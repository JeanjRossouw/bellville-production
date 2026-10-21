// Retail POS step 8: the pos-shift function over HTTP. Open with a float,
// a sale refused before and carrying the shift after, cash out, the
// X-report figures, a close within the limit, one over it needing a note
// (and a manager), the Z-report, the register freed, and a second shift.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ fails, ...R, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : f.doubleValue;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, cash: { varianceLimitCents: 5000 }, reports: { phone: '0821112222', email: 'owner@shop.co.za' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: '', ...srv('BF', 'BF-BELL') });
const secret = 'shift-secret';
await put('pos/retail/devices/dev_s', { label: 'Till 1', registerId: 'r1', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_s') });
await put('pos/retail/products/p_c', { name: 'Cushion', sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: false, costCents: 5000, priceCents: 19900, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const till = { deviceId: 'dev_s', secret };
let n = 0;
const sale = (o = {}) => ({ action: 'commit', saleId: 'dev_s-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_c', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) }, tenders: [{ method: 'cash', amountCents: 19900, tenderedCents: 20000 }], ...till, ...o });

R.closedSale = await call('pos-sale', sale()); check('a sale on a closed register: 409', R.closedSale.status === 409 && /closed/.test(R.closedSale.error), R.closedSale);
R.status0 = await call('pos-shift', { action: 'status', ...till }); check('status: register known, no shift', R.status0.ok && R.status0.register.name === 'Till 1' && R.status0.shift === null, R.status0);
R.badFloat = await call('pos-shift', { action: 'open', ...till, float: { denoms: { '10000': 2 }, totalCents: 999 } }); check('a float whose total does not match its notes: 400', R.badFloat.status === 400, R.badFloat);
R.open = await call('pos-shift', { action: 'open', ...till, float: { denoms: { '10000': 3, '2000': 5, '100': 10 }, totalCents: 41000 } });
check('opened with the float', R.open.ok && R.open.shift.status === 'open' && R.open.shift.openingFloat.totalCents === 41000 && R.open.shift.openedByName === 'Cathy', R.open);
const shiftId = R.open.shift.id;
check('the register points at the shift', (await getDoc('pos/retail/registers/r1')).currentShiftId === shiftId);
R.openAgain = await call('pos-shift', { action: 'open', ...till, float: { denoms: {}, totalCents: 0 } }); check('opening twice: 409', R.openAgain.status === 409, R.openAgain);

// sales on the shift: two cash (one with change), one card, one EFT awaiting
R.s1 = await call('pos-sale', sale()); R.s2 = await call('pos-sale', sale({ tenders: [{ method: 'cash', amountCents: 19900, tenderedCents: 50000 }] }));
R.s3 = await call('pos-sale', sale({ tenders: [{ method: 'card', amountCents: 19900, cardLast4: '1111' }] })); R.s4 = await call('pos-sale', sale({ tenders: [{ method: 'eft', amountCents: 19900, status: 'awaiting', ref: 'E1' }] }));
check('four sales carry the shift', [R.s1, R.s2, R.s3, R.s4].every(x => x.ok && x.sale.shiftId === shiftId), [R.s1, R.s2, R.s3, R.s4].map(x => x.error || x.sale.shiftId));
// cash out by a cashier needs a supervisor's token; the owner may on their own
R.outNoTok = await call('pos-shift', { action: 'cashMove', ...till, shiftId, kind: 'out', amountCents: 10000, reason: 'Cash drop' }); check('cash out by a cashier without approval: 403', R.outNoTok.status === 403 && /supervisor/.test(R.outNoTok.error), R.outNoTok);
R.out = await call('pos-shift', { action: 'cashMove', ...till, shiftId, kind: 'out', amountCents: 10000, reason: 'Cash drop to the safe' }, own.idToken); check('cash out by the owner', R.out.ok && R.out.movement.kind === 'out', R.out);
R.in = await call('pos-shift', { action: 'cashMove', ...till, shiftId, kind: 'in', amountCents: 2000, reason: 'Change from the bank' }, own.idToken); check('cash in', R.in.ok, R.in);
R.noReason = await call('pos-shift', { action: 'cashMove', ...till, shiftId, kind: 'in', amountCents: 2000, reason: '' }, own.idToken); check('no reason: 400', R.noReason.status === 400, R.noReason);
// the X-report
R.x = await call('pos-shift', { action: 'status', ...till });
const f = R.x.figures;
check('X-report: 4 sales, by method, cash in/out, expected cash = float + cash sales + in − out', f.salesCount === 4 && f.salesTotalCents === 79600 && f.byMethod.cash === 39800 && f.byMethod.card === 19900 && f.byMethod.eft === 19900 && f.cashIn === 2000 && f.cashOut === 10000 && f.expectedCash === 41000 + 39800 + 2000 - 10000 && f.awaitingCents === 19900 && f.vatCents === 4 * vatIn(19900, 1500), f);
// a close over the limit without a note: refused, the drawer counted R 100 short
const expectedCash = f.expectedCash;
const shortBy100 = { denoms: { '10000': Math.floor((expectedCash - 10000) / 10000), '100': Math.round(((expectedCash - 10000) % 10000) / 100) }, totalCents: expectedCash - 10000 };
R.closeShort = await call('pos-shift', { action: 'close', ...till, shiftId, counted: { cash: shortBy100, card: 19900, eft: null } }); check('R 100 short, limit R 50, no note: 400 asking for a manager', R.closeShort.status === 400 && /manager's note/.test(R.closeShort.error), R.closeShort);
R.closeShortNote = await call('pos-shift', { action: 'close', ...till, shiftId, counted: { cash: shortBy100, card: 19900, eft: null }, note: 'Gave R 100 too much change' }); check('…with a note but by a cashier without a manager: 403', R.closeShortNote.status === 403, R.closeShortNote);
// a manager's approval token: from pos-auth's override (the owner approves with a PIN would be the till's way; here the owner closes directly)
R.close = await call('pos-shift', { action: 'close', ...till, shiftId, counted: { cash: shortBy100, card: 19900, eft: null }, note: 'Gave R 100 too much change' }, own.idToken);
check('closed by the owner with the note: variance −R 100 recorded, Z-report saved', R.close.ok && R.close.shift.status === 'closed' && R.close.shift.varianceCents === -10000 && R.close.shift.closingNote === 'Gave R 100 too much change' && R.close.shift.zReport.salesCount === 4 && R.close.shift.expectedByMethod.cash === expectedCash && R.close.shift.countedByMethod.card === 19900 && R.close.shift.varianceByMethod.card === 0 && R.close.shift.varianceByMethod.eft === null, R.close.shift && { v: R.close.shift.varianceByMethod, e: R.close.shift.expectedByMethod });
check('the owner’s details for the summary come back', R.close.reports && R.close.reports.phone === '0821112222', R.close.reports);
check('the register is free again', (await getDoc('pos/retail/registers/r1')).currentShiftId === '');
R.saleAfter = await call('pos-sale', sale()); check('no selling after the close', R.saleAfter.status === 409, R.saleAfter);
const audit = await listColl('auditLog');
check('audit: open, cash out, cash in, close with the variance', ['shift.open', 'cash.out', 'cash.in', 'shift.close'].every(a => audit.some(x => x.action === a)) && audit.find(x => x.action === 'shift.close').details.varianceCents === -10000, audit.map(a => a.action));
// a second shift, closed spot on
R.open2 = await call('pos-shift', { action: 'open', ...till, float: { denoms: { '5000': 2 }, totalCents: 10000 } }); check('a second shift opens', R.open2.ok, R.open2);
R.s5 = await call('pos-sale', sale());
R.close2 = await call('pos-shift', { action: 'close', ...till, shiftId: R.open2.shift.id, counted: { cash: { denoms: { '10000': 2, '5000': 1, '1000': 4, '100': 9 }, totalCents: 29900 }, card: 0, eft: 0 } });
check('a cashier closes a shift that balances to the cent', R.close2.ok && R.close2.shift.varianceCents === 0 && R.close2.shift.salesCount === 1, R.close2.shift ? R.close2.shift.varianceByMethod : R.close2);
const shifts = await listColl('shifts'); check('two closed shifts, each with its Z-report', shifts.length === 2 && shifts.every(s => s.status === 'closed' && s.zReport && s.zReport.closedAt), shifts.map(s => s.status));

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 5000));
console.log(fails.length ? fails.length + ' FAILED' : 'shift-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
