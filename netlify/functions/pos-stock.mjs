// Retail POS — stock control: adjustments, quarantine moves and stock
// takes. Stock on hand stays the sum of movements; this function only ever
// adds movements (and freezes, counts and posts a stock take).
//
//   adjust     { productId, variantId, qty (signed), bucket: 'onHand'|'quarantine', code, note, unitCostCents?, approvalToken? }   a manager
//   move       { productId, variantId, qty, from, to }     on hand ⇄ quarantine; a supervisor
//   takeOpen   { name, scope: 'all'|'category', category }   freezes a snapshot of every stock item in the store; a supervisor
//   takeCount  { takeId, counts: [ { itemId, qty, mode: 'add'|'set' } ] }   any member of the store, from any phone
//   takeReview { takeId }      counting closed, the variances to look at; a supervisor
//   takePost   { takeId, approvalToken? }   a manager: one 'count' movement per variance against the frozen figure
//   takeCancel { takeId }
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, createDoc, patchDoc, serverStamp, bodyOf, audit } from './lib/pos.mjs';
import { whoAndWhere, runSale, moveWrites, approved, int } from './lib/sale.mjs';

export const ADJUST_CODES = ['damaged', 'stolen', 'found', 'correction', 'sample', 'writeoff', 'other'];
const MAX_VARIANCES = 200;   // one transaction: a movement and a level per variance

async function itemOf(ctx, b) {
  const p = await getDoc('products', clean(b.productId, 60));
  if (!p || p.entityId !== ctx.entityId) throw new Reject(400, 'No such product here.');
  let v = null;
  if (b.variantId) { v = await getDoc('variants', clean(b.variantId, 60)); if (!v || v.productId !== p.id) throw new Reject(400, 'No such variant.'); }
  else if (p.hasVariants) throw new Reject(400, `${p.name} needs a variant.`);
  if (p.type !== 'stock' || p.trackStock === false) throw new Reject(400, `${p.name} does not hold stock.`);
  return { p, v, itemId: v ? v.id : p.id, productId: p.id, variantId: v ? v.id : '', name: p.name + (v ? ' · ' + v.name : ''), costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0 };
}
async function levelFor(tx, ctx, levels, itemId) { const lid = ctx.storeId + '_' + itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); return lid; }
const auditRow = (ctx, action, doc, details, approvers, stamp, now) => ({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action, docType: doc.docType, docId: doc.docId, docNo: doc.docNo || '', actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...approvers.keys()][0] || '', overrideName: [...approvers.values()][0] || '', details, ...stamp, serverReceivedAt: now } });
async function loadTake(ctx, id) {
  id = clean(id, 80);
  const t = await getDoc('stockTakes', id);
  if (!t || t.entityId !== ctx.entityId || t.storeId !== ctx.storeId) throw new Reject(404, 'No such stock take at this store.');
  return { ...t, id };
}
const tally = (items) => { let counted = 0, vq = 0, vv = 0; for (const it of items) { if (it.countedQty == null) continue; counted++; const d = it.countedQty - it.frozenQty; vq += d; vv += d * (it.costCents || 0); } return { countedItems: counted, varianceQty: vq, varianceValueCents: vv }; };

const actions = {
  async adjust(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'stock', 'manager', 'A stock adjustment'); if (!a.self) approvers.set(a.uid, a.name);
    const it = await itemOf(ctx, b);
    const qty = int(b.qty);
    if (!qty || Math.abs(qty) > 100000) throw new Reject(400, 'How many? A signed number: 3 found, -2 damaged.');
    const bucket = b.bucket === 'quarantine' ? 'quarantine' : 'onHand';
    const code = ADJUST_CODES.includes(b.code) ? b.code : 'other';
    const note = clean(b.note, 200);
    if (code === 'other' && !note) throw new Reject(400, 'Say why.');
    const unitCost = b.unitCostCents != null && int(b.unitCostCents) >= 0 ? int(b.unitCostCents) : it.costCents;
    const docId = clean(b.adjustId, 80);
    if (!/^[\w:.-]{8,80}$/.test(docId)) throw new Reject(400, 'The adjustment has no id.');
    const dup = await query('stockMovements', [{ field: 'entityId', value: ctx.entityId }, { field: 'docType', value: 'adjust' }, { field: 'docId', value: docId }], 1);
    if (dup.length) return { ok: true, again: true, movement: dup[0], level: await getDoc('stockLevels', ctx.storeId + '_' + it.itemId) };
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const lid = await levelFor(tx, ctx, levels, it.itemId);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = moveWrites(ctx, levels, { productId: it.productId, variantId: it.variantId, itemId: it.itemId, qty, bucket, reason: 'adjust', code, unitCostCents: unitCost, baseCostCents: it.costCents, wac: qty > 0, name: it.name, note, byName: a.name }, { docType: 'adjust', docId, docNo: '' }, stamp, now);
      writes.push(auditRow(ctx, 'stock.adjust', { docType: 'adjust', docId }, { item: it.name, itemId: it.itemId, qty, bucket, code, note, unitCostCents: unitCost }, approvers, stamp, now));
      return { writes, result: { level: { ...levels.get(lid), id: lid }, movement: writes[0].data } };
    } });
  },

  async move(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'stock', 'supervisor', 'Moving stock to or from quarantine'); if (!a.self) approvers.set(a.uid, a.name);
    const it = await itemOf(ctx, b);
    const qty = int(b.qty);
    if (!(qty > 0)) throw new Reject(400, 'How many?');
    const from = b.from === 'quarantine' ? 'quarantine' : 'onHand', to = b.to === 'quarantine' ? 'quarantine' : 'onHand';
    if (from === to) throw new Reject(400, 'From and to are the same.');
    const docId = clean(b.moveId, 80);
    if (!/^[\w:.-]{8,80}$/.test(docId)) throw new Reject(400, 'The move has no id.');
    const dup = await query('stockMovements', [{ field: 'entityId', value: ctx.entityId }, { field: 'docType', value: 'quarantine' }, { field: 'docId', value: docId }], 1);
    if (dup.length) return { ok: true, again: true, level: await getDoc('stockLevels', ctx.storeId + '_' + it.itemId) };
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const lid = await levelFor(tx, ctx, levels, it.itemId);
      const lv = levels.get(lid) || {};
      if ((from === 'quarantine' ? lv.quarantineQty || 0 : lv.onHandQty || 0) < qty) throw new Reject(400, `Only ${from === 'quarantine' ? lv.quarantineQty || 0 : lv.onHandQty || 0} in ${from === 'quarantine' ? 'quarantine' : 'stock'}.`);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const base = { productId: it.productId, variantId: it.variantId, itemId: it.itemId, reason: 'quarantine', unitCostCents: it.costCents, name: it.name, note: clean(b.note, 200), byName: a.name };
      const writes = [...moveWrites(ctx, levels, { ...base, qty: -qty, bucket: from }, { docType: 'quarantine', docId, docNo: '' }, stamp, now), ...moveWrites(ctx, levels, { ...base, qty, bucket: to }, { docType: 'quarantine', docId, docNo: '' }, stamp, now)];
      writes.push(auditRow(ctx, 'stock.move', { docType: 'quarantine', docId }, { item: it.name, itemId: it.itemId, qty, from, to }, approvers, stamp, now));
      return { writes, result: { level: { ...levels.get(lid), id: lid } } };
    } });
  },

  // the snapshot: every stock item in the store (or a category) with what the system says is on hand right now
  async takeOpen(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'stock', 'supervisor', 'Opening a stock take');
    for (const st of ['open', 'review']) { const live = await query('stockTakes', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }, { field: 'status', value: st }], 1); if (live.length) throw new Reject(409, `Stock take “${live[0].name}” is still ${st === 'open' ? 'being counted' : 'in review'}: post or cancel it first.`); }
    const scope = b.scope === 'category' ? 'category' : 'all';
    const category = clean(b.category, 80);
    if (scope === 'category' && !category) throw new Reject(400, 'Which category?');
    const [levels, products, variants] = await Promise.all([query('stockLevels', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }], 5000), query('products', [{ field: 'entityId', value: ctx.entityId }], 5000), query('variants', [{ field: 'entityId', value: ctx.entityId }], 10000)]);
    const byId = new Map(levels.map(l => [l.id, l]));
    const items = [];
    for (const p of products) {
      if (p.type !== 'stock' || p.trackStock === false || p.archived) continue;
      if (scope === 'category' && (p.category || '') !== category) continue;
      const vs = p.hasVariants ? variants.filter(v => v.productId === p.id && !v.archived) : [null];
      for (const v of vs) {
        const itemId = v ? v.id : p.id; const lv = byId.get(ctx.storeId + '_' + itemId);
        items.push({ itemId, productId: p.id, variantId: v ? v.id : '', name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcodes: ((v && v.barcodes) || p.barcodes || []).slice(0, 5), frozenQty: lv ? lv.onHandQty || 0 : 0, countedQty: null, countedBy: '', countedAt: '', costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0 });
      }
    }
    if (!items.length) throw new Reject(400, 'Nothing to count: no stock items' + (scope === 'category' ? ' in that category' : '') + '.');
    if (items.length > 3000) throw new Reject(400, `${items.length} items is too many for one stock take: count by category.`);
    items.sort((x, y) => x.name.localeCompare(y.name));
    const now = nowIso(); const id = randomId('tk_');
    const take = { name: clean(b.name, 80) || 'Stock take ' + now.slice(0, 10), scope, category, status: 'open', frozenAt: now, items, itemCount: items.length, countedItems: 0, log: [], varianceQty: 0, varianceValueCents: 0, openedBy: ctx.user.name, reviewedAt: '', reviewedBy: '', postedAt: '', approvedBy: '', movementCount: 0, cancelledAt: '', ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId), updatedAt: now };
    await createDoc('stockTakes', id, take);
    await audit({ action: 'stock.takeOpen', docType: 'stockTake', docId: id, docNo: take.name, actorUid: ctx.user.id, actorName: ctx.user.name, details: { scope, category, items: items.length }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, take: { ...take, id } };
  },

  // counts from any phone, merged into the take as they come
  async takeCount(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const t = await loadTake(ctx, b.takeId);
    const counts = (Array.isArray(b.counts) ? b.counts : []).map(c => ({ itemId: clean(c.itemId, 60), qty: int(c.qty), mode: c.mode === 'set' ? 'set' : 'add' }));
    if (!counts.length || counts.length > 200) throw new Reject(400, 'Nothing to count.');
    for (const c of counts) if (!(c.qty >= 0) || c.qty > 100000 || (c.mode === 'add' && c.qty === 0)) throw new Reject(400, 'A count is a whole number, nought or more.');
    return runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('stockTakes', t.id, tx);
      if (!cur || cur.status !== 'open') throw new Reject(409, `Stock take “${t.name}” is ${cur ? cur.status : 'gone'}: no more counting.`);
      const now = nowIso();
      const items = cur.items.map(x => ({ ...x }));
      const log = [...(cur.log || [])];
      for (const c of counts) {
        const it = items.find(x => x.itemId === c.itemId);
        if (!it) throw new Reject(400, `That item is not in this stock take${cur.scope === 'category' ? ' (category ' + cur.category + ')' : ''}.`);
        it.countedQty = c.mode === 'set' ? c.qty : (it.countedQty || 0) + c.qty; it.countedBy = ctx.user.name; it.countedAt = now;
        log.push({ at: now, byName: ctx.user.name, itemId: c.itemId, qty: c.qty, mode: c.mode, deviceId: ctx.deviceId });
      }
      const patch = { items, log: log.slice(-3000), ...tally(items), updatedAt: now };
      return { writes: [{ update: true, coll: 'stockTakes', id: t.id, data: patch }], result: { take: { ...cur, ...patch, id: t.id } } };
    } });
  },

  async takeReview(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'stock', 'supervisor', 'Closing the count');
    const t = await loadTake(ctx, b.takeId);
    if (t.status !== 'open') throw new Reject(409, `Stock take “${t.name}” is ${t.status}.`);
    const now = nowIso();
    const patch = { status: 'review', reviewedAt: now, reviewedBy: ctx.user.name, updatedAt: now };
    await patchDoc('stockTakes', t.id, patch);
    await audit({ action: 'stock.takeReview', docType: 'stockTake', docId: t.id, docNo: t.name, actorUid: ctx.user.id, actorName: ctx.user.name, details: tally(t.items), entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, take: { ...t, ...patch } };
  },
  async takeReopen(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'stock', 'supervisor', 'Reopening the count');
    const t = await loadTake(ctx, b.takeId);
    if (t.status !== 'review') throw new Reject(409, `Stock take “${t.name}” is ${t.status}.`);
    const now = nowIso();
    await patchDoc('stockTakes', t.id, { status: 'open', reviewedAt: '', reviewedBy: '', updatedAt: now });
    await audit({ action: 'stock.takeReopen', docType: 'stockTake', docId: t.id, docNo: t.name, actorUid: ctx.user.id, actorName: ctx.user.name, details: {}, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, take: { ...t, status: 'open' } };
  },

  // the variances become movements against the frozen figure; what sold meanwhile is already in the level
  async takePost(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'stock', 'manager', 'Posting a stock take'); if (!a.self) approvers.set(a.uid, a.name);
    const t = await loadTake(ctx, b.takeId);
    if (t.status !== 'review') throw new Reject(409, `Stock take “${t.name}” is ${t.status}: review it first.`);
    const counted = t.items.filter(x => x.countedQty != null);
    const diffs = counted.filter(x => x.countedQty !== x.frozenQty);
    if (diffs.length > MAX_VARIANCES) throw new Reject(400, `${diffs.length} variances is too many for one posting: count by category.`);
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('stockTakes', t.id, tx);
      if (!cur || cur.status !== 'review') throw new Reject(409, `Stock take “${t.name}” is no longer in review.`);
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      for (const x of diffs) {
        await levelFor(tx, ctx, levels, x.itemId);
        writes.push(...moveWrites(ctx, levels, { productId: x.productId, variantId: x.variantId, itemId: x.itemId, qty: x.countedQty - x.frozenQty, bucket: 'onHand', reason: 'count', unitCostCents: x.costCents, name: x.name, note: `Counted ${x.countedQty}, expected ${x.frozenQty}`, byName: a.name, countedAt: now }, { docType: 'stockTake', docId: t.id, docNo: t.name }, stamp, now));
      }
      // counted and found right: only the date moves
      for (const x of counted.filter(y => y.countedQty === y.frozenQty)) { const lid = await levelFor(tx, ctx, levels, x.itemId); if (levels.get(lid)) writes.push({ update: true, coll: 'stockLevels', id: lid, data: { lastCountedAt: now } }); }
      const patch = { status: 'posted', postedAt: now, approvedBy: a.name, movementCount: diffs.length, ...tally(cur.items), updatedAt: now };
      writes.push({ update: true, coll: 'stockTakes', id: t.id, data: patch });
      writes.push(auditRow(ctx, 'stock.takePost', { docType: 'stockTake', docId: t.id, docNo: t.name }, { movements: diffs.length, ...tally(cur.items) }, approvers, stamp, now));
      return { writes, result: { take: { ...cur, ...patch, id: t.id }, movements: diffs.length } };
    } });
  },

  async takeCancel(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'stock', 'supervisor', 'Cancelling a stock take');
    const t = await loadTake(ctx, b.takeId);
    if (!['open', 'review'].includes(t.status)) throw new Reject(409, `Stock take “${t.name}” is ${t.status}.`);
    const now = nowIso();
    await patchDoc('stockTakes', t.id, { status: 'cancelled', cancelledAt: now, updatedAt: now });
    await audit({ action: 'stock.takeCancel', docType: 'stockTake', docId: t.id, docNo: t.name, actorUid: ctx.user.id, actorName: ctx.user.name, details: {}, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, take: { ...t, status: 'cancelled' } };
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
    console.error('pos-stock failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};
