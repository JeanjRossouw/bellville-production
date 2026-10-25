// Retail POS — the Buying tab (supervisors and up): suppliers, purchase
// orders (drafted by a manager, suggested from low stock, sent as a link to
// a printable A4 page by email or WhatsApp), receiving against a PO or
// direct with landed costs and labels for what came in, and transfers
// between stores. The server (pos-buy) numbers, moves stock and keeps the
// on-order figures; suppliers and PO drafts are written straight to Firestore.
import { API } from './config.js';
import * as auth from './auth.js';
import { setOne, patchOne, newId } from './db.js';
import { esc, toast, field, row, val, openModal, openPrint, money, niceDate, niceTime, empty } from './ui.js';
import { centsOf, randsOf } from './money.js';
import { A4_CSS, whatsappUrl, mailtoUrl } from './receipt.js';
import { poHtml, grvHtml, transferHtml } from './buying-doc.js';
import { printLabelItems } from './products.js';
import { items as stockItems } from './stock.js';
import { icon } from './icons.js';
import { parseCsv, csvObjects } from './csv.js';

export const by = { sub: 'po', q: '', filter: 'open', edit: null, rcv: null, tr: null };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();   // { store, entity, settings, stores, products, variants, stockLevels, suppliers, pos, grvs, transfers }
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const today = () => new Date().toISOString().slice(0, 10);
const mkId = (p) => p + '-' + (auth.deviceId() || 'web') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const STATUS = { draft: ['Draft', ''], sent: ['Sent', 'prod'], part: ['Part received', 'prod'], received: ['Received', 'ok'], cancelled: ['Cancelled', 'off'], inTransit: ['In transit', 'prod'] };
const chip = (s) => `<span class="chip ${(STATUS[s] || ['', ''])[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
const suppliers = () => (d().suppliers || []).filter(s => s.entityId === d().entity.id && !s.archived).sort((a, b) => a.name.localeCompare(b.name));
const supplierName = (id) => ((d().suppliers || []).find(s => s.id === id) || {}).name || '';
const stockOf = () => stockItems(d());
const subHtml = () => `<div class="subnav">${[['po', 'Purchase orders'], ['receive', 'Receive'], ['transfers', 'Transfers'], ['suppliers', 'Suppliers']].map(x => `<button class="subtab${by.sub === x[0] ? ' on' : ''}" data-act="by-sub" data-to="${x[0]}">${x[1]}</button>`).join('')}</div>`;
const mgr = () => auth.atLeast('manager');

// ----------------------------------------------------------------- html --
export function buyingHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Buying</h1></div><div class="card muted">Pick a store first.</div>`;
  const head = `<div class="page-head"><h1>Buying · ${esc(dd.store.name)}</h1></div>` + subHtml();
  if (by.sub === 'suppliers') return head + suppliersHtml(dd);
  if (by.sub === 'receive') return head + receiveHtml(dd);
  if (by.sub === 'transfers') return head + transfersHtml(dd);
  return head + (by.edit ? poEditHtml(dd) : poListHtml(dd));
}

// ------------------------------------------------------- suppliers --
function suppliersHtml(dd) {
  const list = suppliers();
  return `<div class="toolbar">${mgr() ? `<button class="btn primary sm" data-act="by-sup-new">${icon('plus')} New supplier</button><button class="btn sm" data-act="by-sup-import" title="A CSV with a Name column (and Phone, Email, Contact, Account no, Terms, Lead, Notes, Owing if you have them), e.g. the old ReptiCube POS's download">Import CSV</button>` : ''}</div>
    ${list.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Supplier</th><th>Contact</th><th>Terms</th><th>Lead</th><th>Products</th><th></th></tr></thead><tbody>${list.map(s => `<tr><td><strong>${esc(s.name)}</strong>${s.accountNo ? `<div class="muted">Account ${esc(s.accountNo)}</div>` : ''}${s.openingOwedCents ? `<div class="muted">Owed when moved over: ${esc(money(s.openingOwedCents))}</div>` : ''}</td><td>${esc(s.contact || '')}<div class="muted">${esc([s.phone, s.email].filter(Boolean).join(' · '))}</div></td><td>${s.termsDays ? s.termsDays + ' days' : '—'}</td><td>${s.leadDays ? s.leadDays + ' days' : '—'}</td><td>${(dd.products || []).filter(p => p.supplierId === s.id && !p.archived).length}</td><td class="r">${mgr() ? `<button class="btn ghost sm" data-act="by-sup-edit" data-id="${esc(s.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No suppliers yet', 'Add the people you buy from; products carry a supplier so orders can be suggested.')}`;
}
function supplierForm(id) {
  const s = (d().suppliers || []).find(x => x.id === id) || {};
  openModal(id ? 'Edit ' + s.name : 'New supplier', row(field('Name', 'su-name', { value: s.name }), field('Contact person', 'su-contact', { value: s.contact })) + row(field('Phone', 'su-phone', { value: s.phone, inputmode: 'tel' }), field('Email', 'su-email', { value: s.email, type: 'email' })) + row(field('Our account no', 'su-acc', { value: s.accountNo }), field('Payment terms (days)', 'su-terms', { value: s.termsDays, type: 'number', min: 0 })) + row(field('Lead time (days)', 'su-lead', { value: s.leadDays, type: 'number', min: 0 }), field('Notes', 'su-notes', { value: s.notes })) + (id ? `<label class="chk"><input type="checkbox" id="su-arch"${s.archived ? ' checked' : ''}> Archived (no longer buying from them)</label>` : ''), {
    okLabel: 'Save', onOk: async (w) => {
      const name = val(w, 'su-name'); if (!name) { toast('A name.', 'warn'); return false; }
      const body = { name, contact: val(w, 'su-contact'), phone: val(w, 'su-phone'), email: val(w, 'su-email'), accountNo: val(w, 'su-acc'), termsDays: Number(val(w, 'su-terms')) || 0, leadDays: Number(val(w, 'su-lead')) || 0, notes: val(w, 'su-notes'), archived: id ? !!w.querySelector('#su-arch').checked : false };
      try { if (id) await patchOne('suppliers', id, { ...body, ...auth.touch() }); else await setOne('suppliers', newId('suppliers'), { ...body, ...auth.stamp(d().entity.id, '') }); toast('Saved ' + name); return true; }
      catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
    }
  });
}

// Suppliers from a CSV (a spreadsheet, or the old ReptiCube POS's "Download
// for the new POS"): new names are added to this company; ones already here
// keep what they have and only get the details they were missing. What was
// still owed in the old system is kept on the supplier, as a note of the
// opening balance (it is paid and settled outside the till, e.g. in Xero).
const COLS = { name: ['name', 'supplier', 'supplier name', 'vendor'], phone: ['phone', 'tel', 'telephone', 'cell', 'mobile'], email: ['email', 'e-mail'], contact: ['contact', 'contact person'],
  accountNo: ['account no', 'account', 'account number', 'our account no'], termsDays: ['terms', 'terms days', 'payment terms', 'payment terms (days)'], leadDays: ['lead', 'lead days', 'lead time', 'lead time (days)'],
  notes: ['notes', 'note'], owing: ['owing', 'owed', 'balance', 'amount owed'], unpaid: ['unpaid grvs', 'unpaid'] };
function readSupplierCsv(text) {
  const rows = csvObjects(parseCsv(text));
  const pick = (r, k) => { const key = Object.keys(r).find(h => COLS[k].includes(h.trim().toLowerCase())); return key ? String(r[key] || '').trim() : ''; };
  return rows.map(r => ({ name: pick(r, 'name'), phone: pick(r, 'phone'), email: pick(r, 'email'), contact: pick(r, 'contact'), accountNo: pick(r, 'accountNo'),
    termsDays: Number(pick(r, 'termsDays')) || 0, leadDays: Number(pick(r, 'leadDays')) || 0, notes: pick(r, 'notes'),
    owedCents: Math.max(0, centsOf(pick(r, 'owing'))), unpaid: pick(r, 'unpaid') })).filter(x => x.name);
}
function importSuppliers() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,text/csv';
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0]; if (!f) return;
    let rows; try { rows = readSupplierCsv(await f.text()); } catch (e) { return toast('Could not read that file: ' + e.message, 'warn'); }
    if (!rows.length) return toast('No suppliers in that file: it needs a column called Name.', 'warn');
    const here = (d().suppliers || []).filter(s => s.entityId === d().entity.id);
    const byName = (n) => here.find(s => String(s.name || '').trim().toLowerCase() === n.toLowerCase());
    const plan = rows.map(r => {
      const s = byName(r.name);
      if (!s) return { r, kind: 'new' };
      const fill = {}; ['phone', 'email', 'contact', 'accountNo'].forEach(k => { if (r[k] && !s[k]) fill[k] = r[k]; });
      if (r.termsDays && !s.termsDays) fill.termsDays = r.termsDays;
      if (r.leadDays && !s.leadDays) fill.leadDays = r.leadDays;
      if (r.owedCents && !s.openingOwedCents) fill.openingOwedCents = r.owedCents;
      return { r, s, kind: Object.keys(fill).length ? 'fill' : 'same', fill };
    });
    const n = (k) => plan.filter(x => x.kind === k).length;
    const owed = rows.reduce((t, r) => t + r.owedCents, 0);
    openModal('Import suppliers into ' + (d().entity.tradingName || d().entity.legalName || ''), `
      <p>${rows.length} in the file: <strong>${n('new')} new</strong>, ${n('fill')} already here get missing details, ${n('same')} already here unchanged.${owed ? ` Owed in total when moved over: <strong>${esc(money(owed))}</strong> (kept on each supplier as its opening balance).` : ''}</p>
      <div class="card" style="padding:0;max-height:50vh;overflow:auto"><table class="tbl"><thead><tr><th>Supplier</th><th>Contact</th><th class="r">Owing</th><th></th></tr></thead><tbody>
      ${plan.map(x => `<tr><td><strong>${esc(x.r.name)}</strong>${x.r.unpaid ? `<div class="muted">${esc(x.r.unpaid)}</div>` : ''}</td><td class="muted">${esc([x.r.phone, x.r.email].filter(Boolean).join(' · '))}</td><td class="r">${x.r.owedCents ? esc(money(x.r.owedCents)) : ''}</td><td>${x.kind === 'new' ? '<span class="chip ok">new</span>' : x.kind === 'fill' ? '<span class="chip">add details</span>' : '<span class="chip off">already here</span>'}</td></tr>`).join('')}</tbody></table></div>`, {
      okLabel: n('new') + n('fill') ? 'Import' : 'Close', onOk: async () => {
        let done = 0;
        try {
          for (const x of plan) {
            const owedNote = x.r.owedCents ? 'Owed ' + money(x.r.owedCents) + ' when moved over (' + niceDate(new Date().toISOString()) + ')' + (x.r.unpaid ? ': ' + x.r.unpaid : '') : '';
            if (x.kind === 'new') {
              await setOne('suppliers', newId('suppliers'), { name: x.r.name, contact: x.r.contact, phone: x.r.phone, email: x.r.email, accountNo: x.r.accountNo, termsDays: x.r.termsDays, leadDays: x.r.leadDays,
                notes: [x.r.notes, owedNote].filter(Boolean).join(' · '), archived: false, openingOwedCents: x.r.owedCents, ...auth.stamp(d().entity.id, '') });
              done++;
            } else if (x.kind === 'fill') {
              const notes = x.fill.openingOwedCents && owedNote ? [x.s.notes, owedNote].filter(Boolean).join(' · ') : undefined;
              await patchOne('suppliers', x.s.id, { ...x.fill, ...(notes !== undefined ? { notes } : {}), ...auth.touch() });
              done++;
            }
          }
        } catch (e) { toast('Stopped after ' + done + ': ' + e.message, 'warn'); return false; }
        toast(done ? done + ' supplier' + (done === 1 ? '' : 's') + ' imported' : 'Nothing to change');
        return true;
      }
    });
  });
  input.click();
}

// ------------------------------------------------- purchase orders --
const openPos = (dd) => (dd.pos || []).filter(p => p.storeId === dd.store.id);
function poListHtml(dd) {
  const all = openPos(dd).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const q = by.q.trim().toLowerCase();
  const rows = all.filter(p => (by.filter === 'all' || (by.filter === 'open' ? ['draft', 'sent', 'part'].includes(p.status) : p.status === by.filter)) && (!q || [p.docNo, p.supplierName, supplierName(p.supplierId), ...(p.lines || []).map(l => l.name)].some(x => String(x || '').toLowerCase().includes(q))));
  const low = stockOf().filter(x => x.low).length, short = mgr() ? forOpenOrders('').length : 0;
  return `<div class="toolbar"><input id="by-q" class="search" type="search" placeholder="Number, supplier, item" value="${esc(by.q)}">
      <select id="by-filter">${[['open', 'Open'], ['draft', 'Drafts'], ['sent', 'Sent'], ['part', 'Part received'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['all', 'All']].map(x => `<option value="${x[0]}"${by.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>
      ${mgr() ? `<button class="btn primary sm" data-act="by-po-new">${icon('plus')} New purchase order</button>${low ? `<button class="btn ghost sm" data-act="by-po-suggest">${icon('box')} Suggest from low stock (${low})</button>` : ''}${short ? `<button class="btn ghost sm" data-act="by-po-open" title="Only what open website orders and sales orders need that you do not have; reorder levels left out">${icon('box')} Order for open orders only (${short})</button>` : ''}` : ''}</div>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>No</th><th>Supplier</th><th>Lines</th><th>Expected</th><th class="r">Total</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(p => `<tr class="${/cancelled|received/.test(p.status) ? 'off' : ''}"><td><strong>${esc(p.docNo || 'Draft')}</strong><div class="muted">${esc(niceDate(p.sentAt || p.createdAt))}</div></td><td>${esc(p.supplierName || supplierName(p.supplierId))}</td><td>${(p.lines || []).length} · ${(p.lines || []).reduce((n, l) => n + (l.qty || 0), 0)} units${p.status === 'part' ? ` · ${(p.lines || []).reduce((n, l) => n + (l.receivedQty || 0), 0)} in` : ''}</td><td class="muted">${esc(niceDate(p.expectedAt))}</td><td class="r">${esc(money(p.totalCents || (p.lines || []).reduce((n, l) => n + l.qty * l.unitCostCents, 0)))}</td><td>${chip(p.status)}</td><td class="r nowrap">${p.status === 'draft' && mgr() ? `<button class="btn ghost sm" data-act="by-po-edit" data-id="${esc(p.id)}">Edit</button>` : ''}<button class="btn ghost sm" data-act="by-po-open" data-id="${esc(p.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>` : empty('No purchase orders', mgr() ? 'Start one, or let the low-stock list suggest it.' : '')}`;
}
function poEditHtml(dd) {
  const e = by.edit; const sups = suppliers();
  const sub = e.lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0);
  return `<div class="card"><h2>${e.id ? 'Purchase order (draft)' : 'New purchase order'}</h2>
    <div class="grid three">${field('Supplier', 'po-supplier', { type: 'select', value: e.supplierId, options: [{ value: '', label: 'Choose…' }, ...sups.map(s => ({ value: s.id, label: s.name }))] })}${field('Expected by', 'po-expected', { type: 'date', value: e.expectedAt })}${field('Note to the supplier', 'po-note', { value: e.note })}</div>
    <div class="tk-scanrow" style="margin:.4rem 0"><label class="pos-search-wrap" style="flex:1 1 260px">${icon('search')}<input id="po-add" class="pos-in" placeholder="Add an item: name, SKU or barcode" autocomplete="off"></label><button class="btn ghost sm" data-act="by-po-open-here" title="What open orders need of this supplier's items">${icon('box')} Open orders</button><button class="btn ghost sm" data-act="by-po-suggest-here">${icon('box')} Suggest from low stock</button></div>
    <div id="po-hits" class="pk-list"></div>
    ${e.lines.length ? `<table class="tbl po-lines"><thead><tr><th>Item</th><th class="r">Available</th><th class="r">On order</th><th class="r">Qty</th><th class="r">Unit cost (ex VAT)</th><th class="r">Total</th><th></th></tr></thead><tbody>${e.lines.map((l, i) => { const s = stockOf().find(x => x.itemId === l.itemId) || {}; return `<tr><td><strong>${esc(l.name)}</strong><div class="muted">${esc(l.sku || '')}</div></td><td class="r">${s.available == null ? '' : s.available}${s.reorderLevel != null ? ` <span class="muted">/ ${s.reorderLevel}</span>` : ''}</td><td class="r">${s.onOrder || ''}</td><td class="r"><input class="in-sm r" data-po-qty="${i}" type="number" min="1" value="${l.qty}" style="max-width:80px"></td><td class="r"><input class="in-sm r" data-po-cost="${i}" inputmode="decimal" value="${randsOf(l.unitCostCents)}" style="max-width:110px"></td><td class="r">${esc(money(l.qty * l.unitCostCents))}</td><td class="r"><button class="pos-icon-btn light" data-act="by-po-rm" data-i="${i}" title="Remove">${icon('x')}</button></td></tr>`; }).join('')}</tbody><tfoot><tr><td colspan="5" class="r"><strong>Subtotal (ex VAT)</strong></td><td class="r"><strong>${esc(money(sub))}</strong></td><td></td></tr></tfoot></table>` : '<p class="muted">No lines yet: add items above, or suggest them from low stock.</p>'}
    <div class="card-actions"><button class="btn" data-act="by-po-save">Save draft</button><button class="btn primary" data-act="by-po-send"${e.lines.length && e.supplierId ? '' : ' disabled'}>${icon('file')} Send to the supplier</button><button class="btn ghost" data-act="by-po-close">Back</button></div></div>`;
}
function newEdit(po) { return po ? { id: po.id, supplierId: po.supplierId || '', expectedAt: po.expectedAt || '', note: po.note || '', lines: (po.lines || []).map(l => ({ ...l })) } : { id: '', supplierId: '', expectedAt: '', note: '', lines: [] }; }
function readEdit() {
  const w = document.getElementById('screen'); const e = by.edit; if (!e || !w.querySelector('#po-supplier')) return e;
  e.supplierId = val(w, 'po-supplier'); e.expectedAt = val(w, 'po-expected'); e.note = val(w, 'po-note');
  w.querySelectorAll('[data-po-qty]').forEach(i => { const l = e.lines[Number(i.dataset.poQty)]; if (l) l.qty = Math.max(1, Math.round(Number(i.value) || 1)); });
  w.querySelectorAll('[data-po-cost]').forEach(i => { const l = e.lines[Number(i.dataset.poCost)]; if (l) l.unitCostCents = Math.max(0, centsOf(i.value)); });
  return e;
}
function addLine(it, qty) { const e = readEdit(); const had = e.lines.find(l => l.itemId === it.itemId); if (had) had.qty += qty || 1; else e.lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, sku: it.sku, name: it.name, barcode: it.barcodes ? it.barcodes[0] || '' : '', qty: qty || 1, unitCostCents: it.costCents || 0, receivedQty: 0 }); ctx.repaint(); }
// what open customer orders need and the shelf cannot give, reorder levels left out: website orders already
// hold their stock (available falls below nothing when they are short), sales orders (those brought in from
// Shopify too) take nothing until they go out, so their stock items count here; less what is on order
const OPEN_SO = ['quoted', 'depositPaid', 'inProduction', 'ready'];
const NONE = '__none';   // the items with no supplier set
export function forOpenOrders(supplierId) {
  const dd = d(), need = new Map(), why = new Map();
  for (const o of dd.specials || []) {
    if (!OPEN_SO.includes(o.status)) continue;
    for (const l of o.lines || []) {
      const p = l.productId && (dd.products || []).find(x => x.id === l.productId);
      if (!p || p.type !== 'stock') continue;
      const id = l.variantId || l.productId;
      need.set(id, (need.get(id) || 0) + (Number(l.qty) || 0));
      why.set(id, [...(why.get(id) || []), o.docNo]);
    }
  }
  const supOf = (x) => ((dd.products || []).find(p => p.id === x.productId) || {}).supplierId || '';
  return stockOf().filter(x => !supplierId || (supplierId === NONE ? !supOf(x) : supOf(x) === supplierId))
    .map(x => ({ ...x, supplierId: supOf(x), need: need.get(x.itemId) || 0, orders: why.get(x.itemId) || [], qty: (need.get(x.itemId) || 0) - x.available - x.onOrder }))
    .filter(x => x.qty > 0);
}
// what the low-stock list says to order: items at or under their reorder level counting what is on order, the reorder quantity each
function suggest(supplierId) {
  const dd = d();
  return stockOf().filter(x => x.reorderLevel != null && x.available + x.onOrder <= x.reorderLevel && (!supplierId || ((dd.products || []).find(p => p.id === x.productId) || {}).supplierId === supplierId)).map(x => ({ ...x, qty: Math.max(1, x.reorderQty || (x.reorderLevel - x.available - x.onOrder + 1)) }));
}
async function poSave(quiet) {
  const e = readEdit(); const dd = d();
  if (!e.lines.length) { toast('Add at least one line.', 'warn'); return null; }
  const doc = { supplierId: e.supplierId, supplierName: supplierName(e.supplierId), expectedAt: e.expectedAt, note: e.note, lines: e.lines, status: 'draft', docNo: '', seq: 0, subtotalCents: e.lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0) };
  try {
    if (e.id) await patchOne('purchaseOrders', e.id, { ...doc, ...auth.touch() });
    else { e.id = newId('purchaseOrders'); await setOne('purchaseOrders', e.id, { ...doc, ...auth.stamp(dd.entity.id, dd.store.id) }); }
    if (!quiet) toast('Draft saved');
    return e.id;
  } catch (err) { toast('Could not save: ' + err.message, 'warn'); return null; }
}
async function poSend() {
  const e = readEdit(); if (!e.supplierId) return toast('Choose the supplier.', 'warn');
  const id = await poSave(true); if (!id) return;
  try {
    const r = await withPin('poSend', { poId: id, how: 'link', ...where() }, 'manager');
    by.edit = null; toast('Sent: ' + r.po.docNo); ctx.repaint(); shareModal(r.po);
  } catch (err) { toast(err.offline ? 'Sending needs the line.' : err.message, 'warn'); }
}
function poView(id) {
  const dd = d(); const p = openPos(dd).find(x => x.id === id); if (!p) return;
  const sup = (dd.suppliers || []).find(s => s.id === p.supplierId);
  const { wrap } = openModal((p.docNo || 'Draft purchase order') + ' · ' + esc(p.supplierName || (sup && sup.name) || ''), `
    <div class="lb-head">${chip(p.status)}<span class="muted">${p.sentAt ? 'Sent ' + esc(niceDate(p.sentAt)) + ' by ' + esc(p.sentBy) : 'Drafted ' + esc(niceDate(p.createdAt))}${p.expectedAt ? ' · expected ' + esc(niceDate(p.expectedAt)) : ''}${(p.grvs || []).length ? ' · received on ' + p.grvs.map(g => esc(g.docNo)).join(', ') : ''}</span></div>
    <table class="tbl"><thead><tr><th>Item</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Unit cost</th><th class="r">Total</th></tr></thead><tbody>${p.lines.map(l => `<tr><td>${esc(l.name)}<div class="muted">${esc(l.sku || '')}</div></td><td class="r">${l.qty}</td><td class="r">${l.receivedQty || 0}</td><td class="r">${esc(money(l.unitCostCents))}</td><td class="r">${esc(money(l.qty * l.unitCostCents))}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="4" class="r">Subtotal</td><td class="r">${esc(money(p.subtotalCents || 0))}</td></tr>${p.vatCents ? `<tr><td colspan="4" class="r">VAT</td><td class="r">${esc(money(p.vatCents))}</td></tr><tr><td colspan="4" class="r"><strong>Total</strong></td><td class="r"><strong>${esc(money(p.totalCents))}</strong></td></tr>` : ''}</tfoot></table>
    ${p.note ? `<p class="muted">${esc(p.note)}</p>` : ''}${p.cancelReason ? `<p class="warn">Cancelled: ${esc(p.cancelReason)}</p>` : ''}
    <div class="card-actions lb-acts">
      ${['sent', 'part'].includes(p.status) ? `<button class="btn primary" data-act="by-po-receive" data-id="${esc(p.id)}">${icon('inbox')} Receive against it</button>` : ''}
      ${p.status === 'draft' && mgr() ? `<button class="btn primary" data-act="by-po-edit" data-id="${esc(p.id)}">Edit and send</button>` : ''}
      ${p.status !== 'draft' ? `<button class="btn" data-act="by-po-share" data-id="${esc(p.id)}">${icon('user')} Send again</button>` : ''}
      <button class="btn ghost" data-act="by-po-print" data-id="${esc(p.id)}">${icon('printer')} Print / PDF</button>
      ${['draft', 'sent', 'part'].includes(p.status) && mgr() ? `<button class="btn ghost" data-act="by-po-cancel" data-id="${esc(p.id)}">Cancel order</button>` : ''}
    </div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  wrap.querySelector('.modal-card').classList.add('wide');
}
function poDoc(p) { const dd = d(); return poHtml({ po: p, entity: dd.entity, store: dd.store, supplier: (dd.suppliers || []).find(s => s.id === p.supplierId) }); }
async function shareModal(p) {
  const dd = d(); const sup = (dd.suppliers || []).find(s => s.id === p.supplierId) || {};
  let link = null;
  const getLink = async () => { if (link) return link; link = await auth.api('link', { poId: p.id, ...where() }, API.doc); return link; };
  const { wrap } = openModal('Send ' + p.docNo + ' to ' + (p.supplierName || sup.name || 'the supplier'), `<p class="muted">The supplier opens a link to the order as an A4 page and prints it or saves it as a PDF.</p>
    <div class="rc-acts"><button class="btn" data-sh="mail">${icon('file')} Email${sup.email ? ' ' + esc(sup.email) : ''}</button><button class="btn" data-sh="wa">${icon('user')} WhatsApp${sup.phone ? ' ' + esc(sup.phone) : ''}</button><button class="btn ghost" data-sh="copy">Copy link</button><button class="btn ghost" data-sh="print">${icon('printer')} Print / PDF here</button></div>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
  wrap.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sh]'); if (!b) return;
    try {
      if (b.dataset.sh === 'print') return openPrint('Purchase order ' + p.docNo, poDoc(p), A4_CSS);
      const r = await getLink();
      if (b.dataset.sh === 'mail') { const email = prompt('Email address', sup.email || ''); if (email) window.open(mailtoUrl(email, 'Purchase order ' + p.docNo + ' from ' + (dd.entity.tradingName || dd.entity.legalName), r.text), '_blank'); }
      else if (b.dataset.sh === 'wa') { const phone = prompt('WhatsApp number', sup.phone || ''); if (phone) window.open(whatsappUrl(phone, r.text), '_blank'); }
      else { await navigator.clipboard.writeText(r.url).catch(() => {}); toast('Link copied'); wrap.querySelector('.rc-acts').insertAdjacentHTML('beforeend', `<p class="muted" style="word-break:break-all;font-size:11px">${esc(r.url)}</p>`); }
    } catch (err) { toast(err.message, 'warn'); }
  });
}

// ---------------------------------------------------------- receive --
function receiveHtml(dd) {
  const r = by.rcv;
  const grvs = (dd.grvs || []).filter(g => g.storeId === dd.store.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!r) {
    const open = openPos(dd).filter(p => ['sent', 'part'].includes(p.status));
    return `<div class="card"><h2>Receive stock</h2><p class="muted">Against a purchase order (part or all of it), or a direct receipt with no order. The cost that goes into stock is the landed cost: the goods plus freight, duty and other charges, spread over the lines.</p>
      <div class="card-actions">${open.map(p => `<button class="btn" data-act="by-rcv-po" data-id="${esc(p.id)}">${icon('inbox')} ${esc(p.docNo)} · ${esc(p.supplierName)}</button>`).join('')}<button class="btn ghost" data-act="by-rcv-direct">Direct receipt (no PO)</button></div></div>
      ${grvs.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>GRV</th><th>Supplier</th><th>Against</th><th>Lines</th><th class="r">Into stock</th><th>By</th><th></th></tr></thead><tbody>${grvs.map(g => `<tr><td><strong>${esc(g.docNo)}</strong><div class="muted">${esc(niceDate(g.createdAt))}</div></td><td>${esc(g.supplierName || '—')}${g.supplierInvoiceNo ? `<div class="muted">inv ${esc(g.supplierInvoiceNo)}</div>` : ''}</td><td>${esc(g.purchaseOrderDocNo || 'direct')}</td><td>${g.lineCount} · ${g.lines.reduce((n, l) => n + l.qty, 0)} units</td><td class="r">${esc(money(g.totalCostCents))}</td><td class="muted">${esc(g.receivedBy)}</td><td class="r nowrap"><button class="btn ghost sm" data-act="by-grv-print" data-id="${esc(g.id)}">Print</button><button class="btn ghost sm" data-act="by-grv-labels" data-id="${esc(g.id)}">Labels</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }
  const sub = r.lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0);
  const extra = (r.freightCents || 0) + (r.dutyCents || 0) + (r.otherCents || 0);
  return `<div class="card"><h2>${r.po ? 'Receive against ' + esc(r.po.docNo) + ' · ' + esc(r.po.supplierName) : 'Direct receipt'}</h2>
    <div class="grid three">${r.po ? '' : field('Supplier', 'rc-supplier', { type: 'select', value: r.supplierId, options: [{ value: '', label: 'None / unknown' }, ...suppliers().map(s => ({ value: s.id, label: s.name }))] })}${field('Supplier invoice no', 'rc-inv', { value: r.supplierInvoiceNo })}${field('Invoice date', 'rc-invdate', { type: 'date', value: r.invoiceDate })}</div>
    ${r.po ? '' : `<div class="tk-scanrow" style="margin:.4rem 0"><label class="pos-search-wrap" style="flex:1 1 260px">${icon('search')}<input id="rc-add" class="pos-in" placeholder="Add an item: name, SKU or barcode" autocomplete="off"></label></div><div id="rc-hits" class="pk-list"></div>`}
    ${r.lines.length ? `<table class="tbl po-lines"><thead><tr><th>Item</th>${r.po ? '<th class="r">Ordered</th><th class="r">Still open</th>' : ''}<th class="r">Received now</th><th class="r">Unit cost (ex VAT)</th><th class="r">Landed each</th><th class="r">Total</th><th></th></tr></thead><tbody>${r.lines.map((l, i) => `<tr><td><strong>${esc(l.name)}</strong><div class="muted">${esc(l.sku || '')}</div></td>${r.po ? `<td class="r">${l.ordered}</td><td class="r">${l.open}</td>` : ''}<td class="r"><input class="in-sm r" data-rc-qty="${i}" type="number" min="0" value="${l.qty}" style="max-width:80px"></td><td class="r"><input class="in-sm r" data-rc-cost="${i}" inputmode="decimal" value="${randsOf(l.unitCostCents)}" style="max-width:110px"></td><td class="r">${esc(money(landedEach(r, i)))}</td><td class="r">${esc(money(l.qty * l.unitCostCents))}</td><td class="r">${r.po ? '' : `<button class="pos-icon-btn light" data-act="by-rcv-rm" data-i="${i}" title="Remove">${icon('x')}</button>`}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="${r.po ? 6 : 4}" class="r">Goods (ex VAT)</td><td class="r">${esc(money(sub))}</td><td></td></tr>${extra ? `<tr><td colspan="${r.po ? 6 : 4}" class="r">Landed costs</td><td class="r">${esc(money(extra))}</td><td></td></tr><tr><td colspan="${r.po ? 6 : 4}" class="r"><strong>Into stock</strong></td><td class="r"><strong>${esc(money(sub + extra))}</strong></td><td></td></tr>` : ''}</tfoot></table>` : '<p class="muted">Add the items that arrived.</p>'}
    <h3 class="st-h3">Landed costs (imports, courier)</h3>
    <div class="grid four">${field('Freight (R)', 'rc-freight', { value: randsOf(r.freightCents || 0), inputmode: 'decimal' })}${field('Duty (R)', 'rc-duty', { value: randsOf(r.dutyCents || 0), inputmode: 'decimal' })}${field('Other (R)', 'rc-other', { value: randsOf(r.otherCents || 0), inputmode: 'decimal' })}${field('Spread by', 'rc-method', { type: 'select', value: r.method, options: [{ value: 'value', label: 'Value of each line' }, { value: 'qty', label: 'Quantity' }] })}</div>
    ${field('Note', 'rc-note', { value: r.note })}
    <label class="chk"><input type="checkbox" id="rc-updcost"${r.updateCosts ? ' checked' : ''}> Update the products’ cost to the new weighted average</label>
    <div class="card-actions"><button class="btn primary" data-act="by-rcv-go"${r.lines.some(l => l.qty > 0) ? '' : ' disabled'}>${icon('inbox')} Receive into stock</button><button class="btn ghost" data-act="by-rcv-close">Back</button></div></div>`;
}
function landedEach(r, i) {
  const extra = (r.freightCents || 0) + (r.dutyCents || 0) + (r.otherCents || 0);
  const base = r.lines.map(l => r.method === 'qty' ? l.qty : l.qty * l.unitCostCents); const sum = base.reduce((n, x) => n + x, 0);
  const l = r.lines[i]; if (!l.qty) return 0;
  return Math.round((l.qty * l.unitCostCents + (sum ? extra * base[i] / sum : 0)) / l.qty);
}
function readRcv() {
  const w = document.getElementById('screen'); const r = by.rcv; if (!r || !w.querySelector('#rc-inv')) return r;
  if (!r.po) r.supplierId = val(w, 'rc-supplier');
  r.supplierInvoiceNo = val(w, 'rc-inv'); r.invoiceDate = val(w, 'rc-invdate'); r.note = val(w, 'rc-note'); r.method = val(w, 'rc-method');
  r.freightCents = centsOf(val(w, 'rc-freight')); r.dutyCents = centsOf(val(w, 'rc-duty')); r.otherCents = centsOf(val(w, 'rc-other')); r.updateCosts = !!w.querySelector('#rc-updcost').checked;
  w.querySelectorAll('[data-rc-qty]').forEach(i => { const l = r.lines[Number(i.dataset.rcQty)]; if (l) l.qty = Math.max(0, Math.round(Number(i.value) || 0)); });
  w.querySelectorAll('[data-rc-cost]').forEach(i => { const l = r.lines[Number(i.dataset.rcCost)]; if (l) l.unitCostCents = Math.max(0, centsOf(i.value)); });
  return r;
}
function startReceive(po) {
  const dd = d();
  by.rcv = { po: po || null, supplierId: po ? po.supplierId : '', supplierInvoiceNo: '', invoiceDate: today(), note: '', method: 'value', freightCents: 0, dutyCents: 0, otherCents: 0, updateCosts: (dd.settings.buying || {}).updateCostsOnReceive !== false,
    lines: po ? po.lines.filter(l => (l.receivedQty || 0) < l.qty).map(l => ({ ...l, ordered: l.qty, open: l.qty - (l.receivedQty || 0), qty: l.qty - (l.receivedQty || 0) })) : [] };
  by.sub = 'receive'; ctx.repaint();
}
async function receiveGo() {
  const r = readRcv(); const lines = r.lines.filter(l => l.qty > 0);
  if (!lines.length) return toast('Nothing arrived?', 'warn');
  const body = { grvId: mkId('grv'), purchaseOrderId: r.po ? r.po.id : '', supplierId: r.supplierId, supplierInvoiceNo: r.supplierInvoiceNo, invoiceDate: r.invoiceDate, lines: lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitCostCents: l.unitCostCents })), landed: { freightCents: r.freightCents, dutyCents: r.dutyCents, otherCents: r.otherCents, method: r.method }, updateCosts: r.updateCosts, note: r.note, ...where() };
  try {
    const res = await withPin('receive', body, 'supervisor');
    by.rcv = null; ctx.repaint();
    toast('Received: ' + res.grv.docNo + (res.poStatus ? ' · ' + (res.poStatus === 'received' ? 'order complete' : 'order part received') : '') + (res.grv.costChanges.length ? ' · ' + res.grv.costChanges.length + ' cost' + (res.grv.costChanges.length === 1 ? '' : 's') + ' updated' : ''));
    if (ctx.onChange) ctx.onChange();
    grvModal(res.grv);
  } catch (e) { toast(e.offline ? 'Receiving needs the line.' : e.message, 'warn'); }
}
function grvModal(g) {
  const dd = d();
  openModal('Goods received ' + g.docNo, `<p>${g.lineCount} line${g.lineCount === 1 ? '' : 's'}, ${g.lines.reduce((n, l) => n + l.qty, 0)} units, ${esc(money(g.totalCostCents))} into stock${g.landed && g.landed.totalCents ? ' (landed costs ' + esc(money(g.landed.totalCents)) + ')' : ''}.</p>${g.costChanges && g.costChanges.length ? `<p class="muted">Costs updated: ${g.costChanges.map(c => esc(c.name) + ' ' + esc(money(c.fromCents)) + ' → ' + esc(money(c.toCents))).join('; ')}</p>` : ''}
    <div class="rc-acts"><button class="btn" data-act="by-grv-print" data-id="${esc(g.id)}">${icon('printer')} Print GRV</button><button class="btn" data-act="by-grv-labels" data-id="${esc(g.id)}">${icon('barcode')} Labels for what came in</button></div>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
}
function grvLabels(g) {
  const dd = d();
  const list = g.lines.map(l => { const p = (dd.products || []).find(x => x.id === l.productId) || {}; const v = l.variantId ? (dd.variants || []).find(x => x.id === l.variantId) : null; return { name: l.name, code: l.barcode || l.sku || '', priceCents: v && v.priceCents != null ? v.priceCents : p.priceCents || 0, copies: l.qty }; });
  printLabelItems(list, 1);
}

// --------------------------------------------------------- transfers --
function transfersHtml(dd) {
  const t = by.tr;
  const sid = dd.store.id;
  const all = (dd.transfers || []).sort((a, b) => String(b.sentAt || b.createdAt).localeCompare(String(a.sentAt || a.createdAt)));
  const out = all.filter(x => x.fromStoreId === sid), inn = all.filter(x => x.toStoreId === sid);
  const others = (dd.stores || []).filter(s => s.entityId === dd.entity.id && s.id !== sid && s.active !== false);
  if (t) {
    return `<div class="card"><h2>Send stock to another store</h2>
      <div class="grid two">${field('To', 'tr-to', { type: 'select', value: t.toStoreId, options: [{ value: '', label: 'Choose…' }, ...others.map(s => ({ value: s.id, label: s.name }))] })}${field('Note', 'tr-note', { value: t.note })}</div>
      <div class="tk-scanrow" style="margin:.4rem 0"><label class="pos-search-wrap" style="flex:1 1 260px">${icon('search')}<input id="tr-add" class="pos-in" placeholder="Add an item: name, SKU or barcode" autocomplete="off"></label></div><div id="tr-hits" class="pk-list"></div>
      ${t.lines.length ? `<table class="tbl po-lines"><thead><tr><th>Item</th><th class="r">Available here</th><th class="r">Send</th><th></th></tr></thead><tbody>${t.lines.map((l, i) => { const s = stockOf().find(x => x.itemId === l.itemId) || {}; return `<tr><td><strong>${esc(l.name)}</strong><div class="muted">${esc(l.sku || '')}</div></td><td class="r">${s.available == null ? '' : s.available}</td><td class="r"><input class="in-sm r" data-tr-qty="${i}" type="number" min="1" value="${l.qty}" style="max-width:80px"></td><td class="r"><button class="pos-icon-btn light" data-act="by-tr-rm" data-i="${i}">${icon('x')}</button></td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">Add the items to send.</p>'}
      <div class="card-actions"><button class="btn primary" data-act="by-tr-send"${t.lines.length && t.toStoreId ? '' : ' disabled'}>${icon('truck')} Send (stock leaves now)</button><button class="btn ghost" data-act="by-tr-close">Back</button></div></div>`;
  }
  const rowsOf = (list, incoming) => list.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>No</th><th>${incoming ? 'From' : 'To'}</th><th>Lines</th><th class="r">Units</th><th>Status</th><th></th></tr></thead><tbody>${list.map(x => `<tr class="${/cancelled|received/.test(x.status) ? 'off' : ''}"><td><strong>${esc(x.docNo)}</strong><div class="muted">${esc(niceDate(x.sentAt))} · ${esc(x.sentBy)}</div></td><td>${esc(incoming ? x.fromStoreName : x.toStoreName)}</td><td>${x.lineCount}</td><td class="r">${x.units}${x.status !== 'inTransit' ? '' : ' · ' + x.lines.reduce((n, l) => n + (l.receivedQty || 0), 0) + ' in'}${x.lostUnits ? ' · ' + x.lostUnits + ' short' : ''}</td><td>${chip(x.status)}</td><td class="r nowrap">${incoming && x.status === 'inTransit' ? `<button class="btn primary sm" data-act="by-tr-receive" data-id="${esc(x.id)}">Receive</button>` : ''}${!incoming && x.status === 'inTransit' && !x.lines.some(l => l.receivedQty > 0) ? `<button class="btn ghost sm" data-act="by-tr-cancel" data-id="${esc(x.id)}">Cancel</button>` : ''}<button class="btn ghost sm" data-act="by-tr-print" data-id="${esc(x.id)}">Print</button></td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${incoming ? 'Nothing on its way here.' : 'Nothing sent from here.'}</p>`;
  return `<div class="toolbar"><button class="btn primary sm" data-act="by-tr-new"${others.length ? '' : ' disabled'}>${icon('truck')} New transfer</button>${others.length ? '' : '<span class="muted">This company has no other store.</span>'}</div>
    <h3 class="st-h3">Incoming</h3>${rowsOf(inn, true)}<h3 class="st-h3">Outgoing</h3>${rowsOf(out, false)}`;
}
function readTr() { const w = document.getElementById('screen'); const t = by.tr; if (!t || !w.querySelector('#tr-to')) return t; t.toStoreId = val(w, 'tr-to'); t.note = val(w, 'tr-note'); w.querySelectorAll('[data-tr-qty]').forEach(i => { const l = t.lines[Number(i.dataset.trQty)]; if (l) l.qty = Math.max(1, Math.round(Number(i.value) || 1)); }); return t; }
async function trSend() {
  const t = readTr(); if (!t.toStoreId) return toast('Which store?', 'warn');
  const bad = t.lines.find(l => { const s = stockOf().find(x => x.itemId === l.itemId); return s && l.qty > s.available; });
  if (bad) return toast(bad.name + ': only ' + (stockOf().find(x => x.itemId === bad.itemId) || {}).available + ' available here.', 'warn');
  try {
    const r = await withPin('transferSend', { transferId: mkId('tr'), toStoreId: t.toStoreId, lines: t.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty })), note: t.note, ...where() }, 'supervisor');
    by.tr = null; toast('Sent ' + r.transfer.docNo + ' to ' + r.transfer.toStoreName); if (ctx.onChange) ctx.onChange(); ctx.repaint();
    openPrint('Transfer ' + r.transfer.docNo, trDoc(r.transfer), A4_CSS);
  } catch (e) { toast(e.offline ? 'A transfer needs the line.' : e.message, 'warn'); }
}
function trDoc(x) { const dd = d(); return transferHtml({ tr: x, entity: dd.entity, fromStore: (dd.stores || []).find(s => s.id === x.fromStoreId), toStore: (dd.stores || []).find(s => s.id === x.toStoreId) }); }
function trReceive(id) {
  const x = (d().transfers || []).find(t => t.id === id); if (!x) return;
  const open = x.lines.filter(l => (l.receivedQty || 0) < l.qty);
  openModal('Receive ' + x.docNo + ' from ' + x.fromStoreName, `<table class="tbl"><thead><tr><th>Item</th><th class="r">Sent</th><th class="r">Already in</th><th class="r">Arrived now</th></tr></thead><tbody>${open.map(l => `<tr><td>${esc(l.name)}</td><td class="r">${l.qty}</td><td class="r">${l.receivedQty || 0}</td><td class="r"><input class="in-sm r" data-trr="${esc(l.itemId)}" type="number" min="0" max="${l.qty - (l.receivedQty || 0)}" value="${l.qty - (l.receivedQty || 0)}" style="max-width:80px"></td></tr>`).join('')}</tbody></table>
    <label class="chk"><input type="checkbox" id="trr-close"> Close the transfer: anything short is recorded as lost in transit (the sender already took it out of stock)</label>`, {
    okLabel: 'Receive', onOk: async (w) => {
      const lines = [...w.querySelectorAll('[data-trr]')].map(i => ({ itemId: i.dataset.trr, qty: Math.max(0, Math.round(Number(i.value) || 0)) }));
      const close = !!w.querySelector('#trr-close').checked;
      if (!lines.some(l => l.qty > 0) && !close) { toast('Nothing arrived?', 'warn'); return false; }
      try { const r = await withPin('transferReceive', { transferId: id, lines, close, ...where() }, 'supervisor'); toast(r.transfer.status === 'received' ? 'Received ' + x.docNo + (r.transfer.lostUnits ? ' · ' + r.transfer.lostUnits + ' short' : '') : 'Part received; the rest is still on the way'); if (ctx.onChange) ctx.onChange(); return true; }
      catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}

// ----------------------------------------------------------- shared --
async function withPin(action, body, minRole) {
  try { return await auth.api(action, body, API.buy); }
  catch (e) {
    if (e.status === 403 && /PIN/.test(e.message)) { const role = /manager/.test(e.message) ? 'manager' : minRole; const a = await auth.requireOverride({ minRole: role, action: 'buy', details: { what: action }, text: e.message }); return auth.api(action, { ...body, approvalToken: a.token }, API.buy); }
    throw e;
  }
}
// the item search under a line editor: the hits list and what adding does
function hits(hostId, q, onPick) {
  const host = document.getElementById(hostId); if (!host) return;
  const s = q.trim().toLowerCase(); if (!s) { host.innerHTML = ''; return; }
  const found = stockOf().filter(x => [x.name, x.sku, ...x.barcodes].some(v => String(v).toLowerCase().includes(s))).slice(0, 8);
  host.innerHTML = found.map(x => `<button class="pk-row" data-pick="${esc(x.itemId)}"><strong>${esc(x.name)}</strong><span>${esc(x.sku)} · ${x.available} available · cost ${esc(money(x.costCents))}</span></button>`).join('') || '<div class="muted" style="padding:.4rem .7rem">No stock item matches.</div>';
  host.onclick = (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; const it = stockOf().find(x => x.itemId === b.dataset.pick); if (it) onPick(it); };
}
export function onInput(id, value) {
  if (id === 'by-q') { by.q = value; ctx.repaint(); const q = document.getElementById('by-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  if (id === 'po-add') hits('po-hits', value, (it) => { addLine(it, 1); });
  if (id === 'rc-add') hits('rc-hits', value, (it) => { const r = readRcv(); if (!r.lines.some(l => l.itemId === it.itemId)) r.lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, name: it.name, sku: it.sku, barcode: it.barcodes[0] || '', qty: 1, unitCostCents: it.costCents }); ctx.repaint(); });
  if (id === 'tr-add') hits('tr-hits', value, (it) => { const t = readTr(); if (!t.lines.some(l => l.itemId === it.itemId)) t.lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, name: it.name, sku: it.sku, qty: 1 }); ctx.repaint(); });
}
export function onEnter(id, value) {
  const pickExact = (fn) => { const s = String(value).trim().toLowerCase(); const it = stockOf().find(x => x.barcodes.some(b => String(b).toLowerCase() === s) || x.sku.toLowerCase() === s); if (it) { fn(it); return true; } return false; };
  if (id === 'po-add') return pickExact(it => addLine(it, 1));
  if (id === 'rc-add') return pickExact(it => { const r = readRcv(); const had = r.lines.find(l => l.itemId === it.itemId); if (had) had.qty++; else r.lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, name: it.name, sku: it.sku, barcode: it.barcodes[0] || '', qty: 1, unitCostCents: it.costCents }); ctx.repaint(); });
  if (id === 'tr-add') return pickExact(it => { const t = readTr(); const had = t.lines.find(l => l.itemId === it.itemId); if (had) had.qty++; else t.lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, name: it.name, sku: it.sku, qty: 1 }); ctx.repaint(); });
  return false;
}
export function onChange(e) {
  if (e.target.id === 'by-filter') { by.filter = e.target.value; ctx.repaint(); }
  // a line's figure changes on blur, often the moment a button is pressed: read now, redraw a beat later so the press still lands
  const later = () => setTimeout(() => ctx.repaint(), 220);
  if (/^rc-(freight|duty|other|method)$/.test(e.target.id) || e.target.dataset.rcQty != null || e.target.dataset.rcCost != null) { readRcv(); later(); }
  if (e.target.dataset.poQty != null || e.target.dataset.poCost != null || e.target.id === 'po-supplier') { readEdit(); later(); }
  if (e.target.id === 'tr-to' || e.target.dataset.trQty != null) { readTr(); later(); }
}
export async function action(act, b) {
  const id = b.dataset.id;
  switch (act) {
    case 'by-sub': by.sub = b.dataset.to; by.q = ''; return ctx.repaint();
    case 'by-sup-new': return supplierForm('');
    case 'by-sup-edit': return supplierForm(id);
    case 'by-sup-import': return importSuppliers();
    case 'by-po-new': by.edit = newEdit(null); return ctx.repaint();
    case 'by-po-suggest': { by.edit = newEdit(null); suggest('').forEach(x => by.edit.lines.push({ productId: x.productId, variantId: x.variantId, itemId: x.itemId, sku: x.sku, name: x.name, barcode: x.barcodes[0] || '', qty: x.qty, unitCostCents: x.costCents, receivedQty: 0 })); if (!by.edit.lines.length) toast('Nothing is low.', 'warn'); return ctx.repaint(); }
    case 'by-po-open': {
      const all = forOpenOrders(''); if (!all.length) return toast('Open orders need nothing you do not have.', 'warn');
      const groups = new Map(); all.forEach(x => groups.set(x.supplierId || NONE, (groups.get(x.supplierId || NONE) || 0) + 1));
      const opts = [...groups.entries()].map(([k, n]) => ({ value: k, label: (k === NONE ? 'No supplier set' : supplierName(k) || 'Unknown supplier') + ' · ' + n + ' item' + (n === 1 ? '' : 's') })).sort((a, b) => a.label.localeCompare(b.label));
      openModal('Order for open orders only', `<p class="muted">Only what open sales orders and website orders need that you do not have (less what is on order). Reorder levels are left out.</p>${field('Supplier', 'oo-sup', { type: 'select', value: opts.length === 1 ? opts[0].value : '', options: [{ value: '', label: 'All suppliers · ' + all.length + ' item' + (all.length === 1 ? '' : 's') }, ...opts] })}`, {
        okLabel: 'Make the order', onOk: (w) => {
          const sid = val(w, 'oo-sup'), list = forOpenOrders(sid);
          by.edit = newEdit(null); by.edit.supplierId = sid && sid !== NONE ? sid : '';
          list.forEach(x => by.edit.lines.push({ productId: x.productId, variantId: x.variantId, itemId: x.itemId, sku: x.sku, name: x.name, barcode: x.barcodes[0] || '', qty: x.qty, unitCostCents: x.costCents, receivedQty: 0 }));
          by.edit.note = 'For open orders: ' + [...new Set(list.flatMap(x => x.orders))].slice(0, 20).join(', ');
          toast(list.length + ' item' + (list.length === 1 ? '' : 's') + ' for open orders' + (sid && sid !== NONE ? ' from ' + supplierName(sid) : ''));
          ctx.repaint(); return true;
        } });
      return;
    }
    case 'by-po-open-here': { const e = readEdit(); const list = forOpenOrders(e.supplierId); if (!list.length) return toast(e.supplierId ? 'Open orders need nothing more of this supplier’s.' : 'Open orders need nothing you do not have.', 'warn'); let n = 0; list.forEach(x => { if (!e.lines.some(l => l.itemId === x.itemId)) { e.lines.push({ productId: x.productId, variantId: x.variantId, itemId: x.itemId, sku: x.sku, name: x.name, barcode: x.barcodes[0] || '', qty: x.qty, unitCostCents: x.costCents, receivedQty: 0 }); n++; } }); toast(n + ' added for open orders'); return ctx.repaint(); }
    case 'by-po-suggest-here': { const e = readEdit(); const list = suggest(e.supplierId); if (!list.length) return toast(e.supplierId ? 'Nothing of this supplier’s is low.' : 'Nothing is low.', 'warn'); list.forEach(x => { if (!e.lines.some(l => l.itemId === x.itemId)) e.lines.push({ productId: x.productId, variantId: x.variantId, itemId: x.itemId, sku: x.sku, name: x.name, barcode: x.barcodes[0] || '', qty: x.qty, unitCostCents: x.costCents, receivedQty: 0 }); }); toast(list.length + ' suggested'); return ctx.repaint(); }
    case 'by-po-edit': { const p = openPos(d()).find(x => x.id === id); if (p) { const m = document.getElementById('modal'); if (m) m.remove(); by.edit = newEdit(p); by.sub = 'po'; ctx.repaint(); } return; }
    case 'by-po-rm': { const e = readEdit(); e.lines.splice(Number(b.dataset.i), 1); return ctx.repaint(); }
    case 'by-po-save': { if (await poSave(false)) ctx.repaint(); return; }
    case 'by-po-send': return poSend();
    case 'by-po-close': by.edit = null; return ctx.repaint();
    case 'by-po-open': return poView(id);
    case 'by-po-print': { const p = openPos(d()).find(x => x.id === id); if (p) openPrint('Purchase order ' + (p.docNo || 'draft'), poDoc(p), A4_CSS); return; }
    case 'by-po-share': { const p = openPos(d()).find(x => x.id === id); if (p) shareModal(p); return; }
    case 'by-po-cancel': { const p = openPos(d()).find(x => x.id === id); if (!p) return; const reason = prompt('Cancel ' + (p.docNo || 'this draft') + '? Why?', ''); if (reason === null) return; try { await withPin('poCancel', { poId: id, reason, ...where() }, 'manager'); const m = document.getElementById('modal'); if (m) m.remove(); toast('Cancelled'); if (ctx.onChange) ctx.onChange(); } catch (e) { toast(e.message, 'warn'); } return; }
    case 'by-po-receive': { const p = openPos(d()).find(x => x.id === id); const m = document.getElementById('modal'); if (m) m.remove(); if (p) startReceive(p); return; }
    case 'by-rcv-po': { const p = openPos(d()).find(x => x.id === id); if (p) startReceive(p); return; }
    case 'by-rcv-direct': return startReceive(null);
    case 'by-rcv-rm': { const r = readRcv(); r.lines.splice(Number(b.dataset.i), 1); return ctx.repaint(); }
    case 'by-rcv-go': return receiveGo();
    case 'by-rcv-close': by.rcv = null; return ctx.repaint();
    case 'by-grv-print': { const g = (d().grvs || []).find(x => x.id === id); if (g) openPrint('Goods received ' + g.docNo, grvHtml({ grv: g, entity: d().entity, store: d().store }), A4_CSS); return; }
    case 'by-grv-labels': { const g = (d().grvs || []).find(x => x.id === id); if (g) grvLabels(g); return; }
    case 'by-tr-new': by.tr = { toStoreId: '', note: '', lines: [] }; return ctx.repaint();
    case 'by-tr-rm': { const t = readTr(); t.lines.splice(Number(b.dataset.i), 1); return ctx.repaint(); }
    case 'by-tr-send': return trSend();
    case 'by-tr-close': by.tr = null; return ctx.repaint();
    case 'by-tr-receive': return trReceive(id);
    case 'by-tr-cancel': { if (!confirm('Cancel this transfer? The stock comes back into this store.')) return; try { await withPin('transferCancel', { transferId: id, ...where() }, 'supervisor'); toast('Transfer cancelled, stock back'); if (ctx.onChange) ctx.onChange(); } catch (e) { toast(e.message, 'warn'); } return; }
    case 'by-tr-print': { const x = (d().transfers || []).find(t => t.id === id); if (x) openPrint('Transfer ' + x.docNo, trDoc(x), A4_CSS); return; }
  }
}
