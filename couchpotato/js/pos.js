// Point of sale — the showroom till, inside the factory system.
//
// A sale is rung up from the same catalogue the costing uses, against the
// same customers. Each line is either MADE TO ORDER or FROM STOCK:
//   made to order → an order is created on the spot and appears on Orders and
//                   the factory floor, numbered like any other
//   from stock    → sold off the showroom floor; the product's stock count
//                   drops, no factory work
// Every sale raises an invoice in Couch Potato's numbering with the payment
// (deposit or full) recorded on it, so statements and the accountant's export
// see it; orders born here are already billed and never re-queue for invoicing.
//
// Products are found by tapping, searching, or their barcode: a scanner on
// the till types the code and presses Enter, the search box takes a typed
// code, and phones can use the camera.
//
// A return (Sales → Return) takes back some or all of a sale's lines:
//   from stock      back on the shelf (or not, if damaged)
//   made to order   not started yet: the factory order is cancelled;
//                   finished, not delivered: the order is closed;
//                   delivered: the piece comes back (on the shelf or not);
//                   being built: not returnable until it is finished
// It raises a credit note (CN-0001) against the sale's invoice: what is still
// owing on the invoice is reduced first, the rest is refunded.
import * as store from './store.js';
import { allProducts, productByCode } from './costing.js';
import { allCustomers, customerById } from './customers.js';
import { allOrders } from './orders.js';
import { printInvoice, invoiceById, paidAmount, balance } from './invoices.js';
import { openBarcodeCamera } from './barcode.js';
import { esc, money, field, row, val, openModal, toast, today, addDays, niceDate, empty, statusMeta } from './ui.js';

let settings = {};
let sales = [];
let unwatch = null;
let onChange = null;
let posTab = 'sale';       // sale | sales
let cat = '';
let search = '';
let cart = { lines: [], customerId: '', discount: 0, note: '' };

let wedgeOn = false;

export function startPos(cb, cfg) {
  onChange = cb; settings = cfg || {};
  if (!wedgeOn) { document.addEventListener('keydown', onScannerKey, true); wedgeOn = true; }
  if (unwatch) unwatch();
  unwatch = store.watch('sales', rows => { sales = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); if (onChange) onChange(); });
  try { const saved = JSON.parse(localStorage.getItem('cp-pos-cart') || 'null'); if (saved && Array.isArray(saved.lines)) cart = saved; } catch (e) {}
}
export const setPosSettings = (cfg) => { settings = cfg || {}; };
export const allSales = () => sales;
export const setPosTab = (t) => { posTab = t; };
const persist = () => { try { localStorage.setItem('cp-pos-cart', JSON.stringify(cart)); } catch (e) {} };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const vatRate = () => settings.vatRegistered ? (Number(settings.vatRate) || 0) : 0;
const leadDays = () => Number(settings.leadDays) || 28;

// ----------------------------------------------------------------- cart -----

function addProduct(id) {
  const p = allProducts().find(x => x.id === id);
  if (!p) return;
  const kind = (Number(p.stock) || 0) > 0 ? 'stock' : 'order';
  // Tapping the same product again adds to its line (unless a fabric has been
  // chosen on it — a second fabric is a second line).
  const existing = cart.lines.find(l => l.productId === id && l.kind === kind && !l.fabric);
  if (existing) { existing.qty += 1; }
  else cart.lines.push({ productId: id, name: p.name, qty: 1, unitPrice: Number(p.sellingPrice) || 0, kind, fabric: '', note: '' });
  persist();
}
// ------------------------------------------------------------- scanning -----

// A code from the scanner, the search box or the camera.
function addByCode(code) {
  const c = String(code || '').trim();
  if (!c) return false;
  const p = productByCode(c);
  if (!p) { toast('No product has barcode ' + c + '. Add it to the product under Costing.', 'warn'); return false; }
  addProduct(p.id);
  search = ''; posTab = 'sale';
  rerender();
  toast('＋ ' + p.name);
  return true;
}
// A scanner types fast and ends with Enter. On the till's sale screen, catch
// that burst wherever it lands: on the page, or in a box of the sale (a price
// or a note someone was just editing), which then gets its old text back.
// The search box handles its own Enter; other screens and open windows are
// left alone.
const wedge = { buf: '', last: 0, el: null, before: '' };
const SCAN_GAP = 60;      // ms between keys: scanners type far faster than people
function onScannerKey(e) {
  if (!host || !host.querySelector('#pos-search') || document.querySelector('#modal.open')) return;
  const el = e.target;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  if (typing && (el.id === 'pos-search' || !el.classList.contains('pos-in') || el.tagName === 'SELECT')) return;
  const now = Date.now();
  if (e.key === 'Enter') {
    const code = wedge.buf, inBox = wedge.el && wedge.el.isConnected;
    // in a box, only a code we know counts (a quick typist's price stays as typed)
    if (code.length >= 5 && now - wedge.last < SCAN_GAP && (!inBox || productByCode(code))) {
      e.preventDefault();
      if (inBox) { wedge.el.value = wedge.before; posInput(wedge.el); wedge.el.blur(); }
      addByCode(code);
    }
    wedge.buf = ''; wedge.el = null;
    return;
  }
  if (!e.key || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  if (now - wedge.last > SCAN_GAP || wedge.el !== (typing ? el : null)) { wedge.buf = ''; wedge.el = typing ? el : null; wedge.before = typing ? el.value : ''; }
  wedge.buf += e.key; wedge.last = now;
}
// Enter in the search box: a barcode, or the one product the search shows.
function onSearchEnter(el) {
  const v = el.value.trim();
  if (!v) return;
  if (productByCode(v)) { addByCode(v); return; }
  const q = v.toLowerCase();
  const hits = allProducts().filter(p => (!cat || (p.category || 'Other') === cat) && String(p.name || '').toLowerCase().includes(q));
  if (hits.length === 1) { addProduct(hits[0].id); search = ''; rerender(); toast('＋ ' + hits[0].name); }
  else toast(hits.length ? hits.length + ' products match: tap the one you want' : 'No product has barcode ' + v, 'warn');
}

function addCustom() {
  openModal('Other item', row(field('Description', 'pc-name', { placeholder: 'e.g. Delivery fee, scatter cushion' }), field('Price each (excl. VAT)', 'pc-price', { type: 'number', min: 0, step: '0.01' })), {
    okLabel: 'Add to sale',
    onOk: (w) => {
      const name = val(w, 'pc-name'); const price = parseFloat(val(w, 'pc-price')) || 0;
      if (!name) { toast('Give it a description', 'warn'); return false; }
      cart.lines.push({ productId: '', name, qty: 1, unitPrice: price, kind: 'stock', fabric: '', note: '', custom: true });
      persist(); rerender();
    }
  });
}
function lineTotal(l) { return r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)); }
export function totals() {
  const subtotalRaw = r2(cart.lines.reduce((s, l) => s + lineTotal(l), 0));
  const discount = Math.min(subtotalRaw, r2(cart.discount));
  const subtotal = r2(subtotalRaw - discount);
  const vat = r2(subtotal * vatRate());
  return { subtotalRaw, discount, subtotal, vat, total: r2(subtotal + vat), lines: cart.lines.length, pieces: cart.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0) };
}

// ------------------------------------------------------------- customer -----

function pickCustomer() {
  const custs = allCustomers();
  const m = openModal('Customer', `
    <input id="pk-q" placeholder="Search name or phone…" style="width:100%; font:inherit; font-size:15px; padding:.6rem .7rem; border:1px solid #d6d3d1; border-radius:3px; margin-bottom:.6rem">
    <div id="pk-list" class="pk-list"></div>
    <div class="cat" style="margin-top:1rem">Or add a new customer</div>
    ${row(field('Name', 'pk-name'), field('Phone', 'pk-phone'))}
    ${row(field('Email', 'pk-email', { type: 'email' }), field('Area', 'pk-area'))}
    ${field('Delivery address', 'pk-address', { type: 'textarea' })}`, {
    okLabel: 'Add & use this customer',
    onOk: async (w) => {
      const name = val(w, 'pk-name');
      if (!name) { toast('Pick a customer from the list, or type a name to add one', 'warn'); return false; }
      const id = await store.create('customers', { name, phone: val(w, 'pk-phone'), email: val(w, 'pk-email'), area: val(w, 'pk-area'), address: val(w, 'pk-address'), termsDays: 0 });
      cart.customerId = id; persist(); rerender();
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  const list = card.querySelector('#pk-list'), q = card.querySelector('#pk-q');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = custs.filter(c => !t || String(c.name || '').toLowerCase().includes(t) || String(c.phone || '').replace(/\s/g, '').includes(t.replace(/\s/g, ''))).slice(0, 12);
    list.innerHTML = rows.map(c => `<button type="button" class="pk-row" data-pick="${esc(c.id)}"><strong>${esc(c.name)}</strong><span>${esc([c.phone, c.area].filter(Boolean).join(' · '))}</span></button>`).join('') || '<div class="muted" style="padding:.4rem 0">No match — add them below.</div>';
    list.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { cart.customerId = b.dataset.pick; persist(); m.close(); rerender(); }));
  };
  q.addEventListener('input', draw); draw(); setTimeout(() => q.focus(), 60);
}

// ------------------------------------------------------------- checkout -----

function checkout() {
  if (!cart.lines.length) { toast('Nothing on the sale yet', 'warn'); return; }
  const hasOrder = cart.lines.some(l => l.kind === 'order');
  const c = customerById(cart.customerId);
  if (hasOrder && !c) { toast('A made-to-order sale needs a customer — tap Customer first', 'warn'); return; }
  const missingFabric = cart.lines.filter(l => l.kind === 'order' && !l.fabric.trim());
  if (missingFabric.length && !confirm(missingFabric.length + ' made-to-order line(s) have no fabric. Continue anyway?')) return;
  const t = totals();
  const cur = settings.currency || 'R';
  const m = openModal('Take payment', `
    <div class="cost-live" style="margin-top:0">
      <div><span>Items</span><strong>${esc(money(t.subtotalRaw, cur))}</strong></div>
      ${t.discount ? `<div><span>Discount</span><strong>− ${esc(money(t.discount, cur))}</strong></div>` : ''}
      ${vatRate() ? `<div><span>VAT ${Math.round(vatRate() * 100)}%</span><strong>${esc(money(t.vat, cur))}</strong></div>` : ''}
      <div class="tot"><span>Total</span><strong>${esc(money(t.total, cur))}</strong></div>
    </div>
    <div class="pay-kinds">
      <button type="button" class="btn primary" data-pay="full">Paid in full</button>
      <button type="button" class="btn" data-pay="deposit">Deposit</button>
    </div>
    ${row(field('Amount received now', 'py-amt', { value: t.total, type: 'number', min: 0, step: '0.01' }), field('Method', 'py-method', { type: 'select', value: 'Card', options: ['Card', 'EFT', 'Cash', 'Other'].map(x => ({ value: x, label: x })) }))}
    ${field('Reference', 'py-ref', { placeholder: 'Card slip / EFT reference' })}
    <div class="cost-live"><div class="tot"><span>Balance after this payment</span><strong id="py-bal">${esc(money(0, cur))}</strong></div></div>
    ${hasOrder ? `<p class="muted">Made-to-order items will be due out of the factory by <strong>${esc(niceDate(addDays(today(), leadDays())))}</strong> (${leadDays()} days). Any balance is due on collection or delivery.</p>` : ''}`, {
    okLabel: 'Complete sale',
    onOk: async (w) => {
      const amt = parseFloat(val(w, 'py-amt')) || 0;
      if (amt < 0 || amt > t.total + 0.005) { toast('Amount must be between 0 and the total', 'warn'); return false; }
      await completeSale(amt, val(w, 'py-method'), val(w, 'py-ref'));
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  const amt = card.querySelector('#py-amt'), bal = card.querySelector('#py-bal');
  const live = () => { bal.textContent = money(Math.max(0, t.total - (parseFloat(amt.value) || 0)), cur); };
  amt.addEventListener('input', live);
  card.querySelector('[data-pay="full"]').addEventListener('click', () => { amt.value = t.total; live(); });
  card.querySelector('[data-pay="deposit"]').addEventListener('click', () => { amt.value = r2(t.total * 0.5); live(); amt.focus(); amt.select(); });
}

async function completeSale(amount, method, ref) {
  const t = totals();
  const c = customerById(cart.customerId) || null;
  const who = (store.getUser() || {}).name || 'till';
  const now = store.nowIso();
  const sn = await store.nextNumber('saleNo', 1);
  const saleNo = 'S-' + String(sn).padStart(4, '0');
  const due = addDays(today(), leadDays());

  // 1. orders for made-to-order lines
  const lines = [];
  for (const l of cart.lines) {
    const line = { kind: l.kind, productId: l.productId || '', name: l.name, qty: Number(l.qty) || 0, unitPrice: r2(l.unitPrice), fabric: l.fabric || '', note: l.note || '', orderId: '', orderNo: '' };
    if (l.kind === 'order') {
      const n = await store.nextNumber('orderNo', settings.firstOrderNo || 1001);
      const orderNo = (settings.orderPrefix || 'CP-') + n;
      const id = await store.create('orders', {
        orderNo, customerId: c ? c.id : '', customerName: c ? c.name : '', externalRef: saleNo, source: 'pos', saleNo,
        product: l.name, qty: line.qty, fabric: l.fabric || '', notes: [l.note, 'Sold at the till on ' + saleNo].filter(Boolean).join('\n'),
        paidDate: today(), dueDate: due, priceEach: line.unitPrice, status: 'new', fabricStatus: 'none',
        events: [{ at: now, by: who, what: 'Sold at the till (' + saleNo + ')' }]
      });
      line.orderId = id; line.orderNo = orderNo;
    } else if (l.productId) {
      const p = allProducts().find(x => x.id === l.productId);
      if (p && Number.isFinite(Number(p.stock))) await store.update('products', p.id, { stock: Math.max(0, (Number(p.stock) || 0) - line.qty) });
    }
    lines.push(line);
  }

  // 2. the invoice, with the payment on it
  const inNo = await store.nextNumber('invoiceNo', settings.firstInvoiceNo || 1);
  const invoiceNo = (settings.invoicePrefix || 'INV-') + String(inNo).padStart(4, '0');
  const payments = amount > 0 ? [{ at: today(), amount: r2(amount), method, ref, by: who }] : [];
  const paid = r2(amount) >= t.total - 0.005;
  const invLines = lines.map(l => ({ orderId: l.orderId, orderNo: l.orderNo, externalRef: '', qty: l.qty, unitPrice: l.unitPrice,
    description: l.name + (l.fabric ? ' — ' + l.fabric : '') + (l.kind === 'order' ? ' (made to order, due ' + niceDate(due) + ')' : l.custom ? '' : ' (from stock)') }));
  if (t.discount) invLines.push({ orderId: '', orderNo: '', externalRef: '', description: 'Discount', qty: 1, unitPrice: -t.discount });
  const invoiceId = await store.create('invoices', {
    invoiceNo, customerId: c ? c.id : '', customerName: c ? c.name : 'Walk-in customer', date: today(),
    dueDate: paid ? today() : due, lines: invLines, subtotal: t.subtotal, vat: t.vat, vatRate: vatRate(), total: t.total,
    status: paid ? 'paid' : 'issued', paidAt: paid ? today() : '', payments, note: 'Till sale ' + saleNo + (cart.note ? ' · ' + cart.note : ''),
    saleNo, events: [{ at: now, by: who, what: 'Raised at the till (' + saleNo + ')' }]
  });
  for (const l of lines) if (l.orderId) await store.update('orders', l.orderId, { invoiceId, invoiceNo });

  // 3. the sale itself
  const saleId = await store.create('sales', { saleNo, date: today(), customerId: c ? c.id : '', customerName: c ? c.name : 'Walk-in customer',
    lines, subtotal: t.subtotal, discount: t.discount, vat: t.vat, total: t.total, paidNow: r2(amount), method, ref, balance: r2(t.total - amount),
    invoiceId, invoiceNo, note: cart.note, by: who });

  // pieces from the shelf also come off the online shop's count
  store.shopifyPushSale(saleId, lines);

  const made = lines.filter(l => l.kind === 'order').length;
  cart = { lines: [], customerId: '', discount: 0, note: '' }; persist();
  toast(saleNo + ' complete' + (made ? ' · ' + made + ' order' + (made === 1 ? '' : 's') + ' sent to the factory' : ''));
  setTimeout(() => printInvoice(invoiceId), 150);
  rerender();
}

// ---------------------------------------------------------------- render ----

let host = null;
const rerender = () => { if (host) renderPos(host); };

export function renderPos(h) {
  host = h;
  const cur = settings.currency || 'R';
  const tab = (key, label) => `<button class="btn ${posTab === key ? 'primary' : 'ghost'} sm" data-act="pos-tab" data-to="${key}">${label}</button>`;
  h.innerHTML = `
    <div class="page-head"><div><h1>Point of sale</h1><p class="sub">Made-to-order lines go straight to the factory. Stock lines come off the floor.</p></div>
      <div class="btn-row">${tab('sale', 'New sale')}${tab('sales', 'Sales')}</div></div>
    ${posTab === 'sale' ? saleHtml(cur) : salesHtml(cur)}`;
  if (posTab === 'sale') {
    const s = h.querySelector('#pos-search');
    if (s) {
      s.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(s); } });
      if (search) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
  }
}

function saleHtml(cur) {
  const prods = allProducts();
  const cats = [...new Set(prods.map(p => p.category || 'Other'))].sort();
  const q = search.trim().toLowerCase();
  const shown = prods.filter(p => (!cat || (p.category || 'Other') === cat) && (!q || String(p.name || '').toLowerCase().includes(q)));
  const c = customerById(cart.customerId);
  const t = totals();
  return `<div class="pos">
    <div class="pos-left">
      <div class="toolbar" style="margin-bottom:.6rem">
        <input id="pos-search" class="search pos-in" placeholder="Search, or scan a barcode…" value="${esc(search)}" autocomplete="off">
        <button class="btn ghost" data-act="pos-scan" title="Scan a barcode with the camera">📷 Scan</button>
        <button class="btn ghost" data-act="pos-custom">Other item</button>
      </div>
      <div class="btn-row" style="margin-bottom:.7rem">
        <button class="btn ${!cat ? 'primary' : 'ghost'} sm" data-act="pos-cat" data-to="">All</button>
        ${cats.map(x => `<button class="btn ${cat === x ? 'primary' : 'ghost'} sm" data-act="pos-cat" data-to="${esc(x)}">${esc(x)}</button>`).join('')}
      </div>
      ${shown.length ? `<div class="pos-grid">${shown.map(p => `
        <button class="pos-tile" data-act="pos-add" data-id="${esc(p.id)}">
          <span class="pos-tile-cat">${esc(p.category || '')}</span>
          <span class="pos-tile-name">${esc(p.name)}</span>
          <span class="pos-tile-price">${esc(money(p.sellingPrice || 0, cur))}</span>
          <span class="pos-tile-stock">${Number(p.stock) > 0 ? Number(p.stock) + ' in stock' : 'made to order'}</span>
        </button>`).join('')}</div>` : empty('', 'No products', prods.length ? 'Nothing matches.' : 'Add products under Costing first.')}
    </div>
    <div class="pos-right">
      <div class="card pos-cart">
        <button class="pos-cust" data-act="pos-customer">${c ? `<strong>${esc(c.name)}</strong><span>${esc([c.phone, c.area].filter(Boolean).join(' · ') || 'tap to change')}</span>` : '<strong>Customer</strong><span>Tap to pick or add (needed for made-to-order)</span>'}</button>
        <div class="pos-lines">${cart.lines.length ? cart.lines.map((l, i) => `
          <div class="pos-line">
            <div class="pos-line-top">
              <strong>${esc(l.name)}</strong>
              <button class="icon-btn" data-act="pos-remove" data-i="${i}" title="Remove">✕</button>
            </div>
            <div class="pos-line-ctl">
              <span class="qty"><button class="btn ghost sm" data-act="pos-qty" data-i="${i}" data-d="-1">−</button><b>${esc(l.qty)}</b><button class="btn ghost sm" data-act="pos-qty" data-i="${i}" data-d="1">+</button></span>
              <input class="pos-in" data-field="unitPrice" data-i="${i}" type="number" min="0" step="0.01" value="${esc(l.unitPrice)}" title="Price each">
              <strong class="pos-line-tot">${esc(money(lineTotal(l), cur))}</strong>
            </div>
            ${l.custom ? '' : `<div class="pos-kind">
              <button class="${l.kind === 'order' ? 'on' : ''}" data-act="pos-kind" data-i="${i}" data-to="order">Made to order</button>
              <button class="${l.kind === 'stock' ? 'on' : ''}" data-act="pos-kind" data-i="${i}" data-to="stock">From stock</button>
            </div>
            ${l.kind === 'order' ? `<input class="pos-in" data-field="fabric" data-i="${i}" value="${esc(l.fabric)}" placeholder="Fabric / colour">` : ''}`}
            <input class="pos-in" data-field="note" data-i="${i}" value="${esc(l.note)}" placeholder="Note (optional)">
          </div>`).join('') : '<div class="muted" style="padding:1.2rem .4rem; text-align:center">Tap a product to start a sale.</div>'}
        </div>
        <div class="pos-totals">
          <div><span>Items (${t.pieces})</span><strong>${esc(money(t.subtotalRaw, cur))}</strong></div>
          <div><span>Discount</span><span><input class="pos-in" data-field="discount" type="number" min="0" step="0.01" value="${cart.discount || ''}" placeholder="0.00" style="width:110px; text-align:right"></span></div>
          ${vatRate() ? `<div><span>VAT ${Math.round(vatRate() * 100)}%</span><strong>${esc(money(t.vat, cur))}</strong></div>` : ''}
          <div class="tot"><span>Total</span><strong>${esc(money(t.total, cur))}</strong></div>
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-act="pos-clear">Clear</button>
          <button class="btn primary pos-charge" data-act="pos-charge">Take payment</button>
        </div>
      </div>
    </div>
  </div>`;
}

function salesHtml(cur) {
  const t = today();
  const todays = sales.filter(s => s.date === t);
  const byMethod = {}; todays.forEach(s => { byMethod[s.method || '—'] = r2((byMethod[s.method || '—'] || 0) + (Number(s.paidNow) || 0)); });
  const taken = r2(todays.reduce((s, x) => s + (Number(x.paidNow) || 0), 0));
  const tile = (n, label) => `<div class="tile"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  return `
    <div class="tiles">
      ${tile(todays.length, 'Sales today')}
      ${refundsOn(t) ? `<div class="tile"><div class="tile-n">− ${esc(money(refundsOn(t), cur))}</div><div class="tile-l">Refunded today</div></div>` : ''}
      <div class="tile"><div class="tile-n">${esc(money(taken, cur))}</div><div class="tile-l">Taken today</div></div>
      ${Object.keys(byMethod).sort().map(m => `<div class="tile"><div class="tile-n">${esc(money(byMethod[m], cur))}</div><div class="tile-l">${esc(m)} today</div></div>`).join('')}
    </div>
    ${sales.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>Sale</th><th>Date</th><th>Customer</th><th>Items</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Invoice</th><th></th></tr></thead>
      <tbody>${sales.slice(0, 200).map(s => `<tr>
        <td><strong>${esc(s.saleNo)}</strong><div class="muted">${esc(s.by || '')}</div></td><td>${esc(niceDate(s.date))}</td><td>${esc(s.customerName || '')}</td>
        <td>${(s.lines || []).map(l => esc(l.qty + '× ' + l.name) + (l.kind === 'order' ? ' <span class="chip st-prod">' + esc(l.orderNo || 'order') + '</span>' : ' <span class="chip calm">stock</span>')).join('<br>')}
          ${(s.returns || []).map(r => `<div class="muted" style="margin-top:3px">↩ ${esc(r.returnNo)} ${esc(niceDate(r.date))}: ${esc((r.lines || []).map(x => x.qty + '× ' + x.name).join(', '))}${Number(r.refund) ? ' · refunded ' + esc(money(r.refund, cur)) : ''}${r.creditId ? ` <button class="btn ghost sm" data-act="pos-reprint" data-id="${esc(r.creditId)}">${esc(r.creditNo || 'Credit note')}</button>` : ''}</div>`).join('')}</td>
        <td class="r">${esc(money(s.total, cur))}</td><td class="r">${esc(money(s.paidNow, cur))}${s.method ? '<div class="muted">' + esc(s.method) + '</div>' : ''}</td>
        <td class="r">${Number(s.balance) > 0 ? '<strong>' + esc(money(s.balance, cur)) + '</strong>' : '—'}</td>
        <td>${esc(s.invoiceNo || '')}</td>
        <td class="r nowrap">${s.invoiceId ? `<button class="btn ghost sm" data-act="pos-reprint" data-id="${esc(s.invoiceId)}">Receipt</button>` : ''}${(s.lines || []).some((l, i) => returnedQty(s, i) < (Number(l.qty) || 0)) ? ` <button class="btn ghost sm" data-act="pos-return" data-id="${esc(s.id)}">Return</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : empty('', 'No sales yet', 'Ring up the first one under New sale.')}`;
}

// -------------------------------------------------------------- returns -----

const returnedQty = (s, i) => (s.returns || []).reduce((t, r) => t + (r.lines || []).filter(x => x.i === i).reduce((a, x) => a + (Number(x.qty) || 0), 0), 0);
// the till discount, spread over the lines, and the VAT the sale carried
const saleFactor = (s) => { const raw = (s.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0); return raw > 0 ? (Number(s.subtotal) || 0) / raw : 1; };
const saleVat = (s) => Number(s.subtotal) ? (Number(s.vat) || 0) / Number(s.subtotal) : 0;
const refundsOn = (day) => r2(sales.reduce((t, s) => t + (s.returns || []).filter(r => r.date === day).reduce((a, r) => a + (Number(r.refund) || 0), 0), 0));
const refundedSoFar = (s) => r2((s.returns || []).reduce((t, r) => t + (Number(r.refund) || 0), 0));
// money really paid on an invoice: not what earlier returns took off it
const realPaid = (inv) => r2((inv.payments || []).filter(p => !/^Credit note /.test(String(p.method || ''))).reduce((t, p) => t + (Number(p.amount) || 0), 0));
const productExists = (id) => !!id && allProducts().some(p => p.id === id);
// what earlier returns already credited, excl. VAT, per line and in total
const lineExOf = (x) => x.ex != null ? Number(x.ex) : r2((Number(x.qty) || 0) * (Number(x.unitEx) || 0));
const prevLineEx = (s, i) => r2((s.returns || []).reduce((t, r) => t + (r.lines || []).filter(x => x.i === i).reduce((a, x) => a + lineExOf(x), 0), 0));
const prevEx = (s) => r2((s.returns || []).reduce((t, r) => t + (r.ex != null ? Number(r.ex) : (r.lines || []).reduce((a, x) => a + lineExOf(x), 0)), 0));
const prevVat = (s) => r2((s.returns || []).reduce((t, r) => t + (r.vat != null ? Number(r.vat) : r2((Number(r.credit) || 0) - (r.lines || []).reduce((a, x) => a + lineExOf(x), 0))), 0));

// What may happen to a line that comes back.
//   back   from stock, or a delivered piece: it comes back (on the shelf or not)
//   cancel made to order, not started: the factory order is cancelled
//   built  made to order, finished but not delivered: the order is closed
//          and the piece can go on the shelf
//   gone   the factory order is no longer on the system: refund only
function lineState(l) {
  if (l.kind !== 'order') return { ok: true, mode: 'back', counted: true };
  const o = allOrders().find(x => x.id === l.orderId);
  if (!o) return { ok: true, mode: 'gone', note: 'The factory order is no longer on the system' };
  if (o.status === 'new') return { ok: true, mode: 'cancel', o, note: 'Not started: factory order ' + o.orderNo + ' is cancelled' };
  if (o.status === 'ready') return { ok: true, mode: 'built', o, note: 'Finished, not delivered: order ' + o.orderNo + ' is closed' };
  if (o.status === 'dispatched' || o.status === 'invoiced') return { ok: true, mode: 'back', o, counted: true, note: 'Delivered: the piece comes back' };
  return { ok: false, o, note: 'Being built (' + statusMeta(o.status).label + '). Finish it first, or change the order.' };
}
const canShelve = (l, st) => st.ok && (st.mode === 'back' || st.mode === 'built') && productExists(l.productId);

// The value of what comes back. The last pieces of a line, and the last
// lines of the sale, take exactly what is left, so returning everything
// never credits a cent more than was charged.
function returnAmounts(s, picks) {
  const f = saleFactor(s), vr = saleVat(s);
  const per = picks.map(p => {
    const l = s.lines[p.i];
    const unitEx = r2((Number(l.unitPrice) || 0) * f);
    const last = returnedQty(s, p.i) + p.qty >= (Number(l.qty) || 0);
    const ex = last ? r2(Math.max(0, r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * f) - prevLineEx(s, p.i))) : r2(p.qty * unitEx);
    return { ...p, unitEx, ex };
  });
  let ex = r2(per.reduce((t, x) => t + x.ex, 0)), vat = r2(ex * vr);
  const all = (s.lines || []).every((l, i) => returnedQty(s, i) + per.filter(x => x.i === i).reduce((a, x) => a + x.qty, 0) >= (Number(l.qty) || 0));
  if (all && per.length) {
    const left = r2(Math.max(0, (Number(s.subtotal) || 0) - prevEx(s)));
    per[per.length - 1].ex = r2(per[per.length - 1].ex + left - ex);   // the cents of rounding land on the last line
    ex = left;
    vat = r2(Math.max(0, (Number(s.vat) || 0) - prevVat(s)));
  }
  return { per, ex, vat, credit: r2(ex + vat) };
}

function openReturn(id) {
  const s = sales.find(x => x.id === id); if (!s) return;
  const cur = settings.currency || 'R';
  const f = saleFactor(s), vr = saleVat(s);
  const inv = s.invoiceId ? invoiceById(s.invoiceId) : null;
  if (inv && inv.status === 'void') { toast('The invoice for ' + s.saleNo + ' was voided, so there is nothing to return against.', 'warn'); return; }
  const owing = inv ? Math.max(0, balance(inv)) : 0;
  const paidNet = Math.max(0, r2((inv ? realPaid(inv) : Number(s.paidNow) || 0) - refundedSoFar(s)));
  const rows = (s.lines || []).map((l, i) => ({ l, i, left: (Number(l.qty) || 0) - returnedQty(s, i), st: lineState(l) })).filter(x => x.left > 0);
  const single = rows.length === 1;
  const m = openModal('Return from ' + s.saleNo, `
    <p class="muted" style="margin-top:0">${esc(s.customerName || 'Walk-in customer')} · ${esc(niceDate(s.date))} · ${esc(s.invoiceNo || '')} · paid ${esc(money(paidNet, cur))}${owing ? ' · still owing ' + esc(money(owing, cur)) : ''}</p>
    <div class="card" style="padding:0; overflow:auto; margin-bottom:.8rem"><table class="tbl">
      <thead><tr><th>Item</th><th class="r">Bought</th><th class="r">Coming back</th><th></th></tr></thead>
      <tbody>${rows.map(x => `<tr>
        <td><strong>${esc(x.l.name)}</strong>${x.l.fabric ? '<div class="muted">' + esc(x.l.fabric) + '</div>' : ''}<div class="muted">${esc(money(r2((Number(x.l.unitPrice) || 0) * f * (1 + vr)), cur))} each${x.st.note ? ' · ' + esc(x.st.note) : ''}</div></td>
        <td class="r">${esc(x.left)}${x.left < x.l.qty ? '<div class="muted">of ' + esc(x.l.qty) + '</div>' : ''}</td>
        <td class="r">${x.st.ok ? `<input class="rt-qty" data-i="${x.i}" type="number" min="0" max="${x.left}" step="1" value="${single ? x.left : 0}" style="width:70px">` : '<span class="chip late">not yet</span>'}</td>
        <td>${canShelve(x.l, x.st) ? `<label class="check" style="white-space:nowrap"><input type="checkbox" class="rt-shelf" data-i="${x.i}" checked> Back on the shelf</label>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
    ${row(field('Why is it coming back?', 'rt-why', { type: 'select', value: 'Changed their mind', options: ['Changed their mind', 'Damaged', 'Faulty', 'Wrong item', 'Not as described', 'Other'].map(x => ({ value: x, label: x })) }), field('Note', 'rt-note', { placeholder: 'Optional' }))}
    <div class="cost-live" id="rt-live"></div>
    ${row(field('Refund now', 'rt-refund', { type: 'number', min: 0, step: '0.01', value: 0 }), field('Method', 'rt-method', { type: 'select', value: s.method || 'Card', options: ['Card', 'Cash', 'EFT', 'Other'].map(x => ({ value: x, label: x })) }))}
    <p class="muted" id="rt-hint"></p>`, {
    okLabel: 'Complete return',
    onOk: async (w) => {
      const picks = pickReturn(w);
      if (!picks.length) { toast('Say how many of each item are coming back', 'warn'); return false; }
      const { credit } = returnAmounts(s, picks);
      const { minRefund, maxRefund } = bounds(credit);
      const refund = r2(parseFloat(val(w, 'rt-refund')) || 0);
      if (refund < minRefund - 0.005 || refund > maxRefund + 0.005) { toast('The refund must be between ' + money(minRefund, cur) + ' and ' + money(maxRefund, cur), 'warn'); return false; }
      const ok = w.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Saving…';
      try { await completeReturn(s.id, picks, refund, val(w, 'rt-method'), [val(w, 'rt-why'), val(w, 'rt-note')].filter(Boolean).join(': ')); }
      catch (e) { toast('Nothing was changed: ' + e.message, 'warn'); ok.disabled = false; ok.textContent = 'Complete return'; return false; }
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  // anything still owing on the invoice is reduced first, so the refund is
  // at least credit − owing and at most the money really paid
  function bounds(credit) {
    const maxRefund = Math.min(credit, paidNet);
    const minRefund = inv ? Math.max(0, r2(credit - owing)) : maxRefund;
    return { minRefund: Math.min(minRefund, maxRefund), maxRefund };
  }
  let lastCredit = -1;
  const live = () => {
    const picks = pickReturn(card);
    const { credit } = returnAmounts(s, picks);
    const { minRefund } = bounds(credit);
    card.querySelector('#rt-live').innerHTML = `<div class="tot"><span>Value coming back${vr ? ' (incl. VAT)' : ''}</span><strong>${esc(money(credit, cur))}</strong></div>`;
    const inp = card.querySelector('#rt-refund');
    // a new choice of items: take it off what is still owing first, refund the rest
    if (credit !== lastCredit) { inp.value = minRefund; lastCredit = credit; }
    const setOff = r2(credit - (parseFloat(inp.value) || 0));
    card.querySelector('#rt-hint').textContent = !picks.length ? '' : (setOff > 0.004 ? money(setOff, cur) + ' comes off what is still owing on ' + (s.invoiceNo || 'the invoice') + '. ' : '') + 'A credit note is printed.';
  };
  card.addEventListener('input', live);
  card.addEventListener('change', live);
  live();
}
function pickReturn(w) {
  return [...w.querySelectorAll('.rt-qty')].map(el => {
    const i = parseInt(el.dataset.i, 10);
    const qty = Math.max(0, Math.min(parseInt(el.max, 10) || 0, parseInt(el.value, 10) || 0));
    const shelf = w.querySelector('.rt-shelf[data-i="' + i + '"]');
    return { i, qty, restock: shelf ? shelf.checked : false };
  }).filter(p => p.qty > 0);
}

// Everything a return changes is written in one go: the factory orders, the
// stock, the credit note, the invoice and the sale. If any of it fails,
// none of it happens, so trying again never cancels or restocks twice.
async function completeReturn(saleId, picks, refund, method, reason) {
  const s = sales.find(x => x.id === saleId);
  if (!s) throw new Error('the sale is no longer there');
  const who = (store.getUser() || {}).name || 'till';
  const now = store.nowIso();
  const cur = settings.currency || 'R';
  // check again: the factory may have started a piece while this was open
  for (const p of picks) {
    const l = s.lines[p.i];
    const st = lineState(l);
    if (!st.ok) throw new Error(l.name + ': ' + st.note);
    if (p.qty > (Number(l.qty) || 0) - returnedQty(s, p.i)) throw new Error(l.name + ' was returned in the meantime. Close this and open it again.');
  }
  const { per, ex, vat, credit } = returnAmounts(s, picks);
  const inv = s.invoiceId ? invoiceById(s.invoiceId) : null;
  if (inv && inv.status === 'void') throw new Error('the invoice was voided');
  const owing = inv ? Math.max(0, balance(inv)) : 0;
  refund = Math.min(r2(refund), credit);
  let setOff = r2(credit - refund);
  if (setOff > owing + 0.004) { refund = r2(refund + setOff - owing); setOff = owing; }    // never more off the invoice than it owes

  const returnNo = 'R-' + String(await store.nextNumber('returnNo', 1)).padStart(4, '0');
  const creditNo = 'CN-' + String(await store.nextNumber('creditNo', 1)).padStart(4, '0');
  const creditId = store.newId('invoices');
  const ops = [], lines = [];
  for (const p of per) {
    const l = s.lines[p.i];
    const st = lineState(l);
    const rec = { i: p.i, qty: p.qty, name: l.name, kind: l.kind, productId: l.productId || '', orderNo: l.orderNo || '', unitEx: p.unitEx, ex: p.ex, restock: false, cancelled: false, counted: !!st.counted };
    if (st.mode === 'cancel' || st.mode === 'built') {
      // not delivered: the order goes (or gets smaller), so it leaves the floor and the delivery list
      const left = (Number(st.o.qty) || 1) - p.qty;
      if (left <= 0) ops.push({ op: 'remove', coll: 'orders', id: st.o.id });
      else ops.push({ op: 'update', coll: 'orders', id: st.o.id, patch: { qty: left }, event: p.qty + ' returned at the till (' + returnNo + ')' });
      rec.cancelled = true;
    } else if (st.mode === 'back' && st.o) {
      ops.push({ op: 'update', coll: 'orders', id: st.o.id, patch: {}, event: p.qty + ' brought back at the till (' + returnNo + ')' + (p.restock && canShelve(l, st) ? ', back on the shelf' : '') });
    }
    if (p.restock && canShelve(l, st)) { ops.push({ op: 'update', coll: 'products', id: l.productId, patch: { stock: store.inc(p.qty) } }); rec.restock = true; }
    lines.push(rec);
  }
  const payments = [];
  if (refund > 0) payments.push({ at: today(), amount: -refund, method, ref: returnNo, by: who });
  if (setOff > 0) payments.push({ at: today(), amount: -setOff, method: 'Off ' + (s.invoiceNo || 'the invoice'), ref: returnNo, by: who });
  ops.push({ op: 'create', coll: 'invoices', id: creditId, data: {
    kind: 'credit', invoiceNo: creditNo, customerId: s.customerId || '', customerName: s.customerName || 'Walk-in customer', date: today(), dueDate: '',
    lines: lines.map(x => ({ orderId: '', orderNo: x.orderNo, externalRef: '', qty: x.qty, unitPrice: -r2(x.ex / x.qty),
      description: 'Returned: ' + x.name + (x.cancelled ? ' (order closed)' : x.restock ? ' (back on the shelf)' : '') })),
    subtotal: -ex, vat: -vat, vatRate: saleVat(s), total: -credit, status: 'paid', paidAt: today(), payments,
    note: 'Return ' + returnNo + ' against ' + (s.invoiceNo || s.saleNo) + (reason ? ' · ' + reason : ''),
    againstInvoiceId: s.invoiceId || '', againstInvoiceNo: s.invoiceNo || '', saleNo: s.saleNo, returnNo,
    events: [{ at: now, by: who, what: 'Credit note for return ' + returnNo }]
  } });
  let newOwing = owing;
  if (inv && setOff > 0) {
    const pays = [...(inv.payments || []), { at: today(), amount: setOff, method: 'Credit note ' + creditNo, ref: returnNo, by: who }];
    const paid = r2(pays.reduce((t, x) => t + (Number(x.amount) || 0), 0));
    const patch = { payments: pays };
    if (paid >= (Number(inv.total) || 0) - 0.005) { patch.status = 'paid'; patch.paidAt = today(); }
    ops.push({ op: 'update', coll: 'invoices', id: inv.id, patch, event: 'Credit note ' + creditNo + ' (' + money(setOff, cur) + ') for return ' + returnNo });
    newOwing = Math.max(0, r2((Number(inv.total) || 0) - paid));
  }
  ops.push({ op: 'update', coll: 'sales', id: s.id, patch: {
    returns: [...(s.returns || []), { returnNo, date: today(), at: now, by: who, lines, ex, vat, credit, refund, setOff, method, reason, creditId, creditNo }],
    balance: inv ? newOwing : Math.max(0, Number(s.balance) || 0)
  } });
  await store.batchWrite(ops);

  // pieces back on the shelf go back on the online shop's count too
  if (lines.some(x => x.restock)) store.shopifyPushReturn(s.id, returnNo);
  toast(returnNo + ' done' + (refund ? ' · refund ' + money(refund, cur) + ' (' + method + ')' : '') + (lines.some(x => x.cancelled) ? ' · factory order closed' : ''));
  setTimeout(() => printInvoice(creditId), 200);
  rerender();
}

// ---------------------------------------------------------------- events ----

export function posAction(act, el) {
  const i = parseInt(el.dataset.i, 10);
  switch (act) {
    case 'pos-tab': posTab = el.dataset.to; return rerender();
    case 'pos-cat': cat = el.dataset.to; return rerender();
    case 'pos-add': addProduct(el.dataset.id); return rerender();
    case 'pos-custom': return addCustom();
    case 'pos-qty': { const l = cart.lines[i]; if (!l) return; l.qty = Math.max(1, (Number(l.qty) || 1) + parseInt(el.dataset.d, 10)); persist(); return rerender(); }
    case 'pos-remove': cart.lines.splice(i, 1); persist(); return rerender();
    case 'pos-kind': { const l = cart.lines[i]; if (!l) return; l.kind = el.dataset.to; persist(); return rerender(); }
    case 'pos-customer': return pickCustomer();
    case 'pos-clear': if (!cart.lines.length || confirm('Clear this sale?')) { cart = { lines: [], customerId: '', discount: 0, note: '' }; persist(); rerender(); } return;
    case 'pos-charge': return checkout();
    case 'pos-reprint': return printInvoice(el.dataset.id);
    case 'pos-scan': return openBarcodeCamera(addByCode);
    case 'pos-return': return openReturn(el.dataset.id);
  }
}
export function posInput(el) {
  if (!el.isConnected) return;          // a late keystroke from a box that was redrawn (e.g. after a scan)
  if (el.id === 'pos-search') { search = el.value; return rerender(); }
  const f = el.dataset.field;
  if (!f) return;
  if (f === 'discount') { cart.discount = parseFloat(el.value) || 0; persist(); return updateTotalsOnly(); }
  const l = cart.lines[parseInt(el.dataset.i, 10)]; if (!l) return;
  if (f === 'unitPrice') { l.unitPrice = parseFloat(el.value) || 0; persist(); return updateTotalsOnly(); }
  l[f] = el.value; persist();
}
function updateTotalsOnly() {
  // keep focus in the input the user is typing in: refresh only the numbers
  if (!host) return;
  const cur = settings.currency || 'R';
  const t = totals();
  host.querySelectorAll('.pos-line').forEach((el, i) => { const l = cart.lines[i]; const tot = el.querySelector('.pos-line-tot'); if (l && tot) tot.textContent = money(lineTotal(l), cur); });
  const box = host.querySelector('.pos-totals'); if (!box) return;
  const strongs = box.querySelectorAll('div > strong');
  if (strongs[0]) strongs[0].textContent = money(t.subtotalRaw, cur);
  if (vatRate() && strongs[1]) strongs[1].textContent = money(t.vat, cur);
  const tot = box.querySelector('.tot strong'); if (tot) tot.textContent = money(t.total, cur);
}
