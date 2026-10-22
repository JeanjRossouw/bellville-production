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

## Today (the first screen)
- The whole factory on one screen. Tiles: In production (pieces being built, how many are
  due within a week, how many are late), Raw stock (materials that will run short once the
  waiting orders are built), To dispatch (pieces done and waiting to go out, and how many
  went out today), On shift (who has clocked in, of the staff on the register). Tap a tile
  to open its screen; On shift opens the register.
- Orders finished this week: a bar per day, today's outlined, against last week.
- Assistant: what needs doing now, each with the button that does it. A late order → Send
  opens a message to the client with a new expected date (and moves the order's due date if
  ticked). A piece done but the client not told → Send opens WhatsApp saying it is finished.
  An order due within 3 days and not started → Plan it. Stock running short → Order stock.
  Overdue invoices → Statements. "Later" hides one until tomorrow.
- Due in the next 7 days and overdue: the open orders, soonest first.
- The register (On shift): tap a name to clock them in, again to clock them out; "Clock
  everyone in" does the lot. The names come from Money → Wages (active staff); the register
  shows no pay. Factory-floor and wages roles may clock people in.
- Each part shows only to a role that may see what it is about.

## Moving from the demo to the real system
- The demo (?demo=1) keeps everything in that one browser only. To keep it: in the demo,
  Settings → "Move to the real system" → "⬇ Download all my data" (one .json file). Use the
  same computer and browser, and the same web address, that the data was typed in on.
- Then sign in to the real system (the same address without ?demo=1), as the owner, and go
  to Settings → "Bring in data from the demo" → "⬆ Choose the demo file". It shows what is
  in the file; tick "Leave out the demo's own sample records" if you used the built-in sample
  company, and "Also bring in the business settings". "Bring it in" adds everything with the
  same links (orders to customers, invoices to orders) and the numbering carries on.
- Logins, the team, roles and the shop and Xero connections are not moved: invite the team
  and connect the shop and Xero again in the real system. Each demo company is its own file.
- Copying a whole company (for instance work done in the wrong company): sign in to it as the
  owner, Settings → "⬇ Download all my data", then sign in to the other company and bring the
  file in (leave "business settings" unticked to keep that company's own name and details).
- "Remove what came in from a file" (Settings, owner) takes out every record a file brought in,
  for instance the demo's example orders, and keeps what the team added itself.

## Suppliers and the supplier sheet
- Buying → Stock → Suppliers (and on the till: Stock → Suppliers) lists every supplier with
  the contact person, WhatsApp, email, office phone, account no. and what you buy from them
  with the price ("2nd" marks a supplier that is not the main one). ＋ Supplier / Edit.
- "⬇ Supplier sheet" downloads an Excel workbook: Suppliers (one row per supplier, add new
  ones at the bottom), What I buy (pick the supplier and the item from the drop-downs, type
  the price excl. VAT for a VAT-registered company, their item code, Main supplier Yes/No; one
  row per supplier an item is bought from), and Stock list (everything in stock on the system:
  the materials, and the online shop's products when it is connected; it is the drop-down).
- "⬆ Import supplier sheet" brings it back: new suppliers are added, existing ones brought up
  to date (a blank cell keeps what is there), and every item gets its suppliers and prices. The
  main supplier becomes the item's supplier and, if ticked, its price the item's cost price
  (product costs follow). Items not in the stock list are skipped and named.
- Purchase orders fill in the supplier's WhatsApp and email from the list.

## Delivery notes (from Done)
- When a piece is marked Done it waits on Factory floor → Done (and Orders → Done). Tick the
  pieces going on the same truck (or "Select all"), then "🚚 Make delivery note": pick the
  delivery date and the driver, and tap "Book and print". Every ticked order is booked on
  that driver's run for the day, the note gets a number (DN-0001), and it prints as the
  driver's list (each stop with a "received by" box) plus a page per stop for the client to
  sign. The run can go to the driver on WhatsApp at the same time.
- A piece with no delivery address is flagged; a collection ticked onto a note becomes a
  delivery. Reprint from Deliveries → the driver's day → "Delivery note".
- Invoice first: "🧾 Invoice ticked" (or "Invoice it" on a Done order) invoices pieces before
  they go out; they stay on Done with the invoice number, which prints on the delivery note.
  When they are delivered they end as Invoiced (not back on the To invoice list). Settings →
  "Delivery notes" → "Invoice first" means only invoiced pieces can go on a delivery note.
- From the invoices (invoice first, then deliver): Money → Invoices → Invoices tab → filter
  "To deliver (no delivery note yet)". Tick the invoices going out (or Select all) and
  "🚚 Make delivery note": date and driver, then "Book and print". Each invoice is a stop
  with its goods (discounts, delivery fees and gift cards left off) and its customer's
  address (for a till sale with a delivery, the address typed at the till). The orders on
  those invoices are booked on the driver's run, and each invoice shows its note number.
  Till sales of shop stock have no order, so this is the way to send them with a driver.
- Today reminds you when finished pieces are not booked to go out ("Make a delivery note?").

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
- The till is laid out like a shop till. At the top: the company · POS, the shop's name,
  online/offline, how many products, then one button for each part of the day: 🛒 Sell,
  📈 Dashboard, 👥 Clients, 📋 Orders, 📥 Receive, 📦 Count, 🗂 Catalogue, 🧾 PO Order,
  📊 Sales, ↩ Refund, 🧾 Register, ↻ (read the shop again), who is ringing, 🔒 Lock.
- Sell: the scan box ("Scan barcode or search by name / SKU"), 📷 scans with the camera, ⭐
  edits the quick keys. Below it the category chips: 🗂 Categories (the landing: one picture
  tile per category with its count; the categories are the shop's COLLECTIONS, like the
  online store, else the product type), All, then each category. Tap a category tile or
  chip to see its products; a typed search spans every category. A product tile shows its
  picture, price and "stock N" / "out of stock · sales order" / "made to order".
- On a phone the screen is one panel at a time: the 🔍 Shop / 🛒 Cart · R… bar at the
  bottom switches between the products and the cart.
- The cart: the customer bar (tap to pick or add), the lines, TOTAL, "Pay · N items", then
  📋 Sales order (search the shop for an item not in stock and put it on the sale as a sales
  order line), 📝 Quote (save the cart as a draft quote for the customer; it is listed under
  Orders → Quotes and sent from the Quotes screen), 🎁 Gift card, ➕ Custom item (anything not
  in the catalogue) and 🚚 Delivery (a delivery fee with the address; made-to-order pieces on
  that sale are booked as a delivery there).
- Clients: every customer with what they owe, deposits held on laybys, store credit and
  points; those with balances show first, or search by name, phone or email. Tap one for
  their profile (owing, deposits, credit, points, their sales), "Use in this sale", "Account
  payment" and WhatsApp. ＋ New client adds one.
- Orders: the open sales orders, laybys and account sales (Pay, Collect, Slip, WhatsApp) and
  the Quotes tab ("To cart" puts a quote's lines on the sale).
- Refund: type the sale number, invoice number or shop order number, or tap a recent sale,
  and the return box opens for it (see returns below).
- Catalogue (with the shop connected): the shop's products in one table with price, cost
  price, margin, reorder level, ⭐ quick key and label copies; managers type costs and levels
  and tap Save; "Print the labels ticked" prints labels.
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
- Sales order for something not in stock: tapping a sold-out product (or taking more than
  the shop has) offers to sell it as a sales order: pick the customer, take the deposit,
  give the date it is expected. It works like a layby: the goods are ordered in (it shows
  under Order stock as "sales orders need"), the balance is paid and it is collected when
  it arrives (Sales → Pay, then Collect).
- Layby (a sales order): pick the customer, Take payment → "Layby", take the deposit. The
  goods stay in the shop and the balance shows on the Sales tab ("owed to the till"). "Pay"
  on the sale takes more money; when it is paid in full, "Collect" hands it over (stock and
  the shop's order happen then; points are earned then). Made-to-order pieces on a layby go
  to the factory straight away.
- On account: Take payment → "On account": the goods go now, the balance is on the
  customer's invoice; when it is settled the shop's order is marked paid in Shopify too. "Account payment" on the Sales tab takes money from a customer who
  owes, oldest sale first; "Pay" on one sale does the same for that sale.
- Quick keys: tap ⭐ next to the scan box, then ☆ on a product to pin it (⭐ to unpin); tap ⭐
  again to finish. Pinned products show on a strip at the top of the landing and of All.
- Receive, Count, PO Order and Catalogue open the stock room pages (with the shop connected):
  - Receive stock: a delivery from a supplier. Type the supplier and their invoice number,
    then scan each item (every scan adds one), search and press Enter, or load the
    supplier's invoice (PDF, Excel or CSV) and the lines are matched by code or name; lines
    not found are listed to pick by hand or skip. Fix quantities and costs, then "Book it
    in": the pieces go onto the shop's stock (Shopify) and the delivery is listed below with
    Labels (barcode labels for what came in) and Print. "Send again" if the shop could not
    be reached.
  - Order stock: "What to order" suggests, per supplier, what to buy: a reorder level per
    product from the last 30 days' sales (two weeks' cover; type a different level in the
    box), plus what open sales orders need, less what is on hand and already on order.
    "Create PO" for a supplier makes a purchase order with those lines; "＋ Purchase order"
    starts an empty one (search the shop, press Enter). Save and send: WhatsApp, email or
    print, then "Mark as sent" (the stock counts as on order). "Receive" on a sent order
    puts its outstanding lines into Receive stock to book in; the order shows part or
    fully received.
  - Suppliers: who the shop buys from, with WhatsApp, email and account number. "Load from
    Shopify" adds the vendors on the shop's products as suppliers.
  - Stock take: "Count the whole shop" or one category. Scan each item (adds one) or type the
    count; the difference against the shop shows. "Make it the shop's stock" (a manager, or
    a manager's PIN) sets the counted numbers as the shop's stock; lines not counted are left
    alone. Past counts are listed.
  - Labels: pick shop products and how many labels of each, 3 across on an A4 label sheet.
- Dashboard: today / this week / this month from the till's sales: sales value, money
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
- Client groups: give a customer a Group (Customers → Edit → Group, e.g. Trade, Retail,
  Showroom; or a Group column when importing customers). The buttons above the list filter
  by group, and Orders → the customer filter has "Group: …" choices.
- Hiding clients from the factory: Settings → Roles → "Clients they see". Set a role to
  "Only some groups", then "Choose groups" to tick the groups it may see by name. Every
  other client shows on that role's screens (orders, floor, job cards, scan, Today,
  deliveries, stock room) by its group name only, with no phone, email or address, and it
  cannot WhatsApp those clients, book their deliveries or import customers or orders. New
  companies start with the Factory floor role on "Only some groups" with none ticked.
  Printed delivery notes and the driver's run still carry the real name and address,
  because they go out with the goods. The owner always sees everyone.

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

## Accounting (Xero)
- Settings → Accounting (Xero) → Connect Xero: sign in to Xero in the new tab and pick the
  organisation. Then fill in the bank account code (where the till money goes) and the sales
  account code (default 200) and Save. From then on every till sale paid in full goes to Xero
  by itself as a paid sales invoice (prices incl. VAT); the Sales tab shows the Xero invoice
  number on the sale. A layby or account sale goes when it is paid in full. If Xero could not
  be reached, the sale waits on the till and is sent later. Disconnect stops it.

## Online shop (Shopify)
- Settings → Online shop → Connect Shopify with the store address, Client ID and Client
  secret from an app made in the Shopify Dev Dashboard. Paid online orders then come in as
  orders by themselves (tagged "online #…"), "Bring in products" brings the shop's
  products, prices and pictures into the price list (matched by exact name the first time),
  and till sales from stock come off the shop's count.

## Demo mode
- Adding ?demo=1 to the address runs a demo company kept only in that browser.
`;
