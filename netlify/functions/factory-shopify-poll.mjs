// Every 15 minutes: bring in any online orders the Shopify webhooks missed,
// for every company that has connected a shop. See factory-shopify.mjs.
import { runsHere, notHere } from './lib/product.mjs';
import { listDocs } from './lib/factory-firestore.mjs';
import { syncCompany } from './factory-shopify.mjs';

export const config = { schedule: '*/15 * * * *' };

export const handler = async () => {
  if (!runsHere('factory')) return notHere('factory');
  // this repo deploys to more than one site; the poll only works where the factory key is set
  if (!process.env.FACTORY_SERVICE_ACCOUNT && !process.env.COUCHPOTATO_SERVICE_ACCOUNT) return { statusCode: 200, body: JSON.stringify({ skipped: 'FACTORY_SERVICE_ACCOUNT is not set on this site: nothing to do here' }) };
  const started = Date.now();
  let links;
  try { links = await listDocs('shopifyLinks'); }
  catch (e) { console.error('factory-shopify-poll failed:', e); return { statusCode: 500, body: JSON.stringify({ error: String(e.message).slice(0, 300) }) }; }
  const out = [];
  for (const l of links) {
    if (Date.now() - started > 22000) { out.push({ cid: l.id, skipped: 'out of time, next run' }); continue; }
    try { out.push(await syncCompany(l.id, { budgetMs: 6000 })); }
    catch (e) { out.push({ cid: l.id, error: e.message }); }
  }
  console.log('factory-shopify-poll:', JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
