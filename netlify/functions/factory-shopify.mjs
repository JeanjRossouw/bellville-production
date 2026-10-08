// Shopify for the factory app: each company connects its own online shop.
//
//   POST { action:'connect', domain, clientId, clientSecret, importWhen }   owner
//   POST { action:'disconnect' }                                             owner
//   POST { action:'settings', importWhen }                                   owner
//   POST { action:'products' }   bring the shop's products in                owner
//   POST { action:'sync' }       bring new online orders in now              owner
//   POST { action:'pushSale', saleId }   a till sale took stock: tell Shopify  any member
//   POST ?c=<company id> from Shopify (orders/create, orders/paid)           signed by Shopify
//
// What lives where (all written here, with the service account; the app
// itself can never read the keys):
//   companies/<cid>/secrets/shopify        store domain, Client ID and secret
//   companies/<cid>/integrations/shopify   status the app shows (no secrets)
//   companies/<cid>/shopifyOrders/<id>     each online order, once
//   companies/<cid>/shopifyPushes/<sale>   each till sale sent, once
//   shopifyLinks/<cid>                     which companies the 15-minute check visits
import { verifyFirebaseToken } from './lib/auth.mjs';
import {
  getDoc, patchDoc, createDoc, deleteDoc, query, commitWrites, nextNumber, companyActive, projectId
} from './lib/factory-firestore.mjs';
import * as shopify from './lib/factory-shopify.mjs';
import { wantOrder, orderLines, orderDocId, customerOf, mapLine, mapProduct } from '../../couchpotato/js/shopify-map.js';

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const nowIso = () => new Date().toISOString();
const CID = /^[A-Za-z0-9_-]{1,64}$/;

function siteUrl(event) {
  const h = event.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (host && /(^|\.)netlify\.app$|^localhost(:\d+)?$/i.test(host)) return (/^localhost/.test(host) ? 'http://' : 'https://') + host;
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
}
const hookUrl = (event, cid) => siteUrl(event) + '/.netlify/functions/factory-shopify?c=' + encodeURIComponent(cid);

// The signed-in person, their company and their role in it.
async function whoIs(event) {
  const h = event.headers || {};
  const header = h.authorization || h.Authorization || '';
  const user = await verifyFirebaseToken(header.startsWith('Bearer ') ? header.slice(7) : '', projectId());
  const me = await getDoc('users/' + user.sub);
  if (!me || !me.companyId) throw new Error('No company for this login');
  const member = await getDoc(`companies/${me.companyId}/members/${user.sub}`);
  if (!member) throw new Error('Not part of this company');
  const company = await getDoc('companies/' + me.companyId);
  if (!company) throw new Error('Company not found');
  return { user, member, company, cid: me.companyId, owner: member.role === 'owner' };
}

const secretsOf = (cid) => getDoc(`companies/${cid}/secrets/shopify`);
const statusPath = (cid) => `companies/${cid}/integrations/shopify`;
async function vatOf(cid) {
  const s = (await getDoc(`companies/${cid}/settings/factory`)) || {};
  // the same default as the app (config.js): 15% when registered and never changed
  return { settings: s, vatRate: s.vatRegistered ? (s.vatRate == null ? 0.15 : Number(s.vatRate) || 0) : 0 };
}

// ------------------------------------------------------- online orders ----

// One Shopify order into the company: its customer, then one factory order
// per line. Safe to run twice for the same order (webhook and the 15-minute
// check can both see it): every line has a fixed id and is only created once.
export async function importOrder(cid, o, ctx) {
  const st = ctx.status || {};
  const marker = `companies/${cid}/shopifyOrders/${o.id}`;
  const seen = await getDoc(marker);
  const paidNow = ['paid', 'partially_paid'].includes(String(o.financial_status || ''));
  if (seen) {
    // brought in before it was paid ("as soon as placed"): note the payment
    if (paidNow && !seen.paid) {
      const day = String(o.processed_at || nowIso()).slice(0, 10);
      for (const id of seen.orderIds || []) await patchDoc(`companies/${cid}/orders/${id}`, { paidDate: day, updatedAt: nowIso(), updatedBy: 'Shopify' }).catch(() => {});
      await patchDoc(marker, { paid: true, paidAt: nowIso() });
      return { order: o.name, paidLater: true };
    }
    return null;
  }
  if (!wantOrder(o, st.importWhen)) return null;

  const { settings, vatRate } = ctx.vat || await vatOf(cid);
  const parent = 'companies/' + cid;

  // the customer: the same email or cell number, or a new one
  const c = customerOf(o);
  let customer = null;
  if (c.email) customer = (await query(parent, 'customers', { email: c.email }, 1))[0] || null;
  if (!customer && c.phone) customer = (await query(parent, 'customers', { phone: c.phone }, 1))[0] || null;
  let customerId = customer ? customer.id : '';
  if (!customerId) {
    customerId = 'shopify-c-' + (o.customer && o.customer.id ? o.customer.id : o.id);
    await createDoc(`${parent}/customers/${customerId}`, { ...c, notes: 'Added from online order ' + (o.name || ''), source: 'shopify',
      createdAt: nowIso(), createdBy: 'Shopify', updatedAt: nowIso(), updatedBy: 'Shopify' });
  }
  const customerName = customer ? customer.name : c.name;

  const made = [];
  for (const li of orderLines(o)) {
    const id = orderDocId(o, li);
    if (await getDoc(`${parent}/orders/${id}`)) { made.push({ id }); continue; }
    const product = li.variant_id ? (await query(parent, 'products', { shopifyVariantId: String(li.variant_id) }, 1))[0] || null : null;
    const qty = Number(li.current_quantity ?? li.quantity) || 1;
    const fromStock = !!(product && Number(product.stock) >= qty && qty > 0);
    const doc = mapLine(o, li, { customerId, customerName, product, fromStock, leadDays: settings.leadDays, vatRate });
    const n = await nextNumber(cid, 'orderNo', settings.firstOrderNo || 1001);
    doc.orderNo = (settings.orderPrefix || 'CP-') + n;
    if (await createDoc(`${parent}/orders/${id}`, doc)) {
      made.push({ id, orderNo: doc.orderNo });
      // Shopify already took it off its own count; take it off ours too
      if (fromStock) await commitWrites([{ path: `${parent}/products/${product.id}`, inc: { stock: -qty } }]);
    } else made.push({ id });
  }
  if (!made.length) return null;
  await createDoc(marker, { name: o.name || '', at: nowIso(), paid: paidNow, orderIds: made.map(m => m.id), customerId });
  const fresh = made.filter(m => m.orderNo);
  if (fresh.length) {
    await commitWrites([{ path: statusPath(cid), data: { lastOrderAt: nowIso(), lastOrderName: o.name || '' } }, { path: statusPath(cid), inc: { ordersIn: 1 } }]);
  }
  return { order: o.name, orders: fresh.map(m => m.orderNo) };
}

// Look for orders the webhooks may have missed (or that came while the app
// was locked). Runs every 15 minutes, and from the "Check now" button.
export async function syncCompany(cid, { budgetMs = 8000 } = {}) {
  const started = Date.now();
  const st = await getDoc(statusPath(cid));
  if (!st || !st.connected) return { cid, skipped: 'not connected' };
  const company = await getDoc('companies/' + cid);
  if (!companyActive(company)) return { cid, skipped: 'subscription not active' };
  const cfg = await secretsOf(cid);
  if (!cfg || !cfg.clientSecret) return { cid, skipped: 'no keys' };

  const since = new Date(Date.parse(st.lastCheckedAt || st.connectedAt || nowIso()) - 10 * 60000).toISOString();
  const connectedAt = Date.parse(st.connectedAt || 0) || 0;
  const ctx = { status: st, vat: await vatOf(cid) };
  let orders;
  try { orders = await shopify.listOrders(cfg, since); }
  catch (e) { await patchDoc(statusPath(cid), { lastError: e.message, lastErrorAt: nowIso() }); throw e; }
  const done = [];
  let upTo = new Date(started).toISOString();
  for (const o of orders) {
    if (Date.now() - started > budgetMs) { upTo = o.updated_at || upTo; break; }    // carry on next time from here
    if (Date.parse(o.created_at) < connectedAt) continue;                            // from before the shop was connected
    const r = await importOrder(cid, o, ctx);
    if (r) done.push(r);
  }
  await patchDoc(statusPath(cid), { lastCheckedAt: upTo, lastError: '' });
  return { cid, looked: orders.length, brought: done };
}

// ------------------------------------------------------------- actions ----

async function connect(event, who, body) {
  if (!who.owner) throw new Error('Only the owner can connect the online shop');
  const domain = shopify.normaliseDomain(body.domain);
  if (!domain) throw new Error('That does not look like a Shopify store. Use the address that ends in .myshopify.com');
  const cfg = { domain, clientId: String(body.clientId || '').trim(), clientSecret: String(body.clientSecret || '').trim() };
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Paste both the Client ID and the Client secret');
  const s = await shopify.shop(cfg);                     // proves the keys work
  cfg.locationId = s.primaryLocationId || await shopify.locationId(cfg).catch(() => '');
  let hooks = 'on';
  try { await shopify.addWebhooks(cfg, hookUrl(event, who.cid)); }
  catch (e) { hooks = e.message; }
  const before = (await getDoc(statusPath(who.cid))) || {};
  await patchDoc(`companies/${who.cid}/secrets/shopify`, cfg);
  await patchDoc(statusPath(who.cid), {
    connected: true, domain, shopName: s.name, currency: s.currency, taxesIncluded: s.taxesIncluded,
    connectedAt: nowIso(), connectedBy: who.member.name || who.user.email || '', lastCheckedAt: nowIso(),
    importWhen: body.importWhen === 'placed' ? 'placed' : 'paid', webhooks: hooks, lastError: '', ordersIn: Number(before.ordersIn) || 0
  });
  await patchDoc('shopifyLinks/' + who.cid, { domain, at: nowIso() });
  return { ok: true, shopName: s.name, currency: s.currency, webhooks: hooks };
}

async function disconnect(event, who) {
  if (!who.owner) throw new Error('Only the owner can disconnect the online shop');
  const cfg = await secretsOf(who.cid);
  if (cfg && cfg.clientSecret) await shopify.removeWebhooks(cfg, hookUrl(event, who.cid)).catch(() => {});
  await deleteDoc(`companies/${who.cid}/secrets/shopify`);
  await deleteDoc('shopifyLinks/' + who.cid);
  await patchDoc(statusPath(who.cid), { connected: false, disconnectedAt: nowIso(), webhooks: '' });
  return { ok: true };
}

// The shop's products into the price list: linked by Shopify variant, or
// matched by exact name the first time. Prices (and counts, where Shopify
// keeps them) come from the shop; recipes and costs are never touched.
async function products(who) {
  if (!who.owner) throw new Error('Only the owner can bring products in');
  const cfg = await secretsOf(who.cid);
  if (!cfg) throw new Error('Connect the shop first');
  const st = (await getDoc(statusPath(who.cid))) || {};
  const { vatRate } = await vatOf(who.cid);
  const rows = await shopify.listProducts(cfg);
  const parent = 'companies/' + who.cid;
  const mine = await query(parent, 'products', {}, 5000);
  const byVariant = Object.fromEntries(mine.filter(p => p.shopifyVariantId).map(p => [String(p.shopifyVariantId), p]));
  const byName = {};
  mine.filter(p => !p.shopifyVariantId).forEach(p => { byName[String(p.name || '').trim().toLowerCase()] = p; });
  const writes = [];
  let created = 0, updated = 0, linked = 0;
  for (const v of rows) {
    const d = mapProduct(v, { taxesIncluded: st.taxesIncluded, vatRate });
    const hit = byVariant[v.shopifyVariantId] || byName[String(v.title).trim().toLowerCase()];
    const stamp = { updatedAt: nowIso(), updatedBy: 'Shopify' };
    if (hit) {
      if (!hit.shopifyVariantId) { linked++; delete byName[String(v.title).trim().toLowerCase()]; } else updated++;
      const { name, category, ...keep } = d;                // keep the factory's own name and category
      writes.push({ path: `${parent}/products/${hit.id}`, data: { ...keep, ...(hit.category ? {} : { category }), ...stamp } });
    } else {
      created++;
      const id = 'shopify-' + v.shopifyVariantId;
      writes.push({ path: `${parent}/products/${id}`, data: { labourHours: 0, materials: [], notes: 'From the online shop' + (v.sku ? ' (SKU ' + v.sku + ')' : ''), stock: 0, ...d, source: 'shopify', createdAt: nowIso(), createdBy: 'Shopify', ...stamp } });
    }
  }
  await commitWrites(writes);
  await patchDoc(statusPath(who.cid), { productsAt: nowIso(), productsCount: rows.length });
  return { ok: true, total: rows.length, created, updated, linked };
}

// A till sale took pieces off the shelf: take the same off Shopify, once.
async function pushSale(who, body) {
  const saleId = String(body.saleId || '');
  if (!CID.test(saleId)) throw new Error('Which sale?');
  const st = await getDoc(statusPath(who.cid));
  if (!st || !st.connected) return { ok: true, skipped: 'not connected' };
  if (!companyActive(who.company)) return { ok: true, skipped: 'subscription not active' };
  const sale = await getDoc(`companies/${who.cid}/sales/${saleId}`);
  if (!sale) throw new Error('Sale not found');
  if (!await createDoc(`companies/${who.cid}/shopifyPushes/${saleId}`, { at: nowIso(), by: who.member.name || '' })) return { ok: true, already: true };
  const cfg = await secretsOf(who.cid);
  const done = [], failed = [];
  for (const l of sale.lines || []) {
    if (l.kind !== 'stock' || !l.productId || !(Number(l.qty) > 0)) continue;
    const p = await getDoc(`companies/${who.cid}/products/${l.productId}`);
    if (!p || !p.shopifyInventoryItemId) continue;
    try { await shopify.adjustStock(cfg, p.shopifyInventoryItemId, -Number(l.qty)); done.push(p.name); }
    catch (e) { failed.push(p.name + ': ' + e.message); }
  }
  if (failed.length) await patchDoc(statusPath(who.cid), { lastError: 'Stock for ' + (sale.saleNo || 'a till sale') + ' not sent: ' + failed.join('; '), lastErrorAt: nowIso() });
  return { ok: true, adjusted: done.length, failed };
}

// --------------------------------------------------------------- entry ----

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  // ---- Shopify telling us about an order ----
  if (h['x-shopify-hmac-sha256']) {
    const cid = String((event.queryStringParameters || {}).c || '');
    if (!CID.test(cid)) return json(400, { error: 'no company' });
    try {
      const cfg = await secretsOf(cid);
      if (!cfg || !shopify.verifyWebhook(raw, h['x-shopify-hmac-sha256'], cfg.clientSecret)) return json(401, { error: 'bad signature' });
      if (!shopify.TOPICS.includes(h['x-shopify-topic'])) return json(200, { ignored: true });
      const st = await getDoc(statusPath(cid));
      const company = await getDoc('companies/' + cid);
      // a locked company's orders wait; the 15-minute check brings them in once it is paid up
      if (!st || !st.connected || !companyActive(company)) return json(200, { waiting: true });
      const r = await importOrder(cid, JSON.parse(raw.toString('utf8')), { status: st });
      return json(200, { ok: true, r });
    } catch (e) {
      console.error('factory-shopify webhook failed:', e);
      return json(500, { error: 'failed' });          // Shopify tries again later
    }
  }

  // ---- the app ----
  let body; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  let who;
  try { who = await whoIs(event); } catch (e) { return json(403, { error: e.message }); }
  try {
    switch (body.action) {
      case 'connect': return json(200, await connect(event, who, body));
      case 'disconnect': return json(200, await disconnect(event, who));
      case 'settings':
        if (!who.owner) return json(403, { error: 'Only the owner can change this' });
        await patchDoc(statusPath(who.cid), { importWhen: body.importWhen === 'placed' ? 'placed' : 'paid' });
        return json(200, { ok: true });
      case 'products': return json(200, await products(who));
      case 'sync':
        if (!who.owner) return json(403, { error: 'Only the owner can do this' });
        return json(200, await syncCompany(who.cid));
      case 'pushSale': return json(200, await pushSale(who, body));
      default: return json(400, { error: 'Unknown action' });
    }
  } catch (e) {
    console.error('factory-shopify ' + body.action + ' failed:', e);
    return json(400, { error: e.message || 'Something went wrong' });
  }
};

// for the tests
export { connect, disconnect, products, pushSale };
