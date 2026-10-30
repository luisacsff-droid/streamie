// Carga variables de entorno desde .env (si existe) y expone la configuración.
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // Sin archivo .env: se usan las variables del sistema (Railway, Render, etc.)
}

const env = process.env;

const config = {
  appName: env.APP_NAME || 'Streamie',
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'streamie.db'),
  isProd: env.NODE_ENV === 'production',

  // EulerStream: firma de la conexión al LIVE
  eulerApiKey: env.EULER_API_KEY || '',
  // Conexiones simultáneas máximas que permite tu plan de EulerStream
  maxConnections: Number(env.MAX_CONNECTIONS || 20),

  // TTS premium (Google Cloud Text-to-Speech)
  googleTtsKey: env.GOOGLE_TTS_API_KEY || '',

  // Song request (YouTube Data API v3)
  youtubeKey: env.YOUTUBE_API_KEY || '',

  // Stripe (opcional; sin estas llaves el botón de pago se oculta)
  stripeSecret: env.STRIPE_SECRET_KEY || '',
  stripePriceId: env.STRIPE_PRICE_ID || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',

  // Correos con acceso a /api/admin
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

module.exports = config;
