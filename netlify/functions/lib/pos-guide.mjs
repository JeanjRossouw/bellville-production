// The retail POS guide the in-app assistant answers from: what each screen
// does, who may do what, the rules the system keeps, and how to read the
// figures when planning. Plain words; the screens are named as the tabs are.
export const GUIDE = `
# The retail POS (the "till")

One app for a group of retail companies ("companies"), each with its own stores, registers (tills) and numbering. Prices include VAT (15%); money is always exact cents; finished documents (sales, credit notes, refunds) are never edited — a mistake is corrected with a new linked document (a credit note, a new sale). Stock on hand is the sum of every movement, never typed over.

## Signing in and roles
- Office staff sign in with email and password. A till is enrolled once by a manager (Admin → Devices) and after that staff sign in with their PIN. A quiet till locks after the minutes set in Settings; "My PIN" changes your own PIN.
- Roles, lowest to highest: cashier, supervisor, manager, owner. Each role may give discounts up to its limit (Settings → Discounts). When something needs a higher role, the app asks for that person's PIN on the spot (a "manager override"); the override is recorded with both names in the audit log.
- Cashier: sells, takes payments, parks sales, returns within the window, lay-by instalments, custom-order payments. Supervisor: cash in/out, quarantine moves, order status steps, sends an order to the factory, sees Stock, Buying and Online. Manager: stock adjustments, stock-take posting, returns outside the window, cancellations, register closes over the limit, staff PINs, Reports, Admin settings. Owner: companies, stores, Shopify, Xero, the factory link, everything.

## Sell (the sale screen)
- Scan a barcode anywhere, or search, or tap a favourite / category tile. Made-to-order items show "made to order"; out-of-stock items say so.
- Each line: quantity, a discount (with a reason; over your limit asks for a PIN), a price change (manager's PIN), a note. On a made-to-order line the note button opens the specification (model, size, fabric, colour, legs, notes for the maker).
- Customer: tap "Add a customer" to pick one by name or cell number, or quick-add with the cell number (and marketing consent). Needed over R 5 000 (a full tax invoice needs the customer's name and address), for lay-bys, accounts, custom orders and sales orders.
- Buttons: Pay (opens the payment screen), Park (keep the sale for later; Recall brings it back), Lay-by, Custom order. A voided line or sale is recorded with its reason.
- Pay: the store's methods — cash (rounded to 10c, change shown), card (last 4 digits), EFT (paid or awaiting), QR, gift voucher by code, store credit, loyalty points, on account (within the customer's limit), split any way. The slip or tax invoice prints, or goes by WhatsApp/email as a link. Under R 50 a till slip; to R 5 000 an abridged tax invoice; above, a full tax invoice.
- A register till sells only while its shift is open (Register tab). Offline: sales still go through with the next number from the till's block and sync when the line is back; a banner counts what is waiting.

## Sales
- Every sale of the store, newest first; open one to reprint (marked COPY), share the link, or start a return from it.

## Returns
- Find the sale by scanning the receipt barcode, by number, by customer or by day. Tick the lines and quantities (never more than was sold). Refund at the price actually paid, VAT reversed; by cash, card, EFT or store credit. Reason codes; restock, quarantine or write-off.
- Outside the return window (Settings), made-to-order goods and no-receipt returns (store credit only, customer required) need a manager's PIN. The credit note is numbered and printed. An exchange rings the new items up with the credit as the first payment, in one go.

## Lay-bys (CPA section 62)
- From the cart with a customer: minimum deposit %, term, instalment schedule, the agreement with the cancellation penalty (at most 1% of the price, never on death or hospitalisation) signed on the screen. Stock is reserved. Instalments at any till; reminders by WhatsApp; collection when paid writes the tax invoice; cancellation by a manager with the refund shown.

## Custom orders (made to order, with a quote and deposit)
- From the cart with a made-to-order item and a customer: the specification per item (with a photo), the sign-off the customer signs (no change of mind once in production), a deposit (the minimum % in Settings). Under the minimum it stays "Quoted"; reaching it sends the order to the factory. The balance can be paid at any till; WhatsApp updates at each step; delivery or collection booked; the hand-over writes the tax invoice and keeps the signed delivery note. A manager cancels (no fee before production; after it the deposit covers the work).
- The factory: when the company is linked to a Factory Manager company (Admin → Settings → Factory), the order goes into the factory's own orders by itself with the store as the customer; the factory's status (in production, ready) comes back to the till every ten minutes, or at once with "Check factory". Without the link a supervisor moves the status by hand.

## Sales orders (made to order, sold outright)
- A made-to-order item rung up as an ordinary sale and paid (or on account) is a sales order: the specification on the line, the customer required, the tax invoice written at once, and the factory gets the order straight away. They are listed at the top of the Custom orders tab: Check factory, WhatsApp update, Hand over (signed on the screen). A credit note on the line cancels the factory order.

## Customers
- One profile per cell number. Marketing consent per channel (WhatsApp, SMS, email) with the date (POPIA). History across stores: sales, credit notes, lay-bys, orders, store credit, points. Merge duplicates; export or anonymise on request (a manager). Loyalty points earn per rand by tier, pay at the till, and expire as set.

## Stock (supervisor and up)
- Per item: on hand, reserved (lay-bys), available, on order, in quarantine. Adjustments need a manager and a reason code (found stock at a cost moves the average cost). Quarantine moves by a supervisor. Reorder points give the low-stock list.
- Stock takes: freeze, count by scanning on a phone or typing, review the variances, a manager posts (sales during the count are not double-counted).

## Buying (supervisor and up)
- Suppliers; purchase orders (suggested from low stock), sent as a PDF link by email or WhatsApp; receive in full or part against the PO, or directly without one (a numbered GRV); landed costs (freight, duty) spread into the average cost; labels for what came in. Store-to-store transfers: sent → in transit → received (closed short with the loss recorded).

## Online (supervisor and up)
- Shopify: the POS is master for stock and pushes what is available per store to the shop after every movement; the shop is master for product content; online orders come in and take or reserve stock; click & collect list per store; discount codes shared with the till; a sync log. Set up under Admin → Settings → Shopify (owner).

## Register
- Open with a float by denomination; cash in/out with a reason (a supervisor's PIN); the X-report any time; a blind close by denomination with the variance per method; over the limit a manager's note and PIN; the Z-report saved and sent to the owner.

## Home
- The dashboard: today against the same weekday last week per store (sales, basket, refunds, net), open lay-bys and their balance.

## Products (manager and up to change)
- Products, variants, barcodes, categories, brands, type (stock, non-stock, made to order, voucher, bundle), VAT class, cost and price with the margin, per-store prices, reorder levels, favourites, labels (Code 128), CSV in and out.

## Reports (manager and up)
- Filters: company, store, dates, staff, channel; CSV and print/PDF. Daily sales, Z-reports, VAT per company, sales by product/category/brand with gross profit, by staff, by hour, discounts and voids, refunds, stock value, low stock, movements, dead stock, lay-bys, custom orders, customers. Xero: one balanced sales journal per company per day, posted by hand or every morning.

## Admin
- Companies (owner), Stores (owner: payment methods, receipt text, print agent), Registers, Devices (enrol a till), Staff (roles, stores, PINs), Settings per company (VAT rates by date, receipt texts, discount limits per role, cash variance limit, lay-by and custom-order terms, returns window and reasons, loyalty, Xero accounts, buying, the factory link, Shopify, idle minutes, PIN length, numbering block size).

## Planning with the figures
- Low stock: "available + on order" at or under the reorder point; the suggested order quantity is the product's reorder quantity, or enough to clear the point. Buying → New PO → Suggest from low stock.
- Custom and sales orders: expected dates come from the lead time in Settings or the factory's due date; "Ready" means the customer can be called (WhatsApp update); "update to send" means a status changed and the customer has not been told.
- Lay-bys: due dates and overdue instalments are on the Lay-bys tab; reminders go by WhatsApp.
- Today vs last week: the same weekday a week ago, per store, on Home. Reports → By hour shows when the store is busy for rostering; By staff for sales per person; Dead stock for what has not sold.
`;
