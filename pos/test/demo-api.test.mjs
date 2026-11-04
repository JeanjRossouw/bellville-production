// Factory Manager POS: the demo business. A fresh login signs up a space of its own, then builds Demo Furniture
// Co there and replays two weeks of trading through the real server code; the first shops' owner is refused.
// Every document carries its day, stock never goes below zero, the registers open and close, orders move.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ fails, ...R, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : 'timestampValue' in f ? f.timestampValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const listIn = async (gid, coll) => { const out = []; let token = ''; do { const r = await (await fetch(`${docs}/pos/${gid}/${coll}?pageSize=300${token ? '&pageToken=' + token : ''}`, { headers: H })).json(); out.push(...(r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) }))); token = r.nextPageToken || ''; } while (token); return out; };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
const demo = await mk('demo@newshop.co.za');

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const t0 = Date.now();

// ---- a space of its own; the first shops' owner is refused
R.up = await call('pos-signup', { action: 'start', businessName: 'Demo Furniture Co', name: 'Demo Owner' }, demo.idToken);
const G = R.up.groupId;
check('the demo login has a space of its own', R.up.ok && /^g/.test(G || ''), R.up);
R.notHere = await call('pos-demo', { action: 'plan' }, own.idToken);
check('the first shops’ owner cannot build it in their space', R.notHere.status === 403 && /space of its own/.test(R.notHere.error), R.notHere);
R.plan = await call('pos-demo', { action: 'plan' }, demo.idToken);
check('the plan: six months of trading days, Sundays left out, none done', R.plan.ok && R.plan.days.length > 150 && R.plan.days.length < 160 && R.plan.done.length === 0 && !R.plan.seeded && !R.plan.days.some(d => new Date(d + 'T12:00:00Z').getUTCDay() === 0), R.plan.error || [R.plan.days && R.plan.days.length, R.plan.from, R.plan.to]);

// ---- the business
R.seed = await call('pos-demo', { action: 'seed' }, demo.idToken);
check('seeded: the staff with their PINs, 36 customers', R.seed.ok && R.seed.seeded && R.seed.customers === 36 && R.seed.staff.length === 3 && R.seed.staff.every(s => /^\d{6}$/.test(s.pin)), R.seed.error || R.seed);
const [ents, stores, regs, users, prods, vars, fabs, custs, levels] = await Promise.all(['entities', 'stores', 'registers', 'users', 'products', 'variants', 'fabrics', 'customers', 'stockLevels'].map(c => listIn(G, c)));
check('the company, two stores with tills, four staff (the owner too), products with couches in fabrics, opening stock at both stores', ents.length === 1 && ents[0].id === 'DM' && ents[0].vatRegistered && stores.length === 2 && regs.length === 2 && users.length === 4 && users.filter(u => u.pinSet).length === 3 && prods.length === 15 && vars.length === 2 && fabs.length === 6 && custs.length === 36 && custs.filter(c => c.accountEnabled).length === 6 && levels.length === 22 && levels.every(l => l.onHandQty > 0 && l.avgCostCents > 0), [ents.length, stores.length, regs.length, users.length, prods.length, vars.length, fabs.length, custs.length, levels.length]);
check('every seeded record is dated at the start of the six months', ents[0].createdAt.slice(0, 10) === R.plan.from && custs.every(c => c.createdAt.slice(0, 10) === R.plan.from), [ents[0].createdAt, R.plan.from]);
R.seedAgain = await call('pos-demo', { action: 'seed' }, demo.idToken);
check('seeding again changes nothing', R.seedAgain.ok && !R.seedAgain.seeded && (await listIn(G, 'customers')).length === 36, R.seedAgain);

// ---- two weeks of trading
const days = R.plan.days.slice(0, 12);
R.days = [];
for (const d of days) { const r = await call('pos-demo', { action: 'day', date: d }, demo.idToken); R.days.push({ d, ok: r.ok, sales: r.sales, orders: r.orders, quotes: r.quotes, laybys: r.laybys, returns: r.returns, skipped: (r.skipped || []).slice(0, 3), error: r.error }); }
check('every day traded', R.days.every(x => x.ok), R.days.filter(x => !x.ok));
const sum = (k) => R.days.reduce((n, x) => n + (x[k] || 0), 0);
check('sales every day, orders and quotes over the fortnight, nothing skipped', sum('sales') >= 60 && R.days.every(x => x.sales >= 3) && sum('orders') >= 2 && sum('quotes') >= 1 && R.days.every(x => !x.skipped.length), R.days);
R.dayAgain = await call('pos-demo', { action: 'day', date: days[0] }, demo.idToken);
check('a day done is done', R.dayAgain.ok && R.dayAgain.again === true, R.dayAgain);
R.future = await call('pos-demo', { action: 'day', date: '2099-01-01' }, demo.idToken);
check('not a day that has come yet', R.future.status === 400, R.future);

const [sales, shifts, orders, quotes, laybys, notes, pays, moves, levels2, audit] = await Promise.all(['sales', 'shifts', 'specialOrders', 'quotes', 'laybys', 'creditNotes', 'payments', 'stockMovements', 'stockLevels', 'auditLog'].map(c => listIn(G, c)));
check('the sales carry their day, numbered per till, both stores, cash and card and EFT among them, some on account', sales.length === sum('sales') && sales.every(s => days.includes(s.clientCreatedAt.slice(0, 10)) && s.createdAt.slice(0, 10) === s.clientCreatedAt.slice(0, 10)) && new Set(sales.map(s => s.storeId)).size === 2 && ['cash', 'card', 'eft', 'account'].every(m => sales.some(s => (s.paymentMethods || []).includes(m))) && sales.every(s => /^DM-\d{6}$/.test(s.docNo)), [sales.length, sum('sales'), sales.slice(0, 2).map(s => [s.docNo, s.clientCreatedAt, s.paymentMethods])]);
check('a register opened and closed at each store every day, the cash counted', shifts.length === days.length * 2 && shifts.every(s => s.status === 'closed' && s.openedAt.slice(0, 10) === s.closedAt.slice(0, 10) && days.includes(s.openedAt.slice(0, 10))) && shifts.some(s => s.countedByMethod.cash > s.openingFloat.totalCents), [shifts.length, shifts.slice(0, 2).map(s => [s.status, s.openedAt, s.closedAt, s.varianceCents])]);
check('cash-ups balance (a rand or two out at most)', shifts.every(s => Math.abs(s.varianceCents) <= 5000), shifts.map(s => s.varianceCents));
check('sales orders: couches in a fabric with a deposit, dated on their day, expected three weeks on', orders.length === sum('orders') && orders.every(o => o.lines[0].spec && o.lines[0].spec.fabricId && o.paidCents > 0 && days.includes(o.openedAt.slice(0, 10)) && o.expectedAt > o.openedAt.slice(0, 10)), orders.map(o => [o.docNo, o.status, o.openedAt, o.paidCents, o.lines[0].spec]));
check('some orders moved on within the fortnight', orders.some(o => ['depositPaid', 'inProduction', 'ready'].includes(o.status)) && orders.some(o => (o.statusHistory || []).length > 1), orders.map(o => [o.docNo, o.status, (o.statusHistory || []).length]));
check('quotes priced by the server, dated on their day', quotes.length === sum('quotes') && quotes.every(q => q.totalCents > 1000000 && days.includes(q.quotedAt.slice(0, 10))), quotes.map(q => [q.docNo, q.totalCents, q.quotedAt, q.status]));
check('stock never below zero', levels2.every(l => l.onHandQty >= 0), levels2.filter(l => l.onHandQty < 0));
check('every rand that moved is a payment row on its shift, and the stock movements say why', pays.filter(p => p.docType === 'sale').length >= sales.length && pays.filter(p => p.method === 'cash').every(p => p.shiftId) && moves.some(m => m.reason === 'opening') && moves.some(m => m.reason === 'sale'), [pays.length, moves.length]);
check('audited as the demo staff, not the owner', audit.filter(a => a.action === 'sale.commit').every(a => /Sipho|Nadia/.test(a.actorName)), audit.filter(a => a.action === 'sale.commit').slice(0, 3).map(a => a.actorName));
check('the staff can sign in by PIN', users.filter(u => u.pinSet).every(u => u.role !== 'owner') && (await listIn(G, 'pinHashes')).length === 3);

// ---- finish
R.fin = await call('pos-demo', { action: 'finish' }, demo.idToken);
const quotes2 = await listIn(G, 'quotes');
check('finished: quotes valid from their own day, the counts', R.fin.ok && R.fin.days === days.length && R.fin.counts.sales === sales.length && quotes2.every(q => q.validUntil === new Date(Date.parse(q.quotedAt.slice(0, 10) + 'T12:00:00Z') + (q.validDays || 14) * 86400000).toISOString().slice(0, 10)), R.fin.error || [R.fin, quotes2.map(q => [q.quotedAt, q.validUntil])]);
check('the space is marked as a demo', (await (async () => { const r = await (await fetch(`${docs}/posGroups/${G}`, { headers: H })).json(); return r.fields && r.fields.demo && r.fields.demo.booleanValue; })()) === true);
R.seconds = Math.round((Date.now() - t0) / 1000);

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 8000));
console.log(fails.length ? fails.length + ' FAILED' : 'demo-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
