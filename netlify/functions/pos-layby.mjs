// Retail POS — lay-bys under section 62 of the Consumer Protection Act
// (pos/js/layby-terms.js has the rules). Only this function writes laybys.
//
//   open      { laybyId, customerId (required), lines, saleDiscountCents…, totals, termDays?, frequency?,
//               deposit: [ tenders ], agreement: { accepted: true, signedBy, signature (PNG data URL) }, clientCreatedAt, + where }
//             → the lay-by numbered LB from the entity's counter, its stock reserved, the deposit as payments
//   pay       { laybyId, paymentId, tenders, clientCreatedAt, + where }      an instalment, at any till of the company
//   complete  { laybyId, saleId, + where }                                  balance nil, at the lay-by's store: the tax invoice
//             is written as a sale paid by the lay-by; the reserved stock goes out
//   cancel    { laybyId, kind, reason, refunds: [ { method, amountCents, ref } ], approvalToken? }
//             a supervisor; waiving the penalty (death, hospitalisation, our fault) a manager
//   remind    { laybyId, kind: 'due'|'overdue'|'ready', how: 'whatsapp'|'phone'|'email' } → the message, logged on the lay-by
//   report    { from, to }   supervisor and up: open, behind, overdue; opened, collected, cancelled in the period; money taken
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, patchDoc, serverStamp, bodyOf, audit, withGroup } from './lib/pos.mjs';
import { whoAndWhere, prepareSale, prepareTenders, runSale, nextFromCounter, moveWrites, approved, int } from './lib/sale.mjs';
import { pctOf } from '../../pos/js/money.js';
import { laybySettings, schedule, dueDate, expectedBy, penaltyFor, agreementText, reminderText, CANCEL_KINDS, NO_PENALTY, PENALTY_CAP_PCT, FREQ } from '../../pos/js/layby-terms.js';

const REFUND_METHODS = ['cash', 'card', 'eft', 'storeCredit'];
const NOW_METHODS = ['cash', 'card', 'eft', 'qr', 'storeCredit'];   // money in hand today: no vouchers, no account, no awaiting EFT
const money = (c) => 'R ' + (c / 100).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
const idOk = (id) => /^[\w:.-]{8,80}$/.test(id);

async function loadLayby(ctx, id) {
  id = clean(id, 80);
  const lb = await getDoc('laybys', id);
  if (!lb || lb.entityId !== ctx.entityId) throw new Reject(404, 'No such lay-by here.');
  return { ...lb, id };
}
// the tenders of a deposit or instalment: real money now
function moneyNow(ctx, tenders, total, customer) {
  const t = prepareTenders(ctx, tenders, { total, customer, partial: true });
  if (!(t.paid > 0)) throw new Reject(400, 'How much is being paid?');
  const bad = t.pays.find(p => !NOW_METHODS.includes(p.method) || p.status === 'awaiting');
  if (bad) throw new Reject(400, 'Pay a lay-by with cash, card, EFT, QR or store credit, received now.');
  return t;
}
const payRows = (ctx, lb, pays, instalment, firstId, stamp, now) => pays.map((p, i) => ({ create: true, coll: 'payments', id: i === 0 && firstId ? firstId : randomId('pay_'), data: { docType: 'layby', docId: lb.id, docNo: lb.docNo, instalment, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...p, ...stamp, serverReceivedAt: now } }));
// what reserving the goods, or releasing them, moves
const reserveMoves = (moves, sign) => moves.map(m => ({ ...m, qty: sign * Math.abs(m.qty), bucket: 'reserved', reason: 'layby' }));
async function levelsFor(tx, ctx, levels, moves) { for (const m of moves) { const lid = ctx.storeId + '_' + m.itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); } }
const auditRow = (ctx, action, lb, details, approvers, stamp, now) => ({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action, docType: 'layby', docId: lb.id, docNo: lb.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...approvers.keys()][0] || '', overrideName: [...approvers.values()][0] || '', details, ...stamp, serverReceivedAt: now } });

const actions = {
  async open(event, b) {
    const ctx = await whoAndWhere(event, b);
    const ls = laybySettings(ctx.settings);
    const id = clean(b.laybyId, 80);
    if (!idOk(id)) throw new Reject(400, 'The lay-by has no id.');
    const had = await getDoc('laybys', id);
    if (had) return { ok: true, layby: { ...had, id }, again: true };
    if (!b.customerId) throw new Reject(400, 'A lay-by needs the customer: add them to the sale first.');
    const prep = await prepareSale(ctx, b, { noTenders: true });
    const bad = prep.lines.find(l => l.type === 'mto' || l.type === 'voucher');
    if (bad) throw new Reject(400, `${bad.name}: ${bad.type === 'mto' ? 'made-to-order goods go on a special order' : 'a gift voucher cannot go on lay-by'}.`);
    if (!(prep.total > 0)) throw new Reject(400, 'The lay-by comes to nothing.');
    const minDeposit = pctOf(prep.total, ls.minDepositPct);
    const termDays = Math.min(ls.termDays, Math.max(7, int(b.termDays) || ls.termDays));
    const frequency = FREQ[b.frequency] ? b.frequency : ls.frequency;
    const dep = moneyNow(ctx, b.deposit, prep.total, prep.customer);
    if (dep.paid < minDeposit) throw new Reject(400, `The deposit must be at least ${ls.minDepositPct}% of the price: ${money(minDeposit)}.`);
    const ag = b.agreement || {};
    const signedBy = clean(ag.signedBy, 120);
    if (!ag.accepted || !signedBy) throw new Reject(400, 'The customer must read and sign the lay-by agreement.');
    const signature = String(ag.signature || '').slice(0, 200000);
    if (signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new Reject(400, 'The signature is not a PNG.');
    const customer = prep.customer;
    const openedAt = prep.when;
    const balance = prep.total - dep.paid;
    const sched = schedule(balance, openedAt, termDays, frequency);
    const reserve = reserveMoves(prep.moves, 1);

    const r = await runSale(ctx, {}, { more: async (tx, levels) => {
      const num = await nextFromCounter(tx, ctx, 'LB', ctx.entity.laybyPrefix || (ctx.entity.invoicePrefix + '-LB'));
      await levelsFor(tx, ctx, levels, reserve);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const lb = {
        id, series: 'LB', seq: num.seq, docNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '',
        customerId: customer.id, customerSnapshot: { name: customer.name, phone: customer.phone || '', email: customer.email || '', vatNo: customer.vatNo || '', address: customer.address || {} },
        lines: prep.lines, lineCount: prep.lines.length, subtotalCents: prep.gross, lineDiscountCents: prep.lineDisc, saleDiscountCents: prep.saleDisc, saleDiscountPct: Number(b.saleDiscountPct) || 0, saleDiscountReason: clean(b.saleDiscountReason, 120),
        totalCents: prep.total, vatCents: prep.vat, vatRateBp: prep.rateBp, vatRegistered: !!ctx.entity.vatRegistered,
        minDepositPct: ls.minDepositPct, minDepositCents: minDeposit, depositCents: dep.paid, paidCents: dep.paid, balanceCents: balance, paymentCount: 1, lastPaidAt: now,
        history: [{ n: 0, at: now, amountCents: dep.paid, methods: dep.pays.map(p => p.method), storeId: ctx.storeId, byName: ctx.user.name }],
        termDays, frequency, openedAt, dueAt: dueDate(openedAt, termDays), schedule: sched,
        penaltyPct: ls.penaltyPct, penaltyCapCents: pctOf(prep.total, PENALTY_CAP_PCT),
        status: 'open', reminders: [], lastReminderAt: '', completedAt: '', completedSaleId: '', completedDocNo: '', cancelledAt: '', cancelKind: '', cancelReason: '', penaltyCents: 0, penaltyBreakdown: null, refunds: [], refundedCents: 0,
        cashierUid: ctx.user.id, cashierName: ctx.user.name, approvers: [...prep.approvers].map(([uid, name]) => ({ uid, name })), note: clean(b.note, 300),
        ...stamp, serverReceivedAt: now, updatedAt: now
      };
      lb.agreement = { text: agreementText(ctx.entity, lb), acceptedAt: now, signedBy, signature, cashierUid: ctx.user.id, cashierName: ctx.user.name };
      const { id: _id, ...data } = lb;
      const writes = [num.write, { create: true, coll: 'laybys', id, data }];
      writes.push(...payRows(ctx, lb, dep.pays, 0, '', stamp, now));
      for (const m of reserve) writes.push(...moveWrites(ctx, levels, m, { docType: 'layby', docId: id, docNo: num.docNo }, stamp, now));
      if (dep.creditUsed) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) - dep.creditUsed, updatedAt: now } });
      writes.push(auditRow(ctx, 'layby.open', lb, { totalCents: prep.total, depositCents: dep.paid, termDays, frequency, lines: prep.lines.length, methods: dep.pays.map(p => p.method) }, prep.approvers, stamp, now));
      return { writes, result: { layby: lb, payments: dep.pays } };
    } });
    return r;
  },

  // an instalment: at any till of the company (the till's shift takes the money)
  async pay(event, b) {
    const ctx = await whoAndWhere(event, b);
    const lb = await loadLayby(ctx, b.laybyId);
    if (lb.status !== 'open') throw new Reject(409, `Lay-by ${lb.docNo} is ${lb.status}.`);
    const payId = clean(b.paymentId, 80);
    if (!idOk(payId)) throw new Reject(400, 'The payment has no id.');
    const had = await getDoc('payments', payId);
    if (had && (had.entityId !== ctx.entityId || had.docId !== lb.id)) throw new Reject(403, 'That payment id belongs elsewhere.');
    if (had) return { ok: true, layby: lb, payments: [had], again: true };
    const customer = lb.customerId ? await getDoc('customers', lb.customerId) : null;
    const t = moneyNow(ctx, b.tenders, lb.balanceCents, customer);
    const r = await runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('laybys', lb.id, tx);
      if (!cur || cur.status !== 'open') throw new Reject(409, `Lay-by ${lb.docNo} is no longer open.`);
      if (t.paid > cur.balanceCents) throw new Reject(400, `Only ${money(cur.balanceCents)} is still owed.`);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const instalment = (cur.paymentCount || 0);
      const patch = { paidCents: cur.paidCents + t.paid, balanceCents: cur.balanceCents - t.paid, paymentCount: instalment + 1, lastPaidAt: now, updatedAt: now, history: [...(cur.history || []), { n: instalment, at: now, amountCents: t.paid, methods: t.pays.map(p => p.method), storeId: ctx.storeId, byName: ctx.user.name }].slice(-100) };
      const writes = [{ update: true, coll: 'laybys', id: lb.id, data: patch }];
      writes.push(...payRows(ctx, lb, t.pays, instalment, payId, stamp, now));
      if (t.creditUsed) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) - t.creditUsed, updatedAt: now } });
      writes.push(auditRow(ctx, 'layby.pay', lb, { amountCents: t.paid, instalment, methods: t.pays.map(p => p.method), balanceCents: patch.balanceCents }, new Map(), stamp, now));
      return { writes, result: { layby: { ...cur, ...patch, id: lb.id }, payments: t.pays, instalment, paidAt: now } };
    } });
    return r;
  },

  // the goods go out: a sale paid by the lay-by, so the tax invoice is issued and the stock moves
  async complete(event, b) {
    const ctx = await whoAndWhere(event, b);
    const lb = await loadLayby(ctx, b.laybyId);
    if (lb.status === 'completed' && lb.completedSaleId) { const sale = await getDoc('sales', lb.completedSaleId); return { ok: true, again: true, layby: lb, sale: sale ? { ...sale, id: lb.completedSaleId } : null, lines: await query('saleLines', [{ field: 'saleId', value: lb.completedSaleId }], 500, { field: 'lineNo' }), payments: [] }; }
    if (lb.status !== 'open') throw new Reject(409, `Lay-by ${lb.docNo} is ${lb.status}.`);
    if (lb.balanceCents > 0) throw new Reject(400, `${money(lb.balanceCents)} is still owed on ${lb.docNo}.`);
    if (lb.storeId !== ctx.storeId) { const st = await getDoc('stores', lb.storeId); throw new Reject(400, `Lay-by ${lb.docNo} is collected at ${st ? st.name : lb.storeId}, where its goods are reserved.`); }
    const saleId = clean(b.saleId, 80);
    if (!idOk(saleId)) throw new Reject(400, 'The sale has no id.');
    const body = {
      clientCreatedAt: nowIso(), customerId: lb.customerId, laybyOf: lb.docNo, note: 'Lay-by ' + lb.docNo + (lb.note ? ' · ' + lb.note : ''),
      lines: lb.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, note: l.note, custom: l.custom, name: l.name, vatClass: l.vatClass })),
      saleDiscountCents: lb.saleDiscountCents, saleDiscountPct: lb.saleDiscountPct, saleDiscountReason: lb.saleDiscountReason, tenders: []
    };
    const prep = await prepareSale(ctx, body, { trusted: 'Lay-by ' + lb.docNo, prepaid: { method: 'layby', docNo: lb.docNo, amountCents: lb.totalCents } });
    if (prep.total !== lb.totalCents) throw new Reject(409, `The lay-by's price (${money(lb.totalCents)}) and the sale's (${money(prep.total)}) differ.`);
    const release = reserveMoves(prep.moves, -1);
    const r = await runSale(ctx, body, { saleId, prep, more: async (tx, levels) => {
      const cur = await getDoc('laybys', lb.id, tx);
      if (!cur || cur.status !== 'open' || cur.balanceCents > 0) throw new Reject(409, `Lay-by ${lb.docNo} is no longer ready to collect.`);
      await levelsFor(tx, ctx, levels, release);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      for (const m of release) writes.push(...moveWrites(ctx, levels, m, { docType: 'layby', docId: lb.id, docNo: lb.docNo }, stamp, now));
      const patch = { status: 'completed', completedAt: now, completedSaleId: saleId, completedByUid: ctx.user.id, completedByName: ctx.user.name, updatedAt: now };
      writes.push({ update: true, coll: 'laybys', id: lb.id, data: patch });
      writes.push(auditRow(ctx, 'layby.complete', lb, { saleId, totalCents: lb.totalCents }, new Map(), stamp, now));
      return { writes, result: { layby: { ...cur, ...patch, id: lb.id } } };
    } });
    if (r.sale && r.sale.docNo) { await patchDoc('laybys', lb.id, { completedDocNo: r.sale.docNo }); r.layby.completedDocNo = r.sale.docNo; }
    return r;
  },

  // cancelled: the penalty the agreement disclosed (never over 1%, never on death or hospitalisation), the rest refunded, the stock released
  async cancel(event, b) {
    const ctx = await whoAndWhere(event, b);
    const lb = await loadLayby(ctx, b.laybyId);
    if (lb.status !== 'open') throw new Reject(409, `Lay-by ${lb.docNo} is ${lb.status}.`);
    const kind = CANCEL_KINDS.some(k => k[0] === b.kind) ? b.kind : 'customer';
    const approvers = new Map();
    const need = (minRole, what) => { const a = approved(ctx, b.approvalToken, 'layby', minRole, what); if (!a.self) approvers.set(a.uid, a.name); };
    need('supervisor', 'Cancelling a lay-by');
    if (NO_PENALTY.includes(kind)) need('manager', 'Waiving the cancellation penalty');
    if (kind === 'lapsed' && lb.dueAt >= today()) throw new Reject(400, `Lay-by ${lb.docNo} is only due by ${lb.dueAt}.`);
    const pen = penaltyFor(lb, kind);
    const refunds = (Array.isArray(b.refunds) ? b.refunds : []).map(r => ({ method: clean(r.method, 20), amountCents: int(r.amountCents), ref: clean(r.ref, 60) }));
    for (const r of refunds) { if (!REFUND_METHODS.includes(r.method)) throw new Reject(400, `${r.method || 'That'} is not a refund method.`); if (!(r.amountCents > 0)) throw new Reject(400, 'A refund must be more than nothing.'); }
    const refunded = refunds.reduce((n, r) => n + r.amountCents, 0);
    if (refunded !== pen.refundCents) throw new Reject(400, `The refunds (${money(refunded)}) must equal what is owed back: ${money(pen.refundCents)} (paid ${money(lb.paidCents)} less the penalty ${money(pen.chargedCents)}).`);
    const customer = lb.customerId ? await getDoc('customers', lb.customerId) : null;
    const credit = refunds.filter(r => r.method === 'storeCredit').reduce((n, r) => n + r.amountCents, 0);
    if (credit && !customer) throw new Reject(400, 'Store credit needs the customer.');
    const release = reserveMoves(lb.lines.filter(l => l.trackStock && l.itemId).map(l => ({ productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: -l.qty, unitCostCents: l.costCents, name: l.name })), -1);
    // bundles reserved their parts: release what the opening reserved, read from its movements
    const reservedMoves = await query('stockMovements', [{ field: 'docType', value: 'layby' }, { field: 'docId', value: lb.id }, { field: 'bucket', value: 'reserved' }], 200);
    const toRelease = reservedMoves.length ? reservedMoves.filter(m => m.qty > 0).map(m => ({ productId: m.productId, variantId: m.variantId, itemId: m.variantId || m.productId, qty: -m.qty, unitCostCents: m.unitCostCents || 0, name: m.note || '', bucket: 'reserved', reason: 'layby' })) : release;
    const r = await runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('laybys', lb.id, tx);
      if (!cur || cur.status !== 'open' || cur.paidCents !== lb.paidCents) throw new Reject(409, `Lay-by ${lb.docNo} changed meanwhile: look again.`);
      await levelsFor(tx, ctx, levels, toRelease);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      for (const m of toRelease) writes.push(...moveWrites(ctx, levels, m, { docType: 'layby', docId: lb.id, docNo: lb.docNo }, stamp, now));
      const patch = { status: 'cancelled', cancelledAt: now, cancelKind: kind, cancelReason: clean(b.reason, 200), penaltyCents: pen.chargedCents, penaltyBreakdown: pen, refunds, refundedCents: refunded, cancelledByUid: ctx.user.id, cancelledByName: ctx.user.name, approvers: [...approvers].map(([uid, name]) => ({ uid, name })), updatedAt: now };
      writes.push({ update: true, coll: 'laybys', id: lb.id, data: patch });
      for (const rf of refunds) {
        writes.push({ create: true, coll: 'refunds', id: randomId('rf_'), data: { laybyId: lb.id, laybyDocNo: lb.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...rf, ...stamp, serverReceivedAt: now } });
        writes.push({ create: true, coll: 'payments', id: randomId('pay_'), data: { docType: 'refund', docId: lb.id, docNo: lb.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', method: rf.method, amountCents: -rf.amountCents, ref: rf.ref, status: 'paid', ...stamp, serverReceivedAt: now } });
      }
      if (credit) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) + credit, updatedAt: now } });
      writes.push(auditRow(ctx, 'layby.cancel', lb, { kind, penaltyCents: pen.chargedCents, refundedCents: refunded, methods: refunds.map(x => x.method) }, approvers, stamp, now));
      return { writes, result: { layby: { ...cur, ...patch, id: lb.id }, breakdown: pen, refunds } };
    } });
    return r;
  },

  // a reminder: the words to send, and a note on the lay-by that it was sent
  async remind(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const lb = await loadLayby(ctx, b.laybyId);
    if (lb.status !== 'open') throw new Reject(409, `Lay-by ${lb.docNo} is ${lb.status}.`);
    const kind = ['due', 'overdue', 'ready'].includes(b.kind) ? b.kind : (lb.balanceCents <= 0 ? 'ready' : lb.paidCents < expectedBy(lb, today()) || lb.dueAt < today() ? 'overdue' : 'due');
    const how = ['whatsapp', 'phone', 'email'].includes(b.how) ? b.how : 'whatsapp';
    const text = reminderText(ctx.entity, ctx.store, lb, kind);
    const now = nowIso();
    const entry = { at: now, kind, how, byUid: ctx.user.id, byName: ctx.user.name };
    await patchDoc('laybys', lb.id, { reminders: [...(lb.reminders || []), entry].slice(-50), lastReminderAt: now, updatedAt: now });
    await audit({ action: 'layby.remind', docType: 'layby', docId: lb.id, docNo: lb.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, details: { kind, how }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, text, kind, how, phone: lb.customerSnapshot.phone || '', email: lb.customerSnapshot.email || '', reminder: entry };
  },

  // the lay-by report for the store: supervisors and up
  async report(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, '', 'layby', 'supervisor', 'The lay-by report');
    const from = clean(b.from, 10) || '0000-00-00', to = clean(b.to, 10) || '9999-12-31';
    const all = await query('laybys', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }], 2000);
    const day = today();
    const open = all.filter(l => l.status === 'open');
    const sum = (rows, f) => rows.reduce((n, l) => n + (l[f] || 0), 0);
    const behind = open.filter(l => l.balanceCents > 0 && l.paidCents < expectedBy(l, day) && l.dueAt >= day);
    const overdue = open.filter(l => l.balanceCents > 0 && l.dueAt < day);
    const ready = open.filter(l => l.balanceCents <= 0);
    const inRange = (iso) => { const d = String(iso || '').slice(0, 10); return d >= from && d <= to; };
    const opened = all.filter(l => inRange(l.openedAt)), completed = all.filter(l => l.status === 'completed' && inRange(l.completedAt)), cancelled = all.filter(l => l.status === 'cancelled' && inRange(l.cancelledAt));
    const pays = (await query('payments', [{ field: 'entityId', value: ctx.entityId }, { field: 'docType', value: 'layby' }], 5000)).filter(p => inRange(p.createdAt));
    const here = pays.filter(p => p.storeId === ctx.storeId);
    const byMethod = {}; for (const p of here) byMethod[p.method] = (byMethod[p.method] || 0) + p.amountCents;
    const ids = new Set(all.map(l => l.id));
    const onOurs = pays.filter(p => ids.has(p.docId)).reduce((n, p) => n + p.amountCents, 0);
    const row = (l) => ({ id: l.id, docNo: l.docNo, customer: l.customerSnapshot ? l.customerSnapshot.name : '', phone: l.customerSnapshot ? l.customerSnapshot.phone : '', openedAt: l.openedAt, dueAt: l.dueAt, totalCents: l.totalCents, paidCents: l.paidCents, balanceCents: l.balanceCents, expectedCents: expectedBy(l, day), status: l.status, state: l.status !== 'open' ? l.status : l.balanceCents <= 0 ? 'ready' : l.dueAt < day ? 'overdue' : l.paidCents < expectedBy(l, day) ? 'behind' : 'on track', lastReminderAt: l.lastReminderAt || '', penaltyCents: l.penaltyCents || 0, refundedCents: l.refundedCents || 0 });
    return {
      ok: true, from, to, at: nowIso(),
      open: { count: open.length, valueCents: sum(open, 'totalCents'), paidCents: sum(open, 'paidCents'), balanceCents: sum(open, 'balanceCents') },
      ready: { count: ready.length, valueCents: sum(ready, 'totalCents') },
      behind: { count: behind.length, balanceCents: sum(behind, 'balanceCents') }, overdue: { count: overdue.length, balanceCents: sum(overdue, 'balanceCents') },
      opened: { count: opened.length, valueCents: sum(opened, 'totalCents') }, completed: { count: completed.length, valueCents: sum(completed, 'totalCents') },
      cancelled: { count: cancelled.length, valueCents: sum(cancelled, 'totalCents'), penaltyCents: sum(cancelled, 'penaltyCents'), refundedCents: sum(cancelled, 'refundedCents') },
      takenHereCents: here.reduce((n, p) => n + p.amountCents, 0), takenHereByMethod: byMethod, paidOnOursCents: onOurs,
      rows: open.map(row).sort((x, y) => x.dueAt.localeCompare(y.dueAt)), closed: [...completed, ...cancelled].map(row)
    };
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
    console.error('pos-layby failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};

// every request works in its own customer's space (lib/pos.mjs)
export const handler = withGroup(handleRequest);
