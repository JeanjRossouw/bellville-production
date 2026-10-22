// Retail POS in the browser: the assistant. The "?" button on the till, a
// starter question answered (by the tests' mock Anthropic), a typed
// question, the chat kept on the tab and cleared at sign-out.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAnthropic } from './mock-anthropic.mjs';
const mock = await startMockAnthropic(8798);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const crash = (e) => { console.log(JSON.stringify({ fails, errs, ...R, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
const pinRec = (pin) => { const salt = '56'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') }); await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, specialOrder: { minDepositPct: 50, leadDays: 21 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'so-secret-' + Date.now();
await put('pos/retail/devices/dev_so', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_so') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, barcodes: ['SOFA'], priceCents: 1500000, costCents: 600000 });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000 });
await put('pos/retail/customers/c_thandi', { name: 'Thandi Mokoena', contact: 'Thandi', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__opened = []; window.open = (u) => { if (u) { window.__opened.push(u); return { focus() {}, close() {} }; } const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_so', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const nav = async (v) => { await p.click('#nav [data-view=' + v + ']'); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const modalText = () => p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const paper = () => p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };
const pickThandi = async () => { await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', '0825'); await p.waitForTimeout(250); await p.click('#cu-list .pk-row'); await p.waitForTimeout(300); };
const sign = async (sel) => { const box = await p.locator(sel).boundingBox(); await p.mouse.move(box.x + 20, box.y + 60); await p.mouse.down(); await p.mouse.move(box.x + 120, box.y + 40, { steps: 8 }); await p.mouse.move(box.x + 200, box.y + 90, { steps: 8 }); await p.mouse.up(); };
// a 2×2 PNG for the spec photo
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DwHwyZGBgYGBgYAEwWAwXLpQwTAAAAAElFTkSuQmCC', 'base64');

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Custom orders tab present', R.nav.includes('orders'), R.nav);


check('the assistant button is on the till', (await p.locator('#as-fab').count()) === 1);
await p.click('#as-fab'); await p.waitForSelector('#as-panel:not([hidden])');
R.hello = await p.locator('#as-log').innerText(); check('the welcome and the starter questions', /Ask me how to do anything on the till/.test(R.hello) && /What should I reorder\?/.test(R.hello), R.hello);
await p.click('#as-log [data-ask="What should I reorder?"]'); await p.waitForTimeout(1500);
R.log1 = await p.locator('#as-log').innerText(); check('the starter asked and answered', /What should I reorder\?/.test(R.log1) && /Mock answer to: What should I reorder\?/.test(R.log1), R.log1);
const L = mock.last(); check('the till sent the tab and the store', /Tab open now: sell/.test(L.body.messages[0].content) && /Store: Bellville/.test(L.body.system[1].text), L.body.messages[0].content);
await p.fill('#as-q', 'How do I park a sale?'); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
R.log2 = await p.locator('#as-log').innerText(); check('a typed question answered', /Mock answer to: How do I park a sale\?/.test(R.log2), R.log2);
await p.click('#as-close'); check('closed', await p.locator('#as-panel').isHidden());
await p.click('#as-fab'); await p.waitForTimeout(200); R.log3 = await p.locator('#as-log').innerText(); check('the chat is kept', /How do I park a sale\?/.test(R.log3), R.log3);
await p.click('#sign-out'); await p.waitForTimeout(800);
check('gone at sign-out, and the chat with it', (await p.locator('#as-fab').count()) === 0 && (await p.evaluate(() => sessionStorage.getItem('pos-assist-chat'))) === null);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await mock.close();
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
