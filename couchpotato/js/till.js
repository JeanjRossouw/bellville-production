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
//   gift cards       giftCards: sold at the till (a code on the slip), used at
//                    the till as a way to pay, what is left kept on the card.
//   store credit, points   on the customer: credit from a return, loyalty
//                    points earned on sales (settings.loyaltyPct, 1 point = R1);
//                    both are ways to pay at the till.
//   the register     tillShifts: one open cash-up at a time: opened with a
//                    float, pay-ins and pay-outs along the way, closed with the
//                    cash counted. What the sales took, by method and by
//                    person, is read from the sales (and refunds) made while
//                    it was open; the X report shows it any time, the Z report
//                    prints at the close with the variance.
//
// A PIN is kept only as a hash (of the company and the PIN); the till compares
// hashes. It is a till PIN, not a password: it says who is ringing.
import * as store from './store.js';
import { esc, money, field, row, val, openModal, toast, waDigits, niceDate } from './ui.js';

let settings = {};
let staff = [];
let shifts = [];
let cards = [];
let unwatch = null, unwatchS = null, unwatchG = null;
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
  if (unwatchS) unwatchS();
  if (unwatchG) unwatchG();
  unwatchG = store.watch('giftCards', rows => { cards = rows; if (onChange) onChange(); });
  unwatchS = store.watch('tillShifts', rows => { shifts = rows.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || ''))); if (onChange) onChange(); });
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
        done = true; setTimeout(() => resolve(s), 0);     // once this box has closed, so what follows can open its own
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

// ----------------------------------------------------------- gift cards ----

export const allGiftCards = () => cards;
export const giftCardByCode = (code) => { const c = String(code || '').replace(/[\s-]/g, '').toUpperCase(); return c ? cards.find(g => String(g.code || '').replace(/-/g, '').toUpperCase() === c) || null : null; };
// a code nobody can guess, easy to read out: GC-XXXX-XXXX-XXXX
export function newGiftCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = new Uint8Array(12); crypto.getRandomValues(b);
  const s = [...b].map(x => A[x % A.length]).join('');
  return 'GC-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

// ---------------------------------------------------------------- slip ------

function slipLines(sale) {
  return (sale.lines || []).map(l => {
    const gross = r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0));
    return { name: l.name + (l.fabric ? ' (' + l.fabric + ')' : ''), qty: l.qty, each: Number(l.unitPrice) || 0, gross, disc: r2(Number(l.disc) || 0),
      note: l.kind === 'order' ? 'made to order' + (l.orderNo ? ' ' + l.orderNo : '') : l.kind === 'giftcard' && l.giftCode ? 'code ' + l.giftCode : '' };
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
  if (Number(sale.balance) > 0) L.push('Still owing  ' + money(sale.balance, cur) + (sale.kind === 'layby' ? ' (layby: collect when paid)' : sale.kind === 'account' ? ' (on account)' : ''));
  if (sale.pointsEarned) L.push('Points earned  ' + sale.pointsEarned + (sale.pointsBalance != null ? ' (balance ' + sale.pointsBalance + ')' : ''));
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
    ${Number(sale.balance) > 0 ? `<div class="r b"><span>Still owing${sale.kind === 'layby' ? ' (layby)' : sale.kind === 'account' ? ' (on account)' : ''}</span><span>${m(sale.balance)}</span></div>` : ''}
    ${sale.pointsEarned ? `<div class="r s"><span>Points earned</span><span>${esc(sale.pointsEarned)}${sale.pointsBalance != null ? ' (balance ' + esc(sale.pointsBalance) + ')' : ''}</span></div>` : ''}
    <hr><div class="c s">Invoice ${esc(sale.invoiceNo || '')}${sale.shopifyOrderName ? ' · Shop ' + esc(sale.shopifyOrderName) : ''}<br>Thank you!</div>
  </body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html); win.document.close();
}

// ------------------------------------------------------------ register -----

export const openShift = () => shifts.find(x => x.status === 'open') || null;
export const closedShifts = () => shifts.filter(x => x.status === 'closed');
export const shiftById = (id) => shifts.find(x => x.id === id) || null;
const inWindow = (at, sh) => !!at && at >= (sh.openedAt || '') && (!sh.closedAt || at <= sh.closedAt);
const cashIn = (sh) => (sh.moves || []).filter(m => m.kind === 'in').reduce((t, m) => t + (Number(m.amount) || 0), 0);
const cashOut = (sh) => (sh.moves || []).filter(m => m.kind === 'out').reduce((t, m) => t + (Number(m.amount) || 0), 0);

// Everything the register took and gave back while a shift was open, from
// the sales themselves: by method, by person, and the cash expected in the
// drawer (float + cash sales + cash in − cash refunds − cash out).
export const MONEY = ['Cash', 'Card', 'EFT', 'Other'];
export function shiftFigures(sh, sales) {
  const by = { Cash: 0, Card: 0, EFT: 0, 'Gift card': 0, 'Store credit': 0, Points: 0, Other: 0 }, refunds = { Cash: 0, Card: 0, EFT: 0, 'Store credit': 0, Other: 0 }, staff = {};
  let count = 0, returns = 0, value = 0;
  (sales || []).forEach(s => {
    if (inWindow(s.createdAt, sh)) {
      count++; value = r2(value + (Number(s.total) || 0));
      const who = s.by || '?'; staff[who] = staff[who] || { sales: 0, taken: 0, refunds: 0 }; staff[who].sales++;
    }
    // every payment taken in the window: with the sale, or later on a layby / account
    const pays = s.payments && s.payments.length ? s.payments : [{ method: s.method || 'Other', amount: s.paidNow, at: s.createdAt }];
    pays.forEach(p => {
      if (!inWindow(p.at && p.at.length > 10 ? p.at : s.createdAt, sh)) return;
      const m = by[p.method] != null ? p.method : 'Other'; by[m] = r2(by[m] + (Number(p.amount) || 0));
      const who = p.by || s.by || '?'; staff[who] = staff[who] || { sales: 0, taken: 0, refunds: 0 }; if (MONEY.includes(m)) staff[who].taken = r2(staff[who].taken + (Number(p.amount) || 0));
    });
    (s.returns || []).forEach(r => {
      if (!inWindow(r.at, sh) || !(Number(r.refund) > 0)) return;
      returns++;
      const m = refunds[r.method] != null ? r.method : 'Other'; refunds[m] = r2(refunds[m] + Number(r.refund));
      const who = r.by || '?'; staff[who] = staff[who] || { sales: 0, taken: 0, refunds: 0 }; staff[who].refunds = r2(staff[who].refunds + Number(r.refund));
    });
  });
  const float = Number(sh.float) || 0, ins = r2(cashIn(sh)), outs = r2(cashOut(sh));
  const expected = r2(float + by.Cash + ins - refunds.Cash - outs);
  return { by, refunds, staff, count, returns, value, float, ins, outs, expected, taken: r2(by.Cash + by.Card + by.EFT + by.Other), other: r2(by['Gift card'] + by['Store credit'] + by.Points), refunded: r2(refunds.Cash + refunds.Card + refunds.EFT + refunds.Other + refunds['Store credit']) };
}

export function openRegister() {
  if (openShift()) { toast('The register is already open', 'warn'); return; }
  openModal('Open the register', field('Cash float in the drawer', 'rg-float', { type: 'number', min: 0, step: '0.01', value: settings.tillFloat || '' }) + '<p class="muted">The notes and coins you start the day with. They are counted again at the close.</p>', {
    okLabel: 'Open register',
    onOk: async (w) => {
      const f = r2(parseFloat(val(w, 'rg-float')) || 0);
      const n = await store.nextNumber('shiftNo', 1);
      await store.create('tillShifts', { no: 'Z-' + String(n).padStart(4, '0'), status: 'open', float: f, openedAt: store.nowIso(), openedBy: ringer(), moves: [] });
      toast('Register open with ' + money(f, settings.currency || 'R') + ' float');
    }
  });
}
// cash put in or taken out of the drawer that is not a sale
export async function cashMove(kind) {
  const sh = openShift(); if (!sh) { toast('Open the register first', 'warn'); return; }
  const me = tillUser();
  if (kind === 'out' && usesPins() && !isManager(me) && !await managerApproval('Taking cash out of the drawer needs a manager.')) return;
  openModal(kind === 'in' ? 'Cash in' : 'Cash out', row(field('Amount', 'cm-amt', { type: 'number', min: 0, step: '0.01' }), field(kind === 'in' ? 'Where from' : 'What for', 'cm-why', { placeholder: kind === 'in' ? 'e.g. Change from the bank' : 'e.g. Milk, courier' })), {
    okLabel: kind === 'in' ? 'Put it in' : 'Take it out',
    onOk: async (w) => {
      const a = r2(parseFloat(val(w, 'cm-amt')) || 0), why = val(w, 'cm-why');
      if (!(a > 0)) { toast('How much?', 'warn'); return false; }
      if (!why) { toast(kind === 'in' ? 'Say where it came from' : 'Say what it was for', 'warn'); return false; }
      await store.update('tillShifts', sh.id, { moves: [...(sh.moves || []), { at: store.nowIso(), by: ringer(), kind, amount: a, reason: why }] });
      toast(money(a, settings.currency || 'R') + (kind === 'in' ? ' put in the drawer' : ' taken out'));
    }
  });
}
export async function closeRegister(sales) {
  const sh = openShift(); if (!sh) return;
  const me = tillUser();
  if (usesPins() && !isManager(me) && !await managerApproval('Closing the register needs a manager.')) return;
  const cur = settings.currency || 'R';
  const f = shiftFigures(sh, sales);
  const m = openModal('Close the register: ' + sh.no, `
    <div class="cost-live" style="margin-top:0">
      <div><span>Float</span><strong>${esc(money(f.float, cur))}</strong></div>
      <div><span>Cash sales</span><strong>${esc(money(f.by.Cash, cur))}</strong></div>
      ${f.ins ? `<div><span>Cash in</span><strong>${esc(money(f.ins, cur))}</strong></div>` : ''}
      ${f.refunds.Cash ? `<div><span>Cash refunds</span><strong>− ${esc(money(f.refunds.Cash, cur))}</strong></div>` : ''}
      ${f.outs ? `<div><span>Cash out</span><strong>− ${esc(money(f.outs, cur))}</strong></div>` : ''}
      <div class="tot"><span>Cash expected in the drawer</span><strong>${esc(money(f.expected, cur))}</strong></div>
    </div>
    ${field('Cash counted in the drawer', 'rg-count', { type: 'number', min: 0, step: '0.01' })}
    <div class="cost-live"><div class="tot"><span>Difference</span><strong id="rg-var">—</strong></div></div>
    ${field('Note', 'rg-note', { placeholder: 'Optional: anything to explain' })}
    <p class="muted">Card ${esc(money(f.by.Card, cur))} · EFT ${esc(money(f.by.EFT, cur))}${f.by.Other ? ' · Other ' + esc(money(f.by.Other, cur)) : ''} · ${f.count} sale${f.count === 1 ? '' : 's'}. The Z report prints when you close.</p>`, {
    okLabel: 'Close register',
    onOk: async (w) => {
      const raw = val(w, 'rg-count');
      if (raw === '') { toast('Count the cash in the drawer first', 'warn'); return false; }
      const counted = r2(parseFloat(raw) || 0);
      const closedAt = store.nowIso();
      const fig = shiftFigures({ ...sh, closedAt }, sales);
      const rec = { status: 'closed', closedAt, closedBy: ringer(), counted, expected: fig.expected, variance: r2(counted - fig.expected), note: val(w, 'rg-note'), figures: fig };
      await store.update('tillShifts', sh.id, rec);
      toast(sh.no + ' closed' + (rec.variance ? ' · ' + (rec.variance > 0 ? 'over by ' : 'short by ') + money(Math.abs(rec.variance), cur) : ' · the cash balances'));
      setTimeout(() => printReport({ ...sh, ...rec }, 'Z'), 150);
    }
  });
  const inp = m.wrap.querySelector('#rg-count'), out = m.wrap.querySelector('#rg-var');
  inp.addEventListener('input', () => { if (inp.value === '') { out.textContent = '—'; return; } const v = r2((parseFloat(inp.value) || 0) - f.expected); out.textContent = (v > 0 ? 'over ' : v < 0 ? 'short ' : '') + money(Math.abs(v), cur); out.style.color = Math.abs(v) > 0.005 ? '#b91c1c' : '#1f7a3a'; });
}

// The X report (while open) and the Z report (at the close): an 80 mm slip.
export function printReport(sh, kind, sales) {
  const cur = settings.currency || 'R';
  const f = sh.figures && kind === 'Z' ? sh.figures : shiftFigures(sh, sales);
  const m = (x) => esc(money(x, cur));
  const when = (iso) => iso ? new Date(iso).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(kind + ' report ' + (sh.no || ''))}</title><style>
    @page { size: 80mm auto; margin: 3mm; } body { font: 12px/1.35 'Courier New', monospace; width: 74mm; margin: 0 auto; color: #000; }
    .c { text-align: center; } h1 { font-size: 15px; margin: 0 0 2px; } .r { display: flex; justify-content: space-between; gap: 6px; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
    .b { font-weight: 700; font-size: 14px; } .s { font-size: 11px; } .no-print { margin: 8px 0; text-align: center; } @media print { .no-print { display: none; } }
  </style></head><body>
    <div class="no-print"><button onclick="window.print()">PRINT</button> <button onclick="window.close()">CLOSE</button></div>
    <div class="c"><h1>${esc(settings.name || '')}</h1><div class="b">${kind === 'Z' ? 'Z REPORT (CASH-UP)' : 'X REPORT'} ${esc(sh.no || '')}</div></div><hr>
    <div class="r s"><span>Opened</span><span>${esc(when(sh.openedAt))} ${esc(sh.openedBy || '')}</span></div>
    ${sh.closedAt ? `<div class="r s"><span>Closed</span><span>${esc(when(sh.closedAt))} ${esc(sh.closedBy || '')}</span></div>` : `<div class="r s"><span>Printed</span><span>${esc(when(new Date().toISOString()))}</span></div>`}
    <hr><div class="r"><span>Sales</span><span>${f.count}</span></div><div class="r"><span>Sales value</span><span>${m(f.value)}</span></div>
    <div class="r"><span>Cash</span><span>${m(f.by.Cash)}</span></div><div class="r"><span>Card</span><span>${m(f.by.Card)}</span></div><div class="r"><span>EFT</span><span>${m(f.by.EFT)}</span></div>${f.by.Other ? `<div class="r"><span>Other</span><span>${m(f.by.Other)}</span></div>` : ''}
    <div class="r b"><span>Money taken</span><span>${m(f.taken)}</span></div>${f.other ? `<div class="r s"><span>Gift cards / credit / points used</span><span>${m(f.other)}</span></div>` : ''}
    ${f.refunded ? `<div class="r"><span>Refunds (${f.returns})</span><span>−${m(f.refunded)}</span></div>` : ''}
    <hr><div class="r"><span>Float</span><span>${m(f.float)}</span></div><div class="r"><span>Cash sales</span><span>${m(f.by.Cash)}</span></div>
    ${(sh.moves || []).map(x => `<div class="r s"><span>${x.kind === 'in' ? 'In' : 'Out'}: ${esc(x.reason)} (${esc(x.by)})</span><span>${x.kind === 'in' ? '' : '−'}${m(x.amount)}</span></div>`).join('')}
    ${f.refunds.Cash ? `<div class="r"><span>Cash refunds</span><span>−${m(f.refunds.Cash)}</span></div>` : ''}
    <div class="r b"><span>Cash expected</span><span>${m(f.expected)}</span></div>
    ${kind === 'Z' ? `<div class="r b"><span>Cash counted</span><span>${m(sh.counted)}</span></div><div class="r b"><span>${Number(sh.variance) > 0 ? 'OVER' : Number(sh.variance) < 0 ? 'SHORT' : 'Difference'}</span><span>${m(Math.abs(Number(sh.variance) || 0))}</span></div>${sh.note ? '<div class="s">' + esc(sh.note) + '</div>' : ''}` : ''}
    <hr><div class="b">By person</div>
    ${Object.keys(f.staff).sort().map(n => `<div class="r"><span>${esc(n)} (${f.staff[n].sales})</span><span>${m(f.staff[n].taken)}${f.staff[n].refunds ? ' / −' + m(f.staff[n].refunds) : ''}</span></div>`).join('') || '<div class="s">No sales yet</div>'}
    <hr><div class="c s">${kind === 'Z' ? 'Counted by: ______________' : 'Register still open'}</div>
  </body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html); win.document.close();
}

export function registerHtml(sales) {
  const cur = settings.currency || 'R';
  const sh = openShift();
  const tile = (n, label) => `<div class="tile"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  const when = (iso) => iso ? new Date(iso).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  let top;
  if (!sh) top = `<div class="card"><h2>Register closed</h2><p class="muted">Open it with the cash float to start the day. Sales ring up either way; the cash-up counts what happens while it is open.</p>
      <div class="card-actions"><button class="btn primary" data-act="till-open">Open register</button></div></div>`;
  else {
    const f = shiftFigures(sh, sales);
    top = `<div class="tiles">${tile(esc(money(f.expected, cur)), 'Cash expected in the drawer')}${tile(esc(money(f.by.Cash, cur)), 'Cash sales')}${tile(esc(money(f.by.Card, cur)), 'Card')}${tile(esc(money(f.by.EFT, cur)), 'EFT')}${tile(f.count, 'Sales')}${f.refunded ? tile('− ' + esc(money(f.refunded, cur)), 'Refunded') : ''}</div>
      <div class="card"><h2>${esc(sh.no)} · open since ${esc(when(sh.openedAt))} (${esc(sh.openedBy || '')})</h2>
        <p class="muted">Float ${esc(money(f.float, cur))}${f.ins ? ' · cash in ' + esc(money(f.ins, cur)) : ''}${f.outs ? ' · cash out ' + esc(money(f.outs, cur)) : ''}${f.refunds.Cash ? ' · cash refunds ' + esc(money(f.refunds.Cash, cur)) : ''}</p>
        ${(sh.moves || []).length ? `<table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th class="r">Amount</th></tr></thead><tbody>${sh.moves.map(x => `<tr><td>${esc(when(x.at))}</td><td>${esc(x.by)}</td><td>${x.kind === 'in' ? 'In' : 'Out'}: ${esc(x.reason)}</td><td class="r">${x.kind === 'in' ? '' : '− '}${esc(money(x.amount, cur))}</td></tr>`).join('')}</tbody></table>` : ''}
        ${Object.keys(f.staff).length ? `<h3 style="margin:.8rem 0 .3rem">By person</h3><table class="tbl"><thead><tr><th>Person</th><th class="r">Sales</th><th class="r">Taken</th><th class="r">Refunded</th></tr></thead><tbody>${Object.keys(f.staff).sort().map(n => `<tr><td>${esc(n)}</td><td class="r">${f.staff[n].sales}</td><td class="r">${esc(money(f.staff[n].taken, cur))}</td><td class="r">${f.staff[n].refunds ? esc(money(f.staff[n].refunds, cur)) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}
        <div class="card-actions"><button class="btn ghost" data-act="till-cash-in">Cash in</button><button class="btn ghost" data-act="till-cash-out">Cash out</button><button class="btn ghost" data-act="till-x">X report</button><button class="btn primary" data-act="till-close">Close register</button></div></div>`;
  }
  const hist = closedShifts();
  return top + `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
    <thead><tr><th>Cash-up</th><th>Opened</th><th>Closed</th><th class="r">Sales</th><th class="r">Taken</th><th class="r">Expected</th><th class="r">Counted</th><th class="r">Difference</th><th></th></tr></thead>
    <tbody>${hist.length ? hist.slice(0, 100).map(x => { const g = x.figures || {}; const v = Number(x.variance) || 0; return `<tr><td><strong>${esc(x.no)}</strong></td><td>${esc(when(x.openedAt))}<div class="muted">${esc(x.openedBy || '')}</div></td><td>${esc(when(x.closedAt))}<div class="muted">${esc(x.closedBy || '')}</div></td>
      <td class="r">${g.count || 0}</td><td class="r">${esc(money(g.taken || 0, cur))}</td><td class="r">${esc(money(x.expected, cur))}</td><td class="r">${esc(money(x.counted, cur))}</td>
      <td class="r ${Math.abs(v) > 0.005 ? 'bad' : 'good'}">${v > 0 ? 'over ' : v < 0 ? 'short ' : ''}${esc(money(Math.abs(v), cur))}</td><td class="r"><button class="btn ghost sm" data-act="till-z" data-id="${esc(x.id)}">Z report</button></td></tr>`; }).join('') : '<tr><td colspan="9" class="muted">No cash-ups yet.</td></tr>'}</tbody></table></div>`;
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
