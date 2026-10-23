// Retail POS — sales orders: a made-to-order item sold as an ordinary sale
// (pos-sale writes the salesOrders document with the sale and sends it to
// the factory). This function moves it along after that.
//
//   factorySync { saleId }                                         any member: the factory's status now
//   factorySend { saleId }                                         a supervisor: send it to the factory (nothing goes by itself)
//   status      { saleId, status: 'inProduction'|'ready', note }   a supervisor, when the factory does not say
//   update      { saleId, status?, how }                           → the WhatsApp text, logged
//   handover    { saleId, kind: 'collect'|'deliver', signedBy, signature, note }   handed to the customer
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, nowIso, getDoc, patchDoc, bodyOf, audit, withGroup } from './lib/pos.mjs';
import { whoAndWhere, approved } from './lib/sale.mjs';
import { pushToFactory, syncFromFactory, histOf } from './lib/factory-bridge.mjs';
import { noteHandover } from './lib/factory-link.mjs';
import { salesOrderText, SALES_NEXT, SALES_STATUSES } from '../../pos/js/special-terms.js';

export const FORWARD_SALES = { open: ['inProduction', 'ready'], inProduction: ['ready'] };
async function loadOrder(ctx, id) {
  id = clean(id, 80);
  const so = await getDoc('salesOrders', id);
  if (!so || so.entityId !== ctx.entityId) throw new Reject(404, 'No such sales order here.');
  return { ...so, id };
}
const auditRow = (ctx, action, so, details) => audit({ action, docType: 'salesOrder', docId: so.id, docNo: so.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, details, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });

const actions = {
  async factorySync(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const so = await loadOrder(ctx, b.saleId);
    if (!so.factory || !so.factory.orders || !so.factory.orders.length) throw new Reject(409, `Sales order ${so.docNo} has not been sent to the factory.`);
    return { ok: true, order: await syncFromFactory('salesOrders', so, FORWARD_SALES) };
  },
  async factorySend(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'salesOrder', 'supervisor', 'Sending an order to the factory');
    const so = await loadOrder(ctx, b.saleId);
    if (!['open', 'inProduction', 'ready'].includes(so.status)) throw new Reject(409, `Sales order ${so.docNo} is ${so.status}.`);
    const order = await pushToFactory(ctx, 'salesOrders', so, 'sales');
    if (order.factory && order.factory.error) throw new Reject(502, order.factory.error);
    return { ok: true, order };
  },
  // the till moves it along (a supervisor or higher), when the factory does not say
  async status(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'salesOrder', 'supervisor', 'Changing an order’s status');
    const so = await loadOrder(ctx, b.saleId);
    const status = clean(b.status, 20);
    if (!['inProduction', 'ready'].includes(status)) throw new Reject(400, 'The status can move to inProduction or ready here.');
    if (so.status === status) return { ok: true, order: so, same: true };
    if (!SALES_NEXT[so.status] || !SALES_NEXT[so.status].includes(status)) throw new Reject(409, `Sales order ${so.docNo} is ${so.status}: it cannot go to ${status}.`);
    const now = nowIso();
    const patch = { status, statusHistory: histOf(so, status, ctx.user.name, 'till', clean(b.note, 200), now), updateDue: true, updatedAt: now };
    if (/^\d{4}-\d{2}-\d{2}$/.test(b.expectedAt || '')) patch.expectedAt = b.expectedAt;
    await patchDoc('salesOrders', so.id, patch);
    await auditRow(ctx, 'salesOrder.status', so, { from: so.status, to: status, source: 'till', note: clean(b.note, 200) });
    return { ok: true, order: { ...so, ...patch } };
  },
  async update(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const so = await loadOrder(ctx, b.saleId);
    const status = SALES_STATUSES.includes(b.status) ? b.status : so.status;
    const how = ['whatsapp', 'phone', 'email'].includes(b.how) ? b.how : 'whatsapp';
    const text = salesOrderText(ctx.entity, ctx.store, so, status);
    const now = nowIso();
    const entry = { at: now, status, how, byName: ctx.user.name };
    await patchDoc('salesOrders', so.id, { updates: [...(so.updates || []), entry].slice(-50), updateDue: false, lastUpdateAt: now, updatedAt: now });
    await auditRow(ctx, 'salesOrder.update', so, { status, how });
    return { ok: true, text, status, how, phone: (so.customerSnapshot || {}).phone || '', email: (so.customerSnapshot || {}).email || '', update: entry };
  },
  // handed to the customer: the invoice was written with the sale; the signed note is kept here
  async handover(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const so = await loadOrder(ctx, b.saleId);
    if (['delivered', 'collected'].includes(so.status)) return { ok: true, order: so, again: true };
    if (!['open', 'inProduction', 'ready'].includes(so.status)) throw new Reject(409, `Sales order ${so.docNo} is ${so.status}.`);
    const kind = b.kind === 'deliver' ? 'deliver' : 'collect';
    const signedBy = clean(b.signedBy, 120);
    const signature = String(b.signature || '').slice(0, 200000);
    if (signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new Reject(400, 'The signature is not a PNG.');
    const now = nowIso();
    const status = kind === 'collect' ? 'collected' : 'delivered';
    const patch = { status, statusHistory: histOf(so, status, ctx.user.name, 'till', clean(b.note, 200), now), updateDue: true, completedAt: now, completedByUid: ctx.user.id, completedByName: ctx.user.name, handover: { signedBy, signature, at: now, byName: ctx.user.name, note: clean(b.note, 300), kind }, updatedAt: now };
    await patchDoc('salesOrders', so.id, patch);
    await auditRow(ctx, 'salesOrder.handover', so, { status, signed: !!signature });
    if (so.factory && so.factory.orders && so.factory.orders.length) await noteHandover(so.factory.companyId, so.factory.orders, `${kind === 'collect' ? 'Collected by' : 'Delivered to'} the customer from the ${ctx.store.name} store on ${now.slice(0, 10)} (sales order ${so.docNo})`).catch(() => {});
    return { ok: true, order: { ...so, ...patch } };
  }
};

const handleRequest = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-salesorder failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};

// every request works in its own customer's space (lib/pos.mjs)
export const handler = withGroup(handleRequest);
