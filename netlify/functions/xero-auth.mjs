// Xero OAuth2 connect flow (one organisation per business).
//
//   GET /.netlify/functions/xero-auth?action=connect&biz=bellville
//       → redirects the admin to Xero's consent screen for that business.
//   GET /.netlify/functions/xero-auth?action=callback&code=...&state=bellville
//       → Xero redirects back here; we exchange the code, resolve the org's
//         tenant id, and store the token set under that business key.
//
// Register XERO_REDIRECT_URI (this function's callback URL) in your Xero app.
import { clientCreds, exchangeCode, getConnections, saveTokens, loadTokens, AUTHORIZE_URL, SCOPES, BIZ_KEYS } from './lib/xero.mjs';

function html(status, title, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta charset="utf-8"><title>${title}</title>
      <body style="font-family:system-ui,sans-serif;max-width:520px;margin:3rem auto;padding:0 1rem;line-height:1.5">
      <h2>${title}</h2>${body}</body>`
  };
}

export const handler = async (event) => {
  const action = event.queryStringParameters?.action;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  try {
    clientCreds(); // throws early with a clear message if creds are missing
    if (!redirectUri) throw new Error('XERO_REDIRECT_URI is not set');

    if (action === 'connect') {
      const biz = event.queryStringParameters?.biz;
      if (!BIZ_KEYS.includes(biz)) return html(400, 'Invalid business', `<p>Unknown business "<code>${biz}</code>".</p>`);
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', process.env.XERO_CLIENT_ID);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', SCOPES);
      url.searchParams.set('state', biz);
      return { statusCode: 302, headers: { Location: url.toString() }, body: '' };
    }

    if (action === 'callback') {
      const { code, state: biz, error } = event.queryStringParameters || {};
      if (error) return html(400, 'Xero declined', `<p>${error}</p>`);
      if (!code || !BIZ_KEYS.includes(biz)) return html(400, 'Bad callback', '<p>Missing code or business.</p>');

      const tokenSet = await exchangeCode(code);
      const connections = await getConnections(tokenSet.access_token);
      const conn = connections && connections[0];
      if (!conn) return html(400, 'No organisation', '<p>No Xero organisation was authorised. Try again and select one.</p>');

      const existing = (await loadTokens(biz)) || {};
      await saveTokens(biz, {
        ...existing,
        ...tokenSet,
        tenant_id: conn.tenantId,
        tenant_name: conn.tenantName,
        obtained_at: Date.now()
      });

      return html(200, 'Xero connected ✅',
        `<p><strong>${biz}</strong> is now linked to the Xero organisation <strong>${conn.tenantName}</strong>.</p>
         <p>You can close this tab and return to the POS.</p>`);
    }

    return html(400, 'Unknown action', '<p>Use <code>?action=connect&biz=…</code>.</p>');
  } catch (e) {
    return html(500, 'Xero auth error', `<pre style="white-space:pre-wrap;color:#b91c1c">${e.message}</pre>`);
  }
};
