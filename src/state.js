// Estado en memoria de cada streamer durante la sesión (se reinicia al reiniciar el servidor).
const sessions = new Map();

function get(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      gifters: new Set(), // usuarios que han regalado en esta sesión
      lastTts: new Map(), // usuario -> timestamp del último TTS
      songs: { current: null, queue: [], paused: false, seq: 0 },
      log: [], // últimos eventos para el panel
    });
  }
  return sessions.get(userId);
}

function pushLog(userId, entry) {
  const s = get(userId);
  s.log.unshift({ at: Date.now(), ...entry });
  if (s.log.length > 100) s.log.length = 100;
}

function resetSession(userId) {
  const s = get(userId);
  s.gifters.clear();
  s.lastTts.clear();
}

module.exports = { get, pushLog, resetSession };
