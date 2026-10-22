// Retail POS — the Customers tab: find a customer by cell number or name,
// the profile with POPIA consent per channel (dated), purchase history,
// lay-bys and custom orders across the company's stores, store credit and
// loyalty points; a manager merges duplicates, exports a profile on
// request, anonymises it, or adjusts points. The server (pos-customer)
// writes everything; the cell number is the key.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, openModal, money, niceDate, niceTime, empty } from './ui.js';
import { toCsv, download } from './csv.js';
import { CHANNELS, loyaltySettings, phoneKey } from './loyalty-terms.js';
import { icon } from './icons.js';

export const cu = { q: '', filter: 'active' };
let ctx = { repaint() {}, data: () => ({}) };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();   // { entity, store, settings, customers }
const where = () => auth.session.device ? auth.deviceBody() : { entityId: d().entity.id, storeId: d().store ? d().store.id : '', registerId: '' };
const mine = () => (d().customers || []).filter(c => c.entityId === d().entity.id);
const one = (id) => mine().find(c => c.id === id);
const consentOf = (c) => CHANNELS.filter(([k]) => c.consent && c.consent[k] && c.consent[k].granted).map(([, l]) => l);

// ----------------------------------------------------------------- html --
export function customersHtml() {
  const dd = d();
  if (!dd.entity) return `<div class="page-head"><h1>Customers</h1></div><div class="card muted">Pick a store first.</div>`;
  const q = cu.q.trim().toLowerCase(), qk = phoneKey(cu.q);
  const rows = mine().filter(c => (cu.filter === 'all' || (cu.filter === 'active' ? !c.archived && !c.mergedInto : cu.filter === 'credit' ? (c.storeCreditCents || 0) > 0 : cu.filter === 'account' ? c.accountEnabled : cu.filter === 'consent' ? consentOf(c).length > 0 : true)) && (!q || [c.name, c.phone, c.email, ...(c.tags || [])].some(x => String(x || '').toLowerCase().includes(q)) || (qk && (c.phoneKey === qk || (c.altPhones || []).includes(qk)))))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const ls = loyaltySettings(dd.settings);
  return `<div class="page-head"><h1>Customers</h1><p class="sub">${mine().filter(c => !c.archived).length} customers${ls.enabled ? ' · loyalty on: ' + ls.pointsPerRand + ' point' + (ls.pointsPerRand === 1 ? '' : 's') + ' per rand, ' + ls.pointValueCents + 'c a point' : ''}</p></div>
    <div class="toolbar"><input id="cu-q" class="search" type="search" placeholder="Cell number, name, email, tag" value="${esc(cu.q)}">
      <select id="cu-filter">${[['active', 'Active'], ['credit', 'With store credit'], ['account', 'With an account'], ['consent', 'Opted in to marketing'], ['all', 'All, incl. archived']].map(x => `<option value="${x[0]}"${cu.filter === x[0] ? ' selected' : ''}>${x[1]}</option>`).join('')}</select>
      <button class="btn primary sm" data-act="cu-new">${icon('plus')} New customer</button>${auth.atLeast('manager') ? `<button class="btn ghost sm" data-act="cu-export-all">${icon('file')} CSV</button>` : ''}</div>
    ${rows.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl cu-tbl"><thead><tr><th>Customer</th><th>Cell · email</th><th>Consent</th><th class="r">Credit</th>${ls.enabled ? '<th class="r">Points</th><th>Tier</th>' : ''}<th class="r">Spent</th><th></th></tr></thead>
      <tbody>${rows.slice(0, 300).map(c => `<tr class="${c.archived ? 'off' : ''}"><td><strong>${esc(c.name)}</strong>${c.mergedInto ? '<div class="muted">merged</div>' : c.anonymised ? '<div class="muted">anonymised</div>' : (c.tags || []).length ? `<div class="muted">${esc(c.tags.join(', '))}</div>` : ''}</td><td>${esc(c.phone || '')}<div class="muted">${esc(c.email || '')}</div></td><td class="muted">${esc(consentOf(c).join(', ') || '—')}</td><td class="r">${c.storeCreditCents ? esc(money(c.storeCreditCents)) : ''}${c.accountBalanceCents ? `<div class="warn">owes ${esc(money(c.accountBalanceCents))}</div>` : ''}</td>${ls.enabled ? `<td class="r">${(c.loyalty || {}).points || 0}</td><td class="muted">${esc((c.loyalty || {}).tier || '')}</td>` : ''}<td class="r">${esc(money((c.stats || {}).spentCents || 0))}<div class="muted">${(c.stats || {}).salesCount || 0} sale${(c.stats || {}).salesCount === 1 ? '' : 's'}</div></td><td class="r"><button class="btn ghost sm" data-act="cu-open" data-id="${esc(c.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>${rows.length > 300 ? '<p class="muted">The first 300: narrow the search.</p>' : ''}`
      : empty('No customers match', 'Customers are added at the till or here. The cell number is the key: one profile per number.')}`;
}
export function onInput(id, value) { if (id === 'cu-q') { cu.q = value; ctx.repaint(); const q = document.getElementById('cu-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } }
export function onChange(e) { if (e.target.id === 'cu-filter') { cu.filter = e.target.value; ctx.repaint(); } }
export async function action(act, b) {
  const id = b.dataset.id;
  if (act === 'cu-new') return editForm('');
  if (act === 'cu-edit') return editForm(id);
  if (act === 'cu-open') return profile(id);
  if (act === 'cu-consent') return consentToggle(id, b.dataset.ch, b.dataset.on === '1');
  if (act === 'cu-merge') return mergeForm(id);
  if (act === 'cu-export') return exportOne(id);
  if (act === 'cu-anon') return anonymise(id);
  if (act === 'cu-points') return adjustPoints(id);
  if (act === 'cu-export-all') return exportAll();
}

// ------------------------------------------------------------- forms --
// the form the till's quick-add and this tab share: saveCustomer(body) → the customer
export async function saveCustomer(body) { const r = await auth.api('save', { ...body, ...where() }, API.customer); return r.customer; }
export function consentFields(prefix, c = {}) {
  return `<div class="cu-consent"><span class="muted">May we contact them about specials? (POPIA: their choice, recorded with the date)</span>${CHANNELS.map(([k, l]) => `<label class="chk"><input type="checkbox" id="${prefix}-${k}"${c.consent && c.consent[k] && c.consent[k].granted ? ' checked' : ''}> ${l}</label>`).join('')}</div>`;
}
export const readConsent = (w, prefix) => Object.fromEntries(CHANNELS.map(([k]) => [k, !!w.querySelector('#' + prefix + '-' + k).checked]));
function editForm(id) {
  const c = id ? one(id) : null; if (id && !c) return;
  const mgr = auth.atLeast('manager'); const a = (c && c.address) || {};
  openModal(c ? 'Edit ' + c.name : 'New customer', row(field('Name', 'cf-name', { value: c ? c.name : '' }), field('Cell number', 'cf-phone', { value: c ? c.phone : '', inputmode: 'tel', placeholder: '082 123 4567' })) + row(field('Email', 'cf-email', { value: c ? c.email : '', type: 'email' }), field('VAT number', 'cf-vat', { value: c ? c.vatNo : '' })) + row(field('Street', 'cf-line1', { value: a.line1 }), field('Suburb', 'cf-line2', { value: a.line2 })) + row(field('City', 'cf-city', { value: a.city }), field('Postal code', 'cf-code', { value: a.code })) + row(field('Birthday', 'cf-dob', { type: 'date', value: c ? c.dob : '' }), field('Tags (comma separated)', 'cf-tags', { value: c ? (c.tags || []).join(', ') : '' })) + field('Notes', 'cf-notes', { type: 'textarea', value: c ? c.notes : '' }) + consentFields('cf', c || {}) + (mgr ? `<div class="grid two"><label class="chk"><input type="checkbox" id="cf-acc"${c && c.accountEnabled ? ' checked' : ''}> Has an account (buys on credit)</label>${field('Credit limit (R)', 'cf-limit', { value: c ? ((c.creditLimitCents || 0) / 100).toFixed(2) : '0.00', inputmode: 'decimal' })}</div>` : ''), {
    okLabel: 'Save', onOk: async (w) => {
      const body = { customerId: id, name: val(w, 'cf-name'), phone: val(w, 'cf-phone'), email: val(w, 'cf-email'), vatNo: val(w, 'cf-vat'), address: { line1: val(w, 'cf-line1'), line2: val(w, 'cf-line2'), city: val(w, 'cf-city'), code: val(w, 'cf-code') }, dob: val(w, 'cf-dob'), tags: val(w, 'cf-tags'), notes: val(w, 'cf-notes'), consent: readConsent(w, 'cf') };
      if (mgr) { body.accountEnabled = !!w.querySelector('#cf-acc').checked; body.creditLimitCents = Math.round(Number(val(w, 'cf-limit').replace(/[^\d.]/g, '')) * 100) || 0; }
      try { const cust = await saveCustomer(body); toast('Saved ' + cust.name); return true; } catch (e) { toast(e.message, 'warn'); return false; }
    }
  });
}

// ----------------------------------------------------------- profile --
async function profile(id) {
  const c = one(id); if (!c) return;
  const dd = d(); const ls = loyaltySettings(dd.settings); const mgr = auth.atLeast('manager');
  const consentHtml = (cc) => CHANNELS.map(([k, l]) => { const x = (cc.consent || {})[k] || {}; return `<div class="x-row"><span>${l}: <strong>${x.granted ? 'yes' : 'no'}</strong>${x.at ? ` <span class="muted">· ${esc(niceDate(x.at))} by ${esc(x.byName)}${x.source ? ' (' + esc(x.source) + ')' : ''}</span>` : ''}</span>${cc.anonymised || cc.mergedInto ? '' : `<button class="btn ghost sm" data-act="cu-consent" data-id="${esc(cc.id)}" data-ch="${k}" data-on="${x.granted ? '0' : '1'}">${x.granted ? 'Withdraw' : 'Opt in'}</button>`}</div>`; }).join('');
  const { wrap } = openModal(c.name, `<div class="lb-detail">
    <div class="lb-head">${c.anonymised ? '<span class="chip off">anonymised</span>' : c.mergedInto ? '<span class="chip off">merged</span>' : ''}<span class="muted">${esc(c.phone || 'no cell number')}${c.email ? ' · ' + esc(c.email) : ''}${c.vatNo ? ' · VAT ' + esc(c.vatNo) : ''}${c.address && (c.address.line1 || c.address.city) ? ' · ' + esc([c.address.line1, c.address.line2, c.address.city, c.address.code].filter(Boolean).join(', ')) : ''}${(c.altPhones || []).length ? ' · also ' + esc(c.altPhones.join(', ')) : ''}</span></div>
    <div class="lb-cols"><div><h3>Consent (POPIA)</h3>${consentHtml(c)}${c.notes ? `<p class="muted">${esc(c.notes)}</p>` : ''}</div>
      <div><h3>Money and points</h3><div class="x-row"><span>Store credit</span><strong>${esc(money(c.storeCreditCents || 0))}</strong></div>${c.accountEnabled ? `<div class="x-row"><span>Account: owes</span><strong>${esc(money(c.accountBalanceCents || 0))} of ${esc(money(c.creditLimitCents || 0))}</strong></div>` : ''}${ls.enabled ? `<div class="x-row"><span>Points · ${esc((c.loyalty || {}).tier || ls.tiers[0].name)}</span><strong id="cu-pts">${(c.loyalty || {}).points || 0} (${esc(money(((c.loyalty || {}).points || 0) * ls.pointValueCents))})</strong></div>` : ''}<div class="x-row"><span>Spent</span><span>${esc(money((c.stats || {}).spentCents || 0))} over ${(c.stats || {}).salesCount || 0} sale${(c.stats || {}).salesCount === 1 ? '' : 's'}${(c.stats || {}).lastSaleAt ? ', last ' + esc(niceDate(c.stats.lastSaleAt)) : ''}</span></div></div></div>
    <h3 class="st-h3">History</h3><div id="cu-hist" class="muted">Loading…</div>
    <div class="card-actions lb-acts">${c.anonymised ? '' : `<button class="btn" data-act="cu-edit" data-id="${esc(c.id)}">Edit</button>`}${mgr && !c.anonymised && !c.mergedInto ? `<button class="btn ghost" data-act="cu-merge" data-id="${esc(c.id)}">Merge a duplicate into this</button>${ls.enabled ? `<button class="btn ghost" data-act="cu-points" data-id="${esc(c.id)}">Adjust points</button>` : ''}<button class="btn ghost" data-act="cu-export" data-id="${esc(c.id)}">${icon('file')} Export (POPIA request)</button><button class="btn ghost" data-act="cu-anon" data-id="${esc(c.id)}">Anonymise</button>` : ''}</div></div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
  wrap.querySelector('.modal-card').classList.add('wide');
  try {
    const h = await auth.api('history', { customerId: c.id, ...where() }, API.customer);
    const host = wrap.querySelector('#cu-hist'); if (!host) return;
    const tbl = (title, rows, cols) => rows.length ? `<h4 class="cu-h4">${title}</h4><table class="tbl"><tbody>${rows.map(r => `<tr>${cols.map(fn => `<td>${fn(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
    host.className = '';
    host.innerHTML = (h.loyalty && h.loyalty.enabled ? `<p class="muted">${h.loyalty.points} points worth ${esc(money(h.loyalty.valueCents))}${h.loyalty.expiringSoon ? ` · <span class="warn">${h.loyalty.expiringSoon} expire within 30 days</span>` : ''}</p>` : '') +
      tbl('Sales', h.sales, [r => esc(niceDate(r.at)) + ' <span class="muted">' + esc(r.storeId) + '</span>', r => '<strong>' + esc(r.docNo) + '</strong>', r => r.lines + ' line' + (r.lines === 1 ? '' : 's'), r => '<span class="r">' + esc(money(r.totalCents)) + '</span>']) +
      tbl('Credit notes', h.creditNotes, [r => esc(niceDate(r.at)), r => '<strong>' + esc(r.docNo) + '</strong> against ' + esc(r.saleDocNo || 'no receipt'), r => esc(money(r.totalCents))]) +
      tbl('Lay-bys', h.laybys, [r => esc(niceDate(r.at)), r => '<strong>' + esc(r.docNo) + '</strong> · ' + esc(r.status), r => 'paid ' + esc(money(r.paidCents)) + ' of ' + esc(money(r.totalCents))]) +
      tbl('Custom orders', h.specialOrders, [r => esc(niceDate(r.at)), r => '<strong>' + esc(r.docNo) + '</strong> · ' + esc(r.status), r => 'paid ' + esc(money(r.paidCents)) + ' of ' + esc(money(r.totalCents))]) +
      tbl('Points', h.ledger.slice(0, 30), [r => esc(niceDate(r.at)), r => esc(r.kind) + (r.docNo ? ' · ' + esc(r.docNo) : '') + (r.note ? ' · ' + esc(r.note) : ''), r => (r.points > 0 ? '+' : '') + r.points + ' <span class="muted">→ ' + r.balanceAfter + '</span>']) ||
      '<p class="muted">Nothing yet.</p>';
  } catch (e) { const host = wrap.querySelector('#cu-hist'); if (host) host.textContent = 'Could not load the history: ' + e.message; }
}
async function consentToggle(id, channel, granted) {
  try { await auth.api('consent', { customerId: id, channel, granted, ...where() }, API.customer); toast((granted ? 'Opted in to ' : 'Withdrawn from ') + channel + ', recorded'); const m = document.getElementById('modal'); if (m) m.remove(); setTimeout(() => profile(id), 400); }
  catch (e) { toast(e.message, 'warn'); }
}

// ------------------------------------------------------------ manager --
async function withPin(action, body) {
  try { return await auth.api(action, body, API.customer); }
  catch (e) {
    if (e.status === 403 && /PIN/.test(e.message)) { const a = await auth.requireOverride({ minRole: 'manager', action: 'customer', details: { what: action }, text: e.message }); return auth.api(action, { ...body, approvalToken: a.token }, API.customer); }
    throw e;
  }
}
function mergeForm(keepId) {
  const keep = one(keepId); if (!keep) return;
  const others = mine().filter(c => c.id !== keepId && !c.archived && !c.mergedInto && !c.anonymised);
  openModal('Merge into ' + keep.name, `<p class="muted">The other profile's store credit, account balance, points, consent and history move to <strong>${esc(keep.name)}</strong>; its cell number becomes a second number here. Invoices already issued stay as they are. This cannot be undone.</p>` + field('Duplicate to merge in', 'mg-drop', { type: 'select', value: '', options: [{ value: '', label: 'Choose…' }, ...others.map(c => ({ value: c.id, label: c.name + (c.phone ? ' · ' + c.phone : '') + (c.storeCreditCents ? ' · credit ' + money(c.storeCreditCents) : '') }))] }), {
    okLabel: 'Merge', onOk: async (w) => { const dropId = val(w, 'mg-drop'); if (!dropId) { toast('Which one?', 'warn'); return false; } if (!confirm('Merge ' + (one(dropId) || {}).name + ' into ' + keep.name + '?')) return false;
      try { await withPin('merge', { keepId, dropId, ...where() }); toast('Merged'); const m = document.getElementById('modal'); if (m) m.remove(); return true; } catch (e) { toast(e.message, 'warn'); return false; } }
  });
}
async function exportOne(id) {
  const c = one(id); if (!c) return;
  try {
    const r = await withPin('export', { customerId: id, ...where() });
    download(JSON.stringify(r, null, 2), 'customer-' + (c.phoneKey || c.id) + '.json', 'application/json');
    const rows = [['Type', 'Date', 'Number', 'Store', 'Amount', 'Status'], ...r.sales.map(s => ['Sale', s.at, s.docNo, s.storeId, (s.totalCents / 100).toFixed(2), s.status]), ...r.creditNotes.map(s => ['Credit note', s.at, s.docNo, s.storeId, (s.totalCents / 100).toFixed(2), '']), ...r.laybys.map(s => ['Lay-by', s.at, s.docNo, s.storeId, (s.totalCents / 100).toFixed(2), s.status]), ...r.specialOrders.map(s => ['Custom order', s.at, s.docNo, s.storeId, (s.totalCents / 100).toFixed(2), s.status])];
    download(toCsv(rows), 'customer-' + (c.phoneKey || c.id) + '-history.csv');
    toast('Exported: the profile as JSON and the history as CSV');
  } catch (e) { toast(e.message, 'warn'); }
}
async function anonymise(id) {
  const c = one(id); if (!c) return;
  const reason = prompt('Anonymise ' + c.name + '? Their name, number, email, address, notes and consent are wiped and the number freed; invoices already issued keep their copy as tax records. Why?', 'Customer request (POPIA)'); if (reason === null) return;
  try { await withPin('anonymise', { customerId: id, reason, ...where() }); toast('Anonymised'); const m = document.getElementById('modal'); if (m) m.remove(); } catch (e) { toast(e.message, 'warn'); }
}
function adjustPoints(id) {
  const c = one(id); if (!c) return;
  openModal('Adjust points for ' + c.name, row(field('Points (minus to take away)', 'ap-pts', { type: 'number' }), field('Why', 'ap-note', { placeholder: 'e.g. goodwill, a missed scan' })), {
    okLabel: 'Adjust', onOk: async (w) => { try { const r = await withPin('adjustPoints', { customerId: id, points: Number(val(w, 'ap-pts')), note: val(w, 'ap-note'), ...where() }); toast('Points now ' + r.points); const m = document.getElementById('modal'); if (m) m.remove(); return true; } catch (e) { toast(e.message, 'warn'); return false; } }
  });
}
function exportAll() {
  const rows = [['Name', 'Cell', 'Email', 'VAT no', 'City', 'WhatsApp consent', 'SMS consent', 'Email consent', 'Store credit', 'Account owes', 'Points', 'Tier', 'Spent', 'Sales', 'Last sale', 'Tags'], ...mine().filter(c => !c.archived).map(c => [c.name, c.phone, c.email, c.vatNo, (c.address || {}).city || '', ...CHANNELS.map(([k]) => (c.consent && c.consent[k] && c.consent[k].granted) ? 'yes ' + String(c.consent[k].at).slice(0, 10) : 'no'), ((c.storeCreditCents || 0) / 100).toFixed(2), ((c.accountBalanceCents || 0) / 100).toFixed(2), (c.loyalty || {}).points || 0, (c.loyalty || {}).tier || '', (((c.stats || {}).spentCents || 0) / 100).toFixed(2), (c.stats || {}).salesCount || 0, ((c.stats || {}).lastSaleAt || '').slice(0, 10), (c.tags || []).join(' ')])];
  download(toCsv(rows), 'customers-' + d().entity.id + '.csv');
}
