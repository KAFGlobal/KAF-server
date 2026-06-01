const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_SECRET  = process.env.SHOPIFY_SECRET;
const SHOP            = process.env.SHOP_DOMAIN;
const FRONTEND_URL    = 'https://kafglobaldashboard.netlify.app';
const REDIRECT_URI    = 'https://kaf-server-production.up.railway.app/auth/callback';
const SCOPES          = 'read_products,write_inventory,read_orders,read_customers,read_price_rules';

let ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = `https://${SHOP}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, hmac } = req.query;
  const params = Object.keys(req.query).filter(k => k !== 'hmac').sort().map(k => `${k}=${req.query[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(400).send('Invalid HMAC');
  try {
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_SECRET, code })
    });
    const data = await r.json();
    ACCESS_TOKEN = data.access_token;
    res.redirect(`${FRONTEND_URL}?shopify=connected`);
  } catch(e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ connected: !!ACCESS_TOKEN, shop: SHOP });
});

app.get('/auth/token', (req, res) => {
  res.json({ token: ACCESS_TOKEN });
});

async function shopifyGet(endpoint) {
  const r = await fetch(`https://${SHOP}/admin/api/2024-01/${endpoint}`, {
    headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error('Shopify ' + r.status);
  return r.json();
}

app.get('/shopify/shop',      async (req, res) => { try { res.json(await shopifyGet('shop.json')); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/shopify/products',  async (req, res) => { try { res.json(await shopifyGet('products.json?limit=250&fields=id,title,variants,status')); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/shopify/orders',    async (req, res) => { try { res.json(await shopifyGet('orders.json?limit=50&status=any&fields=id,name,email,created_at,total_price,financial_status,fulfillment_status,discount_codes,total_discounts,line_items')); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/shopify/customers', async (req, res) => { try { res.json(await shopifyGet('customers.json?limit=100&fields=id,first_name,last_name,email,orders_count,total_spent,city,country,created_at')); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/shopify/discounts', async (req, res) => { try { res.json(await shopifyGet('price_rules.json?limit=50')); } catch(e) { res.status(500).json({ error: e.message }); } });

app.get('/sync/customers', async (req, res) => {
  try {
    const data = await shopifyGet(
      'customers.json?limit=250&fields=id,first_name,last_name,email,orders_count,total_spent,accepts_marketing,created_at'
    );

    const customers = data.customers.map(c => ({
      id: c.id,
      email: c.email,
      first_name: c.first_name,
      last_name: c.last_name,
      accepts_marketing: c.accepts_marketing,
      orders_count: c.orders_count,
      total_spent: c.total_spent,
      created_at: c.created_at
    }));

    const { error } = await supabase
      .from('customers')
      .upsert(customers);

    if (error) throw error;

    res.json({ synced: customers.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/sync/orders', async (req, res) => {
  try {
    const data = await shopifyGet(
      'orders.json?limit=250&status=any'
    );

    const orders = data.orders.map(o => ({
      id: o.id,
      order_number: o.name,
      email: o.email,
      customer_id: o.customer?.id || null,
      created_at: o.created_at,
      financial_status: o.financial_status,
      fulfillment_status: o.fulfillment_status,
      sales_channel: o.source_name,
      total_price: o.total_price,
      subtotal_price: o.subtotal_price,
      total_discounts: o.total_discounts,
      currency: o.currency
    }));

    const { error } = await supabase
      .from('orders')
      .upsert(orders);

    if (error) throw error;

    res.json({ synced: orders.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customers', async (req, res) => {
  const { data } = await supabase
    .from('customers')
    .select('*');

  res.json(data);
});

app.get('/api/orders', async (req, res) => {
  const { data } = await supabase
    .from('orders')
    .select('*');

  res.json(data);
});

app.get('/', (req, res) => res.json({ status: 'KAF Global API running', shopify: !!ACCESS_TOKEN }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`KAF server running on port ${PORT}`));
