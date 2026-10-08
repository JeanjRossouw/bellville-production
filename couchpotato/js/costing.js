// Costing — what each product really costs to build, and what to charge.
//
//   unit cost = materials (bill of materials × current prices)
//             + labour (hours × the factory's hourly rate)
//             + overhead share (monthly overheads ÷ pieces built per month)
//
// Three collections: materials (one document each, with today's price),
// products (one document each, carrying its bill of materials and selling
// price) and the overheads + labour rate, which live in settings.
import * as store from './store.js';
import { esc, money, field, row, val, openModal, toast, empty, niceDate, today } from './ui.js';

export const UNITS = ['m', 'm²', 'sheet', 'each', 'kg', 'L', 'roll', 'pack'];

let materials = [];
let products = [];
let settings = {};
let unwatchM = null, unwatchP = null;
let onChange = null;
let costView = 'products';   // products | materials | overheads

export function startCosting(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  if (unwatchM) unwatchM();
  if (unwatchP) unwatchP();
  unwatchM = store.watch('materials', rows => { materials = rows.sort(byName); if (onChange) onChange(); });
  unwatchP = store.watch('products', rows => { products = rows.sort(byName); if (onChange) onChange(); });
}
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
export const setCostingSettings = (cfg) => { settings = cfg || {}; };
export const setCostView = (v) => { costView = v; };
export const allProducts = () => products;
export const allMaterials = () => materials;
export const materialById = (id) => materials.find(m => m.id === id) || null;
export const productByName = (name) => products.find(p => String(p.name || '').toLowerCase() === String(name || '').toLowerCase()) || null;

// ------------------------------------------------------------- the maths ----

export function overheadPerUnit() {
  const total = (settings.overheads || []).reduce((s, o) => s + (Number(o.monthly) || 0), 0);
  const units = Number(settings.unitsPerMonth) || 0;
  return units > 0 ? total / units : 0;
}
export const labourRate = () => Number(settings.labourRate) || 0;

export function costOf(p) {
  const lines = (p.materials || []).map(l => {
    const m = materialById(l.materialId);
    const qty = Number(l.qty) || 0;
    return { material: m, qty, cost: m ? qty * (Number(m.cost) || 0) : 0, missing: !m };
  });
  const material = lines.reduce((s, l) => s + l.cost, 0);
  const labour = (Number(p.labourHours) || 0) * labourRate();
  const overhead = overheadPerUnit();
  const total = material + labour + overhead;
  const price = Number(p.sellingPrice) || 0;
  const margin = price - total;
  return { lines, material, labour, overhead, total, price, margin, marginPct: price > 0 ? margin / price : null };
}

// ----------------------------------------------------------- materials ------

function materialForm(m) {
  m = m || {};
  return row(
    field('Material', 'm-name', { value: m.name, placeholder: 'e.g. Foam 50mm high density' }),
    field('Unit', 'm-unit', { type: 'select', value: m.unit || 'm', options: UNITS.map(u => ({ value: u, label: u })) })
  ) + row(
    field('Cost per unit (excl. VAT)', 'm-cost', { value: m.cost == null ? '' : m.cost, type: 'number', min: 0, step: '0.01' }),
    field('Supplier', 'm-supplier', { value: m.supplier, placeholder: 'Who you buy it from' })
  ) + row(
    field('Reorder when it drops below', 'm-level', { value: m.reorderLevel || '', type: 'number', min: 0, step: '0.01', placeholder: 'Leave blank to not track' }),
    field('Usual order quantity', 'm-reqty', { value: m.reorderQty || '', type: 'number', min: 0, step: '0.01', placeholder: 'e.g. a roll or a pallet' })
  ) + field('Notes', 'm-notes', { value: m.notes, type: 'textarea', placeholder: 'Size, grade, colour code…' });
}
const readMaterial = (w) => ({ name: val(w, 'm-name'), unit: val(w, 'm-unit'), cost: parseFloat(val(w, 'm-cost')) || 0, supplier: val(w, 'm-supplier'), notes: val(w, 'm-notes'),
  reorderLevel: parseFloat(val(w, 'm-level')) || 0, reorderQty: parseFloat(val(w, 'm-reqty')) || 0 });

export function newMaterial() {
  openModal('New material', materialForm(null), {
    okLabel: 'Save material',
    onOk: async (w) => { const d = readMaterial(w); if (!d.name) { toast('Give the material a name', 'warn'); return false; } await store.create('materials', d); toast('Material added'); }
  });
}
export function editMaterial(id) {
  const m = materialById(id); if (!m) return;
  openModal('Edit ' + m.name, materialForm(m), {
    okLabel: 'Save changes',
    onOk: async (w) => { const d = readMaterial(w); if (!d.name) { toast('Give the material a name', 'warn'); return false; } await store.update('materials', id, d, 'Price or details updated'); toast('Material updated'); }
  });
}
export async function deleteMaterial(id) {
  const m = materialById(id); if (!m) return;
  const used = products.filter(p => (p.materials || []).some(l => l.materialId === id));
  if (used.length) { toast(m.name + ' is used by ' + used.length + ' product' + (used.length === 1 ? '' : 's') + ' — remove it from those first', 'warn'); return; }
  if (!confirm('Remove ' + m.name + ' from the materials list?')) return;
  await store.remove('materials', id);
}

// ------------------------------------------------------------ products ------

function bomRow(l, i) {
  l = l || {};
  return `<div class="bom-row" data-row="${i}">
    <select class="bom-mat"><option value="">— material —</option>${materials.map(m => `<option value="${esc(m.id)}"${m.id === l.materialId ? ' selected' : ''}>${esc(m.name)} (${esc(money(m.cost, settings.currency))}/${esc(m.unit)})</option>`).join('')}</select>
    <input class="bom-qty" type="number" min="0" step="0.01" value="${esc(l.qty == null ? '' : l.qty)}" placeholder="qty">
    <span class="bom-line muted"></span>
    <button type="button" class="icon-btn bom-del" title="Remove">✕</button>
  </div>`;
}

function productForm(p) {
  p = p || {};
  const cur = settings.currency || 'R';
  return row(
    field('Product', 'p-name', { value: p.name, placeholder: 'e.g. 3 Seater Chesterfield' }),
    field('Category', 'p-cat', { value: p.category, placeholder: 'e.g. Sofas, Corner units, Chairs' })
  ) + row(
    field('Labour hours per piece', 'p-hours', { value: p.labourHours == null ? '' : p.labourHours, type: 'number', min: 0, step: '0.25' }),
    field('Selling price each (excl. VAT)', 'p-price', { value: p.sellingPrice == null ? '' : p.sellingPrice, type: 'number', min: 0, step: '0.01' })
  ) + row(
    field('In stock on the showroom floor', 'p-stock', { value: p.stock == null ? '' : p.stock, type: 'number', min: 0, placeholder: '0 = made to order only' }),
    '<div class="fld"></div>'
  ) + `<div class="fld"><span>Bill of materials</span>
      <div id="bom">${(p.materials && p.materials.length ? p.materials : [{}]).map(bomRow).join('')}</div>
      <button type="button" class="btn ghost sm" id="bom-add" style="margin-top:.4rem">＋ Add a material</button>
      ${materials.length ? '' : '<p class="muted">No materials yet — add them under the Materials tab first.</p>'}
    </div>
    <div class="cost-live" id="p-live"></div>`
    + field('Notes', 'p-notes', { value: p.notes, type: 'textarea', placeholder: 'Frame timber, foam grade, anything the floor must know' });
}

function readProduct(w) {
  const lines = [];
  w.querySelectorAll('.bom-row').forEach(r => {
    const materialId = r.querySelector('.bom-mat').value;
    const qty = parseFloat(r.querySelector('.bom-qty').value) || 0;
    if (materialId && qty > 0) lines.push({ materialId, qty });
  });
  return {
    name: val(w, 'p-name'), category: val(w, 'p-cat'),
    labourHours: parseFloat(val(w, 'p-hours')) || 0,
    sellingPrice: parseFloat(val(w, 'p-price')) || 0,
    stock: parseInt(val(w, 'p-stock'), 10) || 0,
    materials: lines, notes: val(w, 'p-notes')
  };
}

function wireProductForm(wrap) {
  // Listen on the modal card, which is rebuilt for every modal, rather than
  // the shared container — otherwise the handlers outlive this form.
  const w = wrap.querySelector('.modal-card') || wrap;
  const cur = settings.currency || 'R';
  const live = () => {
    const out = w.querySelector('#p-live');
    if (!out) return;
    const d = readProduct(w);
    w.querySelectorAll('.bom-row').forEach(r => {
      const m = materialById(r.querySelector('.bom-mat').value);
      const q = parseFloat(r.querySelector('.bom-qty').value) || 0;
      r.querySelector('.bom-line').textContent = m && q ? money(m.cost * q, cur) : '';
    });
    const c = costOf(d);
    out.innerHTML = `
      <div><span>Materials</span><strong>${esc(money(c.material, cur))}</strong></div>
      <div><span>Labour ${d.labourHours || 0}h × ${esc(money(labourRate(), cur))}</span><strong>${esc(money(c.labour, cur))}</strong></div>
      <div><span>Overhead share</span><strong>${esc(money(c.overhead, cur))}</strong></div>
      <div class="tot"><span>Cost to build</span><strong>${esc(money(c.total, cur))}</strong></div>
      <div class="${c.margin < 0 ? 'bad' : 'good'}"><span>Margin at ${esc(money(c.price, cur))}</span><strong>${esc(money(c.margin, cur))}${c.marginPct != null ? ' · ' + Math.round(c.marginPct * 100) + '%' : ''}</strong></div>`;
  };
  w.addEventListener('input', live);
  w.addEventListener('change', live);
  w.querySelector('#bom-add').addEventListener('click', () => {
    const bom = w.querySelector('#bom');
    bom.insertAdjacentHTML('beforeend', bomRow({}, bom.children.length));
    live();
  });
  w.addEventListener('click', (e) => {
    const b = e.target.closest('.bom-del');
    if (b) { b.closest('.bom-row').remove(); live(); }
  });
  live();
}

export function newProduct() {
  const m = openModal('New product', productForm(null), {
    okLabel: 'Save product',
    onOk: async (w) => { const d = readProduct(w); if (!d.name) { toast('Give the product a name', 'warn'); return false; } await store.create('products', d); toast('Product added'); }
  });
  wireProductForm(m.wrap);
}
export function editProduct(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  const m = openModal('Edit ' + p.name, productForm(p), {
    okLabel: 'Save changes',
    onOk: async (w) => { const d = readProduct(w); if (!d.name) { toast('Give the product a name', 'warn'); return false; } await store.update('products', id, d, 'Costing updated'); toast('Product updated'); }
  });
  wireProductForm(m.wrap);
}
export async function duplicateProduct(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  // the copy is a product of its own: not linked to the online shop's item
  const { id: _id, createdAt, createdBy, updatedAt, updatedBy, events, shopifyProductId, shopifyVariantId, shopifyInventoryItemId, source, ...rest } = p;
  await store.create('products', { ...rest, name: p.name + ' (copy)' });
  toast('Copied — now edit the copy');
}
export async function deleteProduct(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  if (!confirm('Remove ' + p.name + ' from the catalogue?')) return;
  await store.remove('products', id);
}

// ------------------------------------------------------------ overheads -----

export async function saveOverheads(host) {
  const rows = [];
  host.querySelectorAll('.oh-row').forEach(r => {
    const name = r.querySelector('.oh-name').value.trim();
    const monthly = parseFloat(r.querySelector('.oh-amt').value) || 0;
    if (name) rows.push({ name, monthly });
  });
  const patch = {
    overheads: rows,
    unitsPerMonth: parseFloat(host.querySelector('#oh-units').value) || 0,
    labourRate: parseFloat(host.querySelector('#oh-rate').value) || 0
  };
  await store.saveSettings(patch);
  settings = { ...settings, ...patch };
  toast('Overheads and labour rate saved');
  return patch;
}

// ---------------------------------------------------------------- render ----

export function renderCosting(host) {
  const cur = settings.currency || 'R';
  const tab = (key, label) => `<button class="btn ${costView === key ? 'primary' : 'ghost'} sm" data-act="cost-view" data-to="${key}">${label}</button>`;
  let body;
  if (costView === 'materials') body = materialsHtml(cur);
  else if (costView === 'overheads') body = overheadsHtml(cur);
  else body = productsHtml(cur);
  host.innerHTML = `
    <div class="page-head">
      <div><h1>Costing</h1><p class="sub">Materials + labour + a share of overheads = what a piece really costs</p></div>
      <div class="btn-row">
        <button class="btn ghost" data-act="print-pricesheet">Price sheet</button>
        <button class="btn ghost" data-act="print-costsheet">Cost sheet</button>
      </div>
    </div>
    <div class="btn-row" style="margin-bottom:.9rem">${tab('products', 'Products')}${tab('materials', 'Materials')}${tab('overheads', 'Overheads & labour')}</div>
    ${body}`;
}

function productsHtml(cur) {
  const oh = overheadPerUnit();
  const warn = !oh || !labourRate()
    ? `<div class="notice-inline">${!labourRate() ? 'No labour rate set' : ''}${!labourRate() && !oh ? ' and ' : ''}${!oh ? 'no overheads or pieces-per-month set' : ''} — costs below are incomplete. Fill in the Overheads & labour tab.</div>` : '';
  const head = `<div class="page-head" style="margin:0 0 .6rem"><p class="sub">${products.length} product${products.length === 1 ? '' : 's'} · overhead share ${esc(money(oh, cur))} per piece · labour ${esc(money(labourRate(), cur))}/h</p>
    <button class="btn primary" data-act="new-product">＋ New product</button></div>`;
  if (!products.length) return head + warn + empty('', 'No products costed yet', 'Add a product and its bill of materials to see what it costs to build.');
  const cats = {};
  products.forEach(p => { (cats[p.category || 'Uncategorised'] = cats[p.category || 'Uncategorised'] || []).push(p); });
  return head + warn + Object.keys(cats).sort().map(cat => `
    <h2 class="cat">${esc(cat)}</h2>
    <div class="card" style="padding:0; overflow:auto">
      <table class="tbl cost">
        <thead><tr><th>Product</th><th class="r">Materials</th><th class="r">Labour</th><th class="r">Overhead</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Margin</th><th></th></tr></thead>
        <tbody>${cats[cat].map(p => { const c = costOf(p); const missing = c.lines.some(l => l.missing); return `<tr>
          <td><strong>${esc(p.name)}</strong>${missing ? ' <span class="chip late">material missing</span>' : ''}<div class="muted">${c.lines.length} material${c.lines.length === 1 ? '' : 's'} · ${p.labourHours || 0}h${Number(p.stock) > 0 ? ' · ' + Number(p.stock) + ' in stock' : ''}</div></td>
          <td class="r">${esc(money(c.material, cur))}</td>
          <td class="r">${esc(money(c.labour, cur))}</td>
          <td class="r">${esc(money(c.overhead, cur))}</td>
          <td class="r"><strong>${esc(money(c.total, cur))}</strong></td>
          <td class="r">${c.price ? esc(money(c.price, cur)) : '<span class="muted">not set</span>'}</td>
          <td class="r ${c.price ? (c.margin < 0 ? 'bad' : c.marginPct < 0.2 ? 'warn' : 'good') : ''}">${c.price ? esc(money(c.margin, cur)) + '<div class="muted">' + Math.round(c.marginPct * 100) + '%</div>' : ''}</td>
          <td class="r nowrap">
            <button class="btn ghost sm" data-act="edit-product" data-id="${esc(p.id)}">Edit</button>
            <button class="btn ghost sm" data-act="dup-product" data-id="${esc(p.id)}" title="Copy">Copy</button>
            <button class="btn danger sm" data-act="del-product" data-id="${esc(p.id)}">Delete</button>
          </td></tr>`; }).join('')}</tbody>
      </table>
    </div>`).join('');
}

function materialsHtml(cur) {
  const usage = {};
  products.forEach(p => (p.materials || []).forEach(l => { usage[l.materialId] = (usage[l.materialId] || 0) + 1; }));
  const head = `<div class="page-head" style="margin:0 0 .6rem"><p class="sub">${materials.length} material${materials.length === 1 ? '' : 's'} · change a price here and every product using it updates</p>
    <button class="btn primary" data-act="new-material">＋ New material</button></div>`;
  if (!materials.length) return head + empty('', 'No materials yet', 'Timber, foam, webbing, fabric, feet, glue — add each with its current price.');
  return head + `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>Material</th><th>Unit</th><th class="r">Cost / unit</th><th>Supplier</th><th class="r">Used in</th><th></th></tr></thead>
    <tbody>${materials.map(m => `<tr>
      <td><strong>${esc(m.name)}</strong>${m.notes ? '<div class="muted">' + esc(m.notes) + '</div>' : ''}</td>
      <td>${esc(m.unit)}</td>
      <td class="r">${esc(money(m.cost, cur))}</td>
      <td>${esc(m.supplier || '')}</td>
      <td class="r">${usage[m.id] || 0} product${(usage[m.id] || 0) === 1 ? '' : 's'}</td>
      <td class="r nowrap"><button class="btn ghost sm" data-act="edit-material" data-id="${esc(m.id)}">Edit</button> <button class="btn danger sm" data-act="del-material" data-id="${esc(m.id)}">Delete</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function overheadsHtml(cur) {
  const rows = (settings.overheads && settings.overheads.length) ? settings.overheads : [{ name: '', monthly: '' }];
  const total = rows.reduce((s, o) => s + (Number(o.monthly) || 0), 0);
  return `
    <div class="card">
      <h2>Monthly overheads</h2>
      <p class="muted">Everything the factory pays whether or not a couch gets built: rent, electricity, salaries, insurance, vehicle, bank charges.</p>
      <div id="oh-rows">${rows.map(o => ohRow(o)).join('')}</div>
      <button type="button" class="btn ghost sm" data-act="oh-add" style="margin-top:.4rem">＋ Add a line</button>
      <div class="cost-live" style="margin-top:.9rem">
        <div class="tot"><span>Total overheads per month</span><strong id="oh-total">${esc(money(total, cur))}</strong></div>
      </div>
    </div>
    <div class="card">
      <h2>Spread over production</h2>
      ${row(
        field('Pieces built in a typical month', 'oh-units', { value: settings.unitsPerMonth == null ? '' : settings.unitsPerMonth, type: 'number', min: 0, placeholder: 'e.g. 60' }),
        field('Labour rate per hour (' + cur + ')', 'oh-rate', { value: settings.labourRate == null ? '' : settings.labourRate, type: 'number', min: 0, step: '0.01', placeholder: 'e.g. 85' })
      )}
      <div class="cost-live"><div class="tot"><span>Overhead share per piece</span><strong id="oh-per">${esc(money(overheadPerUnit(), cur))}</strong></div></div>
      <div class="card-actions"><button class="btn primary" data-act="save-overheads">Save</button></div>
    </div>`;
}
function ohRow(o) {
  return `<div class="oh-row"><input class="oh-name" value="${esc(o.name || '')}" placeholder="e.g. Rent"><input class="oh-amt" type="number" min="0" step="0.01" value="${esc(o.monthly == null ? '' : o.monthly)}" placeholder="per month"><button type="button" class="icon-btn" data-act="oh-del" title="Remove">✕</button></div>`;
}
export function addOverheadRow(host) { host.querySelector('#oh-rows').insertAdjacentHTML('beforeend', ohRow({})); }
export function liveOverheads(host) {
  const cur = settings.currency || 'R';
  let total = 0; host.querySelectorAll('.oh-amt').forEach(i => { total += parseFloat(i.value) || 0; });
  const units = parseFloat((host.querySelector('#oh-units') || {}).value) || 0;
  const t = host.querySelector('#oh-total'); if (t) t.textContent = money(total, cur);
  const per = host.querySelector('#oh-per'); if (per) per.textContent = money(units > 0 ? total / units : 0, cur);
}

// --------------------------------------------------------------- printing ---

const PRINT_CSS = `
  body { font: 12px/1.45 Arial, Helvetica, sans-serif; color: #000; margin: 0; padding: 16px; }
  .no-print { margin-bottom: 12px; } @media print { .no-print { display: none; } }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #000; padding-bottom: 8px; margin-bottom: 14px; }
  .co { font-size: 20px; font-weight: 900; letter-spacing: .08em; } .co small { display: block; font-size: 10px; font-weight: 400; letter-spacing: .12em; color: #444; }
  .t { text-align: right; } .t b { display: block; font-size: 16px; } .t span { font-size: 10px; color: #444; }
  h2 { font-size: 13px; margin: 14px 0 4px; border-bottom: 2px solid #000; letter-spacing: .06em; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #000; padding: 5px 8px; text-align: left; } th { background: #eee; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; }
  .r { text-align: right; } .ft { margin-top: 14px; font-size: 10px; color: #444; }
`;
function openPrint(title, body) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
    <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:800;background:#000;color:#fff;border:0;cursor:pointer">PRINT</button>
    <button onclick="window.close()" style="padding:8px 16px;margin-left:8px;cursor:pointer">CLOSE</button></div>${body}</body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html); win.document.close();
}
function header(sub) {
  return `<div class="hd"><div class="co">${esc((settings.name || 'COUCH POTATO').toUpperCase())}<small>${esc([settings.phone, settings.email].filter(Boolean).join(' · '))}</small></div>
    <div class="t"><b>${esc(sub)}</b><span>${esc(niceDate(today()))}${settings.vatRegistered && settings.vatNo ? ' · VAT ' + esc(settings.vatNo) : ''}</span></div></div>`;
}
const grouped = () => { const c = {}; products.forEach(p => { (c[p.category || 'Products'] = c[p.category || 'Products'] || []).push(p); }); return c; };

// The price sheet is what they hand a customer: prices only, no costs.
export function printPriceSheet() {
  if (!products.length) { toast('No products to print yet', 'warn'); return; }
  const cur = settings.currency || 'R';
  const vat = settings.vatRegistered ? (Number(settings.vatRate) || 0) : 0;
  const cats = grouped();
  const body = header('PRICE LIST') + Object.keys(cats).sort().map(cat => `<h2>${esc(cat)}</h2><table>
    <tr><th>Product</th><th class="r">Price excl. VAT</th>${vat ? '<th class="r">VAT</th><th class="r">Price incl. VAT</th>' : ''}</tr>
    ${cats[cat].filter(p => Number(p.sellingPrice) > 0).map(p => { const px = Number(p.sellingPrice); return `<tr><td>${esc(p.name)}</td><td class="r">${esc(money(px, cur))}</td>${vat ? `<td class="r">${esc(money(px * vat, cur))}</td><td class="r"><b>${esc(money(px * (1 + vat), cur))}</b></td>` : ''}</tr>`; }).join('')}
  </table>`).join('') + `<div class="ft">Prices valid for 30 days from the date above. Made to order${settings.paymentTermsDays ? ' · payment terms ' + settings.paymentTermsDays + ' days' : ''}.</div>`;
  openPrint('Price list', body);
}

// The cost sheet is internal: the full breakdown per product.
export function printCostSheet() {
  if (!products.length) { toast('No products to print yet', 'warn'); return; }
  const cur = settings.currency || 'R';
  const cats = grouped();
  const body = header('COST SHEET — INTERNAL') + `<p>Overhead share ${esc(money(overheadPerUnit(), cur))} per piece (${esc(money((settings.overheads || []).reduce((s, o) => s + (Number(o.monthly) || 0), 0), cur))}/month ÷ ${settings.unitsPerMonth || 0} pieces) · labour ${esc(money(labourRate(), cur))}/h</p>`
    + Object.keys(cats).sort().map(cat => `<h2>${esc(cat)}</h2><table>
    <tr><th>Product</th><th class="r">Materials</th><th class="r">Labour</th><th class="r">Overhead</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Margin</th></tr>
    ${cats[cat].map(p => { const c = costOf(p); return `<tr><td>${esc(p.name)}</td><td class="r">${esc(money(c.material, cur))}</td><td class="r">${esc(money(c.labour, cur))}</td><td class="r">${esc(money(c.overhead, cur))}</td><td class="r"><b>${esc(money(c.total, cur))}</b></td><td class="r">${esc(money(c.price, cur))}</td><td class="r">${esc(money(c.margin, cur))}${c.marginPct != null ? ' (' + Math.round(c.marginPct * 100) + '%)' : ''}</td></tr>`; }).join('')}
  </table>`).join('');
  openPrint('Cost sheet', body);
}
