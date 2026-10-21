// The supplier sheet: an Excel workbook to fill in and bring back.
//   Read me       how to fill it in
//   Suppliers     one row per supplier: name, contact person, WhatsApp, email,
//                 office phone, account no., notes
//   What I buy    one row per item per supplier: the supplier and the item are
//                 drop-downs (the item list is the stock list), the price,
//                 their code, and whether they are the main supplier
//   Stock list    everything in stock on the system (materials, and the online
//                 shop's products when it is connected): the drop-down's list
// Importing it: suppliers are added or brought up to date (blank cells leave
// what is there), and each item gets the suppliers it is bought from with
// their prices (buyFrom); the main one becomes the item's supplier and, if
// asked, its price the item's cost.
import * as store from './store.js';
import { allMaterials } from './costing.js';
import * as till from './till.js';
import { shopProduct } from './shopstock.js';
import { allSuppliers, supplierByName, mayEditSuppliers } from './suppliers.js';
import { toXlsxBook, download } from './exporter.js';
import { readFile, toNumber } from './importer.js';
import { esc, money, openModal, toast, today } from './ui.js';

let settings = {};
export const setSupplierSheetSettings = (cfg) => { settings = cfg || {}; };
const key = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
const vatNote = () => settings.vatRegistered ? 'excl. VAT' : '';

// Everything that can be bought: materials, then the shop's products.
function stockItems() {
  const out = allMaterials().filter(m => m.name).map(m => ({ kind: 'material', id: m.id, name: String(m.name).trim(), unit: m.unit || '', price: m.cost, supplier: m.supplier || '', buyFrom: m.buyFrom || [] }));
  const seen = new Set(out.map(x => key(x.name)));
  if (till.shopOn()) till.shopItems().forEach(i => {
    if (seen.has(key(i.name))) return; seen.add(key(i.name));
    const sp = shopProduct(i.variantId) || {};
    out.push({ kind: 'shop', id: i.variantId, name: String(i.name).trim(), unit: 'each', price: sp.cost, supplier: sp.supplier || i.vendor || '', buyFrom: sp.buyFrom || [], sku: i.sku || '', barcode: i.barcode || '' });
  });
  return out;
}

export function downloadSupplierSheet() {
  const items = stockItems();
  const known = allSuppliers();
  // every supplier: the list, plus names on the items not on the list yet
  const names = new Map();
  known.forEach(s => names.set(key(s.name), s));
  items.forEach(it => { [it.supplier, ...it.buyFrom.map(b => b.supplier)].filter(Boolean).forEach(n => { if (!names.has(key(n))) names.set(key(n), { name: String(n).trim() }); }); });
  const sups = [...names.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const supRows = [['Supplier', 'Contact person', 'WhatsApp', 'Email', 'Office phone', 'Account no.', 'Notes']]
    .concat(sups.map(s => [s.name || '', s.contact || '', s.phone || '', s.email || '', s.officePhone || '', s.account || '', s.notes || '']));
  // what is bought from whom, as it stands
  const buyRows = [['Supplier', 'Item', 'Unit', 'Price' + (vatNote() ? ' (' + vatNote() + ')' : ''), 'Their item code', 'Main supplier', 'Notes']];
  items.forEach(it => {
    if (it.buyFrom.length) it.buyFrom.forEach(b => buyRows.push([b.supplier || '', it.name, '', b.price == null || b.price === '' ? '' : Number(b.price), b.code || '', b.main || key(b.supplier) === key(it.supplier) ? 'Yes' : 'No', b.notes || '']));
    else if (it.supplier) buyRows.push([it.supplier, it.name, '', it.price == null || it.price === '' ? '' : Number(it.price), '', 'Yes', '']);
  });
  const stockRows = [['Item', 'Unit', 'Type', 'Current price' + (vatNote() ? ' (' + vatNote() + ')' : ''), 'Current supplier']]
    .concat(items.map(it => [it.name, it.unit, it.kind === 'shop' ? 'Shop product' : 'Material', it.price == null || it.price === '' ? '' : Number(it.price), it.supplier]));
  const supLast = Math.max(supRows.length + 300, 400), stockLast = stockRows.length;
  const buyLast = Math.max(buyRows.length + 500, 800);
  // the unit follows the item chosen
  for (let r = 2; r <= buyLast; r++) {
    const row = buyRows[r - 1] || (buyRows[r - 1] = ['', '', '', '', '', '', '']);
    row[2] = { f: `IF(B${r}="","",IFERROR(VLOOKUP(B${r},'Stock list'!$A$2:$B$${stockLast},2,FALSE),""))` };
  }
  const readMe = [
    ['SUPPLIER SHEET — ' + (settings.name || '')],
    [''],
    ['1. Suppliers: one row per supplier. Fill in the contact person, WhatsApp number, email and account number.'],
    ['   Add new suppliers at the bottom. Leave a cell blank to keep what is on the system.'],
    ['2. What I buy: one row for every item you buy from a supplier.'],
    ['   Choose the supplier and the item from the drop-downs (the item list is your stock list), then type the price' + (vatNote() ? ' ' + vatNote() : '') + '.'],
    ['   The same item can be bought from more than one supplier: one row each. Mark the one you usually use as Main supplier = Yes.'],
    ['3. Stock list: everything in stock on the system. It is the list behind the item drop-down; do not change it.'],
    ['4. Save the file, then in Factory Manager: Buying → Stock → Suppliers → Import supplier sheet.'],
    [''],
    ['Made ' + today() + '. ' + items.length + ' stock items, ' + sups.length + ' suppliers.']
  ];
  const blob = toXlsxBook([
    { name: 'Read me', rows: readMe, head: false, widths: [110] },
    { name: 'Suppliers', rows: supRows, widths: [30, 22, 18, 30, 18, 16, 36] },
    { name: 'What I buy', rows: buyRows, widths: [30, 40, 10, 16, 16, 14, 30], lists: [
      { range: `A2:A${buyLast}`, source: `'Suppliers'!$A$2:$A$${supLast}`, prompt: 'Pick the supplier (add new ones on the Suppliers sheet)' },
      { range: `B2:B${buyLast}`, source: `'Stock list'!$A$2:$A$${stockLast}`, strict: true, prompt: 'Pick the item from your stock list' },
      { range: `F2:F${buyLast}`, values: ['Yes', 'No'] }
    ] },
    { name: 'Stock list', rows: stockRows, widths: [44, 10, 14, 18, 30] }
  ]);
  download(blob, 'Supplier sheet ' + (settings.name ? settings.name + ' ' : '') + today() + '.xlsx');
  toast('Supplier sheet downloaded: ' + sups.length + ' suppliers, ' + items.length + ' stock items');
}

// ---------------------------------------------------------------- import --
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SUP_COLS = { name: ['supplier', 'supplier name', 'name', 'company'], contact: ['contact person', 'contact', 'rep', 'person'], phone: ['whatsapp', 'whatsapp number', 'cell', 'mobile', 'cell number'],
  email: ['email', 'e mail', 'email address'], officePhone: ['office phone', 'phone', 'tel', 'telephone', 'landline'], account: ['account no', 'account', 'account number', 'acc no'], notes: ['notes', 'note', 'comments'] };
const BUY_COLS = { supplier: ['supplier', 'supplier name', 'bought from', 'vendor'], item: ['item', 'material', 'product', 'stock item', 'description'], price: ['price', 'cost', 'unit price', 'cost price'],
  code: ['their item code', 'item code', 'code', 'supplier code', 'their code'], main: ['main supplier', 'main', 'preferred', 'default'], notes: ['notes', 'note', 'comments'] };
function mapCols(head, spec) {
  const h = head.map(x => norm(x).replace(/ (excl|incl) vat$/, '').replace(/ r$/, ''));
  const out = {};
  for (const [k, syns] of Object.entries(spec)) { const i = h.findIndex(x => syns.includes(x) || syns.some(s => x.startsWith(s + ' '))); if (i >= 0 && !Object.values(out).includes(i)) out[k] = i; }
  return out;
}
const yes = (v) => /^(y|yes|ja|true|1|x|main)$/i.test(String(v || '').trim());

// What the workbook would change: pure, so it can be checked first.
export function planSupplierSheet(sheets) {
  const byName = (re) => sheets.find(s => re.test(String(s.name || '')));
  let supSheet = byName(/^supplier/i), buySheet = byName(/buy|price/i);
  if (!supSheet) supSheet = sheets.find(s => { const c = mapCols(s.rows[0] || [], SUP_COLS); return c.name != null && (c.phone != null || c.email != null || c.contact != null); });
  if (!buySheet) buySheet = sheets.find(s => s !== supSheet && !/stock list|read me/i.test(s.name) && (() => { const c = mapCols(s.rows[0] || [], BUY_COLS); return c.supplier != null && c.item != null; })());
  if (!supSheet && !buySheet) throw new Error('This file has no Suppliers sheet and no What I buy sheet. Use the supplier sheet downloaded from Factory Manager.');
  const plan = { supAdd: [], supUpdate: [], supSame: 0, items: [], unknown: [], noSupplier: 0, newFromBuys: [] };
  const sheetSups = new Map();
  if (supSheet) {
    const c = mapCols(supSheet.rows[0] || [], SUP_COLS);
    supSheet.rows.slice(1).forEach(r => {
      const name = String(r[c.name] == null ? '' : r[c.name]).trim(); if (!name) return;
      const d = {}; Object.keys(SUP_COLS).forEach(k => { if (c[k] != null) { const v = String(r[c[k]] == null ? '' : r[c[k]]).trim(); if (v) d[k] = v; } });
      d.name = name;
      if (sheetSups.has(key(name))) Object.assign(sheetSups.get(key(name)), d); else sheetSups.set(key(name), d);
    });
    sheetSups.forEach(d => {
      const ex = supplierByName(d.name);
      if (!ex) { plan.supAdd.push(d); return; }
      const patch = {}; Object.keys(d).forEach(k => { if (k !== 'name' && d[k] !== (ex[k] || '')) patch[k] = d[k]; });
      if (Object.keys(patch).length) plan.supUpdate.push({ id: ex.id, name: ex.name, patch }); else plan.supSame++;
    });
  }
  if (buySheet) {
    const c = mapCols(buySheet.rows[0] || [], BUY_COLS);
    const stock = stockItems(); const byKey = new Map(); stock.forEach(it => byKey.set(key(it.name), it));
    const per = new Map();
    buySheet.rows.slice(1).forEach((r, i) => {
      const item = String(r[c.item] == null ? '' : r[c.item]).trim(), sup = String(r[c.supplier] == null ? '' : r[c.supplier]).trim();
      if (!item && !sup) return;
      if (!item) return;
      if (!sup) { plan.noSupplier++; return; }
      const it = byKey.get(key(item));
      if (!it) { plan.unknown.push({ row: i + 2, item, supplier: sup }); return; }
      const price = c.price != null ? toNumber(r[c.price]) : null;
      const line = { supplier: (supplierByName(sup) || sheetSups.get(key(sup)) || { name: sup }).name, price: price == null ? null : Math.round(price * 100) / 100, code: c.code != null ? String(r[c.code] || '').trim() : '', notes: c.notes != null ? String(r[c.notes] || '').trim() : '', main: c.main != null && yes(r[c.main]) };
      if (!supplierByName(sup) && !sheetSups.has(key(sup)) && !plan.newFromBuys.some(n => key(n) === key(sup))) plan.newFromBuys.push(sup);
      const k = it.kind + ':' + it.id;
      if (!per.has(k)) per.set(k, { it, lines: [] });
      const e = per.get(k);
      const same = e.lines.find(l => key(l.supplier) === key(line.supplier));
      if (same) Object.assign(same, line); else e.lines.push(line);
    });
    per.forEach(({ it, lines }) => {
      let main = lines.find(l => l.main) || lines[0];
      lines.forEach(l => { l.main = l === main; });
      plan.items.push({ kind: it.kind, id: it.id, name: it.name, buyFrom: lines, supplier: main.supplier, price: main.price, oldPrice: it.price, oldSupplier: it.supplier });
    });
  }
  return plan;
}

export async function applySupplierSheet(plan, opts) {
  const done = { sup: 0, mat: 0, shop: 0 };
  if (mayEditSuppliers()) {
    for (const d of plan.supAdd) { await store.create('suppliers', { name: d.name, contact: d.contact || '', phone: d.phone || '', email: d.email || '', officePhone: d.officePhone || '', account: d.account || '', notes: d.notes || '' }); done.sup++; }
    for (const u of plan.supUpdate) { await store.update('suppliers', u.id, u.patch); done.sup++; }
    for (const n of plan.newFromBuys) if (!supplierByName(n) && !plan.supAdd.some(d => key(d.name) === key(n))) { await store.create('suppliers', { name: n, contact: '', phone: '', email: '', officePhone: '', account: '', notes: '' }); done.sup++; }
  }
  for (const it of plan.items) {
    const patch = { buyFrom: it.buyFrom.map(l => ({ supplier: l.supplier, price: l.price, code: l.code, notes: l.notes, main: l.main })), supplier: it.supplier };
    if (opts.costs && it.price != null) patch.cost = it.price;
    if (it.kind === 'material') { await store.update('materials', it.id, patch, 'Suppliers and prices from the supplier sheet'); done.mat++; }
    else { if (shopProduct(it.id)) await store.update('shopProducts', it.id, patch); else await store.createWithId('shopProducts', it.id, { ...patch, name: it.name, quickKey: false }); done.shop++; }
  }
  return done;
}

export function importSupplierSheet() {
  if (!mayEditSuppliers() && !store.can('costing', 'edit')) { toast('Your role cannot change suppliers or prices', 'warn'); return; }
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xlsm,.csv';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    let plan;
    try { plan = planSupplierSheet(await readFile(f)); } catch (e) { toast(e.message, 'warn'); return; }
    previewSupplierSheet(plan, f.name);
  });
  inp.click();
}
export function previewSupplierSheet(plan, fileName) {
  const cur = settings.currency || 'R';
  const priced = plan.items.filter(i => i.price != null);
  const changed = priced.filter(i => Number(i.oldPrice) !== Number(i.price));
  const m = openModal('Import supplier sheet', `
    <p class="muted">${esc(fileName || '')}</p>
    <div class="tiles" style="margin:.4rem 0 .8rem">
      <div class="tile"><div class="tile-n">${plan.supAdd.length + plan.newFromBuys.filter(n => !plan.supAdd.some(d => key(d.name) === key(n))).length}</div><div class="tile-l">New suppliers</div></div>
      <div class="tile"><div class="tile-n">${plan.supUpdate.length}</div><div class="tile-l">Suppliers updated</div></div>
      <div class="tile"><div class="tile-n">${plan.items.length}</div><div class="tile-l">Items with suppliers</div></div>
      <div class="tile"><div class="tile-n">${changed.length}</div><div class="tile-l">Prices changing</div></div>
    </div>
    ${changed.length ? `<div class="cat">Prices that change (the main supplier’s price)</div><div class="pk-list" style="max-height:26vh">${changed.slice(0, 80).map(i => `<div class="pk-row" style="cursor:default"><strong>${esc(i.name)}</strong><span>${esc(i.supplier)} · ${i.oldPrice != null && i.oldPrice !== '' ? esc(money(i.oldPrice, cur)) + ' → ' : ''}<b>${esc(money(i.price, cur))}</b></span></div>`).join('')}</div>` : ''}
    ${plan.unknown.length ? `<p class="notice-inline">${plan.unknown.length} row${plan.unknown.length === 1 ? '' : 's'} with an item not in your stock list ${plan.unknown.length === 1 ? 'is' : 'are'} skipped: ${plan.unknown.slice(0, 6).map(u => esc(u.item) + ' (row ' + u.row + ')').join(', ')}${plan.unknown.length > 6 ? '…' : ''}. Add the item to your stock first, or pick it from the drop-down.</p>` : ''}
    ${plan.noSupplier ? `<p class="muted">${plan.noSupplier} row${plan.noSupplier === 1 ? '' : 's'} without a supplier skipped.</p>` : ''}
    <label class="check"><input type="checkbox" id="ssi-costs" checked> Use the main supplier’s price as the item’s cost price${vatNote() ? ' (' + vatNote() + ')' : ''} (product costs follow)</label>`, {
    okLabel: 'Import',
    onOk: async (w) => {
      try {
        const d = await applySupplierSheet(plan, { costs: w.querySelector('#ssi-costs').checked });
        toast('Imported: ' + d.sup + ' supplier' + (d.sup === 1 ? '' : 's') + ', ' + (d.mat + d.shop) + ' item' + (d.mat + d.shop === 1 ? '' : 's') + ' with their suppliers');
      } catch (e) { toast('Import stopped: ' + e.message, 'warn'); return false; }
    }
  });
  m.wrap.querySelector('.modal-card').classList.add('wide');
}
