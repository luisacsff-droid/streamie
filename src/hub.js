// Canal en tiempo real entre el servidor y los overlays / reproductor / panel.
// Cada pantalla se conecta a /ws?k=<overlay_key>&role=<alerts|player|songs|dashboard>
const { WebSocketServer } = require('ws');
const db = require('./db');

const ROLES = new Set(['alerts', 'player', 'songs', 'dashboard', 'visualizer']);
const clients = new Map(); // userId -> Set<ws>
let onClientMessage = () => {};
let onClientJoin = () => {};

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://x');
    let user = null;
    try {
      user = await db.getUserByKey(url.searchParams.get('k') || '');
    } catch (err) {
      console.error('[hub]', err.message);
    }
    const role = url.searchParams.get('role');
    if (!user || !ROLES.has(role)) {
      ws.close(4001, 'llave inválida');
      return;
    }
    ws.userId = user.id;
    ws.role = role;
    ws.isAlive = true;
    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(ws);

    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string') onClientMessage(user.id, role, msg);
    });
    ws.on('close', () => {
      const set = clients.get(user.id);
      if (set) {
        set.delete(ws);
        if (!set.size) clients.delete(user.id);
      }
    });

    onClientJoin(user.id, role, ws);
  });

  // Mantiene vivas las conexiones y limpia las caídas.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(timer));
  return wss;
}

// Envía un mensaje a las pantallas de un usuario (opcionalmente solo a ciertos roles).
function send(userId, msg, roles) {
  const set = clients.get(userId);
  if (!set) return 0;
  const data = JSON.stringify(msg);
  let n = 0;
  for (const ws of set) {
    if (ws.readyState !== 1) continue;
    if (roles && !roles.includes(ws.role)) continue;
    ws.send(data);
    n++;
  }
  return n;
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Desconecta todas las pantallas (por ejemplo al regenerar la llave).
function kick(userId) {
  for (const ws of clients.get(userId) || []) ws.close(4002, 'llave regenerada');
}

function count(userId, role) {
  let n = 0;
  for (const ws of clients.get(userId) || []) if (!role || ws.role === role) n++;
  return n;
}

module.exports = {
  attach,
  send,
  sendTo,
  kick,
  count,
  onMessage: (fn) => (onClientMessage = fn),
  onJoin: (fn) => (onClientJoin = fn),
};
