# Retail POS — data model

The point of sale for the retail group (furniture, baby and nursery, reptile
supplies). One app, one Firebase project, several legal entities.

This document is the contract between the till, the server functions and the
database rules. Change it first; then the code.

## Ground rules (from the brief)

1. Money is stored as **whole cents** (`…Cents` fields are integers). Never a
   float, never a rand amount.
2. Prices are **VAT inclusive**. VAT on a line is `round(lineTotalCents × rateBp
   ÷ (10000 + rateBp))`, which at 15% is `round(price × 15 ÷ 115)`. The rate
   is a whole number of basis points (`1500` = 15%) from the entity's settings,
   with an effective-from date, so a rate change applies from a day without
   touching old documents.
3. **Entities** are the legal companies: own name, registration number, VAT
   number (or not registered), document prefixes and counters. **Stores**
   belong to an entity; **registers** belong to a store; **devices** are
   enrolled against a register.
4. A finished **sale, refund or credit note is never changed**. A correction is
   a new document that points at the one it corrects.
5. **Stock on hand is the sum of `stockMovements`.** `stockLevels` is a cache
   the server keeps alongside each movement, and can rebuild from the
   movements at any time. Nothing else writes it.
6. **Every record** carries `entityId`, `storeId`, `createdBy`, `createdAt`
   and `deviceId`. Records that belong to no store (a product, a setting)
   carry `storeId: ''`.
7. **Document numbers run per entity and per series with no gaps.** A device
   is issued a block of numbers to use offline; a number the device never
   uses is written to `voidedNumbers` when its block closes, so every number
   in the series has either a document or a void.
8. **Totals, VAT and numbers are checked on the server** before a finished
   document exists. The database rules refuse those collections from any
   browser; only the Netlify functions (with the admin key) write them.
9. **Rules restrict every user to their entity and their allowed stores**,
   by role.

## Where it lives

```
pos/{groupId}                       the retail group (one per deployment)
pos/{groupId}/<collection>/{id}     everything below
```

`groupId` is a constant in the app's config. Nothing in Factory Manager's
`companies/…` or the existing `users/{uid}` is touched: that `users` doc is
writable by its own login, so a POS role could never safely live there.

## Roles

| Role | Rank | May |
|---|---|---|
| `cashier` | 1 | Ring up sales, refunds within their discount limit, take lay-by payments, add customers |
| `supervisor` | 2 | All of the above, plus overrides (bigger discounts, voids before completion), opening and closing a register, stock counts, viewing suppliers and purchase orders |
| `manager` | 3 | All of the above, plus products, prices, suppliers, purchase orders, receiving stock, staff who are cashiers or supervisors, settings of their entities, enrolling devices |
| `owner` | 4 | Everything in every entity and store, plus entities, stores, registers and staff of any role |

A user's reach is `entityIds` and `storeIds` on their `users` record. An owner
has every entity and store.

## Stamps on every record

```
entityId    string   the legal entity ('' never; an entity's own record carries its own id)
storeId     string   the store, or '' when the record belongs to no store
createdBy   string   the uid of the person (the till's signed-in PIN user, or the login)
createdAt   string   ISO 8601 from the device clock (a sale made offline keeps its true time)
deviceId    string   the enrolled device, or 'web' for an office login, or 'server' for a function's own writes
```

Records a browser may update also carry `updatedBy` and `updatedAt`. The
server adds `serverReceivedAt` to every document it writes, which is the
trusted clock.

Rules enforce on every browser create: `createdBy == auth.uid`, all five stamp
fields present. On every browser update: the five stamps unchanged.

## Numbering

| Series | Document | Prefix field on the entity |
|---|---|---|
| `INV` | sale (a tax invoice, or an invoice when not VAT registered) | `invoicePrefix` |
| `CN` | credit note | `creditNotePrefix` |
| `LB` | lay-by | `laybyPrefix` |
| `SO` | special order | `specialOrderPrefix` |
| `PO` | purchase order | `poPrefix` |
| `GRV` | goods received | `grvPrefix` |

`docNo` = prefix + `-` + the sequence padded to 6 digits (`BF-000123`). The
sequence `seq` is also stored as a number so gaps can be audited with a query.

- `counters/{entityId}_{series}` holds `next`. Server only.
- `numberBlocks/{id}`: the server issues a device `from`..`to` for a series
  (default 50 numbers; refilled when fewer than 10 remain and the device is
  online). The device stores its blocks in IndexedDB and numbers offline
  sales from them. `usedUpTo` moves as the server accepts documents.
- When fewer than `refillBelow` numbers remain, the server issues the till
  its next block early, so it always has spare numbers offline.
- A queued offline sale the server refuses on replay (the price changed
  meanwhile, say) gets its number voided (`voidNumber`, `reason: 'refused…'`)
  and is kept on the till for a manager to see. A till that is retired has
  the unused remainder of its blocks voided (`reason: 'till retired'`).

## Collections

Access is written as **R:** who may read, **W:** who may write from a browser.
"Server" means only the Netlify functions, with the admin key. All reads are
further limited to the reader's entities and stores unless noted.

### Group and people

**`pos/{groupId}`** — `{ name, createdAt }`. R: members. W: server.

**`users/{uid}`**
```
email, name, role ('cashier'|'supervisor'|'manager'|'owner'), active (bool),
entityIds [string], storeIds [string], defaultStoreId,
pinSet (bool: a PIN exists; the hash is not here), pinChangedAt,
+ stamps
```
R: own record always; managers and owners read all. W: owner any; a manager
may create or update users with role `cashier` or `supervisor` whose
`entityIds` and `storeIds` are within the manager's own. Nobody changes their
own `role`, `active`, `entityIds` or `storeIds`. Delete never (set `active:
false`).

**`pinHashes/{uid}`** — `{ hash, salt, algo: 'pbkdf2-sha256', iterations, failedCount, lockedUntil }`. R/W: server only. A PIN is checked by the function; a registered device also keeps a local, salted copy for the staff of its store so a PIN works offline (step 2).

**`devices/{deviceId}`**
```
label, entityId, storeId, registerId, enrolledBy, enrolledAt, active,
lastSeenAt, appVersion, + stamps
```
R: members of the store. W: server (enrolment is a function: a manager
types a one-time code on the device).

### Entities, stores, registers, settings

**`entities/{entityId}`** (`entityId` = its own id, `storeId` = '')
```
legalName, tradingName, regNo, vatRegistered (bool), vatNo ('' when not registered),
invoicePrefix, creditNotePrefix, laybyPrefix, specialOrderPrefix, poPrefix, grvPrefix,
address { line1, line2, city, code }, phone, email, website,
bank { name, accountName, accountNo, branchCode }, logoUrl, active, + stamps
```
R: members of the entity. W: owner. Delete never.

**`stores/{storeId}`** (`storeId` = its own id)
```
entityId, name, address {…}, phone, email, paymentMethods [ 'cash'|'card'|'eft'|'qr'|'voucher'|'storeCredit'|'account' ],
receiptHeader, receiptFooter (override the entity's when set), printAgentUrl (a local print agent the till posts ESC/POS bytes to), active, + stamps
```
R: members of the store. W: owner.

**`registers/{registerId}`**
```
entityId, storeId, name, active, currentShiftId ('' when closed), + stamps
```
R: members of the store. W: owner or manager of the entity, except
`currentShiftId`, which only the server moves.

**`settings/{entityId}`** (`storeId` = '')
```
vat {
  rates [ { rateBp, effectiveFrom 'YYYY-MM-DD' } ]      // rate in force = the latest effectiveFrom <= the document date
}
receipt { header, footer, returnPolicy }
discounts { maxPctByRole { cashier, supervisor, manager, owner } }    // whole percents
cash { varianceLimitCents }                                            // beyond this a close needs a manager
layby { minDepositPct, termDays (the longest), penaltyPct (≤ 1), frequency, reminderDays }
session { idleLogoutMinutes, pinLength (4..6) }
numbering { blockSize, refillBelow }
reports { phone, email }                                               // where the daily summary goes (the owner)
returns { windowDays, reasons [string] }
+ stamps
```
R: members of the entity. W: manager or owner of the entity.

### Catalogue and stock

**`products/{productId}`** (`storeId` = '')
```
entityId, sku, name, description, brand, category, supplierId,
type ('stock'|'nonstock'|'mto'|'bundle'|'voucher'),
vatClass ('standard'|'zero'|'exempt'),
trackStock (bool), costCents, priceCents, barcodes [string], images [url],
options [ { name, values [string] } ]            // up to 3; present when hasVariants
hasVariants (bool),
storePrices { storeId: priceCents },              // per-store override of priceCents
bundle [ { productId, variantId, qty } ],         // type 'bundle' only
reorderLevel, reorderQty, archived (bool), shopifyProductId, + stamps, updatedBy, updatedAt
```
R: members of the entity. W: manager or owner. Delete never (archive). A
price or cost change also appends an `auditLog` entry (`action:
'product.price'`) from the browser.

**`variants/{variantId}`** (`storeId` = '')
```
entityId, productId, sku, name ('Red / Large'), optionValues { optionName: value },
barcodes [string], costCents, priceCents (null = the product's),
storePrices { storeId: priceCents }, images [url], archived, shopifyVariantId, + stamps
```
R / W: as products.

An **item** is what stock is held for: the variant when the product has
variants, else the product. `itemId` = `variantId || productId`.

**`stockLevels/{storeId}_{itemId}`**
```
entityId, storeId, productId, variantId ('' when none), onHandQty (int),
quarantineQty (int: returns kept apart until inspected; its own movement bucket),
reservedQty (int: open lay-bys and special orders holding stock; its own movement bucket `reserved`; the till sells on hand less reserved),
lastMovementAt, lastCountedAt, rebuiltAt, + stamps (createdBy 'server')
```
R: members of the store. W: server only, in the same batch as the movement.
`onHandQty` always equals the sum of that item's movements in that store.

**`stockMovements/{id}`** — append only
```
entityId, storeId, productId, variantId, qty (int, signed: +in, −out),
reason ('sale'|'creditNote'|'receive'|'adjust'|'count'|'transferOut'|'transferIn'|'layby'|'specialOrder'|'bundle'),
docType, docId, docNo, unitCostCents, note, + stamps, serverReceivedAt
```
R: members of the store. W: server only. Never updated or deleted.

### Customers

**`customers/{customerId}`** (`storeId` = '')
```
entityId, name, contact, phone, email, vatNo, address {…},
accountEnabled (bool), creditLimitCents, storeCreditCents (server moves this), accountBalanceCents (server moves this: what they owe),
notes, archived, + stamps, updatedBy, updatedAt
```
R: members of the entity. W: any member of the entity may create and update,
except `storeCreditCents` and `accountBalanceCents` (the server only) and
`accountEnabled` and `creditLimitCents` (a manager). Delete never.

### Sales and money

**`sales/{saleId}`** — immutable. `saleId` is made on the device
(`<deviceId>-<time36>-<rand>`), so a sale the till sends twice after a dropped
connection is written once.
```
entityId, storeId, registerId, shiftId, deviceId,
series 'INV', seq (int), docNo, blockId,
customerId ('' for walk-in), customerSnapshot { name, vatNo, address },
lineCount, subtotalCents, lineDiscountCents, saleDiscountCents, saleDiscountPct,
totalCents, vatCents, vatRateBp, vatRegistered (bool),
tenderedCents, changeCents, roundingCents (cash rounded to 10c: the difference, recorded, never hidden), paymentMethods [string],
cashierUid, cashierName, overrideUid, overrideName, overrideReason,
note, source ('till'|'online'|'import'), clientCreatedAt, serverReceivedAt, verified: true,
exchangeOf (the credit note an exchange spent), laybyOf (the lay-by a collection completes),
+ stamps
```
R: members of the store. W: server only.

**`saleLines/{saleId}_{lineNo}`** — immutable
```
entityId, storeId, saleId, docNo, lineNo (1..n),
productId, variantId, itemId, sku, name, type, fulfilment ('stock'|'mto'|'special'|'service'),
qty (int), unitPriceCents, discountCents, lineTotalCents,
vatClass, vatRateBp, vatCents, costCents (snapshot), trackStock,
+ stamps
```
R: members of the store. W: server only.

**`payments/{id}`** — immutable. One row per tender, on any document.
```
entityId, storeId, registerId, shiftId,
docType ('sale'|'layby'|'specialOrder'|'refund'|'account'), docId, docNo,
method ('cash'|'card'|'eft'|'qr'|'voucher'|'storeCredit'|'account'|'creditNote'|'layby'), instalment (lay-bys: 0 = the deposit),
amountCents (int; a refund is negative), ref (card slip no., EFT ref, voucher code, the credit note or lay-by number),
+ stamps, serverReceivedAt
```
R: members of the store. W: server only.

**`vouchers/{code}`** — a gift voucher, keyed by its code
```
entityId, storeId (where sold), amountCents, balanceCents, status ('open'|'used'|'void'),
soldSaleId, soldDocNo, soldAt, expiresAt, customerId, uses [ { saleId, docNo, amountCents, at } ], + stamps
```
R: members of the entity (the till checks a code). W: server only: created
when a voucher product is sold, reduced when one pays for a sale.

**`creditNotes/{id}`** — immutable, series `CN` (the `pos-return` function; numbered straight from the entity's counter inside the transaction, since returns need the office line)
```
entityId, storeId, registerId, shiftId, seq, docNo,
saleId, saleDocNo ('' for a return without a receipt), noReceipt (bool), customerId, customerSnapshot,
lines [ { saleLineNo, productId, variantId, itemId, name, qty, soldQty, unitPaidCents (the price actually paid, after line and sale discounts),
          lineTotalCents, vatRateBp, vatCents (the VAT reversed), reason, disposition ('restock'|'quarantine'|'writeoff'), type, fulfilment } ],
lineCount, totalCents, vatCents, vatRateBp (the sale’s rate, or today’s without a receipt), vatRegistered, refunds [ { method, amountCents, ref } ], refundedCents,
exchangeSaleId, exchangeUsedCents (the credit spent on the new sale, written in the same transaction),
cashierUid, cashierName, approvers [ { uid, name } ], reasonSummary, clientCreatedAt, serverReceivedAt, + stamps
```
R: members of the store. W: server only. Restocked goods come back through
`stockMovements` (`reason: 'creditNote'`, bucket `onHand`); quarantined ones
go to the level's `quarantineQty` (bucket `quarantine`), not sellable; a
write-off moves nothing. Never more than was sold on a line (earlier credit
notes on the sale are summed). Outside the entity's return window, or a
made-to-order item, or a return without a receipt, needs a manager's PIN; a
return without a receipt is store credit only and needs the customer.

**`refunds/{id}`** — immutable. The money going back for a credit note (a negative `payments` row is written alongside, so the shift's cash-up stays right; `storeCredit` moves the customer's `storeCreditCents` up).
```
entityId, storeId, registerId, shiftId, creditNoteId, creditNoteDocNo,
method ('cash'|'card'|'eft'|'storeCredit'), amountCents (positive), ref,
+ stamps, serverReceivedAt
```
R: members of the store. W: server only. It also writes the matching negative
`payments` row (so a shift's cash is one sum) and, for `storeCredit`, moves
the customer's `storeCreditCents`.

**`laybys/{id}`** — series `LB`, numbered from the entity's counter inside the transaction (the `pos-layby` function; online only)
```
entityId, storeId, registerId, shiftId (where opened), seq, docNo, customerId (required), customerSnapshot,
lines [ as saleLines: prices and discounts checked at opening, then fixed ], lineCount, subtotalCents, lineDiscountCents,
saleDiscountCents, totalCents, vatCents, vatRateBp, vatRegistered,
minDepositPct, minDepositCents, depositCents, paidCents, balanceCents, paymentCount, lastPaidAt,
history [ { n (0 = the deposit), at, amountCents, methods, storeId, byName } ],
termDays, frequency ('weekly'|'fortnightly'|'monthly'), openedAt, dueAt, schedule [ { n, dueAt, amountCents } ],
penaltyPct (≤ 1), penaltyCapCents (1% of the full price),
agreement { text, acceptedAt, signedBy, signature (PNG data URL), cashierUid, cashierName },
status ('open'|'completed'|'cancelled'), reminders [ { at, kind ('due'|'overdue'|'ready'), how, byUid, byName } ], lastReminderAt,
completedAt, completedSaleId, completedDocNo, completedByUid, completedByName,
cancelledAt, cancelKind ('customer'|'lapsed'|'death'|'hospitalisation'|'store'), cancelReason, penaltyCents,
penaltyBreakdown { fullPriceCents, paidCents, penaltyPct, computedCents, capPct, capCents, chargedCents, waivedWhy, refundCents },
refunds [ { method, amountCents, ref } ], refundedCents, cashierUid, cashierName, approvers, note, + stamps, updatedAt
```
R: members of the store. W: server only. Section 62 of the Consumer
Protection Act and regulation 35, as `pos/js/layby-terms.js` applies them:
the penalty is at most 1% of the full price, is written into the agreement
before the customer signs, and is never charged on death or hospitalisation
(nor when the store cannot supply). Opening reserves the goods (`stockMovements`
bucket `reserved`, `stockLevels.reservedQty`); the deposit and every
instalment are `payments` rows (`docType 'layby'`, the till and shift that
took the money, at any till of the company). Collection writes the final
`sales` document paid by one `layby` tender (so no cash is counted twice),
with the sale's own stock movement and the reservation released; the sale
carries `laybyOf`. Cancellation releases the stock, writes `refunds` and
negative `payments` (`docType 'refund'`) for what goes back, and keeps the
written penalty breakdown. Reminders are logged here and sent from the
till by WhatsApp.

**`specialOrders/{id}`** — live until closed, series `SO`
```
entityId, storeId, registerId, seq, docNo, blockId, customerId (required),
lines [ { productId, variantId, itemId, name, qty, unitPriceCents, lineTotalCents, vatRateBp, vatCents, source ('supplier'|'factory') } ],
totalCents, depositCents, paidCents, balanceCents,
supplierId, purchaseOrderId, factoryOrderRef, expectedAt,
status ('ordered'|'received'|'collected'|'cancelled'), completedSaleId, + stamps, updatedAt
```
R: members of the store. W: server only.

**`shifts/{id}`** — one register session (the `pos-shift` function)
```
entityId, storeId, registerId, deviceId, status ('open'|'closed'),
openedBy, openedByName, openedAt, openingFloat { denoms { '20000': 2, … }, totalCents },
closedBy, closedByName, closedAt, countedCash { denoms, totalCents },
countedByMethod { cash, card, eft, qr, voucher, storeCredit, account },     what was counted or typed at close (null = not counted)
expectedByMethod { … }                                                     the server's own sums: float + cash sales + cash in − cash out; the other methods from payments
varianceByMethod { … }, varianceCents (cash), varianceApprovedBy { uid, name } (a manager, when over the limit), closingNote,
salesCount, salesTotalCents, zReport { the whole closing picture, kept as it was },
+ stamps, updatedAt
```
R: members of the store. W: server only. A till with a register sells only
while its shift is open; the sale and its payments carry `shiftId`. The till's
number block is not touched by a close (it carries on next shift); the unused
remainder is voided only when the till is retired.

**`cashMovements/{id}`** — cash in or out of the drawer during a shift
```
entityId, storeId, registerId, shiftId, kind ('in'|'out'), amountCents, reason,
actorUid, actorName, approvedBy { uid, name } (a supervisor or higher when the actor is a cashier), + stamps, serverReceivedAt
```
R: members of the store. W: server only.

### Buying

**`suppliers/{id}`** (`storeId` = '')
```
entityId, name, contact, phone, email, accountNo, termsDays, notes, archived, + stamps, updatedBy, updatedAt
```
R: supervisor and up, in the entity. W: manager or owner.

**`purchaseOrders/{id}`** — series `PO`
```
entityId, storeId (the store it is for), seq, docNo, supplierId, supplierName,
lines [ { productId, variantId, itemId, sku, name, qty, unitCostCents, receivedQty } ],
totalCostCents, status ('draft'|'sent'|'part'|'received'|'cancelled'),
expectedAt, sentAt, note, + stamps, updatedBy, updatedAt
```
R: supervisor and up, in the store. W: manager or owner may create and edit
while `status` is `draft`; the number is issued by the server when it is
sent; `part`, `received`, `receivedQty` are server only.

**`goodsReceived/{id}`** — immutable, series `GRV`
```
entityId, storeId, seq, docNo, purchaseOrderId, purchaseOrderDocNo, supplierId,
supplierInvoiceNo, lines [ { productId, variantId, itemId, name, qty, unitCostCents } ],
totalCostCents, receivedBy, + stamps, serverReceivedAt
```
R: supervisor and up. W: server only (writes the stock movements, moves the
PO's `receivedQty`, and updates `costCents` on the item when the setting says so).

### Audit

**`auditLog/{id}`** — append only
```
entityId, storeId, action (e.g. 'login.pin', 'override.discount', 'product.price', 'settings.change', 'user.role', 'shift.close.variance'),
docType, docId, docNo, actorUid, actorName, overrideUid, overrideName,
details { … what changed: before/after for a price, the pct for a discount },
+ stamps, serverReceivedAt (when the server wrote it)
```
R: manager and owner, in the entity. W: any member may **create** one with
`actorUid == auth.uid`; the server writes the ones that need it (a PIN
override logs both people). Never updated or deleted.

### Numbering (server only)

**`counters/{entityId}_{series}`** — `{ entityId, series, next }`. No browser access.

**`numberBlocks/{id}`**
```
entityId, storeId, series, deviceId, registerId, from, to, usedUpTo, issuedAt, closedAt, + stamps
```
R: members of the store (a device reads its own). W: server.

**`voidedNumbers/{id}`**
```
entityId, storeId, series, seq, docNo, blockId, deviceId, reason ('unused at close'|'refused'|'block replaced'), + stamps
```
R: manager and owner. W: server.

## Queries and indexes

Every list query from a browser must filter by `entityId`, and for
store-scoped collections also by `storeId`, because that is how the rules
prove the reader is allowed each row. Composite indexes needed
(`firestore.indexes.json`):

| Collection | Fields |
|---|---|
| sales | entityId, storeId, clientCreatedAt ↓ |
| sales | entityId, seq ↓ (gap audit) |
| sales | entityId, customerId, clientCreatedAt ↓ |
| saleLines | entityId, storeId, productId, createdAt ↓ |
| saleLines | saleId, lineNo ↑ |
| payments | shiftId, method ↑ |
| payments | entityId, storeId, createdAt ↓ |
| stockMovements | storeId, productId, variantId, createdAt ↓ |
| stockMovements | entityId, docType, docId ↑ |
| stockLevels | entityId, storeId, onHandQty ↑ (low stock) |
| creditNotes | entityId, storeId, clientCreatedAt ↓ |
| creditNotes | entityId, saleId ↑ |
| laybys | entityId, storeId, status, dueAt ↑ |
| laybys | entityId, customerId, status ↑ |
| specialOrders | entityId, storeId, status, expectedAt ↑ |
| shifts | entityId, registerId, status ↑ |
| shifts | entityId, storeId, openedAt ↓ |
| purchaseOrders | entityId, storeId, status, createdAt ↓ |
| products | entityId, archived, name ↑ |
| products | entityId, category, name ↑ |
| variants | entityId, productId, archived ↑ |
| customers | entityId, archived, name ↑ |
| auditLog | entityId, createdAt ↓ |
| auditLog | entityId, docType, docId, createdAt ↓ |
| numberBlocks | deviceId, series, closedAt ↑ |
| devices | entityId, storeId, active ↑ |
| users | entityIds (array), role ↑ |

Single-field lookups (`barcodes array-contains`, `sku ==`, `docNo ==`) use the
automatic indexes.

## How a sale is written (the `pos-sale` function, `commit`)

The till sends the cart and the tenders. The server, in one transaction:

1. checks who is asking (the signed-in cashier, and the till by its secret)
   and that the store, register and entity are theirs;
2. prices every line itself from the catalogue (the store's price, or the
   approved override), checks each discount against the cashier's limit or
   its approval token, recomputes the totals at the VAT rate in force on the
   sale date, and refuses the sale if the till's totals differ by a cent;
3. checks the tenders cover the total (change only on cash; cash may be
   rounded to 10c, the difference recorded), the customer's store credit or
   account, and any voucher's balance;
4. takes the next number from the till's block (issuing a block first when it
   has none; a number the till chose offline must be inside its block and
   unused), and writes the sale, its lines, the payments, a stock movement
   and level change per tracked item, the customer's credit or balance, any
   voucher sold or used, the block's `usedUpTo`, and an audit row;
5. answers with the sale as written. The same `saleId` sent again returns the
   same answer and writes nothing.

## Offline

The till keeps in IndexedDB: its number blocks, an **outbox** of finished
documents not yet accepted by the server (each with its `saleId`, so a resend
is harmless), the catalogue and stock levels it last read, and the PIN cache
for its store's staff. Firestore's own offline persistence covers the reads.
A document in the outbox is "pending" on the till until the server's answer
comes back; the server's answer, not the device, makes it final.
