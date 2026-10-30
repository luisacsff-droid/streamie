// Servidor principal: API del panel, páginas, overlays y WebSocket.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const config = require('./config');
const db = require('./db');
const hub = require('./hub');
const live = require('./live');
const state = require('./state');
const billing = require('./billing');
const pipeline = require('./pipeline');
const songs = require('./modules/songs');
const { normalizeSettings } = require('./settings');
const { getPlan, PLANS, PREMIUM_VOICES } = require('./plans');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'streamie_session';

// ---------- utilidades ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Límite simple de intentos por IP (login/registro).
const attempts = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Demasiados intentos, espera un momento.' });
    list.push(now);
    attempts.set(key, list);
    next();
  };
}
setInterval(() => attempts.clear(), 15 * 60_000).unref();

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 30 * 864e5,
  });
}

function auth(req, res, next) {
  const user = db.userBySession(req.cookies[COOKIE]);
  if (!user) return res.status(401).json({ error: 'Inicia sesión.' });
  req.user = user;
  next();
}

function overlayUrls(user) {
  const k = encodeURIComponent(user.overlayKey);
  return {
    alerts: `${config.baseUrl}/o/alerts?k=${k}`,
    player: `${config.baseUrl}/o/player?k=${k}`,
    songs: `${config.baseUrl}/o/songs?k=${k}`,
  };
}

function me(user) {
  const plan = getPlan(user.plan);
  const used = db.getUsageSeconds(user.id);
  return {
    email: user.email,
    plan: plan.id,
    planInfo: plan,
    plans: PLANS,
    tiktokUsername: user.tiktokUsername,
    settings: user.settings,
    overlayKey: user.overlayKey,
    overlays: overlayUrls(user),
    usage: { usedSeconds: used, limitSeconds: plan.monthlyLiveHours * 3600 },
    voices: PREMIUM_VOICES,
    features: {
      billing: billing.enabled(),
      premiumTts: Boolean(config.googleTtsKey),
      youtubeSearch: Boolean(config.youtubeKey),
      signing: Boolean(config.eulerApiKey),
    },
    live: live.publicStatus(user.id),
    isAdmin: config.adminEmails.includes(user.email),
    appName: config.appName,
  };
}

// ---------- webhook de Stripe (necesita el cuerpo crudo, va antes de express.json) ----------
app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    if (!config.stripeWebhookSecret) return res.status(400).send('webhook no configurado');
    const raw = req.body.toString('utf8');
    if (!billing.verify(raw, req.get('stripe-signature'))) return res.status(400).send('firma inválida');
    const userId = billing.handleEvent(JSON.parse(raw));
    if (userId) pipeline.pushConfig(userId);
    res.json({ received: true });
  }
);

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// Las API que cambian datos solo aceptan JSON (protección básica contra CSRF junto con SameSite).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Se esperaba JSON.' });
  }
  next();
});

// ---------- cuenta ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post(
  '/api/register',
  rateLimit(10, 15 * 60_000),
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'Correo inválido.');
    if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
    if (db.getUserByEmail(email)) throw new HttpError(409, 'Ese correo ya tiene cuenta.');
    const user = db.createUser(email, await bcrypt.hash(password, 10));
    setSessionCookie(res, db.createSession(user.id));
    res.json(me(user));
  })
);

app.post(
  '/api/login',
  rateLimit(20, 15 * 60_000),
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.getUserByEmail(email);
    const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.passHash));
    if (!ok) throw new HttpError(401, 'Correo o contraseña incorrectos.');
    setSessionCookie(res, db.createSession(user.id));
    res.json(me(user));
  })
);

app.post('/api/logout', (req, res) => {
  if (req.cookies[COOKIE]) db.deleteSession(req.cookies[COOKIE]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(me(req.user)));

// ---------- configuración ----------
app.put('/api/tiktok', auth, (req, res) => {
  const name = String(req.body.username || '').trim().replace(/^@/, '');
  if (name && !/^[\w.]{2,24}$/.test(name)) throw new HttpError(400, 'Usuario de TikTok inválido.');
  db.setUsername(req.user.id, name);
  res.json(me(db.getUser(req.user.id)));
});

app.put('/api/settings', auth, (req, res) => {
  // Mezcla lo recibido sobre lo actual y valida contra el plan.
  const merged = normalizeSettings(deepAssign(structuredClone(req.user.settings), req.body), req.user.plan);
  db.saveSettings(req.user.id, merged);
  pipeline.pushConfig(req.user.id);
  res.json(me(db.getUser(req.user.id)));
});

function deepAssign(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

app.post('/api/overlay-key/rotate', auth, (req, res) => {
  hub.kick(req.user.id);
  db.rotateKey(req.user.id);
  res.json(me(db.getUser(req.user.id)));
});

// ---------- conexión al LIVE ----------
app.post('/api/live/start', auth, (req, res) => {
  try {
    live.start(req.user);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  res.json(live.publicStatus(req.user.id));
});

app.post('/api/live/stop', auth, (req, res) => {
  live.stop(req.user.id, 'Desconectado.');
  res.json({ status: 'offline' });
});

app.get('/api/log', auth, (req, res) => res.json(state.get(req.user.id).log));

// ---------- pruebas (eventos simulados) ----------
const FAKE_NAMES = ['luna_gamer', 'el_profe_mx', 'sofi.dance', 'carlitos99', 'mariana_live', 'tacos_al_pastor'];
const FAKE_GIFTS = [
  { name: 'Rosa', diamonds: 1 },
  { name: 'TikTok', diamonds: 1 },
  { name: 'Corazón', diamonds: 5 },
  { name: 'Dona', diamonds: 30 },
  { name: 'Sombrero', diamonds: 99 },
  { name: 'León', diamonds: 29999 },
];
const pick = (a) => a[crypto.randomInt(a.length)];

app.post(
  '/api/test/:kind',
  auth,
  wrap(async (req, res) => {
    const kind = req.params.kind;
    if (!['chat', 'gift', 'follow', 'share'].includes(kind)) throw new HttpError(400, 'Tipo inválido.');
    const name = String(req.body.user || '').trim().slice(0, 30) || pick(FAKE_NAMES);
    const event = { kind, simulated: true, user: { uniqueId: name, name, avatar: '' } };
    if (kind === 'chat') {
      event.comment = String(req.body.comment || '¡Hola desde la prueba!').slice(0, 300);
    }
    if (kind === 'gift') {
      const g = pick(FAKE_GIFTS);
      event.gift = { id: 0, name: g.name, image: '', diamonds: g.diamonds, count: 1 + crypto.randomInt(5) };
    }
    await pipeline.handleEvent(req.user.id, event);
    res.json({ ok: true });
  })
);

// ---------- canciones ----------
app.get('/api/songs', auth, (req, res) => res.json(songs.snapshot(req.user.id)));
app.post('/api/songs/:action', auth, (req, res) => {
  try {
    songs.control(req.user.id, req.params.action, String(req.body.songId || ''));
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  res.json(songs.snapshot(req.user.id));
});

// ---------- pagos ----------
app.post(
  '/api/billing/checkout',
  auth,
  wrap(async (req, res) => {
    if (!billing.enabled()) throw new HttpError(400, 'Los pagos aún no están configurados.');
    res.json({ url: await billing.checkoutUrl(req.user) });
  })
);
app.post(
  '/api/billing/portal',
  auth,
  wrap(async (req, res) => {
    if (!billing.enabled()) throw new HttpError(400, 'Los pagos aún no están configurados.');
    res.json({ url: await billing.portalUrl(req.user) });
  })
);

// ---------- administración ----------
app.post('/api/admin/plan', auth, (req, res) => {
  if (!config.adminEmails.includes(req.user.email)) throw new HttpError(403, 'Solo administradores.');
  const target = db.getUserByEmail(String(req.body.email || '').trim().toLowerCase());
  if (!target) throw new HttpError(404, 'Usuario no encontrado.');
  if (!PLANS[req.body.plan]) throw new HttpError(400, 'Plan inválido.');
  db.setPlan(target.id, req.body.plan);
  pipeline.pushConfig(target.id);
  res.json({ ok: true });
});

// ---------- páginas ----------
app.get('/health', (req, res) => res.json({ ok: true, live: live.activeCount() }));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC, 'dashboard.html')));
app.get('/o/alerts', (req, res) => res.sendFile(path.join(PUBLIC, 'overlay-alerts.html')));
app.get('/o/player', (req, res) => res.sendFile(path.join(PUBLIC, 'player.html')));
app.get('/o/songs', (req, res) => res.sendFile(path.join(PUBLIC, 'overlay-songs.html')));
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));

// ---------- errores ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno.' : err.message });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
hub.attach(server);

hub.onJoin((userId, role, ws) => {
  const user = db.getUser(userId);
  hub.sendTo(ws, pipeline.helloFor(user));
  if (role === 'player' || role === 'songs' || role === 'dashboard') hub.sendTo(ws, songs.snapshot(userId));
  if (role === 'dashboard') hub.sendTo(ws, { type: 'live:status', ...live.publicStatus(userId) });
});

hub.onMessage((userId, role, msg) => {
  if (role === 'player') songs.onPlayerMessage(userId, msg);
});

setInterval(() => db.purgeSessions(), 6 * 3600_000).unref();

server.listen(config.port, () => {
  console.log(`${config.appName} escuchando en ${config.baseUrl}`);
  if (!config.eulerApiKey) console.warn('⚠  Falta EULER_API_KEY: la conexión al LIVE puede fallar o limitarse.');
  if (!config.youtubeKey) console.warn('ℹ  Sin YOUTUBE_API_KEY: song request solo acepta links de YouTube.');
  if (!config.googleTtsKey) console.warn('ℹ  Sin GOOGLE_TTS_API_KEY: TTS usa solo la voz del navegador.');
});

function shutdown() {
  live.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
