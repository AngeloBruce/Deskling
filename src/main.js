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

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, desktopCapturer, nativeImage, shell, powerMonitor } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const guard = require('./guard');
const { Brain } = require('./brain');
const { Pomodoro } = require('./focus');
const { DayStats } = require('./stats');
const { startSensors, ocr } = require('./sensors');

const ROOT = path.join(__dirname, '..');
// Dónde van los archivos que Clawd escribe (config, .env, logs):
//   - con `npm start` → la carpeta del proyecto, como siempre;
//   - instalado (.exe) → %APPDATA%\Deskling, porque el programa instalado es
//     de solo lectura. El config.json del proyecto queda como "valores por defecto".
const DATA = app.isPackaged ? app.getPath('userData') : ROOT;
const CONFIG_PATH = path.join(DATA, 'config.json');
const LOGS = path.join(DATA, 'logs');

// ---------------------------------------------------------------------------
// Configuración y API key
// ---------------------------------------------------------------------------

/** Lee el .env (líneas CLAVE=valor) sin dependencias externas. El .env manda: pisa variables del sistema con el mismo nombre. */
function loadEnv() {
  const file = path.join(DATA, '.env');
  const loaded = new Set(); // qué variables salieron del .env (para el log de arranque)
  if (!fs.existsSync(file)) return loaded;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2]) { process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); loaded.add(m[1]); }
  }
  return loaded;
}

/**
 * Lee la config: los valores por defecto (config.json del proyecto) + lo que
 * cambiaste vos. Así, si una versión nueva agrega opciones, no se rompe.
 */
let configReadError = null; // para el log de arranque
function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (CONFIG_PATH === path.join(ROOT, 'config.json')) return defaults;
  let mine = {};
  try { mine = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { configReadError = e.code || e.message; /* primera vez: no hay */ }
  const merged = { ...defaults, ...mine };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n'); // así lo podés abrir y editar
  return merged;
}
const config = loadConfig();

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
let workTimer = null;

/**
 * Log de depuración: con la variable CLAWD_DEBUG=1 escribe en logs/debug.log
 * los eventos de los sensores y lo que dice Clawd. Útil para ver qué pasa.
 */
function debug(...args) {
  if (process.env.CLAWD_DEBUG !== '1') return;
  const line = `${new Date().toISOString()} ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'debug.log'), line); } catch {}
}

/**
 * Errores importantes, SIEMPRE (no hace falta CLAWD_DEBUG): logs/errors.log.
 * Nunca escribe la key ni lo que ves; solo qué falló.
 */
function errorLog(msg) {
  debug('[error]', msg);
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'errors.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
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
const WIN_W = 260, WIN_H = 272; // alto: lo justo para que entre el menú (y la tarjeta del resumen)
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
  summary: () => showSummary(true),
  'music-toggle': () => musicCommand('toggle'),
  'music-next': () => musicCommand('next'),
  'music-prev': () => musicCommand('prev'),
  capture: () => setCapture(!config.screenCapture),
  autostart: () => setAutoStart(!config.autoStart),
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

/**
 * Arrancar con Windows: Electron escribe una entrada en
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run (solo tu usuario, sin admin).
 * Mientras no haya instalador (.exe), lo que se registra es electron.exe + la
 * carpeta del proyecto, que es lo mismo que hace `npm start`.
 */
function loginItemOpts() {
  // entre comillas: las rutas pueden tener espacios y Windows las cortaría ahí
  if (app.isPackaged) return { name: 'Deskling', path: `"${process.execPath}"` };
  return { name: 'Deskling', path: `"${process.execPath}"`, args: [`"${ROOT}"`] };
}
function applyAutoStart(force = false) {
  app.setLoginItemSettings({ openAtLogin: !!config.autoStart, ...loginItemOpts() });
  if (config.autoStart) approveStartup(force);
  if (app.isPackaged) logonTask(!!config.autoStart);
}

/**
 * Plan B (el que de verdad funciona en algunas versiones de Windows 11): una
 * tarea del Programador de tareas que abre Clawd cuando iniciás sesión.
 * En esas versiones la lista de "Run" no abre ninguna app de tu usuario,
 * aunque esté activada. La tarea es solo de tu usuario y no pide administrador.
 * Si las dos cosas abren Clawd, el segundo se cierra solo (una sola instancia).
 */
const TASK = 'Deskling';
function logonTask(on) {
  const opts = { windowsHide: true };
  if (!on) return execFile('schtasks.exe', ['/delete', '/tn', TASK, '/f'], opts, () => {});
  // schtasks /query termina con error si la tarea no existe → recién ahí la creamos
  execFile('schtasks.exe', ['/query', '/tn', TASK], opts, (missing) => {
    if (!missing) return;
    const exe = process.execPath.replace(/'/g, "''");
    const ps = [
      '$u = "$env:USERDOMAIN\\$env:USERNAME"',
      '$t = New-ScheduledTaskTrigger -AtLogOn -User $u',
      "$t.Delay = 'PT10S'", // 10 s después de entrar, cuando el escritorio ya cargó
      `$a = New-ScheduledTaskAction -Execute '${exe}'`,
      '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew',
      '$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited',
      `Register-ScheduledTask -TaskName '${TASK}' -Action $a -Trigger $t -Settings $s -Principal $p -Description 'Abre Clawd al iniciar sesión' -Force | Out-Null`,
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], opts,
      (err) => debug('[arranque] tarea programada', err ? `falló: ${err.message}` : 'creada'));
  });
}

/**
 * Windows guarda aparte qué apps de inicio están ACTIVADAS (lo que muestra el
 * Administrador de tareas → Aplicaciones de arranque). Si la nuestra no tiene
 * marca, algunas versiones de Windows 11 la tratan como desactivada y no la abren.
 * Electron debería escribirla pero no lo hace, así que la escribimos nosotros:
 *   - si no hay marca → la ponemos como activada (02);
 *   - si la desactivaste en el Administrador de tareas (03) → la respetamos,
 *     salvo que la vuelvas a prender desde el menú de Clawd (force).
 */
const STARTUP_APPROVED = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`;
function approveStartup(force) {
  const enable = () => execFile('reg.exe', ['add', STARTUP_APPROVED, '/v', 'Deskling', '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f'],
    { windowsHide: true }, (err) => debug('[arranque] marca de activado', err ? `falló: ${err.message}` : 'ok'));
  if (force) return enable();
  // reg query termina con error si el valor no existe
  execFile('reg.exe', ['query', STARTUP_APPROVED, '/v', 'Deskling'], { windowsHide: true }, (err) => { if (err) enable(); });
}

function setAutoStart(on) {
  config.autoStart = on;
  saveConfig();
  applyAutoStart(true);
  say(on ? '🚀 ¡Listo! Cuando prendas la compu, aparezco solo.' : '👌 Ok, ya no arranco con Windows. Abrime con npm start.');
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
    { label: 'Arrancar con Windows', type: 'checkbox', checked: !!config.autoStart, click: MENU_ACTIONS.autostart },
    { label: '💬 Opiná ahora', click: MENU_ACTIONS.poke },
    { label: pomodoro.active ? '🍅 Terminar foco' : `🍅 Modo foco (${config.focus.workMinutes} min)`, click: MENU_ACTIONS.focus },
    { label: '⏯ Música: play / pausa', click: MENU_ACTIONS['music-toggle'] },
    { label: '⏭ Música: siguiente', click: MENU_ACTIONS['music-next'] },
    { label: '📊 Terminé por hoy', click: MENU_ACTIONS.summary },
    { type: 'separator' },
    { label: 'Ver registro de seguridad', click: MENU_ACTIONS.guardlog },
    { label: 'Abrir config.json', click: MENU_ACTIONS.config },
    { type: 'separator' },
    { label: 'Salir', click: MENU_ACTIONS.quit },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Deskling');
  tray.on('click', () => win.isVisible() ? win.hide() : win.show());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

function togglePause() {
  state.paused = !state.paused;
  mood(state.paused ? 'sleeping' : 'idle');
  if (!state.paused) say('¡Volví! ¿Qué me perdí? 👀');
}

function guardLogPath() {
  return path.join(LOGS, 'guard.log');
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
    errorLog(`IA (${reason}): ${e.name} ${e.message}`);
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
        // TimeoutError = el servidor de la IA no contestó a tiempo (tu internet puede andar bien)
        // TypeError "fetch failed" = no se pudo ni conectar (ahí sí suele ser el internet)
        const slow = e.name === 'TimeoutError';
        const offline = e.name === 'TypeError' && /fetch/i.test(e.message);
        say(msgs[e.message] || (slow ? '🐢 La IA no me contesta: su servidor está lento o caído. Probá más tarde o cambiá de modelo.'
          : offline ? 'Estoy sin señal 📡 Revisá tu internet.' : '😵 Algo falló con la IA. Mirá logs/debug.log.'));
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
    if (/^(electron|deskling)$/i.test(proc) || title === 'Deskling') return; // instalado, el proceso se llama "Deskling"
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
      stats.song(state.media.artist);
      speak('music');
    }
  });

  // Llegó una notificación de Windows (se ve aunque esté "No molestar").
  sensors.on('notification', (n) => {
    if (config.ignoredNotificationApps.includes(n.app)) return;
    stats.notification();
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
  sensors.on('media-control', onMusicResult); // respuesta a musicCommand
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

// Una sola instancia: si ya está abierto, no abrimos otro Clawd.
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  const fromEnvFile = loadEnv();
  guard.setLogFile(guardLogPath());

  const p = config.providers[config.provider];
  // De dónde salió la key (el .env o una variable de Windows) + una "huella" corta
  // para comparar keys sin escribirlas. Sirve cuando la IA dice "la key no funciona".
  const key = process.env[p.envKey] || '';
  const huella = key ? require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 8) : '-';
  errorLog(`arranque: datos=${DATA} empaquetada=${app.isPackaged} config=${configReadError || 'ok'} carpeta=${process.cwd()}`);
  errorLog(`arranque: proveedor=${config.provider} key=${!key ? 'falta' : fromEnvFile.has(p.envKey) ? '.env' : 'variable de Windows'} huella=${huella}`);
  brain = new Brain({
    baseURL: p.baseURL,
    apiKey: process.env[p.envKey],
    model: p.model,
    visionModel: p.visionModel,
    personality: config.personality,
    extra: p.extra,
    visionExtra: p.visionExtra,
    avoidEmojis: config.avoidEmojis,
  });

  createWindow();
  createTray();
  // deja el registro de Windows igual que config.autoStart. Solo el instalado:
  // si no, cada `npm start` haría que Windows abra la copia del proyecto.
  if (app.isPackaged) applyAutoStart();

  // Clic derecho sobre Clawd → el menú propio. Le pasamos el estado actual
  // (pausado, captura) para que muestre los interruptores bien.
  ipcMain.on('menu', () => {
    win.focus(); // así, si hacés clic en otra ventana, el menú se cierra (ver 'blur')
    const m = state.media;
    win.webContents.send('menu-open', {
      paused: state.paused,
      screenCapture: config.screenCapture,
      autoStart: !!config.autoStart,
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

  // Resumen del día: contar el tiempo en cada app y ver si ya toca mostrarlo.
  setInterval(trackDay, 10 * 1000);
  setInterval(() => { stats.save(); checkSummaryTime(); }, 60 * 1000);
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

app.on('before-quit', () => { sensors?.stop(); stats.save(); });
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
    // Solo el hook de Claude Code, no páginas web: un navegador manda "Origin" y no
    // puede mandar JSON a otro sitio sin pedir permiso antes (y acá no se lo damos).
    if (req.headers.origin || !String(req.headers['content-type']).startsWith('application/json')) {
      res.writeHead(403).end();
      return;
    }
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
  if (event === 'Stop') stats.claude();
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
    stats.pomodoro();
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
// ejecuta win-sensors.ps1 sobre la app que esté sonando (Spotify, navegador…).
// =============================================================================
let lastMusicCmd = { cmd: '', wasPlaying: false };

function musicCommand(cmd) {
  lastMusicCmd = { cmd, wasPlaying: !!state.media?.playing };
  debug('[musica]', cmd);
  sensors?.send(cmd);
}

/** Respuesta de win-sensors.ps1 a una orden de música: avisamos con un globito cortito. */
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

// =============================================================================
// Resumen del día — el contador está en stats.js (todo queda en tu PC).
// Aparece solo una vez por día:
//   - cuando tocás "Terminé por hoy" en el menú (ese lo podés pedir siempre),
//   - a la hora de config.summary.hour (ej: 23 h), o
//   - si después de config.summary.afterHour (ej: 18 h) dejás la compu sola
//     un rato (idleMinutes): queda en el globito para cuando vuelvas.
// A la IA solo le pasamos los números y nombres de apps, para que te diga
// una frase de cierre. Si la IA falla, la tarjeta sale igual sin la frase.
// =============================================================================
const stats = new DayStats(LOGS);

/** Cada 10 s: sumá esos 10 s a la app activa (si estás frente a la compu). */
function trackDay() {
  const w = state.window;
  // 5 min sin tocar mouse ni teclado = no estás (menos que eso: leyendo, mirando un video corto…)
  if (!w || powerMonitor.getSystemIdleTime() > 300) return;
  stats.addApp(w.private ? 'privada' : w.process, 10);
  if (state.distractSince) stats.distract(10);
}

/** Cada minuto: ¿ya es hora del resumen automático? */
function checkSummaryTime() {
  const c = config.summary;
  if (!c?.enabled || stats.roll().summaryShown || state.paused) return;
  if (stats.totalSec() < c.minActiveMinutes * 60) return; // día casi sin uso: no hay mucho que contar
  const hour = new Date().getHours();
  const idle = powerMonitor.getSystemIdleTime() / 60;
  if (hour >= c.hour || (hour >= c.afterHour && idle >= c.idleMinutes)) showSummary(false);
}

async function showSummary(manual) {
  const d = stats.roll();
  d.summaryShown = true;
  stats.save();
  const lines = stats.lines();
  // tarjeta larga: se queda hasta que hagas clic (o mucho rato si te fuiste)
  const show = (extra) => say([...lines, extra].filter(Boolean).join('\n'), { card: true, face: 'happy', seconds: manual ? 40 : 600, sound: config.sound });

  if (!brain || state.busy) return show('');
  state.busy = true;
  mood('thinking');
  try {
    const context = 'Es el final del día. Este es el resumen de lo que hizo hoy en la compu:\n'
      + lines.join('\n')
      + '\nDecile UNA frase corta de cierre (máx 15 palabras): felicitalo por algo concreto del resumen '
      + 'o dale un consejo para mañana, y despedite hasta mañana. No repitas los números, '
      + 'no hables de la canción que suena y no copies tus comentarios anteriores.';
    const phrase = await brain.comment(context);
    show(phrase ? `💬 ${phrase}` : '');
  } catch (e) {
    debug('[resumen] sin frase de la IA:', e.message);
    show('🌙 ¡Buen trabajo hoy! Nos vemos mañana.');
  } finally {
    state.busy = false;
  }
}
