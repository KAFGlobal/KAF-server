const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: ['https://kafglobaldashboard.netlify.app', 'http://localhost:3000'] }));

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_SECRET  = process.env.SHOPIFY_SECRET;
const SHOP            = process.env.SHOP_DOMAIN;
const REDIRECT_URI    = process.env.REDIRECT_URI;
const FRONTEND_URL    = 'https://kafglobaldashboard.netlify.app';
const SCOPES          = 'read_products,write_inventory,read_orders,read_customers,read_price_rules';

let ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = `https://${SHOP}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, hmac, state } = req.query;
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
    console.log('Access token obtained:', ACCESS_TOKEN);
    res.redirect(`${FRONTEND_URL}?shopify=connected`);
  } catch(e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ connected: !!ACCESS_TOKEN, shop: SHOP });
});

// ── Shopify proxy ─────────────────────────────────────────────────────────────

async function shopifyGet(endpoint) {
  const r = await fetch(`https://${SHOP}/admin/api/2024-01/${endpoint}`, {
    headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error('Shopify ' + r.status + ' — ' + await r.text());
  return r.json();
}

app.get('/shopify/shop', async (req, res) => {
  try { res.json(await shopifyGet('shop.json')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/shopify/products', async (req, res) => {
  try { res.json(await shopifyGet('products.json?limit=250&fields=id,title,variants,status')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/shopify/orders', async (req, res) => {
  try { res.json(await shopifyGet('orders.json?limit=50&status=any&fields=id,name,email,created_at,total_price,financial_status,fulfillment_status,discount_codes,total_discounts,line_items')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/shopify/customers', async (req, res) => {
  try { res.json(await shopifyGet('customers.json?limit=100&fields=id,first_name,last_name,email,orders_count,total_spent,city,country,created_at')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/shopify/discounts', async (req, res) => {
  try { res.json(await shopifyGet('price_rules.json?limit=50')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/shopify/inventory', async (req, res) => {
  try { res.json(await shopifyGet('inventory_levels.json?limit=250')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'KAF Global API running', shopify: !!ACCESS_TOKEN }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KAF server running on port ${PORT}`));
