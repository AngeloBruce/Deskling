// =============================================================================
// streaks.js — Las rachas: agua, foco, constancia, sin distracción y las apps que elijas.
//
// Todo LOCAL (logs/streaks.json): por cada día solo guarda fechas y cantidades, y de
// apps solo las que elegiste en Ajustes, nunca títulos. Nada de esto se manda a la IA.
// Están pensadas para acompañar, no para presionar:
//   - hay días libres: un día sin cumplir no corta la racha si queda margen;
//   - el récord queda guardado aunque la racha se corte.
// El día termina a las 4 de la mañana: trasnochar no cuenta como un día nuevo.
// =============================================================================
const { readUserConfig, writeConfig } = require('./settings');
const { today } = require('./stats');

const DAY_CUT_HOURS = 4;
const ACTIVE_SEC = 10 * 60;      // menos que esto no cuenta como un día de uso
const APP_SEC = 10 * 60;         // lo mismo para la racha de una app
const DISTRACT_MARGIN_SEC = 60;  // pasar de largo por una distracción no corta el día
const BROKEN_MIN_DAYS = 3;       // una racha más corta se corta sin aviso
const MAX_APPS = 30;             // apps distintas por día en el archivo (por si se edita a mano)

const EMPTY_DAY = { water: 0, waterDone: false, waterAsked: 0, pomodoros: 0, activeSec: 0, distractSec: 0, apps: {} };

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
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

/** El nombre de una app elegida: una línea corta y que no pise nada de los objetos. */
function validApp(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 60
    && !/[\u0000-\u001f\u007f]/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
}

/** La racha de una app elegida. */
function appKind(name) {
  return {
    id: `app:${name}`,
    emoji: '💻',
    label: name,
    hint: 'Al menos 10 min en el día. Las apps privadas y el tiempo en distracciones no cuentan.',
    done: (d) => count(own(d.apps, name)) >= APP_SEC,
  };
}

/** ¿Es un id de racha que se puede guardar? */
const validKind = (id) => KINDS.some((k) => k.id === id) || (id.startsWith('app:') && validApp(id.slice(4)));

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
    const apps = Object.create(null);
    for (const [name, sec] of Object.entries(isObject(d.apps) ? d.apps : {}).slice(0, MAX_APPS)) {
      if (validApp(name) && count(sec)) apps[name] = count(sec);
    }
    days[date] = {
      water: count(d.water),
      waterDone: d.waterDone === true,
      waterAsked: count(d.waterAsked),
      pomodoros: count(d.pomodoros),
      activeSec: count(d.activeSec),
      distractSec: count(d.distractSec),
      apps,
    };
  }
  const best = Object.create(null);
  for (const [id, n] of Object.entries(isObject(raw.best) ? raw.best : {})) if (validKind(id) && count(n)) best[id] = count(n);
  const brokenSeen = Object.create(null);
  for (const [id, date] of Object.entries(isObject(raw.brokenSeen) ? raw.brokenSeen : {})) if (validKind(id) && isDate(date)) brokenSeen[id] = date;
  const rewardsSeen = Array.isArray(raw.rewardsSeen) ? [...new Set(raw.rewardsSeen.filter((r) => typeof r === 'string' && r.length <= 60))].slice(0, 50) : [];
  return { days, best, brokenSeen, rewardsSeen };
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

/** Las rachas fijas más las de las apps elegidas (sin repetir ni nombres raros). */
function kindsFor(apps) {
  const names = [...new Set((apps || []).filter(validApp))];
  return [...KINDS, ...names.map(appKind)];
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
    return (this.data.days[this.day()] ??= { ...EMPTY_DAY, apps: Object.create(null) });
  }

  /** Lo que ya hay de hoy, sin crear el día. */
  peek() { return this.data.days[this.day()] || EMPTY_DAY; }

  addActive(sec, distracted) {
    const d = this.rec();
    d.activeSec += sec;
    if (distracted) d.distractSec += sec;
  }

  /** Tiempo en una de las apps elegidas. */
  addApp(name, sec) {
    if (!validApp(name)) return;
    const d = this.rec();
    if (!Object.hasOwn(d.apps, name) && Object.keys(d.apps).length >= MAX_APPS) return;
    d.apps[name] = count(own(d.apps, name)) + sec;
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

  /** Anota que se preguntó por el vaso: sirve para saber si salió, aunque no lo hayas visto. */
  asked() { this.rec().waterAsked++; }

  /** ¿Ya cumpliste los vasos de hoy? Sirve también si bajaste la meta durante el día. */
  waterReached(goal) {
    if (this.peek().water < goal) return this.peek().waterDone;
    if (!this.peek().waterDone) this.rec().waterDone = true;
    return true;
  }

  glasses() { return this.peek().water; }

  /** Cómo va cada racha. El récord solo puede subir. */
  status(restPerWeek, apps = []) {
    const todayKey = this.day();
    return kindsFor(apps).map((kind) => {
      const { current, best } = walk(this.data.days, kind, restPerWeek, todayKey);
      if (best > (this.data.best[kind.id] || 0)) {
        this.data.best[kind.id] = best;
        this.dirty = true;
      }
      return {
        id: kind.id,
        emoji: kind.emoji,
        label: kind.label,
        hint: kind.hint,
        current,
        best: this.data.best[kind.id] || 0,
        doneToday: !kind.closedOnly && !!kind.done(this.peek()),
      };
    });
  }

  current(id, restPerWeek) {
    return this.status(restPerWeek).find((s) => s.id === id).current;
  }

  /** El mejor récord de una racha, ya guardado. */
  best(id) { return this.data.best[id] || 0; }

  /** Las rachas que se cortaron y todavía no se avisaron. Se mira una vez por día. */
  takeBroken(restPerWeek, apps = []) {
    const todayKey = this.day();
    if (this.brokenChecked === todayKey) return [];
    this.brokenChecked = todayKey;
    const out = [];
    for (const kind of kindsFor(apps)) {
      const { broken } = walk(this.data.days, kind, restPerWeek, todayKey);
      if (!broken || broken.date <= (this.data.brokenSeen[kind.id] || '')) continue;
      this.data.brokenSeen[kind.id] = broken.date;
      this.dirty = true;
      if (broken.days >= BROKEN_MIN_DAYS) out.push({ id: kind.id, label: kind.label, days: broken.days });
    }
    this.status(restPerWeek, apps); // deja el récord al día antes de mostrarlo
    return out.map((b) => ({ ...b, best: this.best(b.id) }));
  }

  /** Anota un premio como avisado. Devuelve true si era nuevo. */
  markReward(id) {
    if (this.data.rewardsSeen.includes(id)) return false;
    this.data.rewardsSeen.push(id);
    this.dirty = true;
    this.save();
    return true;
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
    this.wait = 0; // cuántos avisos faltan para la próxima pregunta (la primera, al abrir la app)
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
