/**
 * Calibration: the per-device-class learner (pressure curve, typical speed,
 * hand jitter) and the two pressure mappings the spine uses (DESIGN §2.2.2).
 *
 * The learner only updates between strokes. Every stroke snapshots `Calib`
 * into its recipe, so geometry never depends on the learner afterwards.
 */
import type { Calib, Device } from '../core/types';
import { S } from '../core/types';
import { clamp, clamp01, smoothstep } from '../core/num';
import { dexp, dlog, dpow } from '../core/det';
import { rowOk, firstOk, lastOk } from './signals';

/** Pen One Euro min cutoff from the learned jitter J (sp). */
export function penFcMin(J: number): number {
  return clamp(3.5 - 1.5 * smoothstep(0.4, 1.6, J), 1.2, 3.5);
}
/** Flat-hand guard weight k from the learned pressure span. */
export const flatGuard = (lo: number, hi: number): number => smoothstep(0.08, 0.25, hi - lo);

const FC_MIN: Record<Device, number> = { pen: 3.5, mouse: 2.0, touch: 1.5 };

function makeCalib(d: Device, lo: number, hi: number, gamma: number, vMed: number, jitter: number): Calib {
  return {
    lo, hi, gamma, flat: flatGuard(lo, hi), vMed, jitter,
    fcMin: d === 'pen' ? penFcMin(jitter) : FC_MIN[d],
  };
}

/** Cold-start calibration per device class. */
export const DEFAULT_CALIB: Record<Device, Calib> = {
  pen: makeCalib('pen', 0.04, 0.80, 1, 0.9, 0.3),
  mouse: makeCalib('mouse', 0.04, 0.80, 1, 0.9, 0.3),
  touch: makeCalib('touch', 0.04, 0.80, 1, 0.9, 0.3),
};

/**
 * Pen pressure curve: normalise by the learned P5..P95 span, apply γ, then
 * blend toward 0.6 for flat hands (k = calib.flat). NaN input returns 0.6.
 * A damaged calib (γ not a positive number, flat NaN) falls back to γ = 1, k = 1,
 * so a bad recipe snapshot can never turn every width into NaN.
 */
export function calibratePressure(raw: number, c: Calib): number {
  if (!(raw === raw)) return 0.6;
  const span = c.hi - c.lo;
  const pn = span > 1e-6 ? clamp01((raw - c.lo) / span) : raw >= c.lo ? 1 : 0;
  const g = c.gamma > 0 && c.gamma < 1e3 ? c.gamma : 1;
  const curved = pn <= 0 ? 0 : pn >= 1 ? 1 : dpow(pn, g);
  return 0.6 + (curved - 0.6) * (c.flat === c.flat ? clamp01(c.flat) : 1);
}

/** One step of speed-synthesised pressure for mouse/touch (DESIGN §2.2.2). NaN speed holds the value. */
export function synthPressure(prev: number, vn: number, dtMs: number): number {
  if (!(dtMs > 0) || !(vn === vn)) return prev;
  const target = 0.22 + 0.68 * (1 - smoothstep(0.3, 2.4, vn));
  return prev + (target - prev) * (1 - dexp(-dtMs / 45));
}

/** Initial synthesised pressure at the first station. */
export const SYNTH_P0 = 0.35;

// ============================================================================ learner

/** Persistent learner of one calibration per device class. */
export interface Learner {
  snapshot(d: Device): Calib;
  /**
   * Between strokes only: feed a finished stroke's rows (S.STRIDE) and its measured jitter.
   * `z` (sp per doc unit, i.e. recipe.z) converts sample positions to sp for the speed
   * statistic; it defaults to 1 (contract note: the BUILD signature has no z; pass it).
   */
  observe(d: Device, samples: Float32Array, rows: number, jitter: number, z?: number): void;
  reset(d?: Device): void;
  readonly strokes: Readonly<Record<Device, number>>;
}

const RES_CAP = 3000;          // reservoir size (in-stroke samples)
const JIT_CAP = 15;            // recent per-stroke jitter values
const TRIM_MS = 30;            // excluded at each stroke end
const FAST_STROKES = 150;      // EMA phase length
const EMA = 0.08;              // per-stroke EMA weight while learning
const LOCK_STEP = 0.01;        // max relative move per stroke once locked
const LOCK_BAND = 0.15;        // ± band around the converged value once locked
const MIN_SPEED = 0.06;        // sp/ms: slower windows are holds, not drawing
const VWIN_MS = 8;             // speed windows, as for stations

/** A fixed-capacity ring of floats (oldest overwritten). */
class Ring {
  readonly a: Float32Array;
  n = 0; head = 0;
  constructor(cap: number) { this.a = new Float32Array(cap); }
  push(v: number): void {
    this.a[this.head] = v;
    this.head = (this.head + 1) % this.a.length;
    if (this.n < this.a.length) this.n++;
  }
  /** Oldest → newest. */
  values(): number[] {
    const out: number[] = [];
    const cap = this.a.length, start = (this.head - this.n + cap) % cap;
    for (let i = 0; i < this.n; i++) out.push(this.a[(start + i) % cap]);
    return out;
  }
  clear(): void { this.n = 0; this.head = 0; }
}

/** Linear-interpolated percentile of a sorted array (q in 0..1). */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const x = clamp01(q) * (n - 1);
  const i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[i];
}
const sortedCopy = (v: number[]): Float64Array => Float64Array.from(v).sort();

type Param = 'lo' | 'hi' | 'gamma' | 'vMed' | 'jitter';
const PARAMS: readonly Param[] = ['lo', 'hi', 'gamma', 'vMed', 'jitter'];

class DevLearner {
  strokes = 0;
  lo: number; hi: number; gamma: number; vMed: number; jitter: number;
  conv: Record<Param, number> | null = null;
  readonly pRes = new Ring(RES_CAP);
  readonly vRes = new Ring(RES_CAP);
  readonly jRes = new Ring(JIT_CAP);

  constructor(readonly d: Device) {
    const c = DEFAULT_CALIB[d];
    this.lo = c.lo; this.hi = c.hi; this.gamma = c.gamma; this.vMed = c.vMed; this.jitter = c.jitter;
  }

  reset(): void {
    const c = DEFAULT_CALIB[this.d];
    this.strokes = 0; this.conv = null;
    this.lo = c.lo; this.hi = c.hi; this.gamma = c.gamma; this.vMed = c.vMed; this.jitter = c.jitter;
    this.pRes.clear(); this.vRes.clear(); this.jRes.clear();
  }

  snapshot(): Calib { return makeCalib(this.d, this.lo, this.hi, this.gamma, this.vMed, this.jitter); }

  /** Move a parameter toward its target under the learning / lock rules. */
  private move(k: Param, target: number): void {
    if (!(target === target)) return;
    const cur = this[k];
    let step = EMA * (target - cur);
    if (this.conv) {
      const lim = LOCK_STEP * Math.abs(cur);
      step = clamp(step, -lim, lim);
      const c = this.conv[k];
      this[k] = clamp(cur + step, c - LOCK_BAND * Math.abs(c), c + LOCK_BAND * Math.abs(c));
    } else {
      this[k] = cur + step;
    }
  }

  observe(data: Float32Array, rows: number, jitter: number, z: number): void {
    const f = firstOk(data, rows), l = lastOk(data, rows);
    if (f < 0 || l <= f) return;
    const t0 = data[f * S.STRIDE + S.T], t1 = data[l * S.STRIDE + S.T];
    const a = t0 + TRIM_MS, b = t1 - TRIM_MS;
    // pressure reservoir (real pressure only; corrupt rows skipped)
    for (let i = f; i <= l; i++) {
      const o = i * S.STRIDE, t = data[o + S.T], p = data[o + S.P];
      if (t >= a && t <= b && p === p && rowOk(data, i)) this.pRes.push(p);
    }
    // speed reservoir: one value per ≥ 8 ms window of intact rows, holds excluded
    for (let i = f; i <= l;) {
      const o = i * S.STRIDE, t = data[o + S.T];
      if (t < a || !rowOk(data, i)) { i++; continue; }
      let j = i + 1;
      while (j <= l && (!rowOk(data, j) || data[j * S.STRIDE + S.T] - t < VWIN_MS)) j++;
      if (j > l) break;
      const oj = j * S.STRIDE, tj = data[oj + S.T];
      if (tj > b) break;
      const dx = (data[oj + S.X] - data[o + S.X]) * z, dy = (data[oj + S.Y] - data[o + S.Y]) * z;
      const v = Math.sqrt(dx * dx + dy * dy) / (tj - t);
      if (v >= MIN_SPEED) this.vRes.push(v);
      i = j;
    }
    if (jitter === jitter && jitter > 0) this.jRes.push(jitter);

    // targets
    if (this.pRes.n >= 32) {
      const sp = sortedCopy(this.pRes.values());
      const lo = percentile(sp, 0.05), mid = percentile(sp, 0.5), hi = percentile(sp, 0.95);
      const ratio = hi - lo > 1e-6 ? clamp((mid - lo) / (hi - lo), 0.02, 0.98) : 0.5;
      this.move('lo', lo);
      this.move('hi', hi);
      this.move('gamma', clamp(dlog(0.5) / dlog(ratio), 0.55, 1.8));
      this.lo = clamp(this.lo, 0, 0.9);
      this.hi = clamp(this.hi, this.lo + 0.02, 1);
      this.gamma = clamp(this.gamma, 0.55, 1.8);
    }
    if (this.vRes.n >= 16) {
      this.move('vMed', percentile(sortedCopy(this.vRes.values()), 0.5));
      this.vMed = clamp(this.vMed, 0.15, 5);
    }
    if (this.jRes.n >= 1) {
      this.move('jitter', percentile(sortedCopy(this.jRes.values()), 0.5));
      this.jitter = clamp(this.jitter, 0.05, 3);
    }
    this.strokes++;
    if (!this.conv && this.strokes >= FAST_STROKES) {
      this.conv = { lo: this.lo, hi: this.hi, gamma: this.gamma, vMed: this.vMed, jitter: this.jitter };
    }
  }

  toJSON(): string {
    const r4 = (v: number[]): number[] => v.map(x => Math.round(x * 1e4) / 1e4);
    return JSON.stringify({
      v: 1, strokes: this.strokes,
      lo: this.lo, hi: this.hi, gamma: this.gamma, vMed: this.vMed, jitter: this.jitter,
      conv: this.conv, p: r4(this.pRes.values()), s: r4(this.vRes.values()), j: r4(this.jRes.values()),
    });
  }

  fromJSON(text: string): void {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || o.v !== 1) return;
    const num = (x: unknown): number | null => (typeof x === 'number' && x === x && x !== Infinity && x !== -Infinity ? x : null);
    const fill = (ring: Ring, x: unknown): void => {
      ring.clear();
      if (Array.isArray(x)) for (const v of x) { const n = num(v); if (n !== null) ring.push(n); }
    };
    const st = num(o.strokes);
    for (const k of PARAMS) { const n = num(o[k]); if (n !== null) this[k] = n; }
    this.strokes = st !== null ? Math.max(0, Math.floor(st)) : 0;
    const c = o.conv as Record<string, unknown> | null;
    if (c && typeof c === 'object') {
      const conv = {} as Record<Param, number>;
      let ok = true;
      for (const k of PARAMS) { const n = num(c[k]); if (n === null) ok = false; else conv[k] = n; }
      this.conv = ok ? conv : null;
    } else this.conv = null;
    if (!this.conv && this.strokes >= FAST_STROKES) {
      this.conv = { lo: this.lo, hi: this.hi, gamma: this.gamma, vMed: this.vMed, jitter: this.jitter };
    }
    fill(this.pRes, o.p); fill(this.vRes, o.s); fill(this.jRes, o.j);
    this.lo = clamp(this.lo, 0, 0.9);
    this.hi = clamp(this.hi, this.lo + 0.02, 1);
    this.gamma = clamp(this.gamma, 0.55, 1.8);
    this.vMed = clamp(this.vMed, 0.15, 5);
    this.jitter = clamp(this.jitter, 0.05, 3);
  }
}

const DEVICES: readonly Device[] = ['pen', 'mouse', 'touch'];
const keyOf = (d: Device): string => `rise:calib:${d}`;

/**
 * Create the learner. `io` (prefs.load/save) persists each class under
 * 'rise:calib:<device>'; every call is wrapped in try/catch.
 */
export function createLearner(io?: { load(key: string): string | null; save(key: string, v: string): void }): Learner {
  const L: Record<Device, DevLearner> = { pen: new DevLearner('pen'), mouse: new DevLearner('mouse'), touch: new DevLearner('touch') };
  if (io) {
    for (const d of DEVICES) {
      try {
        const s = io.load(keyOf(d));
        if (s) L[d].fromJSON(s);
      } catch { L[d].reset(); }
    }
  }
  const save = (d: Device): void => {
    if (!io) return;
    try { io.save(keyOf(d), L[d].toJSON()); } catch { /* storage unavailable: keep learning in memory */ }
  };
  const strokes = {} as Record<Device, number>;
  for (const d of DEVICES) Object.defineProperty(strokes, d, { enumerable: true, get: () => L[d].strokes });
  return {
    snapshot: d => L[d].snapshot(),
    observe(d, samples, rows, jitter, z = 1) {
      L[d].observe(samples, Math.min(rows, Math.floor(samples.length / S.STRIDE)), jitter, z > 0 ? z : 1);
      save(d);
    },
    reset(d) {
      for (const k of d ? [d] : DEVICES) { L[k].reset(); save(k); }
    },
    strokes,
  };
}
