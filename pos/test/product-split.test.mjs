// Factory Manager and Factory Manager POS on two sites: the edge function
// sends each address to its own app (netlify/edge-functions/product-split.js)
// and each scheduled job runs only on its own product's site
// (netlify/functions/lib/product.mjs). With FM_PRODUCT unset, nothing changes.
import { splitTarget } from '../../netlify/edge-functions/product-split.js';
const fails = []; const check = (n, c, x) => { if (!c) fails.push(n + (x !== undefined ? ' — ' + JSON.stringify(x) : '')); };

// ---- the routing
check('POS site: the root opens the till', splitTarget('pos', 'https://pos.factorymanager.co.za/') === 'https://pos.factorymanager.co.za/pos/');
check('POS site: the root keeps its query', splitTarget('pos', 'https://pos.factorymanager.co.za/?emulator=1') === 'https://pos.factorymanager.co.za/pos/?emulator=1');
check('POS site: the till itself is left alone', splitTarget('pos', 'https://pos.factorymanager.co.za/pos/') === '' && splitTarget('pos', 'https://pos.factorymanager.co.za/pos/js/app.js') === '');
check('POS site: the factory app goes to the factory site', splitTarget('pos', 'https://pos.factorymanager.co.za/app/?pos=1') === 'https://factorymanager.co.za/app/?pos=1', splitTarget('pos', 'https://pos.factorymanager.co.za/app/?pos=1'));
check('POS site: the old /couchpotato path goes to the factory app', splitTarget('pos', 'https://pos.factorymanager.co.za/couchpotato/index.html') === 'https://factorymanager.co.za/app/index.html', splitTarget('pos', 'https://pos.factorymanager.co.za/couchpotato/index.html'));
check('POS site: the factory website goes to the factory site', splitTarget('pos', 'https://pos.factorymanager.co.za/factory-manager') === 'https://factorymanager.co.za/');
check('factory site: the till goes to the POS site', splitTarget('factory', 'https://factorymanager.co.za/pos/?emulator=1') === 'https://pos.factorymanager.co.za/pos/?emulator=1' && splitTarget('factory', 'https://factorymanager.co.za/pos') === 'https://pos.factorymanager.co.za/pos/');
check('factory site: the factory app and the website are left alone', splitTarget('factory', 'https://factorymanager.co.za/') === '' && splitTarget('factory', 'https://factorymanager.co.za/app/') === '' && splitTarget('factory', 'https://factorymanager.co.za/postcards') === '');
check('the two addresses can be overridden', splitTarget('factory', 'https://x.netlify.app/pos/', { POS_URL: 'https://till.example.co.za/' }) === 'https://till.example.co.za/pos/' && splitTarget('pos', 'https://y.netlify.app/app/', { FACTORY_URL: 'https://f.example.co.za' }) === 'https://f.example.co.za/app/');
check('no product: nothing moves', splitTarget('', 'https://factorymanager.co.za/pos/') === '' && splitTarget('', 'https://pos.factorymanager.co.za/') === '');

// ---- the schedules
const mod = await import('../../netlify/functions/lib/product.mjs');
const runs = (v, p) => { if (v == null) delete process.env.FM_PRODUCT; else process.env.FM_PRODUCT = v; return mod.runsHere(p); };
check('unset: every job runs (one site, as before)', runs(null, 'pos') && runs(null, 'factory'));
check('the POS site runs POS jobs only', runs('pos', 'pos') && !runs('pos', 'factory') && runs(' POS ', 'pos'));
check('the factory site runs factory jobs only', runs('factory', 'factory') && !runs('factory', 'pos'));
process.env.FM_PRODUCT = 'factory';
process.env.FACTORY_SERVICE_ACCOUNT = process.env.FACTORY_SERVICE_ACCOUNT || JSON.stringify({ project_id: 'x', client_email: 'x', private_key: '' });
for (const f of ['pos-shopify-sync', 'pos-factory-sync', 'pos-xero-daily']) {
  const r = await (await import(`../../netlify/functions/${f}.mjs`)).handler({});
  check(f + ' skips itself on the factory site', r.statusCode === 200 && /runs on the pos site/.test(r.body), r);
}
process.env.FM_PRODUCT = 'pos';
const poll = await (await import('../../netlify/functions/factory-shopify-poll.mjs')).handler({});
check('factory-shopify-poll skips itself on the POS site', poll.statusCode === 200 && /runs on the factory site/.test(poll.body), poll);
delete process.env.FM_PRODUCT;

console.log(JSON.stringify({ fails }, null, 1));
console.log(fails.length ? fails.length + ' FAILED' : 'product-split: all passed');
process.exit(fails.length ? 1 : 0);
