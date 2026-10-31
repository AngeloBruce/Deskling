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
 */
window.clawd.onSay((msg) => {
  const span = document.createElement('span'); // ver #bubble .text en style.css
  span.className = 'text';
  span.textContent = msg.text;
  bubble.replaceChildren(span);
  bubble.classList.toggle('alert', !!msg.alert);
  bubble.classList.remove('hidden');
  setMood(msg.alert ? 'excited' : 'talking');
  // Cara: la que pida main (msg.face) o, si no, notificación → > <  ·  comentario → ^ ^
  const face = msg.face || (msg.alert ? 'squint' : 'happy');
  setFace(face, face === 'angry' ? 7000 : 3500);
  if (msg.sound) beep();

  // Después de la animación vuelve al estado base.
  setTimeout(() => setMood(baseMood), 1600);

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => bubble.classList.add('hidden'), (msg.seconds || 12) * 1000);
});

/** El proceso principal nos dice "pensando", "durmiendo", etc. */
window.clawd.onMood((mood) => {
  if (mood === 'idle' || mood === 'sleeping') baseMood = mood;
  setMood(mood);
});

// Clic en el globito → se cierra.
bubble.addEventListener('click', () => bubble.classList.add('hidden'));

// Clic derecho sobre Clawd → menú (pausar, captura, salir…).
clawdEl.addEventListener('contextmenu', (e) => { e.preventDefault(); window.clawd.openMenu(); });

// Doble clic sobre Clawd → que opine ya.
clawdEl.addEventListener('dblclick', () => window.clawd.poke());

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

function maybeDance() {
  if (!spotifyPlaying) return;
  if (clawdEl.className === 'idle') {
    setMood('dancing');
    setFace('happy', 6000);
    setTimeout(() => { if (clawdEl.className === 'dancing') setMood(baseMood); }, 6000);
  }
  danceTimer = setTimeout(maybeDance, 25000 + Math.random() * 35000);
}
