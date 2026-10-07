// Scan out — the loading door. A couch leaves the factory when its job-card
// QR is scanned (phone camera app, or the scanner here), or when it is picked
// from the Ready list. Dispatching stamps who sent it and when, then offers
// a one-tap WhatsApp or email to the customer, and the order drops into the
// invoice queue.
import * as store from './store.js';
import { allOrders, orderById, setStatus } from './orders.js';
import { customerById } from './customers.js';
import { esc, openModal, toast, niceDate, today, money, empty } from './ui.js';
import { orderIdFromCode } from './qr.js';

let settings = {};
export const setScanSettings = (cfg) => { settings = cfg || {}; };

// ------------------------------------------------------------- finding ------

export function findOrderByCode(raw) {
  const id = orderIdFromCode(raw);
  const byId = orderById(id);
  if (byId) return byId;
  const key = String(raw || '').trim().toLowerCase().replace(/^#/, '');
  return allOrders().find(o => String(o.orderNo || '').toLowerCase() === key
    || String(o.orderNo || '').toLowerCase() === (settings.orderPrefix || 'cp-').toLowerCase() + key) || null;
}

// ------------------------------------------------------------- dispatch -----

export function confirmDispatch(id) {
  const o = orderById(id);
  if (!o) { toast('No order found for that code', 'warn'); return; }
  const c = customerById(o.customerId) || {};
  const cur = settings.currency || 'R';
  if (o.status === 'dispatched' || o.status === 'invoiced') {
    openModal('Already dispatched', `
      <div class="scan-hit">
        <div class="scan-no">${esc(o.orderNo || '')}</div>
        <h2>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</h2>
        <p>${esc(o.customerName || '')}</p>
        <p class="muted">Left the factory ${esc(niceDate(o.dispatchedAt))}${o.dispatchedBy ? ' · sent out by ' + esc(o.dispatchedBy) : ''}${o.status === 'invoiced' ? ' · invoiced' : ''}.</p>
      </div>`, { okLabel: 'Close', cancelLabel: '', onOk: () => true });
    return;
  }
  const notReady = o.status !== 'ready';
  openModal('Dispatch this piece?', `
    <div class="scan-hit">
      <div class="scan-no">${esc(o.orderNo || '')}</div>
      <h2>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</h2>
      ${o.fabric ? `<p>${esc(o.fabric)}</p>` : ''}
      <p>${esc(o.customerName || '')}${o.externalRef ? ' · their ref ' + esc(o.externalRef) : ''}</p>
      ${c.address || c.area ? `<p>${esc([c.address, c.area].filter(Boolean).join(', '))}</p>` : ''}
      ${o.priceEach ? `<p class="muted">${esc(money(o.priceEach * (o.qty || 1), cur))} to invoice</p>` : ''}
      ${notReady ? `<div class="notice-inline">This order is not marked Done yet (it is <strong>${esc(o.status)}</strong>). Dispatching it anyway will mark it done.</div>` : ''}
    </div>`, {
    okLabel: 'Yes, it has left',
    onOk: async () => {
      await setStatus(id, 'dispatched');
      setTimeout(() => notifyCustomer(id), 80);
    }
  });
}

// ---------------------------------------------------------- notification ----

function digits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '27' + d.slice(1);
  return d;
}

export function messageFor(o) {
  const c = customerById(o.customerId) || {};
  const who = c.contact || c.name || o.customerName || '';
  const item = (o.product || 'your order') + ((o.qty || 1) > 1 ? ' × ' + o.qty : '');
  return `Hi ${who}, good news: ${item} (order ${o.orderNo || ''}) left the ${settings.name || 'Couch Potato'} factory today, ${niceDate(today())}.`
    + (settings.phone ? ` Any questions, call us on ${settings.phone}.` : '') + ` — ${settings.name || 'Couch Potato'}`;
}

export function notifyCustomer(id) {
  const o = orderById(id);
  if (!o) return;
  const c = customerById(o.customerId) || {};
  const msg = messageFor(o);
  const wa = digits(c.phone);
  const subject = encodeURIComponent((settings.name || 'Couch Potato') + ' — order ' + (o.orderNo || '') + ' dispatched');
  const m = openModal('Tell the customer', `
    <p class="muted" style="margin-bottom:.6rem">${esc(o.orderNo || '')} is marked dispatched${o.dispatchedBy ? ' by ' + esc(o.dispatchedBy) : ''}. Send ${esc(c.name || o.customerName || 'the customer')} the news:</p>
    <textarea id="nt-msg" rows="4" style="width:100%; font:inherit; font-size:14px; padding:.6rem; border:1px solid #d6d3d1; border-radius:10px">${esc(msg)}</textarea>
    <div class="notify-btns">
      ${wa ? `<a class="btn primary" target="_blank" rel="noopener" id="nt-wa" href="https://wa.me/${wa}?text=${encodeURIComponent(msg)}">WhatsApp ${esc(c.phone)}</a>` : '<span class="muted">No phone number on this customer.</span>'}
      ${c.email ? `<a class="btn" target="_blank" rel="noopener" id="nt-em" href="mailto:${esc(c.email)}?subject=${subject}&body=${encodeURIComponent(msg)}">Email ${esc(c.email)}</a>` : '<span class="muted">No email on this customer.</span>'}
      <button type="button" class="btn ghost" id="nt-copy">Copy message</button>
    </div>
    ${o.notifiedAt ? `<p class="muted">Already notified ${esc(niceDate(o.notifiedAt))} via ${esc(o.notifiedVia || '')}.</p>` : ''}`,
    { okLabel: 'Done', cancelLabel: '', onOk: () => true });
  const card = m.wrap.querySelector('.modal-card');
  const ta = card.querySelector('#nt-msg');
  const refresh = () => {
    const t = ta.value;
    const a = card.querySelector('#nt-wa'); if (a) a.href = 'https://wa.me/' + wa + '?text=' + encodeURIComponent(t);
    const e = card.querySelector('#nt-em'); if (e) e.href = 'mailto:' + (c.email || '') + '?subject=' + subject + '&body=' + encodeURIComponent(t);
  };
  ta.addEventListener('input', refresh);
  const mark = (via) => store.update('orders', id, { notifiedAt: store.nowIso(), notifiedVia: via }, 'Customer notified via ' + via);
  const wab = card.querySelector('#nt-wa'); if (wab) wab.addEventListener('click', () => mark('WhatsApp'));
  const emb = card.querySelector('#nt-em'); if (emb) emb.addEventListener('click', () => mark('email'));
  card.querySelector('#nt-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ta.value); toast('Message copied'); mark('copied message'); }
    catch (e) { ta.select(); toast('Select the text and copy it', 'warn'); }
  });
}

// ---------------------------------------------------------------- camera ----

let stream = null, timer = null, detector = null;

export async function startCamera(host) {
  const video = host.querySelector('#scan-video');
  const msg = host.querySelector('#scan-msg');
  if (!video) return;
  if (!('BarcodeDetector' in window)) {
    msg.innerHTML = 'This browser cannot read QR codes inside the app. Use the phone’s own <strong>camera app</strong> on the job-card code instead — it opens this page on the right order — or type the order number below.';
    return;
  }
  try {
    detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
    host.querySelector('#scan-start').hidden = true;
    host.querySelector('#scan-stop').hidden = false;
    video.hidden = false;
    msg.textContent = 'Point the camera at the QR code on the job card.';
    timer = setInterval(async () => {
      if (!detector || video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          const o = findOrderByCode(codes[0].rawValue);
          stopCamera(host);
          if (o) confirmDispatch(o.id); else toast('That code is not one of our orders', 'warn');
        }
      } catch (e) { /* a frame failed to decode — keep going */ }
    }, 350);
  } catch (e) {
    msg.textContent = 'Could not open the camera: ' + (e && e.message ? e.message : e) + '. Type the order number below instead.';
  }
}

export function stopCamera(host) {
  if (timer) { clearInterval(timer); timer = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  detector = null;
  const h = host || document;
  const video = h.querySelector('#scan-video'); if (video) { video.hidden = true; video.srcObject = null; }
  const s = h.querySelector('#scan-start'); if (s) s.hidden = false;
  const x = h.querySelector('#scan-stop'); if (x) x.hidden = true;
}

export function manualFind(host) {
  const inp = host.querySelector('#scan-manual');
  const o = findOrderByCode(inp.value);
  if (!o) { toast('No order ' + inp.value.trim() + ' found', 'warn'); return; }
  inp.value = '';
  confirmDispatch(o.id);
}

// ---------------------------------------------------------------- render ----

export function renderScan(host) {
  const cur = settings.currency || 'R';
  const rows = allOrders();
  const ready = rows.filter(o => o.status === 'ready').sort((a, b) => String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  const t = today();
  const todayOut = rows.filter(o => (o.status === 'dispatched' || o.status === 'invoiced') && String(o.dispatchedAt || '').slice(0, 10) === t)
    .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')));
  const toInvoice = rows.filter(o => o.status === 'dispatched' && !o.invoiceId);
  const tile = (n, label, cls) => `<div class="tile ${cls || ''}"><div class="tile-n">${n}</div><div class="tile-l">${esc(label)}</div></div>`;
  const line = (o, action) => `
    <div class="card scan-row">
      <div>
        <div class="order-no">${esc(o.orderNo || '')}</div>
        <strong>${esc(o.product || '')}${(o.qty || 1) > 1 ? ' × ' + esc(o.qty) : ''}</strong>
        <div class="muted">${esc(o.customerName || '')}${o.fabric ? ' · ' + esc(o.fabric) : ''}${o.dispatchedAt ? ' · out ' + esc(String(o.dispatchedAt).slice(11, 16)) + (o.dispatchedBy ? ' by ' + esc(o.dispatchedBy) : '') : ''}${o.notifiedAt ? ' · ✓ customer told' : ''}</div>
      </div>
      <div class="btn-row">${action}</div>
    </div>`;
  host.innerHTML = `
    <div class="page-head"><div><h1>Scan out</h1><p class="sub">Scan the job card at the door, or pick from the Done list</p></div></div>
    <div class="tiles">
      ${tile(ready.length, 'Done, to go out', ready.length ? 'amber' : '')}
      ${tile(todayOut.length, 'Dispatched today')}
      ${tile(toInvoice.length, 'Awaiting invoice', toInvoice.length ? 'amber' : '')}
      <div class="tile wide"><div class="tile-n">${esc(money(toInvoice.reduce((s, o) => s + (Number(o.priceEach) || 0) * (o.qty || 1), 0), cur))}</div><div class="tile-l">Dispatched, not yet invoiced</div></div>
    </div>
    <div class="card scan-cam">
      <div class="scan-cam-grid">
        <div>
          <h2>Scanner</h2>
          <p id="scan-msg" class="muted">Start the camera and point it at the QR code on the job card. Any phone’s own camera app works too — the code opens this page on the right order.</p>
          <video id="scan-video" playsinline muted hidden></video>
          <div class="btn-row" style="margin-top:.5rem">
            <button class="btn primary" id="scan-start" data-act="scan-start">Start camera</button>
            <button class="btn" id="scan-stop" data-act="scan-stop" hidden>■ Stop</button>
          </div>
        </div>
        <div>
          <h2>Or type the order number</h2>
          <div class="btn-row">
            <input id="scan-manual" placeholder="e.g. CP-1003" style="flex:1 1 160px; font:inherit; font-size:15px; padding:.6rem .7rem; border:1px solid #d6d3d1; border-radius:10px" onkeydown="if(event.key==='Enter'){event.preventDefault(); this.closest('.scan-cam').querySelector('[data-act=scan-find]').click()}">
            <button class="btn" data-act="scan-find">Find</button>
          </div>
        </div>
      </div>
    </div>
    <h2 class="cat">Done, waiting to go out (${ready.length})</h2>
    ${ready.length ? ready.map(o => line(o, `<button class="btn primary sm" data-act="dispatch" data-id="${esc(o.id)}">Dispatch</button>`)).join('')
      : '<div class="card muted">Nothing is marked Done on the floor.</div>'}
    <h2 class="cat">Dispatched today (${todayOut.length})</h2>
    ${todayOut.length ? todayOut.map(o => line(o, `<button class="btn ghost sm" data-act="notify" data-id="${esc(o.id)}">Tell customer</button>`)).join('')
      : '<div class="card muted">Nothing has gone out yet today.</div>'}
    ${toInvoice.length ? `<p class="muted" style="margin-top:.8rem">${toInvoice.length} dispatched order${toInvoice.length === 1 ? '' : 's'} waiting under <strong>Invoices</strong>.</p>` : ''}`;
}
