// Factory Manager POS in the browser, two businesses: the owner of a business
// that signed up signs in by email and sees only that business (its company,
// not the first shops'); a till enrolled for that business signs in by PIN and
// sells that business's products; the first shops' owner still sees theirs.
import { chromium } from 'playwright';
import { createHash, pbkdf2Sync } from 'node:crypto';
const PID = 'factory-manager-ece82', FS = 'http://127.0.0.1:8085', AU = 'http://127.0.0.1:9099', BASE = 'http://localhost:8788/pos/?emulator=1';
const FBDIR = process.env.FIREBASE_SDK_DIR || '';
const toFs = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
const docs = `${FS}/v1/projects/${PID}/databases/(default)/documents`;
const H = { Authorization: 'Bearer owner', 'content-type': 'application/json' };
const put = (p, data) => fetch(`${docs}/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
const srv = (e, s = '') => ({ entityId: e, storeId: s, createdBy: 'server', createdAt: '2026-10-21T08:00:00.000Z', deviceId: 'server' });
await fetch(`${FS}/emulator/v1/projects/${PID}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AU}/emulator/v1/projects/${PID}/accounts`, { method: 'DELETE' });
const pinRec = (pin) => { const salt = '56'.repeat(16); return { hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'), salt, iterations: 100000, algo: 'pbkdf2-sha256', failedCount: 0, lockedUntil: '' }; };
const mk = async (email) => (await (await fetch(`${AU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json());
const G2 = 'gTwoShop';
const seed = async (g, names) => {
  await put(`pos/${g}/entities/BF`, { legalName: names.legal, tradingName: names.trading, vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', active: true, ...srv('BF') });
  await put(`pos/${g}/settings/BF`, { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } }, session: { idleLogoutMinutes: 10, pinLength: 6 }, ...srv('BF') });
  await put(`pos/${g}/stores/BF-BELL`, { entityId: 'BF', name: names.store, active: true, paymentMethods: ['cash', 'card'], ...srv('BF', 'BF-BELL') });
  await put(`pos/${g}/products/p_lamp`, { name: names.product, sku: 'LA-1', barcodes: ['LAMP'], category: 'Shop', brand: '', type: 'stock', vatClass: 'standard', trackStock: true, costCents: 20000, priceCents: 50000, images: [], options: [], hasVariants: false, storePrices: {}, bundle: [], archived: false, favourite: true, ...srv('BF') });
  await put(`pos/${g}/stockLevels/BF-BELL_p_lamp`, { productId: 'p_lamp', variantId: '', onHandQty: 5, reservedQty: 0, onOrderQty: 0, ...srv('BF', 'BF-BELL') });
};
await seed('retail', { legal: 'Bellville Furniture (Pty) Ltd', trading: 'Bellville Furniture', store: 'Bellville', product: 'Brass Lamp' });
const own = await mk('owner@shop.co.za');
await put('pos/retail/users/' + own.localId, { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await seed(G2, { legal: 'Other Shop (Pty) Ltd', trading: 'Other Shop', store: 'High Street', product: 'Desk Lamp' });
const own2 = await mk('owner@othershop.co.za');
await put('posGroups/' + G2, { name: 'Other Shop', ownerUid: own2.localId, status: 'trial', createdAt: '2026-10-23T08:00:00.000Z' });
await put('posMembers/' + own2.localId, { groupId: G2, at: '2026-10-23T08:00:00.000Z' });
await put(`pos/${G2}/users/` + own2.localId, { email: 'owner@othershop.co.za', name: 'Nomsa', role: 'owner', active: true, entityIds: [], storeIds: [], defaultStoreId: '', pinSet: false, ...srv('*') });
await put('posMembers/st_sipho', { groupId: G2, at: '2026-10-23T08:00:00.000Z' });
await put(`pos/${G2}/users/st_sipho`, { email: '', name: 'Sipho', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], defaultStoreId: 'BF-BELL', pinSet: true, ...srv('BF') });
await put(`pos/${G2}/pinHashes/st_sipho`, { ...pinRec('333333'), ...srv('BF') });
const secret = 'g2-browser-' + Date.now();
await put(`pos/${G2}/devices/dev_b`, { label: 'Front till', registerId: '', secretHash: createHash('sha256').update(secret).digest('hex'), enrolledBy: 'server', enrolledAt: '2026-10-23T08:00:00.000Z', active: true, ...srv('BF', 'BF-BELL', 'dev_b') });

const R = {}, fails = [], errs = [];
const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); };
const b = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox'] });
async function page(device) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  if (FBDIR) await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[\w-]+\.js)/, r => r.fulfill({ path: FBDIR + '/' + r.request().url().split('/').pop(), contentType: 'text/javascript' }));
  if (device) await ctx.addInitScript((dev) => { if (!localStorage.getItem('pos-device')) localStorage.setItem('pos-device', JSON.stringify(dev)); }, device);
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('dialog', d => d.accept());
  await p.goto(BASE, { waitUntil: 'load' });
  return p;
}
const emailIn = async (p, email) => {
  await p.waitForSelector('#login:not([hidden])');
  const sw = p.locator('#login-switch [data-mode=email]'); if (await sw.isVisible()) await sw.click();
  await p.fill('#login-email', email); await p.fill('#login-pass', 'secret123'); await p.click('#login-submit');
  await p.waitForSelector('#nav [data-view=admin]', { state: 'attached', timeout: 20000 }); await p.waitForTimeout(1200);
};
const companies = async (p) => { await p.click('#nav [data-view=admin]', { force: true }).catch(() => {}); await p.waitForTimeout(300); await p.click('[data-sub=companies]').catch(() => {}); await p.waitForTimeout(1200); return (await p.locator('#screen').innerText()).replace(/\s+/g, ' '); };

// ---- the second business's owner, by email
const p2 = await page(null);
await emailIn(p2, 'owner@othershop.co.za');
R.co2 = await companies(p2);
check('the new business\'s owner sees only her company', /Other Shop/.test(R.co2) && !/Bellville Furniture/.test(R.co2), R.co2.slice(0, 300));
// ---- the first shops' owner, by email, in another browser
const p1 = await page(null);
await emailIn(p1, 'owner@shop.co.za');
R.co1 = await companies(p1);
check('the first shops\' owner still sees theirs only', /Bellville Furniture/.test(R.co1) && !/Other Shop/.test(R.co1), R.co1.slice(0, 300));
// ---- a till enrolled for the second business, by PIN
const pt = await page({ deviceId: 'dev_b', secret, groupId: G2, entityId: 'BF', storeId: 'BF-BELL', registerId: '', label: 'Front till' });
await pt.waitForSelector('#login-pin .pinpad', { timeout: 20000 });
for (const ch of '333333') await pt.locator('#login-pin [data-key="' + ch + '"]').click();
await pt.waitForSelector('#sl-q', { timeout: 20000 }); await pt.waitForTimeout(1500);
R.till = (await pt.locator('#screen').innerText()).replace(/\s+/g, ' ');
check('the till signs Sipho in and shows his business\'s products only', /Desk Lamp/.test(R.till) && !/Brass Lamp/.test(R.till), R.till.slice(0, 300));
console.log(JSON.stringify({ fails, errs, co2: R.co2.slice(0, 160), co1: R.co1.slice(0, 160), till: R.till.slice(0, 160) }, null, 1));
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
