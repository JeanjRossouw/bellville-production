// Retail POS — the driver's page (pos/driver.html?d=<token>): their deliveries, no login; the token
// is theirs alone (a manager makes a new one, which stops the old). Only orders given to this driver.
//
//   run       { d }                                   the driver, the shop, their orders out for delivery, today's done
//   onTheWay  { d, orderId }                          logged; the message for the client, sent from the driver's phone
//   delivered { d, orderId, signedBy, signature, note }   the client signs; the order is delivered (the invoice was written at dispatch)
//   issue     { d, orderId, note }                    could not deliver: the shop sees it on To do
import { json, Reject, clean, getTop, getDoc, patchDoc, query, inGroup, nowIso, audit, bodyOf, GROUP_RE } from './lib/pos.mjs';
import { completeDelivery, signatureOk } from './lib/delivery.mjs';
import { tokenOk, trackUrl } from './lib/track.mjs';

const saToday = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const addr = (a) => a ? [a.line1, a.line2, a.city, a.code].filter(Boolean).join(', ') : '';

async function driverOf(d) {
  const bad = new Reject(404, 'This link no longer works: ask the shop for your new one.');
  if (!tokenOk(d)) throw bad;
  const l = await getTop('posDriverLinks/' + d);
  if (!l || l.revoked || !GROUP_RE.test(l.gid || '')) throw bad;
  return { l, bad };
}
async function withDriver(b, fn) {
  const { l, bad } = await driverOf(clean(b.d, 60));
  return inGroup(l.gid, async () => {
    const drv = await getDoc('drivers', l.driverId);
    if (!drv || drv.linkToken !== b.d || drv.active === false) throw bad;
    return fn({ ...drv, id: l.driverId });
  });
}
async function orderFor(drv, id) {
  const so = await getDoc('specialOrders', clean(id, 80));
  if (!so || so.entityId !== drv.entityId || !so.delivery || so.delivery.driverId !== drv.id) throw new Reject(404, 'That delivery is not on your list.');
  return { ...so, id: clean(id, 80) };
}
const stop = (so) => {
  const c = so.customerSnapshot || {}, dv = so.delivery || {};
  return {
    id: so.id, docNo: so.docNo, status: so.status, name: c.name || '', phone: dv.phone || c.phone || '', address: addr(dv.address || c.address), date: dv.date || '', slot: dv.slot || '', note: dv.note || '',
    items: (so.lines || []).filter(l => !l.custom || !/^Delivery/.test(l.name)).map(l => l.qty + ' × ' + l.name), onTheWayAt: dv.onTheWayAt || '', issue: dv.issue || null,
    completedAt: so.status === 'delivered' ? so.completedAt || '' : '', invoiceNo: so.completedDocNo || ''
  };
};

const actions = {
  async run(b) {
    return withDriver(b, async (drv) => {
      const e = (await getDoc('entities', drv.entityId)) || {};
      const out = await query('specialOrders', [{ field: 'entityId', value: drv.entityId }, { field: 'status', value: 'outForDelivery' }], 300);
      const done = await query('specialOrders', [{ field: 'entityId', value: drv.entityId }, { field: 'status', value: 'delivered' }], 500);
      const mine = (o) => o.delivery && o.delivery.driverId === drv.id;
      return {
        driver: { name: drv.name }, shop: { name: e.tradingName || e.legalName || '' },
        stops: out.filter(mine).sort((a, c) => String(a.delivery.date + a.delivery.slot).localeCompare(String(c.delivery.date + c.delivery.slot))).map(stop),
        done: done.filter(o => mine(o) && String(o.completedAt || '').slice(0, 10) >= saToday()).map(stop)
      };
    });
  },
  async onTheWay(b, event) {
    return withDriver(b, async (drv) => {
      const so = await orderFor(drv, b.orderId);
      if (so.status !== 'outForDelivery') throw new Reject(409, `${so.docNo} is ${so.status}.`);
      const now = nowIso();
      await patchDoc('specialOrders', so.id, { delivery: { ...so.delivery, onTheWayAt: now }, updatedAt: now });
      const e = (await getDoc('entities', so.entityId)) || {};
      const first = String((so.customerSnapshot || {}).name || '').split(' ')[0];
      const link = so.trackToken ? `\nFollow it here: ${trackUrl(event, so.trackToken)}` : '';
      return { ok: true, phone: so.delivery.phone || (so.customerSnapshot || {}).phone || '', text: `Hi${first ? ' ' + first : ''}, it's ${drv.name.split(' ')[0]} from ${e.tradingName || e.legalName || 'the shop'}: I'm on my way with your order ${so.docNo}.${link}` };
    });
  },
  async delivered(b) {
    return withDriver(b, async (drv) => {
      const so = await orderFor(drv, b.orderId);
      if (so.status === 'delivered') return { ok: true, again: true, stop: stop(so) };
      if (so.status !== 'outForDelivery') throw new Reject(409, `${so.docNo} is ${so.status}.`);
      const signedBy = clean(b.signedBy, 120), signature = String(b.signature || '').slice(0, 200000);
      if (!signedBy) throw new Reject(400, 'Who received it?');
      if (!signature || !signatureOk(signature)) throw new Reject(400, 'The client signs in the box.');
      const done = await completeDelivery(so, { byName: drv.name, byUid: 'driver:' + drv.id, source: 'driver', signedBy, signature, note: clean(b.note, 300) });
      return { ok: true, stop: stop(done) };
    });
  },
  async issue(b) {
    return withDriver(b, async (drv) => {
      const so = await orderFor(drv, b.orderId);
      const note = clean(b.note, 300);
      if (!note) throw new Reject(400, 'What went wrong?');
      const now = nowIso();
      await patchDoc('specialOrders', so.id, { delivery: { ...so.delivery, issue: { note, at: now, by: drv.name } }, todoDue: true, updatedAt: now });
      await audit({ action: 'specialOrder.deliveryIssue', docType: 'specialOrder', docId: so.id, docNo: so.docNo, actorUid: 'driver:' + drv.id, actorName: drv.name, details: { note }, entityId: so.entityId, storeId: so.storeId || '' });
      return { ok: true };
    });
  }
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(b, event));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-driver failed:', e);
    return json(500, { error: 'Something went wrong. Try again in a minute.' });
  }
};
