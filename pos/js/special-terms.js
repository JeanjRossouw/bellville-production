// Retail POS — the special-order rules the till and the server share:
// the settings, the status flow, the sign-off text the customer signs
// (the specification read back, no change of mind once in production),
// and the WhatsApp update for each status.
export const STATUSES = ['quoted', 'depositPaid', 'inProduction', 'ready', 'delivered', 'collected', 'cancelled'];
export const STATUS_LABEL = { quoted: 'Quoted', depositPaid: 'Deposit paid', inProduction: 'In production', ready: 'Ready', delivered: 'Delivered', collected: 'Collected', cancelled: 'Cancelled' };
// what may follow what
export const NEXT = { quoted: ['depositPaid', 'cancelled'], depositPaid: ['inProduction', 'ready', 'cancelled'], inProduction: ['ready', 'cancelled'], ready: ['delivered', 'collected', 'cancelled'], delivered: [], collected: [], cancelled: [] };
export const SPEC_FIELDS = [['model', 'Model'], ['size', 'Size'], ['fabric', 'Fabric'], ['colour', 'Colour'], ['legs', 'Legs'], ['notes', 'Notes']];
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
  if (status === 'delivered') return `Hi ${name}, ${co} here: your order ${so.docNo} was delivered today. Thank you — enjoy it, and tell us if anything is not right.`;
  if (status === 'collected') return `Hi ${name}, ${co} here: thank you for collecting your order ${so.docNo}. Enjoy it, and tell us if anything is not right.`;
  if (status === 'booked') return `Hi ${name}, ${co} here: your order ${so.docNo} is booked for ${so.delivery.kind === 'deliver' ? 'delivery' : 'collection'} on ${so.delivery.date}${so.delivery.slot ? ' (' + so.delivery.slot + ')' : ''}${so.delivery.kind === 'deliver' && so.delivery.address ? ' to ' + [so.delivery.address.line1, so.delivery.address.city].filter(Boolean).join(', ') : ''}.`;
  if (status === 'cancelled') return `Hi ${name}, ${co} here: your order ${so.docNo} has been cancelled${so.refundedCents ? ' and ' + rands(so.refundedCents) + ' refunded' : ''}.`;
  return `Hi ${name}, ${co} here with an update on your order ${so.docNo} (${what}): it is now ${STATUS_LABEL[status] || status}.`;
}
