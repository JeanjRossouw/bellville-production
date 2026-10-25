// Retail POS — the sale core, shared by pos-sale (a sale) and pos-return (an
// exchange: a credit note and a new sale in one transaction).
//
//   whoAndWhere(event, b)        the cashier, the till, the store, the open shift
//   prepareSale(ctx, b, opts)    prices every line, checks discounts, overrides, totals, VAT and tenders; no writes
//   saleWrites(tx, ctx, prep, saleId, b)   inside a transaction: the number, stock, vouchers; → { writes, result }
//   runSale(ctx, b, { more })    the transaction loop; `more(tx)` adds writes (an exchange's credit note) and a result
import { SPEC_FIELDS, fabricLabel, fabricMetresOf, fabricCentsFor, framePriceOf, upholsteredOf } from '../../../pos/js/special-terms.js';
import { Reject, clean, randomId, nowIso, rank, getDoc, query, commit, beginTransaction, rollback, serverStamp, loginOf, loadUser, inEntity, inStore, verifyOverrideToken, loadDevice, createDoc, patchDoc } from './pos.mjs';
import { vatIn, rateOn, rateFor, lineTotals, roundTo10c } from '../../../pos/js/money.js';
import { loyaltySettings, tierFor, earnPoints, pointsFor, sweep, earnLot, redeem, compactLots, blankLoyalty, blankStats } from '../../../pos/js/loyalty-terms.js';
import { afterStock } from './shopify-pos.mjs';

export const PREPAID = ['creditNote', 'layby', 'specialOrder'];   // a document that already holds the money pays first
export const METHODS = ['cash', 'card', 'eft', 'qr', 'voucher', 'storeCredit', 'account', 'points'];
export const BLOCK_SIZE_DEFAULT = 50;
export const int = (v) => Number.isInteger(v) ? v : (Number.isInteger(Number(v)) ? Number(v) : NaN);
export const pad6 = (n) => String(n).padStart(6, '0');
export const blockId = (entityId, series, deviceId, from) => `${entityId}_${series}_${deviceId}_${from}`;

// who and where: the cashier (by token) and the till (by secret); an office login sells as 'web:<uid>'
// opts.noShift: the till's register need not have an open shift (customers, stock, buying: no money changes hands)
// opts.shiftOptional: use the open shift if there is one (a refund at a till lands on its shift), otherwise none
export async function whoAndWhere(event, b, opts = {}) {
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
  if (registerId && !opts.noShift) {
    const reg = await getDoc('registers', registerId);
    if (!reg || reg.storeId !== storeId) throw new Reject(400, 'That register is not in this store.');
    const sh = reg.currentShiftId ? await getDoc('shifts', reg.currentShiftId) : null;
    if (!sh || sh.status !== 'open') { if (!opts.shiftOptional) throw new Reject(409, 'The register is closed: open it under Register first.'); }
    else shiftId = sh.id;
  }
  const ctx = { user, device, deviceId: device ? device.id : 'web:' + login.sub, entityId, storeId, registerId, shiftId, entity, store, settings: settings || {}, lineNonces: new Set() };
  // a manager's approval sent with the request is good once: it is spent here, before anything is written
  if (b.approvalToken) { ctx.approvalToken = String(b.approvalToken); ctx.approval = await consumeToken(ctx, ctx.approvalToken); }
  return ctx;
}

// the till's open block for a series, issuing one inside the transaction when it has none
export async function openBlock(tx, ctx, series, size) {
  const rows = await query('numberBlocks', [{ field: 'entityId', value: ctx.entityId }, { field: 'series', value: series }, { field: 'deviceId', value: ctx.deviceId }, { field: 'closedAt', value: '' }], 5);
  const live = rows.filter(r => (r.usedUpTo || r.from - 1) < r.to).sort((x, y) => x.from - y.from)[0];
  if (live) return { block: await getDoc('numberBlocks', live.id, tx), fresh: false };
  const key = ctx.entityId + '_' + series;
  const counter = await getDoc('counters', key, tx);
  const from = counter ? counter.next : 1, to = from + size - 1;
  const block = { id: blockId(ctx.entityId, series, ctx.deviceId, from), series, deviceId: ctx.deviceId, registerId: ctx.registerId || '', from, to, usedUpTo: from - 1, issuedAt: nowIso(), closedAt: '', ...serverStamp(ctx.entityId, ctx.storeId, 'server', ctx.deviceId) };
  return { block, fresh: true, counterNext: to + 1, counterExisted: !!counter };
}
// the next number of a series straight from the entity's counter, inside a transaction (credit notes, lay-bys: online only)
export async function nextFromCounter(tx, ctx, series, prefix) {
  const key = ctx.entityId + '_' + series;
  const counter = await getDoc('counters', key, tx);
  const seq = counter ? counter.next : 1;
  return { seq, docNo: prefix + '-' + pad6(seq), write: { set: true, coll: 'counters', id: key, data: { entityId: ctx.entityId, series, next: seq + 1, ...(counter ? {} : serverStamp(ctx.entityId, '', 'server')) } } };
}

export async function priceOf(ctx, p, v) {
  if (v) { if (v.storePrices && v.storePrices[ctx.storeId] != null) return v.storePrices[ctx.storeId]; if (v.priceCents != null) return v.priceCents; }
  if (p.storePrices && p.storePrices[ctx.storeId] != null) return p.storePrices[ctx.storeId];
  return p.priceCents || 0;
}
export const limitOf = (settings, role) => { const m = (settings.discounts || {}).maxPctByRole || {}; const v = m[role]; return v == null ? ({ cashier: 5, supervisor: 15, manager: 50, owner: 100 })[role] || 0 : Number(v); };
// a discount: within the cashier's limit, or carrying an approval token from pos-auth whose approver may give that much
const rememberNonce = (ctx, t) => { if (!t || !t.nonce) return; if (!ctx.lineNonces) ctx.lineNonces = new Set(); if (!ctx.lineTokens) ctx.lineTokens = new Map(); ctx.lineNonces.add(t.nonce); ctx.lineTokens.set(t.nonce, t); };
export function discountOk(ctx, pct, token, what) {
  if (pct <= limitOf(ctx.settings, ctx.user.role)) return { by: null };
  const t = verifyOverrideToken(token);
  if (!t || t.action !== 'override.discount' || t.entityId !== ctx.entityId) throw new Reject(403, `${pct}% off ${what} is over your limit and has no manager's approval.`);
  if (pct > limitOf(ctx.settings, t.role)) throw new Reject(403, `${pct}% off ${what}: the approver (${t.role}) may not give that much.`);
  rememberNonce(ctx, t);
  return { by: { uid: t.overrideUid, name: t.overrideName } };
}
const USED = 'That approval has been used already: ask for the PIN again.';
const usedRow = (ctx, t) => ({ action: t.action, overrideUid: t.overrideUid || '', actorUid: t.actorUid || '', usedAt: nowIso(), expiresAt: new Date(t.exp).toISOString(), ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) });
// an override token is spent the first time it is presented: usedTokens/{nonce} is created once, so a second
// request with the same token is refused (the PIN must be typed again)
export async function consumeToken(ctx, token) {
  const t = verifyOverrideToken(token);
  if (!t || !t.nonce) return null;
  if (await getDoc('usedTokens', t.nonce)) throw new Reject(403, USED);
  if (!(await createDoc('usedTokens', t.nonce, usedRow(ctx, t)))) throw new Reject(403, USED);
  return t;
}
// the approvals on sale lines (discounts, price changes) are spent inside the sale's transaction
export async function spendLineApprovals(ctx, tx) {
  const writes = [];
  for (const nonce of ctx.lineNonces || []) {
    if (await getDoc('usedTokens', nonce, tx)) throw new Reject(403, 'A manager\'s approval on this sale has been used already: ask for the PIN again.');
    writes.push({ create: true, coll: 'usedTokens', id: nonce, data: usedRow(ctx, ctx.lineTokens.get(nonce)) });
  }
  return writes;
}
// an approval token from pos-auth for this action, by at least this role; the actor's own rank may do.
// Only the token spent at the door (whoAndWhere, b.approvalToken) counts.
export function approved(ctx, token, action, minRole, what) {
  if (rank(ctx.user.role) >= rank(minRole)) return { uid: ctx.user.id, name: ctx.user.name, self: true };
  const t = token && token === ctx.approvalToken ? ctx.approval : null;
  if (!t || t.action !== 'override.' + action || t.entityId !== ctx.entityId || rank(t.role) < rank(minRole)) throw new Reject(403, `${what} needs a ${minRole}'s PIN.`);
  return { uid: t.overrideUid, name: t.overrideName, self: false };
}

// a quote, while it is open and valid: its prices stand for the same items (the till names the quote and the line)
export const saDay = (ms = Date.now()) => new Date(ms + 2 * 3600000).toISOString().slice(0, 10);
async function quoteOf(ctx, id, cache) {
  id = clean(id, 80); if (!id) return null;
  if (!cache.has(id)) cache.set(id, await getDoc('quotes', id));
  const q = cache.get(id);
  return q && q.entityId === ctx.entityId && q.status === 'open' && String(q.validUntil || '') >= saDay() ? { ...q, id } : null;
}
async function quotedLine(ctx, l, p, v, cache) {
  const q = await quoteOf(ctx, l.quoteId, cache); if (!q) return null;
  const ql = (q.lines || []).find(x => x.lineNo === int(l.quoteLine));
  const fab = (sp) => (sp && sp.fabricId) || '';
  if (!ql || ql.productId !== p.id || (ql.variantId || '') !== (v ? v.id : '') || fab(ql.spec) !== fab(l.spec)) return null;
  return { q, ql };
}

// once a sale or a sales order is written from a quote, the quote is used (it does not price a second one)
export async function markQuoteUsed(ctx, quoteId, kind, docNo) {
  const id = clean(quoteId, 80); if (!id) return;
  try { const q = await getDoc('quotes', id); if (q && q.entityId === ctx.entityId && q.status === 'open') await patchDoc('quotes', id, { status: 'used', usedAs: { kind, docNo }, usedAt: nowIso(), usedBy: ctx.user.name, updatedAt: nowIso() }); }
  catch (e) { console.error('quote not marked used', e); }
}

// opts.creditNote: { docNo, amountCents } — an exchange pays with the credit note first
// opts.quote: a quotation, not a tax invoice (no customer address needed over R 5 000)
export async function prepareSale(ctx, b, opts = {}) {
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
  const lines = [], moves = [], vouchersSold = [], qCache = new Map();
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
    } else {
      p = await getDoc('products', clean(l.productId, 60));
      if (!p || p.entityId !== ctx.entityId || (p.archived && !opts.trusted)) throw new Reject(400, `Line ${n}: that product is not for sale here.`);
      if (l.variantId) { v = await getDoc('variants', clean(l.variantId, 60)); if (!v || v.productId !== p.id || v.archived) throw new Reject(400, `Line ${n}: that variant is not for sale.`); }
      else if (p.hasVariants) throw new Reject(400, `Line ${n}: ${p.name} needs a variant.`);
      listPrice = await priceOf(ctx, p, v); name = p.name + (v ? ' · ' + v.name : ''); vatClass = p.vatClass || 'standard'; type = p.type || 'stock';
      trackStock = p.trackStock !== false && type === 'stock'; costCents = (v && v.costCents != null ? v.costCents : p.costCents) || 0; itemId = v ? v.id : p.id;
    }
    // a couch in a fabric of the customer's choice, priced here, never by the till: the frame price when it has one (else
    // its price) + the metres it takes × the catalogue fabric's price per metre (nothing for the customer's own fabric).
    // A stocked couch made in another fabric is made for the customer: a made-to-order line, no stock taken.
    let fabricCharge = null;
    if (upholsteredOf(p, v) && l.spec && typeof l.spec === 'object' && (l.spec.fabricId || l.spec.frame)) {
      let f = null; const fid = clean(l.spec.fabricId, 60);
      if (fid) { f = await getDoc('fabrics', fid); if (!f || f.entityId !== ctx.entityId || (f.archived && !opts.trusted)) throw new Reject(400, `Line ${n}: that fabric is not in the catalogue.`); }
      const frame = framePriceOf(p, v), metres = f ? fabricMetresOf(p, v) : 0, perMetre = f ? int(f.priceCents) || 0 : 0;
      fabricCharge = { fabricId: f ? fid : '', fabric: f ? fabricLabel(f) : clean(l.spec.fabric, 120), fabricMetres: metres, fabricPerMetreCents: perMetre, fabricCents: fabricCentsFor(metres, perMetre), frame: frame > 0, framePriceCents: frame };
      listPrice = (frame > 0 ? frame : listPrice) + fabricCharge.fabricCents;
      if (type === 'stock') { type = 'mto'; trackStock = false; }
    }
    // the price: the list price, or an override a manager approved
    let unit = int(l.unitPriceCents), override = null;
    if (!(unit >= 0)) throw new Reject(400, `Line ${n}: the price is wrong.`);
    const quoted = p && l.quoteId ? await quotedLine(ctx, l, p, v, qCache) : null;
    if (unit !== listPrice && opts.trusted) override = { fromCents: listPrice, reason: opts.trusted, by: null };   // fixed when the lay-by was opened
    else if (unit !== listPrice && quoted && unit === quoted.ql.unitPriceCents) override = { fromCents: listPrice, reason: 'Quote ' + quoted.q.docNo, by: null };
    else if (unit !== listPrice) {
      const t = verifyOverrideToken(l.priceOverride && l.priceOverride.token);
      const self = rank(ctx.user.role) >= rank('manager');
      if (!self && (!t || t.action !== 'override.price' || t.entityId !== ctx.entityId)) throw new Reject(403, `Line ${n}: the price of ${name} was changed without a manager's approval.`);
      if (!self) rememberNonce(ctx, t);
      override = { fromCents: listPrice, reason: clean(l.priceOverride && l.priceOverride.reason, 120), by: self ? { uid: ctx.user.id, name: ctx.user.name } : { uid: t.overrideUid, name: t.overrideName } };
      if (!self) approvers.set(t.overrideUid, t.overrideName);
    }
    const disc = int(l.discountCents) || 0;
    if (disc < 0 || disc > qty * unit) throw new Reject(400, `Line ${n}: the discount is wrong.`);
    const pct = disc ? Math.round(disc / (qty * unit) * 1000) / 10 : 0;
    const dOk = disc && !opts.trusted && !(quoted && disc === (quoted.ql.discountCents || 0)) ? discountOk(ctx, pct, l.discountToken, name) : { by: null };
    if (dOk.by) approvers.set(dOk.by.uid, dOk.by.name);
    const lr = rateFor(vatClass, rateBp, !!ctx.entity.vatRegistered);
    const t = lineTotals({ qty, unitPriceCents: unit, discountCents: disc, rateBp: lr });
    gross += t.grossCents; lineDisc += t.discountCents; sub += t.lineTotalCents;
    const fulfilment = type === 'mto' ? 'mto' : type === 'nonstock' || type === 'voucher' ? 'service' : 'stock';
    // a made-to-order line on an ordinary sale carries its specification (a sales order); it is read back on the invoice line's note
    const spec = opts.spec && type === 'mto' && l.spec && typeof l.spec === 'object' ? specOf(l.spec) : null;
    if (spec && !spec.model) spec.model = name;
    if (spec && fabricCharge) Object.assign(spec, fabricCharge);
    const noteOf = [clean(l.note, 200), ...(spec ? specNote(spec).filter(x => x !== 'Model ' + name) : [])].filter(Boolean).join(' · ').slice(0, 200);
    lines.push({ lineNo: n, productId: p ? p.id : '', variantId: v ? v.id : '', itemId, sku: (v && v.sku) || (p && p.sku) || '', name, type, fulfilment, qty, unitPriceCents: unit, listPriceCents: listPrice, priceOverride: override,
      discountCents: t.discountCents, discountPct: pct, discountReason: clean(l.discountReason, 120), discountBy: dOk.by, lineTotalCents: t.lineTotalCents, vatClass, vatRateBp: lr, costCents, trackStock, note: noteOf, custom: !!l.custom, ...(spec ? { spec } : {}), ...(fabricCharge ? { fabricCharge } : {}) });
    if (p && type === 'bundle') for (const c of p.bundle || []) { const cp = await getDoc('products', c.productId); if (!cp) continue; const cv = c.variantId ? await getDoc('variants', c.variantId) : null; if (cp.trackStock !== false && cp.type === 'stock') moves.push({ productId: cp.id, variantId: cv ? cv.id : '', itemId: cv ? cv.id : cp.id, qty: -(qty * (int(c.qty) || 1)), unitCostCents: (cv && cv.costCents != null ? cv.costCents : cp.costCents) || 0, reason: 'bundle', name: cp.name + (cv ? ' · ' + cv.name : '') }); }
    else if (trackStock) moves.push({ productId: p.id, variantId: v ? v.id : '', itemId, qty: -qty, unitCostCents: costCents, reason: 'sale', name });
    if (type === 'voucher') for (let k = 0; k < qty; k++) vouchersSold.push({ lineNo: n, amountCents: unit });
  }
  // ---- the sale discount, spread over the lines so each line's VAT is right
  const saleDisc = Math.min(sub, int(b.saleDiscountCents) || 0);
  if (saleDisc < 0) throw new Reject(400, 'The sale discount is wrong.');
  let saleBy = null;
  let saleCode = '';
  const saleQuote = b.quoteId ? await quoteOf(ctx, b.quoteId, qCache) : null;
  if (saleDisc && !opts.trusted && !(saleQuote && saleDisc === (saleQuote.saleDiscountCents || 0))) {
    // a Shopify discount code the server knows needs no PIN; anything else goes by the role limits
    const code = clean(b.saleDiscountCode, 40).toUpperCase();
    const dc = code ? await getDoc('discountCodes', ctx.entityId + '_' + code) : null;
    const day = when.slice(0, 10);
    if (dc && dc.entityId === ctx.entityId && dc.active && (!dc.startsAt || dc.startsAt.slice(0, 10) <= day) && (!dc.endsAt || dc.endsAt.slice(0, 10) >= day)) {
      const allowed = dc.kind === 'percentage' ? Math.round(sub * dc.value / 100) : dc.valueCents || 0;
      if (saleDisc > allowed) throw new Reject(400, `Code ${code} gives at most ${(allowed / 100).toFixed(2)} off this sale.`);
      saleCode = code;
    } else if (code) throw new Reject(400, `Discount code ${code} is not valid today.`);
    else { const pct = Math.round(saleDisc / sub * 1000) / 10; saleBy = discountOk(ctx, pct, b.saleDiscountToken, 'the sale').by; if (saleBy) approvers.set(saleBy.uid, saleBy.name); }
  }
  let left = saleDisc, vat = 0;
  lines.forEach((l, i) => { const share = i === lines.length - 1 ? left : (sub ? Math.round(saleDisc * l.lineTotalCents / sub) : 0); left -= share; l.saleDiscountCents = share; l.netCents = l.lineTotalCents - share; l.vatCents = vatIn(l.netCents, l.vatRateBp); vat += l.vatCents; });
  const total = sub - saleDisc;
  const told = b.totals || {};
  if (!opts.trusted && (int(told.totalCents) !== total || int(told.vatCents) !== vat)) throw new Reject(409, `The till’s total (${told.totalCents}) does not match the server’s (${total}). Reopen the sale and try again.`);
  // over R 5 000 a VAT-registered company must issue a full tax invoice: the customer's name and address go on it
  if (ctx.entity.vatRegistered && total > 500000 && !opts.quote) {
    const a = customer && customer.address;
    if (!customer || !String(customer.name || '').trim()) throw new Reject(400, 'Over R 5 000 a full tax invoice is needed: add the customer with their name and address.');
    if (!a || !String(a.line1 || a.city || '').trim()) throw new Reject(400, `Over R 5 000 a full tax invoice is needed: add ${customer.name}’s address.`);
  }

  // ---- the tenders: a sale is paid in full; a lay-by's deposit or instalment is a part (opts.noTenders: none at all)
  const base = { when, at, rateBp, customer, lines, moves, vouchersSold, approvers, saleBy, saleCode, gross, lineDisc, saleDisc, sub, total, vat };
  if (opts.noTenders) return { ...base, voucherUse: [], pays: [], paid: 0, rounding: 0, cashTendered: 0, cashPay: null, creditUsed: 0, accountUsed: 0, pointsUsed: 0, pointsCents: 0 };
  const prepaid = opts.prepaid || (opts.creditNote ? { method: 'creditNote', ...opts.creditNote } : null);
  return { ...base, ...prepareTenders(ctx, b.tenders, { total, customer, prepaid }) };
}

// The tenders of a document: each method against the store's, one cash tender rounded to 10c with the
// change worked out, store credit and the account against the customer, vouchers looked up later inside
// the transaction. opts.prepaid { method: 'creditNote'|'layby'|'specialOrder', docNo, amountCents } pays first (an exchange's
// credit, a lay-by collected). opts.partial takes less than the total (a lay-by's deposit or instalment):
// cash is then whatever was given less change, with no rounding.
export function prepareTenders(ctx, inTenders, { total, customer, prepaid, partial } = {}) {
  const tenders = Array.isArray(inTenders) ? [...inTenders] : [];
  if (prepaid) tenders.unshift({ method: prepaid.method, amountCents: Math.min(prepaid.amountCents, total), ref: prepaid.docNo });
  if (!tenders.length || tenders.length > 10) throw new Reject(400, 'No payment.');
  const allowed = ctx.store.paymentMethods || ['cash', 'card'];
  let paid = 0, cashTendered = 0, cashCount = 0, creditUsed = 0, accountUsed = 0, rounding = 0, pointsCents = 0, pointsUsed = 0;
  const ls = loyaltySettings(ctx.settings);
  const voucherUse = [];
  const pays = [];
  for (const t of tenders) {
    const method = clean(t.method, 20); const amount = int(t.amountCents);
    if (PREPAID.includes(method)) { if (!prepaid || method !== prepaid.method || t !== tenders[0]) throw new Reject(400, method === 'layby' ? 'A lay-by pays only when it is collected.' : method === 'specialOrder' ? 'A special order pays only when it is handed over.' : 'A credit note pays only through an exchange.'); }
    else if (!METHODS.includes(method) || (!allowed.includes(method) && method !== 'points')) throw new Reject(400, `${method || 'That'} is not a payment method at this store.`);
    if (!(amount > 0)) { if (prepaid && method === prepaid.method) continue; throw new Reject(400, 'A payment must be more than nothing.'); }
    const pay = { method, amountCents: amount, ref: clean(t.ref, 60), status: 'paid' };
    if (method === 'cash') { cashCount++; pay.tenderedCents = int(t.tenderedCents) || amount; if (pay.tenderedCents < amount) throw new Reject(400, 'Cash given is less than the cash part.'); cashTendered += pay.tenderedCents; }
    if (method === 'card') { pay.cardLast4 = clean(t.cardLast4, 4).replace(/\D/g, ''); pay.approvalCode = clean(t.approvalCode, 20); }
    if (method === 'eft') pay.status = t.status === 'awaiting' ? 'awaiting' : 'paid';
    if (method === 'storeCredit') { if (!customer) throw new Reject(400, 'Store credit needs the customer on the sale.'); creditUsed += amount; }
    if (method === 'account') { if (!customer || !customer.accountEnabled) throw new Reject(400, 'This customer has no account.'); accountUsed += amount; }
    if (method === 'points') { if (!ls.enabled) throw new Reject(400, 'Loyalty points are not switched on.'); if (!customer) throw new Reject(400, 'Points need the customer on the sale.'); pointsCents += amount; pay.points = pointsFor(ls, amount); pointsUsed += pay.points; }
    if (method === 'voucher') { const code = clean(t.voucherCode, 40).toUpperCase(); if (!code) throw new Reject(400, 'Which voucher?'); voucherUse.push({ code, amount, pay }); }
    paid += amount; pays.push(pay);
  }
  if (cashCount > 1) throw new Reject(400, 'One cash payment per sale: add the notes together.');
  if (creditUsed > (customer ? customer.storeCreditCents || 0 : 0)) throw new Reject(400, 'Not enough store credit.');
  if (accountUsed && accountUsed + (customer.accountBalanceCents || 0) > (customer.creditLimitCents || 0)) throw new Reject(400, 'That takes the account past its limit.');
  if (pointsUsed) { const have = sweep(customer.loyalty, nowIso()).points; if (pointsUsed > have) throw new Reject(400, `Not enough points: ${have} (${(have * ls.pointValueCents / 100).toFixed(2)} rand).`); if (pointsUsed < ls.minRedeemPoints) throw new Reject(400, `At least ${ls.minRedeemPoints} points at a time.`); }
  const cashPay = pays.find(p => p.method === 'cash');
  if (partial) {
    if (paid > total) throw new Reject(400, `Payments (${paid}) are more than what is owed (${total}).`);
    if (cashPay) cashPay.changeCents = cashPay.tenderedCents - cashPay.amountCents;
    if (pointsUsed) throw new Reject(400, 'Points pay for a sale, not a deposit.');
    return { voucherUse, pays, paid, rounding: 0, cashTendered, cashPay, creditUsed, accountUsed, pointsUsed: 0, pointsCents: 0 };
  }
  // cash may be rounded to 10c: the cash part due is total less the other tenders
  const others = paid - (cashPay ? cashPay.amountCents : 0);
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
  return { voucherUse, pays, paid, rounding, cashTendered, cashPay, creditUsed, accountUsed, pointsUsed, pointsCents };
}

// inside a transaction: the number, the vouchers, the stock levels; the writes for a sale and what to answer
export async function saleWrites(tx, ctx, s, saleId, b, levels = new Map()) {
  const size = Math.max(10, Math.min(500, int((ctx.settings.numbering || {}).blockSize) || BLOCK_SIZE_DEFAULT));
  const { block, fresh, counterNext, counterExisted } = await openBlock(tx, ctx, 'INV', size);
  let seq = int(b.seq);
  if (seq) { if (seq < block.from || seq > block.to || seq <= block.usedUpTo) throw new Reject(409, `Number ${seq} is not free in this till’s block (${block.from}–${block.to}, used to ${block.usedUpTo}).`); }
  else seq = block.usedUpTo + 1;
  const docNo = ctx.entity.invoicePrefix + '-' + pad6(seq);
  const vouchers = [];
  for (const u of s.voucherUse) { const vd = await getDoc('vouchers', u.code, tx); if (!vd || vd.entityId !== ctx.entityId || vd.status !== 'open' || (vd.expiresAt && vd.expiresAt < s.when.slice(0, 10))) throw new Reject(400, `Voucher ${u.code} is not valid here.`); if (vd.balanceCents < u.amount) throw new Reject(400, `Voucher ${u.code} has ${vd.balanceCents} cents left.`); vouchers.push({ vd, u }); }
  for (const m of s.moves) { const id = ctx.storeId + '_' + m.itemId; if (!levels.has(id)) levels.set(id, (await getDoc('stockLevels', id, tx)) || null); }
  const now = nowIso();
  const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
  const writes = [];
  const customer = s.customer;
  const sale = {
    series: 'INV', seq, docNo, blockId: block.id, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '',
    customerId: customer ? customer.id : '', customerSnapshot: customer ? { name: customer.name, phone: customer.phone || '', email: customer.email || '', vatNo: customer.vatNo || '', address: customer.address || {} } : null,
    lineCount: s.lines.length, subtotalCents: s.gross, lineDiscountCents: s.lineDisc, saleDiscountCents: s.saleDisc, saleDiscountPct: Number(b.saleDiscountPct) || 0, saleDiscountReason: clean(b.saleDiscountReason, 120), saleDiscountBy: s.saleBy, saleDiscountCode: s.saleCode || '',
    totalCents: s.total, vatCents: s.vat, vatRateBp: s.rateBp, vatRegistered: !!ctx.entity.vatRegistered, roundingCents: s.rounding,
    tenderedCents: s.cashTendered, changeCents: s.cashPay ? s.cashPay.changeCents : 0, paymentMethods: [...new Set(s.pays.map(p => p.method))], paidStatus: s.pays.some(p => p.status === 'awaiting') ? 'awaiting' : 'paid',
    cashierUid: ctx.user.id, cashierName: ctx.user.name, approvers: [...s.approvers].map(([uid, name]) => ({ uid, name })),
    note: clean(b.note, 300), source: ctx.device ? 'till' : 'office', clientCreatedAt: s.when, verified: true, loyalty: null, exchangeOf: b.exchangeOf || '', laybyOf: b.laybyOf || '', specialOrderOf: b.specialOrderOf || '', ...stamp, serverReceivedAt: now
  };
  writes.push({ create: true, coll: 'sales', id: saleId, data: sale });
  s.lines.forEach(l => writes.push({ create: true, coll: 'saleLines', id: saleId + '_' + l.lineNo, data: { saleId, docNo, ...l, ...stamp } }));
  s.pays.forEach(p => writes.push({ create: true, coll: 'payments', id: randomId('pay_'), data: { docType: 'sale', docId: saleId, docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...p, ...stamp, serverReceivedAt: now } }));
  for (const m of s.moves) writes.push(...moveWrites(ctx, levels, m, { docType: 'sale', docId: saleId, docNo }, stamp, now));
  let loyaltyOut = null;
  if (customer) {
    const ls = loyaltySettings(ctx.settings);
    const lo = { ...blankLoyalty(), ...(customer.loyalty || {}) };
    const sw = sweep(lo, now);
    let lots = sw.lots;
    const ledger = [];
    if (sw.expiredPoints) ledger.push({ kind: 'expire', points: -sw.expiredPoints });
    if (s.pointsUsed) { lots = redeem(lots, s.pointsUsed); ledger.push({ kind: 'redeem', points: -s.pointsUsed }); }
    const tier = tierFor(ls, lo.lifetimeCents);
    const earned = earnPoints(ls, s.total - s.pointsCents, tier);
    if (earned) { lots = compactLots([...lots, earnLot(ls, earned, now, saleId)]); ledger.push({ kind: 'earn', points: earned, expiresAt: lots[lots.length - 1].expiresAt }); }
    const after = lots.reduce((n, l) => n + l.left, 0);
    const lifetime = (lo.lifetimeCents || 0) + (s.total - s.pointsCents);
    const st = { ...blankStats(), ...(customer.stats || {}) };
    const stats = { salesCount: (st.salesCount || 0) + 1, spentCents: (st.spentCents || 0) + s.total, firstSaleAt: st.firstSaleAt || now, lastSaleAt: now };
    let bal = sw.points;
    for (const e of ledger) { bal += e.points; writes.push({ create: true, coll: 'loyaltyLedger', id: randomId('lp_'), data: { customerId: customer.id, kind: e.kind, points: e.points, balanceAfter: bal, saleId, docNo, note: '', expiresAt: e.expiresAt || '', ...stamp, serverReceivedAt: now } }); }
    const loyalty = ls.enabled || lots.length ? { points: after, lifetimeCents: lifetime, tier: tierFor(ls, lifetime).name, lots, lastEarnedAt: earned ? now : lo.lastEarnedAt || '' } : lo;
    writes.push({ update: true, coll: 'customers', id: customer.id, data: { ...(s.creditUsed ? { storeCreditCents: (customer.storeCreditCents || 0) - s.creditUsed } : {}), ...(s.accountUsed ? { accountBalanceCents: (customer.accountBalanceCents || 0) + s.accountUsed } : {}), loyalty, stats, updatedAt: now, updatedBy: 'server' } });
    if (ls.enabled) loyaltyOut = { earned, redeemed: s.pointsUsed, balance: after, tier: loyalty.tier };
  }
  if (loyaltyOut) sale.loyalty = loyaltyOut;
  for (const { vd, u } of vouchers) { const leftOver = vd.balanceCents - u.amount; writes.push({ update: true, coll: 'vouchers', id: vd.id, data: { balanceCents: leftOver, status: leftOver > 0 ? 'open' : 'used', uses: [...(vd.uses || []), { saleId, docNo, amountCents: u.amount, at: now }], updatedAt: now } }); u.pay.ref = vd.id; }
  const codesSold = [];
  for (const vs of s.vouchersSold) { const code = 'GV' + randomId().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10); codesSold.push({ lineNo: vs.lineNo, code, amountCents: vs.amountCents }); writes.push({ create: true, coll: 'vouchers', id: code, data: { code, amountCents: vs.amountCents, balanceCents: vs.amountCents, status: 'open', soldSaleId: saleId, soldDocNo: docNo, soldAt: now, expiresAt: new Date(s.at + 3 * 365 * 86400000).toISOString().slice(0, 10), customerId: customer ? customer.id : '', uses: [], ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) } }); }
  if (fresh) { writes.push({ create: true, coll: 'numberBlocks', id: block.id, data: { ...block, usedUpTo: seq } }); writes.push({ set: true, coll: 'counters', id: ctx.entityId + '_INV', data: { entityId: ctx.entityId, series: 'INV', next: counterNext, ...(counterExisted ? {} : serverStamp(ctx.entityId, '', 'server')) } }); }
  else writes.push({ update: true, coll: 'numberBlocks', id: block.id, data: { usedUpTo: Math.max(block.usedUpTo, seq) } });
  writes.push({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'sale.commit', docType: 'sale', docId: saleId, docNo, actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...s.approvers.keys()][0] || '', overrideName: [...s.approvers.values()][0] || '', details: { totalCents: s.total, lines: s.lines.length, methods: sale.paymentMethods, negativeStock: [...levels.values()].some(l => l && l.onHandQty < 0) }, ...stamp, serverReceivedAt: now } });
  sale.id = saleId;
  return { writes, result: { ok: true, sale, lines: s.lines.map(l => ({ ...l, saleId, docNo })), payments: s.pays, vouchersSold: codesSold, negativeStock: [...levels.values()].filter(l => l && l.onHandQty < 0).length } };
}

// a stock movement and the level it moves, kept in the `levels` map for the next one in the same transaction.
// bucket 'onHand' (default) is sellable stock; 'quarantine' is kept apart (a return to be inspected);
// 'reserved' is held for a lay-by or special order and counts against what may be sold
export function moveWrites(ctx, levels, m, doc, stamp, now) {
  const id = ctx.storeId + '_' + m.itemId; const lv = levels.get(id);
  const bucket = m.bucket || 'onHand';
  const onHand = (lv ? lv.onHandQty || 0 : 0) + (bucket === 'onHand' ? m.qty : 0);
  const quarantine = (lv ? lv.quarantineQty || 0 : 0) + (bucket === 'quarantine' ? m.qty : 0);
  const reserved = (lv ? lv.reservedQty || 0 : 0) + (bucket === 'reserved' ? m.qty : 0);
  const onOrder = (lv ? lv.onOrderQty || 0 : 0) + (m.onOrderDelta || 0);
  // the weighted average cost moves when stock comes in at a cost (a receipt, stock found); counts and sales leave it
  const oldOnHand = lv ? lv.onHandQty || 0 : 0;
  const oldAvg = lv && lv.avgCostCents > 0 ? lv.avgCostCents : (m.baseCostCents || m.unitCostCents || 0);
  const avg = m.wac && bucket === 'onHand' && m.qty > 0 && m.unitCostCents >= 0 ? (oldOnHand > 0 ? Math.round((oldOnHand * oldAvg + m.qty * m.unitCostCents) / (oldOnHand + m.qty)) : m.unitCostCents) : oldAvg;
  const next = { ...(lv || {}), storeId: ctx.storeId, productId: m.productId, variantId: m.variantId, onHandQty: onHand, quarantineQty: quarantine, reservedQty: reserved, onOrderQty: onOrder, avgCostCents: avg, lastCountedAt: m.countedAt || (lv ? lv.lastCountedAt || '' : '') };
  levels.set(id, next);
  return [
    { create: true, coll: 'stockMovements', id: randomId('mv_'), data: { productId: m.productId, variantId: m.variantId, qty: m.qty, bucket, reason: m.reason, code: m.code || '', docType: doc.docType, docId: doc.docId, docNo: doc.docNo, unitCostCents: m.unitCostCents || 0, note: m.note || m.name || '', byName: m.byName || '', onHandAfter: onHand, ...stamp, serverReceivedAt: now } },
    { set: true, coll: 'stockLevels', id, data: { productId: m.productId, variantId: m.variantId, onHandQty: onHand, quarantineQty: quarantine, reservedQty: reserved, onOrderQty: onOrder, avgCostCents: avg, lastMovementAt: now, lastCountedAt: next.lastCountedAt, rebuiltAt: lv ? lv.rebuiltAt || '' : '', negative: onHand < 0, ...(lv ? {} : serverStamp(ctx.entityId, ctx.storeId, 'server', 'server')), entityId: ctx.entityId, storeId: ctx.storeId } }
  ];
}

// the transaction loop: `more(tx, levels)` may add writes and fields to the answer (an exchange's credit note)
// the specification of a made-to-order line, as the till sends it; the photo (shrunk by the till) at most 300 KB
export const PHOTO_MAX = 300000;
export const specOf = (sp) => { const out = {}; for (const [k] of SPEC_FIELDS) out[k] = clean(sp && sp[k], k === 'notes' ? 500 : 120); const photo = String((sp && sp.photo) || ''); if (photo) { if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > PHOTO_MAX) throw new Reject(400, 'The photo must be a JPEG, PNG or WebP under 300 KB (the till shrinks it).'); } out.photo = photo; return out; };
export const specNote = (sp) => sp ? SPEC_FIELDS.filter(f => sp[f[0]] && f[0] !== 'notes').map(f => f[1] + ' ' + sp[f[0]]) : [];

// `more` runs before the sale is numbered (a credit note the sale's tender names); `after` runs once the sale is
// written and sees its result (a document that carries the invoice number), all in the one transaction
export async function runSale(ctx, b, { saleId, prep, more, after } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tx = await beginTransaction();
    let done = false;
    try {
      const levels = new Map();
      const extra = more ? await more(tx, levels) : { writes: [], result: {} };
      const s = prep ? await saleWrites(tx, ctx, prep, saleId, b, levels) : { writes: [], result: {} };
      const late = after ? await after(tx, levels, s.result) : { writes: [], result: {} };
      const spent = await spendLineApprovals(ctx, tx);
      await commit(squash([...extra.writes, ...s.writes, ...late.writes, ...spent]), tx); done = true;
      if (levels.size) await afterStock(ctx, levels);   // the POS is master for stock: Shopify hears of every movement
      return { ...s.result, ...extra.result, ...late.result, ok: true };
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
}

// a document set twice in one transaction keeps the last write (the levels map carries the earlier one's figures)
function squash(writes) {
  const last = new Map();
  writes.forEach((w, i) => { if (w.set) last.set(w.coll + '/' + w.id, i); });
  return writes.filter((w, i) => !w.set || last.get(w.coll + '/' + w.id) === i);
}
