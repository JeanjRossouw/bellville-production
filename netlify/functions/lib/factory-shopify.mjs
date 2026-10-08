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

const tokens = {};
async function token(cfg) {
  const key = cfg.domain + '|' + cfg.clientId;
  const c = tokens[key];
  if (c && Date.now() < c.exp - 60000) return c.token;
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
async function api(cfg, pathOrUrl, { method = 'GET', body } = {}) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `https://${cfg.domain}/admin/api/${API_VERSION}${pathOrUrl}`;
  const res = await fetch(url, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'X-Shopify-Access-Token': await token(cfg), 'Content-Type': 'application/json', Accept: 'application/json' }
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

export async function shop(cfg) {
  const { json } = await api(cfg, '/shop.json');
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
      for (const v of variants) {
        const named = variants.length > 1 && v.title && v.title !== 'Default Title';
        out.push({
          shopifyProductId: String(p.id), shopifyVariantId: String(v.id), shopifyInventoryItemId: String(v.inventory_item_id || ''),
          title: named ? `${p.title} — ${v.title}` : p.title, sku: v.sku || '', price: Number(v.price) || 0,
          tracked: v.inventory_management === 'shopify', qoh: Number(v.inventory_quantity) || 0, category: p.product_type || ''
        });
      }
    }
    url = next;
  }
  return out;
}

// Orders changed since a moment (new, paid, edited), oldest first.
export async function listOrders(cfg, sinceIso) {
  const out = [];
  let url = '/orders.json?status=any&limit=250&order=updated_at+asc&updated_at_min=' + encodeURIComponent(sinceIso);
  while (url) {
    const { json, next } = await api(cfg, url);
    out.push(...(json.orders || []));
    url = next;
  }
  return out;
}

// Take (or add) stock on Shopify by a number of pieces, never by setting a
// total, so a sale online at the same moment is never written over.
export async function adjustStock(cfg, inventoryItemId, delta) {
  const location_id = Number(await locationId(cfg));
  await api(cfg, '/inventory_levels/adjust.json', { method: 'POST', body: { location_id, inventory_item_id: Number(inventoryItemId), available_adjustment: Math.round(delta) } });
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
