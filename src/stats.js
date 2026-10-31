// =============================================================================
// stats.js — Lo que pasó en el día, para el resumen de la noche.
//
// Cuenta cosas simples, todo LOCAL (se guarda en logs/stats-AAAA-MM-DD.json):
//   - minutos en cada app (solo el nombre del programa, nunca el título)
//   - canciones escuchadas y el artista que más sonó
//   - pomodoros terminados, veces que Claude Code terminó, notificaciones
//   - minutos en apps de distracción (YouTube, TikTok…)
// A la IA solo le llega el resumen ya armado (nombres de apps y números).
// =============================================================================
const fs = require('fs');
const path = require('path');

// Nombres más lindos para los programas más comunes.
const APP_NAMES = {
  code: 'VS Code', windowsterminal: 'Terminal', powershell: 'PowerShell', pwsh: 'PowerShell',
  cmd: 'Terminal', explorer: 'Explorador', brave: 'Brave', chrome: 'Chrome', msedge: 'Edge',
  firefox: 'Firefox', claude: 'Claude', spotify: 'Spotify', discord: 'Discord', whatsapp: 'WhatsApp',
  cursor: 'Cursor', notepad: 'Bloc de notas', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint',
  privada: 'App privada', // las de config.privateApps: no guardamos cuál era
};

function prettyApp(proc) {
  const key = String(proc || '').toLowerCase();
  return APP_NAMES[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '¿?');
}

/** 45 → "<1 min" · 2700 → "45 min" · 7800 → "2 h 10 min" */
function fmt(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Fecha local como "2026-10-30" (el día de la persona, no el de UTC). */
function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function empty(date) {
  return { date, apps: {}, songs: 0, artists: {}, pomodoros: 0, claude: 0, notifications: 0, distractSec: 0, summaryShown: false };
}

class DayStats {
  /** @param {string|null} dir carpeta donde guardar (null = no guardar, para las pruebas) */
  constructor(dir) {
    this.dir = dir;
    this.data = this.load(today());
  }

  file(date) { return this.dir && path.join(this.dir, `stats-${date}.json`); }

  load(date) {
    try { return { ...empty(date), ...JSON.parse(fs.readFileSync(this.file(date), 'utf8')) }; } catch { return empty(date); }
  }

  save() {
    if (!this.dir) return;
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file(this.data.date), JSON.stringify(this.data)); } catch {}
  }

  /** Si cambió el día (pasó la medianoche), empezamos de cero. */
  roll() {
    const d = today();
    if (this.data.date !== d) { this.save(); this.data = this.load(d); }
    return this.data;
  }

  addApp(proc, sec) { const d = this.roll(); const n = prettyApp(proc); d.apps[n] = (d.apps[n] || 0) + sec; }
  song(artist) { const d = this.roll(); d.songs++; if (artist) d.artists[artist] = (d.artists[artist] || 0) + 1; }
  pomodoro() { this.roll().pomodoros++; }
  claude() { this.roll().claude++; }
  notification() { this.roll().notifications++; }
  distract(sec) { this.roll().distractSec += sec; }

  /** Segundos frente a la compu en todo el día. */
  totalSec() { return Object.values(this.roll().apps).reduce((a, b) => a + b, 0); }

  /** Las líneas de la tarjeta del resumen (sin la frase de la IA). */
  lines() {
    const d = this.roll();
    const out = [`📊 Tu día: ${fmt(this.totalSec())} en la compu`];
    const top = Object.entries(d.apps).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length) out.push('💻 ' + top.map(([n, s]) => `${n} ${fmt(s)}`).join(' · '));
    const work = [];
    if (d.pomodoros) work.push(`🍅 ${d.pomodoros} pomodoro${d.pomodoros > 1 ? 's' : ''}`);
    if (d.claude) work.push(`✅ Claude terminó ${d.claude} ${d.claude > 1 ? 'veces' : 'vez'}`);
    if (work.length) out.push(work.join(' · '));
    if (d.songs) {
      const fav = Object.entries(d.artists).sort((a, b) => b[1] - a[1])[0];
      out.push(`🎵 ${d.songs} ${d.songs > 1 ? 'canciones' : 'canción'}${fav ? `, más ${fav[0]}` : ''}`);
    }
    if (d.distractSec >= 300) out.push(`📱 ${fmt(d.distractSec)} en distracciones`);
    if (d.notifications) out.push(`📩 ${d.notifications} notificaci${d.notifications > 1 ? 'ones' : 'ón'}`);
    return out;
  }
}

module.exports = { DayStats, fmt, prettyApp, today };
