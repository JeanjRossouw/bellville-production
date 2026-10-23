// Server-side helpers for the retail POS (pos/DATA-MODEL.md).
//
// Everything a POS function needs: Firestore under pos/{group} through the
// REST API with the project's service account (so the server-only
// collections can be written), the login check against the same Firebase
// project as Factory Manager, PIN hashing, custom tokens for PIN logins,
// the Identity Toolkit admin calls that create a login, and the audit log.
//
// Env: FACTORY_SERVICE_ACCOUNT (the project's service-account JSON, already
//      used by the billing and driver functions).
//      POS_GROUP_ID (optional) — the default group under pos/; default 'retail'.
//      Each Factory Manager POS customer has its own group (pos/{groupId}); a
//      request works in one, worked out once by withGroup() below.
//      FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST — tests only.
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SignJWT, importPKCS8 } from 'jose';
import { verifyFirebaseToken } from './auth.mjs';

// ---- the customer's own space: pos/{groupId}
// Every read and write in a request goes to the group that request works in.
// The shops that were here before sign-ups (Bellville, ReptiCube, PinkFoot)
// are the default group; a login or till with no record of its own is there.
export const DEFAULT_GROUP = process.env.POS_GROUP_ID || 'retail';
export const GROUP_ID = DEFAULT_GROUP;      // the default group's id (kept for older callers)
const groupStore = new AsyncLocalStorage();
export const groupId = () => (groupStore.getStore() || {}).gid || DEFAULT_GROUP;
export const inGroup = (gid, fn) => groupStore.run({ gid: gid || DEFAULT_GROUP }, fn);
export const GROUP_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const PROJECT_ID = 'factory-manager-ece82';
// the project's public web key (the one in couchpotato/js/config.js); it only identifies the project
const WEB_API_KEY = 'AIzaSyDchC2SgGdNn9VieudKSVOfZrHdi_GqPcg';
const EMU_FS = process.env.FIRESTORE_EMULATOR_HOST || '';
const EMU_AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
const FS_BASE = EMU_FS ? `http://${EMU_FS}/v1` : 'https://firestore.googleapis.com/v1';
const IDT_BASE = EMU_AUTH ? `http://${EMU_AUTH}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CUSTOM_TOKEN_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export const RANK = { cashier: 1, supervisor: 2, manager: 3, owner: 4 };
export const rank = (r) => RANK[r] || 0;
export const ROLES = Object.keys(RANK);
export const nowIso = () => new Date().toISOString();
export const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
// an answer to the person at the till: a status and a sentence they can act on
export class Reject extends Error { constructor(status, message) { super(message); this.status = status; } }
export const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
export const randomId = (prefix = '') => prefix + randomBytes(9).toString('base64url');

// ------------------------------------------------------------ service account
function serviceAccount() {
  const raw = process.env.FACTORY_SERVICE_ACCOUNT || process.env.COUCHPOTATO_SERVICE_ACCOUNT;
  if (!raw) {
    if (EMU_FS) return { project_id: PROJECT_ID, client_email: 'emulator@local', private_key: '' };
    throw new Error('FACTORY_SERVICE_ACCOUNT is not set');
  }
  return JSON.parse(raw);
}
const tokens = {};     // scope -> { at, token }
async function accessToken(scope) {
  if (EMU_FS) return 'owner';
  const c = tokens[scope];
  if (c && Date.now() - c.at < 3000000) return c.token;
  const sa = serviceAccount();
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience(TOKEN_URL)
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!res.ok) throw new Error('Google token exchange failed: ' + (await res.text()));
  const j = await res.json();
  tokens[scope] = { at: Date.now(), token: j.access_token };
  return j.access_token;
}
const fsToken = () => accessToken('https://www.googleapis.com/auth/datastore');
const idtToken = () => accessToken('https://www.googleapis.com/auth/identitytoolkit');

// ------------------------------------------------------------------ Firestore
const projectId = () => serviceAccount().project_id || PROJECT_ID;
const root = () => `${FS_BASE}/projects/${projectId()}/databases/(default)/documents`;
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');
export const docPath = (coll, id) => `pos/${groupId()}/${coll}/${id}`;
const docName = (coll, id) => `projects/${projectId()}/databases/(default)/documents/${docPath(coll, id)}`;

export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
  return { stringValue: String(v) };
}
export function fromFs(f) {
  if (!f || typeof f !== 'object') return null;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return parseInt(f.integerValue, 10);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('nullValue' in f) return null;
  if ('timestampValue' in f) return f.timestampValue;
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(fromFs);
  if ('mapValue' in f) return Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}
const docOf = (d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) });

async function call(method, url, body) {
  const t = await fsToken();
  return fetch(url, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

export async function getDoc(coll, id, tx) {
  if (tx) {
    // inside a transaction the read goes through batchGet, the way the SDKs do it
    const res = await call('POST', `${root().replace(/\/documents$/, '')}/documents:batchGet`, { documents: [docName(coll, id)], transaction: tx });
    if (!res.ok) throw new Error(`Firestore get ${coll}/${id} in transaction failed: ${await res.text()}`);
    const rows = await res.json();
    const hit = rows.find(r => r.found);
    return hit ? docOf(hit.found) : null;
  }
  const res = await call('GET', `${root()}/${enc(docPath(coll, id))}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${coll}/${id} failed: ${await res.text()}`);
  return docOf(await res.json());
}
// set only the named fields; the document is created if missing
export async function patchDoc(coll, id, patch) {
  const mask = Object.keys(patch).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await call('PATCH', `${root()}/${enc(docPath(coll, id))}?${mask}`, { fields: toFs(patch).mapValue.fields });
  if (!res.ok) throw new Error(`Firestore patch ${coll}/${id} failed: ${await res.text()}`);
}
// the group's own document, pos/{group}
export async function patchGroupDoc(patch) {
  const mask = Object.keys(patch).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await call('PATCH', `${root()}/${enc('pos/' + groupId())}?${mask}`, { fields: toFs(patch).mapValue.fields });
  if (!res.ok) throw new Error(`Firestore patch group failed: ${await res.text()}`);
}
// create only when not there yet: false when it already was
export async function createDoc(coll, id, data) {
  const res = await call('PATCH', `${root()}/${enc(docPath(coll, id))}?currentDocument.exists=false`, { fields: toFs(data).mapValue.fields });
  if (res.ok) return true;
  const t = await res.text();
  if (res.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(t)) return false;
  throw new Error(`Firestore create ${coll}/${id} failed: ${t}`);
}
export async function deleteDoc(coll, id) { await commit([{ delete: true, coll, id }]); }
export async function addDoc(coll, data) {
  const id = randomId();
  if (!await createDoc(coll, id, data)) throw new Error('id clash on ' + coll);
  return id;
}
// filters: [{ field, op: 'EQUAL'|'ARRAY_CONTAINS'|'IN'|'GREATER_THAN'|..., value }]
export async function query(coll, filters, limit = 500, orderBy) {
  const parts = (filters || []).map(f => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op || 'EQUAL', value: toFs(f.value) } }));
  const where = parts.length === 1 ? parts[0] : parts.length ? { compositeFilter: { op: 'AND', filters: parts } } : undefined;
  const sq = { from: [{ collectionId: coll }], ...(where ? { where } : {}), limit };
  if (orderBy) sq.orderBy = [{ field: { fieldPath: orderBy.field }, direction: orderBy.desc ? 'DESCENDING' : 'ASCENDING' }];
  const res = await call('POST', `${root()}/${enc('pos/' + groupId())}:runQuery`, { structuredQuery: sq });
  if (!res.ok) throw new Error(`Firestore query ${coll} failed: ${await res.text()}`);
  return (await res.json()).filter(r => r.document).map(r => docOf(r.document));
}

// Several writes that all happen or none. Each: { create|set|update|delete, coll, id, data }.
//   create: refused if the document exists;  update: refused if it does not;  set: either way.
// With a transaction id from beginTransaction(), reads made in it are checked too.
export async function commit(writes, tx) {
  const body = {
    writes: writes.map(w => {
      if (w.delete) return { delete: docName(w.coll, w.id) };
      const out = { update: { name: docName(w.coll, w.id), fields: toFs(w.data).mapValue.fields } };
      if (w.create) out.currentDocument = { exists: false };
      if (w.update) { out.currentDocument = { exists: true }; out.updateMask = { fieldPaths: Object.keys(w.data) }; }
      return out;
    })
  };
  if (tx) body.transaction = tx;
  const res = await call('POST', `${root().replace(/\/documents$/, '')}/documents:commit`, body);
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 409 || /ALREADY_EXISTS|ABORTED|FAILED_PRECONDITION/.test(t)) throw new Reject(409, 'That was written by someone else a moment ago. Try again.');
    throw new Error(`Firestore commit failed: ${t}`);
  }
  return (await res.json()).writeResults || [];
}
// let a transaction go without writing, so its locks are freed at once
export async function rollback(tx) {
  if (!tx) return;
  try { await call('POST', `${root().replace(/\/documents$/, '')}/documents:rollback`, { transaction: tx }); } catch (e) { /* it expires on its own */ }
}
export async function beginTransaction() {
  const res = await call('POST', `${root().replace(/\/documents$/, '')}/documents:beginTransaction`, { options: { readWrite: {} } });
  if (!res.ok) throw new Error(`Firestore beginTransaction failed: ${await res.text()}`);
  return (await res.json()).transaction;
}

// the five stamps on a record the server writes, plus the trusted clock
export const serverStamp = (entityId, storeId, createdBy, deviceId = 'server') => ({
  entityId: entityId || '', storeId: storeId || '', createdBy: createdBy || 'server', createdAt: nowIso(), deviceId: deviceId || 'server', serverReceivedAt: nowIso()
});

// ---------------------------------------------------------------- who is this
export function bearer(event) {
  const h = event.headers.authorization || event.headers.Authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
// the signed-in login behind the request, or null when there is none
export async function loginOf(event) {
  const t = bearer(event);
  if (!t) return null;
  try { return await verifyFirebaseToken(t, PROJECT_ID); } catch (e) { throw new Reject(401, 'Your sign-in has expired. Sign in again.'); }
}
export async function loadUser(uid) {
  const u = uid ? await getDoc('users', uid) : null;
  return u && u.active ? u : null;
}
// a signed-in, active member of the group
export async function requireMember(event) {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const user = await loadUser(login.sub);
  if (!user) throw new Reject(403, 'This login is not on the staff list.');
  return { uid: login.sub, email: login.email || '', user };
}
export const inEntity = (u, e) => u.role === 'owner' || (u.entityIds || []).includes(e);
export const inStore = (u, s) => u.role === 'owner' || (u.storeIds || []).includes(s);
export const atLeast = (u, r) => rank(u.role) >= rank(r);
// may `u` manage a person with this role, these entities, these stores?
export function mayManage(u, role, entityIds, storeIds) {
  if (u.role === 'owner') return ROLES.includes(role);
  if (u.role !== 'manager') return false;
  return ['cashier', 'supervisor'].includes(role) && entityIds.every(e => inEntity(u, e)) && storeIds.every(s => inStore(u, s));
}

// ---------------------------------------------------------------------- PINs
export const PIN_ITERATIONS = 100000;
export const pinValid = (pin, length) => /^\d{4,6}$/.test(pin) && (!length || pin.length === length);
export const newSalt = () => randomBytes(16).toString('hex');
export const hashPin = (pin, saltHex, iterations = PIN_ITERATIONS) => pbkdf2Sync(String(pin), Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256').toString('hex');
export function pinMatches(pin, rec) {
  if (!rec || !rec.hash || !rec.salt) return false;
  const a = Buffer.from(hashPin(pin, rec.salt, rec.iterations || PIN_ITERATIONS), 'hex'), b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// A Firebase custom token: the browser trades it for a session as this uid.
export async function customToken(uid, claims = {}) {
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid, claims };
  if (EMU_AUTH) {    // the Auth emulator checks no signature
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, iss: sa.client_email, sub: sa.client_email, aud: CUSTOM_TOKEN_AUD, iat: now, exp: now + 3600 })}.`;
  }
  const key = await importPKCS8(sa.private_key, 'RS256');
  return await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience(CUSTOM_TOKEN_AUD)
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
}

// A short-lived proof that a manager approved something, carried by the till
// into the write that needs it (a discount beyond the limit, a price change).
function overrideSecret() {
  if (process.env.POS_OVERRIDE_SECRET) return process.env.POS_OVERRIDE_SECRET;
  return sha256('override:' + (serviceAccount().private_key || 'emulator'));
}
export function overrideToken(claims, minutes = 5) {
  const body = { g: groupId(), ...claims, exp: Date.now() + minutes * 60000, nonce: randomBytes(8).toString('hex') };
  const b = Buffer.from(JSON.stringify(body)).toString('base64url');
  return b + '.' + createHmac('sha256', overrideSecret()).update(b).digest('base64url');
}
export function verifyOverrideToken(t, { anyGroup = false } = {}) {
  const [b, sig] = String(t || '').split('.');
  if (!b || !sig) return null;
  const want = createHmac('sha256', overrideSecret()).update(b).digest('base64url');
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const body = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  if (!(body.exp > Date.now())) return null;
  // a token made in one customer's space is no good in another's (older tokens are the default group's)
  if (!anyGroup && (body.g || DEFAULT_GROUP) !== groupId()) return null;
  return body;
}

// ----------------------------------------------------------- Identity Toolkit
// A login for a person with an email: created by the server, with a password
// they never see; they set their own through the reset email.
export async function createAuthUser({ email, displayName }) {
  const t = await idtToken();
  const res = await fetch(`${IDT_BASE}/projects/${projectId()}/accounts`, {
    method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName, password: randomBytes(24).toString('base64url'), emailVerified: false })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (j.error && j.error.message) || '';
    if (/EMAIL_EXISTS|DUPLICATE_EMAIL/.test(msg)) return { uid: await uidByEmail(email), existed: true };
    throw new Error('Could not create the login: ' + (msg || res.status));
  }
  return { uid: j.localId, existed: false };
}
export async function uidByEmail(email) {
  const t = await idtToken();
  const res = await fetch(`${IDT_BASE}/projects/${projectId()}/accounts:lookup`, {
    method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: [email] })
  });
  const j = await res.json().catch(() => ({}));
  return (j.users && j.users[0] && j.users[0].localId) || '';
}
export async function sendPasswordReset(email, continueUrl) {
  const res = await fetch(`${IDT_BASE}/accounts:sendOobCode?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email, ...(continueUrl ? { continueUrl } : {}) })
  });
  if (!res.ok) throw new Error('Could not send the set-your-password email: ' + (await res.text()).slice(0, 200));
}

// -------------------------------------------------------------------- audit
export async function audit(a) {
  const row = {
    action: a.action, docType: a.docType || '', docId: a.docId || '', docNo: a.docNo || '',
    actorUid: a.actorUid || '', actorName: a.actorName || '', overrideUid: a.overrideUid || '', overrideName: a.overrideName || '',
    details: a.details || {},
    ...serverStamp(a.entityId, a.storeId, a.actorUid || 'server', a.deviceId || 'server')
  };
  return addDoc('auditLog', row);
}

// ------------------------------------------------------------------ devices
export async function loadDevice(deviceId, secret) {
  if (!deviceId || !secret) return null;
  const d = await getDoc('devices', deviceId);
  if (!d || !d.active || d.secretHash !== sha256(secret)) return null;
  return d;
}

// the request body, whichever way Netlify hands it over
export function bodyOf(event) {
  try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); }
  catch { throw new Reject(400, 'Invalid request'); }
}

// ---- documents outside any group: which space a login belongs to, and the spaces themselves
//   posMembers/{uid}  { groupId }                       written when a person is added
//   posGroups/{gid}   { name, ownerUid, status, trialEndsAt, paidUntil, ... }   one per customer
export async function getTop(path) {
  const res = await call('GET', `${root()}/${enc(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${path} failed: ${await res.text()}`);
  return docOf(await res.json());
}
export async function patchTop(path, patch) {
  const mask = Object.keys(patch).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await call('PATCH', `${root()}/${enc(path)}?${mask}`, { fields: toFs(patch).mapValue.fields });
  if (!res.ok) throw new Error(`Firestore patch ${path} failed: ${await res.text()}`);
}
export async function createTop(path, data) {
  const res = await call('PATCH', `${root()}/${enc(path)}?currentDocument.exists=false`, { fields: toFs(data).mapValue.fields });
  if (res.ok) return true;
  const t = await res.text();
  if (res.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(t)) return false;
  throw new Error(`Firestore create ${path} failed: ${t}`);
}
export async function listTop(coll, limit = 500) {
  const res = await call('POST', `${root()}:runQuery`, { structuredQuery: { from: [{ collectionId: coll }], limit } });
  if (!res.ok) throw new Error(`Firestore list ${coll} failed: ${await res.text()}`);
  return (await res.json()).filter(r => r.document && r.document.name.split('/').length === 7).map(r => docOf(r.document));
}
// a person joins a group: one record, so every later request finds their space
export const setMember = (uid, gid) => patchTop('posMembers/' + uid, { groupId: gid || groupId(), at: nowIso() });

// which business a login already belongs to, if any: its own record, or (for the first shops, who have none) the default group's staff list
export async function memberGroupOf(uid) {
  const m = uid ? await getTop('posMembers/' + uid) : null;
  if (m && GROUP_RE.test(m.groupId || '')) return m.groupId;
  return uid && await getTop(`pos/${DEFAULT_GROUP}/users/${uid}`) ? DEFAULT_GROUP : null;
}
// which group a login is in (kept a few minutes per function instance)
const memberCache = new Map();
export async function groupOfLogin(uid) {
  const hit = memberCache.get(uid);
  if (hit && hit.at > Date.now() - 300000) return hit.gid;
  const m = uid ? await getTop('posMembers/' + uid) : null;
  const gid = m && GROUP_RE.test(m.groupId || '') ? m.groupId : DEFAULT_GROUP;
  memberCache.set(uid, { gid, at: Date.now() });
  return gid;
}
// The group a request works in: a signed link or Xero's return names it in its
// signature; a signed-in person's own record says it (a login cannot reach
// another customer's space); an enrolled till says it in its body and then
// proves itself with its secret inside that group; Shopify's webhook names
// it in the address and proves it with that group's own shop secret.
export async function groupFor(event) {
  const q = event.queryStringParameters || {};
  const signed = q.t || q.state;
  if (signed) { let c = null; try { c = verifyOverrideToken(signed, { anyGroup: true }); } catch (e) {} if (c && GROUP_RE.test(c.g || '')) return c.g; }
  if (bearer(event)) { const login = await loginOf(event); return groupOfLogin(login.sub); }
  if (q.hook && GROUP_RE.test(q.g || '')) return q.g;
  let b = {}; try { b = event.body ? bodyOf(event) : {}; } catch (e) {}
  if (b && b.deviceId && GROUP_RE.test(b.groupId || '')) return b.groupId;
  return DEFAULT_GROUP;
}
// wrap a function's handler so everything in it works in the request's group
export const withGroup = (handler) => async (event, context) => {
  let gid;
  try { gid = await groupFor(event); }
  catch (e) { if (e instanceof Reject) return json(e.status, { error: e.message }); throw e; }
  return inGroup(gid, () => handler(event, context));
};
// every group, for the schedules: the default one and every customer's
export async function allGroups() {
  let rows = [];
  try { rows = await listTop('posGroups', 1000); } catch (e) { console.error('posGroups', e.message); }
  return [DEFAULT_GROUP, ...rows.map(r => r.id).filter(id => GROUP_RE.test(id) && id !== DEFAULT_GROUP)];
}
