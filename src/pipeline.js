// Ruta de cada evento del LIVE (real o simulado) hacia alertas, TTS y canciones.
const db = require('./db');
const hub = require('./hub');
const state = require('./state');
const config = require('./config');
const { getPlan } = require('./plans');
const { buildAlert } = require('./modules/alerts');
const tts = require('./modules/tts');
const songs = require('./modules/songs');

// Caché corta del usuario para no leer la BD en cada mensaje de chat.
const userCache = new Map();
function getUser(userId) {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.at < 5000) return hit.user;
  const user = db.getUser(userId);
  userCache.set(userId, { user, at: Date.now() });
  return user;
}
function invalidate(userId) {
  userCache.delete(userId);
}

function log(userId, entry) {
  state.pushLog(userId, entry);
  hub.send(userId, { type: 'log', entry: { at: Date.now(), ...entry } }, ['dashboard']);
}

const lastNoPlayerWarn = new Map();
async function speak(user, text) {
  if (!hub.count(user.id, 'player')) {
    // Nadie escuchando: no gastes en TTS, pero avisa en el panel (máx. 1 vez por minuto).
    if (Date.now() - (lastNoPlayerWarn.get(user.id) || 0) > 60_000) {
      lastNoPlayerWarn.set(user.id, Date.now());
      log(user.id, { kind: 'system', text: 'Hay voz por leer, pero el Reproductor no está abierto. Ábrelo y dale “Activar audio”.' });
    }
    return;
  }
  const msg = await tts.buildTts(text, user.settings);
  hub.send(user.id, msg, ['player']);
}

async function handleEvent(userId, event) {
  const user = getUser(userId);
  if (!user) return;
  const session = state.get(userId);

  try {
    if (event.kind === 'chat') {
      log(userId, { kind: 'chat', text: `${event.user.name}: ${event.comment}` });
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

    if (event.kind === 'gift') {
      session.gifters.add(event.user.uniqueId);
      const total = event.gift.diamonds * event.gift.count;
      log(userId, { kind: 'gift', text: `${event.user.name} envió ${event.gift.count}x ${event.gift.name} (${total} 💎)` });
      const moved = songs.onGift(user, event);
      if (moved) log(userId, { kind: 'song', text: moved });
    } else if (event.kind === 'follow' || event.kind === 'share') {
      log(userId, { kind: event.kind, text: `${event.user.name} ${event.kind === 'follow' ? 'te siguió' : 'compartió el LIVE'}` });
    } else {
      return;
    }

    const alert = buildAlert(event, user.settings);
    if (alert) {
      hub.send(userId, alert, ['alerts']);
      if (user.settings.alerts.readAloud) await speak(user, alert.text);
    }
  } catch (err) {
    console.error('[pipeline]', err);
  }
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
  };
}

function pushConfig(userId) {
  invalidate(userId);
  const user = db.getUser(userId);
  if (user) hub.send(userId, { ...helloFor(user), type: 'config' });
}

module.exports = { handleEvent, helloFor, pushConfig, invalidate, log };
