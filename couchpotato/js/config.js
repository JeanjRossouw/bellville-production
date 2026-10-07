// Couch Potato factory system — configuration.
//
// This app is deliberately standalone: its own Firebase project, its own
// hosting, its own logins. Nothing is shared with the Bellville Furniture
// system. Bellville is simply one of Couch Potato's customers.
//
// Until FIREBASE_CONFIG below is filled in, the app runs in DEMO mode: data
// lives in this browser only, so the whole system can be clicked through and
// reviewed before any database exists. See SETUP.md for going live.

export const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
};

// The factory's own details. These appear on job cards, quotes and invoices,
// and are editable in the app under Settings — so Couch Potato can correct
// their own registered details without anyone touching the code.
export const FACTORY_DEFAULTS = {
  name: 'Couch Potato',
  legalName: 'Couch Potato',
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
