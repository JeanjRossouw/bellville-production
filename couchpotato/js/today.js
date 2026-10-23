// Today — the whole factory on one screen, the first thing you see.
//
//   In production   pieces being built, how many are due this week, how many are late
//   Raw stock       materials that will run short once the waiting orders are built
//   To dispatch     pieces done and waiting to go out, and how many went out today
//   On shift        who has clocked in today, of the staff on the register
//   Finished        pieces finished each day this week, against last week
//   Assistant       what needs doing now, each with the button that does it:
//                   a late order (tell the client), a piece done but the client not
//                   told, a piece due soon and not started, stock running short,
//                   invoices overdue. "Later" hides one until tomorrow.
//   Due this week   the open orders due in the next seven days
//
// Each part shows only to a role that may see what it is about (Settings →
// Roles); a role that sees none of it gets a short welcome.
//
// The clock-in register (who is in today) lives in attendance/:
//   attendance/roster   the names on the register (no pay details), kept up to
//                       date from Wages by whoever may edit wages
//   attendance/<date>   in: { staffId: 'HH:MM' }, out: { staffId: 'HH:MM' }
// Factory-floor and wages roles may clock people in and out.
import * as store from './store.js';
import { allOrders } from './orders.js';
import { levels } from './stock.js';
import { finishedOn, mondayOf } from './floor.js';
import { allInvoices, isOverdue, balance } from './invoices.js';
import { allStaff } from './wages.js';
import { customerById } from './customers.js';
import { esc, money, today, addDays, niceDate, daysUntil, openModal, toast, waDigits, statusChip } from './ui.js';
import { nameOf, detail, seesClient } from './clientgroups.js';
import { stopPerson } from './jobs.js';
import { overdueOutside } from './outside.js';

let settings = {};
let att = {};               // attendance docs by id
let onChange = null;
let unwatch = null;
let attLoaded = false;
export const setTodaySettings = (cfg) => { settings = cfg || {}; };
export function startToday(cb, cfg) {
  onChange = cb; settings = cfg || {};
  if (unwatch) unwatch();
  unwatch = store.watch('attendance', rows => { att = {}; rows.forEach(r => { att[r.id] = r; }); attLoaded = true; if (onChange) onChange(); });
}

const isOpen = (o) => o.status !== 'invoiced' && o.status !== 'cancelled' && o.status !== 'dispatched';
const building = (o) => o.status === 'new' || o.status === 'in-production';
const nowHm = () => new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
const first = (s) => String(s || '').trim().split(/\s+/)[0] || 'there';
// a client this role sees by group only: no phone, so no message to send
const phoneOf = (o) => detail(o, o.deliveryPhone || (customerById(o.customerId) || {}).phone || '');
const custName = (o) => nameOf(o);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const sees = (...areas) => areas.some(a => store.can(a));
const edits = (...areas) => areas.some(a => store.can(a, 'edit'));

// ----------------------------------------------------------- "Later" -----
const LATER = 'cp-today-later';
const laterMap = () => { try { return JSON.parse(localStorage.getItem(LATER) || '{}'); } catch (e) { return {}; } };
const isLater = (key) => laterMap()[key] === today();
function later(key) {
  const m = laterMap(); Object.keys(m).forEach(k => { if (m[k] !== today()) delete m[k]; }); m[key] = today();
  try { localStorage.setItem(LATER, JSON.stringify(m)); } catch (e) {}
}

// -------------------------------------------------------------- figures --
function figures() {
  const orders = allOrders();
  const t = today(), mon = mondayOf(t), sun = addDays(mon, 6);
  const prod = orders.filter(o => o.status === 'in-production');
  const dueWeek = orders.filter(o => building(o) && o.dueDate && o.dueDate >= t && o.dueDate <= addDays(t, 6));
  const late = orders.filter(o => building(o) && o.dueDate && o.dueDate < t);
  const ready = orders.filter(o => o.status === 'ready' && !o.deliveredAt);
  const outToday = orders.filter(o => String(o.dispatchedAt || '').slice(0, 10) === t || String(o.deliveredAt || '').slice(0, 10) === t);
  const fin = orders.filter(o => o.status !== 'cancelled').map(finishedOn);
  // Monday to Saturday, and Sunday too when it is Sunday or something was finished then
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(mon, i)).filter((d, i) => i < 6 || d === t || fin.includes(d));
  const perDay = days.map(d => fin.filter(x => x === d).length);
  const lastMon = addDays(mon, -7);
  const lastWeek = fin.filter(x => x >= lastMon && x < mon).length;
  return { orders, t, mon, sun, prod, dueWeek, late, ready, outToday, days, perDay, lastWeek, thisWeek: fin.filter(x => x >= mon && x <= sun).length };
}

// ------------------------------------------------------------- register --
const roster = () => ((att.roster || {}).people || []).filter(p => p && p.id);
const dayDoc = (d) => att[d || today()] || { in: {}, out: {} };
const onShift = () => { const d = dayDoc(); return roster().filter(p => (d.in || {})[p.id] && !(d.out || {})[p.id]); };
// for the job cards: who is on the register, and a day's clock times
export const rosterPeople = () => roster();
export const attendanceOf = (d) => att[d || today()] || null;
export const isClockedIn = (staffId) => { const d = dayDoc(); return !!(d.in || {})[staffId] && !(d.out || {})[staffId]; };
// Wages keeps the real staff list; the register gets the names only.
export async function syncRoster() {
  // only once both lists are in, so a list still loading never empties the register
  if (!store.can('wages', 'edit') || !attLoaded || !allStaff().length) return;
  const want = allStaff().filter(s => s.active !== false).map(s => ({ id: s.id, name: s.name || '', job: s.job || '' })).sort((a, b) => a.name.localeCompare(b.name));
  const have = roster();
  if (JSON.stringify(want) === JSON.stringify(have)) return;
  if (!want.length && !have.length) return;
  try { await store.setWithId('attendance', 'roster', { people: want }); } catch (e) { /* role or connection: next time */ }
}
async function clock(staffId) {
  if (!edits('factory', 'wages')) { toast('Your role cannot clock people in', 'warn'); return; }
  const t = today(), d = dayDoc(t), ins = { ...(d.in || {}) }, outs = { ...(d.out || {}) };
  const p = roster().find(x => x.id === staffId); if (!p) return;
  let what;
  if (!ins[staffId]) { ins[staffId] = nowHm(); what = p.name + ' clocked in at ' + ins[staffId]; }
  else if (!outs[staffId]) { outs[staffId] = nowHm(); what = p.name + ' clocked out at ' + outs[staffId]; stopPerson(staffId, 'clocked out'); }
  else { delete outs[staffId]; what = p.name + ' back in'; }
  await store.setWithId('attendance', t, { day: t, in: ins, out: outs });
  toast(what);
}
// The station tablet: someone not clocked in starts a job, so clock them in
// first (or back in, after clocking out earlier).
export async function clockIn(staffId) {
  if (!edits('factory', 'wages')) return false;
  const t = today(), d = dayDoc(t), ins = { ...(d.in || {}) }, outs = { ...(d.out || {}) };
  if (ins[staffId] && !outs[staffId]) return true;
  if (!ins[staffId]) ins[staffId] = nowHm(); else delete outs[staffId];
  const p = store.setWithId('attendance', t, { day: t, in: ins, out: outs });
  att[t] = { ...(att[t] || {}), day: t, in: ins, out: outs };
  p.catch(e => toast('Could not clock in: ' + e.message, 'warn'));
  return true;
}
export async function clockOut(staffId) {
  if (!edits('factory', 'wages')) return;
  const t = today(), d = dayDoc(t), ins = { ...(d.in || {}) }, outs = { ...(d.out || {}) };
  if (!ins[staffId] || outs[staffId]) return;
  outs[staffId] = nowHm();
  stopPerson(staffId, 'clocked out');
  att[t] = { ...(att[t] || {}), day: t, in: ins, out: outs };
  store.setWithId('attendance', t, { day: t, in: ins, out: outs }).catch(e => toast('Could not clock out: ' + e.message, 'warn'));
}
async function clockAll() {
  if (!edits('factory', 'wages')) return;
  const t = today(), d = dayDoc(t), ins = { ...(d.in || {}) }, outs = { ...(d.out || {}) };
  const now = nowHm(); let n = 0;
  roster().forEach(p => { if (!ins[p.id]) { ins[p.id] = now; n++; } });
  if (!n) { toast('Everyone is already in'); return; }
  await store.setWithId('attendance', t, { day: t, in: ins, out: outs });
  toast(plural(n, 'person', 'people') + ' clocked in at ' + now);
}
function registerHtml() {
  const d = dayDoc(), people = roster();
  const may = edits('factory', 'wages');
  if (!people.length) return `<p class="muted">Nobody on the register yet. ${store.can('wages') ? 'Add your staff under Money → Wages; they appear here by themselves.' : 'The owner adds staff under Wages; they appear here.'}</p>`;
  const notIn = people.filter(p => !(d.in || {})[p.id]).length;
  return `<div class="reg-top"><p class="muted">${may ? 'Tap a name to clock them in; tap again to clock them out.' : 'Who is in today.'}</p>${may && notIn ? `<button type="button" class="btn ghost sm" data-reg-all="1">Clock everyone in (${notIn})</button>` : ''}</div>
    <div class="reg-list">${people.map(p => { const i = (d.in || {})[p.id], o = (d.out || {})[p.id];
      return `<button type="button" class="reg-row ${i && !o ? 'in' : o ? 'gone' : ''}" data-reg="${esc(p.id)}"${may ? '' : ' disabled'}><span><strong>${esc(p.name)}</strong>${p.job ? '<small>' + esc(p.job) + '</small>' : ''}</span><span class="reg-t">${i ? 'in ' + esc(i) : 'not in'}${o ? ' · out ' + esc(o) : ''}</span></button>`; }).join('')}</div>`;
}
function openRegister() {
  const m = openModal('Who is in today · ' + niceDate(today()), `<div id="reg-box">${registerHtml()}</div>`, { okLabel: 'Done', onOk: () => true });
  const box = m.wrap.querySelector('#reg-box');
  const redraw = () => { if (box.isConnected) box.innerHTML = registerHtml(); };
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-reg-all]')) { await clockAll(); setTimeout(redraw, 50); return; }
    const b = e.target.closest('[data-reg]'); if (!b) return; await clock(b.dataset.reg); setTimeout(redraw, 50);
  });
  const was = onChange; onChange = () => { redraw(); if (was) was(); };
  const restore = setInterval(() => { if (!box.isConnected) { onChange = was; clearInterval(restore); } }, 500);
}

// ------------------------------------------------------------ assistant --
// What needs doing, most pressing first. Each: key (for Later), tone, text,
// and the buttons.
function nudges(f) {
  const out = [];
  // work at a supplier past the day it was due back
  if (sees('factory', 'orders')) {
    const late = overdueOutside();
    if (late.length) out.push({ key: 'outside-' + late.map(c => c.id).sort().join('.'), tone: 'red', text: `${plural(late.length, 'job is', 'jobs are')} overdue back from ${late.length === 1 ? esc((late[0].outsourced || {}).supplier || 'the supplier') : 'suppliers'}: ${esc(late.slice(0, 3).map(c => c.orderNo + ' ' + c.operationName).join(', '))}${late.length > 3 ? '…' : ''}. Chase ${late.length === 1 ? 'it' : 'them'}?`,
      send: { act: 'go', to: 'factory', sub: 'outside', label: 'Outside work' } });
  }
  if (sees('orders', 'factory')) {
    f.late.filter(o => seesClient(o) && !(o.lateNoticeAt && daysUntil(String(o.lateNoticeAt).slice(0, 10)) > -7))
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .forEach(o => { const d = -daysUntil(o.dueDate);
        out.push({ key: 'late-' + o.id, tone: 'red', text: `Order ${esc(o.orderNo || '')}${custName(o) ? ' for ' + esc(custName(o)) : ''} is running ${plural(d, 'day')} behind. Let the client know?`,
          send: { act: 'late', id: o.id, label: 'Send' } }); });
  }
  if (sees('factory', 'orders', 'deliveries') && edits('factory', 'orders', 'deliveries')) {
    const loose = f.ready.filter(o => !o.deliveryDate && o.deliveryMethod !== 'collect').sort((a, b) => String(a.orderNo || '').localeCompare(String(b.orderNo || ''), undefined, { numeric: true }));
    if (loose.length) out.push({ key: 'dn-' + loose.map(o => o.id).sort().join('.'), tone: 'amber', text: `${plural(loose.length, 'piece is', 'pieces are')} done and not booked to go out${loose.length > 1 ? ' (' + esc(loose.slice(0, 3).map(o => o.orderNo).join(', ')) + (loose.length > 3 ? '…' : '') + ')' : ' (' + esc(loose[0].orderNo || '') + ')'}. Make a delivery note?`,
      send: { act: 'go', to: sees('factory') ? 'factory' : 'orders', sub: 'done', label: 'Delivery note' } });
  }
  if (sees('orders', 'deliveries', 'scan')) {
    f.ready.filter(o => !(o.clientToldAt && (!o.readyAt || o.clientToldAt >= o.readyAt)) && phoneOf(o))
      .forEach(o => out.push({ key: 'ready-' + o.id, tone: 'green', text: `Order ${esc(o.orderNo || '')}${custName(o) ? ' for ' + esc(custName(o)) : ''} is done. Tell the client it is ready?`, send: { act: 'ready', id: o.id, label: 'Send' } }));
  }
  if (sees('factory')) {
    f.orders.filter(o => o.status === 'new' && o.dueDate && daysUntil(o.dueDate) >= 0 && daysUntil(o.dueDate) <= 3)
      .forEach(o => { const d = daysUntil(o.dueDate);
        out.push({ key: 'start-' + o.id, tone: 'amber', text: `Order ${esc(o.orderNo || '')} is due ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + plural(d, 'day')} and not started yet.`, send: { act: 'go', to: 'factory', label: 'Plan it' } }); });
  }
  if (sees('stock')) {
    const short = levels(f.orders).rows.filter(r => r.short);
    if (short.length) out.push({ key: 'stock-' + short.map(r => r.m.id).join('.'), tone: 'amber', text: `${plural(short.length, 'material')} will run short: ${esc(short.slice(0, 3).map(r => r.m.name).join(', '))}${short.length > 3 ? ' and more' : ''}. Order now?`, send: { act: 'go', to: 'stock', label: 'Order stock' } });
  }
  if (sees('invoices')) {
    const od = allInvoices().filter(isOverdue);
    if (od.length) { const sum = od.reduce((t, i) => t + balance(i), 0);
      out.push({ key: 'inv-' + od.length + '-' + Math.round(sum), tone: 'red', text: `${esc(money(sum, settings.currency))} is overdue on ${plural(od.length, 'invoice')}. Send the statements?`, send: { act: 'go', to: 'invoices', sub: 'statements', label: 'Statements' } }); }
  }
  return out.filter(n => !isLater(n.key));
}
let showAll = false;
function assistantHtml(f) {
  const list = nudges(f);
  const shown = showAll ? list : list.slice(0, 3);
  return `<div class="td-card td-ai">
    <div class="td-k"><span class="td-dia">◆</span> Assistant</div>
    ${list.length ? shown.map(n => `<div class="td-nudge ${n.tone}">
      <p>${n.text}</p>
      <div class="td-btns"><button class="td-send" data-act="today-do" data-do="${esc(n.send.act)}" data-id="${esc(n.send.id || '')}" data-to="${esc(n.send.to || '')}" data-sub="${esc(n.send.sub || '')}" data-key="${esc(n.key)}">${esc(n.send.label)}</button><button class="td-later" data-act="today-later" data-key="${esc(n.key)}">Later</button></div>
    </div>`).join('') + (list.length > 3 ? `<button class="td-more" data-act="today-more">${showAll ? 'Show fewer' : '+ ' + (list.length - 3) + ' more'}</button>` : '')
      : '<p class="td-calm">All clear. Nothing needs you right now.</p>'}
  </div>`;
}

// ------------------------------------------------------------- the page --
export function renderToday(host) {
  syncRoster();
  const f = figures();
  const me = store.getUser() || {};
  const hour = new Date().getHours();
  const hello = (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') + (me.name ? ', ' + first(me.name) : '');
  const tile = (k, n, sub, to, cls) => `<button class="td-tile ${cls || ''}" data-act="today-do" data-do="${to === 'register' ? 'register' : 'go'}" data-to="${esc(to)}"><div class="td-k">${esc(k)}</div><div class="td-n">${n}</div><div class="td-sub">${sub}</div></button>`;
  const tiles = [];
  if (sees('orders', 'factory')) tiles.push(tile('In production', f.prod.length, `${f.dueWeek.length} due within a week${f.late.length ? ' · <b class="red">' + f.late.length + ' late</b>' : ''}`, sees('factory') ? 'factory' : 'orders'));
  if (sees('stock')) { const short = levels(f.orders).rows.filter(r => r.short).length; tiles.push(tile('Raw stock', short, short ? (short === 1 ? 'item low' : 'items low') : 'all in stock', 'stock', short ? 'warn' : '')); }
  if (sees('orders', 'scan', 'deliveries')) tiles.push(tile('To dispatch', f.ready.length, f.outToday.length ? f.outToday.length + ' out today' : 'none out yet today', sees('deliveries') ? 'deliveries' : sees('scan') ? 'scan' : 'orders'));
  if (sees('factory', 'wages')) { const r = roster(); tiles.push(tile('On shift', onShift().length, r.length ? 'of ' + plural(r.length, 'staff', 'staff') : 'tap to set up', 'register')); }
  const max = Math.max(1, ...f.perDay);
  const chart = sees('orders', 'factory') ? `<div class="td-card td-chart">
      <div class="td-k">Orders finished · this week <span class="td-meta">${f.thisWeek} so far · ${f.lastWeek} last week</span></div>
      <div class="td-bars" style="grid-template-columns:repeat(${f.days.length}, 1fr)">${f.days.map((d, i) => `<div class="td-bar${d === f.t ? ' now' : d > f.t ? ' later' : ''}" data-day="${d}"><span class="td-v">${d > f.t ? '' : f.perDay[i]}</span><i style="height:${Math.round(f.perDay[i] / max * 100)}%"></i><span class="td-d">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]}</span></div>`).join('')}</div>
    </div>` : '';
  const due = sees('orders', 'factory') ? f.orders.filter(o => building(o) || o.status === 'ready').filter(o => o.dueDate && o.dueDate <= addDays(f.t, 7)).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, 12) : [];
  const dueHtml = due.length ? `<div class="td-card td-due"><div class="td-k">Due in the next 7 days and overdue</div>
      ${due.map(o => { const d = daysUntil(o.dueDate); return `<button class="td-row" data-act="today-do" data-do="go" data-to="orders"><span><strong>${esc(o.orderNo || '')}</strong> ${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}<small>${esc(custName(o))}</small></span><span>${statusChip(o.status)} <em class="${d < 0 ? 'red' : d <= 1 ? 'amber' : ''}">${d < 0 ? plural(-d, 'day') + ' late' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : niceDate(o.dueDate)}</em></span></button>`; }).join('')}</div>` : '';
  const anything = tiles.length || chart;
  host.innerHTML = `<div class="today">
    <div class="td-head"><div><div class="td-k">Your factory · today</div><h1>${esc(hello)}</h1><p class="td-date">${esc(new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</p></div></div>
    ${anything ? `<div class="td-tiles">${tiles.join('')}</div>
    <div class="td-mid">${chart}${assistantHtml(f)}</div>${dueHtml}` : `<div class="td-card">${assistantHtml(f)}<p class="td-calm">Use the menu above for your screens.</p></div>`}
  </div>`;
}

// ------------------------------------------------------------- actions ---
// A late order: tell the client, with a new date, and (if allowed) move the due date.
function tellLate(id) {
  const o = allOrders().find(x => x.id === id); if (!o) return;
  const phone = phoneOf(o);
  const newDate = addDays(today(), 7);
  const mayMove = store.can('orders', 'edit') || store.can('factory', 'edit');
  const msg = (d) => `Hi ${first(o.deliveryContact || custName(o))}, ${settings.name || ''} here. A quick update on your ${o.product || 'order'} (order ${o.orderNo || ''}): it is running a little behind. We now expect it to be ready by ${niceDate(d)}. Sorry for the wait, and thank you for your patience.`;
  const m = openModal('Let the client know · ' + (o.orderNo || ''), `
    <p class="muted">${esc(o.product || '')} for ${esc(custName(o))} was due ${esc(niceDate(o.dueDate))}.</p>
    <label class="fld"><span>New expected date</span><input type="date" id="lt-date" value="${esc(newDate)}"></label>
    <textarea id="lt-msg" rows="5" style="width:100%; font:inherit; font-size:14px; padding:.6rem; border:1px solid #d6d3d1; border-radius:10px; margin-top:.5rem">${esc(msg(newDate))}</textarea>
    ${mayMove ? '<label class="check"><input type="checkbox" id="lt-move" checked> Move the order’s due date to the new date</label>' : ''}
    ${phone ? '' : '<p class="notice-inline">No phone number on this order or customer: copy the message instead.</p>'}`, {
    okLabel: phone ? 'Send on WhatsApp' : 'Copy message', onOk: async (w) => {
      const d = w.querySelector('#lt-date').value || newDate, text = w.querySelector('#lt-msg').value;
      if (phone) window.open('https://wa.me/' + waDigits(phone) + '?text=' + encodeURIComponent(text), '_blank');
      else { try { await navigator.clipboard.writeText(text); toast('Message copied'); } catch (e) { toast('Copy the message from the box', 'warn'); return false; } }
      const patch = { lateNoticeAt: store.nowIso() };
      const move = w.querySelector('#lt-move'); if (move && move.checked && d) patch.dueDate = d;
      try { await store.update('orders', o.id, patch, 'Client told it is running late' + (patch.dueDate ? '; due date moved to ' + d : '')); } catch (e) { /* the message went; recording it needs an orders role */ }
    } });
  const date = m.wrap.querySelector('#lt-date'), ta = m.wrap.querySelector('#lt-msg');
  date.addEventListener('change', () => { ta.value = msg(date.value || newDate); });
}
function tellReady(id) {
  const o = allOrders().find(x => x.id === id); if (!o) return;
  const phone = phoneOf(o);
  const where = [settings.address, settings.phone ? 'Phone ' + settings.phone : ''].filter(Boolean).join('. ');
  const msg = `Hi ${first(o.deliveryContact || custName(o))}, ${settings.name || ''} here. Good news: your ${o.product || 'order'} (order ${o.orderNo || ''}) is finished. `
    + (o.deliveryMethod === 'collect' ? 'It is ready for collection' + (where ? ' from ' + where : '') + '. Reply here to say when you are coming.' : 'Reply here and we will book a delivery day that suits you.');
  window.open('https://wa.me/' + waDigits(phone) + '?text=' + encodeURIComponent(msg), '_blank');
  store.update('orders', o.id, { clientToldAt: store.nowIso() }, 'Client told it is ready').catch(() => {});
}
export function todayAction(b, go) {
  switch (b.dataset.act) {
    case 'today-later': later(b.dataset.key); toast('Hidden until tomorrow'); return onChange && onChange();
    case 'today-more': showAll = !showAll; return onChange && onChange();
    case 'today-do': {
      const what = b.dataset.do;
      if (what === 'late') return tellLate(b.dataset.id);
      if (what === 'ready') return tellReady(b.dataset.id);
      if (what === 'register') return openRegister();
      if (what === 'go') return go(b.dataset.to, b.dataset.sub);
    }
  }
}
