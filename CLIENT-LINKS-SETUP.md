# Customer document links — setup

A quote or sales order can be shared with the customer as a private link. They
see the document with your letterhead and banking details, its current status,
and can ask for an update without phoning. Replies appear on the same page.

Staff press **📤 Send** on any quote or sales order in **📋 Orders**, then pick
WhatsApp, email, or copy the link.

## How it hangs together

| Piece | Where |
|---|---|
| Shared document + message thread | `netlify/functions/client-doc.mjs` |
| The customer's page | `reptipos/doc.html` — opened as `/reptipos/doc.html?t=<token>` |
| Email delivery | `netlify/functions/send-doc.mjs` |
| Staff inbox | 💬 **Messages** in the till header, with an unread count |

Documents live in Firestore alongside the rest of the app state, one per shared
document at `shared-data/clientdoc-<token>`, plus a small index doc so the inbox
needs no query support.

## Environment variables

| Variable | Needed for | Notes |
|----------|-----------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | Everything | Already set — the Shopify webhook uses it |
| `RESEND_API_KEY` | Emailing a link | From <https://resend.com>; the free tier covers a shop's volume |
| `MAIL_FROM` | Emailing a link | e.g. `ReptiCube <accounts@repticube.co.za>` — the domain must be verified in Resend, or mail is rejected |

**Without `RESEND_API_KEY` nothing breaks.** The link, the WhatsApp share and
copy-to-clipboard all work; only the Email button reports that sending is not
set up yet.

## The token is the password

Anyone holding the link can see that document and post messages to it — there is
no sign-in, which is what makes it usable for a customer. Tokens are 32 random
hex characters, so they cannot be guessed, and each document has its own. The
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
