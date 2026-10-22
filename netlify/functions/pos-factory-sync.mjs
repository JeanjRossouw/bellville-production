// Retail POS — the factory schedule: every ten minutes, for every company
// linked to a Factory Manager company, send the custom orders that are not
// at the factory yet (a write failed, or the link was made after the
// deposit) and read the factory's status back on the open ones.
import { json, query, getDoc, nowIso } from './lib/pos.mjs';
import { factoryCfg } from './lib/factory-link.mjs';
import { pushForSchedule, syncFromFactory } from './pos-special.mjs';

export const config = { schedule: '*/10 * * * *' };

export const handler = async () => {
  const started = Date.now();
  const ents = (await query('entities', [], 50)).filter(e => e.active !== false);
  const out = [];
  for (const e of ents) {
    const settings = (await getDoc('settings', e.id)) || {};
    const cfg = factoryCfg(settings); if (!cfg) continue;
    let sent = 0, synced = 0, moved = 0, failed = 0;
    for (const status of ['depositPaid', 'inProduction']) {
      const rows = await query('specialOrders', [{ field: 'entityId', value: e.id }, { field: 'status', value: status }], 300);
      for (const so of rows) {
        if (Date.now() - started > 20000) break;
        try {
          if (!so.factory || !so.factory.orders || !so.factory.orders.length) { const r = await pushForSchedule(e, settings, so); if (r.factory && r.factory.error) failed++; else sent++; continue; }
          const r = await syncFromFactory(so); synced++; if (r.status !== so.status) moved++;
        } catch (err) { failed++; console.error('factory sync', so.docNo, err.message); }
      }
    }
    out.push(`${e.id} → ${cfg.companyName || cfg.companyId}: ${sent} sent, ${synced} checked, ${moved} moved on, ${failed} failed`);
  }
  return json(200, { ok: true, at: nowIso(), done: out });
};
