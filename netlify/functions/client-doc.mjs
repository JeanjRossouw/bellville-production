// Client-facing documents: a quote, sales order or invoice shared with a
// customer over a private link, with a message thread so they can ask for an
// update instead of phoning.
//
//   Public (the link holder, no sign-in — the token IS the credential):
//     GET  ?token=…                       → the document + thread
//     POST { action:'message', token, text, name? }
//
//   Staff (Firebase ID token, same as xero-invoice):
//     GET  ?inbox=1                       → index for the badge + inbox list
//     POST { action:'create', doc }       → share a document, returns url
//     POST { action:'reply', token, text }
//     POST { action:'status', token, status, note? }
//
// Storage reuses the service-account Firestore helper: one doc per shared
// document at shared-data/clientdoc-<token>, plus a small index doc so the
// inbox needs no query support.
import { randomUUID } from 'node:crypto';
import { readDoc, writeDoc } from './lib/firestore.mjs';
import { requireUser } from './lib/auth.mjs';

const INDEX_DOC = 'clientdocs-index';
const MAX_TEXT = 2000;
const MAX_MESSAGES = 200;

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

const docKey = (token) => `clientdoc-${token}`;
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Tokens are the only thing protecting a document, so they must be random and
// long. 32 hex characters from randomUUID is ample and needs no dependency.
const newToken = () => randomUUID().replace(/-/g, '');

function validToken(token) {
  return /^[a-f0-9]{32}$/.test(String(token || ''));
}

function siteUrl(event) {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (base) return base.replace(/\/$/, '');
  const host = event.headers['x-forwarded-host'] || event.headers.host || '';
  return host ? `https://${host}` : '';
}

// What the client is allowed to see. Everything here was put on the document
// by staff for exactly that purpose, so it is returned whole.
function publicView(doc) {
  return {
    token: doc.token,
    type: doc.type,
    number: doc.number,
    createdAt: doc.createdAt,
    company: doc.company || {},
    client: { name: (doc.client && doc.client.name) || '' },
    items: doc.items || [],
    totalCents: doc.totalCents || 0,
    depositCents: doc.depositCents || 0,
    balanceCents: doc.balanceCents || 0,
    status: doc.status || 'sent',
    statusNote: doc.statusNote || '',
    expectedDate: doc.expectedDate || '',
    messages: (doc.messages || []).map((m) => ({
      from: m.from, text: m.text, at: m.at, who: m.from === 'staff' ? m.who || 'Team' : m.who || 'You'
    }))
  };
}

async function loadIndex() {
  const idx = await readDoc(INDEX_DOC);
  return Array.isArray(idx.docs) ? idx.docs : [];
}

// The index is a compact summary list — it never holds message text, only
// enough for the inbox to render and count.
async function updateIndex(token, patch) {
  const docs = await loadIndex();
  const i = docs.findIndex((d) => d.token === token);
  if (i >= 0) docs[i] = { ...docs[i], ...patch };
  else docs.unshift({ token, ...patch });
  await writeDoc(INDEX_DOC, { docs: docs.slice(0, 500) }, 'client-doc');
}

async function staffOnly(event) {
  await requireUser(event);
}

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters && event.queryStringParameters.inbox) {
        await staffOnly(event);
        const docs = await loadIndex();
        return json(200, { docs, unread: docs.filter((d) => d.unread).length });
      }
      const token = (event.queryStringParameters || {}).token;
      if (!validToken(token)) return json(400, { error: 'Invalid link' });
      const doc = await readDoc(docKey(token));
      if (!doc || !doc.token) return json(404, { error: 'This link is no longer available.' });
      return json(200, publicView(doc));
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = body.action;

    // ---- Public: the customer asks for an update --------------------------
    if (action === 'message') {
      if (!validToken(body.token)) return json(400, { error: 'Invalid link' });
      const text = clean(body.text, MAX_TEXT);
      if (!text) return json(400, { error: 'Please type a message first.' });

      const doc = await readDoc(docKey(body.token));
      if (!doc || !doc.token) return json(404, { error: 'This link is no longer available.' });

      const at = new Date().toISOString();
      doc.messages = [...(doc.messages || []), { from: 'client', text, at, who: clean(body.name, 60) || 'Customer' }]
        .slice(-MAX_MESSAGES);
      doc.lastClientAt = at;
      doc.unread = true;
      await writeDoc(docKey(doc.token), doc, 'client');
      await updateIndex(doc.token, {
        number: doc.number, type: doc.type, client: (doc.client || {}).name || '',
        totalCents: doc.totalCents || 0, status: doc.status || 'sent', lastClientAt: at, unread: true
      });
      return json(200, { ok: true, messages: publicView(doc).messages });
    }

    // ---- Everything below is staff-only -----------------------------------
    try {
      await staffOnly(event);
    } catch (e) {
      return json(401, { error: 'Unauthorized: ' + e.message });
    }

    if (action === 'create') {
      const d = body.doc || {};
      const token = validToken(d.token) ? d.token : newToken();
      const existing = validToken(d.token) ? await readDoc(docKey(token)) : {};
      const doc = {
        token,
        type: clean(d.type, 20) || 'quote',
        number: clean(d.number, 40),
        createdAt: existing.createdAt || new Date().toISOString(),
        company: d.company || {},
        client: { name: clean((d.client || {}).name, 120), email: clean((d.client || {}).email, 160), phone: clean((d.client || {}).phone, 40) },
        items: Array.isArray(d.items) ? d.items.slice(0, 200).map((i) => ({
          name: clean(i.name, 200), qty: Number(i.qty) || 0, lineTotalCents: Math.round(Number(i.lineTotalCents) || 0)
        })) : [],
        totalCents: Math.round(Number(d.totalCents) || 0),
        depositCents: Math.round(Number(d.depositCents) || 0),
        balanceCents: Math.round(Number(d.balanceCents) || 0),
        expectedDate: clean(d.expectedDate, 40),
        status: clean(d.status, 40) || existing.status || 'sent',
        statusNote: clean(d.statusNote, 500) || existing.statusNote || '',
        // Sharing the same document again must not wipe the conversation.
        messages: existing.messages || [],
        unread: !!existing.unread,
        lastClientAt: existing.lastClientAt || ''
      };
      await writeDoc(docKey(token), doc, 'staff');
      await updateIndex(token, {
        number: doc.number, type: doc.type, client: doc.client.name,
        totalCents: doc.totalCents, status: doc.status, unread: doc.unread, lastClientAt: doc.lastClientAt
      });
      return json(200, { token, url: `${siteUrl(event)}/reptipos/doc.html?t=${token}` });
    }

    if (action === 'reply' || action === 'status') {
      if (!validToken(body.token)) return json(400, { error: 'Invalid link' });
      const doc = await readDoc(docKey(body.token));
      if (!doc || !doc.token) return json(404, { error: 'Document not found' });

      if (action === 'reply') {
        const text = clean(body.text, MAX_TEXT);
        if (!text) return json(400, { error: 'Empty reply' });
        doc.messages = [...(doc.messages || []), { from: 'staff', text, at: new Date().toISOString(), who: clean(body.who, 60) || 'Team' }]
          .slice(-MAX_MESSAGES);
      } else {
        doc.status = clean(body.status, 40) || doc.status;
        doc.statusNote = clean(body.note, 500);
      }
      // Either action means staff have seen it.
      doc.unread = false;
      await writeDoc(docKey(doc.token), doc, 'staff');
      await updateIndex(doc.token, { unread: false, status: doc.status });
      return json(200, { ok: true, doc: publicView(doc) });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    const unauthorized = /Unauthorized|token/i.test(e.message || '');
    return json(unauthorized ? 401 : 500, { error: e.message || 'Something went wrong' });
  }
};
