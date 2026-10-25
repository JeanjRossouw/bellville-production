// Retail POS — the client's private page for a sales order or a quotation (track.html): the link
// made by the server, sent with a written message on WhatsApp (or copied when there is no number).
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, openModal } from './ui.js';
import { whatsappUrl } from './receipt.js';

export async function sendLink(kind, id, where) {
  try {
    const r = await auth.api('trackLink', { kind, id, ...where }, API.special);
    if (r.phone) window.open(whatsappUrl(r.phone, r.text), '_blank');
    else {
      await navigator.clipboard.writeText(r.text).catch(() => {});
      openModal('No phone number', `<p>There is no cell number for this client. The message and the link are copied; send them another way:</p><p class="muted">${esc(r.text)}</p>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
    }
    return r;
  } catch (e) { toast(e.offline ? 'Sending the link needs the line: try again when connected.' : e.message, 'warn'); return null; }
}
