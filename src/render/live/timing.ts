/**
 * Live-layer timing (DESIGN §3.2, §6.6): the hot-ink decay, reveal and un-grow schedules, the
 * tuning constants, the arc clock and the halo's brightness. Pure: no canvas, no state.
 */
import type { FormId, Ground } from '../../core/types';
import { clamp01, easeOutCubic } from '../../core/num';

// ============================================================================ constants

/** Hot ink (DESIGN §3.2): Night burns like light painting; Paper reads darker wet and dries lighter. */
export const HOT: Readonly<Record<Ground, { readonly h: number; readonly tau: number }>> = {
  night: { h: 0.45, tau: 220 },
  paper: { h: 0.25, tau: 380 },
};
/** Hot window cap and chunk (sp). */
export const HOT_WINDOW = 120, HOT_CHUNK = 12;
/**
 * The oldest part of a full hot window cools spatially to 0 over this arc (sp): four 12 sp
 * chunks, so a fast stroke's trail fades out at the cap instead of stepping.
 */
export const HOT_EDGE = 48;
/** Living-wake reveal times (ms): Line 160 (morph), Sprout 280 per generation, Drift 240. */
export function revealMs(form: FormId): number {
  return form === 'line' ? 160 : form === 'sprout' ? 280 : 240;
}
/** easeOutCubic reaches 0.6 at this fraction of its time: a Sprout child starts when its parent reaches 60 %. */
export const CHILD_AT = 1 - Math.cbrt(0.4);
/** Spine reach of each Form (sp): growth is born this far behind the nib, plus the 24 sp unsettled tail. */
export const REACH: Record<FormId, number> = {
  line: 36, echo: 0, sprout: 24, drift: 12,
  // the promoted lab Forms: their operators' `reach`
  ripple: 52, craze: 60, plume: 22, caustic: 20, burin: 8, plait: 108, orbit: 54,
};
/** Removal, restyle, re-grow, lift cross-fade, Echo ghost dissolve and brim flash durations (ms). */
export const UNGROW_MS = 200, RESTYLE_UNGROW_MS = 150, GROW_MS = 320, LIFT_MS = 120, GHOST_MS = 150, BRIM_MS = 160;
/** At most this many strokes animate at once; older ones fast-forward. */
export const MAX_ANIMATING = 4;
/** On hold start, settled ink this far behind the nib (sp) moves to #wet so the pool window regrows there. */
export const PIN_ARC = 96;
/** The pinned window stays wet this long (ms) after the halo goes. */
export const PIN_LINGER = 300;
/**
 * Cooled ink moves to #dry in batches at most this often (ms), or at once when nothing else on
 * the stroke is still animating: #dry repaints at ≤ 10 Hz however steadily a stroke cools.
 */
export const PROMOTE_MS = 100;
/** A wet poly whose hot multiplier changed by less than this is not repainted this frame. */
export const HOT_EPS = 1 / 512;
/** Play: pre-halo ramp before a pool starts and halo fade after it ends (ms, stroke clock). */
export const PLAY_PRE = 200, PLAY_OUT = 150;

const E3 = Math.exp(-3), INV_1ME3 = 1 / (1 - E3);

// ============================================================================ pure helpers

/**
 * η(age) = max(0, (e^(−age/τ) − e^(−3)) / (1 − e^(−3))): 1 when fresh, reaching exactly 0 at
 * age 3τ (DESIGN §3.2). Negative ages count as fresh; NaN counts as cold.
 */
export function hotEta(age: number, tau: number): number {
  if (age !== age) return 0;
  if (!(age > 0)) return 1;
  if (age >= 3 * tau) return 0;
  const v = (Math.exp(-age / tau) - E3) * INV_1ME3;
  return v > 0 ? v : 0;
}

/** Hot alpha multiplier 1 + h·η(age) on ground g (exactly 1 from age 3τ). */
export function hotMultiplier(age: number, g: Ground): number {
  const p = HOT[g];
  return 1 + p.h * hotEta(age, p.tau);
}

/** Spatial cool-down at the far end of a full hot window: 0 beyond 120 sp behind the tip, 1 within 72 sp. */
export function windowEdge(s: number, tip: number): number {
  const lo = tip - HOT_WINDOW;
  if (s <= lo) return 0;
  const t = (s - lo) / HOT_EDGE;
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** easeOutCubic of a time fraction (NaN → 0). */
export function ease01(t: number): number {
  return t === t ? easeOutCubic(t) : 0;
}

/** Reveal of one poly of a prefix chain (Drift thirds): f of the chain's arc, mapped onto this poly. */
export function chainReveal(f: number, off: number, tot: number, len: number): number {
  if (len > 0 && tot > len) return clamp01((f * tot - off) / len);
  return f;
}

/** Sprout cascade: a generation-g poly starts this long after its unit (other Forms: 0). */
export function genOffset(form: FormId, gen: number, T: number): number {
  return form === 'sprout' && gen > 1 ? (gen - 1) * CHILD_AT * T : 0;
}

/** Echo fold-out time T = clamp(350 + 120·d_E, 350, 1100) ms. */
export function echoFoldMs(dE: number): number {
  return Math.min(1100, Math.max(350, 350 + 120 * (dE > 0 ? dE : 0)));
}

/**
 * Progress 0..1 of generation g (of 0..G) at time t of a whole-stroke growth lasting `dur`: one
 * phase per generation, two slots long on a grid of dur/(G + 2), so consecutive generations
 * overlap by half. `reverse` (un-grow) runs the deepest generation first and the spine last.
 */
export function genPhase(t: number, dur: number, g: number, G: number, reverse: boolean): number {
  if (!(dur > 0)) return 1;
  const slot = dur / (G + 2);
  const k = reverse ? G - g : g;
  return clamp01((t - k * slot) / (2 * slot));
}

/** Drift's drawn-length law N(d) = 18·min(d, 1) + 26.4·max(0, d − 1) (DESIGN §2.3.6). */
export function driftN(d: number): number {
  return 18 * Math.min(Math.max(d, 0), 1) + 26.4 * Math.max(0, d - 1);
}

// ============================================================================ arc clock

/**
 * When the nib (or a replay) reached each arc: monotone (arc, wall-time) marks. Hot ages of the
 * trunk read it, so the trail cools from where the nib actually was, at any replay speed.
 */
export class ArcClock {
  private s = new Float64Array(64);
  private w = new Float64Array(64);
  n = 0;
  /** Arcs ≤ this are treated as reached long ago (fast-forward). */
  agedTo = -Infinity;

  reset(): void { this.n = 0; this.agedTo = -Infinity; }

  /**
   * Record that arc s was reached at time t. Arcs never decrease; a pause (same arc, later time)
   * is kept. Marks closer than 0.25 sp and 40 ms to the last one are dropped unless `force`
   * (a stroke's final arc must always land, or a replay would stop a hair short of its end).
   */
  mark(s: number, t: number, force = false): void {
    if (s !== s || t !== t) return;
    const n = this.n;
    if (n > 0) {
      const ls = this.s[n - 1], lt = this.w[n - 1];
      if (s < ls) s = ls;
      if (!(t > lt)) { if (force && s > ls) this.s[n - 1] = s; return; }
      if (!force && s - ls < 0.25 && t - lt < 40) return;
    }
    if (n >= this.s.length) {
      const a = new Float64Array(2 * n), b = new Float64Array(2 * n);
      a.set(this.s); b.set(this.w); this.s = a; this.w = b;
    }
    this.s[n] = s; this.w[n] = t; this.n = n + 1;
  }

  /** Last arc reached (−∞ before any mark). */
  get last(): number { return this.n > 0 ? this.s[this.n - 1] : -Infinity; }
  /** Wall time of the last mark. */
  get lastTime(): number { return this.n > 0 ? this.w[this.n - 1] : -Infinity; }

  /** Wall time at which arc s was first reached; `beyond` for arcs past the last mark. */
  at(s: number, beyond: number): number {
    if (s <= this.agedTo) return -Infinity;
    const n = this.n;
    if (n === 0) return beyond;
    const S = this.s;
    if (s > S[n - 1]) return beyond;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m] < s) lo = m + 1; else hi = m; }
    if (lo === 0) return this.w[0];
    const s0 = S[lo - 1], s1 = S[lo];
    return s1 > s0 ? this.w[lo - 1] + (this.w[lo] - this.w[lo - 1]) * (s - s0) / (s1 - s0) : this.w[lo];
  }

  /** Arc reached by time t (−∞ before the first mark). */
  arcAt(t: number): number {
    const n = this.n;
    if (n === 0) return -Infinity;
    const W = this.w;
    if (t < W[0]) return -Infinity;
    if (t >= W[n - 1]) return this.s[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (W[m] <= t) lo = m; else hi = m; }
    const s0 = this.s[lo], s1 = this.s[hi];
    return s0 + (s1 - s0) * (t - W[lo]) / (W[hi] - W[lo]);
  }
}

/** Halo brightness (DESIGN §6.6): pre · (0.15 + 0.5·level) · brim flash (×1.8 for 160 ms, easing off over its last 60). */
export function haloAlpha(pre: number, level: number, flashAge: number, rm: boolean): number {
  let p = clamp01(pre), l = clamp01(level);
  if (rm) { p = p >= 0.5 ? 1 : 0; l = Math.round(l * 4) / 4; }
  let k = 1;
  if (!rm && flashAge >= 0 && flashAge < BRIM_MS) k = 1 + 0.8 * (flashAge < 100 ? 1 : 1 - (flashAge - 100) / (BRIM_MS - 100));
  return p * (0.15 + 0.5 * l) * k;
}
