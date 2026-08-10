# Customer document links — setup

A quote or sales order can be shared with the customer as a private link. They
see the document with your letterhead and banking details, its current status,
and can ask for an update without phoning. Replies appear on the same page.

Staff press **📤 Send** on any quote or sales order in **📋 Orders**, check the
cellphone number, and WhatsApp opens with the message ready to send. There is
also a copy-link button for pasting anywhere else.

## Links are prepared on their own

Nobody has to remember to make a link. The moment one of these is rung up, the
link is created and queued under **📤 To send** in the till header, with a count
on it:

| When | Queued as |
|---|---|
| A sales order is created | Order, status *Awaiting stock* |
| A quote is saved | Quote |
| A sale goes through with an **enclosure** on it | Order, status *In production* |

Open **📤 To send**, check the cellphone number, press **Send on WhatsApp** —
one tap, message already written. **Copy** puts the link on the clipboard
instead. **Not needed** removes the row, for when the customer walked out with
the thing in their hands; the link still exists and can be re-sent from
**📋 Orders** later.

Sent rows stay visible for a day with a **Send again** button, then clear
themselves. If the link could not be created — the till was offline, say — the
row shows the reason and a **Retry**. A sale is never held up by this: the
selling finishes first, and the link is queued after.

### Why it does not send by itself

WhatsApp's click-to-chat cannot send on its own; a person has to press send in
WhatsApp. Sending with no human involved means Meta's WhatsApp Business
Platform — business verification, a dedicated number that is not already on
WhatsApp, templates approved by Meta, and a fee per message. That is a real
option, but it is a decision with a cost, not a switch to flip.

What actually went wrong before was not the tap. It was nobody making a link at
all, and that part is now automatic.

### Which products count as enclosures

Two things count, and the default is `RANGE, Starter Kit`:

- Every enclosure range has a Shopify product type ending in **RANGE** — `RC
  RANGE`, `RCA RANGE`, `RCB RANGE`, `RCV RANGE`.
- `Reptile enclosure Starter Kit`, which is built around an enclosure.

`Reptile enclosure decor` also has the word *enclosure* in its name and is **not**
one — matching on that word would queue a link every time somebody bought a
piece of cork bark. That is why these are matched as terms instead.

Set it under **🧾 Register → 📤 Customer links** (managers only), comma-separated
and matched loosely against the product type. Leaving it empty turns the sale
trigger off; orders and quotes still queue.

## How it hangs together

| Piece | Where |
|---|---|
| Shared document + message thread | `netlify/functions/client-doc.mjs` |
| The customer's page | `reptipos/doc.html`, served at `/o/<token>` by a rewrite in `netlify.toml` |
| Staff inbox | 💬 **Messages** in the till header, with an unread count |

Documents live in Firestore alongside the rest of the app state, one per shared
document at `shared-data/clientdoc-<token>`, plus a small index doc so the inbox
needs no query support.

## Environment variables

| Variable | Needed for | Notes |
|----------|-----------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | Everything | The service-account JSON. Mark it **secret** in Netlify, or its value is readable in plain text through the API |

Nothing else. Sharing is deliberately WhatsApp-only: it needs no mail provider,
no domain verification and no per-message fee, and it is how customers here
prefer to be reached.

## Sending on WhatsApp

The **Send** button opens WhatsApp with the customer's number and a short
message containing the link — staff press send there. It is the same
click-to-chat approach the till already uses for receipts, so it works on the
till, a phone or the desktop app with no approval from Meta.

Numbers are accepted however staff type them — `082 123 4567`, `+27 82…`,
`0027…` — and converted to the international form WhatsApp needs. A number that
cannot be made sense of is refused rather than opening an empty chat.

If a customer would rather have it by email, use **Copy link** and paste it into
whatever you normally send mail from.

## Making the link look like yours

Links are `https://<site>/o/<token>` — short enough to sit in a WhatsApp message.
The old `/reptipos/doc.html?t=…` form still resolves, so anything already sent
keeps working.

The domain is whatever the site answers on. To send customers to a subdomain of
your own domain instead of `bellville-production.netlify.app`, add that
subdomain under **Domain management** in Netlify, set it as the **primary**
domain, and point a CNAME at the site from wherever the domain is registered.
Then redeploy — the function reads `URL` from the build environment, so links
keep using the old host until a deploy picks up the new one. Nothing in the code
changes.

## So the customer can find it again

A link sits in a WhatsApp thread and is buried within a week. Three things
address that, in order of how well they work:

1. **Home screen.** The customer's page prompts them to save it to their phone,
   with the right wording for iPhone or Android. It then opens as an app icon —
   one tap, no searching. On Android the page builds a manifest at load time so
   the installed shortcut points at *that* document rather than a generic page;
   iPhone uses the `apple-*` meta tags with whatever URL is open. The prompt is
   dismissible and remembered.
2. **The message says so.** The WhatsApp text sent with the link suggests saving
   it, which is where the customer decides what to do with it.
3. **Re-send it.** Pressing Send again reuses the same token, so the newest
   message in the chat always carries a working link and the conversation on the
   page is not lost.

Customers can also star the WhatsApp message or pin the chat — no work on our
side, and worth suggesting to anyone who asks.

## The token is the password

Anyone holding the link can see that document and post messages to it — there is
no sign-in, which is what makes it usable for a customer. Tokens are 16 random
hex characters — 64 bits, far too large to guess — and each document has its
own. Tokens issued before this were 32 characters and remain valid. The page is
marked `noindex` so search engines will not list it.

What a link does **not** expose: the customer's email address and phone number
are stored but never returned to the page, and one token gives access to exactly
one document — never a list, never another customer's.

Re-sending an already-shared document reuses its token, so the customer's
existing link keeps working and the conversation is not lost.

## Statuses shown to the customer

`sent`, `accepted`, `awaiting_stock`, `in_production`, `ready`, `delivered`,
`paid`, `cancelled` — rendered in plain words ("Awaiting stock", "Ready for
collection"). Staff can also attach a short note, which appears under the status.

Banking details appear only while a balance is owing.
