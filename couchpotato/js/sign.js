// The client signs the delivery note on the screen with a finger. Used by
// the driver's page and by the office (a collection, or the office tablet).
//
//   openSignScreen({ company, orderNo, product, qty, fabric, customer, address, by }, onDone)
//   onDone(signedBy, dataUrl) — dataUrl is the note and signature as one JPEG,
//   or '' when marked delivered without a signature.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openSignScreen(s, onDone) {
  const v = document.createElement('div');
  v.className = 'drv-sign';
  const dateTxt = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  v.innerHTML = `<div class="drv-sign-in">
    <div class="drv-note-head"><div><strong>${esc((s.company || '').toUpperCase())}</strong><br><small>DELIVERY NOTE</small></div><div class="r"><strong>${esc(s.orderNo)}</strong><br><small>${esc(dateTxt)}</small></div></div>
    <table class="drv-note-tbl"><tr><th>ITEM</th><td>${esc(s.product)}${Number(s.qty) > 1 ? ' × ' + esc(s.qty) : ''}${s.fabric ? '<br>' + esc(s.fabric) : ''}</td></tr>
      <tr><th>DELIVERED TO</th><td>${esc(s.customer)}<br>${esc(s.address)}</td></tr><tr><th>${s.byLabel || 'DRIVER'}</th><td>${esc(s.by)}</td></tr></table>
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
  const done = async (signedBy, dataUrl) => { v.remove(); await onDone(signedBy, dataUrl); };
  v.querySelector('#sg-nosign').onclick = () => { if (confirm('Mark as delivered without the client signing?')) done('', ''); };
  v.querySelector('#sg-save').onclick = () => {
    if (strokes < 5) { alert('Ask the client to sign in the box first.'); return; }
    const name = v.querySelector('#sg-name').value.trim() || s.customer;
    done(name, compose(s, name, c));
  };
}

// The note and the signature as one picture, like a photographed paper note.
export function compose(s, name, pad) {
  const W = 1000, H = 1250, out = document.createElement('canvas'); out.width = W; out.height = H;
  const x = out.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#111';
  const now = new Date();
  x.font = '900 40px Arial'; x.fillText(String(s.company || '').toUpperCase(), 60, 100);
  x.font = '400 20px Arial'; x.fillText('DELIVERY NOTE', 60, 135);
  x.textAlign = 'right'; x.font = '900 40px Arial'; x.fillText(s.orderNo || '', W - 60, 100);
  x.font = '400 22px Arial'; x.fillText(now.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + now.toTimeString().slice(0, 5), W - 60, 135); x.textAlign = 'left';
  x.fillRect(60, 160, W - 120, 4);
  let y = 230;
  const rowTxt = (k, v) => { x.font = '700 20px Arial'; x.fillStyle = '#555'; x.fillText(k, 60, y); x.fillStyle = '#111'; x.font = '400 28px Arial'; String(v).split('\n').forEach(l => { x.fillText(l, 300, y); y += 38; }); y += 14; };
  rowTxt('ITEM', (s.product || '') + (Number(s.qty) > 1 ? ' × ' + s.qty : '') + (s.fabric ? '\n' + s.fabric : ''));
  rowTxt('DELIVERED TO', (s.customer || '') + '\n' + (s.address || ''));
  rowTxt(s.byLabel || 'DRIVER', s.by || '');
  y += 10; x.font = '400 26px Arial'; x.fillText('I confirm I have received the item(s) above in good order.', 60, y); y += 60;
  x.font = '700 20px Arial'; x.fillStyle = '#555'; x.fillText('NAME', 60, y); x.fillStyle = '#111'; x.font = '400 30px Arial'; x.fillText(name, 300, y); y += 50;
  x.font = '700 20px Arial'; x.fillStyle = '#555'; x.fillText('SIGNATURE', 60, y);
  const sw = W - 120, sh = Math.round(sw * (220 / Math.max(1, pad.clientWidth)));
  x.strokeStyle = '#999'; x.lineWidth = 2; x.strokeRect(60, y + 20, sw, sh);
  x.drawImage(pad, 60, y + 20, sw, sh);
  return out.toDataURL('image/jpeg', 0.8);
}
