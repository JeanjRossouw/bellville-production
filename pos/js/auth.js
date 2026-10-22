// Retail POS — who is at the till.
//
// Two ways in. An owner or manager signs in with email and password (Firebase
// Auth). Staff at an enrolled till type a PIN: the till sends its own id and
// secret with the PIN to the server, which answers with a Firebase custom
// token for that person, so they are signed in as themselves and the database
// rules apply to them by name. With the line down, the till checks the PIN
// against the cache of its store's staff it kept from the last sync.
//
// The device record (its id and secret) lives in this browser's localStorage.
// So does the PIN cache. Neither ever leaves the device except to the server.
//
// requireOverride() is the manager-PIN modal any screen can call. The server
// logs the actor and the approver on one audit row and returns a short-lived
// token the write that needed the approval carries along.
import { API, APP_VERSION, RANK, DEFAULTS } from './config.js';
import { fb, EMULATOR } from './db.js';
import { openModal, closeModal, pinPadHtml, wirePinPad, toast, esc } from './ui.js';

const LS_DEVICE = 'pos-device';
const LS_CACHE = 'pos-pincache';
const LS_LAST = 'pos-last-user';
const LS_MODE = 'pos-mode';          // how the last sign-in was made, so a reload keeps it

// what the rest of the app reads
export const session = {
  mode: '',          // '' | 'email' | 'pin' | 'pin-offline'
  uid: '',
  user: null,        // { uid, name, email, role, entityIds, storeIds, defaultStoreId, pinSet }
  device: null,      // { deviceId, label, entityId, storeId, registerId } when this browser is an enrolled till
  nobodyYet: false   // the group has no owner yet: the first sign-in may claim it
};
let secret = '';     // the device secret, in memory while the page lives
const listeners = [];
export const onSession = (fn) => { listeners.push(fn); };
const emit = () => listeners.forEach(fn => { try { fn(session); } catch (e) { console.error(e); } });

export const rank = (role) => RANK[role] || 0;
export const atLeast = (role) => !!session.user && rank(session.user.role) >= rank(role);
export const inEntity = (e) => !!session.user && (session.user.role === 'owner' || (session.user.entityIds || []).includes(e));
export const inStore = (s) => !!session.user && (session.user.role === 'owner' || (session.user.storeIds || []).includes(s));
export const deviceId = () => (session.device && session.device.deviceId) || 'web';

// the five stamps on a record this browser writes (rule 6)
export function stamp(entityId, storeId = '') {
  return { entityId, storeId: storeId || '', createdBy: session.uid, createdAt: new Date().toISOString(), deviceId: deviceId() };
}
export const touch = () => ({ updatedBy: session.uid, updatedAt: new Date().toISOString() });

// ------------------------------------------------------------- the server --
async function idToken() {
  const u = fb.auth && fb.auth.currentUser;
  return u ? await u.getIdToken() : '';
}
export async function api(action, body = {}, url = API.auth) {
  const token = await idToken();
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ appVersion: APP_VERSION, ...body, action }) });
  } catch (e) { const err = new Error('No connection to the server.'); err.offline = true; throw err; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || 'The server said no (' + r.status + ').'); err.status = r.status; throw err; }
  return j;
}

// ----------------------------------------------------------- the device --
function loadDevice() {
  try { const d = JSON.parse(localStorage.getItem(LS_DEVICE) || 'null'); if (d && d.deviceId && d.secret) { secret = d.secret; const { secret: _s, ...pub } = d; return pub; } } catch (e) {}
  return null;
}
function saveDevice(d, s) { try { localStorage.setItem(LS_DEVICE, JSON.stringify({ ...d, secret: s })); } catch (e) {} }
export function forgetDevice() { try { localStorage.removeItem(LS_DEVICE); localStorage.removeItem(LS_CACHE); } catch (e) {} secret = ''; session.device = null; emit(); }
const devBody = () => session.device ? { deviceId: session.device.deviceId, secret } : {};
export const deviceBody = devBody;   // the till's identity for the other functions

function loadCache() { try { return JSON.parse(localStorage.getItem(LS_CACHE) || 'null') || { at: '', staff: [] }; } catch (e) { return { at: '', staff: [] }; } }
function saveCache(staff) { try { localStorage.setItem(LS_CACHE, JSON.stringify({ at: new Date().toISOString(), staff })); } catch (e) {} }

// PBKDF2-SHA256 in the browser, the same way the server hashes a PIN, so the
// offline check compares like with like.
async function pbkdf2Hex(pin, saltHex, iterations) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function cachedMatch(pin, minRole) {
  const { staff } = loadCache();
  for (const s of staff) {
    if (minRole && rank(s.role) < rank(minRole)) continue;
    if (await pbkdf2Hex(pin, s.salt, s.iterations) === s.hash) return s;
  }
  return null;
}

// ------------------------------------------------------------------ boot --
let ready = null;
export function boot() {
  if (ready) return ready;
  session.device = loadDevice();
  ready = new Promise((resolve) => {
    let first = true;
    fb.fns.onAuthStateChanged(fb.auth, async (u) => {
      if (u) await adoptLogin(u);
      else if (session.mode !== 'pin-offline') { session.mode = ''; session.uid = ''; session.user = null; }
      emit();
      if (first) { first = false; resolve(session); }
    });
  });
  return ready;
}
// a Firebase user is signed in: find out who they are to the POS
async function adoptLogin(u) {
  try {
    const r = await api('me', devBody());
    session.nobodyYet = !!r.nobodyYet;
    if (r.device) session.device = r.device;
    if (r.user) { session.user = r.user; session.uid = r.user.uid; session.mode = session.mode || rememberedMode(r.user); try { localStorage.setItem(LS_LAST, JSON.stringify(r.user)); } catch (e) {} }
    else { session.user = null; session.uid = u.uid; session.mode = 'email'; }
  } catch (e) {
    // offline: the last answer stands
    let last = null; try { last = JSON.parse(localStorage.getItem(LS_LAST) || 'null'); } catch (x) {}
    if (last && last.uid === u.uid) { session.user = last; session.uid = u.uid; session.mode = session.mode || rememberedMode(last); }
    else { session.user = null; session.uid = u.uid; session.mode = 'email'; }
  }
}

// the mode a reload comes back in: what was remembered, else PIN on a till for someone without an email
function rememberedMode(user) {
  let m = ''; try { m = localStorage.getItem(LS_MODE) || ''; } catch (e) {}
  if (m === 'pin' || m === 'email') return m;
  return session.device && !(user && user.email) ? 'pin' : 'email';
}
const rememberMode = (m) => { try { localStorage.setItem(LS_MODE, m); } catch (e) {} };

// ------------------------------------------------------------- sign in --
export async function signInEmail(email, password) {
  rememberMode('email');
  await fb.fns.signInWithEmailAndPassword(fb.auth, String(email || '').trim(), password);
  session.mode = 'email';
}
export async function claimGroup(name, groupName) {
  const r = await api('bootstrap', { name, groupName });
  session.user = r.user; session.uid = r.user.uid; session.nobodyYet = false; emit();
  return r;
}
export async function signInPin(pin) {
  if (!session.device) throw new Error('This till is not enrolled yet.');
  try {
    const r = await api('pinLogin', { ...devBody(), pin });
    saveCache(r.staff || []);
    rememberMode('pin');
    session.mode = 'pin';
    session.user = r.user; session.uid = r.user.uid; session.device = r.device;
    try { localStorage.setItem(LS_LAST, JSON.stringify(r.user)); } catch (e) {}
    await fb.fns.signInWithCustomToken(fb.auth, r.token);   // onAuthStateChanged → adoptLogin keeps mode 'pin'
    emit();
    return r.user;
  } catch (e) {
    if (!e.offline) throw e;
    // the line is down: the cached staff list decides
    const s = await cachedMatch(pin);
    if (!s) throw new Error('No connection, and that PIN is not in this till’s offline list.');
    session.mode = 'pin-offline';
    session.user = { uid: s.uid, name: s.name, role: s.role, entityIds: s.entityIds, storeIds: s.storeIds, defaultStoreId: session.device.storeId, pinSet: true, email: '' };
    session.uid = s.uid;
    emit();
    toast('Signed in offline as ' + s.name + '. Sales will send when the line is back.', 'warn');
    return session.user;
  }
}
// lock the till: back to the PIN pad. The Firebase session stays (so the
// cached data still reads offline); the next person signs in over it.
export function lock() {
  closeModal();
  session.mode = ''; session.uid = ''; session.user = null; emit();
}
export async function signOut() {
  closeModal();
  session.mode = ''; session.uid = ''; session.user = null;
  try { localStorage.removeItem(LS_LAST); localStorage.removeItem(LS_MODE); } catch (e) {}
  await fb.fns.signOut(fb.auth);
  emit();
}
export async function refreshPinCache() {
  if (!session.device) return;
  try { const r = await api('pinCache', devBody()); saveCache(r.staff || []); } catch (e) {}
}

// ----------------------------------------------------------- enrolment --
export async function enrolDevice({ storeId, registerId, label }) {
  const r = await api('enrol', { storeId, registerId, label });
  saveDevice(r.device, r.secret);
  secret = r.secret; session.device = r.device; emit();
  await refreshPinCache();
  return r.device;
}

// --------------------------------------------------------- the override --
// requireOverride({ minRole: 'manager', action: 'discount', docType, docId, details, title })
//   → { uid, name, role, token } or throws when refused / cancelled
export function requireOverride(o = {}) {
  const minRole = o.minRole || 'manager';
  const roleLabel = minRole === 'owner' ? 'the owner' : 'a ' + minRole;
  return new Promise((resolve, reject) => {
    let done = false;
    const { close, wrap } = openModal(o.title || 'Needs ' + roleLabel, `
      <p class="muted">${esc(o.text || 'Ask ' + roleLabel + ' to type their PIN to approve this.')}</p>
      ${pinPadHtml({ length: DEFAULTS.pinLength })}`, {
      okLabel: 'Approve', cancelLabel: 'Cancel',
      onOk: () => { pad.querySelector('[data-key=ok]').click(); return false; },
      onClose: () => { if (!done) { done = true; reject(new Error('Not approved')); } }
    });
    const pad = wrap.querySelector('.pinpad');
    wirePinPad(pad, async (pin) => {
      const body = { pin, minRole, what: o.action || 'approve', docType: o.docType || '', docId: o.docId || '', details: o.details || {}, actorUid: session.uid, actorName: session.user ? session.user.name : '' };
      if (session.device) Object.assign(body, devBody());
      else { body.entityId = o.entityId || (session.user && session.user.entityIds[0]) || ''; body.storeId = o.storeId || (session.user && session.user.defaultStoreId) || ''; }
      let r;
      try { r = await api('override', body); }
      catch (e) {
        if (!e.offline) throw e;
        // offline: the cached list decides, and the approval is logged when the line is back (step 9's outbox)
        const s = await cachedMatch(pin, minRole);
        if (!s) throw new Error('No connection, and no ' + minRole + ' PIN in this till’s offline list matches.');
        if (s.uid === session.uid) throw new Error('You cannot approve your own action.');
        r = { uid: s.uid, name: s.name, role: s.role, token: '', offline: true };
      }
      done = true; close(true); resolve(r);
    });
  });
}

// ----------------------------------------------------------------- idle --
// After this many quiet minutes a PIN user is locked out to the pad and an
// email user is signed out.
let idleTimer = null, idleMinutes = DEFAULTS.idleLogoutMinutes;
export function setIdleMinutes(m) { idleMinutes = Number(m) > 0 ? Number(m) : DEFAULTS.idleLogoutMinutes; armIdle(); }
function armIdle() {
  clearTimeout(idleTimer);
  if (!session.user) return;
  idleTimer = setTimeout(onIdle, idleMinutes * 60000);
}
async function onIdle() {
  if (!session.user) return;
  if (session.mode === 'email') { await signOut(); toast('Signed out after ' + idleMinutes + ' quiet minutes.'); }
  else { lock(); toast('Locked after ' + idleMinutes + ' quiet minutes. Type your PIN.'); }
}
export function watchIdle() {
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(ev => document.addEventListener(ev, armIdle, { passive: true, capture: true }));
  onSession(armIdle);
  armIdle();
}
export const forceIdle = onIdle;   // tests
