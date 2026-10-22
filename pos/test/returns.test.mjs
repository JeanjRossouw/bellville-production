// Retail POS step 10 in the browser: the Returns tab on a till as a
// cashier. A sale, then a part return found by scanning the receipt number,
// refunded in cash, the credit note printed; a return without a receipt
// with a manager's PIN as store credit; an exchange with the current cart.
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
const pinRec = (pin) => { const salt = '56'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') }); await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, returns: { windowDays: 7, reasons: ['Changed mind', 'Faulty', 'Wrong item'] }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'rt-secret-' + Date.now();
await put('pos/retail/devices/dev_rt', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_rt') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c_thandi', { name: 'Thandi Mokoena', contact: 'Thandi', phone: '0825550101', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.open = () => { const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_rt', secret, label: 'Front till', entityId: 'BF', storeId: 'BF-BELL', registerId: '' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const nav = async (v) => { await p.click('#nav [data-view=' + v + ']'); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
// a sale: 2 cushions and a lamp, cash
await scan('CUSH'); await scan('CUSH'); await scan('LAMP');
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-add=cash]'); await p.waitForTimeout(200); await p.click('#modal-ok'); await toast(); await p.waitForTimeout(900); await closeModal();

// ---- Returns: find by scanning the receipt number, return 1 cushion
await nav('returns');
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Returns tab present', R.nav.includes('returns'), R.nav);
await p.fill('#rt-q', 'BF-000001'); await p.press('#rt-q', 'Enter'); await p.waitForSelector('.rt-tbl', { timeout: 10000 });
R.found = await screenText(); check('the sale is shown with its lines and what was paid each', /BF-000001 · R 898\.00/.test(R.found) && /Scatter Cushion 2 R 199\.00/.test(R.found) && /Lamp 1 R 500\.00/.test(R.found), R.found.slice(0, 300));
await p.click('[data-act=rt-qty][data-line="1"][data-d="1"]'); await p.waitForTimeout(200);
await p.selectOption('[data-rt-reason="1"]', 'Faulty'); await p.selectOption('[data-rt-disp="1"]', 'quarantine'); await p.waitForTimeout(200);
R.credit = await screenText(); check('the credit shows: 1 cushion, R 199, VAT reversed R 25.96', /Scatter Cushion × 1 · Faulty · Quarantine/.test(R.credit) && /VAT reversed R 25\.96/.test(R.credit) && /Credit note total R 199\.00/i.test(R.credit), R.credit.slice(-300));
check('the + stops at what was sold', await p.locator('[data-act=rt-qty][data-line="1"][data-d="1"]').isEnabled() && !(await p.locator('[data-act=rt-qty][data-line="1"][data-d="1"]').evaluate(async (el) => { el.click(); await new Promise(r => setTimeout(r, 200)); return document.querySelector('[data-act=rt-qty][data-line="1"][data-d="1"]').disabled === false; })));
await p.click('[data-act=rt-qty][data-line="1"][data-d="-1"]'); await p.waitForTimeout(200);   // back to 1
await p.click('[data-act=rt-refund]'); await p.waitForSelector('#modal #rf-cash');
check('cash refund prefilled with the credit', (await p.inputValue('#rf-cash')) === '199.00');
await p.click('#modal-ok'); R.cn = await toast(); await p.waitForTimeout(1200);
check('credit note issued', /Credit note BF-CN-000001/.test(R.cn), R.cn);
await p.waitForSelector('#modal .rc-paper'); R.cnReceipt = await p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
check('the credit note prints: title, against the sale, the line, VAT, the refund', /CREDIT NOTE/.test(R.cnReceipt) && /Against BF-000001/.test(R.cnReceipt) && /Scatter Cushion/.test(R.cnReceipt) && /Faulty · quarantine/.test(R.cnReceipt) && /VAT 15% R 25\.96/.test(R.cnReceipt) && /Refund: Cash R 199\.00/.test(R.cnReceipt) && /BF-CN-000001/.test(R.cnReceipt), R.cnReceipt);
await p.screenshot({ path: S + '/shots/pos10-creditnote.png' });
await closeModal();
const lv = await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion'); check('the cushion went to quarantine: on hand 8, quarantine 1', lv.onHandQty === 8 && lv.quarantineQty === 1, lv);

// ---- without a receipt: a lamp as store credit for Thandi, with Mandla's PIN
await p.click('[data-act=rt-noreceipt]'); await p.waitForSelector('#rt-nr-cust');
await p.selectOption('#rt-nr-cust', 'c_thandi'); await p.fill('#rt-nr-q', 'lamp'); await p.waitForTimeout(200); await p.click('#rt-nr-hits .pk-row'); await p.waitForTimeout(300);
R.nr = await screenText(); check('the lamp listed at today’s price, quarantine by default', /Lamp R 500\.00/.test(R.nr) && /Store credit R 500\.00/i.test(R.nr), R.nr.slice(-300));
await p.click('[data-act=rt-refund]'); await p.waitForSelector('#modal .pinpad');
await pinType('#modal', '111111'); R.nrOwn = await p.locator('#modal .pin-msg').innerText(); check('the cashier’s own PIN cannot approve', /cashier|own/.test(R.nrOwn), R.nrOwn);
await pinType('#modal', '222222'); R.nrDone = await toast(); await p.waitForTimeout(1200);
check('credit note 2 issued as store credit', /Credit note BF-CN-000002/.test(R.nrDone), R.nrDone);
await closeModal();
check('Thandi has R 500 store credit', (await getDoc('pos/retail/customers/c_thandi')).storeCreditCents === 50000);
const notes = await listColl('creditNotes'); check('the second note: no receipt, approver Mandla', notes.some(n => n.noReceipt && n.approvers.some(a => a.name === 'Mandla') && n.refunds[0].method === 'storeCredit'), notes.map(n => [n.docNo, n.noReceipt]));

// ---- an exchange: the lamp from the sale (R 500) for two cushions (R 398): R 102 back in cash
await nav('sell'); await scan('CUSH'); await scan('CUSH');
await nav('returns'); await p.fill('#rt-q', 'BF-000001'); await p.press('#rt-q', 'Enter'); await p.waitForSelector('.rt-tbl');
R.again = await screenText(); check('line 1 shows 1 returned before', /1 returned before/.test(R.again), R.again.slice(0, 300));
await p.click('[data-act=rt-qty][data-line="2"][data-d="1"]'); await p.waitForTimeout(200);
R.exBtn = await p.locator('[data-act=rt-exchange]').innerText(); check('exchange button names the cart', /Exchange with the current cart \(2 · R 398\.00\)/i.test(R.exBtn), R.exBtn);
await p.click('[data-act=rt-exchange]'); await p.waitForSelector('#modal #ex-method');
R.exModal = await p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ')); check('the exchange modal: refund R 102', /Refund to the customer R 102\.00/.test(R.exModal), R.exModal.slice(0, 200));
await p.click('#modal-ok'); R.exDone = await toast(); await p.waitForTimeout(1500);
check('credit note 3 and exchange sale 2', /Credit note BF-CN-000003 · exchange sale BF-000002/.test(R.exDone), R.exDone);
await closeModal(); await closeModal();
const sales = await listColl('sales'); const s2 = sales.find(s => s.docNo === 'BF-000002');
check('the new sale paid by the credit note; the cart is empty', s2 && s2.paymentMethods.join() === 'creditNote' && s2.exchangeOf === 'BF-CN-000003' && s2.totalCents === 39800, s2 && { m: s2.paymentMethods, x: s2.exchangeOf });
await nav('sell'); check('cart cleared after the exchange', /No items yet/.test(await p.locator('.pos-right').innerText()));

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 5000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
