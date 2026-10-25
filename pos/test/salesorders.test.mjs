// Retail POS in the browser: a sales order. A made-to-order item rung up as
// an ordinary sale: the specification on the line, the customer needed
// before paying, paid by card, the invoice printed; the Sales orders section
// on the Custom orders tab, the factory checked, the WhatsApp update, the
// hand-over signed on the screen.
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
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, specialOrder: { minDepositPct: 50, leadDays: 21 }, factory: { companyId: 'CPTEST', companyName: 'Couch Potato Test' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville', code: '7530' }, active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('companies/CPTEST', { name: 'Couch Potato Test', status: 'free', createdAt: '2026-01-01T00:00:00.000Z' });
await put('companies/CPTEST/settings/factory', { orderPrefix: 'CP-', firstOrderNo: 1001 });
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
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(600); };
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
const finish = async () => { await p.click('#modal-ok'); const t = await toast(); await p.waitForTimeout(900); if (await p.locator('#modal .rc-paper').count()) { R.slip = await paper(); await p.click('#modal-ok'); await p.waitForTimeout(300); } return t; };


// ---- a sofa made to order, sold as a sale: the spec on the line, the customer first
await scan('SOFA');
R.cart = await p.locator('.pos-right').innerText(); check('the line says made to order and asks for the specification', /made to order/i.test(R.cart) && /Specification/i.test(R.cart), R.cart.slice(0, 300));
await p.click('[data-act=sl-pay]'); R.noCust = await toast(); check('paying without a customer: refused on the till', /sales order: add the customer first/.test(R.noCust), R.noCust);
await p.click('[data-act=sl-note][data-i="0"]'); await p.waitForSelector('#modal #ln-fab');
check('the model prefilled', (await p.inputValue('#ln-model')) === 'Custom Sofa');
await p.fill('#ln-size', '2.4 m'); await p.fill('#ln-fab .fb-pick-q', 'Linen look'); await p.fill('#ln-colour', 'Charcoal'); await p.fill('#ln-legs', 'Oak'); await p.fill('#ln-notes', 'Firm seat'); await p.fill('#ln-note', 'deliver Friday');
await p.click('#modal-ok'); await p.waitForTimeout(300);
R.cart2 = await p.locator('.pos-right').innerText(); check('the spec shows on the line', /2\.4 m · Linen look · Charcoal · Oak · deliver Friday/i.test(R.cart2), R.cart2.slice(0, 300));
await pickThandi();
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay');
await p.click('[data-m=card]'); await p.fill('#py-amount', '15000'); await p.fill('#py-last4', '4242'); await p.click('[data-add=card]'); await p.waitForTimeout(200);
R.sold = await finish(); check('sold: BF-000001', /Sale BF-000001/.test(R.sold), R.sold);
check('the invoice line prints the spec', /Custom Sofa/.test(R.slip || '') && /Fabric Linen look/.test(R.slip || '') && /Colour Charcoal/.test(R.slip || ''), (R.slip || '').slice(0, 400));
await p.waitForTimeout(1200);
const so1 = (await listColl('salesOrders'))[0];
check('the sales order written: open, the spec, not at the factory by itself', so1 && so1.docNo === 'BF-000001' && so1.status === 'open' && so1.lines[0].spec.fabric === 'Linen look' && !so1.factoryRef && so1.customerSnapshot.name === 'Thandi Mokoena', so1 && [so1.status, so1.factoryRef]);

// ---- it waits at the till: the cashier sees it is not at the factory and cannot send it; the manager sends it
await nav('orders');
await p.click('[data-act=so-sales-open]'); await p.waitForSelector('#modal .lb-detail');
R.waiting = await modalText(); check('the cashier sees "Not at the factory" and no Send button', /Not at the factory/.test(R.waiting) && /Send to factory/.test(R.waiting) && (await p.locator('[data-act=so-sales-send]').count()) === 0, R.waiting.slice(0, 500));
await p.keyboard.press('Escape'); await p.waitForTimeout(300); if (await p.locator('#modal').count()) { await p.locator('#modal [data-close]').first().click(); await p.waitForTimeout(200); }
await p.click('#lock'); await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '222222'); await p.waitForSelector('#nav [data-view=orders]', { state: 'attached' }); await p.waitForTimeout(1000);
await nav('orders');
await p.click('[data-act=so-sales-open]'); await p.waitForSelector('#modal [data-act=so-sales-send]');
await p.click('[data-act=so-sales-send]'); R.sentToast = await toast(); await p.waitForTimeout(800);
check('the manager sends it: at the factory as CP-1001', /BF-000001 is at the factory: CP-1001/.test(R.sentToast) && (await listColl('salesOrders'))[0].factoryRef === 'CP-1001', R.sentToast);
if (await p.locator('#modal').count()) { await p.locator('#modal [data-close]').first().click(); await p.waitForTimeout(200); }
await p.click('#lock'); await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#nav [data-view=sell]', { state: 'attached' }); await p.waitForTimeout(1200);   // back on the screen it was locked on

// ---- the Sales orders section, the factory, the update, the hand-over
await nav('orders');
R.tab = await screenText(); check('listed under Sales orders: ordered, at the factory', /Sales orders/i.test(R.tab) && /BF-000001/.test(R.tab) && /1 × Custom Sofa/.test(R.tab) && /Ordered/i.test(R.tab) && /CP-1001/.test(R.tab), R.tab.slice(0, 400));
await p.click('[data-act=so-sales-open]'); await p.waitForSelector('#modal .lb-detail');
R.detail = await modalText(); check('the detail: the spec, the factory line, the hand-over, no status buttons for a cashier', /Fabric: Linen look/.test(R.detail) && /CP-1001 new/.test(R.detail) && /Hand over/i.test(R.detail) && !/deliver Friday · Size/.test(R.detail) && (await p.locator('[data-act=so-sales-status]').count()) === 0, R.detail.slice(0, 400));
await p.click('[data-act=so-sales-sync]'); R.syncToast = await toast(); await p.waitForTimeout(500); check('checked at the factory', /The factory: CP-1001 new/.test(R.syncToast), R.syncToast);
await p.waitForSelector('#modal .lb-detail');
await p.click('[data-act=so-sales-update]'); await p.waitForTimeout(800);
R.opened = await p.evaluate(() => window.__opened); check('the WhatsApp update opened with the message', R.opened.some(u => /wa\.me|whatsapp/.test(u) && /invoice%20BF-000001|invoice\+BF-000001|BF-000001/.test(u)), R.opened);
await p.waitForSelector('#modal .lb-detail');
await p.click('[data-act=so-sales-handover]'); await p.waitForSelector('#modal #dn-pad');
await sign('#dn-pad'); await p.click('#modal-ok'); R.handToast = await toast(); await p.waitForTimeout(800);
check('handed over', /BF-000001 handed over/.test(R.handToast), R.handToast);
const so2 = (await listColl('salesOrders'))[0];
check('written: collected, signed', so2.status === 'collected' && so2.handover.signedBy === 'Thandi Mokoena' && so2.handover.signature.startsWith('data:image/png'), so2 && [so2.status, so2.handover && so2.handover.signedBy]);
await closeModal();
R.tab2 = await screenText(); check('gone from the open list', !/BF-000001/.test(R.tab2) || /No open sales orders/.test(R.tab2), R.tab2.slice(0, 300));

console.log(JSON.stringify({ fails, errs, ...R, slip: undefined }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
