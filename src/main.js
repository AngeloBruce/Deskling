// =============================================================================
// main.js — Proceso principal de Electron. Es el "director de orquesta":
//
//   sensores (PowerShell) ──► guard.js (filtra datos sensibles) ──► brain.js (IA)
//          │                                                          │
//          └──── notificaciones ───────► globito ◄──── comentario ────┘
//
// Qué hace:
//   1. Crea la ventanita transparente, siempre visible, con Clawd.
//   2. Crea el ícono de la bandeja (pausar, captura on/off, salir).
//   3. Escucha los sensores: ventana activa, música y notificaciones.
//   4. Decide CUÁNDO hablar (cambio de canción, cambio de app, cada X minutos)
//      respetando los tiempos de espera para no ser pesado ni gastar el plan gratis.
// =============================================================================

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, desktopCapturer, nativeImage, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const guard = require('./guard');
const { Brain } = require('./brain');
const { Pomodoro } = require('./focus');
const { startSensors, startMediaControl, ocr } = require('./sensors');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ---------------------------------------------------------------------------
// Configuración y API key
// ---------------------------------------------------------------------------

/** Lee el .env (líneas CLAVE=valor) sin dependencias externas. El .env manda: pisa variables del sistema con el mismo nombre. */
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/** Guarda en config.json lo que se cambia desde el menú (ej: captura on/off). */
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Estado: lo último que sabemos de lo que estás haciendo
// ---------------------------------------------------------------------------
const state = {
  window: null,          // { process, title, private }
  media: null,           // { artist, title, playing, source }
  notifications: [],     // últimas notificaciones (ya filtradas), para dar contexto
  paused: false,         // pausado desde el menú → no habla ni avisa
  held: [],              // notificaciones guardadas durante el foco { app, sensitive }
  distractSince: 0,      // desde cuándo estás en una app de distracción (0 = no estás)
  distractNagged: false, // ya te avisó en esta racha de distracción
  busy: false,           // esperando respuesta de la IA
  lastSpoke: 0,          // cuándo habló por última vez (cualquier motivo)
  lastMusicSpoke: 0,     // cuándo comentó música por última vez
  lastTrack: '',         // para detectar cambio de canción
  appSince: Date.now(),  // desde cuándo estás en la app actual
  warnedNoKey: false,
  side: 'right',         // de qué lado de la ventana está Clawd (ver updateSide)
  claudePending: null,   // aviso de Claude Code que todavía no fuiste a ver { kind, project, timer }
};

let win = null;
let tray = null;
let brain = null;
let sensors = null;
let mediaCtl = null; // control de la música (ver musicCommand)
let workTimer = null;

/**
 * Log de depuración: con la variable CLAWD_DEBUG=1 escribe en logs/debug.log
 * los eventos de los sensores y lo que dice Clawd. Útil para ver qué pasa.
 */
function debug(...args) {
  if (process.env.CLAWD_DEBUG !== '1') return;
  const line = `${new Date().toISOString()} ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try { fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'logs', 'debug.log'), line); } catch {}
}

/** Manda un mensaje al globito. */
function say(text, extra = {}) {
  debug('say:', text);
  win?.webContents.send('say', { text, seconds: config.bubbleSeconds, sound: false, ...extra });
}
function mood(m) {
  win?.webContents.send('mood', m);
}

// ---------------------------------------------------------------------------
// Ventana y bandeja
// ---------------------------------------------------------------------------

// Medidas de la ventana. Clawd va en una esquina de abajo de la ventana
// (derecha o izquierda según `state.side`) y el globito crece hacia el otro lado.
const WIN_W = 260, WIN_H = 228; // alto: lo justo para que entre el menú con los controles de música
const CLAWD_W = 60, CLAWD_PAD = 8; // ancho del sprite y margen al borde (igual que style.css)

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - 12,   // esquina inferior derecha
    y: workArea.y + workArea.height - WIN_H - 4,
    frame: false,          // sin barra de título
    transparent: true,     // fondo invisible
    resizable: false,
    skipTaskbar: true,     // no aparece en la barra de tareas
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // la ventana no puede tocar Node directamente
      nodeIntegration: false,
    },
  });
  // Nivel "screen-saver": queda arriba incluso de apps en pantalla completa.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Errores y console.log de la ventana → al log de depuración.
  win.webContents.on('console-message', (_e, level, message) => debug(`[ventana:${level}]`, message));
  win.webContents.on('preload-error', (_e, p, err) => debug('[preload-error]', err.message));
}

/**
 * Elige de qué lado de la ventana va Clawd para que el globito tenga espacio:
 *   - Clawd en la mitad DERECHA de la pantalla → Clawd a la derecha, el globito crece hacia la izquierda.
 *   - Clawd en la mitad IZQUIERDA → Clawd a la izquierda, el globito crece hacia la derecha.
 * Al cambiar de lado corremos la ventana para que Clawd quede en el mismo lugar
 * de la pantalla (no "salta"); solo cambia hacia dónde sale el globito.
 */
function updateSide() {
  const [x, y] = win.getPosition();
  const offsetRight = WIN_W - CLAWD_PAD - CLAWD_W; // dónde está Clawd dentro de la ventana si está a la derecha
  const clawdX = state.side === 'right' ? x + offsetRight : x + CLAWD_PAD; // borde izquierdo de Clawd en pantalla
  const { workArea } = screen.getDisplayNearestPoint({ x: clawdX, y });
  const side = clawdX + CLAWD_W / 2 > workArea.x + workArea.width / 2 ? 'right' : 'left';
  if (side !== state.side) {
    state.side = side;
    win.setPosition(side === 'right' ? clawdX - offsetRight : clawdX - CLAWD_PAD, y);
  }
  win.webContents.send('side', state.side);
}

/**
 * Ícono de la bandeja: un mini Clawd de 16x16 dibujado píxel a píxel
 * (así no hace falta un archivo .png/.ico).
 */
function trayIcon() {
  const rows = [
    '................',
    '................',
    '................',
    '..############..',
    '..############..',
    '#####.####.#####',
    '#####.####.#####',
    '..############..',
    '..############..',
    '..############..',
    '...#.#....#.#...',
    '...#.#....#.#...',
    '...#.#....#.#...',
    '................',
    '................',
    '................',
  ];
  const buf = Buffer.alloc(16 * 16 * 4); // formato BGRA
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== '#') return;
    const i = (y * 16 + x) * 4;
    buf[i] = 0x57; buf[i + 1] = 0x77; buf[i + 2] = 0xd9; buf[i + 3] = 0xff; // #d97757
  }));
  return nativeImage.createFromBitmap(buf, { width: 16, height: 16 });
}

/**
 * Acciones del menú. Las usan los dos menús: el propio (clic derecho sobre
 * Clawd, lo dibuja renderer.js) y el nativo de la bandeja.
 */
const MENU_ACTIONS = {
  pause: () => togglePause(),
  focus: () => (pomodoro.active ? pomodoro.stop() : pomodoro.start()),
  'music-toggle': () => musicCommand('toggle'),
  'music-next': () => musicCommand('next'),
  'music-prev': () => musicCommand('prev'),
  capture: () => setCapture(!config.screenCapture),
  poke: () => speak('poke', { force: true }),
  guardlog: () => shell.openPath(guardLogPath()),
  config: () => shell.openPath(CONFIG_PATH),
  quit: () => goodbye(),
};

/** Despedida: Clawd saluda y se encoge (renderer.js) y recién ahí cerramos. */
let leaving = false;
function goodbye() {
  if (leaving) return;
  leaving = true;
  if (!win?.isVisible()) return app.quit(); // si estaba escondido, no hay nada que mostrar
  win.webContents.send('goodbye');
  setTimeout(() => app.quit(), 1700); // lo que dura la animación "bye" de style.css
}

function setCapture(on) {
  config.screenCapture = on;
  saveConfig();
  say(on
    ? '👀 Ok, voy a mirar tu pantalla de vez en cuando (sin datos sensibles).'
    : '🙈 Listo, ya no miro tu pantalla. Solo veo títulos.');
}

/** Menú nativo de Windows: solo para el ícono de la bandeja. */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: state.paused ? '▶ Despertar a Clawd' : '⏸ Pausar (dormir)', click: MENU_ACTIONS.pause },
    { label: 'Ver mi pantalla (captura)', type: 'checkbox', checked: config.screenCapture, click: MENU_ACTIONS.capture },
    { label: '💬 Opiná ahora', click: MENU_ACTIONS.poke },
    { label: pomodoro.active ? '🍅 Terminar foco' : `🍅 Modo foco (${config.focus.workMinutes} min)`, click: MENU_ACTIONS.focus },
    { label: '⏯ Música: play / pausa', click: MENU_ACTIONS['music-toggle'] },
    { label: '⏭ Música: siguiente', click: MENU_ACTIONS['music-next'] },
    { type: 'separator' },
    { label: 'Ver registro de seguridad', click: MENU_ACTIONS.guardlog },
    { label: 'Abrir config.json', click: MENU_ACTIONS.config },
    { type: 'separator' },
    { label: 'Salir', click: MENU_ACTIONS.quit },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Clawd Buddy');
  tray.on('click', () => win.isVisible() ? win.hide() : win.show());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

function togglePause() {
  state.paused = !state.paused;
  mood(state.paused ? 'sleeping' : 'idle');
  if (!state.paused) say('¡Volví! ¿Qué me perdí? 👀');
}

function guardLogPath() {
  return path.join(ROOT, 'logs', 'guard.log');
}

// ---------------------------------------------------------------------------
// Privacidad
// ---------------------------------------------------------------------------

/** ¿La ventana activa es de una app privada (banco, gestor de contraseñas, login…)? */
function isPrivate(proc, title) {
  // sin acentos de los dos lados: "Enlace Móvil" coincide con "enlace movil"
  const hay = guard.normalize(`${proc} ${title}`);
  return config.privateApps.some((p) => hay.includes(guard.normalize(p)));
}

/**
 * Saca una captura de la pantalla y la pasa por el guard:
 *   1. Captura reducida (1280 px de ancho).
 *   2. OCR LOCAL con el motor de Windows (no sale nada de la PC).
 *   3. Si el texto tiene contraseñas, códigos, etc. → NO se manda la captura.
 * Devuelve un data URL jpeg o null.
 */
async function safeScreenshot() {
  if (!config.screenCapture || state.window?.private) return null;
  try {
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (!src) return null;
    const img = src.thumbnail;
    const tmp = path.join(os.tmpdir(), `clawd-${process.pid}.png`);
    fs.writeFileSync(tmp, img.toPNG());
    const text = await ocr(tmp);
    fs.rmSync(tmp, { force: true });
    if (text === null) return null; // si el OCR falla, por las dudas no mandamos nada
    // reglas estrictas: ante cualquier "código", "emparejar", dígitos en cajitas… no se manda
    if (guard.checkCapture(text).block) return null;
    return `data:image/jpeg;base64,${img.toJPEG(70).toString('base64')}`;
  } catch (e) {
    console.error('captura:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hablar con la IA
// ---------------------------------------------------------------------------

/**
 * Arma el texto de contexto que va a la IA. Todo ya pasó por el guard.
 * Con `withImage`, le pedimos que hable de la CAPTURA y no le pasamos la
 * música (si se la pasamos, siempre termina comentando la canción porque es
 * lo más fácil).
 */
function buildContext(reason, withImage = false) {
  const lines = [];
  const reasons = {
    music: 'Acaba de cambiar la canción. Comentá la música.',
    work: 'Cambió de actividad. Comentá lo que está haciendo.',
    checkin: 'Pasó un rato. Hacé un comentario sobre cómo viene (trabajo, música o un descanso).',
    poke: 'Te tocaron para que digas algo. Comentá lo que veas.',
  };
  lines.push(reasons[reason] || reasons.checkin);
  if (withImage) {
    lines.push('Tenés una CAPTURA de su pantalla adjunta: comentá algo CONCRETO que se vea en ella '
      + '(el programa que escribe, la página, un error, lo que esté haciendo). Esta vez NO hables de la música, '
      + 'y usá un emoji que tenga que ver con lo que ves.');
    // segunda capa de seguridad (la primera es no mandar la captura, ver safeScreenshot)
    lines.push('MUY IMPORTANTE: NUNCA repitas números, códigos, contraseñas, emails, teléfonos ni nombres '
      + 'de personas que aparezcan en la captura. Si ves algo así, ignoralo y comentá otra cosa.');
  }

  const w = state.window;
  if (w) {
    lines.push(w.private
      ? 'App activa: una app privada (no sabés cuál, no preguntes).'
      : `App activa: ${w.process} — "${w.title}"`);
    const mins = Math.round((Date.now() - state.appSince) / 60000);
    if (mins >= 1) lines.push(`Lleva ${mins} min en esa app.`);
  }
  const m = state.media;
  if (!withImage) {
    if (m?.playing && m.title) lines.push(`Está escuchando: ${m.artist ? m.artist + ' - ' : ''}${m.title}`);
    else lines.push('No está sonando música.');
  }

  if (state.notifications.length) {
    lines.push(`Notificaciones recientes de: ${[...new Set(state.notifications.map((n) => n.app))].join(', ')}`);
  }
  lines.push(`Hora: ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`);
  return lines.join('\n');
}

/**
 * Pide un comentario a la IA y lo muestra.
 * Respeta: pausa, si ya está pensando, y los tiempos de espera (cooldown).
 */
async function speak(reason, { force = false } = {}) {
  if (state.paused || state.busy || !brain) return;
  // En foco no opina de nada (salvo que lo toques con "Opiná ahora").
  if (pomodoro.working && reason !== 'poke') return;
  const now = Date.now();
  if (!force) {
    if (now - state.lastSpoke < config.cooldownSeconds * 1000) return;
    if (reason === 'music' && now - state.lastMusicSpoke < config.musicCooldownSeconds * 1000) return;
  }

  state.busy = true;
  mood('thinking');
  try {
    // Captura solo en check-ins o cuando lo tocás (las demás veces alcanza con el título).
    const image = (reason === 'checkin' || reason === 'poke') ? await safeScreenshot() : null;
    // dos versiones del contexto: con captura (hablá de la pantalla) y sin
    // captura (por si la visión falla y brain.js comenta solo con texto)
    const raw = await brain.comment(buildContext(reason, !!image), image, buildContext(reason));
    // tercera capa: si vio una captura, tachamos cualquier número de 4+ cifras que diga
    const text = image ? guard.redactNumbers(raw) : raw;
    debug('[brain]', reason, image ? '(con captura)' : '', '→', text);
    if (brain.lastVisionError) {
      // La captura falló y comentó solo con el texto: lo dejamos anotado.
      debug('[vision-error]', brain.lastVisionError);
      brain.lastVisionError = null;
    }
    state.lastSpoke = Date.now();
    if (reason === 'music') state.lastMusicSpoke = state.lastSpoke;
    if (text) say(text);
    else mood('idle');
  } catch (e) {
    mood('idle');
    if (e.message === 'NO_KEY') {
      if (!state.warnedNoKey) say('Me falta la API key 🔑 Copiá .env.example a .env y poné tu key de Groq.', { seconds: 30 });
      state.warnedNoKey = true;
    } else if (e.message === 'RATE_LIMITED') {
      // plan gratis al límite: nos quedamos callados un rato, sin molestar
    } else {
      console.error('brain:', e.message);
      debug('[brain-error]', e.message);
      // Solo avisamos si lo pediste vos (doble clic / menú); si no, silencio.
      if (force) {
        const msgs = {
          BAD_KEY: '🔑 La API key no funciona. Revisala en el .env.',
          NO_MODEL: '🤖 El modelo de IA no está disponible. Cambialo en config.json.',
        };
        const offline = e.name === 'TimeoutError' || e.name === 'TypeError'; // fetch sin internet
        say(msgs[e.message] || (offline ? 'Estoy sin señal 📡 Revisá tu internet.' : '😵 Algo falló con la IA. Mirá logs/debug.log.'));
      }
    }
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Sensores → eventos
// ---------------------------------------------------------------------------

function wireSensors() {
  sensors = startSensors();
  for (const t of ['window', 'media', 'notification', 'status']) sensors.on(t, (e) => debug(`[sensor:${t}]`, e));

  // Cambió la ventana activa.
  sensors.on('window', ({ process: proc, title }) => {
    // Ignoramos nuestra propia ventana (al hacer clic en Clawd).
    if (/^electron$/i.test(proc) || title === 'Clawd Buddy') return;
    const priv = isPrivate(proc, title);
    const clean = priv ? '[app privada]' : guard.check('ventana', title).clean;
    // ¿Fuiste a mirar a Claude? Entonces ya no hace falta insistir.
    if (state.claudePending && isClaudeApp(proc)) clearClaudePending();
    const changedApp = state.window?.process !== proc;
    state.window = { process: proc, title: clean, private: priv };
    if (changedApp) {
      state.appSince = Date.now();
      // Esperamos unos segundos: si solo pasaste de largo por una app, no comenta.
      clearTimeout(workTimer);
      workTimer = setTimeout(() => speak('work'), config.workCommentDelaySeconds * 1000);
    }
  });

  // Cambió la música (o se pausó).
  sensors.on('media', (m) => {
    state.media = {
      ...m,
      artist: guard.check('musica', m.artist || '').clean,
      title: guard.check('musica', m.title || '').clean,
    };
    // Baile: solo cuando la música viene de Spotify (en otras apps no baila).
    win?.webContents.send('music', { spotifyPlaying: !!m.playing && /spotify/i.test(m.source || '') });
    const track = `${m.artist}|${m.title}`;
    if (m.playing && m.title && track !== state.lastTrack) {
      state.lastTrack = track;
      speak('music');
    }
  });

  // Llegó una notificación de Windows (se ve aunque esté "No molestar").
  sensors.on('notification', (n) => {
    if (config.ignoredNotificationApps.includes(n.app)) return;
    const title = guard.check(`noti:${n.app}`, n.title || '');
    const body = guard.check(`noti:${n.app}`, n.body || '');
    const sensitive = title.sensitive || body.sensitive;

    state.notifications.push({ app: n.app, at: Date.now() });
    if (state.notifications.length > 10) state.notifications.shift();

    if (state.paused) return;
    // En foco: las notificaciones se guardan y te las resume en el descanso,
    // salvo las de apps importantes (config.focus.priorityApps, ej: llamadas).
    if (pomodoro.working && !config.focus.priorityApps.includes(n.app)) {
      state.held.push({ app: n.app, sensitive });
      return;
    }
    if (sensitive) {
      // No mostramos el contenido: solo avisamos que llegó algo delicado.
      say(`🔐 ${n.app}: te llegó un código o contraseña. No lo leo, fijate vos 👀`, { alert: true, sound: config.sound });
    } else {
      const text = [title.clean, body.clean].filter(Boolean).join(': ');
      const short = text.length > 140 ? text.slice(0, 137) + '…' : text;
      say(`📩 ${n.app} — ${short}`, { alert: true, sound: config.sound });
    }
  });

  sensors.on('status', (s) => {
    if (s.notifications !== 'Allowed') {
      say('No puedo leer tus notificaciones 😢 Activalo en Configuración → Privacidad → Notificaciones.', { seconds: 20 });
    }
  });
  sensors.on('error', (e) => console.error('sensores:', e.message));
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

// Una sola instancia: si ya está abierto, no abrimos otro Clawd.
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  loadEnv();
  guard.setLogFile(guardLogPath());

  const p = config.providers[config.provider];
  brain = new Brain({
    baseURL: p.baseURL,
    apiKey: process.env[p.envKey],
    model: p.model,
    visionModel: p.visionModel,
    personality: config.personality,
    extra: p.extra,
    visionExtra: p.visionExtra,
  });

  createWindow();
  createTray();

  // Clic derecho sobre Clawd → el menú propio. Le pasamos el estado actual
  // (pausado, captura) para que muestre los interruptores bien.
  ipcMain.on('menu', () => {
    win.focus(); // así, si hacés clic en otra ventana, el menú se cierra (ver 'blur')
    const m = state.media;
    win.webContents.send('menu-open', {
      paused: state.paused,
      screenCapture: config.screenCapture,
      focusing: pomodoro.active,
      // la canción (ya filtrada por el guard) para la fila de controles de música
      music: m?.title ? { title: m.title, artist: m.artist, playing: !!m.playing } : null,
    });
  });
  ipcMain.on('menu-action', (_e, name) => MENU_ACTIONS[name]?.());

  // Clics que atraviesan: la ventana es más grande que Clawd (para que entre el
  // globito) y la parte transparente tapaba botones de otras apps. Así que por
  // defecto la ventana IGNORA el mouse (los clics pasan a la app de abajo) y
  // renderer.js nos avisa cuando el mouse está sobre Clawd, el globito o el menú.
  // `forward: true` hace que igual nos lleguen los movimientos del mouse.
  win.setIgnoreMouseEvents(true, { forward: true });
  ipcMain.on('mouse-capture', (_e, on) => win.setIgnoreMouseEvents(!on, { forward: true }));
  win.on('blur', () => win.webContents.send('menu-close'));
  ipcMain.on('poke', () => speak('poke', { force: true }));
  // rueda del mouse sobre Clawd: para arriba = siguiente, para abajo = anterior
  ipcMain.on('music-wheel', (_e, dir) => musicCommand(dir > 0 ? 'next' : 'prev'));

  mediaCtl = startMediaControl();
  mediaCtl.on('result', onMusicResult);
  mediaCtl.on('error', (e) => debug('[musica] error:', e.message));

  // Arrastre propio: al agarrar guardamos dónde estaba la ventana y al mover
  // la corremos lo mismo que se movió el mouse.
  let dragFrom = null;
  ipcMain.on('drag-start', () => { dragFrom = win.getPosition(); });
  ipcMain.on('drag-move', (_e, dx, dy) => {
    if (dragFrom) win.setPosition(Math.round(dragFrom[0] + dx), Math.round(dragFrom[1] + dy));
  });
  // Al soltarlo, decidimos de qué lado sale el globito.
  ipcMain.on('drag-end', () => { dragFrom = null; updateSide(); });

  win.webContents.once('did-finish-load', () => {
    updateSide();
    say('¡Hola! Soy Clawd 🦀 Te acompaño mientras trabajás.');
    wireSensors();
  });

  // Check-in periódico (con captura si está activada).
  setInterval(() => speak('checkin'), config.checkinMinutes * 60 * 1000);

  if (config.claudeCode?.enabled) startClaudeServer();

  // Recordatorios de bienestar (espalda, agua, ojos…), sin usar la IA.
  setInterval(wellnessTip, config.wellness.everyMinutes * 60 * 1000);

  // ¿Te fuiste a YouTube/TikTok…? (ver checkDistraction)
  setInterval(checkDistraction, 10 * 1000);
});

/**
 * Tira un consejo de bienestar al azar de config.json → wellness.tips
 * (nunca el mismo dos veces seguidas). No gasta llamadas a la IA.
 * Si estás en pausa o Clawd está hablando de otra cosa, se lo saltea.
 */
let lastTip = -1;
function randomTip() {
  const tips = config.wellness.tips;
  return tips[Math.floor(Math.random() * tips.length)] || '';
}

function wellnessTip() {
  const tips = config.wellness.tips;
  if (state.paused || state.busy || pomodoro.working || !tips.length) return; // en foco, el tip llega en el descanso
  let i;
  do { i = Math.floor(Math.random() * tips.length); } while (tips.length > 1 && i === lastTip);
  lastTip = i;
  say(tips[i], { sound: config.sound });
}

app.on('before-quit', () => sensors?.stop());
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// Avisos de Claude Code
//
// hooks/clawd-hook.js (lo ejecuta Claude Code) nos manda un POST a
// http://127.0.0.1:<puerto>/claude cuando Claude termina ("Stop") o necesita
// algo ("Notification"). Si no vas a mirar en `nagMinutes`, Clawd se enoja >:(
// El servidor solo escucha en 127.0.0.1: nada de afuera de tu PC puede usarlo.
// ---------------------------------------------------------------------------

/** ¿Este proceso es donde usás Claude Code? (app de Claude, terminal, VS Code…) */
function isClaudeApp(proc) {
  return config.claudeCode.apps.some((a) => proc.toLowerCase() === a.toLowerCase());
}

function clearClaudePending() {
  clearTimeout(state.claudePending?.timer);
  state.claudePending = null;
}

function startClaudeServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/claude') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 10000) req.destroy(); }); // límite por las dudas
    req.on('end', () => {
      res.writeHead(204).end();
      try { onClaudeEvent(JSON.parse(body)); } catch (e) { debug('[claude] JSON inválido', e.message); }
    });
  });
  server.on('error', (e) => debug('[claude] servidor:', e.message)); // ej: puerto ocupado
  server.listen(config.claudeCode.port, '127.0.0.1', () => debug('[claude] escuchando en', config.claudeCode.port));
}

/** Llega un evento de Claude Code. */
function onClaudeEvent({ event, message, cwd }) {
  debug('[claude]', event, message);
  if (state.paused) return;
  // Si ya estás mirando a Claude, no hace falta avisarte.
  if (state.window && isClaudeApp(state.window.process)) return;

  const project = guard.check('claude', path.basename(cwd || '') || 'tu proyecto').clean;
  const needsYou = event === 'Notification';
  const detail = needsYou ? guard.check('claude', message || '').clean : '';

  if (needsYou) {
    // "Claude needs your permission to use Bash" / "Claude is waiting for your input"
    const text = /permission/i.test(detail) ? `🔐 Claude necesita tu permiso en ${project}` : `⏳ Claude te está esperando en ${project}`;
    say(text, { alert: true, sound: config.sound, face: 'squint' });
  } else {
    say(`✅ ¡Claude terminó en ${project}!`, { sound: config.sound, face: 'happy' });
  }

  // Si en `nagMinutes` no fuiste a mirar → carita enojada.
  clearClaudePending();
  const kind = needsYou ? 'te necesita' : 'terminó';
  state.claudePending = {
    timer: setTimeout(() => {
      if (state.paused) return;
      say(`😤 ¡Oye! Claude ${kind} hace rato en ${project}. ¿Qué haces?`, { alert: true, sound: config.sound, face: 'angry', seconds: 20 });
      state.claudePending = null;
    }, config.claudeCode.nagMinutes * 60 * 1000),
  };
}

// =============================================================================
// Modo foco (pomodoro) — la cuenta del tiempo está en focus.js
// Durante el foco Clawd no opina, no tira tips y GUARDA las notificaciones
// (salvo las de config.focus.priorityApps). Los avisos de Claude Code sí pasan:
// son parte de tu trabajo. En el descanso te resume lo que llegó.
// =============================================================================
const pomodoro = new Pomodoro({ ...config.focus, onPhase: onFocusPhase });

function onFocusPhase({ phase, endsAt, cycle, prev }) {
  debug('[foco]', phase, 'ciclo', cycle);
  win?.webContents.send('focus', { phase, endsAt });
  const f = config.focus;

  if (phase === 'work') {
    state.held = [];
    if (prev === 'off') say(`🍅 ¡Modo foco! ${f.workMinutes} min. Me quedo calladito y te guardo las notis.`, { face: 'happy' });
    else say(`💪 ¡Volvemos! Otros ${f.workMinutes} min de foco.`, { sound: config.sound, face: 'happy' });
  } else if (phase === 'break' || phase === 'longBreak') {
    const mins = phase === 'longBreak' ? f.longBreakMinutes : f.breakMinutes;
    const extra = phase === 'longBreak' ? ` ¡Ya van ${cycle} 🍅, te ganaste uno largo!` : '';
    say(`⏰ ¡Listo el foco! Descanso de ${mins} min.${extra} ${randomTip()}`, { alert: true, sound: config.sound, face: 'happy', seconds: 15 });
    setTimeout(releaseHeld, 6000); // el resumen de notis, después del festejo
  } else if (phase === 'off' && prev !== 'off') {
    say(cycle ? `✅ Foco terminado. ¡Hiciste ${cycle} 🍅, bien ahí!` : '✅ Listo, salimos del modo foco.', { face: 'happy' });
    setTimeout(releaseHeld, 4000);
  }
}

/** Resume las notificaciones guardadas: "3 de WhatsApp, 1 de Discord". */
function releaseHeld() {
  if (!state.held.length) return;
  const count = {};
  for (const n of state.held) count[n.app] = (count[n.app] || 0) + 1;
  const list = Object.entries(count).map(([a, c]) => `${c} de ${a}`).join(', ');
  const secret = state.held.some((n) => n.sensitive) ? ' (hay un código 🔐, fijate vos)' : '';
  say(`📬 Mientras te concentrabas: ${list}${secret}`, { alert: true, sound: config.sound, seconds: 15 });
  state.held = [];
}

// =============================================================================
// Aviso de distracción
// Si la ventana activa parece YouTube/TikTok/etc. (config.distractions.keywords):
//   - en foco, te avisa a los pocos segundos (focusSeconds);
//   - fuera del foco, después de un rato largo (minutes).
// Te avisa una sola vez por racha: si te vas y volvés, empieza de nuevo.
// =============================================================================
function checkDistraction() {
  const d = config.distractions;
  const w = state.window;
  const hay = w && !w.private ? `${w.process} ${w.title}`.toLowerCase() : '';
  const site = d.keywords.find((k) => hay.includes(k));
  if (!site) { state.distractSince = 0; state.distractNagged = false; return; }

  if (!state.distractSince) state.distractSince = Date.now();
  if (state.distractNagged || state.paused) return;
  const elapsed = Date.now() - state.distractSince;
  const name = site.charAt(0).toUpperCase() + site.slice(1);

  if (pomodoro.working && elapsed >= d.focusSeconds * 1000) {
    state.distractNagged = true;
    say(`👀 Oye… estamos en modo foco y eso parece ${name}. ¿Volvemos?`, { alert: true, sound: config.sound, face: 'squint' });
  } else if (!pomodoro.working && elapsed >= d.minutes * 60 * 1000) {
    state.distractNagged = true;
    say(`📱 Llevas ${Math.round(elapsed / 60000)} min en ${name}. ¿Un ratito más o volvemos?`, { sound: config.sound, face: 'squint' });
  }
}

// =============================================================================
// Control de la música (play/pausa, siguiente, anterior)
// Se usa desde el menú y con la rueda del mouse sobre Clawd. La orden la
// ejecuta media-control.ps1 sobre la app que esté sonando (Spotify, navegador…).
// =============================================================================
let lastMusicCmd = { cmd: '', wasPlaying: false };

function musicCommand(cmd) {
  lastMusicCmd = { cmd, wasPlaying: !!state.media?.playing };
  debug('[musica]', cmd);
  mediaCtl?.send(cmd);
}

/** Respuesta de media-control.ps1: avisamos con un globito cortito. */
function onMusicResult({ cmd, ok, reason }) {
  debug('[musica] resultado', cmd, ok, reason || '');
  if (!ok) {
    say(reason === 'sin-musica' ? '🤷 No hay música sonando para controlar.' : '😵 No pude controlar la música.', { seconds: 3 });
    return;
  }
  const texts = {
    toggle: lastMusicCmd.wasPlaying ? '⏸ Pausé la música.' : '▶ ¡Dale play!',
    next: '⏭ Siguiente canción…',
    prev: '⏮ La anterior…',
  };
  // Si pasás de canción, en un toque llega el comentario de la nueva (sensors 'media').
  say(texts[cmd] || '🎵', { seconds: 3, face: 'happy' });
}
