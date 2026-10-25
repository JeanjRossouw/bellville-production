// The fabric catalogue, in the browser and over HTTP, through the real rules:
// a supplier's price list in as CSV (cost per metre excl. VAT + 80% + 15%
// VAT, never under R 250 a metre); a made-to-order product's fabric metres
// (and a variant's own); on the till the specification picks a fabric and
// the line's price gains metres × price per metre; the server works it out
// again: a sale and a custom order in a catalogue fabric go through, a till
// that leaves the fabric out is refused, another company's or an archived
// fabric is refused; a cashier cannot write the catalogue.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1', FN = 'http://localhost:8788/.netlify/functions/';
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
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-01T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, specialOrder: { minDepositPct: 50, leadDays: 21 }, session: { idleLogoutMinutes: 30, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', address: { line1: '12 Voortrekker Rd', city: 'Bellville' }, active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Couches', brand: '', type: 'mto', vatClass: 'standard', trackStock: false, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_sofa', { name: 'Chesterfield 3 Seater', priceCents: 900000, fabricMetres: 11.5 });
await prod('p_couch', { name: 'Modular Couch', priceCents: 900000, fabricMetres: 11, hasVariants: true, options: [{ name: 'Size', values: ['2 Seater', '3 Seater'] }] });
await put('pos/retail/variants/v2', { productId: 'p_couch', name: '2 Seater', optionValues: { Size: '2 Seater' }, sku: 'MC2', barcodes: [], priceCents: 700000, costCents: null, fabricMetres: 8, storePrices: {}, archived: false, ...srv('BF') });
await put('pos/retail/variants/v3', { productId: 'p_couch', name: '3 Seater', optionValues: { Size: '3 Seater' }, sku: 'MC3', barcodes: [], priceCents: null, costCents: null, storePrices: {}, archived: false, ...srv('BF') });
await prod('p_daybed', { name: 'Kendra Daybed', type: 'stock', trackStock: true, priceCents: 2399900, framePriceCents: 1500000, fabricMetres: 10 });
// an L-shape sold in its shown fabrics (variants), no frame price yet
await prod('p_corner', { name: 'Mexico L Shape Corner', type: 'stock', trackStock: true, priceCents: 2199900, hasVariants: true, options: [{ name: 'Fabric', values: ['jamie-grey', 'acho-beige'] }] });
await put('pos/retail/variants/vg', { productId: 'p_corner', name: 'jamie-grey', optionValues: { Fabric: 'jamie-grey' }, sku: 'MX-G', barcodes: [], priceCents: null, costCents: null, storePrices: {}, archived: false, ...srv('BF') });
await put('pos/retail/variants/vb', { productId: 'p_corner', name: 'acho-beige', optionValues: { Fabric: 'acho-beige' }, sku: 'MX-B', barcodes: [], priceCents: null, costCents: null, storePrices: {}, archived: false, ...srv('BF') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });
await put('pos/retail/customers/c_na', { name: 'Jean Test', phone: '0825550202', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: 'keep me', tags: ['vip'], archived: false, ...srv('BF') });
await put('pos/retail/customers/c_na2', { name: 'Mia Test', phone: '0825550303', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });
// another company's fabric
await put('pos/retail/fabrics/f_other', { supplier: 'X', design: 'Elsewhere', collection: '', costCents: 10000, markupPct: 80, minPriceCents: 25000, priceCents: 25000, archived: false, ...srv('ZZ') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
const toast = async () => { await p.waitForTimeout(700); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const txt = (sel) => p.locator(sel).innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(700); };
await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-form'); await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#nav [data-view=fabrics]', { state: 'attached' }); await p.waitForTimeout(1500);

// ---- a price list in
await nav('fabrics');
R.empty = await txt('#screen'); check('the screen: none yet, the price rule said', /No fabrics yet/i.test(R.empty) && /cost \(excl\. VAT\) \+ the markup \+ 15% VAT, never under the lowest price/.test(R.empty), R.empty.slice(0, 300));
const csv = ['supplier,design,collection,composition,widthCm,use,costPerMetre,retailPricePerMetre,Price per metre at 80% (R incl. VAT)',
  'FibreGuard (Home Fabrics),Acapella,Grenoble,"87% Recycled Polyester, 13% Polyester",138,Upholstery,525.00,,1086.75',
  'U&G Fabrics,Ticino,Adventure,100% POLYESTER,145,Upholstery,70.00,,250.00',
  'Hertex (Stonehaus),Aaran,Highland Fling,100% PL,140,Upholstery,220.00,440.00,',
  'Hertex (Stonehaus),Bayonne,Biarritz,100% PL,300,Upholstery,110.00,220.00,',
  'Silkhouse,Archway,Affinity,100% Polyester,143,Upholstery,290.00,,600.30',
  'Silkhouse,Archway,Affinity,100% Polyester,143,Upholstery,290.00,,600.30'].join('\n');
await p.setInputFiles('#fb-file', { name: 'fabrics.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await p.waitForSelector('#fi-plan .ci-sum'); R.plan = await txt('#fi-plan');
check('the preview: 5 new (the repeated row once), 80% and R 250 at the least, the supplier’s retail where given', /5 new · 0 changed · 0 the same/.test(R.plan) && /Aaran \(Highland Fling\) · Hertex \(Stonehaus\) new R 220\.00 cost → R 440\.00 a metre/.test(R.plan) && /Bayonne \(Biarritz\) · Hertex \(Stonehaus\) new R 110\.00 cost → R 250\.00 a metre/.test(R.plan) && /Acapella \(Grenoble\) · FibreGuard \(Home Fabrics\) new R 525\.00 cost → R 1,086\.75 a metre/.test(R.plan) && /Ticino \(Adventure\) · U&G Fabrics new R 70\.00 cost → R 250\.00 a metre/.test(R.plan) && /Archway \(Affinity\) · Silkhouse new R 290\.00 cost → R 600\.30 a metre/.test(R.plan), R.plan);
await p.click('#modal-ok'); R.imported = await toast(); await p.waitForTimeout(800);
const fabs = await coll('fabrics'), F = (d) => fabs.find(f => f.design === d);
check('in through the rules: cents, the markup and the floor kept; the retail kept as the price', F('Aaran').priceCents === 44000 && F('Aaran').listPriceCents === 44000 && F('Aaran').costCents === 22000 && F('Bayonne').priceCents === 25000 && /5 added, 0 updated/.test(R.imported) && F('Acapella').priceCents === 108675 && F('Acapella').costCents === 52500 && F('Acapella').markupPct === 80 && F('Ticino').priceCents === 25000 && F('Ticino').minPriceCents === 25000 && F('Archway').priceCents === 60030 && F('Acapella').entityId === 'BF', [R.imported, fabs.map(f => [f.design, f.priceCents])]);
R.list = await txt('.fb-tbl'); check('the list', /Acapella Grenoble FibreGuard \(Home Fabrics\)/.test(R.list) && /R 250\.00 \+80% · lowest price/.test(R.list), R.list.slice(0, 400));
// the same list again with a new cost: one changed
await p.setInputFiles('#fb-file', { name: 'fabrics.csv', mimeType: 'text/csv', buffer: Buffer.from(csv.replace('525.00', '550.00')) });
await p.waitForSelector('#fi-plan .ci-sum'); R.plan2 = await txt('#fi-plan');
check('again: 1 changed, 4 the same', /0 new · 1 changed · 4 the same/.test(R.plan2) && /R 1,086\.75 → R 550\.00 cost → R 1,138\.50/.test(R.plan2), R.plan2);
await p.click('[data-close]'); await p.waitForTimeout(300);

// ---- the product: fabric metres for made to order
await nav('products');
await p.click('[data-act=pr-edit][data-id=p_sofa]'); await p.waitForSelector('#pf-fabricm');
check('made to order: the fabric metres field, filled', await p.locator('#pf-fabric').isVisible() && (await p.inputValue('#pf-fabricm')) === '11.5');
await p.fill('#pf-fabricm', '12'); await p.click('#modal-ok'); await toast();
check('saved: 12 m', (await one('products/p_sofa')).fabricMetres === 12);
await p.click('[data-act=pr-edit][data-id=p_couch]'); await p.waitForSelector('#pf-variants');
R.var = await p.$$eval('#pf-variants [data-vfab]', x => x.map(i => i.value)); check('the variant grid: 2 Seater 8 m, 3 Seater the product’s', R.var.join() === '8,', R.var);
await p.click('[data-close]'); await p.waitForTimeout(300);

// ---- the till: the specification picks the fabric, the price follows
await nav('sell'); await p.waitForTimeout(500);
await p.click('.pos-tile:has-text("Chesterfield 3 Seater")'); await p.waitForTimeout(300);
await p.click('[data-act=sl-note]'); await p.waitForSelector('#ln-fab');
check('the specification says the metres', /Fabric \(12 m\)/i.test(await txt('#ln-fab')));
await p.fill('#ln-fab .fb-pick-q', 'acap'); await p.waitForTimeout(200);
await p.click('.fb-pick-row:has-text("Acapella")'); await p.waitForTimeout(200);
R.note = await txt('#ln-fab .fb-pick-note'); check('12 m × R 1,086.75 = R 13,041.00 added', /12 m × R 1,086\.75 = R 13,041\.00 added to the price/.test(R.note), R.note);
await p.click('#modal-ok'); await p.waitForTimeout(400);
R.cart = await txt('.pos-cart'); check('the line: R 22,041.00 with the fabric, the chip says so', /R 22,041\.00/.test(R.cart) && /fabric \+R 13,041\.00/i.test(R.cart) && /Acapella \(Grenoble\)/i.test(R.cart), R.cart.slice(0, 500));
const line = await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]).lines[0]);
check('the line keeps the fabric id', line.spec && line.spec.fabricId === F('Acapella').id && line.unitPriceCents === 2204100 && line.listPriceCents === 2204100, line);
// a fabric not from the catalogue adds nothing
await p.click('[data-act=sl-note]'); await p.waitForSelector('#ln-fab'); await p.fill('#ln-fab .fb-pick-q', 'Customer’s own velvet'); await p.waitForTimeout(200);
R.own = await txt('#ln-fab .fb-pick-note'); await p.click('#modal-ok'); await p.waitForTimeout(300);
const line2 = await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]).lines[0]);
check('the customer’s own fabric: nothing added, back to R 9,000', /Not from the catalogue: nothing is added/.test(R.own) && line2.unitPriceCents === 900000 && !line2.spec.fabricId && line2.spec.fabric === 'Customer’s own velvet', [R.own, line2.unitPriceCents, line2.spec]);

// ---- a stocked couch with a frame price: as shown, or the frame + a fabric of choice; the Fabric button; a delivery
await p.click('.pos-tile:has-text("Kendra Daybed")'); await p.waitForSelector('input[name=fb-how]');
R.how = await txt('#modal'); check('adding it asks: as shown from stock, or the frame + a fabric', /As shown · R 23,999\.00 · from stock/.test(R.how) && /Frame · R 15,000\.00 \+ the fabric the customer chooses/.test(R.how), R.how.slice(0, 300));
await p.check('input[name=fb-how][value=frame]'); await p.fill('#ln-fab2 .fb-pick-q', 'acap'); await p.waitForTimeout(200); await p.click('#ln-fab2 .fb-pick-row:has-text("Acapella")'); await p.waitForTimeout(200);
R.tot = await txt('#fb-total'); check('frame R 15,000 + 10 m × R 1,086.75 = R 25,867.50', /R 25,867\.50/.test(R.tot), R.tot);
await p.click('#modal-ok'); await p.waitForTimeout(400);
let cl = (await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]))).lines;
let dl = cl.find(l => l.productId === 'p_daybed');
check('the line: R 25,867.50, made to order (no stock taken), the frame and the fabric kept', dl.unitPriceCents === 2586750 && dl.type === 'mto' && dl.trackStock === false && dl.spec.frame === true && dl.spec.fabricId === F('Acapella').id, dl);
R.fbtn = await txt('.pos-line:has-text("Kendra Daybed") [data-act=sl-fabric]'); check('the line’s Fabric button says Frame + Acapella', /Frame \+ Acapella/i.test(R.fbtn), R.fbtn);
await p.click('.pos-line:has-text("Kendra Daybed") [data-act=sl-fabric]'); await p.waitForSelector('input[name=fb-how]');
await p.check('input[name=fb-how][value=shown]'); await p.click('#modal-ok'); await p.waitForTimeout(400);
cl = (await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]))).lines; dl = cl.find(l => l.productId === 'p_daybed');
check('as shown again: R 23,999.00 from stock', dl.unitPriceCents === 2399900 && dl.type === 'stock' && dl.trackStock === true && !dl.spec.frame && !dl.spec.fabricId, dl);
await p.click('[data-act=sl-delivery]'); await p.waitForSelector('#dl-line1');
await p.fill('#dl-line1', '5 Lane'); await p.fill('#dl-city', 'Parow'); await p.fill('#dl-fee', '450'); await p.click('#modal-ok'); await p.waitForTimeout(400);
R.cart2 = await txt('.pos-cart'); { const dl0 = (await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]))).lines.find(l => l.delivery);
check('the delivery line: just Delivery, R 450, the address kept on it', /Delivery/.test(R.cart2) && !/Delivery to/.test(R.cart2) && /R 450\.00/.test(R.cart2) && dl0.name === 'Delivery' && dl0.delivery.address === '5 Lane, Parow', [R.cart2.slice(0, 600), dl0]); }
// ---- a couch with variants (its shown fabrics): the picker offers the frame; a manager sets the frame price from the till
await p.click('.pos-tile:has-text("Mexico L Shape Corner")'); await p.waitForSelector('[data-frame]');
R.vp = await txt('#modal'); check('the picker: the variants, and Frame + fabric of choice (set the frame price first)', /jamie-grey/.test(R.vp) && /Frame \+ fabric of choice/.test(R.vp) && /set the frame price first/.test(R.vp), R.vp);
await p.click('[data-frame]'); await p.waitForSelector('#fr-price');
await p.fill('#fr-price', '14000'); await p.fill('#fr-metres', '14'); await p.click('#modal-ok');
await p.waitForSelector('[data-frame]:has-text("frame R 14,000.00")', { timeout: 5000 }).catch(() => {});
R.vp2 = await txt('#modal'); check('saved on the product, the picker again: frame R 14,000.00 + the fabric', /frame R 14,000\.00 \+ the fabric/.test(R.vp2), R.vp2);
await p.click('[data-frame]'); await p.waitForSelector('input[name=fb-how]');
check('the frame is picked already', await p.isChecked('input[name=fb-how][value=frame]'));
await p.fill('#ln-fab2 .fb-pick-q', 'acap'); await p.waitForTimeout(200); await p.click('#ln-fab2 .fb-pick-row:has-text("Acapella")'); await p.waitForTimeout(200);
R.tot2 = await txt('#fb-total'); check('frame R 14,000 + 14 m × R 1,086.75 = R 29,214.50', /R 29,214\.50/.test(R.tot2), R.tot2);
await p.click('#modal-ok'); await p.waitForTimeout(400);
cl = (await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]))).lines;
const ml = cl.find(l => l.productId === 'p_corner');
check('the line: Mexico L Shape Corner · frame, R 29,214.50, made to order', ml && ml.name === 'Mexico L Shape Corner · frame' && ml.unitPriceCents === 2921450 && ml.type === 'mto' && !ml.trackStock && ml.spec.frame === true && ml.spec.fabricId === F('Acapella').id, ml);
await p.click('.pos-tile:has-text("Mexico L Shape Corner")'); await p.waitForSelector('[data-v]'); await p.click('[data-v=vg]'); await p.waitForTimeout(400);
cl = (await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]))).lines;
check('jamie-grey as shown: its own line from stock, no fabric question', cl.filter(l => l.productId === 'p_corner').length === 2 && cl.some(l => l.variantId === 'vg' && l.name === 'Mexico L Shape Corner · jamie-grey' && l.type === 'stock' && l.unitPriceCents === 2199900) && !(await p.$('input[name=fb-how]')), cl.filter(l => l.productId === 'p_corner'));

// ---- Delivery again changes its line; a sales order asks a customer with no address for one; Delivery keeps it on the customer
const cartLines = async () => (await p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]))).lines;
await p.click('[data-act=sl-delivery]'); await p.waitForSelector('#dl-line1');
R.dlAgain = await txt('#modal'); check('Delivery again: the same line, to change', /Change delivery/i.test(R.dlAgain) && (await p.inputValue('#dl-fee')) === '450.00' && (await p.inputValue('#dl-city')) === 'Parow', R.dlAgain.slice(0, 200));
await p.fill('#dl-fee', '500'); await p.click('#modal-ok'); await p.waitForTimeout(400);
const dls = (await cartLines()).filter(l => l.delivery); check('still one delivery line, now R 500', dls.length === 1 && dls[0].unitPriceCents === 50000 && dls[0].delivery.city === 'Parow', dls);
const pickCust = async (q) => { await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', q); await p.waitForTimeout(300); await p.click('#cu-list .pk-row'); await p.waitForTimeout(400); };
await p.click('[data-act=sl-void]'); await p.waitForSelector('#vd-reason'); await p.fill('#vd-reason', 'test'); await p.click('#modal-ok'); await p.waitForTimeout(500);
await pickCust('0825550202');
await p.click('.pos-tile:has-text("Mexico L Shape Corner")'); await p.waitForSelector('[data-frame]'); await p.click('[data-frame]'); await p.waitForSelector('input[name=fb-how]');
await p.fill('#ln-fab2 .fb-pick-q', 'Customer’s own linen'); await p.waitForTimeout(200); await p.click('#modal-ok'); await p.waitForTimeout(400);
await p.click('[data-act=sl-special]'); await p.waitForSelector('#modal #so-pad');
R.soClient = await txt('#modal .so-client'); check('the sales order shows the client, no address boxes', /Jean Test/.test(R.soClient) && /0825550202/.test(R.soClient) && /No address yet: needed at the hand-over/.test(R.soClient) && !(await p.$('#so-a1')), R.soClient);
await p.uncheck('#so-depnow'); await p.check('#so-accept');
{ const box = await p.locator('#so-pad').boundingBox(); await p.mouse.move(box.x + 20, box.y + 40); await p.mouse.down(); await p.mouse.move(box.x + 150, box.y + 70, { steps: 8 }); await p.mouse.up(); }
await p.click('#modal-ok'); R.soOk = await toast();
check('over R 5 000 with no address: the sales order opens (no tax invoice yet)', /Sales order BF-SO-\d+/.test(R.soOk), R.soOk);
const soNa = (await coll('specialOrders')).find(o => o.customerId === 'c_na');
if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); }
await pickCust('0825550303');
await p.click('[data-act=sl-delivery]'); await p.waitForSelector('#dl-line1'); await p.fill('#dl-line1', '7 Elm Rd'); await p.fill('#dl-city', 'Bellville'); await p.fill('#dl-fee', '0'); await p.click('#modal-ok'); R.dlKeep = await toast();
const cna2 = await one('customers/c_na2'); check('Delivery keeps the address on a customer who had none', /address is kept on Mia Test/.test(R.dlKeep) && cna2.address.line1 === '7 Elm Rd' && cna2.address.city === 'Bellville', [R.dlKeep, cna2.address]);

// ---- the server prices it again
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
let n = 0;
const saleBody = (lines, total) => ({ action: 'commit', saleId: 'web-fab-' + (++n) + '-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines, saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, tenders: [{ method: 'card', amountCents: total }], ...bell });
const acap = F('Acapella').id, tic = F('Ticino').id, arch = F('Archway').id;
R.sale = await call('pos-sale', saleBody([{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 2204100, discountCents: 0, spec: { model: 'Chesterfield', fabric: 'whatever the till typed', fabricId: acap, colour: 'Charcoal' } }], 2204100));
const sl = R.sale.lines && R.sale.lines[0];
check('a sale in Acapella: priced by the server, the fabric on the spec', R.sale.ok && sl.listPriceCents === 2204100 && !sl.priceOverride && sl.spec.fabricId === acap && sl.spec.fabric === 'Acapella (Grenoble) · FibreGuard (Home Fabrics)' && sl.spec.fabricMetres === 12 && sl.spec.fabricPerMetreCents === 108675 && sl.spec.fabricCents === 1304100, R.sale.error || sl);
R.frame = await call('pos-sale', saleBody([{ productId: 'p_daybed', variantId: '', qty: 1, unitPriceCents: 2586750, discountCents: 0, spec: { frame: true, fabricId: acap } }], 2586750));
const fl = R.frame.lines && R.frame.lines[0];
check('the frame + Acapella sold: R 25,867.50, made to order, no stock moved, the frame on the spec', R.frame.ok && fl.type === 'mto' && fl.fulfilment === 'mto' && !fl.trackStock && fl.spec.frame === true && fl.spec.framePriceCents === 1500000 && fl.spec.fabricCents === 1086750 && R.frame.salesOrder, R.frame.error || fl);
R.own = await call('pos-sale', saleBody([{ productId: 'p_daybed', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0, spec: { frame: true, fabric: 'Customer’s own linen' } }], 1500000));
check('the frame in the customer’s own fabric: R 15,000', R.own.ok && R.own.lines[0].unitPriceCents === 1500000 && R.own.lines[0].spec.fabric === 'Customer’s own linen' && R.own.lines[0].spec.fabricCents === 0, R.own.error || R.own.lines);
R.mx = await call('pos-sale', saleBody([{ productId: 'p_corner', variantId: 'vg', qty: 1, unitPriceCents: 2921450, discountCents: 0, spec: { frame: true, fabricId: acap } }], 2921450));
check('the L-shape frame + Acapella sold at R 29,214.50, named as the frame', R.mx.ok && R.mx.lines[0].name === 'Mexico L Shape Corner · frame' && R.mx.lines[0].type === 'mto' && R.mx.lines[0].spec.framePriceCents === 1400000, R.mx.error || R.mx.lines);
R.addrEmpty = await call('pos-customer', { action: 'address', customerId: 'c_na2', address: {}, ...bell }); check('an empty address: refused', R.addrEmpty.status === 400, R.addrEmpty);
// the hand-over of that order writes the tax invoice: over R 5 000 it needs the address
await fetch(`${docs}/pos/retail/specialOrders/${soNa.id}?updateMask.fieldPaths=status&updateMask.fieldPaths=balanceCents&updateMask.fieldPaths=paidCents`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { status: { stringValue: 'ready' }, balanceCents: { integerValue: '0' }, paidCents: { integerValue: String(soNa.totalCents) } } }) });
R.hoNoAddr = await call('pos-special', { action: 'deliver', orderId: soNa.id, saleId: 'sos-na-' + Date.now().toString(36), signedBy: 'Jean Test', ...bell });
check('hand-over without an address: refused, asks for it', R.hoNoAddr.status === 400 && /Jean Test’s address/.test(R.hoNoAddr.error), R.hoNoAddr);
R.setAddr = await call('pos-customer', { action: 'address', customerId: 'c_na', address: { line1: '9 Oak St', city: 'Durbanville' }, ...bell });
const cna = await one('customers/c_na'); check('the address kept on the customer, nothing else touched', R.setAddr.ok && cna.address.line1 === '9 Oak St' && cna.notes === 'keep me' && cna.tags.join() === 'vip', cna);
R.ho = await call('pos-special', { action: 'deliver', orderId: soNa.id, saleId: 'sos-na2-' + Date.now().toString(36), signedBy: 'Jean Test', ...bell });
check('with the address: handed over, the tax invoice carries it', R.ho.ok && R.ho.sale && R.ho.sale.customerSnapshot.address.line1 === '9 Oak St', R.ho.error || R.ho.sale);
R.cheap = await call('pos-sale', saleBody([{ productId: 'p_daybed', variantId: '', qty: 1, unitPriceCents: 1400000, discountCents: 0, spec: { frame: true } }], 1400000));
check('under the frame price: refused', R.cheap.status === 403, R.cheap);
R.tamper = await call('pos-sale', saleBody([{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 900000, discountCents: 0, spec: { fabricId: acap } }], 900000));
check('a till that leaves the fabric out: refused', R.tamper.status === 403 && /without a manager/.test(R.tamper.error), R.tamper);
R.other = await call('pos-sale', saleBody([{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 900000 + 300000, discountCents: 0, spec: { fabricId: 'f_other' } }], 1200000));
check('another company’s fabric: refused', R.other.status === 400 && /not in the catalogue/.test(R.other.error), R.other);
// a custom order, a variant with its own metres; the 3 seater with the product's
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const total = 900000 + 1175000;
R.so = await call('pos-special', { action: 'open', orderId: 'so-fab-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: 'c1',
  lines: [{ productId: 'p_couch', variantId: 'v2', qty: 1, unitPriceCents: 900000, discountCents: 0, spec: { size: '2 Seater', fabric: '', fabricId: tic, colour: 'Sand' } }, { productId: 'p_couch', variantId: 'v3', qty: 1, unitPriceCents: 1175000, discountCents: 0, spec: { fabricId: tic } }],
  saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, deposit: [], signoff: { accepted: true, signedBy: 'T Mokoena', signature: sig }, ...bell });
const L = R.so.order && R.so.order.lines;
check('a custom order in Ticino: 8 m × R 250 on the 2 seater, 11 m (the product’s) on the 3 seater', R.so.ok && L[0].spec.fabricCents === 200000 && L[0].spec.fabricMetres === 8 && L[0].spec.fabric === 'Ticino (Adventure) · U&G Fabrics' && L[0].spec.colour === 'Sand' && L[1].spec.fabricCents === 275000 && L[1].spec.fabricMetres === 11 && R.so.order.totalCents === total, R.so.error || L);
check('the sign-off reads the fabric back', R.so.order && /Fabric Ticino \(Adventure\) · U&G Fabrics/.test(R.so.order.signoff.text), R.so.order && R.so.order.signoff.text);
await put('pos/retail/fabrics/' + arch, { ...F('Archway'), archived: true });
R.arch = await call('pos-sale', saleBody([{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 900000 + 720360, discountCents: 0, spec: { fabricId: arch } }], 1620360));
check('an archived fabric: refused on a new sale', R.arch.status === 400 && /not in the catalogue/.test(R.arch.error), R.arch);
// a cashier cannot write the catalogue
const casWrite = await fetch(`${docs}/pos/retail/fabrics/f_cas`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + cas.idToken, 'content-type': 'application/json' }, body: JSON.stringify({ fields: toFs({ supplier: 'x', design: 'y', costCents: 1, priceCents: 1, ...srv('BF'), createdBy: cas.localId }).mapValue.fields }) });
check('a cashier cannot write a fabric', casWrite.status === 403, casWrite.status);
const casRead = await fetch(`${docs}/pos/retail/fabrics/${acap}`, { headers: { Authorization: 'Bearer ' + cas.idToken } });
check('a cashier reads the catalogue', casRead.status === 200, casRead.status);

// ---- the client's own page: a private link per order and quotation; a quotation accepted and signed there
const track = async (body) => { const r = await fetch(FN + 'pos-track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
R.oLink = await call('pos-special', { action: 'trackLink', kind: 'order', id: R.so.order.id, ...bell });
const oTok = (/[?&]t=([\w-]+)/.exec(R.oLink.link || '') || [])[1];
check('the order’s link: the client page, with a message to send it', R.oLink.ok && /\/pos\/track\.html\?t=/.test(R.oLink.link) && R.oLink.text.includes(R.oLink.link) && R.oLink.phone === '0825550101', R.oLink);
R.oLink2 = await call('pos-special', { action: 'trackLink', kind: 'order', id: R.so.order.id, ...bell }); check('the same link every time', R.oLink2.link === R.oLink.link, R.oLink2.link);
R.oView = await track({ action: 'view', t: oTok });
check('the page: the order, its steps and the money, no costs', R.oView.kind === 'order' && R.oView.docNo === R.so.order.docNo && R.oView.status === 'quoted' && R.oView.balanceCents === total && R.oView.minDepositCents > 0 && R.oView.steps.length === 5 && R.oView.lines.length === 2 && !/costCents|signature|cashier/.test(JSON.stringify(R.oView)), R.oView);
R.badTok = await track({ action: 'view', t: 'x'.repeat(24) }); check('a made-up link: not found', R.badTok.status === 404, R.badTok);
R.upd = await call('pos-special', { action: 'update', orderId: R.so.order.id, ...bell }); check('every WhatsApp update carries the order page', R.upd.ok && R.upd.text.includes(R.oLink.link), R.upd.text);
const qId = 'qt-fab-' + Date.now().toString(36);
R.q = await call('pos-special', { action: 'quote', quoteId: qId, clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines: [{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 900000, discountCents: 0, spec: null }], saleDiscountCents: 0, totals: { totalCents: 900000, vatCents: vatIn(900000, 1500) }, ...bell });
R.qLink = await call('pos-special', { action: 'trackLink', kind: 'quote', id: qId, ...bell });
const qTok = (/[?&]t=([\w-]+)/.exec(R.qLink.link || '') || [])[1];
check('a quotation’s link and message', R.q.ok && R.qLink.ok && /accept and sign it/.test(R.qLink.text), [R.q.error, R.qLink]);
R.noSig = await track({ action: 'accept', t: qTok, name: 'Thandi Mokoena' }); check('accepting without signing: refused', R.noSig.status === 400 && /Sign/.test(R.noSig.error), R.noSig);
R.oAcc = await track({ action: 'accept', t: oTok, name: 'x', signature: sig }); check('an order link cannot accept', R.oAcc.status === 400, R.oAcc);
// the client opens the page on their phone, signs and accepts
const cp = await ctx.newPage(); cp.on('pageerror', e => errs.push('CLIENT PAGEERROR ' + e.message));
await cp.goto(R.qLink.link.replace(/^https?:\/\/[^/]+/, 'http://localhost:8788')); await cp.waitForSelector('#acc-go');
R.qPage = (await cp.locator('#app').innerText()).replace(/\s+/g, ' ');
check('the client sees the quotation: the shop, the items, the total, valid until', /BELLVILLE FURNITURE/i.test(R.qPage) && /Chesterfield 3 Seater/.test(R.qPage) && /R 9,000\.00/.test(R.qPage) && /Valid until/.test(R.qPage), R.qPage.slice(0, 400));
await cp.fill('#acc-name', 'Thandi Mokoena');
{ const box = await cp.locator('#acc-pad').boundingBox(); await cp.mouse.move(box.x + 20, box.y + 40); await cp.mouse.down(); await cp.mouse.move(box.x + 160, box.y + 80, { steps: 8 }); await cp.mouse.up(); }
await cp.click('#acc-go'); await cp.waitForSelector('text=Accepted and signed by', { timeout: 8000 }).catch(() => {});
R.qAcc = (await cp.locator('#app').innerText()).replace(/\s+/g, ' ');
const qDoc = await one('quotes/' + qId);
check('accepted and signed: on the quotation, the page says so', /Accepted and signed by Thandi Mokoena/.test(R.qAcc) && qDoc.accepted && qDoc.accepted.name === 'Thandi Mokoena' && /^data:image\/png/.test(qDoc.accepted.signature), [R.qAcc.slice(0, 300), qDoc && qDoc.accepted && qDoc.accepted.name]);
R.again = await track({ action: 'accept', t: qTok, name: 'Someone else', signature: sig }); check('accepting twice: the first stands', R.again.again && R.again.accepted.name === 'Thandi Mokoena', R.again);
await cp.goto('http://localhost:8788/pos/track.html?t=' + oTok); await cp.waitForSelector('.steps');
R.oPage = (await cp.locator('#app').innerText()).replace(/\s+/g, ' ');
check('the client’s order page: waiting for the deposit, the balance', /Waiting for the deposit/.test(R.oPage) && /Balance/.test(R.oPage) && new RegExp(R.so.order.docNo).test(R.oPage), R.oPage.slice(0, 400));
await cp.close();
// the shop's To do board
await p.evaluate(() => document.querySelector('#nav [data-view="todo"]').click()); await p.waitForTimeout(1500);
R.todo = await txt('#screen');
check('To do: the quote accepted online, the order waiting for its deposit', /Quotes accepted online/.test(R.todo) && /Thandi Mokoena/.test(R.todo) && /Load into the sale/i.test(R.todo) && /Waiting for the deposit/.test(R.todo) && new RegExp(R.so.order.docNo).test(R.todo), R.todo.slice(0, 800));

check('no page errors', errs.length === 0, errs);
await b.close(); if (server) server.kill();
console.log(JSON.stringify({ fails, errs, ok: fails.length === 0 }, null, 1));
process.exit(fails.length ? 1 : 0);
