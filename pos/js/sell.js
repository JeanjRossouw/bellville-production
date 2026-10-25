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
import { saveCustomer, consentFields, readConsent } from './customers.js';
import { openPay } from './pay.js';
import { pickerHtml, wirePicker, pickedFabric } from './fabrics.js';
import { fabricMetresOf, fabricCentsFor, framePriceOf, upholsteredOf, fabricLabel } from './special-terms.js';

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
const stockOf = (itemId) => { const s = store(); const lv = (d().stockLevels || []).find(x => x.storeId === (s && s.id) && (x.variantId === itemId || (!x.variantId && x.productId === itemId))); return (lv ? (Number(lv.onHandQty) || 0) - (Number(lv.reservedQty) || 0) : 0) + ((d().stockOffsets || {})[itemId] || 0); };
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
  const have = c.lines.find(l => l.itemId === itemId && !l.priceOverride && !l.quote && !(l.spec && (l.spec.fabricId || l.spec.fabric)));   // a second couch in another fabric is its own line
  if (have && p.type !== 'voucher') { have.qty += qty; }
  else {
    c.lines.push({ lineId: newId('x'), productId: p.id, variantId: v ? v.id : '', itemId, name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcode: ((v && v.barcodes) || p.barcodes || [])[0] || '',
      qty, listPriceCents: priceOf(p, v), unitPriceCents: priceOf(p, v), priceOverride: null, discountCents: 0, discountPct: 0, discountReason: '', discountBy: null, note: '',
      type: p.type, vatClass: p.vatClass || 'standard', trackStock: p.trackStock !== false && p.type === 'stock', costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0 });
  }
  const added = c.lines[c.lines.length - 1];
  if (!have && framePriceOf(p, v) > 0 && added && added.itemId === itemId) { persist(); ctx.repaint(); return lineFabric(c.lines.length - 1); }
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
          ${lineCanFabric(l) ? `<button class="btn ghost sm" data-act="sl-fabric" data-i="${i}">${icon('fabric')} ${l.spec && (l.spec.fabricId || l.spec.frame) ? (l.spec.frame ? 'Frame + ' : '') + esc(l.spec.fabricId ? (fabricList().find(f => f.id === l.spec.fabricId) || {}).design || 'fabric' : l.spec.fabric || 'own fabric') : 'Fabric'}</button>` : ''}
          <button class="btn ghost sm" data-act="sl-note" data-i="${i}">${l.type === 'mto' ? (l.spec && (l.spec.fabric || l.spec.size || l.spec.colour) ? esc([l.spec.size, l.spec.fabric, l.spec.colour, l.spec.legs].filter(Boolean).join(' · ')) : 'Specification') + (l.note ? ' · ' + esc(l.note) : '') : l.note ? esc(l.note) : 'Note'}</button>${l.type === 'mto' ? '<span class="chip prod">made to order</span>' : ''}${l.fabricCents ? `<span class="chip">fabric +${esc(money(l.fabricCents))}</span>` : ''}${l.quote ? `<span class="chip ok" title="The price of quote ${esc(l.quote.docNo)}">quoted ${esc(l.quote.docNo)}</span>` : ''}${l.trackStock && stockOf(l.itemId) < l.qty ? '<span class="chip late">stock goes negative</span>' : ''}</div>
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
        <button data-act="sl-delivery" title="A delivery fee, with the address, on this sale or sales order">${icon('pin')}Delivery</button>
        <button data-act="sl-layby"${c.lines.length && ctx.onLayby ? '' : ' disabled'} title="Put this sale on lay-by">${icon('box')}Lay-by</button>
        <button data-act="sl-special"${c.lines.some(l => l.type === 'mto') && ctx.onSpecial ? '' : ' disabled'} title="Made to order: the spec signed off, a deposit now and the rest before delivery">${icon('truck')}Sales order</button>
        <button data-act="sl-quote"${c.lines.length && ctx.onQuote ? '' : ' disabled'} title="A numbered quotation of this sale, valid for some days, to print or send">${icon('file')}Quote</button>
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
    case 'sl-fabric': return lineFabric(i);
    case 'sl-delivery': return delivery();
    case 'sl-line-disc': return lineDiscount(i);
    case 'sl-cart-disc': return cartDiscount();
    case 'sl-price': return priceOverride(i);
    case 'sl-customer': return pickCustomer();
    case 'sl-park': return parkSale();
    case 'sl-recall': return recallSale();
    case 'sl-void': return voidSale();
    case 'sl-custom': return customItem();
    case 'sl-special': {
      if (!c.lines.length || !ctx.onSpecial) return;
      if (d().registerId && !d().shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
      return ctx.onSpecial(c, totals(), () => { sale.cart = freshCart(); persist(); ctx.repaint(); });
    }
    case 'sl-quote': {
      if (!c.lines.length || !ctx.onQuote) return;
      return ctx.onQuote(c, totals());
    }
    case 'sl-layby': {
      if (!c.lines.length || !ctx.onLayby) return;
      if (d().registerId && !d().shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
      return ctx.onLayby(c, totals(), () => { sale.cart = freshCart(); persist(); ctx.repaint(); });
    }
    case 'sl-pay': {
      if (!c.lines.length) return;
      if (d().registerId && !d().shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
      if (c.lines.some(l => l.type === 'mto') && !c.customer) return toast('A made-to-order item is a sales order: add the customer first, so the store can tell them when it is ready.', 'warn');
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
  if (l.type !== 'mto') return openModal('Note on ' + l.name, field('Note', 'ln-note', { value: l.note, placeholder: 'e.g. Grey fabric, deliver Friday' }), { okLabel: 'Save', onOk: (w) => { l.note = val(w, 'ln-note'); persist(); ctx.repaint(); return true; } });
  // made to order: the specification is kept on the sale's sales order, for when someone sends it to the factory
  const sp = l.spec || {};
  const { p, v } = itemOfLine(l), metres = p ? fabricMetresOf(p, v) : 0, fabs = fabricList();
  const m = openModal('Made to order: ' + l.name, `<p class="muted">Sold as a sales order: when the sale is written the factory gets this specification, and the customer on the sale is told when it is ready.</p>
    ${pickerHtml('ln-fab', fabs, sp.fabricId, sp.fabric, metres)}
    <div class="grid two">${field('Model', 'ln-model', { value: sp.model || l.name })}${field('Size', 'ln-size', { value: sp.size || '', placeholder: 'e.g. 2.4 m' })}${field('Colour', 'ln-colour', { value: sp.colour || '', placeholder: 'e.g. Charcoal' })}${field('Legs', 'ln-legs', { value: sp.legs || '', placeholder: 'e.g. Oak, tapered' })}</div>
    ${field('Notes for the maker', 'ln-notes', { type: 'textarea', rows: 2, value: sp.notes || '' })}
    ${field('Note on the slip', 'ln-note', { value: l.note, placeholder: 'e.g. deliver Friday' })}`, { okLabel: 'Save', onOk: (w) => {
      const fab = pickedFabric(w, 'ln-fab');
      if (l.quote && (fab.fabricId || '') !== ((l.spec && l.spec.fabricId) || '')) delete l.quote;   // another fabric: the quote's price no longer applies
      l.spec = { model: val(w, 'ln-model'), size: val(w, 'ln-size'), fabric: fab.fabric, fabricId: fab.fabricId, frame: !!(l.spec && l.spec.frame), colour: val(w, 'ln-colour'), legs: val(w, 'ln-legs'), notes: val(w, 'ln-notes') };
      l.note = val(w, 'ln-note'); priceWithFabric(l); persist(); ctx.repaint(); return true; } });
  wirePicker(m.wrap, 'ln-fab', fabs);
}
// the company's fabric catalogue, for the specification
const fabricList = () => (d().fabrics || []).filter(f => f.entityId === (entity() || {}).id);
const itemOfLine = (l) => { const p = d().products.find(x => x.id === l.productId) || null; return { p, v: p && l.variantId ? d().variants.find(x => x.id === l.variantId) || null : null }; };
// a made-to-order line's list price: the item's own, plus its metres × the chosen catalogue fabric's price per metre
// (the server works it out the same way and refuses a sale that does not match)
export function priceWithFabric(l) {
  const { p, v } = itemOfLine(l); if (!p) return;
  const sp = l.spec || {}, chosen = upholsteredOf(p, v) && !!(sp.fabricId || sp.frame);
  const f = chosen && sp.fabricId ? fabricList().find(x => x.id === sp.fabricId) : null;
  const frame = chosen ? framePriceOf(p, v) : 0;
  const base = frame > 0 ? frame : priceOf(p, v), add = f ? fabricCentsFor(fabricMetresOf(p, v), f.priceCents) : 0;
  l.fabricCents = add;
  // a stocked couch made in a chosen fabric is made for the customer: no stock taken (the server does the same)
  const made = p.type === 'mto' || chosen;
  l.type = made ? 'mto' : p.type; l.trackStock = !made && p.trackStock !== false && p.type === 'stock';
  const list = base + add;
  if (!l.priceOverride) { l.listPriceCents = list; l.unitPriceCents = list; } else l.listPriceCents = list;
  if (l.discountPct) l.discountCents = pctOf(l.qty * l.unitPriceCents, l.discountPct);
}
const lineCanFabric = (l) => { const { p, v } = itemOfLine(l); return !l.custom && upholsteredOf(p, v); };
// the fabric of a couch: as shown (its price, from stock when it is stocked), or the frame with a fabric of the
// customer's choice: a catalogue fabric adds its metres × price per metre, the customer's own fabric adds nothing
function lineFabric(i) {
  const l = sale.cart.lines[i]; if (!l) return;
  const { p, v } = itemOfLine(l); if (!p) return;
  const frame = framePriceOf(p, v), metres = fabricMetresOf(p, v), fabs = fabricList(), sp = l.spec || {};
  const how0 = sp.frame || (frame > 0 && sp.fabricId) ? 'frame' : sp.fabricId ? 'fabric' : 'shown';
  const m = openModal('Fabric: ' + l.name, `
    ${frame > 0 ? `<div class="fb-how">
      <label class="chk"><input type="radio" name="fb-how" value="shown"${how0 === 'shown' ? ' checked' : ''}> <span><strong>As shown</strong> · ${esc(money(priceOf(p, v)))}${p.type === 'stock' ? ' · from stock' : ''}</span></label>
      <label class="chk"><input type="radio" name="fb-how" value="frame"${how0 === 'frame' ? ' checked' : ''}> <span><strong>Frame</strong> · ${esc(money(frame))} + the fabric the customer chooses (made to order)</span></label></div>` : ''}
    <div id="fb-pickwrap">${pickerHtml('ln-fab2', fabs, sp.fabricId, sp.fabric, metres)}</div>
    <p class="muted">Search the catalogue, or type the customer’s own fabric (nothing is added for it).</p>
    <div class="fb-total">Price: <strong id="fb-total"></strong></div>`, { okLabel: 'Use this', onOk: (w) => {
      const how = frame > 0 ? (w.querySelector('input[name=fb-how]:checked') || {}).value : 'fabric';
      const fab = pickedFabric(w, 'ln-fab2');
      const had = (l.spec && l.spec.fabricId) || '';
      if (how === 'shown') { if (l.spec) { delete l.spec.fabricId; delete l.spec.frame; if (!fab.fabricId) l.spec.fabric = ''; } }
      else l.spec = { ...(l.spec || {}), model: (l.spec && l.spec.model) || p.name, fabric: fab.fabric, fabricId: fab.fabricId, frame: how === 'frame' };
      if (l.quote && ((l.spec && l.spec.fabricId) || '') !== had) delete l.quote;
      priceWithFabric(l); persist(); ctx.repaint(); return true; } });
  const w = m.wrap;
  const total = () => {
    const how = frame > 0 ? (w.querySelector('input[name=fb-how]:checked') || {}).value : 'fabric';
    w.querySelector('#fb-pickwrap').hidden = how === 'shown';
    const f = fabs.find(x => x.id === (w.querySelector('#ln-fab2') || {}).dataset.fabric);
    const cents = how === 'shown' ? priceOf(p, v) : (how === 'frame' ? frame : priceOf(p, v)) + (f ? fabricCentsFor(metres, f.priceCents) : 0);
    w.querySelector('#fb-total').textContent = money(cents) + (f && how !== 'shown' ? ' (incl. ' + fabricLabel(f) + ')' : '');
  };
  wirePicker(w, 'ln-fab2', fabs, total);
  w.addEventListener('change', total); total();
}
// a delivery fee on the sale (or the sales order): a line with the address, standard VAT
function delivery() {
  const cu = sale.cart.customer, a = (cu && cu.address) || {};
  const fee = Number((settings().delivery || {}).defaultFeeCents) || 0;
  openModal('Delivery', `${row(field('Street', 'dl-line1', { value: a.line1 || '' }), field('Suburb', 'dl-line2', { value: a.line2 || '' }))}
    ${row(field('City', 'dl-city', { value: a.city || '' }), field('Delivery fee (R, incl. VAT)', 'dl-fee', { value: fee ? randsOf(fee) : '', inputmode: 'decimal' }))}
    ${field('Note for the driver (optional)', 'dl-note', { placeholder: 'e.g. 3rd floor, no lift' })}`, {
    okLabel: 'Add delivery', onOk: (w) => {
      const where = [val(w, 'dl-line1'), val(w, 'dl-line2'), val(w, 'dl-city')].filter(Boolean).join(', '), cents = centsOf(val(w, 'dl-fee'));
      if (!where) { toast('Where to: the street or the suburb.', 'warn'); return false; }
      if (!(cents >= 0) || val(w, 'dl-fee') === '') { toast('The delivery fee (0 for free delivery).', 'warn'); return false; }
      sale.cart.lines.push({ lineId: newId('x'), productId: '', variantId: '', itemId: '', name: 'Delivery to ' + where, sku: '', barcode: '', qty: 1, listPriceCents: cents, unitPriceCents: cents, priceOverride: null, discountCents: 0, discountPct: 0, discountReason: '', discountBy: null, note: val(w, 'dl-note'), type: 'nonstock', vatClass: 'standard', trackStock: false, costCents: 0, custom: true, delivery: { address: where } });
      persist(); ctx.repaint(); return true; }
  });
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
  const codes = (d().discountCodes || []).filter(x => x.active);
  openModal('Discount on the sale', discountForm('Sale', sub, { pct: c.discountPct, cents: c.discountCents, reason: c.discountReason }) + (codes.length ? field('Or a discount code from the online shop', 'dc-code', { type: 'select', value: c.discountCode || '', options: [{ value: '', label: 'None' }, ...codes.map(x => ({ value: x.code, label: x.code + ' · ' + (x.kind === 'percentage' ? x.value + '% off' : money(x.valueCents) + ' off') }))] }) : ''), {
    okLabel: 'Apply', onOk: async (w) => {
      const codeEl = w.querySelector('#dc-code'); const code = codeEl ? codeEl.value : '';
      if (code) {
        // a shop code: the discount it gives, no PIN; the server checks the code again
        const x = codes.find(y => y.code === code); const cents = Math.min(sub, x.kind === 'percentage' ? pctOf(sub, x.value) : x.valueCents);
        c.discountCents = cents; c.discountPct = x.kind === 'percentage' ? x.value : (sub ? Math.round(cents / sub * 1000) / 10 : 0); c.discountReason = 'Code ' + code; c.discountBy = null; c.discountToken = ''; c.discountCode = code; persist(); ctx.repaint(); return true;
      }
      c.discountCode = '';
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
    <details style="margin-top:.7rem"><summary class="muted">Quick add</summary>${row(field('Name', 'cu-name'), field('Cell number', 'cu-phone', { inputmode: 'tel', placeholder: '082 123 4567' }))}${row(field('Email (optional)', 'cu-email', { type: 'email' }), field('VAT number (optional)', 'cu-vat'))}${consentFields('cu')}<button class="btn primary sm" type="button" id="cu-add">Add and attach</button></details>
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
      const dup = (d().customers || []).find(x => String(x.phone || '').replace(/\s/g, '') === phone && !x.archived);
      if (dup) { attach(dup); close(true); return toast('That number is ' + dup.name + ': attached.'); }
      try { const rec = await saveCustomer({ name, phone, email: val(wrap, 'cu-email'), vatNo: val(wrap, 'cu-vat'), consent: readConsent(wrap, 'cu'), consentSource: 'till' }); attach(rec); close(true); toast(name + ' added'); } catch (err) { toast(err.offline ? 'Adding a customer needs the line.' : err.message, 'warn'); }
    }
  });
  setTimeout(() => { const q = wrap.querySelector('#cu-q'); if (q && !wrap.contains(document.activeElement)) q.focus(); }, 50);   // not when the cashier is already typing in the quick-add
}
function attach(x) { if (!x) return; sale.cart.customerId = x.id; sale.cart.customer = { id: x.id, name: x.name, phone: x.phone || '', email: x.email || '', vatNo: x.vatNo || '', address: x.address || {}, accountEnabled: !!x.accountEnabled, storeCreditCents: x.storeCreditCents || 0, loyalty: x.loyalty ? { points: x.loyalty.points || 0, tier: x.loyalty.tier || '' } : null }; persist(); ctx.repaint(); }

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
// a quote into the sale: its lines at the quoted prices, its discounts and its customer; the server holds the
// till to those prices only while the quote is open and valid, and marks it used when the sale or the order is written
export function loadQuote(q) {
  const lines = [];
  for (const ql of q.lines || []) {
    const p = d().products.find(x => x.id === ql.productId) || null, v = p && ql.variantId ? d().variants.find(x => x.id === ql.variantId) || null : null;
    if (!ql.custom && !p) { toast(ql.name + ' is no longer in the catalogue: the quote cannot be loaded.', 'warn'); return false; }
    const l = { lineId: newId('x'), productId: ql.productId || '', variantId: ql.variantId || '', itemId: v ? v.id : p ? p.id : '', name: ql.name, sku: ql.sku || '', barcode: '', qty: ql.qty,
      listPriceCents: ql.unitPriceCents, unitPriceCents: ql.unitPriceCents, priceOverride: null, discountCents: ql.discountCents || 0, discountPct: ql.discountPct || 0, discountReason: ql.discountReason || '', discountBy: null, note: '',
      type: ql.custom ? 'nonstock' : p.type, vatClass: ql.vatClass || 'standard', trackStock: !!ql.trackStock, costCents: ql.costCents || 0, custom: !!ql.custom,
      ...(ql.spec ? { spec: { model: ql.spec.model || '', size: ql.spec.size || '', fabric: ql.spec.fabric || '', fabricId: ql.spec.fabricId || '', frame: !!ql.spec.frame, colour: ql.spec.colour || '', legs: ql.spec.legs || '', notes: ql.spec.notes || '' } } : {}),
      quote: { id: q.id, lineNo: ql.lineNo, docNo: q.docNo } };
    if (p) { priceWithFabric(l); l.unitPriceCents = ql.unitPriceCents; l.fabricCents = ql.spec && ql.spec.fabricCents || 0; }
    lines.push(l);
  }
  const cust = q.customerId ? (d().customers || []).find(x => x.id === q.customerId) || null : null;
  sale.cart = { ...freshCart(), lines, customerId: cust ? cust.id : '', customer: cust, discountCents: q.saleDiscountCents || 0, discountPct: q.saleDiscountPct || 0, discountReason: q.saleDiscountReason || (q.saleDiscountCents ? 'Quote ' + q.docNo : ''), quoteId: q.id, quoteDocNo: q.docNo };
  persist(); ctx.repaint();
  return true;
}
