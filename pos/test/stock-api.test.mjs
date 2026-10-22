// Retail POS step 13: the pos-stock function over HTTP. Adjustments need a
// manager and a reason, move the level by a movement and the weighted
// average cost when stock is found at a cost; quarantine moves by a
// supervisor; a stock take frozen by a supervisor, counted from a till by
// scans and typed counts while a sale goes through, reviewed, posted by a
// manager as 'count' movements against the frozen figures, with uncounted
// items left alone.
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
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000, reorderLevel: 5, reorderQty: 10 });
await prod('p_lamp', { name: 'Lamp', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await prod('p_book', { name: 'Care Book', category: 'Books', barcodes: ['BOOK'], priceCents: 12000, costCents: 5000 });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, priceCents: 1500000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 2, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 3, reservedQty: 0, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const nid = (p) => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const lvl = (id) => getDoc('pos/retail/stockLevels/BF-BELL_' + id);

// ---- adjustments: a manager, a reason, a movement; found stock moves the average cost
R.adjCas = await call('pos-stock', { action: 'adjust', adjustId: nid('adj'), productId: 'p_cushion', qty: -2, code: 'damaged', note: 'torn', ...bell }); check('a cashier cannot adjust', R.adjCas.status === 403 && /manager/.test(R.adjCas.error), R.adjCas);
R.adjSup = await call('pos-stock', { action: 'adjust', adjustId: nid('adj'), productId: 'p_cushion', qty: -2, code: 'damaged', ...bell }, sup.idToken); check('nor a supervisor on their own', R.adjSup.status === 403, R.adjSup);
R.adjOther = await call('pos-stock', { action: 'adjust', adjustId: nid('adj'), productId: 'p_cushion', qty: -1, code: 'other', ...bell }, own.idToken); check('"other" needs a note', R.adjOther.status === 400 && /why/.test(R.adjOther.error), R.adjOther);
R.adjMto = await call('pos-stock', { action: 'adjust', adjustId: nid('adj'), productId: 'p_sofa', qty: 1, code: 'found', ...bell }, own.idToken); check('a made-to-order item holds no stock', R.adjMto.status === 400 && /does not hold stock/.test(R.adjMto.error), R.adjMto);
const adj1Id = nid('adj');
R.adj1 = await call('pos-stock', { action: 'adjust', adjustId: adj1Id, productId: 'p_cushion', qty: -2, code: 'damaged', note: 'torn in the window', ...bell }, own.idToken);
check('−2 damaged: on hand 8, the reservation untouched', R.adj1.ok && R.adj1.level.onHandQty === 8 && R.adj1.level.reservedQty === 2 && R.adj1.movement.reason === 'adjust' && R.adj1.movement.code === 'damaged' && R.adj1.movement.qty === -2 && R.adj1.movement.onHandAfter === 8, R.adj1.error || R.adj1.level);
R.adjAgain = await call('pos-stock', { action: 'adjust', adjustId: adj1Id, productId: 'p_cushion', qty: -2, code: 'damaged', note: 'torn in the window', ...bell }, own.idToken); check('the same adjustment again: the first answer, stock untouched', R.adjAgain.ok && R.adjAgain.again && R.adjAgain.level.onHandQty === 8 && R.adjAgain.movement.docId === adj1Id, R.adjAgain);
R.adj2 = await call('pos-stock', { action: 'adjust', adjustId: nid('adj'), productId: 'p_cushion', qty: 3, code: 'found', unitCostCents: 6000, ...bell }, own.idToken);
check('+3 found at R 60: on hand 11, the average cost moves from R 50 to R 52.73', R.adj2.ok && R.adj2.level.onHandQty === 11 && R.adj2.level.avgCostCents === Math.round((8 * 5000 + 3 * 6000) / 11), R.adj2.error || R.adj2.level);
R.adj3 = await call('pos-stock', { action: 'adjust', adjustId: nid('adj'), productId: 'p_cushion', qty: -1, code: 'sample', ...bell }, own.idToken); check('a sample out leaves the average cost alone', R.adj3.ok && R.adj3.level.onHandQty === 10 && R.adj3.level.avgCostCents === 5273, R.adj3.error || R.adj3.level);
let moves = await listColl('stockMovements'); check('three adjustment movements on the record, with the approver', moves.filter(m => m.reason === 'adjust' && m.docType === 'adjust').length === 3 && moves.every(m => m.byName === 'Jean'), moves.map(m => [m.reason, m.qty, m.byName]));

// ---- quarantine: a supervisor moves goods aside and back
R.qCas = await call('pos-stock', { action: 'move', moveId: nid('qm'), productId: 'p_lamp', qty: 1, from: 'onHand', to: 'quarantine', ...bell }); check('a cashier cannot move to quarantine', R.qCas.status === 403, R.qCas);
R.q1 = await call('pos-stock', { action: 'move', moveId: nid('qm'), productId: 'p_lamp', qty: 1, from: 'onHand', to: 'quarantine', note: 'scratched?', ...bell }, sup.idToken);
check('1 lamp into quarantine', R.q1.ok && R.q1.level.onHandQty === 2 && R.q1.level.quarantineQty === 1, R.q1.error || R.q1.level);
R.qTooMany = await call('pos-stock', { action: 'move', moveId: nid('qm'), productId: 'p_lamp', qty: 5, from: 'quarantine', to: 'onHand', ...bell }, sup.idToken); check('not more than is in quarantine', R.qTooMany.status === 400 && /Only 1 in quarantine/.test(R.qTooMany.error), R.qTooMany);
moves = await listColl('stockMovements'); check('the move is two movements, one per bucket', moves.filter(m => m.reason === 'quarantine').length === 2 && moves.some(m => m.reason === 'quarantine' && m.bucket === 'onHand' && m.qty === -1) && moves.some(m => m.reason === 'quarantine' && m.bucket === 'quarantine' && m.qty === 1), moves.filter(m => m.reason === 'quarantine'));

// ---- a stock take: frozen, counted while a sale goes through, reviewed, posted
R.tkCas = await call('pos-stock', { action: 'takeOpen', name: 'Try', ...bell }); check('a cashier cannot open a stock take', R.tkCas.status === 403, R.tkCas);
R.tk = await call('pos-stock', { action: 'takeOpen', name: 'October count', scope: 'all', ...bell }, sup.idToken);
const T = R.tk.take || {};
check('frozen: the three stock items, not the sofa, at the system figures', R.tk.ok && T.status === 'open' && T.itemCount === 3 && T.items.map(x => x.itemId + ':' + x.frozenQty).sort().join() === 'p_book:0,p_cushion:10,p_lamp:2', R.tk.error || T.items);
R.tk2 = await call('pos-stock', { action: 'takeOpen', name: 'Again', ...bell }, sup.idToken); check('only one stock take at a time', R.tk2.status === 409 && /still being counted/.test(R.tk2.error), R.tk2);
R.c1 = await call('pos-stock', { action: 'takeCount', takeId: T.id, counts: [{ itemId: 'p_cushion', qty: 1, mode: 'add' }], ...bell });
R.c2 = await call('pos-stock', { action: 'takeCount', takeId: T.id, counts: [{ itemId: 'p_cushion', qty: 1, mode: 'add' }, { itemId: 'p_cushion', qty: 1, mode: 'add' }], ...bell });
check('scans add up: 3 cushions counted by Cathy', R.c2.ok && R.c2.take.items.find(x => x.itemId === 'p_cushion').countedQty === 3 && R.c2.take.items.find(x => x.itemId === 'p_cushion').countedBy === 'Cathy' && R.c2.take.countedItems === 1 && R.c2.take.log.length === 3, R.c2.error || R.c2.take);
R.c3 = await call('pos-stock', { action: 'takeCount', takeId: T.id, counts: [{ itemId: 'p_lamp', qty: 2, mode: 'set' }], ...bell }, sup.idToken); check('a typed count sets the lamp to 2', R.c3.ok && R.c3.take.items.find(x => x.itemId === 'p_lamp').countedQty === 2 && R.c3.take.countedItems === 2, R.c3.error || R.c3.take);
R.cBad = await call('pos-stock', { action: 'takeCount', takeId: T.id, counts: [{ itemId: 'p_sofa', qty: 1, mode: 'add' }], ...bell }); check('an item outside the take is refused', R.cBad.status === 400 && /not in this stock take/.test(R.cBad.error), R.cBad);
// a sale in the middle of the count
R.sale = await call('pos-sale', { action: 'commit', saleId: 'web-mid-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) }, tenders: [{ method: 'card', amountCents: 19900 }], ...bell }, own.idToken);
check('a sale during the count: cushion 9 on hand', R.sale.ok && (await lvl('p_cushion')).onHandQty === 9, R.sale.error);
R.revCas = await call('pos-stock', { action: 'takeReview', takeId: T.id, ...bell }); check('a cashier cannot close the count', R.revCas.status === 403, R.revCas);
R.postEarly = await call('pos-stock', { action: 'takePost', takeId: T.id, ...bell }, own.idToken); check('no posting before review', R.postEarly.status === 409 && /review it first/.test(R.postEarly.error), R.postEarly);
R.rev = await call('pos-stock', { action: 'takeReview', takeId: T.id, ...bell }, sup.idToken); check('in review: the variances', R.rev.ok && R.rev.take.status === 'review' && R.rev.take.varianceQty === -7 && R.rev.take.varianceValueCents === -7 * 5000 + 0, R.rev.error || R.rev.take);
R.cLate = await call('pos-stock', { action: 'takeCount', takeId: T.id, counts: [{ itemId: 'p_book', qty: 1, mode: 'add' }], ...bell }); check('no counting once in review', R.cLate.status === 409, R.cLate);
R.postSup = await call('pos-stock', { action: 'takePost', takeId: T.id, ...bell }, sup.idToken); check('posting needs a manager', R.postSup.status === 403 && /manager/.test(R.postSup.error), R.postSup);
R.post = await call('pos-stock', { action: 'takePost', takeId: T.id, ...bell }, own.idToken);
check('posted: one movement (the cushion), the lamp matched, the book untouched', R.post.ok && R.post.take.status === 'posted' && R.post.movements === 1 && R.post.take.approvedBy === 'Jean', R.post.error || R.post.take);
R.lvlC = await lvl('p_cushion'); R.lvlL = await lvl('p_lamp');
check('cushion: 9 on hand less the −7 variance = 2; the sale meanwhile stands; counted today', R.lvlC.onHandQty === 2 && R.lvlC.reservedQty === 2 && R.lvlC.lastCountedAt.slice(0, 10) === new Date().toISOString().slice(0, 10), R.lvlC);
check('lamp: 2 on hand, 1 in quarantine, counted today with no movement', R.lvlL.onHandQty === 2 && R.lvlL.quarantineQty === 1 && !!R.lvlL.lastCountedAt, R.lvlL);
check('the book has no level: it was not counted', (await lvl('p_book')) === null);
moves = await listColl('stockMovements');
check('the count movement: −7 against the frozen 10, on the stock take', moves.filter(m => m.reason === 'count').length === 1 && moves.find(m => m.reason === 'count').qty === -7 && moves.find(m => m.reason === 'count').docType === 'stockTake' && /Counted 3, expected 10/.test(moves.find(m => m.reason === 'count').note), moves.filter(m => m.reason === 'count'));
R.cancelLate = await call('pos-stock', { action: 'takeCancel', takeId: T.id, ...bell }, sup.idToken); check('a posted take cannot be cancelled', R.cancelLate.status === 409, R.cancelLate);
R.tk3 = await call('pos-stock', { action: 'takeOpen', name: 'Books only', scope: 'category', category: 'Books', ...bell }, sup.idToken); check('a category take holds only that category', R.tk3.ok && R.tk3.take.itemCount === 1 && R.tk3.take.items[0].itemId === 'p_book', R.tk3.error || R.tk3.take);
R.tk3c = await call('pos-stock', { action: 'takeCancel', takeId: R.tk3.take.id, ...bell }, sup.idToken); check('cancelled', R.tk3c.ok && R.tk3c.take.status === 'cancelled', R.tk3c);
const audit = await listColl('auditLog'); check('audited', ['stock.adjust', 'stock.move', 'stock.takeOpen', 'stock.takeReview', 'stock.takePost', 'stock.takeCancel'].every(a => audit.some(x => x.action === a)), audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'stock-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
