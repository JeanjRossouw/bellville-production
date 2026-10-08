// Shared rendering helpers: escaping, money, dates, status chips, toasts, modals.

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const money = (n, cur) => (cur || 'R') + ' ' + (Math.round((Number(n) || 0) * 100) / 100)
  .toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const today = () => new Date().toISOString().split('T')[0];

export function addDays(iso, days) {
  const d = new Date((iso || today()) + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export function niceDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.round((d - new Date(today() + 'T00:00:00')) / 86400000);
}

export const STATUSES = [
  { key: 'new', label: 'New', icon: '', cls: 'st-new', help: 'Accepted, not started on the floor yet' },
  { key: 'in-production', label: 'In production', icon: '', cls: 'st-prod', help: 'Being built' },
  { key: 'ready', label: 'Done', icon: '', cls: 'st-ready', help: 'Built and finished, waiting to go out' },
  { key: 'dispatched', label: 'Dispatched', icon: '', cls: 'st-disp', help: 'Scanned out to the customer' },
  { key: 'invoiced', label: 'Invoiced', icon: '', cls: 'st-inv', help: 'Billed to the customer' }
];

export const statusMeta = (key) => STATUSES.find(s => s.key === key) || STATUSES[0];

export function statusChip(key) {
  const s = statusMeta(key);
  return `<span class="chip ${s.cls}">${esc(s.label)}</span>`;
}

export const FABRIC_STATES = [
  { key: 'none', label: 'Not ordered', cls: 'fb-none' },
  { key: 'ordered', label: 'Ordered', cls: 'fb-ord' },
  { key: 'received', label: 'Received', cls: 'fb-rec' }
];

export function fabricChip(key) {
  const f = FABRIC_STATES.find(x => x.key === key) || FABRIC_STATES[0];
  return `<span class="chip ${f.cls}">${esc(f.label)}</span>`;
}

let toastTimer = null;
export function toast(msg, kind) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast show ' + (kind || 'ok');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

// A single reusable modal. `html` is the body; buttons are supplied by caller.
export function openModal(title, html, opts) {
  const o = opts || {};
  let wrap = document.getElementById('modal');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'modal';
    document.body.appendChild(wrap);
  }
  wrap.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button class="icon-btn" data-close="1" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${html}</div>
      <div class="modal-foot">
        <button class="btn ghost" data-close="1">${esc(o.cancelLabel || 'Cancel')}</button>
        <button class="btn primary" id="modal-ok">${esc(o.okLabel || 'Save')}</button>
      </div>
    </div>`;
  wrap.classList.add('open');
  const close = () => { wrap.classList.remove('open'); wrap.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const ok = wrap.querySelector('#modal-ok');
  ok.addEventListener('click', async () => {
    if (!o.onOk) return close();
    const res = await o.onOk(wrap);
    if (res !== false) close();
  });
  const first = wrap.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 50);
  return { close, wrap };
}

export const val = (wrap, id) => {
  const el = wrap.querySelector('#' + id);
  return el ? String(el.value || '').trim() : '';
};

export function field(label, id, opts) {
  const o = opts || {};
  const type = o.type || 'text';
  if (type === 'select') {
    return `<label class="fld"><span>${esc(label)}</span>
      <select id="${id}">${(o.options || []).map(op =>
        `<option value="${esc(op.value)}"${op.value === o.value ? ' selected' : ''}>${esc(op.label)}</option>`).join('')}</select></label>`;
  }
  if (type === 'textarea') {
    return `<label class="fld"><span>${esc(label)}</span>
      <textarea id="${id}" rows="${o.rows || 2}" placeholder="${esc(o.placeholder || '')}">${esc(o.value || '')}</textarea></label>`;
  }
  return `<label class="fld"><span>${esc(label)}</span>
    <input id="${id}" type="${type}" value="${esc(o.value == null ? '' : o.value)}"
      placeholder="${esc(o.placeholder || '')}"${o.min != null ? ` min="${o.min}"` : ''}${o.step ? ` step="${o.step}"` : ''}${o.list ? ` list="${o.list}" autocomplete="off"` : ''}></label>`;
}

export const row = (...cells) => `<div class="fld-row">${cells.join('')}</div>`;

export function empty(icon, title, note) {
  return `<div class="empty"><div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div>
    ${note ? `<div class="empty-note">${esc(note)}</div>` : ''}</div>`;
}

export function phaseStub(phase, title, lines) {
  return `<div class="card stub">
    <div class="stub-badge">Phase ${phase}</div>
    <h2>${esc(title)}</h2>
    <p class="stub-lead">Not built yet. This is what goes here:</p>
    <ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
  </div>`;
}

// ------------------------------------------------------------- printing ---
// Invoices, statements and purchase orders print the same way.
const PRINT_CSS = `
  body { font: 12px/1.45 Arial, Helvetica, sans-serif; color: #000; margin: 0; padding: 18px; }
  .no-print { margin-bottom: 12px; } @media print { .no-print { display: none; } }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
  .co { font-size: 22px; font-weight: 900; letter-spacing: .1em; } .co small { display: block; font-size: 10px; font-weight: 400; letter-spacing: .04em; color: #333; white-space: pre-line; margin-top: 4px; }
  .t { text-align: right; } .t b { display: block; font-size: 22px; letter-spacing: .08em; } .t .n { font-size: 16px; font-weight: 800; } .t span { display: block; font-size: 10.5px; color: #333; }
  .two { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 14px; } .box { flex: 1; } .box h4 { margin: 0 0 3px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: #333; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #000; padding: 6px 8px; text-align: left; vertical-align: top; } th { background: #eee; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; }
  .r { text-align: right; } .tot td { font-weight: 800; } .big td { font-size: 14px; }
  .bank { margin-top: 16px; border: 1px solid #000; padding: 8px; white-space: pre-line; font-size: 11.5px; } .bank b { display: block; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 3px; }
  .ft { margin-top: 14px; font-size: 10px; color: #333; } .paid { position: absolute; right: 40px; top: 120px; border: 4px solid #15803d; color: #15803d; font-size: 28px; font-weight: 900; padding: 4px 16px; transform: rotate(-12deg); letter-spacing: .1em; }
`;
export function openPrint(title, body) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
    <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:800;background:#000;color:#fff;border:0;cursor:pointer">PRINT</button>
    <button onclick="window.close()" style="padding:8px 16px;margin-left:8px;cursor:pointer">CLOSE</button></div>${body}</body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html); win.document.close();
}
// The company block at the top of every printed document.
export function docHeader(settings, kind, no, lines) {
  const details = [settings.legalName && settings.legalName !== settings.name ? settings.legalName : '', settings.address, settings.phone, settings.email,
    settings.regNo ? 'Reg. no. ' + settings.regNo : '', settings.vatRegistered && settings.vatNo ? 'VAT no. ' + settings.vatNo : ''].filter(Boolean).join('\n');
  return `<div class="hd"><div class="co">${esc((settings.name || 'COMPANY').toUpperCase())}<small>${esc(details)}</small></div>
    <div class="t"><b>${esc(kind)}</b><span class="n">${esc(no)}</span>${(lines || []).map(l => `<span>${esc(l)}</span>`).join('')}</div></div>`;
}

// A phone number as WhatsApp wants it: digits only, 0xx → 27xx.
export function waDigits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '27' + d.slice(1);
  return d;
}
