// Customers — the factory's own client list. Bellville Furniture is one entry
// among others, which is what keeps this system Couch Potato's rather than a
// copy of any one customer's workflow.
import * as store from './store.js';
import { esc, field, row, val, openModal, toast, empty, niceDate } from './ui.js';

let customers = [];
let unwatch = null;
let onChange = null;

export function startCustomers(cb) {
  onChange = cb;
  if (unwatch) unwatch();
  unwatch = store.watch('customers', (rows) => {
    customers = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (onChange) onChange(customers);
  });
}

export const allCustomers = () => customers;
export const customerById = (id) => customers.find(c => c.id === id) || null;

function form(c) {
  c = c || {};
  return row(
    field('Customer name', 'cu-name', { value: c.name, placeholder: 'e.g. Bellville Furniture' }),
    field('Contact person', 'cu-contact', { value: c.contact, placeholder: 'Who we deal with' })
  ) + row(
    field('Phone', 'cu-phone', { value: c.phone, placeholder: '082 555 1234' }),
    field('Email', 'cu-email', { value: c.email, type: 'email', placeholder: 'orders@example.co.za' })
  ) + row(
    field('Area', 'cu-area', { value: c.area, placeholder: 'e.g. Durbanville' }),
    field('Payment terms (days)', 'cu-terms', { value: c.termsDays == null ? 30 : c.termsDays, type: 'number', min: 0 })
  ) + field('Delivery address', 'cu-address', { value: c.address, type: 'textarea', placeholder: 'Street, suburb, city' })
    + field('Notes', 'cu-notes', { value: c.notes, type: 'textarea', placeholder: 'Anything worth remembering about this customer' });
}

function read(wrap) {
  return {
    name: val(wrap, 'cu-name'),
    contact: val(wrap, 'cu-contact'),
    phone: val(wrap, 'cu-phone'),
    email: val(wrap, 'cu-email'),
    area: val(wrap, 'cu-area'),
    termsDays: parseInt(val(wrap, 'cu-terms'), 10) || 0,
    address: val(wrap, 'cu-address'),
    notes: val(wrap, 'cu-notes')
  };
}

export function newCustomer() {
  openModal('New customer', form(null), {
    okLabel: 'Save customer',
    onOk: async (wrap) => {
      const d = read(wrap);
      if (!d.name) { toast('Give the customer a name', 'warn'); return false; }
      await store.create('customers', d);
      toast('Customer added');
    }
  });
}

export function editCustomer(id) {
  const c = customerById(id);
  if (!c) return;
  openModal('Edit ' + c.name, form(c), {
    okLabel: 'Save changes',
    onOk: async (wrap) => {
      const d = read(wrap);
      if (!d.name) { toast('Give the customer a name', 'warn'); return false; }
      await store.update('customers', id, d, 'Customer details updated');
      toast('Customer updated');
    }
  });
}

export async function deleteCustomer(id, orderCount) {
  const c = customerById(id);
  if (!c) return;
  if (orderCount > 0) {
    toast(c.name + ' has ' + orderCount + ' order(s) — move or remove those first', 'warn');
    return;
  }
  if (!confirm('Remove ' + c.name + ' from the customer list?')) return;
  await store.remove('customers', id);
  toast('Customer removed');
}

export function renderCustomers(host, orders) {
  const counts = {};
  (orders || []).forEach(o => { counts[o.customerId] = (counts[o.customerId] || 0) + 1; });
  const openCounts = {};
  (orders || []).forEach(o => {
    if (o.status !== 'invoiced' && o.status !== 'cancelled') openCounts[o.customerId] = (openCounts[o.customerId] || 0) + 1;
  });

  host.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Customers</h1>
        <p class="sub">${customers.length} customer${customers.length === 1 ? '' : 's'} on the books</p>
      </div>
      <button class="btn primary" data-act="new-customer">＋ New customer</button>
    </div>
    ${customers.length ? `<div class="grid cards">${customers.map(c => `
      <div class="card cust">
        <div class="cust-top">
          <h2>${esc(c.name)}</h2>
          <span class="count">${openCounts[c.id] || 0} open</span>
        </div>
        <div class="meta">
          ${c.contact ? `<div>👤 ${esc(c.contact)}</div>` : ''}
          ${c.phone ? `<div>📱 ${esc(c.phone)}</div>` : ''}
          ${c.email ? `<div>✉️ ${esc(c.email)}</div>` : ''}
          ${c.area || c.address ? `<div>📍 ${esc([c.address, c.area].filter(Boolean).join(', '))}</div>` : ''}
          <div class="muted">Terms: ${c.termsDays ? c.termsDays + ' days' : 'on collection'} · ${counts[c.id] || 0} order${(counts[c.id] || 0) === 1 ? '' : 's'} all time</div>
          ${c.createdAt ? `<div class="muted">Added ${esc(niceDate(c.createdAt))}</div>` : ''}
        </div>
        ${c.notes ? `<p class="notes">${esc(c.notes)}</p>` : ''}
        <div class="card-actions">
          <button class="btn ghost sm" data-act="edit-customer" data-id="${esc(c.id)}">✏️ Edit</button>
          <button class="btn danger sm" data-act="del-customer" data-id="${esc(c.id)}" data-n="${counts[c.id] || 0}">🗑 Remove</button>
        </div>
      </div>`).join('')}</div>`
      : empty('👥', 'No customers yet', 'Add the factory’s first customer to start capturing orders against it.')}
  `;
}
