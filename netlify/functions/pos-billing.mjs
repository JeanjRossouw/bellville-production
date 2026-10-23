// Factory Manager POS: the subscription. Each business (posGroups/{groupId})
// has a 14-day trial, then pays monthly through PayFast, the same way as
// Factory Manager (lib/payfast.mjs). Its billing fields are written only
// here; the database rules stop the app writing them.
//
//   GET  ?plan=1                     → the plan and price (public)
//   POST { action: 'status' }        (login) → the business's standing: trial, active, read only
//   POST { action: 'checkout' }      (owner) → the signed PayFast form
//   POST { action: 'cancel' }        (owner) → stop the subscription; it runs to the end of the month paid for
//   POST <PayFast ITN form body>     → PayFast's payment notice; updates the business
//
// Env: FACTORY_SERVICE_ACCOUNT, PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY,
//      PAYFAST_PASSPHRASE, PAYFAST_SANDBOX (optional), POS_PRICE (optional).
import { json, Reject, getTop, patchTop, loginOf, groupOfLogin, inGroup, loadUser, DEFAULT_GROUP, GROUP_RE } from './lib/pos.mjs';
import { posPlan, accessOfGroup } from './lib/pos-plans.mjs';
import { applyNotice } from './factory-billing.mjs';
import * as payfast from './lib/payfast.mjs';

function siteUrl(event) {
  const h = event.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (host && /(^|\.)netlify\.app$|^localhost(:\d+)?$|^(www\.)?factorymanager\.co\.za$/i.test(host)) return (/^localhost/.test(host) ? 'http://' : 'https://') + host.replace(/^www\./i, '');
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
}
// the signed-in person, their business and their place in it
async function whoIs(event) {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const groupId = await groupOfLogin(login.sub);
  const user = await inGroup(groupId, () => loadUser(login.sub));
  if (!user) throw new Reject(403, 'This login is not on the staff list.');
  const group = groupId === DEFAULT_GROUP ? null : await getTop('posGroups/' + groupId);
  return { login, user, groupId, group };
}
const standing = (w) => {
  const a = accessOfGroup(w.group);
  const daysLeft = a.until ? Math.max(0, Math.ceil((Date.parse(a.until) - Date.now()) / 86400000)) : null;
  return { ok: true, groupId: w.groupId, name: w.group ? w.group.name : '', status: w.group ? w.group.status : 'free', access: a.state, why: a.why, until: a.until || '', daysLeft, plan: posPlan(), configured: payfast.configured(), owner: w.user.role === 'owner', canCancel: !!(w.group && w.group.payfastToken && w.group.status === 'active') };
};

export const handler = async (event) => {
  try {
    const plan = posPlan();
    if (event.httpMethod === 'GET') return json(200, { plan, configured: payfast.configured(), sandbox: payfast.sandbox() });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const ctype = String((event.headers || {})['content-type'] || (event.headers || {})['Content-Type'] || '');

    // ---- PayFast's payment notice (form-encoded) ----
    if (/x-www-form-urlencoded/i.test(ctype)) {
      const pairs = payfast.parseBody(raw);
      const v = await payfast.verifyItn(pairs);
      if (!v.ok) { console.warn('pos-billing: rejected notice:', v.why); return { statusCode: 400, body: 'rejected' }; }
      const gid = v.data.custom_str1;
      if (!gid || !GROUP_RE.test(gid) || gid === DEFAULT_GROUP) return { statusCode: 400, body: 'no business' };
      const group = await getTop('posGroups/' + gid);
      if (!group) return { statusCode: 404, body: 'unknown business' };
      // PayFast resends a notice until it gets a 200: one payment counts once
      const pid = String(v.data.pf_payment_id || v.data.m_payment_id || '').replace(/[^A-Za-z0-9_-]/g, '_');
      if (pid && String(v.data.payment_status).toUpperCase() === 'COMPLETE' && await getTop(`posGroups/${gid}/payments/${pid}`)) return { statusCode: 200, body: 'already counted' };
      const patch = applyNotice(group, v.data, plan);
      if (patch) {
        await patchTop('posGroups/' + gid, { ...patch, plan: plan.id });
        if (pid) await patchTop(`posGroups/${gid}/payments/${pid}`, { at: new Date(), status: String(v.data.payment_status || ''), amount: Number(v.data.amount_gross) || 0, fee: Number(v.data.amount_fee) || 0, reference: String(v.data.pf_payment_id || ''), item: String(v.data.item_name || '') });
      }
      return { statusCode: 200, body: 'ok' };
    }

    // ---- the app (JSON, signed in) ----
    let body; try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const w = await whoIs(event);
    if (body.action === 'status') return json(200, standing(w));
    if (w.user.role !== 'owner') return json(403, { error: 'Only the owner manages the subscription.' });
    if (!w.group) return json(400, { error: 'This business has no subscription to manage.' });

    if (body.action === 'checkout') {
      if (!payfast.configured()) return json(503, { error: 'Payments are not switched on yet. Ask the seller to set up PayFast.' });
      const base = siteUrl(event);
      const fields = payfast.checkoutFields({
        amount: plan.amount, itemName: plan.name + ' (monthly)',
        companyId: w.groupId, companyName: w.group.name, email: w.login.email, name: w.user.name,
        returnUrl: base + '/pos/?billing=done', cancelUrl: base + '/pos/?billing=cancelled', notifyUrl: base + '/.netlify/functions/pos-billing'
      });
      return json(200, { action: payfast.processUrl(), fields });
    }
    if (body.action === 'cancel') {
      if (!w.group.payfastToken) return json(400, { error: 'There is no active subscription to cancel.' });
      await payfast.cancelSubscription(w.group.payfastToken);
      await patchTop('posGroups/' + w.groupId, { status: 'cancelled', cancelledAt: new Date() });     // it runs to the end of the month paid for
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-billing failed:', e);
    return json(500, { error: e.message || 'Something went wrong' });
  }
};
