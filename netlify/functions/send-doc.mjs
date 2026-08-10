// Email a shared document link to a customer.
//
//   POST /.netlify/functions/send-doc   (Authorization: Bearer <firebase id token>)
//   body: { to, subject, heading, intro, url, company: { name, lines[] } }
//
// Env: RESEND_API_KEY  — from https://resend.com (free tier covers a shop's volume)
//      MAIL_FROM       — e.g. "ReptiCube <accounts@repticube.co.za>"; the domain
//                        must be verified in Resend or delivery will be rejected.
//
// Without RESEND_API_KEY this returns 503 with a plain message, and the till
// falls back to the WhatsApp share or copy-link — sending is the only part
// that stops working.
import { requireUser } from './lib/auth.mjs';

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

function emailHtml({ heading, intro, url, company }) {
  const lines = (company && Array.isArray(company.lines) ? company.lines : []).map(esc).join('<br>');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16191d">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e7eb;border-radius:10px;padding:28px">
    <h1 style="margin:0 0 4px;font-size:19px">${esc((company && company.name) || '')}</h1>
    ${lines ? `<div style="color:#5c6570;font-size:12px;line-height:1.5;margin-bottom:18px">${lines}</div>` : ''}
    <h2 style="margin:18px 0 10px;font-size:17px">${esc(heading || 'Your document')}</h2>
    <p style="margin:0 0 20px;line-height:1.55">${esc(intro || '')}</p>
    <p style="margin:0 0 22px">
      <a href="${esc(url)}" style="display:inline-block;background:#16191d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:7px;font-weight:600">View your document</a>
    </p>
    <p style="margin:0 0 6px;color:#5c6570;font-size:13px">You can ask us for an update on that page at any time — no need to phone.</p>
    <p style="margin:0;color:#98a0a8;font-size:12px;word-break:break-all">${esc(url)}</p>
  </div></body></html>`;
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  try {
    await requireUser(event);
  } catch (e) {
    return json(401, { error: 'Unauthorized: ' + e.message });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return json(503, { error: 'Email is not set up yet — add RESEND_API_KEY in Netlify. Use WhatsApp or copy the link for now.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  if (!isEmail(body.to)) return json(400, { error: 'That customer has no valid email address.' });
  if (!/^https?:\/\//.test(String(body.url || ''))) return json(400, { error: 'Missing document link' });

  const from = process.env.MAIL_FROM || 'onboarding@resend.dev';
  const text = `${body.heading || 'Your document'}\n\n${body.intro || ''}\n\n${body.url}\n\nYou can ask us for an update on that page at any time.`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [String(body.to).trim()],
        subject: String(body.subject || body.heading || 'Your document').slice(0, 200),
        html: emailHtml(body),
        text
      })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return json(502, { error: out.message || `Email provider returned ${res.status}` });
    return json(200, { ok: true, id: out.id || null });
  } catch (e) {
    return json(502, { error: 'Could not reach the email provider: ' + e.message });
  }
};
