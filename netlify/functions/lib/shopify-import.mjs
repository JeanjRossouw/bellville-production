// Retail POS — open Shopify orders brought in as sales orders (Sales → Online → Bring in open orders).
// An order placed on the shop before the POS was connected (the webhooks only bring new ones) is made
// a sales order here, so it gets the client's page, To do, delivery slots and the driver:
//
//   specialOrders/shp-<shopify order number id>   status depositPaid (or quoted when nothing is paid),
//     source 'shopify', urgent (a red tag, listed first), invoiceBy 'shopify' (Shopify's order is the tax invoice: the POS writes none, at
//     dispatch or hand-over), shopify { id, name, createdAt, financialStatus }, the lines (matched to the
//     POS products by Shopify id or SKU, else named lines; their Shopify options on the spec), what Shopify
//     received as paid "via Shopify" (no POS payment rows: it is not in a till's cash-up), the balance.
//   customers/<id> + customerPhones   the client matched by cell number, then email, else made (no consent).
// Bringing them in again skips the ones already here.
import { gql, gidNum } from './shopify-pos.mjs';
import { getDoc, query, nowIso, randomId, serverStamp, clean } from './pos.mjs';
import { runSale, nextFromCounter } from './sale.mjs';
import { pctOf, vatIn } from '../../../pos/js/money.js';
import { specialSettings } from '../../../pos/js/special-terms.js';
import { phoneKey, phoneOk, emailKey, blankConsent, blankLoyalty, blankStats } from '../../../pos/js/loyalty-terms.js';

const cents = (x) => Math.round(Number((x && x.shopMoney ? x.shopMoney.amount : x) || 0) * 100);
const Q = `query($after: String, $q: String) { orders(first: 40, after: $after, query: $q, sortKey: CREATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus note email phone
    totalPriceSet { shopMoney { amount } } totalReceivedSet { shopMoney { amount } }
    customer { firstName lastName email phone }
    shippingAddress { name address1 address2 city zip phone }
    shippingLines(first: 3) { nodes { title originalPriceSet { shopMoney { amount } } } }
    lineItems(first: 50) { nodes { title variantTitle quantity sku customAttributes { key value } discountedTotalSet { shopMoney { amount } } variant { id } } } } } }`;

// the shop's open orders that are not yet sent out
export async function openShopifyOrders(cfg, max = 400) {
  const out = []; let after = null;
  do {
    const d = await gql(cfg, Q, { after, q: 'status:open fulfillment_status:unfulfilled' });
    out.push(...d.orders.nodes.filter(o => !o.cancelledAt));
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after && out.length < max);
  return out;
}

const idOf = (o) => 'shp-' + gidNum(o.id);
const nameOf = (o) => { const c = o.customer || {}, a = o.shippingAddress || {}; return clean([c.firstName, c.lastName].filter(Boolean).join(' ') || a.name || 'Online customer', 120); };
const phoneOf = (o) => clean((o.customer || {}).phone || (o.shippingAddress || {}).phone || o.phone || '', 30);
const emailOf = (o) => clean((o.customer || {}).email || o.email || '', 120);

// what bringing them in would do: per order, already here or new, the client, the lines matched, the money
export async function planShopifyImport(entityId, orders) {
  const [products, variants, customers] = await Promise.all([query('products', [{ field: 'entityId', value: entityId }], 5000), query('variants', [{ field: 'entityId', value: entityId }], 10000), query('customers', [{ field: 'entityId', value: entityId }], 10000)]);
  const plan = [];
  for (const o of orders) {
    const had = await getDoc('specialOrders', idOf(o));
    const pk = phoneKey(phoneOf(o)), ek = emailKey(emailOf(o));
    const cust = customers.find(c => !c.anonymised && pk && c.phoneKey === pk) || customers.find(c => !c.anonymised && ek && c.emailKey === ek) || null;
    const lines = o.lineItems.nodes.filter(li => li.quantity > 0).map(li => {
      const vid = li.variant ? li.variant.id : '', sku = String(li.sku || '').trim().toLowerCase();
      const v = variants.find(x => vid && x.shopifyVariantId === vid) || (sku ? variants.find(x => String(x.sku || '').toLowerCase() === sku) : null);
      const p = v ? products.find(x => x.id === v.productId) : (products.find(x => vid && x.shopifyVariantId === vid) || (sku ? products.find(x => String(x.sku || '').toLowerCase() === sku && !x.hasVariants) : null));
      const total = cents(li.discountedTotalSet), qty = Number(li.quantity) || 1;
      const opts = (li.customAttributes || []).filter(a => a.key && a.value && !String(a.key).startsWith('_')).map(a => a.key + ': ' + a.value).join(' · ');
      return { qty, name: clean(li.title + (li.variantTitle ? ' · ' + li.variantTitle : ''), 160), productId: p ? p.id : '', variantId: v ? v.id : '', matched: !!p, totalCents: total, unitPriceCents: Math.round(total / qty), vatClass: (p && p.vatClass) || 'standard', type: p ? (p.type === 'stock' ? 'mto' : p.type) : 'mto', spec: { model: clean(li.title, 120), size: '', fabric: '', colour: '', legs: '', notes: clean(opts, 500) } };
    });
    const ship = (o.shippingLines && o.shippingLines.nodes || []).filter(s => cents(s.originalPriceSet) > 0);
    for (const s of ship) lines.push({ qty: 1, name: clean('Delivery · ' + s.title, 160), productId: '', variantId: '', matched: true, totalCents: cents(s.originalPriceSet), unitPriceCents: cents(s.originalPriceSet), vatClass: 'standard', type: 'nonstock', custom: true, spec: null });
    const total = cents(o.totalPriceSet), sum = lines.reduce((n, l) => n + l.totalCents, 0);
    if (total !== sum && total > 0) lines.push({ qty: 1, name: total > sum ? 'Tax and charges on the Shopify order' : 'Discount on the Shopify order', productId: '', variantId: '', matched: true, totalCents: total - sum, unitPriceCents: total - sum, vatClass: 'standard', type: 'nonstock', custom: true, spec: null });
    const paid = Math.min(total, cents(o.totalReceivedSet));
    plan.push({ id: idOf(o), name: o.name, already: !!had, alreadyDocNo: had ? had.docNo : '', createdAt: o.createdAt, financialStatus: o.displayFinancialStatus || '', client: { name: nameOf(o), phone: phoneOf(o), email: emailOf(o), existing: cust ? cust.id : '' }, address: o.shippingAddress || null, note: clean(o.note, 300), lines, totalCents: total, paidCents: paid, balanceCents: total - paid, unmatched: lines.filter(l => !l.matched).length, _o: o });
  }
  return plan;
}

// bring them in: one transaction per order (its number, the client when new, the order)
export async function importShopifyOrders(ctx, plan) {
  const ss = specialSettings(ctx.settings);
  const out = [];
  for (const x of plan.filter(p => !p.already)) {
    const a = x.address || {};
    const address = { line1: clean(a.address1, 120), line2: clean(a.address2, 120), city: clean(a.city, 80), code: clean(a.zip, 12) };
    const r = await runSale(ctx, {}, { more: async (tx) => {
      if (await getDoc('specialOrders', x.id, tx)) return { writes: [], result: { skipped: true } };
      const now = nowIso();
      const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
      const writes = [];
      let customerId = x.client.existing;
      if (!customerId) {
        customerId = randomId('cu_');
        const pk = phoneOk(x.client.phone) ? phoneKey(x.client.phone) : '';
        if (pk && await getDoc('customerPhones', ctx.entityId + '_' + pk, tx)) customerId = (await getDoc('customerPhones', ctx.entityId + '_' + pk, tx)).customerId;
        else {
          writes.push({ create: true, coll: 'customers', id: customerId, data: { name: x.client.name, contact: x.client.name, phone: x.client.phone, phoneKey: pk, email: x.client.email, emailKey: emailKey(x.client.email), vatNo: '', address, dob: '', tags: ['shopify'], notes: 'From Shopify order ' + x.name, consent: blankConsent(), accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, loyalty: blankLoyalty(), stats: blankStats(), mergedIds: [], altPhones: [], mergedInto: '', anonymised: false, anonymisedAt: '', archived: false, ...serverStamp(ctx.entityId, '', ctx.user.id, ctx.deviceId), updatedAt: now } });
          if (pk) writes.push({ set: true, coll: 'customerPhones', id: ctx.entityId + '_' + pk, data: { customerId, entityId: ctx.entityId, storeId: '', updatedAt: now } });
        }
      }
      const num = await nextFromCounter(tx, ctx, 'SO', ctx.entity.specialOrderPrefix || (ctx.entity.invoicePrefix + '-SO'));
      const lines = x.lines.map((l, i) => ({ lineNo: i + 1, productId: l.productId, variantId: l.variantId, itemId: l.variantId || l.productId, name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents, listPriceCents: l.unitPriceCents, lineTotalCents: l.totalCents, discountCents: 0, saleDiscountCents: 0, netCents: l.totalCents, vatClass: l.vatClass, vatCents: l.vatClass === 'standard' && ctx.entity.vatRegistered ? vatIn(l.totalCents, 1500) : 0, type: l.type, trackStock: false, custom: !!l.custom || !l.productId, note: '', spec: l.spec }));
      const status = x.paidCents > 0 ? 'depositPaid' : 'quoted';
      const opened = x.createdAt || now;
      const so = {
        series: 'SO', seq: num.seq, docNo: num.docNo, source: 'shopify', invoiceBy: 'shopify', urgent: true, shopify: { id: x._o.id, name: x.name, createdAt: x.createdAt, financialStatus: x.financialStatus },
        customerId, customerSnapshot: { name: x.client.name, phone: x.client.phone, email: x.client.email, vatNo: '', address },
        lines, lineCount: lines.length, subtotalCents: x.totalCents, saleDiscountCents: 0, saleDiscountPct: 0, saleDiscountReason: '', totalCents: x.totalCents,
        vatCents: lines.reduce((n, l) => n + l.vatCents, 0), vatRegistered: !!ctx.entity.vatRegistered,
        minDepositPct: ss.minDepositPct, minDepositCents: pctOf(x.totalCents, ss.minDepositPct), leadDays: ss.leadDays,
        depositCents: x.paidCents, paidCents: x.paidCents, balanceCents: x.totalCents - x.paidCents,
        history: x.paidCents > 0 ? [{ at: opened, amountCents: x.paidCents, methods: ['shopify'], n: 0, storeId: ctx.storeId, ref: x.name }] : [],
        status, statusHistory: [{ status, at: now, byName: ctx.user.name, source: 'shopify', note: 'Brought in from Shopify order ' + x.name }],
        expectedAt: new Date(Date.parse(opened) + ss.leadDays * 86400000).toISOString().slice(0, 10), openedAt: opened,
        signoff: { accepted: true, signedBy: x.client.name, signature: '', text: `Ordered on the online shop: Shopify order ${x.name}.`, acceptedAt: opened },
        note: x.note, updates: [], updateDue: true, cashierUid: ctx.user.id, cashierName: ctx.user.name + ' (from Shopify)', registerId: '', shiftId: '',
        ...stamp, serverReceivedAt: now, updatedAt: now
      };
      writes.push({ create: true, coll: 'specialOrders', id: x.id, data: so });
      writes.push({ create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'specialOrder.fromShopify', docType: 'specialOrder', docId: x.id, docNo: num.docNo, actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: '', overrideName: '', details: { shopify: x.name, totalCents: x.totalCents, paidCents: x.paidCents }, ...stamp, serverReceivedAt: now } });
      writes.push(num.write);
      return { writes, result: { docNo: num.docNo } };
    } });
    out.push({ name: x.name, id: x.id, docNo: r.docNo || '', skipped: !!r.skipped });
  }
  return out;
}
