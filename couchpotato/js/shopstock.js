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
//   Suppliers  who the shop buys from (suppliers: name, phone, email, notes),
//             typed in or loaded from the shop's product vendors.
//   Order stock  purchase orders for shop stock (shopPos: { no, supplier,
//             supplierId, lines[{variantId, inventoryItemId, name, sku, qty,
//             cost, received}], total, status draft|sent|part|received }), sent
//             by WhatsApp, email or print, and received straight into a
//             delivery. What to order is suggested: a reorder level per
//             product from the last 30 days' sales (two weeks' cover; editable,
//             shopProducts.reorderLevel) plus what open sales orders need,
//             less what is on hand and already on order, grouped by supplier.
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
import { esc, money, field, row, val, openModal, toast, empty, today, niceDate, openPrint, isoLocal, docHeader, waDigits, addDays } from './ui.js';

let settings = {};
let grvs = [], takes = [], shopProds = {}, suppliers = [], pos = [];
let salesRef = () => [];
let unwatch = [];
let onChange = null;
let view = 'receive';          // receive | take | labels | dashboard
let draft = { supplier: '', ref: '', date: '', lines: [], unmatched: [], poId: '' };
let poDraft = null;        // a purchase order being written: { supplierId, supplier, lines }
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
  unwatch.push(store.watch('suppliers', rows => { suppliers = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); if (onChange) onChange(); }));
  unwatch.push(store.watch('shopPos', rows => { pos = rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); if (onChange) onChange(); }));
  try { const d = JSON.parse(localStorage.getItem('cp-grv-draft') || 'null'); if (d && Array.isArray(d.lines)) draft = d; } catch (e) {}
}
export const setShopStockSettings = (cfg) => { settings = cfg || {}; };
export const setShopStockView = (v) => { view = v; };
export const shopProduct = (key) => shopProds[key] || null;
export const isQuickKey = (key) => !!(shopProds[key] && shopProds[key].quickKey);
export const setView = (v) => { view = v; };
export const currentView = () => view;
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
  const id = await store.create('grvs', { no, supplier: draft.supplier.trim(), ref: draft.ref.trim(), date: draft.date || today(), lines, total, status: 'booked', received: [], failed: [], by: till.ringer(), unmatched: draft.unmatched, poId: draft.poId || '' });
  // against a purchase order: what came in is marked received on it
  const po = draft.poId ? pos.find(x => x.id === draft.poId) : null;
  if (po) {
    const pl = (po.lines || []).map(l => { const got = lines.filter(x => x.variantId === l.variantId).reduce((a, x) => a + x.qty, 0); return got ? { ...l, received: (Number(l.received) || 0) + got } : l; });
    const done = pl.every(l => (Number(l.received) || 0) >= (Number(l.qty) || 0));
    await store.update('shopPos', po.id, { lines: pl, status: done ? 'received' : 'part', receivedAt: store.nowIso(), grvNo: no });
  }
  // the costs stay with the products, for the dashboard
  for (const l of lines) if (l.cost > 0) { if (shopProds[l.variantId]) await store.update('shopProducts', l.variantId, { cost: l.cost, costAt: today(), name: l.name }); else await store.createWithId('shopProducts', l.variantId, { cost: l.cost, costAt: today(), name: l.name, quickKey: false }); }
  draft = { supplier: '', ref: '', date: '', lines: [], unmatched: [], poId: '' }; persistDraft();
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
  const po = draft.poId ? pos.find(x => x.id === draft.poId) : null;
  return `<div class="card">
    <h2>Receive a delivery</h2>${po ? `<p class="notice-inline">Receiving against <strong>${esc(po.no)}</strong> from ${esc(po.supplier)}: set what actually arrived (remove a line to leave it on order).</p>` : ''}
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

// ------------------------------------------------------------- suppliers ---

export const allSuppliers = () => suppliers;
function supplierByName(name) { const n = String(name || '').trim().toLowerCase(); return suppliers.find(s => String(s.name || '').trim().toLowerCase() === n) || null; }
function editSupplier(id) {
  const sp = suppliers.find(x => x.id === id) || {};
  openModal(id ? 'Edit ' + sp.name : 'New supplier', row(field('Name', 'sp-name', { value: sp.name }), field('WhatsApp / cell', 'sp-phone', { value: sp.phone })) + row(field('Email', 'sp-email', { type: 'email', value: sp.email }), field('Account no. with them', 'sp-acc', { value: sp.account })) + field('Notes', 'sp-notes', { type: 'textarea', value: sp.notes, placeholder: 'Order days, minimums, rep’s name…' }), {
    okLabel: id ? 'Save' : 'Add',
    onOk: async (w) => {
      const name = val(w, 'sp-name'); if (!name) { toast('Give the supplier a name', 'warn'); return false; }
      const d = { name, phone: val(w, 'sp-phone'), email: val(w, 'sp-email'), account: val(w, 'sp-acc'), notes: val(w, 'sp-notes') };
      if (id) await store.update('suppliers', id, d); else await store.create('suppliers', d);
      toast(name + (id ? ' saved' : ' added'));
    }
  });
}
// The shop's product vendors become suppliers (the ones not here yet).
async function loadSuppliersFromShop() {
  const names = [...new Set(till.shopItems().map(i => String(i.vendor || '').trim()).filter(Boolean))];
  const fresh = names.filter(n => !supplierByName(n));
  if (!fresh.length) { toast(names.length ? 'Every vendor in the shop is already a supplier' : 'The shop’s products have no vendor filled in', 'warn'); return; }
  for (const n of fresh) await store.create('suppliers', { name: n, phone: '', email: '', account: '', notes: 'From the shop’s products' });
  toast(fresh.length + ' supplier' + (fresh.length === 1 ? '' : 's') + ' added from the shop');
}
function suppliersHtml() {
  const bought = {}; grvs.forEach(g => { bought[g.supplier] = (bought[g.supplier] || 0) + 1; });
  return `<div class="card"><div class="page-head" style="margin:0 0 .5rem"><div><h2>Suppliers</h2><p class="sub">Who the shop buys from. Purchase orders go to them by WhatsApp or email.</p></div>
      <div class="btn-row"><button class="btn ghost" data-act="ss-sup-load" title="Add the vendors on the shop’s products as suppliers">Load from Shopify</button><button class="btn primary" data-act="ss-sup-new">＋ Supplier</button></div></div>
    ${suppliers.length ? `<table class="tbl"><thead><tr><th>Supplier</th><th>Contact</th><th class="r">Deliveries</th><th></th></tr></thead><tbody>${suppliers.map(sp => `<tr><td><strong>${esc(sp.name)}</strong>${sp.notes ? '<div class="muted">' + esc(sp.notes) + '</div>' : ''}</td><td>${esc([sp.phone, sp.email, sp.account ? 'acc ' + sp.account : ''].filter(Boolean).join(' · '))}</td><td class="r">${bought[sp.name] || 0}</td><td class="r nowrap"><button class="btn ghost sm" data-act="ss-sup-edit" data-id="${esc(sp.id)}">Edit</button> <button class="btn ghost sm" data-act="ss-po-for" data-supplier="${esc(sp.name)}">Order stock</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No suppliers yet. Add one, or load them from the shop’s products.</p>'}
  </div>`;
}

// -------------------------------------------------------- purchase orders ---

// How many of a product sold in the last `days` days, per day.
function velocity(variantId, days) {
  const since = Date.now() - days * 86400000; let units = 0;
  salesRef().forEach(s => { if (Date.parse(s.createdAt || '') >= since) (s.lines || []).forEach(l => { if (l.variantId === variantId) units += Number(l.qty) || 0; }); });
  return units / days;
}
export const suggestedLevel = (variantId) => Math.ceil(velocity(variantId, 30) * 14);     // two weeks' cover
export const reorderLevel = (variantId) => { const p = shopProds[variantId]; return p && p.reorderLevel != null ? Number(p.reorderLevel) : suggestedLevel(variantId); };
// what open sales orders (laybys not collected) still need of each product
function openDemand() {
  const d = {};
  salesRef().forEach(s => { if (s.kind === 'layby' && !s.collectedAt && s.status !== 'cancelled') (s.lines || []).forEach(l => { if (l.variantId) d[l.variantId] = (d[l.variantId] || 0) + (Number(l.qty) || 0); }); });
  return d;
}
function onOrder() {
  const d = {};
  pos.filter(p => p.status === 'sent' || p.status === 'part').forEach(p => (p.lines || []).forEach(l => { const out = (Number(l.qty) || 0) - (Number(l.received) || 0); if (out > 0) d[l.variantId] = (d[l.variantId] || 0) + out; }));
  return d;
}
export function suggestions() {
  const demand = openDemand(), ordered = onOrder();
  return till.shopItems().filter(i => i.tracked).map(i => {
    const level = reorderLevel(i.variantId), need = demand[i.variantId] || 0, coming = ordered[i.variantId] || 0, onHand = Number(i.qty) || 0;
    return { i, level, need, coming, onHand, rec: Math.max(0, level + need - onHand - coming), supplier: i.vendor || '(no supplier)' };
  }).filter(r => r.rec > 0 || r.need > 0);
}
async function setLevel(variantId, level, name) {
  const v = Math.max(0, Math.round(Number(level) || 0));
  if (shopProds[variantId]) await store.update('shopProducts', variantId, { reorderLevel: v });
  else await store.createWithId('shopProducts', variantId, { reorderLevel: v, name: name || '', quickKey: false });
}
function startPo(supplierName, lines) {
  const sp = supplierByName(supplierName);
  poDraft = { supplierId: sp ? sp.id : '', supplier: supplierName || '', lines: (lines || []).map(l => ({ ...l })), notes: '' };
  view = 'order'; rerender();
}
function poAddLine(it, qty) {
  if (!poDraft) return;
  const had = poDraft.lines.find(l => l.variantId === it.variantId);
  if (had) had.qty += qty || 1;
  else poDraft.lines.push({ variantId: it.variantId, inventoryItemId: it.inventoryItemId, name: it.name, sku: it.sku || '', qty: qty || 1, cost: costOfShopItem(it.variantId), received: 0 });
}
function poSearch(q) {
  const t = String(q || '').trim().toLowerCase(); if (!t) return;
  const hits = till.shopItems().filter(i => [i.name, i.sku, i.barcode].some(v => String(v || '').toLowerCase().includes(t)));
  if (hits.length === 1) { poAddLine(hits[0]); rerender(); return; }
  if (!hits.length) { toast('Nothing in the shop matches', 'warn'); return; }
  const m = openModal('Which product?', `<div class="pk-list">${hits.slice(0, 30).map(i => `<button type="button" class="pk-row" data-v="${esc(i.variantId)}"><strong>${esc(i.name)}</strong><span>${esc([i.sku, i.vendor].filter(Boolean).join(' · '))} · ${esc(i.qty)} in stock</span></button>`).join('')}</div>`, { okLabel: 'Close' });
  m.wrap.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { poAddLine(till.shopItem(b.dataset.v)); m.close(); rerender(); }));
}
const poTotal = (p) => r2((p.lines || []).reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0));
async function savePo() {
  if (!poDraft) return;
  if (!poDraft.supplier.trim()) { toast('Who is the order for?', 'warn'); return null; }
  const lines = poDraft.lines.filter(l => Number(l.qty) > 0).map(l => ({ ...l, qty: Math.round(Number(l.qty)), cost: r2(l.cost) }));
  if (!lines.length) { toast('Add at least one product', 'warn'); return null; }
  let sp = supplierByName(poDraft.supplier);
  if (!sp) { const id = await store.create('suppliers', { name: poDraft.supplier.trim(), phone: '', email: '', account: '', notes: '' }); sp = { id, name: poDraft.supplier.trim() }; }
  const n = await store.nextNumber('shopPoNo', 1);
  const no = 'PO-' + String(n).padStart(4, '0');
  const id = await store.create('shopPos', { no, supplierId: sp.id, supplier: sp.name, lines, total: poTotal({ lines }), status: 'draft', notes: poDraft.notes || '', by: till.ringer() });
  poDraft = null;
  return id;
}
function poText(p) {
  return 'Hi ' + (p.supplier || '') + ', purchase order ' + p.no + ' from ' + (settings.name || '') + ':\n'
    + (p.lines || []).map(l => '• ' + l.qty + ' × ' + l.name + (l.sku ? ' (' + l.sku + ')' : '')).join('\n')
    + (p.notes ? '\n' + p.notes : '')
    + '\nPlease quote ' + p.no + ' on your invoice. Thank you, ' + till.ringer() + (settings.phone ? ' (' + settings.phone + ')' : '');
}
function sendPo(id) {
  const p = pos.find(x => x.id === id); if (!p) return;
  const sp = suppliers.find(x => x.id === p.supplierId) || {};
  const phone = waDigits(sp.phone);
  const m = openModal('Send ' + p.no, `<p>Send the order to <strong>${esc(p.supplier)}</strong>. The message is written for you; check it and press send.</p>
    <pre class="po-msg">${esc(poText(p))}</pre>
    <div class="btn-row"><button class="btn primary" id="sp-wa">WhatsApp${phone ? '' : ' (pick the chat)'}</button>${sp.email ? '<button class="btn ghost" id="sp-mail">Email</button>' : ''}<button class="btn ghost" id="sp-print">Print / PDF</button></div>
    <p class="muted">Once it has gone, tap <strong>Mark as sent</strong>: the stock then counts as on order.</p>`, {
    okLabel: p.status === 'draft' ? 'Mark as sent' : 'Done',
    onOk: async () => { if (p.status === 'draft') { await store.update('shopPos', id, { status: 'sent', sentAt: store.nowIso() }); toast(p.no + ' sent · on order'); } }
  });
  m.wrap.querySelector('#sp-wa').addEventListener('click', () => window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(poText(p)), '_blank'));
  const mail = m.wrap.querySelector('#sp-mail'); if (mail) mail.addEventListener('click', () => window.open('mailto:' + encodeURIComponent(sp.email) + '?subject=' + encodeURIComponent('Purchase order ' + p.no + ' from ' + (settings.name || '')) + '&body=' + encodeURIComponent(poText(p)), '_blank'));
  m.wrap.querySelector('#sp-print').addEventListener('click', () => printPo(id));
}
function printPo(id) {
  const p = pos.find(x => x.id === id); if (!p) return;
  const c = cur(), sp = suppliers.find(x => x.id === p.supplierId) || {};
  openPrint(p.no, `${docHeader(settings, 'PURCHASE ORDER', p.no, ['Date ' + niceDate(String(p.createdAt || today()).slice(0, 10))])}
    <div class="two"><div class="box"><h4>Supplier</h4><strong>${esc(p.supplier)}</strong>${sp.phone ? '<br>' + esc(sp.phone) : ''}${sp.email ? '<br>' + esc(sp.email) : ''}${sp.account ? '<br>Our account ' + esc(sp.account) : ''}</div>
      <div class="box"><h4>Deliver to</h4><strong>${esc(settings.name || '')}</strong><br>${esc(settings.address || '').replace(/\n/g, '<br>')}</div></div>
    <table><tr><th>Product</th><th>SKU</th><th class="r">Qty</th><th class="r">Each excl. VAT</th><th class="r">Amount</th></tr>${(p.lines || []).map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.sku || '')}</td><td class="r">${esc(l.qty)}</td><td class="r">${esc(money(l.cost, c))}</td><td class="r">${esc(money(l.qty * l.cost, c))}</td></tr>`).join('')}
      <tr class="tot big"><td colspan="4" class="r">TOTAL excl. VAT</td><td class="r">${esc(money(p.total, c))}</td></tr></table>
    ${p.notes ? `<p>${esc(p.notes)}</p>` : ''}<div class="ft">Please quote ${esc(p.no)} on your delivery note and invoice.</div>`);
}
// Receive a sent order: its outstanding lines go into the delivery, to fix up and book in.
function receivePo(id) {
  const p = pos.find(x => x.id === id); if (!p) return;
  if (draft.lines.length && !confirm('There is an unfinished delivery on the screen. Replace it with ' + p.no + '?')) return;
  const sp = suppliers.find(x => x.id === p.supplierId) || {};
  draft = { supplier: p.supplier, ref: '', date: today(), unmatched: [], poId: p.id,
    lines: (p.lines || []).map(l => ({ variantId: l.variantId, inventoryItemId: l.inventoryItemId, name: l.name, sku: l.sku || '', barcode: (till.shopItem(l.variantId) || {}).barcode || '', qty: Math.max(0, (Number(l.qty) || 0) - (Number(l.received) || 0)), cost: Number(l.cost) || 0, price: (till.shopItem(l.variantId) || {}).price })).filter(l => l.qty > 0) };
  persistDraft(); view = 'receive'; rerender();
  toast('Receiving ' + p.no + ' from ' + (sp.name || p.supplier));
}
function orderHtml() {
  const c = cur(), seesCost = store.can('costing') || store.can('stock');
  if (poDraft) {
    const total = poTotal(poDraft);
    return `<div class="card"><h2>Purchase order</h2>
      ${row(field('Supplier', 'po-sup', { value: poDraft.supplier, placeholder: 'Who to order from', list: 'po-sup-list' }), '<div class="fld"><span>Add a product</span><input id="po-find" placeholder="Search the shop and press Enter…" autocomplete="off"></div>')}
      <datalist id="po-sup-list">${suppliers.map(s => `<option value="${esc(s.name)}"></option>`).join('')}</datalist>
      ${poDraft.lines.length ? `<div style="overflow:auto"><table class="tbl ss-po"><thead><tr><th>Product</th><th class="r">Qty</th>${seesCost ? '<th class="r">Cost each</th><th class="r">Amount</th>' : ''}<th></th></tr></thead><tbody>${poDraft.lines.map((l, i) => `<tr><td><strong>${esc(l.name)}</strong><div class="muted">${esc(l.sku || '')}</div></td><td class="r"><input class="po-in" data-f="qty" data-i="${i}" type="number" min="1" step="1" value="${esc(l.qty)}" style="width:80px"></td>${seesCost ? `<td class="r"><input class="po-in" data-f="cost" data-i="${i}" type="number" min="0" step="0.01" value="${esc(l.cost || '')}" style="width:110px"></td><td class="r">${esc(money(l.qty * l.cost, c))}</td>` : ''}<td class="r"><button class="icon-btn" data-act="ss-po-remove" data-i="${i}" title="Remove">✕</button></td></tr>`).join('')}</tbody></table></div>
      <p class="muted">${poDraft.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0)} pieces${seesCost ? ' · ' + esc(money(total, c)) + ' excl. VAT' : ''}</p>` : '<p class="muted">Search for the products to order.</p>'}
      ${field('Note to the supplier', 'po-notes', { value: poDraft.notes, placeholder: 'Delivery address, urgency…' })}
      <div class="card-actions"><button class="btn ghost" data-act="ss-po-cancel">Cancel</button><button class="btn ghost" data-act="ss-po-save">Save draft</button><button class="btn primary" data-act="ss-po-send-new">Save and send</button></div></div>`;
  }
  const sug = suggestions();
  const groups = {}; sug.forEach(r => { (groups[r.supplier] = groups[r.supplier] || []).push(r); });
  const open = pos.filter(p => p.status !== 'received' && p.status !== 'cancelled'), done = pos.filter(p => p.status === 'received' || p.status === 'cancelled');
  const chip = (p) => p.status === 'draft' ? '<span class="chip">draft</span>' : p.status === 'sent' ? '<span class="chip calm">sent · on order</span>' : p.status === 'part' ? '<span class="chip late">part received</span>' : p.status === 'received' ? '<span class="chip calm">received</span>' : '<span class="chip">cancelled</span>';
  const poRow = (p) => `<tr><td><strong>${esc(p.no)}</strong><div class="muted">${esc(niceDate(String(p.createdAt || '').slice(0, 10)))} · ${esc(p.by || '')}</div></td><td>${esc(p.supplier)}</td><td class="r">${(p.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0)}${p.status === 'part' ? ' <span class="muted">(' + (p.lines || []).reduce((a, l) => a + (Number(l.received) || 0), 0) + ' in)</span>' : ''}</td>${seesCost ? `<td class="r">${esc(money(p.total, c))}</td>` : ''}<td>${chip(p)}</td>
    <td class="r nowrap">${p.status === 'draft' ? `<button class="btn primary sm" data-act="ss-po-send" data-id="${esc(p.id)}">Send</button> <button class="btn ghost sm" data-act="ss-po-cancel-po" data-id="${esc(p.id)}">Cancel</button>` : ''}${p.status === 'sent' || p.status === 'part' ? `<button class="btn primary sm" data-act="ss-po-receive" data-id="${esc(p.id)}">Receive</button> <button class="btn ghost sm" data-act="ss-po-send" data-id="${esc(p.id)}">Send again</button>` : ''} <button class="btn ghost sm" data-act="ss-po-print" data-id="${esc(p.id)}">Print</button></td></tr>`;
  return `<div class="card"><div class="page-head" style="margin:0 0 .5rem"><div><h2>What to order</h2><p class="sub">The reorder level comes from the last 30 days’ sales (two weeks’ cover; change it per product), plus what open sales orders need, less what is on hand and already on order.</p></div>
      <div class="btn-row"><button class="btn primary" data-act="ss-po-new">＋ Purchase order</button></div></div>
    ${Object.keys(groups).length ? Object.keys(groups).sort().map(sup => `<h3 style="margin:.8rem 0 .3rem">${esc(sup)} <button class="btn primary sm" data-act="ss-po-for" data-supplier="${esc(sup)}" style="margin-left:.5rem">Create PO · ${groups[sup].reduce((a, r) => a + r.rec, 0)} pieces</button></h3>
      <table class="tbl"><thead><tr><th>Product</th><th class="r">On hand</th><th class="r">On order</th><th class="r">Sales orders need</th><th class="r">Reorder level</th><th class="r">Order</th></tr></thead><tbody>${groups[sup].map(r => `<tr><td><strong>${esc(r.i.name)}</strong><div class="muted">${esc(r.i.sku || '')}</div></td><td class="r">${r.onHand}</td><td class="r">${r.coming || ''}</td><td class="r">${r.need || ''}</td><td class="r"><input class="ss-level" data-v="${esc(r.i.variantId)}" data-name="${esc(r.i.name)}" type="number" min="0" step="1" value="${r.level}" style="width:70px; text-align:right" title="Suggested: ${suggestedLevel(r.i.variantId)}"></td><td class="r"><strong>${r.rec}</strong></td></tr>`).join('')}</tbody></table>`).join('')
      : '<p class="muted">Nothing to order: everything is above its reorder level and no sales orders are waiting.</p>'}
  </div>
  <div class="card" style="padding:0; overflow:auto"><table class="tbl"><thead><tr><th>Order</th><th>Supplier</th><th class="r">Pieces</th>${seesCost ? '<th class="r">Total</th>' : ''}<th>Status</th><th></th></tr></thead><tbody>${open.length || done.length ? [...open, ...done.slice(0, 50)].map(poRow).join('') : '<tr><td colspan="6" class="muted">No purchase orders yet.</td></tr>'}</tbody></table></div>`;
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

// ------------------------------------------------------------- catalogue ---

// The shop's products in one table: price, cost price and margin, reorder
// level, quick key, label copies. Cost prices are the manager's business, so
// a cashier sees the page without them.
let catQ = '', catMissing = false; const catEdits = {}, catLabels = {};
const seesCosts = () => !till.usesPins() || till.isManager(till.tillUser());
function catalogueHtml() {
  const items = till.shopItems();
  const missing = items.filter(i => !(costOfShopItem(i.variantId) > 0)).length;
  return `<div class="card"><h2>Catalogue</h2><p class="muted">${items.length} products from the online shop. ${seesCosts() ? 'Type a cost price or a reorder level and tap Save; the margin is worked out on the price incl. VAT.' : 'Prices come from the shop; cost prices are for managers.'}</p>
    <div class="toolbar" style="margin-bottom:.5rem"><input id="ct-q" class="search" placeholder="Search by name, SKU, barcode, category or supplier…" value="${esc(catQ)}" autocomplete="off">${seesCosts() ? `<button class="btn ${catMissing ? 'primary' : 'ghost'} sm" data-act="ss-cat-missing">${missing} without a cost</button>` : ''}</div>
    <div id="ct-rows" style="overflow:auto"></div>
    <div class="card-actions">${seesCosts() ? '<button class="btn primary" data-act="ss-cat-save">Save</button>' : ''}<button class="btn ghost" data-act="ss-cat-labels">Print the labels ticked</button></div></div>`;
}
function drawCatalogueRows(h) {
  const box = h.querySelector('#ct-rows'); if (!box) return;
  const q = catQ.trim().toLowerCase();
  let rows = till.shopItems().filter(i => !q || [i.name, i.sku, i.barcode, i.category, i.vendor, ...(i.collections || [])].some(v => String(v || '').toLowerCase().includes(q)));
  if (catMissing) rows = rows.filter(i => !(costOfShopItem(i.variantId) > 0));
  rows = rows.sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 300);
  const c = cur(); const costs = seesCosts();
  box.innerHTML = rows.length ? `<table class="tbl"><thead><tr><th></th><th>Product</th><th>Category</th><th class="r">Stock</th><th class="r">Price</th>${costs ? '<th class="r">Cost</th><th class="r">Margin</th><th class="r">Reorder at</th>' : ''}<th class="r">Labels</th></tr></thead><tbody>${rows.map(i => {
    const e = catEdits[i.variantId] || {}; const cost = e.cost != null ? e.cost : costOfShopItem(i.variantId); const lvl = e.reorderLevel != null ? e.reorderLevel : (shopProds[i.variantId] && shopProds[i.variantId].reorderLevel);
    const margin = cost > 0 && i.price > 0 ? Math.round((1 - cost / i.price) * 100) : null;
    return `<tr><td><button class="icon-btn" data-act="ss-cat-star" data-v="${esc(i.variantId)}" data-name="${esc(i.name)}" title="Quick key">${isQuickKey(i.variantId) ? '⭐' : '☆'}</button></td>
      <td><strong>${esc(i.name)}</strong><div class="muted">${esc(i.sku || '')}${i.barcode ? ' · ' + esc(i.barcode) : ''}${i.vendor ? ' · ' + esc(i.vendor) : ''}</div></td><td>${esc((i.collections && i.collections.length ? i.collections : [i.category]).filter(Boolean).join(', '))}</td>
      <td class="r">${i.tracked ? esc(i.qty) : '—'}</td><td class="r">${esc(money(i.price, c))}</td>
      ${costs ? `<td class="r"><input class="ct-in" data-v="${esc(i.variantId)}" data-f="cost" type="number" min="0" step="0.01" value="${cost > 0 ? esc(cost) : ''}" style="width:90px"></td><td class="r">${margin == null ? '—' : margin + '%'}</td><td class="r"><input class="ct-in" data-v="${esc(i.variantId)}" data-f="reorderLevel" type="number" min="0" step="1" value="${lvl > 0 ? esc(lvl) : ''}" style="width:70px"></td>` : ''}
      <td class="r"><input class="ct-lb" data-v="${esc(i.variantId)}" type="number" min="0" step="1" value="${esc(catLabels[i.variantId] || '')}" placeholder="0" style="width:60px"></td></tr>`; }).join('')}</tbody></table>` : '<div class="muted" style="padding:.6rem">No match</div>';
  box.querySelectorAll('.ct-in').forEach(inp => inp.addEventListener('input', () => { const v = inp.value === '' ? 0 : Math.max(0, parseFloat(inp.value) || 0); catEdits[inp.dataset.v] = { ...(catEdits[inp.dataset.v] || {}), [inp.dataset.f]: inp.dataset.f === 'cost' ? r2(v) : Math.round(v) }; }));
  box.querySelectorAll('.ct-lb').forEach(inp => inp.addEventListener('input', () => { catLabels[inp.dataset.v] = parseInt(inp.value, 10) || 0; }));
}
async function saveCatalogueEdits() {
  const keys = Object.keys(catEdits);
  if (!keys.length) { toast('Nothing changed', 'warn'); return; }
  for (const v of keys) {
    const e = catEdits[v]; const it = till.shopItem(v); const patch = {};
    if (e.cost != null) { patch.cost = e.cost; patch.costAt = today(); }
    if (e.reorderLevel != null) patch.reorderLevel = e.reorderLevel;
    if (shopProds[v]) await store.update('shopProducts', v, patch); else await store.createWithId('shopProducts', v, { ...patch, name: it ? it.name : '', quickKey: false });
    delete catEdits[v];
  }
  toast(keys.length + ' product' + (keys.length === 1 ? '' : 's') + ' saved');
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
  salesRef = () => sales || [];
  h.innerHTML = `<div class="btn-row" style="margin-bottom:.8rem">${tab('receive', 'Receive stock')}${tab('order', 'Order stock')}${tab('suppliers', 'Suppliers')}${tab('take', 'Stock take')}${tab('catalogue', 'Catalogue')}${tab('labels', 'Labels')}</div>` + (view === 'take' ? takeHtml() : view === 'labels' ? labelsHtml() : view === 'order' ? orderHtml() : view === 'suppliers' ? suppliersHtml() : view === 'catalogue' ? catalogueHtml() : receiveHtml());
  const cq = h.querySelector('#ct-q'); if (cq) { cq.addEventListener('input', () => { catQ = cq.value; drawCatalogueRows(h); }); drawCatalogueRows(h); }
  const pf = h.querySelector('#po-find');
  if (pf) { pf.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = pf.value.trim(); const it = matchItem(v, ''); if (it) { poAddLine(it); rerender(); } else poSearch(v); } }); setTimeout(() => pf.focus(), 50); }
  const ps = h.querySelector('#po-sup'); if (ps) ps.addEventListener('input', () => { poDraft.supplier = ps.value; });
  const pn = h.querySelector('#po-notes'); if (pn) pn.addEventListener('input', () => { poDraft.notes = pn.value; });
  h.querySelectorAll('.po-in').forEach(i => i.addEventListener('input', () => { const l = poDraft && poDraft.lines[parseInt(i.dataset.i, 10)]; if (!l) return; l[i.dataset.f] = i.dataset.f === 'qty' ? Math.max(1, parseInt(i.value, 10) || 1) : r2(parseFloat(i.value) || 0); }));
  h.querySelectorAll('.ss-level').forEach(i => i.addEventListener('change', () => setLevel(i.dataset.v, i.value, i.dataset.name)));
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
    case 'ss-clear': if (confirm('Clear this delivery?')) { draft = { supplier: '', ref: '', date: '', lines: [], unmatched: [], poId: '' }; persistDraft(); rerender(); } return;
    case 'ss-book': return bookIn();
    case 'ss-send': return sendGrv(el.dataset.id);
    case 'ss-print-grv': return printGrv(el.dataset.id);
    case 'ss-labels-grv': { const g = grvs.find(x => x.id === el.dataset.id); if (g) printLabels((g.lines || []).map(l => ({ i: { name: l.name, price: l.price, barcode: l.barcode, sku: l.sku }, copies: l.qty }))); return; }
    case 'ss-labels-print': return printLabels(till.shopItems().map(x => ({ i: x, copies: labelPicks[x.variantId] || 0 })));
    case 'ss-cat-save': return saveCatalogueEdits();
    case 'ss-cat-missing': catMissing = !catMissing; return rerender();
    case 'ss-cat-star': return toggleQuickKey(el.dataset.v, el.dataset.name);
    case 'ss-cat-labels': return printLabels(Object.keys(catLabels).map(v => ({ i: till.shopItem(v) || { name: '', price: 0, barcode: '', sku: '' }, copies: catLabels[v] || 0 })));
    case 'ss-sup-new': return editSupplier('');
    case 'ss-sup-edit': return editSupplier(el.dataset.id);
    case 'ss-sup-load': return loadSuppliersFromShop();
    case 'ss-po-new': return startPo('', []);
    case 'ss-po-for': return startPo(el.dataset.supplier, suggestions().filter(r => r.supplier === el.dataset.supplier && r.rec > 0).map(r => ({ variantId: r.i.variantId, inventoryItemId: r.i.inventoryItemId, name: r.i.name, sku: r.i.sku || '', qty: r.rec, cost: costOfShopItem(r.i.variantId), received: 0 })));
    case 'ss-po-remove': if (poDraft) poDraft.lines.splice(i, 1); return rerender();
    case 'ss-po-cancel': poDraft = null; return rerender();
    case 'ss-po-save': { const id = await savePo(); if (id) { toast('Saved as a draft'); rerender(); } return; }
    case 'ss-po-send-new': { const id = await savePo(); if (id) { rerender(); setTimeout(() => sendPo(id), 200); } return; }
    case 'ss-po-send': return sendPo(el.dataset.id);
    case 'ss-po-print': return printPo(el.dataset.id);
    case 'ss-po-receive': return receivePo(el.dataset.id);
    case 'ss-po-cancel-po': { const p = pos.find(x => x.id === el.dataset.id); if (p && confirm('Cancel ' + p.no + '?')) await store.update('shopPos', p.id, { status: 'cancelled' }); return; }
    case 'ss-take-start': await startTake(el.dataset.scope); return;
    case 'ss-take-scan': return openBarcodeCamera((code) => { takeScanCode(code); });
    case 'ss-take-cancel': { const t = openTake(); if (t && confirm('Cancel this count? Nothing is changed on the shop.')) await store.update('stockTakes', t.id, { status: 'cancelled' }); return; }
    case 'ss-take-done': return reconcile();
    case 'ss-count': await countOne(el.dataset.v, parseInt(el.dataset.d, 10)); return;
  }
}
