// Factory Manager and Factory Manager POS: two products from this one
// codebase, each on its own Netlify site (factorymanager.co.za and
// pos.factorymanager.co.za), sharing one Firebase project. Each site says which
// product it is with the environment variable FM_PRODUCT ('factory' or 'pos');
// a scheduled job runs only on its own product's site, so nothing runs twice.
// Unset (one site serving both, as before the split): everything runs.
export const productHere = () => String(process.env.FM_PRODUCT || '').trim().toLowerCase();
export const runsHere = (product) => { const p = productHere(); return !p || p === product; };
export const notHere = (product) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: `This is the ${productHere()} site (FM_PRODUCT); this job runs on the ${product} site` }) });
