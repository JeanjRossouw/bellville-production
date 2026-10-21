// Retail POS — the Sales tab: the store's sales, newest first, to look up,
// reprint (marked COPY) and share. Reads only; the documents never change.
import { list } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, empty, money, niceDate, niceTime } from './ui.js';
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
    openReceipt({ sale, lines, payments, vouchersSold: [], entity: d.entity, store: d.store, settings: d.settings, copy: true });
  } catch (e) { toast('Could not open it: ' + e.message, 'warn'); }
}
