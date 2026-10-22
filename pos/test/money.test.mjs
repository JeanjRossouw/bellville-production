// The money maths, which the till and the server share. node pos/test/money.test.mjs
import assert from 'node:assert/strict';
import { loyaltySettings, earnPoints } from '../js/loyalty-terms.js';
import { vatIn, exVat, addVat, rateOn, rateFor, lineTotals, pctOf, marginPct, priceForMargin, roundTo10c, centsOf, randsOf, roundHalfUp } from '../js/money.js';

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('✗ ' + name + ': ' + e.message); process.exitCode = 1; } };

t('VAT inside R 115.00 at 15% is R 15.00', () => assert.equal(vatIn(11500, 1500), 1500));
t('VAT inside R 100.00 at 15% is R 13.04 (round half up)', () => assert.equal(vatIn(10000, 1500), 1304));
t('VAT inside R 0.01 is 0', () => assert.equal(vatIn(1, 1500), 0));
t('VAT inside R 6 400.00 at 15% is R 834.78', () => assert.equal(vatIn(640000, 1500), 83478));
t('ex VAT + VAT = incl', () => { for (const c of [1, 99, 10000, 123456, 99999999]) assert.equal(exVat(c, 1500) + vatIn(c, 1500), c); });
t('no rate: no VAT', () => assert.equal(vatIn(10000, 0), 0));
t('addVat puts 15% on an exclusive amount', () => assert.equal(addVat(10000, 1500), 11500));
t('a negative amount (a refund) carries negative VAT', () => assert.equal(vatIn(-11500, 1500), -1500));
t('roundHalfUp: 0.5 up, -0.5 away from zero', () => { assert.equal(roundHalfUp(2.5), 3); assert.equal(roundHalfUp(-2.5), -3); assert.equal(roundHalfUp(2.4), 2); });

const rates = [{ rateBp: 1400, effectiveFrom: '2000-01-01' }, { rateBp: 1500, effectiveFrom: '2018-04-01' }, { rateBp: 1600, effectiveFrom: '2027-04-01' }];
t('rate on a day: the latest effective on or before it', () => {
  assert.equal(rateOn(rates, '2018-03-31'), 1400);
  assert.equal(rateOn(rates, '2018-04-01'), 1500);
  assert.equal(rateOn(rates, '2026-10-21T10:00:00.000Z'), 1500);
  assert.equal(rateOn(rates, '2027-04-01'), 1600);
  assert.equal(rateOn(rates, '1999-01-01'), 0);
  assert.equal(rateOn([], '2026-01-01'), 0);
});
t('rateFor: standard gets the rate, zero and exempt get none, an unregistered entity gets none', () => {
  assert.equal(rateFor('standard', 1500, true), 1500);
  assert.equal(rateFor('zero', 1500, true), 0);
  assert.equal(rateFor('exempt', 1500, true), 0);
  assert.equal(rateFor('standard', 1500, false), 0);
});
t('a line: 2 × R 6 400 less R 100 off', () => {
  const l = lineTotals({ qty: 2, unitPriceCents: 640000, discountCents: 10000, rateBp: 1500 });
  assert.deepEqual(l, { grossCents: 1280000, discountCents: 10000, lineTotalCents: 1270000, vatCents: 165652 });
});
t('a discount cannot exceed the line', () => assert.equal(lineTotals({ qty: 1, unitPriceCents: 1000, discountCents: 5000 }).lineTotalCents, 0));
t('12.5% of R 100.00 is R 12.50', () => assert.equal(pctOf(10000, 12.5), 1250));
t('margin: R 115 incl at 15% on a cost of R 60 is 40%', () => assert.equal(marginPct(11500, 6000, 1500), 40));
t('margin without VAT', () => assert.equal(marginPct(10000, 6000, 0), 40));
t('margin on a zero price is null', () => assert.equal(marginPct(0, 6000, 1500), null));
t('price for a 40% margin on a cost of R 60 at 15% is R 115', () => assert.equal(priceForMargin(6000, 40, 1500), 11500));
t('rounding to 10c: R 12.34 → R 12.30, R 12.35 → R 12.40', () => {
  assert.deepEqual(roundTo10c(1234), { roundedCents: 1230, roundingCents: -4 });
  assert.deepEqual(roundTo10c(1235), { roundedCents: 1240, roundingCents: 5 });
  assert.deepEqual(roundTo10c(1200), { roundedCents: 1200, roundingCents: 0 });
});
t('centsOf reads what people type', () => {
  assert.equal(centsOf('1234.56'), 123456); assert.equal(centsOf('1 234,50'), 123450); assert.equal(centsOf('R 99'), 9900);
  assert.equal(centsOf('1,234.5'), 123450); assert.equal(centsOf(''), 0); assert.equal(centsOf('abc'), 0); assert.equal(centsOf('0.1'), 10);
});
t('randsOf prints cents', () => { assert.equal(randsOf(123456), '1234.56'); assert.equal(randsOf(5), '0.05'); assert.equal(randsOf(0), '0.00'); });
t('points: R 100 at 0.29 a rand is 29, not 28 (no binary drift)', () => { const ls = loyaltySettings({ loyalty: { enabled: true, pointsPerRand: 0.29 } }); assert.equal(earnPoints(ls, 10000, null), 29); assert.equal(earnPoints(ls, 10000, { multiplier: 1.5 }), 43); assert.equal(earnPoints(ls, 0, null), 0); });
console.log(process.exitCode ? 'money: FAILED' : 'money: all ' + n + ' passed');
