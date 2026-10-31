// =============================================================================
// focus.js — Modo foco (pomodoro).
//
// Ciclo clásico: 25 min de foco → 5 de descanso → foco → … y cada 4 focos un
// descanso largo de 15. Los tiempos salen de config.json → focus.
//
// Este archivo solo lleva la cuenta del tiempo y avisa cuándo cambia la fase.
// Qué hace Clawd en cada fase (callarse, guardar notificaciones, festejar…)
// lo decide main.js con el callback onPhase.
// =============================================================================

class Pomodoro {
  /**
   * @param {object} opts
   * @param {number} opts.workMinutes
   * @param {number} opts.breakMinutes
   * @param {number} opts.longBreakMinutes
   * @param {number} opts.cyclesBeforeLongBreak
   * @param {(info: {phase: string, endsAt: number, cycle: number, prev: string}) => void} opts.onPhase
   *   se llama cada vez que cambia la fase: 'work', 'break', 'longBreak' u 'off'
   */
  constructor(opts) {
    this.opts = opts;
    this.phase = 'off';
    this.cycle = 0;      // cuántos focos completaste en esta tanda
    this.endsAt = 0;
    this.timer = null;
  }

  get active() { return this.phase !== 'off'; }
  get working() { return this.phase === 'work'; }

  /** Arranca una tanda nueva desde el primer foco. */
  start() {
    this.cycle = 0;
    this.go('work');
  }

  /** Corta todo. */
  stop() {
    this.go('off');
  }

  info(prev) {
    return { phase: this.phase, endsAt: this.endsAt, cycle: this.cycle, prev };
  }

  /** Pasa a una fase y programa la siguiente. */
  go(phase) {
    const prev = this.phase;
    clearTimeout(this.timer);
    this.phase = phase;
    const mins = { work: this.opts.workMinutes, break: this.opts.breakMinutes, longBreak: this.opts.longBreakMinutes }[phase];
    this.endsAt = mins ? Date.now() + mins * 60 * 1000 : 0;
    if (mins) this.timer = setTimeout(() => this.next(), mins * 60 * 1000);
    this.opts.onPhase(this.info(prev));
  }

  /** Terminó la fase actual: foco → descanso (corto o largo) → foco… */
  next() {
    if (this.phase === 'work') {
      this.cycle++;
      this.go(this.cycle % this.opts.cyclesBeforeLongBreak === 0 ? 'longBreak' : 'break');
    } else {
      this.go('work');
    }
  }
}

module.exports = { Pomodoro };
