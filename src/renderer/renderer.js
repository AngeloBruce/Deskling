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
 * msg = { text, alert?, sound?, seconds? }
 *   alert   → borde naranja y Clawd salta (notificaciones)
 *   sound   → hace "pip"
 *   seconds → cuánto queda visible
 */
window.clawd.onSay((msg) => {
  bubble.textContent = msg.text;
  bubble.classList.toggle('alert', !!msg.alert);
  bubble.classList.remove('hidden');
  setMood(msg.alert ? 'excited' : 'talking');
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
