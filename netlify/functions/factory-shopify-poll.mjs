// Every 15 minutes: bring in any online orders the Shopify webhooks missed,
// for every company that has connected a shop. See factory-shopify.mjs.
import { listDocs } from './lib/factory-firestore.mjs';
import { syncCompany } from './factory-shopify.mjs';

export const config = { schedule: '*/15 * * * *' };

export const handler = async () => {
  const started = Date.now();
  const links = await listDocs('shopifyLinks');
  const out = [];
  for (const l of links) {
    if (Date.now() - started > 22000) { out.push({ cid: l.id, skipped: 'out of time, next run' }); continue; }
    try { out.push(await syncCompany(l.id, { budgetMs: 6000 })); }
    catch (e) { out.push({ cid: l.id, error: e.message }); }
  }
  console.log('factory-shopify-poll:', JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
