// The till's own pieces, used by the point of sale (pos.js):
//
//   staff and PINs   tillStaff: { name, pinHash, role: 'manager'|'cashier',
//                    maxDiscPct, canRefund, active }. When any are set up, the
//                    till starts locked and someone unlocks it with their PIN;
//                    whoever is unlocked rings the sale. Managers give any
//                    discount and approve what a cashier may not (their PIN on
//                    the spot). Set up under Settings → Till staff.
//   the shop's stock when the online shop is connected, the till sells the
//                    shop's own products at the shop's price and count, read
//                    live from Shopify (kept on this device for a quick start);
//                    each sale becomes a Shopify order (see factory-shopify).
//   the slip         an 80 mm receipt, and the same as text for WhatsApp/email.
//
// A PIN is kept only as a hash (of the company and the PIN); the till compares
// hashes. It is a till PIN, not a password: it says who is ringing.
import * as store from './store.js';
import { esc, money, field, row, val, openModal, toast, waDigits, niceDate } from './ui.js';

let settings = {};
let staff = [];
let unwatch = null;
let onChange = null;
let current = null;            // who is ringing; in memory only, so the till starts locked
let shop = null;               // the online shop's connection status
let cat = { at: '', items: [] };
let loading = false;
let lastError = '';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cid = () => (store.getCompany() || {}).id || (store.getUser() || {}).companyId || 'demo';
const catKey = () => 'cp-till-catalogue-' + cid();

export function startTill(cb, cfg) {
  onChange = cb; settings = cfg || {};
  if (unwatch) unwatch();
  unwatch = store.watch('tillStaff', rows => {
    staff = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (current && !staff.some(s => s.id === current.id && s.active !== false)) current = null;   // removed while signed in
    if (onChange) onChange();
  });
  try { const c = JSON.parse(localStorage.getItem(catKey()) || 'null'); if (c && Array.isArray(c.items)) cat = c; } catch (e) {}
}
export const setTillSettings = (cfg) => { settings = cfg || {}; };

// --------------------------------------------------------------- staff -----

export const tillStaff = () => staff.filter(s => s.active !== false);
export const allTillStaff = () => staff;
export const usesPins = () => tillStaff().length > 0;
export const tillUser = () => current;
export const isManager = (s) => !!s && s.role === 'manager';
// who rang it: the till person, else the login
export const ringer = () => (current && current.name) || (store.getUser() || {}).name || 'till';
export function lockTill() { current = null; if (onChange) onChange(); }

export async function pinHash(pin) {
  const data = new TextEncoder().encode(cid() + ':' + String(pin).trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function byPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin || ''))) return null;
  const h = await pinHash(pin);
  return tillStaff().find(s => s.pinHash === h) || null;
}
export async function unlockWith(pin) {
  const s = await byPin(pin);
  if (!s) return null;
  current = s; if (onChange) onChange();
  return s;
}

// The PIN pad that locks the till. Keys and Enter go to tillKey (pos.js
// routes the clicks); a keyboard types straight into the box.
export function lockHtml() {
  return `<div class="till-lock">
    <div class="till-lock-card">
      <h2>🔒 Till locked</h2>
      <p class="muted">Enter your PIN to ring up sales.</p>
      <input id="till-pin" class="till-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••" aria-label="PIN">
      <div class="till-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(k => `<button type="button" data-act="till-key" data-k="${k}">${k}</button>`).join('')}</div>
      <button class="btn primary" data-act="till-key" data-k="ok" style="width:100%">Unlock</button>
    </div></div>`;
}
export async function tillKey(k) {
  const inp = document.getElementById('till-pin'); if (!inp) return;
  if (k === 'C') inp.value = '';
  else if (k === '⌫') inp.value = inp.value.slice(0, -1);
  else if (/^\d$/.test(k)) { if (inp.value.length < 6) inp.value += k; }
  if (k === 'ok' || (/^\d$/.test(k) && inp.value.length >= 4 && await byPin(inp.value))) {
    const s = await unlockWith(inp.value);
    if (!s) { inp.value = ''; inp.classList.add('bad'); setTimeout(() => inp.classList.remove('bad'), 600); if (k === 'ok') toast('That PIN is not on the till', 'warn'); return; }
    toast('Hi ' + s.name);
  }
}

// A manager's PIN, for something the person at the till may not do alone.
// Resolves with the manager, or null if cancelled.
export function managerApproval(why) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal('Manager approval', `
      <p>${esc(why)}</p>
      <label class="fld"><span>Manager PIN</span><input id="mg-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6"></label>`, {
      okLabel: 'Approve',
      onOk: async (w) => {
        const s = await byPin(val(w, 'mg-pin'));
        if (!isManager(s)) { toast('That is not a manager’s PIN', 'warn'); return false; }
        done = true; resolve(s);
      },
      onClose: () => { if (!done) resolve(null); }
    });
    setTimeout(() => { const i = m.wrap.querySelector('#mg-pin'); if (i) i.focus(); }, 60);
  });
}

// --- Settings → Till staff (the owner, or whoever may change the settings)

export function staffCardHtml() {
  const rows = allTillStaff();
  return `<div class="card" id="till-staff-card">
    <h2>Till staff</h2>
    <p class="muted">Give everyone who uses the till their own PIN. The till then starts locked, each sale shows who rang it, and a cashier’s discounts stay within their limit unless a manager enters their PIN. Leave this empty to use the till without PINs.</p>
    ${rows.length ? rows.map(s => `<div class="team-row">
      <div><strong>${esc(s.name)}</strong>${s.active === false ? ' <span class="chip calm">off</span>' : ''}<div class="muted">${isManager(s) ? 'Manager: any discount, approves the rest' : 'Cashier: discounts up to ' + (Number(s.maxDiscPct) || 0) + '%' + (s.canRefund ? ', may do returns' : ', returns need a manager')}</div></div>
      <div class="btn-row"><button class="btn ghost sm" data-act="till-staff-edit" data-id="${esc(s.id)}">Edit</button><button class="btn danger sm" data-act="till-staff-del" data-id="${esc(s.id)}">Remove</button></div>
    </div>`).join('') : '<p class="muted">No till staff yet.</p>'}
    <div class="card-actions"><button class="btn primary" data-act="till-staff-new">＋ Till staff</button></div>
  </div>`;
}

export function editTillStaff(id) {
  const s = staff.find(x => x.id === id) || { role: staff.length ? 'cashier' : 'manager', maxDiscPct: 10, canRefund: false };
  const first = !staff.length;
  openModal(id ? 'Edit ' + s.name : 'New till staff', row(field('Name', 'ts-name', { value: s.name, placeholder: 'As it shows on the slip' }),
      field(id ? 'New PIN (leave blank to keep)' : 'PIN (4 to 6 digits)', 'ts-pin', { type: 'password' })) +
    row(field('Role', 'ts-role', { type: 'select', value: s.role || 'cashier', options: [{ value: 'cashier', label: 'Cashier' }, { value: 'manager', label: 'Manager' }] }),
      field('Most discount without a manager (%)', 'ts-disc', { value: s.maxDiscPct == null ? 10 : s.maxDiscPct, type: 'number', min: 0, step: '1' })) +
    `<label class="check"><input type="checkbox" id="ts-refund"${s.canRefund ? ' checked' : ''}> May do returns and refunds without a manager</label>
     ${id ? `<label class="check"><input type="checkbox" id="ts-off"${s.active === false ? ' checked' : ''}> Switched off (cannot unlock the till)</label>` : ''}
     ${first ? '<p class="muted">The first person is a manager, so someone can always approve.</p>' : ''}`, {
    okLabel: id ? 'Save' : 'Add',
    onOk: async (w) => {
      const name = val(w, 'ts-name').trim(), pin = val(w, 'ts-pin').trim();
      if (!name) { toast('Give them a name', 'warn'); return false; }
      if (pin && !/^\d{4,6}$/.test(pin)) { toast('A PIN is 4 to 6 digits', 'warn'); return false; }
      if (!id && !pin) { toast('Give them a PIN', 'warn'); return false; }
      const d = { name, role: val(w, 'ts-role') === 'manager' ? 'manager' : 'cashier', maxDiscPct: Math.max(0, Math.min(100, parseFloat(val(w, 'ts-disc')) || 0)),
        canRefund: !!w.querySelector('#ts-refund').checked, active: !(w.querySelector('#ts-off') || {}).checked };
      if (pin) {
        d.pinHash = await pinHash(pin);
        if (staff.some(x => x.id !== id && x.pinHash === d.pinHash)) { toast('Someone else has that PIN: pick another', 'warn'); return false; }
      }
      // never leave the till without a manager who can unlock it
      const managersAfter = staff.filter(x => x.id !== id && x.role === 'manager' && x.active !== false).length + (d.role === 'manager' && d.active ? 1 : 0);
      if (!managersAfter) { toast('Keep at least one manager who is switched on', 'warn'); return false; }
      if (id) await store.update('tillStaff', id, d); else await store.create('tillStaff', d);
      toast(name + (id ? ' saved' : ' added to the till'));
    }
  });
}
export async function removeTillStaff(id) {
  const s = staff.find(x => x.id === id); if (!s) return;
  const others = staff.filter(x => x.id !== id);
  if (others.length && !others.some(x => x.role === 'manager' && x.active !== false)) { toast('Keep at least one manager: make someone else a manager first', 'warn'); return; }
  if (!confirm('Remove ' + s.name + ' from the till?')) return;
  await store.remove('tillStaff', id);
  toast(s.name + ' removed');
}

// ----------------------------------------------------- the shop's stock -----

export const setTillShop = (s) => { const was = shopOn(); shop = s; if (shopOn() && !was) refreshCatalogue(); };
export const shopOn = () => !!(shop && shop.connected);
export const shopItems = () => (shopOn() ? cat.items : []);
export const catalogueAt = () => cat.at;
export const catalogueError = () => lastError;
export const catalogueLoading = () => loading;
export const shopItem = (variantId) => shopItems().find(i => i.variantId === String(variantId)) || null;
export function shopItemByCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  return shopItems().find(i => String(i.barcode || '').toLowerCase() === c) || shopItems().find(i => String(i.sku || '').toLowerCase() === c) || null;
}
// Read the shop again: on opening the till (if it is a few minutes old), after
// a sale, and on the ↻ button.
export async function refreshCatalogue(force) {
  if (!shopOn() || loading) return;
  if (!force && cat.at && Date.now() - Date.parse(cat.at) < 3 * 60000) return;
  loading = true; if (onChange) onChange();
  try {
    const r = await store.shopifyCall('catalogue');
    if (r && r.connected) {
      cat = { at: r.at || new Date().toISOString(), items: r.items || [] };
      try { localStorage.setItem(catKey(), JSON.stringify(cat)); } catch (e) { /* too big or storage off: it is read again next time */ }
    }
    lastError = '';
  } catch (e) { lastError = e.message || 'Could not read the shop'; }
  loading = false; if (onChange) onChange();
}
// what this sale took, off the count here, until the shop is read again
export function takeFromShop(lines) {
  (lines || []).forEach(l => { const i = l.variantId && shopItem(l.variantId); if (i && i.tracked) i.qty = Math.max(0, (Number(i.qty) || 0) - (Number(l.qty) || 0)); });
  try { localStorage.setItem(catKey(), JSON.stringify(cat)); } catch (e) {}
}

// ---------------------------------------------------------------- slip ------

function slipLines(sale) {
  return (sale.lines || []).map(l => {
    const gross = r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0));
    return { name: l.name + (l.fabric ? ' (' + l.fabric + ')' : ''), qty: l.qty, each: Number(l.unitPrice) || 0, gross, disc: r2(Number(l.disc) || 0),
      note: l.kind === 'order' ? 'made to order' + (l.orderNo ? ' ' + l.orderNo : '') : '' };
  });
}
const payLine = (p) => (p.method || '') + (p.ref ? ' (' + p.ref + ')' : '');

export function slipText(sale) {
  const cur = settings.currency || 'R';
  const L = [settings.name || 'Receipt', ...[settings.address, settings.phone].filter(Boolean),
    '', (sale.saleNo || '') + ' · ' + niceDate(sale.date) + (sale.time ? ' ' + sale.time : ''), 'Served by ' + (sale.by || ''), sale.customerName && sale.customerName !== 'Walk-in customer' ? 'Customer: ' + sale.customerName : '', ''];
  slipLines(sale).forEach(l => { L.push(l.qty + ' × ' + l.name + '  ' + money(l.gross, cur)); if (l.disc) L.push('   less ' + money(l.disc, cur)); if (l.note) L.push('   ' + l.note); });
  if (Number(sale.discount)) L.push('Discount  −' + money(sale.discount, cur));
  L.push('TOTAL  ' + money(sale.total, cur));
  if (Number(sale.vat)) L.push('Includes VAT  ' + money(sale.vat, cur));
  (sale.payments || [{ method: sale.method, amount: sale.paidNow, ref: sale.ref }]).filter(p => Number(p.amount)).forEach(p => L.push(payLine(p) + '  ' + money(p.amount, cur)));
  if (Number(sale.tendered)) L.push('Cash given  ' + money(sale.tendered, cur), 'Change  ' + money(sale.change, cur));
  if (Number(sale.balance) > 0) L.push('Still owing  ' + money(sale.balance, cur));
  L.push('', 'Invoice ' + (sale.invoiceNo || ''), 'Thank you!');
  return L.filter((x, i) => x !== '' || L[i - 1] !== '').join('\n');
}

export function printSlip(sale) {
  const cur = settings.currency || 'R';
  const m = (x) => esc(money(x, cur));
  const pays = (sale.payments || [{ method: sale.method, amount: sale.paidNow, ref: sale.ref }]).filter(p => Number(p.amount));
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(sale.saleNo || 'Slip')}</title><style>
    @page { size: 80mm auto; margin: 3mm; }
    body { font: 12px/1.35 'Courier New', monospace; width: 74mm; margin: 0 auto; color: #000; }
    .c { text-align: center; } h1 { font-size: 15px; margin: 0 0 2px; } .r { display: flex; justify-content: space-between; gap: 6px; }
    .r span:last-child { white-space: nowrap; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; } .b { font-weight: 700; font-size: 14px; }
    .s { font-size: 11px; } .no-print { margin: 8px 0; text-align: center; } @media print { .no-print { display: none; } }
  </style></head><body>
    <div class="no-print"><button onclick="window.print()">PRINT</button> <button onclick="window.close()">CLOSE</button></div>
    <div class="c"><h1>${esc(settings.name || '')}</h1><div class="s">${[settings.address, settings.phone, settings.vatRegistered && settings.vatNo ? 'VAT no. ' + settings.vatNo : ''].filter(Boolean).map(esc).join('<br>')}</div></div>
    <hr><div class="r"><span>${esc(sale.saleNo || '')}</span><span>${esc(niceDate(sale.date))} ${esc(sale.time || '')}</span></div>
    <div class="s">Served by ${esc(sale.by || '')}${sale.customerName && sale.customerName !== 'Walk-in customer' ? '<br>' + esc(sale.customerName) : ''}</div><hr>
    ${slipLines(sale).map(l => `<div>${esc(l.qty)} × ${esc(l.name)}</div><div class="r"><span class="s">${l.qty > 1 ? '@ ' + m(l.each) : ''}</span><span>${m(l.gross)}</span></div>${l.disc ? `<div class="r s"><span>less discount</span><span>−${m(l.disc)}</span></div>` : ''}${l.note ? `<div class="s">${esc(l.note)}</div>` : ''}`).join('')}
    <hr>${Number(sale.discount) ? `<div class="r"><span>Discount</span><span>−${m(sale.discount)}</span></div>` : ''}
    <div class="r b"><span>TOTAL</span><span>${m(sale.total)}</span></div>
    ${Number(sale.vat) ? `<div class="r s"><span>Includes VAT</span><span>${m(sale.vat)}</span></div>` : ''}<hr>
    ${pays.map(p => `<div class="r"><span>${esc(payLine(p))}</span><span>${m(p.amount)}</span></div>`).join('')}
    ${Number(sale.tendered) ? `<div class="r"><span>Cash given</span><span>${m(sale.tendered)}</span></div><div class="r b"><span>Change</span><span>${m(sale.change)}</span></div>` : ''}
    ${Number(sale.balance) > 0 ? `<div class="r b"><span>Still owing</span><span>${m(sale.balance)}</span></div>` : ''}
    <hr><div class="c s">Invoice ${esc(sale.invoiceNo || '')}${sale.shopifyOrderName ? ' · Shop ' + esc(sale.shopifyOrderName) : ''}<br>Thank you!</div>
  </body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html); win.document.close();
}

export function shareSlip(sale, how, customer) {
  const text = slipText(sale);
  if (how === 'wa') {
    const to = waDigits((customer || {}).phone);
    window.open('https://wa.me/' + to + '?text=' + encodeURIComponent(text), '_blank');
  } else {
    window.open('mailto:' + encodeURIComponent((customer || {}).email || '') + '?subject=' + encodeURIComponent('Your receipt ' + (sale.saleNo || '') + (settings.name ? ' from ' + settings.name : '')) + '&body=' + encodeURIComponent(text), '_blank');
  }
}
