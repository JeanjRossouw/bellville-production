// Retail POS — To do (Sales → To do): every open sales order and quotation that needs someone,
// in the order the work goes: a quote the client accepted online, the deposit, updates to send,
// late, ready but not paid, ready to book, booked, then what went out this week. Each row has the
// button for its next step (the Sales orders and Quotes tabs do the work).
import { esc, money, niceDate, empty } from './ui.js';
import { icon } from './icons.js';

let ctx = { data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const OPEN = ['quoted', 'depositPaid', 'inProduction', 'ready'];

const who = (c) => `${esc((c || {}).name || '—')}${c && c.phone ? `<div class="muted">${esc(c.phone)}</div>` : ''}`;
const what = (lines) => (lines || []).filter(l => !l.delivery).map(l => esc(l.qty + ' × ' + l.name)).join('<br>');
const btn = (act, id, label, primary) => `<button class="btn ${primary ? 'primary' : 'ghost'} sm" data-act="${act}" data-id="${esc(id)}">${label}</button>`;

// the work, bucket by bucket
export function buckets() {
  const dd = ctx.data(), now = today();
  const orders = (dd.specials || []).filter(o => OPEN.includes(o.status));
  const quotes = (dd.quotes || []).filter(q => q.status === 'open');
  const by = (f) => (a, b) => String(f(a) || '').localeCompare(String(f(b) || ''));
  const done = (dd.specials || []).filter(o => /^(delivered|collected)$/.test(o.status) && String(o.completedAt || '').slice(0, 10) >= addDays(now, -7));
  return [
    { key: 'accepted', title: 'Quotes accepted online', hint: 'Load it into the sale, then Sales order to take the deposit.', rows: quotes.filter(q => q.accepted).sort(by(q => q.accepted.at)).map(q => ({ kind: 'quote', x: q })) },
    { key: 'deposit', title: 'Waiting for the deposit', hint: 'Orders opened without the deposit: take it to start production.', rows: orders.filter(o => o.status === 'quoted').sort(by(o => o.openedAt)).map(o => ({ kind: 'order', x: o })) },
    { key: 'updates', title: 'Updates to send', hint: 'Something changed: one tap sends the client a WhatsApp with their order page.', rows: orders.filter(o => o.updateDue && o.status !== 'quoted').sort(by(o => o.updatedAt)).map(o => ({ kind: 'order', x: o })) },
    { key: 'late', title: 'Late', hint: 'Past the expected date and not ready yet: check with the factory and tell the client.', rows: orders.filter(o => ['depositPaid', 'inProduction'].includes(o.status) && o.expectedAt && o.expectedAt < now).sort(by(o => o.expectedAt)).map(o => ({ kind: 'order', x: o })) },
    { key: 'owed', title: 'Ready, balance owed', hint: 'Ready: the balance is paid before delivery or collection.', rows: orders.filter(o => o.status === 'ready' && o.balanceCents > 0).sort(by(o => o.updatedAt)).map(o => ({ kind: 'order', x: o })) },
    { key: 'book', title: 'Ready and paid: book it', hint: 'Book the delivery or collection.', rows: orders.filter(o => o.status === 'ready' && o.balanceCents <= 0 && !o.delivery).map(o => ({ kind: 'order', x: o })) },
    { key: 'booked', title: 'Booked', hint: 'Hand over on the day: the tax invoice and the signed delivery note.', rows: orders.filter(o => o.delivery && o.status !== 'quoted').sort(by(o => o.delivery.date)).map(o => ({ kind: 'order', x: o })) },
    { key: 'done', title: 'Delivered or collected this week', hint: '', rows: done.sort(by(o => o.completedAt)).reverse().map(o => ({ kind: 'order', x: o })) }
  ];
}

function rowHtml(b, r) {
  const o = r.x;
  if (r.kind === 'quote') return `<tr><td><strong>${esc(o.docNo)}</strong><div class="muted">accepted ${esc(niceDate(o.accepted.at))} by ${esc(o.accepted.name)}</div></td><td>${who(o.customerSnapshot)}</td><td>${what(o.lines)}</td><td class="r"><strong>${esc(money(o.totalCents))}</strong></td>
    <td class="btn-row" style="margin:0">${btn('qt-load', o.id, 'Load into the sale', true)}${btn('qt-print', o.id, 'View')}</td></tr>`;
  const dv = o.delivery, now = today();
  const when = b.key === 'booked' ? `<span class="${dv.date < now ? 'warn' : dv.date === now ? 'ok' : ''}">${dv.date === now ? 'Today' : dv.date === addDays(now, 1) ? 'Tomorrow' : esc(niceDate(dv.date))}</span>${dv.slot ? ' · ' + esc(dv.slot) : ''}<div class="muted">${dv.kind === 'collect' ? 'collect' : 'deliver'}</div>`
    : b.key === 'done' ? esc(niceDate(o.completedAt)) : o.expectedAt ? 'expected ' + esc(niceDate(o.expectedAt)) : '';
  const acts = {
    deposit: btn('so-pay', o.id, icon('cash') + ' Take the deposit', true),
    updates: btn('so-update', o.id, icon('user') + ' Send update', true),
    late: btn('so-update', o.id, icon('user') + ' Tell the client') + btn('so-factory-sync', o.id, 'Check factory'),
    owed: btn('so-pay', o.id, icon('cash') + ' Take a payment', true) + btn('so-update', o.id, 'Remind'),
    book: btn('so-book', o.id, icon('truck') + ' Book', true),
    booked: o.balanceCents > 0 ? `<span class="warn">${esc(money(o.balanceCents))} owed</span>` + btn('so-pay', o.id, icon('cash') + ' Take it', true) : o.status === 'ready' ? btn('so-deliver', o.id, icon('truck') + ' Hand over', true) : '<span class="muted">not ready yet</span>',
    done: btn('so-print-delivery', o.id, 'Delivery note')
  }[b.key] || '';
  return `<tr><td><strong>${esc(o.docNo)}</strong></td><td>${who(o.customerSnapshot)}</td><td>${what(o.lines)}</td><td class="r">${b.key === 'done' ? esc(money(o.totalCents)) : `<strong>${esc(money(o.balanceCents))}</strong><div class="muted">of ${esc(money(o.totalCents))}</div>`}</td>
    <td>${when}</td><td class="btn-row" style="margin:0">${acts}${btn('so-open', o.id, 'Open')}</td></tr>`;
}

export function todoHtml() {
  const dd = ctx.data();
  if (!dd.store) return `<div class="page-head"><h1>To do</h1></div><div class="card muted">Pick a store first.</div>`;
  const bs = buckets(), open = bs.filter(b => b.key !== 'done').reduce((n, b) => n + b.rows.length, 0);
  return `<div class="page-head"><h1>To do</h1><p class="sub">${open ? open + ' thing' + (open === 1 ? '' : 's') + ' to do for clients' : 'Nothing waiting on you'} · every update carries the client’s own order page, so they need not phone</p></div>
    ${bs.some(b => b.rows.length) ? bs.filter(b => b.rows.length).map(b => `<div class="card todo-b" data-bucket="${b.key}"><h3>${esc(b.title)} <span class="chip">${b.rows.length}</span></h3>${b.hint ? `<p class="muted">${esc(b.hint)}</p>` : ''}
      <div style="overflow:auto"><table class="tbl todo-tbl"><tbody>${b.rows.map(r => rowHtml(b, r)).join('')}</tbody></table></div></div>`).join('')
    : empty('All clear', 'Sales orders and quotes that need someone show here.')}`;
}
export const count = () => buckets().filter(b => b.key !== 'done').reduce((n, b) => n + b.rows.length, 0);
