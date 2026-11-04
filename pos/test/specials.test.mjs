// Retail POS step 12 in the browser: a custom order from the cart as a
// cashier (the spec with a photo, the deposit, the sign-off signed on the
// screen), the Custom orders tab, the WhatsApp update, the balance, the
// hand-over with a signed delivery note into a tax invoice, and a quoted
// order cancelled with a manager's PIN.
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
await put('pos/retail/entities/BF', { legalName: 'Bellville Furniture (Pty) Ltd', tradingName: 'Bellville Furniture', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', creditNotePrefix: 'BF-CN', laybyPrefix: 'BF-LB', specialOrderPrefix: 'BF-SO', active: true, ...srv('BF') });
await put('pos/retail/settings/BF', { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, specialOrder: { minDepositPct: 50, leadDays: 21 }, ...srv('BF') });
await put('pos/retail/stores/BF-BELL', { entityId: 'BF', name: 'Bellville', active: true, paymentMethods: ['cash', 'card', 'eft'], ...srv('BF', 'BF-BELL') });
const secret = 'so-secret-' + Date.now();
await put('pos/retail/devices/dev_so', { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-21T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_so') });
const prod = (id, o) => put('pos/retail/products/' + id, { sku: '', barcodes: [], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 0, priceCents: 0, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...o, ...srv('BF') });
await prod('p_sofa', { name: 'Custom Sofa', type: 'mto', trackStock: false, barcodes: ['SOFA'], priceCents: 1500000, costCents: 600000 });
await prod('p_cushion', { name: 'Scatter Cushion', barcodes: ['CUSH'], priceCents: 19900, costCents: 5000 });
await put('pos/retail/customers/c_thandi', { name: 'Thandi Mokoena', contact: 'Thandi', phone: '0825550101', email: '', vatNo: '', address: { line1: '5 Lane', city: 'Parow' }, accountEnabled: false, creditLimitCents: 0, storeCreditCents: 0, accountBalanceCents: 0, notes: '', archived: false, ...srv('BF') });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); window.__printed = []; window.__opened = []; window.open = (u) => { if (u) { window.__opened.push(u); return { focus() {}, close() {} }; } const d = { write(h) { window.__printed.push(h); }, close() {} }; return { document: d, focus() {}, print() {}, close() {} }; }; }, { deviceId: 'dev_so', secret, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const pinType = async (scope, pin) => { for (const ch of pin) await p.locator(scope + ' [data-key="' + ch + '"]').click(); await p.waitForTimeout(900); };
const scan = async (code) => { await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await p.keyboard.type(code); await p.keyboard.press('Enter'); await p.waitForTimeout(350); };
const nav = async (v) => { await p.evaluate((v) => document.querySelector('#nav [data-view="' + v + '"]').click(), v); await p.waitForTimeout(600); };
const screenText = () => p.locator('#screen').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const modalText = () => p.locator('#modal').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const paper = () => p.locator('#modal .rc-paper').innerText().then(t => t.replace(/\s+/g, ' '));
const closeModal = async () => { if (await p.locator('#modal').count()) { await p.click('#modal-ok'); await p.waitForTimeout(300); } };
const pickThandi = async () => { await p.click('[data-act=sl-customer]'); await p.waitForSelector('#modal #cu-q'); await p.fill('#cu-q', '0825'); await p.waitForTimeout(250); await p.click('#cu-list .pk-row'); await p.waitForTimeout(300); };
const sign = async (sel) => { const box = await p.locator(sel).boundingBox(); await p.mouse.move(box.x + 20, box.y + 60); await p.mouse.down(); await p.mouse.move(box.x + 120, box.y + 40, { steps: 8 }); await p.mouse.move(box.x + 200, box.y + 90, { steps: 8 }); await p.mouse.up(); };
// a 2×2 PNG for the spec photo
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DwHwyZGBgYGBgYAEwWAwXLpQwTAAAAAElFTkSuQmCC', 'base64');

await p.goto(BASE, { waitUntil: 'load' });
await p.waitForSelector('#login-pin .pinpad'); await pinType('#login-pin', '111111'); await p.waitForSelector('#sl-q'); await p.waitForTimeout(1200);
R.nav = await p.$$eval('#nav [data-view]', x => x.map(y => y.dataset.view)); check('Custom orders tab present', R.nav.includes('orders'), R.nav);

// ---- a custom sofa for Thandi: the spec, a photo, the deposit, the sign-off
await scan('CUSH');
check('the button needs a made-to-order item', await p.locator('[data-act=sl-special]').isDisabled());
await p.click('[data-act=sl-void-line][data-i="0"]'); await p.waitForSelector('#modal #vd-reason'); await p.fill('#vd-reason', 'Wrong item'); await p.click('#modal-ok'); await p.waitForTimeout(400);
await scan('SOFA'); await pickThandi();
await p.click('[data-act=sl-special]'); await p.waitForSelector('#modal #so-pad');
R.newModal = await modalText();
check('the spec fields, the deposit at 50% and the sign-off text', (await p.inputValue('#so-model-0')) === 'Custom Sofa' && (await p.inputValue('#so-dep')) === '7500.00' && /no change of mind once production has started/.test(R.newModal) && /Deposit R 7,500\.00 \(50%\)/.test(R.newModal), R.newModal.slice(0, 500));
await p.fill('#so-size-0', '2.4 m'); await p.fill('#so-fabric-0', 'Linen look'); await p.fill('#so-colour-0', 'Charcoal'); await p.fill('#so-legs-0', 'Oak'); await p.fill('#so-notes-0', 'Firm seat');
await p.setInputFiles('input[data-photo="0"]', { name: 'sofa.png', mimeType: 'image/png', buffer: png }); await p.waitForTimeout(600);
check('the photo is shown', await p.locator('#so-ph-0').isVisible() && (await p.getAttribute('#so-ph-0', 'src')).startsWith('data:image/jpeg'));
R.terms = await p.locator('#so-terms').innerText(); check('the sign-off reads the spec back', /Size 2\.4 m, Fabric Linen look, Colour Charcoal, Legs Oak, Notes Firm seat \(photo attached\)/.test(R.terms), R.terms.slice(0, 400));
await p.check('#so-accept'); await sign('#so-pad');
check('cash is not offered: this till has no open register', !(await p.$$eval('#so-method option', os => os.map(o => o.value))).includes('cash') && /approval code and last 4 digits are on the card slip/i.test(R.newModal), R.newModal.slice(0, 200));
await p.click('#modal-ok'); R.noProof = await toast(); check('the deposit by card needs the slip\'s proof', /approval code and the last 4/.test(R.noProof), R.noProof);
await p.fill('#so-ref', '123456'); await p.fill('#so-last4', '4242');
await p.click('#modal-ok'); R.opened = await toast(); await p.waitForTimeout(1500);
check('order opened with the deposit', /Sales order BF-SO-000001 opened, deposit paid/.test(R.opened), R.opened);
await p.waitForSelector('#modal .rc-paper'); R.orderDoc = await paper();
check('the order prints: the spec, the payment plan, the signature', /SALES ORDER/.test(R.orderDoc) && /Custom Sofa/.test(R.orderDoc) && /Fabric: Linen look/.test(R.orderDoc) && /Colour: Charcoal/.test(R.orderDoc) && /Paid R 7,500\.00/.test(R.orderDoc) && /Balance before delivery R 7,500\.00/.test(R.orderDoc) && /Signed: Thandi Mokoena/.test(R.orderDoc) && /BF-SO-000001/.test(R.orderDoc), R.orderDoc.slice(0, 500));
check('the spec photo is on the order', (await p.locator('#modal .rc-paper .spec-img').count()) === 1);
await closeModal();
check('the cart is cleared', /No items yet/.test(await p.locator('.pos-right').innerText()));
const o1 = (await listColl('specialOrders'))[0];
check('written: deposit paid, update due, photo kept', o1 && o1.status === 'depositPaid' && o1.updateDue === true && o1.lines[0].spec.photo.startsWith('data:image/jpeg'), o1 && [o1.status, o1.updateDue]);

// ---- the tab, the update, the balance, the hand-over
await nav('orders');
R.tab = await screenText(); check('listed: deposit paid, update to send', /BF-SO-000001/.test(R.tab) && /1 × Custom Sofa/.test(R.tab) && /Deposit paid/i.test(R.tab) && /update to send/i.test(R.tab) && /1 update to send/.test(R.tab), R.tab.slice(0, 400));
await p.click('[data-act=so-open]'); await p.waitForSelector('#modal .lb-detail');
R.detail = await modalText(); check('the detail: spec, progress, money, no status buttons for a cashier', /Fabric: Linen look/.test(R.detail) && /Deposit paid/.test(R.detail) && /Take a payment/i.test(R.detail) && (await p.locator('[data-act=so-status]').count()) === 0, R.detail.slice(0, 400));
await p.click('[data-act=so-update]'); R.updToast = await toast(); await p.waitForTimeout(400);
R.opened1 = await p.evaluate(() => window.__opened); check('the WhatsApp update opened with the deposit words', /Update logged/.test(R.updToast) && R.opened1.length === 1 && /wa\.me\/27825550101/.test(R.opened1[0]) && /Thank%20you%20for%20your%20deposit/.test(R.opened1[0]), [R.updToast, R.opened1]);
await p.click('[data-act=so-pay]'); await p.waitForSelector('#modal #sp-amount');
check('the whole balance suggested', (await p.inputValue('#sp-amount')) === '7500.00');
await p.selectOption('#sp-method', 'card'); await p.fill('#sp-ref', '123456'); await p.click('#modal-ok'); R.noLast4 = await toast();
check('the card slip\'s last 4 digits are asked for', /approval code and the last 4/.test(R.noLast4), R.noLast4);
await p.fill('#sp-last4', '1234'); await p.click('#modal-ok'); R.paid = await toast(); await p.waitForTimeout(1500);
check('paid in full', /Paid R 7,500\.00 on BF-SO-000001/.test(R.paid) && /paid in full/.test(R.paid), R.paid);
await p.waitForSelector('#modal .rc-paper'); R.payslip = await paper(); check('the payment receipt', /SALES ORDER PAYMENT/.test(R.payslip) && /Paid now R 7,500\.00/.test(R.payslip) && /Balance R 0\.00/.test(R.payslip) && /Card ••1234 R 7,500\.00/.test(R.payslip), R.payslip);
await closeModal();
await p.click('[data-act=so-open]'); await p.waitForSelector('#modal .lb-detail');
R.notReady = await modalText(); check('paid but not made: still open, no hand-over until Ready', (await p.locator('[data-act=so-deliver]').count()) === 0 && /Open until it is made/.test(R.notReady), R.notReady.slice(0, 300));
await closeModal();
await fetch(`${docs}/pos/retail/specialOrders/${o1.id}?updateMask.fieldPaths=status`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { status: { stringValue: 'ready' } } }) });   // the couch is made
await p.waitForTimeout(800);
await p.click('[data-act=so-open]'); await p.waitForSelector('#modal [data-act=so-deliver]');
await p.click('[data-act=so-deliver]'); await p.waitForSelector('#modal #dn-pad');
await sign('#dn-pad'); await p.fill('#dn-note', 'Collected in good order'); await p.click('#modal-ok'); R.handed = await toast(); await p.waitForTimeout(1800);
check('handed over: tax invoice BF-000001', /Collected: tax invoice BF-000001/.test(R.handed), R.handed);
await p.waitForSelector('#modal .rc-paper'); R.inv = await paper();
check('the full tax invoice over R 5 000: customer address, VAT, paid by the special order', /TAX INVOICE/.test(R.inv) && /5 Lane, Parow/.test(R.inv) && /Custom Sofa/.test(R.inv) && /VAT 15% R 1,956\.52/.test(R.inv) && /Sales order R 15,000\.00/.test(R.inv), R.inv);
await p.click('#modal .rc-acts button:has-text("Delivery note")'); await p.waitForTimeout(500);
R.note = await paper(); check('the delivery note with the signature and the spec', /DELIVERY NOTE/.test(R.note) && /Collected at Bellville/.test(R.note) && /Fabric: Linen look/.test(R.note) && /Tax invoice BF-000001/.test(R.note) && /Signed: Thandi Mokoena/.test(R.note), R.note);
check('the signature image is on the note', (await p.locator('#modal .rc-paper .sig img').count()) === 1);
await closeModal();
R.tab2 = await screenText(); check('collected orders leave the open list', /No open sales orders/i.test(R.tab2), R.tab2.slice(0, 200));
const o1b = (await listColl('specialOrders')).find(o => o.docNo === 'BF-SO-000001');
check('written: collected, signed, invoice BF-000001', o1b.status === 'collected' && o1b.deliveryNote.signedBy === 'Thandi Mokoena' && o1b.deliveryNote.signature.startsWith('data:image/png') && o1b.completedDocNo === 'BF-000001', o1b && [o1b.status, o1b.completedDocNo]);

// ---- a quotation without a deposit, cancelled with Mandla's PIN
await nav('sell'); await scan('SOFA'); await pickThandi();
await p.click('[data-act=sl-special]'); await p.waitForSelector('#modal #so-pad');
await p.uncheck('#so-depnow'); await p.check('#so-accept'); await sign('#so-pad'); await p.click('#modal-ok'); R.quoted = await toast(); await p.waitForTimeout(1500);
check('quoted without a deposit', /Sales order BF-SO-000002 quoted/.test(R.quoted), R.quoted);
R.quoteDoc = await paper(); check('printed as a quotation', /QUOTATION/.test(R.quoteDoc) && /Deposit to start R 7,500\.00/.test(R.quoteDoc), R.quoteDoc.slice(0, 300));
await closeModal();
await nav('orders'); await p.selectOption('#so-filter', 'quoted'); await p.waitForTimeout(300);
await p.click('[data-act=so-open]'); await p.waitForSelector('#modal .lb-detail');
// ---- the deposit by EFT: recorded as awaiting the bank, a manager confirms it on the order
await p.click('[data-act=so-pay]'); await p.waitForSelector('#modal #sp-amount');
await p.selectOption('#sp-method', 'eft'); await p.fill('#sp-ref', 'MOKOENA'); await p.click('#modal-ok'); R.eftToast = await toast(); await p.waitForTimeout(1500);
check('an EFT is recorded as awaiting the bank', /Recorded R 7,500\.00 by EFT on BF-SO-000002: awaiting the bank/.test(R.eftToast), R.eftToast);
await p.waitForSelector('#modal .rc-paper'); R.eftSlip = await paper(); check('the slip says the payment is awaited', /Payment awaited: not yet paid/.test(R.eftSlip) && /Recorded, awaiting the bank R 7,500\.00/.test(R.eftSlip) && /Balance R 15,000\.00/.test(R.eftSlip), R.eftSlip);
await closeModal();
await nav('todo'); R.todoBank = await screenText(); check('To do: the bank payment to confirm', /Bank payments to confirm/.test(R.todoBank) && /BF-SO-000002/.test(R.todoBank) && /R 7,500\.00 awaiting/.test(R.todoBank), R.todoBank.slice(0, 300));
await nav('orders'); await p.selectOption('#so-filter', 'quoted'); await p.waitForTimeout(300);
await p.click('[data-act=so-open]'); await p.waitForSelector('#modal .lb-detail'); R.eftDetail = await modalText();
check('the order: still quoted, the EFT awaiting the bank, the confirm button', /Quoted/.test(R.eftDetail) && /EFT MOKOENA · awaiting the bank/.test(R.eftDetail) && /Awaiting the bank \(a manager confirms\) R 7,500\.00/.test(R.eftDetail) && (await p.locator('[data-act=so-pay-confirm]').count()) === 1, R.eftDetail.slice(0, 500));
// ---- the details put right: the phone and the expected date (anyone); the colour, a signed-off spec, with a supervisor's PIN (the manager's here)
await p.click('[data-act=so-edit]'); await p.waitForSelector('#modal #ed-phone');
R.editModal = await modalText(); check('the edit window: what can and cannot change', /The items, the price and the money stay as signed off/.test(R.editModal) && /model, size and fabric set the price and cannot/.test(R.editModal) && (await p.locator('#ed-colour-0').count()) === 1, R.editModal.slice(0, 300));
await p.fill('#ed-phone', '0829990000'); await p.fill('#ed-expected', '2026-12-15'); await p.fill('#ed-colour-0', 'Navy'); await p.fill('#ed-reason', 'Client changed the colour and gave a new number'); await p.click('#modal-ok');
await p.waitForSelector('#modal .pinpad'); await pinType('#modal', '222222'); R.edited = await toast(); await p.waitForTimeout(1200);
check('saved with the PIN', /BF-SO-000002 updated/.test(R.edited), R.edited);
await p.waitForSelector('#modal .lb-detail'); R.editDetail = await modalText();
check('the order shows the new phone, date and colour, and says what changed', /0829990000/.test(R.editDetail) && /15 Dec 2026/.test(R.editDetail) && /Colour: Navy/.test(R.editDetail) && /Details changed 1 time/.test(R.editDetail) && /Custom Sofa: colour: .* → Navy/.test(R.editDetail) && /R 15,000\.00/.test(R.editDetail), R.editDetail.slice(0, 700));
await p.click('[data-act=so-print-order]'); await p.waitForSelector('#modal .rc-paper'); R.editDoc = await paper();
check('the printed order: the amendment under the signed terms, the price as before', /Changed after sign-off/.test(R.editDoc) && /Mandla/.test(R.editDoc) && /Navy/.test(R.editDoc) && /Deposit to start R 7,500\.00/.test(R.editDoc), R.editDoc.slice(0, 400));
await closeModal();
const o2e = (await listColl('specialOrders')).find(o => o.docNo === 'BF-SO-000002');
check('written: the spec changed, the sign-off text as signed with the amendment, the money untouched', o2e.lines[0].spec.colour === 'Navy' && o2e.customerSnapshot.phone === '0829990000' && o2e.expectedAt === '2026-12-15' && o2e.signoff.amendments.length === 1 && o2e.signoff.amendments[0].byName === 'Mandla' && /I have checked the specification/.test(o2e.signoff.text) && o2e.totalCents === 1500000 && o2e.awaitingCents === 750000 && o2e.edits.length === 1 && o2e.edits[0].changes.length === 3, o2e && [o2e.lines[0].spec, o2e.edits]);
await nav('orders'); await p.selectOption('#so-filter', 'quoted'); await p.waitForTimeout(300);
await p.click('[data-act=so-open]'); await p.waitForSelector('#modal .lb-detail');
await p.click('[data-act=so-cancel]'); await p.waitForSelector('#modal #sc-kind');
R.cancelModal = await modalText(); check('no fee before production', /Production has not started: no fee/.test(R.cancelModal) && /To refund R 0\.00/.test(R.cancelModal), R.cancelModal.slice(0, 300));
await p.click('#modal-ok'); await p.waitForSelector('#modal .pinpad'); await pinType('#modal', '222222'); R.cancelled = await toast(); await p.waitForTimeout(1500);
check('cancelled with the manager’s PIN', /BF-SO-000002 cancelled · refund R 0\.00/.test(R.cancelled), R.cancelled);
R.cancelDoc = await paper(); check('the cancellation statement', /SALES ORDER CANCELLATION/.test(R.cancelDoc) && /Cancellation fee R 0\.00/.test(R.cancelDoc) && /section 20\(2\)\(b\)/.test(R.cancelDoc), R.cancelDoc);
await closeModal();
const o2 = (await listColl('specialOrders')).find(o => o.docNo === 'BF-SO-000002');
check('written: cancelled, approver Mandla', o2.status === 'cancelled' && o2.approvers.some(a => a.name === 'Mandla'), o2 && [o2.status, o2.approvers]);
check('the awaiting EFT closed as not received with the order', o2.awaitingCents === 0 && o2.history.length === 1 && o2.history[0].status === 'void' && (await listColl('payments')).find(x => x.docNo === 'BF-SO-000002').status === 'void', o2.history);

// ---- an invoice is final: only who it is made out to can be put right, by a manager (the PIN), and the invoice says so
await nav('sales'); await p.waitForTimeout(600);
await p.click('[data-act=sa-open][data-id]'); await p.waitForSelector('#modal .rc-paper'); await p.waitForTimeout(300);
R.invBefore = await paper();
await p.click('#modal [data-rc=fix]'); await p.waitForSelector('#modal #fx-name');
await p.fill('#fx-name', 'Thandi Mokoena-Smith'); await p.fill('#fx-vat', '4111222333'); await p.fill('#fx-reason', 'Married name and the VAT number'); await p.click('#modal-ok');
await p.waitForSelector('#modal .pinpad'); await pinType('#modal', '222222'); R.fixed = await toast(); await p.waitForTimeout(1200);
await p.waitForSelector('#modal .rc-paper'); R.invAfter = await paper();
check('the invoice: the name and VAT number corrected, marked as corrected, the same number and total', /details corrected/.test(R.fixed) && /Thandi Mokoena-Smith/.test(R.invAfter) && /VAT no 4111222333/.test(R.invAfter) && /Details corrected/.test(R.invAfter) && /TAX INVOICE · COPY/.test(R.invAfter) && /Thandi Mokoena/.test(R.invBefore) && !/Details corrected/.test(R.invBefore) && R.invAfter.match(/TOTAL R [\d,.]+/)[0] === R.invBefore.match(/TOTAL R [\d,.]+/)[0], [R.fixed, R.invAfter.slice(0, 400)]);
await closeModal();
const inv = (await listColl('sales'))[0];
check('written: the details on the sale, the earlier ones kept, audited with the manager as approver', inv.customerSnapshot.name === 'Thandi Mokoena-Smith' && inv.detailsFixes.length === 1 && inv.detailsFixes[0].before.name === 'Thandi Mokoena' && inv.detailsFixes[0].byName === 'Mandla' && (await listColl('auditLog')).some(a => a.action === 'sale.fixDetails' && a.overrideName === 'Mandla'), inv && [inv.customerSnapshot, inv.detailsFixes]);

console.log(JSON.stringify({ fails, errs, ...R }, null, 1).slice(0, 6000));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
