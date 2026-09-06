// Live production + costing report at a private link, so an AI assistant (or
// anyone with the link) can scan the current open orders and their costs
// without logging in. The app page itself can't be scanned that way — it needs
// JavaScript + a signed-in user — so this serves the same live Firestore data
// as plain text (default) or JSON (?format=json).
//
//   GET /claude-report?k=<key>              → plain-text costing report
//   GET /claude-report?k=<key>&format=json  → the same report as JSON
//
// The key is the only credential (like client-doc links). It is NOT stored in
// the repo: set CLAUDE_REPORT_KEY in the Netlify site's environment variables
// (Site configuration → Environment variables), then the link is
// /claude-report?k=<that value>. Until it is set, the endpoint refuses with
// setup instructions. Client names and phone numbers are NOT included —
// orders are identified by invoice number only.
//
// Costing mirrors the app's Costing tab exactly:
//   unit cost = BOM materials + cut list + labour per piece + overhead per unit
//   overhead per unit = total monthly overheads ÷ planned units per month
import { readDoc } from './lib/firestore.mjs';

const BIZ = [
  ['bellville', 'Bellville Furniture'],
  ['pinkfoot', 'PinkFoot Boutique'],
  ['repticube', 'ReptiCube']
];

const resp = (status, body, type) => ({
  statusCode: status,
  headers: { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  body
});

// ---- BOM matching, same chain as the app's _wpFindBom (Week Plan) ----
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function findBom(biz, productName) {
  const boms = biz.productBoms || {};
  if (!productName) return null;
  if (boms[productName]) return { key: productName, prod: boms[productName] };
  const keys = Object.keys(boms);
  let k = keys.find(x => x.toLowerCase() === String(productName).toLowerCase());
  if (k) return { key: k, prod: boms[k] };
  const alias = (biz.bomAliases || {})[norm(productName)];
  if (alias && boms[alias]) return { key: alias, prod: boms[alias] };
  const target = norm(productName);
  k = keys.find(x => norm(x) === target);
  if (k) return { key: k, prod: boms[k] };
  const targetWords = new Set(target.split(' ').filter(Boolean));
  let best = null, bestCount = 0;
  keys.forEach(x => {
    const w = norm(x).split(' ').filter(Boolean);
    if (w.length >= 2 && w.every(t => targetWords.has(t)) && w.length > bestCount) { best = x; bestCount = w.length; }
  });
  return best ? { key: best, prod: boms[best] } : null;
}

// ---- Per-unit material cost: BOM materials map + cut list (mirrors the app) ----
function materialsCost(prod, biz) {
  if (!prod) return 0;
  const lib = biz.materialsLibrary || [];
  const byId = {}, byName = {};
  lib.forEach(m => { if (m && m.id) byId[m.id] = m; if (m && m.name) byName[m.name] = m; });
  let s = 0;
  Object.entries(prod.materials || {}).forEach(([id, qty]) => {
    const m = byId[id];
    if (m) s += (parseFloat(qty || 0) * parseFloat(m.cost || 0));
  });
  const DEFAULT_SHEET_AREA_M2 = (2440 * 1220) / 1000000;
  (prod.cutList || []).forEach(c => {
    const mat = byName[c.timber];
    if (!mat) return;
    const cost = parseFloat(mat.cost || 0);
    const len = parseFloat(c.lengthMm || 0);
    const wid = parseFloat(c.widthMm || 0);
    const qty = parseFloat(c.qty || 0);
    if (mat.unit === 'Sheet' && wid > 0) {
      const sheetArea = parseFloat(mat.sheetAreaM2 || DEFAULT_SHEET_AREA_M2);
      s += ((len * wid * qty) / 1000000 / sheetArea) * cost;
    } else {
      s += (len * qty / 1000) * cost;
    }
  });
  return s;
}

export function bizReport(bizData, label) {
  const costing = bizData.costing || {};
  const overheads = Array.isArray(costing.overheads) ? costing.overheads : [];
  const totalOverhead = overheads.reduce((s, o) => s + (parseFloat(o.monthly) || 0), 0);
  const unitsPerMonth = parseFloat(costing.unitsPerMonth) || 0;
  const ohPerUnit = unitsPerMonth > 0 ? totalOverhead / unitsPerMonth : 0;
  const rate = parseFloat(costing.labourRate) || 0;

  const open = (bizData.orders || []).filter(o => o && o.status !== 'delivered' && o.status !== 'done');
  const orders = open.map(o => {
    const qty = parseInt(o.qty) || 1;
    const found = findBom(bizData, o.product);
    const prod = found && found.prod;
    const hasBom = !!(prod && ((prod.materials && Object.keys(prod.materials).length) || (prod.cutList && prod.cutList.length)));
    const mat = prod ? materialsCost(prod, bizData) : 0;
    const directLabour = prod ? parseFloat(prod.labourCost) : NaN;
    const labour = !isNaN(directLabour) ? directLabour : (prod ? (parseFloat(prod.labourHours) || 0) * rate : 0);
    const unitCost = mat + labour + ohPerUnit;
    const sell = prod ? (parseFloat(prod.sellingPrice) || 0) : 0;
    const row = {
      invoice: o.invoice || o.id || '',
      product: o.product || '',
      qty,
      status: o.status || '',
      orderDate: o.orderDate || '',
      dueDate: o.dueDate || '',
      planWeek: o.planWeek || '',
      fabric: o.fabric || '',
      fabricStatus: o.fabricStatus || '',
      outsourcedTo: o.builder || '',
      bomMatched: found ? found.key : null,
      materialPerUnit: +mat.toFixed(2),
      labourPerUnit: +labour.toFixed(2),
      overheadPerUnit: +ohPerUnit.toFixed(2),
      costPerUnit: +unitCost.toFixed(2),
      costTotal: +(unitCost * qty).toFixed(2),
      sellingPerUnit: sell || null,
      profitPerUnit: sell ? +(sell - unitCost).toFixed(2) : null,
      warnings: []
    };
    if (o.builder) row.warnings.push('outsourced to ' + o.builder + ' — materials & labour are the partner’s, in-house cost columns do not apply');
    if (!o.builder && !hasBom) row.warnings.push('no BOM match — material cost unknown');
    if (!o.builder && prod && isNaN(directLabour) && !(parseFloat(prod.labourHours) > 0)) row.warnings.push('no labour cost set');
    if (prod && !sell) row.warnings.push('no selling price set');
    return row;
  });

  const inHouse = orders.filter(o => !o.outsourcedTo);
  const sum = (arr, f) => arr.reduce((s, o) => s + f(o), 0);
  return {
    business: label,
    costingBasis: {
      totalOverheadMonthly: +totalOverhead.toFixed(2),
      plannedUnitsPerMonth: unitsPerMonth,
      overheadPerUnit: +ohPerUnit.toFixed(2),
      labourRatePerHour: rate
    },
    openOrders: orders,
    totals: {
      openOrderCount: orders.length,
      openPieces: sum(orders, o => o.qty),
      outsourcedOrders: orders.length - inHouse.length,
      inHouse: {
        materialCost: +sum(inHouse, o => o.materialPerUnit * o.qty).toFixed(2),
        labourCost: +sum(inHouse, o => o.labourPerUnit * o.qty).toFixed(2),
        overheadShare: +sum(inHouse, o => o.overheadPerUnit * o.qty).toFixed(2),
        totalCost: +sum(inHouse, o => o.costTotal).toFixed(2),
        knownRevenue: +sum(inHouse, o => (o.sellingPerUnit || 0) * o.qty).toFixed(2)
      }
    }
  };
}

// ---- plain-text rendering ----
const R = n => 'R' + (Math.round(n * 100) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, w) => String(s == null ? '' : s).slice(0, w).padEnd(w);
const padL = (s, w) => String(s == null ? '' : s).slice(0, w).padStart(w);

export function textReport(report) {
  const L = [];
  L.push('BELLVILLE PRODUCTION — LIVE ORDER COSTING REPORT');
  L.push('Generated: ' + report.generatedAt);
  L.push('Unit cost = BOM materials + cut list + labour per piece + overhead per unit');
  L.push('(overhead per unit = monthly overheads ÷ planned units/month).');
  L.push('Outsourced orders (Builder column) are built by a partner: their material/labour costs are the partner’s, not ours.');
  L.push('');
  report.businesses.forEach(b => {
    L.push('='.repeat(120));
    L.push(b.business.toUpperCase() + '  —  overheads ' + R(b.costingBasis.totalOverheadMonthly) + '/mo ÷ ' +
      b.costingBasis.plannedUnitsPerMonth + ' units = ' + R(b.costingBasis.overheadPerUnit) + '/unit');
    L.push('='.repeat(120));
    if (!b.openOrders.length) { L.push('No open orders.'); L.push(''); return; }
    L.push(pad('Invoice', 12) + pad('Product', 30) + padL('Qty', 4) + '  ' + pad('Status', 12) + pad('Due', 12) +
      pad('Builder', 14) + padL('Mat/u', 10) + padL('Lab/u', 10) + padL('OH/u', 9) + padL('Cost/u', 11) + padL('Cost tot', 12) + padL('Sell/u', 10));
    L.push('-'.repeat(146));
    b.openOrders.forEach(o => {
      L.push(pad(o.invoice, 12) + pad(o.product, 30) + padL(o.qty, 4) + '  ' + pad(o.status, 12) + pad(o.dueDate, 12) +
        pad(o.outsourcedTo || '', 14) + padL(o.materialPerUnit.toFixed(2), 10) + padL(o.labourPerUnit.toFixed(2), 10) +
        padL(o.overheadPerUnit.toFixed(2), 9) + padL(o.costPerUnit.toFixed(2), 11) + padL(o.costTotal.toFixed(2), 12) +
        padL(o.sellingPerUnit != null ? o.sellingPerUnit.toFixed(2) : '—', 10));
      o.warnings.forEach(w => L.push('            ⚠ ' + w));
    });
    const t = b.totals;
    L.push('-'.repeat(146));
    L.push('Open orders: ' + t.openOrderCount + ' (' + t.openPieces + ' pieces, ' + t.outsourcedOrders + ' outsourced)');
    L.push('In-house totals: materials ' + R(t.inHouse.materialCost) + ' + labour ' + R(t.inHouse.labourCost) +
      ' + overhead share ' + R(t.inHouse.overheadShare) + ' = ' + R(t.inHouse.totalCost) +
      '   |   known revenue ' + R(t.inHouse.knownRevenue));
    L.push('');
  });
  return L.join('\n');
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const key = process.env.CLAUDE_REPORT_KEY;
  if (!key) return resp(503, 'Not configured: set the CLAUDE_REPORT_KEY environment variable in Netlify (Site configuration → Environment variables), redeploy, then open /claude-report?k=<that value>.');
  if ((q.k || '') !== key) return resp(403, 'Forbidden: missing or wrong key (?k=...)');

  let data;
  try {
    data = await readDoc('production');
  } catch (e) {
    return resp(500, 'Could not read live data: ' + e.message);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    businesses: BIZ.filter(([k]) => data[k]).map(([k, label]) => bizReport(data[k], label))
  };

  if ((q.format || '') === 'json') return resp(200, JSON.stringify(report, null, 2), 'application/json');
  return resp(200, textReport(report));
};
