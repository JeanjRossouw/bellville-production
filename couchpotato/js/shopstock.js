// The shop's stock, at the till (with the online shop connected):
//
//   Receive   a delivery from a supplier (a GRV): lines by scanning or
//             searching, or read off the supplier's invoice (Excel, CSV or
//             PDF) and matched by code, then by name. Booked onto the shop's
//             count through the factory-shopify function (`receive`), once.
//             grvs: { no, supplier, ref, date, lines[{variantId,
//             inventoryItemId, name, sku, qty, cost}], total, status, received[],
//             failed[], by }
//   Stock take  count the shop, the whole shop or one category, by scanning
//             (each scan adds one) or typing. The count waits in stockTakes
//             until it is reconciled: the counted numbers become the shop's
//             count (`setStock`). A manager reconciles.
//   Quick keys  the ⭐ products shown first on the till (shopProducts.quickKey).
//   Labels    barcode labels for shop products, from the labels view or
//             straight after a delivery.
//   Costs     a cost per shop product (shopProducts.cost), from deliveries, for
//             the dashboard's gross profit; shown only to roles that see costing.
//   Dashboard today / this week / this month from the till's own sales: money
//             taken, sales, average, top products, by hour.
import * as store from './store.js';
import * as till from './till.js';
import { readFile } from './importer.js';
import { labelSheetHtml, openBarcodeCamera } from './barcode.js';
import { esc, money, field, row, val, openModal, toast, empty, today, niceDate, openPrint, isoLocal } from './ui.js';

let settings = {};
let grvs = [], takes = [], shopProds = {};
let unwatch = [];
let onChange = null;
let view = 'receive';          // receive | take | labels | dashboard
let draft = { supplier: '', ref: '', date: '', lines: [], unmatched: [] };
let takeScan = '';
let dashRange = 'today';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cur = () => settings.currency || 'R';

export function startShopStock(cb, cfg) {
  onChange = cb; settings = cfg || {};
  unwatch.forEach(u => u()); unwatch = [];
  unwatch.push(store.watch('grvs', rows => { grvs = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); if (onChange) onChange(); }));
  unwatch.push(store.watch('stockTakes', rows => { takes = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); if (onChange) onChange(); }));
  unwatch.push(store.watch('shopProducts', rows => { shopProds = {}; rows.forEach(r => { shopProds[r.id] = r; }); if (onChange) onChange(); }));
  try { const d = JSON.parse(localStorage.getItem('cp-grv-draft') || 'null'); if (d && Array.isArray(d.lines)) draft = d; } catch (e) {}
}
export const setShopStockSettings = (cfg) => { settings = cfg || {}; };
export const setShopStockView = (v) => { view = v; };
export const shopProduct = (key) => shopProds[key] || null;
export const isQuickKey = (key) => !!(shopProds[key] && shopProds[key].quickKey);
export const costOfShopItem = (variantId) => Number((shopProds[variantId] || {}).cost) || 0;
const persistDraft = () => { try { localStorage.setItem('cp-grv-draft', JSON.stringify(draft)); } catch (e) {} };

// ------------------------------------------------------------ quick keys ---

// The key for a tile: a shop variant's id, or p-<product id> for the factory's own
export async function toggleQuickKey(key, name) {
  const had = shopProds[key];
  if (had) await store.update('shopProducts', key, { quickKey: !had.quickKey });
  else await store.createWithId('shopProducts', key, { quickKey: true, name: name || '' });
  toast((had && had.quickKey ? 'Removed from' : 'Added to') + ' the quick keys');
}

// --------------------------------------------------------------- receive ---

function matchItem(code, name) {
  const items = till.shopItems();
  if (code) { const c = String(code).toLowerCase(); const hit = items.find(i => String(i.sku || '').toLowerCase() === c || String(i.barcode || '').toLowerCase() === c); if (hit) return hit; }
  if (name) { const n = String(name).trim().toLowerCase(); const exact = items.find(i => String(i.name || '').trim().toLowerCase() === n); if (exact) return exact; return fuzzyFind(name); }
  return null;
}
// Token overlap against name + SKU + barcode, accepted only for a clear
// winner. Tokens that start with a digit (25w, 30cm) must match a whole word,
// so "50w" never matches "150w"; the rest may match as a prefix.
export function fuzzyFind(nm) {
  const toks = String(nm || '').toLowerCase().replace(/[^\w.\-]+/g, ' ').split(/\s+/).filter(t => t.length >= 2);
  if (toks.length < 2) return null;
  let best = null, bestScore = 0, second = 0;
  till.shopItems().forEach(p => {
    const hay = ((p.name || '') + ' ' + (p.sku || '') + ' ' + (p.barcode || '')).toLowerCase();
    const hayToks = hay.replace(/[^\w.\-]+/g, ' ').split(/\s+/).filter(Boolean);
    let hit = 0;
    toks.forEach(t => {
      if (/^\d/.test(t)) { if (hayToks.includes(t)) hit++; return; }
      if (hay.includes(t)) { hit++; return; }
      if (t.length >= 4 && hayToks.some(h => h.length >= 4 && (h.startsWith(t) || t.startsWith(h)))) hit++;
    });
    const score = hit / toks.length;
    if (score > bestScore) { second = bestScore; bestScore = score; best = p; }
    else if (score > second) second = score;
  });
  return bestScore >= 0.7 && bestScore - second >= 0.5 / toks.length ? best : null;
}
function addLine(it, qty, cost) {
  const had = draft.lines.find(l => l.variantId === it.variantId);
  if (had) { had.qty += qty || 1; if (cost > 0) had.cost = cost; }
  else draft.lines.push({ variantId: it.variantId, inventoryItemId: it.inventoryItemId, name: it.name, sku: it.sku || '', barcode: it.barcode || '', qty: qty || 1, cost: cost > 0 ? cost : costOfShopItem(it.variantId), price: it.price });
  persistDraft();
}
export function receiveScan(code) {
  const it = matchItem(code, '');
  if (!it) { toast('No shop product has code ' + code, 'warn'); return false; }
  addLine(it, 1, 0); rerender(); toast('＋ ' + it.name); return true;
}
function receiveSearch(q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return;
  const hits = till.shopItems().filter(i => [i.name, i.sku, i.barcode].some(v => String(v || '').toLowerCase().includes(t)));
  if (hits.length === 1) { addLine(hits[0], 1, 0); rerender(); toast('＋ ' + hits[0].name); return; }
  if (!hits.length) { toast('Nothing in the shop matches', 'warn'); return; }
  const m = openModal('Which product?', `<div class="pk-list">${hits.slice(0, 30).map(i => `<button type="button" class="pk-row" data-v="${esc(i.variantId)}"><strong>${esc(i.name)}</strong><span>${esc([i.sku, i.barcode].filter(Boolean).join(' · '))} · ${esc(i.qty)} in stock</span></button>`).join('')}</div>`, { okLabel: 'Close' });
  m.wrap.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { addLine(till.shopItem(b.dataset.v), 1, 0); m.close(); rerender(); }));
}

// The supplier's invoice as a file: Excel or CSV through the importer's
// reader, a PDF through pdf.js (fetched when first needed), then the rows
// matched by code, exact name, or a clear fuzzy match.
let pdfjsLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsLoading) return pdfjsLoading;
  pdfjsLoading = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    sc.onload = () => { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; } catch (e) {} res(window.pdfjsLib); };
    sc.onerror = () => { pdfjsLoading = null; rej(new Error('Could not load the PDF reader (needs internet)')); };
    document.head.appendChild(sc);
  });
  return pdfjsLoading;
}
async function pdfRows(file) {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const rows = [];
  for (let pg = 1; pg <= doc.numPages; pg++) {
    const tc = await (await doc.getPage(pg)).getTextContent();
    // text runs clustered into visual rows by their y position, then left to right
    const items = tc.items.map(it => ({ str: (it.str || '').trim(), x: it.transform[4], y: it.transform[5] })).filter(it => it.str);
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    let cur = null, curY = null;
    items.forEach(it => { if (curY === null || Math.abs(it.y - curY) > 4) { cur = []; rows.push(cur); curY = it.y; } cur.push(it); });
  }
  return rows.map(r => r.sort((a, b) => a.x - b.x).map(c => c.str));
}
export async function importInvoice(file) {
  if (!file) return;
  try {
    const fromPdf = /\.pdf$/i.test(file.name);
    let rows;
    if (fromPdf) rows = await pdfRows(file);
    else {
      // the importer's reader gives every sheet of the workbook: the one with the item table
      const sheets = await readFile(file);
      const pick = sheets.find(sh => (sh.rows || []).some(r => (r || []).some(c => /qty|quantity|units/i.test(String(c || ''))))) || sheets.sort((a, b) => (b.rows || []).length - (a.rows || []).length)[0];
      rows = pick ? pick.rows : [];
    }
    applyRows(rows, fromPdf);
  } catch (e) { toast('Could not read the file: ' + e.message, 'warn'); }
}
const moneyOf = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(n) ? r2(Math.abs(n)) : 0; };
function applyRows(rows, fromPdf) {
  if (!rows || !rows.length) { toast('The file is empty', 'warn'); return; }
  const lower = r => (r || []).map(c => String(c == null ? '' : c).trim().toLowerCase());
  // the header is not always first: a PDF carries the address block above the table
  const hdrIdx = rows.findIndex(r => lower(r).some(c => /qty|quantity|units/.test(c)));
  let iSku = -1, iQty = -1, iCost = -1, iName = -1, start;
  if (hdrIdx >= 0) {
    const hdr = lower(rows[hdrIdx]);
    const col = (...names) => hdr.findIndex(h => names.some(n => h.includes(n)));
    iSku = col('sku', 'barcode', 'item code', 'code'); iQty = col('qty', 'quantity', 'units'); iCost = col('unit cost', 'cost', 'unit price', 'price', 'excl');
    iName = hdr.findIndex((h, ix) => ix !== iSku && ['description', 'product', 'name', 'title', 'item'].some(n => h.includes(n)));
    start = hdrIdx + 1;
  } else if (!fromPdf) { iSku = 0; iQty = 1; iCost = 2; start = 0; }       // a headerless CSV: code, qty, cost
  else { toast('Could not find the item table in this PDF. Ask the supplier for the invoice as Excel or CSV.', 'warn'); return; }
  let matched = 0; const misses = [];
  for (let r = start; r < rows.length; r++) {
    const rowv = rows[r] || [];
    const code = iSku >= 0 ? String(rowv[iSku] == null ? '' : rowv[iSku]).trim() : '';
    const nm = iName >= 0 ? String(rowv[iName] == null ? '' : rowv[iName]).trim() : '';
    const qty = Math.round(Number(String(rowv[iQty] == null ? '' : rowv[iQty]).replace(/[^\d.]/g, '')) || 0);
    if ((!code && !nm) || qty <= 0 || qty > 100000) continue;
    const cost = iCost >= 0 ? moneyOf(rowv[iCost]) : 0;
    const it = matchItem(code, nm);
    if (it) { addLine(it, qty, cost); matched++; }
    else misses.push({ code, name: nm, qty, cost });
  }
  draft.unmatched = misses; persistDraft(); rerender();
  toast(matched + ' line' + (matched === 1 ? '' : 's') + ' matched' + (misses.length ? ', ' + misses.length + ' not found (listed below)' : ''), misses.length ? 'warn' : undefined);
}
function pickForMiss(i) {
  const miss = draft.unmatched[i]; if (!miss) return;
  const m = openModal('Which product is “' + (miss.name || miss.code) + '”?', `<input id="pm-q" placeholder="Search the shop…" style="width:100%; font:inherit; padding:.5rem .6rem; border:1px solid #d6d3d1; border-radius:3px; margin-bottom:.5rem"><div class="pk-list" id="pm-list"></div>`, { okLabel: 'Skip this line', onOk: () => { draft.unmatched.splice(i, 1); persistDraft(); rerender(); } });
  const list = m.wrap.querySelector('#pm-list'), q = m.wrap.querySelector('#pm-q');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const hits = till.shopItems().filter(x => !t || [x.name, x.sku, x.barcode].some(v => String(v || '').toLowerCase().includes(t))).slice(0, 25);
    list.innerHTML = hits.map(x => `<button type="button" class="pk-row" data-v="${esc(x.variantId)}"><strong>${esc(x.name)}</strong><span>${esc([x.sku, x.barcode].filter(Boolean).join(' · '))}</span></button>`).join('') || '<div class="muted" style="padding:.4rem">No match</div>';
    list.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { addLine(till.shopItem(b.dataset.v), miss.qty, miss.cost); draft.unmatched.splice(i, 1); persistDraft(); m.close(); rerender(); }));
  };
  q.addEventListener('input', draw); draw(); setTimeout(() => q.focus(), 60);
}

async function bookIn() {
  if (!draft.lines.length) { toast('Nothing on the delivery yet', 'warn'); return; }
  if (!draft.supplier.trim()) { toast('Who is the delivery from?', 'warn'); return; }
  if (!confirm('Book ' + draft.lines.reduce((a, l) => a + l.qty, 0) + ' pieces from ' + draft.supplier + ' onto the shop’s stock?')) return;
  const n = await store.nextNumber('grvNo', 1);
  const no = 'GRV-' + String(n).padStart(4, '0');
  const lines = draft.lines.map(l => ({ ...l, qty: Math.round(l.qty), cost: r2(l.cost) }));
  const total = r2(lines.reduce((a, l) => a + l.qty * l.cost, 0));
  const id = await store.create('grvs', { no, supplier: draft.supplier.trim(), ref: draft.ref.trim(), date: draft.date || today(), lines, total, status: 'booked', received: [], failed: [], by: till.ringer(), unmatched: draft.unmatched });
  // the costs stay with the products, for the dashboard
  for (const l of lines) if (l.cost > 0) { if (shopProds[l.variantId]) await store.update('shopProducts', l.variantId, { cost: l.cost, costAt: today(), name: l.name }); else await store.createWithId('shopProducts', l.variantId, { cost: l.cost, costAt: today(), name: l.name, quickKey: false }); }
  draft = { supplier: '', ref: '', date: '', lines: [], unmatched: [] }; persistDraft();
  toast(no + ' saved · sending to the shop…');
  rerender();
  await sendGrv(id);
}
async function sendGrv(id) {
  try {
    const r = await store.shopifyCall('receive', { grvId: id });
    const g = grvs.find(x => x.id === id) || {};
    if (r.failed && r.failed.length) toast((g.no || 'Delivery') + ': ' + r.failed.length + ' line(s) Shopify refused: ' + r.failed.map(f => f.name + ' (' + f.error + ')').join('; '), 'warn');
    else if (!r.already) toast((g.no || 'Delivery') + ' is on the shop’s stock');
    till.refreshCatalogue(true);
  } catch (e) { toast('Not on the shop’s stock yet: ' + e.message + '. Tap Send again on the delivery.', 'warn'); }
}
function receiveHtml() {
  const c = cur();
  const total = r2(draft.lines.reduce((a, l) => a + l.qty * l.cost, 0));
  const seesCost = store.can('costing') || store.can('stock');
  return `<div class="card">
    <h2>Receive a delivery</h2>
    ${row(field('Supplier', 'gr-sup', { value: draft.supplier, placeholder: 'Who it is from', list: 'gr-sup-list' }), field('Their invoice / delivery note no.', 'gr-ref', { value: draft.ref }))}
    <datalist id="gr-sup-list">${[...new Set(grvs.map(g => g.supplier).filter(Boolean))].map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>
    <div class="toolbar" style="margin:.4rem 0 .6rem">
      <input id="gr-scan" class="search" placeholder="Scan a barcode, or search the shop and press Enter…" autocomplete="off">
      <button class="btn ghost" data-act="ss-scan">📷 Scan</button>
      <label class="btn ghost" style="cursor:pointer">📄 Supplier’s invoice (PDF, Excel, CSV)<input type="file" id="gr-file" accept=".pdf,.xlsx,.xlsm,.csv,text/csv,application/pdf" hidden></label>
    </div>
    ${draft.lines.length ? `<div style="overflow:auto"><table class="tbl ss-lines"><thead><tr><th>Product</th><th class="r">Qty</th>${seesCost ? '<th class="r">Cost each</th><th class="r">Amount</th>' : ''}<th></th></tr></thead><tbody>
      ${draft.lines.map((l, i) => `<tr><td><strong>${esc(l.name)}</strong><div class="muted">${esc([l.sku, l.barcode].filter(Boolean).join(' · '))}</div></td>
        <td class="r"><input class="ss-in" data-f="qty" data-i="${i}" type="number" min="1" step="1" value="${esc(l.qty)}" style="width:80px"></td>
        ${seesCost ? `<td class="r"><input class="ss-in" data-f="cost" data-i="${i}" type="number" min="0" step="0.01" value="${esc(l.cost || '')}" style="width:110px"></td><td class="r">${esc(money(l.qty * l.cost, c))}</td>` : ''}
        <td class="r"><button class="icon-btn" data-act="ss-remove" data-i="${i}" title="Remove">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted">${draft.lines.reduce((a, l) => a + l.qty, 0)} pieces${seesCost ? ' · ' + esc(money(total, c)) + ' excl. VAT' : ''}</p>` : '<p class="muted">Scan each item as you unpack it, or load the supplier’s invoice.</p>'}
    ${draft.unmatched.length ? `<div class="notice-inline"><strong>${draft.unmatched.length} line${draft.unmatched.length === 1 ? '' : 's'} on the invoice not found in the shop:</strong><br>${draft.unmatched.map((u, i) => `<button class="btn ghost sm" data-act="ss-pick" data-i="${i}" style="margin:.2rem .3rem .2rem 0">${esc(u.qty + ' × ' + (u.name || u.code))}</button>`).join('')}<br><span class="muted">Tap one to pick the product it is, or skip it.</span></div>` : ''}
    <div class="card-actions"><button class="btn ghost" data-act="ss-clear">Clear</button><button class="btn primary" data-act="ss-book">Book it in</button></div>
  </div>
  <div class="card" style="padding:0; overflow:auto"><table class="tbl"><thead><tr><th>Delivery</th><th>Supplier</th><th>Date</th><th class="r">Pieces</th>${seesCost ? '<th class="r">Total</th>' : ''}<th>Shop</th><th></th></tr></thead>
    <tbody>${grvs.length ? grvs.slice(0, 100).map(g => `<tr><td><strong>${esc(g.no)}</strong><div class="muted">${esc(g.ref || '')} · ${esc(g.by || '')}</div></td><td>${esc(g.supplier)}</td><td>${esc(niceDate(g.date))}</td><td class="r">${(g.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0)}</td>${seesCost ? `<td class="r">${esc(money(g.total, c))}</td>` : ''}
      <td>${g.status === 'received' ? '<span class="chip calm">on the shop’s stock</span>' : g.status === 'part' ? '<span class="chip late">' + (g.failed || []).length + ' line(s) refused</span>' : '<span class="chip late">not sent yet</span>'}</td>
      <td class="r nowrap">${g.status !== 'received' ? `<button class="btn primary sm" data-act="ss-send" data-id="${esc(g.id)}">Send again</button> ` : ''}<button class="btn ghost sm" data-act="ss-labels-grv" data-id="${esc(g.id)}">Labels</button> <button class="btn ghost sm" data-act="ss-print-grv" data-id="${esc(g.id)}">Print</button></td></tr>`).join('') : '<tr><td colspan="7" class="muted">No deliveries yet.</td></tr>'}</tbody></table></div>`;
}
function printGrv(id) {
  const g = grvs.find(x => x.id === id); if (!g) return;
  const c = cur();
  openPrint(g.no, `<h1>${esc(settings.name || '')} · Goods received ${esc(g.no)}</h1><p>From <strong>${esc(g.supplier)}</strong>${g.ref ? ' · their ref ' + esc(g.ref) : ''} · ${esc(niceDate(g.date))} · booked in by ${esc(g.by || '')}</p>
    <table><tr><th>Product</th><th>SKU</th><th class="r">Qty</th><th class="r">Cost each</th><th class="r">Amount</th></tr>${(g.lines || []).map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.sku || l.barcode || '')}</td><td class="r">${esc(l.qty)}</td><td class="r">${esc(money(l.cost, c))}</td><td class="r">${esc(money(l.qty * l.cost, c))}</td></tr>`).join('')}
    <tr class="tot big"><td colspan="4" class="r">TOTAL excl. VAT</td><td class="r">${esc(money(g.total, c))}</td></tr></table>
    ${(g.failed || []).length ? '<p><b>Not on the shop’s stock:</b> ' + g.failed.map(f => esc(f.name + ' (' + f.error + ')')).join('; ') + '</p>' : ''}`);
}

// ------------------------------------------------------------ stock take ---

export const openTake = () => takes.find(t => t.status === 'open') || null;
function startTake(scope) {
  const items = till.shopItems().filter(i => i.tracked && (!scope || (i.category || 'Shop') === scope));
  if (!items.length) { toast('Nothing to count there', 'warn'); return; }
  return store.create('stockTakes', { no: 'ST-' + String(Date.now()).slice(-6), status: 'open', scope: scope || '', startedAt: store.nowIso(), by: till.ringer(),
    lines: items.map(i => ({ variantId: i.variantId, inventoryItemId: i.inventoryItemId, name: i.name, sku: i.sku || '', barcode: i.barcode || '', category: i.category || '', system: Number(i.qty) || 0, counted: null })) });
}
async function countOne(variantId, delta, set) {
  const t = openTake(); if (!t) return false;
  const lines = t.lines.map(l => l.variantId === variantId ? { ...l, counted: set != null ? set : (Number(l.counted) || 0) + delta, countedAt: store.nowIso() } : l);
  if (!lines.some(l => l.variantId === variantId)) return false;
  await store.update('stockTakes', t.id, { lines });
  return true;
}
export async function takeScanCode(code) {
  const it = matchItem(code, '');
  if (!it) { toast('No shop product has code ' + code, 'warn'); return false; }
  if (!await countOne(it.variantId, 1)) { toast(it.name + ' is not in this count', 'warn'); return false; }
  toast('＋1 ' + it.name); return true;
}
async function reconcile() {
  const t = openTake(); if (!t) return;
  const counted = t.lines.filter(l => l.counted != null && l.counted !== '');
  if (!counted.length) { toast('Nothing counted yet', 'warn'); return; }
  const me = till.tillUser();
  if (till.usesPins() && !till.isManager(me) && !await till.managerApproval('Making the count the shop’s stock needs a manager.')) return;
  const diff = counted.filter(l => Number(l.counted) !== Number(l.system)).length;
  if (!confirm('Make these counts the shop’s stock? ' + counted.length + ' counted, ' + diff + ' different from the shop. Lines not counted are left as they are.')) return;
  try {
    const r = await store.shopifyCall('setStock', { takeId: t.id });
    toast(r.failed && r.failed.length ? r.set + ' set, ' + r.failed.length + ' refused: ' + r.failed.map(f => f.name).join(', ') : r.set + ' products set on the shop');
    till.refreshCatalogue(true);
  } catch (e) { toast('Not set on the shop: ' + e.message, 'warn'); }
}
function takeHtml() {
  const t = openTake();
  if (!t) {
    const cats = [...new Set(till.shopItems().filter(i => i.tracked).map(i => i.category || 'Shop'))].sort();
    return `<div class="card"><h2>Stock take</h2><p class="muted">Count the shop by scanning each item (every scan adds one) or typing the number. When you are done, the counts become the shop’s stock.</p>
      <div class="btn-row"><button class="btn primary" data-act="ss-take-start" data-scope="">Count the whole shop</button>${cats.map(x => `<button class="btn ghost" data-act="ss-take-start" data-scope="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>
      ${takes.filter(x => x.status !== 'open').length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl"><thead><tr><th>Stock take</th><th>Started</th><th>Reconciled</th><th class="r">Counted</th><th class="r">Different</th></tr></thead><tbody>${takes.filter(x => x.status !== 'open').slice(0, 50).map(x => { const cnt = (x.lines || []).filter(l => l.counted != null); return `<tr><td><strong>${esc(x.no)}</strong>${x.scope ? ' <span class="muted">' + esc(x.scope) + '</span>' : ''}</td><td>${esc(niceDate(String(x.startedAt || '').slice(0, 10)))} ${esc(x.by || '')}</td><td>${esc(niceDate(String(x.reconciledAt || '').slice(0, 10)))} ${esc(x.reconciledBy || '')}</td><td class="r">${cnt.length}</td><td class="r">${cnt.filter(l => Number(l.counted) !== Number(l.system)).length}</td></tr>`; }).join('')}</tbody></table></div>` : ''}`;
  }
  const f = takeScan.trim().toLowerCase();
  const filt = (l) => !f || [l.name, l.sku, l.barcode].some(v => String(v || '').toLowerCase().includes(f));
  const lines = t.lines.filter(filt);
  const done = t.lines.filter(l => l.counted != null).length, diff = t.lines.filter(l => l.counted != null && Number(l.counted) !== Number(l.system)).length;
  return `<div class="card">
    <div class="page-head" style="margin:0 0 .5rem"><div><h2>${esc(t.no)}${t.scope ? ' · ' + esc(t.scope) : ''}</h2><p class="sub">${done} of ${t.lines.length} counted · ${diff} different from the shop · started ${esc(niceDate(String(t.startedAt || '').slice(0, 10)))} by ${esc(t.by || '')}</p></div>
      <div class="btn-row"><button class="btn ghost" data-act="ss-take-scan">📷 Scan</button><button class="btn ghost" data-act="ss-take-cancel">Cancel count</button><button class="btn primary" data-act="ss-take-done">Make it the shop’s stock</button></div></div>
    <input id="st-scan" class="search" placeholder="Scan a barcode (adds one), or type to find a product…" value="${esc(takeScan)}" autocomplete="off" style="width:100%; margin-bottom:.5rem">
    <div style="overflow:auto; max-height:60vh"><table class="tbl"><thead><tr><th>Product</th><th class="r">Shop says</th><th class="r">Counted</th><th class="r">Difference</th></tr></thead><tbody>
      ${lines.map(l => { const d = l.counted == null ? null : Number(l.counted) - Number(l.system); return `<tr><td><strong>${esc(l.name)}</strong><div class="muted">${esc([l.sku, l.barcode].filter(Boolean).join(' · '))}</div></td><td class="r">${esc(l.system)}</td>
        <td class="r"><span class="qty"><button class="btn ghost sm" data-act="ss-count" data-v="${esc(l.variantId)}" data-d="-1">−</button><input class="ss-cnt" data-v="${esc(l.variantId)}" type="number" min="0" step="1" value="${l.counted == null ? '' : esc(l.counted)}" style="width:70px; text-align:right"><button class="btn ghost sm" data-act="ss-count" data-v="${esc(l.variantId)}" data-d="1">+</button></span></td>
        <td class="r" style="color:${d == null ? '' : d < 0 ? '#b91c1c' : d > 0 ? '#1f7a3a' : ''}">${d == null ? '' : (d > 0 ? '+' : '') + d}</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
}

// ---------------------------------------------------------------- labels ---

function labelsHtml() {
  return `<div class="card"><h2>Product labels</h2><p class="muted">Barcode labels for the shop’s products (3 across on an A4 label sheet). Pick the products and how many of each.</p>
    <input id="lb-q" class="search" placeholder="Search the shop…" autocomplete="off" style="width:100%; margin-bottom:.5rem">
    <div id="lb-list" class="pk-list" style="max-height:40vh"></div>
    <div class="card-actions"><button class="btn primary" data-act="ss-labels-print">Print the labels</button></div></div>`;
}
const labelPicks = {};
function wireLabels(host) {
  const q = host.querySelector('#lb-q'), list = host.querySelector('#lb-list'); if (!q || !list) return;
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const items = till.shopItems().filter(i => !t || [i.name, i.sku, i.barcode].some(v => String(v || '').toLowerCase().includes(t))).slice(0, 60);
    list.innerHTML = items.map(i => `<div class="pk-row" style="display:grid; grid-template-columns:1fr 90px; align-items:center"><div><strong>${esc(i.name)}</strong><span>${esc(i.barcode || i.sku || 'no barcode')} · ${esc(money(i.price, cur()))}</span></div><input type="number" min="0" step="1" class="lb-n" data-v="${esc(i.variantId)}" value="${esc(labelPicks[i.variantId] || '')}" placeholder="copies" style="width:80px"></div>`).join('') || '<div class="muted" style="padding:.4rem">No match</div>';
    list.querySelectorAll('.lb-n').forEach(inp => inp.addEventListener('input', () => { labelPicks[inp.dataset.v] = parseInt(inp.value, 10) || 0; }));
  };
  q.addEventListener('input', draw); draw();
}
function printLabels(items) {
  const rows = items.filter(x => x.copies > 0).map(x => ({ p: { name: x.i.name, sellingPrice: x.i.price, barcode: x.i.barcode || x.i.sku || '' }, copies: x.copies }));
  if (!rows.length) { toast('Say how many labels of each product', 'warn'); return; }
  openPrint('Labels', labelSheetHtml(rows, settings));
}

// ------------------------------------------------------------- dashboard ---

function rangeDays() {
  const t = today();
  if (dashRange === 'today') return [t, t];
  if (dashRange === 'week') { const d = new Date(t + 'T12:00:00'); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return [isoLocal(d), t]; }
  return [t.slice(0, 7) + '-01', t];
}
export function dashboardHtml(sales) {
  const c = cur();
  const [from, to] = rangeDays();
  const rows = (sales || []).filter(s => s.date >= from && s.date <= to);
  const seesCost = store.can('costing') || store.can('profit');
  const by = {}; let taken = 0, items = 0, cost = 0, costed = 0;
  const prod = {}, hour = {};
  rows.forEach(s => {
    (s.payments || [{ method: s.method, amount: s.paidNow }]).forEach(p => { if (till.MONEY.includes(p.method)) { by[p.method] = r2((by[p.method] || 0) + (Number(p.amount) || 0)); taken = r2(taken + (Number(p.amount) || 0)); } });
    (s.lines || []).forEach(l => {
      if (l.kind === 'giftcard') return;
      items += Number(l.qty) || 0;
      const k = l.name || '?'; prod[k] = prod[k] || { qty: 0, value: 0 }; prod[k].qty += Number(l.qty) || 0; prod[k].value = r2(prod[k].value + (Number(l.net) != null ? Number(l.net) : (Number(l.qty) || 0) * (Number(l.unitPrice) || 0)));
      if (l.shop && costOfShopItem(l.variantId) > 0) { cost += costOfShopItem(l.variantId) * (Number(l.qty) || 0); costed++; }
    });
    const h = String(s.time || String(s.createdAt || '').slice(11, 16) || '').slice(0, 2); if (h) hour[h] = r2((hour[h] || 0) + (Number(s.total) || 0));
  });
  const value = r2(rows.reduce((a, s) => a + (Number(s.total) || 0), 0));
  const vatRate = settings.vatRegistered ? Number(settings.vatRate) || 0 : 0;
  const ex = r2(value / (1 + vatRate));
  const tile = (n, label) => `<div class="tile"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  const top = (key) => Object.entries(prod).sort((a, b) => b[1][key] - a[1][key]).slice(0, 5);
  const hours = Object.keys(hour).sort(), maxH = Math.max(1, ...hours.map(h => hour[h]));
  return `<div class="btn-row" style="margin-bottom:.8rem">${['today', 'week', 'month'].map(k => `<button class="btn ${dashRange === k ? 'primary' : 'ghost'} sm" data-act="ss-range" data-to="${k}">${k === 'today' ? 'Today' : k === 'week' ? 'This week' : 'This month'}</button>`).join('')}</div>
    <div class="tiles">${tile(esc(money(value, c)), 'Sales')}${tile(esc(money(taken, c)), 'Money taken')}${tile(rows.length, 'Sales')}${tile(esc(money(rows.length ? value / rows.length : 0, c)), 'Average sale')}${tile(rows.length ? (items / rows.length).toFixed(1) : '0', 'Items per sale')}${seesCost && costed ? tile(esc(money(ex - cost, c)), 'Gross profit (' + costed + ' lines costed, excl. VAT)') : ''}</div>
    <div class="grid cards" style="grid-template-columns:repeat(auto-fit, minmax(280px, 1fr))">
      <div class="card"><h2>By method</h2>${Object.keys(by).length ? `<table class="tbl">${Object.keys(by).sort().map(m => `<tr><td>${esc(m)}</td><td class="r">${esc(money(by[m], c))}</td></tr>`).join('')}</table>` : '<p class="muted">No money taken yet.</p>'}</div>
      <div class="card"><h2>Top 5 by quantity</h2>${top('qty').length ? `<table class="tbl">${top('qty').map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r">${v.qty}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing sold yet.</p>'}</div>
      <div class="card"><h2>Top 5 by value</h2>${top('value').length ? `<table class="tbl">${top('value').map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r">${esc(money(v.value, c))}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing sold yet.</p>'}</div>
      <div class="card"><h2>By hour</h2>${hours.length ? `<div class="ss-bars">${hours.map(h => `<div class="ss-bar" title="${esc(h + ':00 ' + money(hour[h], c))}"><div style="height:${Math.round(hour[h] / maxH * 100)}%"></div><span>${esc(h)}</span></div>`).join('')}</div>` : '<p class="muted">Nothing yet.</p>'}</div>
    </div>`;
}

// ---------------------------------------------------------------- render ---

let host = null;
const rerender = () => { if (onChange) onChange(); };
export function renderShopStock(h, sales) {
  host = h;
  if (!till.shopOn()) { h.innerHTML = empty('', 'Connect the online shop first', 'The shop’s stock, deliveries and stock takes work with the shop connected (Settings → Online shop).'); return; }
  const tab = (key, label) => `<button class="btn ${view === key ? 'primary' : 'ghost'} sm" data-act="ss-view" data-to="${key}">${label}</button>`;
  h.innerHTML = `<div class="btn-row" style="margin-bottom:.8rem">${tab('receive', 'Receive stock')}${tab('take', 'Stock take')}${tab('labels', 'Labels')}</div>` + (view === 'take' ? takeHtml() : view === 'labels' ? labelsHtml() : receiveHtml());
  const scan = h.querySelector('#gr-scan');
  if (scan) { scan.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = scan.value.trim(); if (!v) return; if (!receiveScan(v)) receiveSearch(v); scan.value = ''; } }); setTimeout(() => scan.focus(), 50); }
  const file = h.querySelector('#gr-file'); if (file) file.addEventListener('change', () => { importInvoice(file.files[0]); file.value = ''; });
  h.querySelectorAll('#gr-sup, #gr-ref').forEach(i => i.addEventListener('input', () => { draft.supplier = h.querySelector('#gr-sup').value; draft.ref = h.querySelector('#gr-ref').value; persistDraft(); }));
  h.querySelectorAll('.ss-in').forEach(i => i.addEventListener('input', () => { const l = draft.lines[parseInt(i.dataset.i, 10)]; if (!l) return; l[i.dataset.f] = i.dataset.f === 'qty' ? Math.max(1, parseInt(i.value, 10) || 1) : r2(parseFloat(i.value) || 0); persistDraft(); }));
  const st = h.querySelector('#st-scan');
  if (st) { st.addEventListener('input', () => { takeScan = st.value; }); st.addEventListener('keydown', async (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const v = st.value.trim(); if (!v) return; if (await takeScanCode(v)) { takeScan = ''; } else { takeScan = v; } rerender(); }); if (takeScan) { st.focus(); st.setSelectionRange(st.value.length, st.value.length); } }
  h.querySelectorAll('.ss-cnt').forEach(i => i.addEventListener('change', () => { countOne(i.dataset.v, 0, i.value === '' ? null : Math.max(0, parseInt(i.value, 10) || 0)); }));
  wireLabels(h);
}

export async function shopStockAction(act, el) {
  const i = parseInt(el.dataset.i, 10);
  switch (act) {
    case 'ss-view': view = el.dataset.to; return rerender();
    case 'ss-range': dashRange = el.dataset.to; return rerender();
    case 'ss-scan': return openBarcodeCamera((code) => { receiveScan(code); });
    case 'ss-remove': draft.lines.splice(i, 1); persistDraft(); return rerender();
    case 'ss-pick': return pickForMiss(i);
    case 'ss-clear': if (confirm('Clear this delivery?')) { draft = { supplier: '', ref: '', date: '', lines: [], unmatched: [] }; persistDraft(); rerender(); } return;
    case 'ss-book': return bookIn();
    case 'ss-send': return sendGrv(el.dataset.id);
    case 'ss-print-grv': return printGrv(el.dataset.id);
    case 'ss-labels-grv': { const g = grvs.find(x => x.id === el.dataset.id); if (g) printLabels((g.lines || []).map(l => ({ i: { name: l.name, price: l.price, barcode: l.barcode, sku: l.sku }, copies: l.qty }))); return; }
    case 'ss-labels-print': return printLabels(till.shopItems().map(x => ({ i: x, copies: labelPicks[x.variantId] || 0 })));
    case 'ss-take-start': await startTake(el.dataset.scope); return;
    case 'ss-take-scan': return openBarcodeCamera((code) => { takeScanCode(code); });
    case 'ss-take-cancel': { const t = openTake(); if (t && confirm('Cancel this count? Nothing is changed on the shop.')) await store.update('stockTakes', t.id, { status: 'cancelled' }); return; }
    case 'ss-take-done': return reconcile();
    case 'ss-count': await countOne(el.dataset.v, parseInt(el.dataset.d, 10)); return;
  }
}
