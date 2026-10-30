// Límites de cada plan. Ajusta aquí lo que incluye Free y Pro.

const PREMIUM_VOICES = [
  { id: 'es-US-Neural2-A', label: 'Latina · mujer', lang: 'es-US' },
  { id: 'es-US-Neural2-B', label: 'Latino · hombre', lang: 'es-US' },
  { id: 'es-US-Neural2-C', label: 'Latino · hombre 2', lang: 'es-US' },
  { id: 'es-ES-Neural2-A', label: 'España · mujer', lang: 'es-ES' },
  { id: 'es-ES-Neural2-B', label: 'España · hombre', lang: 'es-ES' },
  { id: 'en-US-Neural2-F', label: 'Inglés · mujer', lang: 'en-US' },
];

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyLiveHours: 20, // horas de conexión al LIVE por mes
    branding: true, // muestra la marca en los overlays
    tts: {
      premiumVoices: false,
      maxChars: 100,
      modes: ['all', 'command'],
    },
    alerts: {
      customTemplates: false,
      customSound: false,
      customImage: false,
    },
    songs: {
      maxQueue: 5,
      forceApproval: true,
      giftPriority: false,
      giftOnly: false,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyLiveHours: 300, // uso justo
    branding: false,
    tts: {
      premiumVoices: true,
      maxChars: 300,
      modes: ['all', 'command', 'gifters'],
    },
    alerts: {
      customTemplates: true,
      customSound: true,
      customImage: true,
    },
    songs: {
      maxQueue: 50,
      forceApproval: false,
      giftPriority: true,
      giftOnly: true,
    },
  },
};

function getPlan(id) {
  return PLANS[id] || PLANS.free;
}

module.exports = { PLANS, PREMIUM_VOICES, getPlan };
