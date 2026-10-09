/**
 * Spine: how the hand becomes a spine (DESIGN §2.2.2). Incremental, with a
 * numeric settled watermark that makes "live preview ≡ committed geometry" hold.
 *
 * ─── Pipeline ─────────────────────────────────────────────────────────────────
 * Each stage is a streaming state machine fed in order; nothing is ever revised
 * once a stage has emitted it ("final"), so the result cannot depend on how the
 * samples were chunked across append() calls.
 *
 *   samples ─► One Euro (causal, per sample) ─► F: filtered polyline (sp)
 *     F ─► knots every 2.4 sp of F arc
 *     knots ─► resolve: corner test + snap  (needs 4 knots of lookahead = 9.6 sp)
 *     resolved knots ─► Chaikin ×2, corners and ends kept fixed  (1 point of lookahead each)
 *     ─► stations every 2.4 sp of arc; the nearest station snaps onto each corner
 *        (held until the walk is 1.2 sp past it)
 *     ─► per-station signals: κ and normal need the path to s + 3 sp plus the next
 *        station's turning interval; v needs a central difference spanning ≥ 8 ms
 *        (≤ 4 stations each side)
 *
 * ─── What lags the tip, and why ───────────────────────────────────────────────
 * Measured from the filtered tip (which itself lags the raw pointer by the One
 * Euro filter's v·τ; the end flush closes that gap at lift):
 *   corner lookahead 9.6 sp + knot quantisation ≤ 2.4 + Chaikin ~1.2
 *   + station hold 1.2 + signals 4.2 to 9.6 sp  ⇒  measured on long strokes at
 *   0.3–2.5 sp/ms, settled trails the provisional tip by ~19–23 sp on average and
 *   26 sp at worst. The cost of an append is ~15 µs (it re-runs only that tail).
 * Stations [settled, n) are PROVISIONAL: on every append they are recomputed by
 * running a copy of the pipeline to end-of-stream (the last knot treated as an
 * endpoint, windows clamped), exactly as finish() would minus the end flush.
 * Stations [0, settled) are FINAL: bit-identical whatever the append chunking, and
 * `settled` never decreases. Typed-array references on the spine may be replaced
 * when it grows: re-read sp.x etc. after each append().
 *
 * ─── What finish() changes (the lift zones only) ──────────────────────────────
 *  - End flush: the raw lift point is appended to F, so filter lag never shortens
 *    a stroke, timed τ = 1/(2π·fc) after the last row so speed stays continuous across
 *    it; the pipeline is flushed; every station becomes final (settled = n).
 *    This only touches stations that were provisional.
 *  - Seam weld (weldSpine, exported so a live preview can run it on a copy), closed
 *    strokes only: stations within the last W = weldWidth(len, gap)
 *    ≤ 50 sp move toward the start (a cubic Hermite blend: smooth departure, the last
 *    station lands exactly on the first, arriving in the start's direction so the seam
 *    has no kink); x/y are moved there, and nx/ny/k are recomputed
 *    cyclically within SEAM_ZONE = 6 sp of the moved stations and of the start. So the
 *    lift zones are s ≥ L − W − 6 (≤ 56 sp) and s ≤ s0 + 6. t/p/w/vn/c/cs/alt/az and s
 *    never change. This is the only edit finish() makes to previously settled stations.
 * Tapers, flick, seated stop and ramp-down are NOT in the spine: they live in the
 * envelope (envelope.ts), applied at tessellation.
 *
 * ─── Station fields ───────────────────────────────────────────────────────────
 *  x, y   doc units relative to recipe.origin (= sp / z; rot is 0 in P0).
 *  s      absolute arc (sp) along the smoothed path: s0 + 2.4·i for ordinary
 *         stations; a corner station carries its exact corner arc (within 1.2 sp of
 *         its grid value); the last station of a finished stroke sits at the end arc
 *         (0.6–3.0 sp after its predecessor). Spine.L = s[n−1] (absolute end arc).
 *  t      ms since pen-down, interpolated from the sample times (corrupt rows skipped).
 *         On a finished stroke the end-flush segment runs on to t_last + τ (τ is the
 *         filter time constant at lift, typically 3–45 ms), so t strictly increases there.
 *  p      pens (first stored P finite): calibratePressure(raw P at the station, calib);
 *         mouse/touch (stored P = NaN): synthPressure stepped station to station with
 *         dt from the stored t, starting at 0.35 (deterministic, cook-time).
 *  w      UNTAPERED nib width in doc units: nibWidth(nib, S, p, vn, device, alt) / z.
 *  vn     v / calib.vMed, v = (s[i+k] − s[i−k]) / (t[i+k] − t[i−k]) with the smallest
 *         k ≤ 4 spanning ≥ 8 ms (indices clamped at the ends).
 *  k      signed curvature, rad/sp: the polyline's turning inside [s−3, s+3] per sp
 *         (each station's turning spread over its midpoint interval; exact on
 *         circles); k > 0 when the path bends toward n (centre of curvature at P + n/k).
 *  nx, ny unit normal LEFT of travel in the y-down frame: (ty, −tx) of the tangent
 *         P(s+3) − P(s−3), i.e. smoothed over 6 sp.
 *  c, cs  frozen crowding / side crowding, interpolated from the sample channels.
 *  alt, az pen altitude / azimuth (radians), interpolated (az the short way round).
 *  corner 1 where a crisp corner was kept (turn > 55° within ±4 sp at v < 0.25·vMed).
 *
 * ─── Split pieces (s0 / resume) ───────────────────────────────────────────────
 * snapshot() returns the state at the last settled station (layout: const enum RESUME).
 * Protocol for a continuation: s0 = snapshot[RESUME.S], cut bit 0 set, resume =
 * snapshot, samples = continuationSamples(previous rows, n, snapshot) (same origin,
 * first row ON that station). The builder then starts its spine exactly at that
 * station with a warm One Euro cutoff and the carried (synthesised) pressure. The
 * previous piece commits with its rows so far and cut bit 1 (tail is a cut): for such
 * a recipe finish() skips the end flush and keeps exactly the stations that were
 * settled after its last row, so it ends on the very station the snapshot describes
 * (take the snapshot after appending those rows).
 */
import type { Device, NibId, RecipeView, Spine, StrokeRecipe, Calib } from '../core/types';
import { S } from '../core/types';
import { smoothstep } from '../core/num';
import { datan2, PI } from '../core/det';
import { OneEuro, JitterMeter, oneEuroParams } from './stabilize';
import { calibratePressure, synthPressure, SYNTH_P0 } from './calib';
import { nibWidth } from './nibs';
import { weldWidth } from './envelope';
import {
  lerpRow, azAt, rawPressureAt, speedWindow, speedAt, stationFrame, frameFinal, isSynthPressure, firstOk,
  posAtArc, FRAME_HALF, type Frame,
} from './signals';

/** A spine produced by this module: also carries z (sp per doc unit). */
export interface InkSpine extends Spine { z: number }

/** Station spacing (sp). */
export const STATION = 2.4;
/** Knot spacing on the filtered polyline (sp). */
export const KNOT = 2.4;
/** Knots of lookahead before a knot's corner decision is final. */
export const KNOT_AHEAD = 4;
/** Corner: turn above 55° … */
export const CORNER_TURN = (55 * PI) / 180;
/** … measured between points ±4 sp of arc either side … */
export const CORNER_ARM = 4;
/** … while the hand moves slower than 0.25·vMed. */
export const CORNER_SPEED = 0.25;
const CORNER_NMS = 2;          // knots either side a corner must out-turn
const SNAP_HALF = 1.2;         // search ± this arc of F for the true vertex
const SNAP_ARM = 2;            // arm length (sp) of the vertex turning test
const SNAP_MAX = 48;           // F vertices examined at most
const END_MERGE = 0.6;         // a grid station this close to the end is replaced by it
/** Frames within this arc (sp) of a moved station or of the seam are recomputed by the weld. */
export const SEAM_ZONE = 2 * FRAME_HALF;
const FIX_END = 1, FIX_CORNER = 2;

/** snapshot() layout (Float32Array). */
export const enum RESUME { VERSION = 0, S = 1, T = 2, X = 3, Y = 4, Q = 5, NX = 6, NY = 7, P = 8, VN = 9, DX = 10, DY = 11, LENGTH = 12 }

/** Allocate an empty spine with room for `capacity` stations. */
export function createSpine(capacity = 64): InkSpine {
  const c = Math.max(1, capacity | 0);
  return {
    n: 0,
    x: new Float32Array(c), y: new Float32Array(c), s: new Float32Array(c), t: new Float32Array(c),
    p: new Float32Array(c), w: new Float32Array(c), vn: new Float32Array(c), k: new Float32Array(c),
    c: new Float32Array(c), cs: new Float32Array(c), alt: new Float32Array(c), az: new Float32Array(c),
    nx: new Float32Array(c), ny: new Float32Array(c), corner: new Uint8Array(c),
    settled: 0, L: 0, z: 1,
  };
}

function g64(a: Float64Array, need: number): Float64Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 64;
  while (c < need) c *= 2;
  const b = new Float64Array(c); b.set(a); return b;
}
function g32(a: Float32Array, need: number): Float32Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 64;
  while (c < need) c *= 2;
  const b = new Float32Array(c); b.set(a); return b;
}
function g8(a: Uint8Array, need: number): Uint8Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 64;
  while (c < need) c *= 2;
  const b = new Uint8Array(c); b.set(a); return b;
}

/**
 * Live tip state for rise detection (sp relative to origin, ms since down). `travel` is
 * the total travel of the whole stroke: s0 (the earlier pieces of a split stroke) plus
 * this piece's filtered path, so a hold early in a continuation never blooms at s = 0.
 */
export interface Tip { x: number; y: number; s: number; p: number; travel: number; t: number }

/** Incremental spine builder over a recipe or draft. */
export interface SpineBuilder {
  readonly spine: Spine;
  /** Consume sample rows appended to r.samples since the last call; extends stations; advances `settled`. */
  append(): void;
  /**
   * Lift: end flush, lift zones (seated stop, ramp-down), weld if closing. settled = n afterwards.
   * `closed` defaults to the recipe's flag (StrokeRecipe.closed / DraftStroke.closing).
   */
  finish(closed?: boolean): void;
  /** Measured jitter J of this stroke so far (for the learner). */
  jitter(): number;
  /** Serialisable state at the current settled station (for split pieces / resume). */
  snapshot(): Float32Array;
  /** Filtered tip for Rise: position, arc, pressure (synthesised up to `now` for mouse/touch), travel. Reused object. */
  tip(now?: number): Readonly<Tip>;
}

/** Scratch point for knot / F interpolation (single-threaded, never retained). */
const kp = new Float64Array(2);

// ---------------------------------------------------------------- pipeline state (cloneable)

class Pipe {
  // knot sampler
  fi = 0; nk = 0;
  // resolver
  rj = 0;
  // Chaikin rounds
  c1 = false; c1x = 0; c1y = 0; c1q = 0;
  c2 = false; c2x = 0; c2y = 0; c2q = 0;
  // station resampler
  rs = false; px = 0; py = 0; pq = 0; walk = 0; ng = 0;
  pend = false; pIdx = 0; pX = 0; pY = 0; pQ = 0; pA = 0; pCor = false;
  cw = false; cwIdx = 0; cwX = 0; cwY = 0; cwQ = 0; cwA = 0;
  nC = 0; lastA = 0;
  // signals
  settled = 0; pPrev = 0;

  copyFrom(o: Pipe): void {
    this.fi = o.fi; this.nk = o.nk; this.rj = o.rj;
    this.c1 = o.c1; this.c1x = o.c1x; this.c1y = o.c1y; this.c1q = o.c1q;
    this.c2 = o.c2; this.c2x = o.c2x; this.c2y = o.c2y; this.c2q = o.c2q;
    this.rs = o.rs; this.px = o.px; this.py = o.py; this.pq = o.pq; this.walk = o.walk; this.ng = o.ng;
    this.pend = o.pend; this.pIdx = o.pIdx; this.pX = o.pX; this.pY = o.pY; this.pQ = o.pQ; this.pA = o.pA; this.pCor = o.pCor;
    this.cw = o.cw; this.cwIdx = o.cwIdx; this.cwX = o.cwX; this.cwY = o.cwY; this.cwQ = o.cwQ; this.cwA = o.cwA;
    this.nC = o.nC; this.lastA = o.lastA;
    this.settled = o.settled; this.pPrev = o.pPrev;
  }
}

class Builder implements SpineBuilder {
  readonly spine: InkSpine;
  private readonly z: number;
  private readonly s0: number;
  private readonly device: Device;
  private readonly nib: NibId;
  private readonly size: number;
  private readonly calib: Calib;
  private readonly vMed: number;
  private readonly euro: OneEuro;
  private readonly jit: JitterMeter;
  private readonly p0: number;
  private synth = true;
  private lastRawP = NaN;
  private finished = false;
  // end flush timing: points past row flushQ are timed flushT0 + (q − flushQ)·flushDt (ms per row)
  private flushQ = -1; private flushT0 = 0; private flushDt = 0;

  // current sample rows (a draft's array may be replaced as it grows)
  private d: Float32Array = new Float32Array(0);
  private nRows = 0;
  private consumed = 0;

  // F: filtered polyline (sp), one point per sample (+ the end flush point)
  private FX: Float64Array = new Float64Array(256); private FY: Float64Array = new Float64Array(256);
  private FQ: Float64Array = new Float64Array(256); private FT: Float64Array = new Float64Array(256); private FA: Float64Array = new Float64Array(256);
  private nF = 0;
  // knots (append-only; a flush may write one scratch knot at index nk)
  private KX: Float64Array = new Float64Array(64); private KY: Float64Array = new Float64Array(64);
  private KQ: Float64Array = new Float64Array(64); private KT: Float64Array = new Float64Array(64); private KA: Float64Array = new Float64Array(64);
  // committed stations (internal, sp; flushes write scratch stations at ≥ real nC)
  private SX: Float64Array = new Float64Array(64); private SY: Float64Array = new Float64Array(64); private SS: Float64Array = new Float64Array(64);
  private SQ: Float64Array = new Float64Array(64); private ST: Float64Array = new Float64Array(64); private SC: Uint8Array = new Uint8Array(64);

  private readonly real = new Pipe();
  private readonly tmp = new Pipe();
  private readonly fr: Frame = { k: 0, nx: 0, ny: 0 };
  private readonly tipOut: Tip = { x: 0, y: 0, s: 0, p: 0, travel: 0, t: 0 };

  constructor(private readonly r: RecipeView) {
    this.z = r.z > 0 ? r.z : 1;
    this.s0 = r.s0 > 0 ? r.s0 : 0;
    this.device = r.device;
    this.nib = r.stroke.nib;
    this.size = r.stroke.size;
    this.calib = r.calib;
    this.vMed = r.calib.vMed > 0 ? r.calib.vMed : 0.9;
    const { fcMin, beta } = oneEuroParams(r.device, r.calib);
    this.euro = new OneEuro(fcMin, beta);
    this.jit = new JitterMeter(0.5 * this.vMed);
    const res = r.resume;
    const ok = !!res && res.length >= RESUME.LENGTH && res[RESUME.VERSION] === 1;
    this.p0 = ok && res![RESUME.P] === res![RESUME.P] ? res![RESUME.P] : SYNTH_P0;
    if (ok) this.euro.seedVelocity(res![RESUME.DX], res![RESUME.DY]);
    this.real.pPrev = this.p0;
    this.spine = createSpine(64);
    this.spine.z = this.z;
    this.spine.L = this.s0;
  }

  // ---------------------------------------------------------------- intake

  private readRows(): void {
    const s = this.r.samples;
    if (s instanceof Float32Array) { this.d = s; this.nRows = Math.floor(s.length / S.STRIDE); }
    else { this.d = s.data; this.nRows = Math.min(s.n, Math.floor(s.data.length / S.STRIDE)); }
  }

  private pushF(x: number, y: number, q: number, t: number): void {
    const n = this.nF;
    if (n + 1 > this.FX.length) {
      const c = n + 1;
      this.FX = g64(this.FX, c); this.FY = g64(this.FY, c); this.FQ = g64(this.FQ, c);
      this.FT = g64(this.FT, c); this.FA = g64(this.FA, c);
    }
    let a = 0;
    if (n > 0) { const dx = x - this.FX[n - 1], dy = y - this.FY[n - 1]; a = this.FA[n - 1] + Math.sqrt(dx * dx + dy * dy); }
    this.FX[n] = x; this.FY[n] = y; this.FQ[n] = q; this.FT[n] = t; this.FA[n] = a;
    this.nF = n + 1;
  }

  private intake(i: number): void {
    const o = i * S.STRIDE, d = this.d;
    const x = d[o + S.X] * this.z, y = d[o + S.Y] * this.z, t = d[o + S.T];
    if (i === 0) this.synth = isSynthPressure(d, this.nRows);
    // a corrupt row (non-finite position or time) is skipped rather than poisoning the filter
    if (!(x - x === 0 && y - y === 0 && t - t === 0)) return;
    const p = d[o + S.P];
    if (p === p) this.lastRawP = p;
    this.euro.step(x, y, t);
    this.jit.push(x, y, t);
    this.pushF(this.euro.x, this.euro.y, i, t);
  }

  append(): void {
    if (this.finished) return;
    this.readRows();
    if (this.nRows <= this.consumed) return;
    for (let i = this.consumed; i < this.nRows; i++) this.intake(i);
    this.consumed = this.nRows;
    this.advance(this.real, false);
    this.tmp.copyFrom(this.real);
    this.advance(this.tmp, true);
    this.publish(this.tmp.nC);
  }

  finish(closed?: boolean): void {
    if (this.finished) return;
    this.append();
    this.finished = true;
    if (this.r.cut & 2 && this.real.settled > 0) {
      // tail is a cut: the piece ends on its last settled station (its continuation's resume point)
      this.publish(this.real.settled);
      return;
    }
    if (this.nF > 0) {
      // End flush: the raw lift point (the last intact row) joins the filtered path. It is
      // timed one filter time constant τ after the last row: the filtered tip lags the hand
      // by v·τ, so the flush segment keeps the stroke's speed (timing it AT the last row
      // would put several stations at one instant and read v_n as 25–70× vMed there).
      // It carries a fractional row past every intact row (its channels clamp to row li;
      // only its time is extrapolated, see commit()), spaced so that time per row stays
      // that of the last real step: q = li + τ/Δt. In steady motion arc per row matches
      // too (the lag v·τ over τ/Δt rows), so mixing q across the junction (Chaikin)
      // leaves no speed kink.
      const n = this.nF, li = this.FQ[n - 1], o = li * S.STRIDE;
      const x = this.d[o + S.X] * this.z, y = this.d[o + S.Y] * this.z;
      if (x !== this.FX[n - 1] || y !== this.FY[n - 1]) {
        const tau = this.euro.lagMs(), dt = n > 1 ? this.FT[n - 1] - this.FT[n - 2] : 0;
        const span = dt > 0 ? tau / dt : 1;
        this.flushQ = li; this.flushT0 = this.FT[n - 1]; this.flushDt = tau / span;
        this.pushF(x, y, li + span, this.flushT0 + tau);
      }
    }
    this.advance(this.real, true);
    this.real.settled = this.real.nC;
    this.publish(this.real.nC);
    const isClosed = closed ?? ('closing' in this.r ? this.r.closing : this.r.closed);
    if (isClosed) weldSpine(this.spine, this.z);
    this.spine.settled = this.spine.n;
  }

  jitter(): number { return this.jit.value(); }

  // ---------------------------------------------------------------- stages

  private advance(P: Pipe, end: boolean): void {
    this.knots(P, end);
    this.resolve(P, end);
    if (end) this.resampleEnd(P);
    this.signals(P, end);
  }

  private emitKnot(P: Pipe, x: number, y: number, q: number, t: number, a: number): void {
    const j = P.nk;
    if (j + 1 > this.KX.length) {
      const c = j + 1;
      this.KX = g64(this.KX, c); this.KY = g64(this.KY, c); this.KQ = g64(this.KQ, c);
      this.KT = g64(this.KT, c); this.KA = g64(this.KA, c);
    }
    this.KX[j] = x; this.KY[j] = y; this.KQ[j] = q; this.KT[j] = t; this.KA[j] = a;
    P.nk = j + 1;
  }

  /** Knots at every 2.4 sp of F arc; at end-of-stream, a final knot at F's last point. */
  private knots(P: Pipe, end: boolean): void {
    const FX = this.FX, FY = this.FY, FQ = this.FQ, FT = this.FT, FA = this.FA;
    for (; P.fi < this.nF; P.fi++) {
      const i = P.fi;
      if (i === 0) { if (P.nk === 0) this.emitKnot(P, FX[0], FY[0], FQ[0], FT[0], 0); continue; }
      const a0 = FA[i - 1], a1 = FA[i];
      for (let g = P.nk * KNOT; g <= a1; g = P.nk * KNOT) {
        const f = a1 > a0 ? (g - a0) / (a1 - a0) : 1;
        this.emitKnot(P, FX[i - 1] + (FX[i] - FX[i - 1]) * f, FY[i - 1] + (FY[i] - FY[i - 1]) * f,
          FQ[i - 1] + (FQ[i] - FQ[i - 1]) * f, FT[i - 1] + (FT[i] - FT[i - 1]) * f, g);
      }
    }
    if (end && this.nF > 0 && P.nk > 0) {
      const l = this.nF - 1;
      if (FA[l] - this.KA[P.nk - 1] > 1e-9) this.emitKnot(P, FX[l], FY[l], FQ[l], FT[l], FA[l]);
    }
  }

  /** Position at fractional knot index u (clamped to [0, last]) into kp. */
  private knotAt(u: number, last: number): void {
    if (u <= 0) { kp[0] = this.KX[0]; kp[1] = this.KY[0]; return; }
    if (u >= last) { kp[0] = this.KX[last]; kp[1] = this.KY[last]; return; }
    const i = Math.floor(u), f = u - i;
    kp[0] = this.KX[i] + (this.KX[i + 1] - this.KX[i]) * f;
    kp[1] = this.KY[i] + (this.KY[i + 1] - this.KY[i]) * f;
  }

  /** Unsigned turn (rad) at knot m within ±4 sp; 0 when an arm is shorter than 0.5 sp. */
  private knotTurn(m: number, last: number): number {
    const h = CORNER_ARM / KNOT;
    const x = this.KX[m], y = this.KY[m];
    this.knotAt(m - h, last);
    const ax = x - kp[0], ay = y - kp[1];
    this.knotAt(m + h, last);
    const bx = kp[0] - x, by = kp[1] - y;
    if (ax * ax + ay * ay < 0.25 || bx * bx + by * by < 0.25) return 0;
    return datan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
  }

  private isCorner(j: number, last: number): boolean {
    const tj = this.knotTurn(j, last);
    if (!(tj > CORNER_TURN)) return false;
    const k = speedWindow(this.KT, j, last, false);
    if (!(speedAt(this.KA, this.KT, j, k, last) < CORNER_SPEED * this.vMed)) return false;
    for (let m = Math.max(0, j - CORNER_NMS); m <= Math.min(last, j + CORNER_NMS); m++) {
      if (m === j) continue;
      const tm = this.knotTurn(m, last);
      if (m < j ? tm >= tj : tm > tj) return false;
    }
    return true;
  }

  /** Position on F at arc a (clamped), into kp. */
  private fAt(a: number): void {
    const FA = this.FA, l = this.nF - 1;
    if (a <= 0 || l <= 0) { kp[0] = this.FX[0]; kp[1] = this.FY[0]; return; }
    if (a >= FA[l]) { kp[0] = this.FX[l]; kp[1] = this.FY[l]; return; }
    let lo = 0, hi = l;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (FA[m] <= a) lo = m; else hi = m; }
    const ds = FA[hi] - FA[lo], f = ds > 0 ? (a - FA[lo]) / ds : 0;
    kp[0] = this.FX[lo] + (this.FX[hi] - this.FX[lo]) * f;
    kp[1] = this.FY[lo] + (this.FY[hi] - this.FY[lo]) * f;
  }

  /** Index of the true vertex near knot j on F (max turning within ±1.2 sp), or -1. */
  private snapVertex(j: number): number {
    const FA = this.FA, l = this.nF - 1, a = this.KA[j];
    let lo = 0, hi = l + 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (FA[m] < a - SNAP_HALF) lo = m + 1; else hi = m; }
    const i0 = lo;
    let i1 = i0;
    while (i1 + 1 <= l && FA[i1 + 1] <= a + SNAP_HALF) i1++;
    if (i0 > l || FA[i0] > a + SNAP_HALF) return -1;
    const step = Math.max(1, Math.ceil((i1 - i0 + 1) / SNAP_MAX));
    let best = -1, bt = -1;
    for (let m = i0; m <= i1; m += step) {
      const x = this.FX[m], y = this.FY[m];
      this.fAt(FA[m] - SNAP_ARM);
      const ax = x - kp[0], ay = y - kp[1];
      this.fAt(FA[m] + SNAP_ARM);
      const bx = kp[0] - x, by = kp[1] - y;
      if (ax * ax + ay * ay < 0.09 || bx * bx + by * by < 0.09) continue;
      const t = datan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
      if (t > bt) { bt = t; best = m; }
    }
    return best;
  }

  /** Resolve knots whose 4-knot lookahead exists (all of them at end-of-stream). */
  private resolve(P: Pipe, end: boolean): void {
    const last = P.nk - 1;
    for (; P.rj <= last; P.rj++) {
      const j = P.rj;
      if (!end && j + KNOT_AHEAD > last) break;
      let x = this.KX[j], y = this.KY[j], q = this.KQ[j], flag = 0;
      if (j === 0 || (end && j === last)) flag = FIX_END;
      else if (this.isCorner(j, last)) {
        flag = FIX_CORNER;
        const m = this.snapVertex(j);
        if (m >= 0) { x = this.FX[m]; y = this.FY[m]; q = this.FQ[m]; }
      }
      this.chaikin1(P, x, y, q, flag);
    }
  }

  private chaikin1(P: Pipe, x: number, y: number, q: number, flag: number): void {
    if (P.c1) {
      this.chaikin2(P, 0.75 * P.c1x + 0.25 * x, 0.75 * P.c1y + 0.25 * y, 0.75 * P.c1q + 0.25 * q, 0);
      this.chaikin2(P, 0.25 * P.c1x + 0.75 * x, 0.25 * P.c1y + 0.75 * y, 0.25 * P.c1q + 0.75 * q, 0);
    }
    if (flag) this.chaikin2(P, x, y, q, flag);
    P.c1 = true; P.c1x = x; P.c1y = y; P.c1q = q;
  }

  private chaikin2(P: Pipe, x: number, y: number, q: number, flag: number): void {
    if (P.c2) {
      this.resample(P, 0.75 * P.c2x + 0.25 * x, 0.75 * P.c2y + 0.25 * y, 0.75 * P.c2q + 0.25 * q, 0);
      this.resample(P, 0.25 * P.c2x + 0.75 * x, 0.25 * P.c2y + 0.75 * y, 0.25 * P.c2q + 0.75 * q, 0);
    }
    if (flag) this.resample(P, x, y, q, flag);
    P.c2 = true; P.c2x = x; P.c2y = y; P.c2q = q;
  }

  private commit(P: Pipe, x: number, y: number, q: number, a: number, corner: boolean): void {
    const i = P.nC;
    if (i + 1 > this.SX.length) {
      const c = i + 1;
      this.SX = g64(this.SX, c); this.SY = g64(this.SY, c); this.SS = g64(this.SS, c);
      this.SQ = g64(this.SQ, c); this.ST = g64(this.ST, c); this.SC = g8(this.SC, c);
    }
    this.SX[i] = x; this.SY[i] = y; this.SS[i] = a; this.SQ[i] = q;
    this.ST[i] = this.flushQ >= 0 && q > this.flushQ
      ? this.flushT0 + (q - this.flushQ) * this.flushDt
      : lerpRow(this.d, this.nRows, q, S.T);
    this.SC[i] = corner ? 1 : 0;
    P.nC = i + 1; P.lastA = a;
  }

  private commitPending(P: Pipe): void {
    this.commit(P, P.pX, P.pY, P.pQ, P.pA, P.pCor);
    P.pend = false;
  }

  private candidate(P: Pipe, gi: number, x: number, y: number, q: number, a: number): void {
    if (P.pend) this.commitPending(P);
    P.pend = true; P.pIdx = gi; P.pCor = false;
    if (P.cw && P.cwIdx === gi) {
      P.pX = P.cwX; P.pY = P.cwY; P.pQ = P.cwQ; P.pA = P.cwA; P.pCor = true; P.cw = false;
    } else { P.pX = x; P.pY = y; P.pQ = q; P.pA = a; }
    P.ng = gi + 1;
  }

  /** Stations every 2.4 sp of arc; each corner captures its nearest station. */
  private resample(P: Pipe, x: number, y: number, q: number, flag: number): void {
    if (!P.rs) {
      P.rs = true; P.px = x; P.py = y; P.pq = q; P.walk = 0;
      this.candidate(P, 0, x, y, q, 0);
      return;
    }
    const dx = x - P.px, dy = y - P.py, d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) {
      for (let g = P.ng * STATION; g <= P.walk + d; g = P.ng * STATION) {
        const f = (g - P.walk) / d;
        this.candidate(P, P.ng, P.px + dx * f, P.py + dy * f, P.pq + (q - P.pq) * f, g);
      }
      P.walk += d;
    }
    P.px = x; P.py = y; P.pq = q;
    if (flag & FIX_CORNER) {
      const m = Math.round(P.walk / STATION);
      if (P.pend && P.pIdx === m) {
        P.pX = x; P.pY = y; P.pQ = q; P.pA = P.walk; P.pCor = true;
      } else if (m >= P.ng) {
        P.cw = true; P.cwIdx = m; P.cwX = x; P.cwY = y; P.cwQ = q; P.cwA = P.walk;
      }
    }
    // no corner arriving at arc ≥ walk can target the pending station any more
    if (P.pend && Math.round(P.walk / STATION) > P.pIdx) this.commitPending(P);
  }

  private resampleEnd(P: Pipe): void {
    if (!P.rs) return;
    const endA = P.walk;
    if (P.pend) {
      if (!P.pCor && P.pIdx > 0 && endA - P.pA < END_MERGE) P.pend = false;
      else this.commitPending(P);
    }
    if (P.cw) {
      if (endA - P.cwA >= END_MERGE && P.cwA - P.lastA >= END_MERGE) this.commit(P, P.cwX, P.cwY, P.cwQ, P.cwA, true);
      P.cw = false;
    }
    if (P.nC === 0 || endA - P.lastA > 1e-9) this.commit(P, P.px, P.py, P.pq, endA, false);
  }

  /** Per-station signals; in stream mode only for stations whose windows are final. */
  private signals(P: Pipe, end: boolean): void {
    const last = P.nC - 1;
    if (last < 0) return;
    this.ensureSpine(P.nC);
    for (; P.settled <= last; P.settled++) {
      const i = P.settled;
      let k: number;
      if (end) k = speedWindow(this.ST, i, last, false);
      else {
        if (!frameFinal(this.SS, i, last)) break;
        k = speedWindow(this.ST, i, last, true);
        if (k < 0) break;
      }
      this.station(P, i, k, last);
    }
  }

  private station(P: Pipe, i: number, k: number, last: number): void {
    const sp = this.spine, d = this.d, n = this.nRows, z = this.z, q = this.SQ[i];
    const fr = stationFrame(this.SX, this.SY, this.SS, i, 0, last, false, this.fr);
    const vn = speedAt(this.SS, this.ST, i, k, last) / this.vMed;
    let p: number;
    if (this.synth) {
      p = i === 0 ? this.p0 : synthPressure(P.pPrev, vn, this.ST[i] - this.ST[i - 1]);
      P.pPrev = p;
    } else {
      p = calibratePressure(rawPressureAt(d, n, q, this.lastRawP), this.calib);
    }
    const c = lerpRow(d, n, q, S.C), cs = lerpRow(d, n, q, S.CS), alt = lerpRow(d, n, q, S.ALT);
    sp.x[i] = this.SX[i] / z; sp.y[i] = this.SY[i] / z;
    sp.s[i] = this.s0 + this.SS[i];
    sp.t[i] = this.ST[i];
    sp.p[i] = p;
    sp.w[i] = nibWidth(this.nib, this.size, p, vn, this.device, alt) / z;
    sp.vn[i] = vn;
    sp.k[i] = fr.k; sp.nx[i] = fr.nx; sp.ny[i] = fr.ny;
    sp.c[i] = c === c ? c : 0; sp.cs[i] = cs === cs ? cs : 0;
    sp.alt[i] = alt === alt ? alt : PI / 2;
    sp.az[i] = azAt(d, n, q);
    sp.corner[i] = this.SC[i];
  }

  private ensureSpine(n: number): void {
    const sp = this.spine;
    if (n <= sp.x.length) return;
    sp.x = g32(sp.x, n); sp.y = g32(sp.y, n); sp.s = g32(sp.s, n); sp.t = g32(sp.t, n);
    sp.p = g32(sp.p, n); sp.w = g32(sp.w, n); sp.vn = g32(sp.vn, n); sp.k = g32(sp.k, n);
    sp.c = g32(sp.c, n); sp.cs = g32(sp.cs, n); sp.alt = g32(sp.alt, n); sp.az = g32(sp.az, n);
    sp.nx = g32(sp.nx, n); sp.ny = g32(sp.ny, n); sp.corner = g8(sp.corner, n);
  }

  private publish(n: number): void {
    const sp = this.spine;
    sp.n = n;
    sp.settled = this.real.settled;
    sp.L = n > 0 ? sp.s[n - 1] : this.s0;
  }

  // ---------------------------------------------------------------- split pieces & tip

  snapshot(): Float32Array {
    const out = new Float32Array(RESUME.LENGTH);
    const sp = this.spine, m = sp.settled - 1;
    out[RESUME.VERSION] = 1;
    if (m >= 0) {
      out[RESUME.S] = sp.s[m]; out[RESUME.T] = sp.t[m];
      out[RESUME.X] = sp.x[m]; out[RESUME.Y] = sp.y[m]; out[RESUME.Q] = this.SQ[m];
      out[RESUME.NX] = sp.nx[m]; out[RESUME.NY] = sp.ny[m];
      out[RESUME.P] = sp.p[m]; out[RESUME.VN] = sp.vn[m];
    } else {
      // nothing settled yet: the first intact row
      const d = this.d, f = firstOk(d, this.nRows), o = f * S.STRIDE;
      out[RESUME.S] = this.s0; out[RESUME.T] = f >= 0 ? d[o + S.T] : 0;
      out[RESUME.X] = f >= 0 ? d[o + S.X] : 0; out[RESUME.Y] = f >= 0 ? d[o + S.Y] : 0; out[RESUME.Q] = f > 0 ? f : 0;
      out[RESUME.NX] = 0; out[RESUME.NY] = -1; out[RESUME.P] = this.p0; out[RESUME.VN] = 0;
    }
    out[RESUME.DX] = this.euro.dx; out[RESUME.DY] = this.euro.dy;
    return out;
  }

  tip(now?: number): Readonly<Tip> {
    const o = this.tipOut, sp = this.spine, nF = this.nF;
    if (nF === 0) { o.x = o.y = 0; o.travel = o.s = this.s0; o.p = this.p0; o.t = 0; return o; }
    const tl = this.FT[nF - 1];
    const t = now !== undefined && now > tl ? now : tl;
    o.x = this.FX[nF - 1]; o.y = this.FY[nF - 1];
    o.s = sp.L; o.travel = this.s0 + this.FA[nF - 1]; o.t = t;
    if (!this.synth) { o.p = calibratePressure(this.lastRawP, this.calib); return o; }
    // trailing speed over 40 ms on the given clock: a still mouse sends no rows
    const tA = t - 40;
    let i = nF - 1;
    while (i > 0 && this.FT[i - 1] >= tA) i--;
    let aA = this.FA[i];
    if (i > 0 && this.FT[i] > tA) {
      const t0 = this.FT[i - 1], t1 = this.FT[i];
      aA = this.FA[i - 1] + (this.FA[i] - this.FA[i - 1]) * (t1 > t0 ? (tA - t0) / (t1 - t0) : 1);
    }
    const span = t - Math.max(tA, this.FT[0]);
    const vn = span > 0 ? (this.FA[nF - 1] - aA) / span / this.vMed : 0;
    const n = sp.n;
    o.p = n > 0 ? synthPressure(sp.p[n - 1], vn, t - sp.t[n - 1]) : this.p0;
    return o;
  }
}

const wf: Frame = { k: 0, nx: 0, ny: 0 };
const wa = new Float64Array(2), wb = new Float64Array(2);

/** Unit chord direction from arc a to arc b on a spine's stations, into out (false if degenerate). */
function chordDir(sp: Spine, a: number, b: number, out: Float64Array): boolean {
  const last = sp.n - 1;
  posAtArc(sp.x, sp.y, sp.s, 0, last, a, wa);
  posAtArc(sp.x, sp.y, sp.s, 0, last, b, wb);
  const dx = wb[0] - wa[0], dy = wb[1] - wa[1], l = Math.sqrt(dx * dx + dy * dy);
  if (!(l > 1e-12)) return false;
  out[0] = dx / l; out[1] = dy / l;
  return true;
}
const tS = new Float64Array(2), tE = new Float64Array(2);

/**
 * Seam weld of a closed loop, in place (finish() runs exactly this on its spine; a live
 * preview can run it on a copy). Stations within the last W = weldWidth(len, gap) sp are
 * displaced by a cubic Hermite blend over u = (s − (L − W))/W:
 *   D(u) = gap·(3u² − 2u³) + W·k·(t_start − t_end)·(u³ − u²)
 * so the tail leaves its path smoothly (D = D' = 0 at u = 0), lands exactly on the first
 * station, and arrives with the start's direction (D' = t_start − t_end at u = 1): the
 * seam has no kink. k fades the direction match out between 30° and 60° of mismatch, so
 * a deliberately pointed loop keeps its point. nx/ny/k are then recomputed cyclically
 * within SEAM_ZONE of the moved stations and of the start. Returns the first moved
 * station (n when nothing moved).
 */
export function weldSpine(sp: Spine, z: number): number {
  const n = sp.n, last = n - 1;
  if (n < 3) return n;
  const X = sp.x, Y = sp.y, Sa = sp.s;
  const len = Sa[last] - Sa[0];
  const gx = X[0] - X[last], gy = Y[0] - Y[last];
  const W = weldWidth(len, Math.sqrt(gx * gx + gy * gy) * z);
  if (!(W > 0) || len < 4 * FRAME_HALF) return n;
  const a0 = Sa[last] - W;
  // end and start directions over FRAME_HALF of arc, before anything moves
  let cx = 0, cy = 0;
  if (chordDir(sp, Sa[last] - FRAME_HALF, Sa[last], tE) && chordDir(sp, Sa[0], Sa[0] + FRAME_HALF, tS)) {
    const k = smoothstep(0.5, 0.8660254037844386, tE[0] * tS[0] + tE[1] * tS[1]); // cos 60° → cos 30°
    const m = (W / z) * k;
    cx = (tS[0] - tE[0]) * m; cy = (tS[1] - tE[1]) * m;
  }
  let first = last;
  for (let i = last; i > 0 && Sa[i] > a0; i--) {
    const u = (Sa[i] - a0) / W, h = u * u * (3 - 2 * u), g = u * u * (u - 1);
    X[i] += gx * h + cx * g; Y[i] += gy * h + cy * g;
    first = i;
  }
  X[last] = X[0]; Y[last] = Y[0];
  for (let i = 0; i <= last; i++) {
    if (Sa[i] < a0 - SEAM_ZONE && Sa[i] > Sa[0] + SEAM_ZONE) continue;
    stationFrame(X, Y, Sa, i, 0, last, true, wf);
    sp.k[i] = wf.k; sp.nx[i] = wf.nx; sp.ny[i] = wf.ny;
  }
  return first;
}

/** Builder over a recipe (all rows at once) or a draft (rows grow; call append() after each batch). */
export function createSpineBuilder(r: RecipeView): SpineBuilder {
  return new Builder(r);
}

/** Convenience: full build of a committed recipe (≡ builder + append + finish). */
export function buildSpine(r: StrokeRecipe): Spine {
  const b = new Builder(r);
  b.append();
  b.finish();
  return b.spine;
}

/**
 * Sample rows for a split continuation from a snapshot: the first row sits exactly
 * on the snapshot station (its x/y, t, and the other channels interpolated at its
 * fractional row q, azimuth the short way round), followed by rows ⌊q⌋+1 … end.
 * Positions stay relative to the same origin, so the continuation's spine starts on
 * the previous piece's last settled station.
 */
export function continuationSamples(samples: Float32Array, rows: number, snap: Float32Array): Float32Array {
  const n = Math.min(rows, Math.floor(samples.length / S.STRIDE));
  if (n === 0) return new Float32Array(0);
  const q = snap[RESUME.Q];
  const qc = q > 0 ? (q < n - 1 ? q : n - 1) : 0;
  const i0 = Math.floor(qc);
  const out = new Float32Array((n - i0) * S.STRIDE);
  for (let c = 0; c < S.STRIDE; c++) out[c] = c === S.AZ ? azAt(samples, n, qc) : lerpRow(samples, n, qc, c as S);
  out[S.X] = snap[RESUME.X]; out[S.Y] = snap[RESUME.Y]; out[S.T] = snap[RESUME.T];
  out.set(samples.subarray((i0 + 1) * S.STRIDE, n * S.STRIDE), S.STRIDE);
  return out;
}
