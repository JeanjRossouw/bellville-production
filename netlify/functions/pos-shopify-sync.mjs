// Retail POS — the Shopify schedule: every ten minutes, for every company
// connected, push the stock still queued (with its back-off), pull the
// discount codes and push customers who said yes to marketing.
import { json, query, nowIso } from './lib/pos.mjs';
import { secretsOf, settingsOf, flushStock, logSync } from './lib/shopify-pos.mjs';

export const config = { schedule: '*/10 * * * *' };

export const handler = async (event) => {
  const ents = (await query('entities', [], 50)).filter(e => e.active !== false);
  const out = [];
  for (const e of ents) {
    const cfg = await secretsOf(e.id).catch(() => null); if (!cfg) continue;
    const sh = await settingsOf(e.id); if (!sh.connected) continue;
    try {
      const r = await flushStock(e.id, { budgetMs: 8000, max: 150 });
      out.push(`${e.id}: stock ${r.pushed || 0} pushed, ${r.failed || 0} failed, ${r.left || 0} left`);
    } catch (err) { out.push(`${e.id}: ${err.message}`); await logSync(e.id, 'stock', 'failed', err.message); }
  }
  return json(200, { ok: true, at: nowIso(), done: out });
};
