// Retail POS step 6: the pos-sale function over HTTP, against the emulators
// and server.mjs. The owner sells from the office (no till) and from a till.
// Checks the refusals, the arithmetic, numbering, stock, credit, vouchers,
// the account and idempotency.
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ ...R, fails, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
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
const su = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.co.za', password: 'secret123', returnSecureToken: true }) })).json();
const OWNER = su.localId, TOKEN = su.idToken;
const cu = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cathy@shop.co.za', password: 'secret123', returnSecureToken: true }) })).json();
const CATHY = cu.localId, CTOKEN = cu.idToken;
await put('pos/retail/users/' + OWNER, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + CATHY, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, numbering: { blockSize: 20, refillBelow: 5 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card', 'eft', 'voucher', 'storeCredit', 'account'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/registers/r1', { name: 'Till 1', active: true, currentShiftId: 'sh_open', ...srv('BF', 'BF-BELL') });
await put('pos/retail/shifts/sh_open', { registerId: 'r1', status: 'open', openedBy: OWNER, openedByName: 'Jean', openedAt: '2026-10-21T08:00:00.000Z', openingFloat: { denoms: {}, totalCents: 0 }, closedBy: '', closedByName: '', closedAt: '', ...srv('BF', 'BF-BELL', 'dev_t1') });
const secret = 'till-secret-1';
await put('pos/retail/devices/dev_t1', { label: 'Till 1', registerId: 'r1', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, lastSeenAt: '', appVersion: '', ...srv('BF', 'BF-BELL', 'dev_t1') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: false, ...o, ...srv('BF') });
await prod('p_ch', { name: '3 Seater Chesterfield', priceCents: 920000, costCents: 400000, storePrices: { 'BF-BELL': 899900 } });
await prod('p_book', { name: 'Care Book', vatClass: 'zero', priceCents: 12000, costCents: 5000 });
await prod('p_gv', { name: 'Gift voucher R500', type: 'voucher', trackStock: false, priceCents: 50000 });
await prod('p_set', { name: 'Lounge set', type: 'bundle', trackStock: false, priceCents: 1500000, bundle: [{ productId: 'p_ch', variantId: '', qty: 1 }, { productId: 'p_cushion', variantId: '', qty: 4 }] });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000 });
await put('pos/retail/stockLevels/BF-BELL_p_ch', { productId: 'p_ch', variantId: '', onHandQty: 2, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c_addr', { name: 'Walk In Addressed', phone: '', email: '', vatNo: '', address: { line1: '2 Road', city: 'Bellville' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: true, creditLimitCents: 500000, storeCreditCents: 30000, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const mark = (m) => console.error('>> ' + m + ' ' + new Date().toISOString().slice(11, 19));
const call = async (fn, body, token = TOKEN) => { mark('call ' + (body.action || '') + ' ' + (body.saleId || '') + ' ' + JSON.stringify(body.tenders || '').slice(0, 60)); const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const office = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const till = { deviceId: 'dev_t1', secret };
let n = 0;
const sale = (o = {}) => ({ action: 'commit', saleId: o.saleId || 'web-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: 'c_addr', lines: [{ productId: 'p_ch', variantId: '', qty: 1, unitPriceCents: 899900, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 899900, vatCents: vatIn(899900, 1500) }, tenders: [{ method: 'card', amountCents: 899900, cardLast4: '1234', approvalCode: 'A1' }], ...office, ...o });

mark('seeded');
// ---- who
R.noLogin = await call('pos-sale', sale(), ''); check('no login: 401', R.noLogin.status === 401, R.noLogin);
R.wrongStore = await call('pos-sale', sale({ storeId: 'RC-MAIN', entityId: 'RC' }), CTOKEN); check('not your store: 403', R.wrongStore.status === 403, R.wrongStore);
R.badTill = await call('pos-sale', sale({ deviceId: 'dev_t1', secret: 'wrong' })); check('a till with the wrong secret: 403', R.badTill.status === 403, R.badTill);

// ---- the arithmetic
R.badPrice = await call('pos-sale', sale({ lines: [{ productId: 'p_ch', variantId: '', qty: 1, unitPriceCents: 100, discountCents: 0 }], totals: { totalCents: 100, vatCents: 13 } }), CTOKEN); check('a changed price without approval: 403', R.badPrice.status === 403 && /manager/.test(R.badPrice.error), R.badPrice);
R.badTotal = await call('pos-sale', sale({ totals: { totalCents: 899800, vatCents: 117378 } })); check('a total off by a cent: 409', R.badTotal.status === 409 && /does not match/.test(R.badTotal.error), R.badTotal);
R.bigDisc = await call('pos-sale', sale({ lines: [{ productId: 'p_ch', variantId: '', qty: 1, unitPriceCents: 899900, discountCents: 179980, discountReason: 'x' }], totals: { totalCents: 719920, vatCents: vatIn(719920, 1500) }, tenders: [{ method: 'card', amountCents: 719920 }] }), CTOKEN); check('20% off by a cashier without a token: 403', R.bigDisc.status === 403 && /limit/.test(R.bigDisc.error), R.bigDisc);
R.ownerDisc = await call('pos-sale', sale({ lines: [{ productId: 'p_ch', variantId: '', qty: 1, unitPriceCents: 899900, discountCents: 179980, discountReason: 'x' }], totals: { totalCents: 719920, vatCents: vatIn(719920, 1500) }, tenders: [{ method: 'card', amountCents: 719920 }] })); check('the same 20% by the owner: written', R.ownerDisc.ok && R.ownerDisc.sale.docNo === 'BF-000001' && R.ownerDisc.sale.lineDiscountCents === 179980, R.ownerDisc);
R.short = await call('pos-sale', sale({ tenders: [{ method: 'card', amountCents: 100 }] })); check('tenders short: 400', R.short.status === 400 && /do not cover/.test(R.short.error), R.short);
R.oldDate = await call('pos-sale', sale({ clientCreatedAt: '2020-01-01T10:00:00.000Z' })); check('a stale date: 400', R.oldDate.status === 400, R.oldDate);
R.archived = await call('pos-sale', sale({ lines: [{ productId: 'nope', variantId: '', qty: 1, unitPriceCents: 1, discountCents: 0 }], totals: { totalCents: 1, vatCents: 0 }, tenders: [{ method: 'card', amountCents: 1 }] })); check('an unknown product: 400', R.archived.status === 400, R.archived);
R.badMethod = await call('pos-sale', sale({ tenders: [{ method: 'qr', amountCents: 899900 }] })); check('a method the store does not take: 400', R.badMethod.status === 400, R.badMethod);

// ---- over R 5 000 a VAT-registered company needs the customer's name and address (a full tax invoice)
R.big = await call('pos-sale', sale({ customerId: '' })); check('over R 5 000 without a customer: 400', R.big.status === 400 && /full tax invoice/.test(R.big.error), R.big);
await put('pos/retail/customers/c_noaddr', { name: 'No Address', phone: '', email: '', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });
R.bigNoAddr = await call('pos-sale', sale({ customerId: 'c_noaddr' })); check('…and with a customer without an address: 400', R.bigNoAddr.status === 400 && /address/.test(R.bigNoAddr.error), R.bigNoAddr);
await put('pos/retail/customers/c_noaddr?updateMask.fieldPaths=address', { address: { line1: '1 Road', city: 'Parow' } });
R.bigOk = await call('pos-sale', sale({ customerId: 'c_noaddr' })); check('…and with the address: written', R.bigOk.ok, R.bigOk);
// ---- cash: rounding to 10c and change; numbering runs on
const book = { lines: [{ productId: 'p_book', variantId: '', qty: 1, unitPriceCents: 12000, discountCents: 0 }, { productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 1 }], totals: { totalCents: 31899, vatCents: vatIn(19899, 1500) } };
R.cash = await call('pos-sale', sale({ ...book, tenders: [{ method: 'cash', amountCents: 31900, tenderedCents: 50000 }] }));
check('cash rounded to 10c, change given, zero-rated VAT, number 3', R.cash.ok && R.cash.sale.docNo === 'BF-000003' && R.cash.sale.roundingCents === 1 && R.cash.sale.changeCents === 18100 && R.cash.sale.vatCents === vatIn(19899, 1500) && R.cash.payments[0].changeCents === 18100, R.cash);
R.cashOff = await call('pos-sale', sale({ ...book, tenders: [{ method: 'cash', amountCents: 31800, tenderedCents: 50000 }] })); check('cash that is neither exact nor rounded: 400', R.cashOff.status === 400, R.cashOff);
// ---- split: card + cash exact
R.split = await call('pos-sale', sale({ tenders: [{ method: 'card', amountCents: 500000 }, { method: 'cash', amountCents: 399900, tenderedCents: 400000 }] }));
check('split payment: two payment rows, change on the cash', R.split.ok && R.split.payments.length === 2 && R.split.sale.changeCents === 100 && R.split.sale.paymentMethods.join() === 'card,cash', R.split);

// ---- idempotent: the same saleId again writes nothing and answers the same
R.again = await call('pos-sale', sale({ saleId: R.split.sale.id })); check('the same sale again: same number, flagged again', R.again.ok && R.again.again && R.again.sale.docNo === R.split.sale.docNo, R.again);

// ---- stock: movements and levels, negative allowed, a bundle moves its parts
let lv = await getDoc('pos/retail/stockLevels/BF-BELL_p_ch'); check('chesterfield stock 2 → -1 after the three written sales (refused ones move nothing)', lv.onHandQty === -1 && lv.negative === true, lv);
const mv = await listColl('stockMovements'); check('one movement per tracked line, with the sale number', mv.filter(m => m.productId === 'p_ch' && m.reason === 'sale' && m.qty === -1 && /^BF-0000/.test(m.docNo)).length === 3 && mv.every(m => m.createdBy === OWNER && m.serverReceivedAt), mv.length);
R.bundle = await call('pos-sale', sale({ lines: [{ productId: 'p_set', variantId: '', qty: 2, unitPriceCents: 1500000, discountCents: 0 }], totals: { totalCents: 3000000, vatCents: vatIn(3000000, 1500) }, tenders: [{ method: 'eft', amountCents: 3000000, ref: 'EFT1', status: 'awaiting' }] }));
lv = await getDoc('pos/retail/stockLevels/BF-BELL_p_ch'); const cush = await getDoc('pos/retail/stockLevels/BF-BELL_p_cushion');
check('a bundle × 2 moves 2 chesterfields (-1 → -3, flagged) and 8 cushions; EFT awaiting', R.bundle.ok && lv.onHandQty === -3 && lv.negative === true && cush.onHandQty === -9 && R.bundle.sale.paidStatus === 'awaiting' && R.bundle.negativeStock === 2, { lv, cush, st: R.bundle.sale && R.bundle.sale.paidStatus });

// ---- store credit and the account need the customer; balances move
R.creditNoCust = await call('pos-sale', sale({ customerId: '', lines: [{ productId: 'p_book', variantId: '', qty: 1, unitPriceCents: 12000, discountCents: 0 }], totals: { totalCents: 12000, vatCents: 0 }, tenders: [{ method: 'storeCredit', amountCents: 12000 }] })); check('store credit without a customer: 400', R.creditNoCust.status === 400, R.creditNoCust);
R.credit = await call('pos-sale', sale({ customerId: 'c1', tenders: [{ method: 'storeCredit', amountCents: 30000 }, { method: 'account', amountCents: 400000 }, { method: 'card', amountCents: 469900 }] }));
const c1 = await getDoc('pos/retail/customers/c1');
check('credit used up, account up by R 4 000, snapshot on the sale', R.credit.ok && c1.storeCreditCents === 0 && c1.accountBalanceCents === 400000 && R.credit.sale.customerSnapshot.name === 'Thandi Mokoena', { c1, ok: R.credit.ok, err: R.credit.error });
R.overLimit = await call('pos-sale', sale({ customerId: 'c1', tenders: [{ method: 'account', amountCents: 899900 }] })); check('past the credit limit: 400', R.overLimit.status === 400 && /limit/.test(R.overLimit.error), R.overLimit);

// ---- a voucher sold, then used, then empty
R.gvSale = await call('pos-sale', sale({ lines: [{ productId: 'p_gv', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) }, tenders: [{ method: 'card', amountCents: 50000 }] }));
const code = R.gvSale.vouchersSold && R.gvSale.vouchersSold[0] && R.gvSale.vouchersSold[0].code;
check('selling a voucher makes one with a code', !!code && (await getDoc('pos/retail/vouchers/' + code)).balanceCents === 50000, R.gvSale.vouchersSold);
R.gvLook = await call('pos-sale', { action: 'voucher', code, ...office }); check('a voucher can be looked up', R.gvLook.ok && R.gvLook.balanceCents === 50000, R.gvLook);
R.gvUse = await call('pos-sale', sale({ ...book, tenders: [{ method: 'voucher', amountCents: 31899, voucherCode: code }] }));
const gv = await getDoc('pos/retail/vouchers/' + code);
check('voucher pays; balance down; one use recorded', R.gvUse.ok && gv.balanceCents === 18101 && gv.uses.length === 1 && gv.status === 'open', { ok: R.gvUse.ok, err: R.gvUse.error, gv });
R.gvOver = await call('pos-sale', sale({ tenders: [{ method: 'voucher', amountCents: 899900, voucherCode: code }] })); check('more than the voucher holds: 400', R.gvOver.status === 400, R.gvOver);

// ---- a till: its own block, numbers it chose offline
R.blocks = await call('pos-sale', { action: 'blocks', ...till }); const blk = R.blocks.blocks && R.blocks.blocks.INV;
check('the till gets a block after the office’s', R.blocks.ok && blk && blk.from === 21 && blk.to === 40 && blk.usedUpTo === 20, R.blocks);
R.tillSale = await call('pos-sale', sale({ ...till, saleId: 'dev_t1-abc-1', seq: 25 })); check('a till-chosen number inside its block is kept; the sale is on the open shift', R.tillSale.ok && R.tillSale.sale.docNo === 'BF-000025' && R.tillSale.sale.source === 'till' && R.tillSale.sale.deviceId === 'dev_t1' && R.tillSale.sale.shiftId === 'sh_open', R.tillSale);
R.tillReuse = await call('pos-sale', sale({ ...till, saleId: 'dev_t1-abc-2', seq: 25 })); check('the same number again: 409', R.tillReuse.status === 409, R.tillReuse);
R.tillOut = await call('pos-sale', sale({ ...till, saleId: 'dev_t1-abc-3', seq: 99 })); check('a number outside the block: 409', R.tillOut.status === 409, R.tillOut);
R.tillNext = await call('pos-sale', sale({ ...till, saleId: 'dev_t1-abc-4' })); check('next from the till with no number given: 26', R.tillNext.ok && R.tillNext.sale.docNo === 'BF-000026', R.tillNext);
const blocks = await listColl('numberBlocks'); check('two blocks: office 1–20 and till 21–40, usedUpTo moved', blocks.length === 2 && blocks.some(b => b.deviceId === 'web:' + OWNER && b.from === 1 && b.usedUpTo === 8) && blocks.some(b => b.deviceId === 'dev_t1' && b.usedUpTo === 26), blocks.map(b => [b.deviceId, b.from, b.to, b.usedUpTo]));
const counter = await getDoc('pos/retail/counters/BF_INV'); check('the counter sits past both blocks', counter.next === 41, counter);
// ---- every written sale is complete and consistent
const sales = await listColl('sales'), lines = await listColl('saleLines'), pays = await listColl('payments'), audit = await listColl('auditLog');
check('every sale has its lines, payments and an audit row; stamps on all', sales.length === 10 && sales.every(s => lines.filter(l => l.saleId === s.id).length === s.lineCount && pays.some(p => p.docId === s.id) && audit.some(a => a.action === 'sale.commit' && a.docId === s.id) && s.verified && s.createdBy && s.deviceId && s.entityId === 'BF' && s.storeId === 'BF-BELL'), { sales: sales.length, lines: lines.length, pays: pays.length });
check('numbers in the office block are contiguous 1..8', sales.filter(s => s.deviceId.startsWith('web:')).map(s => s.seq).sort((a, b) => a - b).join() === '1,2,3,4,5,6,7,8', sales.map(s => s.seq));
check('VAT on every line adds up to the sale', sales.every(s => lines.filter(l => l.saleId === s.id).reduce((n, l) => n + l.vatCents, 0) === s.vatCents));

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 6000));
console.log(fails.length ? fails.length + ' FAILED' : 'sale-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
