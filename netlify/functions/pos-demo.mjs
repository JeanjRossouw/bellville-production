// Factory Manager POS — a demo business that has been trading for months. Built into an empty space of its
// own (never the first shops'), by that space's owner, from Admin → Companies: the company, two stores with
// registers, staff with PINs, products with fabrics, suppliers, customers and opening stock; then every trading
// day replayed through the real server code (shifts opened and closed, sales paid in cash, by card, EFT and on
// account, sales orders with deposits that go into production and out the door, quotes used and going cold,
// lay-bys paid off and collected, returns, account payments), with the clock turned back so every document
// carries its day. Nothing is faked around the rules: a sale that stock cannot cover is simply not rung up.
//
//   plan   {}              the owner, an empty space → { from, to, days: [dates] }
//   seed   {}              the business (idempotent)
//   day    { date }        one trading day (idempotent: a day done is done)
//   finish {}              quotes dated from their day; the space marked demo
//
// The app runs plan, then day by day, then finish (pos/js/demo.js). A day takes a few seconds.
import { json, Reject, clean, randomId, nowIso, getDoc, query, commit, serverStamp, bodyOf, withGroup, withClock, groupId, DEFAULT_GROUP, patchTop, requireMember, newSalt, hashPin, PIN_ITERATIONS, patchDoc } from './lib/pos.mjs';
import { prepareSale, runSale, moveWrites } from './lib/sale.mjs';
import { actions as sale } from './pos-sale.mjs';
import { actions as special } from './pos-special.mjs';
import { actions as layby } from './pos-layby.mjs';
import { actions as ret } from './pos-return.mjs';
import { actions as shift } from './pos-shift.mjs';
import { actions as customerActs } from './pos-customer.mjs';
import { actions as stockActs } from './pos-stock.mjs';
import { phoneKey, emailKey, blankConsent, blankLoyalty, blankStats } from '../../pos/js/loyalty-terms.js';

const ENT = 'DM';
const STORES = [{ id: 'DM-BELL', name: 'Bellville', register: 'DM-BELL-T1', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville', code: '7530' } },
  { id: 'DM-PAROW', name: 'Parow', register: 'DM-PAROW-T1', phone: '021 555 0200', address: { line1: '48 Main Rd', city: 'Parow', code: '7500' } }];
const STAFF = [
  { id: 'dm_lerato', name: 'Lerato Mokoena', role: 'manager', pin: '222222', storeIds: ['DM-BELL', 'DM-PAROW'] },
  { id: 'dm_sipho', name: 'Sipho Dlamini', role: 'cashier', pin: '111111', storeIds: ['DM-BELL'] },
  { id: 'dm_nadia', name: 'Nadia Jacobs', role: 'cashier', pin: '333333', storeIds: ['DM-PAROW'] }
];
const FABRICS = [
  { id: 'dmf_acap', supplier: 'Home Fabrics', design: 'Acapella', collection: 'FibreGuard', costCents: 60000 }, { id: 'dmf_linen', supplier: 'Hertex', design: 'Linen Sand', collection: 'Natural', costCents: 42000 },
  { id: 'dmf_velvet', supplier: 'Hertex', design: 'Velvet Navy', collection: 'Plush', costCents: 55000 }, { id: 'dmf_boucle', supplier: 'St Leger', design: 'Boucle Cream', collection: 'Texture', costCents: 68000 },
  { id: 'dmf_leather', supplier: 'Home Fabrics', design: 'Leather Look Tan', collection: 'Urban', costCents: 48000 }, { id: 'dmf_grey', supplier: 'Hertex', design: 'Weave Grey', collection: 'Natural', costCents: 38000 }
];
// stock products carry opening stock per store; couches are made to order in a fabric (frame + metres); the care kit is zero-rated for the sake of a VAT example
const PRODUCTS = [
  { id: 'dmp_chester', name: 'Chesterfield 3 Seater', sku: 'CH-3', category: 'Couches', type: 'mto', trackStock: false, priceCents: 1899900, costCents: 700000, framePriceCents: 950000, fabricMetres: 12, favourite: true },
  { id: 'dmp_lshape', name: 'Mia L-Shape Corner', sku: 'MIA-L', category: 'Couches', type: 'mto', trackStock: false, priceCents: 2399900, costCents: 900000, framePriceCents: 1250000, fabricMetres: 16, favourite: true },
  { id: 'dmp_daybed', name: 'Kendra Daybed', sku: 'KEN-D', category: 'Couches', type: 'mto', trackStock: false, priceCents: 1299900, costCents: 480000, framePriceCents: 650000, fabricMetres: 9 },
  { id: 'dmp_wing', name: 'Wingback Chair', sku: 'WB', category: 'Chairs', type: 'stock', priceCents: 499900, costCents: 190000, hasVariants: true, options: [{ name: 'Colour', values: ['Grey', 'Navy'] }], opening: 6, big: true },
  { id: 'dmp_dining', name: 'Oak Dining Table 6 Seater', sku: 'DT-6', category: 'Tables', type: 'stock', priceCents: 899900, costCents: 350000, opening: 3, big: true },
  { id: 'dmp_coffee', name: 'Coffee Table Walnut', sku: 'CT-W', category: 'Tables', type: 'stock', priceCents: 249900, costCents: 90000, opening: 8, big: true },
  { id: 'dmp_side', name: 'Side Table', sku: 'ST-1', category: 'Tables', type: 'stock', priceCents: 129900, costCents: 45000, opening: 10 },
  { id: 'dmp_cushion', name: 'Scatter Cushion', sku: 'CU-1', category: 'Accessories', type: 'stock', priceCents: 24900, costCents: 8000, opening: 60, favourite: true, barcodes: ['6001234500011'] },
  { id: 'dmp_throw', name: 'Knitted Throw', sku: 'TH-1', category: 'Accessories', type: 'stock', priceCents: 39900, costCents: 14000, opening: 40, favourite: true, barcodes: ['6001234500028'] },
  { id: 'dmp_lamp', name: 'Floor Lamp Brass', sku: 'LA-1', category: 'Lighting', type: 'stock', priceCents: 89900, costCents: 32000, opening: 15, favourite: true },
  { id: 'dmp_rug', name: 'Wool Rug 160 × 230', sku: 'RUG-2', category: 'Accessories', type: 'stock', priceCents: 189900, costCents: 70000, opening: 12 },
  { id: 'dmp_care', name: 'Fabric Care Kit', sku: 'CARE', category: 'Accessories', type: 'stock', priceCents: 14900, costCents: 5000, opening: 50, vatClass: 'zero', barcodes: ['6001234500035'] },
  { id: 'dmp_candle', name: 'Scented Candle', sku: 'CAN-1', category: 'Accessories', type: 'stock', priceCents: 19900, costCents: 6000, opening: 45, barcodes: ['6001234500042'] },
  { id: 'dmp_voucher', name: 'Gift voucher R500', sku: 'GV500', category: 'Vouchers', type: 'voucher', trackStock: false, priceCents: 50000, costCents: 0 },
  { id: 'dmp_delivery', name: 'Delivery (Cape Town)', sku: 'DEL', category: 'Services', type: 'nonstock', trackStock: false, priceCents: 45000, costCents: 0 }
];
const VARIANTS = [{ id: 'dmv_wing_grey', productId: 'dmp_wing', name: 'Grey', optionValues: { Colour: 'Grey' }, sku: 'WB-G', opening: 4 }, { id: 'dmv_wing_navy', productId: 'dmp_wing', name: 'Navy', optionValues: { Colour: 'Navy' }, sku: 'WB-N', priceCents: 529900, opening: 3 }];
const FIRST = ['Thandi', 'Sipho', 'Anele', 'Lerato', 'Pieter', 'Annelie', 'Johan', 'Nomvula', 'Riaan', 'Zanele', 'Fatima', 'Yusuf', 'Chantel', 'Bongani', 'Marlize', 'Kagiso', 'Dineo', 'Jacques', 'Naledi', 'Werner', 'Precious', 'Tshepo', 'Elmarie', 'Lwazi', 'Nadia', 'Andile', 'Charmaine', 'Mpho', 'Dirk', 'Ayesha', 'Zola', 'Hennie', 'Palesa', 'Rudi', 'Busi', 'Carla'];
const LAST = ['Mokoena', 'Dlamini', 'van der Merwe', 'Nkosi', 'Botha', 'Jacobs', 'Khumalo', 'Petersen', 'Naidoo', 'Mahlangu', 'Smit', 'Sithole', 'Adams', 'Ndlovu', 'du Plessis', 'Moloi', 'Williams', 'Zulu', 'Fourie', 'Mthembu'];
const STREETS = ['Oak Ave', 'Pine St', 'Voortrekker Rd', 'Main Rd', 'Elm Rd', 'Church St', 'Durban Rd', 'Jan Smuts Dr', 'Protea Cres', 'Acacia Way'];
const SUBURBS = [['Bellville', '7530'], ['Parow', '7500'], ['Durbanville', '7550'], ['Brackenfell', '7560'], ['Goodwood', '7460'], ['Kuils River', '7580'], ['Plattekloof', '7500'], ['Welgemoed', '7530']];
const COLOURS = ['Charcoal', 'Sand', 'Navy', 'Olive', 'Stone', 'Rust'];
const LEGS = ['Oak', 'Walnut', 'Black steel', 'Natural'];

// a small deterministic random stream: the same day builds the same way
function rng(seed) { let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } let a = h >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const chance = (r, p) => r() < p;
const at = (date, hm) => date + 'T' + hm + ':00.000+02:00';                       // a South African clock
const iso = (date, hm) => new Date(at(date, hm)).toISOString();
const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const todayZa = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const hm = (r, from, to) => { const m = between(r, from * 60, to * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const DENOMS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];
const denomsOf = (cents) => { const d = {}; let left = Math.max(0, Math.round(cents / 10) * 10); for (const x of DENOMS) { const n = Math.floor(left / x); if (n) { d[String(x)] = n; left -= n * x; } } return { denoms: d, totalCents: Math.max(0, Math.round(cents / 10) * 10) }; };
const SLOTS = ['08:00–12:00', '12:00–17:00'];

// only the owner of a space of their own, and never the first shops' space
async function owner(event) {
  const me = await requireMember(event);
  if (me.user.role !== 'owner') throw new Reject(403, 'The demo business is the owner’s to build.');
  if (groupId() === DEFAULT_GROUP) throw new Reject(403, 'Not here: the demo business goes into a space of its own. Sign up a demo login first.');
  return { uid: me.uid, name: me.user.name || 'Owner', role: 'owner' };
}
async function emptyOrDemo() {
  const ents = await query('entities', [], 5);
  if (ents.length && !ents.every(e => e.id === ENT)) throw new Reject(409, 'This space already has a company: the demo business goes into an empty space.');
  return ents.length > 0;
}
const stateDoc = async () => (await getDoc('demo', 'state')) || null;
const saveState = (st) => patchDoc('demo', 'state', { ...st, updatedAt: nowIso() });

// ------------------------------------------------------------ the world --
async function world() {
  const [entity, settings, stores, users, products, variants, fabrics, customers, st] = await Promise.all([
    getDoc('entities', ENT), getDoc('settings', ENT), query('stores', [{ field: 'entityId', value: ENT }], 10), query('users', [], 20),
    query('products', [{ field: 'entityId', value: ENT }], 100), query('variants', [{ field: 'entityId', value: ENT }], 100), query('fabrics', [{ field: 'entityId', value: ENT }], 50),
    query('customers', [{ field: 'entityId', value: ENT }], 500), stateDoc()]);
  if (!entity || !st) throw new Reject(409, 'Seed the business first.');
  const staff = (role, storeId) => users.find(u => u.role === role && (!storeId || (u.storeIds || []).includes(storeId))) || users.find(u => u.role === 'owner');
  return { entity: { ...entity, id: ENT }, settings: settings || {}, stores: stores.filter(s => s.active !== false).sort((a, b) => a.id.localeCompare(b.id)), users, products, variants, fabrics, customers: customers.filter(c => !c.anonymised), state: st, staff };
}
const ctxOf = (w, storeId, user, more = {}) => ({ user: { ...user, id: user.id }, device: null, deviceId: 'demo:' + storeId, entityId: ENT, storeId, registerId: '', shiftId: '', entity: w.entity, store: { ...w.stores.find(s => s.id === storeId), id: storeId }, settings: w.settings, ...more });
const ev = (ctx) => ({ __ctx: ctx, headers: { host: 'factorymanager.co.za' } });   // the client's order page link on an update
const money = (c) => 'R ' + (c / 100).toFixed(2);

// the server's own sums for a basket, so the body carries the totals the till would
async function totalsOf(ctx, body, opts = {}) {
  const o = { trusted: 'demo', noTenders: true, spec: true, ...opts };
  const first = await prepareSale(ctx, { ...body, tenders: [] }, o);
  body.lines.forEach((l, i) => { if (first.lines[i] && first.lines[i].listPriceCents) l.unitPriceCents = first.lines[i].listPriceCents; });
  const prep = await prepareSale(ctx, { ...body, tenders: [] }, o);
  return { totals: { totalCents: prep.total, vatCents: prep.vat }, prep };
}
const tenderFor = (r, kind, amount, customer) => {
  if (kind === 'cash') return { method: 'cash', amountCents: amount, tenderedCents: Math.ceil(amount / 10000) * 10000 || amount };
  if (kind === 'card') return { method: 'card', amountCents: amount, cardLast4: String(between(r, 1000, 9999)), approvalCode: String(between(r, 100000, 999999)) };
  if (kind === 'eft') return { method: 'eft', amountCents: amount, ref: ((customer && customer.name) || 'EFT').split(' ')[0].toUpperCase() + ' ' + between(r, 100, 999) };
  return { method: 'account', amountCents: amount };
};

// ------------------------------------------------------------------ seed --
async function seed(me) {
  const now = nowIso();
  const stamp = (storeId = '') => serverStamp(ENT, storeId, me.uid, 'demo');
  const writes = [];
  writes.push({ set: true, coll: 'entities', id: ENT, data: { legalName: 'Demo Furniture (Pty) Ltd', tradingName: 'Demo Furniture Co', regNo: '2019/123456/07', vatRegistered: true, vatNo: '4567890123', invoicePrefix: 'DM', creditNotePrefix: 'DM-CN', laybyPrefix: 'DM-LB', specialOrderPrefix: 'DM-SO', quotePrefix: 'DM-QT',
    address: { line1: '12 Voortrekker Rd', line2: '', city: 'Bellville', code: '7530' }, phone: '021 555 0100', email: 'hello@demofurniture.example', website: '', logoUrl: '', bank: { name: 'FNB', accountName: 'Demo Furniture (Pty) Ltd', accountNo: '62012345678', branchCode: '250655' }, active: true, demo: true, ...stamp() } });
  writes.push({ set: true, coll: 'settings', id: ENT, data: { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, receipt: { header: 'Thank you for shopping with us', footer: 'Made with care in Cape Town.', returnPolicy: 'Goods may be returned within 7 days with this receipt, unused and in their packaging.' },
    discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, cash: { varianceLimitCents: 5000 }, layby: { minDepositPct: 20, termDays: 90, penaltyPct: 1, frequency: 'monthly', reminderDays: 3 }, specialOrder: { minDepositPct: 50, leadDays: 21 },
    quotes: { validDays: 14 }, delivery: { defaultFeeCents: 45000, perSlot: 4, leadDays: 1, days: [1, 2, 3, 4, 5, 6], slots: SLOTS }, stock: { allowNegative: false }, buying: { updateCostsOnReceive: true }, loyalty: { enabled: true, pointsPerRand: 1, pointValueCents: 5, minRedeemPoints: 100, expiryMonths: 12, tiers: [{ name: 'Bronze', fromCents: 0, multiplier: 1 }, { name: 'Silver', fromCents: 1000000, multiplier: 1.5 }, { name: 'Gold', fromCents: 5000000, multiplier: 2 }] },
    session: { idleLogoutMinutes: 10, pinLength: 6 }, numbering: { blockSize: 50, refillBelow: 10 }, returns: { windowDays: 7, reasons: ['Changed mind', 'Faulty', 'Wrong item', 'Damaged', 'Other'] }, ...stamp() } });
  for (const s of STORES) {
    writes.push({ set: true, coll: 'stores', id: s.id, data: { entityId: ENT, name: s.name, phone: s.phone, address: s.address, receiptHeader: '', receiptFooter: '', paymentMethods: ['cash', 'card', 'eft', 'qr', 'voucher', 'storeCredit', 'account'], active: true, ...stamp(s.id) } });
    writes.push({ set: true, coll: 'registers', id: s.register, data: { name: 'Till 1', active: true, currentShiftId: '', ...stamp(s.id) } });
  }
  for (const u of STAFF) {
    writes.push({ set: true, coll: 'users', id: u.id, data: { email: '', name: u.name, role: u.role, active: true, entityIds: [ENT], storeIds: u.storeIds, defaultStoreId: u.storeIds[0], pinSet: true, demo: true, ...stamp() } });
    const salt = newSalt();
    writes.push({ set: true, coll: 'pinHashes', id: u.id, data: { hash: hashPin(u.pin, salt), salt, iterations: PIN_ITERATIONS, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '', ...stamp() } });
  }
  writes.push({ set: true, coll: 'suppliers', id: 'dms_hertex', data: { name: 'Hertex Fabrics', contact: 'Sales desk', phone: '021 555 0301', email: 'orders@hertex.example', accountNo: 'DM-114', termsDays: 30, leadDays: 5, notes: '', archived: false, ...stamp() } });
  writes.push({ set: true, coll: 'suppliers', id: 'dms_homefab', data: { name: 'Home Fabrics', contact: 'Ronel', phone: '021 555 0302', email: 'ronel@homefabrics.example', accountNo: 'DMF-77', termsDays: 30, leadDays: 7, notes: '', archived: false, ...stamp() } });
  writes.push({ set: true, coll: 'drivers', id: 'dmd_1', data: { name: 'Thabo (driver)', phone: '0825550909', active: true, ...stamp() } });
  for (const f of FABRICS) { const price = Math.max(25000, Math.round(f.costCents * 1.8 * 1.15 / 100) * 100); writes.push({ set: true, coll: 'fabrics', id: f.id, data: { supplier: f.supplier, design: f.design, collection: f.collection, costCents: f.costCents, markupPct: 80, minPriceCents: 25000, priceCents: price, archived: false, ...stamp() } }); }
  for (const p of PRODUCTS) {
    const { opening, big, ...rest } = p;
    writes.push({ set: true, coll: 'products', id: p.id, data: { sku: '', barcodes: [], category: '', brand: 'Demo', type: 'stock', vatClass: 'standard', trackStock: p.type === 'stock', costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: false, ...rest, ...stamp() } });
  }
  for (const v of VARIANTS) { const { opening, ...rest } = v; writes.push({ set: true, coll: 'variants', id: v.id, data: { barcodes: [], priceCents: null, costCents: null, storePrices: {}, archived: false, ...rest, ...stamp() } }); }
  const r = rng('customers');
  const customers = [];
  for (let i = 0; i < 36; i++) {
    const name = FIRST[i % FIRST.length] + ' ' + LAST[(i * 7 + 3) % LAST.length];
    const phone = '08' + pick(r, ['2', '3', '4', '6', '7', '8']) + String(5550000 + i * 37).padStart(7, '0');
    const [city, code] = pick(r, SUBURBS);
    const account = i < 6;
    const id = 'dmc_' + String(i + 1).padStart(2, '0');
    customers.push({ id, name, phone });
    writes.push({ set: true, coll: 'customers', id, data: { name, contact: name, phone, phoneKey: phoneKey(phone), email: chance(r, 0.6) ? name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com' : '', emailKey: '', vatNo: account && i < 3 ? '4' + String(100000000 + i * 1234567).slice(0, 9) : '', address: { line1: between(r, 1, 120) + ' ' + pick(r, STREETS), line2: '', city, code },
      dob: '', tags: account ? ['account'] : [], notes: '', consent: { whatsapp: { granted: chance(r, 0.7), at: now, byName: 'Demo', source: 'till' }, sms: { granted: false, at: '', byName: '', source: '' }, email: { granted: chance(r, 0.4), at: now, byName: 'Demo', source: 'till' } },
      accountEnabled: account, creditLimitCents: account ? 2000000 : 0, storeCreditCents: 0, accountBalanceCents: 0, accountAwaitingCents: 0, loyalty: blankLoyalty(), stats: blankStats(), mergedIds: [], altPhones: [], mergedInto: '', anonymised: false, anonymisedAt: '', archived: false, ...stamp(), serverReceivedAt: now } });
    writes.push({ set: true, coll: 'customerPhones', id: ENT + '_' + phoneKey(phone), data: { customerId: id, entityId: ENT, storeId: '', updatedAt: now } });
  }
  for (let i = 0; i < writes.length; i += 200) await commit(writes.slice(i, i + 200));
  // opening stock at each store, by a movement that says so (the levels are the sum of their movements)
  for (const s of STORES) {
    const ctx = { entityId: ENT, storeId: s.id, user: { id: me.uid, name: me.name || 'Owner' }, deviceId: 'demo' };
    await runSale(ctx, {}, { more: async (tx, levels) => {
      const w = [];
      const items = [...PRODUCTS.filter(p => p.type === 'stock' && !p.hasVariants).map(p => ({ productId: p.id, variantId: '', itemId: p.id, qty: p.opening, cost: p.costCents, name: p.name })), ...VARIANTS.map(v => ({ productId: v.productId, variantId: v.id, itemId: v.id, qty: v.opening, cost: PRODUCTS.find(p => p.id === v.productId).costCents, name: v.name }))];
      for (const it of items) { const lid = s.id + '_' + it.itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); if ((levels.get(lid) || {}).onHandQty > 0) continue; w.push(...moveWrites(ctx, levels, { productId: it.productId, variantId: it.variantId, itemId: it.itemId, qty: it.qty, unitCostCents: it.cost, wac: true, reason: 'opening', name: it.name, note: 'Opening stock (demo)', byName: 'Demo' }, { docType: 'opening', docId: 'demo-opening-' + s.id, docNo: '' }, stamp(s.id), now)); }
      return { writes: w, result: {} };
    } });
  }
  return customers.length;
}

// ------------------------------------------------------------- one day --
async function tradeDay(w, store, date, out) {
  const r = rng(store.id + date);
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  const cashier = w.staff('cashier', store.id), manager = w.staff('manager', store.id);
  const st = w.state;
  const addressed = w.customers.filter(c => c.address && c.address.line1);
  const accounts = w.customers.filter(c => c.accountEnabled);
  const stockItems = w.products.filter(p => p.type === 'stock' && !p.hasVariants).map(p => ({ p, v: null, itemId: p.id, price: p.priceCents, big: !!PRODUCTS.find(x => x.id === p.id && x.big) }))
    .concat(w.variants.map(v => ({ p: w.products.find(p => p.id === v.productId), v, itemId: v.id, price: v.priceCents || w.products.find(p => p.id === v.productId).priceCents, big: true })));
  const small = stockItems.filter(i => !i.big), big = stockItems.filter(i => i.big);
  const couches = w.products.filter(p => p.type === 'mto');
  const skip = (what, e) => out.skipped.push(store.id + ' ' + date + ' ' + what + ': ' + (e.message || e));

  // top up what the supplier delivered: anything running low (the stock block would otherwise stop the day's sales)
  const levels = await query('stockLevels', [{ field: 'entityId', value: ENT }, { field: 'storeId', value: store.id }], 200);
  for (const it of stockItems) {
    const lv = levels.find(l => l.id === store.id + '_' + it.itemId) || levels.find(l => (l.variantId || l.productId) === it.itemId);
    const have = lv ? (lv.onHandQty || 0) - (lv.reservedQty || 0) : 0;
    const want = it.big ? 3 : 12;
    if (have < want) { try { await withClock(iso(date, '08:15'), () => stockActs.adjust(ev(ctxOf(w, store.id, manager)), { productId: it.p.id, variantId: it.v ? it.v.id : '', qty: (it.big ? 6 : 36) - have, bucket: 'onHand', code: 'correction', note: 'Delivery from supplier (demo)', unitCostCents: it.v && it.v.costCents != null ? it.v.costCents : it.p.costCents, adjustId: 'demo-top-' + store.id + '-' + date + '-' + it.itemId, entityId: ENT, storeId: store.id })); } catch (e) { skip('top-up ' + it.itemId, e); } }
  }

  // the register opens
  const reg = STORES.find(s => s.id === store.id).register;
  let sh = null;
  try { const o = await withClock(iso(date, '08:30'), () => shift.open(ev(ctxOf(w, store.id, cashier)), { registerId: reg, float: { denoms: { '10000': 5, '5000': 4, '2000': 5, '1000': 10, '500': 10 } } })); sh = o.shift || (await getDoc('shifts', (await getDoc('registers', reg)).currentShiftId)); }
  catch (e) { const rg = await getDoc('registers', reg); sh = rg && rg.currentShiftId ? await getDoc('shifts', rg.currentShiftId) : null; if (!sh) { skip('shift', e); return; } }
  const shiftId = (await getDoc('registers', reg)).currentShiftId;
  const till = (user = cashier) => ctxOf(w, store.id, user, { registerId: reg, shiftId });
  const office = (user = manager) => ctxOf(w, store.id, user);

  // ---- sales through the day
  const n = dow === 6 ? between(r, 5, 8) : between(r, 3, 6);
  const times = Array.from({ length: n }, () => hm(r, 9, 17)).sort();
  for (let i = 0; i < n; i++) {
    const t = times[i];
    const lines = [];
    const k = chance(r, 0.15) ? 3 : chance(r, 0.5) ? 2 : 1;
    for (let j = 0; j < k; j++) { const it = chance(r, 0.18) ? pick(r, big) : pick(r, small); if (lines.some(l => l.itemId === it.itemId)) continue; lines.push({ productId: it.p.id, variantId: it.v ? it.v.id : '', itemId: it.itemId, qty: it.big ? 1 : between(r, 1, 2), unitPriceCents: it.price, discountCents: 0 }); }
    if (chance(r, 0.06)) lines.push({ productId: 'dmp_voucher', variantId: '', itemId: 'dmp_voucher', qty: 1, unitPriceCents: 50000, discountCents: 0 });
    const gross = lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);
    let customer = null;
    const method = chance(r, 0.38) ? 'cash' : chance(r, 0.78) ? 'card' : chance(r, 0.6) ? 'eft' : 'account';
    if (method === 'account') customer = pick(r, accounts); else if (gross > 500000 || chance(r, 0.4)) customer = pick(r, addressed);
    if (method === 'account' && (customer.accountBalanceCents || 0) + gross > (customer.creditLimitCents || 0)) { customer = pick(r, addressed); }
    const useMethod = method === 'account' && !customer.accountEnabled ? 'card' : method;
    const ctx = till();
    const saleId = 'demo-' + store.id + '-' + date + '-' + (i + 1);
    try {
      await withClock(iso(date, t), async () => {
        const body = { saleId, clientCreatedAt: iso(date, t), customerId: customer ? customer.id : '', lines, saleDiscountCents: 0, saleDiscountPct: 0, saleDiscountReason: '', note: '', entityId: ENT, storeId: store.id, registerId: reg };
        const { totals } = await totalsOf(ctx, body);
        body.totals = totals;
        body.tenders = [tenderFor(r, useMethod, totals.totalCents, customer)];
        const res = await sale.commit(ev(ctx), body);
        if (!res.again) { out.sales++; st.sales.push({ id: saleId, storeId: store.id, date, customerId: customer ? customer.id : '', method: useMethod, lines: (res.lines || []).filter(l => l.qty === 1 && l.fulfilment === 'stock').map(l => ({ lineNo: l.lineNo, name: l.name, netCents: l.netCents })) }); if (customer && useMethod === 'account') customer.accountBalanceCents = (customer.accountBalanceCents || 0) + totals.totalCents; }
      });
    } catch (e) { skip('sale ' + (i + 1), e); }
  }
  st.sales = st.sales.slice(-60);

  // ---- a return: something small bought in the last few days, back for a refund the way it was paid
  if (chance(r, 0.12)) {
    const cand = st.sales.filter(s => s.storeId === store.id && s.date < date && s.date >= addDays(date, -6) && s.lines.length && ['cash', 'card'].includes(s.method) && !s.returned);
    const s = cand.length ? pick(r, cand) : null;
    if (s) {
      const l = pick(r, s.lines);
      try { await withClock(iso(date, hm(r, 10, 16)), () => ret.credit(ev(till()), { creditId: 'demo-cn-' + s.id, saleId: s.id, lines: [{ saleLineNo: l.lineNo, qty: 1, reason: pick(r, ['Changed mind', 'Wrong item', 'Faulty']), disposition: 'restock' }], refunds: [{ method: s.method, amountCents: l.netCents }], customerId: s.customerId || '', clientCreatedAt: nowIso(), entityId: ENT, storeId: store.id, registerId: reg })); s.returned = true; out.returns++; }
      catch (e) { skip('return', e); }
    }
  }

  // ---- quotes: a couch in a fabric, priced by the server; half become an order within the week, the rest go cold
  if (chance(r, 0.22)) {
    const customer = pick(r, addressed), couch = pick(r, couches), fabric = pick(r, w.fabrics);
    const id = 'demo-qt-' + store.id + '-' + date;
    try {
      await withClock(iso(date, hm(r, 10, 16)), async () => {
        const ctx = office(cashier);
        const spec = { model: couch.name, size: '', fabric: '', fabricId: fabric.id, colour: pick(r, COLOURS), legs: pick(r, LEGS), notes: '' };
        const body = { quoteId: id, clientCreatedAt: nowIso(), customerId: customer.id, lines: [{ productId: couch.id, variantId: '', qty: 1, unitPriceCents: couch.priceCents, discountCents: 0, spec }], saleDiscountCents: 0, validDays: 14, note: chance(r, 0.3) ? 'Delivery included' : '', entityId: ENT, storeId: store.id };
        const { totals, prep } = await totalsOf(ctx, body, { quote: true });
        body.totals = totals;
        const res = await special.quote(ev(ctx), body);
        if (!res.again) { out.quotes++; st.quotes.push({ id, storeId: store.id, date, customerId: customer.id, orderOn: chance(r, 0.5) ? addDays(date, between(r, 2, 7)) : '' }); }
      });
    } catch (e) { skip('quote', e); }
  }

  // ---- sales orders: from a quote that is due, or walked in; a deposit now, the rest before delivery
  const dueQuote = st.quotes.find(q => q.storeId === store.id && q.orderOn && q.orderOn <= date && !q.ordered);
  if (dueQuote || chance(r, 0.2)) {
    const id = 'demo-so-' + store.id + '-' + date;
    try {
      await withClock(iso(date, hm(r, 10, 16)), async () => {
        const ctx = till();
        let body;
        if (dueQuote) {
          const q = await getDoc('quotes', dueQuote.id);
          const customer = w.customers.find(c => c.id === q.customerId);
          body = { orderId: id, clientCreatedAt: nowIso(), customerId: q.customerId, quoteId: q.id, lines: q.lines.map(l => ({ productId: l.productId, variantId: l.variantId || '', qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: 0, spec: l.spec, quoteId: q.id, quoteLine: l.lineNo })), saleDiscountCents: 0, totals: { totalCents: q.totalCents, vatCents: q.vatCents }, entityId: ENT, storeId: store.id, registerId: reg, _customer: customer };
        } else {
          const customer = pick(r, addressed), couch = pick(r, couches), fabric = pick(r, w.fabrics);
          const spec = { model: couch.name, size: '', fabric: '', fabricId: fabric.id, colour: pick(r, COLOURS), legs: pick(r, LEGS), notes: chance(r, 0.3) ? 'Firm seat' : '' };
          body = { orderId: id, clientCreatedAt: nowIso(), customerId: customer.id, lines: [{ productId: couch.id, variantId: '', qty: 1, unitPriceCents: couch.priceCents, discountCents: 0, spec }], saleDiscountCents: 0, entityId: ENT, storeId: store.id, registerId: reg, _customer: customer };
          const { totals } = await totalsOf(ctx, body, { order: true });
          body.totals = totals;
        }
        const customer = body._customer; delete body._customer;
        const depositKind = chance(r, 0.5) ? 'card' : chance(r, 0.6) ? 'cash' : 'eft';
        const deposit = Math.round(body.totals.totalCents * (chance(r, 0.7) ? 0.5 : 0.6) / 100) * 100;
        body.deposit = [tenderFor(r, depositKind, deposit, customer)];
        body.signoff = { accepted: true, signedBy: customer.name, signature: '' };
        body.expectedAt = addDays(date, between(r, 18, 24));
        body.note = '';
        const res = await special.open(ev(ctx), body);
        if (!res.again) {
          out.orders++;
          const ready = addDays(date, between(r, 12, 20));
          const plan = [];
          if (depositKind === 'eft') plan.push({ on: addDays(date, 1), what: 'confirmDeposit' });
          plan.push({ on: addDays(date, between(r, 2, 4)), what: 'inProduction' }, { on: ready, what: 'ready' }, { on: addDays(ready, between(r, 0, 2)), what: 'balance' }, { on: addDays(ready, between(r, 1, 3)), what: 'book' }, { on: addDays(ready, between(r, 3, 6)), what: 'deliver' });
          st.orders.push({ id, storeId: store.id, date, customerId: customer.id, kind: chance(r, 0.7) ? 'deliver' : 'collect', plan });
          if (dueQuote) dueQuote.ordered = true;
        }
      });
    } catch (e) { skip('order', e); }
  }

  // ---- order steps due today
  for (const o of st.orders.filter(o => o.storeId === store.id)) {
    for (const step of o.plan.filter(s => s.on <= date && !s.done)) {
      try {
        await withClock(iso(date, hm(r, 9, 17)), async () => {
          const so = await getDoc('specialOrders', o.id);
          if (!so || ['cancelled', 'delivered', 'collected'].includes(so.status)) { step.done = true; return; }
          const customer = w.customers.find(c => c.id === o.customerId);
          if (step.what === 'confirmDeposit') { const h = (so.history || []).find(x => x.status === 'awaiting'); if (h) await special.confirmPayment(ev(office()), { paymentId: h.paymentId, bankRef: 'FNB ' + between(r, 1000, 9999), entityId: ENT, storeId: store.id }); }
          else if (step.what === 'inProduction' || step.what === 'ready') { if (so.status === 'quoted' && step.what === 'inProduction') return; await special.status(ev(office()), { orderId: o.id, status: step.what, note: step.what === 'ready' ? 'Made and checked' : '', entityId: ENT, storeId: store.id }); }
          else if (step.what === 'balance') { const owed = so.balanceCents - (so.awaitingCents || 0); if (owed > 0) { const kind = chance(r, 0.7) ? 'card' : 'eft'; await special.pay(ev(till()), { orderId: o.id, paymentId: 'demo-bal-' + o.id, tenders: [tenderFor(r, kind, owed, customer)], clientCreatedAt: nowIso(), entityId: ENT, storeId: store.id, registerId: reg }); if (kind === 'eft') o.plan.push({ on: addDays(date, 1), what: 'confirmBalance' }); } }
          else if (step.what === 'confirmBalance') { const h = (so.history || []).find(x => x.status === 'awaiting'); if (h) await special.confirmPayment(ev(office()), { paymentId: h.paymentId, bankRef: 'FNB ' + between(r, 1000, 9999), entityId: ENT, storeId: store.id }); }
          else if (step.what === 'book') { if (so.status !== 'ready') return; await special.book(ev(office()), { orderId: o.id, kind: o.kind, date: o.plan.find(s => s.what === 'deliver').on, slot: pick(r, SLOTS), address: customer.address, phone: customer.phone, note: '', entityId: ENT, storeId: store.id }); }
          else if (step.what === 'deliver') { if (so.status !== 'ready' || so.balanceCents > 0) return; await special.deliver(ev(till()), { orderId: o.id, saleId: 'demo-inv-' + o.id, signedBy: customer.name, signature: '', note: '', entityId: ENT, storeId: store.id, registerId: reg }); }
          step.done = true;
        });
      } catch (e) { skip('order ' + o.id + ' ' + step.what, e); step.done = true; }
    }
  }
  // the client told: most updates go the same day (the WhatsApp text is logged on the order)
  const due = await query('specialOrders', [{ field: 'entityId', value: ENT }, { field: 'storeId', value: store.id }, { field: 'updateDue', value: true }], 50);
  for (const so of due.filter(o => o.status !== 'quoted' && chance(r, 0.8))) { try { await withClock(iso(date, hm(r, 10, 17)), () => special.update(ev(office(cashier)), { orderId: so.id, how: 'whatsapp', entityId: ENT, storeId: store.id })); } catch (e) { skip('update ' + so.docNo, e); } }
  st.orders = st.orders.filter(o => o.plan.some(s => !s.done) || o.date >= addDays(date, -40));

  // ---- lay-bys: a chair or a rug put away, a deposit now, paid off over weeks, then collected
  if (chance(r, 0.07)) {
    const id = 'demo-lb-' + store.id + '-' + date, customer = pick(r, addressed);
    try {
      await withClock(iso(date, hm(r, 10, 16)), async () => {
        const ctx = till();
        const it = pick(r, big);
        const body = { laybyId: id, clientCreatedAt: nowIso(), customerId: customer.id, lines: [{ productId: it.p.id, variantId: it.v ? it.v.id : '', qty: 1, unitPriceCents: it.price, discountCents: 0 }], saleDiscountCents: 0, termDays: 60, frequency: 'fortnightly', entityId: ENT, storeId: store.id, registerId: reg };
        const { totals } = await totalsOf(ctx, body);
        body.totals = totals;
        body.deposit = [tenderFor(r, chance(r, 0.5) ? 'cash' : 'card', Math.round(totals.totalCents * 0.25 / 100) * 100, customer)];
        body.agreement = { accepted: true, signedBy: customer.name, signature: '' };
        const res = await layby.open(ev(ctx), body);
        if (!res.again) { out.laybys++; st.laybys.push({ id, storeId: store.id, customerId: customer.id, plan: [addDays(date, 14), addDays(date, 28), addDays(date, 42)].map(on => ({ on, what: 'pay' })).concat([{ on: addDays(date, 45), what: 'collect' }]) }); }
      });
    } catch (e) { skip('lay-by', e); }
  }
  for (const lb of st.laybys.filter(l => l.storeId === store.id)) {
    for (const step of lb.plan.filter(s => s.on <= date && !s.done)) {
      try {
        await withClock(iso(date, hm(r, 9, 17)), async () => {
          const doc = await getDoc('laybys', lb.id);
          if (!doc || doc.status !== 'open') { step.done = true; return; }
          const customer = w.customers.find(c => c.id === lb.customerId);
          if (step.what === 'pay' && doc.balanceCents > 0) await layby.pay(ev(till()), { laybyId: lb.id, paymentId: 'demo-lbp-' + lb.id + '-' + step.on, tenders: [tenderFor(r, chance(r, 0.6) ? 'card' : 'cash', Math.min(doc.balanceCents, Math.round(doc.totalCents * 0.25 / 100) * 100 || doc.balanceCents), customer)], clientCreatedAt: nowIso(), entityId: ENT, storeId: store.id, registerId: reg });
          else if (step.what === 'collect') { if (doc.balanceCents > 0) await layby.pay(ev(till()), { laybyId: lb.id, paymentId: 'demo-lbp-' + lb.id + '-final', tenders: [tenderFor(r, 'card', doc.balanceCents, customer)], clientCreatedAt: nowIso(), entityId: ENT, storeId: store.id, registerId: reg }); await layby.complete(ev(till()), { laybyId: lb.id, saleId: 'demo-lbinv-' + lb.id, signedBy: customer.name, signature: '', entityId: ENT, storeId: store.id, registerId: reg }); }
          step.done = true;
        });
      } catch (e) { skip('lay-by ' + lb.id + ' ' + step.what, e); step.done = true; }
    }
  }
  st.laybys = st.laybys.filter(l => l.plan.some(s => !s.done));

  // ---- account customers pay early in the month (an EFT waits for the manager)
  if (Number(date.slice(8, 10)) <= 5 && store.id === STORES[0].id) {
    for (const c of accounts) {
      const cur = await getDoc('customers', c.id);
      const owed = (cur.accountBalanceCents || 0) - (cur.accountAwaitingCents || 0);
      if (owed <= 0 || !chance(r, 0.5)) continue;
      const amount = chance(r, 0.6) ? owed : Math.round(owed * 0.6 / 100) * 100;
      const kind = chance(r, 0.5) ? 'eft' : 'card';
      try {
        await withClock(iso(date, hm(r, 9, 12)), () => customerActs.accountPayment(ev(office()), { customerId: c.id, paymentId: 'demo-ap-' + c.id + '-' + date, tenders: [tenderFor(r, kind, amount, cur)], note: 'Monthly payment', clientCreatedAt: nowIso(), entityId: ENT, storeId: store.id }));
        out.accountPayments++; c.accountBalanceCents = Math.max(0, (c.accountBalanceCents || 0) - amount);
        if (kind === 'eft') st.bank.push({ on: addDays(date, 2), customerId: c.id });
      } catch (e) { skip('account payment ' + c.id, e); }
    }
  }
  for (const b of st.bank.filter(x => x.on <= date && !x.done)) {
    try {
      const pays = await query('payments', [{ field: 'entityId', value: ENT }, { field: 'status', value: 'awaiting' }], 50);
      const ap = []; for (const p of pays.filter(p => p.docType === 'accountPayment')) { const d = await getDoc('accountPayments', p.docId); if (d && d.customerId === b.customerId) ap.push(p); }
      for (const p of ap) await withClock(iso(date, '09:30'), () => customerActs.confirmAccountPayment(ev(office()), { paymentId: p.id, bankRef: 'FNB ' + between(r, 1000, 9999), entityId: ENT, storeId: store.id }));
    } catch (e) { skip('bank ' + b.customerId, e); }
    b.done = true;
  }
  st.bank = st.bank.filter(b => !b.done);

  // ---- the register closes: the cash counted as it is (a rand or two out now and then)
  try {
    const pays = await query('payments', [{ field: 'entityId', value: ENT }, { field: 'shiftId', value: shiftId }], 500);
    const cash = pays.filter(p => p.method === 'cash').reduce((s, p) => s + (p.amountCents || 0), 0);
    const shiftDoc = await getDoc('shifts', shiftId);
    const expected = (shiftDoc.openingFloat || {}).totalCents + cash;
    const counted = expected + (chance(r, 0.1) ? -between(r, 1, 4) * 1000 : 0);
    await withClock(iso(date, '17:45'), () => shift.close(ev(till()), { shiftId, counted: { cash: denomsOf(counted) }, note: '', entityId: ENT, storeId: store.id, registerId: reg }));
  } catch (e) { skip('cash-up', e); }
}

export const actions = {
  async plan(event) {
    const me = await owner(event);
    const seeded = await emptyOrDemo();
    const st = seeded ? await stateDoc() : null;
    const to = todayZa();
    const from = st ? st.from : addDays(to, -182);
    const days = []; for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(d + 'T12:00:00Z').getUTCDay() !== 0) days.push(d);
    return { ok: true, from, to, days, done: st ? st.days || [] : [], seeded, owner: me.name || '' };
  },
  async seed(event) {
    const me = await owner(event);
    const seeded = await emptyOrDemo();
    const to = todayZa(), from = addDays(to, -182);
    let customers = 0;
    if (!seeded) customers = await withClock(iso(from, '08:00'), () => seed(me));
    if (!(await stateDoc())) await commit([{ set: true, coll: 'demo', id: 'state', data: { from, to, days: [], sales: [], quotes: [], orders: [], laybys: [], bank: [], createdAt: nowIso(), updatedAt: nowIso() } }]);
    await patchTop('posGroups/' + groupId(), { demo: true }).catch(() => {});
    return { ok: true, seeded: !seeded, customers, from, to, staff: STAFF.map(s => ({ name: s.name, role: s.role, pin: s.pin, stores: s.storeIds })) };
  },
  async day(event, b) {
    await owner(event);
    const date = clean(b.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Reject(400, 'Which day?');
    const w = await world();
    if ((w.state.days || []).includes(date)) return { ok: true, date, again: true };
    if (date > todayZa()) throw new Reject(400, 'Not a day that has come yet.');
    const out = { date, sales: 0, orders: 0, quotes: 0, laybys: 0, returns: 0, accountPayments: 0, skipped: [] };
    for (const store of w.stores) await tradeDay(w, store, date, out);
    w.state.days = [...(w.state.days || []), date].slice(-400);
    await saveState(w.state);
    return { ok: true, ...out };
  },
  // quotes carry the date they were made (the server dates a quote from the real clock when it is made)
  async finish(event) {
    await owner(event);
    const quotes = await query('quotes', [{ field: 'entityId', value: ENT }], 500);
    let dated = 0;
    for (const q of quotes) { const until = addDays(String(q.quotedAt || q.createdAt).slice(0, 10), q.validDays || 14); if (q.validUntil !== until) { await patchDoc('quotes', q.id, { validUntil: until }); dated++; } }
    const st = await stateDoc();
    const counts = {};
    for (const coll of ['sales', 'specialOrders', 'quotes', 'laybys', 'creditNotes', 'accountPayments', 'shifts']) counts[coll] = (await query(coll, [{ field: 'entityId', value: ENT }], 5000)).length;
    return { ok: true, dated, days: st ? (st.days || []).length : 0, counts, staff: STAFF.map(s => ({ name: s.name, role: s.role, pin: s.pin, stores: s.storeIds })) };
  }
};

const handleRequest = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-demo failed:', e);
    return json(500, { error: 'The demo step failed: ' + String(e.message).slice(0, 200) });
  }
};
export const handler = withGroup(handleRequest);
