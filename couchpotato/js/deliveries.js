// Deliveries — the office side. Finished pieces get a date, a time slot and a
// driver; each driver gets their day's run on WhatsApp with a private link
// to the driver page (js/driver.js), where the client signs on delivery.
//
// An order carries its delivery on itself:
//   deliveryMethod ('' or 'delivery' = a driver takes it; 'collect' = the customer fetches it),
//   deliveryDate, deliverySlot, driverId, driverName,
//   deliveryContact, deliveryPhone, deliveryAddress, deliveryInstructions,
//   driverStatus (scheduled | on-way | late | issue | delivered), driverNote,
//   deliveredAt, deliveredBy, signedBy, hasDeliveryNote
// The signed note itself (a picture) lives in deliveryNotes/<order id>.
import * as store from './store.js';
import { customerById, allCustomers } from './customers.js';
import { esc, field, row, val, openModal, toast, empty, today, addDays, niceDate, waDigits, openPrint, docHeader } from './ui.js';
import { openSignScreen } from './sign.js';
import { contactOf, detail, seesClient } from './clientgroups.js';

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
const isCollect = (o) => o.deliveryMethod === 'collect';
const chip = (o) => {
  if (isCollect(o)) return o.driverStatus === 'delivered' ? '<span class="chip st-disp">Collected</span>' : '<span class="chip calm">Collection</span>'; const [l, c] = STATUS[o.driverStatus || 'scheduled'] || STATUS.scheduled; return `<span class="chip ${c}">${esc(l)}${o.driverStatus === 'late' && o.driverNote ? ' · ' + esc(o.driverNote) : ''}${o.driverStatus === 'issue' && o.driverNote ? ': ' + esc(o.driverNote) : ''}</span>`; };

function newCode() {
  const b = new Uint8Array(12); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const driverLink = (d) => location.origin + location.pathname + '?driver=' + ((store.getCompany() || {}).id || 'demo') + '.' + d.token;

// Still to go out: finished, or being built and already planned.
const toDeliver = (orders) => orders.filter(o => !o.deliveredAt && (o.status === 'ready' || o.status === 'in-production' || (o.status === 'dispatched' && o.deliveryDate) || o.deliveryDate));
// the order's own delivery details, else its customer's (found by name when it is not linked)
const custOf = (o) => customerById(o.customerId) || (o.customerName ? allCustomers().find(c => String(c.name || '').trim().toLowerCase() === String(o.customerName).trim().toLowerCase()) : null) || {};
const addressOf = (o) => { const c = custOf(o); return o.deliveryAddress || [c.address, c.area].filter(Boolean).join(', '); };
const phoneOf = (o) => o.deliveryPhone || custOf(o).phone || '';
// on screen, a client this role sees by group only shows its group and area, nothing more
const shownPhone = (o) => detail(o, phoneOf(o));
const shownAddress = (o) => seesClient(o) ? addressOf(o) : (custOf(o).area || 'address with the office');

// ---------------------------------------------------------------- render ----

export function renderDeliveries(host, orders) {
  const t = today();
  if (!day) day = t;
  const all = toDeliver(orders);
  const open = all.filter(o => !isCollect(o));           // by driver
  const collections = all.filter(isCollect);              // the customer fetches it
  const unscheduled = open.filter(o => !o.deliveryDate);
  const days = [...Array(7)].map((_, i) => addDays(t, i));
  const count = (d) => open.filter(o => o.deliveryDate === d).length;
  const overdue = open.filter(o => o.deliveryDate && o.deliveryDate < t);
  const tab = (k, label) => `<button class="btn ${view === k ? 'primary' : 'ghost'} sm" data-act="dl-view" data-to="${k}">${esc(label)}</button>`;
  let body;
  if (view === 'drivers') body = renderDrivers();
  else if (view === 'done') body = renderDone(orders);
  else body = renderPlan(open, unscheduled, overdue, days, count, collections);
  host.innerHTML = `
    <div class="page-head"><div><h1>Deliveries</h1><p class="sub">Plan the run, send it to the driver, and see it signed for.</p></div>
      <div class="btn-row"><button class="btn primary" data-act="dl-driver-new">＋ Driver</button></div></div>
    <div class="btn-row" style="margin:.2rem 0 .9rem">${tab('plan', 'Plan')}${tab('drivers', 'Drivers (' + drivers.length + ')')}${tab('done', 'Delivered')}</div>
    ${body}`;
}

function card(o, opts) {
  const dn = driverNameOf(o);
  const addr = shownAddress(o);
  return `<div class="dl-card ${o.driverStatus === 'issue' ? 'issue' : ''}">
    <div class="dl-main">
      <div class="dl-top"><strong>${esc(o.orderNo || '')}</strong> ${o.deliveryDate ? chip(o) : ''} ${o.status === 'in-production' ? '<span class="chip st-prod">still on the floor</span>' : ''}</div>
      <div class="dl-prod">${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}${o.fabric ? ' <span class="muted">· ' + esc(o.fabric) + '</span>' : ''}</div>
      <div class="muted">${esc(contactOf(o))}${shownPhone(o) ? ' · ' + esc(shownPhone(o)) : ''}</div>
      <div class="muted">${addr ? esc(addr) : '<span style="color:#b91c1c">no delivery address yet</span>'}</div>
      ${o.deliveryDate && !opts.noWhen ? `<div class="dl-when">${esc(niceDate(o.deliveryDate))}${o.deliverySlot ? ' · ' + esc(o.deliverySlot) : ''}${dn ? ' · ' + esc(dn) : ' · <span style="color:#b91c1c">no driver</span>'}${o.deliveryNoteNo ? ' · ' + esc(o.deliveryNoteNo) : ''}</div>` : ''}
      ${o.deliveryInstructions ? `<div class="muted">Note: ${esc(o.deliveryInstructions)}</div>` : ''}
    </div>
    <div class="dl-acts">
      <button class="btn ${o.deliveryDate ? 'ghost' : 'primary'} sm" data-act="dl-schedule" data-id="${esc(o.id)}">${o.deliveryDate ? 'Change' : 'Schedule'}</button>
      ${!o.deliveryDate ? `<button class="btn ghost sm" data-act="dl-collect" data-id="${esc(o.id)}" title="The customer fetches it from the factory">Collection</button>` : ''}
      ${o.deliveryDate && shownPhone(o) ? `<button class="btn ghost sm" data-act="dl-confirm" data-id="${esc(o.id)}">WhatsApp client</button>` : ''}
      <button class="btn ghost sm" data-act="dl-sign" data-id="${esc(o.id)}" title="The client signs the delivery note here, on this screen">Client signs</button>
      ${o.deliveryDate ? `<button class="btn ghost sm" data-act="dl-delivered" data-id="${esc(o.id)}">Delivered</button>` : ''}
    </div>
  </div>`;
}

// A piece the customer fetches: no driver, no run; the office tells them it
// is ready and marks it collected when they have it.
function collectCard(o) {
  const late = o.deliveryDate && o.deliveryDate < today() && o.status === 'ready';
  return `<div class="dl-card">
    <div class="dl-main">
      <div class="dl-top"><strong>${esc(o.orderNo || '')}</strong> ${chip(o)} ${o.status === 'in-production' ? '<span class="chip st-prod">still on the floor</span>' : o.status === 'ready' ? '<span class="chip st-ready">ready to collect</span>' : ''}</div>
      <div class="dl-prod">${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}${o.fabric ? ' <span class="muted">· ' + esc(o.fabric) + '</span>' : ''}</div>
      <div class="muted">${esc(contactOf(o))}${shownPhone(o) ? ' · ' + esc(shownPhone(o)) : ''}</div>
      <div class="dl-when" ${late ? 'style="color:#b91c1c"' : ''}>${o.deliveryDate ? 'Expected ' + esc(niceDate(o.deliveryDate)) + (late ? ' · not collected yet' : '') : 'No date yet'}</div>
      ${o.deliveryInstructions ? `<div class="muted">Note: ${esc(o.deliveryInstructions)}</div>` : ''}
    </div>
    <div class="dl-acts">
      <button class="btn ghost sm" data-act="dl-schedule" data-id="${esc(o.id)}">Change</button>
      ${shownPhone(o) ? `<button class="btn ${o.status === 'ready' ? 'primary' : 'ghost'} sm" data-act="dl-confirm" data-id="${esc(o.id)}">WhatsApp: ready</button>` : ''}
      <button class="btn ghost sm" data-act="dl-sign" data-id="${esc(o.id)}" title="The client signs for it here, on this screen">Client signs</button>
      <button class="btn ghost sm" data-act="dl-delivered" data-id="${esc(o.id)}">Collected</button>
      <button class="btn ghost sm" data-act="dl-deliver-instead" data-id="${esc(o.id)}" title="A driver takes it after all">Deliver instead</button>
    </div>
  </div>`;
}

function renderPlan(open, unscheduled, overdue, days, count, collections) {
  const dayBtn = (d, label) => `<button class="dl-day ${day === d ? 'on' : ''}" data-act="dl-day" data-to="${d}"><span>${esc(label)}</span><strong>${count(d)}</strong></button>`;
  const onDay = open.filter(o => o.deliveryDate === day).sort((a, b) => String(a.deliverySlot || '~').localeCompare(String(b.deliverySlot || '~')));
  const groups = {};
  onDay.forEach(o => { const k = o.driverId || ''; (groups[k] = groups[k] || []).push(o); });
  const groupHtml = Object.keys(groups).sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1)).map(k => {
    const d = driverById(k);
    const name = k ? driverNameOf(groups[k][0]) : '';
    return `<div class="card dl-run">
      <div class="dl-run-head"><h2>${name ? esc(name) : 'No driver yet'} <span class="muted">· ${groups[k].length} stop${groups[k].length === 1 ? '' : 's'}</span></h2>
        <div class="btn-row">${d ? `<button class="btn primary sm" data-act="dl-send-run" data-id="${esc(k)}">Send run on WhatsApp</button><button class="btn ghost sm" data-act="dl-print-run" data-id="${esc(k)}">Print run sheet</button>` : ''}<button class="btn ghost sm" data-act="dn-print" data-id="${esc(k)}" title="The run sheet and a page per stop for the client to sign">Delivery note${[...new Set(groups[k].map(o => o.deliveryNoteNo).filter(Boolean))].length ? ' ' + esc([...new Set(groups[k].map(o => o.deliveryNoteNo).filter(Boolean))].sort().join(', ')) : ''}</button></div></div>
      ${groups[k].map(o => card(o, { noWhen: false })).join('')}
    </div>`;
  }).join('');
  return `
    ${overdue.length ? `<p class="notice-inline">${overdue.length} deliver${overdue.length === 1 ? 'y was' : 'ies were'} due before today and ${overdue.length === 1 ? 'is' : 'are'} not marked delivered: ${overdue.map(o => esc(o.orderNo)).join(', ')}.</p>` : ''}
    <div class="dl-days">${days.map((d, i) => dayBtn(d, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(d + 'T00:00:00').toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }))).join('')}
      <input type="date" class="dl-pick" data-act="dl-day-pick" value="${esc(day)}" title="Another day"></div>
    <h2 style="margin-top:1rem">${esc(niceDate(day))}</h2>
    ${onDay.length ? groupHtml : `<p class="muted">Nothing booked for this day yet. Schedule from the list below.</p>`}
    ${collections.length ? `<h2 style="margin-top:1.4rem">Collections (${collections.length})</h2><div class="card">${collections.slice().sort((a, b) => String(a.deliveryDate || '~').localeCompare(String(b.deliveryDate || '~'))).map(collectCard).join('')}</div>` : ''}
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
      <td><strong>${esc(o.orderNo)}</strong>${isCollect(o) ? ' <span class="chip calm">collected</span>' : ''}<div class="muted">${esc(o.product || '')}</div></td>
      <td>${esc(contactOf(o))}<div class="muted">${isCollect(o) ? 'Collected at the factory' : esc(shownAddress(o))}</div></td>
      <td>${esc(o.deliveredBy || '')}</td>
      <td>${o.hasDeliveryNote ? esc(o.signedBy || 'signed') : '<span class="muted">no signature</span>'}</td>
      <td class="r nowrap">${o.hasDeliveryNote ? `<button class="btn ghost sm" data-act="dl-note" data-id="${esc(o.id)}">Signed note</button>` : `<button class="btn ghost sm" data-act="dl-sign" data-id="${esc(o.id)}">Client signs</button>`}
        <button class="btn ghost sm" data-act="dl-undo" data-id="${esc(o.id)}">Not delivered</button></td></tr>`).join('')}</tbody>
  </table></div>`;
}

// --------------------------------------------------------------- actions ----

export function scheduleDelivery(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  if (!seesClient(o)) { toast('The office books this delivery: your role sees this client by group only.', 'warn'); return; }
  const c = customerById(o.customerId) || {};
  const opts = (list, cur, blank) => [{ value: '', label: blank }].concat(list).map(x => ({ ...x, selected: x.value === cur }));
  const collect = isCollect(o);
  const { wrap } = openModal((collect ? 'Collection of ' : 'Delivery for ') + (o.orderNo || ''), `
    <p class="muted">${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''} for ${esc(o.customerName || '')}</p>
    ${field('How it gets to them', 'dl-method', { type: 'select', value: collect ? 'collect' : 'delivery', options: [{ value: 'delivery', label: 'A driver delivers it' }, { value: 'collect', label: 'The customer collects it from the factory' }] })}
    ${row(field('Date', 'dl-date', { type: 'date', value: o.deliveryDate || (day >= today() ? day : today()) }),
      `<div data-dl="delivery">${field('Time slot', 'dl-slot', { type: 'select', value: o.deliverySlot || '', options: opts(SLOTS.map(s => ({ value: s, label: s })), o.deliverySlot, 'Any time') })}</div>`)}
    <div data-dl="delivery">${field('Driver', 'dl-driver', { type: 'select', value: o.driverId || (drivers.length === 1 ? drivers[0].id : ''), options: opts(drivers.map(d => ({ value: d.id, label: d.name })), o.driverId, drivers.length ? 'Choose a driver…' : 'No drivers yet: add one first') })}</div>
    ${row(field('Receiving it', 'dl-contact', { value: o.deliveryContact || c.contact || o.customerName || '' }), field('Their cell', 'dl-phone', { value: o.deliveryPhone || c.phone || '' }))}
    <div data-dl="delivery">${field('Delivery address', 'dl-addr', { type: 'textarea', value: o.deliveryAddress || [c.address, c.area].filter(Boolean).join(', ') })}</div>
    ${field('Note', 'dl-note', { value: o.deliveryInstructions || '', placeholder: 'Gate code, stairs, call first…' })}
    <p class="muted" data-dl="collect">The date is when they are expected to fetch it. They get a WhatsApp from the Collections list once it is ready.</p>`, {
    okLabel: 'Save',
    onOk: async (w) => {
      const method = val(w, 'dl-method');
      const date = val(w, 'dl-date');
      if (method === 'collect') {
        await store.update('orders', id, {
          deliveryMethod: 'collect', deliveryDate: date || '', deliverySlot: '', driverId: '', driverName: '',
          deliveryContact: val(w, 'dl-contact'), deliveryPhone: val(w, 'dl-phone'), deliveryInstructions: val(w, 'dl-note'),
          driverStatus: 'scheduled', driverNote: ''
        }, 'For collection' + (date ? ', expected ' + date : ''));
        toast((o.orderNo || 'Order') + ' marked for collection');
        return;
      }
      if (!date) { toast('Pick the delivery date', 'warn'); return false; }
      const dId = val(w, 'dl-driver'); const d = driverById(dId);
      await store.update('orders', id, {
        deliveryMethod: 'delivery', deliveryDate: date, deliverySlot: val(w, 'dl-slot'), driverId: dId || '', driverName: d ? d.name : '',
        deliveryContact: val(w, 'dl-contact'), deliveryPhone: val(w, 'dl-phone'), deliveryAddress: val(w, 'dl-addr'), deliveryInstructions: val(w, 'dl-note'),
        driverStatus: 'scheduled', driverNote: ''
      }, 'Delivery booked for ' + date + (d ? ' with ' + d.name : ''));
      day = date;
      toast((o.orderNo || 'Order') + ' booked for ' + niceDate(date));
    }
  });
  // the driver, slot and address only matter for a delivery
  const card = wrap.querySelector('.modal-card');
  const sel = card.querySelector('#dl-method');
  const show = () => { const c = sel.value === 'collect'; card.querySelectorAll('[data-dl="delivery"]').forEach(el => { el.hidden = c; }); card.querySelectorAll('[data-dl="collect"]').forEach(el => { el.hidden = !c; }); };
  sel.addEventListener('change', show); show();
}

// One tap from the waiting list: the customer fetches it.
export async function markForCollection(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  const c = customerById(o.customerId) || {};
  await store.update('orders', id, {
    deliveryMethod: 'collect', driverId: '', driverName: '', deliverySlot: '', driverStatus: 'scheduled', driverNote: '',
    deliveryContact: o.deliveryContact || c.contact || o.customerName || '', deliveryPhone: o.deliveryPhone || c.phone || ''
  }, 'For collection');
  toast((o.orderNo || 'Order') + ' marked for collection: tell the customer when it is ready');
}

// Back to a delivery: it returns to the waiting list for a date and a driver.
export async function deliverInstead(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  await store.update('orders', id, { deliveryMethod: 'delivery', deliveryDate: '', deliverySlot: '', driverStatus: '' }, 'Changed to a delivery');
  toast((o.orderNo || 'Order') + ' is back on the delivery list');
}

// The booking, confirmed to the client on WhatsApp.
export function confirmToClient(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  const who = String(o.deliveryContact || o.customerName || '').split(' ')[0] || 'there';
  if (isCollect(o)) {
    const where = [settings.address, settings.phone ? 'Phone ' + settings.phone : ''].filter(Boolean).join('. ');
    const msg = 'Hi ' + who + ', ' + (settings.name || '') + ' here. Your ' + (o.product || 'order') + ' (' + (o.orderNo || '') + ') '
      + (o.status === 'ready' ? 'is ready for collection' : 'will be ready for collection' + (o.deliveryDate ? ' on ' + niceDate(o.deliveryDate) : ' soon')) + '.'
      + (where ? ' Collect from ' + where + '.' : '') + ' Reply here to say when you are coming.';
    window.open('https://wa.me/' + waDigits(phoneOf(o)) + '?text=' + encodeURIComponent(msg), '_blank');
    if (o.status === 'ready') store.update('orders', o.id, { clientToldAt: store.nowIso() }, 'Client told it is ready for collection').catch(() => {});
    return;
  }
  const msg = 'Hi ' + who + ', ' + (settings.name || '') + ' here. Your ' + (o.product || 'order') + ' (' + (o.orderNo || '') + ') will be delivered on '
    + niceDate(o.deliveryDate) + (o.deliverySlot ? ' between ' + o.deliverySlot.replace(' - ', ' and ') : '') + '.'
    + (addressOf(o) ? ' To: ' + addressOf(o) + '.' : '') + ' The driver will WhatsApp you when on the way. Reply here if that time does not suit.';
  window.open('https://wa.me/' + waDigits(phoneOf(o)) + '?text=' + encodeURIComponent(msg), '_blank');
  if (o.status === 'ready') store.update('orders', o.id, { clientToldAt: store.nowIso() }, 'Client told the delivery day').catch(() => {});
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
  const word = isCollect(o) ? 'collected' : 'delivered';
  if (!confirm('Mark ' + (o.orderNo || 'this order') + ' as ' + word + ', without a signature?')) return;
  const now = store.nowIso(); const who = (store.getUser() || {}).name || 'office';
  const patch = { driverStatus: 'delivered', driverStatusAt: now, deliveredAt: now, deliveredBy: who, hasDeliveryNote: false };
  if (['new', 'in-production', 'ready'].includes(o.status)) Object.assign(patch, { status: o.invoiceId ? 'invoiced' : 'dispatched', dispatchedAt: o.dispatchedAt || now, dispatchedBy: who });
  await store.update('orders', id, patch, (isCollect(o) ? 'Collected' : 'Delivered') + ' (marked by the office)');
  toast((o.orderNo || 'Order') + ' ' + word);
}

// The client signs here, in the office or on the office tablet: a
// collection at the factory, or a note signed after the fact.
export function clientSigns(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  const me = (store.getUser() || {}).name || 'office';
  openSignScreen({ company: settings.name || '', orderNo: o.orderNo, product: o.product, qty: o.qty, fabric: o.fabric,
    customer: o.deliveryContact || o.customerName || '', address: addressOf(o), by: me, byLabel: 'HANDED OVER BY' },
  async (signedBy, dataUrl) => {
    const now = store.nowIso();
    try {
      if (dataUrl) await store.saveDeliveryNote(id, { orderId: id, orderNo: o.orderNo || '', dataUrl, signedBy, at: now, driver: me });
      const patch = { driverStatus: 'delivered', driverStatusAt: now, deliveredAt: o.deliveredAt || now, deliveredBy: o.deliveredBy || me, signedBy: signedBy || o.signedBy || '', hasDeliveryNote: !!dataUrl || !!o.hasDeliveryNote };
      if (['new', 'in-production', 'ready'].includes(o.status)) Object.assign(patch, { status: o.invoiceId ? 'invoiced' : 'dispatched', dispatchedAt: o.dispatchedAt || now, dispatchedBy: me });
      await store.update('orders', id, patch, dataUrl ? (isCollect(o) ? 'Collected, signed for by ' : 'Delivery note signed by ') + signedBy : (isCollect(o) ? 'Collected' : 'Handed over') + ' without a signature');
      toast((o.orderNo || 'Order') + (dataUrl ? ' signed for by ' + signedBy : ' marked delivered'));
    } catch (e) { toast('Could not save: ' + e.message, 'warn'); }
  });
}

export async function undoDelivered(id, orders) {
  const o = orders.find(x => x.id === id); if (!o) return;
  if (!confirm('Put ' + (o.orderNo || 'this order') + ' back on the ' + (isCollect(o) ? 'collections' : 'delivery') + ' list' + (o.hasDeliveryNote ? ' and remove its signed note' : '') + '?')) return;
  const patch = { driverStatus: 'scheduled', driverStatusAt: store.nowIso(), deliveredAt: null, deliveredBy: null, signedBy: null, hasDeliveryNote: false };
  if ((o.status === 'dispatched' && !o.invoiceId) || (o.status === 'invoiced' && o.invoicedEarly)) Object.assign(patch, { status: 'ready', dispatchedAt: null, dispatchedBy: null });
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

// ------------------------------------------------------- delivery notes ----
// Tick the finished pieces (Factory floor → Done, or Orders → Done) and make
// one delivery note for the driver: every ticked order is booked on that
// driver's run for the day, the note gets a number (DN-0001), and it prints
// as a run sheet plus one page per stop for the client to sign.
//   orders: deliveryNoteNo, deliveryDate, driverId, driverName, deliveryMethod 'delivery'
const picks = new Set();
export const isPicked = (id) => picks.has(id);
export const pickedCount = () => picks.size;
export const clearPicks = () => picks.clear();
export const notePicks = () => [...picks];
export function togglePick(id) { if (picks.has(id)) picks.delete(id); else picks.add(id); }
// What can go on a note: done and not yet delivered.
export const notable = (o) => o.status === 'ready' && !o.deliveredAt;
export const mayBook = () => store.can('deliveries', 'edit') || store.can('factory', 'edit') || store.can('orders', 'edit') || store.can('invoices', 'edit');
export function pickAll(ids) { const all = ids.every(id => picks.has(id)); ids.forEach(id => { if (all) picks.delete(id); else picks.add(id); }); }
// the tick box on a card or a row
export const pickBox = (o) => mayBook() && notable(o) ? `<label class="dn-pick" title="Put it on a delivery note"><input type="checkbox" data-act="dn-pick" data-id="${esc(o.id)}"${picks.has(o.id) ? ' checked' : ''}><span>Delivery note</span></label>` : '';
// the bar above a list of done pieces
export function pickBarHtml(list) {
  if (!mayBook()) return '';
  const ids = list.filter(notable).map(o => o.id);
  [...picks].forEach(id => { if (!ids.includes(id)) picks.delete(id); });     // gone from the list: no longer ticked
  if (!ids.length) return '';
  const n = ids.filter(id => picks.has(id)).length;
  return `<div class="dn-bar">
    <label class="dn-all"><input type="checkbox" data-act="dn-all" data-ids="${esc(ids.join(','))}"${n && n === ids.length ? ' checked' : ''}> Select all ${ids.length}</label>
    <span class="dn-count">${n ? n + ' ticked' : 'Tick the pieces going out together'}</span>
    ${store.can('invoices', 'edit') ? `<button class="btn ghost" data-act="dn-invoice"${n ? '' : ' disabled'} title="Invoice the ticked pieces before they go out (one customer at a time)">🧾 Invoice ticked</button>` : ''}
    <button class="btn primary" data-act="dn-make"${n ? '' : ' disabled'}>🚚 Make delivery note${n ? ' (' + n + ')' : ''}</button>
  </div>`;
}

export function makeDeliveryNote(orders) {
  const list = orders.filter(o => picks.has(o.id) && notable(o)).sort((a, b) => String(a.orderNo || '').localeCompare(String(b.orderNo || ''), undefined, { numeric: true }));
  if (!list.length) { toast('Tick the pieces to put on the note first', 'warn'); return; }
  const known = drivers.length ? drivers : [];
  const names = [...new Set(orders.map(o => o.driverName).filter(Boolean))];
  const noAddr = list.filter(o => !addressOf(o));
  const notInvoiced = list.filter(o => !o.invoiceId);
  if (settings.invoiceBeforeNote && notInvoiced.length) {
    toast(notInvoiced.map(o => o.orderNo).join(', ') + (notInvoiced.length === 1 ? ' is' : ' are') + ' not invoiced yet: invoice first (🧾 Invoice ticked), then make the delivery note', 'warn');
    return;
  }
  const collect = list.filter(isCollect);
  const firstDriver = list.find(o => o.driverId) || {};
  const { wrap } = openModal('Delivery note · ' + list.length + ' piece' + (list.length === 1 ? '' : 's'), `
    <div class="pk-list" style="max-height:30vh; margin-bottom:.7rem">${list.map((o, i) => `<div class="pk-row" style="cursor:default"><strong>${i + 1}. ${esc(o.orderNo || '')} · ${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}</strong><span>${esc(contactOf(o))} · ${addressOf(o) ? esc(shownAddress(o)) : '<b style="color:#b91c1c">no address</b>'}${o.invoiceNo ? ' · ' + esc(o.invoiceNo) : ''}</span></div>`).join('')}</div>
    ${row(field('Delivery date', 'dn-date', { type: 'date', value: list.find(o => o.deliveryDate >= today()) ? list.find(o => o.deliveryDate >= today()).deliveryDate : today() }),
      known.length ? field('Driver', 'dn-driver', { type: 'select', value: firstDriver.driverId || (known.length === 1 ? known[0].id : ''), options: [{ value: '', label: 'Choose a driver…' }].concat(known.map(d => ({ value: d.id, label: d.name }))) })
        : field('Driver', 'dn-driver-name', { value: firstDriver.driverName || names[0] || '', placeholder: 'The driver’s name' }))}
    <label class="check"><input type="checkbox" id="dn-pages" checked> A page per stop for the client to sign</label>
    ${known.length ? '<label class="check"><input type="checkbox" id="dn-wa" checked> Send the run to the driver on WhatsApp</label>' : '<p class="muted">The driver’s private link is set under Deliveries (office).</p>'}
    ${noAddr.length ? `<p class="notice-inline">${noAddr.map(o => esc(o.orderNo)).join(', ')} ${noAddr.length === 1 ? 'has' : 'have'} no delivery address yet: add it under Deliveries → Change, or write it on the note.</p>` : ''}
    ${collect.length ? `<p class="notice-inline">${collect.map(o => esc(o.orderNo)).join(', ')} ${collect.length === 1 ? 'was' : 'were'} for collection and become${collect.length === 1 ? 's' : ''} a delivery.</p>` : ''}
    ${notInvoiced.length ? `<p class="muted">Not invoiced yet: ${notInvoiced.map(o => esc(o.orderNo)).join(', ')}.</p>` : ''}`, {
    okLabel: 'Book and print',
    onOk: async (w) => {
      const date = val(w, 'dn-date');
      if (!date) { toast('Pick the delivery date', 'warn'); return false; }
      const dId = known.length ? val(w, 'dn-driver') : '';
      const d = dId ? driverById(dId) : null;
      const dName = d ? d.name : (val(w, 'dn-driver-name') || '').trim();
      if (!dName) { toast('Choose the driver', 'warn'); return false; }
      const n = await store.nextNumber('deliveryNoteNo', 1);
      const no = (settings.deliveryNotePrefix || 'DN-') + String(n).padStart(4, '0');
      picks.clear();            // before the saves repaint the list
      for (const o of list) {
        const c = customerById(o.customerId) || {};
        await store.update('orders', o.id, {
          deliveryMethod: 'delivery', deliveryDate: date, driverId: d ? d.id : (o.driverName === dName ? o.driverId || '' : ''), driverName: dName,
          driverStatus: 'scheduled', driverNote: '', deliveryNoteNo: no,
          deliveryContact: o.deliveryContact || c.contact || o.customerName || '', deliveryPhone: o.deliveryPhone || c.phone || '', deliveryAddress: o.deliveryAddress || [c.address, c.area].filter(Boolean).join(', ')
        }, 'On delivery note ' + no + ' for ' + date + ' with ' + dName);
      }
      const booked = list.map(o => ({ ...o, deliveryDate: date, driverName: dName, deliveryNoteNo: no }));
      printDeliveryNote(no, date, dName, booked, w.querySelector('#dn-pages').checked);
      const wa = w.querySelector('#dn-wa');
      if (d && wa && wa.checked) { if (d.phone) window.open('https://wa.me/' + waDigits(d.phone) + '?text=' + encodeURIComponent('Delivery note ' + no + '. ' + runText(d, booked)), '_blank'); else toast('Add ' + d.name + '’s cell number to WhatsApp the run', 'warn'); }
      day = date;
      toast(no + ': ' + list.length + ' piece' + (list.length === 1 ? '' : 's') + ' booked for ' + niceDate(date) + ' with ' + dName);
    }
  });
  wrap.querySelector('.modal-card').classList.add('wide');
}

// The note itself: the driver's list, then a page per stop to sign. A stop
// is an order, or an invoice (its goods, to its customer).
const stopOfOrder = (o) => ({ ref: o.orderNo || '', invoiceNo: o.invoiceNo || '', externalRef: o.externalRef || '', items: [{ name: o.product || '', qty: Number(o.qty) || 1, fabric: o.fabric || '' }],
  contact: o.deliveryContact || o.customerName || '', address: addressOf(o), phone: phoneOf(o), note: o.deliveryInstructions || '' });
export function printDeliveryNote(no, date, driverName, list, pages) {
  const stops = list.map(x => x.items ? x : stopOfOrder(x));
  const head = (title, sub) => docHeader(settings, title, no, [niceDate(date), 'Driver ' + driverName].concat(sub || []));
  const items = (st) => st.items.map(it => `${esc(it.name)}${Number(it.qty) > 1 ? ' × ' + esc(it.qty) : ''}${it.fabric ? '<br><small>' + esc(it.fabric) + '</small>' : ''}`).join('<br>');
  const refs = (st, br) => `<strong>${esc(st.ref)}</strong>${st.invoiceNo && st.invoiceNo !== st.ref ? (br ? '<br><small>' : ' · ') + 'Invoice ' + esc(st.invoiceNo) + (br ? '</small>' : '') : ''}${st.externalRef ? (br ? '<br><small>ref ' : ' · your ref ') + esc(st.externalRef) + (br ? '</small>' : '') : ''}`;
  const sheet = `<div class="dn-page">${head('DELIVERY NOTE', [stops.length + ' stop' + (stops.length === 1 ? '' : 's')])}
    <table><tr><th>#</th><th>Order / invoice</th><th>Item</th><th>Deliver to</th><th>Phone</th><th>Received by (name &amp; signature)</th></tr>
    ${stops.map((st, i) => `<tr><td>${i + 1}</td><td>${refs(st, true)}</td><td>${items(st)}</td>
      <td>${esc(st.contact)}<br>${esc(st.address)}${st.note ? '<br><small>' + esc(st.note) + '</small>' : ''}</td><td>${esc(st.phone)}</td><td style="width:24%; height:46px"></td></tr>`).join('')}
    </table>
    <table style="margin-top:14px"><tr><td style="width:50%; height:50px">Loaded by<br><br>______________________ &nbsp; date ________</td><td>Driver<br><br>______________________ &nbsp; date ________</td></tr></table></div>`;
  const stop = (st, i) => `<div class="dn-page">${head('DELIVERY NOTE', ['Stop ' + (i + 1) + ' of ' + stops.length])}
    <table><tr><th style="width:30%">Order / invoice</th><td>${refs(st, false)}</td></tr>
      <tr><th>Deliver to</th><td>${esc(st.contact)}<br>${esc(st.address)}<br>${esc(st.phone)}</td></tr>
      <tr><th>Items</th><td>${items(st)}</td></tr>
      ${st.note ? `<tr><th>Note</th><td>${esc(st.note)}</td></tr>` : ''}</table>
    <p style="margin:14px 0 6px">Received in good order and condition.</p>
    <table><tr><td style="height:60px; width:40%">Name<br><br></td><td style="width:40%">Signature<br><br></td><td>Date<br><br></td></tr></table>
    <p style="font-size:11px; color:#444; margin-top:10px">Driver: bring this page back signed.</p></div>`;
  openPrint('Delivery note ' + no, `<style>.dn-page{page-break-after:always} .dn-page:last-child{page-break-after:auto}</style>${sheet}${pages ? stops.map(stop).join('') : ''}`);
}

// --------------------------------------------- delivery notes from invoices --
// Invoice first, then deliver: tick the invoices going out (Money → Invoices,
// "To deliver") and make one note. Each invoice is a stop with its goods; its
// orders are booked on the driver's run, and the invoice carries the note no.
const invPicks = new Set();
export const invPicked = (id) => invPicks.has(id);
export function toggleInvPick(id) { if (invPicks.has(id)) invPicks.delete(id); else invPicks.add(id); }
export function pickAllInv(ids) { const all = ids.every(id => invPicks.has(id)); ids.forEach(id => { if (all) invPicks.delete(id); else invPicks.add(id); }); }
// what goes on the truck: the invoice's lines less discounts, delivery fees and gift cards
export const goodsOf = (inv) => (inv.lines || []).filter(l => Number(l.qty) > 0 && Number(l.unitPrice) >= 0 && !/^(Discount|Delivery to |Gift card)/i.test(String(l.description || '')));
const deliveredOrder = (orders, id) => { const o = orders.find(x => x.id === id); return !!(o && o.deliveredAt); };
// can still go out: not void, has goods, and not every order on it already delivered
export function invDeliverable(inv, orders) {
  if (inv.status === 'void' || inv.deliveredAt) return false;
  const g = goodsOf(inv); if (!g.length) return false;
  const ids = g.map(l => l.orderId).filter(Boolean);
  return !(ids.length && ids.length === g.length && ids.every(id => deliveredOrder(orders, id)));
}
const invAddress = (inv, orders) => {
  if (inv.deliveryAddress) return inv.deliveryAddress;
  const fee = (inv.lines || []).find(l => /^Delivery to /i.test(String(l.description || '')));
  if (fee) return String(fee.description).replace(/^Delivery to /i, '').replace(/\s*\(from stock\)$/, '');
  const o = (inv.lines || []).map(l => orders.find(x => x.id === l.orderId)).find(x => x && addressOf(x));
  if (o) return addressOf(o);
  const c = customerById(inv.customerId) || {};
  return [c.address, c.area].filter(Boolean).join(', ');
};
const stopOfInvoice = (inv, orders) => {
  const c = customerById(inv.customerId) || {};
  const o = (inv.lines || []).map(l => orders.find(x => x.id === l.orderId)).find(Boolean) || {};
  return { ref: inv.invoiceNo || '', invoiceNo: inv.invoiceNo || '', externalRef: '', contact: inv.customerName || c.name || '',
    items: goodsOf(inv).map(l => ({ name: String(l.description || '').replace(/\s*\((from stock|made to order[^)]*)\)$/, ''), qty: Number(l.qty) || 1, fabric: '' })),
    address: invAddress(inv, orders), phone: o.deliveryPhone || c.phone || '', note: inv.deliveryInstructions || o.deliveryInstructions || '' };
};
export const invPickBox = (inv, orders) => mayBook() && invDeliverable(inv, orders) ? `<input type="checkbox" class="dn-inv-box" data-act="dn-inv-pick" data-id="${esc(inv.id)}"${invPicks.has(inv.id) ? ' checked' : ''} aria-label="Put ${esc(inv.invoiceNo || '')} on a delivery note">` : '';
export function invPickBarHtml(rows, orders) {
  if (!mayBook()) return '';
  const ids = rows.filter(i => invDeliverable(i, orders)).map(i => i.id);
  [...invPicks].forEach(id => { if (!ids.includes(id)) invPicks.delete(id); });
  if (!ids.length) return '';
  const n = ids.filter(id => invPicks.has(id)).length;
  return `<div class="dn-bar">
    <label class="dn-all"><input type="checkbox" data-act="dn-inv-all" data-ids="${esc(ids.join(','))}"${n && n === ids.length ? ' checked' : ''}> Select all ${ids.length}</label>
    <span class="dn-count">${n ? n + ' invoice' + (n === 1 ? '' : 's') + ' ticked' : 'Tick the invoices going out together'}</span>
    <button class="btn primary" data-act="dn-inv-make"${n ? '' : ' disabled'}>🚚 Make delivery note${n ? ' (' + n + ')' : ''}</button>
  </div>`;
}
export function makeNoteFromInvoices(invoices, orders) {
  const list = invoices.filter(i => invPicks.has(i.id) && invDeliverable(i, orders)).sort((a, b) => String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || ''), undefined, { numeric: true }));
  if (!list.length) { toast('Tick the invoices to put on the note first', 'warn'); return; }
  const stops = list.map(i => stopOfInvoice(i, orders));
  const known = drivers;
  const names = [...new Set(orders.map(o => o.driverName).filter(Boolean))];
  const noAddr = stops.filter(st => !st.address);
  const { wrap } = openModal('Delivery note · ' + list.length + ' invoice' + (list.length === 1 ? '' : 's'), `
    <div class="pk-list" style="max-height:30vh; margin-bottom:.7rem">${stops.map((st, i) => `<div class="pk-row" style="cursor:default"><strong>${i + 1}. ${esc(st.ref)} · ${esc(st.contact)}</strong><span>${esc(st.items.map(it => (it.qty > 1 ? it.qty + '× ' : '') + it.name).join(', '))} · ${st.address ? esc(st.address) : '<b style="color:#b91c1c">no address</b>'}</span></div>`).join('')}</div>
    ${row(field('Delivery date', 'dn-date', { type: 'date', value: today() }),
      known.length ? field('Driver', 'dn-driver', { type: 'select', value: known.length === 1 ? known[0].id : '', options: [{ value: '', label: 'Choose a driver…' }].concat(known.map(d => ({ value: d.id, label: d.name }))) })
        : field('Driver', 'dn-driver-name', { value: names[0] || '', placeholder: 'The driver’s name' }))}
    <label class="check"><input type="checkbox" id="dn-pages" checked> A page per stop for the client to sign</label>
    ${known.length ? '<label class="check"><input type="checkbox" id="dn-wa" checked> Send the list to the driver on WhatsApp</label>' : ''}
    ${noAddr.length ? `<p class="notice-inline">${noAddr.map(st => esc(st.ref)).join(', ')} ${noAddr.length === 1 ? 'has' : 'have'} no delivery address: add it to the customer, or write it on the note.</p>` : ''}`, {
    okLabel: 'Book and print',
    onOk: async (w) => {
      const date = val(w, 'dn-date');
      if (!date) { toast('Pick the delivery date', 'warn'); return false; }
      const dId = known.length ? val(w, 'dn-driver') : '';
      const d = dId ? driverById(dId) : null;
      const dName = d ? d.name : (val(w, 'dn-driver-name') || '').trim();
      if (!dName) { toast('Choose the driver', 'warn'); return false; }
      const n = await store.nextNumber('deliveryNoteNo', 1);
      const no = (settings.deliveryNotePrefix || 'DN-') + String(n).padStart(4, '0');
      invPicks.clear();
      for (const [i, inv] of list.entries()) {
        const st = stops[i];
        // the orders on the invoice go on the driver's run
        for (const l of goodsOf(inv)) {
          const o = l.orderId && orders.find(x => x.id === l.orderId);
          if (!o || o.deliveredAt || o.status === 'cancelled') continue;
          const c = customerById(o.customerId) || {};
          await store.update('orders', o.id, {
            deliveryMethod: 'delivery', deliveryDate: date, driverId: d ? d.id : (o.driverName === dName ? o.driverId || '' : ''), driverName: dName, driverStatus: 'scheduled', driverNote: '', deliveryNoteNo: no,
            deliveryContact: o.deliveryContact || c.contact || o.customerName || '', deliveryPhone: o.deliveryPhone || c.phone || '', deliveryAddress: o.deliveryAddress || st.address || ''
          }, 'On delivery note ' + no + ' (' + (inv.invoiceNo || '') + ') for ' + date + ' with ' + dName);
        }
        await store.update('invoices', inv.id, { deliveryNoteNo: no, deliveryDate: date, driverName: dName, deliveryAddress: inv.deliveryAddress || st.address || '' }, 'On delivery note ' + no + ' for ' + date + ' with ' + dName);
      }
      printDeliveryNote(no, date, dName, stops, w.querySelector('#dn-pages').checked);
      const wa = w.querySelector('#dn-wa');
      if (d && wa && wa.checked) {
        if (d.phone) window.open('https://wa.me/' + waDigits(d.phone) + '?text=' + encodeURIComponent('Hi ' + d.name + ', delivery note ' + no + ' for ' + niceDate(date) + ' (' + stops.length + '):\n' + stops.map((st, i) => (i + 1) + '. ' + st.ref + ' · ' + st.contact + ', ' + (st.address || 'no address') + ' · ' + st.items.map(it => (it.qty > 1 ? it.qty + '× ' : '') + it.name).join(', ')).join('\n') + '\n\nYour list: ' + driverLink(d)), '_blank');
        else toast('Add ' + d.name + '’s cell number to WhatsApp the list', 'warn');
      }
      day = date;
      toast(no + ': ' + list.length + ' invoice' + (list.length === 1 ? '' : 's') + ' booked for ' + niceDate(date) + ' with ' + dName);
    }
  });
  wrap.querySelector('.modal-card').classList.add('wide');
}

// Reprint from the Deliveries screen: the driver's run for the day.
export function printRunNote(driverId, orders) {
  const list = toDeliver(orders).filter(o => o.deliveryDate === day && (o.driverId || '') === (driverId || '') && !isCollect(o))
    .sort((a, b) => String(a.deliverySlot || '~').localeCompare(String(b.deliverySlot || '~')) || String(a.orderNo || '').localeCompare(String(b.orderNo || ''), undefined, { numeric: true }));
  if (!list.length) return;
  const nos = [...new Set(list.map(o => o.deliveryNoteNo).filter(Boolean))].sort();
  printDeliveryNote(nos.join(', ') || 'Run ' + niceDate(day), day, driverNameOf(list[0]) || 'not set', list, true);
}
