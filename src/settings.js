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
    soundUrl: '', // Pro
    imageUrl: '', // Pro
  },
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
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(u || '') ? u.slice(0, 500) : '');

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
  a.soundUrl = plan.alerts.customSound ? safeUrl(a.soundUrl) : '';
  a.imageUrl = plan.alerts.customImage ? safeUrl(a.imageUrl) : '';

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
