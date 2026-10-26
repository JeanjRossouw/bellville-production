// Retail POS — sending a document by email: a small window with the address, the subject and the message,
// and links the person taps themselves (so no browser blocks them): their email program (mailto), Gmail
// or Outlook on the web (for a PC with no email program set up), or copy the message to paste anywhere.
import { esc, toast, field, val, openModal } from './ui.js';

const enc = encodeURIComponent;
// the address as typed: '@' stays as it is (some programs take '%40' literally); several split by , or ;
const addrs = (s) => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
export const mailtoHref = (to, subject, body) => 'mailto:' + addrs(to).map(a => a.split('@').map(enc).join('@')).join(',') + '?subject=' + enc(subject) + '&body=' + enc(body);
const gmailHref = (to, subject, body) => 'https://mail.google.com/mail/?view=cm&fs=1&to=' + enc(addrs(to).join(',')) + '&su=' + enc(subject) + '&body=' + enc(body);
const outlookHref = (to, subject, body) => 'https://outlook.office.com/mail/deeplink/compose?to=' + enc(addrs(to).join(',')) + '&subject=' + enc(subject) + '&body=' + enc(body);

export function emailModal({ to = '', subject = '', text = '', title = 'Send by email', onSent } = {}) {
  const { wrap, close } = openModal(title, `
    ${field('To', 'em-to', { value: to, type: 'email', placeholder: 'name@example.co.za' })}
    ${field('Subject', 'em-subject', { value: subject })}
    ${field('Message', 'em-body', { type: 'textarea', rows: 5, value: text })}
    <div class="rc-acts em-acts">
      <a class="btn primary" id="em-mailto" href="#">Open in my email program</a>
      <a class="btn" id="em-gmail" href="#" target="_blank" rel="noopener">Gmail</a>
      <a class="btn" id="em-outlook" href="#" target="_blank" rel="noopener">Outlook</a>
      <button class="btn ghost" type="button" id="em-copy">Copy message</button>
    </div>
    <p class="muted">If nothing opens, the PC has no email program set up: use Gmail or Outlook, or copy the message into your email.</p>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
  const sync = () => {
    const t = val(wrap, 'em-to'), s = val(wrap, 'em-subject'), b = wrap.querySelector('#em-body').value;
    wrap.querySelector('#em-mailto').href = mailtoHref(t, s, b);
    wrap.querySelector('#em-gmail').href = gmailHref(t, s, b);
    wrap.querySelector('#em-outlook').href = outlookHref(t, s, b);
  };
  wrap.addEventListener('input', sync); sync();
  wrap.addEventListener('click', async (e) => {
    const a = e.target.closest('#em-mailto, #em-gmail, #em-outlook');
    if (a) { if (!addrs(val(wrap, 'em-to')).length) { e.preventDefault(); toast('The email address first.', 'warn'); wrap.querySelector('#em-to').focus(); return; } if (onSent) onSent(a.id.slice(3)); return; }
    if (e.target.id === 'em-copy') {
      const msg = val(wrap, 'em-subject') + '\n\n' + wrap.querySelector('#em-body').value;
      await navigator.clipboard.writeText(msg).then(() => toast('Message copied: paste it into your email'), () => toast('Could not copy: select the message and copy it', 'warn'));
    }
  });
  return { wrap, close };
}
