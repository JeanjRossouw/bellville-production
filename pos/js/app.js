// Retail POS — the shell: sign-in, the menu, and the screens of step 2
// (Home, Staff, Devices, Me). Later steps add Sell, Products, Admin.
import { API, APP_VERSION, ROLES, DEFAULTS } from './config.js';
import { initFirebase, watch, getOne, patchOne } from './db.js';
import * as auth from './auth.js';
import { esc, toast, openModal, field, row, val, checks, empty, niceDate, niceTime, money } from './ui.js';
import * as admin from './admin.js';
import { icon } from './icons.js';
import * as products from './products.js';
import * as sell from './sell.js';
import * as salesTab from './sales.js';
import * as register from './register.js';
import * as sync from './sync.js';
import * as returns from './returns.js';
import * as laybys from './laybys.js';
import * as specials from './specials.js';
import * as stock from './stock.js';
import * as buying from './buying.js';
import * as customersTab from './customers.js';
import * as reports from './reports.js';
import * as online from './online.js';
import * as assist from './assist.js';
import * as tasks from './tasks.js';
import * as overview from './overview.js';
import { openCostImport } from './costimport.js';
import * as fabricsTab from './fabrics.js';
import * as quotesTab from './quotes.js';
import * as todo from './todo.js';
import { EMULATOR } from './db.js';

const $ = (id) => document.getElementById(id);
let view = '';                       // the tab on screen; a till starts on Sell, the office on Home
let adminSub = 'companies';          // the Admin tab's sub-screen
let editId = '', settingsEntity = '';  // what the admin forms are on
let entities = [], stores = [], registers = [], users = [], devices = [], settings = {};
let fabrics = [], catalogue = [], variants = [], stockLevels = [], customers = [], storeSales = [], storeLaybys = [], storeSpecials = [], storeSalesOrders = [], storeQuotes = [], storeTasks = [], storeTakes = [], discountCodes = [], suppliers = [], storePOs = [], storeGrvs = [], transfersOut = [], transfersIn = [], stockOffsets = {};
let sellStore = '';                 // the store being sold from: the till's, else chosen
let prEntity = '', prFilter = { q: '', category: '', brand: '', type: '', supplier: '', archived: false };
const unwatch = [];
let unwatchStore = null, watchedStore = '';   // the sell screen's own stock watch, by store

// ------------------------------------------------------------------ boot --
async function main() {
  await initFirebase();
  auth.onSession(onSession);
  auth.watchIdle();
  wireLogin();
  $('screen').addEventListener('click', onAction);
  $('billing-bar').addEventListener('click', (e) => { const b = e.target.closest('[data-bill]'); if (b) billAction(b.dataset.bill); });
  $('sign-out').addEventListener('click', () => auth.signOut());
  $('lock').addEventListener('click', () => auth.lock());
  // the phone menu: one button in the top bar, a sheet with every screen
  $('menu-btn').addEventListener('click', () => openMobileMenu($('mnav').hidden));
  $('mnav').addEventListener('click', (e) => {
    if (e.target.closest('[data-mclose]')) return openMobileMenu(false);
    if (e.target.closest('#m-sign-out')) { openMobileMenu(false); return auth.signOut(); }
    const b = e.target.closest('[data-view]');
    if (b) { openMobileMenu(false); const t = $('nav').querySelector(`[data-view="${b.dataset.view}"]`); if (t) t.click(); window.scrollTo(0, 0); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('mnav').hidden) openMobileMenu(false); });
  // a click outside an open drop-down, or Escape, puts it away
  document.addEventListener('click', (e) => { if (!e.target.closest('#nav')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  $('nav').addEventListener('click', (e) => { const g = e.target.closest('[data-group]'); if (g) return toggleMenu(g); const b = e.target.closest('[data-view]'); if (b) { closeMenus(); if (view === 'stock' && b.dataset.view !== 'stock' && stock.st.camera) stock.action('st-camera', b); view = b.dataset.view; editId = ''; if (view === 'register') register.reg.stale = true; paint(); } });
  await auth.boot();
  sync.setContext({ repaint: () => { paintBanner(); reloadOffsets(); if (view === 'register') paint(); }, storeId: sellStoreId });   // reloadOffsets repaints Sell itself
  sync.watchNetwork();
  overview.setContext({ repaint: () => { if (view === 'overview') paint(); }, shops: () => ({ entities, stores }) });
  if ('serviceWorker' in navigator && !EMULATOR) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.POS = { requireOverride: auth.requireOverride, forceIdle: auth.forceIdle, session: auth.session, version: APP_VERSION };   // for tests and the console
}

function onSession(s) {
  if (s.user) { startData(); showApp(); }
  else { stopData(); showLogin(); }
}

// ---------------------------------------------------------------- data --
// What the signed-in person may list, filtered the way the rules can prove.
function startData() {
  stopData();
  const u = auth.session.user;
  const owner = u.role === 'owner';
  const ents = u.entityIds || [], sts = u.storeIds || [];
  const w = (name, wheres, set) => unwatch.push(watch(name, wheres, rows => { set(rows); paint(); }));
  const bySettings = (rows) => { settings = Object.fromEntries(rows.map(r => [r.id, r])); };
  if (owner) { w('entities', [], r => { entities = r; }); w('stores', [], r => { stores = r; }); w('registers', [], r => { registers = r; }); w('settings', [], bySettings); w('products', [], r => { catalogue = r; }); w('variants', [], r => { variants = r; }); w('fabrics', [], r => { fabrics = r; }); w('customers', [], r => { if (view === 'customers') setTimeout(paint, 0); customers = r; }); }
  else {
    if (ents.length) { w('entities', [['entityId', 'in', ents.slice(0, 30)]], r => { entities = r; }); w('settings', [['entityId', 'in', ents.slice(0, 30)]], bySettings); w('products', [['entityId', 'in', ents.slice(0, 30)]], r => { catalogue = r; }); w('variants', [['entityId', 'in', ents.slice(0, 30)]], r => { variants = r; }); w('fabrics', [['entityId', 'in', ents.slice(0, 30)]], r => { fabrics = r; }); w('customers', [['entityId', 'in', ents.slice(0, 30)]], r => { customers = r; }); }
    // a store-scoped query must name both the entity and the store for the rules to allow it
    if (ents.length && sts.length) { w('stores', [['entityId', 'in', ents.slice(0, 10)], ['storeId', 'in', sts.slice(0, 10)]], r => { stores = r; }); w('registers', [['entityId', 'in', ents.slice(0, 10)], ['storeId', 'in', sts.slice(0, 10)]], r => { registers = r; }); }
  }
  if (auth.atLeast('supervisor')) { if (owner) w('suppliers', [], r => { suppliers = r; if (view === 'buying') paint(); }); else if (ents.length) w('suppliers', [['entityId', 'in', ents.slice(0, 30)]], r => { suppliers = r; if (view === 'buying') paint(); }); }
  if (owner) w('discountCodes', [], r => { discountCodes = r; }); else if (ents.length) w('discountCodes', [['entityId', 'in', ents.slice(0, 30)]], r => { discountCodes = r; });
  if (auth.atLeast('manager')) {
    w('users', [], r => { users = r; });
    if (owner) w('devices', [], r => { devices = r; });
    else if (ents.length && sts.length) w('devices', [['entityId', 'in', ents.slice(0, 10)], ['storeId', 'in', sts.slice(0, 10)]], r => { devices = r; });
  }
  startStoreData();
  // the idle time comes from the entity's settings (the till's entity, else the person's first)
  const eid = (auth.session.device && auth.session.device.entityId) || ents[0] || (owner ? '' : '');
  if (eid) getOne('settings', eid).then(s => auth.setIdleMinutes((s && s.session && s.session.idleLogoutMinutes) || DEFAULTS.idleLogoutMinutes)).catch(() => {});
}
function stopData() {
  overview.stop();
  while (unwatch.length) { try { unwatch.pop()(); } catch (e) {} }
  if (unwatchStore) { try { unwatchStore(); } catch (e) {} unwatchStore = null; } watchedStore = ''; storeSales = []; storeLaybys = []; storeSpecials = []; storeSalesOrders = []; storeQuotes = []; storeTasks = []; storeTakes = []; storePOs = []; storeGrvs = []; transfersOut = []; transfersIn = []; suppliers = []; discountCodes = []; stockLevels = [];   // or it would go on listening as the next person
  entities = []; stores = []; registers = []; users = []; devices = []; settings = {}; fabrics = []; catalogue = []; variants = []; stockLevels = []; customers = [];
}
// the store sold from: the till's own, else the person's default, else their first
function sellStoreId() {
  const u = auth.session.user; if (!u) return '';
  const d = auth.session.device;
  if (d && d.storeId) return d.storeId;
  if (sellStore && auth.inStore(sellStore)) return sellStore;
  if (u.defaultStoreId && auth.inStore(u.defaultStoreId)) return u.defaultStoreId;
  return u.role === 'owner' ? (stores[0] || {}).id || '' : (u.storeIds || [])[0] || '';
}
function startStoreData() {
  const sid = sellStoreId();
  if (sid === watchedStore) return;
  if (unwatchStore) { try { unwatchStore(); } catch (e) {} unwatchStore = null; }
  watchedStore = sid; stockLevels = []; storeSales = []; storeLaybys = []; storeSpecials = []; storeSalesOrders = []; storeQuotes = []; storeTasks = []; storeTakes = []; storePOs = []; storeGrvs = []; transfersOut = []; transfersIn = [];
  if (!sid) return;
  const st = stores.find(x => x.id === sid);
  const eid = st ? st.entityId : (auth.session.device && auth.session.device.entityId) || '';
  if (!eid) { watchedStore = ''; return; }   // the stores are not loaded yet: try again when they are
  const u1 = watch('stockLevels', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { stockLevels = rows; if (view === 'sell' || view === 'stock' || view === 'buying') paint(); });
  const u2 = watch('sales', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeSales = rows; if (view === 'sales') paint(); });
  const u3 = watch('laybys', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeLaybys = rows; if (view === 'laybys') paint(); });
  const u4 = watch('specialOrders', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeSpecials = rows; if (view === 'orders' || view === 'todo') paint(); });
  const u4q = watch('quotes', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeQuotes = rows; if (view === 'quotes' || view === 'todo') paint(); });
  const u4b = watch('salesOrders', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeSalesOrders = rows; if (view === 'orders') paint(); });
  const u4c = watch('tasks', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeTasks = rows; if (view === 'home') paint(); });
  const u5 = auth.atLeast('supervisor') ? watch('stockTakes', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeTakes = rows; if (view === 'stock') paint(); }) : () => {};
  const sup = auth.atLeast('supervisor');
  const u6 = sup ? watch('purchaseOrders', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storePOs = rows; if (view === 'buying') paint(); }) : () => {};
  const u7 = sup ? watch('goodsReceived', [['entityId', '==', eid], ['storeId', '==', sid]], rows => { storeGrvs = rows; if (view === 'buying') paint(); }) : () => {};
  const u8 = sup ? watch('transfers', [['entityId', '==', eid], ['fromStoreId', '==', sid]], rows => { transfersOut = rows; if (view === 'buying') paint(); }) : () => {};
  const u9 = sup ? watch('transfers', [['entityId', '==', eid], ['toStoreId', '==', sid]], rows => { transfersIn = rows; if (view === 'buying') paint(); }) : () => {};
  unwatchStore = () => { u1(); u2(); u3(); u4(); u4b(); u4q(); u4c(); u5(); u6(); u7(); u8(); u9(); };
  sell.loadCart(sid);
  reloadOffsets();
}
const sellData = () => { const sid = sellStoreId(); const st = stores.find(x => x.id === sid) || null; const ent = st ? entities.find(e => e.id === st.entityId) || null : null; return { store: st, entity: ent, settings: ent ? settings[ent.id] || {} : {}, products: catalogue, variants, fabrics: ent ? fabrics.filter(f => f.entityId === ent.id) : [], stockLevels, stockOffsets, customers, discountCodes: ent ? discountCodes.filter(x => x.entityId === ent.id) : [], registerId: register.registerId(), shiftOpen: register.canSell(), shiftKnown: !register.registerId() || !!register.reg.state }; };
async function reloadOffsets() { stockOffsets = await sync.stockOffsets(); if (view === 'sell') paint(); }
function paintBanner() { const bar = $('offline-bar'); if (!bar) return; const html = sync.bannerHtml(); bar.hidden = !html; bar.className = sync.bannerClass(); bar.innerHTML = html; }

// --------------------------------------------------------------- login --
function wireLogin() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-submit'); btn.disabled = true; $('login-msg').textContent = '';
    try { await auth.signInEmail(val(document, 'login-email'), $('login-pass').value); }
    catch (err) { $('login-msg').textContent = friendlyAuthError(err); }
    btn.disabled = false;
  });
  $('login-switch').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setLoginMode(b.dataset.mode); });
  $('claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await auth.claimGroup(val(document, 'claim-name'), val(document, 'claim-group')); toast('You are the owner. Add your companies and stores under Admin.'); }
    catch (err) { toast(err.message, 'warn'); }
  });
  $('claim-out').addEventListener('click', () => auth.signOut());
  $('nobody-out').addEventListener('click', () => auth.signOut());
  // a new business
  $('to-signup').addEventListener('click', () => showSignup(false));
  $('nobody-start').addEventListener('click', () => showSignup(true));
  $('signup-back').addEventListener('click', () => { if (auth.session.uid) auth.signOut(); else { $('signup').hidden = true; $('login').hidden = false; } });
  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signup-submit'); btn.disabled = true; $('signup-msg').textContent = '';
    const loggedIn = !!auth.session.uid;
    const pass = $('signup-pass').value;
    if (!loggedIn && pass.length < 6) { $('signup-msg').textContent = 'The password needs 6 or more characters.'; btn.disabled = false; return; }
    try {
      await auth.signUp({ email: val(document, 'signup-email'), password: pass, businessName: val(document, 'signup-business'), name: val(document, 'signup-name') });
      toast('Welcome. Your 14-day trial has started: add your company and store under Admin.');
    } catch (err) { $('signup-msg').textContent = /email-already-in-use/.test(err.code || '') ? 'That email already has a login: sign in instead, or use another email.' : friendlyAuthError(err); }
    btn.disabled = false;
  });
  if (/[?&]signup=1/.test(location.search)) setTimeout(() => { if (!auth.session.user) showSignup(!!auth.session.uid); }, 300);
  if (/[?&]billing=done/.test(location.search)) toast('Thank you. Your subscription starts as soon as PayFast confirms the payment, usually within a minute.');
  if (/[?&]billing=cancelled/.test(location.search)) toast('Payment cancelled: nothing was charged.', 'warn');
  fetch(API.billing + '?plan=1').then(r => r.ok ? r.json() : null).then(j => { if (j && j.plan) document.querySelectorAll('[data-pos-price]').forEach(el => { el.textContent = 'R ' + j.plan.amount; }); }).catch(() => {});
}
// the sign-up form: everything for a new person, or only the names for a login that has no business yet
function showSignup(loggedIn) {
  $('login').hidden = true; $('nobody').hidden = true; $('claim').hidden = true; $('signup').hidden = false;
  document.querySelectorAll('#signup [data-new]').forEach(el => { el.hidden = loggedIn; el.querySelector('input').required = !loggedIn; });
  $('signup-msg').textContent = '';
  setTimeout(() => { const f = $('signup-business'); if (f) f.focus(); }, 50);
}

// ---- the business's standing: a trial, paid up, or read only (pos-billing)
let standing = null;
async function loadStanding() {
  try { standing = await auth.api('status', {}, API.billing); } catch (e) { standing = null; }
  paintStanding();
}
function paintStanding() {
  const bar = $('billing-bar'); if (!bar) return;
  const s = standing;
  if (!s || s.status === 'free' || !auth.session.user) { bar.hidden = true; return; }
  const price = 'R ' + s.plan.amount + ' a month';
  const pay = s.owner ? `<button class="btn sm" data-bill="checkout">Subscribe · ${esc(price)}</button>` : '<span>The owner subscribes.</span>';
  let html = '', cls = 'billing-bar';
  if (s.access === 'locked') { cls += ' locked'; html = `<strong>Read only.</strong> ${s.why === 'trialOver' ? 'The free trial has ended.' : 'The subscription has ended.'} Everything is still here to see; subscribe to carry on selling. ${pay}`; }
  else if (s.status === 'trial') html = `Free trial: <strong>${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left</strong>. ${pay}`;
  else if (s.status === 'cancelled') html = `Cancelled: it works until ${esc(String(s.until).slice(0, 10))}. ${pay}`;
  else if (s.status === 'active') html = `Subscribed · ${esc(price)} · paid to ${esc(String(s.until).slice(0, 10))}${s.owner && s.canCancel ? ' · <button class="link" data-bill="cancel">Cancel the subscription</button>' : ''}`;
  bar.className = cls; bar.innerHTML = html; bar.hidden = !html;
}
async function billAction(act) {
  if (act === 'checkout') {
    try {
      const r = await auth.api('checkout', {}, API.billing);
      const f = document.createElement('form'); f.method = 'POST'; f.action = r.action;
      for (const [k, v] of r.fields) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
      document.body.appendChild(f); f.submit();
    } catch (e) { toast(e.message, 'warn'); }
  }
  if (act === 'cancel') {
    if (!confirm('Cancel the subscription? No more payments are taken, and the POS works until the end of the month already paid for.')) return;
    try { await auth.api('cancel', {}, API.billing); toast('Cancelled. It works until the end of the month paid for.'); await loadStanding(); } catch (e) { toast(e.message, 'warn'); }
  }
}
function friendlyAuthError(err) {
  const c = (err && err.code) || '';
  if (/wrong-password|invalid-credential|user-not-found|invalid-login/.test(c)) return 'That email and password do not match.';
  if (/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes.';
  if (/network/.test(c)) return 'No connection.';
  return err && err.message ? err.message : 'Could not sign in.';
}
let pinPad = null;
function setLoginMode(mode) {
  const hasDevice = !!auth.session.device;
  if (!hasDevice) mode = 'email';
  $('login-pin').hidden = mode !== 'pin';
  $('login-form').hidden = mode !== 'email';
  $('login-switch').querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('login-switch').hidden = !hasDevice;
  if (mode === 'pin' && !pinPad) {
    const { pinPadHtml, wirePinPad } = window.__ui;
    $('login-pin').innerHTML = `<div class="pin-store">${esc(auth.session.device.label || 'Till')}</div>` + pinPadHtml({ title: 'Type your PIN', length: DEFAULTS.pinLength });
    pinPad = wirePinPad($('login-pin').querySelector('.pinpad'), async (pin) => { await auth.signInPin(pin); });
  }
  if (mode !== 'pin') pinPad = null;
}
function showLogin() {
  if (auth.session.signingUp) return;
  $('app').hidden = true; $('claim').hidden = true; $('nobody').hidden = true; $('signup').hidden = true;
  assist.stopAssistant();
  const fbUser = auth.session.uid && !auth.session.user;
  if (fbUser && auth.session.nobodyYet) { $('login').hidden = true; $('claim').hidden = false; return; }
  if (fbUser) { $('login').hidden = true; $('nobody').hidden = false; return; }
  $('login').hidden = false;
  $('login-device').textContent = auth.session.device ? 'This till: ' + (auth.session.device.label || '') : '';
  setLoginMode(auth.session.device ? 'pin' : 'email');
}

// ----------------------------------------------------------------- app --
function showApp() {
  if (auth.session.signingUp) return;
  $('login').hidden = true; $('claim').hidden = true; $('nobody').hidden = true; $('signup').hidden = true; $('app').hidden = false;
  loadStanding();
  const u = auth.session.user;
  $('who').innerHTML = `<strong>${esc(u.name)}</strong><small>${esc(roleLabel(u.role))}${auth.session.mode === 'pin-offline' ? ' · offline' : ''}</small>`;
  $('lock').hidden = auth.session.mode === 'email';
  $('brand-sub').textContent = auth.session.device ? (storeName(auth.session.device.storeId) || auth.session.device.label) : 'Office';
  if (!view || !navItems().some(n => n.key === view)) view = sellStoreId() && auth.session.mode !== 'email' ? 'sell' : 'home';
  paint();
  assist.startAssistant(() => view, () => { const sd = sellData(); return { entityId: sd.entity ? sd.entity.id : '', storeId: sd.store ? sd.store.id : '' }; }, () => { register.reg.stale = true; if (view === 'home' || view === 'buying' || view === 'orders' || view === 'laybys') paint(); });
}
const roleLabel = (k) => (ROLES.find(r => r.key === k) || { label: k }).label;
const storeName = (id) => (stores.find(s => s.id === id) || {}).name || '';
const entityName = (id) => { const e = entities.find(x => x.id === id); return e ? (e.tradingName || e.legalName) : id; };
// The phone menu sheet: the same screens as the tabs, then who is signed in and Sign out.
function paintMobileMenu(items) {
  const u = auth.session.user || {};
  $('mnav').innerHTML = `<div class="mnav-top"><span class="mnav-brand">Point of sale</span><button class="mnav-close" data-mclose aria-label="Close the menu">✕</button></div>
    <div class="mnav-body"><div class="mnav-group">${items.map(n => `<button class="mnav-item${n.key === view ? ' on' : ''}" data-view="${n.key}">${esc(n.label)}</button>`).join('')}</div></div>
    <div class="mnav-foot"><div class="mnav-who"><strong>${esc(u.name || '')}</strong><span>${esc(roleLabel(u.role))}</span></div><button class="btn ghost wide" id="m-sign-out">Sign out</button></div>`;
}
function openMobileMenu(open) {
  if (open) paintMobileMenu(navItems());
  $('mnav').hidden = !open;
  $('menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
  document.documentElement.classList.toggle('mnav-open', !!open);
}
// The screens this person may open, in menu order. Those with a group sit in
// a drop-down on the bar (a group with one screen shows as a plain tab); the
// phone sheet lists them all in the same order.
const GROUPS = { sales: 'Sales', stock: 'Stock', office: 'Office' };
function navItems() {
  const out = [];
  const store = !!sellStoreId();
  if (store) out.push({ key: 'sell', label: 'Sell' });
  if (register.registerId()) out.push({ key: 'register', label: 'Register' });
  out.push({ key: 'home', label: 'Home' });
  if (store) out.push({ key: 'todo', label: 'To do', group: 'sales' }, { key: 'sales', label: 'Sales', group: 'sales' }, { key: 'returns', label: 'Returns', group: 'sales' }, { key: 'laybys', label: 'Lay-bys', group: 'sales' }, { key: 'orders', label: 'Sales orders', group: 'sales' }, { key: 'quotes', label: 'Quotes', group: 'sales' }, { key: 'customers', label: 'Customers', group: 'sales' });
  if (store && auth.atLeast('supervisor')) out.push({ key: 'stock', label: 'Stock', group: 'stock' }, { key: 'buying', label: 'Buying', group: 'stock' });
  out.push({ key: 'products', label: 'Products', group: 'stock' });
  if (auth.atLeast('supervisor')) out.push({ key: 'fabrics', label: 'Fabrics', group: 'stock' });
  if (store && auth.atLeast('supervisor')) out.push({ key: 'online', label: 'Online', group: 'stock' });
  if (auth.session.user.role === 'owner') out.push({ key: 'overview', label: 'All businesses', group: 'office' });
  if (auth.atLeast('manager')) out.push({ key: 'reports', label: 'Reports', group: 'office' }, { key: 'admin', label: 'Admin', group: 'office' });
  out.push({ key: 'me', label: 'My PIN' });
  return out;
}
// The bar: plain tabs, and a drop-down per group (it says which of its
// screens is open, so you always see where you are).
function navHtml(items) {
  const seen = new Set(), parts = [];
  items.forEach(n => {
    if (!n.group) { parts.push(`<button class="tab${n.key === view ? ' on' : ''}" data-view="${n.key}">${esc(n.label)}</button>`); return; }
    if (seen.has(n.group)) return;
    seen.add(n.group);
    const members = items.filter(x => x.group === n.group);
    if (members.length === 1) { parts.push(`<button class="tab${n.key === view ? ' on' : ''}" data-view="${n.key}">${esc(n.label)}</button>`); return; }
    const cur = members.find(x => x.key === view);
    parts.push(`<div class="tab-wrap"><button class="tab tab-group${cur ? ' has-on' : ''}" data-group="${n.group}" aria-haspopup="true" aria-expanded="false"><span>${esc(GROUPS[n.group])}</span>${cur ? `<span class="tg-now">· ${esc(cur.label)}</span>` : ''}<i class="caret" aria-hidden="true"></i></button>
      <div class="tab-menu" data-menu="${n.group}" hidden role="menu">${members.map(x => `<button class="tab tab-item${x.key === view ? ' on' : ''}" data-view="${x.key}" role="menuitem">${esc(x.label)}</button>`).join('')}</div></div>`);
  });
  return parts.join('');
}
function closeMenus() {
  document.querySelectorAll('#nav .tab-menu').forEach(m => { m.hidden = true; });
  document.querySelectorAll('#nav [data-group]').forEach(g => g.setAttribute('aria-expanded', 'false'));
}
function toggleMenu(g) {
  const m = $('nav').querySelector(`[data-menu="${g.dataset.group}"]`); if (!m) return;
  const open = m.hidden;
  closeMenus();
  m.hidden = !open; g.setAttribute('aria-expanded', open ? 'true' : 'false');
}
// the Admin sub-screens: companies and stores are the owner's; the rest a manager's too
function adminSubs() {
  const owner = auth.session.user.role === 'owner';
  return [
    { key: 'companies', label: 'Companies', show: true }, { key: 'stores', label: 'Stores', show: true },
    { key: 'registers', label: 'Registers', show: true }, { key: 'settings', label: 'Settings', show: true },
    { key: 'staff', label: 'Staff', show: true }, { key: 'devices', label: 'Devices', show: true }
  ].filter(x => x.show || owner);
}
const adminData = () => ({ entities, stores, registers, users, devices, settings, editId, settingsEntity });
const prData = () => ({ entities, stores, settings, products: catalogue, variants, suppliers, prEntity, prFilter });
// the company whose products are on screen
const prEntityId = () => { const t = document.querySelector('.pr-tbl'); if (t) return t.dataset.entity; const sel = document.getElementById('pr-entity'); if (sel) return sel.value; const mine = entities.filter(e => auth.inEntity(e.id)); return prEntity && mine.some(e => e.id === prEntity) ? prEntity : (mine[0] || {}).id || ''; };
function paint() {
  if (!auth.session.user) return;
  const items = navItems();
  $('nav').innerHTML = navHtml(items);
  $('menu-now').textContent = (items.find(n => n.key === view) || { label: '' }).label;
  if (!$('mnav').hidden) paintMobileMenu(items);
  const screen = $('screen');
  if (view === 'sell') {
    startStoreData();
    const mine = stores.filter(s => auth.inStore(s.id));
    const pick = !auth.session.device && mine.length > 1 ? `<div class="sell-store">${icon('shop')} <select id="sl-store">${mine.map(s => `<option value="${esc(s.id)}"${s.id === sellStoreId() ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>` : '';
    screen.innerHTML = pick + sell.sellHtml();
    return;
  }
  if (view === 'sales') { startStoreData(); screen.innerHTML = salesTab.salesHtml({ ...sellData(), sales: storeSales }); return; }
  if (view === 'register') { startStoreData(); screen.innerHTML = register.registerHtml(); return; }
  if (view === 'laybys') { startStoreData(); screen.innerHTML = laybys.laybysHtml(); return; }
  if (view === 'orders') { startStoreData(); screen.innerHTML = specials.specialsHtml(); return; }
  if (view === 'buying') { startStoreData(); screen.innerHTML = buying.buyingHtml(); return; }
  if (view === 'customers') { screen.innerHTML = customersTab.customersHtml(); return; }
  if (view === 'reports') { screen.innerHTML = reports.reportsHtml(); return; }
  if (view === 'fabrics') { screen.innerHTML = fabricsTab.fabricsHtml(); return; }
  if (view === 'quotes') { startStoreData(); screen.innerHTML = quotesTab.quotesHtml(); return; }
  if (view === 'todo') { startStoreData(); screen.innerHTML = todo.todoHtml(); return; }
  if (view === 'overview') { screen.innerHTML = overview.overviewHtml(); return; }
  if (view === 'online') { screen.innerHTML = online.onlineHtml(); online.ensure(); return; }
  if (view === 'stock') { startStoreData(); screen.innerHTML = stock.stockHtml(); const sc = $('tk-scan'); if (sc && !document.activeElement.closest('#screen')) sc.focus(); return; }
  if (view === 'returns') { startStoreData(); screen.innerHTML = returns.returnsHtml(); const q = $('rt-q'); if (q && !document.activeElement.closest('#screen')) q.focus(); return; }
  if (view === 'admin') {
    const subs = adminSubs();
    if (!subs.some(x => x.key === adminSub)) adminSub = subs[0].key;
    const body = adminSub === 'companies' ? admin.companiesHtml(adminData()) : adminSub === 'stores' ? admin.storesHtml(adminData())
      : adminSub === 'registers' ? admin.registersHtml(adminData()) : adminSub === 'settings' ? admin.settingsHtml(adminData())
      : adminSub === 'staff' ? staffHtml() : devicesHtml();
    screen.innerHTML = `<div class="subnav">${subs.map(x => `<button class="subtab${x.key === adminSub ? ' on' : ''}" data-sub="${x.key}">${esc(x.label)}</button>`).join('')}</div>` + body;
    const shop = $('se-shop'); if (shop) online.shopifyCard(screen, shop.dataset.entity, stores);
    const fac = $('se-factory'); if (fac) specials.factoryCard(screen, fac.dataset.entity);
    const drv = $('se-drivers'); if (drv) specials.driversCard(screen, drv.dataset.entity, ((stores || []).find(x => x.entityId === drv.dataset.entity && x.active !== false) || {}).id || '');
  }
  else if (view === 'products') { screen.innerHTML = products.productsHtml(prData()); const q = $('pr-q'); if (q && prFilter.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  else if (view === 'me') screen.innerHTML = meHtml();
  else { screen.innerHTML = homeHtml(); reports.dashboardHtml(screen); }
}
function goSub(sub) { adminSub = sub; editId = ''; paint(); }

function homeHtml() {
  const u = auth.session.user, d = auth.session.device;
  return `<div class="page-head"><h1>Home</h1>${u.role === 'owner' ? '<button class="btn ghost" data-act="go-overview">All businesses</button>' : ''}</div>
    ${auth.atLeast('manager') ? '<div id="dash" class="dash"><p class="muted">Loading today’s figures…</p></div>' : ''}
    ${tasks.tasksHtml()}
    <div class="grid two">
      <div class="card"><h2>Signed in</h2>
        <p><strong>${esc(u.name)}</strong> · ${esc(roleLabel(u.role))}${u.email ? ' · ' + esc(u.email) : ''}</p>
        <p class="muted">${u.role === 'owner' ? 'Every company and store.' : 'Companies: ' + (u.entityIds.map(entityName).join(', ') || 'none') + '. Stores: ' + (u.storeIds.map(s => storeName(s) || s).join(', ') || 'none') + '.'}</p>
        <p class="muted">${auth.session.mode === 'email' ? 'Signed in with email.' : auth.session.mode === 'pin-offline' ? 'Signed in with a PIN, offline.' : 'Signed in with a PIN.'}</p>
      </div>
      <div class="card"><h2>This device</h2>
        ${d ? `<p><strong>${esc(d.label)}</strong><br><span class="muted">${esc(entityName(d.entityId))} · ${esc(storeName(d.storeId) || d.storeId)}${d.registerId ? ' · ' + esc((registers.find(r => r.id === d.registerId) || {}).name || d.registerId) : ''}</span></p>`
          : `<p class="muted">Not an enrolled till. ${auth.atLeast('manager') ? 'Enrol it under Devices to let staff sign in here with a PIN.' : 'Staff sign in with a PIN only on an enrolled till.'}</p>`}
      </div>
    </div>
    <p class="muted" style="margin-top:1rem">Version ${esc(APP_VERSION)}.</p>`;
}

// ---------------------------------------------------------------- staff --
function staffHtml() {
  const me = auth.session.user;
  const roleOpts = ROLES.filter(r => me.role === 'owner' || ['cashier', 'supervisor'].includes(r.key)).map(r => ({ value: r.key, label: r.label }));
  const myEnts = me.role === 'owner' ? entities : entities.filter(e => auth.inEntity(e.id));
  const mySts = me.role === 'owner' ? stores : stores.filter(s => auth.inStore(s.id));
  const sorted = [...users].sort((a, b) => (b.active - a.active) || String(a.name).localeCompare(String(b.name)));
  return `<div class="page-head"><h1>Staff</h1><p class="sub">${sorted.filter(u => u.active).length} active</p></div>
    <div class="card"><h2>Add someone</h2>
      ${row(field('Name', 'st-name', { placeholder: 'First name and surname' }), field('Role', 'st-role', { type: 'select', options: roleOpts, value: 'cashier' }))}
      ${row(field('Email (managers and owners sign in with it; staff may leave it out)', 'st-email', { type: 'email', placeholder: 'name@example.co.za', autocomplete: 'off' }), field('PIN (4–6 digits, for the till)', 'st-pin', { inputmode: 'numeric', placeholder: 'e.g. 482913', autocomplete: 'off' }))}
      <div class="fld-row">
        <div class="fld"><span>Companies</span><div class="checks">${myEnts.length ? myEnts.map(e => `<label><input type="checkbox" data-ent="${esc(e.id)}"> ${esc(e.tradingName || e.legalName)}</label>`).join('') : '<span class="muted">No companies yet (Admin → Companies, step 3)</span>'}</div></div>
        <div class="fld"><span>Stores</span><div class="checks">${mySts.length ? mySts.map(s => `<label><input type="checkbox" data-store="${esc(s.id)}"> ${esc(s.name)} <small class="muted">${esc(entityName(s.entityId))}</small></label>`).join('') : '<span class="muted">No stores yet</span>'}</div></div>
      </div>
      <div class="card-actions"><button class="btn primary" data-act="staff-add">Add</button></div>
    </div>
    <div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <thead><tr><th>Name</th><th>Role</th><th>Sign-in</th><th>Companies · stores</th><th></th></tr></thead>
      <tbody>${sorted.length ? sorted.map(u => `<tr class="${u.active ? '' : 'off'}">
        <td><strong>${esc(u.name)}</strong>${u.id === me.uid ? ' <small class="muted">(you)</small>' : ''}${u.active ? '' : ' <span class="chip">off</span>'}</td>
        <td>${esc(roleLabel(u.role))}</td>
        <td>${u.email ? esc(u.email) : '<span class="muted">PIN only</span>'}${u.pinSet ? ' · PIN set' : ' · <span class="warn">no PIN</span>'}</td>
        <td class="muted">${u.role === 'owner' ? 'all' : esc((u.entityIds || []).map(entityName).join(', ')) + ' · ' + esc((u.storeIds || []).map(s => storeName(s) || s).join(', '))}</td>
        <td class="r nowrap">${u.id !== me.uid && mayManage(u) ? `<button class="btn ghost sm" data-act="staff-pin" data-id="${esc(u.id)}">Set PIN</button> <button class="btn ghost sm" data-act="${u.active ? 'staff-off' : 'staff-on'}" data-id="${esc(u.id)}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>
      </tr>`).join('') : `<tr><td colspan="5">${empty('Nobody yet')}</td></tr>`}</tbody>
    </table></div>`;
}
function mayManage(u) {
  const me = auth.session.user;
  if (me.role === 'owner') return true;
  return me.role === 'manager' && ['cashier', 'supervisor'].includes(u.role) && (u.entityIds || []).every(auth.inEntity) && (u.storeIds || []).every(auth.inStore);
}
async function staffAdd() {
  const w = $('screen');
  const body = { name: val(w, 'st-name'), role: val(w, 'st-role'), email: val(w, 'st-email'), pin: val(w, 'st-pin'), entityIds: checks(w, 'data-ent'), storeIds: checks(w, 'data-store'), continueUrl: location.origin + location.pathname };
  if (!body.name) return toast('Give the person a name.', 'warn');
  try { const r = await auth.api('createUser', body); toast(r.text); }
  catch (e) { toast(e.message, 'warn'); }
}
function staffPin(uid) {
  const u = users.find(x => x.id === uid); if (!u) return;
  openModal('PIN for ' + u.name, field('New PIN (4–6 digits)', 'np-pin', { inputmode: 'numeric', autocomplete: 'off' }) + '<p class="muted">Tell them in person. It is never shown again.</p>', {
    okLabel: 'Set PIN', onOk: async (wrap) => {
      try { await auth.api('setPin', { uid, pin: val(wrap, 'np-pin') }); toast('PIN set for ' + u.name); return true; }
      catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}
async function staffActive(uid, active) {
  try { await patchOne('users', uid, { active, ...auth.touch() }); toast(active ? 'Reactivated' : 'Deactivated: they can no longer sign in'); }
  catch (e) { toast('Could not change that: ' + e.message, 'warn'); }
}

// -------------------------------------------------------------- devices --
function devicesHtml() {
  const d = auth.session.device;
  const mySts = auth.session.user.role === 'owner' ? stores : stores.filter(s => auth.inStore(s.id));
  const regsOf = (sid) => registers.filter(r => r.storeId === sid);
  const firstStore = mySts[0] ? mySts[0].id : '';
  return `<div class="page-head"><h1>Devices</h1><p class="sub">An enrolled till lets staff sign in with a PIN</p></div>
    <div class="card"><h2>This device</h2>
      ${d ? `<p><strong>${esc(d.label)}</strong> · ${esc(storeName(d.storeId) || d.storeId)}${d.registerId ? ' · ' + esc((registers.find(r => r.id === d.registerId) || {}).name || d.registerId) : ''}</p>
        <div class="card-actions"><button class="btn ghost" data-act="device-forget">Forget this device</button></div>`
      : auth.session.mode !== 'email' ? '<p class="muted">Sign in with an email (a manager or the owner) to enrol a device.</p>'
      : `<p class="muted">Enrol this device as a till of one store. Staff of that store can then sign in here with their PIN, even when the line is down.</p>
        ${row(field('Store', 'dv-store', { type: 'select', options: mySts.map(s => ({ value: s.id, label: s.name + ' · ' + entityName(s.entityId) })), value: firstStore }), field('Register', 'dv-register', { type: 'select', options: [{ value: '', label: 'No register yet' }].concat(regsOf(firstStore).map(r => ({ value: r.id, label: r.name }))) }))}
        ${field('Name for this till', 'dv-label', { placeholder: 'e.g. Front till, iPad 2' })}
        <div class="card-actions"><button class="btn primary" data-act="device-enrol"${mySts.length ? '' : ' disabled'}>Enrol this device</button></div>`}
    </div>
    <div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <thead><tr><th>Till</th><th>Store</th><th>Register</th><th>Last seen</th><th>Version</th></tr></thead>
      <tbody>${devices.length ? devices.map(x => `<tr class="${x.active ? '' : 'off'}"><td><strong>${esc(x.label)}</strong>${d && d.deviceId === x.id ? ' <small class="muted">(this one)</small>' : ''}</td><td>${esc(storeName(x.storeId) || x.storeId)}</td><td>${esc((registers.find(r => r.id === x.registerId) || {}).name || '')}</td><td class="muted">${x.lastSeenAt ? esc(niceDate(x.lastSeenAt) + ' ' + niceTime(x.lastSeenAt)) : ''}</td><td class="muted">${esc(x.appVersion || '')}</td></tr>`).join('') : `<tr><td colspan="5">${empty('No tills enrolled yet')}</td></tr>`}</tbody>
    </table></div>`;
}
async function deviceEnrol() {
  const w = $('screen');
  const body = { storeId: val(w, 'dv-store'), registerId: val(w, 'dv-register'), label: val(w, 'dv-label') || 'Till' };
  try { await auth.enrolDevice(body); toast('Enrolled. Staff of this store can now sign in here with a PIN.'); paint(); }
  catch (e) { toast(e.message, 'warn'); }
}

// the offline sales the office refused, for a manager
async function showFailed() {
  const list = await sync.failedList();
  openModal('Refused offline sales', list.length ? `<div class="pk-list">${list.map(x => `<div class="pk-row" style="cursor:default"><strong>${esc(x.docNo)} · ${esc(money(x.totalCents))} · ${esc(niceDate(x.clientCreatedAt))} ${esc(niceTime(x.clientCreatedAt))}</strong><span>${esc(x.error)}</span>${auth.atLeast('manager') ? `<button class="btn ghost sm" data-act="sync-drop" data-id="${esc(x.saleId)}" style="justify-self:start;margin-top:.3rem">Drop</button>` : ''}</div>`).join('')}</div><p class="muted">The number of each was voided; the goods and money need checking by hand.</p>` : '<p class="muted">None.</p>', { okLabel: 'Close', cancelLabel: '', onOk: () => true });
}
document.addEventListener('click', (e) => { const b = e.target.closest('#offline-bar [data-act], #modal [data-act=sync-drop]'); if (b) onAction(e); });

// ------------------------------------------------------------------- me --
function meHtml() {
  const u = auth.session.user;
  return `<div class="page-head"><h1>My PIN</h1></div>
    <div class="card"><p>${u.pinSet ? 'You have a PIN for the till.' : 'You have no PIN yet. Set one to sign in at a till.'}</p>
      ${row(field('New PIN (4–6 digits)', 'me-pin', { inputmode: 'numeric', autocomplete: 'off' }), field('Again', 'me-pin2', { inputmode: 'numeric', autocomplete: 'off' }))}
      <div class="card-actions"><button class="btn primary" data-act="my-pin">${u.pinSet ? 'Change my PIN' : 'Set my PIN'}</button></div>
    </div>`;
}
async function myPin() {
  const w = $('screen');
  const a = val(w, 'me-pin'), b = val(w, 'me-pin2');
  if (a !== b) return toast('The two PINs differ.', 'warn');
  try { await auth.api('setPin', { pin: a }); auth.session.user.pinSet = true; toast('Your PIN is set.'); paint(); }
  catch (e) { toast(e.message, 'warn'); }
}

// -------------------------------------------------------------- actions --
async function onAction(e) {
  const sub = e.target.closest('[data-sub]'); if (sub) return goSub(sub.dataset.sub);
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  const w = $('screen');
  if (b.dataset.act === 'go-overview') { view = 'overview'; paint(); window.scrollTo(0, 0); return; }
  if (b.dataset.act.startsWith('sl-')) return sell.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('fb-')) return fabricsTab.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('qt-')) return quotesTab.action(b.dataset.act, b);
  if (b.dataset.act === 'sa-open') return salesTab.openSale(id, { ...sellData(), sales: storeSales });
  if (b.dataset.act.startsWith('rg-')) return register.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('rt-')) return returns.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('lb-')) return laybys.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('so-')) return specials.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('tk-')) return tasks.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('st-')) { e.preventDefault(); return stock.action(b.dataset.act, b); }
  if (b.dataset.act.startsWith('by-')) { e.preventDefault(); return buying.action(b.dataset.act, b); }
  if (b.dataset.act.startsWith('cu-')) return customersTab.action(b.dataset.act, b);
  if (b.dataset.act.startsWith('rp-')) { e.preventDefault(); return reports.action(b.dataset.act, b); }
  if (b.dataset.act.startsWith('on-')) { e.preventDefault(); return online.action(b.dataset.act, b); }
  if (b.dataset.act === 'sync-now') return sync.syncNow().then(reloadOffsets);
  if (b.dataset.act === 'sync-failed') return showFailed();
  if (b.dataset.act === 'sync-drop') { if (confirm('Drop this refused sale from the till? It was never written; ring it up again if it should be.')) sync.dropFailed(id).then(showFailed); return; }
  if (b.dataset.act === 'sa-all') { salesTab.view.day = ''; return paint(); }
  switch (b.dataset.act) {
    case 'entity-edit': editId = id; paint(); return;
    case 'entity-cancel': editId = ''; paint(); return;
    case 'entity-save': if (await admin.entitySave(w, adminData())) { editId = ''; paint(); } return;
    case 'store-edit': editId = id; paint(); return;
    case 'store-cancel': editId = ''; paint(); return;
    case 'store-save': if (await admin.storeSave(w, adminData())) { editId = ''; paint(); } return;
    case 'register-edit': editId = id; paint(); return;
    case 'register-cancel': editId = ''; paint(); return;
    case 'register-save': if (await admin.registerSave(w, adminData())) { editId = ''; paint(); } return;
    case 'settings-save': return admin.settingsSave(w, adminData());
    case 'pr-new': return products.openProductForm(prData(), '', prEntityId());
    case 'pr-edit': return products.openProductForm(prData(), id, '');
    case 'pr-export': { const n = products.exportCsv(prData(), prEntityId()); toast(n + ' rows exported'); return; }
    case 'pr-costs': return openCostImport(prData(), prEntityId());
    case 'pr-reorder': return products.setReorderAll(prData(), prEntityId());
    case 'pr-supplier': return products.setSupplierMany(prData(), prEntityId(), [...w.querySelectorAll('[data-lbl]:checked')].map(c => c.dataset.lbl));
    case 'pr-labels': return products.printLabels(prData(), [...w.querySelectorAll('[data-lbl]:checked')].map(c => c.dataset.lbl), prEntityId());
    case 'rate-add': return admin.rateAdd(w);
    case 'rate-del': return admin.rateDel(w, b.dataset.i);
    case 'staff-add': return staffAdd();
    case 'staff-pin': return staffPin(id);
    case 'staff-off': return staffActive(id, false);
    case 'staff-on': return staffActive(id, true);
    case 'device-enrol': return deviceEnrol();
    case 'device-forget': if (confirm('Forget this device? Staff will no longer sign in here with a PIN until it is enrolled again.')) { auth.forgetDevice(); paint(); } return;
    case 'my-pin': return myPin();
  }
}
$('screen').addEventListener('change', (e) => {
  if (e.target.id === 'se-entity') { settingsEntity = e.target.value; return paint(); }
  if (e.target.id === 'pr-entity') { prEntity = e.target.value; return paint(); }
  if (e.target.id === 'sa-day') { salesTab.view.day = e.target.value; return paint(); }
  if (e.target.id === 'pr-cat') { prFilter.category = e.target.value; return paint(); }
  if (e.target.id === 'pr-brand') { prFilter.brand = e.target.value; return paint(); }
  if (e.target.id === 'pr-type') { prFilter.type = e.target.value; return paint(); }
  if (e.target.id === 'pr-supplier') { prFilter.supplier = e.target.value; return paint(); }
  if (e.target.id === 'pr-archived') { prFilter.archived = e.target.checked; return paint(); }
  if (e.target.id === 'pr-all') { document.querySelectorAll('[data-lbl]').forEach(c => { c.checked = e.target.checked; }); return; }
  if (e.target.id === 'pr-file') { const f = e.target.files && e.target.files[0]; if (f) products.openImport(f, prData(), prEntityId()); e.target.value = ''; return; }
  if (e.target.id === 'dv-store') {
    const sel = $('dv-register'); if (!sel) return;
    const regs = registers.filter(r => r.storeId === e.target.value);
    sel.innerHTML = '<option value="">No register yet</option>' + regs.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  }
});

$('screen').addEventListener('input', (e) => { if (e.target.id === 'pr-q') { prFilter.q = e.target.value; paint(); } if (e.target.id === 'sl-q') sell.onSearchInput(e.target.value); if (e.target.id === 'sa-q') { salesTab.view.q = e.target.value; paint(); const q = $('sa-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } });
$('screen').addEventListener('keydown', (e) => { if (e.target.id === 'sl-q' && e.key === 'Enter') { e.preventDefault(); sell.onSearchEnter(e.target.value); } if (e.key === 'Enter' && returns.onEnter(e.target.id, e.target.value)) e.preventDefault(); if (e.key === 'Enter' && view === 'stock' && stock.onEnter(e.target.id, e.target.value)) e.preventDefault(); if (e.key === 'Enter' && view === 'buying' && buying.onEnter(e.target.id, e.target.value)) e.preventDefault(); });
$('screen').addEventListener('change', (e) => { if (view === 'fabrics') fabricsTab.onChange(e); if (view === 'quotes') quotesTab.onChange(e); if (view === 'returns') returns.onChange(e); if (view === 'laybys') laybys.onChange(e); if (view === 'orders') specials.onChange(e); if (view === 'stock') stock.onChange(e); if (view === 'buying') buying.onChange(e); if (view === 'customers') customersTab.onChange(e); if (view === 'reports') reports.onChange(e); if (view === 'online') online.onChange(e); });
$('screen').addEventListener('input', (e) => { if (view === 'fabrics') fabricsTab.onInput(e.target.id, e.target.value); if (view === 'quotes') quotesTab.onInput(e.target.id, e.target.value); if (view === 'returns') returns.onInput(e.target.id, e.target.value); if (view === 'laybys') laybys.onInput(e.target.id, e.target.value); if (view === 'orders') specials.onInput(e.target.id, e.target.value); if (view === 'stock') stock.onInput(e.target.id, e.target.value); if (view === 'buying') buying.onInput(e.target.id, e.target.value); if (view === 'customers') customersTab.onInput(e.target.id, e.target.value); });
returns.setContext({ repaint: () => { if (view === 'returns') paint(); }, data: sellData, onDone: () => { register.reg.stale = true; } });
laybys.setContext({ repaint: () => { if (view === 'laybys') paint(); }, data: () => ({ ...sellData(), laybys: storeLaybys }), onChange: () => { register.reg.stale = true; if (view === 'laybys') paint(); } });
// a lay-by's own buttons sit in its modal, outside the screen
document.addEventListener('click', (e) => { const b = e.target.closest('#modal [data-act^="lb-"], #modal [data-act^="so-"], #modal [data-act^="by-"], #modal [data-act^="cu-"], #modal [data-act^="on-"]'); if (!b) return; if (b.dataset.act.startsWith('on-')) return online.action(b.dataset.act, b); if (b.dataset.act.startsWith('lb-')) laybys.action(b.dataset.act, b); else if (b.dataset.act.startsWith('so-')) specials.action(b.dataset.act, b); else if (b.dataset.act.startsWith('cu-')) customersTab.action(b.dataset.act, b); else buying.action(b.dataset.act, b); });
online.setContext({ repaint: () => { if (view === 'online') paint(); }, data: () => ({ ...sellData(), stores }) });
reports.setContext({ repaint: () => { if (view === 'reports') paint(); }, data: () => ({ ...sellData(), entities, stores, users }) });
customersTab.setContext({ repaint: () => { if (view === 'customers') paint(); }, data: () => ({ ...sellData() }) });
buying.setContext({ repaint: () => { if (view === 'buying') paint(); }, data: () => ({ ...sellData(), stores, suppliers, specials: storeSpecials, pos: storePOs, grvs: storeGrvs, transfers: [...transfersOut, ...transfersIn.filter(t => !transfersOut.some(o => o.id === t.id))] }), onChange: () => { reloadOffsets(); if (view === 'buying') paint(); } });
stock.setContext({ repaint: () => { if (view === 'stock') paint(); }, data: () => ({ ...sellData(), takes: storeTakes }), onChange: () => { reloadOffsets(); if (view === 'stock') paint(); } });
todo.setContext({ data: () => ({ ...sellData(), specials: storeSpecials, quotes: storeQuotes }) });
quotesTab.setContext({ repaint: () => { if (view === 'quotes') paint(); }, data: () => ({ ...sellData(), quotes: storeQuotes, cartLines: sell.sale.cart.lines.length }), onLoad: (q) => { const ok = sell.loadQuote(q); if (ok) { view = 'sell'; paint(); } return ok; } });
fabricsTab.setContext({ repaint: () => { if (view === 'fabrics') paint(); }, data: () => ({ entities, fabrics }) });
tasks.setContext({ repaint: () => { if (view === 'home') paint(); }, data: () => ({ ...sellData(), tasks: storeTasks, staff: users }) });
specials.setContext({ repaint: () => { if (view === 'orders' || view === 'todo') paint(); }, data: () => ({ ...sellData(), specials: storeSpecials, salesOrders: storeSalesOrders }), onChange: () => { register.reg.stale = true; if (view === 'orders' || view === 'todo') paint(); } });
document.addEventListener('keydown', (e) => { if (view === 'sell' && auth.session.user) sell.onDocumentKey(e); }, true);
$('screen').addEventListener('change', (e) => { if (e.target.id === 'sl-store') { sellStore = e.target.value; startStoreData(); paint(); } });
sell.setContext({ repaint: () => { if (view === 'sell') paint(); }, data: sellData, onSold: (r) => { register.reg.stale = true; reloadOffsets(); if (!r.offline) sync.refreshBlocks(); }, onLayby: (cart, t, clear) => laybys.openNew(cart, t, () => { clear(); register.reg.stale = true; }), onSpecial: (cart, t, clear) => specials.openNew(cart, t, () => { clear(); register.reg.stale = true; }), onQuote: (cart, t) => quotesTab.openNew(cart, t) });
register.setContext({ repaint: () => { if (view === 'register' || view === 'sell') paint(); }, data: sellData });
register.wireScreen($('screen'));
// the register's state is read once a till signs in, and forgotten on sign-out
auth.onSession((s) => { paintBanner(); if (!s.user) { register.reg.state = null; return; } if (register.registerId() && !register.reg.state) register.refresh(); if (s.device) { sync.refreshBlocks().then(() => { reloadOffsets(); sync.syncNow(); }); } });
import * as __ui from './ui.js';
window.__ui = __ui;
main().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p class="boot-fail">The till could not start: ${esc(e.message)}</p>`); });
