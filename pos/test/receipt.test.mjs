// Retail POS step 7: receipts and tax invoices, on a till as a cashier. The
// three kinds by total, the full-invoice address prompt, COPY on a reprint
// from the Sales tab, the barcode, printer bytes, the share link, and an
// invoice for a company that is not VAT registered.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
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
const pinRec = (pin) => { const salt = 'ef'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF', 'RC'], storeIds: ['BF-BELL', 'RC-MAIN'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', regNo: '2010/1/07', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', address: { line1: '12 Voortrekker Rd', city: 'Bellville' }, phone: '021 000 0000', active: true, ...srv('BF') });
await put('pos/retail/entities/RC', { legalName: 'ReptiCube', tradingName: 'ReptiCube', vatRegistered: false, vatNo: '', invoicePrefix: 'RC', active: true, ...srv('RC') });
for (const e of ['BF', 'RC']) await put('pos/retail/settings/' + e, { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, receipt: { header: 'Shop 4, Bellville Mall', footer: 'Thank you!', returnPolicy: '7 days with this receipt.' }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv(e) });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/RC-MAIN', { entityId: 'RC', name: 'ReptiCube', active: true, paymentMethods: ['cash', 'card'], ...srv('RC', 'RC-MAIN') });
const secret = 'rc-secret-' + Date.now();
await put('pos/retail/devices/dev_bf', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_bf') });
await put('pos/retail/devices/dev_rc', { label: 'Reptile till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('RC', 'RC-MAIN', 'dev_rc') });
const prod = (e, id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: false, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], reorderLevel: null, reorderQty: null, archived: false, favourite: true, ...o, ...srv(e) });
await prod('BF', 'p_pen', { name: 'Pen', barcodes: ['PEN'], priceCents: 2500 });
await prod('BF', 'p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900 });
await prod('BF', 'p_ch', { name: '3 Seater Chesterfield', barcodes: ['CHEST'], priceCents: 899900 });
await prod('RC', 'p_gecko', { name: 'Leopard Gecko Kit', barcodes: ['GECKO'], priceCents: 129900 });
await put('pos/retail/customers/c_sipho', { name: 'Sipho Dlamini', contact: 'Sipho', phone: '0835550102', email: 'sipho@example.co.za', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__opened = []; window.open = (url) => { if (url) { window.__opened.push(url); return null; } const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_bf', secret, label: 'Front till', entityId: 'BF', storeId: 'BF-BELL', registerId: '' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept(d.type() === 'prompt' ? '0835550102' : undefined));
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const payCash = async () => { await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-add=cash]'); await p.waitForTimeout(200); await p.click('#modal-ok'); await p.waitForTimeout(1500); };
const receiptText = () => p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const printed = () => p.evaluate(() => window.__printed.pop() || '');

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(800);

// 1. R 25: a till slip
await scan('PEN'); await payCash(); await p.waitForSelector('#modal .rc-paper');
R.slip = await receiptText();
check('≤ R 50: a till slip with the company, VAT no, number, barcode and policy', /TILL SLIP/.test(R.slip) && /VAT no 4123456789/.test(R.slip) && /BF-000001/.test(R.slip) && /7 days with this receipt/.test(R.slip) && (await p.locator('#modal .rc-paper .bar svg').count()) === 1, R.slip);
await p.click('#modal [data-rc=slip]'); await p.waitForTimeout(200); R.slipPrint = await printed(); check('80 mm print page made', /size: 80mm/.test(R.slipPrint) && /BF-000001/.test(R.slipPrint) && !/COPY/.test(R.slipPrint));
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#modal [data-rc=escpos]')]);
const bytes = fs.readFileSync(await dl.path());
check('ESC/POS bytes: init, bold, a Code 128 and a cut', bytes[0] === 27 && bytes[1] === 64 && bytes.includes(27) && Buffer.from(bytes).toString('latin1').includes('BF-000001') && bytes.indexOf(29) >= 0 && bytes[bytes.length - 3] === 86, bytes.length);
await p.screenshot({ path: S + '/shots/pos7-receipt.png' });
await p.click('#modal-ok'); await p.waitForTimeout(300);

// 2. R 199: an abridged tax invoice; share link opens the document page
await scan('CUSH'); await payCash(); await p.waitForSelector('#modal .rc-paper');
R.abridged = await receiptText(); check('R 50.01–R 5 000: a tax invoice with VAT shown', /TAX INVOICE/.test(R.abridged) && /VAT 15%/.test(R.abridged) && /Excl\. VAT/.test(R.abridged) && /BF-000002/.test(R.abridged), R.abridged);
await p.click('#modal [data-rc=copy]'); await p.waitForTimeout(1200);
R.link = await p.locator('#rc-link').innerText().catch(() => ''); check('a share link with a token', /pos-doc\?t=/.test(R.link), R.link);
const page = await (await fetch(R.link)).text(); check('the link serves the invoice page', /Tax invoice/i.test(page) && /BF-000002/.test(page) && /Bellville Furniture/.test(page) && /R 199\.00/.test(page) && !/COPY/.test(page), page.slice(0, 200));
const bad = await (await fetch(R.link.replace(/t=.*$/, 't=nonsense'))).text(); check('a bad token serves nothing', /not valid/.test(bad));
await p.click('#modal [data-rc=wa]'); await p.waitForTimeout(400); R.wa = await p.evaluate(() => window.__opened.pop() || ''); check('WhatsApp link with the text and the link', /wa\.me\/27835550102\?text=/.test(R.wa) && /BF-000002/.test(decodeURIComponent(R.wa)) && /pos-doc/.test(decodeURIComponent(R.wa)), R.wa.slice(0, 120));
await p.click('#modal-ok'); await p.waitForTimeout(300);

// 3. R 8 999: over R 5 000 → a full tax invoice; blocked without a customer, then the address prompt
await scan('CHEST'); await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-add=cash]'); await p.waitForTimeout(200); await p.click('#modal-ok'); R.noCust = await toast();
check('over R 5 000 without a customer: stopped at the till', /full tax invoice.*add the customer/.test(R.noCust), R.noCust);
await p.click('#modal [data-close]'); await p.waitForTimeout(200);
await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', 'sipho'); await p.waitForTimeout(200); await p.click('#cu-list .pk-row'); await p.waitForTimeout(300);
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-add=cash]'); await p.waitForTimeout(200); await p.click('#modal-ok'); await p.waitForSelector('#fi-line1');
// saving the address completes the sale straight away
await p.fill('#fi-line1', '8 Main Rd'); await p.fill('#fi-city', 'Parow'); await p.fill('#fi-vat', '4987654321'); await p.click('#modal-ok'); await p.waitForSelector('#modal .rc-paper', { timeout: 15000 });
R.full = await receiptText(); check('full tax invoice: customer, address, VAT no and reg no on it', /TAX INVOICE/.test(R.full) && /Sipho Dlamini/.test(R.full) && /8 Main Rd, Parow/.test(R.full) && /VAT no 4987654321/.test(R.full) && /Reg no 2010\/1\/07/.test(R.full) && /BF-000003/.test(R.full), R.full);
const sipho = await getDoc('pos/retail/customers/c_sipho'); check('the address was saved on the customer', sipho.address.line1 === '8 Main Rd' && sipho.vatNo === '4987654321', sipho.address);
await p.click('#modal [data-rc=a4]'); await p.waitForTimeout(200); R.a4 = await printed(); check('A4 page with the customer block and barcode', /size: A4/.test(R.a4) && /Invoice to/.test(R.a4) && /Sipho Dlamini/.test(R.a4) && /<svg/.test(R.a4) && !/class="stamp"/.test(R.a4), R.a4.length);
await p.click('#modal-ok'); await p.waitForTimeout(300);

// 4. the Sales tab: today's three, a reprint marked COPY
await p.evaluate(() => document.querySelector('#nav [data-view=sales]').click()); await p.waitForTimeout(800);
R.salesRows = await p.$$eval('#screen .tbl tbody tr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
check('three sales listed, newest first, with their kinds', R.salesRows.length === 3 && /BF-000003 Tax invoice/.test(R.salesRows[0]) && /Sipho Dlamini/.test(R.salesRows[0]) && /BF-000001 Till slip/.test(R.salesRows[2]), R.salesRows);
await p.click('[data-act=sa-open][data-id]'); await p.waitForSelector('#modal .rc-paper'); await p.waitForTimeout(300);
R.copy = await receiptText(); check('a reprint is a COPY', /TAX INVOICE · COPY/.test(R.copy) && /BF-000003/.test(R.copy), R.copy);
await p.click('#modal [data-rc=a4]'); await p.waitForTimeout(200); R.copyA4 = await printed(); check('the A4 copy carries the COPY stamp', /class="stamp">COPY/.test(R.copyA4));
await p.click('#modal-ok'); await p.waitForTimeout(200);
const audit = await listColl('auditLog'); check('prints audited, the copy flagged', audit.filter(a => a.action === 'receipt.print').length >= 4 && audit.some(a => a.action === 'receipt.print' && a.details.copy === true && a.details.how === 'a4'), audit.filter(a => a.action === 'receipt.print').map(a => a.details));

// 5. a company that is not VAT registered: "Invoice", no VAT line, whatever the total
await p.evaluate((dev) => localStorage.setItem('pos-device', JSON.stringify(dev)), { deviceId: 'dev_rc', secret, label: 'Reptile till', entityId: 'RC', storeId: 'RC-MAIN', registerId: '' });
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#app:not([hidden]), #login:not([hidden])', { timeout: 15000 });
if (await p.locator('#login').isVisible()) { await pinType('#login-pin', '111111'); }
await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
await scan('GECKO'); await payCash(); await p.waitForSelector('#modal .rc-paper');
R.invoice = await receiptText(); check('not VAT registered: an Invoice without VAT', /INVOICE/.test(R.invoice) && !/TAX INVOICE/.test(R.invoice) && !/VAT/.test(R.invoice) && /RC-000001/.test(R.invoice) && /R 1,299\.00/.test(R.invoice), R.invoice);
const rcSale = (await listColl('sales')).find(s => s.docNo === 'RC-000001'); check('no VAT on the sale either', rcSale && rcSale.vatCents === 0 && rcSale.vatRegistered === false);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 5000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
