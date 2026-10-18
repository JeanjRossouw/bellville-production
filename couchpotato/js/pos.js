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
// With the online shop connected, the till sells the SHOP'S stock: its
// products, prices and counts come live from Shopify (till.js), a sale never
// takes more than the shop has, and each sale becomes a Shopify order so the
// shop's count and sales history stay right. Factory products not in the shop
// are still sold made to order.
//
// Staff unlock the till with a PIN when PINs are set up (Settings → Till
// staff); the sale records who rang it. Discounts (a line, or the whole sale,
// in rands or %) beyond a cashier's limit, and returns a cashier may not do,
// need a manager's PIN on the spot. Payment takes cash (with the change),
// card or EFT, or a split across two, and prints an 80 mm slip that can also
// go by WhatsApp or email.
//
// Other ways to pay: a gift card (sold here too, with its code on the slip),
// the customer's store credit (from a return), their loyalty points (earned on
// every sale, settings.loyaltyPct of it, 1 point = R1). And two kinds of sale
// that are not paid in full: a LAYBY (sales order: a deposit now, the goods
// stay here until it is paid and collected) and ON ACCOUNT (the goods go now,
// the customer pays later). Both leave a balance on the invoice; "Pay" on the
// Sales tab and "Account payment" take the money later.
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
import { esc, money, field, row, val, openModal, toast, today, addDays, niceDate, empty, statusMeta, productImg, vatSplit, inclLabel } from './ui.js';
import * as till from './till.js';
import * as shopstock from './shopstock.js';

let settings = {};
let sales = [];
let unwatch = null;
let onChange = null;
let posTab = 'sale';       // sale | sales
let cat = '';
let search = '';
let cart = { lines: [], customerId: '', discount: 0, discountPct: 0, note: '' };

let wedgeOn = false;

export function startPos(cb, cfg) {
  onChange = cb; settings = cfg || {};
  till.startTill(() => rerender(), cfg);
  shopstock.startShopStock(() => rerender(), cfg);
  if (!wedgeOn) { document.addEventListener('keydown', onScannerKey, true); wedgeOn = true; }
  if (unwatch) unwatch();
  unwatch = store.watch('sales', rows => { sales = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); if (onChange) onChange(); });
  try { const saved = JSON.parse(localStorage.getItem('cp-pos-cart') || 'null'); if (saved && Array.isArray(saved.lines)) cart = saved; } catch (e) {}
}
export const setPosSettings = (cfg) => { settings = cfg || {}; till.setTillSettings(cfg); shopstock.setShopStockSettings(cfg); };
let quickEdit = false;      // tapping a tile stars it instead of selling it
export const setPosShop = (s) => till.setTillShop(s);
const emptyCart = () => ({ lines: [], customerId: '', discount: 0, discountPct: 0, note: '' });
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
  else cart.lines.push({ productId: id, name: p.name, qty: 1, unitPrice: Number(p.sellingPrice) || 0, kind, fabric: '', note: '', disc: 0 });
  persist();
}
// One of the shop's products: from stock, never more than the shop has.
function addShopItem(variantId) {
  const it = till.shopItem(variantId);
  if (!it) return false;
  const existing = cart.lines.find(l => l.variantId === it.variantId);
  const have = (existing ? existing.qty : 0) + 1;
  if (it.tracked && have > (Number(it.qty) || 0)) { toast(it.qty > 0 ? 'Only ' + it.qty + ' in stock' : 'Out of stock', 'warn'); return false; }
  if (existing) existing.qty += 1;
  else cart.lines.push({ productId: '', variantId: it.variantId, inventoryItemId: it.inventoryItemId, name: it.name, qty: 1, unitPrice: Number(it.price) || 0, kind: 'stock', fabric: '', note: '', disc: 0, tracked: !!it.tracked, stockQty: Number(it.qty) || 0, shop: true });
  persist();
  return true;
}
const addAny = (id) => (String(id).startsWith('v:') ? addShopItem(id.slice(2)) : (addProduct(id), true));
// ------------------------------------------------------------- scanning -----

// A code from the scanner, the search box or the camera.
function addByCode(code) {
  const c = String(code || '').trim();
  if (!c) return false;
  const p = productByCode(c), it = p ? null : till.shopItemByCode(c);
  if (!p && !it) { toast('No product has barcode ' + c + (till.shopOn() ? '' : '. Add it to the product under Costing.'), 'warn'); return false; }
  search = '';
  if (p) addProduct(p.id); else if (!addShopItem(it.variantId)) { rerender(); return false; }
  search = ''; posTab = 'sale';
  rerender();
  toast('＋ ' + (p ? p.name : it.name));
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
    if (code.length >= 5 && now - wedge.last < SCAN_GAP && (!inBox || productByCode(code) || till.shopItemByCode(code))) {
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
  if (productByCode(v) || till.shopItemByCode(v)) { addByCode(v); return; }
  const hits = tiles().filter(t => matchesTile(t, v.toLowerCase()));
  if (hits.length === 1) { if (addAny(hits[0].id)) { search = ''; rerender(); toast('＋ ' + hits[0].name); } }
  else toast(hits.length ? hits.length + ' products match: tap the one you want' : 'No product has barcode ' + v, 'warn');
}

function addCustom() {
  openModal('Other item', row(field('Description', 'pc-name', { placeholder: 'e.g. Scatter cushion, fitting' }), field('Price each' + inclLabel(vatRate()), 'pc-price', { type: 'number', min: 0, step: '0.01' })), {
    okLabel: 'Add to sale',
    onOk: (w) => {
      const name = val(w, 'pc-name'); const price = parseFloat(val(w, 'pc-price')) || 0;
      if (!name) { toast('Give it a description', 'warn'); return false; }
      cart.lines.push({ productId: '', name, qty: 1, unitPrice: price, kind: 'stock', fabric: '', note: '', disc: 0, custom: true });
      persist(); rerender();
    }
  });
}
// Delivery: one line on the sale, with where it goes. Made-to-order pieces on
// the same sale are booked as a delivery to that address.
function addDelivery() {
  const c = customerById(cart.customerId) || {};
  const had = cart.lines.find(l => l.delivery);
  let last = ''; try { last = localStorage.getItem('cp-pos-delfee') || ''; } catch (e) {}
  openModal('Delivery', field('Deliver to', 'pd-addr', { type: 'textarea', value: had ? had.deliveryAddress : [c.address, c.area].filter(Boolean).join(', '), placeholder: 'Street, suburb, town' })
    + row(field('Delivery fee' + inclLabel(vatRate()), 'pd-fee', { type: 'number', min: 0, step: '0.01', value: had ? had.unitPrice : last }), field('Note for the driver', 'pd-note', { value: had ? had.note : '', placeholder: 'e.g. Phone before, 2nd floor' })), {
    okLabel: had ? 'Change delivery' : 'Add delivery',
    onOk: (w) => {
      const addr = val(w, 'pd-addr').trim(), fee = parseFloat(val(w, 'pd-fee')) || 0;
      if (!addr) { toast('Where must it be delivered?', 'warn'); return false; }
      try { localStorage.setItem('cp-pos-delfee', String(fee)); } catch (e) {}
      const line = { productId: '', name: 'Delivery to ' + addr.replace(/\s*\n\s*/g, ', '), qty: 1, unitPrice: fee, kind: 'stock', fabric: '', note: val(w, 'pd-note'), disc: 0, custom: true, delivery: true, deliveryAddress: addr };
      if (had) cart.lines[cart.lines.indexOf(had)] = line; else cart.lines.push(line);
      persist(); rerender();
    }
  });
}
const lineGross = (l) => r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0));
const lineDisc = (l) => Math.min(lineGross(l), r2(Number(l.disc) || 0));
function lineTotal(l) { return r2(lineGross(l) - lineDisc(l)); }
// A gift card sold: no stock, no VAT (that comes when it is spent), a code on the slip.
function addGiftCard() {
  openModal('Sell a gift card', field('Amount on the card' , 'gc-amt', { type: 'number', min: 0, step: '1', placeholder: 'e.g. 500' }) + '<p class="muted">The code prints on the slip; the customer gives it when paying with the card.</p>', {
    okLabel: 'Add to sale',
    onOk: (w) => {
      const a = r2(parseFloat(val(w, 'gc-amt')) || 0);
      if (!(a > 0)) { toast('How much?', 'warn'); return false; }
      cart.lines.push({ productId: '', name: 'Gift card', qty: 1, unitPrice: a, kind: 'giftcard', fabric: '', note: '', disc: 0, custom: true, noVat: true });
      persist(); rerender();
    }
  });
}
// The whole sale's discount in rands: typed as rands, or as a % of what is
// left after the line discounts.
function cartDiscount(afterLines) {
  if (Number(cart.discountPct) > 0) return Math.min(afterLines, r2(afterLines * Number(cart.discountPct) / 100));
  return Math.min(afterLines, r2(cart.discount));
}
export function totals() {
  const subtotalRaw = r2(cart.lines.reduce((s, l) => s + lineGross(l), 0));
  const lineDiscs = r2(cart.lines.reduce((s, l) => s + lineDisc(l), 0));
  const cartDisc = cartDiscount(r2(subtotalRaw - lineDiscs));
  const discount = r2(lineDiscs + cartDisc);
  // prices include VAT: the total is what the lines add up to, the VAT is inside it
  // (none on a gift card sold: its VAT comes when it is spent)
  const noVat = r2(cart.lines.filter(l => l.noVat).reduce((s, l) => s + lineTotal(l), 0));
  const { gross, ex, vat } = vatSplit(subtotalRaw - discount - noVat, vatRate());
  return { subtotalRaw, lineDiscs, cartDisc, discount, subtotal: r2(ex + noVat), vat, total: r2(gross + noVat), lines: cart.lines.length, pieces: cart.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    pct: subtotalRaw > 0 ? discount / subtotalRaw * 100 : 0 };
}
// What each line really took, with the sale's discount spread over the lines
// by their value; the cents of rounding land on the last line, so the lines
// add up to the total exactly.
function lineNets() {
  const t = totals();
  const after = cart.lines.map(lineTotal), sum = r2(after.reduce((a, b) => a + b, 0));
  const nets = after.map(x => sum > 0 ? r2(x - t.cartDisc * x / sum) : 0);
  const diff = r2(t.total - nets.reduce((a, b) => a + b, 0));
  if (nets.length && diff) nets[nets.length - 1] = r2(nets[nets.length - 1] + diff);
  return nets;
}

// ------------------------------------------------------------ discounts -----

// A discount beyond the till person's limit needs a manager. With no PINs set
// up, or a manager at the till, anything goes.
async function allowedDiscount(pct, what) {
  const me = till.tillUser();
  if (!till.usesPins() || till.isManager(me)) return true;
  const limit = me ? Number(me.maxDiscPct) || 0 : 0;
  if (pct <= limit + 0.0001) return true;
  const ok = await till.managerApproval((me ? me.name : 'The till') + ' may give up to ' + limit + '%. ' + what + ' is ' + Math.round(pct * 10) / 10 + '%: a manager must approve it.');
  return !!ok;
}
async function lineDiscount(i) {
  const l = cart.lines[i]; if (!l) return;
  const gross = lineGross(l);
  const v = prompt('Discount on ' + l.name + ' (' + money(gross, settings.currency || 'R') + '):\n"10%" or a rand amount', l.disc ? String(l.disc) : '');
  if (v === null) return;
  const t = String(v).trim().replace(/\s/g, '');
  let disc = 0;
  if (/^\d+(\.\d+)?%$/.test(t)) disc = r2(gross * parseFloat(t) / 100);
  else if (/^r?\d+(\.\d+)?$/i.test(t)) disc = r2(parseFloat(t.replace(/^r/i, '')));
  else if (t !== '') { toast('Type 10% or a rand amount', 'warn'); return; }
  disc = Math.max(0, Math.min(gross, disc));
  if (disc > 0 && gross > 0 && !await allowedDiscount(disc / gross * 100, 'This discount')) return;
  l.disc = disc; persist(); rerender();
}
async function cartDiscountPrompt() {
  const t = totals();
  const base = r2(t.subtotalRaw - t.lineDiscs);
  const v = prompt('Discount on the whole sale (' + money(base, settings.currency || 'R') + '):\n"10%" or a rand amount', cart.discountPct ? cart.discountPct + '%' : cart.discount ? String(cart.discount) : '');
  if (v === null) return;
  const s = String(v).trim().replace(/\s/g, '');
  let pct = 0, rand = 0;
  if (/^\d+(\.\d+)?%$/.test(s)) pct = Math.min(100, parseFloat(s));
  else if (/^r?\d+(\.\d+)?$/i.test(s)) rand = Math.min(base, r2(parseFloat(s.replace(/^r/i, ''))));
  else if (s !== '') { toast('Type 10% or a rand amount', 'warn'); return; }
  const asPct = pct || (base > 0 ? rand / base * 100 : 0);
  if (asPct > 0 && !await allowedDiscount(asPct, 'This discount')) return;
  cart.discountPct = pct; cart.discount = pct ? 0 : rand; persist(); rerender();
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

const METHODS = ['Cash', 'Card', 'EFT', 'Gift card', 'Store credit', 'Points', 'Other'];
const loyaltyPct = () => Number(settings.loyaltyPct == null ? 5 : settings.loyaltyPct) || 0;
function checkout() {
  if (!cart.lines.length) { toast('Nothing on the sale yet', 'warn'); return; }
  const hasOrder = cart.lines.some(l => l.kind === 'order');
  const c = customerById(cart.customerId);
  if (hasOrder && !c) { toast('A made-to-order sale needs a customer — tap Customer first', 'warn'); return; }
  const missingFabric = cart.lines.filter(l => l.kind === 'order' && !l.fabric.trim());
  if (missingFabric.length && !confirm(missingFabric.length + ' made-to-order line(s) have no fabric. Continue anyway?')) return;
  // the shop's count may have moved since the tile was tapped
  const short = cart.lines.filter(l => l.shop && l.tracked).map(l => ({ l, it: till.shopItem(l.variantId) })).filter(x => x.it && (Number(x.it.qty) || 0) < (Number(x.l.qty) || 0));
  if (short.length) { toast(short.map(x => x.l.name + ': only ' + x.it.qty + ' in stock').join(' · '), 'warn'); return; }
  const t = totals();
  const cur = settings.currency || 'R';
  const payRow = (n) => `<div class="pay-row" data-n="${n}">
      <select class="py-method" data-n="${n}">${METHODS.map(x => `<option value="${x}"${(n === 1 ? 'Card' : 'Cash') === x ? ' selected' : ''}>${x}</option>`).join('')}</select>
      <input class="py-amt" data-n="${n}" type="number" min="0" step="0.01" value="${n === 1 ? t.total : ''}" placeholder="amount" aria-label="Amount">
      <input class="py-ref" data-n="${n}" placeholder="Reference (optional)" aria-label="Reference">
      <div class="py-cash py-gift" data-n="${n}" hidden><input class="py-code" data-n="${n}" placeholder="Gift card code" aria-label="Gift card code" autocomplete="off"><span class="py-gcbal muted"></span></div>
      <div class="py-cash" data-n="${n}" hidden><input class="py-tend" data-n="${n}" type="number" min="0" step="0.01" placeholder="Cash given" aria-label="Cash given"><span class="py-change muted">Change <strong>${esc(money(0, cur))}</strong></span></div>
    </div>`;
  const m = openModal('Take payment', `
    <div class="cost-live" style="margin-top:0">
      <div><span>Items</span><strong>${esc(money(t.subtotalRaw, cur))}</strong></div>
      ${t.discount ? `<div><span>Discount</span><strong>− ${esc(money(t.discount, cur))}</strong></div>` : ''}
      <div class="tot"><span>Total</span><strong>${esc(money(t.total, cur))}</strong></div>
      ${vatRate() ? `<div class="muted"><span>Includes VAT ${Math.round(vatRate() * 100)}%</span><span>${esc(money(t.vat, cur))}</span></div>` : ''}
    </div>
    <div class="pay-kinds">
      ${['Cash', 'Card', 'EFT'].map(x => `<button type="button" class="btn ${x === 'Card' ? 'primary' : ''}" data-pay="${x}">${x}</button>`).join('')}
      <button type="button" class="btn" data-pay="split">Split</button>
      <button type="button" class="btn" data-pay="deposit">Deposit</button>
    </div>
    <div class="pay-kinds" style="grid-template-columns:repeat(3, 1fr); margin-top:0">
      <button type="button" class="btn" data-pay="layby" title="A deposit now, the goods stay here until it is paid">Layby</button>
      <button type="button" class="btn" data-pay="account" title="The goods go now, the customer pays later">On account</button>
      <button type="button" class="btn" data-pay="wallet" title="Pay with the customer’s store credit or points">${c ? 'Credit / points' : 'Credit / points (pick a customer)'}</button>
    </div>
    <p class="muted" id="py-kind-note" hidden></p>
    <div id="pay-rows">${payRow(1)}</div>
    <div class="cost-live"><div class="tot"><span id="py-bal-l">Balance after this payment</span><strong id="py-bal">${esc(money(0, cur))}</strong></div></div>
    ${hasOrder ? `<p class="muted">Made-to-order items will be due out of the factory by <strong>${esc(niceDate(addDays(today(), leadDays())))}</strong> (${leadDays()} days). Any balance is due on collection or delivery.</p>` : ''}`, {
    okLabel: 'Complete sale',
    onOk: async (w) => {
      const pays = readPays(w);
      const paid = r2(pays.reduce((a, p) => a + p.amount, 0));
      if (paid < 0 || paid > t.total + 0.005) { toast('The payments must not be more than the total', 'warn'); return false; }
      for (const p of pays) if (p.method === 'Cash' && p.tendered != null && p.tendered < p.amount - 0.005) { toast('Cash given is less than the cash amount', 'warn'); return false; }
      if (!c && (kind !== 'sale' || pays.some(p => p.method === 'Store credit' || p.method === 'Points'))) { toast('Pick a customer first', 'warn'); return false; }
      const bad = checkWallet(pays, c);
      if (bad) { toast(bad, 'warn'); return false; }
      if (kind === 'sale' && paid < t.total - 0.005 && !confirm('Only ' + money(paid, cur) + ' of ' + money(t.total, cur) + ' is paid. Record it as a deposit, with the balance due on collection or delivery?')) return false;
      const ok = w.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Saving…';
      try { await completeSale(pays, kind); }
      catch (e) { toast('The sale was not completed: ' + e.message, 'warn'); ok.disabled = false; ok.textContent = 'Complete sale'; return false; }
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  const readPays = (w) => [...w.querySelectorAll('.pay-row')].map(r => {
    const method = r.querySelector('.py-method').value, amount = r2(parseFloat(r.querySelector('.py-amt').value) || 0);
    const tendRaw = r.querySelector('.py-tend').value;
    const tendered = method === 'Cash' && tendRaw !== '' ? r2(parseFloat(tendRaw) || 0) : null;
    return { method, amount, ref: r.querySelector('.py-ref').value.trim(), tendered, change: tendered != null ? r2(Math.max(0, tendered - amount)) : 0,
      ...(method === 'Gift card' ? { code: r.querySelector('.py-code').value.trim() } : {}) };
  }).filter(p => p.amount > 0 || p.method === 'Cash');
  let kind = 'sale';
  const live = () => {
    card.querySelectorAll('.pay-row').forEach(r => {
      const m = r.querySelector('.py-method').value;
      r.querySelector('.py-cash:not(.py-gift)').hidden = m !== 'Cash';
      r.querySelector('.py-gift').hidden = m !== 'Gift card';
      const amt = parseFloat(r.querySelector('.py-amt').value) || 0, tend = parseFloat(r.querySelector('.py-tend').value) || 0;
      r.querySelector('.py-change strong').textContent = money(Math.max(0, tend - amt), cur);
      if (m === 'Gift card') { const g = till.giftCardByCode(r.querySelector('.py-code').value); r.querySelector('.py-gcbal').textContent = g ? 'on the card: ' + money(g.balance, cur) : r.querySelector('.py-code').value ? 'no card with that code' : ''; }
      if (m === 'Store credit' && c) r.querySelector('.py-gcbal').textContent = '';
    });
    const paid = readPays(card).reduce((a, p) => a + p.amount, 0);
    const bal = Math.max(0, r2(t.total - paid));
    card.querySelector('#py-bal').textContent = money(bal, cur);
    card.querySelector('#py-bal-l').textContent = bal > 0 ? (kind === 'layby' ? 'Still owing on the layby' : kind === 'account' ? 'Put on the account' : 'Still owing after this payment (deposit)') : 'Balance after this payment';
    card.querySelector('#modal-ok').textContent = bal > 0 ? (kind === 'layby' ? 'Open layby' : kind === 'account' ? 'Sell on account' : 'Take deposit') : 'Complete sale';
    const note = card.querySelector('#py-kind-note');
    note.hidden = kind === 'sale';
    note.textContent = kind === 'layby' ? 'Layby: the goods stay in the shop until it is paid in full and collected (Sales → Collect). Made-to-order pieces go to the factory now.' : kind === 'account' ? 'On account: the goods go now; the balance shows on the customer’s invoice and is taken with "Account payment".' : '';
  };
  const one = (method) => { const rows = card.querySelector('#pay-rows'); rows.innerHTML = payRow(1); rows.querySelector('.py-method').value = method; rows.querySelector('.py-amt').value = t.total; live(); const f = rows.querySelector(method === 'Cash' ? '.py-tend' : '.py-ref'); if (f) f.focus(); };
  card.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => {
    card.querySelectorAll('[data-pay]').forEach(x => x.classList.toggle('primary', x === b));
    const k = b.dataset.pay;
    if (k === 'split') { kind = 'sale'; const rows = card.querySelector('#pay-rows'); rows.innerHTML = payRow(1) + payRow(2); rows.querySelector('.py-method[data-n="1"]').value = 'Card'; rows.querySelector('.py-method[data-n="2"]').value = 'Cash'; rows.querySelector('.py-amt[data-n="1"]').value = ''; live(); rows.querySelector('.py-amt[data-n="1"]').focus(); }
    else if (k === 'deposit') { kind = 'sale'; one('Card'); const a = card.querySelector('.py-amt'); a.value = r2(t.total * 0.5); live(); a.focus(); a.select(); }
    else if (k === 'layby') { if (!c) { toast('A layby needs a customer: tap Customer first', 'warn'); return; } kind = 'layby'; one('Card'); const a = card.querySelector('.py-amt'); a.value = r2(t.total * 0.5); live(); a.focus(); a.select(); }
    else if (k === 'account') { if (!c) { toast('An account sale needs a customer: tap Customer first', 'warn'); return; } kind = 'account'; one('Card'); const a = card.querySelector('.py-amt'); a.value = ''; live(); }
    else if (k === 'wallet') {
      if (!c) { toast('Pick a customer first', 'warn'); return; }
      kind = 'sale';
      const credit = Math.min(t.total, Number(c.storeCredit) || 0), pts = Math.min(r2(t.total - credit), Number(c.points) || 0);
      if (!credit && !pts) { toast(c.name + ' has no store credit or points', 'warn'); return; }
      const rows = card.querySelector('#pay-rows'); rows.innerHTML = payRow(1) + payRow(2);
      rows.querySelector('.py-method[data-n="1"]').value = credit ? 'Store credit' : 'Points'; rows.querySelector('.py-amt[data-n="1"]').value = credit || pts;
      rows.querySelector('.py-method[data-n="2"]').value = credit && pts ? 'Points' : 'Card'; rows.querySelector('.py-amt[data-n="2"]').value = credit && pts ? pts : r2(t.total - (credit || pts));
      live();
    }
    else { kind = 'sale'; one(k); }
  }));
  card.addEventListener('input', live); card.addEventListener('change', live);
  live();
}

// Everything the sale makes: factory orders for made-to-order lines, the
// invoice with the payments on it, the sale itself (with who rang it and
// what each line really took), then the shop's order, the slip.
// Can the gift card, the store credit and the points cover what is put on them?
function checkWallet(pays, c) {
  for (const p of pays) {
    if (p.method === 'Gift card') { const g = till.giftCardByCode(p.code); if (!g) return 'No gift card with that code'; if (g.status === 'used' || !(Number(g.balance) > 0)) return 'That gift card has nothing left on it'; if (p.amount > Number(g.balance) + 0.005) return 'Only ' + money(g.balance, settings.currency || 'R') + ' is left on the gift card'; }
    if (p.method === 'Store credit' && p.amount > (Number((c || {}).storeCredit) || 0) + 0.005) return 'Store credit is only ' + money((c || {}).storeCredit || 0, settings.currency || 'R');
    if (p.method === 'Points' && p.amount > (Number((c || {}).points) || 0) + 0.005) return 'Only ' + Math.floor(Number((c || {}).points) || 0) + ' points';
  }
  const cards = {}; for (const p of pays.filter(x => x.method === 'Gift card')) { cards[p.code] = (cards[p.code] || 0) + p.amount; if (cards[p.code] > Number(till.giftCardByCode(p.code).balance) + 0.005) return 'The gift card is used twice for more than it holds'; }
  return '';
}
// Take what was paid off the gift card, the store credit and the points.
async function spendWallet(pays, c, who, saleNo) {
  for (const p of pays) {
    if (p.method === 'Gift card') { const g = till.giftCardByCode(p.code); const left = r2(Number(g.balance) - p.amount); await store.update('giftCards', g.id, { balance: left, status: left > 0.005 ? 'open' : 'used', uses: [...(g.uses || []), { at: store.nowIso(), amount: p.amount, saleNo, by: who }] }); }
    if (p.method === 'Store credit' && c) await store.update('customers', c.id, { storeCredit: r2((Number(customerById(c.id).storeCredit) || 0) - p.amount) });
    if (p.method === 'Points' && c) await store.update('customers', c.id, { points: Math.max(0, Math.round((Number(customerById(c.id).points) || 0) - p.amount)) });
  }
}
// Points for a sale: a % of what was really paid with money (not a gift card
// sold, not points spent). Added to the customer; returns what was earned.
async function earnPoints(c, amount) {
  const pts = loyaltyPct() > 0 && c && amount > 0 ? Math.floor(amount * loyaltyPct() / 100) : 0;
  if (!pts) return { earned: 0, balance: c ? Math.round(Number(c.points) || 0) : null };
  const now = Math.round(Number(customerById(c.id).points) || 0) + pts;
  await store.update('customers', c.id, { points: now });
  return { earned: pts, balance: now };
}
const pointsBase = (lines, pays) => r2(lines.filter(l => l.kind !== 'giftcard').reduce((a, l) => a + (Number(l.net) || 0), 0) - pays.filter(p => p.method === 'Points' || p.method === 'Gift card' || p.method === 'Store credit').reduce((a, p) => a + p.amount, 0));

async function completeSale(pays, kind) {
  kind = kind || 'sale';
  const t = totals();
  const nets = lineNets();
  const c = customerById(cart.customerId) || null;
  const who = till.ringer();
  const now = store.nowIso();
  const sn = await store.nextNumber('saleNo', 1);
  const saleNo = 'S-' + String(sn).padStart(4, '0');
  const due = addDays(today(), leadDays());
  const amount = r2(pays.reduce((a, p) => a + p.amount, 0));

  // 1. orders for made-to-order lines (to the sale's delivery address, if it has one)
  const delivery = cart.lines.find(l => l.delivery);
  const lines = [];
  for (const [i, l] of cart.lines.entries()) {
    const line = { kind: l.kind, productId: l.productId || '', name: l.name, qty: Number(l.qty) || 0, unitPrice: r2(l.unitPrice), disc: lineDisc(l), net: nets[i], fabric: l.fabric || '', note: l.note || '', orderId: '', orderNo: '',
      ...(l.custom ? { custom: true } : {}), ...(l.delivery ? { delivery: true } : {}), ...(l.shop ? { shop: true, variantId: l.variantId, inventoryItemId: l.inventoryItemId || '' } : {}) };
    if (l.kind === 'giftcard') {
      const code = till.newGiftCode();
      await store.create('giftCards', { code, amount: line.net, balance: line.net, status: 'open', saleNo, customerId: c ? c.id : '', customerName: c ? c.name : '', soldBy: who, uses: [] });
      line.giftCode = code; line.note = 'Code ' + code;
    }
    if (l.kind === 'order') {
      const n = await store.nextNumber('orderNo', settings.firstOrderNo || 1001);
      const orderNo = (settings.orderPrefix || 'CP-') + n;
      const id = await store.create('orders', {
        orderNo, customerId: c ? c.id : '', customerName: c ? c.name : '', externalRef: saleNo, source: 'pos', saleNo,
        product: l.name, qty: line.qty, fabric: l.fabric || '', notes: [l.note, 'Sold at the till on ' + saleNo].filter(Boolean).join('\n'),
        ...(delivery ? { deliveryMethod: 'delivery', deliveryAddress: delivery.deliveryAddress, deliveryInstructions: delivery.note || '' } : {}),
        paidDate: today(), dueDate: due, priceEach: r2(line.net / (line.qty || 1)), status: 'new', fabricStatus: 'none',
        events: [{ at: now, by: who, what: 'Sold at the till (' + saleNo + ')' }]
      });
      line.orderId = id; line.orderNo = orderNo;
    } else if (l.productId && kind !== 'layby') {     // a layby's stock leaves the shelf when it is collected
      const p = allProducts().find(x => x.id === l.productId);
      if (p && Number.isFinite(Number(p.stock))) await store.update('products', p.id, { stock: Math.max(0, (Number(p.stock) || 0) - line.qty) });
    }
    lines.push(line);
  }

  // 2. the invoice, with the payments on it
  const inNo = await store.nextNumber('invoiceNo', settings.firstInvoiceNo || 1);
  const invoiceNo = (settings.invoicePrefix || 'INV-') + String(inNo).padStart(4, '0');
  const payments = pays.filter(p => p.amount > 0).map(p => ({ at: today(), amount: p.amount, method: p.method, ref: p.method === 'Gift card' ? p.code : p.ref, by: who }));
  const paid = amount >= t.total - 0.005;
  const invLines = lines.map(l => ({ orderId: l.orderId, orderNo: l.orderNo, externalRef: '', qty: l.qty, unitPrice: l.unitPrice,
    description: l.name + (l.fabric ? ' — ' + l.fabric : '') + (l.kind === 'order' ? ' (made to order, due ' + niceDate(due) + ')' : l.kind === 'giftcard' ? ' ' + (l.giftCode || '') : l.custom ? '' : ' (from stock)') }));
  if (t.discount) invLines.push({ orderId: '', orderNo: '', externalRef: '', description: 'Discount' + (t.pct ? ' (' + (Math.round(t.pct * 10) / 10) + '%)' : ''), qty: 1, unitPrice: -t.discount });
  const invoiceId = await store.create('invoices', {
    invoiceNo, customerId: c ? c.id : '', customerName: c ? c.name : 'Walk-in customer', date: today(),
    dueDate: paid ? today() : due, lines: invLines, incl: true, subtotal: t.subtotal, vat: t.vat, vatRate: vatRate(), total: t.total,
    status: paid ? 'paid' : 'issued', paidAt: paid ? today() : '', payments, note: (kind === 'layby' ? 'Layby ' : kind === 'account' ? 'On account: till sale ' : 'Till sale ') + saleNo + (cart.note ? ' · ' + cart.note : ''),
    saleNo, events: [{ at: now, by: who, what: 'Raised at the till (' + saleNo + ')' }]
  });
  for (const l of lines) if (l.orderId) await store.update('orders', l.orderId, { invoiceId, invoiceNo });

  // 3. the sale itself
  const cash = pays.find(p => p.method === 'Cash' && p.tendered != null);
  const me = till.tillUser();
  // the gift card, the store credit and the points are spent; points are earned
  await spendWallet(pays, c, who, saleNo);
  const pts = kind === 'sale' ? await earnPoints(c, pointsBase(lines, pays)) : { earned: 0, balance: c ? Math.round(Number(c.points) || 0) : null };
  const sale = { saleNo, kind, date: today(), time: new Date().toTimeString().slice(0, 5), customerId: c ? c.id : '', customerName: c ? c.name : 'Walk-in customer',
    lines, incl: true, subtotal: t.subtotal, discount: t.discount, discountPct: Number(cart.discountPct) || 0, vat: t.vat, total: t.total,
    paidNow: amount, method: [...new Set(payments.map(p => p.method))].join(' + '), ref: payments.map(p => p.ref).filter(Boolean).join(', '), payments: pays.map(p => ({ ...p, at: now, by: who })),
    ...(cash ? { tendered: cash.tendered, change: cash.change } : {}),
    balance: r2(t.total - amount), invoiceId, invoiceNo, note: cart.note, by: who, ...(me ? { tillStaffId: me.id } : {}),
    ...(pts.earned ? { pointsEarned: pts.earned, pointsBalance: pts.balance } : {}),
    ...(kind === 'layby' ? { status: 'layby' } : {}),
    ...(lines.some(l => l.shop) && kind !== 'layby' ? { shopifySale: true } : {}) };
  const saleId = await store.create('sales', sale);

  // pieces from the shelf also come off the online shop's count: a sale of the
  // shop's stock becomes a Shopify order (a layby's only when it is collected)
  if (kind !== 'layby') {
    store.shopifyPushSale(saleId, lines);
    if (lines.some(l => l.shop)) { till.takeFromShop(lines); setTimeout(() => till.refreshCatalogue(true), 4000); }
  }

  const made = lines.filter(l => l.kind === 'order').length;
  cart = emptyCart(); persist();
  toast(saleNo + (kind === 'layby' ? ' layby opened' : kind === 'account' ? ' on account' : ' complete') + (made ? ' · ' + made + ' order' + (made === 1 ? '' : 's') + ' sent to the factory' : '') + (pts.earned ? ' · ' + pts.earned + ' points earned' : ''));
  rerender();
  setTimeout(() => saleDone({ ...sale, id: saleId }, c), 0);     // once the payment box has closed
}

// After the sale: the slip prints, and can go to the customer by WhatsApp or
// email; the A4 invoice is there for whoever wants one.
function saleDone(sale, c) {
  const cur = settings.currency || 'R';
  const m = openModal('Sale ' + sale.saleNo + ' complete', `
    <div class="cost-live" style="margin-top:0"><div class="tot"><span>Total</span><strong>${esc(money(sale.total, cur))}</strong></div>
      ${sale.tendered ? `<div><span>Cash given</span><strong>${esc(money(sale.tendered, cur))}</strong></div><div class="tot"><span>Change</span><strong>${esc(money(sale.change, cur))}</strong></div>` : ''}
      ${Number(sale.balance) > 0 ? `<div><span>${sale.kind === 'layby' ? 'Still owing on the layby' : sale.kind === 'account' ? 'On the account' : 'Still owing'}</span><strong>${esc(money(sale.balance, cur))}</strong></div>` : ''}
      ${(sale.lines || []).filter(l => l.giftCode).map(l => `<div><span>Gift card ${esc(money(l.net, cur))}</span><strong>${esc(l.giftCode)}</strong></div>`).join('')}
      ${sale.pointsEarned ? `<div><span>Points earned</span><strong>${esc(sale.pointsEarned)} (now ${esc(sale.pointsBalance)})</strong></div>` : ''}</div>
    <div class="pay-kinds" style="grid-template-columns:1fr 1fr">
      <button type="button" class="btn primary" data-slip="print">🖨 Print slip</button>
      <button type="button" class="btn" data-slip="invoice">A4 invoice</button>
      <button type="button" class="btn" data-slip="wa">WhatsApp</button>
      <button type="button" class="btn" data-slip="mail">Email</button>
    </div>
    <p class="muted">${c && c.phone ? 'WhatsApp goes to ' + esc(c.phone) + '.' : 'WhatsApp opens for you to pick the chat.'}</p>`, { okLabel: 'Done', cancelLabel: 'Close' });
  m.wrap.querySelectorAll('[data-slip]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.slip;
    if (k === 'print') till.printSlip(sale); else if (k === 'invoice') printInvoice(sale.invoiceId); else till.shareSlip(sale, k, c);
  }));
  setTimeout(() => till.printSlip(sale), 150);
}

// ------------------------------------------------- paying later, collecting ----

// Money on a sale that still owes (a layby, an account sale, a deposit).
function payOnSale(id) {
  const s = sales.find(x => x.id === id); if (!s || !(Number(s.balance) > 0.005)) return;
  const inv = s.invoiceId ? invoiceById(s.invoiceId) : null;
  const c = customerById(s.customerId) || null;
  const cur = settings.currency || 'R';
  const owing = inv ? Math.max(0, balance(inv)) : Number(s.balance) || 0;
  const m = openModal('Payment on ' + s.saleNo + (s.kind === 'layby' ? ' (layby)' : s.kind === 'account' ? ' (on account)' : ''), `
    <p class="muted" style="margin-top:0">${esc(s.customerName || '')} · total ${esc(money(s.total, cur))} · <strong>owing ${esc(money(owing, cur))}</strong></p>
    ${row(field('Amount', 'pl-amt', { type: 'number', min: 0, step: '0.01', value: owing }), field('Method', 'pl-method', { type: 'select', value: 'Card', options: METHODS.map(x => ({ value: x, label: x })) }))}
    <div id="pl-cash" hidden>${row(field('Cash given', 'pl-tend', { type: 'number', min: 0, step: '0.01' }), '<div class="fld"><span>Change</span><strong id="pl-change" style="font-size:18px">—</strong></div>')}</div>
    <div id="pl-gift" hidden>${field('Gift card code', 'pl-code')}</div>
    ${field('Reference', 'pl-ref', { placeholder: 'Optional' })}`, {
    okLabel: 'Take payment',
    onOk: async (w) => {
      const amount = r2(parseFloat(val(w, 'pl-amt')) || 0), method = val(w, 'pl-method');
      if (!(amount > 0)) { toast('How much?', 'warn'); return false; }
      if (amount > owing + 0.005) { toast('That is more than the ' + money(owing, cur) + ' owing', 'warn'); return false; }
      const tendRaw = val(w, 'pl-tend'); const tendered = method === 'Cash' && tendRaw !== '' ? r2(parseFloat(tendRaw) || 0) : null;
      if (tendered != null && tendered < amount - 0.005) { toast('Cash given is less than the amount', 'warn'); return false; }
      const p = { method, amount, ref: val(w, 'pl-ref'), tendered, change: tendered != null ? r2(tendered - amount) : 0, ...(method === 'Gift card' ? { code: val(w, 'pl-code') } : {}) };
      if (!c && (method === 'Store credit' || method === 'Points')) { toast('This sale has no customer', 'warn'); return false; }
      const bad = checkWallet([p], c); if (bad) { toast(bad, 'warn'); return false; }
      await takePayment(s, inv, [p]);
      toast(money(amount, cur) + ' taken on ' + s.saleNo + (p.change ? ' · change ' + money(p.change, cur) : ''));
      const after = sales.find(x => x.id === id);
      if (after && s.kind === 'layby' && !(Number(after.balance) > 0.005)) setTimeout(() => collectLayby(id), 300);
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  const live = () => { const mth = card.querySelector('#pl-method').value; card.querySelector('#pl-cash').hidden = mth !== 'Cash'; card.querySelector('#pl-gift').hidden = mth !== 'Gift card';
    card.querySelector('#pl-change').textContent = money(Math.max(0, (parseFloat(card.querySelector('#pl-tend').value) || 0) - (parseFloat(card.querySelector('#pl-amt').value) || 0)), cur); };
  card.addEventListener('input', live); card.addEventListener('change', live); live();
}
// The payment itself: on the invoice, on the sale, off the card / credit / points.
async function takePayment(s, inv, pays) {
  const who = till.ringer(), now = store.nowIso();
  const c = customerById(s.customerId) || null;
  const amount = r2(pays.reduce((a, p) => a + p.amount, 0));
  await spendWallet(pays, c, who, s.saleNo);
  if (inv) {
    const payments = [...(inv.payments || []), ...pays.map(p => ({ at: today(), amount: p.amount, method: p.method, ref: p.method === 'Gift card' ? p.code : p.ref, by: who }))];
    const paid = r2(payments.reduce((t, p) => t + (Number(p.amount) || 0), 0));
    const patch = { payments };
    if (paid >= (Number(inv.total) || 0) - 0.005) { patch.status = 'paid'; patch.paidAt = today(); }
    await store.update('invoices', inv.id, patch, 'Payment ' + money(amount, settings.currency || 'R') + ' at the till (' + pays.map(p => p.method).join(' + ') + ')');
  }
  const paidNow = r2((Number(s.paidNow) || 0) + amount);
  await store.update('sales', s.id, { paidNow, balance: r2(Math.max(0, (Number(s.total) || 0) - paidNow)), payments: [...(s.payments || []), ...pays.map(p => ({ ...p, at: now, by: who }))] });
}
// A paid layby goes out of the door: its stock leaves, the shop gets its order, points are earned.
async function collectLayby(id) {
  const s = sales.find(x => x.id === id); if (!s || s.kind !== 'layby' || s.collectedAt) return;
  if (Number(s.balance) > 0.005) { toast(money(s.balance, settings.currency || 'R') + ' is still owing on ' + s.saleNo, 'warn'); return; }
  if (!confirm('Hand over layby ' + s.saleNo + ' to ' + (s.customerName || 'the customer') + '?')) return;
  const c = customerById(s.customerId) || null;
  for (const l of s.lines || []) {
    if (l.kind === 'stock' && l.productId) { const p = allProducts().find(x => x.id === l.productId); if (p && Number.isFinite(Number(p.stock))) await store.update('products', p.id, { stock: Math.max(0, (Number(p.stock) || 0) - l.qty) }); }
  }
  const pts = await earnPoints(c, pointsBase(s.lines || [], s.payments || []));
  await store.update('sales', id, { status: 'collected', collectedAt: store.nowIso(), collectedBy: till.ringer(), ...(pts.earned ? { pointsEarned: pts.earned, pointsBalance: pts.balance } : {}), ...((s.lines || []).some(l => l.shop) ? { shopifySale: true } : {}) });
  if ((s.lines || []).some(l => l.shop)) { store.shopifyPushSale(id, s.lines); till.takeFromShop(s.lines); setTimeout(() => till.refreshCatalogue(true), 4000); }
  toast(s.saleNo + ' collected' + (pts.earned ? ' · ' + pts.earned + ' points earned' : ''));
}
// Money against a customer's account: the oldest open sale first.
function accountPayment() {
  const cur = settings.currency || 'R';
  const owing = {}; sales.forEach(s => { if (s.customerId && Number(s.balance) > 0.005) owing[s.customerId] = r2((owing[s.customerId] || 0) + Number(s.balance)); });
  const custs = allCustomers().filter(c => owing[c.id]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!custs.length) { toast('Nobody owes anything on the till', 'warn'); return; }
  const m = openModal('Account payment', `
    ${field('Customer', 'ap-cust', { type: 'select', options: custs.map(c => ({ value: c.id, label: c.name + ' — owes ' + money(owing[c.id], cur) })) })}
    <div class="muted" id="ap-list" style="margin:-.3rem 0 .6rem"></div>
    ${row(field('Amount', 'ap-amt', { type: 'number', min: 0, step: '0.01' }), field('Method', 'ap-method', { type: 'select', value: 'EFT', options: ['EFT', 'Card', 'Cash', 'Other'].map(x => ({ value: x, label: x })) }))}
    <div id="ap-cash" hidden>${row(field('Cash given', 'ap-tend', { type: 'number', min: 0, step: '0.01' }), '<div class="fld"><span>Change</span><strong id="ap-change" style="font-size:18px">—</strong></div>')}</div>
    ${field('Reference', 'ap-ref', { placeholder: 'Bank reference / receipt no.' })}`, {
    okLabel: 'Take payment',
    onOk: async (w) => {
      const cid = val(w, 'ap-cust'), method = val(w, 'ap-method');
      let left = r2(parseFloat(val(w, 'ap-amt')) || 0);
      if (!(left > 0)) { toast('How much?', 'warn'); return false; }
      if (left > owing[cid] + 0.005) { toast('That is more than the ' + money(owing[cid], cur) + ' owing', 'warn'); return false; }
      const tendRaw = val(w, 'ap-tend'); const tendered = method === 'Cash' && tendRaw !== '' ? r2(parseFloat(tendRaw) || 0) : null;
      if (tendered != null && tendered < left - 0.005) { toast('Cash given is less than the amount', 'warn'); return false; }
      const open = sales.filter(s => s.customerId === cid && Number(s.balance) > 0.005).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const total = left;
      for (const s of open) {
        if (left <= 0.005) break;
        const take = Math.min(left, r2(Number(s.balance)));
        await takePayment(s, s.invoiceId ? invoiceById(s.invoiceId) : null, [{ method, amount: take, ref: val(w, 'ap-ref'), tendered: null, change: 0 }]);
        left = r2(left - take);
      }
      toast(money(total, cur) + ' taken on account' + (tendered != null && tendered > total ? ' · change ' + money(tendered - total, cur) : ''));
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  const live = () => {
    const cid = card.querySelector('#ap-cust').value;
    card.querySelector('#ap-list').innerHTML = sales.filter(s => s.customerId === cid && Number(s.balance) > 0.005).map(s => esc(s.saleNo + ' ' + niceDate(s.date) + (s.kind ? ' (' + s.kind + ')' : '') + ': owes ' + money(s.balance, cur))).join('<br>');
    if (!card.querySelector('#ap-amt').value) card.querySelector('#ap-amt').value = owing[cid];
    const mth = card.querySelector('#ap-method').value; card.querySelector('#ap-cash').hidden = mth !== 'Cash';
    card.querySelector('#ap-change').textContent = money(Math.max(0, (parseFloat(card.querySelector('#ap-tend').value) || 0) - (parseFloat(card.querySelector('#ap-amt').value) || 0)), cur);
  };
  card.querySelector('#ap-cust').addEventListener('change', () => { card.querySelector('#ap-amt').value = ''; live(); });
  card.addEventListener('input', live); live();
}

// ---------------------------------------------------------------- render ----

let host = null;
const rerender = () => { if (host) renderPos(host); };

export function renderPos(h) {
  host = h;
  const cur = settings.currency || 'R';
  // PINs set up and nobody unlocked: the till is locked
  if (till.usesPins() && !till.tillUser()) {
    h.innerHTML = `<div class="page-head"><div><h1>Point of sale</h1><p class="sub">${esc(settings.name || '')}</p></div></div>` + till.lockHtml();
    const i = h.querySelector('#till-pin');
    if (i) { i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); till.tillKey('ok'); } }); i.addEventListener('input', () => { if (i.value.length >= 4) till.tillKey(''); }); setTimeout(() => i.focus(), 50); }
    return;
  }
  if (posTab === 'sale') till.refreshCatalogue();
  const me = till.tillUser();
  const tab = (key, label) => `<button class="btn ${posTab === key ? 'primary' : 'ghost'} sm" data-act="pos-tab" data-to="${key}">${label}</button>`;
  h.innerHTML = `
    <div class="page-head"><div><h1>Point of sale</h1><p class="sub">${till.shopOn() ? 'Selling the online shop’s stock' + (till.catalogueAt() ? ' · stock as at ' + esc(new Date(till.catalogueAt()).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })) : '') + (till.catalogueLoading() ? ' · reading the shop…' : '') + '. ' : ''}Made-to-order lines go straight to the factory.${!till.openShift() ? ' <span class="chip calm" title="Open it under Register for the day’s cash-up">register closed</span>' : ''}${store.shopifyPendingCount() ? ' <span class="chip late">' + store.shopifyPendingCount() + ' sale(s) still to reach the shop</span>' : ''}${till.catalogueError() ? ' <span class="chip late">' + esc(till.catalogueError()) + '</span>' : ''}</p></div>
      <div class="btn-row">${me ? `<span class="chip calm" title="Who is ringing">${esc(me.name)}${till.isManager(me) ? ' · manager' : ''}</span><button class="btn ghost sm" data-act="till-lock" title="Lock the till">🔒 Lock</button>` : ''}${till.shopOn() ? `<button class="btn ghost sm" data-act="till-refresh" title="Read the shop’s stock again">↻</button>` : ''}${tab('sale', 'New sale')}${tab('sales', 'Sales')}${tab('register', 'Register')}${till.shopOn() ? tab('stock', 'Stock') : ''}${tab('dash', 'Dashboard')}</div></div>
    ${posTab === 'sale' ? saleHtml(cur) : posTab === 'register' ? till.registerHtml(sales) : posTab === 'stock' ? '<div id="ss-host"></div>' : posTab === 'dash' ? shopstock.dashboardHtml(sales) : salesHtml(cur)}`;
  if (posTab === 'stock') shopstock.renderShopStock(h.querySelector('#ss-host'), sales);
  if (posTab === 'sale') {
    const s = h.querySelector('#pos-search');
    if (s) {
      s.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(s); } });
      if (search) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
  }
}

// What the tiles show: the shop's products when it is connected (factory
// products already in the shop are not shown twice), plus the factory's own
// products, made to order.
function tiles() {
  const shopOn = till.shopOn();
  const out = till.shopItems().map(i => ({ id: 'v:' + i.variantId, name: i.name, category: i.category || 'Shop', price: i.price, image: i.image, sku: i.sku, barcode: i.barcode,
    stock: i.tracked ? 'stock' : 'untracked', qty: i.qty, tracked: i.tracked, shop: true }));
  allProducts().forEach(p => {
    if (shopOn && p.shopifyVariantId) return;
    out.push({ id: p.id, name: p.name, category: p.category || 'Other', price: Number(p.sellingPrice) || 0, image: p.imageUrl, barcode: p.barcode, stock: Number(p.stock) > 0 ? 'stock' : 'order', qty: Number(p.stock) || 0 });
  });
  return out;
}
const matchesTile = (t, q) => !q || [t.name, t.sku, t.barcode].some(v => String(v || '').toLowerCase().includes(q));
const keyOf = (t) => t.shop ? t.id.slice(2) : 'p-' + t.id;
function saleHtml(cur) {
  const prods = tiles();
  const cats = [...new Set(prods.map(p => p.category || 'Other'))].sort();
  const q = search.trim().toLowerCase();
  const shown = prods.filter(p => (!cat || (p.category || 'Other') === cat) && matchesTile(p, q));
  const c = customerById(cart.customerId);
  const t = totals();
  return `<div class="pos">
    <div class="pos-left">
      <div class="toolbar" style="margin-bottom:.6rem">
        <input id="pos-search" class="search pos-in" placeholder="Search, or scan a barcode…" value="${esc(search)}" autocomplete="off">
        <button class="btn ghost" data-act="pos-scan" title="Scan a barcode with the camera">📷 Scan</button>
        <button class="btn ghost" data-act="pos-custom">Other item</button>
        <button class="btn ghost" data-act="pos-delivery" title="Add a delivery fee and where it goes">🚚 Delivery</button>
        <button class="btn ghost" data-act="pos-giftcard" title="Sell a gift card">🎁 Gift card</button>
      </div>
      <div class="btn-row" style="margin-bottom:.7rem">
        <button class="btn ${!cat ? 'primary' : 'ghost'} sm" data-act="pos-cat" data-to="">All</button>
        ${cats.map(x => `<button class="btn ${cat === x ? 'primary' : 'ghost'} sm" data-act="pos-cat" data-to="${esc(x)}">${esc(x)}</button>`).join('')}
        <span style="flex:1"></span>
        <button class="btn ${quickEdit ? 'primary' : 'ghost'} sm" data-act="pos-quick-edit" title="Tap products to add them to, or take them off, the quick keys">⭐ ${quickEdit ? 'Done' : 'Quick keys'}</button>
      </div>
      ${quickEdit ? '<p class="notice-inline">Tap a product to star it (or un-star it). Starred products show first. Tap Done when you are finished.</p>' : ''}
      ${!cat && !q && !quickEdit && prods.some(p => shopstock.isQuickKey(keyOf(p))) ? `<div class="pos-grid pos-quick">${prods.filter(p => shopstock.isQuickKey(keyOf(p))).map(p => `
        <button class="pos-tile quick${p.stock === 'stock' && p.tracked && !(p.qty > 0) ? ' out' : ''}" data-act="pos-add" data-id="${esc(p.id)}"${p.stock === 'stock' && p.tracked && !(p.qty > 0) ? ' disabled' : ''}>
          <span class="pos-tile-cat">⭐ ${esc(p.category || '')}</span><span class="pos-tile-name">${esc(p.name)}</span><span class="pos-tile-price">${esc(money(p.price || 0, cur))}</span>
        </button>`).join('')}</div>` : ''}
      ${shown.length ? `<div class="pos-grid">${shown.map(p => `
        <button class="pos-tile${p.stock === 'stock' && p.tracked && !(p.qty > 0) ? ' out' : ''}${shopstock.isQuickKey(keyOf(p)) ? ' starred' : ''}" data-act="pos-add" data-id="${esc(p.id)}" data-key="${esc(keyOf(p))}" data-name="${esc(p.name)}"${p.stock === 'stock' && p.tracked && !(p.qty > 0) && !quickEdit ? ' disabled' : ''}>
          ${productImg({ imageUrl: p.image }, 'pos-tile-img', 400)}
          <span class="pos-tile-cat">${esc(p.category || '')}</span>
          <span class="pos-tile-name">${esc(p.name)}</span>
          <span class="pos-tile-price">${esc(money(p.price || 0, cur))}</span>
          <span class="pos-tile-stock">${p.stock === 'order' ? 'made to order' : p.stock === 'untracked' ? (p.shop ? 'in the shop' : '') : p.qty > 0 ? p.qty + ' in stock' : 'out of stock'}</span>
        </button>`).join('')}</div>` : empty('', 'No products', prods.length ? 'Nothing matches.' : till.shopOn() ? 'Reading the shop’s products…' : 'Add products under Costing first.')}
    </div>
    <div class="pos-right">
      <div class="card pos-cart">
        <button class="pos-cust" data-act="pos-customer">${c ? `<strong>${esc(c.name)}</strong><span>${esc([c.phone, c.area].filter(Boolean).join(' · ') || 'tap to change')}</span>${Number(c.points) > 0 || Number(c.storeCredit) > 0 ? `<span>${Number(c.points) > 0 ? '⭐ ' + esc(Math.round(Number(c.points))) + ' points' : ''}${Number(c.points) > 0 && Number(c.storeCredit) > 0 ? ' · ' : ''}${Number(c.storeCredit) > 0 ? 'store credit ' + esc(money(c.storeCredit, cur)) : ''}</span>` : ''}` : '<strong>Customer</strong><span>Tap to pick or add (needed for made-to-order, layby, on account)</span>'}</button>
        <div class="pos-lines">${cart.lines.length ? cart.lines.map((l, i) => `
          <div class="pos-line">
            <div class="pos-line-top">
              <strong>${esc(l.name)}</strong>
              <button class="icon-btn" data-act="pos-remove" data-i="${i}" title="Remove">✕</button>
            </div>
            <div class="pos-line-ctl">
              <span class="qty"><button class="btn ghost sm" data-act="pos-qty" data-i="${i}" data-d="-1">−</button><b>${esc(l.qty)}</b><button class="btn ghost sm" data-act="pos-qty" data-i="${i}" data-d="1">+</button></span>
              <input class="pos-in" data-field="unitPrice" data-i="${i}" type="number" min="0" step="0.01" value="${esc(l.unitPrice)}" title="Price each"${l.shop ? ' readonly' : ''}>
              <strong class="pos-line-tot">${esc(money(lineTotal(l), cur))}</strong>
            </div>
            <div class="pos-line-disc"><button class="btn ghost sm" data-act="pos-line-disc" data-i="${i}" title="Discount on this line">${l.disc ? '− ' + esc(money(l.disc, cur)) + ' off' : '% off'}</button>${l.shop && l.tracked ? `<span class="muted">${esc(l.stockQty)} in the shop</span>` : ''}</div>
            ${l.custom || l.shop ? '' : `<div class="pos-kind">
              <button class="${l.kind === 'order' ? 'on' : ''}" data-act="pos-kind" data-i="${i}" data-to="order">Made to order</button>
              <button class="${l.kind === 'stock' ? 'on' : ''}" data-act="pos-kind" data-i="${i}" data-to="stock">From stock</button>
            </div>
            ${l.kind === 'order' ? `<input class="pos-in" data-field="fabric" data-i="${i}" value="${esc(l.fabric)}" placeholder="Fabric / colour" list="fabric-list">` : ''}`}
            <input class="pos-in" data-field="note" data-i="${i}" value="${esc(l.note)}" placeholder="Note (optional)">
          </div>`).join('') : '<div class="muted" style="padding:1.2rem .4rem; text-align:center">Tap a product to start a sale.</div>'}
        </div>
        <div class="pos-totals">
          <div><span>Items (${t.pieces})</span><strong>${esc(money(t.subtotalRaw, cur))}</strong></div>
          ${t.lineDiscs ? `<div><span>Line discounts</span><strong>− ${esc(money(t.lineDiscs, cur))}</strong></div>` : ''}
          <div><span>Discount on the sale</span><button class="btn ghost sm" data-act="pos-cart-disc">${t.cartDisc ? '− ' + esc(money(t.cartDisc, cur)) + (cart.discountPct ? ' (' + esc(cart.discountPct) + '%)' : '') : 'none'}</button></div>
          ${vatRate() ? `<div class="muted"><span>Includes VAT ${Math.round(vatRate() * 100)}%</span><strong>${esc(money(t.vat, cur))}</strong></div>` : ''}
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
    <div class="btn-row" style="margin-bottom:.7rem"><button class="btn ghost" data-act="pos-account" title="Money from a customer who owes on a layby or an account sale">Account payment</button>${(() => { const o = r2(sales.reduce((a, s) => a + Math.max(0, Number(s.balance) || 0), 0)); return o ? '<span class="chip late">owed to the till: ' + esc(money(o, cur)) + '</span>' : ''; })()}</div>
    ${sales.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>Sale</th><th>Date</th><th>Customer</th><th>Items</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Invoice</th><th></th></tr></thead>
      <tbody>${sales.slice(0, 200).map(s => `<tr>
        <td><strong>${esc(s.saleNo)}</strong>${s.kind === 'layby' ? ' <span class="chip ' + (s.collectedAt ? 'calm' : 'late') + '">' + (s.collectedAt ? 'layby collected' : 'layby') + '</span>' : s.kind === 'account' ? ' <span class="chip ' + (Number(s.balance) > 0.005 ? 'late' : 'calm') + '">on account</span>' : ''}<div class="muted">${esc(s.by || '')}</div></td><td>${esc(niceDate(s.date))}</td><td>${esc(s.customerName || '')}</td>
        <td>${(s.lines || []).map(l => esc(l.qty + '× ' + l.name) + (l.kind === 'order' ? ' <span class="chip st-prod">' + esc(l.orderNo || 'order') + '</span>' : ' <span class="chip calm">' + (l.shop ? 'shop' : 'stock') + '</span>')).join('<br>')}${s.shopifyOrderName ? '<div class="muted">Shop order ' + esc(s.shopifyOrderName) + '</div>' : s.shopifySale ? '<div class="muted">to the shop…</div>' : ''}
          ${(s.returns || []).map(r => `<div class="muted" style="margin-top:3px">↩ ${esc(r.returnNo)} ${esc(niceDate(r.date))}: ${esc((r.lines || []).map(x => x.qty + '× ' + x.name).join(', '))}${Number(r.refund) ? ' · refunded ' + esc(money(r.refund, cur)) : ''}${r.creditId ? ` <button class="btn ghost sm" data-act="pos-reprint" data-id="${esc(r.creditId)}">${esc(r.creditNo || 'Credit note')}</button>` : ''}</div>`).join('')}</td>
        <td class="r">${esc(money(s.total, cur))}</td><td class="r">${esc(money(s.paidNow, cur))}${s.method ? '<div class="muted">' + esc(s.method) + '</div>' : ''}</td>
        <td class="r">${Number(s.balance) > 0 ? '<strong>' + esc(money(s.balance, cur)) + '</strong>' : '—'}</td>
        <td>${esc(s.invoiceNo || '')}</td>
        <td class="r nowrap">${Number(s.balance) > 0.005 ? `<button class="btn primary sm" data-act="pos-pay" data-id="${esc(s.id)}">Pay</button> ` : ''}${s.kind === 'layby' && !s.collectedAt && !(Number(s.balance) > 0.005) ? `<button class="btn primary sm" data-act="pos-collect" data-id="${esc(s.id)}">Collect</button> ` : ''}<button class="btn ghost sm" data-act="pos-slip" data-id="${esc(s.id)}" title="80 mm slip">Slip</button>${s.invoiceId ? ` <button class="btn ghost sm" data-act="pos-reprint" data-id="${esc(s.invoiceId)}" title="A4 invoice">Invoice</button>` : ''} <button class="btn ghost sm" data-act="pos-share" data-id="${esc(s.id)}" data-how="wa" title="Send the slip on WhatsApp">WA</button>${(s.lines || []).some((l, i) => returnedQty(s, i) < (Number(l.qty) || 0)) ? ` <button class="btn ghost sm" data-act="pos-return" data-id="${esc(s.id)}">Return</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : empty('', 'No sales yet', 'Ring up the first one under New sale.')}`;
}

// -------------------------------------------------------------- returns -----

const returnedQty = (s, i) => (s.returns || []).reduce((t, r) => t + (r.lines || []).filter(x => x.i === i).reduce((a, x) => a + (Number(x.qty) || 0), 0), 0);
// the till discount, spread over the lines, and the VAT the sale carried
const saleFactor = (s) => { const raw = (s.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0); return raw > 0 ? (Number(s.subtotal) || 0) / raw : 1; };
const saleVat = (s) => Number(s.subtotal) ? (Number(s.vat) || 0) / Number(s.subtotal) : 0;
// what a line really took, excl. VAT: its net (newer sales carry it per line,
// discounts and all), else the list price × the sale's factor
const lineExTotal = (s, l) => l.net != null ? r2(Number(l.net) / (1 + saleVat(s))) : r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * saleFactor(s));
const unitExOf = (s, l) => r2(lineExTotal(s, l) / ((Number(l.qty) || 0) || 1));
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
  if (o.status === 'cancelled') return { ok: true, mode: 'gone', o, note: 'Factory order ' + o.orderNo + ' is cancelled: refund only' };
  if (o.status === 'new') return { ok: true, mode: 'cancel', o, note: 'Not started: factory order ' + o.orderNo + ' is cancelled' };
  if (o.status === 'ready') return { ok: true, mode: 'built', o, note: 'Finished, not delivered: order ' + o.orderNo + ' is closed' };
  if (o.status === 'dispatched' || o.status === 'invoiced') return { ok: true, mode: 'back', o, counted: true, note: 'Delivered: the piece comes back' };
  return { ok: false, o, note: 'Being built (' + statusMeta(o.status).label + '). Finish it first, or change the order.' };
}
const canShelve = (l, st) => st.ok && (st.mode === 'back' || st.mode === 'built') && (productExists(l.productId) || !!l.inventoryItemId);

// The value of what comes back. The last pieces of a line, and the last
// lines of the sale, take exactly what is left, so returning everything
// never credits a cent more than was charged.
function returnAmounts(s, picks) {
  const vr = saleVat(s);
  const per = picks.map(p => {
    const l = s.lines[p.i];
    const unitEx = unitExOf(s, l);
    const last = returnedQty(s, p.i) + p.qty >= (Number(l.qty) || 0);
    const ex = last ? r2(Math.max(0, lineExTotal(s, l) - prevLineEx(s, p.i))) : r2(p.qty * unitEx);
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

async function openReturn(id) {
  const s = sales.find(x => x.id === id); if (!s) return;
  const me = till.tillUser();
  if (till.usesPins() && !till.isManager(me) && !(me && me.canRefund)) {
    if (!await till.managerApproval((me ? me.name : 'The till') + ' may not do returns. A manager must approve this return.')) return;
  }
  const cur = settings.currency || 'R';
  const vr = saleVat(s);
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
        <td><strong>${esc(x.l.name)}</strong>${x.l.fabric ? '<div class="muted">' + esc(x.l.fabric) + '</div>' : ''}<div class="muted">${esc(money(r2(unitExOf(s, x.l) * (1 + vr)), cur))} each${x.st.note ? ' · ' + esc(x.st.note) : ''}</div></td>
        <td class="r">${esc(x.left)}${x.left < x.l.qty ? '<div class="muted">of ' + esc(x.l.qty) + '</div>' : ''}</td>
        <td class="r">${x.st.ok ? `<input class="rt-qty" data-i="${x.i}" type="number" min="0" max="${x.left}" step="1" value="${single ? x.left : 0}" style="width:70px">` : '<span class="chip late">not yet</span>'}</td>
        <td>${canShelve(x.l, x.st) ? `<label class="check" style="white-space:nowrap"><input type="checkbox" class="rt-shelf" data-i="${x.i}" checked> Back on the shelf</label>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
    ${row(field('Why is it coming back?', 'rt-why', { type: 'select', value: 'Changed their mind', options: ['Changed their mind', 'Damaged', 'Faulty', 'Wrong item', 'Not as described', 'Other'].map(x => ({ value: x, label: x })) }), field('Note', 'rt-note', { placeholder: 'Optional' }))}
    <div class="cost-live" id="rt-live"></div>
    ${row(field('Refund now', 'rt-refund', { type: 'number', min: 0, step: '0.01', value: 0 }), field('Method', 'rt-method', { type: 'select', value: String(s.method || 'Card').split(' + ')[0], options: ['Card', 'Cash', 'EFT', 'Other'].concat(s.customerId ? ['Store credit'] : []).map(x => ({ value: x, label: x })) }))}
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
    const rec = { i: p.i, qty: p.qty, name: l.name, kind: l.kind, productId: l.productId || '', ...(l.shop ? { inventoryItemId: l.inventoryItemId || '', variantId: l.variantId || '' } : {}), orderNo: l.orderNo || '', unitEx: p.unitEx, ex: p.ex, restock: false, cancelled: false, counted: !!st.counted };
    if (st.mode === 'cancel' || st.mode === 'built') {
      // not delivered: the order goes (or gets smaller), so it leaves the floor and the delivery list
      const left = (Number(st.o.qty) || 1) - p.qty;
      // orders are never deleted: one fully returned is cancelled, and stays on record
      if (left <= 0) ops.push({ op: 'update', coll: 'orders', id: st.o.id, patch: { status: 'cancelled', cancelledAt: now, cancelReason: 'Returned at the till (' + returnNo + ')' }, event: 'Cancelled: returned at the till (' + returnNo + ')' });
      else ops.push({ op: 'update', coll: 'orders', id: st.o.id, patch: { qty: left }, event: p.qty + ' returned at the till (' + returnNo + ')' });
      rec.cancelled = true;
    } else if (st.mode === 'back' && st.o) {
      ops.push({ op: 'update', coll: 'orders', id: st.o.id, patch: {}, event: p.qty + ' brought back at the till (' + returnNo + ')' + (p.restock && canShelve(l, st) ? ', back on the shelf' : '') });
    }
    if (p.restock && canShelve(l, st)) { if (productExists(l.productId)) ops.push({ op: 'update', coll: 'products', id: l.productId, patch: { stock: store.inc(p.qty) } }); rec.restock = true; }
    lines.push(rec);
  }
  const payments = [];
  if (refund > 0) payments.push({ at: today(), amount: -refund, method, ref: returnNo, by: who });
  if (setOff > 0) payments.push({ at: today(), amount: -setOff, method: 'Off ' + (s.invoiceNo || 'the invoice'), ref: returnNo, by: who });
  ops.push({ op: 'create', coll: 'invoices', id: creditId, data: {
    kind: 'credit', invoiceNo: creditNo, customerId: s.customerId || '', customerName: s.customerName || 'Walk-in customer', date: today(), dueDate: '',
    // a sale priced incl. VAT is credited the same way: its lines carry the VAT
    incl: !!s.incl,
    lines: lines.map(x => ({ orderId: '', orderNo: x.orderNo, externalRef: '', qty: x.qty, unitPrice: -r2((s.incl ? x.ex * (1 + saleVat(s)) : x.ex) / x.qty),
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
  // a refund as store credit goes onto the customer, to spend at the till
  if (method === 'Store credit' && refund > 0 && s.customerId) { const c = customerById(s.customerId); if (c) ops.push({ op: 'update', coll: 'customers', id: c.id, patch: { storeCredit: r2((Number(c.storeCredit) || 0) + refund) } }); }
  await store.batchWrite(ops);

  // pieces back on the shelf go back on the online shop's count too
  if (lines.some(x => x.restock)) store.shopifyPushReturn(s.id, returnNo);
  toast(returnNo + ' done' + (refund ? ' · refund ' + money(refund, cur) + ' (' + method + ')' : '') + (lines.some(x => x.cancelled) ? ' · factory order closed' : ''));
  setTimeout(() => printInvoice(creditId), 200);
  rerender();
}

// ---------------------------------------------------------------- events ----

export function posAction(act, el) {
  if (act.startsWith('ss-')) return shopstock.shopStockAction(act, el);
  const i = parseInt(el.dataset.i, 10);
  switch (act) {
    case 'pos-tab': posTab = el.dataset.to; return rerender();
    case 'pos-cat': cat = el.dataset.to; return rerender();
    case 'pos-add': if (quickEdit) return shopstock.toggleQuickKey(el.dataset.key, el.dataset.name); if (addAny(el.dataset.id)) rerender(); return;
    case 'pos-quick-edit': quickEdit = !quickEdit; return rerender();
    case 'pos-line-disc': return lineDiscount(i);
    case 'pos-giftcard': return addGiftCard();
    case 'pos-pay': return payOnSale(el.dataset.id);
    case 'pos-collect': return collectLayby(el.dataset.id);
    case 'pos-account': return accountPayment();
    case 'pos-cart-disc': return cartDiscountPrompt();
    case 'pos-slip': { const s = sales.find(x => x.id === el.dataset.id); if (s) till.printSlip(s); return; }
    case 'pos-share': { const s = sales.find(x => x.id === el.dataset.id); if (s) till.shareSlip(s, el.dataset.how, customerById(s.customerId)); return; }
    case 'till-key': return till.tillKey(el.dataset.k);
    case 'till-lock': return till.lockTill();
    case 'till-refresh': return till.refreshCatalogue(true);
    case 'till-open': return till.openRegister();
    case 'till-cash-in': return till.cashMove('in');
    case 'till-cash-out': return till.cashMove('out');
    case 'till-x': { const sh = till.openShift(); if (sh) till.printReport(sh, 'X', sales); return; }
    case 'till-close': return till.closeRegister(sales);
    case 'till-z': { const sh = till.shiftById(el.dataset.id); if (sh) till.printReport(sh, 'Z'); return; }
    case 'till-staff-new': return till.editTillStaff('');
    case 'till-staff-edit': return till.editTillStaff(el.dataset.id);
    case 'till-staff-del': return till.removeTillStaff(el.dataset.id);
    case 'pos-custom': return addCustom();
    case 'pos-delivery': return addDelivery();
    case 'pos-qty': { const l = cart.lines[i]; if (!l) return; const q = Math.max(1, (Number(l.qty) || 1) + parseInt(el.dataset.d, 10));
      if (l.shop && l.tracked) { const it = till.shopItem(l.variantId); const have = it ? Number(it.qty) || 0 : l.stockQty; if (q > have) { toast('Only ' + have + ' in stock', 'warn'); return; } }
      l.qty = q; persist(); return rerender(); }
    case 'pos-remove': cart.lines.splice(i, 1); persist(); return rerender();
    case 'pos-kind': { const l = cart.lines[i]; if (!l) return; l.kind = el.dataset.to; persist(); return rerender(); }
    case 'pos-customer': return pickCustomer();
    case 'pos-clear': if (!cart.lines.length || confirm('Clear this sale?')) { cart = emptyCart(); persist(); rerender(); } return;
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
  const l = cart.lines[parseInt(el.dataset.i, 10)]; if (!l) return;
  if (f === 'unitPrice') { if (l.shop) return; l.unitPrice = parseFloat(el.value) || 0; persist(); return updateTotalsOnly(); }
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
  const tot = box.querySelector('.tot strong'); if (tot) tot.textContent = money(t.total, cur);
  const v = box.querySelector('.muted strong'); if (v) v.textContent = money(t.vat, cur);
}
