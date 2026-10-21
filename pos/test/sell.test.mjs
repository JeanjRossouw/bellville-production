// Retail POS step 5: the sale screen on an enrolled till, as a cashier.
// Seeds everything straight into the emulators (the screens for that are
// covered by the earlier tests) and drives the cart.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineTotals, vatIn, pctOf } from '../js/money.js';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const crash = (e) => { console.log(JSON.stringify({ ...R, fails, errs, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : f.doubleValue;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
const pinRec = (pin) => { const salt = 'ab'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') });
await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
const secret = 'test-secret-' + Date.now();
await put('pos/retail/devices/dev_test', { label: 'Front till', registerId: 'r1', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, lastSeenAt: '', appVersion: '', ...srv('BF', 'BF-BELL', 'dev_test') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], reorderLevel: null, reorderQty: null, archived: false, favourite: false, description: '', shopifyProductId: '', shopifyHandle: '', ...o, ...srv('BF') });
await prod('p_ch', { name: '3 Seater Chesterfield', sku: 'CH-3', barcodes: ['6001234567890'], category: 'Sofas', costCents: 400000, priceCents: 920000, storePrices: { 'BF-BELL': 899900 }, favourite: true });
await prod('p_wb', { name: 'Wingback Chair', sku: 'WB', category: 'Chairs', costCents: 150000, priceCents: 349900, options: [{ name: 'Colour', values: ['Grey', 'Navy'] }], hasVariants: true });
await put('pos/retail/variants/v_grey', { productId: 'p_wb', name: 'Grey', optionValues: { Colour: 'Grey' }, sku: 'WB-G', barcodes: ['20000001'], costCents: null, priceCents: null, storePrices: {}, images: [], archived: false, shopifyVariantId: '', ...srv('BF') });
await put('pos/retail/variants/v_navy', { productId: 'p_wb', name: 'Navy', optionValues: { Colour: 'Navy' }, sku: 'WB-N', barcodes: [], costCents: null, priceCents: 379900, storePrices: {}, images: [], archived: false, shopifyVariantId: '', ...srv('BF') });
await prod('p_book', { name: 'Care Book', sku: 'BK1', barcodes: ['9780000000001'], category: 'Books', vatClass: 'zero', costCents: 5000, priceCents: 12000 });
await prod('p_cushion', { name: 'Scatter Cushion', sku: 'CU1', barcodes: ['6002222222222'], category: 'Accessories', costCents: 5000, priceCents: 19900 });
await put('pos/retail/stockLevels/BF-BELL_p_ch', { productId: 'p_ch', variantId: '', onHandQty: 1, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_v_navy', { productId: 'p_wb', variantId: 'v_navy', onHandQty: 4, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c_thandi', { name: 'Thandi Mokoena', contact: 'Thandi', phone: '0825550101', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
// this browser is the enrolled till
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); }, { deviceId: 'dev_test', secret, label: 'Front till', entityId: 'BF', storeId: 'BF-BELL', registerId: 'r1' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const cartText = () => p.locator('.pos-right').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const lineCount = () => p.locator('.pos-line').count();
const totalShown = () => p.locator('.pos-totals .tot strong').innerText();
const T = (lines, cartDisc = 0) => { let sub = 0, gross = 0; const ls = lines.map(l => { const t = lineTotals({ qty: l.qty, unitPriceCents: l.price, discountCents: l.disc || 0, rateBp: l.zero ? 0 : 1500 }); sub += t.lineTotalCents; gross += t.grossCents; return { ...l, ...t }; }); let left = cartDisc, vat = 0; ls.forEach((l, i) => { const sh = i === ls.length - 1 ? left : Math.round(cartDisc * l.lineTotalCents / sub); left -= sh; vat += vatIn(l.lineTotalCents - sh, l.zero ? 0 : 1500); }); return { gross, total: sub - cartDisc, vat }; };
const money = (c) => 'R ' + String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(c % 100).padStart(2, '0');

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login:not([hidden])'); await p.waitForSelector('#login-pin .pinpad');
await pinType('#login-pin', '111111'); await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(900);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('a till opens on Sell', R.nav[0] === 'sell' && (await p.locator('#sl-q').count()) === 1, R.nav);
R.landing = await p.$$eval('.pos-grid .pos-tile', x => x.map(y => y.innerText.replace(/\s+/g, ' ').trim()));
check('landing: the favourite, then the categories', /3 Seater Chesterfield R 8,999\.00 1 in stock/.test(R.landing[0]) && R.landing.slice(1).join('|').toUpperCase().includes('SOFAS') && R.landing.slice(1).join('|').toUpperCase().includes('CHAIRS'), R.landing);

// ---- scan from anywhere (wedge): the chesterfield at the store's price
await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });   // nothing focused: the scanner types into the page
await p.keyboard.type('6001234567890'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
check('scanned line at the store price', (await lineCount()) === 1 && /3 Seater Chesterfield/.test(await cartText()) && (await totalShown()) === money(899900), await cartText());
R.stockWarn = await toast();
await p.keyboard.type('6001234567890'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
R.stockWarn = await toast(); check('selling past stock warns and still sells', /Only 1 on hand/.test(R.stockWarn) && /stock goes negative/i.test(await cartText()), R.stockWarn);
// ---- a scanned variant code adds that variant straight in
await p.keyboard.type('20000001'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
check('variant barcode → that variant, at the product price', /Wingback Chair · Grey/.test(await cartText()) && (await lineCount()) === 2);
// ---- search → variant picker
await p.fill('#sl-q', 'wing'); await p.waitForTimeout(300);
R.hits = await p.$$eval('.pos-grid .pos-tile', x => x.map(y => y.innerText.replace(/\s+/g, ' ').trim())); check('search shows the chair with "from" price', R.hits.length === 1 && /from R 3,499\.00/.test(R.hits[0]), R.hits);
await p.click('.pos-grid .pos-tile'); await p.waitForSelector('#modal .var-pick');
R.vars = await p.$$eval('#modal .var-btn', x => x.map(y => y.innerText.replace(/\s+/g, ' ').trim())); check('picker lists both with price and stock', /Grey R 3,499\.00/.test(R.vars[0]) && /Navy R 3,799\.00 · 4 in stock/.test(R.vars[1]), R.vars);
await p.click('#modal .var-btn:nth-child(2)'); await p.waitForTimeout(300);
check('navy added as its own line', (await lineCount()) === 3 && /Wingback Chair · Navy/.test(await cartText()));
// ---- qty, a zero-rated book, totals
await p.locator('.pos-line[data-i="2"] [data-act=sl-qty][data-d="1"]').click(); await p.waitForTimeout(200);
await p.fill('#sl-q', '9780000000001'); await p.press('#sl-q', 'Enter'); await p.waitForTimeout(300);
let exp = T([{ qty: 2, price: 899900 }, { qty: 1, price: 349900 }, { qty: 2, price: 379900 }, { qty: 1, price: 12000, zero: true }]);
R.totals1 = await p.locator('.pos-totals').innerText().then(t => t.replace(/\s+/g, ' '));
check('totals: items, VAT included (book zero-rated), total', (await totalShown()) === money(exp.total) && R.totals1.includes(money(exp.vat)) && R.totals1.includes('Items (6)'), { shown: R.totals1, exp });
await p.screenshot({ path: S + '/shots/pos5-sell.png' });

// ---- line discount within the cashier's 5%: no PIN; a reason is needed
await p.locator('.pos-line[data-i="1"] [data-act=sl-line-disc]').click(); await p.waitForSelector('#modal');
await p.fill('#dc-pct', '5'); await p.click('#modal-ok'); R.noReason = await toast(); check('a discount needs a reason', /reason/i.test(R.noReason), R.noReason);
await p.fill('#dc-reason', 'Floor model'); await p.click('#modal-ok'); await p.waitForTimeout(300);
check('5% line discount applied without a PIN', /− R 174\.95 \(5%\)/.test(await cartText()) && (await p.locator('#modal').count()) === 0, await cartText());
// ---- 20% on a line: over the cashier's limit → manager PIN; the cashier's own PIN is refused
await p.locator('.pos-line[data-i="0"] [data-act=sl-line-disc]').click(); await p.waitForSelector('#modal #dc-pct');
await p.fill('#dc-pct', '20'); await p.fill('#dc-reason', 'Price match');
await p.click('#modal-ok');
for (let i = 0; i < 25 && !(await p.locator('#modal .pinpad').count()); i++) await p.waitForTimeout(200);
if (!(await p.locator('#modal .pinpad').count())) R.noPad = await p.evaluate(() => ({ modal: (document.getElementById('modal') || { innerText: '' }).innerText.replace(/\s+/g, ' ').slice(0, 200), modals: document.querySelectorAll('.modal').length, toast: document.getElementById('toast').innerText, line0: document.querySelector('.pos-line[data-i="0"]').innerText.replace(/\s+/g, ' ') }));
await p.waitForSelector('#modal .pinpad', { timeout: 3000 });
R.ovTitle = await p.locator('#modal h2').innerText(); check('20% asks for a manager', /20% off needs a manager/i.test(R.ovTitle), R.ovTitle);
await pinType('#modal', '111111'); R.ovRefused = await p.locator('#modal .pin-msg').innerText(); check('cashier PIN refused', /cashier|own/.test(R.ovRefused), R.ovRefused);
await pinType('#modal', '222222'); await p.waitForTimeout(500);
check('20% applied, approver shown', /− R 3,599\.60 \(20%\) · Mandla/i.test(await cartText()), await cartText());
// ---- sale discount 3%: within limit
await p.click('[data-act=sl-cart-disc]'); await p.waitForSelector('#modal'); await p.fill('#dc-pct', '3'); await p.fill('#dc-reason', 'Loyalty'); await p.click('#modal-ok'); await p.waitForTimeout(300);
exp = T([{ qty: 2, price: 899900, disc: 359960 }, { qty: 1, price: 349900, disc: 17495 }, { qty: 2, price: 379900 }, { qty: 1, price: 12000, zero: true }], 0);
const sub = exp.total; const cartDisc = pctOf(sub, 3);
exp = T([{ qty: 2, price: 899900, disc: 359960 }, { qty: 1, price: 349900, disc: 17495 }, { qty: 2, price: 379900 }, { qty: 1, price: 12000, zero: true }], cartDisc);
check('sale discount spread; total and VAT right', (await totalShown()) === money(exp.total) && (await p.locator('.pos-totals').innerText()).includes(money(exp.vat)), { shown: await totalShown(), exp });
// ---- price override needs a manager
await p.locator('.pos-line[data-i="3"] [data-act=sl-price]').click(); await p.waitForSelector('#modal'); await p.fill('#po-price', '100'); await p.fill('#po-reason', 'Dog-eared'); await p.click('#modal-ok'); await p.waitForSelector('#modal .pinpad');
await pinType('#modal', '222222'); await p.waitForTimeout(500);
check('price overridden and marked', /R 100\.00 was R 120\.00/.test(await cartText()), await cartText());
const audit1 = await listColl('auditLog');
check('both overrides audited with both names', audit1.filter(a => a.action === 'override.discount' && a.overrideUid === 'st_mandla' && a.actorUid === 'st_cathy').length === 1 && audit1.some(a => a.action === 'override.price' && a.details.toCents === 10000), audit1.map(a => a.action));

// ---- customer: search, then quick-add by cell
await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', '0825'); await p.waitForTimeout(200);
R.custHits = await p.$$eval('#cu-list .pk-row', x => x.map(y => y.innerText.replace(/\s+/g, ' '))); check('customer found by cell', R.custHits.length === 1 && /Thandi/.test(R.custHits[0]), R.custHits);
await p.click('#cu-list .pk-row'); await p.waitForTimeout(300); check('customer attached', /Thandi Mokoena/.test(await cartText()));
await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.click('#modal summary'); await p.fill('#cu-name', 'Sipho Dlamini'); await p.fill('#cu-phone', '083 555 0102');
await p.click('#cu-add'); R.quickAdd = await toast(); await p.waitForTimeout(600);
check('quick-add attaches the new customer', /Sipho Dlamini added/.test(R.quickAdd) && /Sipho Dlamini/.test(await cartText()), R.quickAdd);
const custs = await listColl('customers'); const sipho = custs.find(c => c.name === 'Sipho Dlamini');
check('customer written by the cashier with stamps and no credit', sipho && sipho.phone === '0835550102' && sipho.storeCreditCents === 0 && sipho.createdBy === 'st_cathy' && sipho.deviceId === 'dev_test' && sipho.entityId === 'BF', sipho);

// ---- park and recall
await p.click('[data-act=sl-park]'); await p.waitForSelector('#modal'); await p.click('#modal-ok'); await p.waitForTimeout(300);
check('parked: cart empty, recall shows 1', (await lineCount()) === 0 && /Recall \(1\)/.test(await cartText()), await cartText());
await p.keyboard.type('6002222222222'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
await p.click('[data-act=sl-recall]'); await p.waitForSelector('#modal .pk-row'); R.parkedRow = await p.locator('#modal .pk-row').first().innerText().then(t => t.replace(/\s+/g, ' '));
check('the parked sale is listed by customer with its total', /Sipho Dlamini/.test(R.parkedRow) && /4 lines/.test(R.parkedRow), R.parkedRow);
await p.click('#modal .pk-row'); await p.waitForTimeout(300);
check('recalled: four lines back, customer back, the cushion cart parked instead', (await lineCount()) === 4 && /Sipho Dlamini/.test(await cartText()) && /Recall \(1\)/.test(await cartText()), await cartText());
// a reload keeps the cart
// a reload keeps the signed-in cashier (a lock is explicit); if it did ask, the PIN gets her back
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#app:not([hidden]), #login:not([hidden])', { timeout: 15000 });
if (await p.locator('#login').isVisible()) { await pinType('#login-pin', '111111'); await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); }
await p.waitForSelector('.pos-line', { timeout: 15000 }).catch(() => {});
check('the cart survives a reload and a sign-in', (await lineCount()) === 4 && /Sipho Dlamini/.test(await cartText()), await cartText());

// ---- void a line, then the sale, with reasons
await p.locator('.pos-line[data-i="3"] [data-act=sl-void-line]').click(); await p.waitForSelector('#modal'); await p.click('#modal-ok'); R.voidNoReason = await toast(); check('void needs a reason', /reason/i.test(R.voidNoReason));
await p.fill('#vd-reason', 'Changed their mind'); await p.click('#modal-ok'); await p.waitForTimeout(400); check('line removed', (await lineCount()) === 3);
await p.click('[data-act=sl-void]'); await p.waitForSelector('#modal'); await p.fill('#vd-reason', 'Walked away'); await p.click('#modal-ok'); await p.waitForTimeout(500);
check('sale voided: cart empty', (await lineCount()) === 0 && /No items yet/.test(await cartText()));
const audit2 = await listColl('auditLog');
const lv = audit2.find(a => a.action === 'sale.line.void'), sv = audit2.find(a => a.action === 'sale.void');
check('voids audited with reasons, by the cashier on this till', lv && lv.details.reason === 'Changed their mind' && /Care Book/.test(lv.details.name) && sv && sv.details.reason === 'Walked away' && sv.details.lines.length === 3 && sv.actorUid === 'st_cathy' && sv.deviceId === 'dev_test' && sv.storeId === 'BF-BELL', { lv: lv && lv.details, sv: sv && sv.details });

console.log(JSON.stringify({ ...R, fails, errs }, null, 1));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
