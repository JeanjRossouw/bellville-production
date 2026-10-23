// Factory Manager POS: the price, in one place. The app shows what this says
// and PayFast's payment notice is checked against it, so a changed form in
// the browser can never buy it for less.
//
// Env POS_PRICE overrides the monthly amount (rands, VAT included, e.g. 999).
export const TRIAL_DAYS = 14;
export function posPlan() {
  const amount = Number(process.env.POS_PRICE || 999);
  return {
    id: 'pos',
    name: 'Factory Manager POS',
    amount: Math.round(amount * 100) / 100,
    currency: 'ZAR',
    interval: 'month',
    includes: 'One business: every company, store, till and person',
    trialDays: TRIAL_DAYS
  };
}
// A business's standing from its posGroups record: may it work, and why.
// No record (the first shops) or 'free' is always fine.
export function accessOfGroup(g, now = new Date()) {
  const at = (x) => (x ? Date.parse(x) : 0) || 0;
  if (!g || g.status === 'free') return { state: 'ok', why: 'free' };
  if (g.status === 'trial') return at(g.trialEndsAt) > now ? { state: 'ok', why: 'trial', until: g.trialEndsAt } : { state: 'locked', why: 'trialOver', until: g.trialEndsAt };
  if (g.status === 'active' || g.status === 'cancelled') return at(g.paidUntil) > now ? { state: 'ok', why: g.status, until: g.paidUntil } : { state: 'locked', why: 'unpaid', until: g.paidUntil };
  return { state: 'locked', why: g.status || 'unknown' };
}
export const LOCKED_TEXT = 'This business\'s Factory Manager POS trial or subscription has ended, so it is read only. The owner presses Subscribe in the bar at the top of the screen.';
