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
import { allQuotes, totals as quoteTotals } from './quotes.js';
import { icon } from './icons.js';

let settings = {};
let sales = [];
let unwatch = null;
let onChange = null;
let posTab = 'sale';       // sale | sales | register | stock | dash | clients | orders
let cat = '__home__';      // the category landing, '' for all, else a category
let search = '';
let mCart = false;         // on a phone: the cart instead of the shop
let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
let netOn = false;
let clientQ = '';          // the Clients search
let ordersTab = 'orders';  // orders | quotes
let cart = { lines: [], customerId: '', discount: 0, discountPct: 0, note: '' };

let wedgeOn = false;

export function startPos(cb, cfg) {
  onChange = cb; settings = cfg || {};
  till.startTill(() => rerender(), cfg);
  shopstock.startShopStock(() => rerender(), cfg);
  if (!wedgeOn) { document.addEventListener('keydown', onScannerKey, true); wedgeOn = true; }
  if (!netOn) { netOn = true; window.addEventListener('online', () => { online = true; rerender(); }); window.addEventListener('offline', () => { online = false; rerender(); }); }
  if (unwatch) unwatch();
  unwatch = store.watch('sales', rows => { sales = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); if (onChange) onChange(); });
  // the half-rung sale survives a reload, but stays with its own company
  cart = emptyCart();
  try { const saved = JSON.parse(localStorage.getItem(cartKey()) || 'null'); if (saved && Array.isArray(saved.lines)) cart = saved; } catch (e) {}
}
export const setPosSettings = (cfg) => { settings = cfg || {}; till.setTillSettings(cfg); shopstock.setShopStockSettings(cfg); };
let quickEdit = false;      // tapping a tile stars it instead of selling it
export const setPosShop = (s) => till.setTillShop(s);
let xero = null;
export const setPosXero = (x) => { xero = x; };
// a sale paid in full goes to Xero, when the company has connected it
const sendToXero = (saleId) => { if (xero && xero.connected) store.xeroPushSale(saleId); };
const emptyCart = () => ({ lines: [], customerId: '', discount: 0, discountPct: 0, note: '' });
export const allSales = () => sales;
export const setPosTab = (t) => { posTab = t; };
const cartKey = () => 'cp-pos-cart-' + ((store.getUser() || {}).companyId || 'demo');
const persist = () => { try { localStorage.setItem(cartKey(), JSON.stringify(cart)); } catch (e) {} };
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
  if (it.tracked && have > (Number(it.qty) || 0) && !(existing && existing.backorder)) {
    // not in stock: it can still be sold as a sales order, to come in and be collected
    if (!confirm((it.qty > 0 ? 'Only ' + it.qty + ' in stock. ' : it.name + ' is out of stock. ') + 'Sell it as a SALES ORDER (ordered in for the customer, paid on a layby and collected when it arrives)?')) return false;
    if (existing) { existing.backorder = true; existing.qty += 1; }
    else cart.lines.push({ productId: '', variantId: it.variantId, inventoryItemId: it.inventoryItemId, name: it.name, qty: 1, unitPrice: Number(it.price) || 0, kind: 'stock', fabric: '', note: '', disc: 0, tracked: !!it.tracked, stockQty: Number(it.qty) || 0, shop: true, backorder: true });
    persist(); toast(it.name + ': sales order line (not in stock)'); return true;
  }
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
  const short = cart.lines.filter(l => l.shop && l.tracked && !l.backorder).map(l => ({ l, it: till.shopItem(l.variantId) })).filter(x => x.it && (Number(x.it.qty) || 0) < (Number(x.l.qty) || 0));
  if (short.length) { toast(short.map(x => x.l.name + ': only ' + x.it.qty + ' in stock').join(' · '), 'warn'); return; }
  const backorder = cart.lines.some(l => l.backorder);
  if (backorder && !c) { toast('A sales order needs a customer — tap Customer first', 'warn'); return; }
  const t = totals();
  const cur = settings.currency || 'R';
  const payRow = (n) => `<div class="pay-row" data-n="${n}">
      <select class="py-method" data-n="${n}">${METHODS.map(x => `<option value="${x}"${(n === 1 ? 'Card' : 'Cash') === x ? ' selected' : ''}>${x}</option>`).join('')}</select>
      <input class="py-amt" data-n="${n}" type="number" min="0" step="0.01" value="${n === 1 ? (backorder ? r2(t.total * 0.5) : t.total) : ''}" placeholder="amount" aria-label="Amount">
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
    ${backorder ? field('Expected in the shop by', 'py-expected', { type: 'date', value: addDays(today(), 14) }) + '<p class="notice-inline">Not in stock: this is a <strong>sales order</strong>. The deposit is taken now; the goods are collected when they arrive and the balance is paid (Sales → Pay, then Collect).</p>' : ''}
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
      if (backorder) kind = 'layby';
      if (kind === 'sale' && paid < t.total - 0.005 && !confirm('Only ' + money(paid, cur) + ' of ' + money(t.total, cur) + ' is paid. Record it as a deposit, with the balance due on collection or delivery?')) return false;
      const ok = w.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Saving…';
      try { await completeSale(pays, kind, backorder ? { backorder: true, expectedDate: val(w, 'py-expected') } : null); }
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
  let kind = backorder ? 'layby' : 'sale';
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
    card.querySelector('#py-bal-l').textContent = bal > 0 ? (backorder ? 'Still owing on the sales order' : kind === 'layby' ? 'Still owing on the layby' : kind === 'account' ? 'Put on the account' : 'Still owing after this payment (deposit)') : 'Balance after this payment';
    card.querySelector('#modal-ok').textContent = bal > 0 ? (backorder ? 'Open sales order' : kind === 'layby' ? 'Open layby' : kind === 'account' ? 'Sell on account' : 'Take deposit') : 'Complete sale';
    const note = card.querySelector('#py-kind-note');
    note.hidden = kind === 'sale' || backorder;
    note.textContent = backorder ? '' : kind === 'layby' ? 'Layby: the goods stay in the shop until it is paid in full and collected (Sales → Collect). Made-to-order pieces go to the factory now.' : kind === 'account' ? 'On account: the goods go now; the balance shows on the customer’s invoice and is taken with "Account payment".' : '';
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

async function completeSale(pays, kind, extra) {
  kind = kind || 'sale';
  extra = extra || {};
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
      ...(l.custom ? { custom: true } : {}), ...(l.delivery ? { delivery: true } : {}), ...(l.shop ? { shop: true, variantId: l.variantId, inventoryItemId: l.inventoryItemId || '' } : {}), ...(l.backorder ? { backorder: true } : {}) };
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
    saleNo, events: [{ at: now, by: who, what: 'Raised at the till (' + saleNo + ')' }],
    ...(delivery ? { deliveryAddress: delivery.deliveryAddress, deliveryInstructions: delivery.note || '' } : {})
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
    ...(kind === 'layby' ? { status: 'layby' } : {}), ...(extra.backorder ? { backorder: true, expectedDate: extra.expectedDate || '' } : {}),
    ...(lines.some(l => l.shop) && kind !== 'layby' ? { shopifySale: true } : {}) };
  const saleId = await store.create('sales', sale);

  if (r2(t.total - amount) <= 0.005) sendToXero(saleId);
  // pieces from the shelf also come off the online shop's count: a sale of the
  // shop's stock becomes a Shopify order (a layby's only when it is collected)
  if (kind !== 'layby') {
    store.shopifyPushSale(saleId, lines);
    if (lines.some(l => l.shop)) { till.takeFromShop(lines); setTimeout(() => till.refreshCatalogue(true), 4000); }
  }

  const made = lines.filter(l => l.kind === 'order').length;
  cart = emptyCart(); mCart = false; persist();
  toast(saleNo + (extra.backorder ? ' sales order opened' : kind === 'layby' ? ' layby opened' : kind === 'account' ? ' on account' : ' complete') + (made ? ' · ' + made + ' order' + (made === 1 ? '' : 's') + ' sent to the factory' : '') + (pts.earned ? ' · ' + pts.earned + ' points earned' : ''));
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
      <button type="button" class="btn primary" data-slip="print">Print slip</button>
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
  const left = r2(Math.max(0, (Number(s.total) || 0) - paidNow));
  await store.update('sales', s.id, { paidNow, balance: left, payments: [...(s.payments || []), ...pays.map(p => ({ ...p, at: now, by: who }))] });
  // an account sale settled: the shop's order is marked paid too; a sale paid in full goes to Xero
  if (left <= 0.005 && s.kind === 'account' && s.shopifySale) store.shopifyMarkPaid(s.id);
  if (left <= 0.005) sendToXero(s.id);
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
function accountPayment(forId) {
  const cur = settings.currency || 'R';
  const owing = {}; sales.forEach(s => { if (s.customerId && Number(s.balance) > 0.005) owing[s.customerId] = r2((owing[s.customerId] || 0) + Number(s.balance)); });
  const custs = allCustomers().filter(c => owing[c.id]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!custs.length) { toast('Nobody owes anything on the till', 'warn'); return; }
  const m = openModal('Account payment', `
    ${field('Customer', 'ap-cust', { type: 'select', value: forId && owing[forId] ? forId : custs[0].id, options: custs.map(c => ({ value: c.id, label: c.name + ' — owes ' + money(owing[c.id], cur) })) })}
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
  h.innerHTML = headHtml() + (posTab === 'sale' ? saleHtml(cur) : posTab === 'register' ? till.registerHtml(sales) : posTab === 'stock' ? '<div id="ss-host"></div>' : posTab === 'dash' ? shopstock.dashboardHtml(sales) : posTab === 'clients' ? clientsHtml(cur) : posTab === 'orders' ? ordersHtml(cur) : salesHtml(cur));
  if (posTab === 'stock') shopstock.renderShopStock(h.querySelector('#ss-host'), sales);
  if (posTab === 'sale') {
    const s = h.querySelector('#pos-search');
    if (s) {
      s.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(s); } });
      if (search) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
  }
  if (posTab === 'clients') { const q = h.querySelector('#cl-q'); if (q && clientQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

// The top of the till, laid out like the old shop till: who we are, how the
// shop is doing, and one button for each part of the day's work.
function headHtml() {
  const me = till.tillUser();
  const n = tiles().length;
  const stockView = shopstock.currentView();
  const on = (key) => posTab === key || (posTab === 'stock' && ({ receive: 'receive', count: 'take', catalogue: 'catalogue', po: 'order' })[key] === stockView);
  const nav = (key, ico, label, title) => `<button class="pos-nav-btn${on(key) ? ' on' : ''}" data-act="pos-tab" data-to="${key}" title="${esc(title || '')}">${icon(ico)}<span>${label}</span></button>`;
  const pend = store.shopifyPendingCount();
  const pill = (dot, text, title, cls = '') => `<span class="pos-pill${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}>${dot ? `<i class="pos-dot ${dot}"></i>` : ''}${text}</span>`;
  return `<div class="pos-head">
    <div class="pos-head-top">
      <div class="pos-brand"><span class="pos-brand-name">${esc(settings.name || 'Shop')}</span><span class="pos-brand-tag">Point of sale</span></div>
      <div class="pos-status">
        ${pill(online ? 'ok' : 'bad', online ? 'Online' : 'Offline')}
        ${till.shopOn() ? pill('', icon('shop') + esc(till.shopName() || 'Online shop'), 'The online shop') : ''}
        ${pill('', n + ' product' + (n === 1 ? '' : 's') + (till.catalogueLoading() ? ' · reading the shop…' : till.catalogueAt() && till.shopOn() ? ' · stock at ' + esc(new Date(till.catalogueAt()).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })) : ''))}
        ${till.openShift() ? pill('ok', 'Register open') : pill('warn', 'Register closed', 'Open it under Register for the day’s cash-up')}
        ${pend ? pill('bad', pend + ' sale' + (pend === 1 ? '' : 's') + ' still to reach the shop') : ''}
        ${till.catalogueError() ? pill('bad', esc(till.catalogueError()), 'The shop could not be read', 'msg') : ''}
      </div>
      <div class="pos-user">
        ${till.shopOn() ? `<button class="pos-icon-btn" data-act="till-refresh" title="Read the shop’s stock again">${icon('refresh')}</button>` : ''}
        ${me ? `<span class="pos-staff" title="Who is ringing">${icon('user')}${esc(me.name)}${till.isManager(me) ? ' <small>manager</small>' : ''}</span><button class="pos-icon-btn" data-act="till-lock" title="Lock the till">${icon('lock')}</button>` : ''}
      </div>
    </div>
    <nav class="pos-nav">
      ${nav('sale', 'cart', 'Sell', 'Ring up a sale')}
      ${nav('dash', 'chart', 'Dashboard', 'How the shop is doing')}
      ${nav('clients', 'users', 'Clients', 'Customers, accounts and laybys')}
      ${nav('orders', 'list', 'Orders', 'Sales orders, laybys and quotes')}
      ${till.shopOn() ? nav('receive', 'inbox', 'Receive', 'Book in a delivery (GRV)') + nav('count', 'box', 'Count', 'Stock take') + nav('catalogue', 'grid', 'Catalogue', 'Products, prices and cost prices') + nav('po', 'file', 'PO Order', 'Purchase orders and what to order') : ''}
      ${nav('sales', 'receipt', 'Sales', 'Sales history')}
      ${nav('refund', 'undo', 'Refund', 'A return or refund')}
      ${nav('register', 'till', 'Register', 'Open, cash up and close the till')}
    </nav>
  </div>`;
}

// What the tiles show: the shop's products when it is connected (factory
// products already in the shop are not shown twice), plus the factory's own
// products, made to order.
function tiles() {
  const shopOn = till.shopOn();
  const out = till.shopItems().map(i => ({ id: 'v:' + i.variantId, name: i.name, category: i.category || 'Shop', cats: (i.collections && i.collections.length ? i.collections : [i.category || 'Shop']), price: i.price, image: i.image, sku: i.sku, barcode: i.barcode,
    stock: i.tracked ? 'stock' : 'untracked', qty: i.qty, tracked: i.tracked, shop: true }));
  allProducts().forEach(p => {
    if (shopOn && p.shopifyVariantId) return;
    out.push({ id: p.id, name: p.name, category: p.category || 'Other', cats: [p.category || (shopOn ? 'Made to order' : 'Other')], price: Number(p.sellingPrice) || 0, image: p.imageUrl, barcode: p.barcode, stock: Number(p.stock) > 0 ? 'stock' : 'order', qty: Number(p.stock) || 0 });
  });
  return out;
}
const matchesTile = (t, q) => !q || [t.name, t.sku, t.barcode].some(v => String(v || '').toLowerCase().includes(q));
const keyOf = (t) => t.shop ? t.id.slice(2) : 'p-' + t.id;
// Categories mirror the online shop: a product's collections (it can sit in
// several), else its product type.
const catList = (prods) => [...new Set(prods.flatMap(p => p.cats))].sort((a, b) => a.localeCompare(b));
const outOf = (p) => p.stock === 'stock' && p.tracked && !(p.qty > 0);
const stockText = (p) => p.stock === 'order' ? 'made to order' : p.stock === 'untracked' ? (p.shop ? 'in the shop' : '') : p.qty > 0 ? 'stock ' + p.qty : 'out of stock · sales order';
// no picture: the product's initials on a quiet panel
const initials = (name) => String(name || '?').split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const thumb = (p) => productImg({ imageUrl: p.image }, 'pos-tile-img', 400) || `<span class="pos-tile-img none">${esc(initials(p.name))}</span>`;
function tileHtml(p, cur, star) {
  const starred = shopstock.isQuickKey(keyOf(p));
  return `<button class="pos-tile${outOf(p) ? ' out' : ''}${starred ? ' starred' : ''}" data-act="pos-add" data-id="${esc(p.id)}" data-key="${esc(keyOf(p))}" data-name="${esc(p.name)}" title="${outOf(p) ? 'Out of stock: tap to sell as a sales order' : ''}">
    ${star ? `<span class="pos-star${starred ? ' on' : ''}">${icon('star')}</span>` : ''}
    ${thumb(p)}
    <span class="pos-tile-name">${esc(p.name)}</span>
    <span class="pos-tile-price">${esc(money(p.price || 0, cur))}</span>
    <span class="pos-tile-stock">${stockText(p)}</span>
  </button>`;
}
// A till with nothing to sell yet: say where products come from.
function noProductsHtml() {
  const owner = (store.getUser() || {}).role === 'owner';
  return `<div class="pos-empty">
    <div class="pos-empty-ico">${icon('box')}</div>
    <h3>No products on the till yet</h3>
    <p>The till sells the products set up under Costing, and the products in your online shop once it is connected. A one-off item can be rung up with Custom item.</p>
    <div class="btn-row">
      ${store.can('costing') ? '<button class="btn primary" data-act="today-do" data-do="go" data-to="costing">Add products</button>' : ''}
      ${owner ? '<button class="btn ghost" data-act="today-do" data-do="go" data-to="settings">Connect the online shop</button>' : ''}
      <button class="btn ghost" data-act="pos-custom">Custom item</button>
    </div>
  </div>`;
}
function saleHtml(cur) {
  const prods = tiles();
  const cats = catList(prods);
  const q = search.trim().toLowerCase();
  const c = customerById(cart.customerId);
  const t = totals();
  const chip = (label, val) => `<button class="cat-chip${cat === val ? ' on' : ''}" data-act="pos-cat" data-to="${esc(val)}">${esc(label)}</button>`;
  const quick = prods.filter(p => shopstock.isQuickKey(keyOf(p)));
  const strip = quick.length ? `<div class="pos-quick"><div class="pos-grid-cat">${icon('star')} Quick keys</div>${quick.map(p => tileHtml(p, cur, false)).join('')}<div class="pos-grid-rule"></div></div>` : '';
  let grid;
  if (quickEdit) {
    grid = `<div class="pos-grid-cat warn">Quick keys: tap the star on a product to pin it, then the star button above when you are done</div>` + prods.filter(p => matchesTile(p, q)).slice(0, 300).map(p => tileHtml(p, cur, true)).join('');
  } else if (cat === '__home__' && !q && cats.length) {
    // the landing: one picture tile per category, like the online shop
    grid = strip + cats.map(x => {
      const inCat = prods.filter(p => p.cats.includes(x));
      const withImg = inCat.find(p => p.image);
      return `<button class="pos-tile cat-tile" data-act="pos-cat" data-to="${esc(x)}">${withImg ? thumb(withImg) : `<span class="pos-tile-img none">${icon('tag')}</span>`}<span class="pos-tile-name">${esc(x)}</span><span class="pos-tile-stock">${inCat.length} item${inCat.length === 1 ? '' : 's'}</span></button>`;
    }).join('');
  } else {
    const shown = prods.filter(p => q ? matchesTile(p, q) : (!cat || cat === '__home__' || p.cats.includes(cat)));
    grid = (!q && (!cat || cat === '__home__') ? strip : '') + (shown.length ? shown.slice(0, 300).map(p => tileHtml(p, cur, false)).join('')
      : prods.length || till.shopOn() ? `<div class="pos-grid-empty">${prods.length ? 'No matches' + (cat && cat !== '__home__' && !q ? ' in ' + esc(cat) : '') : 'Reading the shop’s products…'}</div>`
      : noProductsHtml());
  }
  return `<div class="pos${mCart ? ' m-cart' : ''}">
    <div class="pos-left">
      <div class="pos-scan-row">
        <label class="pos-search-wrap">${icon('search')}<input id="pos-search" class="pos-in" placeholder="Scan a barcode or search by name or SKU" value="${esc(search)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <button class="pos-sq" data-act="pos-scan" title="Scan a barcode with the camera">${icon('camera')}</button>
        <button class="pos-sq${quickEdit ? ' on' : ''}" data-act="pos-quick-edit" title="Edit quick keys (pin favourites)">${icon('star')}</button>
      </div>
      ${cats.length ? `<div class="cat-bar">${chip('Categories', '__home__')}${chip('All', '')}${cats.map(x => chip(x, x)).join('')}</div>` : ''}
      <div class="pos-grid">${grid}</div>
    </div>
    <div class="pos-right">
      <div class="card pos-cart">
        <div class="pos-cart-title"><span>Current sale</span>${cart.lines.length ? '<button class="pos-link" data-act="pos-clear">Clear</button>' : ''}</div>
        <button class="pos-cust${c ? ' set' : ''}" data-act="pos-customer"><span class="pos-cust-ico">${icon('user')}</span><span class="pos-cust-txt">${c ? `<strong>${esc(c.name)}</strong><span>${esc([c.phone, c.area].filter(Boolean).join(' · ') || 'tap to change')}</span>${Number(c.points) > 0 || Number(c.storeCredit) > 0 ? `<span>${Number(c.points) > 0 ? esc(Math.round(Number(c.points))) + ' points' : ''}${Number(c.points) > 0 && Number(c.storeCredit) > 0 ? ' · ' : ''}${Number(c.storeCredit) > 0 ? 'store credit ' + esc(money(c.storeCredit, cur)) : ''}</span>` : ''}` : '<strong>Add a customer</strong><span>Needed for made to order, layby and on account</span>'}</span></button>
        <div class="pos-lines">${cart.lines.length ? cart.lines.map((l, i) => `
          <div class="pos-line">
            <div class="pos-line-top">
              <strong>${esc(l.name)}</strong>
              <button class="pos-icon-btn light" data-act="pos-remove" data-i="${i}" title="Remove">${icon('x')}</button>
            </div>
            <div class="pos-line-ctl">
              <span class="qty"><button class="btn ghost sm" data-act="pos-qty" data-i="${i}" data-d="-1">−</button><b>${esc(l.qty)}</b><button class="btn ghost sm" data-act="pos-qty" data-i="${i}" data-d="1">+</button></span>
              <input class="pos-in" data-field="unitPrice" data-i="${i}" type="number" min="0" step="0.01" value="${esc(l.unitPrice)}" title="Price each"${l.shop ? ' readonly' : ''}>
              <strong class="pos-line-tot">${esc(money(lineTotal(l), cur))}</strong>
            </div>
            <div class="pos-line-disc"><button class="btn ghost sm" data-act="pos-line-disc" data-i="${i}" title="Discount on this line">${l.disc ? '− ' + esc(money(l.disc, cur)) + ' off' : '% off'}</button>${l.backorder ? '<span class="chip late" title="Not in stock: sold as a sales order">sales order</span>' : l.shop && l.tracked ? `<span class="muted">${esc(l.stockQty)} in the shop</span>` : ''}</div>
            ${l.custom || l.shop ? '' : `<div class="pos-kind">
              <button class="${l.kind === 'order' ? 'on' : ''}" data-act="pos-kind" data-i="${i}" data-to="order">Made to order</button>
              <button class="${l.kind === 'stock' ? 'on' : ''}" data-act="pos-kind" data-i="${i}" data-to="stock">From stock</button>
            </div>
            ${l.kind === 'order' ? `<input class="pos-in" data-field="fabric" data-i="${i}" value="${esc(l.fabric)}" placeholder="Fabric / colour" list="fabric-list">` : ''}`}
            <input class="pos-in" data-field="note" data-i="${i}" value="${esc(l.note)}" placeholder="Note (optional)">
          </div>`).join('') : `<div class="pos-cart-empty">${icon('cart')}<span>No items yet</span><small>Scan a barcode or tap a product</small></div>`}
        </div>
        <div class="pos-totals">
          <div><span>Items (${t.pieces})</span><strong>${esc(money(t.subtotalRaw, cur))}</strong></div>
          ${t.lineDiscs ? `<div><span>Line discounts</span><strong>− ${esc(money(t.lineDiscs, cur))}</strong></div>` : ''}
          <div><span>Discount on the sale</span><button class="btn ghost sm" data-act="pos-cart-disc">${t.cartDisc ? '− ' + esc(money(t.cartDisc, cur)) + (cart.discountPct ? ' (' + esc(cart.discountPct) + '%)' : '') : 'none'}</button></div>
          ${vatRate() ? `<div class="muted"><span>Includes VAT ${Math.round(vatRate() * 100)}%</span><strong>${esc(money(t.vat, cur))}</strong></div>` : ''}
          <div class="tot"><span>Total</span><strong>${esc(money(t.total, cur))}</strong></div>
        </div>
        <button class="btn primary pos-charge" data-act="pos-charge"${t.pieces ? '' : ' disabled'}><span>Pay</span><span>${esc(money(t.total, cur))}</span></button>
        <div class="pos-extra">
          <button data-act="pos-salesorder" title="Order an item that is not in stock: paid on a layby, collected when it arrives">${icon('list')}Sales order</button>
          <button data-act="pos-quote" title="Save this cart as a quote for the customer">${icon('quote')}Quote</button>
          <button data-act="pos-giftcard" title="Sell a gift card">${icon('gift')}Gift card</button>
          <button data-act="pos-custom" title="One-off item: a description and a price">${icon('plus')}Custom item</button>
          <button data-act="pos-delivery" title="Add a delivery fee and where it goes">${icon('truck')}Delivery</button>
        </div>
      </div>
    </div>
    <div class="pos-mbar"><button class="${mCart ? '' : 'on'}" data-act="pos-mview" data-to="shop">${icon('search')} Shop</button><button class="${mCart ? 'on' : ''}" data-act="pos-mview" data-to="cart">${icon('cart')} Cart${t.pieces ? ' (' + t.pieces + ')' : ''}<b>${esc(money(t.total, cur))}</b></button></div>
  </div>`;
}

// ---------------------------------------------------------------- clients ---

// Who owes what: a customer's open laybys, sales orders and account sales.
function clientFigures(c) {
  const mine = sales.filter(s => s.customerId === c.id);
  const open = mine.filter(s => (s.kind === 'layby' && !s.collectedAt) || (s.kind === 'account' && Number(s.balance) > 0.005));
  return { owing: r2(open.reduce((t, s) => t + Math.max(0, Number(s.balance) || 0), 0)), deposits: r2(open.filter(s => s.kind === 'layby').reduce((t, s) => t + (Number(s.paidNow) || 0), 0)), open: open.length, sales: mine.length, points: Math.round(Number(c.points) || 0), credit: r2(Number(c.storeCredit) || 0) };
}
function clientsHtml(cur) {
  const q = clientQ.trim().toLowerCase();
  const rowsAll = allCustomers().map(c => ({ c, f: clientFigures(c) }));
  const rows = q ? rowsAll.filter(({ c }) => [c.name, c.phone, c.email].some(v => String(v || '').toLowerCase().replace(/\s/g, '').includes(q.replace(/\s/g, '')))).slice(0, 60)
    : rowsAll.filter(({ f }) => f.owing > 0 || f.deposits > 0 || f.credit > 0 || f.points > 0).sort((a, b) => b.f.owing - a.f.owing || b.f.deposits - a.f.deposits);
  const right = (f) => f.owing ? `<div class="muted">owing</div><strong class="late-ink">${esc(money(f.owing, cur))}</strong>` : f.deposits ? `<div class="muted">deposit</div><strong>${esc(money(f.deposits, cur))}</strong>` : f.credit ? `<div class="muted">store credit</div><strong>${esc(money(f.credit, cur))}</strong>` : f.points ? `<div class="muted">points</div><strong>${f.points}</strong>` : '<span class="muted">view ›</span>';
  return `<div class="card">
    <div class="toolbar" style="margin-bottom:.6rem"><input id="cl-q" class="search pos-in" placeholder="Search clients by name, phone or email" value="${esc(clientQ)}" autocomplete="off"><button class="btn ghost" data-act="pos-client-new">＋ New client</button></div>
    <div class="cat">${q ? 'Matches' : 'Accounts with balances, deposits, credit or points'}</div>
    <div class="pk-list" style="max-height:none">${rows.length ? rows.map(({ c, f }) => `<button type="button" class="pk-row pos-client" data-act="pos-client" data-id="${esc(c.id)}"><div><strong>${esc(c.name)}</strong><span>${esc([c.phone, c.email].filter(Boolean).join(' · '))}${f.open ? ' · ' + f.open + ' open' : ''}${f.sales ? ' · ' + f.sales + ' sale(s)' : ''}</span></div><div class="r">${right(f)}</div></button>`).join('') : `<div class="muted" style="padding:.8rem">${q ? 'No matches — tap ＋ New client to add them.' : 'No outstanding accounts — search above to find any client.'}</div>`}</div>
  </div>`;
}
function openClient(id) {
  const c = customerById(id); if (!c) return;
  const cur = settings.currency || 'R';
  const f = clientFigures(c);
  const mine = sales.filter(s => s.customerId === id).slice(0, 30);
  const m = openModal(c.name, `
    <p class="muted">${esc([c.phone, c.email, c.area].filter(Boolean).join(' · ') || 'No phone or email on file')}</p>
    <div class="tiles" style="margin:.4rem 0 .8rem">
      <div class="tile"><div class="tile-n">${esc(money(f.owing, cur))}</div><div class="tile-l">Owing</div></div>
      <div class="tile"><div class="tile-n">${esc(money(f.deposits, cur))}</div><div class="tile-l">Deposits held</div></div>
      <div class="tile"><div class="tile-n">${esc(money(f.credit, cur))}</div><div class="tile-l">Store credit</div></div>
      <div class="tile"><div class="tile-n">${f.points}</div><div class="tile-l">Points (${esc(money(f.points, cur))})</div></div>
    </div>
    <div class="btn-row" style="margin-bottom:.8rem">
      <button class="btn primary" data-pick="use">Use in this sale</button>
      ${f.owing > 0 ? '<button class="btn ghost" data-pick="pay">Account payment</button>' : ''}
      ${c.phone ? `<a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/${esc(String(c.phone).replace(/\D/g, '').replace(/^0/, '27'))}">WhatsApp</a>` : ''}
    </div>
    ${mine.length ? `<div class="cat">Sales</div><div class="pk-list" style="max-height:34vh">${mine.map(s => `<div class="pk-row" style="cursor:default"><div><strong>${esc(s.saleNo)}</strong> <span>${esc(niceDate(s.date))} · ${esc((s.lines || []).map(l => l.qty + '× ' + l.name).join(', ')).slice(0, 80)}</span></div><div class="r"><strong>${esc(money(s.total, cur))}</strong>${Number(s.balance) > 0.005 ? '<span class="chip late">owes ' + esc(money(s.balance, cur)) + '</span>' : s.kind === 'layby' && !s.collectedAt ? '<span class="chip calm">to collect</span>' : ''}</div></div>`).join('')}</div>` : '<p class="muted">No sales yet.</p>'}`, { okLabel: 'Close', onOk: () => {} });
  m.wrap.querySelector('.modal-card').classList.add('wide');
  m.wrap.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { m.close(); if (b.dataset.pick === 'use') { cart.customerId = id; persist(); posTab = 'sale'; rerender(); } else accountPayment(id); }));
}

// ----------------------------------------------------------------- orders ---

function ordersHtml(cur) {
  const tab = (key, label) => `<button class="btn ${ordersTab === key ? 'primary' : 'ghost'} sm" data-act="pos-orders-tab" data-to="${key}">${label}</button>`;
  let body;
  if (ordersTab === 'quotes') {
    const qs = allQuotes().filter(x => x.status !== 'cancelled').slice(0, 100);
    body = qs.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl"><thead><tr><th>Quote</th><th>Customer</th><th>Date</th><th>Lines</th><th class="r">Total</th><th>Status</th><th></th></tr></thead><tbody>${qs.map(x => `<tr>
        <td><strong>${esc(x.quoteNo || '')}</strong></td><td>${esc(x.customerName || (x.prospect && x.prospect.name) || '')}</td><td>${esc(niceDate(String(x.createdAt || '').slice(0, 10)))}</td>
        <td>${(x.lines || []).map(l => esc(l.qty + '× ' + (l.description || l.name || ''))).join('<br>')}</td><td class="r">${esc(money(quoteTotals(x).total, cur))}</td><td><span class="chip calm">${esc(x.status || 'draft')}</span></td>
        <td class="r nowrap"><button class="btn primary sm" data-act="pos-quote-cart" data-id="${esc(x.id)}">To cart</button></td></tr>`).join('')}</tbody></table></div>` : empty('', 'No quotes', 'Tap 📝 Quote on a sale to save one.');
  } else {
    const open = sales.filter(s => (s.kind === 'layby' && !s.collectedAt) || (s.kind === 'account' && Number(s.balance) > 0.005));
    body = open.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl"><thead><tr><th>Sale</th><th>Customer</th><th>Date</th><th>Items</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th></th></tr></thead><tbody>${open.map(s => `<tr>
        <td><strong>${esc(s.saleNo)}</strong><div>${s.kind === 'layby' ? '<span class="chip late">' + (s.backorder ? 'sales order' + (s.expectedDate ? ' · expected ' + esc(niceDate(s.expectedDate)) : '') : 'layby') + '</span>' : '<span class="chip late">on account</span>'}</div></td>
        <td>${esc(s.customerName || '')}</td><td>${esc(niceDate(s.date))}</td><td>${(s.lines || []).map(l => esc(l.qty + '× ' + l.name)).join('<br>')}</td>
        <td class="r">${esc(money(s.total, cur))}</td><td class="r">${esc(money(s.paidNow, cur))}</td><td class="r">${Number(s.balance) > 0.005 ? '<strong>' + esc(money(s.balance, cur)) + '</strong>' : '—'}</td>
        <td class="r nowrap">${Number(s.balance) > 0.005 ? `<button class="btn primary sm" data-act="pos-pay" data-id="${esc(s.id)}">Pay</button> ` : ''}${s.kind === 'layby' && !(Number(s.balance) > 0.005) ? `<button class="btn primary sm" data-act="pos-collect" data-id="${esc(s.id)}">Collect</button> ` : ''}<button class="btn ghost sm" data-act="pos-slip" data-id="${esc(s.id)}">Slip</button> <button class="btn ghost sm" data-act="pos-share" data-id="${esc(s.id)}" data-how="wa">WA</button></td></tr>`).join('')}</tbody></table></div>` : empty('', 'Nothing open', 'Laybys, sales orders and account sales that are still owing or waiting to be collected show here.');
  }
  return `<div class="btn-row" style="margin-bottom:.8rem">${tab('orders', 'Sales orders & laybys')}${tab('quotes', 'Quotes')}<span style="flex:1"></span><button class="btn ghost sm" data-act="pos-account">Account payment</button></div>` + body;
}
// A quote's lines onto the cart: shop products by name, factory products by id, the rest as custom lines.
function quoteToCart(id) {
  const x = allQuotes().find(q => q.id === id); if (!x) return;
  if (cart.lines.length && !confirm('Replace what is on the sale with this quote?')) return;
  cart = emptyCart(); mCart = false; cart.customerId = x.customerId || '';
  (x.lines || []).forEach(l => {
    const name = l.description || l.name || 'Item', qty = Math.max(1, parseInt(l.qty, 10) || 1), price = r2(Number(l.unitPrice) || 0);
    const it = till.shopItems().find(i => String(i.name).toLowerCase() === String(name).toLowerCase());
    if (it) cart.lines.push({ productId: '', variantId: it.variantId, inventoryItemId: it.inventoryItemId, name: it.name, qty, unitPrice: Number(it.price) || price, kind: 'stock', fabric: '', note: '', disc: 0, tracked: !!it.tracked, stockQty: Number(it.qty) || 0, shop: true, backorder: !!it.tracked && qty > (Number(it.qty) || 0) });
    else if (l.productId && allProducts().some(p => p.id === l.productId)) { const p = allProducts().find(p => p.id === l.productId); cart.lines.push({ productId: p.id, name: p.name, qty, unitPrice: price || Number(p.sellingPrice) || 0, kind: Number(p.stock) > 0 ? 'stock' : 'order', fabric: l.fabric || '', note: '', disc: 0 }); }
    else cart.lines.push({ productId: '', name, qty, unitPrice: price, kind: 'stock', fabric: '', note: '', disc: 0, custom: true });
  });
  if (Number(x.discount)) cart.discount = r2(Number(x.discount));
  persist(); posTab = 'sale'; mCart = true; rerender(); toast(x.quoteNo + ' on the sale');
}
// The cart as a quote for the customer (drawn up under Quotes).
async function saveCartAsQuote() {
  if (!cart.lines.length) { toast('Nothing on the sale yet', 'warn'); return; }
  if (!store.can('quotes')) { toast('Quotes are not switched on for you', 'warn'); return; }
  const c = customerById(cart.customerId);
  if (!c) { toast('A quote needs a customer — tap Customer first', 'warn'); return; }
  const lines = cart.lines.filter(l => l.kind !== 'giftcard').map(l => ({ productId: l.productId || '', description: l.name, fabric: l.fabric || '', qty: Number(l.qty) || 1, unitPrice: r2((Number(l.unitPrice) || 0) - (Number(l.disc) || 0) / (Number(l.qty) || 1)) }));
  const t = totals();
  const n = await store.nextNumber('quoteNo', 1);
  const quoteNo = (settings.quotePrefix || 'Q-') + String(n).padStart(4, '0');
  await store.create('quotes', { customerId: c.id, customerName: c.name, prospect: null, lines, discount: r2(t.cartDisc || 0), validUntil: addDays(today(), 14), notes: cart.note || '', quoteNo, status: 'draft', events: [{ at: store.nowIso(), by: (till.tillUser() || {}).name || store.getUser().name, what: 'Quote drawn up at the till' }] });
  toast(quoteNo + ' saved — under Orders → Quotes, and under Quotes to send');
}
// An item not in stock, straight onto the sale as a sales order line.
function openSalesOrderPick() {
  const items = till.shopItems();
  if (!items.length) { toast(till.shopOn() ? 'The shop’s products are still being read' : 'Sales orders are for the online shop’s products: connect the shop first', 'warn'); return; }
  const m = openModal('Sales order', `<p class="muted">An item the shop does not have on the shelf: it is ordered in for the customer, paid on a layby and collected when it arrives.</p>
    <input id="so-q" class="pos-in" placeholder="Search the shop’s products…" style="width:100%; margin-bottom:.5rem" autocomplete="off"><div id="so-list" class="pk-list" style="max-height:40vh"></div>`, { okLabel: 'Close', onOk: () => {} });
  const q = m.wrap.querySelector('#so-q'), list = m.wrap.querySelector('#so-list');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = items.filter(i => !t || [i.name, i.sku, i.barcode].some(v => String(v || '').toLowerCase().includes(t))).slice(0, 40);
    list.innerHTML = rows.map(i => `<button type="button" class="pk-row" data-v="${esc(i.variantId)}"><strong>${esc(i.name)}</strong><span>${esc(money(i.price, settings.currency || 'R'))} · ${i.tracked ? (i.qty > 0 ? 'stock ' + i.qty : 'out of stock') : 'in the shop'}</span></button>`).join('') || '<div class="muted" style="padding:.4rem">No match</div>';
    list.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { addBackorder(b.dataset.v); m.close(); rerender(); }));
  };
  q.addEventListener('input', draw); draw(); setTimeout(() => q.focus(), 60);
}
function addBackorder(variantId) {
  const it = till.shopItem(variantId); if (!it) return;
  const existing = cart.lines.find(l => l.variantId === it.variantId);
  if (existing) { existing.backorder = true; existing.qty += 1; }
  else cart.lines.push({ productId: '', variantId: it.variantId, inventoryItemId: it.inventoryItemId, name: it.name, qty: 1, unitPrice: Number(it.price) || 0, kind: 'stock', fabric: '', note: '', disc: 0, tracked: !!it.tracked, stockQty: Number(it.qty) || 0, shop: true, backorder: true });
  persist(); toast(it.name + ': sales order line');
}

// ----------------------------------------------------------------- refund ---

// Find the sale that is coming back: by sale number, invoice or shop order, or
// one of the recent sales.
function openRefundLookup() {
  const cur = settings.currency || 'R';
  const recent = sales.filter(s => (s.lines || []).some((l, i) => returnedQty(s, i) < (Number(l.qty) || 0))).slice(0, 8);
  const m = openModal('Refund / return', `
    <input id="rf-q" class="pos-in" placeholder="Sale no., invoice no. or shop order (e.g. S-0012, INV-0012, #1001)" style="width:100%" autocomplete="off">
    <div class="btn-row" style="margin:.6rem 0"><button class="btn primary" id="rf-find">Find the sale</button></div>
    ${recent.length ? `<div class="cat">Recent sales — tap to return</div><div class="pk-list" style="max-height:40vh">${recent.map(s => `<button type="button" class="pk-row" data-s="${esc(s.id)}"><strong>${esc(s.saleNo)}${s.shopifyOrderName ? ' · ' + esc(s.shopifyOrderName) : ''}</strong><span>${esc(niceDate(s.date))}${s.time ? ' ' + esc(s.time) : ''} · ${esc(s.customerName || '')} · ${esc(money(s.total, cur))}</span></button>`).join('')}</div>` : '<p class="muted">No sales to return yet.</p>'}`, { okLabel: 'Close', onOk: () => {} });
  const q = m.wrap.querySelector('#rf-q');
  const find = () => {
    const v = q.value.trim().toLowerCase().replace(/^#/, '');
    if (!v) return;
    const s = sales.find(x => [x.saleNo, x.invoiceNo, x.shopifyOrderName, x.shopifyOrderId].some(k => String(k || '').toLowerCase().replace(/^#/, '') === v));
    if (!s) { toast('No sale ' + q.value.trim() + ' on this till', 'warn'); return; }
    m.close(); openReturn(s.id);
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  m.wrap.querySelector('#rf-find').addEventListener('click', find);
  m.wrap.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { m.close(); openReturn(b.dataset.s); }));
  setTimeout(() => q.focus(), 60);
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
        <td><strong>${esc(s.saleNo)}</strong>${s.kind === 'layby' ? ' <span class="chip ' + (s.collectedAt ? 'calm' : 'late') + '">' + (s.collectedAt ? (s.backorder ? 'sales order collected' : 'layby collected') : (s.backorder ? 'sales order' + (s.expectedDate ? ' · expected ' + niceDate(s.expectedDate) : '') : 'layby')) + '</span>' : s.kind === 'account' ? ' <span class="chip ' + (Number(s.balance) > 0.005 ? 'late' : 'calm') + '">on account</span>' : ''}<div class="muted">${esc(s.by || '')}</div></td><td>${esc(niceDate(s.date))}</td><td>${esc(s.customerName || '')}</td>
        <td>${(s.lines || []).map(l => esc(l.qty + '× ' + l.name) + (l.kind === 'order' ? ' <span class="chip st-prod">' + esc(l.orderNo || 'order') + '</span>' : ' <span class="chip calm">' + (l.shop ? 'shop' : 'stock') + '</span>')).join('<br>')}${s.shopifyOrderName ? '<div class="muted">Shop order ' + esc(s.shopifyOrderName) + '</div>' : s.shopifySale ? '<div class="muted">to the shop…</div>' : ''}
          ${(s.returns || []).map(r => `<div class="muted" style="margin-top:3px">↩ ${esc(r.returnNo)} ${esc(niceDate(r.date))}: ${esc((r.lines || []).map(x => x.qty + '× ' + x.name).join(', '))}${Number(r.refund) ? ' · refunded ' + esc(money(r.refund, cur)) : ''}${r.creditId ? ` <button class="btn ghost sm" data-act="pos-reprint" data-id="${esc(r.creditId)}">${esc(r.creditNo || 'Credit note')}</button>` : ''}</div>`).join('')}</td>
        <td class="r">${esc(money(s.total, cur))}</td><td class="r">${esc(money(s.paidNow, cur))}${s.method ? '<div class="muted">' + esc(s.method) + '</div>' : ''}</td>
        <td class="r">${Number(s.balance) > 0 ? '<strong>' + esc(money(s.balance, cur)) + '</strong>' : '—'}</td>
        <td>${esc(s.invoiceNo || '')}${s.xeroInvoiceNumber ? '<div class="muted">Xero ' + esc(s.xeroInvoiceNumber) + '</div>' : ''}</td>
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
    case 'pos-tab': case 'pos-go': return goTab(el.dataset.to);
    case 'pos-cat': cat = el.dataset.to; search = ''; return rerender();
    case 'pos-mview': mCart = el.dataset.to === 'cart'; return rerender();
    case 'pos-client': return openClient(el.dataset.id);
    case 'pos-client-new': return pickCustomer();
    case 'pos-orders-tab': ordersTab = el.dataset.to; return rerender();
    case 'pos-quote-cart': return quoteToCart(el.dataset.id);
    case 'pos-quote': return saveCartAsQuote();
    case 'pos-salesorder': return openSalesOrderPick();
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
      if (l.shop && l.tracked && !l.backorder) { const it = till.shopItem(l.variantId); const have = it ? Number(it.qty) || 0 : l.stockQty; if (q > have) { if (!confirm('Only ' + have + ' in stock. Make this line a sales order (ordered in, collected when it arrives)?')) return; l.backorder = true; } }
      l.qty = q; persist(); return rerender(); }
    case 'pos-remove': cart.lines.splice(i, 1); persist(); return rerender();
    case 'pos-kind': { const l = cart.lines[i]; if (!l) return; l.kind = el.dataset.to; persist(); return rerender(); }
    case 'pos-customer': return pickCustomer();
    case 'pos-clear': if (!cart.lines.length || confirm('Clear this sale?')) { cart = emptyCart(); mCart = false; persist(); rerender(); } return;
    case 'pos-charge': return checkout();
    case 'pos-reprint': return printInvoice(el.dataset.id);
    case 'pos-scan': return openBarcodeCamera(addByCode);
    case 'pos-return': return openReturn(el.dataset.id);
  }
}
// Where a button at the top goes: a screen of the till, a page of the stock
// room, or the refund box.
function goTab(to) {
  const stockViews = { receive: 'receive', count: 'take', catalogue: 'catalogue', po: 'order' };
  if (to === 'refund') return openRefundLookup();
  if (stockViews[to]) { posTab = 'stock'; shopstock.setView(stockViews[to]); return rerender(); }
  posTab = to; rerender();
}
export function posInput(el) {
  if (!el.isConnected) return;          // a late keystroke from a box that was redrawn (e.g. after a scan)
  if (el.id === 'pos-search') { search = el.value; return rerender(); }
  if (el.id === 'cl-q') { clientQ = el.value; return rerender(); }
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
