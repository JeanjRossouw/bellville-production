// Retail POS — the Reports tab (managers and the owner): a report list with
// filters for company, store, dates, staff and channel; the table on
// screen, a CSV, and an A4 print (save as PDF). The owner's dashboard
// (today against the same weekday last week, per store) lives on Home.
// The Xero section builds the day's sales journal, downloads it as Xero's
// manual-journal CSV, and posts it when the company is connected.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, openPrint, money, niceDate, niceTime, empty } from './ui.js';
import { toCsv, download } from './csv.js';
import { A4_CSS } from './receipt.js';
import { icon } from './icons.js';

export const REPORTS = [
  ['dailySales', 'Daily sales'], ['zReports', 'Z-reports'], ['vat', 'VAT report'], ['byProduct', 'Sales by product'], ['byCategory', 'Sales by category'], ['byBrand', 'Sales by brand'],
  ['byStaff', 'Sales by staff'], ['byHour', 'Sales by hour'], ['discounts', 'Discounts and overrides'], ['voids', 'Voids'], ['refunds', 'Refunds'],
  ['stockValue', 'Stock value'], ['lowStock', 'Low stock'], ['movements', 'Stock movements'], ['deadStock', 'Dead stock'], ['laybys', 'Lay-bys'], ['specialOrders', 'Custom orders'], ['customers', 'Customers']
];
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
export const rp = { report: 'dailySales', entityId: '', storeId: '', from: monthStart(), to: today(), staffUid: '', channel: '', days: 90, result: null, busy: false, xero: null, xeroDate: new Date(Date.now() - 86400000 + 2 * 3600000).toISOString().slice(0, 10), xeroStatus: null, sub: 'reports' };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();   // { entities, stores, users, store, entity }
const myEntities = () => (d().entities || []).filter(e => auth.inEntity(e.id) && e.active !== false);
const entityId = () => rp.entityId || ((d().entity || {}).id) || (myEntities()[0] || {}).id || '';
const fmt = (v, type) => type === 'cents' ? money(v || 0) : type === 'int' ? String(v || 0) : type === 'pct' ? (v == null ? '' : v + '%') : type === 'date' ? (v ? niceDate(v) : '') : type === 'time' ? (v ? niceDate(v) + ' ' + niceTime(v) : '') : String(v == null ? '' : v);
const raw = (v, type) => type === 'cents' ? ((v || 0) / 100).toFixed(2) : type === 'time' ? String(v || '') : type === 'date' ? String(v || '').slice(0, 10) : String(v == null ? '' : v);

// ----------------------------------------------------------------- html --
export function reportsHtml() {
  const dd = d(); const ents = myEntities(); const eid = entityId();
  const stores = (dd.stores || []).filter(s => s.entityId === eid && auth.inStore(s.id));
  const staff = (dd.users || []).filter(u => u.active && (u.role === 'owner' || (u.entityIds || []).includes(eid)));
  const head = `<div class="page-head"><h1>Reports</h1></div><div class="subnav"><button class="subtab${rp.sub === 'reports' ? ' on' : ''}" data-act="rp-sub" data-to="reports">Reports</button><button class="subtab${rp.sub === 'xero' ? ' on' : ''}" data-act="rp-sub" data-to="xero">Xero journal</button></div>`;
  if (rp.sub === 'xero') return head + xeroHtml(ents, eid);
  const r = rp.result;
  return head + `<div class="rp-wrap"><div class="rp-side">${REPORTS.map(([k, l]) => `<button class="rp-item${rp.report === k ? ' on' : ''}" data-act="rp-pick" data-to="${k}">${esc(l)}</button>`).join('')}</div>
    <div class="rp-main"><div class="card rp-filters">
      <div class="grid four">${ents.length > 1 ? field('Company', 'rp-entity', { type: 'select', value: eid, options: ents.map(e => ({ value: e.id, label: e.tradingName || e.legalName })) }) : ''}${field('Store', 'rp-store', { type: 'select', value: rp.storeId, options: [{ value: '', label: 'All stores' }, ...stores.map(s => ({ value: s.id, label: s.name }))] })}${field('From', 'rp-from', { type: 'date', value: rp.from })}${field('To', 'rp-to', { type: 'date', value: rp.to })}</div>
      <div class="grid four">${field('Staff', 'rp-staff', { type: 'select', value: rp.staffUid, options: [{ value: '', label: 'Everyone' }, ...staff.map(u => ({ value: u.id, label: u.name }))] })}${field('Channel', 'rp-channel', { type: 'select', value: rp.channel, options: [{ value: '', label: 'All channels' }, { value: 'till', label: 'Till' }, { value: 'office', label: 'Office' }, { value: 'online', label: 'Online' }] })}${rp.report === 'deadStock' ? field('No sale for (days)', 'rp-days', { type: 'number', value: rp.days, min: 7 }) : ''}
        <div class="fld"><span>&nbsp;</span><div class="tk-acts"><button class="btn primary" data-act="rp-run"${rp.busy ? ' disabled' : ''}>${rp.busy ? 'Running…' : 'Run'}</button>${r ? `<button class="btn" data-act="rp-csv">${icon('file')} CSV</button><button class="btn" data-act="rp-print">${icon('printer')} Print / PDF</button>` : ''}</div></div></div>
      <p class="muted">${(REPORTS.find(x => x[0] === rp.report) || [])[1]}: ${helpFor(rp.report)}</p></div>
    ${r ? tableHtml(r) : '<div class="card muted">Pick a report and tap Run.</div>'}</div></div>`;
}
const helpFor = (k) => ({ dailySales: 'per day per store, with VAT, refunds and tenders.', zReports: 'every register close in the range with its cash variance.', vat: 'output VAT per company and rate, less credit notes; what the VAT201 needs.', byProduct: 'quantity, sales, returns, cost and gross profit per product.', byCategory: 'the same per category.', byBrand: 'the same per brand.', byStaff: 'sales, basket, discounts and refunds per person.', byHour: 'when the day is busy.', discounts: 'every line and sale discount and price override, with who approved it.', voids: 'lines and sales voided before completion, with the reason.', refunds: 'every credit note with its reasons and how it was refunded.', stockValue: 'what is on hand at cost and at retail, per store and category.', lowStock: 'items at or under their reorder level, with the quantity to order.', movements: 'every stock movement in the range.', deadStock: 'stock on hand with no sale for a while.', laybys: 'lay-bys opened in the range and where they stand.', specialOrders: 'custom orders opened in the range.', customers: 'spend, credit, points and consent; new ones in the range.' })[k] || '';
function tableHtml(r) {
  const cols = r.columns;
  return `<div class="card" style="padding:0;overflow:auto"><div class="rp-title"><strong>${esc(r.title)}</strong> <span class="muted">· ${esc(niceDate(r.from))}${r.to !== r.from ? ' – ' + esc(niceDate(r.to)) : ''} · ${r.rows.length} row${r.rows.length === 1 ? '' : 's'}</span></div>
    ${r.rows.length ? `<table class="tbl rp-tbl"><thead><tr>${cols.map(c => `<th class="${/cents|int|pct/.test(c.type) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${r.rows.slice(0, 1000).map(x => `<tr>${cols.map(c => `<td class="${/cents|int|pct/.test(c.type) ? 'r nowrap' : ''}">${esc(fmt(x[c.key], c.type))}</td>`).join('')}</tr>`).join('')}</tbody>
      ${r.totals ? `<tfoot><tr>${cols.map((c, i) => `<td class="${/cents|int|pct/.test(c.type) ? 'r nowrap' : ''}"><strong>${i === 0 && r.totals[c.key] == null ? 'Total' : esc(r.totals[c.key] == null ? '' : fmt(r.totals[c.key], c.type))}</strong></td>`).join('')}</tr></tfoot>` : ''}</table>${r.rows.length > 1000 ? '<p class="muted" style="padding:.5rem .8rem">The first 1 000 rows on screen; the CSV has them all.</p>' : ''}` : '<p class="muted" style="padding:.8rem">Nothing in that range.</p>'}</div>`;
}
function xeroHtml(ents, eid) {
  const x = rp.xero, st = rp.xeroStatus;
  return `<div class="card"><h2>Daily sales journal for Xero</h2>
    <p class="muted">One balanced manual journal per company per day: sales ex VAT, VAT output, the money by tender, and the liabilities for deposits, store credit, vouchers and points. Build it for a day, check it, then post it to Xero or import the CSV (Accounting → Manual journals → Import).</p>
    <div class="grid four">${ents.length > 1 ? field('Company', 'rp-entity', { type: 'select', value: eid, options: ents.map(e => ({ value: e.id, label: e.tradingName || e.legalName })) }) : ''}${field('Day', 'rp-xday', { type: 'date', value: rp.xeroDate })}
      <div class="fld"><span>&nbsp;</span><div class="tk-acts"><button class="btn primary" data-act="rp-xero-build">Build</button>${x ? `<button class="btn" data-act="rp-xero-csv">${icon('file')} CSV for Xero</button><button class="btn" data-act="rp-xero-push"${x.status === 'posted' || x.unbalanced || !x.lines.length ? ' disabled' : ''}>${icon('refresh')} Post to Xero</button>` : ''}</div></div></div>
    ${st ? `<p class="muted">${st.connected ? 'Connected to <strong>' + esc(st.tenantName || 'Xero') + '</strong>' : st.configured ? 'Not connected: ' + (auth.session.user.role === 'owner' ? '<a href="#" data-act="rp-xero-connect">connect Xero</a>' : 'the owner connects Xero') : 'Xero is not set up on this site (XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_POS_REDIRECT_URI on Netlify); the CSV import works regardless.'}${st.lastPushAt ? ' · last posted ' + esc(niceDate(st.lastPushAt)) : ''}${st.lastError ? ' · <span class="warn">' + esc(st.lastError) + '</span>' : ''}${st.connected && auth.session.user.role === 'owner' ? ' · <a href="#" data-act="rp-xero-disconnect">disconnect</a>' : ''}</p>` : ''}
    ${x ? `<div class="x-row"><span>${esc(x.narration)} · ${x.counts.sales} invoices, ${x.counts.creditNotes} credit notes, ${x.counts.payments} payments</span><span class="chip${x.status === 'posted' ? ' ok' : x.status === 'failed' || x.unbalanced ? ' late' : ''}">${esc(x.unbalanced ? 'unbalanced' : x.status)}</span></div>
      ${x.error ? `<p class="warn">${esc(x.error)}</p>` : ''}
      <table class="tbl"><thead><tr><th>Account</th><th>Description</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>${x.lines.map(l => `<tr><td>${esc(l.account)} <span class="muted">${esc(rp.xeroLabels[l.key] || '')}</span></td><td>${esc(l.description)}</td><td class="r">${l.cents > 0 ? esc(money(l.cents)) : ''}</td><td class="r">${l.cents < 0 ? esc(money(-l.cents)) : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No sales that day.</td></tr>'}</tbody><tfoot><tr><td colspan="2"><strong>Totals</strong></td><td class="r"><strong>${esc(money(x.debitsCents))}</strong></td><td class="r"><strong>${esc(money(x.creditsCents))}</strong></td></tr></tfoot></table>` : ''}</div>`;
}

// -------------------------------------------------------------- actions --
function readFilters() {
  const w = document.getElementById('screen');
  const g = (id) => { const e = w.querySelector('#' + id); return e ? e.value : null; };
  if (g('rp-entity') != null) rp.entityId = g('rp-entity');
  if (g('rp-store') != null) rp.storeId = g('rp-store'); if (g('rp-from') != null) rp.from = g('rp-from'); if (g('rp-to') != null) rp.to = g('rp-to');
  if (g('rp-staff') != null) rp.staffUid = g('rp-staff'); if (g('rp-channel') != null) rp.channel = g('rp-channel'); if (g('rp-days') != null) rp.days = Number(g('rp-days')) || 90;
  if (g('rp-xday') != null) rp.xeroDate = g('rp-xday');
}
export function onChange(e) { if (/^rp-/.test(e.target.id)) { const was = rp.entityId; readFilters(); if (e.target.id === 'rp-entity' && rp.entityId !== was) { rp.storeId = ''; rp.result = null; rp.xero = null; rp.xeroStatus = null; ctx.repaint(); } } }
export async function action(act, b) {
  if (act === 'rp-sub') { readFilters(); rp.sub = b.dataset.to; if (rp.sub === 'xero' && !rp.xeroStatus) xeroStatus(); return ctx.repaint(); }
  if (act === 'rp-pick') { readFilters(); rp.report = b.dataset.to; rp.result = null; return ctx.repaint(); }
  if (act === 'rp-run') return run();
  if (act === 'rp-csv') return csv();
  if (act === 'rp-print') return print();
  if (act === 'rp-xero-build') return xeroBuild();
  if (act === 'rp-xero-csv') { if (rp.xeroCsv) download(rp.xeroCsv, 'xero-journal-' + entityId() + '-' + rp.xeroDate + '.csv'); return; }
  if (act === 'rp-xero-push') return xeroPush();
  if (act === 'rp-xero-connect') return xeroConnect();
  if (act === 'rp-xero-disconnect') { if (!confirm('Disconnect Xero for this company?')) return; try { await auth.api('disconnect', { entityId: entityId() }, API.xero); rp.xeroStatus = null; await xeroStatus(); } catch (e) { toast(e.message, 'warn'); } return; }
}
async function run() {
  readFilters(); rp.busy = true; rp.result = null; ctx.repaint();
  try { rp.result = await auth.api('run', { report: rp.report, entityId: entityId(), storeId: rp.storeId, from: rp.from, to: rp.to, staffUid: rp.staffUid, channel: rp.channel, days: rp.days, tzOffsetMin: new Date().getTimezoneOffset() }, API.report); }
  catch (e) { toast(e.message, 'warn'); }
  rp.busy = false; ctx.repaint();
}
function csv() {
  const r = rp.result; if (!r) return;
  const rows = [r.columns.map(c => c.label), ...r.rows.map(x => r.columns.map(c => raw(x[c.key], c.type)))];
  if (r.totals) rows.push(r.columns.map((c, i) => r.totals[c.key] == null ? (i === 0 ? 'Total' : '') : raw(r.totals[c.key], c.type)));
  download(toCsv(rows), `${rp.report}-${entityId()}${rp.storeId ? '-' + rp.storeId : ''}-${r.from}-${r.to}.csv`);
  if (r.detail) download(toCsv([Object.keys(r.detail[0] || {}), ...r.detail.map(x => Object.values(x).map(v => typeof v === 'number' && /cost|value/.test(Object.keys(x)[Object.values(x).indexOf(v)] || '') ? (v / 100).toFixed(2) : v))]), `${rp.report}-detail-${entityId()}-${r.from}.csv`);
}
function print() {
  const r = rp.result; if (!r) return;
  const dd = d(); const ent = myEntities().find(e => e.id === entityId()) || {};
  openPrint(r.title, `<div class="a4"><div class="head"><div class="co">${esc(ent.tradingName || ent.legalName || '')}</div><div class="doc"><div class="t">${esc(r.title)}</div><div>${esc(niceDate(r.from))}${r.to !== r.from ? ' – ' + esc(niceDate(r.to)) : ''}${rp.storeId ? ' · ' + esc(((dd.stores || []).find(s => s.id === rp.storeId) || {}).name || '') : ' · all stores'}</div><div class="s">Run ${esc(niceDate(r.at))} ${esc(niceTime(r.at))} by ${esc(auth.session.user.name)}</div></div></div>
    <table><thead><tr>${r.columns.map(c => `<th class="${/cents|int|pct/.test(c.type) ? 'n' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${r.rows.map(x => `<tr>${r.columns.map(c => `<td class="${/cents|int|pct/.test(c.type) ? 'n' : ''}">${esc(fmt(x[c.key], c.type))}</td>`).join('')}</tr>`).join('')}</tbody>${r.totals ? `<tfoot><tr class="tot">${r.columns.map((c, i) => `<td class="${/cents|int|pct/.test(c.type) ? 'n' : ''}">${i === 0 && r.totals[c.key] == null ? 'Total' : esc(r.totals[c.key] == null ? '' : fmt(r.totals[c.key], c.type))}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`, A4_CSS + ' @page { size: A4 landscape; } .a4 { max-width: 270mm; font-size: 10.5px; } .a4 td, .a4 th { padding: 3px 4px; }');
}
async function xeroStatus() { try { rp.xeroStatus = await auth.api('status', { entityId: entityId() }, API.xero); } catch (e) { rp.xeroStatus = { connected: false, configured: false, lastError: e.message }; } ctx.repaint(); }
async function xeroBuild() {
  readFilters();
  try { const r = await auth.api('build', { entityId: entityId(), date: rp.xeroDate }, API.xero); rp.xero = r.journal; rp.xeroCsv = r.csv; rp.xeroLabels = r.labels; if (!rp.xeroStatus) await xeroStatus(); toast(r.journal.lines.length ? 'Journal built: ' + money(r.journal.debitsCents) + ' each side' : 'No sales that day'); }
  catch (e) { toast(e.message, 'warn'); }
  ctx.repaint();
}
async function xeroPush() {
  if (!rp.xero) return;
  try { const r = await auth.api('push', { entityId: entityId(), date: rp.xeroDate }, API.xero); rp.xero = r.journal; toast('Posted to Xero'); await xeroStatus(); }
  catch (e) { toast(e.message, 'warn'); await xeroBuild(); }
}
async function xeroConnect() {
  try { const r = await auth.api('connectUrl', { entityId: entityId() }, API.xero); window.open(r.url, '_blank'); toast('Finish in the Xero tab, then come back and build the journal'); }
  catch (e) { toast(e.message, 'warn'); }
}

// ------------------------------------------------------------ dashboard --
export async function dashboardHtml(host) {
  if (!auth.atLeast('manager')) return;
  const el = host.querySelector('#dash'); if (!el) return;
  try {
    const r = await auth.api('dashboard', {}, API.report);
    const delta = (a, b) => b ? Math.round((a - b) / b * 100) : (a ? 100 : 0);
    const chip = (a, b) => { const p = delta(a, b); return `<span class="dash-delta ${p > 0 ? 'up' : p < 0 ? 'down' : ''}">${p > 0 ? '▲' : p < 0 ? '▼' : '•'} ${Math.abs(p)}%</span>`; };
    const card = (title, t, l, extra = '') => `<div class="card dash-card"><h3>${esc(title)}</h3><div class="dash-big">${esc(money(t.net))} ${chip(t.net, l.net)}</div><div class="muted">${t.sales} sale${t.sales === 1 ? '' : 's'} · basket ${esc(money(t.basket))}${t.refunds ? ' · refunds ' + esc(money(t.refunds)) : ''}</div><div class="muted">Same day last week: ${esc(money(l.net))} · ${l.sales} sale${l.sales === 1 ? '' : 's'}</div>${extra}</div>`;
    el.innerHTML = `<h2 class="dash-h2">Today, ${esc(niceDate(r.day))}, against ${esc(niceDate(r.lastWeek))}</h2><div class="dash-grid">${r.stores.length > 1 ? card('All stores', r.all.today, r.all.lastWeek) : ''}${r.stores.map(s => card(s.store + (r.stores.some(x => x.entityId !== s.entityId) ? ' · ' + s.entity : ''), s.today, s.lastWeek, s.openLaybys ? `<div class="muted">${s.openLaybys} open lay-by${s.openLaybys === 1 ? '' : 's'} · ${esc(money(s.laybyBalance))} to come</div>` : '')).join('')}</div>`;
  } catch (e) { el.innerHTML = `<p class="muted">The dashboard could not load: ${esc(e.message)}</p>`; }
}
