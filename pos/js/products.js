// Retail POS — the product manager: create, edit and archive products,
// variants (up to three options), several barcodes, categories, brands,
// cost, price and margin, VAT class, product type, images, a price per
// store, Shopify's product CSV in and out, and barcode labels.
//
// Managers and the owner edit; everyone reads (the sale screen needs the
// catalogue). Money is typed in rands and kept in cents.
import { setOne, patchOne, newId, batch } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, empty, money, openPrint } from './ui.js';
import { marginPct, rateOn, rateFor, centsOf, randsOf } from './money.js';
import { parseCsv, toCsv, csvObjects, download } from './csv.js';
import { barcodeSvg, encodable, nextShopCode } from './barcode.js';

export const TYPES = [
  { key: 'stock', label: 'Stock item' }, { key: 'nonstock', label: 'Non-stock (service, fee)' },
  { key: 'mto', label: 'Made to order' }, { key: 'bundle', label: 'Bundle' }, { key: 'voucher', label: 'Gift voucher' }
];
export const VAT_CLASSES = [{ key: 'standard', label: 'Standard' }, { key: 'zero', label: 'Zero-rated' }, { key: 'exempt', label: 'Exempt' }];
const typeLabel = (k) => (TYPES.find(t => t.key === k) || { label: k }).label;
const uniq = (a) => [...new Set(a.filter(Boolean))];
const codes = (text) => uniq(String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
// block tags become a space, inline ones (<b>, <i>) nothing, so sentences keep their shape
const stripHtml = (h) => String(h || '').replace(/<\/?(p|div|br|li|ul|ol|h\d|tr|td|table)[^>]*>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
export const itemVariants = (d, productId) => d.variants.filter(v => v.productId === productId);

// the entity's VAT rate today, for the margin shown
function entityRate(d, entityId) {
  const ent = d.entities.find(e => e.id === entityId);
  const s = d.settings[entityId];
  return ent && ent.vatRegistered ? rateOn(s && s.vat && s.vat.rates, new Date().toISOString()) : 0;
}
const margin = (d, p) => { const r = rateFor(p.vatClass, entityRate(d, p.entityId), !!(d.entities.find(e => e.id === p.entityId) || {}).vatRegistered); return marginPct(p.priceCents, p.costCents, r); };
const thumb = (p) => (p.images && p.images[0]) ? `<img class="pr-thumb" src="${esc(p.images[0])}" alt="" loading="lazy">` : `<span class="pr-thumb none">${esc(String(p.name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase())}</span>`;

async function logChange(entityId, action, docId, details) {
  try { await setOne('auditLog', newId('auditLog'), { action, docType: 'product', docId, docNo: '', actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '', details, ...auth.stamp(entityId, '') }); }
  catch (e) { console.error('audit failed', e); }
}

// ------------------------------------------------------------- the list --
export function productsHtml(d) {
  const mine = d.entities.filter(e => auth.inEntity(e.id));
  if (!mine.length) return `<div class="page-head"><h1>Products</h1></div>${empty('No companies yet', 'Add one under Admin → Companies.')}`;
  const eid = mine.some(e => e.id === d.prEntity) ? d.prEntity : (auth.session.device && mine.some(e => e.id === auth.session.device.entityId) ? auth.session.device.entityId : mine[0].id);
  const f = d.prFilter;
  const all = d.products.filter(p => p.entityId === eid);
  const cats = uniq(all.map(p => p.category)).sort(), brands = uniq(all.map(p => p.brand)).sort();
  const q = String(f.q || '').toLowerCase().trim();
  const list = all.filter(p => (f.archived ? true : !p.archived) && (!f.category || p.category === f.category) && (!f.brand || p.brand === f.brand) && (!f.type || p.type === f.type)
    && (!q || [p.name, p.sku, p.category, p.brand, ...(p.barcodes || []), ...itemVariants(d, p.id).flatMap(v => [v.sku, ...(v.barcodes || [])])].some(x => String(x || '').toLowerCase().includes(q))))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const edits = auth.atLeast('manager');
  const sel = (id, opts, cur, blank) => `<select id="${id}"><option value="">${esc(blank)}</option>${opts.map(o => `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  return `<div class="page-head"><h1>Products</h1>
      <div class="btn-row" style="margin:0">
        ${mine.length > 1 ? `<select id="pr-entity" class="in-sm">${mine.map(e => `<option value="${esc(e.id)}"${e.id === eid ? ' selected' : ''}>${esc(e.tradingName || e.legalName)}</option>`).join('')}</select>` : ''}
        ${edits ? `<label class="btn ghost" title="Shopify's product CSV">Import CSV<input type="file" id="pr-file" accept=".csv,text/csv" hidden></label><button class="btn ghost" data-act="pr-export">Export CSV</button><button class="btn ghost" data-act="pr-costs" title="Costs, and prices if you want, from a spreadsheet">Import costs &amp; prices</button>` : ''}
        <button class="btn ghost" data-act="pr-labels" title="Barcode labels for the ticked products">Labels</button>
        ${edits ? '<button class="btn primary" data-act="pr-new">＋ New product</button>' : ''}
      </div></div>
    <div class="toolbar">
      <input id="pr-q" class="search" type="search" placeholder="Name, SKU, barcode…" value="${esc(f.q || '')}">
      ${sel('pr-cat', cats.map(c => ({ value: c, label: c })), f.category || '', 'All categories')}
      ${sel('pr-brand', brands.map(c => ({ value: c, label: c })), f.brand || '', 'All brands')}
      ${sel('pr-type', TYPES.map(t => ({ value: t.key, label: t.label })), f.type || '', 'All types')}
      <label class="chk"><input type="checkbox" id="pr-archived"${f.archived ? ' checked' : ''}> Show archived</label>
    </div>
    <p class="sub muted" style="margin:0 0 .6rem">${list.length} of ${all.length} product${all.length === 1 ? '' : 's'}</p>
    ${list.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl pr-tbl" data-entity="${esc(eid)}">
      <thead><tr><th><input type="checkbox" id="pr-all" title="Tick all for labels"></th><th></th><th>Product</th><th>SKU · barcodes</th><th>Category · brand</th><th>Type</th><th>VAT</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Margin</th><th></th></tr></thead>
      <tbody>${list.map(p => { const vs = itemVariants(d, p.id).filter(v => !v.archived); const m = margin(d, p); return `<tr class="${p.archived ? 'off' : ''}">
        <td><input type="checkbox" data-lbl="${esc(p.id)}"></td><td>${thumb(p)}</td>
        <td><strong>${esc(p.name)}</strong>${p.archived ? ' <span class="chip">archived</span>' : ''}${vs.length ? `<div class="muted">${vs.length} variant${vs.length === 1 ? '' : 's'}: ${esc(vs.slice(0, 4).map(v => v.name).join(', '))}${vs.length > 4 ? '…' : ''}</div>` : ''}${p.trackStock === false && p.type === 'stock' ? '<div class="muted">stock not tracked</div>' : ''}${p.favourite ? ' <span class="chip">favourite</span>' : ''}</td>
        <td class="muted">${esc(p.sku || '')}${(p.barcodes || []).length ? '<br>' + esc((p.barcodes || []).join(', ')) : ''}</td>
        <td class="muted">${esc(p.category || '')}${p.brand ? '<br>' + esc(p.brand) : ''}</td>
        <td class="muted">${esc(typeLabel(p.type))}</td><td class="muted">${esc(p.vatClass || 'standard')}</td>
        <td class="r">${esc(money(p.costCents))}</td><td class="r"><strong>${esc(money(p.priceCents))}</strong>${Object.keys(p.storePrices || {}).length ? '<div class="muted">per store</div>' : ''}</td>
        <td class="r ${m != null && m < 0 ? 'warn' : ''}">${m == null ? '' : esc(m + '%')}</td>
        <td class="r nowrap">${edits ? `<button class="btn ghost sm" data-act="pr-edit" data-id="${esc(p.id)}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : empty(all.length ? 'No products match' : 'No products yet', all.length ? 'Change the search or filters.' : edits ? 'Add one, or import Shopify’s product CSV.' : '')}`;
}

// ------------------------------------------------------------- the form --
const OPT_MAX = 3;
// metres as typed (11.5, 11,5); null when blank or not a positive number
const metresOf = (t) => { const n = Number(String(t == null ? '' : t).trim().replace(',', '.')); return String(t == null ? '' : t).trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const variantKey = (vals) => Object.keys(vals).sort().map(k => k + '=' + vals[k]).join('|');
export function openProductForm(d, productId, entityId) {
  const p = productId ? d.products.find(x => x.id === productId) : null;
  const eid = p ? p.entityId : entityId;
  const ent = d.entities.find(e => e.id === eid) || {};
  const stores = d.stores.filter(s => s.entityId === eid && s.active !== false);
  const cats = uniq(d.products.filter(x => x.entityId === eid).map(x => x.category)).sort(), brands = uniq(d.products.filter(x => x.entityId === eid).map(x => x.brand)).sort();
  const existing = p ? itemVariants(d, p.id) : [];
  const opts = (p && p.options) || [];
  const x = p || { type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], barcodes: [], storePrices: {}, bundle: [] };
  const html = `<div class="pf" data-entity="${esc(eid)}" data-id="${esc(p ? p.id : '')}">
    ${row(field('Name', 'pf-name', { value: x.name, placeholder: 'e.g. 3 Seater Chesterfield' }), field('SKU', 'pf-sku', { value: x.sku, placeholder: 'your own code' }))}
    ${row(field('Barcodes (scan or type; several, separated by spaces)', 'pf-barcodes', { value: (x.barcodes || []).join(' '), placeholder: 'scan here' }), field('Category', 'pf-cat', { value: x.category, list: 'pf-cats' }))}
    <datalist id="pf-cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist><datalist id="pf-brands">${brands.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    ${row(field('Brand', 'pf-brand', { value: x.brand, list: 'pf-brands' }), field('Type', 'pf-type', { type: 'select', value: x.type, options: TYPES.map(t => ({ value: t.key, label: t.label })) }))}
    <div class="fld-row">${field('VAT class', 'pf-vat', { type: 'select', value: x.vatClass || 'standard', options: VAT_CLASSES.map(v => ({ value: v.key, label: v.label })) })}<div class="fld"><span>Stock and the till</span><label class="chk"><input type="checkbox" id="pf-track"${x.trackStock !== false ? ' checked' : ''}> Track stock on hand</label><label class="chk"><input type="checkbox" id="pf-fav"${x.favourite ? ' checked' : ''}> Show on the till’s favourites</label></div></div>
    <div class="grid three">${field('Cost (R, excl. VAT)', 'pf-cost', { value: randsOf(x.costCents), inputmode: 'decimal' })}${field('Selling price (R, incl. VAT)', 'pf-price', { value: randsOf(x.priceCents), inputmode: 'decimal' })}<div class="fld"><span>Margin</span><div class="pf-margin" id="pf-margin">–</div></div></div>
    <div class="fld" id="pf-fabric"${x.type === 'mto' ? '' : ' hidden'}>${field('Fabric needed (metres): the till adds metres × the chosen fabric’s price per metre', 'pf-fabricm', { value: x.fabricMetres == null ? '' : x.fabricMetres, inputmode: 'decimal', placeholder: 'e.g. 11.5 for a 3-seater' })}</div>
    ${row(field('Reorder when stock falls to', 'pf-reorder', { value: x.reorderLevel == null ? '' : x.reorderLevel, type: 'number', min: 0 }), field('Reorder quantity', 'pf-reorderqty', { value: x.reorderQty == null ? '' : x.reorderQty, type: 'number', min: 0 }))}
    ${field('Pictures (web addresses, one per line)', 'pf-images', { type: 'textarea', value: (x.images || []).join('\n'), rows: 2 })}
    ${field('Description', 'pf-desc', { type: 'textarea', value: x.description, rows: 2 })}
    ${stores.length ? `<div class="fld"><span>Price per store (blank = the price above)</span><div class="sp-grid">${stores.map(s => `<label>${esc(s.name)}<input data-sp="${esc(s.id)}" value="${x.storePrices && x.storePrices[s.id] != null ? randsOf(x.storePrices[s.id]) : ''}" inputmode="decimal" placeholder="${randsOf(x.priceCents)}"></label>`).join('')}</div></div>` : ''}
    <div class="fld"><span>Variants: up to three options (e.g. Colour: Grey, Navy · Size: 2 seater, 3 seater)</span>
      ${[0, 1, 2].map(i => `<div class="opt-row"><input id="pf-opt${i}-name" placeholder="Option ${i + 1} name" value="${esc(opts[i] ? opts[i].name : '')}"><input id="pf-opt${i}-vals" placeholder="values, separated by commas" value="${esc(opts[i] ? opts[i].values.join(', ') : '')}"></div>`).join('')}
      <div class="card-actions" style="margin-top:.4rem"><button class="btn ghost sm" data-act="pr-gen">Build the variant list</button></div>
      <div id="pf-variants">${variantGridHtml(existing.map(v => ({ ...v, _id: v.id })))}</div>
    </div>
    <div class="fld" id="pf-bundle"${x.type === 'bundle' ? '' : ' hidden'}><span>Bundle: what it is made of</span>
      <div id="pf-bundle-rows">${(x.bundle || []).map(b => bundleRowHtml(d, eid, b)).join('')}</div>
      <div class="card-actions" style="margin-top:.4rem"><button class="btn ghost sm" data-act="pr-bundle-add">＋ Add an item</button></div>
    </div>
    ${p ? `<label class="chk"><input type="checkbox" id="pf-archived"${p.archived ? ' checked' : ''}> Archived (not for sale, kept for history)</label>` : ''}
  </div>`;
  const m = openModal(p ? 'Edit ' + p.name : 'New product · ' + (ent.tradingName || ent.legalName || ''), html, {
    okLabel: p ? 'Save' : 'Add product',
    onOk: (wrap) => saveProduct(wrap, d, p, existing)
  });
  m.wrap.querySelector('.modal-card').classList.add('wide');
  const w = m.wrap;
  const live = () => { const r = rateFor(val(w, 'pf-vat'), entityRate(d, eid), !!ent.vatRegistered); const mg = marginPct(centsOf(val(w, 'pf-price')), centsOf(val(w, 'pf-cost')), r); const el = w.querySelector('#pf-margin'); el.textContent = mg == null ? '–' : mg + '%'; el.classList.toggle('warn', mg != null && mg < 0); };
  w.addEventListener('input', (e) => { if (['pf-cost', 'pf-price', 'pf-vat'].includes(e.target.id)) live(); });
  w.addEventListener('change', (e) => { if (e.target.id === 'pf-type') { w.querySelector('#pf-bundle').hidden = e.target.value !== 'bundle'; w.querySelector('#pf-fabric').hidden = e.target.value !== 'mto'; } if (e.target.id === 'pf-vat') live(); });
  w.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'pr-gen') buildVariants(w);
    if (b.dataset.act === 'pr-bundle-add') w.querySelector('#pf-bundle-rows').insertAdjacentHTML('beforeend', bundleRowHtml(d, eid, { productId: '', variantId: '', qty: 1 }));
    if (b.dataset.act === 'pr-bundle-del') b.closest('.bundle-row').remove();
    if (b.dataset.act === 'pr-var-del') b.closest('tr').remove();
  });
  // a scanner into the barcode box: Enter adds the code instead of submitting
  w.querySelector('#pf-barcodes').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.value = codes(e.target.value).join(' ') + ' '; } });
  live();
}
function bundleRowHtml(d, eid, b) {
  const items = d.products.filter(p => p.entityId === eid && !p.archived && p.type !== 'bundle').sort((a, c) => String(a.name).localeCompare(String(c.name)));
  const opts = items.flatMap(p => { const vs = itemVariants(d, p.id).filter(v => !v.archived); return vs.length ? vs.map(v => ({ value: p.id + ':' + v.id, label: p.name + ' · ' + v.name })) : [{ value: p.id + ':', label: p.name }]; });
  const cur = (b.productId || '') + ':' + (b.variantId || '');
  return `<div class="bundle-row"><select data-bp>${opts.map(o => `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select><input data-bq type="number" min="1" value="${esc(b.qty || 1)}"><button class="icon-btn" data-act="pr-bundle-del" title="Remove">✕</button></div>`;
}
function variantGridHtml(list) {
  if (!list.length) return '<p class="muted" style="margin:.3rem 0 0">No variants: one price, one stock count.</p>';
  return `<table class="tbl var-tbl"><thead><tr><th>Variant</th><th>SKU</th><th>Barcode</th><th>Cost (R)</th><th>Price (R, blank = product’s)</th><th title="Made to order: metres of fabric (blank = the product’s)">Fabric m</th><th>Off</th><th></th></tr></thead><tbody>
    ${list.map(v => `<tr data-key="${esc(variantKey(v.optionValues || {}))}" data-id="${esc(v._id || '')}"><td><strong>${esc(v.name)}</strong></td>
      <td><input data-vsku value="${esc(v.sku || '')}"></td><td><input data-vbar value="${esc((v.barcodes || []).join(' '))}"></td>
      <td><input data-vcost value="${v.costCents == null ? '' : randsOf(v.costCents)}" inputmode="decimal"></td><td><input data-vprice value="${v.priceCents == null ? '' : randsOf(v.priceCents)}" inputmode="decimal"></td><td><input data-vfab value="${v.fabricMetres == null ? '' : esc(v.fabricMetres)}" inputmode="decimal" style="width:4.5rem"></td>
      <td><input type="checkbox" data-varch${v.archived ? ' checked' : ''}></td><td>${v._id ? '' : '<button class="icon-btn" data-act="pr-var-del" title="Remove">✕</button>'}</td></tr>`).join('')}</tbody></table>`;
}
// the options typed → every combination, keeping what is already in the grid
function readOptions(w) {
  const out = [];
  for (let i = 0; i < OPT_MAX; i++) {
    const name = val(w, `pf-opt${i}-name`), values = uniq(val(w, `pf-opt${i}-vals`).split(',').map(s => s.trim()));
    if (name && values.length) out.push({ name, values });
  }
  return out;
}
function readGrid(w) {
  return [...w.querySelectorAll('#pf-variants tbody tr')].map(tr => ({
    key: tr.dataset.key, _id: tr.dataset.id, name: tr.querySelector('strong').textContent,
    sku: tr.querySelector('[data-vsku]').value.trim(), barcodes: codes(tr.querySelector('[data-vbar]').value),
    costCents: tr.querySelector('[data-vcost]').value.trim() === '' ? null : centsOf(tr.querySelector('[data-vcost]').value),
    priceCents: tr.querySelector('[data-vprice]').value.trim() === '' ? null : centsOf(tr.querySelector('[data-vprice]').value),
    fabricMetres: metresOf(tr.querySelector('[data-vfab]').value),
    archived: tr.querySelector('[data-varch]').checked
  }));
}
function buildVariants(w) {
  const options = readOptions(w);
  if (!options.length) { w.querySelector('#pf-variants').innerHTML = variantGridHtml([]); return; }
  let combos = [{}];
  for (const o of options) combos = combos.flatMap(c => o.values.map(v => ({ ...c, [o.name]: v })));
  if (combos.length > 100) return toast('That is ' + combos.length + ' variants; keep it under 100.', 'warn');
  const had = Object.fromEntries(readGrid(w).map(g => [g.key, g]));
  const list = combos.map(vals => { const key = variantKey(vals); const g = had[key]; return { optionValues: vals, name: options.map(o => vals[o.name]).join(' / '), sku: g ? g.sku : '', barcodes: g ? g.barcodes : [], costCents: g ? g.costCents : null, priceCents: g ? g.priceCents : null, fabricMetres: g ? g.fabricMetres : null, archived: g ? g.archived : false, _id: g ? g._id : '' }; });
  w.querySelector('#pf-variants').innerHTML = variantGridHtml(list);
}
async function saveProduct(w, d, p, existing) {
  const eid = w.querySelector('.pf').dataset.entity;
  const data = {
    name: val(w, 'pf-name'), sku: val(w, 'pf-sku'), barcodes: codes(val(w, 'pf-barcodes')), category: val(w, 'pf-cat'), brand: val(w, 'pf-brand'),
    type: val(w, 'pf-type'), vatClass: val(w, 'pf-vat'), trackStock: !!w.querySelector('#pf-track').checked, favourite: !!w.querySelector('#pf-fav').checked,
    costCents: centsOf(val(w, 'pf-cost')), priceCents: centsOf(val(w, 'pf-price')),
    reorderLevel: val(w, 'pf-reorder') === '' ? null : Number(val(w, 'pf-reorder')), reorderQty: val(w, 'pf-reorderqty') === '' ? null : Number(val(w, 'pf-reorderqty')),
    images: val(w, 'pf-images').split(/\n+/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s)), description: val(w, 'pf-desc'),
    storePrices: Object.fromEntries([...w.querySelectorAll('[data-sp]')].filter(i => i.value.trim() !== '').map(i => [i.dataset.sp, centsOf(i.value)])),
    options: readOptions(w), bundle: [], archived: p ? !!w.querySelector('#pf-archived').checked : false,
    fabricMetres: val(w, 'pf-type') === 'mto' ? metresOf(val(w, 'pf-fabricm')) : null
  };
  data.hasVariants = data.options.length > 0;
  if (data.type === 'bundle') data.bundle = [...w.querySelectorAll('.bundle-row')].map(r => { const [productId, variantId] = r.querySelector('[data-bp]').value.split(':'); return { productId, variantId: variantId || '', qty: Math.max(1, Math.round(Number(r.querySelector('[data-bq]').value) || 1)) }; }).filter(b => b.productId);
  if (!data.name) { toast('Give the product a name.', 'warn'); return false; }
  if (data.priceCents < 0 || data.costCents < 0) { toast('Prices cannot be negative.', 'warn'); return false; }
  if (data.type === 'bundle' && !data.bundle.length) { toast('A bundle needs at least one item.', 'warn'); return false; }
  const grid = data.hasVariants ? readGrid(w) : [];
  if (data.hasVariants && !grid.length) { toast('Tap “Build the variant list” first.', 'warn'); return false; }
  // a barcode belongs to one item in the company
  const mineCodes = new Set([...data.barcodes, ...grid.flatMap(g => g.barcodes)]);
  for (const other of d.products.filter(x => x.entityId === eid && x.id !== (p && p.id))) {
    const clash = [...(other.barcodes || []), ...itemVariants(d, other.id).flatMap(v => v.barcodes || [])].find(c => mineCodes.has(c));
    if (clash) { toast('Barcode ' + clash + ' already belongs to ' + other.name + '.', 'warn'); return false; }
  }
  try {
    const id = p ? p.id : newId('products');
    if (p) await patchOne('products', id, { ...data, ...auth.touch() });
    else await setOne('products', id, { ...data, shopifyProductId: '', shopifyHandle: '', ...auth.stamp(eid, '') });
    // variants: new rows created, known rows patched, rows no longer in the grid archived
    const keep = new Set();
    for (const g of grid) {
      const vals = Object.fromEntries(g.key.split('|').filter(Boolean).map(kv => kv.split('=')));
      const body = { name: g.name, optionValues: vals, sku: g.sku, barcodes: g.barcodes, costCents: g.costCents, priceCents: g.priceCents, fabricMetres: g.fabricMetres, archived: g.archived, storePrices: {} };
      if (g._id) { keep.add(g._id); await patchOne('variants', g._id, { ...body, ...auth.touch() }); }
      else { const vid = newId('variants'); keep.add(vid); await setOne('variants', vid, { ...body, productId: id, images: [], shopifyVariantId: '', ...auth.stamp(eid, '') }); }
    }
    for (const v of existing) if (!keep.has(v.id) && !v.archived) await patchOne('variants', v.id, { archived: true, ...auth.touch() });
    if (p) {
      const priceChanged = p.priceCents !== data.priceCents || p.costCents !== data.costCents;
      await logChange(eid, priceChanged ? 'product.price' : 'product.save', id, priceChanged ? { name: data.name, before: { priceCents: p.priceCents, costCents: p.costCents }, after: { priceCents: data.priceCents, costCents: data.costCents } } : { name: data.name });
      if (data.archived && !p.archived) await logChange(eid, 'product.archive', id, { name: data.name });
    } else await logChange(eid, 'product.create', id, { name: data.name, priceCents: data.priceCents, costCents: data.costCents, variants: grid.length });
    toast(data.name + (p ? ' saved' : ' added'));
    return true;
  } catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
}

// ----------------------------------------------------------- Shopify CSV --
const SHOPIFY_HEAD = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
  'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card', 'Status', 'Cost per item'];
const handleOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function exportCsv(d, eid) {
  const rows = [SHOPIFY_HEAD];
  for (const p of d.products.filter(x => x.entityId === eid).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const handle = p.shopifyHandle || handleOf(p.name);
    const vs = itemVariants(d, p.id);
    const base = (first) => ({ Handle: handle, Title: first ? p.name : '', 'Body (HTML)': first ? p.description || '' : '', Vendor: first ? p.brand || '' : '', 'Product Category': '', Type: first ? p.category || '' : '', Tags: first ? [p.type !== 'stock' ? p.type : '', p.vatClass !== 'standard' ? 'vat:' + p.vatClass : ''].filter(Boolean).join(', ') : '', Published: first ? (p.archived ? 'FALSE' : 'TRUE') : '',
      'Variant Grams': '', 'Variant Inventory Tracker': p.trackStock === false ? '' : 'shopify', 'Variant Inventory Qty': '', 'Variant Inventory Policy': 'deny', 'Variant Fulfillment Service': 'manual', 'Variant Compare At Price': '', 'Variant Requires Shipping': 'TRUE', 'Variant Taxable': p.vatClass === 'standard' ? 'TRUE' : 'FALSE',
      'Image Src': first ? (p.images || [])[0] || '' : '', 'Image Position': first && (p.images || [])[0] ? '1' : '', 'Image Alt Text': '', 'Gift Card': p.type === 'voucher' ? 'TRUE' : 'FALSE', Status: p.archived ? 'archived' : 'active' });
    if (!vs.length) rows.push(SHOPIFY_HEAD.map(h => ({ ...base(true), 'Option1 Name': 'Title', 'Option1 Value': 'Default Title', 'Variant SKU': p.sku || '', 'Variant Price': randsOf(p.priceCents), 'Variant Barcode': (p.barcodes || [])[0] || '', 'Cost per item': randsOf(p.costCents) })[h] ?? ''));
    else vs.forEach((v, i) => { const o = (p.options || []); const r = { ...base(i === 0), 'Variant SKU': v.sku || '', 'Variant Price': randsOf(v.priceCents == null ? p.priceCents : v.priceCents), 'Variant Barcode': (v.barcodes || [])[0] || '', 'Cost per item': randsOf(v.costCents == null ? p.costCents : v.costCents) };
      o.forEach((opt, k) => { r[`Option${k + 1} Name`] = i === 0 ? opt.name : ''; r[`Option${k + 1} Value`] = (v.optionValues || {})[opt.name] || ''; });
      rows.push(SHOPIFY_HEAD.map(h => r[h] ?? '')); });
  }
  download(toCsv(rows), 'products-' + eid + '-' + new Date().toISOString().slice(0, 10) + '.csv');
  return rows.length - 1;
}
// Shopify's CSV → a plan: products with their variants, matched to what is here by handle, then SKU, then name
export function planImport(text, d, eid) {
  const objs = csvObjects(parseCsv(text));
  if (!objs.length || !('Handle' in objs[0]) || !('Title' in objs[0])) throw new Error('This is not a Shopify product CSV (it needs Handle and Title columns).');
  const groups = new Map();
  let last = null;
  for (const r of objs) {
    const h = r.Handle.trim() || (last && last.handle) || handleOf(r.Title);
    if (!groups.has(h)) groups.set(h, { handle: h, rows: [] });
    const g = groups.get(h); g.rows.push(r); last = g;
  }
  const mine = d.products.filter(p => p.entityId === eid);
  const plan = [];
  for (const g of groups.values()) {
    const first = g.rows.find(r => r.Title.trim()) || g.rows[0];
    const options = [1, 2, 3].map(i => ({ name: (first[`Option${i} Name`] || '').trim(), values: [] })).filter(o => o.name && o.name !== 'Title');
    const variants = g.rows.filter(r => (r['Variant SKU'] || r['Variant Price'] || r['Option1 Value'])).map(r => {
      const vals = {}; options.forEach((o, i) => { const v = (r[`Option${i + 1} Value`] || '').trim(); if (v) { vals[o.name] = v; if (!o.values.includes(v)) o.values.push(v); } });
      return { optionValues: vals, name: options.map(o => vals[o.name]).filter(Boolean).join(' / '), sku: (r['Variant SKU'] || '').trim(), barcodes: codes(r['Variant Barcode']), priceCents: centsOf(r['Variant Price']), costCents: centsOf(r['Cost per item']), image: (r['Image Src'] || '').trim() };
    });
    const images = uniq(g.rows.map(r => (r['Image Src'] || '').trim()));
    const tags = (first.Tags || '').split(',').map(s => s.trim().toLowerCase());
    const type = tags.includes('mto') ? 'mto' : tags.includes('nonstock') ? 'nonstock' : /^true$/i.test(first['Gift Card'] || '') ? 'voucher' : 'stock';
    const vatClass = tags.includes('vat:zero') ? 'zero' : tags.includes('vat:exempt') ? 'exempt' : /^false$/i.test(first['Variant Taxable'] || 'TRUE') ? 'zero' : 'standard';
    const status = (first.Status || '').toLowerCase();
    const product = { name: first.Title.trim(), description: stripHtml(first['Body (HTML)']), brand: (first.Vendor || '').trim(), category: (first.Type || first['Product Category'] || '').trim().split('>').pop().trim(),
      type, vatClass, trackStock: !!(first['Variant Inventory Tracker'] || '').trim(), images, archived: status === 'archived' || status === 'draft' || /^false$/i.test(first.Published || ''),
      options: options.filter(o => o.values.length), shopifyHandle: g.handle };
    product.hasVariants = product.options.length > 0;
    const v0 = variants[0] || { priceCents: 0, costCents: 0, sku: '', barcodes: [] };
    product.priceCents = v0.priceCents; product.costCents = v0.costCents;
    if (!product.hasVariants) { product.sku = v0.sku; product.barcodes = v0.barcodes; }
    else { product.sku = ''; product.barcodes = []; }
    const match = mine.find(p => p.shopifyHandle === g.handle) || (product.sku && mine.find(p => p.sku === product.sku)) || mine.find(p => p.name.toLowerCase() === product.name.toLowerCase());
    plan.push({ handle: g.handle, product, variants: product.hasVariants ? variants : [], existing: match || null });
  }
  return plan;
}
export function openImport(file, d, eid) {
  const reader = new FileReader();
  reader.onload = () => {
    let plan;
    try { plan = planImport(reader.result, d, eid); } catch (e) { return toast(e.message, 'warn'); }
    const adds = plan.filter(x => !x.existing).length, updates = plan.length - adds, vars = plan.reduce((n, x) => n + x.variants.length, 0);
    openModal('Bring in ' + plan.length + ' products from Shopify', `
      <p>${adds} new, ${updates} already here (matched by Shopify handle, SKU or name) and will be updated. ${vars} variant${vars === 1 ? '' : 's'}.</p>
      <p class="muted">Prices and costs come in as rands and are kept in cents. VAT class is Standard unless the row is marked not taxable or tagged vat:zero / vat:exempt. Stock counts are not read from the file: stock here is the sum of movements.</p>
      <div class="pk-list">${plan.slice(0, 40).map(x => `<div class="pk-row"><strong>${esc(x.product.name)}</strong><span>${x.existing ? 'update' : 'new'} · ${esc(money(x.product.priceCents))}${x.variants.length ? ' · ' + x.variants.length + ' variants' : ''}</span></div>`).join('')}${plan.length > 40 ? `<div class="pk-row muted">… and ${plan.length - 40} more</div>` : ''}</div>`, {
      okLabel: 'Bring them in', onOk: async () => { try { const n = await applyImport(plan, d, eid); toast(n + ' products brought in'); return true; } catch (e) { toast('Import stopped: ' + e.message, 'warn'); return false; } }
    });
  };
  reader.readAsText(file);
}
async function applyImport(plan, d, eid) {
  const ops = [];
  let n = 0;
  for (const x of plan) {
    const id = x.existing ? x.existing.id : newId('products');
    const body = { ...x.product, storePrices: x.existing ? x.existing.storePrices || {} : {}, bundle: [], reorderLevel: x.existing ? x.existing.reorderLevel ?? null : null, reorderQty: x.existing ? x.existing.reorderQty ?? null : null, shopifyProductId: x.existing ? x.existing.shopifyProductId || '' : '' };
    if (x.existing) ops.push({ op: 'update', coll: 'products', id, data: { ...body, ...auth.touch() } });
    else ops.push({ op: 'set', coll: 'products', id, data: { ...body, ...auth.stamp(eid, '') } });
    const have = x.existing ? itemVariants(d, id) : [];
    for (const v of x.variants) {
      const key = variantKey(v.optionValues);
      const old = have.find(h => variantKey(h.optionValues || {}) === key) || (v.sku && have.find(h => h.sku === v.sku));
      const vb = { name: v.name, optionValues: v.optionValues, sku: v.sku, barcodes: v.barcodes, costCents: v.costCents, priceCents: v.priceCents, images: v.image ? [v.image] : [], archived: false };
      if (old) ops.push({ op: 'update', coll: 'variants', id: old.id, data: { ...vb, storePrices: old.storePrices || {}, ...auth.touch() } });
      else ops.push({ op: 'set', coll: 'variants', id: newId('variants'), data: { ...vb, productId: id, storePrices: {}, shopifyVariantId: '', ...auth.stamp(eid, '') } });
    }
    n++;
  }
  await batch(ops);
  await logChange(eid, 'product.import', '', { products: n, variants: plan.reduce((k, x) => k + x.variants.length, 0) });
  return n;
}

// --------------------------------------------------------------- labels --
export function printLabels(d, ids, eid) {
  const ent = d.entities.find(e => e.id === eid) || {};
  const items = [];
  for (const id of ids) {
    const p = d.products.find(x => x.id === id); if (!p) continue;
    const vs = itemVariants(d, p.id).filter(v => !v.archived);
    if (!vs.length) items.push({ name: p.name, code: (p.barcodes || [])[0] || p.sku || '', priceCents: p.priceCents });
    else vs.forEach(v => items.push({ name: p.name + ' · ' + v.name, code: (v.barcodes || [])[0] || v.sku || '', priceCents: v.priceCents == null ? p.priceCents : v.priceCents }));
  }
  printLabelItems(items);
}
// labels for a list of { name, code, priceCents, copies? }: 3 across on A4, 70 × 37 mm
export function printLabelItems(items, dflt = 1) {
  const missing = items.filter(i => !i.code || !encodable(i.code));
  if (!items.length) return toast('Nothing to print labels for.', 'warn');
  if (missing.length) toast(missing.length + ' item(s) have no barcode or SKU to print; give them one first.', 'warn');
  const list = items.filter(i => i.code && encodable(i.code));
  if (!list.length) return;
  openModal('Print labels', field('Copies of each (blank = as received)', 'lb-copies', { type: 'number', value: dflt, min: 1, max: 500 }) + `<p class="muted">${list.length} label${list.length === 1 ? '' : 's'}, 3 across on A4 (70 × 37 mm).</p>`, {
    okLabel: 'Print', onOk: (wrap) => {
      const copies = Math.max(1, Math.min(500, Number(val(wrap, 'lb-copies')) || 1));
      const cells = list.flatMap(i => Array.from({ length: Math.min(500, i.copies || copies) }, () => `<div class="lbl"><div class="lbl-name">${esc(i.name)}</div><div class="lbl-price">${esc(money(i.priceCents))}</div><div class="lbl-bar">${barcodeSvg(i.code, 40)}</div><div class="lbl-code">${esc(i.code)}</div></div>`));
      openPrint('Labels', `<div class="lbl-sheet">${cells.join('')}</div>`, `
        @page { size: A4; margin: 10mm 5mm; } .lbl-sheet { display: grid; grid-template-columns: repeat(3, 70mm); gap: 0; }
        .lbl { width: 70mm; height: 37mm; padding: 2mm 3mm; box-sizing: border-box; text-align: center; overflow: hidden; font-family: Arial, sans-serif; break-inside: avoid; }
        .lbl-name { font-size: 10pt; font-weight: 700; line-height: 1.15; max-height: 2.3em; overflow: hidden; } .lbl-price { font-size: 12pt; font-weight: 700; margin: .5mm 0; }
        .lbl-bar svg { width: 58mm; height: 11mm; display: block; margin: 0 auto; } .lbl-code { font-size: 8pt; letter-spacing: .08em; }`);
      return true;
    }
  });
}
