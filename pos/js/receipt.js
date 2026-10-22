// Retail POS — receipts and tax invoices, rendered from the sale the server
// wrote. Nothing here changes a sale.
//
// The kind follows the total and the company:
//   total ≤ R 50            a till slip
//   R 50.01 – R 5 000       an abridged tax invoice
//   over R 5 000            a full tax invoice (the customer's name and address on it)
//   not VAT registered      an "Invoice", no VAT line, whatever the total
// Each carries the sale number as a Code 128 barcode. A reprint is stamped COPY.
//
// Outputs: an 80 mm page and an A4 page for the browser's print dialog
// (A4 → Save as PDF), the same slip as ESC/POS bytes for a till printer
// behind a local print agent, and the text for a WhatsApp or email share.
import { esc, money, niceDate, niceTime } from './ui.js';
import { barcodeSvg, code128Widths, encodable } from './barcode.js';

export const SLIP_MAX = 5000, ABRIDGED_MAX = 500000;
export function receiptKind(sale, entity) {
  if (sale.series === 'LB') return 'layby-' + (sale.docKind || 'agreement');
  if (sale.series === 'CN') return 'creditnote';
  if (!entity.vatRegistered) return 'invoice';
  if (sale.totalCents <= SLIP_MAX) return 'slip';
  if (sale.totalCents <= ABRIDGED_MAX) return 'abridged';
  return 'full';
}
const LB_TITLES = { 'layby-agreement': 'Lay-by agreement', 'layby-payment': 'Lay-by payment', 'layby-collection': 'Collection slip', 'layby-cancel': 'Lay-by cancellation' };
export const kindTitle = (kind) => LB_TITLES[kind] || (kind === 'slip' ? 'Till slip' : kind === 'abridged' ? 'Tax invoice' : kind === 'full' ? 'Tax invoice' : kind === 'creditnote' ? 'Credit note' : 'Invoice');
// what a full tax invoice needs from the customer; '' when all is there
export function fullInvoiceGap(customer) {
  if (!customer || !String(customer.name || '').trim()) return 'the customer’s name';
  const a = customer.address || {};
  if (!String(a.line1 || a.city || '').trim()) return 'the customer’s address';
  return '';
}
const addr = (a) => [a && a.line1, a && a.line2, a && a.city, a && a.code].filter(Boolean).join(', ');
const methodLabel = (m) => ({ cash: 'Cash', card: 'Card', eft: 'EFT', qr: 'QR', voucher: 'Gift voucher', storeCredit: 'Store credit', account: 'On account', layby: 'Lay-by', creditNote: 'Credit note' })[m] || m;

// the facts every rendering shares
export function receiptModel({ sale, lines, payments, entity, store, settings, copy }) {
  const kind = receiptKind(sale, entity);
  const vat = !!entity.vatRegistered;
  const header = (store && store.receiptHeader) || (settings.receipt && settings.receipt.header) || '';
  const footer = (store && store.receiptFooter) || (settings.receipt && settings.receipt.footer) || '';
  const policy = (settings.receipt && settings.receipt.returnPolicy) || '';
  const cust = sale.customerSnapshot;
  return {
    kind, title: kindTitle(kind) + (copy ? ' · COPY' : ''), copy: !!copy, vat,
    company: { name: entity.tradingName || entity.legalName, legalName: entity.legalName, regNo: entity.regNo || '', vatNo: vat ? entity.vatNo : '', address: addr(entity.address), phone: entity.phone || '', email: entity.email || '' },
    store: store ? { name: store.name, address: addr(store.address), phone: store.phone || '' } : null,
    header, footer, policy,
    docNo: sale.docNo, date: sale.clientCreatedAt || sale.createdAt, cashier: sale.cashierName || '', register: sale.registerId || '',
    customer: cust ? { name: cust.name, vatNo: cust.vatNo || '', address: addr(cust.address), phone: cust.phone || '' } : null,
    lines: (lines || []).map(l => ({ name: l.name, qty: l.qty, unitPriceCents: l.unitPaidCents != null ? l.unitPaidCents : l.unitPriceCents, discountCents: l.unitPaidCents != null ? 0 : (l.discountCents || 0) + (l.saleDiscountCents || 0), lineTotalCents: l.netCents != null ? l.netCents : l.lineTotalCents, vatCents: l.vatCents || 0, vatRateBp: l.vatRateBp || 0, zero: !l.vatRateBp, note: l.note || (l.reason ? l.reason + (l.disposition ? ' · ' + l.disposition : '') : '') })),
    creditNote: sale.series === 'CN' ? { saleDocNo: sale.saleDocNo || '', noReceipt: !!sale.noReceipt, exchangeSaleId: sale.exchangeSaleId || '', exchangeUsedCents: sale.exchangeUsedCents || 0 } : null,
    subtotalCents: sale.subtotalCents, discountCents: (sale.lineDiscountCents || 0) + (sale.saleDiscountCents || 0), totalCents: sale.totalCents, vatCents: sale.vatCents, vatRateBp: sale.vatRateBp,
    exVatCents: sale.totalCents - sale.vatCents, roundingCents: sale.roundingCents || 0, changeCents: sale.changeCents || 0,
    payments: (payments || []).map(p => ({ label: (sale.series === 'CN' || p.amountCents < 0 ? 'Refund: ' : '') + methodLabel(p.method) + (p.cardLast4 ? ' ••' + p.cardLast4 : '') + (p.status === 'awaiting' ? ' (awaiting)' : ''), amountCents: Math.abs(p.amountCents), tenderedCents: p.tenderedCents, ref: p.ref || p.approvalCode || '' })),
    awaiting: sale.paidStatus === 'awaiting', vouchers: sale.vouchersSold || [], pending: !!sale.pending,
    // lay-by documents: facts in rows, the agreement's terms, the customer's signature, a line to sign on collection
    totals: sale.noTotals ? false : true, sections: sale.sections || [], terms: sale.terms || '', signature: sale.signature || '', signedBy: sale.signedBy || '', signLine: sale.signLine || '', refLabel: sale.refLabel || ''
  };
}

// ------------------------------------------------------------- 80 mm --
export function slipHtml(m) {
  const row = (a, b, cls = '') => `<div class="r ${cls}"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="slip">
    <div class="c"><div class="co">${esc(m.company.name)}</div>${m.store ? `<div>${esc(m.store.name)}</div>` : ''}${m.header ? `<div class="s">${esc(m.header).replace(/\n/g, '<br>')}</div>` : ''}${m.company.vatNo ? `<div class="s">VAT no ${esc(m.company.vatNo)}</div>` : ''}${m.company.regNo && m.kind === 'full' ? `<div class="s">Reg no ${esc(m.company.regNo)}</div>` : ''}</div>
    <div class="c t">${esc(m.title)}</div>
    ${row('No', '<b>' + esc(m.docNo) + '</b>')}${row('Date', esc(niceDate(m.date) + ' ' + niceTime(m.date)))}${m.cashier ? row('Served by', esc(m.cashier)) : ''}
    ${m.creditNote ? `<div class="s c">${m.creditNote.noReceipt ? 'Returned without a receipt · store credit' : 'Against ' + esc(m.creditNote.saleDocNo)}${m.creditNote.exchangeSaleId ? ' · exchanged' : ''}</div>` : ''}
    ${m.customer ? `<div class="box"><div>${esc(m.customer.name)}</div>${m.kind === 'full' && m.customer.address ? `<div class="s">${esc(m.customer.address)}</div>` : ''}${m.customer.vatNo ? `<div class="s">VAT no ${esc(m.customer.vatNo)}</div>` : ''}</div>` : ''}
    <div class="hr"></div>
    ${m.lines.map(l => `<div class="ln"><div>${esc(l.name)}${m.vat && l.zero ? ' <i>*</i>' : ''}</div><div class="r"><span>${l.qty} × ${esc(money(l.unitPriceCents))}${l.discountCents ? ' − ' + esc(money(l.discountCents)) : ''}</span><span>${esc(money(l.lineTotalCents))}</span></div>${l.note ? `<div class="s">${esc(l.note)}</div>` : ''}</div>`).join('')}
    <div class="hr"></div>
    ${m.refLabel ? `<div class="s c">${esc(m.refLabel)}</div>` : ''}
    ${m.totals && m.discountCents ? row('Discount', '− ' + esc(money(m.discountCents))) : ''}
    ${m.totals && m.vat ? row('Excl. VAT', esc(money(m.exVatCents))) + row('VAT ' + (m.vatRateBp / 100) + '%', esc(money(m.vatCents))) : ''}
    ${m.totals ? row('TOTAL', '<b>' + esc(money(m.totalCents)) + '</b>', 'tot') : ''}
    ${m.sections.map(sec => `<div class="hr"></div>${sec.title ? `<div class="c"><b>${esc(sec.title)}</b></div>` : ''}${sec.rows.map(r => row(esc(r[0]), r[2] ? '<b>' + esc(r[1]) + '</b>' : esc(r[1]))).join('')}`).join('')}
    ${m.roundingCents ? row('Cash rounding', esc(money(m.roundingCents))) : ''}
    ${m.payments.map(p => row(esc(p.label), esc(money(p.tenderedCents && p.tenderedCents !== p.amountCents ? p.tenderedCents : p.amountCents)))).join('')}
    ${m.changeCents ? row('Change', esc(money(m.changeCents))) : ''}
    ${m.awaiting ? '<div class="c s">Payment awaited: not yet paid</div>' : ''}
    ${m.pending ? '<div class="c s">Rung up offline: sent to the office when the line is back</div>' : ''}
    ${m.vat && m.lines.some(l => l.zero) ? '<div class="s">* zero-rated or exempt</div>' : ''}
    ${m.vouchers.map(v => `<div class="box c">Gift voucher ${esc(money(v.amountCents))}<br><b>${esc(v.code)}</b></div>`).join('')}
    ${m.terms ? `<div class="s pol">${esc(m.terms).replace(/\n/g, '<br>')}</div>` : ''}
    ${m.signature ? `<div class="sig"><img src="${m.signature}" alt="signature"><div class="s">Signed: ${esc(m.signedBy)}</div></div>` : m.signedBy ? `<div class="s">Signed: ${esc(m.signedBy)}</div>` : ''}
    ${m.signLine ? `<div class="sigline"><div class="s">${esc(m.signLine)}</div><div class="s">Name: ______________________</div><div class="s">Signature: __________________</div><div class="s">Date: ______________</div></div>` : ''}
    <div class="c bar">${encodable(m.docNo) ? barcodeSvg(m.docNo, 40) : ''}<div class="s">${esc(m.docNo)}</div></div>
    ${m.footer ? `<div class="c s">${esc(m.footer).replace(/\n/g, '<br>')}</div>` : ''}
    ${m.policy ? `<div class="s pol">${esc(m.policy)}</div>` : ''}
  </div>`;
}
export const SLIP_CSS = `
  @page { size: 80mm auto; margin: 3mm; } body { width: 74mm; margin: 0 auto; }
  .slip { font: 11.5px/1.35 "Courier New", monospace; color: #000; width: 74mm; }
  .slip .c { text-align: center; } .slip .co { font-weight: 700; font-size: 14px; } .slip .t { font-weight: 700; font-size: 12.5px; margin: 4px 0; text-transform: uppercase; }
  .slip .s { font-size: 10px; } .slip .r { display: flex; justify-content: space-between; gap: 6px; } .slip .r span:last-child { white-space: nowrap; }
  .slip .hr { border-top: 1px dashed #000; margin: 4px 0; } .slip .ln { margin: 2px 0; } .slip .tot { font-size: 13.5px; font-weight: 700; margin: 3px 0; }
  .slip .box { border: 1px solid #000; padding: 3px 5px; margin: 4px 0; } .slip .bar { margin: 6px 0 2px; } .slip .bar svg { width: 60mm; height: 12mm; display: block; margin: 0 auto; }
  .slip .pol { margin-top: 6px; border-top: 1px dashed #000; padding-top: 4px; white-space: normal; }
  .slip .sig img { display: block; max-width: 60mm; max-height: 20mm; margin: 4px auto 0; } .slip .sigline { margin-top: 10px; line-height: 2.2; }`;

// -------------------------------------------------------------- A4 --
export function a4Html(m) {
  return `<div class="a4${m.copy ? ' copy' : ''}">
    <div class="head"><div><div class="co">${esc(m.company.name)}</div><div class="s">${esc([m.company.legalName !== m.company.name ? m.company.legalName : '', m.company.address, m.company.phone, m.company.email, m.company.regNo ? 'Reg no ' + m.company.regNo : '', m.company.vatNo ? 'VAT no ' + m.company.vatNo : ''].filter(Boolean).join(' · '))}</div>${m.store ? `<div class="s">${esc(m.store.name)}${m.store.address ? ' · ' + esc(m.store.address) : ''}</div>` : ''}</div>
      <div class="doc"><div class="t">${esc(m.title)}</div><div><b>${esc(m.docNo)}</b></div><div>${esc(niceDate(m.date))} ${esc(niceTime(m.date))}</div>${m.cashier ? `<div class="s">Served by ${esc(m.cashier)}</div>` : ''}<div class="bar">${encodable(m.docNo) ? barcodeSvg(m.docNo, 40) : ''}</div></div></div>
    ${m.customer ? `<div class="to"><div class="s">${m.kind === 'full' ? 'Invoice to' : 'Customer'}</div><b>${esc(m.customer.name)}</b>${m.customer.address ? '<br>' + esc(m.customer.address) : ''}${m.customer.vatNo ? '<br>VAT no ' + esc(m.customer.vatNo) : ''}${m.customer.phone ? '<br>' + esc(m.customer.phone) : ''}</div>` : ''}
    <table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Each</th><th class="n">Discount</th>${m.vat ? '<th class="n">VAT</th>' : ''}<th class="n">Total</th></tr></thead>
      <tbody>${m.lines.map(l => `<tr><td>${esc(l.name)}${l.note ? '<div class="s">' + esc(l.note) + '</div>' : ''}</td><td class="n">${l.qty}</td><td class="n">${esc(money(l.unitPriceCents))}</td><td class="n">${l.discountCents ? '− ' + esc(money(l.discountCents)) : ''}</td>${m.vat ? `<td class="n">${l.zero ? '0%' : esc(money(l.vatCents))}</td>` : ''}<td class="n">${esc(money(l.lineTotalCents))}</td></tr>`).join('')}</tbody>
      <tfoot>${m.totals && m.vat ? `<tr><td colspan="${m.vat ? 5 : 4}" class="n">Excl. VAT</td><td class="n">${esc(money(m.exVatCents))}</td></tr><tr><td colspan="5" class="n">VAT ${m.vatRateBp / 100}%</td><td class="n">${esc(money(m.vatCents))}</td></tr>` : ''}
        ${m.totals ? `<tr class="tot"><td colspan="${m.vat ? 5 : 4}" class="n">Total</td><td class="n">${esc(money(m.totalCents))}</td></tr>` : ''}</tfoot></table>
    ${m.refLabel ? `<div class="pay">${esc(m.refLabel)}</div>` : ''}
    ${m.sections.map(sec => `<div class="sec">${sec.title ? `<div class="s st">${esc(sec.title)}</div>` : ''}<table class="kv">${sec.rows.map(r => `<tr><td>${esc(r[0])}</td><td class="n">${r[2] ? '<b>' + esc(r[1]) + '</b>' : esc(r[1])}</td></tr>`).join('')}</table></div>`).join('')}
    <div class="pay">${m.payments.map(p => `<div>${esc(p.label)}${p.ref ? ' · ' + esc(p.ref) : ''}: ${esc(money(p.amountCents))}</div>`).join('')}${m.roundingCents ? `<div>Cash rounding ${esc(money(m.roundingCents))}</div>` : ''}${m.changeCents ? `<div>Change ${esc(money(m.changeCents))}</div>` : ''}${m.awaiting ? '<div><b>Payment awaited: this invoice is not yet paid.</b></div>' : ''}</div>
    ${m.vouchers.length ? `<div class="pay">${m.vouchers.map(v => `<div>Gift voucher ${esc(money(v.amountCents))}: <b>${esc(v.code)}</b></div>`).join('')}</div>` : ''}
    ${m.terms ? `<div class="foot terms">${esc(m.terms).replace(/\n/g, '<br><br>')}</div>` : ''}
    ${m.signature ? `<div class="sig"><img src="${m.signature}" alt="signature"><div class="s">Signed: ${esc(m.signedBy)} · ${esc(niceDate(m.date))}</div></div>` : m.signedBy ? `<div class="sig s">Signed: ${esc(m.signedBy)}</div>` : ''}
    ${m.signLine ? `<div class="sigline"><div>${esc(m.signLine)}</div><div>Name: ____________________________ &nbsp; Signature: ____________________________ &nbsp; Date: ______________</div></div>` : ''}
    ${m.footer ? `<div class="foot">${esc(m.footer).replace(/\n/g, '<br>')}</div>` : ''}${m.policy ? `<div class="foot s">${esc(m.policy)}</div>` : ''}
    ${m.copy ? '<div class="stamp">COPY</div>' : ''}
  </div>`;
}
export const A4_CSS = `
  @page { size: A4; margin: 14mm; } body { font: 12px/1.45 Arial, Helvetica, sans-serif; color: #000; }
  .a4 { position: relative; max-width: 180mm; margin: 0 auto; } .a4 .s { font-size: 10.5px; color: #333; }
  .a4 .head { display: flex; justify-content: space-between; gap: 2rem; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 12px; }
  .a4 .co { font-size: 20px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; } .a4 .doc { text-align: right; } .a4 .t { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .a4 .bar svg { width: 48mm; height: 10mm; display: block; margin: 6px 0 0 auto; }
  .a4 .to { margin: 0 0 12px; padding: 8px 10px; border: 1px solid #000; display: inline-block; min-width: 60mm; }
  .a4 table { width: 100%; border-collapse: collapse; } .a4 th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid #000; padding: 6px 6px; }
  .a4 td { padding: 6px; border-bottom: 1px solid #ddd; vertical-align: top; } .a4 .n { text-align: right; white-space: nowrap; } .a4 tfoot td { border: 0; padding: 4px 6px; } .a4 .tot td { font-size: 15px; font-weight: 700; border-top: 2px solid #000; }
  .a4 .pay { margin-top: 10px; } .a4 .foot { margin-top: 18px; border-top: 1px solid #000; padding-top: 8px; } .a4 .terms { font-size: 11px; line-height: 1.5; }
  .a4 .sec { margin-top: 10px; } .a4 .st { font-weight: 700; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 2px; } .a4 .kv { width: auto; min-width: 90mm; } .a4 .kv td { padding: 3px 8px 3px 0; border: 0; }
  .a4 .sig { margin-top: 14px; } .a4 .sig img { display: block; max-width: 70mm; max-height: 28mm; border-bottom: 1px solid #000; } .a4 .sigline { margin-top: 24px; line-height: 2.4; }
  .a4 .stamp { position: absolute; top: 40mm; left: 50%; transform: translateX(-50%) rotate(-20deg); font-size: 64px; font-weight: 900; color: rgba(180, 0, 0, .25); border: 6px solid rgba(180, 0, 0, .25); padding: 4px 24px; letter-spacing: .3em; }`;

// --------------------------------------------------------- ESC/POS --
// The slip as bytes for a 80 mm thermal printer: ESC @ init, text with
// ESC a alignment, ESC E bold, GS ! size, GS k Code 128, GS V cut.
export function escposBytes(m) {
  const out = []; const enc = new TextEncoder();
  const push = (...b) => out.push(...b); const text = (s) => { push(...enc.encode(String(s).replace(/[^\x20-\x7e\n]/g, (c) => ({ '−': '-', '·': '-', '’': "'", '“': '"', '”': '"', '…': '...' })[c] || '?'))); };
  const line = (s = '') => { text(s); push(10); };
  const align = (n) => push(27, 97, n); const bold = (on) => push(27, 69, on ? 1 : 0); const size = (w, h) => push(29, 33, ((w - 1) << 4) | (h - 1));
  const W = 42;
  const lr = (a, b) => { a = String(a); b = String(b); const gap = Math.max(1, W - a.length - b.length); return a + ' '.repeat(gap) + b; };
  const rand = (c) => money(c).replace(/,/g, ' ');
  push(27, 64);
  align(1); bold(true); size(2, 2); line(m.company.name); size(1, 1); bold(false);
  if (m.store) line(m.store.name); if (m.header) m.header.split('\n').forEach(l => line(l)); if (m.company.vatNo) line('VAT no ' + m.company.vatNo);
  line(); bold(true); line(m.title.toUpperCase()); bold(false); line();
  align(0); line(lr('No', m.docNo)); line(lr('Date', niceDate(m.date) + ' ' + niceTime(m.date))); if (m.cashier) line(lr('Served by', m.cashier));
  if (m.customer) { line(m.customer.name); if (m.kind === 'full' && m.customer.address) line(m.customer.address); if (m.customer.vatNo) line('VAT no ' + m.customer.vatNo); }
  line('-'.repeat(W));
  for (const l of m.lines) { line(l.name.slice(0, W) + (m.vat && l.zero ? '*' : '')); line(lr(`  ${l.qty} x ${rand(l.unitPriceCents)}${l.discountCents ? ' -' + rand(l.discountCents) : ''}`, rand(l.lineTotalCents))); if (l.note) line('  ' + l.note.slice(0, W - 2)); }
  line('-'.repeat(W));
  if (m.refLabel) line(m.refLabel.slice(0, W));
  if (m.totals && m.discountCents) line(lr('Discount', '-' + rand(m.discountCents)));
  if (m.totals && m.vat) { line(lr('Excl. VAT', rand(m.exVatCents))); line(lr('VAT ' + (m.vatRateBp / 100) + '%', rand(m.vatCents))); }
  if (m.totals) { bold(true); size(1, 2); line(lr('TOTAL', rand(m.totalCents))); size(1, 1); bold(false); }
  for (const sec of m.sections) { line('-'.repeat(W)); if (sec.title) { bold(true); line(sec.title); bold(false); } for (const r of sec.rows) line(lr(r[0], r[1])); }
  if (m.roundingCents) line(lr('Cash rounding', rand(m.roundingCents)));
  for (const p of m.payments) line(lr(p.label, rand(p.tenderedCents && p.tenderedCents !== p.amountCents ? p.tenderedCents : p.amountCents)));
  if (m.changeCents) line(lr('Change', rand(m.changeCents)));
  if (m.awaiting) line('Payment awaited: not yet paid');
  if (m.vat && m.lines.some(l => l.zero)) line('* zero-rated or exempt');
  for (const v of m.vouchers) { align(1); line('Gift voucher ' + rand(v.amountCents)); bold(true); line(v.code); bold(false); align(0); }
  line(); align(1);
  if (encodable(m.docNo)) { push(29, 104, 60); push(29, 119, 2); push(29, 72, 2); push(29, 107, 73, m.docNo.length + 2, 123, 66); text(m.docNo); push(10); }
  if (m.terms) { align(0); line(); m.terms.split('\n').forEach(p => { wrap(p, W).forEach(l => line(l)); line(); }); if (m.signedBy) line('Signed: ' + m.signedBy); align(1); }
  if (m.signLine) { align(0); line(); line(m.signLine.slice(0, W)); line(); line('Name: ' + '_'.repeat(W - 6)); line(); line('Signature: ' + '_'.repeat(W - 11)); align(1); }
  if (m.footer) m.footer.split('\n').forEach(l => line(l)); if (m.policy) { line(); wrap(m.policy, W).forEach(l => line(l)); }
  line(); line(); line(); push(29, 86, 66, 0);
  return new Uint8Array(out);
}
function wrap(s, w) { const words = String(s).split(/\s+/), lines = []; let cur = ''; for (const x of words) { if ((cur + ' ' + x).trim().length > w) { lines.push(cur); cur = x; } else cur = (cur + ' ' + x).trim(); } if (cur) lines.push(cur); return lines; }

// ------------------------------------------------------------ share --
export function shareText(m, link) {
  const facts = m.sections.flatMap(sec => sec.rows.map(r => r[0] + ' ' + r[1])).join('; ');
  return `${m.company.name}: ${m.title.replace(' · COPY', '')} ${m.docNo}, ${niceDate(m.date)}.${m.totals ? ' Total ' + money(m.totalCents) + '.' : ''}${facts ? ' ' + facts + '.' : ''}${m.awaiting ? ' Payment awaited.' : ''}${link ? '\n' + link : ''}`;
}
export const whatsappUrl = (phone, text) => 'https://wa.me/' + String(phone || '').replace(/\D/g, '').replace(/^0/, '27') + '?text=' + encodeURIComponent(text);
export const mailtoUrl = (email, subject, text) => 'mailto:' + encodeURIComponent(email || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text);
export { code128Widths };
