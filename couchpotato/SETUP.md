# Couch Potato factory system — setup

This is a **separate system** from Bellville Furniture. It gets its own database,
its own website address and its own logins. Nothing is shared. Bellville Furniture
is simply customer number one inside it.

Right now the app runs in **demo mode**: everything you do stays in your own
browser. That is deliberate, so the whole system can be walked through and
changed before anyone sets up accounts. The three steps below make it real.

---

## 1. Create Couch Potato's own database (Firebase)

Do this from an account that belongs to **Couch Potato**, not Bellville. That is
what makes the system theirs.

1. Go to <https://console.firebase.google.com> and click **Add project**.
   Name it something like `couch-potato-factory`. Google Analytics is not needed.
2. In the new project, open **Build → Authentication → Get started** and enable
   **Email/Password**.
3. Open **Build → Firestore Database → Create database**. Choose
   **Production mode** and a region close to South Africa (`europe-west1` is fine).
4. Open **Project settings** (the gear) → scroll to **Your apps** → click the
   web icon `</>`. Register the app, then copy the `firebaseConfig` block it shows.
5. Paste those values into `couchpotato/js/config.js`, replacing the empty strings:

   ```js
   export const FIREBASE_CONFIG = {
     apiKey: 'AIza…',
     authDomain: 'couch-potato-factory.firebaseapp.com',
     projectId: 'couch-potato-factory',
     storageBucket: 'couch-potato-factory.firebasestorage.app',
     messagingSenderId: '…',
     appId: '1:…:web:…'
   };
   ```

   These values are not secrets. They identify the project; the security rules
   below are what actually protect the data.

6. Still in Firestore, open the **Rules** tab and paste this, then **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Only signed-in people can read or write anything in this factory.
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

   That is the right starting point for a small factory where everyone signed in
   is staff. Tighten it per collection later if outside parties ever get logins.

---

## 2. Create the logins

In **Authentication → Users → Add user**, create one account per person, for
example:

| Person | Email | Role they should get |
|---|---|---|
| Owner | `owner@couchpotato.co.za` | owner |
| Factory floor | `floor@couchpotato.co.za` | factory |
| Bookkeeper | `accounts@couchpotato.co.za` | accounts |

**The first person to sign in automatically becomes the owner.** So sign in as
the owner account first, before anyone else. Everyone who signs in after that
starts with no access until the owner grants them a role.

---

## 3. Put it on its own web address

The app is plain static files, so any host works. On Netlify:

1. **Add new site → Import an existing project**, and pick this repository.
2. Under **Build settings**, set **Base directory** to `couchpotato` and leave
   the build command empty. Set the publish directory to `couchpotato`.
3. Deploy, then rename the site under **Site configuration → Change site name**,
   for example `couchpotato-factory`, giving
   `https://couchpotato-factory.netlify.app`.
4. When they are ready, point their own domain at it under **Domain management**.

This keeps Couch Potato's site completely separate from the Bellville site, even
while the code lives in the same repository. Moving the `couchpotato` folder into
its own repository later is a copy and paste, and nothing inside the app needs to
change when that happens.

---

## Checking it worked

Open the site. If the yellow **Demo mode** notice is gone from the sign-in screen
and your real email and password work, it is live. Under **Settings** the storage
line will say it is connected to Couch Potato's own database.

## Filling in their details

Everything that appears on job cards, quotes and invoices lives under
**Settings**: trading name, registered name, company registration number, VAT
number, address, bank details, and the order and invoice numbering. Set these
first, since later phases print from them.

## What is built so far

| | Status |
|---|---|
| Customers | Built |
| Orders, with their own numbering and full change history | Built |
| Factory floor: week planner, fabric watch-list, job cards | Built |
| Costing: materials, bills of material, overheads, price list | Built |
| Scan out by QR code, with customer notification | Built |
| Invoicing, statements and the accountant's export | Phase 5 |

## How Bellville's orders will arrive

Agreed approach: a one-way automatic feed. Orders placed in the Bellville system
appear here by themselves, and the dispatched status flows back to Bellville.
Only orders cross between the two systems, so the data stays entirely separate
and nobody captures anything twice. That is built once this foundation is signed
off, so that it is built against the final shape of an order.
