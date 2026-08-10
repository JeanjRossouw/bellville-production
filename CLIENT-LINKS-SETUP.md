# Customer document links — setup

A quote or sales order can be shared with the customer as a private link. They
see the document with your letterhead and banking details, its current status,
and can ask for an update without phoning. Replies appear on the same page.

Staff press **📤 Send** on any quote or sales order in **📋 Orders**, check the
cellphone number, and WhatsApp opens with the message ready to send. There is
also a copy-link button for pasting anywhere else.

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

The domain is whatever the site answers on. To send customers to
`orders.repticube.co.za` instead of `bellville-production.netlify.app`, add that
subdomain under **Domain management** in Netlify and point a CNAME at the site
from wherever the domain is registered. Nothing in the code changes — links are
built from the host the request arrived on.

## The token is the password

Anyone holding the link can see that document and post messages to it — there is
no sign-in, which is what makes it usable for a customer. Tokens are 32 random
hex characters — 64 bits, far too large to guess — and each document has its
own. Older 32-character tokens remain valid. The
page is marked `noindex` so search engines will not list it.

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
