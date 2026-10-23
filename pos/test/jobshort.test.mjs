// Factory Manager job cards, phase 3, in the demo: shortages, the customer's
// own fabric (COM) and outside work.
// The COM fee setting; a COM order (the fee on the price, its fabric left out
// of the stock check, off the shelf and the cost, a COM tag on the cards, the
// stock room books the roll in against that order, cutting's metres written
// beside it). Releasing an order short: the check shows each material (short,
// on order with the purchase order), Not now leaves it, Release anyway puts it
// on the floor with "material short", Order what is short drafts the supplier's
// purchase order, Stock → Order now names the order, and the tag goes once the
// shelf is right. A step done outside: ready to send, sent (supplier, due
// date, quote), on the board, overdue on Today, booked back in (the next step
// Ready), the invoice entered and on the cost card against the quote.
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
const setLs = (coll, fn) => p.evaluate(([c, f]) => { const m = JSON.parse(localStorage.getItem('cp-demo-' + c) || '{}'); new Function('m', f)(m); localStorage.setItem('cp-demo-' + c, JSON.stringify(m)); }, [coll, fn]);
const reload = async () => { await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#tabs [data-view]', { state: 'attached' }); await wait(1000); };
const go = async (v) => { await p.evaluate(v => document.querySelector(`#tabs [data-view="${v}"]`).click(), v); await wait(350); };
const station = async (name) => { await go('stations'); if (await p.locator('[data-act="st-change"]').count()) { await p.click('[data-act="st-change"]'); await wait(); } await p.click(`[data-act="st-station"]:has-text("${name}")`); await wait(); };
const person = async (name) => { await p.click(`[data-act="st-person"]:has-text("${name}")`); await wait(); };
const startJob = async (orderNo) => { await p.click(`.st-job:has(.st-no:text-is("${orderNo}")) [data-act="st-start"]`); await wait(400); };
const byNo = async (no) => (await list('orders')).find(o => o.orderNo === no);
const cardsOf = async (orderId) => (await list('jobCards')).filter(c => c.orderId === orderId).sort((a, b) => a.sequence - b.sequence);
async function newOrder(product, com) {
  await go('orders'); await p.click('[data-act="new-order"]'); await wait(300);
  await p.selectOption('#o-cust', 'd-bellville'); await p.fill('#o-product', product); await p.dispatchEvent('#o-product', 'change'); await wait(100);
  R.priceBefore = await p.inputValue('#o-price');
  if (com) { await p.fill('#o-fabric', "Client's velvet: Teal"); await p.check('#o-com'); await wait(100); }
  R.priceAfter = await p.inputValue('#o-price');
  await p.click('#modal-ok'); await wait(500);
  const all = await list('orders');
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}

// ---- the COM fee, then a COM order
await go('settings'); await p.fill('#s-comfee', '350'); await p.click('[data-act="save-settings"]'); await wait(500);
check('the COM fee is a setting', (await ls('settings')).factory.comFee === 350);
const com = await newOrder('2 Seater Amber', true);
check('ticking COM adds the R 350 fee to the price', R.priceBefore === '6400' && R.priceAfter === '6750' && com.com === true && com.comFee === 350 && com.priceEach === 6750, [R.priceBefore, R.priceAfter, com.com, com.comFee]);
R.comCard = await p.locator(`.card.order:has-text("${com.orderNo}")`).innerText();
check('the order shows COM', /COM/.test(R.comCard));

// ---- release it short: foam low, the seat foam out but on order
const fab0 = (await ls('materials'))['m-fab'].onHand;
await setLs('materials', "m['m-foam'].onHand = 1; m['m-foam100'].onHand = 0;"); await reload();
await go('factory');
await p.click(`[data-act="start"][data-id="${com.id}"]`); await wait(500);
R.check = await p.locator('.modal-card').innerText().catch(() => '');
check('the check: foam short by 2.2, the seat foam on order (PO-0001), the customer\'s fabric not in it',
  /Materials for/i.test(R.check) && /Foam 50mm HD[\s\S]*Short[\s\S]*2\.2 m² short/i.test(R.check) && /Foam 100mm seat[\s\S]*On order[\s\S]*1\.5 m² short now, coming[\s\S]*PO-0001/i.test(R.check) && !/Fabric/.test(R.check), R.check.slice(0, 700));
await p.click('.modal-foot [data-close]'); await wait(300);
check('Not now: still New, nothing taken', (await byNo(com.orderNo)).status === 'new' && !(await cardsOf(com.id)).length);
await p.click(`[data-act="start"][data-id="${com.id}"]`); await wait(500);
await p.click('#modal-ok'); await wait(800);
R.o = await byNo(com.orderNo);
check('Release anyway: on the floor, the shortfall kept on the order', R.o.status === 'in-production' && R.o.shortAtRelease.map(l => l.materialId).sort().join() === 'm-foam,m-foam100' && (await cardsOf(com.id)).length === 6, [R.o.status, R.o.shortAtRelease]);
check('the shelf: foam below nothing, the customer\'s fabric not taken', (await ls('materials'))['m-foam'].onHand < 0 && (await ls('materials'))['m-fab'].onHand === fab0);
R.c = await cardsOf(com.id);
check('the cutting card carries the fabric as the customer\'s, at R0; the plan leaves it out of the cost', R.c[1].com === true && R.c[1].bom[0].com === true && R.c[1].bom[0].unitCost === 0 && R.o.planned.lines.find(l => l.materialId === 'm-fab').cost === 0, [R.c[1].bom, R.o.planned.materials]);
await p.click('[data-act="floor-view"][data-to="planner"]').catch(() => {}); await wait();
R.tag = await p.locator(`.pcard:has-text("${com.orderNo}")`).innerText();
check('the planner card: COM and material short', /COM/.test(R.tag) && /material short/i.test(R.tag), R.tag);
// Order what is short: one supplier, its purchase order drafted
await go('orders');
await p.evaluate(() => { const b = [...document.querySelectorAll('[data-act="filter-status"]')].find(x => x.dataset.to === 'in-production'); if (b) b.click(); }); await wait();
await p.click(`[data-act="order-short"][data-id="${com.id}"]`); await wait(500);
R.po = await p.evaluate(() => ({ title: (document.querySelector('.modal-card h2') || {}).textContent, sup: (document.getElementById('po-sup') || {}).value, mats: [...document.querySelectorAll('.po-row .po-mat')].map(s => s.value) }));
check('Order what is short: Foam Factory\'s purchase order, drafted with the foam', /New purchase order/.test(R.po.title) && R.po.sup === 'Foam Factory' && R.po.mats.includes('m-foam'), R.po);
await p.click('.modal-foot [data-close]'); await wait();
await go('stock');
R.orderNow = await p.locator('.stock-order').innerText();
check('Stock → Order now names the order the foam is for', new RegExp('Foam 50mm HD\\s*for[^\\n]*' + com.orderNo, 'i').test(R.orderNow), R.orderNow.slice(0, 500));
// the delivery comes in: the tag goes
await setLs('materials', "m['m-foam'].onHand = 40; m['m-foam100'].onHand = 20;"); await reload();
await go('orders');
check('the shelf right again: no more material short', !/material short/i.test(await p.locator(`.card.order:has-text("${com.orderNo}")`).innerText()));

// ---- the customer's roll comes in, cutting takes from it
await go('storeroom');
R.sr = await p.locator(`.sr-row:has-text("${com.orderNo}")`).innerText();
await p.click(`[data-act="sr-fabric"][data-id="${com.id}"]`); await wait(300);
await p.fill('#fa-m', '10'); await p.fill('#fa-r', '1'); await p.click('#modal-ok'); await wait(500);
R.cs = (await ls('comStock'))[com.id];
check('the stock room books the customer\'s roll against this order only', /COM/.test(R.sr) && R.cs && R.cs.metres === 10 && R.cs.orderNo === com.orderNo && (await byNo(com.orderNo)).fabricStatus === 'received', [R.sr, R.cs]);
await station('Frame shop'); await person('Pieter'); await startJob(com.orderNo); await person('Pieter'); await p.click('[data-act="st-done"]'); await wait(600); await p.click('[data-act="st-done-ok"]'); await wait(500);
await station('Cutting table');
R.cutCard = await p.locator(`.st-job:has(.st-no:text-is("${com.orderNo}"))`).innerText();
await person('Thandi'); await startJob(com.orderNo);
R.cs = (await ls('comStock'))[com.id]; R.iss = (await list('materialIssues')).filter(i => i.orderId === com.id && i.materialId === 'm-fab');
check('the cutting tablet shows COM; starting takes 9 m from the customer\'s roll at R0', /COM/.test(R.cutCard) && R.cs.usedMetres === 9 && R.iss.length === 1 && R.iss[0].com === true && R.iss[0].cost === 0, [R.cutCard, R.cs, R.iss]);
await person('Thandi'); await p.click('[data-act="st-done"]'); await wait(600);
R.mat = await p.locator('.st-mat[data-iss]').first().innerText();
await p.fill('.st-mat[data-iss] .st-mat-qty', '9.5'); await p.selectOption('.st-mat[data-iss] .st-mat-why', 'Pattern match'); await p.click('[data-act="st-done-ok"]'); await wait(600);
R.cs = (await ls('comStock'))[com.id];
check('Done: 9.5 m written beside the customer\'s roll; the shop\'s fabric untouched', /the customer's roll/.test(R.mat) && R.cs.usedMetres === 9.5 && (await ls('materials'))['m-fab'].onHand === fab0, [R.mat, R.cs]);

// ---- outside work: a corner unit, its arm panels cut on a CNC outside
const corner = await newOrder('Corner Unit 2.8 x 2.8', false);
await go('factory'); await p.click(`[data-act="start"][data-id="${corner.id}"]`); await wait(600);
if (await p.locator('#modal-ok').count()) { await p.click('#modal-ok'); await wait(600); }
R.cc = await cardsOf(corner.id);
R.co = await byNo(corner.orderNo);
check('released: the CNC step first, Ready, not at any station, with its quote; the plan carries R 450 outside', R.cc[0].operationName === 'CNC arm panels' && R.cc[0].status === 'ready' && R.cc[0].workstationId === '' && R.cc[0].outsourced.quote === 450 && R.cc[0].outsideOpen === true && R.co.planned.outside === 450 && R.co.planned.ops.length === 6, [R.cc[0], R.co.planned.outside]);
await station('Frame shop');
check('the frame shop does not see it yet (it waits on the CNC)', !(await p.locator(`.st-job:has(.st-no:text-is("${corner.orderNo}"))`).count()));
await go('factory'); await p.click('[data-act="floor-view"][data-to="outside"]'); await wait();
R.ow = await p.locator('#screen').innerText();
check('Outside work: ready to send out', /Ready to send out/i.test(R.ow) && new RegExp(corner.orderNo).test(R.ow) && /CNC arm panels/.test(R.ow), R.ow.slice(0, 500));
await p.click(`[data-act="ow-send"][data-id="${R.cc[0].id}"]`); await wait(300);
R.sendForm = await p.evaluate(() => ({ sup: document.getElementById('ow-sup').value, due: document.getElementById('ow-due').value, quote: document.getElementById('ow-quote').value }));
await p.click('#modal-ok'); await wait(500);
R.c0 = (await cardsOf(corner.id))[0];
check('Send out: Cape CNC, due in 5 days, quote R 450; the card is at the supplier', R.sendForm.sup === 'Cape CNC' && R.sendForm.quote === '450' && R.c0.status === 'out' && R.c0.outsourced.supplier === 'Cape CNC' && R.c0.outsourced.sentAt && R.c0.outsourced.dueAt === R.sendForm.due, [R.sendForm, R.c0.outsourced]);
await p.click('[data-act="floor-view"][data-to="board"]'); await wait();
check('the board has an At suppliers column with it', /At suppliers[\s\S]*CNC arm panels · Cape CNC/i.test(await p.locator('.board').innerText()));
// overdue: shows first, and on Today
await setLs('jobCards', `const k = Object.keys(m).find(x => m[x].orderId === '${corner.id}' && m[x].sequence === 1); m[k].outsourced.dueAt = '2020-01-01';`); await reload();
await go('home');
R.today = await p.locator('#screen').innerText();
check('Today: the overdue work from Cape CNC, with the way to it', /overdue back from Cape CNC/.test(R.today) && new RegExp(corner.orderNo + ' CNC arm panels').test(R.today), R.today.slice(0, 600));
await go('factory'); await p.click('[data-act="floor-view"][data-to="outside"]'); await wait();
check('Outside work: overdue, in red', /overdue/i.test(await p.locator('#screen').innerText()));
await p.click(`[data-act="ow-back"][data-id="${R.c0.id}"]`); await wait(700);
R.cc = await cardsOf(corner.id);
check('Back in: the CNC card done, the frame Ready; still listed for its invoice', R.cc[0].status === 'done' && R.cc[0].outsourced.receivedAt && R.cc[1].status === 'ready' && R.cc[0].outsideOpen === true && /Back, invoice to come/i.test(await p.locator('#screen').innerText()), R.cc.map(c => c.status));
await p.click(`[data-act="ow-invoice"][data-id="${R.c0.id}"]`); await wait(300);
await p.fill('#ow-inv', '480'); await p.fill('#ow-ref', 'INV-77'); await p.click('#modal-ok'); await wait(700);
R.c0 = (await cardsOf(corner.id))[0];
check('the invoice: R 480, INV-77; off the outside list', R.c0.outsourced.invoice === 480 && R.c0.outsourced.invoiceRef === 'INV-77' && R.c0.outsideOpen === false && !new RegExp(corner.orderNo).test(await p.locator('#screen').innerText()), R.c0.outsourced);
await go('orders');
await p.click(`[data-act="order-cost"][data-id="${corner.id}"]`); await wait(900);
R.cost = await p.locator('.modal-card').innerText();
check('the cost card: outside work R 450 quoted against R 480 invoiced (+7%), Cape CNC', /Outside work\s+R 450\.00\s+R 480\.00\s+\+R 30\.00 \(\+7%\)/.test(R.cost) && /CNC arm panels Cape CNC/.test(R.cost), R.cost.slice(0, 900));
await p.click('.modal-foot [data-close]'); await wait();
await p.click(`[data-act="order-cost"][data-id="${com.id}"]`); await wait(900);
check('the COM order\'s cost card: its fabric as the customer\'s own, at nothing', /Fabric \(standard range\)[^\n]*COM[^\n]*\tR 0\.00/.test(await p.locator('.modal-card').innerText()), (await p.locator('.modal-card').innerText()).slice(0, 700));

console.log(JSON.stringify({ fails, errs, ...R, check: process.env.FULL ? R.check : undefined, cost: undefined, today: undefined, orderNow: undefined }, null, 1).slice(0, 4000));
console.log(fails.length || errs.length ? fails.length + ' FAILED' : 'jobshort: all passed');
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
