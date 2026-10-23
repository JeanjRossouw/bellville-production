// Retail POS step 12: the pos-special function over HTTP. Opening needs
// the customer and a signed-off spec, takes made-to-order items only; a
// deposit under the minimum leaves it quoted; nothing goes to the factory
// until a supervisor sends it: written into the linked Factory Manager company's own orders with
// the store as the customer and no retail customer data, the factory's
// status read back; the till's status step; updates logged; a delivery
// booking; the hand-over into a tax invoice paid by the order with the
// signed note; cancellation by a manager with no fee before production and
// the deposit after.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ fails, ...R, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za'), sup = await mk('sam@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, specialOrder: { minDepositPct: 50, leadDays: 21 }, factory: { companyId: 'CPTEST', companyName: 'Couch Potato Test' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville', code: '7530' }, active: true, paymentMethods: ['cash', 'card', 'eft', 'account'], ...srv('BF', 'BF-BELL') });
await put('companies/CPTEST', { name: 'Couch Potato Test', ownerUid: 'x', plan: 'free', status: 'free', createdAt: '2026-01-01T00:00:00.000Z' });
await put('companies/CPTEST/settings/factory', { name: 'Couch Potato Test', orderPrefix: 'CP-', firstOrderNo: 1001, leadDays: 21, vatRegistered: true });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, priceCents: 1500000, costCents: 600000 });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000 });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken, headers = {}) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const listAt = async (p) => { const r = await (await fetch(`${docs}/${p}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const patchAt = (p, data) => fetch(`${docs}/${p}?` + Object.keys(data).map(k => 'updateMask.fieldPaths=' + k).join('&'), { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const FO = (id, n = 1) => 'companies/CPTEST/orders/pos-' + id + '-' + n;
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
let n = 0;
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const photo = sig;
const spec = { size: '2.4 m', fabric: 'Linen look', colour: 'Charcoal', legs: 'Oak, tapered', notes: 'Firm seat', photo };
const sofa = (sp = spec) => [{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0, spec: sp }];
const openBody = (lines, total, deposit, o = {}) => ({ action: 'open', orderId: 'so-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines, saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, deposit, signoff: { accepted: true, signedBy: 'T Mokoena', signature: sig }, ...bell, ...o });


const sale = (lines, tenders, o = {}) => ({ action: 'commit', saleId: 'web-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines, saleDiscountCents: 0, tenders, ...bell, ...o });
const sofaLine = (sp = { size: '2.4 m', fabric: 'Linen look', colour: 'Charcoal', legs: 'Oak, tapered', notes: 'Firm seat' }) => ({ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0, note: 'deliver Friday', spec: sp });
const cushion = { productId: 'p_cushion', variantId: '', qty: 2, unitPriceCents: 19900, discountCents: 0 };
const tot = (c) => ({ totalCents: c, vatCents: vatIn(c, 1500) });

// ---- the customer is needed; the sale is written with its sales order, which waits at the till until a supervisor sends it to the factory
R.noCust = await call('pos-sale', sale([sofaLine()], [{ method: 'card', amountCents: 1500000 }], { customerId: '', totals: tot(1500000) })); check('a made-to-order sale without a customer: refused', R.noCust.status === 400 && /needs the customer|add the customer/.test(R.noCust.error), R.noCust);
R.s1 = await call('pos-sale', sale([sofaLine(), cushion], [{ method: 'card', amountCents: 1539800, cardLast4: '4242' }], { totals: tot(1539800) }));
const S1 = R.s1.sale || {}, SO1 = R.s1.salesOrder || {};
check('the sale written: BF-000001, paid by card', R.s1.ok && S1.docNo === 'BF-000001' && S1.totalCents === 1539800, R.s1.error || S1);
check('the invoice line carries the spec in its note, and the spec itself', R.s1.lines[0].note === 'deliver Friday · Size 2.4 m · Fabric Linen look · Colour Charcoal · Legs Oak, tapered' && R.s1.lines[0].spec.model === 'Custom Sofa' && R.s1.lines[0].spec.notes === 'Firm seat' && !R.s1.lines[1].spec, R.s1.lines.map(l => [l.note, l.spec]));
check('the sales order: the sofa only, open, the customer, expected 21 days out', SO1.id === R.s1.sale.id && SO1.docNo === 'BF-000001' && SO1.status === 'open' && SO1.lines.length === 1 && SO1.lines[0].lineNo === 1 && SO1.lines[0].spec.fabric === 'Linen look' && SO1.totalCents === 1500000 && SO1.customerSnapshot.name === 'Thandi Mokoena' && SO1.paidInFull === true && SO1.expectedAt === new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10), SO1);
check('stored, server-only', (await getDoc('pos/retail/salesOrders/' + SO1.id)).status === 'open');
check('not at the factory by itself: it waits at the till', !(SO1.factory && (SO1.factory.orders || []).length) && (await listAt('companies/CPTEST/orders')).length === 0, SO1.factory);
R.sched0 = await (await fetch(FN + 'pos-factory-sync', { method: 'POST' })).json(); check('the schedule does not send it either', R.sched0.ok && (await listAt('companies/CPTEST/orders')).length === 0, R.sched0);
R.sendCas = await call('pos-salesorder', { action: 'factorySend', saleId: SO1.id, ...bell }); check('a cashier cannot send it', R.sendCas.status === 403, R.sendCas);
R.send1 = await call('pos-salesorder', { action: 'factorySend', saleId: SO1.id, ...bell }, sup.idToken);
check('a supervisor sends it: CP-1001, who asked kept', R.send1.ok && R.send1.order.factory.orders.length === 1 && R.send1.order.factory.orders[0].orderNo === 'CP-1001' && R.send1.order.factoryRef === 'CP-1001' && !R.send1.order.factory.error && R.send1.order.factory.requestedBy === 'Sam', R.send1.error || R.send1.order.factory);
R.fo = await getDoc(FO(SO1.id));
check('the factory order: the store as the customer, the invoice as the reference, the spec, no retail customer', R.fo && R.fo.customerId === 'pos-BF-BF-BELL' && R.fo.customerName === 'Bellville Furniture · Bellville' && R.fo.externalRef === 'BF-000001' && R.fo.product === 'Custom Sofa' && R.fo.fabric === 'Linen look / Charcoal' && /Sales order: tax invoice BF-000001/.test(R.fo.notes) && /paid in full/.test(R.fo.notes) && /Legs: Oak, tapered/.test(R.fo.notes) && /Line note: deliver Friday/.test(R.fo.notes) && R.fo.priceEach === 15000 && R.fo.dueDate === SO1.expectedAt && R.fo.status === 'new' && !/Thandi|0825550101|Parow/.test(JSON.stringify(R.fo)), R.fo);
R.again = await call('pos-sale', { ...sale([sofaLine(), cushion], [{ method: 'card', amountCents: 1539800 }], { totals: tot(1539800) }), saleId: S1.id }); check('the same sale again: the first answer, with its sales order', R.again.ok && R.again.again && R.again.salesOrder && R.again.salesOrder.docNo === 'BF-000001', R.again);
check('one factory order, one factory customer', (await listAt('companies/CPTEST/orders')).length === 1 && (await listAt('companies/CPTEST/customers')).length === 1);
R.resend = await call('pos-salesorder', { action: 'factorySend', saleId: SO1.id, ...bell }, sup.idToken); check('sent again: nothing written twice', R.resend.ok && R.resend.order.factory.orders[0].orderNo === 'CP-1001' && (await listAt('companies/CPTEST/orders')).length === 1, R.resend);

// ---- the factory's status comes back; the update; the hand-over
R.upd0 = await call('pos-salesorder', { action: 'update', saleId: SO1.id, ...bell }); check('the order update text', R.upd0.ok && /Thank you for your order \(invoice BF-000001: Custom Sofa\)/.test(R.upd0.text) && R.upd0.phone === '0825550101', R.upd0);
await patchAt(FO(SO1.id), { status: 'in-production' });
R.sync1 = await call('pos-salesorder', { action: 'factorySync', saleId: SO1.id, ...bell }); check('in production, from the factory', R.sync1.ok && R.sync1.order.status === 'inProduction' && R.sync1.order.statusHistory.at(-1).source === 'factory' && R.sync1.order.updateDue === true, R.sync1);
R.cas = await call('pos-salesorder', { action: 'status', saleId: SO1.id, status: 'ready', ...bell }); check('a cashier cannot move the status', R.cas.status === 403, R.cas);
await patchAt(FO(SO1.id), { status: 'ready' });
R.sched = await (await fetch(FN + 'pos-factory-sync', { method: 'POST' })).json(); check('the schedule reads the sales order too', R.sched.ok && /1 checked, 1 moved on/.test(R.sched.done.join()), R.sched);
R.so1b = await getDoc('pos/retail/salesOrders/' + SO1.id); check('ready', R.so1b.status === 'ready' && R.so1b.factory.orders[0].status === 'ready', R.so1b.status);
R.upd1 = await call('pos-salesorder', { action: 'update', saleId: SO1.id, ...bell }); check('the ready update', /is ready for collection at Bellville/.test(R.upd1.text) && (await getDoc('pos/retail/salesOrders/' + SO1.id)).updateDue === false, R.upd1.text);
R.hand = await call('pos-salesorder', { action: 'handover', saleId: SO1.id, kind: 'collect', signedBy: 'Thandi Mokoena', signature: sig, note: 'All good', ...bell });
check('handed over: collected, signed', R.hand.ok && R.hand.order.status === 'collected' && R.hand.order.handover.signedBy === 'Thandi Mokoena' && R.hand.order.handover.signature === sig && R.hand.order.completedAt, R.hand.error || R.hand.order);
R.handAgain = await call('pos-salesorder', { action: 'handover', saleId: SO1.id, kind: 'collect', ...bell }); check('handing over again: nothing changes', R.handAgain.ok && R.handAgain.again, R.handAgain);
R.foDone = await getDoc(FO(SO1.id)); check('the factory order notes the hand-over', R.foDone.events.length === 2 && /Collected by the customer from the Bellville store/.test(R.foDone.events[1].what), R.foDone.events);

// ---- a credit note on the made-to-order line calls the factory order off
R.s2 = await call('pos-sale', sale([sofaLine({ fabric: 'Velvet', colour: 'Teal' })], [{ method: 'eft', amountCents: 1500000, ref: 'MOKOENA' }], { totals: tot(1500000) }));
const SO2 = R.s2.salesOrder || {}; R.send2 = await call('pos-salesorder', { action: 'factorySend', saleId: SO2.id, ...bell }, sup.idToken); check('a second sales order sent to the factory: CP-1002', R.s2.ok && R.send2.ok && R.send2.order.factoryRef === 'CP-1002', R.send2.error || R.s2.error || SO2);
R.cnCas = await call('pos-return', { action: 'credit', creditId: 'cn-sales-' + Date.now().toString(36), saleId: R.s2.sale.id, lines: [{ saleLineNo: 1, qty: 1, reason: 'Changed mind', disposition: 'writeoff' }], refunds: [{ method: 'eft', amountCents: 1500000 }], ...bell }); check('a made-to-order return needs a manager', R.cnCas.status === 403 && /manager/.test(R.cnCas.error), R.cnCas);
R.cn = await call('pos-return', { action: 'credit', creditId: 'cn-sales-' + Date.now().toString(36) + 'b', saleId: R.s2.sale.id, lines: [{ saleLineNo: 1, qty: 1, reason: 'Changed mind', disposition: 'writeoff' }], refunds: [{ method: 'eft', amountCents: 1500000 }], ...bell }, own.idToken);
check('credited by the owner: the sales order cancelled', R.cn.ok && R.cn.creditNote.docNo === 'BF-CN-000001' && R.cn.salesOrder && R.cn.salesOrder.status === 'cancelled' && R.cn.salesOrder.lines[0].cancelledQty === 1 && /Credit note BF-CN-000001/.test(R.cn.salesOrder.cancelReason), R.cn.error || R.cn.salesOrder);
R.fo2 = await getDoc(FO(SO2.id)); check('its factory order cancelled, on record', R.fo2.status === 'cancelled' && /Credit note BF-CN-000001/.test(R.fo2.cancelReason), R.fo2);

// ---- on account: the factory hears it is not paid in full
await put('pos/retail/customers/c1', { ...(await getDoc('pos/retail/customers/c1')), accountEnabled: true, creditLimitCents: 5000000 });
R.s3 = await call('pos-sale', sale([sofaLine()], [{ method: 'account', amountCents: 1500000 }], { totals: tot(1500000) }));
await call('pos-salesorder', { action: 'factorySend', saleId: R.s3.salesOrder.id, ...bell }, sup.idToken);
check('on account: a sales order not paid in full, at the factory as such', R.s3.ok && R.s3.salesOrder.paidInFull === false && /on the customer's account/.test((await getDoc(FO(R.s3.salesOrder.id))).notes), R.s3.error || R.s3.salesOrder);

const audit = await listColl('auditLog'); check('audited', ['salesOrder.factorySent', 'salesOrder.status', 'salesOrder.update', 'salesOrder.handover', 'salesOrder.factoryCancel'].every(a => audit.some(x => x.action === a)) && audit.some(x => x.action === 'salesOrder.status' && x.actorUid === 'factory'), audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R, fo: undefined, foDone: undefined, fo2: undefined }, null, 1).slice(0, 8000));
console.log(fails.length ? fails.length + ' FAILED' : 'salesorder-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
