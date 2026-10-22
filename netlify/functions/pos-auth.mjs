// Retail POS — who you are (pos/DATA-MODEL.md, step 2).
//
// POST { action, ... } with, where the action needs a login, the Firebase ID
// token as a Bearer header. A device (an enrolled till) proves itself with
// its deviceId and secret instead.
//
//   bootstrap   (login)            the first owner: creates pos/{group} and users/{uid} when the group has nobody yet
//   me          (login)            my users record and, for a device, its record
//   createUser  (owner/manager)    { name, role, entityIds, storeIds, email?, pin? }  → a login by email (set-password mail) or a PIN-only uid
//   setPin      (login)            { uid, pin }  own PIN, or a manager's/owner's for someone in their reach
//   enrol       (manager/owner)    { storeId, registerId, label }  → { deviceId, secret }  this device becomes a till of that store
//   pinLogin    (device)           { deviceId, secret, pin }  → { token, user, staff }  a Firebase custom token for the PIN's owner, and the store's PIN cache
//   pinCache    (device)           { deviceId, secret }  → { staff }  the cache alone, refreshed after a sync
//   override    (device or login)  { pin, minRole, what, actorUid, docType, docId, details, deviceId?, secret?, entityId?, storeId? }
//                                  → { uid, name, role, token }  one audit row names both people
//   heartbeat   (device)           { deviceId, secret, appVersion }
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import {
  GROUP_ID, json, Reject, clean, randomId, nowIso, ROLES, rank,
  getDoc, patchDoc, createDoc, query, commit, serverStamp,
  loginOf, loadUser, requireMember, inEntity, inStore, atLeast, mayManage,
  pinValid, newSalt, hashPin, pinMatches, PIN_ITERATIONS, sha256, customToken, overrideToken,
  createAuthUser, sendPasswordReset, audit, loadDevice, bodyOf, patchGroupDoc
} from './lib/pos.mjs';

const MAX_FAILED = 5, LOCK_MINUTES = 15;
const later = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const publicUser = (u) => ({ uid: u.id, name: u.name, email: u.email || '', role: u.role, entityIds: u.entityIds || [], storeIds: u.storeIds || [], defaultStoreId: u.defaultStoreId || '', pinSet: !!u.pinSet });
const publicDevice = (d) => ({ deviceId: d.id, label: d.label, entityId: d.entityId, storeId: d.storeId, registerId: d.registerId });

// the device's PIN cache: the active staff of its store, with their hashes, so a PIN works offline
async function pinCacheFor(device) {
  const staff = (await query('users', [{ field: 'storeIds', op: 'ARRAY_CONTAINS', value: device.storeId }])).filter(u => u.active && u.pinSet);
  const out = [];
  for (const u of staff) {
    const h = await getDoc('pinHashes', u.id);
    if (h && h.hash) out.push({ uid: u.id, name: u.name, role: u.role, entityIds: u.entityIds || [], storeIds: u.storeIds || [], hash: h.hash, salt: h.salt, iterations: h.iterations || PIN_ITERATIONS });
  }
  return out;
}

// find whose PIN this is among the active staff of a store (or an entity), honouring lock-outs
async function whosePin(pin, { storeId, entityId }) {
  const cands = storeId
    ? (await query('users', [{ field: 'storeIds', op: 'ARRAY_CONTAINS', value: storeId }]))
    : (await query('users', [{ field: 'entityIds', op: 'ARRAY_CONTAINS', value: entityId }]));
  const owners = await query('users', [{ field: 'role', value: 'owner' }]);
  const seen = new Set();
  const all = [...cands, ...owners].filter(u => u.active && u.pinSet && !seen.has(u.id) && seen.add(u.id));
  let locked = false;
  for (const u of all) {
    const h = await getDoc('pinHashes', u.id);
    if (!h) continue;
    if (h.lockedUntil && h.lockedUntil > nowIso()) { locked = true; continue; }
    if (pinMatches(pin, h)) {
      if (h.failedCount) await patchDoc('pinHashes', u.id, { failedCount: 0, lockedUntil: '' });
      return { user: u, locked: false };
    }
  }
  return { user: null, locked };
}
// a wrong PIN counts against every PIN it could have been meant for; five in a row lock it for a while
async function countFailure(storeId) {
  const cands = (await query('users', [{ field: 'storeIds', op: 'ARRAY_CONTAINS', value: storeId }])).filter(u => u.active && u.pinSet);
  for (const u of cands) {
    const h = await getDoc('pinHashes', u.id); if (!h) continue;
    const n = (h.failedCount || 0) + 1;
    await patchDoc('pinHashes', u.id, { failedCount: n, ...(n >= MAX_FAILED ? { lockedUntil: later(LOCK_MINUTES), failedCount: 0 } : {}) });
  }
}

const actions = {
  async bootstrap(event, b) {
    const login = await loginOf(event);
    if (!login) throw new Reject(401, 'Sign in first.');
    const anyone = await query('users', [], 1);
    if (anyone.length) throw new Reject(409, 'This group already has its owner. Ask them to add you under Staff.');
    const name = clean(b.name, 80) || (login.email || '').split('@')[0];
    const groupName = clean(b.groupName, 80) || 'Retail group';
    await patchGroupDoc({ name: groupName, createdAt: nowIso(), createdBy: login.sub });
    await createDoc('users', login.sub, { email: (login.email || '').toLowerCase(), name, role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...serverStamp('*', '', login.sub, 'web') });
    await audit({ entityId: '*', action: 'group.bootstrap', actorUid: login.sub, actorName: name, details: { groupName } });
    return { ok: true, user: publicUser({ id: login.sub, email: login.email, name, role: 'owner', entityIds: [], storeIds: [], pinSet: false }) };
  },

  async me(event, b) {
    const login = await loginOf(event);
    const user = login ? await loadUser(login.sub) : null;
    const device = b.deviceId ? await loadDevice(b.deviceId, b.secret) : null;
    if (device) await patchDoc('devices', device.id, { lastSeenAt: nowIso(), appVersion: clean(b.appVersion, 20) });
    return { user: user ? publicUser(user) : null, device: device ? publicDevice(device) : null, nobodyYet: !user && !(await query('users', [], 1)).length };
  },

  async createUser(event, b) {
    const me = await requireMember(event);
    const name = clean(b.name, 80), role = clean(b.role, 20), email = clean(b.email, 120).toLowerCase();
    const entityIds = [...new Set((b.entityIds || []).map(x => clean(x, 40)).filter(Boolean))];
    const storeIds = [...new Set((b.storeIds || []).map(x => clean(x, 40)).filter(Boolean))];
    if (!name) throw new Reject(400, 'Give the person a name.');
    if (!ROLES.includes(role)) throw new Reject(400, 'Choose a role.');
    if (!mayManage(me.user, role, entityIds, storeIds)) throw new Reject(403, 'Your role cannot add someone like that.');
    if (role !== 'owner' && !entityIds.length) throw new Reject(400, 'Tick at least one company.');
    // every store must belong to one of the ticked entities
    for (const s of storeIds) { const st = await getDoc('stores', s); if (!st || !entityIds.includes(st.entityId)) throw new Reject(400, 'A ticked store is not in a ticked company.'); }
    if (!email && rank(role) >= rank('manager')) throw new Reject(400, 'A manager or owner signs in with an email: fill it in.');
    const pin = clean(b.pin, 6);
    if (pin && !pinValid(pin)) throw new Reject(400, 'A PIN is 4 to 6 digits.');
    let uid, existed = false, mailed = false;
    if (email) {
      if ((await query('users', [{ field: 'email', value: email }], 1)).length) throw new Reject(409, 'Someone with that email is already on the staff list.');
      ({ uid, existed } = await createAuthUser({ email, displayName: name }));
      if (!uid) throw new Reject(500, 'The login could not be made.');
      try { await sendPasswordReset(email, b.continueUrl ? clean(b.continueUrl, 300) : ''); mailed = true; } catch (e) { console.error(e); }
    } else uid = randomId('st_');
    const writes = [{ create: true, coll: 'users', id: uid, data: { email, name, role, active: true, entityIds, storeIds, defaultStoreId: storeIds[0] || '', pinSet: !!pin, pinChangedAt: pin ? nowIso() : '', ...serverStamp(entityIds[0] || '*', '', me.uid, 'web') } }];
    if (pin) { const salt = newSalt(); writes.push({ set: true, coll: 'pinHashes', id: uid, data: { hash: hashPin(pin, salt), salt, iterations: PIN_ITERATIONS, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '', ...serverStamp(entityIds[0] || '*', '', me.uid) } }); }
    await commit(writes);
    await audit({ entityId: entityIds[0] || '*', action: 'user.create', actorUid: me.uid, actorName: me.user.name, docType: 'user', docId: uid, details: { name, role, entityIds, storeIds, email: !!email, pin: !!pin } });
    return { ok: true, uid, existed, mailed, text: email ? (mailed ? name + ' has been emailed a link to set a password.' : name + ' is added, but the email did not go: use "Forgot password" on the sign-in page.') : name + ' is added' + (pin ? ' with a PIN.' : '. Set a PIN so they can sign in at a till.') };
  },

  async setPin(event, b) {
    const me = await requireMember(event);
    const uid = clean(b.uid, 60) || me.uid, pin = clean(b.pin, 6);
    const target = uid === me.uid ? me.user : await getDoc('users', uid);
    if (!target) throw new Reject(404, 'No such person.');
    if (uid !== me.uid && !mayManage(me.user, target.role, target.entityIds || [], target.storeIds || [])) throw new Reject(403, 'Your role cannot set that person’s PIN.');
    const settings = await getDoc('settings', (target.entityIds || [])[0] || '');
    const length = settings && settings.session && settings.session.pinLength;
    if (!pinValid(pin, length)) throw new Reject(400, length ? `A PIN here is ${length} digits.` : 'A PIN is 4 to 6 digits.');
    // the same PIN for two people in one store would make a login ambiguous
    for (const s of target.storeIds || []) {
      const others = (await query('users', [{ field: 'storeIds', op: 'ARRAY_CONTAINS', value: s }])).filter(u => u.id !== uid && u.active && u.pinSet);
      for (const o of others) { const h = await getDoc('pinHashes', o.id); if (h && pinMatches(pin, h)) throw new Reject(409, 'Someone in the same store already uses that PIN. Choose another.'); }
    }
    const salt = newSalt();
    await commit([
      { set: true, coll: 'pinHashes', id: uid, data: { hash: hashPin(pin, salt), salt, iterations: PIN_ITERATIONS, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '', ...serverStamp((target.entityIds || [])[0] || '*', '', me.uid) } },
      { update: true, coll: 'users', id: uid, data: { pinSet: true, pinChangedAt: nowIso(), updatedAt: nowIso(), updatedBy: me.uid } }
    ]);
    await audit({ entityId: (target.entityIds || [])[0] || '*', action: 'pin.set', actorUid: me.uid, actorName: me.user.name, docType: 'user', docId: uid, details: { own: uid === me.uid } });
    return { ok: true };
  },

  async enrol(event, b) {
    const me = await requireMember(event);
    if (!atLeast(me.user, 'manager')) throw new Reject(403, 'A manager or the owner enrols a till.');
    const storeId = clean(b.storeId, 40), registerId = clean(b.registerId, 40), label = clean(b.label, 60) || 'Till';
    const store = await getDoc('stores', storeId);
    if (!store || !inStore(me.user, storeId) || !inEntity(me.user, store.entityId)) throw new Reject(403, 'Not one of your stores.');
    const reg = registerId ? await getDoc('registers', registerId) : null;
    if (registerId && (!reg || reg.storeId !== storeId)) throw new Reject(400, 'That register is not in this store.');
    const deviceId = randomId('dev_'), secret = randomId() + randomId();
    await createDoc('devices', deviceId, { label, registerId, secretHash: sha256(secret), enrolledBy: me.uid, enrolledAt: nowIso(), active: true, lastSeenAt: nowIso(), appVersion: clean(b.appVersion, 20), ...serverStamp(store.entityId, storeId, me.uid, deviceId) });
    await audit({ entityId: store.entityId, storeId, action: 'device.enrol', actorUid: me.uid, actorName: me.user.name, docType: 'device', docId: deviceId, deviceId, details: { label, registerId } });
    return { ok: true, deviceId, secret, device: publicDevice({ id: deviceId, label, entityId: store.entityId, storeId, registerId }) };
  },

  async pinLogin(event, b) {
    const device = await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120));
    if (!device) throw new Reject(403, 'This till is not enrolled. A manager signs in with an email and enrols it under Admin → Devices.');
    const pin = clean(b.pin, 6);
    if (!pinValid(pin)) throw new Reject(400, 'A PIN is 4 to 6 digits.');
    const { user, locked } = await whosePin(pin, { storeId: device.storeId });
    if (!user) {
      await countFailure(device.storeId);
      await audit({ entityId: device.entityId, storeId: device.storeId, action: 'login.pin.failed', deviceId: device.id, details: { locked } });
      throw new Reject(locked ? 423 : 401, locked ? 'Too many wrong PINs: this PIN is locked for ' + LOCK_MINUTES + ' minutes.' : 'That PIN is not known at this till.');
    }
    const token = await customToken(user.id, { posRole: user.role });
    await Promise.all([
      patchDoc('devices', device.id, { lastSeenAt: nowIso(), appVersion: clean(b.appVersion, 20) }),
      audit({ entityId: device.entityId, storeId: device.storeId, action: 'login.pin', actorUid: user.id, actorName: user.name, deviceId: device.id })
    ]);
    return { ok: true, token, user: publicUser(user), device: publicDevice(device), staff: await pinCacheFor(device) };
  },

  async pinCache(event, b) {
    const device = await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120));
    if (!device) throw new Reject(403, 'This till is not enrolled.');
    return { ok: true, device: publicDevice(device), staff: await pinCacheFor(device) };
  },

  async override(event, b) {
    const device = b.deviceId ? await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120)) : null;
    const login = await loginOf(event);
    const actor = login ? await loadUser(login.sub) : null;
    if (!device && !actor) throw new Reject(401, 'Sign in first.');
    const storeId = device ? device.storeId : clean(b.storeId, 40);
    const entityId = device ? device.entityId : clean(b.entityId, 40);
    if (!device && actor && !(inEntity(actor, entityId) && (!storeId || inStore(actor, storeId)))) throw new Reject(403, 'Not your store.');
    const minRole = ROLES.includes(b.minRole) ? b.minRole : 'manager';
    const pin = clean(b.pin, 6);
    if (!pinValid(pin)) throw new Reject(400, 'A PIN is 4 to 6 digits.');
    const { user, locked } = await whosePin(pin, storeId ? { storeId } : { entityId });
    const actorUid = actor ? actor.id : clean(b.actorUid, 60);
    const action = 'override.' + (clean(b.what, 40) || 'approve');
    if (!user || rank(user.role) < rank(minRole) || !inEntity(user, entityId) || (storeId && !inStore(user, storeId))) {
      if (storeId) await countFailure(storeId);
      await audit({ entityId, storeId, action: action + '.refused', actorUid, deviceId: device ? device.id : 'web', details: { minRole, matched: !!user, locked, docType: b.docType || '', docId: b.docId || '' } });
      throw new Reject(403, user ? 'That PIN belongs to a ' + user.role + '; a ' + minRole + ' or higher must approve this.' : locked ? 'Too many wrong PINs: locked for ' + LOCK_MINUTES + ' minutes.' : 'That PIN is not known here.');
    }
    if (user.id === actorUid) throw new Reject(403, 'You cannot approve your own action: ask a ' + minRole + '.');
    const actorName = actor ? actor.name : clean(b.actorName, 80);
    await audit({ entityId, storeId, action, actorUid, actorName, overrideUid: user.id, overrideName: user.name, docType: clean(b.docType, 30), docId: clean(b.docId, 80), details: typeof b.details === 'object' && b.details ? b.details : {}, deviceId: device ? device.id : 'web' });
    const token = overrideToken({ overrideUid: user.id, overrideName: user.name, role: user.role, action, actorUid, storeId, entityId, docId: clean(b.docId, 80) });
    return { ok: true, uid: user.id, name: user.name, role: user.role, token };
  },

  async heartbeat(event, b) {
    const device = await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120));
    if (!device) throw new Reject(403, 'This till is not enrolled.');
    await patchDoc('devices', device.id, { lastSeenAt: nowIso(), appVersion: clean(b.appVersion, 20) });
    return { ok: true, device: publicDevice(device) };
  }
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-auth failed:', e);
    return json(500, { error: 'Something went wrong on the server. Try again; if it keeps happening, tell the office.' });
  }
};
