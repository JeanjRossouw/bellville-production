// Verify the Firebase ID token the browser sends, so only signed-in app users
// can post sales to Xero. Done with `jose` against Google's public certs — no
// firebase-admin / service-account key required.
//
// Env: FIREBASE_PROJECT_ID (default bellville-production-ffb19).
//      POS_AUTH_DISABLED=true bypasses verification — ONLY for first-run testing.
import { importX509, jwtVerify, decodeProtectedHeader } from 'jose';

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const PROJECT_ID = () => process.env.FIREBASE_PROJECT_ID || 'bellville-production-ffb19';

let cache = { at: 0, certs: null };
async function googleCerts() {
  if (cache.certs && Date.now() - cache.at < 3600000) return cache.certs;
  const res = await fetch(CERT_URL);
  if (!res.ok) throw new Error('Could not fetch Google signing certs');
  const certs = await res.json();
  cache = { at: Date.now(), certs };
  return certs;
}

// Returns the decoded token payload ({ sub, email, ... }) or throws.
export async function verifyFirebaseToken(token) {
  if (!token) throw new Error('Missing bearer token');
  const projectId = PROJECT_ID();
  const { kid } = decodeProtectedHeader(token);
  const certs = await googleCerts();
  const pem = certs[kid];
  if (!pem) throw new Error('Unknown token key id');
  const key = await importX509(pem, 'RS256');
  const { payload } = await jwtVerify(token, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId
  });
  return payload;
}

// Pull the bearer token from the event and verify it. Honours POS_AUTH_DISABLED.
export async function requireUser(event) {
  if (String(process.env.POS_AUTH_DISABLED).toLowerCase() === 'true') {
    return { sub: 'auth-disabled', email: 'auth-disabled' };
  }
  const header = event.headers.authorization || event.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return await verifyFirebaseToken(token);
}
