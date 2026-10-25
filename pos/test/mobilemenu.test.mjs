// Retail POS on a phone: the sideways strip of tabs (it was rebuilt on every
// repaint, so a sideways scroll jumped back) gives way to one Menu button with
// a sheet of every screen; picking a screen closes it and goes there; who is
// signed in and Sign out are in the sheet; Lock stays in the bar; nothing is
// wider than the screen. A laptop keeps its tabs.
import { chromium } from 'playwright';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099', BASE = 'http://localhost:8788/pos/?emulator=1';
const FBDIR = process.env.FIREBASE_SDK_DIR || '';
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const own = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.co.za', password: 'secret123', returnSecureToken: true }) })).json();
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: false, ...srv('*') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
async function open(viewport, mobile) {
  const ctx = await b.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('dialog', d => d.accept());
  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForSelector('#login:not([hidden])');
  const sw = p.locator('#login-switch [data-mode=email]'); if (await sw.isVisible()) await sw.click();
  await p.fill('#login-email', 'owner@shop.co.za'); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
  await p.waitForSelector('#nav [data-view]', { state: 'attached', timeout: 20000 }); await p.waitForTimeout(900);
  return p;
}
// ---- a phone
const p = await open({ width: 390, height: 844 }, true);
const W = 390;
R.bar = await p.evaluate(() => ({ nav: getComputedStyle(document.getElementById('nav')).display, btn: getComputedStyle(document.getElementById('menu-btn')).display, out: getComputedStyle(document.getElementById('sign-out')).display, now: document.getElementById('menu-now').textContent }));
check('phone: no strip of tabs, no Sign out in the bar, one Menu button showing where you are (the owner starts on Home)', R.bar.nav === 'none' && R.bar.out === 'none' && R.bar.btn !== 'none' && R.bar.now === 'Home', R.bar);
check('phone: nothing wider than the screen', (await p.evaluate(() => document.documentElement.scrollWidth)) <= W);
const shot = (n) => process.env.SHOT_DIR ? p.screenshot({ path: process.env.SHOT_DIR + '/' + n + '.png' }) : null;
await shot('retail-1-bar');
await p.click('#menu-btn'); await p.waitForTimeout(250);
await shot('retail-2-menu');
R.items = await p.$$eval('#mnav .mnav-item', x => x.map(y => [y.dataset.view, y.textContent, y.classList.contains('on')]));
R.tabs = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view));
check('the sheet lists every screen the tabs do, Home marked', R.items.length === R.tabs.length && R.items.map(i => i[0]).join() === R.tabs.join() && R.items.find(i => i[0] === 'home')[2] === true && R.items.some(i => i[0] === 'sell'), [R.items, R.tabs]);
R.foot = await p.evaluate(() => ({ who: document.querySelector('#mnav .mnav-who').textContent, out: !!document.getElementById('m-sign-out') }));
check('the sheet says who is signed in and has Sign out', /Jean/.test(R.foot.who) && /owner/i.test(R.foot.who) && R.foot.out, R.foot);
await p.click('#mnav .mnav-item[data-view=customers]'); await p.waitForTimeout(800);
R.after = await p.evaluate(() => ({ open: !document.getElementById('mnav').hidden, now: document.getElementById('menu-now').textContent, active: (document.querySelector('#nav .tab.on') || {}).dataset }));
check('picking Customers closes the sheet and goes there', !R.after.open && R.after.now === 'Customers' && R.after.active && R.after.active.view === 'customers', R.after);
await p.click('#menu-btn'); await p.waitForTimeout(200); await p.keyboard.press('Escape'); await p.waitForTimeout(150);
check('Escape closes the sheet', await p.evaluate(() => document.getElementById('mnav').hidden));
await p.click('#menu-btn'); await p.waitForTimeout(200); await p.click('[data-mclose]'); await p.waitForTimeout(150);
check('the ✕ closes the sheet', await p.evaluate(() => document.getElementById('mnav').hidden));
await p.click('#menu-btn'); await p.waitForTimeout(200); await p.click('#m-sign-out'); await p.waitForTimeout(1200);
check('Sign out from the sheet signs out', await p.evaluate(() => !document.getElementById('login').hidden), await p.evaluate(() => document.getElementById('login').hidden));
// ---- a laptop keeps its tabs
const d = await open({ width: 1280, height: 900 }, false);
R.desk = await d.evaluate(() => ({ nav: getComputedStyle(document.getElementById('nav')).display, btn: getComputedStyle(document.getElementById('menu-btn')).display, out: getComputedStyle(document.getElementById('sign-out')).display }));
check('laptop: the tabs and Sign out stay, no Menu button', R.desk.nav !== 'none' && R.desk.out !== 'none' && R.desk.btn === 'none', R.desk);
// the bar groups its screens into drop-downs: Sales, Stock, Office
R.bar2 = await d.evaluate(() => ({ plain: [...document.querySelectorAll('#nav > .tab')].map(x => x.dataset.view), groups: [...document.querySelectorAll('#nav [data-group]')].map(x => x.textContent.trim()), menusShut: [...document.querySelectorAll('#nav .tab-menu')].every(m => m.hidden) }));
check('laptop: Sell, Home and My PIN as tabs; Sales, Stock and Office as drop-downs, shut', R.bar2.plain.includes('sell') && R.bar2.plain.includes('home') && R.bar2.plain.includes('me') && R.bar2.groups.map(g => g.replace(/·.*/, '').trim()).join() === 'Sales,Stock,Office' && R.bar2.menusShut, R.bar2);
await d.click('#nav [data-group=sales]'); await d.waitForTimeout(150);
R.open = await d.evaluate(() => [...document.querySelectorAll('#nav [data-menu=sales]:not([hidden]) [data-view]')].map(x => x.textContent));
await d.click('#nav [data-menu=sales] [data-view=returns]'); await d.waitForTimeout(600);
R.after2 = await d.evaluate(() => ({ group: document.querySelector('#nav [data-group=sales]').textContent.replace(/\s+/g, ' ').trim(), shut: document.querySelector('#nav [data-menu=sales]').hidden, h1: (document.querySelector('#screen h1') || {}).textContent }));
check('the Sales drop-down opens with its screens; picking Returns goes there, shuts it and the bar says Sales · Returns', R.open.join() === 'To do,Sales,Returns,Lay-bys,Sales orders,Quotes,Customers' && R.after2.shut && /Sales\s*· Returns/.test(R.after2.group) && /Returns/i.test(R.after2.h1 || ''), [R.open, R.after2]);
await d.click('#nav [data-group=office]'); await d.waitForTimeout(150); await d.mouse.click(700, 600); await d.waitForTimeout(150);
check('a click elsewhere shuts an open drop-down', await d.evaluate(() => document.querySelector('#nav [data-menu=office]').hidden));
console.log(JSON.stringify({ fails, errs, ...R }, null, 1));
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
