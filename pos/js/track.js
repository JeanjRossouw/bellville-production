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
  const when = v.done ? `${v.status === 'collected' ? 'Collected' : 'Delivered'} on ${day(v.completedAt)}${v.invoiceNo ? ' · tax invoice ' + esc(v.invoiceNo) : ''}`
    : dv ? `${dv.kind === 'collect' ? 'Collection' : 'Delivery'} booked for <strong>${day(dv.date)}</strong>${dv.slot ? ' · ' + esc(dv.slot) : ''}`
    : v.expectedAt && !v.cancelled ? `Expected by <strong>${day(v.expectedAt)}</strong>` : '';
  return `<div class="card"><h3>Your order</h3><h2>${esc(v.docNo)}</h2>
      <p>${v.name ? 'Hi ' + esc(v.name) + ', ' : ''}${head}</p>${when ? `<p>${when}</p>` : ''}
      ${!v.cancelled ? `<ol class="steps">${v.steps.map(s => `<li class="${s.done ? 'done' : ''}${s.current ? ' current' : ''}">${esc(s.label)}</li>`).join('')}</ol>` : ''}</div>
    <div class="card"><h3>What you ordered</h3>${items(v.lines)}</div>
    <div class="card"><h3>Payments</h3>
      <div class="row"><span>Total</span><strong>${esc(money(v.totalCents))}</strong></div>
      ${v.payments.map(p => `<div class="row"><span class="muted">Paid ${day(p.at)}</span><span>${esc(money(p.amountCents))}</span></div>`).join('')}
      <div class="row tot"><span>Balance</span><span class="${v.balanceCents > 0 ? 'owed' : ''}">${esc(money(v.balanceCents))}</span></div>
      ${v.minDepositCents > 0 ? `<p class="owed">A deposit of ${esc(money(v.minDepositCents))} starts your order.</p>` : ''}
      ${v.balanceCents > 0 && !v.cancelled && v.status !== 'quoted' ? `<p class="muted">The balance is paid before delivery or collection.</p>` : ''}</div>
    <p class="muted center no-print" style="padding:8px 0">This page updates as your order moves along: keep the link.</p>`;
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
