// Subscriptions for the factory app.
//
//   GET  ?plan=1                     → the plan and price (public)
//   POST { action:'checkout' }       → the signed PayFast form (company owner only)
//   POST { action:'cancel' }         → stop the subscription (company owner only)
//   POST <PayFast ITN form body>     → PayFast's payment notice; updates the company
//
// Staff calls carry a Firebase ID token from the factory app's project. The
// company's billing fields (status, paidUntil, plan) are written only here,
// with the service account; the database rules stop the app writing them.
import { verifyFirebaseToken } from './lib/auth.mjs';
import { getDoc, patchDoc, projectId } from './lib/factory-firestore.mjs';
import { plan, GRACE_DAYS } from './lib/factory-plans.mjs';
import * as payfast from './lib/payfast.mjs';

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

function siteUrl(event) {
  const h = event.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (host && /(^|\.)netlify\.app$|^localhost(:\d+)?$/i.test(host)) return (/^localhost/.test(host) ? 'http://' : 'https://') + host;
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
}

// The signed-in person and their company; only the owner may change billing.
async function ownerOf(event) {
  const h = event.headers || {};
  const header = h.authorization || h.Authorization || '';
  const user = await verifyFirebaseToken(header.startsWith('Bearer ') ? header.slice(7) : '', projectId());
  const me = await getDoc('users/' + user.sub);
  if (!me || !me.companyId) throw new Error('No company for this login');
  const member = await getDoc(`companies/${me.companyId}/members/${user.sub}`);
  if (!member || member.role !== 'owner') throw new Error('Only the owner can manage the subscription');
  const company = await getDoc('companies/' + me.companyId);
  if (!company) throw new Error('Company not found');
  return { user, member, company, companyId: me.companyId };
}

const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
function nextMonth(from) { const d = new Date(from); d.setMonth(d.getMonth() + 1); return d; }

// What a payment notice does to the company. Exported for the tests.
export function applyNotice(company, data, price, now = new Date()) {
  const status = String(data.payment_status || '').toUpperCase();
  if (status === 'CANCELLED') return { status: 'cancelled', cancelledAt: now };
  if (status !== 'COMPLETE') return null;
  const gross = Number(data.amount_gross);
  if (!(Math.abs(gross - price.amount) < 0.005)) throw new Error('amount ' + data.amount_gross + ' does not match the plan (' + price.amount + ')');
  // a month from today, or from the end of the month already paid for, whichever is later
  const paidTo = company && company.paidUntil ? addDays(new Date(company.paidUntil), -GRACE_DAYS) : null;
  const start = paidTo && paidTo > now ? paidTo : now;
  return {
    status: 'active', plan: price.id,
    paidUntil: addDays(nextMonth(start), GRACE_DAYS),
    lastPaymentAt: now, lastPaymentAmount: gross,
    ...(data.token ? { payfastToken: data.token } : {})
  };
}

export const handler = async (event) => {
  try {
    const price = plan();
    if (event.httpMethod === 'GET') return json(200, { plan: price, configured: payfast.configured(), sandbox: payfast.sandbox() });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const ctype = String((event.headers || {})['content-type'] || (event.headers || {})['Content-Type'] || '');

    // ---- PayFast's payment notice (form-encoded) ----
    if (/x-www-form-urlencoded/i.test(ctype)) {
      const pairs = payfast.parseBody(raw);
      const v = await payfast.verifyItn(pairs);
      if (!v.ok) { console.warn('factory-billing: rejected notice:', v.why); return { statusCode: 400, body: 'rejected' }; }
      const cid = v.data.custom_str1;
      if (!cid || !/^[A-Za-z0-9_-]{1,64}$/.test(cid)) return { statusCode: 400, body: 'no company' };
      const company = await getDoc('companies/' + cid);
      if (!company) return { statusCode: 404, body: 'unknown company' };
      // PayFast resends a notice until it gets a 200, so one payment must
      // only ever count once.
      const pid = String(v.data.pf_payment_id || v.data.m_payment_id || '').replace(/[^A-Za-z0-9_-]/g, '_');
      if (pid && String(v.data.payment_status).toUpperCase() === 'COMPLETE' && await getDoc(`companies/${cid}/payments/${pid}`)) return { statusCode: 200, body: 'already counted' };
      const patch = applyNotice(company, v.data, price);
      if (patch) {
        await patchDoc('companies/' + cid, patch);
        if (pid) await patchDoc(`companies/${cid}/payments/${pid}`, {
          at: new Date(), status: String(v.data.payment_status || ''), amount: Number(v.data.amount_gross) || 0,
          fee: Number(v.data.amount_fee) || 0, reference: String(v.data.pf_payment_id || ''), item: String(v.data.item_name || '')
        });
      }
      return { statusCode: 200, body: 'ok' };
    }

    // ---- the app (JSON, signed-in owner) ----
    let body; try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    let who;
    try { who = await ownerOf(event); } catch (e) { return json(403, { error: e.message }); }

    if (body.action === 'checkout') {
      if (!payfast.configured()) return json(503, { error: 'Payments are not switched on yet. Ask the seller to set up PayFast.' });
      const base = siteUrl(event);
      // where the app lives on this site: /couchpotato/ today, / once it has its own site
      const app = base + ('/' + String(process.env.FACTORY_APP_PATH || 'couchpotato/').replace(/^\/+/, '')).replace(/\/?$/, '/');
      const fields = payfast.checkoutFields({
        amount: price.amount, itemName: 'Factory Manager — ' + price.name + ' (monthly)',
        companyId: who.companyId, companyName: who.company.name, email: who.user.email, name: who.member.name,
        returnUrl: app + '?billing=done', cancelUrl: app + '?billing=cancelled', notifyUrl: base + '/.netlify/functions/factory-billing'
      });
      return json(200, { action: payfast.processUrl(), fields });
    }

    if (body.action === 'cancel') {
      if (!who.company.payfastToken) return json(400, { error: 'There is no active subscription to cancel.' });
      await payfast.cancelSubscription(who.company.payfastToken);
      // access continues to the end of the month already paid for
      await patchDoc('companies/' + who.companyId, { status: 'cancelled', cancelledAt: new Date() });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('factory-billing failed:', e);
    return json(500, { error: e.message || 'Something went wrong' });
  }
};
