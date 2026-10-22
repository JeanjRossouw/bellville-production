// Client groups — which clients a role may see by name.
//
// Every customer can carry a group (Trade, Retail, Showroom, …). The owner
// sets per role, under Settings → Roles, whether it sees all clients or only
// the clients in chosen groups. Anyone else's client shows by its group name
// only ("Trade"), with no phone, email or address: the factory still sees
// what to make and when, just not for whom.
//
// This hides clients on the screens. Documents that go out with the goods
// (a delivery note, the driver's run) still carry the real name and address.
import * as store from './store.js';
import { allCustomers, customerById } from './customers.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const byName = (name) => { const n = norm(name); return n ? allCustomers().find(c => norm(c.name) === n) || null : null; };
// the customer behind an order, invoice or delivery stop
const custOf = (o) => (o && (customerById(o.customerId) || byName(o.customerName))) || null;

// every group in use, sorted
export function allGroups() {
  const seen = new Map();
  allCustomers().forEach(c => { const g = String(c.group || '').trim(); if (g && !seen.has(norm(g))) seen.set(norm(g), g); });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export const groupOfCustomer = (c) => String((c && c.group) || '').trim();
export const groupOf = (o) => groupOfCustomer(custOf(o));

// true when this person may see the customer by name
export function seesCustomer(c) {
  const rule = store.myClientRule();
  if (rule.mode !== 'groups') return true;
  const g = norm(groupOfCustomer(c));
  return !!g && rule.groups.some(x => norm(x) === g);
}
// for an order (or anything with customerId / customerName)
export function seesClient(o) {
  if (store.myClientRule().mode !== 'groups') return true;
  return seesCustomer(custOf(o));
}
export const limited = () => store.myClientRule().mode === 'groups';

// what to show in place of a client the role may not see
export const hiddenLabel = (o) => groupOf(o) || 'Client';

// the name to show for an order's client
export function nameOf(o) {
  if (seesClient(o)) return (o && o.customerName) || (custOf(o) || {}).name || '';
  return hiddenLabel(o);
}
// who receives a delivery
export function contactOf(o) {
  if (seesClient(o)) return (o && (o.deliveryContact || o.customerName)) || '';
  return hiddenLabel(o);
}
// a detail (phone, address, email) only when the client may be seen
export const detail = (o, value) => seesClient(o) ? (value || '') : '';

export const visibleCustomers = () => allCustomers().filter(seesCustomer);
