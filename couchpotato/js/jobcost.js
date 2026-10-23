// Job costing — planned against actual, per order (phase 2 of the job cards
// & costing spec). The gap between the two is the report.
//
//   planned  frozen on the order when it is released (jobs.js plannedOf):
//            the bill × qty × prices then; each step's standard minutes ×
//            its station's rate then
//   actual   materials issued × their price when issued, plus what was
//            changed or added at Done; labour = the minutes timed on each
//            step × the rate of the day they were timed (paused time is not
//            charged); rework = the time on rework cards, all of it loss
//   margin   the price excl. VAT − the cost, in rand and as a percentage
//
// The actual is worked out from the order's own job cards, time entries and
// material issues (a handful of records), when the order is done, when a
// manager corrects a time, and whenever its cost card is opened; it is kept
// on the order (orders.actual) so the margin report reads it without going
// back to the floor's records.
//
// Variance: within 5% normal, 5–15% a warning, over 15% flagged. On paper,
// an asterisk for a warning and bold with two for flagged.
import * as store from './store.js';
import { orderById, allOrders } from './orders.js';
import { productByName, allProducts } from './costing.js';
import { plannedOf, jobSettings, minutesBetween, readsTime } from './jobs.js';
import { operationById, hm } from './routing.js';
import { finishedOn } from './floor.js';
import { rosterPeople } from './today.js';
import { nameOf } from './clientgroups.js';
import { esc, money, openModal, toast, today, addDays, niceDate, exVat, openPrint, docHeader } from './ui.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cur = () => jobSettings().currency || 'R';
const vatRate = () => jobSettings().vatRegistered ? (Number(jobSettings().vatRate) || 0) : 0;
export const priceEx = (o) => r2(exVat((Number(o.priceEach) || 0) * (Number(o.qty) || 1), vatRate()));
export const seesCost = () => (store.getUser() || {}).role === 'owner' || store.can('costing') || store.can('profit');

// within 5% '', 5–15% 'warn', over 15% 'bad'; nothing planned and something spent is 'bad'
export function varClass(planned, actual) {
  if (!planned) return actual > 0.005 ? 'bad' : '';
  const p = Math.abs(actual - planned) / planned;
  return p > 0.15 ? 'bad' : p > 0.05 ? 'warn' : '';
}
const pct = (n, of) => of ? Math.round(n / of * 100) + '%' : '';

// ------------------------------------------------------------ the actual ----

// Everything the floor recorded for one order, added up.
export async function actualFor(o) {
  const [cards, entries, issues] = await Promise.all([
    store.getWhere('jobCards', [['orderId', '==', o.id]]),
    store.getWhere('timeEntries', [['orderId', '==', o.id]]),
    store.getWhere('materialIssues', [['orderId', '==', o.id]]).catch(() => [])
  ]);
  const byCard = {}; cards.forEach(c => { byCard[c.id] = c; });
  const now = store.nowIso();
  const ops = {};            // operationId -> { name, minutes, cost }
  let labour = 0, rework = 0, reworkMin = 0;
  entries.filter(e => e.kind === 'work').forEach(e => {
    const min = e.open ? minutesBetween(e.start, now) : (Number(e.minutes) || 0), cost = min / 60 * (Number(e.rateAtTime) || 0);
    const c = byCard[e.jobCardId] || {};
    if (c.isRework) { rework += cost; reworkMin += min; return; }
    const k = c.operationId || e.workstationId || '?';
    const x = ops[k] = ops[k] || { name: c.operationName || '', minutes: 0, cost: 0 };
    x.minutes += min; x.cost += cost; labour += cost;
  });
  const lines = {};          // materialId -> { name, unit, planned, qty, cost, reasons }
  let materials = 0;
  issues.forEach(i => {
    const x = lines[i.materialId] = lines[i.materialId] || { name: i.name || '', unit: i.unit || '', planned: 0, qty: 0, cost: 0, reasons: [] };
    x.planned += Number(i.plannedQty) || 0; x.qty += Number(i.qty) || 0; x.cost += Number(i.cost) || 0;
    if (i.varianceReason && !x.reasons.includes(i.varianceReason)) x.reasons.push(i.varianceReason);
    materials += Number(i.cost) || 0;
  });
  const main = cards.filter(c => !c.isRework && !c.skipped);
  return {
    materials: r2(materials), labour: r2(labour), rework: r2(rework), reworkMinutes: Math.round(reworkMin), total: r2(materials + labour + rework),
    ops: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { name: v.name, minutes: Math.round(v.minutes), cost: r2(v.cost) }])),
    lines, reworkCards: cards.filter(c => c.isRework).length,
    done: main.filter(c => c.status === 'done').length, steps: main.length,
    complete: !cards.some(c => c.open), at: now
  };
}

// Work it out and keep it on the order (when this person may change orders).
export async function refreshActual(orderId) {
  const o = orderById(orderId);
  if (!o || !(o.releasedAt || o.jobCards) || !readsTime()) return null;
  const a = await actualFor(o);
  const keep = { materials: a.materials, labour: a.labour, rework: a.rework, total: a.total, complete: a.complete, at: a.at };
  if (['orders', 'factory', 'scan'].some(x => store.can(x, 'edit'))) {
    try { await store.update('orders', orderId, { actual: keep }); } catch (e) { /* role or connection: shown anyway */ }
  }
  return a;
}

// ------------------------------------------------------ the cost card ----

function costRows(o, plan, a, print) {
  const c = cur();
  const mark = (cls) => print ? (cls === 'bad' ? ' **' : cls === 'warn' ? ' *' : '') : '';
  // while the order is on the floor, a step not reached yet is "not yet",
  // and the totals compare what is done so far with its share of the plan
  const row = (label, p, x, opts) => {
    opts = opts || {};
    if (opts.notYet) return `<tr class="${opts.sub ? 'sub' : ''}"><td>${label}</td><td class="r">${esc(money(p, c))}</td><td class="r muted">not yet</td><td></td></tr>`;
    const cmp = opts.against != null ? opts.against : p;
    const cls = opts.noVar ? '' : varClass(cmp, x);
    const v = x - cmp;
    return `<tr class="${opts.sub ? 'sub' : ''} ${opts.strong ? 'strong' : ''} ${print && cls === 'bad' ? 'flag' : ''}"><td>${label}</td>
      <td class="r">${p == null ? '' : esc(money(p, c))}</td><td class="r">${esc(money(x, c))}</td>
      <td class="r ${print ? '' : cls}">${opts.loss ? (x ? 'all of it is loss' : '') : (p == null ? '' : (v >= 0 ? '+' : '−') + esc(money(Math.abs(v), c)) + (cmp ? ' (' + (v >= 0 ? '+' : '−') + Math.round(Math.abs(v) / cmp * 100) + '%)' : '') + (opts.against != null ? ' so far' : '')) + mark(cls)}</td></tr>`;
  };
  const going = !a.complete;
  const lineRows = (plan.lines || []).reduce((m, l) => { const k = l.materialId; (m[k] = m[k] || { name: l.name, unit: l.unit, qty: 0, cost: 0 }); m[k].qty += l.qty; m[k].cost += l.cost; return m; }, {});
  Object.keys(a.lines).forEach(k => { if (!lineRows[k]) lineRows[k] = { name: a.lines[k].name, unit: a.lines[k].unit, qty: 0, cost: 0 }; });
  let matSoFar = 0, labSoFar = 0;
  const matSub = Object.entries(lineRows).map(([k, l]) => { const x = a.lines[k] || { qty: 0, cost: 0, reasons: [] };
    if (going && !a.lines[k]) return row(`${esc(l.name)} <span class="muted">${esc(r2(l.qty))} ${esc(l.unit || '')}</span>`, r2(l.cost), 0, { sub: true, notYet: true });
    matSoFar += l.cost;
    return row(`${esc(l.name)} <span class="muted">${esc(r2(l.qty))} → ${esc(r2(x.qty))} ${esc(l.unit || '')}${x.reasons && x.reasons.length ? ' · ' + esc(x.reasons.join(', ')) : ''}</span>`, r2(l.cost), r2(x.cost), { sub: true }); }).join('');
  const opIds = [...(plan.ops || []).map(x => x.operationId), ...Object.keys(a.ops).filter(k => !(plan.ops || []).some(x => x.operationId === k))];
  const opSub = opIds.map(k => { const p = (plan.ops || []).find(x => x.operationId === k), x = a.ops[k] || { minutes: 0, cost: 0 };
    if (going && !a.ops[k]) return row(`${esc((p && p.name) || (operationById(k) || {}).name || 'Step')} <span class="muted">${esc(hm(p ? p.minutes : 0))}</span>`, p ? p.cost : 0, 0, { sub: true, notYet: true });
    labSoFar += p ? p.cost : 0;
    return row(`${esc((p && p.name) || x.name || (operationById(k) || {}).name || 'Step')} <span class="muted">${esc(hm(p ? p.minutes : 0))} → ${esc(hm(x.minutes))}</span>`, p ? p.cost : 0, x.cost, { sub: true }); }).join('');
  const price = priceEx(o);
  const mP = price - plan.total, mA = price - a.total;
  return `<table class="tbl jcost"><thead><tr><th>Line</th><th class="r">Planned</th><th class="r">Actual</th><th class="r">Variance</th></tr></thead><tbody>
    ${row('<strong>Materials</strong>', plan.materials, a.materials, { strong: true, ...(going ? { against: r2(matSoFar) } : {}) })}${matSub}
    ${row('<strong>Labour</strong>', plan.labour, a.labour, { strong: true, ...(going ? { against: r2(labSoFar) } : {}) })}${opSub}
    ${row('<strong>Rework</strong>' + (a.reworkCards ? ` <span class="muted">${a.reworkCards} card${a.reworkCards === 1 ? '' : 's'}, ${esc(hm(a.reworkMinutes))}</span>` : ''), 0, a.rework, { strong: true, loss: true, noVar: !a.rework })}
    ${row('<strong>Total cost</strong>', plan.total, a.total, { strong: true, ...(going ? { against: r2(matSoFar + labSoFar) } : {}) })}
    <tr class="strong margin"><td><strong>Margin</strong> <span class="muted">on ${esc(money(price, cur()))} excl. VAT</span></td>
      <td class="r">${esc(money(mP, cur()))}<div class="muted">${pct(mP, price)}</div></td>${going ? '<td class="r muted">when it is done</td>' : `<td class="r ${mA < 0 ? 'bad' : ''}"><strong>${esc(money(mA, cur()))}</strong><div class="muted">${pct(mA, price)}</div></td>`}<td></td></tr>
  </tbody></table>`;
}

export async function openOrderCost(orderId) {
  const o = orderById(orderId); if (!o) return;
  if (!seesCost()) { toast('Costs are for the owner and the Costing and Profit roles', 'warn'); return; }
  let a;
  try { a = await refreshActual(orderId); } catch (e) { toast('Could not read the floor\'s records: ' + e.message, 'warn'); return; }
  if (!a) { toast('This order has no job cards, so there is nothing timed to cost', 'warn'); return; }
  const frozen = !!o.planned, plan = o.planned || plannedOf(o);
  const prog = a.steps ? Math.round(a.done / a.steps * 100) : 0;
  const body = `<div class="jcost-top"><div><strong>${esc(o.product || '')}${Number(o.qty) > 1 ? ' × ' + esc(o.qty) : ''}</strong> · ${esc(nameOf(o))}</div>
      <div class="jcost-prog"><span style="width:${prog}%"></span></div><div class="muted">${a.done} of ${a.steps} steps done${a.complete ? '' : ' · still on the floor: the actual is so far'}${a.reworkCards ? ' · <span class="chip late">rework</span>' : ''}</div></div>
    ${frozen ? '' : '<p class="notice-inline">Released before costing was switched on: the planned figures are at today\'s prices and rates.</p>'}
    ${costRows(o, plan, a, false)}
    <p class="muted">Variance: within 5% normal, 5–15% <span class="warn">warning</span>, over 15% <span class="bad">flagged</span>. Paused time is not charged.</p>`;
  const m = openModal('Cost · ' + (o.orderNo || ''), body, { okLabel: 'Print', cancelLabel: 'Close', onOk: () => { printOrderCost(o, plan, a, frozen); return false; } });
  m.wrap.querySelector('.modal-card').classList.add('wide');
}

function printOrderCost(o, plan, a, frozen) {
  const s = jobSettings();
  const body = docHeader(s, 'ORDER COST — INTERNAL', o.orderNo || '', [o.product + (Number(o.qty) > 1 ? ' × ' + o.qty : ''), nameOf(o), a.done + ' of ' + a.steps + ' steps done'])
    + (frozen ? '' : '<p>Planned at today\'s prices (released before costing was switched on).</p>')
    + costRows(o, plan, a, true).replace('class="tbl jcost"', '')
    + '<p class="ft">* 5–15% over or under plan. ** more than 15%. Paused time is not charged; rework is all loss.</p>';
  openPrint('Cost ' + (o.orderNo || ''), body.replace(/<tr class="([^"]*)flag([^"]*)">/g, '<tr class="$1flag$2" style="font-weight:800">'));
}

// ------------------------------------------------------ the report -----

let period = 30;
let cache = null;            // { period, at, data }
let loading = false;
let repaint = () => {};
export const setJobCostRepaint = (fn) => { repaint = fn; };
export const setCostPeriod = (n) => { period = Number(n) || 30; cache = null; };

async function load() {
  if (loading || (cache && cache.period === period && Date.now() - cache.at < 60000)) return;
  loading = true;
  try {
    const since = addDays(today(), -period), sinceIso = new Date(since + 'T00:00:00').toISOString();
    const back180 = new Date(addDays(today(), -180) + 'T00:00:00').toISOString();
    // the orders finished in the period that went through the job cards
    const done = allOrders().filter(o => (o.releasedAt || o.jobCards) && ['ready', 'dispatched', 'invoiced'].includes(o.status) && finishedOn(o) >= since);
    for (const o of done) if (!o.actual || !o.actual.complete) { try { const a = await refreshActual(o.id); if (a) o._actual = a; } catch (e) { /* skipped */ } }
    const [cards, entries, att] = await Promise.all([
      store.getWhere('jobCards', [['doneAt', '>=', back180]]),
      store.getWhere('timeEntries', [['day', '>=', since]]),
      store.getWhere('attendance', [['day', '>=', since]])
    ]);
    cache = { period, at: Date.now(), data: { since, sinceIso, done, cards, entries, att } };
  } catch (e) { cache = { period, at: Date.now(), error: e.message }; }
  loading = false;
  repaint();
}

const actualOf = (o) => o._actual || o.actual || null;

export function renderJobCosting(host) {
  load();
  const c = cur();
  const head = `<div class="btn-row" style="margin:-.4rem 0 .9rem">${[30, 90].map(n => `<button class="btn ${period === n ? 'primary' : 'ghost'} sm" data-act="jc-period" data-to="${n}">Last ${n} days</button>`).join('')}
    <button class="btn ghost sm" data-act="jc-refresh">Refresh</button></div>`;
  if (!cache || cache.period !== period) return head + '<p class="muted">Adding up the floor\'s records…</p>';
  if (cache.error) return head + `<p class="notice-inline">Could not read the floor's records: ${esc(cache.error)}</p>`;
  const { done, cards, entries, att, sinceIso } = cache.data;
  const rows = done.map(o => { const a = actualOf(o) || { total: 0, materials: 0, labour: 0, rework: 0 }, plan = o.planned || plannedOf(o), price = priceEx(o);
    return { o, a, plan, price, margin: price - a.total, pct: price ? (price - a.total) / price : 0 }; }).sort((x, y) => x.pct - y.pct);
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const tP = sum(r => r.plan.total), tA = sum(r => r.a.total), tPrice = sum(r => r.price), tRw = sum(r => r.a.rework || 0);
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  const tiles = `<div class="tiles">${tile(rows.length, 'Orders finished with job cards')}${tile(esc(money(tA, c)), 'Actual cost · planned ' + money(tP, c), varClass(tP, tA) === 'bad' ? 'red' : varClass(tP, tA) ? 'amber' : '')}
    ${tile(tPrice ? Math.round((tPrice - tA) / tPrice * 100) + '%' : '—', 'Margin on ' + money(tPrice, c) + ' excl. VAT', tPrice - tA < 0 ? 'red' : '')}${tile(esc(money(tRw, c)), 'Rework (loss)', tRw ? 'amber' : '')}</div>`;
  const vcell = (p, a) => `<td class="r ${varClass(p, a)}">${a - p >= 0 ? '+' : '−'}${esc(money(Math.abs(a - p), c))}</td>`;
  const orderTbl = rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Order</th><th>Product</th><th class="r">Price excl. VAT</th><th class="r">Planned</th><th class="r">Actual</th><th class="r">Variance</th><th class="r">Margin</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><strong>${esc(r.o.orderNo || '')}</strong><div class="muted">${esc(nameOf(r.o))}</div></td><td>${esc(r.o.product || '')}${Number(r.o.qty) > 1 ? ' × ' + esc(r.o.qty) : ''}${r.a.rework ? ' <span class="chip late">rework</span>' : ''}</td>
      <td class="r">${esc(money(r.price, c))}</td><td class="r">${esc(money(r.plan.total, c))}</td><td class="r">${esc(money(r.a.total, c))}</td>${vcell(r.plan.total, r.a.total)}
      <td class="r ${r.margin < 0 ? 'bad' : ''}"><strong>${esc(money(r.margin, c))}</strong><div class="muted">${Math.round(r.pct * 100)}%</div></td>
      <td class="r"><button class="btn ghost sm" data-act="order-cost" data-id="${esc(r.o.id)}">Cost card</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No orders released with job cards were finished in this period yet.</p>';
  // per product
  const byP = {};
  rows.forEach(r => { const k = r.o.product || '?'; const b = byP[k] = byP[k] || { n: 0, qty: 0, plan: 0, act: 0, price: 0 }; b.n++; b.qty += Number(r.o.qty) || 1; b.plan += r.plan.total; b.act += r.a.total; b.price += r.price; });
  const prodTbl = Object.keys(byP).length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Product</th><th class="r">Orders</th><th class="r">Actual cost a piece</th><th class="r">Planned a piece</th><th class="r">Margin</th></tr></thead><tbody>
    ${Object.entries(byP).sort((a, b) => (a[1].price - a[1].act) / (a[1].price || 1) - (b[1].price - b[1].act) / (b[1].price || 1)).map(([k, b]) => `<tr><td><strong>${esc(k)}</strong></td><td class="r">${b.n}</td><td class="r ${varClass(b.plan, b.act)}">${esc(money(b.act / b.qty, c))}</td><td class="r">${esc(money(b.plan / b.qty, c))}</td><td class="r ${b.price - b.act < 0 ? 'bad' : ''}">${b.price ? Math.round((b.price - b.act) / b.price * 100) + '%' : ''}</td></tr>`).join('')}</tbody></table></div>` : '';
  // labour against standard, per step (the period's finished, non-rework cards)
  const inPeriod = cards.filter(x => String(x.doneAt) >= sinceIso && !x.skipped);
  const byOp = {};
  inPeriod.filter(x => !x.isRework && x.stdMinutes).forEach(x => { const b = byOp[x.operationName || x.operationId] = byOp[x.operationName || x.operationId] || { n: 0, std: 0, act: 0 }; b.n++; b.std += Number(x.stdMinutes) || 0; b.act += Number(x.workedMinutes) || 0; });
  const opTbl = Object.keys(byOp).length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Step</th><th class="r">Times done</th><th class="r">Standard</th><th class="r">Timed</th><th class="r">Over / under</th></tr></thead><tbody>
    ${Object.entries(byOp).sort((a, b) => (b[1].act - b[1].std) / (b[1].std || 1) - (a[1].act - a[1].std) / (a[1].std || 1)).map(([k, b]) => `<tr><td><strong>${esc(k)}</strong></td><td class="r">${b.n}</td><td class="r">${esc(hm(b.std))}</td><td class="r">${esc(hm(b.act))}</td><td class="r ${varClass(b.std, b.act)}">${b.std ? (b.act >= b.std ? '+' : '−') + Math.round(Math.abs(b.act - b.std) / b.std * 100) + '%' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No steps finished in this period yet.</p>';
  // rework: per month, and per person whose step it went back to
  const rwCards = {}; cards.filter(x => x.isRework).forEach(x => { rwCards[x.id] = x; });
  const rwEntries = entries.filter(e => e.kind === 'work' && rwCards[e.jobCardId]);
  const rwCost = (e) => (Number(e.minutes) || 0) / 60 * (Number(e.rateAtTime) || 0);
  const byMonth = {}, byWho = {};
  rwEntries.forEach(e => { const m = String(e.day).slice(0, 7), w = rwCards[e.jobCardId].causedBy || 'not known'; byMonth[m] = (byMonth[m] || 0) + rwCost(e); byWho[w] = (byWho[w] || 0) + rwCost(e); });
  const rwHtml = rwEntries.length ? `<div class="fld-row"><div class="card" style="padding:0"><table class="tbl"><thead><tr><th>Month</th><th class="r">Rework cost</th></tr></thead><tbody>${Object.entries(byMonth).sort().reverse().map(([m, v]) => `<tr><td>${esc(m)}</td><td class="r">${esc(money(v, c))}</td></tr>`).join('')}</tbody></table></div>
    <div class="card" style="padding:0"><table class="tbl"><thead><tr><th>Sent back from the step of</th><th class="r">Rework cost</th></tr></thead><tbody>${Object.entries(byWho).sort((a, b) => b[1] - a[1]).map(([w, v]) => `<tr><td>${esc(w)}</td><td class="r">${esc(money(v, c))}</td></tr>`).join('')}</tbody></table></div></div>` : '<p class="muted">No rework in this period.</p>';
  // idle time per person per day
  const days = att.filter(d => d.in);
  const people = {};
  days.forEach(d => Object.entries(d.in || {}).forEach(([sid, inAt]) => {
    const outAt = (d.out || {})[sid]; if (!outAt && d.day !== today()) return;      // a day never clocked out is left out
    const end = outAt ? Date.parse(new Date(d.day + 'T' + outAt + ':00').toISOString()) : Date.now();
    const clocked = Math.max(0, Math.round((end - Date.parse(new Date(d.day + 'T' + inAt + ':00').toISOString())) / 60000));
    const p = people[sid] = people[sid] || { name: '', days: 0, clocked: 0, onJobs: 0 }; p.days++; p.clocked += clocked;
  }));
  entries.filter(e => e.kind === 'work').forEach(e => { if (people[e.staffId]) { people[e.staffId].onJobs += e.open ? minutesBetween(e.start, store.nowIso()) : (Number(e.minutes) || 0); people[e.staffId].name = people[e.staffId].name || e.staffName; } });
  const roster = rosterPeople();
  const idleTbl = Object.keys(people).length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Person</th><th class="r">Days</th><th class="r">Clocked</th><th class="r">On jobs</th><th class="r">Idle a day</th><th class="r">On jobs %</th></tr></thead><tbody>
    ${Object.entries(people).map(([sid, p]) => ({ sid, ...p, name: p.name || (roster.find(r => r.id === sid) || {}).name || sid })).sort((a, b) => (a.onJobs / (a.clocked || 1)) - (b.onJobs / (b.clocked || 1))).map(p => { const idle = Math.max(0, p.clocked - p.onJobs);
      return `<tr><td><strong>${esc(p.name)}</strong></td><td class="r">${p.days}</td><td class="r">${esc(hm(p.clocked))}</td><td class="r">${esc(hm(p.onJobs))}</td><td class="r ${idle / (p.days || 1) > 60 ? 'bad' : ''}">${esc(hm(idle / (p.days || 1)))}</td><td class="r">${p.clocked ? Math.round(p.onJobs / p.clocked * 100) + '%' : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No clock-ins in this period.</p>';
  // suggested standard times: the average of the last 10 runs, a piece
  const runs = {};
  cards.filter(x => x.status === 'done' && !x.isRework && !x.skipped && Number(x.workedMinutes) > 0).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))
    .forEach(x => { const k = x.product + '|' + x.operationId; const r = runs[k] = runs[k] || { product: x.product, operationId: x.operationId, name: x.operationName, list: [] }; if (r.list.length < 10) r.list.push((Number(x.workedMinutes) || 0) / (Number(x.qty) || 1)); });
  const sugg = Object.values(runs).map(r => { const p = productByName(r.product), step = p && (p.routing || []).find(s => s.operationId === r.operationId); return { ...r, p, std: step ? Number(step.stdMinutes) || 0 : null, avg: Math.round(r.list.reduce((s, x) => s + x, 0) / r.list.length) }; })
    .filter(r => r.p && r.std != null && r.avg !== r.std).sort((a, b) => Math.abs(b.avg - b.std) / (b.std || 1) - Math.abs(a.avg - a.std) / (a.std || 1));
  const canSet = store.can('costing', 'edit') || store.can('pos', 'edit');
  const suggTbl = sugg.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Product</th><th>Step</th><th class="r">Standard</th><th class="r">Suggested</th><th class="r">From</th><th></th></tr></thead><tbody>
    ${sugg.map(r => `<tr><td>${esc(r.product)}</td><td>${esc(r.name)}</td><td class="r">${esc(hm(r.std))}</td><td class="r ${varClass(r.std, r.avg)}"><strong>${esc(hm(r.avg))}</strong></td><td class="r">${r.list.length} run${r.list.length === 1 ? '' : 's'}</td>
      <td class="r">${canSet ? `<button class="btn ghost sm" data-act="jc-use-std" data-product="${esc(r.p.id)}" data-op="${esc(r.operationId)}" data-min="${r.avg}">Use ${esc(hm(r.avg))}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted">The average time a piece over the last ten runs of each step (up to six months back). Using it changes the product's routing; orders already released keep the standard they were planned with.</p>` : '<p class="muted">Nothing to suggest yet: the standard times match what the floor does, or there are no runs yet.</p>';
  return head + tiles
    + '<h2 class="cat">Margin per order, worst first</h2>' + orderTbl
    + (prodTbl ? '<h2 class="cat">Margin per product</h2>' + prodTbl : '')
    + '<h2 class="cat">Labour against standard, per step</h2>' + opTbl
    + '<h2 class="cat">Rework</h2>' + rwHtml
    + '<h2 class="cat">Idle time per person</h2>' + idleTbl
    + '<h2 class="cat">Suggested standard times</h2>' + suggTbl;
}

export async function jobCostAction(act, el) {
  if (act === 'jc-period') { setCostPeriod(el.dataset.to); return repaint(); }
  if (act === 'jc-refresh') { cache = null; allOrders().forEach(o => { delete o._actual; }); return repaint(); }
  if (act === 'order-cost') return openOrderCost(el.dataset.id);
  if (act === 'jc-use-std') {
    const p = allProducts().find(x => x.id === el.dataset.product); if (!p) return;
    const min = Number(el.dataset.min) || 0;
    const routing = (p.routing || []).map(s => s.operationId === el.dataset.op ? { ...s, stdMinutes: min } : s);
    try { await store.update('products', p.id, { routing }, 'Standard time from the floor: ' + ((operationById(el.dataset.op) || {}).name || 'step') + ' ' + hm(min)); toast(p.name + ': standard set to ' + hm(min)); }
    catch (e) { toast(e.message, 'warn'); }
    cache = null; repaint();
  }
}
