// Retail POS step 10: the pos-return function over HTTP. Find by number,
// customer and date; a part return at the price actually paid with VAT
// reversed; never more than sold; dispositions and stock; refunds equal
// the credit; store credit; the window and made-to-order need a manager;
// no-receipt returns are store credit only; an exchange writes the credit
// note and the new sale together with the credit as the first tender.
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
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, returns: { windowDays: 7, reasons: ['Changed mind', 'Faulty'] }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', priceCents: 50000, costCents: 20000 });
await prod('p_book', { name: 'Care Book', vatClass: 'zero', priceCents: 12000, costCents: 5000 });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, priceCents: 1500000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const office = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
let n = 0;
const nid = (p) => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const sale = (lines, tenders, o = {}) => ({ action: 'commit', saleId: 'web-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: '', lines, saleDiscountCents: 0, totals: o.totals, tenders, ...office, ...o });

// a sale: 3 cushions with 10% off (owner), 1 lamp, 1 book; sale discount R 100
const lines = [{ productId: 'p_cushion', variantId: '', qty: 3, unitPriceCents: 19900, discountCents: 5970, discountReason: 'x' }, { productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }, { productId: 'p_book', variantId: '', qty: 1, unitPriceCents: 12000, discountCents: 0 }];
const sub = 59700 - 5970 + 50000 + 12000, saleDisc = 10000;
// the sale discount spread like the server does it
const lt = [53730, 50000, 12000]; const shares = lt.map((x, i) => i === 2 ? saleDisc - Math.round(saleDisc * lt[0] / sub) - Math.round(saleDisc * lt[1] / sub) : Math.round(saleDisc * x / sub));
const nets = lt.map((x, i) => x - shares[i]); const vats = [vatIn(nets[0], 1500), vatIn(nets[1], 1500), 0];
R.sale = await call('pos-sale', sale(lines, [{ method: 'card', amountCents: sub - saleDisc }], { saleDiscountCents: saleDisc, customerId: 'c1', totals: { totalCents: sub - saleDisc, vatCents: vats[0] + vats[1] } }), own.idToken);
check('the sale is written', R.sale.ok && R.sale.sale.docNo === 'BF-000001', R.sale);
const saleId = R.sale.sale.id;

// ---- find
R.findNo = await call('pos-return', { action: 'find', docNo: 'bf-000001', ...office }); check('find by number: the sale, its lines and nothing returned yet', R.findNo.ok && R.findNo.sales.length === 1 && R.findNo.sales[0].lines.length === 3 && Object.keys(R.findNo.sales[0].returned).length === 0 && R.findNo.settings.windowDays === 7, R.findNo);
R.findCust = await call('pos-return', { action: 'find', customerId: 'c1', ...office }); check('find by customer', R.findCust.ok && R.findCust.sales.length === 1, R.findCust);
R.findDate = await call('pos-return', { action: 'find', date: new Date().toISOString().slice(0, 10), ...office }); check('find by date', R.findDate.ok && R.findDate.sales.length === 1, R.findDate);
R.findNone = await call('pos-return', { action: 'find', docNo: 'BF-999999', ...office }); check('nothing found is an empty list', R.findNone.ok && R.findNone.sales.length === 0, R.findNone);

// ---- a part return: 2 of the 3 cushions, restocked, refunded in cash, by the cashier (inside the window)
const twoCushions = Math.round(nets[0] * 2 / 3), twoVat = vatIn(twoCushions, 1500);
R.tooMany = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId, lines: [{ saleLineNo: 1, qty: 4, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: 1 }], ...office }); check('more than sold: 400', R.tooMany.status === 400 && /only 3 of 3/.test(R.tooMany.error), R.tooMany);
R.shortRefund = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId, lines: [{ saleLineNo: 1, qty: 2, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: 100 }], ...office }); check('refunds that do not equal the credit: 400', R.shortRefund.status === 400 && /do not add up/.test(R.shortRefund.error), R.shortRefund);
const cn1Id = nid('cn');
R.cn1 = await call('pos-return', { action: 'credit', creditId: cn1Id, saleId, lines: [{ saleLineNo: 1, qty: 2, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: twoCushions }], ...office });
check('credit note BF-CN-000001 at the price actually paid, VAT reversed', R.cn1.ok && R.cn1.creditNote.docNo === 'BF-CN-000001' && R.cn1.creditNote.totalCents === twoCushions && R.cn1.creditNote.vatCents === twoVat && R.cn1.creditNote.lines[0].unitPaidCents === Math.round(nets[0] / 3) && R.cn1.creditNote.refundedCents === twoCushions && !R.cn1.sale, { cn: R.cn1.creditNote && { t: R.cn1.creditNote.totalCents, v: R.cn1.creditNote.vatCents, u: R.cn1.creditNote.lines[0].unitPaidCents }, exp: { twoCushions, twoVat, u: Math.round(nets[0] / 3) }, err: R.cn1.error });
check('restocked: 10 − 3 + 2 = 9', (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 9);
R.cnAgain = await call('pos-return', { action: 'credit', creditId: cn1Id, saleId, lines: [{ saleLineNo: 1, qty: 2, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: twoCushions }], ...office }); check('the same credit again: the first answer, nothing written twice', R.cnAgain.ok && R.cnAgain.again && R.cnAgain.creditNote.docNo === 'BF-CN-000001' && (await listColl('creditNotes')).length === 1 && (await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion')).onHandQty === 9, R.cnAgain);
R.cnNoId = await call('pos-return', { action: 'credit', saleId, lines: [{ saleLineNo: 1, qty: 1, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: 1 }], ...office }); check('a credit without an id: 400', R.cnNoId.status === 400 && /no id/.test(R.cnNoId.error), R.cnNoId);
let pays = await listColl('payments'); check('a negative cash payment row for the refund', pays.some(p => p.docType === 'refund' && p.method === 'cash' && p.amountCents === -twoCushions && p.docNo === 'BF-CN-000001'), pays.filter(p => p.docType === 'refund'));
R.findAgain = await call('pos-return', { action: 'find', docNo: 'BF-000001', ...office }); check('find shows 2 returned on line 1', R.findAgain.sales[0].returned['1'] === 2, R.findAgain.sales[0].returned);
R.oneLeft = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId, lines: [{ saleLineNo: 1, qty: 2, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: 1 }], ...office }); check('only one cushion left to return', R.oneLeft.status === 400 && /only 1 of 3/.test(R.oneLeft.error), R.oneLeft);

// ---- the lamp to quarantine, refunded as store credit (customer on the note); the book written off
R.cn2 = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId, customerId: 'c1', lines: [{ saleLineNo: 2, qty: 1, reason: 'Faulty', disposition: 'quarantine' }, { saleLineNo: 3, qty: 1, reason: 'Damaged', disposition: 'writeoff' }], refunds: [{ method: 'storeCredit', amountCents: nets[1] + nets[2] }], ...office });
check('lamp and book credited; book zero-rated so no VAT back on it', R.cn2.ok && R.cn2.creditNote.totalCents === nets[1] + nets[2] && R.cn2.creditNote.vatCents === vatIn(nets[1], 1500), R.cn2.creditNote && { t: R.cn2.creditNote.totalCents, v: R.cn2.creditNote.vatCents, err: R.cn2.error });
const c1 = await getDoc('pos/retail/customers/c1'); check('store credit up by the refund', c1.storeCreditCents === nets[1] + nets[2], c1.storeCreditCents);
const lampLv = await getDoc('pos/retail/stockLevels/BF-BELL_p_lamp'); check('the lamp sits in quarantine, not on hand', lampLv && lampLv.quarantineQty === 1 && lampLv.onHandQty === -1, lampLv);
const mv = await listColl('stockMovements'); check('movements: quarantine bucket for the lamp, none for the written-off book', mv.some(m => m.productId === 'p_lamp' && m.bucket === 'quarantine' && m.qty === 1 && m.reason === 'creditNote') && !mv.some(m => m.productId === 'p_book' && m.reason === 'creditNote'), mv.map(m => [m.productId, m.bucket, m.qty, m.reason]));

// ---- outside the window: the cashier needs a manager; the owner may
await put('pos/retail/sales/' + saleId + '?updateMask.fieldPaths=clientCreatedAt', { clientCreatedAt: new Date(Date.now() - 10 * 86400000).toISOString() });
R.old = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId, lines: [{ saleLineNo: 1, qty: 1, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: nets[0] - twoCushions }], ...office }); check('after 7 days a cashier is refused: 403', R.old.status === 403 && /manager/.test(R.old.error), R.old);
R.oldOwner = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId, lines: [{ saleLineNo: 1, qty: 1, reason: 'Faulty', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: nets[0] - twoCushions }], ...office }, own.idToken); check('…the owner may; the last cushion goes back', R.oldOwner.ok && R.oldOwner.creditNote.docNo === 'BF-CN-000003', R.oldOwner);

// ---- made to order needs a manager
R.mtoSale = await call('pos-sale', sale([{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0 }], [{ method: 'card', amountCents: 1500000 }], { customerId: 'c1', totals: { totalCents: 1500000, vatCents: vatIn(1500000, 1500) } }), own.idToken);
R.mtoCashier = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId: R.mtoSale.sale.id, lines: [{ saleLineNo: 1, qty: 1, reason: 'Changed mind', disposition: 'writeoff' }], refunds: [{ method: 'card', amountCents: 1500000 }], ...office }); check('a made-to-order return by a cashier: 403', R.mtoCashier.status === 403 && /made-to-order/.test(R.mtoCashier.error), R.mtoCashier);

// ---- no receipt: store credit only, customer and manager
R.nrCash = await call('pos-return', { action: 'credit', creditId: nid('cn'), noReceipt: true, customerId: 'c1', lines: [{ productId: 'p_cushion', variantId: '', qty: 1, reason: 'Changed mind', disposition: 'quarantine' }], refunds: [{ method: 'cash', amountCents: 19900 }], ...office }, own.idToken); check('no receipt: cash refused', R.nrCash.status === 400 && /store credit only/.test(R.nrCash.error), R.nrCash);
R.nrNoCust = await call('pos-return', { action: 'credit', creditId: nid('cn'), noReceipt: true, lines: [{ productId: 'p_cushion', variantId: '', qty: 1, reason: 'Changed mind' }], refunds: [{ method: 'storeCredit', amountCents: 19900 }], ...office }, own.idToken); check('no receipt: the customer is needed', R.nrNoCust.status === 400 && /customer/.test(R.nrNoCust.error), R.nrNoCust);
R.nrCashier = await call('pos-return', { action: 'credit', creditId: nid('cn'), noReceipt: true, customerId: 'c1', lines: [{ productId: 'p_cushion', variantId: '', qty: 1, reason: 'Changed mind' }], refunds: [{ method: 'storeCredit', amountCents: 19900 }], ...office }); check('no receipt by a cashier: 403', R.nrCashier.status === 403, R.nrCashier);
R.nr = await call('pos-return', { action: 'credit', creditId: nid('cn'), noReceipt: true, customerId: 'c1', lines: [{ productId: 'p_cushion', variantId: '', qty: 1, reason: 'Changed mind' }], refunds: [{ method: 'storeCredit', amountCents: 19900 }], ...office }, own.idToken);
check('no receipt by the owner: store credit at today’s price, quarantined', R.nr.ok && R.nr.creditNote.noReceipt && R.nr.creditNote.totalCents === 19900 && R.nr.creditNote.lines[0].disposition === 'quarantine' && (await getDoc('pos/retail/customers/c1')).storeCreditCents === nets[1] + nets[2] + 19900, R.nr);

// ---- an exchange: return 1 cushion (R 199 paid) for a lamp (R 500): the credit pays first, card the rest; one transaction, two numbers
R.s2 = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'cash', amountCents: 19900, tenderedCents: 20000 }], { totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken);
const exSale = { saleId: 'web-ex-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) }, tenders: [{ method: 'card', amountCents: 50000 - 19900, cardLast4: '9999' }] };
R.ex = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId: R.s2.sale.id, lines: [{ saleLineNo: 1, qty: 1, reason: 'Wrong item', disposition: 'restock' }], refunds: [], exchange: exSale, ...office });
check('exchange: credit note and new sale written together', R.ex.ok && R.ex.creditNote.docNo === 'BF-CN-000005' && R.ex.sale && R.ex.sale.docNo === 'BF-000051' /* the cashier's own web session takes the next block */ && R.ex.creditNote.exchangeSaleId === R.ex.sale.id && R.ex.creditNote.exchangeUsedCents === 19900 && R.ex.sale.exchangeOf === 'BF-CN-000005', R.ex.error || { cn: R.ex.creditNote && R.ex.creditNote.docNo, s: R.ex.sale && R.ex.sale.docNo });
pays = await listColl('payments'); check('the new sale paid by the credit note first, then card', pays.filter(p => p.docId === exSale.saleId).map(p => p.method + ':' + p.amountCents + ':' + p.ref).sort().join('|') === 'card:30100:|creditNote:19900:BF-CN-000005', pays.filter(p => p.docId === exSale.saleId));
R.exShort = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId: R.s2.sale.id, lines: [{ saleLineNo: 1, qty: 1, reason: 'Wrong item' }], refunds: [], exchange: { ...exSale, saleId: exSale.saleId + 'b' }, ...office }); check('the same line cannot be exchanged twice', R.exShort.status === 400 && /only 0 of 1/.test(R.exShort.error), R.exShort);
// an exchange for less: the rest refunded
R.s3 = await call('pos-sale', sale([{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], [{ method: 'card', amountCents: 50000 }], { totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) } }), own.idToken);
const exSale2 = { saleId: 'web-ex2-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) }, tenders: [] };
R.ex2 = await call('pos-return', { action: 'credit', creditId: nid('cn'), saleId: R.s3.sale.id, lines: [{ saleLineNo: 1, qty: 1, reason: 'Wrong item', disposition: 'restock' }], refunds: [{ method: 'cash', amountCents: 50000 - 19900 }], exchange: exSale2, ...office });
check('exchange for less: credit covers the sale, the rest refunded in cash', R.ex2.ok && R.ex2.creditNote.exchangeUsedCents === 19900 && R.ex2.creditNote.refundedCents === 30100 && R.ex2.sale.paymentMethods.join() === 'creditNote', R.ex2.error || R.ex2.creditNote);
const notes = await listColl('creditNotes'); check('credit notes numbered 1..6 with no gap', notes.map(x => x.seq).sort((a, b) => a - b).join() === '1,2,3,4,5,6' && notes.every(x => x.verified && x.createdBy), notes.map(x => x.seq));
const audit = await listColl('auditLog'); check('returns audited', audit.filter(a => a.action === 'return.creditNote').length === 4 && audit.filter(a => a.action === 'return.exchange').length === 2, audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 6000));
console.log(fails.length ? fails.length + ' FAILED' : 'return-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
