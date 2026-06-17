// Inbound Shopify webhook: an online order decrements MASTER stock in Firestore
// (the POS is the master; this keeps online + in-store from overselling).
//
//   Register in each store for topic "orders/create", format JSON, URL:
//     https://<site>/.netlify/functions/shopify-webhook?biz=bellville
//
// Verifies the Shopify HMAC. Idempotent per order id (Netlify Blobs). Only
// touches stock — it never pushes back to Shopify (Shopify already decremented
// its own inventory for the order), avoiding a sync loop.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { readDoc, writeDoc } from './lib/firestore.mjs';

const BIZ_KEYS = ['bellville', 'pinkfoot', 'repticube'];

function verifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error('SHOPIFY_WEBHOOK_SECRET is not set');
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Decrement an item's master quantity-on-hand in place (skips made-to-order).
function decrementItem(item, qty) {
  if (item.isSpecialOrder) return;
  const shop = item.ItemShops && item.ItemShops.ItemShop && item.ItemShops.ItemShop[0];
  if (!shop) return;
  shop.qoh = Math.max(0, (Number(shop.qoh) || 0) - qty);
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  const biz = event.queryStringParameters?.biz;
  if (!BIZ_KEYS.includes(biz)) return { statusCode: 400, body: 'Unknown business' };

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  const hmac = event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'];

  try {
    if (!verifyHmac(raw, hmac)) return { statusCode: 401, body: 'Bad HMAC' };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }

  let order;
  try { order = JSON.parse(raw.toString('utf8')); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  // Idempotency — Shopify may deliver the same order more than once.
  const orderKey = `${biz}:${order.id}`;
  const seen = getStore('shopify-orders');
  if (await seen.get(orderKey)) return { statusCode: 200, body: 'Already processed' };

  const lines = order.line_items || [];
  if (lines.length === 0) {
    await seen.set(orderKey, '1');
    return { statusCode: 200, body: 'No line items' };
  }

  try {
    const posBiz = await readDoc('pos-' + biz);   // { catalog, sales }
    const cat = (posBiz && posBiz.catalog) || [];
    let changed = 0;
    for (const li of lines) {
      const variantId = li.variant_id != null ? String(li.variant_id) : '';
      const sku = li.sku || '';
      const qty = Number(li.quantity) || 0;
      if (qty <= 0) continue;
      const item = cat.find((p) =>
        (variantId && String(p.shopifyVariantId || '') === variantId) ||
        (sku && (p.customSku || '') === sku));
      if (item) { decrementItem(item, qty); changed++; }
    }
    if (changed > 0) await writeDoc('pos-' + biz, posBiz, `shopify-order:${biz}:${order.id}`);
    await seen.set(orderKey, '1');
    return { statusCode: 200, body: `OK (${changed} item(s) adjusted)` };
  } catch (e) {
    // Don't mark as seen — let Shopify retry.
    return { statusCode: 500, body: 'Stock update failed: ' + e.message };
  }
};
