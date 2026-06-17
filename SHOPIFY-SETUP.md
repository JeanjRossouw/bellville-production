# Shopify integration — setup (Phase 3)

The **POS is the master** of products & stock. This integration syncs in both
directions:

- **Outbound** (POS → Shopify): adding/editing a product, an in-store sale, or
  the **Sync catalogue → Shopify** button pushes the product, price, and
  inventory level to that business's Shopify store.
- **Inbound** (Shopify → POS): an online order fires a webhook that **decrements
  master stock** in Firestore, so online and in-store can't oversell.

Each business (Bellville / PinkFoot / ReptiCube) uses **its own Shopify store**.

## 1. Create a custom app per store

For each store: **Settings → Apps and sales channels → Develop apps → Create an
app**. Grant Admin API scopes:
`read_products, write_products, read_inventory, write_inventory, read_orders`.
Install it and copy the **Admin API access token** (`shpat_…`).

## 2. Set Netlify environment variables

Per business (append the upper-cased business key):

```
SHOPIFY_STORE_DOMAIN_BELLVILLE=bellville.myshopify.com
SHOPIFY_ADMIN_TOKEN_BELLVILLE=shpat_xxx
SHOPIFY_LOCATION_ID_BELLVILLE=...        # optional; defaults to the primary location

SHOPIFY_STORE_DOMAIN_PINKFOOT=...        SHOPIFY_ADMIN_TOKEN_PINKFOOT=...
SHOPIFY_STORE_DOMAIN_REPTICUBE=...       SHOPIFY_ADMIN_TOKEN_REPTICUBE=...
```

(A non-suffixed `SHOPIFY_STORE_DOMAIN` / `SHOPIFY_ADMIN_TOKEN` acts as a global
fallback if you ever run a single store.)

### For the inbound webhook (online order → master stock)

The webhook writes back to Firestore, so it needs a Firebase service account:

| Variable | Notes |
|----------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | The **entire** service-account JSON, as one string. Firebase console → Project settings → Service accounts → Generate new private key. |
| `SHOPIFY_WEBHOOK_SECRET` | Secret used to verify the webhook HMAC (see step 3). |

## 3. Register the order webhook (per store)

Point each store's **orders/create** webhook at this site, with the business in
the query string and format JSON:

```
https://<your-site>.netlify.app/.netlify/functions/shopify-webhook?biz=bellville
```

Set it up via **Settings → Notifications → Webhooks**, or the Admin API. Use the
store's webhook signing secret as `SHOPIFY_WEBHOOK_SECRET`. The function verifies
the `X-Shopify-Hmac-Sha256` signature and ignores anything that fails.

## 4. How it maps

| POS catalogue item (Lightspeed-shaped) | Shopify |
|----------------------------------------|---------|
| `description` | Product title |
| `customSku` | Variant SKU |
| `Prices.ItemPrice[0].amount` | Variant price |
| `ItemShops.ItemShop[0].qoh` | Inventory level at the location (absolute set) |
| `shopifyProductId / shopifyVariantId / shopifyInventoryItemId` | Stored back on the item after first push |

A **✓ / ⏳** badge in the catalogue table shows whether each product is on
Shopify yet. Made-to-order items are pushed as products but their stock is not
tracked, and online orders for them don't decrement anything.

## Notes / limitations

- Inventory is set as an **absolute** value (master wins), not a delta.
- The webhook is **idempotent** per order id (Netlify Blobs) and only touches
  stock — it never re-pushes to Shopify, so there's no sync loop.
- Matching online-order lines to catalogue items is by `shopifyVariantId` first,
  then SKU. Products created outside the POS won't match until synced.
- Local development needs `netlify dev` for the functions + Blobs.
