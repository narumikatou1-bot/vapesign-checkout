// server.js — Node 20/22 OK (ESM)

// ① .env を一番最初に読む（超重要）
import 'dotenv/config';

import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// ② Stripe SDK（Webhook検証にも使用）
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ③ WooCommerce REST helpers
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const WC_BASE = mustEnv('WC_BASE_URL').replace(/\/$/, '');
const WC_CK   = mustEnv('WC_CONSUMER_KEY');
const WC_CS   = mustEnv('WC_CONSUMER_SECRET');

const UA = 'vapesign-checkout/1.1 (+https://vapesign.jp)';
const TIMEOUT_MS = 10_000;

// consumer_key / consumer_secret をURLに付ける（WAFに弾かれにくい）
function wcUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${WC_BASE}/wp-json/wc/v3${path}${sep}consumer_key=${encodeURIComponent(WC_CK)}&consumer_secret=${encodeURIComponent(WC_CS)}`;
}

async function wcFetch(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(wcUrl(path), {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': UA,
        ...(init.headers || {}),
      },
      signal: controller.signal,
      ...init,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function wcGetOrder(orderId) {
  const r = await wcFetch(`/orders/${orderId}`);
  if (!r.ok) {
    throw new Error(`Woo GET ${orderId} failed: ${r.status} ${await r.text()}`);
  }
  return r.json();
}

async function wcUpdateOrderStatus(orderId, status) {
  const r = await wcFetch(`/orders/${orderId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
  if (!r.ok) {
    throw new Error(`Woo PUT ${orderId} failed: ${r.status} ${await r.text()}`);
  }
  return r.json();
}

// ④ Webhook（必ず一番上で raw を受ける）
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,                   // ← raw body
      sig,
      mustEnv('STRIPE_WEBHOOK_SECRET')
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;                 // Checkout Session
        const orderId = parseInt(s.client_reference_id, 10);

        // ガード：ID/モード/状態
        if (!orderId || s.mode !== 'payment' || s.payment_status !== 'paid') {
          console.log('[Webhook] guard skipped:', { orderId, mode: s.mode, pay: s.payment_status });
          break;
        }

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
        // 必要に応じて他イベントも処理
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ⑤ それ以外は JSON（Webhook より下）
app.use(cors({ origin: ['https://vapesign.jp', 'https://www.vapesign.jp'] }));
app.use(express.json());

// 動作確認
app.get('/health', (_req, res) => res.send('ok'));

// ⑥ Checkout URL を作る（WPの mu‑plugin が叩く）
app.post('/api/create-checkout', async (req, res) => {
  try {
    if (req.headers['x-api-key'] !== mustEnv('INTERNAL_API_KEY')) {
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
      // 任意：24h 有効（Stripe の上限に合わせる）
      expires_at: Math.floor(Date.now()/1000) + 60*60*24,
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

// 成功ページからの照会（任意）
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
      payment_status: s.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      status: s.status,                 // 'complete' | 'open' | 'expired'
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
