// Retail POS — the database connection.
//
// Firebase Auth and Firestore from the CDN, with Firestore's offline cache on
// (reads keep working with the line down; the finished documents go through
// the server, see outbox in step 9). Every helper here addresses
// pos/{GROUP_ID}/<collection>; nothing else in the project is reachable.
//
// ?emulator=1 on localhost talks to the local emulators (tests).
import { FIREBASE_CONFIG, FB_VERSION, GROUP_ID } from './config.js';

const FB = (m) => `https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-${m}.js`;
export const EMULATOR = new URLSearchParams(location.search).get('emulator') === '1' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
export const fb = { app: null, auth: null, db: null, fns: {} };

export async function initFirebase() {
  const [appMod, authMod, fsMod] = await Promise.all([import(FB('app')), import(FB('auth')), import(FB('firestore'))]);
  fb.app = appMod.initializeApp(FIREBASE_CONFIG);
  fb.auth = authMod.getAuth(fb.app);
  // one tab per till: the single-tab cache (the multi-tab one trips the SDK's internal checks)
  fb.db = fsMod.initializeFirestore(fb.app, { localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentSingleTabManager({ forceOwnership: true }) }) });
  if (EMULATOR) {
    authMod.connectAuthEmulator(fb.auth, 'http://localhost:9099', { disableWarnings: true });
    fsMod.connectFirestoreEmulator(fb.db, 'localhost', 8085);
  }
  fb.fns = { ...authMod, ...fsMod };
}

export const col = (name) => fb.fns.collection(fb.db, 'pos', GROUP_ID, name);
export const ref = (name, id) => fb.fns.doc(fb.db, 'pos', GROUP_ID, name, id);
export const groupRef = () => fb.fns.doc(fb.db, 'pos', GROUP_ID);
const rowOf = (d) => ({ id: d.id, ...d.data() });

// Live rows of a collection, filtered: wheres = [['entityId', '==', 'BF'], ['storeId', 'in', [...]]].
// Every query from the browser must filter by entityId (and storeId where
// the record has one): that is how the rules prove each row is allowed.
export function watch(name, wheres, cb, onError) {
  const q = fb.fns.query(col(name), ...(wheres || []).map(w => fb.fns.where(w[0], w[1], w[2])));
  return fb.fns.onSnapshot(q, { includeMetadataChanges: false }, (snap) => cb(snap.docs.map(rowOf)), (err) => { console.error('watch ' + name + ' failed:', err); if (onError) onError(err); });
}
export async function getOne(name, id) {
  const s = await fb.fns.getDoc(ref(name, id));
  return s.exists() ? rowOf(s) : null;
}
export async function list(name, wheres, max = 500) {
  const q = fb.fns.query(col(name), ...(wheres || []).map(w => fb.fns.where(w[0], w[1], w[2])), fb.fns.limit(max));
  return (await fb.fns.getDocs(q)).docs.map(rowOf);
}
// a record with an id we choose (the only kind: ids are never left to chance)
export async function setOne(name, id, data) { await fb.fns.setDoc(ref(name, id), data); }
export async function patchOne(name, id, patch) { await fb.fns.updateDoc(ref(name, id), patch); }
export const newId = (name) => fb.fns.doc(col(name)).id;
// several records in chunks of 400 (Firestore's limit per batch): [{ op: 'set'|'update'|'delete', coll, id, data }]
export async function batch(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = fb.fns.writeBatch(fb.db);
    for (const o of ops.slice(i, i + 400)) {
      if (o.op === 'set') b.set(ref(o.coll, o.id), o.data);
      else if (o.op === 'update') b.update(ref(o.coll, o.id), o.data);
      else if (o.op === 'delete') b.delete(ref(o.coll, o.id));
    }
    await b.commit();
  }
}
export const nowIso = () => new Date().toISOString();
export const serverTime = () => fb.fns.serverTimestamp();
