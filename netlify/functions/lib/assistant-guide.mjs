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
- Tap products (or search, or scan a barcode with 📷 Scan) to add them to the sale.
- Each line is either "from stock" (taken off the showroom shelf count) or "made to order"
  (becomes a factory order with its own order number when the sale is completed).
  Made-to-order lines need a customer and should have a fabric, picked from the fabric list.
- "Other item" adds anything not in the catalogue. "🚚 Delivery" adds a delivery fee with
  the address; made-to-order pieces on that sale are booked as a delivery to that address.
- A discount can be given on the whole sale. Take payment: Paid in full or Deposit, with the
  method (Card, EFT, Cash, Other) and a reference. An invoice is raised and printed as the
  receipt; any balance is due on collection or delivery.
- Sales tab: today's sales, reprint a receipt, and Return: pick what comes back, whether it
  goes back on the shelf, and the refund. A made-to-order piece not started yet is cancelled.
  A credit note is printed.

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
