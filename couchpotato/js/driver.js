// The driver's page: opened from a private link (?driver=<company>.<code>),
// no login, big buttons, and every message to the client or the shop written
// for them and opened in WhatsApp, so they only press Send.
import * as store from './store.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wa = (phone) => { let d = String(phone || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '27' + d.slice(1); return d; };
const first = (n) => String(n || '').split(' ')[0] || 'there';

let code = '';
let data = null;
let dayOffset = 0;      // 0 today, 1 tomorrow

export async function startDriverPage(d) {
  code = d;
  document.title = 'Deliveries';
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.className = 'drv';
  await load();
}

async function load(msg) {
  const app = document.getElementById('app');
  if (!data) app.innerHTML = `<div class="drv-head"><div class="drv-co">Deliveries</div></div><div class="drv-body"><div class="drv-empty">Loading your list…</div></div>`;
  try {
    data = await store.driverLoad(code, store.localDate(new Date(Date.now() + dayOffset * 86400000)));
    render();
    if (msg) flash(msg);
  } catch (e) {
    app.innerHTML = `<div class="drv-head"><div class="drv-co">Deliveries</div></div><div class="drv-body"><div class="drv-empty">${esc(e.message)}</div>
      <button class="drv-btn dark" onclick="location.reload()">Try again</button></div>`;
  }
}

function flash(msg) {
  const t = document.createElement('div'); t.className = 'drv-flash'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

const btn = (label, act, cls, extra) => `<button class="drv-btn ${cls || ''}" data-a="${act}" ${extra || ''}>${label}</button>`;

function render() {
  const app = document.getElementById('app');
  const { driver, company, stops, date } = data;
  const open = stops.filter(s => !s.deliveredAt), done = stops.filter(s => s.deliveredAt);
  const nice = new Date(date + 'T00:00:00').toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
  const card = (s, i) => {
    const maps = s.address ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s.address) : '';
    const st = s.driverStatus === 'on-way' ? 'On the way' : s.driverStatus === 'late' ? 'Running late' + (s.driverNote ? ' · ' + s.driverNote : '') : s.driverStatus === 'issue' ? 'Problem' + (s.driverNote ? ': ' + s.driverNote : '') : '';
    return `<div class="drv-card ${s.deliveredAt ? 'done' : ''}" data-id="${esc(s.id)}">
      <div class="drv-stop">STOP ${i + 1}${s.slot ? ' · ' + esc(s.slot) : ''}${st ? `<span class="drv-st">${esc(st)}</span>` : ''}</div>
      <div class="drv-prod">${esc(s.product)}${Number(s.qty) > 1 ? ' × ' + esc(s.qty) : ''}</div>
      <div class="drv-who">${esc(s.customer)}</div>
      <div class="drv-addr">${s.address ? esc(s.address) : '<span class="drv-warn">No address — ask the office</span>'}</div>
      ${s.instructions ? `<div class="drv-note">${esc(s.instructions)}</div>` : ''}
      ${s.deliveredAt ? `<div class="drv-ok">✓ Delivered ${esc(String(s.deliveredAt).slice(11, 16))}${s.signedBy ? ' · signed by ' + esc(s.signedBy) : ''}</div>` : `
      <div class="drv-grid">
        ${maps ? `<a class="drv-btn" href="${maps}" target="_blank" rel="noopener">Navigate</a>` : ''}
        ${btn('On my way', 'onway', 'blue')}
        ${btn('Running late', 'late', 'amber')}
        ${btn('Delivered', 'deliver', 'green')}
        ${btn('Problem', 'problem', 'red')}
        ${s.phone ? `<a class="drv-btn" href="tel:${wa(s.phone)}">Call client</a>` : ''}
      </div>
      <div class="drv-menu" hidden></div>
      <div class="drv-hint">${s.phone ? 'The buttons open WhatsApp with the message ready. Just press Send.' : 'No cell number for this client.'}</div>`}
    </div>`;
  };
  app.innerHTML = `
    <div class="drv-head">
      <div class="drv-co">${esc(company.name || 'Deliveries')}</div>
      <div class="drv-hi">Hi ${esc(driver.name)}</div>
      <div class="drv-date">${esc(nice)}</div>
      <div class="drv-days"><button data-a="day0" class="${dayOffset === 0 ? 'on' : ''}">Today</button><button data-a="day1" class="${dayOffset === 1 ? 'on' : ''}">Tomorrow</button></div>
    </div>
    <div class="drv-body">
      <div class="drv-tiles"><div><strong>${open.length}</strong>TO DO</div><div><strong>${done.length}</strong>DONE</div>
        ${company.phone ? `<a class="drv-shop" href="https://wa.me/${wa(company.phone)}?text=${encodeURIComponent("Hi, it's " + driver.name + ' (driver). ')}" target="_blank" rel="noopener">Message the office</a>` : ''}</div>
      ${stops.length ? '' : `<div class="drv-empty">Nothing on your list ${dayOffset ? 'tomorrow' : 'today'}.<br><small>The office sends your stops when they are planned.</small></div>`}
      ${open.map(card).join('')}
      ${done.length ? `<div class="drv-sec">DONE</div>${done.map((s, i) => card(s, open.length + i)).join('')}` : ''}
      <button class="drv-btn" data-a="refresh" style="margin-top:12px">Refresh the list</button>
    </div>`;
  app.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', onTap));
}

async function act(stopId, payload, msg) {
  try { await store.driverAct(code, { orderId: stopId, ...payload }); await load(msg); }
  catch (e) { alert(e.message); }
}

function openWa(phone, text) { if (phone) window.open('https://wa.me/' + wa(phone) + '?text=' + encodeURIComponent(text), '_blank'); }

function onTap(e) {
  const b = e.currentTarget;
  const a = b.dataset.a;
  if (a === 'refresh') return load('List updated');
  if (a === 'day0' || a === 'day1') { dayOffset = a === 'day1' ? 1 : 0; return load(); }
  const cardEl = b.closest('.drv-card');
  const s = data.stops.find(x => x.id === (cardEl && cardEl.dataset.id)); if (!s) return;
  const co = data.company.name || '';
  const menu = cardEl.querySelector('.drv-menu');
  if (a === 'onway') {
    openWa(s.phone, `Hi ${first(s.customer)}, ${co} here. I am on my way with your ${s.product}, about 30 to 45 minutes. See you soon!`);
    return act(s.id, { action: 'status', status: 'on-way' }, 'Marked: on the way');
  }
  if (a === 'late') {
    menu.hidden = false;
    menu.innerHTML = `<div class="drv-q">How late?</div><div class="drv-grid">${['15 min', '30 min', '1 hour'].map(m => `<button class="drv-btn amber" data-late="${m}">${m}</button>`).join('')}
      <button class="drv-btn" data-late="tomorrow">Not today</button></div>`;
    menu.querySelectorAll('[data-late]').forEach(x => x.addEventListener('click', () => {
      const m = x.dataset.late;
      openWa(s.phone, m === 'tomorrow'
        ? `Hi ${first(s.customer)}, ${co} here. I am sorry, we cannot make your delivery today. The office will contact you to arrange a new time.`
        : `Hi ${first(s.customer)}, ${co} here. I am running about ${m} late with your ${s.product}. Sorry for the wait!`);
      act(s.id, { action: 'status', status: m === 'tomorrow' ? 'issue' : 'late', note: m === 'tomorrow' ? 'cannot make it today' : m }, 'Client told');
    }));
    return;
  }
  if (a === 'problem') {
    menu.hidden = false;
    menu.innerHTML = `<div class="drv-q">What is wrong? (the office gets told)</div><div class="drv-grid">${['Nobody home', 'Wrong address', 'Does not fit', 'Damaged'].map(m => `<button class="drv-btn red" data-p="${m}">${m}</button>`).join('')}</div>`;
    menu.querySelectorAll('[data-p]').forEach(x => x.addEventListener('click', () => {
      openWa(data.company.phone, `Problem at ${s.orderNo} (${s.customer}): ${x.dataset.p.toLowerCase()}. — ${data.driver.name}`);
      act(s.id, { action: 'status', status: 'issue', note: x.dataset.p.toLowerCase() }, 'Office told');
    }));
    return;
  }
  if (a === 'deliver') return signScreen(s);
}

// ------------------------------------------------------- client signs here --

function signScreen(s) {
  const v = document.createElement('div');
  v.className = 'drv-sign';
  const dateTxt = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  v.innerHTML = `<div class="drv-sign-in">
    <div class="drv-note-head"><div><strong>${esc((data.company.name || '').toUpperCase())}</strong><br><small>DELIVERY NOTE</small></div><div class="r"><strong>${esc(s.orderNo)}</strong><br><small>${esc(dateTxt)}</small></div></div>
    <table class="drv-note-tbl"><tr><th>ITEM</th><td>${esc(s.product)}${Number(s.qty) > 1 ? ' × ' + esc(s.qty) : ''}${s.fabric ? '<br>' + esc(s.fabric) : ''}</td></tr>
      <tr><th>DELIVERED TO</th><td>${esc(s.customer)}<br>${esc(s.address)}</td></tr><tr><th>DRIVER</th><td>${esc(data.driver.name)}</td></tr></table>
    <p>I confirm I have received the item(s) above <strong>in good order</strong>.</p>
    <label class="drv-lbl">NAME</label><input id="sg-name" value="${esc(s.customer)}">
    <label class="drv-lbl">SIGN IN THE BOX WITH YOUR FINGER</label>
    <canvas id="sg-pad"></canvas>
    <div class="drv-grid">
      <button class="drv-btn" id="sg-clear">Clear</button>
      <button class="drv-btn" id="sg-cancel">Cancel</button>
      <button class="drv-btn green wide" id="sg-save">Save signature</button>
    </div>
    <button class="drv-btn" id="sg-nosign" style="margin-top:8px">Delivered without a signature</button>
  </div>`;
  document.body.appendChild(v);
  const c = v.querySelector('#sg-pad');
  const scale = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * scale); c.height = Math.round(220 * scale);
  const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, strokes = 0;
  const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.onpointerdown = (e) => { e.preventDefault(); c.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); drawing = true; };
  c.onpointermove = (e) => { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); strokes++; };
  c.onpointerup = c.onpointercancel = () => { drawing = false; };
  v.querySelector('#sg-clear').onclick = () => { ctx.clearRect(0, 0, c.width, c.height); strokes = 0; };
  v.querySelector('#sg-cancel').onclick = () => v.remove();
  const done = async (signedBy, dataUrl) => {
    v.remove();
    await act(s.id, { action: 'delivered', signedBy, dataUrl }, 'Delivered' + (dataUrl ? ' and signed' : ''));
    // thank the client
    if (s.phone && confirm('Send ' + first(s.customer) + ' a WhatsApp that it is delivered?')) openWa(s.phone, `Hi ${first(s.customer)}, your ${s.product} has been delivered${signedBy ? ' and signed for by ' + signedBy : ''}. Thank you for choosing ${data.company.name || 'us'} — enjoy!`);
  };
  v.querySelector('#sg-nosign').onclick = () => { if (confirm('Mark as delivered without the client signing?')) done('', ''); };
  v.querySelector('#sg-save').onclick = () => {
    if (strokes < 5) { alert('Ask the client to sign in the box first.'); return; }
    const name = v.querySelector('#sg-name').value.trim() || s.customer;
    done(name, compose(s, name, c));
  };
}

// The note and the signature as one picture, like a photographed paper note.
function compose(s, name, pad) {
  const W = 1000, H = 1250, out = document.createElement('canvas'); out.width = W; out.height = H;
  const x = out.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#111';
  const now = new Date();
  x.font = '900 40px Arial'; x.fillText(String(data.company.name || '').toUpperCase(), 60, 100);
  x.font = '400 20px Arial'; x.fillText('DELIVERY NOTE', 60, 135);
  x.textAlign = 'right'; x.font = '900 40px Arial'; x.fillText(s.orderNo || '', W - 60, 100);
  x.font = '400 22px Arial'; x.fillText(now.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + now.toTimeString().slice(0, 5), W - 60, 135); x.textAlign = 'left';
  x.fillRect(60, 160, W - 120, 4);
  let y = 230;
  const rowTxt = (k, v) => { x.font = '700 20px Arial'; x.fillStyle = '#555'; x.fillText(k, 60, y); x.fillStyle = '#111'; x.font = '400 28px Arial'; String(v).split('\n').forEach(l => { x.fillText(l, 300, y); y += 38; }); y += 14; };
  rowTxt('ITEM', (s.product || '') + (Number(s.qty) > 1 ? ' × ' + s.qty : '') + (s.fabric ? '\n' + s.fabric : ''));
  rowTxt('DELIVERED TO', (s.customer || '') + '\n' + (s.address || ''));
  rowTxt('DRIVER', data.driver.name || '');
  y += 10; x.font = '400 26px Arial'; x.fillText('I confirm I have received the item(s) above in good order.', 60, y); y += 60;
  x.font = '700 20px Arial'; x.fillStyle = '#555'; x.fillText('NAME', 60, y); x.fillStyle = '#111'; x.font = '400 30px Arial'; x.fillText(name, 300, y); y += 50;
  x.font = '700 20px Arial'; x.fillStyle = '#555'; x.fillText('SIGNATURE', 60, y);
  const sw = W - 120, sh = Math.round(sw * (220 / Math.max(1, pad.clientWidth)));
  x.strokeStyle = '#999'; x.lineWidth = 2; x.strokeRect(60, y + 20, sw, sh);
  x.drawImage(pad, 60, y + 20, sw, sh);
  return out.toDataURL('image/jpeg', 0.8);
}
