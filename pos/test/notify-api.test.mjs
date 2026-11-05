// Retail POS: automatic client messages (pos-notify, pos-notify-sweep, lib/notify.mjs) and the live expected
// date from the factory (lib/factory-bridge.mjs). The owner sets the keys and switches it on; a custom order's
// deposit, the factory moving the date, the factory starting, a supervisor marking it ready each get a message
// by SMS or email (the test server stands in for BulkSMS and Resend and keeps what was posted); a customer
// nobody can reach stays on the board with the reason; the customer's own choice of channel is honoured.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const SINK = 'http://localhost:8788/__notify';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ fails, ...R, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const patchAt = (p, data) => fetch(`${docs}/${p}?` + Object.keys(data).map(k => 'updateMask.fieldPaths=' + k).join('&'), { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za'), sup = await mk('sam@shop.co.za'), mgr = await mk('mandla@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, phone: '0821234567', ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + mgr.localId, { email: 'mandla@shop.co.za', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, specialOrder: { minDepositPct: 50, leadDays: 21 }, factory: { companyId: 'CPTEST', companyName: 'Couch Potato Test' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville', code: '7530' }, active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
await put('companies/CPTEST', { name: 'Couch Potato Test', ownerUid: 'x', plan: 'free', status: 'free', createdAt: '2026-01-01T00:00:00.000Z' });
await put('companies/CPTEST/settings/factory', { name: 'Couch Potato Test', orderPrefix: 'CP-', firstOrderNo: 1001, leadDays: 21, vatRegistered: true });
await put('pos/retail/products/p_sofa', { name: 'Custom Sofa', sku: '', barcodes: [], category: '', brand: '', type: 'mto', vatClass: 'standard', trackStock: false, costCents: 600000, priceCents: 1500000, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...srv('BF') });
const cust = (id, o) => put('pos/retail/customers/' + id, { phone: '', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...o, ...srv('BF') });
await cust('c1', { name: 'Thandi Mokoena', phone: '0825550101', email: 'thandi@example.com' });
await cust('c2', { name: 'Mr FAIL Test', phone: '0835550102' });            // FAIL in the text makes the stand-in provider refuse
await cust('c3', { name: 'Quiet Customer', phone: '0845550103', email: 'quiet@example.com', notifyBy: 'none' });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const sink = async () => (await fetch(SINK)).json();
const clearSink = () => fetch(SINK, { method: 'DELETE' });
const sweep = () => call('pos-notify-sweep', {}, null);
const FO = (id, n = 1) => 'companies/CPTEST/orders/pos-' + id + '-' + n;
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
let n = 0;
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const sofa = () => [{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0, spec: { size: '2.4 m', fabric: 'Linen look', colour: 'Charcoal' } }];
const openBody = (customerId, o = {}) => ({ action: 'open', orderId: 'so-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId, lines: sofa(), saleDiscountCents: 0, totals: { totalCents: 1500000, vatCents: vatIn(1500000, 1500) }, deposit: [{ method: 'card', amountCents: 750000, cardLast4: '4242', approvalCode: '123456' }], signoff: { accepted: true, signedBy: 'T Mokoena', signature: sig }, ...bell, ...o });
const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// ---- setting up: the owner, the keys kept on the server, a test message
R.setCas = await call('pos-notify', { action: 'setup', entityId: 'BF', auto: true }); check('a cashier cannot set it up', R.setCas.status === 403, R.setCas);
R.setMgr = await call('pos-notify', { action: 'setup', entityId: 'BF', auto: true }, mgr.idToken); check('nor a manager', R.setMgr.status === 403, R.setMgr);
R.setNoKeys = await call('pos-notify', { action: 'setup', entityId: 'BF', auto: true }, own.idToken); check('on with no keys: refused', R.setNoKeys.status === 400 && /at least one channel/.test(R.setNoKeys.error), R.setNoKeys);
R.setup = await call('pos-notify', { action: 'setup', entityId: 'BF', auto: true, channels: ['sms', 'email'], from: 'Bellville Furniture <orders@bellville.test>', bulksmsTokenId: 'tid-1', bulksmsTokenSecret: 'tsecret-1', resendApiKey: 're_test_key', siteUrl: 'http://localhost:8788' }, own.idToken);
check('set up: on, SMS and email ready, WhatsApp not', R.setup.ok && R.setup.notify.auto === true && R.setup.notify.ready.sms === true && R.setup.notify.ready.email === true && R.setup.notify.ready.whatsapp === false && R.setup.notify.siteUrl === 'http://localhost:8788', R.setup);
R.secrets = await getDoc('pos/retail/notifySecrets/BF'); check('the keys on the server', R.secrets && R.secrets.bulksmsTokenId === 'tid-1' && R.secrets.resendApiKey === 're_test_key', R.secrets);
R.status = await call('pos-notify', { action: 'status', entityId: 'BF' }, mgr.idToken); check('a manager sees what is set up, never the keys', R.status.ok && R.status.auto && R.status.ready.sms && R.status.hasKeys && R.status.due === 0 && !/tsecret|re_test/.test(JSON.stringify(R.status)), R.status);
R.statusCas = await call('pos-notify', { action: 'status', entityId: 'BF' }); check('not a cashier', R.statusCas.status === 403, R.statusCas);
await clearSink();
R.testSms = await call('pos-notify', { action: 'test', entityId: 'BF', channel: 'sms', phone: '082 123 4567' }, own.idToken);
R.testEmail = await call('pos-notify', { action: 'test', entityId: 'BF', channel: 'email', email: 'jean@example.com' }, own.idToken);
R.testWa = await call('pos-notify', { action: 'test', entityId: 'BF', channel: 'whatsapp', phone: '0821234567' }, own.idToken);
let got = await sink();
check('the test SMS: BulkSMS, basic auth of the token, +27 number', R.testSms.ok && R.testSms.to === '+27821234567' && got[0] && got[0].provider === 'sms' && got[0].auth === 'Basic ' + Buffer.from('tid-1:tsecret-1').toString('base64') && got[0].body.to === '+27821234567' && /test of the automatic order updates/.test(got[0].body.body), [R.testSms, got[0]]);
check('the test email: Resend, the sender, the subject', R.testEmail.ok && got[1] && got[1].provider === 'email' && got[1].auth === 'Bearer re_test_key' && got[1].body.from === 'Bellville Furniture <orders@bellville.test>' && got[1].body.to.join() === 'jean@example.com' && /a test from the till/.test(got[1].body.subject), [R.testEmail, got[1]]);
check('WhatsApp is not set up: the test says so', R.testWa.status === 400 && /not set up/.test(R.testWa.error), R.testWa);
R.secretsKept = await call('pos-notify', { action: 'setup', entityId: 'BF', auto: true, channels: ['sms', 'email'], from: 'Bellville Furniture <orders@bellville.test>', siteUrl: 'http://localhost:8788' }, own.idToken);
check('saving again with blank keys keeps them', R.secretsKept.ok && R.secretsKept.notify.ready.sms === true && (await getDoc('pos/retail/notifySecrets/BF')).bulksmsTokenSecret === 'tsecret-1', R.secretsKept);

// ---- the deposit paid: the first message goes by itself, with the client's link
await clearSink();
R.open = await call('pos-special', openBody('c1'));
const O = R.open.order || {};
check('opened with the deposit: an update due', R.open.ok && O.status === 'depositPaid' && O.updateDue === true, R.open.error || O);
R.sw1 = await sweep();
got = await sink();
check('the schedule sent it: one SMS, logged', R.sw1.ok && R.sw1.done.some(x => /retail\/BF: 1 sent, 0 left/.test(x)) && got.length === 1 && got[0].provider === 'sms' && got[0].body.to === '+27825550101', [R.sw1, got.map(g => [g.provider, g.body.to])]);
check('the deposit text, with the link to the order page on the site', /Thank you for your deposit on order BF-SO-000001/.test(got[0].body.body) && /http:\/\/localhost:8788\/pos\/track\.html\?t=/.test(got[0].body.body), got[0].body.body);
let o = await getDoc('pos/retail/specialOrders/' + O.id);
check('on the order: sent by Automatic by SMS, nothing due', o.updateDue === false && o.updates.length === 1 && o.updates[0].auto === true && o.updates[0].how === 'sms' && o.updates[0].byName === 'Automatic' && o.updates[0].to === '+27825550101' && o.updates[0].status === 'depositPaid' && !!o.lastUpdateAt && !!o.trackToken, o.updates);
R.sw1b = await sweep(); check('nothing more to send', R.sw1b.ok && !R.sw1b.done.length && (await sink()).length === 1, R.sw1b);
check('audited as Automatic', (await listColl('auditLog')).some(a => a.action === 'specialOrder.update' && a.actorName === 'Automatic' && a.details.how === 'sms'));

// ---- the factory moves the date: the expected date follows, and the client hears
R.send = await call('pos-special', { action: 'factorySend', orderId: O.id, ...bell }, sup.idToken); check('sent to the factory with the expected date as its due date', R.send.ok && (await getDoc(FO(O.id))).dueDate === O.expectedAt, R.send.error);
const later = plusDays(35);
await patchAt(FO(O.id), { dueDate: later });
R.sync1 = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell });
check('the factory\'s date is the expected date now, on record, an update due for the date', R.sync1.ok && R.sync1.order.expectedAt === later && R.sync1.order.status === 'depositPaid' && R.sync1.order.updateDue === true && R.sync1.order.updateReason === 'eta' && R.sync1.order.edits.at(-1).byName === 'Factory Manager' && R.sync1.order.edits.at(-1).changes[0].field === 'expected' && R.sync1.order.edits.at(-1).changes[0].after === later, R.sync1.error || R.sync1.order);
R.syncSame = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell }); check('the same date again: nothing new', R.syncSame.ok && R.syncSame.order.edits.length === 1, R.syncSame.order && R.syncSame.order.edits);
await clearSink();
R.sw2 = await sweep(); got = await sink();
check('the date message', got.length === 1 && new RegExp('expected date for your order BF-SO-000001 .* has moved to ' + later).test(got[0].body.body), got.map(g => g.body.body));
o = await getDoc('pos/retail/specialOrders/' + O.id);
check('logged as the date', o.updateDue === false && o.updates.at(-1).reason === 'eta' && o.updateReason === '', o.updates);
check('audited: the factory moved the date', (await listColl('auditLog')).some(a => a.action === 'specialOrder.expected' && a.actorName === 'Factory Manager' && a.details.after === later));
// the factory starts and moves the date in the same breath: the status message carries the new date
const later2 = plusDays(40);
await patchAt(FO(O.id), { status: 'in-production', dueDate: later2 });
R.sync2 = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell });
check('in production, the date moved again, the status message due', R.sync2.ok && R.sync2.order.status === 'inProduction' && R.sync2.order.expectedAt === later2 && R.sync2.order.updateDue === true && R.sync2.order.updateReason === '', R.sync2.error || R.sync2.order);
await clearSink(); R.sw3 = await sweep(); got = await sink();
check('"in production, expected around" the new date', got.length === 1 && new RegExp('is now in production, expected around ' + later2).test(got[0].body.body), got.map(g => g.body.body));
// a finished order keeps its date even if the factory's due date is older
await patchAt(FO(O.id), { status: 'ready', dueDate: plusDays(1) });
R.sync3 = await call('pos-special', { action: 'factorySync', orderId: O.id, ...bell });
check('ready: the date is no longer the factory\'s to move', R.sync3.ok && R.sync3.order.status === 'ready' && R.sync3.order.expectedAt === later2, R.sync3.order && [R.sync3.order.status, R.sync3.order.expectedAt]);

// ---- the customer's own choice: email first
await patchAt('pos/retail/customers/c1', { notifyBy: 'email' });
await clearSink(); R.sw4 = await sweep(); got = await sink();
check('ready went by email, as she asked', got.length === 1 && got[0].provider === 'email' && got[0].body.to.join() === 'thandi@example.com' && /your order BF-SO-000001 · Ready/.test(got[0].body.subject) && /good news, your order BF-SO-000001/.test(got[0].body.text), got.map(g => [g.provider, g.body.subject]));
R.saveCust = await call('pos-customer', { action: 'save', customerId: 'c1', name: 'Thandi Mokoena', phone: '0825550101', email: 'thandi@example.com', notifyBy: 'whatsapp', consent: {}, ...bell }, mgr.idToken);
check('the preference is saved with the profile', R.saveCust.ok && R.saveCust.customer.notifyBy === 'whatsapp' && (await getDoc('pos/retail/customers/c1')).notifyBy === 'whatsapp', R.saveCust);
R.saveCust2 = await call('pos-customer', { action: 'save', customerId: 'c1', name: 'Thandi Mokoena', phone: '0825550101', email: 'thandi@example.com', consent: {}, ...bell }, mgr.idToken);
check('a save that does not mention it keeps it', R.saveCust2.ok && R.saveCust2.customer.notifyBy === 'whatsapp', R.saveCust2.customer && R.saveCust2.customer.notifyBy);

// ---- nobody can be reached: it stays for a person, with the reason; "send now" says why; the manual WhatsApp clears it
R.open2 = await call('pos-special', openBody('c2')); const O2 = R.open2.order || {};
R.open3 = await call('pos-special', openBody('c3')); const O3 = R.open3.order || {};
await clearSink(); R.sw5 = await sweep(); got = await sink();
const o2 = await getDoc('pos/retail/specialOrders/' + O2.id), o3 = await getDoc('pos/retail/specialOrders/' + O3.id);
check('the provider refused and there is no email: still due, the reason kept, one try', got.length === 0 && o2.updateDue === true && /Not sent yet: SMS: 500/.test(o2.notifyError) && /email: no address/.test(o2.notifyError) && o2.notifyTries === 1, [got.length, o2.notifyError, o2.notifyTries]);
check('the customer who wants none: still due, said so', o3.updateDue === true && /asked for no automatic messages/.test(o3.notifyError), o3.notifyError);
check('the schedule reports what is left', R.sw5.done.some(x => /retail\/BF: 0 sent, 2 left/.test(x)), R.sw5.done);
R.now = await call('pos-notify', { action: 'send', entityId: 'BF', coll: 'specialOrders', id: O2.id }, mgr.idToken); check('"send now" says why it cannot', R.now.status === 502 && /SMS: 500/.test(R.now.error), R.now);
R.nowCas = await call('pos-notify', { action: 'send', entityId: 'BF', coll: 'specialOrders', id: O2.id }); check('not a cashier', R.nowCas.status === 403, R.nowCas);
R.board = await call('pos-notify', { action: 'status', entityId: 'BF' }, mgr.idToken); check('the status lists both as failed', R.board.ok && R.board.due === 2 && R.board.failed === 2 && R.board.rows.some(r => r.docNo === O2.docNo && /SMS: 500/.test(r.error)), R.board);
for (let i = 0; i < 4; i++) await sweep();
check('after five tries it gives up, on record', /Not sent automatically/.test((await getDoc('pos/retail/specialOrders/' + O2.id)).notifyError) && (await getDoc('pos/retail/specialOrders/' + O2.id)).notifyTries === 5);
R.manual = await call('pos-special', { action: 'update', orderId: O2.id, how: 'whatsapp', ...bell });
check('the WhatsApp button clears it', R.manual.ok && (await getDoc('pos/retail/specialOrders/' + O2.id)).updateDue === false && (await getDoc('pos/retail/specialOrders/' + O2.id)).notifyError === '', R.manual);
// fixed: an email on the profile, and "send now" goes
await patchAt('pos/retail/customers/c3', { notifyBy: '' });
await clearSink(); R.now3 = await call('pos-notify', { action: 'send', entityId: 'BF', coll: 'specialOrders', id: O3.id }, mgr.idToken); got = await sink();
check('"send now" once the customer allows it: SMS', R.now3.ok && R.now3.sent && R.now3.how === 'sms' && got.length === 1 && got[0].body.to === '+27845550103' && (await getDoc('pos/retail/specialOrders/' + O3.id)).updateDue === false, [R.now3, got.length]);

// ---- off: nothing goes; the keys removed
R.off = await call('pos-notify', { action: 'setup', entityId: 'BF', auto: false, channels: ['sms', 'email'], from: 'Bellville Furniture <orders@bellville.test>' }, own.idToken); check('off', R.off.ok && R.off.notify.auto === false, R.off);
R.open4 = await call('pos-special', openBody('c1'));
await clearSink(); R.sw6 = await sweep();
check('off: the schedule leaves it for a person', R.sw6.ok && !R.sw6.done.length && (await sink()).length === 0 && (await getDoc('pos/retail/specialOrders/' + R.open4.order.id)).updateDue === true, R.sw6);
R.forget = await call('pos-notify', { action: 'forget', entityId: 'BF' }, own.idToken);
check('the keys are gone', R.forget.ok && (await getDoc('pos/retail/notifySecrets/BF')) === null && R.forget.notify.ready.sms === false, R.forget);
const auditAll = await listColl('auditLog'); check('audited', ['notify.setup', 'notify.test', 'notify.forget'].every(a => auditAll.some(x => x.action === a)), auditAll.map(a => a.action));

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 8000));
console.log(fails.length ? fails.length + ' FAILED' : 'notify-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
