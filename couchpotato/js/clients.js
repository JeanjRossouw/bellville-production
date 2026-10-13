// The app owner's view of every company: who is on trial, who is paying,
// who has free access. Shown as the Clients tab in the app and as the whole
// of the owner's own page (admin.html). Only logins listed in the database's
// admins collection can read the companies at all, so nobody else sees this.
import * as store from './store.js';
import { PRODUCT, TRIAL_DAYS } from './config.js';
import { esc, money, toast } from './ui.js';

let clients = [];
let plan = null;

export const setClients = (rows) => { clients = rows || []; };
export const setClientPlan = (p) => { plan = p || null; };
export const allClients = () => clients;

const longDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

// Where a company stands: on trial, paying, free, cancelled or unpaid.
export function stateOf(c, now = Date.now()) {
  if (c.status === 'free') return ['Free', ''];
  const trialEnd = c.trialEndsAt ? Date.parse(c.trialEndsAt) : (Date.parse(c.createdAt || '') || now) + TRIAL_DAYS * 86400000;
  if (c.status === 'trial') return now < trialEnd ? ['Trial · ' + Math.ceil((trialEnd - now) / 86400000) + 'd left', ''] : ['Trial ended', 'red'];
  if (c.paidUntil && now < Date.parse(c.paidUntil)) return [c.status === 'cancelled' ? 'Cancelled · until ' + longDate(c.paidUntil) : 'Paying', c.status === 'cancelled' ? 'amber' : 'green'];
  return ['Unpaid', 'red'];
}

export function renderClients(host) {
  const now = Date.now();
  const p = plan || { amount: 2999 };
  const rows = clients.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const paying = rows.filter(c => c.status === 'active' && c.paidUntil && now < Date.parse(c.paidUntil)).length;
  const trials = rows.filter(c => stateOf(c, now)[0].startsWith('Trial ·')).length;
  const tile = (n, label) => `<div class="tile"><div class="tile-n">${esc(String(n))}</div><div class="tile-l">${esc(label)}</div></div>`;
  host.innerHTML = `
    <div class="page-head"><div><h1>Clients</h1><p class="sub">Every company on ${esc(PRODUCT.name)}. Only you see this.</p></div></div>
    <div class="tiles">${tile(rows.length, 'Companies')}${tile(paying, 'Paying')}${tile(trials, 'On trial')}<div class="tile wide"><div class="tile-n">${esc(money(paying * (Number(p.amount) || 0), 'R'))}</div><div class="tile-l">Monthly income</div></div></div>
    <div class="card">
      ${rows.map(c => { const [st, cls] = stateOf(c, now); return `<div class="team-row client-row">
        <div><div class="who-n">${esc(c.name || '(no name)')}</div><div class="who-e">${esc([c.ownerEmail, c.createdAt ? 'since ' + longDate(c.createdAt) : '', c.lastPaymentAt ? 'last paid ' + longDate(c.lastPaymentAt) : ''].filter(Boolean).join(' · '))}</div></div>
        <div><span class="chip ${cls === 'green' ? 'st-disp' : cls === 'red' ? 'late' : cls === 'amber' ? 'st-ready' : ''}">${esc(st)}</span></div>
        <div class="team-acts">
          ${c.status === 'trial' ? `<button class="btn ghost sm" data-act="client-extend" data-id="${esc(c.id)}">+14 days trial</button>` : ''}
          <button class="btn ghost sm" data-act="client-free" data-id="${esc(c.id)}">${c.status === 'free' ? 'End free access' : 'Give free access'}</button>
        </div>
      </div>`; }).join('') || '<p class="muted">No companies yet.</p>'}
    </div>`;
}

export async function clientExtend(id) {
  const c = clients.find(x => x.id === id); if (!c) return;
  const now = Date.now();
  const end = c.trialEndsAt ? Date.parse(c.trialEndsAt) : (Date.parse(c.createdAt || '') || now) + TRIAL_DAYS * 86400000;
  const next = new Date(Math.max(end, now) + 14 * 86400000);
  if (!confirm('Extend the trial for ' + (c.name || 'this company') + ' to ' + longDate(next.toISOString()) + '?')) return;
  try { await store.sellerUpdateCompany(id, { trialEndsAt: next.toISOString() }); toast('Trial extended'); }
  catch (e) { toast('Could not extend: ' + e.message, 'warn'); }
}

export async function clientFree(id) {
  const c = clients.find(x => x.id === id); if (!c) return;
  const on = c.status !== 'free';
  // ending free access: back to paying if paid up, otherwise a trial that has ended
  const back = c.paidUntil && Date.parse(c.paidUntil) > Date.now() ? 'active' : 'trial';
  if (!confirm(on ? 'Give ' + (c.name || 'this company') + ' free access with no payments?' : 'End free access for ' + (c.name || 'this company') + '?')) return;
  const patch = on ? { status: 'free' } : { status: back, ...(back === 'trial' ? { trialEndsAt: new Date().toISOString() } : {}) };
  try { await store.sellerUpdateCompany(id, patch); toast(on ? 'Free access given' : 'Free access ended'); }
  catch (e) { toast('Could not change: ' + e.message, 'warn'); }
}
