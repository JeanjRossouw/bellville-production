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

// Create a paid + (best-effort) fulfilled Shopify order for a walk-in sale, so
// inventory decrements. lineItems: [{ variantId, qty }]. idemKey makes retries
// return the SAME order instead of creating duplicates. Returns the order name.
async function createOrder({ lineItems, note, idemKey, customerId }) {
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
        const li2 = { variant_id: Number(li.variantId), quantity: Number(li.qty) || 1 };
        // Discounted unit price (cents) overrides the variant price so the order
        // total matches what the customer actually paid. Inventory still
        // decrements by variant.
        if (li.priceCents != null) li2.price = (Number(li.priceCents) / 100).toFixed(2);
        return li2;
      }),
      financial_status: 'paid',
      inventory_behaviour: 'decrement_obeying_policy', // decrement stock
      tags: 'walk-in',
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
  const done = [];
  for (const l of lines) {
    const invItem = Number(l.inventoryItemId);
    const available = Math.max(0, Math.round(Number(l.counted) || 0));
    const body = { location_id: Number(locationId), inventory_item_id: invItem, available };
    try { await shopify('/inventory_levels/set.json', { method: 'POST', body }); }
    catch (e) {
      await shopify('/inventory_levels/connect.json', { method: 'POST', body: { location_id: Number(locationId), inventory_item_id: invItem } }).catch(() => {});
      await shopify('/inventory_levels/set.json', { method: 'POST', body });
    }
    done.push({ inventoryItemId: String(invItem), available });
  }
  return { set: done.length, lineItems: done };
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
    line_items: (lineItems || []).map(li => ({ variant_id: Number(li.variantId), quantity: Number(li.qty) || 1 })),
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
    if (body.action === 'receiveStock') return json(200, await receiveStock(body));
    if (body.action === 'setStock') return json(200, await setStock(body));
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
