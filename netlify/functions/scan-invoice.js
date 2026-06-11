// Netlify Function: read a supplier invoice photo and return structured GRV line items.
// The Anthropic API key stays server-side (Netlify env var ANTHROPIC_API_KEY) — never in the browser.
// Zero-dependency: uses the built-in fetch (Netlify runs Node 18+), so it deploys with no npm install.

const MODEL = 'claude-opus-4-8'; // capable vision model; switch to claude-sonnet-4-6 / claude-haiku-4-5 to cut cost

const SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: 'string', description: 'Supplier / company name on the invoice' },
    invoice: { type: 'string', description: 'Invoice or document number' },
    date: { type: 'string', description: 'Invoice date as YYYY-MM-DD if visible, else empty string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', description: "Supplier's stock/product code for the line, else empty string" },
          description: { type: 'string', description: 'Item description' },
          qty: { type: 'number', description: 'Quantity received' },
          unit: { type: 'string', description: 'Unit of measure (e.g. Each, m, length, box) — empty string if unknown' },
          unitCost: { type: 'number', description: 'Unit price EX VAT (per single unit, excluding VAT). 0 if not visible.' }
        },
        required: ['code', 'description', 'qty', 'unit', 'unitCost'],
        additionalProperties: false
      }
    }
  },
  required: ['supplier', 'invoice', 'date', 'lines'],
  additionalProperties: false
};

const PROMPT = `You are reading a photo of a supplier delivery note or invoice for a furniture factory.
Extract every physical stock line item into the structured schema.
- unitCost must be the price PER SINGLE UNIT and EXCLUDING VAT (ex VAT). Invoices usually print the ex-VAT unit price in the line table — use that. Do NOT use the VAT-inclusive total. If only a line total is shown, divide by the quantity to get the unit cost.
- qty is the quantity received for that line.
- code is the supplier's own stock/product code if one is printed next to the line; otherwise empty string.
- Skip non-stock lines such as VAT, subtotal, total, delivery/freight charges, and any notes.
- If a field is not visible, use an empty string (or 0 for numbers). Never invent values.`;

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return resp(200, {});
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return resp(500, { error: 'ANTHROPIC_API_KEY is not set on the Netlify site.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Invalid request body' }); }

  const dataUrl = body.image || '';
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([\s\S]+)$/.exec(dataUrl);
  if (!m) return resp(400, { error: 'image must be a base64 image data URL' });
  const mediaType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  const b64 = m[2];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });

    const data = await r.json();
    if (!r.ok) return resp(502, { error: (data && data.error && data.error.message) || ('Anthropic API error ' + r.status) });
    if (data.stop_reason === 'refusal') return resp(422, { error: 'The model declined to read this image.' });
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const parsed = JSON.parse(textBlock ? textBlock.text : '{}');
    return resp(200, parsed);
  } catch (e) {
    console.error('scan-invoice failed:', e);
    return resp(502, { error: (e && e.message) ? e.message : 'Scan failed' });
  }
};
