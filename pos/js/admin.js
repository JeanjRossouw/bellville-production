// Retail POS — Admin: companies (entities), stores, registers and each
// company's settings. The owner sets up companies and stores; a manager
// looks after registers and settings within their reach. Every save
// appends an audit row saying what changed.
import { setOne, patchOne, newId, nowIso } from './db.js';
import * as auth from './auth.js';
import { esc, toast, field, row, val, checks, empty } from './ui.js';

export const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash' }, { key: 'card', label: 'Card' }, { key: 'eft', label: 'EFT' }, { key: 'qr', label: 'QR (SnapScan, Zapper)' },
  { key: 'voucher', label: 'Gift voucher' }, { key: 'storeCredit', label: 'Store credit' }, { key: 'account', label: 'On account' }
];
export const SERIES = [
  { key: 'invoicePrefix', label: 'Invoice', suffix: '' }, { key: 'creditNotePrefix', label: 'Credit note', suffix: '-CN' },
  { key: 'laybyPrefix', label: 'Lay-by', suffix: '-LB' }, { key: 'specialOrderPrefix', label: 'Special order', suffix: '-SO' },
  { key: 'poPrefix', label: 'Purchase order', suffix: '-PO' }, { key: 'grvPrefix', label: 'Goods received', suffix: '-GRV' }
];
export const defaultSettings = () => ({
  vat: { rates: [{ rateBp: 1500, effectiveFrom: '2018-04-01' }] },
  receipt: { header: '', footer: 'Thank you for your support.', returnPolicy: 'Goods may be returned within 7 days with this receipt, unused and in their packaging.' },
  discounts: { maxPctByRole: { cashier: 5, supervisor: 15, manager: 50, owner: 100 } },
  cash: { varianceLimitCents: 5000 },
  layby: { minDepositPct: 20, termDays: 90, penaltyPct: 1, frequency: 'monthly', reminderDays: 3 },
  specialOrder: { minDepositPct: 50, leadDays: 21 },
  session: { idleLogoutMinutes: 10, pinLength: 6 },
  numbering: { blockSize: 50, refillBelow: 10 },
  reports: { phone: '', email: '' },
  returns: { windowDays: 7, reasons: ['Changed mind', 'Faulty', 'Wrong item', 'Damaged', 'Other'] }
});

// rands typed on a screen → whole cents; never a float kept
export const centsOf = (s) => { const n = Number(String(s || '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
export const randsOf = (c) => (Math.round(Number(c) || 0) / 100).toFixed(2);
const CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
const codeOf = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '-');
// (the postal code's id is '-postal': '-code' is the company's or store's own code box)
const addrFields = (p, a = {}) => row(field('Street', p + '-line1', { value: a.line1 }), field('Suburb / area', p + '-line2', { value: a.line2 })) + row(field('City', p + '-city', { value: a.city }), field('Postal code', p + '-postal', { value: a.code }));
const addrOf = (w, p) => ({ line1: val(w, p + '-line1'), line2: val(w, p + '-line2'), city: val(w, p + '-city'), code: val(w, p + '-postal') });
const addrText = (a) => [a && a.line1, a && a.line2, a && a.city, a && a.code].filter(Boolean).join(', ');
const bool = (w, id) => { const e = w.querySelector('#' + id); return !!(e && e.checked); };
const check = (label, id, on) => `<label class="chk"><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${esc(label)}</label>`;

async function logChange(entityId, storeId, action, docType, docId, details) {
  try { await setOne('auditLog', newId('auditLog'), { action, docType, docId, docNo: '', actorUid: auth.session.uid, actorName: auth.session.user.name, overrideUid: '', overrideName: '', details, ...auth.stamp(entityId, storeId) }); }
  catch (e) { console.error('audit failed', e); }
}
// which top-level fields differ (for the audit row)
const changed = (before, after) => Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]) && !['updatedAt', 'updatedBy'].includes(k));

// ------------------------------------------------------------ companies --
export function companiesHtml(d) {
  const isOwner = auth.session.user.role === 'owner';
  const editing = d.editId ? d.entities.find(e => e.id === d.editId) : null;
  const e = editing || {};
  const form = !isOwner ? '' : `<div class="card" id="en-form"><h2>${editing ? 'Edit ' + esc(e.tradingName || e.legalName) : 'Add a company'}</h2>
    ${row(field('Code (short, used in document numbers; cannot change later)', 'en-code', { value: e.id, placeholder: 'e.g. BF', disabled: !!editing }), field('Trading name', 'en-trading', { value: e.tradingName, placeholder: 'e.g. Bellville Furniture' }))}
    ${row(field('Legal name', 'en-legal', { value: e.legalName, placeholder: 'e.g. Bellville Furniture (Pty) Ltd' }), field('Registration no', 'en-reg', { value: e.regNo }))}
    <div class="fld-row"><div class="fld"><span>VAT</span>${check('VAT registered', 'en-vatreg', e.vatRegistered)}</div>${field('VAT number', 'en-vatno', { value: e.vatNo, placeholder: '4…' })}</div>
    <div class="fld"><span>Document prefixes</span><div class="prefix-grid">${SERIES.map(s => `<label>${esc(s.label)}<input id="en-${s.key}" value="${esc(e[s.key] || '')}" placeholder="${esc((e.id || 'XX') + s.suffix)}"></label>`).join('')}</div></div>
    ${addrFields('en', e.address)}
    ${row(field('Phone', 'en-phone', { value: e.phone }), field('Email', 'en-email', { value: e.email, type: 'email' }))}
    ${field('Website', 'en-web', { value: e.website })}
    <div class="fld"><span>Bank details (on invoices)</span>${row(field('Bank', 'en-bank', { value: e.bank && e.bank.name }), field('Account name', 'en-bankname', { value: e.bank && e.bank.accountName }))}${row(field('Account number', 'en-bankno', { value: e.bank && e.bank.accountNo }), field('Branch code', 'en-branch', { value: e.bank && e.bank.branchCode }))}</div>
    ${editing ? check('Active', 'en-active', e.active !== false) : ''}
    <div class="card-actions"><button class="btn primary" data-act="entity-save">${editing ? 'Save' : 'Add company'}</button>${editing ? '<button class="btn ghost" data-act="entity-cancel">Cancel</button>' : ''}</div>
  </div>`;
  return `<div class="page-head"><h1>Companies</h1><p class="sub">Each legal entity: its own VAT status, numbering and invoices</p></div>
    ${form}
    ${d.entities.length ? `<div class="grid cards">${d.entities.map(x => `<div class="card${x.active === false ? ' off' : ''}">
      <h2>${esc(x.tradingName || x.legalName)} <span class="chip">${esc(x.id)}</span>${x.active === false ? ' <span class="chip">inactive</span>' : ''}</h2>
      <p>${esc(x.legalName)}${x.regNo ? ' · ' + esc(x.regNo) : ''}<br><span class="muted">${x.vatRegistered ? 'VAT registered · ' + esc(x.vatNo) : 'Not VAT registered'}</span></p>
      <p class="muted">${esc(addrText(x.address))}${x.phone ? '<br>' + esc(x.phone) : ''}${x.email ? ' · ' + esc(x.email) : ''}</p>
      <p class="muted">Invoices ${esc(x.invoicePrefix)}-000001 · credit notes ${esc(x.creditNotePrefix)}-000001</p>
      ${isOwner ? `<div class="card-actions"><button class="btn ghost sm" data-act="entity-edit" data-id="${esc(x.id)}">Edit</button></div>` : ''}
    </div>`).join('')}</div>` : empty('No companies yet', isOwner ? 'Add the first one above.' : 'The owner adds companies.')}`;
}
export async function entitySave(w, d) {
  const editing = d.editId ? d.entities.find(e => e.id === d.editId) : null;
  const id = editing ? editing.id : codeOf(val(w, 'en-code'));
  if (!CODE.test(id)) return toast('The code is letters and digits, e.g. BF or PF.', 'warn');
  if (!editing && d.entities.some(e => e.id === id)) return toast('That code is taken.', 'warn');
  const vatRegistered = bool(w, 'en-vatreg');
  const data = {
    legalName: val(w, 'en-legal'), tradingName: val(w, 'en-trading') || val(w, 'en-legal'), regNo: val(w, 'en-reg'),
    vatRegistered, vatNo: vatRegistered ? val(w, 'en-vatno') : '',
    address: addrOf(w, 'en'), phone: val(w, 'en-phone'), email: val(w, 'en-email'), website: val(w, 'en-web'),
    bank: { name: val(w, 'en-bank'), accountName: val(w, 'en-bankname'), accountNo: val(w, 'en-bankno'), branchCode: val(w, 'en-branch') },
    active: editing ? bool(w, 'en-active') : true
  };
  SERIES.forEach(s => { data[s.key] = codeOf(val(w, 'en-' + s.key)) || id + s.suffix; });
  if (!data.legalName) return toast('Fill in the legal name.', 'warn');
  if (vatRegistered && !/^\d{10}$/.test(data.vatNo)) return toast('A South African VAT number is 10 digits.', 'warn');
  try {
    if (editing) {
      await patchOne('entities', id, { ...data, ...auth.touch() });
      await logChange(id, '', 'entity.save', 'entity', id, { changed: changed(editing, data) });
      toast(data.tradingName + ' saved');
    } else {
      await setOne('entities', id, { ...data, ...auth.stamp(id, '') });
      await setOne('settings', id, { ...defaultSettings(), ...auth.stamp(id, '') });
      await logChange(id, '', 'entity.create', 'entity', id, { tradingName: data.tradingName, vatRegistered });
      toast(data.tradingName + ' added. Now add its stores, then check its Settings.');
    }
    return true;
  } catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
}

// --------------------------------------------------------------- stores --
export function storesHtml(d) {
  const isOwner = auth.session.user.role === 'owner';
  const editing = d.editId ? d.stores.find(s => s.id === d.editId) : null;
  const s = editing || {};
  const entName = (id) => { const e = d.entities.find(x => x.id === id); return e ? (e.tradingName || e.legalName) : id; };
  const form = !isOwner ? '' : !d.entities.length ? '<div class="card muted">Add a company first.</div>' : `<div class="card"><h2>${editing ? 'Edit ' + esc(s.name) : 'Add a store'}</h2>
    ${row(field('Code (cannot change later)', 'st-code', { value: s.id, placeholder: 'e.g. BF-BELL', disabled: !!editing }), field('Company', 'st-entity', { type: 'select', value: s.entityId || d.entities[0].id, options: d.entities.map(e => ({ value: e.id, label: e.tradingName || e.legalName })), disabled: !!editing }))}
    ${row(field('Store name', 'st-name', { value: s.name, placeholder: 'e.g. Bellville' }), field('Phone', 'st-phone', { value: s.phone }))}
    ${addrFields('st', s.address)}
    ${field('Email', 'st-email', { value: s.email, type: 'email' })}
    <div class="fld"><span>Payment methods at this store</span><div class="checks inline">${PAYMENT_METHODS.map(m => `<label><input type="checkbox" data-pm="${m.key}"${(s.paymentMethods || ['cash', 'card']).includes(m.key) ? ' checked' : ''}> ${esc(m.label)}</label>`).join('')}</div></div>
    ${row(field('Receipt header (blank = the company’s)', 'st-rhead', { type: 'textarea', value: s.receiptHeader }), field('Receipt footer (blank = the company’s)', 'st-rfoot', { type: 'textarea', value: s.receiptFooter }))}
    ${field('Till printer: print agent address (optional)', 'st-agent', { value: s.printAgentUrl, placeholder: 'e.g. http://192.168.0.20:9100/print — a small program on the shop network that passes the slip to the printer' })}
    ${editing ? check('Active', 'st-active', s.active !== false) : ''}
    <div class="card-actions"><button class="btn primary" data-act="store-save">${editing ? 'Save' : 'Add store'}</button>${editing ? '<button class="btn ghost" data-act="store-cancel">Cancel</button>' : ''}</div>
  </div>`;
  return `<div class="page-head"><h1>Stores</h1><p class="sub">Each store belongs to one company; registers and tills belong to a store</p></div>
    ${form}
    ${d.stores.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Store</th><th>Company</th><th>Payment methods</th><th>Address</th><th></th></tr></thead>
      <tbody>${d.stores.map(x => `<tr class="${x.active === false ? 'off' : ''}"><td><strong>${esc(x.name)}</strong> <span class="chip">${esc(x.id)}</span>${x.active === false ? ' <span class="chip">inactive</span>' : ''}</td><td>${esc(entName(x.entityId))}</td><td class="muted">${esc((x.paymentMethods || []).map(k => (PAYMENT_METHODS.find(m => m.key === k) || { label: k }).label).join(', '))}</td><td class="muted">${esc(addrText(x.address))}</td><td class="r">${isOwner ? `<button class="btn ghost sm" data-act="store-edit" data-id="${esc(x.id)}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : empty('No stores yet', isOwner ? 'Add one above.' : 'The owner adds stores.')}`;
}
export async function storeSave(w, d) {
  const editing = d.editId ? d.stores.find(s => s.id === d.editId) : null;
  const id = editing ? editing.id : codeOf(val(w, 'st-code'));
  if (!CODE.test(id)) return toast('The code is letters and digits, e.g. BF-BELL.', 'warn');
  if (!editing && d.stores.some(s => s.id === id)) return toast('That code is taken.', 'warn');
  const entityId = editing ? editing.entityId : val(w, 'st-entity');
  const data = {
    name: val(w, 'st-name'), phone: val(w, 'st-phone'), email: val(w, 'st-email'), address: addrOf(w, 'st'),
    paymentMethods: checks(w, 'data-pm'), receiptHeader: val(w, 'st-rhead'), receiptFooter: val(w, 'st-rfoot'), printAgentUrl: val(w, 'st-agent'),
    active: editing ? bool(w, 'st-active') : true
  };
  if (!data.name) return toast('Give the store a name.', 'warn');
  if (!data.paymentMethods.length) return toast('Tick at least one payment method.', 'warn');
  try {
    if (editing) { await patchOne('stores', id, { ...data, ...auth.touch() }); await logChange(entityId, id, 'store.save', 'store', id, { changed: changed(editing, data) }); toast(data.name + ' saved'); }
    else { await setOne('stores', id, { ...data, ...auth.stamp(entityId, id) }); await logChange(entityId, id, 'store.create', 'store', id, { name: data.name }); toast(data.name + ' added'); }
    return true;
  } catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
}

// ------------------------------------------------------------ registers --
export function registersHtml(d) {
  const mine = d.stores.filter(s => auth.inStore(s.id) && auth.inEntity(s.entityId));
  const editing = d.editId ? d.registers.find(r => r.id === d.editId) : null;
  const r = editing || {};
  const storeName = (id) => (d.stores.find(s => s.id === id) || { name: id }).name;
  const form = !mine.length ? '<div class="card muted">No stores yet.</div>' : `<div class="card"><h2>${editing ? 'Edit ' + esc(r.name) : 'Add a register'}</h2>
    ${row(field('Store', 'rg-store', { type: 'select', value: r.storeId || mine[0].id, options: mine.map(s => ({ value: s.id, label: s.name })), disabled: !!editing }), field('Name', 'rg-name', { value: r.name, placeholder: 'e.g. Till 1' }))}
    ${editing ? check('Active', 'rg-active', r.active !== false) : ''}
    <div class="card-actions"><button class="btn primary" data-act="register-save">${editing ? 'Save' : 'Add register'}</button>${editing ? '<button class="btn ghost" data-act="register-cancel">Cancel</button>' : ''}</div>
  </div>`;
  return `<div class="page-head"><h1>Registers</h1><p class="sub">A register is a till point with its own cash drawer and shifts</p></div>
    ${form}
    ${d.registers.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl"><thead><tr><th>Register</th><th>Store</th><th>Shift</th><th></th></tr></thead>
      <tbody>${d.registers.map(x => `<tr class="${x.active === false ? 'off' : ''}"><td><strong>${esc(x.name)}</strong>${x.active === false ? ' <span class="chip">inactive</span>' : ''}</td><td>${esc(storeName(x.storeId))}</td><td class="muted">${x.currentShiftId ? 'open' : 'closed'}</td><td class="r"><button class="btn ghost sm" data-act="register-edit" data-id="${esc(x.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>`
      : empty('No registers yet')}`;
}
export async function registerSave(w, d) {
  const editing = d.editId ? d.registers.find(r => r.id === d.editId) : null;
  const storeId = editing ? editing.storeId : val(w, 'rg-store');
  const store = d.stores.find(s => s.id === storeId);
  if (!store) return toast('Choose a store.', 'warn');
  const data = { name: val(w, 'rg-name'), active: editing ? bool(w, 'rg-active') : true };
  if (!data.name) return toast('Give the register a name.', 'warn');
  try {
    if (editing) { await patchOne('registers', editing.id, { ...data, ...auth.touch() }); await logChange(store.entityId, storeId, 'register.save', 'register', editing.id, { changed: changed(editing, data) }); toast(data.name + ' saved'); }
    else { const id = newId('registers'); await setOne('registers', id, { ...data, currentShiftId: '', ...auth.stamp(store.entityId, storeId) }); await logChange(store.entityId, storeId, 'register.create', 'register', id, { name: data.name }); toast(data.name + ' added'); }
    return true;
  } catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
}

// ------------------------------------------------------------- settings --
export function settingsHtml(d) {
  const mine = d.entities.filter(e => auth.inEntity(e.id));
  if (!mine.length) return `<div class="page-head"><h1>Settings</h1></div>${empty('No companies yet')}`;
  const eid = mine.some(e => e.id === d.settingsEntity) ? d.settingsEntity : mine[0].id;
  const s = { ...defaultSettings(), ...(d.settings[eid] || {}) };
  const ent = mine.find(e => e.id === eid);
  const pct = (role) => (s.discounts && s.discounts.maxPctByRole && s.discounts.maxPctByRole[role]) ?? defaultSettings().discounts.maxPctByRole[role];
  return `<div class="page-head"><h1>Settings</h1>
      <div class="fld" style="margin:0;min-width:220px"><select id="se-entity">${mine.map(e => `<option value="${esc(e.id)}"${e.id === eid ? ' selected' : ''}>${esc(e.tradingName || e.legalName)}</option>`).join('')}</select></div></div>
    <div id="se-form" data-entity="${esc(eid)}">
    <div class="grid two">
      <div class="card"><h2>VAT</h2>
        <p class="muted">${ent.vatRegistered ? 'VAT registered (' + esc(ent.vatNo) + '). Prices include VAT; the rate in force on the day of the sale applies.' : 'Not VAT registered: no VAT on documents. The rates below are kept for when that changes.'}</p>
        <table class="tbl" id="se-rates"><thead><tr><th>Rate %</th><th>From</th><th></th></tr></thead><tbody>
          ${(s.vat.rates || []).map((r, i) => `<tr><td><input class="in-sm" data-rate="${i}" value="${(r.rateBp / 100).toFixed(2).replace(/\.?0+$/, '')}" inputmode="decimal"></td><td><input class="in-sm" type="date" data-from="${i}" value="${esc(r.effectiveFrom)}"></td><td class="r"><button class="icon-btn" data-act="rate-del" data-i="${i}" title="Remove">✕</button></td></tr>`).join('')}
        </tbody></table>
        <div class="card-actions"><button class="btn ghost sm" data-act="rate-add">＋ Rate change</button></div>
      </div>
      <div class="card"><h2>Receipts</h2>
        ${field('Header (under the company name)', 'se-rhead', { type: 'textarea', value: s.receipt.header, placeholder: 'e.g. Shop 4, Bellville Mall · 021 000 0000' })}
        ${field('Footer', 'se-rfoot', { type: 'textarea', value: s.receipt.footer })}
        ${field('Return policy (printed on every receipt)', 'se-policy', { type: 'textarea', value: s.receipt.returnPolicy, rows: 3 })}
      </div>
      <div class="card"><h2>Discounts: the most each role may give</h2>
        <div class="grid four">${['cashier', 'supervisor', 'manager', 'owner'].map(r => field(r[0].toUpperCase() + r.slice(1) + ' %', 'se-disc-' + r, { value: pct(r), type: 'number', min: 0, max: 100 })).join('')}</div>
        <p class="muted">More than that needs the PIN of a role that may.</p>
      </div>
      <div class="card"><h2>Cash</h2>
        ${field('Variance limit at close (R)', 'se-variance', { value: randsOf(s.cash.varianceLimitCents), inputmode: 'decimal' })}
        <p class="muted">A difference between expected and counted cash beyond this needs a manager’s note.</p>
      </div>
      <div class="card"><h2>Lay-bys</h2>
        <div class="grid three">${field('Minimum deposit %', 'se-lb-dep', { value: s.layby.minDepositPct, type: 'number', min: 0, max: 100 })}${field('Longest term (days)', 'se-lb-term', { value: s.layby.termDays, type: 'number', min: 7 })}${field('Cancellation penalty % (at most 1)', 'se-lb-pen', { value: s.layby.penaltyPct, type: 'number', min: 0, max: 1, step: '0.1' })}</div>
        <div class="grid two">${field('Instalments', 'se-lb-freq', { type: 'select', value: s.layby.frequency || 'monthly', options: [{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Every two weeks' }, { value: 'monthly', label: 'Monthly' }] })}${field('Remind days before an instalment', 'se-lb-rem', { value: s.layby.reminderDays == null ? 3 : s.layby.reminderDays, type: 'number', min: 0 })}</div>
        <p class="muted">Section 62 of the Consumer Protection Act: the penalty is at most 1% of the full price, is disclosed on the agreement before the customer signs, and is never charged on death or hospitalisation.</p>
      </div>
      <div class="card"><h2>Special orders (made to order)</h2>
        <div class="grid two">${field('Minimum deposit %', 'se-so-dep', { value: (s.specialOrder || {}).minDepositPct == null ? 50 : s.specialOrder.minDepositPct, type: 'number', min: 0, max: 100 })}${field('Usual lead time (days)', 'se-so-lead', { value: (s.specialOrder || {}).leadDays == null ? 21 : s.specialOrder.leadDays, type: 'number', min: 1 })}</div>
        <p class="muted">The customer signs the specification off; no change of mind once it is in production. The factory app updates the status through the pos-special endpoint with the POS_FACTORY_KEY.</p>
      </div>
      <div class="card"><h2>Returns</h2>
        <div class="grid two">${field('Return window (days)', 'se-ret-days', { value: (s.returns || {}).windowDays, type: 'number', min: 0 })}${field('Reason codes (comma separated)', 'se-ret-reasons', { value: ((s.returns || {}).reasons || []).join(', ') })}</div>
        <p class="muted">After the window a manager’s PIN is needed. A return without a receipt is store credit only, with a manager’s PIN. A made-to-order item always needs a manager.</p>
      </div>
      <div class="card"><h2>Daily summary to the owner</h2>
        <div class="grid two">${field('WhatsApp number', 'se-rep-phone', { value: (s.reports || {}).phone, inputmode: 'tel', placeholder: '082 123 4567' })}${field('Email', 'se-rep-email', { value: (s.reports || {}).email, type: 'email' })}</div>
        <p class="muted">When a register closes, the Z-report summary is offered to send here.</p>
      </div>
      <div class="card"><h2>Tills</h2>
        <div class="grid three">${field('Lock after quiet minutes', 'se-idle', { value: s.session.idleLogoutMinutes, type: 'number', min: 1 })}${field('PIN length', 'se-pinlen', { type: 'select', value: String(s.session.pinLength), options: [4, 5, 6].map(n => ({ value: String(n), label: n + ' digits' })) })}${field('Numbers per block (offline)', 'se-block', { value: s.numbering.blockSize, type: 'number', min: 10, max: 500 })}</div>
      </div>
    </div>
    <div class="card-actions"><button class="btn primary" data-act="settings-save">Save settings</button></div>
    </div>`;
}
export function settingsRead(w) {
  const rows = [...w.querySelectorAll('#se-rates tbody tr')];
  const rates = rows.map(tr => ({ rateBp: Math.round(Number(tr.querySelector('[data-rate]').value) * 100), effectiveFrom: tr.querySelector('[data-from]').value }))
    .filter(r => Number.isFinite(r.rateBp) && r.rateBp >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const num = (id, min, max, dflt) => { const n = Number(val(w, id)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
  return {
    vat: { rates },
    receipt: { header: val(w, 'se-rhead'), footer: val(w, 'se-rfoot'), returnPolicy: val(w, 'se-policy') },
    discounts: { maxPctByRole: { cashier: num('se-disc-cashier', 0, 100, 5), supervisor: num('se-disc-supervisor', 0, 100, 15), manager: num('se-disc-manager', 0, 100, 50), owner: num('se-disc-owner', 0, 100, 100) } },
    cash: { varianceLimitCents: centsOf(val(w, 'se-variance')) },
    layby: { minDepositPct: num('se-lb-dep', 0, 100, 20), termDays: num('se-lb-term', 7, 3650, 90), penaltyPct: num('se-lb-pen', 0, 1, 1), frequency: val(w, 'se-lb-freq') || 'monthly', reminderDays: num('se-lb-rem', 0, 60, 3) },
    specialOrder: { minDepositPct: num('se-so-dep', 0, 100, 50), leadDays: num('se-so-lead', 1, 365, 21) },
    session: { idleLogoutMinutes: num('se-idle', 1, 1440, 10), pinLength: num('se-pinlen', 4, 6, 6) },
    numbering: { blockSize: num('se-block', 10, 500, 50), refillBelow: 10 },
    reports: { phone: val(w, 'se-rep-phone'), email: val(w, 'se-rep-email') },
    returns: { windowDays: num('se-ret-days', 0, 3650, 7), reasons: val(w, 'se-ret-reasons').split(',').map(x => x.trim()).filter(Boolean) }
  };
}
export async function settingsSave(w, d) {
  const eid = w.querySelector('#se-form').dataset.entity;
  const data = settingsRead(w);
  if (!data.vat.rates.length) return toast('Keep at least one VAT rate with a date.', 'warn');
  const before = d.settings[eid] || null;
  try {
    if (before) await patchOne('settings', eid, { ...data, ...auth.touch() });
    else await setOne('settings', eid, { ...data, ...auth.stamp(eid, '') });
    await logChange(eid, '', 'settings.save', 'settings', eid, { changed: changed(before || {}, data) });
    auth.setIdleMinutes(data.session.idleLogoutMinutes);
    toast('Settings saved');
    return true;
  } catch (e) { toast('Could not save: ' + e.message, 'warn'); return false; }
}
// add/remove a VAT rate row without losing what is typed elsewhere
export function rateAdd(w) {
  const tb = w.querySelector('#se-rates tbody'); const i = tb.children.length;
  tb.insertAdjacentHTML('beforeend', `<tr><td><input class="in-sm" data-rate="${i}" value="15" inputmode="decimal"></td><td><input class="in-sm" type="date" data-from="${i}" value="${nowIso().slice(0, 10)}"></td><td class="r"><button class="icon-btn" data-act="rate-del" data-i="${i}" title="Remove">✕</button></td></tr>`);
}
export function rateDel(w, i) { const tr = w.querySelectorAll('#se-rates tbody tr')[Number(i)]; if (tr) tr.remove(); }
