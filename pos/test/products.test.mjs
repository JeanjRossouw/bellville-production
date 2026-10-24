// Retail POS step 4: the product manager. Emulators + server.mjs.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const su = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.co.za', password: 'secret123' }) })).json();
await put('pos/retail/users/' + su.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/entities/RC', { legalName: 'ReptiCube', tradingName: 'ReptiCube', vatRegistered: false, vatNo: '', invoicePrefix: 'RC', active: true, ...srv('RC') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/settings/RC', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('RC') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-PAROW') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript(() => { window.__printed = []; window.open = () => { const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login:not([hidden])'); await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(600);
await p.evaluate(() => document.querySelector('#nav [data-view=products]').click()); await p.waitForTimeout(500);
check('empty list', /No products yet/i.test(await p.locator('#screen').innerText()));

// ---- a simple product with a live margin
await p.click('[data-act=pr-new]'); await p.waitForSelector('#modal .pf');
await p.fill('#pf-name', '3 Seater Chesterfield'); await p.fill('#pf-sku', 'CH-3'); await p.fill('#pf-barcodes', '6001234567890'); await p.fill('#pf-cat', 'Sofas'); await p.fill('#pf-brand', 'Bellville');
await p.fill('#pf-cost', '4000'); await p.fill('#pf-price', '9200'); await p.waitForTimeout(100);
R.margin = await p.locator('#pf-margin').innerText(); check('margin shows live: 9200 incl at 15% = 8000 ex, cost 4000 → 50%', R.margin === '50%', R.margin);
await p.selectOption('#pf-vat', 'zero'); await p.waitForTimeout(100); R.marginZero = await p.locator('#pf-margin').innerText(); check('zero-rated: margin on the full price', R.marginZero === '56.5%', R.marginZero);
await p.selectOption('#pf-vat', 'standard');
await p.fill('[data-sp="BF-PAROW"]', '8999'); await p.fill('#pf-reorder', '2');
await p.click('#modal-ok'); R.add1 = await toast(); check('product added', /added/.test(R.add1), R.add1);
await p.waitForTimeout(600);
let prods = await listColl('products');
const ch = prods.find(x => x.name === '3 Seater Chesterfield');
check('stored in cents with store price, stamps, no variants', ch && ch.priceCents === 920000 && ch.costCents === 400000 && ch.storePrices['BF-PAROW'] === 899900 && ch.barcodes[0] === '6001234567890' && ch.hasVariants === false && ch.entityId === 'BF' && ch.createdBy === su.localId && ch.reorderLevel === 2, ch);
R.row = await p.locator('.pr-tbl tbody tr').first().innerText().then(t => t.replace(/\s+/g, ' '));
check('listed with price, margin and per-store note', /3 Seater Chesterfield.*CH-3.*6001234567890.*Sofas.*R 4,000\.00.*R 9,200\.00.*per store.*50%/.test(R.row), R.row);

// ---- a product with variants (2 options → 4), barcodes on variants
await p.click('[data-act=pr-new]'); await p.waitForSelector('#modal .pf');
await p.fill('#pf-name', 'Wingback Chair'); await p.fill('#pf-sku', 'WB'); await p.fill('#pf-cat', 'Chairs'); await p.fill('#pf-cost', '1500'); await p.fill('#pf-price', '3499');
await p.fill('#pf-opt0-name', 'Colour'); await p.fill('#pf-opt0-vals', 'Grey, Navy'); await p.fill('#pf-opt1-name', 'Leg'); await p.fill('#pf-opt1-vals', 'Oak, Black');
await p.click('[data-act=pr-gen]'); await p.waitForTimeout(100);
R.varRows = await p.$$eval('#pf-variants tbody tr strong', x => x.map(y => y.innerText)); check('four variants built', R.varRows.join('|') === 'Grey / Oak|Grey / Black|Navy / Oak|Navy / Black', R.varRows);
const vr = p.locator('#pf-variants tbody tr');
await vr.nth(0).locator('[data-vsku]').fill('WB-GO'); await vr.nth(0).locator('[data-vbar]').fill('20000001'); await vr.nth(3).locator('[data-vprice]').fill('3799'); await vr.nth(3).locator('[data-vsku]').fill('WB-NB');
await p.click('#modal-ok'); R.add2 = await toast(); check('variant product added', /added/.test(R.add2), R.add2);
await p.waitForTimeout(700);
prods = await listColl('products'); let vars = await listColl('variants');
const wb = prods.find(x => x.name === 'Wingback Chair');
check('product has options and hasVariants', wb && wb.hasVariants && wb.options.length === 2 && wb.options[1].values.join() === 'Oak,Black', wb && wb.options);
check('four variant records, one with its own price', vars.filter(v => v.productId === wb.id).length === 4 && vars.some(v => v.sku === 'WB-NB' && v.priceCents === 379900) && vars.some(v => v.sku === 'WB-GO' && v.priceCents === null && v.barcodes[0] === '20000001'), vars.map(v => [v.sku, v.priceCents]));
// a clashing barcode is refused
await p.click('[data-act=pr-new]'); await p.waitForSelector('#modal .pf');
await p.fill('#pf-name', 'Clash'); await p.fill('#pf-price', '10'); await p.fill('#pf-barcodes', '20000001'); await p.click('#modal-ok'); R.clash = await toast(); check('a barcode used by another item is refused', /already belongs to Wingback Chair/.test(R.clash), R.clash);
await p.click('#modal [data-close]'); await p.waitForTimeout(200);

// ---- edit: price change → audit; search and filters
await p.click('[data-act=pr-edit][data-id="' + ch.id + '"]'); await p.waitForSelector('#modal .pf');
await p.fill('#pf-price', '9500'); await p.click('#modal-ok'); await toast(); await p.waitForTimeout(600);
const audit = await listColl('auditLog');
const priceRow = audit.find(a => a.action === 'product.price');
check('a price change is audited before and after', priceRow && priceRow.details.before.priceCents === 920000 && priceRow.details.after.priceCents === 950000 && priceRow.actorUid === su.localId, priceRow && priceRow.details);
await p.fill('#pr-q', 'wb-nb'); await p.waitForTimeout(300); R.search = await p.locator('.pr-tbl tbody tr').count(); check('search finds by a variant SKU', R.search === 1, R.search);
await p.fill('#pr-q', ''); await p.waitForTimeout(300);
await p.selectOption('#pr-cat', 'Sofas'); await p.waitForTimeout(300); R.filt = await p.locator('.pr-tbl tbody tr').count(); check('category filter', R.filt === 1, R.filt);
await p.selectOption('#pr-cat', ''); await p.waitForTimeout(300);
await p.screenshot({ path: S + '/shots/pos4-products.png' });

// ---- export then import a Shopify CSV
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=pr-export]')]);
const csvPath = await dl.path(); const csv = fs.readFileSync(csvPath, 'utf8');
const lines = csv.split(/\r?\n/).filter(Boolean);
check('export: Shopify header and one row per variant (1 + 4)', lines[0].startsWith('﻿Handle,Title,Body (HTML),Vendor') && lines.length === 6, lines.length);
check('export carries price in rands, cost per item and option values', /3-seater-chesterfield,3 Seater Chesterfield/.test(csv) && /,9500\.00,/.test(csv) && /Navy,.*Black/.test(csv) && /Cost per item/.test(lines[0]), csv.slice(0, 400));
const shopify = `Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,Variant SKU,Variant Inventory Tracker,Variant Price,Variant Taxable,Variant Barcode,Image Src,Status,Cost per item
leopard-gecko-kit,"Leopard Gecko Starter Kit","<p>Everything for a <b>new gecko</b>.</p>",Exo Terra,Reptile kits,,TRUE,Size,Small,,,,,LGK-S,shopify,1299.00,TRUE,6009876543210,https://cdn.example.com/lgk.jpg,active,750.00
leopard-gecko-kit,,,,,,,,Large,,,,,LGK-L,shopify,1899.00,TRUE,6009876543227,,,1100.00
heat-mat-8w,"Heat Mat 8W",,ProRep,Heating,,TRUE,Title,Default Title,,,,,HM8,shopify,249.00,FALSE,6001112223334,,active,120.00
3-seater-chesterfield,"3 Seater Chesterfield",,,Sofas,,TRUE,Title,Default Title,,,,,CH-3,shopify,9999.00,TRUE,6001234567890,,active,4100.00
`;
await p.selectOption('#pr-entity', 'RC'); await p.waitForTimeout(300);
await p.setInputFiles('#pr-file', { name: 'products_export.csv', mimeType: 'text/csv', buffer: Buffer.from(shopify) });
await p.waitForSelector('#modal'); R.importText = await p.locator('#modal .modal-body').innerText();
check('import preview counts', /3 new, 0 already here/.test(R.importText) && /2 variants/.test(R.importText), R.importText);
await p.click('#modal-ok'); R.imp = await toast(); check('imported', /3 products brought in/.test(R.imp), R.imp);
await p.waitForTimeout(800);
prods = await listColl('products'); vars = await listColl('variants');
const lgk = prods.find(x => x.name === 'Leopard Gecko Starter Kit'), hm = prods.find(x => x.name === 'Heat Mat 8W'), ch2 = prods.find(x => x.name === '3 Seater Chesterfield' && x.entityId === 'RC');
check('gecko kit: RC, brand, category, description without tags, image, cents, two variants', lgk && lgk.entityId === 'RC' && lgk.brand === 'Exo Terra' && lgk.category === 'Reptile kits' && lgk.description === 'Everything for a new gecko.' && lgk.images[0] === 'https://cdn.example.com/lgk.jpg' && lgk.priceCents === 129900 && lgk.costCents === 75000 && lgk.hasVariants && vars.filter(v => v.productId === lgk.id).length === 2 && vars.some(v => v.sku === 'LGK-L' && v.priceCents === 189900 && v.barcodes[0] === '6009876543227'), lgk);
check('heat mat: not taxable → zero-rated, barcode on the product, no variants', hm && hm.vatClass === 'zero' && hm.barcodes[0] === '6001112223334' && !hm.hasVariants && hm.priceCents === 24900, hm);
check('the BF chesterfield was not touched by an RC import; RC got its own', ch2 && ch2.priceCents === 999900 && prods.find(x => x.id === ch.id).priceCents === 950000);
// importing again updates, not duplicates
await p.setInputFiles('#pr-file', { name: 'products_export.csv', mimeType: 'text/csv', buffer: Buffer.from(shopify.replace('1299.00', '1399.00')) });
await p.waitForSelector('#modal'); R.import2 = await p.locator('#modal .modal-body').innerText(); check('second import matches by handle', /0 new, 3 already here/.test(R.import2), R.import2);
await p.click('#modal-ok'); await toast(); await p.waitForTimeout(800);
prods = await listColl('products'); vars = await listColl('variants');
check('re-import updated in place', prods.filter(x => x.entityId === 'RC').length === 3 && prods.find(x => x.id === lgk.id).priceCents === 139900 && vars.filter(v => v.productId === lgk.id).length === 2);

// ---- labels
await p.selectOption('#pr-entity', 'BF'); await p.waitForTimeout(300);
await p.check('#pr-all'); await p.click('[data-act=pr-labels]'); await p.waitForSelector('#modal'); await p.fill('#lb-copies', '2'); await p.click('#modal-ok'); await p.waitForTimeout(300);
R.printed = await p.evaluate(() => window.__printed.length ? window.__printed[0] : '');
R.lblCounts = { labels: (R.printed.match(/class="lbl"/g) || []).length, svgs: (R.printed.match(/<svg/g) || []).length, p9500: /R 9,500\.00/.test(R.printed), navyBlack: /Wingback Chair · Navy \/ Black/.test(R.printed), p3799: /R 3,799\.00/.test(R.printed), sample: R.printed.replace(/<svg[\s\S]*?<\/svg>/g, '[svg]').slice(-500) };
// the chesterfield and two of the four variants carry a code; the other two have none and are left off the sheet
check('label sheet printed: 3 coded items × 2 copies, barcodes as SVG, prices', R.lblCounts.labels === 6 && R.lblCounts.svgs === 6 && R.lblCounts.p9500 && R.lblCounts.navyBlack && R.lblCounts.p3799, R.lblCounts);

// ---- archive
await p.click('[data-act=pr-edit][data-id="' + ch.id + '"]'); await p.waitForSelector('#modal .pf'); await p.check('#pf-archived'); await p.click('#modal-ok'); await toast(); await p.waitForTimeout(500);
R.afterArchive = await p.locator('.pr-tbl tbody tr').count(); check('archived products hide by default', R.afterArchive === 1, R.afterArchive);
await p.check('#pr-archived'); await p.waitForTimeout(300); check('…and show when asked', (await p.locator('.pr-tbl tbody tr').count()) === 2);
check('archive audited', (await listColl('auditLog')).some(a => a.action === 'product.archive'));

console.log(JSON.stringify({ ...R, fails, errs }, null, 1));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
