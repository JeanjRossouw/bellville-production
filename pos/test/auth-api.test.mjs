// Retail POS step 12: the pos-special function over HTTP. Opening needs
// the customer and a signed-off spec, takes made-to-order items only; a
// deposit under the minimum leaves it quoted, reaching it sends it to the
// factory: written into the linked Factory Manager company's own orders with
// the store as the customer and no retail customer data, the factory's
// status read back; the till's status step; updates logged; a delivery
// booking; the hand-over into a tax invoice paid by the order with the
// signed note; cancellation by a manager with no fee before production and
// the deposit after.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
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


const man = await mk('mandla@shop.co.za');
await put('pos/retail/users/' + man.localId, { email: 'mandla@shop.co.za', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await patchAt('pos/retail/users/' + cas.localId, { pinSet: true });
await put('pos/retail/pinHashes/' + cas.localId, { ...pinRec('111111'), ...srv('BF') });
await put('pos/retail/pinHashes/' + man.localId, { ...pinRec('222222'), ...srv('BF') });
const secret = 'auth-secret-' + Date.now();
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
await put('pos/retail/devices/dev_a', { label: 'Till 1', registerId: 'r1', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_a') });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, onOrderQty: 0, ...srv('BF', 'BF-BELL') });
const dev = { deviceId: 'dev_a', secret };
const pinLogin = (pin) => call('pos-auth', { action: 'pinLogin', ...dev, pin }, '');
const override = (pin, what, minRole = 'manager') => call('pos-auth', { action: 'override', ...dev, pin, minRole, what, actorUid: cas.localId, actorName: 'Cathy' }, '');

// ---- the till locked after twelve wrong PINs
R.wrongs = [];
for (let i = 0; i < 12; i++) { const r = await pinLogin('999999'); R.wrongs.push([r.status, r.error]); }
check('five wrong: not known; then each PIN locked; the twelfth locks the till', R.wrongs.slice(0, 5).every(x => x[0] === 401) && R.wrongs.slice(5, 11).every(x => x[0] === 423 && /this PIN is locked/.test(x[1])) && R.wrongs[11][0] === 423 && /on this till/.test(R.wrongs[11][1]), R.wrongs);
R.dev = await getDoc('pos/retail/devices/dev_a'); check('the till carries its lock', R.dev.pinLockedUntil > new Date().toISOString() && R.dev.pinFailCount === 0, R.dev);
R.rightLocked = await pinLogin('111111'); check('the right PIN is refused while the till is locked', R.rightLocked.status === 423 && /on this till/.test(R.rightLocked.error), R.rightLocked);
R.ovLocked = await override('222222', 'stock'); check('so is an override from that till', R.ovLocked.status === 423, R.ovLocked);
let audit = await listColl('auditLog'); check('the lock audited', audit.some(a => a.action === 'device.pinLocked' && a.deviceId === 'dev_a' && a.details.wrong === 12), audit.map(a => a.action));
await patchAt('pos/retail/devices/dev_a', { pinLockedUntil: '' });
await patchAt('pos/retail/pinHashes/' + cas.localId, { lockedUntil: '', failedCount: 0 }); await patchAt('pos/retail/pinHashes/' + man.localId, { lockedUntil: '', failedCount: 0 });
R.login = await pinLogin('111111'); check('unlocked: Cathy signs in', R.login.ok && R.login.user.name === 'Cathy' && typeof R.login.token === 'string', R.login.error);
R.wrongAgain = await pinLogin('999999'); R.dev2 = await getDoc('pos/retail/devices/dev_a'); check('a wrong PIN starts a fresh window on the till', R.wrongAgain.status === 401 && R.dev2.pinFailCount === 1 && R.dev2.pinFailWindowStart, R.dev2);
R.login2 = await pinLogin('111111'); R.dev3 = await getDoc('pos/retail/devices/dev_a'); check('a right PIN clears the till\'s count', R.login2.ok && !R.dev3.pinFailCount, R.dev3);

// ---- an approval is good once: on an action
R.ov = await override('222222', 'stock'); check('Mandla approves', R.ov.ok && R.ov.name === 'Mandla' && R.ov.token, R.ov);
R.adj1 = await call('pos-stock', { action: 'adjust', adjustId: 'adj-once-0001', productId: 'p_cushion', qty: -1, code: 'damaged', approvalToken: R.ov.token, ...bell }); check('the adjustment with the approval', R.adj1.ok && R.adj1.level.onHandQty === 9, R.adj1.error);
R.adj2 = await call('pos-stock', { action: 'adjust', adjustId: 'adj-once-0002', productId: 'p_cushion', qty: -1, code: 'damaged', approvalToken: R.ov.token, ...bell }); check('the same approval again: refused, nothing adjusted', R.adj2.status === 403 && /used already/.test(R.adj2.error) && (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 9, R.adj2);
R.adjReplay = await call('pos-stock', { action: 'adjust', adjustId: 'adj-once-0001', productId: 'p_cushion', qty: -1, code: 'damaged', approvalToken: R.ov.token, ...bell }); check('the first adjustment resent with its token: refused too (the token is spent before the replay check), stock untouched', R.adjReplay.status === 403 && (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 9, R.adjReplay);
audit = await listColl('auditLog'); check('the adjustment audited with the approver', audit.some(a => a.action === 'stock.adjust' && a.overrideName === 'Mandla'), audit.filter(a => a.action === 'stock.adjust'));

// ---- on a cash movement (pos-shift has its own door)
R.shift = await call('pos-shift', { action: 'open', ...dev, float: { denoms: { '10000': 3, '2000': 5, '100': 10 }, totalCents: 41000 } }); check('the shift opened', R.shift.ok, R.shift.error);
R.ovCash = await override('222222', 'cash', 'supervisor'); check('a cash approval', R.ovCash.ok, R.ovCash);
R.cm1 = await call('pos-shift', { action: 'cashMove', ...dev, shiftId: R.shift.shift.id, kind: 'out', amountCents: 10000, reason: 'Cash drop', approvalToken: R.ovCash.token, moveId: 'cm-once-0001' }); check('cash out with the approval', R.cm1.ok && R.cm1.movement.approvedBy.name === 'Mandla', R.cm1);
R.cm2 = await call('pos-shift', { action: 'cashMove', ...dev, shiftId: R.shift.shift.id, kind: 'out', amountCents: 10000, reason: 'Cash drop', approvalToken: R.ovCash.token, moveId: 'cm-once-0002' }); check('again: refused', R.cm2.status === 403 && /used already/.test(R.cm2.error), R.cm2);

// ---- on a sale line: a discount over the cashier's limit
R.ovDisc = await override('222222', 'discount'); check('a discount approval', R.ovDisc.ok, R.ovDisc);
const saleBody = (id) => ({ action: 'commit', saleId: id, clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 3980, discountPct: 20, discountReason: 'Display', discountToken: R.ovDisc.token }], saleDiscountCents: 0, totals: { totalCents: 15920, vatCents: vatIn(15920, 1500) }, tenders: [{ method: 'card', amountCents: 15920 }], ...dev });
R.s1 = await call('pos-sale', saleBody('web-once-' + Date.now().toString(36)));
check('the sale with the approved discount', R.s1.ok && R.s1.lines[0].discountBy && R.s1.lines[0].discountBy.name === 'Mandla', R.s1.error || R.s1.lines);
R.s1again = await call('pos-sale', saleBody(R.s1.sale.id)); check('the same sale again: still the first answer', R.s1again.ok && R.s1again.again, R.s1again);
R.s2 = await call('pos-sale', saleBody('web-once-' + Date.now().toString(36) + 'b')); check('a second sale on the same approval: refused', R.s2.status === 403 && /used already/.test(R.s2.error), R.s2);
R.spent = await listColl('usedTokens'); check('three approvals spent, server only', R.spent.length === 3 && R.spent.every(x => x.usedAt && x.expiresAt && x.overrideUid === man.localId), R.spent.map(x => x.action));

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 7000));
console.log(fails.length ? fails.length + ' FAILED' : 'auth-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
