// Retail POS — customers: the cell number as the key, POPIA consent per
// channel with a date, history across the stores, merging duplicates, an
// export and an anonymisation on request, and loyalty points by hand.
// Only this function (and the sale core, for credit, points and stats)
// writes customers.
//
//   save         { customerId?, name, contact, phone, email, vatNo, address, dob, tags, notes, notifyBy ('sms'|'email'|'whatsapp'|'none'|''), consent { whatsapp, sms, email } (booleans), consentSource,
//                  accountEnabled?, creditLimitCents? (a manager) }     → the customer; a cell number is one customer per company
//   consent      { customerId, channel, granted, source }
//   address      { customerId, address { line1, line2, city, code } }   the address only (from the till: a delivery, a tax invoice over R 5 000)
//   history      { customerId }                                         → sales, credit notes, lay-bys, custom orders, the points ledger
//   merge        { keepId, dropId }                                     a manager
//   export       { customerId }                                         a manager: the profile and history
//   anonymise    { customerId, reason }                                 a manager: the personal details wiped, the number freed
//   adjustPoints { customerId, points, note }                           a manager
//   accountPayment { customerId, paymentId, tenders [ { method, amountCents, tenderedCents?, ref?, cardLast4?, approvalCode? } ], note, clientCreatedAt, + where }
//                money against the account, numbered AP: cash at an open register, card with its proof, EFT or QR awaiting
//                the bank until a manager confirms it, store credit; only confirmed money reduces what is owed; never more than is owed
//   confirmAccountPayment { paymentId, bankRef, approvalToken? }   a manager: the EFT/QR is on the statement, it counts now
//   voidAccountPayment    { paymentId, reason, approvalToken? }    a manager: it never came; the account owes it again
//   statement    { customerId }                                         → the account statement (invoices on account, payments, running balance, ageing)
//   takeOn       { batchId, rows: [ { line, name, phone, email, vatNo, address, owedCents, limitCents, creditCents, creditRef } ] }
//                the owner, from the old system's customer list: profiles made or found by cell number; what they owe becomes the
//                account's opening balance (the account opened, the limit at least that); store credit only with a document's
//                reference; anything else (no cell number, a credit balance, credit without a reference, already taken on) is handed
//                back as an exception for a person to decide — nothing is guessed
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, serverStamp, bodyOf, audit, rank, withGroup } from './lib/pos.mjs';
import { whoAndWhere, runSale, approved, int, moneyNow, nextFromCounter } from './lib/sale.mjs';
import { statementOf } from './lib/account.mjs';
import { CHANNELS, phoneKey, phoneOk, emailKey, loyaltySettings, sweep, tierFor, blankConsent, blankLoyalty, blankStats } from '../../pos/js/loyalty-terms.js';

const idOk = (id) => /^[\w:.-]{8,80}$/.test(id);
const money = (c) => 'R ' + (c / 100).toFixed(2);
const keyId = (entityId, k) => entityId + '_' + k;
async function loadCustomer(ctx, id) {
  id = clean(id, 80);
  const c = await getDoc('customers', id);
  if (!c || c.entityId !== ctx.entityId) throw new Reject(404, 'No such customer here.');
  return { ...c, id };
}
const consentPatch = (cur, wants, byName, source, now) => { const out = { ...blankConsent(), ...(cur || {}) }; for (const [ch] of CHANNELS) { if (wants && typeof wants[ch] === 'boolean' && !!out[ch].granted !== wants[ch]) out[ch] = { granted: wants[ch], at: now, byName, source }; } return out; };
const auditRow = (ctx, action, id, details, stamp, now) => ({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action, docType: 'customer', docId: id, docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: '', overrideName: '', details, ...stamp, serverReceivedAt: now } });
const safeRow = (s) => ({ id: s.id, docNo: s.docNo, at: s.clientCreatedAt || s.createdAt || s.openedAt, storeId: s.storeId, totalCents: s.totalCents, status: s.status || s.paidStatus || '', lines: s.lineCount || (s.lines || []).length, cashier: s.cashierName || '' });

// an EFT or QR on an account, awaiting the bank: confirmed (it counts now) or voided (never came), by a manager or with one's PIN
async function bankAccountPayment(event, b, confirm) {
  const ctx = await whoAndWhere(event, b, { noShift: true });
  const a = approved(ctx, b.approvalToken, 'customer', 'manager', confirm ? 'Confirming a bank payment' : 'Marking a payment not received');
  const pid = clean(b.paymentId, 80);
  const pay = await getDoc('payments', pid);
  if (!pay || pay.entityId !== ctx.entityId || pay.docType !== 'accountPayment') throw new Reject(404, 'No such payment here.');
  if (pay.status !== 'awaiting') throw new Reject(409, pay.status === 'void' ? 'That payment was marked not received.' : 'That payment is confirmed already.');
  const bankRef = clean(b.bankRef, 60), reason = clean(b.reason, 200);
  if (!confirm && !reason) throw new Reject(400, 'Why was it not received?');
  return runSale(ctx, {}, { more: async (tx) => {
    const ap = await getDoc('accountPayments', pay.docId, tx);
    if (!ap) throw new Reject(404, 'The payment’s receipt is gone.');
    const cur = await getDoc('customers', ap.customerId, tx);
    const now = nowIso();
    const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
    const amt = pay.amountCents;
    const mark = confirm ? { status: 'paid', confirmedAt: now, confirmedBy: a.name, bankRef } : { status: 'void', voidedAt: now, voidedBy: a.name, voidReason: reason };
    const awaiting = Math.max(0, (ap.awaitingCents || 0) - amt);
    const confirmed = (ap.confirmedCents || 0) + (confirm ? amt : 0);
    const apPatch = { tenders: (ap.tenders || []).map(x => x.paymentId === pid ? { ...x, ...mark } : x), awaitingCents: awaiting, confirmedCents: confirmed, voidCents: (ap.voidCents || 0) + (confirm ? 0 : amt),
      status: awaiting ? 'part' : confirmed > 0 ? 'paid' : 'void', owedAfter: (ap.owedAfter != null ? ap.owedAfter : ap.owedBefore) - (confirm ? amt : 0), updatedAt: now };
    const cPatch = { accountAwaitingCents: Math.max(0, (cur.accountAwaitingCents || 0) - amt), ...(confirm ? { accountBalanceCents: (cur.accountBalanceCents || 0) - amt, lastAccountPaymentAt: now } : {}), updatedAt: now, updatedBy: 'server' };
    const writes = [{ update: true, coll: 'accountPayments', id: pay.docId, data: apPatch },
      { update: true, coll: 'payments', id: pid, data: confirm ? { status: 'paid', confirmedAt: now, confirmedByUid: a.uid, confirmedByName: a.name, bankRef } : { status: 'void', voidedAt: now, voidedByUid: a.uid, voidedByName: a.name, voidReason: reason } },
      { update: true, coll: 'customers', id: ap.customerId, data: cPatch },
      { ...auditRow(ctx, confirm ? 'customer.confirmAccountPay' : 'customer.voidAccountPay', ap.customerId, { docNo: ap.docNo, paymentId: pid, amountCents: amt, method: pay.method, ref: pay.ref || '', bankRef, reason, owedAfter: cPatch.accountBalanceCents != null ? cPatch.accountBalanceCents : cur.accountBalanceCents || 0 }, stamp, now) }];
    if (!a.self) writes[3].data.overrideUid = a.uid, writes[3].data.overrideName = a.name;
    return { writes, result: { payment: { ...ap, ...apPatch, id: pay.docId }, row: { ...pay, ...mark, id: pid }, customer: { ...cur, ...cPatch, id: ap.customerId } } };
  } });
}

export const actions = {
  async save(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const id = clean(b.customerId, 80);
    const cur = id ? await loadCustomer(ctx, id) : null;
    if (id && !cur) throw new Reject(404, 'No such customer.');
    if (cur && cur.anonymised) throw new Reject(409, 'This profile was anonymised: make a new one.');
    const name = clean(b.name, 120);
    if (!name) throw new Reject(400, 'A name.');
    const phone = clean(b.phone, 30), pk = phoneKey(phone);
    if (phone && !phoneOk(phone)) throw new Reject(400, 'That cell number does not look right: 10 digits, e.g. 082 123 4567.');
    if (!cur && !pk) throw new Reject(400, 'A cell number: it is how we know the customer again.');
    const email = clean(b.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Reject(400, 'That email address does not look right.');
    const a = b.address || {};
    const address = { line1: clean(a.line1, 120), line2: clean(a.line2, 120), city: clean(a.city, 80), code: clean(a.code, 12) };
    const mgr = rank(ctx.user.role) >= rank('manager');
    const wantsAccount = b.accountEnabled != null || b.creditLimitCents != null;
    if (wantsAccount && !mgr) throw new Reject(403, 'Only a manager opens an account or sets its limit.');
    const newId = cur ? cur.id : (idOk(clean(b.newId, 80)) ? clean(b.newId, 80) : randomId('cu_'));
    return runSale(ctx, {}, { more: async (tx) => {
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId);
      const writes = [];
      if (!cur) { const had = await getDoc('customers', newId, tx); if (had) return { writes: [], result: { customer: { ...had, id: newId }, again: true } }; }
      // the cell number is one customer per company
      if (pk && (!cur || cur.phoneKey !== pk)) {
        const taken = await getDoc('customerPhones', keyId(ctx.entityId, pk), tx);
        if (taken && taken.customerId !== newId) { const other = await getDoc('customers', taken.customerId); throw new Reject(409, `That number is already ${other ? other.name : 'another customer'}: use that profile, or merge the two.`); }
        writes.push({ set: true, coll: 'customerPhones', id: keyId(ctx.entityId, pk), data: { customerId: newId, entityId: ctx.entityId, storeId: '', updatedAt: now } });
        if (cur && cur.phoneKey) writes.push({ delete: true, coll: 'customerPhones', id: keyId(ctx.entityId, cur.phoneKey) });
      }
      const consent = consentPatch(cur ? cur.consent : null, b.consent, ctx.user.name, clean(b.consentSource, 20) || (ctx.device ? 'till' : 'office'), now);
      const data = { name, contact: clean(b.contact, 120) || name, phone, phoneKey: pk, email, emailKey: emailKey(email), vatNo: clean(b.vatNo, 20), address, dob: /^\d{4}-\d{2}-\d{2}$/.test(b.dob || '') ? b.dob : (cur ? cur.dob || '' : ''), tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(t => clean(t, 30)).filter(Boolean).slice(0, 20), notes: clean(b.notes, 1000), notifyBy: b.notifyBy == null ? (cur && cur.notifyBy) || '' : ['sms', 'email', 'whatsapp', 'none'].includes(b.notifyBy) ? b.notifyBy : '', consent, updatedAt: now, updatedBy: ctx.user.id };
      if (wantsAccount) { data.accountEnabled = !!b.accountEnabled; data.creditLimitCents = Math.max(0, int(b.creditLimitCents) || 0); }
      if (cur) writes.push({ update: true, coll: 'customers', id: cur.id, data });
      else writes.push({ create: true, coll: 'customers', id: newId, data: { ...data, accountEnabled: !!b.accountEnabled && mgr, creditLimitCents: mgr ? Math.max(0, int(b.creditLimitCents) || 0) : 0, storeCreditCents: 0, accountBalanceCents: 0, loyalty: blankLoyalty(), stats: blankStats(), mergedIds: [], altPhones: [], mergedInto: '', anonymised: false, anonymisedAt: '', archived: false, ...stamp } });
      writes.push(auditRow(ctx, cur ? 'customer.update' : 'customer.create', newId, { name, phoneKey: pk, consent: Object.fromEntries(CHANNELS.map(c => [c[0], consent[c[0]].granted])) }, stamp, now));
      const out = cur ? { ...cur, ...data } : { id: newId, ...writes.find(w => w.coll === 'customers').data };
      return { writes, result: { customer: { ...out, id: newId } } };
    } });
  },

  async address(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const c = await loadCustomer(ctx, b.customerId);
    if (c.anonymised) throw new Reject(409, 'This profile was anonymised.');
    const a = b.address || {};
    const address = { line1: clean(a.line1, 120), line2: clean(a.line2, 120), city: clean(a.city, 80), code: clean(a.code, 12) };
    if (!address.line1 && !address.city) throw new Reject(400, 'The street or the city.');
    const now = nowIso(); const stamp = serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId);
    await runSale(ctx, {}, { more: async () => ({ writes: [{ update: true, coll: 'customers', id: c.id, data: { address, updatedAt: now, updatedBy: ctx.user.id } }, auditRow(ctx, 'customer.address', c.id, { city: address.city }, stamp, now)], result: {} }) });
    return { ok: true, customer: { ...c, address, id: c.id } };
  },

  async consent(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const c = await loadCustomer(ctx, b.customerId);
    if (c.anonymised) throw new Reject(409, 'This profile was anonymised.');
    const ch = CHANNELS.find(x => x[0] === b.channel); if (!ch) throw new Reject(400, 'Which channel: whatsapp, sms or email?');
    const now = nowIso();
    const consent = consentPatch(c.consent, { [ch[0]]: !!b.granted }, ctx.user.name, clean(b.source, 20) || (ctx.device ? 'till' : 'office'), now);
    await runSale(ctx, {}, { more: async () => ({ writes: [{ update: true, coll: 'customers', id: c.id, data: { consent, updatedAt: now, updatedBy: ctx.user.id } }, auditRow(ctx, 'customer.consent', c.id, { channel: ch[0], granted: !!b.granted, source: clean(b.source, 20) }, serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId), now)], result: {} }) });
    return { ok: true, consent };
  },

  // everything on the customer, across the company's stores (the till reads only its own store's documents)
  async history(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const c = await loadCustomer(ctx, b.customerId);
    const ids = [c.id, ...(c.mergedIds || [])];
    const all = async (coll, max) => { const out = []; for (const id of ids) out.push(...await query(coll, [{ field: 'entityId', value: ctx.entityId }, { field: 'customerId', value: id }], max)); return out; };
    const [sales, notes, laybys, orders, ledger, aps] = await Promise.all([all('sales', 300), all('creditNotes', 100), all('laybys', 100), all('specialOrders', 100), query('loyaltyLedger', [{ field: 'entityId', value: ctx.entityId }, { field: 'customerId', value: c.id }], 200), all('accountPayments', 200)]);
    const by = (x, y) => String(y.at).localeCompare(String(x.at));
    const ls = loyaltySettings(ctx.settings);
    const sw = sweep(c.loyalty, nowIso());
    return { ok: true, customer: c, loyalty: { ...ls, points: sw.points, expiringSoon: sw.lots.filter(l => l.expiresAt && Date.parse(l.expiresAt) - Date.now() < 30 * 86400000).reduce((n, l) => n + l.left, 0), tier: tierFor(ls, (c.loyalty || {}).lifetimeCents || 0).name, valueCents: sw.points * ls.pointValueCents },
      sales: sales.map(safeRow).sort(by), creditNotes: notes.map(n => ({ ...safeRow(n), saleDocNo: n.saleDocNo, refundedCents: n.refundedCents })).sort(by), laybys: laybys.map(l => ({ ...safeRow(l), paidCents: l.paidCents, balanceCents: l.balanceCents, dueAt: l.dueAt })).sort(by), specialOrders: orders.map(o => ({ ...safeRow(o), paidCents: o.paidCents, balanceCents: o.balanceCents, expectedAt: o.expectedAt })).sort(by),
      ledger: ledger.map(l => ({ at: l.createdAt, kind: l.kind, points: l.points, balanceAfter: l.balanceAfter, docNo: l.docNo || '', note: l.note || '', expiresAt: l.expiresAt || '' })).sort((x, y) => String(y.at).localeCompare(String(x.at))),
      accountPayments: aps.map(p => ({ id: p.id, at: p.clientCreatedAt || p.createdAt, docNo: p.docNo, storeId: p.storeId, amountCents: p.amountCents, confirmedCents: p.confirmedCents || 0, awaitingCents: p.awaitingCents || 0, status: p.status, cashierName: p.cashierName || '', tenders: p.tenders || [] })).sort(by) };
  },

  // two profiles become one: money, points and consent move to the kept one; documents stay as issued and are found through mergedIds
  async merge(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'customer', 'manager', 'Merging customers');
    const keep = await loadCustomer(ctx, b.keepId), drop = await loadCustomer(ctx, b.dropId);
    if (keep.id === drop.id) throw new Reject(400, 'Those are the same customer.');
    if (keep.anonymised || drop.anonymised || keep.mergedInto || drop.mergedInto) throw new Reject(409, 'One of them is already merged or anonymised.');
    return runSale(ctx, {}, { more: async (tx) => {
      const k = await getDoc('customers', keep.id, tx), dr = await getDoc('customers', drop.id, tx);
      if (!k || !dr || dr.mergedInto) throw new Reject(409, 'A profile changed meanwhile: look again.');
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId);
      const consent = { ...blankConsent(), ...(k.consent || {}) };
      for (const [ch] of CHANNELS) { const d = (dr.consent || {})[ch]; if (d && d.granted && !consent[ch].granted) consent[ch] = d; }
      const kl = { ...blankLoyalty(), ...(k.loyalty || {}) }, dl = { ...blankLoyalty(), ...(dr.loyalty || {}) };
      const lots = [...(kl.lots || []), ...(dl.lots || [])].filter(l => l.left > 0);
      const points = lots.reduce((n, l) => n + l.left, 0);
      const ls = loyaltySettings(ctx.settings);
      const lifetime = (kl.lifetimeCents || 0) + (dl.lifetimeCents || 0);
      const ks = { ...blankStats(), ...(k.stats || {}) }, ds = { ...blankStats(), ...(dr.stats || {}) };
      const stats = { salesCount: (ks.salesCount || 0) + (ds.salesCount || 0), spentCents: (ks.spentCents || 0) + (ds.spentCents || 0), firstSaleAt: [ks.firstSaleAt, ds.firstSaleAt].filter(Boolean).sort()[0] || '', lastSaleAt: [ks.lastSaleAt, ds.lastSaleAt].filter(Boolean).sort().pop() || '' };
      const fill = (a, b2) => a || b2 || '';
      const kept = { email: fill(k.email, dr.email), emailKey: emailKey(fill(k.email, dr.email)), vatNo: fill(k.vatNo, dr.vatNo), address: (k.address && (k.address.line1 || k.address.city)) ? k.address : (dr.address || k.address || {}), notes: [k.notes, dr.notes].filter(Boolean).join('\n'), tags: [...new Set([...(k.tags || []), ...(dr.tags || [])])],
        storeCreditCents: (k.storeCreditCents || 0) + (dr.storeCreditCents || 0), accountBalanceCents: (k.accountBalanceCents || 0) + (dr.accountBalanceCents || 0), accountEnabled: !!(k.accountEnabled || dr.accountEnabled), creditLimitCents: Math.max(k.creditLimitCents || 0, dr.creditLimitCents || 0),
        consent, loyalty: { points, lifetimeCents: lifetime, tier: tierFor(ls, lifetime).name, lots, lastEarnedAt: [kl.lastEarnedAt, dl.lastEarnedAt].filter(Boolean).sort().pop() || '' }, stats,
        mergedIds: [...new Set([...(k.mergedIds || []), dr.id, ...(dr.mergedIds || [])])], altPhones: [...new Set([...(k.altPhones || []), ...(dr.phoneKey && dr.phoneKey !== k.phoneKey ? [dr.phoneKey] : []), ...(dr.altPhones || [])])], updatedAt: now, updatedBy: ctx.user.id };
      const writes = [{ update: true, coll: 'customers', id: k.id, data: kept }];
      writes.push({ update: true, coll: 'customers', id: dr.id, data: { mergedInto: k.id, archived: true, storeCreditCents: 0, accountBalanceCents: 0, loyalty: { ...dl, points: 0, lots: [] }, updatedAt: now, updatedBy: ctx.user.id } });
      if (dr.phoneKey) writes.push({ set: true, coll: 'customerPhones', id: keyId(ctx.entityId, dr.phoneKey), data: { customerId: k.id, entityId: ctx.entityId, storeId: '', updatedAt: now } });
      if (dl.points) { writes.push({ create: true, coll: 'loyaltyLedger', id: randomId('lp_'), data: { customerId: dr.id, kind: 'merge', points: -dl.points, balanceAfter: 0, saleId: '', docNo: '', note: 'Merged into ' + k.name, expiresAt: '', ...stamp, serverReceivedAt: now } }); writes.push({ create: true, coll: 'loyaltyLedger', id: randomId('lp_'), data: { customerId: k.id, kind: 'merge', points: dl.points, balanceAfter: points, saleId: '', docNo: '', note: 'Merged from ' + dr.name, expiresAt: '', ...stamp, serverReceivedAt: now } }); }
      writes.push(auditRow(ctx, 'customer.merge', k.id, { dropId: dr.id, creditCents: dr.storeCreditCents || 0, points: dl.points || 0 }, stamp, now));
      return { writes, result: { customer: { ...k, ...kept, id: k.id } } };
    } });
  },

  async export(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'customer', 'manager', 'Exporting a customer’s data');
    const h = await actions.history(event, b);
    await audit({ action: 'customer.export', docType: 'customer', docId: h.customer.id, docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, details: { sales: h.sales.length }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    const { loyalty, ...profile } = h.customer;
    return { ok: true, exportedAt: nowIso(), by: ctx.user.name, entity: ctx.entity.legalName, profile: { ...profile, loyalty: { points: h.loyalty.points, tier: h.loyalty.tier, lifetimeCents: (loyalty || {}).lifetimeCents || 0 } }, sales: h.sales, creditNotes: h.creditNotes, laybys: h.laybys, specialOrders: h.specialOrders, ledger: h.ledger };
  },

  // the personal details go; the invoices already issued keep their copy as tax records
  async anonymise(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'customer', 'manager', 'Anonymising a customer');
    const c = await loadCustomer(ctx, b.customerId);
    if (c.anonymised) return { ok: true, customer: c, again: true };
    if ((c.accountBalanceCents || 0) > 0) throw new Reject(409, `${c.name} still owes ${(c.accountBalanceCents / 100).toFixed(2)} on account: settle it first.`);
    const now = nowIso(); const stamp = serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId);
    const data = { name: 'Anonymised customer', contact: '', phone: '', phoneKey: '', email: '', emailKey: '', vatNo: '', address: {}, dob: '', notes: '', tags: [], consent: blankConsent(), altPhones: [], anonymised: true, anonymisedAt: now, archived: true, updatedAt: now, updatedBy: ctx.user.id };
    const writes = [{ update: true, coll: 'customers', id: c.id, data }];
    for (const k of [c.phoneKey, ...(c.altPhones || [])].filter(Boolean)) writes.push({ delete: true, coll: 'customerPhones', id: keyId(ctx.entityId, k) });
    writes.push(auditRow(ctx, 'customer.anonymise', c.id, { reason: clean(b.reason, 200), creditKeptCents: c.storeCreditCents || 0 }, stamp, now));
    await runSale(ctx, {}, { more: async () => ({ writes, result: {} }) });
    return { ok: true, customer: { ...c, ...data } };
  },

  // money against the account (lib/sale.mjs moneyNow says what counts now and what waits for the bank). Numbered AP from the
  // entity's counter; the payment rows carry the register and shift, so the cash is in that drawer's cash-up; only
  // confirmed money reduces what is owed, and never more than is owed.
  async accountPayment(event, b) {
    const ctx = await whoAndWhere(event, b);
    const c = await loadCustomer(ctx, b.customerId);
    const id = clean(b.paymentId, 80);
    if (!idOk(id)) throw new Reject(400, 'The payment has no id.');
    const had = await getDoc('accountPayments', id);
    if (had) { if (had.entityId !== ctx.entityId) throw new Reject(403, 'Not your payment.'); return { ok: true, payment: { ...had, id }, payments: [], customer: c, again: true }; }
    if (c.anonymised || c.mergedInto) throw new Reject(409, 'This profile no longer takes payments.');
    const owed = c.accountBalanceCents || 0, awaiting = c.accountAwaitingCents || 0;
    if (!(owed > 0)) throw new Reject(400, `${c.name} owes nothing on account.`);
    const t = moneyNow(ctx, b.tenders, owed, c, 'an account');
    if (t.paid > owed - awaiting) throw new Reject(400, `${c.name} owes ${money(owed - awaiting)}` + (awaiting ? ` (${money(awaiting)} is awaiting the bank)` : '') + '.');
    return runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('customers', c.id, tx);
      const owedNow = cur.accountBalanceCents || 0, awaitingNow = cur.accountAwaitingCents || 0;
      if (t.paid > owedNow - awaitingNow) throw new Reject(400, `${c.name} owes only ${money(owedNow - awaitingNow)} now.`);
      const num = await nextFromCounter(tx, ctx, 'AP', ctx.entity.accountPaymentPrefix || (ctx.entity.invoicePrefix + '-AP'));
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const ids = t.pays.map(() => randomId('pay_'));
      const doc = {
        series: 'AP', seq: num.seq, docNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '',
        customerId: c.id, customerSnapshot: { name: cur.name, phone: cur.phone || '', email: cur.email || '', vatNo: cur.vatNo || '', address: cur.address || {} },
        amountCents: t.paid, confirmedCents: t.confirmed, awaitingCents: t.awaiting, voidCents: 0, methods: [...new Set(t.pays.map(p => p.method))],
        tenders: t.pays.map((p, i) => ({ paymentId: ids[i], method: p.method, amountCents: p.amountCents, ref: p.ref || '', cardLast4: p.cardLast4 || '', status: p.status || 'paid' })),
        status: t.awaiting ? (t.confirmed ? 'part' : 'awaiting') : 'paid', owedBefore: owedNow, owedAfter: owedNow - t.confirmed,
        tenderedCents: t.cashTendered || 0, changeCents: t.cashPay ? t.cashPay.changeCents : 0, note: clean(b.note, 300),
        cashierUid: ctx.user.id, cashierName: ctx.user.name, clientCreatedAt: clean(b.clientCreatedAt, 40) || now, ...stamp, serverReceivedAt: now, updatedAt: now
      };
      const writes = [num.write, { create: true, coll: 'accountPayments', id, data: doc }];
      t.pays.forEach((p, i) => writes.push({ create: true, coll: 'payments', id: ids[i], data: { docType: 'accountPayment', docId: id, docNo: num.docNo, registerId: ctx.registerId || '', shiftId: ctx.shiftId || '', ...p, ...stamp, serverReceivedAt: now } }));
      const cPatch = { accountBalanceCents: owedNow - t.confirmed, accountAwaitingCents: awaitingNow + t.awaiting, lastAccountPaymentAt: t.confirmed ? now : cur.lastAccountPaymentAt || '', ...(t.creditUsed ? { storeCreditCents: (cur.storeCreditCents || 0) - t.creditUsed } : {}), updatedAt: now, updatedBy: 'server' };
      writes.push({ update: true, coll: 'customers', id: c.id, data: cPatch });
      writes.push(auditRow(ctx, 'customer.accountPayment', c.id, { docNo: num.docNo, amountCents: t.paid, confirmedCents: t.confirmed, awaitingCents: t.awaiting, methods: doc.methods, owedAfter: doc.owedAfter }, stamp, now));
      return { writes, result: { payment: { id, ...doc }, payments: t.pays.map((p, i) => ({ ...p, id: ids[i] })), customer: { ...cur, ...cPatch, id: c.id } } };
    } });
  },
  async confirmAccountPayment(event, b) { return bankAccountPayment(event, b, true); },
  async voidAccountPayment(event, b) { return bankAccountPayment(event, b, false); },

  // the account statement: every invoice put on account and every payment, oldest first, with the running balance
  async statement(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const c = await loadCustomer(ctx, b.customerId);
    const st = await statementOf(ctx.entityId, c);
    return { ok: true, customer: { id: c.id, name: c.name, phone: c.phone || '', email: c.email || '', vatNo: c.vatNo || '', address: c.address || {}, accountEnabled: !!c.accountEnabled, creditLimitCents: c.creditLimitCents || 0 }, ...st };
  },

  // the old system's customers and balances, taken on once (see the header)
  async takeOn(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    if (ctx.user.role !== 'owner') throw new Reject(403, 'The take-on is the owner’s.');
    const batchId = clean(b.batchId, 60) || 'takeon';
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 100);
    if (!rows.length) throw new Reject(400, 'No rows.');
    const exceptions = [];
    const skip = (r, why) => exceptions.push({ line: r.line || 0, name: clean(r.name, 120), phone: clean(r.phone, 30), why });
    return runSale(ctx, {}, { more: async (tx) => {
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId);
      const writes = [];
      let created = 0, updated = 0, owedCents = 0, creditCents = 0;
      const seen = new Set();
      for (const r of rows) {
        const name = clean(r.name, 120), phone = clean(r.phone, 30), pk = phoneOk(phone) ? phoneKey(phone) : '';
        const owed = int(r.owedCents) || 0, credit = int(r.creditCents) || 0, limit = Math.max(0, int(r.limitCents) || 0), ref = clean(r.creditRef, 80);
        if (!name) { skip(r, 'no name'); continue; }
        if (!pk) { skip(r, phone ? 'the cell number does not look right' : 'no cell number: add the customer by hand, then take the balance on'); continue; }
        if (seen.has(pk)) { skip(r, 'the same cell number twice in the file'); continue; }
        seen.add(pk);
        const key = await getDoc('customerPhones', keyId(ctx.entityId, pk), tx);
        const cur = key ? await getDoc('customers', key.customerId, tx) : null;
        if (cur && cur.takeOn) { skip(r, `already taken on (${cur.takeOn.batchId}, ${String(cur.takeOn.at).slice(0, 10)})`); continue; }
        if (owed < 0) skip(r, `the account is in credit by R ${(-owed / 100).toFixed(2)}: decide (store credit with a document, or a refund) and add it by hand`);
        if (credit < 0) skip(r, `a negative store credit (R ${(credit / 100).toFixed(2)}) was not taken on`);
        if (credit > 0 && !ref) skip(r, `store credit R ${(credit / 100).toFixed(2)} without a document reference was not taken on`);
        const owedOn = owed > 0 ? owed : 0, creditOn = credit > 0 && ref ? credit : 0;
        const a = r.address || {};
        const address = { line1: clean(a.line1, 120), line2: clean(a.line2, 120), city: clean(a.city, 80), code: clean(a.code, 12) };
        const email = clean(r.email, 120).toLowerCase();
        const take = { batchId, at: now, owedCents: owedOn, creditCents: creditOn, creditRef: ref, byName: ctx.user.name };
        if (cur) {
          const data = { takeOn: take, updatedAt: now, updatedBy: ctx.user.id };
          if (!cur.email && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { data.email = email; data.emailKey = emailKey(email); }
          if (!cur.vatNo && clean(r.vatNo, 20)) data.vatNo = clean(r.vatNo, 20);
          if (!(cur.address && (cur.address.line1 || cur.address.city)) && (address.line1 || address.city)) data.address = address;
          if (owedOn) { data.accountEnabled = true; data.creditLimitCents = Math.max(cur.creditLimitCents || 0, limit, owedOn); data.accountBalanceCents = (cur.accountBalanceCents || 0) + owedOn; }
          else if (limit) { data.accountEnabled = true; data.creditLimitCents = Math.max(cur.creditLimitCents || 0, limit); }
          if (creditOn) data.storeCreditCents = (cur.storeCreditCents || 0) + creditOn;
          writes.push({ update: true, coll: 'customers', id: key.customerId, data });
          updated++;
        } else {
          const id = randomId('cu_');
          writes.push({ create: true, coll: 'customers', id, data: { name, contact: name, phone, phoneKey: pk, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '', emailKey: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? emailKey(email) : '', vatNo: clean(r.vatNo, 20), address, dob: '', tags: ['take-on'], notes: 'Taken on from the old system', consent: blankConsent(),
            accountEnabled: !!(owedOn || limit), creditLimitCents: Math.max(limit, owedOn), storeCreditCents: creditOn, accountBalanceCents: owedOn, accountAwaitingCents: 0, loyalty: blankLoyalty(), stats: blankStats(), mergedIds: [], altPhones: [], mergedInto: '', anonymised: false, anonymisedAt: '', archived: false, takeOn: take, ...stamp, serverReceivedAt: now } });
          writes.push({ set: true, coll: 'customerPhones', id: keyId(ctx.entityId, pk), data: { customerId: id, entityId: ctx.entityId, storeId: '', updatedAt: now } });
          created++;
        }
        owedCents += owedOn; creditCents += creditOn;
      }
      writes.push(auditRow(ctx, 'customer.takeOn', '', { batchId, rows: rows.length, created, updated, owedCents, creditCents, exceptions: exceptions.length }, stamp, now));
      return { writes, result: { created, updated, owedCents, creditCents, exceptions } };
    } });
  },

  async adjustPoints(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'customer', 'manager', 'Adjusting points');
    const c = await loadCustomer(ctx, b.customerId);
    const pts = int(b.points); const note = clean(b.note, 200);
    if (!pts) throw new Reject(400, 'How many points, plus or minus?');
    const adjustId = clean(b.adjustId, 80);
    if (adjustId) { const dup = await query('loyaltyLedger', [{ field: 'entityId', value: ctx.entityId }, { field: 'customerId', value: c.id }, { field: 'docNo', value: adjustId }], 1); if (dup.length) return { ok: true, again: true, points: dup[0].balanceAfter }; }
    if (!note) throw new Reject(400, 'Say why.');
    const ls = loyaltySettings(ctx.settings);
    return runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('customers', c.id, tx);
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId);
      const lo = { ...blankLoyalty(), ...(cur.loyalty || {}) };
      const sw = sweep(lo, now);
      let lots = sw.lots;
      if (pts > 0) lots = [...lots, { points: pts, left: pts, earnedAt: now, expiresAt: ls.expiryMonths ? new Date(Date.parse(nowIso()) + ls.expiryMonths * 30 * 86400000).toISOString() : '', saleId: '' }];
      else { if (-pts > sw.points) throw new Reject(400, `Only ${sw.points} points to take.`); let need = -pts; lots = lots.map(l => { const take = Math.min(l.left, need); need -= take; return { ...l, left: l.left - take }; }).filter(l => l.left > 0); }
      const after = lots.reduce((n, l) => n + l.left, 0);
      const loyalty = { ...lo, points: after, lots, tier: tierFor(ls, lo.lifetimeCents).name };
      return { writes: [{ update: true, coll: 'customers', id: c.id, data: { loyalty, updatedAt: now, updatedBy: ctx.user.id } }, { create: true, coll: 'loyaltyLedger', id: randomId('lp_'), data: { customerId: c.id, kind: 'adjust', points: pts, balanceAfter: after, saleId: '', docNo: adjustId, note, expiresAt: '', ...stamp, serverReceivedAt: now } }, auditRow(ctx, 'customer.points', c.id, { points: pts, note }, stamp, now)], result: { points: after } };
    } });
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
    console.error('pos-customer failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};

// every request works in its own customer's space (lib/pos.mjs)
export const handler = withGroup(handleRequest);
