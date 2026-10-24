// Retail POS step 8 in the browser: the Register tab on a till, as a
// cashier with a manager's PIN at hand. Sell is blocked while closed; open
// with a float; a sale; the X-report; cash out with a supervisor's PIN;
// close with a blind count that is R 100 short → note and manager PIN;
// the Z-report; the summary to the owner.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const crash = (e) => { console.log(JSON.stringify({ fails, errs, ...R, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : f.doubleValue;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
const pinRec = (pin) => { const salt = '12'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/users/st_sarah', { email: '', name: 'Sarah', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') }); await put('pos/retail/pinHashes/st_sarah', { ...pinRec('333333'), ...srv('BF') }); await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, cash: { varianceLimitCents: 5000 }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, reports: { phone: '0821112222', email: 'owner@shop.co.za' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
const secret = 'reg-secret-' + Date.now();
await put('pos/retail/devices/dev_r', { label: 'Front till', registerId: 'r1', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_r') });
await put('pos/retail/products/p_c', { name: 'Scatter Cushion', sku: '', barcodes: ['CUSH'], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: false, costCents: 5000, priceCents: 19900, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__opened = []; window.open = (url) => { if (url) { window.__opened.push(url); return null; } const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_r', secret, label: 'Front till', entityId: 'BF', storeId: 'BF-BELL', registerId: 'r1' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept(d.type() === 'prompt' ? (d.defaultValue() || '0821112222') : undefined));
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(700); };
const den = async (scope, d, n) => p.fill(scope + ' [data-den="' + d + '"]', String(n));

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1500);
// closed: Sell says so and Pay stays off
await scan('CUSH');
R.closedBanner = await p.locator('.reg-closed').innerText().catch(() => ''); check('Sell shows the register closed', /register is closed/i.test(R.closedBanner), R.closedBanner);
check('Pay disabled while closed', await p.locator('[data-act=sl-pay]').isDisabled());
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('a till with a register has the Register tab', R.nav.includes('register'), R.nav);

// open with a float: 3 × R100, 5 × R20, 10 × R1 = R 410
await nav('register'); await p.waitForSelector('[data-act=rg-open]');
await den('#screen', 10000, 3); await den('#screen', 2000, 5); await den('#screen', 100, 10); await p.waitForTimeout(150);
R.floatTotal = await p.locator('#op-total').innerText(); check('the float adds up live', R.floatTotal === 'R 410.00', R.floatTotal);
await p.click('[data-act=rg-open]'); await p.waitForSelector('#modal'); await p.click('#modal-ok'); R.opened = await toast(); await p.waitForTimeout(1200);
R.openHead = await screenText(); check('open: X-report and the drawer with the float', /Register open/.test(R.opened) && /Open since .* by Cathy · float R 410\.00/.test(R.openHead) && /Expected cash in the drawer R 410\.00/.test(R.openHead), R.openHead.slice(0, 200));
await p.screenshot({ path: S + '/shots/pos8-register.png' });

// a cash sale with change, then the X-report moves
await nav('sell'); check('Pay enabled once open', !(await p.locator('[data-act=sl-pay]').isDisabled()));
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.fill('#py-tendered', '200'); await p.click('[data-add=cash]'); await p.waitForTimeout(200); await p.click('#modal-ok'); await toast(); await p.waitForTimeout(900);
if (await p.locator('#modal .rc-paper').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); }
await nav('register'); await p.waitForTimeout(600);
R.x1 = await screenText(); check('X-report: one sale, cash R 199, expected R 609', /Sales 1 · R 199\.00/.test(R.x1) && /Expected cash in the drawer R 609\.00/.test(R.x1), R.x1.slice(0, 300));

// cash out by the cashier: needs a supervisor's PIN
await p.click('[data-act=rg-cash][data-kind=out]'); await p.waitForSelector('#modal #cm-amount'); await p.fill('#cm-amount', '100'); await p.fill('#cm-reason', 'Cash drop'); await p.click('#modal-ok'); await p.waitForSelector('#modal .pinpad');
await pinType('#modal', '111111'); R.ownPin = await p.locator('#modal .pin-msg').innerText(); check('the cashier’s own PIN cannot approve the cash out', /cashier|own/.test(R.ownPin), R.ownPin);
await pinType('#modal', '333333'); R.cashOut = await toast(); await p.waitForTimeout(900);
R.x2 = await screenText(); check('cash out recorded by a supervisor; expected cash down to R 509', /Cash out recorded/.test(R.cashOut) && /Expected cash in the drawer R 509\.00/.test(R.x2) && /− R 100\.00 · Cash drop/.test(R.x2), R.x2.slice(0, 300));
await p.click('[data-act=rg-x-print]'); await p.waitForTimeout(200); R.xPrint = await p.evaluate(() => window.__printed.pop() || ''); check('X-report prints', /X-report/.test(R.xPrint) && /R 199\.00/.test(R.xPrint));

// close: the count is R 100 short (R 409) → note, manager's PIN → Z-report
await p.click('[data-act=rg-close]'); await p.waitForSelector('#modal [data-den]');
check('the close is blind: no expected figures in the count', !/509/.test(await p.locator('#modal').innerText()));
await den('#modal', 10000, 3); await den('#modal', 2000, 5); await den('#modal', 500, 1); await den('#modal', 200, 2); await p.fill('#cl-card', '0'); await p.waitForTimeout(150);
R.countTotal = await p.locator('#cl-total').innerText(); check('counted R 409.00', R.countTotal === 'R 409.00', R.countTotal);
await p.click('#modal-ok'); await p.waitForSelector('#vr-note');
R.varianceAsk = await p.locator('#modal').innerText(); check('over the limit: asks what happened', /out by -10000 cents, more than the limit of 5000/.test(R.varianceAsk), R.varianceAsk.slice(0, 200));
await p.fill('#vr-note', 'Gave R 100 too much change'); await p.click('#modal-ok'); await p.waitForSelector('#modal .pinpad');
await pinType('#modal', '333333'); R.supNo = await p.locator('#modal .pin-msg').innerText(); check('a supervisor cannot approve the variance', /supervisor/.test(R.supNo), R.supNo);
await pinType('#modal', '222222'); await p.waitForSelector('#modal .z-tbl', { timeout: 15000 });
R.z = await p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' '));
check('Z-report: cash expected R 509, counted R 409, variance −R 100 flagged; card 0/0; the note', /Cash.*R 509\.00 R 409\.00 −R 100\.00/.test(R.z) && /Card R 0\.00 R 0\.00 R 0\.00/.test(R.z) && /Gave R 100 too much change/.test(R.z) && /opened by Cathy, closed by Cathy/.test(R.z), R.z.slice(0, 400));
await p.click('#modal [data-z=wa]'); await p.waitForTimeout(300); R.wa = decodeURIComponent(await p.evaluate(() => window.__opened.pop() || ''));
check('the summary goes to the owner’s WhatsApp', /wa\.me\/27821112222/.test(R.wa) && /Z-report Till 1/.test(R.wa) && /Cash: expected R 509\.00, counted R 409\.00, variance −R 100\.00/.test(R.wa), R.wa.slice(0, 300));
await p.click('#modal-ok'); await p.waitForTimeout(800);
R.afterClose = await screenText(); check('closed again: the open form and the last close', /Open the register/i.test(R.afterClose) && /Last close/i.test(R.afterClose), R.afterClose.slice(0, 200));
const shifts = await listColl('shifts'); const sh = shifts[0];
check('the shift in the database: closed, variance, approver Mandla, Z-report', shifts.length === 1 && sh.status === 'closed' && sh.varianceCents === -10000 && sh.varianceApprovedBy && sh.varianceApprovedBy.name === 'Mandla' && sh.zReport.salesCount === 1 && sh.countedCash.totalCents === 40900, sh && { v: sh.varianceCents, a: sh.varianceApprovedBy });
const cm = await listColl('cashMovements'); check('the cash out, approved by Sarah', cm.length === 1 && cm[0].kind === 'out' && cm[0].approvedBy.name === 'Sarah' && cm[0].actorUid === 'st_cathy', cm);
await nav('sell'); check('Sell blocked again after the close', await p.locator('[data-act=sl-pay]').isDisabled() || /register is closed/i.test(await screenText()));

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 5000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
