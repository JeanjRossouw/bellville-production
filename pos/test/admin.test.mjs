// Retail POS step 3: companies, stores, registers and settings, from an
// empty group, as the owner and then as a manager. Emulators + server.mjs.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = REPO + '/pos/test', FBDIR = process.env.FIREBASE_SDK_DIR || '';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099';
const BASE = 'http://localhost:8788/pos/?emulator=1';
const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const crash = (e) => { console.log(JSON.stringify({ ...R, fails, errs, crash: String(e && e.message || e).slice(0, 300) }, null, 1)); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const fromFs = (f) => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? parseInt(f.integerValue, 10) : 'booleanValue' in f ? f.booleanValue : 'nullValue' in f ? null : 'arrayValue' in f ? (f.arrayValue.values || []).map(fromFs) : 'mapValue' in f ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)])) : f.doubleValue;
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const getDoc = async (p) => { const r = await (await fetch(`${docs}/${p}`, { headers: H })).json(); return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, fromFs(x)])) : null; };
const listColl = async (coll) => { const r = await (await fetch(`${docs}/pos/retail/${coll}?pageSize=300`, { headers: H })).json(); return (r.documents || []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromFs(x)])) })); };
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.co.za', password: 'secret123' }) });

let server = null;
if (!(await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false))) {
  server = spawn('node', [S + '/server.mjs', REPO], { stdio: 'inherit' });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (await fetch('http://localhost:8788/pos/').then(r => r.ok).catch(() => false)) break; }
}
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
const p = await ctx.newPage();
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|favicon|emulator|WebChannel|transport errored|Failed to load resource/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('dialog', d => d.accept());
const toast = async () => { await p.waitForTimeout(500); return (await p.locator('#toast').innerText().catch(() => '')).trim(); };
const sub = async (s) => { await p.click('#nav [data-view=admin]'); await p.waitForTimeout(250); await p.click('[data-sub=' + s + ']'); await p.waitForTimeout(500); };
const signIn = async (email, pass) => { await p.waitForSelector('#login:not([hidden])'); const sw = p.locator('#login-switch [data-mode=email]'); if (await sw.isVisible()) await sw.click(); await p.fill('#login-email', email); await p.fill('#login-pass', pass); await p.click('#login-submit'); };

// owner claims the group
await p.goto(BASE, { waitUntil: 'load' });
await signIn('owner@shop.co.za', 'secret123');
await p.waitForSelector('#claim:not([hidden])', { timeout: 15000 });
await p.fill('#claim-name', 'Jean'); await p.click('#claim-form button[type=submit]');
await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(600);

// ---- companies
await sub('companies');
R.subs = await p.$$eval('.subnav [data-sub]', x => x.map(y => y.dataset.sub)); check('admin sub-tabs', R.subs.join() === 'companies,stores,registers,settings,staff,devices', R.subs);
await p.fill('#en-code', 'bf'); await p.fill('#en-trading', 'Bellville Furniture'); await p.fill('#en-legal', 'Bellville Furniture (Pty) Ltd'); await p.fill('#en-reg', '2010/123456/07');
await p.check('#en-vatreg'); await p.fill('#en-vatno', '412');
await p.click('[data-act=entity-save]'); R.badVat = await toast(); check('a VAT number is 10 digits', /10 digits/.test(R.badVat), R.badVat);
await p.fill('#en-vatno', '4123456789'); await p.fill('#en-line1', '12 Voortrekker Rd'); await p.fill('#en-city', 'Bellville'); await p.fill('#en-phone', '021 000 0000'); await p.fill('#en-bank', 'FNB'); await p.fill('#en-bankno', '62000000000');
await p.click('[data-act=entity-save]'); R.addBF = await toast(); check('BF added', /Bellville Furniture added/.test(R.addBF), R.addBF);
await p.waitForTimeout(600);
const bf = await getDoc('pos/retail/entities/BF');
check('BF stored upper-cased with prefixes and stamps', bf && bf.vatRegistered === true && bf.invoicePrefix === 'BF' && bf.creditNotePrefix === 'BF-CN' && bf.grvPrefix === 'BF-GRV' && bf.entityId === 'BF' && bf.storeId === '' && bf.createdBy && bf.deviceId === 'web', bf);
const bfSettings = await getDoc('pos/retail/settings/BF');
check('settings seeded with defaults', bfSettings && bfSettings.vat.rates[0].rateBp === 1500 && bfSettings.discounts.maxPctByRole.cashier === 5 && bfSettings.cash.varianceLimitCents === 5000 && bfSettings.session.pinLength === 6, bfSettings);
// a second company, not VAT registered
await p.fill('#en-code', 'PF'); await p.fill('#en-trading', 'PinkFoot Boutique'); await p.fill('#en-legal', 'PinkFoot Boutique CC');
await p.click('[data-act=entity-save]'); R.addPF = await toast(); check('PF added', /PinkFoot Boutique added/.test(R.addPF), R.addPF);
await p.waitForTimeout(600);
await p.fill('#en-code', 'BF'); await p.fill('#en-legal', 'x'); await p.click('[data-act=entity-save]'); R.dupCode = await toast(); check('a taken code is refused', /taken/.test(R.dupCode), R.dupCode);
await p.waitForTimeout(500);
R.cards = await p.$$eval('#screen .grid.cards .card h2', x => x.map(y => y.innerText.replace(/\s+/g, ' ').trim())); check('two company cards', R.cards.length === 2 && /Bellville Furniture BF/i.test(R.cards.join('|')) && /PinkFoot Boutique PF/i.test(R.cards.join('|')), R.cards);
// edit BF: the code is locked, the name changes
await p.click('[data-act=entity-edit][data-id=BF]'); await p.waitForTimeout(300);
R.enCodes = await p.$$eval('#en-code', els => els.map(e => (e.disabled ? 'disabled:' : 'live:') + e.value + ' in ' + (e.closest('#en-form') ? 'en-form' : e.closest('#screen') ? 'screen' : e.parentElement.outerHTML.slice(0, 60))));
R.formCount = await p.locator('#en-form').count();
check('one code box, locked, on edit', R.enCodes.length === 1 && R.enCodes[0].startsWith('disabled:'), R.enCodes);
await p.fill('#en-trading', 'Bellville Furniture Store'); await p.click('[data-act=entity-save]'); R.editBF = await toast(); check('BF edited', /saved/.test(R.editBF), R.editBF);
await p.waitForTimeout(500); await p.screenshot({ path: S + '/shots/pos3-companies.png' });

// ---- stores
await sub('stores');
await p.fill('#st-code', 'bf-bell'); await p.selectOption('#st-entity', 'BF'); await p.fill('#st-name', 'Bellville'); await p.fill('#st-line1', 'Shop 4, Bellville Mall'); await p.fill('#st-city', 'Bellville');
await p.check('[data-pm=eft]'); await p.check('[data-pm=qr]'); await p.uncheck('[data-pm=card]');
await p.click('[data-act=store-save]'); R.addStore = await toast(); check('store added', /Bellville added/.test(R.addStore), R.addStore);
await p.waitForTimeout(600);
const st = await getDoc('pos/retail/stores/BF-BELL');
check('store stored with its methods and stamps', st && st.entityId === 'BF' && st.storeId === 'BF-BELL' && st.paymentMethods.join() === 'cash,eft,qr' && st.active === true, st);
await p.fill('#st-code', 'PF-MAIN'); await p.selectOption('#st-entity', 'PF'); await p.fill('#st-name', 'PinkFoot'); await p.click('[data-act=store-save]'); await toast(); await p.waitForTimeout(500);
R.storeRows = await p.$$eval('#screen .tbl tbody tr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim())); check('two stores listed with their companies', R.storeRows.length === 2 && /Bellville BF-BELL Bellville Furniture Store Cash, EFT, QR/i.test(R.storeRows.join('|')), R.storeRows);

// ---- registers
await sub('registers');
await p.selectOption('#rg-store', 'BF-BELL'); await p.fill('#rg-name', 'Till 1'); await p.click('[data-act=register-save]'); R.addReg = await toast(); check('register added', /Till 1 added/.test(R.addReg), R.addReg);
await p.waitForTimeout(600);
const regs = await listColl('registers'); check('register stored closed, stamped', regs.length === 1 && regs[0].storeId === 'BF-BELL' && regs[0].entityId === 'BF' && regs[0].currentShiftId === '', regs);

// ---- settings
await sub('settings');
await p.selectOption('#se-entity', 'BF'); await p.waitForTimeout(300);
R.vatNote = await p.locator('#screen .card').first().innerText(); check('VAT card says registered', /VAT registered \(4123456789\)/.test(R.vatNote), R.vatNote);
await p.fill('#se-disc-cashier', '10'); await p.fill('#se-variance', '100'); await p.fill('#se-idle', '5'); await p.selectOption('#se-pinlen', '4'); await p.fill('#se-lb-dep', '25'); await p.fill('#se-rhead', 'Shop 4, Bellville Mall');
await p.click('[data-act=rate-add]'); await p.waitForTimeout(100);
const rows = p.locator('#se-rates tbody tr'); check('a second rate row', await rows.count() === 2);
await rows.nth(1).locator('[data-rate]').fill('16'); await rows.nth(1).locator('[data-from]').fill('2027-04-01');
await p.click('[data-act=settings-save]'); R.saveSet = await toast(); check('settings saved', /Settings saved/.test(R.saveSet), R.saveSet);
await p.waitForTimeout(600);
const s2 = await getDoc('pos/retail/settings/BF');
check('settings stored: cents, rates sorted, pin length', s2.discounts.maxPctByRole.cashier === 10 && s2.cash.varianceLimitCents === 10000 && s2.session.idleLogoutMinutes === 5 && s2.session.pinLength === 4 && s2.layby.minDepositPct === 25 && s2.vat.rates.length === 2 && s2.vat.rates[1].rateBp === 1600 && s2.vat.rates[1].effectiveFrom === '2027-04-01' && s2.receipt.header === 'Shop 4, Bellville Mall' && s2.updatedBy, s2);
await p.selectOption('#se-entity', 'PF'); await p.waitForTimeout(300);
R.pfNote = await p.locator('#screen .card').first().innerText(); check('PF: not VAT registered', /Not VAT registered/.test(R.pfNote), R.pfNote);
await p.screenshot({ path: S + '/shots/pos3-settings.png' });
// survives a reload
await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(800);
await sub('settings'); await p.selectOption('#se-entity', 'BF'); await p.waitForTimeout(400);
check('after reload the saved values show', (await p.inputValue('#se-disc-cashier')) === '10' && (await p.inputValue('#se-variance')) === '100.00' && (await p.inputValue('#se-pinlen')) === '4');
const audit = await listColl('auditLog');
R.auditActions = audit.map(a => a.action).sort();
check('audit rows for each save', ['entity.create', 'entity.create', 'entity.save', 'store.create', 'store.create', 'register.create', 'settings.save', 'group.bootstrap'].every(a => R.auditActions.includes(a)), R.auditActions);
const settingsRow = audit.find(a => a.action === 'settings.save'); check('settings audit says what changed', settingsRow && settingsRow.details.changed.includes('discounts') && settingsRow.details.changed.includes('cash') && settingsRow.actorUid, settingsRow && settingsRow.details);

// ---- a manager: adds a register and saves settings, but cannot add companies or stores
await sub('staff');
await p.fill('#st-name', 'Mandla'); await p.selectOption('#st-role', 'manager'); await p.fill('#st-email', 'mgr@shop.co.za'); await p.check('[data-ent="BF"]'); await p.check('[data-store="BF-BELL"]'); await p.click('[data-act=staff-add]'); await toast();
const mgrAuth = await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/projects/${PID}/accounts:lookup`, { method: 'POST', headers: H, body: JSON.stringify({ email: ['mgr@shop.co.za'] }) })).json();
await fetch(`${AU}/identitytoolkit.googleapis.com/v1/projects/${PID}/accounts:update`, { method: 'POST', headers: H, body: JSON.stringify({ localId: mgrAuth.users[0].localId, password: 'mgrpass1' }) });
await p.click('#sign-out'); await signIn('mgr@shop.co.za', 'mgrpass1');
await p.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await p.waitForTimeout(800);
await sub('companies'); check('manager sees no company form', (await p.locator('#en-form').count()) === 0);
R.mgrCards = await p.$$eval('#screen .grid.cards .card h2', x => x.map(y => y.innerText.trim())); check('manager sees only BF', R.mgrCards.length === 1 && /Bellville/i.test(R.mgrCards[0]), R.mgrCards);
await sub('stores'); check('manager sees no store form', (await p.locator('#st-code').count()) === 0);
await sub('registers'); await p.fill('#rg-name', 'Till 2'); await p.click('[data-act=register-save]'); R.mgrReg = await toast(); check('manager adds a register', /Till 2 added/.test(R.mgrReg), R.mgrReg);
await sub('settings'); R.mgrEnts = await p.$$eval('#se-entity option', o => o.map(x => x.value)); check('manager settings: BF only', R.mgrEnts.join() === 'BF', R.mgrEnts);
await p.fill('#se-idle', '7'); await p.click('[data-act=settings-save]'); R.mgrSet = await toast(); check('manager saves settings', /Settings saved/.test(R.mgrSet), R.mgrSet);
await p.waitForTimeout(500); check('idle stored by the manager', (await getDoc('pos/retail/settings/BF')).session.idleLogoutMinutes === 7);

console.log(JSON.stringify({ ...R, fails, errs }, null, 1));
await b.close();
if (server) server.kill();
process.exit(fails.length || errs.length ? 1 : 0);
