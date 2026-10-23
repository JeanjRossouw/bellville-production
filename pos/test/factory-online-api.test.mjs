// Factory Manager: online shop orders wait for a person. Against the
// Firestore emulator, straight through netlify/functions/factory-shopify.mjs.
// With the owner's setting unset (every shop connected before this) or
// 'manual', a Shopify order is held in shopifyOrders as 'waiting' and makes
// no factory orders; paid later, it is noted; the list shows it to who sees
// orders; a person sends only the ticked lines (one factory order each, never
// twice), or keeps the order off the factory and can undo that; a cancelled
// order cannot be sent; a role that only views orders cannot send. With
// sendToFactory 'auto' an order still goes by itself, as before.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.FACTORY_SERVICE_ACCOUNT = process.env.FACTORY_SERVICE_ACCOUNT || JSON.stringify({ project_id: 'factory-manager-ece82', client_email: 'emulator@test', private_key: '' });
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085';
const { importOrder, onlineList, sendOnline, keepOnline } = await import('../../netlify/functions/factory-shopify.mjs');
const { getDoc, patchDoc, query } = await import('../../netlify/functions/lib/factory-firestore.mjs');
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
const tryErr = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });

const CID = 'REPTI';
await patchDoc(`companies/${CID}`, { name: 'ReptiCube', ownerUid: 'u_owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' });
await patchDoc(`companies/${CID}/settings/factory`, { name: 'ReptiCube', orderPrefix: 'RC-', firstOrderNo: 501, leadDays: 14, vatRegistered: true });
await patchDoc(`companies/${CID}/roles/floor`, { perms: { orders: 'view' } });
await patchDoc(`companies/${CID}/roles/office`, { perms: { orders: 'edit' } });
// connected before this change: importWhen 'paid' stored, no sendToFactory
await patchDoc(`companies/${CID}/integrations/shopify`, { connected: true, domain: 'repticube.myshopify.com', importWhen: 'paid', ordersIn: 0 });
const status = () => getDoc(`companies/${CID}/integrations/shopify`);
const owner = { owner: true, cid: CID, user: { email: 'jean@repticube.co.za' }, member: { role: 'owner', name: 'Jean' }, company: { status: 'active' } };
const office = { owner: false, cid: CID, user: { email: 'office@repticube.co.za' }, member: { role: 'office', name: 'Office' }, company: { status: 'active' } };
const floor = { owner: false, cid: CID, user: { email: 'floor@repticube.co.za' }, member: { role: 'floor', name: 'Floor' }, company: { status: 'active' } };
const factoryOrders = async () => (await query(`companies/${CID}`, 'orders', {}, 500));

const order = (n, o = {}) => ({
  id: 9000000 + n, name: '#' + n, order_number: n, created_at: '2026-10-23T08:00:00Z', financial_status: 'paid', taxes_included: true, currency: 'ZAR', total_price: '4150.00',
  email: 'thandi@example.com', customer: { id: 77001, first_name: 'Thandi', last_name: 'Mokoena', phone: '082 555 0101' },
  shipping_address: { name: 'Thandi Mokoena', address1: '5 Lane', city: 'Parow', phone: '082 555 0101' },
  line_items: [
    { id: n * 10 + 1, product_id: 1, variant_id: 11, title: 'Custom Enclosure 1200', variant_title: 'Oak', quantity: 1, price: '3500.00', sku: 'EN-1200', taxable: true, tax_lines: [], requires_shipping: true },
    { id: n * 10 + 2, product_id: 2, variant_id: 22, title: 'UVB Light', variant_title: '', quantity: 2, price: '325.00', sku: 'LT-UVB', taxable: true, tax_lines: [], requires_shipping: true }
  ], ...o
});

// ---- not chosen (a shop connected before): the order waits, nothing made
R.h1 = await importOrder(CID, order(1001, { financial_status: 'pending' }), { status: await status() });
R.m1 = await getDoc(`companies/${CID}/shopifyOrders/${9001001}`);
check('an unpaid order waits, with its lines, customer and total, and makes no factory order', R.h1 && R.h1.waiting && R.m1.status === 'waiting' && R.m1.paid === false && R.m1.lines.length === 2 && R.m1.lines[1].title === 'UVB Light' && R.m1.lines[1].qty === 2 && R.m1.customer.name === 'Thandi Mokoena' && R.m1.total === '4150.00' && (await factoryOrders()).length === 0, [R.h1, R.m1]);
check('the waiting count goes up', (await status()).waiting === 1, await status());
R.h1b = await importOrder(CID, order(1001), { status: await status() });
check('the same order paid: noted, still waiting, still nothing made', !R.h1b && (await getDoc(`companies/${CID}/shopifyOrders/${9001001}`)).paid === true && (await getDoc(`companies/${CID}/shopifyOrders/${9001001}`)).status === 'waiting' && (await factoryOrders()).length === 0);

// ---- the list
R.list = await onlineList(office);
check('the list: one waiting, the raw order not sent to the browser', R.list.waiting.length === 1 && R.list.waiting[0].id === '9001001' && !('order' in R.list.waiting[0]), R.list);
check('a role that views orders sees the list', (await onlineList(floor)).waiting.length === 1);
R.floorSend = await tryErr(() => sendOnline(floor, { orderId: '9001001', lines: ['10011'] }));
check('a role that only views orders cannot send', /cannot add orders/.test(R.floorSend), R.floorSend);
R.none = await tryErr(() => sendOnline(office, { orderId: '9001001', lines: [] }));
check('nothing ticked: refused', /Tick the lines/.test(R.none), R.none);

// ---- send only the enclosure; the light stays off the factory
R.send = await sendOnline(office, { orderId: '9001001', lines: ['10011'] });
const fo = await factoryOrders();
check('only the ticked line became a factory order, numbered from the company', R.send.ok && R.send.orders.length === 1 && R.send.orders[0] === 'RC-501' && fo.length === 1 && /Enclosure/.test(fo[0].product || fo[0].description || ''), [R.send, fo]);
R.m1s = await getDoc(`companies/${CID}/shopifyOrders/${9001001}`);
check('the order is marked sent, by whom, with the line and the factory number', R.m1s.status === 'sent' && R.m1s.sentBy === 'Office' && R.m1s.sentLines.join() === '10011' && R.m1s.orderNos.join() === 'RC-501' && (await status()).waiting === 0, R.m1s);
R.again = await tryErr(() => sendOnline(office, { orderId: '9001001', lines: ['10011'] }));
check('the same line again: nothing made twice', /Tick the lines/.test(R.again) && (await factoryOrders()).length === 1, R.again);
check('the customer added once, as a factory customer', (await query(`companies/${CID}`, 'customers', {}, 50)).filter(c => c.source === 'shopify').length === 1);

// ---- a second order: not for the factory, then undo, then cancelled on the shop
await importOrder(CID, order(1002), { status: await status() });
R.keep = await keepOnline(office, { orderId: '9001002', note: 'Lights from the supplier' });
R.m2 = await getDoc(`companies/${CID}/shopifyOrders/${9001002}`);
check('kept off the factory: by whom, why, nothing made', R.keep.status === 'kept' && R.m2.status === 'kept' && R.m2.keptBy === 'Office' && R.m2.keptNote === 'Lights from the supplier' && (await factoryOrders()).length === 1, R.m2);
check('the list shows it under dealt with', (await onlineList(owner)).recent.some(r => r.id === '9001002' && r.status === 'kept'));
R.undo = await keepOnline(office, { orderId: '9001002', undo: true });
check('undo: back to waiting', R.undo.status === 'waiting' && (await getDoc(`companies/${CID}/shopifyOrders/${9001002}`)).status === 'waiting');
await importOrder(CID, order(1002, { cancelled_at: '2026-10-23T09:00:00Z' }), { status: await status() });
R.cancelSend = await tryErr(() => sendOnline(office, { orderId: '9001002', lines: ['10021'] }));
check('cancelled on the shop: it cannot be sent', (await getDoc(`companies/${CID}/shopifyOrders/${9001002}`)).status === 'cancelled' && /cancelled/.test(R.cancelSend), R.cancelSend);

// ---- the owner chose 'auto': the old way, every line by itself (but never what a person kept off, or the shop cancelled)
await importOrder(CID, order(1004), { status: await status() });
await keepOnline(office, { orderId: '9001004', note: 'From the shelf' });
await patchDoc(`companies/${CID}/integrations/shopify`, { sendToFactory: 'auto' });
R.auto = await importOrder(CID, order(1003), { status: await status() });
check('auto: both lines made at once', R.auto && R.auto.orders.length === 2 && (await factoryOrders()).length === 3 && (await getDoc(`companies/${CID}/shopifyOrders/${9001003}`)).status === 'sent', R.auto);
R.autoKept = await importOrder(CID, order(1004), { status: await status() });
R.autoCancelled = await importOrder(CID, order(1002, { cancelled_at: null }), { status: await status() });
check('auto: a kept order and a cancelled one are never sent by themselves', !R.autoKept && !R.autoCancelled && (await factoryOrders()).length === 3 && (await getDoc(`companies/${CID}/shopifyOrders/${9001004}`)).status === 'kept', [R.autoKept, R.autoCancelled, (await factoryOrders()).length]);

console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 4000));
console.log(fails.length ? fails.length + ' FAILED' : 'factory-online-api: all passed');
process.exit(fails.length ? 1 : 0);
