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

## Phase status
- **Phase 1 (this):** catalogue from Shopify (cached + offline-tolerant), scan/
  search, cart + total. No payment yet.
- Phase 2: payments (cash / card-paid / split) + write the sale back to Shopify
  as a paid + fulfilled order. Phase 3: offline queue. Phase 4: staff PINs +
  cash-up. Phase 5: returns/refunds.

## Test Phase 1
1. Open `/reptipos/` (on the main site or the dedicated one).
2. The catalogue loads from ReptiCube Shopify (status shows the product count).
3. **Search** by name/SKU → tap a tile to add to the cart.
4. **Scan** a barcode (or type a barcode/SKU + Enter) → it adds that item.
5. Adjust quantities; the total updates. (Pay is stubbed until Phase 2.)
