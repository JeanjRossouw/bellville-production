// Create a paid sales invoice in Xero for one POS sale.
//
//   POST /.netlify/functions/xero-invoice   (Authorization: Bearer <firebase id token>)
//   body: { biz: "bellville", sale: <Lightspeed-shaped sale object> }
//
// Flow: ensure a "POS Customer" contact → create an AUTHORISED ACCREC invoice
// (line amounts VAT-inclusive, matching the till) → apply a Payment so it shows
// as paid. Idempotent on the sale's local id (used as the invoice Reference).
import { xeroApi, getPosContactId, bizConfig, BIZ_KEYS } from './lib/xero.mjs';
import { requireUser } from './lib/auth.mjs';

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  try {
    await requireUser(event); // verifies the caller is a signed-in app user
  } catch (e) {
    return json(401, { error: 'Unauthorized: ' + e.message });
  }

  let biz, sale;
  try {
    ({ biz, sale } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  if (!BIZ_KEYS.includes(biz)) return json(400, { error: `Unknown business "${biz}"` });
  if (!sale || !sale._localId) return json(400, { error: 'Missing sale' });

  const lines = (sale.SaleLines && sale.SaleLines.SaleLine) || [];
  if (lines.length === 0) return json(400, { error: 'Sale has no line items' });

  const cfg = bizConfig(biz);
  if (!cfg.bankAccount) return json(500, { error: `XERO_BANK_ACCOUNT not configured for ${biz}` });

  const reference = sale._localId;
  const dateStr = (sale.timeStamp || new Date().toISOString()).slice(0, 10);

  try {
    // Idempotency: if an invoice with this reference already exists, return it.
    const existing = await xeroApi(biz, `/Invoices?where=${encodeURIComponent(`Reference=="${reference}"`)}`);
    const prior = existing && existing.Invoices && existing.Invoices[0];
    if (prior) {
      return json(200, {
        invoiceID: prior.InvoiceID, invoiceNumber: prior.InvoiceNumber,
        status: prior.Status, idempotent: true
      });
    }

    const contactId = await getPosContactId(biz);

    const invoicePayload = {
      Invoices: [{
        Type: 'ACCREC',
        Status: 'AUTHORISED',
        Contact: { ContactID: contactId },
        Date: dateStr,
        DueDate: dateStr,
        Reference: reference,
        LineAmountTypes: 'Inclusive', // till prices already include 15% VAT
        LineItems: lines.map((li) => ({
          Description: li._description || li._sku || 'Item',
          Quantity: Number(li.unitQuantity) || 1,
          UnitAmount: Number(li.unitPrice) || 0,
          AccountCode: cfg.revenueAccount,
          ...(cfg.taxType ? { TaxType: cfg.taxType } : {})
        }))
      }]
    };

    const invRes = await xeroApi(biz, '/Invoices', { method: 'POST', body: invoicePayload });
    const invoice = invRes.Invoices[0];

    // Apply payment for the full amount so the invoice is settled.
    const payRes = await xeroApi(biz, '/Payments', {
      method: 'POST',
      body: {
        Payments: [{
          Invoice: { InvoiceID: invoice.InvoiceID },
          Account: { Code: cfg.bankAccount },
          Date: dateStr,
          Amount: Number(sale.total) || invoice.Total,
          Reference: (sale.SalePayments?.SalePayment?.[0]?._cardRef) || 'POS card'
        }]
      }
    });

    return json(200, {
      invoiceID: invoice.InvoiceID,
      invoiceNumber: invoice.InvoiceNumber,
      status: invoice.Status,
      paymentID: payRes.Payments?.[0]?.PaymentID || null
    });
  } catch (e) {
    return json(e.status === 401 ? 401 : 502, { error: e.message });
  }
};
