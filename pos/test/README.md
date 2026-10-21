# POS tests

Both run against the local Firebase emulators (Firestore on 8085, Auth on 9099):

```
npm i -D @firebase/rules-unit-testing firebase firebase-tools playwright   # once
npx firebase emulators:start --only firestore,auth --project factory-manager-ece82
```

- `rules.test.mjs` — the `/pos/{gid}` block of `couchpotato/firestore.rules`:
  roles, entity and store reach, the server-only collections, the five
  stamps and whole cents. `node pos/test/rules.test.mjs`
- `auth.test.mjs` — step 2 in a browser: the first owner, staff, enrolling a
  till, PIN sign-in, lock-out, the manager override and its audit row, idle,
  offline PIN. It starts `server.mjs` (the repo as static files plus the
  `pos-*` functions on the emulators) on port 8788 if nothing is there.
  `node pos/test/auth.test.mjs`
- `admin.test.mjs` — step 3: companies, stores, registers and settings as the
  owner, then as a manager. `node pos/test/admin.test.mjs`
- `products.test.mjs` — step 4: products, variants, barcodes, per-store
  prices, the price audit, Shopify CSV out and in, labels, archiving.
  `node pos/test/products.test.mjs`
- `sell.test.mjs` — step 5: the sale screen on an enrolled till as a cashier:
  wedge scanning, variants, discounts within and over the role limit (manager
  PIN), a price override, customers, park and recall, a reload, voids.
  `node pos/test/sell.test.mjs`
- `sale-api.test.mjs` — step 6: the `pos-sale` function over HTTP: who may
  sell, prices and discounts checked, totals to the cent, cash rounding and
  change, split tenders, idempotency, stock movements and levels (a bundle
  moves its parts), store credit, the account and its limit, vouchers sold and
  used, the till's number block and numbers it chose. `node pos/test/sale-api.test.mjs`
- `pay.test.mjs` — step 6 in the browser: the payment screen on a till.
  `node pos/test/pay.test.mjs`
- `receipt.test.mjs` — step 7: a till slip, an abridged and a full tax
  invoice (the address prompt over R 5 000), the 80 mm page, printer bytes,
  the A4 page, the share link and its page, a COPY reprint from the Sales
  tab, and an Invoice for a company not VAT registered. `node pos/test/receipt.test.mjs`
- `money.test.mjs` — the shared cents and VAT maths; needs no emulator.
  `node pos/test/money.test.mjs`
  Set `FIREBASE_SDK_DIR` to a local copy of the `firebase` package's browser
  builds when www.gstatic.com is not reachable, and `CHROME` to a Chromium
  path when Playwright's own is not installed.
