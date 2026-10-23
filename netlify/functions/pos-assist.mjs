// Retail POS — the assistant on the page: answers how the system works
// (from lib/pos-guide.mjs), helps plan from the store's live figures, and
// has hands (lib/assist-tools.mjs): it can look at low stock by supplier,
// propose draft purchase orders, list the customers who should hear from
// the store with the messages written, and propose tasks. A proposal comes
// back as a card; nothing is written until the person taps it (confirm).
//
//   ask     { messages: [ { role: 'user'|'assistant', content } ], screen, entityId, storeId }
//           Authorization: Bearer <POS login>   → { answer, cards, used, limit }
//   confirm { proposalId, entityId, storeId }   → { kind, made, message }
//     401 sign in · 429 the day's questions are used up · 503 not set up
//
// Everyone signed in may ask (each question costs money): POS_ASSIST_PER_DAY
// questions a day per login (60), counted in assistantUse/<uid> (server only).
// Money figures go to supervisors and up; cashiers get counts and the orders.
//
// Env: ANTHROPIC_API_KEY, FACTORY_SERVICE_ACCOUNT, POS_GROUP_ID (optional), POS_ASSIST_PER_DAY (optional).
import Anthropic from '@anthropic-ai/sdk';
import { json, Reject, clean, nowIso, getDoc, query, patchDoc, bodyOf, requireMember, inEntity, inStore, rank } from './lib/pos.mjs';
import { whoAndWhere } from './lib/sale.mjs';
import { GUIDE } from './lib/pos-guide.mjs';
import { TOOLS, runTool, confirmProposal } from './lib/assist-tools.mjs';
import { STATUS_LABEL, SALES_LABEL } from '../../pos/js/special-terms.js';

const PER_DAY = () => Math.max(1, Number(process.env.POS_ASSIST_PER_DAY) || 60);
const MAX_TURNS = 12;
const MAX_CHARS = 2000;
const MAX_TOOL_ROUNDS = 5;
const rands = (c) => 'R ' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // as the till prints it: R 7,500.00

const SYSTEM = `You are the assistant inside the retail POS ("the till") of a South African furniture and homeware group. You help the people using it: cashiers, supervisors, managers and the owner, at the store or in the office.

Three jobs. First, how the system works: answer from the guide below, saying exactly where to tap (tab → button), in short numbered steps when there is more than one. Second, planning: the store's live figures are given after the guide; use them to answer what to reorder, what is due, which orders need a call, how today compares, and to suggest a plan when asked. Quote the figures you were given; do not invent any. If a figure is not there, say where in the app to look (Reports, Stock, Home). Third, doing: you have tools. To suggest an order, call low_stock_by_supplier, then propose_purchase_orders with sensible quantities (the suggested ones unless the person says otherwise). To get customers told, call customers_to_contact. To plan work, call propose_tasks. Tasks and orders you propose are NOT created until the person taps the card under your answer: say so, and never claim something was created or sent. Keep proposals modest: only what the figures support.

Plain words a busy shop assistant understands; short answers (a few lines) unless they ask for more. South African English and rands (R). If the guide does not cover something, say so rather than guessing at buttons. Never ask for or repeat anyone's PIN or password. Questions not about the shop: answer briefly if you can.

${GUIDE}`;

// the chat as the browser sent it: text only, alternating, starting with the person, the last few turns
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

const saDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const range = (field, from, to) => [{ field, op: 'GREATER_THAN_OR_EQUAL', value: from + 'T00:00:00.000Z' }, { field, op: 'LESS_THAN_OR_EQUAL', value: to + 'T23:59:59.999Z' }];
const sum = (rows, k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);

// the store as it stands now, in a few lines the model can quote
export async function snapshot(user, entityId, storeId) {
  const money = rank(user.role) >= rank('supervisor');
  const [entity, store] = await Promise.all([getDoc('entities', entityId), getDoc('stores', storeId)]);
  if (!entity || !store) return '';
  const today = saDay(), lastWeek = saDay(new Date(Date.now() - 7 * 86400000));
  const inStoreQ = [{ field: 'entityId', value: entityId }, { field: 'storeId', value: storeId }];
  const [salesToday, salesLast, notesToday, registers, laybys, specials, salesOrders, levels, products, takes, tasks] = await Promise.all([
    query('sales', [...inStoreQ, ...range('clientCreatedAt', today, today)], 2000),
    query('sales', [...inStoreQ, ...range('clientCreatedAt', lastWeek, lastWeek)], 2000),
    query('creditNotes', [...inStoreQ, ...range('clientCreatedAt', today, today)], 500),
    query('registers', inStoreQ, 50),
    query('laybys', [...inStoreQ, { field: 'status', value: 'open' }], 1000),
    query('specialOrders', inStoreQ, 1000),
    query('salesOrders', inStoreQ, 1000),
    query('stockLevels', inStoreQ, 3000),
    query('products', [{ field: 'entityId', value: entityId }], 3000),
    query('stockTakes', [...inStoreQ, { field: 'status', value: 'open' }], 20),
    query('tasks', [...inStoreQ, { field: 'status', value: 'open' }], 200)
  ]);
  const lines = [];
  lines.push(`Store: ${store.name} (${entity.tradingName || entity.legalName}). Today: ${today}. You are talking to ${user.name}, ${user.role}.`);
  const fig = (g) => `${g.length} sale${g.length === 1 ? '' : 's'}` + (money ? `, ${rands(sum(g, 'totalCents'))}` + (g.length ? `, average basket ${rands(sum(g, 'totalCents') / g.length)}` : '') : '');
  lines.push(`Today so far: ${fig(salesToday)}${notesToday.length ? `; ${notesToday.length} credit note${notesToday.length === 1 ? '' : 's'}` + (money ? ` (${rands(sum(notesToday, 'totalCents'))})` : '') : ''}. Same weekday last week (${lastWeek}): ${fig(salesLast)}.`);
  const open = registers.filter(r => r.currentShiftId);
  lines.push(`Registers: ${registers.length}; open now: ${open.length ? open.map(r => r.name).join(', ') : 'none'}.`);
  const week = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const dueSoon = laybys.filter(l => l.dueAt && l.dueAt.slice(0, 10) <= week);
  lines.push(`Open lay-bys: ${laybys.length}${money ? `, balance owed ${rands(sum(laybys, 'balanceCents'))}` : ''}; ${dueSoon.length} due within 7 days${dueSoon.length ? ' (' + dueSoon.slice(0, 8).map(l => `${l.docNo} ${(l.customerSnapshot || {}).name || ''} by ${String(l.dueAt).slice(0, 10)}`).join('; ') + ')' : ''}.`);
  const openSpecials = specials.filter(o => ['quoted', 'depositPaid', 'inProduction', 'ready'].includes(o.status)).sort((a, b) => String(a.expectedAt).localeCompare(String(b.expectedAt)));
  lines.push(`Custom orders open: ${openSpecials.length}${openSpecials.length ? ' — ' + openSpecials.slice(0, 12).map(o => `${o.docNo} ${(o.customerSnapshot || {}).name || ''}: ${(o.lines || []).map(l => l.qty + ' × ' + l.name).join(', ')}, ${STATUS_LABEL[o.status] || o.status}${o.factoryRef ? ' (factory ' + o.factoryRef + ')' : o.status !== 'quoted' ? ' (not sent to the factory: a supervisor sends it)' : ''}, expected ${o.expectedAt}${money && o.balanceCents ? ', balance ' + rands(o.balanceCents) : ''}${o.updateDue ? ', update to send' : ''}`).join('; ') : ''}.`);
  const openSales = salesOrders.filter(o => ['open', 'inProduction', 'ready'].includes(o.status)).sort((a, b) => String(a.expectedAt).localeCompare(String(b.expectedAt)));
  lines.push(`Sales orders open: ${openSales.length}${openSales.length ? ' — ' + openSales.slice(0, 12).map(o => `${o.docNo} ${(o.customerSnapshot || {}).name || ''}: ${(o.lines || []).map(l => l.qty + ' × ' + l.name).join(', ')}, ${SALES_LABEL[o.status] || o.status}${o.factoryRef ? ' (factory ' + o.factoryRef + ')' : ' (not sent to the factory: a supervisor sends it)'}, expected ${o.expectedAt}${o.updateDue ? ', update to send' : ''}`).join('; ') : ''}.`);
  const byItem = new Map(levels.map(l => [l.variantId || l.productId, l]));
  const low = [];
  for (const p of products) {
    if (p.archived || p.reorderLevel == null || p.type !== 'stock') continue;
    const lv = byItem.get(p.id) || { onHandQty: 0, reservedQty: 0, onOrderQty: 0 };
    const available = (lv.onHandQty || 0) - (lv.reservedQty || 0);
    if (available + (lv.onOrderQty || 0) <= p.reorderLevel) low.push({ name: p.name, available, onOrder: lv.onOrderQty || 0, level: p.reorderLevel, suggest: Math.max(1, p.reorderQty || (p.reorderLevel - available - (lv.onOrderQty || 0) + 1)) });
  }
  low.sort((a, b) => (a.available - a.level) - (b.available - b.level));
  lines.push(`Low stock (at or under the reorder point): ${low.length}${low.length ? ' — ' + low.slice(0, 15).map(x => `${x.name}: ${x.available} available${x.onOrder ? ', ' + x.onOrder + ' on order' : ''}, reorder at ${x.level}, suggest ordering ${x.suggest}`).join('; ') : ''}.`);
  if (takes.length) lines.push(`Stock takes open: ${takes.map(t => t.name).join(', ')}.`);
  lines.push(`Open tasks: ${tasks.length}${tasks.length ? ' — ' + tasks.slice(0, 10).map(t => t.title + (t.due ? ' by ' + t.due : '') + (t.assigneeName ? ' (' + t.assigneeName + ')' : '')).join('; ') : ''}.`);
  return lines.join('\n');
}

// the person, their store, and the day's allowance
async function who(event, b) {
  const { uid, user } = await requireMember(event);
  const entityId = clean(b.entityId, 40), storeId = clean(b.storeId, 40);
  if (!entityId || !storeId || !inEntity(user, entityId) || !inStore(user, storeId)) throw new Reject(403, 'Pick your store first.');
  return { uid, user, entityId, storeId };
}

const actions = {
  async ask(event, b) {
    const { uid, user, entityId, storeId } = await who(event, b);
    if (!process.env.ANTHROPIC_API_KEY) throw new Reject(503, 'The assistant is not switched on yet: the owner must add ANTHROPIC_API_KEY on Netlify.');
    const messages = cleanMessages(b.messages);
    if (!messages.length) throw new Reject(400, 'Ask a question first.');

    const day = saDay();
    const use = (await getDoc('assistantUse', uid)) || {};
    const used = use.day === day ? Number(use.count) || 0 : 0;
    if (used >= PER_DAY()) throw new Reject(429, `That is all the questions for today (${PER_DAY()}). The assistant is back tomorrow.`);
    await patchDoc('assistantUse', uid, { day, count: used + 1, name: user.name, lastAt: nowIso(), entityId, storeId });

    // the context the tools work in: the same one the other functions build
    const ctx = await whoAndWhere(event, b, { noShift: true });
    let live = '';
    try { live = await snapshot(user, entityId, storeId); } catch (e) { console.error('pos-assist snapshot', e.message); }
    const where = b.screen ? `(Tab open now: ${clean(b.screen, 40)})\n\n` : '';
    messages[messages.length - 1].content = where + messages[messages.length - 1].content;

    const client = new Anthropic();
    const system = [
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },   // the guide, cached across questions
      { type: 'text', text: live ? 'The store right now:\n' + live : 'The store\'s live figures are not available just now.' }
    ];
    const cards = [];
    const convo = [...messages];
    let response;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        response = await client.beta.messages.create({
          model: 'claude-opus-5-5',
          max_tokens: 2000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low' },          // short answers at the till: quick and cheap
          system, tools: TOOLS, messages: convo
        });
        if (response.stop_reason !== 'tool_use') break;
        const uses = response.content.filter(x => x.type === 'tool_use');
        const results = [];
        for (const u of uses) {
          try {
            const r = await runTool(ctx, u.name, u.input || {});
            if (r.card) cards.push(r.card);
            results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result).slice(0, 12000) });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Could not: ' + String(e.message).slice(0, 300), is_error: true });
          }
        }
        convo.push({ role: 'assistant', content: response.content });
        convo.push({ role: 'user', content: results });
      }
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new Reject(429, 'The assistant is busy. Try again in a minute.');
      if (e instanceof Anthropic.AuthenticationError) throw new Reject(503, 'The assistant\'s API key is not valid. The owner must check ANTHROPIC_API_KEY on Netlify.');
      if (e instanceof Anthropic.APIError) { console.error('pos-assist API', e.status, e.message); throw new Reject(502, 'The assistant could not answer just now. Try again.'); }
      if (e instanceof Anthropic.APIConnectionError) { console.error('pos-assist connection', e.message); throw new Reject(502, 'The assistant could not be reached. Try again.'); }
      throw e;
    }
    if (response.stop_reason === 'refusal') return { ok: true, answer: 'Sorry, I can\'t help with that one. Ask me about the till or the store.', cards, used: used + 1, limit: PER_DAY() };
    const answer = (response.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    return { ok: true, answer: answer || (cards.length ? 'Here is what I propose: tap the card to go ahead.' : 'Sorry, I don\'t have an answer for that. Try asking it another way.'), cards, used: used + 1, limit: PER_DAY() };
  },

  // the person taps a card: the proposal is carried out in their name
  async confirm(event, b) {
    const ctx = await whoAndWhere(event, b, { noShift: true });
    return { ok: true, ...(await confirmProposal(ctx, b.proposalId)) };
  }
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const b = bodyOf(event);
    const fn = actions[b.action];
    if (!fn) return json(400, { error: 'Unknown action' });
    return json(200, await fn(event, b));
  } catch (e) {
    if (e instanceof Reject) return json(e.status, { error: e.message });
    console.error('pos-assist failed:', e);
    return json(500, { error: 'Something went wrong. Try again.' });
  }
};
