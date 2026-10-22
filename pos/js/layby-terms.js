// Retail POS — the lay-by rules shared by the till and the server: the
// settings with their legal limits, the instalment schedule, the agreement
// text the customer signs, and the cancellation penalty. Section 62 of the
// Consumer Protection Act 68 of 2008 and regulation 35: the penalty is at
// most 1% of the full price, must be disclosed before the agreement, and is
// not charged when the cancellation is due to the consumer's death or
// hospitalisation. If the supplier cannot deliver once the price is paid,
// the consumer may choose equivalent goods or a refund (double the amount
// paid, or the amount with interest when the cause was beyond the
// supplier's control).
import { pctOf } from './money.js';

export const PENALTY_CAP_PCT = 1;
export const FREQ = { weekly: 7, fortnightly: 14, monthly: 30 };
export const FREQ_LABEL = { weekly: 'week', fortnightly: 'two weeks', monthly: 'month' };
export const CANCEL_KINDS = [
  ['customer', 'The customer cancels'], ['lapsed', 'Not paid by the due date'],
  ['death', 'Death of the customer'], ['hospitalisation', 'Hospitalisation of the customer'], ['store', 'We cannot supply the goods']
];
// no penalty for these; 'store' because the fault is ours
export const NO_PENALTY = ['death', 'hospitalisation', 'store'];

const num = (v, dflt) => (v == null || v === '' || !Number.isFinite(Number(v))) ? dflt : Number(v);
export function laybySettings(s = {}) {
  const l = s.layby || {};
  return {
    minDepositPct: Math.min(100, Math.max(0, num(l.minDepositPct, 20))),
    termDays: Math.max(7, Math.min(3650, Math.round(num(l.termDays, 90)))),
    penaltyPct: Math.min(PENALTY_CAP_PCT, Math.max(0, num(l.penaltyPct, PENALTY_CAP_PCT))),
    frequency: FREQ[l.frequency] ? l.frequency : 'monthly',
    reminderDays: Math.max(0, Math.round(num(l.reminderDays, 3)))
  };
}
const addDays = (iso, n) => { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// the balance split into equal instalments within the term, the last taking the odd cents
export function schedule(balanceCents, openedAt, termDays, frequency) {
  if (!(balanceCents > 0)) return [];
  const step = FREQ[frequency] || 30;
  const n = Math.max(1, Math.floor(termDays / step));
  const each = Math.floor(balanceCents / n);
  let left = balanceCents;
  const out = [];
  for (let i = 1; i <= n; i++) { const amountCents = i === n ? left : each; left -= amountCents; out.push({ n: i, dueAt: addDays(openedAt, Math.min(termDays, i * step)), amountCents }); }
  return out;
}
export const dueDate = (openedAt, termDays) => addDays(openedAt, termDays);

// what should have been paid by a day: the deposit and the instalments due on or before it
export const expectedBy = (lb, day) => (lb.depositCents || 0) + (lb.schedule || []).filter(x => x.dueAt <= day).reduce((n, x) => n + x.amountCents, 0);

// the penalty the agreement disclosed, capped by the regulation and by what was paid; none for the no-penalty kinds
export function penaltyFor(lb, kind) {
  const computed = pctOf(lb.totalCents, lb.penaltyPct);
  const cap = pctOf(lb.totalCents, PENALTY_CAP_PCT);
  const waived = NO_PENALTY.includes(kind);
  const charged = waived ? 0 : Math.min(computed, cap, lb.paidCents || 0);
  const why = { death: 'no penalty on the death of the customer', hospitalisation: 'no penalty on the hospitalisation of the customer', store: 'no penalty: the store could not supply the goods' }[kind] || '';
  return { fullPriceCents: lb.totalCents, paidCents: lb.paidCents || 0, penaltyPct: lb.penaltyPct, computedCents: computed, capPct: PENALTY_CAP_PCT, capCents: cap, chargedCents: charged, waivedWhy: why, refundCents: (lb.paidCents || 0) - charged };
}

const rands = (c) => 'R ' + (Math.round(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// the agreement, written once at opening and kept on the lay-by
export function agreementText(entity, lb) {
  const co = entity.legalName + (entity.tradingName && entity.tradingName !== entity.legalName ? ' trading as ' + entity.tradingName : '');
  const n = lb.schedule.length;
  return [
    `Lay-by agreement ${lb.docNo} between ${co} and ${lb.customerSnapshot.name}, under section 62 of the Consumer Protection Act 68 of 2008.`,
    `Goods: ${lb.lines.map(l => l.qty + ' × ' + l.name).join('; ')}. Full price ${rands(lb.totalCents)}${lb.vatRegistered ? ' including VAT' : ''}.`,
    `Deposit paid today: ${rands(lb.depositCents)}. Balance ${rands(lb.balanceCents)}` + (n ? ` in ${n} instalment${n === 1 ? '' : 's'} of ${rands(lb.schedule[0].amountCents)} every ${FREQ_LABEL[lb.frequency]}, the last by ${lb.dueAt}.` : '.') + ' Instalments may be paid at any of our tills, and sooner or larger than scheduled.',
    'The goods are reserved for you and handed over when the full price is paid; until then they remain our property. Prices on this agreement are fixed.',
    `If you cancel, or the full price is not paid by ${lb.dueAt}, we may cancel and charge a cancellation penalty of ${lb.penaltyPct}% of the full price (${rands(lb.penaltyCapCents)}), and will refund the rest of what you paid with a written breakdown. No penalty is charged if the cancellation is because of your death or hospitalisation.`,
    'If we cannot supply the goods once you have paid in full, you may choose equivalent or better goods, or a refund of double the amount you paid (the amount paid plus interest at the prescribed rate if the cause was beyond our control).'
  ].join('\n');
}
// a reminder to send, by kind
export function reminderText(entity, store, lb, kind) {
  const co = entity.tradingName || entity.legalName;
  const next = (lb.schedule || []).find(x => x.dueAt >= new Date().toISOString().slice(0, 10)) || null;
  if (kind === 'ready') return `Hi ${lb.customerSnapshot.name}, ${co} here: your lay-by ${lb.docNo} is paid in full. Your goods are ready to collect at ${store.name}. Please bring your agreement or this message.`;
  if (kind === 'overdue') return `Hi ${lb.customerSnapshot.name}, ${co} here: a reminder that your lay-by ${lb.docNo} is behind. ${rands(lb.balanceCents)} is still owed; it was due by ${lb.dueAt}. Please pay at any of our tills so the lay-by stays open. Thank you.`;
  return `Hi ${lb.customerSnapshot.name}, ${co} here: a reminder that ${next ? 'an instalment of ' + rands(next.amountCents) + ' on your lay-by ' + lb.docNo + ' is due by ' + next.dueAt : rands(lb.balanceCents) + ' is still owed on your lay-by ' + lb.docNo + ', due by ' + lb.dueAt}. Balance ${rands(lb.balanceCents)}. You can pay at any of our tills. Thank you.`;
}
