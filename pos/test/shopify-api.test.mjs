// Retail POS step 17: pos-shopify against the mock Shopify in mock-shopify.mjs.
// The owner connects (the keys proven and kept server-side), maps a store
// to a location, links products by SKU (content comes across), a sale
// pushes the available quantity at once, a signed webhook order deducts
// stock and an unpaid one reserves it, a cancellation and a refund put it
// back, click & collect is marked and fulfilled, discount codes are pulled
// and one is honoured on a sale, consented customers are pushed, the log.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
import { startMockShopify } from './mock-shopify.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ fails, ...R, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), mgr = await mk('mandla@shop.co.za'), sup = await mk('sam@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + mgr.localId, { email: 'mandla@shop.co.za', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_cushion', { name: 'Scatter Cushion', sku: 'CU-1', priceCents: 19900, costCents: 5000 });
await prod('p_lamp', { name: 'Lamp', sku: 'LA-1', priceCents: 50000, costCents: 20000 });
await prod('p_rug', { name: 'Rug', sku: 'RU-1', priceCents: 80000, costCents: 30000 });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 10, reservedQty: 0, avgCostCents: 5000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 1, avgCostCents: 20000, ...srv('BF', 'BF-BELL') });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', phoneKey: '27825550101', email: 'thandi@example.com', emailKey: 'thandi@example.com', vatNo: '', address: {}, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', tags: [], archived: false, consent: { whatsapp: { granted: false }, sms: { granted: true, at: '2026-10-21T09:00:00.000Z' }, email: { granted: true, at: '2026-10-21T09:00:00.000Z' } }, loyalty: { points: 0, lifetimeCents: 0, tier: '', lots: [] }, stats: {}, ...srv('BF') });
await put('pos/retail/customers/c2', { name: 'No Consent', phone: '0825550199', phoneKey: '27825550199', email: 'no@example.com', consent: { email: { granted: false } }, archived: false, ...srv('BF') });

const mock = await startMockShopify(8799, {
  // the shop's catalogue for the cut-over import: the cushion (already here, price changed), a hide in two sizes with stock, an archived terrarium, a gift card
  products: [
    { id: 'gid://shopify/Product/3001', title: 'Scatter Cushion — Linen', handle: 'scatter-cushion', descriptionHtml: '<p>A soft linen cushion.</p>', status: 'ACTIVE', vendor: 'Bellville', productType: 'Home > Cushions', tags: [], isGiftCard: false, options: [{ name: 'Title', values: ['Default Title'] }], images: { nodes: [{ url: 'https://cdn.example/cushion.jpg' }] }, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1001', title: 'Default Title', sku: 'CU-1', barcode: '6001234567890', price: '219.00', taxable: true, selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null, inventoryItem: { id: 'gid://shopify/InventoryItem/2001', tracked: true, unitCost: { amount: '55.00' }, inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/11' }, quantities: [{ name: 'available', quantity: 99 }] }] } } }] } },
    { id: 'gid://shopify/Product/3010', title: 'Reptile Hide', handle: 'reptile-hide', descriptionHtml: 'A cave.', status: 'ACTIVE', vendor: 'ReptiCube', productType: 'Enclosures', tags: ['hide'], isGiftCard: false, options: [{ name: 'Size', values: ['Small', 'Medium'] }], images: { nodes: [] }, variants: { nodes: [
      { id: 'gid://shopify/ProductVariant/1101', title: 'Small', sku: 'HD-S', barcode: '', price: '149.00', taxable: true, selectedOptions: [{ name: 'Size', value: 'Small' }], image: null, inventoryItem: { id: 'gid://shopify/InventoryItem/2101', tracked: true, unitCost: { amount: '60.00' }, inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/11' }, quantities: [{ name: 'available', quantity: 7 }] }, { location: { id: 'gid://shopify/Location/12' }, quantities: [{ name: 'available', quantity: 2 }] }] } } },
      { id: 'gid://shopify/ProductVariant/1102', title: 'Medium', sku: 'HD-M', barcode: '6009876543210', price: '199.00', taxable: true, selectedOptions: [{ name: 'Size', value: 'Medium' }], image: null, inventoryItem: { id: 'gid://shopify/InventoryItem/2102', tracked: true, unitCost: null, inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/11' }, quantities: [{ name: 'available', quantity: 3 }] }] } } }
    ] } },
    { id: 'gid://shopify/Product/3011', title: 'Old Terrarium', handle: 'old-terrarium', descriptionHtml: '', status: 'ARCHIVED', vendor: '', productType: '', tags: [], isGiftCard: false, options: [{ name: 'Title', values: ['Default Title'] }], images: { nodes: [] }, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1111', title: 'Default Title', sku: 'TR-OLD', barcode: '', price: '1200.00', taxable: true, selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null, inventoryItem: { id: 'gid://shopify/InventoryItem/2111', tracked: true, unitCost: null, inventoryLevels: { nodes: [] } } }] } },
    { id: 'gid://shopify/Product/3012', title: 'Gift Card', handle: 'gift-card', descriptionHtml: '', status: 'ACTIVE', vendor: '', productType: '', tags: [], isGiftCard: true, options: [{ name: 'Denominations', values: ['R100', 'R250'] }], images: { nodes: [] }, variants: { nodes: [
      { id: 'gid://shopify/ProductVariant/1121', title: 'R100', sku: '', barcode: '', price: '100.00', taxable: false, selectedOptions: [{ name: 'Denominations', value: 'R100' }], image: null, inventoryItem: { id: 'gid://shopify/InventoryItem/2121', tracked: false, unitCost: null, inventoryLevels: { nodes: [] } } },
      { id: 'gid://shopify/ProductVariant/1122', title: 'R250', sku: '', barcode: '', price: '250.00', taxable: false, selectedOptions: [{ name: 'Denominations', value: 'R250' }], image: null, inventoryItem: { id: 'gid://shopify/InventoryItem/2122', tracked: false, unitCost: null, inventoryLevels: { nodes: [] } } }
    ] } }
  ],
  variants: [
    { id: 'gid://shopify/ProductVariant/1001', sku: 'CU-1', title: 'Default', inventoryItem: { id: 'gid://shopify/InventoryItem/2001', tracked: true }, product: { id: 'gid://shopify/Product/3001', title: 'Scatter Cushion — Linen', handle: 'scatter-cushion', descriptionHtml: '<p>A soft <b>linen</b> cushion.</p>', status: 'ACTIVE', images: { nodes: [{ url: 'https://cdn.example/cushion.jpg' }] } } },
    { id: 'gid://shopify/ProductVariant/1002', sku: 'la-1', title: 'Default', inventoryItem: { id: 'gid://shopify/InventoryItem/2002', tracked: true }, product: { id: 'gid://shopify/Product/3002', title: 'Lamp', handle: 'lamp', descriptionHtml: '', status: 'ACTIVE', images: { nodes: [] } } },
    { id: 'gid://shopify/ProductVariant/1003', sku: 'ZZ-9', title: 'Default', inventoryItem: { id: 'gid://shopify/InventoryItem/2003', tracked: true }, product: { id: 'gid://shopify/Product/3003', title: 'Unknown thing', handle: 'unknown', descriptionHtml: '', status: 'ACTIVE', images: { nodes: [] } } }
  ],
  discounts: [
    { id: 'gid://shopify/DiscountCodeNode/5001', codeDiscount: { __typename: 'DiscountCodeBasic', title: 'Ten off', status: 'ACTIVE', startsAt: '2026-01-01T00:00:00Z', endsAt: null, codes: { nodes: [{ code: 'TEN' }] }, customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.1 }, items: { __typename: 'AllDiscountItems' } } } },
    { id: 'gid://shopify/DiscountCodeNode/5002', codeDiscount: { __typename: 'DiscountCodeBasic', title: 'R50', status: 'ACTIVE', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z', codes: { nodes: [{ code: 'FIFTY' }] }, customerGets: { value: { __typename: 'DiscountAmount', amount: { amount: '50.00' } }, items: { __typename: 'AllDiscountItems' } } } },
    { id: 'gid://shopify/DiscountCodeNode/5003', codeDiscount: { __typename: 'DiscountCodeFreeShipping', title: 'Free ship', status: 'ACTIVE', codes: { nodes: [{ code: 'SHIP' }] } } }
  ]
});

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit', env: { ...process.env, SHOPIFY_API_BASE: 'http://127.0.0.1:8799' } });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = mgr.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const hook = async (topic, payload, secret = 'shpss_secret') => { const raw = JSON.stringify(payload); const hmac = crypto.createHmac('sha256', secret).update(raw).digest('base64'); const r = await fetch(FN + 'pos-shopify?hook=1&e=BF', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': hmac }, body: raw }); return { status: r.status, ...(await r.json()) }; };
const lvl = (id) => getDoc('pos/retail/stockLevels/BF-BELL_' + id);
const ops = (op) => mock.calls.filter(c => c.op === op);

// ---- connect (the owner), with the keys proven on the mock
R.connMgr = await call('pos-shopify', { action: 'connect', entityId: 'BF', domain: 'bellville-online.myshopify.com', clientId: 'id1', clientSecret: 'shpss_secret' }); check('only the owner connects', R.connMgr.status === 403, R.connMgr);
R.connBad = await call('pos-shopify', { action: 'connect', entityId: 'BF', domain: 'bellville-online.myshopify.com', clientId: 'id1', clientSecret: 'wrong' }, own.idToken); check('wrong keys are refused by the shop', R.connBad.status >= 400 && /Client ID and secret/.test(R.connBad.error), R.connBad);
R.conn = await call('pos-shopify', { action: 'connect', entityId: 'BF', domain: 'https://bellville-online.myshopify.com/', clientId: 'id1', clientSecret: 'shpss_secret', siteUrl: 'http://localhost:8788' }, own.idToken);
check('connected: the shop named, the locations listed', R.conn.ok && R.conn.shopName === 'Bellville Online' && R.conn.locations.length === 2, R.conn);
check('the secret lives server-side', (await getDoc('pos/retail/shopifySecrets/BF')).clientSecret === 'shpss_secret' && (await getDoc('pos/retail/settings/BF')).shopify.connected === true);
// ---- one tap: Connect set the rest up by itself
const HOOK_URL = 'http://localhost:8788/.netlify/functions/pos-shopify?hook=1&e=BF';
check('connect set up: 3 webhooks on the app at this site, Bellville mapped to the Bellville shop location by name, 2 of 3 linked, 2 stock figures pushed, 2 codes pulled, no errors', R.conn.setup && R.conn.setup.webhooks === 3 && mock.state.webhooks.length === 3 && mock.state.webhooks.every(h => h.callbackUrl === HOOK_URL) && mock.state.webhooks.map(h => h.topic).sort().join() === 'ORDERS_CANCELLED,ORDERS_CREATE,REFUNDS_CREATE' && R.conn.setup.mapped.join() === 'Bellville → Bellville shop' && R.conn.setup.unmapped.length === 0 && R.conn.setup.linked === 2 && R.conn.setup.seen === 3 && R.conn.setup.pushed === 2 && R.conn.setup.codes === 2 && R.conn.setup.errors.length === 0, [R.conn.setup, mock.state.webhooks]);
R.shAfter = (await getDoc('pos/retail/settings/BF')).shopify;
check('the mapping, default store, webhooks, site and outcome kept in settings', R.shAfter.locationByStore['BF-BELL'] === 'gid://shopify/Location/11' && R.shAfter.defaultStoreId === 'BF-BELL' && R.shAfter.webhooks.length === 3 && R.shAfter.siteUrl === 'http://localhost:8788' && R.shAfter.setup.linked === 2, R.shAfter);
check('stock on the shop straight after connect: 10 cushions, 4 lamps (5 less 1 reserved)', mock.state.inventory['gid://shopify/InventoryItem/2001|gid://shopify/Location/11'] === 10 && mock.state.inventory['gid://shopify/InventoryItem/2002|gid://shopify/Location/11'] === 4, mock.state.inventory);
check('TEN is on the till already', (await getDoc('pos/retail/discountCodes/BF_TEN')) !== null);
// setup again: nothing duplicated; a webhook that points at an old site address is pointed back
mock.state.webhooks[0].callbackUrl = 'https://old-site.example/.netlify/functions/pos-shopify?hook=1&e=BF';
R.setupMgr = await call('pos-shopify', { action: 'setup', entityId: 'BF' }); check('only the owner runs setup', R.setupMgr.status === 403, R.setupMgr);
R.setup2 = await call('pos-shopify', { action: 'setup', entityId: 'BF' }, own.idToken);
check('setup again (site remembered): still 3 webhooks, the moved one pointed back, none duplicated', R.setup2.ok && R.setup2.setup.webhooks === 3 && mock.state.webhooks.length === 3 && mock.state.webhooks.every(h => h.callbackUrl === HOOK_URL) && ops('hookUpdate').length === 1 && ops('hookCreate').length === 3 && R.setup2.setup.errors.length === 0, [R.setup2, mock.state.webhooks]);
R.stAfter = await call('pos-shopify', { action: 'status', entityId: 'BF' }); check('status carries the webhooks, the site, the setup outcome and the scopes to copy', R.stAfter.webhooks.length === 3 && R.stAfter.siteUrl === 'http://localhost:8788' && R.stAfter.setup.webhooks === 3 && /^read_products,write_inventory,.*write_customers$/.test(R.stAfter.scopes), R.stAfter);
R.set = await call('pos-shopify', { action: 'settings', entityId: 'BF', locationByStore: { 'BF-BELL': 'gid://shopify/Location/11' }, defaultStoreId: 'BF-BELL', pickupByTitle: { 'Collect at Bellville': 'BF-BELL' }, pushStock: true, pullOrders: true, syncCodes: true, syncCustomers: true }, own.idToken); check('store mapped to a location', R.set.ok && R.set.locationByStore['BF-BELL'] === 'gid://shopify/Location/11', R.set);

// ---- link by SKU (case-insensitive); content comes across; the unknown SKU is reported
R.link = await call('pos-shopify', { action: 'link', entityId: 'BF' });
check('2 of 3 shop variants linked, the rug and ZZ-9 unmatched', R.link.ok && R.link.linked === 2 && R.link.seen === 3 && R.link.unmatched.includes('ZZ-9'), R.link);
R.pc = await getDoc('pos/retail/products/p_cushion');
check('the cushion carries the Shopify ids, the shop’s title, description and picture', R.pc.shopifyVariantId === 'gid://shopify/ProductVariant/1001' && R.pc.shopifyInventoryItemId === 'gid://shopify/InventoryItem/2001' && R.pc.shopifyProductId === 'gid://shopify/Product/3001' && R.pc.name === 'Scatter Cushion — Linen' && R.pc.description === 'A soft linen cushion.' && R.pc.images[0] === 'https://cdn.example/cushion.jpg' && R.pc.contentFrom === 'shopify' && R.pc.priceCents === 19900, R.pc);
check('the lamp linked by its lower-case SKU', (await getDoc('pos/retail/products/p_lamp')).shopifyVariantId === 'gid://shopify/ProductVariant/1002');

// ---- stock: push all, then a sale pushes the new figure at once (available = on hand − reserved)
R.pushAll = await call('pos-shopify', { action: 'pushStock', entityId: 'BF' });
check('push all: 2 items queued and pushed', R.pushAll.ok && R.pushAll.queued === 2 && R.pushAll.pushed === 2 && mock.state.inventory['gid://shopify/InventoryItem/2001|gid://shopify/Location/11'] === 10 && mock.state.inventory['gid://shopify/InventoryItem/2002|gid://shopify/Location/11'] === 4, [R.pushAll, mock.state.inventory]);
R.sale = await call('pos-sale', { action: 'commit', saleId: 'web-sh-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_cushion', variantId: '', qty: 3, unitPriceCents: 19900, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 59700, vatCents: vatIn(59700, 1500) }, tenders: [{ method: 'card', amountCents: 59700 }], ...bell }, own.idToken);
check('a sale of 3 cushions pushed 7 to the shop at once', R.sale.ok && mock.state.inventory['gid://shopify/InventoryItem/2001|gid://shopify/Location/11'] === 7 && (await listColl('shopifyQueue')).length === 0, [R.sale.error, mock.state.inventory, (await listColl('shopifyQueue')).length]);
check('the stock pushes are logged', (await listColl('shopifySync')).filter(l => l.kind === 'stock' && l.status === 'ok').length >= 2);

// ---- an online order by webhook: a bad signature refused; a paid order deducts; an unpaid pickup reserves
const order = (id, o = {}) => ({ id, name: '#' + id, order_number: id, created_at: new Date().toISOString(), financial_status: 'paid', fulfillment_status: null, email: 'thandi@example.com', phone: '', currency: 'ZAR', total_price: '398.00', customer: { first_name: 'Thandi', last_name: 'Mokoena', email: 'thandi@example.com' }, shipping_address: { address1: '5 Lane', city: 'Parow', phone: '0825550101' }, shipping_lines: [{ title: 'Courier', code: 'courier' }], line_items: [{ id: 70001, variant_id: 1001, sku: 'CU-1', title: 'Scatter Cushion — Linen', quantity: 2, price: '199.00' }], ...o });
R.bad = await hook('orders/create', order(9001), 'nope'); check('a webhook with a bad signature is refused', R.bad.status === 401, R.bad);
R.o1 = await hook('orders/create', order(9001));
check('a paid courier order: 2 cushions deducted at Bellville, pushed to the shop as 5', R.o1.ok && R.o1.stock === 'deducted' && (await lvl('p_cushion')).onHandQty === 5 && mock.state.inventory['gid://shopify/InventoryItem/2001|gid://shopify/Location/11'] === 5, [R.o1, await lvl('p_cushion')]);
R.o1again = await hook('orders/create', order(9001)); check('the same order again changes nothing', R.o1again.again === true && (await lvl('p_cushion')).onHandQty === 5, R.o1again);
R.o2 = await hook('orders/create', order(9002, { financial_status: 'pending', shipping_lines: [{ title: 'Collect at Bellville', code: 'pickup' }], line_items: [{ id: 70002, variant_id: 1002, sku: 'LA-1', title: 'Lamp', quantity: 1, price: '500.00' }, { id: 70003, variant_id: 1003, sku: 'ZZ-9', title: 'Unknown thing', quantity: 1, price: '10.00' }], total_price: '510.00' }));
check('an unpaid click & collect order reserves the lamp; the unknown line is flagged', R.o2.ok && R.o2.stock === 'reserved' && R.o2.unmapped === 1 && (await lvl('p_lamp')).reservedQty === 2 && (await lvl('p_lamp')).onHandQty === 5 && mock.state.inventory['gid://shopify/InventoryItem/2002|gid://shopify/Location/11'] === 3, [R.o2, await lvl('p_lamp')]);
const oo = await listColl('onlineOrders'); const o2 = oo.find(o => o.orderNo === '#9002');
check('the order record: pickup, mapped store, new, the lines', o2 && o2.pickup === true && o2.storeId === 'BF-BELL' && o2.status === 'new' && o2.lines.length === 2 && o2.lines[0].itemId === 'p_lamp' && !o2.lines[1].itemId, o2);
R.list = await call('pos-shopify', { action: 'orders', ...bell }, sup.idToken); check('the store’s online orders, pickups first', R.list.ok && R.list.orders.length === 2 && R.list.orders[0].orderNo === '#9002', R.list.orders && R.list.orders.map(o => o.orderNo));
// click & collect: ready, then collected → fulfilled on Shopify
R.ready = await call('pos-shopify', { action: 'collect', orderId: o2.id, status: 'ready', ...bell }, sup.idToken); check('marked ready', R.ready.ok && R.ready.status === 'ready', R.ready);
R.coll = await call('pos-shopify', { action: 'collect', orderId: o2.id, status: 'collected', ...bell }, sup.idToken); check('collected and fulfilled on the shop', R.coll.ok && R.coll.status === 'collected' && /fulfilled on Shopify/.test(R.coll.fulfilled) && mock.state.fulfilled.length === 1, R.coll);
// a cancellation puts a paid order's stock back; a refund restocks a line
R.cancel = await hook('orders/cancelled', { id: 9001 }); check('cancelled: 2 cushions back (7), pushed', R.cancel.ok && (await lvl('p_cushion')).onHandQty === 7 && mock.state.inventory['gid://shopify/InventoryItem/2001|gid://shopify/Location/11'] === 7 && oo.length === 2, [R.cancel, await lvl('p_cushion')]);
R.o3 = await hook('orders/create', order(9003)); check('another paid order: 5', R.o3.ok && (await lvl('p_cushion')).onHandQty === 5);
R.refund = await hook('refunds/create', { id: 8001, order_id: 9003, refund_line_items: [{ id: 1, quantity: 1, restock_type: 'return', line_item_id: 70001, line_item: { id: 70001 } }] });
check('a refund restocks 1 cushion: 6', R.refund.ok && R.refund.restocked === 1 && (await lvl('p_cushion')).onHandQty === 6, [R.refund, await lvl('p_cushion')]);
R.refundAgain = await hook('refunds/create', { id: 8001, order_id: 9003, refund_line_items: [{ id: 1, quantity: 1, restock_type: 'return', line_item_id: 70001 }] }); check('the same refund again: nothing', R.refundAgain.again === true && (await lvl('p_cushion')).onHandQty === 6, R.refundAgain);
const moves = await listColl('stockMovements'); check('online movements on the record', moves.filter(m => m.reason === 'online').length === 4 && moves.filter(m => m.reason === 'onlineRefund').length === 1, moves.map(m => [m.reason, m.bucket, m.qty]));

// ---- discount codes pulled; one honoured on a sale without a PIN, not more than it gives; free shipping ignored
R.codes = await call('pos-shopify', { action: 'pullCodes', entityId: 'BF' }); check('2 code discounts pulled (free shipping skipped)', R.codes.ok && R.codes.codes === 2, R.codes);
const ten = await getDoc('pos/retail/discountCodes/BF_TEN'); check('TEN: 10% off, active', ten && ten.kind === 'percentage' && ten.value === 10 && ten.active === true, ten);
const saleWith = (code, disc) => ({ action: 'commit', saleId: 'web-dc-' + code + '-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_rug', variantId: '', qty: 1, unitPriceCents: 80000, discountCents: 0 }], saleDiscountCents: disc, saleDiscountCode: code, totals: { totalCents: 80000 - disc, vatCents: vatIn(80000 - disc, 1500) }, tenders: [{ method: 'card', amountCents: 80000 - disc }], ...bell });
R.dcSup = await call('pos-sale', saleWith('TEN', 8000), sup.idToken); check('a supervisor applies TEN (10% = R 80) with no PIN', R.dcSup.ok && R.dcSup.sale.saleDiscountCode === 'TEN' && R.dcSup.sale.saleDiscountCents === 8000, R.dcSup.error);
R.dcMore = await call('pos-sale', saleWith('TEN', 9000), sup.idToken); check('more than the code gives is refused', R.dcMore.status === 400 && /at most 80\.00/.test(R.dcMore.error), R.dcMore);
R.dcBad = await call('pos-sale', saleWith('NOPE', 1000), sup.idToken); check('an unknown code is refused', R.dcBad.status === 400 && /not valid/.test(R.dcBad.error), R.dcBad);
R.dcFifty = await call('pos-sale', saleWith('FIFTY', 5000), sup.idToken); check('FIFTY: R 50 off', R.dcFifty.ok && R.dcFifty.sale.saleDiscountCents === 5000, R.dcFifty.error);

// ---- consented customers pushed with their consent
R.cust = await call('pos-shopify', { action: 'pushCustomers', entityId: 'BF' });
check('Thandi pushed with email and SMS consent; the one without consent not', R.cust.ok && R.cust.pushed === 1 && R.cust.of === 1 && mock.state.customers.length === 1 && mock.state.customers[0].email === 'thandi@example.com' && mock.state.customers[0].emailMarketingConsent.marketingState === 'SUBSCRIBED' && mock.state.customers[0].smsMarketingConsent.marketingState === 'SUBSCRIBED' && mock.state.customers[0].phone === '+27825550101', [R.cust, mock.state.customers]);
check('the Shopify id kept', (await getDoc('pos/retail/customers/c1')).shopifyCustomerId === 'gid://shopify/Customer/900');
R.cust2 = await call('pos-shopify', { action: 'pushCustomers', entityId: 'BF', all: true }); check('pushing again updates rather than duplicates', R.cust2.ok && mock.state.customers.length === 1 && ops('customerUpdate').length === 1, R.cust2);

// ---- status, sync now, log
R.status = await call('pos-shopify', { action: 'status', entityId: 'BF' }); check('status: connected, 2 linked, codes, no queue', R.status.ok && R.status.connected && R.status.linked === 2 && R.status.codes.sort().join() === 'FIFTY,TEN' && R.status.queue.count === 0 && /pos-shopify\?hook=1&e=BF/.test(R.status.webhookUrl), R.status);
R.sync = await call('pos-shopify', { action: 'syncNow', entityId: 'BF' }); check('sync now runs everything', R.sync.ok && R.sync.codes === 2 && R.sync.customers && R.sync.stock, R.sync);
// ---- the shop's catalogue into the till (the cut-over): preview, then import with the shop's stock as opening stock
R.catMgr = await call('pos-shopify', { action: 'catalogue', entityId: 'BF' }); check('only the owner brings the catalogue in', R.catMgr.status === 403, R.catMgr);
R.cat = await call('pos-shopify', { action: 'catalogue', entityId: 'BF' }, own.idToken);
check('preview: 4 products, 1 already here (the cushion), 3 new, 4 variants, 1 archived; opening stock for the 2 hide sizes (10 units) at Bellville, the cushion skipped because it has stock here', R.cat.ok && R.cat.products === 4 && R.cat.updated === 1 && R.cat.created === 3 && R.cat.variants === 4 && R.cat.archived === 1 && R.cat.stock.items === 2 && R.cat.stock.qty === 10 && R.cat.stock.skipped === 1 && R.cat.stock.stores.join() === 'Bellville' && R.cat.sample.length === 4, R.cat);
R.catIn = await call('pos-shopify', { action: 'catalogueImport', entityId: 'BF', openingStock: true }, own.idToken);
check('imported: 3 new, 1 updated, 4 variants, opening stock for 2 items (10 units)', R.catIn.ok && R.catIn.created === 3 && R.catIn.updated === 1 && R.catIn.variants === 4 && R.catIn.stock.items === 2 && R.catIn.stock.qty === 10 && R.catIn.stock.skipped === 1, R.catIn);
const prods = await listColl('products'); const vars = await listColl('variants');
const hide = prods.find(p => p.shopifyProductId === 'gid://shopify/Product/3010'); const hideS = vars.find(v => v.shopifyVariantId === 'gid://shopify/ProductVariant/1101'); const hideM = vars.find(v => v.shopifyVariantId === 'gid://shopify/ProductVariant/1102');
check('the hide is a stock product with a Size option and two variants, linked, with the shop\'s prices, cost and barcode', hide && hide.hasVariants === true && hide.type === 'stock' && hide.trackStock === true && hide.category === 'Enclosures' && hide.brand === 'ReptiCube' && hide.options.length === 1 && hide.options[0].values.join() === 'Small,Medium' && hide.priceCents === 14900 && hide.costCents === 6000 && hideS && hideS.productId === hide.id && hideS.name === 'Small' && hideS.sku === 'HD-S' && hideS.priceCents === 14900 && hideS.costCents === 6000 && hideS.shopifyInventoryItemId === 'gid://shopify/InventoryItem/2101' && hideM && hideM.barcodes.join() === '6009876543210' && hideM.costCents === undefined && hideM.optionValues.Size === 'Medium', [hide, hideS, hideM]);
R.pcAfter = await getDoc('pos/retail/products/p_cushion');
check('the cushion was matched by Shopify id and updated: new price, barcode, cost, picture, still linked', R.pcAfter.priceCents === 21900 && R.pcAfter.costCents === 5500 && R.pcAfter.barcodes.join() === '6001234567890' && R.pcAfter.images[0] === 'https://cdn.example/cushion.jpg' && R.pcAfter.category === 'Cushions' && R.pcAfter.shopifyVariantId === 'gid://shopify/ProductVariant/1001' && prods.filter(p => p.sku === 'CU-1').length === 1, R.pcAfter);
const terr = prods.find(p => p.shopifyProductId === 'gid://shopify/Product/3011'); const gift = prods.find(p => p.shopifyProductId === 'gid://shopify/Product/3012');
check('the archived terrarium comes in archived; the gift card as a voucher with no stock tracking, zero-rated', terr && terr.archived === true && terr.sku === 'TR-OLD' && gift && gift.type === 'voucher' && gift.trackStock === false && gift.vatClass === 'zero' && gift.hasVariants === true && vars.filter(v => v.productId === gift.id).length === 2, [terr, gift]);
R.hideLvl = await getDoc('pos/retail/stockLevels/BF-BELL_' + hideS.id);
check('opening stock: 7 small hides at Bellville at R 60 average, by a movement that says so; the medium 3; nothing at Parow (not mapped)', R.hideLvl && R.hideLvl.onHandQty === 7 && R.hideLvl.avgCostCents === 6000 && (await getDoc('pos/retail/stockLevels/BF-BELL_' + hideM.id)).onHandQty === 3 && (await listColl('stockMovements')).filter(m => m.docType === 'import').length === 2 && (await listColl('stockMovements')).find(m => m.docType === 'import' && m.variantId === hideS.id).note === 'Opening stock from Shopify', [R.hideLvl, (await listColl('stockMovements')).filter(m => m.docType === 'import').map(m => [m.qty, m.reason, m.code, m.note])]);
check('the cushion\'s stock here was left alone (it had moved already)', (await lvl('p_cushion')).onHandQty === 6, await lvl('p_cushion'));
check('the opening figures were pushed to the shop too (the same number back)', mock.state.inventory['gid://shopify/InventoryItem/2101|gid://shopify/Location/11'] === 7, mock.state.inventory);
R.catAgain = await call('pos-shopify', { action: 'catalogueImport', entityId: 'BF', openingStock: true }, own.idToken);
check('importing again updates rather than duplicates, and takes no opening stock twice', R.catAgain.ok && R.catAgain.created === 0 && R.catAgain.updated === 4 && R.catAgain.stock.items === 0 && R.catAgain.stock.skipped === 3 && (await listColl('products')).length === prods.length && (await listColl('variants')).length === vars.length && (await getDoc('pos/retail/stockLevels/BF-BELL_' + hideS.id)).onHandQty === 7, [R.catAgain, (await listColl('products')).length, prods.length]);

R.log = await call('pos-shopify', { action: 'log', entityId: 'BF' }); check('the log has orders, stock, codes, customers and the link', R.log.ok && ['order', 'stock', 'codes', 'customers', 'link', 'cancel', 'refund'].every(k => R.log.log.some(l => l.kind === k)), R.log.log && R.log.log.map(l => l.kind + ':' + l.status));
R.disc = await call('pos-shopify', { action: 'disconnect', entityId: 'BF' }, own.idToken); check('disconnected: our webhooks removed from the app, the secret gone, a webhook refused', R.disc.ok && R.disc.webhooksRemoved === 3 && mock.state.webhooks.length === 0 && (await getDoc('pos/retail/shopifySecrets/BF')) === null && (await hook('orders/create', order(9009))).status === 401, [R.disc, mock.state.webhooks]);

console.log(JSON.stringify({ fails, ...R, log: undefined, list: undefined }, null, 1).slice(0, 10000));
console.log(fails.length ? fails.length + ' FAILED' : 'shopify-api: all passed');
await mock.close();
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
