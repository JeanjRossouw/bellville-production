// Profit — what the factory actually made, month by month and order by order.
//
// A piece counts in the month it left the factory (dispatched), or the day it
// was sold from showroom stock. For each:
//   sales      its price excl. VAT (after any quote or till discount)
//   materials  its bill of materials at today's material prices
//   labour     its labour hours × the labour rate
// A month's net profit is sales − materials − labour − that month's
// overheads (Costing → Overheads). Labour and materials are the costing's
// estimates, not timesheets or invoices; the report says so.
import { productByName, costOf, overheadPerUnit } from './costing.js';
import { esc, money, today } from './ui.js';

let settings = {};
let month = '';         // 'YYYY-MM' being looked at
export const setProfitSettings = (cfg) => { settings = cfg || {}; };
export const setProfitMonth = (m) => { month = m; };

const cur = () => settings.currency || 'R';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthlyOverheads = () => (settings.overheads || []).reduce((s, o) => s + (Number(o.monthly) || 0), 0);
const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });

// Every piece that has left the factory or the showroom, with its numbers.
export function pieces(orders, sales) {
  const out = [];
  (orders || []).filter(o => (o.status === 'dispatched' || o.status === 'invoiced') && o.dispatchedAt).forEach(o => {
    const qty = Number(o.qty) || 1;
    const p = productByName(o.product);
    const c = p ? costOf(p) : null;
    out.push({
      month: String(o.dispatchedAt).slice(0, 7), ref: o.orderNo, who: o.customerName || '', product: o.product || '', qty,
      sales: r2((Number(o.priceEach) || 0) * qty),
      materials: c ? r2(c.material * qty) : 0, labour: c ? r2(c.labour * qty) : 0,
      overheadShare: c ? r2(c.overhead * qty) : 0, costed: !!c, kind: 'order'
    });
  });
  (sales || []).forEach(s => {
    const raw = (s.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const factor = raw > 0 ? (Number(s.subtotal) || raw) / raw : 1;     // the till discount, spread over the lines
    (s.lines || []).filter(l => l.kind === 'stock').forEach(l => {
      const qty = Number(l.qty) || 0;
      const p = productByName(l.name);
      const c = p ? costOf(p) : null;
      out.push({
        month: String(s.date || s.createdAt || '').slice(0, 7), ref: s.saleNo, who: s.customerName || 'Walk-in', product: l.name || '', qty,
        sales: r2((Number(l.unitPrice) || 0) * qty * factor),
        materials: c ? r2(c.material * qty) : 0, labour: c ? r2(c.labour * qty) : 0,
        overheadShare: c ? r2(c.overhead * qty) : 0, costed: !!c, kind: 'stock'
      });
    });
  });
  return out;
}

export function monthTotals(list, m) {
  const rows = list.filter(x => x.month === m);
  const sum = (k) => r2(rows.reduce((s, x) => s + x[k], 0));
  const sales = sum('sales'), materials = sum('materials'), labour = sum('labour');
  const gross = r2(sales - materials - labour);
  const overheads = monthlyOverheads();
  return {
    month: m, pieces: rows.reduce((s, x) => s + x.qty, 0), uncosted: rows.filter(x => !x.costed).length,
    sales, materials, labour, gross, grossPct: sales ? gross / sales : null, overheads, net: r2(gross - overheads)
  };
}

function lastMonths(n) {
  const out = []; const d = new Date(today() + 'T00:00:00'); d.setDate(1);
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 7)); d.setMonth(d.getMonth() - 1); }
  return out;
}

const pct = (x) => x == null ? '—' : Math.round(x * 100) + '%';
const signed = (n) => `<span style="color:${n < 0 ? '#b91c1c' : 'inherit'}">${esc(money(n, cur()))}</span>`;

export function renderProfit(host, orders, sales) {
  const list = pieces(orders, sales);
  // from the first month anything went out (no losses for months before the app was used)
  const first = list.reduce((m, x) => (x.month && x.month < m ? x.month : m), today().slice(0, 7));
  const months = lastMonths(6).filter(m => m >= first);
  if (!month || !months.includes(month)) month = months[0];
  const sel = monthTotals(list, month);
  const rows = list.filter(x => x.month === month);
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;

  // by product, for the month
  const byProd = {};
  rows.forEach(x => {
    const k = x.product || '(no description)';
    const b = byProd[k] = byProd[k] || { product: k, qty: 0, sales: 0, cost: 0, costed: true };
    b.qty += x.qty; b.sales += x.sales; b.cost += x.materials + x.labour + x.overheadShare; if (!x.costed) b.costed = false;
  });
  const prods = Object.values(byProd).sort((a, b) => (b.sales - b.cost) - (a.sales - a.cost));
  const ordersSorted = rows.slice().sort((a, b) => ((a.sales - a.materials - a.labour - a.overheadShare) / (a.sales || 1)) - ((b.sales - b.materials - b.labour - b.overheadShare) / (b.sales || 1)));

  host.innerHTML = `
    <div class="page-head"><div><h1>Profit</h1><p class="sub">What the factory made, month by month and piece by piece.</p></div>
      <div class="btn-row"><select id="pf-month">${months.map(m => `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(monthName(m))}</option>`).join('')}</select></div></div>
    <div class="tiles">
      ${tile(esc(money(sel.sales, cur())), 'Sales, ' + monthName(month))}
      ${tile(signed(sel.gross), 'Gross profit · ' + pct(sel.grossPct), sel.gross < 0 ? 'red' : '')}
      ${tile(signed(sel.net), 'After overheads', sel.net < 0 ? 'red' : '')}
      ${tile(esc(String(sel.pieces)), 'Pieces out', '')}
    </div>
    ${sel.uncosted ? `<p class="notice-inline">${sel.uncosted} piece${sel.uncosted === 1 ? ' is' : 's are'} for products not in the catalogue, so ${sel.uncosted === 1 ? 'its' : 'their'} cost is counted as nothing and the profit shows too high. Add ${sel.uncosted === 1 ? 'it' : 'them'} under Costing with a bill of materials.</p>` : ''}

    <div class="card" style="padding:0; overflow:auto"><table class="tbl">
      <thead><tr><th>Month</th><th class="r">Pieces</th><th class="r">Sales</th><th class="r">Materials</th><th class="r">Labour</th><th class="r">Gross profit</th><th class="r">Gross %</th><th class="r">Overheads</th><th class="r">Net profit</th></tr></thead>
      <tbody>${months.map(m => { const t = monthTotals(list, m); return `<tr class="${m === month ? 'sel' : ''}" data-act="profit-month" data-to="${m}" style="cursor:pointer">
        <td><strong>${esc(monthName(m))}</strong></td><td class="r">${t.pieces}</td><td class="r">${esc(money(t.sales, cur()))}</td>
        <td class="r">${esc(money(t.materials, cur()))}</td><td class="r">${esc(money(t.labour, cur()))}</td>
        <td class="r">${signed(t.gross)}</td><td class="r">${pct(t.grossPct)}</td><td class="r">${esc(money(t.overheads, cur()))}</td><td class="r"><strong>${signed(t.net)}</strong></td></tr>`; }).join('')}</tbody>
    </table></div>

    <div class="profit-two">
      <div class="card" style="padding:0; overflow:auto">
        <h2 style="padding:1rem 1rem 0">By product, ${esc(monthName(month))}</h2>
        ${prods.length ? `<table class="tbl"><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Sales</th><th class="r">After full cost</th><th class="r">Margin</th></tr></thead>
          <tbody>${prods.map(b => `<tr><td>${esc(b.product)}${b.costed ? '' : ' <span class="muted">(not costed)</span>'}</td><td class="r">${b.qty}</td><td class="r">${esc(money(b.sales, cur()))}</td><td class="r">${signed(b.sales - b.cost)}</td><td class="r">${b.costed ? pct(b.sales ? (b.sales - b.cost) / b.sales : null) : '—'}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted" style="padding:0 1rem 1rem">Nothing left the factory this month.</p>'}
      </div>
      <div class="card" style="padding:0; overflow:auto">
        <h2 style="padding:1rem 1rem 0">Every piece, weakest margin first</h2>
        ${ordersSorted.length ? `<table class="tbl"><thead><tr><th>Ref</th><th>Product</th><th class="r">Sale</th><th class="r">Full cost</th><th class="r">Margin</th></tr></thead>
          <tbody>${ordersSorted.map(x => { const full = x.materials + x.labour + x.overheadShare; const m = x.sales - full; return `<tr>
            <td><strong>${esc(x.ref || '')}</strong><div class="muted">${esc(x.who)}</div></td><td>${esc(x.product)}${x.qty > 1 ? ' × ' + x.qty : ''}${x.kind === 'stock' ? ' <span class="muted">(from stock)</span>' : ''}</td>
            <td class="r">${esc(money(x.sales, cur()))}</td><td class="r">${x.costed ? esc(money(full, cur())) : '<span class="muted">not costed</span>'}</td>
            <td class="r">${x.costed ? signed(m) + '<div class="muted">' + pct(x.sales ? m / x.sales : null) + '</div>' : '—'}</td></tr>`; }).join('')}</tbody></table>`
          : '<p class="muted" style="padding:0 1rem 1rem">Nothing left the factory this month.</p>'}
      </div>
    </div>
    <p class="muted">How this is worked out: a piece counts in the month it was dispatched, or sold from showroom stock. Sales are excl. VAT, after discounts.
      Materials and labour are estimates from each product's costing at today's prices (labour ${esc(money(Number(settings.labourRate) || 0, cur()))}/hour).
      Overheads are your monthly overheads from Costing (${esc(money(monthlyOverheads(), cur()))}). The per-piece full cost also carries an overhead share of ${esc(money(overheadPerUnit(), cur()))}.</p>`;
}
