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
import { getStore } from '@netlify/blobs';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shopify(path, { method = 'GET', body } = {}, _retry = 0) {
  const c = cfg();
  const token = await accessToken();
  const res = await fetch(`https://${c.domain}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  // Respect Shopify's REST rate limit: back off on 429 and retry a few times.
  if (res.status === 429 && _retry < 6) {
    const ra = Number(res.headers.get('Retry-After')) || 1;
    await sleep(ra * 1000 + 250);
    return shopify(path, { method, body }, _retry + 1);
  }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) { const e = new Error(`Shopify ${method} ${path} (${res.status}): ${text.slice(0, 300)}`); e.status = res.status; throw e; }
  return { json, headers: res.headers };
}

// GraphQL Admin API — used for gift cards + store credit, which have no REST
// equivalent on current API versions. Newer version than the REST calls because
// giftCardDebit/storeCreditAccount* don't exist on 2024-10.
const GQL_API_VERSION = '2025-07';
async function gql(query, variables) {
  const c = cfg();
  const token = await accessToken();
  const res = await fetch(`https://${c.domain}/admin/api/${GQL_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) { const e = new Error(`Shopify GraphQL (${res.status})`); e.status = res.status; throw e; }
  if (j.errors && j.errors.length) {
    const msg = j.errors.map(x => x.message).join('; ');
    const e = new Error(msg.includes('access') ? msg + ' — the app is missing a scope (gift cards need read/write_gift_cards, which Shopify Support must enable; store credit needs read_store_credit_accounts + write_store_credit_account_transactions).' : msg);
    e.status = 400; throw e;
  }
  return j.data;
}
const centsToDec = (c) => (Number(c) / 100).toFixed(2);
const decToCents = (d) => Math.round(Number(d) * 100);
const CURRENCY = process.env.SHOPIFY_CURRENCY || 'ZAR';
function userErrs(node) {
  const errs = (node && node.userErrors) || [];
  if (errs.length) { const e = new Error(errs.map(x => x.message).join('; ')); e.status = 400; throw e; }
}

// ---- Gift cards (GraphQL) ----
// We generate the code client-side and keep a hashed map in Firestore, because
// Shopify never returns a gift card's code after creation (last 4 chars only).
async function gcCreate({ amountCents, code, customerId, note }) {
  if (!amountCents || amountCents <= 0) { const e = new Error('No amount'); e.status = 400; throw e; }
  const d = await gql(`mutation($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard { id lastCharacters balance { amount } }
      userErrors { message }
    }}`, { input: {
      initialValue: centsToDec(amountCents),
      ...(code ? { code } : {}),
      ...(customerId ? { customerId: `gid://shopify/Customer/${customerId}` } : {}),
      note: note || 'Sold at ReptiCube POS'
    } });
  userErrs(d.giftCardCreate);
  const gc = d.giftCardCreate.giftCard;
  return { id: gc.id, last4: gc.lastCharacters, balanceCents: decToCents(gc.balance.amount) };
}
async function gcBalance({ id }) {
  const d = await gql(`query($id: ID!) { node(id: $id) { ... on GiftCard {
    id lastCharacters enabled expiresOn balance { amount } } } }`, { id });
  const gc = d.node;
  if (!gc) { const e = new Error('Gift card not found'); e.status = 404; throw e; }
  return { id: gc.id, last4: gc.lastCharacters, enabled: !!gc.enabled, expiresOn: gc.expiresOn || null, balanceCents: decToCents(gc.balance.amount) };
}
// Fallback lookup for cards not in our map (e.g. sold online): search by the
// LAST characters of the code — Shopify can't search the full code.
async function gcFind({ last4 }) {
  const d = await gql(`query($q: String!) { giftCards(first: 5, query: $q) {
    nodes { id lastCharacters enabled balance { amount } } } }`, { q: `code:${last4} status:enabled` });
  return { cards: (d.giftCards.nodes || []).map(gc => ({ id: gc.id, last4: gc.lastCharacters, enabled: !!gc.enabled, balanceCents: decToCents(gc.balance.amount) })) };
}
async function gcDebit({ id, amountCents }) {
  if (!amountCents || amountCents <= 0) { const e = new Error('No amount'); e.status = 400; throw e; }
  const d = await gql(`mutation($id: ID!, $debitInput: GiftCardDebitInput!) {
    giftCardDebit(id: $id, debitInput: $debitInput) {
      giftCardDebitTransaction { giftCard { balance { amount } } }
      userErrors { message }
    }}`, { id, debitInput: { debitAmount: { amount: centsToDec(amountCents), currencyCode: CURRENCY } } });
  userErrs(d.giftCardDebit);
  return { balanceCents: decToCents(d.giftCardDebit.giftCardDebitTransaction.giftCard.balance.amount) };
}

// ---- Store credit (GraphQL) ----
async function scBalance({ customerId }) {
  const d = await gql(`query($id: ID!) { customer(id: $id) {
    storeCreditAccounts(first: 10) { nodes { id balance { amount currencyCode } } } } }`,
    { id: `gid://shopify/Customer/${customerId}` });
  const accts = (d.customer && d.customer.storeCreditAccounts.nodes) || [];
  const acct = accts.find(a => a.balance.currencyCode === CURRENCY) || accts[0];
  return acct ? { accountId: acct.id, balanceCents: decToCents(acct.balance.amount) } : { accountId: null, balanceCents: 0 };
}
async function scCredit({ customerId, amountCents }) {
  if (!amountCents || amountCents <= 0) { const e = new Error('No amount'); e.status = 400; throw e; }
  const d = await gql(`mutation($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction { account { id balance { amount } } }
      userErrors { message }
    }}`, { id: `gid://shopify/Customer/${customerId}`,
      creditInput: { creditAmount: { amount: centsToDec(amountCents), currencyCode: CURRENCY } } });
  userErrs(d.storeCreditAccountCredit);
  return { balanceCents: decToCents(d.storeCreditAccountCredit.storeCreditAccountTransaction.account.balance.amount) };
}
async function scDebit({ accountId, amountCents }) {
  if (!amountCents || amountCents <= 0) { const e = new Error('No amount'); e.status = 400; throw e; }
  const d = await gql(`mutation($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
      storeCreditAccountTransaction { account { id balance { amount } } }
      userErrors { message }
    }}`, { id: accountId, debitInput: { debitAmount: { amount: centsToDec(amountCents), currencyCode: CURRENCY } } });
  userErrs(d.storeCreditAccountDebit);
  return { balanceCents: decToCents(d.storeCreditAccountDebit.storeCreditAccountTransaction.account.balance.amount) };
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
      const productImage = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '';
      // Map each image id → src so a variant can show its OWN photo.
      const imgById = {};
      (p.images || []).forEach(im => { if (im && im.id != null) imgById[String(im.id)] = im.src; });
      for (const v of variants) {
        const named = variants.length > 1 && v.title && v.title !== 'Default Title';
        const variantImage = (v.image_id != null && imgById[String(v.image_id)]) || productImage;
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
          vendor: p.vendor || '',
          imageUrl: variantImage
        });
      }
    }
    // Pagination via Link header
    const link = (headers.get('link') || headers.get('Link') || '');
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1].replace(/^https?:\/\/[^/]+\/admin\/api\/[^/]+/, '') : null;
  }

  // Attach each product's Shopify COLLECTIONS so the till can show the same
  // catalogue structure as the online store (a product can sit in several).
  // Best-effort: if this fails the till falls back to product_type.
  try {
    const collMap = {};
    let after = null;
    for (let page = 0; page < 30; page++) {
      const d = await gql(`query($after: String) { products(first: 50, after: $after, query: "status:active") {
        nodes { legacyResourceId collections(first: 15) { nodes { title } } }
        pageInfo { hasNextPage endCursor } } }`, { after });
      d.products.nodes.forEach(n => { collMap[String(n.legacyResourceId)] = n.collections.nodes.map(c => c.title); });
      if (!d.products.pageInfo.hasNextPage) break;
      after = d.products.pageInfo.endCursor;
    }
    out.forEach(r => { r.collections = collMap[r.productId] || []; });
  } catch (e) { /* collections are an enhancement — the catalogue still works without them */ }
  // Best-effort: pull each variant's unit cost (Shopify "Cost per item") so the
  // POS can show margins. Batched; never blocks the catalogue if it fails.
  try {
    const ids = [...new Set(out.map(r => r.inventoryItemId).filter(Boolean))];
    const costMap = {};
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const { json } = await shopify(`/inventory_items.json?ids=${batch.join(',')}&limit=100`);
      (json.inventory_items || []).forEach(it => { if (it.cost != null && it.cost !== '') costMap[String(it.id)] = Math.round((Number(it.cost) || 0) * 100); });
    }
    out.forEach(r => { if (costMap[r.inventoryItemId] != null) r.costCents = costMap[r.inventoryItemId]; });
  } catch (e) { /* costs optional (needs read_inventory) */ }
  return out;
}

// Create a paid + (best-effort) fulfilled Shopify order for a walk-in sale, so
// inventory decrements. lineItems: [{ variantId, qty }]. idemKey makes retries
// return the SAME order instead of creating duplicates. Returns the order name.
async function createOrder({ lineItems, note, idemKey, customerId, onAccount }) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) { const e = new Error('No line items'); e.status = 400; throw e; }

  // Idempotency: if we've already created an order for this key, return it.
  let store = null;
  if (idemKey) {
    try {
      store = getStore('reptipos-orders');
      const prior = await store.get(idemKey, { type: 'json' });
      if (prior) return { ...prior, idempotent: true };
    } catch (e) { store = null; /* Blobs unavailable — proceed without the guard */ }
  }

  const payload = {
    order: {
      line_items: lineItems.map(li => {
        // Custom (open) line: title + price only — no product exists, so no
        // variant and no stock movement. Everything else sells by variant.
        if (li.custom) return { title: String(li.title || 'Custom item').slice(0, 255), quantity: Number(li.qty) || 1, price: (Number(li.priceCents) / 100).toFixed(2) };
        const li2 = { variant_id: Number(li.variantId), quantity: Number(li.qty) || 1 };
        // Discounted unit price (cents) overrides the variant price so the order
        // total matches what the customer actually paid. Inventory still
        // decrements by variant.
        if (li.priceCents != null) li2.price = (Number(li.priceCents) / 100).toFixed(2);
        return li2;
      }),
      // On-account sales are recorded as PENDING in Shopify — the money hasn't
      // arrived yet; the till's account ledger tracks the debt.
      financial_status: onAccount ? 'pending' : 'paid',
      inventory_behaviour: 'decrement_obeying_policy', // decrement stock
      tags: onAccount ? 'walk-in, on-account' : 'walk-in',
      source_name: 'reptipos',
      note: note || 'ReptiCube walk-in POS',
      send_receipt: false,
      send_fulfillment_receipt: false,
      ...(customerId ? { customer: { id: Number(customerId) } } : {})
    }
  };
  const { json } = await shopify('/orders.json', { method: 'POST', body: payload });
  const order = json.order;

  // Best-effort: mark fulfilled (stock already decremented via inventory_behaviour).
  let fulfilled = false;
  try {
    const fo = await shopify(`/orders/${order.id}/fulfillment_orders.json`);
    const ids = (fo.json.fulfillment_orders || []).filter(f => f.status !== 'closed').map(f => ({ fulfillment_order_id: f.id }));
    if (ids.length) {
      await shopify('/fulfillments.json', { method: 'POST', body: { fulfillment: { line_items_by_fulfillment_order: ids, notify_customer: false } } });
      fulfilled = true;
    }
  } catch (e) { /* paid + decremented already; fulfillment is non-critical */ }

  const result = { orderId: String(order.id), orderName: order.name, fulfilled };
  if (store && idemKey) { try { await store.setJSON(idemKey, result); } catch (e) { /* best-effort */ } }
  return result;
}

// Receive goods into stock: increment Shopify inventory at the primary location
// for each line (GRV). idemKey makes a retry a no-op instead of double-adding.
// lineItems: [{ inventoryItemId, qty, costCents? }]. Optionally update the
// variant's cost so margins stay current.
async function receiveStock({ lineItems, idemKey, updateCost }) {
  const lines = (lineItems || []).filter(l => l.inventoryItemId && (Number(l.qty) || 0) !== 0);
  if (lines.length === 0) { const e = new Error('No stock lines'); e.status = 400; throw e; }

  let store = null;
  if (idemKey) {
    try { store = getStore('reptipos-grv'); const prior = await store.get(idemKey, { type: 'json' }); if (prior) return { ...prior, idempotent: true }; }
    catch (e) { store = null; }
  }

  const locationId = await primaryLocationId(); // needs read_locations; receiving needs a location
  if (!locationId) { const e = new Error('No Shopify location to receive into'); e.status = 400; throw e; }

  const received = [];
  for (const li of lines) {
    const invItem = Number(li.inventoryItemId);
    const qty = Number(li.qty) || 0;
    const body = { location_id: Number(locationId), inventory_item_id: invItem, available_adjustment: qty };
    try {
      await shopify('/inventory_levels/adjust.json', { method: 'POST', body });
    } catch (e) {
      // Item may not be stocked at this location yet — connect, then retry.
      await shopify('/inventory_levels/connect.json', { method: 'POST', body: { location_id: Number(locationId), inventory_item_id: invItem } }).catch(() => {});
      await shopify('/inventory_levels/adjust.json', { method: 'POST', body });
    }
    if (updateCost && li.costCents != null) {
      try { await shopify(`/inventory_items/${invItem}.json`, { method: 'PUT', body: { inventory_item: { id: invItem, cost: (Number(li.costCents) / 100).toFixed(2) } } }); } catch (e) { /* cost is non-critical */ }
    }
    received.push({ inventoryItemId: String(invItem), qty });
  }
  const result = { received: received.length, lineItems: received, locationId: String(locationId) };
  if (store && idemKey) { try { await store.setJSON(idemKey, result); } catch (e) {} }
  return result;
}

// Set counted quantities as the ABSOLUTE stock level (stock take reconcile).
// lineItems: [{ inventoryItemId, counted }]. Setting an absolute value is
// naturally idempotent, so no idemKey is needed.
async function setStock({ lineItems }) {
  const lines = (lineItems || []).filter(l => l.inventoryItemId && l.counted != null);
  if (lines.length === 0) { const e = new Error('No counts'); e.status = 400; throw e; }
  const locationId = await primaryLocationId();
  if (!locationId) { const e = new Error('No Shopify location to count into'); e.status = 400; throw e; }
  const done = []; const failed = [];
  for (const l of lines) {
    const invItem = Number(l.inventoryItemId);
    const available = Math.max(0, Math.round(Number(l.counted) || 0));
    const body = { location_id: Number(locationId), inventory_item_id: invItem, available };
    try {
      try { await shopify('/inventory_levels/set.json', { method: 'POST', body }); }
      catch (e) {
        // Maybe not stocked at this location yet — connect, then retry once.
        await shopify('/inventory_levels/connect.json', { method: 'POST', body: { location_id: Number(locationId), inventory_item_id: invItem } }).catch(() => {});
        await shopify('/inventory_levels/set.json', { method: 'POST', body });
      }
      done.push(String(invItem));
    } catch (e) {
      // One item failing (e.g. a bundle / inventory not tracked) must not abort the rest.
      failed.push({ inventoryItemId: String(invItem), error: String(e.message || e).slice(0, 160) });
    }
  }
  return { set: done.length, done, failed };
}

// Bulk-set unit cost prices (Shopify "Cost per item"). lineItems: [{ inventoryItemId, costCents }].
async function setCosts({ lineItems }) {
  const lines = (lineItems || []).filter(l => l.inventoryItemId && l.costCents != null);
  if (lines.length === 0) { const e = new Error('No costs'); e.status = 400; throw e; }
  const done = []; const failed = [];
  for (const l of lines) {
    const invItem = Number(l.inventoryItemId);
    try { await shopify(`/inventory_items/${invItem}.json`, { method: 'PUT', body: { inventory_item: { id: invItem, cost: (Number(l.costCents) / 100).toFixed(2) } } }); done.push(String(invItem)); }
    catch (e) { failed.push({ inventoryItemId: String(invItem), error: String(e.message || e).slice(0, 160) }); }
  }
  return { set: done.length, done, failed };
}

async function shopInfo() {
  try { const { json } = await shopify('/shop.json'); return json.shop ? json.shop.name : ''; }
  catch (e) { return ''; }
}

// ---- Customers ----
function mapCustomer(c) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || c.phone || ('Customer ' + c.id);
  return { id: String(c.id), name, email: c.email || '', phone: c.phone || '' };
}
async function searchCustomers(q) {
  const query = encodeURIComponent(String(q || '').trim());
  if (!query) return [];
  const { json } = await shopify(`/customers/search.json?query=${query}&limit=20`);
  return (json.customers || []).map(mapCustomer);
}
async function createCustomer({ firstName, lastName, name, email, phone }) {
  let fn = firstName, ln = lastName;
  if (!fn && name) { const parts = String(name).trim().split(/\s+/); fn = parts.shift(); ln = parts.join(' '); }
  const body = { customer: { first_name: fn || '', last_name: ln || '', email: email || undefined, phone: phone || undefined } };
  const { json } = await shopify('/customers.json', { method: 'POST', body });
  return mapCustomer(json.customer);
}
// ---- Parked sales (Shopify draft orders) ----
// The full cart state (incl. discounts) is stashed in the draft's note as JSON
// under a marker, so retrieve restores it exactly.
const PARK_MARKER = '@@reptipos-park@@';
async function draftCreate({ lineItems, customerId, parkData }) {
  const body = {
    draft_order: {
      line_items: lineItems.map(li => ({ variant_id: Number(li.variantId), quantity: Number(li.qty) || 1 })),
      tags: 'pos,parked',
      note: PARK_MARKER + (parkData ? JSON.stringify(parkData) : ''),
      ...(customerId ? { customer: { id: Number(customerId) } } : {})
    }
  };
  const { json } = await shopify('/draft_orders.json', { method: 'POST', body });
  return { id: String(json.draft_order.id), name: json.draft_order.name };
}
async function draftList() {
  const { json } = await shopify('/draft_orders.json?status=open&limit=50');
  return (json.draft_orders || []).filter(d => d.note && d.note.startsWith(PARK_MARKER)).map(d => {
    let parkData = null;
    try { parkData = JSON.parse(d.note.slice(PARK_MARKER.length)); } catch (e) {}
    return {
      id: String(d.id), name: d.name, createdAt: d.created_at,
      totalCents: Math.round((Number(d.total_price) || 0) * 100),
      customerName: d.customer ? [d.customer.first_name, d.customer.last_name].filter(Boolean).join(' ') : '',
      parkData
    };
  });
}
async function draftDelete(id) {
  await shopify(`/draft_orders/${Number(id)}.json`, { method: 'DELETE' });
  return { ok: true };
}

// ---- Quotes & Sales orders (Shopify draft orders carrying a JSON doc) ----
// Both are draft orders so they're visible in Shopify admin. Full state (cart,
// discounts, deposit, balance, status) lives in the note under a marker. Tags:
//   pos,quote          a price quote
//   pos,sales-order    a sales order (deposit taken, balance owing, awaiting stock)
const DOC_MARKER = '@@reptipos-doc@@';
function buildDocNote(doc) { return DOC_MARKER + JSON.stringify(doc || {}); }
function parseDocNote(note) {
  if (!note) return null;
  const i = note.indexOf(DOC_MARKER);
  if (i < 0) return null;
  try { return JSON.parse(note.slice(i + DOC_MARKER.length)); } catch (e) { return null; }
}
async function docSave({ id, lineItems, customerId, tags, doc }) {
  const draft = {
    line_items: (lineItems || []).map(li => li.custom
      ? { title: String(li.title || 'Custom item').slice(0, 255), quantity: Number(li.qty) || 1, price: (Number(li.priceCents) / 100).toFixed(2) }
      : { variant_id: Number(li.variantId), quantity: Number(li.qty) || 1 }),
    tags: tags || 'pos',
    note: buildDocNote(doc),
    ...(customerId ? { customer: { id: Number(customerId) } } : {})
  };
  if (id) {
    const { json } = await shopify(`/draft_orders/${Number(id)}.json`, { method: 'PUT', body: { draft_order: { id: Number(id), ...draft } } });
    return { id: String(json.draft_order.id), name: json.draft_order.name };
  }
  const { json } = await shopify('/draft_orders.json', { method: 'POST', body: { draft_order: draft } });
  return { id: String(json.draft_order.id), name: json.draft_order.name };
}
async function docList(type, customerId) {
  const { json } = await shopify('/draft_orders.json?status=open&limit=100');
  return (json.draft_orders || []).map(d => {
    const doc = parseDocNote(d.note);
    return {
      id: String(d.id), name: d.name, createdAt: d.created_at,
      customer: d.customer ? { id: String(d.customer.id), name: [d.customer.first_name, d.customer.last_name].filter(Boolean).join(' ') } : null,
      doc
    };
  }).filter(d => d.doc && (!type || d.doc.type === type) && (!customerId || (d.customer && d.customer.id === String(customerId))));
}

// ---- Refunds / returns ----
// Look up an order by its name/number (e.g. "#1001", "1001", or "RC-…" if tagged)
// so the till can refund against it. Returns line items with the quantity still
// refundable (original qty minus what's already been refunded).
async function lookupOrder(q) {
  const term = String(q || '').trim();
  if (!term) return null;
  // Try by name first (Shopify matches with/without the leading #).
  let order = null;
  try {
    const { json } = await shopify(`/orders.json?name=${encodeURIComponent(term)}&status=any&limit=5`);
    order = (json.orders || [])[0] || null;
  } catch (e) { /* fall through */ }
  // Fall back to a numeric order id.
  if (!order && /^\d+$/.test(term)) {
    try { const { json } = await shopify(`/orders/${term}.json`); order = json.order || null; } catch (e) {}
  }
  if (!order) return null;

  // Tally quantities already refunded per line item.
  const refunded = {};
  for (const r of order.refunds || []) {
    for (const rli of r.refund_line_items || []) {
      const id = String(rli.line_item_id);
      refunded[id] = (refunded[id] || 0) + (Number(rli.quantity) || 0);
    }
  }
  const lineItems = (order.line_items || []).map(li => {
    const already = refunded[String(li.id)] || 0;
    const refundable = Math.max(0, (Number(li.quantity) || 0) - already);
    return {
      lineItemId: String(li.id),
      variantId: li.variant_id != null ? String(li.variant_id) : '',
      name: li.title + (li.variant_title && li.variant_title !== 'Default Title' ? ' — ' + li.variant_title : ''),
      sku: li.sku || '',
      qty: Number(li.quantity) || 0,
      refundedQty: already,
      refundableQty: refundable,
      unitPriceCents: Math.round((Number(li.price) || 0) * 100)
    };
  });
  return {
    orderId: String(order.id),
    name: order.name,
    createdAt: order.created_at,
    totalCents: Math.round((Number(order.total_price) || 0) * 100),
    customerName: order.customer ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') : '',
    financialStatus: order.financial_status,
    lineItems
  };
}

// Create a refund (optionally restocking) for selected line items. idemKey makes
// a retry return the same refund instead of refunding twice.
// refundLineItems: [{ lineItemId, qty }].
async function refundCreate({ orderId, refundLineItems, restock, reason, idemKey }) {
  if (!orderId) { const e = new Error('No order'); e.status = 400; throw e; }
  const lines = (refundLineItems || []).filter(l => (Number(l.qty) || 0) > 0);
  if (lines.length === 0) { const e = new Error('Nothing to refund'); e.status = 400; throw e; }

  let store = null;
  if (idemKey) {
    try { store = getStore('reptipos-refunds'); const prior = await store.get(idemKey, { type: 'json' }); if (prior) return { ...prior, idempotent: true }; }
    catch (e) { store = null; }
  }

  // Restock needs a location; if we can't read one, refund without restocking.
  let locationId = null;
  if (restock) { try { locationId = await primaryLocationId(); } catch (e) { locationId = null; } }
  const restockType = (restock && locationId) ? 'return' : 'no_restock';
  const refund_line_items = lines.map(l => ({
    line_item_id: Number(l.lineItemId),
    quantity: Number(l.qty),
    restock_type: restockType,
    ...(restockType === 'return' ? { location_id: Number(locationId) } : {})
  }));

  // Ask Shopify to calculate the refund (amounts + suggested transactions), then
  // submit exactly that so the money figure always matches the order.
  let transactions = [];
  let calcAmountCents = 0;
  try {
    const { json } = await shopify(`/orders/${Number(orderId)}/refunds/calculate.json`, {
      method: 'POST', body: { refund: { refund_line_items, currency: undefined } }
    });
    const calc = json.refund || {};
    transactions = (calc.transactions || []).map(t => ({ parent_id: t.parent_id, amount: t.amount, kind: 'refund', gateway: t.gateway }));
    calcAmountCents = (calc.transactions || []).reduce((s, t) => s + Math.round((Number(t.amount) || 0) * 100), 0);
  } catch (e) { /* calculate may be unavailable; fall back to line-item only refund */ }

  const body = {
    refund: {
      notify: false,
      note: reason || 'ReptiCube POS refund',
      refund_line_items,
      ...(transactions.length ? { transactions } : {})
    }
  };
  const { json } = await shopify(`/orders/${Number(orderId)}/refunds.json`, { method: 'POST', body });
  const refund = json.refund || {};
  const amountCents = calcAmountCents || (refund.transactions || []).reduce((s, t) => s + Math.round((Number(t.amount) || 0) * 100), 0);
  const result = { refundId: String(refund.id || ''), orderId: String(orderId), amountCents, restocked: restockType === 'return' };
  if (store && idemKey) { try { await store.setJSON(idemKey, result); } catch (e) {} }
  return result;
}

async function customerOrders(customerId) {
  const { json } = await shopify(`/orders.json?customer_id=${Number(customerId)}&status=any&limit=20`);
  return (json.orders || []).map(o => ({
    name: o.name, createdAt: o.created_at,
    totalCents: Math.round((Number(o.total_price) || 0) * 100),
    items: (o.line_items || []).reduce((n, li) => n + (Number(li.quantity) || 0), 0)
  }));
}

// One historic (Lightspeed) receipt → a backdated Shopify order. Custom line
// items only (no variants), so stock is NEVER touched; processed_at carries
// the original sale date so Shopify reports place it correctly. Idempotent
// per receipt number, so re-running an import can't duplicate orders.
async function importHistoric({ receipt, processedAt, lineItems, note, paymentMethod }) {
  if (!receipt || !processedAt || !Array.isArray(lineItems) || !lineItems.length) {
    const e = new Error('receipt, processedAt and lineItems are required'); e.status = 400; throw e;
  }
  let store = null;
  const key = 'ls-' + String(receipt);
  try {
    store = getStore('reptipos-lsimport');
    const prior = await store.get(key, { type: 'json' });
    if (prior) return { ...prior, idempotent: true };
  } catch (e) { store = null; }
  const payload = {
    order: {
      line_items: lineItems.map(li => ({
        title: String(li.title || 'Item').slice(0, 255),
        quantity: 1,                                        // qty folded into the title; price is the LINE total → order total exact
        price: (Number(li.priceCents) / 100).toFixed(2)
      })),
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
      processed_at: processedAt,                            // the original Lightspeed sale date
      tags: 'lightspeed-import',
      source_name: 'lightspeed',
      note: note || ('Lightspeed receipt ' + receipt),
      send_receipt: false,
      send_fulfillment_receipt: false
      // NO inventory_behaviour → inventory is bypassed entirely
    }
  };
  const { json } = await shopify('/orders.json', { method: 'POST', body: payload });
  const out = { orderId: String(json.order.id), orderName: json.order.name };
  if (store) { try { await store.set(key, JSON.stringify(out)); } catch (e) {} }
  return out;
}

// Compact order list for a date range — the till's "Shopify" sales view.
// Includes ALL orders (till + online web orders), newest first, capped at 500.
async function listOrders({ since, until }) {
  if (!since) { const e = new Error('No date range'); e.status = 400; throw e; }
  let url = `/orders.json?status=any&created_at_min=${encodeURIComponent(since)}${until ? `&created_at_max=${encodeURIComponent(until)}` : ''}&limit=250&fields=id,name,created_at,total_price,financial_status,cancelled_at,source_name,customer,line_items`;
  const orders = [];
  let guard = 0;
  while (url && guard < 2) {   // 2 pages = 500 orders, plenty for a period view
    guard++;
    const { json, headers } = await shopify(url);
    for (const o of json.orders || []) {
      orders.push({
        id: String(o.id), name: o.name, createdAt: o.created_at,
        totalCents: Math.round((Number(o.total_price) || 0) * 100),
        financialStatus: o.financial_status || '',
        cancelled: !!o.cancelled_at,
        source: o.source_name || '',
        customerName: o.customer ? [o.customer.first_name, o.customer.last_name].filter(Boolean).join(' ') : '',
        itemCount: (o.line_items || []).reduce((n, li) => n + (Number(li.quantity) || 0), 0)
      });
    }
    const link = (headers.get('link') || headers.get('Link') || '');
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1].replace(/^https?:\/\/[^/]+\/admin\/api\/[^/]+/, '') : null;
  }
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { orders };
}

// Sales report for a date range: totals + per-variant breakdown + points for a chart.
async function salesReport({ since, until }) {
  if (!since) { const e = new Error('No date range'); e.status = 400; throw e; }
  let url = `/orders.json?status=any&created_at_min=${encodeURIComponent(since)}${until ? `&created_at_max=${encodeURIComponent(until)}` : ''}&limit=250`;
  let orderCount = 0, salesCents = 0, itemCount = 0; const byVariant = {}; const points = [];
  let guard = 0;
  while (url && guard < 25) {
    guard++;
    const { json, headers } = await shopify(url);
    for (const o of json.orders || []) {
      if (o.cancelled_at) continue;
      const cents = Math.round((Number(o.total_price) || 0) * 100);
      orderCount++; salesCents += cents; points.push({ at: o.created_at, cents });
      for (const li of o.line_items || []) {
        const q = Number(li.quantity) || 0; itemCount += q;
        const vid = li.variant_id != null ? String(li.variant_id) : ('t:' + (li.title || ''));
        const v = byVariant[vid] || (byVariant[vid] = { variantId: li.variant_id != null ? String(li.variant_id) : '', name: li.title || '', qty: 0, revenueCents: 0 });
        v.qty += q; v.revenueCents += Math.round((Number(li.price) || 0) * 100) * q;
      }
    }
    const link = (headers.get('link') || headers.get('Link') || '');
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1].replace(/^https?:\/\/[^/]+\/admin\/api\/[^/]+/, '') : null;
  }
  return { orderCount, salesCents, itemCount, items: Object.values(byVariant), points };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    if (body.action === 'getProducts') {
      const products = await getProducts();
      // Location + shop name are optional (extra scopes) — never block the catalogue.
      let locationId = null;
      try { locationId = await primaryLocationId(); } catch (e) { /* read_locations not granted */ }
      const shopName = await shopInfo();
      return json(200, { products, locationId, shopName, domain: cfg().domain });
    }
    if (body.action === 'createOrder') {
      const out = await createOrder(body);
      return json(200, out);
    }
    if (body.action === 'parkSale') return json(200, await draftCreate(body));
    if (body.action === 'listParked') return json(200, { parked: await draftList() });
    if (body.action === 'deleteParked') return json(200, await draftDelete(body.id));
    if (body.action === 'searchCustomers') return json(200, { customers: await searchCustomers(body.q) });
    if (body.action === 'createCustomer') return json(200, { customer: await createCustomer(body) });
    if (body.action === 'customerOrders') return json(200, { orders: await customerOrders(body.customerId) });
    if (body.action === 'salesReport') return json(200, await salesReport(body));
    if (body.action === 'listOrders') return json(200, await listOrders(body));
    if (body.action === 'importHistoric') return json(200, await importHistoric(body));
    if (body.action === 'receiveStock') return json(200, await receiveStock(body));
    if (body.action === 'setStock') return json(200, await setStock(body));
    if (body.action === 'setCosts') return json(200, await setCosts(body));
    if (body.action === 'gcCreate') return json(200, await gcCreate(body));
    if (body.action === 'gcBalance') return json(200, await gcBalance(body));
    if (body.action === 'gcFind') return json(200, await gcFind(body));
    if (body.action === 'gcDebit') return json(200, await gcDebit(body));
    if (body.action === 'scBalance') return json(200, await scBalance(body));
    if (body.action === 'scCredit') return json(200, await scCredit(body));
    if (body.action === 'scDebit') return json(200, await scDebit(body));
    if (body.action === 'docSave') return json(200, await docSave(body));
    if (body.action === 'docList') return json(200, { docs: await docList(body.type, body.customerId) });
    if (body.action === 'docDelete') return json(200, await draftDelete(body.id));
    if (body.action === 'lookupOrder') return json(200, { order: await lookupOrder(body.q) });
    if (body.action === 'refundCreate') return json(200, await refundCreate(body));
    return json(400, { error: `Unknown action "${body.action}"` });
  } catch (e) {
    return json(e.status === 401 ? 401 : (e.status === 400 ? 400 : 502), { error: e.message });
  }
};
