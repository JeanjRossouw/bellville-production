// A mock Shopify Admin API for the tests: the client-credentials token
// endpoint and a GraphQL endpoint that answers the operations the POS uses,
// recording every call. startMockShopify(port) → { calls, state, close }.
import http from 'node:http';

export function startMockShopify(port = 8799, seed = {}) {
  const state = {
    shop: { name: 'Bellville Online', host: 'bellville-online.myshopify.com' },
    locations: seed.locations || [{ id: 'gid://shopify/Location/11', name: 'Bellville shop', isActive: true, address: { city: 'Cape Town' } }, { id: 'gid://shopify/Location/12', name: 'Parow', isActive: true, address: { city: 'Cape Town' } }],
    variants: seed.variants || [],
    discounts: seed.discounts || [],
    customers: seed.customers || [],
    inventory: {},   // inventoryItemId|locationId → qty
    fulfilled: [],
    webhooks: seed.webhooks || [],   // { id, topic, callbackUrl }
    orders: seed.orders || {}
  };
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith('/admin/oauth/access_token')) {
        const b = JSON.parse(body || '{}');
        calls.push({ op: 'token', clientId: b.client_id });
        if (b.client_secret !== 'shpss_secret') return send(401, { error: 'invalid_client' });
        return send(200, { access_token: 'shpat_mock', expires_in: 86399 });
      }
      if (!req.url.endsWith('/graphql.json')) return send(404, { error: 'no' });
      if (req.headers['x-shopify-access-token'] !== 'shpat_mock') return send(401, { errors: [{ message: 'no token' }] });
      const { query, variables } = JSON.parse(body || '{}');
      const op = /productVariants\(/.test(query) ? 'variants' : /inventorySetQuantities/.test(query) ? 'setStock' : /codeDiscountNodes/.test(query) ? 'codes' : /customerCreate/.test(query) ? 'customerCreate' : /customerUpdate/.test(query) ? 'customerUpdate' : /customers\(first: 1/.test(query) ? 'customerFind' : /fulfillmentCreateV2/.test(query) ? 'fulfil' : /fulfillmentOrders/.test(query) ? 'fulfillmentOrders' : /webhookSubscriptionCreate/.test(query) ? 'hookCreate' : /webhookSubscriptionUpdate/.test(query) ? 'hookUpdate' : /webhookSubscriptionDelete/.test(query) ? 'hookDelete' : /webhookSubscriptions\(/.test(query) ? 'hooks' : /locations\(/.test(query) && /shop \{/.test(query) ? 'shop' : /locations\(/.test(query) ? 'locations' : 'unknown';
      calls.push({ op, variables });
      if (op === 'shop') return send(200, { data: { shop: { name: state.shop.name, primaryDomain: { host: state.shop.host } }, locations: { nodes: state.locations } } });
      if (op === 'locations') return send(200, { data: { locations: { nodes: state.locations } } });
      if (op === 'variants') { const after = Number(variables.after || 0); const page = state.variants.slice(after, after + 100); return send(200, { data: { productVariants: { pageInfo: { hasNextPage: after + 100 < state.variants.length, endCursor: String(after + 100) }, nodes: page } } }); }
      if (op === 'setStock') { for (const q of variables.input.quantities) state.inventory[q.inventoryItemId + '|' + q.locationId] = q.quantity; return send(200, { data: { inventorySetQuantities: { userErrors: [], inventoryAdjustmentGroup: { createdAt: new Date().toISOString() } } } }); }
      if (op === 'codes') return send(200, { data: { codeDiscountNodes: { nodes: state.discounts } } });
      if (op === 'customerFind') { const q = String(variables.q); const hit = state.customers.find(c => q === 'email:' + c.email || q === 'phone:' + c.phone); return send(200, { data: { customers: { nodes: hit ? [{ id: hit.id }] : [] } } }); }
      if (op === 'customerCreate') { const id = 'gid://shopify/Customer/' + (900 + state.customers.length); state.customers.push({ id, ...variables.input }); return send(200, { data: { customerCreate: { customer: { id }, userErrors: [] } } }); }
      if (op === 'customerUpdate') { const c = state.customers.find(x => x.id === variables.input.id); if (c) Object.assign(c, variables.input); return send(200, { data: { customerUpdate: { customer: { id: variables.input.id }, userErrors: [] } } }); }
      if (op === 'fulfillmentOrders') return send(200, { data: { order: { fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/' + variables.id.split('/').pop(), status: 'OPEN' }] } } } });
      if (op === 'hooks') return send(200, { data: { webhookSubscriptions: { nodes: state.webhooks.map(h => ({ id: h.id, topic: h.topic, endpoint: { __typename: 'WebhookHttpEndpoint', callbackUrl: h.callbackUrl } })) } } });
      if (op === 'hookCreate') { if (!/^https?:\/\//.test(variables.w.callbackUrl)) return send(200, { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['callbackUrl'], message: 'Address is not a valid URL' }] } } }); const id = 'gid://shopify/WebhookSubscription/' + (500 + state.webhooks.length); state.webhooks.push({ id, topic: variables.topic, callbackUrl: variables.w.callbackUrl }); return send(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id }, userErrors: [] } } }); }
      if (op === 'hookUpdate') { const h = state.webhooks.find(x => x.id === variables.id); if (h) h.callbackUrl = variables.w.callbackUrl; return send(200, { data: { webhookSubscriptionUpdate: { webhookSubscription: { id: variables.id }, userErrors: [] } } }); }
      if (op === 'hookDelete') { state.webhooks = state.webhooks.filter(x => x.id !== variables.id); return send(200, { data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: variables.id, userErrors: [] } } }); }
      if (op === 'fulfil') { state.fulfilled.push(variables.f.lineItemsByFulfillmentOrder[0].fulfillmentOrderId); return send(200, { data: { fulfillmentCreateV2: { fulfillment: { id: 'gid://shopify/Fulfillment/1' }, userErrors: [] } } }); }
      return send(200, { errors: [{ message: 'mock: unknown operation' }] });
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ calls, state, close: () => new Promise(r => srv.close(r)) })));
}
