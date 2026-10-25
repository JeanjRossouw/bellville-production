// Retail POS step 2: sign-in, PINs, enrolment, override, idle, offline. Against the emulators + posserver.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
// Usage: node pos/test/auth.test.mjs   (emulators running; see README.md)
//   FIREBASE_SDK_DIR  a local copy of the firebase npm package's browser builds, when www.gstatic.com is unreachable
//   CHROME            the Chromium to launch (default: Playwright's)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const R = {}, fails = [];
const errs = [];
const crash = (e) => { console.log(JSON.stringify({ ...R, fails, errs, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const mark = (m) => console.error('>> ' + m + ' ' + new Date().toISOString().slice(11,19));
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };

// ---- emulator helpers
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : f.doubleValue;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (path, data) => fetch(`${docs}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
mark('clear firestore'); await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' }); mark('cleared');
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' }); mark('auth cleared');
await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.co.za', password: 'secret123' }) });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, ...srv('BF', 'BF-PAROW') });
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
await put('pos/retail/settings/BF', { session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });

mark('seeded');
// ---- the server
let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}

mark('server ok');
// ---- the browser
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const p = await ctx.newPage();
// 'Failed to load resource' is the browser's own line for a refused request (a wrong PIN, the lock-out): expected here
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const nav = async (v) => { if (['staff', 'devices'].includes(v)) { await p.evaluate(() => document.querySelector('#nav [data-view=admin]').click()); await p.waitForTimeout(300); await p.click('[data-sub=' + v + ']'); } else await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(500); };
const who = () => p.locator('#who').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const pinType = async (scope, pin) => { for (const d of pin) await p.locator(scope + ' [data-key="' + d + '"]').click(); await p.waitForTimeout(900); };

mark('browser up');
// 1. first sign-in claims the group
await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login:not([hidden])', { timeout: 20000 });
check('no device: the email form, no switch', await p.locator('#login-form').isVisible() && !(await p.locator('#login-switch').isVisible()));
await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'wrong'); await p.click('#login-submit'); await p.waitForTimeout(1200);
R.badPass = await p.locator('#login-msg').innerText(); check('wrong password says so', /do not match/.test(R.badPass), R.badPass);
await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#claim:not([hidden])', { timeout: 15000 });
await p.fill('#claim-name', 'Jean'); await p.fill('#claim-group', 'Rossouw Retail'); await p.click('#claim-form button[type=submit]');
await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(800);
R.ownerWho = await who(); check('owner signed in', /Jean.*Owner/i.test(R.ownerWho), R.ownerWho);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('owner menu: every tab, Reports and Admin included', R.nav.join() === 'sell,home,sales,returns,laybys,orders,customers,stock,buying,products,fabrics,online,overview,reports,admin,me', R.nav);
const group = await (await fetch(`${docs}/pos/retail`, { headers: H })).json(); check('group doc written', fromFs(group.fields.name) === 'Rossouw Retail');

mark('claimed');
// 2. staff
await nav('staff'); await p.waitForTimeout(600);
await p.screenshot({ path: S + '/shots/pos2-staff.png' });
const addStaff = async (name, role, email, pin, ents, sts) => {
  await p.fill('#st-name', name); await p.selectOption('#st-role', role); await p.fill('#st-email', email); await p.fill('#st-pin', pin);
  for (const e of ents) await p.check(`[data-ent="${e}"]`); for (const s of sts) await p.check(`[data-store="${s}"]`);
  await p.click('[data-act=staff-add]'); return toast();
};
R.addMgr = await addStaff('Mandla', 'manager', 'mgr@shop.co.za', '222222', ['BF'], ['BF-BELL', 'BF-PAROW']);
check('manager added by email', /emailed a link|added/.test(R.addMgr), R.addMgr);
await p.waitForTimeout(600); await nav('staff');
R.addCash = await addStaff('Cathy', 'cashier', '', '111111', ['BF'], ['BF-BELL']); check('cashier added with a PIN', /added with a PIN/.test(R.addCash), R.addCash);
await p.waitForTimeout(600); await nav('staff');
R.addSup = await addStaff('Sarah', 'supervisor', '', '333333', ['BF'], ['BF-BELL']); check('supervisor added', /added/.test(R.addSup), R.addSup);
await p.waitForTimeout(600); await nav('staff');
R.dupPin = await addStaff('Dup', 'cashier', '', '111111', ['BF'], ['BF-BELL']);
await p.waitForTimeout(600); await nav('staff');
R.noName = await addStaff('', 'cashier', '', '', [], []); check('a name is needed', /name/i.test(R.noName), R.noName);
await p.waitForTimeout(800); await nav('staff');
R.rows = await p.$$eval('#screen .tbl tbody tr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
check('four people listed', R.rows.length === 5, R.rows);   // owner + 3 + Dup
check('cashier shows PIN only · PIN set', R.rows.some(r => /Cathy.*PIN only · PIN set/.test(r)), R.rows);
const usersNow = await listColl('users');
const uid = (n) => (usersNow.find(u => u.name === n) || {}).id;
check('manager has a login (auth uid, not st_)', uid('Mandla') && !uid('Mandla').startsWith('st_'), uid('Mandla'));
check('cashier is PIN-only (st_ uid)', String(uid('Cathy')).startsWith('st_'), uid('Cathy'));
const hashes = await listColl('pinHashes'); check('hashes stored, never the PIN', hashes.every(h => h.hash && h.salt && !JSON.stringify(h).includes('111111')));
// deactivate Dup
await p.locator('tr', { hasText: 'Dup' }).locator('[data-act=staff-off]').click(); R.offToast = await toast(); check('deactivated', /Deactivated/.test(R.offToast), R.offToast);

mark('staff done');
// 3. enrol this device
await nav('devices');
await p.selectOption('#dv-store', 'BF-BELL'); await p.waitForTimeout(200); await p.selectOption('#dv-register', 'r1'); await p.fill('#dv-label', 'Front till');
await p.click('[data-act=device-enrol]'); R.enrol = await toast(); check('enrolled', /Enrolled/.test(R.enrol), R.enrol);
await p.waitForTimeout(600);
R.devCard = await p.locator('#screen .card').first().innerText(); check('this device card shows the till', /Front till.*Bellville.*Till 1/s.test(R.devCard), R.devCard);
R.stored = await p.evaluate(() => JSON.parse(localStorage.getItem('pos-device') || 'null'));
check('device id and secret kept on the device', R.stored && R.stored.deviceId && R.stored.secret && R.stored.storeId === 'BF-BELL');
R.cache = await p.evaluate(() => JSON.parse(localStorage.getItem('pos-pincache') || 'null'));
check('PIN cache holds the store’s staff with hashes', R.cache && R.cache.staff.length === 3 && R.cache.staff.every(s => s.hash && s.salt), R.cache && R.cache.staff.map(s => s.name));

mark('enrolled');
// 4. sign out → PIN pad
await p.click('#sign-out'); await p.waitForSelector('#login:not([hidden])'); await p.waitForTimeout(400);
check('with a device: the PIN pad and the switch', await p.locator('#login-pin').isVisible() && await p.locator('#login-switch').isVisible());
await p.screenshot({ path: S + '/shots/pos2-pinpad.png' });
await pinType('#login-pin', '999999'); R.wrongPin = await p.locator('#login-pin .pin-msg').innerText(); check('wrong PIN refused', /not known/.test(R.wrongPin), R.wrongPin);
await pinType('#login-pin', '111111'); await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(800);
R.cashWho = await who(); check('cashier signed in by PIN', /Cathy.*Cashier/i.test(R.cashWho), R.cashWho);
R.cashNav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('cashier menu on a till with a register: the selling tabs and Register, no Stock, Reports or Admin', R.cashNav.join() === 'sell,register,home,sales,returns,laybys,orders,customers,products,me', R.cashNav);
R.fbUser = await p.evaluate(() => window.POS.session.uid); check('signed in as her own uid', R.fbUser === uid('Cathy'), R.fbUser);
check('lock button shows for a PIN user', await p.locator('#lock').isVisible());

mark('pin login done');
// 5. override: cashier's own PIN no, supervisor no, manager yes
// start the override without holding the page; read its answer afterwards
const over = (o) => p.evaluate((o) => { window.__ov = window.POS.requireOverride(o).then(r => ({ ok: true, ...r })).catch(e => ({ ok: false, error: e.message })); }, o);
const overResult = async () => { for (let i = 0; i < 40; i++) { const r = await p.evaluate(() => Promise.race([window.__ov, new Promise(res => setTimeout(() => res(null), 200))])); if (r) return r; } return { ok: false, error: 'no answer' }; };
await over({ minRole: 'manager', action: 'discount', docType: 'sale', docId: 'tmp1', details: { pct: 20 } });
await p.waitForSelector('#modal .pinpad'); await p.screenshot({ path: S + '/shots/pos2-override.png' });
await pinType('#modal', '111111'); R.ovSelf = await p.locator('#modal .pin-msg').innerText(); check('own PIN cannot approve', /cashier|own/.test(R.ovSelf), R.ovSelf);
await pinType('#modal', '333333'); R.ovSup = await p.locator('#modal .pin-msg').innerText(); check('a supervisor cannot approve a manager override', /supervisor/.test(R.ovSup), R.ovSup);
await pinType('#modal', '222222'); R.ov = await overResult();
check('manager approves: name and token', R.ov.ok && R.ov.name === 'Mandla' && R.ov.role === 'manager' && R.ov.token && R.ov.token.includes('.'), R.ov);
const audit = await listColl('auditLog');
const ovRow = audit.find(a => a.action === 'override.discount');
check('audit row names both people', ovRow && ovRow.actorUid === uid('Cathy') && ovRow.overrideUid === uid('Mandla') && ovRow.details.pct === 20 && ovRow.docId === 'tmp1', ovRow);
check('audit has the refused tries too', audit.filter(a => a.action === 'override.discount.refused').length === 2, audit.map(a => a.action));
check('audit has pin logins and the failed one', audit.some(a => a.action === 'login.pin' && a.actorUid === uid('Cathy')) && audit.some(a => a.action === 'login.pin.failed'));
// cancelling
await over({ minRole: 'manager', action: 'void' });
await p.waitForSelector('#modal .pinpad'); await p.click('#modal [data-close]'); R.ovCancel = await overResult(); check('cancel rejects', !R.ovCancel.ok && /Not approved/.test(R.ovCancel.error), R.ovCancel);
// supervisor-level override accepts a supervisor
await over({ minRole: 'supervisor', action: 'linevoid' });
await p.waitForSelector('#modal .pinpad'); await pinType('#modal', '333333'); R.ovSup2 = await overResult(); check('supervisor approves a supervisor-level override', R.ovSup2.ok && R.ovSup2.name === 'Sarah', R.ovSup2);

mark('override done');
// 6. idle: a PIN user is locked to the pad
await p.evaluate(() => window.POS.forceIdle());
await p.waitForSelector('#login:not([hidden])'); R.idleToast = await toast(); check('idle locks a PIN user', /Locked after/.test(R.idleToast), R.idleToast);

mark('idle done'); R.modalLeft = await p.evaluate(() => { const m = document.getElementById('modal'); return m ? m.querySelector('.modal-head h2').innerText + ' | ' + m.querySelector('.modal-body').innerText.slice(0, 120) : ''; });
// 7. five wrong PINs lock
for (let i = 0; i < 5; i++) await pinType('#login-pin', '777777');
await pinType('#login-pin', '111111'); R.locked = await p.locator('#login-pin .pin-msg').innerText(); check('locked after five wrong PINs', /locked/i.test(R.locked), R.locked);
// unlock for the rest of the test
for (const h of hashes) await put('pos/retail/pinHashes/' + h.id + '?updateMask.fieldPaths=lockedUntil&updateMask.fieldPaths=failedCount', { lockedUntil: '', failedCount: 0 });

mark('lockout done');
// 8. offline PIN sign-in from the cache
await ctx.setOffline(true);
await pinType('#login-pin', '111111');
R.offTrace = [];
for (let i = 0; i < 12; i++) { R.offTrace.push(await p.evaluate(() => (window.POS.session.mode || '-') + ':' + (window.POS.session.user ? window.POS.session.user.name : '') + ':' + (document.getElementById('app').hidden ? 'login' : 'app') + ':' + document.getElementById('who').innerText.replace(/\s+/g, ' '))); await p.waitForTimeout(250); }
R.offWho = await who(); check('offline PIN sign-in from the cache', /Cathy.*offline/i.test(R.offWho), R.offWho);
await p.screenshot({ path: S + '/shots/pos2-offline.png' });
await ctx.setOffline(false);
await p.click('#lock'); await p.waitForSelector('#login:not([hidden])');
await ctx.setOffline(true); await pinType('#login-pin', '555555'); R.offBad = await p.locator('#login-pin .pin-msg').innerText(); check('offline: a PIN not in the cache is refused', /offline list/.test(R.offBad), R.offBad); await ctx.setOffline(false);

mark('offline done');
// 9. manager by email on the till; idle signs an email user out
const mgrAuth = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/projects/${PID}/accounts:lookup`, { method: 'POST', headers: H, body: JSON.stringify({ email: ['mgr@shop.co.za'] }) })).json();
await fetch(`${AU}/identitytoolkit.googleapis.com/v1/projects/${PID}/accounts:update`, { method: 'POST', headers: H, body: JSON.stringify({ localId: mgrAuth.users[0].localId, password: 'mgrpass1' }) });
await p.click('#login-switch [data-mode=email]'); await p.fill('#login-email', 'mgr@shop.co.za'); await p.fill('#login-pass', 'mgrpass1'); await p.click('#login-submit');
await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(800);
R.mgrWho = await who(); check('manager signed in by email', /Mandla.*Manager/i.test(R.mgrWho), R.mgrWho);
R.mgrNav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('manager menu has admin', R.mgrNav.includes('admin'), R.mgrNav);
await nav('staff'); R.mgrRoles = await p.$$eval('#st-role option', o => o.map(x => x.value)); check('a manager may only add cashiers and supervisors', R.mgrRoles.join() === 'cashier,supervisor', R.mgrRoles);
await p.evaluate(() => window.POS.forceIdle()); await p.waitForSelector('#login:not([hidden])'); R.idleOut = await toast(); check('idle signs an email user out', /Signed out after/.test(R.idleOut), R.idleOut);
check('Firebase session gone after sign-out', (await p.evaluate(() => window.POS.session.uid)) === '');

mark('manager done');
// 10. a second owner sign-in is not a claim
await p.click('#login-switch [data-mode=email]'); await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); check('owner returns straight to the app', true);

console.log(JSON.stringify({ ...R, fails, errs }, null, 1));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);

