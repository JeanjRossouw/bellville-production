// ReptiCube POS — Shopify proxy (Netlify Function).
//
// The browser NEVER holds Shopify credentials; it calls this function, which
// adds auth and calls Shopify. Single store (ReptiCube). Shopify is the source
// of truth for products + stock.
//
// Env (un-suffixed preferred; _REPTICUBE accepted as fallback so it also works
// if deployed on the existing multi-store site):
//   SHOPIFY_DOMAIN            e.g. repticube.myshopify.com   (or SHOPIFY_STORE_DOMAIN[_REPTICUBE])
//   SHOPIFY_TOKEN             static Admin API token (shpat_…)  — if you have one
//   …or client-credentials (Dev Dashboard apps):
//   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET  (or *_REPTICUBE)
//
// Phase 1 action: "getProducts". (Phase 2 will add "createOrder".)
const API_VERSION = '2024-10';

function env(...names) {
  for (const n of names) { if (process.env[n]) return process.env[n]; }
  return '';
}
function cfg() {
  return {
    domain: env('SHOPIFY_DOMAIN', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_STORE_DOMAIN_REPTICUBE'),
    token: env('SHOPIFY_TOKEN', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_ADMIN_TOKEN_REPTICUBE'),
    clientId: env('SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_ID_REPTICUBE'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET', 'SHOPIFY_CLIENT_SECRET_REPTICUBE')
  };
}

let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  const c = cfg();
  if (!c.domain) throw new Error('SHOPIFY_DOMAIN not set');
  if (c.token) return c.token; // static token
  if (!c.clientId || !c.clientSecret) throw new Error('Set SHOPIFY_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch(`https://${c.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' })
  });
  if (!res.ok) throw new Error(`Shopify token grant failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return tokenCache.token;
}

async function shopify(path, { method = 'GET', body } = {}) {
  const c = cfg();
  const token = await accessToken();
  const res = await fetch(`https://${c.domain}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) { const e = new Error(`Shopify ${method} ${path} (${res.status}): ${text.slice(0, 300)}`); e.status = res.status; throw e; }
  return { json, headers: res.headers };
}

async function primaryLocationId() {
  const { json } = await shopify('/locations.json');
  const loc = (json.locations || []).find(l => l.active) || (json.locations || [])[0];
  return loc ? String(loc.id) : null;
}

// All active products → one flat row per variant (incl. barcode for scanning).
async function getProducts() {
  const out = [];
  let url = `/products.json?limit=250&status=active`;
  while (url) {
    const { json, headers } = await shopify(url);
    for (const p of json.products || []) {
      const variants = p.variants || [];
      const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '';
      for (const v of variants) {
        const named = variants.length > 1 && v.title && v.title !== 'Default Title';
        out.push({
          productId: String(p.id),
          variantId: String(v.id),
          inventoryItemId: String(v.inventory_item_id || ''),
          name: named ? `${p.title} — ${v.title}` : p.title,
          sku: v.sku || '',
          barcode: v.barcode || '',
          price: Number(v.price) || 0,
          qty: Number(v.inventory_quantity) || 0,
          category: p.product_type || '',
          imageUrl: image
        });
      }
    }
    // Pagination via Link header
    const link = (headers.get('link') || headers.get('Link') || '');
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1].replace(/^https?:\/\/[^/]+\/admin\/api\/[^/]+/, '') : null;
  }
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  let action;
  try { ({ action } = JSON.parse(event.body || '{}')); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  try {
    if (action === 'getProducts') {
      const [products, locationId] = await Promise.all([getProducts(), primaryLocationId()]);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products, locationId }) };
    }
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Unknown action "${action}"` }) };
  } catch (e) {
    return { statusCode: e.status === 401 ? 401 : 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};
