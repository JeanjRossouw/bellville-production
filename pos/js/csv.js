// Retail POS — CSV in and out. Handles quoted fields, commas and line
// breaks inside quotes, a BOM, and Windows line ends; nothing else is needed
// for Shopify's product export.

export function parseCsv(text, sep = ',') {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
// the separator a spreadsheet saved with: a comma, or the semicolon (or tab) Excel uses where the decimal mark is a comma
export function sepOf(text) {
  const line = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/)[0] || '';
  const n = (c) => line.split(c).length - 1;
  return n('\t') > n(',') && n('\t') > n(';') ? '\t' : n(';') > n(',') ? ';' : ',';
}
// rows of arrays → CSV text (Excel-friendly: BOM, CRLF)
export function toCsv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');
}
// rows with a header row → objects keyed by the header (trimmed)
export function csvObjects(rows) {
  const head = (rows[0] || []).map(h => String(h || '').trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : String(r[i])])));
}
export function download(text, fileName, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
