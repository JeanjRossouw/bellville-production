// Retail POS — the supplier invoice reader, in the background (a Netlify background function: it answers 202 at
// once and may run for minutes, which a long invoice needs). pos-invoice queues the read and calls this with the
// read's id, its business and the secret it was queued with; the result is kept on invoiceReads/<id>, which the
// till asks pos-invoice for.
//
//   POST { readId, g, key }
//
// Env: ANTHROPIC_API_KEY, FACTORY_SERVICE_ACCOUNT.
import { json, clean, inGroup, GROUP_RE } from './lib/pos.mjs';
import { runRead } from './lib/invoice-read.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let b = {}; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  const readId = clean(b.readId, 80), key = clean(b.key, 80), g = clean(b.g, 40);
  if (!readId || !key || (g && !GROUP_RE.test(g))) return json(400, { error: 'Bad request' });
  try { return json(200, await inGroup(g, () => runRead(readId, key))); }
  catch (e) { console.error('pos-invoice-read-background failed:', e); return json(500, { error: 'The read failed.' }); }
};
