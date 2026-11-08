// Configuración por usuario: valores por defecto y validación según el plan.
const { getPlan, PREMIUM_VOICES } = require('./plans');

const DEFAULTS = {
  alerts: {
    enabled: true,
    durationSec: 6,
    volume: 0.8,
    readAloud: false, // leer la alerta con TTS
    gift: { enabled: true, minDiamonds: 1, template: '{user} envió {count}x {gift}' },
    follow: { enabled: true, template: '{user} empezó a seguirte' },
    share: { enabled: true, template: '{user} compartió el LIVE' },
    soundId: '', // Pro: sonido subido para todas las alertas
    imageId: '', // Pro: imagen o GIF subido para todas las alertas
  },
  // Visualizador de audio para el stream.
  visualizer: {
    style: 'bars', // bars | mirror | wave | circle | dots
    color: '#b6ff1f',
    color2: '#b6ff1f',
    bars: 64,
    sens: 1.2,
    position: 'bottom', // bottom | center
    glow: true,
    source: 'pc', // demo (decorativo) | pc (audio de la PC, capturado en el Reproductor) | audio (dispositivo de grabación)
    device: '', // parte del nombre del dispositivo, ej. "CABLE" o "BlackHole"
  },
  // Reglas: cuando llega cierto regalo, suena su propio sonido.
  // { id, giftId, giftName, giftImage, soundId, imageId, text }
  giftSounds: [],
  // Reglas: cuando un viewer manda cierto sticker en el chat, suena su sonido.
  // { id, stickerId, stickerImage, soundId, imageId, text, showAlert }
  stickerSounds: [],
  // Alertas propias que el streamer dispara con un botón.
  // { id, name, emoji, text, soundId, imageId }
  events: [],
  tts: {
    enabled: true,
    mode: 'all', // all | command | gifters
    command: '!tts',
    readUsername: true,
    voice: 'browser', // 'browser' (gratis, la elige el reproductor) o id de voz premium
    rate: 1,
    volume: 1,
    maxChars: 100,
    userCooldownSec: 10,
    skipCommands: true, // no leer mensajes que empiezan con "!"
    blockedWords: [],
  },
  songs: {
    enabled: true,
    command: '!sr',
    requireApproval: true,
    maxQueue: 5,
    maxPerUser: 2,
    maxDurationSec: 420,
    volume: 0.5,
    giftOnly: false, // Pro: solo quien ya regaló puede pedir
    giftPriority: { enabled: false, minDiamonds: 10 }, // Pro: regalo => su canción pasa al frente
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in base)) continue; // ignora llaves desconocidas
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (typeof v === typeof base[k] || (Array.isArray(base[k]) && Array.isArray(v))) {
      base[k] = v;
    }
  }
  return base;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));
const str = (s, max) => String(s ?? '').slice(0, max);
const mediaId = (id) => (/^[A-Za-z0-9_-]{16,40}$/.test(id || '') ? id : '');
const itemId = (id) => (/^[A-Za-z0-9_-]{4,40}$/.test(id || '') ? id : Math.random().toString(36).slice(2, 10));
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

// Devuelve configuración completa, válida y recortada a lo que permite el plan.
function normalizeSettings(raw, planId) {
  const plan = getPlan(planId);
  const s = deepMerge(clone(DEFAULTS), typeof raw === 'string' ? safeParse(raw) : raw);

  // Alertas
  const a = s.alerts;
  a.durationSec = clamp(a.durationSec, 2, 20);
  a.volume = clamp(a.volume, 0, 1);
  a.gift.minDiamonds = clamp(a.gift.minDiamonds, 1, 100000);
  for (const k of ['gift', 'follow', 'share']) {
    a[k].template = plan.alerts.customTemplates ? str(a[k].template, 120) : DEFAULTS.alerts[k].template;
  }
  a.soundId = plan.alerts.customSound ? mediaId(a.soundId) : '';
  a.imageId = plan.alerts.customImage ? mediaId(a.imageId) : '';

  // Sonidos por regalo
  s.giftSounds = list(s.giftSounds)
    .slice(0, plan.giftSounds)
    .map((r) => ({
      id: itemId(r.id),
      giftId: str(r.giftId, 30).replace(/[^0-9]/g, ''),
      giftName: str(r.giftName, 60).trim(),
      giftImage: /^https:\/\/[^\s"'<>]+$/i.test(r.giftImage || '') ? str(r.giftImage, 500) : '',
      soundId: mediaId(r.soundId),
      imageId: mediaId(r.imageId),
      text: str(r.text, 120),
    }));

  // Visualizador
  const v = s.visualizer;
  if (!['bars', 'mirror', 'wave', 'circle', 'dots'].includes(v.style)) v.style = 'bars';
  const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : d);
  v.color = hex(v.color, '#b6ff1f');
  v.color2 = hex(v.color2, v.color);
  v.bars = Math.round(clamp(v.bars, 16, 128));
  v.sens = clamp(v.sens, 0.3, 3);
  if (!['bottom', 'center'].includes(v.position)) v.position = 'bottom';
  if (!['demo', 'pc', 'audio'].includes(v.source)) v.source = 'demo';
  v.device = str(v.device, 60).trim();

  // Sonidos por sticker
  const seenSticker = new Set();
  s.stickerSounds = list(s.stickerSounds)
    .map((r) => ({
      id: itemId(r.id),
      stickerId: str(r.stickerId, 40).replace(/[^0-9A-Za-z_-]/g, ''),
      stickerImage: /^https:\/\/[^\s"'<>]+$/i.test(r.stickerImage || '') ? str(r.stickerImage, 600) : '',
      soundId: mediaId(r.soundId),
      imageId: mediaId(r.imageId),
      text: str(r.text, 120),
      showAlert: r.showAlert !== false,
    }))
    .filter((r) => r.stickerId && !seenSticker.has(r.stickerId) && seenSticker.add(r.stickerId))
    .slice(0, plan.stickerSounds);

  // Eventos manuales
  s.events = list(s.events)
    .slice(0, plan.events)
    .map((e) => ({
      id: itemId(e.id),
      name: str(e.name, 40).trim() || 'Evento',
      emoji: str(e.emoji, 8).trim(),
      text: str(e.text, 120),
      soundId: mediaId(e.soundId),
      imageId: mediaId(e.imageId),
    }));

  // TTS
  const t = s.tts;
  if (!plan.tts.modes.includes(t.mode)) t.mode = 'all';
  t.command = str(t.command, 20).trim() || '!tts';
  t.rate = clamp(t.rate, 0.5, 2);
  t.volume = clamp(t.volume, 0, 1);
  t.maxChars = clamp(t.maxChars, 10, plan.tts.maxChars);
  t.userCooldownSec = clamp(t.userCooldownSec, 0, 600);
  t.blockedWords = (Array.isArray(t.blockedWords) ? t.blockedWords : [])
    .map((w) => str(w, 40).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);
  const premium = PREMIUM_VOICES.some((v) => v.id === t.voice);
  if (t.voice !== 'browser' && (!premium || !plan.tts.premiumVoices)) t.voice = 'browser';

  // Canciones
  const g = s.songs;
  g.command = str(g.command, 20).trim() || '!sr';
  if (plan.songs.forceApproval) g.requireApproval = true;
  g.maxQueue = clamp(g.maxQueue, 1, plan.songs.maxQueue);
  g.maxPerUser = clamp(g.maxPerUser, 1, 20);
  g.maxDurationSec = clamp(g.maxDurationSec, 30, 1200);
  g.volume = clamp(g.volume, 0, 1);
  if (!plan.songs.giftOnly) g.giftOnly = false;
  if (!plan.songs.giftPriority) g.giftPriority.enabled = false;
  g.giftPriority.minDiamonds = clamp(g.giftPriority.minDiamonds, 1, 100000);

  return s;
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

module.exports = { DEFAULTS, normalizeSettings };
