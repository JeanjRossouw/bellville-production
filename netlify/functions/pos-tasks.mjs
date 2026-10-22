// Retail POS — the store's task list: what, by when, for whom. The assistant
// proposes tasks (pos-assist); people add, tick and reopen them here.
//
//   add    { title, note, due (YYYY-MM-DD or ''), assigneeUid, + where }   any member
//   done   { taskId }                                                      any member
//   reopen { taskId }                                                      any member
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional).
import { json, Reject, clean, randomId, nowIso, getDoc, createDoc, patchDoc, serverStamp, bodyOf, audit } from './lib/pos.mjs';
import { whoAndWhere } from './lib/sale.mjs';

async function loadTask(ctx, id) {
  id = clean(id, 60);
  const t = await getDoc('tasks', id);
  if (!t || t.entityId !== ctx.entityId || t.storeId !== ctx.storeId) throw new Reject(404, 'No such task here.');
  return { ...t, id };
}
const auditRow = (ctx, action, t, details) => audit({ action, docType: 'task', docId: t.id, docNo: '', actorUid: ctx.user.id, actorName: ctx.user.name, details, entityId: ctx.entityId, storeId: ctx.storeId, deviceId: ctx.deviceId });

const actions = {
  async add(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const title = clean(b.title, 120);
    if (!title) throw new Reject(400, 'What is the task?');
    const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : '';
    const assigneeUid = clean(b.assigneeUid, 60);
    const who = assigneeUid ? await getDoc('users', assigneeUid) : null;
    if (assigneeUid && (!who || !(who.storeIds || []).includes(ctx.storeId) && who.role !== 'owner')) throw new Reject(400, 'That person is not at this store.');
    const id = randomId('tk_'); const now = nowIso();
    const task = { title, note: clean(b.note, 300), due, assigneeUid, assigneeName: who ? who.name : '', status: 'open', source: 'person', doneAt: '', doneBy: '', ...serverStamp(ctx.entityId, ctx.storeId, ctx.user.id, ctx.deviceId), createdByName: ctx.user.name, updatedAt: now };
    await createDoc('tasks', id, task);
    await auditRow(ctx, 'task.add', { id }, { title, due, assigneeName: task.assigneeName });
    return { ok: true, task: { id, ...task } };
  },
  async done(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const t = await loadTask(ctx, b.taskId);
    if (t.status === 'done') return { ok: true, task: t, same: true };
    const now = nowIso();
    const patch = { status: 'done', doneAt: now, doneBy: ctx.user.name, updatedAt: now };
    await patchDoc('tasks', t.id, patch);
    await auditRow(ctx, 'task.done', t, { title: t.title });
    return { ok: true, task: { ...t, ...patch } };
  },
  async reopen(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    const t = await loadTask(ctx, b.taskId);
    const now = nowIso();
    const patch = { status: 'open', doneAt: '', doneBy: '', updatedAt: now };
    await patchDoc('tasks', t.id, patch);
    await auditRow(ctx, 'task.reopen', t, { title: t.title });
    return { ok: true, task: { ...t, ...patch } };
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
    console.error('pos-tasks failed:', e);
    return json(500, { error: 'Something went wrong on the server. Nothing was written; try again.' });
  }
};
