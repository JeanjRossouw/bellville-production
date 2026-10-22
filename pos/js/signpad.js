// Retail POS — a signature drawn with a finger or mouse on a canvas: the
// lay-by agreement, a delivery note, a collection slip. The strokes become
// a small PNG data URL kept on the document.
export const padHtml = (id, h = 150) => `<div class="sign-wrap"><canvas id="${id}" class="sign-pad" height="${h}"></canvas><div class="sign-foot"><span class="muted">Sign in the box</span><button type="button" class="btn ghost sm" data-sign-clear="${id}">Clear</button></div></div>`;

// wire a canvas after it is in the page: returns { isEmpty(), dataUrl(), clear() }
export function wirePad(c) {
  const scale = window.devicePixelRatio || 1;
  const cssH = Number(c.getAttribute('height')) || 150;
  const cssW = c.clientWidth || 400;
  c.width = Math.round(cssW * scale); c.height = Math.round(cssH * scale);
  c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
  const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, strokes = 0;
  const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener('pointerdown', (e) => { e.preventDefault(); c.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y); ctx.stroke(); drawing = true; strokes++; });
  c.addEventListener('pointermove', (e) => { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
  const up = () => { drawing = false; };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  const clear = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.restore(); strokes = 0; };
  const btn = c.parentElement && c.parentElement.querySelector('[data-sign-clear]'); if (btn) btn.addEventListener('click', clear);
  return { isEmpty: () => strokes === 0, dataUrl: () => strokes ? c.toDataURL('image/png') : '', clear };
}
