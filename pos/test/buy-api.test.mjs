// Retail POS step 14: the pos-buy function over HTTP. A PO sent by a
// manager gets its number and puts stock on order; a part receipt against
// it with landed costs spread by value moves stock in at the landed cost,
// the weighted average and the product's cost; the rest received; a direct
// receipt; a PO cancelled releases what was on order; a transfer between
// stores leaves the sender now, is received in part at the other store and
// closed short; a cancelled transfer puts the stock back; a signed link to
// the PO page.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL', 'BF-PAROW'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', poPrefix: 'BF-PO', grvPrefix: 'BF-GRV', transferPrefix: 'BF-TR', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, buying: { updateCostsOnReceive: true }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-PAROW') });
await put('pos/retail/suppliers/s_foam', { name: 'Foam Co', contact: 'Pete', phone: '0215550001', email: 'orders@foam.co.za', accountNo: 'BF-77', termsDays: 30, leadDays: 7, notes: '', archived: false, ...srv('BF') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, supplierId: 's_foam', ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', sku: 'CU-1', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000, reorderLevel: 5, reorderQty: 10 });
await prod('p_lamp', { name: 'Lamp', sku: 'LA-1', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 4, reservedQty: 1, avgCostCents: 5000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/purchaseOrders/po1', { status: 'draft', docNo: '', seq: 0, supplierId: 's_foam', supplierName: 'Foam Co', expectedAt: '2026-11-01', note: 'Please deliver before 10', lines: [{ productId: 'p_cushion', variantId: '', itemId: 'p_cushion', sku: 'CU-1', name: 'Scatter Cushion', qty: 10, unitCostCents: 5000, receivedQty: 0 }, { productId: 'p_lamp', variantId: '', itemId: 'p_lamp', sku: 'LA-1', name: 'Lamp', qty: 2, unitCostCents: 20000, receivedQty: 0 }], subtotalCents: 90000, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' }, parow = { entityId: 'BF', storeId: 'BF-PAROW', registerId: '' };
const lvl = (s, id) => getDoc('pos/retail/stockLevels/' + s + '_' + id);

// ---- the PO: sent by a manager, numbered, stock on order
R.sendSup = await call('pos-buy', { action: 'poSend', poId: 'po1', ...bell }, sup.idToken); check('a supervisor cannot send a PO', R.sendSup.status === 403 && /manager/.test(R.sendSup.error), R.sendSup);
R.send = await call('pos-buy', { action: 'poSend', poId: 'po1', how: 'link', ...bell }, own.idToken);
check('sent: BF-PO-000001, totals with VAT, supplier snapshot', R.send.ok && R.send.po.docNo === 'BF-PO-000001' && R.send.po.status === 'sent' && R.send.po.subtotalCents === 90000 && R.send.po.vatCents === 13500 && R.send.po.totalCents === 103500 && R.send.po.supplierSnapshot.email === 'orders@foam.co.za', R.send.error || R.send.po);
R.lv1 = await lvl('BF-BELL', 'p_cushion'); R.lvL = await lvl('BF-BELL', 'p_lamp');
check('on order: 10 cushions, 2 lamps (a level made for the lamp), on hand untouched', R.lv1.onOrderQty === 10 && R.lv1.onHandQty === 4 && R.lvL && R.lvL.onOrderQty === 2 && R.lvL.onHandQty === 0, [R.lv1, R.lvL]);
R.sendAgain = await call('pos-buy', { action: 'poSend', poId: 'po1', ...bell }, own.idToken); check('sending again changes nothing', R.sendAgain.ok && R.sendAgain.again, R.sendAgain);
R.link = await call('pos-doc', { action: 'link', poId: 'po1', ...bell }, sup.idToken); check('a signed link to the PO page', R.link.ok && /pos-doc\?t=/.test(R.link.url) && /purchase order BF-PO-000001, 2 lines, R 1,035\.00/.test(R.link.text), R.link);
R.linkCas = await call('pos-doc', { action: 'link', poId: 'po1', ...bell }); check('not for a cashier', R.linkCas.status === 403, R.linkCas);
R.page = await (await fetch(R.link.url)).text(); check('the page is the order for the supplier', /PURCHASE ORDER|Purchase order/.test(R.page) && /BF-PO-000001/.test(R.page) && /Foam Co/.test(R.page) && /Scatter Cushion/.test(R.page) && /Deliver to/.test(R.page) && /1,035\.00/.test(R.page), R.page.slice(0, 200));

// ---- a part receipt with landed costs: 6 cushions at R 55 and 1 lamp at R 200, freight R 70 by value
R.rcvCas = await call('pos-buy', { action: 'receive', grvId: 'grv-test-x1', purchaseOrderId: 'po1', lines: [{ productId: 'p_cushion', qty: 6, unitCostCents: 5500 }], ...bell }); check('a cashier cannot receive', R.rcvCas.status === 403 && /supervisor/.test(R.rcvCas.error), R.rcvCas);
R.rcvOver = await call('pos-buy', { action: 'receive', grvId: 'grv-test-x2', purchaseOrderId: 'po1', lines: [{ productId: 'p_cushion', qty: 11, unitCostCents: 5500 }], ...bell }, sup.idToken); check('not more than ordered', R.rcvOver.status === 400 && /only 10 still open/.test(R.rcvOver.error), R.rcvOver);
R.rcv1 = await call('pos-buy', { action: 'receive', grvId: 'grv-test-1', purchaseOrderId: 'po1', supplierInvoiceNo: 'INV-9', invoiceDate: '2026-10-22', lines: [{ productId: 'p_cushion', qty: 6, unitCostCents: 5500 }, { productId: 'p_lamp', qty: 1, unitCostCents: 20000 }], landed: { freightCents: 7000, dutyCents: 0, otherCents: 0, method: 'value' }, updateCosts: true, ...bell }, sup.idToken);
const g1 = R.rcv1.grv || {};
check('GRV BF-GRV-000001 against the PO, goods R 530 + freight R 70', R.rcv1.ok && g1.docNo === 'BF-GRV-000001' && g1.purchaseOrderDocNo === 'BF-PO-000001' && g1.subtotalCents === 53000 && g1.landed.totalCents === 7000 && g1.totalCostCents === 60000 && g1.supplierName === 'Foam Co', R.rcv1.error || g1);
// freight by value: cushions 330/530 of 70 = 43.58 → 6 × 55 + 43.58 = 373.58 → 62.26 each; lamp 200 + 26.42 = 226.42
const gl = g1.lines || [{}, {}];
check('landed costs spread by value', gl[0].landedShareCents === 4358 && gl[0].landedCents === 37358 && gl[0].landedUnitCents === 6226 && gl[1].landedShareCents === 2642 && gl[1].landedUnitCents === 22642, g1.lines);
R.lv2 = await lvl('BF-BELL', 'p_cushion'); R.lvL2 = await lvl('BF-BELL', 'p_lamp');
check('cushion: 10 on hand, 4 on order, average cost (4×50 + 6×62.26)/10 = 57.36', R.lv2.onHandQty === 10 && R.lv2.onOrderQty === 4 && R.lv2.avgCostCents === Math.round((4 * 5000 + 6 * 6226) / 10), R.lv2);
check('lamp: 1 on hand at the landed R 226.42, 1 on order', R.lvL2.onHandQty === 1 && R.lvL2.onOrderQty === 1 && R.lvL2.avgCostCents === 22642, R.lvL2);
check('the products’ costs updated to the new averages', (await getDoc('pos/retail/products/p_cushion')).costCents === 5736 && (await getDoc('pos/retail/products/p_lamp')).costCents === 22642 && (g1.costChanges || []).length === 2, g1.costChanges);
R.po2 = await getDoc('pos/retail/purchaseOrders/po1'); check('the PO is part received', R.po2.status === 'part' && R.po2.lines[0].receivedQty === 6 && R.po2.lines[1].receivedQty === 1 && R.po2.grvs[0].docNo === 'BF-GRV-000001', R.po2.lines);
let moves = await listColl('stockMovements'); check('receive movements at the landed cost, on the GRV', moves.filter(m => m.reason === 'receive' && m.docNo === 'BF-GRV-000001').length === 2 && moves.find(m => m.reason === 'receive' && m.productId === 'p_cushion').unitCostCents === 6226 && /Foam Co · inv INV-9/.test(moves.find(m => m.reason === 'receive').note), moves.filter(m => m.reason === 'receive'));
R.rcvAgain = await call('pos-buy', { action: 'receive', grvId: 'grv-test-1', purchaseOrderId: 'po1', lines: [{ productId: 'p_cushion', qty: 6, unitCostCents: 5500 }], ...bell }, sup.idToken); check('the same receipt again: the first stands', R.rcvAgain.ok && R.rcvAgain.again, R.rcvAgain);

// the rest, without landed costs, costs left alone; then the PO is complete
R.rcv2 = await call('pos-buy', { action: 'receive', grvId: 'grv-test-2', purchaseOrderId: 'po1', lines: [{ productId: 'p_cushion', qty: 4, unitCostCents: 5500 }, { productId: 'p_lamp', qty: 1, unitCostCents: 20000 }], updateCosts: false, ...bell }, sup.idToken);
check('the rest received: PO complete, nothing on order', R.rcv2.ok && R.rcv2.poStatus === 'received' && (await getDoc('pos/retail/purchaseOrders/po1')).status === 'received' && (await lvl('BF-BELL', 'p_cushion')).onOrderQty === 0 && (await lvl('BF-BELL', 'p_cushion')).onHandQty === 14, R.rcv2.error || R.rcv2.poStatus);
check('costs not updated this time', (await getDoc('pos/retail/products/p_cushion')).costCents === 5736 && R.rcv2.grv.costChanges.length === 0);
R.rcvClosed = await call('pos-buy', { action: 'receive', grvId: 'grv-test-3', purchaseOrderId: 'po1', lines: [{ productId: 'p_cushion', qty: 1, unitCostCents: 5500 }], ...bell }, sup.idToken); check('nothing more against a complete PO', R.rcvClosed.status === 409, R.rcvClosed);
// a direct receipt with no PO
R.direct = await call('pos-buy', { action: 'receive', grvId: 'grv-test-4', supplierId: 's_foam', lines: [{ productId: 'p_lamp', qty: 3, unitCostCents: 21000 }], landed: { freightCents: 0, dutyCents: 3000, otherCents: 0, method: 'qty' }, ...bell }, sup.idToken);
check('direct: GRV 3, duty spread by quantity (R 10 each), lamp 5 on hand', R.direct.ok && R.direct.grv.docNo === 'BF-GRV-000003' && R.direct.grv.purchaseOrderDocNo === '' && R.direct.grv.lines[0].landedUnitCents === 22000 && (await lvl('BF-BELL', 'p_lamp')).onHandQty === 5, R.direct.error || R.direct.grv);

// ---- a PO cancelled releases what was on order
await put('pos/retail/purchaseOrders/po2', { status: 'draft', docNo: '', seq: 0, supplierId: 's_foam', supplierName: 'Foam Co', expectedAt: '', note: '', lines: [{ productId: 'p_cushion', variantId: '', itemId: 'p_cushion', sku: 'CU-1', name: 'Scatter Cushion', qty: 5, unitCostCents: 5000, receivedQty: 0 }], subtotalCents: 25000, ...srv('BF', 'BF-BELL') });
R.send2 = await call('pos-buy', { action: 'poSend', poId: 'po2', ...bell }, own.idToken); check('PO 2 sent: 5 on order', R.send2.ok && R.send2.po.docNo === 'BF-PO-000002' && (await lvl('BF-BELL', 'p_cushion')).onOrderQty === 5, R.send2.error);
// ---- changed and sent again: the same number, revision 2 and 3, on order moved by the difference
R.revSup = await call('pos-buy', { action: 'poRevise', poId: 'po2', lines: [{ productId: 'p_cushion', qty: 8, unitCostCents: 5000 }], ...bell }, sup.idToken); check('a supervisor cannot change a sent PO', R.revSup.status === 403, R.revSup);
R.rev = await call('pos-buy', { action: 'poRevise', poId: 'po2', supplierId: 's_foam', note: 'Two lamps too', lines: [{ productId: 'p_cushion', qty: 8, unitCostCents: 5200 }, { productId: 'p_lamp', qty: 2, unitCostCents: 21000 }], ...bell }, own.idToken);
check('revision 2: same number, 8 cushions + 2 lamps on order, the totals and the history', R.rev.ok && R.rev.po.docNo === 'BF-PO-000002' && R.rev.po.revision === 2 && R.rev.po.status === 'sent' && R.rev.po.subtotalCents === 8 * 5200 + 2 * 21000 && R.rev.po.revisions.length === 1 && R.rev.po.revisions[0].lines[0].qty === 5 && (await lvl('BF-BELL', 'p_cushion')).onOrderQty === 8 && (await lvl('BF-BELL', 'p_lamp')).onOrderQty === 2, R.rev.error || [R.rev.po, await lvl('BF-BELL', 'p_cushion')]);
R.rev3 = await call('pos-buy', { action: 'poRevise', poId: 'po2', lines: [{ productId: 'p_cushion', qty: 3, unitCostCents: 5200 }], ...bell }, own.idToken);
check('revision 3: the lamps dropped, 3 cushions on order', R.rev3.ok && R.rev3.po.revision === 3 && (await lvl('BF-BELL', 'p_cushion')).onOrderQty === 3 && (await lvl('BF-BELL', 'p_lamp')).onOrderQty === 0, R.rev3.error);
R.revDone = await call('pos-buy', { action: 'poRevise', poId: 'po1', lines: [{ productId: 'p_cushion', qty: 1, unitCostCents: 5000 }], ...bell }, own.idToken); check('a received PO cannot be changed', R.revDone.status === 409, R.revDone);
R.revEmpty = await call('pos-buy', { action: 'poRevise', poId: 'po2', lines: [], ...bell }, own.idToken); check('no lines: refused (cancel it instead)', R.revEmpty.status === 400, R.revEmpty);
R.cancel = await call('pos-buy', { action: 'poCancel', poId: 'po2', reason: 'Price went up', ...bell }, own.idToken); check('cancelled: nothing on order', R.cancel.ok && R.cancel.po.status === 'cancelled' && (await lvl('BF-BELL', 'p_cushion')).onOrderQty === 0, R.cancel.error);

// ---- a transfer: 5 cushions Bellville → Parow; 4 arrive; closed short by 1
R.trCas = await call('pos-buy', { action: 'transferSend', transferId: 'tr-test-x', toStoreId: 'BF-PAROW', lines: [{ productId: 'p_cushion', qty: 1 }], ...bell }); check('a cashier cannot send a transfer', R.trCas.status === 403, R.trCas);
R.trMany = await call('pos-buy', { action: 'transferSend', transferId: 'tr-test-y', toStoreId: 'BF-PAROW', lines: [{ productId: 'p_cushion', qty: 14 }], ...bell }, sup.idToken); check('never more than available (14 on hand, 1 reserved)', R.trMany.status === 400 && /only 13 available/.test(R.trMany.error), R.trMany);
R.trSame = await call('pos-buy', { action: 'transferSend', transferId: 'tr-test-z', toStoreId: 'BF-BELL', lines: [{ productId: 'p_cushion', qty: 1 }], ...bell }, sup.idToken); check('not to the same store', R.trSame.status === 400, R.trSame);
R.tr = await call('pos-buy', { action: 'transferSend', transferId: 'tr-test-1', toStoreId: 'BF-PAROW', lines: [{ productId: 'p_cushion', qty: 5 }], note: 'For the window', ...bell }, sup.idToken);
check('sent: BF-TR-000001 in transit at the average cost (R 56.69); Bellville down to 9', R.tr.ok && R.tr.transfer.docNo === 'BF-TR-000001' && R.tr.transfer.status === 'inTransit' && R.tr.transfer.lines[0].unitCostCents === Math.round((10 * 5736 + 4 * 5500) / 14) && (await lvl('BF-BELL', 'p_cushion')).onHandQty === 9, R.tr.error || R.tr.transfer);
R.trWrong = await call('pos-buy', { action: 'transferReceive', transferId: 'tr-test-1', lines: [{ itemId: 'p_cushion', qty: 5 }], ...bell }, sup.idToken); check('received only at the other end', R.trWrong.status === 400 && /receive it there/.test(R.trWrong.error), R.trWrong);
R.trIn1 = await call('pos-buy', { action: 'transferReceive', transferId: 'tr-test-1', lines: [{ itemId: 'p_cushion', qty: 3 }], ...parow }, sup.idToken);
check('3 arrive at Parow: still in transit, Parow 3 on hand at R 56.69', R.trIn1.ok && R.trIn1.transfer.status === 'inTransit' && R.trIn1.transfer.lines[0].receivedQty === 3 && (await lvl('BF-PAROW', 'p_cushion')).onHandQty === 3 && (await lvl('BF-PAROW', 'p_cushion')).avgCostCents === Math.round((10 * 5736 + 4 * 5500) / 14), R.trIn1.error || R.trIn1.transfer);
R.trCancelLate = await call('pos-buy', { action: 'transferCancel', transferId: 'tr-test-1', ...bell }, sup.idToken); check('part received: cannot cancel', R.trCancelLate.status === 409, R.trCancelLate);
R.trIn2 = await call('pos-buy', { action: 'transferReceive', transferId: 'tr-test-1', lines: [{ itemId: 'p_cushion', qty: 1 }], close: true, ...parow }, sup.idToken);
check('closed short: 4 received, 1 lost in transit, nothing invented', R.trIn2.ok && R.trIn2.transfer.status === 'received' && R.trIn2.transfer.closedShort && R.trIn2.transfer.lostUnits === 1 && R.trIn2.transfer.lines[0].lostQty === 1 && (await lvl('BF-PAROW', 'p_cushion')).onHandQty === 4 && (await lvl('BF-BELL', 'p_cushion')).onHandQty === 9, R.trIn2.error || R.trIn2.transfer);
moves = await listColl('stockMovements'); check('transfer movements: one out of 5, two in (3 and 1)', moves.filter(m => m.reason === 'transferOut').length === 1 && moves.filter(m => m.reason === 'transferIn' && m.storeId === 'BF-PAROW').map(m => m.qty).sort().join() === '1,3', moves.filter(m => /transfer/.test(m.reason)).map(m => [m.reason, m.storeId, m.qty]));
// a transfer cancelled before anything arrives: the stock comes back
R.tr2 = await call('pos-buy', { action: 'transferSend', transferId: 'tr-test-2', toStoreId: 'BF-PAROW', lines: [{ productId: 'p_lamp', qty: 2 }], ...bell }, sup.idToken);
R.tr2c = await call('pos-buy', { action: 'transferCancel', transferId: 'tr-test-2', ...bell }, sup.idToken);
check('cancelled: lamps back at Bellville (5)', R.tr2.ok && R.tr2c.ok && R.tr2c.transfer.status === 'cancelled' && (await lvl('BF-BELL', 'p_lamp')).onHandQty === 5, R.tr2c.error || R.tr2c.transfer);
R.counters = [await getDoc('pos/retail/counters/BF_PO'), await getDoc('pos/retail/counters/BF_GRV'), await getDoc('pos/retail/counters/BF_TR')]; check('PO 1..2, GRV 1..3, TR 1..2 without a gap', R.counters.every(Boolean) && R.counters[0].next === 3 && R.counters[1].next === 4 && R.counters[2].next === 3, R.counters);
const audit = await listColl('auditLog'); check('audited', ['po.send', 'po.cancel', 'stock.receive', 'stock.transferSend', 'stock.transferReceive', 'stock.transferCancel'].every(a => audit.some(x => x.action === a)), audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R, page: undefined }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'buy-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
