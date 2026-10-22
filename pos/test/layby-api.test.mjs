// Retail POS step 11: the pos-layby function over HTTP. Opening needs the
// customer, a deposit of at least the minimum, a signed agreement and no
// made-to-order goods; stock is reserved; the penalty in settings is capped
// at 1%; instalments at another store; collection writes the tax invoice
// paid by the lay-by and moves the stock; cancellation with the penalty
// breakdown and a refund that must add up, none on death; reminders and
// the report.
import { spawn } from 'node:child_process';
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
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za'), sup = await mk('sam@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', active: true, ...srv('BF') });
// the penalty in settings is 10%: the law caps it at 1
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, layby: { minDepositPct: 20, termDays: 90, penaltyPct: 10, frequency: 'monthly' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-PAROW') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', priceCents: 50000, costCents: 20000 });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, priceCents: 1500000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 3, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' }, parow = { entityId: 'BF', storeId: 'BF-PAROW', registerId: '' };
let n = 0;
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const openBody = (lines, total, deposit, o = {}) => ({ action: 'open', laybyId: 'lb-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines, saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, deposit, agreement: { accepted: true, signedBy: 'T Mokoena', signature: sig }, ...bell, ...o });
const two = [{ productId: 'p_cushion', variantId: '', qty: 2, unitPriceCents: 19900, discountCents: 0 }, { productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }];

// ---- opening: what is refused
R.noCust = await call('pos-layby', openBody(two, 89800, [{ method: 'cash', amountCents: 20000, tenderedCents: 20000 }], { customerId: '' })); check('no customer: refused', R.noCust.status === 400 && /customer/.test(R.noCust.error), R.noCust);
R.mto = await call('pos-layby', openBody([{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0 }], 1500000, [{ method: 'card', amountCents: 300000 }])); check('made-to-order: refused, a special order', R.mto.status === 400 && /special order/.test(R.mto.error), R.mto);
R.small = await call('pos-layby', openBody(two, 89800, [{ method: 'cash', amountCents: 10000, tenderedCents: 10000 }])); check('deposit under 20%: refused', R.small.status === 400 && /at least 20%/.test(R.small.error) && /R 179\.60/.test(R.small.error), R.small);
R.unsigned = await call('pos-layby', openBody(two, 89800, [{ method: 'cash', amountCents: 20000, tenderedCents: 20000 }], { agreement: { accepted: true, signedBy: '' } })); check('unsigned agreement: refused', R.unsigned.status === 400 && /sign/.test(R.unsigned.error), R.unsigned);
R.later = await call('pos-layby', openBody(two, 89800, [{ method: 'eft', amountCents: 20000, status: 'awaiting' }])); check('an awaiting EFT is not a deposit', R.later.status === 400 && /received now/.test(R.later.error), R.later);

// ---- opened: numbered, reserved, the deposit a payment, the schedule within the term
const b1 = openBody(two, 89800, [{ method: 'cash', amountCents: 20000, tenderedCents: 20000 }]);
R.open = await call('pos-layby', b1);
const L = R.open.layby || {};
check('lay-by opened as BF-LB-000001', R.open.ok && L.docNo === 'BF-LB-000001' && L.status === 'open', R.open.error || L.docNo);
check('deposit, balance, schedule of 3 monthly instalments adding up', L.depositCents === 20000 && L.paidCents === 20000 && L.balanceCents === 69800 && L.schedule.length === 3 && L.schedule.reduce((s, x) => s + x.amountCents, 0) === 69800 && L.schedule[0].amountCents === 23266 && L.schedule[2].amountCents === 23268, L.schedule);
check('term 90 days, due date set', L.termDays === 90 && L.dueAt === new Date(Date.parse(L.openedAt) + 90 * 86400000).toISOString().slice(0, 10), [L.dueAt, L.openedAt]);
check('penalty capped at 1% and written into the agreement', L.penaltyPct === 1 && L.penaltyCapCents === 898 && /1% of the full price \(R 8\.98\)/.test(L.agreement.text) && /death or hospitalisation/.test(L.agreement.text) && L.agreement.signedBy === 'T Mokoena' && L.agreement.signature === sig, L.agreement && L.agreement.text);
check('the deposit is recorded in the history', L.history.length === 1 && L.history[0].n === 0 && L.history[0].amountCents === 20000, L.history);
R.lvl1 = await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion'); R.lvlLamp = await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp');
check('stock reserved, on hand untouched', R.lvl1.onHandQty === 10 && R.lvl1.reservedQty === 2 && R.lvlLamp.onHandQty === 3 && R.lvlLamp.reservedQty === 1, [R.lvl1, R.lvlLamp]);
let moves = await listColl('stockMovements');
check('two reserved movements on the lay-by', moves.filter(m => m.bucket === 'reserved' && m.docNo === 'BF-LB-000001' && m.reason === 'layby').length === 2 && moves.every(m => m.docNo !== 'BF-LB-000001' || m.qty > 0), moves.map(m => [m.bucket, m.qty, m.docNo]));
let pays = await listColl('payments');
check('the deposit is a payment row on the lay-by', pays.filter(p => p.docType === 'layby' && p.docNo === 'BF-LB-000001' && p.instalment === 0 && p.amountCents === 20000 && p.method === 'cash').length === 1, pays);
R.again = await call('pos-layby', b1); check('the same opening again: the first stands', R.again.ok && R.again.again && R.again.layby.docNo === 'BF-LB-000001', R.again);

// ---- instalments at another store (the owner at Parow), never more than owed
R.pay1 = await call('pos-layby', { action: 'pay', laybyId: L.id, paymentId: 'lp-' + Date.now().toString(36) + '-1', tenders: [{ method: 'card', amountCents: 30000, cardLast4: '4242' }], clientCreatedAt: new Date().toISOString(), ...parow }, own.idToken);
check('R 300 by card at Parow: balance down, history grows', R.pay1.ok && R.pay1.layby.paidCents === 50000 && R.pay1.layby.balanceCents === 39800 && R.pay1.layby.paymentCount === 2 && R.pay1.layby.history.length === 2 && R.pay1.layby.history[1].storeId === 'BF-PAROW' && R.pay1.instalment === 1, R.pay1.error || R.pay1.layby);
pays = await listColl('payments');
check('the instalment row carries the till that took it', pays.some(p => p.docNo === 'BF-LB-000001' && p.instalment === 1 && p.storeId === 'BF-PAROW' && p.amountCents === 30000 && p.cardLast4 === '4242'), pays.filter(p => p.docNo === 'BF-LB-000001'));
R.over = await call('pos-layby', { action: 'pay', laybyId: L.id, paymentId: 'lp-' + Date.now().toString(36) + '-2', tenders: [{ method: 'cash', amountCents: 50000, tenderedCents: 50000 }], ...bell }); check('more than the balance: refused', R.over.status === 400 && /more than what is owed|Only R 398\.00/.test(R.over.error), R.over);
R.early = await call('pos-layby', { action: 'complete', laybyId: L.id, saleId: 'lbs-early-' + Date.now().toString(36), ...bell }); check('collecting with a balance: refused', R.early.status === 400 && /still owed/.test(R.early.error), R.early);
R.pay2 = await call('pos-layby', { action: 'pay', laybyId: L.id, paymentId: 'lp-' + Date.now().toString(36) + '-3', tenders: [{ method: 'cash', amountCents: 39800, tenderedCents: 40000 }], clientCreatedAt: new Date().toISOString(), ...bell });
check('the rest in cash with change: paid in full', R.pay2.ok && R.pay2.layby.balanceCents === 0 && R.pay2.payments[0].changeCents === 200, R.pay2.error || R.pay2.layby);
R.wrongStore = await call('pos-layby', { action: 'complete', laybyId: L.id, saleId: 'lbs-x-' + Date.now().toString(36), ...parow }, own.idToken); check('collection only where the goods are reserved', R.wrongStore.status === 400 && /collected at Bellville/.test(R.wrongStore.error), R.wrongStore);

// ---- collection: a tax invoice paid by the lay-by; reserved out, on hand out
const saleId = 'lbs-' + Date.now().toString(36);
R.done = await call('pos-layby', { action: 'complete', laybyId: L.id, saleId, ...bell });
check('collected: sale BF-000001 paid by the lay-by', R.done.ok && R.done.sale && R.done.sale.docNo === 'BF-000001' && R.done.sale.totalCents === 89800 && R.done.sale.paymentMethods.join() === 'layby' && R.done.sale.laybyOf === 'BF-LB-000001' && R.done.sale.customerSnapshot.name === 'Thandi Mokoena', R.done.error || R.done.sale);
check('the lay-by is completed and points at the invoice', R.done.layby.status === 'completed' && R.done.layby.completedSaleId === saleId && R.done.layby.completedDocNo === 'BF-000001', R.done.layby);
pays = await listColl('payments');
check('one layby tender on the sale, for the full price, with the LB number', pays.filter(p => p.docType === 'sale' && p.docId === saleId).length === 1 && pays.find(p => p.docId === saleId).method === 'layby' && pays.find(p => p.docId === saleId).amountCents === 89800 && pays.find(p => p.docId === saleId).ref === 'BF-LB-000001', pays.filter(p => p.docId === saleId));
R.lvl2 = await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion'); R.lvlLamp2 = await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp');
check('stock: reserved released and sold out of on hand', R.lvl2.onHandQty === 8 && R.lvl2.reservedQty === 0 && R.lvlLamp2.onHandQty === 2 && R.lvlLamp2.reservedQty === 0, [R.lvl2, R.lvlLamp2]);
moves = await listColl('stockMovements');
check('release and sale movements both written', moves.filter(m => m.docId === L.id && m.bucket === 'reserved' && m.qty < 0).length === 2 && moves.filter(m => m.docId === saleId && m.reason === 'sale' && m.qty < 0).length === 2, moves.map(m => [m.bucket, m.qty, m.docNo]));
R.doneAgain = await call('pos-layby', { action: 'complete', laybyId: L.id, saleId, ...bell }); check('collecting again: the first answer stands', R.doneAgain.ok && R.doneAgain.again && R.doneAgain.sale.docNo === 'BF-000001', R.doneAgain);
R.payClosed = await call('pos-layby', { action: 'pay', laybyId: L.id, paymentId: 'lp-' + Date.now().toString(36) + '-9', tenders: [{ method: 'cash', amountCents: 100, tenderedCents: 100 }], ...bell }); check('no payments on a completed lay-by', R.payClosed.status === 409, R.payClosed);

// ---- cancellation: the penalty the agreement disclosed, capped, the refund must add up; a supervisor's PIN
R.open2 = await call('pos-layby', openBody([{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], 50000, [{ method: 'cash', amountCents: 10000, tenderedCents: 10000 }]));
const L2 = R.open2.layby; check('second lay-by BF-LB-000002', R.open2.ok && L2.docNo === 'BF-LB-000002', R.open2.error);
R.lvlLamp3 = await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp'); check('the lamp is reserved again', R.lvlLamp3.reservedQty === 1 && R.lvlLamp3.onHandQty === 2, R.lvlLamp3);
R.cancelCas = await call('pos-layby', { action: 'cancel', laybyId: L2.id, kind: 'customer', refunds: [{ method: 'cash', amountCents: 9500 }], ...bell }); check('a cashier cannot cancel without a supervisor', R.cancelCas.status === 403 && /supervisor/.test(R.cancelCas.error), R.cancelCas);
R.cancelWrong = await call('pos-layby', { action: 'cancel', laybyId: L2.id, kind: 'customer', refunds: [{ method: 'cash', amountCents: 10000 }], ...bell }, sup.idToken); check('the refund must be what was paid less the penalty', R.cancelWrong.status === 400 && /must equal/.test(R.cancelWrong.error) && /R 95\.00/.test(R.cancelWrong.error) && /R 5\.00/.test(R.cancelWrong.error), R.cancelWrong);
R.cancel = await call('pos-layby', { action: 'cancel', laybyId: L2.id, kind: 'customer', reason: 'Changed mind', refunds: [{ method: 'cash', amountCents: 9500 }], ...bell }, sup.idToken);
check('cancelled: penalty 1% = R 5, R 95 refunded', R.cancel.ok && R.cancel.layby.status === 'cancelled' && R.cancel.layby.penaltyCents === 500 && R.cancel.layby.refundedCents === 9500 && R.cancel.breakdown.computedCents === 500 && R.cancel.breakdown.capCents === 500 && R.cancel.breakdown.chargedCents === 500 && R.cancel.breakdown.refundCents === 9500, R.cancel.error || R.cancel.layby);
pays = await listColl('payments');
check('the refund is a negative payment row and a refund row', pays.some(p => p.docType === 'refund' && p.docNo === 'BF-LB-000002' && p.amountCents === -9500 && p.method === 'cash') && (await listColl('refunds')).some(r => r.laybyDocNo === 'BF-LB-000002' && r.amountCents === 9500), pays.filter(p => p.docNo === 'BF-LB-000002'));
R.lvlLamp4 = await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp'); check('the lamp is released', R.lvlLamp4.reservedQty === 0 && R.lvlLamp4.onHandQty === 2, R.lvlLamp4);

// death: no penalty; a manager's say-so
R.open3 = await call('pos-layby', openBody([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], 19900, [{ method: 'cash', amountCents: 5000, tenderedCents: 5000 }]));
const L3 = R.open3.layby;
R.deathSup = await call('pos-layby', { action: 'cancel', laybyId: L3.id, kind: 'death', refunds: [{ method: 'storeCredit', amountCents: 5000 }], ...bell }, sup.idToken); check('waiving the penalty needs a manager', R.deathSup.status === 403 && /manager/.test(R.deathSup.error), R.deathSup);
R.death = await call('pos-layby', { action: 'cancel', laybyId: L3.id, kind: 'death', refunds: [{ method: 'storeCredit', amountCents: 5000 }], ...bell }, own.idToken);
check('death: no penalty, the whole deposit back as store credit', R.death.ok && R.death.layby.penaltyCents === 0 && R.death.breakdown.chargedCents === 0 && /death/.test(R.death.breakdown.waivedWhy) && R.death.layby.refundedCents === 5000 && (await getDoc('pos/retail/customers/c1')).storeCreditCents === 5000, R.death.error || R.death.breakdown);

// lapsed only after the due date; reminders; the report
R.open4 = await call('pos-layby', openBody([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], 19900, [{ method: 'cash', amountCents: 4000, tenderedCents: 4000 }], { termDays: 30, frequency: 'weekly' }));
const L4 = R.open4.layby; check('a 30-day weekly lay-by: 4 instalments', R.open4.ok && L4.termDays === 30 && L4.schedule.length === 4 && L4.schedule[3].dueAt <= L4.dueAt, R.open4.error || L4.schedule);
R.lapsed = await call('pos-layby', { action: 'cancel', laybyId: L4.id, kind: 'lapsed', refunds: [{ method: 'cash', amountCents: 3801 }], ...bell }, own.idToken); check('not yet due: cannot lapse', R.lapsed.status === 400 && /only due by/.test(R.lapsed.error), R.lapsed);
R.remind = await call('pos-layby', { action: 'remind', laybyId: L4.id, how: 'whatsapp', ...bell });
check('a reminder: the words, the number, logged on the lay-by', R.remind.ok && R.remind.kind === 'due' && /BF-LB-000004/.test(R.remind.text) && /R 39\.75/.test(R.remind.text) && R.remind.phone === '0825550101' && (await getDoc('pos/retail/laybys/' + L4.id)).reminders.length === 1, R.remind);
R.repCas = await call('pos-layby', { action: 'report', ...bell }); check('the report needs a supervisor', R.repCas.status === 403, R.repCas);
R.rep = await call('pos-layby', { action: 'report', from: '2000-01-01', to: '2999-12-31', ...bell }, own.idToken);
check('the report: 1 open, 1 collected, 2 cancelled with R 5 penalty and R 145 refunded', R.rep.ok && R.rep.open.count === 1 && R.rep.open.balanceCents === 15900 && R.rep.completed.count === 1 && R.rep.completed.valueCents === 89800 && R.rep.cancelled.count === 2 && R.rep.cancelled.penaltyCents === 500 && R.rep.cancelled.refundedCents === 14500, R.rep.error || R.rep);
check('money taken here and paid on our lay-bys anywhere', R.rep.takenHereCents === 20000 + 39800 + 10000 + 5000 + 4000 && R.rep.paidOnOursCents === R.rep.takenHereCents + 30000 && R.rep.rows.length === 1 && R.rep.rows[0].docNo === 'BF-LB-000004' && R.rep.rows[0].state === 'on track', [R.rep.takenHereCents, R.rep.paidOnOursCents, R.rep.rows]);
R.counter = await getDoc('pos/retail/counters/BF_LB'); check('LB numbers 1..4 without a gap', R.counter.next === 5, R.counter);
const audit = await listColl('auditLog'); check('audited', ['layby.open', 'layby.pay', 'layby.complete', 'layby.cancel', 'layby.remind'].every(a => audit.some(x => x.action === a)) && audit.filter(a => a.action === 'layby.open').length === 4, audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'layby-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
