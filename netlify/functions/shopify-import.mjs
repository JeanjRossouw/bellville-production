// One-time(ish) catalogue import: pull all products from a business's Shopify
// store so the POS catalogue can be seeded from an existing store. After import
// the POS is the master, as usual.
//
//   POST /.netlify/functions/shopify-import   (Authorization: Bearer <firebase id token>)
//   body: { biz }
//   → { products: [{ shopifyProductId, shopifyVariantId, shopifyInventoryItemId,
//                     title, sku, price, qoh }] }
import { listAllProducts, BIZ_KEYS } from './lib/shopify.mjs';
import { requireUser } from './lib/auth.mjs';

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try { await requireUser(event); } catch (e) { return json(401, { error: 'Unauthorized: ' + e.message }); }

  let biz;
  try { ({ biz } = JSON.parse(event.body || '{}')); }
  catch { return json(400, { error: 'Invalid JSON body' }); }
  if (!BIZ_KEYS.includes(biz)) return json(400, { error: `Unknown business "${biz}"` });

  try {
    const products = await listAllProducts(biz);
    return json(200, { products });
  } catch (e) {
    return json(e.status === 401 ? 401 : 502, { error: e.message });
  }
};
