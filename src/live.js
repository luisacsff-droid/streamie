// Gestiona una conexión al TikTok LIVE por streamer, con reconexión y conteo de horas.
const { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError } = require('tiktok-live-connector');
const config = require('./config');
const db = require('./db');
const hub = require('./hub');
const state = require('./state');
const pipeline = require('./pipeline');
const { getPlan } = require('./plans');

const WAIT_RETRY_MS = 60_000; // revisar cada minuto si ya empezó el LIVE
const WAIT_MAX_MS = 3 * 3600_000; // dejar de esperar tras 3 horas
const USAGE_TICK_MS = 60_000;
const MAX_ERROR_RETRIES = 5;

const lives = new Map(); // userId -> estado de conexión

function publicStatus(userId) {
  const l = lives.get(userId);
  if (!l) return { status: 'offline', message: '' };
  return { status: l.status, message: l.message, username: l.username, since: l.since, viewers: l.viewers || 0 };
}

function setStatus(userId, status, message = '') {
  const l = lives.get(userId);
  if (!l) return;
  l.status = status;
  l.message = message;
  if (status === 'live') l.since = Date.now();
  hub.send(userId, { type: 'live:status', ...publicStatus(userId) }, ['dashboard']);
}

function activeCount() {
  let n = 0;
  for (const l of lives.values()) if (l.status === 'live' || l.status === 'connecting') n++;
  return n;
}

function remainingSeconds(user) {
  const limit = getPlan(user.plan).monthlyLiveHours * 3600;
  return limit - db.getUsageSeconds(user.id);
}

// La librería ha cambiado nombres de campos entre versiones (v2: comment/giftDetails,
// v3: content/gift). Leemos ambos para no depender de una sola.
const img = (m) => m?.urlList?.[0] || m?.url?.[0] || '';

const toUser = (u = {}) => {
  const handle = u.uniqueId || u.displayId || '';
  return {
    uniqueId: handle || String(u.id || u.userId || ''),
    name: u.nickname || handle || 'alguien',
    avatar: img(u.avatarThumb) || img(u.profilePicture),
  };
};

function wire(userId, conn) {
  const emit = (event) => pipeline.handleEvent(userId, event);

  // Stickers (emotes) del chat: llegan solos o dentro de un mensaje.
  const emitStickers = (user, list) => {
    for (const e of list || []) {
      const em = e?.emote || e;
      const id = em?.emoteId || em?.emote_id;
      if (id) emit({ kind: 'sticker', user, sticker: { id: String(id), image: img(em.image) } });
    }
  };

  conn.on(WebcastEvent.CHAT, (d) => {
    const user = toUser(d.user);
    emitStickers(user, d.emotes);
    const comment = d.content ?? d.comment ?? '';
    if (!comment) return;
    emit({ kind: 'chat', user, comment });
  });

  conn.on(WebcastEvent.EMOTE, (d) => emitStickers(toUser(d.user), d.emoteList || d.emotes));

  conn.on(WebcastEvent.GIFT, (d) => {
    const g = d.gift || d.giftDetails || {};
    const type = g.type ?? g.giftType;
    // Los regalos en racha (tipo 1) llegan varias veces; solo se procesa el final.
    if (type === 1 && !d.repeatEnd) return;
    emit({
      kind: 'gift',
      user: toUser(d.user),
      gift: {
        id: d.giftId,
        name: g.name || g.giftName || 'regalo',
        image: img(g.icon) || img(g.image) || img(g.giftImage),
        diamonds: Number(g.diamondCount) || 0,
        count: Number(d.repeatCount) || 1,
      },
    });
  });

  conn.on(WebcastEvent.FOLLOW, (d) => emit({ kind: 'follow', user: toUser(d.user) }));
  conn.on(WebcastEvent.SHARE, (d) => emit({ kind: 'share', user: toUser(d.user) }));

  conn.on(WebcastEvent.ROOM_USER, (d) => {
    const l = lives.get(userId);
    if (l) l.viewers = Number(d.viewerCount ?? d.total) || 0;
  });

  conn.on(WebcastEvent.STREAM_END, () => {
    pipeline.log(userId, { kind: 'system', text: 'El LIVE terminó.' });
    stop(userId, 'El LIVE terminó.');
  });

  conn.on(ControlEvent.DISCONNECTED, () => {
    const l = lives.get(userId);
    if (!l || l.stopping) return;
    pipeline.log(userId, { kind: 'system', text: 'Se perdió la conexión, reintentando…' });
    schedule(userId, 5000);
  });

  conn.on(ControlEvent.ERROR, ({ info, exception }) => {
    console.warn(`[live ${userId}]`, info, exception?.message || '');
  });
}

function schedule(userId, ms) {
  const l = lives.get(userId);
  if (!l || l.stopping) return;
  clearTimeout(l.retryTimer);
  l.retryTimer = setTimeout(() => attempt(userId), ms);
}

async function attempt(userId) {
  const l = lives.get(userId);
  if (!l || l.stopping) return;
  const user = db.getUser(userId);
  if (!user) return stop(userId);

  if (remainingSeconds(user) <= 0) {
    return stop(userId, 'Se acabaron tus horas del mes. Pásate a Pro para seguir.');
  }
  if (activeCount() >= config.maxConnections) {
    setStatus(userId, 'waiting', 'Servidor lleno, reintentando en un minuto…');
    return schedule(userId, WAIT_RETRY_MS);
  }

  try {
    l.conn?.removeAllListeners();
    l.conn?.disconnect?.();
  } catch {
    /* ignorar */
  }

  setStatus(userId, 'connecting', `Conectando a @${l.username}…`);
  const conn = new TikTokLiveConnection(l.username, {
    signApiKey: config.eulerApiKey || undefined,
    processInitialData: false,
    enableExtendedGiftInfo: false,
  });
  l.conn = conn;
  wire(userId, conn);

  try {
    await conn.connect();
    if (l.stopping) return conn.disconnect();
    l.errors = 0;
    state.resetSession(userId);
    setStatus(userId, 'live', `Conectado al LIVE de @${l.username}`);
    pipeline.log(userId, { kind: 'system', text: `Conectado al LIVE de @${l.username}` });
  } catch (err) {
    if (l.stopping) return;
    const offline = err instanceof UserOfflineError || /offline|not.*live|isn't online/i.test(err?.message || '');
    if (offline) {
      if (Date.now() - l.startedAt > WAIT_MAX_MS) return stop(userId, 'Dejé de esperar: el LIVE no empezó en 3 horas.');
      setStatus(userId, 'waiting', `@${l.username} no está en vivo. Me conecto solo cuando empiece.`);
      return schedule(userId, WAIT_RETRY_MS);
    }
    l.errors = (l.errors || 0) + 1;
    console.warn(`[live ${userId}] error al conectar:`, err?.message);
    if (l.errors > MAX_ERROR_RETRIES) {
      const reason = /room id/i.test(err?.message || '')
        ? `No encontré a @${l.username} en TikTok. Revisa que el usuario esté bien escrito.`
        : `No pude conectar: ${err?.message || 'error desconocido'}`;
      return stop(userId, reason);
    }
    setStatus(userId, 'error', `Error al conectar (intento ${l.errors}/${MAX_ERROR_RETRIES}), reintentando…`);
    schedule(userId, 5000 * 2 ** l.errors);
  }
}

function start(user) {
  const username = (user.tiktokUsername || '').replace(/^@/, '').trim();
  if (!username) throw new Error('Primero guarda tu usuario de TikTok.');
  if (remainingSeconds(user) <= 0) throw new Error('Se acabaron tus horas del mes.');

  stop(user.id, '', true);
  const l = { username, status: 'connecting', message: '', startedAt: Date.now(), errors: 0, stopping: false };
  lives.set(user.id, l);

  // Cuenta las horas solo mientras está conectado al LIVE.
  l.usageTimer = setInterval(() => {
    if (l.status !== 'live') return;
    db.addUsage(user.id, USAGE_TICK_MS / 1000);
    const fresh = db.getUser(user.id);
    if (fresh && remainingSeconds(fresh) <= 0) stop(user.id, 'Se acabaron tus horas del mes.');
  }, USAGE_TICK_MS);

  attempt(user.id);
  return publicStatus(user.id);
}

function stop(userId, message = '', silent = false) {
  const l = lives.get(userId);
  if (!l) return;
  l.stopping = true;
  clearTimeout(l.retryTimer);
  clearInterval(l.usageTimer);
  try {
    l.conn?.removeAllListeners();
    l.conn?.disconnect?.();
  } catch {
    /* ignorar */
  }
  lives.delete(userId);
  if (!silent) hub.send(userId, { type: 'live:status', status: 'offline', message }, ['dashboard']);
}

function stopAll() {
  for (const id of [...lives.keys()]) stop(id, 'Servidor reiniciándose.');
}

module.exports = { start, stop, stopAll, publicStatus, remainingSeconds, activeCount, _wire: wire };
