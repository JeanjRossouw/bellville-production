# Setting up the shared app

This is **one app sold to many furniture makers**. Every business that signs up
gets its own company inside the same app and the same database. The database
rules keep each company's records invisible to every other company.

You set the database up **once**, from an account that belongs to you as the
seller. After that, each new client signs up on their own: they open the app,
tap **Start free trial**, and are working in a minute.

Until step 1 is done the app runs in **demo mode**: everything stays in the
browser that opened it. Signing in with any email opens the demo factory, and
**Start free trial** creates an empty demo company, so the whole sign-up flow
can be tried before the database exists.

---

## 1. Create the database (Firebase), once

1. Go to <https://console.firebase.google.com> and click **Add project**.
   Name it after the product, for example `factory-manager`. Analytics is not needed.
2. **Build → Authentication → Get started**, and enable **Email/Password**.
3. **Build → Firestore Database → Create database**. Choose **Production mode**
   and a region close to South Africa (`europe-west1` is fine).
4. **Project settings** (the gear) → **Your apps** → the web icon `</>`.
   Register the app and copy the `firebaseConfig` block it shows.
5. Paste those values into `couchpotato/js/config.js`, replacing the empty
   strings in `FIREBASE_CONFIG`. These values are not secrets; the rules below
   are what protect the data.
6. **Firestore → Rules**: replace everything with the contents of
   [`firestore.rules`](firestore.rules) and click **Publish**.
   These rules are the wall between companies. They have been tested against
   Google's Firestore emulator, including attempts to read another company's
   orders, join a company uninvited, raise your own role and change the plan.
7. **Authentication → Settings → Authorized domains**: add the web address the
   app runs on (step 2), so sign-in works there.

## 2. Put it on its own web address

The app is plain static files. On Netlify:

1. **Add new site → Import an existing project**, and pick this repository.
2. Set **Base directory** and **Publish directory** to `couchpotato`, with no
   build command.
3. Rename the site, and later point the product's own domain at it.

## 3. The first company

Open the app and tap **Start free trial**. Enter the company name, your name,
email and a password. You become that company's **owner**.

For Couch Potato: have their owner do this themselves, so the company and its
owner login are theirs from day one.

## How people get in

| Who | How |
|---|---|
| A new business | **Start free trial** on the sign-in page. They become the owner of a new company with a 14-day trial. |
| Their staff | The owner opens **Settings → Team**, enters the person's email and role, and taps **WhatsApp** to send them the sign-up link. The person creates a login with that email and lands in the company with that role. |
| Someone who forgot their password | **Forgot your password?** on the sign-in page emails a reset link. |

Roles are the owner's to design, under **Settings → Roles**: a grid with the
screens down the side and the roles across the top. Each square is **Hidden**
(not in that person's menu), **View** (they can look but not change anything)
or **Edit**. The owner can add roles (Bookkeeper, Driver, Upholsterer…),
rename them and delete unused ones. Every company starts with three, which can
be changed freely:

| Role | Starts with |
|---|---|
| Owner | Everything, plus the team and billing (cannot be changed) |
| Office | Every screen at Edit |
| Sales / till | Point of sale, quotes, orders and customers |
| Factory floor | Factory floor, stock and scan out; orders to view |
| Stock room | The stock room (receive, count, give out, tools); stock and orders to view |

Changes apply at once: anyone whose menus change gets a fresh start with the
right screens. The database rules enforce the same grid, so a View or Hidden
screen cannot be worked around from outside the app. Anyone without access to
Costing does not see costs or margins on quotes.

The owner can change a role or remove someone at any time; a removed person's
login stops opening anything immediately.

## 4. Switch on payments (PayFast), once

Each company pays a monthly subscription through PayFast, by card or instant
EFT. PayFast debits it every month until the company cancels. The price is
**R 799 per month** until you change it (step 4 below).

1. Open a PayFast merchant account at <https://payfast.io> in your business's name.
   While testing, use a **sandbox** account from <https://sandbox.payfast.co.za>
   instead; it takes test cards and moves no money.
2. In PayFast: **Settings → Developer settings**. Note the **Merchant ID** and
   **Merchant Key**, and set a **Passphrase** (any long phrase). Turn on
   **Recurring billing** / subscriptions if PayFast asks.
3. In the app's Firebase project: **Project settings → Service accounts →
   Generate new private key**. A JSON file downloads. This is a secret.
4. On the Netlify site that serves the app → **Site configuration →
   Environment variables**, add:

   | Variable | Value |
   |---|---|
   | `PAYFAST_MERCHANT_ID` | from step 2 |
   | `PAYFAST_MERCHANT_KEY` | from step 2 |
   | `PAYFAST_PASSPHRASE` | the passphrase from step 2 |
   | `PAYFAST_SANDBOX` | `true` while testing; delete it to take real money |
   | `FACTORY_SERVICE_ACCOUNT` | the whole JSON from step 3, as one line |
   | `FACTORY_PRICE` | optional: the monthly price in rands, e.g. `799` |
   | `FACTORY_PLAN_NAME` | optional: the plan's name, default `Standard` |
   | `FACTORY_APP_PATH` | optional: where the app lives on the site, default `couchpotato/`; set to `/` once it has its own site |

5. Redeploy. The owner of each company now sees **Settings → Billing** with a
   **Subscribe** button.

How a payment flows: the owner taps **Subscribe**, the app's server signs the
payment form, and the owner pays on PayFast's own page. PayFast then sends the
server a payment notice. The server checks the notice's signature, checks it
with PayFast directly, checks the amount against the price, and only then marks
the company paid up for another month. Each later monthly payment extends it
again. The browser can never mark a company as paid: the database rules refuse
it.

## Deliveries and the driver's link

The **Deliveries** screen (under Production) books finished pieces for a day,
a time slot (08:00 to 20:00) and a driver, and sends each driver their run on
WhatsApp. Drivers do not log in: each gets a private link with big buttons
(navigate, on my way, running late, problem, call) and, on Delivered, the
client signs on the phone or tablet. The signed note is saved with the order,
and the order moves to Dispatched, so it waits for invoicing.

The driver's page runs through `netlify/functions/factory-driver.mjs`, which
checks the link's code on the server and shows only that driver's stops for
the day, without prices. It uses the same `FACTORY_SERVICE_ACCOUNT` as billing
(step 4). If a phone is lost, open Deliveries → Drivers → **New link**: the old
link stops working at once. Only roles with **Edit** on Deliveries can see or
send driver links.

## 5. Make yourself the seller, once

The seller sees a **Clients** tab listing every company: who is on a trial,
who is paying, who has stopped, and your monthly income. From there you can
extend someone's trial by 14 days or give a company free access (for example
Couch Potato, as your first client).

1. Sign up in the app yourself, with your own email.
2. Firebase → **Authentication → Users**: copy your **User UID**.
3. Firebase → **Firestore → Start collection**: name it `admins`, set the
   document id to your User UID, and add one field, `email`, with your email.
4. Sign out and in again. The **Clients** tab appears.

Nobody can make themselves a seller from the app; only an entry you create
by hand in the Firebase console counts.

## What happens when a trial ends or a payment stops

- **Trial ends (14 days) without subscribing:** the company becomes **read
  only**. Everyone can still sign in and look at everything they captured, but
  nothing can be added or changed. The owner sees a **Subscribe now** button;
  everyone else is told to ask the owner.
- **Paying:** full use. Each payment extends access to the next billing date
  plus 5 days' grace, so a day-late payment never locks anyone out.
- **A monthly payment fails:** access runs to the end of the grace days, then
  read only until they subscribe again.
- **Owner cancels** (Settings → Billing): no more payments are taken; full use
  continues until the end of the month already paid for, then read only.
- Settings, the team and billing always stay open, so a locked company can
  still fix its details and pay.

The database rules enforce all of this, not only the screens.

## Things to know

- **After updating the app, publish `firestore.rules` again** (Firestore →
  Rules), so the database enforces the newest rules.
- **One login, one company.** Someone who works for two companies needs two
  email addresses for now.
- **TRIAL_DAYS** is set in `js/config.js` and repeated in `firestore.rules`;
  change both together.
