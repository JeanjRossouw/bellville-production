// The app owner's own page (admin.html): sign in, become the owner if the
// login's email is on the owner list, and see every company on the app.
// Nothing else of the app is here; the owner's own company, if any, is
// still at the normal address.
import * as store from './store.js';
import { isCloudConfigured, isDemoForced, PRODUCT } from './config.js';
import { esc, toast } from './ui.js';
import { renderClients, clientExtend, clientFree, setClients, setClientPlan } from './clients.js';

let booted = false;
let unwatchCompanies = null;

function showLogin(status) {
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
  document.getElementById('product-name').textContent = PRODUCT.name;
  document.getElementById('login-mode').innerHTML = isCloudConfigured() ? '' : isDemoForced()
    ? '<div class="notice"><strong>Demo.</strong> Sign in with any email to see the demo company. <a href="?demo=0">Go to the real page</a></div>'
    : '<div class="notice"><strong>Demo mode.</strong> No database is connected yet. Sign in with any email to see the demo company.</div>';
  const st = document.getElementById('login-status');
  st.className = 'login-status'; st.textContent = status || '';
}

// Signed in, but not the owner: say so, and how to fix it.
function showRefused(user, why) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `<div class="shell"><div class="card" style="max-width:560px;margin:3rem auto">
    <h2>Not the owner's login</h2>
    <p>You are signed in as <strong>${esc(user.email || '')}</strong>, but this login is not set up as ${esc(PRODUCT.name)}'s owner.</p>
    <p class="muted">${esc(why || '')}</p>
    <p class="muted">The owner's email address is set on the Netlify site, as the environment variable <code>FACTORY_ADMIN_EMAILS</code>. Sign in with that email, or add this one there and sign in again.</p>
    <div class="card-actions"><button class="btn ghost" data-act="retry">Try again</button><button class="btn primary" id="sign-out">Sign out</button></div>
  </div></div>`;
  app.querySelector('#sign-out').addEventListener('click', () => store.signOutNow());
  app.querySelector('[data-act=retry]').addEventListener('click', () => start(user));
}

function showClients(user) {
  document.getElementById('login').hidden = true;
  const app = document.getElementById('app');
  app.hidden = false;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-name">${esc(PRODUCT.name)}</span><span class="brand-sub">Owner</span></div>
      <div class="topbar-right">
        <div class="who"><div class="who-n">${esc(user.name || user.email || '')} <button class="who-edit" id="who-edit" type="button" title="Change the name this login shows">change</button></div><div class="who-r">${user.name && user.email && user.name !== user.email ? esc(user.email) + ' · ' : ''}owner</div></div>
        <button class="btn ghost sm" id="sign-out">Sign out</button>
      </div>
    </header>
    <main class="shell"><div id="screen"></div></main>`;
  app.querySelector('#sign-out').addEventListener('click', () => store.signOutNow());
  // the name this login goes by (the same name the app shows on the team list)
  app.querySelector('#who-edit').addEventListener('click', async () => {
    const n = prompt('Your name, as this login shows it:', user.name && user.name !== user.email ? user.name : '');
    if (n == null || !n.trim()) return;
    try { await store.setMyName(n); toast('Name saved'); showClients({ ...user, name: n.trim() }); } catch (e) { toast(e.message, 'warn'); }
  });
  const screen = app.querySelector('#screen');
  screen.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'client-extend') clientExtend(b.dataset.id);
    if (b.dataset.act === 'client-free') clientFree(b.dataset.id);
  });
  renderClients(screen);
  if (unwatchCompanies) unwatchCompanies();
  unwatchCompanies = store.watchAllCompanies(rows => { setClients(rows); renderClients(screen); });
  store.getPlan().then(r => { setClientPlan(r.plan); renderClients(screen); }).catch(() => {});
}

// Owner already → the companies. Otherwise ask the server to make this
// login the owner (it checks the email against the owner list).
async function start(user) {
  let admin = await store.isSeller();
  let why = '';
  if (!admin) {
    try { admin = !!(await store.claimSeller()).admin; }
    catch (e) { why = e.message; }
  }
  if (admin) showClients(user); else showRefused(user, why);
}

async function boot() {
  await store.initStore();
  store.onUser(async (user) => {
    if (unwatchCompanies) { unwatchCompanies(); unwatchCompanies = null; }
    setClients([]);
    if (!user) { showLogin(booted ? '' : ''); booted = true; return; }
    booted = true;
    await start(user);
  });
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const status = document.getElementById('login-status');
  status.className = 'login-status'; status.textContent = '';
  const btn = document.getElementById('login-submit'); btn.disabled = true;
  try { await store.signIn(email, pass); }
  catch (err) {
    const code = err && err.code;
    status.textContent = code === 'auth/invalid-credential' ? 'That email and password do not match.'
      : code === 'auth/invalid-email' ? 'That email address does not look right.'
      : 'Could not sign in: ' + ((err && err.message) || 'unknown error');
  } finally { btn.disabled = false; }
});
document.getElementById('login-forgot').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const status = document.getElementById('login-status');
  const r = await store.forgotPassword(email);
  status.className = 'login-status' + (r.ok ? ' ok' : ''); status.textContent = r.text;
});
boot().catch(err => { showLogin('Startup failed: ' + err.message); toast('Startup failed: ' + err.message, 'warn'); });
