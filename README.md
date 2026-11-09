# bellville-production

Production management web app for Bellville Furniture, PinkFoot Boutique, and
ReptiCube. Single `index.html`, vanilla JavaScript, Firebase backend (Auth +
Firestore), PDF.js for sales-order parsing.

Deployed via Netlify (auto-deploy from this repo's default branch) at
https://bellville-production.netlify.app.

## Editing

Edit `index.html` directly — the app itself has no build step. Push to the
default branch and Netlify deploys automatically.

The POS **integrations** (Phase 2+) run as Netlify Functions in
`netlify/functions/` with a small `package.json` (deps: `jose`,
`@netlify/blobs`); Netlify installs and bundles these on deploy. Setup and
required env vars are in `XERO-SETUP.md` (Phase 2 — accounting) and
`SHOPIFY-SETUP.md` (Phase 3 — catalogue/stock sync + online-order webhook). Run
`netlify dev` to exercise the functions locally.

## Notes

- Firebase project: `bellville-production-ffb19`
- All state lives in `data.bellville | data.pinkfoot | data.repticube`,
  synced via a single Firestore doc at `shared-data/production`.
- Role-based tab visibility — see `ROLE_PERMISSIONS` near the bottom of the
  script block.
- **Manufacturer portal** (`?builder=1&m=<name>`): an outsource manufacturer
  (Couch Patato, Legacy Upholstery) sees only the orders whose `builder` is its
  name. An admin makes a locked login from the Couch Manufacturers card
  (🔑 Make login): `users/<uid>` gets `role 'manufacturer', builderId, builder`,
  and that login opens only its own portal whatever the address says (the name
  follows a rename by id). Staff capture any order (a couch, a rug, anything)
  on the staff portal and may leave the supplier on **Allocate later**
  (`builder: 'To allocate'`: outsourced, on the staff portal first and counted
  apart, on no supplier's portal). Each card, in the list and the planner
  view, has the supplier as a choice: allocating a waiting order is one tap;
  moving it from one supplier to another asks first, clears the old
  supplier's done mark and keeps their thread in `builderPrevThreads`, for
  staff only. Admins add suppliers, make logins and copy links from
  🏭 Suppliers on the staff portal (the same list as the planner card).
  Supplier tabs on the staff portal give each supplier its own list and
  planner (print, job cards, export and "Move all to Unscheduled" follow the
  tab), and staff can **✓ Mark done** an order for its supplier: it moves to
  the Delivery list, as when the supplier marks it. The lock is in the
  page: the whole `shared-data/production` doc still downloads to every
  signed-in login, so this stops a partner from seeing the rest of the system,
  not someone determined with the browser's developer tools.
- **POS** (Phase 1): a `🛒 POS` tab provides a standalone till per business.
  Products & stock are the master here; completed sales decrement stock and
  print a receipt. POS data lives in **its own per-business Firestore docs**
  (`shared-data/pos-<biz>`, `{ catalog, sales }`) — separate from the main
  `shared-data/production` doc so a large imported catalogue can't blow the
  1 MB doc limit. (Legacy embedded `data.<biz>.posCatalog/posSales` is migrated
  out automatically on load.)
  New `cashier` role sees only Dashboard + POS. The POS data model is shaped on
  the **Lightspeed Retail (R-Series) API** (`Item` / `Sale` / `SaleLine` /
  `SalePayment`) so future Lightspeed sync is a clean field map; `_`-prefixed
  fields are local-only. Made-to-order sale lines (`isSpecialOrder`) auto-create
  production jobs (`source: 'pos'`) in the factory orders flow. The Dashboard
  shows a POS sales card (per-business daily takings, week/month totals, top
  products, Xero sync status). See `POS-BUILD-PLAN.md`, `XERO-SETUP.md`,
  `SHOPIFY-SETUP.md`.
- Quotes and sales orders can be shared with the customer as a private link
  (**📤 Send** → WhatsApp or copy). They see the document, its status and
  banking details, and can ask for an update; replies land in the till's 💬
  **Messages** inbox. See `CLIENT-LINKS-SETUP.md`.
- Those links are **prepared automatically** — a sales order, a quote, or any
  sale with an enclosure on it queues one under 📤 **To send** in the till
  header. Staff tap once to fire WhatsApp; click-to-chat cannot send by itself.
- **🗂 Catalogue** (managers only) is the back office: cost prices, retail
  prices, adding and retiring products, without opening Shopify or Lightspeed.
  Products stay in Shopify; **cost prices live in the POS** and are fetched only
  by manager screens, so a cashier's till never receives one. See
  `CATALOGUE-SETUP.md`.
- Till staff sign in with a PIN and are either a **cashier** or a **manager**.
  Cost prices, the dashboard, receiving, purchase orders and sales history are
  managers only. See `STAFF-ROLES.md`.
- The standalone ReptiCube till at `/reptipos/` posts each completed sale to
  **Shopify** (order + stock) and to **Xero** (paid invoice) via the same
  `xero-invoice` function the main POS tab uses. The two have separate retry
  queues, so one being down never blocks the other.
