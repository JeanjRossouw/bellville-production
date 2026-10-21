// Retail POS — a sale becomes real here (pos/DATA-MODEL.md, "How a sale is written").
// The arithmetic and the writes live in lib/sale.mjs, shared with pos-return.
//
//   commit     { saleId, entityId, storeId, registerId, deviceId?, secret?, clientCreatedAt, seq?,
//                customerId, lines [ { productId, variantId, qty, unitPriceCents, priceOverride?, discountCents, discountPct, discountReason, discountToken?, note, custom?, name?, vatClass? } ],
//                saleDiscountCents, saleDiscountPct, saleDiscountReason, saleDiscountToken?, note,
//                totals { totalCents, vatCents },   the till's own sums, which must agree
//                tenders [ { method, amountCents, tenderedCents?, ref?, cardLast4?, approvalCode?, status?, voucherCode? } ] }
//   blocks     { deviceId, secret } | (login) → the till's open number blocks, the next issued early when few remain
//   voidNumber { seq, reason }   a number taken offline for a sale that was then refused
//   voucher    { code, entityId } → { balanceCents, status }
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, nowIso, getDoc, query, commit, beginTransaction, rollback, serverStamp, createDoc, patchDoc, bodyOf } from './lib/pos.mjs';
import { whoAndWhere, prepareSale, runSale, int, pad6, blockId, BLOCK_SIZE_DEFAULT } from './lib/sale.mjs';

const actions = {
  async commit(event, b) {
    const ctx = await whoAndWhere(event, b);
    const saleId = clean(b.saleId, 80);
    if (!/^[\w:.-]{8,80}$/.test(saleId)) throw new Reject(400, 'The sale has no id.');
    // the same sale again (a resend after a dropped line): the first answer stands
    const had = await getDoc('sales', saleId);
    if (had) return { ok: true, sale: had, again: true, lines: await query('saleLines', [{ field: 'saleId', value: saleId }], 500, { field: 'lineNo' }) };
    const prep = await prepareSale(ctx, b);
    return runSale(ctx, b, { saleId, prep });
  },

  // the till's open blocks for a series; one is issued when it has none, and the next
  // one early when fewer than the refill mark remain, so it always has spare numbers offline
  async blocks(event, b) {
    const ctx = await whoAndWhere(event, b);
    const size = Math.max(10, Math.min(500, int((ctx.settings.numbering || {}).blockSize) || BLOCK_SIZE_DEFAULT));
    const refill = Math.max(1, int((ctx.settings.numbering || {}).refillBelow) || 10);
    const out = {};
    for (const series of ['INV']) {
      for (let round = 0; round < 2; round++) {
        const open = (await query('numberBlocks', [{ field: 'entityId', value: ctx.entityId }, { field: 'series', value: series }, { field: 'deviceId', value: ctx.deviceId }, { field: 'closedAt', value: '' }], 10)).filter(r => (r.usedUpTo || r.from - 1) < r.to).sort((x, y) => x.from - y.from);
        const left = open.reduce((n, r) => n + (r.to - r.usedUpTo), 0);
        if (open.length && left >= refill) break;
        const tx = await beginTransaction();
        try {
          const key = ctx.entityId + '_' + series;
          const counter = await getDoc('counters', key, tx);
          const from = counter ? counter.next : 1, to = from + size - 1;
          const block = { id: blockId(ctx.entityId, series, ctx.deviceId, from), series, deviceId: ctx.deviceId, registerId: ctx.registerId || '', from, to, usedUpTo: from - 1, issuedAt: nowIso(), closedAt: '', ...serverStamp(ctx.entityId, ctx.storeId, 'server', ctx.deviceId) };
          await commit([{ create: true, coll: 'numberBlocks', id: block.id, data: block }, { set: true, coll: 'counters', id: key, data: { entityId: ctx.entityId, series, next: to + 1, ...(counter ? {} : serverStamp(ctx.entityId, '', 'server')) } }], tx);
        } catch (e) { await rollback(tx); if (!(e instanceof Reject)) throw e; }
      }
      const list = (await query('numberBlocks', [{ field: 'entityId', value: ctx.entityId }, { field: 'series', value: series }, { field: 'deviceId', value: ctx.deviceId }, { field: 'closedAt', value: '' }], 10)).filter(r => (r.usedUpTo || r.from - 1) < r.to).sort((x, y) => x.from - y.from).map(r => ({ id: r.id, from: r.from, to: r.to, usedUpTo: r.usedUpTo }));
      out[series] = { ...list[0], prefix: ctx.entity.invoicePrefix, list };
    }
    return { ok: true, blocks: out, deviceId: ctx.deviceId };
  },

  // a number the till took offline for a sale the server then refused: recorded as void, so the series has no gap
  async voidNumber(event, b) {
    const ctx = await whoAndWhere(event, b);
    const seq = int(b.seq); const reason = clean(b.reason, 160) || 'refused';
    if (!(seq > 0)) throw new Reject(400, 'Which number?');
    const blocks = await query('numberBlocks', [{ field: 'entityId', value: ctx.entityId }, { field: 'series', value: 'INV' }, { field: 'deviceId', value: ctx.deviceId }], 50);
    const block = blocks.find(r => seq >= r.from && seq <= r.to);
    if (!block) throw new Reject(400, `Number ${seq} is not in this till’s blocks.`);
    if ((await query('sales', [{ field: 'entityId', value: ctx.entityId }, { field: 'seq', value: seq }], 1)).length) throw new Reject(409, `Number ${seq} belongs to a written sale.`);
    const id = ctx.entityId + '_INV_' + seq;
    const made = await createDoc('voidedNumbers', id, { series: 'INV', seq, docNo: ctx.entity.invoicePrefix + '-' + pad6(seq), blockId: block.id, reason, ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) });
    if (seq > (block.usedUpTo || 0)) await patchDoc('numberBlocks', block.id, { usedUpTo: seq });
    return { ok: true, voided: made, seq };
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
