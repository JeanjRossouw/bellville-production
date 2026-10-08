// Firestore REST access to the factory app's own Firebase project, by full
// document path (companies/<id>, companies/<id>/members/<uid>, …). Used by the
// billing function, which has to read and update any company.
//
// Env: FACTORY_SERVICE_ACCOUNT (or COUCHPOTATO_SERVICE_ACCOUNT, the same
// project's key used by the Bellville feed) — the service-account JSON.
import { SignJWT, importPKCS8 } from 'jose';

const FS_BASE = 'https://firestore.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function serviceAccount() {
  const raw = process.env.FACTORY_SERVICE_ACCOUNT || process.env.COUCHPOTATO_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FACTORY_SERVICE_ACCOUNT is not set');
  return JSON.parse(raw);
}
export const projectId = () => serviceAccount().project_id;

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
