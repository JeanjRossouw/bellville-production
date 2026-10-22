// Retail POS — the phone's camera as a barcode scanner, where the browser
// has BarcodeDetector (Chrome on Android, Samsung Internet; Safari with a
// flag). Elsewhere the keyboard-wedge scanner or typing still works.
//
//   const sc = cameraScanner({ video, onCode, formats });  sc.supported; await sc.start(); sc.stop();
export function cameraScanner({ video, onCode, formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] }) {
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let stream = null, timer = null, detector = null, last = '', lastAt = 0;
  async function start() {
    if (!supported) throw new Error('This browser cannot read barcodes with the camera: use a scanner or type the code.');
    let fmts = formats;
    try { const ok = await window.BarcodeDetector.getSupportedFormats(); fmts = formats.filter(f => ok.includes(f)); } catch (e) {}
    detector = new window.BarcodeDetector({ formats: fmts.length ? fmts : undefined });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream; video.hidden = false;
    await video.play();
    timer = setInterval(async () => {
      if (!detector || video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (!codes || !codes.length) return;
        const v = String(codes[0].rawValue || '').trim();
        // the same code within a second and a half is the same label, not a second item
        if (!v || (v === last && Date.now() - lastAt < 1500)) return;
        last = v; lastAt = Date.now();
        onCode(v);
      } catch (e) { /* a frame failed to decode: the next one may not */ }
    }, 250);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    detector = null;
    if (video) { video.hidden = true; video.srcObject = null; }
  }
  return { supported, start, stop, running: () => !!stream };
}
