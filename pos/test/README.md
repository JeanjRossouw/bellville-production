# POS tests

`rules.test.mjs` checks the `/pos/{gid}` block of `couchpotato/firestore.rules`
against the Firestore emulator: roles, entity and store reach, the server-only
collections, the five stamps and whole cents.

```
npm i -D @firebase/rules-unit-testing firebase firebase-tools   # once
npx firebase emulators:start --only firestore --project factory-manager-ece82
node pos/test/rules.test.mjs
```
