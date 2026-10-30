// Import costs in the browser, through the real rules: the costs sheet out,
// a filled-in sheet back (Excel's semicolons and decimal commas), found by
// SKU, barcode or name; a product with variants takes its variants' lowest
// cost; blanks, unknown and doubtful rows left alone; only costCents
// changes; another company's same SKU untouched; the audit row. Then the
// Shopify product CSV used as a costs file.
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
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
const crash = (e) => { console.log(JSON.stringify({ fails, errs, ...R, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => f.nullValue !== undefined ? null : f.booleanValue !== undefined ? f.booleanValue : f.integerValue !== undefined ? Number(f.integerValue) : f.doubleValue !== undefined ? f.doubleValue : f.stringValue !== undefined ? f.stringValue : f.arrayValue ? (f.arrayValue.values || []).map(fromFs) : f.mapValue ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : undefined;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const one = async (p) => { const r = await (await fetch(`${docs}/pos/retail/${p}`, { headers: H })).json(); return r.fields ? fromFs({ mapValue: { fields: r.fields } }) : null; };
const coll = async (c) => { const r = await (await fetch(`${docs}/pos/retail/${c}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...fromFs({ mapValue: { fields: d.fields } }) })); };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mgr = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mgr@shop.co.za', password: 'secret123', returnSecureToken: true }) })).json();
// written by the server's Shopify pull: its own stamps, not this person's
const st = (e) => ({ entityId: e, storeId: '', createdBy: 'server', createdAt: '2026-10-01T08:00:00.000Z', deviceId: 'office' });
await put('pos/retail/users/' + mgr.localId, { email: 'mgr@shop.co.za', name: 'Mo', role: 'manager', active: true, entityIds: ['RC', 'BF'], storeIds: [], defaultStoreId: '', pinSet: false, ...st('*') });
await put('pos/retail/entities/RC', { legalName: 'ReptiCube', tradingName: 'ReptiCube', vatRegistered: false, invoicePrefix: 'RC', active: true, ...st('RC') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, invoicePrefix: 'BF', active: true, ...st('BF') });
for (const e of ['RC', 'BF']) await put('pos/retail/settings/' + e, { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, session: { idleLogoutMinutes: 30, pinLength: 6 }, ...st(e) });
const prod = (id, e, o) => put('pos/retail/products/' + id, { name: id, description: 'From Shopify', brand: 'ProRep', category: 'Heating', type: 'stock', vatClass: 'zero', trackStock: true, images: ['https://cdn.example.com/' + id + '.jpg', 'https://cdn.example.com/' + id + '-2.jpg'], archived: false, options: [], hasVariants: false, sku: '', barcodes: [], storePrices: {}, bundle: [], shopifyHandle: '', ...o, ...st(e) });
await put('pos/retail/suppliers/sup_akwa', { name: 'Akwa', contact: '', phone: '', email: '', archived: false, ...st('RC') });
await prod('p_mat', 'RC', { name: 'Heat Mat 8W', sku: 'HM8', barcodes: ['6001', '6001-old'], priceCents: 24900, shopifyHandle: 'heat-mat-8w' });          // no costCents at all
await prod('p_kit', 'RC', { name: 'Gecko Kit', priceCents: 129900, costCents: 0, hasVariants: true, options: [{ name: 'Size', values: ['Small', 'Large'] }], shopifyHandle: 'gecko-kit' });
await put('pos/retail/variants/v_s', { productId: 'p_kit', name: 'Small', optionValues: { Size: 'Small' }, sku: 'LGK-S', barcodes: [], priceCents: null, costCents: null, storePrices: {}, archived: false, ...st('RC') });
await put('pos/retail/variants/v_l', { productId: 'p_kit', name: 'Large', optionValues: { Size: 'Large' }, sku: 'LGK-L', barcodes: ['6002'], priceCents: 189900, costCents: null, storePrices: {}, archived: false, ...st('RC') });
await prod('p_lamp', 'RC', { name: 'Basking Lamp', priceCents: 19500, costCents: 10000 });
await prod('p_d1', 'RC', { name: 'Dup A', sku: 'DUP', barcodes: ['7001'], priceCents: 5000, costCents: 0 });
await prod('p_d2', 'RC', { name: 'Dup B', sku: 'DUP', barcodes: ['7002'], priceCents: 5000, costCents: 0 });
await prod('p_uv', 'RC', { name: 'Giangarden UVL601 UVB &UVA LED Fixture Plus', sku: "'10296", priceCents: 87000, costCents: 0 });
await prod('p_th', 'RC', { name: 'Thermo-hygrometer TH32 digital', sku: '', priceCents: 15000, costCents: 0 });
await prod('p_bf', 'BF', { name: 'Heat Mat (furniture shop)', sku: 'HM8', priceCents: 30000, costCents: 9900, vatClass: 'standard' });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
const toast = async () => { await p.waitForTimeout(700); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const txt = (sel) => p.locator(sel).innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-form'); await p.fill('#login-email', 'mgr@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#nav [data-view=products]', { state: 'attached' }); await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelector('#nav [data-view=products]').click()); await p.waitForTimeout(800);
await p.selectOption('#pr-entity', 'RC'); await p.waitForTimeout(500);

// ---- the sheet
await p.click('[data-act=pr-costs]'); await p.waitForSelector('#modal');
R.intro = await txt('#modal .modal-body');
check('the window says the cost changes (prices only when ticked), and VAT included for a company not registered', /The cost changes, and the selling price too/.test(R.intro) && /VAT included/.test(R.intro) && /not VAT registered/.test(R.intro), R.intro);
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-ci=sheet]')]);
R.sheetName = dl.suggestedFilename(); R.sheet = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').split('\r\n');
check('the costs sheet: heading, one row per simple product and per variant (not the kit itself), price and cost now', /^costs-RC-/.test(R.sheetName) && R.sheet[0] === 'Product,Variant,SKU,Barcode,Price,Cost' && R.sheet.length === 9
  && R.sheet.includes('Gecko Kit,Large,LGK-L,6002,1899.00,0.00') && R.sheet.includes('Gecko Kit,Small,LGK-S,,1299.00,0.00') && R.sheet.includes('Heat Mat 8W,,HM8,6001,249.00,0.00') && R.sheet.includes('Basking Lamp,,,,195.00,100.00') && !R.sheet.some(l => /furniture/.test(l)), R.sheet);

// ---- a filled-in sheet the way Excel saves it where the decimal mark is a comma
const filled = ['SKU;Barcode;Product;Variant;Cost', 'HM8;;;;120,50', 'LGK-S;;;;300', ';6002;;;R 1 450.00', ';;Basking Lamp;;100.00', 'DUP;;;;55', 'NOPE;;;;10', ';;Heat Mat 8W;;abc', ';;Basking Lamp;;', ';7002;;;12.5', 'UVL601;;Giangarden UVL601 UVB & UVA LED Fixture Plus;;500,25', 'TH32;;Giangarden TH32 Digital Thermo-hygrometer;;100,05'].join('\r\n');
await p.setInputFiles('#ci-file', { name: 'costs.csv', mimeType: 'text/csv', buffer: Buffer.from(filled) });
await p.waitForSelector('#ci-plan .ci-sum'); R.plan = await txt('#ci-plan');
check('the preview: 7 to change (the kit from its variants), 1 the same, 1 blank, 2 not found, 1 not a number', /7 costs to change · 1 the same · 1 left blank · 2 not found · 1 not a number/.test(R.plan), R.plan);
check('the preview lines', /Heat Mat 8W R 0\.00 → R 120\.50/.test(R.plan) && /Gecko Kit · Small R 0\.00 → R 300\.00/.test(R.plan) && /Gecko Kit · Large R 0\.00 → R 1,450\.00/.test(R.plan) && /Gecko Kit R 0\.00 → R 300\.00 \(from its variants\)/.test(R.plan) && /Dup B R 0\.00 → R 12\.50/.test(R.plan), R.plan);
await p.click('.ci-miss summary >> nth=0'); R.miss = await txt('.ci-miss >> nth=0');
check('not found: the shared SKU says so, the unknown one by line', /Line 6: DUP \(more than one product matches\)/.test(R.miss) && /Line 7: NOPE/.test(R.miss), R.miss);
await p.click('#modal-ok'); R.saved = await toast();
check('saved', /7 costs saved/.test(R.saved) && await p.locator('#modal').count() === 0, R.saved);
await p.waitForTimeout(600);
const mat = await one('products/p_mat'), kit = await one('products/p_kit'), vs = await one('variants/v_s'), vl = await one('variants/v_l'), lamp = await one('products/p_lamp'), d1 = await one('products/p_d1'), d2 = await one('products/p_d2'), bf = await one('products/p_bf');
check('the costs in cents', mat.costCents === 12050 && vs.costCents === 30000 && vl.costCents === 145000 && kit.costCents === 30000 && d2.costCents === 1250 && d1.costCents === 0 && lamp.costCents === 10000, [mat.costCents, vs.costCents, vl.costCents, kit.costCents, d1.costCents, d2.costCents, lamp.costCents]);
check('nothing else changed: price, name, both barcodes, both pictures, VAT class, the stamps; who and when written', mat.priceCents === 24900 && mat.name === 'Heat Mat 8W' && mat.barcodes.join() === '6001,6001-old' && mat.images.length === 2 && mat.vatClass === 'zero' && mat.createdBy === 'server' && mat.updatedBy === mgr.localId && vl.priceCents === 189900 && vs.priceCents === null, mat);
const uv = await one('products/p_uv'), th = await one('products/p_th');
check('a supplier list: "UVB & UVA" found as "UVB &UVA" (letters and digits only), TH32 found inside another name', uv.costCents === 50025 && th.costCents === 10005, [uv.costCents, th.costCents]);
check('the furniture shop’s HM8 untouched', bf.costCents === 9900 && !bf.updatedBy, bf);
R.audit = (await coll('auditLog')).find(a => a.action === 'product.costImport');
check('one audit row with before and after', R.audit && R.audit.entityId === 'RC' && R.audit.details.changed === 7 && R.audit.details.changes.some(c => c.id === 'p_mat' && c.fromCents === 0 && c.toCents === 12050) && R.audit.details.changes.some(c => c.id === 'v_s' && c.fromCents === null), R.audit);
R.list = await txt('.pr-tbl'); check('the list shows the cost and margin', /Heat Mat 8W/.test(R.list) && /R 120\.50 R 249\.00 51\.6%/.test(R.list), R.list.slice(0, 500));

// ---- the Shopify product CSV as a costs file: only the edited cost changes
const [ex] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=pr-export]')]);
let shop = fs.readFileSync(await ex.path(), 'utf8');
R.shopRow = shop.split('\r\n').find(l => l.startsWith('heat-mat-8w'));
shop = shop.replace(R.shopRow, R.shopRow.replace(/,120\.50$/, ',130.00'));
await p.click('[data-act=pr-costs]'); await p.waitForSelector('#modal');
await p.setInputFiles('#ci-file', { name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(shop) });
await p.waitForSelector('#ci-plan .ci-sum'); R.plan2 = await txt('#ci-plan');
check('the Shopify CSV: one cost to change, the rest the same (found by SKU and handle with options)', /^1 cost to change · 7 the same · 0 left blank/.test(R.plan2) && /Heat Mat 8W R 120\.50 → R 130\.00/.test(R.plan2), [R.plan2, R.shopRow]);
await p.click('#modal-ok'); await toast(); await p.waitForTimeout(500);
check('saved: R 130', (await one('products/p_mat')).costCents === 13000);

// ---- prices from the spreadsheet: listed apart, saved only when ticked
const priced = ['Product,Variant,SKU,Barcode,Price,Cost', 'Heat Mat 8W,,HM8,6001,"1,259.00",130.00', 'Gecko Kit,Large,LGK-L,6002,1999.00,1450.00', 'Gecko Kit,Small,LGK-S,,1299.00,', 'Basking Lamp,,,,0,'].join('\r\n');
await p.click('[data-act=pr-costs]'); await p.waitForSelector('#modal');
await p.setInputFiles('#ci-file', { name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(priced) });
await p.waitForSelector('#ci-plan .ci-sum'); R.plan3 = await txt('#ci-plan');
check('prices: two differ (the mat, the large kit), the small kit the same, a price of 0 left alone; costs the same', /0 costs to change/.test(R.plan3) && /Also change these 2 prices/.test(R.plan3) && /Heat Mat 8W R 249\.00 → R 1,259\.00/.test(R.plan3) && /Gecko Kit · Large R 1,899\.00 → R 1,999\.00/.test(R.plan3), R.plan3);
await p.click('#modal-ok'); R.untick = await toast();
check('not ticked: nothing to save, it says to tick', /Tick “Also change these prices”/.test(R.untick) && await p.locator('#modal').count() === 1, R.untick);
await p.check('#ci-prices'); await p.click('#modal-ok'); R.saved3 = await toast(); await p.waitForTimeout(600);
const mat2 = await one('products/p_mat'), vl2 = await one('variants/v_l'), vs2 = await one('variants/v_s'), lamp2 = await one('products/p_lamp');
check('ticked: the mat R 1 259 and the large kit R 1 999 in cents, the small kit still the product’s, the lamp and the costs as they were', /2 prices saved/.test(R.saved3) && mat2.priceCents === 125900 && vl2.priceCents === 199900 && vs2.priceCents === null && lamp2.priceCents === 19500 && mat2.costCents === 13000 && vl2.costCents === 145000 && mat2.barcodes.join() === '6001,6001-old', [R.saved3, mat2.priceCents, vl2.priceCents, vs2.priceCents, lamp2.priceCents, mat2.costCents]);
R.audit2 = (await coll('auditLog')).filter(a => a.action === 'product.costImport').find(a => a.details.pricesChanged === 2);
check('the audit row has the prices before and after', R.audit2 && R.audit2.details.prices.some(c => c.id === 'p_mat' && c.fromCents === 24900 && c.toCents === 125900) && R.audit2.details.prices.some(c => c.id === 'v_l' && c.fromCents === 189900), R.audit2 && R.audit2.details);

// ---- a file without a cost column
await p.click('[data-act=pr-costs]'); await p.waitForSelector('#modal');
await p.setInputFiles('#ci-file', { name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('SKU,Qty\nHM8,10\n') });
await p.waitForTimeout(500); R.nocost = await txt('#ci-plan');
check('no cost column: said so', /No cost column/.test(R.nocost), R.nocost);
await p.click('#modal-ok'); R.nofile = await toast();
check('Save with nothing to save stays open', /Choose the file first/.test(R.nofile) && await p.locator('#modal').count() === 1, R.nofile);

// ---- the reorder level on every stock item at once
if (await p.locator('#modal').count()) { await p.keyboard.press('Escape'); await p.waitForTimeout(300); if (await p.locator('#modal').count()) { await p.locator('#modal [data-close]').first().click().catch(() => {}); await p.waitForTimeout(300); } }
await p.click('[data-act=pr-reorder]'); await p.waitForSelector('#ro-level');
R.ro = await txt('#modal'); check('reorder: the stock items counted, 2 by default', /will be set/.test(R.ro) && (await p.inputValue('#ro-level')) === '2', R.ro);
await p.click('#modal-ok'); R.roToast = await toast(); await p.waitForTimeout(800);
const rc = (await coll('products')).filter(x => x.entityId === 'RC' && x.type === 'stock' && !x.archived && x.trackStock !== false);
check('every RC stock item reorders at 2, the one with no cost written with whole cents', /Reorder level 2 set on \d+ item/.test(R.roToast) && rc.length > 0 && rc.every(x => x.reorderLevel === 2) && Number.isInteger((await one('products/p_mat')).costCents), [R.roToast, rc.map(x => [x.id, x.reorderLevel])]);

// ---- the supplier on many products at once
await p.waitForSelector('#pr-supplier');
await p.selectOption('#pr-supplier', '__none'); await p.waitForTimeout(500);
R.noSup = await txt('#screen');
await p.click('[data-act=pr-supplier]'); await p.waitForSelector('#bs-sup');
R.bsModal = await txt('#modal'); check('set supplier: the products shown by the filter, Akwa offered', /products? shown by the filters/.test(R.bsModal) && /Akwa/.test(R.bsModal), R.bsModal);
await p.click('#modal-ok'); R.bsToast = await toast(); await p.waitForTimeout(800);
const rcAll = (await coll('products')).filter(x => x.entityId === 'RC' && !x.archived);
check('Akwa set on every RC product that had none; the other company untouched', /Supplier Akwa set on \d+ product/.test(R.bsToast) && rcAll.every(x => x.supplierId === 'sup_akwa') && !(await one('products/p_bf')).supplierId, [R.bsToast, rcAll.map(x => [x.id, x.supplierId])]);
await p.selectOption('#pr-supplier', 'sup_akwa'); await p.waitForTimeout(500);
R.akwa = await txt('#screen'); check('the Akwa filter shows them', new RegExp(rcAll.length + ' of').test(R.akwa), R.akwa.slice(0, 200));

// ---- archive many at once, then bring them back
const two = (await p.$$eval('[data-lbl]', cs => cs.map(c => c.dataset.lbl))).slice(0, 2);
for (const id of two) await p.check(`[data-lbl="${id}"]`);
await p.click('[data-act=pr-archive]'); await p.waitForSelector('#modal-ok');
R.arModal = await txt('#modal'); R.arOk = await txt('#modal-ok');
check('archive: the 2 ticked products named, nothing deleted', /2 products ticked/.test(R.arModal) && /bring them back any time/i.test(R.arModal) && /Archive 2 products/i.test(R.arOk), [R.arModal, R.arOk]);
await p.click('#modal-ok'); R.arToast = await toast(); await p.waitForTimeout(800);
const arch = await Promise.all(two.map(id => one('products/' + id)));
R.afterArch = await txt('#screen');
check('the two are archived and leave the list; the rest stay for sale', /Archived 2 products/.test(R.arToast) && arch.every(x => x.archived === true && Number.isInteger(x.priceCents)) && (await coll('products')).filter(x => x.entityId === 'RC' && !x.archived).length === rcAll.length - 2 && new RegExp((rcAll.length - 2) + ' of').test(R.afterArch), [R.arToast, arch.map(x => x.archived)]);
check('the archive is in the change log', (await coll('auditLog')).some(x => x.action === 'product.archiveMany' && x.details && x.details.items === 2), '');
await p.check('#pr-archived'); await p.waitForTimeout(500);
for (const id of two) await p.check(`[data-lbl="${id}"]`);
await p.click('[data-act=pr-archive]'); await p.waitForSelector('#modal-ok');
R.backOk = await txt('#modal-ok'); check('ticked archived ones: the window offers to bring them back', /Bring back 2 products/i.test(R.backOk), R.backOk);
await p.click('#modal-ok'); R.backToast = await toast(); await p.waitForTimeout(800);
check('brought back: for sale again', /Brought back 2 products/.test(R.backToast) && (await Promise.all(two.map(id => one('products/' + id)))).every(x => x.archived === false), R.backToast);

// ---- delete for good: only what nothing points to; the rest refused and told why
await put('pos/retail/stockLevels/RC-MAIN_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 3, quarantineQty: 0, reservedQty: 0, onOrderQty: 0, avgCostCents: 10000, ...st('RC'), storeId: 'RC-MAIN' });
await put('pos/retail/quotes/q1', { docNo: 'RC-QT-000001', status: 'open', lines: [{ productId: 'p_uv', variantId: '', itemId: 'p_uv', name: 'Giangarden', qty: 1 }], ...st('RC') });
await p.uncheck('#pr-archived'); await p.waitForTimeout(400);
for (const id of ['p_d1', 'p_d2', 'p_kit', 'p_lamp', 'p_uv']) await p.check(`[data-lbl="${id}"]`);
await p.click('[data-act=pr-archive]'); await p.waitForSelector('#ba-delete'); await p.click('#ba-delete'); await p.waitForSelector('#modal-ok');
R.delModal = await txt('#modal'); check('delete: the 5 named, the warning that it cannot be undone', /Delete 5 products for good/i.test(R.delModal) && /cannot be undone/.test(R.delModal) && /Dup A/.test(R.delModal), R.delModal);
await p.click('#modal-ok'); R.delToast = await toast(); await p.waitForSelector('#bd-refused', { timeout: 8000 }); R.delResult = await txt('#modal');
check('3 deleted, 2 refused', /Deleted 3 products, 2 refused/.test(R.delToast), R.delToast);
check('the refused ones are named with the reason', /Basking Lamp — has 3 on hand/.test(R.delResult) && /Giangarden[^—]*— on quote RC-QT-000001/.test(R.delResult), R.delResult);
check('the deleted products and the kit\'s variants are gone; the refused ones stay', (await Promise.all(['products/p_d1', 'products/p_d2', 'products/p_kit', 'variants/v_s', 'variants/v_l'].map(one))).every(x => x === null) && (await one('products/p_lamp')) && (await one('products/p_uv')) && (await one('stockLevels/RC-MAIN_p_lamp')).onHandQty === 3, '');
check('one change-log row per deleted product', (await coll('auditLog')).filter(x => x.action === 'product.delete').map(x => x.details.name).sort().join() === 'Dup A,Dup B,Gecko Kit', '');
await p.click('#modal-ok'); await p.waitForTimeout(500);
R.afterDel = await txt('#screen'); check('the list shows the 4 left', /4 of 4 products/.test(R.afterDel), R.afterDel.slice(-200));

check('no page errors', errs.length === 0, errs);
await b.close(); if (server) server.kill();
console.log(JSON.stringify({ fails, errs, ok: fails.length === 0 }, null, 1));
process.exit(fails.length ? 1 : 0);
