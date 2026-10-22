// Retail POS — the shop's catalogue brought into the till for a cut-over
// (ReptiCube and any shop that ran on Shopify before the till): every
// product with its variants, prices, costs, barcodes and pictures, matched
// to what is already here, and, when asked, the shop's stock at each mapped
// location as the opening stock of items that have never moved here. After
// that the till is master for stock and the shop for content, as usual.
import { query, commit, nowIso, randomId, serverStamp } from './pos.mjs';
import { gql } from './shopify-pos.mjs';
import { runSale, moveWrites } from './sale.mjs';

const cents = (s) => Math.round(Number(s || 0) * 100);
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
const low = (s) => String(s || '').trim().toLowerCase();
const vkey = (ov) => Object.entries(ov || {}).map(([k, v]) => low(k) + '=' + low(v)).sort().join('|');

// ---- every product on the shop, in the till's terms
export async function pullCatalogue(cfg) {
  const out = []; let after = null;
  for (let page = 0; page < 200; page++) {
    const d = await gql(cfg, `query($after: String) { products(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title handle descriptionHtml status vendor productType tags isGiftCard options { name values } images(first: 5) { nodes { url } } variants(first: 100) { nodes { id title sku barcode price taxable selectedOptions { name value } image { url } inventoryItem { id tracked unitCost { amount } inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { name quantity } } } } } } } } }`, { after });
    const pr = d.products;
    for (const n of pr.nodes) {
      const options = (n.options || []).filter(o => o.name && o.name !== 'Title').map(o => ({ name: o.name, values: (o.values || []).filter(v => v && v !== 'Default Title') }));
      const variants = (n.variants && n.variants.nodes || []).map(v => {
        const ov = {}; for (const so of v.selectedOptions || []) if (so.name !== 'Title' && so.value !== 'Default Title') ov[so.name] = so.value;
        const inv = v.inventoryItem || {};
        const available = {}; for (const l of (inv.inventoryLevels && inv.inventoryLevels.nodes) || []) { const q = (l.quantities || []).find(x => x.name === 'available'); if (l.location && q) available[l.location.id] = Number(q.quantity) || 0; }
        return { id: v.id, title: v.title || '', sku: String(v.sku || '').trim(), barcode: String(v.barcode || '').trim(), priceCents: cents(v.price), taxable: v.taxable !== false, optionValues: ov, name: options.map(o => ov[o.name]).filter(Boolean).join(' / '), image: v.image && v.image.url || '', inventoryItemId: inv.id || '', tracked: inv.tracked !== false, costCents: inv.unitCost && inv.unitCost.amount != null ? cents(inv.unitCost.amount) : null, available };
      });
      out.push({ id: n.id, handle: n.handle || '', title: n.title || '', description: strip(n.descriptionHtml), vendor: n.vendor || '', productType: n.productType || '', tags: (n.tags || []).map(low), giftCard: !!n.isGiftCard, status: n.status || 'ACTIVE', images: (n.images && n.images.nodes || []).map(i => i.url).filter(Boolean).slice(0, 5), options: options.filter(o => o.values.length), variants });
    }
    if (!pr.pageInfo.hasNextPage) break;
    after = pr.pageInfo.endCursor;
  }
  return out;
}

// ---- the plan: each shop product against the till's, matched by Shopify id, then handle, then SKU, then name
export async function planCatalogue(entityId, shop) {
  const [products, variants] = await Promise.all([query('products', [{ field: 'entityId', value: entityId }], 5000), query('variants', [{ field: 'entityId', value: entityId }], 10000)]);
  const plan = [];
  for (const sp of shop) {
    const hasVariants = sp.options.length > 0 && sp.variants.length > 0;
    const v0 = sp.variants[0] || { priceCents: 0, costCents: null, sku: '', barcode: '', taxable: true, tracked: true };
    const type = sp.giftCard ? 'voucher' : sp.tags.includes('mto') ? 'mto' : sp.tags.includes('nonstock') ? 'nonstock' : 'stock';
    const vatClass = sp.tags.includes('vat:zero') ? 'zero' : sp.tags.includes('vat:exempt') ? 'exempt' : v0.taxable ? 'standard' : 'zero';
    const existing = products.find(p => p.shopifyProductId === sp.id) || (sp.handle && products.find(p => p.shopifyHandle === sp.handle)) || (!hasVariants && v0.sku && products.find(p => !p.hasVariants && low(p.sku) === low(v0.sku))) || products.find(p => low(p.name) === low(sp.title)) || null;
    const product = { name: sp.title, description: sp.description, brand: sp.vendor, category: sp.productType.split('>').pop().trim(), type, vatClass, trackStock: type === 'stock' && v0.tracked, images: sp.images, archived: sp.status !== 'ACTIVE', options: hasVariants ? sp.options : [], hasVariants, priceCents: v0.priceCents, ...(v0.costCents != null ? { costCents: v0.costCents } : {}), sku: hasVariants ? '' : v0.sku, barcodes: hasVariants || !v0.barcode ? [] : [v0.barcode], shopifyProductId: sp.id, shopifyHandle: sp.handle, shopifyVariantId: hasVariants ? '' : v0.id, shopifyInventoryItemId: hasVariants ? '' : v0.inventoryItemId, contentFrom: 'shopify' };
    const have = existing ? variants.filter(v => v.productId === existing.id) : [];
    const vs = hasVariants ? sp.variants.map(sv => ({ shop: sv, existing: have.find(h => h.shopifyVariantId === sv.id) || have.find(h => vkey(h.optionValues) === vkey(sv.optionValues)) || (sv.sku && have.find(h => low(h.sku) === low(sv.sku))) || null, body: { name: sv.name || sv.title, optionValues: sv.optionValues, sku: sv.sku, barcodes: sv.barcode ? [sv.barcode] : [], priceCents: sv.priceCents, ...(sv.costCents != null ? { costCents: sv.costCents } : {}), images: sv.image ? [sv.image] : [], archived: false, shopifyVariantId: sv.id, shopifyInventoryItemId: sv.inventoryItemId, shopifyProductId: sp.id } })) : [];
    plan.push({ shop: sp, existing, product, variants: vs, hasVariants });
  }
  return plan;
}
// what the opening stock would be: per mapped store, the shop's available quantity of every tracked item that has never moved here
export async function planStock(entityId, plan, locationByStore) {
  const stores = Object.entries(locationByStore || {}).filter(([, loc]) => loc);
  const levels = new Map((await query('stockLevels', [{ field: 'entityId', value: entityId }], 20000)).map(l => [l.id, l]));
  const rows = []; let skipped = 0;
  for (const [storeId, loc] of stores) {
    for (const x of plan) {
      if (x.product.type !== 'stock' || !x.product.trackStock) continue;
      const items = x.hasVariants ? x.variants.map(v => ({ shop: v.shop, existingId: v.existing ? v.existing.id : '', isVariant: true, name: x.product.name + ' · ' + v.body.name, costCents: v.body.costCents ?? x.product.costCents ?? (x.existing ? x.existing.costCents : 0) ?? 0 })) : [{ shop: x.shop.variants[0], existingId: x.existing ? x.existing.id : '', isVariant: false, name: x.product.name, costCents: x.product.costCents ?? (x.existing ? x.existing.costCents : 0) ?? 0 }];
      for (const it of items) {
        if (!it.shop || !it.shop.tracked) continue;
        const qty = it.shop.available[loc] || 0; if (qty <= 0) continue;
        if (it.existingId && levels.has(storeId + '_' + it.existingId)) { skipped++; continue; }
        rows.push({ storeId, product: x, variantShopId: it.isVariant ? it.shop.id : '', qty, name: it.name, costCents: it.costCents || 0 });
      }
    }
  }
  return { rows, skipped, stores: stores.map(([s]) => s) };
}

// ---- apply: products and variants written (new ones created, matched ones updated), then the opening stock as movements
export async function applyCatalogue(entityId, user, plan, { openingStock, locationByStore } = {}) {
  const now = nowIso(); const stamp = serverStamp(entityId, '', user.id, 'office');
  const writes = []; const ids = new Map();   // shop product id → till product id; shop variant id → till variant id
  let created = 0, updated = 0, variantsN = 0;
  for (const x of plan) {
    const id = x.existing ? x.existing.id : randomId('pr_');
    ids.set(x.shop.id, id);
    if (x.existing) { writes.push({ update: true, coll: 'products', id, data: { ...x.product, linkedAt: now, updatedBy: user.id, updatedAt: now } }); updated++; }
    else { writes.push({ set: true, coll: 'products', id, data: { ...x.product, supplierId: '', storePrices: {}, bundle: [], reorderLevel: null, reorderQty: null, favourite: false, linkedAt: now, ...stamp, updatedBy: user.id, updatedAt: now } }); created++; }
    for (const v of x.variants) {
      const vid = v.existing ? v.existing.id : randomId('va_');
      ids.set(v.shop.id, vid); variantsN++;
      if (v.existing) writes.push({ update: true, coll: 'variants', id: vid, data: { ...v.body, linkedAt: now, updatedBy: user.id, updatedAt: now } });
      else writes.push({ set: true, coll: 'variants', id: vid, data: { ...v.body, productId: id, storePrices: {}, linkedAt: now, ...stamp, updatedBy: user.id, updatedAt: now } });
    }
  }
  for (let i = 0; i < writes.length; i += 400) await commit(writes.slice(i, i + 400));
  const result = { created, updated, variants: variantsN, stock: { items: 0, qty: 0, skipped: 0 } };
  if (openingStock) {
    const st = await planStock(entityId, plan, locationByStore);
    result.stock.skipped = st.skipped;
    const docId = 'shopify-import-' + now.replace(/\D/g, '').slice(0, 14);
    for (const storeId of st.stores) {
      const mine = st.rows.filter(r => r.storeId === storeId);
      const ctx = { entityId, storeId, user: { id: user.id, name: user.name }, deviceId: 'office' };
      for (let i = 0; i < mine.length; i += 120) {
        const chunk = mine.slice(i, i + 120);
        await runSale(ctx, {}, { more: async (tx, levels) => {
          const ws = []; const t = nowIso(); const stp = serverStamp(entityId, storeId, user.id, 'office');
          for (const r of chunk) {
            const productId = ids.get(r.product.shop.id); const variantId = r.variantShopId ? ids.get(r.variantShopId) : '';
            const itemId = variantId || productId; const lid = storeId + '_' + itemId;
            if (!levels.has(lid)) levels.set(lid, null);   // never moved here: that is the condition for an opening figure
            ws.push(...moveWrites(ctx, levels, { productId, variantId, itemId, qty: r.qty, bucket: 'onHand', reason: 'adjust', code: 'correction', unitCostCents: r.costCents, baseCostCents: r.costCents, wac: true, name: r.name, note: 'Opening stock from Shopify', byName: user.name }, { docType: 'import', docId, docNo: '' }, stp, t));
            result.stock.items++; result.stock.qty += r.qty;
          }
          return { writes: ws, result: {} };
        } });
      }
    }
  }
  return result;
}
