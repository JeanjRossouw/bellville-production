// Factory floor — the week planner, fabric watch-list and printable job
// cards. Everything here is a view over the orders collection; it adds two
// field to an order: planWeek (the Monday of the week it is built).
import * as store from './store.js';
import { allOrders, orderById, setStatus } from './orders.js';
import { esc, money, today, isoLocal, niceDate, daysUntil, statusChip, statusMeta, fabricChip, FABRIC_STATES, openModal, toast, empty, field, val, docHeader } from './ui.js';
import { qrSvg, scanUrl } from './qr.js';

let settings = {};
export const setFloorSettings = (cfg) => { settings = cfg || {}; };

let floorView = 'planner';   // planner | fabric

// --------------------------------------------------------------- weeks ------

export function mondayOf(iso) {
  const d = new Date((iso || today()) + 'T12:00:00');
  if (isNaN(d.getTime())) return mondayOf(today());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoLocal(d);
}
const plusDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); };

export function weeks(count) {
  const start = mondayOf(today());
  const out = [];
  for (let i = 0; i < (count || 4); i++) {
    const mon = plusDays(start, i * 7);
    out.push({
      mon,
      title: i === 0 ? 'This week' : i === 1 ? 'Next week' : 'Week of ' + niceDate(mon).replace(/ \d{4}$/, ''),
      range: niceDate(mon).replace(/ \d{4}$/, '') + ' – ' + niceDate(plusDays(mon, 6)).replace(/ \d{4}$/, '')
    });
  }
  return out;
}

// On the floor: being built, or waiting to be. A piece marked Done leaves
// the floor at once; it is then on Deliveries and Scan out, waiting to go.
const onFloor = (o) => o.status === 'new' || o.status === 'in-production';

// Which column an order sits in: a week Monday, 'later', or 'pool'.
function bucketOf(o, wks) {
  if (!o.planWeek) return 'pool';
  if (o.planWeek < wks[0].mon) return 'pool';           // a past week — needs re-planning
  if (wks.some(w => w.mon === o.planWeek)) return o.planWeek;
  return 'later';
}

// ------------------------------------------------------------- mutations ----

export async function setPlanWeek(id, mon) {
  const o = orderById(id);
  if (!o) return;
  await store.update('orders', id, { planWeek: mon || '' },
    mon ? 'Planned for the week of ' + niceDate(mon) : 'Taken off the planner');
}

export async function startBuild(id) {
  await setStatus(id, 'in-production');
}

export function moveMenu(id) {
  const o = orderById(id);
  if (!o) return;
  const wks = weeks(6);
  const btn = (label, mon, on) => `<button class="btn ${on ? 'primary' : 'ghost'} wide" data-move="${esc(mon)}" style="margin-bottom:.4rem">${esc(label)}${on ? ' ✓' : ''}</button>`;
  const m = openModal('Move ' + (o.orderNo || 'order'),
    wks.map(w => btn(w.title + ' · ' + w.range, w.mon, o.planWeek === w.mon)).join('') +
    `<div class="fld" style="margin-top:.6rem"><span>Another week (pick any date in it)</span><input type="date" id="mv-date"></div>` +
    btn('Take off the planner (unscheduled)', '', !o.planWeek),
    { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  m.wrap.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', async () => {
    await setPlanWeek(id, b.dataset.move);
    m.close();
  }));
  const dt = m.wrap.querySelector('#mv-date');
  dt.addEventListener('change', async () => { if (dt.value) { await setPlanWeek(id, mondayOf(dt.value)); m.close(); } });
}

// ----------------------------------------------------------------- cards ----

function dueBadge(o) {
  const d = daysUntil(o.dueDate);
  if (d == null) return '';
  if (d < 0) return `<span class="chip late">${Math.abs(d)}d late</span>`;
  if (d <= 7) return `<span class="chip soon">${d === 0 ? 'today' : d + 'd'}</span>`;
  return `<span class="chip calm">${esc(niceDate(o.dueDate).replace(/ \d{4}$/, ''))}</span>`;
}

function planCard(o) {
  const waiting = o.fabric && o.fabricStatus !== 'received';
  return `
    <div class="pcard ${waiting ? 'waiting' : ''}" draggable="true" data-drag="${esc(o.id)}">
      <div class="pcard-top">
        <span class="pcard-no">${esc(o.orderNo || '')}</span>
        ${dueBadge(o)}
      </div>
      <div class="pcard-prod">${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</div>
      <div class="pcard-meta">${esc(o.customerName || '')}${o.fabric ? ' · ' + esc(o.fabric) : ''}</div>
      <div class="pcard-chips">
        ${o.fabric ? fabricChip(o.fabricStatus) : ''}
        ${o.status === 'ready' ? statusChip('ready') : ''}
      </div>
      <div class="pcard-controls">
        ${o.status === 'new' ? `<button class="btn ghost sm" data-act="start" data-id="${esc(o.id)}" title="The floor has started on it">In production</button>` : ''}
      </div>
      <div class="pcard-actions">
        ${o.status !== 'ready' ? `<button class="btn primary sm" data-act="mark-ready" data-id="${esc(o.id)}">Done</button>` : ''}
        <button class="btn ghost sm" data-act="print-job" data-id="${esc(o.id)}" title="Print job card">Print</button>
        <button class="btn ghost sm" data-act="plan-move" data-id="${esc(o.id)}" title="Move to another week">⋮</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- render ----

export function setFloorView(v) { floorView = v; }

export function renderFloor(host, overviewHtml) {
  const rows = allOrders().filter(onFloor);
  const tab = (key, label) => `<button class="btn ${floorView === key ? 'primary' : 'ghost'} sm" data-act="floor-view" data-to="${key}">${label}</button>`;
  let body = '';
  if (floorView === 'planner') body = plannerHtml(rows);
  else body = fabricHtml(rows);

  host.innerHTML = `
    <div class="page-head">
      <div><h1>Factory floor</h1><p class="sub">${rows.length} piece${rows.length === 1 ? '' : 's'} on the floor</p></div>
      <div class="btn-row">
        <button class="btn ghost" data-act="print-planner">Planner</button>
        <button class="btn ghost" data-act="print-week-jobs">This week's job cards</button>
        ${store.can('profit') ? '<button class="btn ghost" data-act="print-week-report" title="What the week produced, against the target">Week’s production</button>' : ''}
      </div>
    </div>
    ${overviewHtml || ''}
    ${weekStrip()}
    <div class="btn-row" style="margin-bottom:.9rem">${tab('planner', 'Planner')}${tab('fabric', 'Fabric')}</div>
    ${body}`;
  wireDragDrop(host);
}

function plannerHtml(rows) {
  const wks = weeks(4);
  const by = { pool: [], later: [] };
  wks.forEach(w => { by[w.mon] = []; });
  rows.forEach(o => by[bucketOf(o, wks)].push(o));
  const sortCards = (arr) => arr.sort((a, b) => String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  Object.keys(by).forEach(k => sortCards(by[k]));
  const col = (key, title, sub, items, cls) => `
    <div class="pcol ${cls || ''}" data-drop="${esc(key)}">
      <div class="pcol-head"><div class="pcol-title">${esc(title)}</div><div class="pcol-sub">${esc(sub)}</div></div>
      <div class="pcol-body">${items.map(planCard).join('') || '<div class="pcol-empty">Drop orders here</div>'}</div>
    </div>`;
  return `
    <p class="muted" style="margin:-.3rem 0 .7rem">Drag an order into the week it gets built, or tap ⋮ on a phone.</p>
    <div class="pgrid">
      ${wks.map((w, i) => col(w.mon, w.title, w.range + ' · ' + by[w.mon].length, by[w.mon], i === 0 ? 'current' : '')).join('')}
    </div>
    ${by.later.length ? `<div class="card" style="margin-top:1rem"><h2>Later (${by.later.length})</h2><div class="ppool">${by.later.map(planCard).join('')}</div></div>` : ''}
    <div class="card pool" data-drop="" style="margin-top:1rem">
      <h2>Unscheduled (${by.pool.length})</h2>
      <p class="muted">Not yet given a week, or planned for a week that has passed.</p>
      <div class="ppool">${by.pool.map(planCard).join('') || '<div class="pcol-empty">Everything is planned</div>'}</div>
    </div>`;
}

function fabricHtml(rows) {
  const waiting = rows.filter(o => o.fabric && o.fabricStatus !== 'received')
    .sort((a, b) => String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  if (!waiting.length) return empty('', 'No fabric outstanding', 'Every order on the floor has its fabric in.');
  return `
    <p class="muted" style="margin:-.3rem 0 .7rem">Pieces that cannot be finished until fabric arrives, soonest due first.</p>
    <div class="card">
      <table class="tbl">
        <thead><tr><th>Order</th><th>Product</th><th>Customer</th><th>Fabric</th><th>Due</th><th>Fabric status</th></tr></thead>
        <tbody>${waiting.map(o => `<tr>
          <td><strong>${esc(o.orderNo || '')}</strong></td>
          <td>${esc(o.product || '')}</td>
          <td>${esc(o.customerName || '')}</td>
          <td>${esc(o.fabric || '')}</td>
          <td>${dueBadge(o)}</td>
          <td><select data-act="fabric" data-id="${esc(o.id)}">${FABRIC_STATES.map(f => `<option value="${f.key}"${f.key === (o.fabricStatus || 'none') ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}</select></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

// ------------------------------------------------------------ drag & drop ---

function wireDragDrop(host) {
  host.querySelectorAll('[data-drag]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      try { e.dataTransfer.setData('text/plain', el.dataset.drag); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  host.querySelectorAll('[data-drop]').forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault(); col.classList.remove('over');
      let id = ''; try { id = e.dataTransfer.getData('text/plain'); } catch (x) {}
      if (!id) return;
      await setPlanWeek(id, col.dataset.drop);
    });
  });
}

// ---------------------------------------------------------------- printing --

const PRINT_CSS = `
  * { box-sizing: border-box; } body { font: 12px/1.4 Arial, Helvetica, sans-serif; color: #000; margin: 0; padding: 14px; }
  .no-print { margin-bottom: 12px; } @media print { .no-print { display: none; } .page { page-break-after: always; } .page:last-child { page-break-after: auto; } }
  .page { padding: 4px 0 18px; }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #000; padding-bottom: 8px; margin-bottom: 12px; }
  .hd-r { display: flex; gap: 14px; align-items: flex-start; } .qr svg { width: 100%; height: 100%; display: block; } .qr-wrap { text-align: center; } .qr-wrap small { display: block; font-size: 8.5px; color: #444; letter-spacing: .04em; margin-top: 2px; }
  .co { font-size: 20px; font-weight: 900; letter-spacing: .08em; } .co small { display: block; font-size: 10px; font-weight: 400; letter-spacing: .12em; color: #444; }
  .jc { text-align: right; } .jc .t { font-size: 11px; letter-spacing: .14em; color: #444; } .jc .n { font-size: 30px; font-weight: 900; line-height: 1; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #000; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eee; width: 26%; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  .big { font-size: 18px; font-weight: 800; }
  .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
  .sg { border: 1px solid #000; padding: 8px; min-height: 60px; } .sg b { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 18px; }
  .sg .ln { border-bottom: 1px solid #000; height: 16px; } .sg small { color: #444; font-size: 9px; }
  .notes { border: 1px solid #000; padding: 8px; min-height: 60px; margin-top: 12px; white-space: pre-wrap; }
  .ft { margin-top: 10px; font-size: 10px; color: #444; display: flex; justify-content: space-between; }
  .pl th { width: auto; } .pl td { font-size: 11px; } .pl h2 { font-size: 13px; margin: 14px 0 4px; border-bottom: 2px solid #000; }
`;

function openPrint(title, body) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
    <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:800;background:#000;color:#fff;border:0;cursor:pointer">PRINT</button>
    <button onclick="window.close()" style="padding:8px 16px;margin-left:8px;cursor:pointer">CLOSE</button></div>${body}</body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html);
  win.document.close();
}

// No prices on a job card: it goes to the floor.
function jobCardHtml(o) {
  const fab = o.fabric ? (FABRIC_STATES.find(f => f.key === o.fabricStatus) || FABRIC_STATES[0]).label : '';
  return `<div class="page">
    <div class="hd">
      <div class="co">${esc((settings.name || 'COUCH POTATO').toUpperCase())}<small>${esc([settings.phone, settings.email].filter(Boolean).join(' · ') || 'FACTORY JOB CARD')}</small></div>
      <div class="hd-r">
        <div class="jc"><div class="t">JOB CARD</div><div class="n">${esc(o.orderNo || '')}</div></div>
        <div class="qr-wrap">${qrSvg(scanUrl(o.id), 92)}<small>SCAN AT THE DOOR</small></div>
      </div>
    </div>
    <table>
      <tr><th>Product</th><td class="big">${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</td></tr>
      <tr><th>Customer</th><td>${esc(o.customerName || '')}${o.externalRef ? ' &nbsp;·&nbsp; their ref <b>' + esc(o.externalRef) + '</b>' : ''}</td></tr>
      <tr><th>Fabric</th><td>${o.fabric ? '<b>' + esc(o.fabric) + '</b> &nbsp;·&nbsp; ' + esc(fab) : '<i>none</i>'}</td></tr>
      <tr><th>Due out</th><td class="big">${esc(niceDate(o.dueDate) || '—')}</td></tr>
      <tr><th>Planned week</th><td>${o.planWeek ? 'Week of ' + esc(niceDate(o.planWeek)) : '<i>not planned</i>'}</td></tr>
    </table>
    <div class="sign">
      ${['Built by', 'Checked by', 'Dispatched by'].map(l => `<div class="sg"><b>${l}</b><div class="ln"></div><small>name / date</small></div>`).join('')}
    </div>
    <div class="notes"><b>Notes</b><br>${esc(o.notes || '')}</div>
    <div class="ft"><span>Order placed ${esc(niceDate(o.paidDate || o.createdAt))}</span><span>Printed ${esc(niceDate(today()))}</span></div>
  </div>`;
}

// ------------------------------------------------ the week's production ----
// What the week produced against the owner's target. Finished = marked Done
// (or straight out of the door) in that week; planned = on that week's
// planner. Values are the orders' prices (incl. VAT). Money roles only.

const valueOf = (o) => (Number(o.priceEach) || 0) * (Number(o.qty) || 1);
// the day a piece was finished: readyAt, else its Done step, else when it left
export function finishedOn(o) {
  if (o.readyAt) return String(o.readyAt).slice(0, 10);
  const ev = (o.events || []).filter(e => /Moved to Done/.test(e.what || '')).pop();
  if (ev && ev.at) return String(ev.at).slice(0, 10);
  if ((o.status === 'dispatched' || o.status === 'invoiced') && o.dispatchedAt) return String(o.dispatchedAt).slice(0, 10);
  return '';
}
export function weekFigures(mon) {
  const sun = plusDays(mon, 6);
  const inWeek = (d) => d && d >= mon && d <= sun;
  const rows = allOrders().filter(o => o.status !== 'cancelled');
  const finished = rows.filter(o => inWeek(finishedOn(o)));
  const planned = rows.filter(o => o.planWeek === mon);
  const open = planned.filter(o => !finished.includes(o) && (o.status === 'new' || o.status === 'in-production'));
  const out = rows.filter(o => inWeek(String(o.dispatchedAt || '').slice(0, 10)));
  const sum = (a) => a.reduce((t, o) => t + valueOf(o), 0);
  const target = Number(settings.weeklyTarget) || 0;
  const finishedValue = sum(finished);
  return { mon, sun, target, finished, planned, open, out, finishedValue, plannedValue: sum(planned), openValue: sum(open), outValue: sum(out), pct: target ? Math.round(finishedValue / target * 100) : null };
}
function weekStrip() {
  if (!store.can('profit')) return '';
  const f = weekFigures(mondayOf(today()));
  const cur = settings.currency || 'R';
  const cls = f.target ? (f.finishedValue >= f.target ? 'green' : f.pct >= 70 ? 'amber' : 'red') : '';
  const tile = (n, label, c) => `<div class="tile ${c || ''}"><div class="tile-n">${n}</div><div class="tile-l">${label}</div></div>`;
  return `<div class="tiles week-strip">
    ${tile(esc(money(f.finishedValue, cur)), 'Finished this week · ' + f.finished.length + ' piece' + (f.finished.length === 1 ? '' : 's'))}
    ${tile(f.target ? f.pct + '%' : '—', f.target ? 'of the ' + esc(money(f.target, cur)) + ' weekly target' : 'No weekly target yet (Settings)', cls)}
    ${tile(esc(money(f.openValue, cur)), 'Planned this week, still to finish · ' + f.open.length)}
    ${tile(esc(money(f.outValue, cur)), 'Left the factory this week · ' + f.out.length)}
  </div>`;
}
export function weekReportDialog() {
  if (!store.can('profit')) { toast('Your role cannot see the money side', 'warn'); return; }
  const start = mondayOf(today());
  const short = (d) => niceDate(d).replace(/ \d{4}$/, '');
  const choices = [];
  for (let i = 1; i >= -8; i--) {
    const mon = plusDays(start, i * 7);
    choices.push({ value: mon, label: (i === 1 ? 'Next week' : i === 0 ? 'This week' : i === -1 ? 'Last week' : 'Week of ' + short(mon)) + ' · ' + short(mon) + ' – ' + short(plusDays(mon, 6)) });
  }
  openModal('The week’s production', field('Week', 'wr-week', { type: 'select', value: start, options: choices })
    + '<p class="muted">What was finished that week against the weekly target (Settings → Numbering and terms), what was planned but not finished, and what left the factory.</p>',
    { okLabel: 'Print', onOk: (w) => { printWeekReport(val(w, 'wr-week') || start); } });
}
export function printWeekReport(mon) {
  const f = weekFigures(mon);
  const cur = settings.currency || 'R';
  const range = niceDate(mon) + ' – ' + niceDate(f.sun);
  const line = (o, extra) => `<tr><td><b>${esc(o.orderNo || '')}</b></td><td>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</td><td>${esc(o.customerName || '')}</td><td>${extra}</td><td style="text-align:right">${esc(money(valueOf(o), cur))}</td></tr>`;
  const table = (items, col, extra, total) => items.length
    ? `<table class="pl"><tr><th>Order</th><th>Product</th><th>Customer</th><th>${col}</th><th style="text-align:right">Value</th></tr>${items.map(o => line(o, extra(o))).join('')}
       <tr><td colspan="4" style="text-align:right"><b>Total</b></td><td style="text-align:right"><b>${esc(money(total, cur))}</b></td></tr></table>`
    : '<p><i>None</i></p>';
  const verdict = !f.target ? 'No weekly target set' : f.finishedValue >= f.target ? 'Target met: ' + f.pct + '%' : f.pct + '% of target, short by ' + money(f.target - f.finishedValue, cur);
  const body = `<div class="page">
    ${docHeader(settings, 'WEEK’S PRODUCTION', range, [verdict])}
    <table class="pl"><tr><th>Target</th><th>Finished</th><th>Of target</th><th>Planned for the week</th><th>Planned, not finished</th><th>Left the factory</th></tr>
      <tr><td>${f.target ? esc(money(f.target, cur)) : '—'}</td><td>${esc(money(f.finishedValue, cur))} · ${f.finished.length}</td><td><b>${f.pct == null ? '—' : f.pct + '%'}</b></td>
      <td>${esc(money(f.plannedValue, cur))} · ${f.planned.length}</td><td>${esc(money(f.openValue, cur))} · ${f.open.length}</td><td>${esc(money(f.outValue, cur))} · ${f.out.length}</td></tr></table>
    <h2>Finished this week (${f.finished.length})</h2>${table(f.finished, 'Finished', o => esc(niceDate(finishedOn(o))), f.finishedValue)}
    <h2>Planned for this week, not finished (${f.open.length})</h2>${table(f.open, 'Status', o => esc(statusMeta(o.status).label) + (o.dueDate ? ' · due ' + esc(niceDate(o.dueDate)) : ''), f.openValue)}
    <h2>Left the factory this week (${f.out.length})</h2>${table(f.out, 'Out', o => esc(niceDate(String(o.dispatchedAt).slice(0, 10))), f.outValue)}
  </div>`;
  openPrint('Week’s production ' + mon, body);
}

export function printJobCard(id) {
  const o = orderById(id);
  if (!o) return;
  openPrint('Job card ' + (o.orderNo || ''), jobCardHtml(o));
}

export function printWeekJobCards() {
  const wk = weeks(1)[0];
  const items = allOrders().filter(o => onFloor(o) && o.planWeek === wk.mon)
    .sort((a, b) => String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  if (!items.length) { toast('Nothing is planned for this week yet', 'warn'); return; }
  openPrint('Job cards — ' + wk.title, items.map(jobCardHtml).join(''));
}

export function printPlanner() {
  const wks = weeks(4);
  const rows = allOrders().filter(onFloor);
  const by = { pool: [] };
  wks.forEach(w => { by[w.mon] = []; });
  rows.forEach(o => { const b = bucketOf(o, wks); (by[b] = by[b] || []).push(o); });
  const table = (items) => items.length
    ? `<table class="pl"><tr><th>Order</th><th>Product</th><th>Customer</th><th>Fabric</th><th>Due</th></tr>
       ${items.map(o => `<tr><td><b>${esc(o.orderNo || '')}</b></td><td>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</td><td>${esc(o.customerName || '')}</td>
         <td>${esc(o.fabric || '')}${o.fabric && o.fabricStatus !== 'received' ? ' <b>(' + esc((FABRIC_STATES.find(f => f.key === o.fabricStatus) || FABRIC_STATES[0]).label) + ')</b>' : ''}</td>
         <td>${esc(niceDate(o.dueDate))}</td></tr>`).join('')}</table>`
    : '<p><i>Nothing planned</i></p>';
  const body = `<div class="page">
    <div class="hd"><div class="co">${esc((settings.name || 'COUCH POTATO').toUpperCase())}<small>PRODUCTION PLANNER</small></div>
    <div class="jc"><div class="t">PRINTED</div><div class="n" style="font-size:16px">${esc(niceDate(today()))}</div></div></div>
    ${wks.map(w => `<h2>${esc(w.title)} — ${esc(w.range)} (${by[w.mon].length})</h2>${table(by[w.mon])}`).join('')}
    ${by.later && by.later.length ? `<h2>Later (${by.later.length})</h2>${table(by.later)}` : ''}
    <h2>Unscheduled (${by.pool.length})</h2>${table(by.pool)}
  </div>`;
  openPrint('Planner', body);
}
