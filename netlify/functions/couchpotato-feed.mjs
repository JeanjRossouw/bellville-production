// One-way order feed: Bellville Furniture → Couch Potato's factory system,
// with the dispatch status flowing back.
//
// Runs on a schedule (every 15 minutes) and can be run by hand:
//   GET /.netlify/functions/couchpotato-feed?k=<FEED_KEY>          → sync now, report as text
//   GET /.netlify/functions/couchpotato-feed?k=<FEED_KEY>&dry=1    → show what WOULD happen
//
// What crosses the boundary, and nothing else:
//   →  Bellville / PinkFoot orders assigned to the supplier become orders in
//      Couch Potato's system, once each (create-only, keyed on the Bellville
//      order id). Couch Potato's own edits are never overwritten.
//   ←  When Couch Potato scans an order out, the Bellville order is marked
//      DONE by the supplier, with a note in its comment thread, so it moves
//      to Bellville's Delivery portal exactly as if the supplier had ticked it.
//
// Env (Netlify → Site configuration → Environment variables):
//   FIREBASE_SERVICE_ACCOUNT      Bellville's (already set for the Shopify sync)
//   COUCHPOTATO_SERVICE_ACCOUNT   the app's Firebase project service-account JSON
//   COUCHPOTATO_COMPANY_ID        Couch Potato's company id in the app (Settings → Team)
//   COUCHPOTATO_CUSTOMER_ID       the Bellville Furniture customer's id in Couch Potato's system
//   COUCHPOTATO_CUSTOMER_NAME     optional, default "Bellville Furniture"
//   COUCHPOTATO_BUILDER_NAME      optional, the supplier name as stored in Bellville, default "Couch Patato"
//   FEED_KEY                      optional, for running by hand
import { readDoc, writeDoc } from './lib/firestore.mjs';
import { createIfMissing, query } from './lib/cp-firestore.mjs';

export const config = { schedule: '*/15 * * * *' };

const BIZ = { bellville: 'Bellville', pinkfoot: 'PinkFoot' };
const builderName = () => (process.env.COUCHPOTATO_BUILDER_NAME || 'Couch Patato').trim().toLowerCase();
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

// ----------------------------------------------------------- pure logic ----

export const feedKey = (biz, orderId) => 'bv-' + biz + '-' + String(orderId).replace(/[^A-Za-z0-9_-]/g, '_');

export function customSizeText(o) {
  const cs = o && o.customSize;
  if (!cs) return '';
  const n = (v) => parseFloat(v) > 0 ? parseFloat(v) : 0;
  const parts = [];
  if (n(cs.lengthMm)) parts.push('L' + n(cs.lengthMm));
  if (n(cs.depthMm)) parts.push('D' + n(cs.depthMm));
  if (n(cs.heightMm)) parts.push('H' + n(cs.heightMm));
  let t = parts.length ? parts.join(' × ') + ' mm' : '';
  const side = cs.daybedSide || '';
  const dl = n(cs.daybedLengthMm) ? ' (' + n(cs.daybedLengthMm) + 'mm)' : '';
  if (side === 'left' || side === 'right') t += (t ? ' · ' : '') + 'daybed ' + side.toUpperCase() + dl;
  else if (side === 'u') t += (t ? ' · ' : '') + 'U-shape, daybeds both sides' + dl;
  else if (side === 'corner-left' || side === 'corner-right') t += (t ? ' · ' : '') + 'corner unit, ' + side.replace('corner-', '') + ' hand' + dl;
  if (n(cs.cushions)) t += (t ? ' · ' : '') + n(cs.cushions) + ' seat cushions';
  if (cs.note) t += (t ? ' · ' : '') + cs.note;
  return t;
}

// Which Bellville orders belong to the supplier and are still live.
export function ordersForSupplier(data, name) {
  const out = [];
  Object.keys(BIZ).forEach(biz => {
    ((data[biz] && data[biz].orders) || []).forEach(o => {
      if (!o || !o.id) return;
      if (String(o.builder || '').trim().toLowerCase() !== (name || builderName())) return;
      if (o.status === 'delivered' || o.status === 'cancelled') return;
      out.push({ biz, o });
    });
  });
  return out;
}

// The Couch Potato order document for a Bellville order.
export function mapOrder(biz, o, env) {
  env = env || process.env;
  const size = customSizeText(o);
  const notes = [o.notes, size ? 'Custom size: ' + size : '', biz === 'pinkfoot' ? 'PinkFoot Boutique order' : '',
    o.category ? 'Category: ' + o.category : ''].filter(Boolean).join('\n');
  const paid = o.paidDate || o.orderDate || today();
  return {
    orderNo: 'BV-' + (o.invoice || o.id),
    externalRef: String(o.invoice || ''),
    feedKey: feedKey(biz, o.id),
    source: 'feed',
    customerId: env.COUCHPOTATO_CUSTOMER_ID || '',
    customerName: env.COUCHPOTATO_CUSTOMER_NAME || 'Bellville Furniture',
    product: o.product || '',
    qty: parseInt(o.qty, 10) || 1,
    fabric: o.fabric || '',
    fabricStatus: o.fabricStatus === 'received' ? 'received' : o.fabricStatus === 'ordered' ? 'ordered' : 'none',
    notes,
    paidDate: paid,
    dueDate: o.dueDate || '',
    priceEach: 0,
    status: 'new',
    events: [{ at: nowIso(), by: 'Bellville feed', what: 'Received automatically from ' + (env.COUCHPOTATO_CUSTOMER_NAME || 'Bellville Furniture') + ' (their ' + BIZ[biz] + ' order #' + (o.invoice || o.id) + ')' }],
    createdAt: nowIso(), createdBy: 'Bellville feed', updatedAt: nowIso(), updatedBy: 'Bellville feed'
  };
}

// Mark the Bellville orders whose Couch Potato twins have left the factory.
// Mutates `data`; returns the list of changes made.
export function applyDispatches(data, cpDispatched) {
  const byKey = {};
  cpDispatched.forEach(c => { if (c.feedKey) byKey[c.feedKey] = c; });
  const changes = [];
  Object.keys(BIZ).forEach(biz => {
    ((data[biz] && data[biz].orders) || []).forEach(o => {
      if (!o || !o.id || o.builderDone) return;
      const cp = byKey[feedKey(biz, o.id)];
      if (!cp) return;
      const when = String(cp.dispatchedAt || today()).slice(0, 10);
      o.builderDone = true;
      o.builderDoneAt = when;
      if (!Array.isArray(o.builderComments)) o.builderComments = [];
      o.builderComments.push({ by: cp.customerSupplierName || 'Couch Potato', at: nowIso(),
        text: '✅ Dispatched from the factory on ' + when + (cp.dispatchedBy ? ' by ' + cp.dispatchedBy : '') + ' (their order ' + (cp.orderNo || '') + ')' });
      changes.push({ biz, id: o.id, invoice: o.invoice, when });
    });
  });
  return changes;
}

// ----------------------------------------------------------- the sync ------

export async function runSync(opts) {
  const dry = !!(opts && opts.dry);
  const log = [];
  const data = await readDoc('production');

  // → push new supplier orders into Couch Potato
  const mine = ordersForSupplier(data);
  let created = 0, skipped = 0;
  for (const { biz, o } of mine) {
    const doc = mapOrder(biz, o);
    if (dry) { log.push('would push ' + doc.orderNo + ' (' + doc.product + ')'); continue; }
    const made = await createIfMissing('orders', doc.feedKey, doc);
    if (made) { created++; log.push('pushed ' + doc.orderNo + ' — ' + doc.product); } else skipped++;
  }

  // ← pull dispatches back
  const cpDone = await query('orders', { source: 'feed', status: ['dispatched', 'invoiced'] });
  const fresh = dry ? data : await readDoc('production');       // re-read right before writing: smallest possible window
  const changes = applyDispatches(fresh, cpDone);
  if (changes.length && !dry) {
    await writeDoc('production', fresh, 'couchpotato-feed');
  }
  changes.forEach(c => log.push((dry ? 'would mark' : 'marked') + ' #' + (c.invoice || c.id) + ' (' + c.biz + ') done by supplier, dispatched ' + c.when));

  return { dry, supplierOrders: mine.length, created, alreadyThere: skipped, dispatchedBack: changes.length, log };
}

export const handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const manual = !!(event && event.httpMethod === 'GET');
  if (manual) {
    const key = process.env.FEED_KEY;
    if (!key || (q.k || '') !== key) return { statusCode: 403, body: 'Forbidden: set FEED_KEY and pass ?k=' };
  }
  try {
    const r = await runSync({ dry: manual && q.dry === '1' });
    const text = (r.dry ? 'DRY RUN\n' : '') + `supplier orders: ${r.supplierOrders} · pushed: ${r.created} · already there: ${r.alreadyThere} · marked done back in Bellville: ${r.dispatchedBack}\n` + r.log.join('\n');
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
  } catch (e) {
    console.error('couchpotato-feed failed:', e);
    return { statusCode: 500, body: 'Feed failed: ' + e.message };
  }
};
