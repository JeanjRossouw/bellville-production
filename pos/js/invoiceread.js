// Retail POS — a supplier's invoice dropped on the Receive screen. The files go to the server (pos-invoice), which
// has them read; what comes back (the supplier, the number and date, each line's code, description, quantity and
// price, the delivery charge) is matched to the till's own items here and shown for the person to check. Nothing
// reaches stock until they tap Receive into stock on the receipt this fills in.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, openModal, money, niceDate } from './ui.js';
import { randsOf, centsOf } from './money.js';

export const INVOICE_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
const TYPES = INVOICE_ACCEPT.split(',');
const MAX_BYTES = 3500000, MAX_FILES = 5, MAX_SIDE = 2000;

const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
// a photo is made smaller before it goes (a phone's photo is many megabytes; the reader needs far less)
async function photo(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 700000 && file.type === 'image/jpeg') return { type: file.type, data: b64(await file.arrayBuffer()) };
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return { type: 'image/jpeg', data: b64(await blob.arrayBuffer()) };
  } catch (e) { return { type: file.type, data: b64(await file.arrayBuffer()) }; }
}
// the dropped files as the server takes them; an Error with words for the person when they will not do
export async function filesToPayload(list) {
  const files = [...(list || [])];
  if (!files.length) throw new Error('Drop the invoice: a PDF or a photo.');
  if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files at a time (the pages of one invoice).`);
  const out = [];
  for (const f of files) {
    const type = (f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : '')).toLowerCase();
    if (!TYPES.includes(type)) throw new Error(`${f.name} is not a PDF or a photo (JPG, PNG or WebP). Save or print the invoice as a PDF, or take a photo of it.`);
    out.push({ name: f.name, ...(type === 'application/pdf' ? { type, data: b64(await f.arrayBuffer()) } : await photo(f)) });
  }
  if (out.reduce((n, f) => n + f.data.length, 0) * 0.75 > MAX_BYTES) throw new Error('That is too big to read (about 3.5 MB at most): use a photo, or a PDF of only the invoice\'s pages.');
  return out;
}
// read it: queued on the server, then asked for until it is done (a long invoice takes a minute or so)
export async function readInvoice(list, where, { onWait, onStart } = {}) {
  const files = await filesToPayload(list);
  const start = await auth.api('start', { files, ...where }, API.invoice);
  if (onStart) onStart(start.readId);
  return waitForRead(start.readId, where, { onWait });
}
// a read already started (this one, or one begun before the page was left): asked for until it is done
export async function waitForRead(readId, where, { onWait, began = Date.now() } = {}) {
  for (;;) {
    const r = await auth.api('result', { readId, ...where }, API.invoice);
    if (r.status === 'done') return r.result;
    if (r.status === 'failed') throw new Error(r.error || 'The invoice could not be read.');
    if (Date.now() - began > 600000) throw new Error('The invoice is taking too long to read. Try again with fewer pages, or type it in.');
    if (onWait) onWait(Math.round((Date.now() - began) / 1000));
    await new Promise(res => setTimeout(res, Date.now() - began < 20000 ? 1500 : Date.now() - began < 120000 ? 3000 : 6000));
  }
}

// ---- matching the invoice's lines to the till's items: the code first (our SKU or barcode, however it is spaced or
// dashed), then the description against the item's name; a name match is marked for the person to check
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s) => [...new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1))];
export function matchInvoice(result, items, productOf = () => null) {
  const byCode = new Map(), dupe = new Set();
  const put = (code, it) => { const k = norm(code); if (k.length < 2) return; if (byCode.has(k) && byCode.get(k) !== it) dupe.add(k); else byCode.set(k, it); };
  for (const it of items) { put(it.sku, it); for (const b of it.barcodes || []) put(b, it); }
  const toks = items.map(it => ({ it, w: words(it.name) }));
  return (result.lines || []).map(line => {
    const k = norm(line.code);
    if (k && byCode.has(k) && !dupe.has(k)) return { line, item: byCode.get(k), how: 'code' };
    // a code of ours written inside the description
    for (const w of String(line.description || '').split(/\s+/)) { const c = norm(w); if (c.length >= 4 && /\d/.test(c) && byCode.has(c) && !dupe.has(c)) return { line, item: byCode.get(c), how: 'code' }; }
    const lw = words(line.description); if (!lw.length) return { line, item: null, how: '' };
    let best = null, bestS = 0, second = 0;
    for (const t of toks) {
      if (!t.w.length) continue;
      let hit = 0; for (const w of lw) if (t.w.includes(w)) hit++;
      if (!hit) continue;
      const s = 2 * hit / (lw.length + t.w.length);
      if (s > bestS) { second = bestS; bestS = s; best = t.it; } else if (s > second) second = s;
    }
    return best && bestS >= 0.75 && bestS - second >= 0.08 ? { line, item: best, how: 'name' } : { line, item: null, how: '', near: best && bestS >= 0.4 ? best : null };
  });
}
export const supplierMatch = (name, suppliers) => { const n = norm(name); if (n.length < 3) return null; return (suppliers || []).find(s => norm(s.name) === n) || (suppliers || []).find(s => { const m = norm(s.name); return m.length >= 4 && (n.includes(m) || m.includes(n)); }) || null; };

// ---- what was read, for the person to check: each line with the item it was matched to (changed with a search), the
// quantity and the cost; then onFill gets the supplier, the number, the date, the delivery charge and the chosen lines
// `saved` is what onState was last given for this same invoice (the person's choices so far), so a window closed by
// mistake, or a page left, opens again as it was
export function reviewInvoice({ result, items, productOf, suppliers, vatRegistered, onFill, saved, onState }) {
  const rows = matchInvoice(result, items, productOf).map(m => ({ ...m, on: !!m.item || !!m.near, qty: m.line.qty, costCents: vatRegistered ? m.line.unitExCents : m.line.unitInclCents, picking: !m.item, q: '' }));
  if (Array.isArray(saved) && saved.length === rows.length) saved.forEach((sv, i) => { const r = rows[i]; if (!sv) return; const it = sv.itemId ? items.find(x => x.itemId === sv.itemId) : null; r.item = it || null; r.how = it ? sv.how || 'you' : ''; r.picking = !it; r.on = !!sv.on; r.qty = Math.max(0, Math.round(Number(sv.qty) || 0)); r.costCents = Math.max(0, Math.round(Number(sv.costCents) || 0)); });
  const keep = () => { if (onState) onState(rows.map(r => ({ itemId: r.item ? r.item.itemId : '', how: r.how, on: r.on, qty: r.qty, costCents: r.costCents }))); };
  const sup = supplierMatch(result.supplierName, suppliers);
  const delivery = vatRegistered ? result.deliveryExCents : result.deliveryInclCents;
  const goods = vatRegistered ? (result.subtotalCents ? result.subtotalCents - result.deliveryExCents : 0) : (result.totalCents ? result.totalCents - result.deliveryInclCents : 0);
  const find = (q) => { const s = q.trim().toLowerCase(); if (!s) return []; return items.filter(x => [x.name, x.sku, ...(x.barcodes || [])].some(v => String(v || '').toLowerCase().includes(s))).slice(0, 6); };
  const sumLine = () => {
    const picked = rows.filter(r => r.on), sum = picked.reduce((n, r) => n + r.qty * r.costCents, 0), noItem = picked.filter(r => !r.item).length, off = goods && Math.abs(sum - goods) > 100;
    return { cls: off ? 'warn' : 'muted', html: `${picked.length} line${picked.length === 1 ? '' : 's'} ticked, adding up to <strong>${esc(money(sum))}</strong>${goods ? ' · the invoice’s goods come to ' + esc(money(goods)) + (off ? ': they differ, so check the quantities and costs' : '') : ''}${noItem ? ` · <span class="warn">${noItem} ticked line${noItem === 1 ? ' has' : 's have'} no item chosen</span>` : ''} · <span class="muted">saved as you go</span>` };
  };
  const body = () => {
    return `<p><strong>${esc(result.supplierName || 'Supplier not shown')}</strong>${sup ? ` <span class="chip ok">on your list${sup.name !== result.supplierName ? ' as ' + esc(sup.name) : ''}</span>` : result.supplierName ? ' <span class="chip">not on your supplier list</span>' : ''}
      ${result.invoiceNo ? ' · invoice <strong>' + esc(result.invoiceNo) + '</strong>' : ''}${result.invoiceDate ? ' · ' + esc(niceDate(result.invoiceDate)) : ''}${result.totalCents ? ' · total ' + esc(money(result.totalCents)) : ''}${delivery ? ' · delivery ' + esc(money(delivery)) : ''}</p>
      <p class="muted">Check each line against the invoice before you fill in the receipt. Costs are ${vatRegistered ? 'excluding VAT' : result.vatCharged ? 'including VAT (this company is not VAT registered, so the VAT is part of what the stock cost)' : 'as on the invoice (no VAT charged)'}.${result.note ? ' <span class="warn">' + esc(result.note) + '</span>' : ''}</p>
      <div id="iv-scroll" style="max-height:52vh;overflow:auto"><table class="tbl iv-tbl"><thead><tr><th></th><th>On the invoice</th><th class="r">Qty</th><th class="r">Cost each</th><th>Item here</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.on ? '' : 'off'}"><td><input type="checkbox" data-iv-on="${i}"${r.on ? ' checked' : ''} aria-label="Take this line"></td>
        <td>${r.line.code ? '<strong>' + esc(r.line.code) + '</strong> ' : ''}${esc(r.line.description)}${r.line.qtyAsPrinted !== r.line.qty ? `<div class="warn">quantity on the invoice: ${esc(String(r.line.qtyAsPrinted))}</div>` : ''}</td>
        <td class="r"><input class="in-sm r" data-iv-qty="${i}" type="number" min="0" step="1" value="${r.qty}" style="max-width:70px"></td>
        <td class="r"><input class="in-sm r" data-iv-cost="${i}" inputmode="decimal" value="${randsOf(r.costCents)}" style="max-width:96px"></td>
        <td>${r.item ? `<strong>${esc(r.item.name)}</strong><div class="muted">${esc(r.item.sku || '')} ${r.how === 'code' ? '<span class="chip ok">code matched</span>' : r.how === 'name' ? '<span class="chip late">matched by name: check</span>' : '<span class="chip">chosen by you</span>'} <button class="btn ghost sm" type="button" data-iv-change="${i}">Change</button></div>` : '<span class="chip late">not matched</span>'}
          ${r.picking ? `<div class="iv-pick"><input class="in-sm" data-iv-q="${i}" placeholder="Find the item: name, SKU or barcode" value="${esc(r.q)}" autocomplete="off">
            <div class="pk-list" data-iv-hits="${i}">${hitsHtml(r, i)}</div></div>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <p id="iv-sum" class="${sumLine().cls}">${sumLine().html}</p>`;
  };
  const hitsHtml = (r, i) => { const list = r.q.trim() ? find(r.q) : r.near ? [r.near] : []; return list.map(x => `<button class="pk-row" type="button" data-iv-pick="${esc(x.itemId)}" data-i="${i}"><strong>${esc(x.name)}</strong><span>${esc(x.sku || '')} · cost ${esc(money(x.costCents))}</span></button>`).join('') || (r.q.trim() ? '<div class="muted" style="padding:.4rem .7rem">No item matches. Add the product under Products first, or untick this line.</div>' : ''); };
  const { wrap, close } = openModal('Invoice read: check it', `<div id="iv-body">${body()}</div>`, {
    okLabel: 'Fill in the receipt', cancelLabel: 'Back', onOk: () => {
      read();
      const picked = rows.filter(r => r.on && r.qty > 0);
      if (!picked.length) { toast('Tick at least one line with a quantity.', 'warn'); return false; }
      if (picked.some(r => !r.item)) { toast('Choose the item for every ticked line, or untick it.', 'warn'); return false; }
      onFill({ supplier: sup, supplierName: result.supplierName, invoiceNo: result.invoiceNo, invoiceDate: result.invoiceDate, deliveryCents: delivery, lines: picked.map(r => ({ item: r.item, qty: r.qty, unitCostCents: r.costCents })), skipped: rows.length - picked.length });
      return true;
    } });
  wrap.querySelector('.modal-card').classList.add('wide');
  wrap.addEventListener('click', (e) => { if (e.target === wrap) e.stopImmediatePropagation(); }, true);   // a tap beside the window does not close it: only Back, ✕ or Fill in
  const host = wrap.querySelector('#iv-body');
  const read = () => { host.querySelectorAll('[data-iv-qty]').forEach(x => { rows[Number(x.dataset.ivQty)].qty = Math.max(0, Math.round(Number(x.value) || 0)); }); host.querySelectorAll('[data-iv-cost]').forEach(x => { rows[Number(x.dataset.ivCost)].costCents = Math.max(0, centsOf(x.value)); }); };
  const sumNow = () => { const p = host.querySelector('#iv-sum'), x = sumLine(); if (p) { p.className = x.cls; p.innerHTML = x.html; } };
  // a redraw (an item chosen, Change tapped) puts the list back where it was scrolled to and the cursor back in its box
  const paint = () => {
    read();
    const sc = host.querySelector('#iv-scroll'), top = sc ? sc.scrollTop : 0, a = document.activeElement;
    const d = a && host.contains(a) ? [...a.attributes].find(x => x.name.startsWith('data-iv-')) : null;
    host.innerHTML = body();
    const sc2 = host.querySelector('#iv-scroll'); if (sc2) sc2.scrollTop = top;
    if (d) { const el = host.querySelector(`[${d.name}="${d.value}"]`); if (el) el.focus({ preventScroll: true }); }
    keep();
  };
  // a tick or a changed figure: the row and the sum, nothing else moves
  host.addEventListener('change', (e) => { const t = e.target; if (t.dataset.ivOn != null) { rows[Number(t.dataset.ivOn)].on = t.checked; const tr = t.closest('tr'); if (tr) tr.classList.toggle('off', !t.checked); read(); sumNow(); keep(); } else if (t.dataset.ivQty != null || t.dataset.ivCost != null) { read(); sumNow(); keep(); } });
  host.addEventListener('input', (e) => { const t = e.target; if (t.dataset.ivQ == null) return; const i = Number(t.dataset.ivQ); rows[i].q = t.value; const h = host.querySelector(`[data-iv-hits="${i}"]`); if (h) h.innerHTML = hitsHtml(rows[i], i); });
  host.addEventListener('click', (e) => {
    const ch = e.target.closest('[data-iv-change]'); if (ch) { const r = rows[Number(ch.dataset.ivChange)]; r.picking = true; r.q = ''; paint(); const q = host.querySelector(`[data-iv-q="${ch.dataset.ivChange}"]`); if (q) q.focus(); return; }
    const pk = e.target.closest('[data-iv-pick]'); if (pk) { const r = rows[Number(pk.dataset.i)], it = items.find(x => x.itemId === pk.dataset.ivPick); if (it) { r.item = it; r.how = 'you'; r.picking = false; r.on = true; paint(); } }
  });
  keep();
  return { close };
}
