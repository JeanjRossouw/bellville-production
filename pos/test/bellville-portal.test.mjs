// The Bellville production app (index.html, its own Firebase project), with Firebase replaced by an in-browser
// stand-in: a manufacturer login is locked to its own portal (the link's ?m= changes nothing, the staff portal and
// the full system never open, its comments are stamped with its name); on the staff portal an order moves to
// another supplier (the old supplier's thread kept for staff only); an admin makes a manufacturer login without
// being signed out. Run with the test server up: node pos/test/bellville-portal.test.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
const crash = (e) => { console.log(JSON.stringify({ fails, errs, ...R, crash: String(e && e.stack || e).slice(0, 600) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);

let server = null;
if (!(await fetch('http://localhost:8788/index.html').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [REPO + '/pos/test/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/index.html').then(r => r.ok).catch(() => false)) break; }
}

// ---- the Firebase stand-in: one shared store on window.__fb, seeded per page
const APP = `export function initializeApp(cfg, name) { return { name: name || '[DEFAULT]' }; }
export function deleteApp() { return Promise.resolve(); }`;
const AUTH = `const fb = () => window.__fb;
const notify = () => fb().listeners.forEach(cb => setTimeout(() => cb(fb().current), 0));
export function getAuth(app) { return { app: app || { name: '[DEFAULT]' } }; }
const main = (a) => !a || !a.app || a.app.name === '[DEFAULT]';
export async function signInWithEmailAndPassword(a, email, pw) { const u = fb().users[email]; if (!u || u.password !== pw) throw Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }); if (main(a)) { fb().current = { uid: u.uid, email }; notify(); } return { user: { uid: u.uid, email } }; }
export async function createUserWithEmailAndPassword(a, email, pw) { if (fb().users[email]) throw Object.assign(new Error('in use'), { code: 'auth/email-already-in-use' }); const uid = 'u' + Object.keys(fb().users).length + Date.now().toString(36); fb().users[email] = { uid, password: pw }; if (main(a)) { fb().current = { uid, email }; notify(); } return { user: { uid, email } }; }
export async function signOut(a) { if (main(a)) { fb().current = null; notify(); } }
export function onAuthStateChanged(a, cb) { fb().listeners.push(cb); setTimeout(() => cb(fb().current), 0); return () => {}; }
export async function signInAnonymously() { throw new Error('no anonymous sign-in here'); }`;
const STORE = `const fb = () => window.__fb;
const clone = (x) => x == null ? x : JSON.parse(JSON.stringify(x));
const snap = (path) => ({ exists: () => fb().docs[path] != null, data: () => clone(fb().docs[path]), id: path.split('/').pop(), metadata: { fromCache: false, hasPendingWrites: false } });
export function getFirestore(app) { return { app: app || { name: '[DEFAULT]' } }; }
export function doc(db, coll, id) { return { path: coll + '/' + id }; }
export function collection(db, coll) { return { path: coll }; }
export async function setDoc(ref, data, opts) { fb().docs[ref.path] = opts && opts.merge ? { ...(fb().docs[ref.path] || {}), ...clone(data) } : clone(data); fb().writes.push(ref.path); (fb().subs[ref.path] || []).forEach(cb => setTimeout(() => cb(snap(ref.path)), 0)); }
export async function getDoc(ref) { return snap(ref.path); }
export async function deleteDoc(ref) { delete fb().docs[ref.path]; }
const qsnap = (coll) => { const docs = Object.keys(fb().docs).filter(k => k.startsWith(coll + '/') && k.split('/').length === 2).map(k => snap(k)); return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f), docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
export function onSnapshot(ref, cb) { const isColl = !ref.path.includes('/'); (fb().subs[ref.path] = fb().subs[ref.path] || []).push(isColl ? (() => cb(qsnap(ref.path))) : cb); setTimeout(() => cb(isColl ? qsnap(ref.path) : snap(ref.path)), 0); return () => {}; }
export async function enableIndexedDbPersistence() {}`;

const order = (id, invoice, builder, o = {}) => ({ id, invoice, customer: 'Client ' + invoice, product: '3 Seater ' + invoice, fabric: 'Moldova', qty: 1, orderDate: '2026-11-01', paidDate: '2026-11-01', dueDate: '2026-11-29', status: 'pending', builder, ...o });
const production = () => JSON.stringify({
  bellville: {
    orders: [
      order('O1', '3701', 'Couch Patato', { builderComments: [{ by: 'Couch Patato', at: '2026-11-02T08:00:00.000Z', text: 'Frame cut, waiting for fabric' }] }),
      order('O2', '3702', 'Legacy Upholstery'),
      order('O3', '3703', 'Couch Patato', { builderDone: true, builderDoneAt: '2026-11-05T09:00:00.000Z' })
    ],
    manufacturers: [{ id: 'MFG-1', name: 'Couch Patato', email: 'orders@cp.test' }, { id: 'MFG-2', name: 'Legacy Upholstery', email: 'orders@lu.test' }],
    products: {}, inventory: {}, staff: []
  },
  pinkfoot: { orders: [], products: {}, inventory: {}, staff: [] }, repticube: { orders: [], products: {}, inventory: {}, staff: [] }
});
const seed = (current, extra = {}) => ({
  users: { 'admin@bv.test': { uid: 'admin', password: 'secret12' }, 'cp@cp.test': { uid: 'cp', password: 'secret12' }, 'sales@bv.test': { uid: 'sales', password: 'secret12' }, ...(extra.users || {}) },
  docs: { 'users/admin': { email: 'admin@bv.test', role: 'admin' }, 'users/cp': { email: 'cp@cp.test', role: 'manufacturer', builderId: 'MFG-1', builder: 'Couch Patato' }, 'users/sales': { email: 'sales@bv.test', role: 'sales' }, 'shared-data/production': { data: extra.production || production() }, ...(extra.docs || {}) },
  current, listeners: [], subs: {}, writes: []
});

const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
async function open(url, state) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.route(/gstatic\.com\/firebasejs\/.*firebase-app\.js/, r => r.fulfill({ body: APP, contentType: 'text/javascript' }));
  await ctx.route(/gstatic\.com\/firebasejs\/.*firebase-auth\.js/, r => r.fulfill({ body: AUTH, contentType: 'text/javascript' }));
  await ctx.route(/gstatic\.com\/firebasejs\/.*firebase-firestore\.js/, r => r.fulfill({ body: STORE, contentType: 'text/javascript' }));
  await ctx.route(/^https:\/\/(?!www\.gstatic\.com\/firebasejs)/, r => r.abort());
  await ctx.addInitScript((s) => { window.__fb = s; try { localStorage.clear(); } catch (e) {} }, state);
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  const answers = [];
  p.on('dialog', d => { const a = answers.shift(); R.dialogs = [...(R.dialogs || []), d.message().slice(0, 160)]; if (a === false) d.dismiss(); else d.accept(a == null ? undefined : String(a)); });
  await p.goto('http://localhost:8788' + url, { waitUntil: 'load' });
  await p.waitForTimeout(2500);
  return { p, ctx, answers };
}
const shown = (p, id) => p.evaluate((id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; }, id);
const text = (p, sel) => p.locator(sel).innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const saved = (p) => p.evaluate(() => JSON.parse((window.__fb.docs['shared-data/production'] || {}).data || '{}'));

// ---- 1. a manufacturer login, opening another supplier's link: still its own portal, nothing else
{
  const { p, ctx } = await open('/index.html?builder=1&m=Legacy%20Upholstery', seed({ uid: 'cp', email: 'cp@cp.test' }));
  R.m1 = await text(p, '#builder-portal-content');
  check('the portal shows Couch Patato\'s orders, not Legacy\'s, whatever the link says', /3701/.test(R.m1) && /3703/.test(R.m1) && !/3702/.test(R.m1), R.m1.slice(0, 300));
  check('the header is Couch Patato\'s', /couch patato/i.test(await text(p, '#builder-portal-name')), await text(p, '#builder-portal-name'));
  check('the full system is hidden', !(await shown(p, 'main-app')) && await shown(p, 'builder-only-view'));
  await p.evaluate(() => { window.exitStaffPortalMode(); }); await p.waitForTimeout(300);
  check('"Full system" from the console still lands on the portal', !(await shown(p, 'main-app')) && await shown(p, 'builder-only-view'));
  await p.evaluate(() => { window.enterStaffPortalMode(); }); await p.waitForTimeout(300);
  R.m1b = await text(p, '#builder-portal-content');
  check('the staff portal from the console: still only Couch Patato\'s orders', !/3702/.test(R.m1b) && /3701/.test(R.m1b) && /manufacturer portal/i.test(await text(p, '#builder-portal-subtitle')), R.m1b.slice(0, 200));
  await p.fill('#bp-comment-O1', 'Fabric arrived, building tomorrow'); await p.click('button[onclick="builderPortalAddComment(\'O1\')"]'); await p.waitForTimeout(1500);
  const d1 = await saved(p);
  const c = (d1.bellville.orders.find(o => o.id === 'O1').builderComments || []).at(-1) || {};
  check('the manufacturer\'s comment is stamped with its name (the partner side), not as staff', c.by === 'Couch Patato' && /building tomorrow/.test(c.text), c);
  await ctx.close();
}
// ---- 2. the same login on the plain address: the portal again
{
  const { p, ctx } = await open('/index.html', seed({ uid: 'cp', email: 'cp@cp.test' }));
  check('the plain address opens the portal, not the full system', !(await shown(p, 'main-app')) && /3701/.test(await text(p, '#builder-portal-content')));
  await ctx.close();
}
// ---- 3. a manufacturer renamed in the card: the login follows by id
{
  const renamed = production().replace(/"name":"Couch Patato"/, '"name":"Couch Potato"').replace(/"builder":"Couch Patato"/g, '"builder":"Couch Potato"').replace(/"by":"Couch Patato"/g, '"by":"Couch Potato"');
  const { p, ctx } = await open('/index.html', seed({ uid: 'cp', email: 'cp@cp.test' }, { production: renamed }));
  check('after a rename the login shows the orders under the new name', /3701/.test(await text(p, '#builder-portal-content')) && /couch potato/i.test(await text(p, '#builder-portal-name')), await text(p, '#builder-portal-name'));
  await ctx.close();
}
// ---- 4. staff portal: move an order to Legacy; the old thread is kept for staff only
{
  const { p, ctx, answers } = await open('/index.html', seed({ uid: 'admin', email: 'admin@bv.test' }));
  check('an admin gets the full system', await shown(p, 'main-app'));
  await p.evaluate(() => window.enterStaffPortalMode()); await p.waitForTimeout(600);
  check('the staff portal lists every outsourced order', /3701/.test(await text(p, '#builder-portal-content')) && /3702/.test(await text(p, '#builder-portal-content')));
  const sel = p.locator('select[onchange*="staffPortalSetSupplier(\'O1\'"]');
  check('each card has a supplier choice', await sel.count() === 1 && (await sel.inputValue()) === 'Couch Patato');
  answers.push(false);                         // cancel first: nothing moves, the choice goes back
  await sel.selectOption('Legacy Upholstery'); await p.waitForTimeout(600);
  check('cancelled: still with Couch Patato', (await saved(p)).bellville.orders.find(o => o.id === 'O1').builder === 'Couch Patato' && (await sel.inputValue()) === 'Couch Patato');
  answers.push(true);
  await sel.selectOption('Legacy Upholstery'); await p.waitForTimeout(1800);
  const o1 = (await saved(p)).bellville.orders.find(o => o.id === 'O1');
  check('moved: the builder is Legacy, the thread starts with the move note, the old thread kept apart', o1.builder === 'Legacy Upholstery' && o1.builderComments.length === 1 && /Moved to Legacy Upholstery from Couch Patato/.test(o1.builderComments[0].text) && o1.builderPrevThreads.length === 1 && o1.builderPrevThreads[0].builder === 'Couch Patato' && o1.builderPrevThreads[0].comments.length === 1, o1);
  R.s4 = await text(p, '#builder-portal-content');
  check('the card shows the earlier messages with Couch Patato for staff', /Earlier messages with Couch Patato \(1, only our staff see these\)/.test(R.s4), R.s4.slice(0, 400));
  check('an order the supplier marked done is not on the staff portal (it is on the Delivery portal), so it is not moved from here', !/3703/.test(R.s4), R.s4.slice(0, 200));
  R.after = (await saved(p));
  // ---- 5. the admin makes a portal login for Legacy and stays signed in
  await p.evaluate(() => window.exitStaffPortalMode()); await p.waitForTimeout(400);
  answers.push('legacy@lu.test', 'secret12', true);
  await p.evaluate(() => window.makeManufacturerLogin('MFG-2')); await p.waitForTimeout(1800);
  const fb = await p.evaluate(() => ({ users: window.__fb.users, docs: window.__fb.docs, current: window.__fb.current }));
  const uid = (fb.users['legacy@lu.test'] || {}).uid;
  check('the login exists, linked to Legacy by id, as a manufacturer', uid && fb.docs['users/' + uid] && fb.docs['users/' + uid].role === 'manufacturer' && fb.docs['users/' + uid].builderId === 'MFG-2' && fb.docs['users/' + uid].builder === 'Legacy Upholstery', fb.docs['users/' + uid]);
  check('the admin is still the one signed in', fb.current && fb.current.uid === 'admin', fb.current);
  check('the card lists the login', ((await saved(p)).bellville.manufacturers.find(m => m.id === 'MFG-2').logins || []).some(l => l.email === 'legacy@lu.test'));
  check('the link was offered', (R.dialogs || []).some(m => /Login made for Legacy Upholstery/.test(m)));
  answers.push('legacy@lu.test', 'secret12');
  await p.evaluate(() => window.makeManufacturerLogin('MFG-2')); await p.waitForTimeout(800);
  check('the same email again is refused, plainly', (R.dialogs || []).some(m => /already has a login/.test(m)));
  R.legacy = { uid, users: fb.users, userDoc: fb.docs['users/' + uid] };
  await ctx.close();
}
// ---- 6. the new Legacy login sees the orders moved to it, and only those
{
  const st = seed({ uid: R.legacy.uid, email: 'legacy@lu.test' }, { production: JSON.stringify(R.after), users: { 'legacy@lu.test': { uid: R.legacy.uid, password: 'secret12' } }, docs: { ['users/' + R.legacy.uid]: R.legacy.userDoc } });
  const { p, ctx } = await open('/index.html?builder=1&m=Couch%20Patato', st);
  R.l6 = await text(p, '#builder-portal-content');
  check('Legacy sees 3701 (moved) and 3702, not 3703 (still Couch Patato\'s), and not Couch Patato\'s earlier thread', /3701/.test(R.l6) && /3702/.test(R.l6) && !/3703/.test(R.l6) && !/Frame cut, waiting for fabric/.test(R.l6) && !/Earlier messages/.test(R.l6), R.l6.slice(0, 400));
  check('the header is Legacy\'s', /legacy upholstery/i.test(await text(p, '#builder-portal-name')));
  await ctx.close();
}
// ---- 7. a sales login: unchanged, lands on the staff portal with the supplier choice
{
  const { p, ctx } = await open('/index.html', seed({ uid: 'sales', email: 'sales@bv.test' }));
  check('a sales login lands on the staff portal with the supplier choice', /staff portal/i.test(await text(p, '#builder-portal-subtitle')) && await p.locator('select[onchange*="staffPortalSetSupplier("]').count() === 2);
  await ctx.close();
}
// ---- 8. a sales login captures a rug order without a supplier: it waits on the staff portal, first
{
  const { p, ctx } = await open('/index.html', seed({ uid: 'sales', email: 'sales@bv.test' }));
  check('sales does not get the Suppliers button', !(await shown(p, 'staff-portal-suppliers')));
  await p.evaluate(() => window.openNewOrder()); await p.waitForTimeout(300);
  R.noSup = await p.locator('#no-supplier').inputValue();
  check('the new order\'s supplier starts on Allocate later, with every supplier to choose from', R.noSup === 'To allocate' && await p.locator('#no-supplier option').count() === 3, R.noSup);
  await p.fill('#no-invoice', '3801'); await p.fill('#no-customer', 'Rina Rug'); await p.fill('#no-product', 'Rug 2 × 3 m — Natural jute');
  await p.click('#no-save'); await p.waitForTimeout(1500);
  const o = (await saved(p)).bellville.orders.find(x => x.invoice === '3801');
  check('saved waiting for a supplier, outsourced (not our own build)', o && o.builder === 'To allocate' && o.product.startsWith('Rug'), o);
  R.cnt8 = await text(p, '#builder-portal-count');
  check('the header counts it apart', /2 orders with suppliers · 1 to allocate/.test(R.cnt8), R.cnt8);
  R.first8 = await p.locator('#builder-portal-content > div').first().innerText();
  check('the waiting order is first, its choice on To allocate', /#3801/.test(R.first8) && (await p.locator('select[onchange*="staffPortalSetSupplier(\'' + o.id + '\'"]').inputValue()) === 'To allocate', R.first8.slice(0, 120));
  await ctx.close();
}
// ---- 9. the admin adds a supplier on the portal and allocates the waiting order in one tap; the planner view too
{
  const prod = JSON.parse(production());
  prod.bellville.orders.push(order('O9', '3801', 'To allocate', { product: 'Rug 2 × 3 m', fabric: '' }));
  const { p, ctx, answers } = await open('/index.html', seed({ uid: 'admin', email: 'admin@bv.test' }, { production: JSON.stringify(prod) }));
  await p.evaluate(() => window.enterStaffPortalMode()); await p.waitForTimeout(500);
  check('an admin gets the Suppliers button', await shown(p, 'staff-portal-suppliers'));
  await p.click('#staff-portal-suppliers'); await p.waitForTimeout(300);
  R.sup9 = await text(p, '#sup-list');
  check('the window lists the suppliers with their actions', /Couch Patato/.test(R.sup9) && /Legacy Upholstery/.test(R.sup9) && /Make login/i.test(R.sup9), R.sup9.slice(0, 200));
  await p.fill('#sup-name', 'couch patato'); await p.click('button[onclick="addSupplierFromPortal()"]'); await p.waitForTimeout(300);
  await p.fill('#sup-name', 'To allocate'); await p.click('button[onclick="addSupplierFromPortal()"]'); await p.waitForTimeout(300);
  check('a name already used, and the waiting name, are refused', (R.dialogs || []).some(m => /couch patato is already a supplier/.test(m)) && (R.dialogs || []).some(m => /kept for orders without a supplier/.test(m)), R.dialogs);
  await p.fill('#sup-name', 'Rug Co'); await p.fill('#sup-email', 'orders@rugco.test'); await p.click('button[onclick="addSupplierFromPortal()"]'); await p.waitForTimeout(1200);
  check('Rug Co added, listed', (await saved(p)).bellville.manufacturers.some(m => m.name === 'Rug Co' && m.email === 'orders@rugco.test') && /Rug Co/.test(await text(p, '#sup-list')));
  await p.click('#suppliers-modal button[onclick="closeSuppliersModal()"]'); await p.waitForTimeout(400);
  const before = (R.dialogs || []).length;
  await p.locator('select[onchange*="staffPortalSetSupplier(\'O9\'"]').selectOption('Rug Co'); await p.waitForTimeout(1500);
  const o9 = (await saved(p)).bellville.orders.find(x => x.id === 'O9');
  check('allocated in one tap (no question), with the note', o9.builder === 'Rug Co' && (R.dialogs || []).length === before && /Allocated to Rug Co/.test((o9.builderComments || []).at(-1).text), o9);
  await p.evaluate(() => window.setPortalView ? window.setPortalView('planner') : window.togglePortalView()); await p.waitForTimeout(800);
  check('the planner view cards carry the supplier choice', await p.locator('.plan-card select[onchange*="staffPortalSetSupplier("]').count() >= 3, await p.locator('.plan-card').count());
  R.after9 = await saved(p);
  await ctx.close();
}
// ---- 10. suppliers never see an order waiting to be allocated
{
  const prod = JSON.parse(production());
  prod.bellville.orders.push(order('O9', '3801', 'To allocate', { product: 'Rug 2 × 3 m', fabric: '' }));
  const { p, ctx } = await open('/index.html?builder=1&m=To%20allocate', seed({ uid: 'cp', email: 'cp@cp.test' }, { production: JSON.stringify(prod) }));
  R.c10 = await text(p, '#builder-portal-content');
  check('a supplier login, even with ?m=To allocate, sees only its own', /3701/.test(R.c10) && !/3801/.test(R.c10), R.c10.slice(0, 200));
  await ctx.close();
}
check('no page errors', errs.length === 0, errs);
await b.close(); if (server) server.kill();
console.log(JSON.stringify({ fails, errs, ok: fails.length === 0 }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'bellville-portal: all passed');
process.exit(fails.length ? 1 : 0);
