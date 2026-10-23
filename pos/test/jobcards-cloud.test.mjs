// Factory Manager job cards on the database emulator, through the real rules
// (couchpotato/firestore.rules): the tablet signed in with the Factory floor
// role releases an order, times Sipho (clocking him in), pauses, finishes the
// step and passes the check; the order is Done. The owner then corrects a
// time entry with a reason. No permission errors along the way.
import { chromium } from 'playwright';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = (process.env.FM_BASE || 'http://localhost:8788/couchpotato/') + '?emulator=1';
const FBDIR = process.env.FIREBASE_SDK_DIR || '';
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const toFs = (v) => v === null ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => f.nullValue !== undefined ? null : f.booleanValue !== undefined ? f.booleanValue : f.integerValue !== undefined ? Number(f.integerValue) : f.doubleValue !== undefined ? f.doubleValue : f.stringValue !== undefined ? f.stringValue : f.timestampValue !== undefined ? f.timestampValue : f.arrayValue ? (f.arrayValue.values || []).map(fromFs) : f.mapValue ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : undefined;
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const all = async (coll) => { const r = await (await fetch(`${docs}/companies/C1/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...fromFs({ mapValue: { fields: d.fields } }) })); };
const one = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? fromFs({ mapValue: { fields: r.fields } }) : null; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const signUp = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json()).localId;
const ownUid = await signUp('jean@cp.co.za'), floorUid = await signUp('tablet@cp.co.za');
const none = { pos: 'none', orders: 'none', quotes: 'none', customers: 'none', factory: 'none', costing: 'none', stock: 'none', storeroom: 'none', scan: 'none', deliveries: 'none', invoices: 'none', profit: 'none', wages: 'none', settings: 'none' };
await put('companies/C1', { name: 'Couch Potato', ownerUid: ownUid, ownerEmail: 'jean@cp.co.za', plan: 'trial', status: 'trial', createdAt: new Date() });
await put('users/' + ownUid, { email: 'jean@cp.co.za', companyId: 'C1', companies: { C1: 'Couch Potato' } });
await put('users/' + floorUid, { email: 'tablet@cp.co.za', companyId: 'C1', companies: { C1: 'Couch Potato' } });
await put(`companies/C1/members/${ownUid}`, { role: 'owner', email: 'jean@cp.co.za', name: 'Jean' });
await put(`companies/C1/members/${floorUid}`, { role: 'factory', email: 'tablet@cp.co.za', name: 'Floor tablet' });
await put('companies/C1/roles/factory', { name: 'Factory floor', perms: { ...none, factory: 'edit', scan: 'edit', stock: 'edit', orders: 'view', deliveries: 'view' }, clientMode: 'all', clientGroups: [] });
await put('companies/C1/settings/factory', { name: 'Couch Potato', overheads: [{ name: 'Rent', monthly: 31000 }], productiveHours: 1000, labourRate: 85, unitsPerMonth: 40, orderPrefix: 'CP-' });
await put('companies/C1/workstations/ws1', { name: 'Upholstery', staffHourlyCost: 140, active: true, sort: 1 });
await put('companies/C1/workstations/ws2', { name: 'QC', staffHourlyCost: 75, active: true, sort: 2 });
await put('companies/C1/operations/op1', { name: 'Upholster', workstationId: 'ws1', qc: false, active: true, sort: 1 });
await put('companies/C1/operations/op2', { name: 'QC check', workstationId: 'ws2', qc: true, active: true, sort: 2 });
await put('companies/C1/products/p1', { name: 'Sofa', sellingPrice: 9000, labourHours: 4, materials: [], routing: [{ operationId: 'op1', stdMinutes: 180 }, { operationId: 'op2', stdMinutes: 15 }] });
await put('companies/C1/attendance/roster', { people: [{ id: 's1', name: 'Sipho Dlamini', job: 'Upholsterer' }] });
await put('companies/C1/customers/c1', { name: 'Bellville Furniture' });
await put('companies/C1/orders/o1', { orderNo: 'CP-1', product: 'Sofa', qty: 1, status: 'new', customerId: 'c1', customerName: 'Bellville Furniture', fabric: 'Oatmeal', dueDate: '2026-12-01', priceEach: 9000, events: [] });

const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
async function open(email) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(email + ' PAGEERROR ' + e.message));
  p.on('console', m => { if (/permission|insufficient/i.test(m.text())) errs.push(email + ' ' + m.text().slice(0, 300)); });
  p.on('dialog', d => d.accept());
  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForSelector('#login:not([hidden])', { timeout: 20000 });
  await p.fill('#login-email', email); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
  await p.waitForSelector('#tabs [data-view]', { state: 'attached', timeout: 20000 }); await p.waitForTimeout(1500);
  return p;
}
const wait = (p, ms) => p.waitForTimeout(ms || 600);
const go = async (p, v) => { await p.evaluate(v => document.querySelector(`#tabs [data-view="${v}"]`).click(), v); await wait(p); };

// ---- the tablet, Factory floor role
const t = await open('tablet@cp.co.za');
R.tabs = await t.$$eval('#tabs [data-view]', x => x.map(y => y.dataset.view));
check('the floor role has the Station tablet', R.tabs.includes('stations') && R.tabs.includes('factory'), R.tabs);
await go(t, 'factory');
await t.click('[data-act="start"][data-id="o1"]'); await wait(t, 1500);
R.cards = (await all('jobCards')).sort((a, b) => a.sequence - b.sequence);
R.o1 = await one('companies/C1/orders/o1');
check('released through the rules: two cards, Upholster Ready, QC Waiting; the order in production', R.cards.length === 2 && R.cards[0].status === 'ready' && R.cards[1].status === 'waiting' && R.cards[1].qc === true && R.o1.status === 'in-production' && R.o1.jobCards === 2, [R.cards.map(c => [c.operationName, c.status]), R.o1 && R.o1.status]);
await go(t, 'stations');
await t.click('[data-act="st-station"]:has-text("Upholstery")'); await wait(t);
await t.click('[data-act="st-person"]:has-text("Sipho")'); await wait(t, 300);
await t.click('.st-job:has(.st-no:text-is("CP-1")) [data-act="st-start"]'); await wait(t, 1500);
R.te = await all('timeEntries');
R.att = (await all('attendance')).find(a => a.id !== 'roster');
check('Start: Sipho clocked in, one open entry at R 171 an hour (R 140 + R 31 000 ÷ 1 000 h)', R.att && R.att.in && R.att.in.s1 && R.te.length === 1 && R.te[0].open === true && R.te[0].rateAtTime === 171 && R.te[0].staffName === 'Sipho Dlamini', [R.att, R.te]);
await t.click('[data-act="st-person"]:has-text("Sipho")'); await wait(t, 300);
await t.click('[data-act="st-pause"]'); await wait(t, 300); await t.click('[data-act="st-pause-why"][data-why="Waiting for material"]'); await wait(t, 1500);
R.te = await all('timeEntries');
check('Pause: the work entry stopped, an open pause with its reason', R.te.length === 2 && R.te.some(e => e.kind === 'work' && e.open === false && e.end) && R.te.some(e => e.kind === 'pause' && e.open === true && e.pauseReason === 'Waiting for material'), R.te.map(e => [e.kind, e.open, e.pauseReason]));
await t.click('[data-act="st-person"]:has-text("Sipho")'); await wait(t, 300);
await t.click('.st-job:has(.st-no:text-is("CP-1")) [data-act="st-start"]'); await wait(t, 1200);
await t.click('[data-act="st-person"]:has-text("Sipho")'); await wait(t, 300);
await t.click('[data-act="st-done"]'); await wait(t, 300); await t.fill('#st-note', 'Used an extra metre'); await t.click('[data-act="st-done-ok"]'); await wait(t, 1500);
R.cards = (await all('jobCards')).sort((a, b) => a.sequence - b.sequence);
check('Done: Upholster done with the note, QC Ready, every timer stopped, worked minutes added up', R.cards[0].status === 'done' && R.cards[0].open === false && R.cards[0].note === 'Used an extra metre' && R.cards[1].status === 'ready' && (await all('timeEntries')).every(e => e.open === false) && typeof R.cards[0].workedMinutes === 'number', R.cards.map(c => [c.status, c.note, c.workedMinutes]));
await t.click('[data-act="st-change"]'); await wait(t, 300);
await t.click('[data-act="st-station"]:has-text("QC")'); await wait(t);
await t.click('[data-act="st-person"]:has-text("Sipho")'); await wait(t, 300);
await t.click('.st-job:has(.st-no:text-is("CP-1")) [data-act="st-start"]'); await wait(t, 1200);
await t.click('[data-act="st-person"]:has-text("Sipho")'); await wait(t, 300);
await t.click('[data-act="st-done"]'); await wait(t, 300); await t.click('[data-act="st-done-ok"]'); await wait(t, 2000);
R.o1 = await one('companies/C1/orders/o1');
check('the check passed: the order is Done (ready), both cards closed', R.o1.status === 'ready' && (await all('jobCards')).every(c => c.open === false), R.o1 && R.o1.status);
await go(t, 'factory'); await t.click('[data-act="floor-view"][data-to="board"]'); await wait(t);
R.board = await t.evaluate(() => ({ cols: document.querySelectorAll('.bd-col').length, times: !!document.querySelector('.bd-times') }));
check('the floor role sees the board, not the managers\' time table', R.board.cols === 2 && !R.board.times, R.board);

// ---- the owner corrects a time entry
const o = await open('jean@cp.co.za');
await go(o, 'orders');
await o.evaluate(() => { const b = [...document.querySelectorAll('[data-act="filter-status"]')].find(x => x.dataset.to === 'ready'); if (b) b.click(); }); await wait(o);
await o.click('[data-act="jobs-order"][data-id="o1"]'); await wait(o, 1500);
await o.locator('[data-te]').first().click(); await wait(o, 300);
await o.evaluate(() => { const s = document.getElementById('te-start'), e = document.getElementById('te-end'); const st = new Date(s.value); e.value = new Date(st.getTime() + 50 * 60000 - st.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
await o.fill('#te-why', 'Sipho forgot to press Pause at lunch'); await o.click('#modal-ok'); await wait(o, 1500);
R.edited = (await all('timeEntries')).find(e => e.editReason);
check('the owner\'s change is saved through the rules: 50 minutes, who and why', R.edited && R.edited.minutes === 50 && R.edited.editedBy === 'Jean' && R.edited.editReason === 'Sipho forgot to press Pause at lunch', R.edited);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 5000));
console.log(fails.length || errs.length ? fails.length + ' FAILED' : 'jobcards-cloud: all passed');
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
