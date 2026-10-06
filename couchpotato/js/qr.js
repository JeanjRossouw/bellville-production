// QR codes for job cards. The code holds a link into this app with the order
// id, so ANY phone's ordinary camera app can scan the sticker: it opens the
// app straight onto that order's dispatch screen. The in-app scanner reads
// the same codes.
import qrcode from './vendor/qrcode.js';

export function scanUrl(orderId) {
  return location.origin + location.pathname + '?scan=' + encodeURIComponent(orderId);
}

export function orderIdFromCode(raw) {
  const m = String(raw || '').match(/[?&]scan=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : String(raw || '').trim();
}

export function qrSvg(text, px) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return `<div class="qr" style="width:${px || 110}px;height:${px || 110}px">${svg}</div>`;
}
