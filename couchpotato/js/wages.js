// Wages — the factory side of pay. Staff and how each is paid; a run per
// week (or per month for salaries) with hours, overtime, piece-work taken
// from the job cards finished in that period, bonuses, advances and
// deductions; payslips and a wage sheet to print; and an export for the
// accountant or a payroll service.
//
// PAYE is deliberately not worked out here: the tax tables change every
// year and getting them wrong is costly. UIF (1% from the worker, 1% from
// the company, on earnings up to the ceiling) is shown so the net pay and
// the export are right.
//
//   staff/<id>     name, job, phone, idNumber, payType, rate, uif, bank, active
//   wageRuns/<id>  id = w-<Monday> or m-<YYYY-MM>; kind, start, end, status
//                  (draft | paid), lines (one per staff member, with the
//                  figures as they were when saved), paidAt, paidBy
import * as store from './store.js';
import { allOrders } from './orders.js';
import { productByName } from './costing.js';
import { mondayOf, finishedOn } from './floor.js';
import { toCsv, download } from './exporter.js';
import { esc, money, field, row, val, openModal, toast, empty, today, isoLocal, addDays, niceDate, openPrint, docHeader } from './ui.js';

export const PAY_TYPES = [
  { key: 'hourly', label: 'Per hour', hint: 'rate × hours worked' },
  { key: 'weekly', label: 'Weekly wage', hint: 'a fixed wage for the week' },
  { key: 'piece', label: 'Per piece', hint: 'rate per labour hour × the hours in each piece built' },
  { key: 'monthly', label: 'Monthly salary', hint: 'paid in the month’s run' }
];
const UIF_RATE = 0.01;
const UIF_MONTHLY_CEILING = 17712;   // earnings above this carry no UIF
const NORMAL_HOURS = 45;             // a full week
const OT = 1.5;                      // overtime at time and a half
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const typeLabel = (k) => (PAY_TYPES.find(t => t.key === k) || PAY_TYPES[0]).label;

let staff = [];
let runs = [];
let settings = {};
let unwatch = [];
let onChange = null;
let view = 'run';          // run | staff | history
let period = '';           // w-YYYY-MM-DD or m-YYYY-MM
let draft = null;          // the run on screen, with unsaved changes
let dirty = false;

export function startWages(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  unwatch.forEach(u => u && u()); unwatch = [];
  unwatch.push(store.watch('staff', rows => { staff = rows.filter(s => !s.removed).sort((a, b) => String(a.name).localeCompare(String(b.name))); if (onChange) onChange(); }));
  unwatch.push(store.watch('wageRuns', rows => { runs = rows.sort((a, b) => String(b.start).localeCompare(String(a.start))); if (onChange) onChange(); }));
}
export const setWagesSettings = (cfg) => { settings = cfg || {}; };
const changed = () => { if (onChange) onChange(); };
export const setWageView = (v) => { view = v; };
export const setWagePeriod = (id) => { period = id; view = 'run'; };
export const allStaff = () => staff;
export const allRuns = () => runs;

// --------------------------------------------------------------- periods ----

function periodInfo(id) {
  if (String(id).startsWith('m-')) {
    const ym = id.slice(2); const [y, m] = ym.split('-').map(Number);
    const start = ym + '-01', end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { id, kind: 'month', start, end, label: new Date(start + 'T00:00:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' }) };
  }
  const mon = String(id).slice(2);
  return { id, kind: 'week', start: mon, end: addDays(mon, 6), label: 'Week of ' + niceDate(mon) };
}
const thisWeekId = () => 'w-' + mondayOf(today());
const thisMonthId = () => 'm-' + today().slice(0, 7);
function periodChoices() {
  const out = [];
  const mon = mondayOf(today());
  for (let i = 1; i >= -8; i--) { const m = addDays(mon, i * 7); out.push({ value: 'w-' + m, label: (i === 1 ? 'Next week' : i === 0 ? 'This week' : i === -1 ? 'Last week' : 'Week') + ' · ' + niceDate(m).replace(/ \d{4}$/, '') + ' – ' + niceDate(addDays(m, 6)).replace(/ \d{4}$/, '') });
  }
  const d = new Date(today() + 'T12:00:00');
  for (let i = 0; i >= -3; i--) { const x = new Date(d.getFullYear(), d.getMonth() + i, 1, 12); const ym = isoLocal(x).slice(0, 7); out.push({ value: 'm-' + ym, label: (i === 0 ? 'This month' : 'Month') + ' · ' + x.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' }) }); }
  runs.forEach(r => { if (!out.some(o => o.value === r.id)) out.push({ value: r.id, label: periodInfo(r.id).label }); });
  return out;
}
const inPeriod = (s, p) => p.kind === 'month' ? s.payType === 'monthly' : s.payType !== 'monthly';

// ----------------------------------------------------------------- maths ----

// The figures for one line. For a piece worker the rate is per labour hour;
// each piece pays its product's labour hours at that rate, extra hours too.
export function calc(l) {
  const rate = Number(l.rate) || 0, hours = Number(l.hours) || 0, ot = Number(l.overtime) || 0;
  const hourly = l.payType === 'hourly' || l.payType === 'piece' ? rate : l.payType === 'weekly' ? rate / NORMAL_HOURS : rate * 12 / 52 / NORMAL_HOURS;
  let basic = 0;
  if (l.payType === 'hourly') basic = hours * rate;
  else if (l.payType === 'weekly' || l.payType === 'monthly') basic = rate;
  else basic = (l.pieces || []).reduce((s, p) => s + (Number(p.amount) || 0), 0) + hours * rate;
  const overtimePay = ot * hourly * OT;
  const bonus = Number(l.bonus) || 0;
  const gross = r2(basic + overtimePay + bonus);
  const ceiling = l.payType === 'monthly' ? UIF_MONTHLY_CEILING : UIF_MONTHLY_CEILING * 12 / 52;
  const uif = l.uif === false ? 0 : r2(Math.min(gross, ceiling) * UIF_RATE);
  const deductions = r2((l.deductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0));
  const advances = r2(Number(l.advances) || 0);
  return { basic: r2(basic), overtimePay: r2(overtimePay), bonus: r2(bonus), gross, uif, uifEmployer: uif, deductions, advances, net: r2(gross - uif - deductions - advances), hourly: r2(hourly) };
}
export function totals(lines) {
  const t = { gross: 0, uif: 0, uifEmployer: 0, deductions: 0, advances: 0, net: 0, people: 0 };
  lines.forEach(l => { const c = calc(l); t.gross += c.gross; t.uif += c.uif; t.uifEmployer += c.uifEmployer; t.deductions += c.deductions; t.advances += c.advances; t.net += c.net; t.people++; });
  Object.keys(t).forEach(k => { t[k] = r2(t[k]); });
  return t;
}

// ------------------------------------------------------------- the draft ----

function freshLine(s) {
  return { staffId: s.id, name: s.name, job: s.job || '', payType: s.payType || 'hourly', rate: Number(s.rate) || 0, uif: s.uif !== false,
    hours: s.payType === 'hourly' ? NORMAL_HOURS : 0, overtime: 0, pieces: [], bonus: 0, advances: 0, deductions: [], note: '' };
}
// The run for the period on screen: the saved one, else a new one for the
// staff who belong in it. Anyone added since is brought in.
function loadDraft() {
  if (!period) period = thisWeekId();
  const p = periodInfo(period);
  const saved = runs.find(r => r.id === period);
  if (!draft || draft.id !== period || (!dirty && saved && saved.updatedAt !== draft.updatedAt)) {
    draft = saved ? JSON.parse(JSON.stringify(saved)) : { id: period, kind: p.kind, start: p.start, end: p.end, status: 'draft', lines: [] };
    dirty = false;
  }
  if (draft.status !== 'paid') {
    staff.filter(s => s.active !== false && inPeriod(s, p)).forEach(s => { if (!draft.lines.some(l => l.staffId === s.id)) draft.lines.push(freshLine(s)); });
  }
  return draft;
}
const lineOf = (id) => (draft && draft.lines.find(l => l.staffId === id)) || null;

// A typed number: hours, overtime, bonus, advances. Recalculated in place
// so the typing is never interrupted by a repaint.
export function wageInput(t) {
  const l = lineOf(t.dataset.id); if (!l || draft.status === 'paid') return;
  const k = t.dataset.wg;
  if (['hours', 'overtime', 'bonus', 'advances'].includes(k)) l[k] = Math.max(0, parseFloat(t.value) || 0);
  else if (k === 'note') l.note = t.value;
  dirty = true;
  refreshRow(t.closest('tr'), l);
}
function refreshRow(tr, l) {
  if (!tr) return;
  const c = calc(l);
  const set = (cell, v) => { const el = tr.querySelector('[data-cell="' + cell + '"]'); if (el) el.textContent = v; };
  const cur = settings.currency || 'R';
  set('gross', money(c.gross, cur)); set('uif', money(c.uif, cur)); set('net', money(c.net, cur));
  const tot = totals(draft.lines);
  const foot = tr.closest('table').querySelector('tfoot');
  if (foot) { const f = (cell, v) => { const el = foot.querySelector('[data-cell="' + cell + '"]'); if (el) el.textContent = v; }; f('gross', money(tot.gross, cur)); f('uif', money(tot.uif, cur)); f('net', money(tot.net, cur)); }
  const unsaved = document.getElementById('wg-unsaved'); if (unsaved) unsaved.hidden = false;
}

// ---------------------------------------------------------------- render ----

export function renderWages(host) {
  const cur = settings.currency || 'R';
  const tab = (k, label) => `<button class="btn ${view === k ? 'primary' : 'ghost'} sm" data-act="wg-view" data-to="${k}">${esc(label)}</button>`;
  let body;
  if (view === 'staff') body = staffHtml(cur);
  else if (view === 'history') body = historyHtml(cur);
  else body = runHtml(cur);
  host.innerHTML = `
    <div class="page-head"><div><h1>Wages</h1><p class="sub">Hours, piece-work and pay for the week; payslips and the wage sheet. PAYE is not worked out here.</p></div>
      <div class="btn-row">${store.can('wages', 'edit') ? '<button class="btn primary" data-act="wg-staff-new">＋ Staff member</button>' : ''}</div></div>
    <div class="btn-row" style="margin:.2rem 0 .9rem">${tab('run', 'This period')}${tab('staff', 'Staff (' + staff.filter(s => s.active !== false).length + ')')}${tab('history', 'Past runs')}</div>
    ${body}`;
}

function staffHtml(cur) {
  if (!staff.length) return empty('', 'No staff yet', 'Add each person with how they are paid: per hour, a weekly wage, per piece, or a monthly salary.');
  const edit = store.can('wages', 'edit');
  return `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>Name</th><th>Job</th><th>Paid</th><th class="r">Rate</th><th>UIF</th><th>Cell</th><th></th></tr></thead>
    <tbody>${staff.map(s => `<tr${s.active === false ? ' style="opacity:.5"' : ''}>
      <td><strong>${esc(s.name)}</strong>${s.idNumber ? '<div class="muted">ID ' + esc(s.idNumber) + '</div>' : ''}</td>
      <td>${esc(s.job || '')}</td>
      <td>${esc(typeLabel(s.payType))}</td>
      <td class="r nowrap">${esc(money(s.rate, cur))}${s.payType === 'hourly' || s.payType === 'piece' ? '/h' : s.payType === 'weekly' ? '/week' : '/month'}</td>
      <td>${s.uif === false ? 'no' : 'yes'}</td>
      <td>${esc(s.phone || '')}</td>
      <td class="r nowrap">${edit ? `<button class="btn ghost sm" data-act="wg-staff-edit" data-id="${esc(s.id)}">Edit</button> <button class="btn ghost sm" data-act="wg-staff-toggle" data-id="${esc(s.id)}">${s.active === false ? 'Back on' : 'Left'}</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="muted">Per piece pays the labour hours of each piece built (from Costing) at the person’s rate per hour, plus any extra hours. A weekly wage or monthly salary is fixed; overtime is paid at ${OT}× the hourly equivalent (${NORMAL_HOURS} hours a week).</p>`;
}

function runHtml(cur) {
  const d = loadDraft();
  const p = periodInfo(d.id);
  const edit = store.can('wages', 'edit') && d.status !== 'paid';
  const t = totals(d.lines);
  const pick = `<select data-act="wg-period">${periodChoices().map(c => `<option value="${esc(c.value)}" ${c.value === d.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
  const status = d.status === 'paid' ? `<span class="chip st-disp">Paid ${esc(niceDate(String(d.paidAt || '').slice(0, 10)))}${d.paidBy ? ' · ' + esc(d.paidBy) : ''}</span>` : runs.some(r => r.id === d.id) ? '<span class="chip st-new">Draft, saved</span>' : '<span class="chip calm">Not saved yet</span>';
  const num = (l, k, step) => edit ? `<input type="number" min="0" step="${step || '0.5'}" value="${esc(l[k] || 0)}" data-wg="${k}" data-id="${esc(l.staffId)}" style="width:5.2em">` : esc(String(l[k] || 0));
  const rowHtml = (l) => {
    const c = calc(l);
    const pieces = `${l.pieces.length ? l.pieces.map(pc => `<div class="muted">${esc(pc.orderNo)} ${esc(pc.product)} · ${esc(String(pc.hours))}h · ${esc(money(pc.amount, cur))}${edit ? ` <button class="btn ghost xs" data-act="wg-piece-del" data-id="${esc(l.staffId)}" data-order="${esc(pc.orderId)}" title="Take off">✕</button>` : ''}</div>`).join('') : ''}${edit && l.payType === 'piece' ? `<button class="btn ghost xs" data-act="wg-piece-add" data-id="${esc(l.staffId)}">＋ piece</button>` : ''}`;
    const deds = `${l.deductions.map((x, i) => `<div class="muted">${esc(x.what)} · ${esc(money(x.amount, cur))}${edit ? ` <button class="btn ghost xs" data-act="wg-ded-del" data-id="${esc(l.staffId)}" data-i="${i}">✕</button>` : ''}</div>`).join('')}${edit ? `<button class="btn ghost xs" data-act="wg-ded-add" data-id="${esc(l.staffId)}">＋ deduction</button>` : ''}`;
    return `<tr>
      <td><strong>${esc(l.name)}</strong><div class="muted">${esc(typeLabel(l.payType))} · ${esc(money(l.rate, cur))}${l.payType === 'hourly' || l.payType === 'piece' ? '/h' : l.payType === 'weekly' ? '/week' : '/month'}</div></td>
      <td class="nowrap">${l.payType === 'weekly' || l.payType === 'monthly' ? '<span class="muted">fixed</span>' : num(l, 'hours')}</td>
      <td class="nowrap">${num(l, 'overtime')}</td>
      <td>${l.payType === 'piece' ? pieces : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${num(l, 'bonus', '1')}</td>
      <td class="nowrap">${num(l, 'advances', '1')}</td>
      <td>${deds}</td>
      <td class="r nowrap" data-cell="gross">${esc(money(c.gross, cur))}</td>
      <td class="r nowrap" data-cell="uif">${esc(money(c.uif, cur))}</td>
      <td class="r nowrap" data-cell="net"><strong>${esc(money(c.net, cur))}</strong></td>
    </tr>`;
  };
  return `
    <div class="btn-row" style="align-items:center; gap:.6rem; flex-wrap:wrap; margin-bottom:.6rem">
      <label>Period ${pick}</label> ${status}
      <span id="wg-unsaved" class="chip late" hidden>Unsaved changes</span>
    </div>
    <p class="muted" style="margin:-.2rem 0 .6rem">${esc(niceDate(p.start))} – ${esc(niceDate(p.end))} · ${p.kind === 'month' ? 'monthly salaries' : 'hourly, weekly and piece-work staff'}. ${d.status === 'paid' ? 'Paid runs cannot be changed; reopen it if something was wrong.' : 'Type the hours; the pay works out as you go. Save, then print.'}</p>
    ${!d.lines.length ? empty('', 'Nobody in this period', p.kind === 'month' ? 'No staff on a monthly salary yet.' : 'Add staff paid per hour, per week or per piece under Staff.') : `
    <div class="card" style="padding:0; overflow:auto"><table class="tbl wg-tbl">
      <thead><tr><th>Who</th><th>Hours</th><th>Overtime h</th><th>Pieces built</th><th>Bonus</th><th>Advances</th><th>Deductions</th><th class="r">Gross</th><th class="r">UIF 1%</th><th class="r">Net pay</th></tr></thead>
      <tbody>${d.lines.map(rowHtml).join('')}</tbody>
      <tfoot><tr><td colspan="7" class="r"><strong>${t.people} people</strong></td><td class="r nowrap" data-cell="gross"><strong>${esc(money(t.gross, cur))}</strong></td><td class="r nowrap" data-cell="uif"><strong>${esc(money(t.uif, cur))}</strong></td><td class="r nowrap" data-cell="net"><strong>${esc(money(t.net, cur))}</strong></td></tr></tfoot>
    </table></div>
    <div class="btn-row" style="margin-top:.8rem; flex-wrap:wrap">
      ${edit ? `<button class="btn primary" data-act="wg-save">Save</button><button class="btn ghost" data-act="wg-paid" title="Locks the run and stamps it paid">Mark paid</button>` : ''}
      ${d.status === 'paid' && store.can('wages', 'edit') ? '<button class="btn ghost" data-act="wg-reopen">Reopen</button>' : ''}
      <button class="btn ghost" data-act="wg-print-sheet">Print wage sheet</button>
      <button class="btn ghost" data-act="wg-print-slips">Print payslips</button>
      <button class="btn ghost" data-act="wg-export">Export (CSV)</button>
    </div>
    <p class="muted">Company UIF for this run: ${esc(money(t.uifEmployer, cur))} (1%, on top of the pay). PAYE, SDL and the EMP201 are done by your accountant or payroll service from the export.</p>`}`;
}

function historyHtml(cur) {
  if (!runs.length) return empty('', 'No runs yet', 'Each period you save appears here.');
  return `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>Period</th><th>Status</th><th class="r">People</th><th class="r">Gross</th><th class="r">UIF</th><th class="r">Net</th><th></th></tr></thead>
    <tbody>${runs.map(r => { const t = totals(r.lines || []); return `<tr>
      <td><strong>${esc(periodInfo(r.id).label)}</strong><div class="muted">${esc(niceDate(r.start))} – ${esc(niceDate(r.end))}</div></td>
      <td>${r.status === 'paid' ? '<span class="chip st-disp">Paid</span>' : '<span class="chip st-new">Draft</span>'}</td>
      <td class="r">${t.people}</td><td class="r">${esc(money(t.gross, cur))}</td><td class="r">${esc(money(t.uif, cur))}</td><td class="r"><strong>${esc(money(t.net, cur))}</strong></td>
      <td class="r nowrap"><button class="btn ghost sm" data-act="wg-open" data-id="${esc(r.id)}">Open</button></td></tr>`; }).join('')}</tbody></table></div>`;
}

// --------------------------------------------------------------- actions ----

function staffForm(s) {
  return row(field('Name', 'st-name', { value: s.name, placeholder: 'First name and surname' }), field('Job', 'st-job', { value: s.job, placeholder: 'Upholsterer, framer, sewing…' }))
    + row(field('Paid', 'st-type', { type: 'select', value: s.payType || 'hourly', options: PAY_TYPES.map(t => ({ value: t.key, label: t.label + ' — ' + t.hint })) }),
          field('Rate (R)', 'st-rate', { value: s.rate || '', type: 'number', min: 0, step: '0.01', placeholder: 'per hour, per week or per month' }))
    + row(field('Cell number', 'st-phone', { value: s.phone }), field('ID number', 'st-id', { value: s.idNumber, placeholder: 'For the payslip' }))
    + row(field('UIF', 'st-uif', { type: 'select', value: s.uif === false ? 'no' : 'yes', options: [{ value: 'yes', label: 'Yes, 1% each side' }, { value: 'no', label: 'No' }] }),
          field('Bank details', 'st-bank', { value: s.bank, placeholder: 'Bank, account number (for EFT)' }));
}
function readStaff(w) {
  const name = val(w, 'st-name'); if (!name) { toast('Give them a name', 'warn'); return null; }
  const rate = parseFloat(val(w, 'st-rate')) || 0; if (!rate) { toast('Fill in the rate', 'warn'); return null; }
  return { name, job: val(w, 'st-job'), payType: val(w, 'st-type') || 'hourly', rate, phone: val(w, 'st-phone'), idNumber: val(w, 'st-id'), uif: val(w, 'st-uif') !== 'no', bank: val(w, 'st-bank') };
}
export function newStaff() {
  openModal('New staff member', staffForm({}), { okLabel: 'Add', onOk: async (w) => { const d = readStaff(w); if (!d) return false; view = 'staff'; await store.create('staff', { ...d, active: true }); toast(d.name + ' added'); } });
}
export function editStaff(id) {
  const s = staff.find(x => x.id === id); if (!s) return;
  openModal('Edit ' + s.name, staffForm(s), { okLabel: 'Save', onOk: async (w) => { const d = readStaff(w); if (!d) return false; await store.update('staff', id, d); if (draft && draft.status !== 'paid') { const l = lineOf(id); if (l) { Object.assign(l, { name: d.name, job: d.job, payType: d.payType, rate: d.rate, uif: d.uif }); dirty = true; } } toast('Saved'); changed(); } });
}
export async function toggleStaff(id) {
  const s = staff.find(x => x.id === id); if (!s) return;
  const leaving = s.active !== false;
  if (!confirm(leaving ? s.name + ' has left? They stay in past runs and can be brought back.' : 'Bring ' + s.name + ' back?')) return;
  await store.update('staff', id, { active: !leaving });
  if (leaving && draft && draft.status !== 'paid') { draft.lines = draft.lines.filter(l => l.staffId !== id); dirty = true; }
  changed();
}

// Pieces finished in this period that nobody has been paid for yet.
function unassignedPieces() {
  const p = periodInfo(draft.id);
  const taken = new Set(); draft.lines.forEach(l => l.pieces.forEach(pc => taken.add(pc.orderId)));
  runs.forEach(r => { if (r.id !== draft.id) (r.lines || []).forEach(l => (l.pieces || []).forEach(pc => taken.add(pc.orderId))); });
  return allOrders().filter(o => o.status !== 'cancelled' && !taken.has(o.id)).filter(o => { const d = finishedOn(o); return d && d >= p.start && d <= p.end; })
    .sort((a, b) => String(a.orderNo).localeCompare(String(b.orderNo), undefined, { numeric: true }));
}
export function addPiece(staffId) {
  const l = lineOf(staffId); if (!l || draft.status === 'paid') return;
  const free = unassignedPieces();
  if (!free.length) { toast('No finished pieces in this period are still unassigned. Mark job cards Done on the Factory floor first.', 'warn'); return; }
  const hoursOf = (o) => { const p = productByName(o.product); return (p && Number(p.labourHours)) || 0; };
  openModal('Pieces built by ' + l.name, `
    <p class="muted">Finished in this period and not yet paid to anyone. Hours come from the product’s labour hours (Costing); change them if this piece took longer or less.</p>
    <table class="tbl"><thead><tr><th></th><th>Order</th><th>Piece</th><th>Hours</th><th class="r">Pays</th></tr></thead><tbody>
    ${free.map(o => `<tr><td><input type="checkbox" class="wg-pick" value="${esc(o.id)}"></td><td>${esc(o.orderNo || '')}</td><td>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</td>
      <td><input type="number" min="0" step="0.25" value="${esc(String(hoursOf(o) * (o.qty || 1)))}" class="wg-h" data-id="${esc(o.id)}" style="width:5em"></td><td class="r">${esc(money(hoursOf(o) * (o.qty || 1) * l.rate, settings.currency || 'R'))}</td></tr>`).join('')}
    </tbody></table>`, {
    okLabel: 'Add pieces',
    onOk: (w) => {
      const picked = [...w.querySelectorAll('.wg-pick:checked')].map(c => c.value);
      if (!picked.length) { toast('Tick the pieces they built', 'warn'); return false; }
      picked.forEach(id => { const o = allOrders().find(x => x.id === id); const h = parseFloat((w.querySelector('.wg-h[data-id="' + id + '"]') || {}).value) || 0; l.pieces.push({ orderId: id, orderNo: o.orderNo || '', product: o.product || '', hours: h, amount: r2(h * l.rate) }); });
      dirty = true; changed();
    }
  });
}
export function removePiece(staffId, orderId) {
  const l = lineOf(staffId); if (!l || draft.status === 'paid') return;
  l.pieces = l.pieces.filter(p => p.orderId !== orderId); dirty = true; changed();
}
export function addDeduction(staffId) {
  const l = lineOf(staffId); if (!l || draft.status === 'paid') return;
  openModal('Deduction for ' + l.name, row(field('What for', 'dd-what', { placeholder: 'Loan repayment, uniform, absent 2 days…' }), field('Amount (R)', 'dd-amt', { type: 'number', min: 0, step: '0.01' })), {
    okLabel: 'Add', onOk: (w) => { const amt = parseFloat(val(w, 'dd-amt')) || 0; if (!amt) { toast('Fill in the amount', 'warn'); return false; } l.deductions.push({ what: val(w, 'dd-what') || 'Deduction', amount: r2(amt) }); dirty = true; changed(); }
  });
}
export function removeDeduction(staffId, i) {
  const l = lineOf(staffId); if (!l || draft.status === 'paid') return;
  l.deductions.splice(Number(i), 1); dirty = true; changed();
}

function snapshot(d) {
  return { ...d, lines: d.lines.map(l => ({ ...l, figures: calc(l) })), totals: totals(d.lines), updatedAt: store.nowIso() };
}
export async function saveRun() {
  if (!draft) return;
  const data = snapshot(draft);
  await store.batchWrite([{ op: 'create', coll: 'wageRuns', id: draft.id, data }]);
  draft.updatedAt = data.updatedAt; dirty = false;
  toast('Saved: ' + periodInfo(draft.id).label); changed();
}
export async function markPaid() {
  if (!draft) return;
  const t = totals(draft.lines);
  if (!confirm('Mark ' + periodInfo(draft.id).label + ' as paid: ' + money(t.net, settings.currency || 'R') + ' net to ' + t.people + ' people? It locks the run.')) return;
  const data = { ...snapshot(draft), status: 'paid', paidAt: store.nowIso(), paidBy: (store.getUser() || {}).name || '' };
  await store.batchWrite([{ op: 'create', coll: 'wageRuns', id: draft.id, data }]);
  draft = null; dirty = false;
  toast('Paid: ' + periodInfo(data.id).label); changed();
}
export async function reopenRun() {
  if (!draft || draft.status !== 'paid') return;
  if (!confirm('Reopen ' + periodInfo(draft.id).label + '? It goes back to a draft.')) return;
  await store.update('wageRuns', draft.id, { status: 'draft', paidAt: '', paidBy: '' });
  draft = null; dirty = false; changed();
}

// ---------------------------------------------------------------- print -----

const periodLines = (d) => [niceDate(d.start) + ' – ' + niceDate(d.end), d.status === 'paid' ? 'Paid ' + niceDate(String(d.paidAt || '').slice(0, 10)) : 'Draft'];
export function printWageSheet() {
  const d = draft || loadDraft(); const cur = settings.currency || 'R'; const t = totals(d.lines);
  const body = `<div class="page">${docHeader(settings, 'WAGE SHEET', periodInfo(d.id).label, periodLines(d))}
    <table class="pl"><tr><th>Name</th><th>Paid</th><th>Hours</th><th>OT</th><th>Pieces</th><th style="text-align:right">Gross</th><th style="text-align:right">UIF</th><th style="text-align:right">Deductions</th><th style="text-align:right">Advances</th><th style="text-align:right">Net</th><th>Signature</th></tr>
    ${d.lines.map(l => { const c = calc(l); return `<tr><td><b>${esc(l.name)}</b><br><small>${esc(l.job || '')}</small></td><td>${esc(typeLabel(l.payType))}<br><small>${esc(money(l.rate, cur))}</small></td><td>${l.payType === 'weekly' || l.payType === 'monthly' ? '—' : esc(String(l.hours || 0))}</td><td>${esc(String(l.overtime || 0))}</td><td>${l.pieces.length ? l.pieces.length + ' · ' + esc(money(l.pieces.reduce((s, p) => s + p.amount, 0), cur)) : '—'}</td>
      <td style="text-align:right">${esc(money(c.gross, cur))}</td><td style="text-align:right">${esc(money(c.uif, cur))}</td><td style="text-align:right">${esc(money(c.deductions, cur))}</td><td style="text-align:right">${esc(money(c.advances, cur))}</td><td style="text-align:right"><b>${esc(money(c.net, cur))}</b></td><td style="width:16%"></td></tr>`; }).join('')}
    <tr><td colspan="5"><b>Total · ${t.people} people</b></td><td style="text-align:right"><b>${esc(money(t.gross, cur))}</b></td><td style="text-align:right"><b>${esc(money(t.uif, cur))}</b></td><td style="text-align:right"><b>${esc(money(t.deductions, cur))}</b></td><td style="text-align:right"><b>${esc(money(t.advances, cur))}</b></td><td style="text-align:right"><b>${esc(money(t.net, cur))}</b></td><td></td></tr></table>
    <p><small>UIF: 1% from each person (shown) and 1% from the company, ${esc(money(t.uifEmployer, cur))} for this run. PAYE is not worked out here.</small></p></div>`;
  openPrint('Wage sheet ' + d.id, body);
}
export function printPayslips() {
  const d = draft || loadDraft(); const cur = settings.currency || 'R';
  const slip = (l) => { const c = calc(l); const s = staff.find(x => x.id === l.staffId) || {};
    const earn = [['Basic' + (l.payType === 'hourly' ? ' · ' + l.hours + 'h × ' + money(l.rate, cur) : l.payType === 'piece' ? ' · ' + l.pieces.length + ' piece' + (l.pieces.length === 1 ? '' : 's') + (l.hours ? ' + ' + l.hours + 'h' : '') : ''), c.basic]];
    if (c.overtimePay) earn.push(['Overtime · ' + l.overtime + 'h × ' + money(c.hourly * OT, cur), c.overtimePay]);
    if (c.bonus) earn.push(['Bonus', c.bonus]);
    const ded = [['UIF 1%', c.uif]]; l.deductions.forEach(x => ded.push([x.what, x.amount])); if (c.advances) ded.push(['Advances', c.advances]);
    return `<div class="page">${docHeader(settings, 'PAYSLIP', periodInfo(d.id).label, periodLines(d))}
      <table class="pl"><tr><th>Employee</th><th>Job</th><th>ID number</th><th>Paid</th></tr><tr><td><b>${esc(l.name)}</b></td><td>${esc(l.job || '')}</td><td>${esc(s.idNumber || '')}</td><td>${esc(typeLabel(l.payType))} · ${esc(money(l.rate, cur))}</td></tr></table>
      <h2>Earnings</h2><table class="pl">${earn.map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${esc(money(v, cur))}</td></tr>`).join('')}<tr><td><b>Gross</b></td><td style="text-align:right"><b>${esc(money(c.gross, cur))}</b></td></tr></table>
      <h2>Deductions</h2><table class="pl">${ded.map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${esc(money(v, cur))}</td></tr>`).join('')}</table>
      <h2>Net pay: ${esc(money(c.net, cur))}</h2>
      ${l.pieces.length ? `<h2>Pieces</h2><table class="pl"><tr><th>Order</th><th>Piece</th><th>Hours</th><th style="text-align:right">Pays</th></tr>${l.pieces.map(p => `<tr><td>${esc(p.orderNo)}</td><td>${esc(p.product)}</td><td>${esc(String(p.hours))}</td><td style="text-align:right">${esc(money(p.amount, cur))}</td></tr>`).join('')}</table>` : ''}
      <p><small>${s.bank ? 'Paid by EFT to ' + esc(s.bank) + '. ' : ''}Company UIF ${esc(money(c.uifEmployer, cur))} paid on top. PAYE not deducted here.</small></p></div>`; };
  openPrint('Payslips ' + d.id, d.lines.map(slip).join(''));
}
export function exportRun() {
  const d = draft || loadDraft();
  const rows = [['Period', 'From', 'To', 'Name', 'ID number', 'Job', 'Paid', 'Rate', 'Hours', 'Overtime hours', 'Pieces', 'Pieces value', 'Basic', 'Overtime pay', 'Bonus', 'Gross', 'UIF employee', 'UIF employer', 'Deductions', 'Advances', 'Net', 'Status']];
  d.lines.forEach(l => { const c = calc(l); const s = staff.find(x => x.id === l.staffId) || {};
    rows.push([periodInfo(d.id).label, d.start, d.end, l.name, s.idNumber || '', l.job || '', typeLabel(l.payType), l.rate, l.hours || 0, l.overtime || 0, l.pieces.length, r2(l.pieces.reduce((t, p) => t + p.amount, 0)), c.basic, c.overtimePay, c.bonus, c.gross, c.uif, c.uifEmployer, c.deductions, c.advances, c.net, d.status]); });
  download(toCsv(rows), 'wages-' + d.id + '.csv');
  toast('Exported ' + d.lines.length + ' line' + (d.lines.length === 1 ? '' : 's'));
}
