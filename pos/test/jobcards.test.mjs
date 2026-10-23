// Factory Manager job cards, phase 1, in the demo (this browser's storage).
// Workstations and steps under Costing, with the station rate = people + the
// overhead an hour. Releasing an order makes one card per step, the first
// Ready. On the station tablet: a person taps their name and Start; starting
// another job pauses the first; Pause asks why; Done makes the next step
// Ready; two people on one card both log time; someone not clocked in is
// clocked in by starting. A check fails back to an earlier step as a rework
// card, the check waits for it, then passes; the last card done makes the
// order Done. Clocking out stops the timer; one left running overnight is
// stopped at the day's end and marked. A manager's change to a time entry
// keeps who and why. Cancelling closes the cards; a product with no routing
// goes into production the old way. The board shows the stations, the TV
// link shows the board alone, and the tablet fits a phone.
import { chromium } from 'playwright';
const BASE = process.env.FM_BASE || 'http://localhost:8788/couchpotato/';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic|gstatic\.com\/firebasejs/, r => r.abort());
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('dialog', d => d.accept());
const wait = (ms) => p.waitForTimeout(ms || 250);
await p.goto(BASE + '?demo=1', { waitUntil: 'load' });
await p.evaluate(() => localStorage.clear());
await p.goto(BASE + '?demo=1', { waitUntil: 'load' });
await p.fill('#login-email', 'jean@couchpotato.co.za'); await p.fill('#login-pass', 'x'); await p.click('#login-form button[type=submit]');
await p.waitForSelector('#tabs [data-view]', { state: 'attached', timeout: 20000 }); await wait(800);

const ls = (coll) => p.evaluate(c => JSON.parse(localStorage.getItem('cp-demo-' + c) || '{}'), coll);
const list = async (coll) => Object.entries(await ls(coll)).map(([id, v]) => ({ id, ...v }));
const go = async (v) => { await p.evaluate(v => document.querySelector(`#tabs [data-view="${v}"]`).click(), v); await wait(350); };
const station = async (name) => {
  await go('stations');
  if (await p.locator('[data-act="st-change"]').count()) { await p.click('[data-act="st-change"]'); await wait(); }
  await p.click(`[data-act="st-station"]:has-text("${name}")`); await wait();
};
const person = async (name) => { await p.click(`[data-act="st-person"]:has-text("${name}")`); await wait(); };
const startJob = async (orderNo) => { await p.click(`.st-job:has(.st-no:text-is("${orderNo}")) [data-act="st-start"]`); await wait(400); };
const done = async () => { await p.click('[data-act="st-done"]'); await wait(); await p.click('[data-act="st-done-ok"]'); await wait(500); };
const cardsOf = async (orderId) => (await list('jobCards')).filter(c => c.orderId === orderId).sort((a, b) => a.sequence - b.sequence || (a.isRework ? 1 : 0) - (b.isRework ? 1 : 0));
const entries = async () => await list('timeEntries');

// ---- setup under Costing
await go('costing'); await p.click('[data-act="cost-view"][data-to="stations"]'); await wait();
R.rates = await p.$$eval('.tbl tbody tr', rows => rows.slice(0, 6).map(r => [...r.querySelectorAll('td')].slice(0, 4).map(td => td.textContent.trim())));
check('six workstations, each rate = its people + R 43.87 overhead an hour (R 68 000 ÷ 1 550 h)', R.rates.length === 6 && R.rates[0][0] === 'Frame shop' && /70\.00/.test(R.rates[0][1]) && /43\.87/.test(R.rates[0][2]) && /113\.87/.test(R.rates[0][3]), R.rates);
await p.click('[data-act="cost-view"][data-to="products"]'); await wait();
await p.locator('tr:has-text("2 Seater Amber") [data-act="edit-product"]').click(); await wait();
R.route = await p.evaluate(() => ({ rows: document.querySelectorAll('.rt-row').length, total: document.getElementById('rt-total').textContent }));
check('the product shows its routing: six steps, the time a piece, labour at the station rates', R.route.rows === 6 && /6 steps · 6h 05 a piece/.test(R.route.total) && /labour at the station rates .*R/.test(R.route.total), R.route);
await p.click('.modal-foot [data-close]'); await wait();

// ---- release CP-1002 (2 Seater Amber) and CP-1004 (Daybed) from the planner
await go('factory');
R.relLabel = await p.locator('[data-act="start"][data-id="d2"]').textContent();
check('a new order whose product has steps offers Release to floor', /Release to floor/.test(R.relLabel), R.relLabel);
await p.click('[data-act="start"][data-id="d2"]'); await wait(500);
await p.click('[data-act="floor-view"][data-to="planner"]').catch(() => {}); await wait();
if (await p.locator('[data-act="start"][data-id="d4"]').count()) await p.click('[data-act="start"][data-id="d4"]'); await wait(500);
R.c2 = await cardsOf('d2'); R.o = await ls('orders');
check('released: six cards in routing order, the first Ready, the rest Waiting; minutes from the routing', R.c2.length === 6 && R.c2.map(c => c.status).join() === 'ready,waiting,waiting,waiting,waiting,waiting' && R.c2.map(c => c.operationName).join() === 'Build frame,Cut fabric,Sew covers,Upholster,QC check,Pack' && R.c2[0].stdMinutes === 90 && R.c2[4].qc === true, R.c2.map(c => [c.operationName, c.status, c.stdMinutes]));
check('the order is in production, stamped as released with its card count', R.o.d2.status === 'in-production' && R.o.d2.releasedAt && R.o.d2.jobCards === 6 && (R.o.d2.events || []).some(e => /Released to the floor: 6 job cards/.test(e.what)), [R.o.d2.status, R.o.d2.jobCards]);
check('the second order released too', (await cardsOf('d4')).length === 6 && R.o.d4.status === 'in-production');

// ---- Pieter starts CP-1002 at the frame shop
await station('Frame shop');
R.readyHere = await p.$$eval('.st-jobs .st-no', x => x.map(y => y.textContent));
check('the frame shop lists both orders ready', R.readyHere.includes('CP-1002') && R.readyHere.includes('CP-1004'), R.readyHere);
await person('Pieter'); await startJob('CP-1002');
R.e1 = (await entries()).filter(e => e.staffId === 's3' && e.open);
check('Start: back to the names, one running entry for Pieter at the frame shop rate', !(await p.locator('.st-now').count()) && R.e1.length === 1 && R.e1[0].kind === 'work' && R.e1[0].rateAtTime === 113.87 && R.e1[0].day && (await cardsOf('d2'))[0].status === 'running', R.e1);
check('his name shows him on the job', /CP-1002 Build frame/.test(await p.locator('[data-act="st-person"]:has-text("Pieter")').textContent()));

// starting another job pauses the first
await person('Pieter'); await startJob('CP-1004');
R.e2 = (await entries()).filter(e => e.staffId === 's3');
check('one job at a time: starting CP-1004 stops CP-1002 (its card paused) and times the new one', R.e2.filter(e => e.open).length === 1 && R.e2.find(e => e.open).jobCardId === (await cardsOf('d4'))[0].id && R.e2.find(e => e.jobCardId === R.c2[0].id).open === false && (await cardsOf('d2'))[0].status === 'paused', R.e2.map(e => [e.jobCardId, e.open]));

// pause with a reason
await person('Pieter'); await p.click('[data-act="st-pause"]'); await wait();
R.reasons = await p.$$eval('[data-act="st-pause-why"]', x => x.map(y => y.dataset.why));
await p.click('[data-act="st-pause-why"][data-why="Tea or lunch"]'); await wait(400);
R.e3 = (await entries()).filter(e => e.staffId === 's3' && e.open);
check('Pause asks why, then logs an open pause (not charged) with the reason; the card shows paused', R.reasons.length === 5 && R.e3.length === 1 && R.e3[0].kind === 'pause' && R.e3[0].pauseReason === 'Tea or lunch' && (await cardsOf('d4'))[0].status === 'paused' && (await cardsOf('d4'))[0].lastPause === 'Tea or lunch', R.e3);

// carry on with CP-1002 and finish it
await person('Pieter'); await startJob('CP-1002');
await person('Pieter'); await done();
R.c2 = await cardsOf('d2');
R.e4 = (await entries()).filter(e => e.staffId === 's3');
check('Done: the frame card is done by Pieter, the pause ended, nothing of his runs, Cut fabric is Ready', R.c2[0].status === 'done' && !R.c2[0].open && R.c2[0].doneBy === 'Pieter Swart' && R.c2[0].qtyDone === 1 && R.c2[1].status === 'ready' && !R.e4.some(e => e.open), [R.c2.map(c => c.status), R.e4.filter(e => e.open)]);

// ---- two people on one card, at the cutting table
await station('Cutting table');
await person('Thandi'); await startJob('CP-1002');
await person('Sipho'); await startJob('CP-1002');
R.two = (await entries()).filter(e => e.jobCardId === R.c2[1].id && e.open);
check('two people on one card: two running entries', R.two.length === 2 && R.two.map(e => e.staffId).sort().join() === 's1,s2', R.two);
await go('factory'); await p.click('[data-act="floor-view"][data-to="board"]'); await wait();
R.board = await p.evaluate(() => ({ cols: [...document.querySelectorAll('.bd-col .bd-head strong')].map(x => x.textContent), cut: (document.querySelector('.bd-col:nth-child(2)') || {}).innerText || '', idle: document.querySelector('.bd-idle').innerText, times: !!document.querySelector('.bd-times table') }));
check('the board: a column per station; the cutting card shows both people timing it', R.board.cols.length === 6 && /CP-1002/.test(R.board.cut) && /Thandi Mokoena/.test(R.board.cut) && /Sipho Dlamini/.test(R.board.cut), R.board);
check('the board lists who is clocked in and not on a job, and the owner sees time today', /Pieter Swart/.test(R.board.idle) && R.board.times, R.board.idle);
await station('Cutting table'); await person('Thandi'); await done();
R.cut = (await entries()).filter(e => e.jobCardId === R.c2[1].id);
check('Done stops everyone on the card', R.cut.length === 2 && R.cut.every(e => !e.open && e.end) && (await cardsOf('d2'))[2].status === 'ready', R.cut);

// ---- someone not clocked in: starting clocks them in
await station('Sewing');
R.nomsa = await p.locator('[data-act="st-person"]:has-text("Nomsa")').textContent();
await person('Nomsa'); await startJob('CP-1002');
R.att = (await ls('attendance'))[await p.evaluate(() => new Date().toLocaleDateString('en-CA'))];
check('Nomsa was not clocked in; starting a job clocked her in', /not clocked in/.test(R.nomsa) && R.att && R.att.in && R.att.in.s4, [R.nomsa, R.att]);
await person('Nomsa'); await done();
await station('Upholstery'); await person('Sipho'); await startJob('CP-1002'); await person('Sipho'); await done();

// ---- the check fails back to upholstery, the fix is done, then it passes
await station('QC'); await person('Thandi'); await startJob('CP-1002');
await person('Thandi');
R.qcBtns = await p.$$eval('.st-acts button', x => x.map(y => y.textContent.trim()));
await p.click('[data-act="st-fail"]'); await wait(500);
R.backTo = await p.$$eval('[data-act="st-fail-to"] strong', x => x.map(y => y.textContent));
await p.fill('#st-why', 'Seam open on the left arm');
await p.click('[data-act="st-fail-to"]:has-text("Upholster")'); await wait(500);
R.c2 = await cardsOf('d2');
R.rw = R.c2.find(c => c.isRework);
R.qc = R.c2.find(c => c.qc);
check('a check offers Pass and Fail; Fail lists the earlier steps', R.qcBtns.join() === 'Pause,Pass,Fail: send back' && R.backTo.join() === 'Build frame,Cut fabric,Sew covers,Upholster', [R.qcBtns, R.backTo]);
check('Fail: a rework card Ready at Upholstery with the note; the check waits for it; the order notes it', R.rw && R.rw.status === 'ready' && R.rw.workstationId === 'ws-uph' && R.rw.note === 'Seam open on the left arm' && R.rw.reworkOf === R.qc.id && R.qc.status === 'waiting' && R.qc.waitingOn === R.rw.id && R.qc.reworks === 1
  && ((await ls('orders')).d2.events || []).some(e => /QC check failed: back to Upholster/.test(e.what)), [R.rw, R.qc]);
await station('Upholstery');
R.rwCard = await p.locator('.st-job:has(.st-no:text-is("CP-1002"))').textContent();
check('the rework shows on the upholstery tablet, marked, with why', /rework/.test(R.rwCard) && /Seam open/.test(R.rwCard), R.rwCard);
await person('Sipho'); await startJob('CP-1002'); await person('Sipho'); await done();
R.qc = (await cardsOf('d2')).find(c => c.qc);
check('the fix done: the check is Ready again', R.qc.status === 'ready' && !R.qc.waitingOn, R.qc);
await station('QC'); await person('Thandi'); await startJob('CP-1002'); await person('Thandi'); await done();
await station('Packing'); await person('Pieter'); await startJob('CP-1002'); await person('Pieter'); await done(); await wait(500);
R.o = await ls('orders'); R.c2 = await cardsOf('d2');
check('the last card done: the order is Done (ready), every card closed', R.o.d2.status === 'ready' && R.o.d2.readyAt && R.c2.every(c => !c.open && c.status === 'done'), [R.o.d2.status, R.c2.map(c => c.status)]);

// ---- clocking out stops the job
await station('Frame shop'); await person('Pieter'); await startJob('CP-1004');
await person('Pieter');
R.coLabel = await p.locator('[data-act="st-clockout"]').textContent();
await p.click('[data-act="st-clockout"]'); await wait(500);
const d4first = (await cardsOf('d4'))[0].id;
R.e5 = (await entries()).filter(e => e.staffId === 's3' && e.jobCardId === d4first).sort((a, b) => String(a.start).localeCompare(String(b.start))).pop();
R.att = (await ls('attendance'))[await p.evaluate(() => new Date().toLocaleDateString('en-CA'))];
check('Clock out stops the running job (marked why) and clocks him out', /stops this job/.test(R.coLabel) && R.e5 && !R.e5.open && R.e5.endReason === 'clocked out' && R.att.out.s3 && (await cardsOf('d4'))[0].status === 'paused', [R.coLabel, R.e5, R.att.out]);

// ---- a timer left running yesterday is stopped at the day's end
await p.evaluate(() => {
  const d = new Date(); d.setDate(d.getDate() - 1); const y = d.toLocaleDateString('en-CA');
  const m = JSON.parse(localStorage.getItem('cp-demo-timeEntries'));
  m['te-stale'] = { jobCardId: 'x-card', orderId: 'd4', workstationId: 'ws-uph', staffId: 's1', staffName: 'Sipho Dlamini', kind: 'work', start: new Date(y + 'T15:00:00').toISOString(), end: '', open: true, minutes: 0, day: y, pauseReason: '', rateAtTime: 183.87 };
  localStorage.setItem('cp-demo-timeEntries', JSON.stringify(m));
});
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#tabs [data-view]', { state: 'attached' }); await wait(1200);
R.stale = (await ls('timeEntries'))['te-stale'];
check('left running overnight: stopped at 17:00 that day (2 hours), marked as stopped by the system', R.stale && !R.stale.open && R.stale.autoClosed === true && R.stale.minutes === 120 && /Left running/.test(R.stale.editReason), R.stale);

// ---- a manager changes a time entry: who and why stay with it
await go('orders');
await p.evaluate(() => { const b = [...document.querySelectorAll('[data-act="filter-status"]')].find(x => x.dataset.to === 'ready'); if (b) b.click(); }); await wait();
await p.click('[data-act="jobs-order"][data-id="d2"]'); await wait(600);
R.modal = await p.locator('.modal-card').innerText();
check('the order\'s job cards: every step with who and how long, the rework among them', /Build frame/.test(R.modal) && /Rework: Upholster/.test(R.modal) && /Pieter Swart/.test(R.modal) && /Standard 6h 05/.test(R.modal), R.modal.slice(0, 400));
await p.locator('[data-te]').first().click(); await wait(300);
await p.evaluate(() => { const s = document.getElementById('te-start'), e = document.getElementById('te-end'); const st = new Date(s.value); e.value = new Date(st.getTime() + 75 * 60000 - st.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
await p.click('#modal-ok'); await wait(200);
R.noWhy = await p.locator('.modal-card h2').textContent();
await p.fill('#te-why', 'Forgot to press Done before lunch'); await p.click('#modal-ok'); await wait(700);
R.edited = (await entries()).find(e => e.editReason === 'Forgot to press Done before lunch');
check('a change needs a reason; saved with the new minutes, who and why; the order history says so', /Change a time entry/.test(R.noWhy) && R.edited && R.edited.minutes === 75 && R.edited.editedBy && R.edited.editedAt
  && ((await ls('orders')).d2.events || []).some(e => /changed from .* to 1h 15: Forgot to press Done/.test(e.what)), [R.noWhy, R.edited]);
await p.keyboard.press('Escape'); await wait();

// ---- cancelling an order closes its cards
await p.evaluate(() => { const b = [...document.querySelectorAll('[data-act="filter-status"]')].find(x => x.dataset.to === 'in-production'); if (b) b.click(); }); await wait();
await p.click('[data-act="cancel-order"][data-id="d4"]'); await wait(700);
R.c4 = await cardsOf('d4'); R.o = await ls('orders');
check('cancelled: its cards closed (not by the floor), the order no longer released', R.o.d4.status === 'cancelled' && R.c4.every(c => !c.open && c.skipped) && !R.o.d4.releasedAt, [R.o.d4.status, R.c4.map(c => [c.open, c.skipped])]);

// ---- a product with no steps goes into production the old way
await p.evaluate(() => { const m = JSON.parse(localStorage.getItem('cp-demo-orders')); m.dnr = { ...m.d2, orderNo: 'CP-1099', product: 'Custom bench', status: 'new', releasedAt: '', jobCards: 0, events: [], readyAt: '' }; localStorage.setItem('cp-demo-orders', JSON.stringify(m)); });
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#tabs [data-view]', { state: 'attached' }); await wait(1000);
await go('factory'); await p.click('[data-act="floor-view"][data-to="planner"]'); await wait();
R.oldLabel = await p.locator('[data-act="start"][data-id="dnr"]').textContent();
await p.click('[data-act="start"][data-id="dnr"]'); await wait(500);
check('no routing: "In production" as before, and no job cards', /In production/.test(R.oldLabel) && (await ls('orders')).dnr.status === 'in-production' && !(await cardsOf('dnr')).length && !(await ls('orders')).dnr.releasedAt, R.oldLabel);

// ---- the TV board, and the tablet on a phone
const tv = await ctx.newPage(); tv.on('pageerror', e => errs.push('TV ' + e.message));
await tv.goto(BASE + '?demo=1&board=1', { waitUntil: 'load' }); await tv.waitForSelector('.board.tv', { timeout: 15000 }); await tv.waitForTimeout(500);
R.tv = await tv.evaluate(() => ({ tabs: getComputedStyle(document.getElementById('tabs')).display, cols: document.querySelectorAll('.bd-col').length, title: !!document.querySelector('.bd-title'), times: !!document.querySelector('.bd-times') }));
check('?board=1: the board alone for the TV, no menu, no manager table', R.tv.tabs === 'none' && R.tv.cols === 6 && R.tv.title && !R.tv.times, R.tv);
const ph = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
ph.on('pageerror', e => errs.push('PHONE ' + e.message));
await ph.route(/fonts\.googleapis|fonts\.gstatic|gstatic\.com\/firebasejs/, r => r.abort());
await ph.goto(BASE + '?demo=1', { waitUntil: 'load' });
await ph.fill('#login-email', 'jean@couchpotato.co.za'); await ph.fill('#login-pass', 'x'); await ph.click('#login-form button[type=submit]');
await ph.waitForSelector('#menu-btn', { timeout: 15000 }); await ph.waitForTimeout(600);
await ph.goto(BASE + '?demo=1&station=ws-sew', { waitUntil: 'load' }); await ph.waitForSelector('.station', { timeout: 15000 }); await ph.waitForTimeout(500);
R.phone = await ph.evaluate(() => ({ where: document.querySelector('.st-where').textContent, w: document.documentElement.scrollWidth, names: document.querySelectorAll('.st-name').length, h: (document.querySelector('.st-name') || {}).offsetHeight }));
check('?station=<id> on a phone: straight onto that station, names big enough to tap, nothing wider than the screen', R.phone.where === 'Sewing' && R.phone.w <= 390 && R.phone.names === 4 && R.phone.h >= 60, R.phone);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
console.log(fails.length || errs.length ? fails.length + ' FAILED' : 'jobcards: all passed');
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
