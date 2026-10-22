# Retail POS — hardening review (step 18)

The whole of `pos/` and `netlify/functions/pos-*` and `lib/{pos,sale,shopify-pos}.mjs`
was read for: float money maths, missing server-side checks, security-rule
gaps, duplicate document numbers, non-idempotent sync, missing audit
entries, and anything that edits a finished sale. Issues by severity, each
with what was done.

## High

| # | Issue | Fix |
|---|---|---|
| H1 | `pos-xero` carried `config.schedule` on the function that also serves its HTTP actions and the OAuth callback. A Netlify scheduled function cannot be invoked over HTTP, so the Xero API and connect flow would have been dead in production. | The schedule is its own function, `pos-xero-daily.mjs`, importing `buildDoc`/`pushDoc`; both POS schedules are declared in `netlify.toml` (`pos-shopify-sync` every 10 min, `pos-xero-daily` 01:30 UTC), since in-function `config` is not picked up on this site. |
| H2 | No idempotency key on credit notes (`pos-return credit`), stock adjustments and quarantine moves (`pos-stock`), cash in/out (`pos-shift cashMove`) and points adjustments: a resend after a dropped line would refund, adjust or move twice. | The till sends `creditId`, `adjustId`, `moveId`, `adjustId` (points); the server answers a repeat with the first result (`again: true`). Sales, lay-by and custom-order payments, receipts and transfers already carried keys. |
| H3 | Replays of `pos-sale commit`, `pos-layby pay` and `pos-special pay` returned the earlier document by id without checking the caller's company (or that the payment belonged to that lay-by/order). | Entity (and document) checked before the replay answer; 403 otherwise. |

## Medium

| # | Issue | Fix |
|---|---|---|
| M1 | A line returned in pieces was pro-rated per return (`round(net × qty / sold)`), so the pieces could add up to a cent more or less than was paid. | Telescoped: each part is `round(net × (done + qty) / sold) − round(net × done / sold)`, so the parts always sum to the line. |
| M2 | Loyalty points: `floor(cents / 100 × rate × multiplier)` through a float product could lose a point to binary drift (0.1 × 3 = 0.30000000000000004). | Rounded to a fixed scale before the floor: `floor(round(cents × rate × mult × 1000) / 100000)`. |
| M3 | Audit gaps: voiding an offline number, Shopify settings/disconnect/link/push-all, Xero connect/disconnect, reopening a stock take. | Audit rows added (`sale.voidNumber`, `shopify.settings/disconnect/link/pushAll`, `xero.connect/disconnect`, `stock.takeReopen`). |
| M4 | A manager-PIN override token is bound to its action and company and expires, but can be reused within its life (two over-limit discounts on one PIN). | Life cut from 10 to 5 minutes; each use is already audited with the approver. Single use would make `approved()` asynchronous across every function and is left as a follow-up. |
| M5 | A refund at a register till attached to no shift (step 10 passed `registerId: ''`), so the cash-up did not see refunds. | Fixed in step 16 (`shiftOptional`): refunds land on the open shift when there is one. |

## Low / accepted

- Any member may create `auditLog` rows with any `action` from the till (voids, receipt prints). They carry the writer's uid by rule; server actions are stamped `createdBy: 'server'`, so forged rows are attributable.
- Custom (non-stock) items can be rung up at any price by a cashier — by design (the brief's "custom item").
- `pos-doc` share links are signed and valid for five years; they expose one document's page to whoever holds the link. By design (WhatsApp/email).
- Office logins may name any register of their store on a sale and it lands on that register's open shift. They are members of the store; the register must be open.
- Money maths: every amount is integer cents through `pos/js/money.js`; the only divisions are pro-rata splits that are rounded once and reconciled (sale discounts spread with the last line taking the remainder; landed costs the same; returns telescoped), VAT per line through `vatIn`, and report ratios for display.
- Finished documents: no code path updates `sales`, `saleLines`, `payments`, `creditNotes` or `refunds` after creation (grep across all functions); corrections are new linked documents. `laybys.completedDocNo` / `specialOrders.completedDocNo` are patched after the sale commit — those are live documents, not the sale.
- Numbering: every series is taken either from the entity's counter inside the transaction (`nextFromCounter`, with Firestore's contention retry) or from a per-device block whose `usedUpTo` moves in the same transaction; an offline number the server refuses is recorded in `voidedNumbers` so the audit can explain the gap.
- Sync: `pos-sale commit` is idempotent on `saleId`; the outbox resends oldest first and marks refused sales for a manager; Shopify webhooks are idempotent per order/refund id; `inventorySetQuantities` sets absolute quantities so a double push is harmless; Xero journals are looked up by narration before posting.
- Rules: finished documents, counters, customers, PIN hashes, Shopify secrets and the phone index are server-only; stamps are checked on every client write (`pStamped`/`pStampsKept` keep `entityId`, `storeId`, `createdBy`, `createdAt`, `deviceId`); store-scoped reads need both `entityId` and `storeId` filters; `rules.test.mjs` holds 104 cases.

## Follow-ups

- Done: override tokens are single-use (`usedTokens/{nonce}`: the request's `approvalToken` is spent in `whoAndWhere`, sale-line approvals inside the sale's transaction), and `pos-auth` locks a till for 15 minutes after 12 wrong PINs within 15 minutes, on top of the per-PIN lock-out.
- The `pos-doc` share link for a sale could carry a shorter life for receipts under R 50.
