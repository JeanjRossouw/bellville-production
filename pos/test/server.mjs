// Serves the repo as static files and runs the pos-* Netlify functions
// against the local emulators, on port 8788. node posserver.mjs <repo>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
// the factory's helpers read the project id from the key; on the emulator no key is used
process.env.FACTORY_SERVICE_ACCOUNT = process.env.FACTORY_SERVICE_ACCOUNT || JSON.stringify({ project_id: 'factory-manager-ece82', client_email: 'emulator@test', private_key: '' });
process.env.SHOPIFY_API_BASE = process.env.SHOPIFY_API_BASE || 'http://127.0.0.1:8799';   // the tests' mock Shopify
const ROOT = process.argv[2];
const fns = {};
async function fn(name) { if (!fns[name]) fns[name] = (await import(path.join(ROOT, 'netlify/functions', name + '.mjs'))).handler; return fns[name]; }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
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
