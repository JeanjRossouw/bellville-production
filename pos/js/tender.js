// Retail POS — taking money now, at the till or in the office, the same way everywhere (sales orders, lay-bys,
// account payments): the methods a store offers (cash only at an open register, so it is in that drawer's
// cash-up), the proof field (the EFT or QR reference as it will show on the bank statement; a card needs
// nothing typed), and a tender built from those fields, checked the way the server checks it (lib/sale.mjs moneyNow).
import { toast, field, row, val } from './ui.js';
import { centsOf } from './money.js';

export const METHOD = { cash: 'Cash', card: 'Card', eft: 'EFT', qr: 'QR', storeCredit: 'Store credit', shopify: 'Paid via Shopify' };
// the ways an order can be paid here: cash only at an open register (it is counted in that drawer's cash-up)
export const payMethods = (dd, extra = []) => (dd.store.paymentMethods || ['cash', 'card']).filter(k => METHOD[k] && (k !== 'cash' || (dd.registerId && dd.shiftOpen)) && (k === 'storeCredit' ? extra.includes('storeCredit') : k !== 'storeCredit'));
// the proof field for a payment: the bank reference for EFT or QR (a card needs nothing typed: the machine's slip is the proof).
// The last-4 box stays in the page, always hidden, so the screens that show and hide fields by method keep working.
export const proofFields = (pre, method) => row(field('Reference (as on the bank statement)', pre + '-ref', { placeholder: method === 'qr' ? 'the QR reference' : 'the EFT reference' }), `<div hidden>${field('', pre + '-last4')}</div>`);
export const proofNote = (method, cashOk) => method === 'eft' || method === 'qr' ? 'Recorded as awaiting the bank: a manager confirms it once it shows on the statement, and the order counts it paid from then.' : cashOk ? '' : 'Cash is taken at an open register.';
// a tender from the pay fields, checked the way the server checks it
export function tenderFrom(wrap, pre, method, amount, cashOk) {
  const tender = { method, amountCents: amount, ref: val(wrap, pre + '-ref') };
  if (method === 'cash') { tender.tenderedCents = centsOf(val(wrap, pre + '-given')); if (tender.tenderedCents < amount) { toast('Cash given is short.', 'warn'); return null; } }
  if (method === 'card') delete tender.ref;
  if ((method === 'eft' || method === 'qr') && !tender.ref) { toast('The reference, as it will show on the bank statement.', 'warn'); return null; }
  return tender;
}
export const PAY_STATE = { awaiting: 'awaiting the bank', void: 'not received' };
