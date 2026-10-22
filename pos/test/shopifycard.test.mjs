// Retail POS in the browser: the Shopify and Factory cards under Admin → Settings, used the way a person does —
// a click into a field or on the select first, then the button. (The cards' click handler was once-only and a click
// into a field used it up, so Connect and Save did nothing.) Connect, map the location, save; link the factory.
import { chromium } from 'playwright';
import { startMockShopify } from './mock-shopify.mjs';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099', BASE = 'http://localhost:8788/pos/?emulator=1';
const FBDIR = process.env.FIREBASE_SDK_DIR || '';
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const own = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.co.za', password: 'secret123', returnSecureToken: true }) })).json();
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', sku: 'CU-1', priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', sku: 'LA-1', priceCents: 50000, costCents: 20000 });
await prod('p_rug', { name: 'Rug', sku: 'RU-1', priceCents: 80000, costCents: 30000 });
for (const [id, q] of [['p_cushion', 12], ['p_lamp', 4], ['p_rug', 2]]) await put('pos/retail/stockLevels/BF-BELL_' + id, { productId: id, variantId: '', onHandQty: q, reservedQty: 0, onOrderQty: 0, ...srv('BF', 'BF-BELL') });
const mock = await startMockShopify(8799, { variants: [
  { id: 'gid://shopify/ProductVariant/1001', sku: 'CU-1', title: 'Default', inventoryItem: { id: 'gid://shopify/InventoryItem/2001', tracked: true }, product: { id: 'gid://shopify/Product/3001', title: 'Scatter Cushion — Linen', handle: 'scatter-cushion', descriptionHtml: '<p>A soft linen cushion.</p>', status: 'ACTIVE', images: { nodes: [] } } },
  { id: 'gid://shopify/ProductVariant/1002', sku: 'LA-1', title: 'Default', inventoryItem: { id: 'gid://shopify/InventoryItem/2002', tracked: true }, product: { id: 'gid://shopify/Product/3002', title: 'Lamp', handle: 'lamp', descriptionHtml: '', status: 'ACTIVE', images: { nodes: [] } } },
  { id: 'gid://shopify/ProductVariant/1003', sku: 'RU-1', title: 'Default', inventoryItem: { id: 'gid://shopify/InventoryItem/2003', tracked: true }, product: { id: 'gid://shopify/Product/3003', title: 'Rug', handle: 'rug', descriptionHtml: '', status: 'ACTIVE', images: { nodes: [] } } }
] });

await put('companies/CPTEST', { name: 'Couch Potato Test', status: 'free', createdAt: '2026-01-01T00:00:00.000Z' });
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login:not([hidden])');
const sw = p.locator('#login-switch [data-mode=email]'); if (await sw.isVisible()) await sw.click();
await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#nav [data-view=admin]', { timeout: 20000 }); await p.waitForTimeout(800);
await p.click('#nav [data-view=admin]'); await p.waitForTimeout(300); await p.click('[data-sub=settings]'); await p.waitForTimeout(800);
await p.waitForSelector('#sh-domain', { timeout: 15000 });
// a person clicks into the fields first
await p.click('#sh-domain'); await p.keyboard.type('bellville-furniture.myshopify.com');
await p.click('#sh-id'); await p.keyboard.type('a1b2c3d4e5f6');
await p.click('#sh-secret'); await p.keyboard.type('shpss_secret');
await p.click('[data-act=on-connect]'); R.connect = await toast(); await p.waitForTimeout(2500);
check('Connect works after clicking into the fields', /Connected to Bellville Online/.test(R.connect), R.connect);
await p.waitForSelector('#sh-default', { timeout: 15000 }); await p.waitForTimeout(2500);
// the select is clicked (the card's listener must survive it), then saved
await p.click('#sh-loc-BF-BELL'); await p.selectOption('#sh-loc-BF-BELL', 'gid://shopify/Location/11'); await p.selectOption('#sh-default', 'BF-BELL');
await p.click('[data-act=on-settings]'); R.save = await toast(); await p.waitForTimeout(2500);
check('Save works after clicking the select', /Shopify settings saved/.test(R.save), R.save);
const st = await (await fetch(`${docs}/pos/retail/settings/BF`, { headers: H })).json();
const sh = st.fields && st.fields.shopify && st.fields.shopify.mapValue.fields;
check('written: the location for Bellville and the default store', sh && sh.locationByStore.mapValue.fields['BF-BELL'].stringValue === 'gid://shopify/Location/11' && sh.defaultStoreId.stringValue === 'BF-BELL', sh && Object.keys(sh));
// the factory card the same way: click the select, pick, save
await p.waitForSelector('#fa-co', { timeout: 15000 });
await p.click('#fa-co'); await p.selectOption('#fa-co', 'CPTEST'); await p.click('[data-act=fa-link]'); R.link = await toast(); await p.waitForTimeout(1500);
check('the factory link saves after clicking the select', /Custom orders go to Couch Potato Test/.test(R.link), R.link);
console.log(JSON.stringify({ fails, errs, ...R }, null, 1));
await b.close(); await mock.close();
process.exit(fails.length || errs.length ? 1 : 0);
