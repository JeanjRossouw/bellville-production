// The app shell — sign-in and sign-up, boot, navigation by role, Settings and the team.
import * as store from './store.js';
import { FACTORY_DEFAULTS, isCloudConfigured, PRODUCT, TRIAL_DAYS } from './config.js';
import { AREAS, LEVELS, levelOf } from './permissions.js';
import { esc, field, row, toast, money, daysUntil, openModal } from './ui.js';
import { startCustomers, renderCustomers, newCustomer, editCustomer, deleteCustomer } from './customers.js';
import {
  startOrders, renderOrders, newOrder, editOrder, deleteOrder, setStatus, setFabric,
  setDue, setFilter, getFilter, setOrderSettings, allOrders
} from './orders.js';
import {
  renderFloor, setFloorView, setFloorSettings, startBuild, moveMenu,
  printJobCard, printWeekJobCards, printPlanner
} from './floor.js';
import { renderScan, setScanSettings, startCamera, stopCamera, manualFind, confirmDispatch, notifyCustomer } from './scan.js';
import { startPos, renderPos, setPosSettings, posAction, posInput, allSales } from './pos.js';
import { startQuotes, renderQuotes, setQuoteSettings, setQuoteFilter, newQuote, editQuote, copyQuote, sendQuote, printQuote, acceptQuote, declineQuote } from './quotes.js';
import { renderProfit, setProfitSettings, setProfitMonth } from './profit.js';
import {
  startDeliveries, renderDeliveries, setDeliverySettings, setDeliveryView, setDeliveryDay, scheduleDelivery, confirmToClient,
  sendRun, printRun, markDelivered, undoDelivered, viewNote, clientSigns, newDriver, editDriver, sendDriverLink, copyDriverLink, relinkDriver, removeDriver
} from './deliveries.js';
import {
  startStoreroom, renderStoreroom, setStoreroomSettings, setStoreroomView, receivePo, receiveDirect, fabricArrived, issueStock,
  liveCount, saveCount, newAsset, giveAsset, assetBack, assetRepair, assetGone, assetHistory, newPerson, editPerson, togglePerson
} from './storeroom.js';
import {
  startStock, renderStock, setStockSettings, setStockView, countMaterial, newPurchaseOrder, draftForSupplier,
  editPurchaseOrder, sendPurchaseOrder, printPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder
} from './stock.js';
import {
  startInvoices, renderInvoices, setInvoiceSettings, setInvView, setInvFilter, setStmtCustomer, newInvoiceFor,
  invoiceCustomerQueue, pickedIds, recordPayment, voidInvoice, printInvoice, printStatement, exportCsv
} from './invoices.js';
import {
  startCosting, renderCosting, setCostingSettings, setCostView, newMaterial, editMaterial, deleteMaterial,
  newProduct, editProduct, duplicateProduct, deleteProduct, saveOverheads, addOverheadRow, liveOverheads,
  printPriceSheet, printCostSheet
} from './costing.js';


// ?pos=1 is the till link: opens straight onto the point of sale with bigger
// touch targets, for the tablet at the showroom counter.
const TILL = new URLSearchParams(location.search).get('pos') === '1';
if (TILL) document.documentElement.classList.add('till');

let settings = { ...FACTORY_DEFAULTS };
let view = TILL ? 'pos' : 'orders';
let booted = false;
// A job-card QR opens the app with ?scan=<order id>: remember it until the
// orders have loaded, then go straight to the dispatch screen for that order.
let pendingScan = new URLSearchParams(location.search).get('scan') || '';
if (pendingScan) history.replaceState(null, '', location.pathname);

// The menu: screens grouped into drop-downs, so the bar stays short. A
// group with only one screen this person may see shows as a plain tab.
const NAV = [
  { key: 'pos', label: 'Point of sale', group: 'sales' },
  { key: 'quotes', label: 'Quotes', group: 'sales' },
  { key: 'customers', label: 'Customers', group: 'sales' },
  { key: 'orders', label: 'Orders', group: 'production' },
  { key: 'factory', label: 'Factory floor', group: 'production' },
  { key: 'scan', label: 'Scan out', group: 'production' },
  { key: 'deliveries', label: 'Deliveries', group: 'production' },
  { key: 'costing', label: 'Costing', group: 'buying' },
  { key: 'stock', label: 'Stock', group: 'buying' },
  { key: 'storeroom', label: 'Stock room', group: 'buying' },
  { key: 'invoices', label: 'Invoices', group: 'money' },
  { key: 'profit', label: 'Profit', group: 'money' },
  { key: 'settings', label: 'Settings' },
  { key: 'clients', label: 'Clients' }
];
const GROUPS = [['sales', 'Sales'], ['production', 'Production'], ['buying', 'Buying'], ['money', 'Money']];

// What each person sees comes from their role, which the owner designs under
// Settings → Roles. The owner sees everything, plus the team and billing.
let seller = false;          // the seller's own login: sees every company under Clients
const allowedViews = (user) => !user ? [] : NAV.map(n => n.key).filter(k =>
  k === 'clients' ? seller : k === 'settings' ? (user.role === 'owner' || store.can('settings')) : store.can(k));
// A screen the role may only look at: nothing on it may change data.
const viewOnly = (k) => store.getUser() && store.getUser().role !== 'owner' && k !== 'clients' && levelOf(store.myPerms(), k) === 'view';
// Actions that only look, print or switch what is shown — allowed on a view-only screen.
const LOOK_ONLY = new Set(['filter-status', 'floor-view', 'cost-view', 'stock-view', 'quote-filter', 'profit-month', 'inv-view',
  'print-job', 'print-week-jobs', 'print-planner', 'print-pricesheet', 'print-costsheet', 'inv-print', 'stmt-print', 'inv-export',
  'po-print', 'quote-print', 'scan-start', 'scan-stop', 'scan-find', 'notify',
  'sr-view', 'sr-asset-history',
  'dl-view', 'dl-day', 'dl-day-pick', 'dl-print-run', 'dl-note', 'dl-confirm', 'dl-send-run', 'dl-driver-copy']);
let rolesStarted = false;
let lastAllowed = '';
let team = { members: [], invites: [] };
let billing = { plan: null, configured: false, payments: [] };
let shop = null;          // the online shop's connection status (integrations/shopify)
let clients = [];
let readOnlyOk = false;      // chose "look around (read only)" on the lock screen
let lastAccess = 'ok';
// Back from PayFast: ?billing=done or ?billing=cancelled
const BILLING_RETURN = new URLSearchParams(location.search).get('billing') || '';
if (BILLING_RETURN) history.replaceState(null, '', location.pathname + (new URLSearchParams(location.search).get('pos') === '1' ? '?pos=1' : ''));

// ------------------------------------------------------------------ boot ----

async function boot() {
  await store.initStore();
  store.onUser(async (user) => {
    if (!user) { showLogin(); return; }
    if (user.role === 'none') { showNoAccess(user); return; }
    // the company's roles decide the menus, so they load first (and stay live)
    if (!rolesStarted) {
      rolesStarted = true;
      await new Promise(res => {
        let first = true;
        setTimeout(() => { if (first) { first = false; res(); } }, 6000);
        store.watchRoles(() => { if (first) { first = false; res(); } else onRolesChange(); });
      });
      lastAllowed = allowedViews(user).join(',');
    }
    if (!allowedViews(user).length) { showNoScreens(user); return; }
    if (!booted) {
      booted = true;
      seller = await store.isSeller();
      if (seller) store.watchAllCompanies(rows => { clients = rows; if (view === 'clients') paint(); });
      if (user.role === 'owner') {
        store.watch('members', rows => { team.members = rows; if (view === 'settings') paint(); });
        store.watch('invites', rows => { team.invites = rows; if (view === 'settings') paint(); });
        store.watch('payments', rows => { billing.payments = rows; if (view === 'settings') paint(); });
        // only the Online shop card is redrawn: the 15-minute check writes here,
        // and a full repaint would wipe settings the owner is still typing
        store.watch('integrations', rows => { shop = rows.find(r => r.id === 'shopify') || null; if (view === 'settings') redrawShopCard(); });
        store.getPlan().then(r => { billing.plan = r.plan; billing.configured = !!r.configured; if (view === 'settings') paint(); });
      }
      // a payment, a cancellation or an extended trial takes effect live
      store.watchCompany(() => onCompanyChange());
      lastAccess = store.accessState();
      if (BILLING_RETURN === 'done') toast('Thank you — your subscription starts as soon as PayFast confirms the payment, usually within a minute.');
      if (BILLING_RETURN === 'cancelled') toast('Payment cancelled — nothing was charged.', 'warn');
      store.seedDemoIfEmpty();
      store.shopifyRetryPending();      // till sales whose stock could not reach the online shop yet
      settings = await store.loadSettings(FACTORY_DEFAULTS);
      setOrderSettings(settings);
      setFloorSettings(settings);
      setCostingSettings(settings);
      setScanSettings(settings);
      setInvoiceSettings(settings);
      setPosSettings(settings);
      setStockSettings(settings);
      setQuoteSettings(settings);
      setProfitSettings(settings);
      setDeliverySettings(settings);
      setStoreroomSettings(settings);
      // only what this person's role may see is loaded at all
      if (store.can('quotes')) startQuotes(() => { if (view === 'quotes') paint(); }, settings);
      if (store.can('deliveries')) startDeliveries(() => { if (view === 'deliveries') paint(); }, settings, store.can('deliveries', 'edit'));
      if (store.can('storeroom')) startStoreroom(() => { if (view === 'storeroom') paint(); }, settings);
      if (store.can('stock') || store.can('storeroom')) startStock(() => { if (view === 'stock' || view === 'storeroom') paint(); }, settings);
      if (store.can('pos') || store.can('profit')) startPos(() => { if (view === 'pos' || view === 'profit') paint(); }, settings);
      if (store.can('invoices') || store.can('pos') || store.can('profit')) startInvoices(() => { if (view === 'invoices' || view === 'orders') paint(); }, settings);
      startCosting(() => { if (view === 'costing' || view === 'orders' || view === 'pos' || view === 'stock') paint(); }, settings);
      startCustomers(() => { if (view === 'customers' || view === 'orders' || view === 'pos') paint(); });
      startOrders(() => {
        if (view !== 'settings') paint();   // includes Stock (what open orders need) and Profit
        if (pendingScan) { const id = pendingScan; pendingScan = ''; view = 'scan'; paint(); confirmDispatch(id); }
      }, settings);
      if (pendingScan) view = 'scan';
    }
    if (!allowedViews(user).includes(view)) view = allowedViews(user)[0];
    if (store.accessState() !== 'ok' && !readOnlyOk) { showLocked(user); return; }
    showApp(user);
  });
  // a save refused because the subscription is not active, or the role does not allow it
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && (e.reason.code === 'subscription' || e.reason.code === 'role')) { e.preventDefault(); toast(e.reason.message, 'warn'); }
  });
}

// The owner changed a role. The owner's own screen just repaints; anyone
// whose menus changed gets a fresh start so the right screens load.
function onRolesChange() {
  const user = store.getUser(); if (!user) return;
  if (!booted) { if (user.role !== 'owner' && allowedViews(user).join(',') !== lastAllowed) location.reload(); return; }
  if (user.role === 'owner') { if (view === 'settings') paint(); return; }
  const now = allowedViews(user).join(',');
  if (now !== lastAllowed) { location.reload(); return; }
  if (booted) paint();
}

function onCompanyChange() {
  const user = store.getUser(); if (!user || !booted) return;
  const now = store.accessState();
  if (now === lastAccess) { const c = document.getElementById('status-chip'); if (c) c.outerHTML = statusChip(); if (view === 'settings' || view === 'clients') paint(); return; }
  lastAccess = now;
  if (now === 'ok') { readOnlyOk = false; showApp(user); toast('Subscription active — thank you.'); }
  else if (!readOnlyOk) showLocked(user);
  else showApp(user);
}

// ------------------------------------------------------------- lock screen --

const LOCK_TEXT = {
  'trial-ended': ['Your free trial has ended', 'Subscribe to keep adding orders, invoices and sales.'],
  unpaid: ['Payment is overdue', 'The last monthly payment did not come through. Subscribe again to carry on.'],
  ended: ['Your subscription has ended', 'Subscribe again to carry on where you left off.']
};

function showLocked(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  const [title, lead] = LOCK_TEXT[store.accessState()] || LOCK_TEXT['trial-ended'];
  const owner = user.role === 'owner';
  const p = billing.plan;
  app.innerHTML = `<div class="shell"><div class="card lock-card">
    <p class="lock-co">${esc((store.getCompany() || {}).name || '')}</p>
    <h1>${esc(title)}</h1>
    <p>${esc(lead)} Everything you captured is safe, and you can still look at all of it.</p>
    ${owner
      ? `<div class="lock-price">${p ? `<strong>${esc(money(p.amount, 'R'))}</strong> per month · ${esc(p.includes || '')}` : ''}</div>
         <div class="card-actions"><button class="btn primary" id="lock-pay">Subscribe now</button></div>
         <p class="muted">Paid securely through PayFast by card or instant EFT. Cancel any time.</p>`
      : `<p>Ask the owner of ${esc((store.getCompany() || {}).name || 'your company')} to subscribe under Settings → Billing.</p>`}
    <div class="card-actions">
      <button class="btn ghost" id="lock-look">Look around (read only)</button>
      <button class="btn ghost" id="lock-out">Sign out</button>
    </div>
  </div></div>`;
  if (owner && !p) store.getPlan().then(r => { billing.plan = r.plan; billing.configured = !!r.configured; if (document.getElementById('lock-pay')) showLocked(user); });
  if (owner) document.getElementById('lock-pay').addEventListener('click', startCheckout);
  document.getElementById('lock-look').addEventListener('click', () => { readOnlyOk = true; showApp(user); });
  document.getElementById('lock-out').addEventListener('click', signOutAndReset);
}

// Off to PayFast: the server signs the form, the browser posts it.
async function startCheckout() {
  try {
    const r = await store.billingCall('checkout');
    if (r.demo) { toast('Demo: payment simulated — subscribed for a month.'); return; }
    const form = document.createElement('form');
    form.method = 'POST'; form.action = r.action; form.style.display = 'none';
    r.fields.forEach(([k, v]) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i); });
    document.body.appendChild(form); form.submit();
  } catch (e) { toast('Could not start the payment: ' + e.message, 'warn'); }
}

async function cancelSubscription() {
  const c = store.getCompany() || {};
  const until = c.paidUntil ? new Date(c.paidUntil).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  if (!confirm('Cancel the monthly subscription? No further payments will be taken' + (until ? ', and you keep full use until ' + until : '') + '.')) return;
  try { await store.billingCall('cancel'); toast('Subscription cancelled'); }
  catch (e) { toast('Could not cancel: ' + e.message, 'warn'); }
}

// ?join=<email> is the link an owner sends to someone they invited.
const JOIN_EMAIL = new URLSearchParams(location.search).get('join') || '';
let SIGNUP = new URLSearchParams(location.search).get('signup') === '1';

function setLoginMode(mode) {
  const form = document.getElementById('login-form');
  form.dataset.mode = mode;
  form.querySelectorAll('[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(mode); });
  document.querySelectorAll('#login-switch [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  document.getElementById('login-switch').hidden = mode === 'join';
  document.getElementById('login-company').required = mode === 'up';
  document.getElementById('login-name').required = mode !== 'in';
  document.getElementById('login-pass').autocomplete = mode === 'in' ? 'current-password' : 'new-password';
  if (mode === 'in') document.getElementById('login-pass').removeAttribute('minlength'); else document.getElementById('login-pass').minLength = 6;
  document.getElementById('login-submit').textContent = mode === 'in' ? 'Sign in' : mode === 'up' ? 'Start ' + TRIAL_DAYS + '-day free trial' : 'Create my login';
  document.getElementById('login-lead').textContent = mode === 'up'
    ? 'Set up your company in a minute. Free for ' + TRIAL_DAYS + ' days, no card needed. You can invite your team once you are in.'
    : mode === 'join' ? 'You have been invited to join your team. Create your login with this email address.' : '';
  document.getElementById('login-status').textContent = '';
}

function showLogin() {
  document.getElementById('app').hidden = true;
  const login = document.getElementById('login');
  login.hidden = false;
  document.getElementById('product-name').textContent = PRODUCT.name;
  document.getElementById('product-tag').textContent = PRODUCT.tagline;
  document.getElementById('login-mode').innerHTML = isCloudConfigured()
    ? ''
    : `<div class="notice">
         <strong>Demo mode.</strong> No database is connected yet, so everything stays in this browser.
         Sign in with any email to look around the demo factory, or start a trial to set up an empty company of your own.
       </div>`;
  if (JOIN_EMAIL) { document.getElementById('login-email').value = JOIN_EMAIL; setLoginMode('join'); }
  else if (SIGNUP) { SIGNUP = false; setLoginMode('up'); }      // "Start free trial" on the website
  else setLoginMode(document.getElementById('login-form').dataset.mode || 'in');
}

// Signed in, but not part of any company: start one here, or wait to be invited.
function showNoAccess(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `<div class="shell"><div class="card" style="max-width:560px;margin:3rem auto">
    <h1>Welcome</h1>
    ${user.error ? `<p class="notice-inline">Could not load your account: ${esc(user.error)}</p>` : ''}
    <p><strong>${esc(user.email)}</strong> is signed in but is not part of a company yet.</p>
    <h2>Start your own company</h2>
    <p class="muted">A ${TRIAL_DAYS}-day free trial. You become the owner and can invite your team.</p>
    ${field('Company name', 'nc-company', { placeholder: 'e.g. Couch Potato' })}
    ${field('Your name', 'nc-name', { value: user.name && user.name !== user.email ? user.name : '' })}
    <div class="card-actions"><button class="btn primary" id="nc-create">Create company</button></div>
    <h2>Joining a team?</h2>
    <p class="muted">Ask the owner to invite exactly <strong>${esc(user.email)}</strong> under Settings → Team, then sign out and in again.</p>
    <div class="card-actions"><button class="btn ghost" id="noaccess-out">Sign out</button></div>
  </div></div>`;
  document.getElementById('noaccess-out').addEventListener('click', signOutAndReset);
  document.getElementById('nc-create').addEventListener('click', async () => {
    const name = document.getElementById('nc-company').value.trim();
    if (!name) { toast('Enter the company name', 'warn'); return; }
    try { await store.createCompany(name, document.getElementById('nc-name').value.trim()); }
    catch (e) { toast('Could not create the company: ' + e.message, 'warn'); }
  });
}

// In a company, but the owner has not given their role any screens yet.
function showNoScreens(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `<div class="shell"><div class="card" style="max-width:560px;margin:3rem auto">
    <h1>Nothing to show yet</h1>
    <p>You are in <strong>${esc((store.getCompany() || {}).name || 'the company')}</strong> as <strong>${esc(store.roleLabel(user.role))}</strong>, but that role has no screens switched on yet.</p>
    <p class="muted">Ask the owner to open Settings → Roles and choose what ${esc(store.roleLabel(user.role))} can see. This page updates by itself when they do.</p>
    <div class="card-actions"><button class="btn ghost" id="noscreens-out">Sign out</button></div>
  </div></div>`;
  document.getElementById('noscreens-out').addEventListener('click', signOutAndReset);
}

// Signing out reloads the page, so nothing from one company's session can
// linger in memory when the next person signs in.
async function signOutAndReset() {
  try { await store.signOutNow(); } finally { location.replace(location.pathname); }
}

function showApp(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-name">${esc(settings.name || (store.getCompany() || {}).name || PRODUCT.name)}</span>
        <span class="brand-sub">${esc(PRODUCT.name)}</span>
      </div>
      <div class="top-right">
        ${store.storeMode() === 'demo' ? '<span class="chip demo-chip" title="No database connected — data stays in this browser">DEMO</span>' : ''}
        ${statusChip()}
        <span class="who">${esc(user.name || user.email)}<span class="role">${esc(store.roleLabel(user.role))}</span></span>
        <button class="btn ghost sm" id="sign-out">Sign out</button>
      </div>
    </header>
    <nav class="tabs" id="tabs">${navHtml(user)}</nav>
    ${store.accessState() !== 'ok' ? `<div class="readonly-bar">Read only — ${esc((LOCK_TEXT[store.accessState()] || [''])[0].toLowerCase())}. ${store.getUser().role === 'owner' ? '<button class="btn sm" id="ro-pay">Subscribe</button>' : 'Ask the owner to subscribe.'}</div>` : ''}
    <main class="shell" id="screen"></main>`;
  const roPay = document.getElementById('ro-pay'); if (roPay) roPay.addEventListener('click', startCheckout);

  document.getElementById('sign-out').addEventListener('click', signOutAndReset);
  document.getElementById('tabs').addEventListener('click', (e) => {
    const g = e.target.closest('[data-group]');
    if (g) { toggleMenu(g); return; }
    const b = e.target.closest('[data-view]');
    if (b && allowedViews(store.getUser()).includes(b.dataset.view)) { closeMenus(); view = b.dataset.view; paint(); }
  });
  document.getElementById('screen').addEventListener('click', onAction);
  document.getElementById('screen').addEventListener('change', onChangeEvent);
  document.getElementById('screen').addEventListener('input', onInput);
  paint();
}

function statusChip() {
  const state = store.accessState();
  const c = store.getCompany() || {};
  if (state !== 'ok') return '<span class="trial-chip low" id="status-chip">Read only</span>';
  const left = store.trialDaysLeft();
  if (left != null) return `<span class="trial-chip ${left <= 3 ? 'low' : ''}" id="status-chip" title="Free trial">Trial · ${left} day${left === 1 ? '' : 's'} left</span>`;
  if (c.status === 'cancelled' && c.paidUntil) return `<span class="trial-chip low" id="status-chip">Ends ${esc(new Date(c.paidUntil).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }))}</span>`;
  return '<span id="status-chip"></span>';
}

// --------------------------------------------------------------- painting ---

// ------------------------------------------------------------------ menu ----

function navHtml(user) {
  const ok = allowedViews(user);
  const parts = [];
  GROUPS.forEach(([g, label]) => {
    const items = NAV.filter(n => n.group === g && ok.includes(n.key));
    if (!items.length) return;
    if (items.length === 1) { parts.push(`<button class="tab" data-view="${items[0].key}"><span>${esc(items[0].label)}</span></button>`); return; }
    parts.push(`<button class="tab tab-group" data-group="${g}" aria-haspopup="true"><span class="tg-label">${esc(label)}</span><span class="tg-now"></span><i class="caret"></i></button>
      <div class="tab-menu" data-menu="${g}" hidden role="menu">${items.map(n => `<button class="tab-item" data-view="${n.key}" role="menuitem">${esc(n.label)}</button>`).join('')}</div>`);
  });
  NAV.filter(n => !n.group && ok.includes(n.key)).forEach(n => parts.push(`<button class="tab" data-view="${n.key}"><span>${esc(n.label)}</span></button>`));
  return parts.join('');
}

function closeMenus() {
  document.querySelectorAll('.tab-menu').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.tab-group').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
// The bar scrolls sideways on a phone, so the menu floats (position: fixed)
// under its button instead of being clipped by the bar.
function toggleMenu(btn) {
  const m = document.querySelector(`.tab-menu[data-menu="${btn.dataset.group}"]`);
  const opening = m.hidden;
  closeMenus();
  if (!opening) return;
  const r = btn.getBoundingClientRect();
  m.style.top = Math.round(r.bottom) + 'px';
  m.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 230))) + 'px';
  m.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
}
document.addEventListener('click', (e) => { if (!e.target.closest('.tab-group, .tab-menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
window.addEventListener('resize', closeMenus);

function markActive() {
  document.querySelectorAll('#tabs [data-view]').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  document.querySelectorAll('#tabs .tab-group').forEach(b => {
    const cur = NAV.find(n => n.key === view && n.group === b.dataset.group);
    b.classList.toggle('on', !!cur);
    b.querySelector('.tg-now').textContent = cur ? cur.label : '';
  });
}

function paint() {
  markActive();
  paintScreen();
  const screen = document.getElementById('screen');
  if (screen && viewOnly(view)) screen.insertAdjacentHTML('afterbegin', '<div class="viewonly-note">View only: your role can look at this screen but not change anything on it.</div>');
}

function paintScreen() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  if (view !== 'scan') stopCamera(screen);
  if (view === 'orders') return renderOrders(screen);
  if (view === 'customers') return renderCustomers(screen, allOrders());
  if (view === 'settings') return renderSettings(screen);
  if (view === 'clients') return renderClients(screen);
  if (view === 'factory') return renderFloor(screen, overview());
  if (view === 'costing') return renderCosting(screen);
  if (view === 'stock') return renderStock(screen, allOrders());
  if (view === 'quotes') return renderQuotes(screen);
  if (view === 'profit') return renderProfit(screen, allOrders(), allSales());
  if (view === 'deliveries') return renderDeliveries(screen, allOrders());
  if (view === 'storeroom') return renderStoreroom(screen, allOrders());
  if (view === 'scan') return renderScan(screen);
  if (view === 'invoices') return renderInvoices(screen);
  if (view === 'pos') return renderPos(screen);
  screen.innerHTML = '';
}

// A small "what matters today" strip, useful on its own and a preview of the
// factory floor screen.
function overview() {
  const rows = allOrders();
  const cur = settings.currency || 'R';
  const openRows = rows.filter(o => o.status !== 'invoiced' && o.status !== 'cancelled');
  const late = openRows.filter(o => { const d = daysUntil(o.dueDate); return d != null && d < 0; });
  const week = openRows.filter(o => { const d = daysUntil(o.dueDate); return d != null && d >= 0 && d <= 7; });
  const waiting = openRows.filter(o => o.fabric && o.fabricStatus !== 'received');
  const value = openRows.reduce((s, o) => s + (Number(o.priceEach) || 0) * (o.qty || 1), 0);
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  return `<div class="tiles">
    ${tile(openRows.length, 'Open orders')}
    ${tile(week.length, 'Due within 7 days', week.length ? 'amber' : '')}
    ${tile(late.length, 'Past due', late.length ? 'red' : '')}
    ${tile(waiting.length, 'Waiting on fabric', waiting.length ? 'amber' : '')}
    <div class="tile wide"><div class="tile-n">${esc(money(value, cur))}</div><div class="tile-l">Value on the floor</div></div>
  </div>`;
}

// --------------------------------------------------------------- settings ---

function renderSettings(host) {
  const s = settings;
  host.innerHTML = `
    <div class="page-head"><div>
      <h1>Settings</h1>
      <p class="sub">The factory’s own details. These appear on job cards, quotes and invoices.</p>
    </div></div>
    <div class="card">
      <h2>Business details</h2>
      ${row(field('Trading name', 's-name', { value: s.name }), field('Registered name', 's-legal', { value: s.legalName }))}
      ${row(field('Company reg. no.', 's-reg', { value: s.regNo }), field('VAT number', 's-vat', { value: s.vatNo, placeholder: 'Leave blank if not registered' }))}
      ${row(field('Phone', 's-phone', { value: s.phone }), field('Email', 's-email', { value: s.email, type: 'email' }))}
      ${field('Address', 's-address', { value: s.address, type: 'textarea' })}
      ${field('Bank details for invoices', 's-bank', { value: s.bankDetails, type: 'textarea', placeholder: 'Bank, account name, account number, branch code' })}
      <h2>Numbering and terms</h2>
      ${row(field('Order number prefix', 's-oprefix', { value: s.orderPrefix }), field('Next order number', 's-ofirst', { value: s.firstOrderNo, type: 'number', min: 1 }))}
      ${row(field('Invoice prefix', 's-iprefix', { value: s.invoicePrefix }), field('Default payment terms (days)', 's-terms', { value: s.paymentTermsDays, type: 'number', min: 0 }))}
      ${row(field('Made-to-order lead time (days)', 's-lead', { value: s.leadDays == null ? 28 : s.leadDays, type: 'number', min: 1 }), '<div class="fld"></div>')}
      ${row(
        field('VAT registered', 's-vatreg', { type: 'select', value: s.vatRegistered ? 'yes' : 'no', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] }),
        field('VAT rate (%)', 's-vatrate', { value: Math.round((s.vatRate || 0) * 100), type: 'number', min: 0, step: '0.01' })
      )}
      <div class="card-actions"><button class="btn primary" data-act="save-settings">Save settings</button></div>
    </div>
    ${store.getUser().role === 'owner' ? billingCard() + shopCard() + rolesCard() + teamCard() : ''}
    <div class="card">
      <h2>How this system is wired</h2>
      <ul class="plain">
        <li><strong>Your company only.</strong> Everything here belongs to ${esc(settings.name || 'your company')}. Other businesses on ${esc(PRODUCT.name)} cannot see any of it, and you cannot see theirs.</li>
        <li><strong>One record per order.</strong> Saves send only what changed, so two people working at once can never overwrite each other’s orders.</li>
        <li><strong>Every change is stamped.</strong> Each order carries its own history of who changed what and when.</li>
        <li><strong>Storage:</strong> ${store.storeMode() === 'cloud' ? 'in the cloud, backed up by Google.' : 'demo mode — this browser only. See SETUP.md to connect the real database.'}</li>
      </ul>
    </div>`;
}

// --------------------------------------------------------------- billing ----

const longDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

function billingCard() {
  const c = store.getCompany() || {};
  const p = billing.plan;
  const state = store.accessState();
  const left = store.trialDaysLeft();
  let status;
  if (c.status === 'free') status = 'Free access, given by ' + PRODUCT.name + '.';
  else if (left != null && state === 'ok') status = 'Free trial — ' + left + ' day' + (left === 1 ? '' : 's') + ' left (ends ' + longDate(new Date(store.trialEndsAt()).toISOString()) + ').';
  else if (c.status === 'active' && state === 'ok') status = 'Subscribed. Paid up to ' + longDate(c.paidUntil) + '; PayFast takes the next payment automatically.';
  else if (c.status === 'cancelled' && state === 'ok') status = 'Cancelled. Full use until ' + longDate(c.paidUntil) + ', then read only.';
  else status = (LOCK_TEXT[state] || [''])[0] + '. The app is read only until you subscribe.';
  const canSubscribe = c.status !== 'free' && !(c.status === 'active' && state === 'ok');
  const canCancel = c.status === 'active' && !!c.payfastToken;
  const pays = billing.payments.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
  return `<div class="card">
    <h2>Billing</h2>
    <p>${esc(status)}</p>
    ${p ? `<p class="muted">${esc(p.name)} plan: <strong>${esc(money(p.amount, 'R'))}</strong> per month. ${esc(p.includes || '')}.</p>` : ''}
    ${!billing.configured && store.storeMode() === 'cloud' ? '<p class="notice-inline">Online payments are not switched on yet.</p>' : ''}
    <div class="card-actions">
      ${canSubscribe ? `<button class="btn primary" data-act="subscribe">${c.status === 'cancelled' ? 'Subscribe again' : 'Subscribe'}</button>` : ''}
      ${canCancel ? '<button class="btn ghost" data-act="cancel-sub">Cancel subscription</button>' : ''}
    </div>
    ${pays.length ? `<h2>Payments</h2>` + pays.map(x => `<div class="team-row"><div><div class="who-n">${esc(longDate(x.at))}</div><div class="who-e">${esc(x.reference ? 'PayFast ' + x.reference : '')}</div></div><div>${esc(money(x.amount, 'R'))}</div><div class="team-acts muted">${esc(String(x.status || '').toLowerCase())}</div></div>`).join('') : ''}
  </div>`;
}

// ---------------------------------------------------------- online shop ----
// Shopify: online orders come in as factory orders, the shop's products
// come into the price list, and till sales take stock off the shop too.

const ago = (iso) => { if (!iso) return ''; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : longDate(iso); };

function redrawShopCard() {
  const el = document.getElementById('shop-card');
  if (!el) return;
  if (document.activeElement && document.activeElement.id === 'shop-when') return;   // mid-choice: leave it be
  el.outerHTML = shopCard();
}

function shopCard() {
  const s = shop || {};
  if (!s.connected) return `<div class="card" id="shop-card">
    <h2>Online shop</h2>
    <p>Connect your Shopify store and every online order comes in as a factory order by itself, with the customer, the fabric and the delivery address. Your shop’s products come into your price list, and pieces sold from stock at the till come off the shop’s count too.</p>
    <div class="card-actions"><button class="btn primary" data-act="shop-connect">Connect Shopify</button></div>
  </div>`;
  const when = s.importWhen === 'placed' ? 'placed' : 'paid';
  return `<div class="card" id="shop-card">
    <h2>Online shop</h2>
    <p><strong>Connected to ${esc(s.shopName || s.domain)}</strong> <span class="muted">(${esc(s.domain || '')})</span>. Online orders come in by themselves${s.webhooks === 'on' ? ' within a minute' : ', every 15 minutes'}.</p>
    <p class="muted">Orders brought in: ${esc(String(s.ordersIn || 0))}${s.lastOrderName ? ' · last ' + esc(s.lastOrderName) + ' ' + esc(ago(s.lastOrderAt)) : ''} · last checked ${esc(ago(s.lastCheckedAt) || 'not yet')}${s.productsAt ? ' · products brought in ' + esc(ago(s.productsAt)) : ''}</p>
    ${s.webhooks && s.webhooks !== 'on' ? `<p class="notice-inline">Shopify could not be asked to send orders straight away (${esc(s.webhooks)}). They still come in every 15 minutes.</p>` : ''}
    ${s.lastError ? `<p class="notice-inline">${esc(s.lastError)}</p>` : ''}
    ${field('Bring online orders in', 'shop-when', { type: 'select', value: when, options: [{ value: 'paid', label: 'Once they are paid (recommended)' }, { value: 'placed', label: 'As soon as they are placed, paid or not' }] })}
    <div class="card-actions">
      <button class="btn primary" data-act="shop-sync">Check for orders now</button>
      <button class="btn ghost" data-act="shop-products">Bring in products</button>
      <button class="btn ghost" data-act="shop-disconnect">Disconnect</button>
    </div>
  </div>`;
}

function shopConnect() {
  const demo = store.storeMode() === 'demo';
  openModal('Connect Shopify', `
    <ol class="steps">
      <li>In your Shopify admin open <strong>Settings → Apps and sales channels → Develop apps</strong>, then <strong>Build apps in Dev Dashboard</strong>.</li>
      <li>Create an app called <em>${esc(PRODUCT.name)}</em>. Under access give it: <code>read_products</code>, <code>read_orders</code>, <code>read_customers</code>, <code>read_inventory</code>, <code>write_inventory</code>, <code>read_locations</code>.</li>
      <li>Under <strong>Protected customer data</strong>, allow name, email, phone and address, so orders arrive with who and where. Then release the app and install it on your store.</li>
      <li>Copy the app’s <strong>Client ID</strong> and <strong>Client secret</strong> into the boxes below.</li>
    </ol>
    ${field('Your store', 'sh-domain', { placeholder: 'your-store.myshopify.com' })}
    ${row(field('Client ID', 'sh-id'), field('Client secret', 'sh-secret', { type: 'password' }))}
    ${field('Bring online orders in', 'sh-when', { type: 'select', value: 'paid', options: [{ value: 'paid', label: 'Once they are paid (recommended)' }, { value: 'placed', label: 'As soon as they are placed, paid or not' }] })}
    <p class="muted">The secret is kept on the server only. Nobody on your team can see it again, and only orders from now on come in.${demo ? ' <strong>Demo mode:</strong> any store name and keys work, and a made-up shop is used.' : ''}</p>`, {
    okLabel: 'Connect',
    onOk: async (w) => {
      const g = (id) => (w.querySelector('#' + id) || {}).value || '';
      const ok = w.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Connecting…';
      try {
        const r = await store.shopifyCall('connect', { domain: g('sh-domain'), clientId: g('sh-id'), clientSecret: g('sh-secret'), importWhen: g('sh-when') });
        toast('Connected to ' + (r.shopName || 'your shop') + '. Now bring your products in.');
      } catch (e) { toast(e.message, 'warn'); ok.disabled = false; ok.textContent = 'Connect'; return false; }
    }
  });
}

async function shopRun(action, label, btn, payload) {
  const was = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { return await store.shopifyCall(action, payload); }
  catch (e) { toast(e.message, 'warn'); return null; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; } }
}

async function shopProducts(btn) {
  const r = await shopRun('products', 'Bringing products in…', btn);
  if (r) toast(r.total + ' products in your shop: ' + r.created + ' new, ' + r.linked + ' matched to yours by name, ' + r.updated + ' updated. Prices come from the shop; recipes and costs are yours.');
}
async function shopSync(btn) {
  const r = await shopRun('sync', 'Checking…', btn);
  if (!r) return;
  if (r.skipped) { toast('Not checked: ' + r.skipped, 'warn'); return; }
  const n = (r.brought || []).filter(x => x.orders && x.orders.length);
  toast(n.length ? n.map(x => x.order + ' → ' + x.orders.join(', ')).join(' · ') : 'No new online orders');
}
async function shopDisconnect() {
  if (!confirm('Disconnect ' + ((shop && shop.shopName) || 'the shop') + '? Online orders stop coming in. Orders already here stay.')) return;
  if (await shopRun('disconnect')) toast('Shop disconnected');
}
async function shopWhen(value) {
  if (await shopRun('settings', '', null, { importWhen: value })) { toast(value === 'placed' ? 'Online orders come in as soon as they are placed' : 'Online orders come in once they are paid'); return; }
  const sel = document.getElementById('shop-when');     // not saved: show what is really set
  if (sel) sel.value = (shop && shop.importWhen) === 'placed' ? 'placed' : 'paid';
}

// ------------------------------------------------------------ the seller ----
// Every company on the app. Only logins listed in the database's admins
// collection see this.

function renderClients(host) {
  const now = Date.now();
  const p = billing.plan || { amount: 799 };
  const rows = clients.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const stateOf = (c) => {
    if (c.status === 'free') return ['Free', ''];
    const trialEnd = c.trialEndsAt ? Date.parse(c.trialEndsAt) : (Date.parse(c.createdAt || '') || now) + TRIAL_DAYS * 86400000;
    if (c.status === 'trial') return now < trialEnd ? ['Trial · ' + Math.ceil((trialEnd - now) / 86400000) + 'd left', ''] : ['Trial ended', 'red'];
    if (c.paidUntil && now < Date.parse(c.paidUntil)) return [c.status === 'cancelled' ? 'Cancelled · until ' + longDate(c.paidUntil) : 'Paying', c.status === 'cancelled' ? 'amber' : 'green'];
    return ['Unpaid', 'red'];
  };
  const paying = rows.filter(c => c.status === 'active' && c.paidUntil && now < Date.parse(c.paidUntil)).length;
  const trials = rows.filter(c => stateOf(c)[0].startsWith('Trial ·')).length;
  const tile = (n, label) => `<div class="tile"><div class="tile-n">${esc(String(n))}</div><div class="tile-l">${esc(label)}</div></div>`;
  host.innerHTML = `
    <div class="page-head"><div><h1>Clients</h1><p class="sub">Every company on ${esc(PRODUCT.name)}. Only you see this.</p></div></div>
    <div class="tiles">${tile(rows.length, 'Companies')}${tile(paying, 'Paying')}${tile(trials, 'On trial')}<div class="tile wide"><div class="tile-n">${esc(money(paying * p.amount, 'R'))}</div><div class="tile-l">Monthly income</div></div></div>
    <div class="card">
      ${rows.map(c => { const [st, cls] = stateOf(c); return `<div class="team-row client-row">
        <div><div class="who-n">${esc(c.name || '(no name)')}</div><div class="who-e">${esc([c.ownerEmail, c.createdAt ? 'since ' + longDate(c.createdAt) : '', c.lastPaymentAt ? 'last paid ' + longDate(c.lastPaymentAt) : ''].filter(Boolean).join(' · '))}</div></div>
        <div><span class="chip ${cls === 'green' ? 'st-disp' : cls === 'red' ? 'late' : cls === 'amber' ? 'st-ready' : ''}">${esc(st)}</span></div>
        <div class="team-acts">
          ${c.status === 'trial' ? `<button class="btn ghost sm" data-act="client-extend" data-id="${esc(c.id)}">+14 days trial</button>` : ''}
          <button class="btn ghost sm" data-act="client-free" data-id="${esc(c.id)}">${c.status === 'free' ? 'End free access' : 'Give free access'}</button>
        </div>
      </div>`; }).join('') || '<p class="muted">No companies yet.</p>'}
    </div>`;
}

async function clientExtend(id) {
  const c = clients.find(x => x.id === id); if (!c) return;
  const now = Date.now();
  const end = c.trialEndsAt ? Date.parse(c.trialEndsAt) : (Date.parse(c.createdAt || '') || now) + TRIAL_DAYS * 86400000;
  const next = new Date(Math.max(end, now) + 14 * 86400000);
  if (!confirm('Extend the trial for ' + (c.name || 'this company') + ' to ' + longDate(next.toISOString()) + '?')) return;
  try { await store.sellerUpdateCompany(id, { trialEndsAt: next.toISOString() }); toast('Trial extended'); }
  catch (e) { toast('Could not extend: ' + e.message, 'warn'); }
}

async function clientFree(id) {
  const c = clients.find(x => x.id === id); if (!c) return;
  const on = c.status !== 'free';
  // ending free access: back to paying if paid up, otherwise a trial that has ended
  const back = c.paidUntil && Date.parse(c.paidUntil) > Date.now() ? 'active' : 'trial';
  if (!confirm(on ? 'Give ' + (c.name || 'this company') + ' free access with no payments?' : 'End free access for ' + (c.name || 'this company') + '?')) return;
  const patch = on ? { status: 'free' } : { status: back, ...(back === 'trial' ? { trialEndsAt: new Date().toISOString() } : {}) };
  try { await store.sellerUpdateCompany(id, patch); toast(on ? 'Free access given' : 'Free access ended'); }
  catch (e) { toast('Could not change: ' + e.message, 'warn'); }
}

// ----------------------------------------------------------------- roles ----
// The owner's grid: screens down the side, roles across the top, and for
// each square Hidden, View or Edit. Changes apply at once to everyone.

function rolesCard() {
  const list = store.roleList().filter(r => !r.fixed);
  const used = (key) => team.members.filter(m => m.role === key).length + team.invites.filter(i => i.role === key).length;
  const lvl = (r, a) => LEVELS.map(l => `<option value="${l.key}" ${levelOf(r.perms, a) === l.key ? 'selected' : ''}>${esc(l.label)}</option>`).join('');
  return `<div class="card">
    <h2>Roles: who sees what</h2>
    <p class="muted">Each role gets every screen as <strong>Hidden</strong> (not in their menu), <strong>View</strong> (can look, cannot change) or <strong>Edit</strong>. Changes apply straight away to everyone with that role. The owner always sees everything.</p>
    <div class="roles-wrap"><table class="tbl roles-tbl">
      <thead><tr><th>Screen</th><th class="c">Owner</th>${list.map(r => `<th class="c"><div class="role-name">${esc(r.label)}</div>
        <div class="muted role-count">${used(r.key)} ${used(r.key) === 1 ? 'person' : 'people'}</div>
        <div class="role-acts"><button class="btn ghost xs" data-act="role-rename" data-id="${esc(r.key)}">Rename</button><button class="btn ghost xs" data-act="role-del" data-id="${esc(r.key)}">Delete</button></div></th>`).join('')}</tr></thead>
      <tbody>${AREAS.map(a => `<tr><td><strong>${esc(a.label)}</strong><div class="muted">${esc(a.hint)}</div></td><td class="c muted">Edit</td>
        ${list.map(r => `<td class="c"><select class="lvl lvl-${levelOf(r.perms, a.key)}" data-act="role-perm" data-id="${esc(r.key)}" data-area="${a.key}">${lvl(r, a.key)}</select></td>`).join('')}</tr>`).join('')}
      <tr><td><strong>Team and billing</strong><div class="muted">Invite people, change roles, the subscription</div></td><td class="c muted">Edit</td>${list.map(() => '<td class="c muted">Owner only</td>').join('')}</tr>
      </tbody>
    </table></div>
    <div class="card-actions"><button class="btn primary" data-act="role-new">＋ New role</button></div>
  </div>`;
}

async function rolePerm(key, area, level) {
  const r = store.roleList().find(x => x.key === key); if (!r) return;
  try { await store.saveRole(key, { perms: { ...r.perms, [area]: level } }); toast(r.label + ': ' + (AREAS.find(a => a.key === area) || {}).label + ' → ' + (LEVELS.find(l => l.key === level) || {}).label); }
  catch (e) { toast('Could not save: ' + e.message, 'warn'); paint(); }
}
async function roleNew() {
  const name = prompt('Name the new role (e.g. Bookkeeper, Driver, Upholsterer):', '');
  if (!name || !name.trim()) return;
  try { await store.createRole(name.trim()); toast(name.trim() + ' added — now choose what it can see'); }
  catch (e) { toast('Could not add the role: ' + e.message, 'warn'); }
}
async function roleRename(key) {
  const name = prompt('New name for this role:', store.roleLabel(key));
  if (!name || !name.trim()) return;
  await store.saveRole(key, { name: name.trim() });
}
async function roleDelete(key) {
  const n = team.members.filter(m => m.role === key).length + team.invites.filter(i => i.role === key).length;
  if (n) { toast(store.roleLabel(key) + ' is still given to ' + n + (n === 1 ? ' person' : ' people') + ' — move them to another role first', 'warn'); return; }
  if (!confirm('Delete the role ' + store.roleLabel(key) + '?')) return;
  await store.deleteRole(key); toast('Role deleted');
}

// ------------------------------------------------------------------ team ----

const joinLink = (email) => location.origin + location.pathname + '?join=' + encodeURIComponent(email);
function inviteMessage(inv) {
  const co = settings.name || (store.getCompany() || {}).name || 'our company';
  return 'Hi' + (inv.name ? ' ' + inv.name.split(' ')[0] : '') + ', you are invited to ' + co + ' on ' + PRODUCT.name + '. '
    + 'Create your login with this email address (' + inv.email + ') here: ' + joinLink(inv.email);
}

function teamCard() {
  const me = store.getUser();
  const roleOpts = (cur) => store.roleList().map(r => `<option value="${esc(r.key)}" ${r.key === cur ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
  const members = team.members.slice().sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
  const owners = members.filter(m => m.role === 'owner').length;
  return `<div class="card">
    <h2>Team</h2>
    <p class="muted">Everyone who can sign in to ${esc(settings.name || 'your company')}, and what they can open.</p>
    ${members.map(m => `<div class="team-row">
      <div><div class="who-n">${esc(m.name || m.email)}${m.id === me.uid ? ' <span class="muted">(you)</span>' : ''}</div><div class="who-e">${esc(m.email || '')}</div></div>
      <select data-act="member-role" data-id="${esc(m.id)}" ${m.id === me.uid || (m.role === 'owner' && owners < 2) ? 'disabled' : ''}>${roleOpts(m.role)}</select>
      <div class="team-acts">${m.id === me.uid ? '' : `<button class="btn ghost sm" data-act="member-remove" data-id="${esc(m.id)}">Remove</button>`}</div>
    </div>`).join('') || '<p class="muted">Loading…</p>'}
    ${team.invites.length ? `<h2>Invited, not signed up yet</h2>` + team.invites.map(i => `<div class="team-row">
      <div><div class="who-n">${esc(i.name || i.email)}</div><div class="who-e">${esc(i.email)} · ${esc(store.roleLabel(i.role))}</div></div>
      <div></div>
      <div class="team-acts">
        <button class="btn ghost sm" data-act="invite-wa" data-id="${esc(i.id)}">WhatsApp</button>
        <button class="btn ghost sm" data-act="invite-copy" data-id="${esc(i.id)}">Copy link</button>
        <button class="btn ghost sm" data-act="invite-cancel" data-id="${esc(i.id)}">Cancel</button>
      </div>
    </div>`).join('') : ''}
    <h2>Invite someone</h2>
    <div class="team-invite">
      ${field('Name', 'ti-name', { placeholder: 'Their name' })}
      ${field('Email', 'ti-email', { type: 'email', placeholder: 'their@email.co.za' })}
      ${field('Role', 'ti-role', { type: 'select', value: (store.roleList().find(r => !r.fixed) || {}).key || 'owner', options: store.roleList().filter(r => !r.fixed).concat(store.roleList().filter(r => r.fixed)).map(r => ({ value: r.key, label: r.label })) })}
      <div class="fld"><button class="btn primary" data-act="invite">Invite</button></div>
    </div>
    <p class="muted">What each role can see and change is set in the Roles grid above.</p>
    <p class="muted">Company id, for connecting other systems such as an order feed: <code>${esc((store.getCompany() || {}).id || '')}</code></p>
  </div>`;
}

async function sendInvite() {
  const g = (id) => (document.getElementById(id) || {}).value || '';
  const inv = { email: g('ti-email').trim().toLowerCase(), role: g('ti-role'), name: g('ti-name').trim() };
  if (team.members.some(m => String(m.email).toLowerCase() === inv.email)) { toast(inv.email + ' is already on the team', 'warn'); return; }
  try { await store.invite(inv.email, inv.role, inv.name); }
  catch (e) { toast(e.message, 'warn'); return; }
  toast('Invitation saved — tap WhatsApp next to their name to send them the link');
}

async function memberRole(uid, role) {
  const m = team.members.find(x => x.id === uid); if (!m) return;
  if (!confirm('Change ' + (m.name || m.email) + ' to ' + store.roleLabel(role) + '?')) { paint(); return; }
  try { await store.setMemberRole(uid, role); toast('Role changed'); }
  catch (e) { toast('Could not change the role: ' + e.message, 'warn'); paint(); }
}

async function memberRemove(uid) {
  const m = team.members.find(x => x.id === uid); if (!m) return;
  if (!confirm('Remove ' + (m.name || m.email) + ' from the team? They will no longer be able to open anything.')) return;
  try { await store.removeMember(uid); toast('Removed'); }
  catch (e) { toast('Could not remove: ' + e.message, 'warn'); }
}

async function saveSettings() {
  const g = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  const patch = {
    name: g('s-name') || settings.name || (store.getCompany() || {}).name || '',
    legalName: g('s-legal'),
    regNo: g('s-reg'),
    vatNo: g('s-vat'),
    phone: g('s-phone'),
    email: g('s-email'),
    address: g('s-address'),
    bankDetails: g('s-bank'),
    orderPrefix: g('s-oprefix') || settings.orderPrefix || 'ORD-',
    firstOrderNo: parseInt(g('s-ofirst'), 10) || 1001,
    invoicePrefix: g('s-iprefix') || 'INV-',
    paymentTermsDays: parseInt(g('s-terms'), 10) || 0,
    leadDays: parseInt(g('s-lead'), 10) || 28,
    vatRegistered: g('s-vatreg') === 'yes',
    vatRate: (parseFloat(g('s-vatrate')) || 0) / 100
  };
  await store.saveSettings(patch);
  settings = { ...settings, ...patch };
  setOrderSettings(settings);
  setFloorSettings(settings);
  setCostingSettings(settings);
  setScanSettings(settings);
  setInvoiceSettings(settings);
  setPosSettings(settings);
  setStockSettings(settings);
  setQuoteSettings(settings);
  setProfitSettings(settings);
  setDeliverySettings(settings);
  setStoreroomSettings(settings);
  const bn = document.querySelector('.brand-name');
  if (bn) bn.textContent = settings.name;
  toast('Settings saved');
}

// ---------------------------------------------------------------- events ----

async function onAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (viewOnly(view) && !LOOK_ONLY.has(b.dataset.act)) { toast('Your role can only look at this screen. Ask the owner if you need to change things here.', 'warn'); return; }
  const id = b.dataset.id;
  if (b.dataset.act.startsWith('pos-')) return posAction(b.dataset.act, b);
  switch (b.dataset.act) {
    case 'new-order': return newOrder();
    case 'edit-order': return editOrder(id);
    case 'del-order': return deleteOrder(id);
    case 'status': return setStatus(id, b.dataset.to);
    case 'new-customer': return newCustomer();
    case 'edit-customer': return editCustomer(id);
    case 'del-customer': return deleteCustomer(id, parseInt(b.dataset.n, 10) || 0);
    case 'save-settings': return saveSettings();
    case 'subscribe': return startCheckout();
    case 'stock-view': setStockView(b.dataset.to); return paint();
    case 'sr-view': setStoreroomView(b.dataset.to); return paint();
    case 'sr-receive-po': return receivePo(id);
    case 'sr-receive-direct': return receiveDirect();
    case 'sr-fabric': return fabricArrived(id, allOrders());
    case 'sr-issue': return issueStock(false, allOrders());
    case 'sr-issue-back': return issueStock(true, allOrders());
    case 'sr-count-save': return saveCount(document.getElementById('screen'));
    case 'sr-asset-new': return newAsset();
    case 'sr-asset-give': return giveAsset(id);
    case 'sr-asset-back': return assetBack(id);
    case 'sr-asset-repair': return assetRepair(id);
    case 'sr-asset-gone': return assetGone(id);
    case 'sr-asset-history': return assetHistory(id);
    case 'sr-person-new': return newPerson();
    case 'sr-person-edit': return editPerson(id);
    case 'sr-person-toggle': return togglePerson(id);
    case 'dl-view': setDeliveryView(b.dataset.to); return paint();
    case 'dl-day': setDeliveryDay(b.dataset.to); return paint();
    case 'dl-schedule': return scheduleDelivery(id, allOrders());
    case 'dl-confirm': return confirmToClient(id, allOrders());
    case 'dl-delivered': return markDelivered(id, allOrders());
    case 'dl-sign': return clientSigns(id, allOrders());
    case 'dl-undo': return undoDelivered(id, allOrders());
    case 'dl-note': return viewNote(id);
    case 'dl-send-run': return sendRun(id, allOrders());
    case 'dl-print-run': return printRun(id, allOrders());
    case 'dl-driver-new': return newDriver();
    case 'dl-driver-edit': return editDriver(id);
    case 'dl-driver-send': return sendDriverLink(id);
    case 'dl-driver-copy': return copyDriverLink(id);
    case 'dl-driver-relink': return relinkDriver(id);
    case 'dl-driver-del': return removeDriver(id, allOrders());
    case 'quote-filter': setQuoteFilter(b.dataset.to); return paint();
    case 'quote-new': return newQuote();
    case 'quote-edit': return editQuote(id);
    case 'quote-copy': return copyQuote(id);
    case 'quote-send': return sendQuote(id);
    case 'quote-print': return printQuote(id);
    case 'quote-accept': return acceptQuote(id);
    case 'quote-decline': return declineQuote(id);
    case 'profit-month': setProfitMonth(b.dataset.to); return paint();
    case 'stock-count': return countMaterial(id);
    case 'po-new': return newPurchaseOrder();
    case 'po-draft': return draftForSupplier(b.dataset.supplier, allOrders());
    case 'po-edit': return editPurchaseOrder(id);
    case 'po-send': return sendPurchaseOrder(id);
    case 'po-print': return printPurchaseOrder(id);
    case 'po-receive': return receivePurchaseOrder(id);
    case 'po-cancel': return cancelPurchaseOrder(id);
    case 'cancel-sub': return cancelSubscription();
    case 'shop-connect': return shopConnect();
    case 'shop-products': return shopProducts(b);
    case 'shop-sync': return shopSync(b);
    case 'shop-disconnect': return shopDisconnect();
    case 'client-extend': return clientExtend(id);
    case 'client-free': return clientFree(id);
    case 'invite': return sendInvite();
    case 'role-new': return roleNew();
    case 'role-rename': return roleRename(id);
    case 'role-del': return roleDelete(id);
    case 'member-remove': return memberRemove(id);
    case 'invite-cancel': {
      const inv = team.invites.find(i => i.id === id);
      if (inv && confirm('Cancel the invitation for ' + inv.email + '?')) { await store.cancelInvite(inv.email); toast('Invitation cancelled'); }
      return;
    }
    case 'invite-wa': { const inv = team.invites.find(i => i.id === id); if (inv) window.open('https://wa.me/?text=' + encodeURIComponent(inviteMessage(inv)), '_blank'); return; }
    case 'invite-copy': {
      const inv = team.invites.find(i => i.id === id); if (!inv) return;
      try { await navigator.clipboard.writeText(joinLink(inv.email)); toast('Link copied'); } catch (e) { prompt('Copy this link:', joinLink(inv.email)); }
      return;
    }
    case 'floor-view': setFloorView(b.dataset.to); return paint();
    case 'plan-move': return moveMenu(id);
    case 'mark-ready': return setStatus(id, 'ready');
    case 'start': return startBuild(id);
    case 'print-job': return printJobCard(id);
    case 'print-week-jobs': return printWeekJobCards();
    case 'print-planner': return printPlanner();
    case 'cost-view': setCostView(b.dataset.to); return paint();
    case 'new-material': return newMaterial();
    case 'edit-material': return editMaterial(id);
    case 'del-material': return deleteMaterial(id);
    case 'new-product': return newProduct();
    case 'edit-product': return editProduct(id);
    case 'dup-product': return duplicateProduct(id);
    case 'del-product': return deleteProduct(id);
    case 'oh-add': addOverheadRow(document.getElementById('screen')); return;
    case 'oh-del': b.closest('.oh-row').remove(); return liveOverheads(document.getElementById('screen'));
    case 'save-overheads': {
      const patch = await saveOverheads(document.getElementById('screen'));
      settings = { ...settings, ...patch };
      setOrderSettings(settings); setFloorSettings(settings); setCostingSettings(settings); setStockSettings(settings); setProfitSettings(settings); setQuoteSettings(settings);
      return paint();
    }
    case 'print-pricesheet': return printPriceSheet();
    case 'print-costsheet': return printCostSheet();
    case 'scan-start': return startCamera(document.getElementById('screen'));
    case 'scan-stop': return stopCamera(document.getElementById('screen'));
    case 'scan-find': return manualFind(document.getElementById('screen'));
    case 'dispatch': return confirmDispatch(id);
    case 'notify': return notifyCustomer(id);
    case 'inv-view': setInvView(b.dataset.to); return paint();
    case 'inv-customer': return invoiceCustomerQueue(b.dataset.cust);
    case 'inv-selected': {
      const ids = pickedIds(document.getElementById('screen'), b.dataset.cust);
      if (!ids.length) { toast('Tick the orders to put on the invoice first', 'warn'); return; }
      return newInvoiceFor(ids);
    }
    case 'inv-pay': return recordPayment(id);
    case 'inv-void': return voidInvoice(id);
    case 'inv-print': return printInvoice(id);
    case 'stmt-print': return printStatement(b.dataset.cust);
    case 'inv-export': return exportCsv();
    case 'filter-status': {
      // Tapping the tile you are already filtered to clears it again.
      const cur = getFilter().status;
      setFilter({ status: cur === b.dataset.to ? 'open' : b.dataset.to });
      return paint();
    }
  }
}

function onChangeEvent(e) {
  const t = e.target;
  if (t.classList && t.classList.contains('pos-in')) return posInput(t);
  if (t.id === 'o-filter-cust') { setFilter({ customer: t.value }); return paint(); }
  if (t.id === 'o-filter-status') { setFilter({ status: t.value }); return paint(); }
  const act = t.dataset ? t.dataset.act : '';
  if (viewOnly(view) && (act === 'fabric' || act === 'due')) { toast('Your role can only look at this screen.', 'warn'); paint(); return; }
  if (act === 'member-role') return memberRole(t.dataset.id, t.value);
  if (act === 'role-perm') return rolePerm(t.dataset.id, t.dataset.area, t.value);
  if (t.id === 'pf-month') { setProfitMonth(t.value); return paint(); }
  if (act === 'dl-day-pick' && t.value) { setDeliveryDay(t.value); return paint(); }
  if (act === 'fabric') return setFabric(t.dataset.id, t.value);
  if (act === 'due') return setDue(t.dataset.id, t.value);
  if (t.id === 'inv-filter') { setInvFilter(t.value); return paint(); }
  if (t.id === 'stmt-cust') { setStmtCustomer(t.value); return paint(); }
  if (t.id === 'shop-when') return shopWhen(t.value);
}

let searchTimer = null;
function onInput(e) {
  if (e.target.classList && e.target.classList.contains('pos-in')) {
    if (e.target.id === 'pos-search') { clearTimeout(searchTimer); searchTimer = setTimeout(() => posInput(e.target), 160); return; }
    return posInput(e.target);
  }
  if (e.target.closest && e.target.closest('.oh-row, #oh-units')) return liveOverheads(document.getElementById('screen'));
  if (e.target.classList && e.target.classList.contains('sr-in')) return liveCount(document.getElementById('screen'));
  if (e.target.id !== 'o-search') return;
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    setFilter({ q: v });
    const screen = document.getElementById('screen');
    renderOrders(screen);
    const s = document.getElementById('o-search');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }, 180);
}

// ----------------------------------------------------------------- login ----

// ?driver=<company>.<code>: the driver's page, no login.
const DRIVER_CODE = new URLSearchParams(location.search).get('driver') || '';

document.addEventListener('DOMContentLoaded', () => {
  if (DRIVER_CODE) { import('./driver.js').then(m => m.startDriverPage(DRIVER_CODE)); return; }
  document.getElementById('login-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (b) setLoginMode(b.dataset.mode);
  });
  document.getElementById('login-forgot').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    const status = document.getElementById('login-status');
    if (!email) { status.className = 'login-status'; status.textContent = 'Type your email address first.'; return; }
    try { await store.resetPassword(email); status.className = 'login-status ok'; status.textContent = 'A reset link is on its way to ' + email + '.'; }
    catch (err) { status.className = 'login-status'; status.textContent = 'Could not send the reset email: ' + err.message; }
  });
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = document.getElementById('login-form').dataset.mode;
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    const status = document.getElementById('login-status');
    status.className = 'login-status'; status.textContent = '';
    const btn = document.getElementById('login-submit'); btn.disabled = true;
    try {
      if (mode === 'in') await store.signIn(email, pass);
      else await store.signUp({ email, password: pass, name: document.getElementById('login-name').value.trim(), companyName: mode === 'up' ? document.getElementById('login-company').value.trim() : '' });
      if (JOIN_EMAIL) history.replaceState(null, '', location.pathname + (TILL ? '?pos=1' : ''));
    } catch (err) {
      const code = err && err.code;
      status.textContent = code === 'auth/invalid-credential' ? 'That email and password do not match.'
        : code === 'auth/email-already-in-use' ? 'There is already a login for that email — use Sign in instead.'
        : code === 'auth/weak-password' ? 'Use a password of at least 6 characters.'
        : code === 'auth/invalid-email' ? 'That email address does not look right.'
        : 'Could not continue: ' + ((err && err.message) || 'unknown error');
    } finally { btn.disabled = false; }
  });
  boot().catch(err => {
    document.getElementById('login-status').textContent = 'Startup failed: ' + err.message;
    console.error(err);
  });
});
