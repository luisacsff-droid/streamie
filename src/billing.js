// Pagos del plan Pro con Mercado Pago Suscripciones (preapproval). Sin SDK: llamadas HTTP directas.
//
// Flujo:
// 1. El streamer da clic en "Pasar a Pro": creamos una suscripción "pending" con su correo de
//    Mercado Pago y lo mandamos a init_point para que pague.
// 2. Mercado Pago avisa al webhook (y también revisamos al volver a /app?pago=ok).
// 3. Nunca confiamos en lo que trae el aviso: volvemos a pedir la suscripción a la API con
//    nuestra llave y aplicamos su estado real (authorized = Pro).
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const API = 'https://api.mercadopago.com';
const MONTH = 30 * 24 * 3600_000;

const enabled = () => Boolean(config.mpAccessToken);

async function mp(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.mpAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn('[billing] Mercado Pago', res.status, json.message || json.error || '');
    throw new Error(friendlyError(json.message || json.error || ''));
  }
  return json;
}

function friendlyError(msg) {
  const m = String(msg).toLowerCase();
  if (m.includes('payer') && m.includes('email')) return 'Revisa el correo de tu cuenta de Mercado Pago.';
  if (m.includes('both') && m.includes('test')) return 'En modo de prueba, el pagador también debe ser un usuario de prueba de Mercado Pago.';
  return 'Mercado Pago no respondió bien. Intenta de nuevo en un momento.';
}

// Precios para mostrar y cuántos lugares de fundador quedan.
async function pricing() {
  const taken = config.founderSlots > 0 ? await db.countFounders() : 0;
  return {
    enabled: enabled(),
    normal: config.proPriceMxn,
    founder: config.founderPriceMxn,
    founderSlots: config.founderSlots,
    founderLeft: Math.max(0, config.founderSlots - taken),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Crea la suscripción y devuelve la página de pago de Mercado Pago.
async function checkoutUrl(user, payerEmail) {
  const email = String(payerEmail || user.email).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new Error('Escribe un correo válido.');
  // Quien ya fue fundador conserva su precio aunque haya cancelado y vuelva.
  const p = await pricing();
  const founder = user.founder || p.founderLeft > 0;
  const amount = founder ? config.founderPriceMxn : config.proPriceMxn;
  const sub = await mp('POST', '/preapproval', {
    reason: `${config.appName} Pro${founder ? ' (precio de fundador)' : ''}`,
    external_reference: `u${user.id}:${founder ? 'founder' : 'normal'}`,
    payer_email: email,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: amount,
      currency_id: 'MXN',
    },
    back_url: `${config.baseUrl}/app?pago=ok`,
    status: 'pending',
  });
  if (!sub.init_point) throw new Error('Mercado Pago no devolvió la página de pago.');
  // Se recuerda para poder revisarla al volver, aunque el webhook tarde o no llegue.
  await db.setMpSub(user.id, sub.id);
  return sub.init_point;
}

const parseRef = (ref) => {
  const m = String(ref || '').match(/^u(\d+):(founder|normal)$/);
  return m ? { userId: Number(m[1]), tier: m[2] } : null;
};
const future = (t) => (Number.isFinite(t) && t > Date.now() ? t : null);

// Fin del periodo ya pagado de una suscripción (para conservar Pro tras cancelar).
function paidUntil(pre, knownNext) {
  const next = future(Date.parse(knownNext || pre.next_payment_date));
  if (next) return next;
  const last = Date.parse(pre.summarized?.last_charged_date || '');
  return future(last + MONTH);
}

// Aplica el estado real de una suscripción a la cuenta. Devuelve el id del usuario afectado.
async function apply(pre, { knownNext } = {}) {
  const ref = parseRef(pre.external_reference);
  if (!ref) return undefined;
  const user = await db.getUser(ref.userId);
  if (!user) return undefined;

  if (pre.status === 'authorized') {
    // Cobro mínimo esperado: evita activar Pro con una suscripción de otro monto o moneda.
    const min = Math.min(config.founderPriceMxn, config.proPriceMxn);
    const amt = Number(pre.auto_recurring?.transaction_amount);
    if (pre.auto_recurring?.currency_id !== 'MXN' || !(amt >= min)) {
      console.warn('[billing] suscripción con monto inesperado', pre.id, amt);
      return undefined;
    }
    await db.setSubscription(user.id, { plan: 'pro', mpSub: pre.id, proUntil: null });
    if (ref.tier === 'founder') await db.setFounder(user.id);
    return user.id;
  }

  if (pre.status === 'cancelled' || pre.status === 'paused') {
    // Un aviso viejo de otra suscripción no debe quitarle Pro a quien ya tiene una nueva.
    if (user.mpSub && user.mpSub !== pre.id) return undefined;
    // Para saber si ya pagaba, se lee el plan guardado (sin contar los correos con Pro gratis).
    const wasPaying = (await db.getStoredPlan(user.id)) === 'pro';
    const until = wasPaying ? paidUntil(pre, knownNext) : null;
    await db.setSubscription(user.id, { plan: until ? 'pro' : 'free', mpSub: pre.id, proUntil: until });
    return user.id;
  }
  return undefined; // pending: todavía no paga
}

// Aviso de Mercado Pago (webhook). Acepta el formato nuevo (type + data.id) y el viejo (topic + id).
async function handleNotification(query, body) {
  const type = body?.type || query.type || query.topic || '';
  const id = String(body?.data?.id || query['data.id'] || query.id || '');
  if (!/^[\w-]{1,64}$/.test(id)) return undefined;
  if (type === 'subscription_preapproval' || type === 'preapproval') {
    return apply(await mp('GET', `/preapproval/${id}`));
  }
  if (type === 'subscription_authorized_payment' || type === 'authorized_payment') {
    const payment = await mp('GET', `/authorized_payments/${id}`);
    if (!payment.preapproval_id) return undefined;
    return apply(await mp('GET', `/preapproval/${payment.preapproval_id}`));
  }
  return undefined;
}

// Firma del webhook (cabecera x-signature). Es opcional: aunque no se configure, nunca se
// confía en el contenido del aviso porque la suscripción se vuelve a pedir a la API.
function verify(headers, query) {
  if (!config.mpWebhookSecret) return true;
  const parts = Object.fromEntries(
    String(headers['x-signature'] || '')
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length === 2)
  );
  if (!parts.ts || !parts.v1) return false;
  const dataId = String(query['data.id'] || '').toLowerCase();
  const reqId = String(headers['x-request-id'] || '');
  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (reqId) manifest += `request-id:${reqId};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', config.mpWebhookSecret).update(manifest).digest('hex');
  return parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}

// Revisa la suscripción guardada (al volver de pagar o al abrir "Mi suscripción").
async function sync(user) {
  if (!user.mpSub) return status(user, null);
  const pre = await mp('GET', `/preapproval/${user.mpSub}`);
  await apply(pre);
  return status(await db.getUser(user.id), pre);
}

function status(user, pre) {
  return {
    status: pre?.status || null, // pending | authorized | paused | cancelled
    plan: user.plan,
    amount: pre?.auto_recurring?.transaction_amount ?? null,
    nextPayment: pre?.status === 'authorized' ? pre.next_payment_date || null : null,
    proUntil: user.proUntil,
    founder: user.founder,
  };
}

// Cancela desde el panel. Conserva Pro hasta el final del periodo pagado.
async function cancel(user) {
  if (!user.mpSub) throw new Error('No tienes una suscripción activa.');
  const before = await mp('GET', `/preapproval/${user.mpSub}`);
  if (before.status === 'cancelled') return sync(user);
  const after = await mp('PUT', `/preapproval/${user.mpSub}`, { status: 'cancelled' });
  await apply({ ...before, ...after, status: 'cancelled' }, { knownNext: before.next_payment_date });
  return status(await db.getUser(user.id), { ...after, status: 'cancelled' });
}

module.exports = { enabled, pricing, checkoutUrl, handleNotification, verify, sync, cancel, _apply: apply };
