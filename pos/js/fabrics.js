// Retail POS — the fabric catalogue (Stock → Fabrics).
//
// Each company keeps its suppliers' fabrics with the price per metre: the
// supplier's cut price excl. VAT, a markup (80% unless said otherwise) and
// 15% VAT on top, never under the lowest price per metre (R 250), in whole cents. A manager brings a price list in as CSV
// (supplier, design, collection, composition, width, use, cost per metre),
// edits one fabric, or archives it. On the till a made-to-order item's
// specification picks a fabric from here: the item's price gains its metres
// (Products: "Fabric needed") × the fabric's price per metre, and the server
// works the same sum out again before anything is written.
//
//   fabrics/<id>  { entityId, storeId: '', supplier, design, collection, composition, widthCm, use,
//                   costCents (per metre, excl. VAT), markupPct, minPriceCents, listPriceCents (the supplier's
//                   recommended retail, incl. VAT, when there is one: it is the price instead of the markup),
//                   priceCents (per metre, incl. VAT), archived, stamps }
import { batch, setOne, newId, patchOne } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, empty, money } from './ui.js';
import { parseCsv, sepOf, csvObjects } from './csv.js';
import { centsOf, randsOf } from './money.js';
import { fabricLabel, fabricPriceCents, FABRIC_MARKUP, FABRIC_MIN_CENTS } from './special-terms.js';

const MARKUP = FABRIC_MARKUP;
const low = (s) => String(s == null ? '' : s).trim().toLowerCase();
// the price per metre: the supplier's recommended retail when there is one, else cost + markup + VAT; never under the lowest price
const priceFor = (f) => f.listPriceCents > 0 ? Math.max(f.listPriceCents, f.minPriceCents || 0) : fabricPriceCents(f.costCents, f.markupPct, f.minPriceCents);
const keyOf = (f) => low(f.supplier) + '|' + low(f.design) + '|' + low(f.collection);
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
export const fb = { entity: '', q: '', supplier: '', archived: false };

const mine = () => { const d = ctx.data(); return d.entities.filter(e => auth.inEntity(e.id)); };
const entityId = () => { const m = mine(); return m.some(e => e.id === fb.entity) ? fb.entity : (m[0] || {}).id || ''; };
export const fabricsOf = (all, eid) => (all || []).filter(f => f.entityId === eid);
const matches = (f, q) => !q || [f.design, f.collection, f.supplier, f.composition].some(x => low(x).includes(q));

// ------------------------------------------------------------- the list --
export function fabricsHtml() {
  const d = ctx.data(), m = mine();
  if (!m.length) return `<div class="page-head"><h1>Fabrics</h1></div>${empty('No companies yet', 'Add one under Admin → Companies.')}`;
  const eid = entityId(), all = fabricsOf(d.fabrics, eid);
  const sups = [...new Set(all.map(f => f.supplier).filter(Boolean))].sort();
  const q = low(fb.q);
  const list = all.filter(f => (fb.archived || !f.archived) && (!fb.supplier || f.supplier === fb.supplier) && matches(f, q))
    .sort((a, b) => String(a.supplier).localeCompare(String(b.supplier)) || String(a.design).localeCompare(String(b.design)));
  const edits = auth.atLeast('manager');
  const shown = list.slice(0, 300);
  return `<div class="page-head"><h1>Fabrics</h1>
      <div class="btn-row" style="margin:0">
        ${m.length > 1 ? `<select id="fb-entity" class="in-sm">${m.map(e => `<option value="${esc(e.id)}"${e.id === eid ? ' selected' : ''}>${esc(e.tradingName || e.legalName)}</option>`).join('')}</select>` : ''}
        ${edits ? `<label class="btn ghost" title="A price list as CSV: supplier, design, collection, composition, width, use, cost per metre (excl. VAT)">Import price list<input type="file" id="fb-file" accept=".csv,text/csv,.txt" hidden></label><button class="btn primary" data-act="fb-new">＋ Fabric</button>` : ''}
      </div></div>
    <p class="muted" style="margin:-.4rem 0 .8rem">Price per metre = the supplier’s cost (excl. VAT) + the markup + 15% VAT, never under the lowest price per metre. On a made-to-order item the till adds the item’s metres × this price.</p>
    <div class="toolbar">
      <input id="fb-q" class="search" type="search" placeholder="Design, collection, supplier, composition…" value="${esc(fb.q)}">
      <select id="fb-supplier"><option value="">All suppliers</option>${sups.map(s => `<option value="${esc(s)}"${s === fb.supplier ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="fb-archived"${fb.archived ? ' checked' : ''}> Show archived</label>
    </div>
    <p class="sub muted" style="margin:0 0 .6rem">${list.length} of ${all.length} fabric${all.length === 1 ? '' : 's'}${list.length > shown.length ? ' · the first ' + shown.length + ' shown: search to narrow' : ''}</p>
    ${shown.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl fb-tbl" data-entity="${esc(eid)}">
      <thead><tr><th>Design</th><th>Collection</th><th>Supplier</th><th>Composition</th><th class="r">Width</th><th>Use</th><th class="r">Cost / m</th><th class="r">Price / m</th><th></th></tr></thead>
      <tbody>${shown.map(f => `<tr class="${f.archived ? 'off' : ''}"><td><strong>${esc(f.design)}</strong>${f.archived ? ' <span class="chip">archived</span>' : ''}</td><td>${esc(f.collection || '')}</td><td>${esc(f.supplier || '')}</td>
        <td class="muted">${esc(f.composition || '')}</td><td class="r">${f.widthCm ? esc(f.widthCm) + ' cm' : ''}</td><td class="muted">${esc(f.use || '')}</td>
        <td class="r">${esc(money(f.costCents))}</td><td class="r"><strong>${esc(money(f.priceCents))}</strong>${f.listPriceCents > 0 ? `<div class="muted">${f.priceCents === f.listPriceCents ? 'supplier’s retail' : 'lowest price'}</div>` : f.markupPct != null ? `<div class="muted">+${esc(f.markupPct)}%${f.minPriceCents && f.priceCents === f.minPriceCents ? ' · lowest price' : ''}</div>` : ''}</td>
        <td>${edits ? `<button class="btn ghost sm" data-act="fb-edit" data-id="${esc(f.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : empty(all.length ? 'No fabrics match' : 'No fabrics yet', all.length ? 'Change the search or the supplier.' : edits ? 'Import a supplier’s price list (CSV), or add one fabric.' : '')}`;
}

export function action(act, b) {
  if (act === 'fb-new') return openFabric(null);
  if (act === 'fb-edit') return openFabric(fabricsOf(ctx.data().fabrics, entityId()).find(f => f.id === b.dataset.id) || null);
}
export function onInput(id, value) { if (id === 'fb-q') { fb.q = value; ctx.repaint(); const q = document.getElementById('fb-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } }
export function onChange(e) {
  if (e.target.id === 'fb-entity') { fb.entity = e.target.value; ctx.repaint(); }
  if (e.target.id === 'fb-supplier') { fb.supplier = e.target.value; ctx.repaint(); }
  if (e.target.id === 'fb-archived') { fb.archived = e.target.checked; ctx.repaint(); }
  if (e.target.id === 'fb-file') { const f = e.target.files && e.target.files[0]; if (f) openImport(f); e.target.value = ''; }
}

// ----------------------------------------------------------- one fabric --
function openFabric(f) {
  const eid = f ? f.entityId : entityId();
  const x = f || { supplier: fb.supplier || '', design: '', collection: '', composition: '', widthCm: '', use: 'Upholstery', costCents: 0, markupPct: MARKUP, minPriceCents: FABRIC_MIN_CENTS };
  const m = openModal(f ? 'Fabric ' + f.design : 'New fabric', `
    ${row(field('Supplier', 'fe-supplier', { value: x.supplier }), field('Design', 'fe-design', { value: x.design }))}
    ${row(field('Collection', 'fe-collection', { value: x.collection }), field('Composition', 'fe-comp', { value: x.composition }))}
    ${row(field('Width (cm)', 'fe-width', { value: x.widthCm || '', inputmode: 'numeric' }), field('Use', 'fe-use', { value: x.use || '' }))}
    ${row(field('Cost per metre (R, excl. VAT)', 'fe-cost', { value: randsOf(x.costCents), inputmode: 'decimal' }), field('Markup %', 'fe-markup', { value: x.markupPct != null ? x.markupPct : MARKUP, inputmode: 'decimal' }))}
    ${row(field('Lowest price per metre (R, incl. VAT)', 'fe-min', { value: randsOf(x.minPriceCents != null ? x.minPriceCents : FABRIC_MIN_CENTS), inputmode: 'decimal' }), field('Supplier’s retail per metre (R, incl. VAT; blank = cost + markup)', 'fe-list', { value: x.listPriceCents > 0 ? randsOf(x.listPriceCents) : '', inputmode: 'decimal' }))}
    <p>Price per metre, incl. VAT: <strong id="fe-price"></strong></p>
    ${f ? `<label class="chk"><input type="checkbox" id="fe-archived"${f.archived ? ' checked' : ''}> Archived (not offered on new orders)</label>` : ''}`, {
    okLabel: f ? 'Save' : 'Add fabric', onOk: async (w) => {
      const data = { supplier: val(w, 'fe-supplier'), design: val(w, 'fe-design'), collection: val(w, 'fe-collection'), composition: val(w, 'fe-comp'), widthCm: Math.round(Number(val(w, 'fe-width')) || 0) || '',
        use: val(w, 'fe-use'), costCents: centsOf(val(w, 'fe-cost')), markupPct: Number(String(val(w, 'fe-markup')).replace(',', '.')) || 0, minPriceCents: centsOf(val(w, 'fe-min')), listPriceCents: centsOf(val(w, 'fe-list')) || 0 };
      data.priceCents = priceFor(data);
      if (!data.design || !data.supplier) { toast('A fabric needs its supplier and design.', 'warn'); return false; }
      if (!(data.costCents > 0)) { toast('The cost per metre, excl. VAT.', 'warn'); return false; }
      try {
        if (f) await patchOne('fabrics', f.id, { ...data, archived: !!(w.querySelector('#fe-archived') || {}).checked, ...auth.touch() });
        else await setOne('fabrics', newId('fabrics'), { ...data, archived: false, ...auth.stamp(eid, '') });
        toast(data.design + (f ? ' saved' : ' added') + ': ' + money(data.priceCents) + ' a metre'); return true;
      } catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
    }
  });
  const live = () => { m.wrap.querySelector('#fe-price').textContent = money(priceFor({ costCents: centsOf(val(m.wrap, 'fe-cost')), markupPct: Number(String(val(m.wrap, 'fe-markup')).replace(',', '.')) || 0, minPriceCents: centsOf(val(m.wrap, 'fe-min')), listPriceCents: centsOf(val(m.wrap, 'fe-list')) || 0 })); };
  m.wrap.addEventListener('input', live); live();
}

// ------------------------------------------------------- a price list --
const norm = (h) => low(h).replace(/[^a-z0-9]/g, '');
function columnsOf(head) {
  const h = head.map(norm), find = (names) => h.findIndex(x => names.includes(x));
  return { supplier: find(['supplier', 'brand', 'vendor']), design: find(['design', 'name', 'fabric', 'description']), collection: find(['collection', 'range', 'book', 'primarybookrange']),
    composition: find(['composition']), width: find(['widthcm', 'width']), use: find(['use']), cost: find(['costpermetre', 'cost', 'cut', 'cutprice', 'price', 'costexclvat', 'trade']),
    retail: find(['retailpricepermetre', 'retailprice', 'recommendedretail', 'recommendedretailprice', 'retailpermetre', 'retailinclvat']) };
}
export function planImport(text, existing, markupPct, minCents = FABRIC_MIN_CENTS) {
  const rows = parseCsv(text, sepOf(text));
  if (rows.length < 2) throw new Error('The file has no rows under its heading.');
  const col = columnsOf(rows[0]);
  if (col.design < 0 || col.cost < 0) throw new Error('The file needs a Design column and a Cost per metre column (excl. VAT).');
  const have = new Map(existing.map(f => [keyOf(f), f]));
  const cell = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');
  const seen = new Set(), adds = [], updates = [], bad = [];
  let same = 0;
  rows.slice(1).forEach((r, n) => {
    const f = { supplier: cell(r, col.supplier), design: cell(r, col.design), collection: cell(r, col.collection), composition: cell(r, col.composition),
      widthCm: Math.round(Number(cell(r, col.width).replace(/[^\d.]/g, '')) || 0) || '', use: cell(r, col.use) || 'Upholstery' };
    const cost = centsOf(cell(r, col.cost).replace(/^R\s*/i, ''));
    if (!f.design) return;
    if (!(cost > 0)) { bad.push({ line: n + 2, what: f.design }); return; }
    const k = keyOf(f); if (seen.has(k)) return; seen.add(k);
    f.costCents = cost; f.markupPct = markupPct; f.minPriceCents = minCents; f.listPriceCents = col.retail >= 0 ? centsOf(cell(r, col.retail).replace(/^R\s*/i, '')) || 0 : 0; f.priceCents = priceFor(f);
    const old = have.get(k);
    if (!old) adds.push(f);
    else if (old.costCents === f.costCents && old.priceCents === f.priceCents && old.markupPct === f.markupPct && old.minPriceCents === f.minPriceCents && (old.listPriceCents || 0) === f.listPriceCents && !old.archived && old.composition === f.composition && String(old.widthCm || '') === String(f.widthCm || '') && old.use === f.use) same++;
    else updates.push({ id: old.id, from: old, f });
  });
  return { adds, updates, same, bad };
}
function openImport(file) {
  const eid = entityId(), existing = fabricsOf(ctx.data().fabrics, eid);
  const r = new FileReader();
  r.onload = () => {
    const text = r.result;
    let plan = null, busy = false;
    const m = openModal('Import a fabric price list', `
      <p>Costs are per metre, <strong>excl. VAT</strong> (the supplier’s cut price). The price per metre on the till is the cost + the markup + 15% VAT, never under the lowest price. When the list has a <strong>Retail price</strong> column (the supplier’s recommended retail, incl. VAT), that is the price instead.</p>
      ${row(field('Markup %', 'fi-markup', { value: MARKUP, inputmode: 'decimal' }), field('Lowest price per metre (R, incl. VAT)', 'fi-min', { value: randsOf(FABRIC_MIN_CENTS), inputmode: 'decimal' }))}
      <div id="fi-plan"></div>`, {
      okLabel: 'Bring them in', onOk: async () => {
        if (!plan || !(plan.adds.length + plan.updates.length)) { toast('Nothing to bring in.', 'warn'); return false; }
        if (busy) return false; busy = true;
        try { const n = await apply(eid, plan); toast(n.added + ' added, ' + n.updated + ' updated'); return true; }
        catch (e) { busy = false; toast('Import stopped: ' + e.message + '. Try again: what was saved stays.', 'warn'); return false; }
      }
    });
    const show = () => {
      const el = m.wrap.querySelector('#fi-plan');
      try { plan = planImport(text, existing, Number(String(val(m.wrap, 'fi-markup')).replace(',', '.')) || 0, centsOf(val(m.wrap, 'fi-min'))); }
      catch (e) { plan = null; el.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
      const sample = [...plan.adds.map(f => ({ f, tag: 'new' })), ...plan.updates.map(u => ({ f: u.f, tag: money(u.from.priceCents) + ' →' }))].slice(0, 40);
      el.innerHTML = `<div class="ci-sum"><strong>${plan.adds.length} new</strong> · ${plan.updates.length} changed · ${plan.same} the same${plan.bad.length ? ` · <span class="warn">${plan.bad.length} without a cost (left out)</span>` : ''}</div>
        ${sample.length ? `<div class="pk-list">${sample.map(x => `<div class="pk-row"><strong>${esc(fabricLabel(x.f))}</strong><span>${esc(x.tag)} ${esc(money(x.f.costCents))} cost → <strong>${esc(money(x.f.priceCents))}</strong> a metre</span></div>`).join('')}${plan.adds.length + plan.updates.length > sample.length ? `<div class="pk-row muted">… and ${plan.adds.length + plan.updates.length - sample.length} more</div>` : ''}</div>` : ''}`;
    };
    m.wrap.querySelector('#fi-markup').addEventListener('input', show); m.wrap.querySelector('#fi-min').addEventListener('input', show); show();
  };
  r.readAsText(file);
}
async function apply(eid, plan) {
  const ops = [
    ...plan.adds.map(f => ({ op: 'set', coll: 'fabrics', id: newId('fabrics'), data: { ...f, archived: false, ...auth.stamp(eid, '') } })),
    ...plan.updates.map(u => ({ op: 'update', coll: 'fabrics', id: u.id, data: { ...u.f, archived: false, ...auth.touch() } }))
  ];
  for (let i = 0; i < ops.length; i += 100) await batch(ops.slice(i, i + 100));
  try { await setOne('auditLog', newId('auditLog'), { action: 'fabric.import', docType: 'fabric', docId: '', docNo: '', actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '', details: { added: plan.adds.length, updated: plan.updates.length, markupPct: (plan.adds[0] || (plan.updates[0] || {}).f || {}).markupPct, minPriceCents: (plan.adds[0] || (plan.updates[0] || {}).f || {}).minPriceCents }, ...auth.stamp(eid, '') }); } catch (e) { console.error('audit failed', e); }
  return { added: plan.adds.length, updated: plan.updates.length };
}

// ---------------------------------------------- the picker on the till --
// pickerHtml + wirePicker: a search box over the company's fabrics; the chosen one's id sits in
// data-fabric on the box, free text (a customer's own fabric) leaves it empty and adds nothing
export function pickerHtml(id, list, chosen, typed, metres) {
  const f = chosen ? list.find(x => x.id === chosen) : null;
  return `<div class="fld fb-pick" id="${id}" data-fabric="${esc(f ? f.id : '')}" data-metres="${esc(metres || 0)}"><span>Fabric${metres ? ` (${esc(metres)} m)` : ''}</span>
    <input class="fb-pick-q" placeholder="Search the fabric catalogue, or type the customer’s own" value="${esc(f ? fabricLabel(f) : typed || '')}" autocomplete="off">
    <div class="fb-pick-list" hidden></div><div class="fb-pick-note muted"></div></div>`;
}
export function wirePicker(root, id, list, onPick) {
  const box = root.querySelector('#' + id); if (!box) return;
  const q = box.querySelector('.fb-pick-q'), ul = box.querySelector('.fb-pick-list'), note = box.querySelector('.fb-pick-note');
  const metres = Number(box.dataset.metres) || 0;
  const live = list.filter(f => !f.archived);
  const say = () => {
    const f = list.find(x => x.id === box.dataset.fabric);
    note.innerHTML = f ? (metres ? `${esc(metres)} m × ${esc(money(f.priceCents))} = <strong>${esc(money(Math.round(metres * f.priceCents)))}</strong> added to the price` : `<span class="warn">This item has no fabric metres (Products → Edit → Fabric needed): the fabric adds nothing to the price.</span>`)
      : q.value.trim() ? 'Not from the catalogue: nothing is added to the price.' : '';
  };
  const show = () => {
    const s = low(q.value), hits = live.filter(f => matches(f, s)).slice(0, 30);
    ul.innerHTML = hits.map(f => `<button type="button" class="fb-pick-row" data-id="${esc(f.id)}"><strong>${esc(f.design)}</strong> <span class="muted">${esc(f.collection && low(f.collection) !== low(f.design) ? f.collection + ' · ' : '')}${esc(f.supplier || '')}</span><span>${esc(money(f.priceCents))}/m</span></button>`).join('') || '<div class="muted" style="padding:.4rem">No catalogue fabric matches: what you type is kept as the customer’s own.</div>';
    ul.hidden = false;
  };
  q.addEventListener('focus', show);
  q.addEventListener('input', () => { box.dataset.fabric = ''; show(); say(); onPick && onPick(null); });
  ul.addEventListener('mousedown', (e) => e.preventDefault());
  ul.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (!b) return; const f = list.find(x => x.id === b.dataset.id); box.dataset.fabric = f.id; q.value = fabricLabel(f); ul.hidden = true; say(); onPick && onPick(f); });
  q.addEventListener('blur', () => setTimeout(() => { ul.hidden = true; }, 150));
  say();
}
export const pickedFabric = (root, id) => { const box = root.querySelector('#' + id); return box ? { fabricId: box.dataset.fabric || '', fabric: box.querySelector('.fb-pick-q').value.trim() } : { fabricId: '', fabric: '' }; };
