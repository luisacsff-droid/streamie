// Song request: los viewers piden canciones con "!sr <nombre o link de YouTube>".
const config = require('../config');
const state = require('../state');
const hub = require('../hub');

const ROLES = ['player', 'songs', 'dashboard'];
const searchCache = new Map();

function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/i
  );
  return m ? m[1] : null;
}

function parseIsoDuration(iso) {
  const m = String(iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function yt(path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: config.youtubeKey })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  return res.json();
}

// Resuelve texto o link a { videoId, title, durationSec, embeddable }.
async function resolve(query) {
  const id = parseVideoId(query);

  if (!config.youtubeKey) {
    if (!id) throw new Error('La búsqueda por nombre requiere YOUTUBE_API_KEY; manda un link de YouTube.');
    let title = `Video ${id}`;
    try {
      const r = await fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://youtu.be/' + id)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) title = (await r.json()).title || title;
    } catch {
      /* sin red: se usa el título genérico */
    }
    return { videoId: id, title, durationSec: 0, embeddable: true };
  }

  let videoId = id;
  if (!videoId) {
    const key = query.toLowerCase().trim();
    if (searchCache.has(key)) {
      videoId = searchCache.get(key);
    } else {
      // search.list cuesta 100 unidades de la cuota diaria (10,000 por defecto); por eso se cachea.
      const data = await yt('search', {
        part: 'snippet',
        type: 'video',
        videoEmbeddable: 'true',
        maxResults: '1',
        q: query,
      });
      videoId = data.items?.[0]?.id?.videoId;
      if (!videoId) throw new Error('No encontré esa canción.');
      if (searchCache.size > 2000) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(key, videoId);
    }
  }

  const info = await yt('videos', { part: 'snippet,contentDetails,status', id: videoId });
  const v = info.items?.[0];
  if (!v) throw new Error('Ese video no existe o es privado.');
  return {
    videoId,
    title: v.snippet.title,
    durationSec: parseIsoDuration(v.contentDetails.duration),
    embeddable: v.status.embeddable !== false,
  };
}

function snapshot(userId) {
  const { current, queue, paused } = state.get(userId).songs;
  return { type: 'songs:state', current, queue, paused };
}

function broadcast(userId) {
  hub.send(userId, snapshot(userId), ROLES);
}

// Procesa "!sr ..." de un viewer. Devuelve un texto para el registro del panel.
async function request(user, event, query) {
  const g = user.settings.songs;
  const session = state.get(user.id);
  const songs = session.songs;
  const who = event.user;

  if (!g.enabled) return null;
  if (!query) return `${who.name}: falta el nombre de la canción`;
  if (g.giftOnly && !session.gifters.has(who.uniqueId)) return `${who.name}: solo quien regala puede pedir canciones`;

  const waiting = songs.queue.length;
  if (waiting >= g.maxQueue) return `${who.name}: la cola está llena (${g.maxQueue})`;
  const mine = songs.queue.filter((s) => s.requestedBy.uniqueId === who.uniqueId).length;
  if (mine >= g.maxPerUser) return `${who.name}: ya tienes ${mine} canción(es) en cola`;

  let video;
  try {
    video = await resolve(query);
  } catch (err) {
    return `${who.name}: ${err.message}`;
  }
  if (!video.embeddable) return `${who.name}: "${video.title}" no se puede reproducir fuera de YouTube`;
  if (video.durationSec && video.durationSec > g.maxDurationSec) {
    return `${who.name}: "${video.title}" dura más de ${Math.round(g.maxDurationSec / 60)} min`;
  }
  if ([songs.current, ...songs.queue].some((s) => s && s.videoId === video.videoId)) {
    return `${who.name}: "${video.title}" ya está en la cola`;
  }

  const item = {
    id: `s${++songs.seq}`,
    ...video,
    requestedBy: { uniqueId: who.uniqueId, name: who.name, avatar: who.avatar },
    status: g.requireApproval ? 'pending' : 'queued',
    priority: false,
    at: Date.now(),
  };
  songs.queue.push(item);
  if (!songs.current && item.status === 'queued') next(user.id);
  else broadcast(user.id);
  return `${who.name} pidió "${video.title}"${item.status === 'pending' ? ' (espera aprobación)' : ''}`;
}

// Pasa a la siguiente canción aprobada.
function next(userId) {
  const songs = state.get(userId).songs;
  const idx = songs.queue.findIndex((s) => s.status === 'queued');
  songs.current = idx >= 0 ? songs.queue.splice(idx, 1)[0] : null;
  broadcast(userId);
}

// Un regalo puede adelantar la canción de quien lo envió (Pro).
function onGift(user, event) {
  const gp = user.settings.songs.giftPriority;
  if (!gp.enabled) return null;
  const total = event.gift.diamonds * event.gift.count;
  if (total < gp.minDiamonds) return null;
  const songs = state.get(user.id).songs;
  const idx = songs.queue.findIndex((s) => s.requestedBy.uniqueId === event.user.uniqueId && !s.priority);
  if (idx < 0) return null;
  const [item] = songs.queue.splice(idx, 1);
  item.priority = true;
  item.status = 'queued';
  const firstNormal = songs.queue.findIndex((s) => !s.priority);
  songs.queue.splice(firstNormal < 0 ? songs.queue.length : firstNormal, 0, item);
  if (!songs.current) next(user.id);
  else broadcast(user.id);
  return `${event.user.name} adelantó "${item.title}" con un regalo`;
}

// Acciones del streamer desde el panel.
function control(userId, action, songId) {
  const songs = state.get(userId).songs;
  const idx = songs.queue.findIndex((s) => s.id === songId);
  switch (action) {
    case 'approve':
      if (idx >= 0) songs.queue[idx].status = 'queued';
      if (!songs.current) return next(userId);
      break;
    case 'remove':
      if (idx >= 0) songs.queue.splice(idx, 1);
      break;
    case 'top':
      if (idx >= 0) {
        const [it] = songs.queue.splice(idx, 1);
        it.status = 'queued';
        songs.queue.unshift(it);
      }
      break;
    case 'skip':
      return next(userId);
    case 'pause':
      songs.paused = true;
      break;
    case 'resume':
      songs.paused = false;
      if (!songs.current) return next(userId);
      break;
    case 'clear':
      songs.queue = [];
      break;
    default:
      throw new Error('acción inválida');
  }
  broadcast(userId);
}

// Mensajes que manda el reproductor.
function onPlayerMessage(userId, msg) {
  const songs = state.get(userId).songs;
  if (!songs.current || msg.songId !== songs.current.id) return;
  if (msg.type === 'song:ended' || msg.type === 'song:error') next(userId);
}

module.exports = { request, onGift, control, onPlayerMessage, snapshot, broadcast, parseVideoId, parseIsoDuration };
