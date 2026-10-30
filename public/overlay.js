// Conexión compartida de los overlays con el servidor (reconecta sola).
window.overlayConnect = function (role, onMessage) {
  const key = new URLSearchParams(location.search).get('k') || '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  let delay = 1000;

  function open() {
    ws = new WebSocket(`${proto}://${location.host}/ws?k=${encodeURIComponent(key)}&role=${role}`);
    ws.onopen = () => (delay = 1000);
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = (ev) => {
      if (ev.code === 4001 || ev.code === 4002) {
        onMessage({ type: 'invalid-key' });
        return;
      }
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 15000);
    };
  }
  open();
  return { send: (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg)) };
};

// Marca pequeña en overlays del plan Free.
window.overlayBranding = function (show, name) {
  let el = document.getElementById('branding');
  if (!el) {
    el = document.createElement('div');
    el.id = 'branding';
    el.style.cssText =
      'position:fixed;right:16px;bottom:12px;font:600 14px Onest,system-ui,sans-serif;color:#fff;opacity:.75;text-shadow:0 1px 3px #000';
    document.body.append(el);
  }
  el.textContent = show ? `⚡ ${name}` : '';
};
