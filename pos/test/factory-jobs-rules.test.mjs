// Factory Manager job cards: the database rules for workstations, steps,
// job cards and time entries (couchpotato/firestore.rules), on the emulator.
// Costing sets up workstations and steps; the floor (and whoever moves orders
// on) writes job cards and starts and stops time entries; a stopped entry is
// changed only by the owner, Wages or Costing, and only with who and why;
// nobody but the owner deletes; time entries are not read by roles that do
// not see the floor or the money; a company whose trial is over writes nothing.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, updateDoc, deleteDoc, query, where, Timestamp } from 'firebase/firestore';
import fs from 'node:fs';
const env = await initializeTestEnvironment({ projectId: 'fm-jobs-rules', firestore: { rules: fs.readFileSync(new URL('../../couchpotato/firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 } });
await env.clearFirestore();
const results = []; let failed = 0;
async function t(name, p, expectOk) { try { await (expectOk ? assertSucceeds(p) : assertFails(p)); results.push('✓ ' + name); } catch (e) { failed++; results.push('✗ ' + name + ' — ' + e.message.slice(0, 200)); } }
const as = (uid) => env.authenticatedContext(uid, { email: uid + '@factory.co.za' }).firestore();
const own = as('own'), floor = as('floor'), store = as('store'), pay = as('pay'), cost = as('cost'), stranger = as('stranger'), old = as('old');
const C = (db, ...p) => doc(db, 'companies', 'A', ...p);
const none = { pos: 'none', orders: 'none', quotes: 'none', customers: 'none', factory: 'none', costing: 'none', stock: 'none', storeroom: 'none', scan: 'none', deliveries: 'none', invoices: 'none', profit: 'none', wages: 'none', settings: 'none' };
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'companies', 'A'), { name: 'Couch Potato', ownerUid: 'own', plan: 'trial', status: 'trial', createdAt: Timestamp.now() });
  await setDoc(doc(db, 'companies', 'B'), { name: 'Old trial', ownerUid: 'old', plan: 'trial', status: 'trial', createdAt: Timestamp.fromMillis(Date.now() - 30 * 86400000) });
  await setDoc(doc(db, 'companies', 'B', 'members', 'old'), { role: 'owner' });
  await setDoc(C(db, 'roles', 'factory'), { name: 'Factory floor', perms: { ...none, factory: 'edit', scan: 'edit', stock: 'edit', orders: 'view', deliveries: 'view' } });
  await setDoc(C(db, 'roles', 'storeroom'), { name: 'Stock room', perms: { ...none, storeroom: 'edit', stock: 'view', orders: 'view' } });
  await setDoc(C(db, 'roles', 'pay'), { name: 'Wages', perms: { ...none, wages: 'edit' } });
  await setDoc(C(db, 'roles', 'sales'), { name: 'Sales', perms: { ...none, pos: 'edit', quotes: 'edit', orders: 'edit', customers: 'edit' } });
  await setDoc(C(db, 'roles', 'cost'), { name: 'Costing', perms: { ...none, costing: 'edit' } });
  for (const [uid, role] of [['own', 'owner'], ['floor', 'factory'], ['store', 'storeroom'], ['pay', 'pay'], ['cost', 'cost'], ['sales', 'sales']]) await setDoc(C(db, 'members', uid), { role, email: uid + '@factory.co.za' });
  await setDoc(C(db, 'workstations', 'ws1'), { name: 'Upholstery', staffHourlyCost: 140, active: true });
  await setDoc(C(db, 'orders', 'o1'), { orderNo: 'CP-1', status: 'in-production', product: 'Sofa' });
  await setDoc(C(db, 'jobCards', 'jc1'), { orderId: 'o1', operationName: 'Upholster', status: 'ready', open: true, workedMinutes: 0 });
  await setDoc(C(db, 'timeEntries', 'te-run'), { jobCardId: 'jc1', staffId: 's1', kind: 'work', start: '2026-10-23T08:00:00.000Z', end: '', open: true, minutes: 0, day: '2026-10-23', rateAtTime: 183.87 });
  await setDoc(C(db, 'timeEntries', 'te-done'), { jobCardId: 'jc1', staffId: 's1', kind: 'work', start: '2026-10-23T06:00:00.000Z', end: '2026-10-23T07:00:00.000Z', open: false, minutes: 60, day: '2026-10-23', rateAtTime: 183.87 });
  await setDoc(doc(db, 'companies', 'B', 'jobCards', 'jcB'), { orderId: 'x', status: 'ready', open: true });
});

// ---- set-up: Costing only
await t('Costing adds a workstation', setDoc(C(cost, 'workstations', 'ws2'), { name: 'Sewing', staffHourlyCost: 65, active: true }), true);
await t('Costing adds a step', setDoc(C(cost, 'operations', 'op1'), { name: 'Sew covers', workstationId: 'ws2', qc: false, active: true }), true);
await t('the floor reads the workstations (the tablet lists them)', getDoc(C(floor, 'workstations', 'ws1')), true);
await t('the floor CANNOT change a workstation\'s rate', updateDoc(C(floor, 'workstations', 'ws1'), { staffHourlyCost: 1 }), false);
await t('Wages CANNOT add a step', setDoc(C(pay, 'operations', 'op2'), { name: 'x', workstationId: 'ws1' }), false);
await t('a stranger CANNOT read the workstations', getDoc(C(stranger, 'workstations', 'ws1')), false);

// ---- job cards
await t('the floor releases a job card', setDoc(C(floor, 'jobCards', 'jc2'), { orderId: 'o2', operationName: 'Pack', status: 'ready', open: true }), true);
await t('the floor moves a card on', updateDoc(C(floor, 'jobCards', 'jc1'), { status: 'running' }), true);
await t('Wages (clocking someone out) pauses a card', updateDoc(C(pay, 'jobCards', 'jc1'), { status: 'paused' }), true);
await t('the stock room CANNOT touch a job card', updateDoc(C(store, 'jobCards', 'jc1'), { status: 'done' }), false);
await t('the stock room may read job cards (every member may)', getDoc(C(store, 'jobCards', 'jc1')), true);
await t('the floor CANNOT delete a job card', deleteDoc(C(floor, 'jobCards', 'jc2')), false);
await t('the owner may delete one', deleteDoc(C(own, 'jobCards', 'jc2')), true);
await t('a stranger CANNOT read job cards', getDoc(C(stranger, 'jobCards', 'jc1')), false);
await t('the open cards query works for the floor', getDocs(query(collection(floor, 'companies', 'A', 'jobCards'), where('open', '==', true))), true);

// ---- time entries
await t('the floor starts a timer (open)', setDoc(C(floor, 'timeEntries', 'te-new'), { jobCardId: 'jc1', staffId: 's2', kind: 'work', start: '2026-10-23T09:00:00.000Z', end: '', open: true, minutes: 0, day: '2026-10-23', rateAtTime: 183.87 }), true);
await t('the floor CANNOT write an entry that is already stopped', setDoc(C(floor, 'timeEntries', 'te-fake'), { jobCardId: 'jc1', staffId: 's2', kind: 'work', start: '2026-10-23T09:00:00.000Z', end: '2026-10-23T17:00:00.000Z', open: false, minutes: 480, day: '2026-10-23' }), false);
await t('the floor stops a running timer', updateDoc(C(floor, 'timeEntries', 'te-run'), { end: '2026-10-23T09:30:00.000Z', open: false, minutes: 90 }), true);
await t('the floor CANNOT change a stopped entry', updateDoc(C(floor, 'timeEntries', 'te-done'), { minutes: 600 }), false);
await t('the floor CANNOT change it even with a reason (managers only)', updateDoc(C(floor, 'timeEntries', 'te-done'), { minutes: 600, editedBy: 'x', editReason: 'because', editedAt: '2026-10-23T10:00:00.000Z' }), false);
await t('Wages CANNOT change a stopped entry without a reason', updateDoc(C(pay, 'timeEntries', 'te-done'), { minutes: 75 }), false);
await t('Wages changes it with who and why', updateDoc(C(pay, 'timeEntries', 'te-done'), { minutes: 75, editedBy: 'Nomsa', editReason: 'Forgot to press Done', editedAt: '2026-10-23T10:00:00.000Z' }), true);
await t('a later change must carry its own new stamp (not ride on the old reason)', updateDoc(C(cost, 'timeEntries', 'te-done'), { minutes: 9 }), false);
await t('Costing changes it again, with a new stamp', updateDoc(C(cost, 'timeEntries', 'te-done'), { minutes: 70, editedBy: 'Jean', editReason: 'Checked the clock card', editedAt: '2026-10-23T11:00:00.000Z' }), true);
await t('the owner changes it', updateDoc(C(own, 'timeEntries', 'te-done'), { minutes: 72, editedBy: 'Jean', editReason: 'Rounded', editedAt: '2026-10-23T12:00:00.000Z' }), true);
await t('the floor CANNOT delete a time entry', deleteDoc(C(floor, 'timeEntries', 'te-new')), false);
await t('the stock room CANNOT read time entries (orders to look at, no floor, no money)', getDoc(C(store, 'timeEntries', 'te-done')), false);
await t('a role that only works with orders CANNOT read time entries', getDoc(C(as('sales'), 'timeEntries', 'te-done')), false);
await t('the floor reads time entries', getDoc(C(floor, 'timeEntries', 'te-done')), true);
await t('Wages reads time entries', getDoc(C(pay, 'timeEntries', 'te-done')), true);
await t('the running-timers query works for the floor', getDocs(query(collection(floor, 'companies', 'A', 'timeEntries'), where('open', '==', true))), true);
await t('the today query works for the floor', getDocs(query(collection(floor, 'companies', 'A', 'timeEntries'), where('day', '==', '2026-10-23'))), true);
await t('a stranger CANNOT read time entries', getDoc(C(stranger, 'timeEntries', 'te-done')), false);

// ---- material issues
await t('the floor issues a material', setDoc(C(floor, 'materialIssues', 'mi1'), { jobCardId: 'jc1', orderId: 'o1', materialId: 'm1', plannedQty: 10, qty: 10, unitCostAtTime: 100, cost: 1000 }), true);
await t('the floor corrects it with why', updateDoc(C(floor, 'materialIssues', 'mi1'), { qty: 11, cost: 1100, varianceReason: 'Pattern match' }), true);
await t('the stock room CANNOT issue materials to a job card', setDoc(C(store, 'materialIssues', 'mi2'), { jobCardId: 'jc1', qty: 1 }), false);
await t('the stock room CANNOT read what a job cost', getDoc(C(store, 'materialIssues', 'mi1')), false);
await t('Costing reads them', getDoc(C(cost, 'materialIssues', 'mi1')), true);
await t('the floor CANNOT delete an issue', deleteDoc(C(floor, 'materialIssues', 'mi1')), false);
await t('a stranger CANNOT read them', getDoc(C(stranger, 'materialIssues', 'mi1')), false);
await t('the floor may keep an order\'s actual cost on it', updateDoc(C(floor, 'orders', 'o1'), { actual: { materials: 1100, labour: 500, rework: 0, total: 1600, complete: true } }), true);

// ---- a company whose trial is over writes nothing
await t('trial over: the owner reads the floor', getDoc(doc(old, 'companies', 'B', 'jobCards', 'jcB')), true);
await t('trial over: no job card changes', updateDoc(doc(old, 'companies', 'B', 'jobCards', 'jcB'), { status: 'running' }), false);
await t('trial over: no timers', setDoc(doc(old, 'companies', 'B', 'timeEntries', 't1'), { open: true, kind: 'work', staffId: 's' }), false);

console.log(results.join('\n'));
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nall ${results.length} passed`);
await env.cleanup();
process.exit(failed ? 1 : 0);
