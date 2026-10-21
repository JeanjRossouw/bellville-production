// Retail POS — the outbox: sales finished with the line down, kept whole in
// IndexedDB with the number the till took from its block, and sent in
// order when the line is back. The same saleId sent twice is written once
// by the server, so a resend after a dropped answer is harmless. A sale the
// server refuses on replay is kept for a manager to see, and its number is
// voided so the series has no gap.
//
// Also here: the till's number blocks (from the server, kept locally) and
// the next free number for an offline sale.
const DB = 'pos-outbox', VERSION = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sales')) { const s = db.createObjectStore('sales', { keyPath: 'saleId' }); s.createIndex('queuedAt', 'queuedAt'); }
      if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('stock')) db.createObjectStore('stock', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
// runs fn in a transaction; when fn returns a request, the answer is that request's result (which may be nothing)
const tx = async (store, mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(store, mode); const s = t.objectStore(store); const out = fn(s); t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out); t.onerror = () => reject(t.error); }); };
const all = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
const del = (store, k) => tx(store, 'readwrite', (s) => s.delete(k));

// ---------------------------------------------------------------- sales --
// an entry: { saleId, body (what pos-sale commit takes), status: 'queued'|'sending'|'failed', queuedAt, tries, error, seq, docNo, storeId, receipt (the model for a reprint) }
export const queued = async () => (await all('sales')).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
export const queue = (entry) => put('sales', { status: 'queued', tries: 0, error: '', queuedAt: new Date().toISOString(), ...entry });
export const update = (entry) => put('sales', entry);
export const remove = (saleId) => del('sales', saleId);
export async function counts(storeId) {
  const list = (await all('sales')).filter(x => !storeId || x.storeId === storeId);
  return { queued: list.filter(x => x.status !== 'failed').length, failed: list.filter(x => x.status === 'failed').length };
}

// --------------------------------------------------------------- blocks --
// what the server gave this till: { key: storeId+'_'+series, blocks: [{ id, from, to, usedUpTo }], prefix }
export const blocksFor = async (storeId, series = 'INV') => (await tx('blocks', 'readonly', (s) => s.get(storeId + '_' + series))) || null;
export const saveBlocks = (storeId, series, data) => put('blocks', { key: storeId + '_' + series, ...data, savedAt: new Date().toISOString() });
// the next free number: past what the server has used and what this till queued
export async function nextNumber(storeId, series = 'INV') {
  const b = await blocksFor(storeId, series);
  if (!b) return null;
  const taken = new Set((await all('sales')).filter(x => x.storeId === storeId).map(x => x.seq));
  for (const blk of [...b.blocks].sort((x, y) => x.from - y.from)) {
    for (let n = blk.usedUpTo + 1; n <= blk.to; n++) if (!taken.has(n)) return { seq: n, docNo: b.prefix + '-' + String(n).padStart(6, '0'), blockId: blk.id, left: blk.to - n };
  }
  return null;
}
export async function numbersLeft(storeId, series = 'INV') {
  const b = await blocksFor(storeId, series); if (!b) return 0;
  const taken = (await all('sales')).filter(x => x.storeId === storeId).length;
  return b.blocks.reduce((n, blk) => n + (blk.to - blk.usedUpTo), 0) - taken;
}

// ---------------------------------------------------------------- stock --
// what offline sales took off the cached levels, per item, until they sync
export const stockOffsets = async (storeId) => Object.fromEntries((await all('stock')).filter(x => x.storeId === storeId).map(x => [x.itemId, x.qty]));
export async function offsetStock(storeId, itemId, qty) {
  const key = storeId + '_' + itemId;
  const cur = (await tx('stock', 'readonly', (s) => s.get(key))) || { key, storeId, itemId, qty: 0 };
  cur.qty += qty;
  if (cur.qty === 0) await del('stock', key); else await put('stock', cur);
}
export const clearStockOffsets = async (storeId) => { for (const x of await all('stock')) if (x.storeId === storeId) await del('stock', x.key); };
