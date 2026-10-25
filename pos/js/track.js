// Retail POS — the client's own page (track.html?t=…): where the sales order is, the dates and
// what is paid; or the quotation, to accept and sign. Talks only to pos-track.mjs with the token.
import { padHtml, wirePad } from './signpad.js';

const FN = '/.netlify/functions/pos-track';
const t = new URLSearchParams(location.search).get('t') || '';
const app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => 'R ' + (Math.round(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const waDigits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '27' + d.slice(1); return d; };

async function call(action, body = {}) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, t, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again in a minute.');
  return j;
}

const shopHead = (s) => `<div class="shop"><div><h1>${esc(s.name)}</h1><div class="sub">${esc([s.store, s.address].filter(Boolean).join(' · '))}</div></div>
  ${s.phone ? `<div class="actions no-print"><a class="btn ghost sm" href="https://wa.me/${waDigits(s.phone)}">WhatsApp us</a><a class="btn ghost sm" href="tel:${esc(s.phone.replace(/\s/g, ''))}">Call</a></div>` : ''}</div>`;
const items = (lines) => lines.map(l => `<div class="item"><div class="x"><span>${esc(l.qty + ' × ' + l.name)}</span><strong>${esc(money(l.totalCents))}</strong></div>${l.spec.map(x => `<div class="spec">${esc(x)}</div>`).join('')}</div>`).join('');

function orderHtml(v) {
  const dv = v.delivery;
  const head = v.cancelled ? `<span class="pill bad">Cancelled</span>` : v.done ? `<span class="pill">${v.status === 'collected' ? 'Collected' : 'Delivered'}</span>` : v.status === 'quoted' ? `<span class="pill warn">Waiting for the deposit</span>` : `<span class="pill">${esc((v.steps.find(s => s.current) || {}).label || '')}</span>`;
  const picked = dv && dv.requested && !dv.confirmed;
  const when = v.done ? `${v.status === 'collected' ? 'Collected' : 'Delivered'} on ${day(v.completedAt)}${v.invoiceNo ? ' · tax invoice ' + esc(v.invoiceNo) : ''}`
    : dv && dv.onTheWay ? `<strong>${esc(dv.driverName || 'The driver')} is on the way</strong> with your order`
    : v.status === 'outForDelivery' ? `Out for delivery <strong>${day(dv.date)}</strong>${dv.slot ? ' · ' + esc(dv.slot) : ''}${dv.driverName ? ' with ' + esc(dv.driverName) : ''}`
    : picked ? `You asked for <strong>${day(dv.date)}</strong>${dv.slot ? ' · ' + esc(dv.slot) : ''}: the shop will confirm it`
    : dv ? `${dv.kind === 'collect' ? 'Collection' : 'Delivery'} booked for <strong>${day(dv.date)}</strong>${dv.slot ? ' · ' + esc(dv.slot) : ''}`
    : v.expectedAt && !v.cancelled ? `Expected by <strong>${day(v.expectedAt)}</strong>` : '';
  return `<div class="card"><h3>Your order</h3><h2>${esc(v.docNo)}</h2>
      <p>${v.name ? 'Hi ' + esc(v.name) + ', ' : ''}${head}</p>${when ? `<p>${when}</p>` : ''}
      ${!v.cancelled ? `<ol class="steps">${v.steps.map(s => `<li class="${s.done ? 'done' : ''}${s.current ? ' current' : ''}">${esc(s.label)}</li>`).join('')}</ol>` : ''}</div>
    ${v.slots ? pickHtml(v) : v.status === 'ready' && v.balanceCents > 0 ? `<div class="card"><h3>Delivery</h3><p>Your order is ready. Once the balance of <strong>${esc(money(v.balanceCents))}</strong> is paid you choose the delivery day here.</p></div>` : ''}
    <div class="card"><h3>What you ordered</h3>${items(v.lines)}</div>
    <div class="card"><h3>Payments</h3>
      <div class="row"><span>Total</span><strong>${esc(money(v.totalCents))}</strong></div>
      ${v.payments.map(p => `<div class="row"><span class="muted">Paid ${day(p.at)}</span><span>${esc(money(p.amountCents))}</span></div>`).join('')}
      <div class="row tot"><span>Balance</span><span class="${v.balanceCents > 0 ? 'owed' : ''}">${esc(money(v.balanceCents))}</span></div>
      ${v.minDepositCents > 0 ? `<p class="owed">A deposit of ${esc(money(v.minDepositCents))} starts your order.</p>` : ''}
      ${v.balanceCents > 0 && !v.cancelled && v.status !== 'quoted' ? `<p class="muted">The balance is paid before delivery or collection.</p>` : ''}</div>
    <p class="muted center no-print" style="padding:8px 0">This page updates as your order moves along: keep the link.</p>`;
}

// a ready, paid order: the client picks delivery (or collection), a day and a slot
let pick = { kind: 'deliver', date: '', slot: '' };
function pickHtml(v) {
  const dv = v.delivery && v.delivery.requested ? v.delivery : null;
  if (!pick.date) pick = dv ? { kind: dv.kind, date: dv.date, slot: dv.slot } : { kind: 'deliver', date: (v.slots[0] || {}).date || '', slot: '' };
  const theDay = v.slots.find(x => x.date === pick.date) || v.slots[0] || { slots: [] };
  const a = v.address || {};
  if (!v.slots.length) return `<div class="card"><h3>Delivery</h3><p>No open slots in the next two weeks: the shop will contact you.</p></div>`;
  return `<div class="card no-print" id="pick"><h3>${dv ? 'Change your day' : 'Choose your delivery day'}</h3>
    <div class="seg"><label><input type="radio" name="pk-kind" value="deliver"${pick.kind === 'deliver' ? ' checked' : ''}> Deliver to me</label><label><input type="radio" name="pk-kind" value="collect"${pick.kind === 'collect' ? ' checked' : ''}> I'll collect</label></div>
    <div class="daypick">${v.slots.map(x => `<button type="button" class="day${x.date === theDay.date ? ' on' : ''}" data-day="${esc(x.date)}">${esc(day(x.date).replace(/ \d{4}$/, ''))}</button>`).join('')}</div>
    <div class="slots">${theDay.slots.map(x => `<label class="slot${pick.slot === x.slot ? ' on' : ''}"><input type="radio" name="pk-slot" value="${esc(x.slot)}"${pick.slot === x.slot ? ' checked' : ''}> ${esc(x.slot)}</label>`).join('')}</div>
    ${pick.kind === 'deliver' ? `<label for="pk-1">Street</label><input type="text" id="pk-1" value="${esc(a.line1 || '')}"><div style="height:8px"></div>
      <label for="pk-2">Suburb</label><input type="text" id="pk-2" value="${esc(a.line2 || '')}"><div style="height:8px"></div>
      <label for="pk-3">City</label><input type="text" id="pk-3" value="${esc(a.city || '')}"><div style="height:8px"></div>` : ''}
    <label for="pk-note">Anything the driver must know (optional)</label><input type="text" id="pk-note" placeholder="e.g. 3rd floor, no lift; gate code 1234">
    <div class="actions" style="margin-top:12px"><button class="btn" id="pk-go">${dv ? 'Change my day' : 'Ask for this day'}</button></div><p class="err" id="pk-err"></p></div>`;
}

function quoteHtml(v) {
  const state = v.accepted ? `<span class="pill">Accepted</span>` : v.state === 'open' ? `<span class="pill warn">Valid until ${day(v.validUntil)}</span>` : v.state === 'used' ? `<span class="pill">Ordered${v.usedAs ? ' · ' + esc(v.usedAs.docNo) : ''}</span>` : `<span class="pill off">${v.state === 'expired' ? 'Expired' : 'Withdrawn'}</span>`;
  const sign = !v.accepted && v.state === 'open' ? `<div class="card no-print" id="acc"><h3>Accept this quotation</h3>
      <p class="muted">Sign below to accept it. The shop then contacts you to take the deposit and place the order.</p>
      <label for="acc-name">Your name</label><input type="text" id="acc-name" autocomplete="name" value="">
      ${padHtml('acc-pad')}
      <div class="actions"><button class="btn" id="acc-go">Accept and sign</button></div><p class="err" id="acc-err"></p></div>`
    : v.accepted ? `<div class="card"><h3>Accepted</h3><p>Accepted and signed by <strong>${esc(v.accepted.name)}</strong> on ${day(v.accepted.at)}. The shop will contact you about the deposit.</p></div>` : '';
  return `<div class="card"><h3>Quotation</h3><h2>${esc(v.docNo)}</h2><p>${v.name ? 'Hi ' + esc(v.name) + ' · ' : ''}${state}</p>${v.note ? `<p class="muted">${esc(v.note)}</p>` : ''}</div>
    <div class="card"><h3>Items</h3>${items(v.lines)}
      <div class="row tot"><span>Total</span><span>${esc(money(v.totalCents))}</span></div>
      ${v.vatRegistered ? `<div class="row"><span class="muted">Includes VAT</span><span class="muted">${esc(money(v.vatCents))}</span></div>` : ''}
      <p class="muted">Prices include VAT. Made-to-order items are built once the order is placed and the deposit paid.</p></div>
    ${sign}
    <div class="actions no-print"><button class="btn ghost" onclick="window.print()">Print</button></div>`;
}

function render(v) {
  document.title = (v.kind === 'quote' ? 'Quotation ' : 'Order ') + v.docNo + ' · ' + v.shop.name;
  app.innerHTML = shopHead(v.shop) + (v.kind === 'quote' ? quoteHtml(v) : orderHtml(v));
  const pk = document.getElementById('pick');
  if (pk) {
    pk.addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (b) { pick.date = b.dataset.day; pick.slot = ''; render(v); } });
    pk.addEventListener('change', (e) => { if (e.target.name === 'pk-kind') { pick.kind = e.target.value; render(v); } if (e.target.name === 'pk-slot') { pick.slot = e.target.value; pk.querySelectorAll('.slot').forEach(x => x.classList.toggle('on', x.querySelector('input').checked)); } });
    document.getElementById('pk-go').addEventListener('click', async (e) => {
      const err = document.getElementById('pk-err'); err.textContent = '';
      if (!pick.slot) { err.textContent = 'Pick a time slot.'; return; }
      const val = (id) => (document.getElementById(id) || {}).value || '';
      e.target.disabled = true;
      try { pick.date = pick.date || (v.slots[0] || {}).date; render(await call('pickSlot', { kind: pick.kind, date: pick.date, slot: pick.slot, address: { line1: val('pk-1'), line2: val('pk-2'), city: val('pk-3') }, note: val('pk-note') })); window.scrollTo(0, 0); }
      catch (x) { err.textContent = x.message; e.target.disabled = false; }
    });
  }
  const go = document.getElementById('acc-go');
  if (go) {
    const pad = wirePad(document.getElementById('acc-pad'));
    go.addEventListener('click', async () => {
      const err = document.getElementById('acc-err'); err.textContent = '';
      const name = document.getElementById('acc-name').value.trim();
      if (!name) { err.textContent = 'Your name, as you sign.'; return; }
      if (pad.isEmpty()) { err.textContent = 'Sign in the box.'; return; }
      go.disabled = true;
      try { render(await call('accept', { name, signature: pad.dataUrl() })); window.scrollTo(0, 0); }
      catch (e) { err.textContent = e.message; go.disabled = false; }
    });
  }
}

(async () => {
  if (!t) { app.innerHTML = '<div class="center">This link is not complete: ask the shop to send it again.</div>'; return; }
  try { render(await call('view')); }
  catch (e) { app.innerHTML = `<div class="center">${esc(e.message)}</div>`; }
})();
