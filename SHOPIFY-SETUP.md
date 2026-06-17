# Shopify integration — setup (Phase 3)

The **POS is the master** of products & stock. This integration syncs in both
directions:

- **Outbound** (POS → Shopify): adding/editing a product, an in-store sale, or
  the **Sync catalogue → Shopify** button pushes the product, price, and
  inventory level to that business's Shopify store.
- **Inbound** (Shopify → POS): an online order fires a webhook that **decrements
  master stock** in Firestore, so online and in-store can't oversell.

Each business (Bellville / PinkFoot / ReptiCube) uses **its own Shopify store**.

**Seeding from an existing store:** the catalogue panel has an **Import products
← Shopify** button. It pulls every product (one POS item per variant) from that
business's store, pre-filling the Shopify ids so they're already linked. Run it
once to bootstrap the catalogue; after that the POS is the master and pushes
changes out. Re-running is safe — matched products (by variant id, then SKU) are
updated in place, not duplicated. Needs the same `SHOPIFY_*` env vars below.

## 1. Create the app (Shopify Dev Dashboard)

Shopify no longer issues static `shpat_` tokens from the store admin — custom
apps are built in the **Dev Dashboard** and authenticate via the
**client-credentials grant** (the integration trades the app's Client ID +
secret for a short-lived token automatically).

For each business's store:
1. In the store admin → **Settings → Apps and sales channels → Develop apps** →
   **Build apps in Dev Dashboard** (opens the Dev Dashboard).
2. **Create an app** (e.g. `ReptiCube POS`). In its configuration, set an **App
   URL** (your Netlify site URL is fine) and the **Admin API access scopes**:
   `read_products, write_products, read_inventory, write_inventory, read_orders`.
   Release the version.
3. On the app's overview, **Install app** → select that store → Install.
4. Open the app's **Settings** and copy the **Client ID** and **Client secret**.

## 2. Set Netlify environment variables

Per business (append the upper-cased business key):

```
SHOPIFY_STORE_DOMAIN_REPTICUBE=repticube.myshopify.com
SHOPIFY_CLIENT_ID_REPTICUBE=...
SHOPIFY_CLIENT_SECRET_REPTICUBE=...
SHOPIFY_LOCATION_ID_REPTICUBE=...        # optional; defaults to the primary location
```

(A legacy `SHOPIFY_ADMIN_TOKEN_<BIZ>` static token is still honoured if you have
one from an older store — set it and the client-credentials step is skipped.)

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
