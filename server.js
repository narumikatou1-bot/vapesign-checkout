// server.js  — Node 20/22 OK（ESM）
// ① .env を最初に読む
import 'dotenv/config';

import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// ② Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ③ WooCommerce REST helpers（Basic 認証で呼ぶ）
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const WC_BASE = mustEnv('WC_BASE_URL').replace(/\/$/, '');
const WC_CK   = mustEnv('WC_CONSUMER_KEY');
const WC_CS   = mustEnv('WC_CONSUMER_SECRET');

async function wcFetch(path, init = {}) {
  const url = `${WC_BASE}/wp-json/wc/v3${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // Basic 認証（クエリ渡しより WAF に弾かれにくい）
    'Authorization': 'Basic ' + Buffer.from(`${WC_CK}:${WC_CS}`).toString('base64'),
    'User-Agent': 'showermegifts-checkout/1.0 (+https://showermegifts.com)',
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  return res;
}
async function wcGetOrder(orderId) {
  const r = await wcFetch(`/orders/${orderId}`);
  if (!r.ok) throw new Error(`Woo GET ${orderId} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function wcUpdateOrderStatus(orderId, status) {
  const r = await wcFetch(`/orders/${orderId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
  if (!r.ok) throw new Error(`Woo PUT ${orderId} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ④ Webhook（**raw** で最初に置く）
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object; // Stripe Checkout Session
        const orderId = parseInt(s.client_reference_id, 10);

        if (!orderId || s.mode !== 'payment' || s.payment_status !== 'paid') break;

        try {
          const current = await wcGetOrder(orderId);
          const cur = String(current.status || '');
          if (cur === 'processing' || cur === 'completed') {
            console.log(`[Webhook] Woo order ${orderId} already ${cur}`);
          } else {
            await wcUpdateOrderStatus(orderId, 'processing');
            console.log(`[Webhook] Woo order ${orderId} -> processing`);
          }
        } catch (e) {
          console.error('[Webhook Error] Woo update failed:', e.message);
        }
        break;
      }
      case 'checkout.session.expired': {
        const s = event.data.object;
        console.log('[Webhook] expired order:', s.client_reference_id);
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ⑤ それ以外は JSON でOK（Webhook より下）
app.use(cors({ origin: ['https://showermegifts.com'] }));
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));

// チェックアウト URL を作る（WP から叩く想定）
app.post('/api/create-checkout', async (req, res) => {
  try {
    if (req.headers['x-api-key'] !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    const { orderId, amountJpy } = req.body || {};
    const oid = parseInt(orderId, 10);
    const amt = parseInt(amountJpy, 10);
    if (!oid || !Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ ok: false, error: 'BAD_INPUT' });
    }

    const appBase = mustEnv('APP_BASE_URL');
    const params = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: `Order #${oid}` },
          unit_amount: amt,
        },
        quantity: 1,
      }],
      success_url: `${appBase}/payment/success?order=${encodeURIComponent(oid)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appBase}/payment/cancel?order=${encodeURIComponent(oid)}`,
      client_reference_id: String(oid),
      expires_at: Math.floor(Date.now()/1000) + 60*60*24, // 24h
    };

    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `order-${oid}`,
    });

    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error('[create-checkout] error', e);
    res.status(500).json({ ok: false, error: e.message || 'FAILED' });
  }
});

// 任意：成功ページから照会
app.get('/api/checkout-status', async (req, res) => {
  try {
    const { cs } = req.query;
    if (!cs) return res.status(400).json({ ok:false, error:'MISSING_CS' });

    const s = await stripe.checkout.sessions.retrieve(cs, { expand: ['payment_intent'] });
    res.json({
      ok: true,
      orderId: s.client_reference_id,
      amount: s.amount_total,
      currency: s.currency,
      payment_status: s.payment_status,
      status: s.status,
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
