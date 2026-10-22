// Retail POS — the Lay-bys tab. A new lay-by is opened from the cart: the
// deposit, the term and schedule, the agreement with the cancellation
// penalty shown before the customer signs on the screen. Then instalments
// at any till with a receipt, reminders by WhatsApp, collection into a tax
// invoice and a collection slip, cancellation with the penalty breakdown
// and the refund, and the lay-by report. The server (pos-layby) writes it all.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, openPrint, money, niceDate, niceTime, empty } from './ui.js';
import { centsOf, randsOf, pctOf } from './money.js';
import { laybySettings, schedule, dueDate, expectedBy, penaltyFor, agreementText, CANCEL_KINDS, NO_PENALTY, FREQ_LABEL, PENALTY_CAP_PCT } from './layby-terms.js';
import { openReceipt } from './receiptui.js';
import { whatsappUrl, A4_CSS } from './receipt.js';
import { padHtml, wirePad } from './signpad.js';
import { icon } from './icons.js';

export const lb = { filter: 'open', q: '', busy: false };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();   // { store, entity, settings, laybys, registerId, shiftOpen }
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const today = () => new Date().toISOString().slice(0, 10);
const newId = (p) => p + '-' + (auth.deviceId() || 'web') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const stateOf = (l) => l.status !== 'open' ? l.status : l.balanceCents <= 0 ? 'ready' : l.dueAt < today() ? 'overdue' : l.paidCents < expectedBy(l, today()) ? 'behind' : 'open';
const STATE = { open: ['On track', ''], behind: ['Behind', 'late'], overdue: ['Overdue', 'late'], ready: ['Ready to collect', 'ok'], completed: ['Collected', ''], cancelled: ['Cancelled', 'off'] };
const METHOD = { cash: 'Cash', card: 'Card', eft: 'EFT', qr: 'QR', storeCredit: 'Store credit' };
const kindLabel = (k) => (CANCEL_KINDS.find(x => x[0] === k) || [k, k])[1];
const nextDue = (l) => (l.schedule || []).find(x => x.dueAt >= today()) || null;
const one = (id) => (d().laybys || []).find(l => l.id === id);

// ---------------------------------------------------------------- html --
export function laybysHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Lay-bys</h1></div><div class="card muted">Pick a store first.</div>`;
  const all = (dd.laybys || []).map(l => ({ ...l, state: stateOf(l) }));
  const q = lb.q.trim().toLowerCase();
  const rows = all.filter(l => (lb.filter === 'all' || (lb.filter === 'open' ? l.status === 'open' : l.state === lb.filter)) && (!q || [l.docNo, l.customerSnapshot && l.customerSnapshot.name, l.customerSnapshot && l.customerSnapshot.phone].some(x => String(x || '').toLowerCase().includes(q))))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(a.dueAt).localeCompare(String(b.dueAt)));
  const open = all.filter(l => l.status === 'open');
  const count = (st) => all.filter(l => l.state === st).length;
  return `<div class="page-head"><h1>Lay-bys</h1><p class="sub">${open.length} open · ${esc(money(open.reduce((n, l) => n + l.balanceCents, 0)))} still to come in${count('behind') ? ' · ' + count('behind') + ' behind' : ''}${count('overdue') ? ' · ' + count('overdue') + ' overdue' : ''}${count('ready') ? ' · ' + count('ready') + ' ready to collect' : ''}</p></div>
    <div class="toolbar">
      <input id="lb-q" class="search" type="search" placeholder="Number, customer, phone" value="${esc(lb.q)}">
      <select id="lb-filter">${[['open', 'Open'], ['behind', 'Behind'], ['overdue', 'Overdue'], ['ready', 'Ready to collect'], ['completed', 'Collected'], ['cancelled', 'Cancelled'], ['all', 'All']].map(x => `<option value="${x[0]}"${lb.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>
      ${auth.atLeast('supervisor') ? `<button class="btn ghost sm" data-act="lb-report">${icon('chart')} Report</button>` : ''}
      <span class="muted">New lay-bys start from the cart under Sell.</span>
    </div>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl lb-tbl"><thead><tr><th>No</th><th>Customer</th><th>Opened</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>State</th><th></th></tr></thead>
      <tbody>${rows.map(l => `<tr class="${l.status !== 'open' ? 'off' : ''}"><td><strong>${esc(l.docNo)}</strong></td><td>${esc(l.customerSnapshot ? l.customerSnapshot.name : '')}<div class="muted">${esc(l.customerSnapshot ? l.customerSnapshot.phone : '')}</div></td><td class="muted">${esc(niceDate(l.openedAt))}</td><td class="muted">${esc(niceDate(l.dueAt))}</td><td class="r">${esc(money(l.totalCents))}</td><td class="r">${esc(money(l.paidCents))}</td><td class="r"><strong>${esc(money(l.balanceCents))}</strong></td><td><span class="chip ${STATE[l.state][1]}">${STATE[l.state][0]}</span></td><td class="r"><button class="btn ghost sm" data-act="lb-open" data-id="${esc(l.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`
      : empty(lb.filter === 'open' ? 'No open lay-bys' : 'Nothing here', lb.filter === 'open' ? 'Ring the goods up under Sell, add the customer, and tap Lay-by.' : '')}`;
}

// ------------------------------------------------------------ actions --
export async function action(act, b) {
  const id = b.dataset.id;
  if (act === 'lb-open') return openDetail(id);
  if (act === 'lb-report') return report();
  if (act === 'lb-pay') return pay(id);
  if (act === 'lb-collect') return collect(id);
  if (act === 'lb-cancel') return cancel(id);
  if (act === 'lb-remind') return remind(id);
  if (act === 'lb-print-agreement') { const l = one(id); if (l) openReceipt(docOf(l, 'agreement')); return; }
  if (act === 'lb-print-collection') { const l = one(id); if (l) openReceipt(docOf(l, 'collection')); return; }
  if (act === 'lb-print-cancel') { const l = one(id); if (l) openReceipt(docOf(l, 'cancel')); return; }
}
export function onInput(id, value) { if (id === 'lb-q') { lb.q = value; ctx.repaint(); const q = document.getElementById('lb-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } }
export function onChange(e) { if (e.target.id === 'lb-filter') { lb.filter = e.target.value; ctx.repaint(); } }

// ------------------------------------------------------- the documents --
// a lay-by as the receipt module prints it: the agreement, an instalment receipt, the collection slip, the cancellation
export function docOf(l, docKind, extra = {}) {
  const dd = d();
  const base = { ...l, id: l.id, series: 'LB', docKind, clientCreatedAt: l.openedAt, cashierName: l.cashierName, customerSnapshot: l.customerSnapshot, entity: dd.entity, store: dd.store, settings: dd.settings };
  const sched = (l.schedule || []).map(x => [`Instalment ${x.n} by ${niceDate(x.dueAt)}`, money(x.amountCents)]);
  if (docKind === 'agreement') return { sale: { ...base, terms: l.agreement.text, signature: l.agreement.signature, signedBy: l.agreement.signedBy, sections: [{ title: 'Payment plan', rows: [['Deposit paid', money(l.depositCents)], ...sched, ['Balance', money(l.balanceCents), true]] }] }, lines: l.lines, payments: [], entity: dd.entity, store: dd.store, settings: dd.settings, copy: !!extra.copy };
  if (docKind === 'payment') { const n = nextDue({ ...l, schedule: l.schedule }); return { sale: { ...base, clientCreatedAt: extra.at, cashierName: auth.session.user.name, noTotals: true, changeCents: extra.changeCents || 0, refLabel: `Lay-by ${l.docNo} · ${l.customerSnapshot.name}`, sections: [{ title: '', rows: [['Paid now', money(extra.amountCents), true], ['Paid so far', money(l.paidCents)], ['Balance', money(l.balanceCents), true], ...(l.balanceCents > 0 && n ? [['Next due', niceDate(n.dueAt) + ' · ' + money(n.amountCents)]] : l.balanceCents <= 0 ? [['Paid in full', 'ready to collect']] : [])] }] }, lines: [], payments: extra.payments || [], entity: dd.entity, store: dd.store, settings: dd.settings }; }
  if (docKind === 'collection') return { sale: { ...base, clientCreatedAt: l.completedAt || new Date().toISOString(), cashierName: l.completedByName || auth.session.user.name, sections: [{ title: '', rows: [['Paid in full', money(l.paidCents)], ...(l.completedDocNo ? [['Tax invoice', l.completedDocNo]] : [])] }], signLine: 'I have received the goods above in good order.' }, lines: l.lines, payments: [], entity: dd.entity, store: dd.store, settings: dd.settings };
  const pb = l.penaltyBreakdown || penaltyFor(l, l.cancelKind);
  return { sale: { ...base, clientCreatedAt: l.cancelledAt || new Date().toISOString(), cashierName: l.cancelledByName || auth.session.user.name, noTotals: true, refLabel: `Lay-by ${l.docNo} · ${l.customerSnapshot.name} · ${kindLabel(l.cancelKind)}${l.cancelReason ? ' · ' + l.cancelReason : ''}`,
    sections: [{ title: 'Penalty breakdown', rows: [['Full price', money(pb.fullPriceCents)], ['Paid in', money(pb.paidCents)], [`Penalty agreed: ${pb.penaltyPct}% of the full price`, money(pb.computedCents)], [`Legal cap: ${pb.capPct}% of the full price`, money(pb.capCents)], ...(pb.waivedWhy ? [['Waived', pb.waivedWhy]] : []), ['Penalty charged', money(pb.chargedCents), true], ['Refunded', money(pb.refundCents), true], ...(l.refunds || []).map(r => ['Refund by ' + (METHOD[r.method] || r.method), money(r.amountCents)])] }],
    terms: 'Cancellation under section 62 of the Consumer Protection Act 68 of 2008 and regulation 35: the penalty may not exceed 1% of the full price and is not charged on the death or hospitalisation of the consumer. The goods are no longer reserved.' }, lines: [], payments: [], entity: dd.entity, store: dd.store, settings: dd.settings };
}

// --------------------------------------------------------------- new --
// from the cart: openNew(cart, totals, onDone)
export function openNew(cart, t, onDone) {
  const dd = d();
  if (!cart.customer) return toast('A lay-by needs the customer: add them to the sale first.', 'warn');
  if (cart.lines.some(l => l.type === 'mto')) return toast('Made-to-order goods go on a special order, not a lay-by.', 'warn');
  const ls = laybySettings(dd.settings);
  const methods = (dd.store.paymentMethods || ['cash', 'card']).filter(k => METHOD[k] && (k !== 'storeCredit' || (cart.customer.storeCreditCents > 0)));
  const minDep = pctOf(t.totalCents, ls.minDepositPct);
  let busy = false, pad = null;
  const { wrap, close } = openModal('Lay-by for ' + cart.customer.name, `
    <div class="lb-new">
      <div class="lb-new-left">
        <div class="muted">${t.pieces} item${t.pieces === 1 ? '' : 's'} · <strong>${esc(money(t.totalCents))}</strong>${cart.customer.phone ? ' · ' + esc(cart.customer.phone) : ' · <span class="warn">no phone number for reminders</span>'}</div>
        ${row(field('Deposit (R)', 'lb-dep', { value: randsOf(minDep), inputmode: 'decimal' }), field('Paid by', 'lb-method', { type: 'select', value: methods[0], options: methods.map(k => ({ value: k, label: METHOD[k] })) }))}
        <div id="lb-cashrow">${row(field('Cash given (R)', 'lb-given', { value: randsOf(minDep), inputmode: 'decimal' }), field('Card last 4 / reference', 'lb-ref', { placeholder: '' }))}</div>
        ${row(field('Term (days, up to ' + ls.termDays + ')', 'lb-term', { value: ls.termDays, type: 'number', min: 7, max: ls.termDays }), field('Instalments', 'lb-freq', { type: 'select', value: ls.frequency, options: [{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Every two weeks' }, { value: 'monthly', label: 'Monthly' }] }))}
        <div class="card lb-sched" id="lb-sched"></div>
      </div>
      <div class="lb-new-right">
        <div class="lb-terms" id="lb-terms"></div>
        ${field('Customer’s name as signed', 'lb-signby', { value: cart.customer.name })}
        ${padHtml('lb-pad')}
        <label class="chk"><input type="checkbox" id="lb-accept"> The customer has read the agreement, including the cancellation penalty, and agrees to it</label>
      </div>
    </div>`, { okLabel: 'Open lay-by', cancelLabel: 'Back', onOk: () => submit() });
  wrap.querySelector('.modal-card').classList.add('wide');
  pad = wirePad(wrap.querySelector('#lb-pad'));
  const draft = () => {
    const dep = Math.min(t.totalCents, Math.max(0, centsOf(val(wrap, 'lb-dep'))));
    const termDays = Math.min(ls.termDays, Math.max(7, Number(val(wrap, 'lb-term')) || ls.termDays));
    const frequency = val(wrap, 'lb-freq') || ls.frequency;
    const openedAt = new Date().toISOString();
    const bal = t.totalCents - dep;
    return { dep, termDays, frequency, docNo: (dd.entity.laybyPrefix || dd.entity.invoicePrefix + '-LB') + '-(new)', customerSnapshot: { name: cart.customer.name }, lines: t.lines, totalCents: t.totalCents, vatRegistered: !!dd.entity.vatRegistered, depositCents: dep, balanceCents: bal, schedule: schedule(bal, openedAt, termDays, frequency), dueAt: dueDate(openedAt, termDays), penaltyPct: ls.penaltyPct, penaltyCapCents: pctOf(t.totalCents, PENALTY_CAP_PCT), frequency };
  };
  const preview = () => {
    const x = draft();
    wrap.querySelector('#lb-cashrow').hidden = val(wrap, 'lb-method') !== 'cash' && !/card|eft|qr/.test(val(wrap, 'lb-method'));
    wrap.querySelector('#lb-given').closest('.fld').hidden = val(wrap, 'lb-method') !== 'cash';
    wrap.querySelector('#lb-sched').innerHTML = `<div class="x-row"><span>Deposit${x.dep < minDep ? ` <span class="warn">(at least ${esc(money(minDep))})</span>` : ''}</span><strong>${esc(money(x.dep))}</strong></div>` + x.schedule.map(s => `<div class="x-row"><span>Instalment ${s.n} by ${esc(niceDate(s.dueAt))}</span><span>${esc(money(s.amountCents))}</span></div>`).join('') + `<div class="x-row tot"><span>Balance after the deposit</span><strong>${esc(money(x.balanceCents))}</strong></div>`;
    wrap.querySelector('#lb-terms').textContent = agreementText(dd.entity, x);
  };
  wrap.addEventListener('input', preview); wrap.addEventListener('change', preview); preview();
  async function submit() {
    if (busy) return false;
    const x = draft();
    if (x.dep < minDep) { toast(`The deposit must be at least ${money(minDep)} (${ls.minDepositPct}%).`, 'warn'); return false; }
    if (!wrap.querySelector('#lb-accept').checked) { toast('Tick that the customer agrees to the terms.', 'warn'); return false; }
    const signedBy = val(wrap, 'lb-signby'); if (!signedBy) { toast('The customer’s name, as signed.', 'warn'); return false; }
    if (pad.isEmpty()) { toast('The customer signs in the box.', 'warn'); return false; }
    const method = val(wrap, 'lb-method');
    const tender = { method, amountCents: x.dep, ref: val(wrap, 'lb-ref') };
    if (method === 'cash') { tender.tenderedCents = centsOf(val(wrap, 'lb-given')); if (tender.tenderedCents < x.dep) { toast('Cash given is short.', 'warn'); return false; } }
    if (method === 'card') tender.cardLast4 = val(wrap, 'lb-ref').replace(/\D/g, '').slice(-4);
    busy = true;
    const body = {
      laybyId: newId('lb'), clientCreatedAt: new Date().toISOString(), customerId: cart.customerId,
      lines: cart.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, priceOverride: l.priceOverride ? { reason: l.priceOverride.reason, token: l.priceOverride.token } : null, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, discountToken: l.discountToken || '', note: l.note, custom: !!l.custom, name: l.name, vatClass: l.vatClass })),
      saleDiscountCents: cart.discountCents || 0, saleDiscountPct: cart.discountPct || 0, saleDiscountReason: cart.discountReason || '', saleDiscountToken: cart.discountToken || '', note: cart.note || '',
      totals: { totalCents: t.totalCents, vatCents: t.vatCents }, termDays: x.termDays, frequency: x.frequency, deposit: [tender],
      agreement: { accepted: true, signedBy, signature: pad.dataUrl() }, ...where()
    };
    try {
      const r = await auth.api('open', body, API.layby);
      close(true); onDone && onDone(r);
      toast('Lay-by ' + r.layby.docNo + ' opened' + (r.payments && r.payments[0] && r.payments[0].changeCents ? ' · change ' + money(r.payments[0].changeCents) : ''));
      openReceipt(docOf(r.layby, 'agreement'));
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(e.offline ? 'A lay-by needs the line: try again when connected.' : e.message, 'warn'); return false; }
  }
}

// ------------------------------------------------------------ detail --
function openDetail(id) {
  const l = one(id); if (!l) return;
  const st = stateOf(l), ag = l.agreement || {};
  const paidTo = (() => { let left = l.paidCents - l.depositCents; return (l.schedule || []).map(s => { const covered = left >= s.amountCents; left -= s.amountCents; return covered; }); })();
  openModal(l.docNo + ' · ' + l.customerSnapshot.name, `
    <div class="lb-detail">
      <div class="lb-head"><span class="chip ${STATE[st][1]}">${STATE[st][0]}</span><span class="muted">Opened ${esc(niceDate(l.openedAt))} by ${esc(l.cashierName)} · due ${esc(niceDate(l.dueAt))} · ${esc(l.customerSnapshot.phone || 'no phone')}</span></div>
      <table class="tbl"><tbody>${l.lines.map(x => `<tr><td>${esc(x.name)}</td><td class="r">${x.qty} × ${esc(money(x.unitPriceCents))}</td><td class="r">${esc(money(x.netCents != null ? x.netCents : x.lineTotalCents))}</td></tr>`).join('')}
        <tr><td colspan="2" class="r"><strong>Full price</strong></td><td class="r"><strong>${esc(money(l.totalCents))}</strong></td></tr></tbody></table>
      <div class="lb-cols">
        <div><h3>Schedule</h3><div class="x-row"><span>Deposit</span><span>${esc(money(l.depositCents))} ✓</span></div>${(l.schedule || []).map((s, i) => `<div class="x-row${paidTo[i] ? ' done' : s.dueAt < today() && l.balanceCents > 0 ? ' late' : ''}"><span>${s.n}. by ${esc(niceDate(s.dueAt))}</span><span>${esc(money(s.amountCents))}${paidTo[i] ? ' ✓' : ''}</span></div>`).join('')}
          <div class="x-row tot"><span>Paid ${esc(money(l.paidCents))} · balance</span><strong>${esc(money(l.balanceCents))}</strong></div></div>
        <div><h3>Payments</h3>${(l.history || []).map(h => `<div class="x-row"><span>${esc(niceDate(h.at))} ${h.n ? 'instalment ' + h.n : 'deposit'} · ${esc(h.methods.map(m => METHOD[m] || m).join(', '))}${h.storeId !== l.storeId ? ' · ' + esc(h.storeId) : ''}</span><span>${esc(money(h.amountCents))}</span></div>`).join('')}
          ${(l.reminders || []).length ? `<p class="muted">${l.reminders.length} reminder${l.reminders.length === 1 ? '' : 's'} sent, last ${esc(niceDate(l.lastReminderAt))}</p>` : ''}
          ${l.status === 'cancelled' ? `<p class="warn">Cancelled ${esc(niceDate(l.cancelledAt))}: ${esc(kindLabel(l.cancelKind))}${l.cancelReason ? ' · ' + esc(l.cancelReason) : ''}. Penalty ${esc(money(l.penaltyCents))}, refunded ${esc(money(l.refundedCents))}.</p>` : ''}
          ${l.status === 'completed' ? `<p class="ok">Collected ${esc(niceDate(l.completedAt))} · tax invoice ${esc(l.completedDocNo || '')}</p>` : ''}</div>
      </div>
      <p class="muted">Agreement signed by ${esc(ag.signedBy || '')} on ${esc(niceDate(ag.acceptedAt))} · penalty ${l.penaltyPct}% of the full price (${esc(money(l.penaltyCapCents))}) if cancelled; none on death or hospitalisation.</p>
      <div class="card-actions lb-acts">
        ${l.status === 'open' && l.balanceCents > 0 ? `<button class="btn primary" data-act="lb-pay" data-id="${esc(l.id)}">${icon('cash')} Take a payment</button>` : ''}
        ${l.status === 'open' && l.balanceCents <= 0 ? `<button class="btn primary" data-act="lb-collect" data-id="${esc(l.id)}">${icon('box')} Hand over: tax invoice + collection slip</button>` : ''}
        ${l.status === 'open' ? `<button class="btn" data-act="lb-remind" data-id="${esc(l.id)}">${icon('user')} Remind by WhatsApp</button><button class="btn ghost" data-act="lb-cancel" data-id="${esc(l.id)}">Cancel lay-by</button>` : ''}
        <button class="btn ghost" data-act="lb-print-agreement" data-id="${esc(l.id)}">${icon('printer')} Agreement</button>
        ${l.status === 'completed' ? `<button class="btn ghost" data-act="lb-print-collection" data-id="${esc(l.id)}">${icon('printer')} Collection slip</button>` : ''}
        ${l.status === 'cancelled' ? `<button class="btn ghost" data-act="lb-print-cancel" data-id="${esc(l.id)}">${icon('printer')} Cancellation</button>` : ''}
      </div>
    </div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
}
// the detail's buttons live in the modal: the app's click handler passes them here
function fresh(id, r) { if (r && r.layby) { const list = d().laybys || []; const i = list.findIndex(x => x.id === id); if (i >= 0) list[i] = { ...list[i], ...r.layby }; } return one(id) || (r && r.layby); }

// ------------------------------------------------------------- pay --
function pay(id) {
  const l = one(id); if (!l) return;
  const dd = d();
  if (dd.registerId && !dd.shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
  const methods = (dd.store.paymentMethods || ['cash', 'card']).filter(k => METHOD[k] && k !== 'storeCredit');
  const n = nextDue(l); const suggested = Math.min(l.balanceCents, n ? Math.max(0, expectedBy(l, n.dueAt) - l.paidCents) || n.amountCents : l.balanceCents);
  let busy = false;
  const { wrap, close } = openModal('Payment on ' + l.docNo, `
    <div class="muted">${esc(l.customerSnapshot.name)} · balance <strong>${esc(money(l.balanceCents))}</strong>${n ? ' · next ' + esc(money(n.amountCents)) + ' by ' + esc(niceDate(n.dueAt)) : ''}</div>
    ${row(field('Amount (R)', 'lp-amount', { value: randsOf(suggested || l.balanceCents), inputmode: 'decimal' }), field('Paid by', 'lp-method', { type: 'select', value: methods[0], options: methods.map(k => ({ value: k, label: METHOD[k] })) }))}
    ${row(field('Cash given (R)', 'lp-given', { value: randsOf(suggested || l.balanceCents), inputmode: 'decimal' }), field('Card last 4 / reference', 'lp-ref', {}))}
    <div class="pay-quick"><button class="btn ghost sm" type="button" data-lp="${l.balanceCents}">The whole balance</button>${n ? `<button class="btn ghost sm" type="button" data-lp="${n.amountCents}">This instalment</button>` : ''}</div>
    <div class="pay-change-live" id="lp-change"></div>`, { okLabel: 'Take payment', cancelLabel: 'Back', onOk: () => submit() });
  const live = () => { const m = val(wrap, 'lp-method'); wrap.querySelector('#lp-given').closest('.fld').hidden = m !== 'cash'; const a = centsOf(val(wrap, 'lp-amount')), g = centsOf(val(wrap, 'lp-given')); wrap.querySelector('#lp-change').textContent = m === 'cash' && g >= a && a > 0 ? 'Change ' + money(g - a) : m === 'cash' && a > 0 && g < a ? 'Short by ' + money(a - g) : ''; };
  wrap.addEventListener('input', live); wrap.addEventListener('change', live); live();
  wrap.addEventListener('click', (e) => { const q = e.target.closest('[data-lp]'); if (q) { wrap.querySelector('#lp-amount').value = randsOf(Number(q.dataset.lp)); wrap.querySelector('#lp-given').value = randsOf(Number(q.dataset.lp)); live(); } });
  async function submit() {
    if (busy) return false;
    const amount = centsOf(val(wrap, 'lp-amount')); const method = val(wrap, 'lp-method');
    if (!(amount > 0)) { toast('How much?', 'warn'); return false; }
    if (amount > l.balanceCents) { toast('Only ' + money(l.balanceCents) + ' is owed.', 'warn'); return false; }
    const tender = { method, amountCents: amount, ref: val(wrap, 'lp-ref') };
    if (method === 'cash') { tender.tenderedCents = centsOf(val(wrap, 'lp-given')); if (tender.tenderedCents < amount) { toast('Cash given is short.', 'warn'); return false; } }
    if (method === 'card') tender.cardLast4 = val(wrap, 'lp-ref').replace(/\D/g, '').slice(-4);
    busy = true;
    try {
      const r = await auth.api('pay', { laybyId: l.id, paymentId: newId('lp'), tenders: [tender], clientCreatedAt: new Date().toISOString(), ...where() }, API.layby);
      close(true);
      const after = fresh(id, r);
      const pays = r.payments || []; const chg = pays[0] && pays[0].changeCents || 0;
      toast('Paid ' + money(amount) + ' on ' + l.docNo + (chg ? ' · change ' + money(chg) : '') + (after.balanceCents <= 0 ? ' · paid in full, ready to collect' : ''));
      openReceipt(docOf(after, 'payment', { at: r.paidAt || new Date().toISOString(), amountCents: amount, payments: pays, changeCents: chg }));
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(e.offline ? 'A lay-by payment needs the line: try again when connected.' : e.message, 'warn'); return false; }
  }
}

// --------------------------------------------------------- collect --
async function collect(id) {
  const l = one(id); if (!l) return;
  const dd = d();
  if (dd.registerId && !dd.shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
  if (!confirm(`Hand over ${l.docNo} to ${l.customerSnapshot.name}? The tax invoice is written now and the goods leave stock.`)) return;
  try {
    const r = await auth.api('complete', { laybyId: l.id, saleId: newId('lbs'), ...where() }, API.layby);
    const after = fresh(id, r);
    toast('Collected: tax invoice ' + (r.sale ? r.sale.docNo : ''));
    if (ctx.onChange) ctx.onChange(r);
    if (r.sale) { const rc = openReceipt({ sale: r.sale, lines: r.lines, payments: r.payments, vouchersSold: [], entity: dd.entity, store: dd.store, settings: dd.settings, copy: !!r.again }); const slip = () => openReceipt(docOf({ ...after, completedDocNo: r.sale.docNo }, 'collection')); const b = document.createElement('button'); b.className = 'btn'; b.innerHTML = icon('printer') + ' Collection slip'; b.addEventListener('click', slip); const acts = document.querySelector('#modal .rc-acts'); if (acts) acts.insertBefore(b, acts.firstChild); }
  } catch (e) { toast(e.offline ? 'Collecting a lay-by needs the line.' : e.message, 'warn'); }
}

// ---------------------------------------------------------- cancel --
function cancel(id) {
  const l = one(id); if (!l) return;
  const dd = d();
  const methods = ['cash', 'card', 'eft', 'storeCredit'].filter(k => (dd.store.paymentMethods || ['cash', 'card']).includes(k) || k === 'storeCredit');
  let busy = false;
  const { wrap, close } = openModal('Cancel ' + l.docNo, `
    ${row(field('Why', 'lc-kind', { type: 'select', value: l.dueAt < today() ? 'lapsed' : 'customer', options: CANCEL_KINDS.map(k => ({ value: k[0], label: k[1] })) }), field('Note', 'lc-reason', { placeholder: 'optional' }))}
    <div class="card lb-sched" id="lc-break"></div>
    ${row(field('Refund by', 'lc-method', { type: 'select', value: methods[0], options: methods.map(k => ({ value: k, label: METHOD[k] })) }), field('Reference', 'lc-ref', {}))}
    <p class="muted">A supervisor’s PIN; waiving the penalty (death, hospitalisation, our fault) a manager’s.</p>`, { okLabel: 'Cancel the lay-by', cancelLabel: 'Back', onOk: () => submit() });
  const show = () => { const pb = penaltyFor(l, val(wrap, 'lc-kind')); wrap.querySelector('#lc-break').innerHTML = [['Full price', money(pb.fullPriceCents)], ['Paid in', money(pb.paidCents)], [`Penalty agreed: ${pb.penaltyPct}% of the full price`, money(pb.computedCents)], [`Legal cap: ${pb.capPct}%`, money(pb.capCents)], ...(pb.waivedWhy ? [['Waived', pb.waivedWhy]] : []), ['Penalty charged', money(pb.chargedCents)], ['To refund', money(pb.refundCents)]].map((r, i, a) => `<div class="x-row${i === a.length - 1 ? ' tot' : ''}"><span>${esc(r[0])}</span><strong>${esc(r[1])}</strong></div>`).join(''); wrap.querySelector('#lc-method').closest('.fld-row').hidden = pb.refundCents <= 0; };
  wrap.addEventListener('change', show); show();
  async function submit() {
    if (busy) return false;
    const kind = val(wrap, 'lc-kind'); const pb = penaltyFor(l, kind);
    const refunds = pb.refundCents > 0 ? [{ method: val(wrap, 'lc-method'), amountCents: pb.refundCents, ref: val(wrap, 'lc-ref') }] : [];
    const body = { laybyId: l.id, kind, reason: val(wrap, 'lc-reason'), refunds, ...where() };
    busy = true;
    try {
      let r;
      try { r = await auth.api('cancel', body, API.layby); }
      catch (e) {
        if (e.status === 403 && /PIN/.test(e.message)) { const minRole = /manager/.test(e.message) ? 'manager' : 'supervisor'; const a = await auth.requireOverride({ minRole, action: 'layby', details: { docNo: l.docNo, kind, refundCents: pb.refundCents }, text: e.message }); r = await auth.api('cancel', { ...body, approvalToken: a.token }, API.layby); }
        else throw e;
      }
      close(true);
      const after = fresh(id, r);
      toast(l.docNo + ' cancelled · refund ' + money(pb.refundCents) + (pb.chargedCents ? ' · penalty ' + money(pb.chargedCents) : ''));
      openReceipt(docOf(after, 'cancel'));
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(e.message, 'warn'); return false; }
  }
}

// ---------------------------------------------------------- remind --
async function remind(id) {
  const l = one(id); if (!l) return;
  try {
    const r = await auth.api('remind', { laybyId: l.id, how: 'whatsapp', ...where() }, API.layby);
    fresh(id, { layby: { reminders: [...(l.reminders || []), r.reminder], lastReminderAt: r.reminder.at } });
    if (r.phone) window.open(whatsappUrl(r.phone, r.text), '_blank');
    else { await navigator.clipboard.writeText(r.text).catch(() => {}); openModal('No phone number', `<p>${esc(l.customerSnapshot.name)} has no phone number. The reminder is copied; send it another way:</p><p class="muted">${esc(r.text)}</p>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true }); }
    toast('Reminder logged on ' + l.docNo);
    if (ctx.onChange) ctx.onChange(r);
  } catch (e) { toast(e.message, 'warn'); }
}

// ---------------------------------------------------------- report --
async function report() {
  const dd = d();
  const from = new Date(); from.setDate(1);
  const ask = () => openModal('Lay-by report', row(field('From', 'lr-from', { type: 'date', value: from.toISOString().slice(0, 10) }), field('To', 'lr-to', { type: 'date', value: today() })), { okLabel: 'Show', onOk: async (w) => { await show(val(w, 'lr-from'), val(w, 'lr-to')); return true; } });
  async function show(fromDay, toDay) {
    let r;
    try { r = await auth.api('report', { from: fromDay, to: toDay, ...where() }, API.layby); } catch (e) { return toast(e.message, 'warn'); }
    const kv = (rows) => `<table class="tbl"><tbody>${rows.map(x => `<tr><td>${esc(x[0])}</td><td class="r">${esc(x[1])}</td></tr>`).join('')}</tbody></table>`;
    const figures = [
      ['Open lay-bys', `${r.open.count} · ${money(r.open.valueCents)} · paid ${money(r.open.paidCents)} · to come ${money(r.open.balanceCents)}`],
      ['Ready to collect', `${r.ready.count} · ${money(r.ready.valueCents)}`], ['Behind schedule', `${r.behind.count} · ${money(r.behind.balanceCents)} owed`], ['Overdue', `${r.overdue.count} · ${money(r.overdue.balanceCents)} owed`],
      [`Opened ${fromDay} – ${toDay}`, `${r.opened.count} · ${money(r.opened.valueCents)}`], ['Collected', `${r.completed.count} · ${money(r.completed.valueCents)}`], ['Cancelled', `${r.cancelled.count} · ${money(r.cancelled.valueCents)} · penalties ${money(r.cancelled.penaltyCents)} · refunded ${money(r.cancelled.refundedCents)}`],
      ['Money taken at this store', `${money(r.takenHereCents)} (${Object.entries(r.takenHereByMethod).map(([m, c]) => (METHOD[m] || m) + ' ' + money(c)).join(', ') || 'none'})`], ['Paid on this store’s lay-bys (any till)', money(r.paidOnOursCents)]
    ];
    const rowsHtml = r.rows.length ? `<table class="tbl"><thead><tr><th>No</th><th>Customer</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>State</th><th>Last reminder</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${esc(x.docNo)}</td><td>${esc(x.customer)}<div class="muted">${esc(x.phone)}</div></td><td>${esc(niceDate(x.dueAt))}</td><td class="r">${esc(money(x.totalCents))}</td><td class="r">${esc(money(x.paidCents))}</td><td class="r">${esc(money(x.balanceCents))}</td><td>${esc(x.state)}</td><td class="muted">${esc(x.lastReminderAt ? niceDate(x.lastReminderAt) : '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No open lay-bys.</p>';
    const html = `<h3>${esc(dd.store.name)} · ${esc(niceDate(r.at))} ${esc(niceTime(r.at))}</h3>${kv(figures)}<h3>Open lay-bys</h3>${rowsHtml}`;
    const { wrap } = openModal('Lay-by report', `<div class="lb-report">${html}</div><div class="card-actions"><button class="btn" id="lr-print">${icon('printer')} Print</button></div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
    wrap.querySelector('.modal-card').classList.add('wide');
    wrap.querySelector('#lr-print').addEventListener('click', () => openPrint('Lay-by report', `<div class="a4"><div class="head"><div class="co">${esc(dd.entity.tradingName || dd.entity.legalName)}</div><div class="doc"><div class="t">Lay-by report</div><div>${esc(fromDay)} – ${esc(toDay)}</div></div></div>${html}</div>`, A4_CSS + ' h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin:14px 0 4px}'));
  }
  ask();
}
