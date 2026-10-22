// Retail POS — Shopify for one entity: the secrets the owner enters, the
// locations mapped to stores, products linked by SKU (Shopify is master
// for content, the POS for stock), stock pushed after every movement
// (lib/shopify-pos.mjs), orders in by webhook (reserve or deduct, cancel,
// refund), the click & collect list, discount codes shared with the till,
// consented customers pushed, and the sync log.
//
//   connect     { entityId, domain, clientId, clientSecret, siteUrl }   the owner; the keys are proven and kept server-side, then
//                                                               setup runs: webhooks registered on the app, stores mapped to
//                                                               locations by name, products linked by SKU, stock pushed, codes pulled
//   setup       { entityId, siteUrl? }                         the owner: run those steps again (each one is safe to repeat)
//   disconnect  { entityId }                                   the owner; our webhooks are removed from the app
//   catalogue   { entityId }                                   the owner: what bringing the shop's catalogue in would do (new, updated, variants, opening stock)
//   catalogueImport { entityId, openingStock }                 the owner: bring it in; with openingStock the shop's stock becomes the opening stock of items that never moved here
//   status      { entityId }                                   managers: connected? locations? the queue and the last error
//   settings    { entityId, locationByStore, defaultStoreId, pushStock, pullOrders, syncCodes, syncCustomers }   the owner
//   locations   { entityId }                                   the shop's locations, to map
//   link        { entityId }                                   managers: link by SKU, pull content
//   pushStock   { entityId }                                   managers: queue every linked item and flush
//   syncNow     { entityId }                                   managers: flush the queue, pull codes, push customers
//   pullCodes   { entityId } · pushCustomers { entityId }
//   orders      { entityId, storeId? }                         the online orders (click & collect first)
//   collect     { orderId, status: 'ready'|'collected' }       a supervisor: mark it, and fulfil it on Shopify when collected
//   log         { entityId }                                   the last sync entries
//   webhooks: POST ?hook=1&e=<entityId> with X-Shopify-Topic orders/create | orders/cancelled | refunds/create, signed with the client secret
//
// Env: FACTORY_SERVICE_ACCOUNT, SHOPIFY_API_BASE (tests only).
import { json, Reject, clean, randomId, nowIso, getDoc, query, commit, createDoc, patchDoc, deleteDoc, loginOf, loadUser, inEntity, inStore, rank, serverStamp, bodyOf, audit } from './lib/pos.mjs';
import { whoAndWhere, runSale, moveWrites, approved } from './lib/sale.mjs';
import { gql, gidNum, secretsOf, settingsOf, patchShopify, verifyWebhook, logSync, queueStock, flushStock } from './lib/shopify-pos.mjs';
import { pullCatalogue, planCatalogue, planStock, applyCatalogue } from './lib/shopify-catalogue.mjs';

async function who(event, b, minRole = 'manager') {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const user = await loadUser(login.sub);
  if (!user || rank(user.role) < rank(minRole)) throw new Reject(403, minRole === 'owner' ? 'This is for the owner.' : `This is for ${minRole}s and the owner.`);
  const entityId = clean(b.entityId, 40);
  if (!entityId || !inEntity(user, entityId)) throw new Reject(403, 'Not your company.');
  return { user, entityId };
}
async function cfgOf(entityId) { const c = await secretsOf(entityId); if (!c) throw new Reject(409, 'Shopify is not connected for this company: the owner connects it under Admin → Settings → Shopify.'); return c; }
const money = (c) => 'R ' + (c / 100).toFixed(2);
// the scopes the Dev Dashboard app needs; shown on the card with a Copy button
export const SCOPES = ['read_products', 'write_inventory', 'read_inventory', 'read_locations', 'read_orders', 'write_orders', 'write_merchant_managed_fulfillment_orders', 'read_discounts', 'read_customers', 'write_customers'];
const TOPICS = { 'orders/create': 'ORDERS_CREATE', 'orders/cancelled': 'ORDERS_CANCELLED', 'refunds/create': 'REFUNDS_CREATE' };
const hookPath = (entityId) => '/.netlify/functions/pos-shopify?hook=1&e=' + entityId;
// where the webhooks must call: the site the owner is on (sent by the page), else the host this request came to
function siteOf(event, b, sh = {}) {
  const given = clean(b.siteUrl, 200).replace(/\/+$/, '');
  if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(given)) return given;
  if (sh.siteUrl) return sh.siteUrl;
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || '';
  return host ? `${h['x-forwarded-proto'] || 'https'}://${host}` : '';
}

// ---- the webhooks on the app: ours found, moved or created, one per topic; safe to run again
async function ourWebhooks(cfg) {
  const d = await gql(cfg, `query { webhookSubscriptions(first: 100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  return d.webhookSubscriptions.nodes.map(n => ({ id: n.id, topic: n.topic, url: (n.endpoint && n.endpoint.callbackUrl) || '' })).filter(n => /\/pos-shopify\?hook=1&e=/.test(n.url));
}
async function registerWebhooks(entityId, cfg, siteUrl) {
  if (!siteUrl) throw new Error('No site address to register the webhooks to.');
  const url = siteUrl + hookPath(entityId);
  const have = await ourWebhooks(cfg);
  const out = [];
  for (const [name, topic] of Object.entries(TOPICS)) {
    const mine = have.filter(h => h.topic === topic);
    const exact = mine.find(h => h.url === url);
    if (exact) { out.push({ topic: name, id: exact.id, url }); continue; }
    if (mine.length) { await gql(cfg, `mutation($id: ID!, $w: WebhookSubscriptionInput!) { webhookSubscriptionUpdate(id: $id, webhookSubscription: $w) { webhookSubscription { id } userErrors { field message } } }`, { id: mine[0].id, w: { callbackUrl: url } }); out.push({ topic: name, id: mine[0].id, url }); continue; }
    const m = await gql(cfg, `mutation($topic: WebhookSubscriptionTopic!, $w: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $w) { webhookSubscription { id } userErrors { field message } } }`, { topic, w: { callbackUrl: url, format: 'JSON' } });
    out.push({ topic: name, id: m.webhookSubscriptionCreate.webhookSubscription.id, url });
  }
  return out;
}
async function removeWebhooks(cfg) {
  let n = 0;
  for (const h of await ourWebhooks(cfg)) { await gql(cfg, `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }`, { id: h.id }); n++; }
  return n;
}
// ---- stores to locations without asking: a location whose name matches the store's, or the only location for the only store
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function autoMap(entityId, locations) {
  const sh = await settingsOf(entityId);
  const stores = (await query('stores', [{ field: 'entityId', value: entityId }], 100)).filter(s => s.active !== false);
  const map = { ...(sh.locationByStore || {}) };
  const used = new Set(Object.values(map));
  const mapped = [];
  for (const s of stores) {
    if (map[s.id]) continue;
    const byName = locations.find(l => !used.has(l.id) && norm(l.name) && norm(s.name) && (norm(l.name).includes(norm(s.name)) || norm(s.name).includes(norm(l.name))));
    const pick = byName || (locations.length === 1 && stores.length === 1 && !used.size ? locations[0] : null);
    if (pick) { map[s.id] = pick.id; used.add(pick.id); mapped.push(`${s.name} → ${pick.name}`); }
  }
  const defaultStoreId = sh.defaultStoreId && stores.some(s => s.id === sh.defaultStoreId) ? sh.defaultStoreId : (stores.length === 1 ? stores[0].id : (Object.keys(map)[0] || ''));
  await patchShopify(entityId, { locationByStore: map, defaultStoreId });
  return { mapped, unmapped: stores.filter(s => !map[s.id]).map(s => s.name) };
}
// ---- the whole setup after Connect, every step on its own so one failure does not stop the rest; the outcome kept for the card
async function runSetup(entityId, cfg, siteUrl, w) {
  const setup = { at: nowIso(), siteUrl, webhooks: 0, mapped: [], unmapped: [], linked: 0, seen: 0, unmatched: 0, queued: 0, pushed: 0, codes: 0, errors: [] };
  const step = async (what, fn) => { try { await fn(); } catch (e) { setup.errors.push(what + ': ' + String(e.message).slice(0, 200)); await logSync(entityId, 'setup', 'failed', what + ': ' + e.message); } };
  await step('webhooks', async () => { const hooks = await registerWebhooks(entityId, cfg, siteUrl); setup.webhooks = hooks.length; await patchShopify(entityId, { webhooks: hooks, siteUrl }); });
  await step('locations', async () => { const sh = await settingsOf(entityId); const r = await autoMap(entityId, sh.locations || []); setup.mapped = r.mapped; setup.unmapped = r.unmapped; });
  await step('link', async () => { const r = await linkBySku(entityId, cfg); setup.linked = r.linked; setup.seen = r.seen; setup.unmatched = r.unmatched.length; await patchShopify(entityId, { linkedAt: nowIso() }); await logSync(entityId, 'link', 'ok', `${r.linked} of ${r.seen} Shopify variants linked by SKU`); });
  await step('stock', async () => { setup.queued = await queueAll(entityId); const r = await flushStock(entityId, { budgetMs: 8000, max: 200 }); setup.pushed = r.pushed || 0; });
  await step('codes', async () => { setup.codes = await pullCodes(entityId, cfg); });
  await patchShopify(entityId, { setup, lastSyncAt: nowIso() });
  await logSync(entityId, 'setup', setup.errors.length ? 'retry' : 'ok', `webhooks ${setup.webhooks}, ${setup.mapped.length} store(s) mapped, ${setup.linked} of ${setup.seen} linked, ${setup.pushed} stock figures pushed, ${setup.codes} codes${setup.errors.length ? ' · ' + setup.errors.join(' · ') : ''}`);
  await audit({ action: 'shopify.setup', docType: 'settings', docId: entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { webhooks: setup.webhooks, mapped: setup.mapped.length, linked: setup.linked, pushed: setup.pushed, errors: setup.errors }, entityId, storeId: '', deviceId: 'office' });
  return setup;
}

const cents = (s) => Math.round(Number(s || 0) * 100);

// ---- linking by SKU: every variant on Shopify against the POS catalogue
async function linkBySku(entityId, cfg) {
  const [products, variants] = await Promise.all([query('products', [{ field: 'entityId', value: entityId }], 5000), query('variants', [{ field: 'entityId', value: entityId }], 10000)]);
  const bySku = new Map();
  for (const v of variants) if (v.sku) bySku.set(v.sku.trim().toLowerCase(), { v, p: products.find(p => p.id === v.productId) });
  for (const p of products) if (p.sku && !p.hasVariants && !bySku.has(p.sku.trim().toLowerCase())) bySku.set(p.sku.trim().toLowerCase(), { p });
  let after = null, linked = 0, seen = 0, unmatched = [];
  const writes = []; const touched = new Set();
  for (let page = 0; page < 40; page++) {
    const d = await gql(cfg, `query($after: String) { productVariants(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id sku title inventoryItem { id tracked } product { id title handle descriptionHtml status images(first: 3) { nodes { url } } } } } }`, { after });
    const pv = d.productVariants;
    for (const n of pv.nodes) {
      seen++;
      const hit = n.sku ? bySku.get(n.sku.trim().toLowerCase()) : null;
      if (!hit) { if (unmatched.length < 50) unmatched.push(n.sku || n.title); continue; }
      const now = nowIso();
      if (hit.v) writes.push({ update: true, coll: 'variants', id: hit.v.id, data: { shopifyVariantId: n.id, shopifyInventoryItemId: n.inventoryItem ? n.inventoryItem.id : '', shopifyProductId: n.product.id, linkedAt: now, updatedAt: now } });
      else writes.push({ update: true, coll: 'products', id: hit.p.id, data: { shopifyVariantId: n.id, shopifyInventoryItemId: n.inventoryItem ? n.inventoryItem.id : '', linkedAt: now, updatedAt: now } });
      // Shopify is master for content: the title, description and pictures come across
      if (hit.p && !touched.has(hit.p.id)) { touched.add(hit.p.id); writes.push({ update: true, coll: 'products', id: hit.p.id, data: { shopifyProductId: n.product.id, shopifyHandle: n.product.handle || '', name: n.product.title || hit.p.name, description: String(n.product.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) || hit.p.description || '', images: (n.product.images && n.product.images.nodes || []).map(i => i.url).filter(Boolean).slice(0, 3), contentFrom: 'shopify', updatedAt: now } }); }
      linked++;
    }
    if (!pv.pageInfo.hasNextPage) break;
    after = pv.pageInfo.endCursor;
  }
  for (let i = 0; i < writes.length; i += 400) await commit(writes.slice(i, i + 400));
  return { seen, linked, unmatched };
}
// every linked item of every mapped store onto the queue
async function queueAll(entityId) {
  const sh = await settingsOf(entityId);
  const stores = Object.keys(sh.locationByStore || {}).filter(k => sh.locationByStore[k]);
  let n = 0;
  for (const storeId of stores) {
    const levels = new Map((await query('stockLevels', [{ field: 'entityId', value: entityId }, { field: 'storeId', value: storeId }], 10000)).map(l => [l.id, l]));
    const items = [...levels.values()].map(l => l.variantId || l.productId);
    for (let i = 0; i < items.length; i += 200) await queueStock(entityId, storeId, items.slice(i, i + 200), levels);
    n += items.length;
  }
  return n;
}
// discount codes: the shop's active code discounts, kept for the till
async function pullCodes(entityId, cfg) {
  const d = await gql(cfg, `query { codeDiscountNodes(first: 100, query: "status:active") { nodes { id codeDiscount { __typename ... on DiscountCodeBasic { title status startsAt endsAt usageLimit codes(first: 5) { nodes { code } } customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } items { __typename } } } ... on DiscountCodeFreeShipping { title status startsAt endsAt codes(first: 5) { nodes { code } } } } } } }`);
  const now = nowIso(); const writes = []; const codes = [];
  for (const n of d.codeDiscountNodes.nodes) {
    const cd = n.codeDiscount; if (!cd || cd.__typename !== 'DiscountCodeBasic') continue;
    const v = cd.customerGets && cd.customerGets.value;
    const kind = v && v.__typename === 'DiscountPercentage' ? 'percentage' : v && v.__typename === 'DiscountAmount' ? 'fixed' : '';
    if (!kind) continue;
    const allItems = cd.customerGets.items && cd.customerGets.items.__typename === 'AllDiscountItems';
    for (const c of cd.codes.nodes) {
      const code = String(c.code || '').toUpperCase(); if (!code) continue;
      codes.push(code);
      writes.push({ set: true, coll: 'discountCodes', id: entityId + '_' + code, data: { entityId, storeId: '', code, title: cd.title || code, kind, value: kind === 'percentage' ? Math.round(Number(v.percentage) * 10000) / 100 : 0, valueCents: kind === 'fixed' ? cents(v.amount.amount) : 0, startsAt: cd.startsAt || '', endsAt: cd.endsAt || '', active: cd.status === 'ACTIVE', wholeSale: !!allItems, shopifyId: n.id, pulledAt: now, createdBy: 'server', createdAt: now, deviceId: 'server', updatedAt: now } });
    }
  }
  // codes gone from the shop are switched off here
  const had = await query('discountCodes', [{ field: 'entityId', value: entityId }], 2000);
  for (const h of had) if (!codes.includes(h.code) && h.active) writes.push({ update: true, coll: 'discountCodes', id: h.id, data: { active: false, updatedAt: now } });
  for (let i = 0; i < writes.length; i += 400) await commit(writes.slice(i, i + 400));
  return codes.length;
}
// customers who said yes to marketing go to Shopify with that consent; by email, else by phone
async function pushCustomers(entityId, cfg, { all = false } = {}) {
  const sh = await settingsOf(entityId);
  const since = all ? '' : sh.customersPushedAt || '';
  const list = (await query('customers', [{ field: 'entityId', value: entityId }], 10000)).filter(c => !c.anonymised && !c.mergedInto && c.consent && ((c.consent.email && c.consent.email.granted) || (c.consent.sms && c.consent.sms.granted)) && (!since || String(c.updatedAt || c.createdAt) > since));
  let pushed = 0, failed = 0;
  for (const c of list.slice(0, 200)) {
    const emailOk = c.consent.email && c.consent.email.granted && c.email, smsOk = c.consent.sms && c.consent.sms.granted && c.phoneKey;
    if (!emailOk && !smsOk) continue;
    const input = { firstName: String(c.name).split(' ')[0], lastName: String(c.name).split(' ').slice(1).join(' '), ...(c.email ? { email: c.email } : {}), ...(c.phoneKey ? { phone: '+' + c.phoneKey } : {}), ...(emailOk ? { emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: c.consent.email.at || nowIso() } } : {}), ...(smsOk ? { smsMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: c.consent.sms.at || nowIso() } } : {}), tags: ['pos', ...(c.tags || [])].slice(0, 20) };
    try {
      let id = c.shopifyCustomerId;
      if (!id) { const q = c.email ? `email:${c.email}` : `phone:+${c.phoneKey}`; const f = await gql(cfg, `query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`, { q }); id = f.customers.nodes[0] && f.customers.nodes[0].id; }
      if (id) await gql(cfg, `mutation($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } userErrors { field message } } }`, { input: { id, ...input } });
      else { const m = await gql(cfg, `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, { input }); id = m.customerCreate.customer.id; }
      await patchDoc('customers', c.id, { shopifyCustomerId: id, shopifyPushedAt: nowIso() });
      pushed++;
    } catch (e) { failed++; await logSync(entityId, 'customers', 'failed', `${c.name}: ${e.message}`); }
  }
  await patchShopify(entityId, { customersPushedAt: nowIso() });
  return { pushed, failed, of: list.length };
}

// ---- an online order in: the lines mapped to POS items, stock reserved or deducted at the mapped store
function mapOrder(entityId, sh, o, products, variants) {
  const lines = (o.line_items || []).map(li => {
    const vid = li.variant_id ? 'gid://shopify/ProductVariant/' + li.variant_id : '';
    const sku = String(li.sku || '').trim().toLowerCase();
    const v = variants.find(x => x.shopifyVariantId === vid) || (sku ? variants.find(x => String(x.sku || '').toLowerCase() === sku) : null);
    const p = v ? products.find(x => x.id === v.productId) : (products.find(x => x.shopifyVariantId === vid) || (sku ? products.find(x => String(x.sku || '').toLowerCase() === sku && !x.hasVariants) : null));
    return { title: li.title + (li.variant_title ? ' · ' + li.variant_title : ''), sku: li.sku || '', qty: Number(li.quantity) || 0, priceCents: cents(li.price), lineId: String(li.id), productId: p ? p.id : '', variantId: v ? v.id : '', itemId: v ? v.id : (p ? p.id : ''), tracked: !!(p && p.type === 'stock' && p.trackStock !== false), name: p ? p.name + (v ? ' · ' + v.name : '') : '' };
  });
  const ship = (o.shipping_lines || [])[0] || {};
  const pickupMap = sh.pickupByTitle || {};
  const pickup = !!(ship.title && (pickupMap[ship.title] || /pick ?up|collect/i.test(ship.title + ' ' + (ship.code || ''))));
  const storeId = (pickup && pickupMap[ship.title]) || sh.defaultStoreId || Object.keys(sh.locationByStore || {})[0] || '';
  const cust = o.customer || {};
  return { entityId, storeId: storeId || '', shopifyOrderId: String(o.id), orderNo: o.name || ('#' + o.order_number), orderedAt: o.created_at || nowIso(), financialStatus: o.financial_status || '', fulfillmentStatus: o.fulfillment_status || '', pickup, shippingTitle: ship.title || '', customer: { name: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || (o.shipping_address || {}).name || '', email: o.email || cust.email || '', phone: o.phone || cust.phone || (o.shipping_address || {}).phone || '' }, address: o.shipping_address ? [o.shipping_address.address1, o.shipping_address.city].filter(Boolean).join(', ') : '', lines, totalCents: cents(o.total_price), currency: o.currency || 'ZAR', unmapped: lines.filter(l => !l.itemId).length };
}
async function handleWebhook(entityId, topic, raw, o) {
  const sh = await settingsOf(entityId);
  if (sh.pullOrders === false) return { skipped: 'orders off' };
  const id = entityId + '_' + String(o.id || (o.order_id ? 'r' + o.id : randomId('x')));
  const stamp = serverStamp(entityId, '', 'server', 'shopify');
  const ctxLike = (storeId) => ({ entityId, storeId, user: { id: 'shopify', name: 'Shopify' }, deviceId: 'shopify' });
  if (topic === 'orders/create') {
    const had = await getDoc('onlineOrders', id);
    if (had) return { again: true };
    const [products, variants] = await Promise.all([query('products', [{ field: 'entityId', value: entityId }], 5000), query('variants', [{ field: 'entityId', value: entityId }], 10000)]);
    const rec = mapOrder(entityId, sh, o, products, variants);
    const paid = rec.financialStatus === 'paid';
    const moves = rec.lines.filter(l => l.tracked && l.qty > 0).map(l => ({ productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: paid ? -l.qty : l.qty, bucket: paid ? 'onHand' : 'reserved', reason: 'online', name: l.name, note: 'Shopify ' + rec.orderNo, byName: 'Shopify' }));
    if (rec.storeId && moves.length) {
      await runSale(ctxLike(rec.storeId), {}, { more: async (tx, levels) => {
        const now = nowIso(); const writes = [];
        for (const m of moves) { const lid = rec.storeId + '_' + m.itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); writes.push(...moveWrites(ctxLike(rec.storeId), levels, m, { docType: 'onlineOrder', docId: id, docNo: rec.orderNo }, { ...stamp, storeId: rec.storeId }, now)); }
        writes.push({ create: true, coll: 'onlineOrders', id, data: { ...rec, status: 'new', stock: paid ? 'deducted' : 'reserved', readyAt: '', collectedAt: '', cancelledAt: '', refunds: [], ...stamp, storeId: rec.storeId, updatedAt: now } });
        return { writes, result: {} };
      } });
    } else await createDoc('onlineOrders', id, { ...rec, status: 'new', stock: 'none', readyAt: '', collectedAt: '', cancelledAt: '', refunds: [], ...stamp, updatedAt: nowIso() });
    await logSync(entityId, 'order', rec.unmapped ? 'retry' : 'ok', `${rec.orderNo}: ${rec.lines.length} line${rec.lines.length === 1 ? '' : 's'}, ${money(rec.totalCents)}${rec.pickup ? ', click & collect' : ''}${rec.unmapped ? ', ' + rec.unmapped + ' line(s) not matched to a product' : ''}`, { storeId: rec.storeId, docNo: rec.orderNo });
    return { ok: true, orderNo: rec.orderNo, stock: paid ? 'deducted' : 'reserved', unmapped: rec.unmapped };
  }
  if (topic === 'orders/cancelled') {
    const rec = await getDoc('onlineOrders', id);
    if (!rec || rec.status === 'cancelled') return { again: true };
    const restock = rec.stock === 'reserved' || rec.stock === 'deducted';
    if (restock && rec.storeId) {
      await runSale(ctxLike(rec.storeId), {}, { more: async (tx, levels) => {
        const now = nowIso(); const writes = [];
        for (const l of rec.lines.filter(x => x.tracked && x.qty > 0)) { const lid = rec.storeId + '_' + l.itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); writes.push(...moveWrites(ctxLike(rec.storeId), levels, { productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: rec.stock === 'reserved' ? -l.qty : l.qty, bucket: rec.stock === 'reserved' ? 'reserved' : 'onHand', reason: 'online', name: l.name, note: 'Shopify ' + rec.orderNo + ' cancelled', byName: 'Shopify' }, { docType: 'onlineOrder', docId: id, docNo: rec.orderNo }, { ...stamp, storeId: rec.storeId }, now)); }
        writes.push({ update: true, coll: 'onlineOrders', id, data: { status: 'cancelled', stock: 'released', cancelledAt: now, updatedAt: now } });
        return { writes, result: {} };
      } });
    } else await patchDoc('onlineOrders', id, { status: 'cancelled', cancelledAt: nowIso(), updatedAt: nowIso() });
    await logSync(entityId, 'cancel', 'ok', `${rec.orderNo} cancelled: stock ${restock ? 'back' : 'untouched'}`, { storeId: rec.storeId, docNo: rec.orderNo });
    return { ok: true };
  }
  if (topic === 'refunds/create') {
    const oid = entityId + '_' + String(o.order_id);
    const rec = await getDoc('onlineOrders', oid);
    if (!rec) return { skipped: 'order unknown' };
    const refundId = String(o.id);
    if ((rec.refunds || []).some(r => r.id === refundId)) return { again: true };
    const items = (o.refund_line_items || []).filter(r => r.restock_type && r.restock_type !== 'no_restock').map(r => { const l = rec.lines.find(x => x.lineId === String((r.line_item || {}).id || r.line_item_id)); return l && l.tracked ? { ...l, qty: Number(r.quantity) || 0 } : null; }).filter(Boolean);
    if (items.length && rec.storeId && rec.stock === 'deducted') {
      await runSale(ctxLike(rec.storeId), {}, { more: async (tx, levels) => {
        const now = nowIso(); const writes = [];
        for (const l of items) { const lid = rec.storeId + '_' + l.itemId; if (!levels.has(lid)) levels.set(lid, (await getDoc('stockLevels', lid, tx)) || null); writes.push(...moveWrites(ctxLike(rec.storeId), levels, { productId: l.productId, variantId: l.variantId, itemId: l.itemId, qty: l.qty, bucket: 'onHand', reason: 'onlineRefund', name: l.name, note: 'Shopify ' + rec.orderNo + ' refund', byName: 'Shopify' }, { docType: 'onlineOrder', docId: oid, docNo: rec.orderNo }, { ...stamp, storeId: rec.storeId }, now)); }
        writes.push({ update: true, coll: 'onlineOrders', id: oid, data: { status: rec.status === 'collected' ? 'collected' : 'refunded', refunds: [...(rec.refunds || []), { id: refundId, at: now, lines: items.map(l => ({ lineId: l.lineId, qty: l.qty })) }], updatedAt: now } });
        return { writes, result: {} };
      } });
    } else await patchDoc('onlineOrders', oid, { refunds: [...(rec.refunds || []), { id: refundId, at: nowIso(), lines: [] }], updatedAt: nowIso() });
    await logSync(entityId, 'refund', 'ok', `${rec.orderNo} refund: ${items.reduce((n, l) => n + l.qty, 0)} restocked`, { storeId: rec.storeId, docNo: rec.orderNo });
    return { ok: true, restocked: items.length };
  }
  return { skipped: 'topic ' + topic };
}

const actions = {
  async connect(event, b) {
    const w = await who(event, b, 'owner');
    const domain = clean(b.domain, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(domain)) throw new Reject(400, 'The store domain looks like name.myshopify.com.');
    const cfg = { domain, clientId: clean(b.clientId, 200), clientSecret: clean(b.clientSecret, 200) };
    if (!cfg.clientId || !cfg.clientSecret) throw new Reject(400, 'The app’s Client ID and Client secret.');
    let d; try { d = await gql(cfg, `query { shop { name primaryDomain { host } } locations(first: 20) { nodes { id name isActive } } }`, {}, { fresh: true }); } catch (e) { throw new Reject(400, e.message); }
    const had = await getDoc('shopifySecrets', w.entityId);
    if (had) await patchDoc('shopifySecrets', w.entityId, { ...cfg, updatedAt: nowIso() }); else await createDoc('shopifySecrets', w.entityId, { ...cfg, entityId: w.entityId, storeId: '', createdBy: w.user.id, createdAt: nowIso(), deviceId: 'office' });
    const locations = d.locations.nodes.filter(l => l.isActive).map(l => ({ id: l.id, name: l.name }));
    await patchShopify(w.entityId, { connected: true, domain, shopName: d.shop.name, locations, connectedAt: nowIso(), lastError: '', pushStock: true, pullOrders: true, syncCodes: true, syncCustomers: true });
    await audit({ action: 'shopify.connect', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { domain }, entityId: w.entityId, storeId: '', deviceId: 'office' });
    const setup = await runSetup(w.entityId, cfg, siteOf(event, b), w);
    return { ok: true, shopName: d.shop.name, locations, setup };
  },
  async setup(event, b) {
    const w = await who(event, b, 'owner');
    const cfg = await cfgOf(w.entityId);
    const sh = await settingsOf(w.entityId);
    return { ok: true, setup: await runSetup(w.entityId, cfg, siteOf(event, b, sh), w) };
  },
  // ---- the shop's catalogue into the till (a cut-over from ReptiCube or any shop that ran on Shopify)
  async catalogue(event, b) {
    const w = await who(event, b, 'owner');
    const cfg = await cfgOf(w.entityId);
    const sh = await settingsOf(w.entityId);
    let shop; try { shop = await pullCatalogue(cfg); } catch (e) { throw new Reject(502, e.message); }
    const plan = await planCatalogue(w.entityId, shop);
    const st = await planStock(w.entityId, plan, sh.locationByStore || {});
    const stores = await query('stores', [{ field: 'entityId', value: w.entityId }], 100);
    const name = (id) => (stores.find(s => s.id === id) || { name: id }).name;
    return { ok: true, products: plan.length, created: plan.filter(x => !x.existing).length, updated: plan.filter(x => x.existing).length, variants: plan.reduce((n, x) => n + x.variants.length, 0), archived: plan.filter(x => x.product.archived).length,
      stock: { items: st.rows.length, qty: st.rows.reduce((n, r) => n + r.qty, 0), skipped: st.skipped, stores: st.stores.map(name), perStore: st.stores.map(s => ({ store: name(s), items: st.rows.filter(r => r.storeId === s).length, qty: st.rows.filter(r => r.storeId === s).reduce((n, r) => n + r.qty, 0) })) },
      sample: plan.slice(0, 40).map(x => ({ name: x.product.name, action: x.existing ? 'update' : 'new', priceCents: x.product.priceCents, variants: x.variants.length, archived: x.product.archived })) };
  },
  async catalogueImport(event, b) {
    const w = await who(event, b, 'owner');
    const cfg = await cfgOf(w.entityId);
    const sh = await settingsOf(w.entityId);
    let shop; try { shop = await pullCatalogue(cfg); } catch (e) { throw new Reject(502, e.message); }
    const plan = await planCatalogue(w.entityId, shop);
    const r = await applyCatalogue(w.entityId, w.user, plan, { openingStock: !!b.openingStock, locationByStore: sh.locationByStore || {} });
    await patchShopify(w.entityId, { linkedAt: nowIso(), catalogueImportedAt: nowIso() });
    await logSync(w.entityId, 'link', 'ok', `catalogue brought in: ${r.created} new, ${r.updated} updated, ${r.variants} variants${b.openingStock ? `, opening stock for ${r.stock.items} item(s) (${r.stock.qty} units)` : ''}`);
    await audit({ action: 'shopify.catalogue', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { ...r, openingStock: !!b.openingStock }, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true, ...r };
  },
  async disconnect(event, b) {
    const w = await who(event, b, 'owner');
    let removed = 0;
    try { const cfg = await secretsOf(w.entityId); if (cfg) removed = await removeWebhooks(cfg); } catch (e) { await logSync(w.entityId, 'setup', 'failed', 'webhooks not removed: ' + e.message); }
    await deleteDoc('shopifySecrets', w.entityId).catch(() => {});
    await patchShopify(w.entityId, { connected: false, lastError: '', webhooks: [], setup: null });
    await audit({ action: 'shopify.disconnect', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { webhooksRemoved: removed }, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true, webhooksRemoved: removed };
  },
  async status(event, b) {
    const w = await who(event, b);
    const sh = await settingsOf(w.entityId);
    const queue = await query('shopifyQueue', [{ field: 'entityId', value: w.entityId }], 500);
    const [products, variants] = await Promise.all([query('products', [{ field: 'entityId', value: w.entityId }], 5000), query('variants', [{ field: 'entityId', value: w.entityId }], 10000)]);
    const linked = products.filter(p => p.shopifyVariantId && !p.hasVariants).length + variants.filter(v => v.shopifyVariantId).length;
    const codes = await query('discountCodes', [{ field: 'entityId', value: w.entityId }], 500);
    return { ok: true, connected: !!sh.connected && !!(await secretsOf(w.entityId)), shopName: sh.shopName || '', domain: sh.domain || '', locations: sh.locations || [], locationByStore: sh.locationByStore || {}, defaultStoreId: sh.defaultStoreId || '', pickupByTitle: sh.pickupByTitle || {}, pushStock: sh.pushStock !== false, pullOrders: sh.pullOrders !== false, syncCodes: sh.syncCodes !== false, syncCustomers: sh.syncCustomers !== false, lastSyncAt: sh.lastSyncAt || '', lastError: sh.lastError || '', queue: { count: queue.length, failing: queue.filter(q => q.attempts > 0).length, oldest: queue.map(q => q.queuedAt).sort()[0] || '' }, linked, codes: codes.filter(c => c.active).map(c => c.code), webhookUrl: hookPath(w.entityId), webhooks: sh.webhooks || [], siteUrl: sh.siteUrl || '', setup: sh.setup || null, scopes: SCOPES.join(',') };
  },
  async settings(event, b) {
    const w = await who(event, b, 'owner');
    const stores = await query('stores', [{ field: 'entityId', value: w.entityId }], 100);
    const map = {}; for (const s of stores) { const v = clean((b.locationByStore || {})[s.id], 80); if (v) map[s.id] = v; }
    const pickup = {}; for (const [k, v] of Object.entries(b.pickupByTitle || {})) { const t = clean(k, 80), sid = clean(v, 40); if (t && stores.some(s => s.id === sid)) pickup[t] = sid; }
    const patch = { locationByStore: map, pickupByTitle: pickup, defaultStoreId: stores.some(s => s.id === b.defaultStoreId) ? b.defaultStoreId : '', pushStock: b.pushStock !== false, pullOrders: b.pullOrders !== false, syncCodes: b.syncCodes !== false, syncCustomers: b.syncCustomers !== false };
    await patchShopify(w.entityId, patch);
    await audit({ action: 'shopify.settings', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: patch, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true, ...patch };
  },
  async locations(event, b) {
    const w = await who(event, b);
    const cfg = await cfgOf(w.entityId);
    const d = await gql(cfg, `query { locations(first: 50) { nodes { id name isActive address { city } } } }`);
    const locations = d.locations.nodes.filter(l => l.isActive).map(l => ({ id: l.id, name: l.name + (l.address && l.address.city ? ' · ' + l.address.city : '') }));
    await patchShopify(w.entityId, { locations });
    return { ok: true, locations };
  },
  async link(event, b) {
    const w = await who(event, b);
    const cfg = await cfgOf(w.entityId);
    try { const r = await linkBySku(w.entityId, cfg); await logSync(w.entityId, 'link', 'ok', `${r.linked} of ${r.seen} Shopify variants linked by SKU`); await patchShopify(w.entityId, { linkedAt: nowIso() }); await audit({ action: 'shopify.link', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { linked: r.linked, seen: r.seen }, entityId: w.entityId, storeId: '', deviceId: 'office' }); return { ok: true, ...r }; }
    catch (e) { await logSync(w.entityId, 'link', 'failed', e.message); throw new Reject(502, e.message); }
  },
  async pushStock(event, b) {
    const w = await who(event, b);
    await cfgOf(w.entityId);
    const n = await queueAll(w.entityId);
    const r = await flushStock(w.entityId, { budgetMs: 8000, max: 200 });
    await audit({ action: 'shopify.pushAll', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { queued: n, pushed: r.pushed || 0 }, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true, queued: n, ...r };
  },
  async syncNow(event, b) {
    const w = await who(event, b);
    const cfg = await cfgOf(w.entityId);
    const sh = await settingsOf(w.entityId);
    const out = { stock: await flushStock(w.entityId, { budgetMs: 6000, max: 100 }) };
    if (sh.syncCodes !== false) { try { out.codes = await pullCodes(w.entityId, cfg); await logSync(w.entityId, 'codes', 'ok', out.codes + ' discount codes'); } catch (e) { out.codesError = e.message; await logSync(w.entityId, 'codes', 'failed', e.message); } }
    if (sh.syncCustomers !== false) { try { out.customers = await pushCustomers(w.entityId, cfg); await logSync(w.entityId, 'customers', out.customers.failed ? 'retry' : 'ok', `${out.customers.pushed} of ${out.customers.of} consented customers pushed`); } catch (e) { out.customersError = e.message; } }
    await patchShopify(w.entityId, { lastSyncAt: nowIso() });
    return { ok: true, ...out };
  },
  async pullCodes(event, b) { const w = await who(event, b); const cfg = await cfgOf(w.entityId); try { const n = await pullCodes(w.entityId, cfg); await logSync(w.entityId, 'codes', 'ok', n + ' discount codes'); return { ok: true, codes: n }; } catch (e) { await logSync(w.entityId, 'codes', 'failed', e.message); throw new Reject(502, e.message); } },
  async pushCustomers(event, b) { const w = await who(event, b); const cfg = await cfgOf(w.entityId); const r = await pushCustomers(w.entityId, cfg, { all: !!b.all }); await logSync(w.entityId, 'customers', r.failed ? 'retry' : 'ok', `${r.pushed} of ${r.of} consented customers pushed`); return { ok: true, ...r }; },
  // the till's view: the online orders of a store (click & collect first), supervisors and up
  async orders(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    if (rank(ctx.user.role) < rank('supervisor')) throw new Reject(403, 'Online orders are for supervisors and up.');
    const rows = (await query('onlineOrders', [{ field: 'entityId', value: ctx.entityId }, { field: 'storeId', value: ctx.storeId }], 500)).sort((x, y) => (x.pickup === y.pickup ? 0 : x.pickup ? -1 : 1) || String(y.orderedAt).localeCompare(String(x.orderedAt)));
    return { ok: true, orders: rows.slice(0, 200) };
  },
  async collect(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    approved(ctx, b.approvalToken, 'online', 'supervisor', 'Marking an online order');
    const rec = await getDoc('onlineOrders', clean(b.orderId, 80));
    if (!rec || rec.entityId !== ctx.entityId) throw new Reject(404, 'No such online order.');
    const status = b.status === 'collected' ? 'collected' : 'ready';
    if (rec.status === 'cancelled') throw new Reject(409, 'That order was cancelled.');
    const now = nowIso();
    const patch = { status, ...(status === 'ready' ? { readyAt: now } : { collectedAt: now, collectedBy: ctx.user.name }), updatedAt: now };
    let fulfilled = '';
    if (status === 'collected' && rec.fulfillmentStatus !== 'fulfilled') {
      try {
        const cfg = await cfgOf(ctx.entityId);
        const d = await gql(cfg, `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 5) { nodes { id status } } } }`, { id: 'gid://shopify/Order/' + rec.shopifyOrderId });
        const fo = ((d.order || {}).fulfillmentOrders || { nodes: [] }).nodes.find(x => x.status === 'OPEN' || x.status === 'IN_PROGRESS');
        if (fo) { await gql(cfg, `mutation($f: FulfillmentInput!) { fulfillmentCreateV2(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`, { f: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }], notifyCustomer: true } }); fulfilled = 'fulfilled on Shopify'; patch.fulfillmentStatus = 'fulfilled'; }
      } catch (e) { fulfilled = 'not fulfilled on Shopify: ' + e.message; await logSync(ctx.entityId, 'order', 'retry', `${rec.orderNo}: ${fulfilled}`, { storeId: rec.storeId, docNo: rec.orderNo }); }
    }
    await patchDoc('onlineOrders', rec.id || clean(b.orderId, 80), patch);
    await audit({ action: 'online.' + status, docType: 'onlineOrder', docId: clean(b.orderId, 80), docNo: rec.orderNo, actorUid: ctx.user.id, actorName: ctx.user.name, details: { fulfilled }, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });
    return { ok: true, status, fulfilled };
  },
  async log(event, b) {
    const w = await who(event, b);
    const rows = (await query('shopifySync', [{ field: 'entityId', value: w.entityId }], 400)).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 100);
    return { ok: true, log: rows.map(r => ({ at: r.createdAt, kind: r.kind, status: r.status, message: r.message, docNo: r.docNo || '' })) };
  }
};

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  // ---- Shopify calling: a signed webhook for one entity
  if (q.hook) {
    const entityId = clean(q.e, 40);
    const h = event.headers || {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
    try {
      const cfg = await secretsOf(entityId);
      if (!cfg || !verifyWebhook(raw, h['x-shopify-hmac-sha256'] || h['X-Shopify-Hmac-Sha256'], cfg.clientSecret)) return json(401, { error: 'bad signature' });
      const topic = String(h['x-shopify-topic'] || h['X-Shopify-Topic'] || '');
      const r = await handleWebhook(entityId, topic, raw, JSON.parse(raw.toString('utf8') || '{}'));
      return json(200, { ok: true, ...r });
    } catch (e) { console.error('pos-shopify webhook', e); await logSync(entityId, 'order', 'failed', e.message); return json(500, { error: 'webhook failed' }); }
  }
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-shopify failed:', e);
    return json(500, { error: 'Something went wrong on the server: ' + String(e.message).slice(0, 200) });
  }
};
