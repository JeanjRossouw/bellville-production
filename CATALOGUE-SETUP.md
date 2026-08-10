# The catalogue back office

**🗂 Catalogue** in the till header. Managers only — it is where the buying
prices are.

Everything that used to mean opening Shopify or Lightspeed admin: put a cost
price in, correct a retail price, add a product, retire one.

## Where things live, and why

| | Kept in | Why |
|---|---|---|
| Products, names, prices, stock | **Shopify** | The online shop and the till read the same catalogue, so they cannot drift apart |
| **Cost prices** | **the POS** | A buying price is nobody's business but yours. Keeping it out of Shopify means it is not readable by anyone with a Shopify or Lightspeed login |

Cost prices sit in one small Firestore document, `shared-data/pos-costs-repticube`,
keyed by Shopify variant id and shared by every till.

This also closes something the role split could not. Before, cost prices came
down with the catalogue to every till, so a cashier's browser held them even
though no screen showed them. Now costs are fetched **only** by the manager-only
screens that need them — the catalogue, the dashboard, receiving and purchase
orders — so a cashier's till never receives a cost at all.

## Filling in the cost prices

There are none yet. Every product in Shopify has an empty cost, which is why
Lightspeed shows R0.00 supplier price and why the dashboard's gross profit has
not meant anything.

Two ways in, and they work together:

1. **Type them.** 🗂 Catalogue → the **No cost (n)** button filters to the ones
   still missing. Fill the *Costs you* column, press **Save changes**. The
   margin updates as you type, so an obviously wrong number shows up
   immediately.
2. **A spreadsheet**, if you have supplier pricing already. 📦 Count → **Export
   to Excel**, fill the **Cost** column, then **💰 Import cost prices**.

Receiving stock and purchase orders also remember the cost you enter there, so
the list fills itself in over time.

## Adding a product

**+ New product**. Name and selling price are required; SKU, barcode, category,
cost and opening stock are optional. It is created in Shopify, so it appears on
the online shop too.

One variant per product. A product with options — Black and White, or sizes —
still gets set up in Shopify, because the till sells one tile per variant and
the option structure is Shopify's to define.

## Retiring and deleting

**Retire** archives the product: it leaves the till and the online shop but is
kept, along with its images, description and history. Nothing is lost and it can
be brought back from Shopify.

You are then asked once more whether to delete it permanently instead. Take that
only for something like a duplicate typed in by mistake — Shopify offers no undo.

## If a change is refused

Creating, editing or deleting a product needs the Shopify app token to hold
**`write_products`**. Cost prices do not — they never touch Shopify — so if
costs save but a price change comes back with a permissions error, that scope is
what is missing. Add it to the app in the Shopify admin and reinstall the token.

Reading the catalogue needs `read_products`, and stock needs `write_inventory`,
both of which the till already relies on.
