// Retail POS — small screen helpers: escaping, toasts, modals, fields, money
// and the PIN pad used for sign-in and for a manager's approval.

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// whole cents → "R 1,234.56"; never a float in between
export function money(cents, symbol = 'R') {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const rand = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');   // the same on every device, whatever its locale
  return `${sign}${symbol} ${rand}.${String(abs % 100).padStart(2, '0')}`;
}
export const niceDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
export const niceTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : '';

let toastTimer = null;
export function toast(text, kind) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text; t.className = 'toast on' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'warn' ? 5000 : 3000);
}

export function field(label, id, o = {}) {
  const type = o.type || 'text';
  if (type === 'select') {
    return `<label class="fld"><span>${esc(label)}</span><select id="${id}"${o.disabled ? ' disabled' : ''}>${(o.options || []).map(op => `<option value="${esc(op.value)}"${String(op.value) === String(o.value) ? ' selected' : ''}>${esc(op.label)}</option>`).join('')}</select></label>`;
  }
  if (type === 'textarea') return `<label class="fld"><span>${esc(label)}</span><textarea id="${id}" rows="${o.rows || 2}" placeholder="${esc(o.placeholder || '')}">${esc(o.value || '')}</textarea></label>`;
  return `<label class="fld"><span>${esc(label)}</span><input id="${id}" type="${type}" value="${esc(o.value == null ? '' : o.value)}" placeholder="${esc(o.placeholder || '')}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''}${o.step ? ` step="${o.step}"` : ''}${o.inputmode ? ` inputmode="${o.inputmode}"` : ''}${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ''}${o.list ? ` list="${o.list}" autocomplete="off"` : ''}${o.disabled ? ' disabled' : ''}></label>`;
}
export const row = (...cells) => `<div class="fld-row">${cells.join('')}</div>`;
export const val = (wrap, id) => { const e = wrap.querySelector('#' + id); return e ? String(e.value || '').trim() : ''; };
export const checks = (wrap, attr) => [...wrap.querySelectorAll(`input[${attr}]:checked`)].map(e => e.getAttribute(attr));

// A modal: openModal(title, html, { okLabel, cancelLabel, onOk(wrap) → false keeps it open })
export function openModal(title, html, o = {}) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = 'modal'; wrap.id = 'modal';
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close title="Close">✕</button></div>
    <div class="modal-body">${html}</div>
    <div class="modal-foot">${o.cancelLabel === '' ? '' : `<button class="btn ghost" data-close>${esc(o.cancelLabel || 'Cancel')}</button>`}<button class="btn primary" id="modal-ok">${esc(o.okLabel || 'Save')}</button></div>
  </div>`;
  document.body.appendChild(wrap);
  const close = (ok) => { wrap.remove(); document.removeEventListener('keydown', onKey); if (o.onClose) o.onClose(ok); };
  const onKey = (e) => { if (e.key === 'Escape') close(false); };
  document.addEventListener('keydown', onKey);
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(false)));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(false); });
  wrap.querySelector('#modal-ok').addEventListener('click', async () => {
    if (!o.onOk) return close(true);
    const res = await o.onOk(wrap);
    if (res !== false) close(true);
  });
  // focus the first field, unless the person (or a scanner) has already gone to another one
  const first = wrap.querySelector('input, select, textarea');
  if (first) setTimeout(() => { if (!wrap.contains(document.activeElement)) first.focus(); }, 40);
  return { close, wrap };
}
export function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); }

// A document in its own tab, ready to print. `css` is the page's own styling.
export function openPrint(title, body, css = '') {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;font-family:Arial,sans-serif;color:#000;background:#fff}.no-print{padding:8px;background:#eee}@media print{.no-print{display:none}}${css}</style></head><body>
    <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:800;background:#000;color:#fff;border:0;cursor:pointer">PRINT</button> <button onclick="window.close()" style="padding:8px 16px;cursor:pointer">CLOSE</button></div>${body}</body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked: allow pop-ups for this site, then try again.', 'warn'); return; }
  win.document.write(html); win.document.close();
}

export const empty = (title, note) => `<div class="empty"><div class="empty-title">${esc(title)}</div>${note ? `<div class="empty-note">${esc(note)}</div>` : ''}</div>`;

// ---------------------------------------------------------------- PIN pad --
// Big keys for a tablet; the keyboard works too (a wedge scanner never reaches
// it: digits only, Enter submits). onSubmit(pin) → a Promise; a rejection
// shakes the pad and shows the message.
export function pinPadHtml(o = {}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'];
  return `<div class="pinpad" data-len="${o.length || 6}">
    ${o.title ? `<div class="pinpad-title">${esc(o.title)}</div>` : ''}
    <div class="pin-dots" aria-live="polite"></div>
    <div class="pin-msg"></div>
    <div class="pin-keys">${keys.map(k => `<button type="button" class="pin-key${k === 'ok' ? ' ok' : k === 'back' ? ' back' : ''}" data-key="${k}">${k === 'back' ? '⌫' : k === 'ok' ? 'Enter' : k}</button>`).join('')}</div>
  </div>`;
}
export function wirePinPad(pad, onSubmit) {
  const maxLen = parseInt(pad.dataset.len, 10) || 6;
  let pin = '', busy = false;
  const dots = pad.querySelector('.pin-dots'), msg = pad.querySelector('.pin-msg');
  const draw = () => { dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); };
  const fail = (text) => { msg.textContent = text || ''; pad.classList.add('shake'); setTimeout(() => pad.classList.remove('shake'), 500); pin = ''; draw(); };
  const submit = async () => {
    if (busy) return;
    if (pin.length < 4) return fail('A PIN is at least 4 digits');
    busy = true; pad.classList.add('busy'); msg.textContent = '';
    try { await onSubmit(pin); pin = ''; draw(); }
    catch (e) { fail(e && e.message ? e.message : 'That did not work'); }
    busy = false; pad.classList.remove('busy');
  };
  const press = (k) => {
    if (busy) return;
    if (k === 'back') pin = pin.slice(0, -1);
    else if (k === 'ok') return submit();
    else if (/^\d$/.test(k) && pin.length < maxLen) { pin += k; if (pin.length === maxLen) return (draw(), submit()); }
    msg.textContent = ''; draw();
  };
  pad.addEventListener('click', (e) => { const b = e.target.closest('[data-key]'); if (b) press(b.dataset.key); });
  const onKey = (e) => {
    if (!document.body.contains(pad)) return document.removeEventListener('keydown', onKey);
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('back'); else if (e.key === 'Enter') press('ok'); else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  draw();
  return { reset: () => { pin = ''; draw(); msg.textContent = ''; }, fail };
}
