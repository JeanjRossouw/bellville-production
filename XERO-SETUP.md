# Xero integration — setup (Phase 2)

Each completed POS sale is pushed to Xero as a paid sales invoice
(AUTHORISED `ACCREC` invoice + `Payment`). Each business
(Bellville / PinkFoot / ReptiCube) connects to **its own Xero organisation**.

The integration runs as Netlify Functions (`netlify/functions/`) so the Xero
secrets never touch the browser. The till calls them; they hold the credentials.

## 1. Create a Xero app

1. Go to https://developer.xero.com/app/manage and **create an app** (Web app).
2. Add the **OAuth 2.0 redirect URI** (must match exactly):
   `https://<your-site>.netlify.app/.netlify/functions/xero-auth?action=callback`
3. Note the **Client id** and generate a **Client secret**.
4. Scopes used: `openid profile email accounting.transactions accounting.contacts offline_access`.

## 2. Set Netlify environment variables

In Netlify → Site configuration → Environment variables:

| Variable | Required | Notes |
|----------|----------|-------|
| `XERO_CLIENT_ID` | ✅ | From the Xero app |
| `XERO_CLIENT_SECRET` | ✅ | From the Xero app |
| `XERO_REDIRECT_URI` | ✅ | The exact callback URL from step 1.2 |
| `XERO_BANK_ACCOUNT` | ✅ | Account **code** to receive the card payment (e.g. a bank/clearing account) |
| `XERO_REVENUE_ACCOUNT` | optional | Sales account code (default `200`) |
| `XERO_TAX_TYPE` | optional | Output-VAT tax type override; if unset, the revenue account's default rate applies |
| `FIREBASE_PROJECT_ID` | optional | Defaults to `bellville-production-ffb19` |
| `POS_AUTH_DISABLED` | optional | `true` bypasses sign-in checks — **first-run testing only** |

**Per-business overrides** (because each business is a separate org with its
own chart of accounts) — append the upper-cased business key:

```
XERO_BANK_ACCOUNT_BELLVILLE=...     XERO_REVENUE_ACCOUNT_BELLVILLE=...
XERO_BANK_ACCOUNT_PINKFOOT=...      XERO_REVENUE_ACCOUNT_PINKFOOT=...
XERO_BANK_ACCOUNT_REPTICUBE=...     XERO_REVENUE_ACCOUNT_REPTICUBE=...
```

A per-business value wins over the global one; the global one is the fallback.

## 3. Connect each business (one-time)

After deploy, open the **🛒 POS** tab, pick a business, and in the **Product
catalogue** panel click **“Connect this business to Xero.”** You'll be sent to
Xero's consent screen — pick the organisation for that business and approve.
Repeat for all three. (Connecting just hits
`/.netlify/functions/xero-auth?action=connect&biz=<biz>`.)

Tokens (incl. the rotating refresh token and the org's tenant id) are stored in
Netlify Blobs, keyed per business.

## 4. How a sale maps to Xero

| POS sale | Xero |
|----------|------|
| Each `SaleLine` | Invoice `LineItem` (`Description`, `Quantity`, `UnitAmount`, `AccountCode`) |
| Prices (VAT-inclusive) | `LineAmountTypes: "Inclusive"` → Xero derives the 15% VAT |
| `sale._localId` | Invoice `Reference` (also the idempotency key) |
| `sale.total` + card ref | A `Payment` against the bank account, marking it paid |
| Generic retail customer | A contact named **“POS Customer”** (auto-created once) |

The function is **idempotent**: re-posting the same sale returns the existing
invoice instead of duplicating it. The till auto-syncs on checkout and shows a
**✓ Xero / ⏳ Xero** badge per sale, with a **Retry Xero sync** button for any
that failed (e.g. offline at the time).

## Known limitations (later phases)

- **Voiding a synced sale** doesn't yet reverse it in Xero (a paid invoice needs
  a credit note). Such sales are flagged in the till for manual reversal.
- No customer capture — all sales use the single “POS Customer” contact.
- Local development needs `netlify dev` for the functions + Blobs to run.
