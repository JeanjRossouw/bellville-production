// Job cards — the floor's work, one card per step of a product's routing,
// timed by the people doing it.
//
//   jobCards/<id>     orderId, orderNo, product, qty, fabric, operationId,
//                     operationName, workstationId, sequence, stdMinutes (the
//                     step's minutes × the order's qty), qc, status (waiting |
//                     ready | running | paused | done), open, qtyDone,
//                     workedMinutes (charged minutes so far), isRework,
//                     reworkOf (the check that sent it back), waitingOn (a
//                     check waiting for its rework), reworks, doneAt, doneBy,
//                     note, skipped (closed because the order moved on)
//   timeEntries/<id>  jobCardId, orderId, workstationId, staffId, staffName,
//                     kind ('work' | 'pause'), start, end ('' while it runs),
//                     open, minutes, day, pauseReason, rateAtTime,
//                     editedBy, editReason, editedAt, autoClosed
//
// An order is released when it goes into production: its product's routing
// becomes job cards, the first Ready and the rest Waiting. Done on a card
// makes the next one Ready; the last one done makes the order Done. A check
// (QC) passes, or sends the piece back to an earlier step as a rework card,
// timed on its own so its cost shows as loss.
//
// Work minutes are charged at the station's rate of that day; pause minutes
// are logged with their reason and not charged. A person has one job running
// at a time: starting another pauses the first; clocking out pauses it; a job
// still running from an earlier day is stopped at that day's clock-out (or
// the day's end time) and marked, so a manager can check it.
//
// Only open cards, open entries and today's entries are watched, so the
// tablets read no more as the months add up. The floor writes without waiting
// for the server, so a tablet that loses the wifi carries on and catches up.
import * as store from './store.js';
import { orderById, setStatus } from './orders.js';
import { productByName } from './costing.js';
import { routingOf, operationById, workstationById, stationRate, hm } from './routing.js';
import { attendanceOf } from './today.js';
import { esc, openModal, toast, today, niceDate } from './ui.js';

let cards = [];                 // open job cards
let running = [];               // open time entries (work or pause), any day
let todays = [];                // every entry of today
let day = '';
let settings = {};
let onChange = null;
let unwatch = [];
let unwatchDay = null;

export function startJobs(cb, cfg) {
  onChange = cb; settings = cfg || {};
  unwatch.forEach(u => u()); unwatch = [];
  if (unwatchDay) unwatchDay();
  unwatchDay = null; day = '';
  unwatch.push(store.watchWhere('jobCards', [['open', '==', true]], rows => { cards = rows; changed(); }));
  // the times (who, how long, at what rate) only for those who may read them
  if (!readsTime()) return;
  unwatch.push(store.watchWhere('timeEntries', [['open', '==', true]], rows => { running = rows; changed(); }));
  watchDay();
}
export const readsTime = () => ['factory', 'wages', 'costing', 'profit'].some(a => store.can(a));
export const setJobSettings = (cfg) => { settings = cfg || {}; };
// today's entries; a new subscription when the date turns over (the demo
// answers a new watch at once, so the day is set before it is asked)
function watchDay() {
  if (day === today() || !readsTime()) return;
  day = today();
  if (unwatchDay) unwatchDay();
  unwatchDay = null;
  const u = store.watchWhere('timeEntries', [['day', '==', day]], rows => { todays = rows; changed(); });
  unwatchDay = u;
}
let staleChecked = '';
function changed() {
  watchDay();
  // a job left running on an earlier day: stopped once, by whoever runs the floor
  if (staleChecked !== day && store.can('factory', 'edit') && running.some(e => e.day && e.day < day)) { staleChecked = day; closeStale(); }
  if (onChange) onChange();
}

const nowIso = () => store.nowIso();
const who = () => (store.getUser() || {}).name || '';
export const minutesBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 6000) / 10);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fire = (p, what) => { Promise.resolve(p).catch(e => { console.error(what, e); toast((what ? what + ': ' : '') + e.message, 'warn'); }); };

// ----------------------------------------------------------- the lists ----

export const openCards = () => cards;
export const cardById = (id) => cards.find(c => c.id === id) || null;
export const cardsForOrder = (orderId) => cards.filter(c => c.orderId === orderId).sort((a, b) => a.sequence - b.sequence || (a.isRework ? 1 : 0) - (b.isRework ? 1 : 0));
export const cardsAt = (wsId) => cards.filter(c => c.workstationId === wsId);
export const runningEntries = () => running;
const workOn = (cardId) => running.filter(e => e.kind === 'work' && e.jobCardId === cardId);
export const peopleOn = (cardId) => workOn(cardId).map(e => ({ staffId: e.staffId, name: e.staffName, since: e.start }));
export const runningFor = (staffId) => running.find(e => e.kind === 'work' && e.staffId === staffId) || null;
export const pauseFor = (staffId) => running.find(e => e.kind === 'pause' && e.staffId === staffId) || null;
// minutes worked on a card: what is banked plus what is running now
export const cardMinutes = (c) => r1((Number(c.workedMinutes) || 0) + workOn(c.id).reduce((s, e) => s + minutesBetween(e.start, nowIso()), 0));
export const hasRouting = (o) => !!o && routingOf(productByName(o.product)).length > 0;
// the step a released order is at, for the planner and the order card
export function stageOf(o) {
  const mine = cardsForOrder(o.id);
  if (!mine.length) return null;
  const on = mine.find(c => c.status === 'running') || mine.find(c => c.status === 'paused') || mine.find(c => c.status === 'ready') || mine[0];
  return { card: on, left: mine.length, total: Number(o.jobCards) || mine.length };
}

// --------------------------------------------------------- releasing ----

// The job cards an order gets when it goes onto the floor (none when its
// product has no routing: then it is built the old way).
export function releaseOps(o) {
  const steps = routingOf(productByName(o.product));
  const qty = Number(o.qty) || 1;
  return steps.map((r, i) => ({ op: 'create', coll: 'jobCards', id: store.newId('jobCards'), data: {
    orderId: o.id, orderNo: o.orderNo || '', product: o.product || '', qty, fabric: o.fabric || '',
    operationId: r.operationId, operationName: r.op.name, workstationId: r.op.workstationId || '', sequence: i + 1,
    stdMinutes: r1(r.stdMinutes * qty), qc: !!r.op.qc, status: i === 0 ? 'ready' : 'waiting', open: true,
    qtyDone: 0, workedMinutes: 0, isRework: false, reworkOf: '', waitingOn: '', reworks: 0 } }));
}
export async function releaseOrder(o) {
  if (cardsForOrder(o.id).length) return 0;
  const ops = releaseOps(o);
  if (!ops.length) return 0;
  ops.push({ op: 'update', coll: 'orders', id: o.id, patch: { releasedAt: nowIso(), releasedBy: who(), jobCards: ops.length }, event: 'Released to the floor: ' + ops.length + ' job cards' });
  await store.batchWrite(ops);
  return ops.length - 1;
}

// The order moved on (Done, out of the door, cancelled, back to New): its
// open cards close, anyone still timing them stops. Back to New, the order
// can be released again later, with fresh cards.
export async function closeCardsFor(orderId, why, unrelease) {
  // a role that does not watch the floor (the loading door) asks for them
  const mine = unwatch.length ? cards.filter(c => c.orderId === orderId)
    : await store.getWhere('jobCards', [['orderId', '==', orderId], ['open', '==', true]]);
  if (!mine.length && !unrelease) return;
  const now = nowIso(), ops = [];
  mine.forEach(c => {
    running.filter(e => e.jobCardId === c.id).forEach(e => ops.push(...closeOps(e, now)));
    ops.push({ op: 'update', coll: 'jobCards', id: c.id, patch: { status: 'done', open: false, skipped: true, doneAt: now, doneBy: who(), note: why || '' } });
  });
  if (unrelease) ops.push({ op: 'update', coll: 'orders', id: orderId, patch: { releasedAt: '', jobCards: 0 } });
  if (ops.length) await store.batchWrite(ops);
}

// ------------------------------------------------------------ timing ----

function closeOps(e, endIso, extra) {
  const minutes = minutesBetween(e.start, endIso);
  const ops = [{ op: 'update', coll: 'timeEntries', id: e.id, patch: { end: endIso, open: false, minutes, ...(extra || {}) } }];
  if (e.kind === 'work') ops.push({ op: 'update', coll: 'jobCards', id: e.jobCardId, patch: { workedMinutes: store.inc(minutes) } });
  return ops;
}
const othersOn = (cardId, staffId) => workOn(cardId).some(e => e.staffId !== staffId);
// what a card's status becomes once this person stops on it
const afterStop = (cardId, staffId) => othersOn(cardId, staffId) ? 'running' : 'paused';

export function startCard(cardId, person) {
  const c = cardById(cardId); if (!c || !person) return;
  if (c.status === 'waiting' || c.status === 'done') { toast('That job is not ready yet', 'warn'); return; }
  const mine = running.filter(e => e.staffId === person.id);
  if (mine.some(e => e.kind === 'work' && e.jobCardId === cardId)) return;      // already on it
  const now = nowIso(), ops = [];
  mine.forEach(e => {
    ops.push(...closeOps(e, now));
    // switching jobs pauses the one they were on
    if (e.kind === 'work' && e.jobCardId !== cardId && !othersOn(e.jobCardId, person.id)) ops.push({ op: 'update', coll: 'jobCards', id: e.jobCardId, patch: { status: 'paused' } });
  });
  ops.push({ op: 'create', coll: 'timeEntries', id: store.newId('timeEntries'), data: {
    jobCardId: c.id, orderId: c.orderId, workstationId: c.workstationId, staffId: person.id, staffName: person.name || '',
    kind: 'work', start: now, end: '', open: true, minutes: 0, day: today(), pauseReason: '',
    rateAtTime: stationRate(workstationById(c.workstationId)) } });
  ops.push({ op: 'update', coll: 'jobCards', id: c.id, patch: { status: 'running', ...(c.startedAt ? {} : { startedAt: now }) } });
  fire(store.batchWrite(ops), 'Could not start');
}

export const PAUSE_REASONS = ['Tea or lunch', 'Waiting for material', 'Waiting for the frame', 'Rework from the step before', 'Something else'];
export function pauseCard(cardId, staffId, reason) {
  const c = cardById(cardId), e = running.find(x => x.kind === 'work' && x.jobCardId === cardId && x.staffId === staffId);
  if (!c || !e) return;
  const now = nowIso();
  const ops = closeOps(e, now);
  ops.push({ op: 'create', coll: 'timeEntries', id: store.newId('timeEntries'), data: {
    jobCardId: c.id, orderId: c.orderId, workstationId: c.workstationId, staffId, staffName: e.staffName || '',
    kind: 'pause', start: now, end: '', open: true, minutes: 0, day: today(), pauseReason: reason || '', rateAtTime: 0 } });
  ops.push({ op: 'update', coll: 'jobCards', id: c.id, patch: { status: afterStop(cardId, staffId), lastPause: reason || '' } });
  fire(store.batchWrite(ops), 'Could not pause');
}

// Done (or a check passed): everyone on it stops, and the work moves on.
export async function doneCard(cardId, staffId, qty, note) {
  const c = cardById(cardId); if (!c) return;
  const now = nowIso(), ops = [];
  running.filter(e => e.jobCardId === cardId).forEach(e => ops.push(...closeOps(e, now)));
  const name = ((running.find(e => e.staffId === staffId) || {}).staffName) || nameOfStaff(staffId) || who();
  const done = Math.min(Number(c.qty) || 1, (Number(c.qtyDone) || 0) + (Number(qty) || Number(c.qty) || 1));
  if (done < (Number(c.qty) || 1)) {
    ops.push({ op: 'update', coll: 'jobCards', id: c.id, patch: { qtyDone: done, status: 'paused', ...(note ? { note } : {}) } });
    fire(store.batchWrite(ops), 'Could not save');
    toast(done + ' of ' + c.qty + ' done on ' + c.operationName);
    return;
  }
  ops.push({ op: 'update', coll: 'jobCards', id: c.id, patch: { qtyDone: done, status: 'done', open: false, doneAt: now, doneBy: name, note: note || c.note || '' } });
  const rest = cardsForOrder(c.orderId).filter(x => x.id !== c.id);
  let last = false;
  if (c.isRework) {
    // the fix is done: the check that sent it back is ready again
    const back = rest.find(x => x.waitingOn === c.id);
    if (back) ops.push({ op: 'update', coll: 'jobCards', id: back.id, patch: { status: 'ready', waitingOn: '' } });
  } else {
    const next = rest.filter(x => !x.isRework && x.status === 'waiting' && !x.waitingOn && x.sequence > c.sequence).sort((a, b) => a.sequence - b.sequence)[0];
    if (next) ops.push({ op: 'update', coll: 'jobCards', id: next.id, patch: { status: 'ready' } });
    last = !rest.length;
  }
  fire(store.batchWrite(ops), 'Could not save');
  if (last) {
    const o = orderById(c.orderId);
    if (o && o.status === 'in-production') fire(setStatus(o.id, 'ready', { fromCards: true }), 'Could not mark the order done');
  }
}

// A check failed: the piece goes back to an earlier step, as a rework card.
export async function earlierSteps(c) {
  let all = [];
  try { all = await store.getWhere('jobCards', [['orderId', '==', c.orderId]]); } catch (e) { all = cardsForOrder(c.orderId); }
  const seen = {};
  return all.filter(x => !x.isRework && x.sequence < c.sequence && !x.skipped).sort((a, b) => a.sequence - b.sequence)
    .filter(x => (seen[x.operationId] ? false : (seen[x.operationId] = true)));
}
export function failCheck(cardId, staffId, back, note) {
  const c = cardById(cardId); if (!c || !back) return;
  const now = nowIso(), ops = [];
  running.filter(e => e.jobCardId === cardId).forEach(e => ops.push(...closeOps(e, now)));
  const id = store.newId('jobCards');
  ops.push({ op: 'create', coll: 'jobCards', id, data: {
    orderId: c.orderId, orderNo: c.orderNo, product: c.product, qty: c.qty, fabric: c.fabric || '',
    operationId: back.operationId, operationName: back.operationName, workstationId: back.workstationId, sequence: back.sequence,
    stdMinutes: 0, qc: false, status: 'ready', open: true, qtyDone: 0, workedMinutes: 0, isRework: true, reworkOf: c.id, waitingOn: '',
    reworks: 0, note: note || '' } });
  ops.push({ op: 'update', coll: 'jobCards', id: c.id, patch: { status: 'waiting', waitingOn: id, reworks: store.inc(1), lastFail: note || '' } });
  ops.push({ op: 'update', coll: 'orders', id: c.orderId, patch: {}, event: (c.operationName || 'Check') + ' failed: back to ' + back.operationName + (note ? ' (' + note + ')' : '') });
  fire(store.batchWrite(ops), 'Could not send it back');
}

// Clocked out (or gone home): whatever they had running stops.
export function stopPerson(staffId, reason, atIso) {
  const mine = running.filter(e => e.staffId === staffId);
  if (!mine.length) return;
  const at = atIso || nowIso(), ops = [];
  mine.forEach(e => {
    ops.push(...closeOps(e, at > e.start ? at : e.start, reason ? { endReason: reason } : null));
    if (e.kind === 'work') ops.push({ op: 'update', coll: 'jobCards', id: e.jobCardId, patch: { status: afterStop(e.jobCardId, staffId) } });
  });
  fire(store.batchWrite(ops), 'Could not stop the timer');
}

// No overnight timers: an entry from an earlier day stops at that day's
// clock-out, or the day's end time when nobody clocked them out.
const atTime = (d, hhmm) => new Date(d + 'T' + (hhmm || '17:00') + ':00').toISOString();
function closeStale() {
  const ops = [];
  running.filter(e => e.day && e.day < today()).forEach(e => {
    const out = ((attendanceOf(e.day) || {}).out || {})[e.staffId];
    let end = atTime(e.day, out || settings.dayEnd || '17:00');
    if (end < e.start) end = e.start;
    ops.push(...closeOps(e, end, { autoClosed: true, editReason: 'Left running: stopped at ' + (out ? 'their clock-out' : 'the end of the day') + ', ' + hmTime(end) }));
    if (e.kind === 'work' && !othersOn(e.jobCardId, e.staffId)) ops.push({ op: 'update', coll: 'jobCards', id: e.jobCardId, patch: { status: 'paused' } });
  });
  if (ops.length) fire(store.batchWrite(ops), 'Could not stop yesterday\'s timers');
}

// ------------------------------------------------------- time per person ----

let rosterNames = {};
export const setRosterNames = (people) => { rosterNames = {}; (people || []).forEach(p => { rosterNames[p.id] = p.name; }); };
const nameOfStaff = (id) => rosterNames[id] || '';

// For a day: how long each person was clocked in, how much of it was on a
// job, and what was left over (idle).
export function timeToday(people) {
  const d = today(), att = attendanceOf(d) || {}, now = Date.now();
  const all = {};
  [...todays, ...running.filter(e => e.day === d)].forEach(e => { all[e.id] = e; });
  return (people || []).map(p => {
    const inAt = (att.in || {})[p.id], outAt = (att.out || {})[p.id];
    const clocked = inAt ? Math.max(0, Math.round(((outAt ? Date.parse(atTime(d, outAt)) : now) - Date.parse(atTime(d, inAt))) / 60000)) : 0;
    const onJobs = Object.values(all).filter(e => e.staffId === p.id && e.kind === 'work')
      .reduce((s, e) => s + (e.open ? minutesBetween(e.start, nowIso()) : (Number(e.minutes) || 0)), 0);
    return { ...p, inAt, outAt, clocked, onJobs: Math.round(onJobs), idle: Math.max(0, clocked - Math.round(onJobs)), share: clocked ? Math.min(1, onJobs / clocked) : null };
  });
}

// ---------------------------------------------- the order's job cards ----

const STATUS_LABEL = { waiting: 'Waiting', ready: 'Ready', running: 'On it', paused: 'Paused', done: 'Done' };
export const statusLabel = (c) => c.skipped ? 'Closed' : c.waitingOn ? 'Waiting for the fix' : (STATUS_LABEL[c.status] || c.status);
const hmTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const canEditTime = () => (store.getUser() || {}).role === 'owner' || store.can('wages', 'edit') || store.can('costing', 'edit');

export async function openJobCards(orderId) {
  const o = orderById(orderId);
  let list = [], entries = [];
  try { list = await store.getWhere('jobCards', [['orderId', '==', orderId]]); }
  catch (e) { toast('Could not read the job cards: ' + e.message, 'warn'); return; }
  // the times only for a role that may see them; the steps for everyone
  if (readsTime()) { try { entries = await store.getWhere('timeEntries', [['orderId', '==', orderId]]); } catch (e) { entries = []; } }
  list.sort((a, b) => a.sequence - b.sequence || (a.isRework ? 1 : 0) - (b.isRework ? 1 : 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const editable = canEditTime();
  const worked = (c) => entries.filter(e => e.jobCardId === c.id && e.kind === 'work').reduce((s, e) => s + (e.open ? minutesBetween(e.start, nowIso()) : (Number(e.minutes) || 0)), 0);
  const std = list.filter(c => !c.isRework && !c.skipped).reduce((s, c) => s + (Number(c.stdMinutes) || 0), 0);
  const all = list.reduce((s, c) => s + worked(c), 0);
  const body = !list.length ? '<p class="muted">No job cards: this order was not released with a routing.</p>' : `
    <p class="muted">Standard ${esc(hm(std))} · logged ${esc(hm(all))}${std ? ' (' + Math.round(all / std * 100) + '%)' : ''}. Paused time is kept, not charged.</p>
    ${list.map(c => {
      const es = entries.filter(e => e.jobCardId === c.id).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return `<div class="jc-row ${c.isRework ? 'rework' : ''}">
        <div class="jc-head"><strong>${c.isRework ? 'Rework: ' : c.sequence + '. '}${esc(c.operationName)}</strong>
          <span class="muted">${esc((workstationById(c.workstationId) || {}).name || '')}</span>
          <span class="chip ${c.status === 'done' ? 'calm' : c.status === 'running' ? 'soon' : ''}">${esc(statusLabel(c))}</span>
          <span class="jc-min">${esc(hm(worked(c)))}${c.stdMinutes ? ' / ' + esc(hm(c.stdMinutes)) : ''}</span></div>
        ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
        ${es.length ? `<table class="tbl jc-tbl"><tbody>${es.map(e => `<tr class="${e.kind === 'pause' ? 'muted' : ''}">
          <td>${esc(e.staffName || '')}</td><td>${esc(niceDate(e.day))} ${esc(hmTime(e.start))}–${e.open ? 'now' : esc(hmTime(e.end))}</td>
          <td>${e.kind === 'pause' ? 'paused' + (e.pauseReason ? ': ' + esc(e.pauseReason) : '') : esc(hm(e.open ? minutesBetween(e.start, nowIso()) : e.minutes))}${e.editReason ? ' <span class="chip" title="' + esc(e.editReason) + '">' + (e.autoClosed ? 'stopped by the system' : 'changed by ' + esc(e.editedBy || '')) + '</span>' : ''}</td>
          <td class="r">${editable && !e.open && e.kind === 'work' ? `<button class="btn ghost sm" data-te="${esc(e.id)}">Change</button>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>`; }).join('')}`;
  const m = openModal('Job cards · ' + ((o && o.orderNo) || '') + ' ' + ((o && o.product) || ''), body, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  m.wrap.querySelectorAll('[data-te]').forEach(b => b.addEventListener('click', () => editEntry(entries.find(e => e.id === b.dataset.te), list, orderId)));
}

// A manager corrects a time entry: who changed it and why stay on it, and on
// the order's history.
function editEntry(e, list, orderId) {
  if (!e) return;
  const c = list.find(x => x.id === e.jobCardId) || {};
  const html = `<p>${esc(e.staffName || '')} on ${esc(c.operationName || '')}, ${esc(niceDate(e.day))}: ${esc(hm(e.minutes))} logged.</p>
    <div class="fld-row"><label class="fld"><span>Started</span><input type="datetime-local" id="te-start" value="${esc(localInput(e.start))}"></label>
    <label class="fld"><span>Stopped</span><input type="datetime-local" id="te-end" value="${esc(localInput(e.end))}"></label></div>
    <label class="fld"><span>Why it is changed (kept with the entry)</span><input id="te-why" placeholder="e.g. forgot to press Done before lunch"></label>`;
  openModal('Change a time entry', html, { okLabel: 'Save the change', onOk: async (w) => {
    const s = w.querySelector('#te-start').value, en = w.querySelector('#te-end').value, why = w.querySelector('#te-why').value.trim();
    if (!why) { toast('Say why it is changed', 'warn'); return false; }
    const start = new Date(s).toISOString(), end = new Date(en).toISOString();
    if (!s || !en || end <= start) { toast('The stop time must be after the start', 'warn'); return false; }
    const minutes = minutesBetween(start, end), delta = r1(minutes - (Number(e.minutes) || 0));
    try {
      await store.batchWrite([
        { op: 'update', coll: 'timeEntries', id: e.id, patch: { start, end, minutes, editedBy: who(), editReason: why, editedAt: nowIso() } },
        { op: 'update', coll: 'jobCards', id: e.jobCardId, patch: { workedMinutes: store.inc(delta) } },
        { op: 'update', coll: 'orders', id: orderId, patch: {}, event: 'Time for ' + (e.staffName || '') + ' on ' + (c.operationName || '') + ' changed from ' + hm(e.minutes) + ' to ' + hm(minutes) + ': ' + why }
      ]);
    } catch (err) { toast('Could not save: ' + err.message, 'warn'); return false; }
    toast('Changed. It says who and why');
    setTimeout(() => openJobCards(orderId), 50);
  } });
}
