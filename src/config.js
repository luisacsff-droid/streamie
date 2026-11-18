// Carga variables de entorno desde .env (si existe) y expone la configuración.
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // Sin archivo .env: se usan las variables del sistema (Railway, Render, etc.)
}

const env = process.env;

const config = {
  appName: env.APP_NAME || 'Mafy',
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  // Base de datos (Neon, Supabase, Render Postgres…). Sin ella, los datos se borran al reiniciar.
  databaseUrl: env.DATABASE_URL || '',
  isProd: env.NODE_ENV === 'production',

  // EulerStream: firma de la conexión al LIVE
  eulerApiKey: env.EULER_API_KEY || '',
  // Conexiones simultáneas máximas que permite tu plan de EulerStream
  maxConnections: Number(env.MAX_CONNECTIONS || 20),

  // TTS premium (Google Cloud Text-to-Speech)
  googleTtsKey: env.GOOGLE_TTS_API_KEY || '',

  // Song request (YouTube Data API v3)
  youtubeKey: env.YOUTUBE_API_KEY || '',

  // Mercado Pago (opcional; sin MP_ACCESS_TOKEN el botón de pago se oculta)
  mpAccessToken: env.MP_ACCESS_TOKEN || '',
  // Opcional: clave secreta de los webhooks para comprobar la firma.
  mpWebhookSecret: env.MP_WEBHOOK_SECRET || '',
  // Precio de fundador: los primeros N clientes pagan menos, para siempre.
  founderSlots: Number(env.FOUNDER_SLOTS || 100),
  // Precios mensuales en MXN: se muestran en la página y son lo que se cobra.
  proPriceMxn: Number(env.PRO_PRICE_MXN || 119),
  founderPriceMxn: Number(env.FOUNDER_PRICE_MXN || 99),

  // Datos para términos y aviso de privacidad
  legalName: env.LEGAL_NAME || '',
  contactEmail: env.CONTACT_EMAIL || '',

  // Correos con acceso a /api/admin
  // Correos con Pro gratis, sin permisos de administrador (amigos, streamers de prueba, socios).
  proEmails: (env.PRO_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

module.exports = config;
