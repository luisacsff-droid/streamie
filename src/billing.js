// Pagos del plan Pro con Stripe Checkout (suscripción). Sin SDK: llamadas HTTP directas.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const enabled = () => Boolean(config.stripeSecret && config.stripePriceId);

async function stripe(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripeSecret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe ${res.status}`);
  return json;
}

async function checkoutUrl(user) {
  const session = await stripe('checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': config.stripePriceId,
    'line_items[0][quantity]': 1,
    client_reference_id: user.id,
    customer: user.stripeCustomer || undefined,
    customer_email: user.stripeCustomer ? undefined : user.email,
    success_url: `${config.baseUrl}/app?pago=ok`,
    cancel_url: `${config.baseUrl}/app?pago=cancelado`,
    allow_promotion_codes: 'true',
  });
  return session.url;
}

async function portalUrl(user) {
  if (!user.stripeCustomer) throw new Error('No tienes una suscripción.');
  const session = await stripe('billing_portal/sessions', {
    customer: user.stripeCustomer,
    return_url: `${config.baseUrl}/app`,
  });
  return session.url;
}

// Verifica la firma del webhook (cabecera Stripe-Signature).
function verify(rawBody, header) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2)
  );
  const sigs = String(header || '')
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto
    .createHmac('sha256', config.stripeWebhookSecret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

function handleEvent(event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const user = db.getUser(Number(obj.client_reference_id));
      if (!user) return;
      db.setStripe(user.id, obj.customer, obj.subscription);
      db.setPlan(user.id, 'pro');
      return user.id;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const user = db.getUserByCustomer(obj.customer);
      if (!user) return;
      const pro = event.type === 'customer.subscription.updated' && ACTIVE.has(obj.status);
      db.setPlan(user.id, pro ? 'pro' : 'free');
      return user.id;
    }
    default:
      return undefined;
  }
}

module.exports = { enabled, checkoutUrl, portalUrl, verify, handleEvent };
