// Retail POS: a supplier's invoice dropped on the Receive screen, over HTTP (pos-invoice and the background
// reader). The file is kept in chunks, read by the (mock) model, the chunks deleted and the result handed back in
// cents excluding and including VAT; only a supervisor and up, only PDFs and photos, a daily limit, and only the
// person who dropped it may fetch the result. Nothing reaches stock.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAnthropic } from './mock-anthropic.mjs';
const mock = await startMockAnthropic(8798);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const FN = 'http://localhost:8788/.netlify/functions/';
const R = {}, fails = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ fails, ...R, crash: String(e && e.message || e) }, null, 1)); process.exit(1); });
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za'), cas = await mk('cathy@shop.co.za'), sup = await mk('sam@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('pos/retail/users/' + cas.localId, { email: 'cathy@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/users/' + sup.localId, { email: 'sam@shop.co.za', name: 'Sam', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const call = async (fn, body, token = sup.idToken) => { const r = await fetch(FN + fn, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const bell = { entityId: 'BF', storeId: 'BF-BELL', registerId: '' };
const file = (text, name = 'invoice.pdf', type = 'application/pdf') => ({ name, type, data: Buffer.from(text).toString('base64') });
const INV = { supplierName: 'Foam Co (Pty) Ltd', invoiceNo: 'INV-4411', invoiceDate: '2026-11-12', vatCharged: true, pricesIncludeVat: false, vatRatePct: 15,
  lines: [{ code: 'CU-1', description: 'Scatter cushion 45cm', qty: 10, unitPrice: 50, lineTotal: 500 }, { code: '', description: 'Table lamp brass', qty: 2.5, unitPrice: 200.5, lineTotal: 501.25 }],
  deliveryCharge: 100, subtotal: 1101.25, vatAmount: 165.19, total: 1266.44 };

// ---- who may, and what
R.cas = await call('pos-invoice', { action: 'start', files: [file('MOCKINVOICE' + JSON.stringify(INV))], ...bell }, cas.idToken); check('a cashier cannot read an invoice in', R.cas.status === 403, R.cas);
R.none = await call('pos-invoice', { action: 'start', files: [], ...bell }); check('no file: refused', R.none.status === 400, R.none);
R.type = await call('pos-invoice', { action: 'start', files: [file('x', 'sheet.xlsx', 'application/vnd.ms-excel')], ...bell }); check('only a PDF or a photo', R.type.status === 400 && /PDF or a photo/.test(R.type.error), R.type);
R.many = await call('pos-invoice', { action: 'start', files: Array.from({ length: 6 }, () => file('x')), ...bell }); check('at most five files', R.many.status === 400 && /At most 5/.test(R.many.error), R.many);
R.big = await call('pos-invoice', { action: 'start', files: [{ name: 'huge.pdf', type: 'application/pdf', data: 'A'.repeat(5000004) }], ...bell }); check('too big: refused with what to do', R.big.status === 400 && /too big/.test(R.big.error), R.big);
check('nothing was kept for the refused ones', (await listColl('invoiceReads')).length === 0 && (await listColl('invoiceReadChunks')).length === 0);

// ---- an invoice read: a file over one chunk long, so the chunks are joined back in order
const pad = ' '.repeat(1300000);
R.start = await call('pos-invoice', { action: 'start', files: [file(pad + 'MOCKINVOICE' + JSON.stringify(INV) + pad), file('page two', 'p2.jpg', 'image/jpeg')], ...bell });
check('queued: an id comes back', R.start.ok && /^ir_/.test(R.start.readId) && R.start.used === 1, R.start);
R.res = await call('pos-invoice', { action: 'result', readId: R.start.readId, ...bell });
const r = R.res.result || {};
check('read: the supplier, the number and the date as on the invoice', R.res.ok && R.res.status === 'done' && r.readable === true && r.supplierName === 'Foam Co (Pty) Ltd' && r.invoiceNo === 'INV-4411' && r.invoiceDate === '2026-11-12' && r.vatCharged === true && r.vatRatePct === 15, R.res);
check('the lines in cents, excluding and including VAT; a part quantity rounded and kept as printed', r.lines && r.lines.length === 2 && r.lines[0].code === 'CU-1' && r.lines[0].qty === 10 && r.lines[0].unitExCents === 5000 && r.lines[0].unitInclCents === 5750 && r.lines[0].lineTotalCents === 50000 && r.lines[1].qty === 3 && r.lines[1].qtyAsPrinted === 2.5 && r.lines[1].unitExCents === 20050 && r.lines[1].unitInclCents === 23058, r.lines);
check('the delivery charge and the totals', r.deliveryExCents === 10000 && r.deliveryInclCents === 11500 && r.subtotalCents === 110125 && r.vatCents === 16519 && r.totalCents === 126644, r);
const rec = await getDoc('pos/retail/invoiceReads/' + R.start.readId);
check('the record says who and what; the file itself is gone once read', rec.status === 'done' && rec.byName === 'Sam' && rec.files.length === 2 && rec.files[0].name === 'invoice.pdf' && rec.chunks >= 4 && (await listColl('invoiceReadChunks')).length === 0, { status: rec.status, chunks: rec.chunks });
const sent = mock.last().body;
const blocks = sent.messages[0].content;
check('the model got the PDF as a document and the photo as an image, whole, with the one tool', blocks[0].type === 'document' && blocks[0].source.media_type === 'application/pdf' && Buffer.from(blocks[0].source.data, 'base64').toString('utf8').length === 2 * pad.length + 11 + JSON.stringify(INV).length && blocks[1].type === 'image' && Buffer.from(blocks[1].source.data, 'base64').toString('utf8') === 'page two' && sent.tools.length === 1 && sent.tools[0].name === 'record_invoice' && /never work out or guess/.test(sent.system), blocks.map(b => b.type));
R.other = await call('pos-invoice', { action: 'result', readId: R.start.readId, ...bell }, own.idToken); check('only the person who dropped it gets the result', R.other.status === 404, R.other);
check('nothing reached stock', (await listColl('stockLevels')).length === 0 && (await listColl('goodsReceived')).length === 0 && (await listColl('stockMovements')).length === 0);

// ---- prices that include VAT; a supplier that charges none
const done = async (files) => { const s = await call('pos-invoice', { action: 'start', files, ...bell }); return (await call('pos-invoice', { action: 'result', readId: s.readId, ...bell })); };
R.incl = await done([file('MOCKINVOICE' + JSON.stringify({ ...INV, pricesIncludeVat: true, lines: [{ code: 'A', description: 'Thing', qty: 1, unitPrice: 115, lineTotal: 115 }], deliveryCharge: 0 }))]);
check('prices including VAT: the excluding figure is worked back', R.incl.result.lines[0].unitInclCents === 11500 && R.incl.result.lines[0].unitExCents === 10000, R.incl.result && R.incl.result.lines);
R.novat = await done([file('MOCKINVOICE' + JSON.stringify({ ...INV, vatCharged: false, vatRatePct: 0, lines: [{ code: 'A', description: 'Thing', qty: 1, unitPrice: 80, lineTotal: 80 }] }))]);
check('no VAT charged: the same either way', R.novat.result.lines[0].unitInclCents === 8000 && R.novat.result.lines[0].unitExCents === 8000 && R.novat.result.vatRatePct === 0, R.novat.result && R.novat.result.lines);

// ---- not an invoice; the reader failing; the daily limit
R.not = await done([file('a holiday photo', 'beach.jpg', 'image/jpeg')]);
check('not an invoice: said so, no lines', R.not.status === 'done' && R.not.result.readable === false && R.not.result.lines.length === 0 && /not an invoice/i.test(R.not.result.note), R.not);
R.fail = await done([file('MOCKINVOICE-FAIL')]);
check('the reader failing: a failed read with words for the person, the file gone', R.fail.ok && R.fail.status === 'failed' && R.fail.result === null && /could not be read just now/.test(R.fail.error) && (await listColl('invoiceReadChunks')).length === 0, R.fail);
await put('pos/retail/invoiceReadUse/' + sup.localId, { day: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }), count: 40, name: 'Sam', ...srv('BF', 'BF-BELL') });
R.limit = await call('pos-invoice', { action: 'start', files: [file('MOCKINVOICE' + JSON.stringify(INV))], ...bell }); check('the day’s limit: refused politely', R.limit.status === 429 && /40/.test(R.limit.error), R.limit);

console.log(JSON.stringify({ fails, ...R, start: undefined }, null, 1).slice(0, 6000));
console.log(fails.length ? fails.length + ' FAILED' : 'invoice-api: all passed');
await mock.close();
if (server) server.kill();
process.exit(fails.length ? 1 : 0);
