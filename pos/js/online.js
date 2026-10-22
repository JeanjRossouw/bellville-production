// Retail POS — the Online tab (supervisors and up): the shop's orders for
// this store with click & collect first (mark ready, mark collected, which
// fulfils the order on Shopify), the sync state (queue, linked items,
// codes), the sync buttons for managers, and the log. The owner's connect
// form and settings live under Admin → Settings → Shopify (shopifyCard).
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money, niceDate, niceTime, empty } from './ui.js';
import { icon } from './icons.js';

export const on = { orders: null, status: null, log: null, busy: false, filter: 'open' };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store.id, registerId: '' };
const STATE = { new: ['New', 'prod'], ready: ['Ready to collect', 'ok'], collected: ['Collected', ''], cancelled: ['Cancelled', 'off'], refunded: ['Refunded', 'off'] };

export function onlineHtml() {
  const dd = d();
  if (!dd.store) return `<div class="page-head"><h1>Online</h1></div><div class="card muted">Pick a store first.</div>`;
  const st = on.status;
  const rows = (on.orders || []).filter(o => on.filter === 'all' || (on.filter === 'open' ? /new|ready/.test(o.status) : on.filter === 'pickup' ? o.pickup && /new|ready/.test(o.status) : o.status === on.filter));
  return `<div class="page-head"><h1>Online · ${esc(dd.store.name)}</h1><p class="sub">${st ? (st.connected ? `Connected to ${esc(st.shopName || st.domain)} · ${st.linked} item${st.linked === 1 ? '' : 's'} linked · ${st.queue.count ? st.queue.count + ' stock update' + (st.queue.count === 1 ? '' : 's') + ' waiting' + (st.queue.failing ? ' (' + st.queue.failing + ' retrying)' : '') : 'stock up to date'}${st.lastSyncAt ? ' · last sync ' + esc(niceDate(st.lastSyncAt)) + ' ' + esc(niceTime(st.lastSyncAt)) : ''}${st.lastError ? ' · <span class="warn">' + esc(st.lastError) + '</span>' : ''}` : 'Not connected: the owner connects Shopify under Admin → Settings.') : 'Loading…'}</p></div>
    <div class="toolbar">
      <select id="on-filter">${[['open', 'Open orders'], ['pickup', 'Click & collect'], ['collected', 'Collected'], ['cancelled', 'Cancelled'], ['all', 'All']].map(x => `<option value="${x[0]}"${on.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>
      <button class="btn ghost sm" data-act="on-refresh">${icon('refresh')} Refresh</button>
      ${auth.atLeast('manager') && st && st.connected ? `<button class="btn ghost sm" data-act="on-sync"${on.busy ? ' disabled' : ''}>${icon('refresh')} Sync now</button><button class="btn ghost sm" data-act="on-link"${on.busy ? ' disabled' : ''}>Link products by SKU</button><button class="btn ghost sm" data-act="on-push"${on.busy ? ' disabled' : ''}>Push all stock</button><button class="btn ghost sm" data-act="on-log">Log</button>` : ''}</div>
    ${on.orders === null ? '<div class="card muted">Loading orders…</div>' : rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Lines</th><th class="r">Total</th><th>Delivery</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(o => `<tr class="${/cancelled|collected|refunded/.test(o.status) ? 'off' : ''}"><td><strong>${esc(o.orderNo)}</strong><div class="muted">${esc(niceDate(o.orderedAt))} ${esc(niceTime(o.orderedAt))}</div></td><td>${esc(o.customer.name)}<div class="muted">${esc([o.customer.phone, o.customer.email].filter(Boolean).join(' · '))}</div></td><td>${o.lines.map(l => `<div>${l.qty} × ${esc(l.name || l.title)}${l.itemId ? '' : ' <span class="warn">(not a POS item)</span>'}</div>`).join('')}</td><td class="r">${esc(money(o.totalCents))}<div class="muted">${esc(o.financialStatus)}</div></td><td>${o.pickup ? '<span class="chip ok">Click &amp; collect</span>' : esc(o.shippingTitle || 'delivery')}${o.address && !o.pickup ? `<div class="muted">${esc(o.address)}</div>` : ''}</td><td class="muted">${esc(o.stock)}</td><td><span class="chip ${(STATE[o.status] || ['', ''])[1]}">${esc((STATE[o.status] || [o.status])[0])}</span></td><td class="r nowrap">${o.status === 'new' && o.pickup ? `<button class="btn ghost sm" data-act="on-ready" data-id="${esc(o.id)}">Ready</button>` : ''}${/new|ready/.test(o.status) ? `<button class="btn primary sm" data-act="on-collected" data-id="${esc(o.id)}">${o.pickup ? 'Collected' : 'Handed over'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No online orders here', 'Orders arrive by webhook as the shop takes them; click & collect ones show first.')}
    ${on.log ? `<h3 class="st-h3">Sync log</h3><div class="card" style="padding:0;overflow:auto"><table class="tbl"><tbody>${on.log.map(l => `<tr class="${l.status === 'failed' ? 'neg' : ''}"><td class="muted nowrap">${esc(niceDate(l.at))} ${esc(niceTime(l.at))}</td><td>${esc(l.kind)}</td><td><span class="chip${l.status === 'ok' ? ' ok' : l.status === 'failed' ? ' late' : ''}">${esc(l.status)}</span></td><td>${esc(l.message)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div>` : ''}`;
}
export async function load() {
  const dd = d(); if (!dd.store) return;
  try {
    const [st, o] = await Promise.all([auth.atLeast('manager') ? auth.api('status', { entityId: dd.entity.id }, API.shopify).catch(e => ({ connected: false, lastError: e.message, queue: {}, linked: 0 })) : Promise.resolve(on.status || { connected: !!(dd.settings.shopify || {}).connected, shopName: (dd.settings.shopify || {}).shopName, queue: {}, linked: 0 }), auth.api('orders', { ...where() }, API.shopify)]);
    on.status = st; on.orders = o.orders;
  } catch (e) { on.orders = []; toast(e.message, 'warn'); }
  ctx.repaint();
}
export function onChange(e) { if (e.target.id === 'on-filter') { on.filter = e.target.value; ctx.repaint(); } }
export async function action(act, b) {
  const dd = d(); const id = b.dataset.id;
  const run = async (what, body, done) => { on.busy = true; ctx.repaint(); try { const r = await auth.api(what, { entityId: dd.entity.id, ...body }, API.shopify); toast(done(r)); } catch (e) { toast(e.message, 'warn'); } on.busy = false; await load(); };
  if (act === 'on-refresh') return load();
  if (act === 'on-sync') return run('syncNow', {}, r => `Synced: ${r.stock.pushed || 0} stock updates${r.codes != null ? ', ' + r.codes + ' codes' : ''}${r.customers ? ', ' + r.customers.pushed + ' customers' : ''}`);
  if (act === 'on-link') return run('link', {}, r => `${r.linked} of ${r.seen} shop variants linked by SKU${r.unmatched.length ? ' · not matched: ' + r.unmatched.slice(0, 5).join(', ') : ''}`);
  if (act === 'on-push') return run('pushStock', {}, r => `${r.queued} items queued, ${r.pushed || 0} pushed now${r.failed ? ', ' + r.failed + ' retrying' : ''}`);
  if (act === 'on-log') { try { on.log = (await auth.api('log', { entityId: dd.entity.id }, API.shopify)).log; } catch (e) { toast(e.message, 'warn'); } return ctx.repaint(); }
  if (act === 'on-ready' || act === 'on-collected') {
    try { const r = await auth.api('collect', { orderId: id, status: act === 'on-ready' ? 'ready' : 'collected', ...where() }, API.shopify); toast(act === 'on-ready' ? 'Marked ready: tell the customer' : 'Collected' + (r.fulfilled ? ' · ' + r.fulfilled : '')); }
    catch (e) { if (e.status === 403 && /PIN/.test(e.message)) { try { const a = await auth.requireOverride({ minRole: 'supervisor', action: 'online', details: { orderId: id }, text: e.message }); await auth.api('collect', { orderId: id, status: act === 'on-ready' ? 'ready' : 'collected', approvalToken: a.token, ...where() }, API.shopify); } catch (e2) { toast(e2.message, 'warn'); } } else toast(e.message, 'warn'); }
    return load();
  }
}

// ---- the owner's card under Settings: connect, map locations to stores, the switches
export async function shopifyCard(host, entityId, stores) {
  const el = host.querySelector('#se-shop'); if (!el) return;
  let st;
  try { st = await auth.api('status', { entityId }, API.shopify); } catch (e) { el.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const mine = stores.filter(s => s.entityId === entityId);
  const locOpts = [{ value: '', label: 'Not on Shopify' }, ...(st.locations || []).map(l => ({ value: l.id, label: l.name }))];
  el.innerHTML = st.connected ? `<p>Connected to <strong>${esc(st.shopName || st.domain)}</strong> (${esc(st.domain)}) · ${st.linked} items linked · ${(st.codes || []).length} discount codes</p>
      <p class="muted">Webhooks to register on the Shopify app (orders/create, orders/cancelled, refunds/create): <code>${esc(location.origin + st.webhookUrl)}</code></p>
      <div class="grid two">${mine.map(s => field('Shopify location for ' + s.name, 'sh-loc-' + s.id, { type: 'select', value: (st.locationByStore || {})[s.id] || '', options: locOpts })).join('')}</div>
      ${field('Store for online orders and pickups with no match', 'sh-default', { type: 'select', value: st.defaultStoreId, options: [{ value: '', label: 'Choose…' }, ...mine.map(s => ({ value: s.id, label: s.name }))] })}
      <div class="grid two">${field('Pickup shipping title → store (title=storeId, one per line)', 'sh-pickup', { type: 'textarea', rows: 2, value: Object.entries(st.pickupByTitle || {}).map(([k, v]) => k + '=' + v).join('\n') })}
        <div><label class="chk"><input type="checkbox" id="sh-push"${st.pushStock ? ' checked' : ''}> Push stock after every movement</label><label class="chk"><input type="checkbox" id="sh-pull"${st.pullOrders ? ' checked' : ''}> Take orders from the webhooks</label><label class="chk"><input type="checkbox" id="sh-codes"${st.syncCodes ? ' checked' : ''}> Share discount codes with the till</label><label class="chk"><input type="checkbox" id="sh-cust"${st.syncCustomers ? ' checked' : ''}> Push customers who opted in to marketing</label></div></div>
      <div class="card-actions"><button class="btn primary" data-act="on-settings" data-entity="${esc(entityId)}">Save Shopify settings</button><button class="btn ghost" data-act="on-locations" data-entity="${esc(entityId)}">Refresh locations</button><button class="btn ghost" data-act="on-disconnect" data-entity="${esc(entityId)}">Disconnect</button></div>`
    : `<p class="muted">${st.lastError ? '<span class="warn">' + esc(st.lastError) + '</span> · ' : ''}A Dev Dashboard app on the shop with read_products, write_inventory, read_locations, read_orders, write_orders (fulfilment), read_discounts, write_customers, read_customers.</p>
      <div class="grid three">${field('Store domain', 'sh-domain', { value: st.domain || '', placeholder: 'name.myshopify.com' })}${field('Client ID', 'sh-id', { autocomplete: 'off' })}${field('Client secret', 'sh-secret', { type: 'password', autocomplete: 'new-password' })}</div>
      <div class="card-actions"><button class="btn primary" data-act="on-connect" data-entity="${esc(entityId)}">Connect Shopify</button></div>`;
  if (el.dataset.wired) return;    // one listener per card element: a click into a field must not use it up
  el.dataset.wired = '1';
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; e.preventDefault();
    const act = b.dataset.act; const w = el;
    try {
      if (act === 'on-connect') { const r = await auth.api('connect', { entityId, domain: val(w, 'sh-domain'), clientId: val(w, 'sh-id'), clientSecret: val(w, 'sh-secret') }, API.shopify); toast('Connected to ' + r.shopName); }
      else if (act === 'on-settings') { const locationByStore = Object.fromEntries(mine.map(s => [s.id, val(w, 'sh-loc-' + s.id)])); const pickupByTitle = Object.fromEntries(val(w, 'sh-pickup').split('\n').map(l => l.split('=').map(x => x.trim())).filter(x => x[0] && x[1])); await auth.api('settings', { entityId, locationByStore, pickupByTitle, defaultStoreId: val(w, 'sh-default'), pushStock: !!w.querySelector('#sh-push').checked, pullOrders: !!w.querySelector('#sh-pull').checked, syncCodes: !!w.querySelector('#sh-codes').checked, syncCustomers: !!w.querySelector('#sh-cust').checked }, API.shopify); toast('Shopify settings saved'); }
      else if (act === 'on-locations') { await auth.api('locations', { entityId }, API.shopify); toast('Locations refreshed'); }
      else if (act === 'on-disconnect') { if (!confirm('Disconnect Shopify for this company? Stock will no longer be pushed and orders will be refused until it is connected again.')) return; await auth.api('disconnect', { entityId }, API.shopify); toast('Disconnected'); }
      else return;
      shopifyCard(host, entityId, stores);
    } catch (err) { toast(err.message, 'warn'); }
  });
}
