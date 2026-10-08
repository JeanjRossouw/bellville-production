// The stock room — for the stock room manager, who receives, counts and
// gives out, and cannot change prices, materials or purchase orders.
//
//   Receive    against a purchase order, a delivery without one, or a
//              client's own fabric for an order (the order then shows the
//              fabric as received)
//   Give out   stock handed to a person, optionally for an order. This does
//              NOT take it off the shelf count: production already does that
//              when a piece starts (the order's bill of materials). It is a
//              record of who has what, and feeds "issued vs used".
//   Count      the stock take: every material on one page
//   Assets     tools and equipment: received into the register, given to a
//              person, taken back, sent for repair, written off
//   People     the staff the stock room gives stock and tools to (not logins)
//
// Everything lands in stockMoves (see stock.js), so the movement trail is one
// list.
import * as store from './store.js';
import { allMaterials, materialById } from './costing.js';
import { allPurchaseOrders, receivePurchaseOrder, logMove, allMoves, levels } from './stock.js';
import { esc, money, field, row, val, openModal, toast, empty, today, niceDate, addDays } from './ui.js';

let staff = [];
let assets = [];
let onChange = null;
let settings = {};
let view = 'receive';         // receive | issue | count | assets | people | report
let unwatchS = null, unwatchA = null;

export function startStoreroom(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  if (unwatchS) unwatchS();
  if (unwatchA) unwatchA();
  unwatchS = store.watch('storeStaff', rows => { staff = rows.sort((a, b) => String(a.name).localeCompare(String(b.name))); if (onChange) onChange(); });
  unwatchA = store.watch('assets', rows => { assets = rows.sort((a, b) => String(a.name).localeCompare(String(b.name))); if (onChange) onChange(); });
}
export const setStoreroomSettings = (cfg) => { settings = cfg || {}; };
export const setStoreroomView = (v) => { view = v; };

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const qty = (n) => String(r3(n)).replace(/\.0+$/, '');
const activeStaff = () => staff.filter(p => !p.inactive);
const personById = (id) => staff.find(p => p.id === id) || null;
const monthStart = () => today().slice(0, 8) + '01';

// ---------------------------------------------------------------- render ----

export function renderStoreroom(host, orders) {
  const tab = (k, label) => `<button class="btn ${view === k ? 'primary' : 'ghost'} sm" data-act="sr-view" data-to="${k}">${esc(label)}</button>`;
  const openPos = allPurchaseOrders().filter(p => p.status === 'sent' || p.status === 'part');
  const waitingFabric = fabricWaiting(orders);
  let body;
  if (view === 'issue') body = renderIssue(orders);
  else if (view === 'count') body = renderCount();
  else if (view === 'assets') body = renderAssets();
  else if (view === 'people') body = renderPeople();
  else if (view === 'report') body = renderReport();
  else body = renderReceive(openPos, waitingFabric);
  host.innerHTML = `
    <div class="page-head"><div><h1>Stock room</h1><p class="sub">Receive, count, and give out stock and tools. Every movement is recorded.</p></div></div>
    <div class="btn-row" style="margin:.2rem 0 .9rem">
      ${tab('receive', 'Receive' + (openPos.length || waitingFabric.length ? ' (' + (openPos.length + waitingFabric.length) + ')' : ''))}
      ${tab('issue', 'Give out')}${tab('count', 'Stock take')}${tab('assets', 'Tools & assets')}${tab('people', 'People')}${tab('report', 'Issued vs used')}
    </div>
    ${body}`;
}

// ------------------------------------------------------------- receiving ----

// Orders whose fabric is still to come in.
const fabricWaiting = (orders) => (orders || []).filter(o => o.fabric && o.fabricStatus !== 'received' && !['dispatched', 'invoiced'].includes(o.status));

function renderReceive(openPos, waiting) {
  return `
    <div class="card">
      <h2>Deliveries on order</h2>
      ${openPos.length ? openPos.map(p => `<div class="sr-row">
        <div><strong>${esc(p.poNo)}</strong> · ${esc(p.supplier || '')}<div class="muted">${(p.lines || []).map(l => esc(qty((Number(l.qty) || 0) - (Number(l.received) || 0)) + ' ' + (l.unit || '') + ' ' + l.name)).join(' · ')}${p.expectedDate ? ' · expected ' + esc(niceDate(p.expectedDate)) : ''}</div></div>
        <button class="btn primary sm" data-act="sr-receive-po" data-id="${esc(p.id)}">Receive</button></div>`).join('')
        : '<p class="muted">No purchase orders waiting.</p>'}
      <div class="card-actions"><button class="btn ghost" data-act="sr-receive-direct">Delivery without a purchase order</button></div>
    </div>
    <div class="card">
      <h2>Client fabric to come in (${waiting.length})</h2>
      <p class="muted">When a client's fabric arrives, book it to the order: the order then shows the fabric as received, for the factory floor.</p>
      ${waiting.length ? waiting.map(o => `<div class="sr-row">
        <div><strong>${esc(o.orderNo || '')}</strong> · ${esc(o.product || '')}<div class="muted">${esc(o.fabric)} · ${esc(o.customerName || '')}${o.fabricStatus === 'ordered' ? ' · ordered' : ''}</div></div>
        <button class="btn primary sm" data-act="sr-fabric" data-id="${esc(o.id)}">Fabric arrived</button></div>`).join('')
        : '<p class="muted">Every open order has its fabric.</p>'}
    </div>`;
}

export function receivePo(id) { receivePurchaseOrder(id); }

export function receiveDirect() {
  const mats = allMaterials();
  if (!mats.length) { toast('There are no materials yet — the office adds them under Costing', 'warn'); return; }
  openModal('Delivery without a purchase order', `
    ${field('Material', 'rd-mat', { type: 'select', options: mats.map(m => ({ value: m.id, label: m.name + ' (' + (m.unit || '') + ')' })) })}
    ${row(field('Quantity received', 'rd-qty', { type: 'number', min: 0, step: '0.01' }), field('Supplier', 'rd-sup', { placeholder: 'Who delivered it' }))}
    ${field('Delivery note / invoice no.', 'rd-ref', { placeholder: 'From the supplier\'s paperwork' })}`, {
    okLabel: 'Book it in',
    onOk: async (w) => {
      const id = val(w, 'rd-mat'); const q = r3(parseFloat(val(w, 'rd-qty')));
      if (!(q > 0)) { toast('Enter the quantity received', 'warn'); return false; }
      await store.update('materials', id, { onHand: store.inc(q) });
      await logMove(id, q, 'received-direct', val(w, 'rd-ref'), val(w, 'rd-sup'));
      toast(qty(q) + ' ' + ((materialById(id) || {}).unit || '') + ' of ' + ((materialById(id) || {}).name || '') + ' booked in');
    }
  });
}

// A client's own fabric (or fabric bought for one order) has come in.
export function fabricArrived(id, orders) {
  const o = (orders || []).find(x => x.id === id); if (!o) return;
  openModal('Fabric for ' + (o.orderNo || ''), `
    <p><strong>${esc(o.product || '')}</strong> for ${esc(o.customerName || '')}<br><span class="muted">Fabric on the order: ${esc(o.fabric || '')}</span></p>
    ${row(field('Metres received', 'fa-m', { type: 'number', min: 0, step: '0.1' }), field('Rolls / pieces', 'fa-r', { type: 'number', min: 0, step: '1' }))}
    ${field('Note', 'fa-note', { placeholder: 'Colour checked, roll number, shelf…' })}`, {
    okLabel: 'Fabric received',
    onOk: async (w) => {
      const m = r3(parseFloat(val(w, 'fa-m')) || 0), r = parseInt(val(w, 'fa-r'), 10) || 0;
      const what = [m ? qty(m) + ' m' : '', r ? r + (r === 1 ? ' roll' : ' rolls') : ''].filter(Boolean).join(', ');
      await store.update('orders', id, { fabricStatus: 'received', fabricReceivedAt: store.nowIso(), fabricNote: [what, val(w, 'fa-note')].filter(Boolean).join(' · ') },
        'Fabric received in the stock room' + (what ? ': ' + what : ''));
      await logMove('', m, 'client-fabric', o.orderNo, [o.customerName, val(w, 'fa-note')].filter(Boolean).join(' · '), { name: o.fabric || 'Client fabric', unit: 'm' });
      toast((o.orderNo || 'Order') + ': fabric received');
    }
  });
}

// --------------------------------------------------------------- give out ---

function renderIssue(orders) {
  const since = monthStart();
  const recent = allMoves().filter(m => m.kind === 'issued' || m.kind === 'issue-return').slice(0, 60);
  const byPerson = {};
  allMoves().filter(m => (m.kind === 'issued' || m.kind === 'issue-return') && String(m.createdAt || '').slice(0, 10) >= since).forEach(m => {
    const k = m.person || '?'; byPerson[k] = (byPerson[k] || 0) + 1;
  });
  return `
    <div class="card">
      <div class="btn-row"><button class="btn primary" data-act="sr-issue">Give out stock</button><button class="btn ghost" data-act="sr-issue-back">Stock brought back</button></div>
      <p class="muted">Giving out records who took what and for which order. It does not take it off the shelf count: that happens once, when the order starts on the floor.</p>
      ${Object.keys(byPerson).length ? `<p class="muted">This month: ${Object.keys(byPerson).sort().map(k => esc(k) + ' ' + byPerson[k]).join(' · ')}</p>` : ''}
    </div>
    ${recent.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>When</th><th>Who</th><th>What</th><th class="r">Qty</th><th>For</th><th>By</th></tr></thead>
      <tbody>${recent.map(m => `<tr>
        <td class="nowrap">${esc(String(m.createdAt || '').slice(0, 16).replace('T', ' '))}</td>
        <td><strong>${esc(m.person || '')}</strong></td><td>${esc(m.name || '')}</td>
        <td class="r">${m.kind === 'issue-return' ? '<span style="color:#1f7a3a">back ' : ''}${esc(qty(Math.abs(m.qty)))} ${esc(m.unit || '')}${m.kind === 'issue-return' ? '</span>' : ''}</td>
        <td>${esc(m.ref || '')}${m.note ? '<div class="muted">' + esc(m.note) + '</div>' : ''}</td><td>${esc(m.createdBy || '')}</td></tr>`).join('')}</tbody>
    </table></div>` : empty('', 'Nothing given out yet', 'Tap Give out stock when someone takes materials from the stock room.')}`;
}

export function issueStock(back, orders) {
  const people = activeStaff();
  if (!people.length) { toast('Add the people you give stock to first (People tab)', 'warn'); view = 'people'; if (onChange) onChange(); return; }
  const mats = allMaterials();
  const open = (orders || []).filter(o => ['new', 'in-production'].includes(o.status));
  openModal(back ? 'Stock brought back' : 'Give out stock', `
    ${field(back ? 'Brought back by' : 'Given to', 'is-person', { type: 'select', options: people.map(p => ({ value: p.id, label: p.name + (p.job ? ' · ' + p.job : '') })) })}
    ${row(field('Material', 'is-mat', { type: 'select', options: mats.map(m => ({ value: m.id, label: m.name + ' (' + (m.unit || '') + ')' })) }), field('Quantity', 'is-qty', { type: 'number', min: 0, step: '0.01' }))}
    ${field('For order (optional)', 'is-order', { type: 'select', options: [{ value: '', label: '— not for one order —' }].concat(open.map(o => ({ value: o.orderNo, label: o.orderNo + ' · ' + (o.product || '') }))) })}
    ${field('Note', 'is-note', { placeholder: back ? 'Left over, wrong colour…' : 'Anything worth noting' })}`, {
    okLabel: back ? 'Book it back' : 'Give out',
    onOk: async (w) => {
      const p = personById(val(w, 'is-person')); const id = val(w, 'is-mat'); const q = r3(parseFloat(val(w, 'is-qty')));
      if (!p) { toast('Choose the person', 'warn'); return false; }
      if (!(q > 0)) { toast('Enter the quantity', 'warn'); return false; }
      await logMove(id, back ? -q : q, back ? 'issue-return' : 'issued', val(w, 'is-order'), val(w, 'is-note'), { personId: p.id, person: p.name });
      toast(back ? qty(q) + ' brought back by ' + p.name : qty(q) + ' ' + ((materialById(id) || {}).unit || '') + ' given to ' + p.name);
    }
  });
}

// --------------------------------------------------------------- the count --

function renderCount() {
  const mats = allMaterials();
  if (!mats.length) return empty('', 'No materials yet', 'The office adds materials under Costing.');
  return `<div class="card">
    <p class="muted">Count what is on the shelf and type it in. Leave a line empty to skip it. Only the lines you fill in are saved, and every difference is recorded.</p>
    <div style="overflow:auto"><table class="tbl sr-count">
      <thead><tr><th>Material</th><th class="r">System says</th><th class="r">Counted</th><th class="r">Difference</th></tr></thead>
      <tbody>${mats.map(m => `<tr data-id="${esc(m.id)}" data-had="${m.onHand == null ? '' : esc(m.onHand)}">
        <td><strong>${esc(m.name)}</strong><div class="muted">${esc(m.supplier || '')}${m.countedAt ? ' · last counted ' + esc(niceDate(String(m.countedAt).slice(0, 10))) : ''}</div></td>
        <td class="r">${m.onHand == null ? '<span class="muted">never counted</span>' : esc(qty(m.onHand)) + ' ' + esc(m.unit || '')}</td>
        <td class="r"><input class="sr-in" type="number" min="0" step="0.01" placeholder="${esc(m.unit || '')}"></td>
        <td class="r sr-diff muted"></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="card-actions"><button class="btn primary" data-act="sr-count-save">Save the count</button></div>
  </div>`;
}

export function liveCount(host) {
  host.querySelectorAll('.sr-count tbody tr').forEach(tr => {
    const v = tr.querySelector('.sr-in').value; const cell = tr.querySelector('.sr-diff');
    if (v === '') { cell.textContent = ''; return; }
    const d = r3(parseFloat(v) - (parseFloat(tr.dataset.had) || 0));
    cell.textContent = (d > 0 ? '+' : '') + qty(d);
    cell.style.color = d < 0 ? '#b91c1c' : d > 0 ? '#1f7a3a' : '';
  });
}

export async function saveCount(host) {
  const rows = [...host.querySelectorAll('.sr-count tbody tr')].filter(tr => tr.querySelector('.sr-in').value !== '');
  if (!rows.length) { toast('Type in at least one count', 'warn'); return; }
  if (!confirm('Save the count for ' + rows.length + ' material' + (rows.length === 1 ? '' : 's') + '?')) return;
  let changed = 0;
  for (const tr of rows) {
    const id = tr.dataset.id; const counted = r3(parseFloat(tr.querySelector('.sr-in').value));
    if (!(counted >= 0)) continue;
    const had = tr.dataset.had === '' ? null : Number(tr.dataset.had);
    const delta = r3(counted - (had || 0));
    await store.update('materials', id, { onHand: counted, countedAt: store.nowIso() });
    await logMove(id, delta, had == null ? 'opening' : 'count', '', 'Stock take' + (delta ? (delta > 0 ? ': more than recorded' : ': less than recorded') : ': matched'));
    if (delta) changed++;
  }
  toast('Count saved — ' + rows.length + ' counted, ' + changed + ' different from the system');
}

// ---------------------------------------------------------------- assets ----

const ASSET_STATUS = { store: ['In the stock room', 'st-disp'], issued: ['With', 'st-prod'], repair: ['Away for repair', 'st-ready'], gone: ['Written off', 'late'] };
function renderAssets() {
  const shown = assets.filter(a => a.status !== 'gone');
  return `<div class="card">
    <div class="btn-row"><button class="btn primary" data-act="sr-asset-new">＋ Receive a tool or asset</button></div>
    ${shown.length ? `<div style="overflow:auto"><table class="tbl" style="margin-top:.6rem">
      <thead><tr><th>Asset</th><th>Number</th><th>Where it is</th><th></th></tr></thead>
      <tbody>${shown.map(a => { const [l, c] = ASSET_STATUS[a.status] || ASSET_STATUS.store; return `<tr>
        <td><strong>${esc(a.name)}</strong><div class="muted">${esc([a.category, a.serial].filter(Boolean).join(' · '))}</div></td>
        <td>${esc(a.tag || '')}</td>
        <td><span class="chip ${c}">${esc(l)}${a.status === 'issued' ? ' ' + esc(a.holderName || '') : ''}</span>${a.status === 'issued' && a.issuedAt ? '<div class="muted">since ' + esc(niceDate(String(a.issuedAt).slice(0, 10))) + '</div>' : ''}</td>
        <td class="r nowrap">
          ${a.status === 'store' ? `<button class="btn primary sm" data-act="sr-asset-give" data-id="${esc(a.id)}">Give out</button>` : `<button class="btn primary sm" data-act="sr-asset-back" data-id="${esc(a.id)}">Back in store</button>`}
          ${a.status !== 'repair' ? `<button class="btn ghost sm" data-act="sr-asset-repair" data-id="${esc(a.id)}">Repair</button>` : ''}
          <button class="btn ghost sm" data-act="sr-asset-history" data-id="${esc(a.id)}">History</button>
          <button class="btn ghost sm" data-act="sr-asset-gone" data-id="${esc(a.id)}">Write off</button>
        </td></tr>`; }).join('')}</tbody></table></div>`
      : '<p class="muted">No tools or assets in the register yet. Staple guns, compressors, sewing machines, ladders, trolleys: anything that gets lent out.</p>'}
  </div>`;
}

export function newAsset() {
  openModal('Receive a tool or asset', `
    ${row(field('What is it', 'as-name', { placeholder: 'e.g. Pneumatic staple gun' }), field('Asset number / tag', 'as-tag', { placeholder: 'e.g. T-014' }))}
    ${row(field('Kind', 'as-cat', { placeholder: 'Tool, machine, vehicle…' }), field('Serial number', 'as-serial'))}
    ${field('Note', 'as-note', { placeholder: 'Condition, where it came from' })}`, {
    okLabel: 'Add to the register',
    onOk: async (w) => {
      const name = val(w, 'as-name'); if (!name) { toast('Say what it is', 'warn'); return false; }
      await store.create('assets', { name, tag: val(w, 'as-tag'), category: val(w, 'as-cat'), serial: val(w, 'as-serial'), notes: val(w, 'as-note'), status: 'store',
        events: [{ at: store.nowIso(), by: (store.getUser() || {}).name || '', what: 'Received into the stock room' }] });
      toast(name + ' added');
    }
  });
}

export function giveAsset(id) {
  const a = assets.find(x => x.id === id); if (!a) return;
  const people = activeStaff();
  if (!people.length) { toast('Add the people first (People tab)', 'warn'); return; }
  openModal('Give out ' + a.name, field('Given to', 'ag-p', { type: 'select', options: people.map(p => ({ value: p.id, label: p.name })) }) + field('Note', 'ag-note', { placeholder: 'Condition when handed over' }), {
    okLabel: 'Give out',
    onOk: async (w) => {
      const p = personById(val(w, 'ag-p')); if (!p) return false;
      await store.update('assets', id, { status: 'issued', holderId: p.id, holderName: p.name, issuedAt: store.nowIso() }, 'Given to ' + p.name + (val(w, 'ag-note') ? ' (' + val(w, 'ag-note') + ')' : ''));
      toast(a.name + ' given to ' + p.name);
    }
  });
}
export async function assetBack(id) {
  const a = assets.find(x => x.id === id); if (!a) return;
  const note = prompt('Back in the stock room. Any note on its condition?', '');
  if (note === null) return;
  await store.update('assets', id, { status: 'store', holderId: '', holderName: '', issuedAt: null }, 'Back in the stock room' + (a.holderName ? ' from ' + a.holderName : '') + (note ? ' (' + note + ')' : ''));
}
export async function assetRepair(id) {
  const a = assets.find(x => x.id === id); if (!a) return;
  const where = prompt('Sent for repair. Where to, and what is wrong?', ''); if (where === null) return;
  await store.update('assets', id, { status: 'repair', holderId: '', holderName: '' }, 'Sent for repair' + (where ? ': ' + where : ''));
}
export async function assetGone(id) {
  const a = assets.find(x => x.id === id); if (!a) return;
  const why = prompt('Write off ' + a.name + '. Why? (broken, lost, stolen…)', ''); if (why === null) return;
  await store.update('assets', id, { status: 'gone', holderId: '', holderName: '' }, 'Written off' + (why ? ': ' + why : ''));
}
export function assetHistory(id) {
  const a = assets.find(x => x.id === id); if (!a) return;
  openModal(a.name + (a.tag ? ' · ' + a.tag : ''), (a.events || []).slice().reverse().map(e => `<div class="sr-row"><div>${esc(e.what)}<div class="muted">${esc(String(e.at || '').slice(0, 16).replace('T', ' '))} · ${esc(e.by || '')}</div></div></div>`).join('') || '<p class="muted">No history yet.</p>',
    { okLabel: 'Close', onOk: () => true });
}

// ---------------------------------------------------------------- people ----

function renderPeople() {
  return `<div class="card">
    <div class="btn-row"><button class="btn primary" data-act="sr-person-new">＋ Person</button></div>
    <p class="muted">The people the stock room gives stock and tools to. They do not need a login.</p>
    ${staff.length ? staff.map(p => {
      const tools = assets.filter(a => a.status === 'issued' && a.holderId === p.id);
      return `<div class="team-row">
        <div><div class="who-n">${esc(p.name)}${p.inactive ? ' <span class="muted">(left)</span>' : ''}</div><div class="who-e">${esc([p.job, p.phone].filter(Boolean).join(' · '))}</div></div>
        <div class="who-e">${tools.length ? 'Has: ' + tools.map(a => esc(a.name + (a.tag ? ' ' + a.tag : ''))).join(', ') : ''}</div>
        <div class="team-acts"><button class="btn ghost sm" data-act="sr-person-edit" data-id="${esc(p.id)}">Edit</button>
          <button class="btn ghost sm" data-act="sr-person-toggle" data-id="${esc(p.id)}">${p.inactive ? 'Back at work' : 'Has left'}</button></div></div>`;
    }).join('') : '<p class="muted">Nobody yet.</p>'}
  </div>`;
}
function personForm(p) {
  return row(field('Name', 'sp-name', { value: p.name }), field('Job', 'sp-job', { value: p.job, placeholder: 'Upholsterer, framer, sewing…' })) + field('Cell number', 'sp-phone', { value: p.phone });
}
export function newPerson() {
  openModal('New person', personForm({}), { okLabel: 'Add', onOk: async (w) => { const name = val(w, 'sp-name'); if (!name) return false; await store.create('storeStaff', { name, job: val(w, 'sp-job'), phone: val(w, 'sp-phone') }); toast(name + ' added'); } });
}
export function editPerson(id) {
  const p = personById(id); if (!p) return;
  openModal('Edit ' + p.name, personForm(p), { okLabel: 'Save', onOk: async (w) => { const name = val(w, 'sp-name'); if (!name) return false; await store.update('storeStaff', id, { name, job: val(w, 'sp-job'), phone: val(w, 'sp-phone') }); } });
}
export async function togglePerson(id) {
  const p = personById(id); if (!p) return;
  const tools = assets.filter(a => a.status === 'issued' && a.holderId === p.id);
  if (!p.inactive && tools.length && !confirm(p.name + ' still has ' + tools.map(a => a.name).join(', ') + '. Mark them as left anyway?')) return;
  await store.update('storeStaff', id, { inactive: !p.inactive });
}

// ---------------------------------------------------------- issued vs used --
// What was handed out against what production should have used (the bills
// of materials of pieces started), this month and last. A big gap is waste,
// a wrong bill of materials, or stock walking out.

function renderReport() {
  const from = monthStart();
  const prev = addDays(from, -1).slice(0, 8) + '01';
  const sum = (since, until) => {
    const t = {};
    allMoves().forEach(m => {
      const d = String(m.createdAt || '').slice(0, 10);
      if (!m.materialId || d < since || (until && d >= until)) return;
      const x = t[m.materialId] = t[m.materialId] || { issued: 0, used: 0 };
      if (m.kind === 'issued' || m.kind === 'issue-return') x.issued += Number(m.qty) || 0;
      if (m.kind === 'used' || m.kind === 'returned') x.used -= Number(m.qty) || 0;
    });
    return t;
  };
  const table = (title, t) => {
    const ids = Object.keys(t).filter(id => t[id].issued || t[id].used);
    if (!ids.length) return `<div class="card"><h2>${esc(title)}</h2><p class="muted">Nothing given out or used yet.</p></div>`;
    return `<div class="card" style="padding:0; overflow:auto"><h2 style="padding:1rem 1rem 0">${esc(title)}</h2><table class="tbl">
      <thead><tr><th>Material</th><th class="r">Given out</th><th class="r">Should have used</th><th class="r">Difference</th></tr></thead>
      <tbody>${ids.map(id => { const m = materialById(id) || {}; const x = t[id]; const d = r3(x.issued - x.used); const pct = x.used ? d / x.used : null;
        const flag = x.used ? Math.abs(pct) > 0.1 : x.issued > 0;
        return `<tr><td><strong>${esc(m.name || '?')}</strong></td><td class="r">${esc(qty(x.issued))} ${esc(m.unit || '')}</td><td class="r">${esc(qty(x.used))} ${esc(m.unit || '')}</td>
          <td class="r"><strong style="color:${flag ? '#b91c1c' : 'inherit'}">${d > 0 ? '+' : ''}${esc(qty(d))}</strong>${pct != null ? ' <span class="muted">(' + Math.round(pct * 100) + '%)</span>' : ''}</td></tr>`; }).join('')}</tbody></table>
      <p class="muted" style="padding:0 1rem 1rem">More given out than the orders needed shows in red (over 10%).${store.can('costing') ? ' The value on the shelf: ' + esc(money(levels([]).rows.reduce((s, r) => s + Math.max(0, r.onHand) * (Number(r.m.cost) || 0), 0), settings.currency || 'R')) + '.' : ''}</p></div>`;
  };
  return table('This month', sum(from)) + table('Last month', sum(prev, from));
}
