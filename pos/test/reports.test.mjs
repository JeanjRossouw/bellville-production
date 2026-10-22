// Retail POS step 16 in the browser: as the owner at the office — the
// dashboard on Home, the Reports tab running daily sales with the CSV and
// the print, the staff filter, and the Xero journal built and downloaded.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
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
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('*') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_lamp', { name: 'Lamp', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 0, avgCostCents: 20000, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
// two sales today through the function
const call = async (fn, body) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + own.idToken }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
for (const i of [1, 2]) { const r = await call('pos-sale', { action: 'commit', saleId: 'web-rp-' + i + '-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) }, tenders: [{ method: 'card', amountCents: 50000 }], entityId: 'BF', storeId: 'BF-BELL', registerId: '' }); if (!r.ok) crash(new Error('seed sale: ' + r.error)); }

const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript(() => { window.__printed = []; window.open = () => { const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const nav = async (v) => { await p.click('#nav [data-view=' + v + ']'); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-form'); await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#nav [data-view=reports]'); await p.waitForTimeout(1500);

// ---- the dashboard on Home
await nav('home'); await p.waitForSelector('.dash-card', { timeout: 15000 }); await p.waitForTimeout(300);
R.dash = await screenText(); check('today: R 1 000 over 2 sales, last week nothing', /Today,/i.test(R.dash) && /Bellville/.test(R.dash) && /R 1,000\.00/.test(R.dash) && /2 sales · basket R 500\.00/.test(R.dash) && /Same day last week: R 0\.00/.test(R.dash), R.dash.slice(0, 400));

// ---- Reports: daily sales, CSV, print
await nav('reports'); await p.waitForSelector('[data-act=rp-run]');
R.list = await screenText(); check('the report list', /Daily sales/.test(R.list) && /VAT report/.test(R.list) && /Dead stock/.test(R.list) && /Customers/.test(R.list), R.list.slice(0, 300));
await p.click('[data-act=rp-run]'); await p.waitForSelector('.rp-tbl', { timeout: 15000 });
R.daily = await screenText(); check('daily sales on screen: 2 sales, R 1 000, card R 1 000', /Daily sales/.test(R.daily) && /1 row/.test(R.daily) && /Bellville 2 2 R 1,000\.00 R 0\.00 R 1,000\.00 R 130\.44/.test(R.daily) && /Total/.test(R.daily), R.daily.slice(0, 600));
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=rp-csv]')]);
R.csvName = dl.suggestedFilename(); const csvPath = await dl.path(); const csv = (await import('node:fs')).readFileSync(csvPath, 'utf8');
check('the CSV: a header, the row, the total', /dailySales-BF-/.test(R.csvName) && /Day,Store,Sales/.test(csv) && /Bellville,2,2,1000\.00/.test(csv) && /Total/.test(csv), [R.csvName, csv.slice(0, 200)]);
await p.click('[data-act=rp-print]'); await p.waitForTimeout(400);
R.printed = await p.evaluate(() => window.__printed); check('the A4 print', R.printed.length === 1 && /Daily sales/.test(R.printed[0]) && /1,000\.00/.test(R.printed[0]) && /landscape/.test(R.printed[0]));
await p.click('[data-act=rp-pick][data-to=byProduct]'); await p.waitForTimeout(200); await p.click('[data-act=rp-run]'); await p.waitForSelector('.rp-tbl', { timeout: 15000 });
R.prod = await screenText(); check('by product: the lamp, 2 sold, GP', /Sales by product/.test(R.prod) && /Lamp 2 0 R 1,000\.00/.test(R.prod) && /R 469\.56/.test(R.prod), R.prod.slice(0, 500));
await p.selectOption('#rp-store', 'BF-BELL'); await p.click('[data-act=rp-pick][data-to=lowStock]'); await p.waitForTimeout(200); await p.click('[data-act=rp-run]'); await p.waitForTimeout(1500);
R.low = await screenText(); check('low stock: nothing (no reorder levels)', /Low stock/.test(R.low) && /Nothing in that range/.test(R.low), R.low.slice(0, 300));

// ---- the Xero journal
await p.click('[data-act=rp-sub][data-to=xero]'); await p.waitForSelector('#rp-xday'); await p.waitForTimeout(600);
await p.fill('#rp-xday', new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10)); await p.dispatchEvent('#rp-xday', 'change'); await p.click('[data-act=rp-xero-build]'); R.built = await toast(); await p.waitForTimeout(800);
R.xero = await screenText(); check('the journal built and balanced: R 1 000 each side, sales ex VAT R 869.56, VAT R 130.44, card R 1 000', /Journal built: R 1,000\.00 each side/.test(R.built) && /R 869\.56/.test(R.xero) && /R 130\.44/.test(R.xero) && /Card takings/.test(R.xero) && /Not connected|not set up on this site/.test(R.xero) && /2 invoices/.test(R.xero), R.xero.slice(0, 600));
const [dl2] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=rp-xero-csv]')]);
const xcsv = (await import('node:fs')).readFileSync(await dl2.path(), 'utf8');
check('Xero’s CSV downloaded', /xero-journal-BF-/.test(dl2.suggestedFilename()) && /\*Narration,\*Date/.test(xcsv) && /869\.56|-869\.56/.test(xcsv) && /1000\.00/.test(xcsv), xcsv.slice(0, 200));

console.log(JSON.stringify({ fails, errs, ...R, printed: undefined }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
