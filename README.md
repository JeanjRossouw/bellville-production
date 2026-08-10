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
- The standalone ReptiCube till at `/reptipos/` posts each completed sale to
  **Shopify** (order + stock) and to **Xero** (paid invoice) via the same
  `xero-invoice` function the main POS tab uses. The two have separate retry
  queues, so one being down never blocks the other.
