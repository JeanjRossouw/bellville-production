// The subscription price, in one place. The browser shows what this says and
// the payment notice from PayFast is checked against it, so a changed form in
// the browser can never buy the plan for less.
//
// Env FACTORY_PRICE overrides the monthly amount (rands, e.g. 799).
export function plan() {
  const amount = Number(process.env.FACTORY_PRICE || 799);
  return {
    id: 'standard',
    name: process.env.FACTORY_PLAN_NAME || 'Standard',
    amount: Math.round(amount * 100) / 100,
    currency: 'ZAR',
    interval: 'month',
    includes: 'Every feature, unlimited users and orders'
  };
}

// Paid months run to the next billing date plus a few days' grace, so a
// payment that lands a day late never locks anyone out.
export const GRACE_DAYS = 5;
