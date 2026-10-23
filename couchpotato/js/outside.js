// Outside work — a step a supplier does (frames bought in, CNC parts,
// spraying), phase 3 of the job cards spec. Its job card is not timed on a
// tablet: when it is Ready, someone sends the piece out (supplier, the date
// it is due back, the quote); when it comes back it is booked in, which
// finishes the card and makes the next step Ready; the supplier's invoice is
// entered when it arrives, and is the step's actual cost (the quote until
// then). Overdue work shows first here and on Today.
//
//   jobCards/<id>  status 'out' while at the supplier; outsourced: supplier,
//                  quote, days, sentAt, dueAt, receivedAt, invoice, invoiceRef;
//                  outsideOpen until the invoice is in
import * as store from './store.js';
import { orderById } from './orders.js';
import { doneCard } from './jobs.js';
import { refreshActual } from './jobcost.js';
import { allSuppliers } from './suppliers.js';
import { nameOf } from './clientgroups.js';
import { esc, money, openModal, toast, today, addDays, niceDate, daysUntil, empty, field, row, val } from './ui.js';

let list = [];            // outsourced cards not yet invoiced (ready, out, or back)
let settings = {};
let onChange = null;
let unwatch = null;
export function startOutside(cb, cfg) {
  onChange = cb; settings = cfg || {};
  if (unwatch) unwatch();
  unwatch = store.watchWhere('jobCards', [['outsideOpen', '==', true]], rows => { list = rows; if (onChange) onChange(); });
}
export const setOutsideSettings = (cfg) => { settings = cfg || {}; };
const cur = () => settings.currency || 'R';
const who = () => (store.getUser() || {}).name || '';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const mayAct = () => ['factory', 'orders'].some(a => store.can(a, 'edit'));

export const outsideCards = () => list;
export const atSuppliers = () => list.filter(c => c.status === 'out');
export const overdueOutside = () => atSuppliers().filter(c => c.outsourced && c.outsourced.dueAt && c.outsourced.dueAt < today());

// ---------------------------------------------------------- the actions ----

export function sendOut(cardId) {
  const c = list.find(x => x.id === cardId); if (!c) return;
  const o = c.outsourced || {}, ord = orderById(c.orderId) || {};
  const due = addDays(today(), Number(o.days) || 7);
  const { wrap } = openModal('Send out · ' + c.operationName + ' · ' + (c.orderNo || ''), `
    <p><strong>${esc(c.product || '')}${Number(c.qty) > 1 ? ' × ' + esc(c.qty) : ''}</strong> · ${esc(nameOf(ord))}</p>
    ${row(field('Supplier', 'ow-sup', { value: o.supplier, list: 'ow-sup-list' }), field('Due back', 'ow-due', { type: 'date', value: due }))}
    ${row(field('Their quote, excl. VAT (' + cur() + ')', 'ow-quote', { type: 'number', min: 0, step: '0.01', value: o.quote || '' }), '<div></div>')}
    <datalist id="ow-sup-list">${allSuppliers().map(x => `<option value="${esc(x.name)}"></option>`).join('')}</datalist>`, {
    okLabel: 'Sent out',
    onOk: async (w) => {
      const supplier = val(w, 'ow-sup').trim(), dueAt = val(w, 'ow-due'), quote = r2(parseFloat(val(w, 'ow-quote')) || 0);
      if (!supplier || !dueAt) { toast('Say who it went to and when it is due back', 'warn'); return false; }
      try {
        await store.batchWrite([
          { op: 'update', coll: 'jobCards', id: c.id, patch: { status: 'out', outsourced: { ...o, supplier, dueAt, quote, sentAt: store.nowIso(), sentBy: who() } } },
          { op: 'update', coll: 'orders', id: c.orderId, patch: {}, event: c.operationName + ': sent to ' + supplier + ', due back ' + niceDate(dueAt) }
        ]);
      } catch (e) { toast(e.message, 'warn'); return false; }
      toast((c.orderNo || '') + ' sent to ' + supplier);
    }
  });
  return wrap;
}

export async function bookBack(cardId) {
  const c = list.find(x => x.id === cardId); if (!c) return;
  const o = c.outsourced || {};
  if (!confirm((c.orderNo || '') + ': ' + c.operationName + ' back from ' + (o.supplier || 'the supplier') + '?')) return;
  try {
    await store.batchWrite([
      { op: 'update', coll: 'jobCards', id: c.id, patch: { outsourced: { ...o, receivedAt: store.nowIso(), receivedBy: who() }, outsideOpen: o.invoice == null } },
      { op: 'update', coll: 'orders', id: c.orderId, patch: {}, event: c.operationName + ': back from ' + (o.supplier || 'the supplier') }
    ]);
    await doneCard(c.id, '', Number(c.qty) || 1, '');
  } catch (e) { toast(e.message, 'warn'); return; }
  toast((c.orderNo || '') + ': ' + c.operationName + ' booked back in');
}

export function enterInvoice(cardId) {
  const c = list.find(x => x.id === cardId); if (!c) return;
  const o = c.outsourced || {};
  openModal('Supplier invoice · ' + c.operationName + ' · ' + (c.orderNo || ''), `
    <p>${esc(o.supplier || '')} quoted ${esc(money(o.quote || 0, cur()))}.</p>
    ${row(field('Invoice amount, excl. VAT (' + cur() + ')', 'ow-inv', { type: 'number', min: 0, step: '0.01', value: o.quote || '' }), field('Their invoice number', 'ow-ref', { value: o.invoiceRef || '' }))}`, {
    okLabel: 'Save',
    onOk: async (w) => {
      const invoice = r2(parseFloat(val(w, 'ow-inv')));
      if (isNaN(invoice)) { toast('Put in the invoice amount', 'warn'); return false; }
      try {
        await store.batchWrite([
          { op: 'update', coll: 'jobCards', id: c.id, patch: { outsourced: { ...o, invoice, invoiceRef: val(w, 'ow-ref').trim() }, outsideOpen: !o.receivedAt && c.open !== false ? true : false } },
          { op: 'update', coll: 'orders', id: c.orderId, patch: {}, event: c.operationName + ': ' + (o.supplier || 'supplier') + ' invoice ' + money(invoice, cur()) + (o.quote ? ' (quoted ' + money(o.quote, cur()) + ')' : '') }
        ]);
      } catch (e) { toast(e.message, 'warn'); return false; }
      refreshActual(c.orderId).catch(() => {});
      toast('Invoice saved');
    }
  });
}

export async function outsideAction(act, el) {
  if (!mayAct()) { toast('Your role can look at the floor, not send work out', 'warn'); return; }
  if (act === 'ow-send') return sendOut(el.dataset.id);
  if (act === 'ow-back') return bookBack(el.dataset.id);
  if (act === 'ow-invoice') return enterInvoice(el.dataset.id);
}

// ---------------------------------------------------------- the screen ----

function rowHtml(c, buttons) {
  const o = c.outsourced || {}, ord = orderById(c.orderId) || {};
  const late = c.status === 'out' && o.dueAt && o.dueAt < today();
  return `<tr class="${late ? 'late' : ''}"><td><strong>${esc(c.orderNo || '')}</strong><div class="muted">${esc(nameOf(ord))}</div></td>
    <td>${esc(c.product || '')}${Number(c.qty) > 1 ? ' × ' + esc(c.qty) : ''}<div class="muted">${esc(c.operationName)}</div></td>
    <td>${esc(o.supplier || '—')}</td>
    <td>${o.sentAt ? esc(niceDate(o.sentAt.slice(0, 10))) : '<span class="muted">—</span>'}</td>
    <td>${o.dueAt ? (late ? `<span class="chip late">${-daysUntil(o.dueAt)}d overdue</span>` : esc(niceDate(o.dueAt))) : '<span class="muted">—</span>'}</td>
    <td class="r">${esc(money(o.invoice != null ? o.invoice : o.quote || 0, cur()))}<div class="muted">${o.invoice != null ? 'invoiced' : 'quoted'}</div></td>
    <td class="r nowrap">${mayAct() ? buttons : ''}</td></tr>`;
}
const table = (rows) => `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Order</th><th>What</th><th>Supplier</th><th>Sent</th><th>Due back</th><th class="r">Cost</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

export function outsideHtml() {
  const ready = list.filter(c => c.open !== false && (c.status === 'ready' || c.status === 'paused'));
  const out = atSuppliers().sort((a, b) => String((a.outsourced || {}).dueAt).localeCompare(String((b.outsourced || {}).dueAt)));
  const back = list.filter(c => c.status === 'done' && (c.outsourced || {}).invoice == null);
  const waiting = list.filter(c => c.status === 'waiting');
  if (!ready.length && !out.length && !back.length && !waiting.length) return empty('', 'Nothing at suppliers', 'Steps done outside (Costing → Workstations & steps → a step "done outside") show here when their order is released: send them out, book them back in, enter the invoice.');
  const inv = (c) => `<button class="btn ghost sm" data-act="ow-invoice" data-id="${esc(c.id)}">Invoice</button>`;
  return (ready.length ? `<h2 class="cat">Ready to send out</h2>` + table(ready.map(c => rowHtml(c, `<button class="btn primary sm" data-act="ow-send" data-id="${esc(c.id)}">Send out</button>`)).join('')) : '')
    + `<h2 class="cat">At suppliers${out.length ? ' (' + out.length + ')' : ''}</h2>` + (out.length ? table(out.map(c => rowHtml(c, `<button class="btn primary sm" data-act="ow-back" data-id="${esc(c.id)}">Back in</button> ${inv(c)}`)).join('')) : '<p class="muted">Nothing out right now.</p>')
    + (back.length ? `<h2 class="cat">Back, invoice to come</h2>` + table(back.map(c => rowHtml(c, inv(c))).join('')) : '')
    + (waiting.length ? `<p class="muted">Coming up: ${waiting.map(c => esc(c.orderNo + ' ' + c.operationName)).join(', ')} (still at an earlier step).</p>` : '');
}
