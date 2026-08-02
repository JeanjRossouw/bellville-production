# ReptiCube — Lightspeed → Shopify migration runbook

Goal: get ReptiCube's catalogue, stock and customers out of Lightspeed Retail
(R-Series) and into the **Shopify store that the POS reads from**, then cut over.
Shopify is the single source of truth; the POS only reads the catalogue and
writes sales back, so everything must live in Shopify before go-live.

Rough volumes (confirm against your export): **~525 products**, **~347
customers**, plus an inventory baseline. Numbers below are estimates — trust the
actual export row counts.

> **No VAT.** ReptiCube is not VAT-registered. When importing, the Shopify price
> is the final price. Do **not** set "charge tax on this product", and leave the
> store tax settings off. The POS never shows a VAT line.

---

## 0. Before you touch anything
- [ ] Decide the **target store**: the real `repticube.myshopify.com`, **or** a
      Shopify **dev store** for a dry run first (recommended). The POS header
      turns **amber** when it isn't connected to ReptiCube, so a dry run on a dev
      store can never write a real sale by accident.
- [ ] Take a full Lightspeed export (below) and **keep the originals untouched** —
      always work on copies.
- [ ] Pick a **freeze window**: a quiet period where no sales happen in Lightspeed
      while you take the final inventory baseline and import. A Sunday evening is
      ideal.

## 1. Export from Lightspeed (R-Series)
From the Lightspeed back office (Reports / Inventory / Customers → Export to CSV):
- [ ] **Items** export — name, SKU, **UPC/barcode**, default cost, **retail
      price**, category/department, and **quantity on hand (QOH)** per shop.
- [ ] **Customers** export — first/last name, email, phone, and any account
      balance / store credit.
- [ ] **Open special orders / layaways** (if any) — these become deposits/owings
      you'll carry over manually (see §6).
- [ ] Product **images** if you have them as files; otherwise note that Shopify
      products will start image-less and you'll add photos later.

Keep each export as `lightspeed-items-YYYYMMDD.csv`, etc.

## 2. Clean the data (work in a spreadsheet)
**Products**
- [ ] One row per **sellable variant**. If Lightspeed used matrix items
      (size/colour), each child becomes a Shopify variant under one product.
- [ ] **Barcodes**: ensure every scannable item has a UPC/barcode in its own
      column — this is what the till scans. Items with no barcode can still be
      searched by name/SKU, but barcode is strongly preferred.
- [ ] De-dupe SKUs and barcodes (no two products may share a barcode — the till
      matches the first hit). Flag blanks.
- [ ] Prices: confirm the **retail (incl.) price** column — that is the final
      price. No tax math.
- [ ] Map Lightspeed category/department → Shopify **Product type** (the till
      shows this; it's also handy for reporting).
- [ ] Drop discontinued / archived items, or mark them so they import as
      **draft** (only `active` products reach the till).

**Customers**
- [ ] De-dupe on email, then phone. ~347 raw rows often collapse a little once
      duplicates merge. Keep the most complete record.
- [ ] Normalise phone numbers to a consistent format (e.g. `+27…`) so the till's
      customer search finds them.
- [ ] Note any **store credit / account balances** separately — Shopify customer
      import doesn't carry these; handle as store-credit (§6).

## 3. Build the Shopify product import CSV
Use Shopify's official product CSV template (Products → Import → "Need a
template?"). Map columns:

| Shopify column | From Lightspeed |
|---|---|
| `Title` | Item name |
| `Variant SKU` | SKU |
| `Variant Barcode` | UPC / barcode |
| `Variant Price` | Retail price (final, incl.) |
| `Variant Inventory Qty` | QOH (the baseline — see §5 about timing) |
| `Variant Inventory Tracker` | `shopify` |
| `Variant Inventory Policy` | `deny` (don't oversell) unless an item is made-to-order |
| `Type` | Category / department |
| `Status` | `active` (or `draft` for discontinued) |
| `Charge tax` | **FALSE** (not VAT-registered) |

- [ ] For matrix items, repeat the `Handle` across variant rows so they group
      under one product (per Shopify's template rules).
- [ ] **Inventory tracked at one location.** Confirm the store has a single
      active **Location** (the till reads/decrements there). If there are several,
      pick the shop location and import quantities against it.

## 4. Import & verify products (dry run first)
- [ ] Import the CSV on the **dev store** first. Fix any row errors Shopify
      reports, re-export, re-import until clean.
- [ ] Spot-check 10–15 items: title, price, barcode, qty, product type, `active`.
- [ ] Point the POS env vars at the dev store, open `/reptipos/`, and confirm:
      catalogue count ≈ export count, **scanning a real barcode** adds the right
      item, prices match, out-of-stock tiles disable.
- [ ] Only once the dry run is clean, repeat the import on the **live ReptiCube
      store**.

## 5. Inventory baseline (do this during the freeze)
Stock is the number most likely to drift. To avoid a mismatch:
- [ ] During the freeze window, take the **final QOH** from Lightspeed (a fresh
      inventory export, or a quick physical count of fast-movers).
- [ ] Set those quantities in Shopify — either in the product import CSV (if you
      import during the freeze) or via **Shopify admin → Inventory** afterwards.
      For a small number of corrections, the till's own stock figure will re-sync
      from Shopify on the next catalogue refresh (↻).
- [ ] After this point, **all** sales (in-store via the POS, and online) flow
      through Shopify, so stock stays correct going forward.

## 6. Customers, store credit & open orders
- [ ] Import customers via **Shopify admin → Customers → Import** (Shopify's
      customer CSV), using your de-duped list. The till's customer search reads
      these live.
- [ ] **Store credit / account balances:** record each as Shopify **store
      credit** (Customers → the customer → store credit), or track owings as a
      tagged draft order. Keep your Lightspeed balance export as the source of
      truth until each is reconciled.
- [ ] **Layaways / special orders in progress:** for each, create a Shopify
      **draft order** (or use the till's Park) noting the deposit already paid and
      the balance owing, so staff can complete it when stock arrives.

## 7. Cut-over checklist (go-live)
- [ ] Live store: products imported, prices/barcodes verified, inventory baseline
      set, customers imported.
- [ ] POS env vars point at **live ReptiCube** (`SHOPIFY_DOMAIN` +
      `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`), header shows
      `🏪 ReptiCube` in grey (not amber).
- [ ] App version released with **all required scopes** (see REPTIPOS-SETUP.md)
      and **re-installed/approved** on the live store.
- [ ] Do **one** real test sale of a cheap item: confirm the Shopify order is
      created, paid, stock decrements, receipt prints. Then refund it (test the
      refund + restock path) and confirm stock returns.
- [ ] Open the register with the real opening float; staff PINs created.
- [ ] Stop using Lightspeed for sales. Keep it read-only for ~1 month for history.

## 8. After go-live
- [ ] Reconcile the first day's Z-report against Shopify orders.
- [ ] Watch for any barcodes that don't scan (missing/duplicate) and fix in
      Shopify; the till picks them up on the next ↻ refresh.
- [ ] Schedule a periodic stock count to catch any drift early.

---

### Notes / gotchas
- **One barcode per item.** Duplicates make the scanner ambiguous (first match
  wins).
- **Active only.** Draft/archived products never reach the till — use that to
  stage items before they go live.
- **Single location.** The till reads and decrements one Shopify location; make
  sure inventory lives there.
- **No tax.** Never enable "charge tax" — the price is final.
- **Dry-run on a dev store** end-to-end before touching live; the amber store
  badge is your safety net.
