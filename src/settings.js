// =============================================================================
// settings.js — Leer, validar y guardar la configuración sin perder nada.
//
// No depende de Electron, así se puede probar con `npm test`.
//   - Un config.json con errores NO se pisa: se guarda una copia y se avisa.
//   - Se escribe a un archivo temporal y se renombra: un cierre a mitad de
//     camino no deja el JSON roto.
//   - La ventana de ajustes solo puede cambiar lo que está en SCHEMA. La key, las
//     URLs de los proveedores y el puerto quedan afuera a propósito.
// =============================================================================
const fs = require('fs');
const path = require('path');
const { PERSONALITIES, SKINS, ACCESSORIES, SIZES, LEGACY_PERSONALITY } = require('./presets');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fusión profunda: los objetos se combinan; las listas y los valores se reemplazan enteros. */
function mergeConfig(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (k === '__proto__') continue;
    out[k] = isObject(v) && isObject(out[k]) ? mergeConfig(out[k], v) : v;
  }
  return out;
}

/** Lo que cambia respecto de los valores por defecto (para no congelarlos al guardar). */
function diffConfig(base, current) {
  const out = {};
  for (const [k, v] of Object.entries(current)) {
    if (isObject(v) && isObject(base[k])) {
      const inner = diffConfig(base[k], v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (JSON.stringify(v) !== JSON.stringify(base[k])) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Lee la config del usuario.
 * @returns {{config: object, status: 'ok'|'missing'|'corrupt'|'unreadable', backup?: string, code?: string}}
 *   Si está rota, deja una copia al lado (`backup`) y devuelve una config vacía.
 *   'unreadable' = existe pero no se pudo leer o copiar (permisos, archivo bloqueado):
 *   no hay copia, así que ese archivo no se debe pisar.
 */
function readUserConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { config: {}, status: 'missing' };
    return { config: {}, status: 'unreadable', code: e.code };
  }
  try {
    const config = JSON.parse(raw.replace(/^﻿/, '')); // el Bloc de notas puede agregar un BOM
    if (!isObject(config)) throw new Error('no es un objeto');
    return { config, status: 'ok' };
  } catch {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const backup = `${file}.bak-${stamp}`;
    try {
      fs.writeFileSync(backup, raw);
    } catch (e) {
      return { config: {}, status: 'unreadable', code: e.code };
    }
    return { config: {}, status: 'corrupt', backup };
  }
}

/** ¿Son la misma carpeta? Compara rutas resueltas: da igual una barra final o, en Windows, las mayúsculas. */
function samePath(a, b) {
  return path.relative(a, b) === '';
}

/** Escribe el JSON de forma segura: a un temporal y después renombra. */
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Las configs anteriores a las personalidades solo tienen el texto: elegimos el preset sin perderlo. */
function migrate(mine) {
  if (mine.personalityPreset !== undefined || typeof mine.personality !== 'string') return mine;
  return mine.personality.trim() === LEGACY_PERSONALITY
    ? { ...mine, personalityPreset: 'clasico', personality: '' }
    : { ...mine, personalityPreset: 'custom' };
}

/**
 * El proveedor de IA lo elige la ventana de ajustes, pero config.json se puede editar a mano:
 * un nombre que no existe (o una lista de proveedores rota) dejaba la app sin arrancar.
 * Corrige `config` en memoria para que siempre quede uno que sirva.
 * @returns {string} qué se corrigió, para el log ('' = nada)
 */
function fixProvider(config, defaults) {
  const valid = (p) => isObject(p) && ['baseURL', 'model', 'envKey'].every((k) => typeof p[k] === 'string' && p[k]);
  const all = isObject(config.providers) ? Object.entries(config.providers) : [];
  const usable = Object.fromEntries(all.filter(([, p]) => valid(p)));
  let fixed = '';
  if (!Object.keys(usable).length) {
    config.providers = mergeConfig({}, defaults.providers);
    fixed = 'la lista de proveedores no servía: uso la de fábrica';
  } else {
    if (Object.keys(usable).length !== all.length) fixed = 'se ignoraron proveedores incompletos';
    config.providers = usable;
  }
  if (typeof config.provider !== 'string' || !Object.hasOwn(config.providers, config.provider)) {
    const was = typeof config.provider === 'string' ? config.provider.slice(0, 40) : typeof config.provider;
    config.provider = Object.hasOwn(config.providers, defaults.provider) ? defaults.provider : Object.keys(config.providers)[0];
    fixed = `el proveedor "${was}" no existe: uso "${config.provider}"`;
  }
  return fixed;
}

const int = (min, max) => ({ type: 'int', min, max });
const list = (extra = {}) => ({ type: 'list', ...extra });
const oneOf = (catalog) => ({ type: 'enum', values: Object.keys(catalog) });

// Todo lo que se puede cambiar desde la ventana de ajustes.
const SCHEMA = {
  userName: { type: 'line', max: 40 },
  petName: { type: 'line', max: 20, required: true },
  personalityPreset: oneOf(PERSONALITIES),
  personality: { type: 'text', max: 4000 },
  'appearance.skin': oneOf(SKINS),
  'appearance.accessory': oneOf(ACCESSORIES),
  'appearance.size': oneOf(SIZES),
  'appearance.christmas': { type: 'bool' },
  provider: { type: 'provider' },
  cooldownSeconds: int(5, 3600),
  musicCooldownSeconds: int(5, 3600),
  workCommentDelaySeconds: int(1, 600),
  checkinMinutes: int(1, 240),
  bubbleSeconds: int(3, 120),
  sound: { type: 'bool' },
  screenCapture: { type: 'bool' },
  autoStart: { type: 'bool' },
  'focus.workMinutes': int(1, 180),
  'focus.breakMinutes': int(1, 60),
  'focus.longBreakMinutes': int(1, 120),
  'focus.cyclesBeforeLongBreak': int(1, 12),
  'focus.priorityApps': list(),
  'distractions.keywords': list({ lower: true }), // main.js las compara con el título en minúscula
  'distractions.focusSeconds': int(5, 600),
  'distractions.minutes': int(1, 240),
  'wellness.everyMinutes': int(1, 240),
  'wellness.tips': list(),
  'streaks.enabled': { type: 'bool' },
  'streaks.waterGoal': int(1, 12),
  'streaks.waterAfterReminders': int(1, 8),
  'streaks.restDaysPerWeek': int(0, 3),
  'streaks.apps': list({ max: 10 }),
  'summary.enabled': { type: 'bool' },
  'summary.hour': int(0, 23),
  'summary.afterHour': int(0, 23),
  'summary.idleMinutes': int(1, 240),
  'summary.minActiveMinutes': int(0, 600),
  'claudeCode.enabled': { type: 'bool' },
  'claudeCode.nagMinutes': int(1, 120),
  privateApps: list(),
  ignoredNotificationApps: list(),
  avoidEmojis: list(),
};

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let at = obj;
  for (const k of keys) at = at[k] ??= {};
  at[last] = value;
}

/** Limpia un valor según su regla. Devuelve undefined si no sirve (y entonces no se cambia). */
function cleanValue(rule, v, providers) {
  switch (rule.type) {
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'int': {
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      return Number.isFinite(n) ? Math.min(rule.max, Math.max(rule.min, Math.round(n))) : undefined;
    }
    case 'enum':
      return rule.values.includes(v) ? v : undefined;
    case 'provider':
      return providers.includes(v) ? v : undefined;
    case 'line': {
      if (typeof v !== 'string') return undefined;
      // una sola línea: estos nombres van dentro del prompt
      const line = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, rule.max);
      return rule.required && !line ? undefined : line;
    }
    case 'text':
      if (typeof v !== 'string') return undefined;
      return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, rule.max);
    case 'list': {
      if (!Array.isArray(v)) return undefined;
      // sin vacíos: una palabra vacía coincidiría con todas las ventanas
      const items = v.filter((s) => typeof s === 'string')
        .map((s) => (rule.lower ? s.toLowerCase() : s).trim().slice(0, 200))
        .filter(Boolean);
      return [...new Set(items)].slice(0, rule.max || 200);
    }
    default:
      return undefined;
  }
}

/**
 * Valida lo que manda la ventana de ajustes. Devuelve un objeto con SOLO lo válido:
 * claves desconocidas o valores que no sirven se ignoran; los números se ajustan al rango.
 */
function sanitize(patch, providers = []) {
  const out = {};
  for (const [key, rule] of Object.entries(SCHEMA)) {
    const raw = getPath(patch, key);
    if (raw === undefined) continue;
    const value = cleanValue(rule, raw, providers);
    if (value !== undefined) setPath(out, key, value);
  }
  return out;
}

/** Lo que ve la ventana de ajustes: solo las claves de SCHEMA. */
function editableView(config) {
  const out = {};
  for (const key of Object.keys(SCHEMA)) {
    const value = getPath(config, key);
    if (value !== undefined) setPath(out, key, value);
  }
  return out;
}

/** Mínimos y máximos de los campos numéricos, para no repetirlos en el HTML. */
function limits() {
  const out = {};
  for (const [key, rule] of Object.entries(SCHEMA)) {
    if (rule.type === 'int') out[key] = { min: rule.min, max: rule.max };
  }
  return out;
}

module.exports = { mergeConfig, diffConfig, readUserConfig, samePath, writeConfig, migrate, fixProvider, sanitize, editableView, limits, getPath };
