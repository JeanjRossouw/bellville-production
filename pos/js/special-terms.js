// Retail POS — the special-order rules the till and the server share:
// the settings, the status flow, the sign-off text the customer signs
// (the specification read back, no change of mind once in production),
// and the WhatsApp update for each status.
export const STATUSES = ['quoted', 'depositPaid', 'inProduction', 'ready', 'outForDelivery', 'delivered', 'collected', 'cancelled'];
export const STATUS_LABEL = { quoted: 'Quoted', depositPaid: 'Deposit paid', inProduction: 'In production', ready: 'Ready', outForDelivery: 'Out for delivery', delivered: 'Delivered', collected: 'Collected', cancelled: 'Cancelled' };
// what may follow what
export const NEXT = { quoted: ['depositPaid', 'cancelled'], depositPaid: ['inProduction', 'ready', 'cancelled'], inProduction: ['ready', 'cancelled'], ready: ['outForDelivery', 'delivered', 'collected', 'cancelled'], outForDelivery: ['delivered'], delivered: [], collected: [], cancelled: [] };
// urgent: marked so by a person, or brought in from Shopify (until someone clears it)
export const isUrgent = (so) => !!so && (so.urgent === true || (so.urgent == null && so.source === 'shopify'));
export const SPEC_FIELDS = [['model', 'Model'], ['size', 'Size'], ['fabric', 'Fabric'], ['colour', 'Colour'], ['legs', 'Legs'], ['notes', 'Notes']];
// a sales order: a made-to-order item sold as an ordinary sale (invoiced), built by the factory and handed over
export const SALES_STATUSES = ['open', 'inProduction', 'ready', 'delivered', 'collected', 'cancelled'];
export const SALES_LABEL = { open: 'Ordered', inProduction: 'In production', ready: 'Ready', delivered: 'Delivered', collected: 'Collected', cancelled: 'Cancelled' };
export const SALES_NEXT = { open: ['inProduction', 'ready', 'cancelled'], inProduction: ['ready', 'cancelled'], ready: ['delivered', 'collected', 'cancelled'], delivered: [], collected: [], cancelled: [] };
// the fabric catalogue: what a fabric is called on an order, the metres a made-to-order item takes
// (the variant's, else the product's), what that fabric adds to the item's price, and the
// selling price per metre from the supplier's cost (excl. VAT) with the markup and 15% VAT on top,
// never under the lowest price per metre (incl. VAT)
export const FABRIC_MARKUP = 80, FABRIC_MIN_CENTS = 25000;
export const fabricLabel = (f) => (f.design || '') + (f.collection && String(f.collection).toLowerCase() !== String(f.design || '').toLowerCase() ? ' (' + f.collection + ')' : '') + (f.supplier ? ' · ' + f.supplier : '');
export const fabricMetresOf = (p, v) => { const m = Number(v && v.fabricMetres != null && v.fabricMetres !== '' ? v.fabricMetres : p && p.fabricMetres); return Number.isFinite(m) && m > 0 ? m : 0; };
// a couch's frame price (the variant's, else the product's): it without fabric, for a fabric of the customer's choice
export const framePriceOf = (p, v) => { const c = Number(v && v.framePriceCents != null && v.framePriceCents !== '' ? v.framePriceCents : p && p.framePriceCents); return Number.isFinite(c) && c > 0 ? Math.round(c) : 0; };
// a product a fabric can be chosen for: made to order, or a stocked couch with a frame price or fabric metres
export const upholsteredOf = (p, v) => !!p && (p.type === 'mto' || (p.type === 'stock' && (framePriceOf(p, v) > 0 || fabricMetresOf(p, v) > 0)));
export const fabricCentsFor = (metres, perMetreCents) => Math.round((Number(metres) || 0) * (Number(perMetreCents) || 0));
export const fabricPriceCents = (costCents, markupPct, minCents = 0) => Math.max(Math.round(Number(minCents) || 0), Math.round((Number(costCents) || 0) * (100 + (Number(markupPct) || 0)) * 115 / 10000));
export const CANCEL_KINDS = [['customer', 'The customer cancels'], ['store', 'We cannot make it'], ['other', 'Other']];

const num = (v, dflt) => (v == null || v === '' || !Number.isFinite(Number(v))) ? dflt : Number(v);
export function specialSettings(s = {}) {
  const x = s.specialOrder || {};
  return { minDepositPct: Math.min(100, Math.max(0, num(x.minDepositPct, 50))), leadDays: Math.max(1, Math.round(num(x.leadDays, 21))) };
}
const rands = (c) => 'R ' + (Math.round(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const specText = (sp) => SPEC_FIELDS.filter(f => sp && sp[f[0]]).map(f => f[1] + ' ' + sp[f[0]]).join(', ');

// the sign-off: the spec read back and the terms, written once and kept on the order
export function signoffText(entity, so) {
  const co = entity.legalName + (entity.tradingName && entity.tradingName !== entity.legalName ? ' trading as ' + entity.tradingName : '');
  return [
    `Special order ${so.docNo}: ${co} will make the following to ${so.customerSnapshot.name}'s specification.`,
    ...so.lines.map(l => `${l.qty} × ${l.name}: ${specText(l.spec) || 'as the standard product'}${l.spec && l.spec.photo ? ' (photo attached)' : ''}. ${rands(l.netCents != null ? l.netCents : l.lineTotalCents)}.`),
    `Price ${rands(so.totalCents)}${so.vatRegistered ? ' including VAT' : ''}. Deposit ${rands(so.minDepositCents)} (${so.minDepositPct}%) to start; the balance is paid before delivery or collection. Usual lead time ${so.leadDays} days from the deposit; we will send updates as it progresses.`,
    'I have checked the specification above (model, size, fabric, colour, legs and notes) and confirm it is what I want made. The goods are made to my specification and are not kept in stock: there is no change of mind once production has started (Consumer Protection Act, section 20(2)(b) — goods made to the consumer\'s specification). If I cancel after production has started, the deposit covers the work and materials already spent, and any further amount paid is refunded.',
    'Workmanship and materials are guaranteed for six months from delivery; made-to-order goods delivered with a defect are repaired, replaced or refunded as the Act provides.'
  ].join('\n');
}
// the WhatsApp message for a status
export function updateText(entity, store, so, status) {
  const co = entity.tradingName || entity.legalName;
  const name = so.customerSnapshot.name;
  const what = so.lines.map(l => l.name).join(', ');
  if (status === 'depositPaid') return `Hi ${name}, ${co} here. Thank you for your deposit on order ${so.docNo} (${what}). It is in the queue for production; usual lead time is ${so.leadDays} days${so.expectedAt ? ', expected around ' + so.expectedAt : ''}. We will let you know as it moves along.`;
  if (status === 'inProduction') return `Hi ${name}, ${co} here: your order ${so.docNo} (${what}) is now in production${so.expectedAt ? ', expected around ' + so.expectedAt : ''}.`;
  if (status === 'ready') return `Hi ${name}, ${co} here: good news, your order ${so.docNo} (${what}) is ready. ${so.balanceCents > 0 ? 'The balance of ' + rands(so.balanceCents) + ' is due before ' : 'Let us arrange '}${so.delivery && so.delivery.kind === 'deliver' ? 'delivery' : 'collection at ' + store.name}. Please reply to book a day.`;
  if (status === 'outForDelivery') return `Hi ${name}, ${co} here: your order ${so.docNo} (${what}) is out for delivery${so.delivery && so.delivery.date ? ' on ' + so.delivery.date + (so.delivery.slot ? ' (' + so.delivery.slot + ')' : '') : ''}${so.delivery && so.delivery.driverName ? ' with ' + so.delivery.driverName : ''}. The driver lets you know when they are on the way.`;
  if (status === 'delivered') return `Hi ${name}, ${co} here: your order ${so.docNo} was delivered today. Thank you — enjoy it, and tell us if anything is not right.`;
  if (status === 'collected') return `Hi ${name}, ${co} here: thank you for collecting your order ${so.docNo}. Enjoy it, and tell us if anything is not right.`;
  if (status === 'booked') return `Hi ${name}, ${co} here: your order ${so.docNo} is booked for ${so.delivery.kind === 'deliver' ? 'delivery' : 'collection'} on ${so.delivery.date}${so.delivery.slot ? ' (' + so.delivery.slot + ')' : ''}${so.delivery.kind === 'deliver' && so.delivery.address ? ' to ' + [so.delivery.address.line1, so.delivery.address.city].filter(Boolean).join(', ') : ''}.${so.balanceCents > 0 ? ' Please settle the balance of ' + rands(so.balanceCents) + ' before then: we deliver once it is paid in full.' : ''}`;
  if (status === 'cancelled') return `Hi ${name}, ${co} here: your order ${so.docNo} has been cancelled${so.refundedCents ? ' and ' + rands(so.refundedCents) + ' refunded' : ''}.`;
  return `Hi ${name}, ${co} here with an update on your order ${so.docNo} (${what}): it is now ${STATUS_LABEL[status] || status}.`;
}
// the WhatsApp update on a sales order
export function salesOrderText(entity, store, so, status) {
  const co = entity.tradingName || entity.legalName;
  const name = (so.customerSnapshot || {}).name || '';
  const what = (so.lines || []).map(l => l.name).join(', ');
  if (status === 'open') return `Hi ${name}, ${co} here. Thank you for your order (invoice ${so.docNo}: ${what}). It is in the queue for production${so.expectedAt ? ', expected around ' + so.expectedAt : ''}. We will let you know as it moves along.`;
  if (status === 'inProduction') return `Hi ${name}, ${co} here: your order ${so.docNo} (${what}) is now in production${so.expectedAt ? ', expected around ' + so.expectedAt : ''}.`;
  if (status === 'ready') return `Hi ${name}, ${co} here: good news, your order ${so.docNo} (${what}) is ready for collection at ${store.name}. Please reply to arrange a day, or delivery if you would prefer.`;
  if (status === 'delivered') return `Hi ${name}, ${co} here: your order ${so.docNo} was delivered today. Thank you — enjoy it, and tell us if anything is not right.`;
  if (status === 'collected') return `Hi ${name}, ${co} here: thank you for collecting your order ${so.docNo}. Enjoy it, and tell us if anything is not right.`;
  if (status === 'cancelled') return `Hi ${name}, ${co} here: your order ${so.docNo} has been cancelled.`;
  return `Hi ${name}, ${co} here with an update on your order ${so.docNo} (${what}): it is now ${SALES_LABEL[status] || status}.`;
}
