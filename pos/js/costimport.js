// Retail POS — cost prices (and, when asked, selling prices) from a spreadsheet.
//
// A manager downloads the costs sheet (every product and variant of the
// company with its SKU, barcode, price and cost), fills in the Cost column,
// and brings it back. A supplier's own price list or the Shopify product CSV
// works too: any CSV with a cost column and a SKU, barcode, handle or name
// to find the item by. Names are compared on letters and digits only, and a
// supplier's model code (UVL601) is found inside our own product names.
//
// It changes costCents on products and variants that are already here (and
// updatedBy/updatedAt). When the file also has a Price column, the prices that
// differ are listed apart and change only if the person ticks "Also change
// these prices": priceCents on a product without variants, or on the variant
// itself. A "Frame price" and a "Fabric metres" column (the shops' price lists)
// set framePriceCents and fabricMetres the same way, under their own tick.
// A "Supplier" column sets the product's supplier by name, under its own
// tick: a name not in Buying → Suppliers yet is created there. Per-store
// prices, names, barcodes, pictures and VAT classes are never touched, and
// nothing else is created or deleted. One audit row records every
// change, before and after. Writes go in batches of 100.
import { batch, setOne, newId } from './db.js';
import * as auth from './auth.js';
import { esc, toast, openModal, money } from './ui.js';
import { parseCsv, sepOf, toCsv, download } from './csv.js';
import { randsOf } from './money.js';

export const low = (s) => String(s == null ? '' : s).trim().toLowerCase();
export const norm = (h) => low(h).replace(/[^a-z0-9]/g, '');
const handleOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const skuKey = (s) => low(s).replace(/^'+/, '');           // Excel and Shopify sometimes keep a leading apostrophe
// a supplier's model code in a name (UVL601, LF-T508T, TH32): letters and digits, starting with a letter, 3 or more long
const codesIn = (name) => (String(name || '').match(/[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*/g) || []).map(norm).filter(c => c.length >= 3);
const vkey = (vals) => Object.keys(vals || {}).sort().map(k => low(k) + '=' + low(vals[k])).join('|');
const SHEET_HEAD = ['Product', 'Variant', 'SKU', 'Barcode', 'Price', 'Cost', 'Frame price', 'Fabric metres', 'Supplier'];
const supsOf = (d, eid) => (d.suppliers || []).filter(sp => sp.entityId === eid && !sp.archived);
const supName = (d, p) => (p.supplierId && ((d.suppliers || []).find(sp => sp.id === p.supplierId) || {}).name) || '';
// metres as people type them: 11, 4.5, 4,5; null when blank, NaN when not a number
export function metresOf(text) {
  const t = String(text == null ? '' : text).trim().replace(',', '.').replace(/\s*m$/i, '');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100) / 100;
}

// rands as people type them: 245.50, 245,50, R 1 245.50, 1,245.50, 1245; null when blank, NaN when not a number
export function costCentsOf(text) {
  let t = String(text == null ? '' : text).trim().replace(/^R\s*/i, '').replace(/[\s ']/g, '');
  if (!t) return null;
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}

// every product and variant of the company, as something a row can point at
export function itemsOf(d, eid) {
  const out = [];
  for (const p of d.products.filter(x => x.entityId === eid)) {
    const vs = d.variants.filter(v => v.productId === p.id);
    const pp = Number.isInteger(p.priceCents) ? p.priceCents : 0;
    out.push({ coll: 'products', id: p.id, p, v: null, label: p.name, stored: Number.isInteger(p.costCents) ? p.costCents : 0, now: Number.isInteger(p.costCents) ? p.costCents : 0, priceStored: pp, price: pp, frame: p.framePriceCents > 0 ? p.framePriceCents : null, metres: p.fabricMetres > 0 ? p.fabricMetres : null });
    for (const v of vs) out.push({ coll: 'variants', id: v.id, p, v, label: p.name + ' · ' + (v.name || ''), stored: Number.isInteger(v.costCents) ? v.costCents : null, now: Number.isInteger(v.costCents) ? v.costCents : (Number.isInteger(p.costCents) ? p.costCents : 0),
      priceStored: Number.isInteger(v.priceCents) ? v.priceCents : null, price: Number.isInteger(v.priceCents) ? v.priceCents : pp, frame: v.framePriceCents > 0 ? v.framePriceCents : null, metres: v.fabricMetres > 0 ? v.fabricMetres : null });
  }
  return out;
}

// the costs sheet: one row per product without variants, one per variant
export function sheetCsv(d, eid) {
  const rows = [SHEET_HEAD];
  const items = itemsOf(d, eid).filter(it => it.v || !d.variants.some(v => v.productId === it.p.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const it of items) {
    rows.push([it.p.name, it.v ? it.v.name || '' : '', (it.v ? it.v.sku : it.p.sku) || '', ((it.v ? it.v.barcodes : it.p.barcodes) || [])[0] || '', randsOf(it.price), randsOf(it.now), it.frame ? randsOf(it.frame) : '', it.metres ? String(it.metres) : '', supName(d, it.p)]);
  }
  return { text: toCsv(rows), count: rows.length - 1 };
}

// which column holds what, by its heading
function columnsOf(head) {
  const h = head.map(norm);
  const find = (names) => h.findIndex(x => names.includes(x));
  let cost = find(['newcost', 'cost', 'costperitem', 'costprice', 'unitcost', 'costr', 'costexclvat', 'costinclvat', 'costexvat', 'costincvat']);
  if (cost < 0) cost = h.findIndex(x => x.includes('cost') && !/current|old|total|avg|average/.test(x));
  const opts = [1, 2, 3].map(i => ({ name: find(['option' + i + 'name']), value: find(['option' + i + 'value']) }));
  // the selling price, only under a heading that says so (never "Supplier price" or "RSK price excl. VAT")
  const price = find(['price', 'newprice', 'sellingprice', 'priceincl', 'priceinclvat', 'variantprice', 'retailprice']);
  // the shops' own price lists: the couch without fabric, and the metres the maker needs
  const frame = find(['frameprice', 'frame', 'framepriceincl', 'framepriceinclvat', 'framer', 'framepricer']);
  const metres = find(['fabricmetres', 'fabricmeters', 'metres', 'meters', 'meter', 'metre', 'meterfabric', 'metrefabric', 'fabricneeded', 'fabricneededmetres', 'fabricm', 'metresneeded']);
  return {
    cost, price, frame, metres, supplier: find(['supplier', 'suppliername', 'vendor', 'suppliedby']), sku: find(['sku', 'variantsku', 'code', 'itemcode', 'productcode', 'stockcode']), barcode: find(['barcode', 'variantbarcode', 'barcodes', 'ean', 'upc']),
    handle: find(['handle']), name: find(['product', 'productname', 'name', 'title', 'item', 'description']), variant: find(['variant', 'variantname']), opts
  };
}

// the file against the company's items: what would change, what is the same, what was not found
export function planCosts(text, d, eid) {
  const rows = parseCsv(text, sepOf(text));
  if (rows.length < 2) throw new Error('The file has no rows under its heading.');
  const col = columnsOf(rows[0]);
  if (col.cost < 0 && col.price < 0 && col.frame < 0 && col.metres < 0 && col.supplier < 0) throw new Error('No cost column: the heading needs a column called Cost (or Cost per item, Cost price), Price, Frame price, Fabric metres or Supplier.');
  if (col.sku < 0 && col.barcode < 0 && col.handle < 0 && col.name < 0) throw new Error('Nothing to find the products by: the file needs a SKU, Barcode, Handle or Product column.');
  const items = itemsOf(d, eid);
  const index = (keyOf) => { const m = new Map(); for (const it of items) for (const k of keyOf(it)) if (k) { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(it)) m.get(k).push(it); } return m; };
  const withVariants = new Set(d.variants.map(v => v.productId));
  // a product with variants is costed per variant by SKU and barcode; its own SKU and barcode (if any) name the product
  const bySku = index(it => [skuKey(it.v ? it.v.sku : it.p.sku)]);
  const byCode = index(it => ((it.v ? it.v.barcodes : it.p.barcodes) || []).map(low));
  // names compared on letters and digits only: "UVB &UVA" and "UVB & UVA" are the same
  const byName = index(it => [it.v ? norm(it.p.name) + '|' + norm(it.v.name) : norm(it.p.name)]);
  const byModel = index(it => codesIn(it.v ? it.v.name : it.p.name));
  const byHandle = index(it => [low(it.p.shopifyHandle || handleOf(it.p.name)) + '|' + (it.v ? vkey(it.v.optionValues) : '')]);
  const cell = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');
  const changes = new Map(), prices = new Map(), frames = new Map(), suppliers = new Map(), newSuppliers = new Map(), same = [], missing = [], bad = [];
  const sups = supsOf(d, eid);
  const supByName = new Map(sups.map(sp => [norm(sp.name), sp]));
  let blank = 0, lastName = '', lastHandle = '';
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    // a Shopify CSV names the product on its first row only
    const name = cell(r, col.name) || (col.handle >= 0 && cell(r, col.handle) === lastHandle ? lastName : '');
    if (cell(r, col.name)) lastName = cell(r, col.name);
    if (col.handle >= 0) lastHandle = cell(r, col.handle);
    let cents = costCentsOf(cell(r, col.cost)), price = costCentsOf(cell(r, col.price));
    const what = [cell(r, col.sku), cell(r, col.barcode), name, cell(r, col.variant)].filter(Boolean).join(' · ') || 'line ' + line;
    if (Number.isNaN(cents) || cents < 0) { bad.push({ line, what, cost: cell(r, col.cost) }); cents = null; }
    if (Number.isNaN(price) || price < 0) { bad.push({ line, what, cost: cell(r, col.price) }); price = null; }
    if (price === 0) price = null;                    // a price of nothing is left alone
    let frame = costCentsOf(cell(r, col.frame)), metres = metresOf(cell(r, col.metres));
    if (Number.isNaN(frame) || frame < 0) { bad.push({ line, what, cost: cell(r, col.frame) }); frame = null; }
    if (Number.isNaN(metres)) { bad.push({ line, what, cost: cell(r, col.metres) }); metres = null; }
    if (frame === 0) frame = null; if (metres === 0) metres = null;
    if (costCentsOf(cell(r, col.cost)) === null) blank++;
    const supplier = cell(r, col.supplier);
    if (cents === null && price === null && frame === null && metres === null && !supplier) return;
    const opts = {}; col.opts.forEach(o => { const k = cell(r, o.name), v = cell(r, o.value); if (v && v !== 'Default Title') opts[k || 'Option'] = v; });
    const tries = [
      bySku.get(skuKey(cell(r, col.sku))), byCode.get(low(cell(r, col.barcode))),
      col.handle >= 0 ? byHandle.get(low(cell(r, col.handle)) + '|' + vkey(opts)) : null,
      col.handle >= 0 && !Object.keys(opts).length ? byHandle.get(low(cell(r, col.handle)) + '|') : null,
      name ? byName.get(norm(name) + (cell(r, col.variant) ? '|' + norm(cell(r, col.variant)) : '')) : null,
      // last: the row's SKU, or a code in its name, found in exactly one of our product names
      ...[norm(cell(r, col.sku)), ...codesIn(name)].filter(c => c.length >= 3).map(c => byModel.get(c))
    ];
    // the first key that points at exactly one item
    const hit = tries.find(t => t && t.length === 1);
    if (!hit) { missing.push({ line, what, many: tries.some(t => t && t.length > 1) }); return; }
    const it = hit[0];
    // the supplier is the product's: by name, 'none' clears it, a new name is made under Buying → Suppliers when ticked
    if (supplier) {
      const clear = /^(none|-|no supplier)$/i.test(supplier);
      const found = clear ? null : supByName.get(norm(supplier));
      const toId = clear ? '' : found ? found.id : null;
      if (toId !== (it.p.supplierId || '')) {
        if (toId === null && !newSuppliers.has(norm(supplier))) newSuppliers.set(norm(supplier), supplier);
        suppliers.set(it.p.id, { p: it.p, from: supName(d, it.p), to: clear ? '' : found ? found.name : newSuppliers.get(norm(supplier)), supplierId: toId, key: clear ? '' : norm(supplier) });
      }
    }
    if (price !== null) { if (price === it.price) prices.delete(it.id); else prices.set(it.id, { it, to: price }); }
    if ((frame !== null && frame !== it.frame) || (metres !== null && metres !== it.metres)) frames.set(it.id, { it, frame: frame !== null && frame !== it.frame ? frame : null, metres: metres !== null && metres !== it.metres ? metres : null });
    if (cents === null) return;
    if (cents === it.now) { changes.delete(it.id); same.push(it); return; }
    changes.set(it.id, { it, to: cents });
  });
  // a product with variants whose own cost is still nothing takes its variants' lowest, so the list shows a cost
  for (const p of d.products.filter(x => x.entityId === eid && withVariants.has(x.id) && !(x.costCents > 0) && !changes.has(x.id))) {
    const vc = [...changes.values()].filter(c => c.it.v && c.it.p.id === p.id).map(c => c.to);
    if (vc.length) changes.set(p.id, { it: items.find(i => i.id === p.id && !i.v), to: Math.min(...vc), fromVariants: true });
  }
  return { changes: [...changes.values()], prices: [...prices.values()], frames: [...frames.values()], suppliers: [...suppliers.values()], newSuppliers: [...newSuppliers.values()], same: same.length, blank, missing, bad, rows: rows.length - 1 };
}

// one write per record: its new cost, and its new price when prices are wanted
async function applyCosts(plan, eid, withPrices, withFrames, withSuppliers) {
  const by = new Map();
  // the suppliers first: the new ones made, then each product pointed at its supplier
  const sups = withSuppliers ? (plan.suppliers || []) : [];
  const made = new Map();
  for (const name of (withSuppliers ? plan.newSuppliers || [] : [])) {
    const id = newId('suppliers');
    await setOne('suppliers', id, { name, contact: '', phone: '', email: '', accountNo: '', termsDays: 0, leadDays: 0, notes: 'Made by the costs import', archived: false, ...auth.stamp(eid, '') });
    made.set(norm(name), id);
  }
  const supId = (c) => c.supplierId !== null ? c.supplierId : made.get(c.key) || '';
  const put = (it, patch) => { const o = by.get(it.id) || { op: 'update', coll: it.coll, id: it.id, data: { ...auth.touch() } }; Object.assign(o.data, patch); by.set(it.id, o); };
  plan.changes.forEach(c => put(c.it, { costCents: c.to }));
  const prices = withPrices ? plan.prices : [];
  prices.forEach(c => put(c.it, { priceCents: c.to }));
  // frame price (whole cents) and fabric metres (2 decimals); an old float price or cost on the record is made whole so the rules take the write
  const frames = withFrames ? (plan.frames || []) : [];
  const whole = (it) => { const rec = it.v || it.p, out = {}; for (const k of ['priceCents', 'costCents']) { const x = rec[k]; if (x != null && !Number.isInteger(x)) out[k] = Math.round(Number(x) || 0); else if (!it.v && x == null) out[k] = 0; } return out; };
  frames.forEach(c => put(c.it, { ...whole(c.it), ...(c.frame !== null ? { framePriceCents: c.frame } : {}), ...(c.metres !== null ? { fabricMetres: c.metres } : {}) }));
  sups.forEach(c => put({ id: c.p.id, coll: 'products' }, { supplierId: supId(c) }));
  const ops = [...by.values()];
  let done = 0;
  for (let i = 0; i < ops.length; i += 100) { await batch(ops.slice(i, i + 100)); done = Math.min(ops.length, i + 100); }
  try {
    await setOne('auditLog', newId('auditLog'), { action: 'product.costImport', docType: 'product', docId: '', docNo: '', actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '',
      details: { changed: plan.changes.length, changes: plan.changes.slice(0, 300).map(c => ({ id: c.it.id, coll: c.it.coll, name: c.it.label, fromCents: c.it.stored, toCents: c.to })),
        pricesChanged: prices.length, prices: prices.slice(0, 300).map(c => ({ id: c.it.id, coll: c.it.coll, name: c.it.label, fromCents: c.it.priceStored, toCents: c.to })),
        framesChanged: frames.length, frames: frames.slice(0, 300).map(c => ({ id: c.it.id, coll: c.it.coll, name: c.it.label, fromFrameCents: c.it.frame, toFrameCents: c.frame, fromMetres: c.it.metres, toMetres: c.metres })),
        suppliersChanged: sups.length, suppliersCreated: [...made.keys()].length, suppliers: sups.slice(0, 300).map(c => ({ id: c.p.id, name: c.p.name, from: c.from, to: c.to, supplierId: supId(c) })) }, ...auth.stamp(eid, '') });
  } catch (e) { console.error('audit failed', e); }
  return { costs: plan.changes.length, prices: prices.length, frames: frames.length, suppliers: sups.length, created: made.size, records: done };
}

// the Import costs window: the sheet to fill in, then the file, a preview and Save
export function openCostImport(d, eid) {
  const ent = d.entities.find(e => e.id === eid) || {};
  const vat = ent.vatRegistered ? 'excluding VAT (you claim the VAT back)' : 'what you pay, VAT included (' + esc(ent.tradingName || ent.legalName || eid) + ' is not VAT registered)';
  let plan = null, busy = false;
  const m = openModal('Import costs and prices · ' + (ent.tradingName || ent.legalName || eid), `
    <p>The cost changes, and the selling price too if the file has a Price column and you tick it. A <strong>Frame price</strong> and <strong>Fabric metres</strong> column (the shops’ price lists) set the couch’s frame price and the metres it needs, under their own tick. A <strong>Supplier</strong> column sets each product’s supplier by name (a new name is added under Buying → Suppliers), under its own tick. Names, barcodes and pictures stay as they are. Costs are in rands, ${vat}.</p>
    <ol class="ci-steps"><li><button type="button" class="btn ghost" data-ci="sheet">Download the costs sheet</button> <span class="muted">every product and variant with its SKU, barcode, price, cost and supplier now</span></li>
      <li>Fill in the <strong>Cost</strong> column (and change the <strong>Price</strong> where you want) in Excel or Google Sheets. Leave a cost blank to keep it as it is. Save as CSV.</li>
      <li><label class="btn ghost">Choose the file<input type="file" id="ci-file" accept=".csv,text/csv,.txt" hidden></label> <span class="muted">a supplier’s list or the Shopify product CSV works too, if it has a Cost column and a SKU, barcode or product name</span></li></ol>
    <div id="ci-plan"></div>`, {
    okLabel: 'Save the costs', onOk: async () => {
      const withPrices = !!(m.wrap.querySelector('#ci-prices') || {}).checked, withFrames = !!(m.wrap.querySelector('#ci-frames') || {}).checked, withSuppliers = !!(m.wrap.querySelector('#ci-suppliers') || {}).checked;
      if (!plan || (!plan.changes.length && !(withPrices && plan.prices.length) && !(withFrames && plan.frames.length) && !(withSuppliers && (plan.suppliers || []).length))) { toast(plan ? (plan.prices.length ? 'Tick “Also change these prices” to save the prices' : plan.frames.length ? 'Tick “Also set these frame prices and fabric metres” to save them' : (plan.suppliers || []).length ? 'Tick “Also set these suppliers” to save them' : 'Nothing to change') : 'Choose the file first', 'warn'); return false; }
      if (busy) return false; busy = true;
      const ok = m.wrap.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Saving…';
      try { const n = await applyCosts(plan, eid, withPrices, withFrames, withSuppliers); toast([n.costs ? n.costs + ' cost' + (n.costs === 1 ? '' : 's') : '', n.prices ? n.prices + ' price' + (n.prices === 1 ? '' : 's') : '', n.frames ? n.frames + ' frame price' + (n.frames === 1 ? '' : 's') + ' / fabric metres' : '', n.suppliers ? n.suppliers + ' supplier' + (n.suppliers === 1 ? '' : 's') + (n.created ? ' (' + n.created + ' new)' : '') : ''].filter(Boolean).join(' and ') + ' saved'); return true; }
      catch (e) { toast('Saving stopped: ' + e.message + '. Nothing after that was changed; try again.', 'warn'); busy = false; ok.disabled = false; ok.textContent = 'Save the costs'; return false; }
    }
  });
  m.wrap.querySelector('[data-ci=sheet]').addEventListener('click', () => {
    const s = sheetCsv(d, eid);
    download(s.text, 'costs-' + eid + '-' + new Date().toISOString().slice(0, 10) + '.csv');
    toast(s.count + ' rows in the costs sheet');
  });
  m.wrap.querySelector('#ci-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const el = m.wrap.querySelector('#ci-plan');
      try { plan = planCosts(r.result, d, eid); } catch (err) { plan = null; el.innerHTML = `<p class="warn">${esc(err.message)}</p>`; return; }
      const c = plan.changes, pr = plan.prices, fr = plan.frames || [], su = plan.suppliers || [], nu = plan.newSuppliers || [];
      const frTxt = (x) => [x.frame !== null ? 'frame ' + money(x.it.frame || 0) + ' → ' + money(x.frame) : '', x.metres !== null ? (x.it.metres || 0) + ' m → ' + x.metres + ' m' : ''].filter(Boolean).join(' · ');
      el.innerHTML = `<div class="ci-sum"><strong>${c.length} cost${c.length === 1 ? '' : 's'} to change</strong> · ${plan.same} the same · ${plan.blank} left blank${plan.missing.length ? ` · <span class="warn">${plan.missing.length} not found</span>` : ''}${plan.bad.length ? ` · <span class="warn">${plan.bad.length} not a number</span>` : ''}</div>
        ${c.length ? `<div class="pk-list">${c.slice(0, 60).map(x => `<div class="pk-row"><strong>${esc(x.it.label)}</strong><span>${esc(money(x.it.now))} → <strong>${esc(money(x.to))}</strong>${x.fromVariants ? ' <span class="muted">(from its variants)</span>' : ''}</span></div>`).join('')}${c.length > 60 ? `<div class="pk-row muted">… and ${c.length - 60} more</div>` : ''}</div>` : ''}
        ${pr.length ? `<div class="ci-prices"><label class="chk"><input type="checkbox" id="ci-prices"> <strong>Also change these ${pr.length} price${pr.length === 1 ? '' : 's'}</strong></label> <span class="muted">the selling price in the file differs from the POS; left as they are unless ticked</span>
          <div class="pk-list">${pr.slice(0, 60).map(x => `<div class="pk-row"><strong>${esc(x.it.label)}</strong><span>${esc(money(x.it.price))} → <strong>${esc(money(x.to))}</strong></span></div>`).join('')}${pr.length > 60 ? `<div class="pk-row muted">… and ${pr.length - 60} more</div>` : ''}</div></div>` : ''}
        ${fr.length ? `<div class="ci-prices"><label class="chk"><input type="checkbox" id="ci-frames"> <strong>Also set these ${fr.length} frame price${fr.length === 1 ? '' : 's'} and fabric metres</strong></label> <span class="muted">the couch without fabric, and the metres the maker needs; the till prices frame + metres × the chosen fabric</span>
          <div class="pk-list">${fr.slice(0, 60).map(x => `<div class="pk-row"><strong>${esc(x.it.label)}</strong><span>${esc(frTxt(x))}</span></div>`).join('')}${fr.length > 60 ? `<div class="pk-row muted">… and ${fr.length - 60} more</div>` : ''}</div></div>` : ''}
        ${su.length ? `<div class="ci-prices"><label class="chk"><input type="checkbox" id="ci-suppliers"> <strong>Also set these ${su.length} supplier${su.length === 1 ? '' : 's'}</strong></label> <span class="muted">${nu.length ? `${nu.length} new supplier${nu.length === 1 ? '' : 's'} will be added under Buying → Suppliers: ${esc(nu.join(', '))}` : 'all suppliers already under Buying → Suppliers'}</span>
          <div class="pk-list">${su.slice(0, 60).map(x => `<div class="pk-row"><strong>${esc(x.p.name)}</strong><span>${esc(x.from || 'none')} → <strong>${esc(x.to || 'none')}</strong></span></div>`).join('')}${su.length > 60 ? `<div class="pk-row muted">… and ${su.length - 60} more</div>` : ''}</div></div>` : ''}
        ${plan.missing.length ? `<details class="ci-miss"><summary>Not found (left alone)</summary>${plan.missing.slice(0, 50).map(x => `<div class="muted">Line ${x.line}: ${esc(x.what)}${x.many ? ' (more than one product matches)' : ''}</div>`).join('')}${plan.missing.length > 50 ? `<div class="muted">… and ${plan.missing.length - 50} more</div>` : ''}</details>` : ''}
        ${plan.bad.length ? `<details class="ci-miss"><summary>Cost or price not a number (left alone)</summary>${plan.bad.slice(0, 30).map(x => `<div class="muted">Line ${x.line}: ${esc(x.what)}: “${esc(x.cost)}”</div>`).join('')}</details>` : ''}`;
    };
    r.readAsText(f);
    e.target.value = '';
  });
}
