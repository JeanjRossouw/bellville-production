// Retail POS — the payment screen. The methods the store offers, split
// tenders, cash with quick buttons and change (rounded to 10c, the rounding
// recorded), card details, EFT awaiting or paid, QR, store credit, a gift
// voucher by its code, and the customer's account. Completing the sale is
// one call to the pos-sale function, which writes everything or nothing.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money } from './ui.js';
import { roundTo10c, centsOf, randsOf } from './money.js';
import { icon } from './icons.js';
import { fullInvoiceGap, ABRIDGED_MAX } from './receipt.js';
import { openReceipt } from './receiptui.js';
import * as sync from './sync.js';
import { vatIn } from './money.js';
import { saveCustomer } from './customers.js';
import { loyaltySettings } from './loyalty-terms.js';

const METHODS = [
  { key: 'cash', label: 'Cash', ico: 'cash' }, { key: 'card', label: 'Card', ico: 'card' }, { key: 'eft', label: 'EFT', ico: 'file' }, { key: 'qr', label: 'QR', ico: 'grid' },
  { key: 'voucher', label: 'Gift voucher', ico: 'gift' }, { key: 'storeCredit', label: 'Store credit', ico: 'star' }, { key: 'account', label: 'On account', ico: 'user' }, { key: 'points', label: 'Points', ico: 'star' }
];
const QUICK = [2000, 5000, 10000, 20000, 50000];

// openPay({ totals, cart, data, onDone })
export function openPay(o) {
  const { totals: t, cart, data } = o;
  const store = data.store, customer = cart.customer;
  const ls = loyaltySettings(data.settings);
  const allowed = [...(store.paymentMethods || ['cash', 'card']).filter(k => METHODS.some(m => m.key === k)), ...(ls.enabled && !(store.paymentMethods || []).includes('points') ? ['points'] : [])];
  const pointsHave = customer && customer.loyalty ? customer.loyalty.points || 0 : 0;
  const tenders = o.keep ? [...o.keep] : [];   // { method, amountCents, tenderedCents?, ref?, cardLast4?, approvalCode?, status?, voucherCode?, label }
  let method = allowed[0] || 'cash', busy = false;
  const sumOthers = () => tenders.reduce((n, x) => n + x.amountCents, 0);
  // what is still owed, and for cash the 10c-rounded figure
  const due = () => Math.max(0, t.totalCents - sumOthers());
  const cashDue = () => roundTo10c(due());

  const { wrap, close } = openModal('Pay ' + money(t.totalCents), `<div class="pay"><div class="pay-left" id="pay-left"></div><div class="pay-right" id="pay-right"></div></div>`, { okLabel: 'Complete sale', cancelLabel: 'Back', onOk: () => complete() });
  wrap.querySelector('.modal-card').classList.add('wide');
  const okBtn = wrap.querySelector('#modal-ok');

  function draw() {
    const d = due(), cd = cashDue();
    const m = METHODS.find(x => x.key === method);
    wrap.querySelector('#pay-right').innerHTML = `
      <div class="pay-sum"><div><span>Total</span><strong>${esc(money(t.totalCents))}</strong></div>
        ${tenders.map((x, i) => `<div class="pay-tender"><span>${esc(x.label)}</span><strong>${esc(money(x.amountCents))}</strong><button class="pos-icon-btn light" data-rm="${i}" title="Remove">${icon('x')}</button></div>`).join('')}
        <div class="pay-due"><span>${d ? 'Still to pay' : 'Paid in full'}</span><strong>${esc(money(d))}</strong></div>
        ${tenders.some(x => x.method === 'cash' && x.changeCents) ? `<div class="pay-change"><span>Change</span><strong>${esc(money(tenders.find(x => x.method === 'cash').changeCents))}</strong></div>` : ''}
        ${tenders.some(x => x.roundingCents) ? `<div class="muted"><span>Cash rounding</span><strong>${esc(money(tenders.find(x => x.roundingCents).roundingCents))}</strong></div>` : ''}
      </div>
      ${customer ? `<p class="muted">${esc(customer.name)}${customer.storeCreditCents ? ' · store credit ' + esc(money(customer.storeCreditCents)) : ''}${customer.accountEnabled ? ' · has an account' : ''}</p>` : '<p class="muted">Walk-in customer</p>'}`;
    okBtn.disabled = d > 0 || busy;
    okBtn.textContent = d > 0 ? 'Still to pay ' + money(d) : 'Complete sale';
    if (!d) { wrap.querySelector('#pay-left').innerHTML = `<div class="pay-done">${icon('cart')}<p>Everything is covered. Tap <strong>Complete sale</strong>.</p></div>`; return; }
    wrap.querySelector('#pay-left').innerHTML = `
      <div class="pay-methods">${allowed.map(k => { const mm = METHODS.find(x => x.key === k); const off = (k === 'storeCredit' && !(customer && customer.storeCreditCents > 0)) || (k === 'account' && !(customer && customer.accountEnabled)) || (k === 'points' && !(customer && pointsHave >= ls.minRedeemPoints)); return `<button class="pay-m${k === method ? ' on' : ''}" data-m="${k}"${off ? ' disabled' : ''}>${icon(mm.ico)}<span>${esc(mm.label)}</span></button>`; }).join('')}</div>
      <div class="pay-form">${formFor(method, d, cd)}</div>`;
    const first = wrap.querySelector('#pay-left input'); if (first) { first.focus(); first.select && first.select(); }
  }
  function formFor(k, d, cd) {
    const amountField = (label) => field(label || 'Amount (R)', 'py-amount', { value: randsOf(d), inputmode: 'decimal' });
    if (k === 'cash') return `<div class="pay-cash"><div class="muted">Cash due ${esc(money(cd.roundedCents))}${cd.roundingCents ? ' (rounded from ' + esc(money(d)) + ')' : ''}</div>
      ${field('Cash given (R)', 'py-tendered', { value: randsOf(cd.roundedCents), inputmode: 'decimal' })}
      <div class="pay-quick"><button class="btn ghost sm" data-q="${cd.roundedCents}">Exact</button>${QUICK.filter(q => q >= cd.roundedCents || true).map(q => `<button class="btn ghost sm" data-q="${q}">${esc(money(q).replace('.00', ''))}</button>`).join('')}</div>
      <div class="pay-change-live" id="py-change"></div>
      <button class="btn primary" data-add="cash">Add cash</button></div>`;
    if (k === 'card') return amountField() + row(field('Last 4 digits', 'py-last4', { inputmode: 'numeric', placeholder: '1234' }), field('Approval code', 'py-approval', { placeholder: 'from the machine' })) + '<button class="btn primary" data-add="card">Add card payment</button>';
    if (k === 'eft') return amountField() + row(field('Reference', 'py-ref', { placeholder: 'as on the statement' }), field('Status', 'py-status', { type: 'select', value: 'paid', options: [{ value: 'paid', label: 'Paid: seen in the bank' }, { value: 'awaiting', label: 'Awaiting: not yet in the bank' }] })) + '<button class="btn primary" data-add="eft">Add EFT</button>';
    if (k === 'qr') return amountField() + field('Reference', 'py-ref', { placeholder: 'SnapScan / Zapper reference' }) + '<button class="btn primary" data-add="qr">Add QR payment</button>';
    if (k === 'voucher') return field('Voucher code', 'py-code', { placeholder: 'GV…', autocomplete: 'off' }) + '<div class="muted" id="py-vinfo"></div>' + amountField('Amount to use (R)') + '<button class="btn primary" data-add="voucher">Use voucher</button>';
    if (k === 'storeCredit') return `<div class="muted">${esc(customer.name)} has ${esc(money(customer.storeCreditCents))} store credit.</div>` + field('Amount to use (R)', 'py-amount', { value: randsOf(Math.min(d, customer.storeCreditCents)), inputmode: 'decimal' }) + '<button class="btn primary" data-add="storeCredit">Use store credit</button>';
    if (k === 'account') return `<div class="muted">Goes onto ${esc(customer.name)}’s account.</div>` + amountField() + '<button class="btn primary" data-add="account">Put on account</button>';
    if (k === 'points') return `<div class="muted">${esc(customer.name)} has ${pointsHave} points, worth ${esc(money(pointsHave * ls.pointValueCents))} (at least ${ls.minRedeemPoints} at a time).</div>` + field('Amount to use (R)', 'py-amount', { value: randsOf(Math.min(d, pointsHave * ls.pointValueCents)), inputmode: 'decimal' }) + '<button class="btn primary" data-add="points">Use points</button>';
    return '';
  }
  function liveChange() {
    const el = wrap.querySelector('#py-change'); if (!el) return;
    const given = centsOf(val(wrap, 'py-tendered')), cd = cashDue();
    el.textContent = given >= cd.roundedCents ? 'Change ' + money(given - cd.roundedCents) : given ? 'Short by ' + money(cd.roundedCents - given) : '';
  }
  async function add(k) {
    const d = due();
    if (k === 'cash') {
      const cd = cashDue(); const given = centsOf(val(wrap, 'py-tendered'));
      if (given < cd.roundedCents) return toast('Cash given is short.', 'warn');
      tenders.push({ method: 'cash', amountCents: cd.roundedCents, tenderedCents: given, changeCents: given - cd.roundedCents, roundingCents: cd.roundingCents, label: 'Cash' + (given !== cd.roundedCents ? ' (given ' + money(given) + ')' : '') });
      return draw();
    }
    const amount = Math.min(d, centsOf(val(wrap, 'py-amount')));
    if (!(amount > 0)) return toast('How much?', 'warn');
    if (k === 'card') { const last4 = val(wrap, 'py-last4').replace(/\D/g, ''); tenders.push({ method: 'card', amountCents: amount, cardLast4: last4, approvalCode: val(wrap, 'py-approval'), label: 'Card' + (last4 ? ' ••' + last4 : '') }); }
    if (k === 'eft') { const status = val(wrap, 'py-status'); tenders.push({ method: 'eft', amountCents: amount, ref: val(wrap, 'py-ref'), status, label: 'EFT' + (status === 'awaiting' ? ' (awaiting)' : '') }); }
    if (k === 'qr') tenders.push({ method: 'qr', amountCents: amount, ref: val(wrap, 'py-ref'), label: 'QR' });
    if (k === 'storeCredit') { if (amount > customer.storeCreditCents) return toast('Not that much credit.', 'warn'); tenders.push({ method: 'storeCredit', amountCents: amount, label: 'Store credit' }); }
    if (k === 'account') tenders.push({ method: 'account', amountCents: amount, label: 'On account' });
    if (k === 'points') { if (amount > pointsHave * ls.pointValueCents) return toast('Not that many points.', 'warn'); const pts = Math.ceil(amount / ls.pointValueCents); if (pts < ls.minRedeemPoints) return toast('At least ' + ls.minRedeemPoints + ' points at a time.', 'warn'); tenders.push({ method: 'points', amountCents: amount, label: 'Points (' + pts + ')' }); }
    if (k === 'voucher') {
      const code = val(wrap, 'py-code').toUpperCase(); if (!code) return toast('Type the voucher code.', 'warn');
      try { const r = await auth.api('voucher', { code, ...where(data) }, API.sale); if (r.status !== 'open' || r.balanceCents <= 0) return toast('That voucher has nothing left on it.', 'warn'); const use = Math.min(amount, r.balanceCents); tenders.push({ method: 'voucher', amountCents: use, voucherCode: code, label: 'Voucher ' + code }); }
      catch (e) { return toast(e.message, 'warn'); }
    }
    draw();
  }
  // over R 5 000 a VAT-registered company issues a full tax invoice: the customer's name and address must be on it
  async function fullInvoiceReady() {
    if (!data.entity.vatRegistered || t.totalCents <= ABRIDGED_MAX) return true;
    const gap = fullInvoiceGap(customer);
    if (!gap) return true;
    if (!customer) { toast('Over R 5 000 a full tax invoice is needed: go Back and add the customer.', 'warn'); return false; }
    return new Promise((resolve) => {
      openModal('Full tax invoice: ' + customer.name, `<p class="muted">Over R 5 000 the invoice must carry the customer’s name and address (and VAT number if they have one).</p>` +
        row(field('Street', 'fi-line1', { value: customer.address && customer.address.line1 }), field('Suburb', 'fi-line2', { value: customer.address && customer.address.line2 })) + row(field('City', 'fi-city', { value: customer.address && customer.address.city }), field('Postal code', 'fi-code', { value: customer.address && customer.address.code })) + field('Customer VAT number (if any)', 'fi-vat', { value: customer.vatNo }), {
        okLabel: 'Save and continue', onOk: async (w) => {
          const address = { line1: val(w, 'fi-line1'), line2: val(w, 'fi-line2'), city: val(w, 'fi-city'), code: val(w, 'fi-code') }, vatNo = val(w, 'fi-vat');
          if (!address.line1 && !address.city) { toast('A street or a city, at least.', 'warn'); return false; }
          try { await saveCustomer({ customerId: customer.id, name: customer.name, phone: customer.phone, email: customer.email, address, vatNo }); customer.address = address; customer.vatNo = vatNo; resolve(true); return true; }
          catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
        }, onClose: (ok) => { if (!ok) resolve(false); }
      });
    });
  }
  async function complete() {
    if (busy || due() > 0) return false;
    if (!(await fullInvoiceReady())) { if (!document.getElementById('modal')) reopen(); return false; }
    busy = true; okBtn.disabled = true; okBtn.textContent = 'Writing the sale…';
    const body = {
      saleId: cart.id, clientCreatedAt: new Date().toISOString(), customerId: cart.customerId || '',
      lines: cart.lines.map(l => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, priceOverride: l.priceOverride ? { reason: l.priceOverride.reason, token: l.priceOverride.token } : null, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, discountToken: l.discountToken || '', note: l.note, custom: !!l.custom, name: l.name, vatClass: l.vatClass })),
      saleDiscountCents: cart.discountCents || 0, saleDiscountPct: cart.discountPct || 0, saleDiscountReason: cart.discountReason || '', saleDiscountToken: cart.discountToken || '', note: cart.note || '',
      totals: { totalCents: t.totalCents, vatCents: t.vatCents },
      tenders: tenders.map(x => ({ method: x.method, amountCents: x.amountCents, tenderedCents: x.tenderedCents, ref: x.ref, cardLast4: x.cardLast4, approvalCode: x.approvalCode, status: x.status, voucherCode: x.voucherCode })),
      ...where(data)
    };
    try {
      const r = await auth.api('commit', body, API.sale);
      close(true);
      o.onDone(r);
      openReceipt({ sale: r.sale, lines: r.lines, payments: r.payments, vouchersSold: r.vouchersSold || [], entity: data.entity, store: data.store, settings: data.settings, copy: !!r.again });
      return true;
    } catch (e) {
      if (e.offline && auth.session.device) {
        // the line is down: the till takes a number from its block and keeps the sale to send later
        const r = await queueOffline(body);
        if (r) { close(true); o.onDone(r); openReceipt({ sale: r.sale, lines: r.lines, payments: r.payments, vouchersSold: [], entity: data.entity, store: data.store, settings: data.settings, copy: false }); return true; }
      }
      busy = false; draw();
      toast(e.offline ? 'No connection, and no number for an offline sale.' : e.message, 'warn');
      return false;
    }
  }
  // the sale as the server would write it, from the till's own arithmetic, with a number from the block
  async function queueOffline(body) {
    const num = await sync.nextNumber();
    if (!num) { toast('No numbers left for offline sales: connect once to get more.', 'warn'); return null; }
    body.seq = num.seq; body.blockId = num.blockId;
    const cashT = tenders.find(x => x.method === 'cash');
    const sale = { id: cart.id, docNo: num.docNo, seq: num.seq, series: 'INV', blockId: num.blockId, registerId: auth.session.device.registerId || '', shiftId: '', customerId: cart.customerId || '', customerSnapshot: cart.customer ? { name: cart.customer.name, phone: cart.customer.phone || '', email: cart.customer.email || '', vatNo: cart.customer.vatNo || '', address: cart.customer.address || {} } : null,
      lineCount: t.lines.length, subtotalCents: t.grossCents, lineDiscountCents: t.lineDiscountCents, saleDiscountCents: t.saleDiscountCents, totalCents: t.totalCents, vatCents: t.vatCents, vatRateBp: t.lines[0] ? t.lines[0].vatRateBp : 0, vatRegistered: !!data.entity.vatRegistered,
      roundingCents: cashT ? cashT.roundingCents || 0 : 0, tenderedCents: cashT ? cashT.tenderedCents : 0, changeCents: cashT ? cashT.changeCents : 0, paymentMethods: [...new Set(tenders.map(x => x.method))], paidStatus: tenders.some(x => x.status === 'awaiting') ? 'awaiting' : 'paid',
      cashierUid: auth.session.uid, cashierName: auth.session.user.name, clientCreatedAt: body.clientCreatedAt, source: 'till', pending: true, entityId: data.entity.id, storeId: data.store.id, deviceId: auth.session.device.deviceId };
    const lines = t.lines.map((l, i) => ({ saleId: cart.id, docNo: num.docNo, lineNo: i + 1, productId: l.productId, variantId: l.variantId, itemId: l.itemId, name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, lineTotalCents: l.lineTotalCents, saleDiscountCents: l.saleDiscountCents, netCents: l.netCents, vatRateBp: l.vatRateBp, vatCents: l.vatCents, note: l.note, trackStock: l.trackStock }));
    const payments = tenders.map(x => ({ method: x.method, amountCents: x.amountCents, tenderedCents: x.tenderedCents, changeCents: x.changeCents, ref: x.ref, cardLast4: x.cardLast4, approvalCode: x.approvalCode, status: x.status || 'paid' }));
    const stockMoves = t.lines.filter(l => l.trackStock && l.itemId).map(l => ({ itemId: l.itemId, qty: -l.qty }));
    await sync.enqueue({ saleId: cart.id, body, seq: num.seq, docNo: num.docNo, stockMoves, totalCents: t.totalCents, clientCreatedAt: body.clientCreatedAt });
    return { ok: true, sale, lines, payments, vouchersSold: [], offline: true };
  }
  const reopen = () => openPay({ ...o, keep: tenders });
  wrap.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]'); if (m) { method = m.dataset.m; return draw(); }
    const q = e.target.closest('[data-q]'); if (q) { wrap.querySelector('#py-tendered').value = randsOf(Number(q.dataset.q)); return liveChange(); }
    const a = e.target.closest('[data-add]'); if (a) return add(a.dataset.add);
    const rm = e.target.closest('[data-rm]'); if (rm) { tenders.splice(Number(rm.dataset.rm), 1); return draw(); }
  });
  wrap.addEventListener('input', (e) => { if (e.target.id === 'py-tendered') liveChange(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const b = wrap.querySelector('[data-add]'); if (b) b.click(); } });
  draw();
}
// the till's identity, or the office user's store
function where(data) {
  const dev = auth.session.device;
  return dev ? auth.deviceBody() : { entityId: data.entity.id, storeId: data.store.id, registerId: '' };
}
