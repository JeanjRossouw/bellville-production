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
- `shift-api.test.mjs` — step 8: the `pos-shift` function over HTTP: open
  with a float, sales refused before and carrying the shift after, cash in
  and out with approval, the X-report figures, a close over the limit
  needing a note and a manager, the Z-report, the register freed, a second
  shift. `node pos/test/shift-api.test.mjs`
- `register.test.mjs` — step 8 in the browser: the Register tab on a till.
  `node pos/test/register.test.mjs`
- `offline.test.mjs` — step 9: blocks fetched at sign-in; sales rung up with
  the line down take the next numbers and wait in the outbox with the banner
  counting them and the cached stock dropping; back online they sync in
  order; a queued sale whose price changed is refused, kept for a manager
  and its number voided; the next block comes early when few numbers remain.
  `node pos/test/offline.test.mjs`
- `return-api.test.mjs` — step 10: the `pos-return` function over HTTP: finding
  a sale by number, customer or date; a part return at the price actually
  paid with the VAT reversed; never more than was sold; restock, quarantine
  and write-off; cash, card, EFT and store credit; the return window (manager
  PIN outside it); made-to-order needs a manager; no-receipt returns as store
  credit only, with a customer; an exchange written with its new sale in one
  transaction; credit notes numbered without a gap. `node pos/test/return-api.test.mjs`
- `returns.test.mjs` — step 10 in the browser: the Returns tab on a till.
  `node pos/test/returns.test.mjs`
- `layby-api.test.mjs` — step 11: the `pos-layby` function over HTTP: opening
  needs the customer, the minimum deposit, a signed agreement and no
  made-to-order goods; stock reserved; the settings' penalty capped at 1%;
  instalments at another store; collection into a tax invoice paid by the
  lay-by with the stock moved; cancellation with the breakdown, a refund that
  must add up, none on death (a manager); reminders; the report.
  `node pos/test/layby-api.test.mjs`
- `laybys.test.mjs` — step 11 in the browser: a lay-by from the cart with the
  signature drawn on the screen, the Lay-bys tab, an instalment and its
  receipt, collection, a cancellation with a manager's PIN.
  `node pos/test/laybys.test.mjs`
- `special-api.test.mjs` — step 12: the `pos-special` function over HTTP:
  opening needs the customer and a signed-off spec and takes made-to-order
  items only; a deposit under the minimum leaves it quoted, reaching it
  sends it to the factory; the factory endpoints with their key (the queue
  with specs, status by SO number or factory ref); the till's status step;
  updates logged; a delivery booking; the hand-over into a tax invoice paid
  by the order with the signed note; cancellation by a manager, no fee
  before production and the deposit after. `node pos/test/special-api.test.mjs`
- `specials.test.mjs` — step 12 in the browser: a custom order from the
  cart with a photo and the sign-off signed on the screen, the tab, the
  WhatsApp update, the balance, the hand-over with a signed delivery note,
  a quotation cancelled with a manager's PIN. `node pos/test/specials.test.mjs`
- `stock-api.test.mjs` — step 13: the `pos-stock` function over HTTP:
  adjustments need a manager and a reason and move the weighted average
  cost when stock is found at a cost; quarantine moves by a supervisor; a
  stock take frozen, counted by scans and typed counts while a sale goes
  through, reviewed, posted by a manager as `count` movements against the
  frozen figures with uncounted items left alone. `node pos/test/stock-api.test.mjs`
- `stock.test.mjs` — step 13 in the browser: the Stock tab as a manager —
  levels, the low-stock list, an adjustment, the item card, a stock take
  counted by scanning, reviewed and posted. `node pos/test/stock.test.mjs`
- `buy-api.test.mjs` — step 14: the `pos-buy` function over HTTP: a PO sent
  (the number, stock on order, the signed link page for the supplier), a
  part receipt with landed costs spread by value at the landed cost into
  the average and the product's cost, the rest, a direct receipt by
  quantity, a cancelled PO, a transfer sent, part received and closed
  short, a cancelled transfer. `node pos/test/buy-api.test.mjs`
- `buying.test.mjs` — step 14 in the browser: a supplier, a PO suggested
  from low stock and sent (email link, print), received with freight, the
  GRV and labels, a transfer sent. `node pos/test/buying.test.mjs`
- `customer-api.test.mjs` — step 15: the `pos-customer` function over HTTP:
  one profile per cell number, consent per channel with the date, a sale
  that earns points and one that redeems them, expiry, the history across
  stores, merging a duplicate, the export, anonymising (invoices keep their
  snapshot), points by hand. `node pos/test/customer-api.test.mjs`
- `customers.test.mjs` — step 15 in the browser: quick-add at the till with
  consent, the Customers tab and profile, a sale earning points and the
  receipt line, points as payment, a merge and an anonymisation by a
  manager. `node pos/test/customers.test.mjs`
- `report-api.test.mjs` — step 16: the `pos-report` and `pos-xero` functions
  over HTTP: the dashboard against last week, daily sales with tenders and
  refunds, the VAT report, sales by product with gross profit, by staff,
  discounts, voids, refunds, stock value, low and dead stock, movements,
  lay-bys, customers, the filters, and a balanced Xero journal with its
  CSV. `node pos/test/report-api.test.mjs`
- `reports.test.mjs` — step 16 in the browser: the dashboard on Home, the
  Reports tab running daily sales, the CSV and the print, the Xero journal
  built and downloaded. `node pos/test/reports.test.mjs`
- `money.test.mjs` — the shared cents and VAT maths; needs no emulator.
  `node pos/test/money.test.mjs`
  Set `FIREBASE_SDK_DIR` to a local copy of the `firebase` package's browser
  builds when www.gstatic.com is not reachable, and `CHROME` to a Chromium
  path when Playwright's own is not installed.
