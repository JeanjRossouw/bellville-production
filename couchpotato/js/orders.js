// Orders — the spine of the factory system. One Firestore document per order.
//
// An order's life: new → in production → ready → dispatched (scanned out at the
// door) → invoiced. Each step stamps who did it and when, on the order itself,
// so there is always an answer to "who changed this and when".
import * as store from './store.js';
import { allCustomers, customerById } from './customers.js';
import { allProducts, productByName } from './costing.js';
import { consumeForOrder, returnForOrder } from './stock.js';
import {
  esc, money, field, row, val, openModal, toast, empty, today, addDays,
  niceDate, daysUntil, statusChip, statusMeta, STATUSES, fabricChip, FABRIC_STATES
} from './ui.js';

let orders = [];
let unwatch = null;
let onChange = null;
let settings = {};

export function startOrders(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  if (unwatch) unwatch();
  unwatch = store.watch('orders', (rows) => {
    orders = rows.sort((a, b) => String(b.orderNo || '').localeCompare(String(a.orderNo || ''), undefined, { numeric: true }));
    if (onChange) onChange(orders);
  });
}

export const allOrders = () => orders;
export const setOrderSettings = (cfg) => { settings = cfg || {}; };
export const orderById = (id) => orders.find(o => o.id === id) || null;

// ------------------------------------------------------------- capture ------

function form(o) {
  o = o || {};
  const custs = allCustomers();
  const custOptions = [{ value: '', label: custs.length ? 'Choose a customer…' : 'No customers yet — add one first' }]
    .concat(custs.map(c => ({ value: c.id, label: c.name })));
  const paid = o.paidDate || today();
  return row(
    field('Customer', 'o-cust', { type: 'select', options: custOptions, value: o.customerId || '' }),
    field('Their order / invoice no.', 'o-ref', { value: o.externalRef, placeholder: 'So both sides can match it up' })
  ) + row(
    field('Product', 'o-product', { value: o.product, placeholder: 'e.g. 3 Seater Chesterfield', list: 'o-product-list' }),
    field('Qty', 'o-qty', { value: o.qty || 1, type: 'number', min: 1 })
  ) + row(
    field('Fabric / colour', 'o-fabric', { value: o.fabric, placeholder: 'e.g. Moldova : Oatmeal' }),
    field('Price each (excl. VAT)', 'o-price', { value: o.priceEach || '', type: 'number', min: 0, step: '0.01', placeholder: '0.00' })
  ) + row(
    field('Date paid / order placed', 'o-paid', { value: paid, type: 'date' }),
    field('Due out of the factory', 'o-due', { value: o.dueDate || addDays(paid, 28), type: 'date' })
  ) + field('Notes for the floor', 'o-notes', { value: o.notes, type: 'textarea', placeholder: 'Anything the builders must know' })
    + `<datalist id="o-product-list">${allProducts().map(p => `<option value="${esc(p.name)}"></option>`).join('')}</datalist>`;
}

// Picking a catalogue product fills in its selling price (unless a price was typed already).
function wireProductPrice(wrap) {
  const prod = wrap.querySelector('#o-product'), price = wrap.querySelector('#o-price');
  let priceTouched = !!price.value;
  price.addEventListener('input', () => { priceTouched = !!price.value; });
  const fill = () => { const p = productByName(prod.value); if (p && p.sellingPrice && !priceTouched) price.value = p.sellingPrice; };
  prod.addEventListener('change', fill);
  prod.addEventListener('input', fill);
}

function read(wrap) {
  const customerId = val(wrap, 'o-cust');
  const c = customerById(customerId);
  return {
    customerId,
    customerName: c ? c.name : '',
    externalRef: val(wrap, 'o-ref'),
    product: val(wrap, 'o-product'),
    qty: parseInt(val(wrap, 'o-qty'), 10) || 1,
    fabric: val(wrap, 'o-fabric'),
    priceEach: parseFloat(val(wrap, 'o-price')) || 0,
    paidDate: val(wrap, 'o-paid'),
    dueDate: val(wrap, 'o-due'),
    notes: val(wrap, 'o-notes')
  };
}

export function newOrder() {
  if (!allCustomers().length) {
    toast('Add a customer first — every order belongs to one', 'warn');
    return;
  }
  const { wrap } = openModal('New order', form(null), {
    okLabel: 'Save order',
    onOk: async (w) => {
      const d = read(w);
      if (!d.customerId) { toast('Choose which customer this is for', 'warn'); return false; }
      if (!d.product) { toast('Say what is being built', 'warn'); return false; }
      const n = await store.nextNumber('orderNo', settings.firstOrderNo || 1001);
      await store.create('orders', {
        ...d,
        orderNo: (settings.orderPrefix || 'CP-') + n,
        source: 'manual',
        status: 'new',
        fabricStatus: 'none',
        events: [{ at: store.nowIso(), by: (store.getUser() || {}).name || 'system', what: 'Order captured' }]
      });
      toast('Order ' + (settings.orderPrefix || 'CP-') + n + ' captured');
    }
  });
  // Keep the due date 4 weeks after the paid date while the user is typing,
  // unless they have deliberately changed it themselves.
  const paid = wrap.querySelector('#o-paid');
  const due = wrap.querySelector('#o-due');
  wireProductPrice(wrap);
  let dueTouched = false;
  due.addEventListener('input', () => { dueTouched = true; });
  paid.addEventListener('change', () => { if (!dueTouched) due.value = addDays(paid.value, 28); });
}

export function editOrder(id) {
  const o = orderById(id);
  if (!o) return;
  const { wrap: editWrap } = openModal('Edit ' + (o.orderNo || 'order'), form(o), {
    okLabel: 'Save changes',
    onOk: async (w) => {
      const d = read(w);
      if (!d.customerId) { toast('Choose which customer this is for', 'warn'); return false; }
      if (!d.product) { toast('Say what is being built', 'warn'); return false; }
      await store.update('orders', id, d, 'Order details updated');
      toast('Order updated');
    }
  });
  wireProductPrice(editWrap);
}

export async function deleteOrder(id) {
  const o = orderById(id);
  if (!o) return;
  if (!confirm('Delete ' + (o.orderNo || 'this order') + ' — ' + (o.product || '') + '?')) return;
  // its materials came off the shelf when it started: put them back if it was never built
  if (o.materialsUsed && (o.status === 'new' || o.status === 'in-production')
      && confirm('Put the materials for ' + (o.orderNo || 'this order') + ' back in stock?')) await returnForOrder(o, 'deleted');
  await store.remove('orders', id);
  toast('Order deleted');
}

// -------------------------------------------------------------- changes -----

export async function setStatus(id, status) {
  const o = orderById(id);
  if (!o) return;
  const meta = statusMeta(status);
  const patch = { status };
  if (status === 'dispatched' && !o.dispatchedAt) {
    patch.dispatchedAt = store.nowIso();
    patch.dispatchedBy = (store.getUser() || {}).name || 'system';
  }
  // Sold at the till: already on an invoice, so leaving the door completes it.
  if (status === 'dispatched' && o.invoiceId) patch.status = 'invoiced';
  await store.update('orders', id, patch, 'Moved to ' + meta.label);
  // Stock: materials come off the shelf when an order leaves New (building
  // starts, or it skips straight past that), and go back if it is moved back
  // to New. Orders already past New when stock tracking began are left
  // alone: their materials were off the shelf before the first count.
  try {
    if (o.status === 'new' && status !== 'new' && !o.materialsUsed) await consumeForOrder(o);
    if (status === 'new' && o.materialsUsed) await returnForOrder(o);
  } catch (e) { console.error('stock update failed:', e); toast('Status saved, but stock could not be updated: ' + e.message, 'warn'); }
  toast((o.orderNo || 'Order') + ' → ' + meta.label);
}

export async function setFabric(id, fabricStatus) {
  const f = FABRIC_STATES.find(x => x.key === fabricStatus);
  await store.update('orders', id, { fabricStatus }, 'Fabric: ' + (f ? f.label : fabricStatus));
}

export async function setDue(id, dueDate) {
  await store.update('orders', id, { dueDate }, 'Due date set to ' + (dueDate || 'none'));
}

// ---------------------------------------------------------------- render ----

let filter = { status: 'open', customer: '', q: '' };
export const setFilter = (patch) => { filter = { ...filter, ...patch }; };
export const getFilter = () => filter;

function matches(o) {
  if (filter.status === 'open' && (o.status === 'invoiced' || o.status === 'cancelled')) return false;
  if (filter.status !== 'open' && filter.status !== 'all' && o.status !== filter.status) return false;
  if (filter.customer && o.customerId !== filter.customer) return false;
  const q = String(filter.q || '').toLowerCase().trim();
  if (!q) return true;
  return [o.orderNo, o.externalRef, o.product, o.fabric, o.customerName, o.notes]
    .some(v => String(v || '').toLowerCase().includes(q));
}

export function visibleOrders() { return orders.filter(matches); }

function dueBadge(o) {
  if (o.status === 'dispatched' || o.status === 'invoiced') return '';
  const d = daysUntil(o.dueDate);
  if (d == null) return '<span class="chip warn-soft">No due date</span>';
  if (d < 0) return `<span class="chip late">${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} late</span>`;
  if (d <= 7) return `<span class="chip soon">${d === 0 ? 'Due today' : 'Due in ' + d + ' day' + (d === 1 ? '' : 's')}</span>`;
  return `<span class="chip calm">${esc(niceDate(o.dueDate))}</span>`;
}

function orderCard(o) {
  const cur = settings.currency || 'R';
  const next = STATUSES[STATUSES.findIndex(s => s.key === o.status) + 1];
  return `
    <div class="card order">
      <div class="order-top">
        <div>
          <div class="order-no">${esc(o.orderNo || '—')}
            ${o.source === 'feed' ? '<span class="chip feed" title="Came through automatically from the customer’s system">auto</span>' : ''}
            ${o.source === 'shopify' ? `<span class="chip feed" title="Online order ${esc(o.shopifyOrderName || '')} from your Shopify store">online ${esc(o.shopifyOrderName || '')}</span>` : ''}
          </div>
          <h2>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' <span class="qty">× ' + esc(o.qty) + '</span>' : ''}</h2>
          <div class="meta">
            <div>${esc(o.customerName || 'No customer')}${o.externalRef ? ' · their ref ' + esc(o.externalRef) : ''}</div>
            ${o.fabric ? `<div>${esc(o.fabric)}</div>` : ''}
            ${o.paidDate ? `<div class="muted">Paid ${esc(niceDate(o.paidDate))}</div>` : ''}
            ${o.priceEach ? `<div class="muted">${esc(money(o.priceEach, cur))} each · ${esc(money(o.priceEach * (o.qty || 1), cur))} total</div>` : ''}
            ${o.planWeek ? `<div class="muted">Planned for the week of ${esc(niceDate(o.planWeek))}</div>` : ''}
          </div>
        </div>
        <div class="order-chips">
          ${statusChip(o.status)}${o.invoiceNo ? ' <span class="chip st-inv">' + esc(o.invoiceNo) + '</span>' : ''}
          ${dueBadge(o)}
          ${o.fabric ? fabricChip(o.fabricStatus) : ''}
        </div>
      </div>
      ${o.notes ? `<p class="notes">${esc(o.notes)}</p>` : ''}
      <div class="order-controls">
        <label class="inline">Due
          <input type="date" value="${esc(o.dueDate || '')}" data-act="due" data-id="${esc(o.id)}">
        </label>
        ${o.fabric ? `<label class="inline">Fabric
          <select data-act="fabric" data-id="${esc(o.id)}">
            ${FABRIC_STATES.map(f => `<option value="${f.key}"${f.key === (o.fabricStatus || 'none') ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}
          </select></label>` : ''}
      </div>
      <div class="card-actions">
        ${next ? `<button class="btn primary sm" data-act="status" data-id="${esc(o.id)}" data-to="${next.key}">${esc(next.label)}</button>` : ''}
        <button class="btn ghost sm" data-act="edit-order" data-id="${esc(o.id)}">Edit</button>
        <button class="btn danger sm" data-act="del-order" data-id="${esc(o.id)}">Delete</button>
      </div>
    </div>`;
}

export function renderOrders(host) {
  const rows = visibleOrders();
  const cur = settings.currency || 'R';
  const counts = {};
  STATUSES.forEach(s => { counts[s.key] = orders.filter(o => o.status === s.key).length; });
  const openValue = rows.reduce((s, o) => s + (Number(o.priceEach) || 0) * (o.qty || 1), 0);
  const late = rows.filter(o => {
    const d = daysUntil(o.dueDate);
    return d != null && d < 0 && o.status !== 'dispatched' && o.status !== 'invoiced';
  }).length;

  host.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Orders</h1>
        <p class="sub">${rows.length} shown · ${esc(money(openValue, cur))} on the floor${late ? ` · <span class="late-text">${late} late</span>` : ''}</p>
      </div>
      <button class="btn primary" data-act="new-order">＋ New order</button>
    </div>

    <div class="stat-strip">
      ${STATUSES.map(s => `<button class="stat ${filter.status === s.key ? 'on' : ''}" data-act="filter-status" data-to="${s.key}" title="${esc(s.help)}">
        <span class="stat-n">${counts[s.key]}</span><span class="stat-l">${esc(s.label)}</span></button>`).join('')}
    </div>

    <div class="toolbar">
      <input id="o-search" class="search" type="search" placeholder="Order no., product, fabric, customer…" value="${esc(filter.q)}">
      <select id="o-filter-cust">
        <option value="">All customers</option>
        ${allCustomers().map(c => `<option value="${esc(c.id)}"${c.id === filter.customer ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select id="o-filter-status">
        <option value="open"${filter.status === 'open' ? ' selected' : ''}>Open orders</option>
        <option value="all"${filter.status === 'all' ? ' selected' : ''}>Everything</option>
        ${STATUSES.map(s => `<option value="${s.key}"${s.key === filter.status ? ' selected' : ''}>${esc(s.label)} only</option>`).join('')}
      </select>
    </div>

    ${rows.length ? `<div class="grid cards">${rows.map(orderCard).join('')}</div>`
      : empty('', 'Nothing here', orders.length ? 'No orders match this filter.' : 'Capture the factory’s first order to get going.')}
  `;
}
