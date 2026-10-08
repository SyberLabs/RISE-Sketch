/**
 * Ripple (lab prototype, 'ripple' slot v107): interference moiré contours (DESIGN §2.3.7).
 *
 * The stroke is a ridge on a survey map, or a line dropped into still water: contour rings run
 * parallel to it on both sides, ever wider apart outward, and wrap the open ends in round caps.
 * Each ring breathes along the arc (a slow sine whose phase lags ring by ring, so density waves
 * sweep outward like a 60s op-art poster), alternates bright / faint and deepens in tone
 * outward. Rings of neighbouring strokes (and of the stroke's own distant parts) cross at
 * slight angles and beat into moiré: on Night the crossings add into interference fringes,
 * on Paper the field reads as survey-map contours.
 *
 *   b(s)   = 1.2·w̄ + 3 sp                     w̄ = nib width (sp), tent-averaged over ±12 sp
 *   δ_k(s) = b·1.18^(k−1)·A_σ·(1 + a·sin(2πs/λ − 0.35k)) + n_k·ν_kσ(s)     ring k = 1..10, side σ = ±1
 *   a      = 0.07 + 0.2·smoothstep(0.4, 2.2, v̄n)    ≤ 0.27 < 0.18/|1.18e^(−0.35i) − 1| = 0.43: rings never cross
 *   λ      = 32 + 2.5S sp;  n_k = min(0.4k, 0.1·gap_k), gap_k = b(1.18^(k−1) − 1.18^(k−2));  ν = value noise (14 sp)
 *   A_σ    = (1 + 0.35σ·tilt_n)(1 − 0.3·max(0, σ·cs))     lean spreads one side, side ink packs it
 *   K(D)   = 2·D·(0.6 + 0.8p);  ring k weight f_k = clamp(K − k + 1, 0, 1)
 *
 * Ring points ride the spine position plus the station normals tent-averaged over
 * clamp(0.25δ_k, 2.4, 12) sp, so outer rings follow a smoother frame and never amplify jitter.
 *
 * Unit j = 12 sp of arc [s_j, s_j + 12] (s_j = s0 + 12j). Ring points sit at arcs s_j + 2m
 * (subdivided where a ring's chord exceeds 3 sp, e.g. outside a corner); every ring point is a
 * pure function of its arc, so neighbouring units share their joint point bit for bit. Cleanup
 * (the spec's "drop points within 0.9δ of the seed"): a point's width × smoothstep(0.965, 0.995,
 * q/δ), q = distance to the spine stations within ±40 sp; points at 0 are dropped (the ring
 * splits into runs), so inside a corner the rings of both legs meet in clean mitred V's. Inward
 * rings collapse: × smoothstep(0.97, 0.8, δ|κ̄|) on the concave side. A unit reads the spine on
 * [s_j − 40, s_j + 52] (halfWin 52).
 *
 * Depth: ring k's runs are drawn as a dash centred in the unit, of fraction f_k of its span, at
 * alpha × f_k: a new ring arrives as a dashed contour whose dashes lengthen until they join, so
 * depth is continuous and rising never re-cooks (each unit is cooked once at its ceiling).
 *
 * Ends: on an open stroke the first unit wraps every ring round the head and, at finish, the
 * last unit round the tail (two quarter caps per ring meeting at a shared apex; each a prefix of
 * f_k from its joint). A live-cooked first unit always has its head cap: if the stroke closes,
 * the weld zone re-cooks it without one, so cook ≡ finish stays exact under closure flicker.
 * A closed loop has no caps: units within 40 sp of L ramp each ring point toward that ring's
 * start point at s0 (inside the 56 sp weld zone, so re-cooked at finish): every ring joins itself.
 *
 * Night / Paper: alpha min(1, 0.95·0.93^(k−1)·(even rings 0.6)·(0.6 + 0.5p)·glow(c))·f_k; tone bucket
 * min(k, 4), then alternating 3 / 4 (Spectral shimmers ring by ring). Width (op-art duty):
 * max(clamp(0.05w̄ + 0.4, 0.45, 1.1), min(0.38·gap_k, 3.2)) sp, even rings × 0.7, so inner
 * rings are hairlines and outer rings bands; × (0.6 + 0.4·E_in) (the entry taper only thins the
 * field). Polys of different units never weld at tessellation (gen ≥ 1 needs the same unit), so
 * the width pinches to 0.6× within 2 sp of every joint to keep the overlapping round ends from
 * double-exposing into a dot on Night.
 *
 * Tap: a bullseye of K(D) evenly spaced rings (b + (k − 1)·0.42b, b from max(w, 0.6S)), each a
 * five-lobed wobble, grown as an arc centred on a golden-angle phase; a second family of the
 * same rings round a centre 1.6 gaps away fades in over D ∈ [0.5, 2] with the opposite wobble,
 * so the two beat into moiré fringes. Its rotation is the only use of rng outside the noise.
 *
 * Decisions vs DESIGN §2.3.7 (rings round(1.4d), δ_i = (1.2w̄ + 3)·1.22^i, noise 0.4i, Chaikin):
 * δ_i is read as ring i's offset (read as a cumulative spacing, 10 rings would sit 245 sp out);
 * growth 1.18 and K = 2D(0.6 + 0.8p) rather than 1.22 and 1.4D (base 2 showed a thin 2–3 ring
 * tube; pressure now adds rings); the spatial-hash cleanup is a local soft fade (exact under
 * chunking); no Chaikin pass (rings are analytic offset curves sampled at 2 sp plus chord
 * subdivision); noise capped by the ring gap; reach 52, not 24 (the cleanup must see across a
 * corner); the modulation and the duty widths are the psychedelic layer the spec leaves open.
 */
import { PolyKind } from '../../src/core/types';
import { rnd, Ch, dcos, dsin, PI, TAU } from '../../src/core/det';
import { clamp, smoothstep } from '../../src/core/num';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from '../../src/ink/operators/types';
import { UnitGeom, toneOf, glow } from '../../src/ink/operators/types';
import { RADIAL_ID } from '../../src/ink/operators/line.v1';
import type { LabFormMeta } from './harness';

export const meta: LabFormMeta = {
  name: 'Ripple',
  v: 107,
  ink: 'spectral',
  notes: 'Interference contours: hairline rings parallel to the stroke, widening outward, breathing in slow sine waves that lag ring by ring; neighbouring rings beat into moiré. Speed = wobble, pressure = more and brighter rings, lean = one side spreads, hold = rings bloom outward, loop = rings shrink inward until they collapse, tap = bullseye with interference fringes.',
};

/** Depth range, the most rings, rings per depth level, ring growth ratio. */
const DMAX = 6, NR = 10, PER_LEVEL = 2, GROW = 1.18;
/** Unit arc (sp), lattice step (sp), cleanup window (sp); halfWin = SPAN + WIN. */
const SPAN = 12, H = 2, WIN = 40, HALF_WIN = SPAN + WIN;
/** Chord (sp) above which a ring segment is subdivided, and the most subdivisions; cap chord (sp). */
const CHORD = 3, SUB_MAX = 10, CAP_CHORD = 3;
/** Budgets: points per unit at its ceiling, causal points per stroke. */
const UNIT_BUDGET = 640, STROKE_BUDGET = 16000;
/** Averaging half-window (sp) of width, speed and curvature. */
const MEAN_WIN = 12;
/** Modulation: amplitude at rest and added at speed (sum 0.27 < 0.43 keeps rings ordered), phase lag per ring (rad). */
const A0 = 0.07, A1 = 0.2, PSI = 0.35;
/** Noise: cell (sp), amplitude per ring (sp), cap as a fraction of the gap below the ring. */
const NOISE_H = 14, NOISE_K = 0.4, NOISE_GAP = 0.1, NOISE_ADDR = 0x5100;
/** Lean spread and side-ink packing of a side's rings. */
const LEAN = 0.35, CROWD = 0.3;
/** Cleanup fade on q/δ, inward collapse fade on δ·|κ̄|. */
const CLEAR_LO = 0.965, CLEAR_HI = 0.995, COLLAPSE_LO = 0.8, COLLAPSE_HI = 0.97;
/** Closed loops: offsets ramp to the head's over this arc (sp) before L (< the 56 sp weld zone). */
const SEAM_RAMP = 40;
/** Alpha: base, fade per ring, even-ring factor; even-ring width factor. */
const ALPHA = 0.95, FADE = 0.93, EVEN = 0.6, EVEN_W = 0.7;
/** Op-art duty: ring width as a fraction of the gap below it, at least the hairline wr, at most W_MAX sp. */
const DUTY = 0.38, W_MAX = 3.2;
/** Width at a joint and the arc (sp) over which it eases back. */
const PINCH = 0.6, PINCH_LEN = 2;
/** Tap: ring gap as a fraction of b, second family offset (gaps), wobble lobes and amplitude. */
const TAP_GAP = 0.42, TAP_OFF = 1.6, TAP_LOBES = 5, TAP_WOB = 0.035, GOLDEN = 2.399963229728653;

/** 1.18^(k−1) for k = 0..NR (k = 0 is the gap reference below ring 1). */
const GP = new Float64Array(NR + 1);
GP[0] = 1 / GROW; GP[1] = 1;
for (let k = 2; k <= NR; k++) GP[k] = GP[k - 1] * GROW;

/** Rings drawn at depth D and pressure p (fractional). */
export function ringsAt(D: number, p: number): number { return PER_LEVEL * D * (0.6 + 0.8 * p); }
/** Base offset b (sp) of a nib width (sp). */
export const baseOffset = (wsp: number): number => 1.2 * wsp + 3;
/** Modulation wavelength (sp) of a nib size. */
const lambdaOf = (S: number): number => 32 + 2.5 * S;
/** Ring alpha before f_k. */
export function ringAlpha(k: number, p: number, c: number): number {
  let a = ALPHA * ((k & 1) ? 1 : EVEN) * (0.6 + 0.5 * p) * glow(c);
  for (let i = 1; i < k; i++) a *= FADE;
  return a < 1 ? a : 1;
}
/** Tone bucket of ring k: 1..4, then alternating 3 / 4 (shimmer). */
export const ringBucket = (k: number): number => (k <= 4 ? k : 4 - ((k - 4) & 1));

/** What a ring point needs to know about the spine at one arc. */
class Facts { s = 0; x = 0; y = 0; nx = 0; ny = -1; b = 0; a = 0; kb = 0; asP = 1; asM = 1; th = 0; wr = 0 }
const V2 = new Float64Array(2), N2 = new Float64Array(2);

function facts(cx: FormCx, s: number, F: Facts): void {
  const sp = cx.sp, at = cx.at, z = cx.z, r = cx.r;
  at.pos(s, V2); at.normal(s, N2);
  F.s = s; F.x = V2[0]; F.y = V2[1]; F.nx = N2[0]; F.ny = N2[1];
  const wsp = tent(cx, sp.w, s, MEAN_WIN) * z;
  F.b = baseOffset(wsp);
  F.wr = clamp(0.05 * wsp + 0.4, 0.45, 1.1);
  F.a = A0 + A1 * smoothstep(0.4, 2.2, tent(cx, sp.vn, s, MEAN_WIN));
  F.kb = tent(cx, sp.k, s, MEAN_WIN);
  const cs = clamp(at.at(sp.cs, s), -1, 1);
  let tn = 0;
  if (r.device === 'pen') {
    const ca = dcos(at.at(sp.alt, s)), wt = smoothstep(0.1, 0.3, ca);
    if (wt > 0) { const az = at.angle(sp.az, s); tn = clamp(wt * ca * (dcos(az) * F.nx + dsin(az) * F.ny), -1, 1); }
  }
  F.asP = (1 + LEAN * tn) * (1 - CROWD * (cs > 0 ? cs : 0));
  F.asM = (1 - LEAN * tn) * (1 - CROWD * (cs < 0 ? -cs : 0));
  F.th = (TAU * s) / lambdaOf(r.stroke.size);
}

/**
 * Tent-weighted mean of a station field over arcs [s − R, s + R] (stations ≤ the readable
 * watermark): continuous in s, unlike a boxcar mean, so offsets far from the spine never step
 * when a station enters the window. Falls back to the interpolated value.
 */
function tent(cx: FormCx, a: ArrayLike<number>, s: number, R: number): number {
  const S = cx.sp.s, hi = cx.at.hi, lo = s - R;
  let l = 0, h = hi + 1;
  while (l < h) { const m = (l + h) >> 1; if (S[m] <= lo) l = m + 1; else h = m; }
  let sum = 0, ws = 0;
  for (let i = l; i <= hi; i++) {
    const d = S[i] - s;
    if (d >= R) break;
    const w = 1 - (d < 0 ? -d : d) / R;
    sum += w * a[i]; ws += w;
  }
  return ws > 0 ? sum / ws : cx.at.at(a, s);
}

/** Ring normal: station normals tent-averaged over R = clamp(0.25·δ, 2.4, 12) sp (outer rings ride a smoother frame). */
let RNX = 0, RNY = -1;
function ringNormal(cx: FormCx, F: Facts, k: number): void {
  const R = clamp(0.25 * F.b * GP[k], 2.4, 12);
  let x = tent(cx, cx.sp.nx, F.s, R), y = tent(cx, cx.sp.ny, F.s, R);
  const m = Math.sqrt(x * x + y * y);
  if (m > 1e-6) { x /= m; y /= m; } else { x = F.nx; y = F.ny; }
  RNX = x; RNY = y;
}

/** Smooth value noise in [−1, 1] on absolute arc, one stream per ring side. */
function noise(seed: number, k: number, side: number, s: number): number {
  const u = s / NOISE_H, i = Math.floor(u), t = u - i, e = t * t * (3 - 2 * t);
  const addr = NOISE_ADDR + 2 * k + (side > 0 ? 1 : 0);
  const a = rnd(seed, Ch.Geometry, addr, i), b = rnd(seed, Ch.Geometry, addr, i + 1);
  return 2 * (a + (b - a) * e) - 1;
}

/** Offset magnitude (sp) of ring k on side σ at the facts' arc. */
function off(F: Facts, k: number, side: number, seed: number): number {
  const base = F.b * GP[k] * (side > 0 ? F.asP : F.asM);
  const n = Math.min(NOISE_K * k, NOISE_GAP * F.b * (GP[k] - GP[k - 1]));
  return base * (1 + F.a * dsin(F.th - k * PSI)) + n * noise(seed, k, side, F.s);
}

/** Distance (doc) from (x, y) to the nearest spine station with arc in [s − WIN, s + WIN]. */
function clearance(cx: FormCx, x: number, y: number, s: number): number {
  const S = cx.sp.s, X = cx.sp.x, Y = cx.sp.y, hi = cx.at.hi, lo = s - WIN, up = s + WIN;
  let l = 0, h = hi + 1;
  while (l < h) { const m = (l + h) >> 1; if (S[m] < lo) l = m + 1; else h = m; }
  let best = Infinity;
  for (let i = l; i <= hi && S[i] <= up; i++) {
    const dx = X[i] - x, dy = Y[i] - y, d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Closed-loop seam: per (ring, side) position correction (doc), ramped in over the last SEAM_RAMP sp. */
const SEAM_X = new Float64Array(2 * (NR + 1)), SEAM_Y = new Float64Array(2 * (NR + 1));
let seamOn = false, seamL = 0;

/** The last ring point: position (doc) and fade. */
let PX = 0, PY = 0, PF = 0;

function ringPt(cx: FormCx, F: Facts, k: number, side: number): void {
  const o = off(F, k, side, cx.r.seed);
  const z = cx.z, d = (side * o) / z;
  ringNormal(cx, F, k);
  PX = F.x + d * RNX; PY = F.y + d * RNY;
  if (seamOn) {
    const e = smoothstep(seamL - SEAM_RAMP, seamL, F.s), q = 2 * k + (side > 0 ? 1 : 0);
    PX += SEAM_X[q] * e; PY += SEAM_Y[q] * e;
  }
  let f = smoothstep(CLEAR_LO, CLEAR_HI, (clearance(cx, PX, PY, F.s) * z) / o);
  if (side * F.kb > 0) f *= smoothstep(COLLAPSE_HI, COLLAPSE_LO, o * Math.abs(F.kb));
  PF = f;
}

/** Joint pinch: arc span of the unit's rings and arc length (sp) of the current cap quarter. */
let pinchSpan = 0, pinchCap = 0;

/** Run building: the open branch (−1 = none). Branch len codes the kind: 0 ring run, 1 cap quarter. */
let run = -1;
function push(g: UnitGeom, k: number, kind: number, x: number, y: number, pa: number, w: number, fac: number): void {
  if (!(fac > 0)) { closeRun(g); return; }
  if (run < 0) run = g.beginBranch(k, kind);
  g.addPt(x, y, pa);
  g.auxFit(g.nPts, 1);
  // pinch toward every joint (unit ends, cap joints and apex): polys of different units never
  // weld, so their round ends overlap there and would double-expose into a dot on Night
  const d = kind === 0 ? (pa < pinchSpan - pa ? pa : pinchSpan - pa) : (pa < 1 - pa ? pa : 1 - pa) * pinchCap;
  g.aux[g.nPts - 1] = w * fac * (PINCH + (1 - PINCH) * smoothstep(0, PINCH_LEN, d));
}
function closeRun(g: UnitGeom): void {
  if (run < 0) return;
  g.endBranch(run);
  if (g.bCnt[run] < 2) { g.nPts = g.bOff[run]; g.nB = run; }
  run = -1;
}

const FL: Facts[] = [];
for (let i = 0; i <= Math.ceil(SPAN / H) + 1; i++) FL.push(new Facts());
const FS = new Facts(), FH = new Facts(), FT = new Facts();

/** Width (doc) of ring k at the facts' arc. */
const ringW = (F: Facts, k: number, z: number): number => {
  const w = DUTY * F.b * (GP[k] - GP[k - 1]);
  return ((w > F.wr ? (w < W_MAX ? w : W_MAX) : F.wr) * ((k & 1) ? 1 : EVEN_W)) / z;
};

/** Cook unit rec at its ceiling: every ring's runs and the end caps; g.k = span (sp). */
function cookUnit(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
  g.reset();
  run = -1;
  const at = cx.at, sp = cx.sp, z = cx.z, L = cx.L, sa = rec.s, sEnd = sa + SPAN;
  const sb = sEnd < L ? sEnd : L, span = sb - sa;
  g.w = at.at(sp.w, sa); g.p = at.at(sp.p, sa); g.c = at.at(sp.c, sa);
  g.k = span > 0 ? span : 0; g.ceil = DMAX;
  if (!(span > 0)) return;
  const M = Math.max(1, Math.ceil(span / H - 1e-9));
  pinchSpan = span;
  for (let m = 0; m <= M; m++) facts(cx, m === M ? sb : sa + m * H, FL[m]);
  // closed loop: ramp every ring point toward the ring's start point at s0 over the last SEAM_RAMP sp
  seamOn = false;
  seamL = L;
  if (cx.final && cx.closed && sb > L - SEAM_RAMP) {
    facts(cx, cx.s0, FH); facts(cx, L, FT);
    for (let k = 1; k <= NR; k++) {
      for (let side = 1; side >= -1; side -= 2) {
        const q = 2 * k + (side > 0 ? 1 : 0);
        ringPt(cx, FH, k, side); const hx = PX, hy = PY;
        ringPt(cx, FT, k, side);
        SEAM_X[q] = hx - PX; SEAM_Y[q] = hy - PY;
      }
    }
    seamOn = true;
  }
  for (let k = 1; k <= NR; k++) {
    for (let side = 1; side >= -1; side -= 2) {
      ringPt(cx, FL[0], k, side);
      push(g, k, 0, PX, PY, 0, ringW(FL[0], k, z), PF);
      for (let m = 1; m <= M; m++) {
        const x0 = PX, y0 = PY, a0 = FL[m - 1].s;
        ringPt(cx, FL[m], k, side);
        const x1 = PX, y1 = PY, f1 = PF, a1 = FL[m].s;
        const dx = x1 - x0, dy = y1 - y0, chord = Math.sqrt(dx * dx + dy * dy) * z;
        if (chord > CHORD) {
          const n = Math.min(SUB_MAX, Math.ceil(chord / CHORD));
          for (let t = 1; t < n; t++) {
            const s = a0 + ((a1 - a0) * t) / n;
            facts(cx, s, FS);
            ringPt(cx, FS, k, side);
            push(g, k, 0, PX, PY, s - sa, ringW(FS, k, z), PF);
          }
        }
        push(g, k, 0, x1, y1, m === M ? span : a1 - sa, ringW(FL[m], k, z), f1);
        PX = x1; PY = y1;
      }
      closeRun(g);
    }
  }
  seamOn = false;
  // caps: the head on the first unit (unless the finished stroke is closed or cut there), the tail at finish
  if (rec.j === 0 && !(cx.cut & 1) && !(cx.final && cx.closed)) cap(cx, g, FL[0], -1);
  if (cx.final && sEnd >= L && !cx.closed && !(cx.cut & 2)) cap(cx, g, FL[M], 1);
  g.ceil = unitCeiling(g);
}

/**
 * Round caps of every ring at one end: two quarter arcs per ring from the side rings' end
 * points to a shared apex at (oP + oM)/2 along the outward tangent (dir = −1 head, +1 tail, in
 * the ring's own smoothed frame); pa = 0..1 from the joint. The joint is the ring's own end point (same function, same arc: exact).
 */
function cap(cx: FormCx, g: UnitGeom, F: Facts, dir: number): void {
  const z = cx.z, sd = cx.r.seed;
  for (let k = 1; k <= NR; k++) {
    const oP = off(F, k, 1, sd), oM = off(F, k, -1, sd), rA = 0.5 * (oP + oM), w = ringW(F, k, z);
    ringNormal(cx, F, k);
    const nx = RNX, ny = RNY, dx = -dir * ny, dy = dir * nx;
    for (let side = 1; side >= -1; side -= 2) {
      const oS = side > 0 ? oP : oM, rMax = oS > rA ? oS : rA;
      const nq = clamp(Math.ceil(((PI / 2) * rMax) / CAP_CHORD), 3, 24);
      pinchCap = (PI / 2) * rMax;
      ringPt(cx, F, k, side);
      push(g, k, 1, PX, PY, 0, w, PF);
      for (let i = 1; i <= nq; i++) {
        const phi = ((PI / 2) * i) / nq;
        const c = i === nq ? 0 : dcos(phi), sn = i === nq ? 1 : dsin(phi);
        const r = (rA + (oS - rA) * c) / z;
        const x = F.x + r * (c * side * nx + sn * dx), y = F.y + r * (c * side * ny + sn * dy);
        const f = smoothstep(CLEAR_LO, CLEAR_HI, clearance(cx, x, y, F.s) / r);
        push(g, k, 1, x, y, i === nq ? 1 : i / nq, w, f);
      }
      closeRun(g);
    }
  }
}

/** Ring weight f_k at depth D for the unit's pressure. */
const weight = (K: number, k: number): number => clamp(K - k + 1, 0, 1);

/**
 * Walk the drawn part of branch b: ring runs keep pa ∈ [lo, hi] (a dash centred in the unit),
 * caps the prefix pa ≤ f. Boundary points are interpolated (and exactly the stored point when
 * the bound sits on it). Returns the points written (or counted when out is null).
 */
function walkBranch(g: UnitGeom, b: number, lo: number, hi: number, wMul: number, out: Sink | null): number {
  const o = g.bOff[b], n = g.bCnt[b], pa = g.pa;
  let i = 0;
  while (i < n && pa[o + i] < lo) i++;
  if (i === n || pa[o + i] > hi && (i === 0 || pa[o + i - 1] > hi)) return 0;
  let cnt = 0;
  if (i > 0 && pa[o + i] > lo) { cnt++; if (out) lerpPt(g, o + i - 1, lo, wMul, out); }
  for (; i < n && pa[o + i] <= hi; i++) { cnt++; if (out) out.pt(g.px[o + i], g.py[o + i], g.aux[o + i] * wMul); }
  if (i < n && i > 0 && pa[o + i - 1] < hi) { cnt++; if (out) lerpPt(g, o + i - 1, hi, wMul, out); }
  return cnt;
}
function lerpPt(g: UnitGeom, j: number, a: number, wMul: number, out: Sink): void {
  const a0 = g.pa[j], a1 = g.pa[j + 1], t = a1 > a0 ? (a - a0) / (a1 - a0) : 0;
  out.pt(g.px[j] + (g.px[j + 1] - g.px[j]) * t, g.py[j] + (g.py[j + 1] - g.py[j]) * t, (g.aux[j] + (g.aux[j + 1] - g.aux[j]) * t) * wMul);
}

/** Points (out = null) or emitted polys of the unit at depth D. */
function unitWalk(g: UnitGeom, D: number, eIn: number, born: number, unit: number, out: Sink | null): number {
  if (!(D > 0) || g.nB === 0) return 0;
  // the entry taper only thins the rings: the field round the head stays (its cap included)
  const K = ringsAt(D, g.p), mid = 0.5 * g.k, wIn = 0.6 + 0.4 * eIn;
  let pts = 0;
  for (let b = 0; b < g.nB; b++) {
    const k = g.bGen[b], f = weight(K, k);
    if (!(f > 0)) continue;
    const isCap = g.bLen[b] === 1;
    const lo = isCap ? 0 : mid - f * mid, hi = isCap ? f : mid + f * mid;
    if (!out) { const c = walkBranch(g, b, lo, hi, 1, null); pts += c >= 2 ? c : 0; continue; }
    out.begin(PolyKind.Ribbon, k, ringAlpha(k, g.p, g.c) * f, toneOf(g.p, ringBucket(k)), born, unit, 1);
    walkBranch(g, b, lo, hi, wIn, out);
    pts += out.end();
  }
  return pts;
}

/** Largest 1/16 level ≤ DMAX whose points fit the unit budget. */
function unitCeiling(g: UnitGeom): number {
  if (unitWalk(g, DMAX, 1, 0, 0, null) <= UNIT_BUDGET) return DMAX;
  let lo = 0, hi = DMAX * 16;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (unitWalk(g, m / 16, 1, 0, 0, null) <= UNIT_BUDGET) lo = m; else hi = m; }
  return lo / 16;
}

const chain: ChainOperator = {
  halfWin: HALF_WIN,
  dMax: DMAX,
  unitBudget: UNIT_BUDGET,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 : cur.s) + HALF_WIN;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    if (cur.phase === 0) { cur.s = cx.s0; cur.phase = 1; cur.side = 0; return false; }
    const s = cur.s;
    rec.s = s; rec.j = cur.j; rec.side = 0; rec.tmpl = 0;
    cur.j++;
    cur.s = s + SPAN;
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s < cx.L; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void { cookUnit(cx, rec, g); },

  count(g: UnitGeom, D: number): number { return unitWalk(g, D, 1, 0, 0, null); },

  emit(_cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return unitWalk(g, D, eIn, rec.s, rec.j, out);
  },
};

/**
 * Radial seed: a bullseye. Ring k (radius b + (k − 1)·0.42b, a five-lobed wobble whose phase
 * turns ring by ring) is drawn as an arc of fraction f_k centred on a golden-angle phase, so
 * the target grows ring by ring as a spiral of arcs that close into circles. A second family
 * of the same rings round a centre offset by 1.6 gaps fades in over D ∈ [0.5, 2] with the
 * opposite wobble: where the two families coincide and where they alternate they beat into
 * moiré fringes. The rotation is the only use of rng.
 */
function rippleRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z, wsp = Math.max(seed.w * z, 0.6 * r.stroke.size), b = baseOffset(wsp), gap = TAP_GAP * b;
  const K = ringsAt(D, seed.p), wr = Math.max(clamp(0.05 * wsp + 0.4, 0.45, 1.1), Math.min(DUTY * gap, W_MAX));
  const rot = TAU * rnd(r.seed, Ch.Angle, RADIAL_ID + 48);
  const fB = smoothstep(0.5, 2, D);
  for (let fam = 0; fam < 2; fam++) {
    if (fam === 1 && !(fB > 0)) break;
    const e = fam === 0 ? 0 : (TAP_OFF * gap) / z;
    const cx0 = seed.x + e * dcos(rot), cy0 = seed.y + e * dsin(rot), sg = fam === 0 ? 1 : -1;
    for (let k = 1; k <= NR; k++) {
      const f = weight(K, k);
      if (!(f > 0)) break;
      const R = b + (k - 1) * gap, n = clamp(Math.ceil((TAU * R) / 2.5), 32, 160);
      const ph = rot + (fam === 0 ? 0 : PI) + GOLDEN * k;
      const alpha = ringAlpha(k, seed.p, seed.c) * f * (fam === 0 ? 1 : 0.85 * fB);
      out.begin(PolyKind.Ribbon, k, alpha, toneOf(seed.p, ringBucket(k)), cx.s0, 0, 1);
      const w = (wr * ((k & 1) ? 1 : EVEN_W)) / z;
      const u0 = 0.5 - 0.5 * f, u1 = 0.5 + 0.5 * f, i0 = Math.ceil(u0 * n), i1 = Math.floor(u1 * n);
      tapPt(cx0, cy0, R, ph, u0, k, sg, w, z, out);
      for (let i = i0; i <= i1; i++) if (i / n > u0 && i / n < u1) tapPt(cx0, cy0, R, ph, i / n, k, sg, w, z, out);
      tapPt(cx0, cy0, R, ph, u1, k, sg, w, z, out);
      out.end();
    }
  }
  return D;
}
function tapPt(x0: number, y0: number, R: number, ph: number, u: number, k: number, sg: number, w: number, z: number, out: Sink): void {
  const a = ph + TAU * (u - 0.5);
  const rr = (R * (1 + TAP_WOB * dsin(TAP_LOBES * a + sg * k * PSI))) / z;
  out.pt(x0 + rr * dcos(a), y0 + rr * dsin(a), w);
}

export const ops: FormOps = {
  id: 'ripple', v: 107, locality: 'local', reach: HALF_WIN, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: rippleRadial,
  radialCeiling: DMAX,
};
