// Retail POS — the Shopify schedule: every ten minutes, for every company
// connected, push the stock still queued (with its back-off), pull the
// discount codes and push customers who said yes to marketing.
import { json, query, nowIso, allGroups, inGroup, groupStanding } from './lib/pos.mjs';
import { secretsOf, settingsOf, flushStock, logSync } from './lib/shopify-pos.mjs';

export const config = { schedule: '*/10 * * * *' };

// This repo deploys to more than one site; the schedule only works where the factory key is set.
export const handler = async (event) => {
  if (!process.env.FACTORY_SERVICE_ACCOUNT) return json(200, { ok: true, skipped: 'FACTORY_SERVICE_ACCOUNT is not set on this site: nothing to do here' });
  try {
    const out = [];
    // every customer's space in turn (lib/pos.mjs)
    for (const gid of await allGroups()) await inGroup(gid, async () => {
    if ((await groupStanding(gid)).state === 'locked') return;      // a business that has not paid gets no syncing
    const ents = (await query('entities', [], 50)).filter(e => e.active !== false);
    for (const e of ents) {
      const cfg = await secretsOf(e.id).catch(() => null); if (!cfg) continue;
      const sh = await settingsOf(e.id); if (!sh.connected) continue;
      try {
        const r = await flushStock(e.id, { budgetMs: 8000, max: 150 });
        out.push(`${e.id}: stock ${r.pushed || 0} pushed, ${r.failed || 0} failed, ${r.left || 0} left`);
      } catch (err) { out.push(`${e.id}: ${err.message}`); await logSync(e.id, 'stock', 'failed', err.message); }
    }
    });
    return json(200, { ok: true, at: nowIso(), done: out });
  } catch (e) {
    console.error('pos-shopify-sync failed:', e);
    return json(500, { ok: false, error: String(e.message).slice(0, 300) });
  }
};
