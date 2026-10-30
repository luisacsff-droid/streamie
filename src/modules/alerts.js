// Convierte un evento del LIVE en una alerta para el overlay.
const crypto = require('crypto');

function render(template, vars) {
  return template.replace(/\{(user|count|gift|diamonds)\}/g, (_, k) => String(vars[k] ?? ''));
}

function buildAlert(event, settings) {
  const a = settings.alerts;
  if (!a.enabled) return null;
  const cfg = a[event.kind];
  if (!cfg || !cfg.enabled) return null;

  const vars = { user: event.user.name, count: 1, gift: '', diamonds: 0 };
  if (event.kind === 'gift') {
    const total = event.gift.diamonds * event.gift.count;
    if (total < cfg.minDiamonds) return null;
    Object.assign(vars, { count: event.gift.count, gift: event.gift.name, diamonds: total });
  }

  return {
    type: 'alert',
    id: crypto.randomUUID(),
    kind: event.kind,
    text: render(cfg.template, vars),
    user: event.user,
    gift: event.gift || null,
    durationSec: a.durationSec,
    volume: a.volume,
    soundUrl: a.soundUrl,
    imageUrl: a.imageUrl,
  };
}

module.exports = { buildAlert };
