// Text-to-speech: decide qué mensajes se leen y genera audio premium (Google Cloud TTS).
const crypto = require('crypto');
const config = require('../config');
const { PREMIUM_VOICES } = require('../plans');

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b\S+\.(?:com|net|org|io|gg|tv|ly|me|mx)\S*/gi;

function clean(text, t) {
  let out = String(text || '')
    .replace(URL_RE, '')
    .replace(/(.)\1{4,}/g, '$1$1$1') // "aaaaaaa" -> "aaa"
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return null;
  const lower = out.toLowerCase();
  if (t.blockedWords.some((w) => lower.includes(w))) return null;
  if (out.length > t.maxChars) out = out.slice(0, t.maxChars);
  return out;
}

// Devuelve el texto a leer para un mensaje de chat, o null si no aplica.
function textForChat(event, settings, session) {
  const t = settings.tts;
  if (!t.enabled) return null;
  let comment = String(event.comment || '').trim();
  const songCmd = settings.songs.command.toLowerCase();
  if (comment.toLowerCase().startsWith(songCmd)) return null;

  if (t.mode === 'command') {
    const cmd = t.command.toLowerCase();
    if (!comment.toLowerCase().startsWith(cmd + ' ')) return null;
    comment = comment.slice(cmd.length).trim();
  } else {
    if (t.skipCommands && comment.startsWith('!')) return null;
    if (t.mode === 'gifters' && !session.gifters.has(event.user.uniqueId)) return null;
  }

  const now = Date.now();
  const last = session.lastTts.get(event.user.uniqueId) || 0;
  if (now - last < t.userCooldownSec * 1000) return null;

  const body = clean(comment, t);
  if (!body) return null;
  session.lastTts.set(event.user.uniqueId, now);
  return t.readUsername ? `${event.user.name} dice: ${body}` : body;
}

const cache = new Map(); // texto+voz -> audio (evita pagar dos veces lo mismo)

async function synthesize(text, voiceId, rate) {
  const voice = PREMIUM_VOICES.find((v) => v.id === voiceId);
  if (!voice || !config.googleTtsKey) return null;
  const cacheKey = `${voiceId}|${rate}|${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(config.googleTtsKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voice.lang, name: voice.id },
        audioConfig: { audioEncoding: 'MP3', speakingRate: rate },
      }),
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Google TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { audioContent } = await res.json();
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, audioContent);
  return audioContent;
}

// Construye el mensaje para el reproductor. Si la voz premium falla, cae a la voz del navegador.
async function buildTts(text, settings) {
  const t = settings.tts;
  const msg = {
    type: 'tts',
    id: crypto.randomUUID(),
    text,
    voice: 'browser',
    rate: t.rate,
    volume: t.volume,
    audio: null,
  };
  if (t.voice !== 'browser') {
    try {
      const audio = await synthesize(text, t.voice, t.rate);
      if (audio) {
        msg.voice = t.voice;
        msg.audio = audio;
      }
    } catch (err) {
      console.warn('[tts] voz premium falló, usando la del navegador:', err.message);
    }
  }
  return msg;
}

module.exports = { textForChat, buildTts, clean };
