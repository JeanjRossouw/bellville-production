// Retail POS step 13 in the browser: the Stock tab as a manager on a till —
// levels with on hand, reserved and available, the low-stock list from the
// reorder levels, an adjustment with a reason, an item's movements, and a
// stock take counted by scanning (keyboard wedge) and typed counts, then
// reviewed and posted. A cashier has no Stock tab.
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
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'st-secret-' + Date.now();
await put('pos/retail/devices/dev_st', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_st') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', sku: 'CU-1', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000, reorderLevel: 9, reorderQty: 10 });
await prod('p_lamp', { name: 'Lamp', sku: 'LA-1', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 2, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 3, reservedQty: 0, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.open = () => { const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_st', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const modalText = () => p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };
const rowText = (name) => p.locator('.st-tbl tr', { hasText: name }).first().innerText().then(t => t.replace(/\s+/g, ' ').trim());

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1000);
R.navCas = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('a cashier has no Stock tab', !R.navCas.includes('stock'), R.navCas);
await p.click('#lock'); await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '222222'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('a manager has the Stock tab', R.nav.includes('stock'), R.nav);

// ---- levels, the low list, an adjustment, the card
await nav('stock'); await p.waitForSelector('.st-tbl');
R.cushion = await rowText('Scatter Cushion'); check('cushion: 10 on hand, 2 reserved, 8 available, reorder at 9, value R 500', /Scatter Cushion.*CU-1 10 2 8\s+9 \(\+10\) R 500\.00/.test(R.cushion), R.cushion);
R.sum = await screenText(); check('the summary: 2 items, 13 on hand, R 1,100 at cost, 1 low', /2 items · 13 on hand · R 1,100\.00 at cost · 1 low/.test(R.sum), R.sum.slice(0, 300));
await p.click('[data-act=st-sub][data-to=low]'); await p.waitForTimeout(300);
R.low = await screenText(); check('the low-stock list shows the cushion only', /1 item at or under their reorder level/.test(R.low) && /Scatter Cushion/.test(R.low) && !/Lamp/.test(R.low), R.low.slice(0, 300));
await p.click('[data-act=st-sub][data-to=levels]'); await p.waitForTimeout(300);
await p.click('[data-act=st-adjust]'); await p.waitForSelector('#modal #ad-item');
await p.selectOption('#ad-item', 'p_cushion'); await p.fill('#ad-qty', '-1'); await p.selectOption('#ad-code', 'damaged'); await p.fill('#ad-note', 'torn'); await p.click('#modal-ok'); R.adj = await toast(); await p.waitForTimeout(1200);
check('adjusted by the manager without a PIN', /Scatter Cushion: -1 · now 9 on hand/.test(R.adj), R.adj);
R.cushion2 = await rowText('Scatter Cushion'); check('the row follows the level', /CU-1 9 2 7/.test(R.cushion2), R.cushion2);
await p.click('.st-tbl tr:has-text("Scatter Cushion") [data-act=st-card]'); await p.waitForSelector('#modal table'); await p.waitForTimeout(400);
R.card = await modalText(); check('the card: the adjustment in the movements, with the reason and the approver', /On hand 9 · reserved 2 · available 7/.test(R.card) && /Adjustment · damaged/.test(R.card) && /torn/.test(R.card) && /Mandla/.test(R.card), R.card.slice(0, 400));
await closeModal();

// ---- a stock take: freeze, count by scanning and a typed count, review, post
await p.click('[data-act=st-sub][data-to=takes]'); await p.waitForSelector('#tk-name');
await p.fill('#tk-name', 'October count'); await p.click('[data-act=st-take-open]'); R.frozen = await toast(); await p.waitForSelector('#tk-scan');
check('frozen with 2 items', /Frozen: 2 items to count/.test(R.frozen), R.frozen);
R.blind = await screenText(); check('a blind count: no system figures shown', /counting/i.test(R.blind) && /0 of 2 counted/.test(R.blind) && !/System/.test(R.blind), R.blind.slice(0, 300));
await p.fill('#tk-scan', 'CUSH'); await p.press('#tk-scan', 'Enter'); await p.waitForTimeout(700);
await p.fill('#tk-scan', 'CUSH'); await p.press('#tk-scan', 'Enter'); await p.waitForTimeout(700);
R.last = await p.locator('#tk-last').innerText(); check('two scans: cushion 2', /Scatter Cushion: 2/.test(R.last), R.last);
await p.fill('#tk-scan', 'NOPE'); await p.press('#tk-scan', 'Enter'); R.unknown = await toast(); check('an unknown code says so', /Unknown code NOPE/.test(R.unknown), R.unknown);
await p.click('.tk-tbl tr:has-text("Lamp") [data-act=st-set]'); await p.waitForSelector('#modal #tk-qty'); await p.fill('#tk-qty', '3'); await p.click('#modal-ok'); await p.waitForTimeout(700);
R.counted = await screenText(); check('2 of 2 counted', /2 of 2 counted/.test(R.counted), R.counted.slice(0, 200));
await p.click('[data-act=st-take-review]'); R.rev = await toast(); await p.waitForSelector('#tk-review');
R.review = await screenText(); check('the review: the cushion −7 at −R 350, the lamp matched', /1 variance · -7 units · [−-]R 350\.00 at cost/.test(R.review) && /Scatter Cushion CU-1 9 2 -7 [−-]R 350\.00 Mandla/.test(R.review) && !/Lamp/.test(R.review), R.review.slice(0, 500));
await p.click('[data-act=st-varonly]'); await p.waitForTimeout(200); R.all = await screenText(); check('all items shows the lamp too', /Lamp LA-1 3 3/.test(R.all), R.all.slice(0, 500));
await p.click('[data-act=st-take-post]'); R.posted = await toast(); await p.waitForTimeout(1500);
check('posted by the manager: 1 movement', /Posted: 1 movement/.test(R.posted), R.posted);
R.after = await screenText(); check('the take shows posted', /posted .* by Mandla, 1 movement/.test(R.after), R.after.slice(0, 300));
check('the level: 2 on hand', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 2);
await p.click('[data-act=st-sub][data-to=levels]'); await p.waitForTimeout(400);
R.cushion3 = await rowText('Scatter Cushion'); check('the levels table: cushion 2 on hand, 0 available', /CU-1 2 2 0/.test(R.cushion3), R.cushion3);
const takes = await listColl('stockTakes'); check('written: posted, the log of every scan', takes.length === 1 && takes[0].status === 'posted' && takes[0].log.length === 3 && takes[0].movementCount === 1, takes[0] && [takes[0].status, takes[0].log.length]);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
