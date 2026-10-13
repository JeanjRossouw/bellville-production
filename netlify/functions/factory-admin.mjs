// The app owner's own login. The database only treats a login as the owner
// when admins/<uid> exists, and nothing in the app may write there; this is
// the one place that does. A signed-in login whose email is on the owner
// list becomes an admin; everyone else is refused.
//
//   POST { action: 'claim' }, Authorization: Bearer <Firebase ID token>
//     → { admin: true, email }        the login is now (or already was) the owner
//     → 403 { error }                  the email is not on the list
//
// Env: FACTORY_ADMIN_EMAILS   the owner's email addresses, comma-separated
//      FACTORY_SERVICE_ACCOUNT the same key the billing function uses
import { verifyFirebaseToken } from './lib/auth.mjs';
import { getDoc, patchDoc, projectId } from './lib/factory-firestore.mjs';

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

export const ownerEmails = () => String(process.env.FACTORY_ADMIN_EMAILS || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    let body = {};
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); }
    catch { return json(400, { error: 'Invalid request' }); }
    if (body.action !== 'claim') return json(400, { error: 'Unknown action' });

    const header = (event.headers || {}).authorization || (event.headers || {}).Authorization || '';
    let user;
    try { user = await verifyFirebaseToken(header.startsWith('Bearer ') ? header.slice(7) : '', projectId()); }
    catch (e) { return json(401, { error: 'Sign in first (' + e.message + ')' }); }
    const email = String(user.email || '').toLowerCase();
    const uid = String(user.sub || user.user_id || '');
    if (!email || !uid) return json(401, { error: 'This login has no email address' });

    const allowed = ownerEmails();
    if (!allowed.length) return json(503, { error: 'No owner is set up yet. On the Netlify site, add the environment variable FACTORY_ADMIN_EMAILS with the owner’s email address, then try again.' });
    if (!allowed.includes(email)) return json(403, { error: email + ' is not on the owner list. Sign in with the owner’s email, or add this address to FACTORY_ADMIN_EMAILS on the Netlify site.' });

    const had = await getDoc('admins/' + uid);
    if (!had) await patchDoc('admins/' + uid, { email, name: String(user.name || '').slice(0, 80), claimedAt: new Date().toISOString() });
    return json(200, { admin: true, email, already: !!had });
  } catch (e) {
    console.error('factory-admin:', e);
    return json(500, { error: e.message || 'Something went wrong' });
  }
};
