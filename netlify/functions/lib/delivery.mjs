// Retail POS — deliveries of sales orders: the slots a client may choose, the drivers and their
// private links, and an order marked delivered (by the driver on the road, or at the till).
//
//   settings/<entityId>.delivery  { defaultFeeCents, days: [1..7] (Mon = 1), slots: ['08:00–12:00', …], perSlot, leadDays }
//   drivers/<id>                  { entityId, name, phone, active, linkToken, stamps }       server only
//   posDriverLinks/<token>        { gid, driverId, entityId, at, revoked? }                  server only, outside every group
//   specialOrders/<id>.delivery   { kind, date, slot, address, phone, note, requested?, confirmed?,
//                                   driverId?, driverName?, dispatchedAt?, onTheWayAt?, issue? { note, at } }
import { randomBytes } from 'node:crypto';
import { createTop, patchTop, patchDoc, groupId, nowIso, audit, query } from './pos.mjs';
import { noteHandover } from './factory-link.mjs';

export const DELIVERY_DEFAULTS = { days: [1, 2, 3, 4, 5, 6], slots: ['08:00–12:00', '12:00–17:00'], perSlot: 4, leadDays: 1 };
export function deliverySettings(s = {}) {
  const d = s.delivery || {};
  const days = Array.isArray(d.days) && d.days.length ? d.days.map(Number).filter(n => n >= 1 && n <= 7) : DELIVERY_DEFAULTS.days;
  const slots = Array.isArray(d.slots) && d.slots.filter(Boolean).length ? d.slots.map(x => String(x).slice(0, 40)).filter(Boolean) : DELIVERY_DEFAULTS.slots;
  const perSlot = Number(d.perSlot) > 0 ? Math.min(100, Math.round(d.perSlot)) : DELIVERY_DEFAULTS.perSlot;
  const leadDays = Number(d.leadDays) >= 0 ? Math.min(30, Math.round(d.leadDays)) : DELIVERY_DEFAULTS.leadDays;
  return { days, slots, perSlot, leadDays, defaultFeeCents: Number(d.defaultFeeCents) || 0 };
}

const saDay = (ms) => new Date(ms + 2 * 3600000).toISOString().slice(0, 10);
const isoDow = (iso) => { const d = new Date(iso + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d; };

// the next two weeks of open slots: the delivery days, the slots, less what is already booked
export async function openSlots(entityId, settings, days = 14) {
  const ds = deliverySettings(settings);
  const busy = {};
  for (const status of ['ready', 'outForDelivery']) {
    for (const o of await query('specialOrders', [{ field: 'entityId', value: entityId }, { field: 'status', value: status }], 500)) {
      const dv = o.delivery; if (dv && dv.date && dv.slot) busy[dv.date + '|' + dv.slot] = (busy[dv.date + '|' + dv.slot] || 0) + 1;
    }
  }
  const out = [], start = Date.now() + ds.leadDays * 86400000;
  for (let i = 0; i < days; i++) {
    const date = saDay(start + i * 86400000);
    if (!ds.days.includes(isoDow(date))) continue;
    const slots = ds.slots.map(slot => ({ slot, left: Math.max(0, ds.perSlot - (busy[date + '|' + slot] || 0)) })).filter(x => x.left > 0);
    if (slots.length) out.push({ date, slots });
  }
  return out;
}

// a driver's private link: a new one replaces the old (the old stops working)
export async function newDriverLink(driver) {
  if (driver.linkToken) await patchTop('posDriverLinks/' + driver.linkToken, { revoked: true }).catch(() => {});
  const t = randomBytes(18).toString('base64url');
  await createTop('posDriverLinks/' + t, { gid: groupId(), driverId: driver.id, entityId: driver.entityId, at: nowIso() });
  await patchDoc('drivers', driver.id, { linkToken: t, updatedAt: nowIso() });
  return t;
}
export function driverUrl(event, t) {
  const h = (event && event.headers) || {};
  const host = h['x-forwarded-host'] || h.host || '';
  return `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}/pos/driver.html?d=${t}`;
}

const hist = (so, status, by, source, note, now) => [...(so.statusHistory || []), { status, at: now, byName: by, source, note: note || '' }].slice(-50);

// out for delivery → delivered: the signed note kept (the tax invoice was written at dispatch)
export async function completeDelivery(so, { byName, byUid, source, signedBy, signature, note, deviceId }) {
  const now = nowIso();
  const patch = {
    status: 'delivered', statusHistory: hist(so, 'delivered', byName, source, note, now), updateDue: true, completedAt: now, completedByUid: byUid || '', completedByName: byName,
    deliveryNote: { signedBy: signedBy || '', signature: signature || '', at: now, byName, note: note || '', kind: 'deliver' }, updatedAt: now
  };
  await patchDoc('specialOrders', so.id, patch);
  await audit({ action: 'specialOrder.delivered', docType: 'specialOrder', docId: so.id, docNo: so.docNo, actorUid: byUid || source, actorName: byName, details: { source, signed: !!signature }, entityId: so.entityId, storeId: so.storeId, deviceId: deviceId || 'server' });
  if (so.factory && so.factory.orders && so.factory.orders.length) await noteHandover(so.factory.companyId, so.factory.orders, `Delivered to the customer by ${byName} on ${now.slice(0, 10)} (${so.docNo}, invoice ${so.completedDocNo || ''})`).catch(() => {});
  return { ...so, ...patch };
}
export const signatureOk = (s) => !s || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s);
