/**
 * Form operators: contracts plus the small runtime kit every operator shares.
 *
 * This deviates from the DESIGN §7.2 sketch (allowed by BUILD §3) to fit the unit model
 * of ink/cook.ts. An operator never owns state across calls; the cook does:
 *  - Gen-0 TRUNK, chunked into absolute 50 sp blocks (unit = block index). Every Form
 *    has one; Line replaces the plain station trunk with its displaced trunk.
 *  - Local GROWTH CHAINS (Sprout anchors, Drift stations): a sequential cursor decides
 *    each unit's arc and frozen choices (ChainRecord) from the spine within `halfWin` sp;
 *    the unit is then cooked once at its ceiling (UnitGeom) and truncated to its depth.
 *    A unit is a pure function of (record, spine within halfWin sp, d at its arc, entry
 *    factor, rng address), which is what makes regrow / truncation / cook ≡ finish exact.
 *  - Echo's global crystal and ghost and every Form's radial seed are plain functions.
 *
 * Runtime kit (here so the operator files stay pure geometry):
 *  - PolyBuf: a growable poly buffer implementing Sink; arc `a` accumulates in sp.
 *  - Sampler: station interpolation by absolute arc up to a watermark `hi`, bit-exact
 *    whichever watermark is used for arcs inside the readable range.
 *  - TrunkPts + writeTrunk: centreline points -> tone-split core chunks, brush dry-split
 *    bristles and chisel angles (shared by the plain trunk and Line).
 */
import type { DepthField, FormId, RecipeCore, Spine } from '../../core/types';
import { PolyKind } from '../../core/types';
import { rnd, Ch, PI as PI_, TAU as TWO_PI } from '../../core/det';
import { chiselAngle, drySplit } from '../nibs';
import type { CurlField } from '../noise';

// ============================================================================ sink

/** Receives polys point by point (doc units relative to the stroke origin). */
export interface Sink {
  /** Start a poly. `cat` orders polys of one gen at assembly: 0 = trunk core chunks, 1 = others. */
  begin(kind: PolyKind, gen: number, alpha: number, tone: number, born: number, unit: number, cat?: number): void;
  /** Append a point: position, FULL width (doc) and, for chisel polys, the nib angle (doc radians). */
  pt(x: number, y: number, w: number, ang?: number): void;
  /** Close the poly; returns its point count (0 when it was dropped as degenerate). */
  end(): number;
}

function grow32(a: Float32Array, need: number): Float32Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 64;
  while (c < need) c *= 2;
  const b = new Float32Array(c); b.set(a); return b;
}
function growU32(a: Uint32Array, need: number): Uint32Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 16;
  while (c < need) c *= 2;
  const b = new Uint32Array(c); b.set(a); return b;
}
function growU8(a: Uint8Array, need: number): Uint8Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 16;
  while (c < need) c *= 2;
  const b = new Uint8Array(c); b.set(a); return b;
}
function grow64(a: Float64Array, need: number): Float64Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 64;
  while (c < need) c *= 2;
  const b = new Float64Array(c); b.set(a); return b;
}

const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
/** Largest Float32 ≤ v (boxes are rounded outward so they always contain their points). */
export function down32(v: number): number {
  f32[0] = v;
  if (f32[0] <= v) return f32[0];
  i32[0] += f32[0] > 0 ? -1 : f32[0] < 0 ? 1 : 0;
  if (f32[0] === 0) f32[0] = -1e-45;
  return f32[0];
}
/** Smallest Float32 ≥ v. */
export function up32(v: number): number {
  f32[0] = v;
  if (f32[0] >= v) return f32[0];
  i32[0] += f32[0] > 0 ? 1 : f32[0] < 0 ? -1 : 0;
  if (f32[0] === 0) f32[0] = 1e-45;
  return f32[0];
}

/**
 * Growable poly storage (stride-4 points x, y, w, a). A Ribbon/Chisel poly with fewer than
 * two points is dropped at end(); a Dot keeps one point. The per-poly box includes w/2.
 */
export class PolyBuf implements Sink {
  pts: Float32Array; ang: Float32Array | null = null; nPts = 0;
  start: Uint32Array; count: Uint32Array; kind: Uint8Array; gen: Uint8Array; tone: Uint8Array; cat: Uint8Array;
  alpha: Float32Array; born: Float32Array; unit: Uint32Array; box: Float32Array;
  nPolys = 0;
  /** sp per doc unit: the arc column accumulates distance × zs. */
  zs = 1;
  private open = false; private lx = 0; private ly = 0; private arc = 0;
  private bx0 = 0; private by0 = 0; private bx1 = 0; private by1 = 0;

  constructor(ptsCap = 64, polyCap = 8) {
    this.pts = new Float32Array(4 * ptsCap);
    this.start = new Uint32Array(polyCap); this.count = new Uint32Array(polyCap);
    this.kind = new Uint8Array(polyCap); this.gen = new Uint8Array(polyCap); this.tone = new Uint8Array(polyCap);
    this.cat = new Uint8Array(polyCap);
    this.alpha = new Float32Array(polyCap); this.born = new Float32Array(polyCap); this.unit = new Uint32Array(polyCap);
    this.box = new Float32Array(4 * polyCap);
  }

  clear(): void { this.nPts = 0; this.nPolys = 0; this.open = false; }

  private ensurePolys(n: number): void {
    if (n <= this.start.length) return;
    this.start = growU32(this.start, n); this.count = growU32(this.count, n);
    this.kind = growU8(this.kind, n); this.gen = growU8(this.gen, n); this.tone = growU8(this.tone, n);
    this.cat = growU8(this.cat, n);
    this.alpha = grow32(this.alpha, n); this.born = grow32(this.born, n); this.unit = growU32(this.unit, n);
    this.box = grow32(this.box, 4 * n);
  }

  private ensurePts(n: number): void {
    if (4 * n > this.pts.length) this.pts = grow32(this.pts, 4 * n);
    if (this.ang && n > this.ang.length) this.ang = grow32(this.ang, this.pts.length >> 2);
  }

  begin(kind: PolyKind, gen: number, alpha: number, tone: number, born: number, unit: number, cat = 1): void {
    const i = this.nPolys;
    this.ensurePolys(i + 1);
    this.start[i] = this.nPts; this.count[i] = 0;
    this.kind[i] = kind; this.gen[i] = gen; this.tone[i] = tone; this.cat[i] = cat;
    this.alpha[i] = alpha; this.born[i] = born; this.unit[i] = unit >>> 0;
    if (kind === PolyKind.Chisel && !this.ang) this.ang = new Float32Array(this.pts.length >> 2);
    this.open = true; this.arc = 0;
    this.bx0 = Infinity; this.by0 = Infinity; this.bx1 = -Infinity; this.by1 = -Infinity;
  }

  pt(x: number, y: number, w: number, ang = 0): void {
    const k = this.nPts;
    this.ensurePts(k + 1);
    const i = this.nPolys;
    if (k > this.start[i]) {
      const dx = x - this.lx, dy = y - this.ly;
      this.arc += Math.sqrt(dx * dx + dy * dy) * this.zs;
    }
    const o = 4 * k, p = this.pts;
    p[o] = x; p[o + 1] = y; p[o + 2] = w; p[o + 3] = this.arc;
    if (this.ang) this.ang[k] = ang;
    this.lx = x; this.ly = y;
    // the box is taken from the stored Float32 values, so it contains them exactly
    const fx = p[o], fy = p[o + 1], fw = p[o + 2], h = 0.5 * (fw > 0 ? fw : 0);
    if (fx - h < this.bx0) this.bx0 = fx - h; if (fx + h > this.bx1) this.bx1 = fx + h;
    if (fy - h < this.by0) this.by0 = fy - h; if (fy + h > this.by1) this.by1 = fy + h;
    this.nPts = k + 1;
  }

  end(): number {
    if (!this.open) return 0;
    this.open = false;
    const i = this.nPolys, n = this.nPts - this.start[i];
    if (n === 0 || (n < 2 && this.kind[i] !== PolyKind.Dot)) { this.nPts = this.start[i]; return 0; }
    this.count[i] = n;
    const b = 4 * i;
    this.box[b] = down32(this.bx0); this.box[b + 1] = down32(this.by0);
    this.box[b + 2] = up32(this.bx1); this.box[b + 3] = up32(this.by1);
    this.nPolys = i + 1;
    return n;
  }

}

// ============================================================================ spine sampling

/**
 * Interpolation over stations [0, hi] by absolute arc. Arcs outside the range clamp to the
 * end stations. Results for an arc ≤ s[hi] are bit-identical whatever `hi` is (the same
 * bracketing stations and weights), which keeps live and final cooks equal.
 */
export class Sampler {
  sp: Spine;
  hi = 0;
  /** Weight of station i+1 from the last locate(). */
  t = 0;
  private readonly nv = new Float64Array(2);

  constructor(sp: Spine, hi = 0) { this.sp = sp; this.hi = hi; }

  set(sp: Spine, hi: number): void { this.sp = sp; this.hi = hi; }

  /** Station interval [i, i+1] holding arc s (i in [0, hi−1]); sets t. hi = 0 gives i = 0, t = 0. */
  locate(s: number): number {
    const S = this.sp.s, hi = this.hi;
    if (hi <= 0 || !(s > S[0])) { this.t = 0; return 0; }
    if (s >= S[hi]) { this.t = 0; return hi; }
    let lo = 0, h = hi;
    while (h - lo > 1) { const m = (lo + h) >> 1; if (S[m] <= s) lo = m; else h = m; }
    const ds = S[lo + 1] - S[lo];
    this.t = ds > 0 ? (s - S[lo]) / ds : 0;
    return lo;
  }

  /** Field value at arc s (linear between stations). */
  at(a: ArrayLike<number>, s: number): number {
    const i = this.locate(s), t = this.t;
    if (t === 0) return a[i];
    return a[i] + (a[i + 1] - a[i]) * t;
  }

  /**
   * Angle field (radians) at arc s, interpolated the short way round, so stations on either
   * side of the ±π / 0–2π wrap (pen azimuth) never interpolate through the opposite direction.
   */
  angle(a: ArrayLike<number>, s: number): number {
    const i = this.locate(s), t = this.t;
    if (t === 0) return a[i];
    let d = (a[i + 1] - a[i]) % TWO_PI;
    if (d > PI_) d -= TWO_PI; else if (d <= -PI_) d += TWO_PI;
    return a[i] + d * t;
  }

  /** Position at arc s into out[0], out[1] (doc). */
  pos(s: number, out: Float64Array): void {
    const i = this.locate(s), t = this.t, X = this.sp.x, Y = this.sp.y;
    if (t === 0) { out[0] = X[i]; out[1] = Y[i]; return; }
    out[0] = X[i] + (X[i + 1] - X[i]) * t; out[1] = Y[i] + (Y[i + 1] - Y[i]) * t;
  }

  /** Unit normal at arc s (lerped station normals, renormalised) into out. */
  normal(s: number, out: Float64Array): void {
    const i = this.locate(s), t = this.t, NX = this.sp.nx, NY = this.sp.ny;
    let x: number, y: number;
    if (t === 0) { x = NX[i]; y = NY[i]; } else { x = NX[i] + (NX[i + 1] - NX[i]) * t; y = NY[i] + (NY[i + 1] - NY[i]) * t; }
    const m = Math.sqrt(x * x + y * y);
    if (m > 1e-9) { out[0] = x / m; out[1] = y / m; } else { out[0] = 0; out[1] = -1; }
  }

  /** Unit tangent (direction of travel) at arc s: the normal rotated back, t = (−ny, nx). */
  tangent(s: number, out: Float64Array): void {
    this.normal(s, this.nv);
    out[0] = -this.nv[1]; out[1] = this.nv[0];
  }

  /**
   * Mean of a station field over stations with arc in [s − half, s + half] (within [0, hi]);
   * the interpolated value at s when no station falls inside.
   */
  mean(a: ArrayLike<number>, s: number, half: number): number {
    const S = this.sp.s, hi = this.hi, lo = s - half, up = s + half;
    let l = 0, h = hi + 1;
    while (l < h) { const m = (l + h) >> 1; if (S[m] < lo) l = m + 1; else h = m; }
    let sum = 0, n = 0;
    for (let i = l; i <= hi && S[i] <= up; i++) { sum += a[i]; n++; }
    return n > 0 ? sum / n : this.at(a, s);
  }
}

// ============================================================================ contexts

/** What an operator may read about the stroke being cooked. */
export interface FormCx {
  readonly r: RecipeCore;
  readonly sp: Spine;
  /** Sampler over stations [0, hi]; hi is the readable watermark (settled − 1 live, n − 1 final). */
  readonly at: Sampler;
  /** sp per doc unit. */
  readonly z: number;
  /** Arc of station 0 and of the last readable station. */
  readonly s0: number;
  readonly L: number;
  /** The spine is finished (tail zones are final). */
  readonly final: boolean;
  /** Provisional tail of a live stroke: Line fades its displacement to 0 over this arc behind the tip. */
  readonly tipFade: number;
  readonly closed: boolean;
  /** Cut flags in force (bit 0 head, bit 1 tail): the draft's live, the committed recipe's at finish. */
  readonly cut: number;
  /** Depth field d(s) (not clamped; operators clamp to their dMax). */
  readonly depth: DepthField;
  readonly base: number;
  /** Causal entry factor E_in(s) (operators); full trunk envelope E(s) (gen-0 widths). */
  inF(s: number): number;
  trunkE(s: number): number;
  /** The stroke's Drift curl field (λ = 280 sp at the commit zoom), built on first use. */
  curl(): CurlField;
}

// ============================================================================ chains

/** Frozen per-unit choices made when the chain reaches a unit. */
export interface ChainRecord { s: number; j: number; side: number; tmpl: number }
/** Sequential chain cursor: phase 0 = first unit arc not known yet; `s` = next unit arc. */
export interface ChainCursor { phase: number; s: number; j: number; side: number }

/** A unit's geometry at its ceiling: polylines ("branches") plus per-unit scalars. */
export class UnitGeom {
  px: Float64Array = new Float64Array(64); py: Float64Array = new Float64Array(64); pa: Float64Array = new Float64Array(64); nPts = 0;
  bOff: Int32Array = new Int32Array(8); bCnt: Int32Array = new Int32Array(8); bGen: Uint8Array = new Uint8Array(8); bLen: Float64Array = new Float64Array(8); nB = 0;
  /** Untapered width (doc), pressure, crowding at the unit; unit ceiling; operator scalar. */
  w = 0; p = 0; c = 0; ceil = 0; k = 0;
  /**
   * Optional per-point operator data, `stride` values per point, parallel to px / py / pa
   * (Sprout v2 keeps each point's crotch clearance here). addPt never touches it: an operator
   * that uses it sizes it with auxFit and fills it itself.
   */
  aux: Float64Array = new Float64Array(0);

  reset(): void { this.nPts = 0; this.nB = 0; }

  /** Make aux hold at least n points of `stride` values (contents kept). */
  auxFit(n: number, stride: number): void {
    if (n * stride > this.aux.length) this.aux = grow64(this.aux, n * stride);
  }

  addPt(x: number, y: number, a: number): void {
    const n = this.nPts;
    if (n + 1 > this.px.length) { this.px = grow64(this.px, n + 1); this.py = grow64(this.py, n + 1); this.pa = grow64(this.pa, n + 1); }
    this.px[n] = x; this.py[n] = y; this.pa[n] = a; this.nPts = n + 1;
  }

  /** Open branch b at the current point index. */
  beginBranch(gen: number, len: number): number {
    const b = this.nB;
    if (b + 1 > this.bOff.length) {
      const c = this.bOff.length * 2;
      const o = new Int32Array(c); o.set(this.bOff); this.bOff = o;
      const k = new Int32Array(c); k.set(this.bCnt); this.bCnt = k;
      const g = new Uint8Array(c); g.set(this.bGen); this.bGen = g;
      const l = new Float64Array(c); l.set(this.bLen); this.bLen = l;
    }
    this.bOff[b] = this.nPts; this.bCnt[b] = 0; this.bGen[b] = gen; this.bLen[b] = len;
    this.nB = b + 1;
    return b;
  }

  endBranch(b: number): void { this.bCnt[b] = this.nPts - this.bOff[b]; }

  /** Points of branch b drawn to arc lam (sp): the prefix with arc < lam plus the end point. */
  prefixCount(b: number, lam: number): number {
    if (!(lam > 0)) return 0;
    const o = this.bOff[b], n = this.bCnt[b], pa = this.pa;
    let k = 1;
    while (k < n && pa[o + k] < lam) k++;
    return k < n ? k + 1 : n;
  }
}

/** A local growth chain (Sprout anchors, Drift stations). */
export interface ChainOperator {
  /** Half-width (sp) of the spine window a unit reads around its arc. */
  readonly halfWin: number;
  readonly dMax: number;
  readonly unitBudget: number;
  readonly strokeBudget: number;
  /** Arc that must be readable before step() may run on this cursor. */
  need(cx: FormCx, cur: ChainCursor): number;
  /** One step: fills `rec` and returns true when a unit is reached; always advances the cursor. */
  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean;
  /** Whether a unit at arc s survives the finish of a stroke ending at cx.L. */
  keep(cx: FormCx, s: number): boolean;
  /** Cook the unit at its ceiling into g (sets g.ceil, the unit ceiling as an absolute depth). */
  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void;
  /** Points the unit emits at depth D (D already clamped to [0, g.ceil]). */
  count(g: UnitGeom, D: number): number;
  /** Emit the unit truncated to depth D with entry factor eIn; returns the points written. */
  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number;
}

/** Gen-0 trunk style: width multiplier and alpha of the spine. */
export interface TrunkStyle { w: number; alpha: number }

/** One Form, as the cook drives it. */
export interface FormOps {
  readonly id: FormId;
  readonly v: number;
  readonly locality: 'local' | 'global';
  /** Arc (sp) of spine an output point depends on, either side. */
  readonly reach: number;
  readonly dMax: number;
  readonly baseDefault: number;
  readonly unitBudget: number;
  readonly strokeBudget: number;
  trunkStyle(r: RecipeCore): TrunkStyle;
  /** Fills trunk centreline points for stations [i0, i1] (Line); null = the plain station trunk. */
  readonly trunk: ((cx: FormCx, i0: number, i1: number, T: TrunkPts) => void) | null;
  /** Spine reach (sp) of a trunk point beyond its block; 0 for the plain trunk. */
  readonly trunkReach: number;
  /** Depth reach of trunk points (sp); < 0 when the trunk ignores depth. */
  readonly trunkDepthReach: number;
  readonly chain: ChainOperator | null;
  /** Radial seed growth at depth (the gen-0 dot is written by the cook). Returns the realised depth. */
  radial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number;
  /** Depth ceiling of a radial seed. */
  readonly radialCeiling: number;
}

// ============================================================================ helpers

/** Pressure bucket of the tone index: min(5, floor(6p)). */
export function pBucket(p: number): number {
  const b = Math.floor(p * 6);
  return b < 0 ? 0 : b > 5 ? 5 : b;
}
/** Tone index pBucket·5 + dBucket (dBucket clamped to 0..4). */
export function toneOf(p: number, dBucket: number): number {
  return pBucket(p) * 5 + (dBucket < 0 ? 0 : dBucket > 4 ? 4 : dBucket);
}
/** Glow budget for growth (gen ≥ 1): 1/(1 + 0.6c). */
export const glow = (c: number): number => 1 / (1 + 0.6 * (c > 0 ? c : 0));
/** Night hierarchy factor 0.72^(g−1) for g ≥ 1 (Paper's 0.78 is applied at raster: registry.paperAlphaScale). */
export function hierarchy(g: number): number {
  let a = 1;
  for (let i = 1; i < g; i++) a *= 0.72;
  return a;
}

/** Facts about a radial (tap / bloom) seed. */
export interface RadialSeed { x: number; y: number; w: number; p: number; c: number }

/** Centre (mean station position), mean untapered width, mean pressure and crowding of a short spine. */
export function radialSeed(sp: Spine, out: RadialSeed): RadialSeed {
  const n = sp.n;
  let x = 0, y = 0, w = 0, p = 0, c = 0;
  for (let i = 0; i < n; i++) { x += sp.x[i]; y += sp.y[i]; w += sp.w[i]; p += sp.p[i]; c += sp.c[i]; }
  const k = n > 0 ? 1 / n : 0;
  out.x = x * k; out.y = y * k; out.w = w * k; out.p = n > 0 ? p * k : 0.6; out.c = c * k;
  return out;
}

// ============================================================================ trunk

/** Trunk centreline points (SoA, reused): positions, FINAL widths, normals, dry-split, angle, arc, tone. */
export class TrunkPts {
  n = 0;
  x: Float64Array = new Float64Array(64); y: Float64Array = new Float64Array(64); w: Float64Array = new Float64Array(64);
  nx: Float64Array = new Float64Array(64); ny: Float64Array = new Float64Array(64); ds: Float64Array = new Float64Array(64);
  ang: Float64Array = new Float64Array(64); s: Float64Array = new Float64Array(64); tone: Uint8Array = new Uint8Array(64);

  reset(): void { this.n = 0; }

  push(x: number, y: number, w: number, nx: number, ny: number, ds: number, ang: number, s: number, tone: number): void {
    const k = this.n;
    if (k + 1 > this.x.length) {
      const c = k + 1;
      this.x = grow64(this.x, c); this.y = grow64(this.y, c); this.w = grow64(this.w, c);
      this.nx = grow64(this.nx, c); this.ny = grow64(this.ny, c); this.ds = grow64(this.ds, c);
      this.ang = grow64(this.ang, c); this.s = grow64(this.s, c); this.tone = growU8(this.tone, c);
    }
    this.x[k] = x; this.y[k] = y; this.w[k] = w; this.nx[k] = nx; this.ny[k] = ny; this.ds[k] = ds;
    this.ang[k] = ang; this.s[k] = s; this.tone[k] = tone;
    this.n = k + 1;
  }
}

/** Stations [i0, i1] as trunk points: final width (× envelope × wMul), dry-split, chisel angle, tone. */
export function stationTrunk(cx: FormCx, i0: number, i1: number, wMul: number, T: TrunkPts): void {
  const sp = cx.sp, r = cx.r, nib = r.stroke.nib, dev = r.device, chisel = nib === 'chisel';
  for (let i = i0; i <= i1; i++) {
    const s = sp.s[i], w = sp.w[i] * cx.trunkE(s) * wMul;
    const ds = drySplit(nib, sp.vn[i], sp.p[i], dev);
    const ang = chisel ? chiselAngle(sp.alt[i], sp.az[i]) - r.rot : 0;
    T.push(sp.x[i], sp.y[i], w, sp.nx[i], sp.ny[i], ds, ang, s, toneOf(sp.p[i], 0));
  }
}

/** Bristles of the brush dry-split: 4 strands of width w/4.5 at offsets (j − 1.5)·w/4. */
const BRISTLES = 4;
const BRISTLE_W = 1 / 4.5;
/** Gate cell (sp) and threshold of the strand-breaking noise. */
const GATE_CELL = 12, GATE_T = 0.35;

/**
 * Write trunk points as gen-0 polys: core chunks split where the tone changes (adjacent
 * chunks share their boundary point exactly), then the dry-split bristles. The core is
 * w·(1 − ds) wide so strands show through as the brush dries; each strand is gated by
 * r(seed, Ch.Misc, j, floor(s/12)) > 0.35 so strands break (DESIGN §2.2.1).
 */
export function writeTrunk(T: TrunkPts, kind: PolyKind, alpha: number, unit: number, seed: number, out: Sink): void {
  const n = T.n;
  if (n < 2) return;
  const chisel = kind === PolyKind.Chisel;
  let k0 = 0, dry = false;
  for (let k = 0; k < n; k++) if (T.ds[k] > 0) { dry = true; break; }
  for (let k = 1; k < n; k++) {
    if (k < n - 1 && T.tone[k] === T.tone[k0]) continue;
    out.begin(kind, 0, alpha, T.tone[k0], T.s[k0], unit, 0);
    for (let q = k0; q <= k; q++) {
      const w = dry ? T.w[q] * (1 - T.ds[q]) : T.w[q];
      out.pt(T.x[q], T.y[q], w, chisel ? T.ang[q] : 0);
    }
    out.end();
    k0 = k;
  }
  if (!dry || chisel) return;
  for (let j = 0; j < BRISTLES; j++) {
    const off = (j - 1.5) * 0.25;
    let run = -1;
    for (let k = 0; k <= n; k++) {
      const on = k < n && T.ds[k] > 0 && rnd(seed, Ch.Misc, j, Math.floor(T.s[k] / GATE_CELL)) > GATE_T;
      if (on && run < 0) run = k;
      if (!on && run >= 0) {
        if (k - run >= 2) {
          out.begin(PolyKind.Ribbon, 0, alpha, T.tone[run], T.s[run], unit, 1);
          for (let q = run; q < k; q++) {
            const w = T.w[q], o = off * w;
            out.pt(T.x[q] + T.nx[q] * o, T.y[q] + T.ny[q] * o, w * BRISTLE_W);
          }
          out.end();
        }
        run = -1;
      }
    }
  }
}

/** The plain station trunk of stations [i0, i1] (Echo, Sprout, Drift; Line at depth 0 equals it). */
export function plainTrunk(cx: FormCx, i0: number, i1: number, style: TrunkStyle, unit: number, T: TrunkPts, out: Sink): void {
  T.reset();
  stationTrunk(cx, i0, i1, style.w, T);
  writeTrunk(T, cx.r.stroke.nib === 'chisel' ? PolyKind.Chisel : PolyKind.Ribbon, style.alpha, unit, cx.r.seed, out);
}
