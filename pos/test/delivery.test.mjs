// Deliveries of sales orders, over HTTP and in the browser: a ready, paid order's client picks a day and
// a slot on their own page (a full slot is not offered, an unpaid order offers none); a manager adds a
// driver with a private link; the shop confirms the day and dispatches it (the tax invoice written once,
// never again on a second dispatch); the driver's page lists it, sends "on the way", reports a problem,
// and takes the client's signature; the order is delivered; a new driver link stops the old one.
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
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, specialOrder: { minDepositPct: 50, leadDays: 21 }, delivery: { defaultFeeCents: 45000, days: [1, 2, 3, 4, 5, 6, 7], slots: ['08:00–12:00', '12:00–17:00'], perSlot: 1, leadDays: 1 }, session: { idleLogoutMinutes: 30, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville' }, active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/products/p_sofa', { name: 'Chesterfield 3 Seater', sku: '', barcodes: [], category: 'Couches', brand: '', type: 'mto', vatClass: 'standard', trackStock: false, costCents: 0, priceCents: 900000, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...srv('BF') });
for (const [id, name, phone] of [['c1', 'Thandi Mokoena', '0825550101'], ['c2', 'Pieter Botha', '0825550202']]) await put('pos/retail/customers/' + id, { name, phone, email: '', vatNo: '', address: { line1: '5 Lane', line2: 'Parow North', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = own.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const pub = async (fn, body) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const tokOf = (link) => (/[?&][td]=([\w-]+)/.exec(link || '') || [])[1];
// an order made, paid in full and ready
const readyOrder = async (cid, tag) => {
  const o = await call('pos-special', { action: 'open', orderId: 'so-dl-' + tag + '-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: cid,
    lines: [{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 900000, discountCents: 0, spec: { size: '2.4 m', fabric: 'Linen', colour: 'Sand' } }], saleDiscountCents: 0, totals: { totalCents: 900000, vatCents: vatIn(900000, 1500) },
    deposit: [{ method: 'card', amountCents: 900000, ref: '1234', cardLast4: '1234' }], signoff: { accepted: true, signedBy: 'Client', signature: sig }, ...bell });
  if (!o.ok) throw new Error('open: ' + o.error);
  const r = await call('pos-special', { action: 'status', orderId: o.order.id, status: 'ready', ...bell });
  if (!r.ok) throw new Error('ready: ' + r.error);
  return r.order;
};

// ---- the client picks a day on their order page; the slot fills (one a slot here)
const o1 = await readyOrder('c1', 'a');
check('ready and paid in full', o1.status === 'ready' && o1.balanceCents === 0, o1);
const l1 = await call('pos-special', { action: 'trackLink', kind: 'order', id: o1.id, ...bell }); const t1 = tokOf(l1.link);
R.v1 = await pub('pos-track', { action: 'view', t: t1 });
check('the page offers days and slots, from tomorrow', Array.isArray(R.v1.slots) && R.v1.slots.length >= 10 && R.v1.slots[0].slots.length === 2 && R.v1.address.line1 === '5 Lane', R.v1.slots && R.v1.slots.slice(0, 2));
const first = R.v1.slots[0];
R.p1 = await pub('pos-track', { action: 'pickSlot', t: t1, kind: 'deliver', date: first.date, slot: '08:00–12:00', address: { line1: '5 Lane', line2: 'Parow North', city: 'Parow' }, note: 'Gate code 1234' });
check('picked: asked for, not yet confirmed', R.p1.delivery && R.p1.delivery.requested && !R.p1.delivery.confirmed && R.p1.delivery.date === first.date, R.p1.delivery || R.p1);
const o1d = await one('specialOrders/' + o1.id);
check('on the order: the request, the address, the driver note', o1d.delivery.requested === true && o1d.delivery.address.city === 'Parow' && o1d.delivery.note === 'Gate code 1234' && o1d.delivery.bookedBy === 'the client', o1d.delivery);
const o2 = await readyOrder('c2', 'b');
const l2 = await call('pos-special', { action: 'trackLink', kind: 'order', id: o2.id, ...bell }); const t2 = tokOf(l2.link);
R.v2 = await pub('pos-track', { action: 'view', t: t2 });
const d2 = R.v2.slots.find(x => x.date === first.date);
check('that slot is full now (one a slot): the other client cannot have it', d2 && !d2.slots.some(x => x.slot === '08:00–12:00') && d2.slots.some(x => x.slot === '12:00–17:00'), d2);
R.full = await pub('pos-track', { action: 'pickSlot', t: t2, kind: 'deliver', date: first.date, slot: '08:00–12:00' });
check('asking for a full slot: refused', R.full.status === 409 && /gone/.test(R.full.error), R.full);
R.unpaid = await (async () => { const o = await call('pos-special', { action: 'open', orderId: 'so-dl-c-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: 'c2', lines: [{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 900000, discountCents: 0, spec: { size: '2 m' } }], saleDiscountCents: 0, totals: { totalCents: 900000, vatCents: vatIn(900000, 1500) }, deposit: [{ method: 'card', amountCents: 450000, cardLast4: '9999' }], signoff: { accepted: true, signedBy: 'P', signature: sig }, ...bell });
  await call('pos-special', { action: 'status', orderId: o.order.id, status: 'ready', ...bell });
  const l = await call('pos-special', { action: 'trackLink', kind: 'order', id: o.order.id, ...bell });
  return { view: await pub('pos-track', { action: 'view', t: tokOf(l.link) }), pick: await pub('pos-track', { action: 'pickSlot', t: tokOf(l.link), kind: 'deliver', date: first.date, slot: '12:00–17:00' }) }; })();
check('a balance owed: no slots offered, picking refused', !R.unpaid.view.slots && R.unpaid.pick.status === 409 && /balance/.test(R.unpaid.pick.error), R.unpaid);

// ---- drivers: a manager adds one; the link is theirs
R.casDrv = await call('pos-special', { action: 'driverSave', name: 'X', ...bell }, cas.idToken); check('a cashier cannot add a driver', R.casDrv.status === 403, R.casDrv);
R.drv = await call('pos-special', { action: 'driverSave', name: 'Sipho Dlamini', phone: '0835550123', ...bell });
const dTok = tokOf(R.drv.driver && R.drv.driver.link);
check('a driver added, with a private link and a message to send it', R.drv.ok && /\/pos\/driver\.html\?d=/.test(R.drv.driver.link) && /your deliveries are on this page/.test(R.drv.text), R.drv);
R.list = await call('pos-special', { action: 'drivers', ...bell }); check('the drivers list', R.list.drivers.length === 1 && R.list.drivers[0].name === 'Sipho Dlamini' && R.list.drivers[0].link === R.drv.driver.link, R.list);

// ---- confirmed, dispatched: the tax invoice is written then
R.conf = await call('pos-special', { action: 'book', orderId: o1.id, kind: 'deliver', date: first.date, slot: '08:00–12:00', address: o1d.delivery.address, note: o1d.delivery.note, ...bell });
check('the shop confirms the client’s day', R.conf.ok && R.conf.delivery.confirmed && R.conf.delivery.requested, R.conf.delivery || R.conf);
const salesBefore = (await coll('sales')).length;
R.disp = await call('pos-special', { action: 'dispatch', orderId: o1.id, driverId: R.drv.driver.id, saleId: 'sos-dl-' + Date.now().toString(36), ...bell });
check('dispatched: out for delivery with Sipho, the tax invoice written', R.disp.ok && R.disp.order.status === 'outForDelivery' && R.disp.order.delivery.driverName === 'Sipho Dlamini' && R.disp.sale && /^BF-\d+/.test(R.disp.sale.docNo) && R.disp.sale.paymentMethods.join() === 'specialOrder', R.disp.error || R.disp.order);
R.again = await call('pos-special', { action: 'dispatch', orderId: o1.id, driverId: R.drv.driver.id, saleId: 'sos-dl2-' + Date.now().toString(36), ...bell });
check('dispatched again: no second invoice', R.again.ok && R.again.again && (await coll('sales')).length === salesBefore + 1, [R.again, (await coll('sales')).length, salesBefore]);
R.cancelOut = await call('pos-special', { action: 'cancel', orderId: o1.id, kind: 'customer', reason: 'x', feeCents: 0, refunds: [], ...bell });
check('out for delivery: not cancelled at the till', R.cancelOut.status === 409, R.cancelOut);

// ---- the driver's page
R.run = await pub('pos-driver', { action: 'run', d: dTok });
check('the driver sees the delivery: the client, the address, the note, the items', R.run.driver.name === 'Sipho Dlamini' && R.run.stops.length === 1 && R.run.stops[0].name === 'Thandi Mokoena' && /5 Lane, Parow North, Parow/.test(R.run.stops[0].address) && R.run.stops[0].note === 'Gate code 1234' && /Chesterfield/.test(R.run.stops[0].items[0]), R.run);
R.way = await pub('pos-driver', { action: 'onTheWay', d: dTok, orderId: o1.id });
check('on the way: a message for the client from the driver, with the order page', R.way.ok && R.way.phone === '0825550101' && /Hi Thandi, it's Sipho from Bellville Furniture: I'm on my way/.test(R.way.text) && R.way.text.includes(l1.link), R.way);
R.tv = await pub('pos-track', { action: 'view', t: t1 }); check('the client’s page: on its way with Sipho', R.tv.status === 'outForDelivery' && R.tv.delivery.onTheWay && R.tv.delivery.driverName === 'Sipho Dlamini' && R.tv.steps.find(s => s.key === 'onTheWay').current, R.tv);
R.iss = await pub('pos-driver', { action: 'issue', d: dTok, orderId: o1.id, note: 'Nobody home' }); check('a problem reported', R.iss.ok && (await one('specialOrders/' + o1.id)).delivery.issue.note === 'Nobody home', R.iss);
R.re = await call('pos-special', { action: 'dispatch', orderId: o1.id, driverId: R.drv.driver.id, saleId: 'sos-dl3-' + Date.now().toString(36), ...bell });
check('sent out again: the problem cleared, still one invoice', R.re.ok && !(await one('specialOrders/' + o1.id)).delivery.issue && (await coll('sales')).length === salesBefore + 1, R.re);
R.noSig = await pub('pos-driver', { action: 'delivered', d: dTok, orderId: o1.id, signedBy: 'Thandi' }); check('delivered without a signature: refused', R.noSig.status === 400, R.noSig);
R.other = await pub('pos-driver', { action: 'delivered', d: dTok, orderId: o2.id, signedBy: 'P', signature: sig }); check('another order (not theirs): refused', R.other.status === 404, R.other);
R.del = await pub('pos-driver', { action: 'delivered', d: dTok, orderId: o1.id, signedBy: 'Thandi Mokoena', signature: sig, note: 'All good' });
const o1f = await one('specialOrders/' + o1.id);
check('delivered and signed on the driver’s phone: the order closes, update due', R.del.ok && o1f.status === 'delivered' && o1f.deliveryNote.signedBy === 'Thandi Mokoena' && o1f.deliveryNote.signature === sig && o1f.updateDue === true && o1f.completedByName === 'Sipho Dlamini', o1f.status);
R.run2 = await pub('pos-driver', { action: 'run', d: dTok }); check('the driver’s list: nothing left, one delivered today', R.run2.stops.length === 0 && R.run2.done.length === 1, R.run2);
R.tv2 = await pub('pos-track', { action: 'view', t: t1 }); check('the client’s page: delivered, the invoice number', R.tv2.done && R.tv2.status === 'delivered' && /^BF-/.test(R.tv2.invoiceNo) && R.tv2.steps.every(s => s.done), R.tv2);
R.upd = await call('pos-special', { action: 'update', orderId: o1.id, ...bell }); check('the thank-you update', /was delivered today/.test(R.upd.text), R.upd.text);
R.newLink = await call('pos-special', { action: 'driverSave', driverId: R.drv.driver.id, name: 'Sipho Dlamini', phone: '0835550123', newLink: true, ...bell });
R.oldLink = await pub('pos-driver', { action: 'run', d: dTok });
check('a new link: the old one stops working', R.newLink.ok && R.newLink.driver.link !== R.drv.driver.link && R.oldLink.status === 404, R.oldLink);

// ---- in the browser: the client picks a day; the driver signs; the shop's To do
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const cp = await ctx.newPage(); cp.on('pageerror', e => errs.push('CLIENT ' + e.message));
await cp.goto('http://localhost:8788/pos/track.html?t=' + t2); await cp.waitForSelector('#pick');
R.pickTxt = (await cp.locator('#pick').innerText()).replace(/\s+/g, ' ');
check('the client page: choose your delivery day', /Choose your delivery day/i.test(R.pickTxt) && /Deliver to me/.test(R.pickTxt), R.pickTxt.slice(0, 200));
await cp.click('#pick [data-day]:nth-child(2)'); await cp.waitForTimeout(200);
await cp.check('#pick input[name=pk-slot] >> nth=0'); await cp.fill('#pk-note', 'Ring twice'); await cp.click('#pk-go');
await cp.waitForSelector('text=the shop will confirm it', { timeout: 8000 }).catch(() => {});
R.asked = (await cp.locator('#app').innerText()).replace(/\s+/g, ' ');
const o2d = await one('specialOrders/' + o2.id);
check('asked for a day on the page: the order has it', /You asked for/.test(R.asked) && o2d.delivery && o2d.delivery.requested && o2d.delivery.note === 'Ring twice', [R.asked.slice(0, 300), o2d.delivery]);
// the driver's page for order 2: confirm and dispatch, then sign on the phone
await call('pos-special', { action: 'book', orderId: o2.id, kind: 'deliver', date: o2d.delivery.date, slot: o2d.delivery.slot, address: o2d.delivery.address, ...bell });
const d2s = await call('pos-special', { action: 'dispatch', orderId: o2.id, driverId: R.drv.driver.id, saleId: 'sos-dl4-' + Date.now().toString(36), ...bell });
check('order 2 dispatched', d2s.ok && d2s.order.status === 'outForDelivery', d2s.error);
const dp = await ctx.newPage(); dp.on('pageerror', e => errs.push('DRIVER ' + e.message));
await dp.goto('http://localhost:8788/pos/driver.html?d=' + tokOf(R.newLink.driver.link)); await dp.waitForSelector('[data-sign]');
R.drvPage = (await dp.locator('#app').innerText()).replace(/\s+/g, ' ');
check('the driver page: Pieter Botha, the address, Map and Call', /Pieter Botha/.test(R.drvPage) && /5 Lane, Parow North, Parow/.test(R.drvPage) && /Map/i.test(R.drvPage) && /Call/i.test(R.drvPage), R.drvPage.slice(0, 400));
await dp.click('[data-sign]'); await dp.waitForSelector('#sg-pad');
{ const box = await dp.locator('#sg-pad').boundingBox(); await dp.mouse.move(box.x + 20, box.y + 40); await dp.mouse.down(); await dp.mouse.move(box.x + 160, box.y + 80, { steps: 8 }); await dp.mouse.up(); }
await dp.click('#sg-go'); await dp.waitForSelector('text=The shop sees it now', { timeout: 8000 }).catch(() => {});
R.drvDone = (await dp.locator('#app').innerText()).replace(/\s+/g, ' ');
check('signed on the driver’s phone: delivered', /The shop sees it now/.test(R.drvDone) && (await one('specialOrders/' + o2.id)).status === 'delivered', R.drvDone.slice(0, 300));
// the shop: To do shows the delivered order and the unpaid one
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
if (FBDIR) await p.context().route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
p.on('pageerror', e => errs.push('POS ' + e.message));
await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-form'); await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
await p.waitForSelector('#nav [data-view=todo]', { state: 'attached' }); await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelector('#nav [data-view="todo"]').click()); await p.waitForTimeout(1500);
R.todo = (await p.locator('#screen').innerText()).replace(/\s+/g, ' ');
check('To do: ready but owed, delivered this week', /Ready, balance owed/.test(R.todo) && /Delivered or collected this week/.test(R.todo) && /Thandi Mokoena/.test(R.todo), R.todo.slice(0, 600));

// dispatch from To do: a ready, paid, confirmed delivery
const o3 = await readyOrder('c1', 'd');
const v3 = await pub('pos-track', { action: 'view', t: tokOf((await call('pos-special', { action: 'trackLink', kind: 'order', id: o3.id, ...bell })).link) });
const day3 = v3.slots[v3.slots.length - 1];
await call('pos-special', { action: 'book', orderId: o3.id, kind: 'deliver', date: day3.date, slot: day3.slots[0].slot, address: { line1: '5 Lane', city: 'Parow' }, ...bell });
await p.waitForTimeout(1500);
R.todo2 = (await p.locator('#screen').innerText()).replace(/\s+/g, ' ');
check('To do: a delivery to dispatch', /Deliveries to dispatch/.test(R.todo2) && new RegExp(o3.docNo).test(R.todo2), R.todo2.slice(0, 600));
await p.click(`[data-act=so-dispatch][data-id="${o3.id}"]`); await p.waitForSelector('#dp-driver');
R.dpModal = (await p.locator('#modal').innerText()).replace(/\s+/g, ' ');
check('the dispatch window: the driver, the invoice said', /Sipho Dlamini/.test(R.dpModal) && /tax invoice is written now/.test(R.dpModal), R.dpModal.slice(0, 300));
await p.click('#modal-ok'); await p.waitForTimeout(1200);
R.dpToast = (await p.locator('#toast').innerText().catch(() => '')).trim();
check('dispatched from the till: out for delivery, invoiced', /is out for delivery · tax invoice BF-\d+/.test(R.dpToast) && (await one('specialOrders/' + o3.id)).status === 'outForDelivery', R.dpToast);
if (await p.locator('#modal').count()) { await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
// Admin → Settings: the deliveries and the drivers
await p.evaluate(() => document.querySelector('#nav [data-view="admin"]').click()); await p.waitForTimeout(800);
await p.evaluate(() => { const b = document.querySelector('[data-sub="settings"]'); if (b) b.click(); }); await p.waitForSelector('#se-drivers table', { timeout: 8000 }).catch(() => {});
R.set = (await p.locator('#screen').innerText()).replace(/\s+/g, ' ');
check('settings: the delivery days, slots and the driver', /DELIVERIES/i.test(R.set) && (await p.inputValue('#se-dl-slots')) === '08:00–12:00, 12:00–17:00' && (await p.inputValue('#se-dl-per')) === '1' && /Sipho Dlamini/.test(R.set) && /Send their link/i.test(R.set), R.set.slice(R.set.search(/DELIVERIES/i), R.set.search(/DELIVERIES/i) + 400));

check('no page errors', errs.length === 0, errs);
await b.close(); if (server) server.kill();
console.log(JSON.stringify({ fails, errs, ok: fails.length === 0 }, null, 1));
process.exit(fails.length ? 1 : 0);
