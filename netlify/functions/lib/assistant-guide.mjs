// What the in-app help assistant knows about Factory Manager. It is the
// assistant's whole picture of the app, so keep it in step with the screens:
// when a button, a rule or a flow changes, change it here too.
export const GUIDE = `
# Factory Manager: how the app works

Factory Manager runs a furniture factory (couches, beds, upholstery) from order to invoice:
the showroom till, quotes, orders, the factory floor, stock, the stock room, deliveries,
invoices, profit and wages. Each company has its own data. People log in with email and
password; the owner invites the team under Settings and gives each person a role.

## Roles and what people see
- The owner sees and changes everything. Other roles (e.g. Factory floor, Office, Sales / till,
  Stock room) get each screen as Hidden, View or Edit. The owner changes this under
  Settings → Roles: who sees what. A screen someone can only view shows "View only".
- One login can belong to several companies; a company switcher appears at the top.
  An invitation to another company shows as a bar at the top to accept or decline.
- Everyone can change their own name under Settings.

## Prices and VAT
- Every selling price in the app is the price the customer pays, including VAT. VAT is never
  added on top at the till, on quotes or on invoices: for a VAT-registered company the VAT is
  worked out inside the total ("Includes VAT 15%: R…"). A company that is not VAT
  registered (Settings → VAT registered: No) has no VAT anywhere.
- Material costs and purchase orders to suppliers are excl. VAT (the business claims that VAT
  back), and margins in Costing and on quotes are worked out excl. VAT.

## Search
- Every list screen has a search box at the top. Type any words (order number, customer,
  product, fabric, phone, area); every word must match. Orders and the till have their own.

## Point of sale (the showroom till)
- Till staff and PINs: under Settings → Till staff the owner adds each person with a PIN
  (4–6 digits), as a Manager or a Cashier with a discount limit (%) and whether they may do
  returns. Once anyone is set up, the till starts locked: enter your PIN on the pad to unlock;
  🔒 Lock locks it again. Each sale records who rang it. With no till staff set up, the till
  is open and the login's name is used.
- With the online shop connected, the till sells the SHOP'S stock: its products, prices and
  stock counts come from Shopify (↻ reads them again; "stock as at" shows when). A product
  with no stock is greyed out and a line can never take more than the shop has. Each sale
  becomes an order in Shopify (paid, fulfilled, stock taken off), shown on the sale as
  "Shop order #…"; if the shop could not be reached, the sale is sent again later ("sale(s)
  still to reach the shop"). Factory products not in the shop are still sold made to order.
- Tap products (or search, or scan a barcode: the shop's barcodes and SKUs work) to add them
  to the sale. "Other item" adds anything not in the catalogue. "🚚 Delivery" adds a delivery
  fee with the address; made-to-order pieces on that sale are booked as a delivery there.
- Discounts: "% off" on a line, or "Discount on the sale" for the whole sale, typed as "10%"
  or a rand amount. A cashier may discount up to their limit; more needs a manager's PIN
  (the Manager approval box). A manager at the till can give any discount.
- Take payment: Cash (type the cash given, the change is shown), Card, EFT, Split (two
  methods, e.g. card and cash), or Deposit (part now, the balance on collection or
  delivery). The 80 mm slip prints; the Sale complete box can also print the A4 invoice or
  send the slip by WhatsApp or email. An invoice is raised for every sale.
- Other ways to pay: "Gift card" (type the code from the slip; what is left stays on the
  card), "Store credit" and "Points" (the customer's own; "Credit / points" fills them in).
  "🎁 Gift card" on the sale screen sells a gift card for any amount (no VAT until it is
  spent); its code prints on the slip and shows in the Sale complete box.
- Loyalty points: every sale earns Settings → "Loyalty points at the till" % of what was
  paid with money (default 5%), 1 point = R1, kept on the customer (shown under the customer
  on the sale and on the Customers screen). Spent as a payment method at the till.
- Store credit: a return can be refunded as "Store credit" instead of money; it is kept on
  the customer and spent at the till.
- Layby (a sales order): pick the customer, Take payment → "Layby", take the deposit. The
  goods stay in the shop and the balance shows on the Sales tab ("owed to the till"). "Pay"
  on the sale takes more money; when it is paid in full, "Collect" hands it over (stock and
  the shop's order happen then; points are earned then). Made-to-order pieces on a layby go
  to the factory straight away.
- On account: Take payment → "On account": the goods go now, the balance is on the
  customer's invoice. "Account payment" on the Sales tab takes money from a customer who
  owes, oldest sale first; "Pay" on one sale does the same for that sale.
- Quick keys: ⭐ Quick keys on the sale screen, then tap products to star them (tap again to
  un-star); starred products show first on the till. Tap Done to finish.
- Stock tab (with the shop connected):
  - Receive stock: a delivery from a supplier. Type the supplier and their invoice number,
    then scan each item (every scan adds one), search and press Enter, or load the
    supplier's invoice (PDF, Excel or CSV) and the lines are matched by code or name; lines
    not found are listed to pick by hand or skip. Fix quantities and costs, then "Book it
    in": the pieces go onto the shop's stock (Shopify) and the delivery is listed below with
    Labels (barcode labels for what came in) and Print. "Send again" if the shop could not
    be reached.
  - Stock take: "Count the whole shop" or one category. Scan each item (adds one) or type the
    count; the difference against the shop shows. "Make it the shop's stock" (a manager, or
    a manager's PIN) sets the counted numbers as the shop's stock; lines not counted are left
    alone. Past counts are listed.
  - Labels: pick shop products and how many labels of each, 3 across on an A4 label sheet.
- Dashboard tab: today / this week / this month from the till's sales: sales value, money
  taken, number of sales, average sale, items per sale, gross profit (where a cost is known
  from deliveries; only for roles that see costing or profit), takings by method, top 5
  products by quantity and by value, and sales by hour.
- Register tab (the cash-up): Open register with the cash float at the start of the day.
  It then shows the cash expected in the drawer (float + cash sales + cash in − cash refunds
  − cash out), card and EFT totals, the sales count and the takings per person. "Cash in" /
  "Cash out" record money put in or taken out that is not a sale (a cashier's cash out needs
  a manager's PIN). "X report" prints the figures so far. "Close register" (a manager, or a
  manager's PIN): count the cash in the drawer, see the difference (over/short), add a note,
  and the Z report prints. Closed cash-ups are listed below with a Z report button to
  reprint. Sales ring up whether the register is open or not; "register closed" shows on
  the sale screen as a reminder.
- Sales tab: today's sales with who rang them, Slip / Invoice / WA buttons to reprint or
  send, and Return: pick what comes back, whether it goes back on the shelf, and the refund.
  A cashier who may not do returns needs a manager's PIN. A made-to-order piece not started
  yet is cancelled. A credit note is printed.

## Quotes
- New quote: pick a customer (or a new prospect), add lines from the catalogue (price fills
  in), fabric, quantity, a discount and a valid-until date. People who may see costing see the
  cost and margin while pricing.
- Send by WhatsApp or email, or print. When the customer says yes, Accepted turns every line
  into a factory order (and a new customer is added). Declined keeps it on record.

## Orders
- One order per piece (or set). It carries the customer, product, quantity, fabric, price,
  paid date, due date and notes. Statuses: New → In production → Done → Dispatched →
  Invoiced. The tiles at the top filter by status; the dropdown shows Open orders,
  Everything, one status, or Cancelled.
- Orders are never deleted. "Cancel order" (for New, In production or Done) asks why,
  keeps it on record as Cancelled, and can put its materials back in stock. "Reopen" brings
  a cancelled order back as New.
- The fabric status (Not ordered, Ordered, Received) shows on each order. Fabric bought on
  a purchase order for the order shows its PO number.
- Import / Export: bring orders in from Excel/CSV, or export them.
- An order shows its invoice number once invoiced.

## Factory floor
- The planner by week, the pieces on the floor and what is late. Start a piece, mark it
  Done; Done pieces leave the floor and go to Deliveries. A piece marked Done by mistake can
  be moved back.
- Print a job card for one order, or this week's job cards. Job cards have no prices: the
  product, customer, fabric and fabric status, due date, planned week, a QR code for scanning
  out at the door, and sign-off lines.
- The week's production report shows the value of what was finished against the weekly
  target (Settings → Weekly production target) and can be printed.

## Scan out
- At the loading door, scan the job card's QR code (or pick from the Done list) to mark a
  piece Dispatched.

## Deliveries
- Plan the run by day: book each Done order for a delivery (date, slot, driver, address,
  contact, instructions) or mark it for collection by the customer. Drivers get their day's
  run on WhatsApp with a private link; the customer signs on the driver's phone and the
  signed delivery note is kept.

## Customers
- The customer list with contact details, area and payment terms, their open orders and
  what they owe.

## Costing (Buying → Costing)
- Products: each product's bill of materials (materials × quantity), labour hours × the
  labour rate, and a share of the monthly overheads give the cost to build; the margin is
  against the selling price (excl. VAT). Price sheet and cost sheet print. Products can have
  a picture (a web address, filled in by itself from the online shop).
- Materials: name, unit, cost per unit (excl. VAT), supplier, reorder level. Tick "This is a
  fabric" so it shows in the fabric list on orders, quotes and the till.
- Overheads & labour: monthly overheads (rent, electricity, salaries…), pieces built per
  month and the labour rate per hour.
- Import: materials, products (with selling prices) and bills of materials from Excel/CSV,
  in that order. Importing again with the same names updates them.

## Stock (Buying → Stock)
- Every material: on hand, needed by orders not started, on order, and what is left; the
  Order now list says what to buy. Materials come off the shelf when a piece starts.
- Purchase orders: raise one per supplier (lines of material, quantity and cost), send it on
  WhatsApp, email or print, then Mark as sent. A line can be "For order …": fabric bought for
  one customer's order. When the PO is sent, that order's fabric shows as Ordered on the PO.

## Stock room
- Receive: book a purchase order in (what actually arrived; the rest stays on order), a
  delivery without a PO, or a client's own fabric for an order. Fabric bought for an order is
  booked in against that order number and set aside for it (not added to the shelf), and the
  order's fabric shows as Received.
- Give out stock and tools to staff, stock take (count every material), assets register.

## Invoices
- To invoice: everything dispatched and not yet billed, one invoice per customer. Issue
  invoice prints a tax invoice. Every invoice shows its order number(s) at the top and on
  each line; till sales also show the sale number.
- Record payments, see what is overdue, print statements, export for the accountant.

## Profit
- Month by month: sales (excl. VAT), materials, labour and overhead share, and the profit,
  per piece.

## Wages
- Staff with their rate, the week's hours, overtime (1.5×, 45-hour week), piece-work and
  deductions; UIF 1% each (capped). Save the week, print the wage sheet and payslips, mark
  paid. PAYE is not worked out here.

## Settings
- Company details (name, address, phone, email, VAT number, bank details for invoices),
  numbering (order, invoice, PO prefixes), VAT registered and rate, lead time, payment
  terms, weekly production target, team and invitations, roles: who sees what,
  subscription, and the Online shop (Shopify) connection.

## Online shop (Shopify)
- Settings → Online shop → Connect Shopify with the store address, Client ID and Client
  secret from an app made in the Shopify Dev Dashboard. Paid online orders then come in as
  orders by themselves (tagged "online #…"), "Bring in products" brings the shop's
  products, prices and pictures into the price list (matched by exact name the first time),
  and till sales from stock come off the shop's count.

## Demo mode
- Adding ?demo=1 to the address runs a demo company kept only in that browser.
`;
