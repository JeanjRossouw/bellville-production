// Minimal Firestore REST client for Couch Potato's OWN Firebase project —
// per-document reads and writes, which is how that system is built (one
// document per order). Authenticates with a service account for that project
// (signed JWT → access token); no firebase-admin dependency.
//
// Env: COUCHPOTATO_SERVICE_ACCOUNT = the service-account JSON (one string).
import { SignJWT, importPKCS8 } from 'jose';

const FS_BASE = 'https://firestore.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function serviceAccount() {
  const raw = process.env.COUCHPOTATO_SERVICE_ACCOUNT;
  if (!raw) throw new Error('COUCHPOTATO_SERVICE_ACCOUNT is not set');
  return JSON.parse(raw);
}

let tokenCache = { at: 0, token: null };
async function accessToken() {
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

const root = () => `${FS_BASE}/projects/${serviceAccount().project_id}/databases/(default)/documents`;

// ---- JS <-> Firestore value encoding ----
export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
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
const docToObj = (d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) });

// ---- operations ----
async function call(method, url, body) {
  const t = await accessToken();
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res;
}

// Create a document with a fixed id, ONLY if it does not exist yet.
// Returns true when created, false when it was already there.
export async function createIfMissing(collection, id, obj) {
  const res = await call('PATCH', `${root()}/${collection}/${encodeURIComponent(id)}?currentDocument.exists=false`, { fields: toFs(obj).mapValue.fields });
  if (res.status === 409 || res.status === 412) return false;
  if (!res.ok) throw new Error(`Firestore create ${collection}/${id} failed: ${await res.text()}`);
  return true;
}

// Patch only the named fields of a document.
export async function patchFields(collection, id, patch) {
  const mask = Object.keys(patch).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await call('PATCH', `${root()}/${collection}/${encodeURIComponent(id)}?${mask}`, { fields: toFs(patch).mapValue.fields });
  if (!res.ok) throw new Error(`Firestore patch ${collection}/${id} failed: ${await res.text()}`);
}

// Query a collection with simple equality / IN filters: { field: value | [values] }.
export async function query(collection, filters) {
  const parts = Object.entries(filters || {}).map(([field, value]) => Array.isArray(value)
    ? { fieldFilter: { field: { fieldPath: field }, op: 'IN', value: { arrayValue: { values: value.map(toFs) } } } }
    : { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toFs(value) } });
  const where = parts.length === 1 ? parts[0] : parts.length ? { compositeFilter: { op: 'AND', filters: parts } } : undefined;
  const res = await call('POST', `${root()}:runQuery`, { structuredQuery: { from: [{ collectionId: collection }], ...(where ? { where } : {}), limit: 1000 } });
  if (!res.ok) throw new Error(`Firestore query ${collection} failed: ${await res.text()}`);
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => docToObj(r.document));
}

export async function getDocById(collection, id) {
  const res = await call('GET', `${root()}/${collection}/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${collection}/${id} failed: ${await res.text()}`);
  return docToObj(await res.json());
}
