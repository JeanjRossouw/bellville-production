// Couch Potato factory system — boot, navigation and the Settings screen.
import * as store from './store.js';
import { FACTORY_DEFAULTS, isCloudConfigured } from './config.js';
import { esc, field, row, toast, phaseStub, money, daysUntil } from './ui.js';
import { startCustomers, renderCustomers, newCustomer, editCustomer, deleteCustomer } from './customers.js';
import {
  startOrders, renderOrders, newOrder, editOrder, deleteOrder, setStatus, setFabric,
  setDue, setFilter, getFilter, setOrderSettings, allOrders, showHistory
} from './orders.js';

let settings = { ...FACTORY_DEFAULTS };
let view = 'orders';
let booted = false;

const NAV = [
  { key: 'orders', icon: '📋', label: 'Orders' },
  { key: 'customers', icon: '👥', label: 'Customers' },
  { key: 'factory', icon: '🏭', label: 'Factory floor' },
  { key: 'costing', icon: '💰', label: 'Costing' },
  { key: 'scan', icon: '📷', label: 'Scan out' },
  { key: 'invoices', icon: '🧾', label: 'Invoices' },
  { key: 'settings', icon: '⚙️', label: 'Settings' }
];

// ------------------------------------------------------------------ boot ----

async function boot() {
  await store.initStore();
  store.onUser(async (user) => {
    if (!user) { showLogin(); return; }
    if (user.role === 'none') { showNoAccess(user); return; }
    if (!booted) {
      booted = true;
      settings = await store.loadSettings(FACTORY_DEFAULTS);
      setOrderSettings(settings);
      store.seedDemoIfEmpty();
      startCustomers(() => { if (view === 'customers' || view === 'orders') paint(); });
      startOrders(() => { if (view !== 'settings') paint(); }, settings);
    }
    showApp(user);
  });
}

function showLogin() {
  document.getElementById('app').hidden = true;
  const login = document.getElementById('login');
  login.hidden = false;
  document.getElementById('login-mode').innerHTML = isCloudConfigured()
    ? ''
    : `<div class="notice">
         <strong>Demo mode.</strong> No database is connected yet, so everything you do here
         stays in this browser only. Sign in with any email and password to look around.
         See <code>SETUP.md</code> to connect Couch Potato’s own database.
       </div>`;
}

function showNoAccess(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `<div class="shell"><div class="card stub">
    <h2>No access yet</h2>
    <p>${esc(user.email)} is signed in, but has not been given a role on this system.
    Ask the owner to grant access under Settings.</p>
    <button class="btn ghost" id="noaccess-out">Sign out</button>
  </div></div>`;
  document.getElementById('noaccess-out').addEventListener('click', () => store.signOutNow());
}

function showApp(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="logo">🛋️</span>
        <span class="brand-name">${esc(settings.name || 'Couch Potato')}</span>
        <span class="brand-sub">Factory system</span>
      </div>
      <div class="top-right">
        ${store.storeMode() === 'demo' ? '<span class="chip demo-chip" title="No database connected — data stays in this browser">DEMO</span>' : ''}
        <span class="who">${esc(user.name || user.email)}<span class="role">${esc(user.role)}</span></span>
        <button class="btn ghost sm" id="sign-out">Sign out</button>
      </div>
    </header>
    <nav class="tabs" id="tabs">
      ${NAV.map(n => `<button class="tab" data-view="${n.key}">${n.icon} <span>${esc(n.label)}</span></button>`).join('')}
    </nav>
    <main class="shell" id="screen"></main>`;

  document.getElementById('sign-out').addEventListener('click', () => {
    booted = false;
    store.signOutNow();
  });
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) { view = b.dataset.view; paint(); }
  });
  document.getElementById('screen').addEventListener('click', onAction);
  document.getElementById('screen').addEventListener('change', onChangeEvent);
  document.getElementById('screen').addEventListener('input', onInput);
  paint();
}

// --------------------------------------------------------------- painting ---

function paint() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  if (view === 'orders') return renderOrders(screen);
  if (view === 'customers') return renderCustomers(screen, allOrders());
  if (view === 'settings') return renderSettings(screen);
  if (view === 'factory') return screen.innerHTML = overview() + phaseStub(2, 'Factory floor', [
    'A week-by-week planner: drag each order into the week it gets built',
    'Printable job cards per couch, with the cut list and fabric',
    'Build stages so the floor can see what is at frames, foam, upholstery or finishing',
    'Who is working on what, and what is waiting on fabric'
  ]);
  if (view === 'costing') return screen.innerHTML = phaseStub(3, 'Costing', [
    'Materials library with current prices: timber, foam, webbing, fabric, feet, glue',
    'A bill of materials per product, so a true cost comes out automatically',
    'Labour per piece plus a share of monthly overheads',
    'Cost versus the price charged, per product and per customer',
    'A price sheet Couch Potato can quote from, in their own name'
  ]);
  if (view === 'scan') return screen.innerHTML = phaseStub(4, 'Scan out', [
    'A QR code printed on each job card, unique to that couch',
    'Any phone or tablet camera scans it at the loading door',
    'Scanning marks the order dispatched and stamps who sent it out and when',
    'The customer is notified automatically that their couch has left',
    'The item drops straight into the invoice queue for the bookkeeper'
  ]);
  if (view === 'invoices') return screen.innerHTML = phaseStub(5, 'Invoices', [
    'An invoice queue fed by scan-outs, so nothing dispatched goes unbilled',
    'Invoices in Couch Potato’s own name, numbering and VAT',
    'Per-customer statements and what is still outstanding',
    'Payments recorded against invoices',
    'A monthly export for their accountant'
  ]);
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
      ${row(
        field('VAT registered', 's-vatreg', { type: 'select', value: s.vatRegistered ? 'yes' : 'no', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] }),
        field('VAT rate (%)', 's-vatrate', { value: Math.round((s.vatRate || 0) * 100), type: 'number', min: 0, step: '0.01' })
      )}
      <div class="card-actions"><button class="btn primary" data-act="save-settings">💾 Save settings</button></div>
    </div>
    <div class="card">
      <h2>How this system is wired</h2>
      <ul class="plain">
        <li><strong>Separate from every customer.</strong> Its own database, hosting and logins. Bellville Furniture is simply customer number one.</li>
        <li><strong>One record per order.</strong> Saves send only what changed, so two people working at once can never overwrite each other’s orders.</li>
        <li><strong>Every change is stamped.</strong> Each order carries its own history of who changed what and when.</li>
        <li><strong>Storage:</strong> ${store.storeMode() === 'cloud' ? 'connected to Couch Potato’s own database.' : 'demo mode — this browser only. See SETUP.md to connect the real database.'}</li>
      </ul>
    </div>`;
}

async function saveSettings() {
  const g = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  const patch = {
    name: g('s-name') || 'Couch Potato',
    legalName: g('s-legal'),
    regNo: g('s-reg'),
    vatNo: g('s-vat'),
    phone: g('s-phone'),
    email: g('s-email'),
    address: g('s-address'),
    bankDetails: g('s-bank'),
    orderPrefix: g('s-oprefix') || 'CP-',
    firstOrderNo: parseInt(g('s-ofirst'), 10) || 1001,
    invoicePrefix: g('s-iprefix') || 'INV-',
    paymentTermsDays: parseInt(g('s-terms'), 10) || 0,
    vatRegistered: g('s-vatreg') === 'yes',
    vatRate: (parseFloat(g('s-vatrate')) || 0) / 100
  };
  await store.saveSettings(patch);
  settings = { ...settings, ...patch };
  setOrderSettings(settings);
  const bn = document.querySelector('.brand-name');
  if (bn) bn.textContent = settings.name;
  toast('Settings saved');
}

// ---------------------------------------------------------------- events ----

async function onAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'new-order': return newOrder();
    case 'edit-order': return editOrder(id);
    case 'del-order': return deleteOrder(id);
    case 'status': return setStatus(id, b.dataset.to);
    case 'history': return showHistory(id);
    case 'new-customer': return newCustomer();
    case 'edit-customer': return editCustomer(id);
    case 'del-customer': return deleteCustomer(id, parseInt(b.dataset.n, 10) || 0);
    case 'save-settings': return saveSettings();
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
  if (t.id === 'o-filter-cust') { setFilter({ customer: t.value }); return paint(); }
  if (t.id === 'o-filter-status') { setFilter({ status: t.value }); return paint(); }
  const act = t.dataset ? t.dataset.act : '';
  if (act === 'fabric') return setFabric(t.dataset.id, t.value);
  if (act === 'due') return setDue(t.dataset.id, t.value);
}

let searchTimer = null;
function onInput(e) {
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    const status = document.getElementById('login-status');
    status.textContent = '';
    try {
      await store.signIn(email, pass);
    } catch (err) {
      status.textContent = (err && err.code === 'auth/invalid-credential')
        ? 'That email and password do not match.'
        : 'Could not sign in: ' + ((err && err.message) || 'unknown error');
    }
  });
  boot().catch(err => {
    document.getElementById('login-status').textContent = 'Startup failed: ' + err.message;
    console.error(err);
  });
});
