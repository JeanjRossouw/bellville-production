// Retail POS step 16: pos-report and pos-xero over HTTP. A day of trade is
// rung up (sales with a discount, a credit note, a lay-by deposit, a
// register close), then the dashboard against last week, each report with
// its totals and filters, and a balanced Xero journal with its CSV.
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
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za'), mgr = await mk('mandla@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + mgr.localId, { email: 'mandla@shop.co.za', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, layby: { minDepositPct: 20, termDays: 90, penaltyPct: 1, frequency: 'monthly' }, returns: { windowDays: 7, reasons: ['Faulty'] }, cash: { varianceLimitCents: 5000 }, xero: { autoDaily: false, accounts: { cash: '090', card: '091' } }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-PAROW') });
await put('pos/retail/registers/reg1', { entityId: 'BF', name: 'Till 1', currentShiftId: '', active: true, ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: 'House', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000, reorderLevel: 20, reorderQty: 10 });
await prod('p_lamp', { name: 'Lamp', category: 'Lighting', brand: 'Lux', priceCents: 50000, costCents: 20000 });
await prod('p_rug', { name: 'Rug', category: 'Floor', priceCents: 80000, costCents: 30000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, avgCostCents: 5000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 0, avgCostCents: 20000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_rug', { productId: 'p_rug', variantId: '', onHandQty: 2, reservedQty: 0, avgCostCents: 30000, lastMovementAt: '2026-01-01T00:00:00.000Z', ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', phoneKey: '27825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, consent: { whatsapp: { granted: true, at: '2026-10-21T08:00:00.000Z', byName: 'Cathy', source: 'till' } }, loyalty: { points: 0, lifetimeCents: 0, tier: '', lots: [] }, stats: { salesCount: 0, spentCents: 0 }, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = mgr.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' }, till = { entityId: 'BF', storeId: 'BF-BELL', registerId: 'reg1' };
let n = 0;
const sale = (lines, tenders, o = {}) => ({ action: 'commit', saleId: 'web-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: '', lines, saleDiscountCents: 0, totals: o.totals, tenders, ...bell, ...o });
const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);

// ---- a day of trade on a register: 3 sales (one with a 10% discount by the manager), a credit note, a lay-by deposit, the close
R.open = await call('pos-shift', { action: 'open', ...till, float: { denoms: { '20000': 5 }, totalCents: 100000 } }, mgr.idToken); check('register opened', R.open.ok, R.open.error);
R.s1 = await call('pos-sale', sale([{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }, { productId: 'p_cushion', variantId: '', qty: 2, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'card', amountCents: 89800 }], { customerId: 'c1', totals: { totalCents: 89800, vatCents: vatIn(50000, 1500) + vatIn(39800, 1500) }, ...till }), cas.idToken); check('sale 1 (card, R 898)', R.s1.ok, R.s1.error);
R.s2 = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 1990, discountReason: 'Shop soiled' }], [{ method: 'cash', amountCents: 17910, tenderedCents: 20000 }], { totals: { totalCents: 17910, vatCents: vatIn(17910, 1500) }, ...till }), mgr.idToken); check('sale 2 (cash, 10% off by the manager, R 179.10)', R.s2.ok && R.s2.sale.roundingCents === 0, R.s2.error || R.s2.sale);
R.s3 = await call('pos-sale', sale([{ productId: 'p_rug', variantId: '', qty: 1, unitPriceCents: 80000, discountCents: 0 }], [{ method: 'cash', amountCents: 80000, tenderedCents: 80000 }], { totals: { totalCents: 80000, vatCents: vatIn(80000, 1500) }, ...till }), cas.idToken); check('sale 3 (cash, R 800)', R.s3.ok, R.s3.error);
R.cn = await call('pos-return', { action: 'credit', creditId: 'cn-report-test-1', saleId: R.s1.sale.id, lines: [{ saleLineNo: 2, qty: 1, reason: 'Faulty', disposition: 'writeoff' }], refunds: [{ method: 'cash', amountCents: 19900 }], clientCreatedAt: new Date().toISOString(), ...till }, cas.idToken); check('a cushion back for cash', R.cn.ok && R.cn.creditNote.totalCents === 19900, R.cn.error);
R.lb = await call('pos-layby', { action: 'open', laybyId: 'lb-report-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines: [{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) }, deposit: [{ method: 'card', amountCents: 15000 }], agreement: { accepted: true, signedBy: 'T Mokoena' }, ...till }, cas.idToken); check('a lay-by with a R 150 deposit', R.lb.ok, R.lb.error);
R.voidAudit = await put('pos/retail/auditLog/au_void1', { action: 'sale.line.void', docType: 'sale', docId: '', docNo: '', actorUid: cas.localId, actorName: 'Cathy', details: { name: 'Lamp', qty: 1, unitPriceCents: 50000, reason: 'Scanned twice' }, ...srv('BF', 'BF-BELL'), createdBy: cas.localId, createdAt: new Date().toISOString() });
R.close = await call('pos-shift', { action: 'close', shiftId: R.open.shift.id, counted: { cash: { denoms: { '20000': 5, '10000': 7, '5000': 1, '2000': 1, '1000': 1, '10': 1 }, totalCents: 178010 }, card: 104800 }, note: '', ...till }, mgr.idToken); check('register closed with the cash right', R.close.ok && R.close.shift.varianceCents === 0, R.close.error || R.close.shift);

// ---- the dashboard: today vs the same weekday last week
R.dash = await call('pos-report', { action: 'dashboard' }, own.idToken);
check('dashboard: both stores, today 3 sales R 1 877.10 less R 199 refunds, nothing last week, a lay-by open', R.dash.ok && R.dash.stores.length === 2 && R.dash.stores[0].today.sales === 3 && R.dash.stores[0].today.total === 89800 + 17910 + 80000 && R.dash.stores[0].today.refunds === 19900 && R.dash.stores[0].lastWeek.sales === 0 && R.dash.stores[0].openLaybys === 1 && R.dash.all.today.net === 187710 - 19900, R.dash.error || R.dash.stores);
R.dashCas = await call('pos-report', { action: 'dashboard' }, cas.idToken); check('not for a cashier', R.dashCas.status === 403, R.dashCas);

// ---- reports
const run = (report, o = {}) => call('pos-report', { action: 'run', report, entityId: 'BF', from: today, to: today, ...o });
R.daily = await run('dailySales');
check('daily sales: one row, 3 sales, gross R 1 897, discounts R 19.90, VAT, refunds R 199, cash R 779.10 (R 979.10 − R 199 refund... no: refunds are their own rows) card R 1 048', R.daily.ok && R.daily.rows.length === 1 && R.daily.rows[0].sales === 3 && R.daily.rows[0].gross === 50000 + 39800 + 19900 + 80000 && R.daily.rows[0].discounts === 1990 && R.daily.rows[0].total === 187710 && R.daily.rows[0].refunds === 19900 && R.daily.rows[0].net === 167810 && R.daily.rows[0].card === 89800 + 15000 && R.daily.rows[0].cash === 17910 + 80000 - 19900 && R.daily.totals.net === 167810, R.daily.error || R.daily.rows);
R.z = await run('zReports'); check('Z-reports: the close with no variance, R 1 877.10 sales', R.z.ok && R.z.rows.length === 1 && R.z.rows[0].variance === 0 && R.z.rows[0].total === 187710 && R.z.rows[0].closedBy === 'Mandla', R.z.error || R.z.rows);
R.vat = await run('vat'); check('VAT: 15% row, output VAT on R 1 877.10 less the credit note', R.vat.ok && R.vat.rows.length === 1 && R.vat.rows[0].rate === '15%' && R.vat.rows[0].vat === vatIn(50000, 1500) + vatIn(39800, 1500) + vatIn(17910, 1500) + vatIn(80000, 1500) && R.vat.rows[0].cnVat === vatIn(19900, 1500) && R.vat.rows[0].netIncl === 167810 && /VAT no 4123456789/.test(R.vat.title), R.vat.error || R.vat.rows);
R.prod = await run('byProduct');
const cushion = (R.prod.rows || []).find(r => r.key === 'Scatter Cushion');
check('by product: cushions 3 sold, 1 returned, GP from the cost snapshot', R.prod.ok && cushion && cushion.qty === 3 && cushion.returnedQty === 1 && cushion.revenue === 39800 + 17910 && cushion.cost === 15000 && cushion.gp === cushion.excl - 15000 && R.prod.totals.gp > 0, R.prod.error || R.prod.rows);
R.cat = await run('byCategory'); check('by category: Shop, Lighting, Floor', R.cat.ok && R.cat.rows.map(r => r.key).sort().join() === 'Floor,Lighting,Shop', R.cat.rows && R.cat.rows.map(r => r.key));
R.brand = await run('byBrand'); check('by brand: Lux lamp R 500', R.brand.ok && R.brand.rows.find(r => r.key === 'Lux').revenue === 50000, R.brand.rows);
R.staff = await run('byStaff'); check('by staff: Cathy 2 sales and a refund, Mandla 1 with a discount', R.staff.ok && R.staff.rows.find(r => r.staff === 'Cathy').sales === 2 && R.staff.rows.find(r => r.staff === 'Cathy').refunded === 19900 && R.staff.rows.find(r => r.staff === 'Mandla').discounts === 1990, R.staff.rows);
R.staffF = await run('dailySales', { staffUid: cas.localId }); check('the staff filter: Cathy’s 2 sales only', R.staffF.ok && R.staffF.rows[0].sales === 2 && R.staffF.rows[0].total === 89800 + 80000, R.staffF.rows);
R.chan = await run('dailySales', { channel: 'online' }); check('the channel filter: nothing online', R.chan.ok && R.chan.rows.length === 0, R.chan.rows);
R.hour = await run('byHour'); check('by hour: one hour with 3 sales', R.hour.ok && R.hour.rows.length === 1 && R.hour.rows[0].sales === 3, R.hour.rows);
R.disc = await run('discounts'); check('discounts: the 10% line by Mandla', R.disc.ok && R.disc.rows.length === 1 && R.disc.rows[0].amount === 1990 && R.disc.rows[0].pct === 10 && R.disc.rows[0].reason === 'Shop soiled' && R.disc.rows[0].staff === 'Mandla', R.disc.rows);
R.voids = await run('voids'); check('voids: the lamp scanned twice', R.voids.ok && R.voids.rows.length === 1 && R.voids.rows[0].amount === 50000 && R.voids.rows[0].reason === 'Scanned twice', R.voids.rows);
R.ref = await run('refunds'); check('refunds: the credit note, faulty, written off, cash', R.ref.ok && R.ref.rows.length === 1 && R.ref.rows[0].against === 'BF-000001' && /Faulty/.test(R.ref.rows[0].reasons) && /writeoff/.test(R.ref.rows[0].dispositions) && /cash 199\.00/.test(R.ref.rows[0].methods), R.ref.rows);
R.sv = await run('stockValue'); check('stock value: cushions 7 × R 50, lamps 3 on hand (1 reserved on the lay-by still counts), rug 1', R.sv.ok && R.sv.totals.units === 7 + 4 + 1 && R.sv.totals.value === 7 * 5000 + 4 * 20000 + 1 * 30000 && R.sv.rows.some(r => r.category === 'Lighting'), R.sv.error || R.sv);
R.low = await run('lowStock'); check('low stock: cushions at 7 against a level of 20, order 10', R.low.ok && R.low.rows.length === 1 && R.low.rows[0].name === 'Scatter Cushion' && R.low.rows[0].suggest === 10, R.low.rows);
R.mov = await run('movements'); check('movements: sales out, the write-off, the reservation', R.mov.ok && R.mov.rows.length >= 5 && R.mov.rows.some(r => r.reason === 'layby' && r.bucket === 'reserved'), R.mov.rows && R.mov.rows.map(r => [r.reason, r.qty]));
R.dead = await run('deadStock', { days: 30 }); check('dead stock: nothing sold in 30 days — the lamp and cushion sold today, so none', R.dead.ok && R.dead.rows.length === 0, R.dead.rows);
R.lbr = await run('laybys'); check('lay-bys: the one opened today, on track, R 350 to come', R.lbr.ok && R.lbr.rows.length === 1 && R.lbr.rows[0].balance === 35000 && R.lbr.rows[0].status === 'on track', R.lbr.rows);
R.cust = await run('customers'); check('customers: Thandi with 1 sale, consent, R 898 spent', R.cust.ok && R.cust.rows[0].name === 'Thandi Mokoena' && R.cust.rows[0].sales === 1 && R.cust.rows[0].spent === 89800 && /whatsapp/.test(R.cust.rows[0].consent), R.cust.rows);
R.storeF = await call('pos-report', { action: 'run', report: 'dailySales', entityId: 'BF', storeId: 'BF-PAROW', from: today, to: today }, own.idToken); check('a store with no trade: empty', R.storeF.ok && R.storeF.rows.length === 0, R.storeF.rows);
R.storeNo = await run('dailySales', { storeId: 'BF-PAROW' }); check('a manager cannot report on a store not theirs', R.storeNo.status === 403, R.storeNo);
R.bad = await run('nope'); check('an unknown report is refused', R.bad.status === 400, R.bad);
R.other = await call('pos-report', { action: 'run', report: 'dailySales', entityId: 'XX', from: today, to: today }); check('not another company', R.other.status === 403, R.other);

// ---- the Xero journal for today: balanced, the CSV
R.x = await call('pos-xero', { action: 'build', entityId: 'BF', date: today });
const J = R.x.journal || {};
check('the journal balances', R.x.ok && J.lines.length > 4 && J.debitsCents === J.creditsCents && !J.unbalanced && J.status === 'built', R.x.error || J);
const line = (k, desc) => (J.lines || []).find(l => l.key === k && (!desc || l.description.includes(desc)));
const salesVat = vatIn(50000, 1500) + vatIn(39800, 1500) + vatIn(17910, 1500) + vatIn(80000, 1500);
check('revenue ex VAT credited and VAT output credited', line('sales', 'Sales ') && line('sales', 'Sales ').cents === -(187710 - salesVat) && line('vat', 'VAT on sales').cents === -salesVat, J.lines);
check('credit note reverses revenue and VAT', line('sales', 'Credit notes').cents === 19900 - vatIn(19900, 1500) && line('vat', 'reversed').cents === vatIn(19900, 1500), J.lines);
check('cash and card takings debited, the cash refund credited, the lay-by deposit a liability', line('cash', 'sales').cents === 17910 + 80000 && line('card', 'sales').cents === 89800 && line('cash', 'refunds').cents === -19900 && line('card', 'lay-by').cents === 15000 && line('layby', 'received').cents === -15000, J.lines);
check('the account codes from settings', line('cash').account === '090' && line('sales').account === '200', J.accounts);
check('the CSV is Xero’s manual-journal layout', /\*Narration,\*Date,\*Description,\*AccountCode,\*TaxRate,\*Amount/.test(R.x.csv) && R.x.csv.split('\r\n').length === J.lines.length + 1 && new RegExp(today.split('-').reverse().join('/')).test(R.x.csv), R.x.csv.slice(0, 300));
check('stored under the company and day', (await getDoc('pos/retail/xeroJournals/BF_' + today)).status === 'built');
R.xPush = await call('pos-xero', { action: 'push', entityId: 'BF', date: today }); check('posting without a connection says so (the CSV still works)', R.xPush.status === 409 && /not connected/.test(R.xPush.error), R.xPush);
R.xStatus = await call('pos-xero', { action: 'status', entityId: 'BF' }); check('status: not connected, accounts shown', R.xStatus.ok && R.xStatus.connected === false && R.xStatus.accounts.cash === '090' && R.xStatus.accounts.sales === '200', R.xStatus);
R.xEmpty = await call('pos-xero', { action: 'build', entityId: 'BF', date: '2020-01-01' }); check('an empty day builds an empty, balanced journal', R.xEmpty.ok && R.xEmpty.journal.lines.length === 0 && R.xEmpty.journal.debitsCents === 0, R.xEmpty.error);
R.xCas = await call('pos-xero', { action: 'build', entityId: 'BF', date: today }, cas.idToken); check('not for a cashier', R.xCas.status === 403, R.xCas);

console.log(JSON.stringify({ fails, ...R, x: { lines: J.lines, debits: J.debitsCents, credits: J.creditsCents }, mov: undefined, prod: undefined }, null, 1).slice(0, 12000));
console.log(fails.length ? fails.length + ' FAILED' : 'report-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
