// Barcodes: drawing them on labels (Code 128) and reading them with the
// camera. A USB or Bluetooth scanner needs nothing from here: it types the
// code and presses Enter, which the till listens for (pos.js).
import { esc, money, openModal, toast } from './ui.js';

// Code 128 bar patterns: each value is 6 widths (bar, space, bar, …); the
// stop is 7. Values 0–102 are characters, 104 starts code set B, 106 stops.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

// The widths of a code in set B (printable ASCII), with its check value.
export function code128Widths(text) {
  const s = String(text || '');
  const vals = [104];
  for (const ch of s) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) throw new Error('A barcode can only hold plain letters, numbers and signs');
    vals.push(v);
  }
  const check = vals.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;
  vals.push(check, 106);
  return vals.map(v => PATTERNS[v]).join('');
}

// An SVG of the code, `h` units high, with the quiet zone either side.
export function barcodeSvg(text, h = 50) {
  const widths = code128Widths(text);
  const quiet = 10;
  let x = quiet, rects = '';
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]);
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="${h}"/>`;
    x += w;
  }
  const total = x + quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${total}" height="${h}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

// Our own codes for products that have none: 2 + 7 digits (the range shops
// use for in-store codes), one more than the highest already given out.
export function nextShopCode(products) {
  const used = (products || []).map(p => String(p.barcode || '')).filter(c => /^2\d{7}$/.test(c)).map(Number);
  const next = used.length ? Math.max(...used) + 1 : 20000001;
  return String(next);
}

// A sheet of sticky labels: name, price and barcode, `copies` of each.
export function labelSheetHtml(items, settings) {
  const cur = settings.currency || 'R';
  const vat = settings.vatRegistered ? (Number(settings.vatRate) || 0) : 0;
  const cells = [];
  items.forEach(({ p, copies }) => {
    for (let i = 0; i < (copies || 1); i++) {
      cells.push(`<div class="lbl"><div class="nm">${esc(p.name)}</div>
        <div class="pr">${esc(money((Number(p.sellingPrice) || 0) * (1 + vat), cur))}${vat ? ' <small>incl. VAT</small>' : ''}</div>
        <div class="bc">${barcodeSvg(p.barcode)}</div><div class="cd">${esc(p.barcode)}</div></div>`);
    }
  });
  return `<style>
    .sheet{display:grid;grid-template-columns:repeat(3,63.5mm);gap:2mm 2.5mm;justify-content:center}
    .lbl{border:1px dashed #bbb;height:38.1mm;padding:2mm 3mm;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;page-break-inside:avoid}
    .nm{font:700 10pt Arial;line-height:1.15;max-height:2.4em;overflow:hidden}
    .pr{font:800 12pt Arial;margin:1mm 0}.pr small{font:400 7pt Arial}
    .bc{flex:1;min-height:0}.bc svg{width:100%;height:100%}
    .cd{font:9pt monospace;text-align:center;letter-spacing:.1em}
    @media print{.lbl{border-color:transparent}}
  </style><div class="sheet">${cells.join('')}</div>`;
}

// ---------------------------------------------------------- the camera -----

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code'];

// Opens the camera in a window and calls onCode(text) with the first code
// it reads. Phones whose browser cannot read barcodes are told so.
export async function openBarcodeCamera(onCode) {
  const m = openModal('Scan a barcode', `
    <video id="bc-video" playsinline muted style="width:100%;max-height:60vh;background:#000;border-radius:6px" hidden></video>
    <p id="bc-msg" class="muted" style="margin-top:.6rem">Opening the camera…</p>`, { okLabel: 'Done' });
  const card = m.wrap.querySelector('.modal-card');
  const video = card.querySelector('#bc-video'), msg = card.querySelector('#bc-msg');
  if (!('BarcodeDetector' in window)) {
    msg.innerHTML = 'This phone’s browser cannot read barcodes with the camera. Use a barcode scanner on the till, or type the code in the search box and press Enter.';
    return;
  }
  let stream = null, timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
  try {
    const supported = window.BarcodeDetector.getSupportedFormats ? await window.BarcodeDetector.getSupportedFormats() : FORMATS;
    const detector = new window.BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream; video.hidden = false; await video.play();
    msg.textContent = 'Hold the barcode in front of the camera.';
    timer = setInterval(async () => {
      if (!card.isConnected) return stop();              // the window was closed
      if (video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) { const text = codes[0].rawValue; stop(); m.close(); onCode(text); }
      } catch (e) { /* a frame failed to decode; keep going */ }
    }, 300);
  } catch (e) {
    stop();
    msg.textContent = 'Could not open the camera: ' + (e && e.message ? e.message : e) + '. Type the code in the search box instead.';
    toast('Camera not available', 'warn');
  }
}
