// Retail POS step 14 in the browser: the Buying tab as a manager on a till —
// a supplier added, a purchase order suggested from low stock, sent (the
// share links), received against with freight spread over the lines, the
// GRV and labels, and a transfer sent to the other store.
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
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL', 'BF-PAROW'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', poPrefix: 'BF-PO', grvPrefix: 'BF-GRV', transferPrefix: 'BF-TR', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, session: { idleLogoutMinutes: 10, pinLength: 6 }, buying: { updateCostsOnReceive: true }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-PAROW') });
const secret = 'by-secret-' + Date.now();
await put('pos/retail/devices/dev_by', { label: 'Back office', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_by') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', sku: 'CU-1', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000, reorderLevel: 5, reorderQty: 10 });
await prod('p_lamp', { name: 'Lamp', sku: 'LA-1', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 3, reservedQty: 0, avgCostCents: 5000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 6, reservedQty: 0, avgCostCents: 20000, ...srv('BF', 'BF-BELL') });
// an open sales order (e.g. brought in from Shopify) wanting 8 lamps; 6 on the shelf, no reorder level on the lamp
await put('pos/retail/specialOrders/shp-1', { docNo: 'BF-SO-000009', status: 'depositPaid', source: 'shopify', lines: [{ lineNo: 1, productId: 'p_lamp', variantId: '', name: 'Lamp', qty: 8, unitPriceCents: 50000 }, { lineNo: 2, productId: '', variantId: '', name: 'Delivery', qty: 1, custom: true }], totalCents: 400000, paidCents: 400000, balanceCents: 0, customerSnapshot: { name: 'Web client' }, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__opened = []; window.open = (u) => { if (u) { window.__opened.push(u); return { focus() {}, close() {} }; } const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_by', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Back office' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept(d.type() === 'prompt' ? 'orders@foam.co.za' : undefined));
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const modalText = () => p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '222222'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Buying tab present', R.nav.includes('buying'), R.nav);

// ---- a supplier
await nav('buying'); await p.click('[data-act=by-sub][data-to=suppliers]'); await p.waitForTimeout(300);
await p.click('[data-act=by-sup-new]'); await p.waitForSelector('#modal #su-name');
await p.fill('#su-name', 'Foam Co'); await p.fill('#su-contact', 'Pete'); await p.fill('#su-phone', '0215550001'); await p.fill('#su-email', 'orders@foam.co.za'); await p.fill('#su-terms', '30'); await p.fill('#su-lead', '7');
await p.click('#modal-ok'); R.sup = await toast(); await p.waitForTimeout(800);
R.supList = await screenText(); check('supplier saved and listed', /Saved Foam Co/.test(R.sup) && /Foam Co/.test(R.supList) && /30 days/.test(R.supList), R.supList.slice(0, 300));
const supId = (await listColl('suppliers'))[0].id;
await fetch(`${docs}/pos/retail/products/p_cushion?updateMask.fieldPaths=supplierId`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { supplierId: { stringValue: supId } } }) }); await p.waitForTimeout(600);

// ---- a purchase order suggested from low stock, sent
await p.click('[data-act=by-sub][data-to=po]'); await p.waitForTimeout(300);
R.poList = await screenText(); check('the low-stock suggestion is offered', /Suggest from low stock \(1\)/i.test(R.poList), R.poList.slice(0, 300));
check('the open-orders option offered: 1 item short', /Order for open orders only \(1\)/i.test(R.poList), R.poList.slice(0, 300));
await p.click('[data-act=by-po-open]'); await p.waitForSelector('#po-supplier');
R.openEdit = await screenText();
check('for open orders only: the lamp (8 wanted, 6 here) → 2; the low cushion left out', /Lamp/.test(R.openEdit) && !/Scatter Cushion/.test(R.openEdit) && (await p.inputValue('[data-po-qty="0"]')) === '2' && /BF-SO-000009/.test(await p.inputValue('#po-note')), R.openEdit.slice(0, 400));
await p.click('[data-act=by-po-close]'); await p.waitForTimeout(300);
await p.click('[data-act=by-po-suggest]'); await p.waitForSelector('#po-supplier');
R.edit = await screenText(); check('the cushion suggested: 10 at R 50', /Scatter Cushion/.test(R.edit) && (await p.inputValue('[data-po-qty="0"]')) === '10' && (await p.inputValue('[data-po-cost="0"]')) === '50.00' && /Subtotal \(ex VAT\) R 500\.00/.test(R.edit), R.edit.slice(0, 400));
await p.fill('#po-add', 'lamp'); await p.waitForTimeout(250); await p.click('#po-hits .pk-row'); await p.waitForTimeout(300);
await p.fill('[data-po-qty="1"]', '2'); await p.dispatchEvent('[data-po-qty="1"]', 'change'); await p.waitForTimeout(300);
R.edit2 = await screenText(); check('the lamp added, 2 at R 200: subtotal R 900', /Lamp/.test(R.edit2) && /Subtotal \(ex VAT\) R 900\.00/.test(R.edit2), R.edit2.slice(0, 500));
await p.selectOption('#po-supplier', supId); await p.fill('#po-expected', '2026-11-01'); await p.fill('#po-note', 'Before 10 please');
await p.click('[data-act=by-po-send]'); R.sent = await toast(); await p.waitForSelector('#modal [data-sh=mail]');
check('sent as BF-PO-000001', /Sent: BF-PO-000001/.test(R.sent), R.sent);
await p.click('#modal [data-sh=mail]'); await p.waitForTimeout(800);
R.opened = await p.evaluate(() => window.__opened); check('the email carries the link to the PO page', R.opened.length === 1 && /^mailto:orders%40foam\.co\.za/.test(R.opened[0]) && /pos-doc/.test(decodeURIComponent(R.opened[0])) && /BF-PO-000001/.test(decodeURIComponent(R.opened[0])), R.opened);
await p.click('#modal [data-sh=print]'); await p.waitForTimeout(400);
R.printed = await p.evaluate(() => window.__printed); check('the A4 order printed', R.printed.length === 1 && /Purchase order/.test(R.printed[0]) && /Foam Co/.test(R.printed[0]) && /1,035\.00/.test(R.printed[0]), R.printed.length);
await closeModal();
R.poList2 = await screenText(); check('listed as sent, R 1,035', /BF-PO-000001/.test(R.poList2) && /Sent/i.test(R.poList2) && /R 1,035\.00/.test(R.poList2), R.poList2.slice(0, 300));
check('on order in the levels', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onOrderQty === 10);

// ---- receive against it: 6 cushions and both lamps, freight R 70
await p.click('[data-act=by-sub][data-to=receive]'); await p.waitForTimeout(300);
await p.click('[data-act=by-rcv-po]'); await p.waitForSelector('#rc-inv');
await p.fill('[data-rc-qty="0"]', '6'); await p.dispatchEvent('[data-rc-qty="0"]', 'change'); await p.waitForTimeout(200);
await p.fill('#rc-freight', '70'); await p.dispatchEvent('#rc-freight', 'change'); await p.waitForTimeout(300);
R.rcv = await screenText(); check('landed each shown: cushion R 55.00, lamp R 220.00 (freight by value); into stock R 770', /Landed costs R 70\.00/.test(R.rcv) && /Into stock R 770\.00/.test(R.rcv) && /R 55\.00/.test(R.rcv) && /R 220\.00/.test(R.rcv), R.rcv.slice(0, 700));
await p.fill('#rc-inv', 'INV-9'); await p.click('[data-act=by-rcv-go]'); R.received = await toast(); await p.waitForSelector('#modal [data-act=by-grv-labels]');
check('received: GRV 1, part received, costs updated', /Received: BF-GRV-000001 · order part received · 2 costs updated/.test(R.received), R.received);
await p.click('#modal [data-act=by-grv-labels]'); await p.waitForSelector('#modal #lb-copies');
R.labels = await modalText(); check('labels for what came in: 2 labels (as received)', /2 labels/.test(R.labels), R.labels);
await p.click('#modal-ok'); await p.waitForTimeout(400);
R.printed2 = await p.evaluate(() => window.__printed); check('8 labels printed: 6 cushions and 2 lamps', (R.printed2[1].match(/class="lbl"/g) || []).length === 8, R.printed2.length);
check('levels: cushion 9 on hand, 4 on order; the product cost moved', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 9 && (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onOrderQty === 4 && (await getDoc('pos/retail/products/p_cushion')).costCents === Math.round((3 * 5000 + 6 * 5500) / 9));
R.grvList = await screenText(); check('the GRV listed', /BF-GRV-000001/.test(R.grvList) && /inv INV-9/.test(R.grvList) && /R 770\.00/.test(R.grvList), R.grvList.slice(0, 300));

// ---- a transfer to Parow
await p.click('[data-act=by-sub][data-to=transfers]'); await p.waitForTimeout(300);
await p.click('[data-act=by-tr-new]'); await p.waitForSelector('#tr-to');
await p.selectOption('#tr-to', 'BF-PAROW'); await p.fill('#tr-add', 'LAMP'); await p.press('#tr-add', 'Enter'); await p.waitForTimeout(300);
await p.fill('[data-tr-qty="0"]', '3'); await p.dispatchEvent('[data-tr-qty="0"]', 'change'); await p.waitForTimeout(400); await p.click('[data-act=by-tr-send]'); R.trSent = await toast(); await p.waitForTimeout(1200);
check('transfer sent', /Sent BF-TR-000001 to Parow/.test(R.trSent), R.trSent);
R.trList = await screenText(); check('listed as outgoing, in transit', /Outgoing/i.test(R.trList) && /BF-TR-000001/.test(R.trList) && /In transit/i.test(R.trList) && /Parow/.test(R.trList), R.trList.slice(0, 400));
check('lamps left Bellville: 8 − 3 = 5', (await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp')).onHandQty === 5);
R.printed3 = await p.evaluate(() => window.__printed); check('the transfer note printed', /Stock transfer/.test(R.printed3[R.printed3.length - 1]) && /BF-TR-000001/.test(R.printed3[R.printed3.length - 1]));

// ---- suppliers from a CSV: the old ReptiCube POS's "Download for the new POS"
await nav('buying'); await p.click('[data-act=by-sub][data-to=suppliers]'); await p.waitForTimeout(300);
const csv = '\ufeffName,Phone,Email,Owing,Unpaid GRVs\r\nAkwa,,alex@akwa.co.za,0.00,\r\nRSK Reef,,rskreef@hotmail.com,5961.95,GRV-20261001-003 inv 7781 R5961.95\r\nfoam co,021 555 9999,other@foam.co.za,0.00,\r\n';
const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-act=by-sup-import]')]);
await chooser.setFiles({ name: 'repticube-suppliers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await p.waitForSelector('#modal .tbl');
R.imp = await p.locator('#modal').innerText();
check('the import shows what it will do first: two new, Foam Co already here, R 5,961.95 owed', /2 new/.test(R.imp) && /already here/i.test(R.imp) && /5[ ,]?961\.95/.test(R.imp) && /GRV-20261001-003/.test(R.imp), R.imp.slice(0, 500));
await p.click('#modal-ok'); R.impToast = await toast(); await p.waitForTimeout(800);
R.sups = await listColl('suppliers');
const rsk = R.sups.find(x => x.name === 'RSK Reef'), foam = R.sups.filter(x => /foam co/i.test(x.name));
check('imported: Akwa and RSK Reef added to this company, RSK Reef with what was owed; Foam Co not doubled and kept its own phone', R.sups.some(x => x.name === 'Akwa' && x.email === 'alex@akwa.co.za' && x.entityId === 'BF') && rsk && rsk.openingOwedCents === 596195 && /Owed R ?5[ ,]?961\.95 when moved over/.test(rsk.notes) && foam.length === 1 && foam[0].phone === '0215550001', [R.impToast, R.sups.map(x => [x.name, x.openingOwedCents, x.phone])]);
check('the list shows the opening balance', /Owed when moved over: R ?5[ ,]?961\.95/.test(await screenText()));

console.log(JSON.stringify({ fails, errs, ...R, printed: undefined, printed2: undefined, printed3: undefined }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
