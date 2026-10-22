// Retail POS — the receipt panel after a sale, and for a reprint from the
// Sales tab: a preview of the slip and the ways to give it to the customer.
import { API } from './config.js';
import { setOne, newId } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, val, openModal, openPrint, money } from './ui.js';
import { receiptModel, slipHtml, SLIP_CSS, a4Html, A4_CSS, escposBytes, shareText, whatsappUrl, mailtoUrl, kindTitle } from './receipt.js';
import { icon } from './icons.js';

// openReceipt({ sale, lines, payments, vouchersSold, entity, store, settings, copy })
export function openReceipt(o) {
  const m = receiptModel(o);
  const store = o.store || {};
  const { wrap, close } = openModal(m.title + ' ' + m.docNo, `
    <div class="rc"><div class="rc-preview"><div class="rc-paper">${slipHtml(m)}</div></div>
    <div class="rc-acts">
      <button class="btn primary" data-rc="slip">${icon('printer')} Print slip</button>
      <button class="btn" data-rc="a4">${icon('file')} A4 / PDF</button>
      ${store.printAgentUrl ? `<button class="btn" data-rc="escpos">${icon('receipt')} Till printer</button>` : `<button class="btn ghost" data-rc="escpos" title="Download the slip as printer bytes (set a print agent on the store to send it straight)">${icon('receipt')} Printer bytes</button>`}
      <button class="btn" data-rc="wa">${icon('user')} WhatsApp</button>
      <button class="btn" data-rc="mail">${icon('file')} Email</button>
      <button class="btn ghost" data-rc="copy">Copy link</button>
      ${m.copy ? '<p class="muted">A reprint: it is marked COPY.</p>' : ''}
    </div></div>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
  wrap.querySelector('.modal-card').classList.add('wide');
  const audit = (how) => setOne('auditLog', newId('auditLog'), { action: 'receipt.print', docType: o.sale.series === 'LB' ? 'layby' : o.sale.series === 'SO' ? 'specialOrder' : o.sale.series === 'CN' ? 'creditNote' : 'sale', docId: o.sale.id, docNo: m.docNo, actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '', details: { kind: m.kind, copy: m.copy, how }, ...auth.stamp(o.entity.id, store.id || '') }).catch(() => {});
  let link = null;
  // lay-by documents have no public page: the share is the text itself
  const getLink = async () => { if (link) return link; const r = /^(LB|SO)$/.test(o.sale.series) ? { text: shareText(m, ''), url: '' } : await auth.api('link', { saleId: o.sale.id, ...where(o) }, API.doc); link = r; return r; };
  wrap.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rc]'); if (!b) return;
    const how = b.dataset.rc;
    try {
      if (how === 'slip') { openPrint(m.title + ' ' + m.docNo, slipHtml(m), SLIP_CSS); audit('slip'); }
      else if (how === 'a4') { openPrint(m.title + ' ' + m.docNo, a4Html(m), A4_CSS); audit('a4'); }
      else if (how === 'escpos') {
        const bytes = escposBytes(m);
        if (store.printAgentUrl) { const r = await fetch(store.printAgentUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }); if (!r.ok) throw new Error('The print agent said ' + r.status); toast('Sent to the till printer'); }
        else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); a.download = m.docNo + '.bin'; document.body.appendChild(a); a.click(); a.remove(); }
        audit('escpos');
      }
      else if (how === 'wa') { const r = await getLink(); const phone = prompt('WhatsApp number', (m.customer && m.customer.phone) || ''); if (phone) { window.open(whatsappUrl(phone, r.text), '_blank'); audit('whatsapp'); } }
      else if (how === 'mail') { const r = await getLink(); const email = prompt('Email address', (o.sale.customerSnapshot && o.sale.customerSnapshot.email) || ''); if (email) { window.open(mailtoUrl(email, m.title.replace(' · COPY', '') + ' ' + m.docNo + ' from ' + m.company.name, r.text), '_blank'); audit('email'); } }
      else if (how === 'copy') { const r = await getLink(); if (!r.url) { toast('No link for this document: share the text by WhatsApp or email.', 'warn'); return; } await navigator.clipboard.writeText(r.url).catch(() => {}); toast('Link copied'); wrap.querySelector('.rc-acts').insertAdjacentHTML('beforeend', `<p class="muted" style="word-break:break-all;font-size:11px" id="rc-link">${esc(r.url)}</p>`); }
    } catch (err) { toast(err.message, 'warn'); }
  });
  return { close, model: m };
}
function where(o) { const dev = auth.session.device; return dev ? auth.deviceBody() : { entityId: o.entity.id, storeId: o.store ? o.store.id : '' }; }
export { kindTitle, money };
