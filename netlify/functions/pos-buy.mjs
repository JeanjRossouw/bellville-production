// Retail POS — buying: purchase orders sent and cancelled, goods received
// (against a PO, part or full, or direct) with landed costs, and transfers
// between stores. Stock moves only as movements; on-order figures ride on
// the levels.
//
//   poSend          { poId, how }                                 a manager: the number, status 'sent', stock on order
//   poCancel        { poId, reason }                              a manager: what was still on order is released
//   poRevise        { poId, supplierId, expectedAt, note, lines [ { productId, variantId, qty, unitCostCents } ] }
//                   a manager: a sent order nothing has been received on, changed: the same number, revision + 1,
//                   the on-order figures moved by the difference; then sent to the supplier again
//   receive         { grvId, purchaseOrderId?, supplierId?, supplierInvoiceNo, invoiceDate, lines [ { productId, variantId, qty, unitCostCents } ],
//                     landed { freightCents, dutyCents, otherCents, method: 'value'|'qty' }, updateCosts, note }   a supervisor
//   transferSend    { transferId, toStoreId, lines [ { productId, variantId, qty } ], note }    a supervisor at the sending store
//   transferReceive { transferId, lines [ { itemId, qty } ], close }                           a supervisor at the receiving store
//   transferCancel  { transferId }                                                             nothing received yet: the stock goes back
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, query, serverStamp, bodyOf, withGroup } from './lib/pos.mjs';
import { whoAndWhere, runSale, moveWrites, nextFromCounter, approved, int } from './lib/sale.mjs';
import { rateOn } from '../../pos/js/money.js';

const idOk = (id) => /^[\w:.-]{8,80}$/.test(id);
const money = (c) => 'R ' + (c / 100).toFixed(2);

async function itemOf(ctx, b) {
  const p = await getDoc('products', clean(b.productId, 60));
  if (!p || p.entityId !== ctx.entityId) throw new Reject(400, 'No such product here.');
  let v = null;
  if (b.variantId) { v = await getDoc('variants', clean(b.variantId, 60)); if (!v || v.productId !== p.id) throw new Reject(400, 'No such variant.'); }
  else if (p.hasVariants) throw new Reject(400, `${p.name} needs a variant.`);
  if (p.type !== 'stock' || p.trackStock === false) throw new Reject(400, `${p.name} does not hold stock.`);
  return { p, v, itemId: v ? v.id : p.id, productId: p.id, variantId: v ? v.id : '', name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcode: ((v && v.barcodes) || p.barcodes || [])[0] || '', costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0 };
}
async function levelFor(tx, ctx, levels, storeId, itemId) { const lid = storeId + '_' + itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); return lid; }
// the on-order figure moves without a stock movement
function onOrderWrite(ctx, levels, line, delta, now) {
  const lid = ctx.storeId + '_' + line.itemId; const lv = levels.get(lid);
  const next = { ...(lv || { productId: line.productId, variantId: line.variantId, onHandQty: 0, quarantineQty: 0, reservedQty: 0, avgCostCents: 0, lastMovementAt: '', lastCountedAt: '', rebuiltAt: '', negative: false, ...serverStamp(ctx.entityId, ctx.storeId, 'server', 'server') }), onOrderQty: Math.max(0, (lv ? lv.onOrderQty || 0 : 0) + delta), updatedAt: now };
  levels.set(lid, next);
  return { set: true, coll: 'stockLevels', id: lid, data: next };
}
const auditRow = (ctx, action, doc, details, approvers, stamp, now) => ({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action, docType: doc.docType, docId: doc.docId, docNo: doc.docNo || '', actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: [...approvers.keys()][0] || '', overrideName: [...approvers.values()][0] || '', details, ...stamp, serverReceivedAt: now } });
const poStatus = (lines) => lines.every(l => (l.receivedQty || 0) >= l.qty) ? 'received' : lines.some(l => (l.receivedQty || 0) > 0) ? 'part' : 'sent';
async function loadPo(ctx, id) { id = clean(id, 80); const po = await getDoc('purchaseOrders', id); if (!po || po.entityId !== ctx.entityId) throw new Reject(404, 'No such purchase order here.'); return { ...po, id }; }
async function loadTransfer(ctx, id) { id = clean(id, 80); const t = await getDoc('transfers', id); if (!t || t.entityId !== ctx.entityId) throw new Reject(404, 'No such transfer here.'); return { ...t, id }; }

// landed costs spread over the lines by value (default) or quantity; the last line takes the odd cents
function allocate(lines, landed) {
  const extra = (landed.freightCents || 0) + (landed.dutyCents || 0) + (landed.otherCents || 0);
  const base = lines.map(l => landed.method === 'qty' ? l.qty : l.qty * l.unitCostCents);
  const sum = base.reduce((n, x) => n + x, 0);
  let left = extra;
  lines.forEach((l, i) => { const share = i === lines.length - 1 ? left : (sum ? Math.round(extra * base[i] / sum) : 0); left -= share; l.landedCents = l.qty * l.unitCostCents + share; l.landedUnitCents = Math.round(l.landedCents / l.qty); l.landedShareCents = share; });
  return extra;
}

const actions = {
  async poSend(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'buy', 'manager', 'Sending a purchase order');
    const po = await loadPo(ctx, b.poId);
    if (po.status === 'sent' && po.docNo) return { ok: true, po, again: true };
    if (po.status !== 'draft') throw new Reject(409, `Purchase order is ${po.status}.`);
    if (po.storeId !== ctx.storeId) throw new Reject(400, 'That order is for another store.');
    if (!Array.isArray(po.lines) || !po.lines.length) throw new Reject(400, 'The order has no lines.');
    const lines = [];
    for (const l of po.lines) { const it = await itemOf(ctx, l); const qty = int(l.qty), cost = int(l.unitCostCents); if (!(qty > 0) || !(cost >= 0)) throw new Reject(400, `${it.name}: quantity and cost must be whole numbers.`); lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, sku: it.sku, name: it.name, barcode: it.barcode, qty, unitCostCents: cost, receivedQty: 0 }); }
    const sub = lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0);
    const rateBp = ctx.entity.vatRegistered ? rateOn((ctx.settings.vat || {}).rates, nowIso()) : 0;
    const vat = Math.round(sub * rateBp / 10000);
    const supplier = po.supplierId ? await getDoc('suppliers', po.supplierId) : null;
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('purchaseOrders', po.id, tx);
      if (!cur || cur.status !== 'draft') throw new Reject(409, 'The order was changed meanwhile: look again.');
      const num = await nextFromCounter(tx, ctx, 'PO', ctx.entity.poPrefix || (ctx.entity.invoicePrefix + '-PO'));
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [num.write];
      for (const l of lines) { await levelFor(tx, ctx, levels, ctx.storeId, l.itemId); writes.push(onOrderWrite(ctx, levels, l, l.qty, now)); }
      const patch = { seq: num.seq, docNo: num.docNo, lines, supplierName: supplier ? supplier.name : po.supplierName || '', supplierSnapshot: supplier ? { email: supplier.email || '', phone: supplier.phone || '', contact: supplier.contact || '' } : null, subtotalCents: sub, vatRateBp: rateBp, vatCents: vat, totalCents: sub + vat, status: 'sent', sentAt: now, sentBy: ctx.user.name, sentHow: clean(b.how, 20), grvs: [], updatedAt: now };
      writes.push({ update: true, coll: 'purchaseOrders', id: po.id, data: patch });
      writes.push(auditRow(ctx, 'po.send', { docType: 'purchaseOrder', docId: po.id, docNo: num.docNo }, { lines: lines.length, totalCents: sub + vat, supplier: patch.supplierName }, new Map(), stamp, now));
      return { writes, result: { po: { ...cur, ...patch, id: po.id } } };
    } });
  },

  async poRevise(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'buy', 'manager', 'Changing a purchase order');
    const po = await loadPo(ctx, b.poId);
    if (po.status !== 'sent') throw new Reject(409, po.status === 'part' ? `${po.docNo} is part received: receive or cancel what is open, and order the rest anew.` : `Purchase order is ${po.status}.`);
    if (po.storeId !== ctx.storeId) throw new Reject(400, 'That order is for another store.');
    const raw = Array.isArray(b.lines) ? b.lines : [];
    if (!raw.length) throw new Reject(400, 'The order needs at least one line (or cancel it).');
    const lines = [];
    for (const l of raw) { const it = await itemOf(ctx, l); const qty = int(l.qty), cost = int(l.unitCostCents); if (!(qty > 0) || !(cost >= 0)) throw new Reject(400, `${it.name}: quantity and cost must be whole numbers.`); lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, sku: it.sku, name: it.name, barcode: it.barcode, qty, unitCostCents: cost, receivedQty: 0 }); }
    const sub = lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0);
    const rateBp = ctx.entity.vatRegistered ? rateOn((ctx.settings.vat || {}).rates, nowIso()) : 0;
    const vat = Math.round(sub * rateBp / 10000);
    const supplierId = clean(b.supplierId, 80) || po.supplierId;
    const supplier = supplierId ? await getDoc('suppliers', supplierId) : null;
    if (supplierId && (!supplier || supplier.entityId !== ctx.entityId)) throw new Reject(400, 'Choose one of your suppliers.');
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('purchaseOrders', po.id, tx);
      if (!cur || cur.status !== 'sent' || (cur.lines || []).some(l => (l.receivedQty || 0) > 0)) throw new Reject(409, 'The order changed meanwhile (something was received?): look again.');
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      // on order: the new quantities less the old, item by item
      const delta = new Map();
      for (const l of cur.lines || []) delta.set(l.itemId, { line: l, d: (delta.get(l.itemId) || { d: 0 }).d - l.qty });
      for (const l of lines) delta.set(l.itemId, { line: l, d: (delta.get(l.itemId) || { d: 0 }).d + l.qty });
      const writes = [];
      for (const { line, d } of delta.values()) if (d) { await levelFor(tx, ctx, levels, ctx.storeId, line.itemId); writes.push(onOrderWrite(ctx, levels, line, d, now)); }
      const revision = (cur.revision || 1) + 1;
      const revisions = [...(cur.revisions || []), { revision: cur.revision || 1, at: cur.revisedAt || cur.sentAt, by: cur.revisedBy || cur.sentBy, lines: (cur.lines || []).map(l => ({ name: l.name, qty: l.qty, unitCostCents: l.unitCostCents })), totalCents: cur.totalCents }].slice(-20);
      const patch = { lines, supplierId, supplierName: supplier ? supplier.name : cur.supplierName || '', supplierSnapshot: supplier ? { email: supplier.email || '', phone: supplier.phone || '', contact: supplier.contact || '' } : cur.supplierSnapshot || null,
        expectedAt: /^\d{4}-\d{2}-\d{2}$/.test(b.expectedAt || '') ? b.expectedAt : cur.expectedAt || '', note: clean(b.note, 300), subtotalCents: sub, vatRateBp: rateBp, vatCents: vat, totalCents: sub + vat,
        revision, revisions, revisedAt: now, revisedBy: ctx.user.name, updatedAt: now };
      writes.push({ update: true, coll: 'purchaseOrders', id: po.id, data: patch });
      writes.push(auditRow(ctx, 'po.revise', { docType: 'purchaseOrder', docId: po.id, docNo: cur.docNo }, { revision, lines: lines.length, totalCents: sub + vat, was: cur.totalCents }, new Map(), stamp, now));
      return { writes, result: { po: { ...cur, ...patch, id: po.id } } };
    } });
  },

  async poCancel(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'buy', 'manager', 'Cancelling a purchase order');
    const po = await loadPo(ctx, b.poId);
    if (!['draft', 'sent', 'part'].includes(po.status)) throw new Reject(409, `Purchase order is ${po.status}.`);
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('purchaseOrders', po.id, tx);
      if (!cur || !['draft', 'sent', 'part'].includes(cur.status)) throw new Reject(409, 'The order changed meanwhile.');
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      if (cur.status !== 'draft') for (const l of cur.lines) { const open = l.qty - (l.receivedQty || 0); if (open > 0) { await levelFor(tx, ctx, levels, cur.storeId, l.itemId); writes.push(onOrderWrite({ ...ctx, storeId: cur.storeId }, levels, l, -open, now)); } }
      const patch = { status: 'cancelled', cancelledAt: now, cancelledBy: ctx.user.name, cancelReason: clean(b.reason, 200), updatedAt: now };
      writes.push({ update: true, coll: 'purchaseOrders', id: po.id, data: patch });
      writes.push(auditRow(ctx, 'po.cancel', { docType: 'purchaseOrder', docId: po.id, docNo: cur.docNo || '' }, { reason: patch.cancelReason, wasStatus: cur.status }, new Map(), stamp, now));
      return { writes, result: { po: { ...cur, ...patch, id: po.id } } };
    } });
  },

  // goods in: against a PO (part or full) or direct; the landed cost goes into the stock's cost
  async receive(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'buy', 'supervisor', 'Receiving stock'); if (!a.self) approvers.set(a.uid, a.name);
    const grvId = clean(b.grvId, 80);
    if (!idOk(grvId)) throw new Reject(400, 'The receipt has no id.');
    const had = await getDoc('goodsReceived', grvId);
    if (had) return { ok: true, grv: { ...had, id: grvId }, again: true };
    const po = b.purchaseOrderId ? await loadPo(ctx, b.purchaseOrderId) : null;
    if (po) { if (!['sent', 'part'].includes(po.status)) throw new Reject(409, `Purchase order ${po.docNo} is ${po.status}.`); if (po.storeId !== ctx.storeId) throw new Reject(400, `${po.docNo} is for another store.`); }
    const supplierId = clean(po ? po.supplierId : b.supplierId, 60);
    const supplier = supplierId ? await getDoc('suppliers', supplierId) : null;
    if (supplierId && (!supplier || supplier.entityId !== ctx.entityId)) throw new Reject(400, 'No such supplier here.');
    const inLines = Array.isArray(b.lines) ? b.lines : [];
    if (!inLines.length || inLines.length > 300) throw new Reject(400, 'Nothing to receive.');
    const lines = [];
    for (const l of inLines) {
      const it = await itemOf(ctx, l); const qty = int(l.qty), cost = int(l.unitCostCents);
      if (!(qty > 0) || qty > 100000) throw new Reject(400, `${it.name}: how many arrived?`);
      if (!(cost >= 0)) throw new Reject(400, `${it.name}: the cost must be whole cents, nought or more.`);
      if (lines.some(x => x.itemId === it.itemId)) throw new Reject(400, `${it.name} is on the receipt twice: add the quantities together.`);
      if (po) { const pl = po.lines.find(x => x.itemId === it.itemId); if (!pl) throw new Reject(400, `${it.name} is not on ${po.docNo}: receive it without a purchase order.`); const open = pl.qty - (pl.receivedQty || 0); if (qty > open) throw new Reject(400, `${it.name}: only ${open} still open on ${po.docNo}; receive the rest without a purchase order.`); }
      lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, name: it.name, sku: it.sku, barcode: it.barcode, qty, unitCostCents: cost, oldCostCents: it.costCents, p: it.p, v: it.v });
    }
    const L = b.landed || {};
    const landed = { freightCents: Math.max(0, int(L.freightCents) || 0), dutyCents: Math.max(0, int(L.dutyCents) || 0), otherCents: Math.max(0, int(L.otherCents) || 0), method: L.method === 'qty' ? 'qty' : 'value' };
    landed.totalCents = allocate(lines, landed);
    const sub = lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0);
    const updateCosts = b.updateCosts == null ? ((ctx.settings.buying || {}).updateCostsOnReceive !== false) : !!b.updateCosts;
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const curPo = po ? await getDoc('purchaseOrders', po.id, tx) : null;
      if (po && (!curPo || !['sent', 'part'].includes(curPo.status))) throw new Reject(409, `${po.docNo} changed meanwhile: look again.`);
      const num = await nextFromCounter(tx, ctx, 'GRV', ctx.entity.grvPrefix || (ctx.entity.invoicePrefix + '-GRV'));
      for (const l of lines) await levelFor(tx, ctx, levels, ctx.storeId, l.itemId);
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [num.write];
      const costChanges = [];
      for (const l of lines) {
        const pl = curPo ? curPo.lines.find(x => x.itemId === l.itemId) : null;
        writes.push(...moveWrites(ctx, levels, { productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: l.qty, bucket: 'onHand', reason: 'receive', unitCostCents: l.landedUnitCents, baseCostCents: l.oldCostCents, wac: true, onOrderDelta: pl ? -l.qty : 0, name: l.name, note: (supplier ? supplier.name : 'Direct receipt') + (b.supplierInvoiceNo ? ' · inv ' + clean(b.supplierInvoiceNo, 40) : ''), byName: a.name }, { docType: 'goodsReceived', docId: grvId, docNo: num.docNo }, stamp, now));
        if (updateCosts) { const lv = levels.get(ctx.storeId + '_' + l.itemId); const newCost = lv.avgCostCents; if (newCost !== l.oldCostCents) { costChanges.push({ itemId: l.itemId, name: l.name, fromCents: l.oldCostCents, toCents: newCost }); writes.push(l.v ? { update: true, coll: 'variants', id: l.v.id, data: { costCents: newCost, updatedAt: now, updatedBy: 'server' } } : { update: true, coll: 'products', id: l.p.id, data: { costCents: newCost, updatedAt: now, updatedBy: 'server' } }); } }
      }
      const grv = { series: 'GRV', seq: num.seq, docNo: num.docNo, purchaseOrderId: po ? po.id : '', purchaseOrderDocNo: po ? po.docNo : '', supplierId, supplierName: supplier ? supplier.name : '', supplierInvoiceNo: clean(b.supplierInvoiceNo, 40), invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(b.invoiceDate || '') ? b.invoiceDate : '',
        lines: lines.map(({ p, v, oldCostCents, ...l }) => l), lineCount: lines.length, subtotalCents: sub, landed, totalCostCents: sub + landed.totalCents, updateCosts, costChanges, receivedBy: ctx.user.name, note: clean(b.note, 300), ...stamp, serverReceivedAt: now };
      writes.push({ create: true, coll: 'goodsReceived', id: grvId, data: grv });
      if (curPo) {
        const plines = curPo.lines.map(x => { const got = lines.find(l => l.itemId === x.itemId); return got ? { ...x, receivedQty: (x.receivedQty || 0) + got.qty } : x; });
        const status = poStatus(plines);
        writes.push({ update: true, coll: 'purchaseOrders', id: po.id, data: { lines: plines, status, grvs: [...(curPo.grvs || []), { id: grvId, docNo: num.docNo, at: now }], receivedAt: status === 'received' ? now : '', updatedAt: now } });
      }
      writes.push(auditRow(ctx, 'stock.receive', { docType: 'goodsReceived', docId: grvId, docNo: num.docNo }, { lines: lines.length, units: lines.reduce((n, l) => n + l.qty, 0), totalCostCents: sub + landed.totalCents, landedCents: landed.totalCents, po: po ? po.docNo : '', updateCosts, costChanges: costChanges.length }, approvers, stamp, now));
      return { writes, result: { grv: { ...grv, id: grvId }, poStatus: curPo ? poStatus(curPo.lines.map(x => { const got = lines.find(l => l.itemId === x.itemId); return got ? { ...x, receivedQty: (x.receivedQty || 0) + got.qty } : x; })) : '', levels: lines.map(l => ({ itemId: l.itemId, ...levels.get(ctx.storeId + '_' + l.itemId) })) } };
    } });
  },

  // stock leaves the sender now; it is in transit until the other store receives it
  async transferSend(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'buy', 'supervisor', 'Sending stock to another store'); if (!a.self) approvers.set(a.uid, a.name);
    const id = clean(b.transferId, 80);
    if (!idOk(id)) throw new Reject(400, 'The transfer has no id.');
    const had = await getDoc('transfers', id);
    if (had) return { ok: true, transfer: { ...had, id }, again: true };
    const toStoreId = clean(b.toStoreId, 40);
    const to = toStoreId ? await getDoc('stores', toStoreId) : null;
    if (!to || to.entityId !== ctx.entityId || !to.active) throw new Reject(400, 'Which store is it going to? It must be one of this company’s.');
    if (toStoreId === ctx.storeId) throw new Reject(400, 'That is this store.');
    const inLines = Array.isArray(b.lines) ? b.lines : [];
    if (!inLines.length || inLines.length > 300) throw new Reject(400, 'Nothing to send.');
    const lines = [];
    for (const l of inLines) { const it = await itemOf(ctx, l); const qty = int(l.qty); if (!(qty > 0)) throw new Reject(400, `${it.name}: how many?`); if (lines.some(x => x.itemId === it.itemId)) throw new Reject(400, `${it.name} is on the transfer twice.`); lines.push({ productId: it.productId, variantId: it.variantId, itemId: it.itemId, name: it.name, sku: it.sku, barcode: it.barcode, qty, receivedQty: 0, lostQty: 0, unitCostCents: it.costCents }); }
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const num = await nextFromCounter(tx, ctx, 'TR', ctx.entity.transferPrefix || (ctx.entity.invoicePrefix + '-TR'));
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [num.write];
      for (const l of lines) {
        const lid = await levelFor(tx, ctx, levels, ctx.storeId, l.itemId); const lv = levels.get(lid) || {};
        const avail = (lv.onHandQty || 0) - (lv.reservedQty || 0);
        if (l.qty > avail) throw new Reject(400, `${l.name}: only ${avail} available to send (${lv.onHandQty || 0} on hand, ${lv.reservedQty || 0} reserved).`);
        if (lv.avgCostCents > 0) l.unitCostCents = lv.avgCostCents;
        writes.push(...moveWrites(ctx, levels, { productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: -l.qty, bucket: 'onHand', reason: 'transferOut', unitCostCents: l.unitCostCents, name: l.name, note: 'To ' + to.name, byName: a.name }, { docType: 'transfer', docId: id, docNo: num.docNo }, stamp, now));
      }
      const tr = { series: 'TR', seq: num.seq, docNo: num.docNo, fromStoreId: ctx.storeId, toStoreId, fromStoreName: ctx.store.name, toStoreName: to.name, lines, lineCount: lines.length, units: lines.reduce((n, l) => n + l.qty, 0), valueCents: lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0), status: 'inTransit', sentAt: now, sentBy: ctx.user.name, receivedAt: '', receivedBy: '', closedShort: false, note: clean(b.note, 300), ...stamp, serverReceivedAt: now, updatedAt: now };
      writes.push({ create: true, coll: 'transfers', id, data: tr });
      writes.push(auditRow(ctx, 'stock.transferSend', { docType: 'transfer', docId: id, docNo: num.docNo }, { to: toStoreId, lines: lines.length, units: tr.units }, approvers, stamp, now));
      return { writes, result: { transfer: { ...tr, id } } };
    } });
  },

  async transferReceive(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'buy', 'supervisor', 'Receiving a transfer'); if (!a.self) approvers.set(a.uid, a.name);
    const tr = await loadTransfer(ctx, b.transferId);
    if (tr.status !== 'inTransit') throw new Reject(409, `Transfer ${tr.docNo} is ${tr.status}.`);
    if (tr.toStoreId !== ctx.storeId) throw new Reject(400, `${tr.docNo} is going to ${tr.toStoreName}: receive it there.`);
    const got = (Array.isArray(b.lines) ? b.lines : []).map(l => ({ itemId: clean(l.itemId, 60), qty: int(l.qty) }));
    for (const g of got) if (!(g.qty >= 0)) throw new Reject(400, 'A quantity is a whole number.');
    const close = !!b.close;
    if (!got.some(g => g.qty > 0) && !close) throw new Reject(400, 'Nothing arrived?');
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('transfers', tr.id, tx);
      if (!cur || cur.status !== 'inTransit') throw new Reject(409, `Transfer ${tr.docNo} changed meanwhile.`);
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      const lines = cur.lines.map(l => ({ ...l }));
      for (const g of got) {
        if (!g.qty) continue;
        const l = lines.find(x => x.itemId === g.itemId); if (!l) throw new Reject(400, 'That item is not on the transfer.');
        const open = l.qty - (l.receivedQty || 0); if (g.qty > open) throw new Reject(400, `${l.name}: only ${open} still on the way.`);
        await levelFor(tx, ctx, levels, ctx.storeId, l.itemId);
        writes.push(...moveWrites(ctx, levels, { productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: g.qty, bucket: 'onHand', reason: 'transferIn', unitCostCents: l.unitCostCents, baseCostCents: l.unitCostCents, wac: true, name: l.name, note: 'From ' + cur.fromStoreName, byName: a.name }, { docType: 'transfer', docId: tr.id, docNo: cur.docNo }, stamp, now));
        l.receivedQty = (l.receivedQty || 0) + g.qty;
      }
      const allIn = lines.every(l => l.receivedQty >= l.qty);
      if (close) lines.forEach(l => { l.lostQty = l.qty - l.receivedQty; });
      const done = allIn || close;
      const patch = { lines, status: done ? 'received' : 'inTransit', receivedAt: done ? now : '', receivedBy: done ? ctx.user.name : '', closedShort: done && !allIn, lostUnits: done ? lines.reduce((n, l) => n + (l.lostQty || 0), 0) : 0, updatedAt: now };
      writes.push({ update: true, coll: 'transfers', id: tr.id, data: patch });
      writes.push(auditRow(ctx, 'stock.transferReceive', { docType: 'transfer', docId: tr.id, docNo: cur.docNo }, { units: got.reduce((n, g) => n + g.qty, 0), done, lostUnits: patch.lostUnits }, approvers, stamp, now));
      return { writes, result: { transfer: { ...cur, ...patch, id: tr.id } } };
    } });
  },

  async transferCancel(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const approvers = new Map();
    const a = approved(ctx, b.approvalToken, 'buy', 'supervisor', 'Cancelling a transfer'); if (!a.self) approvers.set(a.uid, a.name);
    const tr = await loadTransfer(ctx, b.transferId);
    if (tr.status !== 'inTransit') throw new Reject(409, `Transfer ${tr.docNo} is ${tr.status}.`);
    if (tr.lines.some(l => l.receivedQty > 0)) throw new Reject(409, 'Part of it was received: close it short instead.');
    if (tr.fromStoreId !== ctx.storeId) throw new Reject(400, 'Only the sending store cancels a transfer; the stock goes back there.');
    return runSale(ctx, {}, { more: async (tx, levels) => {
      const cur = await getDoc('transfers', tr.id, tx);
      if (!cur || cur.status !== 'inTransit' || cur.lines.some(l => l.receivedQty > 0)) throw new Reject(409, 'The transfer changed meanwhile.');
      const now = nowIso(); const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      for (const l of cur.lines) { await levelFor(tx, ctx, levels, ctx.storeId, l.itemId); writes.push(...moveWrites(ctx, levels, { productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: l.qty, bucket: 'onHand', reason: 'transferIn', unitCostCents: l.unitCostCents, baseCostCents: l.unitCostCents, wac: true, name: l.name, note: 'Transfer cancelled', byName: a.name }, { docType: 'transfer', docId: tr.id, docNo: cur.docNo }, stamp, now)); }
      const patch = { status: 'cancelled', cancelledAt: now, cancelledBy: ctx.user.name, updatedAt: now };
      writes.push({ update: true, coll: 'transfers', id: tr.id, data: patch });
      writes.push(auditRow(ctx, 'stock.transferCancel', { docType: 'transfer', docId: tr.id, docNo: cur.docNo }, {}, approvers, stamp, now));
      return { writes, result: { transfer: { ...cur, ...patch, id: tr.id } } };
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
    console.error('pos-buy failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};

// every request works in its own customer's space (lib/pos.mjs)
export const handler = withGroup(handleRequest);
