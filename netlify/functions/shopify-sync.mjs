// Push POS catalogue + stock to a business's Shopify store (POS is the master).
//
//   POST /.netlify/functions/shopify-sync   (Authorization: Bearer <firebase id token>)
//   body:
//     { biz, action: "product",   product: { _localId, description, customSku, price, qoh,
//                                             shopifyProductId?, shopifyVariantId? } }
//       → upsert the product AND set its inventory; returns the Shopify ids.
//     { biz, action: "inventory", items: [{ shopifyInventoryItemId, qoh }] }
//       → set inventory levels only (used after an in-store sale).
import { upsertProduct, setInventory, BIZ_KEYS } from './lib/shopify.mjs';
import { requireUser } from './lib/auth.mjs';

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try { await requireUser(event); } catch (e) { return json(401, { error: 'Unauthorized: ' + e.message }); }

  let biz, action, product, items;
  try { ({ biz, action, product, items } = JSON.parse(event.body || '{}')); }
  catch { return json(400, { error: 'Invalid JSON body' }); }
  if (!BIZ_KEYS.includes(biz)) return json(400, { error: `Unknown business "${biz}"` });

  try {
    if (action === 'product') {
      if (!product) return json(400, { error: 'Missing product' });
      const ids = await upsertProduct(biz, product);
      if (ids.shopifyInventoryItemId) {
        await setInventory(biz, ids.shopifyInventoryItemId, product.qoh);
      }
      return json(200, ids);
    }

    if (action === 'inventory') {
      const list = Array.isArray(items) ? items.filter((i) => i.shopifyInventoryItemId) : [];
      const results = [];
      for (const i of list) {
        try { await setInventory(biz, i.shopifyInventoryItemId, i.qoh); results.push({ id: i.shopifyInventoryItemId, ok: true }); }
        catch (e) { results.push({ id: i.shopifyInventoryItemId, ok: false, error: e.message }); }
      }
      return json(200, { results });
    }

    return json(400, { error: `Unknown action "${action}"` });
  } catch (e) {
    return json(e.status === 401 ? 401 : 502, { error: e.message });
  }
};
