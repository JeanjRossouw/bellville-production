// Retail POS → Factory Manager, for any POS document that carries
// made-to-order lines (a custom order in specialOrders, a sales order in
// salesOrders): the push once the money is in, the status read back, the
// schedule's way in, and the cancellation. The document needs id, docNo,
// entityId, storeId, lines [ { qty, name, netCents, note, spec } ],
// expectedAt and lastPaidAt; it gets factory {…} and factoryRef.
import { getDoc, patchDoc, nowIso, audit } from './pos.mjs';
import { factoryCfg, sendOrder, readOrders, posStatusOf, cancelOrders } from './factory-link.mjs';

export const KIND_LABEL = { custom: 'Custom order', sales: 'Sales order' };
export const histOf = (doc, status, byName, source, note, now) => [...(doc.statusHistory || []), { status, at: now, byName, source, note: note || '' }].slice(-50);
const row = (ctx, action, coll, doc, details) => audit({ action, docType: coll === 'salesOrders' ? 'salesOrder' : 'specialOrder', docId: doc.id, docNo: doc.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, details, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });

// the document written into the linked factory company; a failure is kept on the document and tried again by the schedule
export async function pushToFactory(ctx, coll, doc, kind = 'custom') {
  const cfg = factoryCfg(ctx.settings);
  if (!cfg) return doc;    // no factory linked: the till moves the status by hand
  const store = ctx.store || (await getDoc('stores', doc.storeId)) || { id: doc.storeId, name: doc.storeId };
  try {
    const sent = await sendOrder(cfg.companyId, doc, { ...ctx.entity, id: ctx.entityId }, { ...store, id: doc.storeId }, kind);
    const factory = { companyId: cfg.companyId, companyName: cfg.companyName, customerId: sent.customerId, orders: sent.orders, sentAt: doc.factory && doc.factory.sentAt ? doc.factory.sentAt : nowIso(), lastCheckedAt: nowIso(), error: '' };
    const factoryRef = sent.orders.map(o => o.orderNo).filter(Boolean).join(', ');
    const patch = { factory, factoryRef, updatedAt: nowIso() };
    await patchDoc(coll, doc.id, patch);
    await row(ctx, (coll === 'salesOrders' ? 'salesOrder' : 'specialOrder') + '.factorySent', coll, doc, { companyId: cfg.companyId, orders: factoryRef });
    return { ...doc, ...patch };
  } catch (e) {
    console.error('factory send', e.message);
    const factory = { ...(doc.factory || {}), companyId: cfg.companyId, companyName: cfg.companyName, error: 'Not at the factory yet: ' + String(e.message).slice(0, 200) + '. It will be tried again.' };
    await patchDoc(coll, doc.id, { factory }).catch(() => {});
    await row(ctx, (coll === 'salesOrders' ? 'salesOrder' : 'specialOrder') + '.factoryFailed', coll, doc, { error: String(e.message).slice(0, 200) }).catch(() => {});
    return { ...doc, factory };
  }
}
// the schedule's way in: the same push, with the entity and settings read here
export async function pushForSchedule(entity, settings, coll, doc, kind) {
  const store = await getDoc('stores', doc.storeId);
  const ctx = { entityId: doc.entityId, storeId: doc.storeId, entity: { ...entity, id: entity.id }, settings, store: { ...(store || { name: doc.storeId }), id: doc.storeId }, user: { id: 'server', name: 'Schedule' }, deviceId: 'server' };
  return pushToFactory(ctx, coll, doc, kind);
}
// the factory's status read back; the document moved forward when the factory has.
// `forward` says which steps the factory may cause from each status.
export async function syncFromFactory(coll, doc, forward) {
  const orders = await readOrders(doc.factory.companyId, doc.factory.orders);
  const now = nowIso();
  const factory = { ...doc.factory, orders, lastCheckedAt: now, error: '' };
  const patch = { factory, factoryRef: orders.map(o => o.orderNo).filter(Boolean).join(', ') || doc.factoryRef || '', updatedAt: now };
  const to = posStatusOf(orders);
  if (to && (forward[doc.status] || []).includes(to)) {
    const note = orders.filter(o => o.orderNo).map(o => `${o.orderNo} ${o.status}`).join(', ');
    patch.status = to; patch.statusHistory = histOf(doc, to, 'Factory Manager', 'factory', note, now); patch.updateDue = true;
    await audit({ action: (coll === 'salesOrders' ? 'salesOrder' : 'specialOrder') + '.status', docType: coll === 'salesOrders' ? 'salesOrder' : 'specialOrder', docId: doc.id, docNo: doc.docNo, actorUid: 'factory', actorName: 'Factory Manager', details: { from: doc.status, to, source: 'factory', note }, entityId: doc.entityId, storeId: doc.storeId, deviceId: 'factory' });
  }
  await patchDoc(coll, doc.id, patch);
  return { ...doc, ...patch };
}
// the till called it off (all of it, or some lines): the factory orders cancelled, the document's factory block refreshed
export async function cancelAtFactory(ctx, coll, doc, orders, reason) {
  if (!doc.factory || !orders || !orders.length) return doc;
  try {
    const done = await cancelOrders(doc.factory.companyId, orders, reason, ctx.user.name);
    const all = await readOrders(doc.factory.companyId, doc.factory.orders);
    const factory = { ...doc.factory, orders: all, lastCheckedAt: nowIso(), error: '' };
    await patchDoc(coll, doc.id, { factory });
    await row(ctx, (coll === 'salesOrders' ? 'salesOrder' : 'specialOrder') + '.factoryCancel', coll, doc, { cancelled: done, kept: all.filter(o => !done.includes(o.id) && orders.some(x => x.id === o.id)).map(o => o.orderNo) });
    return { ...doc, factory };
  } catch (e) {
    console.error('factory cancel', e.message);
    const factory = { ...doc.factory, error: 'Could not cancel at the factory: ' + String(e.message).slice(0, 200) };
    await patchDoc(coll, doc.id, { factory }).catch(() => {});
    return { ...doc, factory };
  }
}
