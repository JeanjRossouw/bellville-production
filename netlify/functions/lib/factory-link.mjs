// Retail POS → Factory Manager: a custom order whose deposit is paid becomes
// factory orders, written by the POS server straight into the factory
// company's own records (companies/<id>/orders). The factory never reaches
// into the POS, and no retail customer goes across: the factory's customer
// is the store, and the order carries the SO number, the specification and
// the store's address. The factory's status comes back the same way, read
// by the POS server.
//
// Both apps live in one Firebase project, so the factory's REST helpers
// (by full path, service account) are used here as they are.
import { getDoc, patchDoc, createDoc, query, listDocs, nextNumber } from './factory-firestore.mjs';

export const STORE_GROUP = 'POS stores';
const now = () => new Date().toISOString();
const r2 = (c) => Math.round(c) / 100;                   // cents → the factory's rands
const safe = (s) => String(s || '').replace(/[^\w-]/g, '_').slice(0, 60);

// the link as the POS keeps it in settings/<entityId>.factory
export const factoryCfg = (settings) => { const f = (settings && settings.factory) || {}; return f.companyId ? { companyId: String(f.companyId), companyName: String(f.companyName || '') } : null; };

// the factory companies the owner may link to
export async function listCompanies() {
  const rows = await listDocs('companies', 200);
  return rows.filter(c => c.name).map(c => ({ id: c.id, name: String(c.name), status: c.status || '' })).sort((a, b) => a.name.localeCompare(b.name));
}
export async function companyNamed(cid) { const c = await getDoc('companies/' + cid); return c && c.name ? String(c.name) : ''; }

// ---- the store as the factory's customer
export const storeCustomerId = (entityId, storeId) => 'pos-' + safe(entityId) + '-' + safe(storeId);
const addrLine = (a) => [a && a.line1, a && a.line2, a && a.city, a && a.code].filter(Boolean).join(', ');
export function storeCustomer(entity, store) {
  const t = now();
  return {
    name: `${entity.tradingName || entity.legalName || entity.id} · ${store.name || store.id}`,
    contact: store.name || '', email: store.email || entity.email || '', phone: store.phone || entity.phone || '',
    address: addrLine(store.address || entity.address), area: (store.address && store.address.city) || (entity.address && entity.address.city) || '',
    termsDays: 0, group: STORE_GROUP, source: 'pos', posEntityId: entity.id, posStoreId: store.id,
    notes: 'A retail POS store. Its custom orders come in from the till when the store sends them; the store hands the goods to its own customer.',
    createdAt: t, createdBy: 'POS', updatedAt: t, updatedBy: 'POS'
  };
}
export async function ensureStoreCustomer(cid, entity, store) {
  const id = storeCustomerId(entity.id, store.id);
  const path = `companies/${cid}/customers/${id}`;
  const had = await getDoc(path);
  const want = storeCustomer(entity, store);
  if (!had) await createDoc(path, want);
  else if (had.name !== want.name || had.phone !== want.phone || had.address !== want.address) await patchDoc(path, { name: want.name, phone: want.phone, email: want.email, address: want.address, area: want.area, updatedAt: now(), updatedBy: 'POS' });
  return { id, name: want.name };
}

// ---- the orders
export const SPEC_LABELS = [['model', 'Model'], ['size', 'Size'], ['fabric', 'Fabric'], ['colour', 'Colour'], ['legs', 'Legs']];
export const orderDocId = (soId, lineNo) => 'pos-' + safe(soId) + '-' + lineNo;
// one factory order for one line of the custom order; the number is filled in by the caller
export function factoryOrderDoc(so, line, lineNo, { customerId, customerName, store, entity, kind = 'custom' }) {
  const t = now();
  const sp = line.spec || {};
  const fabric = [sp.fabric, sp.colour].filter(Boolean).join(' / ');
  const notes = [
    kind === 'sales' ? `Sales order: tax invoice ${so.docNo} from the ${store.name || store.id} store (${entity.tradingName || entity.legalName || entity.id}), ${so.paidInFull === false ? 'on the customer\'s account' : 'paid in full'} at the till.` : `Custom order ${so.docNo} from the ${store.name || store.id} store (${entity.tradingName || entity.legalName || entity.id}), signed off by the customer at the till.`,
    ...SPEC_LABELS.filter(([k]) => sp[k]).map(([k, l]) => `${l}: ${sp[k]}`),
    sp.notes ? 'Notes: ' + sp.notes : '',
    line.note ? 'Line note: ' + line.note : '',
    so.lines.length > 1 ? `Line ${lineNo} of ${so.lines.length} on ${so.docNo}.` : '',
    'Deliver to the store; the store hands it to the customer.'
  ].filter(Boolean).join('\n');
  return {
    customerId, customerName,
    externalRef: so.docNo, source: 'pos',
    posOrderId: so.id, posDocNo: so.docNo, posEntityId: so.entityId, posStoreId: so.storeId, posLineNo: lineNo,
    productId: '', product: sp.model || line.name || 'Custom item', qty: Number(line.qty) || 1,
    fabric, fabricStatus: 'none', notes,
    ...(sp.photo ? { photo: sp.photo } : {}),
    paidDate: (so.lastPaidAt || t).slice(0, 10), dueDate: so.expectedAt || '',
    priceEach: r2(Number(line.qty) > 0 ? Math.round(line.netCents / line.qty) : line.netCents),
    status: 'new',
    deliveryContact: store.name || '', deliveryPhone: store.phone || entity.phone || '', deliveryAddress: addrLine(store.address || entity.address), deliveryInstructions: 'To the store, for ' + so.docNo + '.',
    events: [{ at: t, by: 'POS', what: kind === 'sales' ? `Sales order ${so.docNo} came in from the ${store.name || store.id} till, invoiced` : `Custom order ${so.docNo} came in from the ${store.name || store.id} till, deposit paid` }],
    createdAt: t, createdBy: 'POS', updatedAt: t, updatedBy: 'POS'
  };
}
// write the orders the custom order needs; the ones already there are kept (a resend writes nothing twice)
export async function sendOrder(cid, so, entity, store, kind = 'custom') {
  const settings = (await getDoc(`companies/${cid}/settings/factory`)) || {};
  const cust = await ensureStoreCustomer(cid, entity, store);
  const orders = [];
  for (let i = 0; i < so.lines.length; i++) {
    const lineNo = i + 1;
    const id = orderDocId(so.id, lineNo);
    const path = `companies/${cid}/orders/${id}`;
    const had = await getDoc(path);
    if (had) { orders.push({ id, orderNo: had.orderNo || '', lineNo, status: had.status || 'new' }); continue; }
    const doc = factoryOrderDoc(so, so.lines[i], lineNo, { customerId: cust.id, customerName: cust.name, store, entity, kind });
    const n = await nextNumber(cid, 'orderNo', settings.firstOrderNo || 1001);
    doc.orderNo = (settings.orderPrefix || 'CP-') + n;
    if (!(await createDoc(path, doc))) { const again = await getDoc(path); orders.push({ id, orderNo: (again && again.orderNo) || '', lineNo, status: (again && again.status) || 'new' }); continue; }
    orders.push({ id, orderNo: doc.orderNo, lineNo, status: 'new' });
  }
  return { companyId: cid, customerId: cust.id, orders };
}
// what the factory says now
export async function readOrders(cid, orders) {
  const out = [];
  for (const o of orders || []) { const d = await getDoc(`companies/${cid}/orders/${o.id}`); out.push({ ...o, status: d ? (d.status || 'new') : 'missing', orderNo: (d && d.orderNo) || o.orderNo || '', readyAt: (d && d.readyAt) || '', dueDate: (d && d.dueDate) || '' }); }
  return out;
}
// the custom order's status from its factory orders: building → inProduction; all built (or out of the door) → ready
export function posStatusOf(orders) {
  const live = (orders || []).filter(o => o.status !== 'cancelled' && o.status !== 'missing');
  if (!live.length) return null;
  if (live.every(o => ['ready', 'dispatched', 'invoiced'].includes(o.status))) return 'ready';
  if (live.some(o => ['in-production', 'ready', 'dispatched', 'invoiced'].includes(o.status))) return 'inProduction';
  return null;
}
// the till called it off: the factory orders not yet out of the door are cancelled, on record
export async function cancelOrders(cid, orders, reason, byName) {
  const t = now();
  const done = [];
  for (const o of orders || []) {
    const path = `companies/${cid}/orders/${o.id}`;
    const d = await getDoc(path); if (!d) continue;
    const ev = { at: t, by: 'POS', what: `Cancelled at the till by ${byName || 'the store'}${reason ? ': ' + reason : ''}` };
    if (['dispatched', 'invoiced', 'cancelled'].includes(d.status)) { await patchDoc(path, { events: [...(d.events || []), ev].slice(-100), updatedAt: t, updatedBy: 'POS' }); continue; }
    await patchDoc(path, { status: 'cancelled', cancelledAt: t, cancelReason: 'Cancelled at the till' + (reason ? ': ' + reason : ''), events: [...(d.events || []), ev].slice(-100), updatedAt: t, updatedBy: 'POS' });
    done.push(o.id);
  }
  return done;
}
// a note on the factory orders when the store hands the goods over
export async function noteHandover(cid, orders, what) {
  const t = now();
  for (const o of orders || []) { const path = `companies/${cid}/orders/${o.id}`; const d = await getDoc(path); if (d) await patchDoc(path, { events: [...(d.events || []), { at: t, by: 'POS', what }].slice(-100), updatedAt: t, updatedBy: 'POS' }).catch(() => {}); }
}
export { query as factoryQuery };
