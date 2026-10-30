// Panel del streamer.
(() => {
  let me = null;
  let ws = null;
  let songsState = { current: null, queue: [], paused: false };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, method = 'GET', body) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
    });
    if (res.status === 401) {
      location.href = '/';
      throw new Error('Sesión expirada');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Algo salió mal.');
    return data;
  }
  // Las peticiones sin cuerpo también mandan JSON (el servidor lo exige).
  const post = (path, body = {}) => api(path, 'POST', body);

  let toastTimer;
  function toast(msg, err = false) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.setAttribute('role', 'status');
    el.textContent = msg;
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2600);
  }

  // ---------- esquema de configuración ----------
  const proLocked = (check) => (p) => !check(p);
  const SCHEMA = {
    alerts: [
      { group: 'General' },
      { path: 'alerts.enabled', type: 'switch', label: 'Mostrar alertas' },
      { path: 'alerts.durationSec', type: 'range', min: 2, max: 20, step: 1, label: 'Duración', fmt: (v) => v + ' s' },
      { path: 'alerts.volume', type: 'range', min: 0, max: 1, step: 0.05, label: 'Volumen del sonido', fmt: pct },
      { path: 'alerts.readAloud', type: 'switch', label: 'Leer la alerta en voz alta', hint: 'Usa la voz configurada en la pestaña Voz.' },
      { group: 'Regalos' },
      { path: 'alerts.gift.enabled', type: 'switch', label: 'Alertas de regalos' },
      { path: 'alerts.gift.minDiamonds', type: 'number', min: 1, max: 100000, label: 'Diamantes mínimos', hint: 'Regalos menores no muestran alerta.' },
      { path: 'alerts.gift.template', type: 'text', label: 'Texto', hint: 'Usa {user}, {count}, {gift} y {diamonds}.', lock: proLocked((p) => p.alerts.customTemplates) },
      { group: 'Follows y compartidos' },
      { path: 'alerts.follow.enabled', type: 'switch', label: 'Alertas de follow' },
      { path: 'alerts.follow.template', type: 'text', label: 'Texto de follow', lock: proLocked((p) => p.alerts.customTemplates) },
      { path: 'alerts.share.enabled', type: 'switch', label: 'Alertas al compartir' },
      { path: 'alerts.share.template', type: 'text', label: 'Texto al compartir', lock: proLocked((p) => p.alerts.customTemplates) },
      { group: 'Estilo propio' },
      { path: 'alerts.soundUrl', type: 'text', label: 'Sonido (link https a .mp3)', placeholder: 'https://…/sonido.mp3', lock: proLocked((p) => p.alerts.customSound) },
      { path: 'alerts.imageUrl', type: 'text', label: 'Imagen o GIF (link https)', placeholder: 'https://…/alerta.gif', lock: proLocked((p) => p.alerts.customImage) },
    ],
    tts: [
      { group: 'Qué se lee' },
      { path: 'tts.enabled', type: 'switch', label: 'Leer el chat en voz alta' },
      {
        path: 'tts.mode', type: 'select', label: 'Mensajes que se leen',
        options: (p) => [
          { value: 'all', label: 'Todo el chat' },
          { value: 'command', label: 'Solo con comando' },
          { value: 'gifters', label: 'Solo de quien ya regaló', disabled: !p.tts.modes.includes('gifters'), pro: true },
        ],
      },
      { path: 'tts.command', type: 'text', label: 'Comando', hint: 'Para el modo “Solo con comando”. Ej: !tts hola' },
      { path: 'tts.readUsername', type: 'switch', label: 'Decir el nombre antes del mensaje' },
      { path: 'tts.skipCommands', type: 'switch', label: 'Ignorar mensajes que empiezan con “!”' },
      { path: 'tts.maxChars', type: 'number', min: 10, max: (p) => p.tts.maxChars, label: 'Máximo de letras por mensaje', hint: (p) => `Tu plan permite hasta ${p.tts.maxChars}.` },
      { path: 'tts.userCooldownSec', type: 'number', min: 0, max: 600, label: 'Espera entre mensajes del mismo usuario (s)' },
      { path: 'tts.blockedWords', type: 'list', label: 'Palabras bloqueadas', hint: 'Separadas por coma. Mensajes con estas palabras no se leen.' },
      { group: 'Voz' },
      {
        path: 'tts.voice', type: 'select', label: 'Voz',
        hint: () => (me.features.premiumTts ? '' : 'Las voces naturales se activan cuando el administrador configura Google TTS.'),
        options: (p) => [
          { value: 'browser', label: 'Voz del navegador (gratis)' },
          ...me.voices.map((v) => ({ value: v.id, label: v.label, disabled: !p.tts.premiumVoices || !me.features.premiumTts, pro: true })),
        ],
      },
      { path: 'tts.rate', type: 'range', min: 0.5, max: 2, step: 0.1, label: 'Velocidad', fmt: (v) => Number(v).toFixed(1) + '×' },
      { path: 'tts.volume', type: 'range', min: 0, max: 1, step: 0.05, label: 'Volumen', fmt: pct },
    ],
    songs: [
      { group: 'Pedidos' },
      { path: 'songs.enabled', type: 'switch', label: 'Aceptar canciones del chat' },
      { path: 'songs.command', type: 'text', label: 'Comando', hint: () => (me.features.youtubeSearch ? 'Ej: !sr bad bunny monaco' : 'Por ahora solo con link de YouTube. Ej: !sr https://youtu.be/…') },
      { path: 'songs.requireApproval', type: 'switch', label: 'Aprobar cada canción antes de que suene', lock: (p) => p.songs.forceApproval, lockText: 'Siempre activo en Free' },
      { path: 'songs.maxQueue', type: 'number', min: 1, max: (p) => p.songs.maxQueue, label: 'Canciones máximas en cola', hint: (p) => `Tu plan permite hasta ${p.songs.maxQueue}.` },
      { path: 'songs.maxPerUser', type: 'number', min: 1, max: 20, label: 'Canciones por persona' },
      { path: 'songs.maxDurationSec', type: 'number', min: 30, max: 1200, label: 'Duración máxima (segundos)' },
      { path: 'songs.volume', type: 'range', min: 0, max: 1, step: 0.05, label: 'Volumen de la música', fmt: pct },
      { group: 'Regalos y canciones' },
      { path: 'songs.giftOnly', type: 'switch', label: 'Solo quien regaló puede pedir', lock: proLocked((p) => p.songs.giftOnly) },
      { path: 'songs.giftPriority.enabled', type: 'switch', label: 'Un regalo adelanta su canción', lock: proLocked((p) => p.songs.giftPriority) },
      { path: 'songs.giftPriority.minDiamonds', type: 'number', min: 1, max: 100000, label: 'Diamantes para adelantar', lock: proLocked((p) => p.songs.giftPriority) },
    ],
  };

  function pct(v) {
    return Math.round(v * 100) + '%';
  }
  const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
  function buildPatch(path, value) {
    const out = {};
    const keys = path.split('.');
    keys.reduce((o, k, i) => (o[k] = i === keys.length - 1 ? value : {}), out);
    return out;
  }
  const call = (v, p) => (typeof v === 'function' ? v(p) : v);

  function renderFields() {
    const p = me.planInfo;
    for (const container of document.querySelectorAll('[data-section]')) {
      container.innerHTML = '';
      for (const f of SCHEMA[container.dataset.section]) {
        if (f.group) {
          const h = document.createElement('h3');
          h.className = 'group-title';
          h.textContent = f.group;
          container.append(h);
          continue;
        }
        container.append(renderField(f, p));
      }
    }
  }

  function renderField(f, p) {
    const locked = f.lock ? f.lock(p) : false;
    const value = getPath(me.settings, f.path);
    const row = document.createElement('div');
    row.className = 'field' + (locked ? ' locked' : '') + (f.type === 'list' ? ' wide' : '');
    const id = 'f_' + f.path.replace(/\./g, '_');
    const hint = call(f.hint, p);
    const tag = locked ? `<span class="pro-tag">${esc(f.lockText || 'Pro')}</span>` : '';
    row.innerHTML = `<label class="label" for="${id}">${esc(f.label)}${tag}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label><div class="control"></div>`;
    const control = row.querySelector('.control');
    let input;

    if (f.type === 'switch') {
      control.innerHTML = `<span class="switch"><input type="checkbox" id="${id}"><span></span></span>`;
      input = control.querySelector('input');
      input.checked = Boolean(value);
      input.addEventListener('change', () => save(f.path, input.checked));
    } else if (f.type === 'range') {
      control.innerHTML = `<input type="range" id="${id}" min="${f.min}" max="${f.max}" step="${f.step}"><output></output>`;
      input = control.querySelector('input');
      const out = control.querySelector('output');
      input.value = value;
      out.textContent = f.fmt(value);
      input.addEventListener('input', () => (out.textContent = f.fmt(input.value)));
      input.addEventListener('change', () => save(f.path, Number(input.value)));
    } else if (f.type === 'number') {
      control.innerHTML = `<input type="number" id="${id}" min="${call(f.min, p)}" max="${call(f.max, p)}" inputmode="numeric">`;
      input = control.querySelector('input');
      input.value = value;
      input.addEventListener('change', () => save(f.path, Number(input.value)));
    } else if (f.type === 'select') {
      input = document.createElement('select');
      input.id = id;
      for (const o of call(f.options, p)) {
        const opt = new Option(o.label + (o.pro && o.disabled ? ' (Pro)' : ''), o.value);
        opt.disabled = Boolean(o.disabled);
        input.append(opt);
      }
      input.value = value;
      control.append(input);
      input.addEventListener('change', () => save(f.path, input.value));
    } else if (f.type === 'list') {
      input = document.createElement('textarea');
      input.id = id;
      input.rows = 2;
      input.value = (value || []).join(', ');
      control.append(input);
      input.addEventListener('change', () => save(f.path, input.value.split(',').map((s) => s.trim()).filter(Boolean)));
    } else {
      input = document.createElement('input');
      input.id = id;
      input.placeholder = f.placeholder || '';
      input.value = value ?? '';
      control.append(input);
      input.addEventListener('change', () => save(f.path, input.value));
    }
    if (locked) input.disabled = true;
    return row;
  }

  async function save(path, value) {
    try {
      me = await api('/settings', 'PUT', buildPatch(path, value));
      const stored = getPath(me.settings, path);
      if (JSON.stringify(stored) !== JSON.stringify(value)) {
        toast('Ajustado al límite de tu plan.');
        renderFields();
      } else {
        toast('Guardado');
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- encabezado y conexión ----------
  function renderHeader() {
    $('appName').textContent = me.appName;
    document.title = 'Panel · ' + me.appName;
    const pro = me.plan === 'pro';
    $('planPill').textContent = pro ? 'Pro' : 'Free';
    $('planPill').classList.toggle('pro', pro);
    $('upgradeBtn').hidden = pro || !me.features.billing;
    $('portalBtn').hidden = !pro || !me.features.billing;
    const used = me.usage.usedSeconds / 3600;
    const limit = me.usage.limitSeconds / 3600;
    $('usageText').textContent = `${used.toFixed(1)} de ${limit} h de LIVE este mes`;
    $('usageBar').style.width = Math.min(100, (used / limit) * 100) + '%';
    $('urlAlerts').value = me.overlays.alerts;
    $('urlPlayer').value = me.overlays.player;
    $('urlSongs').value = me.overlays.songs;
    $('openPlayer').href = me.overlays.player;
    if (document.activeElement !== $('username')) $('username').value = me.tiktokUsername;
    const warn = $('warn');
    warn.hidden = me.features.signing;
    warn.textContent = 'El servidor no tiene llave de EulerStream: la conexión puede fallar. Mientras tanto usa “Probar sin estar en vivo”.';
  }

  const STATUS_TEXT = { offline: 'Desconectado', connecting: 'Conectando…', waiting: 'Esperando el LIVE', live: 'En vivo', error: 'Reintentando' };
  function renderStatus(s) {
    $('statusDot').className = 'dot ' + s.status;
    $('statusText').textContent = s.message || STATUS_TEXT[s.status] || s.status;
    $('viewers').textContent = s.status === 'live' && s.viewers ? `· ${s.viewers} viendo` : '';
    const on = s.status !== 'offline';
    $('connectBtn').hidden = on;
    $('disconnectBtn').hidden = !on;
    $('username').disabled = on;
  }

  $('connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('username').value.trim().replace(/^@/, '');
    if (!username) return toast('Escribe tu usuario de TikTok.', true);
    try {
      if (username !== me.tiktokUsername) me = await api('/tiktok', 'PUT', { username });
      renderStatus(await post('/live/start'));
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('disconnectBtn').addEventListener('click', async () => {
    try {
      await post('/live/stop');
      renderStatus({ status: 'offline' });
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- pestañas ----------
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
      document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
    })
  );

  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const input = $(b.dataset.copy);
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      toast('Link copiado');
    })
  );

  $('rotateBtn').addEventListener('click', async () => {
    if (!confirm('Los links actuales dejarán de funcionar y tendrás que pegarlos de nuevo en OBS. ¿Continuar?')) return;
    me = await post('/overlay-key/rotate');
    renderHeader();
    connectWs();
    toast('Links nuevos generados');
  });

  // ---------- pruebas ----------
  document.querySelectorAll('[data-test]').forEach((b) =>
    b.addEventListener('click', () => post('/test/' + b.dataset.test).catch((e) => toast(e.message, true)))
  );
  $('chatTest').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await post('/test/chat', { user: f.user.value, comment: f.comment.value });
      f.comment.value = '';
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- canciones ----------
  function renderSongs() {
    const { current, queue, paused } = songsState;
    $('nowPlaying').innerHTML = current
      ? `<span class="small muted">${paused ? 'En pausa' : 'Sonando'}</span><b>${esc(current.title)}</b><span class="small muted">pedida por ${esc(current.requestedBy.name)}</span>`
      : `<span class="empty">${paused ? 'Música en pausa.' : 'Nada sonando. Pide una con el comando del chat.'}</span>`;
    $('pauseBtn').textContent = paused ? 'Reanudar' : 'Pausar';
    const list = $('queue');
    list.innerHTML = queue.length ? '' : '<li class="empty" style="background:none">La cola está vacía.</li>';
    for (const s of queue) {
      const li = document.createElement('li');
      li.className = (s.status === 'pending' ? 'pending' : '') + (s.priority ? ' priority' : '');
      li.innerHTML = `<div style="min-width:0"><div class="title" title="${esc(s.title)}">${esc(s.title)}</div><div class="who">${esc(s.requestedBy.name)}${s.status === 'pending' ? ' · espera aprobación' : ''}</div></div>
        <div class="acts">${s.status === 'pending' ? `<button data-act="approve" class="primary">Aprobar</button>` : `<button data-act="top" class="ghost" title="Mover al inicio">Subir</button>`}<button data-act="remove" class="ghost danger" aria-label="Quitar">✕</button></div>`;
      li.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => songAction(b.dataset.act, s.id)));
      list.append(li);
    }
  }
  async function songAction(action, songId) {
    try {
      songsState = await post('/songs/' + action, { songId });
      renderSongs();
    } catch (err) {
      toast(err.message, true);
    }
  }
  $('skipBtn').addEventListener('click', () => songAction('skip'));
  $('pauseBtn').addEventListener('click', () => songAction(songsState.paused ? 'resume' : 'pause'));
  $('clearBtn').addEventListener('click', () => confirm('¿Vaciar la cola de canciones?') && songAction('clear'));

  // ---------- registro de actividad ----------
  function addLog(entry, prepend = true) {
    const li = document.createElement('li');
    const t = new Date(entry.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<time>${t}</time><span class="${esc(entry.kind)}">${esc(entry.text)}</span>`;
    const log = $('log');
    log.querySelector('.empty')?.remove();
    prepend ? log.prepend(li) : log.append(li);
    while (log.children.length > 100) log.lastChild.remove();
  }

  // ---------- tiempo real ----------
  let wsRetry;
  function connectWs() {
    clearTimeout(wsRetry);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?k=${encodeURIComponent(me.overlayKey)}&role=dashboard`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'log') addLog(msg.entry);
      else if (msg.type === 'live:status') {
        renderStatus(msg);
        if (msg.status === 'offline') refreshMe();
      } else if (msg.type === 'songs:state') {
        songsState = msg;
        renderSongs();
      } else if (msg.type === 'config' && msg.plan !== me.plan) refreshMe(true);
    };
    ws.onclose = () => (wsRetry = setTimeout(connectWs, 3000));
  }

  async function refreshMe(rerender = false) {
    me = await api('/me');
    renderHeader();
    if (rerender) renderFields();
  }

  // ---------- pagos y sesión ----------
  $('upgradeBtn').addEventListener('click', async () => {
    try {
      location.href = (await post('/billing/checkout')).url;
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('portalBtn').addEventListener('click', async () => {
    try {
      location.href = (await post('/billing/portal')).url;
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('logoutBtn').addEventListener('click', async () => {
    await post('/logout');
    location.href = '/';
  });

  // ---------- inicio ----------
  (async () => {
    me = await api('/me');
    renderHeader();
    renderFields();
    renderStatus(me.live);
    renderSongs();
    const log = await api('/log');
    if (!log.length) $('log').innerHTML = '<li class="empty">Aquí verás regalos, mensajes y canciones en cuanto pasen.</li>';
    log.forEach((e) => addLog(e, false));
    connectWs();
    const q = new URLSearchParams(location.search).get('pago');
    if (q === 'ok') toast('¡Listo! Tu plan Pro se activa en unos segundos.');
    if (q) history.replaceState(null, '', '/app');
  })().catch((err) => toast(err.message, true));

  setInterval(() => refreshMe().catch(() => {}), 120_000);
})();
