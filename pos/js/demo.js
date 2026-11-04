// Retail POS — the demo business (Admin → Companies, in an empty space of its own): the server builds
// Demo Furniture Co and replays six months of trading a day at a time (netlify/functions/pos-demo.mjs).
// This runs the steps in order with a progress window, and shows the staff PINs at the end.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, openModal } from './ui.js';

let running = false;
export async function build() {
  if (running) return;
  if (!confirm('Build Demo Furniture Co here, with six months of trading? Only in an empty space; it takes a few minutes and cannot be undone.')) return;
  running = true;
  const { wrap, close } = openModal('Building the demo business', `<p id="dm-line">Planning…</p><div class="dm-bar"><div id="dm-fill" style="width:0%"></div></div><p class="muted" id="dm-note">Keep this page open. Every day is written through the real system, so it takes a moment each.</p>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  const line = (t) => { const el = wrap.querySelector('#dm-line'); if (el) el.textContent = t; };
  const fill = (p) => { const el = wrap.querySelector('#dm-fill'); if (el) el.style.width = Math.round(p * 100) + '%'; };
  try {
    const plan = await auth.api('plan', {}, API.demo);
    line('Making the company, stores, staff, products, customers and opening stock…');
    const seed = await auth.api('seed', {}, API.demo);
    const todo = plan.days.filter(d => !plan.done.includes(d));
    const totals = { sales: 0, orders: 0, quotes: 0, laybys: 0, returns: 0, accountPayments: 0 };
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      const d = todo[i];
      line(`Trading day ${i + 1} of ${todo.length}: ${d} · ${totals.sales} sales, ${totals.orders} orders, ${totals.quotes} quotes so far`);
      fill((i + 1) / (todo.length + 1));
      try { const r = await auth.api('day', { date: d }, API.demo); for (const k of Object.keys(totals)) totals[k] += r[k] || 0; }
      catch (e) { failed++; if (failed > 5) throw new Error('Too many days failed: ' + e.message); }
    }
    line('Finishing…');
    const fin = await auth.api('finish', {}, API.demo);
    fill(1);
    wrap.querySelector('.modal-body').innerHTML = `<p><strong>Demo Furniture Co is ready</strong>: ${fin.days} trading days, ${fin.counts.sales} sales, ${fin.counts.specialOrders} sales orders, ${fin.counts.quotes} quotes, ${fin.counts.laybys} lay-bys, ${fin.counts.creditNotes} credit notes, ${fin.counts.accountPayments} account payments, ${fin.counts.shifts} cash-ups.</p>
      <h3>Staff PINs (for a till: enrol a device under Admin → Devices)</h3><table class="tbl"><tbody>${(fin.staff || seed.staff || []).map(s => `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.role)}</td><td>${esc(s.stores.join(', '))}</td><td><code>${esc(s.pin)}</code></td></tr>`).join('')}</tbody></table>
      <p class="muted">Start at Home for today's figures, To do for what needs someone, Sales orders for the couches in production, Customers for the accounts and statements, Reports for the six months.</p>`;
    toast('The demo business is built');
    wrap.querySelector('#modal-ok').addEventListener('click', () => location.reload(), { once: true });
  } catch (e) { line('Stopped: ' + e.message); toast(e.message, 'warn'); running = false; }
}
