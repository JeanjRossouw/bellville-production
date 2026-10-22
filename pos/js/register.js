// Retail POS — the Register tab: open the shift with a float counted by
// denomination, see the X-report while it runs, move cash in or out with a
// reason (a supervisor's PIN when the cashier is not one), and close with a
// blind count, the variance per method, a manager's note and PIN when the
// cash is out by more than the limit, the Z-report, and the daily summary
// to the owner by WhatsApp or email.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, openPrint, money, niceDate, niceTime } from './ui.js';
import { centsOf, randsOf } from './money.js';
import { whatsappUrl, mailtoUrl } from './receipt.js';
import { icon } from './icons.js';

export const DENOMS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];
const METHODS = [['cash', 'Cash'], ['card', 'Card'], ['eft', 'EFT'], ['qr', 'QR'], ['voucher', 'Gift vouchers'], ['storeCredit', 'Store credit'], ['account', 'On account']];
export const reg = { state: null, loading: false, lastZ: null, stale: true };   // state: { register, shift, figures, varianceLimitCents }; stale: read it again on the next look
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const where = () => { const dev = auth.session.device; const d = ctx.data(); return dev ? auth.deviceBody() : { entityId: d.entity && d.entity.id, storeId: d.store && d.store.id, registerId: d.registerId || '' }; };
export const registerId = () => (auth.session.device && auth.session.device.registerId) || '';
// is the register open? true when there is no register to open (the office)
export const canSell = () => !registerId() || !!(reg.state && reg.state.shift);

export async function refresh() {
  if (!registerId() || reg.loading) return;
  reg.loading = true; reg.stale = false;
  try { reg.state = await auth.api('status', where(), API.shift); } catch (e) { if (!e.offline) toast(e.message, 'warn'); }
  reg.loading = false; ctx.repaint();
}

// ------------------------------------------------------------- counting --
function countGrid(prefix, values = {}) {
  return `<div class="den-grid">${DENOMS.map(d => `<label><span>${esc(money(d).replace('.00', ''))}</span><input type="number" min="0" inputmode="numeric" data-den="${d}" value="${values[String(d)] || ''}" placeholder="0"></label>`).join('')}</div>
    <div class="den-total">Counted <strong id="${prefix}-total">R 0.00</strong></div>`;
}
function readGrid(w) {
  const denoms = {}; let total = 0;
  w.querySelectorAll('[data-den]').forEach(i => { const n = Math.max(0, Math.round(Number(i.value) || 0)); if (n) { denoms[i.dataset.den] = n; total += n * Number(i.dataset.den); } });
  return { denoms, totalCents: total };
}
const liveTotal = (w, prefix) => { const el = w.querySelector('#' + prefix + '-total'); if (el) el.textContent = money(readGrid(w).totalCents); };

// ----------------------------------------------------------------- html --
export function registerHtml() {
  if (!registerId()) return `<div class="page-head"><h1>Register</h1></div><div class="card muted">This device has no register. ${auth.atLeast('manager') ? 'Enrol it against one under Admin → Devices.' : 'Ask a manager.'}</div>`;
  const st = reg.state;
  if (reg.stale && !reg.loading) refresh();        // a sale or a tab change since the last look: fresh figures
  if (!st) return `<div class="page-head"><h1>Register</h1></div><div class="card muted">Checking the register…</div>`;
  if (!st.shift) return `<div class="page-head"><h1>${esc(st.register.name)}</h1><p class="sub">Closed</p></div>
    <div class="card"><h2>Open the register</h2><p class="muted">Count the float in the drawer.</p>${countGrid('op')}
      <div class="card-actions"><button class="btn primary" data-act="rg-open">Open with this float</button></div></div>
    ${reg.lastZ ? `<div class="card"><h2>Last close</h2>${zHtml(reg.lastZ)}<div class="card-actions"><button class="btn ghost" data-act="rg-z-print">Print Z-report</button><button class="btn ghost" data-act="rg-z-send">Send the summary</button></div></div>` : ''}`;
  const f = st.figures, sh = st.shift;
  return `<div class="page-head"><h1>${esc(st.register.name)}</h1><p class="sub">Open since ${esc(niceTime(sh.openedAt))} by ${esc(sh.openedByName)} · float ${esc(money(sh.openingFloat.totalCents))}</p></div>
    <div class="grid two">
      <div class="card"><h2>X-report (so far)</h2>${xHtml(f, sh)}</div>
      <div class="card"><h2>Cash drawer</h2>
        <div class="x-row"><span>Expected cash in the drawer</span><strong>${esc(money(f.expectedCash))}</strong></div>
        <p class="muted">Float ${esc(money(sh.openingFloat.totalCents))} + cash sales ${esc(money(f.byMethod.cash))} + in ${esc(money(f.cashIn))} − out ${esc(money(f.cashOut))}.</p>
        ${f.cashMoves.length ? `<ul class="cm-list">${f.cashMoves.map(m => `<li>${m.kind === 'in' ? '＋' : '−'} ${esc(money(m.amountCents))} · ${esc(m.reason)} <span class="muted">${esc(m.by)} ${esc(niceTime(m.at))}</span></li>`).join('')}</ul>` : ''}
        <div class="card-actions"><button class="btn" data-act="rg-cash" data-kind="in">Cash in</button><button class="btn" data-act="rg-cash" data-kind="out">Cash out</button><button class="btn ghost" data-act="rg-x-print">Print X-report</button></div>
      </div>
    </div>
    <div class="card"><h2>Close the register</h2><p class="muted">Count the drawer first, without looking at the expected figures; then the totals from the card machine and the bank.</p>
      <div class="card-actions"><button class="btn primary" data-act="rg-close">Count and close</button></div></div>`;
}
function xHtml(f, sh) {
  return `<div class="x-row"><span>Sales</span><strong>${f.salesCount} · ${esc(money(f.salesTotalCents))}</strong></div>
    <div class="x-row muted"><span>of which VAT</span><span>${esc(money(f.vatCents))}</span></div>
    ${f.discountCents ? `<div class="x-row muted"><span>Discounts given</span><span>${esc(money(f.discountCents))}</span></div>` : ''}
    ${f.awaitingCents ? `<div class="x-row warn"><span>EFT awaiting</span><span>${esc(money(f.awaitingCents))}</span></div>` : ''}
    <div class="hr"></div>
    ${METHODS.filter(([k]) => f.byMethod[k]).map(([k, l]) => `<div class="x-row"><span>${esc(l)}</span><span>${esc(money(f.byMethod[k]))}</span></div>`).join('') || '<div class="muted">No sales yet</div>'}
    ${f.firstSaleAt ? `<p class="muted" style="margin-top:.5rem">First sale ${esc(niceTime(f.firstSaleAt))}, last ${esc(niceTime(f.lastSaleAt))}.</p>` : ''}`;
}
export function zHtml(z) {
  const v = (c) => c == null ? '<span class="muted">not counted</span>' : (c > 0 ? '+' : '') + money(c);
  return `<p class="muted">${esc(niceDate(z.openedAt))} ${esc(niceTime(z.openedAt))} – ${esc(niceTime(z.closedAt))} · opened by ${esc(z.openedByName)}, closed by ${esc(z.closedByName)}</p>
    <div class="x-row"><span>Sales</span><strong>${z.salesCount} · ${esc(money(z.salesTotalCents))}</strong></div><div class="x-row muted"><span>of which VAT</span><span>${esc(money(z.vatCents))}</span></div>
    ${z.discountCents ? `<div class="x-row muted"><span>Discounts</span><span>${esc(money(z.discountCents))}</span></div>` : ''}
    <table class="tbl z-tbl"><thead><tr><th>Method</th><th class="r">Expected</th><th class="r">Counted</th><th class="r">Variance</th></tr></thead><tbody>
      ${METHODS.filter(([k]) => k === 'cash' || z.expectedByMethod[k] || z.countedByMethod[k] != null).map(([k, l]) => `<tr><td>${esc(l)}${k === 'cash' ? `<div class="muted">float ${esc(money(z.openingFloatCents))} · in ${esc(money(z.cashIn))} · out ${esc(money(z.cashOut))}</div>` : ''}</td><td class="r">${esc(money(z.expectedByMethod[k]))}</td><td class="r">${z.countedByMethod[k] == null ? '' : esc(money(z.countedByMethod[k]))}</td><td class="r ${z.varianceByMethod[k] ? (Math.abs(z.varianceByMethod[k]) > (k === 'cash' ? z.varianceLimitCents : 0) ? 'warn' : '') : ''}">${v(z.varianceByMethod[k])}</td></tr>`).join('')}
    </tbody></table>
    ${z.note ? `<p><strong>Note:</strong> ${esc(z.note)}</p>` : ''}`;
}
export const zText = (z, regName, storeName) => `Z-report ${regName}${storeName ? ' · ' + storeName : ''}, ${niceDate(z.openedAt)} ${niceTime(z.openedAt)}–${niceTime(z.closedAt)}\nSales ${z.salesCount} · ${money(z.salesTotalCents)} (VAT ${money(z.vatCents)})\n` + METHODS.filter(([k]) => k === 'cash' || z.expectedByMethod[k] || z.countedByMethod[k] != null).map(([k, l]) => `${l}: expected ${money(z.expectedByMethod[k])}${z.countedByMethod[k] == null ? '' : ', counted ' + money(z.countedByMethod[k]) + ', variance ' + money(z.varianceByMethod[k])}`).join('\n') + (z.cashIn || z.cashOut ? `\nCash in ${money(z.cashIn)}, out ${money(z.cashOut)}` : '') + (z.note ? `\nNote: ${z.note}` : '') + `\nClosed by ${z.closedByName}.`;

// -------------------------------------------------------------- actions --
export async function action(act, b) {
  const st = reg.state;
  if (act === 'rg-open') return openShift();
  if (act === 'rg-cash') return cashMove(b.dataset.kind);
  if (act === 'rg-close') return closeShift();
  if (act === 'rg-x-print' && st && st.shift) { openPrint('X-report ' + st.register.name, `<div class="zr"><h2>X-report · ${esc(st.register.name)}</h2>${xHtml(st.figures, st.shift)}</div>`, Z_CSS); return; }
  if (act === 'rg-z-print' && reg.lastZ) return printZ(reg.lastZ, reg.lastZName);
  if (act === 'rg-z-send' && reg.lastZ) return sendZ(reg.lastZ, reg.lastZName, (ctx.data().settings || {}).reports || {});
}
function openShift() {
  const w = document.getElementById('screen');
  const float_ = readGrid(w);
  openModal('Open with a float of ' + money(float_.totalCents), `<p class="muted">${float_.totalCents ? 'This becomes the expected cash before any sale.' : 'No float at all? The drawer starts empty.'}</p>`, {
    okLabel: 'Open', onOk: async () => { try { await auth.api('open', { ...where(), float: float_ }, API.shift); toast('Register open'); reg.stale = true; await refresh(); return true; } catch (e) { toast(e.message, 'warn'); return false; } }
  });
}
const mkId = (p) => p + '-' + (auth.deviceId() || 'web') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
function cashMove(kind) {
  const st = reg.state; if (!st || !st.shift) return;
  openModal(kind === 'in' ? 'Cash in' : 'Cash out', row(field('Amount (R)', 'cm-amount', { inputmode: 'decimal' }), field('Reason', 'cm-reason', { placeholder: kind === 'in' ? 'e.g. Change from the bank' : 'e.g. Cash drop to the safe, petty cash' })) + (auth.atLeast('supervisor') ? '' : '<p class="muted">A supervisor or manager approves with their PIN.</p>'), {
    okLabel: kind === 'in' ? 'Put in' : 'Take out', onOk: async (w) => {
      const amountCents = centsOf(val(w, 'cm-amount')), reason = val(w, 'cm-reason');
      if (!(amountCents > 0) || !reason) { toast('An amount and a reason.', 'warn'); return false; }
      try {
        let approvalToken = '';
        if (!auth.atLeast('supervisor')) { const r = await auth.requireOverride({ minRole: 'supervisor', action: 'cash', details: { kind, amountCents, reason } }); approvalToken = r.token; }
        await auth.api('cashMove', { ...where(), shiftId: st.shift.id, kind, amountCents, reason, approvalToken, moveId: mkId('cm') }, API.shift);
        toast('Cash ' + kind + ' recorded'); await refresh(); return true;
      } catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}
function closeShift() {
  const st = reg.state; if (!st || !st.shift) return;
  const d = ctx.data();
  const others = METHODS.slice(1).filter(([k]) => (d.store && d.store.paymentMethods || ['cash', 'card']).includes(k));
  const { wrap } = openModal('Count the drawer', `<p class="muted">Blind: the expected figures show after the count.</p>${countGrid('cl')}
    <h2 style="margin-top:1rem">From the machines and the bank</h2><div class="grid three">${others.map(([k, l]) => field(l + ' total (R)', 'cl-' + k, { inputmode: 'decimal', placeholder: 'leave blank if not counted' })).join('')}</div>`, {
    okLabel: 'Close the register', onOk: async (w) => {
      const counted = { cash: readGrid(w) };
      others.forEach(([k]) => { const t = val(w, 'cl-' + k); counted[k] = t === '' ? null : centsOf(t); });
      return attemptClose(st, counted, '', '');
    }
  });
  wrap.querySelector('.modal-card').classList.add('wide');
  wrap.addEventListener('input', () => liveTotal(wrap, 'cl'));
}
async function attemptClose(st, counted, note, approvalToken) {
  try {
    const r = await auth.api('close', { ...where(), shiftId: st.shift.id, counted, note, approvalToken }, API.shift);
    const regName = st.register.name;
    reg.lastZ = r.shift.zReport; reg.lastZName = regName; reg.state = null; reg.stale = true;
    toast('Register closed');
    showZ(r.shift.zReport, r.reports || {}, regName);
    refresh();
    return true;
  } catch (e) {
    if (e.status === 400 && /manager's note/.test(e.message)) { askVariance(st, counted, e.message); return true; }
    toast(e.message, 'warn'); return false;
  }
}
// the cash is out by more than the limit: a note and a manager
function askVariance(st, counted, why) {
  openModal('Cash is out of line', `<p>${esc(why)}</p>` + field('What happened', 'vr-note', { type: 'textarea', placeholder: 'e.g. R 50 note given as change by mistake' }), {
    okLabel: auth.atLeast('manager') ? 'Close with this note' : 'Manager approves and closes', onOk: async (w) => {
      const note = val(w, 'vr-note'); if (!note) { toast('Write what happened.', 'warn'); return false; }
      try {
        let token = '';
        if (!auth.atLeast('manager')) { const r = await auth.requireOverride({ minRole: 'manager', action: 'variance', details: { note, countedCashCents: counted.cash.totalCents } }); token = r.token; }
        return attemptClose(st, counted, note, token);
      } catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}
function showZ(z, reports, regName) {
  regName = regName || (reg.state && reg.state.register && reg.state.register.name) || reg.lastZName || 'Register';
  openModal('Z-report · ' + regName, zHtml(z) + `<div class="card-actions"><button class="btn" data-z="print">${icon('printer')} Print</button><button class="btn" data-z="wa">WhatsApp the owner</button><button class="btn" data-z="mail">Email the owner</button></div>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true });
  document.getElementById('modal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'print') printZ(z, regName);
    else sendZ(z, regName, reports, b.dataset.z);
  });
}
const Z_CSS = `.zr{max-width:90mm;margin:0 auto;font:12px/1.4 Arial,sans-serif}.zr h2{font-size:14px}.x-row{display:flex;justify-content:space-between;padding:2px 0}.hr{border-top:1px dashed #000;margin:4px 0}.z-tbl{width:100%;border-collapse:collapse;margin-top:6px}.z-tbl th,.z-tbl td{padding:3px 4px;border-bottom:1px solid #ccc;text-align:left;font-size:11px}.z-tbl .r{text-align:right}.muted{color:#555}.warn{color:#b00}`;
function printZ(z, regName) { openPrint('Z-report', `<div class="zr"><h2>Z-report · ${esc(regName || '')}</h2>${zHtml(z)}</div>`, Z_CSS); }
function sendZ(z, regName, reports = {}, how = 'wa') {
  const d = ctx.data();
  const text = zText(z, regName || '', d.store && d.store.name);
  if (how === 'mail') { const email = prompt('Owner’s email', reports.email || ''); if (email) window.open(mailtoUrl(email, 'Z-report ' + (regName || '') + ' ' + niceDate(z.closedAt), text), '_blank'); }
  else { const phone = prompt('Owner’s WhatsApp number', reports.phone || ''); if (phone) window.open(whatsappUrl(phone, text), '_blank'); }
}
export function wireScreen(screen) {
  screen.addEventListener('input', (e) => { if (e.target.matches('[data-den]')) liveTotal(screen, 'op'); });
}
