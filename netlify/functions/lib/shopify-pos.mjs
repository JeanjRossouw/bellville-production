// Retail POS — the Shopify Admin GraphQL API for one entity: the secrets
// (server only), a short-lived token by the client-credentials grant, the
// GraphQL call, webhook verification, the stock queue the sale core feeds
// after every movement, and the sync log. SHOPIFY_API_BASE overrides the
// host for tests.
import crypto from 'node:crypto';
import { getDoc, query, commit, createDoc, patchDoc, addDoc, nowIso, randomId, serverStamp } from './pos.mjs';

export const API_VERSION = '2024-10';
const base = (domain) => process.env.SHOPIFY_API_BASE || ('https://' + domain);
export const gidNum = (gid) => String(gid || '').split('/').pop();

export async function secretsOf(entityId) { const s = await getDoc('shopifySecrets', entityId); return s && s.domain && s.clientId && s.clientSecret ? s : null; }
export async function settingsOf(entityId) { const s = await getDoc('settings', entityId); return (s && s.shopify) || {}; }
export async function patchShopify(entityId, patch) { const s = (await getDoc('settings', entityId)) || {}; await patchDoc('settings', entityId, { shopify: { ...(s.shopify || {}), ...patch } }); }

const tokens = {};
async function token(cfg, fresh) {
  const key = cfg.domain + '|' + cfg.clientId + '|' + crypto.createHash('sha256').update(String(cfg.clientSecret || '')).digest('hex');
  const c = tokens[key];
  if (!fresh && c && Date.now() < c.exp - 60000) return c.token;
  const res = await fetch(`${base(cfg.domain)}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials' }) });
  if (!res.ok) { const t = (await res.text()).slice(0, 200); throw new Error(res.status === 404 ? 'No Shopify store at ' + cfg.domain : res.status === 400 || res.status === 401 ? 'Shopify did not accept the Client ID and secret. Check both, and that the app is installed on this store.' : `Shopify would not let us in (${res.status}): ${t}`); }
  const j = await res.json();
  tokens[key] = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return j.access_token;
}
// one GraphQL call; userErrors in the payload are thrown
export async function gql(cfg, queryText, variables = {}, { fresh } = {}) {
  const res = await fetch(`${base(cfg.domain)}/admin/api/${API_VERSION}/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': await token(cfg, fresh), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: queryText, variables }) });
  const text = await res.text();
  if (!res.ok) { const e = new Error(res.status === 403 ? 'The Shopify app is missing a permission for this call (see SHOPIFY-SETUP.md for the scopes).' : `Shopify GraphQL (${res.status}): ${text.slice(0, 200)}`); e.status = res.status; throw e; }
  const j = JSON.parse(text);
  if (j.errors && j.errors.length) { const e = new Error('Shopify: ' + j.errors.map(x => x.message).join('; ').slice(0, 300)); e.throttled = j.errors.some(x => /throttl/i.test(x.message)); throw e; }
  const ue = Object.values(j.data || {}).flatMap(v => (v && v.userErrors) || []);
  if (ue.length) throw new Error('Shopify refused: ' + ue.map(x => x.message).join('; ').slice(0, 300));
  return j.data;
}
export function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got; try { got = Buffer.from(String(hmacHeader), 'base64'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---- the sync log: every push, pull and webhook, with retries counted
export async function logSync(entityId, kind, status, message, extra = {}) {
  try { await addDoc('shopifySync', { kind, status, message: String(message || '').slice(0, 500), ...extra, ...serverStamp(entityId, extra.storeId || '', 'server', 'server') }); } catch (e) { console.error('shopifySync log', e.message); }
}

// ---- the stock queue: one row per store item that must reach Shopify, fed by the sale core
const queueId = (entityId, storeId, itemId) => `${entityId}_${storeId}_${itemId}`;
export async function queueStock(entityId, storeId, items, levels) {
  const now = nowIso();
  const writes = items.map(itemId => { const lv = levels.get(storeId + '_' + itemId) || {}; return { set: true, coll: 'shopifyQueue', id: queueId(entityId, storeId, itemId), data: { entityId, storeId, itemId, productId: lv.productId || '', variantId: lv.variantId || '', availableQty: (lv.onHandQty || 0) - (lv.reservedQty || 0), queuedAt: now, attempts: 0, nextAt: now, lastError: '', createdBy: 'server', createdAt: now, deviceId: 'server' } }; });
  if (writes.length) await commit(writes);
}
// push what is queued: the entity's secrets, the store's location, the item's inventory item id; back-off on failure
export async function flushStock(entityId, { budgetMs = 4000, max = 40 } = {}) {
  const started = Date.now();
  const cfg = await secretsOf(entityId); if (!cfg) return { pushed: 0, skipped: 'not connected' };
  const sh = await settingsOf(entityId); if (sh.pushStock === false) return { pushed: 0, skipped: 'push off' };
  const now = nowIso();
  const rows = (await query('shopifyQueue', [{ field: 'entityId', value: entityId }], 500)).filter(r => !r.nextAt || r.nextAt <= now).sort((a, b) => String(a.nextAt).localeCompare(String(b.nextAt))).slice(0, max);
  let pushed = 0, failed = 0;
  const groups = new Map();
  for (const r of rows) {
    const loc = (sh.locationByStore || {})[r.storeId];
    if (!loc) { await patchDoc('shopifyQueue', r.id, { attempts: r.attempts + 1, lastError: 'store not mapped to a Shopify location', nextAt: new Date(Date.now() + 3600000).toISOString() }); failed++; continue; }
    if (!r.variantId && !r.productId) { await commit([{ delete: true, coll: 'shopifyQueue', id: r.id }]); continue; }
    const item = r.variantId ? await getDoc('variants', r.variantId) : await getDoc('products', r.productId);
    const inv = item && item.shopifyInventoryItemId;
    if (!inv) { await commit([{ delete: true, coll: 'shopifyQueue', id: r.id }]); continue; }   // not linked: nothing to push
    if (!groups.has(loc)) groups.set(loc, []);
    groups.get(loc).push({ row: r, inventoryItemId: inv, quantity: Math.max(0, r.availableQty) });
    if (Date.now() - started > budgetMs) break;
  }
  for (const [loc, list] of groups) {
    try {
      await gql(cfg, `mutation set($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } inventoryAdjustmentGroup { createdAt } } }`, { input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: list.map(x => ({ inventoryItemId: x.inventoryItemId, locationId: loc, quantity: x.quantity })) } });
      await commit(list.map(x => ({ delete: true, coll: 'shopifyQueue', id: x.row.id })));
      pushed += list.length;
      await logSync(entityId, 'stock', 'ok', `${list.length} item${list.length === 1 ? '' : 's'} pushed to ${gidNum(loc)}`, { count: list.length });
    } catch (e) {
      failed += list.length;
      const wait = (n) => Math.min(6 * 3600000, 60000 * Math.pow(2, Math.min(n, 8)));
      for (const x of list) await patchDoc('shopifyQueue', x.row.id, { attempts: x.row.attempts + 1, lastError: String(e.message).slice(0, 300), nextAt: new Date(Date.now() + wait(x.row.attempts)).toISOString() });
      await logSync(entityId, 'stock', 'retry', e.message, { count: list.length });
    }
  }
  if (pushed || failed) await patchShopify(entityId, { lastSyncAt: nowIso(), lastError: failed ? 'some stock did not push; it will retry' : '' }).catch(() => {});
  return { pushed, failed, left: rows.length - pushed - failed };
}
// the hook the sale core calls after a commit: queue the levels that moved, then try to push them at once
export async function afterStock(ctx, levels) {
  try {
    const sh = await settingsOf(ctx.entityId);
    if (!sh.connected || sh.pushStock === false) return;
    const byStore = new Map();
    for (const [id, lv] of levels) { if (!lv) continue; const storeId = lv.storeId || id.slice(0, id.indexOf('_')); const itemId = lv.variantId || lv.productId || id.slice(id.indexOf('_') + 1); if (!byStore.has(storeId)) byStore.set(storeId, []); byStore.get(storeId).push(itemId); }
    for (const [storeId, items] of byStore) await queueStock(ctx.entityId, storeId, items, levels);
    await flushStock(ctx.entityId, { budgetMs: 3000 });
  } catch (e) { console.error('shopify afterStock', e.message); await logSync(ctx.entityId, 'stock', 'retry', 'queued for the schedule: ' + e.message); }
}
