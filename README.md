# Streamie

Web app para streamers de TikTok LIVE con **alertas**, **lectura del chat (TTS)** y **song request**, con planes Free y Pro.

El streamer crea su cuenta, escribe su usuario de TikTok, pega tres links en OBS / TikTok LIVE Studio y listo.

---

## Qué incluye

| | Free | Pro |
|---|---|---|
| Alertas de regalos, follows y shares | ✅ textos fijos | ✅ textos, sonido e imagen propios |
| TTS (leer el chat) | voz del navegador, 100 letras | voces naturales (Google), 300 letras, modo “solo quien regaló” |
| Song request (`!sr`) | cola de 5, siempre con aprobación | cola de 50, aprobación opcional, regalos que adelantan canciones |
| Horas de LIVE al mes | 20 | 300 (uso justo) |
| Marca en overlays | sí | no |

Los límites se cambian en `src/plans.js`.

## Cómo funciona

```
TikTok LIVE ──(EulerStream firma la conexión)──► servidor Node.js
                                                  │
                         ┌────────────────────────┼─────────────────────────┐
                         ▼                        ▼                         ▼
                 /o/alerts (OBS)          /o/player (audio)          /o/songs (OBS)
                 animaciones              voz + música YouTube        canción actual
```

- `src/live.js` — una conexión por streamer, reconexión automática, espera a que empiece el LIVE, cuenta horas.
- `src/pipeline.js` — cada evento pasa por alertas, TTS y canciones.
- `src/modules/` — lógica de alertas, TTS y song request.
- `src/hub.js` — WebSocket hacia los overlays y el panel.
- `public/` — landing, panel y overlays (HTML/CSS/JS sin framework).
- Base de datos SQLite en un solo archivo (`data/streamie.db`).

## Correrlo en tu computadora

Requiere Node.js 20.12 o más nuevo.

```bash
npm install
cp .env.example .env      # y llena EULER_API_KEY
npm start
```

Abre http://localhost:3000, crea una cuenta y usa **“Probar sin estar en vivo”** para ver alertas, voz y canciones sin necesidad de un LIVE real.

Para probar el plan Pro sin pagos: `npm run set-plan -- tu@correo.com pro`

## Llaves que necesitas

| Variable | Para qué | ¿Obligatoria? | Dónde se saca |
|---|---|---|---|
| `EULER_API_KEY` | Firmar la conexión al LIVE | Sí en producción | eulerstream.com → Dashboard → API Keys |
| `MAX_CONNECTIONS` | Tope de streamers conectados a la vez (según tu plan de Euler) | No (20) | — |
| `GOOGLE_TTS_API_KEY` | Voces naturales del plan Pro | No | Google Cloud → habilitar *Cloud Text-to-Speech API* → API key |
| `YOUTUBE_API_KEY` | Buscar canciones por nombre (`!sr bad bunny`) | No; sin ella solo se aceptan links | Google Cloud → habilitar *YouTube Data API v3* → API key |
| `STRIPE_*` | Cobrar el plan Pro | No | Stripe → Productos (precio recurrente) + Webhooks |
| `ADMIN_EMAILS` | Cambiar planes desde `/api/admin/plan` | No | — |

**Restringe las llaves de Google** en la consola a la API correspondiente.

## Publicarlo (Railway, recomendado)

Netlify/Vercel **no sirven** para el servidor: necesita mantener conexiones abiertas durante horas.

1. Sube esta carpeta a un repositorio de GitHub (sin `node_modules`, `data` ni `.env`).
2. En railway.app → *New Project* → *Deploy from GitHub repo*.
3. Agrega un **Volume** montado en `/data`.
4. En *Variables* pon todo lo de `.env.example`, con:
   - `NODE_ENV=production`
   - `DB_PATH=/data/streamie.db`
   - `BASE_URL=https://tu-app.up.railway.app` (o tu dominio)
5. Railway detecta `npm start` solo. Revisa que `https://tu-dominio/health` responda `{"ok":true}`.

Render (con disco persistente) o un VPS con `pm2` funcionan igual.

### Stripe

1. Crea un producto “Pro” con precio mensual → copia el `price_…` a `STRIPE_PRICE_ID`.
2. Webhook → `https://tu-dominio/api/billing/webhook` con los eventos `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → copia el secreto a `STRIPE_WEBHOOK_SECRET`.
3. Activa el *Customer portal* en Stripe para que los usuarios cancelen solos.

## Cómo lo usa el streamer

1. **Overlays → Alertas**: fuente de navegador en OBS / LIVE Studio, 1920×1080.
2. **Overlays → Reproductor**: abrirlo en Chrome y dar clic en “Activar audio” (LIVE Studio captura el audio del escritorio), o agregarlo en OBS con “Controlar audio desde OBS”. Solo uno a la vez, o se oirá doble.
3. **Overlays → Canción actual**: fuente de navegador opcional.
4. Escribir el usuario y **Conectar**. Si aún no está en vivo, la app espera y se conecta sola cuando empiece (hasta 3 h).

## Límites conocidos y siguientes pasos

- **Dependencia de terceros**: la conexión al LIVE no es oficial. Si TikTok cambia algo, depende de que EulerStream lo arregle. Revisa sus términos y los de TikTok antes de cobrar.
- **Música con derechos**: TikTok puede silenciar o cortar un LIVE con música protegida. Avísale a tus usuarios.
- **Cuota de YouTube**: cada búsqueda por nombre gasta 100 de las 10,000 unidades diarias gratis (~100 búsquedas/día; se cachean las repetidas). Pide aumento de cuota a Google cuando crezcas, o usa solo links.
- **Cola de canciones en memoria**: se pierde si el servidor se reinicia.
- **Verificación del usuario de TikTok**: hoy cualquiera puede escribir cualquier usuario. Antes de crecer, agrega verificación (por ejemplo, un código en la bio).
- Sin recuperación de contraseña por correo (necesita un servicio de email como Resend).
- SQLite aguanta bien cientos de usuarios en un solo servidor; para varios servidores, migrar a Postgres y mover el estado en memoria a Redis.
