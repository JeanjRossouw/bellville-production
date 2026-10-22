// Retail POS — the assistant on the page: a "?" button on every screen that
// opens a small chat. Questions go to the pos-assist function, which answers
// from the POS guide and the store's live figures (today against last week,
// low stock, open orders and lay-bys). The chat stays for this browser tab
// and is cleared when someone signs out.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast } from './ui.js';
import { whatsappUrl } from './receipt.js';

const KEY = 'pos-assist-chat';
let chat = [];
let busy = false;
let ctx = { screen: () => '', where: () => ({}) };

function load() { try { chat = JSON.parse(sessionStorage.getItem(KEY) || '[]').slice(-30); } catch (e) { chat = []; } }
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(chat.slice(-30))); } catch (e) {} }

// answers are short markdown: bold, lists and line breaks are enough
function fmt(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^[-•] (.*)$/gm, '• $1').replace(/\n/g, '<br>');
}
const STARTERS = ['What should I reorder?', 'Which orders need a call?', 'How is today going against last week?', 'How do I do a return without a receipt?'];

function paint() {
  const log = document.getElementById('as-log'); if (!log) return;
  log.innerHTML = (chat.length ? '' : `<div class="as-msg bot">Hi! Ask me how to do anything on the till, or for help planning from the store's figures.<div class="as-starters">${STARTERS.map(s => `<button type="button" class="btn ghost sm" data-ask="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`)
    + chat.map((m, i) => `<div class="as-msg ${m.role === 'user' ? 'me' : m.error ? 'bot err' : 'bot'}">${fmt(m.content)}${(m.cards || []).map((c, j) => cardHtml(c, i, j)).join('')}</div>`).join('')
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
    const r = await auth.api('ask', { messages: history, screen: ctx.screen(), ...ctx.where() }, API.assist);
    chat.push({ role: 'assistant', content: r.answer || '', cards: (r.cards || []).filter(Boolean) });
  } catch (e) {
    chat.push({ role: 'assistant', content: e.offline ? 'The assistant needs the line: try again when connected.' : (e.message || 'The assistant could not answer.'), error: true });
  }
  busy = false; save(); paint();
}

// a proposal (orders or tasks to create on a tap) or the customers to message, under the answer
function cardHtml(c, i, j) {
  if (c.type === 'proposal') return `<div class="as-card"><strong>${esc(c.title)}</strong><ul>${(c.lines || []).map(l => `<li>${esc(l)}</li>`).join('')}</ul>${c.done ? `<div class="as-done">${esc(c.done)}</div>` : `<button type="button" class="btn primary sm" data-confirm="${esc(c.id)}" data-i="${i}" data-j="${j}">${esc(c.confirmLabel || 'Go ahead')}</button>`}</div>`;
  if (c.type === 'updates') return `<div class="as-card"><strong>${esc(c.title)}</strong>${(c.items || []).map((x, k) => `<div class="as-upd"><div><strong>${esc(x.customer || '')}</strong> · ${esc(x.docNo)} <span class="muted">${esc(x.why)}</span><div class="muted as-upd-text">${esc(x.text)}</div></div>${x.sent ? '<span class="chip ok">sent</span>' : x.phone ? `<button type="button" class="btn sm" data-wa="${i}:${j}:${k}">WhatsApp</button>` : '<span class="chip">no number</span>'}</div>`).join('')}</div>`;
  return '';
}
const whereFull = () => auth.session.device ? auth.deviceBody() : { ...ctx.where(), registerId: '' };
async function onCardClick(e) {
  const c = e.target.closest('[data-confirm]');
  if (c) {
    const card = (chat[Number(c.dataset.i)].cards || [])[Number(c.dataset.j)]; if (!card || busy) return;
    busy = true; c.disabled = true; paint();
    try { const r = await auth.api('confirm', { proposalId: card.id, ...whereFull() }, API.assist); card.done = r.message || 'Done.'; chat.push({ role: 'assistant', content: r.message || 'Done.' }); if (ctx.onChange) ctx.onChange(r); }
    catch (err) { chat.push({ role: 'assistant', content: err.message || 'That did not go through.', error: true }); }
    busy = false; save(); paint(); return;
  }
  const w = e.target.closest('[data-wa]');
  if (w) {
    const [i, j, k] = w.dataset.wa.split(':').map(Number);
    const card = (chat[i].cards || [])[j]; const item = card && card.items[k]; if (!item) return;
    try {
      const r = await auth.api(item.send.action, { ...item.send.body, ...whereFull() }, API[item.send.api]);
      window.open(whatsappUrl(r.phone || item.phone, r.text || item.text), '_blank');
      item.sent = true; save(); paint();
      if (ctx.onChange) ctx.onChange(r);
    } catch (err) { toast(err.message || 'Could not send.', 'warn'); }
  }
}
// `screen` says which tab is open; `where` gives the entity and store the figures are for
export function startAssistant(screen, where, onChange) {
  if (screen) ctx.screen = screen;
  if (where) ctx.where = where;
  if (onChange) ctx.onChange = onChange;
  if (document.getElementById('as-fab')) return;
  load();
  // the button sits in the top bar next to Lock, so it never covers the cart or a tile; the panel floats
  const bar = document.getElementById('lock');
  const btn = '<button id="as-fab" class="as-fab in-bar" title="Assistant: ask how to do something, or for help planning" aria-label="Assistant" type="button">?</button>';
  if (bar && bar.parentElement) bar.insertAdjacentHTML('beforebegin', btn); else document.body.insertAdjacentHTML('beforeend', btn.replace(' in-bar', ''));
  document.body.insertAdjacentHTML('beforeend', `
    <div id="as-panel" class="as-panel" hidden role="dialog" aria-label="Assistant">
      <div class="as-head"><strong>Assistant</strong><span class="muted">The till, and planning from today's figures</span>
        <button class="icon-btn" id="as-clear" title="Start a new chat" type="button">↺</button><button class="icon-btn" id="as-close" title="Close" type="button">✕</button></div>
      <div class="as-log" id="as-log"></div>
      <form class="as-form" id="as-form"><textarea id="as-q" rows="2" placeholder="Type your question…" maxlength="2000"></textarea><button class="btn primary" id="as-send" type="submit">Ask</button></form>
    </div>`);
  const panel = document.getElementById('as-panel'), q = document.getElementById('as-q');
  document.getElementById('as-fab').addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) { paint(); q.focus(); } });
  document.getElementById('as-close').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('as-clear').addEventListener('click', () => { if (busy) return; chat = []; save(); paint(); });
  document.getElementById('as-log').addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) return ask(b.dataset.ask); onCardClick(e); });
  document.getElementById('as-form').addEventListener('submit', (e) => { e.preventDefault(); const v = q.value; q.value = ''; ask(v); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('as-form').requestSubmit(); } });
}
export function stopAssistant() {
  ['as-fab', 'as-panel'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  chat = []; try { sessionStorage.removeItem(KEY); } catch (e) {}     // the next person starts a fresh chat
}
