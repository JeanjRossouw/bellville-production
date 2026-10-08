// Configuration — one app, sold to many furniture makers as a subscription.
//
// Every business that signs up gets its own company inside the same app and
// the same database. The database rules (firestore.rules at the repo root)
// keep each company's records invisible to every other company.
//
// Until FIREBASE_CONFIG below is filled in, the app runs in DEMO mode: data
// lives in this browser only, so the whole system can be clicked through and
// reviewed before the database exists. See SETUP.md for going live.

// The product's own name, shown on the sign-in page before anyone belongs to
// a company. A working name — change it here when the real one is chosen.
export const PRODUCT = {
  name: 'Factory Manager',
  tagline: 'Orders, factory floor, costing, dispatch and invoicing for furniture makers'
};

// Every new company starts on a free trial of this many days.
export const TRIAL_DAYS = 14;

export const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
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
  paymentTermsDays: 30,
  leadDays: 28,
  bankDetails: ''
};

export const isCloudConfigured = () => !!FIREBASE_CONFIG.projectId;
