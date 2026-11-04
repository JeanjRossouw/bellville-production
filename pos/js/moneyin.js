// Retail POS — Money in (Sales → Money in; managers and the owner): every rand that came into the business on a day,
// or each day of a month, from the payment rows the server wrote. Money is cash, card, EFT and QR; it is shown by how
// it was paid and by what it was paid on (sales, sales orders, lay-bys, accounts), refunds taken off, with what still
// awaits the bank listed apart (an EFT or QR counts only once a manager confirms it). The report of the same name under
// Reports gives the CSV.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, money, niceDate, niceTime, empty } from './ui.js';

const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
export const mi = { mode: 'day', day: today(), month: today().slice(0, 7), storeId: '', result: null, loadedFor: '', busy: false };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();
const METHOD = { cash: 'Cash', card: 'Card', eft: 'EFT', qr: 'QR' };
const KIND = { sales: 'Sales', orders: 'Sales orders', laybys: 'Lay-bys', accounts: 'Accounts' };
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return ym + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0'); };
const range = () => mi.mode === 'day' ? [mi.day, mi.day] : [mi.month + '-01', monthEnd(mi.month)];
const niceMonth = (ym) => new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });

export function moneyHtml() {
  const dd = d();
  if (!dd.entity) return `<div class="page-head"><h1>Money in</h1></div><div class="card muted">Pick a store first.</div>`;
  const key = [dd.entity.id, mi.mode, ...range(), mi.storeId].join('|');
  if (mi.loadedFor !== key && !mi.busy) load(key);
  const r = mi.result && mi.loadedFor === key ? mi.result : null;
  const t = r ? r.totals : null;
  const stores = (dd.stores || []).filter(s => s.entityId === dd.entity.id && s.active !== false);
  const [from, to] = range();
  return `<div class="page-head"><h1>Money in</h1><p class="sub">${esc(dd.entity.tradingName || dd.entity.legalName)} · ${mi.mode === 'day' ? esc(niceDate(mi.day)) : esc(niceMonth(mi.month))}${mi.storeId ? ' · ' + esc((stores.find(s => s.id === mi.storeId) || {}).name || '') : ' · every store'}</p></div>
    <div class="toolbar">
      <div class="seg"><button class="btn sm${mi.mode === 'day' ? ' primary' : ' ghost'}" data-act="mi-mode" data-to="day">Day</button><button class="btn sm${mi.mode === 'month' ? ' primary' : ' ghost'}" data-act="mi-mode" data-to="month">Month</button></div>
      ${mi.mode === 'day' ? field('Day', 'mi-day', { type: 'date', value: mi.day }) + `<button class="btn ghost sm" data-act="mi-shift" data-n="-1">◀ Day before</button><button class="btn ghost sm" data-act="mi-shift" data-n="1">Day after ▶</button><button class="btn ghost sm" data-act="mi-today">Today</button>` : field('Month', 'mi-month', { type: 'month', value: mi.month })}
      ${stores.length > 1 ? field('Store', 'mi-store', { type: 'select', value: mi.storeId, options: [{ value: '', label: 'Every store' }, ...stores.map(s => ({ value: s.id, label: s.name }))] }) : ''}
    </div>
    ${!r ? '<div class="card muted">Adding it up…</div>' : `
    <div class="mi-top">
      <div class="card mi-big"><div class="muted">Money in${mi.mode === 'day' ? ' today' : ' this month'}</div><div class="mi-num">${esc(money(t.total))}</div><div class="muted">${t.count} payment${t.count === 1 ? '' : 's'}${t.refunds ? ' · refunds ' + esc(money(t.refunds)) + ' already taken off' : ''}</div></div>
      ${['cash', 'card', 'eft', 'qr'].map(m => `<div class="card mi-tile"><div class="muted">${METHOD[m]}</div><div class="mi-mid">${esc(money(t[m]))}</div></div>`).join('')}
      ${t.awaiting ? `<div class="card mi-tile warn"><div class="muted">Awaiting the bank</div><div class="mi-mid">${esc(money(t.awaiting))}</div><div class="muted">not counted yet</div></div>` : ''}
    </div>
    <div class="grid two">
      <div class="card"><h2>What it was paid on</h2><table class="tbl"><tbody>${Object.keys(KIND).map(k => `<tr><td>${KIND[k]}</td><td class="r"><strong>${esc(money(t[k]))}</strong></td></tr>`).join('')}${t.refunds ? `<tr class="off"><td>Refunds</td><td class="r">${esc(money(t.refunds))}</td></tr>` : ''}<tr class="tot"><td>Money in</td><td class="r"><strong>${esc(money(t.total))}</strong></td></tr>${t.other ? `<tr><td class="muted">Paid another way (vouchers, store credit, points, on account): not money in</td><td class="r muted">${esc(money(t.other))}</td></tr>` : ''}</tbody></table></div>
      <div class="card"><h2>Who took it</h2>${r.byStaff.length ? `<table class="tbl"><thead><tr><th>Staff</th><th class="r">Cash</th><th class="r">Card</th><th class="r">EFT</th><th class="r">QR</th><th class="r">Total</th></tr></thead><tbody>${r.byStaff.map(x => `<tr><td>${esc(x.staff)}<div class="muted">${x.count} payment${x.count === 1 ? '' : 's'}</div></td><td class="r">${esc(money(x.cash))}</td><td class="r">${esc(money(x.card))}</td><td class="r">${esc(money(x.eft))}</td><td class="r">${esc(money(x.qr))}</td><td class="r"><strong>${esc(money(x.total))}</strong></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing yet.</p>'}</div>
    </div>
    ${r.awaiting.length ? `<div class="card"><h2>Awaiting the bank <span class="chip late">${r.awaiting.length}</span></h2><p class="muted">EFTs and QR payments recorded but not yet confirmed against the statement: a manager confirms each on the order or the customer's card, and only then does it count as money in.</p>
      <table class="tbl"><thead><tr><th>When</th><th>Store</th><th>On</th><th>By</th><th>Reference</th><th>Taken by</th><th class="r">Amount</th></tr></thead><tbody>${r.awaiting.map(a => `<tr><td class="muted">${esc(niceDate(a.at))} ${esc(niceTime(a.at))}</td><td>${esc(a.store)}</td><td><strong>${esc(a.docNo)}</strong> <span class="muted">${esc(KIND[a.kind] || a.kind)}</span></td><td>${esc(METHOD[a.method] || a.method)}</td><td>${esc(a.ref)}</td><td>${esc(a.by)}</td><td class="r"><strong>${esc(money(a.amount))}</strong></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="card"><h2>${mi.mode === 'day' ? 'By store' : 'By day'}</h2>${r.rows.length ? `<div style="overflow:auto"><table class="tbl mi-tbl"><thead><tr>${mi.mode === 'month' ? '<th>Day</th>' : ''}<th>Store</th><th class="r">Cash</th><th class="r">Card</th><th class="r">EFT</th><th class="r">QR</th><th class="r">Sales</th><th class="r">Sales orders</th><th class="r">Lay-bys</th><th class="r">Accounts</th><th class="r">Refunds</th><th class="r">Money in</th><th class="r">Awaiting</th></tr></thead>
      <tbody>${r.rows.map(x => `<tr>${mi.mode === 'month' ? `<td><button class="btn ghost sm" data-act="mi-open" data-day="${esc(x.day)}">${esc(niceDate(x.day))}</button></td>` : ''}<td>${esc(x.store)}</td><td class="r">${esc(money(x.cash))}</td><td class="r">${esc(money(x.card))}</td><td class="r">${esc(money(x.eft))}</td><td class="r">${esc(money(x.qr))}</td><td class="r">${esc(money(x.sales))}</td><td class="r">${esc(money(x.orders))}</td><td class="r">${esc(money(x.laybys))}</td><td class="r">${esc(money(x.accounts))}</td><td class="r">${x.refunds ? esc(money(x.refunds)) : ''}</td><td class="r"><strong>${esc(money(x.total))}</strong></td><td class="r">${x.awaiting ? '<span class="warn">' + esc(money(x.awaiting)) + '</span>' : ''}</td></tr>`).join('')}
      <tr class="tot">${mi.mode === 'month' ? '<td></td>' : ''}<td>Total</td><td class="r">${esc(money(t.cash))}</td><td class="r">${esc(money(t.card))}</td><td class="r">${esc(money(t.eft))}</td><td class="r">${esc(money(t.qr))}</td><td class="r">${esc(money(t.sales))}</td><td class="r">${esc(money(t.orders))}</td><td class="r">${esc(money(t.laybys))}</td><td class="r">${esc(money(t.accounts))}</td><td class="r">${t.refunds ? esc(money(t.refunds)) : ''}</td><td class="r"><strong>${esc(money(t.total))}</strong></td><td class="r">${t.awaiting ? esc(money(t.awaiting)) : ''}</td></tr></tbody></table></div>` : empty('No money in ' + (mi.mode === 'day' ? 'on this day' : 'this month'), 'Payments show here as they are taken.')}</div>
    <p class="muted">A payment counts on the day it was taken, at the store where it was taken. Deposits and balances on sales orders and lay-bys are money in on that day; the sale itself is written at the hand-over. The cash-up on each register is the drawer's own count.</p>`}`;
}
async function load(key) {
  const dd = d();
  mi.busy = true;
  try {
    const [from, to] = range();
    const r = await auth.api('run', { report: 'moneyIn', entityId: dd.entity.id, storeId: mi.storeId, from, to }, API.report);
    mi.result = r; mi.loadedFor = key;
  } catch (e) { mi.result = null; mi.loadedFor = key; toast(e.message, 'warn'); }
  mi.busy = false;
  ctx.repaint();
}
const shiftDay = (n) => { mi.day = new Date(Date.parse(mi.day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); };
export function action(act, b) {
  if (act === 'mi-mode') { mi.mode = b.dataset.to === 'month' ? 'month' : 'day'; return ctx.repaint(); }
  if (act === 'mi-shift') { shiftDay(Number(b.dataset.n) || 0); return ctx.repaint(); }
  if (act === 'mi-today') { mi.day = today(); return ctx.repaint(); }
  if (act === 'mi-open') { mi.day = b.dataset.day; mi.mode = 'day'; return ctx.repaint(); }
}
export function onChange(e) {
  if (e.target.id === 'mi-day' && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { mi.day = e.target.value; ctx.repaint(); }
  if (e.target.id === 'mi-month' && /^\d{4}-\d{2}$/.test(e.target.value)) { mi.month = e.target.value; ctx.repaint(); }
  if (e.target.id === 'mi-store') { mi.storeId = e.target.value; ctx.repaint(); }
}
