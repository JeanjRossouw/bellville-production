# POS tests

Both run against the local Firebase emulators (Firestore on 8085, Auth on 9099):

```
npm i -D @firebase/rules-unit-testing firebase firebase-tools playwright   # once
npx firebase emulators:start --only firestore,auth --project factory-manager-ece82
```

- `rules.test.mjs` — the `/pos/{gid}` block of `couchpotato/firestore.rules`:
  roles, entity and store reach, the server-only collections, the five
  stamps and whole cents. `node pos/test/rules.test.mjs`
- `auth.test.mjs` — step 2 in a browser: the first owner, staff, enrolling a
  till, PIN sign-in, lock-out, the manager override and its audit row, idle,
  offline PIN. It starts `server.mjs` (the repo as static files plus the
  `pos-*` functions on the emulators) on port 8788 if nothing is there.
  `node pos/test/auth.test.mjs`
- `admin.test.mjs` — step 3: companies, stores, registers and settings as the
  owner, then as a manager. `node pos/test/admin.test.mjs`
  Set `FIREBASE_SDK_DIR` to a local copy of the `firebase` package's browser
  builds when www.gstatic.com is not reachable, and `CHROME` to a Chromium
  path when Playwright's own is not installed.
