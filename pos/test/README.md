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
  writes the order into the linked Factory Manager company's own orders with
  the store as the customer and no retail customer data (one factory
  customer per store, numbered from the factory's sequence, sent again
  without a second copy); the factory's status read back to the till and
  its orders cancelled when the till cancels; the owner's link; the till's status step;
  updates logged; a delivery booking; the hand-over into a tax invoice paid
  by the order with the signed note; cancellation by a manager, no fee
  before production and the deposit after. `node pos/test/special-api.test.mjs`
- `salesorder-api.test.mjs` — sales orders over HTTP: a made-to-order item on
  an ordinary sale needs the customer; the sale is written with its
  `salesOrders` document and the spec on the invoice line, and goes to the
  factory at once (store as the customer, invoice as the reference); the
  factory's status back by hand and by the schedule; the update; the signed
  hand-over; a credit note on the line cancels the factory order; on account.
  `node pos/test/salesorder-api.test.mjs`
- `salesorders.test.mjs` — sales orders in the browser: the specification on
  the line, the customer needed before paying, paid by card with the spec on
  the invoice, the Sales orders section, the factory checked, the WhatsApp
  update, the hand-over signed on the screen. `node pos/test/salesorders.test.mjs`
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
- `overview.test.mjs` — All businesses, the owner's screen: two shop companies
  (one with two stores) and two Factory Manager companies on the same login;
  today, this week and this month against the same days before, refunds,
  void invoices, credit notes and cancelled orders, what a factory invoiced
  the owner's own shop kept out of the total, a new sale arriving live, a
  phone with no sideways scroll, and no screen for a manager.
  `node pos/test/overview.test.mjs`
- `costimport.test.mjs` — Import costs on Products: the costs sheet out, a
  filled-in sheet back with Excel's semicolons and decimal commas, found by
  SKU, barcode or name; a product with variants takes its variants' lowest
  cost; blank, unknown, doubtful and non-number rows left alone; only the
  cost changes (prices, barcodes, pictures, VAT class, stamps kept); another
  company's same SKU untouched; the audit row; the Shopify product CSV used
  as a costs file; selling prices from a Price column, listed apart and
  saved only when ticked (product and variant prices, the audit row).
  `node pos/test/costimport.test.mjs`
- `fabrics.test.mjs` — the fabric catalogue: a price list in as CSV (cost
  per metre excl. VAT + 80% + 15% VAT, never under R 250), a made-to-order
  product's fabric metres and a variant's own; on the till the
  specification picks a fabric and the price follows; the server prices it
  again (a sale and a custom order go through, a till that leaves the fabric
  out, another company's or an archived fabric are refused); a cashier
  reads but cannot write the catalogue. `node pos/test/fabrics.test.mjs`
- `quotes.test.mjs` — quotes and the Sales order button: a quote priced by
  the server (fabric included), numbered, valid for some days, with or
  without the customer; its prices hold in a sale or a sales order (a
  deposit, the rest later) after the list price rose, once, while in date;
  cancelled once; on the till Quote shows the Quotation, Sales → Quotes lists
  it, Load into the sale puts it back at its prices, Sales order needs the
  customer. `node pos/test/quotes.test.mjs`
- `shopify-api.test.mjs` — step 17: `pos-shopify` against a mock Shopify in
  the test: connect, locations mapped, products linked by SKU with content
  pulled, stock pushed after a sale and by "push all", a webhook order
  (signed) deducting stock and one reserving it, a cancellation and a
  refund restocking, click & collect marked and fulfilled, discount codes
  pulled and honoured on a sale, consented customers pushed, the log.
  `node pos/test/shopify-api.test.mjs`
- `online.test.mjs` — step 17 in the browser: the Online tab's click &
  collect list and a shop discount code applied on the till.
  `node pos/test/online.test.mjs`
- `assist-api.test.mjs` — the assistant: `pos-assist` over HTTP against a
  mock Anthropic API in the test (`mock-anthropic.mjs`, which calls a tool
  when the question says `[tool:name {…}]`): sign-in needed, the store
  needed, the guide and the store's live snapshot in the system prompt,
  money for a supervisor and not for a cashier, the day's count; the hands:
  low stock by supplier, a purchase order proposed and confirmed into a
  draft (a manager only, once, by the person who asked), the customers to
  message with the words written, tasks proposed and confirmed, and
  `pos-tasks` by hand. `node pos/test/assist-api.test.mjs`
- `assist.test.mjs` — the assistant in the browser: the "?" button, a starter
  question, the answer, the chat cleared at sign-out. `node pos/test/assist.test.mjs`
- `auth-api.test.mjs` — `pos-auth` and the approvals over HTTP: a till locked
  after 12 wrong PINs within 15 minutes (on top of each PIN's own lock-out),
  the override refused while locked, unlocked again; a manager's approval
  token good once on an action (`approvalToken`) and once on a sale line
  (a discount over the limit), the same sale replayed still answered.
  `node pos/test/auth-api.test.mjs`
- `shopifycard.test.mjs` — the Shopify and Factory cards under Admin →
  Settings in the browser, used the way a person does (a click into a field
  or on the select first, then the button): Connect, the location and the
  default store saved, the factory link saved. `node pos/test/shopifycard.test.mjs`
- Factory Manager job cards (couchpotato/, phase 1 of the job cards spec):
  - `jobcards.test.mjs` — the whole floor in the demo (no emulator):
    workstation rates, a product's routing, release, the station tablet
    (start, switch, pause with a reason, done, two people on one card,
    clocking in by starting, a failed check sent back as rework then passed,
    the order Done), clock-out and an overnight timer stopped, a manager's
    change with who and why, cancelling, a product without steps, the board,
    the TV link and the tablet on a phone. Needs `server.mjs` on 8788 (or
    `FM_BASE`). `node pos/test/jobcards.test.mjs`
  - `jobcost.test.mjs` — phase 2 in the demo: the plan frozen at release,
    materials issued at start and corrected at Done (a reason for more, an
    extra one, the shelf moved), the actual on the order, the cost card on
    the floor and finished, the printout, the report and Use for a suggested
    standard time. `node pos/test/jobcost.test.mjs`
  - `jobshort.test.mjs` — phase 3 in the demo: the COM fee and a COM order
    (left out of the check, the shelf and the cost; the roll booked in; what
    cutting took), the shortage check (short, on order, Not now, Release
    anyway, material short, Order what is short, Order now naming the order,
    the tag gone when the shelf is right), and a step done outside (send,
    board, overdue on Today, back in, invoice on the cost card).
    `node pos/test/jobshort.test.mjs`
  - `factory-jobs-rules.test.mjs` — the rules for workstations, steps, job
    cards, time entries, material issues and the customer's fabric: who writes, a stopped entry changed only by the
    owner, Wages or Costing with a reason, who reads the times, a lapsed
    trial. `node pos/test/factory-jobs-rules.test.mjs`
  - `jobcards-cloud.test.mjs` — the tablet with the Factory floor role on the
    emulators through the real rules, then the owner's correction; no
    permission errors. `node pos/test/jobcards-cloud.test.mjs`
- `money.test.mjs` — the shared cents, VAT and loyalty-points maths; needs
  no emulator. `node pos/test/money.test.mjs`
- Step 18 (hardening, see `pos/HARDENING.md`) is covered inside the suites
  above: a credit note, stock adjustment, quarantine move, cash movement and
  points adjustment sent twice with one id are written once; a sale id from
  another company is refused on replay.
  Set `FIREBASE_SDK_DIR` to a local copy of the `firebase` package's browser
  builds when www.gstatic.com is not reachable, and `CHROME` to a Chromium
  path when Playwright's own is not installed.
