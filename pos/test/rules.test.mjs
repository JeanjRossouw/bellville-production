// Retail POS rules: roles, entity and store reach, the server-only
// collections, stamps and whole cents.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, updateDoc, deleteDoc, query, where } from 'firebase/firestore';
import fs from 'node:fs';
const env = await initializeTestEnvironment({ projectId: 'pos-rules', firestore: { rules: fs.readFileSync(new URL('../../couchpotato/firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 } });
await env.clearFirestore();
const G = 'grp';
const P = (db, coll, id) => doc(db, 'pos', G, coll, id);
const as = (uid) => env.authenticatedContext(uid, { email: uid + '@shop.co.za' }).firestore();
const owner = as('owner'), mgr = as('mgr'), sup = as('sup'), cash = as('cash'), cash2 = as('cash2'), off = as('off'), stranger = as('stranger');
const results = []; let failed = 0;
async function t(name, p, expectOk) { try { await (expectOk ? assertSucceeds(p) : assertFails(p)); results.push('✓ ' + name); } catch (e) { failed++; results.push('✗ ' + name + ' — ' + e.message.slice(0, 200)); } }
const stamp = (by, entityId, storeId = '', deviceId = 'web') => ({ entityId, storeId, createdBy: by, createdAt: '2026-10-21T10:00:00.000Z', deviceId });
// the server seeds the group: entities BF and RC, stores, people
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const srv = (e, s = '') => stamp('server', e, s, 'server');
  await setDoc(P(db, 'users', 'owner'), { email: 'owner@shop.co.za', name: 'Jean', role: 'owner', active: true, entityIds: [], storeIds: [], ...srv('BF') });
  await setDoc(P(db, 'users', 'mgr'), { email: 'mgr@shop.co.za', name: 'Mandla', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL', 'BF-PAROW'], ...srv('BF') });
  await setDoc(P(db, 'users', 'sup'), { email: 'sup@shop.co.za', name: 'Sarah', role: 'supervisor', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], ...srv('BF') });
  await setDoc(P(db, 'users', 'cash'), { email: 'cash@shop.co.za', name: 'Cathy', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], ...srv('BF') });
  await setDoc(P(db, 'users', 'cash2'), { email: 'cash2@shop.co.za', name: 'Carl', role: 'cashier', active: true, entityIds: ['RC'], storeIds: ['RC-MAIN'], ...srv('RC') });
  await setDoc(P(db, 'users', 'off'), { email: 'off@shop.co.za', name: 'Gone', role: 'manager', active: false, entityIds: ['BF'], storeIds: ['BF-BELL'], ...srv('BF') });
  await setDoc(P(db, 'entities', 'BF'), { legalName: 'Bellville Furniture (Pty) Ltd', vatRegistered: true, vatNo: '4123456789', invoicePrefix: 'BF', ...srv('BF') });
  await setDoc(P(db, 'entities', 'RC'), { legalName: 'ReptiCube', vatRegistered: false, vatNo: '', invoicePrefix: 'RC', ...srv('RC') });
  await setDoc(P(db, 'stores', 'BF-BELL'), { entityId: 'BF', name: 'Bellville', ...srv('BF', 'BF-BELL') });
  await setDoc(P(db, 'stores', 'BF-PAROW'), { entityId: 'BF', name: 'Parow', ...srv('BF', 'BF-PAROW') });
  await setDoc(P(db, 'stores', 'RC-MAIN'), { entityId: 'RC', name: 'ReptiCube', ...srv('RC', 'RC-MAIN') });
  await setDoc(P(db, 'sales', 's1'), { docNo: 'BF-000001', totalCents: 640000, ...srv('BF', 'BF-BELL') });
  await setDoc(P(db, 'sales', 's2'), { docNo: 'BF-000002', totalCents: 10000, ...srv('BF', 'BF-PAROW') });
  await setDoc(P(db, 'sales', 's3'), { docNo: 'RC-000001', totalCents: 9900, ...srv('RC', 'RC-MAIN') });
  await setDoc(P(db, 'stockLevels', 'BF-BELL_p1'), { productId: 'p1', onHandQty: 3, ...srv('BF', 'BF-BELL') });
  await setDoc(P(db, 'customers', 'c1'), { name: 'Thandi', storeCreditCents: 5000, accountEnabled: false, creditLimitCents: 0, ...srv('BF') });
  await setDoc(P(db, 'products', 'p0'), { name: 'Old', priceCents: 100, costCents: 50, ...srv('BF') });
  await setDoc(P(db, 'purchaseOrders', 'po1'), { status: 'draft', docNo: '', supplierId: 'x', lines: [], ...srv('BF', 'BF-BELL') });
  await setDoc(P(db, 'purchaseOrders', 'po2'), { status: 'sent', docNo: 'BF-PO-000001', seq: 1, supplierId: 'x', lines: [], ...srv('BF', 'BF-BELL') });
  await setDoc(P(db, 'counters', 'BF_INV'), { next: 3, ...srv('BF') });
  await setDoc(P(db, 'pinHashes', 'cash'), { hash: 'x', ...srv('BF') });
});

// ---- who is in
await t('a stranger reads nothing', getDoc(P(stranger, 'entities', 'BF')), false);
await t('a deactivated manager reads nothing', getDoc(P(off, 'entities', 'BF')), false);
await t('cashier reads own entity', getDoc(P(cash, 'entities', 'BF')), true);
await t('cashier CANNOT read the other entity', getDoc(P(cash, 'entities', 'RC')), false);
await t('owner reads every entity', getDoc(P(owner, 'entities', 'RC')), true);
await t('cashier reads own user record', getDoc(P(cash, 'users', 'cash')), true);
await t('cashier CANNOT read another user record', getDoc(P(cash, 'users', 'mgr')), false);
await t('manager reads user records', getDoc(P(mgr, 'users', 'cash')), true);

// ---- store reach on reads (point reads and list queries)
await t('cashier reads a sale in her store', getDoc(P(cash, 'sales', 's1')), true);
await t('cashier CANNOT read a sale in the other store', getDoc(P(cash, 'sales', 's2')), false);
await t('cashier lists sales of her store', getDocs(query(collection(cash, 'pos', G, 'sales'), where('entityId', '==', 'BF'), where('storeId', '==', 'BF-BELL'))), true);
await t('cashier CANNOT list sales of the other store', getDocs(query(collection(cash, 'pos', G, 'sales'), where('entityId', '==', 'BF'), where('storeId', '==', 'BF-PAROW'))), false);
await t('cashier CANNOT list sales without a store filter', getDocs(query(collection(cash, 'pos', G, 'sales'), where('entityId', '==', 'BF'))), false);
await t('manager lists both stores (in)', getDocs(query(collection(mgr, 'pos', G, 'sales'), where('entityId', '==', 'BF'), where('storeId', 'in', ['BF-BELL', 'BF-PAROW']))), true);
await t('manager CANNOT list the other entity', getDocs(query(collection(mgr, 'pos', G, 'sales'), where('entityId', '==', 'RC'), where('storeId', '==', 'RC-MAIN'))), false);
await t('owner lists any store', getDocs(query(collection(owner, 'pos', G, 'sales'), where('entityId', '==', 'RC'), where('storeId', '==', 'RC-MAIN'))), true);
await t('cashier lists products of her entity', getDocs(query(collection(cash, 'pos', G, 'products'), where('entityId', '==', 'BF'))), true);
await t('cashier reads stock in her store', getDoc(P(cash, 'stockLevels', 'BF-BELL_p1')), true);

// ---- the server-only collections refuse every browser
const srvColls = ['sales', 'saleLines', 'payments', 'creditNotes', 'refunds', 'laybys', 'specialOrders', 'shifts', 'goodsReceived', 'stockMovements', 'stockLevels', 'numberBlocks', 'voidedNumbers', 'counters', 'devices', 'pinHashes'];
for (const c of srvColls) await t('owner CANNOT write ' + c, setDoc(P(owner, c, 'x1'), { any: 1, ...stamp('owner', 'BF', 'BF-BELL') }), false);
await t('owner CANNOT change a sale', updateDoc(P(owner, 'sales', 's1'), { totalCents: 1 }), false);
await t('owner CANNOT delete a sale', deleteDoc(P(owner, 'sales', 's1')), false);
await t('owner CANNOT bump the stock cache', updateDoc(P(owner, 'stockLevels', 'BF-BELL_p1'), { onHandQty: 99 }), false);
await t('nobody reads counters', getDoc(P(owner, 'counters', 'BF_INV')), false);
await t('nobody reads PIN hashes', getDoc(P(owner, 'pinHashes', 'cash')), false);

// ---- entities, stores, registers, settings
await t('owner creates an entity', setDoc(P(owner, 'entities', 'PF'), { legalName: 'PinkFoot', vatRegistered: false, invoicePrefix: 'PF', ...stamp('owner', 'PF') }), true);
await t('owner CANNOT create an entity whose entityId is not its id', setDoc(P(owner, 'entities', 'PF2'), { legalName: 'x', ...stamp('owner', 'PF') }), false);
await t('manager CANNOT create an entity', setDoc(P(mgr, 'entities', 'ZZ'), { legalName: 'x', ...stamp('mgr', 'ZZ') }), false);
await t('owner creates a store', setDoc(P(owner, 'stores', 'PF-MAIN'), { entityId: 'PF', name: 'PinkFoot', ...stamp('owner', 'PF', 'PF-MAIN') }), true);
await t('owner CANNOT create a store with a mismatched storeId', setDoc(P(owner, 'stores', 'PF-2'), { name: 'x', ...stamp('owner', 'PF', 'PF-MAIN') }), false);
await t('manager creates a register in her store', setDoc(P(mgr, 'registers', 'r1'), { name: 'Till 1', active: true, currentShiftId: '', ...stamp('mgr', 'BF', 'BF-BELL') }), true);
await t('manager CANNOT create a register in another entity', setDoc(P(mgr, 'registers', 'r2'), { name: 'x', currentShiftId: '', ...stamp('mgr', 'RC', 'RC-MAIN') }), false);
await t('manager CANNOT open a shift by hand', updateDoc(P(mgr, 'registers', 'r1'), { currentShiftId: 'sh1' }), false);
await t('manager renames the register', updateDoc(P(mgr, 'registers', 'r1'), { name: 'Front till' }), true);
await t('supervisor CANNOT create a register', setDoc(P(sup, 'registers', 'r3'), { name: 'x', currentShiftId: '', ...stamp('sup', 'BF', 'BF-BELL') }), false);
await t('manager writes settings of her entity', setDoc(P(mgr, 'settings', 'BF'), { vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] }, ...stamp('mgr', 'BF') }), true);
await t('manager CANNOT write settings of another entity', setDoc(P(mgr, 'settings', 'RC'), { vat: {}, ...stamp('mgr', 'RC') }), false);
await t('supervisor CANNOT write settings', updateDoc(P(sup, 'settings', 'BF'), { cash: { varianceLimitCents: 100 } }), false);
await t('cashier reads settings', getDoc(P(cash, 'settings', 'BF')), true);

// ---- stamps (rule 6) and whole cents (rule 1)
await t('a product needs all five stamps', setDoc(P(mgr, 'products', 'p1'), { name: 'Sofa', priceCents: 640000, costCents: 300000, entityId: 'BF', storeId: '', createdBy: 'mgr' }), false);
await t('a product must be stamped by its writer', setDoc(P(mgr, 'products', 'p1'), { name: 'Sofa', priceCents: 640000, costCents: 300000, ...stamp('owner', 'BF') }), false);
await t('a product price must be whole cents', setDoc(P(mgr, 'products', 'p1'), { name: 'Sofa', priceCents: 6400.5, costCents: 300000, ...stamp('mgr', 'BF') }), false);
await t('manager creates a product', setDoc(P(mgr, 'products', 'p1'), { name: 'Sofa', priceCents: 640000, costCents: 300000, ...stamp('mgr', 'BF') }), true);
await t('manager CANNOT move a product to another entity', updateDoc(P(mgr, 'products', 'p1'), { entityId: 'RC' }), false);
await t('manager CANNOT rewrite who created it', updateDoc(P(mgr, 'products', 'p1'), { createdBy: 'owner' }), false);
await t('manager changes a price', updateDoc(P(mgr, 'products', 'p1'), { priceCents: 650000, updatedBy: 'mgr', updatedAt: 'now' }), true);
await t('manager CANNOT delete a product', deleteDoc(P(mgr, 'products', 'p1')), false);
await t('supervisor CANNOT create a product', setDoc(P(sup, 'products', 'p2'), { name: 'x', priceCents: 1, costCents: 1, ...stamp('sup', 'BF') }), false);
await t('cashier CANNOT change a price', updateDoc(P(cash, 'products', 'p1'), { priceCents: 1 }), false);
await t('manager creates a variant', setDoc(P(mgr, 'variants', 'v1'), { productId: 'p1', name: 'Grey', priceCents: null, costCents: null, ...stamp('mgr', 'BF') }), true);
await t('manager CANNOT create a product in another entity', setDoc(P(mgr, 'products', 'p9'), { name: 'x', priceCents: 1, costCents: 1, ...stamp('mgr', 'RC') }), false);

// ---- customers
await t('cashier CANNOT add a customer directly (the server does, keyed by cell number)', setDoc(P(cash, 'customers', 'c2'), { name: 'Sipho', storeCreditCents: 0, accountEnabled: false, creditLimitCents: 0, ...stamp('cash', 'BF') }), false);
await t('cashier CANNOT add a customer with store credit', setDoc(P(cash, 'customers', 'c3'), { name: 'x', storeCreditCents: 100, ...stamp('cash', 'BF') }), false);
await t('cashier CANNOT open an account', updateDoc(P(cash, 'customers', 'c1'), { accountEnabled: true, creditLimitCents: 500000 }), false);
await t('cashier CANNOT change a phone number directly', updateDoc(P(cash, 'customers', 'c1'), { phone: '0821234567', updatedBy: 'cash', updatedAt: 'now' }), false);
await t('cashier CANNOT touch store credit', updateDoc(P(cash, 'customers', 'c1'), { storeCreditCents: 999999 }), false);
await t('manager CANNOT open an account directly either', updateDoc(P(mgr, 'customers', 'c1'), { accountEnabled: true, creditLimitCents: 500000 }), false);
await t('cashier reads customers', getDoc(P(cash, 'customers', 'c1')), true);
await t('cashier CANNOT read the phone index', getDoc(P(cash, 'customerPhones', 'BF_27821234567')), false);
await t('manager CANNOT touch store credit either', updateDoc(P(mgr, 'customers', 'c1'), { storeCreditCents: 0 }), false);
await t('cashier in RC CANNOT read a BF customer', getDoc(P(cash2, 'customers', 'c1')), false);

// ---- buying
await t('cashier CANNOT read suppliers', getDocs(query(collection(cash, 'pos', G, 'suppliers'), where('entityId', '==', 'BF'))), false);
await t('manager adds a supplier', setDoc(P(mgr, 'suppliers', 'su1'), { name: 'Foam Co', ...stamp('mgr', 'BF') }), true);
await t('supervisor reads suppliers', getDoc(P(sup, 'suppliers', 'su1')), true);
await t('manager drafts a purchase order', setDoc(P(mgr, 'purchaseOrders', 'po3'), { status: 'draft', docNo: '', supplierId: 'su1', lines: [], ...stamp('mgr', 'BF', 'BF-BELL') }), true);
await t('manager CANNOT number it herself', setDoc(P(mgr, 'purchaseOrders', 'po4'), { status: 'draft', docNo: 'BF-PO-000009', supplierId: 'su1', lines: [], ...stamp('mgr', 'BF', 'BF-BELL') }), false);
await t('manager CANNOT send it herself', updateDoc(P(mgr, 'purchaseOrders', 'po1'), { status: 'sent' }), false);
await t('manager edits a draft', updateDoc(P(mgr, 'purchaseOrders', 'po1'), { lines: [{ productId: 'p1', qty: 2 }] }), true);
await t('manager CANNOT edit a sent order', updateDoc(P(mgr, 'purchaseOrders', 'po2'), { lines: [] }), false);
await t('supervisor reads purchase orders of her store', getDoc(P(sup, 'purchaseOrders', 'po1')), true);

// ---- users
await t('manager adds a cashier within her reach', setDoc(P(mgr, 'users', 'newcash'), { email: 'n@shop.co.za', name: 'New', role: 'cashier', active: true, entityIds: ['BF'], storeIds: ['BF-PAROW'], ...stamp('mgr', 'BF') }), true);
await t('manager CANNOT add a cashier in another store', setDoc(P(mgr, 'users', 'newcash2'), { email: 'n2@shop.co.za', name: 'New', role: 'cashier', active: true, entityIds: ['RC'], storeIds: ['RC-MAIN'], ...stamp('mgr', 'RC') }), false);
await t('manager CANNOT add a manager', setDoc(P(mgr, 'users', 'newmgr'), { email: 'm@shop.co.za', name: 'M', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], ...stamp('mgr', 'BF') }), false);
await t('owner adds a manager', setDoc(P(owner, 'users', 'newmgr'), { email: 'm@shop.co.za', name: 'M', role: 'manager', active: true, entityIds: ['BF'], storeIds: ['BF-BELL'], ...stamp('owner', 'BF') }), true);
await t('owner CANNOT create a record for their own uid', setDoc(P(owner, 'users', 'owner'), { email: 'x', name: 'x', role: 'owner', active: true, entityIds: [], storeIds: [], ...stamp('owner', 'BF') }), false);
await t('cashier CANNOT promote herself', updateDoc(P(cash, 'users', 'cash'), { role: 'owner' }), false);
await t('cashier CANNOT widen her stores', updateDoc(P(cash, 'users', 'cash'), { storeIds: ['BF-BELL', 'BF-PAROW'] }), false);
await t('cashier corrects her own name', updateDoc(P(cash, 'users', 'cash'), { name: 'Catherine', updatedBy: 'cash', updatedAt: 'now' }), true);
await t('manager CANNOT promote a cashier to manager', updateDoc(P(mgr, 'users', 'cash'), { role: 'manager' }), false);
await t('manager makes a cashier a supervisor', updateDoc(P(mgr, 'users', 'cash'), { role: 'supervisor' }), true);
await t('manager CANNOT deactivate the owner', updateDoc(P(mgr, 'users', 'owner'), { active: false }), false);
await t('owner CANNOT change their own role', updateDoc(P(owner, 'users', 'owner'), { role: 'manager' }), false);
await t('nobody deletes a user', deleteDoc(P(owner, 'users', 'cash')), false);

// ---- audit
await t('cashier appends to the audit log in her own name', setDoc(P(cash, 'auditLog', 'a1'), { action: 'product.view', actorUid: 'cash', details: {}, ...stamp('cash', 'BF', 'BF-BELL') }), true);
await t('cashier CANNOT append in another name', setDoc(P(cash, 'auditLog', 'a2'), { action: 'x', actorUid: 'mgr', ...stamp('cash', 'BF') }), false);
await t('cashier CANNOT read the audit log', getDoc(P(cash, 'auditLog', 'a1')), false);
await t('manager reads the audit log', getDoc(P(mgr, 'auditLog', 'a1')), true);
await t('nobody edits the audit log', updateDoc(P(owner, 'auditLog', 'a1'), { action: 'y' }), false);
await t('nobody deletes from the audit log', deleteDoc(P(owner, 'auditLog', 'a1')), false);

// ---- Factory Manager untouched: a POS user is not a Factory Manager member
await t('POS owner CANNOT read a Factory Manager company', getDoc(doc(owner, 'companies', 'A')), false);

console.log(results.join('\n'));
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nall ${results.length} passed`);
await env.cleanup();
process.exit(failed ? 1 : 0);
