# Order feed: Bellville Furniture → Couch Potato

Orders that Bellville assigns to the supplier appear in Couch Potato's system
by themselves, and when Couch Potato scans one out at the door, the Bellville
order is marked done by the supplier, exactly as if they had ticked it on the
old portal. Only orders cross the boundary. Neither side can see the other's
data, prices, customers or costs.

The feed is a small scheduled job that lives on **Bellville's** site
(`netlify/functions/couchpotato-feed.mjs`), because Bellville is the customer
pushing orders to its supplier. It runs every 15 minutes.

## What it does

- **Bellville → Couch Potato.** Every open Bellville or PinkFoot order whose
  supplier is Couch Potato becomes an order in their system, once. It arrives
  with the ↙ auto tag, numbered `BV-<Bellville invoice>`, with product,
  quantity, fabric, fabric status, notes, custom size, paid date and due date.
  No price (Couch Potato sets their own). Couch Potato's later edits are never
  overwritten, and an order is never sent twice.
- **Couch Potato → Bellville.** When an order has left the factory (dispatched
  or invoiced on their side), the Bellville order gets `builderDone`, the
  dispatch date, and a note in its comment thread. It then moves to Bellville's
  Delivery portal as normal.

## Setup (once, about ten minutes)

1. **The shared app's database must exist, and Couch Potato must have signed
   up** — see `SETUP.md`.
2. In the app's Firebase project: **Project settings → Service accounts →
   Generate new private key**. A JSON file downloads. This is a secret.
3. Signed in as Couch Potato's owner, open **Settings → Team** and copy the
   **company id** at the bottom. Then open **Customers**, make sure Bellville
   Furniture exists, and copy its **feed id**.
4. On **Bellville's** Netlify site → Site configuration → Environment variables,
   add:

   | Variable | Value |
   |---|---|
   | `COUCHPOTATO_SERVICE_ACCOUNT` | the whole JSON from step 2, as one line |
   | `COUCHPOTATO_COMPANY_ID` | Couch Potato's company id from step 3 |
   | `COUCHPOTATO_CUSTOMER_ID` | Bellville's customer feed id from step 3 |
   | `COUCHPOTATO_CUSTOMER_NAME` | `Bellville Furniture` (optional) |
   | `COUCHPOTATO_BUILDER_NAME` | the supplier's name exactly as it appears in Bellville's system (default `Couch Patato`) |
   | `FEED_KEY` | any long random string, for running the feed by hand |

   `FIREBASE_SERVICE_ACCOUNT` (Bellville's own) is already set for the Shopify
   sync and is reused. The service account can reach every company in the
   app, so it stays on Bellville's server only; the feed itself only ever
   touches the company named in `COUCHPOTATO_COMPANY_ID`.
5. Redeploy Bellville's site. The schedule starts on its own.

## Checking it

Run it by hand and read the report:

```
https://bellville-production.netlify.app/.netlify/functions/couchpotato-feed?k=<FEED_KEY>&dry=1
```

`dry=1` shows what would happen without changing anything. Drop `dry=1` to run
it for real. The report lists every order pushed and every order marked done.

## Things to know

- The Bellville side is still one shared document, so the write-back is a
  read-modify-write done in the tightest possible window, and it only ever sets
  three fields on the specific order. The merge-safe save in the Bellville app
  (PR #96) protects the other direction.
- If Couch Potato deletes a fed order, it will not be re-sent (the feed
  remembers by Bellville order id). Re-send by assigning the Bellville order to
  the supplier again after clearing it, or ask for a reset.
- Fabric status and due dates are sent once at creation; later changes on the
  Bellville side do not overwrite what Couch Potato has set.
