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
export const ROLES = [
  { key: 'owner', label: 'Owner', hint: 'Everything, plus the team and the subscription' },
  { key: 'office', label: 'Office', hint: 'Orders, customers, costing, invoices, settings' },
  { key: 'sales', label: 'Sales / till', hint: 'Point of sale, orders and customers' },
  { key: 'factory', label: 'Factory floor', hint: 'The floor planner, job cards and scan out' }
];
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
const DEMO_PLAN = { id: 'standard', name: 'Standard', amount: 799, currency: 'ZAR', interval: 'month', includes: 'Every feature, unlimited users and orders' };

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

// ---- the seller's own view of every company ----

export async function isSeller() {
  if (mode === 'demo') return !!(currentUser && currentUser.companyId === 'demo' && currentUser.role === 'owner');
  try { return (await cloud.fns.getDoc(cloud.fns.doc(cloud.db, 'admins', currentUser.uid))).exists(); }
  catch (e) { return false; }
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
  try { await fsMod.enableIndexedDbPersistence(db); } catch (e) { /* multi-tab or unsupported */ }
  cloud = { auth, db, fns: { ...authMod, ...fsMod } };
  mode = 'cloud';

  cloud.fns.onAuthStateChanged(auth, async (u) => {
    try { currentUser = u ? await resolveUser(u) : null; }
    catch (e) { console.error('Could not load the account:', e); currentUser = u ? { uid: u.uid, email: u.email, name: u.email, role: 'none', companyId: null, error: e.message } : null; }
    if (!currentUser) company = null;
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
  const { doc, getDoc } = cloud.fns;
  const email = lower(u.email);
  const me = await getDoc(doc(cloud.db, 'users', u.uid));
  if (me.exists() && me.data().companyId) {
    const cid = me.data().companyId;
    const [mem, comp] = await Promise.all([
      getDoc(doc(cloud.db, 'companies', cid, 'members', u.uid)),
      getDoc(doc(cloud.db, 'companies', cid))
    ]);
    if (mem.exists() && comp.exists()) {
      company = { id: cid, ...normCompany(comp.data()) };
      return { uid: u.uid, email, name: mem.data().name || me.data().name || email, role: mem.data().role || 'none', companyId: cid };
    }
  }
  const invite = await getDoc(doc(cloud.db, 'invites', email));
  if (invite.exists()) return await joinCompany(u, invite.data(), (pendingSignup && pendingSignup.name) || '');
  const p = pendingSignup; pendingSignup = null;
  if (p && p.companyName) return await createCompanyFor(u, p.companyName, p.name);
  company = null;
  return { uid: u.uid, email, name: (p && p.name) || (me.exists() && me.data().name) || email, role: 'none', companyId: null };
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
  b.set(doc(cloud.db, 'users', u.uid), { email, name: who, companyId: cid });
  b.set(doc(cloud.db, 'companies', cid, 'settings', 'factory'), { name: companyName, legalName: companyName, orderPrefix: prefixFor(companyName), email, updatedAt: nowIso() });
  await b.commit();
  company = { id: cid, name: companyName, ownerUid: u.uid, plan: 'trial', status: 'trial', createdAt: nowIso() };
  return { uid: u.uid, email, name: who, role: 'owner', companyId: cid };
}

async function joinCompany(u, inv, name) {
  const { doc, getDoc, writeBatch } = cloud.fns;
  const email = lower(u.email);
  const cid = inv.companyId;
  const who = name || inv.name || email;
  const b = writeBatch(cloud.db);
  b.set(doc(cloud.db, 'companies', cid, 'members', u.uid), { email, name: who, role: inv.role, joinedAt: nowIso(), invitedBy: inv.invitedBy || '' });
  b.set(doc(cloud.db, 'users', u.uid), { email, name: who, companyId: cid });
  b.delete(doc(cloud.db, 'invites', email));
  b.delete(doc(cloud.db, 'companies', cid, 'invites', email));
  await b.commit();
  const comp = await getDoc(doc(cloud.db, 'companies', cid));
  company = { id: cid, ...normCompany(comp.data() || {}) };
  pendingSignup = null;
  return { uid: u.uid, email, name: who, role: inv.role, companyId: cid };
}

function emitUser() { userWatchers.forEach(cb => { try { cb(currentUser); } catch (e) { console.error(e); } }); }
export function onUser(cb) { userWatchers.push(cb); if (mode === 'demo') cb(currentUser); return () => {
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
  if (mode === 'demo') return;
  await cloud.fns.sendPasswordResetEmail(cloud.auth, lower(email));
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
  if (!ROLES.some(r => r.key === role)) throw new Error('Pick a role');
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
  if (!ROLES.some(r => r.key === role)) throw new Error('Unknown role');
  await update('members', uid, { role });
}

// Removing someone takes away their access to this company at once; their
// login still exists, but it no longer opens anything.
export async function removeMember(uid) {
  await remove('members', uid);
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
  return { uid: 'demo-' + email, name: name || email, companyId: cid, role: 'owner' };
}
function demoJoin(email, inv, name) {
  const all = demoInvites(); delete all[email]; localStorage.setItem('cp-demo-invites', JSON.stringify(all));
  const k = demoPrefix(inv.companyId) + 'invites'; const map = jget(k); delete map[email]; localStorage.setItem(k, JSON.stringify(map));
  const acc = { uid: 'demo-' + email, name: name || inv.name || email, companyId: inv.companyId, role: inv.role };
  demoMemberSet(inv.companyId, acc.uid, { email, name: acc.name, role: inv.role, invitedBy: inv.invitedBy || '' });
  const accounts = demoAccounts(); accounts[email] = acc; saveDemoAccounts(accounts);
  return acc;
}
function demoLogin(email, acc) {
  // the role always comes from the company's member list, like the cloud rules
  const mem = acc.companyId ? jget(demoPrefix(acc.companyId) + 'members')[acc.uid] : null;
  currentUser = { uid: acc.uid, email, name: acc.name, role: acc.companyId ? (mem ? mem.role : 'none') : 'none', companyId: acc.companyId || null };
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
    map[id] = { ...map[id], ...body };
    if (event) map[id].events = [...(map[id].events || []), { at: nowIso(), by: who, what: event }];
    demoWrite(coll, map);
    return;
  }
  if (event) body.events = cloud.fns.arrayUnion({ at: nowIso(), by: who, what: event });
  await cloud.fns.updateDoc(docRef(coll, id), body);
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
  guardWrite('counters');
  if (mode === 'demo') {
    const map = demoRead('counters');
    const next = (map[key] && map[key].value) || first || 1;
    map[key] = { value: next + 1 };
    demoWrite('counters', map);
    return next;
  }
  const ref = docRef('counters', key);
  return await cloud.fns.runTransaction(cloud.db, async (tx) => {
    const snap = await tx.get(ref);
    const next = snap.exists() ? (snap.data().value || first || 1) : (first || 1);
    tx.set(ref, { value: next + 1 }, { merge: true });
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
    return d.toISOString().split('T')[0];
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
    'd3': mk(1003, { status: 'ready', product: 'Corner Unit 2.8 x 2.8', fabric: 'Magical : Eclipse', priceEach: 15900, fabricStatus: 'received', paidDate: day(-30), dueDate: day(-2), planWeek: monday(0) }),
    'd5': mk(1005, { status: 'dispatched', product: 'Ottoman 900mm', fabric: 'Adore : Flint Grey', priceEach: 2400, qty: 2, fabricStatus: 'received', paidDate: day(-35), dueDate: day(-7), dispatchedAt: new Date(Date.now() - 86400000).toISOString(), dispatchedBy: 'Thandi' }),
    'd4': { ...mk(1004, { status: 'new', product: 'Daybed 2.4m', priceEach: 11200, paidDate: day(-10), dueDate: day(18), fabricStatus: 'ordered', planWeek: monday(7) }), customerId: 'd-walkin', customerName: 'Private client — J. Marais', source: 'manual', externalRef: '' }
  });
  demoWrite('counters', { orderNo: { value: 1006 }, invoiceNo: { value: 1 } });
  demoWrite('settings', { factory: {
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
function seedDemoExtras() {
  const orders = demoRead('orders');
  if (orders['r1']) return;
  let seed = 20261006;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().split('T')[0]; };
  const monday = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().split('T')[0]; };

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
    if (status === 'dispatched') { o.dispatchedAt = new Date(Date.now() - Math.floor(rnd() * 5 + 1) * 86400000).toISOString(); o.dispatchedBy = pick(['Sipho', 'Thandi']); }
    orders['r' + i] = o;
  }
  demoWrite('orders', orders);
  const counters = demoRead('counters');
  counters.orderNo = { value: Math.max(n, (counters.orderNo && counters.orderNo.value) || 0) };
  demoWrite('counters', counters);
}
