// Stock — the materials on the shelf, what the open orders still need, and
// purchase orders to the suppliers.
//
//   on hand      counted, then kept up to date automatically:
//                − taken when a piece goes into production (its bill of
//                  materials × the quantity ordered)
//                + given back if it is moved back to New, or deleted unbuilt
//                + received against a purchase order
//                = set by a stock count
//   needed       what the orders not started yet will take
//   on order     sent purchase orders not yet received
//   after that  on hand − needed + on order: below the reorder level means
//                it is time to order, and the Order now list says how much
//
// Every change is written to stockMoves, so "where did the foam go" always
// has an answer. Counts are changed with an increment, never read-and-write,
// so two people using and receiving stock at the same moment cannot lose
// each other's change.
import * as store from './store.js';
import { allMaterials, materialById, productByName } from './costing.js';
import { esc, money, field, row, val, openModal, toast, empty, today, niceDate, addDays, openPrint, docHeader, waDigits } from './ui.js';

let pos = [];
let moves = [];
let settings = {};
let onChange = null;
let view = 'materials';      // materials | orders | moves
let unwatchPo = null, unwatchMv = null;

export function startStock(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  if (unwatchPo) unwatchPo();
  if (unwatchMv) unwatchMv();
  unwatchPo = store.watch('purchaseOrders', rows => {
    pos = rows.sort((a, b) => String(b.poNo || '').localeCompare(String(a.poNo || ''), undefined, { numeric: true }));
    if (onChange) onChange();
  });
  unwatchMv = store.watch('stockMoves', rows => {
    moves = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 400);
    if (onChange) onChange();
  });
}
export const setStockSettings = (cfg) => { settings = cfg || {}; };
export const setStockView = (v) => { view = v; };
export const allPurchaseOrders = () => pos;
const poById = (id) => pos.find(p => p.id === id) || null;

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const qtyTxt = (n) => String(r3(n)).replace(/\.0+$/, '');
const who = () => (store.getUser() || {}).name || 'system';
const cur = () => settings.currency || 'R';

// ------------------------------------------------------- what orders take ---

// The materials one order takes: its product's bill of materials × quantity.
// null when the product is not in the catalogue (nothing to work out).
export function needsFor(o) {
  const p = productByName(o && o.product);
  if (!p) return null;
  const q = Number(o.qty) || 1;
  return (p.materials || [])
    .filter(l => l.materialId && Number(l.qty) > 0)
    .map(l => ({ materialId: l.materialId, qty: r3(Number(l.qty) * q) }));
}

// Every change to the shelf, and every hand-out to a person, is one line
// here. `extra` carries who stock was given to (personId, person).
export async function logMove(materialId, qty, kind, ref, note, extra) {
  const m = materialById(materialId) || {};
  await store.create('stockMoves', { materialId: materialId || '', name: (extra && extra.name) || m.name || '', unit: (extra && extra.unit) || m.unit || '', qty: r3(qty), kind, ref: ref || '', note: note || '', ...(extra || {}) });
}
export const allMoves = () => moves;
// Moves that record who has stock, without changing the count on the shelf.
export const ALLOCATION = ['issued', 'issue-return', 'client-fabric'];

// A piece goes into production: its materials come off the shelf, once.
export async function consumeForOrder(o) {
  if (!o || o.materialsUsed) return 0;
  const need = (needsFor(o) || []).filter(l => materialById(l.materialId));
  if (!need.length) return 0;
  await store.update('orders', o.id, { materialsUsed: need, materialsUsedAt: store.nowIso() }, 'Materials taken from stock');
  for (const l of need) {
    await store.update('materials', l.materialId, { onHand: store.inc(-l.qty) });
    await logMove(l.materialId, -l.qty, 'used', o.orderNo, o.product);
  }
  return need.length;
}

// Moved back to New, or deleted before it was built: the materials go back.
export async function returnForOrder(o, why) {
  if (!o || !Array.isArray(o.materialsUsed) || !o.materialsUsed.length) return 0;
  const back = o.materialsUsed.filter(l => materialById(l.materialId));
  for (const l of back) {
    await store.update('materials', l.materialId, { onHand: store.inc(l.qty) });
    await logMove(l.materialId, l.qty, 'returned', o.orderNo, why || 'Back to stock');
  }
  if (why !== 'deleted') await store.update('orders', o.id, { materialsUsed: null, materialsUsedAt: null }, 'Materials put back in stock');
  return back.length;
}

// ------------------------------------------------------------ the levels ----

// For every material: on hand, needed by orders not started, on order, and
// what is left after all of that.
export function levels(orders) {
  const map = {};
  allMaterials().forEach(m => {
    map[m.id] = { m, onHand: Number(m.onHand) || 0, counted: m.onHand != null, needed: 0, onOrder: 0, waiting: 0 };
  });
  let unknown = 0;
  (orders || []).filter(o => o.status === 'new' && !o.materialsUsed).forEach(o => {
    const need = needsFor(o);
    if (!need) { unknown++; return; }
    need.forEach(l => { if (map[l.materialId]) { map[l.materialId].needed += l.qty; map[l.materialId].waiting++; } });
  });
  pos.filter(p => p.status === 'sent' || p.status === 'part').forEach(p => (p.lines || []).forEach(l => {
    const out = (Number(l.qty) || 0) - (Number(l.received) || 0);
    if (out > 0 && map[l.materialId]) map[l.materialId].onOrder += out;
  }));
  const rows = Object.values(map).map(x => {
    const after = r3(x.onHand - x.needed + x.onOrder);
    const level = Number(x.m.reorderLevel) || 0;
    const tracked = x.counted || level > 0 || x.needed > 0;
    const short = tracked && (after < 0 || (level > 0 && after < level));
    const suggest = short ? Math.ceil(Math.max(Number(x.m.reorderQty) || 0, level - after, -after)) : 0;
    return { ...x, needed: r3(x.needed), onOrder: r3(x.onOrder), after, level, tracked, short, suggest };
  }).sort((a, b) => (b.short - a.short) || String(a.m.name).localeCompare(String(b.m.name)));
  return { rows, unknown };
}

// ------------------------------------------------------------- rendering ----

export function renderStock(host, orders) {
  const { rows, unknown } = levels(orders);
  const shorts = rows.filter(r => r.short);
  const open = pos.filter(p => p.status === 'sent' || p.status === 'part');
  const tab = (k, label) => `<button class="btn ${view === k ? 'primary' : 'ghost'} sm" data-act="stock-view" data-to="${k}">${esc(label)}</button>`;
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${esc(String(n))}</div><div class="tile-l">${esc(label)}</div></div>`;
  let body;
  if (view === 'orders') body = renderPOs();
  else if (view === 'moves') body = renderMoves();
  else body = renderLevels(rows, shorts, unknown);
  host.innerHTML = `
    <div class="page-head"><div><h1>Stock</h1><p class="sub">Materials on the shelf, what the orders still need, and what to order.</p></div>
      <div class="btn-row"><button class="btn primary" data-act="po-new">＋ Purchase order</button></div></div>
    <div class="tiles">
      ${tile(rows.filter(r => r.tracked).length, 'Materials tracked')}
      ${tile(shorts.length, 'To order now', shorts.length ? 'red' : '')}
      ${tile(open.length, 'Purchase orders out', open.length ? 'amber' : '')}
      <div class="tile wide"><div class="tile-n">${esc(money(rows.reduce((s, r) => s + Math.max(0, r.onHand) * (Number(r.m.cost) || 0), 0), cur()))}</div><div class="tile-l">Value on the shelf</div></div>
    </div>
    <div class="btn-row" style="margin:.2rem 0 .9rem">${tab('materials', 'Materials')}${tab('orders', 'Purchase orders' + (pos.length ? ' (' + pos.length + ')' : ''))}${tab('moves', 'Movements')}</div>
    ${body}`;
}

function renderLevels(rows, shorts, unknown) {
  if (!rows.length) return empty('', 'No materials yet', 'Add your materials under Costing → Materials first; then count what is on the shelf here.');
  const bySupplier = {};
  shorts.forEach(r => { const k = r.m.supplier || 'No supplier set'; (bySupplier[k] = bySupplier[k] || []).push(r); });
  const order = shorts.length ? `<div class="card stock-order">
      <h2>Order now</h2>
      <p class="muted">These will run out, or drop below their reorder level, once the orders waiting to start are built. Amounts allow for what is already on order.</p>
      ${Object.keys(bySupplier).sort().map(sup => `<div class="stock-sup">
        <div class="stock-sup-head"><strong>${esc(sup)}</strong>
          <button class="btn primary sm" data-act="po-draft" data-supplier="${esc(sup)}">Draft purchase order</button></div>
        ${bySupplier[sup].map(r => `<div class="stock-line"><span>${esc(r.m.name)}</span><span class="muted">${r.after < 0 ? 'short ' + esc(qtyTxt(-r.after)) + ' ' + esc(r.m.unit || '') : esc(qtyTxt(r.after)) + ' ' + esc(r.m.unit || '') + ' left'}</span><span>order <strong>${esc(qtyTxt(r.suggest))} ${esc(r.m.unit || '')}</strong></span></div>`).join('')}
      </div>`).join('')}
    </div>` : '';
  const uncounted = rows.filter(r => !r.counted).length;
  return `${order}
    ${unknown ? `<p class="notice-inline">${unknown} order${unknown === 1 ? ' is' : 's are'} for products not in the catalogue, so ${unknown === 1 ? 'its' : 'their'} materials are not counted here. Add the product under Costing with its bill of materials.</p>` : ''}
    ${uncounted ? `<p class="muted">${uncounted} material${uncounted === 1 ? ' has' : 's have'} not been counted yet. Tap <strong>Count</strong> and enter what is on the shelf.</p>` : ''}
    <div class="card" style="padding:0; overflow:auto"><table class="tbl stock-tbl">
      <thead><tr><th>Material</th><th class="r">On hand</th><th class="r">Needed</th><th class="r">On order</th><th class="r">After that</th><th class="r">Reorder below</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr class="${r.short ? 'short' : ''}">
        <td><strong>${esc(r.m.name)}</strong><div class="muted">${esc([r.m.supplier, money(r.m.cost, cur()) + ' / ' + (r.m.unit || '')].filter(Boolean).join(' · '))}</div></td>
        <td class="r">${r.counted ? esc(qtyTxt(r.onHand)) + ' <span class="muted">' + esc(r.m.unit || '') + '</span>' : '<span class="muted">not counted</span>'}</td>
        <td class="r">${r.needed ? esc(qtyTxt(r.needed)) + '<div class="muted">' + r.waiting + ' order' + (r.waiting === 1 ? '' : 's') + '</div>' : '<span class="muted">—</span>'}</td>
        <td class="r">${r.onOrder ? esc(qtyTxt(r.onOrder)) : '<span class="muted">—</span>'}</td>
        <td class="r">${r.tracked ? `<span class="chip ${r.short ? 'late' : 'st-disp'}">${esc(qtyTxt(r.after))}</span>` : '<span class="muted">—</span>'}</td>
        <td class="r">${r.level ? esc(qtyTxt(r.level)) : '<span class="muted">—</span>'}</td>
        <td class="r nowrap"><button class="btn ghost sm" data-act="stock-count" data-id="${esc(r.m.id)}">Count</button>
          <button class="btn ghost sm" data-act="edit-material" data-id="${esc(r.m.id)}" title="Price, supplier and reorder level">Edit</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

const PO_STATUS = { draft: ['Draft', ''], sent: ['Sent', 'st-prod'], part: ['Part received', 'st-ready'], received: ['Received', 'st-disp'], cancelled: ['Cancelled', 'late'] };
const poChip = (p) => { const [l, c] = PO_STATUS[p.status] || PO_STATUS.draft; return `<span class="chip ${c}">${esc(l)}</span>`; };
const poTotal = (p) => (p.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);

function renderPOs() {
  if (!pos.length) return empty('', 'No purchase orders yet', 'Raise one from the Order now list on the Materials tab, or with ＋ Purchase order.');
  return `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>PO</th><th>Supplier</th><th>Raised</th><th>Expected</th><th class="r">Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${pos.map(p => `<tr>
      <td><strong>${esc(p.poNo)}</strong><div class="muted">${(p.lines || []).length} line${(p.lines || []).length === 1 ? '' : 's'}</div></td>
      <td>${esc(p.supplier || '')}</td>
      <td>${esc(niceDate(String(p.createdAt || '').slice(0, 10)))}</td>
      <td>${esc(niceDate(p.expectedDate))}</td>
      <td class="r">${esc(money(poTotal(p), cur()))}</td>
      <td>${poChip(p)}</td>
      <td class="r nowrap">
        ${p.status === 'draft' ? `<button class="btn ghost sm" data-act="po-edit" data-id="${esc(p.id)}">Edit</button><button class="btn primary sm" data-act="po-send" data-id="${esc(p.id)}">Send</button>` : ''}
        ${p.status === 'sent' || p.status === 'part' ? `<button class="btn primary sm" data-act="po-receive" data-id="${esc(p.id)}">Receive</button><button class="btn ghost sm" data-act="po-send" data-id="${esc(p.id)}">Send again</button>` : ''}
        <button class="btn ghost sm" data-act="po-print" data-id="${esc(p.id)}">Print</button>
        ${p.status === 'draft' || p.status === 'sent' ? `<button class="btn ghost sm" data-act="po-cancel" data-id="${esc(p.id)}">Cancel</button>` : ''}
      </td></tr>`).join('')}</tbody>
  </table></div>`;
}

const MOVE_KIND = { used: 'Used on', returned: 'Back from', received: 'Received on', 'received-direct': 'Received', count: 'Stock count', opening: 'First count',
  issued: 'Given to', 'issue-return': 'Brought back by', 'client-fabric': 'Client fabric for' };
function renderMoves() {
  if (!moves.length) return empty('', 'Nothing has moved yet', 'Every count, delivery and order that uses materials is listed here.');
  return `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>When</th><th>Material</th><th class="r">Change</th><th>Why</th><th>By</th></tr></thead>
    <tbody>${moves.slice(0, 200).map(m => `<tr>
      <td class="nowrap">${esc(String(m.createdAt || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(m.name)}</td>
      <td class="r">${ALLOCATION.includes(m.kind)
        ? `<strong>${esc(qtyTxt(Math.abs(m.qty)))}</strong> <span class="muted">${esc(m.unit || '')}</span><div class="muted">not off stock</div>`
        : `<strong style="color:${m.qty < 0 ? '#b91c1c' : '#1f7a3a'}">${m.qty > 0 ? '+' : ''}${esc(qtyTxt(m.qty))}</strong> <span class="muted">${esc(m.unit || '')}</span>`}</td>
      <td>${esc(MOVE_KIND[m.kind] || m.kind)} ${esc(m.person || '')} ${esc(m.ref || '')}${m.note ? '<div class="muted">' + esc(m.note) + '</div>' : ''}</td>
      <td>${esc(m.createdBy || '')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// ------------------------------------------------------------ stock count ---

export function countMaterial(id) {
  const m = materialById(id); if (!m) return;
  const had = m.onHand == null ? null : Number(m.onHand);
  openModal('Count ' + m.name, `
    <p class="muted">${had == null ? 'First count: enter what is on the shelf now.' : 'The system says ' + esc(qtyTxt(had)) + ' ' + esc(m.unit || '') + '. Enter what you actually count.'}</p>
    ${row(field('Counted (' + (m.unit || 'units') + ')', 'sc-qty', { type: 'number', min: 0, step: '0.01', value: had == null ? '' : qtyTxt(had) }), field('Note', 'sc-note', { placeholder: 'e.g. month-end count' }))}`, {
    okLabel: 'Save count',
    onOk: async (w) => {
      const raw = val(w, 'sc-qty');
      if (raw === '') { toast('Enter the counted quantity', 'warn'); return false; }
      const counted = r3(parseFloat(raw));
      if (!(counted >= 0)) { toast('Enter a number of 0 or more', 'warn'); return false; }
      const delta = r3(counted - (had || 0));
      await store.update('materials', id, { onHand: counted, countedAt: store.nowIso() }, 'Counted: ' + qtyTxt(counted) + ' ' + (m.unit || ''));
      await logMove(id, delta, had == null ? 'opening' : 'count', '', val(w, 'sc-note') || (delta ? (delta > 0 ? 'More than recorded' : 'Less than recorded') : 'Matched'));
      toast(m.name + ': ' + qtyTxt(counted) + ' ' + (m.unit || '') + ' on hand');
    }
  });
}

// --------------------------------------------------------- purchase orders --

function poLineRow(l, i) {
  l = l || {};
  const mats = allMaterials();
  return `<div class="po-row" data-row="${i}">
    <select class="po-mat"><option value="">— material —</option>${mats.map(m => `<option value="${esc(m.id)}" data-cost="${esc(m.cost || 0)}"${m.id === l.materialId ? ' selected' : ''}>${esc(m.name)} (${esc(m.unit || '')})</option>`).join('')}</select>
    <input class="po-qty" type="number" min="0" step="0.01" value="${esc(l.qty == null ? '' : l.qty)}" placeholder="qty">
    <input class="po-cost" type="number" min="0" step="0.01" value="${esc(l.cost == null ? '' : l.cost)}" placeholder="cost each">
    <button type="button" class="icon-btn po-del" title="Remove">✕</button>
  </div>`;
}

// The most recent contact details used for a supplier, so they are typed once.
function lastContact(supplier) {
  const p = pos.find(x => String(x.supplier || '').toLowerCase() === String(supplier || '').toLowerCase() && (x.supplierPhone || x.supplierEmail));
  return p ? { phone: p.supplierPhone || '', email: p.supplierEmail || '' } : { phone: '', email: '' };
}

function poForm(p) {
  const suppliers = [...new Set(allMaterials().map(m => m.supplier).filter(Boolean))].sort();
  const c = p.supplierPhone || p.supplierEmail ? { phone: p.supplierPhone, email: p.supplierEmail } : lastContact(p.supplier);
  return row(
    field('Supplier', 'po-sup', { value: p.supplier, placeholder: 'Who you are ordering from', list: 'po-sup-list' }),
    field('Delivery expected', 'po-exp', { type: 'date', value: p.expectedDate || addDays(today(), 7) })
  ) + row(
    field('Supplier WhatsApp / cell', 'po-phone', { value: c.phone, placeholder: 'To send the order on WhatsApp' }),
    field('Supplier email', 'po-email', { type: 'email', value: c.email })
  ) + `<div class="fld"><span>What to order</span>
      <div class="po-head muted"><span>Material</span><span>Qty</span><span>Cost each</span><span></span></div>
      <div id="po-lines">${(p.lines && p.lines.length ? p.lines : [{}]).map(poLineRow).join('')}</div>
      <button type="button" class="btn ghost sm" id="po-add" style="margin-top:.4rem">＋ Add a line</button>
      <div class="po-total" id="po-total"></div>
    </div>`
    + field('Note to the supplier', 'po-notes', { value: p.notes, type: 'textarea', placeholder: 'Delivery address, colour codes, anything they must know' })
    + `<datalist id="po-sup-list">${suppliers.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>`;
}

function wirePoForm(w) {
  const lines = w.querySelector('#po-lines');
  const total = () => {
    let t = 0;
    lines.querySelectorAll('.po-row').forEach(r => { t += (parseFloat(r.querySelector('.po-qty').value) || 0) * (parseFloat(r.querySelector('.po-cost').value) || 0); });
    w.querySelector('#po-total').textContent = 'Total ' + money(t, cur()) + (settings.vatRegistered ? ' excl. VAT' : '');
  };
  lines.addEventListener('change', (e) => {
    if (e.target.classList.contains('po-mat')) {
      const opt = e.target.selectedOptions[0]; const cost = e.target.closest('.po-row').querySelector('.po-cost');
      if (opt && opt.dataset.cost && !cost.value) cost.value = opt.dataset.cost;
    }
    total();
  });
  lines.addEventListener('input', total);
  lines.addEventListener('click', (e) => { if (e.target.closest('.po-del')) { e.target.closest('.po-row').remove(); total(); } });
  w.querySelector('#po-add').addEventListener('click', () => { lines.insertAdjacentHTML('beforeend', poLineRow({}, lines.children.length)); });
  w.querySelector('#po-sup').addEventListener('change', (e) => {
    const c = lastContact(e.target.value);
    if (!w.querySelector('#po-phone').value) w.querySelector('#po-phone').value = c.phone;
    if (!w.querySelector('#po-email').value) w.querySelector('#po-email').value = c.email;
  });
  total();
}

function readPo(w) {
  const lines = [];
  w.querySelectorAll('#po-lines .po-row').forEach(r => {
    const id = r.querySelector('.po-mat').value; const m = materialById(id);
    const qty = r3(parseFloat(r.querySelector('.po-qty').value));
    if (m && qty > 0) lines.push({ materialId: id, name: m.name, unit: m.unit || '', qty, cost: Math.round((parseFloat(r.querySelector('.po-cost').value) || 0) * 100) / 100, received: 0 });
  });
  return { supplier: val(w, 'po-sup'), expectedDate: val(w, 'po-exp'), supplierPhone: val(w, 'po-phone'), supplierEmail: val(w, 'po-email'), notes: val(w, 'po-notes'), lines };
}

async function savePo(id, d) {
  if (!d.supplier) { toast('Say who the order is for', 'warn'); return false; }
  if (!d.lines.length) { toast('Add at least one material with a quantity', 'warn'); return false; }
  if (id) { await store.update('purchaseOrders', id, d, 'Purchase order updated'); toast('Purchase order updated'); return; }
  const n = await store.nextNumber('poNo', settings.firstPoNo || 1);
  const poNo = (settings.poPrefix || 'PO-') + String(n).padStart(4, '0');
  view = 'orders';     // show the list it lands in (the save repaints the screen)
  await store.create('purchaseOrders', { ...d, poNo, status: 'draft', events: [{ at: store.nowIso(), by: who(), what: 'Purchase order raised' }] });
  if (onChange) onChange();
  toast(poNo + ' saved as a draft — tap Send when it is right');
}

export function newPurchaseOrder(prefill) {
  const p = prefill || {};
  const { wrap } = openModal('New purchase order', poForm(p), { okLabel: 'Save draft', onOk: (w) => savePo(null, readPo(w)) });
  wirePoForm(wrap);
}

// From the Order now list: one draft for a supplier with the suggested amounts.
export function draftForSupplier(supplier, orders) {
  const { rows } = levels(orders);
  const lines = rows.filter(r => r.short && (r.m.supplier || 'No supplier set') === supplier)
    .map(r => ({ materialId: r.m.id, qty: r.suggest, cost: Number(r.m.cost) || 0 }));
  newPurchaseOrder({ supplier: supplier === 'No supplier set' ? '' : supplier, lines });
}

export function editPurchaseOrder(id) {
  const p = poById(id); if (!p) return;
  const { wrap } = openModal('Edit ' + p.poNo, poForm(p), { okLabel: 'Save changes', onOk: (w) => savePo(id, readPo(w)) });
  wirePoForm(wrap);
}

function poText(p) {
  return 'Hi ' + (p.supplier || '') + ', purchase order ' + p.poNo + ' from ' + (settings.name || '') + ':\n'
    + (p.lines || []).map(l => '• ' + qtyTxt(l.qty) + ' ' + (l.unit || '') + ' ' + l.name).join('\n')
    + (p.expectedDate ? '\nPlease deliver by ' + niceDate(p.expectedDate) + '.' : '')
    + (p.notes ? '\n' + p.notes : '')
    + '\nPlease quote ' + p.poNo + ' on your invoice. Thank you, ' + who() + (settings.phone ? ' (' + settings.phone + ')' : '');
}

export function sendPurchaseOrder(id) {
  const p = poById(id); if (!p) return;
  const phone = waDigits(p.supplierPhone);
  const m = openModal('Send ' + p.poNo, `
    <p>Send the order to <strong>${esc(p.supplier)}</strong>. The message is written for you; check it and press send.</p>
    <pre class="po-msg">${esc(poText(p))}</pre>
    <div class="btn-row">
      <button class="btn primary" id="ps-wa">WhatsApp${phone ? '' : ' (pick the chat)'}</button>
      ${p.supplierEmail ? '<button class="btn ghost" id="ps-mail">Email</button>' : ''}
      <button class="btn ghost" id="ps-print">Print / PDF</button>
    </div>
    <p class="muted">Once it has gone, tap <strong>Mark as sent</strong>: the materials then count as on order.</p>`, {
    okLabel: p.status === 'draft' ? 'Mark as sent' : 'Done',
    onOk: async () => {
      if (p.status === 'draft') { await store.update('purchaseOrders', id, { status: 'sent', sentAt: store.nowIso() }, 'Sent to the supplier'); toast(p.poNo + ' sent — now on order'); }
    }
  });
  m.wrap.querySelector('#ps-wa').addEventListener('click', () => window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(poText(p)), '_blank'));
  const mail = m.wrap.querySelector('#ps-mail');
  if (mail) mail.addEventListener('click', () => { location.href = 'mailto:' + encodeURIComponent(p.supplierEmail) + '?subject=' + encodeURIComponent('Purchase order ' + p.poNo + ' — ' + (settings.name || '')) + '&body=' + encodeURIComponent(poText(p)); });
  m.wrap.querySelector('#ps-print').addEventListener('click', () => printPurchaseOrder(id));
}

export function printPurchaseOrder(id) {
  const p = poById(id); if (!p) return;
  const vat = settings.vatRegistered ? 'excl. VAT' : '';
  const body = `${docHeader(settings, 'PURCHASE ORDER', p.poNo, ['Date ' + niceDate(String(p.createdAt || today()).slice(0, 10)), p.expectedDate ? 'Deliver by ' + niceDate(p.expectedDate) : ''])}
    <div class="two"><div class="box"><h4>Supplier</h4><strong>${esc(p.supplier)}</strong>${p.supplierPhone ? '<br>' + esc(p.supplierPhone) : ''}${p.supplierEmail ? '<br>' + esc(p.supplierEmail) : ''}</div>
      <div class="box"><h4>Deliver to</h4><strong>${esc(settings.name || '')}</strong><br>${esc(settings.address || '').replace(/\n/g, '<br>')}</div></div>
    <table><tr><th>Material</th><th class="r">Qty</th><th>Unit</th><th class="r">Each ${vat}</th><th class="r">Amount</th></tr>
      ${(p.lines || []).map(l => `<tr><td>${esc(l.name)}</td><td class="r">${esc(qtyTxt(l.qty))}</td><td>${esc(l.unit || '')}</td><td class="r">${esc(money(l.cost, cur()))}</td><td class="r">${esc(money((Number(l.qty) || 0) * (Number(l.cost) || 0), cur()))}</td></tr>`).join('')}
      <tr class="tot big"><td colspan="4" class="r">TOTAL ${vat}</td><td class="r">${esc(money(poTotal(p), cur()))}</td></tr>
    </table>
    ${p.notes ? `<p>${esc(p.notes)}</p>` : ''}
    <div class="ft">Please quote ${esc(p.poNo)} on your delivery note and invoice.</div>`;
  openPrint(p.poNo, body);
}

// Booking a delivery in: every line received adds to the shelf.
export function receivePurchaseOrder(id) {
  const p = poById(id); if (!p) return;
  const lines = (p.lines || []).map((l, i) => ({ ...l, i, out: r3((Number(l.qty) || 0) - (Number(l.received) || 0)) }));
  openModal('Receive ' + p.poNo + ' from ' + (p.supplier || ''), `
    <p class="muted">Enter what actually arrived. Anything short stays on order.</p>
    ${lines.map(l => `<div class="po-recv"><span><strong>${esc(l.name)}</strong><div class="muted">ordered ${esc(qtyTxt(l.qty))} ${esc(l.unit)}${l.received ? ', already received ' + esc(qtyTxt(l.received)) : ''}</div></span>
      <input type="number" min="0" step="0.01" data-line="${l.i}" value="${l.out > 0 ? esc(qtyTxt(l.out)) : 0}" ${l.out > 0 ? '' : 'disabled'}><span class="muted">${esc(l.unit)}</span></div>`).join('')}
    ${store.can('costing', 'edit') ? `<label class="check"><input type="checkbox" id="pr-price" checked> Update material prices to this order's prices</label>` : ''}`, {
    okLabel: 'Book it in',
    onOk: async (w) => {
      const got = {};
      w.querySelectorAll('[data-line]').forEach(inp => { const q = r3(parseFloat(inp.value)); if (q > 0) got[inp.dataset.line] = q; });
      if (!Object.keys(got).length) { toast('Enter what arrived', 'warn'); return false; }
      const pc = w.querySelector('#pr-price');
      const prices = !!(pc && pc.checked);       // only roles that may change prices see the box
      const newLines = (p.lines || []).map((l, i) => got[i] ? { ...l, received: r3((Number(l.received) || 0) + got[i]) } : l);
      for (const [i, q] of Object.entries(got)) {
        const l = p.lines[i];
        if (!materialById(l.materialId)) continue;
        const patch = { onHand: store.inc(q) };
        if (prices && Number(l.cost) > 0) patch.cost = Number(l.cost);
        await store.update('materials', l.materialId, patch);
        await logMove(l.materialId, q, 'received', p.poNo, p.supplier);
      }
      const done = newLines.every(l => (Number(l.received) || 0) >= (Number(l.qty) || 0));
      await store.update('purchaseOrders', id, { lines: newLines, status: done ? 'received' : 'part', receivedAt: store.nowIso() }, done ? 'Received in full' : 'Part received');
      toast(done ? p.poNo + ' received in full' : p.poNo + ' part received — the rest stays on order');
    }
  });
}

export async function cancelPurchaseOrder(id) {
  const p = poById(id); if (!p) return;
  if (!confirm('Cancel ' + p.poNo + ' to ' + (p.supplier || 'the supplier') + '?' + (p.status === 'sent' ? ' Let the supplier know too.' : ''))) return;
  await store.update('purchaseOrders', id, { status: 'cancelled' }, 'Cancelled');
  toast(p.poNo + ' cancelled');
}
