# Online shop (Shopify)

Each company on Factory Manager can connect **its own** Shopify store from
**Settings → Online shop**. Only the company's owner sees that card. Nothing
needs setting up on our side per company; the keys are pasted into the app and
kept on the server.

## What it does

- **Online orders → factory orders.** Each order line becomes a factory order
  with the company's own order number. It carries the customer, the fabric or
  colour (the variant or a "Fabric"/"Colour" line property), the price before
  VAT after discounts, the paid date, a due date from the lead time, and the
  delivery address. Orders show an **online #1001** tag.
  - Comes in **once paid** (deposit or full) by default, or **as soon as
    placed** if the owner picks that. An order taken in unpaid gets its paid
    date filled in when Shopify says it is paid.
  - If the product is linked and enough are on the shelf, the order is sent
    **from stock** (status Done, straight to delivery) and the shelf count goes
    down. Otherwise it is built.
  - The customer is matched by email, then cell number, or added.
  - Only orders placed after connecting come in. Cancelled, refunded or
    already-fulfilled orders, gift cards and tips are left out.
  - Every order comes in once only, however often Shopify sends it.
- **Products → price list** ("Bring in products"). Every active variant is
  linked to a product: by its Shopify link, or the first time by exact name.
  Prices (less VAT, when the company is VAT registered and the shop shows
  prices with VAT) and shelf counts (where Shopify keeps count) come from the
  shop. The factory's own names, recipes and costs are never touched. New
  ones are added.
- **Till → shop stock.** A sale at the till of a linked product "from stock"
  takes the same number off Shopify's count. It is sent as "take 2 off", never
  as a total, so an online sale at the same moment is not written over.

Orders arrive within a minute (Shopify webhooks), and a check every 15 minutes
(`factory-shopify-poll`) catches anything missed. While a company's trial has
ended or its subscription has lapsed, its online orders wait, and come in on
the first check after it is paid up.

## For the company (shown in the app when they tap Connect Shopify)

1. In the Shopify admin: **Settings → Apps and sales channels → Develop apps →
   Build apps in Dev Dashboard**.
2. Create an app (e.g. "Factory Manager") with these scopes:
   `read_products`, `read_orders`, `read_customers`, `read_inventory`,
   `write_inventory`, `read_locations`.
3. Under **Protected customer data**, allow name, email, phone and address.
   Without that, orders arrive with no customer details.
4. Release the app and install it on the store.
5. Paste the store address, the **Client ID** and the **Client secret** into
   Factory Manager.

## Where things live

| Path | What | Who can read or write it |
|---|---|---|
| `companies/<id>/secrets/shopify` | store, Client ID, secret, location | server only |
| `companies/<id>/integrations/shopify` | status shown in Settings | the team reads; server writes |
| `companies/<id>/shopifyOrders/<order>` | each online order, once | server only |
| `companies/<id>/shopifyPushes/<sale>` | each till sale sent, once | server only |
| `shopifyLinks/<id>` | companies the 15-minute check visits | server only |

Functions: `netlify/functions/factory-shopify.mjs` (the app's buttons, and
Shopify's webhooks at `?c=<company id>`, checked against the app secret) and
`factory-shopify-poll.mjs` (every 15 minutes). They use the same
`FACTORY_SERVICE_ACCOUNT` as billing; there are no new environment variables.
The order mapping is in `couchpotato/js/shopify-map.js`, shared with the demo.

## Not yet

- Marking the Shopify order **fulfilled** when the factory dispatches it.
- Online orders still appear in **Invoices → to invoice** like any other. Since
  the customer already paid Shopify, record the payment as "Shopify" when
  invoicing, or skip them.
