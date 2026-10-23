// Factory Manager POS in the browser: a new business signs up from the
// sign-in screen (its own space, a 14-day trial) and lands in the app with the
// trial bar and its Subscribe button; when the trial has run out unpaid the bar
// says read only and the app cannot add a company; a login that belongs to no
// business is offered to start one.
import { chromium } from 'playwright';
import { createHash, pbkdf2Sync } from 'node:crypto';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099', BASE = 'http://localhost:8788/pos/?emulator=1';
const FBDIR = process.env.FIREBASE_SDK_DIR || '';
const OUT = process.env.SHOT_DIR || '';
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
// the first shops exist (so the system is not "nobody yet")
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const own = await mk('owner@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await mk('stray@nowhere.co.za');
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const toast = async (p, re, ms = 8000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = (await p.locator('#toast').innerText().catch(() => '')).trim(); if (re.test(t)) return t; await p.waitForTimeout(150); } return t; };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
async function page(url) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('dialog', d => d.accept());
  await p.goto(url, { waitUntil: 'load' });
  return p;
}
// ---- sign up from the sign-in screen
const p = await page(BASE);
await p.waitForSelector('#login:not([hidden])');
await p.click('#to-signup'); await p.waitForSelector('#signup:not([hidden])');
R.lead = (await p.locator('#signup-lead').innerText()).replace(/\s+/g, ' ');
check('the sign-up says 14 days free then the price', /14 days free/.test(R.lead) && /R ?999/.test(R.lead), R.lead);
await p.fill('#signup-business', 'Ayanda Interiors'); await p.fill('#signup-name', 'Ayanda Dube');
await p.fill('#signup-email', 'ayanda@interiors.co.za'); await p.fill('#signup-pass', 'secret123');
await p.click('#signup-submit');
R.welcome = await toast(p, /trial has started/);
await p.waitForSelector('#nav [data-view=admin]', { state: 'attached', timeout: 20000 }); await p.waitForTimeout(1500);
check('signed up: welcomed into the app', /trial has started/.test(R.welcome), R.welcome);
R.bar = (await p.locator('#billing-bar').innerText().catch(() => '')).replace(/\s+/g, ' ');
check('the bar: 14 days left and Subscribe for R999', /14 days left/.test(R.bar) && /Subscribe/i.test(R.bar) && /999/.test(R.bar), R.bar);
const uid = await p.evaluate(() => window.__fbUid || null).catch(() => null);
const members = await (await fetch(`${docs}/posMembers?pageSize=50`, { headers: H })).json();
const mine = (members.documents || []).map(d => ({ uid: d.name.split('/').pop(), g: d.fields.groupId.stringValue })).filter(m => m.g !== 'retail');
check('one new business, the login in it', mine.length === 1 && /^g/.test(mine[0].g), mine);
const G = mine[0] && mine[0].g;
// she adds her company in the trial
await p.click('#nav [data-view=admin]', { force: true }); await p.waitForTimeout(400); await p.click('[data-sub=companies]').catch(() => {}); await p.waitForTimeout(600);
if (OUT) await p.screenshot({ path: OUT + '/signup-1-trial.png' });
// ---- the trial runs out unpaid
await fetch(`${docs}/posGroups/${G}?updateMask.fieldPaths=trialEndsAt`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { trialEndsAt: { timestampValue: new Date(Date.now() - 3600000).toISOString() } } }) });
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#nav [data-view=admin]', { state: 'attached', timeout: 20000 }); await p.waitForTimeout(1500);
R.bar2 = (await p.locator('#billing-bar').innerText().catch(() => '')).replace(/\s+/g, ' ');
check('read only: the bar says so and offers Subscribe', /Read only/i.test(R.bar2) && /trial has ended/.test(R.bar2) && /Subscribe/i.test(R.bar2), R.bar2);
if (OUT) await p.screenshot({ path: OUT + '/signup-2-readonly.png' });
// a company cannot be added now (the rules refuse it)
R.write = await p.evaluate(async (G) => {
  const db = await import('./js/db.js');
  try { await db.fb.fns.setDoc(db.ref('entities', 'AI'), { legalName: 'Ayanda Interiors', tradingName: 'Ayanda Interiors', entityId: 'AI', storeId: '', createdBy: db.fb.auth.currentUser.uid, createdAt: new Date().toISOString(), deviceId: 'web' }); return 'written'; }
  catch (e) { return 'refused ' + (e.code || e.message); }
}, G);
check('read only: the app cannot write', /refused/.test(R.write) && /permission/i.test(R.write), R.write);
// ---- a login with no business is offered to start one
const q = await page(BASE);
await q.waitForSelector('#login:not([hidden])');
const sw = q.locator('#login-switch [data-mode=email]'); if (await sw.isVisible()) await sw.click();
await q.fill('#login-email', 'stray@nowhere.co.za'); await q.fill('#login-pass', 'secret123'); await q.click('#login-submit');
await q.waitForSelector('#nobody:not([hidden])', { timeout: 15000 });
await q.click('#nobody-start'); await q.waitForSelector('#signup:not([hidden])');
check('only the names are asked (the login exists)', await q.locator('#signup-email').isHidden() && await q.locator('#signup-pass').isHidden());
await q.fill('#signup-business', 'Stray Shop'); await q.fill('#signup-name', 'Sam'); await q.click('#signup-submit');
R.welcome2 = await toast(q, /trial has started/);
await q.waitForSelector('#nav [data-view=admin]', { state: 'attached', timeout: 20000 });
check('the stray login started its own business', /trial has started/.test(R.welcome2), R.welcome2);
console.log(JSON.stringify({ fails, errs, ...R }, null, 1));
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
