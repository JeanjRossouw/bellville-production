// Shopify for the factory app: each company connects its own online shop.
//
//   POST { action:'connect', domain, clientId, clientSecret, importWhen }   owner
//   POST { action:'disconnect' }                                             owner
//   POST { action:'settings', importWhen }                                   owner
//   POST { action:'products' }   bring the shop's products in                owner
//   POST { action:'sync' }       bring new online orders in now              owner
//   POST { action:'pushSale', saleId }   a till sale took stock: tell Shopify  any member
//                                        (a sale from the shop's stock becomes a Shopify order)
//   POST { action:'catalogue' }          the shop's products and stock, for the till  any member
//   POST { action:'receive', grvId }     a delivery (grvs/<id>) onto the shop's stock, once
//   POST { action:'setStock', takeId }   a stock take (stockTakes/<id>): counts become the shop's count
//   POST { action:'markPaid', saleId }   an account sale settled: its Shopify order is paid now
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
  getDoc, patchDoc, createDoc, createWith, deleteDoc, query, commitWrites, nextNumber, companyActive, projectId
} from './lib/factory-firestore.mjs';
import * as shopify from './lib/factory-shopify.mjs';
import { wantOrder, isPaid, orderLines, orderDocId, customerOf, findCustomer, mapLine, mapProduct } from '../../couchpotato/js/shopify-map.js';

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
// per line. The webhook and the 15-minute check can both see the same order,
// often at the same moment (orders/create and orders/paid arrive together),
// so the order is claimed first: only the run that claims it takes order
// numbers. A claim left unfinished (the run was cut off) is taken over after
// a few minutes, and lines already made are not made again.
const CLAIM_STALE_MS = 3 * 60000;
export class Busy extends Error {}

export async function importOrder(cid, o, ctx) {
  const st = ctx.status || {};
  const parent = 'companies/' + cid;
  const marker = `${parent}/shopifyOrders/${o.id}`;
  const paidNow = isPaid(o);
  const wanted = wantOrder(o, st.importWhen);
  if (!wanted && !paidNow) return null;               // nothing to do, and nothing to read

  let seen = await getDoc(marker);
  if (seen && seen.done) {
    // brought in before it was paid ("as soon as placed"): note the payment, dated today
    if (paidNow && !seen.paid) {
      const day = nowIso().slice(0, 10);
      for (const id of seen.orderIds || []) {
        await patchDoc(`${parent}/orders/${id}`, { paidDate: day, updatedAt: nowIso(), updatedBy: 'Shopify' }).catch(() => {});
      }
      await patchDoc(marker, { paid: true, paidAt: nowIso() });
      return { order: o.name, paidLater: true };
    }
    return null;
  }
  if (!wanted) return null;
  if (seen && Date.now() - Date.parse(seen.claimedAt || 0) < CLAIM_STALE_MS) {
    // another run is bringing it in right now; if this one knows it is paid, try again shortly
    if (paidNow && !seen.paid) throw new Busy('order ' + (o.name || o.id) + ' is being brought in');
    return null;
  }
  const claim = { name: o.name || '', claimedAt: nowIso(), paid: paidNow, done: false };
  if (seen) await patchDoc(marker, claim);                 // take over a stale claim
  else if (!await createDoc(marker, claim)) return null;   // someone else claimed it first

  const { settings, vatRate } = ctx.vat || await vatOf(cid);

  // the customer: the same email or cell number, however it was typed, or a new one
  const c = customerOf(o);
  const customer = findCustomer(ctx.customers || await query(parent, 'customers', {}, 5000), c);
  let customerId = customer ? customer.id : '';
  if (!customerId) {
    customerId = 'shopify-c-' + (o.customer && o.customer.id ? o.customer.id : o.id);
    await createDoc(`${parent}/customers/${customerId}`, { ...c, notes: 'Added from online order ' + (o.name || ''), source: 'shopify',
      createdAt: nowIso(), createdBy: 'Shopify', updatedAt: nowIso(), updatedBy: 'Shopify' });
    if (ctx.customers) ctx.customers.push({ id: customerId, ...c });
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
    // the order and, from the shelf, the stock it takes: together or not at all
    // (Shopify already took it off its own count)
    if (await createWith(`${parent}/orders/${id}`, doc, fromStock ? [{ path: `${parent}/products/${product.id}`, inc: { stock: -qty } }] : [])) made.push({ id, orderNo: doc.orderNo });
    else made.push({ id });
  }
  await patchDoc(marker, { done: true, at: nowIso(), orderIds: made.map(m => m.id), customerId, paid: paidNow });
  const fresh = made.filter(m => m.orderNo);
  if (fresh.length) {
    await commitWrites([{ path: statusPath(cid), data: { lastOrderAt: nowIso(), lastOrderName: o.name || '' } }, { path: statusPath(cid), inc: { ordersIn: 1 } }]);
  }
  return { order: o.name, orders: fresh.map(m => m.orderNo) };
}

// Look for orders the webhooks may have missed (or that came while the app
// was locked). Runs every 15 minutes, and from the "Check now" button.
// It always moves forward: when time runs out it saves exactly where it got
// to, and the next run carries on from there (with no look-back, so a big
// burst of edited orders is worked through, not re-read for ever). After a
// run that finished, the next one looks back 10 minutes, for orders Shopify
// was slow to list.
export async function syncCompany(cid, { budgetMs = 8000 } = {}) {
  const started = Date.now();
  const st = await getDoc(statusPath(cid));
  if (!st || !st.connected) return { cid, skipped: 'not connected' };
  const company = await getDoc('companies/' + cid);
  if (!companyActive(company)) return { cid, skipped: 'subscription not active' };
  const cfg = await secretsOf(cid);
  if (!cfg || !cfg.clientSecret) return { cid, skipped: 'no keys' };

  const from = Date.parse(st.lastCheckedAt || st.connectedAt || nowIso());
  const since = new Date(from - (st.resumeFrom ? 0 : 10 * 60000)).toISOString();
  const connectedAt = Date.parse(st.connectedAt || 0) || 0;
  const ctx = { status: st, vat: await vatOf(cid), customers: await query('companies/' + cid, 'customers', {}, 5000) };
  let list;
  try { list = await shopify.listOrders(cfg, since, started + budgetMs / 2); }
  catch (e) { await patchDoc(statusPath(cid), { lastError: e.message, lastErrorAt: nowIso() }); throw e; }
  const { orders } = list;
  const done = [];
  let cut = !list.complete, upTo = null;
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (Date.now() - started > budgetMs && i > 0) { cut = true; upTo = orders[i].updated_at; break; }
    upTo = o.updated_at;
    if (Date.parse(o.created_at) < connectedAt) continue;                     // from before the shop was connected
    try { const r = await importOrder(cid, o, ctx); if (r) done.push(r); }
    catch (e) { if (!(e instanceof Busy)) throw e; cut = true; upTo = o.updated_at; break; }   // being brought in now: come back to it
  }
  await patchDoc(statusPath(cid), cut && upTo
    ? { lastCheckedAt: upTo, resumeFrom: true, lastError: '' }
    : { lastCheckedAt: new Date(started).toISOString(), resumeFrom: false, lastError: '' });
  return { cid, looked: orders.length, brought: done, more: cut };
}

// ------------------------------------------------------------- actions ----

async function connect(event, who, body) {
  if (!who.owner) throw new Error('Only the owner can connect the online shop');
  const domain = shopify.normaliseDomain(body.domain);
  if (!domain) throw new Error('That does not look like a Shopify store. Use the address that ends in .myshopify.com');
  const cfg = { domain, clientId: String(body.clientId || '').trim(), clientSecret: String(body.clientSecret || '').trim() };
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Paste both the Client ID and the Client secret');
  const s = await shopify.shop(cfg, true);               // proves these keys to Shopify, never a cached token
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

// The shop's products and stock, live, for the till: every active variant
// with its price as the customer pays it (incl. VAT), barcode and count.
async function catalogue(who) {
  const st = await getDoc(statusPath(who.cid));
  if (!st || !st.connected) return { connected: false, items: [] };
  const cfg = await secretsOf(who.cid);
  const { vatRate } = await vatOf(who.cid);
  const rows = await shopify.listProducts(cfg);
  let colls = {};
  try { colls = await shopify.listCollections(cfg); } catch (e) { console.warn('collections not read for ' + who.cid + ': ' + e.message); }
  const items = rows.map(v => ({
    variantId: v.shopifyVariantId, inventoryItemId: v.shopifyInventoryItemId, productId: v.shopifyProductId,
    name: v.title, sku: v.sku, barcode: v.barcode, price: mapProduct(v, { taxesIncluded: st.taxesIncluded, vatRate }).sellingPrice,
    tracked: !!v.tracked, qty: Math.round(Number(v.qoh) || 0), category: v.category, collections: colls[v.shopifyProductId] || [], vendor: v.vendor || '', image: v.image
  }));
  return { connected: true, shopName: st.shopName || '', at: nowIso(), items };
}

// A sale from the shop's stock becomes one Shopify order, once: paid, handed
// over, its pieces off the shop's count. Lines go at what the customer paid
// for them (after every discount); made-to-order lines are the factory's and
// stay out. The claim says a run is making it; a retry first looks for an
// order already tagged with this sale, so a lost answer never makes two.
const r2s = (n) => Math.round((Number(n) || 0) * 100) / 100;
async function tillOrder(who, sale, saleId) {
  const claimPath = `companies/${who.cid}/shopifyPushes/${saleId}`;
  let claim = await getDoc(claimPath);
  if (claim && (claim.orderId || claim.none)) return { ok: true, already: true, order: claim.orderName || '' };
  if (!claim) {
    if (!await createDoc(claimPath, { at: nowIso(), by: who.member.name || '', state: 'making' })) claim = await getDoc(claimPath);
  }
  if (claim && Date.now() - Date.parse(claim.at || 0) < 2 * 60000) throw new Error('This sale is being sent to Shopify right now');
  if (claim) await patchDoc(claimPath, { at: nowIso(), by: who.member.name || '', state: 'making' });     // take over a stale one
  const cfg = await secretsOf(who.cid);
  try {
    if (!cfg) throw new Error('The shop is not connected');
    const lines = (sale.lines || []).filter(l => l.kind === 'stock' && Number(l.qty) > 0).map(l => {
      const qty = Math.round(Number(l.qty));
      const net = l.net != null ? Number(l.net) : qty * (Number(l.unitPrice) || 0);
      return { variantId: l.variantId || '', title: l.name, qty, price: r2s(net / qty) };
    });
    if (!lines.length) { await patchDoc(claimPath, { none: true, state: 'done' }); return { ok: true, none: true }; }
    const since = new Date(Date.parse(sale.createdAt || nowIso()) - 86400000).toISOString();
    let made = await shopify.findTillOrder(cfg, saleId, since);
    if (!made) {
      const st = (await getDoc(statusPath(who.cid))) || {};
      const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
      const rate = Number(sale.subtotal) ? (Number(sale.vat) || 0) / Number(sale.subtotal) : 0;
      made = await shopify.createTillOrder(cfg, { saleId, saleNo: sale.saleNo || '', lines, paid: !(Number(sale.balance) > 0.005), onAccount: sale.kind === 'account',
        method: sale.method || '', taxesIncluded: rate > 0 || st.taxesIncluded, vatRate: rate, vat: rate ? r2s(total - total / (1 + rate)) : 0 });
    }
    await patchDoc(claimPath, { orderId: made.id, orderName: made.name, state: 'done', doneAt: nowIso() });
    await patchDoc(`companies/${who.cid}/sales/${saleId}`, { shopifyOrderId: made.id, shopifyOrderName: made.name });
    return { ok: true, order: made.name };
  } catch (e) {
    await deleteDoc(claimPath).catch(() => {});      // free it, so the till can try again
    await patchDoc(statusPath(who.cid), { lastError: 'Till sale ' + (sale.saleNo || '') + ' not sent to Shopify yet: ' + e.message, lastErrorAt: nowIso() }).catch(() => {});
    throw e;
  }
}

// A delivery booked in at the till (grvs/<id>) goes onto the shop's count,
// once: the GRV is claimed first; a retry after a lost answer sends only
// what is not marked received yet.
const INV = /^\d{1,20}$/;
async function receive(who, body) {
  const grvId = String(body.grvId || '');
  if (!CID.test(grvId)) throw new Error('Which delivery?');
  const st = await getDoc(statusPath(who.cid));
  if (!st || !st.connected) throw new Error('The shop is not connected');
  const grv = await getDoc(`companies/${who.cid}/grvs/${grvId}`);
  if (!grv) throw new Error('Delivery not found');
  const claimPath = `companies/${who.cid}/shopifyPushes/grv-${grvId}`;
  const claim = await getDoc(claimPath);
  if (claim && claim.state === 'done') return { ok: true, already: true, received: grv.received || [], failed: grv.failed || [] };
  if (claim && claim.state === 'making' && Date.now() - Date.parse(claim.at || 0) < 2 * 60000) throw new Error('This delivery is being sent to Shopify right now');
  if (!claim) await createDoc(claimPath, { at: nowIso(), by: who.member.name || '', state: 'making' });
  else await patchDoc(claimPath, { at: nowIso(), state: 'making' });
  const had = new Set((grv.received || []).map(r => r.inventoryItemId));
  const lines = (grv.lines || []).filter(l => INV.test(String(l.inventoryItemId || '')) && Number(l.qty) > 0 && !had.has(String(l.inventoryItemId)))
    .map(l => ({ inventoryItemId: String(l.inventoryItemId), variantId: INV.test(String(l.variantId || '')) ? String(l.variantId) : '', qty: Math.round(Number(l.qty)), name: l.name || '' }));
  const cfg = await secretsOf(who.cid);
  let r;
  try { r = lines.length ? await shopify.receiveLines(cfg, lines) : { received: [], failed: [] }; }
  catch (e) { await patchDoc(claimPath, { state: 'failed', error: e.message }).catch(() => {}); throw e; }
  const received = [...(grv.received || []), ...r.received], failed = r.failed;
  const done = !failed.length;
  await patchDoc(`companies/${who.cid}/grvs/${grvId}`, { received, failed, status: done ? 'received' : 'part', sentAt: nowIso() });
  await patchDoc(claimPath, { state: done ? 'done' : 'part', doneAt: nowIso() });
  return { ok: true, received: r.received, failed };
}
// A stock take's counts become the shop's count.
async function setStock(who, body) {
  const takeId = String(body.takeId || '');
  if (!CID.test(takeId)) throw new Error('Which stock take?');
  const st = await getDoc(statusPath(who.cid));
  if (!st || !st.connected) throw new Error('The shop is not connected');
  const take = await getDoc(`companies/${who.cid}/stockTakes/${takeId}`);
  if (!take) throw new Error('Stock take not found');
  const lines = (take.lines || []).filter(l => INV.test(String(l.inventoryItemId || '')) && l.counted != null && l.counted !== '')
    .map(l => ({ inventoryItemId: String(l.inventoryItemId), counted: Number(l.counted), name: l.name || '' }));
  if (!lines.length) throw new Error('Nothing counted yet');
  const cfg = await secretsOf(who.cid);
  const r = await shopify.setLevels(cfg, lines);
  await patchDoc(`companies/${who.cid}/stockTakes/${takeId}`, { status: r.failed.length ? 'part' : 'done', reconciledAt: nowIso(), reconciledBy: who.member.name || '', set: r.done.length, failed: r.failed });
  return { ok: true, set: r.done.length, failed: r.failed };
}

// An account sale settled at the till: the pending Shopify order is marked paid.
async function markPaid(who, body) {
  const saleId = String(body.saleId || '');
  if (!CID.test(saleId)) throw new Error('Which sale?');
  const st = await getDoc(statusPath(who.cid));
  if (!st || !st.connected) return { ok: true, skipped: 'not connected' };
  const sale = await getDoc(`companies/${who.cid}/sales/${saleId}`);
  if (!sale) throw new Error('Sale not found');
  if (!sale.shopifyOrderId) return { ok: true, skipped: 'no shop order' };
  if (Number(sale.balance) > 0.005) return { ok: true, skipped: 'still owing' };
  if (sale.shopifyPaidAt) return { ok: true, already: true };
  const cfg = await secretsOf(who.cid);
  const r = await shopify.markOrderPaid(cfg, sale.shopifyOrderId, sale.total, st.currency);
  await patchDoc(`companies/${who.cid}/sales/${saleId}`, { shopifyPaidAt: nowIso() });
  return { ok: true, ...r };
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
  if (sale.shopifySale) return tillOrder(who, sale, saleId);
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

// A return at the till put pieces back on the shelf: add them back on
// Shopify, once.
async function pushReturn(who, body) {
  const saleId = String(body.saleId || ''), returnNo = String(body.returnNo || '');
  if (!CID.test(saleId)) throw new Error('Which sale?');
  if (!/^R-\d{1,9}$/.test(returnNo)) throw new Error('Which return?');
  const st = await getDoc(statusPath(who.cid));
  if (!st || !st.connected) return { ok: true, skipped: 'not connected' };
  if (!companyActive(who.company)) return { ok: true, skipped: 'subscription not active' };
  const sale = await getDoc(`companies/${who.cid}/sales/${saleId}`);
  if (!sale) throw new Error('Sale not found');
  const ret = (sale.returns || []).find(r => r && r.returnNo === returnNo);
  if (!ret) throw new Error('Which return? ' + returnNo + ' is not on this sale');
  if (!await createDoc(`companies/${who.cid}/shopifyPushes/${saleId}--${returnNo}`, { at: nowIso(), by: who.member.name || '' })) return { ok: true, already: true };
  const cfg = await secretsOf(who.cid);
  const done = [], failed = [];
  for (const l of ret.lines || []) {
    if (!l.restock || !(Number(l.qty) > 0)) continue;
    // a line from the shop's stock carries its own inventory item; else the product's
    let item = /^\d{1,20}$/.test(String(l.inventoryItemId || '')) ? String(l.inventoryItemId) : '', name = l.name || '';
    if (!item && l.productId && CID.test(String(l.productId))) {
      const p = await getDoc(`companies/${who.cid}/products/${l.productId}`);
      if (p && p.shopifyInventoryItemId) { item = p.shopifyInventoryItemId; name = p.name; }
    }
    if (!item) continue;
    try { await shopify.adjustStock(cfg, item, Number(l.qty)); done.push(name); }
    catch (e) { failed.push(name + ': ' + e.message); }
  }
  if (failed.length) await patchDoc(statusPath(who.cid), { lastError: 'Stock for return ' + returnNo + ' not sent: ' + failed.join('; '), lastErrorAt: nowIso() });
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
  // a locked company (trial over, payment stopped) is read only here too;
  // disconnecting and the till's stock (which skips itself) are still allowed
  if (['connect', 'settings', 'products', 'sync', 'receive', 'setStock'].includes(body.action) && !companyActive(who.company)) {
    return json(403, { error: 'Your subscription is not active, so the app is read only. Subscribe under Billing to use the online shop again.' });
  }
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
      case 'pushReturn': return json(200, await pushReturn(who, body));
      case 'catalogue': return json(200, await catalogue(who));
      case 'receive': return json(200, await receive(who, body));
      case 'setStock': return json(200, await setStock(who, body));
      case 'markPaid': return json(200, await markPaid(who, body));
      default: return json(400, { error: 'Unknown action' });
    }
  } catch (e) {
    console.error('factory-shopify ' + body.action + ' failed:', e);
    return json(400, { error: e.message || 'Something went wrong' });
  }
};

// for the tests
export { connect, disconnect, products, pushSale, pushReturn, catalogue, receive, setStock, markPaid };
