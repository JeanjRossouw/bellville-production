// The shortage check before an order goes onto the floor (phase 3 of the job
// cards spec). Moving an order into production (Release to floor on the
// planner, or In production on Orders) first compares what it takes with the
// shelf. All there: it goes straight on. Anything short: the person sees each
// material (OK, short by how much, or on order with the purchase order's
// date) and may release anyway, or order what is short first. Released while
// short, the order carries a red "material short" tag until the shelf is
// right again, with the same one tap to order it.
//
//   orders/<id>  shortAtRelease: [{ materialId, name, unit, short }]
import * as store from './store.js';
import { orderById, allOrders } from './orders.js';
import { shortageFor, shortNow, draftForSupplier } from './stock.js';
import { materialById } from './costing.js';
import { esc, openModal, toast, niceDate } from './ui.js';

const qty = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000).replace(/\.0+$/, '');
const LABEL = { ok: 'OK', short: 'Short', 'on-order': 'On order', uncounted: 'Not counted' };

let goToStock = () => {};
export const setGoToStock = (fn) => { goToStock = fn; };

function linesHtml(lines) {
  return `<table class="tbl sc-tbl"><thead><tr><th>Material</th><th class="r">Takes</th><th class="r">On the shelf</th><th>Status</th></tr></thead><tbody>
    ${lines.map(l => `<tr class="sc-${l.status}"><td><strong>${esc(l.name)}</strong>${l.supplier ? `<div class="muted">${esc(l.supplier)}</div>` : ''}</td>
      <td class="r">${esc(qty(l.need))} ${esc(l.unit)}</td><td class="r">${l.status === 'uncounted' ? '<span class="muted">not counted</span>' : esc(qty(l.onHand)) + ' ' + esc(l.unit)}</td>
      <td><span class="chip ${l.status === 'short' ? 'late' : l.status === 'on-order' ? 'soon' : l.status === 'ok' ? 'calm' : ''}">${esc(LABEL[l.status])}</span>
        ${l.short ? `<span class="muted"> ${esc(qty(l.short))} ${esc(l.unit)} short${l.status === 'on-order' ? ' now, coming' : ''}</span>` : ''}
        ${l.status === 'on-order' && l.po ? `<div class="muted">${esc(l.po.poNo || '')}${l.po.date ? ', due ' + esc(niceDate(l.po.date)) : ''}</div>` : ''}</td></tr>`).join('')}</tbody></table>`;
}

// Order what is short: one supplier, its draft purchase order (the Order now
// amounts for that supplier, which include this order); several, the Order
// now list on Stock, grouped by supplier.
export function orderShort(lines) {
  const sups = [...new Set((lines || []).filter(l => l.short > 0).map(l => l.supplier || 'No supplier set'))];
  if (!store.can('stock', 'edit')) { toast('Ordering is for whoever does the buying (Stock). Tell them what is short', 'warn'); return; }
  if (sups.length === 1) return draftForSupplier(sups[0], allOrders());
  goToStock();
  toast('Stock → Order now lists what is short, by supplier: one purchase order each');
}

// The check, then on: `go` moves the order into production.
export async function releaseChecked(id, go) {
  const o = orderById(id); if (!o) return;
  const lines = shortageFor(o) || [];
  const bad = lines.filter(l => l.status === 'short' || l.status === 'on-order');
  if (!bad.length) { await go(); return; }
  const shortLines = bad.map(l => ({ materialId: l.materialId, name: l.name, unit: l.unit, short: l.short, supplier: l.supplier }));
  const m = openModal('Materials for ' + (o.orderNo || 'this order'), `
    <p>${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}: ${bad.filter(l => l.status === 'short').length ? '<strong>not everything is on the shelf.</strong>' : 'what is missing is on order.'} It can go onto the floor anyway; it then shows <span class="chip late">material short</span> until the shelf is right.</p>
    ${linesHtml(lines)}
    <div class="btn-row" style="margin-top:.8rem"><button type="button" class="btn ghost" id="sc-order">Order what is short</button></div>`, {
    okLabel: 'Release anyway', cancelLabel: 'Not now',
    onOk: async () => {
      await go();
      try { await store.update('orders', id, { shortAtRelease: shortLines.map(({ supplier, ...l }) => l) }, 'Released short of ' + shortLines.map(l => l.name).join(', ')); }
      catch (e) { /* the release stands; the tag is a help */ }
    }
  });
  m.wrap.querySelector('#sc-order').addEventListener('click', () => { m.close(); orderShort(shortLines); });
}

// The tag on a released order still short, and its button.
export function shortTag(o) {
  const s = shortNow(o);
  if (!s.length) return '';
  return `<span class="chip late" title="Short: ${esc(s.map(l => l.name).join(', '))}">material short</span>`;
}
export const isShort = (o) => shortNow(o).length > 0;
export function orderShortFor(id) {
  const o = orderById(id); if (!o) return;
  orderShort(shortNow(o).map(l => ({ ...l, short: l.short || 1, supplier: (materialById(l.materialId) || {}).supplier || '' })));
}
