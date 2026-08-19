# Staff logins on the till

Every person who works the till signs in with their own PIN. What they can
reach depends on whether they are a **cashier** or a **manager**.

## Adding someone

**🧾 Register → Staff** (visible to managers only). Type their name, give them a
4–6 digit PIN, choose **Cashier** or **Manager**, press **+ Add staff**. PINs
must be unique — the till refuses a duplicate, because the PIN is how it knows
who rang up a sale.

The built-in `Admin` login is a manager and cannot be removed. Change its PIN
from `0000` before the till goes on the floor.

Press the 🔒 button in the header to sign out at the end of a shift. The signed-in
name shows in the top right, with `· cashier` after it for a cashier.

## What each role sees

| | Cashier | Manager |
|---|---|---|
| Sell, take payment, print slips | ✅ | ✅ |
| Refunds and returns | ✅ | ✅ |
| Clients, accounts and loyalty | ✅ | ✅ |
| Quotes and sales orders, sending them on WhatsApp | ✅ | ✅ |
| Customer messages (💬 Messages) | ✅ | ✅ |
| Stock take / count | ✅ | ✅ |
| Register: open, pay-in, pay-out, cash-up | ✅ | ✅ |
| 📈 Dashboard — takings, profit, top sellers | — | ✅ |
| 📥 Receive stock (GRV) — supplier costs and margins | — | ✅ |
| 🧾 PO Order — purchase orders | — | ✅ |
| 📊 Sales history | — | ✅ |
| 🗂 Catalogue — cost prices, prices, add/retire products | — | ✅ |
| Cost prices in the stock export | blank | filled |
| 💰 Import cost prices | — | ✅ |
| Company, banking, tax and loyalty settings | — | ✅ |

A cashier does not see the buttons for the manager screens at all, and the
screens refuse to open even if reached another way.

### Why the register stays open to cashiers

Cashing up needs the shift figures — the float, cash taken, expected drawer —
so a cashier closing the till can count against them. Those are their own
shift's numbers, not the month's takings or any profit figure. The dashboard,
which is where profit and trend live, is manager-only.

## What this does and does not protect

It stops casual looking, which is what a shop floor needs: a cashier cannot
wander into the dashboard, see what stock cost you, or read the margin on a
purchase order.

**Cost prices are now genuinely not there.** They were moved out of Shopify and
into the POS, and they are fetched only by the manager-only screens that need
them. A cashier's till never downloads a buying price, so there is nothing to
find in the developer tools either.

The rest is still only hiding. Retail prices, stock and sales figures do come
down with the catalogue, and anyone who knows a manager PIN can simply sign in
as a manager. Treat the PINs as real credentials: give each person their own,
and change one when somebody leaves.
