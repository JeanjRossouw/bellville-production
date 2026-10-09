// The driver's page, without a login. A driver's private link carries
// <companyId>.<code>; the code is random (96 bits) and stored on the driver's
// record, which only the office's Deliveries screen can read. Everything the
// driver sees and does goes through here, and only ever touches that
// driver's own stops.
//
//   GET  ?d=<cid>.<code>[&date=YYYY-MM-DD]   → driver, company, the day's stops
//   POST { d, action: 'status', orderId, status: 'on-way'|'late'|'issue', note }
//   POST { d, action: 'delivered', orderId, signedBy, dataUrl }   (signed note, JPEG)
//
// Env: FACTORY_SERVICE_ACCOUNT (the same key the billing function uses).
import { getDoc, patchDoc, query } from './lib/factory-firestore.mjs';

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const CODE = /^([A-Za-z0-9_-]{1,64})\.([a-f0-9]{24})$/;
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);   // South African date
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export function parseCode(d) {
  const m = CODE.exec(String(d || ''));
  return m ? { cid: m[1], code: m[2] } : null;
}

// What a driver may see of an order: enough to deliver it, nothing about money.
export function stopView(o) {
  return {
    id: o.id, orderNo: o.orderNo || '', product: o.product || '', qty: o.qty || 1, fabric: o.fabric || '',
    customer: o.deliveryContact || o.customerName || '', phone: o.deliveryPhone || '', address: o.deliveryAddress || '',
    slot: o.deliverySlot || '', instructions: o.deliveryInstructions || '',
    driverStatus: o.driverStatus || '', driverNote: o.driverNote || '', deliveredAt: o.deliveredAt || '', signedBy: o.signedBy || ''
  };
}

function active(c) {
  const now = Date.now();
  if (c.status === 'free') return true;
  const created = Date.parse(c.createdAt || '') || 0;
  if (c.status === 'trial' && now < (Date.parse(c.trialEndsAt || '') || created + 14 * 86400000)) return true;
  return !!(c.paidUntil && now < Date.parse(c.paidUntil));
}

async function findDriver(cid, code) {
  const rows = await query('companies/' + cid, 'drivers', { token: code }, 2);
  return rows.length === 1 && !rows[0].disabled ? rows[0] : null;
}

export const handler = async (event) => {
  try {
    const isGet = event.httpMethod === 'GET';
    let body = {};
    if (!isGet) {
      if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
      try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); }
      catch { return json(400, { error: 'Invalid request' }); }
    }
    const q = event.queryStringParameters || {};
    const who = parseCode(isGet ? q.d : body.d);
    if (!who) return json(400, { error: 'This link is not complete. Ask the office for your link again.' });
    const [driver, company, settings] = await Promise.all([
      findDriver(who.cid, who.code), getDoc('companies/' + who.cid), getDoc(`companies/${who.cid}/settings/factory`)
    ]);
    if (!driver || !company) return json(404, { error: 'This link does not work any more. Ask the office for a new one.' });

    if (isGet) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : today();
      const stops = (await query('companies/' + who.cid, 'orders', { driverId: driver.id, deliveryDate: date }))
        .map(stopView).sort((a, b) => String(a.slot).localeCompare(String(b.slot)) || String(a.orderNo).localeCompare(String(b.orderNo)));
      return json(200, {
        driver: { name: driver.name || '' }, date,
        company: { name: (settings && settings.name) || company.name || '', phone: (settings && (settings.deliveryPhone || settings.phone)) || '' },
        stops
      });
    }

    // ---- actions: only on this driver's own stops, only while the company is active
    if (!active(company)) return json(403, { error: 'The company\'s subscription is not active, so changes cannot be saved. Tell the office.' });
    const orderId = clean(body.orderId, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(orderId)) return json(400, { error: 'Unknown stop' });
    const path = `companies/${who.cid}/orders/${orderId}`;
    const order = await getDoc(path);
    if (!order || order.driverId !== driver.id) return json(404, { error: 'That stop is not on your list.' });
    const now = new Date().toISOString();

    if (body.action === 'status') {
      const status = ['on-way', 'late', 'issue'].includes(body.status) ? body.status : null;
      if (!status) return json(400, { error: 'Unknown status' });
      await patchDoc(path, { driverStatus: status, driverStatusAt: now, driverNote: clean(body.note, 200), updatedAt: now, updatedBy: driver.name || 'Driver' });
      return json(200, { ok: true });
    }

    if (body.action === 'delivered') {
      const dataUrl = String(body.dataUrl || '');
      if (dataUrl && (!/^data:image\/jpeg;base64,/.test(dataUrl) || dataUrl.length > 900000)) return json(400, { error: 'The signature picture is too big or not a picture.' });
      const signedBy = clean(body.signedBy, 80);
      if (dataUrl) await patchDoc(`companies/${who.cid}/deliveryNotes/${orderId}`, { orderId, orderNo: order.orderNo || '', dataUrl, signedBy, at: now, driver: driver.name || '' });
      const patch = { driverStatus: 'delivered', driverStatusAt: now, deliveredAt: now, deliveredBy: driver.name || 'Driver', signedBy, hasDeliveryNote: !!dataUrl, updatedAt: now, updatedBy: driver.name || 'Driver' };
      // delivered means it has left the factory: into the invoice queue
      if (order.status === 'ready' || order.status === 'in-production' || order.status === 'new') Object.assign(patch, { status: 'dispatched', dispatchedAt: order.dispatchedAt || now, dispatchedBy: driver.name || 'Driver' });
      await patchDoc(path, patch);
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('factory-driver failed:', e);
    return json(500, { error: 'Something went wrong — try again in a moment.' });
  }
};
