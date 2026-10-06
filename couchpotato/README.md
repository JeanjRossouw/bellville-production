# Couch Potato — factory management system

A standalone system for Couch Potato: their customers, their orders, their
factory floor, their costing, their dispatch and their invoicing. It is not part
of the Bellville Furniture system. Bellville is one of their customers.

See **[SETUP.md](SETUP.md)** to connect their own database and put it on its own
web address. Until then the app runs in demo mode in whatever browser opens it.

## Layout

```
couchpotato/
  index.html        sign-in screen and the app shell
  css/app.css       one stylesheet, no framework
  js/config.js      their Firebase project and factory defaults
  js/store.js       the data layer  ← read this one first
  js/ui.js          shared rendering helpers
  js/customers.js   customer screen
  js/orders.js      order capture, status, history
  js/floor.js       planner, fabric list, job cards
  js/costing.js     materials, bills of material, overheads, price sheet
  js/app.js         boot, navigation, settings
```

No build step and no dependencies. The files are served exactly as they are, so
a change is live the moment it deploys.

## The one rule

**Every record is its own document, and a save sends only the fields that
changed.**

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

Next: QR scan-out with customer notification (phase 4), invoicing and
statements (phase 5).
