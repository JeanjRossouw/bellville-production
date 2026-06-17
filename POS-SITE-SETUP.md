# Dedicated POS site (the till) — setup

The till is **the same app in "POS mode"** — a clean, full-screen, cashier-only
view that reuses the same Firebase backend, the per-business POS docs, and the
Netlify functions. No separate codebase.

## How POS mode activates
Any of these boots the till instead of the full Production Manager:
- a **`pos.` subdomain** (e.g. `pos.repticube.co.za`) — best for a dedicated site;
- the **`/pos`** path on the main site (`bellville-production.netlify.app/pos`);
- **`?pos=1`** on any URL.

It also **locks to one business** when the host/URL names it: a `?biz=repticube`
param, or a host containing the business name (`pos.repticube.*`, `pos.pinkfoot.*`,
`pos.bellville.*`). Otherwise it defaults to the current business and the cashier
can switch.

## Option A — a separate Netlify site (own domain), shared backend
1. **Netlify → Add new site → Import an existing project → the same GitHub repo**,
   branch `main`. Build settings are inherited from `netlify.toml` (publish `.`,
   functions `netlify/functions`).
2. **Copy the environment variables** onto this new site — the same Xero / Shopify
   / Firebase vars as the main site, since this site runs its own copy of the
   functions. (Same external apps + same Firebase project = shared data.)
3. **Add a custom domain** like `pos.repticube.co.za`. Because the host starts
   with `pos.` and contains `repticube`, it auto-boots POS mode locked to ReptiCube.
   - Per store: `pos.bellville.…`, `pos.pinkfoot.…`, `pos.repticube.…`.
4. Cashiers open that domain, sign in with a **`cashier`** account, and see only
   the till.

## Option B — no new site (quickest)
Just bookmark the main site's till path:
- `bellville-production.netlify.app/pos?biz=repticube`
- `…/pos?biz=pinkfoot`, `…/pos?biz=bellville`

Same focused till, no extra Netlify setup.

## Notes
- Admins still get the **🛒 POS tab** inside the Production Manager — POS mode is
  only a focused presentation of the same screen.
- The till shares everything: a sale rung up on the dedicated site shows on the
  manager's dashboard and syncs to Xero/Shopify exactly as in-app.
- Give cashiers the **`cashier`** role (Firebase `users/<uid>.role = "cashier"`)
  so they only ever see Dashboard + POS.
