/**
 * Echo v1 (DESIGN §2.3.4): Self-Koch. The stroke becomes its own generator and repeats
 * inside itself. Echo is the one GLOBAL Form: its crystal depends on the whole spine, so
 * it is built at lift; while drawing, a provisional ghost (an 8-vertex uniform generator,
 * depth ≤ 3, α 0.3) stands in, and the trunk is cooked incrementally like every Form.
 *
 * Generator: RDP of the spine at ε = 3% of the chord, 4–12 vertices (fewer than 4: a
 * uniform 5-vertex resample; more than 12: ε × 1.5 until it fits), normalised to a unit
 * chord. RDP keeps the corners you drew.
 *
 * Depth d = n + f: substitution levels 1..n+1 are full and level n+2 folds out by f; a
 * new vertex lerps from its position ON its parent segment (at its arc fraction along the
 * generator, so f = 0 is exactly the parent curve) to its final position. Depth 0 is the
 * generator itself. Caps (the halo ceiling): sides·nSeg^(n+1) ≤ 32k, and
 * (arcLen/chord)^(n+1) ≤ 40 when the generator is longer than its chord.
 *
 * Shapes: open strokes recurse on their chord (bumps as drawn); closed loops become a
 * snowflake on the thirds-by-arc triangle with the generator of arc A→B and bumps facing
 * away from the centroid; a nearly symmetric generator (|area| < 0.05) flips alternate
 * copies. A radial seed is a hexagonal Koch snowflake.
 *
 * Decisions:
 *  - The trunk (spec: α 0.55, width × 0.6) blends from the bare nib at base 0 to that style
 *    by smoothstep(0, 0.5, base), so "depth 0 is the bare nib for every Form" holds for
 *    Echo too. It depends on base only (frozen at pen-down), never on pools, so rising
 *    re-cooks only the ghost.
 *  - Width uses 0.78^d (continuous in d) instead of 0.78^n.
 *  - The crystal is emitted in chunks of ≤ 256 points sharing their joints, so culling and
 *    dirty rects stay tight and its tone follows the pressure along the crystal.
 *  - Exposure baked into alpha is the Night rule; `coverage` lets the raster apply Paper's.
 *  - Fold-out sources (MorphSet.from) are each vertex's position at depth 0: the crystal
 *    unfolds out of the stroke's own simplified shape.
 */
import type { RecipeCore, Spine } from '../../core/types';
import { PolyKind } from '../../core/types';
import { rnd, Ch, dcos, dsin, dpow, PI } from '../../core/det';
import { clamp, lerp, smoothstep } from '../../core/num';
import { rdpIndices } from '../../core/geom';
import type { FormCx, FormOps, RadialSeed, Sampler, Sink, TrunkStyle } from './types';
import { toneOf, glow } from './types';
import { RADIAL_ID } from './line.v1';

/** Point budget of a crystal. */
export const ECHO_BUDGET = 32000;
/** Growth-ratio cap. */
const RATIO_CAP = 40;
/** Generator vertex range. */
const VMIN = 4, VMAX = 12;
/** Points per crystal poly (chunks share their joint point). */
const CHUNK = 256;
/** Ghost: uniform generator vertices, depth cap and alpha. */
export const GHOST_V = 8, GHOST_DEPTH = 3, GHOST_ALPHA = 0.3;
/** Shorter chords (sp) on open strokes fall back to Line. */
export const MIN_CHORD = 12;
const DMAX = 5;

function g64(a: Float64Array, need: number): Float64Array {
  if (need <= a.length) return a;
  let c = a.length * 2 || 64;
  while (c < need) c *= 2;
  const b = new Float64Array(c); b.set(a.subarray(0, a.length)); return b;
}

/** A crystal plan: normalised generator, the sides it recurses on, orientation and cap. */
export class Plan {
  gx: Float64Array = new Float64Array(16); gy: Float64Array = new Float64Array(16); gu: Float64Array = new Float64Array(16); nSeg = 0;
  area = 0; ratio = 1; ybar = 0;
  sides: Float64Array = new Float64Array(24); nSides = 0;
  sigma = 1; flip = false; N = 0;

  /** Normalise vertices (interleaved doc xy, nV of them) to the unit chord first→last. */
  setGenerator(v: ArrayLike<number>, nV: number): boolean {
    const ax = v[0], ay = v[1], dx = v[2 * nV - 2] - ax, dy = v[2 * nV - 1] - ay, D2 = dx * dx + dy * dy;
    if (!(D2 > 0) || nV < 2) return false;
    if (nV > this.gx.length) { this.gx = new Float64Array(nV); this.gy = new Float64Array(nV); this.gu = new Float64Array(nV); }
    let len = 0, area = 0, yb = 0;
    for (let k = 0; k < nV; k++) {
      const qx = v[2 * k] - ax, qy = v[2 * k + 1] - ay;
      this.gx[k] = (qx * dx + qy * dy) / D2; this.gy[k] = (qy * dx - qx * dy) / D2;
      if (k > 0) {
        const ex = this.gx[k] - this.gx[k - 1], ey = this.gy[k] - this.gy[k - 1], l = Math.sqrt(ex * ex + ey * ey);
        len += l; yb += 0.5 * (this.gy[k] + this.gy[k - 1]) * l;
        area += this.gx[k - 1] * this.gy[k] - this.gx[k] * this.gy[k - 1];
      }
      this.gu[k] = len;
    }
    this.gx[0] = 0; this.gy[0] = 0; this.gx[nV - 1] = 1; this.gy[nV - 1] = 0;
    for (let k = 0; k < nV; k++) this.gu[k] = len > 0 ? this.gu[k] / len : k / (nV - 1);
    this.gu[nV - 1] = 1;
    this.nSeg = nV - 1;
    this.area = 0.5 * area; this.ratio = len; this.ybar = yb;
    this.flip = Math.abs(this.area) < 0.05;
    return true;
  }

  /** One side per segment of a closed polygon (interleaved xy), bumps away from its centroid. */
  setPolygon(v: ArrayLike<number>, nV: number): void {
    let cx = 0, cy = 0;
    for (let k = 0; k < nV; k++) { cx += v[2 * k]; cy += v[2 * k + 1]; }
    cx /= nV; cy /= nV;
    this.sides = g64(this.sides, 4 * nV);
    for (let k = 0; k < nV; k++) {
      const m = (k + 1) % nV, o = 4 * k;
      this.sides[o] = v[2 * k]; this.sides[o + 1] = v[2 * k + 1]; this.sides[o + 2] = v[2 * m]; this.sides[o + 3] = v[2 * m + 1];
    }
    this.nSides = nV;
    // bumps go toward sign(ybar)·perp(e − s); choose σ so that is outward on side 0
    const ex = v[2] - v[0], ey = v[3] - v[1], mx = 0.5 * (v[0] + v[2]) - cx, my = 0.5 * (v[1] + v[3]) - cy;
    const outward = -ey * mx + ex * my > 0 ? 1 : -1;
    const yb = this.ybar >= 0 ? 1 : -1;
    this.sigma = outward * yb;
  }

  /** A single side (open stroke): the chord, bumps as drawn. */
  setChord(ax: number, ay: number, bx: number, by: number): void {
    this.sides[0] = ax; this.sides[1] = ay; this.sides[2] = bx; this.sides[3] = by;
    this.nSides = 1; this.sigma = 1;
  }

  /** Realisable depth cap: sides·nSeg^(n+1) ≤ 32k and ratio^(n+1) ≤ 40, n ≤ dMax. */
  caps(dMax: number): number {
    let n = 0;
    for (let m = 1; m <= dMax; m++) {
      let segs = this.nSides;
      for (let q = 0; q <= m; q++) segs *= this.nSeg;
      if (segs > ECHO_BUDGET) break;
      if (this.ratio > 1.02 && dpow(this.ratio, m + 1) > RATIO_CAP) break;
      n = m;
    }
    this.N = n;
    return n;
  }
}

// ---------------------------------------------------------------- generator extraction

let tmpXY: Float64Array = new Float64Array(256);
const pv = new Float64Array(2), tri = new Float64Array(6);

/** Polyline of the spine over arc [sa, sb] (stations inside plus interpolated ends) into tmpXY; returns vertex count. */
function arcPolyline(at: Sampler, sa: number, sb: number): number {
  const sp = at.sp, S = sp.s, hi = at.hi;
  tmpXY = g64(tmpXY, 2 * (hi + 3));
  const v = pv;
  at.pos(sa, v); tmpXY[0] = v[0]; tmpXY[1] = v[1];
  let n = 1;
  for (let i = 0; i <= hi; i++) {
    if (S[i] <= sa || S[i] >= sb) continue;
    tmpXY[2 * n] = sp.x[i]; tmpXY[2 * n + 1] = sp.y[i]; n++;
  }
  at.pos(sb, v); tmpXY[2 * n] = v[0]; tmpXY[2 * n + 1] = v[1];
  return n + 1;
}

const genV = new Float64Array(2 * 64);

/** Uniform resample of arc [sa, sb] to nV vertices into genV. */
function uniformVerts(at: Sampler, sa: number, sb: number, nV: number): void {
  const v = pv;
  for (let k = 0; k < nV; k++) {
    at.pos(sa + ((sb - sa) * k) / (nV - 1), v);
    genV[2 * k] = v[0]; genV[2 * k + 1] = v[1];
  }
}

/** RDP generator of arc [sa, sb] (ε = 3% of chord, 4–12 vertices) into plan; false if degenerate. */
function rdpGenerator(at: Sampler, sa: number, sb: number, z: number, plan: Plan): boolean {
  const n = arcPolyline(at, sa, sb);
  const xy = tmpXY.subarray(0, 2 * n);
  const dx = xy[2 * n - 2] - xy[0], dy = xy[2 * n - 1] - xy[1];
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (!(chord * z > 1e-6)) return false;
  let eps = 0.03 * chord, idx = rdpIndices(xy, eps);
  for (let guard = 0; idx.length > VMAX && guard < 64; guard++) { eps *= 1.5; idx = rdpIndices(xy, eps); }
  if (idx.length < VMIN) {
    uniformVerts(at, sa, sb, 5);
    return plan.setGenerator(genV, 5);
  }
  for (let k = 0; k < idx.length; k++) { genV[2 * k] = xy[2 * idx[k]]; genV[2 * k + 1] = xy[2 * idx[k] + 1]; }
  return plan.setGenerator(genV, idx.length);
}

/**
 * Plan the crystal of a spine read through `at` (stations [0, at.hi]): an RDP generator
 * (final) or a uniform GHOST_V one (ghost); a chord, or the thirds triangle when closed.
 * Returns false when there is no usable chord.
 */
export function planCrystal(at: Sampler, z: number, closed: boolean, uniform: boolean, plan: Plan, dMax: number): boolean {
  const sp: Spine = at.sp, hi = at.hi;
  if (hi < 1) return false;
  const s0 = sp.s[0], L = sp.s[hi], len = L - s0;
  if (!(len > 0)) return false;
  if (closed) {
    const sA = s0, sB = s0 + len / 3, sC = s0 + (2 * len) / 3;
    const ok = uniform ? (uniformVerts(at, sA, sB, GHOST_V), plan.setGenerator(genV, GHOST_V)) : rdpGenerator(at, sA, sB, z, plan);
    if (!ok) return false;
    const v = pv;
    at.pos(sA, v); tri[0] = v[0]; tri[1] = v[1];
    at.pos(sB, v); tri[2] = v[0]; tri[3] = v[1];
    at.pos(sC, v); tri[4] = v[0]; tri[5] = v[1];
    plan.setPolygon(tri, 3);
  } else {
    const ok = uniform ? (uniformVerts(at, s0, L, GHOST_V), plan.setGenerator(genV, GHOST_V)) : rdpGenerator(at, s0, L, z, plan);
    if (!ok) return false;
    plan.setChord(sp.x[0], sp.y[0], sp.x[hi], sp.y[hi]);
  }
  plan.caps(dMax);
  return true;
}

/** Chord of a spine (sp). */
export function chordSp(sp: Spine, hi: number, z: number): number {
  const dx = sp.x[hi] - sp.x[0], dy = sp.y[hi] - sp.y[0];
  return Math.sqrt(dx * dx + dy * dy) * z;
}

// ---------------------------------------------------------------- crystal

let cA: Float64Array = new Float64Array(64), cB: Float64Array = new Float64Array(64);
let fA: Float64Array = new Float64Array(64), fB: Float64Array = new Float64Array(64);
/** Crystal vertices (interleaved) and fold-out sources of the last build. */
export let crystalXY: Float64Array = new Float64Array(64);
export let crystalFrom: Float64Array = new Float64Array(64);

/**
 * Build the crystal polyline at depth d (clamped to [0, plan.N]) into crystalXY, and the
 * depth-0 positions of its vertices into crystalFrom. Returns the vertex count.
 */
export function buildCrystal(plan: Plan, d: number): number {
  const D = clamp(d, 0, plan.N), n = Math.floor(D), f = D - n;
  const levels = n + 1 + (f > 0 ? 1 : 0), nSeg = plan.nSeg;
  let per = 1;
  for (let q = 0; q < levels; q++) per *= nSeg;
  const total = plan.nSides * per + 1;
  crystalXY = g64(crystalXY, 2 * total); crystalFrom = g64(crystalFrom, 2 * total);
  cA = g64(cA, 2 * (per + 1)); cB = g64(cB, 2 * (per + 1)); fA = g64(fA, 2 * (per + 1)); fB = g64(fB, 2 * (per + 1));
  const gx = plan.gx, gy = plan.gy, gu = plan.gu;
  let w = 0;
  for (let side = 0; side < plan.nSides; side++) {
    const o = 4 * side;
    let cur = cA, nxt = cB, fc = fA, fn = fB;
    cur[0] = fc[0] = plan.sides[o]; cur[1] = fc[1] = plan.sides[o + 1];
    cur[2] = fc[2] = plan.sides[o + 2]; cur[3] = fc[3] = plan.sides[o + 3];
    let nv = 2;
    for (let L = 1; L <= levels; L++) {
      const phi = L <= n + 1 ? 1 : f, phiF = L === 1 ? 1 : 0;
      let m = 0;
      for (let i = 0; i < nv - 1; i++) {
        const sx = cur[2 * i], sy = cur[2 * i + 1], dx = cur[2 * i + 2] - sx, dy = cur[2 * i + 3] - sy;
        const tx = fc[2 * i], ty = fc[2 * i + 1], ex = fc[2 * i + 2] - tx, ey = fc[2 * i + 3] - ty;
        const fl = plan.sigma * (plan.flip && (i & 1) ? -1 : 1);
        for (let k = 0; k < nSeg; k++) {
          const ux = gu[k] + (gx[k] - gu[k]) * phi, uy = gy[k] * fl * phi;
          nxt[2 * m] = sx + ux * dx - uy * dy; nxt[2 * m + 1] = sy + ux * dy + uy * dx;
          const vx = gu[k] + (gx[k] - gu[k]) * phiF, vy = gy[k] * fl * phiF;
          fn[2 * m] = tx + vx * ex - vy * ey; fn[2 * m + 1] = ty + vx * ey + vy * ex;
          m++;
        }
      }
      nxt[2 * m] = cur[2 * nv - 2]; nxt[2 * m + 1] = cur[2 * nv - 1];
      fn[2 * m] = fc[2 * nv - 2]; fn[2 * m + 1] = fc[2 * nv - 1];
      nv = m + 1;
      const t1 = cur; cur = nxt; nxt = t1;
      const t2 = fc; fc = fn; fn = t2;
    }
    // sides share their corner vertex: skip the first vertex of every side after the first
    for (let k = side === 0 ? 0 : 1; k < nv; k++) {
      crystalXY[2 * w] = cur[2 * k]; crystalXY[2 * w + 1] = cur[2 * k + 1];
      crystalFrom[2 * w] = fc[2 * k]; crystalFrom[2 * w + 1] = fc[2 * k + 1];
      w++;
    }
  }
  return w;
}

let cw: Float64Array = new Float64Array(64), cu: Float64Array = new Float64Array(64);

/** Pressure along the crystal at normalised arc u. */
export interface PressureAlong { p(u: number): number }
/** Pressure of the spine at arc s0 + u·len (reusable, no closure per call). */
export class SpinePressure implements PressureAlong {
  at: Sampler | null = null; s0 = 0; len = 0;
  set(at: Sampler, s0: number, len: number): this { this.at = at; this.s0 = s0; this.len = len; return this; }
  p(u: number): number { const a = this.at!; return a.at(a.sp.p, this.s0 + u * this.len); }
}
/** A constant pressure. */
export class ConstPressure implements PressureAlong {
  v = 0;
  set(v: number): this { this.v = v; return this; }
  p(): number { return this.v; }
}
const ghostP = new SpinePressure(), radialP = new ConstPressure();

/** Result of emitting a crystal. */
export interface CrystalOut { coverage: number; points: number }

/**
 * Emit the crystal built by buildCrystal (nv vertices) as gen-1 Ribbon chunks.
 * Width = max(0.35 sp, meanW·(0.35 + 0.9p(u))·0.78^d), p(u) from `pAt` (u = normalised arc
 * on the crystal). Alpha = baseAlpha × Night exposure(cov) unless `exposure` is false.
 * When `from` is given, every emitted point's fold-out source is appended to it (aligned
 * with the points the sink receives).
 */
export function emitCrystal(nv: number, d: number, meanW: number, z: number, pAt: PressureAlong,
  baseAlpha: number, dBucket: number, born: number, exposure: boolean, out: Sink, from: { push2(a: number, b: number): void } | null, res: CrystalOut): void {
  res.coverage = 0; res.points = 0;
  if (nv < 2) return;
  cw = g64(cw, nv); cu = g64(cu, nv);
  const P = crystalXY;
  let len = 0;
  cu[0] = 0;
  for (let k = 1; k < nv; k++) {
    const dx = P[2 * k] - P[2 * k - 2], dy = P[2 * k + 1] - P[2 * k - 1];
    len += Math.sqrt(dx * dx + dy * dy); cu[k] = len;
  }
  const scale = meanW * dpow(0.78, d), floor = 0.35 / z;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ink = 0;
  for (let k = 0; k < nv; k++) {
    const u = len > 0 ? cu[k] / len : 0;
    const w = Math.max(floor, scale * (0.35 + 0.9 * pAt.p(u)));
    cw[k] = w;
    const x = P[2 * k], y = P[2 * k + 1], h = 0.5 * w;
    if (x - h < x0) x0 = x - h; if (x + h > x1) x1 = x + h;
    if (y - h < y0) y0 = y - h; if (y + h > y1) y1 = y + h;
    if (k > 0) ink += 0.5 * (w + cw[k - 1]) * (cu[k] - cu[k - 1]);
  }
  const area = (x1 - x0) * (y1 - y0);
  const cov = area > 0 ? ink / area : 0;
  res.coverage = cov;
  const alpha = exposure ? baseAlpha * Math.min(1, 0.55 / Math.sqrt(Math.max(cov, 0.3))) : baseAlpha;
  for (let k0 = 0; k0 < nv - 1; k0 += CHUNK - 1) {
    const k1 = Math.min(nv - 1, k0 + CHUNK - 1);
    const u0 = len > 0 ? cu[k0] / len : 0;
    out.begin(PolyKind.Ribbon, 1, alpha, toneOf(pAt.p(u0), dBucket), born, 0, 1);
    for (let k = k0; k <= k1; k++) {
      out.pt(P[2 * k], P[2 * k + 1], cw[k]);
      if (from) from.push2(crystalFrom[2 * k], crystalFrom[2 * k + 1]);
    }
    res.points += out.end();
  }
}

/** Crystal depth bucket: d01 = min(1, d_E/5), bucket = round(4·d01). */
export const crystalBucket = (dE: number): number => Math.round(4 * Math.min(1, Math.max(0, dE) / 5));
/** Crystal fade-in: smoothstep(0, 0.5, d_E). */
export const crystalFade = (dE: number): number => smoothstep(0, 0.5, dE);

/** Mean untapered width and crowding of stations [0, hi]. */
export function spineMeans(sp: Spine, hi: number, out: { w: number; c: number; p: number }): void {
  let w = 0, c = 0, p = 0;
  for (let i = 0; i <= hi; i++) { w += sp.w[i]; c += sp.c[i]; p += sp.p[i]; }
  const k = hi >= 0 ? 1 / (hi + 1) : 0;
  out.w = w * k; out.c = c * k; out.p = p * k;
}

const ghostPlan = new Plan();
const gm = { w: 0, c: 0, p: 0 };
const gres: CrystalOut = { coverage: 0, points: 0 };

/**
 * Live ghost of the current spine: a uniform 8-vertex generator (snowflake when closing) at
 * depth min(d_E, 3) and α 0.3·fade. Returns the ghost's depth cap (for the live ceiling).
 */
export function echoGhost(cx: FormCx, dE: number, closing: boolean, out: Sink): number {
  if (!planCrystal(cx.at, cx.z, closing, true, ghostPlan, DMAX)) return DMAX;
  const fade = crystalFade(dE);
  if (fade > 0) {
    const d = Math.min(dE, GHOST_DEPTH, ghostPlan.N);
    const nv = buildCrystal(ghostPlan, d);
    spineMeans(cx.sp, cx.at.hi, gm);
    emitCrystal(nv, d, gm.w, cx.z, ghostP.set(cx.at, cx.s0, cx.L - cx.s0), GHOST_ALPHA * fade, crystalBucket(dE), cx.s0, false, out, null, gres);
  }
  return ghostPlan.N;
}

const hexV = new Float64Array(12), koch = new Float64Array(10);
const radialPlan = new Plan();

/**
 * Radial Echo: a hexagonal snowflake of radius (6 + S)(0.6 + 0.8p) sp whose generator is a
 * 4-segment Koch bump of height 0.29(0.6 + 0.8p), every bump outward (never flipped).
 */
function echoRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const r = cx.r, z = cx.z, p = seed.p, k = 0.6 + 0.8 * p;
  const R = (6 + r.stroke.size) * k / z, h = 0.29 * k;
  koch[0] = 0; koch[1] = 0; koch[2] = 1 / 3; koch[3] = 0; koch[4] = 0.5; koch[5] = h; koch[6] = 2 / 3; koch[7] = 0; koch[8] = 1; koch[9] = 0;
  radialPlan.setGenerator(koch, 5);
  // The bump's area is h/6, under the 0.05 flip threshold for p < ~0.58; the flip rule is for
  // drawn generators. A radial snowflake's bumps all face outward (DESIGN §2.3.8).
  radialPlan.flip = false;
  const rot0 = (PI / 3) * rnd(r.seed, Ch.Angle, RADIAL_ID, 2);
  for (let i = 0; i < 6; i++) {
    const a = rot0 + (PI / 3) * i;
    hexV[2 * i] = seed.x + R * dcos(a); hexV[2 * i + 1] = seed.y + R * dsin(a);
  }
  radialPlan.setPolygon(hexV, 6);
  radialPlan.caps(DMAX);
  const D = clamp(depth, 0, radialPlan.N);
  const fade = crystalFade(D);
  if (!(fade > 0)) return D;
  const nv = buildCrystal(radialPlan, D);
  emitCrystal(nv, D, seed.w, z, radialP.set(p), fade * glow(seed.c), crystalBucket(D), cx.s0, true, out, null, gres);
  return D;
}

/** Trunk style: blends from the bare nib (base 0) to α 0.55, width × 0.6. */
function echoTrunk(r: RecipeCore): TrunkStyle {
  const k = smoothstep(0, 0.5, r.form.base);
  return { w: lerp(1, 0.6, k), alpha: lerp(1, 0.55, k) };
}

/** Echo v1. */
export const echo: FormOps = {
  id: 'echo', v: 1, locality: 'global', reach: Infinity, dMax: DMAX, baseDefault: 2,
  unitBudget: ECHO_BUDGET, strokeBudget: ECHO_BUDGET,
  trunkStyle: echoTrunk,
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain: null,
  radial: echoRadial,
  radialCeiling: DMAX,
};
