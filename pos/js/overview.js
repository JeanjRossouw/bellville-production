// All businesses: the owner's sales across every shop company and every
// Factory Manager company they belong to, on one screen, live.
//
// It only reads. The shops: pos/{group}/sales and creditNotes (the owner may
// read them all). The factories: the same login's Factory Manager companies
// (users/<uid>.companies), each one's invoices (credit notes are invoices
// with a negative total; void ones are left out) and the orders taken. A
// company whose rules do not let this person see its invoices is shown as
// such. Days are this device's own dates, so a sale at 23:30 is on that day.
//
// Each business: today against the same day last week, this week (Monday to
// today) against last week's same days, this month against last month's same
// days. Then the latest sales, invoices and orders as they come in.
import * as auth from './auth.js';
import { fb, watch } from './db.js';
import { esc, money, empty } from './ui.js';

const FEED = 30;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : ymd(d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const cents = (rands) => Math.round((Number(rands) || 0) * 100);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const nth = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

// the three periods and what each is held against
export function periods(now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mon = addDays(t, -((t.getDay() + 6) % 7));
  const m1 = new Date(t.getFullYear(), t.getMonth(), 1);
  const pm1 = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const pmLast = new Date(t.getFullYear(), t.getMonth(), 0).getDate();
  const pmTo = new Date(t.getFullYear(), t.getMonth() - 1, Math.min(t.getDate(), pmLast));
  return [
    { key: 'today', label: 'Today', from: ymd(t), to: ymd(t), was: [ymd(addDays(t, -7)), ymd(addDays(t, -7))], against: 'last ' + DAYS[t.getDay()] },
    { key: 'week', label: 'This week', from: ymd(mon), to: ymd(t), was: [ymd(addDays(mon, -7)), ymd(addDays(t, -7))], against: t.getDay() === 1 ? 'last Monday' : 'last week, Monday to ' + DAYS[t.getDay()] },
    { key: 'month', label: 'This month', from: ymd(m1), to: ymd(t), was: [ymd(pm1), ymd(pmTo)], against: t.getDate() === 1 ? 'the 1st of last month' : 'last month, 1st to ' + nth(pmTo.getDate()) }
  ];
}
// the first day any period looks at
const firstDay = (ps) => ps.reduce((a, p) => (p.was[0] < a ? p.was[0] : a), ps[0].from);

// what is on screen: events by business, kept up to date by the listeners
const ov = { key: '', start: '', unsub: [], shopSales: [], shopNotes: [], factories: [], fac: {}, at: 0, ready: { sales: false, notes: false, factories: false } };
let repaint = () => {};
let shopsOf = () => ({ entities: [], stores: [] });
export function setContext(c) { repaint = c.repaint || repaint; shopsOf = c.shops || shopsOf; }

export function stop() {
  while (ov.unsub.length) { try { ov.unsub.pop()(); } catch (e) {} }
  Object.assign(ov, { key: '', start: '', shopSales: [], shopNotes: [], factories: [], fac: {}, at: 0, ready: { sales: false, notes: false, factories: false } });
}
const changed = () => { ov.at = Date.now(); repaint(); };

// start (or restart, on a new day) the listeners; the owner only
export function ensure() {
  const u = auth.session.user;
  if (!u || u.role !== 'owner') return;
  const start = firstDay(periods());
  const key = (auth.session.uid || '') + '|' + start;
  if (ov.key === key) return;
  stop();
  ov.key = key; ov.start = start;
  const startIso = new Date(start + 'T00:00:00').toISOString();
  ov.unsub.push(watch('sales', [['clientCreatedAt', '>=', startIso]], rows => { ov.shopSales = rows; ov.ready.sales = true; changed(); }, () => { ov.ready.sales = true; changed(); }));
  ov.unsub.push(watch('creditNotes', [['clientCreatedAt', '>=', startIso]], rows => { ov.shopNotes = rows; ov.ready.notes = true; changed(); }, () => { ov.ready.notes = true; changed(); }));
  factories(key, start, startIso).catch(() => { ov.ready.factories = true; changed(); });
}

// the Factory Manager companies this login belongs to, and a listener on each
async function factories(key, start, startIso) {
  const { doc, getDoc, collection, query, where, onSnapshot } = fb.fns;
  const uid = auth.session.uid;
  let mine = {};
  try { const me = await getDoc(doc(fb.db, 'users', uid)); mine = (me.exists() && me.data().companies) || {}; } catch (e) { mine = {}; }
  const list = [];
  for (const [cid, name] of Object.entries(mine)) {
    try { const m = await getDoc(doc(fb.db, 'companies', cid, 'members', uid)); if (m.exists()) list.push({ id: cid, name: String(name || cid), role: m.data().role || '' }); } catch (e) { /* no longer a member */ }
  }
  if (ov.key !== key) return;
  ov.factories = list.sort((a, b) => a.name.localeCompare(b.name));
  for (const c of ov.factories) {
    const f = ov.fac[c.id] = { invoices: [], orders: [], denied: false, ready: false };
    const on = (coll, field, from, set) => onSnapshot(query(collection(fb.db, 'companies', c.id, coll), where(field, '>=', from)),
      snap => { set(snap.docs.map(d => ({ id: d.id, ...d.data() }))); f.ready = true; changed(); },
      () => { if (coll === 'invoices') f.denied = true; f.ready = true; changed(); });
    ov.unsub.push(on('invoices', 'date', start, r => { f.invoices = r; }));
    ov.unsub.push(on('orders', 'createdAt', startIso, r => { f.orders = r; }));
  }
  ov.ready.factories = true; changed();
}

// ---- every sale, refund, invoice and order as one shape
// { biz, where, day, at, cents, money: true (counts as sales) | false (an order), what, who, own }
function events() {
  const { entities, stores } = shopsOf();
  const storeName = (id) => (stores.find(s => s.id === id) || {}).name || id || '';
  const out = [];
  for (const s of ov.shopSales) out.push({ biz: 'pos:' + s.entityId, store: s.storeId, where: storeName(s.storeId), day: dayOf(s.clientCreatedAt), at: Date.parse(s.clientCreatedAt) || 0, cents: Number(s.totalCents) || 0, money: true, what: 'Sale ' + (s.docNo || ''), who: s.cashierName || '' });
  for (const n of ov.shopNotes) out.push({ biz: 'pos:' + n.entityId, store: n.storeId, where: storeName(n.storeId), day: dayOf(n.clientCreatedAt), at: Date.parse(n.clientCreatedAt) || 0, cents: -(Number(n.totalCents) || 0), money: true, refund: true, what: 'Refund ' + (n.docNo || ''), who: n.cashierName || '' });
  for (const c of ov.factories) {
    const f = ov.fac[c.id]; if (!f) continue;
    for (const i of f.invoices) {
      if (i.status === 'void') continue;
      const credit = i.kind === 'credit' || Number(i.total) < 0;
      out.push({ biz: 'fm:' + c.id, where: '', day: String(i.date || '').slice(0, 10), at: Date.parse(i.createdAt) || Date.parse((i.date || '') + 'T12:00:00') || 0, cents: cents(i.total), money: true, refund: credit,
        what: (credit ? 'Credit note ' : i.saleNo ? 'Till sale ' : 'Invoice ') + (i.invoiceNo || '') + (i.customerName ? ' · ' + i.customerName : ''), who: '', own: /^pos-/.test(i.customerId || '') });
    }
    for (const o of f.orders) {
      if (o.status === 'cancelled') continue;
      out.push({ biz: 'fm:' + c.id, where: '', day: dayOf(o.createdAt), at: Date.parse(o.createdAt) || 0, cents: cents((Number(o.priceEach) || 0) * (Number(o.qty) || 1)), money: false,
        what: 'Order ' + (o.orderNo || '') + (o.product ? ' · ' + o.product + (Number(o.qty) > 1 ? ' × ' + o.qty : '') : '') + (o.customerName ? ' · ' + o.customerName : ''), who: '', own: o.source === 'pos' });
    }
  }
  // the shop companies' names, for the feed
  const names = Object.fromEntries([...entities.map(e => ['pos:' + e.id, e.tradingName || e.legalName || e.id]), ...ov.factories.map(c => ['fm:' + c.id, c.name])]);
  out.forEach(e => { e.bizName = names[e.biz] || e.biz.slice(e.biz.indexOf(':') + 1); });
  return out;
}

// the figures for one set of events over one period
function figures(evs, p) {
  const sum = (a, b, list) => {
    const inside = list.filter(e => e.day >= a && e.day <= b);
    const sales = inside.filter(e => !e.refund);
    const total = inside.reduce((s, e) => s + e.cents, 0);
    return { total, count: sales.length, avg: sales.length ? Math.round(sales.reduce((s, e) => s + e.cents, 0) / sales.length) : 0 };
  };
  const m = evs.filter(e => e.money), o = evs.filter(e => !e.money);
  return { now: sum(p.from, p.to, m), was: sum(p.was[0], p.was[1], m), orders: sum(p.from, p.to, o), ordersWas: sum(p.was[0], p.was[1], o) };
}
const pct = (a, b) => b ? Math.round((a - b) / Math.abs(b) * 100) : (a ? null : 0);
function chip(a, b) {
  const p = pct(a, b);
  if (p === null) return '<span class="dash-delta up">new</span>';
  return `<span class="dash-delta ${p > 0 ? 'up' : p < 0 ? 'down' : ''}">${p > 0 ? '▲' : p < 0 ? '▼' : '•'} ${Math.abs(p)}%</span>`;
}
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// the three period boxes for a set of events
function periodBoxes(evs, ps, { noun = ['sale', 'sales'], orders = false } = {}) {
  return `<div class="ov-periods">${ps.map(p => {
    const f = figures(evs, p);
    return `<div class="ov-period" data-period="${p.key}"><div class="ov-plabel">${esc(p.label)}</div>
      <div class="ov-big">${esc(money(f.now.total))} ${chip(f.now.total, f.was.total)}</div>
      <div class="muted">${esc(plural(f.now.count, noun[0], noun[1]))}${f.now.count ? ' · average ' + esc(money(f.now.avg)) : ''}</div>
      <div class="muted ov-was">${esc(p.against)}: ${esc(money(f.was.total))}</div>
      ${orders ? `<div class="ov-orders">Orders taken: <strong>${esc(money(f.orders.total))}</strong> · ${esc(plural(f.orders.count, 'order', 'orders'))} ${chip(f.orders.total, f.ordersWas.total)}</div>` : ''}</div>`;
  }).join('')}</div>`;
}

export function overviewHtml() {
  const u = auth.session.user;
  if (!u || u.role !== 'owner') return empty('For the owner', 'All businesses shows every company’s sales together: it is for the owner.');
  ensure();
  const ps = periods();
  const loading = !ov.ready.sales || !ov.ready.notes || !ov.ready.factories;
  const evs = events();
  const { entities, stores } = shopsOf();
  const shops = entities.filter(e => e.active !== false || evs.some(x => x.biz === 'pos:' + e.id)).sort((a, b) => String(a.tradingName || a.legalName).localeCompare(String(b.tradingName || b.legalName)));
  const count = shops.length + ov.factories.length;
  // together: the shops' sales and the factories' invoices, less what a factory invoiced your own shops (the shop's sale already counts it)
  const together = evs.filter(e => !e.own);
  const ownBilled = evs.filter(e => e.own && e.money && e.day >= ps[2].from).reduce((s, e) => s + e.cents, 0);

  const shopCard = (e) => {
    const mine = evs.filter(x => x.biz === 'pos:' + e.id);
    const sts = stores.filter(s => s.entityId === e.id);
    const t = ps[0], m = ps[2];
    return `<div class="card ov-biz" data-biz="pos:${esc(e.id)}"><div class="ov-head"><h2>${esc(e.tradingName || e.legalName || e.id)}</h2><span class="chip">Shop${sts.length > 1 ? 's' : ''}</span></div>
      ${periodBoxes(mine, ps)}
      ${sts.length > 1 ? `<table class="tbl ov-stores"><thead><tr><th>Store</th><th class="r">Today</th><th class="r">${esc(t.against)}</th><th class="r">This month</th><th class="r">Last month to date</th></tr></thead><tbody>${sts.map(s => {
        const ev = mine.filter(x => x.store === s.id), ft = figures(ev, t), fm = figures(ev, m);
        return `<tr><td>${esc(s.name)}</td><td class="r">${esc(money(ft.now.total))} ${chip(ft.now.total, ft.was.total)}</td><td class="r muted">${esc(money(ft.was.total))}</td><td class="r">${esc(money(fm.now.total))} ${chip(fm.now.total, fm.was.total)}</td><td class="r muted">${esc(money(fm.was.total))}</td></tr>`;
      }).join('')}</tbody></table>` : ''}</div>`;
  };
  const factoryCard = (c) => {
    const f = ov.fac[c.id] || {};
    const mine = evs.filter(x => x.biz === 'fm:' + c.id);
    const own = mine.filter(x => x.own && x.money && x.day >= ps[2].from).reduce((s, x) => s + x.cents, 0);
    return `<div class="card ov-biz" data-biz="fm:${esc(c.id)}"><div class="ov-head"><h2>${esc(c.name)}</h2><span class="chip">Factory</span></div>
      ${f.denied ? '<p class="muted">Your role in this company does not show its invoices.</p>' : `<p class="muted ov-note">Invoiced (credit notes taken off), and the orders taken.</p>${periodBoxes(mine, ps, { noun: ['invoice', 'invoices'], orders: true })}${own ? `<p class="muted ov-note">This month includes ${esc(money(own))} invoiced to your own shops.</p>` : ''}`}</div>`;
  };

  const feed = evs.filter(e => e.at).sort((a, b) => b.at - a.at).slice(0, FEED);
  const today = ps[0].from;
  const when = (e) => { const d = new Date(e.at); const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`; return e.day === today ? hm : d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm; };

  return `<div class="page-head"><h1>All businesses</h1><p class="sub">${loading ? 'Loading…' : 'Live: it changes as sales come in.'} ${esc(plural(count, 'business', 'businesses'))}.</p></div>
    ${count > 1 ? `<div class="card ov-biz ov-all" data-biz="all"><div class="ov-head"><h2>Everything together</h2></div>${periodBoxes(together, ps)}${ownBilled ? `<p class="muted ov-note">What a factory invoiced your own shops (${esc(money(ownBilled))} this month) is left out here: the shop’s sale already counts it.</p>` : ''}</div>` : ''}
    ${count ? '' : empty('No businesses yet', 'Add a company under Admin → Companies. Factory Manager companies you belong to with this same email show here too.')}
    <div class="ov-grid">${shops.map(shopCard).join('')}${ov.factories.map(factoryCard).join('')}</div>
    <div class="card ov-feed"><h2>As it happens</h2>
      ${feed.length ? `<table class="tbl"><tbody>${feed.map(e => `<tr class="${e.refund ? 'ov-refund' : ''}${e.money ? '' : ' ov-order'}"><td class="ov-when">${esc(when(e))}</td><td><strong>${esc(e.bizName)}</strong>${e.where ? ' · ' + esc(e.where) : ''}<div class="muted">${esc(e.what)}${e.who ? ' · ' + esc(e.who) : ''}${e.own ? ' · from your shop' : ''}</div></td><td class="r">${e.money ? '' : '<span class="chip">order</span> '}${esc(money(e.cents))}</td></tr>`).join('')}</tbody></table>`
        : `<p class="muted">${loading ? 'Loading…' : 'Nothing since ' + esc(ov.start) + '.'}</p>`}
    </div>`;
}
