// Base de datos PostgreSQL. En producción usa DATABASE_URL (por ejemplo, una base gratis de Neon),
// así los datos sobreviven aunque Render reinicie o duerma la app.
// Sin DATABASE_URL usa una base en memoria (solo para probar en tu computadora: se borra al cerrar).
const crypto = require('crypto');
const config = require('./config');
const { normalizeSettings } = require('./settings');

let pool;
if (config.databaseUrl) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> número de JS (fechas en milisegundos)
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => console.error('[db] error de conexión:', err.message));
} else {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();
  console.warn('⚠  Sin DATABASE_URL: los datos viven en memoria y se borran al reiniciar.');
}

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0] || null;
const all = async (text, params) => (await q(text, params)).rows;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    pass_hash       TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'free',
    tiktok_username TEXT NOT NULL DEFAULT '',
    overlay_key     TEXT NOT NULL UNIQUE,
    settings        TEXT NOT NULL DEFAULT '{}',
    stripe_customer TEXT,
    stripe_sub      TEXT,
    created_at      BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS media (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    data       BYTEA NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS media_user ON media(user_id)`,
  `CREATE TABLE IF NOT EXISTS gifts_seen (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gift_key TEXT NOT NULL,
    gift_id  TEXT NOT NULL DEFAULT '',
    name     TEXT NOT NULL,
    image    TEXT NOT NULL DEFAULT '',
    diamonds INTEGER NOT NULL DEFAULT 0,
    last_at  BIGINT NOT NULL,
    PRIMARY KEY (user_id, gift_key)
  )`,
  `CREATE TABLE IF NOT EXISTS stickers_seen (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id TEXT NOT NULL,
    image      TEXT NOT NULL DEFAULT '',
    times      INTEGER NOT NULL DEFAULT 1,
    last_at    BIGINT NOT NULL,
    PRIMARY KEY (user_id, sticker_id)
  )`,
  `CREATE TABLE IF NOT EXISTS gift_catalog (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    image      TEXT NOT NULL DEFAULT '',
    diamonds   INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS live_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month   TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
  )`,
];

// Crea las tablas si no existen. Se llama una vez al arrancar el servidor.
async function init() {
  for (const sql of SCHEMA) await q(sql);
}

const newKey = () => crypto.randomBytes(18).toString('base64url');
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

// Convierte la fila de la BD en el objeto que usa la app.
function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passHash: row.pass_hash,
    plan: row.plan,
    tiktokUsername: row.tiktok_username,
    overlayKey: row.overlay_key,
    settings: normalizeSettings(row.settings, row.plan),
    stripeCustomer: row.stripe_customer,
    stripeSub: row.stripe_sub,
  };
}

module.exports = {
  init,
  monthKey,
  close: () => pool.end(),

  // ---------- usuarios ----------
  async createUser(email, passHash) {
    const row = await one(
      'INSERT INTO users (email, pass_hash, overlay_key, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, passHash, newKey(), Date.now()]
    );
    return hydrate(row);
  },
  getUser: async (id) => hydrate(await one('SELECT * FROM users WHERE id = $1', [id])),
  getUserByEmail: async (email) => hydrate(await one('SELECT * FROM users WHERE email = $1', [email])),
  getUserByKey: async (key) => hydrate(await one('SELECT * FROM users WHERE overlay_key = $1', [key])),
  getUserByCustomer: async (c) => hydrate(await one('SELECT * FROM users WHERE stripe_customer = $1', [c])),
  saveSettings: (id, settings) => q('UPDATE users SET settings = $1 WHERE id = $2', [JSON.stringify(settings), id]),
  setUsername: (id, name) => q('UPDATE users SET tiktok_username = $1 WHERE id = $2', [name, id]),
  setPlan: (id, plan) => q('UPDATE users SET plan = $1 WHERE id = $2', [plan, id]),
  setStripe: (id, customer, sub) =>
    q('UPDATE users SET stripe_customer = $1, stripe_sub = $2 WHERE id = $3', [customer, sub, id]),
  async rotateKey(id) {
    const key = newKey();
    await q('UPDATE users SET overlay_key = $1 WHERE id = $2', [key, id]);
    return key;
  },

  // ---------- sesiones ----------
  async createSession(userId, days = 30) {
    const token = crypto.randomBytes(32).toString('base64url');
    await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, Date.now() + days * 864e5]);
    return token;
  },
  userBySession: async (token) =>
    hydrate(
      await one(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > $2',
        [token || '', Date.now()]
      )
    ),
  deleteSession: (token) => q('DELETE FROM sessions WHERE token = $1', [token]),
  purgeSessions: () => q('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]),

  // ---------- horas de LIVE ----------
  addUsage: (userId, seconds) =>
    q(
      `INSERT INTO live_usage (user_id, month, seconds) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, month) DO UPDATE SET seconds = live_usage.seconds + EXCLUDED.seconds`,
      [userId, monthKey(), Math.round(seconds)]
    ),
  getUsageSeconds: async (userId) =>
    (await one('SELECT seconds FROM live_usage WHERE user_id = $1 AND month = $2', [userId, monthKey()]))?.seconds || 0,

  // ---------- archivos subidos (sonidos e imágenes) ----------
  async addMedia(userId, { kind, mime, name, data }) {
    const id = crypto.randomBytes(16).toString('base64url');
    await q(
      'INSERT INTO media (id, user_id, kind, mime, name, size, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, userId, kind, mime, name, data.length, data, Date.now()]
    );
    return id;
  },
  listMedia: (userId) =>
    all('SELECT id, kind, mime, name, size, created_at FROM media WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
  countMedia: async (userId) => Number((await one('SELECT COUNT(*) AS n FROM media WHERE user_id = $1', [userId])).n),
  getMedia: (id) => one('SELECT id, user_id, kind, mime, size, data FROM media WHERE id = $1', [id]),
  deleteMedia: async (id, userId) =>
    (await q('DELETE FROM media WHERE id = $1 AND user_id = $2', [id, userId])).rowCount > 0,

  // ---------- regalos ----------
  rememberGift(userId, g) {
    const key = g.id ? `id:${g.id}` : `name:${String(g.name).toLowerCase()}`;
    return q(
      `INSERT INTO gifts_seen (user_id, gift_key, gift_id, name, image, diamonds, last_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, gift_key) DO UPDATE SET name = EXCLUDED.name, image = EXCLUDED.image,
         diamonds = EXCLUDED.diamonds, last_at = EXCLUDED.last_at`,
      [userId, key, String(g.id || ''), String(g.name || 'regalo').slice(0, 60), g.image || '', g.diamonds || 0, Date.now()]
    );
  },
  // Lista general de regalos de TikTok (la misma para todos los streamers).
  // keepExisting: no pisar datos ya guardados (para la lista precargada).
  async saveGiftCatalog(gifts, { keepExisting = false } = {}) {
    const now = Date.now();
    let n = 0;
    for (const g of gifts) {
      if (!g.id || !g.name) continue;
      await q(
        `INSERT INTO gift_catalog (id, name, image, diamonds, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO ${keepExisting ? 'NOTHING' : 'UPDATE SET name = EXCLUDED.name, image = EXCLUDED.image, diamonds = EXCLUDED.diamonds, updated_at = EXCLUDED.updated_at'}`,
        [String(g.id), String(g.name).slice(0, 60), g.image || '', g.diamonds || 0, now]
      );
      n++;
    }
    return n;
  },
  // Regalos para elegir: el catálogo completo más los que el streamer recibió y no estén en él.
  async listGifts(userId) {
    const catalog = await all('SELECT id, name, image, diamonds FROM gift_catalog ORDER BY diamonds ASC, name ASC');
    const ids = new Set(catalog.map((g) => g.id));
    const names = new Set(catalog.map((g) => g.name.toLowerCase()));
    const seen = await all(
      'SELECT gift_id AS id, name, image, diamonds FROM gifts_seen WHERE user_id = $1 ORDER BY last_at DESC LIMIT 150',
      [userId]
    );
    return [...catalog, ...seen.filter((g) => !(g.id && ids.has(g.id)) && !names.has(g.name.toLowerCase()))];
  },

  // ---------- stickers del chat ----------
  async rememberSticker(userId, st) {
    const image = st.image || '';
    const existing = await one('SELECT image FROM stickers_seen WHERE user_id = $1 AND sticker_id = $2', [userId, String(st.id)]);
    if (existing) {
      return q(
        'UPDATE stickers_seen SET image = $1, times = times + 1, last_at = $2 WHERE user_id = $3 AND sticker_id = $4',
        [image || existing.image, Date.now(), userId, String(st.id)]
      );
    }
    return q(
      `INSERT INTO stickers_seen (user_id, sticker_id, image, times, last_at) VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (user_id, sticker_id) DO NOTHING`,
      [userId, String(st.id), image, Date.now()]
    );
  },
  listStickers: (userId) =>
    all(
      'SELECT sticker_id AS id, image, times FROM stickers_seen WHERE user_id = $1 ORDER BY times DESC, last_at DESC LIMIT 120',
      [userId]
    ),
};
