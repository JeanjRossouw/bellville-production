// Xero for the factory app: each company connects its own Xero organisation
// from Settings → Accounting, and every till sale paid in full goes to Xero as
// a paid sales invoice (an AUTHORISED ACCREC invoice, prices incl. VAT, plus a
// Payment to the bank account the owner chose).
//
//   POST { action:'status' }                                   any member
//   POST { action:'connectUrl' }   → { url } to open at Xero  owner
//   POST { action:'settings', bankAccount, revenueAccount, taxType, autoPush }   owner
//   POST { action:'disconnect' }                               owner
//   POST { action:'pushSale', saleId }   a paid sale → Xero, once   any member
//   GET  ?action=callback&code=…&state=…   Xero sends the owner back here
//
// The token set lives in Netlify Blobs under fm-<company id> (lib/xero.mjs, the
// same helpers the Bellville till uses); the app never sees it. What the app
// shows is companies/<cid>/integrations/xero (no secrets).
//
// Env: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI (this function's
//      callback URL), FACTORY_SERVICE_ACCOUNT.
import crypto from 'node:crypto';
import { verifyFirebaseToken } from './lib/auth.mjs';
import { getDoc, patchDoc, createDoc, deleteDoc, projectId, companyActive } from './lib/factory-firestore.mjs';
import { clientCreds, exchangeCode, getConnections, saveTokens, loadTokens, deleteTokens, xeroApi, AUTHORIZE_URL, SCOPES, connectBlobs } from './lib/xero.mjs';

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const html = (status, title, body) => ({ statusCode: status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:520px;margin:3rem auto;padding:0 1rem;line-height:1.5"><h2>${title}</h2>${body}</body>` });
const nowIso = () => new Date().toISOString();
const CID = /^[A-Za-z0-9_-]{1,64}$/;
const key = (cid) => 'fm-' + cid;
const statusPath = (cid) => `companies/${cid}/integrations/xero`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function whoIs(event) {
  const h = event.headers || {};
  const header = h.authorization || h.Authorization || '';
  const user = await verifyFirebaseToken(header.startsWith('Bearer ') ? header.slice(7) : '', projectId());
  const me = await getDoc('users/' + user.sub);
  if (!me || !me.companyId) throw new Error('No company for this login');
  const member = await getDoc(`companies/${me.companyId}/members/${user.sub}`);
  if (!member) throw new Error('Not part of this company');
  const company = await getDoc('companies/' + me.companyId);
  return { user, member, company, cid: me.companyId, owner: member.role === 'owner' };
}

// The state carried to Xero and back names the company, signed with the
// app's secret so a callback can only land on the company that started it.
function sign(cid, ts) { return crypto.createHmac('sha256', clientCreds().secret).update(cid + '.' + ts).digest('hex').slice(0, 32); }
function makeState(cid) { const ts = Date.now().toString(36); return cid + '.' + ts + '.' + sign(cid, ts); }
function readState(state) {
  const [cid, ts, sig] = String(state || '').split('.');
  if (!CID.test(cid || '') || !ts || !sig) return null;
  const want = sign(cid, ts);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  if (Date.now() - parseInt(ts, 36) > 30 * 60000) return null;      // half an hour to approve
  return cid;
}

// A paid sale as a Xero invoice with its payment, once: the Reference is the
// sale number, and an invoice already there with it is reused.
async function pushSale(who, body) {
  const saleId = String(body.saleId || '');
  if (!CID.test(saleId)) throw new Error('Which sale?');
  const st = (await getDoc(statusPath(who.cid))) || {};
  if (!st.connected) return { ok: true, skipped: 'not connected' };
  if (!st.bankAccount) return { ok: true, skipped: 'no bank account code in the Xero settings' };
  const sale = await getDoc(`companies/${who.cid}/sales/${saleId}`);
  if (!sale) throw new Error('Sale not found');
  if (sale.xeroInvoiceId) return { ok: true, already: true, invoice: sale.xeroInvoiceNumber || '' };
  if (Number(sale.balance) > 0.005) return { ok: true, skipped: 'not paid in full yet' };
  const claimPath = `companies/${who.cid}/xeroPushes/${saleId}`;
  const claim = await getDoc(claimPath);
  if (claim && claim.state === 'done') return { ok: true, already: true };
  if (claim && claim.state === 'making' && Date.now() - Date.parse(claim.at || 0) < 2 * 60000) throw new Error('This sale is being sent to Xero right now');
  if (!claim) await createDoc(claimPath, { at: nowIso(), state: 'making' }); else await patchDoc(claimPath, { at: nowIso(), state: 'making' });
  const k = key(who.cid);
  try {
    const reference = sale.saleNo || saleId;
    const existing = await xeroApi(k, `/Invoices?where=${encodeURIComponent(`Reference=="${reference}"`)}`);
    let inv = existing && existing.Invoices && existing.Invoices[0];
    const date = String(sale.date || nowIso()).slice(0, 10);
    if (!inv) {
      const contactId = await contactFor(k, sale);
      const lines = (sale.lines || []).filter(l => Number(l.qty) > 0).map(l => ({
        Description: (l.name || 'Item') + (l.fabric ? ' — ' + l.fabric : ''), Quantity: Number(l.qty) || 1,
        UnitAmount: r2((l.net != null ? Number(l.net) : (Number(l.qty) || 0) * (Number(l.unitPrice) || 0)) / (Number(l.qty) || 1)),
        AccountCode: st.revenueAccount || '200', ...(st.taxType ? { TaxType: st.taxType } : {}), ...(l.kind === 'giftcard' ? { TaxType: 'NONE' } : {})
      }));
      const made = await xeroApi(k, '/Invoices', { method: 'POST', body: { Invoices: [{ Type: 'ACCREC', Status: 'AUTHORISED', Contact: { ContactID: contactId }, Date: date, DueDate: date, Reference: reference, LineAmountTypes: 'Inclusive', LineItems: lines }] } });
      inv = made.Invoices[0];
    }
    // the payment: what the invoice says is owed, into the bank account chosen
    if (Number(inv.AmountDue) > 0.005 || inv.Status === 'AUTHORISED' && !inv.Payments) {
      const amount = Number(inv.AmountDue) > 0 ? Number(inv.AmountDue) : Number(inv.Total) || Number(sale.total) || 0;
      if (amount > 0) await xeroApi(k, '/Payments', { method: 'POST', body: { Payments: [{ Invoice: { InvoiceID: inv.InvoiceID }, Account: { Code: st.bankAccount }, Date: date, Amount: amount, Reference: sale.method || 'Till' }] } });
    }
    await patchDoc(`companies/${who.cid}/sales/${saleId}`, { xeroInvoiceId: inv.InvoiceID, xeroInvoiceNumber: inv.InvoiceNumber || '', xeroAt: nowIso() });
    await patchDoc(claimPath, { state: 'done', doneAt: nowIso(), invoiceId: inv.InvoiceID });
    await patchDoc(statusPath(who.cid), { lastPushAt: nowIso(), lastError: '' });
    return { ok: true, invoice: inv.InvoiceNumber || inv.InvoiceID };
  } catch (e) {
    await deleteDoc(claimPath).catch(() => {});
    await patchDoc(statusPath(who.cid), { lastError: 'Sale ' + (sale.saleNo || '') + ' not sent to Xero: ' + e.message, lastErrorAt: nowIso() }).catch(() => {});
    throw e;
  }
}
// The Xero contact: the customer by name (made if new), else one "Till customer".
async function contactFor(k, sale) {
  const name = String(sale.customerName && sale.customerName !== 'Walk-in customer' ? sale.customerName : 'Till customer').replace(/"/g, '').slice(0, 100);
  const found = await xeroApi(k, `/Contacts?where=${encodeURIComponent(`Name=="${name}"`)}`);
  const hit = found && found.Contacts && found.Contacts[0];
  if (hit) return hit.ContactID;
  const made = await xeroApi(k, '/Contacts', { method: 'POST', body: { Contacts: [{ Name: name }] } });
  return made.Contacts[0].ContactID;
}

export const handler = async (event) => {
  connectBlobs(event);
  const q = event.queryStringParameters || {};
  // ---- Xero sending the owner back ----
  if (event.httpMethod === 'GET' && q.action === 'callback') {
    try {
      if (q.error) return html(400, 'Xero said no', `<p>${String(q.error_description || q.error).replace(/</g, '&lt;')}</p>`);
      const cid = readState(q.state);
      if (!q.code || !cid) return html(400, 'This link has expired', '<p>Go back to Factory Manager → Settings → Accounting and tap Connect Xero again.</p>');
      const tokens = await exchangeCode(q.code);
      const conns = await getConnections(tokens.access_token);
      const conn = conns && conns[0];
      if (!conn) return html(400, 'No organisation', '<p>No Xero organisation was chosen. Try again and pick one.</p>');
      await saveTokens(key(cid), { ...((await loadTokens(key(cid))) || {}), ...tokens, tenant_id: conn.tenantId, tenant_name: conn.tenantName, obtained_at: Date.now() });
      await patchDoc(statusPath(cid), { connected: true, tenantName: conn.tenantName || '', connectedAt: nowIso(), lastError: '' });
      return html(200, 'Xero connected ✅', `<p>Factory Manager is now linked to <strong>${String(conn.tenantName || '').replace(/</g, '&lt;')}</strong>.</p><p>Close this tab and go back to Settings → Accounting to fill in the account codes.</p>`);
    } catch (e) {
      console.error('factory-xero callback:', e);
      return html(500, 'Xero could not be connected', `<pre style="white-space:pre-wrap;color:#b91c1c">${String(e.message).replace(/</g, '&lt;')}</pre>`);
    }
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body; try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); } catch { return json(400, { error: 'Invalid JSON' }); }
  let who;
  try { who = await whoIs(event); } catch (e) { return json(403, { error: e.message }); }
  try {
    const st = (await getDoc(statusPath(who.cid))) || {};
    switch (body.action) {
      case 'status': return json(200, { connected: !!st.connected, tenantName: st.tenantName || '', bankAccount: st.bankAccount || '', revenueAccount: st.revenueAccount || '200', taxType: st.taxType || '', lastError: st.lastError || '', lastPushAt: st.lastPushAt || '', ready: !!(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET && process.env.XERO_REDIRECT_URI) });
      case 'connectUrl': {
        if (!who.owner) return json(403, { error: 'Only the owner can connect Xero' });
        if (!companyActive(who.company)) return json(403, { error: 'Your subscription is not active' });
        try { clientCreds(); } catch { return json(503, { error: 'Xero is not set up on this site yet: XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI must be added on Netlify.' }); }
        if (!process.env.XERO_REDIRECT_URI) return json(503, { error: 'XERO_REDIRECT_URI is not set on Netlify.' });
        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', process.env.XERO_CLIENT_ID);
        url.searchParams.set('redirect_uri', process.env.XERO_REDIRECT_URI); url.searchParams.set('scope', SCOPES); url.searchParams.set('state', makeState(who.cid));
        return json(200, { url: url.toString() });
      }
      case 'settings': {
        if (!who.owner) return json(403, { error: 'Only the owner can change this' });
        const clean = (v) => String(v || '').trim().slice(0, 40);
        await patchDoc(statusPath(who.cid), { bankAccount: clean(body.bankAccount), revenueAccount: clean(body.revenueAccount) || '200', taxType: clean(body.taxType), autoPush: body.autoPush !== false });
        return json(200, { ok: true });
      }
      case 'disconnect': {
        if (!who.owner) return json(403, { error: 'Only the owner can disconnect Xero' });
        await deleteTokens(key(who.cid));
        await patchDoc(statusPath(who.cid), { connected: false, tenantName: '', disconnectedAt: nowIso() });
        return json(200, { ok: true });
      }
      case 'pushSale': return json(200, await pushSale(who, body));
      default: return json(400, { error: 'Unknown action' });
    }
  } catch (e) {
    console.error('factory-xero ' + body.action + ' failed:', e);
    return json(400, { error: e.message || 'Something went wrong' });
  }
};
export { pushSale, makeState, readState };
