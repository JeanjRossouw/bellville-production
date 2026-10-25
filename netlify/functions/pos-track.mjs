// Retail POS — the client's own page for a sales order or a quotation (pos/track.html),
// opened from the private link the shop sends on WhatsApp. No login: the token is the key,
// and the answer carries only what the client should see (no costs, no staff notes).
//
//   view    { t }                              → { kind: 'order' | 'quote', … }
//   accept  { t, name, signature }             a quotation accepted and signed by the client (open, in date, once)
//
// The shop sees an accepted quote on its To-do board and turns it into a sales order at the till.
import { json, Reject, clean, getTop, getDoc, patchDoc, inGroup, nowIso, audit, bodyOf, GROUP_RE } from './lib/pos.mjs';
import { TRACK_COLL, tokenOk } from './lib/track.mjs';
import { SPEC_FIELDS } from '../../pos/js/special-terms.js';

const saToday = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const ORDER_STEPS = [['placed', 'Order placed'], ['inProduction', 'Being made'], ['ready', 'Ready'], ['booked', 'Delivery booked'], ['done', 'Delivered']];
const STEP_OF = { quoted: -1, depositPaid: 0, inProduction: 1, ready: 2, delivered: 4, collected: 4 };

async function linkOf(t) {
  if (!tokenOk(t)) throw new Reject(404, 'This link is not right: ask the shop to send it again.');
  const l = await getTop('posTrack/' + t);
  if (!l || !GROUP_RE.test(l.gid || '') || !TRACK_COLL[l.kind]) throw new Reject(404, 'This link is not right: ask the shop to send it again.');
  return l;
}
const specOf = (sp) => sp && typeof sp === 'object' ? SPEC_FIELDS.filter(([k]) => sp[k]).map(([k, label]) => label + ': ' + String(sp[k]).slice(0, 200)) : [];
const linesOf = (lines) => (lines || []).map(l => ({ qty: l.qty, name: l.name, spec: specOf(l.spec), totalCents: l.netCents != null ? l.netCents : l.lineTotalCents }));

async function shopOf(entityId, storeId) {
  const e = (await getDoc('entities', entityId)) || {};
  const s = storeId ? (await getDoc('stores', storeId)) || {} : {};
  const a = s.address || {};
  return { name: e.tradingName || e.legalName || '', store: s.name || '', phone: s.phone || '', email: s.email || '', address: [a.line1, a.line2, a.city].filter(Boolean).join(', ') };
}

function orderView(so, shop) {
  const done = /^(delivered|collected)$/.test(so.status);
  const dv = so.delivery || null;
  let at = STEP_OF[so.status] != null ? STEP_OF[so.status] : -1;
  if (at === 2 && dv) at = 3;
  const steps = ORDER_STEPS.map(([key, label], i) => ({ key, label: key === 'done' && (so.status === 'collected' || (dv && dv.kind === 'collect')) ? 'Collected' : key === 'booked' && dv && dv.kind === 'collect' ? 'Collection booked' : label, done: at >= i, current: at === i }));
  return {
    kind: 'order', shop, docNo: so.docNo, status: so.status, cancelled: so.status === 'cancelled', done, steps,
    name: String((so.customerSnapshot || {}).name || '').split(' ')[0],
    openedAt: so.openedAt || so.createdAt || '', expectedAt: so.expectedAt || '',
    lines: linesOf(so.lines), totalCents: so.totalCents, paidCents: so.paidCents || 0, balanceCents: so.balanceCents || 0,
    minDepositCents: so.status === 'quoted' ? Math.max(0, (so.minDepositCents || 0) - (so.paidCents || 0)) : 0,
    payments: (so.history || []).map(h => ({ at: h.at, amountCents: h.amountCents })),
    delivery: dv ? { kind: dv.kind, date: dv.date, slot: dv.slot || '' } : null,
    completedAt: done ? so.completedAt || '' : '', invoiceNo: done ? so.completedDocNo || '' : ''
  };
}

function quoteView(q, shop) {
  const state = q.status === 'open' && String(q.validUntil) < saToday() ? 'expired' : q.status;
  return {
    kind: 'quote', shop, docNo: q.docNo, state, name: String((q.customerSnapshot || {}).name || '').split(' ')[0],
    quotedAt: q.quotedAt || q.createdAt || '', validUntil: q.validUntil, note: q.note || '',
    lines: linesOf(q.lines), totalCents: q.totalCents, vatCents: q.vatCents || 0, vatRegistered: !!q.vatRegistered,
    accepted: q.accepted ? { name: q.accepted.name, at: q.accepted.at } : null,
    usedAs: q.usedAs ? { kind: q.usedAs.kind, docNo: q.usedAs.docNo } : null
  };
}

const actions = {
  async view(b) {
    const l = await linkOf(clean(b.t, 60));
    return inGroup(l.gid, async () => {
      const doc = await getDoc(TRACK_COLL[l.kind], l.id);
      if (!doc || doc.trackToken !== b.t) throw new Reject(404, 'This link is not right: ask the shop to send it again.');
      const shop = await shopOf(doc.entityId, doc.storeId);
      return l.kind === 'order' ? orderView(doc, shop) : quoteView(doc, shop);
    });
  },

  async accept(b) {
    const l = await linkOf(clean(b.t, 60));
    if (l.kind !== 'quote') throw new Reject(400, 'Only a quotation is accepted here.');
    const name = clean(b.name, 120);
    if (!name) throw new Reject(400, 'Your name, as you sign.');
    const signature = String(b.signature || '').slice(0, 200000);
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new Reject(400, 'Sign in the box first.');
    return inGroup(l.gid, async () => {
      const q = await getDoc('quotes', l.id);
      if (!q || q.trackToken !== b.t) throw new Reject(404, 'This link is not right: ask the shop to send it again.');
      if (q.accepted) return { ...quoteView(q, await shopOf(q.entityId, q.storeId)), again: true };
      if (q.status !== 'open') throw new Reject(409, `Quotation ${q.docNo} is ${q.status === 'used' ? 'already an order' : 'no longer open'}: ask the shop.`);
      if (String(q.validUntil) < saToday()) throw new Reject(409, `Quotation ${q.docNo} expired on ${q.validUntil}: ask the shop for a new one.`);
      const now = nowIso();
      const accepted = { name, signature, at: now };
      await patchDoc('quotes', l.id, { accepted, todoDue: true, updatedAt: now });
      await audit({ action: 'quote.accepted', docType: 'quote', docId: l.id, docNo: q.docNo, actorUid: 'client', actorName: name, details: { via: 'link' }, entityId: q.entityId, storeId: q.storeId || '' });
      return quoteView({ ...q, accepted }, await shopOf(q.entityId, q.storeId));
    });
  }
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-track failed:', e);
    return json(500, { error: 'Something went wrong. Try again in a minute.' });
  }
};
