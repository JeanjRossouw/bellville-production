// Retail POS step 9: the till with the line down. Blocks fetched online;
// two sales rung up offline take the next numbers, print, and wait in the
// outbox with the banner counting them; the cached stock drops; back
// online they sync in order and the numbers match; a queued sale whose
// price changed meanwhile is refused, kept for a manager, and its number
// voided; the next block is issued early when few numbers remain.
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
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
const pinRec = (pin) => { const salt = '34'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, numbering: { blockSize: 10, refillBelow: 5 }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'off-secret-' + Date.now();
await put('pos/retail/devices/dev_off', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_off') });
await put('pos/retail/products/p_c', { name: 'Scatter Cushion', sku: '', barcodes: ['CUSH'], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 5000, priceCents: 19900, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...srv('BF') });
await put('pos/retail/products/p_b', { name: 'Care Book', sku: '', barcodes: ['BOOK'], category: 'Shop', brand: '', type: 'stock', vatClass: 'zero', trackStock: false, costCents: 5000, priceCents: 12000, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...srv('BF') });
await put('pos/retail/stockLevels/BF-BELL_p_c', { productId: 'p_c', variantId: '', onHandQty: 3, reservedQty: 0, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); }, { deviceId: 'dev_off', secret, label: 'Front till', entityId: 'BF', storeId: 'BF-BELL', registerId: '' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource|INTERNET_DISCONNECTED/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const payCash = async () => { await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-add=cash]'); await p.waitForTimeout(200); await p.click('#modal-ok'); const t = await toast(); await p.waitForTimeout(900); return t; };
const receiptText = () => p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const closeReceipt = async () => { if (await p.locator('#modal .rc-paper').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };
const banner = () => p.locator('#offline-bar').innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const idb = (store) => p.evaluate((store) => new Promise((res) => { const r = indexedDB.open('pos-outbox'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains(store)) return res([]); const t = db.transaction(store, 'readonly').objectStore(store).getAll(); t.onsuccess = () => res(t.result); }; }), store);
const tileStock = () => p.locator('.pos-tile', { hasText: 'Scatter Cushion' }).locator('.pos-tile-stock').innerText();

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(2000);
// blocks fetched at sign-in: size 10
R.blocks0 = await idb('blocks'); check('the till holds a block of 10 after signing in', R.blocks0.length === 1 && R.blocks0[0].blocks.length === 1 && R.blocks0[0].blocks[0].from === 1 && R.blocks0[0].blocks[0].to === 10 && R.blocks0[0].prefix === 'BF', R.blocks0);
check('banner hidden while online with nothing waiting', await p.locator('#offline-bar').isHidden());
check('cushion shows 3 in stock', (await tileStock()) === '3 in stock');

// ---- the line goes down: two sales
await ctx.setOffline(true); await p.waitForTimeout(800);
R.bannerOff = await banner(); check('offline banner', /Offline/.test(R.bannerOff) && /10 numbers left/.test(R.bannerOff), R.bannerOff);
await scan('CUSH'); R.t1 = await payCash();
check('offline sale takes BF-000001 and says it waits', /Offline sale BF-000001/.test(R.t1) && /sent when the line is back/.test(R.t1), R.t1);
await p.waitForSelector('#modal .rc-paper'); R.r1 = await receiptText(); check('receipt prints with the number and the offline note', /BF-000001/.test(R.r1) && /Rung up offline/.test(R.r1) && /TOTAL R 199\.00/.test(R.r1), R.r1);
await closeReceipt();
R.bannerQ1 = await banner(); check('banner counts 1 waiting, 9 numbers left', /1 sale waiting to send/.test(R.bannerQ1) && /9 numbers left/.test(R.bannerQ1), R.bannerQ1);
check('cached stock dropped to 2 for the next sale', (await tileStock()) === '2 in stock', await tileStock());
await scan('CUSH'); R.t2 = await payCash(); check('second offline sale takes BF-000002', /Offline sale BF-000002/.test(R.t2), R.t2); await closeReceipt();
R.queued = await idb('sales'); check('two sales in the outbox in order, with their numbers and bodies', R.queued.length === 2 && R.queued.map(x => x.seq).join() === '1,2' && R.queued.every(x => x.status === 'queued' && x.body.seq === x.seq && x.body.lines.length), R.queued.map(x => [x.seq, x.status]));
check('stock overlay: 1 left', (await tileStock()) === '1 in stock');
check('nothing reached the server yet', (await listColl('sales')).length === 0);
await p.screenshot({ path: S + '/shots/pos9-offline.png' });

// ---- a queued sale whose price changes before it syncs: refused, kept, number voided
await scan('BOOK'); R.t3 = await payCash(); check('third offline sale BF-000003', /BF-000003/.test(R.t3), R.t3); await closeReceipt();
await put('pos/retail/products/p_b?updateMask.fieldPaths=priceCents', { priceCents: 15000 });   // the book now costs more at the office

// ---- back online: the first two sync in order, the third is refused and its number voided
await ctx.setOffline(false); await p.waitForTimeout(6000);
R.bannerAfter = await banner();
const sales = await listColl('sales');
check('the two good sales arrived with their offline numbers, in order', sales.length === 2 && sales.map(s => s.docNo).sort().join() === 'BF-000001,BF-000002' && sales.every(s => s.deviceId === 'dev_off' && s.source === 'till'), sales.map(s => [s.docNo, s.seq]));
const lv = await getDoc('pos/retail/stockLevels/BF-BELL_p_c'); check('stock on the server: 3 − 2 = 1', lv.onHandQty === 1, lv);
R.outboxAfter = await idb('sales'); check('the refused sale is kept as failed with the reason', R.outboxAfter.length === 1 && R.outboxAfter[0].status === 'failed' && /price/.test(R.outboxAfter[0].error) && R.outboxAfter[0].seq === 3, R.outboxAfter.map(x => [x.seq, x.status, x.error]));
const voids = await listColl('voidedNumbers'); check('number 3 voided with the reason', voids.length === 1 && voids[0].seq === 3 && /refused/.test(voids[0].reason) && voids[0].docNo === 'BF-000003', voids);
const blocks = await listColl('numberBlocks'); check('the block’s usedUpTo moved past the void', blocks.some(x => x.from === 1 && x.usedUpTo === 3), blocks.map(x => [x.from, x.to, x.usedUpTo]));
check('banner: 1 refused', /1 offline sale refused/.test(R.bannerAfter), R.bannerAfter);
check('stock overlay cleared once synced', (await tileStock()) === '1 in stock', await tileStock());
// a manager can see and drop it
await p.click('#offline-bar [data-act=sync-failed]'); await p.waitForSelector('#modal .pk-list'); R.failedText = await p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' '));
check('the refused sale is listed for review', /BF-000003/.test(R.failedText) && /price/.test(R.failedText), R.failedText.slice(0, 200));
await p.click('#modal-ok');

// ---- the next block comes early when few numbers remain (block 10, refill at 5: after 3 used, 7 left → not yet; sell 3 more online → 4 left → a second block)
for (let i = 0; i < 3; i++) { await scan('CUSH'); await payCash(); await closeReceipt(); }
await p.waitForTimeout(1500);
R.blocks1 = await idb('blocks'); check('a second block issued early: 1–10 and 11–20', R.blocks1[0].blocks.length === 2 && R.blocks1[0].blocks[1].from === 11 && R.blocks1[0].blocks[1].to === 20, R.blocks1[0] && R.blocks1[0].blocks);
const allSales = await listColl('sales'); check('online sales after the void carry on from 4', allSales.map(s => s.seq).sort((a, b) => a - b).join() === '1,2,4,5,6', allSales.map(s => s.seq));

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
