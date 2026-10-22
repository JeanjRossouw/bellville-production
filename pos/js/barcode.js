// Retail POS — Code 128 barcodes for labels. A scanner needs nothing from
// here: it types the code and presses Enter, which the sale screen listens for.

// Code 128 bar patterns: six widths per value (bar, space, bar, …); the stop
// is seven. Values 0–102 are characters, 104 starts code set B, 106 stops.
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
export const encodable = (text) => /^[\x20-\x7f]{1,48}$/.test(String(text || ''));
export function code128Widths(text) {
  const vals = [104];
  for (const ch of String(text || '')) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 95) throw new Error('A barcode can only hold plain letters, numbers and signs');
    vals.push(v);
  }
  vals.push(vals.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103, 106);
  return vals.map(v => PATTERNS[v]).join('');
}
// an SVG of the code, h units high, with the quiet zone either side
export function barcodeSvg(text, h = 50) {
  const widths = code128Widths(text);
  let x = 10, rects = '';
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]);
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="${h}"/>`;
    x += w;
  }
  const total = x + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${total}" height="${h}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
// an in-store code for an item without one: 2 + 7 digits, one past the highest given out
export function nextShopCode(allCodes) {
  const used = (allCodes || []).map(String).filter(c => /^2\d{7}$/.test(c)).map(Number);
  return String(used.length ? Math.max(...used) + 1 : 20000001);
}
