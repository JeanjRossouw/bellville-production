// Online orders: what the online shop sold, waiting for a person to decide.
// Nothing goes to the factory by itself (unless the owner chose that under
// Settings → Online shop): tick the lines that are to be built and send them,
// or mark the order "Not for the factory" when it is bought in from a
// supplier or sent from the shelf. The orders live on the server
// (companies/<id>/shopifyOrders, read through factory-shopify), so this
// screen asks for them rather than watching them.
import * as store from './store.js';
import { esc, money, niceDate, toast, empty } from './ui.js';

const st = { list: null, loading: false, error: '', ticked: {}, at: 0 };
let repaint = () => {};
export const setOnlineRepaint = (fn) => { repaint = fn; };

async function load(force) {
  if (st.loading || (!force && st.list && Date.now() - st.at < 30000)) return;
  st.loading = true;
  try { st.list = await store.shopifyCall('online'); st.error = ''; }
  catch (e) { st.error = e.message || 'Could not read the online orders'; if (!st.list) st.list = { waiting: [], recent: [] }; }
  st.loading = false; st.at = Date.now();
  repaint();
}
export const waitingCount = () => (st.list ? st.list.waiting.length : 0);

const cur = () => 'R';
// the shop's total; when it gives none, the lines added up
const amount = (o) => money(Number(o.total) || (o.lines || []).reduce((n, l) => n + (Number(l.qty) || 0) * (Number(l.price) || 0), 0), cur());
const linePrice = (l) => money(Number(l.price) || 0, cur());

export function renderOnline(screen, { shop, canEdit, fresh }) {
  if (shop && shop.connected) load(!!fresh);
  const auto = shop && shop.sendToFactory === 'auto';
  const head = `<div class="page-head"><div><h1>Online orders</h1><p class="sub">What the online shop sold. ${auto
    ? 'The owner set online orders to go to the factory by themselves (Settings → Online shop), so this list stays empty.'
    : 'Nothing goes to the factory by itself: tick the lines the factory builds and send them, or mark the order as not for the factory when it is bought in from a supplier or sent from the shelf.'}</p></div>
    <div class="btn-row"><button class="btn ghost" data-act="ol-refresh">${st.loading ? 'Checking…' : 'Refresh'}</button></div></div>`;
  if (!shop || !shop.connected) {
    screen.innerHTML = head + empty('🛒', 'No online shop connected', 'The owner connects the Shopify shop under Settings → Online shop.');
    return;
  }
  if (!st.list) { screen.innerHTML = head + '<p class="muted">Reading the online orders…</p>'; return; }
  const err = st.error ? `<p class="notice-inline">${esc(st.error)}</p>` : '';
  const w = st.list.waiting || [];
  const waitingHtml = w.length ? w.map(o => {
    const tick = st.ticked[o.id] || {};
    return `<div class="card ol-card" data-order="${esc(o.id)}">
      <div class="ol-head"><div><strong>${esc(o.name)}</strong> <span class="chip ${o.paid ? 'calm' : 'late'}">${o.paid ? 'paid' : 'not paid yet'}</span>
        <div class="muted">${esc(niceDate(String(o.placedAt || '').slice(0, 10)))} · ${esc((o.customer || {}).name || 'No name')}${(o.customer || {}).phone ? ' · ' + esc(o.customer.phone) : ''}</div></div>
        <div class="ol-total">${esc(amount(o))}</div></div>
      <div class="ol-lines">${(o.lines || []).map(l => `<label class="ol-line"><input type="checkbox" data-act="ol-tick" data-id="${esc(o.id)}" data-line="${esc(l.id)}"${tick[l.id] ? ' checked' : ''}${canEdit ? '' : ' disabled'}>
        <span class="ol-what"><strong>${esc(l.qty)} × ${esc(l.title)}</strong>${l.sku ? `<span class="muted"> · ${esc(l.sku)}</span>` : ''}</span><span class="muted">${esc(linePrice(l))}</span></label>`).join('')}</div>
      ${canEdit ? `<div class="btn-row"><button class="btn primary" data-act="ol-send" data-id="${esc(o.id)}">Send ticked lines to the factory</button><button class="btn ghost" data-act="ol-keep" data-id="${esc(o.id)}">Not for the factory</button></div>`
        : '<p class="muted">Your role can look at these, not send them.</p>'}
    </div>`;
  }).join('') : empty('✓', 'Nothing waiting', 'New online orders show here until someone sends them to the factory or marks them as not for the factory.');
  const r = st.list.recent || [];
  const recentHtml = r.length ? `<h2 class="ol-h2">Dealt with lately</h2><div class="card" style="padding:0;overflow:auto"><table class="tbl"><tbody>${r.map(o => `<tr>
      <td><strong>${esc(o.name)}</strong><div class="muted">${esc(niceDate(String(o.placedAt || '').slice(0, 10)))} · ${esc((o.customer || {}).name || '')}</div></td>
      <td>${o.status === 'sent' ? `<span class="chip st-prod">to the factory</span> <span class="muted">${esc((o.orderNos || []).join(', '))}${o.sentBy ? ' · ' + esc(o.sentBy) : ''}</span>`
        : o.status === 'kept' ? `<span class="chip calm">not for the factory</span> <span class="muted">${esc(o.keptBy || '')}</span>`
        : `<span class="chip late">${esc(o.status)}</span>`}</td>
      <td class="r">${canEdit && o.status === 'kept' ? `<button class="btn ghost sm" data-act="ol-unkeep" data-id="${esc(o.id)}">Undo</button>` : ''}
        ${canEdit && o.status === 'sent' && (o.lines || []).some(l => !(o.sentLines || []).includes(l.id)) ? `<button class="btn ghost sm" data-act="ol-more" data-id="${esc(o.id)}">Send more lines</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '';
  screen.innerHTML = head + err + `<div class="ol-list">${waitingHtml}</div>` + recentHtml;
}

export async function onlineAction(act, el) {
  const id = el.dataset.id;
  if (act === 'ol-refresh') { await load(true); return; }
  if (act === 'ol-tick') { const t = st.ticked[id] = st.ticked[id] || {}; t[el.dataset.line] = el.checked; return; }
  if (act === 'ol-more') {
    // a sent order with lines left: back on the list with those lines to tick
    const o = (st.list.recent || []).find(x => x.id === id); if (!o) return;
    st.list.recent = st.list.recent.filter(x => x.id !== id);
    st.list.waiting = [{ ...o, lines: (o.lines || []).filter(l => !(o.sentLines || []).includes(l.id)) }, ...st.list.waiting];
    repaint(); return;
  }
  if (act === 'ol-send') {
    const lines = Object.entries(st.ticked[id] || {}).filter(([, v]) => v).map(([k]) => k);
    if (!lines.length) { toast('Tick the lines the factory builds first', 'warn'); return; }
    el.disabled = true; el.textContent = 'Sending…';
    try {
      const r = await store.shopifyCall('sendOnline', { orderId: id, lines });
      toast(r.order + ' → the factory: ' + (r.orders.length ? r.orders.join(', ') : 'already there'));
      delete st.ticked[id];
    } catch (e) { toast(e.message, 'warn'); }
    await load(true); return;
  }
  if (act === 'ol-keep' || act === 'ol-unkeep') {
    if (act === 'ol-keep' && !confirm('Keep this order off the factory? Use this when it is bought in from a supplier or sent from the shelf. You can undo it.')) return;
    try { await store.shopifyCall('keepOnline', { orderId: id, undo: act === 'ol-unkeep' }); toast(act === 'ol-keep' ? 'Kept off the factory' : 'Back on the list'); }
    catch (e) { toast(e.message, 'warn'); }
    await load(true);
  }
}
