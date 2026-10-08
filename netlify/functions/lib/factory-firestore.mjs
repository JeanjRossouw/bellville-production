// Firestore REST access to the factory app's own Firebase project, by full
// document path (companies/<id>, companies/<id>/members/<uid>, …). Used by the
// billing function, which has to read and update any company.
//
// Env: FACTORY_SERVICE_ACCOUNT (or COUCHPOTATO_SERVICE_ACCOUNT, the same
// project's key used by the Bellville feed) — the service-account JSON.
import { SignJWT, importPKCS8 } from 'jose';

// FIRESTORE_EMULATOR_HOST (tests only) points everything at the local emulator.
const EMU = process.env.FIRESTORE_EMULATOR_HOST || '';
const FS_BASE = EMU ? `http://${EMU}/v1` : 'https://firestore.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function serviceAccount() {
  const raw = process.env.FACTORY_SERVICE_ACCOUNT || process.env.COUCHPOTATO_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FACTORY_SERVICE_ACCOUNT is not set');
  return JSON.parse(raw);
}
export const projectId = () => serviceAccount().project_id;

let tokenCache = { at: 0, token: null };
async function accessToken() {
  if (EMU) return 'owner';
  if (tokenCache.token && Date.now() - tokenCache.at < 3000000) return tokenCache.token;
  const sa = serviceAccount();
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/datastore' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience(TOKEN_URL)
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!res.ok) throw new Error('Google token exchange failed: ' + (await res.text()));
  const j = await res.json();
  tokenCache = { at: Date.now(), token: j.access_token };
  return j.access_token;
}

const root = () => `${FS_BASE}/projects/${projectId()}/databases/(default)/documents`;
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

// Dates become Firestore timestamps, so the database rules can compare them
// with request.time.
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

async function call(method, url, body) {
  const t = await accessToken();
  return fetch(url, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

export async function getDoc(path) {
  const res = await call('GET', `${root()}/${enc(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${path} failed: ${await res.text()}`);
  const d = await res.json();
  return { id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) };
}

// Set only the named fields (the document is created if missing).
export async function patchDoc(path, patch) {
  const mask = Object.keys(patch).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await call('PATCH', `${root()}/${enc(path)}?${mask}`, { fields: toFs(patch).mapValue.fields });
  if (!res.ok) throw new Error(`Firestore patch ${path} failed: ${await res.text()}`);
}

// Equality query on one collection under a parent document:
//   query('companies/abc', 'orders', { driverId: 'x', deliveryDate: '2026-10-09' })
export async function query(parentPath, collectionId, filters, limit = 300) {
  const parts = Object.entries(filters || {}).map(([field, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toFs(value) } }));
  const where = parts.length === 1 ? parts[0] : parts.length ? { compositeFilter: { op: 'AND', filters: parts } } : undefined;
  const res = await call('POST', `${root()}/${enc(parentPath)}:runQuery`, { structuredQuery: { from: [{ collectionId }], ...(where ? { where } : {}), limit } });
  if (!res.ok) throw new Error(`Firestore query ${parentPath}/${collectionId} failed: ${await res.text()}`);
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => ({ id: r.document.name.split('/').pop(), ...Object.fromEntries(Object.entries(r.document.fields || {}).map(([k, x]) => [k, fromFs(x)])) }));
}

// Create a document only if it is not there yet. false when it already was,
// so two runs bringing in the same thing can never both write it.
export async function createDoc(path, data) {
  const res = await call('PATCH', `${root()}/${enc(path)}?currentDocument.exists=false`, { fields: toFs(data).mapValue.fields });
  if (res.ok) return true;
  const t = await res.text();
  if (res.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(t)) return false;
  throw new Error(`Firestore create ${path} failed: ${t}`);
}

// A new document with an id Firestore picks; returns the id.
export async function addDoc(collPath, data) {
  const res = await call('POST', `${root()}/${enc(collPath)}`, { fields: toFs(data).mapValue.fields });
  if (!res.ok) throw new Error(`Firestore add ${collPath} failed: ${await res.text()}`);
  return (await res.json()).name.split('/').pop();
}

export async function deleteDoc(path) {
  const res = await call('DELETE', `${root()}/${enc(path)}`);
  if (!res.ok && res.status !== 404) throw new Error(`Firestore delete ${path} failed: ${await res.text()}`);
}

// Every document in a collection (up to `max`), e.g. listDocs('shopifyLinks').
export async function listDocs(collPath, max = 1000) {
  const out = [];
  let token = '';
  do {
    const res = await call('GET', `${root()}/${enc(collPath)}?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
    if (!res.ok) throw new Error(`Firestore list ${collPath} failed: ${await res.text()}`);
    const j = await res.json();
    (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) }));
    token = j.nextPageToken || '';
  } while (token && out.length < max);
  return out;
}

const docName = (path) => `projects/${projectId()}/databases/(default)/documents/${path}`;

// Many writes at once (at most 500), all or nothing. Each item:
//   { path, data }            set the named fields (creating the document if needed)
//   { path, inc: { f: n } }   add n to a number field without reading it
export async function commitWrites(items) {
  for (let i = 0; i < items.length; i += 450) {
    const writes = items.slice(i, i + 450).map(w => w.inc
      ? { transform: { document: docName(w.path), fieldTransforms: Object.entries(w.inc).map(([f, n]) => ({ fieldPath: f, increment: toFs(n) })) } }
      : { update: { name: docName(w.path), fields: toFs(w.data).mapValue.fields }, updateMask: { fieldPaths: Object.keys(w.data) } });
    const res = await call('POST', `${root()}:commit`, { writes });
    if (!res.ok) throw new Error(`Firestore commit failed: ${await res.text()}`);
  }
}

// The company's next number in a sequence (orderNo, invoiceNo …), the way
// the app hands them out. The counter is written only if nobody changed it
// since we read it; if somebody did, read again and retry. So two people (or
// a webhook and the 15-minute check) can never be given the same number.
export async function nextNumber(cid, key, first) {
  const path = `companies/${cid}/counters/${key}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const g = await call('GET', `${root()}/${enc(path)}`);
    let next = Number(first) || 1, pre = { exists: false };
    if (g.ok) {
      const d = await g.json();
      const v = fromFs((d.fields || {}).value);
      if (Number(v) > 0) next = Number(v);
      pre = { updateTime: d.updateTime };
    } else if (g.status !== 404) throw new Error('Firestore counter read failed: ' + await g.text());
    const w = await call('POST', `${root()}:commit`, { writes: [{ update: { name: docName(path), fields: { value: toFs(next + 1) } }, updateMask: { fieldPaths: ['value'] }, currentDocument: pre }] });
    if (w.ok) return next;
    const txt = await w.text();
    if (w.status !== 409 && w.status !== 400 && !/FAILED_PRECONDITION|ALREADY_EXISTS/.test(txt)) throw new Error('Firestore counter write failed: ' + txt);
    await new Promise(r => setTimeout(r, 60 * (attempt + 1) + Math.random() * 80));
  }
  throw new Error('Could not get the next ' + key + ' (too busy), try again');
}

// Is the company allowed to work (trial running, paid up, or free)? The same
// test as companyActive() in firestore.rules.
export function companyActive(c, now = Date.now()) {
  if (!c) return false;
  if (c.status === 'free') return true;
  const created = Date.parse(c.createdAt || '') || 0;
  const trialEnd = c.trialEndsAt ? Date.parse(c.trialEndsAt) : created + 14 * 86400000;
  if (c.status === 'trial' && now < trialEnd) return true;
  return !!(c.paidUntil && now < Date.parse(c.paidUntil));
}
