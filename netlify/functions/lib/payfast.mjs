// PayFast: monthly subscriptions (South Africa).
//
// Env: PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE
//      PAYFAST_SANDBOX=true to use sandbox.payfast.co.za while testing.
//
// Three pieces:
//   checkoutFields() — the signed form the browser posts to PayFast
//   verifyItn()      — checks a payment notice really came from PayFast
//   cancelSubscription() — stops future debits through PayFast's API
import { createHash } from 'node:crypto';

export const sandbox = () => String(process.env.PAYFAST_SANDBOX || '').toLowerCase() === 'true';
const host = () => (sandbox() ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za');
export const processUrl = () => host() + '/eng/process';
const validateUrl = () => host() + '/eng/query/validate';
const md5 = (s) => createHash('md5').update(s).digest('hex');

export function configured() {
  return !!(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY);
}

// PayFast encodes like PHP's urlencode: spaces as "+", hex in capitals.
export function pfEncode(v) {
  return encodeURIComponent(String(v).trim()).replace(/%20/g, '+')
    .replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Signature over the fields in the order given (PayFast's documented order),
// leaving out empty ones, with the passphrase appended.
export function signPairs(pairs, passphrase) {
  let s = pairs.filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + '=' + pfEncode(v)).join('&');
  if (passphrase) s += '&passphrase=' + pfEncode(passphrase);
  return md5(s);
}

// The fields for a monthly subscription, in PayFast's documented order.
export function checkoutFields({ amount, itemName, companyId, companyName, email, name, returnUrl, cancelUrl, notifyUrl }) {
  const [first, ...rest] = String(name || '').trim().split(/\s+/);
  const today = new Date().toISOString().slice(0, 10);
  const pairs = [
    ['merchant_id', process.env.PAYFAST_MERCHANT_ID],
    ['merchant_key', process.env.PAYFAST_MERCHANT_KEY],
    ['return_url', returnUrl],
    ['cancel_url', cancelUrl],
    ['notify_url', notifyUrl],
    ['name_first', first || ''],
    ['name_last', rest.join(' ')],
    ['email_address', email || ''],
    ['m_payment_id', companyId + '-' + Date.now()],
    ['amount', amount.toFixed(2)],
    ['item_name', itemName],
    ['item_description', companyName ? 'Subscription for ' + companyName : ''],
    ['custom_str1', companyId],
    ['subscription_type', '1'],
    ['billing_date', today],
    ['recurring_amount', amount.toFixed(2)],
    ['frequency', '3'],          // monthly
    ['cycles', '0']              // until cancelled
  ].filter(([, v]) => v !== '' && v != null);
  pairs.push(['signature', signPairs(pairs, process.env.PAYFAST_PASSPHRASE || '')]);
  return pairs;
}

// Parse a form body keeping the order PayFast sent it in (the signature
// depends on it).
export function parseBody(raw) {
  return String(raw || '').split('&').filter(Boolean).map(kv => {
    const i = kv.indexOf('=');
    const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    return [k, v];
  });
}

// A payment notice is genuine only if (1) its signature matches with our
// passphrase, (2) it is for our merchant account, and (3) PayFast's own
// server confirms it. The caller still checks the amount.
export async function verifyItn(pairs, { fetchImpl = fetch } = {}) {
  const data = Object.fromEntries(pairs);
  const withoutSig = pairs.filter(([k]) => k !== 'signature');
  const expect = signPairs(withoutSig, process.env.PAYFAST_PASSPHRASE || '');
  if (!data.signature || data.signature !== expect) return { ok: false, why: 'signature mismatch' };
  if (String(data.merchant_id) !== String(process.env.PAYFAST_MERCHANT_ID)) return { ok: false, why: 'wrong merchant' };
  const body = withoutSig.map(([k, v]) => k + '=' + pfEncode(v)).join('&');
  const res = await fetchImpl(validateUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = (await res.text()).trim();
  if (text !== 'VALID') return { ok: false, why: 'PayFast did not confirm (' + text.slice(0, 40) + ')' };
  return { ok: true, data };
}

// Stop a subscription. PayFast's API signs the sorted header values plus the
// passphrase.
export async function cancelSubscription(token, { fetchImpl = fetch } = {}) {
  const timestamp = new Date().toISOString().slice(0, 19);
  const vars = { 'merchant-id': process.env.PAYFAST_MERCHANT_ID, version: 'v1', timestamp };
  if (process.env.PAYFAST_PASSPHRASE) vars.passphrase = process.env.PAYFAST_PASSPHRASE;
  const signature = md5(Object.keys(vars).sort().map(k => k + '=' + pfEncode(vars[k])).join('&'));
  const url = 'https://api.payfast.co.za/subscriptions/' + encodeURIComponent(token) + '/cancel' + (sandbox() ? '?testing=true' : '');
  const res = await fetchImpl(url, { method: 'PUT', headers: { 'merchant-id': vars['merchant-id'], version: 'v1', timestamp, signature } });
  if (!res.ok) throw new Error('PayFast cancel failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
  return true;
}
