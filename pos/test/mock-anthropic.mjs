// A stand-in for the Anthropic API for the tests (ANTHROPIC_BASE_URL): it
// keeps the last request it was sent and answers with a canned message that
// echoes the question, so a test can see what reached the model.
import http from 'node:http';

export function startMockAnthropic(port = 8798) {
  let last = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/last') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(last)); return; }
      if (req.method === 'POST' && /\/v1\/messages/.test(req.url)) {
        let j = {}; try { j = JSON.parse(body); } catch {}
        last = { headers: req.headers, body: j };
        if (String(j.model || '').includes('fail')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock failure' } })); return; }
        const msgs = j.messages || [];
        const lastUser = msgs.length ? msgs[msgs.length - 1] : { content: '' };
        const q = typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content || []).map(b => b.text || '').join(' ');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'Mock answer to: ' + q.replace(/^\([^)]*\)\s*/, '') }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, last: () => last, close: () => new Promise(r => server.close(r)) })));
}
if (process.argv[1] && process.argv[1].endsWith('mock-anthropic.mjs')) startMockAnthropic().then(() => console.log('mock anthropic on 8798'));
