// Retail POS — money and VAT, as whole cents. Pure: no DOM, no database, so
// the till and the server functions share this one file and get the same
// answer (netlify/functions import it too).
//
// Rules: money is an integer number of cents; prices include VAT; the VAT in
// an inclusive amount is round(amount × rateBp ÷ (10000 + rateBp)), which at
// 15% is round(amount × 15 ÷ 115). Rates are basis points (1500 = 15%).

export const isCents = (v) => Number.isInteger(v);
// round half away from zero, the way a till does
export const roundHalfUp = (x) => Math.sign(x) * Math.round(Math.abs(x));

// the VAT inside an inclusive amount
export function vatIn(inclCents, rateBp) {
  if (!rateBp) return 0;
  return roundHalfUp(inclCents * rateBp / (10000 + rateBp));
}
export const exVat = (inclCents, rateBp) => inclCents - vatIn(inclCents, rateBp);
// an exclusive amount with VAT put on
export const addVat = (exCents, rateBp) => exCents + roundHalfUp(exCents * rateBp / 10000);

// the rate in force on a day: the latest effectiveFrom on or before it
export function rateOn(rates, date) {
  const day = String(date || '').slice(0, 10);
  let best = null;
  for (const r of rates || []) {
    if (!r || !Number.isInteger(r.rateBp) || !r.effectiveFrom) continue;
    if (r.effectiveFrom <= day && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best ? best.rateBp : 0;
}
// the rate a line carries: the entity's rate for 'standard', nothing for zero-rated or exempt
export const rateFor = (vatClass, entityRateBp, vatRegistered) => (vatRegistered && vatClass !== 'zero' && vatClass !== 'exempt') ? entityRateBp : 0;

// a sale line: qty × unit price, less a discount, with its VAT
export function lineTotals({ qty, unitPriceCents, discountCents = 0, rateBp = 0 }) {
  const gross = qty * unitPriceCents;
  const lineTotalCents = Math.max(0, gross - (discountCents || 0));
  return { grossCents: gross, discountCents: Math.min(gross, discountCents || 0), lineTotalCents, vatCents: vatIn(lineTotalCents, rateBp) };
}
// a percentage discount on an amount, in cents, rounded like the till
export const pctOf = (cents, pct) => roundHalfUp(cents * (Number(pct) || 0) / 100);

// margin on a VAT-inclusive selling price and a VAT-exclusive cost: both in cents, answer in percent (one decimal)
export function marginPct(priceInclCents, costCents, rateBp) {
  const ex = exVat(priceInclCents, rateBp);
  if (ex <= 0) return null;
  return Math.round(((ex - (costCents || 0)) / ex) * 1000) / 10;
}
// the selling price (incl.) that gives a margin on a cost
export function priceForMargin(costCents, marginPercent, rateBp) {
  const m = Number(marginPercent) || 0;
  if (m >= 100) return null;
  return addVat(roundHalfUp(costCents / (1 - m / 100)), rateBp);
}

// cash rounding to 10c (South African tills; the difference is recorded, never hidden)
export function roundTo10c(cents) {
  const rounded = roundHalfUp(cents / 10) * 10;
  return { roundedCents: rounded, roundingCents: rounded - cents };
}

// rands typed by a person → cents; "1 234,50" and "1234.5" both work
export function centsOf(text) {
  const t = String(text == null ? '' : text).trim().replace(/\s/g, '').replace(/^R/i, '');
  if (!t) return 0;
  const n = Number(t.includes(',') && !t.includes('.') ? t.replace(',', '.') : t.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
export const randsOf = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);
