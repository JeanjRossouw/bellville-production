// Retail POS step 11 in the browser: a lay-by from the cart as a cashier
// (deposit, schedule, the agreement with the penalty shown, the customer's
// signature drawn on the screen), the Lay-bys tab, an instalment with its
// receipt, collection into a tax invoice and a collection slip, and a
// cancellation with the penalty breakdown that needs a manager's PIN.
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
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, layby: { minDepositPct: 20, termDays: 90, penaltyPct: 1, frequency: 'monthly', reminderDays: 3 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'lb-secret-' + Date.now();
await put('pos/retail/devices/dev_lb', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_lb') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 3, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c_thandi', { name: 'Thandi Mokoena', contact: 'Thandi', phone: '0825550101', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__opened = []; window.open = (u) => { if (u) { window.__opened.push(u); return { focus() {}, close() {} }; } const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_lb', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const modalText = () => p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };
const pickThandi = async () => { await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', '0825'); await p.waitForTimeout(250); await p.click('#cu-list .pk-row'); await p.waitForTimeout(300); };
const sign = async (sel) => { const box = await p.locator(sel).boundingBox(); await p.mouse.move(box.x + 20, box.y + 60); await p.mouse.down(); await p.mouse.move(box.x + 120, box.y + 40, { steps: 8 }); await p.mouse.move(box.x + 200, box.y + 90, { steps: 8 }); await p.mouse.up(); };

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Lay-bys tab present', R.nav.includes('laybys'), R.nav);

// ---- a lay-by from the cart: 2 cushions for Thandi
await scan('CUSH'); await scan('CUSH');
await p.click('[data-act=sl-layby]'); R.noCust = await toast(); check('a lay-by needs the customer first', /customer/.test(R.noCust), R.noCust);
await pickThandi();
await p.click('[data-act=sl-layby]'); await p.waitForSelector('#modal #lb-pad');
R.newModal = await modalText();
check('deposit prefilled at 20%, schedule and the terms shown', (await p.inputValue('#lb-dep')) === '79.60' && /Instalment 1 by/.test(R.newModal) && /Instalment 3 by/.test(R.newModal) && /section 62 of the Consumer Protection Act/.test(R.newModal) && /penalty of 1% of the full price \(R 3\.98\)/.test(R.newModal) && /death or hospitalisation/.test(R.newModal), R.newModal.slice(0, 600));
await p.fill('#lb-dep', '100'); await p.fill('#lb-given', '100'); await p.waitForTimeout(200);
R.sched = await p.locator('#lb-sched').innerText().then(t => t.replace(/\s+/g, ' ')); check('the schedule follows the deposit: R 298 left', /Deposit R 100\.00/.test(R.sched) && /Balance after the deposit R 298\.00/.test(R.sched), R.sched);
await p.click('#modal-ok'); R.needTick = await toast(); check('must tick that the customer agrees', /Tick/.test(R.needTick), R.needTick);
await p.check('#lb-accept'); await p.click('#modal-ok'); R.needSign = await toast(); check('must sign', /signs in the box/.test(R.needSign), R.needSign);
await sign('#lb-pad');
await p.click('#modal-ok'); R.opened = await toast(); await p.waitForTimeout(1500);
check('lay-by opened', /Lay-by BF-LB-000001 opened/.test(R.opened), R.opened);
await p.waitForSelector('#modal .rc-paper'); R.agreement = await p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
check('the agreement prints with the goods, the plan, the penalty and the signature', /LAY-BY AGREEMENT/.test(R.agreement) && /Scatter Cushion/.test(R.agreement) && /Deposit paid R 100\.00/.test(R.agreement) && /Balance R 298\.00/.test(R.agreement) && /1% of the full price \(R 3\.98\)/.test(R.agreement) && /Signed: Thandi Mokoena/.test(R.agreement) && /BF-LB-000001/.test(R.agreement), R.agreement.slice(0, 500));
R.sigImg = await p.locator('#modal .rc-paper .sig img').count(); check('the signature image is on it', R.sigImg === 1);
await closeModal();
check('the cart is cleared', /No items yet/.test(await p.locator('.pos-right').innerText()));
const lb1 = (await listColl('laybys'))[0];
check('stock reserved: 2 cushions', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).reservedQty === 2 && lb1 && lb1.agreement.signature.startsWith('data:image/png;base64,'), lb1 && lb1.agreement.signedBy);

// ---- the tab: the lay-by listed; an instalment for the whole balance
await nav('laybys');
R.tab = await screenText(); check('listed as open, on track, R 298 balance', /BF-LB-000001/.test(R.tab) && /Thandi Mokoena/.test(R.tab) && /R 298\.00/.test(R.tab) && /On track/i.test(R.tab) && /1 open/.test(R.tab), R.tab.slice(0, 400));
check('no report button for a cashier', (await p.locator('[data-act=lb-report]').count()) === 0);
await p.click('[data-act=lb-open]'); await p.waitForSelector('#modal .lb-detail');
R.detail = await modalText(); check('the detail: schedule, deposit, agreement signed', /Deposit R 100\.00/.test(R.detail) && /1\. by/.test(R.detail) && /Agreement signed by Thandi Mokoena/.test(R.detail) && /Take a payment/i.test(R.detail), R.detail.slice(0, 400));
await p.click('[data-act=lb-pay]'); await p.waitForSelector('#modal #lp-amount');
await p.click('[data-lp="29800"]'); await p.fill('#lp-given', '300'); await p.waitForTimeout(150);
R.change = await p.locator('#lp-change').innerText(); check('change worked out', /Change R 2\.00/.test(R.change), R.change);
await p.click('#modal-ok'); R.paid = await toast(); await p.waitForTimeout(1500);
check('paid in full, ready to collect', /Paid R 298\.00 on BF-LB-000001/.test(R.paid) && /change R 2\.00/.test(R.paid) && /ready to collect/.test(R.paid), R.paid);
await p.waitForSelector('#modal .rc-paper'); R.payslip = await p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
check('the instalment receipt', /LAY-BY PAYMENT/.test(R.payslip) && /Lay-by BF-LB-000001 · Thandi Mokoena/.test(R.payslip) && /Paid now R 298\.00/.test(R.payslip) && /Balance R 0\.00/.test(R.payslip) && /Paid in full/.test(R.payslip) && /Cash R 300\.00/.test(R.payslip) && /Change R 2\.00/.test(R.payslip), R.payslip);
await closeModal();
R.tab2 = await screenText(); check('now ready to collect', /Ready to collect/i.test(R.tab2) && /R 0\.00/.test(R.tab2), R.tab2.slice(0, 300));

// ---- collection: the tax invoice and the collection slip
await p.click('[data-act=lb-open]'); await p.waitForSelector('#modal .lb-detail');
await p.click('[data-act=lb-collect]'); R.collected = await toast(); await p.waitForTimeout(1500);
check('collected into tax invoice BF-000001', /Collected: tax invoice BF-000001/.test(R.collected), R.collected);
await p.waitForSelector('#modal .rc-paper'); R.inv = await p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
check('the tax invoice: the goods, VAT, paid by the lay-by', /TAX INVOICE/.test(R.inv) && /BF-000001/.test(R.inv) && /Scatter Cushion 2 × R 199\.00/.test(R.inv) && /VAT 15% R 51\.91/.test(R.inv) && /Lay-by R 398\.00/.test(R.inv), R.inv);
await p.click('#modal .rc-acts button:has-text("Collection slip")'); await p.waitForTimeout(500);
R.slip = await p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
check('the collection slip with a line to sign', /COLLECTION SLIP/.test(R.slip) && /Scatter Cushion/.test(R.slip) && /Paid in full R 398\.00/.test(R.slip) && /Tax invoice BF-000001/.test(R.slip) && /received the goods above in good order/.test(R.slip) && /Signature:/.test(R.slip), R.slip);
await closeModal();
check('stock: 8 on hand, none reserved', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 8 && (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).reservedQty === 0);
R.tab3 = await screenText(); check('collected lay-bys leave the open list', !/BF-LB-000001/.test(R.tab3) && /No open lay-bys/i.test(R.tab3), R.tab3.slice(0, 200));

// ---- a second lay-by, cancelled: the penalty breakdown, a manager's PIN for the cashier
await nav('sell'); await scan('LAMP'); await pickThandi();
await p.click('[data-act=sl-layby]'); await p.waitForSelector('#modal #lb-pad');
await p.check('#lb-accept'); await sign('#lb-pad'); await p.click('#modal-ok'); R.opened2 = await toast(); await p.waitForTimeout(1500); await closeModal();
check('second lay-by with the default R 100 deposit', /BF-LB-000002/.test(R.opened2), R.opened2);
await nav('laybys'); await p.click('[data-act=lb-open]'); await p.waitForSelector('#modal .lb-detail');
await p.click('[data-act=lb-cancel]'); await p.waitForSelector('#modal #lc-kind');
R.breakdown = await p.locator('#lc-break').innerText().then(t => t.replace(/\s+/g, ' '));
check('the breakdown: 1% of R 500 = R 5 penalty, R 95 back', /Full price R 500\.00/.test(R.breakdown) && /Paid in R 100\.00/.test(R.breakdown) && /Penalty agreed: 1% of the full price R 5\.00/.test(R.breakdown) && /Penalty charged R 5\.00/.test(R.breakdown) && /To refund R 95\.00/.test(R.breakdown), R.breakdown);
await p.selectOption('#lc-kind', 'death'); await p.waitForTimeout(150);
R.breakdown2 = await p.locator('#lc-break').innerText().then(t => t.replace(/\s+/g, ' ')); check('death: no penalty, all R 100 back', /Waived no penalty on the death/.test(R.breakdown2) && /Penalty charged R 0\.00/.test(R.breakdown2) && /To refund R 100\.00/.test(R.breakdown2), R.breakdown2);
await p.selectOption('#lc-kind', 'customer'); await p.waitForTimeout(150);
await p.click('#modal-ok'); await p.waitForSelector('#modal .pinpad'); await pinType('#modal', '222222'); R.cancelled = await toast(); await p.waitForTimeout(1500);
check('cancelled with Mandla’s PIN: R 95 refund, R 5 penalty', /BF-LB-000002 cancelled · refund R 95\.00 · penalty R 5\.00/.test(R.cancelled), R.cancelled);
await p.waitForSelector('#modal .rc-paper'); R.cancelDoc = await p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
check('the cancellation statement with the written breakdown', /LAY-BY CANCELLATION/.test(R.cancelDoc) && /The customer cancels/.test(R.cancelDoc) && /Legal cap: 1% of the full price R 5\.00/.test(R.cancelDoc) && /Penalty charged R 5\.00/.test(R.cancelDoc) && /Refunded R 95\.00/.test(R.cancelDoc) && /Refund by Cash R 95\.00/.test(R.cancelDoc) && /regulation 35/.test(R.cancelDoc), R.cancelDoc);
await closeModal();
const lb2 = (await listColl('laybys')).find(l => l.docNo === 'BF-LB-000002');
check('written: cancelled, penalty 500, approver Mandla, lamp released', lb2.status === 'cancelled' && lb2.penaltyCents === 500 && lb2.refundedCents === 9500 && lb2.approvers.some(a => a.name === 'Mandla') && (await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp')).reservedQty === 0, lb2 && [lb2.status, lb2.penaltyCents, lb2.approvers]);
await p.selectOption('#lb-filter', 'cancelled'); await p.waitForTimeout(300);
R.tab4 = await screenText(); check('the cancelled filter shows it', /BF-LB-000002/.test(R.tab4) && /Cancelled/i.test(R.tab4), R.tab4.slice(0, 300));

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
