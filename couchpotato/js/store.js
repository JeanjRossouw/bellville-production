// Data layer for the Couch Potato factory system.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: every record is its own document.
// Orders, customers, products and invoices each live in their own Firestore
// document, and a save sends ONLY the fields that changed.
//
// Why that matters: the older Bellville system kept every order for every
// business inside a single document, so each save rewrote the whole lot. A
// device with a stale copy in memory could silently erase orders someone else
// had added — which is exactly what happened in practice. Per-document writes
// make that class of data loss impossible: two people editing two orders, or
// even two fields of one order, never overwrite each other. It also removes the
// 1MB-per-document ceiling and lets the factory floor query only what it needs.
//
// One interface, two backends:
//   cloud — Firebase/Firestore, used as soon as config.js has a project id
//   demo  — this browser's localStorage, so the system can be reviewed and
//           demonstrated before any database is created
import { FIREBASE_CONFIG, isCloudConfigured } from './config.js';

const FB_VERSION = '10.13.0';
const FB = (m) => `https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-${m}.js`;

let mode = 'demo';
let cloud = null;          // { auth, db, fns }
let currentUser = null;    // { uid, email, name, role }
const userWatchers = [];

export const storeMode = () => mode;
export const getUser = () => currentUser;
export const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- boot ------

export async function initStore() {
  if (!isCloudConfigured()) {
    mode = 'demo';
    const saved = localStorage.getItem('cp-demo-user');
    currentUser = saved ? JSON.parse(saved) : null;
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
    currentUser = u ? await resolveUser(u) : null;
    emitUser();
  });
  return mode;
}

// A brand-new system has no users yet, so the first person to sign in becomes
// the owner. After that, roles are explicit and a stranger gets nothing.
async function resolveUser(u) {
  const { doc, getDoc, setDoc, collection, getDocs, limit, query } = cloud.fns;
  const ref = doc(cloud.db, 'users', u.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data();
    return { uid: u.uid, email: u.email, name: d.name || u.email, role: d.role || 'none' };
  }
  const anyUser = await getDocs(query(collection(cloud.db, 'users'), limit(1)));
  const role = anyUser.empty ? 'owner' : 'none';
  await setDoc(ref, { email: u.email, name: u.email, role, createdAt: nowIso() });
  return { uid: u.uid, email: u.email, name: u.email, role };
}

function emitUser() { userWatchers.forEach(cb => { try { cb(currentUser); } catch (e) { console.error(e); } }); }
export function onUser(cb) { userWatchers.push(cb); if (mode === 'demo') cb(currentUser); return () => {
  const i = userWatchers.indexOf(cb); if (i >= 0) userWatchers.splice(i, 1);
}; }

// ---------------------------------------------------------------- auth ------

export async function signIn(email, password) {
  if (mode === 'demo') {
    currentUser = { uid: 'demo', email: email || 'demo@couchpotato.local', name: (email || 'Demo user').split('@')[0], role: 'owner' };
    localStorage.setItem('cp-demo-user', JSON.stringify(currentUser));
    emitUser();
    return currentUser;
  }
  await cloud.fns.signInWithEmailAndPassword(cloud.auth, email, password);
  return currentUser;
}

export async function signOutNow() {
  if (mode === 'demo') {
    currentUser = null;
    localStorage.removeItem('cp-demo-user');
    emitUser();
    return;
  }
  await cloud.fns.signOut(cloud.auth);
}

// ------------------------------------------------------------ demo store ----

const demoKey = (coll) => 'cp-demo-' + coll;
const demoSubs = {};   // coll -> [cb]

function demoRead(coll) {
  try { return JSON.parse(localStorage.getItem(demoKey(coll)) || '{}'); } catch (e) { return {}; }
}
function demoWrite(coll, map) {
  localStorage.setItem(demoKey(coll), JSON.stringify(map));
  (demoSubs[coll] || []).forEach(cb => cb(demoList(coll)));
}
function demoList(coll) {
  const map = demoRead(coll);
  return Object.keys(map).map(id => ({ id, ...map[id] }));
}

// ----------------------------------------------------------------- CRUD -----

// Live list of a collection. Returns an unsubscribe function.
export function watch(coll, cb) {
  if (mode === 'demo') {
    (demoSubs[coll] = demoSubs[coll] || []).push(cb);
    cb(demoList(coll));
    return () => { const a = demoSubs[coll]; const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
  }
  const { collection, onSnapshot } = cloud.fns;
  return onSnapshot(collection(cloud.db, coll), (snap) => {
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
  const snap = await cloud.fns.getDoc(cloud.fns.doc(cloud.db, coll, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function create(coll, data) {
  const who = currentUser ? currentUser.name : 'system';
  const record = { ...data, createdAt: nowIso(), createdBy: who, updatedAt: nowIso(), updatedBy: who };
  if (mode === 'demo') {
    const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const map = demoRead(coll);
    map[id] = record;
    demoWrite(coll, map);
    return id;
  }
  const ref = await cloud.fns.addDoc(cloud.fns.collection(cloud.db, coll), record);
  return ref.id;
}

// Patch-only update: just the named fields are sent, so concurrent edits to
// other fields (or other records) survive untouched. `event` optionally appends
// a line to the record's own audit trail.
export async function update(coll, id, patch, event) {
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
  await cloud.fns.updateDoc(cloud.fns.doc(cloud.db, coll, id), body);
}

export async function remove(coll, id) {
  if (mode === 'demo') {
    const map = demoRead(coll);
    delete map[id];
    demoWrite(coll, map);
    return;
  }
  await cloud.fns.deleteDoc(cloud.fns.doc(cloud.db, coll, id));
}

// ------------------------------------------------------------- numbering ----

// Their own order and invoice sequences, independent of any customer's numbers.
// In the cloud this runs as a transaction so two people capturing orders at the
// same moment can never be handed the same number.
export async function nextNumber(key, first) {
  if (mode === 'demo') {
    const map = demoRead('counters');
    const next = (map[key] && map[key].value) || first || 1;
    map[key] = { value: next + 1 };
    demoWrite('counters', map);
    return next;
  }
  const { doc, runTransaction } = cloud.fns;
  const ref = doc(cloud.db, 'counters', key);
  return await runTransaction(cloud.db, async (tx) => {
    const snap = await tx.get(ref);
    const next = snap.exists() ? (snap.data().value || first || 1) : (first || 1);
    tx.set(ref, { value: next + 1 }, { merge: true });
    return next;
  });
}

// --------------------------------------------------------------- settings ---

export async function loadSettings(defaults) {
  const got = await getOne('settings', 'factory');
  return { ...defaults, ...(got || {}) };
}

export async function saveSettings(patch) {
  if (mode === 'demo') {
    const map = demoRead('settings');
    map.factory = { ...(map.factory || {}), ...patch, updatedAt: nowIso() };
    demoWrite('settings', map);
    return;
  }
  await cloud.fns.setDoc(cloud.fns.doc(cloud.db, 'settings', 'factory'),
    { ...patch, updatedAt: nowIso() }, { merge: true });
}

// Seed a brand-new demo browser with one customer and a few orders, so the
// system can be walked through without typing anything first.
export function seedDemoIfEmpty() {
  if (mode !== 'demo') return false;
  if (Object.keys(demoRead('orders')).length) return false;
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
  const mk = (n, over) => ({
    orderNo: 'CP-' + n, customerId: custId, customerName: 'Bellville Furniture',
    externalRef: String(3200 + (n - 1000)), source: 'feed',
    product: '3 Seater Chesterfield', qty: 1, fabric: 'Moldova : Oatmeal',
    notes: '', paidDate: '', dueDate: '', priceEach: 8500,
    status: 'new', fabricStatus: 'none', events: [],
    createdAt: nowIso(), createdBy: 'demo', updatedAt: nowIso(), updatedBy: 'demo', ...over
  });
  demoWrite('orders', {
    'd1': mk(1001, { status: 'in-production', fabricStatus: 'received', product: '3 Seater Chesterfield', paidDate: day(-24), dueDate: day(4) }),
    'd2': mk(1002, { status: 'new', product: '2 Seater Amber', fabric: 'Adore : Flint Grey', priceEach: 6400, paidDate: day(-6), dueDate: day(22) }),
    'd3': mk(1003, { status: 'ready', product: 'Corner Unit 2.8 x 2.8', fabric: 'Magical : Eclipse', priceEach: 15900, fabricStatus: 'received', paidDate: day(-30), dueDate: day(-2) }),
    'd4': { ...mk(1004, { status: 'new', product: 'Daybed 2.4m', priceEach: 11200, paidDate: day(-10), dueDate: day(18), fabricStatus: 'ordered' }), customerId: 'd-walkin', customerName: 'Private client — J. Marais', source: 'manual', externalRef: '' }
  });
  demoWrite('counters', { orderNo: { value: 1005 } });
  return true;
}
