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

**The server enforces the roles, not just the screens.** Every call the till
makes to the `reptipos-shopify` function carries two things, and the function
checks both before it touches Shopify or the cost prices:

1. the till's Firebase sign-in token, and
2. the PIN of whoever is signed in. The server looks the PIN up in the shared
   staff list and applies that person's role and permissions.

So a cashier's PIN cannot read or change cost prices, open the dashboard or
sales history, edit or retire products, reconcile a stock take or import
history — even by calling the server directly. Refunds and store credit need
**refunds ✓**, receiving needs **📥 receive ✓** (and a cashier's GRV never
overwrites cost prices), adding products needs **🗂 add products ✓**. When a
manager types their PIN into an "Admin PIN needed" prompt, the next few minutes
of calls go out under the manager's PIN. Without a valid PIN the server refuses
everything, apart from saying whether a staff list exists.

**The PIN is now the real key.** The Firebase sign-in is anonymous, so it proves
"this is the POS", not who is using it. That makes the staff PINs the actual
credentials for the shop's stock, gift cards and store credit:

- Give each person their own PIN, and change or remove it when somebody leaves.
- Prefer 6-digit PINs. The server blocks an address after 20 wrong PINs in 15
  minutes, but a 4-digit PIN is still the weakest link.
- Change the built-in `0000` before the till goes on the floor.

**New till, or a PIN added on another till.** The staff list only downloads to a
till after a valid PIN has been entered. On a new till, just type your PIN: the
till asks the server, and the list comes down with the sign-in. The catalogue,
any queued sales and the web-order import start after that first sign-in, not
at page load. A locked till keeps syncing queued sales in the background under
the last PIN that was used on it.
