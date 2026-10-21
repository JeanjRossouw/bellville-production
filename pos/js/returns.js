// Retail POS — the Returns tab: find the sale (scan the receipt barcode,
// type the number, by customer or by date), tick lines and quantities,
// reason and what happens to the goods, then refund by method or exchange
// with the current cart; or a return without a receipt (store credit only,
// a manager's PIN). The server writes the credit note; this screen prints it.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money, niceDate, niceTime } from './ui.js';
import { vatIn, rateOn, rateFor, centsOf, randsOf } from './money.js';
import { openReceipt } from './receiptui.js';
import { sale as sellState, totals as cartTotals, clearCart } from './sell.js';
import { icon } from './icons.js';

const DISP = [['restock', 'Back into stock'], ['quarantine', 'Quarantine (inspect first)'], ['writeoff', 'Write off']];
export const rt = { q: '', mode: 'number', results: null, picked: null, picks: {}, reasons: {}, disps: {}, noReceipt: false, nrLines: [], customer: null, settings: { windowDays: 7, reasons: ['Changed mind', 'Faulty', 'Wrong item', 'Damaged', 'Other'] }, busy: false };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- find --
export async function find(body) {
  rt.busy = true; ctx.repaint();
  try { const r = await auth.api('find', { ...where(), ...body }, API.return); rt.results = r.sales; rt.settings = r.settings || rt.settings; rt.picked = r.sales.length === 1 ? r.sales[0] : null; rt.picks = {}; rt.reasons = {}; rt.disps = {}; }
  catch (e) { toast(e.message, 'warn'); }
  rt.busy = false; ctx.repaint();
}
// what the credit comes to, the way the server works it out
export function creditLines() {
  if (rt.noReceipt) {
    const ent = d().entity, s = d().settings; const rateBp = ent.vatRegistered ? rateOn((s.vat || {}).rates, new Date().toISOString()) : 0;
    return rt.nrLines.map(l => { const lr = rateFor(l.vatClass, rateBp, !!ent.vatRegistered); const net = l.qty * l.unitPriceCents; return { name: l.name, qty: l.qty, unitPaidCents: l.unitPriceCents, lineTotalCents: net, vatCents: vatIn(net, lr), reason: l.reason || 'Other', disposition: l.disposition || 'quarantine' }; });
  }
  if (!rt.picked) return [];
  return rt.picked.lines.filter(l => rt.picks[l.lineNo] > 0).map(l => { const qty = rt.picks[l.lineNo]; const net = Math.round(l.netCents * qty / l.qty); return { saleLineNo: l.lineNo, name: l.name, qty, unitPaidCents: Math.round(l.netCents / l.qty), lineTotalCents: net, vatCents: vatIn(net, l.vatRateBp || 0), reason: rt.reasons[l.lineNo] || rt.settings.reasons[0], disposition: rt.disps[l.lineNo] || 'restock', mto: l.fulfilment === 'mto' }; });
}
const creditTotal = () => creditLines().reduce((n, l) => n + l.lineTotalCents, 0);

// ---------------------------------------------------------------- html --
export function returnsHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Returns</h1></div><div class="card muted">Pick a store first.</div>`;
  const lines = creditLines(), total = creditTotal();
  const cart = cartTotals(sellState.cart);
  const custs = (dd.customers || []).filter(c => !c.archived);
  return `<div class="page-head"><h1>Returns</h1><p class="sub">${rt.noReceipt ? 'Without a receipt: store credit only, a manager’s PIN' : 'Within ' + rt.settings.windowDays + ' days; a manager’s PIN after that or for made-to-order'}</p></div>
    <div class="toolbar">
      <label class="pos-search-wrap" style="flex:1 1 300px">${icon('search')}<input id="rt-q" class="pos-in" placeholder="Scan the receipt barcode or type the sale number" value="${esc(rt.q)}" autocomplete="off"></label>
      <select id="rt-cust"><option value="">By customer…</option>${custs.map(c => `<option value="${esc(c.id)}"${rt.customer === c.id ? ' selected' : ''}>${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}</option>`).join('')}</select>
      <input id="rt-date" type="date" class="in-sm" value="${today()}" title="Sales on a day"><button class="btn ghost sm" data-act="rt-by-date">That day</button>
      <button class="btn ${rt.noReceipt ? 'primary' : 'ghost'} sm" data-act="rt-noreceipt">${rt.noReceipt ? '✓ No receipt' : 'No receipt'}</button>
    </div>
    ${rt.noReceipt ? noReceiptHtml(dd) : (rt.results && rt.results.length > 1 && !rt.picked ? `<div class="card" style="padding:0"><div class="pk-list">${rt.results.map(x => `<button class="pk-row" data-act="rt-pick" data-id="${esc(x.sale.id)}"><strong>${esc(x.sale.docNo)} · ${esc(money(x.sale.totalCents))}</strong><span>${esc(niceDate(x.sale.clientCreatedAt))} ${esc(niceTime(x.sale.clientCreatedAt))} · ${esc(x.sale.customerSnapshot ? x.sale.customerSnapshot.name : 'walk-in')} · ${x.lines.length} line${x.lines.length === 1 ? '' : 's'}</span></button>`).join('')}</div></div>`
      : rt.results && !rt.results.length ? '<div class="card muted">No sale found. Check the number, or do a return without a receipt.</div>'
      : rt.picked ? pickedHtml(rt.picked) : '<div class="card muted">Scan the receipt, type its number, choose a customer, or pick a day.</div>')}
    ${lines.length ? `<div class="card rt-sum"><h2>Credit</h2>
      ${lines.map(l => `<div class="x-row"><span>${esc(l.name)} × ${l.qty} <span class="muted">· ${esc(l.reason)} · ${esc((DISP.find(x => x[0] === l.disposition) || [])[1] || l.disposition)}</span></span><strong>${esc(money(l.lineTotalCents))}</strong></div>`).join('')}
      ${dd.entity.vatRegistered ? `<div class="x-row muted"><span>VAT reversed</span><span>${esc(money(lines.reduce((n, l) => n + l.vatCents, 0)))}</span></div>` : ''}
      <div class="x-row tot"><span>Credit note total</span><strong>${esc(money(total))}</strong></div>
      <div class="card-actions">
        <button class="btn primary" data-act="rt-refund"${rt.busy ? ' disabled' : ''}>${rt.noReceipt ? 'Store credit' : 'Refund'} ${esc(money(total))}</button>
        ${!rt.noReceipt ? `<button class="btn" data-act="rt-exchange"${cart.pieces && !rt.busy ? '' : ' disabled'}>Exchange with the current cart${cart.pieces ? ' (' + cart.pieces + ' · ' + esc(money(cart.totalCents)) + ')' : ''}</button>` : ''}
      </div></div>` : ''}`;
}
function pickedHtml(x) {
  const s = x.sale;
  return `<div class="card"><div class="x-row"><strong>${esc(s.docNo)} · ${esc(money(s.totalCents))}</strong><span class="muted">${esc(niceDate(s.clientCreatedAt))} ${esc(niceTime(s.clientCreatedAt))} · ${esc(s.customerSnapshot ? s.customerSnapshot.name : 'Walk-in')} · ${esc(s.cashierName || '')}${rt.results && rt.results.length > 1 ? ' <button class="btn ghost sm" data-act="rt-unpick">Other sales</button>' : ''}</span></div>
    <table class="tbl rt-tbl"><thead><tr><th>Item</th><th class="r">Sold</th><th class="r">Paid each</th><th>Return</th><th>Reason</th><th>Goods</th></tr></thead><tbody>
    ${x.lines.map(l => { const left = l.qty - (x.returned[l.lineNo] || 0); const q = rt.picks[l.lineNo] || 0; return `<tr class="${left ? '' : 'off'}"><td><strong>${esc(l.name)}</strong>${l.fulfilment === 'mto' ? ' <span class="chip">made to order</span>' : ''}${x.returned[l.lineNo] ? `<div class="muted">${x.returned[l.lineNo]} returned before</div>` : ''}</td><td class="r">${l.qty}</td><td class="r">${esc(money(Math.round(l.netCents / l.qty)))}</td>
      <td><span class="qty"><button class="btn ghost sm" data-act="rt-qty" data-line="${l.lineNo}" data-d="-1"${q ? '' : ' disabled'}>−</button><b>${q}</b><button class="btn ghost sm" data-act="rt-qty" data-line="${l.lineNo}" data-d="1"${q < left ? '' : ' disabled'}>+</button></span></td>
      <td><select data-rt-reason="${l.lineNo}">${rt.settings.reasons.map(r => `<option${(rt.reasons[l.lineNo] || rt.settings.reasons[0]) === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></td>
      <td><select data-rt-disp="${l.lineNo}">${DISP.map(([k, lab]) => `<option value="${k}"${(rt.disps[l.lineNo] || 'restock') === k ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select></td></tr>`; }).join('')}
    </tbody></table></div>`;
}
function noReceiptHtml(dd) {
  const custs = (dd.customers || []).filter(c => !c.archived);
  return `<div class="card"><h2>Return without a receipt</h2><p class="muted">The goods are taken in at today’s price as store credit for the customer, after a manager approves. They go to quarantine unless you choose otherwise.</p>
    ${field('Customer (required)', 'rt-nr-cust', { type: 'select', value: rt.customer || '', options: [{ value: '', label: 'Choose…' }].concat(custs.map(c => ({ value: c.id, label: c.name + (c.phone ? ' · ' + c.phone : '') }))) })}
    <label class="pos-search-wrap">${icon('search')}<input id="rt-nr-q" class="pos-in" placeholder="Scan or search the item" autocomplete="off"></label>
    <div id="rt-nr-hits" class="pk-list" style="margin:.4rem 0 .8rem; max-height:160px"></div>
    ${rt.nrLines.length ? `<table class="tbl rt-tbl"><thead><tr><th>Item</th><th class="r">Price today</th><th>Qty</th><th>Reason</th><th>Goods</th><th></th></tr></thead><tbody>${rt.nrLines.map((l, i) => `<tr><td>${esc(l.name)}</td><td class="r">${esc(money(l.unitPriceCents))}</td><td><span class="qty"><button class="btn ghost sm" data-act="rt-nr-qty" data-i="${i}" data-d="-1">−</button><b>${l.qty}</b><button class="btn ghost sm" data-act="rt-nr-qty" data-i="${i}" data-d="1">+</button></span></td><td><select data-rt-nr-reason="${i}">${rt.settings.reasons.map(r => `<option${(l.reason || rt.settings.reasons[0]) === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></td><td><select data-rt-nr-disp="${i}">${DISP.map(([k, lab]) => `<option value="${k}"${(l.disposition || 'quarantine') === k ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select></td><td><button class="pos-icon-btn light" data-act="rt-nr-del" data-i="${i}">${icon('x')}</button></td></tr>`).join('')}</tbody></table>` : ''}
  </div>`;
}

// ------------------------------------------------------------- actions --
export async function action(act, b) {
  if (act === 'rt-by-date') { const dt = document.getElementById('rt-date').value; return find({ date: dt }); }
  if (act === 'rt-noreceipt') { rt.noReceipt = !rt.noReceipt; rt.picked = null; rt.results = null; rt.picks = {}; return ctx.repaint(); }
  if (act === 'rt-pick') { rt.picked = rt.results.find(x => x.sale.id === b.dataset.id) || null; rt.picks = {}; return ctx.repaint(); }
  if (act === 'rt-unpick') { rt.picked = null; return ctx.repaint(); }
  if (act === 'rt-qty') { const ln = Number(b.dataset.line); const l = rt.picked.lines.find(x => x.lineNo === ln); const left = l.qty - (rt.picked.returned[ln] || 0); rt.picks[ln] = Math.max(0, Math.min(left, (rt.picks[ln] || 0) + Number(b.dataset.d))); return ctx.repaint(); }
  if (act === 'rt-nr-qty') { const l = rt.nrLines[Number(b.dataset.i)]; if (l) l.qty = Math.max(1, l.qty + Number(b.dataset.d)); return ctx.repaint(); }
  if (act === 'rt-nr-del') { rt.nrLines.splice(Number(b.dataset.i), 1); return ctx.repaint(); }
  if (act === 'rt-refund') return refund();
  if (act === 'rt-exchange') return exchange();
}
export function onChange(e) {
  const t = e.target;
  if (t.id === 'rt-cust') { rt.customer = t.value; if (t.value) find({ customerId: t.value }); return true; }
  if (t.id === 'rt-nr-cust') { rt.customer = t.value; return true; }
  if (t.dataset.rtReason) { rt.reasons[t.dataset.rtReason] = t.value; return true; }
  if (t.dataset.rtDisp) { rt.disps[t.dataset.rtDisp] = t.value; ctx.repaint(); return true; }
  if (t.dataset.rtNrReason) { rt.nrLines[Number(t.dataset.rtNrReason)].reason = t.value; return true; }
  if (t.dataset.rtNrDisp) { rt.nrLines[Number(t.dataset.rtNrDisp)].disposition = t.value; ctx.repaint(); return true; }
  return false;
}
export function onEnter(id, value) {
  if (id === 'rt-q') { rt.q = value.trim(); if (rt.q) find({ docNo: rt.q }); return true; }
  if (id === 'rt-nr-q') { const hits = nrSearch(value); if (hits.length === 1) addNr(hits[0]); return true; }
  return false;
}
function nrSearch(q) {
  q = String(q || '').toLowerCase().trim(); if (!q) return [];
  const dd = d();
  return (dd.products || []).filter(p => p.entityId === dd.entity.id && !p.archived && p.type !== 'mto' && [p.name, p.sku, ...(p.barcodes || [])].some(x => String(x || '').toLowerCase().includes(q))).slice(0, 12);
}
export function onInput(id, value) {
  if (id !== 'rt-nr-q') return false;
  const hits = nrSearch(value); const box = document.getElementById('rt-nr-hits');
  if (box) { box.innerHTML = hits.map(p => `<button class="pk-row" data-nr="${esc(p.id)}"><strong>${esc(p.name)}</strong><span>${esc(money(priceOf(p)))}</span></button>`).join(''); box.onclick = (e) => { const b = e.target.closest('[data-nr]'); if (b) addNr(hits.find(p => p.id === b.dataset.nr)); }; }
  return true;
}
const priceOf = (p) => { const sid = d().store.id; return p.storePrices && p.storePrices[sid] != null ? p.storePrices[sid] : p.priceCents || 0; };
function addNr(p) {
  if (!p) return;
  const have = rt.nrLines.find(l => l.productId === p.id && !l.variantId);
  if (have) have.qty++; else rt.nrLines.push({ productId: p.id, variantId: '', name: p.name, unitPriceCents: priceOf(p), vatClass: p.vatClass || 'standard', qty: 1, reason: rt.settings.reasons[0], disposition: 'quarantine' });
  ctx.repaint();
}
// the server's answer when a manager must approve: ask for the PIN once and try again
async function withApproval(body, action) {
  try { return await auth.api('credit', body, API.return); }
  catch (e) {
    if (e.status === 403 && /manager/.test(e.message)) { const r = await auth.requireOverride({ minRole: 'manager', action, details: { totalCents: creditTotal(), noReceipt: rt.noReceipt }, text: e.message }); return auth.api('credit', { ...body, approvalToken: r.token }, API.return); }
    throw e;
  }
}
function bodyBase() {
  if (rt.noReceipt) return { ...where(), noReceipt: true, customerId: rt.customer || '', lines: rt.nrLines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, reason: l.reason, disposition: l.disposition })), clientCreatedAt: new Date().toISOString() };
  return { ...where(), saleId: rt.picked.sale.id, customerId: rt.picked.sale.customerId || '', lines: creditLines().map(l => ({ saleLineNo: l.saleLineNo, qty: l.qty, reason: l.reason, disposition: l.disposition })), clientCreatedAt: new Date().toISOString() };
}
function refund() {
  const total = creditTotal(); if (!total) return;
  const dd = d();
  if (rt.noReceipt) {
    if (!rt.customer) return toast('Choose the customer: the credit goes onto their account.', 'warn');
    return submit({ ...bodyBase(), refunds: [{ method: 'storeCredit', amountCents: total }] }, 'return');
  }
  const methods = ['cash', 'card', 'eft'].filter(m => (dd.store.paymentMethods || []).includes(m)).concat(rt.picked.sale.customerId ? ['storeCredit'] : []);
  const label = { cash: 'Cash', card: 'Card (reverse on the machine)', eft: 'EFT', storeCredit: 'Store credit' };
  openModal('Refund ' + money(total), `<p class="muted">How does ${money(total)} go back to the customer? Split it if need be.</p>` + methods.map(m => field(label[m] + ' (R)', 'rf-' + m, { inputmode: 'decimal', value: m === methods[0] ? randsOf(total) : '' })).join('') + field('Reference (card slip, EFT)', 'rf-ref'), {
    okLabel: 'Refund and issue the credit note', onOk: async (w) => {
      const refunds = methods.map(m => ({ method: m, amountCents: centsOf(val(w, 'rf-' + m)), ref: val(w, 'rf-ref') })).filter(r => r.amountCents > 0);
      const sum = refunds.reduce((n, r) => n + r.amountCents, 0);
      if (sum !== total) { toast('The refunds come to ' + money(sum) + ', not ' + money(total) + '.', 'warn'); return false; }
      return submit({ ...bodyBase(), refunds }, 'return');
    }
  });
}
function exchange() {
  const total = creditTotal(); const cart = sellState.cart; const t = cartTotals(cart);
  if (!total || !cart.lines.length) return;
  const dd = d();
  const diff = t.totalCents - total;
  const methods = ['cash', 'card', 'eft'].filter(m => (dd.store.paymentMethods || []).includes(m));
  openModal('Exchange', `<div class="x-row"><span>Credit for the goods coming back</span><strong>${esc(money(total))}</strong></div><div class="x-row"><span>The new items (${t.pieces})</span><strong>${esc(money(t.totalCents))}</strong></div>
    <div class="x-row tot"><span>${diff > 0 ? 'Customer pays' : diff < 0 ? 'Refund to the customer' : 'Nothing to pay'}</span><strong>${esc(money(Math.abs(diff)))}</strong></div>
    ${diff !== 0 ? field(diff > 0 ? 'Paid by' : 'Refunded by', 'ex-method', { type: 'select', options: methods.map(m => ({ value: m, label: m === 'eft' ? 'EFT' : m[0].toUpperCase() + m.slice(1) })) }) + field('Reference', 'ex-ref') : ''}`, {
    okLabel: 'Exchange', onOk: async (w) => {
      const method = val(w, 'ex-method'), ref = val(w, 'ex-ref');
      const saleBody = { saleId: cart.id, clientCreatedAt: new Date().toISOString(), customerId: cart.customerId || rt.picked.sale.customerId || '',
        lines: cart.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, priceOverride: l.priceOverride ? { reason: l.priceOverride.reason, token: l.priceOverride.token } : null, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, discountToken: l.discountToken || '', note: l.note, custom: !!l.custom, name: l.name, vatClass: l.vatClass })),
        saleDiscountCents: cart.discountCents || 0, saleDiscountPct: cart.discountPct || 0, saleDiscountReason: cart.discountReason || '', saleDiscountToken: cart.discountToken || '', totals: { totalCents: t.totalCents, vatCents: t.vatCents },
        tenders: diff > 0 ? [{ method, amountCents: diff, ref, tenderedCents: method === 'cash' ? diff : undefined }] : [] };
      const refunds = diff < 0 ? [{ method, amountCents: -diff, ref }] : [];
      const r = await submit({ ...bodyBase(), refunds, exchange: saleBody }, 'return');
      if (r) { clearCart(); if (r.sale) openReceipt({ sale: r.sale, lines: r.lines, payments: r.payments, vouchersSold: r.vouchersSold || [], entity: dd.entity, store: dd.store, settings: dd.settings, copy: false }); }
      return !!r;
    }
  });
}
async function submit(body, action) {
  rt.busy = true; ctx.repaint();
  try {
    const r = await withApproval(body, action);
    const dd = d();
    toast('Credit note ' + r.creditNote.docNo + (r.sale ? ' · exchange sale ' + r.sale.docNo : ''));
    rt.results = null; rt.picked = null; rt.picks = {}; rt.nrLines = []; rt.noReceipt = false; rt.q = ''; rt.busy = false; ctx.repaint();
    openReceipt({ sale: { ...r.creditNote, series: 'CN' }, lines: r.creditNote.lines, payments: (r.refunds || []).map(x => ({ ...x })), vouchersSold: [], entity: dd.entity, store: dd.store, settings: dd.settings, copy: false });
    if (ctx.onDone) ctx.onDone(r);
    return r;
  } catch (e) { rt.busy = false; ctx.repaint(); toast(e.message, 'warn'); return null; }
}
