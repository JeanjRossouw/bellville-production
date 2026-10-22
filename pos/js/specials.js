// Retail POS — the Custom orders tab: made-to-order furniture. A new order
// is opened from the cart: the specification per item (model, size,
// fabric, colour, legs, notes, a photo from the phone), the deposit, and the
// customer's sign-off with the no-change-of-mind clause signed on the
// screen. Then payments at any till, a WhatsApp update at each status (the
// factory app or a supervisor moves the status), a delivery booking, the
// hand-over with a signed delivery note into a tax invoice, and
// cancellation by a manager. The server (pos-special) writes it all.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money, niceDate, niceTime, empty } from './ui.js';
import { centsOf, randsOf, pctOf } from './money.js';
import { specialSettings, signoffText, STATUS_LABEL, NEXT, SPEC_FIELDS, CANCEL_KINDS } from './special-terms.js';
import { openReceipt } from './receiptui.js';
import { whatsappUrl, specLines } from './receipt.js';
import { padHtml, wirePad } from './signpad.js';
import { icon } from './icons.js';

export const so = { filter: 'open', q: '' };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();   // { store, entity, settings, specials, registerId, shiftOpen }
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const today = () => new Date().toISOString().slice(0, 10);
const newId = (p) => p + '-' + (auth.deviceId() || 'web') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const OPEN = ['quoted', 'depositPaid', 'inProduction', 'ready'];
const CHIP = { quoted: '', depositPaid: 'prod', inProduction: 'prod', ready: 'ok', delivered: '', collected: '', cancelled: 'off' };
const METHOD = { cash: 'Cash', card: 'Card', eft: 'EFT', qr: 'QR', storeCredit: 'Store credit' };
const kindLabel = (k) => (CANCEL_KINDS.find(x => x[0] === k) || [k, k])[1];
const one = (id) => (d().specials || []).find(o => o.id === id);
const addr = (a) => a ? [a.line1, a.line2, a.city, a.code].filter(Boolean).join(', ') : '';

// ---------------------------------------------------------------- html --
export function specialsHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Custom orders</h1></div><div class="card muted">Pick a store first.</div>`;
  const all = dd.specials || [];
  const q = so.q.trim().toLowerCase();
  const rows = all.filter(o => (so.filter === 'all' || (so.filter === 'open' ? OPEN.includes(o.status) : so.filter === 'done' ? /^(delivered|collected)$/.test(o.status) : o.status === so.filter)) && (!q || [o.docNo, o.customerSnapshot && o.customerSnapshot.name, o.customerSnapshot && o.customerSnapshot.phone, o.factoryRef, ...o.lines.map(l => l.name)].some(x => String(x || '').toLowerCase().includes(q))))
    .sort((a, b) => (OPEN.includes(a.status) ? 0 : 1) - (OPEN.includes(b.status) ? 0 : 1) || String(a.expectedAt).localeCompare(String(b.expectedAt)));
  const open = all.filter(o => OPEN.includes(o.status));
  const due = all.filter(o => o.updateDue && o.status !== 'quoted').length;
  return `<div class="page-head"><h1>Custom orders</h1><p class="sub">${open.length} open · ${esc(money(open.reduce((n, o) => n + o.balanceCents, 0)))} still to come in${due ? ' · ' + due + ' update' + (due === 1 ? '' : 's') + ' to send' : ''}${all.filter(o => o.status === 'ready').length ? ' · ' + all.filter(o => o.status === 'ready').length + ' ready' : ''}</p></div>
    <div class="toolbar">
      <input id="so-q" class="search" type="search" placeholder="Number, customer, phone, item, factory ref" value="${esc(so.q)}">
      <select id="so-filter">${[['open', 'Open'], ['quoted', 'Quoted'], ['depositPaid', 'Deposit paid'], ['inProduction', 'In production'], ['ready', 'Ready'], ['done', 'Delivered / collected'], ['cancelled', 'Cancelled'], ['all', 'All']].map(x => `<option value="${x[0]}"${so.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>
      <span class="muted">New orders start from the cart under Sell (made-to-order items).</span>
    </div>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl lb-tbl"><thead><tr><th>No</th><th>Customer</th><th>What</th><th>Expected</th><th class="r">Price</th><th class="r">Paid</th><th class="r">Balance</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(o => `<tr class="${OPEN.includes(o.status) ? '' : 'off'}"><td><strong>${esc(o.docNo)}</strong>${o.factoryRef ? `<div class="muted">${esc(o.factoryRef)}</div>` : ''}</td><td>${esc(o.customerSnapshot ? o.customerSnapshot.name : '')}<div class="muted">${esc(o.customerSnapshot ? o.customerSnapshot.phone : '')}</div></td><td>${esc(o.lines.map(l => l.qty + ' × ' + l.name).join(', '))}</td><td class="muted">${esc(niceDate(o.expectedAt))}</td><td class="r">${esc(money(o.totalCents))}</td><td class="r">${esc(money(o.paidCents))}</td><td class="r"><strong>${esc(money(o.balanceCents))}</strong></td><td><span class="chip ${CHIP[o.status] || ''}">${esc(STATUS_LABEL[o.status] || o.status)}</span>${o.updateDue && o.status !== 'quoted' ? '<span class="chip late">update to send</span>' : ''}</td><td class="r"><button class="btn ghost sm" data-act="so-open" data-id="${esc(o.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`
      : empty(so.filter === 'open' ? 'No open custom orders' : 'Nothing here', so.filter === 'open' ? 'Ring a made-to-order item up under Sell, add the customer, and tap Custom order.' : '')}`;
}

// ------------------------------------------------------------ actions --
export async function action(act, b) {
  const id = b.dataset.id;
  if (act === 'so-open') return openDetail(id);
  if (act === 'so-pay') return pay(id);
  if (act === 'so-update') return update(id, b.dataset.status || '');
  if (act === 'so-status') return status(id, b.dataset.to);
  if (act === 'so-factory-sync') return factorySync(id);
  if (act === 'so-factory-send') return factorySend(id);
  if (act === 'so-book') return book(id);
  if (act === 'so-deliver') return deliver(id);
  if (act === 'so-cancel') return cancel(id);
  if (act === 'so-print-order') { const o = one(id); if (o) openReceipt(docOf(o, 'order')); return; }
  if (act === 'so-print-delivery') { const o = one(id); if (o) openReceipt(docOf(o, 'delivery')); return; }
  if (act === 'so-print-cancel') { const o = one(id); if (o) openReceipt(docOf(o, 'cancel')); return; }
}
export function onInput(id, value) { if (id === 'so-q') { so.q = value; ctx.repaint(); const q = document.getElementById('so-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } }
export function onChange(e) { if (e.target.id === 'so-filter') { so.filter = e.target.value; ctx.repaint(); } }

// ------------------------------------------------------- the documents --
export function docOf(o, docKind, extra = {}) {
  const dd = d();
  const base = { ...o, id: o.id, series: 'SO', docKind, clientCreatedAt: o.openedAt, cashierName: o.cashierName, entity: dd.entity, store: dd.store, settings: dd.settings };
  const common = { entity: dd.entity, store: dd.store, settings: dd.settings };
  if (docKind === 'order') return { sale: { ...base, docKind: o.status === 'quoted' ? 'quote' : 'order', terms: o.signoff.text, signature: o.signoff.signature, signedBy: o.signoff.signedBy, sections: [{ title: 'Payment', rows: [['Deposit to start', money(o.minDepositCents)], ['Paid', money(o.paidCents)], ['Balance before delivery', money(o.balanceCents), true], ['Expected', niceDate(o.expectedAt)]] }] }, lines: o.lines, payments: [], ...common, copy: !!extra.copy };
  if (docKind === 'payment') return { sale: { ...base, clientCreatedAt: extra.at, cashierName: auth.session.user.name, noTotals: true, changeCents: extra.changeCents || 0, refLabel: `Special order ${o.docNo} · ${o.customerSnapshot.name}`, sections: [{ title: '', rows: [['Paid now', money(extra.amountCents), true], ['Paid so far', money(o.paidCents)], ['Balance', money(o.balanceCents), true], ['Status', STATUS_LABEL[o.status] || o.status]] }] }, lines: [], payments: extra.payments || [], ...common };
  if (docKind === 'delivery') { const dv = o.delivery || {}; const dn = o.deliveryNote; const kind = (dn && dn.kind) || dv.kind || (o.status === 'collected' ? 'collect' : 'deliver'); return { sale: { ...base, clientCreatedAt: (dn && dn.at) || new Date().toISOString(), cashierName: (dn && dn.byName) || dv.driverName || auth.session.user.name, noTotals: true, refLabel: kind === 'collect' ? 'Collected at ' + dd.store.name : 'Delivered to ' + (addr(dv.address) || addr(o.customerSnapshot.address)), sections: [{ title: '', rows: [...(dv.date ? [[kind === 'collect' ? 'Collection' : 'Delivery', niceDate(dv.date) + (dv.slot ? ' · ' + dv.slot : '')]] : []), ...(dv.driverName ? [['Driver', dv.driverName]] : []), ['Paid in full', money(o.paidCents)], ...(o.completedDocNo ? [['Tax invoice', o.completedDocNo]] : [])] }], ...(dn && dn.signature ? { signature: dn.signature, signedBy: dn.signedBy } : { signLine: 'I have received the goods above, made to my specification, in good order.' }) }, lines: o.lines, payments: [], ...common }; }
  return { sale: { ...base, clientCreatedAt: o.cancelledAt || new Date().toISOString(), cashierName: o.cancelledByName || auth.session.user.name, noTotals: true, refLabel: `Special order ${o.docNo} · ${o.customerSnapshot.name} · ${kindLabel(o.cancelKind)}${o.cancelReason ? ' · ' + o.cancelReason : ''}`,
    sections: [{ title: 'Settlement', rows: [['Price', money(o.totalCents)], ['Paid in', money(o.paidCents)], ['Cancellation fee', money(o.feeCents || 0)], ...(o.feeReason ? [['Why', o.feeReason]] : []), ['Refunded', money(o.refundedCents || 0), true], ...(o.refunds || []).map(r => ['Refund by ' + (METHOD[r.method] || r.method), money(r.amountCents)])] }],
    terms: 'Goods made to the customer’s specification (Consumer Protection Act, section 20(2)(b)): once production has started the deposit covers the work and materials spent; before that nothing is charged.' }, lines: [], payments: [], ...common };
}

// --------------------------------------------------------------- new --
// a photo from the phone, shrunk to fit in the order
function shrink(file) {
  return new Promise((resolve) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 800 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); let q = 0.75, out = c.toDataURL('image/jpeg', q); while (out.length > 280000 && q > 0.3) { q -= 0.15; out = c.toDataURL('image/jpeg', q); } resolve(out); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}
// from the cart: openNew(cart, totals, onDone)
export function openNew(cart, t, onDone) {
  const dd = d();
  if (!cart.customer) return toast('A custom order needs the customer: add them to the sale first.', 'warn');
  if (cart.lines.some(l => l.type === 'stock' || l.type === 'voucher' || l.type === 'bundle')) return toast('Only made-to-order and custom items go on a custom order: sell stock items on their own.', 'warn');
  if (!cart.lines.some(l => l.type === 'mto')) return toast('Nothing here is made to order.', 'warn');
  const ss = specialSettings(dd.settings);
  const methods = (dd.store.paymentMethods || ['cash', 'card']).filter(k => METHOD[k] && (k !== 'storeCredit' || cart.customer.storeCreditCents > 0));
  const minDep = pctOf(t.totalCents, ss.minDepositPct);
  const photos = {};
  let busy = false, pad = null;
  const expected = new Date(Date.now() + ss.leadDays * 86400000).toISOString().slice(0, 10);
  const { wrap, close } = openModal('Custom order for ' + cart.customer.name, `
    <div class="lb-new">
      <div class="lb-new-left">
        <div class="muted">${t.pieces} item${t.pieces === 1 ? '' : 's'} · <strong>${esc(money(t.totalCents))}</strong>${cart.customer.phone ? ' · ' + esc(cart.customer.phone) : ' · <span class="warn">no phone number for updates</span>'}</div>
        ${cart.lines.map((l, i) => l.type === 'mto' ? `<div class="card so-spec"><h3>${esc(l.qty + ' × ' + l.name)} · ${esc(money(l.qty * l.unitPriceCents - (l.discountCents || 0)))}</h3>
          <div class="grid two">${field('Model', 'so-model-' + i, { value: l.name })}${field('Size', 'so-size-' + i, { placeholder: 'e.g. 2.4 m' })}${field('Fabric', 'so-fabric-' + i, { placeholder: 'e.g. Linen look' })}${field('Colour', 'so-colour-' + i, { placeholder: 'e.g. Charcoal' })}${field('Legs', 'so-legs-' + i, { placeholder: 'e.g. Oak, tapered' })}</div>
          ${field('Notes', 'so-notes-' + i, { type: 'textarea', rows: 2, placeholder: 'Anything else the maker must know' })}
          <label class="so-photo"><span class="btn ghost sm">${icon('camera')} Photo</span><input type="file" accept="image/*" capture="environment" data-photo="${i}" hidden><img id="so-ph-${i}" class="spec-thumb" alt="" hidden></label></div>` : `<div class="muted">${esc(l.qty + ' × ' + l.name)} · ${esc(money(l.qty * l.unitPriceCents - (l.discountCents || 0)))}</div>`).join('')}
        ${field('Expected by', 'so-expected', { type: 'date', value: expected })}
        <label class="chk"><input type="checkbox" id="so-depnow" checked> Take the deposit now (at least ${esc(money(minDep))}, ${ss.minDepositPct}%)</label>
        <div id="so-deprow">${row(field('Deposit (R)', 'so-dep', { value: randsOf(minDep), inputmode: 'decimal' }), field('Paid by', 'so-method', { type: 'select', value: methods[0], options: methods.map(k => ({ value: k, label: METHOD[k] })) }))}
        ${row(field('Cash given (R)', 'so-given', { value: randsOf(minDep), inputmode: 'decimal' }), field('Card last 4 / reference', 'so-ref', {}))}</div>
      </div>
      <div class="lb-new-right">
        <div class="lb-terms" id="so-terms"></div>
        ${field('Customer’s name as signed', 'so-signby', { value: cart.customer.name })}
        ${padHtml('so-pad')}
        <label class="chk"><input type="checkbox" id="so-accept"> The customer has checked the specification and agrees: no change of mind once in production</label>
      </div>
    </div>`, { okLabel: 'Open custom order', cancelLabel: 'Back', onOk: () => submit() });
  wrap.querySelector('.modal-card').classList.add('wide');
  pad = wirePad(wrap.querySelector('#so-pad'));
  const specs = () => cart.lines.map((l, i) => l.type === 'mto' ? Object.fromEntries(SPEC_FIELDS.map(f => [f[0], val(wrap, 'so-' + f[0] + '-' + i)]).concat([['photo', photos[i] || '']])) : null);
  const draft = () => ({ docNo: (dd.entity.specialOrderPrefix || dd.entity.invoicePrefix + '-SO') + '-(new)', customerSnapshot: { name: cart.customer.name }, lines: t.lines.map((l, i) => ({ ...l, spec: specs()[i] })), totalCents: t.totalCents, vatRegistered: !!dd.entity.vatRegistered, minDepositCents: minDep, minDepositPct: ss.minDepositPct, leadDays: ss.leadDays });
  const preview = () => {
    const depNow = wrap.querySelector('#so-depnow').checked;
    wrap.querySelector('#so-deprow').hidden = !depNow;
    wrap.querySelector('#so-given').closest('.fld').hidden = val(wrap, 'so-method') !== 'cash';
    wrap.querySelector('#so-terms').textContent = signoffText(dd.entity, draft());
  };
  wrap.addEventListener('input', preview); wrap.addEventListener('change', async (e) => { if (e.target.dataset.photo != null) { const f = e.target.files && e.target.files[0]; if (f) { const url = await shrink(f); if (url) { photos[e.target.dataset.photo] = url; const im = wrap.querySelector('#so-ph-' + e.target.dataset.photo); im.src = url; im.hidden = false; } } } preview(); }); preview();
  async function submit() {
    if (busy) return false;
    if (!wrap.querySelector('#so-accept').checked) { toast('Tick that the customer agrees to the specification and the terms.', 'warn'); return false; }
    const signedBy = val(wrap, 'so-signby'); if (!signedBy) { toast('The customer’s name, as signed.', 'warn'); return false; }
    if (pad.isEmpty()) { toast('The customer signs in the box.', 'warn'); return false; }
    const deposit = [];
    if (wrap.querySelector('#so-depnow').checked) {
      const dep = centsOf(val(wrap, 'so-dep')); const method = val(wrap, 'so-method');
      if (dep < minDep) { toast(`The deposit must be at least ${money(minDep)} (${ss.minDepositPct}%).`, 'warn'); return false; }
      const tender = { method, amountCents: Math.min(dep, t.totalCents), ref: val(wrap, 'so-ref') };
      if (method === 'cash') { tender.tenderedCents = centsOf(val(wrap, 'so-given')); if (tender.tenderedCents < tender.amountCents) { toast('Cash given is short.', 'warn'); return false; } }
      if (method === 'card') tender.cardLast4 = val(wrap, 'so-ref').replace(/\D/g, '').slice(-4);
      deposit.push(tender);
    }
    busy = true;
    const sp = specs();
    const body = {
      orderId: newId('so'), clientCreatedAt: new Date().toISOString(), customerId: cart.customerId, expectedAt: val(wrap, 'so-expected'),
      lines: cart.lines.map((l, i) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceCents: l.unitPriceCents, priceOverride: l.priceOverride ? { reason: l.priceOverride.reason, token: l.priceOverride.token } : null, discountCents: l.discountCents, discountPct: l.discountPct, discountReason: l.discountReason, discountToken: l.discountToken || '', note: l.note, custom: !!l.custom, name: l.name, vatClass: l.vatClass, spec: sp[i] })),
      saleDiscountCents: cart.discountCents || 0, saleDiscountPct: cart.discountPct || 0, saleDiscountReason: cart.discountReason || '', saleDiscountToken: cart.discountToken || '', note: cart.note || '',
      totals: { totalCents: t.totalCents, vatCents: t.vatCents }, deposit, signoff: { accepted: true, signedBy, signature: pad.dataUrl() }, ...where()
    };
    try {
      const r = await auth.api('open', body, API.special);
      close(true); onDone && onDone(r);
      toast('Custom order ' + r.order.docNo + (r.order.status === 'depositPaid' ? ' opened, deposit paid' : ' quoted') + (r.payments && r.payments[0] && r.payments[0].changeCents ? ' · change ' + money(r.payments[0].changeCents) : ''));
      openReceipt(docOf(r.order, 'order'));
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(e.offline ? 'A custom order needs the line: try again when connected.' : e.message, 'warn'); return false; }
  }
}

// ------------------------------------------------------------ detail --
function openDetail(id) {
  const o = one(id); if (!o) return;
  const sg = o.signoff || {}, dv = o.delivery;
  const sup = auth.atLeast('supervisor');
  const canStatus = (to) => OPEN.includes(o.status) && NEXT[o.status] && NEXT[o.status].includes(to) && to !== 'cancelled' && to !== 'depositPaid';
  openModal(o.docNo + ' · ' + o.customerSnapshot.name, `
    <div class="lb-detail">
      <div class="lb-head"><span class="chip ${CHIP[o.status] || ''}">${esc(STATUS_LABEL[o.status] || o.status)}</span>${o.updateDue && o.status !== 'quoted' ? '<span class="chip late">update to send</span>' : ''}<span class="muted">Opened ${esc(niceDate(o.openedAt))} by ${esc(o.cashierName)} · expected ${esc(niceDate(o.expectedAt))}${o.factoryRef ? ' · factory ref ' + esc(o.factoryRef) : ''} · ${esc(o.customerSnapshot.phone || 'no phone')}</span></div>
      ${o.lines.map(l => `<div class="so-line"><div class="x-row"><strong>${esc(l.qty + ' × ' + l.name)}</strong><span>${esc(money(l.netCents != null ? l.netCents : l.lineTotalCents))}</span></div>${specLines(l.spec).map(x => `<div class="muted">${esc(x)}</div>`).join('')}${l.spec && l.spec.photo ? `<img class="spec-thumb" src="${l.spec.photo}" alt="">` : ''}</div>`).join('')}
      <div class="x-row tot"><span>Price</span><strong>${esc(money(o.totalCents))}</strong></div>
      <div class="lb-cols">
        <div><h3>Progress</h3>${(o.statusHistory || []).map(h => `<div class="x-row"><span>${esc(STATUS_LABEL[h.status] || h.status)}${h.note ? ' · ' + esc(h.note) : ''}</span><span class="muted">${esc(niceDate(h.at))} · ${esc(h.byName)}${h.source === 'factory' ? ' (factory)' : ''}</span></div>`).join('')}
          ${dv ? `<p class="muted">${dv.kind === 'collect' ? 'Collection' : 'Delivery'} booked for ${esc(niceDate(dv.date))}${dv.slot ? ' · ' + esc(dv.slot) : ''}${dv.kind === 'deliver' ? ' · ' + esc(addr(dv.address)) : ''}${dv.driverName ? ' · ' + esc(dv.driverName) : ''}</p>` : ''}
          ${(o.updates || []).length ? `<p class="muted">${o.updates.length} update${o.updates.length === 1 ? '' : 's'} sent, last ${esc(niceDate(o.lastUpdateAt))}</p>` : ''}</div>
        <div><h3>Money</h3><div class="x-row"><span>Deposit to start</span><span>${esc(money(o.minDepositCents))}</span></div>${(o.history || []).map(h => `<div class="x-row"><span>${esc(niceDate(h.at))} ${h.n ? 'payment ' + h.n : 'deposit'} · ${esc(h.methods.map(m => METHOD[m] || m).join(', '))}${h.storeId !== o.storeId ? ' · ' + esc(h.storeId) : ''}</span><span>${esc(money(h.amountCents))}</span></div>`).join('')}
          <div class="x-row tot"><span>Paid ${esc(money(o.paidCents))} · balance</span><strong>${esc(money(o.balanceCents))}</strong></div>
          ${o.status === 'cancelled' ? `<p class="warn">Cancelled ${esc(niceDate(o.cancelledAt))}: ${esc(kindLabel(o.cancelKind))}${o.cancelReason ? ' · ' + esc(o.cancelReason) : ''}. Fee ${esc(money(o.feeCents || 0))}, refunded ${esc(money(o.refundedCents || 0))}.</p>` : ''}
          ${/^(delivered|collected)$/.test(o.status) ? `<p class="ok">${esc(STATUS_LABEL[o.status])} ${esc(niceDate(o.completedAt))} · tax invoice ${esc(o.completedDocNo || '')}${o.deliveryNote && o.deliveryNote.signedBy ? ' · signed by ' + esc(o.deliveryNote.signedBy) : ''}</p>` : ''}</div>
      </div>
      <p class="muted">Specification signed off by ${esc(sg.signedBy || '')} on ${esc(niceDate(sg.acceptedAt))}: no change of mind once in production.</p>
      ${factoryLine(o)}
      <div class="card-actions lb-acts">
        ${OPEN.includes(o.status) && o.balanceCents > 0 ? `<button class="btn primary" data-act="so-pay" data-id="${esc(o.id)}">${icon('cash')} Take a payment</button>` : ''}
        ${OPEN.includes(o.status) && o.balanceCents <= 0 && o.status !== 'quoted' ? `<button class="btn primary" data-act="so-deliver" data-id="${esc(o.id)}">${icon('truck')} Hand over: delivery note + tax invoice</button>` : ''}
        ${o.status !== 'quoted' ? `<button class="btn${o.updateDue ? ' primary' : ''}" data-act="so-update" data-id="${esc(o.id)}">${icon('user')} WhatsApp update</button>` : ''}
        ${o.factory && (o.factory.orders || []).length && OPEN.includes(o.status) ? `<button class="btn" data-act="so-factory-sync" data-id="${esc(o.id)}">Check factory</button>` : ''}
        ${sup && factoryLinked() && !(o.factory && (o.factory.orders || []).length) && ['depositPaid', 'inProduction', 'ready'].includes(o.status) ? `<button class="btn" data-act="so-factory-send" data-id="${esc(o.id)}">Send to factory</button>` : ''}
        ${sup && canStatus('inProduction') ? `<button class="btn" data-act="so-status" data-to="inProduction" data-id="${esc(o.id)}">In production</button>` : ''}
        ${sup && canStatus('ready') ? `<button class="btn" data-act="so-status" data-to="ready" data-id="${esc(o.id)}">Ready</button>` : ''}
        ${OPEN.includes(o.status) && o.status !== 'quoted' ? `<button class="btn" data-act="so-book" data-id="${esc(o.id)}">${icon('truck')} ${dv ? 'Rebook' : 'Book delivery / collection'}</button>` : ''}
        ${OPEN.includes(o.status) ? `<button class="btn ghost" data-act="so-cancel" data-id="${esc(o.id)}">Cancel order</button>` : ''}
        <button class="btn ghost" data-act="so-print-order" data-id="${esc(o.id)}">${icon('printer')} Order</button>
        ${dv || /^(delivered|collected)$/.test(o.status) ? `<button class="btn ghost" data-act="so-print-delivery" data-id="${esc(o.id)}">${icon('printer')} Delivery note</button>` : ''}
        ${o.status === 'cancelled' ? `<button class="btn ghost" data-act="so-print-cancel" data-id="${esc(o.id)}">${icon('printer')} Cancellation</button>` : ''}
      </div>
    </div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
}
function fresh(id, r) { if (r && r.order) { const list = d().specials || []; const i = list.findIndex(x => x.id === id); if (i >= 0) list[i] = { ...list[i], ...r.order }; } return one(id) || (r && r.order); }
const noLine = (e) => e.offline ? 'This needs the line: try again when connected.' : e.message;

// ------------------------------------------------------------- pay --
function pay(id) {
  const o = one(id); if (!o) return;
  const dd = d();
  if (dd.registerId && !dd.shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
  const methods = (dd.store.paymentMethods || ['cash', 'card']).filter(k => METHOD[k] && k !== 'storeCredit');
  const suggested = o.status === 'quoted' ? Math.min(o.balanceCents, Math.max(0, o.minDepositCents - o.paidCents)) || o.balanceCents : o.balanceCents;
  let busy = false;
  const { wrap, close } = openModal('Payment on ' + o.docNo, `
    <div class="muted">${esc(o.customerSnapshot.name)} · balance <strong>${esc(money(o.balanceCents))}</strong>${o.status === 'quoted' ? ' · deposit to start ' + esc(money(o.minDepositCents)) : ''}</div>
    ${row(field('Amount (R)', 'sp-amount', { value: randsOf(suggested), inputmode: 'decimal' }), field('Paid by', 'sp-method', { type: 'select', value: methods[0], options: methods.map(k => ({ value: k, label: METHOD[k] })) }))}
    ${row(field('Cash given (R)', 'sp-given', { value: randsOf(suggested), inputmode: 'decimal' }), field('Card last 4 / reference', 'sp-ref', {}))}
    <div class="pay-quick"><button class="btn ghost sm" type="button" data-sp="${o.balanceCents}">The whole balance</button>${o.status === 'quoted' && o.minDepositCents > o.paidCents ? `<button class="btn ghost sm" type="button" data-sp="${o.minDepositCents - o.paidCents}">The deposit</button>` : ''}</div>
    <div class="pay-change-live" id="sp-change"></div>`, { okLabel: 'Take payment', cancelLabel: 'Back', onOk: () => submit() });
  const live = () => { const m = val(wrap, 'sp-method'); wrap.querySelector('#sp-given').closest('.fld').hidden = m !== 'cash'; const a = centsOf(val(wrap, 'sp-amount')), g = centsOf(val(wrap, 'sp-given')); wrap.querySelector('#sp-change').textContent = m === 'cash' && g >= a && a > 0 ? 'Change ' + money(g - a) : m === 'cash' && a > 0 && g < a ? 'Short by ' + money(a - g) : ''; };
  wrap.addEventListener('input', live); wrap.addEventListener('change', live); live();
  wrap.addEventListener('click', (e) => { const q = e.target.closest('[data-sp]'); if (q) { wrap.querySelector('#sp-amount').value = randsOf(Number(q.dataset.sp)); wrap.querySelector('#sp-given').value = randsOf(Number(q.dataset.sp)); live(); } });
  async function submit() {
    if (busy) return false;
    const amount = centsOf(val(wrap, 'sp-amount')); const method = val(wrap, 'sp-method');
    if (!(amount > 0)) { toast('How much?', 'warn'); return false; }
    if (amount > o.balanceCents) { toast('Only ' + money(o.balanceCents) + ' is owed.', 'warn'); return false; }
    const tender = { method, amountCents: amount, ref: val(wrap, 'sp-ref') };
    if (method === 'cash') { tender.tenderedCents = centsOf(val(wrap, 'sp-given')); if (tender.tenderedCents < amount) { toast('Cash given is short.', 'warn'); return false; } }
    if (method === 'card') tender.cardLast4 = val(wrap, 'sp-ref').replace(/\D/g, '').slice(-4);
    busy = true;
    try {
      const r = await auth.api('pay', { orderId: o.id, paymentId: newId('sp'), tenders: [tender], clientCreatedAt: new Date().toISOString(), ...where() }, API.special);
      close(true);
      const after = fresh(id, r);
      const pays = r.payments || []; const chg = pays[0] && pays[0].changeCents || 0;
      toast('Paid ' + money(amount) + ' on ' + o.docNo + (chg ? ' · change ' + money(chg) : '') + (after.status === 'depositPaid' && o.status === 'quoted' ? ' · deposit paid, to the factory' : after.balanceCents <= 0 ? ' · paid in full' : ''));
      openReceipt(docOf(after, 'payment', { at: r.paidAt || new Date().toISOString(), amountCents: amount, payments: pays, changeCents: chg }));
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(noLine(e), 'warn'); return false; }
  }
}

// ---------------------------------------------------------- update --
async function update(id, status) {
  const o = one(id); if (!o) return;
  try {
    const r = await auth.api('update', { orderId: o.id, status: status || '', how: 'whatsapp', ...where() }, API.special);
    fresh(id, { order: { updates: [...(o.updates || []), r.update], updateDue: false, lastUpdateAt: r.update.at } });
    if (r.phone) window.open(whatsappUrl(r.phone, r.text), '_blank');
    else { await navigator.clipboard.writeText(r.text).catch(() => {}); openModal('No phone number', `<p>${esc(o.customerSnapshot.name)} has no phone number. The update is copied; send it another way:</p><p class="muted">${esc(r.text)}</p>`, { okLabel: 'Done', cancelLabel: '', onOk: () => true }); }
    toast('Update logged on ' + o.docNo);
    if (ctx.onChange) ctx.onChange(r);
  } catch (e) { toast(noLine(e), 'warn'); }
}
const factoryLinked = () => !!(((d().settings || {}).factory || {}).companyId);
// where the order stands at the factory
function factoryLine(o) {
  const f = o.factory || {};
  const orders = f.orders || [];
  if (orders.length) return `<p class="muted">Factory (${esc(f.companyName || '')}): ${orders.map(x => esc(x.orderNo || x.id) + ' ' + esc(String(x.status || 'new').replace('-', ' '))).join(', ')}${f.lastCheckedAt ? ' · checked ' + esc(niceTime(f.lastCheckedAt)) : ''}${f.error ? ' · <span class="warn">' + esc(f.error) + '</span>' : ''}</p>`;
  if (f.error) return `<p class="warn">${esc(f.error)}</p>`;
  if (factoryLinked() && ['depositPaid', 'inProduction', 'ready'].includes(o.status)) return '<p class="warn">Not at the factory yet.</p>';
  return '';
}
async function factorySync(id) {
  const o = one(id); if (!o) return;
  try {
    const r = await auth.api('factorySync', { orderId: o.id, ...where() }, API.special);
    fresh(id, r);
    toast(r.order.status !== o.status ? o.docNo + ' is now ' + STATUS_LABEL[r.order.status].toLowerCase() + ' · send the customer an update' : 'The factory: ' + (r.order.factory.orders || []).map(x => x.orderNo + ' ' + x.status).join(', '));
    if (ctx.onChange) ctx.onChange(r);
  } catch (e) { toast(noLine(e), 'warn'); }
}
async function factorySend(id) {
  const o = one(id); if (!o) return;
  try {
    const r = await auth.api('factorySend', { orderId: o.id, ...where() }, API.special);
    fresh(id, r);
    toast(o.docNo + ' is at the factory: ' + (r.order.factory.orders || []).map(x => x.orderNo).join(', '));
    if (ctx.onChange) ctx.onChange(r);
  } catch (e) { toast(noLine(e), 'warn'); }
}
// Admin → Settings → Factory: the owner links the company to a Factory Manager company
export async function factoryCard(host, entityId) {
  const el = host.querySelector('#se-factory'); if (!el) return;
  let r;
  try { r = await auth.api('factoryCompanies', { entityId }, API.special); } catch (e) { el.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const linked = r.linked;
  el.innerHTML = `${linked ? `<p>Linked to <strong>${esc(linked.companyName)}</strong>.</p>` : '<p class="muted">Not linked: the till moves a custom order along by hand.</p>'}
    ${field('Factory company', 'fa-co', { type: 'select', value: linked ? linked.companyId : '', options: [{ value: '', label: 'None' }, ...(r.companies || []).map(c => ({ value: c.id, label: c.name }))] })}
    <div class="card-actions"><button class="btn primary" data-act="fa-link">Save factory link</button></div>`;
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.dataset.act !== 'fa-link') return; e.preventDefault();
    try { const x = await auth.api('factoryLink', { entityId, companyId: val(el, 'fa-co') }, API.special); toast(x.linked ? 'Custom orders go to ' + x.linked.companyName : 'Factory link removed'); }
    catch (err) { toast(err.message, 'warn'); }
    factoryCard(host, entityId);
  }, { once: true });
}
async function status(id, to) {
  const o = one(id); if (!o) return;
  const note = prompt((to === 'ready' ? 'Ready: ' : 'In production: ') + 'a note for the record (optional)', '') ; if (note === null) return;
  try {
    const r = await auth.api('status', { orderId: o.id, status: to, note, ...where() }, API.special);
    fresh(id, r);
    toast(o.docNo + ' is now ' + STATUS_LABEL[to].toLowerCase() + ' · send the customer an update');
    if (ctx.onChange) ctx.onChange(r);
  } catch (e) { toast(noLine(e), 'warn'); }
}

// ------------------------------------------------------------ book --
function book(id) {
  const o = one(id); if (!o) return;
  const dv = o.delivery || {}; const a = dv.address || o.customerSnapshot.address || {};
  let busy = false;
  const { wrap, close } = openModal('Book ' + o.docNo, `
    ${row(field('How', 'bk-kind', { type: 'select', value: dv.kind || 'deliver', options: [{ value: 'deliver', label: 'Deliver to the customer' }, { value: 'collect', label: 'Customer collects' }] }), field('Day', 'bk-date', { type: 'date', value: dv.date || o.expectedAt || today() }))}
    ${row(field('Time slot', 'bk-slot', { value: dv.slot || '', placeholder: 'e.g. 09:00–12:00' }), field('Driver', 'bk-driver', { value: dv.driverName || '' }))}
    <div id="bk-addr">${row(field('Street', 'bk-line1', { value: a.line1 || '' }), field('Suburb', 'bk-line2', { value: a.line2 || '' }))}${row(field('City', 'bk-city', { value: a.city || '' }), field('Postal code', 'bk-code', { value: a.code || '' }))}</div>
    ${row(field('Phone', 'bk-phone', { value: dv.phone || o.customerSnapshot.phone || '' }), field('Note', 'bk-note', { value: dv.note || '', placeholder: 'e.g. 3rd floor, no lift' }))}`, { okLabel: 'Book', cancelLabel: 'Back', onOk: () => submit() });
  const live = () => { wrap.querySelector('#bk-addr').hidden = val(wrap, 'bk-kind') !== 'deliver'; };
  wrap.addEventListener('change', live); live();
  async function submit() {
    if (busy) return false; busy = true;
    try {
      const r = await auth.api('book', { orderId: o.id, kind: val(wrap, 'bk-kind'), date: val(wrap, 'bk-date'), slot: val(wrap, 'bk-slot'), driverName: val(wrap, 'bk-driver'), address: { line1: val(wrap, 'bk-line1'), line2: val(wrap, 'bk-line2'), city: val(wrap, 'bk-city'), code: val(wrap, 'bk-code') }, phone: val(wrap, 'bk-phone'), note: val(wrap, 'bk-note'), ...where() }, API.special);
      close(true); fresh(id, r);
      toast(o.docNo + ' booked for ' + niceDate(r.delivery.date) + ' · send the customer the booking');
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(noLine(e), 'warn'); return false; }
  }
}

// --------------------------------------------------------- deliver --
function deliver(id) {
  const o = one(id); if (!o) return;
  const dd = d();
  if (dd.registerId && !dd.shiftOpen) return toast('The register is closed: open it under Register first.', 'warn');
  const kind = (o.delivery && o.delivery.kind) || 'collect';
  let busy = false;
  const { wrap, close } = openModal((kind === 'collect' ? 'Collected: ' : 'Delivered: ') + o.docNo, `
    <p class="muted">${esc(o.lines.map(l => l.qty + ' × ' + l.name).join(', '))} · paid in full ${esc(money(o.paidCents))}. The tax invoice is written now.</p>
    ${row(field('Received by', 'dn-name', { value: o.customerSnapshot.name }), field('Note', 'dn-note', { placeholder: 'e.g. small scuff noted' }))}
    ${padHtml('dn-pad')}`, { okLabel: kind === 'collect' ? 'Hand over' : 'Delivered', cancelLabel: 'Back', onOk: () => submit() });
  const pad = wirePad(wrap.querySelector('#dn-pad'));
  async function submit() {
    if (busy) return false;
    if (pad.isEmpty() && !confirm('No signature. Hand over without one?')) return false;
    busy = true;
    try {
      const r = await auth.api('deliver', { orderId: o.id, saleId: newId('sos'), kind, signedBy: val(wrap, 'dn-name'), signature: pad.dataUrl(), note: val(wrap, 'dn-note'), ...where() }, API.special);
      close(true);
      const after = fresh(id, r);
      toast((kind === 'collect' ? 'Collected: ' : 'Delivered: ') + 'tax invoice ' + (r.sale ? r.sale.docNo : ''));
      if (ctx.onChange) ctx.onChange(r);
      if (r.sale) { openReceipt({ sale: r.sale, lines: r.lines, payments: r.payments, vouchersSold: [], entity: dd.entity, store: dd.store, settings: dd.settings, copy: !!r.again }); const b = document.createElement('button'); b.className = 'btn'; b.innerHTML = icon('printer') + ' Delivery note'; b.addEventListener('click', () => openReceipt(docOf({ ...after, completedDocNo: r.sale.docNo }, 'delivery'))); const acts = document.querySelector('#modal .rc-acts'); if (acts) acts.insertBefore(b, acts.firstChild); }
      return true;
    } catch (e) { busy = false; toast(noLine(e), 'warn'); return false; }
  }
}

// ---------------------------------------------------------- cancel --
function cancel(id) {
  const o = one(id); if (!o) return;
  const dd = d();
  const started = /^(inProduction|ready)$/.test(o.status);
  const methods = ['cash', 'card', 'eft', 'storeCredit'].filter(k => (dd.store.paymentMethods || ['cash', 'card']).includes(k) || k === 'storeCredit');
  let busy = false;
  const { wrap, close } = openModal('Cancel ' + o.docNo, `
    ${row(field('Why', 'sc-kind', { type: 'select', value: 'customer', options: CANCEL_KINDS.map(k => ({ value: k[0], label: k[1] })) }), field('Note', 'sc-reason', { placeholder: 'optional' }))}
    ${row(field('Cancellation fee (R)', 'sc-fee', { value: randsOf(started ? Math.min(o.depositCents, o.paidCents) : 0), inputmode: 'decimal' }), field('Refund by', 'sc-method', { type: 'select', value: methods[0], options: methods.map(k => ({ value: k, label: METHOD[k] })) }))}
    <div class="card lb-sched" id="sc-break"></div>
    <p class="muted">${started ? 'Production has started: the deposit covers the work and materials spent (the customer signed this off).' : 'Production has not started: no fee, everything paid goes back.'} A manager’s PIN.</p>`, { okLabel: 'Cancel the order', cancelLabel: 'Back', onOk: () => submit() });
  const show = () => { const kind = val(wrap, 'sc-kind'); let fee = kind === 'store' || !started ? 0 : Math.min(o.paidCents, centsOf(val(wrap, 'sc-fee'))); wrap.querySelector('#sc-fee').disabled = kind === 'store' || !started; const refund = o.paidCents - fee; wrap.querySelector('#sc-break').innerHTML = [['Paid in', money(o.paidCents)], ['Fee', money(fee)], ['To refund', money(refund)]].map((r, i, a) => `<div class="x-row${i === a.length - 1 ? ' tot' : ''}"><span>${esc(r[0])}</span><strong>${esc(r[1])}</strong></div>`).join(''); wrap.querySelector('#sc-method').closest('.fld-row').hidden = refund <= 0; return { fee, refund }; };
  wrap.addEventListener('input', show); wrap.addEventListener('change', show); show();
  async function submit() {
    if (busy) return false;
    const { fee, refund } = show(); const kind = val(wrap, 'sc-kind');
    const refunds = refund > 0 ? [{ method: val(wrap, 'sc-method'), amountCents: refund, ref: '' }] : [];
    const body = { orderId: o.id, kind, reason: val(wrap, 'sc-reason'), feeCents: fee, refunds, ...where() };
    busy = true;
    try {
      let r;
      try { r = await auth.api('cancel', body, API.special); }
      catch (e) {
        if (e.status === 403 && /PIN/.test(e.message)) { const a = await auth.requireOverride({ minRole: 'manager', action: 'specialOrder', details: { docNo: o.docNo, kind, refundCents: refund, feeCents: fee }, text: e.message }); r = await auth.api('cancel', { ...body, approvalToken: a.token }, API.special); }
        else throw e;
      }
      close(true);
      const after = fresh(id, r);
      toast(o.docNo + ' cancelled · refund ' + money(refund) + (fee ? ' · fee ' + money(fee) : ''));
      openReceipt(docOf(after, 'cancel'));
      if (ctx.onChange) ctx.onChange(r);
      return true;
    } catch (e) { busy = false; toast(e.message, 'warn'); return false; }
  }
}
