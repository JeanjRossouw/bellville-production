// Retail POS — the store's task list on Home: what, by when, for whom. The
// assistant proposes tasks; people add, tick and reopen them here. Written
// by the pos-tasks function; read from the `tasks` collection.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, niceDate, empty } from './ui.js';

let ctx = { repaint() {}, data: () => ({}) };
export function setContext(c) { ctx = { ...ctx, ...c }; }
const d = () => ctx.data();
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);

export function tasksHtml() {
  const dd = d();
  if (!dd.store) return '';
  const all = dd.tasks || [];
  const open = all.filter(t => t.status === 'open').sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const done = all.filter(t => t.status === 'done').sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 5);
  const t0 = today();
  return `<div class="card tk-card"><div class="tk-head"><h2>Tasks · ${esc(dd.store.name)}</h2><button class="btn ghost sm" data-act="tk-add">Add a task</button></div>
    ${open.length ? `<ul class="tk-list">${open.map(t => `<li class="tk-row${t.due && t.due < t0 ? ' late' : ''}"><button class="tk-tick" data-act="tk-done" data-id="${esc(t.id)}" title="Done">✓</button><div class="tk-body"><strong>${esc(t.title)}</strong>${t.note ? `<div class="muted">${esc(t.note)}</div>` : ''}<div class="muted tk-meta">${t.due ? (t.due < t0 ? '<span class="warn">was due ' + esc(niceDate(t.due)) + '</span>' : 'by ' + esc(niceDate(t.due))) : 'no date'}${t.assigneeName ? ' · ' + esc(t.assigneeName) : ''}${t.source === 'assistant' ? ' · <span class="chip">assistant</span>' : ''}</div></div></li>`).join('')}</ul>` : empty('No open tasks', 'Add one, or ask the assistant to plan the day.')}
    ${done.length ? `<details class="tk-done"><summary class="muted">${done.length} done lately</summary><ul class="tk-list">${done.map(t => `<li class="tk-row off"><span class="tk-tick on">✓</span><div class="tk-body"><strong>${esc(t.title)}</strong><div class="muted tk-meta">done ${esc(niceDate(t.doneAt))} by ${esc(t.doneBy || '')} · <button class="link" data-act="tk-reopen" data-id="${esc(t.id)}">reopen</button></div></div></li>`).join('')}</ul></details>` : ''}
  </div>`;
}

export async function action(act, b) {
  const id = b.dataset.id;
  if (act === 'tk-add') return addTask();
  if (act === 'tk-done' || act === 'tk-reopen') {
    try { const r = await auth.api(act === 'tk-done' ? 'done' : 'reopen', { taskId: id, ...where() }, API.tasks); fresh(r.task); toast(act === 'tk-done' ? 'Done: ' + r.task.title : 'Reopened: ' + r.task.title); ctx.repaint(); }
    catch (e) { toast(e.message, 'warn'); }
  }
}
function fresh(task) { const list = d().tasks || []; const i = list.findIndex(x => x.id === task.id); if (i >= 0) list[i] = { ...list[i], ...task }; else list.push(task); }
function addTask() {
  const dd = d();
  const staff = (dd.staff || []).filter(u => u.active !== false && ((u.storeIds || []).includes(dd.store.id) || u.role === 'owner'));
  openModal('Add a task', `${field('What', 'tk-title', { placeholder: 'e.g. Call the three customers whose orders are ready' })}${row(field('By when', 'tk-due', { type: 'date' }), field('For', 'tk-who', { type: 'select', value: '', options: [{ value: '', label: 'Anyone' }, ...staff.map(u => ({ value: u.id, label: u.name }))] }))}${field('Note', 'tk-note', { type: 'textarea', rows: 2 })}`, { okLabel: 'Add', onOk: async (w) => {
    const title = val(w, 'tk-title'); if (!title) { toast('What is the task?', 'warn'); return false; }
    try { const r = await auth.api('add', { title, due: val(w, 'tk-due'), assigneeUid: val(w, 'tk-who'), note: val(w, 'tk-note'), ...where() }, API.tasks); fresh(r.task); toast('Task added'); ctx.repaint(); return true; }
    catch (e) { toast(e.message, 'warn'); return false; }
  } });
}
