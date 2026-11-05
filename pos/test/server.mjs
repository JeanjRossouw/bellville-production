// Serves the repo as static files and runs the pos-* Netlify functions
// against the local emulators, on port 8788. node posserver.mjs <repo>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.POS_STANDING_CACHE_MS = '0';      // a business's standing is read fresh on every request in the tests
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
// the factory's helpers read the project id from the key; on the emulator no key is used
process.env.FACTORY_SERVICE_ACCOUNT = process.env.FACTORY_SERVICE_ACCOUNT || JSON.stringify({ project_id: 'factory-manager-ece82', client_email: 'emulator@test', private_key: '' });
process.env.SHOPIFY_API_BASE = process.env.SHOPIFY_API_BASE || 'http://127.0.0.1:8799';
process.env.ANTHROPIC_API_KEY = 'test-key';                      // the tests' mock Anthropic (pos/test/mock-anthropic.mjs), never the real API
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8798';
process.env.POS_TAKE_BATCH = '1';   // a stock take posts one variance a call, so the tests see the batches
process.env.SHOPIFY_CATALOGUE_PAGE = '1'; process.env.SHOPIFY_CATALOGUE_PAGES = '2';   // the catalogue comes two products a call, so the tests see the chunking
process.env.NOTIFY_SINK = 'http://127.0.0.1:8788/__notify';   // the SMS, email and WhatsApp providers land here (lib/notify.mjs); never the real ones
const notifySink = [];   // every message "sent": { provider, path, headers, body }
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k) && !['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'].includes(k)) delete process.env[k];
const ROOT = process.argv[2];
const fns = {};
async function fn(name) { if (!fns[name]) fns[name] = (await import(path.join(ROOT, 'netlify/functions', name + '.mjs'))).handler; return fns[name]; }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  // the providers' stand-in: a body that says FAIL is refused, the rest kept; GET reads them, DELETE clears them
  if (u.pathname.startsWith('/__notify')) {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(notifySink)); }
    if (req.method === 'DELETE') { notifySink.length = 0; res.writeHead(204); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    const provider = /bulksms|\/v1\/messages/.test(u.pathname) ? 'sms' : /\/emails/.test(u.pathname) ? 'email' : /\/messages$/.test(u.pathname) ? 'whatsapp' : 'unknown';
    const parsed = (() => { try { return JSON.parse(body); } catch (e) { return { raw: body }; } })();
    if (/FAIL/.test(body)) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'the provider said no (FAIL in the message)' })); }
    notifySink.push({ provider, path: u.pathname, auth: req.headers.authorization || '', body: parsed, at: new Date().toISOString() });
    res.writeHead(provider === 'sms' ? 201 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(provider === 'sms' ? [{ id: 'sms-' + notifySink.length }] : provider === 'email' ? { id: 'em-' + notifySink.length } : { messages: [{ id: 'wamid.' + notifySink.length }] }));
  }
  if (u.pathname.startsWith('/.netlify/functions/')) {
    const name = u.pathname.split('/').pop();
    let body = ''; for await (const c of req) body += c;
    try {
      const h = await fn(name);
      const out = await h({ httpMethod: req.method, headers: req.headers, body, isBase64Encoded: false, queryStringParameters: Object.fromEntries(u.searchParams) });
      res.writeHead(out.statusCode, out.headers || {}); return res.end(out.body || '');
    } catch (e) { console.error(e); res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(8788, () => console.log('posserver on 8788'));
