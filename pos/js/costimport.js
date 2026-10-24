// Retail POS — cost prices from a spreadsheet, and nothing else.
//
// A manager downloads the costs sheet (every product and variant of the
// company with its SKU, barcode, price and cost), fills in the Cost column,
// and brings it back. A supplier's own price list or the Shopify product CSV
// works too: any CSV with a cost column and a SKU, barcode, handle or name
// to find the item by. Names are compared on letters and digits only, and a
// supplier's model code (UVL601) is found inside our own product names.
//
// It changes only costCents on products and variants that are already here
// (and updatedBy/updatedAt). It never creates or deletes anything, and never
// touches a price, name, barcode, picture or VAT class. One audit row records
// the changes. Writes go in batches of 100.
import { batch, setOne, newId } from './db.js';
import * as auth from './auth.js';
import { esc, toast, openModal, money } from './ui.js';
import { parseCsv, sepOf, toCsv, download } from './csv.js';
import { randsOf } from './money.js';

const low = (s) => String(s == null ? '' : s).trim().toLowerCase();
const norm = (h) => low(h).replace(/[^a-z0-9]/g, '');
const handleOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const skuKey = (s) => low(s).replace(/^'+/, '');           // Excel and Shopify sometimes keep a leading apostrophe
// a supplier's model code in a name (UVL601, LF-T508T, TH32): letters and digits, starting with a letter, 3 or more long
const codesIn = (name) => (String(name || '').match(/[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*/g) || []).map(norm).filter(c => c.length >= 3);
const vkey = (vals) => Object.keys(vals || {}).sort().map(k => low(k) + '=' + low(vals[k])).join('|');
const SHEET_HEAD = ['Product', 'Variant', 'SKU', 'Barcode', 'Price', 'Cost'];

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
function itemsOf(d, eid) {
  const out = [];
  for (const p of d.products.filter(x => x.entityId === eid)) {
    const vs = d.variants.filter(v => v.productId === p.id);
    out.push({ coll: 'products', id: p.id, p, v: null, label: p.name, stored: Number.isInteger(p.costCents) ? p.costCents : 0, now: Number.isInteger(p.costCents) ? p.costCents : 0 });
    for (const v of vs) out.push({ coll: 'variants', id: v.id, p, v, label: p.name + ' · ' + (v.name || ''), stored: Number.isInteger(v.costCents) ? v.costCents : null, now: Number.isInteger(v.costCents) ? v.costCents : (Number.isInteger(p.costCents) ? p.costCents : 0) });
  }
  return out;
}

// the costs sheet: one row per product without variants, one per variant
export function sheetCsv(d, eid) {
  const rows = [SHEET_HEAD];
  const items = itemsOf(d, eid).filter(it => it.v || !d.variants.some(v => v.productId === it.p.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const it of items) {
    const price = it.v && Number.isInteger(it.v.priceCents) ? it.v.priceCents : it.p.priceCents;
    rows.push([it.p.name, it.v ? it.v.name || '' : '', (it.v ? it.v.sku : it.p.sku) || '', ((it.v ? it.v.barcodes : it.p.barcodes) || [])[0] || '', randsOf(price), randsOf(it.now)]);
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
  return {
    cost, sku: find(['sku', 'variantsku', 'code', 'itemcode', 'productcode', 'stockcode']), barcode: find(['barcode', 'variantbarcode', 'barcodes', 'ean', 'upc']),
    handle: find(['handle']), name: find(['product', 'productname', 'name', 'title', 'item', 'description']), variant: find(['variant', 'variantname']), opts
  };
}

// the file against the company's items: what would change, what is the same, what was not found
export function planCosts(text, d, eid) {
  const rows = parseCsv(text, sepOf(text));
  if (rows.length < 2) throw new Error('The file has no rows under its heading.');
  const col = columnsOf(rows[0]);
  if (col.cost < 0) throw new Error('No cost column: the heading needs a column called Cost (or Cost per item, Cost price).');
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
  const changes = new Map(), same = [], missing = [], bad = [];
  let blank = 0, lastName = '', lastHandle = '';
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    // a Shopify CSV names the product on its first row only
    const name = cell(r, col.name) || (col.handle >= 0 && cell(r, col.handle) === lastHandle ? lastName : '');
    if (cell(r, col.name)) lastName = cell(r, col.name);
    if (col.handle >= 0) lastHandle = cell(r, col.handle);
    const cents = costCentsOf(cell(r, col.cost));
    const what = [cell(r, col.sku), cell(r, col.barcode), name, cell(r, col.variant)].filter(Boolean).join(' · ') || 'line ' + line;
    if (cents === null) { blank++; return; }
    if (Number.isNaN(cents) || cents < 0) { bad.push({ line, what, cost: cell(r, col.cost) }); return; }
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
    if (cents === it.now) { changes.delete(it.id); same.push(it); return; }
    changes.set(it.id, { it, to: cents });
  });
  // a product with variants whose own cost is still nothing takes its variants' lowest, so the list shows a cost
  for (const p of d.products.filter(x => x.entityId === eid && withVariants.has(x.id) && !(x.costCents > 0) && !changes.has(x.id))) {
    const vc = [...changes.values()].filter(c => c.it.v && c.it.p.id === p.id).map(c => c.to);
    if (vc.length) changes.set(p.id, { it: items.find(i => i.id === p.id && !i.v), to: Math.min(...vc), fromVariants: true });
  }
  return { changes: [...changes.values()], same: same.length, blank, missing, bad, rows: rows.length - 1 };
}

async function applyCosts(plan, eid) {
  const ops = plan.changes.map(c => ({ op: 'update', coll: c.it.coll, id: c.it.id, data: { costCents: c.to, ...auth.touch() } }));
  let done = 0;
  for (let i = 0; i < ops.length; i += 100) { await batch(ops.slice(i, i + 100)); done = Math.min(ops.length, i + 100); }
  try {
    await setOne('auditLog', newId('auditLog'), { action: 'product.costImport', docType: 'product', docId: '', docNo: '', actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '',
      details: { changed: ops.length, changes: plan.changes.slice(0, 300).map(c => ({ id: c.it.id, coll: c.it.coll, name: c.it.label, fromCents: c.it.stored, toCents: c.to })) }, ...auth.stamp(eid, '') });
  } catch (e) { console.error('audit failed', e); }
  return done;
}

// the Import costs window: the sheet to fill in, then the file, a preview and Save
export function openCostImport(d, eid) {
  const ent = d.entities.find(e => e.id === eid) || {};
  const vat = ent.vatRegistered ? 'excluding VAT (you claim the VAT back)' : 'what you pay, VAT included (' + esc(ent.tradingName || ent.legalName || eid) + ' is not VAT registered)';
  let plan = null, busy = false;
  const m = openModal('Import cost prices · ' + (ent.tradingName || ent.legalName || eid), `
    <p>Only the cost changes: prices, names, barcodes and pictures stay as they are. Costs are in rands, ${vat}.</p>
    <ol class="ci-steps"><li><button type="button" class="btn ghost" data-ci="sheet">Download the costs sheet</button> <span class="muted">every product and variant with its SKU, barcode, price and cost now</span></li>
      <li>Fill in the <strong>Cost</strong> column in Excel or Google Sheets. Leave a cost blank to keep it as it is. Save as CSV.</li>
      <li><label class="btn ghost">Choose the file<input type="file" id="ci-file" accept=".csv,text/csv,.txt" hidden></label> <span class="muted">a supplier’s list or the Shopify product CSV works too, if it has a Cost column and a SKU, barcode or product name</span></li></ol>
    <div id="ci-plan"></div>`, {
    okLabel: 'Save the costs', onOk: async () => {
      if (!plan || !plan.changes.length) { toast(plan ? 'Nothing to change' : 'Choose the file first', 'warn'); return false; }
      if (busy) return false; busy = true;
      const ok = m.wrap.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Saving…';
      try { const n = await applyCosts(plan, eid); toast(n + ' cost' + (n === 1 ? '' : 's') + ' saved'); return true; }
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
      const c = plan.changes;
      el.innerHTML = `<div class="ci-sum"><strong>${c.length} cost${c.length === 1 ? '' : 's'} to change</strong> · ${plan.same} the same · ${plan.blank} left blank${plan.missing.length ? ` · <span class="warn">${plan.missing.length} not found</span>` : ''}${plan.bad.length ? ` · <span class="warn">${plan.bad.length} not a number</span>` : ''}</div>
        ${c.length ? `<div class="pk-list">${c.slice(0, 60).map(x => `<div class="pk-row"><strong>${esc(x.it.label)}</strong><span>${esc(money(x.it.now))} → <strong>${esc(money(x.to))}</strong>${x.fromVariants ? ' <span class="muted">(from its variants)</span>' : ''}</span></div>`).join('')}${c.length > 60 ? `<div class="pk-row muted">… and ${c.length - 60} more</div>` : ''}</div>` : ''}
        ${plan.missing.length ? `<details class="ci-miss"><summary>Not found (left alone)</summary>${plan.missing.slice(0, 50).map(x => `<div class="muted">Line ${x.line}: ${esc(x.what)}${x.many ? ' (more than one product matches)' : ''}</div>`).join('')}${plan.missing.length > 50 ? `<div class="muted">… and ${plan.missing.length - 50} more</div>` : ''}</details>` : ''}
        ${plan.bad.length ? `<details class="ci-miss"><summary>Cost not a number (left alone)</summary>${plan.bad.slice(0, 30).map(x => `<div class="muted">Line ${x.line}: ${esc(x.what)}: “${esc(x.cost)}”</div>`).join('')}</details>` : ''}`;
    };
    r.readAsText(f);
    e.target.value = '';
  });
}
