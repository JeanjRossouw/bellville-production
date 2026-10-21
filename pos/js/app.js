// Retail POS — the shell: sign-in, the menu, and the screens of step 2
// (Home, Staff, Devices, Me). Later steps add Sell, Products, Admin.
import { APP_VERSION, ROLES, DEFAULTS } from './config.js';
import { initFirebase, watch, getOne, patchOne } from './db.js';
import * as auth from './auth.js';
import { esc, toast, openModal, field, row, val, checks, empty, niceDate, niceTime } from './ui.js';

const $ = (id) => document.getElementById(id);
let view = 'home';
let entities = [], stores = [], registers = [], users = [], devices = [];
const unwatch = [];

// ------------------------------------------------------------------ boot --
async function main() {
  await initFirebase();
  auth.onSession(onSession);
  auth.watchIdle();
  wireLogin();
  $('screen').addEventListener('click', onAction);
  $('sign-out').addEventListener('click', () => auth.signOut());
  $('lock').addEventListener('click', () => auth.lock());
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) { view = b.dataset.view; paint(); } });
  await auth.boot();
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
  if (owner) { w('entities', [], r => { entities = r; }); w('stores', [], r => { stores = r; }); w('registers', [], r => { registers = r; }); }
  else {
    if (ents.length) w('entities', [['entityId', 'in', ents.slice(0, 30)]], r => { entities = r; });
    // a store-scoped query must name both the entity and the store for the rules to allow it
    if (ents.length && sts.length) { w('stores', [['entityId', 'in', ents.slice(0, 10)], ['storeId', 'in', sts.slice(0, 10)]], r => { stores = r; }); w('registers', [['entityId', 'in', ents.slice(0, 10)], ['storeId', 'in', sts.slice(0, 10)]], r => { registers = r; }); }
  }
  if (auth.atLeast('manager')) {
    w('users', [], r => { users = r; });
    if (owner) w('devices', [], r => { devices = r; });
    else if (ents.length && sts.length) w('devices', [['entityId', 'in', ents.slice(0, 10)], ['storeId', 'in', sts.slice(0, 10)]], r => { devices = r; });
  }
  // the idle time comes from the entity's settings (the till's entity, else the person's first)
  const eid = (auth.session.device && auth.session.device.entityId) || ents[0] || (owner ? '' : '');
  if (eid) getOne('settings', eid).then(s => auth.setIdleMinutes((s && s.session && s.session.idleLogoutMinutes) || DEFAULTS.idleLogoutMinutes)).catch(() => {});
}
function stopData() { while (unwatch.length) { try { unwatch.pop()(); } catch (e) {} } entities = []; stores = []; registers = []; users = []; devices = []; }

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
  $('app').hidden = true; $('claim').hidden = true; $('nobody').hidden = true;
  const fbUser = auth.session.uid && !auth.session.user;
  if (fbUser && auth.session.nobodyYet) { $('login').hidden = true; $('claim').hidden = false; return; }
  if (fbUser) { $('login').hidden = true; $('nobody').hidden = false; return; }
  $('login').hidden = false;
  $('login-device').textContent = auth.session.device ? 'This till: ' + (auth.session.device.label || '') : '';
  setLoginMode(auth.session.device ? 'pin' : 'email');
}

// ----------------------------------------------------------------- app --
function showApp() {
  $('login').hidden = true; $('claim').hidden = true; $('nobody').hidden = true; $('app').hidden = false;
  const u = auth.session.user;
  $('who').innerHTML = `<strong>${esc(u.name)}</strong><small>${esc(roleLabel(u.role))}${auth.session.mode === 'pin-offline' ? ' · offline' : ''}</small>`;
  $('lock').hidden = auth.session.mode === 'email';
  $('brand-sub').textContent = auth.session.device ? (storeName(auth.session.device.storeId) || auth.session.device.label) : 'Office';
  if (!navItems().some(n => n.key === view)) view = 'home';
  paint();
}
const roleLabel = (k) => (ROLES.find(r => r.key === k) || { label: k }).label;
const storeName = (id) => (stores.find(s => s.id === id) || {}).name || '';
const entityName = (id) => { const e = entities.find(x => x.id === id); return e ? (e.tradingName || e.legalName) : id; };
function navItems() {
  const out = [{ key: 'home', label: 'Home' }];
  if (auth.atLeast('manager')) out.push({ key: 'staff', label: 'Staff' }, { key: 'devices', label: 'Devices' });
  out.push({ key: 'me', label: 'My PIN' });
  return out;
}
function paint() {
  if (!auth.session.user) return;
  $('nav').innerHTML = navItems().map(n => `<button class="tab${n.key === view ? ' on' : ''}" data-view="${n.key}">${esc(n.label)}</button>`).join('');
  const screen = $('screen');
  if (view === 'staff') screen.innerHTML = staffHtml();
  else if (view === 'devices') screen.innerHTML = devicesHtml();
  else if (view === 'me') screen.innerHTML = meHtml();
  else screen.innerHTML = homeHtml();
}

function homeHtml() {
  const u = auth.session.user, d = auth.session.device;
  return `<div class="page-head"><h1>Home</h1></div>
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
    <p class="muted" style="margin-top:1rem">Selling, products and the admin screens come in the next steps. Version ${esc(APP_VERSION)}.</p>`;
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
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
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
  if (e.target.id === 'dv-store') {
    const sel = $('dv-register'); if (!sel) return;
    const regs = registers.filter(r => r.storeId === e.target.value);
    sel.innerHTML = '<option value="">No register yet</option>' + regs.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  }
});

import * as __ui from './ui.js';
window.__ui = __ui;
main().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p class="boot-fail">The till could not start: ${esc(e.message)}</p>`); });
