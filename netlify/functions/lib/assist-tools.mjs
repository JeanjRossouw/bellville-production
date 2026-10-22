// Retail POS — the assistant's hands. The model may call these tools; the
// reads answer at once, the writes only make a *proposal* (assistantProposals)
// that comes back to the till as a card, and nothing is written until the
// person taps the card (confirmProposal). Customer messages are drafted with
// the templates the till already uses and sent by the till's own one-tap
// WhatsApp flow, which logs them.
import { getDoc, query, createDoc, patchDoc, nowIso, randomId, serverStamp, Reject, rank, clean, audit } from './pos.mjs';
import { updateText, salesOrderText, STATUS_LABEL, SALES_LABEL } from '../../../pos/js/special-terms.js';
import { reminderText, expectedBy } from '../../../pos/js/layby-terms.js';

const rands = (c) => 'R ' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const PROPOSAL_MINUTES = 30;

// what the model is told it can do (strict: the input always matches the schema)
export const TOOLS = [
  { name: 'low_stock_by_supplier', description: 'Items at or under their reorder point at this store, grouped by supplier, each with available, on order, the reorder point, the suggested quantity and the unit cost. Call this before proposing purchase orders.', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'propose_purchase_orders', description: 'Propose draft purchase orders from low stock, one per supplier, using itemIds and supplierIds from low_stock_by_supplier. Nothing is created: the person gets a card to confirm, after which the drafts appear under Buying for a manager to send. Only a manager or the owner may propose. Say in your answer that the card below needs their tap.', strict: true, input_schema: { type: 'object', properties: { orders: { type: 'array', items: { type: 'object', properties: { supplierId: { type: 'string', description: 'the supplier id from low_stock_by_supplier, or an empty string for items with no supplier' }, lines: { type: 'array', items: { type: 'object', properties: { itemId: { type: 'string' }, qty: { type: 'integer' } }, required: ['itemId', 'qty'], additionalProperties: false } } }, required: ['supplierId', 'lines'], additionalProperties: false } }, note: { type: 'string', description: 'a short note for the order, or an empty string' } }, required: ['orders', 'note'], additionalProperties: false } },
  { name: 'customers_to_contact', description: 'Customers who should hear from the store now: custom orders and sales orders with news not yet sent (ready, in production), lay-bys overdue, due within a week or paid up and uncollected. Each comes with the message already written. The till sends them one tap at a time from the card; say so.', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'propose_tasks', description: 'Propose tasks for the store\'s list (what, by when, for whom). Nothing is created until the person confirms the card. Use short, concrete titles; due is a date YYYY-MM-DD or an empty string; assigneeName a staff name or an empty string.', strict: true, input_schema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' }, due: { type: 'string' }, assigneeName: { type: 'string' } }, required: ['title', 'note', 'due', 'assigneeName'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false } },
  { name: 'list_tasks', description: 'The store\'s open tasks, soonest due first.', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
];

// ---- stock: every item of the store with its figures
async function stockItems(ctx) {
  const [products, variants, levels, suppliers] = await Promise.all([
    query('products', [{ field: 'entityId', value: ctx.entityId }], 3000),
    query('variants', [{ field: 'entityId', value: ctx.entityId }], 5000),
    query('stockLevels', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }], 5000),
    query('suppliers', [{ field: 'entityId', value: ctx.entityId }], 500)
  ]);
  const lv = new Map(levels.map(l => [l.variantId || l.productId, l]));
  const sup = new Map(suppliers.filter(s => !s.archived).map(s => [s.id, s]));
  const out = [];
  for (const p of products) {
    if (p.archived || p.type !== 'stock' || p.trackStock === false) continue;
    const vs = p.hasVariants ? variants.filter(v => v.productId === p.id && !v.archived) : [null];
    for (const v of vs) {
      const itemId = v ? v.id : p.id;
      const l = lv.get(itemId) || {};
      const available = (l.onHandQty || 0) - (l.reservedQty || 0), onOrder = l.onOrderQty || 0;
      out.push({ itemId, productId: p.id, variantId: v ? v.id : '', name: p.name + (v ? ' · ' + v.name : ''), sku: (v && v.sku) || p.sku || '', barcode: ((v && v.barcodes) || p.barcodes || [])[0] || '', available, onOrder, reorderLevel: p.reorderLevel == null ? null : Number(p.reorderLevel), reorderQty: p.reorderQty == null ? null : Number(p.reorderQty), costCents: (v && v.costCents != null ? v.costCents : p.costCents) || 0, supplierId: p.supplierId || '', supplier: sup.get(p.supplierId || '') || null });
    }
  }
  return { items: out, suppliers: sup };
}
const lowOf = (items) => items.filter(x => x.reorderLevel != null && x.available + x.onOrder <= x.reorderLevel).map(x => ({ ...x, suggestQty: Math.max(1, x.reorderQty || (x.reorderLevel - x.available - x.onOrder + 1)) }));

// ---- the tools
export async function runTool(ctx, name, input) {
  if (name === 'low_stock_by_supplier') {
    const { items } = await stockItems(ctx);
    const low = lowOf(items);
    const groups = new Map();
    for (const x of low) { const k = x.supplierId || ''; if (!groups.has(k)) groups.set(k, { supplierId: k, supplierName: x.supplier ? x.supplier.name : '(no supplier on the product)', leadDays: x.supplier ? x.supplier.leadDays || null : null, lines: [], totalCents: 0 }); const g = groups.get(k); g.lines.push({ itemId: x.itemId, name: x.name, sku: x.sku, available: x.available, onOrder: x.onOrder, reorderLevel: x.reorderLevel, suggestQty: x.suggestQty, unitCostCents: x.costCents, lineCents: x.suggestQty * x.costCents }); g.totalCents += x.suggestQty * x.costCents; }
    const list = [...groups.values()].sort((a, b) => b.totalCents - a.totalCents);
    return { result: { store: ctx.store.name, lowItems: low.length, suppliers: list.slice(0, 20).map(g => ({ ...g, totalCents: g.totalCents, total: rands(g.totalCents), lines: g.lines.slice(0, 40) })), note: rank(ctx.user.role) >= rank('manager') ? 'This person may propose purchase orders.' : 'This person is a ' + ctx.user.role + ': they may not create purchase orders; a manager must. You can still show what is low.' } };
  }
  if (name === 'propose_purchase_orders') {
    if (rank(ctx.user.role) < rank('manager')) throw new Reject(403, 'Only a manager or the owner may create purchase orders. Show the list instead.');
    const { items, suppliers } = await stockItems(ctx);
    const byId = new Map(items.map(x => [x.itemId, x]));
    const docs = [], lines = [];
    for (const o of (input.orders || []).slice(0, 10)) {
      const supplierId = clean(o.supplierId, 60);
      const s = supplierId ? suppliers.get(supplierId) : null;
      if (supplierId && !s) throw new Reject(400, `No supplier with id ${supplierId}: use the ids from low_stock_by_supplier.`);
      const poLines = [];
      for (const l of (o.lines || []).slice(0, 60)) {
        const x = byId.get(clean(l.itemId, 60)); if (!x) throw new Reject(400, `No stock item with id ${l.itemId} at this store.`);
        const qty = Math.max(1, Math.min(9999, Math.round(Number(l.qty) || 0))); if (!qty) continue;
        poLines.push({ productId: x.productId, variantId: x.variantId, itemId: x.itemId, sku: x.sku, name: x.name, barcode: x.barcode, qty, unitCostCents: x.costCents, receivedQty: 0 });
      }
      if (!poLines.length) continue;
      const subtotalCents = poLines.reduce((n, l) => n + l.qty * l.unitCostCents, 0);
      const expectedAt = new Date(Date.now() + ((s && s.leadDays) || 7) * 86400000).toISOString().slice(0, 10);
      docs.push({ supplierId, supplierName: s ? s.name : '', expectedAt, note: ['Suggested by the assistant from low stock', clean(input.note, 200)].filter(Boolean).join(' · '), lines: poLines, status: 'draft', docNo: '', seq: 0, subtotalCents });
      lines.push(`${s ? s.name : 'No supplier yet'}: ${poLines.length} line${poLines.length === 1 ? '' : 's'}, ${poLines.reduce((n, l) => n + l.qty, 0)} units, ${rands(subtotalCents)} ex VAT`);
    }
    if (!docs.length) throw new Reject(400, 'Nothing to order: every order was empty.');
    const id = await saveProposal(ctx, 'purchaseOrders', docs, lines);
    return { result: { proposalId: id, proposed: lines, next: 'The person must tap "Create the drafts" on the card to create them. Do not say they are created.' }, card: { type: 'proposal', id, kind: 'purchaseOrders', title: `${docs.length} draft purchase order${docs.length === 1 ? '' : 's'} to create`, lines, confirmLabel: 'Create the drafts' } };
  }
  if (name === 'customers_to_contact') {
    const inStore = [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }];
    const [specials, sales, laybys] = await Promise.all([query('specialOrders', inStore, 1000), query('salesOrders', inStore, 1000), query('laybys', [...inStore, { field: 'status', value: 'open' }], 1000)]);
    const items = [];
    for (const o of specials.filter(o => ['depositPaid', 'inProduction', 'ready'].includes(o.status) && (o.updateDue || o.status === 'ready'))) items.push({ kind: 'customOrder', id: o.id, docNo: o.docNo, customer: (o.customerSnapshot || {}).name || '', phone: (o.customerSnapshot || {}).phone || '', why: (STATUS_LABEL[o.status] || o.status) + (o.updateDue ? ', not told yet' : ''), text: updateText(ctx.entity, ctx.store, o, o.status), send: { api: 'special', action: 'update', body: { orderId: o.id, how: 'whatsapp' } } });
    for (const o of sales.filter(o => ['open', 'inProduction', 'ready'].includes(o.status) && (o.updateDue || o.status === 'ready'))) items.push({ kind: 'salesOrder', id: o.id, docNo: o.docNo, customer: (o.customerSnapshot || {}).name || '', phone: (o.customerSnapshot || {}).phone || '', why: (SALES_LABEL[o.status] || o.status) + (o.updateDue ? ', not told yet' : ''), text: salesOrderText(ctx.entity, ctx.store, o, o.status), send: { api: 'salesOrder', action: 'update', body: { saleId: o.id, how: 'whatsapp' } } });
    const day = today(), week = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    for (const lb of laybys) {
      const kind = lb.balanceCents <= 0 ? 'ready' : (lb.paidCents < expectedBy(lb, day) || lb.dueAt < day) ? 'overdue' : ((lb.schedule || []).some(x => x.dueAt >= day && x.dueAt <= week) ? 'due' : '');
      if (!kind) continue;
      if (lb.lastReminderAt && lb.lastReminderAt.slice(0, 10) >= new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)) continue;   // reminded in the last three days
      items.push({ kind: 'layby', id: lb.id, docNo: lb.docNo, customer: (lb.customerSnapshot || {}).name || '', phone: (lb.customerSnapshot || {}).phone || '', why: kind === 'ready' ? 'paid up, not collected' : kind === 'overdue' ? 'behind, ' + rands(lb.balanceCents) + ' owed' : 'instalment due this week', text: reminderText(ctx.entity, ctx.store, lb, kind), send: { api: 'layby', action: 'remind', body: { laybyId: lb.id, kind, how: 'whatsapp' } } });
    }
    const list = items.slice(0, 30);
    return { result: { count: items.length, customers: list.map(x => ({ kind: x.kind, docNo: x.docNo, customer: x.customer, phone: x.phone ? 'yes' : 'none', why: x.why })), next: list.length ? 'The messages are written and on the card: the person sends each with one tap on WhatsApp.' : 'Nobody needs a message right now.' }, card: list.length ? { type: 'updates', id: randomId('up_'), title: `${list.length} customer${list.length === 1 ? '' : 's'} to message`, items: list } : null };
  }
  if (name === 'propose_tasks') {
    const staff = await query('users', [{ field: 'storeIds', op: 'ARRAY_CONTAINS', value: ctx.storeId }], 100);
    const tasks = [];
    for (const t of (input.tasks || []).slice(0, 20)) {
      const title = clean(t.title, 120); if (!title) continue;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '';
      const who = clean(t.assigneeName, 80);
      const u = who ? staff.find(s => s.active && String(s.name || '').toLowerCase() === who.toLowerCase()) : null;
      tasks.push({ title, note: clean(t.note, 300), due, assigneeUid: u ? u.id : '', assigneeName: u ? u.name : who, status: 'open', source: 'assistant' });
    }
    if (!tasks.length) throw new Reject(400, 'No task had a title.');
    const lines = tasks.map(t => t.title + (t.due ? ' · by ' + t.due : '') + (t.assigneeName ? ' · ' + t.assigneeName : ''));
    const id = await saveProposal(ctx, 'tasks', tasks, lines);
    return { result: { proposalId: id, proposed: lines, next: 'The person must tap "Add these tasks" on the card. Do not say they are added.' }, card: { type: 'proposal', id, kind: 'tasks', title: `${tasks.length} task${tasks.length === 1 ? '' : 's'} to add`, lines, confirmLabel: 'Add these tasks' } };
  }
  if (name === 'list_tasks') {
    const rows = (await query('tasks', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }, { field: 'status', value: 'open' }], 200)).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')));
    return { result: { open: rows.length, tasks: rows.slice(0, 50).map(t => ({ title: t.title, due: t.due || '', who: t.assigneeName || '', note: t.note || '', source: t.source })) } };
  }
  throw new Reject(400, 'No such tool: ' + name);
}

// ---- proposals: kept for half an hour, for the person who asked, used once
async function saveProposal(ctx, kind, payload, summary) {
  const id = randomId('pr_');
  const now = nowIso();
  await createDoc('assistantProposals', id, { kind, uid: ctx.user.id, entityId: ctx.entityId, storeId: ctx.storeId, payload, summary, createdAt: now, expiresAt: new Date(Date.now() + PROPOSAL_MINUTES * 60000).toISOString(), used: false });
  return id;
}
export async function confirmProposal(ctx, proposalId) {
  const id = clean(proposalId, 40);
  const pr = await getDoc('assistantProposals', id);
  if (!pr || pr.uid !== ctx.user.id || pr.entityId !== ctx.entityId || pr.storeId !== ctx.storeId) throw new Reject(404, 'That proposal is not yours, or is gone.');
  if (pr.used) throw new Reject(409, 'That was done already.');
  if (pr.expiresAt < nowIso()) throw new Reject(410, 'That proposal has expired: ask again.');
  const now = nowIso();
  const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
  const made = [];
  if (pr.kind === 'purchaseOrders') {
    if (rank(ctx.user.role) < rank('manager')) throw new Reject(403, 'Only a manager or the owner may create purchase orders.');
    for (const doc of pr.payload) { const poId = randomId('po_'); await createDoc('purchaseOrders', poId, { ...doc, ...stamp, updatedBy: ctx.user.id, updatedAt: now }); made.push({ id: poId, supplierName: doc.supplierName, lines: doc.lines.length, subtotalCents: doc.subtotalCents }); }
    await audit({ action: 'assistant.purchaseOrders', docType: 'purchaseOrder', docId: made.map(m => m.id).join(','), docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, details: { count: made.length, via: 'assistant', summary: pr.summary }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
  } else if (pr.kind === 'tasks') {
    for (const t of pr.payload) { const tId = randomId('tk_'); await createDoc('tasks', tId, { ...t, doneAt: '', doneBy: '', ...stamp, createdByName: ctx.user.name, updatedAt: now }); made.push({ id: tId, title: t.title }); }
    await audit({ action: 'assistant.tasks', docType: 'task', docId: made.map(m => m.id).join(','), docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, details: { count: made.length, via: 'assistant', summary: pr.summary }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
  } else throw new Reject(400, 'Unknown proposal.');
  await patchDoc('assistantProposals', id, { used: true, usedAt: now });
  return { kind: pr.kind, made, message: pr.kind === 'purchaseOrders' ? `${made.length} draft purchase order${made.length === 1 ? '' : 's'} created under Buying. A manager sends them from there.` : `${made.length} task${made.length === 1 ? '' : 's'} added to the store's list on Home.` };
}
