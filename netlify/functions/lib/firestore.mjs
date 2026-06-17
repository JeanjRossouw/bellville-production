// Minimal Firestore REST access for the Shopify webhook, which must write the
// master stock back into the shared app document. Uses a Google service account
// (signed JWT → access token) — no firebase-admin dependency.
//
// Env: FIREBASE_SERVICE_ACCOUNT = the service-account JSON (as a single string).
//
// The whole app state lives in one doc, shared-data/production, as a JSON string
// in the `data` field (matching how index.html stores it).
import { SignJWT, importPKCS8 } from 'jose';

const FS_BASE = 'https://firestore.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
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
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!res.ok) throw new Error('Google token exchange failed: ' + (await res.text()));
  const j = await res.json();
  tokenCache = { at: Date.now(), token: j.access_token };
  return j.access_token;
}

function docUrl(docId) {
  const pid = serviceAccount().project_id;
  return `${FS_BASE}/projects/${pid}/databases/(default)/documents/shared-data/${docId}`;
}

// Read the JSON held in a doc's `data` string field. Returns {} if absent.
export async function readDoc(docId) {
  const t = await accessToken();
  const res = await fetch(docUrl(docId), { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error('Firestore read failed: ' + (await res.text()));
  const doc = await res.json();
  const str = (doc.fields && doc.fields.data && doc.fields.data.stringValue) || '{}';
  return JSON.parse(str);
}

export async function writeDoc(docId, obj, updatedBy) {
  const t = await accessToken();
  const body = {
    fields: {
      data: { stringValue: JSON.stringify(obj) },
      updatedAt: { stringValue: new Date().toISOString() },
      updatedBy: { stringValue: updatedBy || 'shopify-webhook' }
    }
  };
  const url = docUrl(docId) + '?updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=updatedBy';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Firestore write failed: ' + (await res.text()));
}
