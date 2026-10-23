// Factory Manager POS: each business has its own space (pos/{group}). A
// second business with the same company and store codes as the first shops
// ('BF', 'BF-BELL') signs in, rings up and approves inside its own space only:
// the server works out the space from the login's record (posMembers), the
// till's enrolment, or the default ('retail') for the first shops, who have no
// record; a till of one space cannot sign in to the other; an approval made in
// one space is no good in the other; a login already in one business cannot
// be added to another; the schedules go through every space.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, pbkdf2Sync } from 'node:crypto';
const pinRec = (pin) => { const salt = '56'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
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
const G2 = 'gTwoShop';
// ---- the first shops (the default space, no posMembers records)
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za');
const seed = async (g, names) => {
  await put(`pos/${g}/entities/BF`, { legalName: names.legal, tradingName: names.trading, vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
  await put(`pos/${g}/settings/BF`, { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, ...srv('BF') });
  await put(`pos/${g}/stores/BF-BELL`, { entityId: 'BF', name: names.store, active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
  await put(`pos/${g}/products/p_lamp`, { name: names.product, sku: 'LA-1', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 20000, priceCents: 50000, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...srv('BF') });
  await put(`pos/${g}/stockLevels/BF-BELL_p_lamp`, { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 0, onOrderQty: 0, ...srv('BF', 'BF-BELL') });
  await put(`pos/${g}/registers/r1`, { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
};
await seed('retail', { legal: 'Bellville Furniture (Pty) Ltd', trading: 'Bellville Furniture', store: 'Bellville', product: 'Lamp' });
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/' + cas.localId, { ...pinRec('111111'), ...srv('BF') });
const secret1 = 'g1-secret-' + Date.now();
await put('pos/retail/devices/dev_a', { label: 'Till 1', registerId: 'r1', secretHash: createHash('sha256').update(secret1).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_a') });
// ---- a second business, signed up, with the same codes
const own2 = await mk('owner@othershop.co.za'), cas2 = await mk('sipho@othershop.co.za'), man2 = await mk('lerato@othershop.co.za');
await put('posGroups/' + G2, { name: 'Other Shop', ownerUid: own2.localId, status: 'trial', trialEndsAt: new Date(Date.now() + 10 * 86400000).toISOString(), createdAt: '2026-10-23T08:00:00.000Z' });
for (const u of [own2, cas2, man2]) await put('posMembers/' + u.localId, { groupId: G2, at: '2026-10-23T08:00:00.000Z' });
await seed(G2, { legal: 'Other Shop (Pty) Ltd', trading: 'Other Shop', store: 'High Street', product: 'Desk Lamp' });
await put(`pos/${G2}/users/` + own2.localId, { email: 'owner@othershop.co.za', name: 'Nomsa', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put(`pos/${G2}/users/` + cas2.localId, { email: 'sipho@othershop.co.za', name: 'Sipho', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put(`pos/${G2}/users/` + man2.localId, { email: 'lerato@othershop.co.za', name: 'Lerato', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put(`pos/${G2}/pinHashes/` + cas2.localId, { ...pinRec('333333'), ...srv('BF') });
await put(`pos/${G2}/pinHashes/` + man2.localId, { ...pinRec('444444'), ...srv('BF') });
const secret2 = 'g2-secret-' + Date.now();
await put(`pos/${G2}/devices/dev_b`, { label: 'Front till', registerId: 'r1', secretHash: createHash('sha256').update(secret2).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-23T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_b') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const listIn = async (g, coll) => { const r = await (await fetch(`${docs}/pos/${g}/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };

// ---- who am I: each login lands in its own space
R.me1 = await call('pos-auth', { action: 'me' }, own.idToken);
R.me2 = await call('pos-auth', { action: 'me' }, own2.idToken);
check('the first shops (no record) are in the default space', R.me1.groupId === 'retail' && R.me1.user && R.me1.user.name === 'Jean', R.me1);
check('the new business is in its own space', R.me2.groupId === G2 && R.me2.user && R.me2.user.name === 'Nomsa', R.me2);

// ---- the same company code, two businesses, two customer lists
R.c2 = await call('pos-customer', { action: 'save', name: 'Thandi Mokoena', phone: '082 555 0101', ...bell }, cas2.idToken);
R.c1 = await call('pos-customer', { action: 'save', name: 'Thandi M.', phone: '082 555 0101', ...bell }, cas.idToken);
check('the same cell number is fine in each business (no clash across them)', R.c2.ok && R.c1.ok, [R.c2, R.c1]);
R.cust2 = await listIn(G2, 'customers'); R.cust1 = await listIn('retail', 'customers');
check('each customer is stored in its own business only', R.cust2.length === 1 && R.cust2[0].name === 'Thandi Mokoena' && R.cust1.length === 1 && R.cust1[0].name === 'Thandi M.', [R.cust2.map(c => c.name), R.cust1.map(c => c.name)]);

// ---- tills: a till signs in only to its own business
R.pin2 = await call('pos-auth', { action: 'pinLogin', deviceId: 'dev_b', secret: secret2, groupId: G2, pin: '333333' });
check('the new business\'s till: Sipho signs in, the device names its space', R.pin2.ok && R.pin2.user.name === 'Sipho' && R.pin2.device.groupId === G2 && !!R.pin2.token, R.pin2);
R.pinNoGroup = await call('pos-auth', { action: 'pinLogin', deviceId: 'dev_b', secret: secret2, pin: '333333' });
R.pinWrong = await call('pos-auth', { action: 'pinLogin', deviceId: 'dev_b', secret: secret2, groupId: 'retail', pin: '333333' });
check('that till cannot sign in to the first shops\' space', !R.pinNoGroup.ok && !R.pinWrong.ok && R.pinNoGroup.status >= 400 && R.pinWrong.status >= 400, [R.pinNoGroup, R.pinWrong]);
R.pin1 = await call('pos-auth', { action: 'pinLogin', deviceId: 'dev_a', secret: secret1, groupId: 'retail', pin: '111111' });
R.pin1b = await call('pos-auth', { action: 'pinLogin', deviceId: 'dev_a', secret: secret1, pin: '111111' });
check('the first shops\' till works with or without naming its space', R.pin1.ok && R.pin1b.ok && R.pin1.device.groupId === 'retail', [R.pin1, R.pin1b]);
R.pinX = await call('pos-auth', { action: 'pinLogin', deviceId: 'dev_a', secret: secret1, groupId: G2, pin: '111111' });
check('and cannot be pointed at the other business', !R.pinX.ok && R.pinX.status >= 400, R.pinX);

// ---- an approval made in one business is no good in the other
R.ov2 = await call('pos-auth', { action: 'override', deviceId: 'dev_b', secret: secret2, groupId: G2, pin: '444444', minRole: 'manager', what: 'stock', actorUid: cas2.localId, actorName: 'Sipho' });
check('Lerato approves in her business', R.ov2.ok && !!R.ov2.token, R.ov2);
const adj = (tok, id) => ({ action: 'adjust', adjustId: 'adj-' + id + '-' + Date.now().toString(36), productId: 'p_lamp', variantId: '', qty: 2, bucket: 'onHand', code: 'found', note: '', approvalToken: tok, ...bell });
R.adjOther = await call('pos-stock', adj(R.ov2.token, 'x'), cas.idToken);
check('her approval is refused in the first shops\' space', !R.adjOther.ok && R.adjOther.status === 403, R.adjOther);
R.adjOwn = await call('pos-stock', adj(R.ov2.token, 'y'), cas2.idToken);
check('and accepted in her own', R.adjOwn.ok, R.adjOwn);
check('only her business\'s stock moved', (await getDoc(`pos/${G2}/stockLevels/BF-BELL_p_lamp`)).onHandQty === 7 && (await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp')).onHandQty === 5);

// ---- a login is in one business only
R.steal = await call('pos-auth', { action: 'createUser', name: 'Cathy', role: 'cashier', email: 'cathy@shop.co.za', entityIds: ['BF'], storeIds: ['BF-BELL'] }, own2.idToken);
check('the other business cannot add a first-shops login', R.steal.status === 409 && /another business/.test(R.steal.error), R.steal);
R.newStaff = await call('pos-auth', { action: 'createUser', name: 'Zola', role: 'cashier', entityIds: ['BF'], storeIds: ['BF-BELL'], pin: '555555' }, own2.idToken);
check('a new person added in a business is recorded in it', R.newStaff.ok && (await getDoc('posMembers/' + R.newStaff.uid)).groupId === G2 && !!(await getDoc(`pos/${G2}/users/` + R.newStaff.uid)) && !(await getDoc('pos/retail/users/' + R.newStaff.uid)), R.newStaff);

// ---- reports read their own business
const today = new Date().toISOString().slice(0, 10);
R.rep2 = await call('pos-report', { action: 'run', report: 'stockValue', entityId: 'BF', from: today, to: today }, own2.idToken);
R.rep1 = await call('pos-report', { action: 'run', report: 'stockValue', entityId: 'BF', from: today, to: today }, own.idToken);
check('stock reports name each business\'s own product', JSON.stringify(R.rep2).includes('Desk Lamp') && !JSON.stringify(R.rep2).includes('"Lamp"') && JSON.stringify(R.rep1).includes('Lamp') && !JSON.stringify(R.rep1).includes('Desk Lamp'), [JSON.stringify(R.rep2).slice(0, 200), JSON.stringify(R.rep1).slice(0, 200)]);

// ---- the schedules go through every space
R.sched = await (await fetch(FN + 'pos-shopify-sync', { method: 'POST' })).json();
check('a schedule runs through every space without failing', R.sched.ok === true, R.sched);

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 6000));
console.log(fails.length ? fails.length + ' FAILED' : 'groups-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
