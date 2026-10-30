// Retail POS — the owner's dashboard and the reports, aggregated on the
// server from the finished documents. Managers see their entities, the
// owner all. Nothing here writes.
//
//   dashboard { entityId? }                      → each store: today vs the same weekday last week
//   run       { report, entityId, storeId?, from, to (dates), staffUid?, channel?, days? }
//             → { columns [ { key, label, type } ], rows, totals, title }
//   reports: dailySales, zReports, vat, byProduct, byCategory, byBrand, byStaff, byHour, discounts, voids,
//            refunds, stockValue, lowStock, movements, deadStock, laybys, specialOrders, orderPayments, customers
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, getDoc, query, loginOf, loadUser, inEntity, inStore, rank, bodyOf, withGroup } from './lib/pos.mjs';
import { expectedBy } from '../../pos/js/layby-terms.js';

const METHODS = ['cash', 'card', 'eft', 'qr', 'voucher', 'storeCredit', 'account', 'points', 'creditNote', 'layby', 'specialOrder'];
const dayOf = (iso) => String(iso || '').slice(0, 10);
const r2 = (c) => c;   // cents stay cents; the till formats

async function who(event, b) {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const user = await loadUser(login.sub);
  if (!user || rank(user.role) < rank('manager')) throw new Reject(403, 'Reports are for managers and the owner.');
  const entityId = clean(b.entityId, 40);
  if (entityId && !inEntity(user, entityId)) throw new Reject(403, 'Not your company.');
  const storeId = clean(b.storeId, 40);
  if (storeId && !inStore(user, storeId)) throw new Reject(403, 'Not your store.');
  return { user, entityId, storeId };
}
// the stores a report covers: one, or every active store of the entity the user may see
async function storesOf(w, entityId) {
  const all = (await query('stores', [{ field: 'entityId', value: entityId }], 100)).filter(s => s.active !== false && inStore(w.user, s.id));
  return w.storeId ? all.filter(s => s.id === w.storeId) : all;
}
const range = (field, from, to) => [{ field, op: 'GREATER_THAN_OR_EQUAL', value: from + 'T00:00:00.000Z' }, { field, op: 'LESS_THAN_OR_EQUAL', value: to + 'T23:59:59.999Z' }];
async function perStore(coll, entityId, stores, field, from, to, max = 5000) {
  const out = [];
  for (const s of stores) out.push(...(await query(coll, [{ field: 'entityId', value: entityId }, { field: 'storeId', value: s.id }, ...range(field, from, to)], max)));
  return out;
}
const sum = (rows, f) => rows.reduce((n, r) => n + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);
const groupBy = (rows, keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const col = (key, label, type = 'text') => ({ key, label, type });
const filt = (sales, w, b) => sales.filter(s => (!b.staffUid || s.cashierUid === b.staffUid) && (!b.channel || (s.source || 'till') === b.channel));

const reports = {
  async dailySales(w, b, stores, from, to) {
    const sales = filt(await perStore('sales', w.entityId, stores, 'clientCreatedAt', from, to), w, b);
    const notes = await perStore('creditNotes', w.entityId, stores, 'clientCreatedAt', from, to);
    const pays = (await perStore('payments', w.entityId, stores, 'createdAt', from, to)).filter(p => p.status !== 'void');
    const rows = [];
    for (const [k, g] of groupBy(sales, s => dayOf(s.clientCreatedAt) + '|' + s.storeId)) {
      const [day, storeId] = k.split('|');
      const ns = notes.filter(n => dayOf(n.clientCreatedAt) === day && n.storeId === storeId);
      const ps = pays.filter(p => dayOf(p.createdAt) === day && p.storeId === storeId);
      const by = Object.fromEntries(METHODS.map(m => [m, sum(ps.filter(p => p.method === m), 'amountCents')]));
      rows.push({ day, store: (stores.find(s => s.id === storeId) || {}).name || storeId, sales: g.length, items: sum(g, 'lineCount'), gross: sum(g, 'subtotalCents'), discounts: sum(g, s => (s.lineDiscountCents || 0) + (s.saleDiscountCents || 0)), total: sum(g, 'totalCents'), vat: sum(g, 'vatCents'), refunds: sum(ns, 'totalCents'), net: sum(g, 'totalCents') - sum(ns, 'totalCents'), basket: g.length ? Math.round(sum(g, 'totalCents') / g.length) : 0, cash: by.cash, card: by.card, eft: by.eft, qr: by.qr, other: by.voucher + by.storeCredit + by.account + by.points + by.layby + by.specialOrder + by.creditNote });
    }
    rows.sort((x, y) => x.day.localeCompare(y.day) || x.store.localeCompare(y.store));
    const tot = (f) => sum(rows, f);
    return { title: 'Daily sales', columns: [col('day', 'Day', 'date'), col('store', 'Store'), col('sales', 'Sales', 'int'), col('items', 'Lines', 'int'), col('gross', 'Gross', 'cents'), col('discounts', 'Discounts', 'cents'), col('total', 'Sales incl. VAT', 'cents'), col('vat', 'VAT', 'cents'), col('refunds', 'Refunds', 'cents'), col('net', 'Net', 'cents'), col('basket', 'Avg basket', 'cents'), col('cash', 'Cash', 'cents'), col('card', 'Card', 'cents'), col('eft', 'EFT', 'cents'), col('qr', 'QR', 'cents'), col('other', 'Other tenders', 'cents')], rows,
      totals: { sales: tot('sales'), items: tot('items'), gross: tot('gross'), discounts: tot('discounts'), total: tot('total'), vat: tot('vat'), refunds: tot('refunds'), net: tot('net'), basket: rows.length && tot('sales') ? Math.round(tot('total') / tot('sales')) : 0, cash: tot('cash'), card: tot('card'), eft: tot('eft'), qr: tot('qr'), other: tot('other') } };
  },
  async zReports(w, b, stores, from, to) {
    const shifts = (await perStore('shifts', w.entityId, stores, 'openedAt', from, to)).filter(s => s.status === 'closed' && (!b.staffUid || s.openedBy === b.staffUid || s.closedBy === b.staffUid));
    const regs = await query('registers', [{ field: 'entityId', value: w.entityId }], 200);
    const rows = shifts.map(s => ({ day: dayOf(s.openedAt), store: (stores.find(x => x.id === s.storeId) || {}).name || s.storeId, register: (regs.find(r => r.id === s.registerId) || {}).name || s.registerId, opened: s.openedAt, closed: s.closedAt, openedBy: s.openedByName, closedBy: s.closedByName, sales: s.salesCount || 0, total: s.salesTotalCents || 0, float: (s.openingFloat || {}).totalCents || 0, expectedCash: (s.expectedByMethod || {}).cash || 0, countedCash: (s.countedByMethod || {}).cash || 0, variance: s.varianceCents || 0, card: (s.expectedByMethod || {}).card || 0, approvedBy: (s.varianceApprovedBy || {}).name || '', note: s.closingNote || '' })).sort((x, y) => x.opened.localeCompare(y.opened));
    return { title: 'Z-reports (register closes)', columns: [col('day', 'Day', 'date'), col('store', 'Store'), col('register', 'Register'), col('opened', 'Opened', 'time'), col('closed', 'Closed', 'time'), col('openedBy', 'Opened by'), col('closedBy', 'Closed by'), col('sales', 'Sales', 'int'), col('total', 'Sales total', 'cents'), col('float', 'Float', 'cents'), col('expectedCash', 'Expected cash', 'cents'), col('countedCash', 'Counted cash', 'cents'), col('variance', 'Variance', 'cents'), col('card', 'Card', 'cents'), col('approvedBy', 'Variance approved by'), col('note', 'Note')], rows, totals: { sales: sum(rows, 'sales'), total: sum(rows, 'total'), variance: sum(rows, 'variance'), card: sum(rows, 'card') } };
  },
  async vat(w, b, stores, from, to) {
    const entity = await getDoc('entities', w.entityId);
    const sales = filt(await perStore('sales', w.entityId, stores, 'clientCreatedAt', from, to), w, b);
    const notes = await perStore('creditNotes', w.entityId, stores, 'clientCreatedAt', from, to);
    const rows = [];
    for (const [rate, g] of groupBy(sales, s => s.vatRateBp || 0)) {
      const ns = notes.filter(n => (n.vatRateBp || 0) === rate);
      rows.push({ entity: entity ? entity.legalName : w.entityId, vatNo: entity ? entity.vatNo || '' : '', rate: rate / 100 + '%', sales: g.length, incl: sum(g, 'totalCents'), vat: sum(g, 'vatCents'), excl: sum(g, 'totalCents') - sum(g, 'vatCents'), creditNotes: ns.length, cnIncl: sum(ns, 'totalCents'), cnVat: sum(ns, 'vatCents'), netIncl: sum(g, 'totalCents') - sum(ns, 'totalCents'), netVat: sum(g, 'vatCents') - sum(ns, 'vatCents') });
    }
    return { title: 'VAT report · ' + (entity ? entity.legalName : w.entityId) + (entity && entity.vatNo ? ' · VAT no ' + entity.vatNo : ''), columns: [col('rate', 'Rate'), col('sales', 'Invoices', 'int'), col('incl', 'Sales incl.', 'cents'), col('excl', 'Sales excl.', 'cents'), col('vat', 'Output VAT', 'cents'), col('creditNotes', 'Credit notes', 'int'), col('cnIncl', 'Credits incl.', 'cents'), col('cnVat', 'VAT reversed', 'cents'), col('netIncl', 'Net sales incl.', 'cents'), col('netVat', 'Net output VAT', 'cents')], rows, totals: { sales: sum(rows, 'sales'), incl: sum(rows, 'incl'), excl: sum(rows, 'excl'), vat: sum(rows, 'vat'), creditNotes: sum(rows, 'creditNotes'), cnIncl: sum(rows, 'cnIncl'), cnVat: sum(rows, 'cnVat'), netIncl: sum(rows, 'netIncl'), netVat: sum(rows, 'netVat') } };
  },
  // sold lines grouped, with the cost snapshot for gross profit; returns taken off by product
  async _lines(w, b, stores, from, to, keyFn, label) {
    const sales = filt(await perStore('sales', w.entityId, stores, 'clientCreatedAt', from, to), w, b);
    const ids = new Set(sales.map(s => s.id));
    const lines = (await perStore('saleLines', w.entityId, stores, 'createdAt', from, to, 20000)).filter(l => ids.has(l.saleId));
    const notes = await perStore('creditNotes', w.entityId, stores, 'clientCreatedAt', from, to);
    const ret = new Map(); for (const n of notes) for (const l of n.lines || []) { const k = l.productId; ret.set(k, { qty: ((ret.get(k) || {}).qty || 0) + l.qty, cents: ((ret.get(k) || {}).cents || 0) + l.lineTotalCents }); }
    const products = new Map((await query('products', [{ field: 'entityId', value: w.entityId }], 5000)).map(p => [p.id, p]));
    const rows = [];
    for (const [k, g] of groupBy(lines, l => keyFn(l, products.get(l.productId) || {}))) {
      const revenue = sum(g, 'netCents'), cost = sum(g, l => (l.costCents || 0) * l.qty), vat = sum(g, 'vatCents');
      const returned = [...new Set(g.map(l => l.productId))].reduce((acc, pid) => { const r = ret.get(pid); return r && keyFn({ productId: pid }, products.get(pid) || {}) === k ? { qty: acc.qty + r.qty, cents: acc.cents + r.cents } : acc; }, { qty: 0, cents: 0 });
      rows.push({ key: k, qty: sum(g, 'qty'), returnedQty: returned.qty, revenue, returned: returned.cents, net: revenue - returned.cents, vat, excl: revenue - vat, cost, gp: revenue - vat - cost, gpPct: revenue - vat ? Math.round((revenue - vat - cost) / (revenue - vat) * 1000) / 10 : 0, discounts: sum(g, l => (l.discountCents || 0) + (l.saleDiscountCents || 0)) });
    }
    rows.sort((x, y) => y.revenue - x.revenue);
    const t = { qty: sum(rows, 'qty'), returnedQty: sum(rows, 'returnedQty'), revenue: sum(rows, 'revenue'), returned: sum(rows, 'returned'), net: sum(rows, 'net'), vat: sum(rows, 'vat'), excl: sum(rows, 'excl'), cost: sum(rows, 'cost'), gp: sum(rows, 'gp'), discounts: sum(rows, 'discounts') };
    t.gpPct = t.excl ? Math.round(t.gp / t.excl * 1000) / 10 : 0;
    return { title: 'Sales by ' + label, columns: [col('key', label[0].toUpperCase() + label.slice(1)), col('qty', 'Sold', 'int'), col('returnedQty', 'Returned', 'int'), col('revenue', 'Sales incl.', 'cents'), col('discounts', 'Discounts', 'cents'), col('returned', 'Refunded', 'cents'), col('net', 'Net incl.', 'cents'), col('excl', 'Sales excl. VAT', 'cents'), col('cost', 'Cost', 'cents'), col('gp', 'Gross profit', 'cents'), col('gpPct', 'GP %', 'pct')], rows, totals: t };
  },
  byProduct(w, b, s, f, t) { return reports._lines(w, b, s, f, t, (l, p) => l.name || p.name || l.productId, 'product'); },
  byCategory(w, b, s, f, t) { return reports._lines(w, b, s, f, t, (l, p) => p.category || '(no category)', 'category'); },
  byBrand(w, b, s, f, t) { return reports._lines(w, b, s, f, t, (l, p) => p.brand || '(no brand)', 'brand'); },
  async byStaff(w, b, stores, from, to) {
    const sales = filt(await perStore('sales', w.entityId, stores, 'clientCreatedAt', from, to), w, b);
    const notes = await perStore('creditNotes', w.entityId, stores, 'clientCreatedAt', from, to);
    const rows = [];
    for (const [uid, g] of groupBy(sales, s => s.cashierUid)) { const ns = notes.filter(n => n.cashierUid === uid); rows.push({ staff: g[0].cashierName, sales: g.length, total: sum(g, 'totalCents'), basket: Math.round(sum(g, 'totalCents') / g.length), items: sum(g, 'lineCount'), discounts: sum(g, s => (s.lineDiscountCents || 0) + (s.saleDiscountCents || 0)), refunds: ns.length, refunded: sum(ns, 'totalCents'), net: sum(g, 'totalCents') - sum(ns, 'totalCents') }); }
    rows.sort((x, y) => y.total - x.total);
    return { title: 'Sales by staff', columns: [col('staff', 'Staff'), col('sales', 'Sales', 'int'), col('items', 'Lines', 'int'), col('total', 'Sales incl.', 'cents'), col('basket', 'Avg basket', 'cents'), col('discounts', 'Discounts given', 'cents'), col('refunds', 'Refunds', 'int'), col('refunded', 'Refunded', 'cents'), col('net', 'Net', 'cents')], rows, totals: { sales: sum(rows, 'sales'), items: sum(rows, 'items'), total: sum(rows, 'total'), basket: sales.length ? Math.round(sum(sales, 'totalCents') / sales.length) : 0, discounts: sum(rows, 'discounts'), refunds: sum(rows, 'refunds'), refunded: sum(rows, 'refunded'), net: sum(rows, 'net') } };
  },
  async byHour(w, b, stores, from, to) {
    const sales = filt(await perStore('sales', w.entityId, stores, 'clientCreatedAt', from, to), w, b);
    const tz = Number(b.tzOffsetMin) || -120;   // South Africa: UTC+2
    const rows = [];
    for (let h = 0; h < 24; h++) { const g = sales.filter(s => ((new Date(Date.parse(s.clientCreatedAt) - tz * 60000)).getUTCHours()) === h); if (g.length) rows.push({ hour: String(h).padStart(2, '0') + ':00', sales: g.length, total: sum(g, 'totalCents'), basket: Math.round(sum(g, 'totalCents') / g.length), items: sum(g, 'lineCount') }); }
    return { title: 'Sales by hour of day', columns: [col('hour', 'Hour'), col('sales', 'Sales', 'int'), col('items', 'Lines', 'int'), col('total', 'Sales incl.', 'cents'), col('basket', 'Avg basket', 'cents')], rows, totals: { sales: sum(rows, 'sales'), items: sum(rows, 'items'), total: sum(rows, 'total'), basket: sales.length ? Math.round(sum(sales, 'totalCents') / sales.length) : 0 } };
  },
  async discounts(w, b, stores, from, to) {
    const sales = filt(await perStore('sales', w.entityId, stores, 'clientCreatedAt', from, to), w, b).filter(s => (s.lineDiscountCents || 0) + (s.saleDiscountCents || 0) > 0);
    const ids = new Set(sales.map(s => s.id));
    const lines = (await perStore('saleLines', w.entityId, stores, 'createdAt', from, to, 20000)).filter(l => ids.has(l.saleId) && (l.discountCents > 0 || l.priceOverride));
    const rows = [];
    for (const s of sales) {
      const ls = lines.filter(l => l.saleId === s.id);
      for (const l of ls) rows.push({ at: s.clientCreatedAt, docNo: s.docNo, store: (stores.find(x => x.id === s.storeId) || {}).name || s.storeId, staff: s.cashierName, what: l.name + (l.priceOverride ? ' (price ' + (l.priceOverride.fromCents / 100).toFixed(2) + ' → ' + (l.unitPriceCents / 100).toFixed(2) + ')' : ''), pct: l.discountPct || 0, amount: l.discountCents || 0, reason: l.discountReason || (l.priceOverride && l.priceOverride.reason) || '', approvedBy: (l.discountBy && l.discountBy.name) || (l.priceOverride && l.priceOverride.by && l.priceOverride.by.name) || '' });
      if (s.saleDiscountCents) rows.push({ at: s.clientCreatedAt, docNo: s.docNo, store: (stores.find(x => x.id === s.storeId) || {}).name || s.storeId, staff: s.cashierName, what: 'Whole sale', pct: s.saleDiscountPct || 0, amount: s.saleDiscountCents, reason: s.saleDiscountReason || '', approvedBy: (s.saleDiscountBy && s.saleDiscountBy.name) || '' });
    }
    rows.sort((x, y) => x.at.localeCompare(y.at));
    return { title: 'Discounts and price overrides', columns: [col('at', 'When', 'time'), col('docNo', 'Sale'), col('store', 'Store'), col('staff', 'Staff'), col('what', 'On'), col('pct', '%', 'pct'), col('amount', 'Discount', 'cents'), col('reason', 'Reason'), col('approvedBy', 'Approved by')], rows, totals: { amount: sum(rows, 'amount') } };
  },
  async voids(w, b, stores, from, to) {
    const rows = [];
    for (const s of stores) {
      const au = (await query('auditLog', [{ field: 'entityId', value: w.entityId }, { field: 'storeId', value: s.id }, ...range('createdAt', from, to)], 5000)).filter(a => /^sale\.(void|line\.void)$/.test(a.action) && (!b.staffUid || a.actorUid === b.staffUid));
      for (const a of au) rows.push({ at: a.createdAt, store: s.name, staff: a.actorName, kind: a.action === 'sale.void' ? 'Whole sale' : 'Line', what: a.action === 'sale.void' ? (a.details.lines || []).map(l => l.qty + ' × ' + l.name).join(', ') : (a.details.qty + ' × ' + a.details.name), amount: a.action === 'sale.void' ? a.details.totalCents || 0 : (a.details.qty || 0) * (a.details.unitPriceCents || 0), reason: (a.details || {}).reason || '' });
    }
    rows.sort((x, y) => x.at.localeCompare(y.at));
    return { title: 'Voids (before completion)', columns: [col('at', 'When', 'time'), col('store', 'Store'), col('staff', 'Staff'), col('kind', 'Kind'), col('what', 'What'), col('amount', 'Value', 'cents'), col('reason', 'Reason')], rows, totals: { amount: sum(rows, 'amount') } };
  },
  async refunds(w, b, stores, from, to) {
    const notes = (await perStore('creditNotes', w.entityId, stores, 'clientCreatedAt', from, to)).filter(n => !b.staffUid || n.cashierUid === b.staffUid);
    const rows = notes.map(n => ({ at: n.clientCreatedAt, docNo: n.docNo, store: (stores.find(x => x.id === n.storeId) || {}).name || n.storeId, against: n.saleDocNo || (n.noReceipt ? 'no receipt' : ''), customer: (n.customerSnapshot || {}).name || '', staff: n.cashierName, reasons: n.reasonSummary || '', dispositions: [...new Set((n.lines || []).map(l => l.disposition))].join(', '), total: n.totalCents, vat: n.vatCents, methods: (n.refunds || []).map(r => r.method + ' ' + (r.amountCents / 100).toFixed(2)).join(', ') + (n.exchangeUsedCents ? ' exchange ' + (n.exchangeUsedCents / 100).toFixed(2) : ''), approvedBy: (n.approvers || []).map(a => a.name).join(', ') })).sort((x, y) => x.at.localeCompare(y.at));
    return { title: 'Refunds and credit notes', columns: [col('at', 'When', 'time'), col('docNo', 'Credit note'), col('store', 'Store'), col('against', 'Against'), col('customer', 'Customer'), col('staff', 'Staff'), col('reasons', 'Reasons'), col('dispositions', 'Goods'), col('total', 'Credit', 'cents'), col('vat', 'VAT reversed', 'cents'), col('methods', 'Refunded by'), col('approvedBy', 'Approved by')], rows, totals: { total: sum(rows, 'total'), vat: sum(rows, 'vat') } };
  },
  async _items(w, stores) {
    const [products, variants] = await Promise.all([query('products', [{ field: 'entityId', value: w.entityId }], 5000), query('variants', [{ field: 'entityId', value: w.entityId }], 10000)]);
    const out = [];
    for (const s of stores) {
      const levels = new Map((await query('stockLevels', [{ field: 'entityId', value: w.entityId }, { field: 'storeId', value: s.id }], 10000)).map(l => [l.id, l]));
      for (const p of products) {
        if (p.type !== 'stock' || p.trackStock === false || p.archived) continue;
        for (const v of p.hasVariants ? variants.filter(x => x.productId === p.id && !x.archived) : [null]) {
          const itemId = v ? v.id : p.id; const lv = levels.get(s.id + '_' + itemId) || {};
          const cost = lv.avgCostCents > 0 ? lv.avgCostCents : (v && v.costCents != null ? v.costCents : p.costCents) || 0;
          out.push({ store: s.name, storeId: s.id, itemId, productId: p.id, name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', category: p.category || '', brand: p.brand || '', onHand: lv.onHandQty || 0, reserved: lv.reservedQty || 0, available: (lv.onHandQty || 0) - (lv.reservedQty || 0), onOrder: lv.onOrderQty || 0, quarantine: lv.quarantineQty || 0, cost, value: (lv.onHandQty || 0) * cost, retail: (lv.onHandQty || 0) * ((v && v.priceCents != null ? v.priceCents : p.priceCents) || 0), reorderLevel: p.reorderLevel, reorderQty: p.reorderQty, lastMovementAt: lv.lastMovementAt || '', lastCountedAt: lv.lastCountedAt || '' });
        }
      }
    }
    return out;
  },
  async stockValue(w, b, stores) {
    const items = (await reports._items(w, stores)).filter(x => x.onHand !== 0);
    const rows = [];
    for (const [k, g] of groupBy(items, x => x.store + '|' + (x.category || '(no category)'))) { const [store, category] = k.split('|'); rows.push({ store, category, items: g.length, units: sum(g, 'onHand'), value: sum(g, 'value'), retail: sum(g, 'retail') }); }
    rows.sort((x, y) => x.store.localeCompare(y.store) || y.value - x.value);
    return { title: 'Stock value at cost', columns: [col('store', 'Store'), col('category', 'Category'), col('items', 'Items', 'int'), col('units', 'Units', 'int'), col('value', 'Value at cost', 'cents'), col('retail', 'Value at retail incl.', 'cents')], rows, totals: { items: sum(rows, 'items'), units: sum(rows, 'units'), value: sum(rows, 'value'), retail: sum(rows, 'retail') }, detail: items.map(x => ({ store: x.store, name: x.name, sku: x.sku, category: x.category, onHand: x.onHand, cost: x.cost, value: x.value })) };
  },
  async lowStock(w, b, stores) {
    const rows = (await reports._items(w, stores)).filter(x => x.reorderLevel != null && x.available + x.onOrder <= x.reorderLevel).map(x => ({ store: x.store, name: x.name, sku: x.sku, category: x.category, onHand: x.onHand, reserved: x.reserved, available: x.available, onOrder: x.onOrder, reorderLevel: x.reorderLevel, suggest: Math.max(1, x.reorderQty || (x.reorderLevel - x.available - x.onOrder + 1)) }));
    return { title: 'Low stock', columns: [col('store', 'Store'), col('name', 'Item'), col('sku', 'SKU'), col('category', 'Category'), col('onHand', 'On hand', 'int'), col('reserved', 'Reserved', 'int'), col('available', 'Available', 'int'), col('onOrder', 'On order', 'int'), col('reorderLevel', 'Reorder at', 'int'), col('suggest', 'Order', 'int')], rows, totals: { suggest: sum(rows, 'suggest') } };
  },
  async movements(w, b, stores, from, to) {
    const rows = (await perStore('stockMovements', w.entityId, stores, 'createdAt', from, to, 20000)).map(m => ({ at: m.createdAt, store: (stores.find(x => x.id === m.storeId) || {}).name || m.storeId, item: m.note && m.reason !== 'adjust' && m.reason !== 'count' ? m.note : m.productId, reason: m.reason + (m.code ? ' · ' + m.code : ''), bucket: m.bucket || 'onHand', qty: m.qty, after: m.onHandAfter, cost: m.unitCostCents || 0, value: (m.unitCostCents || 0) * m.qty, doc: m.docNo || '', by: m.byName || m.createdBy || '', note: m.reason === 'adjust' || m.reason === 'count' ? m.note || '' : '' })).sort((x, y) => x.at.localeCompare(y.at));
    return { title: 'Stock movements', columns: [col('at', 'When', 'time'), col('store', 'Store'), col('item', 'Item'), col('reason', 'Reason'), col('bucket', 'Bucket'), col('qty', 'Qty', 'int'), col('after', 'On hand after', 'int'), col('cost', 'Unit cost', 'cents'), col('value', 'Value', 'cents'), col('doc', 'Document'), col('by', 'By'), col('note', 'Note')], rows, totals: { qty: sum(rows, 'qty'), value: sum(rows, 'value') } };
  },
  async deadStock(w, b, stores) {
    const days = Math.max(7, Math.min(730, Number(b.days) || 90));
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
    const sold = new Set((await perStore('saleLines', w.entityId, stores, 'createdAt', since, today, 20000)).map(l => l.storeId + '_' + (l.itemId || l.productId)));
    const rows = (await reports._items(w, stores)).filter(x => x.onHand > 0 && !sold.has(x.storeId + '_' + x.itemId)).map(x => ({ store: x.store, name: x.name, sku: x.sku, category: x.category, onHand: x.onHand, value: x.value, retail: x.retail, lastMovementAt: x.lastMovementAt })).sort((x, y) => y.value - x.value);
    return { title: `Dead stock: no sale in ${days} days`, columns: [col('store', 'Store'), col('name', 'Item'), col('sku', 'SKU'), col('category', 'Category'), col('onHand', 'On hand', 'int'), col('value', 'Value at cost', 'cents'), col('retail', 'At retail', 'cents'), col('lastMovementAt', 'Last movement', 'date')], rows, totals: { onHand: sum(rows, 'onHand'), value: sum(rows, 'value'), retail: sum(rows, 'retail') } };
  },
  async laybys(w, b, stores, from, to) {
    const day = new Date().toISOString().slice(0, 10);
    const all = (await perStore('laybys', w.entityId, stores, 'openedAt', from, to, 5000)).map(l => ({ docNo: l.docNo, store: (stores.find(x => x.id === l.storeId) || {}).name || l.storeId, customer: (l.customerSnapshot || {}).name || '', opened: l.openedAt, due: l.dueAt, total: l.totalCents, paid: l.paidCents, balance: l.balanceCents, status: l.status !== 'open' ? l.status : l.balanceCents <= 0 ? 'ready' : l.dueAt < day ? 'overdue' : l.paidCents < expectedBy(l, day) ? 'behind' : 'on track', penalty: l.penaltyCents || 0, refunded: l.refundedCents || 0 })).sort((x, y) => x.opened.localeCompare(y.opened));
    return { title: 'Lay-bys', columns: [col('docNo', 'No'), col('store', 'Store'), col('customer', 'Customer'), col('opened', 'Opened', 'date'), col('due', 'Due', 'date'), col('total', 'Price', 'cents'), col('paid', 'Paid', 'cents'), col('balance', 'Balance', 'cents'), col('status', 'State'), col('penalty', 'Penalty', 'cents'), col('refunded', 'Refunded', 'cents')], rows: all, totals: { total: sum(all, 'total'), paid: sum(all, 'paid'), balance: sum(all.filter(x => /open|ready|overdue|behind|on track/.test(x.status)), 'balance'), penalty: sum(all, 'penalty'), refunded: sum(all, 'refunded') } };
  },
  async specialOrders(w, b, stores, from, to) {
    const rows = (await perStore('specialOrders', w.entityId, stores, 'openedAt', from, to, 5000)).map(o => ({ docNo: o.docNo, store: (stores.find(x => x.id === o.storeId) || {}).name || o.storeId, customer: (o.customerSnapshot || {}).name || '', what: (o.lines || []).map(l => l.qty + ' × ' + l.name).join(', '), opened: o.openedAt, expected: o.expectedAt, status: o.status, total: o.totalCents, paid: o.paidCents, balance: o.balanceCents, factoryRef: o.factoryRef || '' })).sort((x, y) => x.opened.localeCompare(y.opened));
    return { title: 'Custom orders', columns: [col('docNo', 'No'), col('store', 'Store'), col('customer', 'Customer'), col('what', 'What'), col('opened', 'Opened', 'date'), col('expected', 'Expected', 'date'), col('status', 'Status'), col('total', 'Price', 'cents'), col('paid', 'Paid', 'cents'), col('balance', 'Balance', 'cents'), col('factoryRef', 'Factory ref')], rows, totals: { total: sum(rows, 'total'), paid: sum(rows, 'paid'), balance: sum(rows.filter(r => !/delivered|collected|cancelled/.test(r.status)), 'balance') } };
  },
  // every rand that moved on sales orders: who took it, how, and whether the bank has confirmed it
  async orderPayments(w, b, stores, from, to) {
    const pays = (await perStore('payments', w.entityId, stores, 'createdAt', from, to)).filter(p => p.docType === 'specialOrder' || (p.docType === 'refund' && p.docNo && /-SO-/.test(p.docNo)));
    const users = new Map(), orders = new Map();
    const userName = async (uid) => { if (!users.has(uid)) users.set(uid, ((await getDoc('users', uid)) || {}).name || uid); return users.get(uid); };
    const orderOf = async (id) => { if (!orders.has(id)) orders.set(id, await getDoc('specialOrders', id)); return orders.get(id) || {}; };
    const rows = [];
    for (const p of pays.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))) {
      const o = await orderOf(p.docId);
      const refund = p.docType === 'refund';
      rows.push({ at: p.createdAt, docNo: p.docNo, customer: (o.customerSnapshot || {}).name || '', store: (stores.find(s => s.id === p.storeId) || {}).name || p.storeId, staff: await userName(p.createdBy), method: p.method, amount: p.amountCents, state: refund ? 'refund' : p.status === 'awaiting' ? 'awaiting the bank' : p.status === 'void' ? 'not received' : p.confirmedAt ? 'confirmed' : 'paid', ref: p.ref || p.bankRef || '', confirmedBy: p.confirmedByName || p.voidedByName || '', register: p.registerId || 'office', orderStatus: o.status || '', balance: o.balanceCents || 0 });
    }
    const counted = rows.filter(r => r.state === 'paid' || r.state === 'confirmed' || r.state === 'refund');
    return { title: 'Order payments', columns: [col('at', 'When', 'time'), col('docNo', 'Order'), col('customer', 'Customer'), col('store', 'Store'), col('register', 'Register'), col('staff', 'Taken by'), col('method', 'Method'), col('amount', 'Amount', 'cents'), col('state', 'State'), col('ref', 'Reference'), col('confirmedBy', 'Confirmed by'), col('orderStatus', 'Order now'), col('balance', 'Still owed', 'cents')], rows, totals: { amount: sum(counted, 'amount') } };
  },
  async customers(w, b, stores, from, to) {
    const cs = (await query('customers', [{ field: 'entityId', value: w.entityId }], 10000)).filter(c => !c.mergedInto);
    const rows = cs.map(c => ({ name: c.anonymised ? 'Anonymised' : c.name, phone: c.phone || '', since: dayOf(c.createdAt), isNew: dayOf(c.createdAt) >= from && dayOf(c.createdAt) <= to ? 'yes' : '', sales: (c.stats || {}).salesCount || 0, spent: (c.stats || {}).spentCents || 0, last: (c.stats || {}).lastSaleAt || '', credit: c.storeCreditCents || 0, owes: c.accountBalanceCents || 0, points: (c.loyalty || {}).points || 0, tier: (c.loyalty || {}).tier || '', consent: ['whatsapp', 'sms', 'email'].filter(k => c.consent && c.consent[k] && c.consent[k].granted).join(' ') })).sort((x, y) => y.spent - x.spent);
    return { title: 'Customers', columns: [col('name', 'Customer'), col('phone', 'Cell'), col('since', 'Since', 'date'), col('isNew', 'New in range'), col('sales', 'Sales', 'int'), col('spent', 'Spent', 'cents'), col('last', 'Last sale', 'date'), col('credit', 'Store credit', 'cents'), col('owes', 'Owes', 'cents'), col('points', 'Points', 'int'), col('tier', 'Tier'), col('consent', 'Consent')], rows, totals: { sales: sum(rows, 'sales'), spent: sum(rows, 'spent'), credit: sum(rows, 'credit'), owes: sum(rows, 'owes'), points: sum(rows, 'points'), newCount: rows.filter(r => r.isNew).length } };
  }
};

const actions = {
  async run(event, b) {
    const w = await who(event, b);
    if (!w.entityId) throw new Reject(400, 'Which company?');
    const fn = reports[clean(b.report, 30)];
    if (!fn || String(b.report).startsWith('_')) throw new Reject(400, 'Which report?');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(b.from || '') ? b.from : new Date().toISOString().slice(0, 10);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(b.to || '') ? b.to : from;
    if (to < from) throw new Reject(400, 'The range ends before it starts.');
    if (Date.parse(to) - Date.parse(from) > 370 * 86400000) throw new Reject(400, 'A year at a time, at most.');
    const stores = await storesOf(w, w.entityId);
    if (!stores.length) throw new Reject(400, 'No store to report on.');
    const out = await fn(w, b, stores, from, to);
    return { ok: true, report: b.report, from, to, entityId: w.entityId, storeId: w.storeId, at: new Date().toISOString(), ...out };
  },
  // today against the same weekday last week, per store
  async dashboard(event, b) {
    const w = await who(event, b);
    const ents = w.entityId ? [await getDoc('entities', w.entityId)].filter(Boolean).map(e => ({ ...e, id: w.entityId })) : (await query('entities', [], 50)).filter(e => e.active !== false && inEntity(w.user, e.id));
    const today = b.day && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
    const lastWeek = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
    const stores = [];
    for (const e of ents) {
      for (const s of await storesOf({ ...w, storeId: '' }, e.id)) {
        const [t, l, n, ln, lb] = await Promise.all([query('sales', [{ field: 'entityId', value: e.id }, { field: 'storeId', value: s.id }, ...range('clientCreatedAt', today, today)], 5000), query('sales', [{ field: 'entityId', value: e.id }, { field: 'storeId', value: s.id }, ...range('clientCreatedAt', lastWeek, lastWeek)], 5000), query('creditNotes', [{ field: 'entityId', value: e.id }, { field: 'storeId', value: s.id }, ...range('clientCreatedAt', today, today)], 500), query('creditNotes', [{ field: 'entityId', value: e.id }, { field: 'storeId', value: s.id }, ...range('clientCreatedAt', lastWeek, lastWeek)], 500), query('laybys', [{ field: 'entityId', value: e.id }, { field: 'storeId', value: s.id }, { field: 'status', value: 'open' }], 2000)]);
        const pick = (g, ns) => ({ sales: g.length, total: sum(g, 'totalCents'), basket: g.length ? Math.round(sum(g, 'totalCents') / g.length) : 0, items: sum(g, 'lineCount'), refunds: sum(ns, 'totalCents'), net: sum(g, 'totalCents') - sum(ns, 'totalCents') });
        stores.push({ entityId: e.id, entity: e.tradingName || e.legalName, storeId: s.id, store: s.name, today: pick(t, n), lastWeek: pick(l, ln), openLaybys: lb.length, laybyBalance: sum(lb, 'balanceCents') });
      }
    }
    const all = (k) => ({ sales: sum(stores, s => s[k].sales), total: sum(stores, s => s[k].total), refunds: sum(stores, s => s[k].refunds), net: sum(stores, s => s[k].net), basket: sum(stores, s => s[k].sales) ? Math.round(sum(stores, s => s[k].total) / sum(stores, s => s[k].sales)) : 0 });
    return { ok: true, day: today, lastWeek, stores, all: { today: all('today'), lastWeek: all('lastWeek') } };
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
    console.error('pos-report failed:', e);
    return json(500, { error: 'Something went wrong on the server.' });
  }
};

// every request works in its own customer's space (lib/pos.mjs)
export const handler = withGroup(handleRequest);
