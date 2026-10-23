// Factory Manager and Factory Manager POS: one codebase, two sites. Each site
// says which product it is with FM_PRODUCT ('factory' or 'pos', set in the
// site's environment variables). This keeps each address to its own app:
//   on the POS site:      /  → /pos/; the factory app's paths → the factory site
//   on the factory site:  /pos/… → the POS site
// Unset, nothing is redirected (one site serving both, as before the split).
// POS_URL and FACTORY_URL override the two addresses (defaults below).
const POS_URL = 'https://pos.factorymanager.co.za';
const FACTORY_URL = 'https://factorymanager.co.za';

export function splitTarget(product, url, env = {}) {
  const u = new URL(url);
  const p = u.pathname;
  if (product === 'pos') {
    if (p === '/' || p === '') return new URL('/pos/' + u.search, u).toString();
    if (/^\/(app|couchpotato)(\/|$)/.test(p) || p === '/factory-manager') {
      const to = String(env.FACTORY_URL || FACTORY_URL).replace(/\/+$/, '');
      return to + (p === '/factory-manager' ? '/' : p.replace(/^\/couchpotato(?=\/|$)/, '/app')) + u.search;
    }
  }
  if (product === 'factory' && /^\/pos(\/|$)/.test(p)) {
    const to = String(env.POS_URL || POS_URL).replace(/\/+$/, '');
    return to + (p === '/pos' ? '/pos/' : p) + u.search;
  }
  return '';
}

export default async (request) => {
  const env = (name) => (globalThis.Netlify && Netlify.env.get(name)) || '';
  const product = env('FM_PRODUCT').trim().toLowerCase();
  if (!product) return;
  const to = splitTarget(product, request.url, { POS_URL: env('POS_URL'), FACTORY_URL: env('FACTORY_URL') });
  if (to) return Response.redirect(to, 302);
};

export const config = { path: ['/', '/pos', '/pos/*', '/app', '/app/*', '/couchpotato', '/couchpotato/*', '/factory-manager'] };
