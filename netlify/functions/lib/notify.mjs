// Retail POS — automatic client messages on custom orders and sales orders.
//
// A status that moves (at the till or at the factory), a date the factory moves, a booking, a dispatch or a
// cancellation sets `updateDue` on the document. Where the company has switched automatic messages on
// (settings/<entityId>.notify.auto) and given the keys (notifySecrets/<entityId>, server only), the schedule
// (pos-notify-sweep, every five minutes) sends the same text the WhatsApp button would, by the first channel
// that can reach the customer, and logs it on the document as an update by "Automatic". Where nothing can
// reach them, or the provider refuses, the document keeps `updateDue` with `notifyError`, and the To do board
// shows it for a person to send by hand.
//
// Channels and providers (one HTTPS call each, no SDK):
//   sms       BulkSMS       https://api.bulksms.com/v1/messages       Basic  tokenId:tokenSecret
//   email     Resend        https://api.resend.com/emails             Bearer apiKey; `from` is a verified sender
//   whatsapp  Meta Cloud    https://graph.facebook.com/v21.0/<phoneId>/messages   Bearer token; an approved
//             template with four body parameters: {{1}} name, {{2}} order number, {{3}} the message, {{4}} the link
// In the tests NOTIFY_SINK points every provider at the test server, which keeps what was posted.
import { getDoc, patchDoc, query, audit, nowIso } from './pos.mjs';
import { ensureTrack } from './track.mjs';
import { updateText, salesOrderText, STATUS_LABEL, SALES_LABEL } from '../../../pos/js/special-terms.js';

export const NOTIFY_CHANNELS = ['sms', 'email', 'whatsapp'];
export const CHANNEL_LABEL = { sms: 'SMS', email: 'email', whatsapp: 'WhatsApp' };
// the company's choices, as settings/<entityId>.notify keeps them
export const notifyCfg = (settings) => {
  const n = (settings && settings.notify) || {};
  const channels = (Array.isArray(n.channels) ? n.channels : []).filter(c => NOTIFY_CHANNELS.includes(c));
  return { auto: !!n.auto, channels: channels.length ? channels : ['sms', 'email'], from: String(n.from || ''), siteUrl: String(n.siteUrl || ''), whatsappTemplate: String(n.whatsappTemplate || ''), whatsappLang: String(n.whatsappLang || 'en'), ready: n.ready || {} };
};
// a South African cell number as the providers want it: +27821234567
export const e164 = (phone) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = '27' + d.slice(1);
  else if (d.length === 9 && /^[1-9]/.test(d)) d = '27' + d;
  return d.length >= 10 && d.length <= 15 ? '+' + d : '';
};
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const base = (real) => process.env.NOTIFY_SINK ? process.env.NOTIFY_SINK.replace(/\/$/, '') : real;
async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { return {}; }
}
// what each channel needs from the secrets
export const channelReady = (cfg, s) => ({
  sms: !!(s && s.bulksmsTokenId && s.bulksmsTokenSecret),
  email: !!(s && s.resendApiKey && emailOk((cfg.from.match(/<([^>]+)>/) || [])[1] || cfg.from)),
  whatsapp: !!(s && s.whatsappToken && s.whatsappPhoneId && cfg.whatsappTemplate)
});

export async function sendSms(secrets, to, text) {
  const r = await post(base('https://api.bulksms.com') + '/v1/messages', { Authorization: 'Basic ' + Buffer.from(secrets.bulksmsTokenId + ':' + secrets.bulksmsTokenSecret).toString('base64') }, { to, body: text, longMessageMaxParts: 5 });
  return { id: String((Array.isArray(r) && r[0] && r[0].id) || '') };
}
export async function sendEmail(secrets, from, to, subject, text) {
  const r = await post(base('https://api.resend.com') + '/emails', { Authorization: 'Bearer ' + secrets.resendApiKey }, { from, to: [to], subject, text });
  return { id: String(r.id || '') };
}
export async function sendWhatsApp(secrets, cfg, to, params) {
  const r = await post(base('https://graph.facebook.com') + '/v21.0/' + encodeURIComponent(secrets.whatsappPhoneId) + '/messages', { Authorization: 'Bearer ' + secrets.whatsappToken },
    { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template', template: { name: cfg.whatsappTemplate, language: { code: cfg.whatsappLang || 'en' }, components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).replace(/\s*\n+\s*/g, ' ').slice(0, 1000) })) }] } });
  return { id: String((r.messages && r.messages[0] && r.messages[0].id) || '') };
}

// the message for a document as it stands: the status text, or the moved date when that is what changed
export function messageFor(coll, entity, store, doc) {
  const sales = coll === 'salesOrders';
  const reason = doc.updateReason === 'eta' ? 'eta' : 'status';
  const status = doc.status;
  const label = reason === 'eta' ? 'new expected date' : (sales ? SALES_LABEL[status] : STATUS_LABEL[status]) || status;
  const text = sales ? salesOrderText(entity, store, doc, reason === 'eta' ? 'eta' : status) : updateText(entity, store, doc, reason === 'eta' ? 'eta' : status);
  return { status, reason, text, subject: `${entity.tradingName || entity.legalName}: your order ${doc.docNo} · ${label}` };
}
// the customer's own choice first, then the company's order; 'none' means no automatic message at all
export function channelsFor(cfg, customer) {
  const pref = customer && NOTIFY_CHANNELS.includes(customer.notifyBy) ? customer.notifyBy : '';
  if (customer && customer.notifyBy === 'none') return [];
  return pref ? [pref, ...cfg.channels.filter(c => c !== pref)] : cfg.channels;
}

// one message for one document, by the first channel that is set up and can reach the customer
export async function sendOne({ coll, doc, entity, store, cfg, secrets, customer, link }) {
  const ready = channelReady(cfg, secrets);
  const snap = doc.customerSnapshot || {};
  const phone = e164((customer && customer.phone) || snap.phone), email = emailOk((customer && customer.email) || snap.email) ? ((customer && customer.email) || snap.email) : '';
  const m = messageFor(coll, entity, store, doc);
  const full = m.text + (link ? '\n\nYour order, any time: ' + link : '');
  const tried = [];
  for (const ch of channelsFor(cfg, customer)) {
    if (!ready[ch]) continue;
    if (ch === 'sms' && !phone) { tried.push('SMS: no cell number'); continue; }
    if (ch === 'whatsapp' && !phone) { tried.push('WhatsApp: no cell number'); continue; }
    if (ch === 'email' && !email) { tried.push('email: no address'); continue; }
    try {
      const r = ch === 'sms' ? await sendSms(secrets, phone, full)
        : ch === 'email' ? await sendEmail(secrets, cfg.from, email, m.subject, full)
        : await sendWhatsApp(secrets, cfg, phone, [snap.name || (customer && customer.name) || 'there', doc.docNo, m.text, link || '']);
      return { ok: true, how: ch, to: ch === 'email' ? email : phone, status: m.status, reason: m.reason, text: full, providerId: r.id };
    } catch (e) { tried.push(`${CHANNEL_LABEL[ch]}: ${String(e.message).slice(0, 160)}`); }
  }
  const why = tried.length ? tried.join('; ') : (customer && customer.notifyBy === 'none' ? 'the customer asked for no automatic messages' : 'no channel is set up for this customer');
  return { ok: false, why, status: m.status, reason: m.reason, text: full };
}

// the link for the client's page, on the site the company set up messages from
const linkFor = async (coll, doc, cfg) => {
  if (coll !== 'specialOrders' || !cfg.siteUrl) return '';
  try { return cfg.siteUrl.replace(/\/$/, '') + '/pos/track.html?t=' + (await ensureTrack('order', doc)); } catch (e) { return ''; }
};
export const GIVE_UP_AFTER = 5;
// a document with an update due: sent and logged, or left for a person with the reason
export async function sendDue(coll, doc, { entity, store, settings, secrets }) {
  const cfg = notifyCfg(settings);
  const customer = doc.customerId ? await getDoc('customers', doc.customerId) : null;
  const link = await linkFor(coll, doc, cfg);
  const r = await sendOne({ coll, doc, entity, store, cfg, secrets, customer, link });
  const now = nowIso();
  const docType = coll === 'salesOrders' ? 'salesOrder' : 'specialOrder';
  if (r.ok) {
    const entry = { at: now, status: r.status, how: r.how, byName: 'Automatic', to: r.to, auto: true, ...(r.reason === 'eta' ? { reason: 'eta' } : {}) };
    await patchDoc(coll, doc.id, { updates: [...(doc.updates || []), entry].slice(-50), updateDue: false, updateReason: '', notifyError: '', notifyTries: 0, lastUpdateAt: now, updatedAt: now });
    await audit({ action: docType + '.update', docType, docId: doc.id, docNo: doc.docNo, actorUid: 'auto', actorName: 'Automatic', details: { status: r.status, how: r.how, to: r.to, reason: r.reason, providerId: r.providerId || '' }, entityId: doc.entityId, storeId: doc.storeId, deviceId: 'schedule' });
    return { sent: true, how: r.how, to: r.to };
  }
  const tries = (doc.notifyTries || 0) + 1;
  await patchDoc(coll, doc.id, { notifyError: (tries >= GIVE_UP_AFTER ? 'Not sent automatically: ' : 'Not sent yet: ') + r.why, notifyTries: tries, updatedAt: now });
  return { sent: false, why: r.why, tries };
}
// every document of the company with an update due (the schedule, and "send now" on the board)
export async function sendDueFor(entity, settings, secrets, { limit = 50, deadline = 0 } = {}) {
  const out = { sent: 0, left: 0, docs: [] };
  const stores = new Map();
  const storeOf = async (id) => { if (!stores.has(id)) stores.set(id, (await getDoc('stores', id)) || { id, name: id }); return stores.get(id); };
  for (const coll of ['specialOrders', 'salesOrders']) {
    const rows = await query(coll, [{ field: 'entityId', value: entity.id }, { field: 'updateDue', value: true }], limit);
    for (const doc of rows) {
      if (deadline && Date.now() > deadline) return out;
      if (doc.status === 'quoted' || (doc.notifyTries || 0) >= GIVE_UP_AFTER) { out.left++; continue; }
      try {
        const r = await sendDue(coll, doc, { entity, store: await storeOf(doc.storeId), settings, secrets });
        if (r.sent) out.sent++; else out.left++;
        out.docs.push({ coll, id: doc.id, docNo: doc.docNo, ...r });
      } catch (e) { out.left++; console.error('notify', doc.docNo, e.message); }
    }
  }
  return out;
}
export const secretsOf = (entityId) => getDoc('notifySecrets', entityId);
