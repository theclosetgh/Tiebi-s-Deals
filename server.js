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
const REMADATA_BASE_URL   = process.env.REMADATA_BASE_URL;
const APP_URL             = process.env.APP_URL;

// ── Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Send public key to frontend
app.get('/config', (req, res) => {
  res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY });
});

// ── Get plans
app.get('/plans', async (req, res) => {
  try {
    // REPLACE THIS with real Remadata API call when you have the docs:
    // const r = await fetch(`${REMADATA_BASE_URL}/plans`, {
    //   headers: { Authorization: `Token ${REMADATA_API_KEY}` }
    // });
    // const data = await r.json();
    // return res.json({ success: true, plans: data });

    const mockPlans = {
      MTN: [
        { id: 'mtn-1gb-1d',   network: 'MTN', gb: 1,  validity: '1 Day',   price: 3.50,  was: 5.00  },
        { id: 'mtn-2gb-3d',   network: 'MTN', gb: 2,  validity: '3 Days',  price: 6.00,  was: 9.00  },
        { id: 'mtn-5gb-7d',   network: 'MTN', gb: 5,  validity: '7 Days',  price: 13.00, was: 19.00, popular: true },
        { id: 'mtn-10gb-30d', network: 'MTN', gb: 10, validity: '30 Days', price: 22.00, was: 32.00 },
        { id: 'mtn-15gb-30d', network: 'MTN', gb: 15, validity: '30 Days', price: 30.00, was: 45.00 },
        { id: 'mtn-30gb-30d', network: 'MTN', gb: 30, validity: '30 Days', price: 55.00, was: 80.00 },
      ],
      AirtelTigo: [
        { id: 'at-1gb-1d',    network: 'AirtelTigo', gb: 1,  validity: '1 Day',   price: 3.00,  was: 4.50  },
        { id: 'at-3gb-3d',    network: 'AirtelTigo', gb: 3,  validity: '3 Days',  price: 7.00,  was: 10.00 },
        { id: 'at-5gb-7d',    network: 'AirtelTigo', gb: 5,  validity: '7 Days',  price: 12.00, was: 18.00, popular: true },
        { id: 'at-10gb-30d',  network: 'AirtelTigo', gb: 10, validity: '30 Days', price: 21.00, was: 30.00 },
        { id: 'at-20gb-30d',  network: 'AirtelTigo', gb: 20, validity: '30 Days', price: 38.00, was: 56.00 },
      ],
      Telecel: [
        { id: 'tc-1gb-1d',    network: 'Telecel', gb: 1,  validity: '1 Day',   price: 3.50,  was: 5.00  },
        { id: 'tc-2gb-3d',    network: 'Telecel', gb: 2,  validity: '3 Days',  price: 6.50,  was: 9.50  },
        { id: 'tc-5gb-7d',    network: 'Telecel', gb: 5,  validity: '7 Days',  price: 13.00, was: 19.00, popular: true },
        { id: 'tc-10gb-30d',  network: 'Telecel', gb: 10, validity: '30 Days', price: 23.00, was: 33.00 },
        { id: 'tc-25gb-30d',  network: 'Telecel', gb: 25, validity: '30 Days', price: 50.00, was: 73.00 },
      ],
      Glo: [
        { id: 'glo-1gb-1d',   network: 'Glo', gb: 1,  validity: '1 Day',   price: 2.80,  was: 4.00  },
        { id: 'glo-3gb-3d',   network: 'Glo', gb: 3,  validity: '3 Days',  price: 6.50,  was: 9.50, popular: true },
        { id: 'glo-5gb-7d',   network: 'Glo', gb: 5,  validity: '7 Days',  price: 11.00, was: 16.00 },
        { id: 'glo-10gb-30d', network: 'Glo', gb: 10, validity: '30 Days', price: 20.00, was: 29.00 },
      ],
    };
    res.json({ success: true, plans: mockPlans });
  } catch (err) {
    console.error('Plans error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch plans' });
  }
});

// ── Initiate payment
app.post('/initiate-payment', async (req, res) => {
  const { planId, network, gb, validity, price, phone, email } = req.body;
  if (!planId || !phone || !price) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  try {
    const { data: order, error: dbErr } = await supabase
      .from('orders')
      .insert({
        plan_id:    planId,
        network:    network,
        gb:         gb,
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

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email:        email || `${phone}@tiebideals.com`,
        amount:       Math.round(price * 100),
        currency:     'GHS',
        reference:    `TD-${order.id}-${Date.now()}`,
        metadata:     { order_id: order.id, plan_id: planId, phone, network, gb },
        callback_url: `${APP_URL}/payment-success.html`,
      }),
    });

    const ps = await paystackRes.json();
    if (!ps.status) throw new Error(ps.message || 'Paystack init failed');

    await supabase.from('orders').update({ paystack_ref: ps.data.reference }).eq('id', order.id);

    res.json({ success: true, orderId: order.id, paymentUrl: ps.data.authorization_url, reference: ps.data.reference });
  } catch (err) {
    console.error('Payment init error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Paystack webhook
app.post('/webhook/paystack', async (req, res) => {
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  if (hash !== req.headers['x-paystack-signature']) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  if (event.event === 'charge.success') {
    const { reference, metadata } = event.data;
    const { order_id, phone, network, gb, plan_id } = metadata;

    await supabase.from('orders').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', order_id);
    await sendData({ order_id, phone, network, gb, plan_id, reference });
  }
  res.sendStatus(200);
});

// ── Send data via Remadata
async function sendData({ order_id, phone, network, gb, plan_id, reference }) {
  try {
    await supabase.from('orders').update({ status: 'sending', sending_at: new Date().toISOString() }).eq('id', order_id);

    // REPLACE with real Remadata API call:
    // const r = await fetch(`${REMADATA_BASE_URL}/data/send`, {
    //   method: 'POST',
    //   headers: { Authorization: `Token ${REMADATA_API_KEY}`, 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ phone, plan_id, network })
    // });
    // const data = await r.json();
    // if (!data.success) throw new Error(data.message);

    // MOCK success after 2 seconds (remove when Remadata is live)
    await new Promise(resolve => setTimeout(resolve, 2000));

    await supabase.from('orders').update({
      status:       'delivered',
      delivered_at: new Date().toISOString(),
    }).eq('id', order_id);

    console.log(`✅ Data delivered: ${gb}GB ${network} → ${phone}`);
  } catch (err) {
    console.error('Remadata error:', err);
    await supabase.from('orders').update({ status: 'failed', error: err.message }).eq('id', order_id);
  }
}

// ── Get order status (frontend polls this)
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

// ── Admin — get all orders
app.get('/admin/orders', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.sendStatus(401);
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Tiebi's Deals server running on port ${PORT}`));
