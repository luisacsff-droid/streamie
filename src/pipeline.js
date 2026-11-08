// Ruta de cada evento del LIVE (real o simulado) hacia alertas, TTS y canciones.
const db = require('./db');
const hub = require('./hub');
const state = require('./state');
const config = require('./config');
const { getPlan } = require('./plans');
const { buildAlert, buildCustomAlert, buildStickerAlert } = require('./modules/alerts');
const tts = require('./modules/tts');
const songs = require('./modules/songs');

// Caché corta del usuario para no leer la BD en cada mensaje de chat.
const userCache = new Map();
// Guarda la promesa para que muchos mensajes seguidos hagan una sola consulta.
function getUser(userId) {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.at < 5000) return hit.promise;
  const promise = db.getUser(userId).catch((err) => {
    userCache.delete(userId);
    throw err;
  });
  userCache.set(userId, { promise, at: Date.now() });
  return promise;
}
function invalidate(userId) {
  userCache.delete(userId);
}

function log(userId, entry) {
  state.pushLog(userId, entry);
  hub.send(userId, { type: 'log', entry: { at: Date.now(), ...entry } }, ['dashboard']);
}

// Avisos en el panel cuando falta abrir un overlay (máx. 1 vez por minuto por tipo).
const lastWarn = new Map();
function warnOnce(userId, key, text) {
  const k = `${userId}|${key}`;
  if (Date.now() - (lastWarn.get(k) || 0) < 60_000) return;
  lastWarn.set(k, Date.now());
  log(userId, { kind: 'system', text });
}

function sendAlert(userId, alert) {
  if (!hub.count(userId, 'alerts')) {
    warnOnce(userId, 'alerts', 'Hay una alerta, pero el overlay de Alertas no está abierto en OBS o LIVE Studio.');
  }
  hub.send(userId, alert, ['alerts']);
}

async function speak(user, text) {
  if (!hub.count(user.id, 'player')) {
    // Nadie escuchando: no gastes en TTS, pero avisa en el panel.
    warnOnce(user.id, 'player', 'Hay voz por leer, pero el Reproductor no está abierto. Ábrelo y dale “Activar audio”.');
    return;
  }
  const msg = await tts.buildTts(text, user.settings);
  hub.send(user.id, msg, ['player']);
}

// Stickers ya conocidos por streamer (para avisar cuando aparece uno nuevo).
const knownStickers = new Map();
async function isNewSticker(userId, id) {
  if (!knownStickers.has(userId)) knownStickers.set(userId, new Set((await db.listStickers(userId)).map((x) => x.id)));
  const set = knownStickers.get(userId);
  if (set.has(id)) return false;
  set.add(id);
  return true;
}

// Evita que alguien sature el stream mandando el mismo sticker muchas veces seguidas.
const stickerCooldown = new Map();
const STICKER_COOLDOWN_MS = 4000;

async function handleSticker(user, event) {
  const st = event.sticker;
  if (!event.simulated) {
    const fresh = await isNewSticker(user.id, st.id);
    await db.rememberSticker(user.id, st);
    if (fresh) {
      log(user.id, { kind: 'sticker', user: event.user.name, text: `Sticker nuevo detectado (de ${event.user.name}). Ya puedes ponerle sonido en la pestaña Stickers.`, sticker: st });
    }
  }
  const rule = user.settings.stickerSounds.find((r) => r.stickerId === st.id);
  if (!rule) return;
  const key = `${user.id}|${event.user.uniqueId}|${st.id}`;
  if (Date.now() - (stickerCooldown.get(key) || 0) < STICKER_COOLDOWN_MS) return;
  stickerCooldown.set(key, Date.now());
  if (stickerCooldown.size > 5000) stickerCooldown.clear();
  log(user.id, { kind: 'sticker', user: event.user.name, text: `${event.user.name} mandó tu sticker 🔊`, sticker: st });
  sendAlert(user.id, buildStickerAlert(event, rule, user.settings));
}

async function handleEvent(userId, event) {
  let user;
  try {
    user = await getUser(userId);
  } catch (err) {
    return console.error('[pipeline] base de datos no disponible:', err.message);
  }
  if (!user) return;
  const session = state.get(userId);

  try {
    if (event.kind === 'chat') {
      log(userId, { kind: 'chat', user: event.user.name, text: `${event.user.name}: ${event.comment}` });
      const cmd = user.settings.songs.command.toLowerCase();
      const comment = tts.normalizeCommand(event.comment);
      if (comment.toLowerCase() === cmd || comment.toLowerCase().startsWith(cmd + ' ')) {
        const result = await songs.request(user, event, comment.slice(cmd.length).trim());
        if (result) log(userId, { kind: 'song', text: result });
        return;
      }
      const text = tts.textForChat(event, user.settings, session);
      if (text) await speak(user, text);
      return;
    }

    if (event.kind === 'sticker') return await handleSticker(user, event);

    if (event.kind === 'gift') {
      session.gifters.add(event.user.uniqueId);
      const total = event.gift.diamonds * event.gift.count;
      log(userId, { kind: 'gift', user: event.user.name, text: `${event.user.name} envió ${event.gift.count}x ${event.gift.name} (${total} 💎)` });
      if (!event.simulated) db.rememberGift(userId, event.gift).catch((err) => console.warn('[pipeline]', err.message));
      const moved = songs.onGift(user, event);
      if (moved) log(userId, { kind: 'song', text: moved });
    } else if (event.kind === 'follow' || event.kind === 'share') {
      log(userId, { kind: event.kind, user: event.user.name, text: `${event.user.name} ${event.kind === 'follow' ? 'te siguió' : 'compartió el LIVE'}` });
    } else {
      return;
    }

    const alert = buildAlert(event, user.settings);
    if (alert) {
      sendAlert(userId, alert);
      if (user.settings.alerts.readAloud) await speak(user, alert.text);
    }
  } catch (err) {
    console.error('[pipeline]', err);
  }
}

// El streamer dispara una alerta propia desde el panel.
async function fireEvent(userId, eventId, userName) {
  invalidate(userId);
  const user = await getUser(userId);
  const ev = user?.settings.events.find((e) => e.id === eventId);
  if (!ev) return false;
  const alert = buildCustomAlert(ev, userName, user.settings);
  sendAlert(userId, alert);
  log(userId, { kind: 'event', text: `Evento: ${alert.text}` });
  if (user.settings.alerts.readAloud) await speak(user, alert.text);
  return true;
}

// Mensaje de bienvenida a cada pantalla con lo que necesita para pintarse.
function helloFor(user) {
  const plan = getPlan(user.plan);
  return {
    type: 'hello',
    appName: config.appName,
    branding: plan.branding,
    plan: plan.id,
    songsVolume: user.settings.songs.volume,
    songsCommand: user.settings.songs.command,
    alertsVolume: user.settings.alerts.volume,
    visualizer: user.settings.visualizer,
  };
}

async function pushConfig(userId) {
  invalidate(userId);
  try {
    const user = await db.getUser(userId);
    if (user) hub.send(userId, { ...helloFor(user), type: 'config' });
  } catch (err) {
    console.warn('[pipeline]', err.message);
  }
}

module.exports = { handleEvent, fireEvent, helloFor, pushConfig, invalidate, log };
