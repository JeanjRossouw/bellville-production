// Retail POS — the Stock tab (supervisors and up): what the store holds
// (on hand, reserved, available, on order, in quarantine, value at cost),
// the low-stock list from the reorder levels, an item's movements,
// adjustments with a reason and a manager's PIN, quarantine moves, and
// stock takes: freeze, count by scanning on a phone, variances, approve
// and post. The server (pos-stock) writes every movement.
import { API } from './config.js';
import * as auth from './auth.js';
import { list } from './db.js';
import { esc, toast, field, row, val, openModal, openPrint, money, niceDate, niceTime, empty } from './ui.js';
import { centsOf, randsOf } from './money.js';
import { cameraScanner } from './scanner.js';
import { A4_CSS } from './receipt.js';
import { icon } from './icons.js';

export const st = { sub: 'levels', filter: 'all', q: '', takeId: '', mode: 'add', showFrozen: false, varOnly: true, busy: false, camera: null };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();   // { store, entity, settings, products, variants, stockLevels, takes }
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const mkId = (p) => p + '-' + (auth.deviceId() || 'web') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const CODES = [['damaged', 'Damaged'], ['stolen', 'Stolen / missing'], ['found', 'Found'], ['correction', 'Correction'], ['sample', 'Sample / display'], ['writeoff', 'Write off'], ['other', 'Other (say why)']];
const REASON = { sale: 'Sale', creditNote: 'Return', receive: 'Received', adjust: 'Adjustment', count: 'Stock take', transferOut: 'Transfer out', transferIn: 'Transfer in', layby: 'Lay-by', specialOrder: 'Special order', bundle: 'Bundle', quarantine: 'Quarantine' };

// ---------------------------------------------------------------- items --
// every stock item of the store's company joined with its level
export function items(dd) {
  const sid = dd.store.id, eid = dd.entity.id;
  const out = [];
  for (const p of dd.products || []) {
    if (p.entityId !== eid || p.type !== 'stock' || p.trackStock === false || p.archived) continue;
    const vs = p.hasVariants ? (dd.variants || []).filter(v => v.productId === p.id && !v.archived) : [null];
    for (const v of vs) {
      const itemId = v ? v.id : p.id;
      const lv = (dd.stockLevels || []).find(x => x.storeId === sid && (x.variantId === itemId || (!x.variantId && x.productId === itemId))) || {};
      const onHand = lv.onHandQty || 0, reserved = lv.reservedQty || 0, cost = (lv.avgCostCents > 0 ? lv.avgCostCents : (v && v.costCents != null ? v.costCents : p.costCents)) || 0;
      out.push({ itemId, productId: p.id, variantId: v ? v.id : '', name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcodes: (v && v.barcodes) || p.barcodes || [], category: p.category || '', onHand, reserved, available: onHand - reserved, onOrder: lv.onOrderQty || 0, quarantine: lv.quarantineQty || 0, reorderLevel: p.reorderLevel, reorderQty: p.reorderQty, costCents: cost, valueCents: onHand * cost, lastCountedAt: lv.lastCountedAt || '', low: p.reorderLevel != null && onHand - reserved <= p.reorderLevel, negative: onHand < 0 });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
const one = (itemId) => items(d()).find(x => x.itemId === itemId);
const findCode = (code) => { const c = String(code || '').trim().toLowerCase(); if (!c) return null; const all = items(d()); return all.find(x => x.barcodes.some(b => String(b).toLowerCase() === c)) || all.find(x => x.sku.toLowerCase() === c) || null; };

// ----------------------------------------------------------------- html --
export function stockHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Stock</h1></div><div class="card muted">Pick a store first.</div>`;
  const subs = [['levels', 'Levels'], ['low', 'Low stock'], ['takes', 'Stock takes']];
  const head = `<div class="page-head"><h1>Stock · ${esc(dd.store.name)}</h1></div><div class="subnav">${subs.map(x => `<button class="subtab${st.sub === x[0] ? ' on' : ''}" data-act="st-sub" data-to="${x[0]}">${x[1]}</button>`).join('')}</div>`;
  if (st.sub === 'takes') return head + takesHtml(dd);
  return head + levelsHtml(dd, st.sub === 'low');
}
function levelsHtml(dd, lowOnly) {
  const all = items(dd);
  const q = st.q.trim().toLowerCase();
  const rows = all.filter(x => (lowOnly ? x.low : st.filter === 'all' || (st.filter === 'negative' ? x.negative : st.filter === 'quarantine' ? x.quarantine > 0 : st.filter === 'reserved' ? x.reserved > 0 : true)) && (!q || [x.name, x.sku, x.category, ...x.barcodes].some(s => String(s).toLowerCase().includes(q))));
  const units = rows.reduce((n, x) => n + x.onHand, 0), value = rows.reduce((n, x) => n + x.valueCents, 0);
  const low = all.filter(x => x.low).length;
  return `<div class="toolbar">
      <input id="st-q" class="search" type="search" placeholder="Name, SKU, barcode, category" value="${esc(st.q)}">
      ${lowOnly ? `<span class="muted">${low} item${low === 1 ? '' : 's'} at or under their reorder level</span>` : `<select id="st-filter">${[['all', 'All items'], ['negative', 'Negative'], ['quarantine', 'In quarantine'], ['reserved', 'Reserved']].map(x => `<option value="${x[0]}"${st.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>`}
      ${auth.atLeast('supervisor') ? `<button class="btn ghost sm" data-act="st-adjust">${icon('plus')} Adjust</button><button class="btn ghost sm" data-act="st-print">${icon('printer')} Print</button>` : ''}
    </div>
    <p class="sub">${rows.length} item${rows.length === 1 ? '' : 's'} · ${units} on hand · ${esc(money(value))} at cost${low && !lowOnly ? ` · <a href="#" data-act="st-sub" data-to="low">${low} low</a>` : ''}</p>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl st-tbl"><thead><tr><th>Item</th><th>SKU</th><th class="r">On hand</th><th class="r">Reserved</th><th class="r">Available</th><th class="r">On order</th><th class="r">Quarantine</th><th class="r">Reorder at</th><th class="r">Value</th><th></th></tr></thead>
      <tbody>${rows.map(x => `<tr class="${x.negative ? 'neg' : x.low ? 'low' : ''}"><td><strong>${esc(x.name)}</strong>${x.category ? `<div class="muted">${esc(x.category)}</div>` : ''}</td><td class="muted">${esc(x.sku)}</td><td class="r">${x.onHand}</td><td class="r">${x.reserved || ''}</td><td class="r"><strong>${x.available}</strong></td><td class="r">${x.onOrder || ''}</td><td class="r">${x.quarantine || ''}</td><td class="r">${x.reorderLevel == null ? '' : x.reorderLevel + (x.reorderQty ? ' <span class="muted">(+' + x.reorderQty + ')</span>' : '')}</td><td class="r">${esc(money(x.valueCents))}</td><td class="r nowrap"><button class="btn ghost sm" data-act="st-card" data-id="${esc(x.itemId)}">Card</button></td></tr>`).join('')}</tbody></table></div>`
      : empty(lowOnly ? 'Nothing is low' : 'No stock items', lowOnly ? 'Items at or under their reorder level show here. Set reorder levels under Products.' : '')}`;
}

// --------------------------------------------------------- stock takes --
function takesHtml(dd) {
  const takes = [...(dd.takes || [])].sort((a, b) => String(b.frozenAt).localeCompare(String(a.frozenAt)));
  const live = takes.find(t => t.status === 'open' || t.status === 'review');
  const cur = st.takeId ? takes.find(t => t.id === st.takeId) : live;
  if (cur && (cur.status === 'open' || cur.status === 'review')) return cur.status === 'open' ? countHtml(cur) : reviewHtml(cur);
  if (cur) return reviewHtml(cur, true);
  const cats = [...new Set(items(dd).map(x => x.category).filter(Boolean))].sort();
  return `<div class="card"><h2>New stock take</h2>
      <div class="grid three">${field('Name', 'tk-name', { value: 'Stock take ' + new Date().toISOString().slice(0, 10) })}${field('Scope', 'tk-scope', { type: 'select', value: 'all', options: [{ value: 'all', label: 'Everything in the store' }, { value: 'category', label: 'One category' }] })}${field('Category', 'tk-cat', { type: 'select', value: cats[0] || '', options: cats.map(c => ({ value: c, label: c })) })}</div>
      <p class="muted">Freezing takes a snapshot of what the system says is on hand. Count on any phone signed in here: scan each item, or type a count. Sales carry on meanwhile; the variance is against the frozen figure.</p>
      <div class="card-actions"><button class="btn primary" data-act="st-take-open">${icon('barcode')} Freeze and start counting</button></div></div>
    ${takes.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Stock take</th><th>Frozen</th><th>Counted</th><th class="r">Variance</th><th>Status</th><th></th></tr></thead><tbody>${takes.map(t => `<tr class="${t.status === 'cancelled' ? 'off' : ''}"><td><strong>${esc(t.name)}</strong><div class="muted">${t.scope === 'category' ? esc(t.category) : 'Everything'} · ${t.itemCount} items · by ${esc(t.openedBy)}</div></td><td class="muted">${esc(niceDate(t.frozenAt))} ${esc(niceTime(t.frozenAt))}</td><td>${t.countedItems} of ${t.itemCount}</td><td class="r">${t.varianceQty > 0 ? '+' : ''}${t.varianceQty} · ${esc(money(t.varianceValueCents))}</td><td><span class="chip${t.status === 'posted' ? ' ok' : ''}">${esc(t.status)}</span></td><td class="r"><button class="btn ghost sm" data-act="st-take-show" data-id="${esc(t.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function countHtml(t) {
  const q = st.q.trim().toLowerCase();
  const rows = t.items.filter(x => !q || [x.name, x.sku, ...(x.barcodes || [])].some(s => String(s).toLowerCase().includes(q)));
  const sup = auth.atLeast('supervisor');
  return `<div class="card tk-head"><div><h2>${esc(t.name)} <span class="chip">counting</span></h2><p class="muted">Frozen ${esc(niceDate(t.frozenAt))} ${esc(niceTime(t.frozenAt))} · ${t.countedItems} of ${t.itemCount} counted${st.showFrozen ? '' : ' · a blind count: the system’s figures are hidden'}</p></div>
      <div class="tk-acts">${sup ? `<button class="btn ghost sm" data-act="st-frozen">${st.showFrozen ? 'Hide' : 'Show'} system figures</button><button class="btn primary sm" data-act="st-take-review">Done counting: review</button><button class="btn ghost sm" data-act="st-take-cancel">Cancel take</button>` : ''}</div></div>
    <div class="card tk-scan">
      <div class="tk-scanrow"><label class="pos-search-wrap" style="flex:1 1 260px">${icon('barcode')}<input id="tk-scan" class="pos-in" placeholder="Scan a barcode, or type a code and press Enter" autocomplete="off"></label>
        <select id="tk-mode"><option value="add"${st.mode === 'add' ? ' selected' : ''}>Each scan adds 1</option><option value="qty"${st.mode === 'qty' ? ' selected' : ''}>Ask how many per scan</option></select>
        <button class="btn ghost sm" data-act="st-camera">${icon('camera')} ${st.camera ? 'Stop camera' : 'Camera'}</button></div>
      <video id="tk-video" class="tk-video" playsinline muted hidden></video>
      <div class="tk-last" id="tk-last">${st.last ? esc(st.last) : 'Nothing scanned yet'}</div>
    </div>
    <div class="toolbar"><input id="st-q" class="search" type="search" placeholder="Find an item in the count" value="${esc(st.q)}"></div>
    <div class="card" style="padding:0;overflow:auto"><table class="tbl tk-tbl"><thead><tr><th>Item</th><th>SKU</th>${st.showFrozen ? '<th class="r">System</th>' : ''}<th class="r">Counted</th><th></th></tr></thead>
      <tbody>${rows.map(x => `<tr class="${x.countedQty == null ? '' : 'done'}"><td><strong>${esc(x.name)}</strong>${x.countedQty != null ? `<div class="muted">${esc(x.countedBy)} · ${esc(niceTime(x.countedAt))}</div>` : ''}</td><td class="muted">${esc(x.sku)}</td>${st.showFrozen ? `<td class="r">${x.frozenQty}</td>` : ''}<td class="r"><strong>${x.countedQty == null ? '—' : x.countedQty}</strong></td><td class="r nowrap"><button class="btn ghost sm" data-act="st-count" data-id="${esc(x.itemId)}" data-d="1">+1</button><button class="btn ghost sm" data-act="st-set" data-id="${esc(x.itemId)}">Set</button></td></tr>`).join('')}</tbody></table></div>`;
}
function reviewHtml(t, done = false) {
  const rows = t.items.filter(x => !st.varOnly || (x.countedQty != null && x.countedQty !== x.frozenQty)).map(x => ({ ...x, diff: x.countedQty == null ? null : x.countedQty - x.frozenQty }));
  const counted = t.items.filter(x => x.countedQty != null), diffs = counted.filter(x => x.countedQty !== x.frozenQty), uncounted = t.itemCount - counted.length;
  const mgr = auth.atLeast('manager'), sup = auth.atLeast('supervisor');
  return `<div class="card tk-head"><div><h2>${esc(t.name)} <span class="chip${t.status === 'posted' ? ' ok' : ''}">${esc(t.status)}</span></h2>
      <p class="muted">Frozen ${esc(niceDate(t.frozenAt))} ${esc(niceTime(t.frozenAt))} · ${counted.length} of ${t.itemCount} counted · ${diffs.length} variance${diffs.length === 1 ? '' : 's'} · ${t.varianceQty > 0 ? '+' : ''}${t.varianceQty} units · ${esc(money(t.varianceValueCents))} at cost${uncounted && !done ? ` · <span class="warn">${uncounted} not counted: they stay as they are</span>` : ''}${t.status === 'posted' ? ` · posted ${esc(niceDate(t.postedAt))} by ${esc(t.approvedBy)}, ${t.movementCount} movement${t.movementCount === 1 ? '' : 's'}` : ''}</p></div>
      <div class="tk-acts"><button class="btn ghost sm" data-act="st-varonly">${st.varOnly ? 'Show all items' : 'Variances only'}</button><button class="btn ghost sm" data-act="st-take-print">${icon('printer')} Print</button>
        ${!done && sup ? `<button class="btn ghost sm" data-act="st-take-reopen">Back to counting</button><button class="btn ghost sm" data-act="st-take-cancel">Cancel take</button>` : ''}
        ${!done ? `<button class="btn primary sm" data-act="st-take-post"${diffs.length || counted.length ? '' : ' disabled'}>${icon('lock')} Approve and post${mgr ? '' : ' (manager PIN)'}</button>` : ''}
        ${done ? `<button class="btn ghost sm" data-act="st-take-show" data-id="">Back</button>` : ''}</div></div>
    <div class="card" style="padding:0;overflow:auto"><table class="tbl tk-tbl" id="tk-review"><thead><tr><th>Item</th><th>SKU</th><th class="r">System</th><th class="r">Counted</th><th class="r">Variance</th><th class="r">At cost</th><th>By</th></tr></thead>
      <tbody>${rows.map(x => `<tr class="${x.diff ? (x.diff < 0 ? 'neg' : 'pos') : ''}"><td><strong>${esc(x.name)}</strong></td><td class="muted">${esc(x.sku)}</td><td class="r">${x.frozenQty}</td><td class="r">${x.countedQty == null ? '<span class="muted">not counted</span>' : x.countedQty}</td><td class="r"><strong>${x.diff == null ? '' : (x.diff > 0 ? '+' : '') + x.diff}</strong></td><td class="r">${x.diff ? esc(money(x.diff * (x.costCents || 0))) : ''}</td><td class="muted">${esc(x.countedBy || '')}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">No variances: everything counted matched.</td></tr>`}</tbody></table></div>`;
}

// ------------------------------------------------------------ actions --
export async function action(act, b) {
  const id = b.dataset.id;
  if (act === 'st-sub') { stopCamera(); st.sub = b.dataset.to; st.q = ''; return ctx.repaint(); }
  if (act === 'st-card') return card(id);
  if (act === 'st-adjust') return adjust(id || '');
  if (act === 'st-print') return printLevels();
  if (act === 'st-take-open') return takeOpen();
  if (act === 'st-take-show') { stopCamera(); st.takeId = id || ''; return ctx.repaint(); }
  if (act === 'st-frozen') { st.showFrozen = !st.showFrozen; return ctx.repaint(); }
  if (act === 'st-varonly') { st.varOnly = !st.varOnly; return ctx.repaint(); }
  if (act === 'st-count') return count(id, Number(b.dataset.d) || 1, 'add');
  if (act === 'st-set') return setCount(id);
  if (act === 'st-camera') return toggleCamera();
  if (act === 'st-take-review') return takeStep('takeReview', 'Counting closed: look at the variances');
  if (act === 'st-take-reopen') return takeStep('takeReopen', 'Back to counting');
  if (act === 'st-take-cancel') { if (!confirm('Cancel this stock take? The counts are kept for the record; nothing is posted.')) return; return takeStep('takeCancel', 'Stock take cancelled'); }
  if (act === 'st-take-post') return takePost();
  if (act === 'st-take-print') return printTake();
}
export function onInput(id, value) { if (id === 'st-q') { st.q = value; ctx.repaint(); const q = document.getElementById('st-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } }
export function onChange(e) { if (e.target.id === 'st-filter') { st.filter = e.target.value; ctx.repaint(); } if (e.target.id === 'tk-mode') st.mode = e.target.value; }
export function onEnter(id, value) { if (id === 'tk-scan') { scanned(value); const i = document.getElementById('tk-scan'); if (i) i.value = ''; return true; } return false; }
const liveTake = () => (d().takes || []).find(t => t.status === 'open');

// a code scanned or typed on the count screen
function scanned(code) {
  const t = liveTake(); if (!t) return;
  const it = findCode(code) || t.items.find(x => (x.barcodes || []).some(b => String(b).toLowerCase() === String(code).trim().toLowerCase()) || x.sku.toLowerCase() === String(code).trim().toLowerCase());
  if (!it) { st.last = 'Unknown code ' + code; toast('Unknown code ' + code, 'warn'); return ctx.repaint(); }
  if (!t.items.some(x => x.itemId === it.itemId)) { st.last = it.name + ' is not in this stock take'; toast(st.last, 'warn'); return ctx.repaint(); }
  if (st.mode === 'qty') return setCount(it.itemId, it.name);
  return count(it.itemId, 1, 'add', it.name);
}
async function count(itemId, qty, mode, name) {
  const t = liveTake(); if (!t) return;
  const it = t.items.find(x => x.itemId === itemId); if (!it) return;
  try {
    const r = await auth.api('takeCount', { takeId: t.id, counts: [{ itemId, qty, mode }], ...where() }, API.stock);
    const after = r.take.items.find(x => x.itemId === itemId);
    st.last = `${name || it.name}: ${after ? after.countedQty : qty}`;
    mergeTake(r.take); ctx.repaint();
    const i = document.getElementById('tk-scan'); if (i) i.focus();
  } catch (e) { toast(e.offline ? 'Counting needs the line.' : e.message, 'warn'); }
}
function setCount(itemId, name) {
  const t = liveTake(); if (!t) return;
  const it = t.items.find(x => x.itemId === itemId); if (!it) return;
  openModal('Count ' + (name || it.name), field('How many are there', 'tk-qty', { type: 'number', value: it.countedQty == null ? '' : it.countedQty, min: 0 }), { okLabel: 'Set', onOk: async (w) => { const q = Number(val(w, 'tk-qty')); if (!Number.isInteger(q) || q < 0) { toast('A whole number.', 'warn'); return false; } await count(itemId, q, 'set', name); return true; } });
}
function mergeTake(take) { const list = d().takes || []; const i = list.findIndex(x => x.id === take.id); if (i >= 0) list[i] = { ...list[i], ...take }; else list.push(take); }
async function takeOpen() {
  const w = document.getElementById('screen');
  const body = { name: val(w, 'tk-name'), scope: val(w, 'tk-scope'), category: val(w, 'tk-cat'), ...where() };
  try { const r = await withPin('takeOpen', body, 'supervisor'); mergeTake(r.take); st.takeId = r.take.id; st.q = ''; st.last = ''; toast('Frozen: ' + r.take.itemCount + ' items to count'); ctx.repaint(); }
  catch (e) { toast(e.offline ? 'A stock take needs the line.' : e.message, 'warn'); }
}
async function takeStep(action, msg) {
  const t = (d().takes || []).find(x => x.id === st.takeId) || liveTake() || (d().takes || []).find(x => x.status === 'review'); if (!t) return;
  stopCamera();
  try { const r = await withPin(action, { takeId: t.id, ...where() }, 'supervisor'); mergeTake(r.take); toast(msg); ctx.repaint(); }
  catch (e) { toast(e.message, 'warn'); }
}
async function takePost() {
  const t = (d().takes || []).find(x => x.status === 'review'); if (!t) return;
  const diffs = t.items.filter(x => x.countedQty != null && x.countedQty !== x.frozenQty).length;
  if (!confirm(`Post ${diffs} variance${diffs === 1 ? '' : 's'} as stock movements? Items not counted stay as they are.`)) return;
  try { const r = await withPin('takePost', { takeId: t.id, ...where() }, 'manager'); mergeTake(r.take); st.takeId = r.take.id; toast('Posted: ' + r.movements + ' movement' + (r.movements === 1 ? '' : 's')); if (ctx.onChange) ctx.onChange(); ctx.repaint(); }
  catch (e) { toast(e.message, 'warn'); }
}
// the call, and again with a PIN of the role the server asks for
async function withPin(action, body, minRole) {
  try { return await auth.api(action, body, API.stock); }
  catch (e) {
    if (e.status === 403 && /PIN/.test(e.message)) { const role = /manager/.test(e.message) ? 'manager' : minRole; const a = await auth.requireOverride({ minRole: role, action: 'stock', details: { what: action, ...(body.qty != null ? { qty: body.qty } : {}) }, text: e.message }); return auth.api(action, { ...body, approvalToken: a.token }, API.stock); }
    throw e;
  }
}
// the camera on the count screen
async function toggleCamera() {
  if (st.camera) return stopCamera(true);
  const video = document.getElementById('tk-video'); if (!video) return;
  const sc = cameraScanner({ video, onCode: (code) => scanned(code) });
  if (!sc.supported) return toast('This browser cannot read barcodes with its camera: use a scanner or type the code.', 'warn');
  try { await sc.start(); st.camera = sc; const btn = document.querySelector('[data-act=st-camera]'); if (btn) btn.innerHTML = icon('camera') + ' Stop camera'; }
  catch (e) { toast('Could not open the camera: ' + e.message, 'warn'); }
}
function stopCamera(repaint) { if (st.camera) { try { st.camera.stop(); } catch (e) {} st.camera = null; if (repaint) ctx.repaint(); } }

// ------------------------------------------------------------- card --
async function card(itemId) {
  const it = one(itemId); if (!it) return;
  const dd = d();
  const { wrap } = openModal(it.name, `<div class="x-row"><span>On hand <strong>${it.onHand}</strong> · reserved ${it.reserved} · available <strong>${it.available}</strong> · on order ${it.onOrder} · quarantine ${it.quarantine}</span></div>
    <p class="muted">${it.sku ? 'SKU ' + esc(it.sku) + ' · ' : ''}${it.barcodes.length ? 'barcodes ' + esc(it.barcodes.join(', ')) + ' · ' : ''}cost ${esc(money(it.costCents))} (weighted average) · value ${esc(money(it.valueCents))}${it.reorderLevel != null ? ' · reorder at ' + it.reorderLevel : ''}${it.lastCountedAt ? ' · last counted ' + esc(niceDate(it.lastCountedAt)) : ''}</p>
    <div class="card-actions">${auth.atLeast('supervisor') ? `<button class="btn" data-act="st-adjust" data-id="${esc(it.itemId)}">Adjust</button><button class="btn ghost" data-act="st-quarantine" data-id="${esc(it.itemId)}">Quarantine ⇄ stock</button>` : ''}</div>
    <h3 class="st-h3">Movements</h3><div id="st-moves" class="muted">Loading…</div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (!b) return; if (b.dataset.act === 'st-adjust') adjust(b.dataset.id); if (b.dataset.act === 'st-quarantine') quarantine(b.dataset.id); });
  try {
    const rows = (await list('stockMovements', [['entityId', '==', dd.entity.id], ['storeId', '==', dd.store.id], ['productId', '==', it.productId], ['variantId', '==', it.variantId]])).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60);
    const host = wrap.querySelector('#st-moves'); if (!host) return;
    host.className = '';
    host.innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>When</th><th>What</th><th class="r">Qty</th><th>Bucket</th><th class="r">After</th><th>By</th></tr></thead><tbody>${rows.map(m => `<tr><td class="muted nowrap">${esc(niceDate(m.createdAt))} ${esc(niceTime(m.createdAt))}</td><td>${esc(REASON[m.reason] || m.reason)}${m.code ? ' · ' + esc(m.code) : ''}${m.docNo ? ' · ' + esc(m.docNo) : ''}${m.note && m.note !== it.name ? `<div class="muted">${esc(m.note)}</div>` : ''}</td><td class="r"><strong>${m.qty > 0 ? '+' : ''}${m.qty}</strong></td><td class="muted">${esc(m.bucket || 'onHand')}</td><td class="r">${m.bucket === 'onHand' || !m.bucket ? m.onHandAfter : ''}</td><td class="muted">${esc(m.byName || m.createdBy || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No movements yet.</p>';
  } catch (e) { const host = wrap.querySelector('#st-moves'); if (host) host.textContent = 'Could not load the movements: ' + e.message; }
}

// ----------------------------------------------------------- adjust --
function adjust(itemId) {
  const dd = d(); const all = items(dd);
  const pick = itemId ? all.find(x => x.itemId === itemId) : null;
  let busy = false;
  const { wrap, close } = openModal('Stock adjustment', `
    ${pick ? `<p><strong>${esc(pick.name)}</strong> · on hand ${pick.onHand}</p>` : field('Item', 'ad-item', { type: 'select', value: '', options: [{ value: '', label: 'Choose…' }, ...all.map(x => ({ value: x.itemId, label: x.name + ' (' + x.onHand + ')' }))] })}
    ${row(field('Quantity (− out, + in)', 'ad-qty', { type: 'number', placeholder: 'e.g. -2 or 3' }), field('Where', 'ad-bucket', { type: 'select', value: 'onHand', options: [{ value: 'onHand', label: 'Stock on hand' }, { value: 'quarantine', label: 'Quarantine' }] }))}
    ${row(field('Reason', 'ad-code', { type: 'select', value: 'damaged', options: CODES.map(c => ({ value: c[0], label: c[1] })) }), field('Note', 'ad-note', { placeholder: 'what happened' }))}
    <div id="ad-costrow" hidden>${field('Cost each (R, excl. VAT) for stock found', 'ad-cost', { value: pick ? randsOf(pick.costCents) : '', inputmode: 'decimal' })}</div>
    <p class="muted">A manager’s PIN. Every adjustment is a movement on the record; stock on hand is never typed over.</p>`, { okLabel: 'Adjust', cancelLabel: 'Back', onOk: () => submit() });
  const live = () => { const q = Number(val(wrap, 'ad-qty')); wrap.querySelector('#ad-costrow').hidden = !(q > 0); };
  wrap.addEventListener('input', live); wrap.addEventListener('change', live); live();
  async function submit() {
    if (busy) return false;
    const it = pick || all.find(x => x.itemId === val(wrap, 'ad-item')); if (!it) { toast('Which item?', 'warn'); return false; }
    const qty = Number(val(wrap, 'ad-qty')); if (!Number.isInteger(qty) || !qty) { toast('A whole number, minus for out.', 'warn'); return false; }
    const code = val(wrap, 'ad-code'), note = val(wrap, 'ad-note');
    if (code === 'other' && !note) { toast('Say why.', 'warn'); return false; }
    busy = true;
    try {
      const r = await withPin('adjust', { adjustId: mkId('adj'), productId: it.productId, variantId: it.variantId, qty, bucket: val(wrap, 'ad-bucket'), code, note, ...(qty > 0 ? { unitCostCents: centsOf(val(wrap, 'ad-cost')) } : {}), ...where() }, 'manager');
      close(true); toast(`${it.name}: ${qty > 0 ? '+' : ''}${qty} · now ${r.level.onHandQty} on hand`); if (ctx.onChange) ctx.onChange(); return true;
    } catch (e) { busy = false; toast(e.offline ? 'An adjustment needs the line.' : e.message, 'warn'); return false; }
  }
}
function quarantine(itemId) {
  const it = one(itemId); if (!it) return;
  openModal('Quarantine ⇄ stock: ' + it.name, `<p class="muted">On hand ${it.onHand} · in quarantine ${it.quarantine}. Goods in quarantine are not for sale until inspected.</p>` + row(field('Move', 'qm-dir', { type: 'select', value: it.quarantine > 0 ? 'out' : 'in', options: [{ value: 'in', label: 'Stock → quarantine' }, { value: 'out', label: 'Quarantine → stock (inspected, fine)' }] }), field('How many', 'qm-qty', { type: 'number', value: 1, min: 1 })) + field('Note', 'qm-note', {}), {
    okLabel: 'Move', onOk: async (w) => { const dir = val(w, 'qm-dir'), qty = Number(val(w, 'qm-qty')); if (!(qty > 0)) { toast('How many?', 'warn'); return false; }
      try { const r = await withPin('move', { moveId: mkId('qm'), productId: it.productId, variantId: it.variantId, qty, from: dir === 'in' ? 'onHand' : 'quarantine', to: dir === 'in' ? 'quarantine' : 'onHand', note: val(w, 'qm-note'), ...where() }, 'supervisor'); toast(`${it.name}: ${r.level.onHandQty} on hand, ${r.level.quarantineQty} in quarantine`); if (ctx.onChange) ctx.onChange(); return true; }
      catch (e) { toast(e.message, 'warn'); return false; } }
  });
}

// ------------------------------------------------------------ print --
function printLevels() {
  const dd = d(); const rows = items(dd).filter(x => st.sub !== 'low' || x.low);
  openPrint('Stock on hand', `<div class="a4"><div class="head"><div class="co">${esc(dd.entity.tradingName || dd.entity.legalName)}</div><div class="doc"><div class="t">${st.sub === 'low' ? 'Low stock' : 'Stock on hand'}</div><div>${esc(dd.store.name)} · ${esc(niceDate(new Date().toISOString()))}</div></div></div>
    <table><thead><tr><th>Item</th><th>SKU</th><th class="n">On hand</th><th class="n">Reserved</th><th class="n">Available</th><th class="n">On order</th><th class="n">Reorder at</th><th class="n">Value</th></tr></thead><tbody>${rows.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.sku)}</td><td class="n">${x.onHand}</td><td class="n">${x.reserved}</td><td class="n">${x.available}</td><td class="n">${x.onOrder}</td><td class="n">${x.reorderLevel == null ? '' : x.reorderLevel}</td><td class="n">${esc(money(x.valueCents))}</td></tr>`).join('')}</tbody><tfoot><tr class="tot"><td colspan="7" class="n">Total at cost</td><td class="n">${esc(money(rows.reduce((n, x) => n + x.valueCents, 0)))}</td></tr></tfoot></table></div>`, A4_CSS);
}
function printTake() {
  const dd = d(); const t = (dd.takes || []).find(x => x.id === st.takeId) || (dd.takes || []).find(x => x.status === 'review'); if (!t) return;
  const rows = t.items.filter(x => !st.varOnly || (x.countedQty != null && x.countedQty !== x.frozenQty));
  openPrint(t.name, `<div class="a4"><div class="head"><div class="co">${esc(dd.entity.tradingName || dd.entity.legalName)}</div><div class="doc"><div class="t">Stock take</div><div>${esc(t.name)} · ${esc(dd.store.name)}</div><div class="s">Frozen ${esc(niceDate(t.frozenAt))} ${esc(niceTime(t.frozenAt))} · ${t.status}${t.approvedBy ? ' · approved by ' + esc(t.approvedBy) : ''}</div></div></div>
    <table><thead><tr><th>Item</th><th>SKU</th><th class="n">System</th><th class="n">Counted</th><th class="n">Variance</th><th class="n">At cost</th><th>By</th></tr></thead><tbody>${rows.map(x => { const dd2 = x.countedQty == null ? null : x.countedQty - x.frozenQty; return `<tr><td>${esc(x.name)}</td><td>${esc(x.sku)}</td><td class="n">${x.frozenQty}</td><td class="n">${x.countedQty == null ? '—' : x.countedQty}</td><td class="n">${dd2 == null ? '' : (dd2 > 0 ? '+' : '') + dd2}</td><td class="n">${dd2 ? esc(money(dd2 * (x.costCents || 0))) : ''}</td><td>${esc(x.countedBy || '')}</td></tr>`; }).join('')}</tbody><tfoot><tr class="tot"><td colspan="4" class="n">Variance</td><td class="n">${t.varianceQty > 0 ? '+' : ''}${t.varianceQty}</td><td class="n">${esc(money(t.varianceValueCents))}</td><td></td></tr></tfoot></table></div>`, A4_CSS);
}
