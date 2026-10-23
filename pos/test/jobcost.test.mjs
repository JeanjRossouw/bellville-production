// Factory Manager job costing (phase 2 of the job cards spec), in the demo.
// Releasing freezes the planned cost on the order (the bill at today's
// prices, each step's minutes at its station rate), and gives each card its
// share of the bill; a price change afterwards leaves the plan alone.
// Starting a step issues its materials once, at the price of the day; at
// Done the person corrects them (more than planned needs a reason), adds one
// not on the list, and the shelf moves by the difference. The order's actual
// cost is worked out when it is done; the cost card shows planned against
// actual (steps not reached "not yet" while it is on the floor), rework as
// loss, the margin, and prints with asterisks. The report under Profit lists
// margin per order and product, labour per step, rework by whose step it went
// back to, idle time, and suggested standard times that can be used.
import { chromium } from 'playwright';
const BASE = process.env.FM_BASE || 'http://localhost:8788/couchpotato/';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic|gstatic\.com\/firebasejs/, r => r.abort());
// the printout: catch what would be written to the print window
await ctx.addInitScript(() => { window.__printed = []; window.open = () => ({ document: { write: (h) => window.__printed.push(h), close() {} }, focus() {}, print() {} }); });
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
const station = async (name) => { await go('stations'); if (await p.locator('[data-act="st-change"]').count()) { await p.click('[data-act="st-change"]'); await wait(); } await p.click(`[data-act="st-station"]:has-text("${name}")`); await wait(); };
const person = async (name) => { await p.click(`[data-act="st-person"]:has-text("${name}")`); await wait(); };
const startJob = async (orderNo) => { await p.click(`.st-job:has(.st-no:text-is("${orderNo}")) [data-act="st-start"]`); await wait(400); };
const openDone = async () => { await p.click('[data-act="st-done"]'); await wait(600); };
const doneOk = async () => { await p.click('[data-act="st-done-ok"]'); await wait(500); };
const step = async (st, who, no) => { await station(st); await person(who); await startJob(no); await person(who); await openDone(); await doneOk(); };
const cardsOf = async (orderId) => (await list('jobCards')).filter(c => c.orderId === orderId).sort((a, b) => a.sequence - b.sequence || (a.isRework ? 1 : 0) - (b.isRework ? 1 : 0));
const r2 = (n) => Math.round(n * 100) / 100;

// ---- the cost card of CP-1001, half built
await go('orders');
await p.evaluate(() => { const b = [...document.querySelectorAll('[data-act="filter-status"]')].find(x => x.dataset.to === 'in-production'); if (b) b.click(); }); await wait();
await p.click('[data-act="order-cost"][data-id="d1"]'); await wait(800);
R.card1 = await p.locator('.modal-card').innerText();
check('on the floor: issued lines with their reasons, steps not reached "not yet", the variance so far, the margin when done',
  /Pine 38×76 22 → 24 m · Cutting error/.test(R.card1) && /\+R 56\.00 \(\+9%\)/.test(R.card1) && /not yet/.test(R.card1) && /so far/.test(R.card1) && /when it is done/.test(R.card1) && /2 of 6 steps done/.test(R.card1), R.card1.slice(0, 900));
await p.click('.modal-foot [data-close]'); await wait();

// ---- each material is used at a step (Costing)
await go('costing');
await p.locator('tr:has-text("2 Seater Amber") [data-act="edit-product"]').click(); await wait();
R.bomOps = await p.$$eval('.bom-row', rows => rows.map(r => [r.querySelector('.bom-mat').selectedOptions[0].textContent.split(' (')[0], (r.querySelector('.bom-op') || { selectedOptions: [{ textContent: '' }] }).selectedOptions[0].textContent]));
check('the bill says where each material is used', R.bomOps.find(x => /Pine/.test(x[0]))[1] === 'used at Build frame' && R.bomOps.find(x => /Fabric/.test(x[0]))[1] === 'used at Cut fabric' && R.bomOps.find(x => /Foam 50/.test(x[0]))[1] === 'used at Upholster', R.bomOps);
await p.click('.modal-foot [data-close]'); await wait();

// ---- release CP-1002: the plan is frozen
const mats0 = await ls('materials');
await go('factory'); await p.click('[data-act="start"][data-id="d2"]'); await wait(600);
R.o2 = (await ls('orders')).d2; R.c2 = await cardsOf('d2');
const prods = await ls('products'), amber = prods['p-2s'];
const expMat = r2(amber.materials.reduce((s, l) => s + l.qty * mats0[l.materialId].cost, 0));
const ohH = r2(68000 / 1550), ws = await ls('workstations'), ops = await ls('operations');
const expLab = r2(amber.routing.reduce((s, r) => s + r2(r.stdMinutes / 60 * r2(ws[ops[r.operationId].workstationId].staffHourlyCost + ohH)), 0));
check('released: the plan is frozen on the order (the bill at today\'s prices, the steps at station rates)', R.o2.planned && Math.abs(R.o2.planned.materials - expMat) < 0.05 && Math.abs(R.o2.planned.labour - expLab) < 0.05 && R.o2.planned.lines.length === amber.materials.length && R.o2.planned.ops.length === 6, [R.o2.planned && R.o2.planned.materials, expMat, R.o2.planned && R.o2.planned.labour, expLab]);
check('each card carries its share of the bill', R.c2[0].bom.map(l => l.materialId).sort().join() === 'm-pine,m-ply,m-web' && R.c2[1].bom.map(l => l.materialId).join() === 'm-fab' && R.c2[2].bom.length === 0 && R.c2[0].bom.find(l => l.materialId === 'm-pine').qty === 16, R.c2.map(c => c.bom.map(l => l.materialId)));
// the timber goes up after release: the plan stays, the issue takes the new price
await p.evaluate(() => { const m = JSON.parse(localStorage.getItem('cp-demo-materials')); m['m-pine'].cost = 30; localStorage.setItem('cp-demo-materials', JSON.stringify(m)); });
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#tabs [data-view]', { state: 'attached' }); await wait(1000);
check('a price change after release leaves the plan alone', (await ls('orders')).d2.planned.materials === R.o2.planned.materials);

// ---- the frame shop: start issues the materials once
const pine0 = (await ls('materials'))['m-pine'].onHand || 0;
await station('Frame shop'); await person('Pieter'); await startJob('CP-1002');
R.iss = (await list('materialIssues')).filter(i => i.jobCardId === R.c2[0].id);
check('starting the step issued its three materials as planned, at the price of the day', R.iss.length === 3 && R.iss.find(i => i.materialId === 'm-pine').qty === 16 && R.iss.find(i => i.materialId === 'm-pine').unitCostAtTime === 30 && R.iss.find(i => i.materialId === 'm-pine').cost === 480 && (await cardsOf('d2'))[0].issued === true, R.iss);
await person('Pieter'); await p.click('[data-act="st-pause"]'); await wait(); await p.click('[data-act="st-pause-why"][data-why="Tea or lunch"]'); await wait(400);
await person('Pieter'); await startJob('CP-1002');
check('starting again issues nothing twice', (await list('materialIssues')).filter(i => i.jobCardId === R.c2[0].id).length === 3);
// Done: more timber than planned, at first without a reason
await person('Pieter'); await openDone();
R.doneRows = await p.$$eval('.st-mat[data-iss] .st-mat-name', x => x.map(y => y.textContent));
await p.fill('.st-mat:has(.st-mat-name:has-text("Pine")) .st-mat-qty', '18.5');
await doneOk();
R.stillDone = await p.locator('[data-act="st-done-ok"]').count();
check('Done lists the step\'s materials; more than planned without a reason is refused', R.doneRows.length === 3 && R.stillDone === 1 && (await cardsOf('d2'))[0].status !== 'done', [R.doneRows, R.stillDone]);
await p.selectOption('.st-mat:has(.st-mat-name:has-text("Pine")) .st-mat-why', 'Offcut wasted');
await p.click('[data-act="st-extra"]'); await wait();
await p.selectOption('.st-mat.st-extra .st-x-mat', 'm-stap'); await p.fill('.st-mat.st-extra .st-mat-qty', '1'); await p.selectOption('.st-mat.st-extra .st-mat-why', 'Cutting error');
await doneOk(); await wait(300);
R.iss = (await list('materialIssues')).filter(i => i.jobCardId === R.c2[0].id);
R.pine = R.iss.find(i => i.materialId === 'm-pine'); R.extra = R.iss.find(i => i.extra);
R.moves = (await list('stockMoves')).filter(m => m.ref === 'CP-1002' && /Build frame/.test(m.note || ''));
check('saved: 18.5 m of timber with why, an extra pack of staples, the shelf down by the difference', R.pine.qty === 18.5 && R.pine.cost === 555 && R.pine.varianceReason === 'Offcut wasted' && R.pine.adjustedBy === 'Pieter Swart'
  && R.extra && R.extra.materialId === 'm-stap' && R.extra.plannedQty === 0 && R.extra.varianceReason === 'Cutting error'
  && Math.abs(((await ls('materials'))['m-pine'].onHand || 0) - (pine0 - 2.5)) < 0.001 && R.moves.length === 2 && R.moves.some(m => m.qty === -2.5 && /Offcut wasted/.test(m.note)), [R.pine, R.extra, R.moves]);
check('the frame card is done; cutting is ready', (await cardsOf('d2'))[0].status === 'done' && (await cardsOf('d2'))[1].status === 'ready');

// ---- the rest of the steps; the check fails back to upholstery once
await step('Cutting table', 'Thandi', 'CP-1002');
await step('Sewing', 'Thandi', 'CP-1002');
await step('Upholstery', 'Sipho', 'CP-1002');
await station('QC'); await person('Thandi'); await startJob('CP-1002'); await person('Thandi');
await p.click('[data-act="st-fail"]'); await wait(500); await p.fill('#st-why', 'Pleat uneven'); await p.click('[data-act="st-fail-to"]:has-text("Upholster")'); await wait(500);
R.rw = (await cardsOf('d2')).find(c => c.isRework);
check('the rework card remembers whose step it went back to', R.rw && R.rw.causedBy === 'Sipho Dlamini' && R.rw.issued === true, R.rw);
await step('Upholstery', 'Sipho', 'CP-1002');
await step('QC', 'Thandi', 'CP-1002');
await step('Packing', 'Pieter', 'CP-1002'); await wait(800);
R.o2 = (await ls('orders')).d2;
R.allIss = (await list('materialIssues')).filter(i => i.orderId === 'd2');
check('the order is done and its actual cost kept on it: every material issued, the timed labour', R.o2.status === 'ready' && R.o2.actual && R.o2.actual.complete === true
  && Math.abs(R.o2.actual.materials - r2(R.allIss.reduce((s, i) => s + i.cost, 0))) < 0.02 && R.allIss.length === amber.materials.length + 1 && R.o2.actual.total >= R.o2.actual.materials, [R.o2.status, R.o2.actual]);

// ---- a manager makes the frame time real (75 minutes); the actual follows
await go('orders');
await p.evaluate(() => { const b = [...document.querySelectorAll('[data-act="filter-status"]')].find(x => x.dataset.to === 'ready'); if (b) b.click(); }); await wait();
await p.click('[data-act="jobs-order"][data-id="d2"]'); await wait(600);
await p.locator('.jc-row:has-text("Build frame") [data-te]').first().click(); await wait(300);
await p.evaluate(() => { const s = document.getElementById('te-start'), e = document.getElementById('te-end'); const st = new Date(s.value); e.value = new Date(st.getTime() + 75 * 60000 - st.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
await p.fill('#te-why', 'Clock card says 75 minutes'); await p.click('#modal-ok'); await wait(900);
await p.keyboard.press('Escape'); await wait();
R.o2 = (await ls('orders')).d2;
check('the correction flows into the actual labour (75 min at R 113.87 an hour is at least R 142.34)', R.o2.actual.labour >= 142.33, R.o2.actual);
await p.click('[data-act="order-cost"][data-id="d2"]'); await wait(900);
R.card2 = await p.locator('.modal-card').innerText();
check('the finished cost card: no "not yet", the timber line with why, rework as loss, the margin on the price excl. VAT', !/not yet/.test(R.card2) && /Pine 38×76 16 → 18\.5 m · Offcut wasted/.test(R.card2) && /all of it is loss|Rework/.test(R.card2) && /Margin on R 5,565\.22 excl\. VAT/.test(R.card2) && !/when it is done/.test(R.card2), R.card2.slice(0, 1200));
await p.click('#modal-ok'); await wait(400);
R.print = await p.evaluate(() => window.__printed.join(''));
check('printed in black and white: over 15% bold with two asterisks, the key at the foot', /ORDER COST — INTERNAL/.test(R.print) && /\*\*/.test(R.print) && /font-weight:800/.test(R.print) && /\* 5–15% over or under plan\. \*\* more than 15%/.test(R.print), R.print.slice(0, 300));
await p.click('.modal-foot [data-close]'); await wait();

// ---- the report under Profit
await go('profit'); await p.click('[data-act="pf-view"][data-to="jobs"]'); await wait(2000);
R.rep = await p.locator('#screen').innerText();
check('the report: CP-1002 in margin per order and per product, the steps against standard, rework by whose step, idle time',
  /Margin per order, worst first/i.test(R.rep) && /CP-1002/.test(R.rep) && /2 Seater Amber/.test(R.rep) && /Build frame/.test(R.rep) && /Sent back from the step of/i.test(R.rep) && /Sipho Dlamini/.test(R.rep) && /Idle time per person/i.test(R.rep), R.rep.slice(0, 1500));
R.use = await p.locator('[data-act="jc-use-std"][data-product="p-2s"][data-op="op-frame"]').getAttribute('data-min').catch(() => null);
check('suggested standard time for the 2 Seater frame: the 75 minutes timed', R.use === '75', R.use);
if (R.use) { await p.click('[data-act="jc-use-std"][data-product="p-2s"][data-op="op-frame"]'); await wait(800); }
check('Use sets the product\'s standard time', (await ls('products'))['p-2s'].routing.find(s => s.operationId === 'op-frame').stdMinutes === 75 && (await ls('orders')).d2.planned.ops.find(x => x.operationId === 'op-frame').minutes === 90);
await p.click('[data-act="jc-period"][data-to="90"]'); await wait(1500);
check('the 90-day view loads too', /Last 90 days/i.test(await p.locator('#screen').innerText()) && /CP-1002/.test(await p.locator('#screen').innerText()));

console.log(JSON.stringify({ fails, errs, ...R, card1: undefined, card2: undefined, rep: undefined, print: undefined }, null, 1).slice(0, 5000));
console.log(fails.length || errs.length ? fails.length + ' FAILED' : 'jobcost: all passed');
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
