# Factory Manager and Factory Manager POS — two sites

Two products come from this one codebase, each on its own Netlify site:

| Product | Address | Netlify site | `FM_PRODUCT` |
|---|---|---|---|
| **Factory Manager** (orders, the floor, costing, stock, dispatch, invoices) | factorymanager.co.za | `factorymanager-za` | `factory` |
| **Factory Manager POS** (the shop's till: registers, lay-bys, returns, custom orders, stock, POs, Shopify, Xero) | pos.factorymanager.co.za | `factorymanager-pos` (new) | `pos` |

They share one Firebase project (`factory-manager-ece82`). A shop's custom
order reaches the factory only when someone at the shop presses **Send to
factory**; nothing crosses by itself.

What `FM_PRODUCT` does:

- **Each scheduled job runs on its own product's site only** (`netlify/functions/lib/product.mjs`):
  `pos-shopify-sync`, `pos-factory-sync` and `pos-xero-daily` on the POS site;
  `factory-shopify-poll` on the factory site. Nothing runs twice.
- **Each address opens its own app** (`netlify/edge-functions/product-split.js`):
  on the POS site the root opens the till (`/pos/`) and the factory app's paths
  go to factorymanager.co.za; on the factory site `/pos/…` goes to the POS site.

Left unset, a site runs every job and redirects nothing — exactly as before
the split — so nothing changes until both sites are set up.

## Do these in order

### 1. Upgrade the database (once)

On the free plan the project has a daily read allowance. When it runs out,
every server job fails until it resets at 09:00 South African time (this is
what showed as a red error on the till). Switch to pay-as-you-go:

1. console.firebase.google.com → project **factory-manager-ece82**.
2. Bottom left, next to *Spark*, press **Upgrade** → choose **Blaze** → pick or create a billing account.
3. Set a **budget alert** when it asks (for example R200 a month). At your size the cost is a few rand a month; the free allowance still applies first.
4. Authentication → Settings → **Authorized domains** → **Add domain** → `pos.factorymanager.co.za`.

### 2. Make the POS site

1. app.netlify.com → **Add new project** → **Import an existing project** → GitHub → **JeanjRossouw/bellville-production**, branch **main**.
   Build settings come from `netlify.toml`; leave them. Name it **factorymanager-pos**. Deploy.
2. Site configuration → **Environment variables** → add each of these (copy the values from the `factorymanager-za` site; tick *Contains secret values* for keys):

   | Key | Value |
   |---|---|
   | `FM_PRODUCT` | `pos` |
   | `FACTORY_SERVICE_ACCOUNT` | the same as on factorymanager-za |
   | `POS_OVERRIDE_SECRET` | the same as on factorymanager-za |
   | `ANTHROPIC_API_KEY` | the same as on factorymanager-za (the till's assistant) |
   | `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | the same as on factorymanager-za |
   | `XERO_POS_REDIRECT_URI` | `https://pos.factorymanager.co.za/.netlify/functions/pos-xero?action=callback` |
   | `POS_GROUP_ID`, `POS_ASSIST_PER_DAY` | only if they are set on factorymanager-za |

3. Domain management → **Add a domain** → `pos.factorymanager.co.za`. If the
   domain's DNS is not on Netlify, add the record Netlify shows (a CNAME `pos`
   → `factorymanager-pos.netlify.app`) where the domain is managed. Wait for
   the HTTPS certificate (a few minutes).
4. On the Xero developer app, add the redirect URI from the table above (keep the old one too).
5. **Deploys → Trigger deploy → Deploy site.**
6. Open **https://pos.factorymanager.co.za** — it opens the till. Sign in.

### 3. Tell the factory site it is the factory

1. On **factorymanager-za** → Environment variables → add `FM_PRODUCT` = `factory`.
2. **Deploys → Trigger deploy → Deploy site.**

From now on factorymanager.co.za/pos sends people to the POS site, and the
POS schedules run only there.

### 4. Point the shop's connections at the new address

- **Shopify** (POS → Admin → Settings → Shopify): press **Run setup again** on
  the new site; it moves the order webhooks to the new address.
- **Xero** (POS → Reports → Xero): already connected companies keep working;
  a new connection uses the new redirect address.

### 5. Move a shop off the till inside Factory Manager

A shop that used Factory Manager's own till (Sales → Point of sale), such as
ReptiCube:

1. In Factory Manager POS: set up the company, store, registers and staff
   (Admin), link the factory (Admin → Settings → Factory), connect Shopify and
   press **Bring in the shop's catalogue** with the opening stock ticked.
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
