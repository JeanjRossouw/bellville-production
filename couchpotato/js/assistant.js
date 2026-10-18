// The help assistant: a "?" button on every screen that opens a small chat.
// Questions go to the factory-assistant function (store.askAssistant), which
// answers from the app's own guide. The chat stays for this browser tab.
import * as store from './store.js';
import { esc } from './ui.js';

const KEY = 'cp-assistant-chat';
let chat = [];
let busy = false;
let screenName = () => '';

function load() { try { chat = JSON.parse(sessionStorage.getItem(KEY) || '[]').slice(-30); } catch (e) { chat = []; } }
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(chat.slice(-30))); } catch (e) {} }

// Answers are short markdown: keep it to bold, lists and line breaks.
function fmt(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

function paint() {
  const log = document.getElementById('as-log'); if (!log) return;
  log.innerHTML = (chat.length ? '' : `<div class="as-msg bot">Hi! Ask me how to do anything in the app, e.g. <em>“How do I order fabric for an order?”</em> or <em>“How do I give a customer a refund?”</em></div>`)
    + chat.map(m => `<div class="as-msg ${m.role === 'user' ? 'me' : m.error ? 'bot err' : 'bot'}">${fmt(m.content)}</div>`).join('')
    + (busy ? '<div class="as-msg bot as-typing">Thinking…</div>' : '');
  log.scrollTop = log.scrollHeight;
  const send = document.getElementById('as-send'); if (send) send.disabled = busy;
}

async function ask(q) {
  q = String(q || '').trim();
  if (!q || busy) return;
  chat.push({ role: 'user', content: q }); busy = true; save(); paint();
  try {
    const history = chat.filter(m => !m.error).map(m => ({ role: m.role, content: m.content }));
    const r = await store.askAssistant(history, screenName());
    chat.push({ role: 'assistant', content: r.answer || '' });
  } catch (e) {
    chat.push({ role: 'assistant', content: e.message || 'The assistant could not answer.', error: true });
  }
  busy = false; save(); paint();
}

export function startAssistant(currentScreen) {
  if (currentScreen) screenName = currentScreen;
  if (document.getElementById('as-fab')) return;
  load();
  document.body.insertAdjacentHTML('beforeend', `
    <button id="as-fab" class="as-fab" title="Help: ask how to do something" aria-label="Help assistant">?</button>
    <div id="as-panel" class="as-panel" hidden role="dialog" aria-label="Help assistant">
      <div class="as-head"><strong>Help</strong><span class="muted">Ask how to do anything in the app</span>
        <button class="icon-btn" id="as-clear" title="Start a new chat">↺</button><button class="icon-btn" id="as-close" title="Close">✕</button></div>
      <div class="as-log" id="as-log"></div>
      <form class="as-form" id="as-form"><textarea id="as-q" rows="2" placeholder="Type your question…" maxlength="2000"></textarea><button class="btn primary" id="as-send" type="submit">Ask</button></form>
    </div>`);
  const panel = document.getElementById('as-panel'), q = document.getElementById('as-q');
  document.getElementById('as-fab').addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) { paint(); q.focus(); } });
  document.getElementById('as-close').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('as-clear').addEventListener('click', () => { if (busy) return; chat = []; save(); paint(); });
  document.getElementById('as-form').addEventListener('submit', (e) => { e.preventDefault(); const v = q.value; q.value = ''; ask(v); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('as-form').requestSubmit(); } });
}
export function stopAssistant() {
  ['as-fab', 'as-panel'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
}
