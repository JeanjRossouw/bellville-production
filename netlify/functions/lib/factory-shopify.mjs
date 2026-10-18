// Shopify Admin API for the factory app, one store per company. Unlike
// lib/shopify.mjs (our own businesses, set up in environment variables),
// each company connects its own store from Settings, so the store and its
// app keys are passed in: { domain, clientId, clientSecret }.
//
// The company makes a custom app for its store in Shopify's Dev Dashboard;
// we trade its Client ID and secret for a short-lived token (the
// client-credentials grant) and keep that in memory only.
import crypto from 'node:crypto';

const API_VERSION = '2024-10';
export const TOPICS = ['orders/create', 'orders/paid'];

// "https://admin.shopify.com/store/oak-iron", "oak-iron.myshopify.com/",
// "oak-iron" → "oak-iron.myshopify.com". '' when it cannot be a store.
export function normaliseDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  const admin = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(s);
  if (admin) s = admin[1];
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) s += '.myshopify.com';
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : '';
}

// Tokens are cached per store, app AND secret, so a token is only ever handed
// to a caller who holds the right secret. `fresh` skips the cache altogether:
// connecting must prove the secret to Shopify itself.
const tokens = {};
async function token(cfg, fresh) {
  const key = cfg.domain + '|' + cfg.clientId + '|' + crypto.createHash('sha256').update(String(cfg.clientSecret || '')).digest('hex');
  const c = tokens[key];
  if (!fresh && c && Date.now() < c.exp - 60000) return c.token;
  const res = await fetch(`https://${cfg.domain}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials' })
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 200);
    throw new Error(res.status === 404 ? 'No Shopify store at ' + cfg.domain
      : res.status === 400 || res.status === 401 ? 'Shopify did not accept the Client ID and secret. Check both, and that the app is installed on this store.'
      : `Shopify would not let us in (${res.status}): ${t}`);
  }
  const j = await res.json();
  tokens[key] = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return j.access_token;
}

// One call. Returns { json, next } where next is the following page's URL.
async function api(cfg, pathOrUrl, { method = 'GET', body, fresh } = {}) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `https://${cfg.domain}/admin/api/${API_VERSION}${pathOrUrl}`;
  const res = await fetch(url, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'X-Shopify-Access-Token': await token(cfg, fresh), 'Content-Type': 'application/json', Accept: 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(res.status === 403
      ? 'The Shopify app is missing a permission for this (' + method + ' ' + pathOrUrl.split('?')[0].replace(/^https:\/\/[^/]+/, '') + '). See the setup steps for the list.'
      : `Shopify ${method} ${pathOrUrl.split('?')[0]} (${res.status}): ${text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
  return { json: text ? JSON.parse(text) : null, next: m ? m[1] : null };
}

// The shop's details. With `fresh`, the keys are proven to Shopify first.
export async function shop(cfg, fresh) {
  const { json } = await api(cfg, '/shop.json', { fresh });
  const s = json.shop || {};
  return { name: s.name || '', currency: s.currency || '', taxesIncluded: !!s.taxes_included, email: s.email || '', primaryLocationId: s.primary_location_id ? String(s.primary_location_id) : '' };
}

export async function locationId(cfg) {
  if (cfg.locationId) return String(cfg.locationId);
  const { json } = await api(cfg, '/locations.json');
  const loc = (json.locations || []).find(l => l.active) || (json.locations || [])[0];
  if (!loc) throw new Error('The Shopify store has no location to hold stock');
  return String(loc.id);
}

// Every active product, one row per variant.
export async function listProducts(cfg) {
  const out = [];
  let url = '/products.json?limit=250&status=active';
  while (url) {
    const { json, next } = await api(cfg, url);
    for (const p of json.products || []) {
      const variants = p.variants || [];
      const images = p.images || [];
      for (const v of variants) {
        // the variant's own picture, else the product's first
        const img = (v.image_id && images.find(i => String(i.id) === String(v.image_id))) || p.image || images[0];
        const named = variants.length > 1 && v.title && v.title !== 'Default Title';
        out.push({
          shopifyProductId: String(p.id), shopifyVariantId: String(v.id), shopifyInventoryItemId: String(v.inventory_item_id || ''),
          title: named ? `${p.title} — ${v.title}` : p.title, sku: v.sku || '', barcode: v.barcode || '', price: Number(v.price) || 0,
          tracked: v.inventory_management === 'shopify', qoh: Number(v.inventory_quantity) || 0, category: p.product_type || '', vendor: p.vendor || '', image: (img && img.src) || ''
        });
      }
    }
    url = next;
  }
  return out;
}

// Each product's collections, so the till can show the same categories as the
// online shop (a product can sit in several). Best-effort: the till falls back
// to the product type when this cannot be read.
export async function listCollections(cfg) {
  const out = {};
  let after = null;
  for (let page = 0; page < 40; page++) {
    const { json } = await api(cfg, '/graphql.json', { method: 'POST', body: { query: `query($after: String) { products(first: 100, after: $after, query: "status:active") {
      nodes { legacyResourceId collections(first: 15) { nodes { title } } } pageInfo { hasNextPage endCursor } } }`, variables: { after } } });
    const d = json && json.data && json.data.products;
    if (!d) break;
    (d.nodes || []).forEach(n => { out[String(n.legacyResourceId)] = (n.collections && n.collections.nodes || []).map(c => c.title).filter(Boolean); });
    if (!d.pageInfo || !d.pageInfo.hasNextPage) break;
    after = d.pageInfo.endCursor;
  }
  return out;
}

// Orders changed since a moment (new, paid, edited), oldest first. Stops
// fetching more pages at `deadline` (ms timestamp); `complete` says whether
// every page was read.
export async function listOrders(cfg, sinceIso, deadline = Infinity) {
  const orders = [];
  let url = '/orders.json?status=any&limit=250&order=updated_at+asc&updated_at_min=' + encodeURIComponent(sinceIso);
  while (url) {
    const { json, next } = await api(cfg, url);
    orders.push(...(json.orders || []));
    url = next;
    if (url && Date.now() > deadline) return { orders, complete: false };
  }
  return { orders, complete: true };
}

// The till's sale as a Shopify order: paid, already handed over (fulfilled),
// and taking its pieces off the shop's stock. Lines sell by variant at the
// price the customer paid; a line with no variant is a custom line (no stock).
// Tagged with the sale, so a retry can find an order that was made but whose
// answer never came back.
export const TILL_TAG = 'factory-manager-till';
export async function createTillOrder(cfg, { saleId, saleNo, lines, paid, onAccount, method, taxesIncluded, vatRate, vat }) {
  const order = {
    line_items: lines.map(l => l.variantId
      ? { variant_id: Number(l.variantId), quantity: l.qty, price: Number(l.price).toFixed(2) }
      : { title: String(l.title || 'Item').slice(0, 255), quantity: l.qty, price: Number(l.price).toFixed(2), requires_shipping: false }),
    financial_status: paid ? 'paid' : 'pending',
    fulfillment_status: 'fulfilled',
    inventory_behaviour: 'decrement_ignoring_policy',     // the till already sold it: never refuse a paid sale
    source_name: 'factory-manager',
    tags: TILL_TAG + ', fm-sale-' + saleId + (onAccount ? ', on-account' : ''),
    note: 'Till sale ' + saleNo + (method ? ' · ' + method : ''),
    send_receipt: false, send_fulfillment_receipt: false,
    taxes_included: !!taxesIncluded,
    ...(vat > 0 ? { tax_lines: [{ title: 'VAT', rate: Number(vatRate) || 0, price: Number(vat).toFixed(2) }] } : {})
  };
  const { json } = await api(cfg, '/orders.json', { method: 'POST', body: { order } });
  return { id: String(json.order.id), name: json.order.name || '' };
}
// A till order already made for this sale (the answer may have been lost).
export async function findTillOrder(cfg, saleId, sinceIso) {
  const tag = 'fm-sale-' + saleId;
  const { json } = await api(cfg, '/orders.json?status=any&limit=50&fields=id,name,tags&created_at_min=' + encodeURIComponent(sinceIso));
  const o = (json.orders || []).find(x => String(x.tags || '').split(',').map(t => t.trim()).includes(tag));
  return o ? { id: String(o.id), name: o.name || '' } : null;
}

// Take (or add) stock on Shopify by a number of pieces, never by setting a
// total, so a sale online at the same moment is never written over.
export async function adjustStock(cfg, inventoryItemId, delta) {
  const location_id = Number(await locationId(cfg));
  await api(cfg, '/inventory_levels/adjust.json', { method: 'POST', body: { location_id, inventory_item_id: Number(inventoryItemId), available_adjustment: Math.round(delta) } });
}

// Stock received at the shop: add the pieces, one line at a time, so one
// item Shopify refuses (not stocked here, tracking off, a bundle) never sinks
// the rest of the delivery: adjust → connect it to the location and try again
// → switch the variant's tracking on and try again → give up on that line.
export async function receiveLines(cfg, lines) {
  const location_id = Number(await locationId(cfg));
  const connect = (item) => api(cfg, '/inventory_levels/connect.json', { method: 'POST', body: { location_id, inventory_item_id: Number(item) } }).catch(() => {});
  const adjust = (item, qty) => api(cfg, '/inventory_levels/adjust.json', { method: 'POST', body: { location_id, inventory_item_id: Number(item), available_adjustment: Math.round(qty) } });
  const received = [], failed = [];
  for (const l of lines) {
    try {
      try { await adjust(l.inventoryItemId, l.qty); }
      catch (e1) {
        await connect(l.inventoryItemId);
        try { await adjust(l.inventoryItemId, l.qty); }
        catch (e2) {
          if (!l.variantId) throw e2;
          await api(cfg, `/variants/${Number(l.variantId)}.json`, { method: 'PUT', body: { variant: { id: Number(l.variantId), inventory_management: 'shopify' } } });
          await connect(l.inventoryItemId);
          await adjust(l.inventoryItemId, l.qty);
        }
      }
      received.push({ inventoryItemId: String(l.inventoryItemId), qty: Math.round(l.qty) });
    } catch (e) { failed.push({ inventoryItemId: String(l.inventoryItemId), name: l.name || '', error: String(e.message || e).replace(/^Shopify \w+ \S+ /, '').slice(0, 200) }); }
  }
  return { received, failed };
}
// A stock take: the counted number becomes the shop's count (setting a total
// is its own safeguard: doing it twice changes nothing).
export async function setLevels(cfg, lines) {
  const location_id = Number(await locationId(cfg));
  const done = [], failed = [];
  for (const l of lines) {
    const body = { location_id, inventory_item_id: Number(l.inventoryItemId), available: Math.max(0, Math.round(Number(l.counted) || 0)) };
    try {
      try { await api(cfg, '/inventory_levels/set.json', { method: 'POST', body }); }
      catch (e) {
        await api(cfg, '/inventory_levels/connect.json', { method: 'POST', body: { location_id, inventory_item_id: body.inventory_item_id } }).catch(() => {});
        await api(cfg, '/inventory_levels/set.json', { method: 'POST', body });
      }
      done.push(String(l.inventoryItemId));
    } catch (e) { failed.push({ inventoryItemId: String(l.inventoryItemId), name: l.name || '', error: String(e.message || e).slice(0, 160) }); }
  }
  return { done, failed };
}

// An order the till made as unpaid (sold on account) is paid now: a sale
// transaction for the amount, unless the shop already shows it paid.
export async function markOrderPaid(cfg, orderId, amount, currency) {
  const { json } = await api(cfg, `/orders/${Number(orderId)}.json?fields=id,financial_status,currency,total_price`);
  const o = json.order || {};
  if (o.financial_status === 'paid') return { already: true };
  await api(cfg, `/orders/${Number(orderId)}/transactions.json`, { method: 'POST', body: { transaction: { kind: 'sale', source: 'external', gateway: 'manual', amount: Number(amount || o.total_price || 0).toFixed(2), currency: currency || o.currency || 'ZAR' } } });
  return { paid: true };
}

// Ask Shopify to tell us about new and paid orders at `address`.
export async function addWebhooks(cfg, address) {
  const { json } = await api(cfg, '/webhooks.json?limit=250');
  const have = json.webhooks || [];
  for (const topic of TOPICS) {
    if (have.some(w => w.topic === topic && w.address === address)) continue;
    await api(cfg, '/webhooks.json', { method: 'POST', body: { webhook: { topic, address, format: 'json' } } });
  }
}
export async function removeWebhooks(cfg, addressPrefix) {
  const { json } = await api(cfg, '/webhooks.json?limit=250');
  for (const w of json.webhooks || []) {
    if (String(w.address || '').startsWith(addressPrefix)) await api(cfg, `/webhooks/${w.id}.json`, { method: 'DELETE' }).catch(() => {});
  }
}

// Is this really Shopify? The notice is signed with the app's secret.
export function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(String(hmacHeader), 'base64'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
