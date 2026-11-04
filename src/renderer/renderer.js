// =============================================================================
// renderer.js — Lo que pasa dentro de la ventanita: mostrar el globito,
// cambiar la animación de Clawd y hacer el "pip" de aviso.
// Recibe órdenes del proceso principal a través de window.clawd (preload.js).
// =============================================================================

const bubble = document.getElementById('bubble');
const clawdEl = document.getElementById('clawd'); // el div del sprite (window.clawd es el puente del preload)
let hideTimer = null;
let baseMood = 'idle'; // a qué estado vuelve después de hablar (idle o sleeping)

/** Cambia la animación de Clawd (ver estados en style.css). */
function setMood(mood) {
  if (clawdEl.className === 'bye') return; // despidiéndose: que nada lo interrumpa
  clawdEl.className = mood;
}

/**
 * Cambia la CARA: 'normal' (puntitos), 'happy' (^ ^), 'squint' (> <) o 'angry' (enojado).
 * Si se pasa `ms`, vuelve a la cara normal después de ese tiempo.
 */
let faceTimer = null;
function setFace(face, ms) {
  clawdEl.dataset.face = face;
  clearTimeout(faceTimer);
  if (ms) faceTimer = setTimeout(() => { clawdEl.dataset.face = 'normal'; }, ms);
}

/**
 * Caras al azar: cada 20–45 segundos, si está tranquilo, pone ^ ^ o > <
 * un ratito para que se sienta vivo.
 */
function randomFace() {
  if (clawdEl.className === 'idle' && clawdEl.dataset.face === 'normal') {
    setFace(Math.random() < 0.6 ? 'happy' : 'squint', 1800);
  }
  setTimeout(randomFace, 20000 + Math.random() * 25000);
}
setTimeout(randomFace, 8000);

/** Sonidito de aviso generado en el momento (no hace falta un archivo de audio). */
function beep() {
  const ctx = new AudioContext();
  [660, 880].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square'; // sonido "8 bits", combina con el pixel art
    osc.frequency.value = freq;
    gain.gain.value = 0.04; // bajito
    osc.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime + i * 0.12;
    osc.start(t);
    osc.stop(t + 0.09);
  });
  setTimeout(() => ctx.close(), 600);
}

/**
 * Muestra un mensaje en el globito.
 * msg = { text, alert?, sound?, seconds?, face? }
 *   alert   → borde naranja y Clawd salta (notificaciones)
 *   sound   → hace "pip"
 *   seconds → cuánto queda visible
 *   face    → forzar una cara: 'happy', 'squint' o 'angry'
 *   card    → tarjeta de varias líneas (el resumen del día), sin cortar el texto
 *   buttons → botones [{ id, label }]: al tocar uno, main decide qué sigue
 */
window.clawd.onSay((msg) => {
  if (msg.buttons?.length) question = { msg, until: Date.now() + msg.seconds * 1000 };
  showBubble(msg);
});

// Una pregunta con botones no se pierde si otro mensaje la tapa: vuelve cuando ese termina.
let question = null; // { msg, until }

function afterBubble() {
  const left = question ? question.until - Date.now() : 0;
  if (left > 0) showBubble({ ...question.msg, sound: false, seconds: left / 1000 });
  else {
    question = null;
    bubble.classList.add('hidden');
  }
}

function showBubble(msg) {
  const span = document.createElement('span'); // ver #bubble .text en style.css
  span.className = 'text';
  span.textContent = msg.text;
  bubble.replaceChildren(span);
  if (msg.buttons?.length) bubble.append(bubbleButtons(msg.buttons));
  bubble.classList.toggle('alert', !!msg.alert);
  bubble.classList.toggle('card', !!msg.card);
  bubble.classList.remove('hidden');
  setMood(msg.alert ? 'excited' : 'talking');
  // Cara: la que pida main (msg.face) o, si no, notificación → > <  ·  comentario → ^ ^
  const face = msg.face || (msg.alert ? 'squint' : 'happy');
  setFace(face, face === 'angry' ? 7000 : 3500);
  if (msg.sound) beep();

  // Después de la animación vuelve al estado base.
  setTimeout(() => setMood(baseMood), 1600);

  clearTimeout(hideTimer);
  hideTimer = setTimeout(afterBubble, (msg.seconds || 12) * 1000);
}

/** La fila de botones del globito. Desaparece al tocar uno, así no se contesta dos veces. */
function bubbleButtons(buttons) {
  const row = document.createElement('div');
  row.className = 'actions';
  for (const { id, label } of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // si no, el clic también cerraría el globito
      question = null;
      row.remove();
      window.clawd.bubbleAction(id);
    });
    row.append(b);
  }
  return row;
}

/** El proceso principal nos dice "pensando", "durmiendo", etc. */
window.clawd.onMood((mood) => {
  if (mood === 'sleeping') question = null; // dormido no pregunta
  if (mood === 'idle' || mood === 'sleeping') baseMood = mood;
  setMood(mood);
});

// Clic en el globito → se cierra. Si era la pregunta, la descartás; si era otro mensaje, ella vuelve.
bubble.addEventListener('click', () => {
  if (bubble.querySelector('.actions')) question = null;
  clearTimeout(hideTimer);
  afterBubble();
});

// Clic derecho sobre Clawd → menú propio (si ya está abierto, lo cierra).
clawdEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (menu.classList.contains('hidden')) window.clawd.openMenu(); // main responde con 'menu-open'
  else closeMenu();
});

// -----------------------------------------------------------------------------
// Menú propio
// -----------------------------------------------------------------------------
const menu = document.getElementById('menu');

/**
 * Iconitos pixel de 7x7: cada "#" es un píxel pintado.
 * Para cambiar un ícono, dibujalo acá con # y puntos.
 */
const ICONS = {
  moon:   ['..###..', '.##....', '##.....', '##.....', '##.....', '.##....', '..###..'],
  sun:    ['#..#..#', '.#...#.', '..###..', '#.###.#', '..###..', '.#...#.', '#..#..#'],
  eye:    ['.......', '..###..', '.#...#.', '#..#..#', '.#...#.', '..###..', '.......'],
  chat:   ['#######', '#.....#', '#.#.#.#', '#.....#', '#######', '##.....', '#......'],
  shield: ['.#####.', '#######', '###.###', '##...##', '.#####.', '..###..', '...#...'],
  gear:   ['..#.#..', '.#####.', '##...##', '.#...#.', '##...##', '.#####.', '..#.#..'],
  bye:    ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
  power:  ['...#...', '.#.#.#.', '#..#..#', '#..#..#', '#.....#', '.#...#.', '..###..'], // arrancar con Windows
  chart:  ['......#', '......#', '...#..#', '...#..#', '#..#..#', '#..#..#', '#######'], // resumen del día
  // modo foco: tomatito (pomodoro) y tacita (descanso)
  tomato: ['..#.#..', '...#...', '.#####.', '#######', '#######', '#######', '.#####.'],
  stop:   ['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......'],
  cup:    ['.#.#...', '#.#....', '.......', '#####..', '#####.#', '######.', '.###...'],
  // controles de música
  play:   ['.#.....', '.##....', '.###...', '.####..', '.###...', '.##....', '.#.....'],
  pause:  ['.......', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.......'],
  next:   ['#.....#', '##....#', '###...#', '####..#', '###...#', '##....#', '#.....#'],
  prev:   ['#.....#', '#....##', '#...###', '#..####', '#...###', '#....##', '#.....#'],
  // notitas para cuando baila
  note:   ['...###.', '...#.#.', '...#...', '...#...', '.###...', '.###...', '.......'],
  notes:  ['..#####', '..#...#', '..#...#', '..#...#', '###.###', '###.###', '.......'],
};

/** Convierte un dibujo de ICONS en un <svg> de rectángulos. */
function pixelIcon(name) {
  const rects = ICONS[name].flatMap((row, y) =>
    [...row].map((c, x) => (c === '#' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ''))).join('');
  return `<svg viewBox="0 0 7 7" shape-rendering="crispEdges">${rects}</svg>`;
}

function setIcon(btn, name) {
  btn.querySelector('i').innerHTML = pixelIcon(name);
}

menu.querySelectorAll('button').forEach((btn, i) => {
  setIcon(btn, btn.dataset.icon);
  btn.style.animationDelay = `${60 + i * 25}ms`; // aparecen en cascada
  btn.addEventListener('click', () => {
    window.clawd.menuAction(btn.dataset.action);
    // los de música (data-keep) dejan el menú abierto, para poder pasar varias canciones
    if (btn.hasAttribute('data-keep')) {
      if (btn.dataset.action === 'music-toggle') setPlaying(btn.dataset.icon !== 'pause');
    } else {
      closeMenu();
    }
  });
});

/** Cambia el botón del medio entre ⏸ (está sonando) y ▶ (está pausada). */
function setPlaying(playing) {
  const btn = menu.querySelector('[data-action="music-toggle"]');
  btn.dataset.icon = playing ? 'pause' : 'play';
  setIcon(btn, btn.dataset.icon);
}

/** Main nos pide abrir el menú y nos dice el estado actual. */
window.clawd.onMenuOpen(({ paused, screenCapture, autoStart, focusing, music }) => {
  menu.querySelector('[data-action="quit"] span').textContent = `Chau, ${petName}`;
  const row = menu.querySelector('.music-row');
  row.classList.toggle('hidden', !music);
  if (music) {
    row.querySelector('.song').textContent = music.artist ? `${music.title} · ${music.artist}` : music.title;
    setPlaying(music.playing);
  }
  const pause = menu.querySelector('[data-action="pause"]');
  pause.querySelector('span').textContent = paused ? `Despertar a ${petName}` : 'Dormir un rato';
  setIcon(pause, paused ? 'sun' : 'moon');
  const focus = menu.querySelector('[data-action="focus"]');
  focus.querySelector('span').textContent = focusing ? 'Terminar foco' : 'Modo foco';
  setIcon(focus, focusing ? 'stop' : 'tomato');
  menu.querySelector('[data-action="capture"]').setAttribute('aria-checked', String(screenCapture));
  menu.querySelector('[data-action="autostart"]').setAttribute('aria-checked', String(!!autoStart));

  // reiniciamos las animaciones de apertura sacando y poniendo el menú
  menu.classList.add('hidden');
  void menu.offsetWidth;
  menu.classList.remove('hidden');
  document.body.classList.add('menu-open');
  setFace('happy', 1200);
});

function closeMenu() {
  menu.classList.add('hidden');
  document.body.classList.remove('menu-open');
}
window.clawd.onMenuClose(closeMenu); // la ventana perdió el foco (clic en otra app)

// Clic en cualquier lado fuera del menú → se cierra.
window.addEventListener('mousedown', (e) => {
  if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.button === 0) closeMenu();
});

// -----------------------------------------------------------------------------
// Contador del modo foco: main nos dice la fase y a qué hora termina; acá
// mostramos los minutos que quedan y la barrita, actualizando cada segundo.
// -----------------------------------------------------------------------------
const badge = document.getElementById('focus-badge');
let focusInfo = { phase: 'off', endsAt: 0, total: 1 };
let badgeTimer = null;

window.clawd.onFocus(({ phase, endsAt }) => {
  if (phase === 'work') question = null; // en foco no vuelve: pregunta otra vez en el descanso
  focusInfo = { phase, endsAt, total: Math.max(1, endsAt - Date.now()) };
  clearInterval(badgeTimer);
  if (phase === 'off') { badge.classList.add('hidden'); return; }
  const rest = phase !== 'work';
  badge.classList.toggle('rest', rest);
  badge.querySelector('i').innerHTML = pixelIcon(rest ? 'cup' : 'tomato');
  badge.classList.remove('hidden');
  drawBadge();
  badgeTimer = setInterval(drawBadge, 1000);
});

function drawBadge() {
  const left = Math.max(0, focusInfo.endsAt - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  badge.querySelector('span').textContent = `${m}:${String(s).padStart(2, '0')}`;
  // la barrita se va llenando a medida que pasa el tiempo
  badge.querySelector('.bar').style.width = `${100 - (left / focusInfo.total) * 100}%`;
  badge.classList.toggle('ending', left < 60000);
}

// Despedida: saluda con el bracito, dice chau, salta y se encoge hasta desaparecer.
// main.js cierra la app cuando termina (1.7 s).
window.clawd.onGoodbye(() => {
  question = null;
  clearTimeout(hideTimer);
  closeMenu();
  clearTimeout(danceTimer);
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = '👋 ¡Chau! Nos vemos';
  bubble.replaceChildren(span);
  bubble.classList.remove('alert', 'hidden');
  bubble.classList.add('bye');
  setFace('happy');
  setMood('bye');
});

// Teclado: Escape cierra, flechas recorren las opciones.
window.addEventListener('keydown', (e) => {
  if (menu.classList.contains('hidden')) return;
  const items = [...menu.querySelectorAll('button')];
  const at = items.indexOf(document.activeElement);
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
});

// Doble clic sobre Clawd → que opine ya.
clawdEl.addEventListener('dblclick', () => window.clawd.poke());

// Rueda del mouse sobre Clawd → pasar de canción (arriba = siguiente, abajo = anterior).
// Una por "ruedazo": ignoramos el resto del giro por 800 ms.
let lastWheel = 0;
clawdEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (Date.now() - lastWheel < 800) return;
  lastWheel = Date.now();
  window.clawd.musicWheel(e.deltaY < 0 ? 1 : -1);
  setFace('happy', 800);
}, { passive: false });

// -----------------------------------------------------------------------------
// Arrastrar vs. acariciar
// Con el botón izquierdo: si movés el mouse más de 4 px es ARRASTRAR (se mueve
// la ventana); si soltás sin moverlo es una CARICIA (blop).
// -----------------------------------------------------------------------------
let press = null; // { x, y, moved } mientras el botón está apretado

clawdEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, moved: false };
  window.clawd.dragStart();
});

window.addEventListener('mousemove', (e) => {
  if (!press) return;
  const dx = e.screenX - press.x;
  const dy = e.screenY - press.y;
  if (!press.moved && Math.hypot(dx, dy) > 4) {
    press.moved = true;
    clawdEl.classList.add('dragging');
  }
  if (press.moved) window.clawd.dragMove(dx, dy);
});

window.addEventListener('mouseup', () => {
  if (!press) return;
  if (press.moved) window.clawd.dragEnd(); // soltó después de arrastrar → main acomoda el lado
  else boop();
  clawdEl.classList.remove('dragging');
  press = null;
});

// -----------------------------------------------------------------------------
// Clics que atraviesan la parte transparente
// La ventana deja pasar el mouse a la app de abajo, salvo cuando está encima
// de algo nuestro. Acá decidimos qué es "nuestro" y se lo decimos a main.
// -----------------------------------------------------------------------------
let capturing = false;

function isOverUs(target) {
  if (press) return true; // arrastrando: no soltamos el mouse a mitad de camino
  if (clawdEl.contains(target)) return true;
  if (!bubble.classList.contains('hidden') && bubble.contains(target)) return true;
  if (!menu.classList.contains('hidden') && menu.contains(target)) return true;
  return false;
}

function updateCapture(on) {
  if (on === capturing) return; // solo avisamos cuando cambia
  capturing = on;
  window.clawd.setMouseCapture(on);
}

window.addEventListener('mousemove', (e) => updateCapture(isOverUs(e.target)));
// el mouse se fue de la ventana → que todo vuelva a atravesar
document.addEventListener('mouseleave', () => { if (!press) updateCapture(false); });

/** Caricia: Clawd se aplasta y rebota como gelatina, cierra los ojitos y hace "blop". */
function boop() {
  clawdEl.classList.remove('boop');
  void clawdEl.offsetWidth; // truco para reiniciar la animación si clickeás seguido
  clawdEl.classList.add('boop');
  setFace('squint', 900);
  blop();
}
clawdEl.addEventListener('animationend', (e) => {
  if (e.animationName === 'boop') clawdEl.classList.remove('boop');
});

/** Sonido "blop": un tono suave que cae rápido de agudo a grave, bajito. */
function blop() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(520, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.12);
  gain.gain.setValueAtTime(0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.16);
  setTimeout(() => ctx.close(), 400);
}

// Main nos dice de qué lado está Clawd ('left' o 'right'); style.css acomoda
// a Clawd y al globito según body[data-side].
window.clawd.onSide((side) => { document.body.dataset.side = side; });

// Skin, accesorio, tamaño y nombre. Los colores y medidas son variables de style.css.
// El accesorio va en un atributo porque setMood reemplaza todas las clases de #clawd.
let petName = 'Clawd';
window.clawd.onAppearance(({ colors, accessory, width, height, petName: name }) => {
  const vars = {
    '--clawd': colors.main,
    '--clawd-dark': colors.dark,
    '--clawd-shade': colors.shade,
    '--clawd-arm': colors.arm,
    '--clawd-bright': colors.bright,
    '--cw': `${width}px`,
    '--ch': `${height}px`,
  };
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  clawdEl.dataset.accessory = accessory;
  petName = name;
});

// -----------------------------------------------------------------------------
// Baile: mientras suena Spotify, de vez en cuando (cada 25–60 s) se balancea
// unos segundos con cara feliz. Si está hablando o pensando, no baila.
// -----------------------------------------------------------------------------
let spotifyPlaying = false;
let danceTimer = null;

window.clawd.onMusic(({ spotifyPlaying: playing }) => {
  spotifyPlaying = playing;
  clearTimeout(danceTimer);
  if (playing) danceTimer = setTimeout(maybeDance, 4000); // primer bailecito al rato de arrancar
  else if (clawdEl.className === 'dancing') setMood(baseMood);
});

const DANCE_MS = 7000; // cuánto dura cada bailecito

function maybeDance() {
  if (!spotifyPlaying) return;
  if (clawdEl.className === 'idle') {
    setMood('dancing');
    setFace('happy', DANCE_MS);
    // una notita por "tiempo" (cada medio segundo, igual que el bop de la cabeza)
    const notes = setInterval(() => {
      if (clawdEl.className !== 'dancing') return clearInterval(notes);
      spawnNote();
    }, 500);
    setTimeout(() => {
      clearInterval(notes);
      if (clawdEl.className === 'dancing') setMood(baseMood);
    }, DANCE_MS);
  }
  danceTimer = setTimeout(maybeDance, 25000 + Math.random() * 35000);
}

// -----------------------------------------------------------------------------
// Laptop: de vez en cuando (cada 1–3 min), si está tranquilo, saca la laptop y
// teclea un rato. Con el menú abierto o el contador del foco no, porque ocupan ese lugar.
// -----------------------------------------------------------------------------
const LAPTOP_MS = 9000; // igual que las animaciones de .working en style.css

function maybeLaptop() {
  const free = document.getElementById('menu').classList.contains('hidden')
    && document.getElementById('focus-badge').classList.contains('hidden');
  if (clawdEl.className === 'idle' && free) {
    setMood('working');
    setTimeout(() => {
      if (clawdEl.classList.contains('working')) setMood(baseMood);
    }, LAPTOP_MS);
  }
  setTimeout(maybeLaptop, 60000 + Math.random() * 120000);
}
setTimeout(maybeLaptop, 30000);

/** Una notita musical que sale de la cabeza de Clawd y sube flotando. */
let noteSide = 1;
function spawnNote() {
  const el = document.createElement('i');
  el.className = 'note' + (Math.random() < 0.35 ? ' light' : ''); // algunas blanquitas
  el.innerHTML = pixelIcon(Math.random() < 0.5 ? 'note' : 'notes');
  noteSide = -noteSide; // una a la izquierda, otra a la derecha
  el.style.left = `${noteSide > 0 ? 63 + Math.random() * 17 : 10 + Math.random() * 17}%`; // en %: sirve para cualquier tamaño
  el.style.setProperty('--dx', `${noteSide * (4 + Math.random() * 6)}px`);
  el.addEventListener('animationend', () => el.remove());
  clawdEl.appendChild(el);
}
