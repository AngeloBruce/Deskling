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
const os = require('os');
const path = require('path');
const guard = require('./guard');
const { Brain } = require('./brain');
const { startSensors, ocr } = require('./sensors');

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
  busy: false,           // esperando respuesta de la IA
  lastSpoke: 0,          // cuándo habló por última vez (cualquier motivo)
  lastMusicSpoke: 0,     // cuándo comentó música por última vez
  lastTrack: '',         // para detectar cambio de canción
  appSince: Date.now(),  // desde cuándo estás en la app actual
  warnedNoKey: false,
  side: 'right',         // de qué lado de la ventana está Clawd (ver updateSide)
};

let win = null;
let tray = null;
let brain = null;
let sensors = null;
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
const WIN_W = 260, WIN_H = 200;
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

/** Menú compartido por la bandeja y el clic derecho sobre Clawd. */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: state.paused ? '▶ Despertar a Clawd' : '⏸ Pausar (dormir)', click: togglePause },
    {
      label: 'Ver mi pantalla (captura)',
      type: 'checkbox',
      checked: config.screenCapture,
      click: (item) => {
        config.screenCapture = item.checked;
        saveConfig();
        say(item.checked
          ? '👀 Ok, voy a mirar tu pantalla de vez en cuando (sin datos sensibles).'
          : '🙈 Listo, ya no miro tu pantalla. Solo veo títulos.');
      },
    },
    { label: '💬 Opiná ahora', click: () => speak('poke', { force: true }) },
    { type: 'separator' },
    { label: 'Ver registro de seguridad', click: () => shell.openPath(guardLogPath()) },
    { label: 'Abrir config.json', click: () => shell.openPath(CONFIG_PATH) },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() },
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
  const hay = `${proc} ${title}`.toLowerCase();
  return config.privateApps.some((p) => hay.includes(p.toLowerCase()));
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
    const check = guard.check('captura', text);
    if (check.sensitive) return null;
    return `data:image/jpeg;base64,${img.toJPEG(70).toString('base64')}`;
  } catch (e) {
    console.error('captura:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hablar con la IA
// ---------------------------------------------------------------------------

/** Arma el texto de contexto que va a la IA. Todo ya pasó por el guard. */
function buildContext(reason) {
  const lines = [];
  const reasons = {
    music: 'Acaba de cambiar la canción. Comentá la música.',
    work: 'Cambió de actividad. Comentá lo que está haciendo.',
    checkin: 'Pasó un rato. Hacé un comentario sobre cómo viene (trabajo, música o un descanso).',
    poke: 'Te tocaron para que digas algo. Comentá lo que veas.',
  };
  lines.push(reasons[reason] || reasons.checkin);

  const w = state.window;
  if (w) {
    lines.push(w.private
      ? 'App activa: una app privada (no sabés cuál, no preguntes).'
      : `App activa: ${w.process} — "${w.title}"`);
    const mins = Math.round((Date.now() - state.appSince) / 60000);
    if (mins >= 1) lines.push(`Lleva ${mins} min en esa app.`);
  }
  const m = state.media;
  if (m?.playing && m.title) lines.push(`Está escuchando: ${m.artist ? m.artist + ' - ' : ''}${m.title}`);
  else lines.push('No está sonando música.');

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
    const text = await brain.comment(buildContext(reason), image);
    debug('[brain]', reason, '→', text);
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
      if (force) say('Estoy sin señal 📡 (revisá internet o la API key)');
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
  });

  createWindow();
  createTray();

  ipcMain.on('menu', () => buildMenu().popup({ window: win }));
  ipcMain.on('poke', () => speak('poke', { force: true }));

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

  // Recordatorios de bienestar (espalda, agua, ojos…), sin usar la IA.
  setInterval(wellnessTip, config.wellness.everyMinutes * 60 * 1000);
});

/**
 * Tira un consejo de bienestar al azar de config.json → wellness.tips
 * (nunca el mismo dos veces seguidas). No gasta llamadas a la IA.
 * Si estás en pausa o Clawd está hablando de otra cosa, se lo saltea.
 */
let lastTip = -1;
function wellnessTip() {
  const tips = config.wellness.tips;
  if (state.paused || state.busy || !tips.length) return;
  let i;
  do { i = Math.floor(Math.random() * tips.length); } while (tips.length > 1 && i === lastTip);
  lastTip = i;
  say(tips[i], { sound: config.sound });
}

app.on('before-quit', () => sensors?.stop());
app.on('window-all-closed', () => app.quit());
