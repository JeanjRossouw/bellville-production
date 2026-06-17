// Shared Xero (Accounting API) helpers for the POS integration.
//
// One Xero ORGANISATION per business (separate org each), so tokens + tenant id
// are stored per business key in a Netlify Blobs store. Refresh tokens rotate on
// every use, so we persist the new token set after each refresh.
//
// Required env vars (see XERO-SETUP.md):
//   XERO_CLIENT_ID, XERO_CLIENT_SECRET   — your Xero app's OAuth2 credentials
//   XERO_REDIRECT_URI                    — must match the app's redirect in Xero
//   XERO_REVENUE_ACCOUNT[_<BIZ>]         — sales revenue account code (default 200)
//   XERO_BANK_ACCOUNT[_<BIZ>]            — bank/clearing account code for the payment
//   XERO_TAX_TYPE[_<BIZ>]                — optional output-VAT tax type override
import { getStore } from '@netlify/blobs';

export const BIZ_KEYS = ['bellville', 'pinkfoot', 'repticube'];

const TOKEN_URL = 'https://identity.xero.com/connect/token';
export const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';
export const SCOPES = 'openid profile email accounting.transactions accounting.contacts offline_access';

function tokenStore() { return getStore('xero-tokens'); }
export async function loadTokens(biz) { return await tokenStore().get(biz, { type: 'json' }); }
export async function saveTokens(biz, t) { await tokenStore().setJSON(biz, t); }

export function clientCreds() {
  const id = process.env.XERO_CLIENT_ID;
  const secret = process.env.XERO_CLIENT_SECRET;
  if (!id || !secret) throw new Error('XERO_CLIENT_ID / XERO_CLIENT_SECRET are not set');
  return { id, secret };
}

function basicAuthHeader() {
  const { id, secret } = clientCreds();
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

// Per-business config with a global fallback. e.g. XERO_REVENUE_ACCOUNT_BELLVILLE.
export function bizConfig(biz) {
  const up = String(biz || '').toUpperCase();
  const pick = (name, dflt) => process.env[`${name}_${up}`] || process.env[name] || dflt;
  return {
    revenueAccount: pick('XERO_REVENUE_ACCOUNT', '200'),
    bankAccount: pick('XERO_BANK_ACCOUNT', ''),
    taxType: pick('XERO_TAX_TYPE', '') // empty => let the revenue account's default rate apply
  };
}

// Exchange an authorization code for the first token set, then resolve & store
// the tenant id for this business.
export async function exchangeCode(code) {
  const redirectUri = process.env.XERO_REDIRECT_URI;
  if (!redirectUri) throw new Error('XERO_REDIRECT_URI is not set');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + (await res.text()));
  return res.json();
}

async function refreshTokens(biz, tokens) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + (await res.text()));
  const fresh = await res.json();
  const merged = { ...tokens, ...fresh, obtained_at: Date.now() };
  await saveTokens(biz, merged); // refresh token rotated — persist immediately
  return merged;
}

export async function getConnections(accessToken) {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('Could not read Xero connections: ' + (await res.text()));
  return res.json();
}

async function validTokens(biz) {
  let t = await loadTokens(biz);
  if (!t || !t.refresh_token) throw new Error(`Xero is not connected for "${biz}" — run the connect flow`);
  const lifeMs = (Number(t.expires_in) || 1800) * 1000;
  if (Date.now() - (t.obtained_at || 0) > lifeMs - 120000) t = await refreshTokens(biz, t);
  return t;
}

// Authenticated call against the Accounting API for a given business's org.
export async function xeroApi(biz, path, { method = 'GET', body } = {}) {
  const t = await validTokens(biz);
  if (!t.tenant_id) throw new Error(`No tenant id stored for "${biz}" — reconnect Xero`);
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      'Xero-tenant-id': t.tenant_id,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (json && (json.Message || json.detail)) || text || res.statusText;
    const err = new Error(`Xero ${method} ${path} failed (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Look up (and cache on the token blob) the generic "POS Customer" contact id.
export async function getPosContactId(biz) {
  const t = await loadTokens(biz);
  if (t && t.pos_contact_id) return t.pos_contact_id;
  const name = 'POS Customer';
  const found = await xeroApi(biz, `/Contacts?where=${encodeURIComponent(`Name=="${name}"`)}`);
  let id = found && found.Contacts && found.Contacts[0] && found.Contacts[0].ContactID;
  if (!id) {
    const created = await xeroApi(biz, '/Contacts', { method: 'POST', body: { Contacts: [{ Name: name }] } });
    id = created.Contacts[0].ContactID;
  }
  await saveTokens(biz, { ...(t || {}), pos_contact_id: id });
  return id;
}
