// The in-app help assistant: answers questions about using Factory Manager,
// from the guide in lib/assistant-guide.mjs, with Claude.
//
//   POST { messages: [{ role: 'user'|'assistant', content }], screen, role }
//   Authorization: Bearer <Firebase ID token>
//     → { answer }
//     → 401 sign in first · 429 the day's questions are used up · 503 not set up
//
// Only signed-in people may ask (each question costs money), and each login
// gets QUESTIONS_PER_DAY a day, counted in assistantUse/<uid> (server only).
//
// Env: ANTHROPIC_API_KEY        the Anthropic API key (Netlify environment variable)
//      FACTORY_SERVICE_ACCOUNT  the same key the other factory functions use
import Anthropic from '@anthropic-ai/sdk';
import { verifyFirebaseToken } from './lib/auth.mjs';
import { getDoc, patchDoc, projectId, serviceAccount } from './lib/factory-firestore.mjs';
import { GUIDE } from './lib/assistant-guide.mjs';

const QUESTIONS_PER_DAY = 60;
const MAX_TURNS = 12;          // the last few turns of the chat are sent, not the whole history
const MAX_CHARS = 2000;        // per message

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

const SYSTEM = `You are the help assistant inside Factory Manager, an app that runs furniture factories (orders, the factory floor, stock, the till, invoices). You help the people using it: owners, office staff, salespeople, the stock room, the floor.

Answer from the guide below. Say exactly where to tap or click (screen → button), in short numbered steps when there is more than one. Use plain words a busy factory worker understands; keep answers short (a few lines) unless they ask for more. South African English and rands (R).

If the guide does not cover something, say so plainly and suggest asking the owner or the app's support, rather than guessing at buttons that may not exist. You cannot see or change the company's data: if they ask about a specific order, customer or amount, tell them where in the app to look it up. Questions not about the app or running the factory: answer briefly and helpfully if you can.

${GUIDE}`;

// The chat as the browser sent it, cleaned: text only, alternating, starting
// with the person, the last few turns.
function cleanMessages(raw) {
  const msgs = (Array.isArray(raw) ? raw : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const out = [];
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + m.content;
    else out.push(m);
  }
  return out.length && out[out.length - 1].role === 'user' ? out : [];
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    let body = {};
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); }
    catch { return json(400, { error: 'Invalid request' }); }

    if (!process.env.ANTHROPIC_API_KEY) return json(503, { error: 'The help assistant is not switched on yet: the owner of the site must add the environment variable ANTHROPIC_API_KEY on Netlify.' });
    try { serviceAccount(); }
    catch { return json(503, { error: 'The site is not set up yet: FACTORY_SERVICE_ACCOUNT is missing on Netlify.' }); }

    const header = (event.headers || {}).authorization || (event.headers || {}).Authorization || '';
    let user;
    try { user = await verifyFirebaseToken(header.startsWith('Bearer ') ? header.slice(7) : '', projectId()); }
    catch { return json(401, { error: 'Sign in to use the help assistant.' }); }
    const uid = String(user.sub || user.user_id || '');
    if (!uid) return json(401, { error: 'Sign in to use the help assistant.' });

    const messages = cleanMessages(body.messages);
    if (!messages.length) return json(400, { error: 'Ask a question first.' });

    // the day's allowance, per login (SA date)
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const use = (await getDoc('assistantUse/' + uid)) || {};
    const used = use.day === day ? Number(use.count) || 0 : 0;
    if (used >= QUESTIONS_PER_DAY) return json(429, { error: 'That is all the questions for today (' + QUESTIONS_PER_DAY + '). The assistant is back tomorrow.' });
    await patchDoc('assistantUse/' + uid, { day, count: used + 1, email: String(user.email || '').toLowerCase(), lastAt: new Date().toISOString() });

    // where they are in the app goes after the cached guide, with the question
    const where = [body.screen ? 'Screen open now: ' + String(body.screen).slice(0, 40) : '', body.role ? 'Their role: ' + String(body.role).slice(0, 40) : ''].filter(Boolean).join('. ');
    if (where) messages[messages.length - 1].content = '(' + where + ')\n\n' + messages[messages.length - 1].content;

    const client = new Anthropic();
    let response;
    try {
      response = await client.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },          // short help answers: quick and cheap
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json(429, { error: 'The assistant is busy. Try again in a minute.' });
      if (e instanceof Anthropic.AuthenticationError) return json(503, { error: 'The help assistant\'s API key is not valid. The owner must check ANTHROPIC_API_KEY on Netlify.' });
      if (e instanceof Anthropic.APIError) { console.error('factory-assistant API', e.status, e.message); return json(502, { error: 'The assistant could not answer just now. Try again.' }); }
      throw e;
    }
    if (response.stop_reason === 'refusal') return json(200, { answer: 'Sorry, I can\'t help with that one. Ask me about using Factory Manager.' });
    const answer = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return json(200, { answer: answer || 'Sorry, I don\'t have an answer for that. Try asking it another way.' });
  } catch (e) {
    console.error('factory-assistant:', e);
    return json(500, { error: 'Something went wrong. Try again.' });
  }
};
