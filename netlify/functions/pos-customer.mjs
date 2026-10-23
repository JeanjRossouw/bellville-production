// Retail POS — customers: the cell number as the key, POPIA consent per
// channel with a date, history across the stores, merging duplicates, an
// export and an anonymisation on request, and loyalty points by hand.
// Only this function (and the sale core, for credit, points and stats)
// writes customers.
//
//   save         { customerId?, name, contact, phone, email, vatNo, address, dob, tags, notes, consent { whatsapp, sms, email } (booleans), consentSource,
//                  accountEnabled?, creditLimitCents? (a manager) }     → the customer; a cell number is one customer per company
//   consent      { customerId, channel, granted, source }
//   history      { customerId }                                         → sales, credit notes, lay-bys, custom orders, the points ledger
//   merge        { keepId, dropId }                                     a manager
//   export       { customerId }                                         a manager: the profile and history
//   anonymise    { customerId, reason }                                 a manager: the personal details wiped, the number freed
//   adjustPoints { customerId, points, note }                           a manager
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, serverStamp, bodyOf, audit, rank, withGroup } from './lib/pos.mjs';
import { whoAndWhere, runSale, approved, int } from './lib/sale.mjs';
import { CHANNELS, phoneKey, phoneOk, emailKey, loyaltySettings, sweep, tierFor, blankConsent, blankLoyalty, blankStats } from '../../pos/js/loyalty-terms.js';

const idOk = (id) => /^[\w:.-]{8,80}$/.test(id);
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

const actions = {
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
      const data = { name, contact: clean(b.contact, 120) || name, phone, phoneKey: pk, email, emailKey: emailKey(email), vatNo: clean(b.vatNo, 20), address, dob: /^\d{4}-\d{2}-\d{2}$/.test(b.dob || '') ? b.dob : (cur ? cur.dob || '' : ''), tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(t => clean(t, 30)).filter(Boolean).slice(0, 20), notes: clean(b.notes, 1000), consent, updatedAt: now, updatedBy: ctx.user.id };
      if (wantsAccount) { data.accountEnabled = !!b.accountEnabled; data.creditLimitCents = Math.max(0, int(b.creditLimitCents) || 0); }
      if (cur) writes.push({ update: true, coll: 'customers', id: cur.id, data });
      else writes.push({ create: true, coll: 'customers', id: newId, data: { ...data, accountEnabled: !!b.accountEnabled && mgr, creditLimitCents: mgr ? Math.max(0, int(b.creditLimitCents) || 0) : 0, storeCreditCents: 0, accountBalanceCents: 0, loyalty: blankLoyalty(), stats: blankStats(), mergedIds: [], altPhones: [], mergedInto: '', anonymised: false, anonymisedAt: '', archived: false, ...stamp } });
      writes.push(auditRow(ctx, cur ? 'customer.update' : 'customer.create', newId, { name, phoneKey: pk, consent: Object.fromEntries(CHANNELS.map(c => [c[0], consent[c[0]].granted])) }, stamp, now));
      const out = cur ? { ...cur, ...data } : { id: newId, ...writes.find(w => w.coll === 'customers').data };
      return { writes, result: { customer: { ...out, id: newId } } };
    } });
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
    const [sales, notes, laybys, orders, ledger] = await Promise.all([all('sales', 300), all('creditNotes', 100), all('laybys', 100), all('specialOrders', 100), query('loyaltyLedger', [{ field: 'entityId', value: ctx.entityId }, { field: 'customerId', value: c.id }], 200)]);
    const by = (x, y) => String(y.at).localeCompare(String(x.at));
    const ls = loyaltySettings(ctx.settings);
    const sw = sweep(c.loyalty, nowIso());
    return { ok: true, customer: c, loyalty: { ...ls, points: sw.points, expiringSoon: sw.lots.filter(l => l.expiresAt && Date.parse(l.expiresAt) - Date.now() < 30 * 86400000).reduce((n, l) => n + l.left, 0), tier: tierFor(ls, (c.loyalty || {}).lifetimeCents || 0).name, valueCents: sw.points * ls.pointValueCents },
      sales: sales.map(safeRow).sort(by), creditNotes: notes.map(n => ({ ...safeRow(n), saleDocNo: n.saleDocNo, refundedCents: n.refundedCents })).sort(by), laybys: laybys.map(l => ({ ...safeRow(l), paidCents: l.paidCents, balanceCents: l.balanceCents, dueAt: l.dueAt })).sort(by), specialOrders: orders.map(o => ({ ...safeRow(o), paidCents: o.paidCents, balanceCents: o.balanceCents, expectedAt: o.expectedAt })).sort(by),
      ledger: ledger.map(l => ({ at: l.createdAt, kind: l.kind, points: l.points, balanceAfter: l.balanceAfter, docNo: l.docNo || '', note: l.note || '', expiresAt: l.expiresAt || '' })).sort((x, y) => String(y.at).localeCompare(String(x.at))) };
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
      if (pts > 0) lots = [...lots, { points: pts, left: pts, earnedAt: now, expiresAt: ls.expiryMonths ? new Date(Date.now() + ls.expiryMonths * 30 * 86400000).toISOString() : '', saleId: '' }];
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
