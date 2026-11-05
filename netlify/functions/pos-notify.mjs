// Retail POS — automatic client messages: the company's keys and choices (Admin → Settings → Client messages),
// a test message, the board's "send now". The sending itself is lib/notify.mjs; the schedule is pos-notify-sweep.
//
//   setup   { entityId, auto, channels, from, whatsappTemplate, whatsappLang, bulksmsTokenId?, bulksmsTokenSecret?, resendApiKey?, whatsappToken?, whatsappPhoneId?, siteUrl }
//           the owner: keys given are kept on the server (notifySecrets/<entityId>) and never shown again; a blank key keeps the one already there
//   forget  { entityId }                                  the owner: the keys removed, automatic messages off
//   status  { entityId }                                  a manager: what is set up, what is due and what could not be sent
//   test    { entityId, channel, phone?, email? }         the owner: one test message, so the keys are proven before the first client gets one
//   send    { entityId, coll: 'specialOrders'|'salesOrders', id }   a manager: this one now, by the automatic channel
import { json, Reject, clean, nowIso, getDoc, patchDoc, createDoc, deleteDoc, query, bodyOf, audit, withGroup, requireMember, inEntity, atLeast } from './lib/pos.mjs';
import { notifyCfg, channelReady, sendDue, sendSms, sendEmail, sendWhatsApp, e164, NOTIFY_CHANNELS, secretsOf } from './lib/notify.mjs';

async function who(event, b, minRole = 'manager') {
  const { user } = await requireMember(event);
  const entityId = clean(b.entityId, 40);
  if (!entityId || !inEntity(user, entityId)) throw new Reject(403, 'Not your company.');
  if (!atLeast(user, minRole)) throw new Reject(403, `This needs ${minRole === 'owner' ? 'the owner' : 'a manager'}.`);
  const entity = await getDoc('entities', entityId); if (!entity) throw new Reject(404, 'No such company.');
  return { user, entityId, entity: { ...entity, id: entityId }, settings: (await getDoc('settings', entityId)) || {} };
}
const siteOf = (event, b) => {
  const given = clean(b.siteUrl, 200);
  if (/^https?:\/\/[^\s/]+$/.test(given)) return given;
  const h = (event && event.headers) || {}; const host = h['x-forwarded-host'] || h.host || '';
  return host ? (/^(localhost|127\.)/.test(host) ? 'http' : 'https') + '://' + host : '';
};

const actions = {
  async setup(event, b) {
    const w = await who(event, b, 'owner');
    const had = (await secretsOf(w.entityId)) || {};
    const keys = {};
    for (const k of ['bulksmsTokenId', 'bulksmsTokenSecret', 'resendApiKey', 'whatsappToken', 'whatsappPhoneId']) { const v = clean(b[k], 400); keys[k] = v || had[k] || ''; }
    const channels = (Array.isArray(b.channels) ? b.channels : []).map(c => clean(c, 10)).filter(c => NOTIFY_CHANNELS.includes(c));
    const notify = { ...((w.settings.notify) || {}), auto: !!b.auto, channels: channels.length ? channels : ['sms', 'email'], from: clean(b.from, 160), whatsappTemplate: clean(b.whatsappTemplate, 120), whatsappLang: clean(b.whatsappLang, 10) || 'en', siteUrl: siteOf(event, b), updatedAt: nowIso() };
    const cfg = notifyCfg({ notify });
    notify.ready = channelReady(cfg, keys);
    if (notify.auto && !Object.values(notify.ready).some(Boolean)) throw new Reject(400, 'Automatic messages need at least one channel set up: BulkSMS keys, a Resend key with a sender address, or the WhatsApp keys with a template.');
    const now = nowIso();
    const hasKeys = Object.values(keys).some(Boolean);
    if (hasKeys) { if (Object.keys(had).length) await patchDoc('notifySecrets', w.entityId, { ...keys, updatedAt: now }); else await createDoc('notifySecrets', w.entityId, { ...keys, entityId: w.entityId, storeId: '', createdBy: w.user.id, createdAt: now, deviceId: 'office' }); }
    await patchDoc('settings', w.entityId, { notify });
    await audit({ action: 'notify.setup', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { auto: notify.auto, channels: notify.channels, ready: notify.ready }, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true, notify };
  },
  async forget(event, b) {
    const w = await who(event, b, 'owner');
    await deleteDoc('notifySecrets', w.entityId).catch(() => {});
    const notify = { ...((w.settings.notify) || {}), auto: false, ready: { sms: false, email: false, whatsapp: false }, updatedAt: nowIso() };
    await patchDoc('settings', w.entityId, { notify });
    await audit({ action: 'notify.forget', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: {}, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true, notify };
  },
  async status(event, b) {
    const w = await who(event, b);
    const cfg = notifyCfg(w.settings);
    const secrets = await secretsOf(w.entityId);
    const due = [];
    for (const coll of ['specialOrders', 'salesOrders']) for (const d of await query(coll, [{ field: 'entityId', value: w.entityId }, { field: 'updateDue', value: true }], 200)) if (d.status !== 'quoted') due.push({ coll, id: d.id, docNo: d.docNo, status: d.status, error: d.notifyError || '', tries: d.notifyTries || 0, customer: (d.customerSnapshot || {}).name || '' });
    return { ok: true, auto: cfg.auto, channels: cfg.channels, from: cfg.from, whatsappTemplate: cfg.whatsappTemplate, whatsappLang: cfg.whatsappLang, siteUrl: cfg.siteUrl, ready: channelReady(cfg, secrets), hasKeys: !!secrets, due: due.length, failed: due.filter(x => x.error).length, rows: due.slice(0, 50) };
  },
  async test(event, b) {
    const w = await who(event, b, 'owner');
    const cfg = notifyCfg(w.settings);
    const secrets = await secretsOf(w.entityId);
    const ch = clean(b.channel, 10);
    if (!NOTIFY_CHANNELS.includes(ch)) throw new Reject(400, 'Which channel?');
    if (!channelReady(cfg, secrets)[ch]) throw new Reject(400, `${ch} is not set up yet: save the keys first.`);
    const co = w.entity.tradingName || w.entity.legalName;
    const text = `Hi, ${co} here. This is a test of the automatic order updates from the till. If you can read this, the ${ch === 'sms' ? 'SMS' : ch === 'email' ? 'email' : 'WhatsApp'} channel works.`;
    const phone = e164(b.phone || w.user.phone), email = clean(b.email || w.user.email, 160);
    try {
      let r;
      if (ch === 'sms') { if (!phone) throw new Reject(400, 'A cell number to send the test to.'); r = await sendSms(secrets, phone, text); }
      else if (ch === 'email') { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Reject(400, 'An email address to send the test to.'); r = await sendEmail(secrets, cfg.from, email, co + ': a test from the till', text); }
      else { if (!phone) throw new Reject(400, 'A cell number to send the test to.'); r = await sendWhatsApp(secrets, cfg, phone, ['there', 'TEST', text, cfg.siteUrl || '']); }
      await audit({ action: 'notify.test', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: { channel: ch, to: ch === 'email' ? email : phone, providerId: r.id || '' }, entityId: w.entityId, storeId: '', deviceId: 'office' });
      return { ok: true, channel: ch, to: ch === 'email' ? email : phone, providerId: r.id || '' };
    } catch (e) { if (e instanceof Reject) throw e; throw new Reject(502, `${ch === 'sms' ? 'BulkSMS' : ch === 'email' ? 'Resend' : 'WhatsApp'} said no: ${String(e.message).slice(0, 200)}`); }
  },
  async send(event, b) {
    const w = await who(event, b);
    const coll = b.coll === 'salesOrders' ? 'salesOrders' : 'specialOrders';
    const id = clean(b.id, 80);
    const doc = await getDoc(coll, id);
    if (!doc || doc.entityId !== w.entityId) throw new Reject(404, 'No such order.');
    if (doc.status === 'quoted') throw new Reject(409, 'A quoted order gets no update until the deposit is paid.');
    const secrets = await secretsOf(w.entityId);
    if (!secrets) throw new Reject(400, 'No keys yet: set up client messages under Admin → Settings.');
    const store = (await getDoc('stores', doc.storeId)) || { id: doc.storeId, name: doc.storeId };
    const r = await sendDue(coll, { ...doc, id, notifyTries: 0 }, { entity: w.entity, store, settings: w.settings, secrets });
    if (!r.sent) throw new Reject(502, r.why);
    return { ok: true, ...r };
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
    console.error('pos-notify failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};
export const handler = withGroup(handleRequest);
