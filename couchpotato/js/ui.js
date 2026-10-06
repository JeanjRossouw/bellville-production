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
  { key: 'new', label: 'New', icon: '🆕', cls: 'st-new', help: 'Accepted, not started on the floor yet' },
  { key: 'in-production', label: 'In production', icon: '🔧', cls: 'st-prod', help: 'Being built' },
  { key: 'ready', label: 'Ready', icon: '📦', cls: 'st-ready', help: 'Finished, waiting to go out' },
  { key: 'dispatched', label: 'Dispatched', icon: '🚚', cls: 'st-disp', help: 'Scanned out to the customer' },
  { key: 'invoiced', label: 'Invoiced', icon: '🧾', cls: 'st-inv', help: 'Billed to the customer' }
];

export const statusMeta = (key) => STATUSES.find(s => s.key === key) || STATUSES[0];

export function statusChip(key) {
  const s = statusMeta(key);
  return `<span class="chip ${s.cls}">${s.icon} ${esc(s.label)}</span>`;
}

export const FABRIC_STATES = [
  { key: 'none', label: 'Not ordered', cls: 'fb-none' },
  { key: 'ordered', label: 'Ordered', cls: 'fb-ord' },
  { key: 'received', label: 'Received', cls: 'fb-rec' }
];

export function fabricChip(key) {
  const f = FABRIC_STATES.find(x => x.key === key) || FABRIC_STATES[0];
  return `<span class="chip ${f.cls}">🧵 ${esc(f.label)}</span>`;
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
