/**
 * Envelope: the width multiplier E(s) applied at tessellation (never stored in
 * Spine.w), plus closure detection (DESIGN §2.2.2).
 *
 *   E(s) = smoothstep(0, Te, s − s0) · smoothstep(0, Tx, L − s)^0.6 · seated bulb
 *
 * Operators only ever see the causal entry factor E_in(s) = smoothstep(0, Te, s − s0)
 * (`inF`), which is final once 40 ms of samples exist (`teFinal`). Everything that
 * depends on the end of the stroke (exit taper, flick, seated stop, ramp-down, the
 * trunk's Te ≤ 0.25·len clamp) exists only in the final envelope: these are lift zones.
 */
import type { Device, RecipeView, Spine } from '../core/types';
import type { InkSpine } from './spine';
import { S } from '../core/types';
import { smoothstep } from '../core/num';
import { dpow, datan2, PI } from '../core/det';
import { NIBS } from './nibs';
import { calibratePressure } from './calib';
import {
  rowsOf, entrySpeed, entryKnown, exitSpeed, exitVelocity, endDwell, isSynthPressure, qAtTime, rawPressureAt,
  netTurning, lastOk, STILL_RADIUS, jitterFactor,
} from './signals';

/** Width envelope of one stroke. */
export interface Envelope {
  readonly Te: number; readonly Tx: number;   // sp
  readonly seated: boolean; readonly closed: boolean;
  /** Causal entry factor E_in(s). */
  inF(s: number): number;
  /** Full width multiplier E(s) (exit factor is 1 in a live envelope). */
  at(s: number): number;
}

/** Envelope with the extra facts the cook and tessellator need. */
export interface InkEnvelope extends Envelope {
  /**
   * True once the entry speed is known (≥ 40 ms of samples, a cut head, or a finished
   * stroke). Closure still toggles Te between its value and 0 (the head zone, ≤ 30 sp).
   */
  readonly teFinal: boolean;
  /** Entry taper the trunk tessellates with (final: min(Te, 0.25·len); live: Te). */
  readonly TeTrunk: number;
  /** Arc of the first station and the end arc the exit taper measures from (sp). */
  readonly s0: number; readonly L: number;
}

/** Seated stop: below this exit v_n … */
export const SEATED_VN = 0.15;
/** … after at least this much end dwell (ms), the stroke ends seated. */
export const SEATED_DWELL_MS = 60;
/** Seated bulb: the last 3 sp widen ×1.12 (with a 3 sp ramp in). */
export const SEATED_BULB = 0.12;
/** Pen ramp-down: real pressure below this, 30 ms before lift, halves Tx. */
export const RAMP_P = 0.35;
const RAMP_LOOKBACK_MS = 30;

const isClosed = (r: RecipeView): boolean => ('closing' in r ? r.closing : r.closed);
const vMedOf = (r: RecipeView): number => (r.calib.vMed > 0 ? r.calib.vMed : 0.9);

/** Entry taper Te (sp) from v_entry; 0 when the head is a cut or the loop is closed. */
export function entryTaper(r: RecipeView): number {
  if (r.cut & 1 || isClosed(r)) return 0;
  const { data, n } = rowsOf(r);
  if (n === 0) return 0;
  const vn = entrySpeed(data, n, r.z) / vMedOf(r);
  return (4 + 26 * smoothstep(0.4, 2.0, vn)) * NIBS[r.stroke.nib].taper;
}

const ss = (T: number, x: number): number => (T > 0 ? smoothstep(0, T, x) : 1);

class Env implements InkEnvelope {
  constructor(
    readonly Te: number, readonly Tx: number, readonly TeTrunk: number,
    readonly seated: boolean, readonly closed: boolean, readonly teFinal: boolean,
    readonly s0: number, readonly L: number, private readonly exitOn: boolean,
  ) {}
  inF(s: number): number { return ss(this.Te, s - this.s0); }
  at(s: number): number {
    let e = ss(this.TeTrunk, s - this.s0);
    if (this.exitOn) {
      if (this.Tx > 0) {
        const x = smoothstep(0, this.Tx, this.L - s);
        e *= x >= 1 ? 1 : x <= 0 ? 0 : dpow(x, 0.6);
      }
      if (this.seated) e *= 1 + SEATED_BULB * smoothstep(this.L - 6, this.L - 3, s);
    }
    return e;
  }
}

/** Live envelope: causal entry taper only; the tip stays round (exit factor 1). */
export function liveEnvelope(r: RecipeView, sp: Spine): InkEnvelope {
  const { data, n } = rowsOf(r);
  const Te = entryTaper(r);
  const s0 = sp.n > 0 ? sp.s[0] : r.s0;
  // a committed recipe is finished, so its entry speed is known even if it lasted < 40 ms
  const teFinal = !('closing' in r) || (r.cut & 1) !== 0 || entryKnown(data, n);
  return new Env(Te, 0, Te, false, isClosed(r), teFinal, s0, sp.L, false);
}

/** Final envelope of a finished spine: exit taper, flick, seated stop, ramp-down, closure. */
export function finalEnvelope(r: RecipeView, sp: Spine): InkEnvelope {
  const { data, n } = rowsOf(r);
  const closed = isClosed(r);
  const s0 = sp.n > 0 ? sp.s[0] : r.s0;
  const len = Math.max(0, sp.L - s0);
  const Te = entryTaper(r);
  const TeTrunk = Math.min(Te, 0.25 * len);
  let Tx = 0, seated = false;
  const last = lastOk(data, n);
  if (!closed && !(r.cut & 2) && last >= 0) {
    const vMed = vMedOf(r);
    // seated: net displacement (robust to tremor) and dwell inside the J-scaled still radius
    const radius = STILL_RADIUS[r.device as Device] * jitterFactor(r.calib.jitter);
    seated = exitVelocity(data, n, r.z) / vMed < SEATED_VN && endDwell(data, n, r.z, radius) >= SEATED_DWELL_MS;
    if (!seated) {
      const vxn = exitSpeed(data, n, r.z) / vMed;
      Tx = Math.min(Math.max(4 + 46 * smoothstep(0.4, 2.2, vxn), 4), 0.35 * len) * NIBS[r.stroke.nib].taper;
      if (!isSynthPressure(data, n)) {
        const tl = data[last * S.STRIDE + S.T];
        const pEnd = calibratePressure(rawPressureAt(data, n, qAtTime(data, n, tl - RAMP_LOOKBACK_MS), NaN), r.calib);
        if (pEnd < RAMP_P) Tx *= 0.5;
      }
    }
  }
  return new Env(Te, Tx, TeTrunk, seated, closed, true, s0, sp.L, true);
}

// ============================================================================ closure

/** Closure radius r_c = max(10 sp, 0.06·len). */
export const closureRadius = (len: number): number => Math.max(10, 0.06 * len);
/** Net turning a loop needs: 300°. */
export const CLOSURE_TURN = (300 * PI) / 180;

/** Arc (sp) of the seam weld: the last 4% of the loop, at least 2·gap and 6 sp, at most 50 sp and half the loop. */
export function weldWidth(len: number, gapSp: number): number {
  return Math.max(0, Math.min(50, Math.max(0.04 * len, 2 * gapSp, 6), 0.5 * len));
}

/** sp per doc unit of a spine: InkSpine carries z; otherwise estimate from arc vs chord. */
export function spineZ(sp: Spine): number {
  const z = (sp as Partial<InkSpine>).z;
  if (typeof z === 'number' && z > 0) return z;
  let arc = 0, chord = 0;
  for (let i = 1; i < sp.n; i++) {
    const dx = sp.x[i] - sp.x[i - 1], dy = sp.y[i] - sp.y[i - 1];
    chord += Math.sqrt(dx * dx + dy * dy); arc += sp.s[i] - sp.s[i - 1];
  }
  return chord > 0 ? arc / chord : 1;
}

/**
 * Cached prefix of the net turning of a live spine (settled stations never change).
 * It remembers station 0 and station `upTo`, so a spine object reused for another
 * stroke (pooled buffers) is detected and the prefix rebuilt instead of trusted.
 */
interface TurnCache { upTo: number; sum: number; hx: number; hy: number; has: boolean; x0: number; y0: number; xu: number; yu: number }
const turnCache = new WeakMap<Spine, TurnCache>();

function liveNetTurning(sp: Spine): number {
  const n = sp.n, X = sp.x, Y = sp.y;
  // stations < settled are final, so headings up to station settled-1 are final
  const fin = sp.settled < n ? sp.settled - 1 : -1;
  let c = turnCache.get(sp);
  if (fin < 1) { turnCache.delete(sp); return netTurning(X, Y, 0, n - 1); }
  if (!c || c.upTo > fin || !Object.is(c.x0, X[0]) || !Object.is(c.y0, Y[0]) ||
    !Object.is(c.xu, X[c.upTo]) || !Object.is(c.yu, Y[c.upTo])) {
    c = { upTo: 0, sum: 0, hx: 0, hy: 0, has: false, x0: X[0], y0: Y[0], xu: X[0], yu: Y[0] };
    turnCache.set(sp, c);
  }
  for (let i = c.upTo + 1; i <= fin; i++) {
    const dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1];
    if (dx * dx + dy * dy < 1e-18) continue;
    if (c.has) c.sum += datan2(c.hx * dy - c.hy * dx, c.hx * dx + c.hy * dy);
    c.hx = dx; c.hy = dy; c.has = true;
  }
  c.upTo = fin; c.xu = X[fin]; c.yu = Y[fin];
  let sum = c.sum, hx = c.hx, hy = c.hy, has = c.has;
  for (let i = fin + 1; i < n; i++) {
    const dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1];
    if (dx * dx + dy * dy < 1e-18) continue;
    if (has) sum += datan2(hx * dy - hy * dx, hx * dx + hy * dy);
    hx = dx; hy = dy; has = true;
  }
  return sum;
}

/**
 * Closure test with hysteresis (on inside r_c, off beyond 1.5·r_c): the tip is
 * near the start, the loop is long relative to the gap (len > 8·gap) and it has
 * turned through more than 300° net.
 */
export function closureTest(sp: Spine, wasClosing: boolean): boolean {
  const n = sp.n;
  if (n < 3) return false;
  const z = spineZ(sp);
  const dx = (sp.x[n - 1] - sp.x[0]) * z, dy = (sp.y[n - 1] - sp.y[0]) * z;
  const gap = Math.sqrt(dx * dx + dy * dy);
  const len = sp.L - sp.s[0];
  const rc = closureRadius(len);
  if (wasClosing ? gap > 1.5 * rc : gap >= rc) return false;
  if (!(len > 8 * gap)) return false;
  return Math.abs(liveNetTurning(sp)) > CLOSURE_TURN;
}
