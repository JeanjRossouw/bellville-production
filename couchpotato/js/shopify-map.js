// How a Shopify order becomes factory orders. Shared by the server (which
// brings real online orders in) and the demo (which makes up one to show the
// flow), so both behave the same. No imports: plain data in, plain data out.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayOf = (iso) => String(iso || '').slice(0, 10);
export function addDays(ymd, n) {
  const d = new Date((ymd || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (Number(n) || 0));
  return d.toISOString().slice(0, 10);
}

// Should this order come in? `when` is the company's choice:
//   'paid'   (default) once it is paid, in full or a deposit
//   'placed' as soon as the customer places it, paid or not
export function wantOrder(o, when) {
  if (!o || !o.id) return false;
  if (o.cancelled_at) return false;
  if (o.fulfillment_status === 'fulfilled') return false;     // already sent out by the shop itself
  const fs = String(o.financial_status || '');
  if (['voided', 'refunded'].includes(fs)) return false;
  if (when !== 'placed' && !['paid', 'partially_paid'].includes(fs)) return false;
  return orderLines(o).length > 0;
}

// The lines worth building or sending: real products, not gift cards or tips.
export function orderLines(o) {
  return (o.line_items || []).filter(li => !li.gift_card && (Number(li.current_quantity ?? li.quantity) || 0) > 0
    && (li.product_id || li.variant_id || li.requires_shipping !== false));
}

// The price of one piece before VAT, after the shop's discounts. Factory
// Manager keeps prices excluding VAT; Shopify stores often show them including it.
export function unitPriceExVat(o, li, vatRate) {
  const qty = Number(li.quantity) || 1;
  const disc = (li.discount_allocations || []).reduce((s, d) => s + (Number(d.amount) || 0), 0) || Number(li.total_discount) || 0;
  const each = (Number(li.price) || 0) - disc / qty;
  // not VAT registered: the shop's price is the whole price
  if (!o.taxes_included || !(Number(vatRate) > 0)) return r2(each);
  const rate = (li.tax_lines || []).reduce((s, t) => s + (Number(t.rate) || 0), 0) || Number(vatRate);
  return r2(each / (1 + rate));
}

// Fabric or colour, if the shop asks for it: a line property first (custom
// order forms), then the variant, e.g. "Charcoal Velvet / 3 Seater".
export function fabricOf(li) {
  const prop = (li.properties || []).find(p => /fabric|colou?r|material|finish/i.test(String(p.name || '')) && String(p.value || '').trim());
  if (prop) return String(prop.value).trim();
  const v = String(li.variant_title || '').trim();
  return v && v !== 'Default Title' ? v : '';
}

// The customer as Factory Manager keeps them.
export function customerOf(o) {
  const c = o.customer || {};
  const ship = o.shipping_address || {};
  const bill = o.billing_address || {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || ship.name || bill.name || o.email || 'Online customer';
  const lines = [ship.address1, ship.address2].filter(Boolean).join(', ');
  return {
    name,
    contact: name,
    email: String(o.email || c.email || o.contact_email || '').trim().toLowerCase(),
    phone: String(c.phone || ship.phone || bill.phone || o.phone || '').trim(),
    address: [lines, ship.zip].filter(Boolean).join(', '),
    area: ship.city || ship.province || '',
    termsDays: 0
  };
}

export const orderDocId = (o, li) => 'shopify-' + o.id + '-' + li.id;

// One factory order per line. `product` is the matching Factory Manager
// product (by Shopify variant), if there is one; `fromStock` when it can be
// sent from the shelf instead of built. The order number is filled in by
// the caller, from the company's own sequence.
export function mapLine(o, li, { customerId, customerName, product, fromStock, leadDays, vatRate, by }) {
  const now = new Date().toISOString();
  const ship = o.shipping_address || {};
  const paidDay = dayOf(o.processed_at || o.created_at) || now.slice(0, 10);
  const paid = ['paid', 'partially_paid'].includes(String(o.financial_status || ''));
  const fabric = fabricOf(li);
  const qty = Number(li.current_quantity ?? li.quantity) || 1;
  const notes = [
    'Online order ' + (o.name || '#' + o.order_number) + ' on Shopify' + (paid ? (o.financial_status === 'partially_paid' ? ', deposit paid' : ', paid') : ', not paid yet'),
    fromStock ? 'Sent from stock, not built.' : '',
    li.sku ? 'SKU ' + li.sku : '',
    (li.properties || []).filter(p => String(p.name || '')[0] !== '_' && String(p.value || '').trim()).map(p => p.name + ': ' + p.value).join('\n'),
    o.note ? 'Customer note: ' + o.note : ''
  ].filter(Boolean).join('\n');
  return {
    customerId, customerName,
    externalRef: String(o.name || ''),
    source: 'shopify',
    shopifyOrderId: String(o.id), shopifyOrderName: String(o.name || ''), shopifyLineId: String(li.id),
    productId: product ? product.id : '',
    product: product ? product.name : String(li.title || li.name || 'Item'),
    qty,
    fabric,
    fabricStatus: fromStock ? 'received' : 'none',
    notes,
    paidDate: paid ? paidDay : '',
    dueDate: addDays(paidDay, fromStock ? 7 : (leadDays == null ? 28 : leadDays)),
    priceEach: unitPriceExVat(o, li, vatRate),
    status: fromStock ? 'ready' : 'new',
    ...(fromStock ? { fromStock: true, readyAt: now } : {}),
    deliveryContact: ship.name || customerName || '',
    deliveryPhone: ship.phone || '',
    deliveryAddress: [ship.address1, ship.address2, ship.city, ship.zip].filter(Boolean).join(', '),
    deliveryInstructions: o.note || '',
    events: [{ at: now, by: by || 'Shopify', what: 'Online order ' + (o.name || '') + ' came in from Shopify' + (fromStock ? ' (sent from stock)' : '') }],
    createdAt: now, createdBy: by || 'Shopify', updatedAt: now, updatedBy: by || 'Shopify'
  };
}

// A Shopify product variant as a Factory Manager product.
export function mapProduct(v, { taxesIncluded, vatRate }) {
  const price = taxesIncluded && vatRate ? r2(v.price / (1 + vatRate)) : r2(v.price);
  return {
    name: v.title, category: v.category || '', sellingPrice: price,
    ...(v.tracked ? { stock: Math.max(0, Math.round(v.qoh) || 0) } : {}),
    shopifyProductId: v.shopifyProductId, shopifyVariantId: v.shopifyVariantId, shopifyInventoryItemId: v.shopifyInventoryItemId
  };
}
