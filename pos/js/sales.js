// Retail POS — the Sales tab: the store's sales, newest first, to look up,
// reprint (marked COPY) and share. An invoice is final: its items, prices and
// payments never change. Only who it is made out to can be put right (Fix
// details on the receipt: a manager, with a reason), and the print says so.
import { list } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, empty, money, niceDate, niceTime } from './ui.js';
import { API } from './config.js';
import { openReceipt } from './receiptui.js';
import { receiptKind, kindTitle } from './receipt.js';

export const view = { day: new Date().toISOString().slice(0, 10), q: '' };

export function salesHtml(d) {
  if (!d.store) return `<div class="page-head"><h1>Sales</h1></div><div class="card muted">Pick a store first.</div>`;
  const q = view.q.trim().toLowerCase();
  const rows = d.sales.filter(s => (!view.day || String(s.clientCreatedAt || '').slice(0, 10) === view.day) && (!q || [s.docNo, s.customerSnapshot && s.customerSnapshot.name, s.cashierName].some(x => String(x || '').toLowerCase().includes(q))))
    .sort((a, b) => String(b.clientCreatedAt).localeCompare(String(a.clientCreatedAt)));
  const total = rows.reduce((n, s) => n + s.totalCents, 0);
  return `<div class="page-head"><h1>Sales</h1><p class="sub">${esc(d.store.name)} · ${rows.length} sale${rows.length === 1 ? '' : 's'} · ${esc(money(total))}</p></div>
    <div class="toolbar">${field('Day', 'sa-day', { type: 'date', value: view.day })}<input id="sa-q" class="search" type="search" placeholder="Number, customer, cashier" value="${esc(view.q)}"><button class="btn ghost sm" data-act="sa-all">All days</button></div>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>No</th><th>Time</th><th>Customer</th><th>Served by</th><th>Paid</th><th class="r">Total</th><th></th></tr></thead>
      <tbody>${rows.map(s => `<tr><td><strong>${esc(s.docNo)}</strong><div class="muted">${esc(kindTitle(receiptKind(s, d.entity)))}</div></td><td class="muted">${esc(niceDate(s.clientCreatedAt))} ${esc(niceTime(s.clientCreatedAt))}</td><td>${esc(s.customerSnapshot ? s.customerSnapshot.name : 'Walk-in')}</td><td class="muted">${esc(s.cashierName || '')}</td><td class="muted">${esc((s.paymentMethods || []).join(', '))}${s.paidStatus === 'awaiting' ? ' <span class="chip late">awaiting</span>' : ''}</td><td class="r"><strong>${esc(money(s.totalCents))}</strong></td><td class="r"><button class="btn ghost sm" data-act="sa-open" data-id="${esc(s.id)}">Receipt</button></td></tr>`).join('')}</tbody></table></div>`
      : empty('No sales ' + (view.day ? 'on that day' : 'yet'))}`;
}
// a reprint: the lines and payments come from the database; it is a COPY
export async function openSale(id, d) {
  const sale = d.sales.find(s => s.id === id); if (!sale) return;
  try {
    const [lines, payments] = await Promise.all([list('saleLines', [['entityId', '==', sale.entityId], ['storeId', '==', sale.storeId], ['saleId', '==', id]]), list('payments', [['entityId', '==', sale.entityId], ['storeId', '==', sale.storeId], ['docId', '==', id]])]);
    lines.sort((a, b) => a.lineNo - b.lineNo);
    openReceipt({ sale, lines, payments, vouchersSold: [], entity: d.entity, store: d.store, settings: d.settings, copy: true, fix: () => fixDetails(sale, d) });
  } catch (e) { toast('Could not open it: ' + e.message, 'warn'); }
}
const where = (d) => auth.session.device ? auth.deviceBody() : { entityId: d.entity.id, storeId: d.store.id };
// who the invoice is made out to, put right: a manager (or a manager's PIN) with a reason; nothing else on it changes
export function fixDetails(sale, d) {
  const c = sale.customerSnapshot || {}, a = c.address || {};
  let busy = false;
  openModal('Fix the details on ' + sale.docNo, `
    <p class="muted">The invoice stays as written: its items, prices and payments never change. Only who it is made out to can be put right, and the invoice then says when its details were corrected.</p>
    ${row(field('Name', 'fx-name', { value: c.name || '' }), field('Phone', 'fx-phone', { value: c.phone || '', inputmode: 'tel' }))}
    ${row(field('Email', 'fx-email', { value: c.email || '', type: 'email' }), field('VAT number', 'fx-vat', { value: c.vatNo || '' }))}
    ${row(field('Address line 1', 'fx-line1', { value: a.line1 || '' }), field('Address line 2', 'fx-line2', { value: a.line2 || '' }))}
    ${row(field('City', 'fx-city', { value: a.city || '' }), field('Postal code', 'fx-code', { value: a.code || '' }))}
    ${field('Why', 'fx-reason', { placeholder: 'e.g. The customer’s VAT number was left off' })}`, {
    okLabel: 'Save the correction', onOk: async (w) => {
      if (busy) return false;
      const reason = val(w, 'fx-reason'); if (!reason) { toast('Say why the details change.', 'warn'); return false; }
      if (!val(w, 'fx-name')) { toast('The customer needs a name.', 'warn'); return false; }
      const body = { saleId: sale.id, reason, customer: { name: val(w, 'fx-name'), phone: val(w, 'fx-phone'), email: val(w, 'fx-email'), vatNo: val(w, 'fx-vat'), address: { line1: val(w, 'fx-line1'), line2: val(w, 'fx-line2'), city: val(w, 'fx-city'), code: val(w, 'fx-code') } }, ...where(d) };
      busy = true;
      try {
        let r;
        try { r = await auth.api('fixDetails', body, API.sale); }
        catch (e) {
          if (e.status === 403 && /PIN/.test(e.message)) { const ap = await auth.requireOverride({ minRole: 'manager', action: 'sale', docType: 'sale', docId: sale.id, details: { docNo: sale.docNo, reason }, text: e.message }); r = await auth.api('fixDetails', { ...body, approvalToken: ap.token }, API.sale); }
          else throw e;
        }
        Object.assign(sale, r.sale);
        toast(sale.docNo + ': details corrected');
        openSale(sale.id, d);
        return true;
      } catch (e) { busy = false; toast(e.offline ? 'This needs the line: try again when connected.' : e.message, 'warn'); return false; }
    }
  });
}
