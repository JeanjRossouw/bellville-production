# Factory Manager — one app for many furniture makers

Orders, the factory floor, costing, dispatch, invoicing and a showroom till,
sold as a subscription. Each business signs up and gets its own company inside
the same app and database; the database rules keep companies apart. Couch
Potato is the first company. "Factory Manager" is a working name, set in
`js/config.js`.

See **[SETUP.md](SETUP.md)** to create the database and put the app on its own
web address. Until then it runs in demo mode in whatever browser opens it.

## Layout

```
couchpotato/
  index.html        sign-in screen and the app shell
  www/              the public website and its screenshots
  css/app.css       one stylesheet, no framework
  js/config.js      product name, trial length, the Firebase project, defaults
  firestore.rules   the database rules that keep companies apart
  js/store.js       the data layer  ← read this one first
  js/ui.js          shared rendering helpers
  js/customers.js   customer screen
  js/orders.js      order capture, status, history
  js/floor.js       planner, fabric list, job cards
  js/costing.js     materials, bills of material, overheads, price sheet
  js/scan.js        scan out at the door, dispatch, tell the customer
  js/invoices.js    invoice queue, invoices, payments, statements, export
  js/pos.js         point of sale: the showroom till
  js/stock.js       materials on hand, purchase orders, stock movements
  js/quotes.js      quotations that turn into orders
  js/profit.js      profit per month, product and piece
  (../netlify/functions/factory-billing.mjs  PayFast subscriptions, server side)
  js/qr.js          QR codes for job cards (vendor/qrcode.js, MIT)
  js/app.js         sign-in and sign-up, navigation by role, settings, the team
```

No build step. The only third-party code is the vendored QR generator. The files are served exactly as they are, so
a change is live the moment it deploys.

## The two rules

**Every record is its own document, and a save sends only the fields that
changed.**

**Every record belongs to one company.** Records live under
`companies/<id>/…`, and only that company's members can read or write them.
`store.js` always works inside the signed-in user's company, so no screen can
reach another company's data by accident.

The older Bellville system kept every order for every business inside a single
database record, so each save rewrote the whole lot. A device holding a stale
copy could wipe out orders someone else had added, and that happened in
practice. Per-document writes make that impossible here: two people working at
the same time, on the same order or different ones, cannot overwrite each other.
It also removes the size ceiling and lets the floor load only what it needs.

Everything in `store.js` exists to hold that line. Keep new features inside it
rather than reaching for Firestore directly.

## Status

Built: customers, orders with their own numbering, status flow, due dates,
fabric tracking, search and per-order change history; the factory floor with a
four-week drag-and-drop planner, fabric watch-list, printable
job cards and a printable planner.

Also built: costing — a materials library with current prices, a bill of
materials per product, labour and an overhead share per piece, margin against
the selling price, a printable price list for customers and an internal cost
sheet. Capturing an order from the catalogue fills in its price.

Also built: scan out — every job card carries a QR code that opens the app
on that order; the Scan out screen reads it with the camera (or takes a typed
order number), marks the piece dispatched with who and when, and offers a
one-tap WhatsApp or email to the customer. Dispatched orders queue for
invoicing.

Also built: invoicing — dispatched orders wait in a queue until they are on
an invoice; invoices are raised per customer in Couch Potato's own numbering,
with VAT when registered, printed in their name with their bank details;
payments are recorded against them; per-customer statements; a CSV export
of every invoice line for the accountant.

Also built: the one-way order feed from Bellville (netlify/functions/
couchpotato-feed.mjs), and a point of sale. The till rings up sales from the
same catalogue against the same customers; each line is made to order (an order
is created on the spot and goes to the factory) or from stock (the showroom
count drops). Every sale raises an invoice with the payment on it, so orders
born at the till are already billed. The till link is `?pos=1`.

Also built: accounts. Sign up with **Start free trial** (a new company on a
14-day trial), invite staff by email with a role (owner, office, sales,
factory), join from the invitation link, change roles, remove people, reset a
forgotten password. Menus follow the role.

Also built: billing. A monthly subscription through PayFast (card or instant
EFT), started from Settings → Billing; payment notices are verified on the
server (netlify/functions/factory-billing.mjs) and only the server can mark a
company paid. When a trial ends or payments stop the company becomes read
only, enforced by the database rules. The seller's Clients tab lists every
company, the monthly income, and can extend a trial or give free access.

Also built: the public website (couchpotato/www/index.html, served at
/factory-manager). What the app does with real screenshots of a fictional
demo company, the live price from the billing function, a short FAQ, and
"Start free trial" buttons that open the app's sign-up form (?signup=1). The
product name and app address are set at the bottom of the page.

Also built: stock and purchase orders (js/stock.js). Materials are counted
once, then kept up to date: an order's bill of materials comes off the shelf
when it leaves New and goes back if it is moved back; deliveries are booked
in against purchase orders; stock counts correct the figure. The Stock tab
shows on hand, what open orders still need, what is on order, and an Order
now list per supplier that drafts the purchase order with the amounts. A
purchase order is sent by WhatsApp, email or print, and received in full or
in part. Every change is listed under Movements.

Also built: quotes (js/quotes.js) — priced from the catalogue with the cost
and margin of every line shown only to the person quoting, for an existing
or a new customer; sent by WhatsApp, email or PDF; accepted with one tap
into factory orders (discount spread over the lines, new customer added);
declined with a reason; expired when past their date. And a profit report
(js/profit.js) — per month sales, materials, labour, gross profit,
overheads and net profit, plus by product and every piece weakest margin
first, from dispatched orders and till sales from stock.

Next: per-role limits on what each role can change, and terms of service
and a privacy policy for the website.
