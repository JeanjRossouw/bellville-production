// All businesses in the browser, through the real rules: the owner of two
// shop companies (one with two stores) who is also the owner of a Factory
// Manager company, and a member of a second one whose role does not show
// invoices. Today against the same day last week per business and all
// together; refunds, void invoices, credit notes and cancelled orders
// handled; what the factory invoiced the owner's own shop kept out of the
// total; a new sale showing up live; the screen is the owner's only.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
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
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-01T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('jean@shop.co.za'), mgr = await mk('mgr@shop.co.za');

// local days, the browser runs in the same time zone
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n) => String(n).padStart(2, '0');
const at = (daysAgo, h = 10, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, h, m); };
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// early in the day, so "now" is always after them; the live sale comes later
const T = (h, m) => new Date(Math.max(at(0, 0, 0).getTime() + m * 1000, Date.now() - (61 - m) * 60000)).toISOString();

// ---- the shops
await put('pos/retail/users/' + own.localId, { email: 'jean@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + mgr.localId, { email: 'mgr@shop.co.za', name: 'Mo', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('*') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/entities/RC', { legalName: 'ReptiCube', tradingName: 'ReptiCube', vatRegistered: false, invoicePrefix: 'RC', active: true, ...srv('RC') });
for (const [e, id, name] of [['BF', 'BF-BELL', 'Bellville'], ['BF', 'BF-DBN', 'Durbanville'], ['RC', 'RC-1', 'ReptiCube shop']]) await put('pos/retail/stores/' + id, { entityId: e, name, active: true, paymentMethods: ['cash', 'card'], ...srv(e, id) });
for (const e of ['BF', 'RC']) await put('pos/retail/settings/' + e, { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, session: { idleLogoutMinutes: 30, pinLength: 6 }, ...srv(e) });
const sale = (id, e, s, cents, when, cashier = 'Thandi') => put('pos/retail/sales/' + id, { docNo: e + '-' + id, totalCents: cents, lineCount: 1, clientCreatedAt: when, cashierName: cashier, verified: true, ...srv(e, s) });
await sale('s1', 'BF', 'BF-BELL', 50000, T(0, 5));
await sale('s2', 'BF', 'BF-DBN', 30000, T(0, 10), 'Pieter');
await sale('s3', 'BF', 'BF-BELL', 40000, at(7, 11).toISOString());           // the same day last week
await sale('s4', 'RC', 'RC-1', 12000, T(0, 15), 'Lee');
await sale('s5', 'BF', 'BF-BELL', 99900, at(80).toISOString());               // long ago: not read
await put('pos/retail/creditNotes/cn1', { docNo: 'BF-CN-000001', totalCents: 5000, lineCount: 1, clientCreatedAt: T(0, 20), cashierName: 'Thandi', verified: true, ...srv('BF', 'BF-BELL') });

// ---- the factories (the same login)
const none = { pos: 'none', orders: 'none', quotes: 'none', customers: 'none', factory: 'none', costing: 'none', stock: 'none', storeroom: 'none', scan: 'none', deliveries: 'none', invoices: 'none', profit: 'none', wages: 'none', settings: 'none' };
await put('users/' + own.localId, { email: 'jean@shop.co.za', companyId: 'C1', companies: { C1: 'Couch Potato', C2: 'Sister Factory' } });
await put('companies/C1', { name: 'Couch Potato', ownerUid: own.localId, plan: 'trial', status: 'trial' });
await put(`companies/C1/members/${own.localId}`, { role: 'owner', email: 'jean@shop.co.za', name: 'Jean' });
await put('companies/C2', { name: 'Sister Factory', ownerUid: 'someone', plan: 'trial', status: 'trial' });
await put(`companies/C2/members/${own.localId}`, { role: 'orders', email: 'jean@shop.co.za', name: 'Jean' });
await put('companies/C2/roles/orders', { name: 'Orders', perms: { ...none, orders: 'edit' } });
const inv = (id, o) => put('companies/C1/invoices/' + id, { invoiceNo: id.toUpperCase(), customerName: 'Retail Co', customerId: 'c1', date: ymd(at(0)), incl: true, status: 'issued', createdAt: T(0, 30), ...o });
await inv('inv-1', { total: 9000 });
await inv('inv-2', { total: 4500, date: ymd(at(7)), createdAt: at(7, 9).toISOString() });
await inv('inv-3', { total: 1000, status: 'void' });
await inv('cn-1', { kind: 'credit', total: -500, status: 'paid', createdAt: T(0, 35) });
await inv('inv-4', { total: 2000, customerId: 'pos-BF-BF-BELL', customerName: 'Bellville Furniture · Bellville', createdAt: T(0, 40) });
await put('companies/C1/orders/o1', { orderNo: 'CP-1001', product: 'Sofa', qty: 2, priceEach: 4500, customerName: 'Retail Co', status: 'new', createdAt: T(0, 25) });
await put('companies/C1/orders/o2', { orderNo: 'CP-1002', product: 'Chair', qty: 1, priceEach: 3000, customerName: 'Retail Co', status: 'cancelled', createdAt: T(0, 26) });
await put('companies/C2/orders/x1', { orderNo: 'SF-1', product: 'Bed', qty: 1, priceEach: 7000, customerName: 'Someone', status: 'new', createdAt: T(0, 27) });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
async function open(email, width = 1280) {
  const ctx = await b.newContext({ viewport: { width, height: 900 }, timezoneId: TZ });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(email + ' PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource|watch .* failed/i.test(m.text())) errs.push(email + ' ' + m.text().slice(0, 200)); });
  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForSelector('#login-form'); await p.fill('#login-email', email); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
  await p.waitForSelector('#nav [data-view=home]', { state: 'attached' }); await p.waitForTimeout(1500);
  return p;
}
const txt = (p, sel) => p.locator(sel).innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const box = (p, biz, period = 'today') => txt(p, `[data-biz="${biz}"] [data-period="${period}"]`);

// ---- the owner
const p = await open('jean@shop.co.za');
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view));
check('the owner has All businesses in Office, before Reports', R.nav.join().includes('overview,reports,admin'), R.nav);
check('Home links to it', await p.locator('[data-act=go-overview]').count() === 1);
await p.click('[data-act=go-overview]');
await p.waitForFunction(() => /Live/.test(document.querySelector('#screen').innerText) && document.querySelectorAll('.ov-biz').length >= 4, null, { timeout: 20000 });
await p.waitForTimeout(800);
R.screen = await txt(p, '#screen');
check('the head: 4 businesses, live', /All businesses/i.test(R.screen) && /Live/.test(R.screen) && /4 businesses/.test(R.screen), R.screen.slice(0, 200));
check('the bar says where you are', /All businesses/i.test(await txt(p, '#nav .tab-group.has-on')));

R.bf = await box(p, 'pos:BF');
check('Bellville Furniture today: R 800 sold less R 50 refunded = R 750, 2 sales, average R 400, against R 400 last week (▲ 88%)', /R 750\.00/.test(R.bf) && /▲ 88%/.test(R.bf) && /2 sales · average R 400\.00/.test(R.bf) && /last \w+day: R 400\.00/.test(R.bf), R.bf);
R.stores = await txt(p, '[data-biz="pos:BF"] .ov-stores');
check('its two stores: Bellville R 450 against R 400, Durbanville R 300 new', /Bellville R 450\.00 ▲ 13% R 400\.00/.test(R.stores) && /Durbanville R 300\.00 new R 0\.00/.test(R.stores), R.stores);
R.rc = await box(p, 'pos:RC');
check('ReptiCube today R 120, new, one store so no store table', /R 120\.00 new/.test(R.rc) && /1 sale · average R 120\.00/.test(R.rc) && await p.locator('[data-biz="pos:RC"] .ov-stores').count() === 0, R.rc);
R.c1 = await box(p, 'fm:C1');
check('Couch Potato today: R 9 000 + R 2 000 − R 500 credit = R 10 500 over 2 invoices (void left out), against R 4 500 (▲ 133%)', /R 10,500\.00 ▲ 133%/.test(R.c1) && /2 invoices · average R 5,500\.00/.test(R.c1) && /R 4,500\.00/.test(R.c1), R.c1);
check('orders taken today: CP-1001 2 × R 4 500 = R 9 000, the cancelled one left out', /Orders taken: R 9,000\.00 · 1 order new/.test(R.c1), R.c1);
R.c1card = await txt(p, '[data-biz="fm:C1"]');
check('the R 2 000 to the own shop is named', /includes R 2,000\.00 invoiced to your own shops/.test(R.c1card), R.c1card.slice(-200));
R.c2 = await txt(p, '[data-biz="fm:C2"]');
check('Sister Factory: the role shows no invoices', /Sister Factory/i.test(R.c2) && /does not show its invoices/.test(R.c2) && !/Orders taken/.test(R.c2), R.c2);
R.all = await box(p, 'all');
check('everything together today: R 750 + R 120 + R 8 500 = R 9 370 (the R 2 000 to the own shop left out), against R 400 + R 4 500 = R 4 900', /R 9,370\.00 ▲ 91%/.test(R.all) && /R 4,900\.00/.test(R.all), R.all);
check('the note on what is left out', /left out here/.test(await txt(p, '[data-biz=all]')));
R.feed = await txt(p, '.ov-feed');
check('the feed: sales with store and cashier, refunds, invoices, credit notes, orders; not the void invoice, the cancelled order or last week’s sale before today’s', /Bellville Furniture · Durbanville Sale BF-s2 · Pieter R 300\.00/.test(R.feed) && /Refund BF-CN-000001 · Thandi −R 50\.00/.test(R.feed) && /Invoice INV-1 · Retail Co R 9,000\.00/.test(R.feed) && /Credit note CN-1/.test(R.feed) && /Order CP-1001 · Sofa × 2 · Retail Co order R 9,000\.00/i.test(R.feed) && /Order SF-1 · Bed/.test(R.feed) && /from your shop/.test(R.feed) && !/INV-3/.test(R.feed) && !/CP-1002/.test(R.feed) && !/BF-s5/.test(R.feed) && R.feed.indexOf('BF-s2') < R.feed.indexOf('BF-s3'), R.feed.slice(0, 900));
check('the week and month boxes are there for each business', await p.locator('[data-period=week]').count() === 4 && await p.locator('[data-period=month]').count() === 4);

// ---- live: a new sale at Bellville shows up with no reload
await sale('s6', 'BF', 'BF-BELL', 10000, new Date().toISOString(), 'Thandi');
await p.waitForFunction(() => /R 850\.00/.test((document.querySelector('[data-biz="pos:BF"] [data-period=today]') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
R.bf2 = await box(p, 'pos:BF'); R.feed2 = await txt(p, '.ov-feed tbody tr:first-child');
check('live: Bellville Furniture now R 850 over 3 sales, the sale on top of the feed', /R 850\.00/.test(R.bf2) && /3 sales/.test(R.bf2) && /Sale BF-s6/.test(R.feed2), [R.bf2, R.feed2]);
await p.screenshot({ path: S + '/shots/overview.png', fullPage: true });

// ---- on a phone
const ph = await open('jean@shop.co.za', 390);
await ph.evaluate(() => document.querySelector('#nav [data-view=overview]').click());
await ph.waitForSelector('[data-biz=all] [data-period=today]', { timeout: 20000 }); await ph.waitForTimeout(1200);
R.wide = await ph.evaluate(() => document.documentElement.scrollWidth);
check('a phone: no sideways scroll', R.wide <= 390, R.wide);
await ph.screenshot({ path: S + '/shots/overview-phone.png', fullPage: true });

// ---- a manager does not get it
const m = await open('mgr@shop.co.za');
R.mnav = await m.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view));
check('a manager: no All businesses, no Home link', !R.mnav.includes('overview') && await m.locator('[data-act=go-overview]').count() === 0, R.mnav);

check('no page errors', errs.length === 0, errs);
await b.close(); if (server) server.kill();
console.log(JSON.stringify({ fails, errs, ok: fails.length === 0 }, null, 1));
process.exit(fails.length ? 1 : 0);
