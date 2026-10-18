// Configuration — one app, sold to many furniture makers as a subscription.
//
// Every business that signs up gets its own company inside the same app and
// the same database. The database rules (firestore.rules at the repo root)
// keep each company's records invisible to every other company.
//
// With FIREBASE_CONFIG below filled in, the app runs on the real database.
// Without it (or with ?demo=1 on the address) it runs in DEMO mode: data
// lives in this browser only, so the whole system can be clicked through
// without touching anyone's records. See SETUP.md.

// The product's own name, shown on the sign-in page before anyone belongs to
// a company. A working name — change it here when the real one is chosen.
export const PRODUCT = {
  name: 'Factory Manager',
  tagline: 'Orders, factory floor, costing, dispatch and invoicing for furniture makers'
};

// Every new company starts on a free trial of this many days.
export const TRIAL_DAYS = 14;

// The Firebase project "factory-manager-ece82". These values are meant to sit
// in the web page; the database rules (firestore.rules) protect the data.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDchC2SgGdNn9VieudKSVOfZrHdi_GqPcg',
  authDomain: 'factory-manager-ece82.firebaseapp.com',
  projectId: 'factory-manager-ece82',
  storageBucket: 'factory-manager-ece82.firebasestorage.app',
  messagingSenderId: '20073181071',
  appId: '1:20073181071:web:ec19a966fd1f5f571565fa'
};

// A company's starting details. These appear on job cards, quotes and
// invoices; each company fills in its own under Settings. The name and order
// prefix are set from the company name at sign-up.
export const FACTORY_DEFAULTS = {
  name: '',
  legalName: '',
  vatNo: '',
  regNo: '',
  phone: '',
  email: '',
  address: '',
  orderPrefix: 'CP-',
  firstOrderNo: 1001,
  invoicePrefix: 'INV-',
  firstInvoiceNo: 1,
  vatRate: 0.15,
  vatRegistered: false,
  currency: 'R',
  weeklyTarget: 0,            // the week's production target, rands at selling prices, incl. VAT (0 = none)
  paymentTermsDays: 30,
  leadDays: 28,
  bankDetails: ''
};

// The demo stays available after going live: ?demo=1 on the address keeps this
// browser tab in demo mode (made-up data, nothing saved to the database), for
// showing the system to a new factory or trying a change; ?demo=0 leaves it.
const DEMO_KEY = 'fm-demo';
const demoWanted = (() => {
  try {
    const q = new URLSearchParams(location.search).get('demo');
    if (q === '1') sessionStorage.setItem(DEMO_KEY, '1');
    if (q === '0') sessionStorage.removeItem(DEMO_KEY);
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch (e) { return false; }
})();
export const isDemoForced = () => demoWanted;
export const isCloudConfigured = () => !!FIREBASE_CONFIG.projectId && !demoWanted;
