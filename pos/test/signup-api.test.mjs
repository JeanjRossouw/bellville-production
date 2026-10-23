// Factory Manager POS: a business signs up and pays. A new login starts a
// business (its own space, a 14-day trial, the person as owner); a login that
// already belongs to a business cannot start another; the subscription's
// standing (trial, days left, the price); checkout needs PayFast and the
// owner; once the trial runs out unpaid the business reads but cannot write,
// signing in still works and the schedules skip it; paid up it writes again.
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
const own = await mk('owner@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
const fresh = await mk('ayanda@newshop.co.za');

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };

// ---- sign up
R.noName = await call('pos-signup', { action: 'start', businessName: '', name: 'Ayanda' }, fresh.idToken);
check('a business needs a name', R.noName.status === 400, R.noName);
R.anon = await call('pos-signup', { action: 'start', businessName: 'New Shop' });
check('signing up needs a login', R.anon.status === 401, R.anon);
R.up = await call('pos-signup', { action: 'start', businessName: 'New Shop', name: 'Ayanda Dube' }, fresh.idToken);
const G = R.up.groupId;
check('signed up: a business of its own on a 14-day trial', R.up.ok && /^g[A-Za-z0-9]+$/.test(G || '') && R.up.user.role === 'owner' && Math.round((Date.parse(R.up.trialEndsAt) - Date.now()) / 86400000) === 14, R.up);
R.grp = await getDoc('posGroups/' + G);
R.rawGrp = await (await fetch(`${docs}/posGroups/${G}`, { headers: H })).json();
check('the business record: trial, owner, name, the trial\'s end stored as a date (the rules compare it)', R.grp && R.grp.status === 'trial' && R.grp.ownerUid === fresh.localId && R.grp.name === 'New Shop' && !!(R.rawGrp.fields.trialEndsAt || {}).timestampValue, [R.grp, R.rawGrp.fields && R.rawGrp.fields.trialEndsAt]);
check('the owner is recorded in the business and nowhere else', (await getDoc('posMembers/' + fresh.localId)).groupId === G && (await getDoc(`pos/${G}/users/` + fresh.localId)).role === 'owner' && !(await getDoc('pos/retail/users/' + fresh.localId)));
R.again = await call('pos-signup', { action: 'start', businessName: 'Second Shop' }, fresh.idToken);
check('the same login cannot start a second business', R.again.status === 409, R.again);
R.first = await call('pos-signup', { action: 'start', businessName: 'Sneaky' }, own.idToken);
check('a first-shops login cannot start one either', R.first.status === 409, R.first);
R.me = await call('pos-auth', { action: 'me' }, fresh.idToken);
check('signing in lands in the new business', R.me.groupId === G && R.me.user && R.me.user.name === 'Ayanda Dube', R.me);

// ---- the standing and the price
R.st = await call('pos-billing', { action: 'status' }, fresh.idToken);
check('the standing: a trial with 14 days left, R999 a month', R.st.ok && R.st.status === 'trial' && R.st.access === 'ok' && R.st.daysLeft === 14 && R.st.plan.amount === 999 && R.st.owner === true, R.st);
R.plan = await (await fetch(FN + 'pos-billing?plan=1')).json();
check('the price is public', R.plan.plan && R.plan.plan.amount === 999 && R.plan.plan.trialDays === 14, R.plan);
R.co = await call('pos-billing', { action: 'checkout' }, fresh.idToken);
check('checkout needs PayFast switched on (not in the tests)', R.co.status === 503 && /PayFast/.test(R.co.error), R.co);
R.st1 = await call('pos-billing', { action: 'status' }, own.idToken);
check('the first shops are free and have nothing to pay', R.st1.ok && R.st1.status === 'free' && R.st1.access === 'ok', R.st1);
R.co1 = await call('pos-billing', { action: 'checkout' }, own.idToken);
check('and no subscription to manage', R.co1.status === 400, R.co1);

// ---- working in the trial
const ent = { entityId: 'NS', storeId: 'NS-1', registerId: '' };
await put(`pos/${G}/entities/NS`, { legalName: 'New Shop (Pty) Ltd', tradingName: 'New Shop', vatRegistered: false, vatNo: '', invoicePrefix: 'NS', active: true, ...srv('NS') });
await put(`pos/${G}/settings/NS`, { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, ...srv('NS') });
await put(`pos/${G}/stores/NS-1`, { entityId: 'NS', name: 'Main', active: true, paymentMethods: ['cash', 'card'], ...srv('NS', 'NS-1') });
R.c1 = await call('pos-customer', { action: 'save', name: 'Lindiwe', phone: '082 555 0199', ...ent }, fresh.idToken);
check('in the trial the business works', R.c1.ok, R.c1);

// ---- the trial runs out unpaid: read only
await put('posGroups/' + G, { ...R.grp, trialEndsAt: new Date(Date.now() - 3600000).toISOString() });
R.c2 = await call('pos-customer', { action: 'save', name: 'Bongani', phone: '082 555 0198', ...ent }, fresh.idToken);
check('the trial over: a write is refused, saying how to pay', R.c2.status === 402 && /read only/.test(R.c2.error) && /Subscribe/.test(R.c2.error), R.c2);
R.me2 = await call('pos-auth', { action: 'me' }, fresh.idToken);
check('signing in still works', R.me2.user && R.me2.groupId === G, R.me2);
R.st2 = await call('pos-billing', { action: 'status' }, fresh.idToken);
check('the standing says read only, the trial over', R.st2.access === 'locked' && R.st2.why === 'trialOver', R.st2);
R.dash = await call('pos-report', { action: 'dashboard' }, fresh.idToken);
check('reading still works', R.dash.status === 200, R.dash);
R.sched = await (await fetch(FN + 'pos-shopify-sync', { method: 'POST' })).json();
check('the schedules skip it without failing', R.sched.ok === true, R.sched);

// ---- paid up: writes again
await put('posGroups/' + G, { ...R.grp, status: 'active', paidUntil: new Date(Date.now() + 30 * 86400000).toISOString() });
R.c3 = await call('pos-customer', { action: 'save', name: 'Bongani', phone: '082 555 0198', ...ent }, fresh.idToken);
check('paid up: it writes again', R.c3.ok, R.c3);
R.st3 = await call('pos-billing', { action: 'status' }, fresh.idToken);
check('the standing says active', R.st3.access === 'ok' && R.st3.status === 'active', R.st3);

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 5000));
console.log(fails.length ? fails.length + ' FAILED' : 'signup-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
