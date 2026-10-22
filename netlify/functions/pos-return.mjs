// Retail POS — returns, refunds and exchanges. A credit note is a numbered,
// never-changed document that reverses lines of a sale at the price actually
// paid, with the VAT reversed. Only this function writes credit notes and
// refunds; the till reads them.
//
//   find    { docNo } | { customerId, from?, to? } | { date }   (login; store context)  → the sales matching, with their lines and what was returned already
//   credit  { saleId, lines [ { saleLineNo, qty, reason, disposition: 'restock'|'quarantine'|'writeoff' } ],
//             refunds [ { method: 'cash'|'card'|'eft'|'storeCredit', amountCents, ref } ],
//             approvalToken?, clientCreatedAt,
//             noReceipt?: true with lines [ { productId, variantId, qty, reason, disposition } ] and customerId (store credit only, a manager's PIN),
//             exchange?: { ...a sale body as pos-sale commit takes it, with its own saleId }   the credit pays the new sale first; both are written together }
//
// Rules: never more than sold; outside the entity's return window or a made-to-order
// item needs a manager's PIN; refunds must equal the credit; a no-receipt return
// is store credit only, needs the customer and a manager.
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { cancelAtFactory } from './lib/factory-bridge.mjs';
import { json, Reject, clean, randomId, nowIso, getDoc, query, serverStamp, bodyOf, patchDoc } from './lib/pos.mjs';
import { whoAndWhere, prepareSale, runSale, nextFromCounter, moveWrites, approved, priceOf, int } from './lib/sale.mjs';
import { vatIn, rateOn, rateFor } from '../../pos/js/money.js';

const REFUND_METHODS = ['cash', 'card', 'eft', 'storeCredit'];
const DISPOSITIONS = ['restock', 'quarantine', 'writeoff'];
const DEFAULT_REASONS = ['Changed mind', 'Faulty', 'Wrong item', 'Damaged', 'Other'];
const returnsSettings = (s) => ({ windowDays: int((s.returns || {}).windowDays) || 7, reasons: (s.returns || {}).reasons || DEFAULT_REASONS });

// what was returned already on a sale, per line
async function returnedSoFar(saleId) {
  const notes = await query('creditNotes', [{ field: 'saleId', value: saleId }], 100);
  const by = {};
  for (const n of notes) for (const l of n.lines || []) by[l.saleLineNo] = (by[l.saleLineNo] || 0) + l.qty;
  return by;
}
async function saleWithLines(ctx, saleId) {
  const sale = await getDoc('sales', saleId);
  if (!sale || sale.entityId !== ctx.entityId) throw new Reject(404, 'No such sale here.');
  const lines = await query('saleLines', [{ field: 'saleId', value: saleId }], 500, { field: 'lineNo' });
  return { sale: { ...sale, id: saleId }, lines, returned: await returnedSoFar(saleId) };
}

const actions = {
  async find(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    let sales = [];
    if (b.docNo) sales = await query('sales', [{ field: 'entityId', value: ctx.entityId }, { field: 'docNo', value: clean(b.docNo, 30).toUpperCase() }], 5);
    else if (b.customerId) sales = (await query('sales', [{ field: 'entityId', value: ctx.entityId }, { field: 'customerId', value: clean(b.customerId, 60) }], 200)).filter(s => (!b.from || s.clientCreatedAt >= b.from) && (!b.to || s.clientCreatedAt <= b.to + 'T23:59:59'));
    else if (b.date) sales = (await query('sales', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }], 500)).filter(s => String(s.clientCreatedAt).slice(0, 10) === clean(b.date, 10));
    else throw new Reject(400, 'Give a receipt number, a customer or a date.');
    sales.sort((x, y) => String(y.clientCreatedAt).localeCompare(String(x.clientCreatedAt)));
    const out = [];
    for (const s of sales.slice(0, 50)) out.push(await saleWithLines(ctx, s.id));
    return { ok: true, sales: out, settings: returnsSettings(ctx.settings) };
  },

  async credit(event, b) {
    // a refund lands on the till's open shift so the cash-up is right; without one it is an office refund
    const ctx = await whoAndWhere(event, b, { shiftOptional: !b.exchange });
    const when = clean(b.clientCreatedAt, 40) || nowIso();
    const rs = returnsSettings(ctx.settings);
    // the till's own id for this credit: a resend after a dropped line gets the first answer, never a second note
    const creditId = clean(b.creditId, 80);
    if (!/^[\w:.-]{8,80}$/.test(creditId)) throw new Reject(400, 'The credit note has no id.');
    const hadNote = await getDoc('creditNotes', creditId);
    if (hadNote) { if (hadNote.entityId !== ctx.entityId) throw new Reject(403, 'Not your credit note.'); return { ok: true, again: true, creditNote: { ...hadNote, id: creditId }, refunds: hadNote.refunds || [], sale: hadNote.exchangeSaleId ? { ...(await getDoc('sales', hadNote.exchangeSaleId)), id: hadNote.exchangeSaleId } : null, lines: hadNote.exchangeSaleId ? await query('saleLines', [{ field: 'saleId', value: hadNote.exchangeSaleId }], 500, { field: 'lineNo' }) : [], payments: [] }; }
    const inLines = Array.isArray(b.lines) ? b.lines : [];
    if (!inLines.length || inLines.length > 100) throw new Reject(400, 'Nothing to return.');
    const approvers = new Map();
    const need = (action, minRole, what) => { const a = approved(ctx, b.approvalToken, action, minRole, what); if (!a.self) approvers.set(a.uid, a.name); return a; };
    const customer = b.customerId ? await getDoc('customers', clean(b.customerId, 60)) : null;
    if (b.customerId && (!customer || customer.entityId !== ctx.entityId)) throw new Reject(400, 'That customer is not known here.');

    // ---- the lines: from the sale at the price actually paid, or without a receipt at today's price
    let sale = null, lines = [], moves = [], total = 0, vat = 0;
    if (!b.noReceipt) {
      const saleId = clean(b.saleId, 80);
      const got = await saleWithLines(ctx, saleId);
      sale = got.sale;
      if (sale.storeId !== ctx.storeId && !approvers.size) need('return', 'manager', 'A return of a sale from another store');
      const ageDays = (Date.now() - Date.parse(sale.clientCreatedAt)) / 86400000;
      if (ageDays > rs.windowDays) need('return', 'manager', `A return after ${rs.windowDays} days`);
      for (const l of inLines) {
        const sl = got.lines.find(x => x.lineNo === int(l.saleLineNo));
        if (!sl) throw new Reject(400, 'That line is not on the sale.');
        const qty = int(l.qty); const left = sl.qty - (got.returned[sl.lineNo] || 0);
        if (!(qty >= 1) || qty > left) throw new Reject(400, `${sl.name}: only ${left} of ${sl.qty} can still be returned.`);
        if (sl.fulfilment === 'mto') need('return', 'manager', 'Returning a made-to-order item');
        const disposition = DISPOSITIONS.includes(l.disposition) ? l.disposition : 'restock';
        const reason = clean(l.reason, 80) || 'Other';
        // the price actually paid: this line's net (after its own and the sale's discounts), pro rata for a part
        const done = got.returned[sl.lineNo] || 0;
        const netReturned = Math.round(sl.netCents * (done + qty) / sl.qty) - Math.round(sl.netCents * done / sl.qty);   // the parts of a line add up to the line, whatever the order
        const vatReturned = vatIn(netReturned, sl.vatRateBp || 0);
        lines.push({ saleLineNo: sl.lineNo, productId: sl.productId, variantId: sl.variantId, itemId: sl.itemId, name: sl.name, qty, soldQty: sl.qty, unitPaidCents: Math.round(sl.netCents / sl.qty), lineTotalCents: netReturned, vatRateBp: sl.vatRateBp || 0, vatCents: vatReturned, reason, disposition, type: sl.type, fulfilment: sl.fulfilment });
        total += netReturned; vat += vatReturned;
        if (sl.trackStock && sl.itemId && disposition !== 'writeoff') moves.push({ productId: sl.productId, variantId: sl.variantId, itemId: sl.itemId, qty, bucket: disposition === 'quarantine' ? 'quarantine' : 'onHand', reason: 'creditNote', unitCostCents: sl.costCents || 0, name: sl.name });
      }
    } else {
      if (!customer) throw new Reject(400, 'A return without a receipt needs the customer: it becomes store credit.');
      need('return', 'manager', 'A return without a receipt');
      const rateBp = ctx.entity.vatRegistered ? rateOn((ctx.settings.vat || {}).rates, when) : 0;
      let n = 0;
      for (const l of inLines) {
        n++;
        const p = await getDoc('products', clean(l.productId, 60));
        if (!p || p.entityId !== ctx.entityId) throw new Reject(400, `Line ${n}: that product is not known here.`);
        const v = l.variantId ? await getDoc('variants', clean(l.variantId, 60)) : null;
        if (l.variantId && (!v || v.productId !== p.id)) throw new Reject(400, `Line ${n}: that variant is not known.`);
        const qty = int(l.qty); if (!(qty >= 1) || qty > 100) throw new Reject(400, `Line ${n}: the quantity is wrong.`);
        if (p.type === 'mto') throw new Reject(400, 'A made-to-order item cannot be returned without its receipt.');
        const unit = await priceOf(ctx, p, v); const lr = rateFor(p.vatClass || 'standard', rateBp, !!ctx.entity.vatRegistered);
        const net = qty * unit, vatR = vatIn(net, lr);
        const disposition = DISPOSITIONS.includes(l.disposition) ? l.disposition : 'quarantine';
        lines.push({ saleLineNo: 0, productId: p.id, variantId: v ? v.id : '', itemId: v ? v.id : p.id, name: p.name + (v ? ' · ' + v.name : ''), qty, soldQty: 0, unitPaidCents: unit, lineTotalCents: net, vatRateBp: lr, vatCents: vatR, reason: clean(l.reason, 80) || 'Other', disposition, type: p.type || 'stock', fulfilment: 'stock' });
        total += net; vat += vatR;
        if (p.trackStock !== false && p.type === 'stock' && disposition !== 'writeoff') moves.push({ productId: p.id, variantId: v ? v.id : '', itemId: v ? v.id : p.id, qty, bucket: disposition === 'quarantine' ? 'quarantine' : 'onHand', reason: 'creditNote', unitCostCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0, name: p.name });
      }
    }
    if (!(total > 0)) throw new Reject(400, 'The credit comes to nothing.');

    // ---- how the money goes back: refunds, or the credit on an exchange's new sale, or both
    const refundsIn = Array.isArray(b.refunds) ? b.refunds : [];
    const refunds = [];
    let refunded = 0, creditToCustomer = 0;
    for (const r of refundsIn) {
      const method = clean(r.method, 20); const amount = int(r.amountCents);
      if (!REFUND_METHODS.includes(method)) throw new Reject(400, `${method || 'That'} is not a refund method.`);
      if (!(amount > 0)) throw new Reject(400, 'A refund must be more than nothing.');
      if (method !== 'storeCredit' && !(ctx.store.paymentMethods || []).includes(method)) throw new Reject(400, `${method} is not used at this store.`);
      if (method === 'storeCredit') { if (!customer) throw new Reject(400, 'Store credit needs the customer on the credit note.'); creditToCustomer += amount; }
      if (b.noReceipt && method !== 'storeCredit') throw new Reject(400, 'Without a receipt the refund is store credit only.');
      refunds.push({ method, amountCents: amount, ref: clean(r.ref, 60) }); refunded += amount;
    }
    let exchangePrep = null, exchangeSaleId = '';
    if (b.exchange) {
      exchangeSaleId = clean(b.exchange.saleId, 80);
      if (!/^[\w:.-]{8,80}$/.test(exchangeSaleId)) throw new Reject(400, 'The exchange sale has no id.');
      if (await getDoc('sales', exchangeSaleId)) throw new Reject(409, 'That exchange was already written.');
      const body = { ...b.exchange, customerId: b.exchange.customerId || (customer ? customer.id : ''), exchangeOf: 'pending' };
      exchangePrep = await prepareSale(ctx, body, { creditNote: { docNo: 'pending', amountCents: total } });
      b.exchange = body;
    }
    const usedOnExchange = exchangePrep ? Math.min(total, exchangePrep.total) : 0;
    if (refunded + usedOnExchange !== total) throw new Reject(400, `The refunds (${refunded}) and the exchange (${usedOnExchange}) do not add up to the credit (${total}).`);

    // ---- in one transaction: the number, the credit note, refunds, stock, the customer, and the exchange's sale
    const id = creditId;
    const result = await runSale(ctx, b.exchange || {}, {
      saleId: exchangeSaleId, prep: exchangePrep,
      more: async (tx, levels) => {
        const num = await nextFromCounter(tx, ctx, 'CN', ctx.entity.creditNotePrefix || (ctx.entity.invoicePrefix + '-CN'));
        for (const m of moves) { const lid = ctx.storeId + '_' + m.itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); }
        const now = nowIso();
        const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
        const writes = [num.write];
        const note = {
          series: 'CN', seq: num.seq, docNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '',
          saleId: sale ? sale.id : '', saleDocNo: sale ? sale.docNo : '', noReceipt: !!b.noReceipt,
          customerId: customer ? customer.id : (sale ? sale.customerId || '' : ''), customerSnapshot: customer ? { name: customer.name, phone: customer.phone || '', vatNo: customer.vatNo || '', address: customer.address || {} } : (sale ? sale.customerSnapshot : null),
          lines, lineCount: lines.length, totalCents: total, vatCents: vat, vatRegistered: !!ctx.entity.vatRegistered, vatRateBp: sale ? sale.vatRateBp || 0 : (ctx.entity.vatRegistered ? rateOn((ctx.settings.vat || {}).rates, when) : 0),
          refunds, refundedCents: refunded, exchangeSaleId, exchangeUsedCents: usedOnExchange,
          cashierUid: ctx.user.id, cashierName: ctx.user.name, approvers: [...approvers].map(([uid, name]) => ({ uid, name })),
          reasonSummary: [...new Set(lines.map(l => l.reason))].join(', '), clientCreatedAt: when, verified: true, ...stamp, serverReceivedAt: now
        };
        writes.push({ create: true, coll: 'creditNotes', id, data: note });
        // the money back: a refund row and a negative payment, so the shift's figures stay right
        for (const r of refunds) {
          writes.push({ create: true, coll: 'refunds', id: randomId('rf_'), data: { creditNoteId: id, creditNoteDocNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...r, ...stamp, serverReceivedAt: now } });
          writes.push({ create: true, coll: 'payments', id: randomId('pay_'), data: { docType: 'refund', docId: id, docNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', method: r.method, amountCents: -r.amountCents, ref: r.ref, status: 'paid', ...stamp, serverReceivedAt: now } });
        }
        if (customer && creditToCustomer) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) + creditToCustomer, updatedAt: now, updatedBy: 'server' } });
        for (const m of moves) writes.push(...moveWrites(ctx, levels, m, { docType: 'creditNote', docId: id, docNo: num.docNo }, stamp, now));
        writes.push({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action: exchangePrep ? 'return.exchange' : 'return.creditNote', docType: 'creditNote', docId: id, docNo: num.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...approvers.keys()][0] || '', overrideName: [...approvers.values()][0] || '', details: { saleDocNo: note.saleDocNo, totalCents: total, lines: lines.length, methods: refunds.map(r => r.method), dispositions: [...new Set(lines.map(l => l.disposition))], noReceipt: !!b.noReceipt }, ...stamp, serverReceivedAt: now } });
        // the exchange's sale and its credit-note tender carry the note's number
        if (exchangePrep) { exchangePrep.pays.filter(p => p.method === 'creditNote').forEach(p => { p.ref = num.docNo; }); b.exchange.exchangeOf = num.docNo; }
        return { writes, result: { creditNote: { id, ...note }, refunds } };
      }
    });
    // a made-to-order line credited: the sales order's line is off, and its factory order called off when the whole line is back
    if (sale && lines.some(l => l.type === 'mto')) {
      const so = await getDoc('salesOrders', sale.id);
      if (so) {
        const soLines = (so.lines || []).map(l => { const hit = lines.find(x => x.type === 'mto' && x.saleLineNo === l.lineNo); return hit ? { ...l, cancelledQty: Math.min(l.qty, (l.cancelledQty || 0) + hit.qty) } : l; });
        const allOff = soLines.every(l => (l.cancelledQty || 0) >= l.qty);
        const now = nowIso(), cn = result.creditNote.docNo;
        const patch = { lines: soLines, updatedAt: now, ...(allOff && so.status !== 'cancelled' ? { status: 'cancelled', cancelledAt: now, cancelReason: 'Credit note ' + cn, statusHistory: [...(so.statusHistory || []), { status: 'cancelled', at: now, byName: ctx.user.name, source: 'till', note: 'Credit note ' + cn }].slice(-50), updateDue: true } : {}) };
        await patchDoc('salesOrders', sale.id, patch);
        const off = ((so.factory || {}).orders || []).filter(o => soLines.some(l => l.lineNo === o.lineNo && (l.cancelledQty || 0) >= l.qty && !((so.lines || []).find(x => x.lineNo === l.lineNo) || {}).cancelledQty));
        if (off.length) await cancelAtFactory(ctx, 'salesOrders', { ...so, ...patch, id: sale.id }, off, 'Credit note ' + cn);
        result.salesOrder = { ...so, ...patch, id: sale.id };
      }
    }
    return result;
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
    console.error('pos-return failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};
