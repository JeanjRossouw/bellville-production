// Retail POS — the take-on from the old system (Admin → Take-on; the owner only).
//
// Two files from the old system's reports, each checked before anything is written, and nothing guessed:
//   Customers and balances: name, cell number, email, VAT number, address, what they owe, a store credit and its
//     document reference. A profile is made (or found by cell number); what is owed becomes the account's opening
//     balance (the account opened, its limit at least that) and shows on the statement as "Opening balance"; store
//     credit only with a document reference. No cell number, an account in credit, credit without a reference, or a
//     customer taken on already: handed back as an exception, for a person to decide.
//   Stock on hand (this store): product or SKU or barcode, variant, quantity, cost. Each item is matched to the
//     catalogue; the level is set to the quantity by a stock adjustment that says "Take-on" (a manager's movement,
//     audited). A negative quantity is taken as nothing and listed; an item not found is listed; a quantity that is
//     already right is left alone.
// Every exception goes on one list, downloadable as a CSV, so the cut-over has a paper trail.
import { API } from './config.js';
import * as auth from './auth.js';
import { esc, toast, openModal, money } from './ui.js';
import { parseCsv, sepOf, toCsv, download } from './csv.js';
import { itemsOf, low, norm, skuKey } from './costimport.js';
import { centsOf } from './money.js';

export const tk = { exceptions: [], done: [], busy: false };
let ctx = { data: () => ({}), repaint() {} };
export const setContext = (c) => { ctx = { ...ctx, ...c }; };
const d = () => ctx.data();
const where = () => ({ entityId: d().entity.id, storeId: d().store ? d().store.id : '', registerId: '' });
const batch = () => 'to-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6);
const cell = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');
const find = (h, names) => h.findIndex(x => names.includes(x));
const note = (what, why, line = 0) => tk.exceptions.push({ at: new Date().toISOString(), what, why, line });

// ------------------------------------------------------------ the page --
export function takeOnHtml() {
  const dd = d();
  if (!dd.entity) return `<div class="page-head"><h1>Take-on</h1></div><div class="card muted">Pick a store first (the stock goes into the store on screen).</div>`;
  return `<div class="page-head"><h1>Take-on from the old system</h1><p class="sub">${esc(dd.entity.tradingName || dd.entity.legalName)} · stock into ${esc(dd.store ? dd.store.name : '—')}</p></div>
    <div class="card"><h2>The order of things</h2><ol class="tk-steps">
      <li><strong>Products first.</strong> Products → Import CSV (Shopify’s format) or add them by hand; then Import costs for cost, frame price and fabric metres. The stock file below is matched to what is here.</li>
      <li><strong>Customers and balances.</strong> Export the customer list with balances from the old system. What a customer owes becomes the opening balance on their account; store credit comes across only with a document reference. Anything unclear is handed back, never guessed.</li>
      <li><strong>Stock on hand.</strong> Export the stock-on-hand report per store. Each line sets the level here by an adjustment marked Take-on. Negative stock is taken as nothing and listed; do a stock take on day one to confirm.</li>
      <li><strong>Open orders.</strong> Capture the open sales orders by hand (Sell → Sales order), recording each deposit as EFT with the old order number as the reference; a manager confirms them. Open lay-bys the same way.</li>
      <li><strong>Cut-over day.</strong> Stop selling on the old system, run the stock take here, send each debtor their statement from their card, and keep the exceptions list with the month’s papers.</li>
    </ol></div>
    <div class="grid two">
      <div class="card"><h2>Customers and balances</h2>
        <p class="muted">A CSV with columns like <em>Name, Cell, Email, VAT no, Address, Suburb, City, Code, Balance (owed), Credit limit, Store credit, Credit reference</em>. Headings are matched by name; extra columns are ignored.</p>
        <label class="btn">Choose the customers file<input type="file" id="tk-cust-file" accept=".csv,text/csv" hidden></label>
      </div>
      <div class="card"><h2>Stock on hand · ${esc(dd.store ? dd.store.name : '')}</h2>
        <p class="muted">A CSV with <em>SKU or Barcode or Product (and Variant), Qty on hand, Cost</em>. Items are found by SKU, then barcode, then name. A product with variants needs the variant’s SKU, barcode or name.</p>
        <label class="btn"${dd.store ? '' : ' disabled'}>Choose the stock file<input type="file" id="tk-stock-file" accept=".csv,text/csv" hidden${dd.store ? '' : ' disabled'}></label>
      </div>
    </div>
    <div class="card"><h2>Exceptions <span class="chip">${tk.exceptions.length}</span></h2>
      <p class="muted">What was handed back for a person to decide. Keep the CSV with the cut-over papers.</p>
      ${tk.exceptions.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Line</th><th>Who / what</th><th>Why</th></tr></thead><tbody>${tk.exceptions.slice(-200).map(x => `<tr><td class="muted">${x.line || ''}</td><td>${esc(x.what)}</td><td>${esc(x.why)}</td></tr>`).join('')}</tbody></table></div><div class="btn-row"><button class="btn" data-act="tk-exceptions">Download the exceptions CSV</button></div>` : '<p class="muted">None yet.</p>'}
      ${tk.done.length ? `<h3 class="st-h3">Done this session</h3>${tk.done.map(x => `<p class="muted">${esc(x)}</p>`).join('')}` : ''}
    </div>`;
}
export function onChange(e) {
  if (e.target.id === 'tk-cust-file' && e.target.files[0]) readFile(e.target.files[0], customersFile);
  if (e.target.id === 'tk-stock-file' && e.target.files[0]) readFile(e.target.files[0], stockFile);
  if (e.target.id === 'tk-cust-file' || e.target.id === 'tk-stock-file') e.target.value = '';
}
export function action(act) {
  if (act === 'tk-exceptions') download(toCsv([['Line', 'Who / what', 'Why', 'When'], ...tk.exceptions.map(x => [x.line || '', x.what, x.why, x.at])]), 'take-on-exceptions.csv');
}
function readFile(file, fn) { const r = new FileReader(); r.onload = () => { try { fn(String(r.result || '')); } catch (e) { toast(e.message, 'warn'); } }; r.readAsText(file); }

// -------------------------------------------------------- customers --
function customerRows(text) {
  const rows = parseCsv(text, sepOf(text));
  if (rows.length < 2) throw new Error('The file has no rows under its heading.');
  const h = rows[0].map(norm);
  const col = {
    name: find(h, ['name', 'customer', 'customername', 'account', 'accountname', 'client', 'debtor', 'fullname']), phone: find(h, ['cell', 'cellphone', 'cellno', 'cellnumber', 'phone', 'telephone', 'mobile', 'contactnumber', 'tel', 'telno', 'contact']),
    email: find(h, ['email', 'emailaddress', 'mail']), vat: find(h, ['vatno', 'vatnumber', 'vat', 'vatregno']),
    line1: find(h, ['address', 'address1', 'street', 'physicaladdress', 'postaladdress']), line2: find(h, ['address2', 'suburb', 'area']), city: find(h, ['city', 'town']), code: find(h, ['postalcode', 'code', 'postcode', 'zip']),
    owed: find(h, ['balance', 'owing', 'owed', 'amountowing', 'accountbalance', 'outstanding', 'balanceowing', 'debtorbalance', 'total', 'totalowing', 'amountdue']), limit: find(h, ['creditlimit', 'limit']),
    credit: find(h, ['storecredit', 'credit', 'creditbalance', 'creditavailable']), ref: find(h, ['creditref', 'creditreference', 'reference', 'creditnote', 'creditnoteno', 'document', 'ref'])
  };
  if (col.name < 0) throw new Error('No name column: the heading needs Name (or Customer, Account).');
  if (col.phone < 0) throw new Error('No cell number column: the heading needs Cell (or Phone, Mobile, Contact number).');
  const out = [];
  rows.slice(1).forEach((r, n) => {
    if (!r.some(x => String(x || '').trim())) return;
    const rands = (i) => { const t = cell(r, i); if (!t) return 0; const c = centsOf(t.replace(/[Rr]\s*/g, '').replace(/\s/g, '')); return Number.isFinite(c) ? c : NaN; };
    out.push({ line: n + 2, name: cell(r, col.name), phone: cell(r, col.phone), email: cell(r, col.email), vatNo: cell(r, col.vat), address: { line1: cell(r, col.line1), line2: cell(r, col.line2), city: cell(r, col.city), code: cell(r, col.code) },
      owedCents: rands(col.owed), limitCents: rands(col.limit), creditCents: rands(col.credit), creditRef: cell(r, col.ref) });
  });
  return out;
}
function customersFile(text) {
  const rows = customerRows(text);
  const bad = rows.filter(r => Number.isNaN(r.owedCents) || Number.isNaN(r.creditCents) || Number.isNaN(r.limitCents));
  const good = rows.filter(r => !bad.includes(r));
  const owed = good.reduce((n, r) => n + (r.owedCents > 0 ? r.owedCents : 0), 0), credit = good.reduce((n, r) => n + (r.creditCents > 0 && r.creditRef ? r.creditCents : 0), 0);
  const inCredit = good.filter(r => r.owedCents < 0), noRef = good.filter(r => r.creditCents > 0 && !r.creditRef), noCell = good.filter(r => !r.phone);
  let busy = false;
  openModal('Take on ' + rows.length + ' customers', `
    <p>${good.length} rows to take on: <strong>${esc(money(owed))}</strong> owed on account across ${good.filter(r => r.owedCents > 0).length} customers, <strong>${esc(money(credit))}</strong> store credit with a reference.</p>
    ${bad.length ? `<p class="warn">${bad.length} row${bad.length === 1 ? '' : 's'} with an amount that is not a number: skipped and listed.</p>` : ''}
    ${noCell.length ? `<p class="warn">${noCell.length} without a cell number: handed back (the till knows a customer by their number).</p>` : ''}
    ${inCredit.length ? `<p class="warn">${inCredit.length} account${inCredit.length === 1 ? '' : 's'} in credit (${esc(money(-inCredit.reduce((n, r) => n + r.owedCents, 0)))}): handed back to decide.</p>` : ''}
    ${noRef.length ? `<p class="warn">${noRef.length} store credit${noRef.length === 1 ? '' : 's'} without a document reference: not taken on, listed.</p>` : ''}
    <p class="muted">Customers already here (by cell number) keep their details; their balance is added once. Nothing is taken on twice.</p>`, {
    okLabel: 'Take them on', onOk: async () => {
      if (busy) return false; busy = true;
      const batchId = batch();
      bad.forEach(r => note(r.name || 'line ' + r.line, 'an amount is not a number', r.line));
      let created = 0, updated = 0, owedOn = 0, creditOn = 0;
      try {
        for (let i = 0; i < good.length; i += 100) {
          const r = await auth.api('takeOn', { batchId, rows: good.slice(i, i + 100), ...where() }, API.customer);
          created += r.created; updated += r.updated; owedOn += r.owedCents; creditOn += r.creditCents;
          (r.exceptions || []).forEach(x => note(x.name + (x.phone ? ' · ' + x.phone : ''), x.why, x.line));
        }
        tk.done.push(`Customers (${batchId}): ${created} made, ${updated} already here, ${money(owedOn)} taken on as owed, ${money(creditOn)} store credit.`);
        toast(created + ' customers made, ' + updated + ' already here · ' + money(owedOn) + ' owed taken on');
        ctx.repaint();
        return true;
      } catch (e) { busy = false; toast(e.message, 'warn'); return false; }
    }
  });
}

// ------------------------------------------------------------ stock --
function stockPlan(text) {
  const dd = d(), eid = dd.entity.id, sid = dd.store.id;
  const rows = parseCsv(text, sepOf(text));
  if (rows.length < 2) throw new Error('The file has no rows under its heading.');
  const h = rows[0].map(norm);
  const col = { sku: find(h, ['sku', 'code', 'itemcode', 'productcode', 'stockcode', 'item']), barcode: find(h, ['barcode', 'barcodes', 'ean', 'upc']), name: find(h, ['product', 'productname', 'name', 'title', 'description', 'itemdescription']), variant: find(h, ['variant', 'variantname', 'size', 'option']),
    qty: find(h, ['qty', 'quantity', 'onhand', 'qtyonhand', 'stock', 'stockonhand', 'available', 'count', 'units', 'soh', 'closingstock']), cost: find(h, ['cost', 'costprice', 'unitcost', 'costperitem', 'avgcost', 'averagecost']) };
  if (col.qty < 0) throw new Error('No quantity column: the heading needs Qty (or On hand, Stock, Quantity).');
  if (col.sku < 0 && col.barcode < 0 && col.name < 0) throw new Error('Nothing to find the items by: SKU, Barcode or Product.');
  const items = itemsOf(dd, eid);
  const index = (keyOf) => { const m = new Map(); for (const it of items) for (const k of keyOf(it)) if (k) { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(it)) m.get(k).push(it); } return m; };
  const bySku = index(it => [skuKey(it.v ? it.v.sku : it.p.sku)]), byCode = index(it => ((it.v ? it.v.barcodes : it.p.barcodes) || []).map(low)), byName = index(it => [it.v ? norm(it.p.name) + '|' + norm(it.v.name) : norm(it.p.name)]);
  const level = (itemId) => { const lv = (dd.stockLevels || []).find(x => x.storeId === sid && (x.variantId === itemId || (!x.variantId && x.productId === itemId))); return lv ? Number(lv.onHandQty) || 0 : 0; };
  const set = [], same = [], exceptions = [];
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    if (!r.some(x => String(x || '').trim())) return;
    const what = [cell(r, col.sku), cell(r, col.barcode), cell(r, col.name), cell(r, col.variant)].filter(Boolean).join(' · ') || 'line ' + line;
    const qtyText = cell(r, col.qty).replace(/\s/g, '').replace(',', '.');
    const qty = qtyText === '' ? 0 : Number(qtyText);
    if (!Number.isFinite(qty)) { exceptions.push({ line, what, why: 'the quantity is not a number: ' + cell(r, col.qty) }); return; }
    const tries = [bySku.get(skuKey(cell(r, col.sku))), byCode.get(low(cell(r, col.barcode))), cell(r, col.name) ? byName.get(norm(cell(r, col.name)) + (cell(r, col.variant) ? '|' + norm(cell(r, col.variant)) : '')) : null];
    const hit = tries.find(t => t && t.length === 1);
    if (!hit) { exceptions.push({ line, what, why: tries.some(t => t && t.length > 1) ? 'matches more than one item: give the variant' : 'not found in the catalogue' }); return; }
    const it = hit[0];
    if (it.p.hasVariants && !it.v) { exceptions.push({ line, what, why: it.p.name + ' has variants: give the variant’s SKU, barcode or name' }); return; }
    if (it.p.type !== 'stock' || it.p.trackStock === false) { exceptions.push({ line, what, why: it.label + ' does not hold stock (' + it.p.type + ')' }); return; }
    let target = Math.round(qty);
    if (target < 0) { exceptions.push({ line, what, why: 'negative stock (' + qty + ') taken as 0: count it on day one' }); target = 0; }
    const cost = col.cost >= 0 && cell(r, col.cost) ? centsOf(cell(r, col.cost).replace(/[Rr]\s*/g, '')) : null;
    const now = level(it.id), delta = target - now;
    if (!delta) { same.push(it); return; }
    set.push({ it, line, what, target, now, delta, cost: Number.isFinite(cost) && cost >= 0 ? cost : null });
  });
  return { set, same, exceptions, rows: rows.length - 1 };
}
function stockFile(text) {
  const plan = stockPlan(text);
  const dd = d();
  let busy = false;
  openModal('Take on stock at ' + dd.store.name, `
    <p>${plan.set.length} item${plan.set.length === 1 ? '' : 's'} to set, ${plan.same.length} already right, ${plan.exceptions.length} handed back.</p>
    ${plan.set.length ? `<div style="max-height:40vh;overflow:auto"><table class="tbl"><thead><tr><th>Item</th><th class="r">Here now</th><th class="r">Becomes</th><th class="r">Cost</th></tr></thead><tbody>${plan.set.slice(0, 300).map(c => `<tr><td>${esc(c.it.label)}</td><td class="r">${c.now}</td><td class="r"><strong>${c.target}</strong></td><td class="r muted">${c.cost != null ? esc(money(c.cost)) : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${plan.exceptions.length ? `<p class="warn">${plan.exceptions.slice(0, 5).map(x => esc(x.what + ': ' + x.why)).join('<br>')}${plan.exceptions.length > 5 ? '<br>…' : ''}</p>` : ''}
    <p class="muted">Each change is a stock adjustment marked Take-on, audited with your name; the cost given sets the item’s average cost.</p>`, {
    okLabel: plan.set.length ? 'Set the stock' : 'Close', onOk: async () => {
      if (busy) return false; busy = true;
      const batchId = batch();
      plan.exceptions.forEach(x => note(x.what, x.why, x.line));
      let done = 0, failed = 0;
      for (const c of plan.set) {
        try { await auth.api('adjust', { productId: c.it.p.id, variantId: c.it.v ? c.it.v.id : '', qty: c.delta, bucket: 'onHand', code: 'correction', note: 'Take-on from the old system (' + batchId + ')', ...(c.cost != null ? { unitCostCents: c.cost } : {}), adjustId: 'takeon-' + batchId + '-' + c.it.id, ...where() }, API.stock); done++; }
        catch (e) { failed++; note(c.it.label, 'not set: ' + e.message, c.line); }
      }
      if (plan.set.length) tk.done.push(`Stock at ${dd.store.name} (${batchId}): ${done} set${failed ? ', ' + failed + ' not set' : ''}, ${plan.same.length} already right, ${plan.exceptions.length} handed back.`);
      toast(done + ' items set' + (failed ? ', ' + failed + ' not set' : ''));
      if (ctx.onStock) ctx.onStock();
      ctx.repaint();
      return true;
    }
  });
}
