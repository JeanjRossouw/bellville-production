# bellville-production

Production management web app for Bellville Furniture, PinkFoot Boutique, and
ReptiCube. Single `index.html`, vanilla JavaScript, Firebase backend (Auth +
Firestore), PDF.js for sales-order parsing.

Deployed via Netlify (auto-deploy from this repo's default branch) at
https://bellville-production.netlify.app.

## Editing

Edit `index.html` directly. There's no build step, no dependencies. Push to
the default branch and Netlify deploys automatically.

## Notes

- Firebase project: `bellville-production-ffb19`
- All state lives in `data.bellville | data.pinkfoot | data.repticube`,
  synced via a single Firestore doc at `shared-data/production`.
- Role-based tab visibility — see `ROLE_PERMISSIONS` near the bottom of the
  script block.
- **POS** (Phase 1): a `🛒 POS` tab provides a standalone till per business.
  Products & stock are the master here (`data.<biz>.posCatalog`); completed
  sales record to `data.<biz>.posSales`, decrement stock, and print a receipt.
  New `cashier` role sees only Dashboard + POS. The POS data model is shaped on
  the **Lightspeed Retail (R-Series) API** (`Item` / `Sale` / `SaleLine` /
  `SalePayment`) so future Lightspeed sync is a clean field map; `_`-prefixed
  fields are local-only. Xero/Shopify/factory integrations are later phases —
  see `POS-BUILD-PLAN.md`.
