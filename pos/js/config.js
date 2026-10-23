// Retail POS — configuration.
//
// The same Firebase project as Factory Manager: the data sits under
// pos/{GROUP_ID}, kept apart from everything else by the database rules
// (couchpotato/firestore.rules). The web values below are public by design;
// the rules protect the data.
// the space the first shops use; a customer who signed up has its own (the server says which at sign-in)
export const GROUP_ID = 'retail';
export const APP_VERSION = '0.2.0';
export const FB_VERSION = '10.13.0';
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDchC2SgGdNn9VieudKSVOfZrHdi_GqPcg',
  authDomain: 'factory-manager-ece82.firebaseapp.com',
  projectId: 'factory-manager-ece82',
  storageBucket: 'factory-manager-ece82.firebasestorage.app',
  messagingSenderId: '20073181071',
  appId: '1:20073181071:web:ec19a966fd1f5f571565fa'
};
// the server functions (Netlify), relative so previews and the live site both work
export const API = {
  auth: '/.netlify/functions/pos-auth',
  sale: '/.netlify/functions/pos-sale',
  doc: '/.netlify/functions/pos-doc',
  shift: '/.netlify/functions/pos-shift',
  return: '/.netlify/functions/pos-return', layby: '/.netlify/functions/pos-layby', special: '/.netlify/functions/pos-special', stock: '/.netlify/functions/pos-stock', buy: '/.netlify/functions/pos-buy', customer: '/.netlify/functions/pos-customer', report: '/.netlify/functions/pos-report', xero: '/.netlify/functions/pos-xero', shopify: '/.netlify/functions/pos-shopify',
  salesOrder: '/.netlify/functions/pos-salesorder', assist: '/.netlify/functions/pos-assist', tasks: '/.netlify/functions/pos-tasks',
  signup: '/.netlify/functions/pos-signup', billing: '/.netlify/functions/pos-billing'
};
export const ROLES = [
  { key: 'cashier', label: 'Cashier' },
  { key: 'supervisor', label: 'Supervisor' },
  { key: 'manager', label: 'Manager' },
  { key: 'owner', label: 'Owner' }
];
export const RANK = { cashier: 1, supervisor: 2, manager: 3, owner: 4 };
export const DEFAULTS = {
  idleLogoutMinutes: 10,
  pinLength: 6
};
