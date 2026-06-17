// Shopify Admin API helpers (one store per business). Auth is a custom-app
// Admin API access token per store — no OAuth dance, just env vars:
//   SHOPIFY_STORE_DOMAIN[_<BIZ>]   e.g. bellville.myshopify.com
//   SHOPIFY_ADMIN_TOKEN[_<BIZ>]    Admin API access token (shpat_…)
//   SHOPIFY_LOCATION_ID[_<BIZ>]    optional; defaults to the store's primary location
const API_VERSION = '2024-10';
export const BIZ_KEYS = ['bellville', 'pinkfoot', 'repticube'];

export function shopConfig(biz) {
  const up = String(biz || '').toUpperCase();
  const pick = (n) => process.env[`${n}_${up}`] || process.env[n] || '';
  return {
    domain: pick('SHOPIFY_STORE_DOMAIN'),
    token: pick('SHOPIFY_ADMIN_TOKEN'),
    location: pick('SHOPIFY_LOCATION_ID')
  };
}

async function shopFetch(biz, path, { method = 'GET', body } = {}) {
  const { domain, token } = shopConfig(biz);
  if (!domain || !token) throw new Error(`Shopify not configured for "${biz}" (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN)`);
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
  const { domain, token } = shopConfig(biz);
  if (!domain || !token) throw new Error(`Shopify not configured for "${biz}"`);
  const out = [];
  // Active products only — drafts/archived shouldn't land on the till.
  let url = `https://${domain}/admin/api/${API_VERSION}/products.json?limit=250&status=active`;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Shopify list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    for (const p of data.products || []) {
      const variants = p.variants || [];
      for (const v of variants) {
        const named = variants.length > 1 && v.title && v.title !== 'Default Title';
        out.push({
          shopifyProductId: String(p.id),
          shopifyVariantId: String(v.id),
          shopifyInventoryItemId: String(v.inventory_item_id || ''),
          title: named ? `${p.title} — ${v.title}` : p.title,
          sku: v.sku || '',
          price: Number(v.price) || 0,
          qoh: Number(v.inventory_quantity) || 0
        });
      }
    }
    const link = res.headers.get('link') || res.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}
