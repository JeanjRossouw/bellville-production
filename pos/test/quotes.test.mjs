// Quotes and the Sales order button, over HTTP and in the browser, through
// the real rules: a quote priced by the server (fabric included), numbered,
// valid for some days, with or without the customer; its prices hold when
// it is loaded into a sale or a sales order (a deposit, the rest later) even
// after the list price went up, and only once, only while in date; it can be
// cancelled. On the till: Quote makes it and shows the Quotation, Sales →
// Quotes lists it, Load into the sale puts it back at its prices, and the
// deposit flow is called Sales order.
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
const patch = (p, data) => fetch(`${docs}/${p}?` + Object.keys(data).map(k => 'updateMask.fieldPaths=' + k).join('&'), { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const one = async (p) => { const r = await (await fetch(`${docs}/pos/retail/${p}`, { headers: H })).json(); return r.fields ? fromFs({ mapValue: { fields: r.fields } }) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
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
await prod('p_sofa', { name: 'Chesterfield 3 Seater', priceCents: 900000, fabricMetres: 12 });
await prod('p_cush', { name: 'Scatter Cushion', type: 'nonstock', priceCents: 25000 });
await put('pos/retail/fabrics/f_acap', { supplier: 'FibreGuard (Home Fabrics)', design: 'Acapella', collection: 'Grenoble', costCents: 52500, markupPct: 80, minPriceCents: 25000, priceCents: 108675, archived: false, ...srv('BF') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const day = (n = 0) => new Date(Date.now() + 2 * 3600000 + n * 86400000).toISOString().slice(0, 10);
let n = 0;
const sofaLine = (unit, o = {}) => ({ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: unit, discountCents: 0, spec: { model: 'Chesterfield', fabricId: 'f_acap', colour: 'Charcoal' }, ...o });
const cushLine = (unit, o = {}) => ({ productId: 'p_cush', variantId: '', qty: 2, unitPriceCents: unit, discountCents: 0, ...o });
const quoteBody = (lines, total, o = {}) => ({ action: 'quote', quoteId: 'qt-test-' + (++n) + '-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), lines, saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, ...bell, ...o });
const saleBody = (lines, total, o = {}) => ({ action: 'commit', saleId: 'web-qt-' + (++n) + '-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines, saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, tenders: [{ method: 'card', amountCents: total }], ...bell, ...o });
const T1 = 2204100 + 50000;   // the sofa in Acapella (R 9 000 + 12 m × R 1 086.75) and two cushions

// ---- a quote: no customer needed, over R 5 000, priced and numbered by the server
R.q1 = await call('pos-special', quoteBody([sofaLine(2204100), cushLine(25000)], T1, { customerName: 'Wanda Walk-in', customerPhone: '0821112222', validDays: 7, note: 'Delivery included' }));
const Q1 = R.q1.quote;
check('quote 1: numbered, open, valid 7 days, the walk-in’s name, the fabric priced on the spec', R.q1.ok && Q1.docNo === 'BF-QT-000001' && Q1.status === 'open' && Q1.validUntil === day(7) && Q1.totalCents === T1 && Q1.customerSnapshot.name === 'Wanda Walk-in' && Q1.lines[0].spec.fabricCents === 1304100 && Q1.lines[0].spec.fabric === 'Acapella (Grenoble) · FibreGuard (Home Fabrics)', R.q1.error || Q1);
R.qBad = await call('pos-special', quoteBody([sofaLine(900000)], 900000));
check('a quote without the fabric’s price: refused like a sale', R.qBad.status === 403, R.qBad);
const q1db = await one('quotes/' + Q1.id);
check('only the server writes quotes; a cashier reads the store’s', q1db && q1db.series === 'QT' && (await fetch(`${docs}/pos/retail/quotes/${Q1.id}`, { headers: { Authorization: 'Bearer ' + cas.idToken } })).status === 200 && (await fetch(`${docs}/pos/retail/quotes/x1`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + cas.idToken, 'content-type': 'application/json' }, body: JSON.stringify({ fields: toFs({ status: 'open', ...srv('BF', 'BF-BELL') }).mapValue.fields }) })).status === 403);

// ---- the price goes up; the quote still holds, once
await patch('pos/retail/products/p_sofa', { priceCents: 950000 });
R.noQuote = await call('pos-sale', saleBody([sofaLine(2204100), cushLine(25000)], T1));
check('the old price without the quote: a cashier is refused', R.noQuote.status === 403 && /without a manager/.test(R.noQuote.error), R.noQuote);
R.s1 = await call('pos-sale', saleBody([sofaLine(2204100, { quoteId: Q1.id, quoteLine: 1 }), cushLine(25000, { quoteId: Q1.id, quoteLine: 2 })], T1, { quoteId: Q1.id }));
check('the sale at the quoted price: through, the override says the quote', R.s1.ok && R.s1.lines[0].priceOverride && R.s1.lines[0].priceOverride.reason === 'Quote BF-QT-000001' && R.s1.lines[0].listPriceCents === 2254100 && R.s1.sale.totalCents === T1, R.s1.error || R.s1.lines);
const q1after = await one('quotes/' + Q1.id);
check('the quote is used, by that sale', q1after.status === 'used' && q1after.usedAs.kind === 'sale' && q1after.usedAs.docNo === R.s1.sale.docNo, q1after);
R.again = await call('pos-sale', saleBody([sofaLine(2204100, { quoteId: Q1.id, quoteLine: 1 }), cushLine(25000, { quoteId: Q1.id, quoteLine: 2 })], T1, { quoteId: Q1.id }));
check('a used quote holds nothing', R.again.status === 403, R.again);

// ---- out of date
R.q2 = await call('pos-special', quoteBody([sofaLine(2254100)], 2254100, { customerId: 'c1' }));
await patch('pos/retail/quotes/' + R.q2.quote.id, { validUntil: day(-1) });
R.expired = await call('pos-special', quoteBody([sofaLine(2254100)], 2254100));   // the new price is fine, of course
await patch('pos/retail/products/p_sofa', { priceCents: 990000 });
R.late = await call('pos-sale', saleBody([sofaLine(2254100, { quoteId: R.q2.quote.id, quoteLine: 1 })], 2254100, { quoteId: R.q2.quote.id }));
check('an expired quote holds nothing', R.q2.ok && R.late.status === 403, R.late);

// ---- a sales order from a quote: a deposit now, the rest later, at the quoted price
R.q3 = await call('pos-special', quoteBody([sofaLine(2294100)], 2294100, { customerId: 'c1' }));
await patch('pos/retail/products/p_sofa', { priceCents: 1000000 });
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
R.so = await call('pos-special', { action: 'open', orderId: 'so-qt-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: 'c1', quoteId: R.q3.quote.id,
  lines: [sofaLine(2294100, { quoteId: R.q3.quote.id, quoteLine: 1 })], saleDiscountCents: 0, totals: { totalCents: 2294100, vatCents: vatIn(2294100, 1500) },
  deposit: [{ method: 'card', amountCents: 1147050, cardLast4: '4242', approvalCode: '123456' }], signoff: { accepted: true, signedBy: 'T Mokoena', signature: sig }, ...bell });
check('the sales order: R 22 941 as quoted, half paid, the rest before delivery', R.so.ok && R.so.order.totalCents === 2294100 && R.so.order.status === 'depositPaid' && R.so.order.balanceCents === 1147050, R.so.error || R.so.order);
const q3after = await one('quotes/' + R.q3.quote.id);
check('quote 3 used by the sales order', q3after.status === 'used' && q3after.usedAs.kind === 'salesOrder' && q3after.usedAs.docNo === R.so.order.docNo, q3after);

// ---- cancelled
R.q4 = await call('pos-special', quoteBody([cushLine(25000)], 50000, { customerId: 'c1' }));
R.c4 = await call('pos-special', { action: 'quoteCancel', quoteId: R.q4.quote.id, reason: 'Customer bought elsewhere', ...bell });
R.c4b = await call('pos-special', { action: 'quoteCancel', quoteId: R.q4.quote.id, reason: 'again', ...bell });
check('a quote cancelled, once', R.c4.ok && R.c4.quote.status === 'cancelled' && (await one('quotes/' + R.q4.quote.id)).cancelReason === 'Customer bought elsewhere' && R.c4b.status === 409, [R.c4, R.c4b]);

// ---- changed: the next revision over the same number, valid again from today; the earlier total kept
R.q5 = await call('pos-special', quoteBody([sofaLine(2304100), cushLine(25000)], 2354100, { customerId: 'c1', note: 'First go' }));
const Q5 = R.q5.quote;
const revBody = (o = {}) => ({ ...quoteBody([sofaLine(2304100, { quoteId: Q5.id, quoteLine: 1 }), cushLine(25000, { quoteId: Q5.id, quoteLine: 2, qty: 4 })], 2404100, { customerId: 'c1', note: 'Four cushions', validDays: 10 }), action: 'quoteRevise', quoteId: Q5.id, ...o });
R.rev = await call('pos-special', revBody());
const Q5r = R.rev.quote;
check('revised: the same number, revision 2, four cushions, valid 10 days from today, revision 1 kept under it', R.rev.ok && Q5r.docNo === Q5.docNo && Q5r.revision === 2 && Q5r.totalCents === 2404100 && Q5r.lines[1].qty === 4 && Q5r.validUntil === day(10) && Q5r.note === 'Four cushions' && Q5r.status === 'open' && Q5r.revisions.length === 1 && Q5r.revisions[0].revision === 1 && Q5r.revisions[0].totalCents === 2354100 && Q5r.revisions[0].lines.length === 2 && Q5r.revisedBy === 'Cathy', R.rev.error || Q5r);
const q5db = await one('quotes/' + Q5.id);
check('written so, and no new number was taken', q5db.revision === 2 && q5db.totalCents === 2404100 && (await one('counters/BF_QT')).next === 7, [q5db.revision, q5db.totalCents]);
await patch('pos/retail/products/p_sofa', { priceCents: 1010000 });
R.revSale = await call('pos-sale', saleBody([sofaLine(2304100, { quoteId: Q5.id, quoteLine: 1 }), cushLine(25000, { quoteId: Q5.id, quoteLine: 2, qty: 4 })], 2404100, { quoteId: Q5.id }));
check('the revised quote prices the sale after the price went up', R.revSale.ok && R.revSale.sale.totalCents === 2404100, R.revSale.error || R.revSale.sale);
R.revUsed = await call('pos-special', revBody()); check('a used quote cannot change', R.revUsed.status === 409 && /used/.test(R.revUsed.error), R.revUsed);
R.revCancelled = await call('pos-special', revBody({ quoteId: R.q4.quote.id })); check('nor a cancelled one', R.revCancelled.status === 409, R.revCancelled);
check('the revision audited', (await listColl('auditLog')).some(a => a.action === 'quote.revise' && a.docNo === Q5.docNo && a.details.revision === 2 && a.details.wasCents === 2354100), 'no quote.revise row');

// ---- on the till
await patch('pos/retail/products/p_sofa', { priceCents: 900000 });
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(700); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const txt = (sel) => p.locator(sel).innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(700); };
const cartLine = () => p.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pos-cart-'))[1]));
await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-form'); await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#nav [data-view=quotes]', { state: 'attached' }); await p.waitForTimeout(1500);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view));
check('Sales has Sales orders and Quotes', R.nav.includes('orders') && R.nav.includes('quotes') && /Sales orders/.test(await p.evaluate(() => document.querySelector('#nav [data-view=orders]').textContent)), R.nav);
await nav('sell');
await p.click('.pos-tile:has-text("Chesterfield 3 Seater")'); await p.waitForTimeout(300);
await p.click('[data-act=sl-note]'); await p.waitForSelector('#ln-fab');
await p.fill('#ln-fab .fb-pick-q', 'acap'); await p.waitForTimeout(200); await p.click('.fb-pick-row:has-text("Acapella")'); await p.click('#modal-ok'); await p.waitForTimeout(300);
check('the buttons: Sales order and Quote', /Sales order/.test(await txt('[data-act=sl-special]')) && /Quote/.test(await txt('[data-act=sl-quote]')));
await p.click('[data-act=sl-special]'); R.noCust = await toast();
check('a sales order needs the customer, said so', /A sales order needs the customer/.test(R.noCust), R.noCust);
await p.click('[data-act=sl-quote]'); await p.waitForSelector('#qt-days');
await p.fill('#qt-name', 'Pieter Visser'); await p.fill('#qt-phone', '0834445555'); await p.click('#modal-ok');
await p.waitForSelector('.rc-paper', { timeout: 15000 }); R.rc = await txt('#modal');
check('the Quotation shows: number, the fabric, valid until', /Quotation BF-QT-000007/i.test(R.rc) && /R 22,041\.00/.test(R.rc) && /Acapella/.test(R.rc) && /Valid until/i.test(R.rc), R.rc.slice(0, 600));
await p.click('[data-close]'); await p.waitForTimeout(300);
check('the sale stays in the cart', (await cartLine()).lines.length === 1);
await nav('quotes');
R.list = await txt('#screen');
check('Quotes: the new one open, the used one under Used', /BF-QT-000007/.test(R.list) && /Pieter Visser/.test(R.list) && /1 × Chesterfield 3 Seater · Acapella/.test(R.list) && !/BF-QT-000001/.test(R.list), R.list.slice(0, 600));
await patch('pos/retail/products/p_sofa', { priceCents: 960000 }); await p.waitForTimeout(800);
await p.click('[data-act=qt-load]'); await p.waitForTimeout(800); R.loaded = await toast();
const c = await cartLine();
check('loaded into the sale at the quoted price, with the fabric and the quote', /is in the sale at its quoted prices/.test(R.loaded) && c.quoteId && c.lines[0].unitPriceCents === 2204100 && c.lines[0].listPriceCents === 2264100 && c.lines[0].spec.fabricId === 'f_acap' && c.lines[0].quote.docNo === 'BF-QT-000007', [R.loaded, c.lines[0]]);
check('the line says quoted', /quoted BF-QT-000007/i.test(await txt('.pos-cart')));
check('the cart says where it came from', /From quote BF-QT-000007 at its prices/.test(await txt('.pos-cart')));

// ---- Edit: the quote back in the cart to change, Quote saves it as revision 2 over the same number
await nav('quotes');
await p.click('[data-act=qt-edit]'); await p.waitForTimeout(800); R.editToast = await toast();
check('Edit loads it to change, and says how to save', /BF-QT-000007 is in the cart: change what you need, then tap Quote to save it as revision 2/.test(R.editToast), R.editToast);
check('the cart says it is editing the quote', /Editing quote BF-QT-000007/.test(await txt('.pos-cart')) && (await cartLine()).revising === true);
await p.click('[data-act=sl-qty][data-i="0"][data-d="1"]'); await p.waitForTimeout(300);
await p.click('[data-act=sl-quote]'); await p.waitForSelector('#qt-days'); R.revModal = await txt('#modal');
check('the window: save as revision 2, replacing revision 1', /Save quote BF-QT-000007 as revision 2/i.test(R.revModal) && /replaces revision 1 \(R 22,041\.00\)/.test(R.revModal) && /R 44,082\.00/.test(R.revModal), R.revModal.slice(0, 400));
await p.click('#modal-ok'); await p.waitForSelector('.rc-paper', { timeout: 15000 }); R.revToast = await toast(); R.revRc = await txt('#modal');
check('saved: the Quotation says rev 2, two sofas at the quoted price', /saved as revision 2/.test(R.revToast) && /Quotation BF-QT-000007 rev 2/i.test(R.revRc) && /R 44,082\.00/.test(R.revRc) && /Revision 2/.test(R.revRc), [R.revToast, R.revRc.slice(0, 500)]);
await p.click('[data-close]'); await p.waitForTimeout(300);
check('the cart is cleared once the revision is saved', (await cartLine()).lines.length === 0);
await nav('quotes'); R.list2 = await txt('#screen');
check('the list: one quote, marked rev 2, at the new total', /BF-QT-000007/.test(R.list2) && /rev 2/i.test(R.list2) && /R 44,082\.00/.test(R.list2) && !/BF-QT-000008/.test(R.list2), R.list2.slice(0, 500));
const q7 = (await listColl('quotes')).find(q => q.docNo === 'BF-QT-000007');
// ---- To do: a quote near its date is one to follow up
await patch('pos/retail/quotes/' + q7.id, { validUntil: day(2) }); await p.waitForTimeout(900);
await nav('todo'); R.todo = await txt('#screen');
check('To do lists the quote to follow up, with a link to send', /Quotes to follow up/.test(R.todo) && /BF-QT-000007/.test(R.todo) && /Pieter Visser/.test(R.todo) && (await p.locator('[data-bucket=cold] [data-act=qt-link]').count()) === 1, R.todo.slice(0, 500));
check('written as revision 2 with revision 1 kept', q7.revision === 2 && q7.totalCents === 4408200 && q7.revisions.length === 1 && q7.revisions[0].totalCents === 2204100 && q7.lines[0].priceOverride && q7.lines[0].priceOverride.reason === 'Quote BF-QT-000007', q7 && [q7.revision, q7.totalCents, q7.lines[0].priceOverride]);

check('no page errors', errs.length === 0, errs);
await b.close(); if (server) server.kill();
console.log(JSON.stringify({ fails, errs, ok: fails.length === 0 }, null, 1));
process.exit(fails.length ? 1 : 0);
