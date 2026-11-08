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
    visualizer: [
      {
        path: 'visualizer.style', type: 'select', label: 'Estilo',
        options: () => [
          { value: 'bars', label: 'Barras' },
          { value: 'mirror', label: 'Barras en espejo' },
          { value: 'wave', label: 'Onda' },
          { value: 'circle', label: 'Círculo' },
          { value: 'dots', label: 'Puntos (ecualizador)' },
        ],
      },
      {
        path: 'visualizer.source', type: 'select', label: 'Fuente',
        options: () => [
          { value: 'demo', label: 'Decorativo (se mueve solo)' },
          { value: 'audio', label: 'Audio real (dispositivo de grabación)' },
        ],
      },
      { path: 'visualizer.device', type: 'text', label: 'Dispositivo (opcional)', placeholder: 'Ej: CABLE, BlackHole, Mezcla estéreo', hint: 'Solo para Audio real. Vacío = el predeterminado.' },
      { path: 'visualizer.color', type: 'color', label: 'Color' },
      { path: 'visualizer.color2', type: 'color', label: 'Segundo color (degradado)' },
      { path: 'visualizer.bars', type: 'range', min: 16, max: 128, step: 8, label: 'Cantidad de barras', fmt: (v) => v },
      { path: 'visualizer.sens', type: 'range', min: 0.3, max: 3, step: 0.1, label: 'Sensibilidad', fmt: (v) => Number(v).toFixed(1) + '×' },
      {
        path: 'visualizer.position', type: 'select', label: 'Posición de las barras',
        options: () => [
          { value: 'bottom', label: 'Abajo' },
          { value: 'center', label: 'Al centro' },
        ],
      },
      { path: 'visualizer.glow', type: 'switch', label: 'Brillo neón' },
    ],
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
      { path: 'alerts.soundId', type: 'media', kind: 'audio', label: 'Sonido para todas las alertas', hint: 'Para un sonido distinto por regalo usa la pestaña Regalos.', lock: proLocked((p) => p.alerts.customSound) },
      { path: 'alerts.imageId', type: 'media', kind: 'image', label: 'Imagen o GIF para todas las alertas', lock: proLocked((p) => p.alerts.customImage) },
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
      { path: 'songs.command', type: 'text', label: 'Comando', hint: () => (me.features.youtubeSearch ? 'Ej: !sr bad bunny monaco' : 'Falta configurar YOUTUBE_API_KEY: sin ella solo funcionan links, y TikTok no deja mandar links en el chat.') },
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
    } else if (f.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.id = id;
      input.className = 'color-input';
      input.value = value;
      control.append(input);
      input.addEventListener('change', () => save(f.path, input.value));
    } else if (f.type === 'media') {
      input = mediaSelect(f.kind, value, (v) => save(f.path, v));
      input.id = id;
      control.append(input);
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

  function updateVizPreview() {
    $('vizPreview').contentWindow?.postMessage({ type: 'visualizer-preview', cfg: me.settings.visualizer }, location.origin);
  }

  async function save(path, value) {
    try {
      me = await api('/settings', 'PUT', buildPatch(path, value));
      if (path.startsWith('visualizer.')) updateVizPreview();
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
    $('urlVisualizer').value = me.overlays.visualizer;
    const prev = $('vizPreview');
    if (!prev.src) prev.src = `/o/visualizer?preview=1&k=${encodeURIComponent(me.overlayKey)}`;
    prev.onload = updateVizPreview;
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

  // ---------- archivos subidos ----------
  let mediaList = [];
  let giftsSeen = [];
  const KIND_LABEL = { audio: 'sonido', image: 'imagen' };
  const ACCEPT = { audio: 'audio/*,.mp3,.wav,.ogg,.m4a', image: 'image/png,image/jpeg,image/gif,image/webp' };
  const newId = () => Math.random().toString(36).slice(2, 10);
  const fmtSize = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

  function pickFile(kind) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = ACCEPT[kind];
      inp.onchange = () => resolve(inp.files[0] || null);
      inp.click();
    });
  }

  async function uploadFile(kind) {
    const file = await pickFile(kind);
    if (!file) return null;
    const type = file.type && file.type.startsWith(kind + '/') ? file.type : kind === 'audio' ? 'audio/mpeg' : 'image/png';
    toast('Subiendo ' + file.name + '…');
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo subir el archivo.');
    if (data.kind !== kind) toast(`Se subió, pero es una ${KIND_LABEL[data.kind]}, no un ${KIND_LABEL[kind]}.`, true);
    else toast('Archivo subido');
    mediaList.unshift(data);
    renderMediaLibrary();
    return data;
  }

  // Selector de archivo con la opción de subir uno nuevo ahí mismo.
  function mediaSelect(kind, value, onChange) {
    const sel = document.createElement('select');
    const fill = (v) => {
      sel.innerHTML = '';
      sel.append(new Option(kind === 'audio' ? 'Sonido normal' : 'Sin imagen', ''));
      for (const m of mediaList.filter((x) => x.kind === kind)) sel.append(new Option(m.name, m.id));
      sel.append(new Option(kind === 'audio' ? '＋ Subir sonido…' : '＋ Subir imagen…', '__upload'));
      sel.value = mediaList.some((m) => m.id === v) ? v : '';
      sel.dataset.prev = sel.value;
    };
    fill(value);
    sel.addEventListener('change', async () => {
      if (sel.value !== '__upload') {
        sel.dataset.prev = sel.value;
        return onChange(sel.value);
      }
      try {
        const m = await uploadFile(kind);
        if (m && m.kind === kind) {
          fill(m.id);
          return onChange(m.id);
        }
      } catch (err) {
        toast(err.message, true);
      }
      fill(sel.dataset.prev);
    });
    sel.dataset.mediaKind = kind;
    return sel;
  }

  // Guarda una lista (regalos o eventos). Los cambios se mandan en orden y la lista local
  // se conserva, porque las filas en pantalla editan esos mismos objetos.
  let saveChain = Promise.resolve();
  function saveList(key, list) {
    saveChain = saveChain.then(async () => {
      try {
        const res = await api('/settings', 'PUT', { [key]: list });
        res.settings[key] = list;
        me = res;
        toast('Guardado');
        renderQuickEvents();
      } catch (err) {
        toast(err.message, true);
      }
    });
    return saveChain;
  }

  function limitNote(el, used, max, what) {
    el.textContent = `${used} de ${max} ${what}` + (me.plan === 'free' ? ' en el plan Free.' : '.');
  }

  // ---------- sonidos por regalo ----------
  function renderGiftSounds() {
    const box = $('giftRules');
    const rules = me.settings.giftSounds;
    const max = me.planInfo.giftSounds;
    limitNote($('giftLimit'), rules.length, max, 'regalos con sonido');
    $('addGiftRule').disabled = rules.length >= max;
    box.innerHTML = rules.length ? '' : '<p class="empty">Todavía no hay regalos con sonido propio.</p>';
    for (const r of rules) {
      const row = document.createElement('div');
      row.className = 'rule';
      row.innerHTML = `
        <div class="r-gift"><span class="lbl">Regalo</span><button type="button" class="gift-pick"></button></div>
        <label class="r-sound"><span>Sonido</span></label>
        <label class="r-image"><span>Imagen (opcional)</span></label>
        <label class="r-text"><span>Texto (opcional)</span><input placeholder="${esc(me.settings.alerts.gift.template)}" value="${esc(r.text)}"></label>
        <div class="r-acts"><button class="sm" data-act="test">Probar</button><button class="sm ghost danger" data-act="remove" aria-label="Quitar regalo">Quitar</button></div>`;
      const pickBtn = row.querySelector('.gift-pick');
      const textIn = row.querySelector('.r-text input');
      const commit = () => saveList('giftSounds', me.settings.giftSounds);
      const paintPick = () => {
        const g = giftsSeen.find((x) => (r.giftId && x.id === r.giftId) || x.name === r.giftName);
        const imgUrl = g?.image || r.giftImage;
        pickBtn.innerHTML = r.giftName
          ? `${imgUrl ? `<img src="${esc(imgUrl)}" alt="" referrerpolicy="no-referrer">` : '🎁'}<span>${esc(r.giftName)}</span>${g?.diamonds ? `<small>${g.diamonds} monedas</small>` : ''}`
          : '<span class="muted">Elegir regalo…</span>';
      };
      paintPick();
      pickBtn.addEventListener('click', () =>
        openGiftPicker(pickBtn, (g) => {
          r.giftName = g.name;
          r.giftId = g.id || '';
          r.giftImage = g.image || '';
          paintPick();
          commit();
        })
      );
      textIn.addEventListener('change', () => {
        r.text = textIn.value;
        commit();
      });
      row.querySelector('.r-sound').append(mediaSelect('audio', r.soundId, (v) => ((r.soundId = v), commit())));
      row.querySelector('.r-image').append(mediaSelect('image', r.imageId, (v) => ((r.imageId = v), commit())));
      row.querySelector('[data-act=test]').addEventListener('click', () => {
        if (!r.giftName) return toast('Primero elige el regalo.', true);
        saveChain.then(() => post('/test/gift', { giftName: r.giftName, giftId: r.giftId, image: r.giftImage })).catch((e) => toast(e.message, true));
      });
      row.querySelector('[data-act=remove]').addEventListener('click', () => {
        me.settings.giftSounds = me.settings.giftSounds.filter((x) => x !== r);
        commit();
        renderGiftSounds();
      });
      box.append(row);
    }
  }

  // Selector visual de regalos (imagen, nombre y monedas), con búsqueda.
  let pickerEl = null;
  function closeGiftPicker() {
    pickerEl?.remove();
    pickerEl = null;
  }
  function openGiftPicker(anchor, onPick) {
    closeGiftPicker();
    const el = document.createElement('div');
    el.className = 'gift-picker';
    el.innerHTML = `<input type="search" placeholder="Buscar regalo…" aria-label="Buscar regalo"><ul role="listbox"></ul>`;
    document.body.append(el);
    pickerEl = el;
    const r = anchor.getBoundingClientRect();
    const width = Math.max(r.width, 300);
    el.style.width = width + 'px';
    el.style.left = Math.min(r.left + scrollX, scrollX + innerWidth - width - 12) + 'px';
    el.style.top = r.bottom + scrollY + 6 + 'px';
    const input = el.querySelector('input');
    const ul = el.querySelector('ul');
    const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const paint = () => {
      const q = norm(input.value.trim());
      // Primero los que empiezan con lo escrito ("rosa" → Rosa antes que Mi primera rosa).
      const list = giftsSeen
        .filter((g) => !q || norm(g.name).includes(q))
        .sort((a, b) => (q ? norm(b.name).startsWith(q) - norm(a.name).startsWith(q) : 0))
        .slice(0, 200);
      ul.innerHTML = '';
      if (!giftsSeen.length) {
        ul.innerHTML = '<li class="empty">La lista de regalos se carga la primera vez que conectas Mafy a un LIVE. Mientras, escribe el nombre exacto del regalo.</li>';
      }
      for (const g of list) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.tabIndex = 0;
        li.innerHTML = `${g.image ? `<img src="${esc(g.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="ph">🎁</span>'}<span><b>${esc(g.name)}</b><small>${g.diamonds || '?'} monedas</small></span>`;
        const choose = () => (onPick(g), closeGiftPicker());
        li.addEventListener('click', choose);
        li.addEventListener('keydown', (e) => e.key === 'Enter' && choose());
        ul.append(li);
      }
      const typed = input.value.trim();
      if (typed && !list.some((g) => norm(g.name) === q)) {
        const li = document.createElement('li');
        li.className = 'custom';
        li.tabIndex = 0;
        li.innerHTML = `<span class="ph">✍️</span><span><b>Usar “${esc(typed)}”</b><small>Escrito a mano</small></span>`;
        const choose = () => (onPick({ id: '', name: typed, image: '' }), closeGiftPicker());
        li.addEventListener('click', choose);
        li.addEventListener('keydown', (e) => e.key === 'Enter' && choose());
        ul.append(li);
      }
    };
    input.addEventListener('input', paint);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeGiftPicker();
      if (e.key === 'Enter') ul.querySelector('li[tabindex]')?.click();
    });
    paint();
    input.focus();
    setTimeout(() => document.addEventListener('pointerdown', function off(e) {
      if (!pickerEl || pickerEl.contains(e.target)) return;
      document.removeEventListener('pointerdown', off);
      closeGiftPicker();
    }), 0);
  }
  addEventListener('keydown', (e) => e.key === 'Escape' && closeGiftPicker());

  $('addGiftRule').addEventListener('click', () => {
    me.settings.giftSounds.push({ id: newId(), giftId: '', giftName: '', giftImage: '', soundId: '', imageId: '', text: '' });
    renderGiftSounds();
    $('giftRules').lastElementChild.querySelector('.gift-pick').click();
  });

  // ---------- sonidos por sticker ----------
  let stickersSeen = [];

  function addStickerRule(st) {
    const rules = me.settings.stickerSounds;
    const existing = rules.find((r) => r.stickerId === st.id);
    if (!existing) {
      if (rules.length >= me.planInfo.stickerSounds) {
        return toast(`Tu plan permite ${me.planInfo.stickerSounds} stickers con sonido. Quita uno para agregar otro.`, true);
      }
      rules.push({ id: newId(), stickerId: st.id, stickerImage: st.image, soundId: '', imageId: '', text: '{user}', showAlert: true });
      saveList('stickerSounds', rules);
    }
    renderStickers();
    const row = document.querySelector(`#stickerRules [data-sticker="${CSS.escape(st.id)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.querySelector('select')?.focus();
  }

  function renderStickers() {
    const rules = me.settings.stickerSounds;
    const max = me.planInfo.stickerSounds;
    const withSound = new Set(rules.map((r) => r.stickerId));
    const grid = $('stickerGrid');
    grid.innerHTML = stickersSeen.length
      ? ''
      : '<p class="empty small">Aún no se detecta ningún sticker. Conecta Mafy a tu LIVE y pide a alguien (o usa otra cuenta) que mande cada uno de tus stickers en el chat. Aparecerán aquí solos.</p>';
    for (const st of stickersSeen) {
      const b = document.createElement('button');
      b.className = 'sticker-tile' + (withSound.has(st.id) ? ' on' : '');
      b.title = withSound.has(st.id) ? 'Ya tiene sonido' : 'Ponerle sonido';
      b.innerHTML = st.image ? `<img src="${esc(st.image)}" alt="Sticker" loading="lazy" referrerpolicy="no-referrer">` : '💬';
      b.addEventListener('click', () => addStickerRule(st));
      grid.append(b);
    }

    limitNote($('stickerLimit'), rules.length, max, 'stickers con sonido');
    const box = $('stickerRules');
    box.innerHTML = '';
    for (const r of rules) {
      const latest = stickersSeen.find((x) => x.id === r.stickerId)?.image || r.stickerImage;
      const row = document.createElement('div');
      row.className = 'rule sticker';
      row.dataset.sticker = r.stickerId;
      row.innerHTML = `
        <div class="r-thumb">${latest ? `<img src="${esc(latest)}" alt="Sticker" referrerpolicy="no-referrer">` : '💬'}
          <label class="r-show"><span class="switch"><input type="checkbox"><span></span></span>Mostrar en pantalla</label></div>
        <label class="r-sound"><span>Sonido</span></label>
        <label class="r-image"><span>Imagen (opcional)</span></label>
        <label class="r-text"><span>Texto en pantalla</span><input maxlength="120" placeholder="{user}" value="${esc(r.text)}"></label>
        <div class="r-acts"><button class="sm" data-act="test">Probar</button><button class="sm ghost danger" data-act="remove">Quitar</button></div>`;
      const commit = () => saveList('stickerSounds', me.settings.stickerSounds);
      const show = row.querySelector('.r-show input');
      const textIn = row.querySelector('.r-text input');
      show.checked = r.showAlert;
      textIn.disabled = !r.showAlert;
      show.addEventListener('change', () => {
        r.showAlert = show.checked;
        textIn.disabled = !show.checked;
        commit();
      });
      textIn.addEventListener('change', () => ((r.text = textIn.value), commit()));
      row.querySelector('.r-sound').append(mediaSelect('audio', r.soundId, (v) => ((r.soundId = v), commit())));
      row.querySelector('.r-image').append(mediaSelect('image', r.imageId, (v) => ((r.imageId = v), commit())));
      row.querySelector('[data-act=test]').addEventListener('click', () =>
        saveChain.then(() => post('/test/sticker', { stickerId: r.stickerId })).catch((e) => toast(e.message, true))
      );
      row.querySelector('[data-act=remove]').addEventListener('click', () => {
        me.settings.stickerSounds = me.settings.stickerSounds.filter((x) => x !== r);
        commit();
        renderStickers();
      });
      box.append(row);
    }
  }

  // ---------- eventos manuales ----------
  function renderEvents() {
    const box = $('eventList');
    const list = me.settings.events;
    const max = me.planInfo.events;
    limitNote($('eventLimit'), list.length, max, 'eventos');
    $('addEvent').disabled = list.length >= max;
    box.innerHTML = list.length ? '' : '<p class="empty">Crea tu primer evento, por ejemplo “Capibara”.</p>';
    for (const ev of list) {
      const row = document.createElement('div');
      row.className = 'rule';
      row.innerHTML = `
        <label class="r-emoji"><span>Emoji</span><input maxlength="8" value="${esc(ev.emoji)}" placeholder="🦫"></label>
        <label class="r-gift"><span>Nombre del botón</span><input maxlength="40" value="${esc(ev.name)}" placeholder="Capibara"></label>
        <label class="r-sound"><span>Sonido</span></label>
        <label class="r-image"><span>Imagen o GIF</span></label>
        <label class="r-text"><span>Texto en pantalla</span><input maxlength="120" value="${esc(ev.text)}" placeholder="{user} mandó un capibara"></label>
        <div class="r-acts"><button class="sm" data-act="test">Probar</button><button class="sm ghost danger" data-act="remove">Quitar</button></div>`;
      const commit = () => saveList('events', me.settings.events);
      const [emojiIn, nameIn, textIn] = [row.querySelector('.r-emoji input'), row.querySelector('.r-gift input'), row.querySelector('.r-text input')];
      emojiIn.addEventListener('change', () => ((ev.emoji = emojiIn.value.trim()), commit()));
      nameIn.addEventListener('change', () => ((ev.name = nameIn.value.trim() || 'Evento'), commit()));
      textIn.addEventListener('change', () => ((ev.text = textIn.value), commit()));
      row.querySelector('.r-sound').append(mediaSelect('audio', ev.soundId, (v) => ((ev.soundId = v), commit())));
      row.querySelector('.r-image').append(mediaSelect('image', ev.imageId, (v) => ((ev.imageId = v), commit())));
      row.querySelector('[data-act=test]').addEventListener('click', () => fireEvent(ev.id, 'viewer_prueba'));
      row.querySelector('[data-act=remove]').addEventListener('click', () => {
        me.settings.events = me.settings.events.filter((x) => x !== ev);
        commit();
        renderEvents();
      });
      box.append(row);
    }
  }

  $('addEvent').addEventListener('click', async () => {
    me.settings.events.push({ id: newId(), name: 'Nuevo evento', emoji: '✨', text: '{user} ', soundId: '', imageId: '' });
    await saveList('events', me.settings.events);
    renderEvents();
    $('eventList').lastElementChild.querySelector('.r-gift input').select();
  });

  async function fireEvent(id, user) {
    try {
      await post(`/events/${encodeURIComponent(id)}/fire`, { user });
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Botonera rápida en la columna derecha.
  function renderQuickEvents() {
    const box = $('quickEvents');
    const list = me.settings.events;
    box.innerHTML = list.length ? '' : '<p class="empty">Crea eventos en la pestaña Eventos y aparecerán aquí como botones.</p>';
    for (const ev of list) {
      const b = document.createElement('button');
      b.className = 'event-btn';
      b.innerHTML = `<span class="e-emoji">${esc(ev.emoji || '✨')}</span>${esc(ev.name)}`;
      b.addEventListener('click', () => fireEvent(ev.id, $('eventUser').value.trim()));
      box.append(b);
    }
  }

  // ---------- biblioteca de archivos ----------
  function renderMediaLibrary() {
    const max = me.planInfo.media.maxFiles;
    $('mediaLimit').textContent = `${mediaList.length} de ${max} archivos · máximo ${Math.round(me.planInfo.media.maxBytes / 1e6)} MB cada uno.`;
    const box = $('mediaList');
    box.innerHTML = mediaList.length ? '' : '<li class="empty">Aún no subes archivos. Sube sonidos MP3 o imágenes y GIFs.</li>';
    for (const m of mediaList) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="m-kind">${m.kind === 'audio' ? '🔊' : '🖼️'}</span><span class="m-name" title="${esc(m.name)}">${esc(m.name)}</span><span class="small muted">${fmtSize(m.size)}</span>
        <button class="sm ghost" data-act="preview">${m.kind === 'audio' ? 'Escuchar' : 'Ver'}</button><button class="sm ghost danger" data-act="remove">Borrar</button>`;
      li.querySelector('[data-act=preview]').addEventListener('click', () => {
        if (m.kind === 'audio') new Audio(m.url).play().catch(() => toast('No se pudo reproducir.', true));
        else window.open(m.url, '_blank', 'noopener');
      });
      li.querySelector('[data-act=remove]').addEventListener('click', async () => {
        if (!confirm(`¿Borrar “${m.name}”? Se quitará de los regalos y eventos que lo usen.`)) return;
        try {
          me = await api('/media/' + encodeURIComponent(m.id), 'DELETE', {});
          mediaList = mediaList.filter((x) => x.id !== m.id);
          renderAllLists();
          toast('Archivo borrado');
        } catch (err) {
          toast(err.message, true);
        }
      });
      box.append(li);
    }
    // Actualiza los selectores abiertos para que incluyan el archivo nuevo.
    document.querySelectorAll('select[data-media-kind]').forEach((sel) => {
      const v = sel.value;
      const kind = sel.dataset.mediaKind;
      const known = new Set([...sel.options].map((o) => o.value));
      for (const m of mediaList.filter((x) => x.kind === kind && !known.has(x.id))) {
        sel.insertBefore(new Option(m.name, m.id), sel.lastElementChild);
      }
      sel.value = v;
    });
  }

  $('uploadSound').addEventListener('click', () => uploadFile('audio').catch((e) => toast(e.message, true)));
  $('uploadImage').addEventListener('click', () => uploadFile('image').catch((e) => toast(e.message, true)));

  // Si una sección falla, las demás se siguen mostrando.
  function renderAllLists() {
    for (const fn of [renderFields, renderGiftSounds, renderStickers, renderEvents, renderQuickEvents, renderMediaLibrary]) {
      try {
        fn();
      } catch (err) {
        console.error(fn.name, err);
      }
    }
  }

  // Personas recientes del chat, para el campo "para quién" de los eventos.
  const recentUsers = [];
  function rememberUser(name) {
    if (!name) return;
    const i = recentUsers.indexOf(name);
    if (i >= 0) recentUsers.splice(i, 1);
    recentUsers.unshift(name);
    recentUsers.length = Math.min(recentUsers.length, 20);
    $('recentUsers').innerHTML = recentUsers.map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  // ---------- registro de actividad ----------
  function addLog(entry, prepend = true) {
    if (prepend) rememberUser(entry.user);
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
  let giftsTimer;
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
      if (msg.type === 'log') {
        addLog(msg.entry);
        // Un regalo nuevo puede ser uno que aún no estaba en la lista para asignar sonidos.
        if (msg.entry.kind === 'sticker' && msg.entry.sticker && !stickersSeen.some((x) => x.id === msg.entry.sticker.id)) {
          stickersSeen.unshift(msg.entry.sticker);
          renderStickers();
        }
        if (msg.entry.kind === 'gift') {
          clearTimeout(giftsTimer);
          giftsTimer = setTimeout(async () => {
            giftsSeen = await api('/gifts-seen').catch(() => giftsSeen);

          }, 3000);
        }
      }
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
    if (rerender) renderAllLists();
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
    [mediaList, giftsSeen, stickersSeen] = await Promise.all([api('/media'), api('/gifts-seen'), api('/stickers-seen')]);
    renderHeader();
    renderAllLists();
    renderStatus(me.live);
    renderSongs();
    const log = await api('/log');
    if (!log.length) $('log').innerHTML = '<li class="empty">Aquí verás regalos, mensajes y canciones en cuanto pasen.</li>';
    log.forEach((e) => addLog(e, false));
    [...log].reverse().forEach((e) => rememberUser(e.user));
    connectWs();
    const q = new URLSearchParams(location.search).get('pago');
    if (q === 'ok') toast('¡Listo! Tu plan Pro se activa en unos segundos.');
    if (q) history.replaceState(null, '', '/app');
  })().catch((err) => toast(err.message, true));

  setInterval(() => refreshMe().catch(() => {}), 120_000);
})();
