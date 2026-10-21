// Suppliers — who the business buys from, for the factory and the shop alike.
//   suppliers/<id>   name, contact (the person), phone (WhatsApp / cell),
//                    officePhone, email, account (our account no. with them), notes
// What is bought from whom lives on the item: materials/<id>.buyFrom and
// shopProducts/<variant>.buyFrom = [{ supplier, price, code, notes, main }],
// with the main supplier also in .supplier (and its price in the cost).
// The supplier sheet (js/suppliersheet.js) fills all of this from Excel.
import * as store from './store.js';
import { allMaterials } from './costing.js';
import { esc, field, row, val, openModal, toast, empty, money, waDigits } from './ui.js';

let suppliers = [];
let unwatch = null;
let onChange = null;
let settings = {};
export const mayReadSuppliers = () => ['pos', 'stock', 'storeroom'].some(a => store.can(a));
export const mayEditSuppliers = () => store.can('pos', 'edit') || store.can('stock', 'edit');
export function startSuppliers(cb, cfg) {
  onChange = cb; settings = cfg || {};
  if (unwatch) unwatch();
  if (!mayReadSuppliers()) { suppliers = []; return; }
  unwatch = store.watch('suppliers', rows => { suppliers = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); if (onChange) onChange(); });
}
export const setSupplierSettings = (cfg) => { settings = cfg || {}; };
export const allSuppliers = () => suppliers;
const key = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const supplierByName = (name) => { const k = key(name); return k ? suppliers.find(s => key(s.name) === k) || null : null; };

export function editSupplier(id) {
  const sp = suppliers.find(x => x.id === id) || {};
  openModal(id ? 'Edit ' + sp.name : 'New supplier',
    row(field('Supplier', 'sp-name', { value: sp.name }), field('Contact person', 'sp-contact', { value: sp.contact, placeholder: 'The rep or the person you deal with' }))
    + row(field('WhatsApp / cell', 'sp-phone', { value: sp.phone }), field('Email', 'sp-email', { type: 'email', value: sp.email }))
    + row(field('Office phone', 'sp-office', { value: sp.officePhone }), field('Account no. with them', 'sp-acc', { value: sp.account }))
    + field('Notes', 'sp-notes', { type: 'textarea', value: sp.notes, placeholder: 'Order days, minimums, delivery times…' }), {
    okLabel: id ? 'Save' : 'Add',
    onOk: async (w) => {
      const name = val(w, 'sp-name').trim(); if (!name) { toast('Give the supplier a name', 'warn'); return false; }
      const other = supplierByName(name); if (other && other.id !== id) { toast(name + ' is already on the list', 'warn'); return false; }
      const d = { name, contact: val(w, 'sp-contact'), phone: val(w, 'sp-phone'), email: val(w, 'sp-email'), officePhone: val(w, 'sp-office'), account: val(w, 'sp-acc'), notes: val(w, 'sp-notes') };
      if (id) await store.update('suppliers', id, d); else await store.create('suppliers', d);
      toast(name + (id ? ' saved' : ' added'));
    }
  });
}

// What a supplier supplies (materials), with their price.
export function suppliesOf(name) {
  const k = key(name);
  const out = [];
  allMaterials().forEach(m => {
    const rows = (m.buyFrom || []).filter(b => key(b.supplier) === k);
    if (rows.length) rows.forEach(b => out.push({ name: m.name, unit: m.unit || '', price: b.price, code: b.code || '', main: !!b.main || key(m.supplier) === k }));
    else if (key(m.supplier) === k) out.push({ name: m.name, unit: m.unit || '', price: m.cost, code: '', main: true });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The Suppliers tab on the Stock screen.
export function suppliersTabHtml() {
  const cur = settings.currency || 'R';
  const names = [...new Set(allMaterials().map(m => m.supplier).filter(Boolean))].filter(n => !supplierByName(n));
  return `<div class="card">
    <div class="dl-run-head"><h2>Suppliers (${suppliers.length})</h2><div class="btn-row">
      <button class="btn ghost" data-act="sup-sheet-dl" title="An Excel sheet with your suppliers and what you buy from them, to fill in">⬇ Supplier sheet</button>
      ${mayEditSuppliers() ? '<button class="btn ghost" data-act="sup-sheet-im" title="Bring the filled-in supplier sheet back in">⬆ Import supplier sheet</button><button class="btn primary" data-act="sup-new">＋ Supplier</button>' : ''}</div></div>
    <p class="muted">Download the supplier sheet, fill in each supplier’s contact details and, on the second sheet, what you buy from them (pick the item from the list) and the price. Then import it here.</p>
    ${names.length ? `<p class="notice-inline">On your materials but not on the list yet: ${names.map(esc).join(', ')}. They are on the supplier sheet, ready for their details.</p>` : ''}
    ${suppliers.length ? `<table class="tbl"><thead><tr><th>Supplier</th><th>Contact</th><th>What you buy</th><th></th></tr></thead><tbody>${suppliers.map(sp => {
      const items = suppliesOf(sp.name);
      return `<tr><td><strong>${esc(sp.name)}</strong>${sp.account ? '<div class="muted">Account ' + esc(sp.account) + '</div>' : ''}${sp.notes ? '<div class="muted">' + esc(sp.notes) + '</div>' : ''}</td>
        <td>${sp.contact ? esc(sp.contact) + '<br>' : ''}${sp.phone ? `<a href="https://wa.me/${esc(waDigits(sp.phone))}" target="_blank" rel="noopener">WhatsApp ${esc(sp.phone)}</a><br>` : ''}${sp.email ? `<a href="mailto:${esc(sp.email)}">${esc(sp.email)}</a><br>` : ''}${sp.officePhone ? esc(sp.officePhone) : ''}</td>
        <td>${items.length ? items.slice(0, 8).map(it => esc(it.name) + (it.price != null && it.price !== '' ? ' <span class="muted">' + esc(money(it.price, cur)) + (it.unit ? '/' + esc(it.unit) : '') + '</span>' : '') + (it.main ? '' : ' <span class="chip calm">2nd</span>')).join('<br>') + (items.length > 8 ? '<br><span class="muted">+ ' + (items.length - 8) + ' more</span>' : '') : '<span class="muted">nothing linked yet</span>'}</td>
        <td class="r nowrap">${mayEditSuppliers() ? `<button class="btn ghost sm" data-act="sup-edit" data-id="${esc(sp.id)}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : empty('', 'No suppliers yet', 'Download the supplier sheet, fill it in and import it, or add them one by one.')}
  </div>`;
}
