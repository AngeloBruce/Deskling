// =============================================================================
// guard.js — Punto de seguridad.
//
// TODO texto que podría salir de la PC (títulos de ventana, música,
// notificaciones, texto de las capturas) pasa por acá ANTES de ir a la IA.
//
// Qué hace:
//   - Tacha API keys, números de tarjeta (validados con Luhn), emails y teléfonos.
//   - Busca palabras clave de credenciales (contraseña, código de verificación,
//     OTP, PIN…). Si aparece una, tacha también los códigos numéricos cercanos
//     y marca el texto como "sensible".
//   - Registra en logs/guard.log QUÉ tipo de dato bloqueó (nunca el dato en sí).
//
// Las pruebas están en test/guard.test.js → correlas con `npm test`.
// =============================================================================
const fs = require('fs');
const path = require('path');

// Palabras clave, escritas SIN acentos y en minúscula (el texto se normaliza
// igual antes de comparar, así "Contraseña" y "contrasena" coinciden).
const KEYWORDS = [
  'contrasena', 'password', 'passwd', 'clave', 'codigo de verificacion', 'codigo de seguridad',
  'verification code', 'security code', 'tu codigo', 'your code', 'otp', '2fa', 'pin', 'token',
  'cvv', 'cvc', 'tarjeta', 'credit card', 'one-time', 'un solo uso', 'login code', 'codigo de acceso',
];

// --- Patrones (expresiones regulares) ---
// API keys conocidas: OpenAI/Anthropic (sk-), Groq (gsk_), NVIDIA (nvapi-),
// GitHub (ghp_…), AWS (AKIA…), Slack (xox…) y tokens JWT (eyJ….….…).
const API_KEY_RE =/\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|nvapi-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
// 13 a 19 dígitos, con espacios o guiones opcionales (después se valida con Luhn).
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Teléfonos tipo "+54 11 5555-1234" o "(011) 555 1234".
const PHONE_RE = /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]\d{3,4}(?:[ -]\d{2,4})?\b/g;
// Códigos de verificación: 4 a 8 dígitos, o formato "ABC-123". Solo se tachan
// si hay una palabra clave cerca (si no, "Pedido 482913" se tacharía sin motivo).
const CODE_RE = /\b\d{4,8}\b|\b[A-Z0-9]{3}-[A-Z0-9]{3}\b/g;

// --- Capturas de pantalla: reglas MÁS estrictas ---
// Una captura no se puede "tachar" (la IA ve la imagen entera y lee los números
// aunque el OCR los lea mal), así que ante la duda NO se manda. Por eso acá
// alcanza con palabras sueltas como "código" o "emparejar", que en un texto
// normal serían demasiado.
// (Caso real: la ventana de Enlace Móvil mostraba "Confirma que este código…
// 4 0 7 3 9 1" y el OCR leyó "4 o 7 3 9 l": ni la palabra ni el número
// coincidían con las reglas de texto, y la IA repitió el código.)
const CAPTURE_KEYWORDS = [
  'codigo', 'code', 'emparejar', 'emparejamiento', 'vincular', 'pairing', 'pair device',
  'verificacion', 'verification', 'verify', 'autenticacion', 'authenticator', 'autenticador',
  'iniciar sesion', 'sign in', 'log in', 'one time', 'pin',
];
// Dígitos sueltos en fila, típicos de las cajitas de un código: "4 0 7 3 9 1".
// Aceptamos o/O/l/I como dígitos porque el OCR los confunde (0→o, 1→l).
const SPACED_DIGITS_RE = /(?:^|\s)((?:[0-9oOlI][\s|]+){3,7}[0-9oOlI])(?=\s|$)/g;

/**
 * ¿Se puede mandar esta captura? Recibe el texto que leyó el OCR.
 * @returns {{block: boolean, reasons: string[]}}
 */
function scanCapture(text) {
  const base = scan(text);
  const reasons = [...base.keywords, ...base.reasons.filter((r) => r !== 'email' && r !== 'telefono')];
  const norm = normalize(text || '');
  for (const k of CAPTURE_KEYWORDS) {
    if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(norm)) reasons.push(k);
  }
  for (const m of String(text || '').matchAll(SPACED_DIGITS_RE)) {
    // al menos 3 dígitos de verdad, para no confundir "l o l o" con un código
    if ((m[1].match(/[0-9]/g) || []).length >= 3) reasons.push('digitos-sueltos');
  }
  return { block: base.sensitive || reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * Última barrera para lo que DICE Clawd cuando vio una captura: tacha
 * cualquier número de 4 a 8 cifras (un código que se haya colado igual).
 */
function redactNumbers(text) {
  return String(text || '').replace(/\d(?:[\s-]?\d){3,7}/g, '[…]');
}

/** Saca acentos y pasa a minúscula: "Contraseña" → "contrasena". */
function normalize(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Algoritmo de Luhn: el chequeo que usan todas las tarjetas de crédito.
 * Sirve para no confundir un número de pedido cualquiera con una tarjeta.
 */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Devuelve qué palabras clave aparecen (como palabra entera, no "spinning" → "pin"). */
function findKeywords(text) {
  const norm = normalize(text);
  return KEYWORDS.filter((k) => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(norm));
}

/**
 * Analiza un texto.
 * @returns {{clean: string, sensitive: boolean, keywords: string[], reasons: string[]}}
 *   clean     → el texto con los datos tachados (esto es lo que se puede mandar)
 *   sensitive → true si habla de credenciales o si se tachó una key/tarjeta/código
 *   keywords  → palabras clave encontradas
 *   reasons   → qué se tachó: api-key, tarjeta, email, telefono, codigo
 */
function scan(text) {
  if (!text) return { clean: '', sensitive: false, keywords: [], reasons: [] };
  const reasons = new Set();
  let clean = String(text);

  clean = clean.replace(API_KEY_RE, () => { reasons.add('api-key'); return '[dato sensible]'; });
  clean = clean.replace(CARD_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && luhn(digits)) { reasons.add('tarjeta'); return '[dato sensible]'; }
    return m;
  });
  clean = clean.replace(EMAIL_RE, () => { reasons.add('email'); return '[oculto]'; });
  clean = clean.replace(PHONE_RE, () => { reasons.add('telefono'); return '[oculto]'; });

  const keywords = findKeywords(clean);
  if (keywords.length) {
    clean = clean.replace(CODE_RE, () => { reasons.add('codigo'); return '[dato sensible]'; });
  }
  const sensitive = keywords.length > 0 || reasons.has('api-key') || reasons.has('tarjeta') || reasons.has('codigo');
  return { clean, sensitive, keywords, reasons: [...reasons] };
}

let logFile = null;
function setLogFile(file) { logFile = file; }

// Registra QUÉ se bloqueó, nunca el dato.
function log(source, result) {
  if (!logFile || (!result.sensitive && !result.reasons.length)) return;
  const line = `${new Date().toISOString()} [${source}] motivos=${[...result.keywords, ...result.reasons].join(',')}\n`;
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, line); } catch {}
}

/** scan() + registrar en el log. Es lo que usa main.js. `source` dice de dónde vino. */
function check(source, text) {
  const result = scan(text);
  log(source, result);
  return result;
}

/** scanCapture() + registrar en el log qué hizo que no se mande la captura. */
function checkCapture(text) {
  const result = scanCapture(text);
  if (result.block) log('captura', { sensitive: true, keywords: [], reasons: result.reasons });
  return result;
}

module.exports = { scan, check, scanCapture, checkCapture, redactNumbers, normalize, setLogFile, luhn };
