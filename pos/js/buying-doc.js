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
    ${head(entity, store, po.status === 'draft' ? 'Purchase order (draft)' : 'Purchase order', po.docNo || 'DRAFT', po.sentAt || po.createdAt, po.expectedAt ? `<div class="s">Expected by ${esc(niceDate(po.expectedAt))}</div>` : '')}
    <div class="to"><div class="s">Supplier</div><b>${esc(sup.name)}</b>${sup.contact ? '<br>' + esc(sup.contact) : ''}${sup.phone ? '<br>' + esc(sup.phone) : ''}${sup.email ? '<br>' + esc(sup.email) : ''}${sup.accountNo ? '<br>Our account ' + esc(sup.accountNo) : ''}</div>
    <div class="to"><div class="s">Deliver to</div><b>${esc(store ? store.name : '')}</b>${store && addr(store.address) ? '<br>' + esc(addr(store.address)) : ''}${store && store.phone ? '<br>' + esc(store.phone) : ''}</div>
    <table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th><th class="n">Unit cost (ex VAT)</th><th class="n">Total</th></tr></thead>
      <tbody>${po.lines.map(l => `<tr><td>${esc(l.sku || l.barcode || '')}</td><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${esc(money(l.unitCostCents))}</td><td class="n">${esc(money(l.qty * l.unitCostCents))}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="n">Subtotal (ex VAT)</td><td class="n">${esc(money(po.subtotalCents))}</td></tr>${po.vatCents ? `<tr><td colspan="4" class="n">VAT ${(po.vatRateBp || 0) / 100}%</td><td class="n">${esc(money(po.vatCents))}</td></tr>` : ''}<tr class="tot"><td colspan="4" class="n">Total</td><td class="n">${esc(money(po.totalCents))}</td></tr></tfoot></table>
    ${po.note ? `<div class="pay">${esc(po.note)}</div>` : ''}
    <div class="foot s">Please quote ${esc(po.docNo || 'the order')} on your invoice and delivery note. Prices are as agreed, excluding VAT.</div>
  </div>`;
}
export const poShareText = (po, entity, url) => `${entity.tradingName || entity.legalName}: purchase order ${po.docNo}, ${po.lines.length} line${po.lines.length === 1 ? '' : 's'}, ${money(po.totalCents)} incl. VAT${po.expectedAt ? ', expected by ' + niceDate(po.expectedAt) : ''}.${url ? '\n' + url : ''}`;

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
