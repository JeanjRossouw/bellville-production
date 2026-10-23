// Retail POS step 12: the pos-special function over HTTP. Opening needs
// the customer and a signed-off spec, takes made-to-order items only; a
// deposit under the minimum leaves it quoted, reaching it sends it to the
// factory: written into the linked Factory Manager company's own orders with
// the store as the customer and no retail customer data, the factory's
// status read back; the till's status step; updates logged; a delivery
// booking; the hand-over into a tax invoice paid by the order with the
// signed note; cancellation by a manager with no fee before production and
// the deposit after.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vatIn } from '../js/money.js';
import { startMockAnthropic } from './mock-anthropic.mjs';
const mock = await startMockAnthropic(8798);
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
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za'), sup = await mk('sam@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, specialOrder: { minDepositPct: 50, leadDays: 21 }, factory: { companyId: 'CPTEST', companyName: 'Couch Potato Test' }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', phone: '021 555 0100', address: { line1: '12 Voortrekker Rd', city: 'Bellville', code: '7530' }, active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
await put('companies/CPTEST', { name: 'Couch Potato Test', ownerUid: 'x', plan: 'free', status: 'free', createdAt: '2026-01-01T00:00:00.000Z' });
await put('companies/CPTEST/settings/factory', { name: 'Couch Potato Test', orderPrefix: 'CP-', firstOrderNo: 1001, leadDays: 21, vatRegistered: true });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: '', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, ...o, ...srv('BF') });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, priceCents: 1500000, costCents: 600000 });
await prod('p_cushion', { name: 'Scatter Cushion', priceCents: 19900, costCents: 5000 });
await put('pos/retail/customers/c1', { name: 'Thandi Mokoena', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = cas.idToken, headers = {}) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const listAt = async (p) => { const r = await (await fetch(`${docs}/${p}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const patchAt = (p, data) => fetch(`${docs}/${p}?` + Object.keys(data).map(k => 'updateMask.fieldPaths=' + k).join('&'), { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const FO = (id, n = 1) => 'companies/CPTEST/orders/pos-' + id + '-' + n;
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
let n = 0;
const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const photo = sig;
const spec = { size: '2.4 m', fabric: 'Linen look', colour: 'Charcoal', legs: 'Oak, tapered', notes: 'Firm seat', photo };
const sofa = (sp = spec) => [{ productId: 'p_sofa', variantId: '', qty: 1, unitPriceCents: 1500000, discountCents: 0, spec: sp }];
const openBody = (lines, total, deposit, o = {}) => ({ action: 'open', orderId: 'so-' + Date.now().toString(36) + '-' + (++n), clientCreatedAt: new Date().toISOString(), customerId: 'c1', lines, saleDiscountCents: 0, totals: { totalCents: total, vatCents: vatIn(total, 1500) }, deposit, signoff: { accepted: true, signedBy: 'T Mokoena', signature: sig }, ...bell, ...o });


await put('pos/retail/products/p_lamp', { name: 'Lamp', sku: 'LAMP', barcodes: [], category: 'Lighting', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 20000, priceCents: 50000, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, reorderLevel: 5, reorderQty: 10, ...srv('BF') });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 3, reservedQty: 0, onOrderQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/registers/BF-BELL-1', { entityId: 'BF', storeId: 'BF-BELL', name: 'Front till', active: true, currentShiftId: 'sh_x', ...srv('BF', 'BF-BELL') });
const in2 = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
await put('pos/retail/laybys/lb1', { docNo: 'BF-LB-000001', status: 'open', balanceCents: 69800, paidCents: 20000, dueAt: in2 + 'T00:00:00.000Z', openedAt: '2026-10-01T08:00:00.000Z', termDays: 60, schedule: [{ n: 1, dueAt: in2, amountCents: 23266 }], customerSnapshot: { name: 'Thandi Mokoena', phone: '0825550101' }, ...srv('BF', 'BF-BELL') });
await put('pos/retail/suppliers/s1', { name: 'Lamp Co', contact: 'Piet', phone: '021 555 0199', email: '', accountNo: '', termsDays: 30, leadDays: 5, notes: '', archived: false, ...srv('BF') });
await patchAt('pos/retail/products/p_lamp', { supplierId: 's1' });
// a sale today, so the figures have something in them
R.sale = await call('pos-sale', { action: 'commit', saleId: 'web-assist-' + Date.now().toString(36), clientCreatedAt: new Date().toISOString(), customerId: '', lines: [{ productId: 'p_lamp', variantId: '', qty: 1, unitPriceCents: 50000, discountCents: 0 }], saleDiscountCents: 0, totals: { totalCents: 50000, vatCents: vatIn(50000, 1500) }, tenders: [{ method: 'card', amountCents: 50000 }], ...bell }, own.idToken);
check('a sale today', R.sale.ok && R.sale.sale.docNo === 'BF-000001', R.sale.error);
// a custom order open, to be listed
R.so = await call('pos-special', openBody(sofa(), 1500000, [{ method: 'card', amountCents: 750000 }]));
check('a custom order at the factory', R.so.ok && R.so.order.status === 'depositPaid', R.so.error);

const ask = (q, token = cas.idToken, o = {}) => call('pos-assist', { action: 'ask', messages: [{ role: 'user', content: q }], screen: 'sell', ...bell, ...o }, token);
R.noLogin = await call('pos-assist', { action: 'ask', messages: [{ role: 'user', content: 'hi' }], ...bell }, ''); check('not signed in: 401', R.noLogin.status === 401, R.noLogin);
R.noStore = await ask('hi', cas.idToken, { storeId: 'BF-OTHER' }); check('not their store: 403', R.noStore.status === 403, R.noStore);
R.empty = await call('pos-assist', { action: 'ask', messages: [], ...bell }); check('nothing asked: 400', R.empty.status === 400, R.empty);

R.cas = await ask('What should I reorder?');
check('a cashier gets an answer, counted', R.cas.ok && /Mock answer to: What should I reorder\?/.test(R.cas.answer) && R.cas.used === 1 && R.cas.limit === 60, R.cas);
let L = mock.last();
const sys = () => (L.body.system || []).map(b => b.text).join('\n');
check('the model: opus 5.5, low effort, the fallback, the guide cached', L.body.model === 'claude-opus-5-5' && L.body.output_config.effort === 'low' && L.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(L.headers['anthropic-beta'] || '') && L.body.system[0].cache_control.type === 'ephemeral' && /# The retail POS/.test(L.body.system[0].text) && /Sales orders \(made to order, sold outright\)/.test(L.body.system[0].text), { model: L.body.model, oc: L.body.output_config, fb: L.body.fallbacks, beta: L.headers['anthropic-beta'] });
check('the live snapshot: the store, today, the register, the lay-by due, the order, low stock', /Store: Bellville \(Bellville Furniture\)/.test(sys()) && /talking to Cathy, cashier/.test(sys()) && /Today so far: 1 sale/.test(sys()) && /open now: Front till/.test(sys()) && /Open lay-bys: 1; 1 due within 7 days \(BF-LB-000001 Thandi Mokoena/.test(sys()) && /Custom orders open: 1 — BF-SO-000001 Thandi Mokoena: 1 × Custom Sofa, Deposit paid \(not sent to the factory: a supervisor sends it\)/.test(sys()) && /Low stock \(at or under the reorder point\): 1 — Lamp: 2 available, reorder at 5, suggest ordering 10/.test(sys()), sys().slice(-1200));
check('no money for a cashier', !/R \d/.test(sys().split('The store right now:')[1] || ''), (sys().split('The store right now:')[1] || '').slice(0, 600));
check('the tab open goes with the question', /^\(Tab open now: sell\)/.test(L.body.messages[0].content), L.body.messages[0].content);
R.use = await getDoc('pos/retail/assistantUse/' + cas.localId); check('the day\'s count kept, server only', R.use && R.use.count === 1 && R.use.name === 'Cathy', R.use);

R.sup = await ask('How is today going?', sup.idToken);
L = mock.last();
check('a supervisor sees the money', R.sup.ok && /Today so far: 1 sale, R 500\.00, average basket R 500\.00/.test(sys()) && /balance owed R 698\.00/.test(sys()) && /balance R 7,500\.00/.test(sys()), sys().slice(-1200));
R.chat = await call('pos-assist', { action: 'ask', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'And now?' }], screen: 'home', ...bell }, sup.idToken);
L = mock.last();
check('the chat history goes along, trimmed to turns', R.chat.ok && L.body.messages.length === 3 && L.body.messages[1].role === 'assistant' && /And now\?/.test(L.body.messages[2].content), L.body.messages);
R.cas2 = await ask('Again?'); check('counted on', R.cas2.used === 2, R.cas2);

const audit = await listColl('assistantUse'); check('one use row per login', audit.length === 2, audit.map(a => [a.name, a.count]));

// ---- the hands: low stock by supplier
const toolMsg = (L) => L.body.messages;
R.low = await ask('[tool:low_stock_by_supplier {}]', own.idToken);
L = mock.last();
check('the tool ran and its result reached the model', R.low.ok && /Mock answer after tools/.test(R.low.answer) && toolMsg(L).length === 3 && toolMsg(L)[1].content.some(b => b.type === 'tool_use') && /Lamp Co/.test(toolMsg(L)[2].content[0].content) && /"suggestQty":10/.test(toolMsg(L)[2].content[0].content) && R.low.cards.length === 0, { answer: R.low.answer.slice(0, 200), n: toolMsg(L).length });
check('the tools were sent, strict', Array.isArray(L.body.tools) && L.body.tools.length === 5 && L.body.tools.every(t => t.strict === true && t.input_schema.additionalProperties === false), L.body.tools && L.body.tools.map(t => t.name));
// ---- a purchase order: proposed, confirmed into a draft, by a manager only
const poCall = '[tool:propose_purchase_orders {"orders":[{"supplierId":"s1","lines":[{"itemId":"p_lamp","qty":10}]}],"note":"for the weekend"}]';
R.poCas = await ask(poCall); L = mock.last();
check('a cashier may not propose orders: the tool says so, the answer still comes', R.poCas.ok && R.poCas.cards.length === 0 && toolMsg(L)[2].content[0].is_error === true && /Only a manager/.test(toolMsg(L)[2].content[0].content), R.poCas);
R.po = await ask(poCall, own.idToken);
check('the owner gets a proposal card, nothing created yet', R.po.ok && R.po.cards.length === 1 && R.po.cards[0].type === 'proposal' && R.po.cards[0].kind === 'purchaseOrders' && /Lamp Co: 1 line, 10 units, R 2,000\.00 ex VAT/.test(R.po.cards[0].lines[0]) && (await listColl('purchaseOrders')).length === 0, R.po.cards);
R.confirmCas = await call('pos-assist', { action: 'confirm', proposalId: R.po.cards[0].id, ...bell }); check('someone else cannot confirm it', R.confirmCas.status === 404, R.confirmCas);
R.confirm = await call('pos-assist', { action: 'confirm', proposalId: R.po.cards[0].id, ...bell }, own.idToken);
check('confirmed: a draft purchase order under Buying', R.confirm.ok && R.confirm.kind === 'purchaseOrders' && R.confirm.made.length === 1 && /draft purchase order created under Buying/.test(R.confirm.message), R.confirm);
const pos = await listColl('purchaseOrders');
check('the draft as the Buying tab makes it, stamped with the owner, noted as suggested', pos.length === 1 && pos[0].status === 'draft' && pos[0].supplierName === 'Lamp Co' && pos[0].lines[0].name === 'Lamp' && pos[0].lines[0].qty === 10 && pos[0].lines[0].unitCostCents === 20000 && pos[0].subtotalCents === 200000 && pos[0].createdBy === own.localId && /Suggested by the assistant/.test(pos[0].note) && /for the weekend/.test(pos[0].note) && pos[0].expectedAt, pos[0]);
R.confirmAgain = await call('pos-assist', { action: 'confirm', proposalId: R.po.cards[0].id, ...bell }, own.idToken); check('a proposal is good once', R.confirmAgain.status === 409, R.confirmAgain);
// ---- the customers to message, with the words written
R.who = await ask('[tool:customers_to_contact {}]');
check('the card lists the custom order and the lay-by due, each with its message and how to send it', R.who.ok && R.who.cards.length === 1 && R.who.cards[0].type === 'updates' && R.who.cards[0].items.some(x => x.kind === 'customOrder' && x.docNo === 'BF-SO-000001' && /Thank you for your deposit/.test(x.text) && x.send.api === 'special' && x.send.body.orderId) && R.who.cards[0].items.some(x => x.kind === 'layby' && x.docNo === 'BF-LB-000001' && /instalment of R 232\.66/.test(x.text) && x.send.action === 'remind' && x.send.body.kind === 'due'), R.who.cards[0] && R.who.cards[0].items.map(x => [x.kind, x.docNo, x.why]));
R.sendLb = await call('pos-layby', { action: 'remind', laybyId: 'lb1', kind: 'due', how: 'whatsapp', ...bell }); check('the lay-by reminder goes from a till with no shift', R.sendLb.ok && R.sendLb.phone === '0825550101', R.sendLb);
// ---- tasks: proposed and confirmed; by hand
R.tk = await ask('[tool:propose_tasks {"tasks":[{"title":"Call Thandi about BF-SO-000001","note":"deposit paid","due":"2026-10-24","assigneeName":"Cathy"},{"title":"Count the lamps","note":"","due":"","assigneeName":"Nobody Known"}]}]');
check('a task proposal card', R.tk.ok && R.tk.cards.length === 1 && R.tk.cards[0].kind === 'tasks' && R.tk.cards[0].lines.length === 2 && /Call Thandi about BF-SO-000001 · by 2026-10-24 · Cathy/.test(R.tk.cards[0].lines[0]), R.tk.cards);
R.tkConfirm = await call('pos-assist', { action: 'confirm', proposalId: R.tk.cards[0].id, ...bell });
let tasks = await listColl('tasks');
check('confirmed: two tasks on the store, the assignee matched by name, the other kept as typed', R.tkConfirm.ok && tasks.length === 2 && tasks.some(t => t.title === 'Call Thandi about BF-SO-000001' && t.assigneeUid === cas.localId && t.assigneeName === 'Cathy' && t.due === '2026-10-24' && t.source === 'assistant' && t.status === 'open' && t.createdBy === cas.localId) && tasks.some(t => t.title === 'Count the lamps' && t.assigneeUid === '' && t.assigneeName === 'Nobody Known'), tasks);
R.list = await ask('[tool:list_tasks {}]'); L = mock.last(); check('the open tasks are listed to the model', /Call Thandi/.test(toolMsg(L)[2].content[0].content) && /"open":2/.test(toolMsg(L)[2].content[0].content), toolMsg(L)[2].content[0].content.slice(0, 300));
R.add = await call('pos-tasks', { action: 'add', title: 'Dust the lamps', due: '2026-10-25', assigneeUid: cas.localId, note: '', ...bell }, own.idToken); check('a task by hand', R.add.ok && R.add.task.assigneeName === 'Cathy' && R.add.task.source === 'person', R.add);
R.noTitle = await call('pos-tasks', { action: 'add', title: '', ...bell }); check('a task needs a title', R.noTitle.status === 400, R.noTitle);
R.done = await call('pos-tasks', { action: 'done', taskId: R.add.task.id, ...bell }); check('ticked by Cathy', R.done.ok && R.done.task.status === 'done' && R.done.task.doneBy === 'Cathy', R.done);
R.reopen = await call('pos-tasks', { action: 'reopen', taskId: R.add.task.id, ...bell }); check('reopened', R.reopen.ok && R.reopen.task.status === 'open', R.reopen);
const au = await listColl('auditLog'); check('audited: the orders and tasks via the assistant, the task by hand', ['assistant.purchaseOrders', 'assistant.tasks', 'task.add', 'task.done', 'task.reopen', 'layby.remind'].every(a => au.some(x => x.action === a)), au.map(a => a.action));
console.log(JSON.stringify({ fails, ...R }, null, 1).slice(0, 6000));
console.log(fails.length ? fails.length + ' FAILED' : 'assist-api: all passed');
await mock.close();
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
