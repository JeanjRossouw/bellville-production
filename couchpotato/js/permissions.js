// Who may see and change what — the owner designs this under Settings → Roles.
//
// A role gives each screen ("area") one of three levels:
//   none  the screen is not in their menu
//   view  they can open it and look, but not change anything there
//   edit  they can work in it
// The owner always has every screen at edit, plus the team and billing.
//
// The database enforces the same thing per collection (firestore.rules):
// a collection can be changed by anyone whose role has edit on any of the
// areas listed for it in WRITE_AREAS. Keep the two in step. A role whose
// only way in is 'storeroom' is held to specific fields by the rules: stock
// counts on materials, received quantities on purchase orders, and the
// fabric-received fields on orders — never prices or anything else.

export const AREAS = [
  { key: 'pos', label: 'Point of sale', hint: 'Ring up sales at the showroom till' },
  { key: 'orders', label: 'Orders', hint: 'Capture orders, due dates, fabric' },
  { key: 'quotes', label: 'Quotes', hint: 'Price and send quotations' },
  { key: 'customers', label: 'Customers', hint: 'The customer list and contact details' },
  { key: 'factory', label: 'Factory floor', hint: 'Planner, job cards, start and finish pieces' },
  { key: 'costing', label: 'Costing & prices', hint: 'Material costs, margins, selling prices' },
  { key: 'stock', label: 'Stock', hint: 'Material counts, purchase orders, deliveries' },
  { key: 'storeroom', label: 'Stock room', hint: 'Receive deliveries and client fabric, stock take, give out stock and tools' },
  { key: 'scan', label: 'Scan out', hint: 'Dispatch pieces at the door' },
  { key: 'deliveries', label: 'Deliveries', hint: 'Schedule deliveries, drivers, signed delivery notes' },
  { key: 'invoices', label: 'Invoices', hint: 'Invoices, payments, statements' },
  { key: 'profit', label: 'Profit', hint: 'Sales, costs and profit per month' },
  { key: 'settings', label: 'Business settings', hint: 'Company details, numbering, VAT' }
];
export const LEVELS = [
  { key: 'none', label: 'Hidden' },
  { key: 'view', label: 'View' },
  { key: 'edit', label: 'Edit' }
];

const all = (level) => Object.fromEntries(AREAS.map(a => [a.key, level]));

// Every new company starts with these; the owner can change them, rename
// them, delete them and add their own.
export const DEFAULT_ROLES = {
  office: { name: 'Office', perms: all('edit') },
  sales: { name: 'Sales / till', perms: { ...all('none'), pos: 'edit', quotes: 'edit', orders: 'edit', customers: 'edit' } },
  factory: { name: 'Factory floor', perms: { ...all('none'), factory: 'edit', scan: 'edit', stock: 'edit', orders: 'view', deliveries: 'view' } },
  // receives, counts and gives out; cannot change prices, materials or orders
  storeroom: { name: 'Stock room', perms: { ...all('none'), storeroom: 'edit', stock: 'view', orders: 'view' } }
};

// A collection may be changed by a role with edit on any of these areas.
// (A sale at the till creates orders and an invoice; starting a piece on the
// floor takes materials off the shelf; and so on.)
export const WRITE_AREAS = {
  orders: ['orders', 'factory', 'scan', 'pos', 'quotes', 'invoices', 'deliveries', 'storeroom'],
  customers: ['customers', 'orders', 'pos', 'quotes'],
  products: ['costing', 'pos'],
  materials: ['costing', 'stock', 'orders', 'factory', 'scan', 'storeroom'],
  stockMoves: ['stock', 'orders', 'factory', 'scan', 'storeroom'],
  purchaseOrders: ['stock', 'storeroom'],
  storeStaff: ['storeroom'],
  assets: ['storeroom'],
  invoices: ['invoices', 'pos'],
  sales: ['pos'],
  quotes: ['quotes'],
  counters: ['orders', 'pos', 'quotes', 'invoices', 'stock', 'factory', 'scan'],
  drivers: ['deliveries'],
  deliveryNotes: ['deliveries'],
  settings: ['settings']
};

// Collections only some roles may read at all (money and buying). Everything
// else is readable by every member, because screens refer to each other
// (an order shows its customer, the till shows the products).
export const READ_AREAS = {
  invoices: ['invoices', 'pos', 'profit'],
  sales: ['pos', 'profit'],
  quotes: ['quotes'],
  purchaseOrders: ['stock', 'storeroom'],
  stockMoves: ['stock', 'storeroom'],
  storeStaff: ['storeroom'],
  assets: ['storeroom', 'stock'],
  drivers: ['deliveries'],          // each driver's private link is a secret: Edit only (see app.js)
  deliveryNotes: ['deliveries', 'orders']
};

export const levelOf = (perms, area) => (perms && perms[area]) || 'none';
export const canSee = (perms, area) => ['view', 'edit'].includes(levelOf(perms, area));
export const canEdit = (perms, area) => levelOf(perms, area) === 'edit';
export const OWNER_PERMS = all('edit');
