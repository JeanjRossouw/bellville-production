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
import * as store from './store.js';
import { allProducts } from './costing.js';
import { allCustomers, customerById } from './customers.js';
import { printInvoice } from './invoices.js';
import { esc, money, field, row, val, openModal, toast, today, addDays, niceDate, empty } from './ui.js';

let settings = {};
let sales = [];
let unwatch = null;
let onChange = null;
let posTab = 'sale';       // sale | sales
let cat = '';
let search = '';
let cart = { lines: [], customerId: '', discount: 0, note: '' };

export function startPos(cb, cfg) {
  onChange = cb; settings = cfg || {};
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
  if (posTab === 'sale') { const s = h.querySelector('#pos-search'); if (s && search) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
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
        <input id="pos-search" class="search pos-in" placeholder="Search products…" value="${esc(search)}">
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
      <div class="tile"><div class="tile-n">${esc(money(taken, cur))}</div><div class="tile-l">Taken today</div></div>
      ${Object.keys(byMethod).sort().map(m => `<div class="tile"><div class="tile-n">${esc(money(byMethod[m], cur))}</div><div class="tile-l">${esc(m)} today</div></div>`).join('')}
    </div>
    ${sales.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>Sale</th><th>Date</th><th>Customer</th><th>Items</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Invoice</th><th></th></tr></thead>
      <tbody>${sales.slice(0, 200).map(s => `<tr>
        <td><strong>${esc(s.saleNo)}</strong><div class="muted">${esc(s.by || '')}</div></td><td>${esc(niceDate(s.date))}</td><td>${esc(s.customerName || '')}</td>
        <td>${(s.lines || []).map(l => esc(l.qty + '× ' + l.name) + (l.kind === 'order' ? ' <span class="chip st-prod">' + esc(l.orderNo || 'order') + '</span>' : ' <span class="chip calm">stock</span>')).join('<br>')}</td>
        <td class="r">${esc(money(s.total, cur))}</td><td class="r">${esc(money(s.paidNow, cur))}${s.method ? '<div class="muted">' + esc(s.method) + '</div>' : ''}</td>
        <td class="r">${Number(s.balance) > 0 ? '<strong>' + esc(money(s.balance, cur)) + '</strong>' : '—'}</td>
        <td>${esc(s.invoiceNo || '')}</td>
        <td class="r nowrap">${s.invoiceId ? `<button class="btn ghost sm" data-act="pos-reprint" data-id="${esc(s.invoiceId)}">Receipt</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : empty('', 'No sales yet', 'Ring up the first one under New sale.')}`;
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
  }
}
export function posInput(el) {
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
