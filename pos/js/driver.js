// Retail POS — the driver's page (driver.html?d=…): the deliveries given to them, a map link and a call
// button for each, "On the way" (a WhatsApp to the client, sent from the driver's phone), the client's
// signature on delivery, and "Problem" when it cannot be delivered. Talks only to pos-driver.mjs.
import { padHtml, wirePad } from './signpad.js';

const FN = '/.netlify/functions/pos-driver';
const d = new URLSearchParams(location.search).get('d') || '';
const app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const day = (iso) => { if (iso === today()) return 'Today'; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ''; };
const waDigits = (p) => { let x = String(p || '').replace(/\D/g, ''); if (x.startsWith('0')) x = '27' + x.slice(1); return x; };
let data = null, open = '';   // the stop being signed for

async function call(action, body = {}) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, d, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again in a minute.');
  return j;
}

function stopHtml(s) {
  const map = s.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}` : '';
  return `<div class="stop" data-stop="${esc(s.id)}">
    <h3>${esc(day(s.date))}${s.slot ? ' · ' + esc(s.slot) : ''} · ${esc(s.docNo)}</h3>
    <h2>${esc(s.name)}</h2>
    <p>${esc(s.address)}${s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ''}</p>
    <p class="muted">${s.items.map(esc).join('<br>')}</p>
    ${s.issue ? `<p class="err">Problem reported: ${esc(s.issue.note)}</p>` : ''}
    <div class="actions">
      ${map ? `<a class="btn ghost" href="${map}" target="_blank" rel="noopener">Map</a>` : ''}
      ${s.phone ? `<a class="btn ghost" href="tel:${esc(s.phone.replace(/\s/g, ''))}">Call</a>` : ''}
      <button class="btn ghost" data-way="${esc(s.id)}">${s.onTheWayAt ? 'On the way ✓' : 'On the way'}</button>
      <button class="btn" data-sign="${esc(s.id)}">Delivered</button>
      <button class="btn ghost" data-issue="${esc(s.id)}">Problem</button>
    </div>
    ${open === s.id ? `<div class="card" style="margin-top:12px"><h3>The client signs</h3>
      <label for="sg-name">Received by</label><input type="text" id="sg-name" value="${esc(s.name)}">
      ${padHtml('sg-pad')}
      <label for="sg-note">Note (optional)</label><input type="text" id="sg-note" placeholder="e.g. left with the neighbour">
      <div class="actions" style="margin-top:10px"><button class="btn big" id="sg-go">Delivered and signed</button></div><p class="err" id="sg-err"></p></div>` : ''}
  </div>`;
}

function render(msg) {
  const v = data;
  app.innerHTML = `<div class="shop"><div><h1>${esc(v.shop.name)}</h1><div class="sub">Deliveries · ${esc(v.driver.name)}</div></div><div class="actions"><button class="btn ghost sm" id="reload">Refresh</button></div></div>
    ${msg ? `<div class="card"><p>${esc(msg)}</p></div>` : ''}
    <div class="card"><h3>To deliver (${v.stops.length})</h3>${v.stops.length ? v.stops.map(stopHtml).join('') : '<p class="muted">Nothing to deliver right now.</p>'}</div>
    ${v.done.length ? `<div class="card"><h3>Delivered today (${v.done.length})</h3>${v.done.map(s => `<div class="row"><span>${esc(s.docNo)} · ${esc(s.name)}</span><span class="pill">Delivered</span></div>`).join('')}</div>` : ''}`;
  const pad = document.getElementById('sg-pad');
  if (pad) {
    const p = wirePad(pad);
    document.getElementById('sg-go').addEventListener('click', async (e) => {
      const err = document.getElementById('sg-err'); err.textContent = '';
      const signedBy = document.getElementById('sg-name').value.trim();
      if (!signedBy) { err.textContent = 'Who received it?'; return; }
      if (p.isEmpty()) { err.textContent = 'The client signs in the box.'; return; }
      e.target.disabled = true;
      try { await call('delivered', { orderId: open, signedBy, signature: p.dataUrl(), note: document.getElementById('sg-note').value.trim() }); open = ''; await load('Delivered and signed. The shop sees it now.'); }
      catch (x) { err.textContent = x.message; e.target.disabled = false; }
    });
  }
}

app.addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.id === 'reload') return load();
  if (t.dataset.sign) { open = open === t.dataset.sign ? '' : t.dataset.sign; render(); const s = document.querySelector(`[data-stop="${t.dataset.sign}"]`); if (s) s.scrollIntoView({ behavior: 'smooth' }); return; }
  if (t.dataset.way) {
    const w = window.open('', '_blank');   // opened now, while the tap counts, so the phone does not block it
    try { const r = await call('onTheWay', { orderId: t.dataset.way }); const url = `https://wa.me/${waDigits(r.phone)}?text=${encodeURIComponent(r.text)}`; if (w) w.location = url; else location.href = url; await load(); }
    catch (x) { if (w) w.close(); alert(x.message); }
    return;
  }
  if (t.dataset.issue) {
    const note = prompt('What went wrong? (the shop sees this)'); if (!note) return;
    try { await call('issue', { orderId: t.dataset.issue, note }); await load('Problem sent to the shop.'); } catch (x) { alert(x.message); }
  }
});

async function load(msg) {
  try { data = await call('run'); render(msg); }
  catch (x) { app.innerHTML = `<div class="center">${esc(x.message)}</div>`; }
}
if (!d) app.innerHTML = '<div class="center">This link is not complete: ask the shop for yours.</div>';
else load();
