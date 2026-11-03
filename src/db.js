// Base de datos SQLite (un solo archivo). Para crecer mucho, migrar a Postgres.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');
const { normalizeSettings } = require('./settings');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  pass_hash       TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free',
  tiktok_username TEXT NOT NULL DEFAULT '',
  overlay_key     TEXT NOT NULL UNIQUE,
  settings        TEXT NOT NULL DEFAULT '{}',
  stripe_customer TEXT,
  stripe_sub      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_user ON media(user_id);
CREATE TABLE IF NOT EXISTS gifts_seen (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_key TEXT NOT NULL,
  gift_id  TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL,
  image    TEXT NOT NULL DEFAULT '',
  diamonds INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, gift_key)
);
CREATE TABLE IF NOT EXISTS stickers_seen (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_id TEXT NOT NULL,
  image      TEXT NOT NULL DEFAULT '',
  times      INTEGER NOT NULL DEFAULT 1,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, sticker_id)
);
CREATE TABLE IF NOT EXISTS gift_catalog (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  image      TEXT NOT NULL DEFAULT '',
  diamonds   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month   TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
`);

const newKey = () => crypto.randomBytes(18).toString('base64url');
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

const stmts = {
  insertUser: db.prepare(
    'INSERT INTO users (email, pass_hash, overlay_key, created_at) VALUES (?, ?, ?, ?)'
  ),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byKey: db.prepare('SELECT * FROM users WHERE overlay_key = ?'),
  byCustomer: db.prepare('SELECT * FROM users WHERE stripe_customer = ?'),
  setSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
  setUsername: db.prepare('UPDATE users SET tiktok_username = ? WHERE id = ?'),
  setPlan: db.prepare('UPDATE users SET plan = ? WHERE id = ?'),
  setStripe: db.prepare('UPDATE users SET stripe_customer = ?, stripe_sub = ? WHERE id = ?'),
  setKey: db.prepare('UPDATE users SET overlay_key = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  addUsage: db.prepare(`INSERT INTO usage (user_id, month, seconds) VALUES (?, ?, ?)
    ON CONFLICT(user_id, month) DO UPDATE SET seconds = seconds + excluded.seconds`),
  getUsage: db.prepare('SELECT seconds FROM usage WHERE user_id = ? AND month = ?'),
  insertMedia: db.prepare(
    'INSERT INTO media (id, user_id, kind, mime, name, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  listMedia: db.prepare(
    'SELECT id, kind, mime, name, size, created_at FROM media WHERE user_id = ? ORDER BY created_at DESC'
  ),
  countMedia: db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id = ?'),
  getMedia: db.prepare('SELECT id, user_id, kind, mime, size, data FROM media WHERE id = ?'),
  deleteMedia: db.prepare('DELETE FROM media WHERE id = ? AND user_id = ?'),
  upsertGift: db.prepare(`INSERT INTO gifts_seen (user_id, gift_key, gift_id, name, image, diamonds, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, gift_key) DO UPDATE SET name = excluded.name, image = excluded.image,
      diamonds = excluded.diamonds, last_at = excluded.last_at`),
  upsertSticker: db.prepare(`INSERT INTO stickers_seen (user_id, sticker_id, image, times, last_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_id, sticker_id) DO UPDATE SET image = CASE WHEN excluded.image != '' THEN excluded.image ELSE image END,
      times = times + 1, last_at = excluded.last_at`),
  listStickers: db.prepare(
    'SELECT sticker_id AS id, image, times FROM stickers_seen WHERE user_id = ? ORDER BY times DESC, last_at DESC LIMIT 120'
  ),
  upsertCatalog: db.prepare(`INSERT INTO gift_catalog (id, name, image, diamonds, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, image = excluded.image, diamonds = excluded.diamonds, updated_at = excluded.updated_at`),
  listCatalog: db.prepare('SELECT id, name, image, diamonds FROM gift_catalog ORDER BY diamonds ASC, name ASC'),
  listGifts: db.prepare(
    'SELECT gift_id AS id, name, image, diamonds FROM gifts_seen WHERE user_id = ? ORDER BY last_at DESC LIMIT 150'
  ),
};

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
  db,
  monthKey,
  createUser(email, passHash) {
    const info = stmts.insertUser.run(email, passHash, newKey(), Date.now());
    return hydrate(stmts.byId.get(info.lastInsertRowid));
  },
  getUser: (id) => hydrate(stmts.byId.get(id)),
  getUserByEmail: (email) => hydrate(stmts.byEmail.get(email)),
  getUserByKey: (key) => hydrate(stmts.byKey.get(key)),
  getUserByCustomer: (c) => hydrate(stmts.byCustomer.get(c)),
  saveSettings(id, settings) {
    stmts.setSettings.run(JSON.stringify(settings), id);
  },
  setUsername: (id, name) => stmts.setUsername.run(name, id),
  setPlan: (id, plan) => stmts.setPlan.run(plan, id),
  setStripe: (id, customer, sub) => stmts.setStripe.run(customer, sub, id),
  rotateKey(id) {
    const key = newKey();
    stmts.setKey.run(key, id);
    return key;
  },
  createSession(userId, days = 30) {
    const token = crypto.randomBytes(32).toString('base64url');
    stmts.insertSession.run(token, userId, Date.now() + days * 864e5);
    return token;
  },
  userBySession: (token) => hydrate(stmts.sessionUser.get(token || '', Date.now())),
  deleteSession: (token) => stmts.deleteSession.run(token),
  purgeSessions: () => stmts.purgeSessions.run(Date.now()),
  addUsage: (userId, seconds) => stmts.addUsage.run(userId, monthKey(), Math.round(seconds)),
  getUsageSeconds: (userId) => stmts.getUsage.get(userId, monthKey())?.seconds || 0,

  // Archivos subidos (sonidos e imágenes)
  addMedia(userId, { kind, mime, name, data }) {
    const id = crypto.randomBytes(16).toString('base64url');
    stmts.insertMedia.run(id, userId, kind, mime, name, data.length, data, Date.now());
    return id;
  },
  listMedia: (userId) => stmts.listMedia.all(userId),
  countMedia: (userId) => stmts.countMedia.get(userId).n,
  getMedia: (id) => stmts.getMedia.get(id),
  deleteMedia: (id, userId) => stmts.deleteMedia.run(id, userId).changes > 0,

  // Regalos que el streamer ha recibido (para elegirlos al asignar sonidos)
  rememberGift(userId, g) {
    const key = g.id ? `id:${g.id}` : `name:${String(g.name).toLowerCase()}`;
    stmts.upsertGift.run(userId, key, String(g.id || ''), String(g.name || 'regalo').slice(0, 60), g.image || '', g.diamonds || 0, Date.now());
  },
  // Lista general de regalos de TikTok (la misma para todos los streamers).
  saveGiftCatalog(gifts) {
    const now = Date.now();
    const tx = db.transaction((list) => {
      let n = 0;
      for (const g of list) {
        if (!g.id || !g.name) continue;
        stmts.upsertCatalog.run(g.id, String(g.name).slice(0, 60), g.image || '', g.diamonds || 0, now);
        n++;
      }
      return n;
    });
    return tx(gifts);
  },
  // Regalos para elegir: el catálogo completo más los que el streamer recibió y no estén en él.
  listGifts(userId) {
    const catalog = stmts.listCatalog.all();
    const ids = new Set(catalog.map((g) => g.id));
    const names = new Set(catalog.map((g) => g.name.toLowerCase()));
    const extra = stmts.listGifts.all(userId).filter((g) => !(g.id && ids.has(g.id)) && !names.has(g.name.toLowerCase()));
    return [...catalog, ...extra];
  },

  // Stickers (emotes) que han llegado en el chat del streamer
  rememberSticker: (userId, st) => stmts.upsertSticker.run(userId, String(st.id), st.image || '', Date.now()),
  listStickers: (userId) => stmts.listStickers.all(userId),
};
