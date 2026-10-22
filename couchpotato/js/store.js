// Data layer — one app, many companies.
//
// RULE ONE: every record is its own document, and a save sends ONLY the
// fields that changed. The older Bellville system kept every order inside a
// single document, so each save rewrote the whole lot and a stale device could
// erase someone else's orders. Per-document writes make that impossible.
//
// RULE TWO: every record belongs to exactly one company. Records live at
// companies/<companyId>/<collection>/<id>, and the database rules
// (firestore.rules) only let members of that company read or write them. No
// other module touches the database directly — they all come through here,
// and this file always works inside the signed-in user's company.
//
//   users/<uid>                  → which company this login belongs to
//   companies/<id>               → name, owner, plan, created
//   companies/<id>/members/<uid> → role in that company (what the rules check)
//   companies/<id>/invites/<email> + invites/<email> → a pending invitation
//   companies/<id>/<anything>    → orders, customers, products, invoices…
//
// One interface, two backends:
//   cloud — Firebase/Firestore, used as soon as config.js has a project id
//   demo  — this browser's localStorage, so the system can be reviewed and
//           demonstrated before any database is created
import { FIREBASE_CONFIG, isCloudConfigured, TRIAL_DAYS } from './config.js';
import { DEFAULT_ROLES, WRITE_AREAS, OWNER_PERMS, canSee, canEdit } from './permissions.js';
import { wantOrder, orderLines, orderDocId, customerOf, findCustomer, mapLine, mapProduct } from './shopify-map.js';

const FB_VERSION = '10.13.0';
const FB = (m) => `https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-${m}.js`;

let mode = 'demo';
let cloud = null;          // { auth, db, fns }
let currentUser = null;    // { uid, email, name, role, companyId }
let company = null;        // { id, name, ownerUid, plan, createdAt }
let pendingSignup = null;  // { companyName, name } between creating the login and the company
const userWatchers = [];

export const storeMode = () => mode;
export const getUser = () => currentUser;
export const getCompany = () => company;
export const nowIso = () => new Date().toISOString();
// ------------------------------------------------------------------ roles ---
//
// The owner designs the roles (Settings → Roles): each one says, per screen,
// hidden, view or edit. They live at companies/<id>/roles/<key>; a member's
// role is one of those keys, or 'owner'.
let roles = {};               // key -> { name, perms, clientMode, clientGroups }
const roleWatchers = [];
export function roleList() {
  return [{ key: 'owner', label: 'Owner', perms: OWNER_PERMS, fixed: true }]
    .concat(Object.keys(roles).map(k => ({ key: k, label: roles[k].name || k, perms: roles[k].perms || {}, clientMode: roles[k].clientMode || 'all', clientGroups: roles[k].clientGroups || [] }))
      .sort((a, b) => a.label.localeCompare(b.label)));
}
export const roleLabel = (key) => key === 'owner' ? 'Owner' : ((roles[key] && roles[key].name) || key);
export function myPerms() {
  if (!currentUser) return {};
  if (currentUser.role === 'owner') return OWNER_PERMS;
  return (roles[currentUser.role] && roles[currentUser.role].perms) || {};
}
export const can = (area, level) => level === 'edit' ? canEdit(myPerms(), area) : canSee(myPerms(), area);
// Which clients this person sees by name: { mode: 'all' } or
// { mode: 'groups', groups: [...] } (see clientgroups.js).
export function myClientRule() {
  if (!currentUser || currentUser.role === 'owner') return { mode: 'all', groups: [] };
  const r = roles[currentUser.role] || {};
  return r.clientMode === 'groups' ? { mode: 'groups', groups: r.clientGroups || [] } : { mode: 'all', groups: [] };
}

// Live: an owner's change to a role reaches everyone with it at once.
export function watchRoles(cb) {
  roleWatchers.push(cb);
  let first = true;
  return watch('roles', rows => {
    roles = {};
    rows.forEach(r => { roles[r.id] = { name: r.name, perms: r.perms || {}, clientMode: r.clientMode || 'all', clientGroups: r.clientGroups || [] }; });
    // a company from before roles existed gets the starting set, once
    if (first && !rows.length && currentUser && currentUser.role === 'owner') { first = false; seedRoles(); return; }
    first = false;
    roleWatchers.forEach(w => { try { w(roles); } catch (e) { console.error(e); } });
  });
}
// a starting role as saved: its name, screens and which clients it sees
const roleSeed = (r) => ({ name: r.name, perms: r.perms, ...(r.clientMode ? { clientMode: r.clientMode, clientGroups: r.clientGroups || [] } : {}) });
async function seedRoles() {
  for (const [key, r] of Object.entries(DEFAULT_ROLES)) await setWithId('roles', key, roleSeed(r));
}
// A signed delivery note (a picture) for an order, saved under the order's id.
export async function saveDeliveryNote(orderId, note) { await setWithId('deliveryNotes', orderId, note); }

export async function saveRole(key, patch) { await update('roles', key, patch); }
export async function createRole(name) {
  const key = 'r' + Date.now().toString(36);
  await setWithId('roles', key, { name: String(name || '').trim() || 'New role', perms: {} });
  return key;
}
export async function deleteRole(key) { await remove('roles', key); }
const lower = (e) => String(e || '').trim().toLowerCase();

// ------------------------------------------------------------- paying ------
//
// A company may add and change records while its trial runs, while it is paid
// up, or when the seller has given it free access. Otherwise it is read only.
// The database rules enforce exactly this; the app mirrors it so people see
// why, instead of a failed save.

export function trialEndsAt() {
  if (!company) return null;
  if (company.trialEndsAt) return Date.parse(company.trialEndsAt);
  const start = Date.parse(company.createdAt || '') || Date.now();
  return start + TRIAL_DAYS * 86400000;
}

// Days left on the free trial (null when not on a trial).
export function trialDaysLeft() {
  if (!company || company.status !== 'trial') return null;
  return Math.max(0, Math.ceil((trialEndsAt() - Date.now()) / 86400000));
}

// 'ok' | 'trial-ended' | 'unpaid' | 'ended'
export function accessState() {
  if (!company) return 'ok';
  const now = Date.now();
  if (company.status === 'free') return 'ok';
  if (company.status === 'trial' && now < trialEndsAt()) return 'ok';
  if (company.paidUntil && now < Date.parse(company.paidUntil)) return 'ok';
  if (company.status === 'trial') return 'trial-ended';
  return company.status === 'cancelled' ? 'ended' : 'unpaid';
}

const LOCK_FREE = ['settings', 'members', 'invites'];
function guardWrite(coll) {
  // the team and the roles are the owner's alone
  if (['members', 'invites', 'roles'].includes(coll)) {
    if (currentUser && currentUser.role === 'owner') return;
    throw Object.assign(new Error('Only the owner can change the team and the roles.'), { code: 'role' });
  }
  // the role must allow it (the database rules check the same)
  const areas = WRITE_AREAS[coll];
  if (areas && !areas.some(a => can(a, 'edit'))) {
    throw Object.assign(new Error('Your role can only look at this, not change it. Ask the owner if you need to.'), { code: 'role' });
  }
  if (LOCK_FREE.includes(coll) || accessState() === 'ok') return;
  throw Object.assign(new Error('Read only: the subscription is not active. The owner can subscribe under Settings → Billing.'), { code: 'subscription' });
}

const companyWatchers = [];
// Live company record: a payment, a cancellation or the seller extending a
// trial shows up without signing in again.
export function watchCompany(cb) {
  companyWatchers.push(cb);
  if (mode === 'demo' || !currentUser || !currentUser.companyId) { cb(company); return () => {}; }
  return cloud.fns.onSnapshot(cloud.fns.doc(cloud.db, 'companies', currentUser.companyId), (snap) => {
    if (!snap.exists()) return;
    company = { id: snap.id, ...normCompany(snap.data()) };
    companyWatchers.forEach(w => { try { w(company); } catch (e) { console.error(e); } });
  }, (err) => console.error('watchCompany failed:', err));
}
function emitCompany() { companyWatchers.forEach(w => { try { w(company); } catch (e) { console.error(e); } }); }

const BILLING_URL = '/.netlify/functions/factory-billing';
const DEMO_PLAN = { id: 'standard', name: 'Standard', amount: 2999, currency: 'ZAR', interval: 'month', includes: 'Every feature, unlimited users and orders' };

export async function getPlan() {
  if (mode === 'demo') return { plan: DEMO_PLAN, configured: true, demo: true };
  try {
    const r = await fetch(BILLING_URL + '?plan=1');
    if (r.ok) return await r.json();
  } catch (e) { /* offline */ }
  return { plan: DEMO_PLAN, configured: false };
}

// checkout → { action, fields } to post to PayFast; cancel → { ok }
export async function billingCall(action) {
  if (mode === 'demo') return demoBilling(action);
  const token = await cloud.auth.currentUser.getIdToken();
  const r = await fetch(BILLING_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// In demo mode paying is simulated, so the whole flow can be shown.
function demoBilling(action) {
  const all = demoCompanies();
  const c = all[company.id] || {};
  const now = new Date();
  if (action === 'checkout') {
    const base = c.paidUntil && Date.parse(c.paidUntil) > now.getTime() ? new Date(Date.parse(c.paidUntil) - 5 * 86400000) : now;
    const next = new Date(base); next.setMonth(next.getMonth() + 1);
    Object.assign(c, { status: 'active', plan: 'standard', paidUntil: new Date(next.getTime() + 5 * 86400000).toISOString(), lastPaymentAt: now.toISOString(), lastPaymentAmount: DEMO_PLAN.amount, payfastToken: 'demo-token' });
    const pays = demoRead('payments'); pays['demo' + now.getTime()] = { at: now.toISOString(), status: 'COMPLETE', amount: DEMO_PLAN.amount, fee: 0, reference: 'DEMO', item: 'Standard (monthly)' }; demoWrite('payments', pays);
  } else if (action === 'cancel') {
    Object.assign(c, { status: 'cancelled', cancelledAt: now.toISOString() });
  }
  all[company.id] = c; localStorage.setItem('cp-demo-companies', JSON.stringify(all));
  company = { id: company.id, ...c };
  emitCompany();
  return { demo: true, ok: true };
}

// ---- the online shop (Shopify) ----
// The keys never come to the browser: connecting, bringing products and
// orders in, and sending stock out all happen on the server
// (netlify/functions/factory-shopify.mjs). The status shows in Settings.

const SHOPIFY_URL = '/.netlify/functions/factory-shopify';

// The help assistant (netlify/functions/factory-assistant.mjs). Each question
// costs money, so only a signed-in login may ask; the demo has no login.
const ASSISTANT_URL = '/.netlify/functions/factory-assistant';
export async function askAssistant(messages, screen) {
  if (mode === 'demo') return { answer: 'The help assistant answers in the live app, once you are signed in. (It is not part of the demo, because every question is sent to the AI service.)' };
  const token = await cloud.auth.currentUser.getIdToken();
  const r = await fetch(ASSISTANT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ messages, screen, role: (currentUser || {}).role || '' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('The assistant could not answer (' + r.status + ')'));
  return j;
}

export async function shopifyCall(action, payload) {
  if (mode === 'demo') return demoShopify(action, payload || {});
  const token = await cloud.auth.currentUser.getIdToken();
  const r = await fetch(SHOPIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, ...(payload || {}) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ---- accounting (Xero) ----
// Each company connects its own Xero (netlify/functions/factory-xero.mjs); a
// till sale paid in full goes there as a paid invoice, through the same
// pending queue as the shop's pushes, so an outage never loses one.
const XERO_URL = '/.netlify/functions/factory-xero';
export async function xeroCall(action, payload) {
  if (mode === 'demo') return demoXero(action, payload || {});
  const token = await cloud.auth.currentUser.getIdToken();
  const r = await fetch(XERO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, ...(payload || {}) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function demoXero(action, p) {
  const ints = demoRead('integrations'); const st = ints.xero || {};
  const save = (patch) => { ints.xero = { ...st, ...patch }; demoWrite('integrations', ints); return ints.xero; };
  if (action === 'status') return { connected: !!st.connected, tenantName: st.tenantName || '', bankAccount: st.bankAccount || '', revenueAccount: st.revenueAccount || '200', taxType: st.taxType || '', lastError: '', ready: true };
  if (action === 'connectUrl') { save({ connected: true, tenantName: 'Demo Organisation', connectedAt: nowIso() }); return { url: '', demo: true }; }
  if (action === 'settings') { save({ bankAccount: p.bankAccount || '', revenueAccount: p.revenueAccount || '200', taxType: p.taxType || '', autoPush: p.autoPush !== false }); return { ok: true }; }
  if (action === 'disconnect') { save({ connected: false, tenantName: '' }); return { ok: true }; }
  if (action === 'pushSale') {
    if (!st.connected) return { ok: true, skipped: 'not connected' };
    if (!st.bankAccount) return { ok: true, skipped: 'no bank account code in the Xero settings' };
    const m = demoRead('sales'); const sale = m[p.saleId]; if (!sale) throw new Error('Sale not found');
    if (Number(sale.balance) > 0.005) return { ok: true, skipped: 'not paid in full yet' };
    if (sale.xeroInvoiceId) return { ok: true, already: true, invoice: sale.xeroInvoiceNumber };
    sale.xeroInvoiceId = 'demo-' + p.saleId; sale.xeroInvoiceNumber = 'INV-X' + String(Object.keys(m).length).padStart(4, '0'); sale.xeroAt = nowIso(); demoWrite('sales', m);
    save({ lastPushAt: nowIso() });
    return { ok: true, invoice: sale.xeroInvoiceNumber };
  }
  throw new Error('Unknown action');
}
export function xeroPushSale(saleId) {
  shopifyRetryPending();
  pushOne('xero|' + saleId);
}

// A till sale took pieces off the shelf: Shopify takes the same off its
// count. Quietly, in the background. If it cannot get through (offline, a
// hiccup), the sale waits on this device and is sent again with the next sale
// or the next time the app opens; the server sends each sale once only.
// Shopify refusing a line shows in Settings.
const PUSH_KEY = 'cp-shopify-pending';
const pendingPushes = () => { try { return JSON.parse(localStorage.getItem(PUSH_KEY) || '[]'); } catch (e) { return []; } };
const savePending = (a) => { try { localStorage.setItem(PUSH_KEY, JSON.stringify(a.slice(-200))); } catch (e) { /* storage off */ } };
// key: a sale id, or 'ret|<sale id>|<return no>' for pieces brought back
async function pushOne(key) {
  const ret = String(key).split('|');
  try {
    if (ret[0] === 'ret') await shopifyCall('pushReturn', { saleId: ret[1], returnNo: ret[2] });
    else if (ret[0] === 'paid') await shopifyCall('markPaid', { saleId: ret[1] });
    else if (ret[0] === 'xero') await xeroCall('pushSale', { saleId: ret[1] });
    else await shopifyCall('pushSale', { saleId: key });
    savePending(pendingPushes().filter(x => x !== key));
  } catch (e) {
    console.warn((ret[0] === 'xero' ? 'Xero' : 'Shopify') + ' not reached yet:', e.message);
    if (!/not found|Which sale|Which return/i.test(e.message)) { const p = pendingPushes(); if (!p.includes(key)) savePending(p.concat(key)); }
    else savePending(pendingPushes().filter(x => x !== key));
  }
}
export function shopifyPushSale(saleId, lines) {
  shopifyRetryPending();
  if ((lines || []).some(l => l.kind === 'stock' && (l.productId || l.variantId))) pushOne(saleId);
}
// An account sale settled: its Shopify order is marked paid.
export function shopifyMarkPaid(saleId) {
  shopifyRetryPending();
  pushOne('paid|' + saleId);
}
// Pieces brought back to the shelf at the till: Shopify adds them back.
export function shopifyPushReturn(saleId, returnNo) {
  shopifyRetryPending();
  pushOne('ret|' + saleId + '|' + returnNo);
}
// how many till sales / returns are still waiting to reach Shopify on this device
export const shopifyPendingCount = () => pendingPushes().length;
export function shopifyRetryPending() {
  if (mode === 'demo') return;
  pendingPushes().forEach(id => pushOne(id));
}

// In demo mode there is no real shop: a made-up one shows the whole flow,
// using the same rules as the server for what an online order becomes.
const DEMO_SHOP = [
  { title: '3 Seater Chesterfield', price: 18999, tracked: false, qoh: 0, category: 'Couches', collections: ['Lounge', 'Own make'], vendor: 'Own make' },
  { title: 'Wingback Chair', price: 7499, tracked: false, qoh: 0, category: 'Chairs', collections: ['Lounge', 'Own make'], vendor: 'Own make' },
  { title: 'Linen Scatter Cushion 50cm', price: 449, tracked: true, qoh: 24, category: 'Accessories', collections: ['Accessories'], vendor: 'Cushion Co' },
  { title: 'Oak Side Table', price: 2899, tracked: true, qoh: 6, category: 'Tables', collections: ['Lounge', 'Tables'], vendor: 'Timber Traders' }
].map((p, i) => ({ ...p, shopifyProductId: String(8100 + i), shopifyVariantId: String(4400 + i), shopifyInventoryItemId: String(5500 + i), sku: 'OS-' + (100 + i), barcode: '600100' + (100 + i) }));

function demoShopify(action, p) {
  const ints = demoRead('integrations');
  const st = ints.shopify || {};
  const save = (patch) => { ints.shopify = { ...st, ...patch }; demoWrite('integrations', ints); return ints.shopify; };
  const vat = () => { const s = (demoRead('settings').factory) || {}; return { settings: s, vatRate: s.vatRegistered ? (s.vatRate == null ? 0.15 : Number(s.vatRate) || 0) : 0 }; };
  if (action === 'connect') {
    const domain = String(p.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const full = /\.myshopify\.com$/.test(domain) ? domain : domain + '.myshopify.com';
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(full)) throw new Error('That does not look like a Shopify store. Use the address that ends in .myshopify.com');
    if (!String(p.clientId || '').trim() || !String(p.clientSecret || '').trim()) throw new Error('Paste both the Client ID and the Client secret');
    const name = full.replace('.myshopify.com', '').split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    save({ connected: true, domain: full, shopName: name, currency: 'ZAR', taxesIncluded: true, connectedAt: nowIso(), connectedBy: (currentUser || {}).name || '',
      lastCheckedAt: nowIso(), importWhen: p.importWhen === 'placed' ? 'placed' : 'paid', webhooks: 'on', lastError: '', ordersIn: Number(st.ordersIn) || 0, demo: true });
    return { ok: true, shopName: name, webhooks: 'on' };
  }
  if (!st.connected) throw new Error('Connect the shop first');
  if (action === 'disconnect') { save({ connected: false, disconnectedAt: nowIso(), webhooks: '' }); return { ok: true }; }
  if (action === 'settings') { save({ importWhen: p.importWhen === 'placed' ? 'placed' : 'paid' }); return { ok: true }; }
  if (action === 'pushSale' || action === 'pushReturn') {
    // the demo shop's count moves like the real one would
    const sale = (demoRead('sales') || {})[p.saleId] || {};
    if (action === 'pushSale' && !sale.demoPushed) {
      (sale.lines || []).forEach(l => { const v = DEMO_SHOP.find(x => x.shopifyVariantId === l.variantId); if (v && v.tracked && l.kind === 'stock') v.qoh = Math.max(0, v.qoh - (Number(l.qty) || 0)); });
      const m = demoRead('sales'); if (m[p.saleId]) { m[p.saleId].demoPushed = true; m[p.saleId].shopifyOrderId = String(7000 + Object.keys(m).length); m[p.saleId].shopifyOrderName = '#' + (7000 + Object.keys(m).length); demoWrite('sales', m); }
    }
    if (action === 'pushReturn') { const r = (sale.returns || []).find(x => x.returnNo === p.returnNo); ((r && r.lines) || []).forEach(l => { const v = DEMO_SHOP.find(x => x.shopifyVariantId === l.variantId); if (v && v.tracked && l.restock) v.qoh += Number(l.qty) || 0; }); }
    return { ok: true, adjusted: 0 };
  }
  if (action === 'markPaid') { const m = demoRead('sales'); if (m[p.saleId] && m[p.saleId].shopifyOrderId) { m[p.saleId].shopifyPaidAt = nowIso(); demoWrite('sales', m); return { ok: true, paid: true }; } return { ok: true, skipped: 'no shop order' }; }
  if (action === 'receive') {
    // the demo shop's count goes up by what was booked in
    const g = (demoRead('grvs') || {})[p.grvId]; if (!g) throw new Error('Delivery not found');
    (g.lines || []).forEach(l => { const v = DEMO_SHOP.find(x => x.shopifyVariantId === l.variantId); if (v && v.tracked) v.qoh += Number(l.qty) || 0; });
    const gm = demoRead('grvs'); gm[p.grvId] = { ...g, status: 'received', received: (g.lines || []).map(l => ({ inventoryItemId: l.inventoryItemId, qty: l.qty })), failed: [], sentAt: nowIso() }; demoWrite('grvs', gm);
    return { ok: true, received: gm[p.grvId].received, failed: [] };
  }
  if (action === 'setStock') {
    const t = (demoRead('stockTakes') || {})[p.takeId]; if (!t) throw new Error('Stock take not found');
    let n = 0;
    (t.lines || []).forEach(l => { if (l.counted == null || l.counted === '') return; const v = DEMO_SHOP.find(x => x.shopifyVariantId === l.variantId); if (v) { v.qoh = Math.max(0, Math.round(Number(l.counted))); n++; } });
    const tm = demoRead('stockTakes'); tm[p.takeId] = { ...t, status: 'done', reconciledAt: nowIso(), reconciledBy: (currentUser || {}).name || '', set: n, failed: [] }; demoWrite('stockTakes', tm);
    return { ok: true, set: n, failed: [] };
  }
  if (action === 'catalogue') {
    const { vatRate } = vat();
    return { connected: true, shopName: st.shopName, at: nowIso(), items: DEMO_SHOP.map(v => ({ variantId: v.shopifyVariantId, inventoryItemId: v.shopifyInventoryItemId, productId: v.shopifyProductId,
      name: v.title, sku: v.sku, barcode: v.barcode || '', price: mapProduct(v, { taxesIncluded: true, vatRate }).sellingPrice, tracked: v.tracked, qty: v.qoh, category: v.category, collections: v.collections || [], vendor: v.vendor || '', image: '' })) };
  }
  if (action === 'products') {
    const { vatRate } = vat();
    const map = demoRead('products');
    let created = 0, updated = 0, linked = 0;
    for (const v of DEMO_SHOP) {
      const d = mapProduct(v, { taxesIncluded: true, vatRate });
      const id = Object.keys(map).find(k => map[k].shopifyVariantId === v.shopifyVariantId)
        || Object.keys(map).find(k => !map[k].shopifyVariantId && String(map[k].name || '').trim().toLowerCase() === v.title.toLowerCase());
      if (id) {
        if (map[id].shopifyVariantId) updated++; else linked++;
        const { name, category, ...keep } = d;
        map[id] = { ...map[id], ...keep, ...(map[id].category ? {} : { category }), updatedAt: nowIso(), updatedBy: 'Shopify' };
      } else {
        created++;
        map['shopify-' + v.shopifyVariantId] = { labourHours: 0, materials: [], notes: 'From the online shop (SKU ' + v.sku + ')', stock: 0, ...d, source: 'shopify', createdAt: nowIso(), createdBy: 'Shopify', updatedAt: nowIso(), updatedBy: 'Shopify' };
      }
    }
    demoWrite('products', map);
    save({ productsAt: nowIso(), productsCount: DEMO_SHOP.length });
    return { ok: true, total: DEMO_SHOP.length, created, updated, linked };
  }
  if (action === 'sync') {
    // a customer buys a couch (built to order) and two cushions (on the shelf)
    const n = 1001 + (Number(st.ordersIn) || 0);
    const couch = DEMO_SHOP[0], cushion = DEMO_SHOP[2];
    const o = {
      id: 7000000 + n, name: '#' + n, order_number: n, created_at: nowIso(), processed_at: nowIso(), financial_status: 'paid', taxes_included: true,
      email: 'naledi.k@example.com', note: 'Please phone before delivery',
      customer: { id: 990001, first_name: 'Naledi', last_name: 'Khumalo', phone: '082 555 0142' },
      shipping_address: { name: 'Naledi Khumalo', address1: '14 Kloof Street', city: 'Gardens, Cape Town', zip: '8001', phone: '082 555 0142' },
      line_items: [
        { id: n * 10 + 1, product_id: Number(couch.shopifyProductId), variant_id: Number(couch.shopifyVariantId), title: couch.title, variant_title: 'Charcoal Velvet', quantity: 1, price: String(couch.price), sku: couch.sku, tax_lines: [{ rate: 0.15 }] },
        { id: n * 10 + 2, product_id: Number(cushion.shopifyProductId), variant_id: Number(cushion.shopifyVariantId), title: cushion.title, variant_title: '', quantity: 2, price: String(cushion.price), sku: cushion.sku, tax_lines: [{ rate: 0.15 }] }
      ]
    };
    if (!wantOrder(o, st.importWhen)) return { ok: true, looked: 1, brought: [] };
    const { settings, vatRate } = vat();
    const c = customerOf(o);
    const custs = demoRead('customers');
    const hit = findCustomer(Object.keys(custs).map(k => ({ id: k, ...custs[k] })), c);
    let customerId = hit ? hit.id : '';
    if (!customerId) { customerId = 'shopify-c-' + o.customer.id; custs[customerId] = { ...c, notes: 'Added from online order ' + o.name, source: 'shopify', createdAt: nowIso(), createdBy: 'Shopify', updatedAt: nowIso(), updatedBy: 'Shopify' }; demoWrite('customers', custs); }
    const customerName = custs[customerId].name;
    const products = demoRead('products');
    const orders = demoRead('orders');
    const made = [];
    for (const li of orderLines(o)) {
      const pid = Object.keys(products).find(k => products[k].shopifyVariantId === String(li.variant_id));
      const product = pid ? { id: pid, ...products[pid] } : null;
      const fromStock = !!(product && Number(product.stock) >= li.quantity);
      const doc = mapLine(o, li, { customerId, customerName, product, fromStock, leadDays: settings.leadDays, vatRate });
      const counters = demoRead('counters');
      const next = (counters.orderNo && counters.orderNo.value) || settings.firstOrderNo || 1001;
      counters.orderNo = { value: next + 1 }; demoWrite('counters', counters);
      doc.orderNo = (settings.orderPrefix || 'CP-') + next;
      orders[orderDocId(o, li)] = doc; made.push(doc.orderNo);
      if (fromStock) { products[pid].stock = Number(products[pid].stock) - li.quantity; }
    }
    demoWrite('products', products);
    demoWrite('orders', orders);
    save({ ordersIn: (Number(st.ordersIn) || 0) + 1, lastOrderAt: nowIso(), lastOrderName: o.name, lastCheckedAt: nowIso() });
    return { ok: true, looked: 1, brought: [{ order: o.name, orders: made }] };
  }
  throw new Error('Unknown action');
}

// ---- the seller's own view of every company ----

export async function isSeller() {
  if (mode === 'demo') return !!(currentUser && currentUser.companyId === 'demo' && currentUser.role === 'owner');
  try { return (await cloud.fns.getDoc(cloud.fns.doc(cloud.db, 'admins', currentUser.uid))).exists(); }
  catch (e) { return false; }
}

// Becomes the app owner: the server checks the login's email against the
// owner list (FACTORY_ADMIN_EMAILS on the site) and writes admins/<uid>.
const ADMIN_URL = '/.netlify/functions/factory-admin';
export async function claimSeller() {
  if (mode === 'demo') return { admin: await isSeller() };
  const token = await cloud.auth.currentUser.getIdToken();
  const r = await fetch(ADMIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'claim' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

export function watchAllCompanies(cb) {
  if (mode === 'demo') {
    const send = () => { const m = demoCompanies(); cb(Object.keys(m).map(id => ({ id, ...m[id] }))); };
    send(); companyWatchers.push(send); return () => {};
  }
  return cloud.fns.onSnapshot(cloud.fns.collection(cloud.db, 'companies'), (snap) => {
    const rows = []; snap.forEach(d => rows.push({ id: d.id, ...normCompany(d.data()) })); cb(rows);
  }, (err) => console.error('watchAllCompanies failed:', err));
}

// The seller may extend a trial or give free access; nothing else.
export async function sellerUpdateCompany(id, patch) {
  const allowed = {};
  ['status', 'trialEndsAt', 'adminNote'].forEach(k => { if (k in patch) allowed[k] = patch[k]; });
  if (mode === 'demo') {
    const all = demoCompanies(); all[id] = { ...(all[id] || {}), ...allowed }; localStorage.setItem('cp-demo-companies', JSON.stringify(all));
    if (company && company.id === id) company = { id, ...all[id] };
    emitCompany(); return;
  }
  if (allowed.trialEndsAt) allowed.trialEndsAt = cloud.fns.Timestamp.fromDate(new Date(allowed.trialEndsAt));
  await cloud.fns.updateDoc(cloud.fns.doc(cloud.db, 'companies', id), allowed);
}

// ---------------------------------------------------------------- boot ------

export async function initStore() {
  if (!isCloudConfigured()) {
    mode = 'demo';
    const saved = localStorage.getItem('cp-demo-user');
    currentUser = saved ? JSON.parse(saved) : null;
    if (currentUser && currentUser.companyId === undefined) currentUser.companyId = 'demo';     // signed in before companies existed
    if (currentUser && currentUser.companyId === 'demo') {
      ensureDemoCompany();
      if (!jget(demoPrefix('demo') + 'members')[currentUser.uid]) demoMemberSet('demo', currentUser.uid, { email: currentUser.email, name: currentUser.name, role: currentUser.role || 'owner' });
    }
    const dc = currentUser && currentUser.companyId ? demoCompanies()[currentUser.companyId] : null;
    company = dc ? { id: currentUser.companyId, ...dc } : null;
    setTimeout(() => emitUser(), 0);
    return mode;
  }
  const [appMod, authMod, fsMod] = await Promise.all([
    import(FB('app')), import(FB('auth')), import(FB('firestore'))
  ]);
  const app = appMod.initializeApp(FIREBASE_CONFIG);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  // Testing only: on this computer, ?emulator=1 uses Google's local copy of
  // Firebase (sign-in on 9099, database on 8085) instead of the real project.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).get('emulator') === '1') {
    authMod.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fsMod.connectFirestoreEmulator(db, '127.0.0.1', 8085);
  }
  try { await fsMod.enableIndexedDbPersistence(db); } catch (e) { /* multi-tab or unsupported */ }
  cloud = { auth, db, fns: { ...authMod, ...fsMod } };
  mode = 'cloud';

  cloud.fns.onAuthStateChanged(auth, async (u) => {
    try { currentUser = u ? await resolveUser(u) : null; }
    catch (e) { console.error('Could not load the account:', e); currentUser = u ? { uid: u.uid, email: u.email, name: u.email, role: 'none', companyId: null, error: e.message } : null; }
    if (!currentUser) company = null;
    userKnown = true;
    emitUser();
  });
  return mode;
}

// Who is this login, and which company do they work in? In order:
//   1. they already belong to a company        → load it
//   2. someone invited their email address     → join that company
//   3. they have just filled in the sign-up form → create their company
//   4. none of these                            → role 'none' (the app offers to create one)
async function resolveUser(u) {
  const { doc, getDoc, setDoc, updateDoc } = cloud.fns;
  const email = lower(u.email);
  const meRef = doc(cloud.db, 'users', u.uid);
  const me = await getDoc(meRef);
  const mine = me.exists() ? me.data() : {};
  const known = { ...(mine.companies || {}) };        // every company this login belongs to
  // null when they are no longer a member there (the rules then refuse the read)
  const load = async (cid) => {
    try {
      const [mem, comp] = await Promise.all([
        getDoc(doc(cloud.db, 'companies', cid, 'members', u.uid)),
        getDoc(doc(cloud.db, 'companies', cid))
      ]);
      if (!mem.exists() || !comp.exists()) return null;
      company = { id: cid, ...normCompany(comp.data()) };
      return { uid: u.uid, email, name: mem.data().name || mine.name || email, role: mem.data().role || 'none', companyId: cid };
    } catch (e) { return null; }
  };
  const stillMember = async (cid) => { try { return (await getDoc(doc(cloud.db, 'companies', cid, 'members', u.uid))).exists(); } catch (e) { return false; } };
  // the company they were last in; failing that (removed from it), any other of theirs
  const order = [mine.companyId, ...Object.keys(known)].filter((c, i, a) => c && a.indexOf(c) === i);
  for (const cid of order) {
    const user = await load(cid);
    if (!user) { delete known[cid]; continue; }
    // companies they have since been removed from drop off the list
    for (const other of Object.keys(known)) if (other !== cid && !(await stillMember(other))) delete known[other];
    const patch = {};
    if (cid !== mine.companyId) patch.companyId = cid;
    if (known[cid] !== (company.name || '') || Object.keys(known).length !== Object.keys(mine.companies || {}).length) { known[cid] = company.name || ''; patch.companies = known; }
    if (Object.keys(patch).length) await (me.exists() ? updateDoc(meRef, patch) : setDoc(meRef, { email, ...patch }, { merge: true }));
    user.companies = known;
    // an invitation to another company waits until this person says yes
    const inv = await getDoc(doc(cloud.db, 'invites', email));
    if (inv.exists() && inv.data().companyId !== cid && !known[inv.data().companyId]) {
      user.pendingInvite = { companyId: inv.data().companyId, companyName: inv.data().companyName || '', role: inv.data().role || '' };
    }
    return user;
  }
  const invite = await getDoc(doc(cloud.db, 'invites', email));
  if (invite.exists()) return await joinCompany(u, invite.data(), (pendingSignup && pendingSignup.name) || '');
  const p = pendingSignup; pendingSignup = null;
  if (p && p.companyName) return await createCompanyFor(u, p.companyName, p.name);
  company = null;
  return { uid: u.uid, email, name: (p && p.name) || mine.name || email, role: 'none', companyId: null };
}

function normCompany(d) {
  const c = { ...d };
  ['createdAt', 'paidUntil', 'trialEndsAt', 'lastPaymentAt', 'cancelledAt'].forEach(k => {
    if (c[k] && typeof c[k].toDate === 'function') c[k] = c[k].toDate().toISOString();
  });
  return c;
}

// Order numbers start with the company's initials: "Couch Potato" → CP-.
function prefixFor(name) {
  const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const p = words.length > 1 ? words.slice(0, 3).map(w => w[0]).join('') : (words[0] || 'ORD').slice(0, 3);
  return p.toUpperCase() + '-';
}

async function createCompanyFor(u, companyName, name) {
  const { doc, collection, writeBatch, serverTimestamp } = cloud.fns;
  const email = lower(u.email);
  const ref = doc(collection(cloud.db, 'companies'));
  const cid = ref.id;
  const who = name || email;
  const b = writeBatch(cloud.db);
  b.set(ref, { name: companyName, ownerUid: u.uid, ownerEmail: email, plan: 'trial', status: 'trial', createdAt: serverTimestamp() });
  b.set(doc(cloud.db, 'companies', cid, 'members', u.uid), { email, name: who, role: 'owner', joinedAt: nowIso() });
  b.set(doc(cloud.db, 'users', u.uid), { email, name: who, companyId: cid, companies: { [cid]: companyName } }, { merge: true });
  b.set(doc(cloud.db, 'companies', cid, 'settings', 'factory'), { name: companyName, legalName: companyName, orderPrefix: prefixFor(companyName), email, updatedAt: nowIso() });
  Object.entries(DEFAULT_ROLES).forEach(([key, r]) => b.set(doc(cloud.db, 'companies', cid, 'roles', key), roleSeed(r)));
  await b.commit();
  company = { id: cid, name: companyName, ownerUid: u.uid, plan: 'trial', status: 'trial', createdAt: nowIso() };
  return { uid: u.uid, email, name: who, role: 'owner', companyId: cid, companies: { [cid]: companyName } };
}

async function joinCompany(u, inv, name) {
  const { doc, getDoc, writeBatch } = cloud.fns;
  const email = lower(u.email);
  const cid = inv.companyId;
  const who = name || inv.name || email;
  const b = writeBatch(cloud.db);
  b.set(doc(cloud.db, 'companies', cid, 'members', u.uid), { email, name: who, role: inv.role, joinedAt: nowIso(), invitedBy: inv.invitedBy || '' });
  // merge: a login that already belongs to another company keeps that one too
  b.set(doc(cloud.db, 'users', u.uid), { email, name: who, companyId: cid, companies: { [cid]: inv.companyName || '' } }, { merge: true });
  b.delete(doc(cloud.db, 'invites', email));
  b.delete(doc(cloud.db, 'companies', cid, 'invites', email));
  await b.commit();
  const comp = await getDoc(doc(cloud.db, 'companies', cid));
  company = { id: cid, ...normCompany(comp.data() || {}) };
  pendingSignup = null;
  return { uid: u.uid, email, name: who, role: inv.role, companyId: cid };
}

function emitUser() { userWatchers.forEach(cb => { try { cb(currentUser); } catch (e) { console.error(e); } }); }
// A watcher that starts listening after the sign-in state is already known
// (Firebase can answer "nobody signed in" before the screen starts listening)
// is told at once, so the sign-in page always appears.
let userKnown = false;
export function onUser(cb) { userWatchers.push(cb); if (mode === 'demo' || userKnown) cb(currentUser); return () => {
  const i = userWatchers.indexOf(cb); if (i >= 0) userWatchers.splice(i, 1);
}; }

// ---------------------------------------------------------------- auth ------

export async function signIn(email, password) {
  if (mode === 'demo') {
    const accounts = demoAccounts();
    const e = lower(email) || 'demo@example.com';
    let acc = accounts[e];
    if (!acc) {
      const inv = demoInvites()[e];
      // Anyone else who signs in to the demo lands in the shared demo factory.
      acc = inv ? demoJoin(e, inv, '') : { uid: 'demo-' + e, name: e.split('@')[0], companyId: 'demo', role: 'owner' };
      if (!inv) { accounts[e] = acc; saveDemoAccounts(accounts); ensureDemoCompany(); demoMemberSet('demo', acc.uid, { email: e, name: acc.name, role: 'owner' }); }
    }
    demoLogin(e, acc);
    return currentUser;
  }
  await cloud.fns.signInWithEmailAndPassword(cloud.auth, email, password);
  return currentUser;
}

// A new login. With a company name it starts a new company (14-day trial);
// without one it is someone joining the team they were invited to.
export async function signUp({ email, password, name, companyName }) {
  const e = lower(email);
  if (mode === 'demo') {
    const accounts = demoAccounts();
    if (accounts[e]) throw Object.assign(new Error('There is already an account for ' + e + ' — sign in instead.'), { code: 'auth/email-already-in-use' });
    const inv = demoInvites()[e];
    let acc;
    if (inv) acc = demoJoin(e, inv, name);
    else if (companyName) acc = demoCreateCompany(e, companyName, name);
    else acc = { uid: 'demo-' + e, name: name || e, companyId: null, role: 'none' };
    accounts[e] = { ...acc }; saveDemoAccounts(accounts);
    demoLogin(e, acc);
    return currentUser;
  }
  pendingSignup = { companyName: String(companyName || '').trim(), name: String(name || '').trim() };
  await cloud.fns.createUserWithEmailAndPassword(cloud.auth, e, password);
  return currentUser;
}

// Signed in, no company, nobody invited them: start one from inside the app.
export async function createCompany(companyName, name) {
  if (!currentUser) throw new Error('Sign in first');
  if (mode === 'demo') {
    const acc = demoCreateCompany(currentUser.email, companyName, name || currentUser.name);
    const accounts = demoAccounts(); accounts[currentUser.email] = acc; saveDemoAccounts(accounts);
    demoLogin(currentUser.email, acc);
    return currentUser;
  }
  currentUser = await createCompanyFor(cloud.auth.currentUser, companyName, name || currentUser.name);
  emitUser();
  return currentUser;
}

export async function resetPassword(email) {
  if (mode === 'demo') { const e = new Error('The demo has no real logins'); e.code = 'demo'; throw e; }
  // the link in the email brings them back here after the new password is set
  const back = { url: location.origin + location.pathname.replace(/[^/]*$/, ''), handleCodeInApp: false };
  try { await cloud.fns.sendPasswordResetEmail(cloud.auth, lower(email), back); }
  catch (err) {
    // this site not yet on Firebase's list of allowed sites: send the plain email instead
    if (err && /continue-uri|unauthorized-domain/.test(String(err.code || ''))) await cloud.fns.sendPasswordResetEmail(cloud.auth, lower(email));
    else throw err;
  }
}
// "Forgot your password?": what to tell the person, whatever happened. Firebase
// does not say whether a login exists for an email (so nobody can fish for
// accounts): when there is none, nothing is sent, so the message says so.
export async function forgotPassword(email) {
  const e = lower(email || '').trim();
  if (!e) return { ok: false, text: 'Type your email address first, then tap Forgot your password.' };
  if (mode === 'demo') return { ok: false, text: 'This is the demo: it has no real logins, so no email is sent. To reset a real password, open the system without ?demo=1 (put ?demo=0 on the address once to leave the demo).' };
  try {
    await resetPassword(e);
    return { ok: true, text: 'If there is a login for ' + e + ', a reset link is on its way. It comes from noreply@' + (FIREBASE_CONFIG.authDomain || 'firebaseapp.com') + ': check the spam or junk folder too. Nothing after a few minutes? Then there is no login for this email yet: sign up, or ask the owner to invite this address.' };
  } catch (err) {
    const c = String((err && err.code) || '');
    return { ok: false, text: c === 'auth/invalid-email' ? 'That email address does not look right.'
      : c === 'auth/user-not-found' ? 'There is no login for ' + e + '. Sign up, or ask the owner to invite this address.'
      : c === 'auth/too-many-requests' ? 'Too many tries from this device. Wait a few minutes and try again.'
      : c === 'auth/network-request-failed' ? 'No internet connection. Try again when you are online.'
      : 'Could not send the reset email: ' + ((err && err.message) || 'unknown error') };
  }
}

export async function signOutNow() {
  if (mode === 'demo') {
    currentUser = null; company = null;
    localStorage.removeItem('cp-demo-user');
    emitUser();
    return;
  }
  await cloud.fns.signOut(cloud.auth);
}

// ------------------------------------------------------------------ team ----

// The owner invites by email. There is no mail server: the app hands back a
// sign-up link to send over WhatsApp or email, and the invitation waits until
// that address creates its login.
export async function invite(email, role, name) {
  const e = lower(email);
  if (!e || !/@/.test(e)) throw new Error('Enter their email address');
  if (role !== 'owner' && !roles[role]) throw new Error('Pick a role');
  const rec = { email: e, role, name: String(name || '').trim(), companyId: company.id, companyName: company.name || '', invitedBy: currentUser.name || currentUser.email, at: nowIso() };
  if (mode === 'demo') {
    const all = demoInvites(); all[e] = rec; localStorage.setItem('cp-demo-invites', JSON.stringify(all));
    const map = demoRead('invites'); map[e] = rec; demoWrite('invites', map);
    return;
  }
  const { doc, writeBatch } = cloud.fns;
  const b = writeBatch(cloud.db);
  b.set(doc(cloud.db, 'invites', e), rec);
  b.set(doc(cloud.db, 'companies', company.id, 'invites', e), rec);
  await b.commit();
}

export async function cancelInvite(email) {
  const e = lower(email);
  if (mode === 'demo') {
    const all = demoInvites(); delete all[e]; localStorage.setItem('cp-demo-invites', JSON.stringify(all));
    const map = demoRead('invites'); delete map[e]; demoWrite('invites', map);
    return;
  }
  const { doc, writeBatch } = cloud.fns;
  const b = writeBatch(cloud.db);
  b.delete(doc(cloud.db, 'invites', e));
  b.delete(doc(cloud.db, 'companies', company.id, 'invites', e));
  await b.commit();
}

export async function setMemberRole(uid, role) {
  if (role !== 'owner' && !roles[role]) throw new Error('Unknown role');
  await update('members', uid, { role });
}

// Removing someone takes away their access to this company at once; their
// login still exists, but it no longer opens anything.
export async function removeMember(uid) {
  await remove('members', uid);
}

// Your own name, as the team list and the job cards show it. The database
// rules let anyone correct their own name, and nothing else of their record.
export async function setMyName(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Type your name');
  if (!currentUser) throw new Error('Sign in first');
  if (mode === 'demo') {
    if (currentUser.companyId) { const map = demoRead('members'); if (map[currentUser.uid]) { map[currentUser.uid] = { ...map[currentUser.uid], name: n }; demoWrite('members', map); } }
    const accounts = demoAccounts(); if (accounts[currentUser.email]) { accounts[currentUser.email].name = n; saveDemoAccounts(accounts); }
  } else {
    const { doc, updateDoc, setDoc } = cloud.fns;
    if (currentUser.companyId) await updateDoc(doc(cloud.db, 'companies', currentUser.companyId, 'members', currentUser.uid), { name: n, updatedAt: nowIso(), updatedBy: n });
    await setDoc(doc(cloud.db, 'users', currentUser.uid), { name: n }, { merge: true });
  }
  currentUser = { ...currentUser, name: n };
  if (mode === 'demo') localStorage.setItem('cp-demo-user', JSON.stringify(currentUser));
  emitUser();
}

// The owner corrects someone else's name.
export async function setMemberName(uid, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Type their name');
  if (currentUser && uid === currentUser.uid) return setMyName(n);
  await update('members', uid, { name: n });
  if (mode === 'demo') { const accounts = demoAccounts(); Object.keys(accounts).forEach(e => { if (accounts[e].uid === uid) accounts[e].name = n; }); saveDemoAccounts(accounts); }
}

// ------------------------------------------------- more than one company ----
// A login may belong to several companies (the seller setting up a client,
// an owner with two factories). users/<uid>.companies lists them; companyId
// is the one being worked in. Switching or joining reloads the app.

export function myCompanies() {
  if (!currentUser) return [];
  const m = currentUser.companies || (currentUser.companyId ? { [currentUser.companyId]: (company && company.name) || '' } : {});
  return Object.keys(m).map(id => ({ id, name: m[id] || id })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function switchCompany(cid) {
  if (!currentUser || !myCompanies().some(c => c.id === cid)) throw new Error('Not one of your companies');
  if (mode === 'demo') {
    const accounts = demoAccounts(); const acc = accounts[currentUser.email];
    if (acc) { acc.companyId = cid; accounts[currentUser.email] = acc; saveDemoAccounts(accounts); }
    const mem = jget(demoPrefix(cid) + 'members')[currentUser.uid];
    const { pendingInvite, ...rest } = currentUser;
    localStorage.setItem('cp-demo-user', JSON.stringify({ ...rest, companyId: cid, role: mem ? mem.role : 'none' }));
    return;
  }
  await cloud.fns.setDoc(cloud.fns.doc(cloud.db, 'users', currentUser.uid), { companyId: cid }, { merge: true });
}

// Says yes to the invitation that is waiting: joins that company and works
// in it from now on, keeping the others.
export async function acceptInvite() {
  if (!currentUser || !currentUser.pendingInvite) throw new Error('No invitation is waiting');
  if (mode === 'demo') {
    const inv = demoInvites()[currentUser.email];
    if (!inv) throw new Error('That invitation was withdrawn');
    demoLogin(currentUser.email, demoJoin(currentUser.email, inv, currentUser.name));
    return;
  }
  const { doc, getDoc } = cloud.fns;
  const inv = await getDoc(doc(cloud.db, 'invites', currentUser.email));
  if (!inv.exists()) throw new Error('That invitation was withdrawn');
  currentUser = await joinCompany(cloud.auth.currentUser, inv.data(), currentUser.name);
  emitUser();
}

export async function declineInvite() {
  if (!currentUser || !currentUser.pendingInvite) return;
  const e = currentUser.email, cid = currentUser.pendingInvite.companyId;
  if (mode === 'demo') {
    const all = demoInvites(); delete all[e]; localStorage.setItem('cp-demo-invites', JSON.stringify(all));
    const k = demoPrefix(cid) + 'invites'; const map = jget(k); delete map[e]; localStorage.setItem(k, JSON.stringify(map));
  } else {
    const { doc, writeBatch } = cloud.fns;
    const b = writeBatch(cloud.db);
    b.delete(doc(cloud.db, 'invites', e)); b.delete(doc(cloud.db, 'companies', cid, 'invites', e));
    await b.commit();
  }
  const { pendingInvite, ...rest } = currentUser; currentUser = rest;
  if (mode === 'demo') localStorage.setItem('cp-demo-user', JSON.stringify(currentUser));
  emitUser();
}

// ---------------------------------------------------------- driver page ----
//
// Drivers do not log in: their private link carries <companyId>.<code>. In
// the cloud the factory-driver function checks the code and returns only
// that driver's stops; in demo mode the same is worked out from this browser.
const DRIVER_URL = '/.netlify/functions/factory-driver';
export const localDate = (d) => (d || new Date()).toLocaleDateString('en-CA');   // YYYY-MM-DD, phone's own day

function demoStop(o) {
  return { id: o.id, orderNo: o.orderNo || '', product: o.product || '', qty: o.qty || 1, fabric: o.fabric || '',
    customer: o.deliveryContact || o.customerName || '', phone: o.deliveryPhone || '', address: o.deliveryAddress || '',
    slot: o.deliverySlot || '', instructions: o.deliveryInstructions || '', driverStatus: o.driverStatus || '',
    driverNote: o.driverNote || '', deliveredAt: o.deliveredAt || '', signedBy: o.signedBy || '' };
}
function demoDriver(d) {
  const m = /^([A-Za-z0-9_-]{1,64})\.([a-f0-9]{24})$/.exec(String(d || ''));
  if (!m) throw new Error('This link is not complete. Ask the office for your link again.');
  const pre = demoPrefix(m[1]);
  const drivers = jget(pre + 'drivers');
  const id = Object.keys(drivers).find(k => drivers[k].token === m[2] && !drivers[k].disabled);
  if (!id) throw new Error('This link does not work any more. Ask the office for a new one.');
  return { pre, cid: m[1], id, driver: drivers[id] };
}

export async function driverLoad(d, date) {
  const day = date || localDate();
  if (!isCloudConfigured()) {
    const x = demoDriver(d);
    const orders = jget(x.pre + 'orders');
    const st = (jget(x.pre + 'settings').factory) || {};
    const stops = Object.keys(orders).map(id => ({ id, ...orders[id] }))
      .filter(o => o.driverId === x.id && o.deliveryDate === day).map(demoStop)
      .sort((a, b) => String(a.slot).localeCompare(String(b.slot)) || String(a.orderNo).localeCompare(String(b.orderNo)));
    return { driver: { name: x.driver.name || '' }, date: day, company: { name: st.name || (demoCompanies()[x.cid] || {}).name || '', phone: st.deliveryPhone || st.phone || '' }, stops };
  }
  const r = await fetch(DRIVER_URL + '?d=' + encodeURIComponent(d) + '&date=' + day);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Could not load the list (' + r.status + ')');
  return j;
}

export async function driverAct(d, payload) {
  if (!isCloudConfigured()) {
    const x = demoDriver(d);
    const orders = jget(x.pre + 'orders');
    const o = orders[payload.orderId];
    if (!o || o.driverId !== x.id) throw new Error('That stop is not on your list.');
    const now = nowIso(); const by = x.driver.name || 'Driver';
    if (payload.action === 'status') Object.assign(o, { driverStatus: payload.status, driverStatusAt: now, driverNote: payload.note || '' });
    if (payload.action === 'delivered') {
      if (payload.dataUrl) { const notes = jget(x.pre + 'deliveryNotes'); notes[payload.orderId] = { orderId: payload.orderId, orderNo: o.orderNo, dataUrl: payload.dataUrl, signedBy: payload.signedBy || '', at: now, driver: by }; localStorage.setItem(x.pre + 'deliveryNotes', JSON.stringify(notes)); }
      Object.assign(o, { driverStatus: 'delivered', driverStatusAt: now, deliveredAt: now, deliveredBy: by, signedBy: payload.signedBy || '', hasDeliveryNote: !!payload.dataUrl });
      if (['new', 'in-production', 'ready'].includes(o.status)) Object.assign(o, { status: 'dispatched', dispatchedAt: o.dispatchedAt || now, dispatchedBy: by });
    }
    o.updatedAt = now; o.updatedBy = by;
    localStorage.setItem(x.pre + 'orders', JSON.stringify(orders));
    return { ok: true };
  }
  const r = await fetch(DRIVER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Could not save (' + r.status + ')');
  return j;
}

// ------------------------------------------------------------ demo store ----

// Demo companies keep their records in localStorage under their own prefix.
// The shared demo factory ('demo') keeps the original keys, so a browser that
// already has demo data keeps it.
const demoPrefix = (cid) => (!cid || cid === 'demo') ? 'cp-demo-' : 'cp-demo-' + cid + '-';
const demoKey = (coll) => demoPrefix(currentUser && currentUser.companyId) + coll;
const demoSubs = {};   // coll -> [cb]
const jget = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } };
const demoAccounts = () => jget('cp-demo-accounts');
const saveDemoAccounts = (m) => localStorage.setItem('cp-demo-accounts', JSON.stringify(m));
const demoCompanies = () => {
  const m = jget('cp-demo-companies');
  if (!m.demo) m.demo = { name: 'Couch Potato', ownerUid: 'demo', plan: 'trial', status: 'trial', createdAt: nowIso(), demo: true };
  return m;
};
const demoInvites = () => jget('cp-demo-invites');
function ensureDemoCompany() { const m = demoCompanies(); localStorage.setItem('cp-demo-companies', JSON.stringify(m)); }
function demoMemberSet(cid, uid, rec) {
  const k = demoPrefix(cid) + 'members';
  const map = jget(k); map[uid] = { ...(map[uid] || {}), ...rec, joinedAt: (map[uid] && map[uid].joinedAt) || nowIso() };
  localStorage.setItem(k, JSON.stringify(map));
}
function demoCreateCompany(email, companyName, name) {
  const cid = 'c' + Date.now().toString(36);
  const m = demoCompanies(); m[cid] = { name: companyName, ownerUid: 'demo-' + email, ownerEmail: email, plan: 'trial', status: 'trial', createdAt: nowIso() };
  localStorage.setItem('cp-demo-companies', JSON.stringify(m));
  demoMemberSet(cid, 'demo-' + email, { email, name: name || email, role: 'owner' });
  localStorage.setItem(demoPrefix(cid) + 'settings', JSON.stringify({ factory: { name: companyName, legalName: companyName, orderPrefix: prefixFor(companyName), email, updatedAt: nowIso() } }));
  localStorage.setItem(demoPrefix(cid) + 'roles', JSON.stringify(Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([k, r]) => [k, roleSeed(r)]))));
  return { uid: 'demo-' + email, name: name || email, companyId: cid, role: 'owner', companies: { [cid]: companyName } };
}
function demoJoin(email, inv, name) {
  const all = demoInvites(); delete all[email]; localStorage.setItem('cp-demo-invites', JSON.stringify(all));
  const k = demoPrefix(inv.companyId) + 'invites'; const map = jget(k); delete map[email]; localStorage.setItem(k, JSON.stringify(map));
  const accounts = demoAccounts(); const prev = accounts[email] || {};
  const was = prev.companies || (prev.companyId ? { [prev.companyId]: (demoCompanies()[prev.companyId] || {}).name || '' } : {});
  const acc = { uid: 'demo-' + email, name: name || prev.name || inv.name || email, companyId: inv.companyId, role: inv.role,
    companies: { ...was, [inv.companyId]: inv.companyName || (demoCompanies()[inv.companyId] || {}).name || '' } };
  demoMemberSet(inv.companyId, acc.uid, { email, name: acc.name, role: inv.role, invitedBy: inv.invitedBy || '' });
  accounts[email] = acc; saveDemoAccounts(accounts);
  return acc;
}
function demoLogin(email, acc) {
  // the role always comes from the company's member list, like the cloud rules
  const mem = acc.companyId ? jget(demoPrefix(acc.companyId) + 'members')[acc.uid] : null;
  const list = acc.companies || (acc.companyId ? { [acc.companyId]: (demoCompanies()[acc.companyId] || {}).name || '' } : {});
  Object.keys(list).forEach(cid => { if (!jget(demoPrefix(cid) + 'members')[acc.uid]) delete list[cid]; });   // removed from it since
  currentUser = { uid: acc.uid, email, name: acc.name, role: acc.companyId ? (mem ? mem.role : 'none') : 'none', companyId: acc.companyId || null, companies: list };
  const inv = demoInvites()[email];
  if (inv && acc.companyId && inv.companyId !== acc.companyId && !currentUser.companies[inv.companyId]) {
    currentUser.pendingInvite = { companyId: inv.companyId, companyName: inv.companyName || '', role: inv.role || '' };
  }
  company = acc.companyId ? { id: acc.companyId, ...demoCompanies()[acc.companyId] } : null;
  localStorage.setItem('cp-demo-user', JSON.stringify(currentUser));
  emitUser();
}

function demoRead(coll) { return jget(demoKey(coll)); }
function demoWrite(coll, map) {
  localStorage.setItem(demoKey(coll), JSON.stringify(map));
  (demoSubs[coll] || []).forEach(cb => cb(demoList(coll)));
}
function demoList(coll) {
  const map = demoRead(coll);
  return Object.keys(map).map(id => ({ id, ...map[id] }));
}

// ----------------------------------------------------------------- CRUD -----

// Every path below is inside the signed-in user's company.
function cpath() {
  if (!currentUser || !currentUser.companyId) throw new Error('Not signed in to a company');
  return ['companies', currentUser.companyId];
}
const collRef = (coll) => cloud.fns.collection(cloud.db, ...cpath(), coll);
const docRef = (coll, id) => cloud.fns.doc(cloud.db, ...cpath(), coll, id);

// Live list of a collection. Returns an unsubscribe function.
export function watch(coll, cb) {
  if (mode === 'demo') {
    (demoSubs[coll] = demoSubs[coll] || []).push(cb);
    cb(demoList(coll));
    return () => { const a = demoSubs[coll]; const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
  }
  return cloud.fns.onSnapshot(collRef(coll), (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  }, (err) => console.error('watch(' + coll + ') failed:', err));
}

export async function getOne(coll, id) {
  if (mode === 'demo') {
    const map = demoRead(coll);
    return map[id] ? { id, ...map[id] } : null;
  }
  const snap = await cloud.fns.getDoc(docRef(coll, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function create(coll, data) {
  guardWrite(coll);
  const who = currentUser ? currentUser.name : 'system';
  const record = { ...data, createdAt: nowIso(), createdBy: who, updatedAt: nowIso(), updatedBy: who };
  if (mode === 'demo') {
    const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const map = demoRead(coll);
    map[id] = record;
    demoWrite(coll, map);
    return id;
  }
  const ref = await cloud.fns.addDoc(collRef(coll), record);
  return ref.id;
}

// A record with an id we choose (role keys, the till's shop products).
export async function setWithId(coll, id, data) {
  guardWrite(coll);
  const who = currentUser ? currentUser.name : 'system';
  const record = { ...data, updatedAt: nowIso(), updatedBy: who };
  if (mode === 'demo') { const map = demoRead(coll); map[id] = { ...(map[id] || {}), ...record }; demoWrite(coll, map); return; }
  await cloud.fns.setDoc(docRef(coll, id), record, { merge: true });
}

// Patch-only update: just the named fields are sent, so concurrent edits to
// other fields (or other records) survive untouched. `event` optionally appends
// a line to the record's own audit trail.
export async function update(coll, id, patch, event) {
  guardWrite(coll);
  const who = currentUser ? currentUser.name : 'system';
  const body = { ...patch, updatedAt: nowIso(), updatedBy: who };
  if (mode === 'demo') {
    const map = demoRead(coll);
    if (!map[id]) return;
    Object.keys(body).forEach(k => { const v = body[k]; if (v && typeof v === 'object' && '__inc' in v) body[k] = Math.round(((Number(map[id][k]) || 0) + v.__inc) * 1000) / 1000; });
    map[id] = { ...map[id], ...body };
    if (event) map[id].events = [...(map[id].events || []), { at: nowIso(), by: who, what: event }];
    demoWrite(coll, map);
    return;
  }
  if (event) body.events = cloud.fns.arrayUnion({ at: nowIso(), by: who, what: event });
  await cloud.fns.updateDoc(docRef(coll, id), body);
}

// An id for a record before it is written, so other writes in the same
// batch can point at it.
export function newId(coll) {
  if (mode === 'demo') return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return cloud.fns.doc(collRef(coll)).id;
}

// Several writes that must all happen or none (a return at the till: the
// order, the stock, the credit note, the invoice and the sale together).
//   { op: 'create', coll, id?, data }        id from newId(), or one is made
//   { op: 'update', coll, id, patch, event }  patch values may be inc(n)
//   { op: 'remove', coll, id }
// The demo applies them one after another (this browser's storage cannot
// fail half-way); the cloud commits them as one batch.
export async function batchWrite(ops) {
  ops.forEach(o => guardWrite(o.coll));
  const who = currentUser ? currentUser.name : 'system';
  if (mode === 'demo') {
    for (const o of ops) {
      if (o.op === 'create') {
        const map = demoRead(o.coll);
        map[o.id || newId(o.coll)] = { ...o.data, createdAt: nowIso(), createdBy: who, updatedAt: nowIso(), updatedBy: who };
        demoWrite(o.coll, map);
      } else if (o.op === 'update') await update(o.coll, o.id, o.patch || {}, o.event);
      else if (o.op === 'remove') await remove(o.coll, o.id);
    }
    return;
  }
  const b = cloud.fns.writeBatch(cloud.db);
  for (const o of ops) {
    if (o.op === 'create') b.set(o.id ? docRef(o.coll, o.id) : cloud.fns.doc(collRef(o.coll)), { ...o.data, createdAt: nowIso(), createdBy: who, updatedAt: nowIso(), updatedBy: who });
    else if (o.op === 'update') {
      const body = { ...(o.patch || {}), updatedAt: nowIso(), updatedBy: who };
      if (o.event) body.events = cloud.fns.arrayUnion({ at: nowIso(), by: who, what: o.event });
      b.update(docRef(o.coll, o.id), body);
    } else if (o.op === 'remove') b.delete(docRef(o.coll, o.id));
  }
  await b.commit();
}

// ---- moving from the demo to the real system ----
// The demo keeps a company's records in this browser (localStorage). The
// owner downloads them as one file here, signs in to the real system and
// brings the file in there: the same ids, so orders still point at their
// customers, invoices at their orders, and so on. Logins, the team, roles and
// the shop and Xero connections are not moved: they are set up again.
export const MOVE_SKIP = ['members', 'invites', 'roles', 'integrations', 'shopifyPushes', 'shopifyOrders', 'xeroPushes', 'assistantUse', 'secrets', 'payments'];
// A record the demo put in by itself. Only the built-in demo company (id
// 'demo') has them; they carry short made-up ids (d1, h27, m-pine, hsl12…),
// where everything a person adds gets a long generated one ('d' + 12 or so
// letters and digits). Numbering, settings, the register and wage runs are
// never counted as samples, except wage runs the demo made.
const GENERATED = /^d(?=[0-9a-z]*[a-z])[0-9a-z]{10,}$/;
export function isSampleRecord(coll, id, doc, companyId) {
  if (companyId !== 'demo' || !doc) return false;
  if (coll === 'counters') return id === 'demoHistory';
  if (['settings', 'shopProducts'].includes(coll)) return false;
  // a wage run or the register that only has the demo's own staff on it
  const people = coll === 'wageRuns' ? (doc.lines || []).map(l => l.staffId) : coll === 'attendance' ? (id === 'roster' ? (doc.people || []).map(x => x.id) : Object.keys({ ...(doc.in || {}), ...(doc.out || {}) })) : null;
  if (people) return people.length > 0 && people.every(x => !GENERATED.test(String(x || '')));
  if (coll === 'deliveryNotes') return !GENERATED.test(String(id));     // a note is kept under its order's id
  return !GENERATED.test(String(id));
}
// Every collection a company keeps (for copying a whole company).
const COMPANY_COLLS = () => [...new Set([...Object.keys(WRITE_AREAS), 'settings', 'counters', 'deliveryNotes', 'attendance', 'sales', 'invoices', 'quotes',
  'purchaseOrders', 'stockMoves', 'assets', 'storeStaff', 'drivers', 'staff', 'wageRuns', 'tillStaff', 'tillShifts', 'giftCards', 'grvs', 'stockTakes', 'shopProducts', 'suppliers', 'shopPos'])].filter(c => !MOVE_SKIP.includes(c));
// Download a company: the demo's from this browser, the real system's from the database (the owner's).
export async function exportCompanyBundle() {
  if (mode === 'demo') return exportDemoBundle();
  if (!currentUser || currentUser.role !== 'owner') throw new Error('Only the owner can download all the data');
  const collections = {};
  for (const coll of COMPANY_COLLS()) {
    try {
      const snap = await cloud.fns.getDocs(collRef(coll));
      const map = {}; snap.forEach(d => { map[d.id] = d.data(); });
      if (Object.keys(map).length) collections[coll] = map;
    } catch (e) { /* a collection this role cannot read: left out */ }
  }
  return { app: 'factory-manager', kind: 'company-export', version: 1, exportedAt: nowIso(), company: { id: currentUser.companyId, name: (company && company.name) || '' }, collections };
}
// Take out everything a bring-in put here (records carry movedFromDemoAt);
// what the team added since stays. Numbering and settings are left alone.
export async function removeMovedIn(dryRun) {
  if (mode !== 'cloud' || !currentUser || currentUser.role !== 'owner') throw new Error('Only the owner can do this, in the real system');
  const found = [];
  for (const coll of COMPANY_COLLS()) {
    if (coll === 'settings' || coll === 'counters') continue;
    try { const snap = await cloud.fns.getDocs(collRef(coll)); snap.forEach(d => { if (d.data().movedFromDemoAt) found.push({ coll, id: d.id }); }); } catch (e) { /* not readable */ }
  }
  const counts = {}; found.forEach(f => { counts[f.coll] = (counts[f.coll] || 0) + 1; });
  if (dryRun) return counts;
  for (let i = 0; i < found.length; i += 400) {
    const b = cloud.fns.writeBatch(cloud.db);
    found.slice(i, i + 400).forEach(f => b.delete(docRef(f.coll, f.id)));
    await b.commit();
  }
  return counts;
}
export function exportDemoBundle() {
  if (mode !== 'demo') throw new Error('Only the demo keeps its data in this browser');
  if (!currentUser || !currentUser.companyId) throw new Error('Sign in to the demo company first');
  const cid = currentUser.companyId, prefix = demoPrefix(cid);
  const reserved = new Set(['user', 'accounts', 'companies', 'invites']);
  const collections = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const coll = k.slice(prefix.length);
    if (!/^[A-Za-z]+$/.test(coll) || reserved.has(coll) || MOVE_SKIP.includes(coll)) continue;   // another company's keys carry its id and a dash
    const map = jget(k);
    if (map && typeof map === 'object' && Object.keys(map).length) collections[coll] = map;
  }
  const co = demoCompanies()[cid] || {};
  return { app: 'factory-manager', kind: 'demo-export', version: 1, exportedAt: nowIso(), company: { id: cid, name: co.name || (company && company.name) || '' }, collections };
}
// Write a bundle into the signed-in owner's company. Records keep their ids;
// one already there with the same id is replaced. Counters move to the higher
// number so nothing is numbered twice. Settings are merged when asked.
export async function importBundle(bundle, opts) {
  opts = opts || {};
  if (mode !== 'cloud') throw new Error('Open the real system (not the demo) to bring the data in');
  if (!currentUser || currentUser.role !== 'owner') throw new Error('Only the owner can bring data in');
  if (!bundle || bundle.app !== 'factory-manager' || !bundle.collections) throw new Error('This is not a Factory Manager data file');
  const done = {};
  const writes = [];
  for (const [coll, map] of Object.entries(bundle.collections)) {
    if (MOVE_SKIP.includes(coll) || !/^[A-Za-z]+$/.test(coll)) continue;
    if (coll === 'settings' && !opts.settings) continue;
    for (const [id, doc] of Object.entries(map || {})) {
      if (!id || /[\/]/.test(id) || !doc || typeof doc !== 'object') continue;
      if (opts.skipSamples && isSampleRecord(coll, id, doc, bundle.company && bundle.company.id)) continue;
      writes.push({ coll, id, doc });
      done[coll] = (done[coll] || 0) + 1;
    }
  }
  // counters: never go backwards
  const counters = writes.filter(w => w.coll === 'counters');
  for (const w of counters) {
    const snap = await cloud.fns.getDoc(docRef('counters', w.id));
    const have = snap.exists() ? Number(snap.data().value) || 0 : 0;
    w.doc = { value: Math.max(have, Number(w.doc.value) || 0) };
  }
  const who = currentUser.name || currentUser.email || 'owner';
  const prep = (w) => {
    const data = { ...w.doc };
    if (w.coll !== 'counters' && w.coll !== 'settings') { data.movedFromDemoAt = nowIso(); data.movedBy = who; }
    return data;
  };
  const put = (b, w) => { if (w.coll === 'settings' || w.coll === 'counters') b.set(docRef(w.coll, w.id), prep(w), { merge: true }); else b.set(docRef(w.coll, w.id), prep(w)); };
  // batches of at most 400 records and about 2 MB (signed notes are pictures;
  // Firebase takes up to 10 MB a batch and 1 MB a record)
  const groups = [];
  let cur = [], size = 0;
  for (const w of writes) {
    const n = JSON.stringify(w.doc).length;
    if (cur.length && (cur.length >= 400 || size + n > 2000000)) { groups.push(cur); cur = []; size = 0; }
    cur.push(w); size += n;
  }
  if (cur.length) groups.push(cur);
  const failed = [];
  let written = 0;
  for (const g of groups) {
    try {
      const b = cloud.fns.writeBatch(cloud.db); g.forEach(w => put(b, w)); await b.commit();
    } catch (e) {
      // one bad record must not stop the rest: write this batch one by one
      for (const w of g) {
        try { const b = cloud.fns.writeBatch(cloud.db); put(b, w); await b.commit(); }
        catch (err) { failed.push({ coll: w.coll, id: w.id, error: String((err && (err.code || err.message)) || err) }); done[w.coll] = Math.max(0, (done[w.coll] || 1) - 1); }
      }
    }
    written += g.length;
    if (opts.progress) opts.progress(written, writes.length);
  }
  Object.defineProperty(done, 'failed', { value: failed, enumerable: false });
  return done;
}

// Add to (or take from) a number without reading it first, so two people
// receiving and using stock at the same moment never lose each other's change:
//   update('materials', id, { onHand: inc(-3) })
export function inc(n) {
  const v = Number(n) || 0;
  return mode === 'demo' ? { __inc: v } : cloud.fns.increment(v);
}

export async function remove(coll, id) {
  guardWrite(coll);
  if (mode === 'demo') {
    const map = demoRead(coll);
    delete map[id];
    demoWrite(coll, map);
    return;
  }
  await cloud.fns.deleteDoc(docRef(coll, id));
}

// ------------------------------------------------------------- numbering ----

// The company's own order and invoice sequences. In the cloud this runs as a
// transaction so two people capturing orders at the same moment can never be
// handed the same number.
export async function nextNumber(key, first) {
  return reserveNumbers(key, 1, first);
}

// A run of `count` numbers in one go (an import of many orders); returns the
// first. `atLeast` moves the sequence past numbers already used elsewhere,
// such as order numbers that came in from a spreadsheet.
export async function reserveNumbers(key, count, first, atLeast) {
  guardWrite('counters');
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const floor = Number(atLeast) || 0;
  if (mode === 'demo') {
    const map = demoRead('counters');
    const next = Math.max((map[key] && map[key].value) || first || 1, floor);
    map[key] = { value: next + n };
    demoWrite('counters', map);
    return next;
  }
  const ref = docRef('counters', key);
  return await cloud.fns.runTransaction(cloud.db, async (tx) => {
    const snap = await tx.get(ref);
    const next = Math.max(snap.exists() ? (snap.data().value || first || 1) : (first || 1), floor);
    tx.set(ref, { value: next + n }, { merge: true });
    return next;
  });
}

// --------------------------------------------------------------- settings ---

export async function loadSettings(defaults) {
  const got = await getOne('settings', 'factory');
  const s = { ...defaults, ...(got || {}) };
  if (!s.name && company) s.name = company.name || '';
  if (!s.legalName) s.legalName = s.name;
  return s;
}

export async function saveSettings(patch) {
  if (mode === 'demo') {
    const map = demoRead('settings');
    map.factory = { ...(map.factory || {}), ...patch, updatedAt: nowIso() };
    demoWrite('settings', map);
    return;
  }
  await cloud.fns.setDoc(docRef('settings', 'factory'), { ...patch, updatedAt: nowIso() }, { merge: true });
  // the trading name is also the company's name everywhere else
  if (patch.name && company && currentUser.role === 'owner' && patch.name !== company.name) {
    await cloud.fns.updateDoc(cloud.fns.doc(cloud.db, 'companies', company.id), { name: patch.name });
    company.name = patch.name;
  }
}

// Seed a brand-new demo browser with one customer and a few orders, so the
// system can be walked through without typing anything first.
export function seedDemoIfEmpty() {
  if (mode !== 'demo' || !currentUser || currentUser.companyId !== 'demo') return false;
  const had = Object.keys(demoRead('orders')).length > 0;
  if (!had) seedDemoBase();
  seedDemoExtras();
  seedDemoDeliveries();
  seedDemoWages();
  seedDemoHistory();
  return !had;
}

function seedDemoBase() {
  const custId = 'd-bellville';
  demoWrite('customers', {
    [custId]: {
      name: 'Bellville Furniture', contact: 'Jean', phone: '021 000 0000',
      email: 'orders@bellvillefurniture.co.za', area: 'Bellville', address: '',
      termsDays: 30, createdAt: nowIso(), createdBy: 'demo'
    },
    'd-walkin': {
      name: 'Private client — J. Marais', contact: 'J. Marais', phone: '082 555 1234',
      email: '', area: 'Durbanville', address: '12 Oak Street, Durbanville',
      termsDays: 0, createdAt: nowIso(), createdBy: 'demo'
    }
  });
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return localDate(d);
  };
  const monday = (offset) => {
    const d = new Date(); d.setDate(d.getDate() + offset);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toISOString().split('T')[0];
  };
  const mk = (n, over) => ({
    orderNo: 'CP-' + n, customerId: custId, customerName: 'Bellville Furniture',
    externalRef: String(3200 + (n - 1000)), source: 'feed',
    product: '3 Seater Chesterfield', qty: 1, fabric: 'Moldova : Oatmeal',
    notes: '', paidDate: '', dueDate: '', priceEach: 8500,
    status: 'new', fabricStatus: 'none', events: [],
    createdAt: nowIso(), createdBy: 'demo', updatedAt: nowIso(), updatedBy: 'demo', ...over
  });
  demoWrite('orders', {
    'd1': mk(1001, { status: 'in-production', fabricStatus: 'received', product: '3 Seater Chesterfield', paidDate: day(-24), dueDate: day(4), planWeek: monday(0) }),
    'd2': mk(1002, { status: 'new', product: '2 Seater Amber', fabric: 'Adore : Flint Grey', priceEach: 6400, paidDate: day(-6), dueDate: day(22) }),
    'd3': mk(1003, { status: 'ready', product: 'Corner Unit 2.8 x 2.8', fabric: 'Magical : Eclipse', priceEach: 15900, fabricStatus: 'received', paidDate: day(-30), dueDate: day(-2), planWeek: monday(0), readyAt: day(-1) }),
    'd5': mk(1005, { status: 'dispatched', product: 'Ottoman 900mm', fabric: 'Adore : Flint Grey', priceEach: 2400, qty: 2, fabricStatus: 'received', paidDate: day(-35), dueDate: day(-7), readyAt: day(-2), dispatchedAt: new Date(Date.now() - 86400000).toISOString(), dispatchedBy: 'Thandi' }),
    'd4': { ...mk(1004, { status: 'new', product: 'Daybed 2.4m', priceEach: 11200, paidDate: day(-10), dueDate: day(18), fabricStatus: 'ordered', planWeek: monday(7) }), customerId: 'd-walkin', customerName: 'Private client — J. Marais', source: 'manual', externalRef: '' }
  });
  demoWrite('counters', { orderNo: { value: 1006 }, invoiceNo: { value: 1 } });
  demoWrite('settings', { factory: { weeklyTarget: 150000,
    phone: '021 000 0000', email: 'factory@couchpotato.co.za',
    labourRate: 85, unitsPerMonth: 60,
    vatRegistered: true, vatNo: '4123456789', regNo: '2015/123456/07', address: '21 Induland Crescent, Lansdowne, Cape Town',
    bankDetails: 'FNB · Couch Potato Factory (Pty) Ltd · Acc 62012345678 · Branch 250655',
    overheads: [{ name: 'Rent', monthly: 25000 }, { name: 'Electricity', monthly: 6000 }, { name: 'Admin salaries', monthly: 30000 }, { name: 'Insurance', monthly: 2500 }, { name: 'Vehicle', monthly: 4500 }]
  } });
  const mats = {
    'm-pine': { name: 'Pine 38×76', unit: 'm', cost: 28, supplier: 'Timber City' },
    'm-ply': { name: 'Plywood 12mm', unit: 'sheet', cost: 420, supplier: 'Timber City' },
    'm-foam': { name: 'Foam 50mm HD', unit: 'm²', cost: 185, supplier: 'Foam Factory' },
    'm-foam100': { name: 'Foam 100mm seat', unit: 'm²', cost: 340, supplier: 'Foam Factory' },
    'm-web': { name: 'Elastic webbing', unit: 'm', cost: 9.5, supplier: 'Upholstery Supplies' },
    'm-dac': { name: 'Dacron wrap', unit: 'm', cost: 32, supplier: 'Upholstery Supplies' },
    'm-fab': { name: 'Fabric (standard range)', unit: 'm', cost: 165, supplier: 'Hertex' },
    'm-feet': { name: 'Timber feet', unit: 'each', cost: 38, supplier: 'Upholstery Supplies' },
    'm-glue': { name: 'Spray adhesive', unit: 'L', cost: 95, supplier: 'Upholstery Supplies' },
    'm-stap': { name: 'Staples', unit: 'pack', cost: 60, supplier: 'Upholstery Supplies' }
  };
  Object.keys(mats).forEach(k => { mats[k].createdAt = nowIso(); mats[k].createdBy = 'demo'; });
  demoWrite('materials', mats);
  const bom = (arr) => arr.map(([materialId, qty]) => ({ materialId, qty }));
  const prods = {
    'p-3s': { name: '3 Seater Chesterfield', category: 'Sofas', labourHours: 14, sellingPrice: 8500, materials: bom([['m-pine', 22], ['m-ply', 1], ['m-foam', 4.5], ['m-foam100', 2.2], ['m-web', 30], ['m-dac', 8], ['m-fab', 13], ['m-feet', 4], ['m-glue', 1], ['m-stap', 1]]) },
    'p-2s': { name: '2 Seater Amber', category: 'Sofas', labourHours: 10, sellingPrice: 6400, stock: 1, materials: bom([['m-pine', 16], ['m-ply', 0.7], ['m-foam', 3.2], ['m-foam100', 1.5], ['m-web', 22], ['m-dac', 6], ['m-fab', 9], ['m-feet', 4], ['m-glue', 0.7], ['m-stap', 1]]) },
    'p-corner': { name: 'Corner Unit 2.8 x 2.8', category: 'Corner units', labourHours: 26, sellingPrice: 15900, materials: bom([['m-pine', 40], ['m-ply', 2], ['m-foam', 8], ['m-foam100', 4.4], ['m-web', 55], ['m-dac', 15], ['m-fab', 24], ['m-feet', 8], ['m-glue', 2], ['m-stap', 2]]) },
    'p-daybed': { name: 'Daybed 2.4m', category: 'Daybeds', labourHours: 18, sellingPrice: 11200, materials: bom([['m-pine', 28], ['m-ply', 1.5], ['m-foam', 6], ['m-foam100', 3], ['m-web', 36], ['m-dac', 10], ['m-fab', 16], ['m-feet', 6], ['m-glue', 1.2], ['m-stap', 1]]) },
    'p-ott': { name: 'Ottoman 900mm', category: 'Occasional', labourHours: 4, sellingPrice: 2400, stock: 3, materials: bom([['m-pine', 6], ['m-ply', 0.4], ['m-foam', 1.2], ['m-foam100', 0.8], ['m-web', 8], ['m-dac', 2.5], ['m-fab', 3], ['m-feet', 4], ['m-glue', 0.3]]) }
  };
  Object.keys(prods).forEach(k => { prods[k].createdAt = nowIso(); prods[k].createdBy = 'demo'; });
  demoWrite('products', prods);
}

// Twenty more orders, generated from a fixed seed so every demo browser gets
// the same believable mix: several customers, every catalogue product, orders
// at each stage, some late, some waiting on fabric, a few already out the door.
// Shelf counts, reorder levels and one delivery on its way, so the Stock
// screen has something true to say in the demo.
function seedDemoStock() {
  const mats = demoRead('materials');
  if (!mats['m-foam'] || mats['m-foam'].onHand != null) return;
  // most materials comfortable; foam, fabric and staples running low
  const lv = { 'm-pine': [640, 150, 300], 'm-ply': [26, 6, 10], 'm-foam': [22, 30, 40], 'm-foam100': [6, 12, 20], 'm-web': [620, 200, 300],
    'm-dac': [210, 60, 100], 'm-fab': [70, 80, 100], 'm-feet': [150, 40, 100], 'm-glue': [16, 5, 10], 'm-stap': [2, 4, 10] };
  Object.keys(lv).forEach(k => { if (mats[k]) Object.assign(mats[k], { onHand: lv[k][0], reorderLevel: lv[k][1], reorderQty: lv[k][2], countedAt: nowIso() }); });
  demoWrite('materials', mats);
  const pos = demoRead('purchaseOrders');
  pos['po1'] = { poNo: 'PO-0001', supplier: 'Foam Factory', supplierPhone: '021 555 0101', supplierEmail: 'orders@foamfactory.example', expectedDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    status: 'sent', sentAt: nowIso(), notes: '', lines: [{ materialId: 'm-foam100', name: 'Foam 100mm seat', unit: 'm²', qty: 20, cost: 340, received: 0 }],
    events: [], createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), createdBy: 'demo', updatedAt: nowIso(), updatedBy: 'demo' };
  demoWrite('purchaseOrders', pos);
  const c = demoRead('counters'); c.poNo = { value: 2 }; demoWrite('counters', c);
}

// Three quotes: one waiting on the customer, one won, one still a draft.
function seedDemoQuotes() {
  const q = demoRead('quotes');
  if (q['q1']) return;
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString();
  const mk = (no, over) => ({ quoteNo: no, lines: [], discount: 0, notes: 'Lead time 4 weeks from deposit. Delivery in the Cape Town metro included.', events: [], createdBy: 'demo', updatedAt: d(0), updatedBy: 'demo', ...over });
  q['q1'] = mk('Q-0001', { customerId: 'd-durbanville', customerName: 'Durbanville Décor', status: 'accepted', createdAt: d(-20), sentAt: d(-20), acceptedAt: d(-17), validUntil: d(10).slice(0, 10),
    lines: [{ productId: 'p-3s', description: '3 Seater Chesterfield', fabric: 'Linen Look : Natural', qty: 2, unitPrice: 8500 }], orderNos: ['CP-1010'] });
  q['q2'] = mk('Q-0002', { customerId: '', customerName: '', prospect: { name: 'Sarah van Wyk', phone: '082 777 1234', email: 'sarah@example.com', address: 'Constantia' }, status: 'sent', createdAt: d(-3), sentAt: d(-3), validUntil: d(27).slice(0, 10),
    lines: [{ productId: 'p-corner', description: 'Corner Unit 2.8 x 2.8', fabric: 'Boucle : Cream', qty: 1, unitPrice: 15900 }, { productId: 'p-ott', description: 'Ottoman 900mm', fabric: 'Boucle : Cream', qty: 1, unitPrice: 2400 }], discount: 500 });
  q['q3'] = mk('Q-0003', { customerId: 'd-stellenbosch', customerName: 'Stellenbosch Interiors', status: 'draft', createdAt: d(-1), validUntil: d(29).slice(0, 10),
    lines: [{ productId: 'p-daybed', description: 'Daybed 2.4m', fabric: '', qty: 3, unitPrice: 11200 }] });
  demoWrite('quotes', q);
  const c = demoRead('counters'); c.quoteNo = { value: 4 }; demoWrite('counters', c);
}

// Two drivers and some deliveries booked for today and tomorrow.
function seedDemoDeliveries() {
  const drv = demoRead('drivers');
  if (drv['drv1']) return;
  drv['drv1'] = { name: 'Sipho', phone: '082 111 2222', token: 'a1b2c3d4e5f6a7b8c9d0e1f2', createdAt: nowIso(), createdBy: 'demo' };
  drv['drv2'] = { name: 'Johan', phone: '083 333 4444', token: 'f0e1d2c3b4a5f6e7d8c9b0a1', createdAt: nowIso(), createdBy: 'demo' };
  demoWrite('drivers', drv);
  const orders = demoRead('orders');
  const today = localDate(), tomorrow = localDate(new Date(Date.now() + 86400000));
  const book = [['d3', today, '08:00 - 10:00', 'drv1', 'Gate code 4455, ring twice'], ['r3', today, '10:00 - 12:00', 'drv1', ''], ['r8', today, '14:00 - 16:00', 'drv2', 'Second floor, no lift'], ['r12', tomorrow, '10:00 - 12:00', 'drv1', '']];
  const custs = demoRead('customers');
  book.forEach(([id, date, slot, d, note]) => {
    const o = orders[id]; if (!o) return;
    const c = custs[o.customerId] || {};
    Object.assign(o, { deliveryDate: date, deliverySlot: slot, driverId: d, driverName: drv[d].name, deliveryContact: c.contact || o.customerName, deliveryPhone: c.phone || '',
      deliveryAddress: c.address || c.area || '', deliveryInstructions: note, driverStatus: 'scheduled' });
    if (o.status === 'new' || o.status === 'in-production' || o.status === 'dispatched') o.status = 'ready';
  });
  // and one the customer fetches from the factory
  const col = orders.r5;
  if (col) {
    const c = custs[col.customerId] || {};
    Object.assign(col, { status: 'ready', deliveryMethod: 'collect', deliveryDate: tomorrow, deliveryContact: c.contact || col.customerName, deliveryPhone: c.phone || '082 555 0101', driverStatus: 'scheduled', deliveryInstructions: 'Coming with a bakkie' });
  }
  demoWrite('orders', orders);
}

// Wages: four people, paid four ways, and last week's run already paid.
function seedDemoWages() {
  const st = demoRead('staff');
  if (st.s1) return;
  const now = nowIso();
  Object.assign(st, {
    s1: { name: 'Sipho Dlamini', job: 'Upholsterer', phone: '082 111 2222', idNumber: '8605125800083', payType: 'piece', rate: 95, uif: true, bank: 'Capitec 1234567890', active: true, createdAt: now, createdBy: 'demo' },
    s2: { name: 'Thandi Mokoena', job: 'Sewing', phone: '083 222 3333', idNumber: '9102030800084', payType: 'weekly', rate: 2600, uif: true, bank: 'FNB 62012345678', active: true, createdAt: now, createdBy: 'demo' },
    s3: { name: 'Pieter Swart', job: 'Frames', phone: '084 333 4444', idNumber: '7811205800085', payType: 'hourly', rate: 62, uif: true, bank: 'Standard Bank 001234567', active: true, createdAt: now, createdBy: 'demo' },
    s4: { name: 'Nomsa Jacobs', job: 'Office', phone: '082 444 5555', idNumber: '8907170800086', payType: 'monthly', rate: 14500, uif: true, bank: 'Nedbank 1098765432', active: true, createdAt: now, createdBy: 'demo' }
  });
  demoWrite('staff', st);
  const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
  const thisMon = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDate(d); })();
  const last = plus(thisMon, -7);
  const runs = demoRead('wageRuns');
  runs['w-' + last] = { id: 'w-' + last, kind: 'week', start: last, end: plus(last, 6), status: 'paid', paidAt: plus(last, 4) + 'T15:00:00.000Z', paidBy: 'Jean',
    lines: [
      { staffId: 's1', name: 'Sipho Dlamini', job: 'Upholsterer', payType: 'piece', rate: 95, uif: true, hours: 4, overtime: 0, bonus: 0, advances: 0, deductions: [], note: '',
        pieces: [{ orderId: 'past-1', orderNo: 'CP-0991', product: '3 Seater Chesterfield', hours: 14, amount: 1330 }, { orderId: 'past-2', orderNo: 'CP-0994', product: 'Ottoman 900mm', hours: 4, amount: 380 }, { orderId: 'past-3', orderNo: 'CP-0996', product: 'Wingback Chair', hours: 9, amount: 855 }] },
      { staffId: 's2', name: 'Thandi Mokoena', job: 'Sewing', payType: 'weekly', rate: 2600, uif: true, hours: 0, overtime: 3, pieces: [], bonus: 0, advances: 0, deductions: [{ what: 'Loan repayment', amount: 200 }], note: '' },
      { staffId: 's3', name: 'Pieter Swart', job: 'Frames', payType: 'hourly', rate: 62, uif: true, hours: 45, overtime: 6, pieces: [], bonus: 0, advances: 300, deductions: [], note: '' }
    ], createdAt: now, createdBy: 'demo', updatedAt: now, updatedBy: 'demo' };
  demoWrite('wageRuns', runs);
}

// Six months before the recent weeks: finished orders with their invoices
// and payments (a few still owing), till sales, purchase orders received,
// quotes won and lost, and the wage runs, so Profit, the statements and
// every history tab look like a factory that has been running. Seeded once.
function seedDemoHistory() {
  const counters = demoRead('counters');
  if (counters.demoHistory) return;
  let seed = 20260401;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
  const at = (iso, h) => iso + 'T' + String(h || 9).padStart(2, '0') + ':00:00.000Z';
  const r2 = (n) => Math.round(n * 100) / 100;
  const pad = (n) => String(n).padStart(4, '0');
  const todayIso = localDate();
  const thisMon = (() => { const d = new Date(todayIso + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDate(d); })();
  const settings = demoRead('settings').factory || {};
  const vat = settings.vatRegistered ? (Number(settings.vatRate) || 0.15) : 0;
  const prefix = settings.invoicePrefix || 'INV-';
  const customers = demoRead('customers'), products = demoRead('products'), materials = demoRead('materials');
  const orders = demoRead('orders'), invoices = demoRead('invoices'), sales = demoRead('sales'), runs = demoRead('wageRuns'), pos = demoRead('purchaseOrders'), moves = demoRead('stockMoves'), quotes = demoRead('quotes');
  const custIds = ['d-bellville', 'd-bellville', 'd-bellville', 'd-stellenbosch', 'd-durbanville', 'd-walkin', 'd-botha'].filter(id => customers[id]);
  if (!custIds.length) return;
  const catalogue = [['3 Seater Chesterfield', 8500], ['2 Seater Amber', 6400], ['Corner Unit 2.8 x 2.8', 15900], ['Daybed 2.4m', 11200], ['Ottoman 900mm', 2400], ['Alaska 3 Seater 2.4m', 9200], ['Paris Chesterfield', 12800], ['Wingback Chair', 4600]];
  const fabrics = ['Linen Look : Natural', 'Moldova : Oatmeal', 'Hertex Velvet : Forest', 'Boucle : Cream', 'Magical : Eclipse', 'Adore : Flint Grey', 'Corduroy : Magnet'];
  const hoursOf = (name) => { const p = Object.values(products).find(x => x.name === name); return (p && Number(p.labourHours)) || 8; };
  let orderN = 760;
  let invoiceN = Math.max(1, (counters.invoiceNo && counters.invoiceNo.value) || 1);
  let saleN = Math.max(1, (counters.saleNo && counters.saleNo.value) || 1);
  let poN = Math.max(1, (counters.poNo && counters.poNo.value) || 1);
  let quoteN = Math.max(1, (counters.quoteNo && counters.quoteNo.value) || 1);
  const shelf = [['Ottoman 900mm', 2400, 'p-ott'], ['Linen Scatter Cushion 50cm', 390, ''], ['Oak Side Table', 2520, ''], ['Wingback Chair', 4600, 'p-wing']];
  const suppliers = ['Foam Factory', 'Timber City', 'Hertex Fabrics', 'Fabric Library'];
  const matList = Object.keys(materials).map(id => ({ id, ...materials[id] }));
  for (let w = -26; w <= -2; w++) {
    const mon = plus(thisMon, w * 7), friday = plus(mon, 4);
    const byCust = {}, weekOrders = [];
    const n = between(5, 8);
    for (let i = 0; i < n; i++) {
      const cid = pick(custIds); const c = customers[cid] || {};
      const [product, price] = pick(catalogue);
      const qty = rnd() < 0.1 ? 2 : 1;
      const paidDate = plus(mon, -between(20, 30));
      const readyDay = plus(mon, between(1, 4));
      const outDay = plus(readyDay, between(0, 2));
      const id = 'h' + orderN;
      const o = { orderNo: 'CP-' + pad(orderN), customerId: cid, customerName: c.name || '', externalRef: cid === 'd-bellville' ? String(2400 + orderN) : '', source: cid === 'd-bellville' ? 'feed' : 'manual',
        product, qty, fabric: pick(fabrics), fabricStatus: 'received', notes: '', paidDate, dueDate: plus(paidDate, 28), priceEach: price, status: 'invoiced', planWeek: mon,
        readyAt: at(readyDay, 15), dispatchedAt: at(outDay, 11), dispatchedBy: pick(['Sipho', 'Thandi']), deliveryMethod: rnd() < 0.2 ? 'collect' : 'delivery',
        events: [{ at: at(paidDate, 9), by: 'Nomsa', what: 'Order captured' }, { at: at(mon, 8), by: 'Sipho', what: 'Moved to In production' }, { at: at(readyDay, 15), by: 'Sipho', what: 'Moved to Done' }, { at: at(outDay, 11), by: 'Thandi', what: 'Moved to Dispatched' }],
        createdAt: at(paidDate, 9), createdBy: 'Nomsa', updatedAt: at(outDay, 11), updatedBy: 'Thandi' };
      orders[id] = o; weekOrders.push({ id, o });
      (byCust[cid] = byCust[cid] || []).push({ id, o });
      orderN++;
    }
    // one invoice per customer for the week, on the Friday; the older ones paid
    Object.keys(byCust).forEach(cid => {
      const c = customers[cid] || {}; const terms = Number(c.termsDays) || 0;
      const lines = byCust[cid].map(({ id, o }) => ({ orderId: id, orderNo: o.orderNo, externalRef: o.externalRef || '', description: o.product + (o.fabric ? ' — ' + o.fabric : ''), qty: o.qty, unitPrice: o.priceEach }));
      const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)), vatAmt = r2(subtotal * vat), total = r2(subtotal + vatAmt);
      const invoiceNo = prefix + pad(invoiceN);
      const dueDate = plus(friday, terms);
      const payDay = terms === 0 ? friday : plus(friday, between(Math.min(terms, 3), terms + 12));
      const paid = (w <= -6 || terms === 0 || rnd() < 0.5) && payDay <= todayIso;
      const method = terms === 0 ? pick(['EFT', 'Card', 'Cash']) : 'EFT';
      const invId = 'hi' + invoiceN;
      invoices[invId] = { invoiceNo, customerId: cid, customerName: c.name || '', date: friday, dueDate, lines, subtotal, vat: vatAmt, vatRate: vat, total,
        status: paid ? 'paid' : 'issued', paidAt: paid ? payDay : '', payments: paid ? [{ at: payDay, amount: total, method, ref: terms === 0 ? '' : 'Payment ' + invoiceNo, by: 'Nomsa' }] : [], note: '',
        events: [{ at: at(friday, 16), by: 'Nomsa', what: 'Invoice issued' }].concat(paid ? [{ at: at(payDay, 10), by: 'Nomsa', what: 'Payment R ' + total + ' (' + method + ') — paid in full' }] : []),
        createdAt: at(friday, 16), createdBy: 'Nomsa', updatedAt: at(paid ? payDay : friday, 16), updatedBy: 'Nomsa' };
      byCust[cid].forEach(({ o }) => { o.invoiceId = invId; o.invoiceNo = invoiceNo; o.events.push({ at: at(friday, 16), by: 'Nomsa', what: 'Invoiced on ' + invoiceNo }); });
      invoiceN++;
    });
    // the showroom till: shelf pieces, paid there and then
    const nSales = between(2, 4);
    for (let i = 0; i < nSales; i++) {
      const date = plus(mon, between(0, 5)); if (date > todayIso) continue;
      const saleNo = 'S-' + pad(saleN), invoiceNo = prefix + pad(invoiceN);
      const lines = []; const nl = rnd() < 0.3 ? 2 : 1;
      for (let k = 0; k < nl; k++) { const [name, price, pid] = pick(shelf); lines.push({ productId: pid, name, qty: 1, unitPrice: price, kind: 'stock', fabric: '', note: '' }); }
      const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)), vatAmt = r2(subtotal * vat), total = r2(subtotal + vatAmt);
      const method = pick(['Card', 'Card', 'Cash', 'EFT']);
      const invId = 'hs' + saleN;
      invoices[invId] = { invoiceNo, customerId: '', customerName: 'Walk-in customer', date, dueDate: date, lines: lines.map(l => ({ orderId: '', orderNo: '', externalRef: saleNo, description: l.name, qty: l.qty, unitPrice: l.unitPrice })),
        subtotal, vat: vatAmt, vatRate: vat, total, status: 'paid', paidAt: date, payments: [{ at: date, amount: total, method, ref: '', by: 'Nomsa' }], note: 'Till sale ' + saleNo, saleNo,
        events: [{ at: at(date, 14), by: 'Nomsa', what: 'Raised at the till (' + saleNo + ')' }], createdAt: at(date, 14), createdBy: 'Nomsa', updatedAt: at(date, 14), updatedBy: 'Nomsa' };
      sales['hsl' + saleN] = { saleNo, date, customerId: '', customerName: 'Walk-in customer', lines, subtotal, discount: 0, vat: vatAmt, total, paidNow: total, method, ref: '', balance: 0, invoiceId: invId, invoiceNo, note: '', by: 'Nomsa',
        createdAt: at(date, 14), createdBy: 'Nomsa', updatedAt: at(date, 14), updatedBy: 'Nomsa' };
      saleN++; invoiceN++;
    }
    // the week's wages, paid on the Friday: Sipho's pieces are this week's sofas and chairs
    const built = weekOrders.filter(x => ['3 Seater Chesterfield', 'Paris Chesterfield', 'Alaska 3 Seater 2.4m', 'Wingback Chair', '2 Seater Amber'].includes(x.o.product)).slice(0, between(2, 4));
    const pieces = built.map(({ id, o }) => { const h = hoursOf(o.product) * (o.qty || 1); return { orderId: id, orderNo: o.orderNo, product: o.product, hours: h, amount: r2(h * 95) }; });
    runs['w-' + mon] = { id: 'w-' + mon, kind: 'week', start: mon, end: plus(mon, 6), status: 'paid', paidAt: at(friday, 15), paidBy: 'Jean',
      lines: [
        { staffId: 's1', name: 'Sipho Dlamini', job: 'Upholsterer', payType: 'piece', rate: 95, uif: true, hours: pick([0, 0, 2, 4]), overtime: 0, pieces, bonus: 0, advances: 0, deductions: [], note: '' },
        { staffId: 's2', name: 'Thandi Mokoena', job: 'Sewing', payType: 'weekly', rate: 2600, uif: true, hours: 0, overtime: pick([0, 0, 2, 3, 5]), pieces: [], bonus: 0, advances: rnd() < 0.15 ? 300 : 0, deductions: (((w % 4) + 4) % 4 === 0) ? [{ what: 'Loan repayment', amount: 200 }] : [], note: '' },
        { staffId: 's3', name: 'Pieter Swart', job: 'Frames', payType: 'hourly', rate: 62, uif: true, hours: pick([45, 45, 45, 40, 36]), overtime: pick([0, 0, 3, 6, 8]), pieces: [], bonus: 0, advances: 0, deductions: [], note: '' }
      ], createdAt: at(friday, 15), createdBy: 'Jean', updatedAt: at(friday, 15), updatedBy: 'Jean' };
    // a supplier delivery every third week or so, received in full
    if (((w % 3) + 3) % 3 === 0 && matList.length) {
      const poNo = (settings.poPrefix || 'PO-') + pad(poN);
      const picked = matList.slice().sort(() => rnd() - 0.5).slice(0, between(2, 3));
      const lines = picked.map(m => { const q = m.unit === 'each' ? between(10, 40) : between(20, 120); return { materialId: m.id, name: m.name, unit: m.unit || '', qty: q, cost: Number(m.cost) || 0, received: q }; });
      const when = plus(mon, 2), supplier = pick(suppliers);
      pos['hpo' + poN] = { poNo, supplier, supplierPhone: '', supplierEmail: '', expectedDate: when, notes: '', lines, status: 'received', sentAt: at(plus(mon, -5), 10), receivedAt: at(when, 11),
        events: [{ at: at(plus(mon, -5), 10), by: 'Nomsa', what: 'Purchase order raised' }, { at: at(when, 11), by: 'Pieter', what: 'Received in full' }], createdAt: at(plus(mon, -5), 10), createdBy: 'Nomsa', updatedAt: at(when, 11), updatedBy: 'Pieter' };
      lines.forEach((l, i) => { moves['hmv' + poN + '-' + i] = { materialId: l.materialId, name: l.name, unit: l.unit, qty: l.qty, kind: 'received', ref: poNo, note: supplier, createdAt: at(when, 11), createdBy: 'Pieter', updatedAt: at(when, 11), updatedBy: 'Pieter' }; });
      poN++;
    }
    // a quote now and then: most won, some lost, one that lapsed
    if (((w % 4) + 4) % 4 === 2) {
      const cid = pick(['d-stellenbosch', 'd-durbanville', 'd-botha'].filter(c => customers[c])); const c = customers[cid] || {};
      const [product, price] = pick(catalogue); const qty = between(1, 3);
      const sent = plus(mon, 1), outcome = pick(['accepted', 'accepted', 'accepted', 'declined', 'expired']);
      const quoteNo = (settings.quotePrefix || 'Q-') + pad(quoteN);
      quotes['hq' + quoteN] = { quoteNo, customerId: cid, customerName: c.name || '', prospect: null, lines: [{ productId: '', description: product, fabric: pick(fabrics), qty, unitPrice: price }], discount: 0, validUntil: plus(sent, 14),
        notes: 'Lead time 4 weeks from deposit.', status: outcome === 'expired' ? 'sent' : outcome, sentAt: at(sent, 10), acceptedAt: outcome === 'accepted' ? at(plus(sent, between(1, 6)), 12) : '', declinedAt: outcome === 'declined' ? at(plus(sent, between(1, 6)), 12) : '',
        events: [{ at: at(sent, 10), by: 'Nomsa', what: 'Quote sent' }].concat(outcome === 'accepted' ? [{ at: at(plus(sent, 3), 12), by: 'Nomsa', what: 'Accepted' }] : outcome === 'declined' ? [{ at: at(plus(sent, 3), 12), by: 'Nomsa', what: 'Declined' }] : []),
        createdAt: at(sent, 10), createdBy: 'Nomsa', updatedAt: at(sent, 10), updatedBy: 'Nomsa' };
      quoteN++;
    }
  }
  // monthly salaries for the last five months
  for (let m = -5; m <= -1; m++) {
    const d = new Date(todayIso + 'T12:00:00'); const first = new Date(d.getFullYear(), d.getMonth() + m, 1, 12), last = new Date(d.getFullYear(), d.getMonth() + m + 1, 0, 12);
    const ym = localDate(first).slice(0, 7), end = localDate(last);
    runs['m-' + ym] = { id: 'm-' + ym, kind: 'month', start: ym + '-01', end, status: 'paid', paidAt: at(plus(end, -5), 12), paidBy: 'Jean',
      lines: [{ staffId: 's4', name: 'Nomsa Jacobs', job: 'Office', payType: 'monthly', rate: 14500, uif: true, hours: 0, overtime: 0, pieces: [], bonus: 0, advances: 0, deductions: [], note: '' }],
      createdAt: at(end, 12), createdBy: 'Jean', updatedAt: at(end, 12), updatedBy: 'Jean' };
  }
  demoWrite('orders', orders); demoWrite('invoices', invoices); demoWrite('sales', sales); demoWrite('wageRuns', runs);
  demoWrite('purchaseOrders', pos); demoWrite('stockMoves', moves); demoWrite('quotes', quotes);
  counters.invoiceNo = { value: Math.max(invoiceN, (counters.invoiceNo && counters.invoiceNo.value) || 0) };
  counters.saleNo = { value: Math.max(saleN, (counters.saleNo && counters.saleNo.value) || 0) };
  counters.poNo = { value: Math.max(poN, (counters.poNo && counters.poNo.value) || 0) };
  counters.quoteNo = { value: Math.max(quoteN, (counters.quoteNo && counters.quoteNo.value) || 0) };
  counters.demoHistory = { value: 1 };
  demoWrite('counters', counters);
}

// The stock room: people, a few tools, and some stock already given out.
function seedDemoStoreroom() {
  const st = demoRead('storeStaff');
  if (st['sp1']) return;
  const now = nowIso();
  Object.assign(st, {
    sp1: { name: 'Sipho Dlamini', job: 'Upholsterer', phone: '082 111 2222', createdAt: now, createdBy: 'demo' },
    sp2: { name: 'Thandi Mokoena', job: 'Sewing', phone: '083 222 3333', createdAt: now, createdBy: 'demo' },
    sp3: { name: 'Pieter Swart', job: 'Frames', phone: '084 333 4444', createdAt: now, createdBy: 'demo' }
  });
  demoWrite('storeStaff', st);
  const as = demoRead('assets');
  const ev = (what) => [{ at: now, by: 'demo', what }];
  Object.assign(as, {
    as1: { name: 'Pneumatic staple gun', tag: 'T-001', category: 'Tool', status: 'issued', holderId: 'sp1', holderName: 'Sipho Dlamini', issuedAt: now, events: ev('Given to Sipho Dlamini'), createdAt: now, createdBy: 'demo' },
    as2: { name: 'Pneumatic staple gun', tag: 'T-002', category: 'Tool', status: 'store', events: ev('Received into the stock room'), createdAt: now, createdBy: 'demo' },
    as3: { name: 'Industrial sewing machine', tag: 'M-001', category: 'Machine', serial: 'JK-58420', status: 'issued', holderId: 'sp2', holderName: 'Thandi Mokoena', issuedAt: now, events: ev('Given to Thandi Mokoena'), createdAt: now, createdBy: 'demo' },
    as4: { name: 'Compressor 50L', tag: 'M-002', category: 'Machine', status: 'repair', events: ev('Sent for repair: pressure switch'), createdAt: now, createdBy: 'demo' }
  });
  demoWrite('assets', as);
  const mv = demoRead('stockMoves');
  const give = (k, mat, name, unit, qty, person, pid, ref) => { mv[k] = { materialId: mat, name, unit, qty, kind: 'issued', ref, note: '', person, personId: pid, createdAt: now, createdBy: 'demo' }; };
  give('mvi1', 'm-foam', 'Foam 50mm HD', 'm²', 5, 'Sipho Dlamini', 'sp1', 'CP-1003');
  give('mvi2', 'm-web', 'Elastic webbing', 'm', 40, 'Pieter Swart', 'sp3', 'CP-1008');
  give('mvi3', 'm-fab', 'Fabric (standard range)', 'm', 14, 'Thandi Mokoena', 'sp2', 'CP-1003');
  demoWrite('stockMoves', mv);
}

function seedDemoExtras() {
  seedDemoStock();
  seedDemoStoreroom();
  seedDemoQuotes();
  const orders = demoRead('orders');
  if (orders['r1']) return;
  let seed = 20261006;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDate(d); };
  const monday = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDate(d); };

  const customers = demoRead('customers');
  const extraCust = {
    'd-stellenbosch': { name: 'Stellenbosch Interiors', contact: 'Anél', phone: '021 887 0000', email: 'orders@stbinteriors.co.za', area: 'Stellenbosch', address: '4 Dorp Street, Stellenbosch', termsDays: 30 },
    'd-durbanville': { name: 'Durbanville Décor', contact: 'Pieter', phone: '021 975 0000', email: 'hello@durbanvilledecor.co.za', area: 'Durbanville', address: 'Shop 12, Tyger Valley Centre', termsDays: 14 },
    'd-botha': { name: 'Private client — M. Botha', contact: 'Marius Botha', phone: '083 222 4455', email: '', area: 'Somerset West', address: '18 Vineyard Road, Somerset West', termsDays: 0 }
  };
  Object.keys(extraCust).forEach(id => { if (!customers[id]) customers[id] = { ...extraCust[id], createdAt: nowIso(), createdBy: 'demo' }; });
  demoWrite('customers', customers);

  const custIds = ['d-bellville', 'd-bellville', 'd-bellville', 'd-stellenbosch', 'd-durbanville', 'd-walkin', 'd-botha'];
  const products = [
    ['3 Seater Chesterfield', 8500], ['2 Seater Amber', 6400], ['Corner Unit 2.8 x 2.8', 15900], ['Daybed 2.4m', 11200], ['Ottoman 900mm', 2400],
    ['Alaska 3 Seater 2.4m', 9200], ['Paris Chesterfield', 12800], ['Wingback Chair', 4600]
  ];
  const fabrics = ['Moldova : Oatmeal', 'Adore : Flint Grey', 'Magical : Eclipse', 'Hertex Velvet : Forest', 'Linen Look : Natural', 'Boucle : Cream', 'Leather : Tan', ''];
  const statuses = ['new', 'new', 'new', 'in-production', 'in-production', 'in-production', 'in-production', 'ready', 'ready', 'dispatched'];
  let n = 1006;
  let bvRef = 3210;
  for (let i = 1; i <= 20; i++) {
    const cid = pick(custIds);
    const c = customers[cid] || {};
    const [product, price] = pick(products);
    const status = pick(statuses);
    const fabric = pick(fabrics);
    const paidOffset = -Math.floor(rnd() * 42);
    const paidDate = day(paidOffset);
    const dueDate = day(paidOffset + 28);
    const qty = rnd() < 0.15 ? 2 : 1;
    const o = {
      orderNo: 'CP-' + n++, customerId: cid, customerName: c.name || '',
      externalRef: cid === 'd-bellville' ? String(bvRef++) : '', source: cid === 'd-bellville' ? 'feed' : 'manual',
      product, qty, fabric,
      fabricStatus: !fabric ? 'none' : status === 'new' ? pick(['none', 'ordered', 'ordered', 'received']) : pick(['ordered', 'received', 'received', 'received']),
      notes: pick(['', '', '', 'Client wants dark feet', 'Extra scatter cushions ×2', 'Deliver before month end', 'Firm seat foam please']),
      paidDate, dueDate, priceEach: price, status, events: [{ at: nowIso(), by: 'demo', what: 'Order captured' }],
      createdAt: nowIso(), createdBy: 'demo', updatedAt: nowIso(), updatedBy: 'demo'
    };
    if (status === 'in-production' || status === 'ready') o.planWeek = monday(pick([0, 0, 7, 7, 14]));
    if (status === 'new' && rnd() < 0.5) o.planWeek = monday(pick([7, 14, 21]));
    if (status === 'ready') o.readyAt = day(-Math.floor(rnd() * 4));
    if (status === 'dispatched') o.readyAt = day(-Math.floor(rnd() * 6 + 1));
    if (status === 'dispatched') { o.dispatchedAt = new Date(Date.now() - Math.floor(rnd() * 5 + 1) * 86400000).toISOString(); o.dispatchedBy = pick(['Sipho', 'Thandi']); }
    orders['r' + i] = o;
  }
  demoWrite('orders', orders);
  const counters = demoRead('counters');
  counters.orderNo = { value: Math.max(n, (counters.orderNo && counters.orderNo.value) || 0) };
  demoWrite('counters', counters);
}

export const createWithId = setWithId;
