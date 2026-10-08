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

Roles:

| Role | Sees |
|---|---|
| Owner | Everything, plus the team |
| Office | Everything except the team |
| Sales / till | Point of sale, orders, customers |
| Factory floor | Factory floor, scan out, orders |

The owner can change a role or remove someone at any time; a removed person's
login stops opening anything immediately.

## Things to know

- **The trial is not enforced yet.** The header shows the days left, but nothing
  locks when it reaches zero. Billing (PayFast or Paystack) and what happens at
  the end of a trial come in the next step.
- **Roles limit what people see, not yet what they can change.** The database
  rules enforce company separation, team management, settings and the plan.
  Within a company, a factory login could still change an invoice through the
  database directly. Tightening that per record type is a later step.
- **One login, one company.** Someone who works for two companies needs two
  email addresses for now.
