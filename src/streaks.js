// =============================================================================
// streaks.js — Las rachas: agua, foco, constancia y sin distracción.
//
// Todo LOCAL (logs/streaks.json): por cada día solo guarda fechas y cantidades,
// nunca nombres de apps ni títulos, y nada de esto se manda a la IA.
// Están pensadas para acompañar, no para presionar:
//   - hay días libres: un día sin cumplir no corta la racha si queda margen;
//   - el récord queda guardado aunque la racha se corte.
// El día termina a las 4 de la mañana: trasnochar no cuenta como un día nuevo.
// =============================================================================
const { readUserConfig, writeConfig } = require('./settings');
const { today } = require('./stats');

const DAY_CUT_HOURS = 4;
const ACTIVE_SEC = 10 * 60;      // menos que esto no cuenta como un día de uso
const DISTRACT_MARGIN_SEC = 60;  // pasar de largo por una distracción no corta el día
const BROKEN_MIN_DAYS = 3;       // una racha más corta se corta sin aviso

const EMPTY_DAY = { water: 0, waterDone: false, pomodoros: 0, activeSec: 0, distractSec: 0 };

// closedOnly = recién se sabe cuando termina el día
const KINDS = [
  { id: 'water', emoji: '💧', label: 'Agua', hint: 'Cumplir tus vasos del día.', done: (d) => d.waterDone },
  { id: 'focus', emoji: '🍅', label: 'Foco', hint: 'Terminar al menos un pomodoro.', done: (d) => d.pomodoros >= 1 },
  { id: 'active', emoji: '🦀', label: 'Constancia', hint: 'Usar la compu con la mascota abierta.', done: (d) => d.activeSec >= ACTIVE_SEC },
  { id: 'calm', emoji: '🚫', label: 'Sin distracción', hint: 'Un día sin tus apps de distracción. Se cuenta al terminar el día.', closedOnly: true,
    done: (d) => d.activeSec >= ACTIVE_SEC && d.distractSec <= DISTRACT_MARGIN_SEC },
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** ¿Es una fecha real "AAAA-MM-DD"? */
function isDate(s) {
  if (!/^20\d\d-\d\d-\d\d$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** El día siguiente. En UTC: el cambio de horario no puede saltear ni repetir un día. */
function nextDay(date) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
}

/** El archivo pudo editarse a mano: solo se queda lo que tiene sentido. */
function cleanData(raw) {
  const days = {};
  for (const [date, d] of Object.entries(isObject(raw.days) ? raw.days : {})) {
    if (!isDate(date) || !isObject(d)) continue;
    days[date] = {
      water: count(d.water),
      waterDone: d.waterDone === true,
      pomodoros: count(d.pomodoros),
      activeSec: count(d.activeSec),
      distractSec: count(d.distractSec),
    };
  }
  const best = {};
  const brokenSeen = {};
  for (const { id } of KINDS) {
    best[id] = count(raw.best?.[id]);
    brokenSeen[id] = isDate(raw.brokenSeen?.[id]) ? raw.brokenSeen[id] : '';
  }
  return { days, best, brokenSeen };
}

/**
 * Recorre el historial de una racha, día por día.
 * Un día sin cumplir usa un día libre si en los últimos 7 quedó margen; si no, corta la racha.
 * Hoy solo suma: como todavía no terminó, no puede cortar nada.
 * @returns {{current: number, best: number, broken: {days: number, date: string}|null}}
 */
function walk(days, kind, restPerWeek, todayKey) {
  const dates = Object.keys(days).filter((d) => d <= todayKey).sort();
  let current = 0;
  let best = 0;
  let broken = null;
  let rests = [];
  if (!dates.length) return { current, best, broken };
  let i = 0;
  for (let date = dates[0]; date <= todayKey; date = nextDay(date), i++) {
    const isToday = date === todayKey;
    if (isToday && kind.closedOnly) break;
    if (kind.done(days[date] || EMPTY_DAY)) {
      current++;
      best = Math.max(best, current);
    } else if (!isToday && current > 0) {
      rests = rests.filter((r) => i - r < 7);
      if (rests.length < restPerWeek) {
        rests.push(i);
      } else {
        broken = { days: current, date };
        current = 0;
        rests = [];
      }
    }
  }
  return { current, best, broken };
}

class Streaks {
  /**
   * @param {string|null} file dónde guardar (null = no guardar, para las pruebas)
   * @param {{now?: () => number, onError?: (msg: string) => void}} [opts]
   */
  constructor(file, { now = Date.now, onError = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.onError = onError;
    this.dirty = false;
    this.brokenChecked = ''; // el último día en que se miró si se cortó alguna racha
    const read = file ? readUserConfig(file) : { config: {}, status: 'missing' };
    this.data = cleanData(read.config);
    // Sin poder leerlo no hay copia: guardar pisaría tus rachas, así que en esta sesión no se escribe.
    this.writable = read.status !== 'unreadable';
    if (read.status === 'corrupt') onError(`rachas con errores: copia en ${read.backup}`);
    if (!this.writable) onError(`no se pudieron leer las rachas: ${read.code}`);
  }

  save() {
    if (!this.dirty || !this.file || !this.writable) return;
    try {
      writeConfig(this.file, this.data);
      this.dirty = false;
    } catch (e) {
      this.onError(`no se pudieron guardar las rachas: ${e.code || e.message}`);
    }
  }

  day() { return today(new Date(this.now() - DAY_CUT_HOURS * 3600000)); }

  /** Los datos de hoy, para sumarles algo. */
  rec() {
    this.dirty = true;
    return (this.data.days[this.day()] ??= { ...EMPTY_DAY });
  }

  /** Lo que ya hay de hoy, sin crear el día. */
  peek() { return this.data.days[this.day()] || EMPTY_DAY; }

  addActive(sec, distracted) {
    const d = this.rec();
    d.activeSec += sec;
    if (distracted) d.distractSec += sec;
  }

  pomodoro() {
    const d = this.rec();
    d.pomodoros++;
    this.save();
    return d.pomodoros;
  }

  /** Terminaste un vaso. La meta cumplida queda anotada: cambiarla después no reescribe el pasado. */
  drink(goal) {
    const d = this.rec();
    d.water++;
    if (d.water >= goal) d.waterDone = true;
    this.save();
    return d.water;
  }

  /** ¿Ya cumpliste los vasos de hoy? Sirve también si bajaste la meta durante el día. */
  waterReached(goal) {
    if (this.peek().water < goal) return this.peek().waterDone;
    if (!this.peek().waterDone) this.rec().waterDone = true;
    return true;
  }

  glasses() { return this.peek().water; }

  /** Cómo va cada racha. El récord solo puede subir. */
  status(restPerWeek) {
    const todayKey = this.day();
    return KINDS.map((kind) => {
      const { current, best } = walk(this.data.days, kind, restPerWeek, todayKey);
      if (best > this.data.best[kind.id]) {
        this.data.best[kind.id] = best;
        this.dirty = true;
      }
      return {
        id: kind.id,
        emoji: kind.emoji,
        label: kind.label,
        hint: kind.hint,
        current,
        best: this.data.best[kind.id],
        doneToday: !kind.closedOnly && !!kind.done(this.peek()),
      };
    });
  }

  current(id, restPerWeek) {
    return this.status(restPerWeek).find((s) => s.id === id).current;
  }

  /** Las rachas que se cortaron y todavía no se avisaron. Se mira una vez por día. */
  takeBroken(restPerWeek) {
    const todayKey = this.day();
    if (this.brokenChecked === todayKey) return [];
    this.brokenChecked = todayKey;
    const out = [];
    for (const kind of KINDS) {
      const { broken } = walk(this.data.days, kind, restPerWeek, todayKey);
      if (!broken || broken.date <= this.data.brokenSeen[kind.id]) continue;
      this.data.brokenSeen[kind.id] = broken.date;
      this.dirty = true;
      if (broken.days >= BROKEN_MIN_DAYS) out.push({ id: kind.id, label: kind.label, days: broken.days });
    }
    this.status(restPerWeek); // deja el récord al día antes de mostrarlo
    return out.map((b) => ({ ...b, best: this.data.best[b.id] }));
  }
}

/**
 * El vaso de agua, medido en avisos (cada aviso = wellness.everyMinutes):
 *   idle → te ofrece un vaso → drinking → te pregunta si lo terminaste → idle
 * Si no contestás no pasa nada: vuelve a preguntar más tarde y no se pierde nada.
 * Vive en memoria: si cerrás la app, simplemente te ofrece otro vaso.
 */
class WaterFlow {
  constructor() {
    this.phase = 'idle';
    this.wait = 1; // cuántos avisos faltan para la próxima pregunta
  }

  /** Pasó un aviso. Si no se puede preguntar justo ahora, la pregunta queda pendiente. */
  tick() { this.wait = Math.max(0, this.wait - 1); }

  /** Qué toca preguntar ahora: 'offer', 'ask' o null. */
  due(goalReached) {
    if (this.wait > 0) return null;
    if (this.phase === 'drinking') return 'ask';
    return goalReached ? null : 'offer';
  }

  /** Se mostró la pregunta. Si no contestás, se repite después del mismo tiempo. */
  shown(after) { this.wait = after; }

  /** Los botones pueden llegar tarde o repetidos: cada uno solo vale en su fase, así un doble clic no suma dos vasos. */
  start(after) {
    if (this.phase !== 'idle') return false;
    this.phase = 'drinking';
    this.wait = after;
    return true;
  }

  finish(after) {
    if (this.phase !== 'drinking') return false;
    this.phase = 'idle';
    this.wait = after;
    return true;
  }

  later() {
    if (this.phase !== 'drinking') return false;
    this.wait = 1;
    return true;
  }
}

module.exports = { Streaks, WaterFlow, KINDS };
