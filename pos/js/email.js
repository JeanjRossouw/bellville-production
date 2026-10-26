// Retail POS — sending a document by email: a small window with the address, the subject and the message,
// and links the person taps themselves (so no browser blocks them): their email program (mailto), Gmail
// or Outlook on the web (for a PC with no email program set up), or copy the message to paste anywhere.
// A document can come with a file to save and attach (an email link cannot attach it by itself).
import { esc, toast, field, val, openModal } from './ui.js';

const enc = encodeURIComponent;
// the address as typed: '@' stays as it is (some programs take '%40' literally); several split by , or ;
const addrs = (s) => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
export const mailtoHref = (to, subject, body) => 'mailto:' + addrs(to).map(a => a.split('@').map(enc).join('@')).join(',') + '?subject=' + enc(subject) + '&body=' + enc(body);
const gmailHref = (to, subject, body) => 'https://mail.google.com/mail/?view=cm&fs=1&to=' + enc(addrs(to).join(',')) + '&su=' + enc(subject) + '&body=' + enc(body);
const outlookHref = (to, subject, body) => 'https://outlook.office.com/mail/deeplink/compose?to=' + enc(addrs(to).join(',')) + '&subject=' + enc(subject) + '&body=' + enc(body);

// file: { label, name, type, make() → bytes or text } — a button that saves it, to attach to the email
export function emailModal({ to = '', subject = '', text = '', title = 'Send by email', file, onSent } = {}) {
  const { wrap, close } = openModal(title, `
    ${field('To', 'em-to', { value: to, type: 'email', placeholder: 'name@example.co.za' })}
    ${field('Subject', 'em-subject', { value: subject })}
    ${file ? `<div class="em-file"><button class="btn" type="button" id="em-file">${esc(file.label)}</button><span class="muted">Save it, then attach ${esc(file.name)} to the email.</span></div>` : ''}
    ${field('Message', 'em-body', { type: 'textarea', rows: 8, value: text })}
    <div class="rc-acts em-acts">
      <a class="btn primary" id="em-mailto" href="#">Open in my email program</a>
      <a class="btn" id="em-gmail" href="#" target="_blank" rel="noopener">Gmail</a>
      <a class="btn" id="em-outlook" href="#" target="_blank" rel="noopener">Outlook</a>
      <button class="btn ghost" type="button" id="em-copy">Copy message</button>
    </div>
    <p class="muted" id="em-long" hidden>A long message: some email programs cut it short. If yours does, use Copy message${file ? ' or attach the file' : ''}.</p>
    <p class="muted">If nothing opens, the PC has no email program set up: use Gmail or Outlook, or copy the message into your email.</p>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
  const sync = () => {
    const t = val(wrap, 'em-to'), s = val(wrap, 'em-subject'), b = wrap.querySelector('#em-body').value;
    wrap.querySelector('#em-mailto').href = mailtoHref(t, s, b);
    wrap.querySelector('#em-gmail').href = gmailHref(t, s, b);
    wrap.querySelector('#em-outlook').href = outlookHref(t, s, b);
    wrap.querySelector('#em-long').hidden = mailtoHref(t, s, b).length <= 1800;
  };
  wrap.addEventListener('input', sync); sync();
  wrap.addEventListener('click', async (e) => {
    const a = e.target.closest('#em-mailto, #em-gmail, #em-outlook');
    if (a) { if (!addrs(val(wrap, 'em-to')).length) { e.preventDefault(); toast('The email address first.', 'warn'); wrap.querySelector('#em-to').focus(); return; } if (onSent) onSent(a.id.slice(3)); return; }
    if (e.target.id === 'em-file') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([file.make()], { type: file.type || 'application/octet-stream' })); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Saved ' + file.name + ': attach it to the email'); return;
    }
    if (e.target.id === 'em-copy') {
      const msg = val(wrap, 'em-subject') + '\n\n' + wrap.querySelector('#em-body').value;
      await navigator.clipboard.writeText(msg).then(() => toast('Message copied: paste it into your email'), () => toast('Could not copy: select the message and copy it', 'warn'));
    }
  });
  return { wrap, close };
}
