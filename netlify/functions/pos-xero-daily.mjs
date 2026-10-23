// Retail POS — the Xero schedule, on its own so pos-xero can still answer
// HTTP: in the small hours, build yesterday's journal for every company
// that asked for it and post it when the company is connected.
import { json, query, getDoc, allGroups, inGroup, groupStanding } from './lib/pos.mjs';
import { loadTokens, connectBlobs } from './lib/xero.mjs';
import { buildDoc, pushDoc, xeroKey } from './pos-xero.mjs';

export const config = { schedule: '30 1 * * *' };   // 01:30 UTC = 03:30 in South Africa

// This repo deploys to more than one site; the schedule only works where the factory key is set.
export const handler = async (event) => {
  if (!process.env.FACTORY_SERVICE_ACCOUNT) return json(200, { ok: true, skipped: 'FACTORY_SERVICE_ACCOUNT is not set on this site: nothing to do here' });
  try {
    connectBlobs(event);
    const day = new Date(Date.now() - 86400000 + 2 * 3600000).toISOString().slice(0, 10);
    const out = [];
    // every customer's space in turn (lib/pos.mjs)
    for (const gid of await allGroups()) await inGroup(gid, async () => {
    if ((await groupStanding(gid)).state === 'locked') return;      // a business that has not paid gets no syncing
    const ents = (await query('entities', [], 50)).filter(e => e.active !== false);
    for (const e of ents) {
      const s = (await getDoc('settings', e.id)) || {};
      if (!(s.xero || {}).autoDaily) continue;
      try { const j = await buildDoc(e.id, day); if (j.lines.length && !j.unbalanced && (await loadTokens(xeroKey(e.id)).catch(() => null))) await pushDoc(e.id, day, 'schedule'); out.push(e.id + ': ' + (j.lines.length ? 'built' : 'empty')); }
      catch (err) { out.push(e.id + ': ' + err.message); console.error('pos-xero-daily', e.id, err); }
    }
    });
    return json(200, { ok: true, day, done: out });
  } catch (e) {
    console.error('pos-xero-daily failed:', e);
    return json(500, { ok: false, error: String(e.message).slice(0, 300) });
  }
};
