// Retail POS — the daily sales journal for Xero: one balanced manual
// journal per entity per day, built from the finished documents, kept as
// xeroJournals/{entityId}_{date}, exported as Xero's manual-journal CSV,
// and pushed through the Accounting API when the entity is connected.
// Runs on a schedule in the small hours for yesterday.
//
//   build   { entityId, date }        a manager: the journal (rebuilt until it is posted)
//   push    { entityId, date }        a manager: post it to Xero (tokens under pos-<entityId>)
//   status  { entityId }              connected? which organisation? the last error
//   connectUrl { entityId }           the owner: where to send the browser to link Xero (XERO_POS_REDIRECT_URI → ?action=callback)
//   disconnect { entityId }
//
// Env: FACTORY_SERVICE_ACCOUNT, XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_POS_REDIRECT_URI, POS_OVERRIDE_SECRET (signs the state).
import { json, Reject, clean, nowIso, getDoc, query, createDoc, patchDoc, loginOf, loadUser, inEntity, rank, overrideToken, verifyOverrideToken, bodyOf, audit } from './lib/pos.mjs';
import { clientCreds, exchangeCode, getConnections, saveTokens, loadTokens, deleteTokens, xeroApi, AUTHORIZE_URL, SCOPES, connectBlobs } from './lib/xero.mjs';

// the schedule lives in pos-xero-daily.mjs: a scheduled function cannot also serve HTTP
const KEY = (entityId) => 'pos-' + entityId;
const DEFAULT_ACCOUNTS = { sales: '200', vat: '820', cash: '090', card: '091', eft: '090', qr: '091', account: '610', storeCredit: '860', voucher: '861', layby: '862', specialOrder: '863', points: '864', exchange: '865', rounding: '260', penalty: '270' };
const LABEL = { sales: 'Sales (ex VAT)', vat: 'VAT output', cash: 'Cash takings', card: 'Card takings', eft: 'EFT received', qr: 'QR payments', account: 'Customer accounts (receivable)', storeCredit: 'Store credit owed', voucher: 'Gift vouchers outstanding', layby: 'Lay-by deposits held', specialOrder: 'Custom order deposits held', points: 'Loyalty points owed', exchange: 'Exchange clearing', rounding: 'Cash rounding', penalty: 'Cancellation penalties' };
const sum = (rows, f) => rows.reduce((n, r) => n + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);
const range = (field, day) => [{ field, op: 'GREATER_THAN_OR_EQUAL', value: day + 'T00:00:00.000Z' }, { field, op: 'LESS_THAN_OR_EQUAL', value: day + 'T23:59:59.999Z' }];

async function who(event, b, minRole = 'manager') {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const user = await loadUser(login.sub);
  if (!user || rank(user.role) < rank(minRole)) throw new Reject(403, `This is for ${minRole}s and the owner.`);
  const entityId = clean(b.entityId, 40);
  if (!entityId || !inEntity(user, entityId)) throw new Reject(403, 'Not your company.');
  return { user, entityId };
}
// settings.xero is one map: read, merge, write (Firestore's REST patch takes whole fields)
async function patchXero(entityId, patch) { const s = (await getDoc('settings', entityId)) || {}; await patchDoc('settings', entityId, { xero: { ...(s.xero || {}), ...patch } }); }
const accountsOf = (settings) => ({ ...DEFAULT_ACCOUNTS, ...(((settings || {}).xero || {}).accounts || {}) });

// the day's journal lines, from every store of the entity: debits positive, credits negative, all balanced
export async function buildLines(entityId, day, settings) {
  const acc = accountsOf(settings);
  const stores = await query('stores', [{ field: 'entityId', value: entityId }], 100);
  const get = async (coll, field, max = 5000) => { const out = []; for (const s of stores) out.push(...await query(coll, [{ field: 'entityId', value: entityId }, { field: 'storeId', value: s.id }, ...range(field, day)], max)); return out; };
  const [sales, notes, pays, laybys, orders] = await Promise.all([get('sales', 'clientCreatedAt'), get('creditNotes', 'clientCreatedAt'), get('payments', 'createdAt', 20000), get('laybys', 'cancelledAt', 500), get('specialOrders', 'cancelledAt', 500)]);
  const lines = [];
  const add = (key, cents, desc) => { if (cents) lines.push({ key, account: acc[key] || DEFAULT_ACCOUNTS[key], description: desc || LABEL[key], cents }); };
  // sales: revenue and VAT credited; rounding is the gap between the invoice and the cash taken
  const salesIncl = sum(sales, 'totalCents'), salesVat = sum(sales, 'vatCents'), rounding = sum(sales, 'roundingCents');
  add('sales', -(salesIncl - salesVat), `Sales ${day}: ${sales.length} invoices`);
  add('vat', -salesVat, 'VAT on sales');
  // credit notes reverse revenue and VAT
  const cnIncl = sum(notes, 'totalCents'), cnVat = sum(notes, 'vatCents');
  add('sales', cnIncl - cnVat, `Credit notes ${day}: ${notes.length}`);
  add('vat', cnVat, 'VAT reversed on credit notes');
  add('exchange', -sum(notes, 'exchangeUsedCents'), 'Credit spent on exchanges');
  // every tender of the day by document and method: money in to the bank/clearing accounts, the rest to liabilities
  const byKey = new Map();
  for (const p of pays) { const k = p.docType + '|' + p.method; byKey.set(k, (byKey.get(k) || 0) + (p.amountCents || 0)); }
  for (const [k, cents] of byKey) {
    const [docType, method] = k.split('|');
    const money = ['cash', 'card', 'eft', 'qr'].includes(method);
    if (docType === 'sale') {
      if (money) add(method, cents, `${LABEL[method]}: sales`);
      else if (method === 'creditNote') add('exchange', cents, 'Credit notes used on exchanges');
      else add(method, cents, `${LABEL[method] || method}: used on sales`);   // store credit, vouchers, points, lay-by and custom-order deposits released, accounts
    } else if (docType === 'layby' || docType === 'specialOrder') {
      if (money) { add(method, cents, `${LABEL[method]}: ${docType === 'layby' ? 'lay-by' : 'custom order'} payments`); add(docType, -cents, `${LABEL[docType]}: received`); }
      else if (method === 'storeCredit' || method === 'points') { add(method, cents, `${LABEL[method]}: used on ${docType === 'layby' ? 'lay-bys' : 'custom orders'}`); add(docType, -cents, `${LABEL[docType]}: received`); }
    } else if (docType === 'refund') {
      // negative rows: money out of the bank (or store credit issued); the other side is the credit note's reversal above,
      // or, for a cancelled lay-by / custom order, the deposit given back
      if (money || method === 'storeCredit' || method === 'card') add(method, cents, `${LABEL[method] || method}: refunds`);
    }
  }
  // cancelled lay-bys and custom orders today: the deposit comes out of the liability; the penalty or fee kept is income
  for (const l of laybys.filter(x => x.status === 'cancelled')) { add('layby', (l.refundedCents || 0) + (l.penaltyCents || 0), `Lay-by ${l.docNo} cancelled`); add('penalty', -(l.penaltyCents || 0), `Lay-by ${l.docNo} penalty`); }
  for (const o of orders.filter(x => x.status === 'cancelled')) { add('specialOrder', (o.refundedCents || 0) + (o.feeCents || 0), `Custom order ${o.docNo} cancelled`); add('penalty', -(o.feeCents || 0), `Custom order ${o.docNo} fee`); }
  // vouchers sold today sit in the sales figure: they are a liability until used, not revenue
  const vouchers = await query('vouchers', [{ field: 'entityId', value: entityId }, ...range('soldAt', day)], 2000);
  if (vouchers.length) { const v = sum(vouchers, 'amountCents'); add('sales', v, 'Gift vouchers sold (not yet revenue)'); add('voucher', -v, 'Gift vouchers sold'); }
  // the gap: cash rounding, and anything the data leaves unbalanced is shown rather than hidden
  const diff = sum(lines, 'cents');
  if (diff) add('rounding', -diff, Math.abs(diff - rounding) <= Math.max(5, sales.length) ? 'Cash rounding' : 'Unbalanced: look at the day');
  const unbalanced = Math.abs(diff - rounding) > Math.max(5, sales.length);
  // merge lines with the same account and description
  const merged = [];
  for (const l of lines) { const m = merged.find(x => x.account === l.account && x.description === l.description); if (m) m.cents += l.cents; else merged.push({ ...l }); }
  return { lines: merged.filter(l => l.cents), debits: sum(merged.filter(l => l.cents > 0), 'cents'), credits: -sum(merged.filter(l => l.cents < 0), 'cents'), counts: { sales: sales.length, creditNotes: notes.length, payments: pays.length }, unbalanced, accounts: acc };
}
// Xero's manual journal CSV: positive amounts debit, negative credit
export function journalCsv(j, entity) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['*Narration', '*Date', '*Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2']];
  for (const l of j.lines) rows.push([`POS sales ${j.date} ${entity.tradingName || entity.legalName}`, j.date.split('-').reverse().join('/'), l.description, l.account, 'Tax Exempt', (l.cents / 100).toFixed(2), '', '', '', '']);
  return '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');
}
export async function buildDoc(entityId, day) {
  const [entity, settings] = await Promise.all([getDoc('entities', entityId), getDoc('settings', entityId)]);
  if (!entity) throw new Reject(404, 'No such company.');
  const id = entityId + '_' + day;
  const had = await getDoc('xeroJournals', id);
  if (had && had.status === 'posted') return { ...had, id, entity };
  const built = await buildLines(entityId, day, settings);
  const now = nowIso();
  const doc = { entityId, storeId: '', date: day, narration: `POS sales ${day} ${entity.tradingName || entity.legalName}`, lines: built.lines, debitsCents: built.debits, creditsCents: built.credits, counts: built.counts, unbalanced: built.unbalanced, accounts: built.accounts, status: had && had.status === 'failed' ? 'failed' : 'built', xeroId: had ? had.xeroId || '' : '', error: had ? had.error || '' : '', postedAt: had ? had.postedAt || '' : '', builtAt: now, createdBy: 'server', createdAt: had ? had.createdAt : now, deviceId: 'server', updatedAt: now };
  if (had) await patchDoc('xeroJournals', id, doc); else await createDoc('xeroJournals', id, doc);
  return { ...doc, id, entity };
}
export async function pushDoc(entityId, day, byName) {
  const j = await buildDoc(entityId, day);
  if (j.status === 'posted') return { ...j, again: true };
  if (!j.lines.length) throw new Reject(400, 'Nothing to post: no sales that day.');
  if (j.unbalanced) throw new Reject(409, 'The journal does not balance: look at the day before posting.');
  const t = await loadTokens(KEY(entityId)).catch(() => null);   // no token store locally: not connected
  if (!t || !t.tenant_id) throw new Reject(409, 'Xero is not connected for this company: connect it under Reports → Xero, or import the CSV.');
  try {
    const found = await xeroApi(KEY(entityId), `/ManualJournals?where=${encodeURIComponent(`Narration=="${j.narration}"`)}`).catch(() => null);
    let mj = found && found.ManualJournals && found.ManualJournals[0];
    if (!mj) {
      const made = await xeroApi(KEY(entityId), '/ManualJournals', { method: 'POST', body: { ManualJournals: [{ Narration: j.narration, Date: day, Status: 'POSTED', LineAmountTypes: 'NoTax', JournalLines: j.lines.map(l => ({ LineAmount: l.cents / 100, AccountCode: l.account, Description: l.description, TaxType: 'NONE' })) }] } });
      mj = made.ManualJournals[0];
    }
    const now = nowIso();
    await patchDoc('xeroJournals', j.id, { status: 'posted', xeroId: mj.ManualJournalID, postedAt: now, postedBy: byName, error: '', updatedAt: now });
    await patchXero(entityId, { lastPushAt: now, lastError: '' }).catch(() => {});
    return { ...j, status: 'posted', xeroId: mj.ManualJournalID, postedAt: now };
  } catch (e) {
    const now = nowIso();
    await patchDoc('xeroJournals', j.id, { status: 'failed', error: String(e.message).slice(0, 500), updatedAt: now });
    await patchXero(entityId, { lastError: String(e.message).slice(0, 300), lastErrorAt: now }).catch(() => {});
    throw new Reject(502, 'Xero did not take the journal: ' + e.message + ' (the CSV import still works)');
  }
}
const html = (status, title, body) => ({ statusCode: status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;padding:2rem;max-width:40rem"><h2>${title}</h2>${body}</body></html>` });

const actions = {
  async build(event, b) {
    const w = await who(event, b);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : new Date().toISOString().slice(0, 10);
    const j = await buildDoc(w.entityId, day);
    const { entity, ...rest } = j;
    return { ok: true, journal: rest, csv: journalCsv(j, entity), labels: LABEL };
  },
  async push(event, b) {
    const w = await who(event, b);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : '';
    if (!day) throw new Reject(400, 'Which day?');
    const j = await pushDoc(w.entityId, day, w.user.name);
    await audit({ action: 'xero.push', docType: 'xeroJournal', docId: j.id, docNo: day, actorUid: w.user.id, actorName: w.user.name, details: { xeroId: j.xeroId, debits: j.debitsCents }, entityId: w.entityId, storeId: '', deviceId: 'office' });
    const { entity, ...rest } = j;
    return { ok: true, journal: rest };
  },
  async status(event, b) {
    const w = await who(event, b);
    const t = await loadTokens(KEY(w.entityId)).catch(() => null);
    const s = (await getDoc('settings', w.entityId)) || {};
    let configured = true; try { clientCreds(); } catch { configured = false; }
    return { ok: true, connected: !!(t && t.tenant_id), tenantName: t ? t.tenant_name || '' : '', configured: configured && !!process.env.XERO_POS_REDIRECT_URI, accounts: accountsOf(s), labels: LABEL, defaults: DEFAULT_ACCOUNTS, lastPushAt: (s.xero || {}).lastPushAt || '', lastError: (s.xero || {}).lastError || '' };
  },
  async connectUrl(event, b) {
    const w = await who(event, b, 'owner');
    clientCreds();
    if (!process.env.XERO_POS_REDIRECT_URI) throw new Reject(503, 'XERO_POS_REDIRECT_URI is not set on Netlify (this function with ?action=callback, registered on the Xero app).');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', process.env.XERO_CLIENT_ID);
    url.searchParams.set('redirect_uri', process.env.XERO_POS_REDIRECT_URI); url.searchParams.set('scope', SCOPES + ' accounting.transactions');
    url.searchParams.set('state', overrideToken({ xero: w.entityId, by: w.user.id, byName: w.user.name }, 20));
    return { ok: true, url: url.toString() };
  },
  async disconnect(event, b) {
    const w = await who(event, b, 'owner');
    await deleteTokens(KEY(w.entityId));
    await patchXero(w.entityId, { connectedTenant: '', connectedAt: '' }).catch(() => {});
    await audit({ action: 'xero.disconnect', docType: 'settings', docId: w.entityId, docNo: '', actorUid: w.user.id, actorName: w.user.name, details: {}, entityId: w.entityId, storeId: '', deviceId: 'office' });
    return { ok: true };
  }
};

export const handler = async (event) => {
  connectBlobs(event);
  const q = event.queryStringParameters || {};
  // ---- Xero sending the owner back
  if (event.httpMethod === 'GET' && q.action === 'callback') {
    try {
      if (q.error) return html(400, 'Xero said no', `<p>${String(q.error_description || q.error).replace(/</g, '&lt;')}</p>`);
      const claim = verifyOverrideToken(q.state || '');
      if (!q.code || !claim || !claim.xero) return html(400, 'This link has expired', '<p>Go back to the POS → Reports → Xero and tap Connect again.</p>');
      const redirect = process.env.XERO_POS_REDIRECT_URI;
      const saved = process.env.XERO_REDIRECT_URI; process.env.XERO_REDIRECT_URI = redirect;   // exchangeCode reads the redirect from the environment
      let tokens; try { tokens = await exchangeCode(q.code); } finally { process.env.XERO_REDIRECT_URI = saved; }
      const conns = await getConnections(tokens.access_token);
      const conn = conns && conns[0];
      if (!conn) return html(400, 'No organisation', '<p>No Xero organisation was chosen. Try again and pick one.</p>');
      await saveTokens(KEY(claim.xero), { ...((await loadTokens(KEY(claim.xero))) || {}), ...tokens, tenant_id: conn.tenantId, tenant_name: conn.tenantName, obtained_at: Date.now() });
      await patchXero(claim.xero, { connectedTenant: conn.tenantName || '', connectedAt: nowIso() }).catch(() => {});
      await audit({ action: 'xero.connect', docType: 'settings', docId: claim.xero, docNo: '', actorUid: claim.by || '', actorName: claim.byName || 'owner', details: { tenant: conn.tenantName || '' }, entityId: claim.xero, storeId: '', deviceId: 'office' }).catch(() => {});
      return html(200, 'Xero connected', `<p>The POS is now linked to <strong>${String(conn.tenantName || '').replace(/</g, '&lt;')}</strong> for company ${claim.xero}.</p><p>Close this tab. Check the account codes under Admin → Settings → Xero.</p>`);
    } catch (e) {
      console.error('pos-xero callback:', e);
      return html(500, 'Xero could not be connected', `<pre style="white-space:pre-wrap;color:#b91c1c">${String(e.message).replace(/</g, '&lt;')}</pre>`);
    }
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-xero failed:', e);
    return json(500, { error: 'Something went wrong on the server.' });
  }
};
