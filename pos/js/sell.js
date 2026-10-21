// Retail POS — the sale screen, for a 10-inch tablet at the counter.
//
// Left: scan or search, favourites, categories, product tiles with the
// store's price and stock on hand. Right: the cart. A keyboard-wedge
// scanner types the code and presses Enter; that is caught anywhere on the
// screen. Discounts are checked against the role limits in settings; over
// the limit the manager-PIN pad opens and the approver is written on the
// line. A price override always needs a manager. The cart in progress and
// the parked sales live on the device until step 6 writes the sale.
import { setOne, newId } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money } from './ui.js';
import { lineTotals, vatIn, pctOf, rateOn, rateFor, centsOf, randsOf } from './money.js';
import { icon } from './icons.js';
import { openPay } from './pay.js';

const ROLE_ORDER = ['cashier', 'supervisor', 'manager', 'owner'];
let ctx = { repaint() {}, data: () => ({}) };     // set by app.js
export const setContext = (c) => { ctx = { ...ctx, ...c }; };

// ---------------------------------------------------------------- state --
export const sale = {
  cart: freshCart(), cat: '__home__', q: '', mobileCart: false
};
function freshCart() { return { id: cartId(), lines: [], customerId: '', customer: null, discountCents: 0, discountPct: 0, discountReason: '', discountBy: null, note: '', startedAt: new Date().toISOString() }; }
function cartId() { return (auth.deviceId() || 'web') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
const storeKey = (s) => 'pos-cart-' + s;
const parkKey = (s) => 'pos-parked-' + s;
export function loadCart(storeId) {
  try { const c = JSON.parse(localStorage.getItem(storeKey(storeId)) || 'null'); sale.cart = c && Array.isArray(c.lines) ? c : freshCart(); } catch (e) { sale.cart = freshCart(); }
}
const persist = () => { const s = store(); if (s) try { localStorage.setItem(storeKey(s.id), JSON.stringify(sale.cart)); } catch (e) {} };
export const parked = () => { const s = store(); try { return s ? JSON.parse(localStorage.getItem(parkKey(s.id)) || '[]') : []; } catch (e) { return []; } };
const savePark = (list) => { const s = store(); if (s) try { localStorage.setItem(parkKey(s.id), JSON.stringify(list)); } catch (e) {} };

// ------------------------------------------------------- the catalogue --
const d = () => ctx.data();
const store = () => d().store || null;
const entity = () => d().entity || null;
const settings = () => d().settings || {};
const rateToday = () => { const e = entity(); return e && e.vatRegistered ? rateOn((settings().vat || {}).rates, new Date().toISOString()) : 0; };
const lineRate = (vatClass) => rateFor(vatClass, rateToday(), !!(entity() || {}).vatRegistered);
const maxPct = (role) => { const m = (settings().discounts || {}).maxPctByRole || {}; const v = m[role]; return v == null ? ({ cashier: 5, supervisor: 15, manager: 50, owner: 100 })[role] : Number(v); };
const myLimit = () => maxPct(auth.session.user.role);
// the lowest role allowed to give this much
const roleFor = (pct) => ROLE_ORDER.find(r => maxPct(r) >= pct) || 'owner';
const variantsOf = (pid) => d().variants.filter(v => v.productId === pid && !v.archived);
const stockOf = (itemId) => { const s = store(); const lv = (d().stockLevels || []).find(x => x.storeId === (s && s.id) && (x.variantId === itemId || (!x.variantId && x.productId === itemId))); return (lv ? Number(lv.onHandQty) || 0 : 0) + ((d().stockOffsets || {})[itemId] || 0); };
// what an item sells for here: the store's price, else the variant's, else the product's
function priceOf(p, v) {
  const s = store();
  if (v) { if (s && v.storePrices && v.storePrices[s.id] != null) return v.storePrices[s.id]; if (v.priceCents != null) return v.priceCents; }
  if (s && p.storePrices && p.storePrices[s.id] != null) return p.storePrices[s.id];
  return p.priceCents || 0;
}
const items = () => d().products.filter(p => !p.archived && p.entityId === (entity() || {}).id);
const catsOf = (list) => [...new Set(list.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const matches = (p, q) => [p.name, p.sku, p.category, p.brand, ...(p.barcodes || []), ...variantsOf(p.id).flatMap(v => [v.sku, v.name, ...(v.barcodes || [])])].some(x => String(x || '').toLowerCase().includes(q));
// a scanned or typed code → the product and variant it belongs to
export function findCode(code) {
  const c = String(code || '').trim().toLowerCase(); if (!c) return null;
  for (const p of items()) {
    if ((p.barcodes || []).some(b => b.toLowerCase() === c) || (p.sku || '').toLowerCase() === c) { const vs = variantsOf(p.id); return vs.length ? { p, pick: true } : { p, v: null }; }
    for (const v of variantsOf(p.id)) if ((v.barcodes || []).some(b => b.toLowerCase() === c) || (v.sku || '').toLowerCase() === c) return { p, v };
  }
  return null;
}

// ------------------------------------------------------------- the cart --
export function addItem(p, v, qty = 1) {
  const c = sale.cart;
  const itemId = v ? v.id : p.id;
  const have = c.lines.find(l => l.itemId === itemId && !l.priceOverride);
  if (have && p.type !== 'voucher') { have.qty += qty; }
  else {
    c.lines.push({ lineId: newId('x'), productId: p.id, variantId: v ? v.id : '', itemId, name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcode: ((v && v.barcodes) || p.barcodes || [])[0] || '',
      qty, listPriceCents: priceOf(p, v), unitPriceCents: priceOf(p, v), priceOverride: null, discountCents: 0, discountPct: 0, discountReason: '', discountBy: null, note: '',
      type: p.type, vatClass: p.vatClass || 'standard', trackStock: p.trackStock !== false && p.type === 'stock', costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0 });
  }
  if (p.trackStock !== false && p.type === 'stock') {
    const onHand = stockOf(itemId), inCart = c.lines.filter(l => l.itemId === itemId).reduce((n, l) => n + l.qty, 0);
    if (inCart > onHand) toast(`Only ${onHand} on hand here: this sale takes stock to ${onHand - inCart}.`, 'warn');
  }
  persist(); ctx.repaint();
}
export function totals(c = sale.cart) {
  let gross = 0, lineDisc = 0, sub = 0;
  const lines = c.lines.map(l => { const t = lineTotals({ qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, rateBp: lineRate(l.vatClass) }); gross += t.grossCents; lineDisc += t.discountCents; sub += t.lineTotalCents; return { ...l, ...t }; });
  // the sale discount is spread over the lines in proportion, so each line's VAT is right
  const cartDisc = Math.min(sub, c.discountCents || 0);
  let left = cartDisc, vat = 0;
  lines.forEach((l, i) => {
    const share = i === lines.length - 1 ? left : (sub ? Math.round(cartDisc * l.lineTotalCents / sub) : 0);
    left -= share;
    l.saleDiscountCents = share; l.netCents = l.lineTotalCents - share; l.vatRateBp = lineRate(l.vatClass); l.vatCents = vatIn(l.netCents, l.vatRateBp);
    vat += l.vatCents;
  });
  const total = sub - cartDisc;
  return { lines, grossCents: gross, lineDiscountCents: lineDisc, saleDiscountCents: cartDisc, discountCents: lineDisc + cartDisc, subtotalCents: sub, totalCents: total, vatCents: vat, pieces: c.lines.reduce((n, l) => n + l.qty, 0) };
}

// ---------------------------------------------------------------- html --
export function sellHtml() {
  const s = store(), e = entity();
  if (!s || !e) return `<div class="page-head"><h1>Sell</h1></div><div class="card muted">This device is not tied to a store yet. ${auth.atLeast('manager') ? 'Enrol it under Admin → Devices, or pick a store above.' : 'Ask a manager to enrol it.'}</div>`;
  const list = items();
  const q = sale.q.trim().toLowerCase();
  const favs = list.filter(p => p.favourite);
  const cats = catsOf(list);
  const tile = (p) => { const vs = variantsOf(p.id); const stock = p.trackStock !== false && p.type === 'stock' && !vs.length ? stockOf(p.id) : null;
    return `<button class="pos-tile" data-act="sl-add" data-id="${esc(p.id)}">${p.images && p.images[0] ? `<img class="pos-tile-img" src="${esc(p.images[0])}" alt="" loading="lazy">` : `<span class="pos-tile-img none">${esc(String(p.name).split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase())}</span>`}
      <span class="pos-tile-name">${esc(p.name)}</span><span class="pos-tile-price">${vs.length ? 'from ' + esc(money(Math.min(...vs.map(v => priceOf(p, v))))) : esc(money(priceOf(p, null)))}</span>
      <span class="pos-tile-stock">${vs.length ? vs.length + ' variants' : stock == null ? (p.type === 'mto' ? 'made to order' : p.type === 'nonstock' ? '' : p.type === 'voucher' ? 'gift voucher' : '') : stock > 0 ? stock + ' in stock' : '<b class="warn">none in stock</b>'}</span></button>`; };
  let grid;
  if (q) { const hits = list.filter(p => matches(p, q)); grid = hits.length ? hits.slice(0, 200).map(tile).join('') : '<div class="pos-grid-empty">Nothing matches</div>'; }
  else if (sale.cat === '__home__') {
    grid = (favs.length ? `<div class="pos-grid-cat">${icon('star')} Favourites</div>${favs.map(tile).join('')}<div class="pos-grid-rule"></div>` : '')
      + cats.map(cn => { const inCat = list.filter(p => p.category === cn); const img = inCat.find(p => p.images && p.images[0]); return `<button class="pos-tile cat-tile" data-act="sl-cat" data-to="${esc(cn)}">${img ? `<img class="pos-tile-img" src="${esc(img.images[0])}" alt="">` : `<span class="pos-tile-img none">${icon('tag')}</span>`}<span class="pos-tile-name">${esc(cn)}</span><span class="pos-tile-stock">${inCat.length} item${inCat.length === 1 ? '' : 's'}</span></button>`; }).join('')
      + (!cats.length && !favs.length ? `<div class="pos-grid-empty">${list.length ? 'Give products a category or a favourite tick to see them here; or search.' : 'No products yet: Products → New product, or import Shopify’s CSV.'}</div>` : '');
  } else { const shown = list.filter(p => sale.cat === '' || p.category === sale.cat); grid = shown.length ? shown.map(tile).join('') : '<div class="pos-grid-empty">Nothing here</div>'; }
  const chip = (label, v) => `<button class="cat-chip${sale.cat === v && !q ? ' on' : ''}" data-act="sl-cat" data-to="${esc(v)}">${esc(label)}</button>`;
  const t = totals();
  const c = sale.cart;
  const park = parked();
  return `<div class="pos${sale.mobileCart ? ' m-cart' : ''}">
    <div class="pos-left">
      <div class="pos-scan-row">
        <label class="pos-search-wrap">${icon('search')}<input id="sl-q" class="pos-in" placeholder="Scan a barcode, or search by name or SKU" value="${esc(sale.q)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <button class="pos-sq" data-act="sl-home" title="Favourites and categories">${icon('grid')}</button>
      </div>
      ${cats.length ? `<div class="cat-bar">${chip('Categories', '__home__')}${chip('All', '')}${cats.map(x => chip(x, x)).join('')}</div>` : ''}
      <div class="pos-grid">${grid}</div>
    </div>
    <div class="pos-right"><div class="card pos-cart">
      <div class="pos-cart-title"><span>Current sale</span><span class="muted" style="letter-spacing:0;text-transform:none;font-weight:500">${esc(s.name)}</span></div>
      ${d().registerId && d().shiftKnown && !d().shiftOpen ? '<div class="notice-inline reg-closed">The register is closed. Open it under <strong>Register</strong> before selling.</div>' : ''}
      <button class="pos-cust${c.customer ? ' set' : ''}" data-act="sl-customer"><span class="pos-cust-ico">${icon('user')}</span><span class="pos-cust-txt">${c.customer ? `<strong>${esc(c.customer.name)}</strong><span>${esc([c.customer.phone, c.customer.vatNo ? 'VAT ' + c.customer.vatNo : ''].filter(Boolean).join(' · ') || 'tap to change')}</span>` : '<strong>Add a customer</strong><span>Needed over R 5 000, for lay-bys and accounts</span>'}</span></button>
      <div class="pos-lines">${c.lines.length ? t.lines.map((l, i) => `<div class="pos-line" data-i="${i}">
        <div class="pos-line-top"><strong>${esc(l.name)}</strong><button class="pos-icon-btn light" data-act="sl-void-line" data-i="${i}" title="Remove this line">${icon('x')}</button></div>
        <div class="pos-line-ctl">
          <span class="qty"><button class="btn ghost sm" data-act="sl-qty" data-i="${i}" data-d="-1">−</button><b>${esc(l.qty)}</b><button class="btn ghost sm" data-act="sl-qty" data-i="${i}" data-d="1">+</button></span>
          <button class="pos-price${l.priceOverride ? ' over' : ''}" data-act="sl-price" data-i="${i}" title="Change the price (manager)">${esc(money(l.unitPriceCents))}${l.priceOverride ? ' <small>was ' + esc(money(l.listPriceCents)) + '</small>' : ''}</button>
          <strong class="pos-line-tot">${esc(money(l.lineTotalCents))}</strong>
        </div>
        <div class="pos-line-disc"><button class="btn ghost sm" data-act="sl-line-disc" data-i="${i}">${l.discountCents ? '− ' + esc(money(l.discountCents)) + (l.discountPct ? ' (' + esc(l.discountPct) + '%)' : '') + (l.discountBy ? ' · ' + esc(l.discountBy.name) : '') : 'Discount'}</button>
          <button class="btn ghost sm" data-act="sl-note" data-i="${i}">${l.note ? esc(l.note) : 'Note'}</button>${l.trackStock && stockOf(l.itemId) < l.qty ? '<span class="chip late">stock goes negative</span>' : ''}</div>
      </div>`).join('') : `<div class="pos-cart-empty">${icon('cart')}<span>No items yet</span><small>Scan a barcode or tap a product</small></div>`}</div>
      <div class="pos-totals">
        <div><span>Items (${t.pieces})</span><strong>${esc(money(t.grossCents))}</strong></div>
        ${t.lineDiscountCents ? `<div><span>Line discounts</span><strong>− ${esc(money(t.lineDiscountCents))}</strong></div>` : ''}
        <div><span>Discount on the sale</span><button class="btn ghost sm" data-act="sl-cart-disc">${t.saleDiscountCents ? '− ' + esc(money(t.saleDiscountCents)) + (c.discountPct ? ' (' + esc(c.discountPct) + '%)' : '') + (c.discountBy ? ' · ' + esc(c.discountBy.name) : '') : 'none'}</button></div>
        ${e.vatRegistered ? `<div class="muted"><span>Includes VAT</span><strong>${esc(money(t.vatCents))}</strong></div>` : '<div class="muted"><span>No VAT (not registered)</span><strong></strong></div>'}
        <div class="tot"><span>Total</span><strong>${esc(money(t.totalCents))}</strong></div>
      </div>
      <button class="btn primary pos-charge" data-act="sl-pay"${c.lines.length && (!d().registerId || d().shiftOpen) ? '' : ' disabled'}><span>Pay</span><span>${esc(money(t.totalCents))}</span></button>
      <div class="pos-extra">
        <button data-act="sl-park"${c.lines.length ? '' : ' disabled'}>${icon('inbox')}Park</button>
        <button data-act="sl-recall"${park.length ? '' : ' disabled'}>${icon('list')}Recall${park.length ? ' (' + park.length + ')' : ''}</button>
        <button data-act="sl-void"${c.lines.length ? '' : ' disabled'}>${icon('undo')}Void sale</button>
        <button data-act="sl-custom">${icon('plus')}Custom item</button>
      </div>
    </div></div>
    <div class="pos-mbar"><button class="${sale.mobileCart ? '' : 'on'}" data-act="sl-mview" data-to="shop">${icon('search')} Shop</button><button class="${sale.mobileCart ? 'on' : ''}" data-act="sl-mview" data-to="cart">${icon('cart')} Cart${t.pieces ? ' (' + t.pieces + ')' : ''}<b>${esc(money(t.totalCents))}</b></button></div>
  </div>`;
}

// ------------------------------------------------------------- actions --
export async function action(act, b) {
  const c = sale.cart; const i = Number(b.dataset.i);
  switch (act) {
    case 'sl-home': sale.cat = '__home__'; sale.q = ''; return ctx.repaint();
    case 'sl-cat': sale.cat = b.dataset.to; sale.q = ''; return ctx.repaint();
    case 'sl-mview': sale.mobileCart = b.dataset.to === 'cart'; return ctx.repaint();
    case 'sl-add': return pickProduct(b.dataset.id);
    case 'sl-qty': { const l = c.lines[i]; if (!l) return; l.qty = Math.max(1, l.qty + Number(b.dataset.d)); if (l.discountPct) l.discountCents = pctOf(l.qty * l.unitPriceCents, l.discountPct); persist(); return ctx.repaint(); }
    case 'sl-void-line': return voidLine(i);
    case 'sl-note': return lineNote(i);
    case 'sl-line-disc': return lineDiscount(i);
    case 'sl-cart-disc': return cartDiscount();
    case 'sl-price': return priceOverride(i);
    case 'sl-customer': return pickCustomer();
    case 'sl-park': return parkSale();
    case 'sl-recall': return recallSale();
    case 'sl-void': return voidSale();
    case 'sl-custom': return customItem();
    case 'sl-pay': {
      if (!c.lines.length) return;
      if (d().registerId && !d().shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
      const t = totals();
      return openPay({ totals: t, cart: c, data: d(), onDone: (r) => {
        sale.lastSale = r; sale.cart = freshCart(); persist(); ctx.repaint();
        toast((r.again ? 'Already written as ' : r.offline ? 'Offline sale ' : 'Sale ') + r.sale.docNo + (r.sale.changeCents ? ' · change ' + money(r.sale.changeCents) : '') + (r.negativeStock ? ' · stock went negative' : '') + (r.offline ? ' · sent when the line is back' : ''), r.offline ? 'warn' : '');
        if (ctx.onSold) ctx.onSold(r);
      } });
    }
  }
}
// typing in the search box; Enter with an exact code adds it straight away
export function onSearchInput(value) { sale.q = value; ctx.repaint(); const q = document.getElementById('sl-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
export function onSearchEnter(value) {
  const hit = findCode(value);
  if (hit) { sale.q = ''; if (hit.pick) pickProduct(hit.p.id); else addItem(hit.p, hit.v); return; }
  const q = String(value || '').trim().toLowerCase();
  const hits = items().filter(p => matches(p, q));
  if (hits.length === 1) { sale.q = ''; pickProduct(hits[0].id); return; }
  if (!hits.length) toast('Nothing matches ' + value, 'warn');
}
// a scanner typing into nowhere in particular: fast keys ending in Enter
let buf = '', last = 0;
export function onDocumentKey(e) {
  const t = e.target; const inField = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.id !== 'sl-q';
  if (inField || document.getElementById('modal')) return;
  const now = Date.now(); if (now - last > 120) buf = ''; last = now;
  if (e.key === 'Enter') { if (buf.length >= 3 && (t.id !== 'sl-q')) { e.preventDefault(); onSearchEnter(buf); } buf = ''; return; }
  if (e.key.length === 1 && t.id !== 'sl-q') buf += e.key;
}
function pickProduct(id) {
  const p = items().find(x => x.id === id); if (!p) return;
  const vs = variantsOf(p.id);
  if (!vs.length) return addItem(p, null);
  const { wrap, close } = openModal(p.name, `<div class="var-pick">${vs.map(v => `<button class="var-btn" data-v="${esc(v.id)}"><strong>${esc(v.name)}</strong><span>${esc(money(priceOf(p, v)))}${p.trackStock !== false && p.type === 'stock' ? ' · ' + stockOf(v.id) + ' in stock' : ''}</span></button>`).join('')}</div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; close(true); addItem(p, vs.find(v => v.id === b.dataset.v)); });
}
function customItem() {
  openModal('Custom item', row(field('What', 'ci-name', { placeholder: 'e.g. Delivery to Parow' }), field('Price (R, incl. VAT)', 'ci-price', { inputmode: 'decimal' })) + field('VAT class', 'ci-vat', { type: 'select', value: 'standard', options: [{ value: 'standard', label: 'Standard' }, { value: 'zero', label: 'Zero-rated' }, { value: 'exempt', label: 'Exempt' }] }), {
    okLabel: 'Add', onOk: (w) => { const name = val(w, 'ci-name'), cents = centsOf(val(w, 'ci-price')); if (!name || cents <= 0) { toast('Give it a name and a price.', 'warn'); return false; }
      sale.cart.lines.push({ lineId: newId('x'), productId: '', variantId: '', itemId: '', name, sku: '', barcode: '', qty: 1, listPriceCents: cents, unitPriceCents: cents, priceOverride: null, discountCents: 0, discountPct: 0, discountReason: '', discountBy: null, note: '', type: 'nonstock', vatClass: val(w, 'ci-vat'), trackStock: false, costCents: 0, custom: true });
      persist(); ctx.repaint(); return true; }
  });
}
function lineNote(i) {
  const l = sale.cart.lines[i]; if (!l) return;
  openModal('Note on ' + l.name, field('Note', 'ln-note', { value: l.note, placeholder: 'e.g. Grey fabric, deliver Friday' }), { okLabel: 'Save', onOk: (w) => { l.note = val(w, 'ln-note'); persist(); ctx.repaint(); return true; } });
}
// a discount needs a reason; over my limit, the PIN of a role that may give it
async function approveDiscount(pct, what) {
  if (pct <= myLimit()) return { name: auth.session.user.name, uid: auth.session.uid, token: '' };
  const minRole = roleFor(pct);
  if (minRole === 'owner' && maxPct('owner') < pct) throw new Error('Nobody may give ' + pct + '% off.');
  const r = await auth.requireOverride({ minRole, action: 'discount', details: { pct, what }, title: pct + '% off needs ' + (minRole === 'owner' ? 'the owner' : 'a ' + minRole), text: 'Your limit is ' + myLimit() + '%. Ask ' + (minRole === 'owner' ? 'the owner' : 'a ' + minRole) + ' to type their PIN.' });
  return { name: r.name, uid: r.uid, token: r.token };
}
function discountForm(label, grossCents, cur) {
  return `<p class="muted">${esc(label)}: ${esc(money(grossCents))}. Your limit is ${myLimit()}%; more needs a manager’s PIN.</p>` + row(field('Percent off', 'dc-pct', { value: cur.pct || '', type: 'number', min: 0, max: 100, step: '0.5' }), field('or Rands off', 'dc-amt', { value: cur.cents ? randsOf(cur.cents) : '', inputmode: 'decimal' })) + field('Reason', 'dc-reason', { value: cur.reason, placeholder: 'e.g. Floor model, price match, loyalty' });
}
function readDiscount(w, grossCents) {
  const pct = Number(val(w, 'dc-pct')) || 0, amt = centsOf(val(w, 'dc-amt'));
  const cents = pct ? pctOf(grossCents, pct) : amt;
  return { cents: Math.min(grossCents, Math.max(0, cents)), pct: pct || (grossCents ? Math.round(cents / grossCents * 1000) / 10 : 0), reason: val(w, 'dc-reason') };
}
function lineDiscount(i) {
  const l = sale.cart.lines[i]; if (!l) return;
  const gross = l.qty * l.unitPriceCents;
  openModal('Discount on ' + l.name, discountForm('Line', gross, { pct: l.discountPct, cents: l.discountCents, reason: l.discountReason }), {
    okLabel: 'Apply', onOk: async (w) => {
      const r = readDiscount(w, gross);
      if (r.cents && !r.reason) { toast('Give a reason.', 'warn'); return false; }
      try { const by = r.cents ? await approveDiscount(r.pct, l.name) : null; l.discountCents = r.cents; l.discountPct = Number(val(w, 'dc-pct')) || 0; l.discountReason = r.reason; l.discountBy = by && by.uid !== auth.session.uid ? by : null; l.discountToken = by ? by.token : ''; persist(); ctx.repaint(); return true; }
      catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}
function cartDiscount() {
  const c = sale.cart; const t = totals(); const sub = t.subtotalCents;
  openModal('Discount on the sale', discountForm('Sale', sub, { pct: c.discountPct, cents: c.discountCents, reason: c.discountReason }), {
    okLabel: 'Apply', onOk: async (w) => {
      const r = readDiscount(w, sub);
      if (r.cents && !r.reason) { toast('Give a reason.', 'warn'); return false; }
      try { const by = r.cents ? await approveDiscount(r.pct, 'the sale') : null; c.discountCents = r.cents; c.discountPct = Number(val(w, 'dc-pct')) || 0; c.discountReason = r.reason; c.discountBy = by && by.uid !== auth.session.uid ? by : null; c.discountToken = by ? by.token : ''; persist(); ctx.repaint(); return true; }
      catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}
function priceOverride(i) {
  const l = sale.cart.lines[i]; if (!l) return;
  openModal('Change the price of ' + l.name, `<p class="muted">List price ${esc(money(l.listPriceCents))}. A manager approves a changed price.</p>` + row(field('New price each (R, incl. VAT)', 'po-price', { value: randsOf(l.unitPriceCents), inputmode: 'decimal' }), field('Reason', 'po-reason', { value: l.priceOverride ? l.priceOverride.reason : '', placeholder: 'e.g. Damaged box' })), {
    okLabel: 'Change', onOk: async (w) => {
      const cents = centsOf(val(w, 'po-price')), reason = val(w, 'po-reason');
      if (cents < 0) return false;
      if (cents === l.listPriceCents) { l.unitPriceCents = cents; l.priceOverride = null; persist(); ctx.repaint(); return true; }
      if (!reason) { toast('Give a reason.', 'warn'); return false; }
      try {
        const r = auth.atLeast('manager') ? { uid: auth.session.uid, name: auth.session.user.name, token: '' } : await auth.requireOverride({ minRole: 'manager', action: 'price', details: { what: l.name, fromCents: l.listPriceCents, toCents: cents, reason } });
        l.unitPriceCents = cents; l.priceOverride = { fromCents: l.listPriceCents, reason, by: { uid: r.uid, name: r.name }, token: r.token };
        if (l.discountPct) l.discountCents = pctOf(l.qty * cents, l.discountPct);
        persist(); ctx.repaint(); return true;
      } catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}
// -------------------------------------------------------------- customer --
function pickCustomer() {
  const e = entity(); const c = sale.cart;
  const list = (q) => { const s = q.toLowerCase().replace(/\s/g, ''); return (d().customers || []).filter(x => !x.archived && (!s || [x.name, x.phone, x.email].some(v => String(v || '').toLowerCase().replace(/\s/g, '').includes(s)))).slice(0, 30); };
  const { wrap, close } = openModal('Customer', `
    <input id="cu-q" class="search" placeholder="Name or cell number" autocomplete="off" style="width:100%;font:inherit;font-size:15px;padding:.6rem .7rem;border:1px solid var(--line-2);border-radius:4px;margin-bottom:.5rem">
    <div class="pk-list" id="cu-list"></div>
    <details style="margin-top:.7rem"><summary class="muted">Quick add</summary>${row(field('Name', 'cu-name'), field('Cell number', 'cu-phone', { inputmode: 'tel', placeholder: '082 123 4567' }))}${row(field('Email (optional)', 'cu-email', { type: 'email' }), field('VAT number (optional)', 'cu-vat'))}<button class="btn primary sm" type="button" id="cu-add">Add and attach</button></details>
    ${c.customer ? '<p style="margin-top:.6rem"><button class="btn ghost sm" type="button" id="cu-clear">Walk-in: no customer</button></p>' : ''}`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  const draw = () => { const q = wrap.querySelector('#cu-q').value; wrap.querySelector('#cu-list').innerHTML = list(q).map(x => `<button class="pk-row" data-c="${esc(x.id)}"><strong>${esc(x.name)}</strong><span>${esc([x.phone, x.email].filter(Boolean).join(' · '))}${x.accountEnabled ? ' · account' : ''}${Number(x.storeCreditCents) > 0 ? ' · credit ' + esc(money(x.storeCreditCents)) : ''}</span></button>`).join('') || '<div class="pk-row muted">No one matches: quick add below</div>'; };
  draw();
  wrap.querySelector('#cu-q').addEventListener('input', draw);
  wrap.querySelector('#cu-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  wrap.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-c]');
    if (b) { const x = (d().customers || []).find(y => y.id === b.dataset.c); attach(x); close(true); return; }
    if (ev.target.id === 'cu-clear') { c.customerId = ''; c.customer = null; persist(); ctx.repaint(); close(true); return; }
    if (ev.target.id === 'cu-add') {
      const name = val(wrap, 'cu-name'), phone = val(wrap, 'cu-phone').replace(/\s/g, '');
      if (!name || !/^\+?\d{9,13}$/.test(phone)) return toast('A name and a cell number (10 digits).', 'warn');
      const dup = (d().customers || []).find(x => String(x.phone || '').replace(/\s/g, '') === phone);
      if (dup) { attach(dup); close(true); return toast('That number is ' + dup.name + ': attached.'); }
      const id = newId('customers');
      const rec = { name, contact: name, phone, email: val(wrap, 'cu-email'), vatNo: val(wrap, 'cu-vat'), address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, notes: '', archived: false, ...auth.stamp(e.id, '') };
      try { await setOne('customers', id, rec); attach({ id, ...rec }); close(true); toast(name + ' added'); } catch (err) { toast('Could not add: ' + err.message, 'warn'); }
    }
  });
  setTimeout(() => wrap.querySelector('#cu-q').focus(), 50);
}
function attach(x) { if (!x) return; sale.cart.customerId = x.id; sale.cart.customer = { id: x.id, name: x.name, phone: x.phone || '', email: x.email || '', vatNo: x.vatNo || '', address: x.address || {}, accountEnabled: !!x.accountEnabled, storeCreditCents: x.storeCreditCents || 0 }; persist(); ctx.repaint(); }

// --------------------------------------------------------- park, recall --
function parkSale() {
  const c = sale.cart; if (!c.lines.length) return;
  openModal('Park this sale', field('Label', 'pk-label', { value: c.customer ? c.customer.name : '', placeholder: 'e.g. Lady in the red coat' }), {
    okLabel: 'Park', onOk: (w) => { const list = parked(); list.unshift({ ...c, label: val(w, 'pk-label') || (c.customer ? c.customer.name : 'Parked'), parkedAt: new Date().toISOString(), parkedBy: auth.session.user.name }); savePark(list); sale.cart = freshCart(); persist(); ctx.repaint(); toast('Parked'); return true; }
  });
}
function recallSale() {
  const list = parked(); if (!list.length) return;
  const { wrap, close } = openModal('Parked sales', `<div class="pk-list">${list.map((x, i) => `<button class="pk-row" data-r="${i}"><strong>${esc(x.label)}</strong><span>${x.lines.length} line${x.lines.length === 1 ? '' : 's'} · ${esc(money(totals(x).totalCents))} · ${esc(x.parkedBy || '')} ${esc(new Date(x.parkedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }))}</span></button>`).join('')}</div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; const i = Number(b.dataset.r);
    if (sale.cart.lines.length) { const cur = sale.cart; list.push({ ...cur, label: cur.customer ? cur.customer.name : 'Parked', parkedAt: new Date().toISOString(), parkedBy: auth.session.user.name }); }
    sale.cart = list.splice(i, 1)[0]; delete sale.cart.label; savePark(list); persist(); ctx.repaint(); close(true); });
}

// ---------------------------------------------------------------- voids --
async function audit(action, details) {
  const e = entity(), s = store();
  try { await setOne('auditLog', newId('auditLog'), { action, docType: 'cart', docId: sale.cart.id, docNo: '', actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '', details, ...auth.stamp(e.id, s.id) }); }
  catch (err) { console.error('audit failed', err); }
}
function voidLine(i) {
  const l = sale.cart.lines[i]; if (!l) return;
  openModal('Remove ' + l.name, field('Reason', 'vd-reason', { placeholder: 'e.g. Customer changed their mind, scanned twice' }), {
    okLabel: 'Remove', onOk: async (w) => { const reason = val(w, 'vd-reason'); if (!reason) { toast('Give a reason.', 'warn'); return false; }
      sale.cart.lines.splice(i, 1); persist(); ctx.repaint(); await audit('sale.line.void', { name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents, reason }); return true; }
  });
}
function voidSale() {
  const c = sale.cart; if (!c.lines.length) return;
  const t = totals();
  openModal('Void the whole sale', `<p class="muted">${t.pieces} item${t.pieces === 1 ? '' : 's'}, ${esc(money(t.totalCents))}. Nothing has been charged; this just clears the cart and notes why.</p>` + field('Reason', 'vd-reason', { placeholder: 'e.g. Customer walked away' }), {
    okLabel: 'Void', onOk: async (w) => { const reason = val(w, 'vd-reason'); if (!reason) { toast('Give a reason.', 'warn'); return false; }
      const lines = c.lines.map(l => ({ name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents })); const totalCents = t.totalCents;
      sale.cart = freshCart(); persist(); ctx.repaint(); await audit('sale.void', { lines, totalCents, reason }); toast('Sale voided'); return true; }
  });
}
export function clearCart() { sale.cart = freshCart(); persist(); }
