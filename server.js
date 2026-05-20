const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.static('public'));

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const REMADATA_API_KEY    = process.env.REMADATA_API_KEY;
const REMADATA_BASE_URL   = 'https://remadata.com/api';
const APP_URL             = process.env.APP_URL;

// ── Your markup percentage (how much profit you add on top)
const MARKUP = 1.30; // 30% markup — change this to adjust your profit

// ── Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Send public key to frontend
app.get('/config', (req, res) => {
  res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY });
});

// ── Get all plans from Remadata
app.get('/plans', async (req, res) => {
  try {
    const response = await fetch(`${REMADATA_BASE_URL}/bundles`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY }
    });
    const data = await response.json();

    if (data.status !== 'success') {
      throw new Error('Failed to fetch bundles from Remadata');
    }

    // Group by network and add your markup price
    const grouped = {};
    const networkMap = {
      mtn:       'MTN',
      airteltigo:'AirtelTigo',
      telecel:   'Telecel',
      glo:       'Glo'
    };

    data.data.forEach((bundle, index) => {
      const netKey  = bundle.network.toLowerCase();
      const netName = networkMap[netKey] || bundle.network.toUpperCase();

      if (!grouped[netName]) grouped[netName] = [];

      const costPrice  = parseFloat(bundle.price);
      const sellPrice  = parseFloat((costPrice * MARKUP).toFixed(2));
      const originalPrice = parseFloat((sellPrice * 1.32).toFixed(2)); // shown as "was" price
      const savePct    = Math.round((1 - sellPrice / originalPrice) * 100);
      const gbVal      = bundle.volumeInMB / 1024;

      grouped[netName].push({
        id:       `${netKey}-${bundle.volumeInMB}-${index}`,
        network:  netName,
        name:     bundle.name,
        gb:       gbVal % 1 === 0 ? gbVal : parseFloat(gbVal.toFixed(1)),
        volumeMB: bundle.volumeInMB,
        validity: bundle.description || '30 Days',
        price:    sellPrice,
        was:      originalPrice,
        save:     `Save ${savePct}%`,
        popular:  bundle.volumeInMB === 5120 // mark 5GB as popular
      });
    });

    res.json({ success: true, plans: grouped });
  } catch (err) {
    console.error('Plans error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch plans from Remadata' });
  }
});

// ── Initiate Paystack payment
app.post('/initiate-payment', async (req, res) => {
  const { planId, network, gb, volumeMB, validity, price, phone, email } = req.body;

  if (!planId || !phone || !price || !volumeMB || !network) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    // Save order to Supabase
    const { data: order, error: dbErr } = await supabase
      .from('orders')
      .insert({
        plan_id:    planId,
        network:    network,
        gb:         gb,
        volume_mb:  volumeMB,
        validity:   validity,
        phone:      phone,
        email:      email || null,
        amount:     price,
        status:     'pending_payment',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbErr) throw dbErr;

    // Initialize Paystack transaction
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email:        email || `${phone}@tiebideals.com`,
        amount:       Math.round(price * 100), // convert to pesewas
        currency:     'GHS',
        reference:    `TD-${order.id}-${Date.now()}`,
        metadata: {
          order_id:  order.id,
          plan_id:   planId,
          phone:     phone,
          network:   network,
          gb:        gb,
          volume_mb: volumeMB,
        },
        callback_url: `${APP_URL}/payment-success.html`,
      }),
    });

    const ps = await paystackRes.json();
    if (!ps.status) throw new Error(ps.message || 'Paystack init failed');

    await supabase
      .from('orders')
      .update({ paystack_ref: ps.data.reference })
      .eq('id', order.id);

    res.json({
      success:    true,
      orderId:    order.id,
      paymentUrl: ps.data.authorization_url,
      reference:  ps.data.reference,
    });
  } catch (err) {
    console.error('Payment init error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Paystack webhook — called automatically after payment
app.post('/webhook/paystack', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('Invalid Paystack webhook signature');
    return res.sendStatus(401);
  }

  const event = JSON.parse(req.body);

  if (event.event === 'charge.success') {
    const { metadata } = event.data;
    const { order_id, phone, network, gb, volume_mb } = metadata;

    console.log(`✅ Payment confirmed — Order ${order_id} | ${network} ${gb}GB → ${phone}`);

    // Mark as paid
    await supabase
      .from('orders')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', order_id);

    // Send data via Remadata
    await sendDataViaRemadata({ order_id, phone, network, gb, volume_mb });
  }

  res.sendStatus(200);
});

// ── Send data via Remadata
async function sendDataViaRemadata({ order_id, phone, network, gb, volume_mb }) {
  try {
    console.log(`📡 Sending ${gb}GB ${network} to ${phone}...`);

    await supabase
      .from('orders')
      .update({ status: 'sending', sending_at: new Date().toISOString() })
      .eq('id', order_id);

    const networkMap = {
      'MTN':        'mtn',
      'AirtelTigo': 'airteltigo',
      'Telecel':    'telecel',
      'Glo':        'glo',
    };

    const response = await fetch(`${REMADATA_BASE_URL}/buy-data`, {
      method: 'POST',
      headers: {
        'X-API-KEY':    REMADATA_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref:         `TD-${order_id}`,
        phone:       phone,
        volumeInMB:  volume_mb,
        networkType: networkMap[network] || network.toLowerCase(),
      }),
    });

    const data = await response.json();

    if (data.status !== 'success') {
      throw new Error(data.message || 'Remadata order failed');
    }

    console.log(`✅ Data sent successfully — Remadata ref: ${data.data.reference}`);

    await supabase
      .from('orders')
      .update({
        status:          'delivered',
        delivered_at:    new Date().toISOString(),
        remadata_ref:    data.data.reference,
        remadata_status: data.data.status,
      })
      .eq('id', order_id);

  } catch (err) {
    console.error(`❌ Remadata error for order ${order_id}:`, err.message);
    await supabase
      .from('orders')
      .update({ status: 'failed', error: err.message })
      .eq('id', order_id);
  }
}

// ── Get order status (frontend polls this every 15 seconds)
app.get('/order/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(404).json({ success: false, message: 'Order not found' });
  }
});

// ── Admin dashboard — view all orders
app.get('/admin/orders', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.sendStatus(401);
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Tiebi's Deals server running on port ${PORT}`);
});
