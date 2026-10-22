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
| `supervisor` | 2 | All of the above, plus overrides (bigger discounts, voids before completion), opening and closing a register, stock counts, quarantine moves, receiving stock, transfers between stores, viewing suppliers and purchase orders |
| `manager` | 3 | All of the above, plus products, prices, suppliers, purchase orders (sending, cancelling), stock adjustments and posting stock takes, staff who are cashiers or supervisors, settings of their entities, enrolling devices |
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
| `TR` | stock transfer | `transferPrefix` |

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
invoicePrefix, creditNotePrefix, laybyPrefix, specialOrderPrefix, poPrefix, grvPrefix, transferPrefix,
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
specialOrder { minDepositPct, leadDays }
buying { updateCostsOnReceive }
loyalty { enabled, pointsPerRand, pointValueCents, minRedeemPoints, expiryMonths, tiers }
xero { autoDaily, accounts {…} }
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
onOrderQty (int: on open purchase orders, not yet received), avgCostCents (the weighted average cost: moved when stock comes in at a cost — a receipt, stock found — never by sales or counts),
lastMovementAt, lastCountedAt, rebuiltAt, + stamps (createdBy 'server')
```
R: members of the store. W: server only, in the same batch as the movement.
`onHandQty` always equals the sum of that item's movements in that store.

**`stockMovements/{id}`** — append only
```
entityId, storeId, productId, variantId, qty (int, signed: +in, −out),
reason ('sale'|'creditNote'|'receive'|'adjust'|'count'|'quarantine'|'transferOut'|'transferIn'|'layby'|'specialOrder'|'bundle'|'online'|'onlineRefund'),
code (adjustments: 'damaged'|'stolen'|'found'|'correction'|'sample'|'writeoff'|'other'), bucket ('onHand'|'quarantine'|'reserved'),
docType, docId, docNo, unitCostCents, note, byName (the approver), onHandAfter, + stamps, serverReceivedAt
```
R: members of the store. W: server only. Never updated or deleted.

**`stockTakes/{id}`** (the `pos-stock` function)
```
entityId, storeId, name, scope ('all'|'category'), category, status ('open'|'review'|'posted'|'cancelled'),
frozenAt, items [ { itemId, productId, variantId, name, sku, barcodes, frozenQty (on hand when frozen), countedQty (null until counted), countedBy, countedAt, costCents } ],
itemCount, countedItems, log [ { at, byName, itemId, qty, mode ('add'|'set'), deviceId } ] (every scan, from every phone),
varianceQty, varianceValueCents, openedBy, reviewedAt, reviewedBy, postedAt, approvedBy, movementCount, cancelledAt, + stamps, updatedAt
```
R: members of the store. W: server only. Opening freezes what the system
says is on hand (a supervisor); any member of the store counts from any
phone (scans add one, or a typed count sets it), merged live; review closes
the count; posting (a manager) writes one `count` movement per variance
against the frozen figure — sales during the count have already moved the
level — and stamps `lastCountedAt`; items not counted are left alone.
Adjustments (`adjust`, a manager) and quarantine moves (`move`, a
supervisor) are movements too; stock on hand is never typed over.

### Customers

**`customers/{customerId}`** (`storeId` = '') — the `pos-customer` function writes them
```
entityId, name, contact, phone, phoneKey (the cell number as 27…: one customer per number per company), email, emailKey, vatNo, address {…}, dob, tags [string], notes,
consent { whatsapp|sms|email: { granted (bool), at, byName, source ('till'|'office'|'import'|'customer') } }   // POPIA: their choice per channel, dated
accountEnabled (bool), creditLimitCents, storeCreditCents (server moves this), accountBalanceCents (server moves this: what they owe),
loyalty { points, lifetimeCents, tier, lots [ { points, left, earnedAt, expiresAt, saleId } ], lastEarnedAt },
stats { salesCount, spentCents, firstSaleAt, lastSaleAt },
mergedIds [customerId] (duplicates merged into this one: history is found through them), altPhones [phoneKey], mergedInto (customerId, when this one was merged away),
anonymised (bool), anonymisedAt, archived, + stamps, updatedBy, updatedAt
```
R: members of the entity. W: server only — `pos-customer` (`save` with the
number's uniqueness checked in the transaction, `consent`, `merge`,
`anonymise`, `adjustPoints`) and the sale core (credit, the account,
points, stats). Merging moves money, points, consent and history to the
kept profile; documents already issued stay as issued. Anonymising wipes
the personal details and frees the number; invoices keep their customer
snapshot as tax records. The export answers a POPIA access request with
the profile and history.

**`customerPhones/{entityId}_{phoneKey}`** → `{ customerId }`: the uniqueness index, server only.

**`loyaltyLedger/{id}`** — append only (server)
```
entityId, customerId, kind ('earn'|'redeem'|'expire'|'adjust'|'merge'), points (signed), balanceAfter, saleId, docNo, note, expiresAt, + stamps
```
R: members of the entity. Points: `settings.loyalty { enabled, pointsPerRand,
pointValueCents, minRedeemPoints, expiryMonths, tiers [ { name, fromCents (lifetime spend), multiplier } ] }`.
A sale with a customer earns `floor(rands paid other than with points ×
pointsPerRand × tier multiplier)` as a lot that expires `expiryMonths`
later; the `points` tender redeems oldest lots first (at least
`minRedeemPoints`); expired lots are swept whenever the balance is
touched. The sale carries `loyalty { earned, redeemed, balance, tier }`
for the receipt.

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
exchangeOf (the credit note an exchange spent), laybyOf (the lay-by a collection completes), specialOrderOf (the special order a hand-over completes),
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
method ('cash'|'card'|'eft'|'qr'|'voucher'|'storeCredit'|'account'|'points'|'creditNote'|'layby'|'specialOrder'), instalment (lay-bys and special orders: 0 = the deposit),
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

**`specialOrders/{id}`** — made-to-order goods, series `SO` from the entity's counter (the `pos-special` function; online only)
```
entityId, storeId, registerId, shiftId, seq, docNo, customerId (required), customerSnapshot,
lines [ as saleLines (made-to-order and non-stock items only), plus spec { model, size, fabric, colour, legs, notes, photo (JPEG data URL, shrunk by the till) } ],
lineCount, subtotalCents, lineDiscountCents, saleDiscountCents, totalCents, vatCents, vatRateBp, vatRegistered,
minDepositPct, minDepositCents, leadDays, depositCents, paidCents, balanceCents, paymentCount, lastPaidAt,
history [ { n (0 = the deposit), at, amountCents, methods, storeId, byName } ],
signoff { text (the specification read back and the no-change-of-mind clause), acceptedAt, signedBy, signature (PNG data URL), cashierUid, cashierName },
status ('quoted'|'depositPaid'|'inProduction'|'ready'|'delivered'|'collected'|'cancelled'),
statusHistory [ { status, at, byName, source ('till'|'factory'), note } ], updateDue (bool: a status changed and no message went yet),
updates [ { at, status, how, byName } ], lastUpdateAt, factoryRef (the factory's order numbers, filled in by the server), expectedAt (date), openedAt,
factory { companyId, companyName, customerId, orders [ { id, orderNo, lineNo, status } ], sentAt, lastCheckedAt, error } (once sent),
delivery { kind ('deliver'|'collect'), date, slot, address, phone, note, driverName, bookedAt, bookedBy } | null,
deliveryNote { signedBy, signature, at, byName, note, kind } | null,
completedAt, completedSaleId, completedDocNo, completedByUid, completedByName,
cancelledAt, cancelKind ('customer'|'store'|'other'), cancelReason, feeCents, feeReason, refunds [ { method, amountCents, ref } ], refundedCents,
cashierUid, cashierName, approvers, note, + stamps, updatedAt
```
R: members of the store. W: server only. The flow is quoted → deposit
paid (the deposit reaches the minimum; the order goes to the factory) →
in production → ready → delivered or collected; cancelled from any open
state by a manager (no fee before production starts; after it the deposit
covers the work, as the sign-off says). The deposit and the balance are
`payments` rows (`docType 'specialOrder'`), taken at any till. The
hand-over writes the final `sales` document paid by one `specialOrder`
tender (the sale carries `specialOrderOf`) and keeps the signed delivery
note. Nothing is reserved: the goods do not exist until made.

**The factory.** The POS and Factory Manager are separate systems in one
Firebase project; the POS server is the only bridge. When the deposit is
reached, `pos-special` writes the order into the linked factory company
(`settings/{entityId}.factory { companyId, companyName, linkedAt, linkedBy }`,
set by the owner under Admin → Settings → Factory): one
`companies/{companyId}/orders/pos-{specialOrderId}-{lineNo}` per line,
numbered from the factory's own sequence, with
`companies/{companyId}/customers/pos-{entityId}-{storeId}` — the *store*, in
group "POS stores" — as the customer. The order carries the SO number, the
specification, the price per piece, the expected date and the store's
address; the retail customer never goes across. The factory's status comes
back the same way (`factorySync`, and the `pos-factory-sync` schedule every
ten minutes, which also sends what is not there yet): in production →
`inProduction`, all lines done or dispatched → `ready`, with
`source: 'factory'` in the history. A cancellation at the till cancels the
factory orders not yet out of the door. Every status change marks
`updateDue` until the till sends the customer the WhatsApp update.

**`salesOrders/{saleId}`** — a sales order: made-to-order lines sold on an
ordinary sale (the `pos-sale` function writes it in the sale's transaction;
`pos-salesorder` moves it along). The sale is never touched again; this is
the live document beside it.
```
saleId, docNo (the invoice), seq, entityId, storeId, registerId, shiftId, customerId (required), customerSnapshot { name, phone, email },
lines [ { lineNo, productId, variantId, itemId, name, qty, unitPriceCents, netCents, note, spec { model, size, fabric, colour, legs, notes }, cancelledQty } ],
lineCount, totalCents, paidInFull (false when on account),
status ('open'|'inProduction'|'ready'|'delivered'|'collected'|'cancelled'), statusHistory [ { status, at, byName, source ('till'|'factory'), note } ],
updateDue, updates [ { at, status, how, byName } ], lastUpdateAt, expectedAt, openedAt, lastPaidAt,
factory { companyId, companyName, customerId, orders [ { id, orderNo, lineNo, status } ], sentAt, lastCheckedAt, error }, factoryRef,
handover { signedBy, signature, at, byName, note, kind } | null, completedAt, cancelledAt, cancelReason,
cashierUid, cashierName, note, + stamps, updatedAt
```
R: members of the store. W: server only. A made-to-order line on a sale
carries `spec` on its `saleLines` row too (and the spec is read back on the
line's note, so it prints). The sale needs a customer. The factory gets the
order the moment the sale is written, exactly as for a custom order, and
its status comes back the same way; the hand-over keeps the signed note
here (the invoice was written with the sale). A credit note on a
made-to-order line sets `cancelledQty`, cancels the sales order when every
line is back, and calls the factory order off.

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
entityId, name, contact, phone, email, accountNo, termsDays, leadDays, notes, archived, + stamps, updatedBy, updatedAt
```
R: supervisor and up, in the entity. W: manager or owner.

**`purchaseOrders/{id}`** — series `PO`
```
entityId, storeId (the store it is for), seq, docNo, supplierId, supplierName, supplierSnapshot { contact, phone, email },
lines [ { productId, variantId, itemId, sku, name, barcode, qty, unitCostCents (ex VAT), receivedQty } ],
subtotalCents, vatRateBp, vatCents, totalCents, status ('draft'|'sent'|'part'|'received'|'cancelled'),
expectedAt, note, sentAt, sentBy, sentHow, grvs [ { id, docNo, at } ], receivedAt, cancelledAt, cancelledBy, cancelReason, + stamps, updatedBy, updatedAt
```
R: supervisor and up, in the store. W: manager or owner write the draft
(no number); `pos-buy` sends it (the number from the entity's counter,
`onOrderQty` up on each line's level), receives against it (`receivedQty`,
`part`/`received`) and cancels it (what was still open comes off order).
A sent order is served to the supplier from a signed `pos-doc` link as an
A4 page to print or save as PDF, sent by email or WhatsApp. Lines can be
suggested from the low-stock list: available + on order ≤ reorder level,
the reorder quantity each, the supplier's products only.

**`goodsReceived/{id}`** — immutable, series `GRV` (`pos-buy receive`)
```
entityId, storeId, seq, docNo, purchaseOrderId, purchaseOrderDocNo ('' for a direct receipt), supplierId, supplierName,
supplierInvoiceNo, invoiceDate, lines [ { productId, variantId, itemId, name, sku, barcode, qty, unitCostCents, landedShareCents, landedCents, landedUnitCents } ],
lineCount, subtotalCents, landed { freightCents, dutyCents, otherCents, totalCents, method ('value'|'qty') }, totalCostCents,
updateCosts (bool), costChanges [ { itemId, name, fromCents, toCents } ], receivedBy, note, + stamps, serverReceivedAt
```
R: supervisor and up. W: server only. One `receive` movement per line at
the landed unit cost (freight, duty and other charges spread over the
lines by value or by quantity), which moves the level's weighted average
cost; with `updateCosts` the product's or variant's `costCents` becomes
that average. Against a PO never more than is still open; the rest is a
direct receipt. Labels print for what came in.

**`transfers/{id}`** — series `TR` (`pos-buy`)
```
entityId, storeId (= fromStoreId), fromStoreId, toStoreId, fromStoreName, toStoreName, seq, docNo,
lines [ { productId, variantId, itemId, name, sku, barcode, qty, receivedQty, lostQty, unitCostCents (the sender's average) } ],
lineCount, units, valueCents, status ('inTransit'|'received'|'cancelled'), sentAt, sentBy, receivedAt, receivedBy,
closedShort (bool), lostUnits, note, cancelledAt, cancelledBy, + stamps, serverReceivedAt, updatedAt
```
R: supervisor and up at either store. W: server only. Sending writes
`transferOut` at the sender at once (never more than available); the
goods are in transit until the other store receives them (`transferIn`
at the sender's cost, into the receiver's average), in part if need be;
closing short records `lostQty` — the stock already left the sender, so
nothing is invented at the receiver. Cancelling before anything arrived
puts the stock back at the sender.

### Reports and Xero

Reports are not stored: `pos-report` aggregates them on the server from
the finished documents (sales, saleLines, payments, creditNotes, shifts'
Z-reports, stockLevels, stockMovements, auditLog, laybys, specialOrders,
customers) for a company, a store or all its stores, a date range, a
member of staff (`cashierUid`) and a channel (`sales.source`: till, office,
online). The owner's dashboard is today against the same weekday last
week, per store. Date ranges use the indexes `(entityId, storeId, <date>)`
on each collection.

**`xeroJournals/{entityId}_{date}`** — the daily sales journal (`pos-xero`)
```
entityId, storeId (''), date, narration, lines [ { key, account, description, cents (+ debit, − credit) } ],
debitsCents, creditsCents, counts { sales, creditNotes, payments }, unbalanced (bool), accounts { the codes used },
status ('built'|'posted'|'failed'), xeroId, error, postedAt, postedBy, builtAt, + stamps, updatedAt
```
R: managers and the owner of the entity. W: server only. Built from the
day's sales (revenue ex VAT and VAT output credited, cash rounding),
credit notes (reversed), every tender by method (bank and clearing
accounts debited; store credit, vouchers, points, lay-by and custom-order
deposits and the account book as liabilities), cancelled lay-bys and
orders (deposits released, penalties as income) and vouchers sold (a
liability, not revenue). Rebuilt until posted. Exported as Xero's
manual-journal CSV; posted through the Accounting API when the company is
connected (tokens under `pos-<entityId>` in the Xero token store, OAuth
through `XERO_POS_REDIRECT_URI`); a schedule at 01:30 UTC builds and posts
yesterday's for every company with `settings.xero.autoDaily`.
`settings.xero { autoDaily, accounts { sales, vat, cash, card, eft, qr, account, storeCredit, voucher, layby, specialOrder, points, exchange, rounding, penalty }, connectedTenant, connectedAt, lastPushAt, lastError }`.

### Shopify

The POS is master for stock; the shop is master for content; the link
between them is the SKU. `pos-shopify` holds it all; the schedule
`pos-shopify-sync` pushes what is still queued every ten minutes.

- **`shopifySecrets/{entityId}`** — `domain, clientId, clientSecret` (a Dev Dashboard app; the client-credentials grant mints short-lived tokens). No client access at all. Webhooks are verified against the client secret.
- `settings.shopify { connected, domain, shopName, locations [ { id, name } ], locationByStore { storeId: locationGid }, defaultStoreId, pickupByTitle { shippingTitle: storeId }, pushStock, pullOrders, syncCodes, syncCustomers, linkedAt, lastSyncAt, lastError, customersPushedAt }`.
- Products and variants gain `shopifyProductId, shopifyVariantId, shopifyInventoryItemId, linkedAt`; `link` matches the shop's variants by SKU (the variant's, else the product's) and pulls title, description and images (`contentFrom: 'shopify'`); prices stay the till's.
- **`shopifyQueue/{entityId}_{storeId}_{itemId}`** — `availableQty (on hand − reserved), attempts, nextAt, lastError`: written by the sale core after every commit that moved a level, flushed at once within a short budget and by the schedule with back-off (`inventorySetQuantities`, name `available`, per mapped location).
- **`onlineOrders/{entityId}_{shopifyOrderId}`** (store members, supervisors and up read) — `orderNo, orderedAt, financialStatus, fulfillmentStatus, pickup (the shipping line says pick up / collect, or is mapped), storeId, customer, address, lines [ { title, sku, qty, priceCents, lineId, productId, variantId, itemId, tracked } ], totalCents, unmapped, status ('new'|'ready'|'collected'|'cancelled'|'refunded'), stock ('deducted'|'reserved'|'released'|'none'), refunds [ { id, at, lines } ]`. `orders/create` deducts (paid) or reserves (unpaid) at the mapped store with `online` movements; `orders/cancelled` puts it back; `refunds/create` restocks the refunded lines (`onlineRefund`); marking collected fulfils the order on Shopify.
- **`discountCodes/{entityId}_{CODE}`** (entity members read) — `code, title, kind ('percentage'|'fixed'), value, valueCents, startsAt, endsAt, active, wholeSale`: pulled from the shop's active code discounts; the till applies one to a sale (`sales.saleDiscountCode`) and the server honours it without a PIN, never more than the code gives.
- Customers who opted in to email or SMS marketing are pushed with that consent (`customerCreate`/`customerUpdate`, matched by email or phone) and gain `shopifyCustomerId, shopifyPushedAt`.
- **`shopifySync/{id}`** — the log: `kind ('stock'|'order'|'cancel'|'refund'|'codes'|'customers'|'link'), status ('ok'|'retry'|'failed'), message, count, docNo`.

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
