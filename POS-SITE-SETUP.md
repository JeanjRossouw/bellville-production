# Factory Manager and Factory Manager POS — two modules, one site

Both live on **factorymanager.co.za**, as separate modules with their own
sign-in:

| Module | Address | What it is |
|---|---|---|
| **Factory Manager** | factorymanager.co.za/app | orders, the floor, costing, stock, dispatch, invoices |
| **Factory Manager POS** | factorymanager.co.za/pos | the shop's till: registers and cash-ups, lay-bys, returns, custom orders, stock and purchase orders, Shopify, Xero, the assistant |

Factory Manager POS works on its own; a shop needs no factory to use it. The
link to a factory is an optional switch, off by default: only when the owner
links a Factory Manager company under **POS → Admin → Settings → Factory** does
**Send to factory** appear on custom orders and sales orders, and even then
nothing is sent until someone presses it.

Both modules run from the one Netlify site (`factorymanager-za`) and the one
Firebase project (`factory-manager-ece82`).

## Selling Factory Manager POS

Any shop can sign up at **factorymanager.co.za/pos** ("New business? Start a
14-day free trial", or straight from the homepage's POS card at
`/pos/?signup=1`). Each business gets its own space, a 14-day trial and then
**R999 a month** through PayFast, paid by the owner with **Subscribe** in the
bar at the top of the POS. When a trial or subscription runs out unpaid the
business becomes read only until it pays.

- PayFast uses the same keys as Factory Manager (`PAYFAST_MERCHANT_ID`,
  `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SANDBOX`), already
  on the site. Nothing else to set.
- To change the price, set `POS_PRICE` (rands, e.g. `999`) on the site.
- The first shops (Bellville, ReptiCube, PinkFoot) are free and never see the
  bar.
- **Publish the database rules** after this change: they add the business
  records (`posMembers`, `posGroups`) and the read-only check.

## The database: upgrade it once

On the free plan the project has a daily read allowance. When it runs out,
every server job fails until it resets at 09:00 South African time (this was
the red error on the till). Switch to pay-as-you-go:

1. console.firebase.google.com → project **factory-manager-ece82**.
2. Bottom left, next to *Spark*, press **Upgrade** → choose **Blaze** → pick or create a billing account.
3. Set a **budget alert** when it asks (for example R200 a month). At your size the cost is a few rand a month; the free allowance still applies first.

## Moving a shop off the till inside Factory Manager

A shop that used Factory Manager's own till (Sales → Point of sale), such as
ReptiCube:

1. In Factory Manager POS (factorymanager.co.za/pos): set up the company,
   store, registers and staff (Admin); if it should send custom orders to a
   factory, link it (Admin → Settings → Factory); connect Shopify and press
   **Bring in the shop's catalogue** with the opening stock ticked.
2. Sell on Factory Manager POS from an agreed day.
3. In Factory Manager → Settings → **Point of sale** → **Switch off the
   built-in till**. Factory Manager is then the factory only; the till link
   (`/app/?pos=1`) says where the till went; past till sales stay on record
   and in Profit. It can be switched back on there.

Open lay-bys, gift-card balances and account balances from the old till do not
move by themselves: finish or note them before the switch.

## The old Bellville till

The older Production Manager on the `bellville-production` site keeps its own
till on **/till** (`index.html?pos=1`). It is not Factory Manager POS.
