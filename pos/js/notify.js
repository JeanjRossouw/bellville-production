// Retail POS — automatic client messages (Admin → Settings → Client messages; the owner sets it up, a manager
// sees what is due). The server (pos-notify, pos-notify-sweep) sends an order's update by SMS, email or
// WhatsApp when its status or expected date moves, and keeps the keys; the board and the order pages use
// `autoPending` to say "going automatically" instead of asking a person to tap WhatsApp.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, val } from './ui.js';

export const CHANNELS = [['sms', 'SMS (BulkSMS)'], ['email', 'Email (Resend)'], ['whatsapp', 'WhatsApp (Meta Cloud API)']];
// the message for this order goes by itself: automatic is on and nothing has failed yet
export const autoOn = (settings) => !!(((settings || {}).notify || {}).auto);
export const autoPending = (settings, o) => autoOn(settings) && !!o.updateDue && o.status !== 'quoted' && !o.notifyError;
// the chip on an order with an update due
export const dueChip = (settings, o) => !o.updateDue || o.status === 'quoted' ? '' : o.notifyError ? `<span class="chip late" title="${esc(o.notifyError)}">update to send</span>` : autoOn(settings) ? '<span class="chip" title="The server sends it within five minutes">update going automatically</span>' : '<span class="chip late">update to send</span>';

export async function notifyCard(host, entityId) {
  const el = host.querySelector('#se-notify'); if (!el) return;
  let st;
  try { st = await auth.api('status', { entityId }, API.notify); } catch (e) { el.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const owner = auth.session.user.role === 'owner';
  const ready = st.ready || {};
  const chan = (k) => ready[k] ? '<span class="chip ok">set up</span>' : '<span class="chip off">not set up</span>';
  el.innerHTML = `<p>${st.auto ? '<strong>On.</strong> An order whose status or expected date moves gets its message within five minutes' : '<strong>Off.</strong> Updates are sent by a person tapping WhatsApp on the order'}${st.due ? ` · <strong>${st.due}</strong> due now${st.failed ? `, <span class="warn">${st.failed} could not be sent</span>` : ''}` : ''}.</p>
    <div class="grid three"><div>SMS ${chan('sms')}</div><div>Email ${chan('email')}</div><div>WhatsApp ${chan('whatsapp')}</div></div>
    ${st.rows && st.rows.filter(r => r.error).length ? `<ul class="muted">${st.rows.filter(r => r.error).slice(0, 8).map(r => `<li><strong>${esc(r.docNo)}</strong> ${esc(r.customer)}: ${esc(r.error)}</li>`).join('')}</ul>` : ''}
    ${owner ? `
    <label class="chk"><input type="checkbox" id="nt-auto"${st.auto ? ' checked' : ''}> Send order updates automatically</label>
    <div class="fld"><span>Try in this order (the customer's own choice on their profile comes first)</span><div class="btn-row">${CHANNELS.map(([k, l]) => `<label class="chk"><input type="checkbox" data-ntch="${k}"${(st.channels || []).includes(k) ? ' checked' : ''}> ${l}</label>`).join('')}</div></div>
    <h3>BulkSMS</h3><p class="muted">bulksms.com → Settings → Advanced → API tokens. SMS reaches any cell number; a long update goes as one message.</p>
    <div class="grid two">${field('Token ID', 'nt-sms-id', { autocomplete: 'off', placeholder: ready.sms ? 'kept on the server' : '' })}${field('Token secret', 'nt-sms-secret', { type: 'password', autocomplete: 'new-password', placeholder: ready.sms ? 'kept on the server' : '' })}</div>
    <h3>Email</h3><p class="muted">resend.com → API keys, with your domain verified there. The sender is shown to the customer.</p>
    <div class="grid two">${field('Resend API key', 'nt-email-key', { type: 'password', autocomplete: 'new-password', placeholder: ready.email ? 'kept on the server' : '' })}${field('Sender', 'nt-from', { value: st.from || '', placeholder: 'Bellville Furniture <orders@yourdomain.co.za>' })}</div>
    <h3>WhatsApp</h3><p class="muted">Meta's WhatsApp Business Platform: a phone number ID and a permanent token, and a message template approved by Meta with four body parameters: {{1}} the customer's name, {{2}} the order number, {{3}} the update, {{4}} the link to their order page.</p>
    <div class="grid two">${field('Phone number ID', 'nt-wa-phone', { autocomplete: 'off', placeholder: ready.whatsapp ? 'kept on the server' : '' })}${field('Permanent token', 'nt-wa-token', { type: 'password', autocomplete: 'new-password', placeholder: ready.whatsapp ? 'kept on the server' : '' })}</div>
    <div class="grid two">${field('Template name', 'nt-wa-template', { value: st.whatsappTemplate || '', placeholder: 'order_update' })}${field('Template language', 'nt-wa-lang', { value: st.whatsappLang || 'en' })}</div>
    <p class="muted">The keys are kept on the server and never shown again; a blank box keeps the key already there. The customer's order page is linked from the site you are on now${st.siteUrl ? ' (' + esc(st.siteUrl) + ')' : ''}.</p>
    <div class="card-actions"><button class="btn primary" data-act="nt-save">Save client messages</button>
      <button class="btn ghost" data-act="nt-test" data-ch="sms">Test SMS to me</button><button class="btn ghost" data-act="nt-test" data-ch="email">Test email to me</button><button class="btn ghost" data-act="nt-test" data-ch="whatsapp">Test WhatsApp to me</button>
      ${st.hasKeys ? '<button class="btn ghost" data-act="nt-forget">Remove the keys</button>' : ''}</div>
    <div class="grid two">${field('Cell number for the tests', 'nt-test-phone', { value: auth.session.user.phone || '', inputmode: 'tel' })}${field('Email for the tests', 'nt-test-email', { value: auth.session.user.email || '', type: 'email' })}</div>` : ''}`;
  if (el.dataset.wired) return;
  el.dataset.wired = '1';
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; e.preventDefault();
    const act = b.dataset.act;
    try {
      if (act === 'nt-save') {
        const body = { entityId, auto: !!el.querySelector('#nt-auto').checked, channels: [...el.querySelectorAll('[data-ntch]')].filter(x => x.checked).map(x => x.dataset.ntch), from: val(el, 'nt-from'), whatsappTemplate: val(el, 'nt-wa-template'), whatsappLang: val(el, 'nt-wa-lang'), bulksmsTokenId: val(el, 'nt-sms-id'), bulksmsTokenSecret: val(el, 'nt-sms-secret'), resendApiKey: val(el, 'nt-email-key'), whatsappToken: val(el, 'nt-wa-token'), whatsappPhoneId: val(el, 'nt-wa-phone'), siteUrl: location.origin };
        const r = await auth.api('setup', body, API.notify);
        toast(r.notify.auto ? 'Automatic client messages are on' : 'Saved: automatic messages are off');
      } else if (act === 'nt-test') {
        b.disabled = true;
        try { const r = await auth.api('test', { entityId, channel: b.dataset.ch, phone: val(el, 'nt-test-phone'), email: val(el, 'nt-test-email') }, API.notify); toast('Test sent to ' + r.to); } finally { b.disabled = false; }
        return;
      } else if (act === 'nt-forget') {
        if (!confirm('Remove the SMS, email and WhatsApp keys and switch automatic messages off?')) return;
        await auth.api('forget', { entityId }, API.notify); toast('Keys removed: updates go by hand again');
      } else return;
    } catch (err) { toast(err.message, 'warn'); }
    notifyCard(host, entityId);
  });
}
// the board's "send now": the automatic channel, for one order (a manager)
export async function sendNow(entityId, coll, id) {
  const r = await auth.api('send', { entityId, coll, id }, API.notify);
  toast(`Sent by ${r.how} to ${r.to}`);
  return r;
}
