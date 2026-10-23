// Factory Manager POS: a new business signs up. The person has just made a
// login (email and password, in the browser); this makes their business:
// its own space (pos/{groupId}), them as its owner, and a 14-day trial.
//
//   POST { action: 'start', businessName, name }   (login, not yet in any business) → { groupId, user, trialEndsAt }
//
// Writes posGroups/{groupId}, pos/{groupId}, pos/{groupId}/users/{uid},
// posMembers/{uid} and the audit row. Companies, stores and staff are then
// added in the app (Admin), as for the first shops.
//
// Env: FACTORY_SERVICE_ACCOUNT.
import { json, Reject, clean, nowIso, randomId, loginOf, inGroup, createTop, setMember, memberGroupOf, createDoc, patchGroupDoc, serverStamp, audit, bodyOf } from './lib/pos.mjs';
import { posPlan, TRIAL_DAYS } from './lib/pos-plans.mjs';

async function start(event, b) {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Make your login first.');
  const businessName = clean(b.businessName, 80);
  const name = clean(b.name, 80) || (login.email || '').split('@')[0];
  if (!businessName) throw new Reject(400, 'What is your business called?');
  if (await memberGroupOf(login.sub)) throw new Reject(409, 'This login already belongs to a business on Factory Manager POS. Sign in instead.');
  const groupId = 'g' + randomId().replace(/[^A-Za-z0-9]/g, '').slice(0, 15);
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 86400000);
  if (!await createTop('posGroups/' + groupId, { name: businessName, ownerUid: login.sub, ownerEmail: (login.email || '').toLowerCase(), ownerName: name, status: 'trial', plan: posPlan().id, trialEndsAt, createdAt: now })) throw new Reject(409, 'Try again.');
  await setMember(login.sub, groupId);
  const user = await inGroup(groupId, async () => {
    await patchGroupDoc({ name: businessName, createdAt: nowIso(), createdBy: login.sub });
    await createDoc('users', login.sub, { email: (login.email || '').toLowerCase(), name, role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...serverStamp('*', '', login.sub, 'web') });
    await audit({ entityId: '*', action: 'group.signup', actorUid: login.sub, actorName: name, details: { businessName, trialDays: TRIAL_DAYS } });
    return { uid: login.sub, email: login.email || '', name, role: 'owner', entityIds: [], storeIds: [], pinSet: false };
  });
  return { ok: true, groupId, user, trialEndsAt: trialEndsAt.toISOString() };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    if (b.action === 'start') return json(200, await start(event, b));
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-signup failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was made; try again.' });
  }
};
