// Retail POS step 17 in the browser: as a manager on a till — a shop
// discount code applied on the sale with no PIN and honoured by the
// server; the Online tab with a click & collect order marked ready and
// collected (fulfilled on the mock shop); the sync status and the log.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockShopify } from './mock-shopify.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const FN = 'http://localhost:8788/.netlify/functions/';
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
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, shopify: { connected: true, domain: 'bellville-online.myshopify.com', shopName: 'Bellville Online', locationByStore: { 'BF-BELL': 'gid://shopify/Location/11' }, defaultStoreId: 'BF-BELL', pushStock: true, pullOrders: true, syncCodes: true, syncCustomers: true }, ...srv('BF') });
await put('pos/retail/shopifySecrets/BF', { domain: 'bellville-online.myshopify.com', clientId: 'id1', clientSecret: 'shpss_secret', ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'on-secret-' + Date.now();
await put('pos/retail/devices/dev_on', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_on') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_lamp', { name: 'Lamp', sku: 'LA-1', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000, shopifyVariantId: 'gid://shopify/ProductVariant/1002', shopifyInventoryItemId: 'gid://shopify/InventoryItem/2002' });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 0, avgCostCents: 20000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/discountCodes/BF_TEN', { entityId: 'BF', storeId: '', code: 'TEN', title: 'Ten off', kind: 'percentage', value: 10, valueCents: 0, startsAt: '2026-01-01T00:00:00Z', endsAt: '', active: true, wholeSale: true, shopifyId: 'x', ...srv('BF') });
const mock = await startMockShopify(8799, {});

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit', env: { ...process.env, SHOPIFY_API_BASE: 'http://127.0.0.1:8799' } });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
// a click & collect order arrives by webhook before we look
const payload = { id: 9101, name: '#9101', order_number: 9101, created_at: new Date().toISOString(), financial_status: 'paid', fulfillment_status: null, email: 'thandi@example.com', currency: 'ZAR', total_price: '500.00', customer: { first_name: 'Thandi', last_name: 'Mokoena', email: 'thandi@example.com' }, shipping_address: { address1: '5 Lane', city: 'Parow', phone: '0825550101' }, shipping_lines: [{ title: 'Pick up in store', code: 'pickup' }], line_items: [{ id: 70101, variant_id: 1002, sku: 'LA-1', title: 'Lamp', quantity: 1, price: '500.00' }] };
const raw = JSON.stringify(payload);
R.hook = await (await fetch(FN + 'pos-shopify?hook=1&e=BF', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', 'shpss_secret').update(raw).digest('base64') }, body: raw })).json();
check('the webhook order took a lamp', R.hook.ok && R.hook.stock === 'deducted' && (await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp')).onHandQty === 4, R.hook);

const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.open = () => { const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_on', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '222222'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Online tab present', R.nav.includes('online'), R.nav);

// ---- a shop discount code on the sale
await scan('LAMP');
await p.click('[data-act=sl-cart-disc]'); await p.waitForSelector('#modal #dc-code');
await p.selectOption('#dc-code', 'TEN'); await p.click('#modal-ok'); await p.waitForTimeout(400);
R.cart = await p.locator('.pos-right').innerText().then(t => t.replace(/\s+/g, ' ')); check('the code took 10% off: R 50', /− R 50\.00/.test(R.cart) && /R 450\.00/.test(R.cart), R.cart.slice(0, 300));
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-m=card]'); await p.waitForTimeout(150); await p.click('[data-add=card]'); await p.waitForTimeout(200); await p.click('#modal-ok'); R.sold = await toast(); await p.waitForTimeout(1500);
check('sold at R 450 with the code', /Sale BF-000001/.test(R.sold), R.sold);
await closeModal();
const sale = (await listColl('sales'))[0];
check('the sale carries the code and no approver; the shop got the new stock (3)', sale && sale.saleDiscountCode === 'TEN' && sale.saleDiscountCents === 5000 && !sale.saleDiscountBy && mock.state.inventory['gid://shopify/InventoryItem/2002|gid://shopify/Location/11'] === 3, [sale && sale.saleDiscountCode, mock.state.inventory]);

// ---- the Online tab: the click & collect order, ready, collected
await nav('online'); await p.waitForSelector('.tbl', { timeout: 15000 }); await p.waitForTimeout(500);
R.online = await screenText(); check('connected, the pickup order listed as new', /Connected to Bellville Online/.test(R.online) && /#9101/.test(R.online) && /Thandi Mokoena/.test(R.online) && /Click & collect/i.test(R.online) && /New/i.test(R.online) && /1 × Lamp/.test(R.online), R.online.slice(0, 500));
await p.click('[data-act=on-ready]'); R.ready = await toast(); await p.waitForTimeout(1200);
check('marked ready', /Marked ready/.test(R.ready), R.ready);
await p.click('[data-act=on-collected]'); R.coll = await toast(); await p.waitForTimeout(1200);
check('collected and fulfilled on the shop', /Collected · fulfilled on Shopify/.test(R.coll) && mock.state.fulfilled.length === 1, [R.coll, mock.state.fulfilled]);
await p.selectOption('#on-filter', 'collected'); await p.waitForTimeout(300);
R.online2 = await screenText(); check('the collected filter shows it', /#9101/.test(R.online2) && /Collected/i.test(R.online2), R.online2.slice(0, 300));
await p.click('[data-act=on-log]'); await p.waitForTimeout(800);
R.log = await screenText(); check('the log shows the order and the stock pushes', /Sync log/i.test(R.log) && /#9101/.test(R.log) && /stock/.test(R.log), R.log.slice(-400));

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await b.close(); await mock.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
