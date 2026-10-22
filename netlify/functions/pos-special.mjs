// Retail POS — special orders for made-to-order goods (pos/js/special-terms.js
// has the rules). Only this function writes specialOrders.
//
//   open      { orderId, customerId (required), lines [ sale lines + spec { model, size, fabric, colour, legs, notes, photo } ],
//               saleDiscountCents…, totals, deposit: [ tenders ] | [], signoff: { accepted, signedBy, signature }, expectedAt?, clientCreatedAt, + where }
//             → status 'quoted', or 'depositPaid' when the deposit meets the minimum
//   pay       { orderId, paymentId, tenders, clientCreatedAt, + where }     a deposit or the balance, at any till
//   status    { orderId, status: 'inProduction'|'ready', note, factoryRef?, expectedAt? }   a supervisor or higher at the till
//   update    { orderId, status?, how }                                     → the WhatsApp text for the status, logged
//   book      { orderId, kind: 'deliver'|'collect', date, slot, address, phone, note, driverName }
//   deliver   { orderId, saleId, signedBy, signature, note, + where }       balance nil: the tax invoice written as a sale
//             paid by the special order; the signed delivery note kept; status delivered or collected
//   cancel    { orderId, kind, reason, feeCents, refunds: [ { method, amountCents, ref } ], approvalToken? }   a manager
//
// The factory (Factory Manager, the same Firebase project): once the deposit
// is paid the server writes the order into the linked factory company's own
// orders, with the store as the customer — no retail customer goes across —
// and reads the factory's status back. The factory never calls the POS.
//   factoryCompanies { entityId }                     the owner: the factory companies to link to
//   factoryLink      { entityId, companyId | '' }     the owner: link this company to a factory company (or unlink)
//   factorySend      { orderId }                      a supervisor: send (again) an order whose deposit is paid
//   factorySync      { orderId }                      any member: read the factory's status now
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, patchDoc, serverStamp, bodyOf, audit, requireMember, inEntity } from './lib/pos.mjs';
import { factoryCfg, listCompanies, companyNamed, noteHandover } from './lib/factory-link.mjs';
import { pushToFactory as pushBridge, syncFromFactory as syncBridge, cancelAtFactory } from './lib/factory-bridge.mjs';
import { whoAndWhere, prepareSale, prepareTenders, runSale, nextFromCounter, approved, int, specOf, specNote } from './lib/sale.mjs';
import { pctOf } from '../../pos/js/money.js';
import { specialSettings, signoffText, updateText, NEXT, STATUSES, SPEC_FIELDS, CANCEL_KINDS } from '../../pos/js/special-terms.js';

const REFUND_METHODS = ['cash', 'card', 'eft', 'storeCredit'];
const NOW_METHODS = ['cash', 'card', 'eft', 'qr', 'storeCredit'];
const money = (c) => 'R ' + (c / 100).toFixed(2);
const idOk = (id) => /^[\w:.-]{8,80}$/.test(id);

async function loadOrder(ctx, id) {
  id = clean(id, 80);
  const so = await getDoc('specialOrders', id);
  if (!so || so.entityId !== ctx.entityId) throw new Reject(404, 'No such special order here.');
  return { ...so, id };
}
function moneyNow(ctx, tenders, total, customer) {
  const t = prepareTenders(ctx, tenders, { total, customer, partial: true });
  if (!(t.paid > 0)) throw new Reject(400, 'How much is being paid?');
  const bad = t.pays.find(p => !NOW_METHODS.includes(p.method) || p.status === 'awaiting');
  if (bad) throw new Reject(400, 'Pay a special order with cash, card, EFT, QR or store credit, received now.');
  return t;
}
const payRows = (ctx, so, pays, instalment, firstId, stamp, now) => pays.map((p, i) => ({ create: true, coll: 'payments', id: i === 0 && firstId ? firstId : randomId('pay_'), data: { docType: 'specialOrder', docId: so.id, docNo: so.docNo, instalment, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...p, ...stamp, serverReceivedAt: now } }));
const auditRow = (ctx, action, so, details, approvers, stamp, now) => ({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action, docType: 'specialOrder', docId: so.id, docNo: so.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...approvers.keys()][0] || '', overrideName: [...approvers.values()][0] || '', details, ...stamp, serverReceivedAt: now } });
const hist = (so, status, by, source, note, now) => [...(so.statusHistory || []), { status, at: now, byName: by, source, note: note || '' }].slice(-50);

const actions = {
  async open(event, b) {
    const ctx = await whoAndWhere(event, b);
    const ss = specialSettings(ctx.settings);
    const id = clean(b.orderId, 80);
    if (!idOk(id)) throw new Reject(400, 'The order has no id.');
    const had = await getDoc('specialOrders', id);
    if (had) return { ok: true, order: { ...had, id }, again: true };
    if (!b.customerId) throw new Reject(400, 'A special order needs the customer: add them to the sale first.');
    const inLines = Array.isArray(b.lines) ? b.lines : [];
    const prep = await prepareSale(ctx, b, { noTenders: true });
    const bad = prep.lines.find(l => l.type === 'stock' || l.type === 'voucher' || l.type === 'bundle');
    if (bad) throw new Reject(400, `${bad.name}: only made-to-order and non-stock items go on a special order; sell stock as a sale or a lay-by.`);
    if (!(prep.total > 0)) throw new Reject(400, 'The order comes to nothing.');
    prep.lines.forEach((l, i) => { l.spec = specOf(inLines[i] && inLines[i].spec); if (l.type === 'mto' && !l.spec.model) l.spec.model = l.name; });
    const minDeposit = pctOf(prep.total, ss.minDepositPct);
    const customer = prep.customer;
    const dep = Array.isArray(b.deposit) && b.deposit.length ? moneyNow(ctx, b.deposit, prep.total, customer) : null;
    const sg = b.signoff || {};
    const signedBy = clean(sg.signedBy, 120);
    if (!sg.accepted || !signedBy) throw new Reject(400, 'The customer must check the specification and sign it off.');
    const signature = String(sg.signature || '').slice(0, 200000);
    if (signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new Reject(400, 'The signature is not a PNG.');
    const expectedAt = /^\d{4}-\d{2}-\d{2}$/.test(b.expectedAt || '') ? b.expectedAt : new Date(Date.now() + ss.leadDays * 86400000).toISOString().slice(0, 10);
    const paid = dep ? dep.paid : 0;
    const status = paid >= minDeposit && paid > 0 ? 'depositPaid' : 'quoted';

    const r = await runSale(ctx, {}, { more: async (tx) => {
      const num = await nextFromCounter(tx, ctx, 'SO', ctx.entity.specialOrderPrefix || (ctx.entity.invoicePrefix + '-SO'));
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const so = {
        id, series: 'SO', seq: num.seq, docNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '',
        customerId: customer.id, customerSnapshot: { name: customer.name, phone: customer.phone || '', email: customer.email || '', vatNo: customer.vatNo || '', address: customer.address || {} },
        lines: prep.lines, lineCount: prep.lines.length, subtotalCents: prep.gross, lineDiscountCents: prep.lineDisc, saleDiscountCents: prep.saleDisc, saleDiscountPct: Number(b.saleDiscountPct) || 0, saleDiscountReason: clean(b.saleDiscountReason, 120),
        totalCents: prep.total, vatCents: prep.vat, vatRateBp: prep.rateBp, vatRegistered: !!ctx.entity.vatRegistered,
        minDepositPct: ss.minDepositPct, minDepositCents: minDeposit, leadDays: ss.leadDays, depositCents: Math.min(paid, minDeposit), paidCents: paid, balanceCents: prep.total - paid, paymentCount: dep ? 1 : 0, lastPaidAt: dep ? now : '',
        history: dep ? [{ n: 0, at: now, amountCents: paid, methods: dep.pays.map(p => p.method), storeId: ctx.storeId, byName: ctx.user.name }] : [],
        status, statusHistory: [{ status: 'quoted', at: now, byName: ctx.user.name, source: 'till', note: '' }, ...(status === 'depositPaid' ? [{ status: 'depositPaid', at: now, byName: ctx.user.name, source: 'till', note: '' }] : [])],
        updateDue: status === 'depositPaid', updates: [], factoryRef: clean(b.factoryRef, 60), expectedAt, openedAt: prep.when,
        delivery: null, deliveryNote: null, completedAt: '', completedSaleId: '', completedDocNo: '', cancelledAt: '', cancelKind: '', cancelReason: '', feeCents: 0, feeReason: '', refunds: [], refundedCents: 0,
        cashierUid: ctx.user.id, cashierName: ctx.user.name, approvers: [...prep.approvers].map(([uid, name]) => ({ uid, name })), note: clean(b.note, 300),
        ...stamp, serverReceivedAt: now, updatedAt: now
      };
      so.signoff = { text: signoffText(ctx.entity, so), acceptedAt: now, signedBy, signature, cashierUid: ctx.user.id, cashierName: ctx.user.name };
      const { id: _id, ...data } = so;
      const writes = [num.write, { create: true, coll: 'specialOrders', id, data }];
      if (dep) { writes.push(...payRows(ctx, so, dep.pays, 0, '', stamp, now)); if (dep.creditUsed) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) - dep.creditUsed, updatedAt: now } }); }
      writes.push(auditRow(ctx, 'specialOrder.open', so, { totalCents: prep.total, depositCents: paid, status, lines: prep.lines.length }, prep.approvers, stamp, now));
      return { writes, result: { order: so, payments: dep ? dep.pays : [] } };
    } });
    if (r.order && r.order.status === 'depositPaid') r.order = await pushToFactory(ctx, r.order);
    return r;
  },

  async pay(event, b) {
    const ctx = await whoAndWhere(event, b);
    const so = await loadOrder(ctx, b.orderId);
    if (!['quoted', 'depositPaid', 'inProduction', 'ready'].includes(so.status)) throw new Reject(409, `Order ${so.docNo} is ${so.status}.`);
    const payId = clean(b.paymentId, 80);
    if (!idOk(payId)) throw new Reject(400, 'The payment has no id.');
    const had = await getDoc('payments', payId);
    if (had && (had.entityId !== ctx.entityId || had.docId !== so.id)) throw new Reject(403, 'That payment id belongs elsewhere.');
    if (had) return { ok: true, order: so, payments: [had], again: true };
    const customer = so.customerId ? await getDoc('customers', so.customerId) : null;
    const t = moneyNow(ctx, b.tenders, so.balanceCents, customer);
    const r = await runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('specialOrders', so.id, tx);
      if (!cur || !['quoted', 'depositPaid', 'inProduction', 'ready'].includes(cur.status)) throw new Reject(409, `Order ${so.docNo} is no longer open.`);
      if (t.paid > cur.balanceCents) throw new Reject(400, `Only ${money(cur.balanceCents)} is still owed.`);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const n = cur.paymentCount || 0;
      const paid = cur.paidCents + t.paid;
      const patch = { paidCents: paid, balanceCents: cur.balanceCents - t.paid, paymentCount: n + 1, lastPaidAt: now, updatedAt: now, depositCents: Math.min(paid, cur.minDepositCents), history: [...(cur.history || []), { n, at: now, amountCents: t.paid, methods: t.pays.map(p => p.method), storeId: ctx.storeId, byName: ctx.user.name }].slice(-100) };
      // the deposit reached: the order goes to the factory
      if (cur.status === 'quoted' && paid >= cur.minDepositCents) { patch.status = 'depositPaid'; patch.statusHistory = hist(cur, 'depositPaid', ctx.user.name, 'till', '', now); patch.updateDue = true; }
      const writes = [{ update: true, coll: 'specialOrders', id: so.id, data: patch }];
      writes.push(...payRows(ctx, so, t.pays, n, payId, stamp, now));
      if (t.creditUsed) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) - t.creditUsed, updatedAt: now } });
      writes.push(auditRow(ctx, 'specialOrder.pay', so, { amountCents: t.paid, instalment: n, methods: t.pays.map(p => p.method), balanceCents: patch.balanceCents, status: patch.status || cur.status }, new Map(), stamp, now));
      return { writes, result: { order: { ...cur, ...patch, id: so.id }, payments: t.pays, instalment: n, paidAt: now, sent: !!patch.status } };
    } });
    if (r.sent) r.order = await pushToFactory(ctx, r.order);
    delete r.sent;
    return r;
  },

  // the till moves it along (a supervisor or higher), when the factory does not call
  async status(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'specialOrder', 'supervisor', 'Changing an order’s status');
    const so = await loadOrder(ctx, b.orderId);
    return setStatus(so, b, { byName: ctx.user.name, source: 'till', ctx });
  },

  // the WhatsApp message for the order's status (or a chosen one), logged on the order
  async update(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const so = await loadOrder(ctx, b.orderId);
    const status = STATUSES.includes(b.status) || b.status === 'booked' ? b.status : so.status;
    const how = ['whatsapp', 'phone', 'email'].includes(b.how) ? b.how : 'whatsapp';
    const text = updateText(ctx.entity, ctx.store, so, status);
    const now = nowIso();
    const entry = { at: now, status, how, byName: ctx.user.name };
    await patchDoc('specialOrders', so.id, { updates: [...(so.updates || []), entry].slice(-50), updateDue: false, lastUpdateAt: now, updatedAt: now });
    await audit({ action: 'specialOrder.update', docType: 'specialOrder', docId: so.id, docNo: so.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, details: { status, how }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, text, status, how, phone: so.customerSnapshot.phone || '', email: so.customerSnapshot.email || '', update: entry };
  },

  // delivery or collection booked
  async book(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const so = await loadOrder(ctx, b.orderId);
    if (['delivered', 'collected', 'cancelled'].includes(so.status)) throw new Reject(409, `Order ${so.docNo} is ${so.status}.`);
    const kind = b.kind === 'collect' ? 'collect' : 'deliver';
    const date = clean(b.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Reject(400, 'Which day?');
    const a = b.address || {};
    const address = kind === 'deliver' ? { line1: clean(a.line1, 120), line2: clean(a.line2, 120), city: clean(a.city, 80), code: clean(a.code, 12) } : null;
    if (kind === 'deliver' && !(address.line1 || address.city)) throw new Reject(400, 'A delivery needs an address.');
    const now = nowIso();
    const delivery = { kind, date, slot: clean(b.slot, 40), address, phone: clean(b.phone, 30) || so.customerSnapshot.phone || '', note: clean(b.note, 300), driverName: clean(b.driverName, 80), bookedAt: now, bookedBy: ctx.user.name };
    await patchDoc('specialOrders', so.id, { delivery, updateDue: true, updatedAt: now });
    await audit({ action: 'specialOrder.book', docType: 'specialOrder', docId: so.id, docNo: so.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, details: { kind, date }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, order: { ...so, delivery, updateDue: true }, delivery };
  },

  // handed over: the tax invoice written as a sale paid by the order; the signed note kept
  async deliver(event, b) {
    const ctx = await whoAndWhere(event, b);
    const so = await loadOrder(ctx, b.orderId);
    if (['delivered', 'collected'].includes(so.status) && so.completedSaleId) { const sale = await getDoc('sales', so.completedSaleId); return { ok: true, again: true, order: so, sale: sale ? { ...sale, id: so.completedSaleId } : null, lines: await query('saleLines', [{ field: 'saleId', value: so.completedSaleId }], 500, { field: 'lineNo' }), payments: [] }; }
    if (!['ready', 'inProduction', 'depositPaid'].includes(so.status)) throw new Reject(409, `Order ${so.docNo} is ${so.status}.`);
    if (so.balanceCents > 0) throw new Reject(400, `${money(so.balanceCents)} is still owed on ${so.docNo}: take the balance first.`);
    const saleId = clean(b.saleId, 80);
    if (!idOk(saleId)) throw new Reject(400, 'The sale has no id.');
    const signedBy = clean(b.signedBy, 120);
    const signature = String(b.signature || '').slice(0, 200000);
    if (signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new Reject(400, 'The signature is not a PNG.');
    const kind = (so.delivery && so.delivery.kind) || (b.kind === 'collect' ? 'collect' : 'deliver');
    const body = {
      clientCreatedAt: nowIso(), customerId: so.customerId, specialOrderOf: so.docNo, note: 'Special order ' + so.docNo,
      lines: so.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, note: [l.note, ...specNote(l.spec)].filter(Boolean).join(' · ').slice(0, 200), custom: l.custom, name: l.name, vatClass: l.vatClass })),
      saleDiscountCents: so.saleDiscountCents, saleDiscountPct: so.saleDiscountPct, saleDiscountReason: so.saleDiscountReason, tenders: []
    };
    const prep = await prepareSale(ctx, body, { trusted: 'Special order ' + so.docNo, prepaid: { method: 'specialOrder', docNo: so.docNo, amountCents: so.totalCents } });
    if (prep.total !== so.totalCents) throw new Reject(409, `The order's price (${money(so.totalCents)}) and the sale's (${money(prep.total)}) differ.`);
    const r = await runSale(ctx, body, { saleId, prep, more: async (tx) => {
      const cur = await getDoc('specialOrders', so.id, tx);
      if (!cur || cur.balanceCents > 0 || ['delivered', 'collected', 'cancelled'].includes(cur.status)) throw new Reject(409, `Order ${so.docNo} is no longer ready to hand over.`);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const status = kind === 'collect' ? 'collected' : 'delivered';
      const patch = { status, statusHistory: hist(cur, status, ctx.user.name, 'till', clean(b.note, 200), now), updateDue: true, completedAt: now, completedSaleId: saleId, completedByUid: ctx.user.id, completedByName: ctx.user.name, deliveryNote: { signedBy, signature, at: now, byName: ctx.user.name, note: clean(b.note, 300), kind }, updatedAt: now };
      const writes = [{ update: true, coll: 'specialOrders', id: so.id, data: patch }];
      writes.push(auditRow(ctx, 'specialOrder.deliver', so, { saleId, status, signed: !!signature }, new Map(), stamp, now));
      return { writes, result: { order: { ...cur, ...patch, id: so.id } } };
    } });
    if (r.sale && r.sale.docNo) { await patchDoc('specialOrders', so.id, { completedDocNo: r.sale.docNo }); r.order.completedDocNo = r.sale.docNo; }
    if (so.factory && so.factory.orders && so.factory.orders.length) await noteHandover(so.factory.companyId, so.factory.orders, `${kind === 'collect' ? 'Collected by' : 'Delivered to'} the customer from the ${ctx.store.name} store on ${nowIso().slice(0, 10)} (${so.docNo}, invoice ${r.sale ? r.sale.docNo : ''})`).catch(() => {});
    return r;
  },

  // cancelled by a manager: the fee the manager sets (the deposit once production started), the rest refunded
  async cancel(event, b) {
    const ctx = await whoAndWhere(event, b);
    const so = await loadOrder(ctx, b.orderId);
    if (!['quoted', 'depositPaid', 'inProduction', 'ready'].includes(so.status)) throw new Reject(409, `Order ${so.docNo} is ${so.status}.`);
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'specialOrder', 'manager', 'Cancelling a special order');
    if (!a.self) approvers.set(a.uid, a.name);
    const kind = CANCEL_KINDS.some(k => k[0] === b.kind) ? b.kind : 'customer';
    const started = ['inProduction', 'ready'].includes(so.status);
    let fee = int(b.feeCents); if (!(fee >= 0)) fee = kind === 'customer' && started ? Math.min(so.depositCents, so.paidCents) : 0;
    if (fee > so.paidCents) throw new Reject(400, 'The fee cannot be more than was paid.');
    if (kind === 'store' && fee) throw new Reject(400, 'No fee when we cannot make it.');
    if (fee && !started && kind === 'customer') throw new Reject(400, 'No fee before production starts.');
    const refundDue = so.paidCents - fee;
    const refunds = (Array.isArray(b.refunds) ? b.refunds : []).map(r => ({ method: clean(r.method, 20), amountCents: int(r.amountCents), ref: clean(r.ref, 60) }));
    for (const r of refunds) { if (!REFUND_METHODS.includes(r.method)) throw new Reject(400, `${r.method || 'That'} is not a refund method.`); if (!(r.amountCents > 0)) throw new Reject(400, 'A refund must be more than nothing.'); }
    const refunded = refunds.reduce((n, r) => n + r.amountCents, 0);
    if (refunded !== refundDue) throw new Reject(400, `The refunds (${money(refunded)}) must equal what is owed back: ${money(refundDue)} (paid ${money(so.paidCents)} less the fee ${money(fee)}).`);
    const customer = so.customerId ? await getDoc('customers', so.customerId) : null;
    const credit = refunds.filter(r => r.method === 'storeCredit').reduce((n, r) => n + r.amountCents, 0);
    if (credit && !customer) throw new Reject(400, 'Store credit needs the customer.');
    const r = await runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('specialOrders', so.id, tx);
      if (!cur || cur.paidCents !== so.paidCents || ['delivered', 'collected', 'cancelled'].includes(cur.status)) throw new Reject(409, `Order ${so.docNo} changed meanwhile: look again.`);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const patch = { status: 'cancelled', statusHistory: hist(cur, 'cancelled', ctx.user.name, 'till', clean(b.reason, 200), now), updateDue: true, cancelledAt: now, cancelKind: kind, cancelReason: clean(b.reason, 200), feeCents: fee, feeReason: fee ? (started ? 'Production had started: the deposit covers the work and materials spent' : clean(b.feeReason, 200)) : '', refunds, refundedCents: refunded, cancelledByUid: ctx.user.id, cancelledByName: ctx.user.name, approvers: [...approvers].map(([uid, name]) => ({ uid, name })), updatedAt: now };
      const writes = [{ update: true, coll: 'specialOrders', id: so.id, data: patch }];
      for (const rf of refunds) {
        writes.push({ create: true, coll: 'refunds', id: randomId('rf_'), data: { specialOrderId: so.id, specialOrderDocNo: so.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...rf, ...stamp, serverReceivedAt: now } });
        writes.push({ create: true, coll: 'payments', id: randomId('pay_'), data: { docType: 'refund', docId: so.id, docNo: so.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', method: rf.method, amountCents: -rf.amountCents, ref: rf.ref, status: 'paid', ...stamp, serverReceivedAt: now } });
      }
      if (credit) writes.push({ update: true, coll: 'customers', id: customer.id, data: { storeCreditCents: (customer.storeCreditCents || 0) + credit, updatedAt: now } });
      writes.push(auditRow(ctx, 'specialOrder.cancel', so, { kind, feeCents: fee, refundedCents: refunded, methods: refunds.map(x => x.method) }, approvers, stamp, now));
      return { writes, result: { order: { ...cur, ...patch, id: so.id }, refunds } };
    } });
    if (so.factory && so.factory.orders && so.factory.orders.length) r.order.factory = (await cancelAtFactory(ctx, 'specialOrders', so, so.factory.orders, clean(b.reason, 200))).factory;
    return r;
  },

  // ---- the factory
  async factoryCompanies(event, b) {
    const { user: u } = await requireMember(event);
    const entityId = clean(b.entityId, 20);
    if (u.role !== 'owner') throw new Reject(403, 'This is for the owner.');
    const settings = (await getDoc('settings', entityId)) || {};
    return { ok: true, companies: await listCompanies(), linked: factoryCfg(settings) };
  },
  async factoryLink(event, b) {
    const { uid, user: u } = await requireMember(event);
    const entityId = clean(b.entityId, 20);
    if (u.role !== 'owner' || !inEntity(u, entityId)) throw new Reject(403, 'This is for the owner.');
    const companyId = clean(b.companyId, 60);
    const name = companyId ? await companyNamed(companyId) : '';
    if (companyId && !name) throw new Reject(404, 'No such factory company.');
    const factory = companyId ? { companyId, companyName: name, linkedAt: nowIso(), linkedBy: u.name } : {};
    await patchDoc('settings', entityId, { factory });
    await audit({ action: companyId ? 'factory.link' : 'factory.unlink', docType: 'settings', docId: entityId, docNo: '', actorUid: uid, actorName: u.name, details: { companyId, name }, entityId, storeId: '', deviceId: 'web' });
    return { ok: true, linked: companyId ? { companyId, companyName: name } : null };
  },
  // send the order to the factory (again): after a failure, or a link made after the deposit was paid
  async factorySend(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'specialOrder', 'supervisor', 'Sending an order to the factory');
    const so = await loadOrder(ctx, b.orderId);
    if (!['depositPaid', 'inProduction', 'ready'].includes(so.status)) throw new Reject(409, `Order ${so.docNo} is ${so.status}: the factory gets it once the deposit is paid.`);
    const order = await pushToFactory(ctx, so);
    if (order.factory && order.factory.error) throw new Reject(502, order.factory.error);
    return { ok: true, order };
  },
  // what the factory says now, and the order moved along if it has
  async factorySync(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const so = await loadOrder(ctx, b.orderId);
    if (!so.factory || !so.factory.orders || !so.factory.orders.length) throw new Reject(409, `Order ${so.docNo} has not been sent to the factory.`);
    const order = await syncFromFactory(so);
    return { ok: true, order };
  }
};

// ---- the factory (lib/factory-bridge.mjs): the order written into the linked company once the deposit is paid, its status read back
const FORWARD_SPECIAL = { depositPaid: ['inProduction', 'ready'], inProduction: ['ready'] };
const pushToFactory = (ctx, so) => pushBridge(ctx, 'specialOrders', so, 'custom');
const syncFromFactory = (so) => syncBridge('specialOrders', so, FORWARD_SPECIAL);

// a status step: only forward, only inProduction or ready from here (delivery and cancellation have their own actions)
async function setStatus(so, b, { byName, source, ctx }) {
  const status = clean(b.status, 20);
  if (!['inProduction', 'ready'].includes(status)) throw new Reject(400, 'The status can move to inProduction or ready here.');
  if (so.status === status) return { ok: true, order: so, same: true };
  if (!NEXT[so.status] || !NEXT[so.status].includes(status)) throw new Reject(409, `Order ${so.docNo} is ${so.status}: it cannot go to ${status}${so.status === 'quoted' ? ' before the deposit is paid' : ''}.`);
  const now = nowIso();
  const patch = { status, statusHistory: hist(so, status, byName, source, clean(b.note, 200), now), updateDue: true, updatedAt: now };
  if (b.factoryRef) patch.factoryRef = clean(b.factoryRef, 60);
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.expectedAt || '')) patch.expectedAt = b.expectedAt;
  await patchDoc('specialOrders', so.id, patch);
  await audit({ action: 'specialOrder.status', docType: 'specialOrder', docId: so.id, docNo: so.docNo, actorUid: ctx ? ctx.user.id : 'factory', actorName: byName, details: { from: so.status, to: status, source, note: clean(b.note, 200) }, entityId: so.entityId, storeId: so.storeId, deviceId: ctx ? ctx.deviceId : 'factory' });
  return { ok: true, order: { ...so, ...patch } };
}

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
    console.error('pos-special failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};
