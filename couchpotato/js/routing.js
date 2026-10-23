// Routings — how a product is built, step by step, and what an hour at each
// place costs. Set up once (Costing → Workstations), then every order of the
// product gets one job card per step when it is released to the floor.
//
//   workstations/<id>  name, staffHourlyCost (what the people normally there
//                      cost an hour, together), sort, active
//   operations/<id>    name, workstationId, qc (a check that passes or sends
//                      the piece back), sort, active; outsourced (a supplier
//                      does it: supplier, outsideCost a piece excl. VAT, days
//                      it usually takes)
//   products/<id>      routing: [{ operationId, stdMinutes }], in build order
//   settings/factory   productiveHours (worked hours a month, all staff),
//                      dayEnd ('17:00': a job left running is stopped there)
//
// A station's rate = its people's cost an hour + the overhead an hour, and
// the overhead an hour = the month's overheads ÷ its productive hours. The
// rate is worked out when it is used, and every time entry keeps the rate of
// its day, so a later change never rewrites what an old order cost.
import * as store from './store.js';
import { esc, money, field, row, val, openModal, toast, empty } from './ui.js';
import { allSuppliers } from './suppliers.js';

let workstations = [];
let operations = [];
let settings = {};
let onChange = null;
let unwatch = [];

const bySort = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name || '').localeCompare(String(b.name || ''));
export function startRouting(cb, cfg) {
  onChange = cb; settings = cfg || {};
  unwatch.forEach(u => u()); unwatch = [];
  unwatch.push(store.watch('workstations', rows => { workstations = rows.sort(bySort); if (onChange) onChange(); }));
  unwatch.push(store.watch('operations', rows => { operations = rows.sort(bySort); if (onChange) onChange(); }));
}
export const setRoutingSettings = (cfg) => { settings = cfg || {}; };
export const allWorkstations = () => workstations.filter(w => w.active !== false);
export const workstationById = (id) => workstations.find(w => w.id === id) || null;
export const allOperations = () => operations.filter(o => o.active !== false);
export const operationById = (id) => operations.find(o => o.id === id) || null;

const cur = () => settings.currency || 'R';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const monthlyOverheads = () => (settings.overheads || []).reduce((s, o) => s + (Number(o.monthly) || 0), 0);
export function overheadPerHour() {
  const h = Number(settings.productiveHours) || 0;
  return h > 0 ? monthlyOverheads() / h : 0;
}
export const stationRate = (ws) => ws ? r2((Number(ws.staffHourlyCost) || 0) + overheadPerHour()) : 0;

// A product's steps, with what each is and where it is done. Steps whose
// operation was since removed are left out.
export function routingOf(p) {
  return ((p && p.routing) || []).map(r => {
    const op = operationById(r.operationId);
    return op ? { operationId: op.id, stdMinutes: Number(r.stdMinutes) || 0, op, ws: workstationById(op.workstationId) } : null;
  }).filter(Boolean);
}
export const routingMinutes = (p) => routingOf(p).reduce((s, r) => s + r.stdMinutes, 0);
export const hm = (min) => { const m = Math.round(Number(min) || 0); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''); };

// ------------------------------------------------------- the setup tab ----

export function stationsTabHtml() {
  const c = cur(), oh = monthlyOverheads(), ph = Number(settings.productiveHours) || 0;
  const editable = store.can('costing', 'edit');
  const ohCard = `<div class="card">
      <h2>Overhead an hour</h2>
      <p class="muted">Every station's rate carries a share of the overheads. Productive hours are the hours worked on the floor in a month, by everyone together (for example 8 people × 45 hours × 4.3 weeks ≈ 1 550).</p>
      ${row(
        field('Productive hours a month', 'ws-hours', { value: ph || '', type: 'number', min: 0, placeholder: 'e.g. 1550' }),
        field('A job left running stops at', 'ws-dayend', { value: settings.dayEnd || '17:00', type: 'time' })
      )}
      <div class="cost-live"><div class="tot"><span>Overheads ${esc(money(oh, c))} a month ÷ ${ph || '—'} hours</span><strong>${esc(money(overheadPerHour(), c))} / h</strong></div></div>
      ${!oh ? '<p class="muted">No overheads entered yet: add them under the Overheads & labour tab.</p>' : ''}
      ${store.can('settings', 'edit') ? '<div class="card-actions"><button class="btn primary" data-act="ws-save-hours">Save</button></div>' : '<p class="muted">The owner (or whoever may change the business settings) saves these.</p>'}
    </div>`;
  const wsHead = `<div class="page-head" style="margin:0 0 .6rem"><div><h2 style="margin:0">Workstations</h2><p class="sub">A place or team that does one kind of work. Its rate is what an hour there costs.</p></div>
    ${editable ? '<div class="btn-row">' + (!workstations.length ? '<button class="btn ghost" data-act="ws-starter" title="Cutting, frames, sewing, upholstery, QC and packing, with their steps">Add the usual upholstery set-up</button>' : '') + '<button class="btn primary" data-act="ws-new">＋ Workstation</button></div>' : ''}</div>`;
  const wsBody = !workstations.length ? empty('', 'No workstations yet', 'Add the places work is done: cutting table, frame shop, sewing, upholstery, QC, packing.')
    : `<div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <thead><tr><th>Workstation</th><th class="r">People / h</th><th class="r">Overhead / h</th><th class="r">Rate / h</th><th>Steps done here</th><th></th></tr></thead>
      <tbody>${workstations.map(w => `<tr class="${w.active === false ? 'muted' : ''}">
        <td><strong>${esc(w.name)}</strong>${w.active === false ? ' <span class="chip">not in use</span>' : ''}</td>
        <td class="r">${esc(money(w.staffHourlyCost, c))}</td>
        <td class="r">${esc(money(overheadPerHour(), c))}</td>
        <td class="r"><strong>${esc(money(stationRate(w), c))}</strong></td>
        <td>${esc(operations.filter(o => o.workstationId === w.id && o.active !== false).map(o => o.name).join(', ') || '—')}</td>
        <td class="r nowrap">${editable ? `<button class="btn ghost sm" data-act="ws-edit" data-id="${esc(w.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const opHead = `<div class="page-head" style="margin:1.2rem 0 .6rem"><div><h2 style="margin:0">Steps</h2><p class="sub">One step of work, done at one workstation. A product's routing lists its steps in order, each with its standard time.</p></div>
    ${editable && workstations.length ? '<button class="btn primary" data-act="op-new">＋ Step</button>' : ''}</div>`;
  const opBody = !operations.length ? empty('', 'No steps yet', workstations.length ? 'Add the steps: build frame, cut fabric, sew covers, upholster, QC check, pack.' : 'Add a workstation first.')
    : `<div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <thead><tr><th>Step</th><th>Workstation</th><th></th><th></th></tr></thead>
      <tbody>${operations.map(o => `<tr class="${o.active === false ? 'muted' : ''}">
        <td><strong>${esc(o.name)}</strong>${o.active === false ? ' <span class="chip">not in use</span>' : ''}</td>
        <td>${o.outsourced ? 'outside: ' + esc(o.supplier || 'a supplier') : esc((workstationById(o.workstationId) || {}).name || '—')}</td>
        <td>${o.qc ? '<span class="chip calm">check: pass or send back</span>' : ''}${o.outsourced ? `<span class="chip">${esc(money(o.outsideCost || 0, cur()))} a piece${o.days ? ', ' + esc(o.days) + ' days' : ''}</span>` : ''}</td>
        <td class="r nowrap">${editable ? `<button class="btn ghost sm" data-act="op-edit" data-id="${esc(o.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  return ohCard + wsHead + wsBody + opHead + opBody;
}

export async function saveHours(host) {
  const patch = { productiveHours: parseFloat(val(host, 'ws-hours')) || 0, dayEnd: val(host, 'ws-dayend') || '17:00' };
  await store.saveSettings(patch);
  settings = { ...settings, ...patch };
  toast('Saved: overhead ' + money(overheadPerHour(), cur()) + ' an hour');
  return patch;
}

function wsForm(w) {
  w = w || {};
  return row(
    field('Workstation', 'ws-name', { value: w.name, placeholder: 'e.g. Upholstery' }),
    field('What its people cost an hour, together (' + cur() + ')', 'ws-cost', { value: w.staffHourlyCost == null ? '' : w.staffHourlyCost, type: 'number', min: 0, step: '0.01', placeholder: 'e.g. 2 people at R60 = 120' })
  ) + (w.id ? `<label class="check"><input type="checkbox" id="ws-off"${w.active === false ? ' checked' : ''}> Not in use any more (kept for past orders)</label>` : '');
}
const readWs = (m) => ({ name: val(m, 'ws-name').trim(), staffHourlyCost: parseFloat(val(m, 'ws-cost')) || 0, ...(m.querySelector('#ws-off') ? { active: !m.querySelector('#ws-off').checked } : {}) });
export function newWorkstation() {
  openModal('New workstation', wsForm(null), { okLabel: 'Save', onOk: async (m) => {
    const d = readWs(m); if (!d.name) { toast('Give it a name', 'warn'); return false; }
    await store.create('workstations', { ...d, active: true, sort: workstations.length + 1 }); toast(d.name + ' added');
  } });
}
export function editWorkstation(id) {
  const w = workstationById(id); if (!w) return;
  openModal('Edit ' + w.name, wsForm(w), { okLabel: 'Save', onOk: async (m) => {
    const d = readWs(m); if (!d.name) { toast('Give it a name', 'warn'); return false; }
    await store.update('workstations', id, d, 'Rate or name changed'); toast('Saved');
  } });
}

function opForm(o) {
  o = o || {};
  return row(
    field('Step', 'op-name', { value: o.name, placeholder: 'e.g. Upholster' }),
    field('Done at', 'op-ws', { type: 'select', value: o.workstationId || '', options: [{ value: '', label: '— (done outside, by a supplier)' }].concat(allWorkstations().map(w => ({ value: w.id, label: w.name }))) })
  ) + `<label class="check"><input type="checkbox" id="op-qc"${o.qc ? ' checked' : ''}> A check: it passes, or sends the piece back to an earlier step to be fixed</label>`
    + `<label class="check"><input type="checkbox" id="op-out"${o.outsourced ? ' checked' : ''}> Done outside, by a supplier (frames bought in, CNC parts, spraying): it is sent and booked back in, not timed on a tablet</label>`
    + `<div id="op-out-box"${o.outsourced ? '' : ' hidden'}>${row(
        field('Supplier', 'op-sup', { value: o.supplier, list: 'op-sup-list', placeholder: 'Who does it' }),
        field('Their price a piece, excl. VAT (' + cur() + ')', 'op-cost', { value: o.outsideCost == null ? '' : o.outsideCost, type: 'number', min: 0, step: '0.01' })
      )}${row(field('Days it usually takes', 'op-days', { value: o.days || '', type: 'number', min: 0, step: '1', placeholder: 'e.g. 5' }), '<div></div>')}
      <datalist id="op-sup-list">${allSuppliers().map(x => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>`
    + (o.id ? `<label class="check"><input type="checkbox" id="op-off"${o.active === false ? ' checked' : ''}> Not in use any more</label>` : '');
}
const readOp = (m) => {
  const out = !!m.querySelector('#op-out').checked;
  return { name: val(m, 'op-name').trim(), workstationId: out ? '' : val(m, 'op-ws'), qc: !!m.querySelector('#op-qc').checked, outsourced: out,
    supplier: out ? val(m, 'op-sup').trim() : '', outsideCost: out ? parseFloat(val(m, 'op-cost')) || 0 : 0, days: out ? parseInt(val(m, 'op-days'), 10) || 0 : 0,
    ...(m.querySelector('#op-off') ? { active: !m.querySelector('#op-off').checked } : {}) };
};
const opOk = (d) => d.name && (d.outsourced || d.workstationId);
function wireOp(w) {
  const out = w.querySelector('#op-out'), box = w.querySelector('#op-out-box');
  out.addEventListener('change', () => { box.hidden = !out.checked; });
}
export function newOperation() {
  const { wrap } = openModal('New step', opForm(null), { okLabel: 'Save', onOk: async (m) => {
    const d = readOp(m); if (!opOk(d)) { toast('Name the step and say where it is done (or tick done outside)', 'warn'); return false; }
    await store.create('operations', { ...d, active: true, sort: operations.length + 1 }); toast(d.name + ' added');
  } });
  wireOp(wrap);
}
export function editOperation(id) {
  const o = operationById(id); if (!o) return;
  const { wrap } = openModal('Edit ' + o.name, opForm(o), { okLabel: 'Save', onOk: async (m) => {
    const d = readOp(m); if (!opOk(d)) { toast('Name the step and say where it is done (or tick done outside)', 'warn'); return false; }
    await store.update('operations', id, d); toast('Saved');
  } });
  wireOp(wrap);
}

// A sofa factory's usual floor, to change rather than type from nothing.
const STARTER = [
  ['Frame shop', 0, [['Build frame']]],
  ['Cutting table', 0, [['Cut fabric']]],
  ['Sewing', 0, [['Sew covers']]],
  ['Upholstery', 0, [['Upholster']]],
  ['QC', 0, [['QC check', true]]],
  ['Packing', 0, [['Pack']]]
];
export async function addStarter() {
  if (workstations.length) return;
  const ops = [];
  STARTER.forEach(([name, cost, steps], i) => {
    const id = store.newId('workstations');
    ops.push({ op: 'create', coll: 'workstations', id, data: { name, staffHourlyCost: cost, active: true, sort: i + 1 } });
    steps.forEach(([sname, qc]) => ops.push({ op: 'create', coll: 'operations', id: store.newId('operations'), data: { name: sname, workstationId: id, qc: !!qc, active: true, sort: i + 1 } }));
  });
  await store.batchWrite(ops);
  toast('Added six workstations and their steps: now put in what each station\'s people cost an hour (Edit)');
}

// --------------------------------------------- the routing on a product ----

function stepRow(r, i) {
  r = r || {};
  return `<div class="rt-row" data-row="${i}">
    <select class="rt-op"><option value="">— step —</option>${operations.filter(o => o.active !== false || o.id === r.operationId).map(o => `<option value="${esc(o.id)}"${o.id === r.operationId ? ' selected' : ''}>${esc(o.name)} · ${esc((workstationById(o.workstationId) || {}).name || '')}${o.active === false ? ' (not in use)' : ''}</option>`).join('')}</select>
    <input class="rt-min" type="number" min="0" step="1" value="${esc(r.stdMinutes == null ? '' : r.stdMinutes)}" placeholder="min">
    <span class="rt-up muted"></span>
    <button type="button" class="icon-btn rt-del" title="Remove">✕</button>
  </div>`;
}
export function routingFieldHtml(p, products) {
  const steps = p && p.routing && p.routing.length ? p.routing : [];
  if (!operations.length) return `<div class="fld"><span>Routing (the steps, in order)</span><p class="muted">No steps set up yet: add them under the Workstations tab, then each product gets its steps and standard times here.</p></div>`;
  const others = (products || []).filter(x => x.id !== (p && p.id) && x.routing && x.routing.length);
  return `<div class="fld"><span>Routing: the steps in build order, minutes for one piece</span>
    <div id="rt">${(steps.length ? steps : [{}]).map(stepRow).join('')}</div>
    <div class="btn-row" style="margin-top:.4rem"><button type="button" class="btn ghost sm" id="rt-add">＋ Add a step</button>
      ${others.length ? `<select id="rt-copy" class="sm"><option value="">Copy the steps of…</option>${others.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>` : ''}</div>
    <p class="muted" id="rt-total"></p></div>`;
}
export function readRouting(w) {
  const out = [];
  w.querySelectorAll('.rt-row').forEach(r => {
    const operationId = r.querySelector('.rt-op').value, stdMinutes = parseFloat(r.querySelector('.rt-min').value) || 0;
    if (operationId) out.push({ operationId, stdMinutes });
  });
  return out;
}
export function wireRouting(w, products) {
  const box = w.querySelector('#rt'); if (!box) return;
  const total = () => {
    const t = readRouting(w), mins = t.reduce((s, r) => s + r.stdMinutes, 0);
    const cost = t.reduce((s, r) => { const op = operationById(r.operationId) || {}; return s + (op.outsourced ? Number(op.outsideCost) || 0 : r.stdMinutes / 60 * stationRate(workstationById(op.workstationId))); }, 0);
    const el = w.querySelector('#rt-total');
    if (el) el.textContent = t.length ? t.length + ' step' + (t.length === 1 ? '' : 's') + ' · ' + hm(mins) + ' a piece · labour at the station rates (and outside work at its price) ' + money(cost, cur()) : 'No steps: orders of this product are built the old way, without job cards.';
  };
  w.querySelector('#rt-add').addEventListener('click', () => { box.insertAdjacentHTML('beforeend', stepRow({}, box.children.length)); total(); });
  box.addEventListener('click', (e) => { const b = e.target.closest('.rt-del'); if (b) { b.closest('.rt-row').remove(); total(); } });
  box.addEventListener('input', total); box.addEventListener('change', total);
  const copy = w.querySelector('#rt-copy');
  if (copy) copy.addEventListener('change', () => {
    const src = (products || []).find(x => x.id === copy.value); if (!src) return;
    box.innerHTML = src.routing.map(stepRow).join(''); copy.value = ''; total();
  });
  total();
}
