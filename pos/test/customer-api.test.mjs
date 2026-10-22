// Retail POS step 15: the pos-customer function and the loyalty parts of
// the sale core over HTTP. One profile per cell number; consent per
// channel with the date and who recorded it; a sale earns points at the
// tier and the receipt line carries them; points pay for a sale (oldest
// lots first, at least the minimum); lots expire; the history across
// stores; merging a duplicate moves money, points and consent; the export;
// anonymising wipes the profile and frees the number while the invoice
// keeps its snapshot; points by hand.
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
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, loyalty: { enabled: true, pointsPerRand: 1, pointValueCents: 5, minRedeemPoints: 100, expiryMonths: 12, tiers: [{ name: 'Bronze', fromCents: 0, multiplier: 1 }, { name: 'Silver', fromCents: 100000, multiplier: 1.5 }] }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
await put('pos/retail/stores/BF-PAROW', { entityId: 'BF', name: 'Parow', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-PAROW') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', priceCents: 50000, costCents: 20000 });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' }, parow = { entityId: 'BF', storeId: 'BF-PAROW', registerId: '' };
let n = 0;
const sale = (lines, tenders, o = {}) => ({ action: 'commit', saleId: 'web-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: '', lines, saleDiscountCents: 0, totals: o.totals, tenders, ...bell, ...o });

// ---- one profile per cell number; consent dated
R.c1 = await call('pos-customer', { action: 'save', name: 'Thandi Mokoena', phone: '082 555 0101', email: 'thandi@example.com', consent: { whatsapp: true, sms: false, email: true }, consentSource: 'till', ...bell });
const T = R.c1.customer || {};
check('created with the number as the key and consent dated', R.c1.ok && T.phoneKey === '27825550101' && T.consent.whatsapp.granted === true && T.consent.whatsapp.byName === 'Cathy' && T.consent.whatsapp.source === 'till' && /^\d{4}-/.test(T.consent.whatsapp.at) && T.consent.sms.granted === false && T.consent.email.granted === true && T.loyalty.points === 0, R.c1.error || T);
R.dup = await call('pos-customer', { action: 'save', name: 'T. Mokoena', phone: '+27 82 555 0101', ...bell }); check('the same number again is refused, naming the profile', R.dup.status === 409 && /already Thandi Mokoena/.test(R.dup.error), R.dup);
R.badPhone = await call('pos-customer', { action: 'save', name: 'X', phone: '12345', ...bell }); check('a bad number is refused', R.badPhone.status === 400 && /cell number/.test(R.badPhone.error), R.badPhone);
R.noPhone = await call('pos-customer', { action: 'save', name: 'X', ...bell }); check('a number is needed', R.noPhone.status === 400, R.noPhone);
R.acct = await call('pos-customer', { action: 'save', customerId: T.id, name: 'Thandi Mokoena', phone: '0825550101', accountEnabled: true, creditLimitCents: 100000, ...bell }); check('a cashier cannot open an account', R.acct.status === 403, R.acct);
R.c2 = await call('pos-customer', { action: 'save', name: 'Thandi M', phone: '0825550199', ...bell }); const T2 = R.c2.customer; check('a second profile (a duplicate person, other number)', R.c2.ok && T2.phoneKey === '27825550199', R.c2.error);
R.upd = await call('pos-customer', { action: 'save', customerId: T.id, name: 'Thandi Mokoena', phone: '0825550102', email: 'thandi@example.com', address: { line1: '5 Lane', city: 'Parow' }, consent: { whatsapp: false, sms: false, email: true }, ...bell });
check('number changed: the old key freed, the new taken; WhatsApp consent withdrawn with the date', R.upd.ok && R.upd.customer.phoneKey === '27825550102' && (await getDoc('pos/retail/customerPhones/BF_27825550101')) === null && (await getDoc('pos/retail/customerPhones/BF_27825550102')).customerId === T.id && R.upd.customer.consent.whatsapp.granted === false, R.upd.error || R.upd.customer);
R.cons = await call('pos-customer', { action: 'consent', customerId: T.id, channel: 'sms', granted: true, source: 'customer', ...bell }); check('consent recorded per channel', R.cons.ok && R.cons.consent.sms.granted && R.cons.consent.sms.source === 'customer', R.cons);

// ---- a sale earns points at Bronze: R 500 → 500 points; a second at Parow; Silver after R 1 000
R.s1 = await call('pos-sale', sale([{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], [{ method: 'card', amountCents: 50000 }], { customerId: T.id, totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) } }), own.idToken);
check('R 500 at Bronze: 500 points, the receipt line', R.s1.ok && R.s1.sale.loyalty && R.s1.sale.loyalty.earned === 500 && R.s1.sale.loyalty.balance === 500 && R.s1.sale.loyalty.tier === 'Bronze', R.s1.error || R.s1.sale.loyalty);
R.cu1 = await getDoc('pos/retail/customers/' + T.id); check('the customer: 500 points in one lot expiring in 12 months, stats', R.cu1.loyalty.points === 500 && R.cu1.loyalty.lots.length === 1 && R.cu1.loyalty.lots[0].expiresAt > new Date(Date.now() + 360 * 86400000).toISOString() && R.cu1.stats.salesCount === 1 && R.cu1.stats.spentCents === 50000 && R.cu1.loyalty.lifetimeCents === 50000, R.cu1.loyalty);
R.s2 = await call('pos-sale', sale([{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }, { productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'card', amountCents: 69900 }], { customerId: T.id, totals: { totalCents: 69900, vatCents: vatIn(50000, 1500) + vatIn(19900, 1500) }, ...parow }), own.idToken);
check('R 699 at Parow, still Bronze when earned: 699 points; lifetime R 1 199 → Silver now', R.s2.ok && R.s2.sale.loyalty.earned === 699 && R.s2.sale.loyalty.balance === 1199 && R.s2.sale.loyalty.tier === 'Silver', R.s2.error || R.s2.sale.loyalty);
R.s3 = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'card', amountCents: 19900 }], { customerId: T.id, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken);
check('at Silver (×1.5): R 199 → 298 points', R.s3.ok && R.s3.sale.loyalty.earned === 298 && R.s3.sale.loyalty.balance === 1497, R.s3.error || R.s3.sale.loyalty);

// ---- points pay: 1497 points = R 74.85; at least 100 points; the rest by card
R.few = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'points', amountCents: 100 }, { method: 'card', amountCents: 19800 }], { customerId: T.id, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken); check('fewer than 100 points at a time: refused', R.few.status === 400 && /At least 100 points/.test(R.few.error), R.few);
R.tooMany = await call('pos-sale', sale([{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], [{ method: 'points', amountCents: 10000 }, { method: 'card', amountCents: 40000 }], { customerId: T.id, totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) } }), own.idToken); check('more than they have: refused with the balance', R.tooMany.status === 400 && /Not enough points: 1497/.test(R.tooMany.error), R.tooMany);
R.noCust = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'points', amountCents: 5000 }, { method: 'card', amountCents: 14900 }], { totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken); check('points need the customer', R.noCust.status === 400 && /customer/.test(R.noCust.error), R.noCust);
R.s4 = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'points', amountCents: 5000 }, { method: 'card', amountCents: 14900 }], { customerId: T.id, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken);
check('R 50 in points (1000 points) + card: 1000 redeemed, points earned on the R 149 at Silver (223)', R.s4.ok && R.s4.sale.loyalty.redeemed === 1000 && R.s4.sale.loyalty.earned === 223 && R.s4.sale.loyalty.balance === 1497 - 1000 + 223 && R.s4.sale.paymentMethods.includes('points'), R.s4.error || R.s4.sale.loyalty);
R.cu2 = await getDoc('pos/retail/customers/' + T.id); check('oldest lots used first: the first lot (500) gone, the second 699 → 199 left', R.cu2.loyalty.points === 720 && R.cu2.loyalty.lots[0].left === 199 && R.cu2.loyalty.lots[0].points === 699, R.cu2.loyalty.lots);
let ledger = await listColl('loyaltyLedger'); check('the ledger: 4 earns and a redeem with balances', ledger.filter(l => l.kind === 'earn').length === 4 && ledger.filter(l => l.kind === 'redeem').length === 1 && ledger.find(l => l.kind === 'redeem').points === -1000, ledger.map(l => [l.kind, l.points, l.balanceAfter]));
const pays = await listColl('payments'); check('the points tender is a payment row with the points', pays.some(p => p.method === 'points' && p.amountCents === 5000 && p.points === 1000), pays.filter(p => p.method === 'points'));

// ---- expiry: a lot dated long ago is swept on the next sale
const cuNow = await getDoc('pos/retail/customers/' + T.id);
const oldLot = { points: 100, left: 100, earnedAt: '2024-01-01T00:00:00.000Z', expiresAt: '2025-01-01T00:00:00.000Z', saleId: '' };
await fetch(`${docs}/pos/retail/customers/${T.id}?updateMask.fieldPaths=loyalty`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { loyalty: toFs({ ...cuNow.loyalty, points: cuNow.loyalty.points + 100, lots: [oldLot, ...cuNow.loyalty.lots] }) } }) });
R.s5 = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'card', amountCents: 19900 }], { customerId: T.id, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken);
check('the expired lot is dropped before the balance is shown: 720 + 298 = 1018', R.s5.ok && R.s5.sale.loyalty.balance === 1018, R.s5.error || R.s5.sale.loyalty);
ledger = await listColl('loyaltyLedger'); check('an expire entry of −100', ledger.some(l => l.kind === 'expire' && l.points === -100), ledger.filter(l => l.kind === 'expire'));

// ---- history across stores; export; merge; anonymise
R.hist = await call('pos-customer', { action: 'history', customerId: T.id, ...bell });
check('history: 5 sales across Bellville and Parow, the ledger, the points value', R.hist.ok && R.hist.sales.length === 5 && R.hist.sales.some(s => s.storeId === 'BF-PAROW') && R.hist.ledger.length >= 6 && R.hist.loyalty.points === 1018 && R.hist.loyalty.valueCents === 1018 * 5 && R.hist.loyalty.tier === 'Silver', R.hist.error || [R.hist.sales.length, R.hist.loyalty]);
R.expCas = await call('pos-customer', { action: 'export', customerId: T.id, ...bell }); check('the export needs a manager', R.expCas.status === 403, R.expCas);
R.exp = await call('pos-customer', { action: 'export', customerId: T.id, ...bell }, own.idToken); check('the export: profile and history', R.exp.ok && R.exp.profile.name === 'Thandi Mokoena' && R.exp.sales.length === 5 && R.exp.entity === 'Bellville Furniture (Pty) Ltd' && R.exp.profile.consent.sms.granted === true, R.exp.error);
// the duplicate buys once and has credit; then the two are merged
R.s6 = await call('pos-sale', sale([{ productId: 'p_cushion', variantId: '', qty: 1, unitPriceCents: 19900, discountCents: 0 }], [{ method: 'card', amountCents: 19900 }], { customerId: T2.id, totals: { totalCents: 19900, vatCents: vatIn(19900, 1500) } }), own.idToken);
await fetch(`${docs}/pos/retail/customers/${T2.id}?updateMask.fieldPaths=storeCreditCents`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { storeCreditCents: { integerValue: '2500' } } }) });
R.mergeCas = await call('pos-customer', { action: 'merge', keepId: T.id, dropId: T2.id, ...bell }); check('merging needs a manager', R.mergeCas.status === 403, R.mergeCas);
R.merge = await call('pos-customer', { action: 'merge', keepId: T.id, dropId: T2.id, ...bell }, own.idToken);
check('merged: credit R 25 and 199 points moved, the other number kept as a second number', R.merge.ok && R.merge.customer.storeCreditCents === 2500 && R.merge.customer.loyalty.points === 1018 + 199 && R.merge.customer.mergedIds.includes(T2.id) && R.merge.customer.altPhones.includes('27825550199') && R.merge.customer.stats.salesCount === 6, R.merge.error || R.merge.customer);
R.dropped = await getDoc('pos/retail/customers/' + T2.id); check('the duplicate points at the kept profile, archived, empty', R.dropped.mergedInto === T.id && R.dropped.archived && R.dropped.storeCreditCents === 0 && R.dropped.loyalty.points === 0, R.dropped);
check('the duplicate’s number now finds the kept profile', (await getDoc('pos/retail/customerPhones/BF_27825550199')).customerId === T.id);
R.hist2 = await call('pos-customer', { action: 'history', customerId: T.id, ...bell }); check('history now includes the duplicate’s sale: 6', R.hist2.sales.length === 6, R.hist2.sales.length);
R.again = await call('pos-customer', { action: 'save', name: 'New Person', phone: '0825550199', ...bell }); check('that number cannot be reused for a new profile', R.again.status === 409, R.again);
// anonymise
R.anonCas = await call('pos-customer', { action: 'anonymise', customerId: T.id, reason: 'x', ...bell }); check('anonymising needs a manager', R.anonCas.status === 403, R.anonCas);
R.anon = await call('pos-customer', { action: 'anonymise', customerId: T.id, reason: 'POPIA request', ...bell }, own.idToken);
R.cuA = await getDoc('pos/retail/customers/' + T.id);
check('anonymised: the details gone, consent cleared, numbers freed, credit kept', R.anon.ok && R.cuA.name === 'Anonymised customer' && R.cuA.phone === '' && R.cuA.email === '' && !R.cuA.consent.sms.granted && R.cuA.anonymised && (await getDoc('pos/retail/customerPhones/BF_27825550102')) === null && (await getDoc('pos/retail/customerPhones/BF_27825550199')) === null && R.cuA.storeCreditCents === 2500, R.anon.error || R.cuA);
check('the invoice keeps its snapshot', (await getDoc('pos/retail/sales/' + R.s1.sale.id)).customerSnapshot.name === 'Thandi Mokoena');
R.saveAnon = await call('pos-customer', { action: 'save', customerId: T.id, name: 'Thandi', phone: '0825550102', ...bell }); check('an anonymised profile cannot be edited', R.saveAnon.status === 409, R.saveAnon);
R.fresh = await call('pos-customer', { action: 'save', name: 'Thandi Again', phone: '0825550102', ...bell }); check('the freed number can start a new profile', R.fresh.ok && R.fresh.customer.phoneKey === '27825550102', R.fresh.error);
R.pts = await call('pos-customer', { action: 'adjustPoints', adjustId: 'pts-welcome-1', customerId: R.fresh.customer.id, points: 50, note: 'Welcome', ...bell }, own.idToken); check('points by hand', R.pts.ok && R.pts.points === 50, R.pts.error);
R.ptsAgain = await call('pos-customer', { action: 'adjustPoints', adjustId: 'pts-welcome-1', customerId: R.fresh.customer.id, points: 50, note: 'Welcome', ...bell }, own.idToken); check('the same points again: not added twice', R.ptsAgain.ok && R.ptsAgain.again && R.ptsAgain.points === 50, R.ptsAgain);
const audit = await listColl('auditLog'); check('audited', ['customer.create', 'customer.update', 'customer.consent', 'customer.merge', 'customer.export', 'customer.anonymise', 'customer.points'].every(a => audit.some(x => x.action === a)), audit.map(a => a.action));

console.log(JSON.stringify({ fails, ...R, exp: undefined, hist: undefined, hist2: undefined }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'customer-api: all passed');
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
