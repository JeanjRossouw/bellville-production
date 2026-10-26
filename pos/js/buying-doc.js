// Retail POS — the buying documents as A4 pages: a purchase order for the
// supplier (also served by pos-doc from a signed link, to save as PDF), a
// goods-received note, and a transfer note. Shared by the till and the server.
import { esc, money, niceDate } from './ui.js';

const addr = (a) => a ? [a.line1, a.line2, a.city, a.code].filter(Boolean).join(', ') : '';
const head = (entity, store, title, docNo, date, extra = '') => `<div class="head"><div><div class="co">${esc(entity.tradingName || entity.legalName)}</div><div class="s">${esc([entity.legalName !== (entity.tradingName || entity.legalName) ? entity.legalName : '', addr(entity.address), entity.phone, entity.email, entity.regNo ? 'Reg no ' + entity.regNo : '', entity.vatNo ? 'VAT no ' + entity.vatNo : ''].filter(Boolean).join(' · '))}</div>${store ? `<div class="s">${esc(store.name)}${addr(store.address) ? ' · ' + esc(addr(store.address)) : ''}${store.phone ? ' · ' + esc(store.phone) : ''}</div>` : ''}</div>
  <div class="doc"><div class="t">${esc(title)}</div><div><b>${esc(docNo)}</b></div><div>${esc(niceDate(date))}</div>${extra}</div></div>`;

// ------------------------------------------------------------ PO --
export function poHtml({ po, entity, store, supplier }) {
  const sup = supplier || { name: po.supplierName };
  return `<div class="a4">
    ${head(entity, store, po.status === 'draft' ? 'Purchase order (draft)' : po.revision > 1 ? 'Purchase order · revised' : 'Purchase order', (po.docNo || 'DRAFT') + (po.revision > 1 ? ' rev ' + po.revision : ''), po.revisedAt || po.sentAt || po.createdAt, (po.expectedAt ? `<div class="s">Expected by ${esc(niceDate(po.expectedAt))}</div>` : '') + (po.revision > 1 ? `<div class="s">Replaces the earlier version of ${esc(po.docNo)}</div>` : ''))}
    <div class="to"><div class="s">Supplier</div><b>${esc(sup.name)}</b>${sup.contact ? '<br>' + esc(sup.contact) : ''}${sup.phone ? '<br>' + esc(sup.phone) : ''}${sup.email ? '<br>' + esc(sup.email) : ''}${sup.accountNo ? '<br>Our account ' + esc(sup.accountNo) : ''}</div>
    <div class="to"><div class="s">Deliver to</div><b>${esc(store ? store.name : '')}</b>${store && addr(store.address) ? '<br>' + esc(addr(store.address)) : ''}${store && store.phone ? '<br>' + esc(store.phone) : ''}</div>
    <table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th><th class="n">Unit cost (ex VAT)</th><th class="n">Total</th></tr></thead>
      <tbody>${po.lines.map(l => `<tr><td>${esc(l.sku || l.barcode || '')}</td><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${esc(money(l.unitCostCents))}</td><td class="n">${esc(money(l.qty * l.unitCostCents))}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="n">Subtotal (ex VAT)</td><td class="n">${esc(money(po.subtotalCents))}</td></tr>${po.vatCents ? `<tr><td colspan="4" class="n">VAT ${(po.vatRateBp || 0) / 100}%</td><td class="n">${esc(money(po.vatCents))}</td></tr>` : ''}<tr class="tot"><td colspan="4" class="n">Total</td><td class="n">${esc(money(po.totalCents))}</td></tr></tfoot></table>
    ${po.note ? `<div class="pay">${esc(po.note)}</div>` : ''}
    <div class="foot s">Please quote ${esc(po.docNo || 'the order')} on your invoice and delivery note. Prices are as agreed, excluding VAT.</div>
  </div>`;
}
// the order written out for an email: each line's code, description, quantity and price, then the totals
const poTitle = (po) => (po.revision > 1 ? 'CHANGED purchase order ' : 'Purchase order ') + po.docNo + (po.revision > 1 ? ' rev ' + po.revision : '');
export function poEmailText({ po, entity, store, supplier }) {
  const co = entity.tradingName || entity.legalName, sup = supplier || {};
  return [
    'Good day' + (sup.contact ? ' ' + sup.contact : '') + ',', '',
    po.revision > 1 ? `Please note the changed order below. It replaces the earlier version of ${po.docNo}.` : 'Please supply the order below.', '',
    poTitle(po) + ' · ' + co,
    'Date: ' + niceDate(po.revisedAt || po.sentAt || po.createdAt) + (po.expectedAt ? ' · Expected by: ' + niceDate(po.expectedAt) : ''),
    store ? 'Deliver to: ' + [store.name, addr(store.address)].filter(Boolean).join(', ') : null,
    sup.accountNo ? 'Our account: ' + sup.accountNo : null, '',
    'Code | Description | Qty | Unit cost (ex VAT) | Total',
    ...po.lines.map(l => `${l.sku || l.barcode || '-'} | ${l.name} | ${l.qty} | ${money(l.unitCostCents)} | ${money(l.qty * l.unitCostCents)}`), '',
    'Subtotal (ex VAT): ' + money(po.subtotalCents),
    po.vatCents ? `VAT ${(po.vatRateBp || 0) / 100}%: ${money(po.vatCents)}` : null,
    'Total: ' + money(po.totalCents), '',
    po.note ? 'Note: ' + po.note : null,
    `Please quote ${po.docNo} on your invoice and delivery note.`, '',
    'Regards', co, [entity.phone, entity.email].filter(Boolean).join(' · ') || null
  ].filter(x => x != null).join('\n').trim();
}
// the same order as spreadsheet rows (for xlsxBytes): rands as numbers so the sheet adds up
export function poSheet({ po, entity, store, supplier }) {
  const sup = supplier || { name: po.supplierName }, r = (c) => Math.round(c) / 100;
  return {
    sheet: po.docNo || 'Order',
    widths: [16, 44, 8, 18, 16],
    rows: [
      [{ v: poTitle(po), s: 'b' }],
      [[entity.tradingName || entity.legalName, entity.vatNo ? 'VAT no ' + entity.vatNo : '', entity.phone, entity.email].filter(Boolean).join(' · ')],
      ['Date', niceDate(po.revisedAt || po.sentAt || po.createdAt), '', po.expectedAt ? 'Expected by' : '', po.expectedAt ? niceDate(po.expectedAt) : ''],
      ['Supplier', sup.name || po.supplierName || '', '', sup.accountNo ? 'Our account' : '', sup.accountNo || ''],
      ['Deliver to', store ? [store.name, addr(store.address)].filter(Boolean).join(', ') : ''],
      [],
      [{ v: 'Code', s: 'b' }, { v: 'Description', s: 'b' }, { v: 'Qty', s: 'b' }, { v: 'Unit cost (ex VAT)', s: 'b' }, { v: 'Total (ex VAT)', s: 'b' }],
      ...po.lines.map(l => [l.sku || l.barcode || '', l.name, l.qty, { v: r(l.unitCostCents), s: 'm' }, { v: r(l.qty * l.unitCostCents), s: 'm' }]),
      [],
      ['', '', '', 'Subtotal (ex VAT)', { v: r(po.subtotalCents), s: 'm' }],
      ...(po.vatCents ? [['', '', '', `VAT ${(po.vatRateBp || 0) / 100}%`, { v: r(po.vatCents), s: 'm' }]] : []),
      ['', '', '', { v: 'Total', s: 'b' }, { v: r(po.totalCents), s: 'bm' }],
      [],
      ...(po.note ? [['Note', po.note]] : []),
      [`Please quote ${po.docNo} on your invoice and delivery note. Prices are as agreed, excluding VAT.`]
    ]
  };
}
export const poShareText =(po, entity, url) => `${entity.tradingName || entity.legalName}: ${po.revision > 1 ? 'CHANGED purchase order ' + po.docNo + ' (revision ' + po.revision + ', replaces the earlier one)' : 'purchase order ' + po.docNo}, ${po.lines.length} line${po.lines.length === 1 ? '' : 's'}, ${money(po.totalCents)} incl. VAT${po.expectedAt ? ', expected by ' + niceDate(po.expectedAt) : ''}.${url ? '\n' + url : ''}`;

// ----------------------------------------------------------- GRV --
export function grvHtml({ grv, entity, store }) {
  const L = grv.landed || {};
  return `<div class="a4">
    ${head(entity, store, 'Goods received', grv.docNo, grv.createdAt, `<div class="s">Received by ${esc(grv.receivedBy)}</div>`)}
    <div class="to"><div class="s">Supplier</div><b>${esc(grv.supplierName || '—')}</b>${grv.purchaseOrderDocNo ? '<br>Against ' + esc(grv.purchaseOrderDocNo) : '<br>Direct receipt, no purchase order'}${grv.supplierInvoiceNo ? '<br>Invoice ' + esc(grv.supplierInvoiceNo) + (grv.invoiceDate ? ' of ' + esc(niceDate(grv.invoiceDate)) : '') : ''}</div>
    <table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th><th class="n">Unit cost</th><th class="n">Landed each</th><th class="n">Total</th></tr></thead>
      <tbody>${grv.lines.map(l => `<tr><td>${esc(l.sku || '')}</td><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${esc(money(l.unitCostCents))}</td><td class="n">${esc(money(l.landedUnitCents))}</td><td class="n">${esc(money(l.landedCents))}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5" class="n">Goods (ex VAT)</td><td class="n">${esc(money(grv.subtotalCents))}</td></tr>${L.totalCents ? `<tr><td colspan="5" class="n">Landed costs (freight ${esc(money(L.freightCents || 0))}, duty ${esc(money(L.dutyCents || 0))}, other ${esc(money(L.otherCents || 0))}; by ${L.method === 'qty' ? 'quantity' : 'value'})</td><td class="n">${esc(money(L.totalCents))}</td></tr>` : ''}<tr class="tot"><td colspan="5" class="n">Total into stock</td><td class="n">${esc(money(grv.totalCostCents))}</td></tr></tfoot></table>
    ${grv.note ? `<div class="pay">${esc(grv.note)}</div>` : ''}
  </div>`;
}

// ------------------------------------------------------ transfer --
export function transferHtml({ tr, entity, fromStore, toStore }) {
  return `<div class="a4">
    ${head(entity, fromStore, 'Stock transfer', tr.docNo, tr.sentAt || tr.createdAt, `<div class="s">${esc(tr.status === 'inTransit' ? 'In transit' : tr.status)}</div>`)}
    <div class="to"><div class="s">From</div><b>${esc(fromStore ? fromStore.name : tr.fromStoreId)}</b><br>Sent by ${esc(tr.sentBy || '')}</div>
    <div class="to"><div class="s">To</div><b>${esc(toStore ? toStore.name : tr.toStoreId)}</b>${toStore && addr(toStore.address) ? '<br>' + esc(addr(toStore.address)) : ''}${tr.receivedBy ? '<br>Received by ' + esc(tr.receivedBy) + ' on ' + esc(niceDate(tr.receivedAt)) : ''}</div>
    <table><thead><tr><th>SKU</th><th>Item</th><th class="n">Sent</th><th class="n">Received</th><th class="n">Short</th></tr></thead>
      <tbody>${tr.lines.map(l => `<tr><td>${esc(l.sku || '')}</td><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${l.receivedQty || 0}</td><td class="n">${l.lostQty ? l.lostQty : ''}</td></tr>`).join('')}</tbody></table>
    ${tr.note ? `<div class="pay">${esc(tr.note)}</div>` : ''}
    <div class="sigline"><div>Received the goods above</div><div>Name: ____________________________ &nbsp; Signature: ____________________________ &nbsp; Date: ______________</div></div>
  </div>`;
}
