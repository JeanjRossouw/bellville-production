// Retail POS — a register's shift: open with a float, cash in and out,
// the X-report while it runs, and the close with a blind count, the
// variance per method and the Z-report. Only this function writes shifts
// and cash movements; the register's open shift is set here.
//
//   open      { registerId, float: { denoms: { '20000': 2, ... }, totalCents }, deviceId?, secret? | entityId, storeId }  (login)
//   status    { registerId, ... }                          → the open shift and its figures so far (an X-report)
//   cashMove  { shiftId, kind: 'in'|'out', amountCents, reason, approvalToken? }   a supervisor or higher approves
//   close     { shiftId, counted: { cash: { denoms, totalCents }, card, eft, qr, voucher, storeCredit, account }, note, approvalToken? }
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import {
  json, Reject, clean, randomId, nowIso, rank,
  getDoc, query, commit, beginTransaction, rollback, serverStamp,
  loginOf, loadUser, inEntity, inStore, verifyOverrideToken, loadDevice, bodyOf
} from './lib/pos.mjs';
import { approved, consumeToken } from './lib/sale.mjs';

export const DENOMS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];
const METHODS = ['cash', 'card', 'eft', 'qr', 'voucher', 'storeCredit', 'account', 'points'];
const int = (v) => Number.isInteger(v) ? v : (Number.isInteger(Number(v)) ? Number(v) : NaN);

async function whoAndWhere(event, b) {
  const login = await loginOf(event);
  if (!login) throw new Reject(401, 'Sign in first.');
  const user = await loadUser(login.sub);
  if (!user) throw new Reject(403, 'This login is not on the staff list.');
  const device = b.deviceId ? await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120)) : null;
  if (b.deviceId && !device) throw new Reject(403, 'This till is not enrolled.');
  const storeId = device ? device.storeId : clean(b.storeId, 40);
  const entityId = device ? device.entityId : clean(b.entityId, 40);
  if (!inEntity(user, entityId) || !inStore(user, storeId)) throw new Reject(403, 'Not your store.');
  const settings = (await getDoc('settings', entityId)) || {};
  const ctx = { user, device, deviceId: device ? device.id : 'web:' + login.sub, entityId, storeId, settings };
  if (b.approvalToken) { ctx.approvalToken = String(b.approvalToken); ctx.approval = await consumeToken(ctx, ctx.approvalToken); }   // an approval is good once
  return ctx;
}
// a count by denomination: whole notes and coins, and its total
function readCount(c) {
  const denoms = {}; let total = 0;
  for (const d of DENOMS) { const n = int((c && c.denoms && c.denoms[String(d)]) || 0); if (!(n >= 0) || n > 100000) throw new Reject(400, 'The count has a bad number.'); if (n) { denoms[String(d)] = n; total += n * d; } }
  if (c && c.totalCents != null && int(c.totalCents) !== total) throw new Reject(400, `The count's total (${c.totalCents}) does not match its notes and coins (${total}).`);
  return { denoms, totalCents: total };
}
// the shift's figures so far: sales and payments by method, cash in and out, expected cash
async function figures(shift) {
  const [pays, moves, sales] = await Promise.all([
    query('payments', [{ field: 'shiftId', value: shift.id }], 2000),
    query('cashMovements', [{ field: 'shiftId', value: shift.id }], 500),
    query('sales', [{ field: 'shiftId', value: shift.id }], 2000)
  ]);
  const byMethod = Object.fromEntries(METHODS.map(m => [m, 0]));
  for (const p of pays) byMethod[p.method] = (byMethod[p.method] || 0) + p.amountCents;
  const cashIn = moves.filter(m => m.kind === 'in').reduce((n, m) => n + m.amountCents, 0);
  const cashOut = moves.filter(m => m.kind === 'out').reduce((n, m) => n + m.amountCents, 0);
  const expectedCash = shift.openingFloat.totalCents + byMethod.cash + cashIn - cashOut;
  const awaiting = pays.filter(p => p.status === 'awaiting').reduce((n, p) => n + p.amountCents, 0);
  return {
    salesCount: sales.length, salesTotalCents: sales.reduce((n, s) => n + s.totalCents, 0), vatCents: sales.reduce((n, s) => n + (s.vatCents || 0), 0),
    discountCents: sales.reduce((n, s) => n + (s.lineDiscountCents || 0) + (s.saleDiscountCents || 0), 0), roundingCents: sales.reduce((n, s) => n + (s.roundingCents || 0), 0),
    byMethod, cashIn, cashOut, cashMoves: moves.map(m => ({ kind: m.kind, amountCents: m.amountCents, reason: m.reason, by: m.actorName, at: m.createdAt })),
    expectedCash, awaitingCents: awaiting, firstSaleAt: sales.map(s => s.clientCreatedAt).sort()[0] || '', lastSaleAt: sales.map(s => s.clientCreatedAt).sort().pop() || ''
  };
}
async function openShiftOf(registerId) {
  const reg = await getDoc('registers', registerId);
  if (!reg) throw new Reject(404, 'No such register.');
  const shift = reg.currentShiftId ? await getDoc('shifts', reg.currentShiftId) : null;
  return { reg, shift: shift && shift.status === 'open' ? shift : null };
}

const actions = {
  async open(event, b) {
    const ctx = await whoAndWhere(event, b);
    const registerId = clean(b.registerId, 40) || (ctx.device && ctx.device.registerId);
    if (!registerId) throw new Reject(400, 'This till has no register: Admin → Devices.');
    const { reg, shift } = await openShiftOf(registerId);
    if (reg.storeId !== ctx.storeId) throw new Reject(400, 'That register is in another store.');
    if (shift) throw new Reject(409, `This register is already open (since ${shift.openedAt.slice(11, 16)}, by ${shift.openedByName}).`);
    const float_ = readCount(b.float);
    const id = randomId('sh_');
    const now = nowIso();
    const data = { registerId, status: 'open', openedBy: ctx.user.id, openedByName: ctx.user.name, openedAt: now, openingFloat: float_, closedBy: '', closedByName: '', closedAt: '', ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId), updatedAt: now };
    await commit([
      { create: true, coll: 'shifts', id, data },
      { update: true, coll: 'registers', id: registerId, data: { currentShiftId: id, updatedAt: now, updatedBy: 'server' } },
      { create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'shift.open', docType: 'shift', docId: id, docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: '', overrideName: '', details: { registerId, floatCents: float_.totalCents }, ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) } }
    ]);
    return { ok: true, shift: { id, ...data } };
  },

  async status(event, b) {
    const ctx = await whoAndWhere(event, b);
    const registerId = clean(b.registerId, 40) || (ctx.device && ctx.device.registerId);
    if (!registerId) return { ok: true, register: null, shift: null };
    const { reg, shift } = await openShiftOf(registerId);
    if (!shift) return { ok: true, register: { id: reg.id, name: reg.name }, shift: null };
    return { ok: true, register: { id: reg.id, name: reg.name }, shift, figures: await figures(shift), varianceLimitCents: (ctx.settings.cash || {}).varianceLimitCents ?? 5000 };
  },

  async cashMove(event, b) {
    const ctx = await whoAndWhere(event, b);
    const shift = await getDoc('shifts', clean(b.shiftId, 60));
    if (!shift || shift.status !== 'open' || shift.storeId !== ctx.storeId) throw new Reject(400, 'That shift is not open here.');
    const kind = b.kind === 'in' ? 'in' : b.kind === 'out' ? 'out' : '';
    const amount = int(b.amountCents); const reason = clean(b.reason, 160);
    if (!kind || !(amount > 0) || !reason) throw new Reject(400, 'Cash in or out needs an amount and a reason.');
    const by = approved(ctx, b.approvalToken, 'cash', 'supervisor', 'Cash ' + kind);
    const id = clean(b.moveId, 80) || randomId('cm_');
    if (!/^[\w:.-]{8,80}$/.test(id)) throw new Reject(400, 'The movement has no id.');
    const had = await getDoc('cashMovements', id);
    if (had) { if (had.entityId !== ctx.entityId) throw new Reject(403, 'Not your register.'); return { ok: true, again: true, movement: { id, ...had }, figures: await figures(shift) }; }
    const now = nowIso();
    const data = { shiftId: shift.id, registerId: shift.registerId, kind, amountCents: amount, reason, actorUid: ctx.user.id, actorName: ctx.user.name, approvedBy: by.self ? null : { uid: by.uid, name: by.name }, ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId), serverReceivedAt: now };
    await commit([
      { create: true, coll: 'cashMovements', id, data },
      { create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'cash.' + kind, docType: 'shift', docId: shift.id, docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: by.self ? '' : by.uid, overrideName: by.self ? '' : by.name, details: { amountCents: amount, reason }, ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) } }
    ]);
    return { ok: true, movement: { id, ...data }, figures: await figures(shift) };
  },

  async close(event, b) {
    const ctx = await whoAndWhere(event, b);
    const shift = await getDoc('shifts', clean(b.shiftId, 60));
    if (!shift || shift.status !== 'open' || shift.storeId !== ctx.storeId) throw new Reject(400, 'That shift is not open here.');
    const counted = b.counted || {};
    const cash = readCount(counted.cash);
    const countedByMethod = { cash: cash.totalCents };
    for (const m of METHODS.slice(1)) { const v = counted[m] == null || counted[m] === '' ? null : int(counted[m]); if (v != null && !(v >= 0)) throw new Reject(400, 'A counted amount is wrong.'); countedByMethod[m] = v; }
    const f = await figures(shift);
    const expectedByMethod = { cash: f.expectedCash, ...Object.fromEntries(METHODS.slice(1).map(m => [m, f.byMethod[m] || 0])) };
    const varianceByMethod = Object.fromEntries(METHODS.map(m => [m, countedByMethod[m] == null ? null : countedByMethod[m] - expectedByMethod[m]]));
    const limit = (ctx.settings.cash || {}).varianceLimitCents ?? 5000;
    const note = clean(b.note, 300);
    let approver = null;
    if (Math.abs(varianceByMethod.cash) > limit) {
      if (!note) throw new Reject(400, `The cash is out by ${varianceByMethod.cash} cents, more than the limit of ${limit}: a manager's note is needed.`);
      const by = approved(ctx, b.approvalToken, 'variance', 'manager', 'A variance over the limit');
      approver = by.self ? null : { uid: by.uid, name: by.name };
    }
    const now = nowIso();
    const z = { ...f, countedByMethod, expectedByMethod, varianceByMethod, openingFloatCents: shift.openingFloat.totalCents, openedAt: shift.openedAt, closedAt: now, openedByName: shift.openedByName, closedByName: ctx.user.name, registerId: shift.registerId, note, varianceLimitCents: limit };
    const patch = { status: 'closed', closedBy: ctx.user.id, closedByName: ctx.user.name, closedAt: now, countedCash: cash, countedByMethod, expectedByMethod, varianceByMethod, varianceCents: varianceByMethod.cash, varianceApprovedBy: approver, closingNote: note, salesCount: f.salesCount, salesTotalCents: f.salesTotalCents, zReport: z, updatedAt: now };
    await commit([
      { update: true, coll: 'shifts', id: shift.id, data: patch },
      { update: true, coll: 'registers', id: shift.registerId, data: { currentShiftId: '', updatedAt: now, updatedBy: 'server' } },
      { create: true, coll: 'auditLog', id: randomId('au_'), data: { action: 'shift.close', docType: 'shift', docId: shift.id, docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, overrideUid: approver ? approver.uid : '', overrideName: approver ? approver.name : '', details: { varianceCents: varianceByMethod.cash, salesCount: f.salesCount, salesTotalCents: f.salesTotalCents, note }, ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId) } }
    ]);
    return { ok: true, shift: { ...shift, ...patch }, reports: ctx.settings.reports || {} };
  }
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-shift failed:', e);
    return json(500, { error: 'Something went wrong on the server. Try again.' });
  }
};
