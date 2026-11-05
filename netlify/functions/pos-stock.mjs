// Retail POS — stock control: adjustments, quarantine moves and stock
// takes. Stock on hand stays the sum of movements; this function only ever
// adds movements (and freezes, counts and posts a stock take).
//
//   adjust     { productId, variantId, qty (signed), bucket: 'onHand'|'quarantine', code, note, unitCostCents?, approvalToken? }   a manager
//   move       { productId, variantId, qty, from, to }     on hand ⇄ quarantine; a supervisor
//   takeOpen   { name, scope: 'all'|'category', category }   freezes a snapshot of every stock item in the store; a supervisor
//   takeCount  { takeId, counts: [ { itemId, qty, mode: 'add'|'set' } ] }   any member of the store, from any phone
//   takeReview { takeId }      counting closed, the variances to look at; a supervisor
//   takePost   { takeId, uncountedAsZero?, approvalToken? }   a manager: one 'count' movement per variance against the frozen figure, a batch a call
//              (the answer says done/left; call again until done); with uncountedAsZero, what nobody found is taken as 0
//   takeCancel { takeId }
//   takeItem { takeId, itemId }   a member of the store: add an item the freeze left out, or refresh one after an edit
//   productDelete { entityId, productIds: [...] }   a manager: gone for good, only products never used anywhere
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, createDoc, patchDoc, commit, serverStamp, bodyOf, audit, withGroup, requireMember, inEntity, atLeast } from './lib/pos.mjs';
import { whoAndWhere, runSale, moveWrites, approved, int } from './lib/sale.mjs';

export const ADJUST_CODES = ['damaged', 'stolen', 'found', 'correction', 'sample', 'writeoff', 'other'];
// posting goes in batches of this many variances (a movement and a level each, one transaction): the take keeps
// its place (postedUpTo) and the app calls again until it is posted, so a whole shop set to nought still fits
const TAKE_BATCH = Math.max(1, Number(process.env.POS_TAKE_BATCH) || 150);

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

export const actions = {
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

  // an item scanned mid-count that the freeze left out (new product, a barcode just attached, a category
  // the take was not frozen on): added to the open take with the level as it stands now, so what sold since
  // the freeze is not counted twice. The same call on an item already in the take refreshes its name, SKU
  // and barcodes after an edit; the frozen figure and the count stay.
  async takeItem(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const t = await loadTake(ctx, b.takeId);
    const itemId = clean(b.itemId, 60);
    if (!itemId) throw new Reject(400, 'Which item?');
    let v = null, p = await getDoc('products', itemId);
    if (!p) { v = await getDoc('variants', itemId); p = v ? await getDoc('products', v.productId) : null; }
    if (!p || p.entityId !== ctx.entityId) throw new Reject(404, 'No such product.');
    if (p.hasVariants && !v) throw new Reject(400, `${p.name} comes in variants: scan the variant's barcode.`);
    if (p.type !== 'stock' || p.trackStock === false || p.archived || (v && v.archived)) throw new Reject(400, `${p.name} does not hold stock, so it is not counted.`);
    if (t.scope === 'category' && (p.category || '') !== t.category) throw new Reject(400, `${p.name} is in ${p.category || 'no category'}; this stock take counts ${t.category}.`);
    const lv = await getDoc('stockLevels', ctx.storeId + '_' + itemId);
    const fresh = { name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcodes: ((v && v.barcodes) || p.barcodes || []).slice(0, 5), costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0 };
    return runSale(ctx, {}, { more: async (tx) => {
      const cur = await getDoc('stockTakes', t.id, tx);
      if (!cur || cur.status !== 'open') throw new Reject(409, `Stock take “${t.name}” is ${cur ? cur.status : 'gone'}: no more counting.`);
      const now = nowIso();
      const items = cur.items.map(x => ({ ...x }));
      const have = items.find(x => x.itemId === itemId);
      let added = false;
      if (have) Object.assign(have, fresh);
      else {
        added = true;
        items.push({ itemId, productId: p.id, variantId: v ? v.id : '', ...fresh, frozenQty: lv ? lv.onHandQty || 0 : 0, countedQty: null, countedBy: '', countedAt: '', addedBy: ctx.user.name, addedAt: now });
        items.sort((x, y) => x.name.localeCompare(y.name));
      }
      const log = added ? [...(cur.log || []), { at: now, byName: ctx.user.name, itemId, qty: 0, mode: 'item', deviceId: ctx.deviceId }].slice(-3000) : cur.log || [];
      const patch = { items, log, itemCount: items.length, ...tally(items), updatedAt: now };
      return { writes: [{ update: true, coll: 'stockTakes', id: t.id, data: patch }], result: { take: { ...cur, ...patch, id: t.id }, added, itemId } };
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
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('stockTakes', t.id, tx);
      if (!cur || cur.status !== 'review') throw new Reject(409, `Stock take “${t.name}” is no longer in review.`);
      // the option is fixed by the first batch; later batches carry on the same way
      const zero = cur.posting ? !!cur.uncountedAsZero : b.uncountedAsZero === true;
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      const items = cur.items.map(x => ({ ...x }));
      let i = cur.postedUpTo || 0, variances = 0, zeroed = 0, budget = TAKE_BATCH * 2;
      for (; i < items.length && budget > 0; i++) {
        const x = items[i];
        if (x.countedQty == null) {
          if (!zero) continue;                        // not counted, left as it is
          // nobody found it: a count of 0 against the frozen figure, so the variance report says what was expected
          Object.assign(x, { countedQty: 0, countedBy: a.name, countedAt: now, assumedZero: true }); zeroed++;
        }
        if (x.countedQty !== x.frozenQty) {
          await levelFor(tx, ctx, levels, x.itemId);
          writes.push(...moveWrites(ctx, levels, { productId: x.productId, variantId: x.variantId, itemId: x.itemId, qty: x.countedQty - x.frozenQty, bucket: 'onHand', reason: 'count', unitCostCents: x.costCents, name: x.name, note: x.assumedZero ? `Not found in the count: taken as 0, expected ${x.frozenQty}` : `Counted ${x.countedQty}, expected ${x.frozenQty}`, byName: a.name, countedAt: now }, { docType: 'stockTake', docId: t.id, docNo: t.name }, stamp, now));
          variances++; budget -= 2;
        } else {
          // counted and found right (or nought and nought): only the date moves
          const lid = await levelFor(tx, ctx, levels, x.itemId);
          if (levels.get(lid)) { writes.push({ update: true, coll: 'stockLevels', id: lid, data: { lastCountedAt: now } }); budget -= 1; }
        }
      }
      const done = i >= items.length;
      const movementCount = (cur.posting ? cur.movementCount || 0 : 0) + variances;
      const uncountedZeroed = (cur.posting ? cur.uncountedZeroed || 0 : 0) + zeroed;
      const patch = { items, postedUpTo: i, posting: !done, uncountedAsZero: zero, uncountedZeroed, movementCount, ...tally(items), updatedAt: now, ...(done ? { status: 'posted', postedAt: now, approvedBy: a.name } : {}) };
      writes.push({ update: true, coll: 'stockTakes', id: t.id, data: patch });
      if (done) writes.push(auditRow(ctx, 'stock.takePost', { docType: 'stockTake', docId: t.id, docNo: t.name }, { movements: movementCount, uncountedAsZero: zero, uncountedZeroed, ...tally(items) }, approvers, stamp, now));
      return { writes, result: { take: { ...cur, ...patch, id: t.id }, movements: variances, zeroed, done, left: items.length - i, total: items.length } };
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
  },

  // gone for good: a product made by mistake. Only one nothing points to can go (the rules block deletes
  // from the till on purpose): no stock, no movement, no sale, no document line, not part of a bundle.
  // Each refused product is named with the reason; the rest are deleted with their variants, their
  // empty stock-level rows and their Shopify queue rows, one audit row each.
  async productDelete(event, b) {
    const { user } = await requireMember(event);
    const entityId = clean(b.entityId, 40);
    if (!entityId || !inEntity(user, entityId)) throw new Reject(403, 'Not your company.');
    if (!atLeast(user, 'manager')) throw new Reject(403, 'Deleting products needs a manager.');
    const ids = [...new Set((Array.isArray(b.productIds) ? b.productIds : []).map(x => clean(x, 60)).filter(Boolean))].slice(0, 200);
    if (!ids.length) throw new Reject(400, 'Which products?');
    // every document line in the company that names a product, read once for the whole batch
    const q = (coll) => query(coll, [{ field: 'entityId', value: entityId }], 5000);
    const [pos, grvs, trs, lbs, sos, qts, takes, bundles] = await Promise.all([q('purchaseOrders'), q('grvs'), q('transfers'), q('laybys'), q('specialOrders'), q('quotes'), q('stockTakes'), query('products', [{ field: 'entityId', value: entityId }, { field: 'type', value: 'bundle' }], 2000)]);
    const onDoc = new Map();   // productId or itemId → the first document naming it
    const note = (key, what) => { if (key && !onDoc.has(key)) onDoc.set(key, what); };
    const scan = (docs, label, field = 'lines') => { for (const d of docs) { if (d.status === 'cancelled') continue; for (const l of d[field] || []) { const w = `on ${label} ${d.docNo || d.name || d.id}`; note(l.productId, w); note(l.itemId, w); note(l.variantId, w); } } };
    scan(pos, 'purchase order'); scan(grvs, 'goods received'); scan(trs, 'transfer'); scan(lbs, 'lay-by'); scan(sos, 'sales order'); scan(qts, 'quote'); scan(takes, 'stock take', 'items');
    for (const bp of bundles) for (const c of bp.bundle || []) { note(c.productId, `part of the bundle ${bp.name}`); note(c.variantId, `part of the bundle ${bp.name}`); }
    // ten products at a time: one at a time, a batch of a hundred ran past the function's time limit (504)
    const deleted = [], refused = [];
    const one = async (id) => {
      const p = await getDoc('products', id);
      if (!p || p.entityId !== entityId) { refused.push({ id, name: id, why: 'not found' }); return; }
      const variants = await query('variants', [{ field: 'productId', value: id }], 500);
      const itemIds = [id, ...variants.map(v => v.id)];
      let why = '';
      for (const k of itemIds) if (onDoc.has(k)) { why = onDoc.get(k); break; }
      const [moves, sold, levels, queue] = why ? [[], [], [], []] : await Promise.all([
        query('stockMovements', [{ field: 'productId', value: id }], 1), query('saleLines', [{ field: 'productId', value: id }], 1),
        query('stockLevels', [{ field: 'productId', value: id }], 500), query('shopifyQueue', [{ field: 'productId', value: id }], 500)]);
      if (!why && sold.length) why = 'sold on ' + (sold[0].docNo || 'a sale');
      if (!why && moves.length) why = 'has stock movements';
      if (!why) { const held = levels.find(l => (l.onHandQty || 0) || (l.quarantineQty || 0) || (l.reservedQty || 0) || (l.onOrderQty || 0)); if (held) why = (held.onHandQty || 0) ? `has ${held.onHandQty} on hand` : (held.onOrderQty || 0) ? `has ${held.onOrderQty} on order` : 'has stock in quarantine or reserved'; }
      if (why) { refused.push({ id, name: p.name, why }); return; }
      const now = nowIso();
      const writes = [{ delete: true, coll: 'products', id }, ...variants.map(v => ({ delete: true, coll: 'variants', id: v.id })), ...levels.map(l => ({ delete: true, coll: 'stockLevels', id: l.id })), ...queue.map(r => ({ delete: true, coll: 'shopifyQueue', id: r.id })),
        { create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'product.delete', docType: 'product', docId: id, docNo: '', actorUid: user.id, actorName: user.name, overrideUid: '', overrideName: '', details: { name: p.name, sku: p.sku || '', variants: variants.length, shopifyProductId: p.shopifyProductId || '' }, ...serverStamp(entityId, '', user.id, 'web:' + user.id), serverReceivedAt: now } }];
      await commit(writes);
      deleted.push({ id, name: p.name, shopify: !!p.shopifyProductId });
    };
    const todo = [...ids];
    await Promise.all(Array.from({ length: Math.min(10, todo.length) }, async () => { while (todo.length) await one(todo.shift()); }));
    // in the order asked, so the caller's list reads the same every time
    const at = new Map(ids.map((id, i) => [id, i]));
    deleted.sort((a, b) => at.get(a.id) - at.get(b.id)); refused.sort((a, b) => at.get(a.id) - at.get(b.id));
    return { ok: true, deleted, refused };
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
    console.error('pos-stock failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};

// every request works in its own customer's space (lib/pos.mjs)
export const handler = withGroup(handleRequest);
