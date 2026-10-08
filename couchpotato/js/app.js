// The app shell — sign-in and sign-up, boot, navigation by role, Settings and the team.
import * as store from './store.js';
import { FACTORY_DEFAULTS, isCloudConfigured, PRODUCT, TRIAL_DAYS } from './config.js';
import { esc, field, row, toast, money, daysUntil } from './ui.js';
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
import { startPos, renderPos, setPosSettings, posAction, posInput } from './pos.js';
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

const NAV = [
  { key: 'pos', icon: '', label: 'Point of sale' },
  { key: 'orders', icon: '', label: 'Orders' },
  { key: 'customers', icon: '', label: 'Customers' },
  { key: 'factory', icon: '', label: 'Factory floor' },
  { key: 'costing', icon: '', label: 'Costing' },
  { key: 'scan', icon: '', label: 'Scan out' },
  { key: 'invoices', icon: '', label: 'Invoices' },
  { key: 'settings', icon: '', label: 'Settings' }
];

// What each role sees. The owner also gets the team under Settings.
const ROLE_VIEWS = {
  owner: NAV.map(n => n.key),
  office: NAV.map(n => n.key),
  sales: ['pos', 'orders', 'customers'],
  factory: ['factory', 'scan', 'orders']
};
const allowedViews = (user) => ROLE_VIEWS[user && user.role] || [];
let team = { members: [], invites: [] };

// ------------------------------------------------------------------ boot ----

async function boot() {
  await store.initStore();
  store.onUser(async (user) => {
    if (!user) { showLogin(); return; }
    if (user.role === 'none' || !allowedViews(user).length) { showNoAccess(user); return; }
    if (!allowedViews(user).includes(view)) view = allowedViews(user)[0];
    if (!booted) {
      booted = true;
      if (user.role === 'owner') {
        store.watch('members', rows => { team.members = rows; if (view === 'settings') paint(); });
        store.watch('invites', rows => { team.invites = rows; if (view === 'settings') paint(); });
      }
      store.seedDemoIfEmpty();
      settings = await store.loadSettings(FACTORY_DEFAULTS);
      setOrderSettings(settings);
      setFloorSettings(settings);
      setCostingSettings(settings);
      setScanSettings(settings);
      setInvoiceSettings(settings);
      setPosSettings(settings);
      startPos(() => { if (view === 'pos') paint(); }, settings);
      startInvoices(() => { if (view === 'invoices' || view === 'orders') paint(); }, settings);
      startCosting(() => { if (view === 'costing' || view === 'orders' || view === 'pos') paint(); }, settings);
      startCustomers(() => { if (view === 'customers' || view === 'orders' || view === 'pos') paint(); });
      startOrders(() => {
        if (view !== 'settings') paint();
        if (pendingScan) { const id = pendingScan; pendingScan = ''; view = 'scan'; paint(); confirmDispatch(id); }
      }, settings);
      if (pendingScan) view = 'scan';
    }
    showApp(user);
  });
}

// ?join=<email> is the link an owner sends to someone they invited.
const JOIN_EMAIL = new URLSearchParams(location.search).get('join') || '';

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
        ${trialChip()}
        <span class="who">${esc(user.name || user.email)}<span class="role">${esc(user.role)}</span></span>
        <button class="btn ghost sm" id="sign-out">Sign out</button>
      </div>
    </header>
    <nav class="tabs" id="tabs">
      ${NAV.filter(n => allowedViews(user).includes(n.key)).map(n => `<button class="tab" data-view="${n.key}"><span>${esc(n.label)}</span></button>`).join('')}
    </nav>
    <main class="shell" id="screen"></main>`;

  document.getElementById('sign-out').addEventListener('click', signOutAndReset);
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b && allowedViews(store.getUser()).includes(b.dataset.view)) { view = b.dataset.view; paint(); }
  });
  document.getElementById('screen').addEventListener('click', onAction);
  document.getElementById('screen').addEventListener('change', onChangeEvent);
  document.getElementById('screen').addEventListener('input', onInput);
  paint();
}

function trialChip() {
  const left = store.trialDaysLeft();
  if (left == null) return '';
  return `<span class="trial-chip ${left <= 3 ? 'low' : ''}" title="Free trial">${left > 0 ? 'Trial · ' + left + ' day' + (left === 1 ? '' : 's') + ' left' : 'Trial ended'}</span>`;
}

// --------------------------------------------------------------- painting ---

function paint() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  if (view !== 'scan') stopCamera(screen);
  if (view === 'orders') return renderOrders(screen);
  if (view === 'customers') return renderCustomers(screen, allOrders());
  if (view === 'settings') return renderSettings(screen);
  if (view === 'factory') return renderFloor(screen, overview());
  if (view === 'costing') return renderCosting(screen);
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
    ${store.getUser().role === 'owner' ? teamCard() : ''}
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

// ------------------------------------------------------------------ team ----

const joinLink = (email) => location.origin + location.pathname + '?join=' + encodeURIComponent(email);
function inviteMessage(inv) {
  const co = settings.name || (store.getCompany() || {}).name || 'our company';
  return 'Hi' + (inv.name ? ' ' + inv.name.split(' ')[0] : '') + ', you are invited to ' + co + ' on ' + PRODUCT.name + '. '
    + 'Create your login with this email address (' + inv.email + ') here: ' + joinLink(inv.email);
}

function teamCard() {
  const me = store.getUser();
  const roleOpts = (cur) => store.ROLES.map(r => `<option value="${r.key}" ${r.key === cur ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
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
      <div><div class="who-n">${esc(i.name || i.email)}</div><div class="who-e">${esc(i.email)} · ${esc((store.ROLES.find(r => r.key === i.role) || {}).label || i.role)}</div></div>
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
      ${field('Role', 'ti-role', { type: 'select', value: 'office', options: store.ROLES.filter(r => r.key !== 'owner').concat(store.ROLES.filter(r => r.key === 'owner')).map(r => ({ value: r.key, label: r.label })) })}
      <div class="fld"><button class="btn primary" data-act="invite">Invite</button></div>
    </div>
    <ul class="roles-help">${store.ROLES.map(r => `<li><strong>${esc(r.label)}:</strong> ${esc(r.hint)}</li>`).join('')}</ul>
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
  if (!confirm('Change ' + (m.name || m.email) + ' to ' + ((store.ROLES.find(r => r.key === role) || {}).label || role) + '?')) { paint(); return; }
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
  const bn = document.querySelector('.brand-name');
  if (bn) bn.textContent = settings.name;
  toast('Settings saved');
}

// ---------------------------------------------------------------- events ----

async function onAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
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
    case 'invite': return sendInvite();
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
      setOrderSettings(settings); setFloorSettings(settings); setCostingSettings(settings);
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
  if (act === 'member-role') return memberRole(t.dataset.id, t.value);
  if (act === 'fabric') return setFabric(t.dataset.id, t.value);
  if (act === 'due') return setDue(t.dataset.id, t.value);
  if (t.id === 'inv-filter') { setInvFilter(t.value); return paint(); }
  if (t.id === 'stmt-cust') { setStmtCustomer(t.value); return paint(); }
}

let searchTimer = null;
function onInput(e) {
  if (e.target.classList && e.target.classList.contains('pos-in')) {
    if (e.target.id === 'pos-search') { clearTimeout(searchTimer); searchTimer = setTimeout(() => posInput(e.target), 160); return; }
    return posInput(e.target);
  }
  if (e.target.closest && e.target.closest('.oh-row, #oh-units')) return liveOverheads(document.getElementById('screen'));
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
