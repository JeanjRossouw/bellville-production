// Retail POS — the client-message schedule: every five minutes, for every company that switched automatic
// messages on and gave its keys, send the update due on each custom order and sales order whose status or
// expected date moved (lib/notify.mjs). Nothing goes out for a company that has not switched it on.
import { json, query, getDoc, nowIso, allGroups, inGroup, groupStanding } from './lib/pos.mjs';
import { notifyCfg, sendDueFor, secretsOf } from './lib/notify.mjs';

export const config = { schedule: '*/5 * * * *' };

// This repo deploys to more than one site; the schedule only works where the Firestore key is set.
export const handler = async () => {
  if (!process.env.FACTORY_SERVICE_ACCOUNT) return json(200, { ok: true, skipped: 'FACTORY_SERVICE_ACCOUNT is not set on this site: nothing to do here' });
  try {
    const started = Date.now();
    const out = [];
    for (const gid of await allGroups()) await inGroup(gid, async () => {
      if ((await groupStanding(gid)).state === 'locked') return;      // a business that has not paid sends nothing
      const ents = (await query('entities', [], 50)).filter(e => e.active !== false);
      for (const e of ents) {
        const settings = (await getDoc('settings', e.id)) || {};
        if (!notifyCfg(settings).auto) continue;
        const secrets = await secretsOf(e.id); if (!secrets) continue;
        const r = await sendDueFor({ ...e, id: e.id }, settings, secrets, { deadline: started + 20000 });
        if (r.sent || r.left) out.push(`${gid}/${e.id}: ${r.sent} sent, ${r.left} left for a person`);
      }
    });
    return json(200, { ok: true, at: nowIso(), done: out });
  } catch (e) {
    console.error('pos-notify-sweep failed:', e);
    return json(500, { ok: false, error: String(e.message).slice(0, 300) });
  }
};
