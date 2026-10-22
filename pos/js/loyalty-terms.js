// Retail POS — customers and loyalty: the rules the till and the server
// share. The cell number is the customer's key (normalised to 27…),
// marketing consent is per channel with a date (POPIA), and points are
// earned per rand at the customer's tier, redeemed oldest first, and
// expire so many months after they were earned.
export const CHANNELS = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];
export const DEFAULT_TIERS = [{ name: 'Bronze', fromCents: 0, multiplier: 1 }, { name: 'Silver', fromCents: 1000000, multiplier: 1.25 }, { name: 'Gold', fromCents: 5000000, multiplier: 1.5 }];

const num = (v, dflt) => (v == null || v === '' || !Number.isFinite(Number(v))) ? dflt : Number(v);
export function loyaltySettings(s = {}) {
  const l = s.loyalty || {};
  const tiers = (Array.isArray(l.tiers) && l.tiers.length ? l.tiers : DEFAULT_TIERS).map(t => ({ name: String(t.name || '').slice(0, 30) || 'Tier', fromCents: Math.max(0, Math.round(num(t.fromCents, 0))), multiplier: Math.max(0, num(t.multiplier, 1)) })).sort((a, b) => a.fromCents - b.fromCents);
  return { enabled: !!l.enabled, pointsPerRand: Math.max(0, num(l.pointsPerRand, 1)), pointValueCents: Math.max(1, Math.round(num(l.pointValueCents, 5))), minRedeemPoints: Math.max(0, Math.round(num(l.minRedeemPoints, 100))), expiryMonths: Math.max(0, Math.round(num(l.expiryMonths, 12))), tiers };
}
// the customer's cell number as the key: digits only, a South African 0… becomes 27…
export function phoneKey(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = '27' + d.slice(1);
  if (d.length === 9 && !d.startsWith('0')) d = '27' + d;
  return d;
}
export const phoneOk = (phone) => /^27[1-9]\d{8}$|^[1-9]\d{9,13}$/.test(phoneKey(phone));
export const emailKey = (e) => String(e || '').trim().toLowerCase();

export const tierFor = (ls, lifetimeCents) => { let t = ls.tiers[0]; for (const x of ls.tiers) if ((lifetimeCents || 0) >= x.fromCents) t = x; return t; };
// points for money spent (not for points redeemed), at the tier's multiplier
// points for money spent (not for points redeemed), at the tier's multiplier; rounded to a fixed scale first so binary drift cannot lose a point
export const earnPoints = (ls, amountCents, tier) => ls.enabled && amountCents > 0 ? Math.floor(Math.round(amountCents * ls.pointsPerRand * (tier ? tier.multiplier : 1) * 1000) / 100000) : 0;
export const pointsValueCents = (ls, points) => Math.max(0, Math.floor(points)) * ls.pointValueCents;
export const pointsFor = (ls, cents) => Math.ceil(cents / ls.pointValueCents);
const addMonths = (iso, n) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };

// the lots as they stand today: expired ones dropped and counted
export function sweep(loyalty, nowIso) {
  const lots = (loyalty && loyalty.lots) || [];
  const live = [], expired = [];
  for (const l of lots) { if (l.left > 0 && l.expiresAt && l.expiresAt <= nowIso) expired.push(l); else if (l.left > 0) live.push(l); }
  return { lots: live, expiredPoints: expired.reduce((n, l) => n + l.left, 0), points: live.reduce((n, l) => n + l.left, 0) };
}
export function earnLot(ls, points, nowIso, saleId) { return { points, left: points, earnedAt: nowIso, expiresAt: ls.expiryMonths ? addMonths(nowIso, ls.expiryMonths) : '', saleId: saleId || '' }; }
// redeem oldest first; returns the lots after
export function redeem(lots, points) {
  let need = points;
  const out = [];
  for (const l of [...lots].sort((a, b) => String(a.earnedAt).localeCompare(String(b.earnedAt)))) { if (need > 0 && l.left > 0) { const take = Math.min(l.left, need); need -= take; const left = l.left - take; if (left > 0) out.push({ ...l, left }); } else out.push(l); }
  if (need > 0) throw new Error('Not enough points.');
  return out;
}
export const MERGE_LOT_CAP = 150;
// too many lots: the oldest few fold into one that expires with the earliest of them
export function compactLots(lots) {
  if (lots.length <= MERGE_LOT_CAP) return lots;
  const s = [...lots].sort((a, b) => String(a.earnedAt).localeCompare(String(b.earnedAt)));
  const head = s.slice(0, lots.length - MERGE_LOT_CAP + 1), rest = s.slice(lots.length - MERGE_LOT_CAP + 1);
  return [{ points: head.reduce((n, l) => n + l.points, 0), left: head.reduce((n, l) => n + l.left, 0), earnedAt: head[0].earnedAt, expiresAt: head[0].expiresAt, saleId: '' }, ...rest];
}
export const blankConsent = () => Object.fromEntries(CHANNELS.map(c => [c[0], { granted: false, at: '', byName: '', source: '' }]));
export const blankLoyalty = () => ({ points: 0, lifetimeCents: 0, tier: '', lots: [], lastEarnedAt: '' });
export const blankStats = () => ({ salesCount: 0, spentCents: 0, firstSaleAt: '', lastSaleAt: '' });
