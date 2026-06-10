import { Router, Request, Response } from 'express';
import { db, nowISO } from './db';
import { config } from './config';
import { Authed } from './auth';

export const payments = Router();

// Create a Stripe Checkout Session for an order (parent storefront). Stub if no key.
payments.post('/orders/:id/checkout', async (req: Authed, res: Response) => {
  const order: any = db.prepare('SELECT * FROM orders WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (!config.stripe.secret) {
    return res.json({ configured: false, message: 'Set STRIPE_SECRET_KEY in .env to enable real checkout.', amount: order.amount });
  }
  try {
    const body = new URLSearchParams();
    body.append('mode', 'payment');
    body.append('success_url', config.stripe.successUrl);
    body.append('cancel_url', config.stripe.cancelUrl);
    body.append('client_reference_id', order.id);
    body.append('line_items[0][quantity]', '1');
    body.append('line_items[0][price_data][currency]', 'usd');
    body.append('line_items[0][price_data][unit_amount]', String(Math.round((order.amount || 0) * 100)));
    body.append('line_items[0][price_data][product_data][name]', `${order.package} — ${order.athlete_name || 'order'}`);
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.stripe.secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const session: any = await r.json();
    if (!r.ok) return res.status(502).json(session);
    res.json({ configured: true, url: session.url, id: session.id });
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

// Stripe webhook. Mounted with a raw body parser in index.ts.
// DEV NOTE: production must verify the Stripe-Signature header with STRIPE_WEBHOOK_SECRET
// (use the `stripe` npm package's constructEvent). This starter trusts the body in dev.
export function stripeWebhook(req: Request, res: Response) {
  let event: any;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('bad payload'); }
  if (event.type === 'checkout.session.completed') {
    const orderId = event.data?.object?.client_reference_id;
    const pi = event.data?.object?.payment_intent;
    if (orderId) {
      db.prepare("UPDATE orders SET paid = 1, paid_at = ?, stripe_payment_intent = ? WHERE id = ?").run(nowISO(), pi || null, orderId);
      // Production: also release the purchased original/high-res photos here.
    }
  }
  res.json({ received: true });
}

export const stripeEnabled = !!config.stripe.secret;
