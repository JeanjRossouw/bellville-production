// Deliveries — the office side. Finished pieces get a date, a time slot and a
// driver; each driver gets their day's run on WhatsApp with a private link
// to the driver page (js/driver.js), where the client signs on delivery.
//
// An order carries its delivery on itself:
//   deliveryDate, deliverySlot, driverId, driverName,
//   deliveryContact, deliveryPhone, deliveryAddress, deliveryInstructions,
//   driverStatus (scheduled | on-way | late | issue | delivered), driverNote,
//   deliveredAt, deliveredBy, signedBy, hasDeliveryNote
// The signed note itself (a picture) lives in deliveryNotes/<order id>.
import * as store from './store.js';
import { customerById } from './customers.js';
import { esc, field, row, val, openModal, toast, empty, today, addDays, niceDate, waDigits, openPrint, docHeader } from './ui.js';

export const SLOTS = ['08:00 - 10:00', '10:00 - 12:00', '12:00 - 14:00', '14:00 - 16:00', '16:00 - 18:00', '18:00 - 20:00'];
const STATUS = {
  scheduled: ['Scheduled', 'st-new'], 'on-way': ['On the way', 'st-prod'], late: ['Running late', 'st-ready'],
  issue: ['Problem', 'late'], delivered: ['Delivered', 'st-disp']
};

let drivers = [];
let settings = {};
let onChange = null;
let unwatch = null;
let view = 'plan';            // plan | drivers | done
let day = '';                 // the day being planned

// Driver records hold each driver's private link, so only roles that may
// edit deliveries load them; a view-only role sees names from the orders.
export function startDeliveries(cb, cfg, mayEdit) {
  onChange = cb;
  settings = cfg || {};
  if (unwatch) unwatch();
  if (!mayEdit) { drivers = []; return; }
  unwatch = store.watch('drivers', rows => { drivers = rows.filter(d => !d.removed).sort((a, b) => String(a.name).localeCompare(String(b.name))); if (onChange) onChange(); });
}
export const setDeliverySettings = (cfg) => { settings = cfg || {}; };
export const setDeliveryView = (v) => { view = v; };
export const setDeliveryDay = (d) => { day = d; view = 'plan'; };
const driverById = (id) => drivers.find(d => d.id === id) || null;
const driverNameOf = (o) => (driverById(o.driverId) || {}).name || o.driverName || '';
const chip = (o) => { const [l, c] = STATUS[o.driverStatus || 'scheduled'] || STATUS.scheduled; return `<span class="chip ${c}">${esc(l)}${o.driverStatus === 'late' && o.driverNote ? ' · ' + esc(o.driverNote) : ''}${o.driverStatus === 'issue' && o.driverNote ? ': ' + esc(o.driverNote) : ''}</span>`; };

function newCode() {
  const b = new Uint8Array(12); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const driverLink = (d) => location.origin + location.pathname + '?driver=' + ((store.getCompany() || {}).id || 'demo') + '.' + d.token;

// Still to go out: finished, or being built and already planned.
const toDeliver = (orders) => orders.filter(o => !o.deliveredAt && (o.status === 'ready' || o.status === 'in-production' || (o.status === 'dispatched' && o.deliveryDate) || o.deliveryDate));
const addressOf = (o) => { const c = customerById(o.customerId) || {}; return o.deliveryAddress || [c.address, c.area].filter(Boolean).join(', '); };
const phoneOf = (o) => o.deliveryPhone || (customerById(o.customerId) || {}).phone || '';

// ---------------------------------------------------------------- render ----

export function renderDeliveries(host, orders) {
  const t = today();
  if (!day) day = t;
  const open = toDeliver(orders);
  const unscheduled = open.filter(o => !o.deliveryDate);
  const days = [...Array(7)].map((_, i) => addDays(t, i));
  const count = (d) => open.filter(o => o.deliveryDate === d).length;
  const overdue = open.filter(o => o.deliveryDate && o.deliveryDate < t);
  const tab = (k, label) => `<button class="btn ${view === k ? 'primary' : 'ghost'} sm" data-act="dl-view" data-to="${k}">${esc(label)}</button>`;
  let body;
  if (view === 'drivers') body = renderDrivers();
  else if (view === 'done') body = renderDone(orders);
  else body = renderPlan(open, unscheduled, overdue, days, count);
  host.innerHTML = `
    <div class="page-head"><div><h1>Deliveries</h1><p class="sub">Plan the run, send it to the driver, and see it signed for.</p></div>
      <div class="btn-row"><button class="btn primary" data-act="dl-driver-new">＋ Driver</button></div></div>
    <div class="btn-row" style="margin:.2rem 0 .9rem">${tab('plan', 'Plan')}${tab('drivers', 'Drivers (' + drivers.length + ')')}${tab('done', 'Delivered')}</div>
    ${body}`;
}

function card(o, opts) {
  const dn = driverNameOf(o);
  const addr = addressOf(o);
  return `<div class="dl-card ${o.driverStatus === 'issue' ? 'issue' : ''}">
    <div class="dl-main">
      <div class="dl-top"><strong>${esc(o.orderNo || '')}</strong> ${o.deliveryDate ? chip(o) : ''} ${o.status === 'in-production' ? '<span class="chip st-prod">still on the floor</span>' : ''}</div>
      <div class="dl-prod">${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}${o.fabric ? ' <span class="muted">· ' + esc(o.fabric) + '</span>' : ''}</div>
      <div class="muted">${esc(o.deliveryContact || o.customerName || '')}${phoneOf(o) ? ' · ' + esc(phoneOf(o)) : ''}</div>
      <div class="muted">${addr ? esc(addr) : '<span style="color:#b91c1c">no delivery address yet</span>'}</div>
      ${o.deliveryDate && !opts.noWhen ? `<div class="dl-when">${esc(niceDate(o.deliveryDate))}${o.deliverySlot ? ' · ' + esc(o.deliverySlot) : ''}${dn ? ' · ' + esc(dn) : ' · <span style="color:#b91c1c">no driver</span>'}</div>` : ''}
      ${o.deliveryInstructions ? `<div class="muted">Note: ${esc(o.deliveryInstructions)}</div>` : ''}
    </div>
    <div class="dl-acts">
      <button class="btn ${o.deliveryDate ? 'ghost' : 'primary'} sm" data-act="dl-schedule" data-id="${esc(o.id)}">${o.deliveryDate ? 'Change' : 'Schedule'}</button>
      ${o.deliveryDate && phoneOf(o) ? `<button class="btn ghost sm" data-act="dl-confirm" data-id="${esc(o.id)}">WhatsApp client</button>` : ''}
      ${o.deliveryDate ? `<button class="btn ghost sm" data-act="dl-delivered" data-id="${esc(o.id)}">Delivered</button>` : ''}
    </div>
  </div>`;
}

function renderPlan(open, unscheduled, overdue, days, count) {
  const dayBtn = (d, label) => `<button class="dl-day ${day === d ? 'on' : ''}" data-act="dl-day" data-to="${d}"><span>${esc(label)}</span><strong>${count(d)}</strong></button>`;
  const onDay = open.filter(o => o.deliveryDate === day).sort((a, b) => String(a.deliverySlot || '~').localeCompare(String(b.deliverySlot || '~')));
  const groups = {};
  onDay.forEach(o => { const k = o.driverId || ''; (groups[k] = groups[k] || []).push(o); });
  const groupHtml = Object.keys(groups).sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1)).map(k => {
    const d = driverById(k);
    const name = k ? driverNameOf(groups[k][0]) : '';
    return `<div class="card dl-run">
      <div class="dl-run-head"><h2>${name ? esc(name) : 'No driver yet'} <span class="muted">· ${groups[k].length} stop${groups[k].length === 1 ? '' : 's'}</span></h2>
        ${d ? `<div class="btn-row"><button class="btn primary sm" data-act="dl-send-run" data-id="${esc(k)}">Send run on WhatsApp</button><button class="btn ghost sm" data-act="dl-print-run" data-id="${esc(k)}">Print run sheet</button></div>` : ''}</div>
      ${groups[k].map(o => card(o, { noWhen: false })).join('')}
    </div>`;
  }).join('');
  return `
    ${overdue.length ? `<p class="notice-inline">${overdue.length} deliver${overdue.length === 1 ? 'y was' : 'ies were'} due before today and ${overdue.length === 1 ? 'is' : 'are'} not marked delivered: ${overdue.map(o => esc(o.orderNo)).join(', ')}.</p>` : ''}
    <div class="dl-days">${days.map((d, i) => dayBtn(d, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(d + 'T00:00:00').toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }))).join('')}
      <input type="date" class="dl-pick" data-act="dl-day-pick" value="${esc(day)}" title="Another day"></div>
    <h2 style="margin-top:1rem">${esc(niceDate(day))}</h2>
    ${onDay.length ? groupHtml : `<p class="muted">Nothing booked for this day yet. Schedule from the list below.</p>`}
    <h2 style="margin-top:1.4rem">Waiting for a delivery date (${unscheduled.length})</h2>
    ${unscheduled.length ? `<div class="card">${unscheduled.map(o => card(o, {})).join('')}</div>` : '<p class="muted">Everything finished has a delivery date.</p>'}`;
}

function renderDrivers() {
  if (!drivers.length) return empty('', 'No drivers yet', 'Add each driver with their cell number. They get a private link: no password, big buttons, everything sent on WhatsApp.');
  return `<div class="card">${drivers.map(d => `<div class="team-row">
      <div><div class="who-n">${esc(d.name)}</div><div class="who-e">${esc(d.phone || 'no cell number')}</div></div>
      <div class="who-e dl-link">${esc(driverLink(d))}</div>
      <div class="team-acts">
        <button class="btn primary sm" data-act="dl-driver-send" data-id="${esc(d.id)}">WhatsApp the link</button>
        <button class="btn ghost sm" data-act="dl-driver-copy" data-id="${esc(d.id)}">Copy</button>
        <button class="btn ghost sm" data-act="dl-driver-edit" data-id="${esc(d.id)}">Edit</button>
        <button class="btn ghost sm" data-act="dl-driver-relink" data-id="${esc(d.id)}" title="The old link stops working">New link</button>
        <button class="btn ghost sm" data-act="dl-driver-del" data-id="${esc(d.id)}">Remove</button>
      </div></div>`).join('')}
    <p class="muted">The link is the driver's key: anyone with it sees that driver's stops for the day. If a phone is lost, tap New link.</p></div>`;
}

function renderDone(orders) {
  const since = addDays(today(), -30);
  const done = orders.filter(o => o.deliveredAt && String(o.deliveredAt).slice(0, 10) >= since).sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)));
  if (!done.length) return empty('', 'Nothing delivered in the last 30 days', 'Deliveries show here once the driver taps Delivered.');
  return `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>Delivered</th><th>Order</th><th>To</th><th>By</th><th>Signed</th><th></th></tr></thead>
    <tbody>${done.map(o => `<tr>
      <td class="nowrap">${esc(String(o.deliveredAt).slice(0, 16).replace('T', ' '))}</td>
      <td><strong>${esc(o.orderNo)}</strong><div class="muted">${esc(o.product || '')}</div></td>
      <td>${esc(o.deliveryContact || o.customerName || '')}<div class="muted">${esc(addressOf(o))}</div></td>
      <td>${esc(o.deliveredBy || '')}</td>
      <td>${o.hasDeliveryNote ? esc(o.signedBy || 'signed') : '<span class="muted">no signature</span>'}</td>
      <td class="r nowrap">${o.hasDeliveryNote ? `<button class="btn ghost sm" data-act="dl-note" data-id="${esc(o.id)}">Signed note</button>` : ''}
        <button class="btn ghost sm" data-act="dl-undo" data-id="${esc(o.id)}">Not delivered</button></td></tr>`).join('')}</tbody>
  </table></div>`;
}

// --------------------------------------------------------------- actions ----

export function scheduleDelivery(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  const c = customerById(o.customerId) || {};
  const opts = (list, cur, blank) => [{ value: '', label: blank }].concat(list).map(x => ({ ...x, selected: x.value === cur }));
  openModal('Delivery for ' + (o.orderNo || ''), `
    <p class="muted">${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''} for ${esc(o.customerName || '')}</p>
    ${row(field('Date', 'dl-date', { type: 'date', value: o.deliveryDate || (day >= today() ? day : today()) }),
      field('Time slot', 'dl-slot', { type: 'select', value: o.deliverySlot || '', options: opts(SLOTS.map(s => ({ value: s, label: s })), o.deliverySlot, 'Any time') }))}
    ${field('Driver', 'dl-driver', { type: 'select', value: o.driverId || (drivers.length === 1 ? drivers[0].id : ''), options: opts(drivers.map(d => ({ value: d.id, label: d.name })), o.driverId, drivers.length ? 'Choose a driver…' : 'No drivers yet: add one first') })}
    ${row(field('Receiving it', 'dl-contact', { value: o.deliveryContact || c.contact || o.customerName || '' }), field('Their cell', 'dl-phone', { value: o.deliveryPhone || c.phone || '' }))}
    ${field('Delivery address', 'dl-addr', { type: 'textarea', value: o.deliveryAddress || [c.address, c.area].filter(Boolean).join(', ') })}
    ${field('Note for the driver', 'dl-note', { value: o.deliveryInstructions || '', placeholder: 'Gate code, stairs, call first…' })}`, {
    okLabel: 'Save delivery',
    onOk: async (w) => {
      const date = val(w, 'dl-date');
      if (!date) { toast('Pick the delivery date', 'warn'); return false; }
      const dId = val(w, 'dl-driver'); const d = driverById(dId);
      await store.update('orders', id, {
        deliveryDate: date, deliverySlot: val(w, 'dl-slot'), driverId: dId || '', driverName: d ? d.name : '',
        deliveryContact: val(w, 'dl-contact'), deliveryPhone: val(w, 'dl-phone'), deliveryAddress: val(w, 'dl-addr'), deliveryInstructions: val(w, 'dl-note'),
        driverStatus: 'scheduled', driverNote: ''
      }, 'Delivery booked for ' + date + (d ? ' with ' + d.name : ''));
      day = date;
      toast((o.orderNo || 'Order') + ' booked for ' + niceDate(date));
    }
  });
}

// The booking, confirmed to the client on WhatsApp.
export function confirmToClient(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  const who = String(o.deliveryContact || o.customerName || '').split(' ')[0] || 'there';
  const msg = 'Hi ' + who + ', ' + (settings.name || '') + ' here. Your ' + (o.product || 'order') + ' (' + (o.orderNo || '') + ') will be delivered on '
    + niceDate(o.deliveryDate) + (o.deliverySlot ? ' between ' + o.deliverySlot.replace(' - ', ' and ') : '') + '.'
    + (addressOf(o) ? ' To: ' + addressOf(o) + '.' : '') + ' The driver will WhatsApp you when on the way. Reply here if that time does not suit.';
  window.open('https://wa.me/' + waDigits(phoneOf(o)) + '?text=' + encodeURIComponent(msg), '_blank');
}

function runText(d, list) {
  return 'Hi ' + (d.name || '') + ', your deliveries for ' + niceDate(day) + ' (' + list.length + '):\n'
    + list.map((o, i) => (i + 1) + '. ' + (o.deliverySlot ? o.deliverySlot + ' · ' : '') + (o.product || '') + ' · ' + (o.deliveryContact || o.customerName || '') + ', ' + (addressOf(o) || 'no address')).join('\n')
    + '\n\nOpen your list here and tick each one off: ' + driverLink(d);
}
export function sendRun(driverId, orders) {
  const d = driverById(driverId); if (!d) return;
  const list = toDeliver(orders).filter(o => o.deliveryDate === day && o.driverId === driverId).sort((a, b) => String(a.deliverySlot || '~').localeCompare(String(b.deliverySlot || '~')));
  if (!d.phone) { toast('Add ' + d.name + "'s cell number first (Drivers → Edit)", 'warn'); return; }
  window.open('https://wa.me/' + waDigits(d.phone) + '?text=' + encodeURIComponent(runText(d, list)), '_blank');
}
export function printRun(driverId, orders) {
  const d = driverById(driverId); if (!d) return;
  const list = toDeliver(orders).filter(o => o.deliveryDate === day && o.driverId === driverId).sort((a, b) => String(a.deliverySlot || '~').localeCompare(String(b.deliverySlot || '~')));
  openPrint('Run sheet ' + day, `${docHeader(settings, 'RUN SHEET', niceDate(day), ['Driver ' + d.name])}
    <table><tr><th>#</th><th>Time</th><th>Order</th><th>Deliver to</th><th>Phone</th><th>Signature</th></tr>
    ${list.map((o, i) => `<tr><td>${i + 1}</td><td>${esc(o.deliverySlot || '')}</td><td><strong>${esc(o.orderNo)}</strong><br>${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}</td>
      <td>${esc(o.deliveryContact || o.customerName || '')}<br>${esc(addressOf(o))}${o.deliveryInstructions ? '<br><small>' + esc(o.deliveryInstructions) + '</small>' : ''}</td><td>${esc(phoneOf(o))}</td><td style="width:22%"></td></tr>`).join('')}
    </table>`);
}

export async function markDelivered(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  if (!confirm('Mark ' + (o.orderNo || 'this order') + ' as delivered, without a signature?')) return;
  const now = store.nowIso(); const who = (store.getUser() || {}).name || 'office';
  const patch = { driverStatus: 'delivered', driverStatusAt: now, deliveredAt: now, deliveredBy: who, hasDeliveryNote: false };
  if (['new', 'in-production', 'ready'].includes(o.status)) Object.assign(patch, { status: 'dispatched', dispatchedAt: o.dispatchedAt || now, dispatchedBy: who });
  await store.update('orders', id, patch, 'Delivered (marked by the office)');
  toast((o.orderNo || 'Order') + ' delivered');
}

export async function undoDelivered(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  if (!confirm('Put ' + (o.orderNo || 'this order') + ' back on the delivery list' + (o.hasDeliveryNote ? ' and remove its signed note' : '') + '?')) return;
  const patch = { driverStatus: 'scheduled', driverStatusAt: store.nowIso(), deliveredAt: null, deliveredBy: null, signedBy: null, hasDeliveryNote: false };
  if (o.status === 'dispatched' && !o.invoiceId) Object.assign(patch, { status: 'ready', dispatchedAt: null, dispatchedBy: null });
  await store.update('orders', id, patch, 'Delivery undone');
  if (o.hasDeliveryNote) { try { await store.remove('deliveryNotes', id); } catch (e) { /* already gone */ } }
  view = 'plan';
  toast((o.orderNo || 'Order') + ' is back on the delivery list');
}

export async function viewNote(id) {
  const n = await store.getOne('deliveryNotes', id);
  if (!n || !n.dataUrl) { toast('No signed note for this delivery', 'warn'); return; }
  openPrint('Delivery note ' + (n.orderNo || ''), `<p>Signed by <strong>${esc(n.signedBy || '')}</strong> · ${esc(String(n.at || '').slice(0, 16).replace('T', ' '))} · driver ${esc(n.driver || '')}</p><img src="${n.dataUrl}" style="max-width:100%; border:1px solid #000">`);
}

// ----------------------------------------------------------------- drivers --

function driverForm(d) {
  return row(field('Name', 'dr-name', { value: d.name, placeholder: 'e.g. Sipho' }), field('Cell number', 'dr-phone', { value: d.phone, placeholder: 'For WhatsApp' }));
}
export function newDriver() {
  openModal('New driver', driverForm({}), {
    okLabel: 'Add driver',
    onOk: async (w) => {
      const name = val(w, 'dr-name'); if (!name) { toast('Give the driver a name', 'warn'); return false; }
      view = 'drivers';    // show the list it lands in (the save repaints the screen)
      await store.create('drivers', { name, phone: val(w, 'dr-phone'), token: newCode() });
      if (onChange) onChange();
      toast(name + ' added — WhatsApp them their link');
    }
  });
}
export function editDriver(id) {
  const d = driverById(id); if (!d) return;
  openModal('Edit ' + d.name, driverForm(d), {
    okLabel: 'Save', onOk: async (w) => { const name = val(w, 'dr-name'); if (!name) return false; await store.update('drivers', id, { name, phone: val(w, 'dr-phone') }); }
  });
}
export function sendDriverLink(id) {
  const d = driverById(id); if (!d) return;
  if (!d.phone) { toast('Add ' + d.name + "'s cell number first", 'warn'); return; }
  const msg = 'Hi ' + d.name + ', this is your delivery list for ' + (settings.name || '') + '. Save this link and open it every morning: ' + driverLink(d);
  window.open('https://wa.me/' + waDigits(d.phone) + '?text=' + encodeURIComponent(msg), '_blank');
}
export async function copyDriverLink(id) {
  const d = driverById(id); if (!d) return;
  try { await navigator.clipboard.writeText(driverLink(d)); toast('Link copied'); } catch (e) { prompt('Copy this link:', driverLink(d)); }
}
export async function relinkDriver(id) {
  const d = driverById(id); if (!d) return;
  if (!confirm('Give ' + d.name + ' a new link? The old one stops working straight away.')) return;
  await store.update('drivers', id, { token: newCode() });
  toast('New link made — WhatsApp it to ' + d.name);
}
export async function removeDriver(id, orders) {
  const d = driverById(id); if (!d) return;
  const booked = toDeliver(orders).filter(o => o.driverId === id && o.deliveryDate >= today()).length;
  if (!confirm('Remove ' + d.name + '? Their link stops working.' + (booked ? ' ' + booked + ' booked deliver' + (booked === 1 ? 'y needs' : 'ies need') + ' another driver.' : ''))) return;
  await store.update('drivers', id, { removed: true, disabled: true, token: newCode() });
  toast(d.name + ' removed');
}
