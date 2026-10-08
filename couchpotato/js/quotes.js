// Quotes — a priced quotation from the catalogue that becomes factory orders
// with one tap when the customer says yes.
//
// draft → sent → accepted (orders created) | declined
// A sent quote past its valid-until date shows as expired until it is
// accepted, declined or re-sent with a new date.
//
// Prices come from the catalogue's selling prices; while capturing, the
// person quoting sees the cost and margin of every line (never printed).
import * as store from './store.js';
import { allCustomers, customerById } from './customers.js';
import { allProducts, productByName, costOf } from './costing.js';
import { esc, money, field, row, val, openModal, toast, empty, today, addDays, niceDate, openPrint, docHeader, waDigits } from './ui.js';

let quotes = [];
let settings = {};
let onChange = null;
let unwatch = null;
let filter = 'open';     // open | accepted | all

export function startQuotes(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  if (unwatch) unwatch();
  unwatch = store.watch('quotes', rows => {
    quotes = rows.sort((a, b) => String(b.quoteNo || '').localeCompare(String(a.quoteNo || ''), undefined, { numeric: true }));
    if (onChange) onChange();
  });
}
export const setQuoteSettings = (cfg) => { settings = cfg || {}; };
export const setQuoteFilter = (f) => { filter = f; };
export const allQuotes = () => quotes;
const quoteById = (id) => quotes.find(q => q.id === id) || null;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cur = () => settings.currency || 'R';
const who = () => (store.getUser() || {}).name || 'system';
const vatRate = () => (settings.vatRegistered ? Number(settings.vatRate) || 0 : 0);
const leadDays = () => Number(settings.leadDays) || 28;
const validDays = () => Number(settings.quoteValidDays) || 30;

export function totals(q) {
  const subtotalRaw = r2((q.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0));
  const discount = Math.min(subtotalRaw, r2(q.discount));
  const subtotal = r2(subtotalRaw - discount);
  const vat = r2(subtotal * vatRate());
  return { subtotalRaw, discount, subtotal, vat, total: r2(subtotal + vat) };
}

const isExpired = (q) => q.status === 'sent' && q.validUntil && q.validUntil < today();
function statusOf(q) {
  if (isExpired(q)) return ['Expired', 'late'];
  return ({ draft: ['Draft', ''], sent: ['Sent', 'st-prod'], accepted: ['Accepted', 'st-disp'], declined: ['Declined', 'late'] })[q.status] || ['Draft', ''];
}
const chip = (q) => { const [l, c] = statusOf(q); return `<span class="chip ${c}">${esc(l)}</span>`; };
const customerName = (q) => q.customerName || (q.prospect && q.prospect.name) || '';
const contactOf = (q) => {
  const c = customerById(q.customerId);
  return c ? { phone: c.phone || '', email: c.email || '' } : { phone: (q.prospect || {}).phone || '', email: (q.prospect || {}).email || '' };
};

// ---------------------------------------------------------------- render ----

export function renderQuotes(host) {
  const open = quotes.filter(q => q.status === 'draft' || q.status === 'sent');
  const openValue = open.reduce((s, q) => s + totals(q).subtotal, 0);
  const month = today().slice(0, 7);
  const wonMonth = quotes.filter(q => q.status === 'accepted' && String(q.acceptedAt || '').slice(0, 7) === month);
  const since = addDays(today(), -90);
  const decided = quotes.filter(q => (q.status === 'accepted' || q.status === 'declined' || isExpired(q)) && String(q.sentAt || q.createdAt || '').slice(0, 10) >= since);
  const won = decided.filter(q => q.status === 'accepted').length;
  const rows = quotes.filter(q => filter === 'all' ? true : filter === 'accepted' ? q.status === 'accepted' : (q.status === 'draft' || q.status === 'sent'));
  const tab = (k, label) => `<button class="btn ${filter === k ? 'primary' : 'ghost'} sm" data-act="quote-filter" data-to="${k}">${esc(label)}</button>`;
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${esc(String(n))}</div><div class="tile-l">${esc(label)}</div></div>`;
  host.innerHTML = `
    <div class="page-head"><div><h1>Quotes</h1><p class="sub">Price it from the catalogue, send it, and turn it into orders when they say yes.</p></div>
      <div class="btn-row"><button class="btn primary" data-act="quote-new">＋ New quote</button></div></div>
    <div class="tiles">
      ${tile(open.length, 'Open quotes')}
      ${tile(money(openValue, cur()), 'Open, excl. VAT')}
      ${tile(money(wonMonth.reduce((s, q) => s + totals(q).subtotal, 0), cur()), 'Won this month')}
      ${tile(decided.length ? Math.round(won / decided.length * 100) + '%' : '—', 'Won, last 90 days')}
    </div>
    <div class="btn-row" style="margin:.2rem 0 .9rem">${tab('open', 'Open')}${tab('accepted', 'Accepted')}${tab('all', 'All')}</div>
    ${rows.length ? `<div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>Quote</th><th>Customer</th><th>For</th><th>Valid until</th><th class="r">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(q => `<tr>
        <td><strong>${esc(q.quoteNo)}</strong><div class="muted">${esc(niceDate(String(q.createdAt || '').slice(0, 10)))}</div></td>
        <td>${esc(customerName(q))}${q.customerId ? '' : ' <span class="muted">(new)</span>'}</td>
        <td>${esc((q.lines || []).map(l => (Number(l.qty) > 1 ? l.qty + ' × ' : '') + l.description).join(', '))}${q.orderNos && q.orderNos.length ? '<div class="muted">Orders ' + esc(q.orderNos.join(', ')) + '</div>' : ''}</td>
        <td>${esc(niceDate(q.validUntil))}</td>
        <td class="r">${esc(money(totals(q).total, cur()))}</td>
        <td>${chip(q)}</td>
        <td class="r nowrap">
          ${q.status === 'draft' || q.status === 'sent' ? `<button class="btn ghost sm" data-act="quote-edit" data-id="${esc(q.id)}">Edit</button>
            <button class="btn ${q.status === 'draft' ? 'primary' : 'ghost'} sm" data-act="quote-send" data-id="${esc(q.id)}">${q.status === 'draft' ? 'Send' : 'Send again'}</button>
            <button class="btn ${q.status === 'sent' ? 'primary' : 'ghost'} sm" data-act="quote-accept" data-id="${esc(q.id)}">Accepted</button>
            <button class="btn ghost sm" data-act="quote-decline" data-id="${esc(q.id)}">Declined</button>` : ''}
          <button class="btn ghost sm" data-act="quote-print" data-id="${esc(q.id)}">Print</button>
          <button class="btn ghost sm" data-act="quote-copy" data-id="${esc(q.id)}" title="Start a new quote from this one">Copy</button>
        </td></tr>`).join('')}</tbody>
    </table></div>` : empty('', filter === 'accepted' ? 'No accepted quotes yet' : 'No open quotes', 'Tap ＋ New quote to price something for a customer.')}`;
}

// ------------------------------------------------------------------ form ----

function lineRow(l, i) {
  l = l || {};
  return `<div class="q-row" data-row="${i}">
    <input class="q-desc" list="q-prod-list" value="${esc(l.description || '')}" placeholder="Product or description">
    <input class="q-fabric" value="${esc(l.fabric || '')}" placeholder="Fabric / colour">
    <input class="q-qty" type="number" min="1" step="1" value="${esc(l.qty || 1)}">
    <input class="q-price" type="number" min="0" step="0.01" value="${esc(l.unitPrice == null ? '' : l.unitPrice)}" placeholder="price each">
    <button type="button" class="icon-btn q-del" title="Remove">✕</button>
    <div class="q-hint muted"></div>
  </div>`;
}

function quoteForm(q) {
  const custs = allCustomers();
  const opts = [{ value: '', label: 'Choose a customer…' }, { value: '__new', label: '＋ New customer (not in the list yet)' }]
    .concat(custs.map(c => ({ value: c.id, label: c.name })));
  const p = q.prospect || {};
  return field('Customer', 'q-cust', { type: 'select', options: opts, value: q.customerId || (q.prospect ? '__new' : '') })
    + `<div id="q-prospect" ${q.prospect ? '' : 'hidden'}>${row(field('Name', 'q-p-name', { value: p.name, placeholder: 'Their name or business' }), field('Cell / WhatsApp', 'q-p-phone', { value: p.phone }))}
       ${row(field('Email', 'q-p-email', { type: 'email', value: p.email }), field('Area / address', 'q-p-addr', { value: p.address }))}</div>`
    + `<div class="fld"><span>What is being quoted</span>
        <div class="q-head muted"><span>Product</span><span>Fabric</span><span>Qty</span><span>Each excl. VAT</span><span></span></div>
        <div id="q-lines">${(q.lines && q.lines.length ? q.lines : [{}]).map(lineRow).join('')}</div>
        <button type="button" class="btn ghost sm" id="q-add" style="margin-top:.4rem">＋ Add a line</button>
      </div>`
    + row(field('Discount (' + cur() + ', excl. VAT)', 'q-disc', { type: 'number', min: 0, step: '0.01', value: q.discount || '' }), field('Valid until', 'q-valid', { type: 'date', value: q.validUntil || addDays(today(), validDays()) }))
    + `<div class="q-total" id="q-total"></div>`
    + field('Notes on the quote', 'q-notes', { type: 'textarea', value: q.notes, placeholder: 'Lead time, delivery, deposit, anything they should know' })
    + `<datalist id="q-prod-list">${allProducts().map(pr => `<option value="${esc(pr.name)}"></option>`).join('')}</datalist>`;
}

function wireForm(w) {
  const lines = w.querySelector('#q-lines');
  const cust = w.querySelector('#q-cust');
  cust.addEventListener('change', () => { w.querySelector('#q-prospect').hidden = cust.value !== '__new'; });
  const live = () => {
    let sub = 0, cost = 0, costed = true;
    lines.querySelectorAll('.q-row').forEach(r => {
      const qty = parseFloat(r.querySelector('.q-qty').value) || 0;
      const price = parseFloat(r.querySelector('.q-price').value) || 0;
      sub += qty * price;
      const pr = productByName(r.querySelector('.q-desc').value);
      const hint = r.querySelector('.q-hint');
      if (!store.can('costing')) { hint.textContent = ''; return; }     // costs are for roles that may see costing
      if (pr) {
        const c = costOf(pr);
        cost += c.total * qty;
        const m = price - c.total;
        hint.innerHTML = 'Your cost ' + esc(money(c.total, cur())) + ' each · margin <strong style="color:' + (m < 0 ? '#b91c1c' : '#1f7a3a') + '">' + esc(money(m, cur())) + (price > 0 ? ' (' + Math.round(m / price * 100) + '%)' : '') + '</strong>';
      } else { hint.textContent = r.querySelector('.q-desc').value ? 'Not in the catalogue: no cost to compare' : ''; if (r.querySelector('.q-desc').value) costed = false; }
    });
    const t = totals({ lines: [{ qty: 1, unitPrice: sub }], discount: parseFloat(w.querySelector('#q-disc').value) || 0 });
    const margin = t.subtotal - cost;
    w.querySelector('#q-total').innerHTML = `<div>Subtotal ${esc(money(t.subtotal, cur()))}${t.vat ? ' · VAT ' + esc(money(t.vat, cur())) : ''} · <strong>Total ${esc(money(t.total, cur()))}</strong></div>`
      + (cost ? `<div class="muted">Only you see this: cost ${esc(money(cost, cur()))}, margin ${esc(money(margin, cur()))}${t.subtotal ? ' (' + Math.round(margin / t.subtotal * 100) + '%)' : ''}${costed ? '' : ', some lines not costed'}</div>` : '');
  };
  // picking a catalogue product fills its price, unless one was typed
  lines.addEventListener('change', (e) => {
    if (e.target.classList.contains('q-desc')) {
      const pr = productByName(e.target.value); const price = e.target.closest('.q-row').querySelector('.q-price');
      if (pr && pr.sellingPrice && !price.value) price.value = pr.sellingPrice;
    }
    live();
  });
  lines.addEventListener('input', live);
  w.querySelector('#q-disc').addEventListener('input', live);
  lines.addEventListener('click', (e) => { if (e.target.closest('.q-del')) { e.target.closest('.q-row').remove(); live(); } });
  w.querySelector('#q-add').addEventListener('click', () => { lines.insertAdjacentHTML('beforeend', lineRow({}, lines.children.length)); });
  live();
}

function readForm(w) {
  const cid = val(w, 'q-cust');
  const c = customerById(cid);
  const lines = [];
  w.querySelectorAll('#q-lines .q-row').forEach(r => {
    const description = r.querySelector('.q-desc').value.trim();
    const qty = parseInt(r.querySelector('.q-qty').value, 10) || 0;
    if (!description || qty <= 0) return;
    const pr = productByName(description);
    lines.push({ productId: pr ? pr.id : '', description, fabric: r.querySelector('.q-fabric').value.trim(), qty, unitPrice: r2(parseFloat(r.querySelector('.q-price').value) || 0) });
  });
  const d = { lines, discount: r2(parseFloat(val(w, 'q-disc')) || 0), validUntil: val(w, 'q-valid'), notes: val(w, 'q-notes') };
  if (cid === '__new') Object.assign(d, { customerId: '', customerName: '', prospect: { name: val(w, 'q-p-name'), phone: val(w, 'q-p-phone'), email: val(w, 'q-p-email'), address: val(w, 'q-p-addr') } });
  else Object.assign(d, { customerId: cid, customerName: c ? c.name : '', prospect: null });
  return d;
}

async function saveQuote(id, d) {
  if (!d.customerId && !(d.prospect && d.prospect.name)) { toast('Choose the customer, or fill in the new customer\'s name', 'warn'); return false; }
  if (!d.lines.length) { toast('Add at least one line', 'warn'); return false; }
  if (id) { await store.update('quotes', id, d, 'Quote updated'); toast('Quote updated'); return; }
  const n = await store.nextNumber('quoteNo', 1);
  const quoteNo = (settings.quotePrefix || 'Q-') + String(n).padStart(4, '0');
  filter = 'open';
  await store.create('quotes', { ...d, quoteNo, status: 'draft', events: [{ at: store.nowIso(), by: who(), what: 'Quote drawn up' }] });
  toast(quoteNo + ' saved — tap Send when it is right');
}

export function newQuote(from) {
  const q = from ? { customerId: from.customerId, customerName: from.customerName, prospect: from.prospect, lines: from.lines, discount: from.discount, notes: from.notes } : {};
  const { wrap } = openModal(from ? 'New quote (copy of ' + from.quoteNo + ')' : 'New quote', quoteForm(q), { okLabel: 'Save quote', onOk: (w) => saveQuote(null, readForm(w)) });
  wrap.querySelector('.modal-card').classList.add('wide');
  wireForm(wrap);
}
export function copyQuote(id) { const q = quoteById(id); if (q) newQuote(q); }

export function editQuote(id) {
  const q = quoteById(id); if (!q) return;
  const { wrap } = openModal('Edit ' + q.quoteNo, quoteForm(q), { okLabel: 'Save changes', onOk: (w) => saveQuote(id, readForm(w)) });
  wrap.querySelector('.modal-card').classList.add('wide');
  wireForm(wrap);
}

// ---------------------------------------------------------------- sending ---

function quoteText(q) {
  const t = totals(q);
  const first = customerName(q).split(' ')[0] || 'there';
  return 'Hi ' + first + ', here is your quotation ' + q.quoteNo + ' from ' + (settings.name || '') + ':\n'
    + (q.lines || []).map(l => '• ' + l.qty + ' × ' + l.description + (l.fabric ? ' (' + l.fabric + ')' : '') + ': ' + money(l.qty * l.unitPrice, cur())).join('\n')
    + (t.discount ? '\nDiscount: −' + money(t.discount, cur()) : '')
    + '\nTotal: ' + money(t.total, cur()) + (t.vat ? ' incl. VAT' : '')
    + (q.validUntil ? '\nValid until ' + niceDate(q.validUntil) + '.' : '')
    + (q.notes ? '\n' + q.notes : '')
    + '\nReply YES to go ahead. Thank you, ' + who() + (settings.phone ? ' (' + settings.phone + ')' : '');
}

export function sendQuote(id) {
  const q = quoteById(id); if (!q) return;
  const c = contactOf(q);
  const phone = waDigits(c.phone);
  const expired = isExpired(q);
  const m = openModal('Send ' + q.quoteNo, `
    <p>Send the quote to <strong>${esc(customerName(q))}</strong>. The message is written for you; check it and press send.</p>
    ${expired ? `<p class="notice-inline">This quote expired on ${esc(niceDate(q.validUntil))}. Sending it again moves the date to ${esc(niceDate(addDays(today(), validDays())))}.</p>` : ''}
    <pre class="po-msg">${esc(quoteText(expired ? { ...q, validUntil: addDays(today(), validDays()) } : q))}</pre>
    <div class="btn-row">
      <button class="btn primary" id="qs-wa">WhatsApp${phone ? '' : ' (pick the chat)'}</button>
      ${c.email ? '<button class="btn ghost" id="qs-mail">Email</button>' : ''}
      <button class="btn ghost" id="qs-print">Print / PDF</button>
    </div>
    <p class="muted">Tip: Print / PDF, then save as PDF, attaches neatly to an email.</p>`, {
    okLabel: q.status === 'draft' || expired ? 'Mark as sent' : 'Done',
    onOk: async () => {
      if (q.status === 'draft' || expired) {
        await store.update('quotes', id, { status: 'sent', sentAt: store.nowIso(), ...(expired ? { validUntil: addDays(today(), validDays()) } : {}) }, 'Sent to the customer');
        toast(q.quoteNo + ' sent');
      }
    }
  });
  const text = () => quoteText(expired ? { ...q, validUntil: addDays(today(), validDays()) } : q);
  m.wrap.querySelector('#qs-wa').addEventListener('click', () => window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(text()), '_blank'));
  const mail = m.wrap.querySelector('#qs-mail');
  if (mail) mail.addEventListener('click', () => { location.href = 'mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent('Quotation ' + q.quoteNo + ' — ' + (settings.name || '')) + '&body=' + encodeURIComponent(text()); });
  m.wrap.querySelector('#qs-print').addEventListener('click', () => printQuote(id));
}

export function printQuote(id) {
  const q = quoteById(id); if (!q) return;
  const t = totals(q);
  const c = customerById(q.customerId) || {};
  const p = q.prospect || {};
  const to = [c.contact, c.address || p.address, c.area, c.phone || p.phone, c.email || p.email].filter(Boolean);
  const body = `${docHeader(settings, 'QUOTATION', q.quoteNo, ['Date ' + niceDate(String(q.createdAt || today()).slice(0, 10)), q.validUntil ? 'Valid until ' + niceDate(q.validUntil) : ''])}
    <div class="two"><div class="box"><h4>Quotation for</h4><strong>${esc(customerName(q))}</strong><br>${to.map(esc).join('<br>')}</div><div class="box"></div></div>
    <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Each</th><th class="r">Amount</th></tr>
      ${(q.lines || []).map(l => `<tr><td>${esc(l.description)}${l.fabric ? '<br><small>' + esc(l.fabric) + '</small>' : ''}</td><td class="r">${esc(l.qty)}</td><td class="r">${esc(money(l.unitPrice, cur()))}</td><td class="r">${esc(money(l.qty * l.unitPrice, cur()))}</td></tr>`).join('')}
      ${t.discount ? `<tr><td colspan="3" class="r">Discount</td><td class="r">−${esc(money(t.discount, cur()))}</td></tr>` : ''}
      <tr class="tot"><td colspan="3" class="r">Subtotal</td><td class="r">${esc(money(t.subtotal, cur()))}</td></tr>
      ${t.vat ? `<tr class="tot"><td colspan="3" class="r">VAT ${Math.round(vatRate() * 100)}%</td><td class="r">${esc(money(t.vat, cur()))}</td></tr>` : ''}
      <tr class="tot big"><td colspan="3" class="r">TOTAL</td><td class="r">${esc(money(t.total, cur()))}</td></tr>
    </table>
    ${q.notes ? `<p style="white-space:pre-line">${esc(q.notes)}</p>` : ''}
    ${settings.bankDetails ? `<div class="bank"><b>To go ahead, pay to</b>${esc(settings.bankDetails)}\nReference: ${esc(q.quoteNo)}</div>` : ''}
    <div class="ft">${q.validUntil ? 'This quotation is valid until ' + esc(niceDate(q.validUntil)) + '. ' : ''}Thank you for the opportunity.</div>`;
  openPrint(q.quoteNo, body);
}

// ---------------------------------------------------------- the outcome ----

// Yes: every line becomes an order for the factory, priced after the
// discount, and a new customer is added to the customer list.
export function acceptQuote(id) {
  const q = quoteById(id); if (!q) return;
  const t = totals(q);
  openModal('Accepted: ' + q.quoteNo, `
    <p>${(q.lines || []).length} order${(q.lines || []).length === 1 ? '' : 's'} will go to the factory for <strong>${esc(customerName(q))}</strong>, worth ${esc(money(t.subtotal, cur()))} excl. VAT.${q.customerId ? '' : ' They will be added to your customers.'}</p>
    ${row(field('Date paid / order placed', 'qa-paid', { type: 'date', value: today() }), field('Due out of the factory', 'qa-due', { type: 'date', value: addDays(today(), leadDays()) }))}`, {
    okLabel: 'Create the orders',
    onOk: async (w) => {
      const paid = val(w, 'qa-paid') || today();
      const due = val(w, 'qa-due') || addDays(paid, leadDays());
      let customerId = q.customerId, cname = q.customerName;
      if (!customerId) {
        const p = q.prospect || {};
        customerId = await store.create('customers', { name: p.name, contact: p.name, phone: p.phone || '', email: p.email || '', address: p.address || '', area: '', termsDays: 0, notes: 'Added from quote ' + q.quoteNo });
        cname = p.name;
      }
      const factor = t.subtotalRaw > 0 ? t.subtotal / t.subtotalRaw : 1;
      const orderNos = [];
      for (const l of q.lines || []) {
        const n = await store.nextNumber('orderNo', settings.firstOrderNo || 1001);
        const orderNo = (settings.orderPrefix || 'ORD-') + n;
        await store.create('orders', {
          orderNo, customerId, customerName: cname, externalRef: q.quoteNo, source: 'quote', quoteNo: q.quoteNo,
          product: l.description, qty: l.qty, fabric: l.fabric || '', notes: q.notes || '',
          paidDate: paid, dueDate: due, priceEach: r2(l.unitPrice * factor), status: 'new', fabricStatus: 'none',
          events: [{ at: store.nowIso(), by: who(), what: 'From accepted quote ' + q.quoteNo }]
        });
        orderNos.push(orderNo);
      }
      await store.update('quotes', id, { status: 'accepted', acceptedAt: store.nowIso(), orderNos, customerId, customerName: cname }, 'Accepted: orders ' + orderNos.join(', '));
      toast(q.quoteNo + ' accepted — ' + orderNos.join(', ') + ' sent to the factory');
    }
  });
}

export async function declineQuote(id) {
  const q = quoteById(id); if (!q) return;
  const why = prompt('Declined. Why, if you know? (price, timing, went elsewhere…)', '');
  if (why === null) return;
  await store.update('quotes', id, { status: 'declined', declinedAt: store.nowIso(), declineReason: why.trim() }, 'Declined' + (why.trim() ? ': ' + why.trim() : ''));
  toast(q.quoteNo + ' marked declined');
}
