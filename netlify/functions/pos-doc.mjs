// Retail POS — a sale as a web page, from a signed link, for WhatsApp or
// email. The link carries a signed token naming the sale; without the token
// nothing is served. The till asks for the link with the cashier's login.
//
//   GET  ?t=<token>                         the invoice or receipt as a page
//   POST { action: 'link', saleId | poId, deviceId?, secret? | entityId, storeId }  (login) → { url, text }
//        a purchase order's link goes to the supplier: an A4 page to print or save as PDF
//
// Env: FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional), POS_OVERRIDE_SECRET (optional, signs the links).
import { json, Reject, clean, getDoc, query, loginOf, loadUser, inEntity, inStore, loadDevice, overrideToken, verifyOverrideToken, bodyOf } from './lib/pos.mjs';
import { receiptModel, a4Html, A4_CSS, shareText } from '../../pos/js/receipt.js';
import { poHtml, poShareText } from '../../pos/js/buying-doc.js';
import { rank } from './lib/pos.mjs';

const YEARS = 5 * 365 * 24 * 60;    // a link works for five years
async function bundle(saleId) {
  const sale = await getDoc('sales', saleId);
  if (!sale) throw new Reject(404, 'No such sale.');
  const [lines, payments, entity, store, settings] = await Promise.all([
    query('saleLines', [{ field: 'saleId', value: saleId }], 500, { field: 'lineNo' }),
    query('payments', [{ field: 'docId', value: saleId }], 20),
    getDoc('entities', sale.entityId), getDoc('stores', sale.storeId), getDoc('settings', sale.entityId)
  ]);
  return { sale: { ...sale, id: saleId }, lines, payments, entity: entity || {}, store, settings: settings || {} };
}
function siteUrl(event) {
  const h = event.headers || {};
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(h.host || '');
  const proto = h['x-forwarded-proto'] || (local ? 'http' : 'https');
  return process.env.URL && !local ? process.env.URL : proto + '://' + (h.host || 'localhost');
}

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const t = (event.queryStringParameters || {}).t || '';
      const claim = verifyOverrideToken(t);
      if (!claim || !claim.doc) return { statusCode: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<!DOCTYPE html><p style="font-family:sans-serif;padding:2rem">This link is not valid.</p>' };
      if (claim.kind === 'po') {
        const po = await getDoc('purchaseOrders', claim.doc);
        if (!po || po.status === 'draft') return { statusCode: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<!DOCTYPE html><p style="font-family:sans-serif;padding:2rem">This order is not available.</p>' };
        const [entity, store, supplier] = await Promise.all([getDoc('entities', po.entityId), getDoc('stores', po.storeId), po.supplierId ? getDoc('suppliers', po.supplierId) : null]);
        const page = poHtml({ po, entity: entity || {}, store, supplier });
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Purchase order ${po.docNo}</title><style>body{margin:0;padding:16px;background:#f4f4f2}${A4_CSS}.a4{background:#fff;padding:14mm;box-shadow:0 1px 6px rgba(0,0,0,.12)}.no-print{max-width:180mm;margin:0 auto 12px}@media print{body{padding:0;background:#fff}.a4{box-shadow:none;padding:0}.no-print{display:none}}</style></head><body>
          <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:700;background:#000;color:#fff;border:0;cursor:pointer">Print / save as PDF</button></div>${page}</body></html>`;
        return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex' }, body: html };
      }
      const b = await bundle(claim.doc);
      const m = receiptModel({ ...b, copy: false });
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${m.title} ${m.docNo}</title><style>body{margin:0;padding:16px;background:#f4f4f2}${A4_CSS}.a4{background:#fff;padding:16px;box-shadow:0 2px 12px rgba(0,0,0,.08)}.no-print{text-align:center;margin:0 0 12px}@media print{body{background:#fff;padding:0}.a4{box-shadow:none}.no-print{display:none}}</style></head><body>
        <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-weight:700;background:#000;color:#fff;border:0;cursor:pointer">Print / save as PDF</button></div>${a4Html(m)}</body></html>`;
      return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex' }, body: html };
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    const b = bodyOf(event);
    if (b.action !== 'link') return json(400, { error: 'Unknown action' });
    const login = await loginOf(event);
    if (!login) throw new Reject(401, 'Sign in first.');
    const user = await loadUser(login.sub);
    if (!user) throw new Reject(403, 'Not on the staff list.');
    if (b.poId) {
      const poId = clean(b.poId, 80);
      const po = await getDoc('purchaseOrders', poId);
      if (!po || po.status === 'draft') throw new Reject(404, 'No such purchase order, or it is still a draft.');
      if (!inEntity(user, po.entityId) || !inStore(user, po.storeId) || rank(user.role) < rank('supervisor')) throw new Reject(403, 'Not your store.');
      const token = overrideToken({ doc: poId, kind: 'po' }, YEARS);
      const url = siteUrl(event) + '/.netlify/functions/pos-doc?t=' + encodeURIComponent(token);
      const entity = await getDoc('entities', po.entityId);
      return json(200, { ok: true, url, text: poShareText(po, entity || {}, url) });
    }
    const saleId = clean(b.saleId, 80);
    const sale = await getDoc('sales', saleId);
    if (!sale) throw new Reject(404, 'No such sale.');
    const device = b.deviceId ? await loadDevice(clean(b.deviceId, 60), clean(b.secret, 120)) : null;
    if (!inEntity(user, sale.entityId) || !inStore(user, sale.storeId) || (device && device.storeId !== sale.storeId)) throw new Reject(403, 'Not your store.');
    const token = overrideToken({ doc: saleId }, YEARS);
    const url = siteUrl(event) + '/.netlify/functions/pos-doc?t=' + encodeURIComponent(token);
    const bb = await bundle(saleId);
    return json(200, { ok: true, url, text: shareText(receiptModel({ ...bb, copy: false }), url) });
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-doc failed:', e);
    return json(500, { error: 'Something went wrong on the server.' });
  }
};
