// Retail POS — a sale becomes real here (pos/DATA-MODEL.md, "How a sale is written").
//
// POST { action: 'commit', ... } with the cashier's Firebase ID token as a
// Bearer header and, from a till, its deviceId and secret. The server prices
// every line itself, checks discounts and overrides, recomputes totals and
// VAT, checks the tenders, takes the next document number from the till's
// block, and writes the sale, lines, payments, stock movements and levels,
// customer credit or balance, vouchers, the block and an audit row in one
// transaction. The same saleId sent twice is written once.
//
//   commit   { saleId, entityId, storeId, registerId, deviceId?, secret?, clientCreatedAt, seq?,
//              customerId, lines [ { productId, variantId, qty, unitPriceCents, priceOverride?, discountCents, discountPct, discountReason, discountToken?, note, custom?, name?, vatClass? } ],
//              saleDiscountCents, saleDiscountPct, saleDiscountReason, saleDiscountToken?, note,
//              totals { totalCents, vatCents },   the till's own sums, which must agree
//              tenders [ { method, amountCents, tenderedCents?, ref?, cardLast4?, approvalCode?, status?, voucherCode? } ] }
//   blocks   { deviceId, secret } | (login) → the till's open number blocks, issuing one per series when it has none
//   voucher  { code, entityId } → { balanceCents, status }
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import {
  json, Reject, clean, randomId, nowIso, rank,
  getDoc, query, commit, beginTransaction, rollback, serverStamp,
  loginOf, loadUser, inEntity, inStore, verifyOverrideToken, loadDevice, bodyOf
} from './lib/pos.mjs';
import { vatIn, rateOn, rateFor, lineTotals, roundTo10c } from '../../pos/js/money.js';

const METHODS = ['cash', 'card', 'eft', 'qr', 'voucher', 'storeCredit', 'account'];
const BLOCK_SIZE_DEFAULT = 50;
const int = (v) => Number.isInteger(v) ? v : (Number.isInteger(Number(v)) ? Number(v) : NaN);
const pad6 = (n) => String(n).padStart(6, '0');
const blockId = (entityId, series, deviceId, from) => `${entityId}_${series}_${deviceId}_${from}`;

// who and where: the cashier (by token) and the till (by secret); an office login sells as 'web:<uid>'
async function whoAndWhere(event, b) {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const user = await loadUser(login.sub);
  if (!user) throw new Reject(403, 'This login is not on the staff list.');
  const device = b.deviceId ? await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120)) : null;
  if (b.deviceId && !device) throw new Reject(403, 'This till is not enrolled.');
  const storeId = device ? device.storeId : clean(b.storeId, 40);
  const entityId = device ? device.entityId : clean(b.entityId, 40);
  if (!inEntity(user, entityId) || !inStore(user, storeId)) throw new Reject(403, 'Not your store.');
  const [entity, store, settings] = await Promise.all([getDoc('entities', entityId), getDoc('stores', storeId), getDoc('settings', entityId)]);
  if (!entity || entity.active === false || !store || store.active === false || store.entityId !== entityId) throw new Reject(400, 'That store is not set up.');
  const registerId = device && device.registerId ? device.registerId : clean(b.registerId, 40);
  // a register sells only while its shift is open; the office (no register) has no shift
  let shiftId = '';
  if (registerId) {
    const reg = await getDoc('registers', registerId);
    if (!reg || reg.storeId !== storeId) throw new Reject(400, 'That register is not in this store.');
    const sh = reg.currentShiftId ? await getDoc('shifts', reg.currentShiftId) : null;
    if (!sh || sh.status !== 'open') throw new Reject(409, 'The register is closed: open it under Register first.');
    shiftId = sh.id;
  }
  return { user, device, deviceId: device ? device.id : 'web:' + login.sub, entityId, storeId, registerId, shiftId, entity, store, settings: settings || {} };
}

// the till's open block for a series, issuing one inside the transaction when it has none
async function openBlock(tx, ctx, series, size) {
  const rows = await query('numberBlocks', [{ field: 'entityId', value: ctx.entityId }, { field: 'series', value: series }, { field: 'deviceId', value: ctx.deviceId }, { field: 'closedAt', value: '' }], 5);
  const live = rows.find(r => (r.usedUpTo || r.from - 1) < r.to);
  if (live) return { block: await getDoc('numberBlocks', live.id, tx), fresh: false };
  const key = ctx.entityId + '_' + series;
  const counter = await getDoc('counters', key, tx);
  const from = counter ? counter.next : 1, to = from + size - 1;
  const block = { id: blockId(ctx.entityId, series, ctx.deviceId, from), series, deviceId: ctx.deviceId, registerId: ctx.registerId || '', from, to, usedUpTo: from - 1, issuedAt: nowIso(), closedAt: '', ...serverStamp(ctx.entityId, ctx.storeId, 'server', ctx.deviceId) };
  return { block, fresh: true, counterNext: to + 1, counterExisted: !!counter };
}

async function priceOf(ctx, p, v) {
  if (v) { if (v.storePrices && v.storePrices[ctx.storeId] != null) return v.storePrices[ctx.storeId]; if (v.priceCents != null) return v.priceCents; }
  if (p.storePrices && p.storePrices[ctx.storeId] != null) return p.storePrices[ctx.storeId];
  return p.priceCents || 0;
}
const limitOf = (settings, role) => { const m = (settings.discounts || {}).maxPctByRole || {}; const v = m[role]; return v == null ? ({ cashier: 5, supervisor: 15, manager: 50, owner: 100 })[role] || 0 : Number(v); };
// a discount: within the cashier's limit, or carrying an approval token from pos-auth whose approver may give that much
function discountOk(ctx, pct, token, what) {
  if (pct <= limitOf(ctx.settings, ctx.user.role)) return { by: null };
  const t = verifyOverrideToken(token);
  if (!t || t.action !== 'override.discount' || t.entityId !== ctx.entityId) throw new Reject(403, `${pct}% off ${what} is over your limit and has no manager's approval.`);
  if (pct > limitOf(ctx.settings, t.role)) throw new Reject(403, `${pct}% off ${what}: the approver (${t.role}) may not give that much.`);
  return { by: { uid: t.overrideUid, name: t.overrideName } };
}

const actions = {
  async commit(event, b) {
    const ctx = await whoAndWhere(event, b);
    const saleId = clean(b.saleId, 80);
    if (!/^[\w:.-]{8,80}$/.test(saleId)) throw new Reject(400, 'The sale has no id.');
    // the same sale again (a resend after a dropped line): the first answer stands
    const had = await getDoc('sales', saleId);
    if (had) return { ok: true, sale: had, again: true, lines: await query('saleLines', [{ field: 'saleId', value: saleId }], 500, { field: 'lineNo' }) };
    const when = clean(b.clientCreatedAt, 40);
    const at = Date.parse(when);
    if (!at || at > Date.now() + 5 * 60000 || at < Date.now() - 7 * 86400000) throw new Reject(400, 'The sale’s time is off: check the till’s clock.');
    const rateBp = ctx.entity.vatRegistered ? rateOn((ctx.settings.vat || {}).rates, when) : 0;
    if (ctx.entity.vatRegistered && !rateBp) throw new Reject(400, 'No VAT rate is in force for that date: Admin → Settings → VAT.');
    const inLines = Array.isArray(b.lines) ? b.lines : [];
    if (!inLines.length || inLines.length > 200) throw new Reject(400, 'The sale has no lines.');
    const customer = b.customerId ? await getDoc('customers', clean(b.customerId, 60)) : null;
    if (b.customerId && (!customer || customer.entityId !== ctx.entityId)) throw new Reject(400, 'That customer is not known here.');

    // ---- the lines, priced by the server
    const lines = [], moves = [], vouchersSold = [];
    let n = 0, gross = 0, lineDisc = 0, sub = 0;
    const approvers = new Map();
    for (const l of inLines) {
      n++;
      const qty = int(l.qty);
      if (!qty || qty < 1 || qty > 1000) throw new Reject(400, `Line ${n}: the quantity is wrong.`);
      let p = null, v = null, listPrice, name, vatClass, type, trackStock, costCents, itemId = '';
      if (l.custom) {
        listPrice = int(l.unitPriceCents); name = clean(l.name, 120); vatClass = ['standard', 'zero', 'exempt'].includes(l.vatClass) ? l.vatClass : 'standard'; type = 'nonstock'; trackStock = false; costCents = 0;
        if (!name || !(listPrice >= 0)) throw new Reject(400, `Line ${n}: a custom item needs a name and a price.`);
        if (rank(ctx.user.role) < rank('cashier')) throw new Reject(403, 'Not allowed.');
      } else {
        p = await getDoc('products', clean(l.productId, 60));
        if (!p || p.entityId !== ctx.entityId || p.archived) throw new Reject(400, `Line ${n}: that product is not for sale here.`);
        if (l.variantId) { v = await getDoc('variants', clean(l.variantId, 60)); if (!v || v.productId !== p.id || v.archived) throw new Reject(400, `Line ${n}: that variant is not for sale.`); }
        else if (p.hasVariants) throw new Reject(400, `Line ${n}: ${p.name} needs a variant.`);
        listPrice = await priceOf(ctx, p, v); name = p.name + (v ? ' · ' + v.name : ''); vatClass = p.vatClass || 'standard'; type = p.type || 'stock';
        trackStock = p.trackStock !== false && type === 'stock'; costCents = (v && v.costCents != null ? v.costCents : p.costCents) || 0; itemId = v ? v.id : p.id;
      }
      // the price: the list price, or an override a manager approved
      let unit = int(l.unitPriceCents), override = null;
      if (!(unit >= 0)) throw new Reject(400, `Line ${n}: the price is wrong.`);
      if (unit !== listPrice) {
        const t = verifyOverrideToken(l.priceOverride && l.priceOverride.token);
        const self = rank(ctx.user.role) >= rank('manager');
        if (!self && (!t || t.action !== 'override.price' || t.entityId !== ctx.entityId)) throw new Reject(403, `Line ${n}: the price of ${name} was changed without a manager's approval.`);
        override = { fromCents: listPrice, reason: clean(l.priceOverride && l.priceOverride.reason, 120), by: self ? { uid: ctx.user.id, name: ctx.user.name } : { uid: t.overrideUid, name: t.overrideName } };
        if (!self) approvers.set(t.overrideUid, t.overrideName);
      }
      const disc = int(l.discountCents) || 0;
      if (disc < 0 || disc > qty * unit) throw new Reject(400, `Line ${n}: the discount is wrong.`);
      const pct = disc ? Math.round(disc / (qty * unit) * 1000) / 10 : 0;
      const dOk = disc ? discountOk(ctx, pct, l.discountToken, name) : { by: null };
      if (dOk.by) approvers.set(dOk.by.uid, dOk.by.name);
      const lr = rateFor(vatClass, rateBp, !!ctx.entity.vatRegistered);
      const t = lineTotals({ qty, unitPriceCents: unit, discountCents: disc, rateBp: lr });
      gross += t.grossCents; lineDisc += t.discountCents; sub += t.lineTotalCents;
      const fulfilment = type === 'mto' ? 'mto' : type === 'nonstock' || type === 'voucher' ? 'service' : 'stock';
      lines.push({ lineNo: n, productId: p ? p.id : '', variantId: v ? v.id : '', itemId, sku: (v && v.sku) || (p && p.sku) || '', name, type, fulfilment, qty, unitPriceCents: unit, listPriceCents: listPrice, priceOverride: override,
        discountCents: t.discountCents, discountPct: pct, discountReason: clean(l.discountReason, 120), discountBy: dOk.by, lineTotalCents: t.lineTotalCents, vatClass, vatRateBp: lr, costCents, trackStock, note: clean(l.note, 200), custom: !!l.custom });
      if (p && type === 'bundle') for (const c of p.bundle || []) { const cp = await getDoc('products', c.productId); if (!cp) continue; const cv = c.variantId ? await getDoc('variants', c.variantId) : null; if (cp.trackStock !== false && cp.type === 'stock') moves.push({ productId: cp.id, variantId: cv ? cv.id : '', itemId: cv ? cv.id : cp.id, qty: -(qty * (int(c.qty) || 1)), unitCostCents: (cv && cv.costCents != null ? cv.costCents : cp.costCents) || 0, reason: 'bundle', name: cp.name + (cv ? ' · ' + cv.name : '') }); }
      else if (trackStock) moves.push({ productId: p.id, variantId: v ? v.id : '', itemId, qty: -qty, unitCostCents: costCents, reason: 'sale', name });
      if (type === 'voucher') for (let k = 0; k < qty; k++) vouchersSold.push({ lineNo: n, amountCents: unit });
    }
    // ---- the sale discount, spread over the lines so each line's VAT is right
    const saleDisc = Math.min(sub, int(b.saleDiscountCents) || 0);
    if (saleDisc < 0) throw new Reject(400, 'The sale discount is wrong.');
    let saleBy = null;
    if (saleDisc) { const pct = Math.round(saleDisc / sub * 1000) / 10; saleBy = discountOk(ctx, pct, b.saleDiscountToken, 'the sale').by; if (saleBy) approvers.set(saleBy.uid, saleBy.name); }
    let left = saleDisc, vat = 0;
    lines.forEach((l, i) => { const share = i === lines.length - 1 ? left : (sub ? Math.round(saleDisc * l.lineTotalCents / sub) : 0); left -= share; l.saleDiscountCents = share; l.netCents = l.lineTotalCents - share; l.vatCents = vatIn(l.netCents, l.vatRateBp); vat += l.vatCents; });
    const total = sub - saleDisc;
    const told = b.totals || {};
    if (int(told.totalCents) !== total || int(told.vatCents) !== vat) throw new Reject(409, `The till’s total (${told.totalCents}) does not match the server’s (${total}). Reopen the sale and try again.`);
    // over R 5 000 a VAT-registered company must issue a full tax invoice: the customer's name and address go on it
    if (ctx.entity.vatRegistered && total > 500000) {
      const a = customer && customer.address;
      if (!customer || !String(customer.name || '').trim()) throw new Reject(400, 'Over R 5 000 a full tax invoice is needed: add the customer with their name and address.');
      if (!a || !String(a.line1 || a.city || '').trim()) throw new Reject(400, `Over R 5 000 a full tax invoice is needed: add ${customer.name}’s address.`);
    }

    // ---- the tenders
    const tenders = Array.isArray(b.tenders) ? b.tenders : [];
    if (!tenders.length || tenders.length > 10) throw new Reject(400, 'No payment.');
    const allowed = ctx.store.paymentMethods || ['cash', 'card'];
    let paid = 0, cashTendered = 0, cashCount = 0, creditUsed = 0, accountUsed = 0, rounding = 0;
    const voucherUse = [];
    const pays = [];
    for (const t of tenders) {
      const method = clean(t.method, 20); const amount = int(t.amountCents);
      if (!METHODS.includes(method) || !allowed.includes(method)) throw new Reject(400, `${method || 'That'} is not a payment method at this store.`);
      if (!(amount > 0)) throw new Reject(400, 'A payment must be more than nothing.');
      const pay = { method, amountCents: amount, ref: clean(t.ref, 60), status: 'paid' };
      if (method === 'cash') { cashCount++; pay.tenderedCents = int(t.tenderedCents) || amount; if (pay.tenderedCents < amount) throw new Reject(400, 'Cash given is less than the cash part.'); cashTendered += pay.tenderedCents; }
      if (method === 'card') { pay.cardLast4 = clean(t.cardLast4, 4).replace(/\D/g, ''); pay.approvalCode = clean(t.approvalCode, 20); }
      if (method === 'eft') pay.status = t.status === 'awaiting' ? 'awaiting' : 'paid';
      if (method === 'storeCredit') { if (!customer) throw new Reject(400, 'Store credit needs the customer on the sale.'); creditUsed += amount; }
      if (method === 'account') { if (!customer || !customer.accountEnabled) throw new Reject(400, 'This customer has no account.'); accountUsed += amount; }
      if (method === 'voucher') { const code = clean(t.voucherCode, 40).toUpperCase(); if (!code) throw new Reject(400, 'Which voucher?'); voucherUse.push({ code, amount, pay }); }
      paid += amount; pays.push(pay);
    }
    if (cashCount > 1) throw new Reject(400, 'One cash payment per sale: add the notes together.');
    if (creditUsed > (customer ? customer.storeCreditCents || 0 : 0)) throw new Reject(400, 'Not enough store credit.');
    if (accountUsed && accountUsed + (customer.accountBalanceCents || 0) > (customer.creditLimitCents || 0)) throw new Reject(400, 'That takes the account past its limit.');
    // cash may be rounded to 10c: the cash part due is total less the other tenders
    const others = paid - pays.filter(p => p.method === 'cash').reduce((n, p) => n + p.amountCents, 0);
    const cashPay = pays.find(p => p.method === 'cash');
    if (cashPay) {
      const due = total - others;
      if (due < 0) throw new Reject(400, 'The other payments already cover the sale: take the cash off.');
      const r = roundTo10c(due);
      if (cashPay.amountCents !== due && cashPay.amountCents !== r.roundedCents) throw new Reject(400, 'The cash part does not match what is due.');
      if (cashPay.amountCents === r.roundedCents) rounding = r.roundingCents;
      if (cashPay.tenderedCents < cashPay.amountCents) throw new Reject(400, 'Cash given is short.');
      cashPay.changeCents = cashPay.tenderedCents - cashPay.amountCents;
      paid = others + cashPay.amountCents;
    }
    if (paid !== total + rounding) throw new Reject(400, `Payments (${paid}) do not cover the sale (${total + rounding}).`);

    // ---- in one transaction: number, stock, credit, vouchers, the block
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = await beginTransaction();
      let done = false;
      try {
        const size = Math.max(10, Math.min(500, int((ctx.settings.numbering || {}).blockSize) || BLOCK_SIZE_DEFAULT));
        const { block, fresh, counterNext, counterExisted } = await openBlock(tx, ctx, 'INV', size);
        let seq = int(b.seq);
        if (seq) { if (seq < block.from || seq > block.to || seq <= block.usedUpTo) throw new Reject(409, `Number ${seq} is not free in this till’s block (${block.from}–${block.to}, used to ${block.usedUpTo}).`); }
        else seq = block.usedUpTo + 1;
        const docNo = ctx.entity.invoicePrefix + '-' + pad6(seq);
        // the vouchers paid with, read inside the transaction
        const vouchers = [];
        for (const u of voucherUse) { const vd = await getDoc('vouchers', u.code, tx); if (!vd || vd.entityId !== ctx.entityId || vd.status !== 'open' || (vd.expiresAt && vd.expiresAt < when.slice(0, 10))) throw new Reject(400, `Voucher ${u.code} is not valid here.`); if (vd.balanceCents < u.amount) throw new Reject(400, `Voucher ${u.code} has ${vd.balanceCents} cents left.`); vouchers.push({ vd, u }); }
        // stock levels, read inside the transaction
        const levels = new Map();
        for (const m of moves) { const id = ctx.storeId + '_' + m.itemId; if (!levels.has(id)) levels.set(id, (await getDoc('stockLevels', id, tx)) || null); }
        const now = nowIso();
        const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
        const writes = [];
        const sale = {
          series: 'INV', seq, docNo, blockId: block.id, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '',
          customerId: customer ? customer.id : '', customerSnapshot: customer ? { name: customer.name, phone: customer.phone || '', email: customer.email || '', vatNo: customer.vatNo || '', address: customer.address || {} } : null,
          lineCount: lines.length, subtotalCents: gross, lineDiscountCents: lineDisc, saleDiscountCents: saleDisc, saleDiscountPct: Number(b.saleDiscountPct) || 0, saleDiscountReason: clean(b.saleDiscountReason, 120), saleDiscountBy: saleBy,
          totalCents: total, vatCents: vat, vatRateBp: rateBp, vatRegistered: !!ctx.entity.vatRegistered, roundingCents: rounding,
          tenderedCents: cashTendered, changeCents: cashPay ? cashPay.changeCents : 0, paymentMethods: [...new Set(pays.map(p => p.method))], paidStatus: pays.some(p => p.status === 'awaiting') ? 'awaiting' : 'paid',
          cashierUid: ctx.user.id, cashierName: ctx.user.name, approvers: [...approvers].map(([uid, name]) => ({ uid, name })),
          note: clean(b.note, 300), source: ctx.device ? 'till' : 'office', clientCreatedAt: when, verified: true, ...stamp, serverReceivedAt: now
        };
        writes.push({ create: true, coll: 'sales', id: saleId, data: sale });
        lines.forEach(l => writes.push({ create: true, coll: 'saleLines', id: saleId + '_' + l.lineNo, data: { saleId, docNo, ...l, ...stamp } }));
        pays.forEach(p => writes.push({ create: true, coll: 'payments', id: randomId('pay_'), data: { docType: 'sale', docId: saleId, docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...p, ...stamp, serverReceivedAt: now } }));
        for (const m of moves) {
          const id = ctx.storeId + '_' + m.itemId; const lv = levels.get(id);
          const onHand = (lv ? lv.onHandQty || 0 : 0) + m.qty;
          writes.push({ create: true, coll: 'stockMovements', id: randomId('mv_'), data: { productId: m.productId, variantId: m.variantId, qty: m.qty, reason: m.reason, docType: 'sale', docId: saleId, docNo, unitCostCents: m.unitCostCents, note: m.name, onHandAfter: onHand, ...stamp, serverReceivedAt: now } });
          writes.push({ set: true, coll: 'stockLevels', id, data: { productId: m.productId, variantId: m.variantId, onHandQty: onHand, reservedQty: lv ? lv.reservedQty || 0 : 0, lastMovementAt: now, lastCountedAt: lv ? lv.lastCountedAt || '' : '', rebuiltAt: lv ? lv.rebuiltAt || '' : '', negative: onHand < 0, ...(lv ? {} : serverStamp(ctx.entityId, ctx.storeId, 'server', 'server')), entityId: ctx.entityId, storeId: ctx.storeId } });
          levels.set(id, { ...(lv || {}), onHandQty: onHand });
        }
        if (customer && (creditUsed || accountUsed)) writes.push({ update: true, coll: 'customers', id: customer.id, data: { ...(creditUsed ? { storeCreditCents: (customer.storeCreditCents || 0) - creditUsed } : {}), ...(accountUsed ? { accountBalanceCents: (customer.accountBalanceCents || 0) + accountUsed } : {}), updatedAt: now, updatedBy: 'server' } });
        for (const { vd, u } of vouchers) { const leftOver = vd.balanceCents - u.amount; writes.push({ update: true, coll: 'vouchers', id: vd.id, data: { balanceCents: leftOver, status: leftOver > 0 ? 'open' : 'used', uses: [...(vd.uses || []), { saleId, docNo, amountCents: u.amount, at: now }], updatedAt: now } }); u.pay.ref = vd.id; }
        const codesSold = [];
        for (const vs of vouchersSold) { const code = 'GV' + randomId().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10); codesSold.push({ lineNo: vs.lineNo, code, amountCents: vs.amountCents }); writes.push({ create: true, coll: 'vouchers', id: code, data: { code, amountCents: vs.amountCents, balanceCents: vs.amountCents, status: 'open', soldSaleId: saleId, soldDocNo: docNo, soldAt: now, expiresAt: new Date(at + 3 * 365 * 86400000).toISOString().slice(0, 10), customerId: customer ? customer.id : '', uses: [], ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) } }); }
        if (fresh) { writes.push({ create: true, coll: 'numberBlocks', id: block.id, data: { ...block, usedUpTo: seq } }); writes.push({ set: true, coll: 'counters', id: ctx.entityId + '_INV', data: { entityId: ctx.entityId, series: 'INV', next: counterNext, ...(counterExisted ? {} : serverStamp(ctx.entityId, '', 'server')) } }); }
        else writes.push({ update: true, coll: 'numberBlocks', id: block.id, data: { usedUpTo: Math.max(block.usedUpTo, seq) } });
        writes.push({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'sale.commit', docType: 'sale', docId: saleId, docNo, actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...approvers.keys()][0] || '', overrideName: [...approvers.values()][0] || '', details: { totalCents: total, lines: lines.length, methods: sale.paymentMethods, negativeStock: [...levels.values()].some(l => l.onHandQty < 0) }, ...stamp, serverReceivedAt: now } });
        await commit(writes, tx); done = true;
        sale.id = saleId;
        return { ok: true, sale, lines: lines.map(l => ({ ...l, saleId, docNo })), payments: pays, vouchersSold: codesSold, negativeStock: [...levels.values()].filter(l => l.onHandQty < 0).length };
      } catch (e) {
        if (e instanceof Reject && e.status === 409 && /moment ago/.test(e.message) && attempt < 4) continue;   // the transaction lost a race: again
        if (e instanceof Reject) throw e;
        if (attempt < 4 && /ABORTED|contention/i.test(String(e.message))) continue;
        throw e;
      } finally {
        if (!done) await rollback(tx);     // a transaction left open would hold its locks
      }
    }
    throw new Reject(409, 'The till was busy writing: try once more.');
  },

  async blocks(event, b) {
    const ctx = await whoAndWhere(event, b);
    const size = Math.max(10, Math.min(500, int((ctx.settings.numbering || {}).blockSize) || BLOCK_SIZE_DEFAULT));
    const out = {};
    for (const series of ['INV']) {
      const tx = await beginTransaction();
      let block, fresh, counterNext, counterExisted;
      try { ({ block, fresh, counterNext, counterExisted } = await openBlock(tx, ctx, series, size)); } catch (e) { await rollback(tx); throw e; }
      if (fresh) await commit([{ create: true, coll: 'numberBlocks', id: block.id, data: block }, { set: true, coll: 'counters', id: ctx.entityId + '_' + series, data: { entityId: ctx.entityId, series, next: counterNext, ...(counterExisted ? {} : serverStamp(ctx.entityId, '', 'server')) } }], tx);
      else await rollback(tx);
      out[series] = { id: block.id, from: block.from, to: block.to, usedUpTo: block.usedUpTo, prefix: ctx.entity.invoicePrefix };
    }
    return { ok: true, blocks: out, deviceId: ctx.deviceId };
  },

  async voucher(event, b) {
    const ctx = await whoAndWhere(event, b);
    const code = clean(b.code, 40).toUpperCase();
    const vd = await getDoc('vouchers', code);
    if (!vd || vd.entityId !== ctx.entityId) throw new Reject(404, 'No such voucher here.');
    return { ok: true, code, balanceCents: vd.balanceCents, status: vd.status, expiresAt: vd.expiresAt || '' };
  }
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-sale failed:', e);
    return json(500, { error: 'Something went wrong on the server. The sale was not written; try again.' });
  }
};
