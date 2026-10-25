// Retail POS — quotations (Sales → Quotes).
//
// From the cart (couch and fabric, cushions, delivery …) the till asks the
// server for a quote: priced as a sale would be (the fabric, the discounts
// and their approvals), numbered QT-…, valid for some days (14 unless said
// otherwise), with or without the customer. It prints, or goes by WhatsApp
// or email, as a Quotation. Later "Load into the sale" puts its lines back
// in the cart at the quoted prices: Pay makes it a sale, Sales order takes a
// deposit. The server holds those prices only while the quote is open and in
// date, for the same items and fabric, and marks it used once the sale or the
// order is written. Only the server writes quotes.
//
//   quotes/<id>  { entityId, storeId, series: 'QT', docNo, customerId, customerSnapshot, lines (as a sale's,
//                  with the spec), totals, validUntil, status: open|used|cancelled, usedAs, note, stamps }
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money, niceDate, empty } from './ui.js';
import { openReceipt } from './receiptui.js';
import { specLines } from './receipt.js';
import { newId } from './db.js';

let ctx = { repaint() {}, data: () => ({}), onLoad: () => false };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();
export const qt = { q: '', filter: 'open' };
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
// open, but past its date: shown as expired (the server will not hold its prices)
const stateOf = (q) => q.status === 'open' && String(q.validUntil) < today() ? 'expired' : q.status;
const LABEL = { open: 'Open', expired: 'Expired', used: 'Used', cancelled: 'Cancelled' };
const CHIP = { open: 'ok', expired: 'late', used: '', cancelled: 'off' };

// ---------------------------------------------------------- the document --
export function docOf(q) {
  const dd = d();
  const rows = [['Valid until', niceDate(q.validUntil)]];
  if (q.usedAs) rows.push(['Used for', (q.usedAs.kind === 'salesOrder' ? 'Sales order ' : 'Sale ') + q.usedAs.docNo]);
  const specs = (q.lines || []).filter(l => l.spec && specLines(l.spec).length).map(l => [l.name, specLines(l.spec).join(' · ')]);
  return { sale: { ...q, id: q.id, series: 'QT', docKind: 'quote', clientCreatedAt: q.quotedAt || q.createdAt, cashierName: q.cashierName,
    refLabel: 'Quotation ' + q.docNo + (q.customerSnapshot && q.customerSnapshot.name ? ' · ' + q.customerSnapshot.name : ''),
    sections: [{ title: 'This quotation', rows }, ...(specs.length ? [{ title: 'Made to order', rows: specs }] : [])],
    terms: 'Prices include VAT and hold until ' + niceDate(q.validUntil) + '. Made-to-order items are built once the order is placed and the deposit paid.' + (q.note ? ' ' + q.note : '') },
    lines: q.lines || [], payments: [], entity: dd.entity, store: dd.store, settings: dd.settings };
}

// ---------------------------------------------------------- a new quote --
export function openNew(cart, t) {
  const dd = d();
  const days = Number((dd.settings.quotes || {}).validDays) || 14;
  let busy = false;
  const { wrap, close } = openModal('Quote' + (cart.customer ? ' for ' + cart.customer.name : ''), `
    <p>${t.pieces} item${t.pieces === 1 ? '' : 's'} · <strong>${esc(money(t.totalCents))}</strong>, priced as on the sale (fabric and discounts included).</p>
    ${cart.customer ? `<p class="muted">For ${esc(cart.customer.name)}${cart.customer.phone ? ' · ' + esc(cart.customer.phone) : ''}.</p>`
      : row(field('Customer’s name (optional)', 'qt-name', { placeholder: 'or add the customer to the sale first' }), field('Phone (for WhatsApp)', 'qt-phone', { inputmode: 'tel' }))}
    ${row(field('Valid for (days)', 'qt-days', { value: days, inputmode: 'numeric' }), field('Note on the quote', 'qt-note', { placeholder: 'e.g. delivery in Bellville included' }))}`, {
    okLabel: 'Make the quote', onOk: async () => {
      if (busy) return false; busy = true;
      const body = {
        quoteId: newId('qt'), clientCreatedAt: new Date().toISOString(), customerId: cart.customerId || '', customerName: val(wrap, 'qt-name'), customerPhone: val(wrap, 'qt-phone'),
        validDays: Number(val(wrap, 'qt-days')) || days, note: val(wrap, 'qt-note'),
        lines: cart.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, priceOverride: l.priceOverride ? { reason: l.priceOverride.reason, token: l.priceOverride.token } : null, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, discountToken: l.discountToken || '', note: l.note, custom: !!l.custom, name: l.name, vatClass: l.vatClass, spec: l.type === 'mto' && l.spec ? l.spec : null })),
        saleDiscountCents: cart.discountCents || 0, saleDiscountPct: cart.discountPct || 0, saleDiscountReason: cart.discountReason || '', saleDiscountToken: cart.discountToken || '', saleDiscountCode: cart.discountCode || '',
        totals: { totalCents: t.totalCents, vatCents: t.vatCents }, ...where()
      };
      try {
        const r = await auth.api('quote', body, API.special);
        close(true);
        toast('Quote ' + r.quote.docNo + ' made, valid until ' + niceDate(r.quote.validUntil) + ' · the sale stays in the cart');
        openReceipt(docOf(r.quote));
        if (ctx.onChange) ctx.onChange(r);
        return true;
      } catch (e) { busy = false; toast(e.offline ? 'A quote needs the line: try again when connected.' : e.message, 'warn'); return false; }
    }
  });
}

// ---------------------------------------------------------- the list --
export function quotesHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Quotes</h1></div><div class="card muted">Pick a store first.</div>`;
  const all = dd.quotes || [], s = qt.q.trim().toLowerCase();
  const rows = all.filter(q => (qt.filter === 'all' || stateOf(q) === qt.filter) && (!s || [q.docNo, q.customerSnapshot && q.customerSnapshot.name, q.customerSnapshot && q.customerSnapshot.phone, ...(q.lines || []).map(l => l.name + ' ' + ((l.spec && l.spec.fabric) || ''))].some(x => String(x || '').toLowerCase().includes(s))))
    .sort((a, b) => String(b.quotedAt || b.createdAt).localeCompare(String(a.quotedAt || a.createdAt)));
  const open = all.filter(q => stateOf(q) === 'open');
  return `<div class="page-head"><h1>Quotes</h1><p class="sub">${open.length} open · ${esc(money(open.reduce((n, q) => n + q.totalCents, 0)))} quoted</p></div>
    <div class="toolbar">
      <input id="qt-q" class="search" type="search" placeholder="Number, customer, phone, item, fabric" value="${esc(qt.q)}">
      <select id="qt-filter">${[['open', 'Open'], ['expired', 'Expired'], ['used', 'Used'], ['cancelled', 'Cancelled'], ['all', 'All']].map(x => `<option value="${x[0]}"${qt.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>
      <span class="muted">A new quote starts from the cart under Sell: tap Quote.</span>
    </div>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl qt-tbl"><thead><tr><th>No</th><th>Customer</th><th>What</th><th>Valid until</th><th class="r">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(q => { const st = stateOf(q); return `<tr class="${st === 'open' ? '' : 'off'}"><td><strong>${esc(q.docNo)}</strong><div class="muted">${esc(niceDate(q.quotedAt || q.createdAt))} · ${esc(q.cashierName || '')}</div></td>
        <td>${esc((q.customerSnapshot && q.customerSnapshot.name) || '—')}${q.customerSnapshot && q.customerSnapshot.phone ? `<div class="muted">${esc(q.customerSnapshot.phone)}</div>` : ''}</td>
        <td>${(q.lines || []).map(l => `<div>${esc(l.qty + ' × ' + l.name)}${l.spec && l.spec.fabric ? ` <span class="muted">· ${esc(l.spec.fabric)}</span>` : ''}</div>`).join('')}</td>
        <td>${esc(niceDate(q.validUntil))}</td><td class="r"><strong>${esc(money(q.totalCents))}</strong></td>
        <td><span class="chip ${CHIP[st]}">${esc(LABEL[st])}</span>${q.usedAs ? `<div class="muted">${esc(q.usedAs.docNo)}</div>` : ''}</td>
        <td class="btn-row" style="margin:0;flex-wrap:nowrap">${`<button class="btn ghost sm" data-act="qt-print" data-id="${esc(q.id)}">Print / send</button>`}${st === 'open' ? `<button class="btn primary sm" data-act="qt-load" data-id="${esc(q.id)}">Load into the sale</button><button class="btn ghost sm" data-act="qt-cancel" data-id="${esc(q.id)}">Cancel</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : empty(qt.filter === 'open' ? 'No open quotes' : 'Nothing here', qt.filter === 'open' ? 'Ring the items up under Sell (pick the fabric on a made-to-order item) and tap Quote.' : '')}`;
}

export async function action(act, b) {
  const q = (d().quotes || []).find(x => x.id === b.dataset.id); if (!q) return;
  if (act === 'qt-print') return openReceipt(docOf(q));
  if (act === 'qt-load') {
    if ((d().cartLines || 0) && !confirm('The sale in the cart is replaced by quote ' + q.docNo + '. Go ahead?')) return;
    if (ctx.onLoad(q)) toast('Quote ' + q.docNo + ' is in the sale at its quoted prices: Pay, or tap Sales order for a deposit.');
    return;
  }
  if (act === 'qt-cancel') {
    const reason = prompt('Cancel quote ' + q.docNo + ': why? (it no longer holds its prices)', ''); if (reason === null) return;
    try { await auth.api('quoteCancel', { quoteId: q.id, reason, ...where() }, API.special); toast(q.docNo + ' cancelled'); }
    catch (e) { toast(e.message, 'warn'); }
  }
}
export function onInput(id, value) { if (id === 'qt-q') { qt.q = value; ctx.repaint(); const el = document.getElementById('qt-q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } }
export function onChange(e) { if (e.target.id === 'qt-filter') { qt.filter = e.target.value; ctx.repaint(); } }
