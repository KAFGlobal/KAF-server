const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json());
app.use(cors({
  origin: '*'
}));

// Shopify environment variables
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_SECRET = process.env.SHOPIFY_SECRET;
const SHOP = process.env.SHOP_DOMAIN;
const FRONTEND_URL = 'https://kafglobaldashboard.netlify.app';
const REDIRECT_URI = 'https://kaf-server-production.up.railway.app/auth/callback';
const SCOPES = 'read_products,write_inventory,read_orders,read_customers,read_price_rules';

// Shopify access token
let ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

// Supabase environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('SUPABASE_URL loaded:', SUPABASE_URL ? 'YES' : 'NO');
console.log('SUPABASE_SERVICE_ROLE_KEY loaded:', SUPABASE_SERVICE_ROLE_KEY ? 'YES' : 'NO');
console.log('SHOP_DOMAIN loaded:', SHOP ? 'YES' : 'NO');
console.log('SHOPIFY_ACCESS_TOKEN loaded:', ACCESS_TOKEN ? 'YES' : 'NO');

if (!SUPABASE_URL || !SUPABASE_URL.startsWith('https://')) {
  console.error('Missing or invalid SUPABASE_URL. It must look like https://zvxmkbdcyszpjczmxxsy.supabase.co');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY');
}

if (!SHOP) {
  console.error('Missing SHOP_DOMAIN');
}

if (!ACCESS_TOKEN) {
  console.error('Missing SHOPIFY_ACCESS_TOKEN');
}

const supabase = createClient(
  SUPABASE_URL || 'https://missing.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY || 'missing-key'
);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'KAF Global API running',
    shopify: !!ACCESS_TOKEN,
    shop: SHOP || null,
    supabaseUrlLoaded: !!SUPABASE_URL,
    supabaseKeyLoaded: !!SUPABASE_SERVICE_ROLE_KEY
  });
});

// Shopify OAuth start
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');

  const url = `https://${SHOP}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

  res.redirect(url);
});

// Shopify OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, hmac } = req.query;

  const params = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(params)
    .digest('hex');

  if (digest !== hmac) {
    return res.status(400).send('Invalid HMAC');
  }

  try {
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_SECRET,
        code
      })
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json(data);
    }

    ACCESS_TOKEN = data.access_token;

    res.redirect(`${FRONTEND_URL}?shopify=connected`);
  } catch (e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

// Auth status
app.get('/auth/status', (req, res) => {
  res.json({
    connected: !!ACCESS_TOKEN,
    shop: SHOP || null
  });
});

// Existing token route
app.get('/auth/token', (req, res) => {
  res.json({
    token: ACCESS_TOKEN
  });
});

// Shopify fetch helper
async function shopifyGet(endpoint) {
  if (!SHOP) {
    throw new Error('SHOP_DOMAIN is missing in Railway variables');
  }

  if (!ACCESS_TOKEN) {
    throw new Error('SHOPIFY_ACCESS_TOKEN is missing in Railway variables');
  }

  const url = `https://${SHOP}/admin/api/2024-01/${endpoint}`;

  const r = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': ACCESS_TOKEN,
      'Content-Type': 'application/json'
    }
  });

  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!r.ok) {
    throw new Error(`Shopify ${r.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// Existing Shopify endpoints
app.get('/shopify/shop', async (req, res) => {
  try {
    res.json(await shopifyGet('shop.json'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/shopify/products', async (req, res) => {
  try {
    res.json(await shopifyGet('products.json?limit=250&fields=id,title,variants,status'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/shopify/orders', async (req, res) => {
  try {
    res.json(await shopifyGet('orders.json?limit=50&status=any&fields=id,name,email,created_at,total_price,financial_status,fulfillment_status,discount_codes,total_discounts,line_items'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/shopify/customers', async (req, res) => {
  try {
    res.json(await shopifyGet('customers.json?limit=100&fields=id,first_name,last_name,email,orders_count,total_spent,city,country,created_at'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/shopify/discounts', async (req, res) => {
  try {
    res.json(await shopifyGet('price_rules.json?limit=50'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync Shopify customers into Supabase
app.get('/sync/customers', async (req, res) => {
  try {
    const data = await shopifyGet(
      'customers.json?limit=250&fields=id,first_name,last_name,email,orders_count,total_spent,accepts_marketing,created_at'
    );

    const customers = (data.customers || []).map(c => ({
      id: c.id,
      email: c.email || null,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      accepts_marketing: !!c.accepts_marketing,
      orders_count: c.orders_count || 0,
      total_spent: c.total_spent || 0,
      created_at: c.created_at || null
    }));

    if (customers.length === 0) {
      return res.json({
        synced: 0,
        message: 'No customers found'
      });
    }

    const { error } = await supabase
      .from('customers')
      .upsert(customers);

    if (error) {
      throw error;
    }

    res.json({
      synced: customers.length,
      message: 'Customers synced to Supabase'
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

// Sync Shopify orders into Supabase
app.get('/sync/orders', async (req, res) => {
  try {
    const data = await shopifyGet(
      'orders.json?limit=250&status=any'
    );

    const orders = (data.orders || []).map(o => ({
      id: o.id,
      order_number: o.name || null,
      email: o.email || null,
      customer_id: o.customer && o.customer.id ? o.customer.id : null,
      created_at: o.created_at || null,
      financial_status: o.financial_status || null,
      fulfillment_status: o.fulfillment_status || null,
      sales_channel: o.source_name || null,
      total_price: o.total_price || 0,
      subtotal_price: o.subtotal_price || 0,
      total_discounts: o.total_discounts || 0,
      currency: o.currency || null
    }));

    if (orders.length === 0) {
      return res.json({
        synced: 0,
        message: 'No orders found'
      });
    }

    const { error } = await supabase
      .from('orders')
      .upsert(orders);

    if (error) {
      throw error;
    }

    res.json({
      synced: orders.length,
      message: 'Orders synced to Supabase'
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

// Read customers from Supabase
app.get('/api/customers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

// Read orders from Supabase
app.get('/api/orders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KAF server running on port ${PORT}`);
});
