// Shopify Admin API helpers (one store per business).
//
// Dev-Dashboard apps no longer issue static shpat_ tokens, so auth uses the
// client-credentials grant (app Client ID + Client secret → short-lived token,
// cached in-process). Env vars (per business, suffix _<BIZ>):
//   SHOPIFY_STORE_DOMAIN[_<BIZ>]    e.g. repticube.myshopify.com
//   SHOPIFY_CLIENT_ID[_<BIZ>]       Dev Dashboard app Client ID
//   SHOPIFY_CLIENT_SECRET[_<BIZ>]   Dev Dashboard app Client secret
//   SHOPIFY_ADMIN_TOKEN[_<BIZ>]     optional legacy static token (used if present)
//   SHOPIFY_LOCATION_ID[_<BIZ>]     optional; defaults to the store's primary location
const API_VERSION = '2024-10';
export const BIZ_KEYS = ['bellville', 'pinkfoot', 'repticube'];

export function shopConfig(biz) {
  const up = String(biz || '').toUpperCase();
  const pick = (n) => process.env[`${n}_${up}`] || process.env[n] || '';
  return {
    domain: pick('SHOPIFY_STORE_DOMAIN'),
    token: pick('SHOPIFY_ADMIN_TOKEN'),        // legacy static token (optional)
    clientId: pick('SHOPIFY_CLIENT_ID'),
    clientSecret: pick('SHOPIFY_CLIENT_SECRET'),
    location: pick('SHOPIFY_LOCATION_ID')
  };
}

// Resolve an Admin API token: a static token if configured, otherwise mint one
// via the client-credentials grant and cache it until shortly before it expires.
const shopTokenCache = {};
async function shopAccessToken(biz) {
  const cfg = shopConfig(biz);
  if (cfg.token) return cfg.token; // legacy static token
  if (!cfg.domain || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(`Shopify not configured for "${biz}" (need SHOPIFY_STORE_DOMAIN + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)`);
  }
  const cached = shopTokenCache[biz];
  if (cached && Date.now() < cached.exp - 60000) return cached.token;
  const res = await fetch(`https://${cfg.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials' })
  });
  if (!res.ok) throw new Error(`Shopify token grant failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  shopTokenCache[biz] = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return shopTokenCache[biz].token;
}

async function shopFetch(biz, path, { method = 'GET', body } = {}) {
  const { domain } = shopConfig(biz);
  if (!domain) throw new Error(`SHOPIFY_STORE_DOMAIN not set for "${biz}"`);
  const token = await shopAccessToken(biz);
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(`Shopify ${method} ${path} (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

let locationCache = {};
export async function primaryLocationId(biz) {
  const cfg = shopConfig(biz);
  if (cfg.location) return String(cfg.location);
  if (locationCache[biz]) return locationCache[biz];
  const data = await shopFetch(biz, '/locations.json');
  const loc = (data.locations || []).find((l) => l.active) || (data.locations || [])[0];
  if (!loc) throw new Error(`No Shopify location for "${biz}"`);
  locationCache[biz] = String(loc.id);
  return locationCache[biz];
}

function mapProductIds(prod) {
  const v = (prod.variants && prod.variants[0]) || {};
  return {
    shopifyProductId: String(prod.id),
    shopifyVariantId: String(v.id || ''),
    shopifyInventoryItemId: String(v.inventory_item_id || '')
  };
}

// Create or update a Shopify product from a POS catalogue item.
export async function upsertProduct(biz, p) {
  const variant = { price: String(p.price ?? 0), sku: p.customSku || '', inventory_management: 'shopify' };
  if (p.shopifyProductId) {
    const body = { product: { id: Number(p.shopifyProductId), title: p.description || 'Item',
      variants: [{ ...(p.shopifyVariantId ? { id: Number(p.shopifyVariantId) } : {}), ...variant }] } };
    const out = await shopFetch(biz, `/products/${p.shopifyProductId}.json`, { method: 'PUT', body });
    return mapProductIds(out.product);
  }
  const body = { product: { title: p.description || 'Item', status: 'active', variants: [variant] } };
  const out = await shopFetch(biz, '/products.json', { method: 'POST', body });
  return mapProductIds(out.product);
}

// Set the absolute available quantity at the store's location.
export async function setInventory(biz, inventoryItemId, qoh) {
  const location_id = Number(await primaryLocationId(biz));
  const body = { location_id, inventory_item_id: Number(inventoryItemId), available: Number(qoh) || 0 };
  try {
    await shopFetch(biz, '/inventory_levels/set.json', { method: 'POST', body });
  } catch (e) {
    // Inventory item may not be stocked at this location yet — connect then retry.
    await shopFetch(biz, '/inventory_levels/connect.json', {
      method: 'POST', body: { location_id, inventory_item_id: Number(inventoryItemId) }
    }).catch(() => {});
    await shopFetch(biz, '/inventory_levels/set.json', { method: 'POST', body });
  }
}

// Pull every product (one entry per variant) for an initial catalogue import.
// Paginates via the Link header. Returns normalised rows the POS can ingest.
export async function listAllProducts(biz) {
  const { domain } = shopConfig(biz);
  if (!domain) throw new Error(`SHOPIFY_STORE_DOMAIN not set for "${biz}"`);
  const token = await shopAccessToken(biz);
  const out = [];
  // Active products only — drafts/archived shouldn't land on the till.
  let url = `https://${domain}/admin/api/${API_VERSION}/products.json?limit=250&status=active`;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Shopify list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    for (const p of data.products || []) {
      const variants = p.variants || [];
      const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '';
      for (const v of variants) {
        const named = variants.length > 1 && v.title && v.title !== 'Default Title';
        out.push({
          shopifyProductId: String(p.id),
          shopifyVariantId: String(v.id),
          shopifyInventoryItemId: String(v.inventory_item_id || ''),
          title: named ? `${p.title} — ${v.title}` : p.title,
          sku: v.sku || '',
          price: Number(v.price) || 0,
          qoh: Number(v.inventory_quantity) || 0,
          category: p.product_type || '',
          imageUrl: image
        });
      }
    }
    const link = res.headers.get('link') || res.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}
