// Import from a spreadsheet: materials, products, bills of materials,
// customers, orders and invoices, from Excel (.xlsx) or a CSV file, so a new
// company can bring its price list, customer list, open orders and what each
// customer owes in one go instead of typing them.
//
// The file is read here in the browser (Excel files are unzipped with the
// browser's own decompressor; nothing is sent anywhere). The columns are
// matched to our fields by their headings, which can be changed before
// anything is saved; a preview shows what will be added, updated or skipped.
// Records are matched to ones already there by name (products also by
// barcode, orders and invoices by their number), and written in batches.
import * as store from './store.js';
import { limited } from './clientgroups.js';
import { allProducts, allMaterials, UNITS } from './costing.js';
import { allCustomers } from './customers.js';
import { allOrders } from './orders.js';
import { allInvoices } from './invoices.js';
import { esc, money, openModal, toast, today, addDays } from './ui.js';

// ------------------------------------------------------------ the kinds -----

const KINDS = {
  materials: {
    label: 'Materials', area: 'costing', coll: 'materials',
    hint: 'One row per material: name, unit, cost per unit, supplier.',
    fields: [
      { k: 'name', label: 'Material', req: true, syn: ['material', 'name', 'description', 'item', 'material name'] },
      { k: 'unit', label: 'Unit', syn: ['unit', 'uom', 'units', 'unit of measure'] },
      { k: 'cost', label: 'Cost per unit', money: true, syn: ['cost', 'unit cost', 'cost price', 'price', 'cost per unit'] },
      { k: 'supplier', label: 'Supplier', syn: ['supplier', 'vendor', 'bought from'] },
      { k: 'reorderLevel', label: 'Reorder level', num: true, syn: ['reorder level', 'reorder', 'minimum', 'min', 'min level'] },
      { k: 'reorderQty', label: 'Usual order quantity', num: true, syn: ['order quantity', 'reorder qty', 'order qty', 'reorder quantity'] },
      { k: 'onHand', label: 'On hand (new ones only)', num: true, syn: ['on hand', 'stock', 'in stock', 'qty', 'quantity', 'stock on hand'] },
      { k: 'notes', label: 'Notes', syn: ['notes', 'note', 'comment', 'comments'] }
    ],
    template: [['Material', 'Unit', 'Cost', 'Supplier', 'Reorder level', 'On hand'], ['Pine 38x76', 'm', '28.50', 'Timber City', '100', '250'], ['Foam 100mm seat', 'm²', '310', 'Foam Factory', '10', '24']]
  },
  products: {
    label: 'Products', area: 'costing', coll: 'products',
    hint: 'One row per product: name, category, selling price. Their materials can come in after, as bills of materials.',
    fields: [
      { k: 'name', label: 'Product', req: true, syn: ['product', 'name', 'description', 'item', 'product name', 'model'] },
      { k: 'category', label: 'Category', syn: ['category', 'type', 'group', 'range'] },
      { k: 'sellingPrice', label: 'Selling price', money: true, syn: ['selling price', 'price', 'retail', 'retail price', 'sell', 'sale price'] },
      { k: 'labourHours', label: 'Labour hours', num: true, syn: ['labour hours', 'labor hours', 'hours', 'labour', 'labor'] },
      { k: 'stock', label: 'In stock', num: true, syn: ['stock', 'in stock', 'on hand', 'qty', 'quantity'] },
      { k: 'barcode', label: 'Barcode', syn: ['barcode', 'ean', 'sku', 'code', 'item code', 'product code'] },
      { k: 'notes', label: 'Notes', syn: ['notes', 'note', 'comment', 'comments', 'description 2'] }
    ],
    template: [['Product', 'Category', 'Price', 'Labour hours', 'In stock', 'Barcode'], ['3 Seater Chesterfield', 'Sofas', '8500', '14', '0', ''], ['Ottoman 900mm', 'Occasional', '2400', '4', '3', '6001234567890']]
  },
  bom: {
    label: 'Bills of materials', area: 'costing', coll: 'products',
    hint: 'One row per material in a product: product, material, quantity. A product listed here gets exactly these materials.',
    fields: [
      { k: 'product', label: 'Product', req: true, syn: ['product', 'product name', 'item', 'model'] },
      { k: 'material', label: 'Material', req: true, syn: ['material', 'material name', 'component', 'part'] },
      { k: 'qty', label: 'Quantity per piece', req: true, num: true, syn: ['qty', 'quantity', 'amount', 'usage', 'qty per piece', 'per piece'] }
    ],
    template: [['Product', 'Material', 'Quantity'], ['3 Seater Chesterfield', 'Pine 38x76', '22'], ['3 Seater Chesterfield', 'Foam 100mm seat', '2.2']]
  },
  customers: {
    label: 'Customers', area: 'customers', coll: 'customers',
    hint: 'One row per customer: name, contact person, cell, email, address.',
    fields: [
      { k: 'name', label: 'Customer', req: true, syn: ['customer', 'name', 'company', 'client', 'customer name', 'business'] },
      { k: 'contact', label: 'Contact person', syn: ['contact', 'contact person', 'attention', 'person'] },
      { k: 'phone', label: 'Cell / phone', syn: ['phone', 'cell', 'mobile', 'tel', 'telephone', 'cell number', 'whatsapp'] },
      { k: 'email', label: 'Email', syn: ['email', 'e-mail', 'email address'] },
      { k: 'address', label: 'Delivery address', syn: ['address', 'delivery address', 'street', 'physical address'] },
      { k: 'area', label: 'Area', syn: ['area', 'suburb', 'city', 'town', 'region'] },
      { k: 'termsDays', label: 'Payment terms (days)', num: true, syn: ['terms', 'payment terms', 'days', 'terms days'] },
      { k: 'group', label: 'Group', syn: ['group', 'client group', 'customer group', 'type', 'category', 'segment'] },
      { k: 'notes', label: 'Notes', syn: ['notes', 'note', 'comment', 'comments'] }
    ],
    template: [['Customer', 'Contact', 'Cell', 'Email', 'Address', 'Area', 'Terms', 'Group'], ['Cape Living Interiors', 'Lindiwe', '021 000 0000', 'orders@capeliving.co.za', '12 Main Road', 'Parow', '30', 'Trade']]
  },
  orders: {
    label: 'Orders', area: 'orders', coll: 'orders',
    hint: 'One row per order: customer, product, quantity, price, dates. Rows without an order number get the next ones; rows with one keep it.',
    fields: [
      { k: 'orderNo', label: 'Order no.', syn: ['order no', 'order number', 'order', 'order nr', 'order num', 'job no', 'job number', 'job'] },
      { k: 'customer', label: 'Customer', req: true, syn: ['customer', 'client', 'customer name', 'company', 'account', 'store'] },
      { k: 'product', label: 'Product', req: true, syn: ['product', 'item', 'description', 'model', 'product name', 'what'] },
      { k: 'qty', label: 'Qty', num: true, syn: ['qty', 'quantity', 'units', 'pieces', 'pcs'] },
      { k: 'fabric', label: 'Fabric / colour', syn: ['fabric', 'colour', 'color', 'fabric colour', 'cover', 'finish'] },
      { k: 'priceEach', label: 'Price each', money: true, syn: ['price each', 'price', 'unit price', 'selling price', 'each', 'rate', 'amount'] },
      { k: 'externalRef', label: 'Their order / invoice no.', syn: ['their ref', 'their order', 'reference', 'ref', 'customer ref', 'po', 'po number', 'their order no', 'customer order'] },
      { k: 'paidDate', label: 'Date paid / placed', date: true, syn: ['date paid', 'paid', 'order date', 'date', 'placed', 'date placed', 'ordered', 'paid date'] },
      { k: 'dueDate', label: 'Due date', date: true, syn: ['due date', 'due', 'delivery date', 'required', 'required date', 'promised', 'eta'] },
      { k: 'fabricStatus', label: 'Fabric status', syn: ['fabric status', 'fabric state', 'fabric ordered', 'fabric stage'] },
      { k: 'status', label: 'Status (new orders only)', syn: ['status', 'stage', 'state', 'progress'] },
      { k: 'notes', label: 'Notes', syn: ['notes', 'note', 'comment', 'comments', 'instructions', 'special instructions'] }
    ],
    template: [['Order no', 'Customer', 'Product', 'Qty', 'Fabric', 'Fabric status', 'Price each', 'Their ref', 'Date paid', 'Due date', 'Status', 'Notes'],
      ['', 'Cape Living Interiors', '3 Seater Chesterfield', '2', 'Moldova : Oatmeal', 'Ordered', '8500', 'PO 4471', '2026-10-01', '2026-10-29', 'New', 'Studs on the arms'],
      ['', 'Cape Living Interiors', 'Ottoman 900mm', '1', 'Moldova : Oatmeal', 'Received', '2400', 'PO 4471', '01/10/2026', '29/10/2026', 'In production', '']]
  },
  invoices: {
    label: 'Invoices', area: 'invoices', coll: 'invoices',
    hint: 'What customers owe from before: one row per invoice with its total and what was paid on it. Each comes in with what is still owing, so statements and the money owed are right from day one.',
    fields: [
      { k: 'invoiceNo', label: 'Invoice no.', req: true, syn: ['invoice no', 'invoice number', 'invoice', 'inv no', 'invoice nr', 'document', 'doc no', 'reference'] },
      { k: 'customer', label: 'Customer', req: true, syn: ['customer', 'client', 'customer name', 'account', 'company', 'debtor'] },
      { k: 'date', label: 'Invoice date', date: true, syn: ['date', 'invoice date', 'doc date', 'issued'] },
      { k: 'dueDate', label: 'Due date', date: true, syn: ['due date', 'due', 'payment due'] },
      { k: 'total', label: 'Invoice total', req: true, money: true, syn: ['total', 'debit', 'debit total', 'amount', 'invoice total', 'total incl vat', 'value'] },
      { k: 'paid', label: 'Paid so far', money: true, syn: ['paid', 'paid total', 'amount paid', 'payments', 'received', 'credit', 'paid to date'] },
      { k: 'orderRef', label: 'Order no.', syn: ['order no', 'order number', 'order', 'their order', 'po', 'po number'] },
      { k: 'units', label: 'Units', num: true, syn: ['units', 'total units', 'qty', 'quantity', 'pieces'] },
      { k: 'note', label: 'Note', syn: ['note', 'notes', 'comment', 'description'] }
    ],
    template: [['Invoice no', 'Customer', 'Date', 'Due date', 'Total', 'Paid', 'Order no', 'Units', 'Note'],
      ['0006', 'Cape Living Interiors', '2026-09-19', '2026-09-26', '38750', '0', '0006', '4', ''],
      ['0005', 'Cape Living Interiors', '18/09/2026', '25/09/2026', '27426.53', '27426.53', '0005', '6', '']]
  }
};

// ------------------------------------------------------- reading files -----

// A CSV file: commas, semicolons (Excel in South Africa often uses them) or
// tabs, with "quoted, values" and "" for a quote.
export function readCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  // the separator most used on any of the first lines (a title line above
  // the table has none)
  const lines = text.split(/\r?\n/, 10);
  const count = (ch) => Math.max(0, ...lines.map(l => l.split('"').filter((_, i) => i % 2 === 0).join('').split(ch).length - 1));
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return [{ name: 'CSV', rows }];
}

// An Excel workbook (.xlsx is a zip of XML files): every sheet's cells as text.
export async function readXlsx(buf) {
  const files = await unzip(buf);
  const xml = (name) => files[name] ? new DOMParser().parseFromString(files[name], 'application/xml') : null;
  const textOf = (el) => [...el.getElementsByTagName('t')].map(t => t.textContent).join('');
  const shared = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) [...ss.getElementsByTagName('si')].forEach(si => shared.push(textOf(si)));
  const wb = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  const target = {};
  if (rels) [...rels.getElementsByTagName('Relationship')].forEach(r => { target[r.getAttribute('Id')] = r.getAttribute('Target'); });
  const sheets = wb ? [...wb.getElementsByTagName('sheet')].map(s => {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let path = target[rid] || '';
    path = path.startsWith('/') ? path.slice(1) : 'xl/' + path.replace(/^\.\//, '');
    return { name: s.getAttribute('name'), path };
  }) : [];
  if (!sheets.length) Object.keys(files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort().forEach((p, i) => sheets.push({ name: 'Sheet ' + (i + 1), path: p }));
  const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref || ''); let n = 0; if (m) for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  return sheets.map(sh => {
    const doc = xml(sh.path);
    const rows = [];
    if (doc) [...doc.getElementsByTagName('row')].forEach(r => {
      const ri = (parseInt(r.getAttribute('r'), 10) || rows.length + 1) - 1;
      const out = [];
      [...r.getElementsByTagName('c')].forEach((c, k) => {
        const ci = c.getAttribute('r') ? colIndex(c.getAttribute('r')) : k;
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = '';
        if (t === 's') val = shared[parseInt(v ? v.textContent : '', 10)] || '';
        else if (t === 'inlineStr') { const is = c.getElementsByTagName('is')[0]; val = is ? textOf(is) : ''; }
        else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
        else val = v ? v.textContent : '';
        out[ci] = val;
      });
      rows[ri] = Array.from(out, x => x == null ? '' : x);
    });
    return { name: sh.name, rows: Array.from(rows, x => x || []) };
  });
}

// The files inside a zip, as text (only what an .xlsx needs: stored or deflated).
async function unzip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file. Save it as .xlsx or CSV and try again.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = new Uint8Array(buf, start, size);
    if (method === 0) out[name] = dec.decode(data);
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out[name] = dec.decode(await new Response(stream).arrayBuffer());
    }
  }
  return out;
}

export async function readFile(file) {
  const name = String(file.name || '').toLowerCase();
  if (/\.xls$/.test(name)) throw new Error('Old Excel files (.xls) cannot be read. In Excel use File → Save as → Excel Workbook (.xlsx) or CSV.');
  if (/\.(xlsx|xlsm)$/.test(name)) return readXlsx(await file.arrayBuffer());
  return readCsv(await file.text());
}

// ------------------------------------------------------- cleaning values ----

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9²]+/g, ' ').trim();
// "R 1 250,50" → 1250.5; "1,250.50" → 1250.5; "" → null
export function toNumber(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return null;
  s = s.replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /^-?\d{1,3}(,\d{3})+$/.test(s) && !/^-?0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');   // 12,500 is twelve thousand five hundred; 2,5 is two and a half
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
// A date as YYYY-MM-DD, or null. Day first for 13/10/2026 (South Africa);
// Excel's own date numbers; "13 Oct 2026" and "Oct 13, 2026".
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function toDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const iso = (y, m, d) => {
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 100) y += 2000;
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d || y < 1990 || y > 2100) return null;
    return t.toISOString().slice(0, 10);
  };
  let m;
  if (/^\d{5}(\.\d+)?$/.test(s)) {                                  // Excel keeps dates as days since 1899-12-30
    const n = Math.floor(Number(s));
    return n > 30000 && n < 80000 ? new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10) : null;
  }
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s))) return iso(m[1], m[2], m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?: .*)?$/.exec(s))) return iso(m[3], m[2], m[1]);
  const mon = (w) => MONTHS.indexOf(String(w).slice(0, 3).toLowerCase()) + 1;
  if ((m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -,]*(\d{2}|\d{4})$/.exec(s)) && mon(m[2])) return iso(m[3], mon(m[2]), m[1]);
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s)) && mon(m[1])) return iso(m[3], mon(m[1]), m[2]);
  return null;
}

// An order's stage from the words people use for it ('' when the cell is
// empty, 'cancelled' for ones that never happened, null when not understood).
const STATUS_WORDS = {
  'new': ['new', 'open', 'pending', 'accepted', 'confirmed', 'not started', 'to do', 'todo', 'waiting', 'ordered', 'paid'],
  'in-production': ['in production', 'production', 'building', 'being built', 'busy', 'wip', 'in progress', 'started', 'on the floor', 'making'],
  'ready': ['ready', 'done', 'finished', 'complete', 'completed', 'built', 'ready for dispatch', 'ready to go'],
  'dispatched': ['dispatched', 'delivered', 'shipped', 'sent', 'collected', 'out', 'gone'],
  'invoiced': ['invoiced', 'billed', 'closed', 'paid in full'],
  'cancelled': ['cancelled', 'canceled', 'void', 'deleted']
};
// Where the fabric is: not ordered, ordered or received ('' when empty,
// null when not understood).
const FABRIC_WORDS = {
  none: ['not ordered', 'none', 'no', 'to order', 'needs ordering', 'outstanding', 'n a'],
  ordered: ['ordered', 'on order', 'yes', 'waiting', 'awaiting', 'in transit'],
  received: ['received', 'in', 'in stock', 'arrived', 'here', 'delivered', 'supplied', 'customer supplied', 'cmt']
};
export function toFabricStatus(v) {
  const s = norm(v);
  if (!s) return '';
  for (const k of Object.keys(FABRIC_WORDS)) if (FABRIC_WORDS[k].includes(s)) return k;
  return null;
}

export function toStatus(v) {
  const s = norm(v);
  if (!s) return '';
  for (const k of Object.keys(STATUS_WORDS)) if (STATUS_WORDS[k].includes(s)) return k;
  return null;
}

const UNIT_WORDS = { m: ['m', 'metre', 'meter', 'metres', 'meters', 'lm', 'running metre'], 'm²': ['m2', 'm²', 'sqm', 'square metre', 'square meter', 'sq m'], sheet: ['sheet', 'sheets', 'board', 'boards'],
  each: ['each', 'ea', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'no', 'item'], kg: ['kg', 'kilo', 'kilogram', 'kgs'], L: ['l', 'litre', 'liter', 'litres', 'liters', 'ltr'], roll: ['roll', 'rolls'], pack: ['pack', 'packs', 'box', 'boxes', 'pkt'] };
function toUnit(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'each';
  for (const u of Object.keys(UNIT_WORDS)) if (UNIT_WORDS[u].includes(s)) return u;
  return UNITS.includes(v) ? v : String(v).trim();
}

// Which file column holds which field, from the headings.
// Exact headings first, for every field; then headings that start with one
// ("Retail price incl VAT"), so "Product code" is never taken for the name.
function guessColumns(kind, headers) {
  const used = new Set(), map = {};
  const h = headers.map(norm);
  const fields = KINDS[kind].fields.map(f => ({ k: f.k, syn: f.syn.map(norm) }));
  fields.forEach(f => {
    const i = h.findIndex((x, j) => !used.has(j) && f.syn.includes(x));
    if (i >= 0) { map[f.k] = i; used.add(i); }
  });
  fields.forEach(f => {
    if (map[f.k] != null) return;
    const i = h.findIndex((x, j) => !used.has(j) && x && f.syn.some(s => x.startsWith(s + ' ') || x.endsWith(' ' + s)));
    if (i >= 0) { map[f.k] = i; used.add(i); }
  });
  return map;
}

// The headings row of a sheet: among the first rows, the first one that is as
// full as the fullest (a title or a blank line above the table is passed over).
function findHeaderRow(rows) {
  const filled = (r) => (r || []).filter(c => String(c == null ? '' : c).trim()).length;
  const top = rows.slice(0, 15);
  const most = Math.max(0, ...top.map(filled));
  const i = top.findIndex(r => filled(r) >= Math.max(1, Math.ceil(most * 0.6)));
  return Math.max(0, i);
}
// The sheet (and its headings row) whose headings best fit this kind of import.
function bestSheet(kind, sheets) {
  let best = { ix: 0, head: 0, score: -1 };
  sheets.forEach((s, ix) => {
    const head = findHeaderRow(s.rows);
    const score = Object.keys(guessColumns(kind, (s.rows[head] || []).map(x => String(x || '')))).length;
    if (score > best.score) best = { ix, head, score };
  });
  return best;
}

// ---------------------------------------------------------- the plan ------

// What the import would do, row by row, before anything is written.
function plan(kind, rows, map, opts) {
  const K = KINDS[kind];
  // Selling prices are kept incl. VAT, costs excl. VAT: a file of selling
  // prices without VAT gets it added, a file of costs with VAT has it taken off.
  const rate = Number(opts.vatRate) || 0;
  const adj = (x) => kind === 'materials' ? (opts.inclVat && rate ? x / (1 + rate) : x) : (opts.addVat && rate ? x * (1 + rate) : x);
  const get = (r, k) => map[k] == null ? '' : String(r[map[k]] == null ? '' : r[map[k]]).trim();
  const out = { add: [], update: [], skip: [] };
  if (kind === 'bom') {
    const prods = allProducts(), mats = allMaterials();
    const byProd = new Map();
    rows.forEach((r, n) => {
      const pn = get(r, 'product'), mn = get(r, 'material'), q = toNumber(get(r, 'qty'));
      if (!pn && !mn) return;
      const p = prods.find(x => norm(x.name) === norm(pn));
      const m = mats.find(x => norm(x.name) === norm(mn));
      if (!p) return out.skip.push({ n, why: 'no product called “' + pn + '”' });
      if (!m) return out.skip.push({ n, why: 'no material called “' + mn + '”' });
      if (!(q > 0)) return out.skip.push({ n, why: 'no quantity' });
      const b = byProd.get(p.id) || { p, lines: [] };
      const same = b.lines.find(l => l.materialId === m.id);
      if (same) same.qty = Math.round((same.qty + q) * 1000) / 1000; else b.lines.push({ materialId: m.id, qty: q });
      byProd.set(p.id, b);
    });
    byProd.forEach(b => out.update.push({ id: b.p.id, name: b.p.name, data: { materials: b.lines }, detail: b.lines.length + ' material' + (b.lines.length === 1 ? '' : 's') }));
    return out;
  }
  if (kind === 'orders') return planOrders(rows, get, adj, opts);
  if (kind === 'invoices') return planInvoices(rows, get, opts);
  const existing = kind === 'materials' ? allMaterials() : kind === 'products' ? allProducts() : allCustomers();
  const seen = new Map();
  rows.forEach((r, n) => {
    const name = get(r, 'name');
    if (!name) { if (r.some(c => String(c || '').trim())) out.skip.push({ n, why: 'no name' }); return; }
    const d = { name };
    K.fields.forEach(f => {
      if (f.k === 'name' || map[f.k] == null) return;
      const raw = get(r, f.k);
      if (raw === '') return;
      if (f.money) { const x = toNumber(raw); if (x != null) d[f.k] = Math.round(adj(x) * 100) / 100; }
      else if (f.num) { const x = toNumber(raw); if (x != null) d[f.k] = f.k === 'termsDays' || f.k === 'stock' ? Math.round(x) : x; }
      else if (f.k === 'unit') d.unit = toUnit(raw);
      else if (f.k === 'email') d.email = raw.toLowerCase();
      else d[f.k] = raw;
    });
    const key = norm(name);
    if (seen.has(key)) { out.skip.push({ n, why: '“' + name + '” is in the file twice; the first row is used' }); return; }
    seen.set(key, true);
    let hit = existing.find(x => norm(x.name) === key);
    if (!hit && kind === 'products' && d.barcode) hit = existing.find(x => x.barcode && String(x.barcode).toLowerCase() === d.barcode.toLowerCase());
    if (kind === 'products' && d.barcode && existing.some(x => x !== hit && x.barcode && String(x.barcode).toLowerCase() === d.barcode.toLowerCase())) {
      out.skip.push({ n, why: 'barcode ' + d.barcode + ' already belongs to another product' }); return;
    }
    if (hit) {
      if (!opts.update) return out.skip.push({ n, why: '“' + name + '” is already there' });
      const { name: _n, onHand, ...patch } = d;               // on hand is only set for new materials (counts go through the stock take)
      if (!Object.keys(patch).length) return out.skip.push({ n, why: 'nothing new for “' + name + '”' });
      out.update.push({ id: hit.id, name, data: patch });
    } else {
      const fresh = { ...d };
      if (kind === 'materials') { fresh.unit = fresh.unit || 'each'; fresh.cost = fresh.cost || 0; }
      if (kind === 'products') { fresh.materials = []; fresh.labourHours = fresh.labourHours || 0; fresh.sellingPrice = fresh.sellingPrice || 0; }
      if (kind === 'customers') fresh.termsDays = fresh.termsDays || 0;
      out.add.push({ name, data: fresh });
    }
  });
  return out;
}

// Orders: matched by order number; the customer by name. A customer not
// here yet is added along with its orders (when that is ticked). The stage
// is only set for new orders: an order already here is moved on the Orders
// page, where its stock comes off the shelf.
function planOrders(rows, get, adj, opts) {
  const out = { add: [], update: [], skip: [], newCustomers: [] };
  const custs = allCustomers(), existing = allOrders();
  const fresh = new Map(), seen = new Set();
  rows.forEach((r, n) => {
    const no = get(r, 'orderNo'), cname = get(r, 'customer'), product = get(r, 'product');
    if (!no && !cname && !product) { if (r.some(c => String(c || '').trim())) out.skip.push({ n, why: 'no customer or product' }); return; }
    if (!cname) return out.skip.push({ n, why: 'no customer' });
    if (!product) return out.skip.push({ n, why: 'no product' });
    const rawStatus = get(r, 'status'), status = toStatus(rawStatus);
    if (status === 'cancelled') return out.skip.push({ n, why: 'cancelled' });
    if (status == null) return out.skip.push({ n, why: 'status “' + rawStatus + '” is not one we know (New, In production, Done, Dispatched, Invoiced)' });
    const rawFabric = get(r, 'fabricStatus'), fabricStatus = toFabricStatus(rawFabric);
    if (fabricStatus == null) return out.skip.push({ n, why: 'fabric status “' + rawFabric + '” is not one we know (Not ordered, Ordered, Received)' });
    const d = { product };
    if (fabricStatus) d.fabricStatus = fabricStatus;
    const q = toNumber(get(r, 'qty'));
    if (q != null) { if (!(q > 0)) return out.skip.push({ n, why: 'quantity ' + get(r, 'qty') }); d.qty = Math.max(1, Math.round(q)); }
    const price = toNumber(get(r, 'priceEach'));
    if (price != null) d.priceEach = Math.round(adj(price) * 100) / 100;
    ['fabric', 'externalRef', 'notes'].forEach(k => { const x = get(r, k); if (x) d[k] = x; });
    for (const k of ['paidDate', 'dueDate']) {
      const raw = get(r, k);
      if (!raw) continue;
      const iso = toDate(raw);
      if (!iso) return out.skip.push({ n, why: 'date “' + raw + '” not understood (use 2026-10-13 or 13/10/2026)' });
      d[k] = iso;
    }
    if (no) {
      const key = norm(no);
      if (seen.has(key)) return out.skip.push({ n, why: 'order ' + no + ' is in the file twice; the first row is used' });
      seen.add(key);
    }
    let cust = custs.find(c => norm(c.name) === norm(cname)), custKey = '';
    if (!cust) {
      if (!opts.addCustomers) return out.skip.push({ n, why: 'no customer called “' + cname + '”' });
      custKey = norm(cname);
      if (!fresh.has(custKey)) fresh.set(custKey, { name: cname });
    }
    const who = cust ? { customerId: cust.id, customerName: cust.name } : { customerName: fresh.get(custKey).name };
    const hit = no ? existing.find(o => norm(o.orderNo) === norm(no)) : null;
    if (hit) {
      if (!opts.update) return out.skip.push({ n, why: 'order ' + no + ' is already there' });
      const patch = { ...who, ...d };
      Object.keys(patch).forEach(k => { if (k !== 'customerId' && String(patch[k]) === String(hit[k] == null ? '' : hit[k])) delete patch[k]; });
      if (!custKey && patch.customerId === hit.customerId) delete patch.customerId;
      if (!Object.keys(patch).length) return out.skip.push({ n, why: 'nothing changed on ' + hit.orderNo });
      out.update.push({ id: hit.id, name: hit.orderNo, custKey, data: patch });
    } else {
      const paid = d.paidDate || today();
      out.add.push({ name: no || product, custKey, data: {
        ...who, qty: 1, priceEach: 0, fabric: '', externalRef: '', notes: '', ...d,
        orderNo: no, paidDate: paid, dueDate: d.dueDate || addDays(paid, 28),
        fabricStatus: 'none', status: status || 'new', source: 'import', ...(d.fabricStatus ? { fabricStatus: d.fabricStatus } : {})
      } });
    }
  });
  // only customers that an order still needs
  const needed = new Set([...out.add, ...out.update].map(x => x.custKey).filter(Boolean));
  out.newCustomers = [...fresh.entries()].filter(([k]) => needed.has(k)).map(([key, c]) => ({ key, name: c.name }));
  return out;
}

// The writes for an orders import: new customers first (with ids chosen
// here so their orders can point at them), then the orders, the ones without
// a number numbered from the company's sequence. Numbers that came in with
// the file move the sequence past them, so they are never handed out again.
async function orderOps(p, settings) {
  const prefix = (settings && settings.orderPrefix) || 'CP-';
  const first = (settings && settings.firstOrderNo) || 1001;
  const custId = {};
  const ops = p.newCustomers.map(c => {
    custId[c.key] = store.newId('customers');
    return { op: 'create', coll: 'customers', id: custId[c.key], data: { name: c.name, termsDays: 0 } };
  });
  const ours = (no) => { const s = String(no || ''); return s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length)) ? Number(s.slice(prefix.length)) : 0; };
  const highest = Math.max(0, ...p.add.map(x => ours(x.data.orderNo)));
  const blank = p.add.filter(x => !x.data.orderNo).length;
  let next = (blank || highest) ? await store.reserveNumbers('orderNo', blank, first, highest ? highest + 1 : 0) : 0;
  const by = (store.getUser() || {}).name || 'system';
  p.add.forEach(x => {
    const data = { ...x.data };
    if (x.custKey) data.customerId = custId[x.custKey];
    if (!data.orderNo) data.orderNo = prefix + (next++);
    data.events = [{ at: store.nowIso(), by, what: 'Imported from a spreadsheet' }];
    ops.push({ op: 'create', coll: 'orders', data });
  });
  p.update.forEach(x => {
    const patch = { ...x.data };
    if (x.custKey) patch.customerId = custId[x.custKey];
    ops.push({ op: 'update', coll: 'orders', id: x.id, patch, event: 'Updated from a spreadsheet' });
  });
  return ops;
}

// Invoices from before (opening balances): matched by number, and one
// already here is left as it is (its payments are recorded on it). Totals
// are what the customer was billed, VAT included; what was paid comes in as
// one payment, so what is owing is right from the start.
function planInvoices(rows, get, opts) {
  const out = { add: [], update: [], skip: [], newCustomers: [] };
  const custs = allCustomers(), existing = allInvoices();
  const fresh = new Map(), seen = new Set();
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  rows.forEach((r, n) => {
    const no = get(r, 'invoiceNo'), cname = get(r, 'customer'), rawTotal = get(r, 'total');
    if (!no && !cname && !rawTotal) { if (r.some(c => String(c || '').trim())) out.skip.push({ n, why: 'no invoice number, customer or total' }); return; }
    if (!no) return out.skip.push({ n, why: 'no invoice number' });
    if (!cname) return out.skip.push({ n, why: 'no customer' });
    const total = toNumber(rawTotal);
    if (total == null) return out.skip.push({ n, why: 'no total' });
    const paid = r2(toNumber(get(r, 'paid')) || 0);
    if (paid > total + 0.005) return out.skip.push({ n, why: 'more paid (' + paid + ') than the total (' + total + ')' });
    const key = norm(no);
    if (seen.has(key)) return out.skip.push({ n, why: 'invoice ' + no + ' is in the file twice; the first row is used' });
    seen.add(key);
    if (existing.some(i => norm(i.invoiceNo) === key)) return out.skip.push({ n, why: 'invoice ' + no + ' is already here' });
    const dates = {};
    for (const k of ['date', 'dueDate']) {
      const raw = get(r, k);
      if (!raw) continue;
      const iso = toDate(raw);
      if (!iso) return out.skip.push({ n, why: 'date “' + raw + '” not understood (use 2026-10-13 or 13/10/2026)' });
      dates[k] = iso;
    }
    let cust = custs.find(c => norm(c.name) === norm(cname)), custKey = '';
    if (!cust) {
      if (!opts.addCustomers) return out.skip.push({ n, why: 'no customer called “' + cname + '”' });
      custKey = norm(cname);
      if (!fresh.has(custKey)) fresh.set(custKey, { name: cname });
    }
    const date = dates.date || today();
    const terms = cust && cust.termsDays != null ? Number(cust.termsDays) || 0 : 0;
    const vatRate = opts.inclVat ? (Number(opts.vatRate) || 0) : 0;
    const subtotal = r2(total / (1 + vatRate)), vat = r2(total - subtotal);
    const units = toNumber(get(r, 'units')), orderRef = get(r, 'orderRef'), note = get(r, 'note');
    out.add.push({ name: no, custKey, data: {
      invoiceNo: no, customerName: cust ? cust.name : fresh.get(custKey).name, ...(cust ? { customerId: cust.id } : {}),
      date, dueDate: dates.dueDate || addDays(date, terms),
      lines: [{ orderId: '', orderNo: orderRef, externalRef: '', description: 'Brought over from before' + (orderRef ? ' · order ' + orderRef : '') + (units ? ' · ' + units + ' unit' + (units === 1 ? '' : 's') : ''), qty: 1, unitPrice: subtotal }],
      subtotal, vat, vatRate, total: r2(total), note: note || 'Imported opening balance',
      payments: paid > 0 ? [{ at: date, amount: paid, method: 'Brought over', ref: 'Paid before the system', by: '' }] : [],
      status: total - paid <= 0.005 ? 'paid' : 'issued', ...(total - paid <= 0.005 ? { paidAt: date } : {}),
      source: 'import'
    } });
  });
  const needed = new Set(out.add.map(x => x.custKey).filter(Boolean));
  out.newCustomers = [...fresh.entries()].filter(([k]) => needed.has(k)).map(([key, c]) => ({ key, name: c.name }));
  return out;
}

// The writes for an invoices import: new customers first, then the
// invoices. Numbers that came in in the company's own style move its
// sequence past them, so the next invoice raised here follows on.
async function invoiceOps(p, settings) {
  const prefix = (settings && settings.invoicePrefix != null) ? settings.invoicePrefix : 'INV-';
  const first = (settings && settings.firstInvoiceNo) || 1;
  const custId = {};
  const ops = p.newCustomers.map(c => {
    custId[c.key] = store.newId('customers');
    return { op: 'create', coll: 'customers', id: custId[c.key], data: { name: c.name, termsDays: 0 } };
  });
  const ours = (no) => { const s = String(no || ''); return s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length)) ? Number(s.slice(prefix.length)) : 0; };
  const highest = Math.max(0, ...p.add.map(x => ours(x.data.invoiceNo)));
  if (highest) await store.reserveNumbers('invoiceNo', 0, first, highest + 1);
  const by = (store.getUser() || {}).name || 'system';
  p.add.forEach(x => {
    const data = { ...x.data, events: [{ at: store.nowIso(), by, what: 'Imported from a spreadsheet' }] };
    if (x.custKey) data.customerId = custId[x.custKey];
    data.payments = data.payments.map(pm => ({ ...pm, by }));
    ops.push({ op: 'create', coll: 'invoices', data });
  });
  return ops;
}

// ------------------------------------------------------------ the window ----

export function openImport(kind, settings) {
  // a role that sees clients by group only cannot bring in customers or orders (the names would be wrong)
  const kinds = Object.keys(KINDS).filter(k => store.can(KINDS[k].area, 'edit') && !(limited() && (k === 'customers' || k === 'orders')));
  if (!kinds.length) { toast('Your role cannot add these', 'warn'); return; }
  let K = kinds.includes(kind) ? kind : kinds[0];
  let sheets = null, sheetIx = 0, headerRow = 0, map = {}, fileName = '';
  const vatReg = !!(settings && settings.vatRegistered);
  const vatRate = settings && settings.vatRate != null ? Number(settings.vatRate) : 0.15;
  const m = openModal('Import from a spreadsheet', `<div id="im-body"></div>`, {
    okLabel: 'Import',
    onOk: async (w) => {
      if (!sheets) { toast('Choose the file first', 'warn'); return false; }
      const p = currentPlan(w);
      const total = p.add.length + p.update.length;
      if (!total) { toast('Nothing to import: check the columns', 'warn'); return false; }
      const ok = w.querySelector('#modal-ok'); ok.disabled = true; ok.textContent = 'Importing…';
      try {
        const coll = KINDS[K].coll;
        const ops = K === 'orders' ? await orderOps(p, settings) : K === 'invoices' ? await invoiceOps(p, settings) : [
          ...p.add.map(x => ({ op: 'create', coll, data: x.data })),
          ...p.update.map(x => ({ op: 'update', coll, id: x.id, patch: x.data, event: 'Updated from a spreadsheet' }))
        ];
        for (let i = 0; i < ops.length; i += 400) await store.batchWrite(ops.slice(i, i + 400));
        toast(KINDS[K].label + ': ' + p.add.length + ' added, ' + p.update.length + ' updated' + (p.skip.length ? ', ' + p.skip.length + ' skipped' : '')
          + (p.newCustomers && p.newCustomers.length ? ', ' + p.newCustomers.length + ' new customer' + (p.newCustomers.length === 1 ? '' : 's') : ''));
      } catch (e) {
        toast('Import stopped: ' + e.message + '. What was saved before it stopped stays; run the same file again to finish.', 'warn');
        ok.disabled = false; ok.textContent = 'Import'; return false;
      }
    }
  });
  const card = m.wrap.querySelector('.modal-card');
  card.style.maxWidth = '900px';
  const body = card.querySelector('#im-body');
  const canAddCustomers = store.can('customers', 'edit');
  const opts = (w) => ({ update: (w.querySelector('#im-update') || {}).checked !== false, inclVat: !!(w.querySelector('#im-vat') || {}).checked, addVat: !!(w.querySelector('#im-addvat') || {}).checked, vatRate,
    addCustomers: canAddCustomers && (w.querySelector('#im-addcust') || {}).checked !== false });
  function dataRows() { const rows = (sheets[sheetIx] || { rows: [] }).rows; return rows.slice(headerRow + 1); }
  function headers() { return ((sheets[sheetIx] || { rows: [] }).rows[headerRow] || []).map(x => String(x || '').trim()); }
  function currentPlan(w) { return plan(K, dataRows(), map, opts(w)); }

  function draw() {
    const fields = KINDS[K].fields;
    const hs = sheets ? headers() : [];
    const p = sheets ? currentPlan(card) : null;
    const colSel = (f) => `<select data-im-col="${f.k}"><option value="">— not in the file —</option>${hs.map((h, i) => `<option value="${i}"${map[f.k] === i ? ' selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select>`;
    const sample = sheets ? dataRows().filter(r => r.some(c => String(c || '').trim())).slice(0, 6) : [];
    body.innerHTML = `
      <div class="btn-row" style="margin-bottom:.6rem">${kinds.map(k => `<button type="button" class="btn ${k === K ? 'primary' : 'ghost'} sm" data-im-kind="${k}">${esc(KINDS[k].label)}</button>`).join('')}</div>
      <p class="muted" style="margin:.2rem 0 .7rem">${esc(KINDS[K].hint)} Excel (.xlsx) or CSV. <a href="#" data-im-template="1">Download a sample file</a></p>
      <div class="btn-row" style="align-items:center; gap:.6rem; flex-wrap:wrap">
        <label class="btn ghost sm" style="margin:0">${sheets ? 'Choose another file' : 'Choose the file'}<input type="file" id="im-file" accept=".xlsx,.xlsm,.csv,.txt,.xls" style="display:none"></label>
        ${fileName ? `<strong>${esc(fileName)}</strong>` : ''}
        ${sheets && sheets.length > 1 ? `<label>Sheet <select id="im-sheet">${sheets.map((s, i) => `<option value="${i}"${i === sheetIx ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        ${sheets ? `<label>Headings on row <input id="im-head" type="number" min="1" value="${headerRow + 1}" style="width:60px"></label>` : ''}
      </div>
      <div class="btn-row" style="margin:.6rem 0; gap:1rem; flex-wrap:wrap">
        ${K !== 'bom' && K !== 'invoices' ? `<label class="check"><input type="checkbox" id="im-update" ${card.querySelector('#im-update') && !card.querySelector('#im-update').checked ? '' : 'checked'}> Update ones already here (same ${K === 'orders' ? 'order no.' : 'name'})</label>` : ''}
        ${(K === 'orders' || K === 'invoices') && canAddCustomers ? `<label class="check"><input type="checkbox" id="im-addcust" ${card.querySelector('#im-addcust') && !card.querySelector('#im-addcust').checked ? '' : 'checked'}> Add customers that aren’t here yet</label>` : ''}
        ${vatReg && K === 'materials' ? `<label class="check"><input type="checkbox" id="im-vat" ${card.querySelector('#im-vat') && card.querySelector('#im-vat').checked ? 'checked' : ''}> Costs in the file include VAT (${Math.round(vatRate * 100)}%): take it off</label>` : ''}
        ${vatReg && (K === 'products' || K === 'orders') ? `<label class="check"><input type="checkbox" id="im-addvat" ${card.querySelector('#im-addvat') && card.querySelector('#im-addvat').checked ? 'checked' : ''}> Prices in the file are excl. VAT: add ${Math.round(vatRate * 100)}% (prices are kept incl. VAT)</label>` : ''}
        ${vatReg && K === 'invoices' ? `<label class="check"><input type="checkbox" id="im-vat" ${card.querySelector('#im-vat') && !card.querySelector('#im-vat').checked ? '' : 'checked'}> Totals include VAT (${Math.round(vatRate * 100)}%)</label>` : ''}
      </div>
      ${sheets ? `
        <h4 style="margin:.8rem 0 .3rem">Which column is which</h4>
        <div class="im-map" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:.5rem">
          ${fields.map(f => `<label class="fld"><span>${esc(f.label)}${f.req ? ' *' : ''}</span>${colSel(f)}</label>`).join('')}
        </div>
        <h4 style="margin:1rem 0 .3rem">The first rows, as they will come in</h4>
        <div class="card" style="padding:0; overflow:auto; max-height:220px"><table class="tbl"><thead><tr>${fields.filter(f => map[f.k] != null).map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead>
          <tbody>${sample.map(r => `<tr>${fields.filter(f => map[f.k] != null).map(f => `<td>${esc(String(r[map[f.k]] == null ? '' : r[map[f.k]]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <div class="cost-live" style="margin-top:.8rem"><div class="tot"><span>${p.add.length} new · ${p.update.length} to update · ${p.skip.length} skipped</span><strong>${esc(KINDS[K].label)}</strong></div></div>
        ${p.skip.length ? `<details style="margin-top:.4rem"><summary class="muted">Why ${p.skip.length} row${p.skip.length === 1 ? ' is' : 's are'} skipped</summary><ul class="plain" style="max-height:140px; overflow:auto">${p.skip.slice(0, 200).map(s => `<li>Row ${s.n + headerRow + 2}: ${esc(s.why)}</li>`).join('')}</ul></details>` : ''}
        ${K === 'bom' && p.update.length ? `<p class="muted">These products get exactly the materials in the file: ${esc(p.update.slice(0, 6).map(x => x.name + ' (' + x.detail + ')').join(', '))}${p.update.length > 6 ? '…' : ''}</p>` : ''}
        ${K === 'products' && p.add.length ? '<p class="muted">New products come in without materials. Import their bills of materials next, or add them under Costing.</p>' : ''}
        ${K === 'invoices' && (p.add.length || p.newCustomers.length) ? (() => { const t = p.add.reduce((a, x) => [a[0] + x.data.total, a[1] + x.data.payments.reduce((s, pm) => s + pm.amount, 0)], [0, 0]);
          return `<p class="muted">Billed ${esc(money(t[0], (settings && settings.currency) || 'R'))} · paid ${esc(money(t[1], (settings && settings.currency) || 'R'))} · <strong>owing ${esc(money(t[0] - t[1], (settings && settings.currency) || 'R'))}</strong>${p.newCustomers.length ? ' · new customer' + (p.newCustomers.length === 1 ? '' : 's') + ': ' + esc(p.newCustomers.map(c => c.name).join(', ')) : ''}. Invoices already here are left as they are.</p>`; })() : ''}
        ${K === 'orders' && p.newCustomers.length ? `<p class="muted">New customers to add: ${esc(p.newCustomers.slice(0, 8).map(c => c.name).join(', '))}${p.newCustomers.length > 8 ? '…' : ''}. Fill in their details under Customers after.</p>` : ''}
        ${K === 'orders' && p.add.some(x => x.data.status !== 'new') ? '<p class="muted">Orders that come in already past New do not take materials off the shelf: those were used before the system.</p>' : ''}
        ${K === 'orders' && p.update.length ? '<p class="muted">Orders already here get their details updated; their stage stays as it is (move them on the Orders page).</p>' : ''}
      ` : '<p class="muted" style="margin-top:1rem">Choose the file to see what comes in. Nothing is saved until you press Import.</p>'}`;
  }

  body.addEventListener('click', (e) => {
    const k = e.target.closest('[data-im-kind]');
    if (k) { K = k.dataset.imKind; if (sheets) { const b = bestSheet(K, sheets); sheetIx = b.ix; headerRow = b.head; map = guessColumns(K, headers()); } draw(); return; }
    if (e.target.closest('[data-im-template]')) {
      e.preventDefault();
      const csv = KINDS[K].template.map(r => r.map(c => /[",;\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = 'sample-' + K + '.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  });
  body.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'im-file' && t.files && t.files[0]) {
      try {
        sheets = await readFile(t.files[0]);
        fileName = t.files[0].name;
        if (!sheets.length) throw new Error('There is nothing in that file');
        const b = bestSheet(K, sheets);
        sheetIx = b.ix; headerRow = b.head;
        map = guessColumns(K, headers());
        if (!Object.keys(map).length) toast('No headings matched: choose which column is which below', 'warn');
      } catch (err) { sheets = null; fileName = ''; toast(err.message, 'warn'); }
      return draw();
    }
    if (t.id === 'im-sheet') { sheetIx = parseInt(t.value, 10) || 0; headerRow = findHeaderRow(sheets[sheetIx].rows); map = guessColumns(K, headers()); return draw(); }
    if (t.id === 'im-head') { headerRow = Math.max(0, (parseInt(t.value, 10) || 1) - 1); map = guessColumns(K, headers()); return draw(); }
    if (t.dataset && t.dataset.imCol) { if (t.value === '') delete map[t.dataset.imCol]; else map[t.dataset.imCol] = parseInt(t.value, 10); return draw(); }
    if (t.id === 'im-update' || t.id === 'im-vat' || t.id === 'im-addvat' || t.id === 'im-addcust') return draw();
  });
  draw();
}

export { KINDS, plan, guessColumns, orderOps, invoiceOps };
