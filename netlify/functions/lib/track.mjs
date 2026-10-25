// Retail POS — the client's private link to their sales order or quotation.
// One random token per document, made the first time the shop sends it:
//
//   posTrack/<token>  { gid, kind: 'order' | 'quote', id, entityId, storeId, at }   server only, outside every group
//   specialOrders/<id>.trackToken, quotes/<id>.trackToken                         the same token, so it is sent again
//
// The page (pos/track.html) reads through pos-track.mjs with the token alone:
// no login, nothing but what the client should see.
import { randomBytes } from 'node:crypto';
import { createTop, patchDoc, groupId, nowIso } from './pos.mjs';

export const TRACK_COLL = { order: 'specialOrders', quote: 'quotes' };
export const tokenOk = (t) => /^[A-Za-z0-9_-]{20,40}$/.test(String(t || ''));

export async function ensureTrack(kind, doc) {
  if (tokenOk(doc.trackToken)) return doc.trackToken;
  const t = randomBytes(18).toString('base64url');
  await createTop('posTrack/' + t, { gid: groupId(), kind, id: doc.id, entityId: doc.entityId, storeId: doc.storeId || '', at: nowIso() });
  await patchDoc(TRACK_COLL[kind], doc.id, { trackToken: t });
  return t;
}

// the page on the site the till itself runs on
export function trackUrl(event, t) {
  const h = (event && event.headers) || {};
  const host = h['x-forwarded-host'] || h.host || '';
  const proto = /^(localhost|127\.)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}/pos/track.html?t=${t}`;
}
