// Retail POS step 12: the pos-special function over HTTP. Opening needs
// the customer and a signed-off spec, takes made-to-order items only; a
// deposit under the minimum leaves it quoted; reaching it sends nothing (nor
// does the schedule) until a supervisor sends it to the factory: written into the linked Factory Manager company's own orders with
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
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville', code: '7530' }, active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
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

// ---- opening: refusals
R.noCust = await call('pos-special', openBody(sofa(), 1500000, [], { customerId: '' })); check('no customer: refused', R.noCust.status === 400 && /customer/.test(R.noCust.error), R.noCust);
R.stock = await call('pos-special', openBody([...sofa(), { productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], 1519900, [])); check('stock items do not go on a special order', R.stock.status === 400 && /only made-to-order/.test(R.stock.error), R.stock);
R.unsigned = await call('pos-special', openBody(sofa(), 1500000, [], { signoff: { accepted: false, signedBy: 'x' } })); check('unsigned spec: refused', R.unsigned.status === 400 && /sign/.test(R.unsigned.error), R.unsigned);
R.bigPhoto = await call('pos-special', openBody(sofa({ ...spec, photo: 'data:image/jpeg;base64,' + 'A'.repeat(400000) }), 1500000, [])); check('a photo over 300 KB is refused', R.bigPhoto.status === 400 && /300 KB/.test(R.bigPhoto.error), R.bigPhoto);

// ---- quoted with a small deposit; the deposit reached later; it goes to the factory only when a supervisor sends it
R.open = await call('pos-special', openBody(sofa(), 1500000, [{ method: 'card', amountCents: 300000, cardLast4: '4242' }]));
const O = R.open.order || {};
check('opened as BF-SO-000001, quoted (deposit under 50%)', R.open.ok && O.docNo === 'BF-SO-000001' && O.status === 'quoted' && O.minDepositCents === 750000 && O.paidCents === 300000 && O.balanceCents === 1200000 && O.depositCents === 300000, R.open.error || [O.docNo, O.status, O.minDepositCents]);
check('the spec kept, model from the product, photo kept', O.lines[0].spec.model === 'Custom Sofa' && O.lines[0].spec.fabric === 'Linen look' && O.lines[0].spec.photo === photo, O.lines[0].spec);
check('the sign-off reads the spec back with the no-change-of-mind clause', /Fabric Linen look, Colour Charcoal, Legs Oak, tapered/.test(O.signoff.text) && /no change of mind once production has started/.test(O.signoff.text) && /section 20\(2\)\(b\)/.test(O.signoff.text) && /Deposit R 7,500\.00 \(50%\)/.test(O.signoff.text) && O.signoff.signedBy === 'T Mokoena', O.signoff && O.signoff.text);
check('expected 21 days out', O.expectedAt === new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10), O.expectedAt);
let pays = await listColl('payments'); check('the deposit is a payment row', pays.some(p => p.docType === 'specialOrder' && p.docNo === 'BF-SO-000001' && p.instalment === 0 && p.amountCents === 300000), pays);
check('nothing at the factory while quoted', (await listAt('companies/CPTEST/orders')).length === 0 && !O.factory);
R.cos = await call('pos-special', { action: 'factoryCompanies', entityId: 'BF' }, own.idToken); check('the owner sees the factory companies and the link', R.cos.ok && R.cos.companies.some(c => c.id === 'CPTEST' && c.name === 'Couch Potato Test') && R.cos.linked.companyId === 'CPTEST', R.cos);
R.cosCas = await call('pos-special', { action: 'factoryCompanies', entityId: 'BF' }); check('not a cashier', R.cosCas.status === 403, R.cosCas);
R.sendEarly = await call('pos-special', { action: 'factorySend', orderId: O.id, ...bell }, sup.idToken); check('cannot be sent before the deposit', R.sendEarly.status === 409 && /deposit/.test(R.sendEarly.error), R.sendEarly);
R.pay1 = await call('pos-special', { action: 'pay', orderId: O.id, paymentId: 'sp-' + Date.now().toString(36) + '-1', tenders: [{ method: 'cash', amountCents: 450000, tenderedCents: 450000 }], clientCreatedAt: new Date().toISOString(), ...bell });
check('R 4 500 more: the deposit reached, an update due', R.pay1.ok && R.pay1.order.status === 'depositPaid' && R.pay1.order.paidCents === 750000 && R.pay1.order.depositCents === 750000 && R.pay1.order.updateDue === true && R.pay1.order.history.length === 2, R.pay1.error || R.pay1.order);
check('the deposit paid sends nothing: the order stays at the till until someone sends it', !(R.pay1.order.factory && (R.pay1.order.factory.orders || []).length) && (await listAt('companies/CPTEST/orders')).length === 0, R.pay1.order.factory);
R.sched = await call('pos-factory-sync', {}); check('the schedule does not send it either', R.sched.ok && (await listAt('companies/CPTEST/orders')).length === 0 && !((await getDoc('pos/retail/specialOrders/' + O.id)).factory || {}).orders, R.sched);
R.sendCas = await call('pos-special', { action: 'factorySend', orderId: O.id, ...bell }); check('a cashier cannot send it to the factory', R.sendCas.status === 403, R.sendCas);
R.send1 = await call('pos-special', { action: 'factorySend', orderId: O.id, ...bell }, sup.idToken);
check('a supervisor sends it: CP-1001, the ref filled in, who asked kept', R.send1.ok && R.send1.order.factory.companyId === 'CPTEST' && R.send1.order.factory.orders.length === 1 && R.send1.order.factory.orders[0].orderNo === 'CP-1001' && R.send1.order.factoryRef === 'CP-1001' && !R.send1.order.factory.error && R.send1.order.factory.requestedBy === 'Sam' && !!R.send1.order.factory.requestedAt, R.send1.error || R.send1.order.factory);
R.fo = await getDoc(FO(O.id));
check('the factory order: the store as the customer, the SO number, the spec, the price, the due date', R.fo && R.fo.orderNo === 'CP-1001' && R.fo.customerId === 'pos-BF-BF-BELL' && R.fo.customerName === 'Bellville Furniture · Bellville' && R.fo.externalRef === 'BF-SO-000001' && R.fo.source === 'pos' && R.fo.product === 'Custom Sofa' && R.fo.fabric === 'Linen look / Charcoal' && /Size: 2\.4 m/.test(R.fo.notes) && /Legs: Oak, tapered/.test(R.fo.notes) && /Notes: Firm seat/.test(R.fo.notes) && R.fo.priceEach === 15000 && R.fo.qty === 1 && R.fo.dueDate === O.expectedAt && R.fo.status === 'new' && R.fo.photo === photo && R.fo.deliveryAddress === '12 Voortrekker Rd, Bellville, 7530' && R.fo.deliveryContact === 'Bellville', R.fo && { ...R.fo, photo: undefined });
R.fc = await getDoc('companies/CPTEST/customers/pos-BF-BF-BELL');
check('the factory customer is the store, in the POS stores group', R.fc && R.fc.name === 'Bellville Furniture · Bellville' && R.fc.group === 'POS stores' && R.fc.phone === '021 555 0100' && R.fc.source === 'pos', R.fc);
check('no retail customer went to the factory', !/Thandi|Mokoena|0825550101|5 Lane|Parow/.test(JSON.stringify([R.fo, R.fc, await listAt('companies/CPTEST/customers')])));
check('only one factory customer and one order', (await listAt('companies/CPTEST/customers')).length === 1 && (await listAt('companies/CPTEST/orders')).length === 1);
R.resend = await call('pos-special', { action: 'factorySend', orderId: O.id, ...bell }, sup.idToken); check('sending again writes nothing twice', R.resend.ok && R.resend.order.factory.orders[0].orderNo === 'CP-1001' && (await listAt('companies/CPTEST/orders')).length === 1 && (await getDoc('companies/CPTEST/counters/orderNo')).value === 1002, R.resend);
R.upd1 = await call('pos-special', { action: 'update', orderId: O.id, how: 'whatsapp', ...bell });
check('the deposit update: words, number, logged', R.upd1.ok && R.upd1.status === 'depositPaid' && /Thank you for your deposit on order BF-SO-000001/.test(R.upd1.text) && /21 days/.test(R.upd1.text) && R.upd1.phone === '0825550101' && (await getDoc('pos/retail/specialOrders/' + O.id)).updateDue === false, R.upd1);

// ---- the factory: its status comes back to the till
R.syncSame = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell }); check('checked: still new, nothing moves', R.syncSame.ok && R.syncSame.order.status === 'depositPaid' && R.syncSame.order.factory.orders[0].status === 'new' && R.syncSame.order.factory.lastCheckedAt, R.syncSame);
await patchAt(FO(O.id), { status: 'in-production' });
R.f1 = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell });
check('the factory started: in production on the till, from the factory', R.f1.ok && R.f1.order.status === 'inProduction' && R.f1.order.updateDue === true && R.f1.order.statusHistory.at(-1).source === 'factory' && R.f1.order.statusHistory.at(-1).byName === 'Factory Manager' && /CP-1001 in-production/.test(R.f1.order.statusHistory.at(-1).note), R.f1.error || R.f1.order);
R.cash = await call('pos-special', { action: 'status', orderId: O.id, status: 'ready', ...bell }); check('a cashier cannot move the status', R.cash.status === 403 && /supervisor/.test(R.cash.error), R.cash);
R.sup = await call('pos-special', { action: 'status', orderId: O.id, status: 'ready', note: 'Checked', ...bell }, sup.idToken); check('a supervisor marks it ready', R.sup.ok && R.sup.order.status === 'ready' && R.sup.order.statusHistory.at(-1).note === 'Checked', R.sup.error || R.sup.order);
await patchAt(FO(O.id), { status: 'ready' });
R.f2 = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell }); check('the factory done after the till already said ready: nothing changes', R.f2.ok && R.f2.order.status === 'ready' && R.f2.order.factory.orders[0].status === 'ready' && R.f2.order.statusHistory.filter(h => h.status === 'ready').length === 1, R.f2);
R.upd2 = await call('pos-special', { action: 'update', orderId: O.id, ...bell }); check('the ready update names the balance', /is ready/.test(R.upd2.text) && /R 7,500\.00/.test(R.upd2.text) && /collection at Bellville/.test(R.upd2.text), R.upd2);

// ---- delivery: booked, then the balance, then the hand-over with the signed note
R.tooEarly = await call('pos-special', { action: 'deliver', orderId: O.id, saleId: 'sos-early-' + Date.now().toString(36), signedBy: 'T', signature: sig, ...bell }); check('no hand-over with a balance', R.tooEarly.status === 400 && /still owed/.test(R.tooEarly.error), R.tooEarly);
R.bookNoAddr = await call('pos-special', { action: 'book', orderId: O.id, kind: 'deliver', date: '2026-11-21', address: {}, ...bell }); check('a delivery needs an address', R.bookNoAddr.status === 400 && /address/.test(R.bookNoAddr.error), R.bookNoAddr);
R.book = await call('pos-special', { action: 'book', orderId: O.id, kind: 'deliver', date: '2026-11-21', slot: '09:00–12:00', address: { line1: '5 Lane', city: 'Parow' }, driverName: 'Sipho', note: 'Ring the bell', ...bell });
check('booked', R.book.ok && R.book.delivery.kind === 'deliver' && R.book.delivery.date === '2026-11-21' && R.book.delivery.address.city === 'Parow' && R.book.delivery.phone === '0825550101' && R.book.order.updateDue === true, R.book.error || R.book.delivery);
R.upd3 = await call('pos-special', { action: 'update', orderId: O.id, status: 'booked', ...bell }); check('the booking update', /booked for delivery on 2026-11-21 \(09:00–12:00\) to 5 Lane, Parow/.test(R.upd3.text), R.upd3.text);
R.pay2 = await call('pos-special', { action: 'pay', orderId: O.id, paymentId: 'sp-' + Date.now().toString(36) + '-2', tenders: [{ method: 'eft', amountCents: 750000, ref: 'MOKOENA' }], clientCreatedAt: new Date().toISOString(), ...bell });
check('the balance by EFT', R.pay2.ok && R.pay2.order.balanceCents === 0 && R.pay2.order.status === 'ready', R.pay2.error || R.pay2.order);
const saleId = 'sos-' + Date.now().toString(36);
R.deliver = await call('pos-special', { action: 'deliver', orderId: O.id, saleId, signedBy: 'Thandi Mokoena', signature: sig, note: 'All good', ...bell });
check('delivered: tax invoice BF-000001 paid by the special order', R.deliver.ok && R.deliver.sale && R.deliver.sale.docNo === 'BF-000001' && R.deliver.sale.totalCents === 1500000 && R.deliver.sale.paymentMethods.join() === 'specialOrder' && R.deliver.sale.specialOrderOf === 'BF-SO-000001' && R.deliver.sale.customerSnapshot.name === 'Thandi Mokoena', R.deliver.error || R.deliver.sale);
check('the order: delivered, signed note, invoice number', R.deliver.order.status === 'delivered' && R.deliver.order.deliveryNote.signedBy === 'Thandi Mokoena' && R.deliver.order.deliveryNote.signature === sig && R.deliver.order.completedDocNo === 'BF-000001' && R.deliver.order.updateDue === true, R.deliver.order);
check('the invoice line carries the spec', R.deliver.lines[0].note.includes('Fabric Linen look') && R.deliver.lines[0].note.includes('Colour Charcoal'), R.deliver.lines[0].note);
pays = await listColl('payments');
check('one specialOrder tender on the sale, for the price, with the SO number', pays.filter(p => p.docType === 'sale' && p.docId === saleId).length === 1 && pays.find(p => p.docId === saleId).method === 'specialOrder' && pays.find(p => p.docId === saleId).amountCents === 1500000 && pays.find(p => p.docId === saleId).ref === 'BF-SO-000001', pays.filter(p => p.docId === saleId));
check('no stock moved for a made-to-order sofa', (await listColl('stockMovements')).length === 0);
R.again = await call('pos-special', { action: 'deliver', orderId: O.id, saleId, ...bell }); check('delivering again: the first answer stands', R.again.ok && R.again.again && R.again.sale.docNo === 'BF-000001', R.again);
R.upd4 = await call('pos-special', { action: 'update', orderId: O.id, ...bell }); check('the delivered update', /was delivered today/.test(R.upd4.text), R.upd4.text);
R.foDone = await getDoc(FO(O.id)); check('the factory order notes the hand-over', R.foDone.events.length === 2 && /Delivered to the customer from the Bellville store/.test(R.foDone.events[1].what) && R.foDone.status === 'ready', R.foDone.events);

// ---- cancellation: a manager; no fee before production, the deposit after
R.open2 = await call('pos-special', openBody(sofa(), 1500000, [{ method: 'card', amountCents: 300000 }]));
const O2 = R.open2.order; check('second order quoted', R.open2.ok && O2.docNo === 'BF-SO-000002' && O2.status === 'quoted', R.open2.error);
R.cancelCas = await call('pos-special', { action: 'cancel', orderId: O2.id, kind: 'customer', refunds: [{ method: 'cash', amountCents: 300000 }], ...bell }); check('a cashier cannot cancel', R.cancelCas.status === 403 && /manager/.test(R.cancelCas.error), R.cancelCas);
R.feeEarly = await call('pos-special', { action: 'cancel', orderId: O2.id, kind: 'customer', feeCents: 10000, refunds: [{ method: 'cash', amountCents: 290000 }], ...bell }, own.idToken); check('no fee before production starts', R.feeEarly.status === 400 && /before production/.test(R.feeEarly.error), R.feeEarly);
R.cancel2 = await call('pos-special', { action: 'cancel', orderId: O2.id, kind: 'customer', reason: 'Changed mind', refunds: [{ method: 'cash', amountCents: 300000 }], ...bell }, own.idToken);
check('cancelled before production: everything back', R.cancel2.ok && R.cancel2.order.status === 'cancelled' && R.cancel2.order.feeCents === 0 && R.cancel2.order.refundedCents === 300000, R.cancel2.error || R.cancel2.order);
pays = await listColl('payments'); check('the refund as a negative payment', pays.some(p => p.docType === 'refund' && p.docNo === 'BF-SO-000002' && p.amountCents === -300000), pays.filter(p => p.docNo === 'BF-SO-000002'));
R.open3 = await call('pos-special', openBody(sofa(), 1500000, [{ method: 'card', amountCents: 750000 }]));
const O3 = R.open3.order; check('third order straight to deposit paid', R.open3.ok && O3.status === 'depositPaid' && O3.depositCents === 750000, R.open3.error || O3.status);
check('not at the factory on opening, even with the deposit paid', !(O3.factory && (O3.factory.orders || []).length), O3.factory);
R.send3 = await call('pos-special', { action: 'factorySend', orderId: O3.id, ...bell }, sup.idToken);
check('sent by a supervisor: CP-1002', R.send3.ok && R.send3.order.factory.orders[0].orderNo === 'CP-1002' && R.send3.order.factoryRef === 'CP-1002', R.send3.error || R.send3.order.factory);
await patchAt(FO(O3.id), { status: 'in-production' });
R.f3 = await call('pos-special', { action: 'factorySync', orderId: O3.id, ...bell }); check('in production', R.f3.ok && R.f3.order.status === 'inProduction', R.f3);
R.cancel3wrong = await call('pos-special', { action: 'cancel', orderId: O3.id, kind: 'customer', refunds: [{ method: 'cash', amountCents: 750000 }], ...bell }, own.idToken); check('after production starts the deposit stays: the refund must be nil', R.cancel3wrong.status === 400 && /must equal what is owed back: R 0\.00/.test(R.cancel3wrong.error), R.cancel3wrong);
R.cancel3 = await call('pos-special', { action: 'cancel', orderId: O3.id, kind: 'customer', refunds: [], ...bell }, own.idToken);
check('cancelled in production: the deposit is the fee', R.cancel3.ok && R.cancel3.order.feeCents === 750000 && R.cancel3.order.refundedCents === 0 && /work and materials/.test(R.cancel3.order.feeReason), R.cancel3.error || R.cancel3.order);
R.fo3 = await getDoc(FO(O3.id)); check('the factory order is cancelled too, on record', R.fo3.status === 'cancelled' && /Cancelled at the till/.test(R.fo3.cancelReason) && R.fo3.events.at(-1).what.includes('Jean') && R.cancel3.order.factory.orders[0].status === 'cancelled', R.fo3);
R.storeFault = await call('pos-special', openBody(sofa(), 1500000, [{ method: 'card', amountCents: 750000 }]));
R.send4 = await call('pos-special', { action: 'factorySend', orderId: R.storeFault.order.id, ...bell }, sup.idToken); check('the fourth order sent to the factory', R.send4.ok && R.send4.order.factory.orders.length === 1, R.send4.error);
R.cancel4 = await call('pos-special', { action: 'cancel', orderId: R.storeFault.order.id, kind: 'store', reason: 'Fabric discontinued', refunds: [{ method: 'storeCredit', amountCents: 750000 }], ...bell }, own.idToken);
check('we cannot make it: all back, as store credit', R.cancel4.ok && R.cancel4.order.feeCents === 0 && (await getDoc('pos/retail/customers/c1')).storeCreditCents === 750000, R.cancel4.error || R.cancel4.order);
check('its factory order cancelled with the reason', (await getDoc(FO(R.storeFault.order.id))).status === 'cancelled' && /Fabric discontinued/.test((await getDoc(FO(R.storeFault.order.id))).cancelReason));
R.unlink = await call('pos-special', { action: 'factoryLink', entityId: 'BF', companyId: '' }, own.idToken); check('the owner can unlink', R.unlink.ok && R.unlink.linked === null && !((await getDoc('pos/retail/settings/BF')).factory || {}).companyId, R.unlink);
R.relink = await call('pos-special', { action: 'factoryLink', entityId: 'BF', companyId: 'CPTEST' }, own.idToken); check('and link again by id, the name looked up', R.relink.ok && R.relink.linked.companyName === 'Couch Potato Test', R.relink);
R.badLink = await call('pos-special', { action: 'factoryLink', entityId: 'BF', companyId: 'NOPE' }, own.idToken); check('an unknown company is refused', R.badLink.status === 404, R.badLink);
R.counter = await getDoc('pos/retail/counters/BF_SO'); check('SO numbers 1..4 without a gap', R.counter.next === 5, R.counter);
const audit = await listColl('auditLog'); check('audited', ['specialOrder.open', 'specialOrder.pay', 'specialOrder.status', 'specialOrder.update', 'specialOrder.book', 'specialOrder.deliver', 'specialOrder.cancel', 'specialOrder.factorySent', 'specialOrder.factoryCancel', 'factory.link', 'factory.unlink'].every(a => audit.some(x => x.action === a)) && audit.some(x => x.action === 'specialOrder.status' && x.actorUid === 'factory'), audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'special-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
