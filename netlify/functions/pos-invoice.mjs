// Retail POS — a supplier's invoice dropped on the Receive screen: taken in, queued for the reader, and its result
// handed back. The reading itself is lib/invoice-read.mjs, run by pos-invoice-read-background.
//
//   start   { files [ { name, type, data (base64) } ], + where }   a supervisor: the files kept in chunks, the read
//           queued and the background reader called → { readId }
//   result  { readId, + where }                                    → { status: queued | reading | done | failed, result?, error? }
//
// Nothing here touches stock, costs or money: the result fills in the receipt for the person to check.
// Each read costs money: POS_INVOICE_READS_PER_DAY a person a day (40 unless set).
//
// Env: ANTHROPIC_API_KEY, FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional), POS_INVOICE_READS_PER_DAY (optional).
import { json, Reject, clean, nowIso, randomId, getDoc, patchDoc, createDoc, commit, serverStamp, bodyOf, rank, groupId, withGroup } from './lib/pos.mjs';
import { whoAndWhere } from './lib/sale.mjs';
import { INVOICE_TYPES, CHUNK, MAX_B64, MAX_FILES, runRead } from './lib/invoice-read.mjs';

const PER_DAY = () => Math.max(1, Number(process.env.POS_INVOICE_READS_PER_DAY) || 40);
const saDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const siteOf = (event) => { const h = (event && event.headers) || {}; const host = h['x-forwarded-host'] || h.host || ''; return host ? (h['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https')) + '://' + host : (process.env.URL || ''); };

async function who(event, b) {
  const ctx = await whoAndWhere(event, b, { noShift: true });
  if (rank(ctx.user.role) < rank('supervisor')) throw new Reject(403, 'Receiving stock is for supervisors and up.');
  return ctx;
}

const actions = {
  async start(event, b) {
    const ctx = await who(event, b);
    if (!process.env.ANTHROPIC_API_KEY) throw new Reject(503, 'The invoice reader is not switched on yet: the owner must add ANTHROPIC_API_KEY on Netlify.');
    const files = (Array.isArray(b.files) ? b.files : []).map(f => ({ name: clean(f && f.name, 120), type: String((f && f.type) || '').toLowerCase(), data: String((f && f.data) || '') }));
    if (!files.length) throw new Reject(400, 'Drop the invoice first: a PDF or a photo.');
    if (files.length > MAX_FILES) throw new Reject(400, `At most ${MAX_FILES} files (the pages of one invoice).`);
    for (const f of files) {
      if (!INVOICE_TYPES.includes(f.type)) throw new Reject(400, `${f.name || 'That file'} is not a PDF or a photo (JPG, PNG or WebP).`);
      if (!f.data || !/^[A-Za-z0-9+/]+=*$/.test(f.data)) throw new Reject(400, `${f.name || 'That file'} did not arrive whole: try again.`);
    }
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total > MAX_B64) throw new Reject(400, 'That is too big to read (about 3.5 MB at most): use a photo, or a PDF of only the invoice\'s pages.');

    const day = saDay();
    const use = (await getDoc('invoiceReadUse', ctx.user.id)) || {};
    const used = use.day === day ? Number(use.count) || 0 : 0;
    if (used >= PER_DAY()) throw new Reject(429, `That is all the invoices the reader takes in a day (${PER_DAY()}). Type this one in, or try tomorrow.`);
    await patchDoc('invoiceReadUse', ctx.user.id, { day, count: used + 1, name: ctx.user.name, lastAt: nowIso(), entityId: ctx.entityId, storeId: ctx.storeId });

    // the files as one long string, cut into documents small enough for Firestore; each file's length kept to cut it back
    const readId = randomId('ir_'), key = randomId('k_');
    const all = files.map(f => f.data).join('');
    const parts = []; for (let i = 0; i < all.length; i += CHUNK) parts.push(all.slice(i, i + CHUNK));
    const stamp = serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId);
    await Promise.all(parts.map((data, i) => commit([{ create: true, coll: 'invoiceReadChunks', id: readId + '_' + i, data: { readId, i, data, ...stamp } }])));
    await createDoc('invoiceReads', readId, { status: 'queued', key, chunks: parts.length, files: files.map(f => ({ name: f.name, type: f.type, len: f.data.length })), byName: ctx.user.name, error: '', ...stamp });

    // the reader works in the background; where that cannot be called, the read is done here and now
    let called = false;
    const site = siteOf(event);
    if (site) {
      try { const r = await fetch(site + '/.netlify/functions/pos-invoice-read-background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readId, g: groupId(), key }) }); called = r.status < 300; }
      catch (e) { console.error('invoice reader not called:', e.message); }
    }
    if (!called) await runRead(readId, key);
    return { ok: true, readId, used: used + 1, limit: PER_DAY() };
  },

  async result(event, b) {
    const ctx = await who(event, b);
    const readId = clean(b.readId, 80);
    const rec = await getDoc('invoiceReads', readId);
    if (!rec || rec.entityId !== ctx.entityId || rec.createdBy !== ctx.user.id) throw new Reject(404, 'No such invoice read.');
    // queued for a while and never picked up (the background call was lost): read it now
    if (rec.status === 'queued' && Date.now() - Date.parse(rec.createdAt) > 20000) { await runRead(readId, rec.key); const now = await getDoc('invoiceReads', readId); return { ok: true, status: now.status, result: now.status === 'done' ? now.result : null, error: now.error || '' }; }
    return { ok: true, status: rec.status, result: rec.status === 'done' ? rec.result : null, error: rec.error || '' };
  }
};

const handleRequest = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-invoice failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};
export const handler = withGroup(handleRequest);
