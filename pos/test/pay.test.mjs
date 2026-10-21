// Retail POS step 6 in the browser: the payment screen on a till, as a
// cashier. Cash with change, a split, store credit, a voucher sold then
// used, EFT awaiting; and what lands in the database. Emulators + server.mjs.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
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
const pinRec = (pin) => { const salt = 'cd'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card', 'eft', 'voucher', 'storeCredit', 'account'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
const secret = 'pay-secret-' + Date.now();
await put('pos/retail/devices/dev_pay', { label: 'Front till', registerId: 'r1', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, lastSeenAt: '', appVersion: '', ...srv('BF', 'BF-BELL', 'dev_pay') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], reorderLevel: null, reorderQty: null, archived: false, favourite: true, description: '', shopifyProductId: '', shopifyHandle: '', ...o, ...srv('BF') });
await prod('p_ch', { name: '3 Seater Chesterfield', barcodes: ['6001234567890'], costCents: 400000, priceCents: 899900 });
await prod('p_book', { name: 'Care Book', barcodes: ['9780000000001'], vatClass: 'zero', costCents: 5000, priceCents: 12000 });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['6002222222222'], costCents: 5000, priceCents: 19899 });
await prod('p_gv', { name: 'Gift voucher R500', type: 'voucher', trackStock: false, barcodes: ['GV500'], priceCents: 50000 });
await put('pos/retail/stockLevels/BF-BELL_p_ch', { productId: 'p_ch', variantId: '', onHandQty: 3, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c_thandi', { name: 'Thandi Mokoena', contact: 'Thandi', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: true, creditLimitCents: 1000000, storeCreditCents: 20000, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); }, { deviceId: 'dev_pay', secret, label: 'Front till', entityId: 'BF', storeId: 'BF-BELL', registerId: 'r1' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const cartText = () => p.locator('.pos-right').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const payText = () => p.locator('#pay-right').innerText().then(t => t.replace(/\s+/g, ' ').trim());
// completing opens the receipt panel: read the toast, then close it
const finish = async () => { await p.click('#modal-ok'); const t = await toast(); await p.waitForTimeout(900); if (await p.locator('#modal .rc-paper').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } return t; };
const money = (c) => 'R ' + String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(c % 100).padStart(2, '0');

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForSelector('#sl-q'); await p.waitForTimeout(800);

// 1. cash, a walk-in: cushion + book (R 318.99 → cash due R 319.00, rounding 1c), R 1,000 given
await scan('6002222222222'); await scan('9780000000001');
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay');
R.pay1 = await payText(); check('pay screen shows the total', /Total R 318\.99/.test(R.pay1) && /Still to pay R 318\.99/i.test(R.pay1), R.pay1);
R.methods = await p.$$eval('#modal .pay-m', x => x.map(y => y.dataset.m + (y.disabled ? '!' : ''))); check('store methods; credit and account off without a customer', R.methods.join() === 'cash,card,eft,voucher,storeCredit!,account!', R.methods);
R.cashDue = await p.locator('#modal .pay-cash .muted').innerText(); check('cash due rounded to 10c', /Cash due R 319\.00 \(rounded from R 318\.99\)/.test(R.cashDue), R.cashDue);
await p.fill('#py-tendered', '1000'); await p.waitForTimeout(100); R.change = await p.locator('#py-change').innerText(); check('live change', R.change === 'Change R 681.00', R.change);
await p.click('[data-add=cash]'); await p.waitForTimeout(200);
R.pay1b = await payText(); check('cash added: paid in full, change and rounding shown', /Paid in full R 0\.00/i.test(R.pay1b) && /Change R 681\.00/.test(R.pay1b) && /Cash rounding R 0\.01/.test(R.pay1b), R.pay1b);
await p.screenshot({ path: S + '/shots/pos6-pay.png' });
R.done1 = await finish();
check('sale written: number and change in the toast, cart cleared', /Sale BF-000001 · change R 681\.00/.test(R.done1) && /No items yet/.test(await cartText()), R.done1);
let sales = await listColl('sales'); const s1 = sales.find(s => s.docNo === 'BF-000001');
check('the sale in the database: cents, VAT (book zero-rated), rounding, cashier, till', s1 && s1.totalCents === 31899 && s1.roundingCents === 1 && s1.changeCents === 68100 && s1.vatCents === vatIn(19899, 1500) && s1.cashierUid === 'st_cathy' && s1.deviceId === 'dev_pay' && s1.source === 'till', s1);
check('the cushion’s stock level appeared at -1 (none on hand before)', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === -1);

// 2. split: card part, then the rest on store credit, with the customer attached
await scan('6001234567890');
await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', 'thandi'); await p.waitForTimeout(200); await p.click('#cu-list .pk-row'); await p.waitForTimeout(300);
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay');
R.methods2 = await p.$$eval('#modal .pay-m', x => x.map(y => y.dataset.m + (y.disabled ? '!' : ''))); check('with the customer: credit and account on', R.methods2.join() === 'cash,card,eft,voucher,storeCredit,account', R.methods2);
await p.click('[data-m=card]'); await p.fill('#py-amount', '8799'); await p.fill('#py-last4', '4321'); await p.fill('#py-approval', 'OK77'); await p.click('[data-add=card]'); await p.waitForTimeout(200);
R.split1 = await payText(); check('card part added, R 200 still to pay', /Card ••4321 R 8,799\.00/.test(R.split1) && /Still to pay R 200\.00/i.test(R.split1), R.split1);
await p.click('[data-m=storeCredit]'); await p.waitForTimeout(100); R.creditDefault = await p.inputValue('#py-amount'); check('store credit offers the rest (R 200 of R 200 credit)', R.creditDefault === '200.00', R.creditDefault);
await p.click('[data-add=storeCredit]'); await p.waitForTimeout(200); R.done2 = await finish();
check('split sale written', /Sale BF-000002/.test(R.done2), R.done2);
const c = await getDoc('pos/retail/customers/c_thandi'); check('store credit used up', c.storeCreditCents === 0, c);
let pays = await listColl('payments'); check('two payment rows on the split sale', pays.filter(x => x.docNo === 'BF-000002').map(x => x.method).sort().join() === 'card,storeCredit' && pays.some(x => x.cardLast4 === '4321' && x.approvalCode === 'OK77'), pays.map(x => [x.docNo, x.method]));

// 3. a voucher sold on account, then used on the next sale
await scan('GV500'); await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', 'thandi'); await p.waitForTimeout(200); await p.click('#cu-list .pk-row'); await p.waitForTimeout(300);
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-m=account]'); await p.click('[data-add=account]'); await p.waitForTimeout(200); R.done3 = await finish();
const vouchers = await listColl('vouchers'); const gv = vouchers[0];
check('voucher created on the account sale', /Sale BF-000003/.test(R.done3) && gv && gv.balanceCents === 50000 && gv.status === 'open' && (await getDoc('pos/retail/customers/c_thandi')).accountBalanceCents === 50000, { done: R.done3, gv });
await scan('9780000000001');   // the R 120 book
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-m=voucher]'); await p.fill('#py-code', gv.id.toLowerCase()); await p.click('[data-add=voucher]'); await p.waitForTimeout(600);
R.gvUse = await payText(); check('voucher covers the book', new RegExp('Voucher ' + gv.id + ' R 120\\.00').test(R.gvUse) && /Paid in full/i.test(R.gvUse), R.gvUse);
R.done4 = await finish();
check('voucher balance down to R 380', /Sale BF-000004/.test(R.done4) && (await getDoc('pos/retail/vouchers/' + gv.id)).balanceCents === 38000, R.done4);

// 4. EFT awaiting; a tender can be removed before completing
await scan('6002222222222');
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-m=card]'); await p.click('[data-add=card]'); await p.waitForTimeout(200);
await p.click('#modal [data-rm="0"]'); await p.waitForTimeout(200); check('a tender can be taken off again', /Still to pay R 198\.99/i.test(await payText()));
await p.click('[data-m=eft]'); await p.fill('#py-ref', 'EFT-9'); await p.selectOption('#py-status', 'awaiting'); await p.click('[data-add=eft]'); await p.waitForTimeout(200);
check('EFT awaiting shown', /EFT \(awaiting\)/.test(await payText()));
R.done5 = await finish();
sales = await listColl('sales'); const s5 = sales.find(s => s.docNo === 'BF-000005');
check('EFT sale written as awaiting', s5 && s5.paidStatus === 'awaiting' && s5.paymentMethods.join() === 'eft', s5 && s5.paidStatus);
check('five sales numbered 1..5 from the till’s block', sales.map(s => s.seq).sort().join() === '1,2,3,4,5' && sales.every(s => s.blockId.includes('dev_pay')), sales.map(s => [s.seq, s.blockId]));
const audit = await listColl('auditLog'); check('each sale audited', audit.filter(a => a.action === 'sale.commit').length === 5);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 5000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
