// Invoices — built in-app, in Couch Potato's own name and numbering.
//
// The queue is fed by the loading door: every dispatched order waits here
// until it is on an invoice, so nothing that left the factory goes unbilled.
// One invoice document per invoice, carrying its lines, VAT and payments;
// the orders it covers are stamped with its number.
import * as store from './store.js';
import { allOrders, orderById } from './orders.js';
import { allCustomers, customerById } from './customers.js';
import { esc, money, field, row, val, openModal, toast, empty, niceDate, today, addDays } from './ui.js';

let invoices = [];
let unwatch = null;
let onChange = null;
let settings = {};
let invView = 'queue';     // queue | invoices | statements
let invFilter = 'open';    // open | paid | all
let stmtCustomer = '';

export function startInvoices(cb, cfg) {
  onChange = cb;
  settings = cfg || {};
  if (unwatch) unwatch();
  unwatch = store.watch('invoices', rows => {
    invoices = rows.sort((a, b) => String(b.invoiceNo || '').localeCompare(String(a.invoiceNo || ''), undefined, { numeric: true }));
    if (onChange) onChange();
  });
}
export const setInvoiceSettings = (cfg) => { settings = cfg || {}; };
export const setInvView = (v) => { invView = v; };
export const setInvFilter = (f) => { invFilter = f; };
export const setStmtCustomer = (id) => { stmtCustomer = id; };
export const allInvoices = () => invoices;
export const invoiceById = (id) => invoices.find(i => i.id === id) || null;

// --------------------------------------------------------------- maths ------

const vatRate = () => settings.vatRegistered ? (Number(settings.vatRate) || 0) : 0;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const paidAmount = (inv) => r2((inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
export const balance = (inv) => r2((Number(inv.total) || 0) - paidAmount(inv));
export const isOverdue = (inv) => inv.status === 'issued' && balance(inv) > 0 && !!inv.dueDate && inv.dueDate < today();

function totalsFor(lines) {
  const subtotal = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0));
  const vat = r2(subtotal * vatRate());
  return { subtotal, vat, total: r2(subtotal + vat) };
}

// ---------------------------------------------------------------- queue -----

export const queue = () => allOrders().filter(o => o.status === 'dispatched');

// Raise one invoice for a set of dispatched orders belonging to one customer.
export function newInvoiceFor(orderIds) {
  const orders = orderIds.map(orderById).filter(Boolean).filter(o => o.status === 'dispatched');
  if (!orders.length) { toast('Nothing to invoice', 'warn'); return; }
  const custId = orders[0].customerId;
  if (orders.some(o => o.customerId !== custId)) { toast('One invoice per customer — pick orders for one customer at a time', 'warn'); return; }
  const c = customerById(custId) || { name: orders[0].customerName };
  const cur = settings.currency || 'R';
  const terms = c.termsDays != null ? Number(c.termsDays) : (Number(settings.paymentTermsDays) || 0);
  const lineRow = (o, i) => `<div class="inv-line" data-i="${i}">
      <input class="il-desc" value="${esc((o.product || '') + (o.fabric ? ' — ' + o.fabric : ''))}" title="Description">
      <input class="il-qty" type="number" min="0" step="1" value="${esc(o.qty || 1)}" title="Qty">
      <input class="il-price" type="number" min="0" step="0.01" value="${esc(o.priceEach || '')}" placeholder="price each" title="Price each excl. VAT">
      <span class="il-tot muted"></span>
    </div>`;
  const m = openModal('New invoice — ' + (c.name || ''), `
    ${row(field('Invoice date', 'iv-date', { value: today(), type: 'date' }), field('Due date', 'iv-due', { value: addDays(today(), terms), type: 'date' }))}
    <div class="fld"><span>Lines (one per order)</span>
      <div class="inv-lines-head"><span>Description</span><span>Qty</span><span>Each</span><span>Total</span></div>
      <div id="inv-lines">${orders.map(lineRow).join('')}</div>
    </div>
    <div class="cost-live" id="iv-live"></div>
    ${field('Note on the invoice', 'iv-note', { value: '', type: 'textarea', placeholder: 'e.g. Delivered to Bellville showroom' })}`,
    {
      okLabel: 'Issue invoice',
      onOk: async (w) => {
        const lines = [];
        w.querySelectorAll('.inv-line').forEach((r, i) => {
          const o = orders[i];
          lines.push({ orderId: o.id, orderNo: o.orderNo || '', externalRef: o.externalRef || '',
            description: r.querySelector('.il-desc').value.trim() || o.product || '',
            qty: parseFloat(r.querySelector('.il-qty').value) || 0,
            unitPrice: parseFloat(r.querySelector('.il-price').value) || 0 });
        });
        if (lines.some(l => !l.unitPrice)) { toast('Every line needs a price', 'warn'); return false; }
        const t = totalsFor(lines);
        const n = await store.nextNumber('invoiceNo', settings.firstInvoiceNo || 1);
        const invoiceNo = (settings.invoicePrefix || 'INV-') + String(n).padStart(4, '0');
        const id = await store.create('invoices', {
          invoiceNo, customerId: custId, customerName: c.name || orders[0].customerName || '',
          date: val(w, 'iv-date') || today(), dueDate: val(w, 'iv-due') || '',
          lines, subtotal: t.subtotal, vat: t.vat, vatRate: vatRate(), total: t.total,
          status: 'issued', payments: [], note: val(w, 'iv-note'),
          events: [{ at: store.nowIso(), by: (store.getUser() || {}).name || 'system', what: 'Invoice issued' }]
        });
        for (const o of orders) await store.update('orders', o.id, { status: 'invoiced', invoiceId: id, invoiceNo }, 'Invoiced on ' + invoiceNo);
        toast(invoiceNo + ' issued for ' + money(t.total, cur));
        setTimeout(() => printInvoice(id), 150);
      }
    });
  const card = m.wrap.querySelector('.modal-card');
  const live = () => {
    const lines = [];
    card.querySelectorAll('.inv-line').forEach(r => {
      const q = parseFloat(r.querySelector('.il-qty').value) || 0, p = parseFloat(r.querySelector('.il-price').value) || 0;
      r.querySelector('.il-tot').textContent = money(q * p, cur);
      lines.push({ qty: q, unitPrice: p });
    });
    const t = totalsFor(lines);
    card.querySelector('#iv-live').innerHTML = `<div><span>Subtotal</span><strong>${esc(money(t.subtotal, cur))}</strong></div>`
      + (vatRate() ? `<div><span>VAT ${Math.round(vatRate() * 100)}%</span><strong>${esc(money(t.vat, cur))}</strong></div>` : '')
      + `<div class="tot"><span>Total</span><strong>${esc(money(t.total, cur))}</strong></div>`;
  };
  card.addEventListener('input', live);
  live();
}

export function invoiceCustomerQueue(customerId) {
  newInvoiceFor(queue().filter(o => o.customerId === customerId).map(o => o.id));
}

// ------------------------------------------------------------- payments -----

export function recordPayment(id) {
  const inv = invoiceById(id);
  if (!inv) return;
  const cur = settings.currency || 'R';
  const due = balance(inv);
  openModal('Payment on ' + inv.invoiceNo, `
    <p class="muted">${esc(inv.customerName)} · total ${esc(money(inv.total, cur))} · paid so far ${esc(money(paidAmount(inv), cur))} · <strong>owing ${esc(money(due, cur))}</strong></p>
    ${row(field('Amount received', 'pm-amt', { value: due, type: 'number', min: 0, step: '0.01' }), field('Date', 'pm-date', { value: today(), type: 'date' }))}
    ${row(field('Method', 'pm-method', { type: 'select', value: 'EFT', options: ['EFT', 'Cash', 'Card', 'Other'].map(x => ({ value: x, label: x })) }), field('Reference', 'pm-ref', { value: '', placeholder: 'Bank reference / receipt no.' }))}`,
    {
      okLabel: 'Record payment',
      onOk: async (w) => {
        const amount = parseFloat(val(w, 'pm-amt')) || 0;
        if (amount <= 0) { toast('Enter the amount received', 'warn'); return false; }
        const payments = [...(inv.payments || []), { at: val(w, 'pm-date') || today(), amount: r2(amount), method: val(w, 'pm-method'), ref: val(w, 'pm-ref'), by: (store.getUser() || {}).name || '' }];
        const paidNow = r2(payments.reduce((s, p) => s + p.amount, 0));
        const patch = { payments };
        if (paidNow >= (Number(inv.total) || 0) - 0.005) { patch.status = 'paid'; patch.paidAt = val(w, 'pm-date') || today(); }
        await store.update('invoices', id, patch, 'Payment ' + money(amount, cur) + ' (' + val(w, 'pm-method') + ')' + (patch.status === 'paid' ? ' — paid in full' : ''));
        toast(patch.status === 'paid' ? inv.invoiceNo + ' paid in full' : money(amount, cur) + ' recorded');
      }
    });
}

export async function voidInvoice(id) {
  const inv = invoiceById(id);
  if (!inv) return;
  if (paidAmount(inv) > 0) { toast('This invoice has payments on it — it cannot be voided', 'warn'); return; }
  if (!confirm('Void ' + inv.invoiceNo + '? Its orders go back to the invoice queue.')) return;
  await store.update('invoices', id, { status: 'void' }, 'Invoice voided');
  for (const l of inv.lines || []) {
    const o = orderById(l.orderId);
    if (o && o.invoiceId === id) await store.update('orders', o.id, { status: 'dispatched', invoiceId: '', invoiceNo: '' }, 'Invoice ' + inv.invoiceNo + ' voided — back in the queue');
  }
  toast(inv.invoiceNo + ' voided');
}

// ---------------------------------------------------------------- render ----

export function renderInvoices(host) {
  const cur = settings.currency || 'R';
  const live = invoices.filter(i => i.status !== 'void');
  const outstanding = live.filter(i => i.status === 'issued');
  const owing = outstanding.reduce((s, i) => s + balance(i), 0);
  const overdue = outstanding.filter(isOverdue);
  const month = today().slice(0, 7);
  const thisMonth = live.filter(i => String(i.date || '').startsWith(month)).reduce((s, i) => s + (Number(i.total) || 0), 0);
  const q = queue();
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  const tab = (key, label, n) => `<button class="btn ${invView === key ? 'primary' : 'ghost'} sm" data-act="inv-view" data-to="${key}">${label}${n != null ? ' (' + n + ')' : ''}</button>`;
  let body;
  if (invView === 'queue') body = queueHtml(q, cur);
  else if (invView === 'statements') body = statementsHtml(cur);
  else body = listHtml(cur);
  host.innerHTML = `
    <div class="page-head">
      <div><h1>Invoices</h1><p class="sub">Everything dispatched gets billed; everything billed gets chased</p></div>
      <div class="btn-row"><button class="btn ghost" data-act="inv-export">Export for the accountant</button></div>
    </div>
    <div class="tiles">
      ${tile(q.length, 'Waiting to be invoiced', q.length ? 'amber' : '')}
      ${tile(overdue.length, 'Overdue invoices', overdue.length ? 'red' : '')}
      <div class="tile ${owing ? 'amber' : ''}"><div class="tile-n">${esc(money(owing, cur))}</div><div class="tile-l">Owed to the factory</div></div>
      <div class="tile wide"><div class="tile-n">${esc(money(thisMonth, cur))}</div><div class="tile-l">Invoiced this month</div></div>
    </div>
    <div class="btn-row" style="margin-bottom:.9rem">${tab('queue', 'To invoice', q.length)}${tab('invoices', 'Invoices', live.length)}${tab('statements', 'Statements')}</div>
    ${body}`;
}

function queueHtml(q, cur) {
  if (!q.length) return empty('', 'Nothing waiting', 'Orders appear here the moment they are scanned out at the door.');
  const byCust = {};
  q.forEach(o => { (byCust[o.customerId] = byCust[o.customerId] || []).push(o); });
  return `<p class="muted" style="margin:-.3rem 0 .7rem">One invoice per customer. Invoice everything for a customer in one go, or tick the orders you want on it.</p>` + Object.keys(byCust).map(cid => {
    const rows = byCust[cid];
    const c = customerById(cid) || { name: rows[0].customerName };
    const total = rows.reduce((s, o) => s + (Number(o.priceEach) || 0) * (o.qty || 1), 0);
    return `<div class="card">
      <div class="page-head" style="margin:0 0 .5rem"><div><h2>${esc(c.name || '')}</h2><p class="sub">${rows.length} order${rows.length === 1 ? '' : 's'} · ${esc(money(total, cur))} excl. VAT</p></div>
        <div class="btn-row">
          <button class="btn ghost sm" data-act="inv-selected" data-cust="${esc(cid)}">Invoice ticked</button>
          <button class="btn primary sm" data-act="inv-customer" data-cust="${esc(cid)}">Invoice all ${rows.length}</button>
        </div></div>
      <table class="tbl"><thead><tr><th></th><th>Order</th><th>Product</th><th>Dispatched</th><th class="r">Amount</th></tr></thead><tbody>
        ${rows.map(o => `<tr><td><input type="checkbox" class="q-pick" data-cust="${esc(cid)}" value="${esc(o.id)}"></td>
          <td><strong>${esc(o.orderNo || '')}</strong>${o.externalRef ? '<div class="muted">their ref ' + esc(o.externalRef) + '</div>' : ''}</td>
          <td>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}${o.fabric ? '<div class="muted">' + esc(o.fabric) + '</div>' : ''}</td>
          <td>${esc(niceDate(o.dispatchedAt))}${o.dispatchedBy ? '<div class="muted">' + esc(o.dispatchedBy) + '</div>' : ''}</td>
          <td class="r">${o.priceEach ? esc(money(o.priceEach * (o.qty || 1), cur)) : '<span class="chip late">no price</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }).join('');
}

export function pickedIds(host, cid) {
  return [...host.querySelectorAll('.q-pick:checked')].filter(cb => cb.dataset.cust === cid).map(cb => cb.value);
}

function statusChipInv(inv) {
  if (inv.status === 'void') return '<span class="chip warn-soft">void</span>';
  if (inv.status === 'paid') return '<span class="chip st-disp">✓ Paid</span>';
  if (isOverdue(inv)) return '<span class="chip late">Overdue</span>';
  return paidAmount(inv) > 0 ? '<span class="chip soon">Part paid</span>' : '<span class="chip st-prod">Issued</span>';
}

function listHtml(cur) {
  const rows = invoices.filter(i => invFilter === 'all' ? true : invFilter === 'paid' ? i.status === 'paid' : i.status === 'issued');
  const sel = `<select id="inv-filter" style="font:inherit; font-size:13px; padding:.4rem .6rem; border:1px solid var(--line); border-radius:8px">
    <option value="open"${invFilter === 'open' ? ' selected' : ''}>Unpaid</option><option value="paid"${invFilter === 'paid' ? ' selected' : ''}>Paid</option><option value="all"${invFilter === 'all' ? ' selected' : ''}>All (incl. void)</option></select>`;
  if (!rows.length) return sel + empty('', 'No invoices here', invoices.length ? 'Try another filter.' : 'Issue the first one from the To invoice tab.');
  return sel + `<div class="card" style="padding:0; overflow:auto; margin-top:.6rem"><table class="tbl">
    <thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th class="r">Total</th><th class="r">Owing</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map(i => `<tr${i.status === 'void' ? ' style="opacity:.5"' : ''}>
      <td><strong>${esc(i.invoiceNo)}</strong><div class="muted">${(i.lines || []).map(l => l.orderNo).filter(Boolean).join(', ')}</div></td>
      <td>${esc(i.customerName)}</td><td>${esc(niceDate(i.date))}</td><td>${esc(niceDate(i.dueDate))}</td>
      <td class="r">${esc(money(i.total, cur))}</td><td class="r">${i.status === 'void' ? '—' : esc(money(balance(i), cur))}</td>
      <td>${statusChipInv(i)}</td>
      <td class="r nowrap">
        <button class="btn ghost sm" data-act="inv-print" data-id="${esc(i.id)}" title="View / print">Print</button>
        ${i.status === 'issued' ? `<button class="btn primary sm" data-act="inv-pay" data-id="${esc(i.id)}">Payment</button>` : ''}
        ${i.status !== 'void' && !paidAmount(i) ? `<button class="btn danger sm" data-act="inv-void" data-id="${esc(i.id)}" title="Void">✕</button>` : ''}
      </td></tr>`).join('')}</tbody></table></div>`;
}

function statementsHtml(cur) {
  const custs = allCustomers();
  const cid = stmtCustomer || (custs[0] && custs[0].id) || '';
  const c = customerById(cid);
  const sel = `<select id="stmt-cust" style="font:inherit; font-size:14px; padding:.5rem .7rem; border:1px solid var(--line); border-radius:8px">${custs.map(x => `<option value="${esc(x.id)}"${x.id === cid ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  if (!c) return empty('', 'No customers yet', '');
  const rows = invoices.filter(i => i.customerId === cid && i.status !== 'void').sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const owing = rows.reduce((s, i) => s + balance(i), 0);
  return `<div class="btn-row" style="margin-bottom:.8rem; align-items:center">${sel}<button class="btn ghost" data-act="stmt-print" data-cust="${esc(cid)}">Print statement</button></div>
    <div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>Date</th><th>Invoice</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Owing</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(i => `<tr><td>${esc(niceDate(i.date))}</td><td><strong>${esc(i.invoiceNo)}</strong></td><td>${esc(niceDate(i.dueDate))}</td>
        <td class="r">${esc(money(i.total, cur))}</td><td class="r">${esc(money(paidAmount(i), cur))}</td><td class="r">${esc(money(balance(i), cur))}</td><td>${statusChipInv(i)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="muted">No invoices for this customer yet.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="5" class="r">Balance owing</th><th class="r">${esc(money(owing, cur))}</th><th></th></tr></tfoot>
    </table></div>`;
}

// --------------------------------------------------------------- printing ---

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
function openPrint(title, body) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
    <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:800;background:#000;color:#fff;border:0;cursor:pointer">PRINT</button>
    <button onclick="window.close()" style="padding:8px 16px;margin-left:8px;cursor:pointer">CLOSE</button></div>${body}</body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups for this site, then try again', 'warn'); return; }
  win.document.write(html); win.document.close();
}
function coHeader(kind, no, lines) {
  const details = [settings.legalName && settings.legalName !== settings.name ? settings.legalName : '', settings.address, settings.phone, settings.email,
    settings.regNo ? 'Reg. no. ' + settings.regNo : '', settings.vatRegistered && settings.vatNo ? 'VAT no. ' + settings.vatNo : ''].filter(Boolean).join('\n');
  return `<div class="hd"><div class="co">${esc((settings.name || 'COUCH POTATO').toUpperCase())}<small>${esc(details)}</small></div>
    <div class="t"><b>${esc(kind)}</b><span class="n">${esc(no)}</span>${(lines || []).map(l => `<span>${esc(l)}</span>`).join('')}</div></div>`;
}

export function printInvoice(id) {
  const inv = invoiceById(id);
  if (!inv) return;
  const cur = settings.currency || 'R';
  const c = customerById(inv.customerId) || {};
  const body = `${inv.status === 'paid' ? '<div class="paid">PAID</div>' : ''}
    ${coHeader(settings.vatRegistered ? 'TAX INVOICE' : 'INVOICE', inv.invoiceNo, ['Date ' + niceDate(inv.date), inv.dueDate ? 'Due ' + niceDate(inv.dueDate) : ''])}
    <div class="two">
      <div class="box"><h4>Invoice to</h4><strong>${esc(inv.customerName)}</strong><br>${esc([c.contact, c.address, c.area].filter(Boolean).join('\n')).replace(/\n/g, '<br>')}${c.email ? '<br>' + esc(c.email) : ''}${c.phone ? '<br>' + esc(c.phone) : ''}</div>
      <div class="box"><h4>Orders</h4>${(inv.lines || []).map(l => esc(l.orderNo) + (l.externalRef ? ' (their ref ' + esc(l.externalRef) + ')' : '')).join('<br>')}</div>
    </div>
    <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Each</th><th class="r">Amount</th></tr>
      ${(inv.lines || []).map(l => `<tr><td>${esc(l.description)}<br><small>Order ${esc(l.orderNo)}</small></td><td class="r">${esc(l.qty)}</td><td class="r">${esc(money(l.unitPrice, cur))}</td><td class="r">${esc(money(l.qty * l.unitPrice, cur))}</td></tr>`).join('')}
      <tr class="tot"><td colspan="3" class="r">Subtotal</td><td class="r">${esc(money(inv.subtotal, cur))}</td></tr>
      ${inv.vat ? `<tr class="tot"><td colspan="3" class="r">VAT ${Math.round((inv.vatRate || 0) * 100)}%</td><td class="r">${esc(money(inv.vat, cur))}</td></tr>` : ''}
      <tr class="tot big"><td colspan="3" class="r">TOTAL</td><td class="r">${esc(money(inv.total, cur))}</td></tr>
      ${paidAmount(inv) ? `<tr><td colspan="3" class="r">Paid</td><td class="r">${esc(money(paidAmount(inv), cur))}</td></tr><tr class="tot"><td colspan="3" class="r">Balance due</td><td class="r">${esc(money(balance(inv), cur))}</td></tr>` : ''}
    </table>
    ${inv.note ? `<p>${esc(inv.note)}</p>` : ''}
    ${settings.bankDetails ? `<div class="bank"><b>Payment details</b>${esc(settings.bankDetails)}\nReference: ${esc(inv.invoiceNo)}</div>` : ''}
    <div class="ft">${inv.dueDate ? 'Payment due by ' + esc(niceDate(inv.dueDate)) + '. ' : ''}Thank you for your business.</div>`;
  openPrint(inv.invoiceNo, body);
}

export function printStatement(customerId) {
  const c = customerById(customerId);
  if (!c) return;
  const cur = settings.currency || 'R';
  const rows = invoices.filter(i => i.customerId === customerId && i.status !== 'void').sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const owing = rows.reduce((s, i) => s + balance(i), 0);
  const body = `${coHeader('STATEMENT', niceDate(today()), [])}
    <div class="two"><div class="box"><h4>Statement for</h4><strong>${esc(c.name)}</strong><br>${esc([c.contact, c.address, c.area].filter(Boolean).join(', '))}</div>
    <div class="box t"><h4>Balance owing</h4><span class="n" style="font-size:20px">${esc(money(owing, cur))}</span></div></div>
    <table><tr><th>Date</th><th>Invoice</th><th>Orders</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Owing</th></tr>
      ${rows.map(i => `<tr><td>${esc(niceDate(i.date))}</td><td>${esc(i.invoiceNo)}</td><td>${(i.lines || []).map(l => esc(l.orderNo)).join(', ')}</td><td>${esc(niceDate(i.dueDate))}${isOverdue(i) ? ' <b>overdue</b>' : ''}</td>
        <td class="r">${esc(money(i.total, cur))}</td><td class="r">${esc(money(paidAmount(i), cur))}</td><td class="r">${esc(money(balance(i), cur))}</td></tr>`).join('') || '<tr><td colspan="7">No invoices.</td></tr>'}
      <tr class="tot big"><td colspan="6" class="r">BALANCE OWING</td><td class="r">${esc(money(owing, cur))}</td></tr>
    </table>
    ${settings.bankDetails ? `<div class="bank"><b>Payment details</b>${esc(settings.bankDetails)}</div>` : ''}`;
  openPrint('Statement — ' + c.name, body);
}

// CSV of every invoice line, for whoever does the books.
export function exportCsv() {
  const rows = [['Invoice', 'Status', 'Date', 'Due', 'Customer', 'Order', 'Their ref', 'Description', 'Qty', 'Each excl', 'Line excl', 'Invoice subtotal', 'VAT', 'Invoice total', 'Paid', 'Owing', 'Paid on']];
  invoices.slice().reverse().forEach(i => (i.lines || []).forEach(l => rows.push([
    i.invoiceNo, i.status, i.date, i.dueDate, i.customerName, l.orderNo, l.externalRef || '', l.description, l.qty, r2(l.unitPrice), r2(l.qty * l.unitPrice),
    r2(i.subtotal), r2(i.vat), r2(i.total), paidAmount(i), i.status === 'void' ? 0 : balance(i), i.paidAt || ''
  ])));
  if (rows.length === 1) { toast('No invoices to export yet', 'warn'); return; }
  const csv = rows.map(r => r.map(v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = (settings.name || 'couch-potato').toLowerCase().replace(/\s+/g, '-') + '-invoices-' + today() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  toast('Invoice export downloaded');
}
