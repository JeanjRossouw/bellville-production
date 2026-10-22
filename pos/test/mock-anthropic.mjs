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
        const blocks = Array.isArray(lastUser.content) ? lastUser.content : [];
        const reply = (content, stop) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } })); };
        // after a tool round: a text answer that quotes the results, so a test can see what the tool returned
        const results = blocks.filter(b => b.type === 'tool_result');
        if (results.length) return reply([{ type: 'text', text: 'Mock answer after tools: ' + results.map(r => (r.is_error ? 'ERROR ' : '') + String(r.content).slice(0, 400)).join(' | ') }], 'end_turn');
        const q = typeof lastUser.content === 'string' ? lastUser.content : blocks.map(b => b.text || '').join(' ');
        // "[tool:NAME {json}]" in the question: the mock calls that tool, the way the model would
        const m = /\[tool:(\w+)\s*(\{[\s\S]*\})?\]/.exec(q);
        if (m && Array.isArray(j.tools) && j.tools.some(t => t.name === m[1])) { let input = {}; try { input = m[2] ? JSON.parse(m[2]) : {}; } catch {} return reply([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_mock_' + Date.now().toString(36), name: m[1], input }], 'tool_use'); }
        return reply([{ type: 'text', text: 'Mock answer to: ' + q.replace(/^\([^)]*\)\s*/, '') }], 'end_turn');
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, last: () => last, close: () => new Promise(r => server.close(r)) })));
}
if (process.argv[1] && process.argv[1].endsWith('mock-anthropic.mjs')) startMockAnthropic().then(() => console.log('mock anthropic on 8798'));
