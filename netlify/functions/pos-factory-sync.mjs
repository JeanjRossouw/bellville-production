// Retail POS — the factory schedule: every ten minutes, for every company
// linked to a Factory Manager company, read the factory's status back on the
// open orders that are at the factory, and try again a send that a person
// asked for and that failed. Nothing goes to the factory by itself: an order
// that nobody has sent stays at the till.
import { runsHere, notHere } from './lib/product.mjs';
import { json, query, getDoc, nowIso } from './lib/pos.mjs';
import { factoryCfg } from './lib/factory-link.mjs';
import { pushForSchedule, syncFromFactory } from './lib/factory-bridge.mjs';

export const config = { schedule: '*/10 * * * *' };
const WORK = [
  { coll: 'specialOrders', kind: 'custom', open: ['depositPaid', 'inProduction'], forward: { depositPaid: ['inProduction', 'ready'], inProduction: ['ready'] } },
  { coll: 'salesOrders', kind: 'sales', open: ['open', 'inProduction'], forward: { open: ['inProduction', 'ready'], inProduction: ['ready'] } }
];

// This repo deploys to more than one site; the schedule only works where the factory key is set.
export const handler = async (event) => {
  if (!runsHere('pos')) return notHere('pos');
  if (!process.env.FACTORY_SERVICE_ACCOUNT) return json(200, { ok: true, skipped: 'FACTORY_SERVICE_ACCOUNT is not set on this site: nothing to do here' });
  try {
    const started = Date.now();
    const ents = (await query('entities', [], 50)).filter(e => e.active !== false);
    const out = [];
    for (const e of ents) {
      const settings = (await getDoc('settings', e.id)) || {};
      const cfg = factoryCfg(settings); if (!cfg) continue;
      let sent = 0, synced = 0, moved = 0, failed = 0;
      for (const w of WORK) for (const status of w.open) {
        const rows = await query(w.coll, [{ field: 'entityId', value: e.id }, { field: 'status', value: status }], 300);
        for (const so of rows) {
          if (Date.now() - started > 20000) break;
          try {
            if (!so.factory || !so.factory.orders || !so.factory.orders.length) {
              if (!so.factory || !so.factory.requestedAt) continue;     // nobody has sent it: it stays at the till
              const r = await pushForSchedule(e, settings, w.coll, so, w.kind); if (r.factory && r.factory.error) failed++; else sent++; continue;
            }
            const r = await syncFromFactory(w.coll, so, w.forward); synced++; if (r.status !== so.status) moved++;
          } catch (err) { failed++; console.error('factory sync', so.docNo, err.message); }
        }
      }
      out.push(`${e.id} → ${cfg.companyName || cfg.companyId}: ${sent} sent, ${synced} checked, ${moved} moved on, ${failed} failed`);
    }
    return json(200, { ok: true, at: nowIso(), done: out });
  } catch (e) {
    console.error('pos-factory-sync failed:', e);
    return json(500, { ok: false, error: String(e.message).slice(0, 300) });
  }
};
