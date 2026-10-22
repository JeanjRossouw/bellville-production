// Retail POS step 15 in the browser: quick-add at the till with POPIA
// consent (through the server, one profile per number), the Customers
// tab and profile, a sale that earns points and prints them, points as
// payment, and a merge and an anonymisation by a manager.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const crash = (e) => { console.log(JSON.stringify({ fails, errs, ...R, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : 'doubleValue' in f ? f.doubleValue : null;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
const pinRec = (pin) => { const salt = '56'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await put('pos/retail/users/st_cathy', { email: '', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/users/st_mandla', { email: '', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put('pos/retail/pinHashes/st_cathy', { ...pinRec('111111'), ...srv('BF') }); await put('pos/retail/pinHashes/st_mandla', { ...pinRec('222222'), ...srv('BF') });
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, loyalty: { enabled: true, pointsPerRand: 1, pointValueCents: 5, minRedeemPoints: 100, expiryMonths: 12, tiers: [{ name: 'Bronze', fromCents: 0, multiplier: 1 }] }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
const secret = 'cu-secret-' + Date.now();
await put('pos/retail/devices/dev_cu', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_cu') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_lamp', { name: 'Lamp', barcodes: ['LAMP'], priceCents: 50000, costCents: 20000 });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000 });
await put('pos/retail/stockLevels/BF-BELL_p_lamp', { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 0, ...srv('BF', 'BF-BELL') });
await put('pos/retail/stockLevels/BF-BELL_p_cushion', { productId: 'p_cushion', variantId: '', onHandQty: 5, reservedQty: 0, ...srv('BF', 'BF-BELL') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__downloads = []; window.open = () => { const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_cu', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Customer request (POPIA)' : undefined));
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const nav = async (v) => { await p.click('#nav [data-view=' + v + ']'); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const modalText = () => p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const paper = () => p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1000);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Customers tab present for a cashier', R.nav.includes('customers'), R.nav);

// ---- quick-add at the till with consent; the same number again attaches
await scan('LAMP');
await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.click('#modal summary');
await p.fill('#cu-name', 'Thandi Mokoena'); await p.fill('#cu-phone', '082 555 0101'); await p.check('#cu-whatsapp');
await p.click('#cu-add'); R.added = await toast(); await p.waitForTimeout(800);
check('added through the server', /Thandi Mokoena added/.test(R.added) && /Thandi Mokoena/.test(await p.locator('.pos-right').innerText()), R.added);
const c1 = (await listColl('customers'))[0];
check('written with the key and dated WhatsApp consent from the till', c1 && c1.phoneKey === '27825550101' && c1.consent.whatsapp.granted && c1.consent.whatsapp.source === 'till' && c1.consent.whatsapp.byName === 'Cathy' && !c1.consent.sms.granted, c1 && c1.consent);
// a sale: R 500 → 500 points on the slip
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay'); await p.click('[data-m=card]'); await p.waitForTimeout(150); await p.click('[data-add=card]'); await p.waitForTimeout(200); await p.click('#modal-ok'); R.sold = await toast(); await p.waitForTimeout(1200);
try { await p.waitForSelector('#modal .rc-paper', { timeout: 8000 }); } catch (e) { R.afterSale = (await p.locator('#modal').count()) ? await modalText() : 'no modal · ' + (await screenText()).slice(0, 200); }
R.slip = (await p.locator('#modal .rc-paper').count()) ? await paper() : ''; check('the slip shows the points earned and the balance', /Points earned 500 · balance 500 · Bronze/.test(R.slip), R.slip);
await closeModal();
// the same number again from the quick-add attaches the existing profile
await scan('CUSH'); await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.click('#modal summary');
await p.fill('#cu-name', 'T Mokoena'); await p.fill('#cu-phone', '0825550101'); R.qa2 = await p.evaluate(() => ({ modals: document.querySelectorAll('#modal').length, names: [...document.querySelectorAll('#cu-name')].map(e => e.value), phones: [...document.querySelectorAll('#cu-phone')].map(e => e.value), adds: document.querySelectorAll('#cu-add').length, open: !!document.querySelector('#modal details').open, active: document.activeElement && document.activeElement.id })); await p.click('#cu-add'); R.dup = await toast(); await p.waitForTimeout(500); if (!/attached/.test(R.dup)) { await p.click('#cu-add'); R.dup = await toast(); await p.waitForTimeout(500); }
check('the number already known: attached, not duplicated', /That number is Thandi Mokoena: attached/.test(R.dup) && (await listColl('customers')).length === 1, R.dup);
// points pay for the cushion: 500 points = R 25, the rest by card
await p.click('[data-act=sl-pay]'); await p.waitForSelector('#modal .pay');
check('Points is offered on the payment screen', (await p.locator('[data-m=points]').count()) === 1 && await p.locator('[data-m=points]').isEnabled());
await p.click('[data-m=points]'); await p.waitForTimeout(150);
R.ptsForm = await modalText(); check('the points form names the balance and value', /has 500 points, worth R 25\.00/.test(R.ptsForm), R.ptsForm.slice(0, 300));
await p.click('[data-add=points]'); await p.waitForTimeout(200); await p.click('[data-m=card]'); await p.waitForTimeout(150); await p.click('[data-add=card]'); await p.waitForTimeout(200);
await p.click('#modal-ok'); R.sold2 = await toast(); await p.waitForTimeout(1200);
await p.waitForSelector('#modal .rc-paper'); R.slip2 = await paper(); check('the slip: points used 500, earned on the R 174 by card, the balance', /Points \(500\) R 25\.00/.test(R.slip2) && /Card R 174\.00/.test(R.slip2) && /Points earned 174 · used 500 · balance 174/.test(R.slip2), R.slip2);
await closeModal();

// ---- the Customers tab: the profile, consent, history
await nav('customers'); await p.waitForSelector('.cu-tbl');
R.list = await screenText(); check('listed with consent, points and spend', /Thandi Mokoena/.test(R.list) && /WhatsApp/.test(R.list) && /174/.test(R.list) && /R 699\.00/.test(R.list) && /2 sales/.test(R.list), R.list.slice(0, 400));
await p.click('[data-act=cu-open]'); await p.waitForSelector('#modal .lb-detail'); await p.waitForTimeout(1200);
R.prof = await modalText(); check('the profile: consent with the date, points, the two sales, the ledger', /WhatsApp: yes/.test(R.prof) && /by Cathy \(till\)/.test(R.prof) && /SMS: no/.test(R.prof) && /Points · Bronze 174/.test(R.prof) && /BF-000001/.test(R.prof) && /BF-000002/.test(R.prof) && /redeem/.test(R.prof) && !/Anonymise/.test(R.prof), R.prof.slice(0, 600));
await p.click('[data-act=cu-consent][data-ch=sms][data-on="1"]'); R.cons = await toast(); await p.waitForTimeout(900);
check('SMS consent recorded from the profile', /Opted in to sms, recorded/.test(R.cons) && (await listColl('customers'))[0].consent.sms.granted === true, R.cons);
await p.waitForSelector('#modal .lb-detail'); await closeModal();

// ---- a manager merges a duplicate and anonymises
await p.click('[data-act=cu-new]'); await p.waitForSelector('#modal #cf-name'); await p.fill('#cf-name', 'Thandi M (dup)'); await p.fill('#cf-phone', '0825550199'); await p.click('#modal-ok'); R.new = await toast(); await p.waitForTimeout(800);
check('a second profile made from the tab', /Saved Thandi M \(dup\)/.test(R.new), R.new);
await p.click('#lock'); await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '222222'); await p.waitForSelector('#nav [data-view=customers]'); await p.waitForTimeout(1000);
await nav('customers'); await p.waitForSelector('.cu-tbl');
await p.click('.cu-tbl tr:has-text("Thandi Mokoena") [data-act=cu-open]'); await p.waitForSelector('#modal [data-act=cu-merge]'); await p.waitForTimeout(600);
await p.click('[data-act=cu-merge]'); await p.waitForSelector('#modal #mg-drop');
const dupId = (await listColl('customers')).find(c => c.name === 'Thandi M (dup)').id;
await p.selectOption('#mg-drop', dupId); await p.click('#modal-ok'); R.merged = await toast(); await p.waitForTimeout(900);
check('merged by the manager', /Merged/.test(R.merged), R.merged);
const kept = (await listColl('customers')).find(c => c.name === 'Thandi Mokoena');
check('the duplicate folded in: second number, archived', kept.altPhones.includes('27825550199') && kept.mergedIds.includes(dupId) && (await getDoc('pos/retail/customers/' + dupId)).mergedInto === kept.id, kept.altPhones);
await p.waitForTimeout(500);
R.list2 = await screenText(); check('the merged profile left the active list', !/Thandi M \(dup\)/.test(R.list2), R.list2.slice(0, 300));
await p.click('.cu-tbl tr:has-text("Thandi Mokoena") [data-act=cu-open]'); await p.waitForSelector('#modal [data-act=cu-anon]'); await p.waitForTimeout(400);
await p.click('[data-act=cu-anon]'); R.anon = await toast(); await p.waitForTimeout(900);
const after = await getDoc('pos/retail/customers/' + kept.id);
check('anonymised: the details gone, the number freed; the invoice keeps its snapshot', /Anonymised/.test(R.anon) && after.name === 'Anonymised customer' && after.phone === '' && after.anonymised && (await getDoc('pos/retail/customerPhones/BF_27825550101')) === null && (await listColl('sales')).every(s => s.customerSnapshot.name === 'Thandi Mokoena'), [R.anon, after.name]);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
