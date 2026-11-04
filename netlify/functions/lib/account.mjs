// Retail POS — a customer's account: what was put on account (the 'account' tender on a sale), what was paid
// against it (accountPayments), the statement in date order with the running balance, and the ageing of what
// is still owed (payments settle the oldest invoices first, so what remains sits on the newest ones).
import { query } from './pos.mjs';

const money = (c) => 'R ' + (c / 100).toFixed(2);
const METHOD = { cash: 'cash', card: 'card', eft: 'EFT', qr: 'QR', storeCredit: 'store credit' };

// the statement lines for a customer (and the profiles merged into them), oldest first, with the running balance
export async function statementOf(entityId, c) {
  const ids = [c.id, ...(c.mergedIds || [])];
  const sales = [], aps = [];
  for (const id of ids) {
    sales.push(...await query('sales', [{ field: 'entityId', value: entityId }, { field: 'customerId', value: id }], 500));
    aps.push(...await query('accountPayments', [{ field: 'entityId', value: entityId }, { field: 'customerId', value: id }], 500));
  }
  const rows = [];
  for (const s of sales.filter(x => (x.paymentMethods || []).includes('account'))) {
    const pays = await query('payments', [{ field: 'entityId', value: entityId }, { field: 'docId', value: s.id }], 20);
    const onAccount = pays.filter(p => p.method === 'account').reduce((n, p) => n + (p.amountCents || 0), 0);
    if (onAccount > 0) rows.push({ at: s.clientCreatedAt || s.createdAt, docNo: s.docNo, kind: 'invoice', what: 'Invoice ' + s.docNo + (s.totalCents !== onAccount ? ` (${money(s.totalCents)}, ${money(onAccount)} on account)` : ''), amountCents: onAccount, docId: s.id });
  }
  for (const p of aps) {
    const how = [...new Set((p.tenders || []).map(t => METHOD[t.method] || t.method))].join(', ');
    if (p.confirmedCents > 0) rows.push({ at: p.clientCreatedAt || p.createdAt, docNo: p.docNo, kind: 'payment', what: 'Payment ' + p.docNo + (how ? ' · ' + how : ''), amountCents: -p.confirmedCents, docId: p.id });
    if (p.awaitingCents > 0) rows.push({ at: p.clientCreatedAt || p.createdAt, docNo: p.docNo, kind: 'awaiting', what: 'Payment ' + p.docNo + ' · awaiting the bank', amountCents: 0, awaitingCents: p.awaitingCents, docId: p.id });
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let bal = 0;
  for (const r of rows) { bal += r.amountCents; r.balanceCents = bal; }
  const owed = c.accountBalanceCents || 0;
  // an opening balance (taken on from the old system) is what the account owes beyond what the statement shows
  const opening = owed - bal;
  return { rows, owedCents: owed, awaitingCents: c.accountAwaitingCents || 0, limitCents: c.creditLimitCents || 0, openingCents: opening, ageing: ageingOf(rows, owed, opening), lastInvoiceAt: rows.filter(r => r.kind === 'invoice').map(r => r.at).pop() || '', lastPaymentAt: rows.filter(r => r.kind === 'payment').map(r => r.at).pop() || '' };
}

// what is owed, by how long it has been owed: the newest invoices hold what is unpaid (payments cleared the oldest)
export function ageingOf(rows, owed, opening = 0, now = Date.now()) {
  const out = { current: 0, d30: 0, d60: 0, d90: 0 };
  let left = Math.max(0, owed - Math.max(0, opening));
  for (const r of rows.filter(x => x.kind === 'invoice').reverse()) {
    if (left <= 0) break;
    const take = Math.min(left, r.amountCents); left -= take;
    const days = Math.floor((now - Date.parse(r.at)) / 86400000);
    out[days <= 30 ? 'current' : days <= 60 ? 'd30' : days <= 90 ? 'd60' : 'd90'] += take;
  }
  if (opening > 0) out.d90 += opening;   // an opening balance is older than anything here
  return out;
}
