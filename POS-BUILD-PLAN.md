# POS System Build Plan

A point-of-sale system for **Bellville Furniture**, **PinkFoot Boutique**, and
**ReptiCube**, integrating with **Shopify**, **Xero**, and the existing
**factory/production app**.

> Status: **Plan / proposal**. No code written yet — this document is for
> review and sign-off before any build starts.

---

## 1. Goal

Build **one** POS application that all three businesses can use, where a sale
made at the till automatically:

1. Decrements stock (in the POS, which is the master) and pushes the new level
   down to Shopify.
2. Records the sale in Xero as an invoice + payment.
3. Triggers a production job in the factory app when an item is made-to-order
   rather than sold from stock.

---

## 2. Decisions already made

These were agreed up front and shape the whole design:

| Decision | Choice | Consequence |
|----------|--------|-------------|
| **Master of products & stock** | **The new POS system** | Shopify and the factory app are *downstream*. Edits flow POS → Shopify, never the reverse (for the master fields). |
| **Payments** | **In-store card machine** | Need a payment-capture step at checkout; see §9. |
| **Deliverable now** | **This plan** | Build starts only after review. |

---

## 3. Build on the existing stack (don't start from scratch)

The factory app is already a single `index.html` — vanilla JS, Firebase Auth +
Firestore, Netlify hosting, role-based tabs (`ROLE_PERMISSIONS`), and
per-business data (`data.bellville | data.pinkfoot | data.repticube`). The POS
should **reuse all of this**:

- POS becomes **a new tab** (`pos`) added to `ROLE_PERMISSIONS`, plus a new
  `cashier` role.
- Per-business data continues to live under the existing
  `data.<business>` structure.
- Firestore's offline persistence (already enabled) means **the till keeps
  working if wifi drops** and syncs when it returns — critical for a POS.

### The one genuinely new piece: a secure backend

Today the app is 100% client-side. That's fine because Firebase rules protect
the data. **But Shopify and Xero both require secret API credentials and OAuth
tokens that must never sit in `index.html`** (anyone could view-source them).

So we add a thin server layer using **Netlify Functions** (you're already on
Netlify — no new hosting):

```
/netlify/functions/
  shopify-sync.js     # push products + inventory to Shopify
  xero-invoice.js     # create invoice + payment in Xero
  xero-auth.js        # OAuth token refresh for Xero
  webhooks-shopify.js # receive Shopify online orders → decrement master stock
```

These functions hold the secrets (set as Netlify environment variables), and
the browser calls them over HTTPS. This is the only structural change to how
the app is deployed.

---

## 4. Architecture overview

```
                        ┌─────────────────────────────┐
                        │   POS  (new tab in the app)  │
                        │   — MASTER of products/stock │
                        └──────────────┬──────────────┘
                                       │  reads/writes (real-time, offline-capable)
                                       ▼
                        ┌─────────────────────────────┐
                        │  Firestore  (shared-data)    │
                        │  products / inventory / sales│
                        └───┬───────────┬───────────┬──┘
        Netlify Functions   │           │           │
        (hold the secrets)  ▼           ▼           ▼
                     ┌──────────┐ ┌──────────┐ ┌──────────────┐
                     │ Shopify  │ │   Xero   │ │ Factory app  │
                     │ catalogue│ │ invoices │ │ production   │
                     │ + stock  │ │ +payments│ │ jobs (BOM)   │
                     └──────────┘ └──────────┘ └──────────────┘
                       downstream    accounting   same Firestore
```

**Source-of-truth split:**

| Data | Master | Notes |
|------|--------|-------|
| Products, prices, stock levels | **POS / Firestore** | Pushed *down* to Shopify. |
| Financial records (invoices, payments, VAT) | **Xero** | Sales pushed *up* from POS. |
| Production jobs, BOM, cut lists | **Factory app** | Already exists; POS creates jobs in it. |
| Online orders | **Shopify** (capture) → POS (master stock) | Webhook decrements master stock so online + in-store don't oversell. |

---

## 5. Data model (Firestore) — shaped on Lightspeed Retail (R-Series)

The POS data model **mirrors the Lightspeed Retail (R-Series) API objects**
(`Item`, `Sale`, `SaleLine`, `SalePayment`) so a future sync to/from Lightspeed
— or any system that already speaks Lightspeed — is a clean field map rather
than a redesign. Fields prefixed `_` are local-only (no Lightspeed equivalent).

Extend the existing `data.<business>` documents with two arrays:

```js
data.bellville = {
  ...existing...,
  posCatalog: [                 // Lightspeed "Item"
    {
      itemID: null,             // Lightspeed id — null until synced
      _localId: 'POS-…',        // our stable local id
      description: 'Couch',     // Lightspeed calls the product name "description"
      customSku, systemSku,
      defaultCost, tax: true, taxClassID, categoryID,
      archived: false,          // soft-delete (keeps historic sales resolving)
      itemType: 'default',
      isSpecialOrder: false,    // our made-to-order marker (mirrors the LS SaleLine flag)
      Prices:    { ItemPrice: [{ amount, useType: 'Default' }] },
      ItemShops: { ItemShop:  [{ shopID, qoh, reorderPoint }] }   // qoh = master stock
    }
  ],
  posSales: [                   // Lightspeed "Sale"
    {
      saleID: null,             // Lightspeed id — null until synced
      _localId: 'SALE-…',
      timeStamp, completeTime, completed, voided,
      isTaxInclusive: true,
      shopID, employeeID, customerID, _cashierEmail,
      calcSubtotal, taxTotal, total, totalDue,
      SaleLines:    { SaleLine:    [{ itemID, _localItemId, _description, _sku,
                                      unitQuantity, unitPrice, normalUnitPrice,
                                      discountAmount, tax, isSpecialOrder, calcTotal }] },
      SalePayments: { SalePayment: [{ amount, paymentTypeID,
                                      PaymentType: { name: 'Credit Card' }, _cardRef }] },
      _synced: { lightspeed, xero, shopify }   // set by later-phase integrations
    }
  ]
}
```

Keeping `posCatalog` and `posSales` *inside* the existing per-business document
means the POS inherits real-time sync, offline support, and the business
selector for free. (If `posSales` volume grows large, split it into a
sub-collection later — not needed for launch.) The later Xero/Shopify/factory
phases add their linking ids (e.g. `xeroInvoiceId`, `shopifyVariantId`,
`productionJobIds`) onto these same objects.

---

## 6. The POS module (UI)

A new `pos` tab with three panes:

1. **Product grid / search** — tap or scan (barcode → SKU) to add to cart.
   Filtered to the currently selected business.
2. **Cart** — line items, quantities, live VAT (15%) and total, discount field.
3. **Checkout** — choose business, confirm card payment, finalise sale,
   print/email receipt.

Behaviour on **"Complete sale"**:

```
1. Validate stock (warn if a non-made-to-order item would go negative)
2. Capture card payment (§9) → store cardRef
3. Write sale to Firestore + decrement master stockOnHand
4. Fire (async, non-blocking) the three integrations:
     → shopify-sync   (update stock on Shopify)
     → xero-invoice   (create + pay invoice)
     → production job  (only for madeToOrder lines)
5. Show receipt; mark per-integration sync status on the sale
```

Integrations run **after** the sale is saved, so a slow/down API never blocks
the till. A small "sync queue" retries anything that failed (the `synced`
flags drive a background retry).

---

## 7. Shopify integration (downstream)

POS is master, so the flow is mostly **outbound**:

- **On product create/edit in POS** → `shopify-sync` upserts the product and
  sets inventory in Shopify (Admin GraphQL API).
- **On each in-store sale** → push the new stock level to Shopify so the
  online store can't oversell.
- **Inbound (the one exception):** a Shopify **webhook** for online orders
  calls `webhooks-shopify`, which decrements the *master* stock in Firestore.
  This is the only case where Shopify pushes to us, and it only touches stock,
  not the catalogue.

Each business maps to its own Shopify store (or a single store with location
tags) — confirm which during Phase 0.

---

## 8. Xero integration (accounting)

Every completed sale becomes a Xero record:

- Create an **invoice** (or "receive money" transaction) with line items, each
  mapped to a revenue **account code** (`product.xeroAccountCode`).
- Apply **15% VAT** (South Africa) per line; Xero handles the VAT return.
- Mark it **paid** against the card/bank-clearing account.
- Store `xeroInvoiceId` back on the sale for traceability.

Xero specifics to handle:

- **OAuth 2.0** with refresh tokens — handled in `xero-auth.js`; tokens stored
  server-side, never in the browser.
- Each business is likely a **separate Xero organisation** → one connection +
  tenant ID per business.
- Map POS payment method → Xero bank/clearing account.

The Xero connection is already available in this workspace, which de-risks
this phase considerably.

---

## 9. Payments — in-store card machine

Two integration levels; recommend starting simple and upgrading later:

**Phase 1 — standalone terminal (recommended start):**
The cashier enters the amount on the existing card machine; on approval they
type/scan the **reference/auth code** into the POS, which records
`paymentMethod: 'card'` + `cardRef`. Zero hardware integration, works with any
bank terminal, ships fast.

**Phase 2 — integrated terminal (optional upgrade):**
If you use a programmable terminal (e.g. Yoco / a cloud-POS-capable reader),
the POS sends the amount to the reader and receives an automatic
approval/decline. Smoother and less error-prone, but tied to a specific
hardware/payment provider — worth doing once the rest is proven.

> **To confirm:** which card machine / acquirer each store uses today. That
> determines whether Phase 2 integration is even available.

---

## 10. Factory integration (made-to-order)

When a sold line has `madeToOrder: true` (e.g. a custom Bellville couch not in
stock), completing the sale **creates a production job** in the existing
factory data — the same structure the `intake`/`orders` tabs already use — and
links it back via `sale.productionJobIds`. The sale is the trigger; the factory
app remains the master of production/BOM/cut-list data. No new system needed,
just a write into the existing model.

---

## 11. Phased delivery

| Phase | Deliverable | Depends on |
|-------|-------------|------------|
| **0. Setup & confirmation** | Confirm Shopify store layout, Xero orgs per business, card machines. Provision Netlify env vars + Firebase rules for new collections. | — |
| **1. POS core (standalone)** ✅ *built* | `pos` tab + `cashier` role, product catalogue, cart, checkout, **manual card capture**, sale recorded in Firestore, master stock decrement, receipt. **Fully usable in-store.** | 0 |
| **2. Xero sync** ✅ *built* | Each completed sale → Xero invoice + payment, with retry queue. Per-business Xero org via Netlify Functions + OAuth2. See `XERO-SETUP.md`. | 1 |
| **3. Shopify sync** ✅ *built* | Push catalogue + stock to Shopify; inbound webhook for online orders → master stock. Per-business store via Netlify Functions. See `SHOPIFY-SETUP.md`. | 1 |
| **4. Made-to-order → factory** | Made-to-order lines create production jobs in the factory app. | 1 |
| **5. Integrated payments (optional)** | Direct card-terminal integration if hardware supports it. | 1, hardware |
| **6. Reporting** | POS sales on the existing dashboard (daily takings per business, top products), reconciled against Xero. | 2 |

Each phase is independently shippable. After Phase 1 you have a working till;
everything else is additive automation.

---

## 12. Risks & open questions

- **Stock consistency** between in-store and online — handled by making POS the
  single master and using the Shopify webhook to feed online sales back. Needs
  careful testing for race conditions.
- **Offline sales** — Firestore queues writes offline; integration pushes must
  wait for reconnect (the retry queue covers this).
- **Multi-org Xero / multi-store Shopify** — confirm the exact account
  structure per business in Phase 0.
- **VAT registration** — confirm each business's VAT status so invoices are
  correct.
- **Card machine model** — determines Phase 5 feasibility.
- **Receipt printing** — browser print vs. dedicated receipt printer (decide in
  Phase 1).

---

## 13. Rough effort

- **Phase 1 (working till):** the bulk of the value, achievable as a focused
  first build.
- **Phases 2–4 (the integrations):** each is a contained chunk, roughly similar
  in size to one another, sequenced after Phase 1.
- **Phases 5–6:** optional polish, do once the core is proven in real use.

The single biggest new concept versus today's app is the **Netlify Functions
backend** for holding Shopify/Xero secrets — small in code, but it's the piece
that makes secure integration possible.

---

## Bottom line

Yes — one POS for all three businesses is very achievable, and your existing
app gives you a big head start (multi-business data model, auth, roles, offline
sync, Netlify + Firebase already in place, and live Shopify + Xero
connections). The recommended path: **ship Phase 1 as a standalone till first**,
then layer Xero, Shopify, and factory automation on top one phase at a time.
