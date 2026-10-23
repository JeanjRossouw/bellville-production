// The station tablet and the floor board.
//
// Station tablet (Production → Station tablet, or /app/?station=1 on the
// tablet at the station): pick the station once, then each person taps their
// name and taps Start, Pause or Done. Big buttons, two taps per action, and
// it goes back to the names by itself, so the next person can use it. Starting
// a job clocks a person in if they were not; one job at a time each.
//
// Floor board (Factory floor → Board, or /app/?board=1 on the TV): every
// station as a column with its jobs, who is on each and for how long, late
// orders in bold, and who is clocked in but not on a job. Managers also see
// each person's time today: clocked in, on jobs, idle.
import * as store from './store.js';
import { orderById } from './orders.js';
import { allWorkstations, workstationById, hm } from './routing.js';
import { openCards, cardsAt, cardById, peopleOn, runningFor, pauseFor, runningEntries, startCard, pauseCard, doneCard, failCheck, earlierSteps,
  PAUSE_REASONS, cardMinutes, timeToday, statusLabel, setRosterNames, issuesFor, recordIssues, VARIANCE_REASONS } from './jobs.js';
import { allMaterials } from './costing.js';
import { rosterPeople, isClockedIn, clockIn, clockOut } from './today.js';
import { nameOf } from './clientgroups.js';
import { esc, toast, today, daysUntil, niceDate } from './ui.js';

const KEY = 'cp-station';
const urlStation = new URLSearchParams(location.search).get('station') || '';
let stationId = (urlStation && urlStation !== '1') ? urlStation : (() => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } })();
let personId = '';
let mode = '';            // '' | 'pause' | 'done' | 'fail'
let failSteps = null;
let doneIssues = null;    // the step's materials as issued, while Done is open
let idleTimer = null;
let repaint = () => {};
export const setStationRepaint = (fn) => { repaint = fn; };
// a note or a count being typed: a change elsewhere on the floor waits
export const stationBusy = () => mode === 'done' || mode === 'fail';

// ---- the running clocks: one ticker for every timer on the page
const clock = (iso) => { const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
setInterval(() => { document.querySelectorAll('[data-since]').forEach(el => { el.textContent = clock(el.dataset.since); }); }, 1000);
const since = (iso, cls) => `<span class="${cls || 'st-timer'}" data-since="${esc(iso)}">${esc(clock(iso))}</span>`;

const people = () => { const p = rosterPeople(); setRosterNames(p); return p; };
const personById = (id) => people().find(p => p.id === id) || null;
const mayWork = () => store.can('factory', 'edit');
const late = (o) => !!o && o.dueDate && daysUntil(o.dueDate) < 0;

// back to the names after a minute untouched, so a tablet is never left on someone
function touch() {
  clearTimeout(idleTimer);
  if (personId) idleTimer = setTimeout(() => { personId = ''; mode = ''; repaint(); }, 60000);
}
function backToNames(msg) { personId = ''; mode = ''; failSteps = null; doneIssues = null; if (msg) toast(msg); repaint(); }

// The materials on Done: as issued when the step started, to correct. More
// than planned needs a reason; one not on the list can be added.
const whyOptions = (sel) => `<option value="">${'why, if it changed'}</option>` + VARIANCE_REASONS.map(r => `<option${r === sel ? ' selected' : ''}>${esc(r)}</option>`).join('');
const extraRow = () => `<div class="st-mat st-extra"><select class="st-x-mat"><option value="">— material —</option>${allMaterials().map(m => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.unit)})</option>`).join('')}</select>
  <input type="number" class="st-mat-qty" step="0.01" min="0" placeholder="qty" inputmode="decimal"><select class="st-mat-why">${whyOptions('')}</select></div>`;
function matsHtml() {
  if (doneIssues == null) return '<p class="muted">Reading the materials…</p>';
  return `<div class="st-mats">${doneIssues.map(i => `<div class="st-mat" data-iss="${esc(i.id)}"><span class="st-mat-name">${esc(i.name)}<small>planned ${esc(i.plannedQty)} ${esc(i.unit)}${i.extra ? ' · extra' : ''}</small></span>
      <input type="number" class="st-mat-qty" step="0.01" min="0" value="${esc(i.qty)}" inputmode="decimal"><select class="st-mat-why">${whyOptions(i.varianceReason)}</select></div>`).join('')}
    <div id="st-extras"></div></div>
    <button class="btn ghost" data-act="st-extra" type="button">＋ A material not on the list</button>`;
}
function readMats() {
  const changes = [], extras = [];
  for (const row of document.querySelectorAll('.st-mat[data-iss]')) {
    const i = (doneIssues || []).find(x => x.id === row.dataset.iss); if (!i) continue;
    const qty = parseFloat(row.querySelector('.st-mat-qty').value), reason = row.querySelector('.st-mat-why').value;
    if (isNaN(qty) || qty < 0) return { error: 'Put in how much ' + i.name + ' was used' };
    if (qty > (Number(i.plannedQty) || 0) + 1e-9 && !reason) return { error: 'More ' + i.name + ' than planned: say why' };
    if (qty !== Number(i.qty) || reason !== (i.varianceReason || '')) changes.push({ id: i.id, materialId: i.materialId, qty, was: Number(i.qty) || 0, unitCost: Number(i.unitCostAtTime) || 0, reason, wasReason: i.varianceReason || '' });
  }
  for (const row of document.querySelectorAll('.st-mat.st-extra')) {
    const materialId = row.querySelector('.st-x-mat').value, qty = parseFloat(row.querySelector('.st-mat-qty').value) || 0, reason = row.querySelector('.st-mat-why').value;
    if (!materialId || !qty) continue;
    if (!reason) return { error: 'Say why the extra material was used' };
    extras.push({ materialId, qty, reason });
  }
  return { changes, extras };
}

// ------------------------------------------------------------ tablet ----

function jobCard(c, opts) {
  const o = orderById(c.orderId) || {};
  const on = peopleOn(c.id);
  const due = o.dueDate ? (daysUntil(o.dueDate) < 0 ? `<span class="chip late">${-daysUntil(o.dueDate)}d late</span>` : `<span class="chip calm">due ${esc(niceDate(o.dueDate).replace(/ \d{4}$/, ''))}</span>`) : '';
  return `<div class="st-job ${c.isRework ? 'rework' : ''} ${late(o) ? 'late' : ''}">
    <div class="st-job-top"><span class="st-no">${esc(c.orderNo || o.orderNo || '')}</span>${due}${c.isRework ? '<span class="chip late">rework</span>' : ''}${c.qc ? '<span class="chip">check</span>' : ''}</div>
    <div class="st-product">${esc(c.product || o.product || '')}${Number(c.qty) > 1 ? ' × ' + esc(c.qty) : ''}</div>
    <div class="st-step">${esc(c.operationName)}${c.stdMinutes ? ' · ' + esc(hm(c.stdMinutes)) : ''}${Number(c.qtyDone) ? ' · ' + esc(c.qtyDone) + ' of ' + esc(c.qty) + ' done' : ''}</div>
    ${(c.fabric || o.fabric) ? `<div class="st-meta">Fabric: <strong>${esc(c.fabric || o.fabric)}</strong></div>` : ''}
    ${o.id ? `<div class="st-meta">${esc(nameOf(o))}</div>` : ''}
    ${o.notes ? `<div class="st-note">${esc(o.notes)}</div>` : ''}
    ${c.note && c.isRework ? `<div class="st-note">Sent back: ${esc(c.note)}</div>` : ''}
    ${c.status === 'paused' && c.lastPause ? `<div class="st-meta">Paused: ${esc(c.lastPause)}</div>` : ''}
    ${on.length ? `<div class="st-meta">On it: ${on.map(p => esc(p.name) + ' ' + since(p.since, 'st-mini')).join(', ')}</div>` : ''}
    ${opts && opts.start ? `<button class="btn primary st-big" data-act="st-start" data-id="${esc(c.id)}">${c.status === 'paused' || on.length ? 'Join / carry on' : 'Start'}</button>` : ''}
  </div>`;
}

function pickerHtml() {
  const ws = allWorkstations();
  if (!ws.length) return `<div class="page-head"><div><h1>Station tablet</h1></div></div><div class="card"><p>No workstations yet. ${store.can('costing') ? 'Set them up under Costing → Workstations & steps, and give each product its steps.' : 'The owner sets them up under Costing.'}</p></div>`;
  return `<div class="page-head"><div><h1>Which station is this tablet at?</h1><p class="sub">Picked once; the tablet remembers it. On another tablet, open this screen and pick its station.</p></div></div>
    <div class="st-grid">${ws.map(w => { const here = cardsAt(w.id), ready = here.filter(c => c.status === 'ready' || c.status === 'paused').length, on = runningEntries().filter(e => e.kind === 'work' && e.workstationId === w.id).length;
      return `<button class="st-pick" data-act="st-station" data-id="${esc(w.id)}"><strong>${esc(w.name)}</strong><span>${ready} ready${on ? ' · ' + on + ' on a job' : ''}</span></button>`; }).join('')}</div>`;
}

function namesHtml(ws) {
  const list = people();
  const here = cardsAt(ws.id);
  const onNow = runningEntries().filter(e => e.kind === 'work' && e.workstationId === ws.id);
  const ready = here.filter(c => c.status === 'ready' || c.status === 'paused' || c.status === 'running');
  const coming = here.filter(c => c.status === 'waiting' && !c.waitingOn);
  const names = !list.length ? `<p class="muted">No names yet. ${store.can('wages') ? 'Add your staff under Money → Wages; they appear here.' : 'The owner adds staff under Wages; they appear here.'}</p>`
    : `<div class="st-names">${list.map(p => {
        const r = runningFor(p.id), pz = pauseFor(p.id), c = r && cardById(r.jobCardId), inNow = isClockedIn(p.id);
        return `<button class="st-name ${r ? 'busy' : ''} ${inNow ? '' : 'out'}" data-act="st-person" data-id="${esc(p.id)}"><strong>${esc(p.name)}</strong>
          <span>${r ? esc((c && c.orderNo) || '') + ' ' + esc((c && c.operationName) || '') + ' ' + since(r.start, 'st-mini') : pz ? 'paused: ' + esc(pz.pauseReason || '') : inNow ? 'not on a job' : 'not clocked in'}</span></button>`; }).join('')}</div>`;
  return `<div class="st-bar"><div><span class="st-where">${esc(ws.name)}</span><span class="muted"> · ${ready.length} job${ready.length === 1 ? '' : 's'} here${onNow.length ? ' · ' + onNow.length + ' on a job' : ''}</span></div>
      <button class="btn ghost sm" data-act="st-change">Change station</button></div>
    <h2 class="st-h">Tap your name</h2>${names}
    <h2 class="st-h">Jobs at ${esc(ws.name)}</h2>
    ${ready.length ? `<div class="st-jobs">${ready.sort(jobOrder).map(c => jobCard(c)).join('')}</div>` : '<p class="muted">Nothing ready here right now.</p>'}
    ${coming.length ? `<h2 class="st-h">Coming next</h2><div class="st-coming">${coming.sort(jobOrder).map(c => `<span>${esc(c.orderNo)} ${esc(c.product)}</span>`).join('')}</div>` : ''}`;
}
// most urgent first: late, then due soonest, then the order it came in
function jobOrder(a, b) {
  const oa = orderById(a.orderId) || {}, ob = orderById(b.orderId) || {};
  return (b.isRework ? 1 : 0) - (a.isRework ? 1 : 0) || String(oa.dueDate || '9999').localeCompare(String(ob.dueDate || '9999')) || String(a.orderNo).localeCompare(String(b.orderNo), undefined, { numeric: true });
}

function personHtml(ws, p) {
  const r = runningFor(p.id), c = r && cardById(r.jobCardId);
  const inNow = isClockedIn(p.id);
  const head = `<div class="st-bar"><div><span class="st-where">${esc(p.name)}</span><span class="muted"> · ${esc(ws.name)}${inNow ? '' : ' · not clocked in: starting a job clocks you in'}</span></div>
    <button class="btn ghost st-back" data-act="st-back">Not me / back</button></div>`;
  if (mode === 'pause' && c) return head + `<h2 class="st-h">Why are you stopping?</h2><div class="st-grid">${PAUSE_REASONS.map(x => `<button class="st-pick" data-act="st-pause-why" data-why="${esc(x)}"><strong>${esc(x)}</strong></button>`).join('')}</div>
    <button class="btn ghost st-big" data-act="st-cancel">Keep going</button>`;
  if (mode === 'done' && c) return head + `<h2 class="st-h">${esc(c.operationName)} on ${esc(c.orderNo)}: done</h2>
    <div class="card st-done">${Number(c.qty) > 1 ? `<label class="fld"><span>How many finished now (of ${esc(Number(c.qty) - (Number(c.qtyDone) || 0))} left)</span><input type="number" id="st-qty" min="1" max="${esc(Number(c.qty) - (Number(c.qtyDone) || 0))}" value="${esc(Number(c.qty) - (Number(c.qtyDone) || 0))}" inputmode="numeric"></label>` : ''}
      <h3 class="st-h" style="margin-top:.4rem">Materials used</h3>${matsHtml()}
      <label class="fld"><span>A note (if anything)</span><input id="st-note" placeholder="anything the office should know"></label>
      <button class="btn primary st-big" data-act="st-done-ok">${c.qc ? 'Passed ✓' : 'Done ✓'}</button>
      <button class="btn ghost st-big" data-act="st-cancel">Not yet</button></div>`;
  if (mode === 'fail' && c) return head + `<h2 class="st-h">Send ${esc(c.orderNo)} back to which step?</h2>
    ${failSteps == null ? '<p class="muted">Reading the steps…</p>' : !failSteps.length ? '<p class="muted">There is no earlier step to send it back to.</p>' : `<label class="fld"><span>What is wrong</span><input id="st-why" placeholder="e.g. seam open on the left arm"></label>
    <div class="st-grid">${failSteps.map(s => `<button class="st-pick" data-act="st-fail-to" data-id="${esc(s.id)}"><strong>${esc(s.operationName)}</strong><span>${esc((workstationById(s.workstationId) || {}).name || '')}</span></button>`).join('')}</div>`}
    <button class="btn ghost st-big" data-act="st-cancel">Back</button>`;
  const now = c ? `<div class="st-now"><div class="st-now-top">On now ${since(r.start, 'st-timer big')}</div>${jobCard(c)}
      ${c.workstationId !== ws.id ? `<p class="muted">This job is at ${esc((workstationById(c.workstationId) || {}).name || 'another station')}.</p>` : ''}
      <div class="st-acts"><button class="btn st-big" data-act="st-pause">Pause</button>
      ${c.qc ? '<button class="btn primary st-big" data-act="st-done">Pass</button><button class="btn danger st-big" data-act="st-fail">Fail: send back</button>' : '<button class="btn primary st-big" data-act="st-done">Done</button>'}</div></div>` : '';
  const here = cardsAt(ws.id).filter(x => (x.status === 'ready' || x.status === 'paused' || x.status === 'running') && (!c || x.id !== c.id)).sort(jobOrder);
  const pz = pauseFor(p.id);
  return head + now
    + (pz && !c ? `<p class="st-paused">Paused ${since(pz.start, 'st-mini')}: ${esc(pz.pauseReason || '')}. Tap Start on a job to carry on.</p>` : '')
    + `<h2 class="st-h">${c ? 'Or start another job (this one pauses)' : 'Pick a job'}</h2>`
    + (here.length ? `<div class="st-jobs">${here.map(x => jobCard(x, { start: mayWork() })).join('')}</div>` : '<p class="muted">Nothing ready at this station.</p>')
    + (inNow ? `<button class="btn ghost" data-act="st-clockout" style="margin-top:1rem">${c ? 'Clock out (stops this job)' : 'Clock out'}</button>` : '');
}

export function renderStations(host) {
  const ws = workstationById(stationId);
  if (!ws || ws.active === false) { host.innerHTML = pickerHtml(); return; }
  const p = personId && personById(personId);
  if (!p) personId = '';
  host.innerHTML = `<div class="station">${p ? personHtml(ws, p) : namesHtml(ws)}</div>`;
}

export async function stationAction(act, el) {
  touch();
  if (act === 'st-station') { stationId = el.dataset.id; try { localStorage.setItem(KEY, stationId); } catch (e) {} personId = ''; mode = ''; return repaint(); }
  if (act === 'st-change') { stationId = ''; try { localStorage.removeItem(KEY); } catch (e) {} personId = ''; return repaint(); }
  if (act === 'st-person') { personId = el.dataset.id; mode = ''; touch(); return repaint(); }
  if (act === 'st-back' || (act === 'st-cancel' && !mode)) return backToNames();
  if (act === 'st-cancel') { mode = ''; return repaint(); }
  if (!mayWork()) { toast('Your role can look at the floor, not time jobs', 'warn'); return; }
  const p = personById(personId); if (!p) return backToNames();
  const r = runningFor(p.id), c = r && cardById(r.jobCardId);
  if (act === 'st-start') {
    const card = cardById(el.dataset.id); if (!card) return;
    if (!isClockedIn(p.id)) await clockIn(p.id);
    startCard(card.id, p);
    return backToNames(p.name + ': started ' + card.operationName + ' on ' + card.orderNo);
  }
  if (act === 'st-pause') { mode = 'pause'; return repaint(); }
  if (act === 'st-pause-why' && c) { pauseCard(c.id, p.id, el.dataset.why); return backToNames(p.name + ': paused (' + el.dataset.why + ')'); }
  if (act === 'st-done') { mode = 'done'; doneIssues = null; repaint(); doneIssues = c ? (await issuesFor(c.id)).sort((a, b) => String(a.name).localeCompare(String(b.name))) : []; return repaint(); }
  if (act === 'st-extra') { const box = document.getElementById('st-extras'); if (box) box.insertAdjacentHTML('beforeend', extraRow()); return; }
  if (act === 'st-done-ok' && c) {
    const mats = readMats();
    if (mats.error) { toast(mats.error, 'warn'); return; }
    recordIssues(c, mats.changes, mats.extras, p.name);
    const q = document.getElementById('st-qty'), n = document.getElementById('st-note');
    await doneCard(c.id, p.id, q ? parseInt(q.value, 10) || 0 : 0, n ? n.value.trim() : '');
    return backToNames(c.operationName + ' on ' + c.orderNo + ': done');
  }
  if (act === 'st-fail' && c) { mode = 'fail'; failSteps = null; repaint(); failSteps = await earlierSteps(c); return repaint(); }
  if (act === 'st-fail-to' && c) {
    const back = (failSteps || []).find(s => s.id === el.dataset.id); if (!back) return;
    const why = (document.getElementById('st-why') || {}).value || '';
    failCheck(c.id, p.id, back, why.trim());
    return backToNames(c.orderNo + ' sent back to ' + back.operationName);
  }
  if (act === 'st-clockout') { await clockOut(p.id); return backToNames(p.name + ' clocked out'); }
}

// ------------------------------------------------------------- board ----

export function boardHtml(tv) {
  const ws = allWorkstations();
  if (!ws.length) return `<div class="card"><p>No workstations yet. ${store.can('costing') ? 'Set them up under Costing → Workstations & steps, give each product its steps, and released orders show here station by station.' : 'The owner sets them up under Costing.'}</p></div>`;
  const all = openCards();
  const rank = { running: 0, paused: 1, ready: 2, waiting: 3 };
  const col = (w) => {
    const list = all.filter(c => c.workstationId === w.id).sort((a, b) => (rank[a.status] - rank[b.status]) || jobOrder(a, b));
    const active = list.filter(c => c.status !== 'waiting'), waiting = list.filter(c => c.status === 'waiting');
    return `<div class="bd-col"><div class="bd-head"><strong>${esc(w.name)}</strong><span>${active.length}${waiting.length ? ' + ' + waiting.length + ' coming' : ''}</span></div>
      ${active.map(c => { const o = orderById(c.orderId) || {}, on = peopleOn(c.id);
        return `<div class="bd-card bd-${esc(c.status)} ${late(o) ? 'late' : ''} ${c.isRework ? 'rework' : ''}">
          <div class="bd-top"><span class="bd-no">${esc(c.orderNo)}</span>${late(o) ? `<span class="chip late">${-daysUntil(o.dueDate)}d late</span>` : ''}${c.isRework ? '<span class="chip late">rework</span>' : ''}</div>
          <div class="bd-prod">${esc(c.product)}${Number(c.qty) > 1 ? ' × ' + esc(c.qty) : ''}</div>
          <div class="bd-step">${esc(c.operationName)} · ${esc(statusLabel(c))}${c.status === 'paused' && c.lastPause ? ': ' + esc(c.lastPause) : ''}</div>
          ${on.length ? `<div class="bd-who">${on.map(p => esc(p.name) + ' ' + since(p.since, 'st-mini')).join(', ')}</div>` : ''}
          ${c.stdMinutes ? `<div class="bd-min ${cardMinutes(c) > c.stdMinutes ? 'over' : ''}">${esc(hm(cardMinutes(c)))} of ${esc(hm(c.stdMinutes))}</div>` : ''}
        </div>`; }).join('') || '<p class="muted bd-empty">Nothing here</p>'}
      ${waiting.length ? `<div class="bd-wait">${waiting.sort(jobOrder).map(c => `<span class="${late(orderById(c.orderId)) ? 'late' : ''}">${esc(c.orderNo)}</span>`).join(' ')}</div>` : ''}
    </div>`;
  };
  const list = people();
  const idle = list.filter(p => isClockedIn(p.id) && !runningFor(p.id));
  const manager = !tv && ((store.getUser() || {}).role === 'owner' || store.can('wages') || store.can('profit'));
  let times = '';
  if (manager && list.length) {
    const t = timeToday(list).filter(x => x.inAt);
    const tc = t.reduce((s, x) => s + x.clocked, 0), tj = t.reduce((s, x) => s + x.onJobs, 0);
    times = `<div class="card bd-times"><h2>Time today</h2>
      ${t.length ? `<table class="tbl"><thead><tr><th>Person</th><th>In</th><th class="r">Clocked</th><th class="r">On jobs</th><th class="r">Idle</th><th class="r">On jobs %</th></tr></thead>
      <tbody>${t.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.inAt)}${x.outAt ? '–' + esc(x.outAt) : ''}</td><td class="r">${esc(hm(x.clocked))}</td><td class="r">${esc(hm(x.onJobs))}</td><td class="r ${x.idle > 60 ? 'bad' : ''}">${esc(hm(x.idle))}</td><td class="r">${x.share == null ? '' : Math.round(x.share * 100) + '%'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2"><strong>Everyone</strong></td><td class="r">${esc(hm(tc))}</td><td class="r">${esc(hm(tj))}</td><td class="r">${esc(hm(Math.max(0, tc - tj)))}</td><td class="r"><strong>${tc ? Math.round(tj / tc * 100) + '%' : ''}</strong></td></tr></tfoot></table>
      <p class="muted">The aim is 90% or more of clocked-in time on a job. Only managers see this table.</p>` : '<p class="muted">Nobody clocked in yet today.</p>'}</div>`;
  }
  return `<div class="board ${tv ? 'tv' : ''}">
    ${tv ? `<div class="bd-title"><strong>${esc(niceDate(today()))}</strong><span>${(() => { const n = all.filter(c => c.status === 'running').length, l = all.filter(c => late(orderById(c.orderId))).length; return n + (n === 1 ? ' job' : ' jobs') + ' running · ' + l + (l === 1 ? ' card' : ' cards') + ' on late orders'; })()}</span></div>` : ''}
    <div class="bd-cols">${ws.map(col).join('')}</div>
    <div class="bd-idle"><strong>Clocked in, not on a job:</strong> ${idle.length ? idle.map(p => { const pz = pauseFor(p.id); return esc(p.name) + (pz ? ' <span class="muted">(' + esc(pz.pauseReason || 'paused') + ')</span>' : ''); }).join(', ') : 'nobody'}</div>
    ${times}
  </div>`;
}
