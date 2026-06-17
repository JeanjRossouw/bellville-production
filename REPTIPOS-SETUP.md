# ReptiCube POS — setup & deploy

A standalone, single-file walk-in POS for ReptiCube. **Shopify is the source of
truth** for products + stock; the browser never holds Shopify credentials (it
calls the `reptipos-shopify` Netlify Function). **Not VAT-registered** — no VAT
anywhere; the Shopify price is the final price.

- Front-end: `reptipos/index.html` (vanilla JS, no build step).
- Backend: `netlify/functions/reptipos-shopify.mjs` (Shopify proxy).
- Till data (later phases): Firebase Firestore (reuses the existing project).

## Environment variables (Netlify)
The function needs the ReptiCube store domain + credentials. It accepts the
clean names **or** the existing `_REPTICUBE`-suffixed ones already on the main
site:

| Variable | Notes |
|----------|-------|
| `SHOPIFY_DOMAIN` (or `SHOPIFY_STORE_DOMAIN_REPTICUBE`) | `repticube.myshopify.com` |
| `SHOPIFY_CLIENT_ID` (or `SHOPIFY_CLIENT_ID_REPTICUBE`) | Dev Dashboard app Client ID |
| `SHOPIFY_CLIENT_SECRET` (or `SHOPIFY_CLIENT_SECRET_REPTICUBE`) | Client secret |
| `SHOPIFY_TOKEN` | *optional* static `shpat_` token, if you ever have one |

(The pack's "get a `shpat_` token" step doesn't work for the ReptiCube store —
it uses the Dev Dashboard's client-credentials grant, which the function mints
automatically from the Client ID/secret.)

## Two ways to run it

**Quick (no new site):** since it lives in this repo, once merged it's served at
`https://bellville-production.netlify.app/reptipos/` and uses the
`_REPTICUBE` env vars already set on that site. Good for testing immediately.

**Dedicated site (clean URL):** create a second Netlify site from this repo with
**publish directory = `reptipos`** and **functions = `netlify/functions`**, set
the env vars above, and point a domain (e.g. `pos.repticube.co.za`) at it.

## Safety & money
- **Money is integer cents** internally (no floats) — formatted as ZAR for display.
- **Idempotent checkout:** each sale carries an idempotency key; a retry returns
  the same Shopify order rather than creating a duplicate paid order (dedup in
  Netlify Blobs), plus a single-submit guard on the Pay button.
- **Connected-store indicator:** the header shows the connected Shopify store
  (🏪) and turns **amber** if it isn't ReptiCube — so you can point the env vars
  at a **dev store** for testing and never accidentally write a real sale to live.
## Required Shopify scopes
The Dev Dashboard app must request **all** of these, then be **released as a new
version** and **re-installed/approved** on the store (adding scopes in the
dashboard alone does nothing until you re-install):

| Scope | Needed for |
|-------|-----------|
| `read_products` | Catalogue (products/variants/barcodes/prices) |
| `read_inventory`, `write_inventory` | Stock levels + restock on refund |
| `read_orders`, `write_orders` | Write sales as paid orders; look up orders to refund; customer history |
| `read_customers`, `write_customers` | Customer search + create + attach |
| `read_draft_orders`, `write_draft_orders` | Park / retrieve sales |
| `read_locations` | Resolve the location for inventory + restock (optional — degrades gracefully) |

If a feature errors with a Shopify permission message, it's almost always a
missing scope that hasn't been re-installed yet. The till surfaces the real
Shopify error text so you can see exactly which one.

## Phase status — all built ✅
- **Catalogue** from Shopify (cached + offline-tolerant), scan/search, product grid.
- **Cart + discounts** (per-line and whole-cart, %/amount, distributed proportionally).
- **Payments**: cash (with change), card-paid (Capitec manual), EFT-paid, split — payment layer abstracted for a future Yoco integration.
- **Sale → Shopify**: each sale writes a **paid** order so stock decrements; per-line discounted price overrides; optional customer attached. Idempotent (no duplicate orders on retry).
- **Receipts**: 80mm thermal print + WhatsApp + email (no VAT line).
- **Customers**: search / create / attach / purchase history (Shopify customers).
- **Park / retrieve**: full cart state stashed in a Shopify draft order.
- **Staff PINs**: lock screen, per-staff PIN, admin can manage staff.
- **Register / cash-up**: open float, pay in/out, X-report, close with counted-cash variance + Z-report (saved to Firestore `cashups`).
- **Offline queue**: a failed Shopify write is recorded locally and auto-retried on reconnect / every 30s / on demand — same idemKey, never a duplicate.
- **Refunds / returns**: look up an order, choose quantities (capped at refundable), optional restock, refund tender (cash/card/EFT), reason. Shopify calculates the amount; idempotent; cash refunds hit the drawer; refund slip prints.
- **Configurable tax**: off by default (no VAT). Admin can set a label + inclusive rate; prices stay tax-inclusive so it only surfaces the portion already in the price.
- **Camera scan**: best-effort BarcodeDetector fallback to the USB scanner.

### Safety trio (kept throughout)
- Integer **cents** everywhere (no floats).
- **Idempotency** keys on every order + refund write.
- **Connected-store badge** turns amber off-ReptiCube so dev-store testing is safe.

### Pending / decisions
- **Yoco deep integration**: left as the documented "card paid externally"
  manual button until the card-machine hardware decision is made. The payment
  layer is abstracted so wiring Yoco later is additive.
- **Data migration**: see `REPTIPOS-MIGRATION.md` (Lightspeed → Shopify runbook).

## Smoke test
1. Open `/reptipos/`, enter the default admin PIN **0000** at the lock screen.
2. Catalogue loads (status shows the product count); header shows the store.
3. **Scan / search** a real barcode/SKU → it adds to the cart; adjust qty + try a discount.
4. **Open register** with a float, then **Pay** → cash/card/EFT/split → confirm.
   Check the Shopify order was created (paid, stock down) and the receipt prints.
5. **Refund** that order (↩ Refund → find by number → qty → confirm) and check stock returns.
6. **Close register** → Z-report. (Test on a **dev store** first — amber badge.)
