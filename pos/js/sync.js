// Retail POS — working with the line down. The till's number blocks are
// fetched while online and kept locally; a sale finished offline goes into
// the outbox with the number it took, and is sent in order when the line is
// back. The banner says what is waiting. A sale the server refuses on
// replay is kept for a manager and its number voided.
import { API } from './config.js';
import * as auth from './auth.js';
import * as outbox from './outbox.js';
import { esc, toast } from './ui.js';

export const sync = { online: typeof navigator === 'undefined' ? true : navigator.onLine, queued: 0, failed: 0, sending: false, numbersLeft: null, lastSyncAt: '' };
let ctx = { repaint() {}, storeId: () => '' };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const storeId = () => (auth.session.device && auth.session.device.storeId) || ctx.storeId();

export async function refreshCounts() {
  const sid = storeId(); if (!sid) return;
  const c = await outbox.counts(sid); sync.queued = c.queued; sync.failed = c.failed;
  sync.numbersLeft = await outbox.numbersLeft(sid);
  ctx.repaint();
}
// the till's blocks from the server (it issues the next one early when few remain)
let blocksInFlight = null;
export function refreshBlocks() {
  if (!auth.session.device) return Promise.resolve();
  if (blocksInFlight) return blocksInFlight;        // two asks at once would get two blocks
  blocksInFlight = (async () => {
    try {
      const r = await auth.api('blocks', auth.deviceBody(), API.sale);
      const inv = r.blocks && r.blocks.INV;
      if (inv && inv.list) await outbox.saveBlocks(auth.session.device.storeId, 'INV', { blocks: inv.list, prefix: inv.prefix });
      sync.online = true;
    } catch (e) { if (e.offline) sync.online = false; }
    blocksInFlight = null;
    await refreshCounts();
  })();
  return blocksInFlight;
}
export const nextNumber = () => outbox.nextNumber(storeId());
export async function enqueue(entry) { await outbox.queue({ ...entry, storeId: storeId() }); for (const m of entry.stockMoves || []) await outbox.offsetStock(storeId(), m.itemId, m.qty); await refreshCounts(); }

// send what is waiting, oldest first; stop at the first sign the line is down again
export async function syncNow() {
  if (sync.sending || !auth.session.device) return;
  const list = (await outbox.queued()).filter(x => x.status !== 'failed' && x.storeId === storeId());
  if (!list.length) return refreshCounts();
  sync.sending = true; ctx.repaint();
  let sent = 0;
  for (const x of list) {
    try {
      await auth.api('commit', x.body, API.sale);
      await outbox.remove(x.saleId);
      for (const m of x.stockMoves || []) await outbox.offsetStock(x.storeId, m.itemId, -m.qty);
      sent++;
    } catch (e) {
      if (e.offline) { sync.online = false; break; }
      if (e.status >= 400 && e.status < 500) {
        x.status = 'failed'; x.error = e.message; x.tries = (x.tries || 0) + 1; await outbox.update(x);
        for (const m of x.stockMoves || []) await outbox.offsetStock(x.storeId, m.itemId, -m.qty);
        try { await auth.api('voidNumber', { ...auth.deviceBody(), seq: x.seq, reason: 'refused: ' + String(e.message).slice(0, 100) }, API.sale); } catch (_) {}
        toast('Sale ' + x.docNo + ' was refused by the office: ' + e.message, 'warn');
      } else { x.tries = (x.tries || 0) + 1; await outbox.update(x); break; }   // a server hiccup: later
    }
  }
  sync.sending = false; sync.lastSyncAt = new Date().toISOString();
  if (sent) toast(sent + ' offline sale' + (sent === 1 ? '' : 's') + ' sent');
  await refreshBlocks();
}
export function watchNetwork() {
  window.addEventListener('online', () => { sync.online = true; ctx.repaint(); syncNow(); });
  window.addEventListener('offline', () => { sync.online = false; ctx.repaint(); });
  setInterval(() => { if (sync.online && sync.queued && !sync.sending) syncNow(); }, 30000);
}
export function bannerHtml() {
  if (!auth.session.user) return '';
  if (!sync.online) return `<span>Offline</span>${sync.queued ? `<span>· ${sync.queued} sale${sync.queued === 1 ? '' : 's'} waiting to send</span>` : ''}${sync.numbersLeft != null ? `<span class="muted">· ${sync.numbersLeft} numbers left</span>` : ''}`;
  if (sync.sending) return `<span>Sending ${sync.queued} offline sale${sync.queued === 1 ? '' : 's'}…</span>`;
  if (sync.queued) return `<span>Back online · ${sync.queued} sale${sync.queued === 1 ? '' : 's'} waiting</span><button class="btn sm" data-act="sync-now">Send now</button>`;
  if (sync.failed) return `<span>${sync.failed} offline sale${sync.failed === 1 ? '' : 's'} refused by the office</span><button class="btn sm" data-act="sync-failed">See them</button>`;
  return '';
}
export const bannerClass = () => !sync.online ? 'offline-bar' : sync.queued || sync.sending ? 'offline-bar ok' : 'offline-bar';
// the refused ones, for a manager
export async function failedList() { return (await outbox.queued()).filter(x => x.status === 'failed'); }
export async function dropFailed(saleId) { await outbox.remove(saleId); await refreshCounts(); }
export async function stockOffsets() { const sid = storeId(); return sid ? outbox.stockOffsets(sid) : {}; }
