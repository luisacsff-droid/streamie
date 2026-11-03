// Convierte un evento del LIVE (o un evento manual) en una alerta para el overlay.
const crypto = require('crypto');
const { mediaUrl } = require('../media');

function render(template, vars) {
  return String(template || '').replace(/\{(user|count|gift|diamonds)\}/g, (_, k) => String(vars[k] ?? ''));
}

// Compara nombres sin importar mayúsculas ni acentos ("Corazón" = "corazon").
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

// Busca la regla de sonido que corresponde a un regalo (primero por id, luego por nombre).
function findGiftRule(gift, settings) {
  const rules = settings.giftSounds || [];
  const id = String(gift.id || '');
  return (
    (id && rules.find((r) => r.giftId && r.giftId === id)) ||
    rules.find((r) => r.giftName && norm(r.giftName) === norm(gift.name)) ||
    null
  );
}

function base(settings) {
  const a = settings.alerts;
  return {
    type: 'alert',
    id: crypto.randomUUID(),
    durationSec: a.durationSec,
    volume: a.volume,
    soundUrl: mediaUrl(a.soundId),
    imageUrl: mediaUrl(a.imageId),
  };
}

function buildAlert(event, settings) {
  const a = settings.alerts;
  if (!a.enabled) return null;

  if (event.kind === 'gift') {
    const total = event.gift.diamonds * event.gift.count;
    const vars = { user: event.user.name, count: event.gift.count, gift: event.gift.name, diamonds: total };
    const rule = findGiftRule(event.gift, settings);

    // Un regalo con sonido propio siempre muestra su alerta (aunque sea barato).
    if (rule) {
      const alert = {
        ...base(settings),
        kind: 'gift',
        text: render(rule.text || a.gift.template, vars),
        user: event.user,
        gift: event.gift,
      };
      if (rule.soundId) alert.soundUrl = mediaUrl(rule.soundId);
      if (rule.imageId) alert.imageUrl = mediaUrl(rule.imageId);
      return alert;
    }
    if (!a.gift.enabled || total < a.gift.minDiamonds) return null;
    return { ...base(settings), kind: 'gift', text: render(a.gift.template, vars), user: event.user, gift: event.gift };
  }

  const cfg = a[event.kind];
  if (!cfg || !cfg.enabled) return null;
  return {
    ...base(settings),
    kind: event.kind,
    text: render(cfg.template, { user: event.user.name }),
    user: event.user,
    gift: null,
  };
}

// Sticker con sonido: alerta completa o solo el sonido, según la regla.
function buildStickerAlert(event, rule, settings) {
  const soundUrl = rule.soundId ? mediaUrl(rule.soundId) : mediaUrl(settings.alerts.soundId);
  if (!rule.showAlert) {
    return { type: 'sound', id: crypto.randomUUID(), soundUrl, volume: settings.alerts.volume };
  }
  return {
    ...base(settings),
    kind: 'sticker',
    text: render(rule.text || '{user}', { user: event.user.name }),
    user: event.user,
    gift: null,
    soundUrl,
    // La imagen del sticker que llega es la más reciente (las de TikTok caducan).
    imageUrl: rule.imageId ? mediaUrl(rule.imageId) : event.sticker.image || rule.stickerImage || '',
  };
}

// Alerta de un evento manual ("¡mandó un capibara!").
function buildCustomAlert(ev, userName, settings) {
  const name = String(userName || '').trim();
  let text = ev.text || ev.name;
  text = name ? render(text, { user: name }) : text.replace(/\{user\}\s*/g, '').trim();
  return {
    ...base(settings),
    kind: 'custom',
    text: text || ev.name,
    emoji: ev.emoji || '',
    user: name ? { uniqueId: name, name, avatar: '' } : null,
    gift: null,
    soundUrl: ev.soundId ? mediaUrl(ev.soundId) : mediaUrl(settings.alerts.soundId),
    imageUrl: ev.imageId ? mediaUrl(ev.imageId) : '',
  };
}

module.exports = { buildAlert, buildCustomAlert, buildStickerAlert, findGiftRule, norm };
