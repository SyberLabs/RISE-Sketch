/**
 * Drift v2 (DESIGN §2.3.6): v1's attractor wake, poured off the trunk's edge.
 *
 * Why v2. Under additive Night ink ('lighter') the trunk and the filaments sit in different
 * raster batches (alpha and tone differ), so wherever a filament lies on the trunk the two ADD.
 * v1 released every filament on the trunk's CENTRELINE at 0.55 × the stroke width, inside a
 * trunk 0.8 × wide, and with momentum along the tangent (or a field running with the stroke)
 * it stayed inside for a long way: a new one every ~5 sp, so the trunk became a near-white core
 * with a thin coloured rim, worst at large brush sizes. (On Paper, multiply darkened the same
 * overlaps; v1 stays as is for the recipes drawn with it.)
 *
 * The fix is geometric: a filament never stacks on the trunk it pours off.
 *  - It leaves on the side its first heading points to (the side the field pushes toward: the
 *    heading is F + m·T and T has no normal part), from just outside the trunk's edge:
 *        x_0 = P(σ) + side·N(σ)·(0.4·w(σ) + m),   m = 0.2 sp of clearance kept
 *    (pushed further out where a corner or a hairpin puts the trunk there too), so it moves away
 *    from the trunk or runs alongside it, never back across its root.
 *  - Its width tapers in from the edge: each point carries its allowance (cooked once, at the
 *    ceiling), the room between its centreline and the trunk's edge along its normal,
 *        w ≤ 2·(d − h − m)/κ                  beside the trunk (a band)
 *        w ≤ 2·(a − √(a² − d² + (h + m)²))    off a round end (the stroke's ends, a radial
 *                                              seed's dot; a = |v·n|, v from its centre)
 *    with d the distance to the trunk's centreline, h the trunk's half width there, n the
 *    filament's normal and κ = |cos φ| (φ the angle between the filament and the trunk). The
 *    trunk is the stretch it pours off: the unit's spine window s ± 6 sp (its stations, at the
 *    untapered width 0.8·w(s')), continued by tangent rays along the root (until the filament
 *    first clears it at full width) where the window is not the stroke's end. Leaving square to
 *    the stroke a filament opens at once; running alongside it stays a hairline on the edge until
 *    it peels away, so the edge sprouts fine wisps that thicken as they leave, not a solid sleeve
 *    of roots; one the field brings back across that stretch passes under it as a hairline.
 *  - A radial seed's 24 filaments start the same way off the seed dot's rim.
 * What it cannot remove: a filament the field carries onto another part of the stroke (further
 * along, or a stroke that curls back on itself) still adds where it crosses it, like any two
 * crossing lines of light; that is a crossing, not a root.
 *
 * Everything else is v1: stations, the field, momentum, jitter, step counts, lengths, tapers,
 * tones, alphas, budgets. Each filament writes exactly v1's points (the allowance only narrows
 * widths), so ceilings and budgets count the same; positions and allowances are cooked once at
 * the ceiling and the allowance is a function of position along the filament only, so
 * truncation stays a prefix and the depth stays continuous.
 *
 *   σ_0 = s0 + 2.5,  σ_{m+1} = σ_m + 5·(1 + c(σ_m)) sp       resumable chain
 *   n_max = round(150·(0.35 + 0.9p)·(1 − 0.5c)) steps of 1.7 sp   (cooked once, at the ceiling)
 *   n(d)  = n_max·N(d)/150,  N(d) = 18·min(d, 1) + 26.4·max(0, d − 1)   (N(6) = 150)
 *   dir_k = normalize(F(x_k) + 0.8·smoothstep(0.3, 2, v_n)·0.95^k·T),  then jitter ±0.14 rad
 *   width = min(0.55·w(σ)·E_in(σ)·(1 − k/n)², allowance_k)    recomputed whenever truncated
 *
 * The field's lattice is λ/2 = 140 sp at the commit zoom (λ_doc = 280/z), so zooming out
 * gives broad currents and zooming in fine eddies. Each filament is split into thirds of
 * its drawn steps with depth tones 0.2 / 0.5 / 0.8 (dBucket 1, 2, 3): the wake deepens in
 * colour as it fades. The thirds share their joints exactly, so they weld at tessellation.
 *
 * Decisions (v1's):
 *  - n_max is clamped to [6, 150] (the spec's 150-steps-per-filament budget; 6 is the
 *    demo's minimum) so every unit's ceiling is dMax.
 *  - Widths are floored at 0.28 sp (the demo's floor) so the fading tail stays a hairline.
 *  - A filament shorter than 3 sp is one poly (dBucket 1) rather than three slivers.
 *  - Radial seeds throw outward with momentum 2.5 (decaying 0.95 per step), not a speed-gated
 *    0.8: a still tap has v_n ≈ 0, and even 0.8 loses to the unit field at once, so the 24
 *    filaments swept to one side. 2.5 keeps the emission radial for ~30 sp (DESIGN §2.3.8).
 */
import { PolyKind } from '../../core/types';
import { rnd, Ch, dcos, dsin, PI } from '../../core/det';
import { clamp, smoothstep } from '../../core/num';
import { JIT_COS, JIT_N, JIT_SIN } from '../noise';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from './types';
import { UnitGeom, toneOf, glow } from './types';
import { RADIAL_ID } from './line.v1';

/** Step length (sp) and the most steps a filament may take. */
const STEP = 1.7, NMAX = 150, NMIN = 6;
/** Filament alpha (Night; Paper's 0.30 is applied at raster: registry.paperAlphaScale). */
const ALPHA = 0.38;
/** Window (sp) of spine a station reads either side (tangent smoothed over 6 sp). */
const WIN = 6;
/** Width factor and floor (sp). */
const WF = 0.55, W_FLOOR = 0.28;
const STROKE_BUDGET = 30000;
/** Radial emission: 24 filaments at 15°·i with ±7.5° jitter. */
const RADIAL_N = 24, RADIAL_STEP = PI / 12;
/**
 * Outward momentum of a radial emission (decays 0.95 per step like a stroke's). It must beat
 * the unit field for a while: at 0.8 the upstream half turned downstream at once and a tap
 * read as a one-sided comet; at 2.5 it reads as a burst for ~30 sp, then pours into the current.
 */
const RADIAL_THROW = 2.5;
/** Trunk width multiplier (trunkStyle; the seed dot is as wide) and the clearance kept outside its edge (sp). */
const TRUNK_W = 0.8, CLEAR_SP = 0.2;
/** Trunk window either side of the station (sp): the unit's spine window. */
const TRUNK_HALF = WIN;
/** Floor of κ = |cos φ|: a filament nearly square to the trunk may widen 1/0.12 × as fast as it clears. */
const KAPPA_MIN = 0.12;

/** Steps drawn at depth d for a filament of n_max steps (fractional). */
export function drawnSteps(nmax: number, d: number): number {
  const D = clamp(d, 0, 6);
  const nd = (nmax * (18 * Math.min(D, 1) + 26.4 * Math.max(0, D - 1))) / NMAX;
  return nd < nmax ? nd : nmax;
}

const pos = new Float64Array(2), tan = new Float64Array(2), nrm = new Float64Array(2), F = new Float64Array(2);
const v2 = new Float64Array(2);

/** Walk one filament from (x, y) with momentum direction (tx, ty) into branch 0 of g. */
function walk(cx: FormCx, g: UnitGeom, x: number, y: number, tx: number, ty: number, mw: number, nmax: number, addr: number): number {
  const z = cx.z, field = cx.curl(), seed = cx.r.seed, d = STEP / z;
  const b = g.beginBranch(1, nmax * STEP);
  g.addPt(x, y, 0);
  let m = mw;
  for (let k = 0; k < nmax; k++) {
    let vx = m * tx, vy = m * ty;
    if (field.dir(x, y, F)) { vx += F[0]; vy += F[1]; }
    let l = Math.sqrt(vx * vx + vy * vy);
    if (!(l > 1e-12)) { vx = tx; vy = ty; l = 1; }
    vx /= l; vy /= l;
    const j = Math.floor(rnd(seed, Ch.Jitter, addr, k) * JIT_N);
    const c = JIT_COS[j], s = JIT_SIN[j];
    x += (vx * c - vy * s) * d; y += (vx * s + vy * c) * d;
    g.addPt(x, y, (k + 1) * STEP);
    m *= 0.95;
  }
  g.endBranch(b);
  return b;
}

// ---------------------------------------------------------------------------- the trunk as a parent

/**
 * The ribbon a filament pours off: a centreline polyline (doc) with its half width per point,
 * and whether each end continues as a ray (a window cut of a longer trunk) or is a real, round
 * end. A single point is a round end: the radial seed's dot.
 */
let TX = new Float64Array(32), TY = new Float64Array(32), TH = new Float64Array(32);
let tN = 0, tRayStart = false, tRayEnd = false;

/**
 * Result of near(): distance, the vector from the nearest point, unit direction of the nearest
 * segment, half width there, and whether it is a round end.
 */
let nD = 0, nVx = 0, nVy = 0, nUx = 1, nUy = 0, nH = 0, nEnd = false;

/** Nearest point of the parent's centreline to (px, py). */
function near(px: number, py: number): void {
  let best = Infinity;
  nUx = 1; nUy = 0; nH = TH[0]; nEnd = true;
  for (let j = 0; j + 1 < tN; j++) {
    const dx = TX[j + 1] - TX[j], dy = TY[j + 1] - TY[j], L2 = dx * dx + dy * dy;
    if (!(L2 > 1e-18)) continue;
    let t = ((px - TX[j]) * dx + (py - TY[j]) * dy) / L2;
    let end = false;
    if (t < 0 && !(j === 0 && tRayStart)) { t = 0; end = j === 0; }
    else if (t > 1 && !(j + 2 === tN && tRayEnd)) { t = 1; end = j + 2 === tN; }
    const qx = TX[j] + dx * t, qy = TY[j] + dy * t;
    const d2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
    if (d2 < best) {
      best = d2;
      const L = Math.sqrt(L2), tc = t < 0 ? 0 : t > 1 ? 1 : t;
      nUx = dx / L; nUy = dy / L; nEnd = end; nVx = px - qx; nVy = py - qy;
      nH = TH[j] + (TH[j + 1] - TH[j]) * tc;
    }
  }
  if (!(best < Infinity)) { nVx = px - TX[0]; nVy = py - TY[0]; best = nVx * nVx + nVy * nVy; }
  nD = Math.sqrt(best);
}

function pushTrunk(x: number, y: number, h: number): void {
  if (tN === TX.length) {
    const c = 2 * tN, x2 = new Float64Array(c), y2 = new Float64Array(c), h2 = new Float64Array(c);
    x2.set(TX); y2.set(TY); h2.set(TH); TX = x2; TY = y2; TH = h2;
  }
  TX[tN] = x; TY[tN] = y; TH[tN] = h; tN++;
}

/**
 * The trunk around station s as the parent: its centreline over s ± 6 sp (the unit's window:
 * the ends interpolated, every station between, so corners are kept; the sampler clamps at the
 * stroke's ends) at the untapered trunk width (operators never see the envelope; the drawn
 * trunk is never wider, but for the seated bulb's ×1.12 over the last 3 sp). An end continues
 * as a tangent ray unless the window reached the stroke's end there (a real, round end).
 */
function trunkParent(cx: FormCx, s: number): void {
  const sp = cx.sp, at = cx.at, S = sp.s, hi = at.hi, s0 = s - TRUNK_HALF, s1 = s + TRUNK_HALF, hw = 0.5 * TRUNK_W;
  tN = 0;
  at.pos(s0, v2);
  pushTrunk(v2[0], v2[1], hw * at.at(sp.w, s0));
  for (let i = at.locate(s0) + 1; i <= hi && S[i] < s1; i++) if (S[i] > s0) pushTrunk(sp.x[i], sp.y[i], hw * sp.w[i]);
  at.pos(s1, v2);
  pushTrunk(v2[0], v2[1], hw * at.at(sp.w, s1));
  tRayStart = s0 >= cx.s0;
  tRayEnd = s1 <= cx.L;
}

/** The seed dot as the parent: a round end of radius 0.4·w. */
function dotParent(seed: RadialSeed): void {
  TX[0] = seed.x; TY[0] = seed.y; TH[0] = 0.5 * TRUNK_W * seed.w; tN = 1;
  tRayStart = false; tRayEnd = false;
}

/** Allowance (full width, doc) at a point heading (hx, hy) after near(), clearance m. */
function allowance(hx: number, hy: number, m: number): number {
  const hl = Math.sqrt(hx * hx + hy * hy);
  if (nEnd) {
    // off a disc of radius R = h + m: the edges at v ± (w/2)·n clear it while
    // w²/4 − a·w + D ≥ 0, a = |v·n|, D = |v|² − R²: up to the smaller root 2(a − √(a² − D))
    // (any width when a² < D: continued as 2(a + √(D − a²)), equal at a² = D); inside it the
    // reach 2(d − R) < 0
    const R = nH + m, D = nD * nD - R * R;
    if (!(D > 0)) return 2 * (nD - R);
    const vn = hl > 0 ? (nVy * hx - nVx * hy) / hl : 0, a = vn < 0 ? -vn : vn, e = a * a - D;
    return e > 0 ? 2 * (a - Math.sqrt(e)) : 2 * (a + Math.sqrt(-e));
  }
  const cs = hl > 0 ? (hx * nUx + hy * nUy) / hl : 1;
  let kap = cs < 0 ? -cs : cs;
  if (kap < KAPPA_MIN) kap = KAPPA_MIN;
  return (2 * (nD - nH - m)) / kap;
}

/**
 * Allowance (full width, doc) of every point of branch b against the parent, into g.aux (one
 * value per point): 2(d − h − m)/κ beside a band, 2(a − √(a² − |v|² + (h + m)²)) off a round
 * end (a = |v·n|, v from its centre, n the filament's normal; the reach 2(d − m − h) < 0 inside
 * it, continuous at the rim), with κ = |cos φ| between the filament's heading (the chord through
 * its neighbours, as the ribbon's joint normal) and the parent there.
 * The root (up to the first point that clears the parent at the filament's full nominal width
 * 0.55·w·(1 − k/n_max)²: no drawn width is wider, as E_in ≤ 1 and n(d) ≤ n_max) is cleared
 * against the window continued by its rays; past it the window's cut ends are round, so a
 * filament the field brings back across the stretch it poured off is pinched to a hairline
 * there (it passes under the trunk) while one merely passing the window's ends is not.
 */
function allowances(g: UnitGeom, b: number, w: number, z: number): void {
  const o = g.bOff[b], cnt = g.bCnt[b], m = CLEAR_SP / z, X = g.px, Y = g.py, q = g.aux;
  const rs = tRayStart, re = tRayEnd;
  let root = true;
  for (let k = 0; k < cnt; k++) {
    const i = o + k, ia = k > 0 ? i - 1 : i, ib = k + 1 < cnt ? i + 1 : i;
    near(X[i], Y[i]);
    const a = allowance(X[ib] - X[ia], Y[ib] - Y[ia], m);
    q[i] = a;
    if (root) {
      const u = 1 - k / (cnt - 1);
      if (a >= WF * w * u * u) { root = false; tRayStart = false; tRayEnd = false; }
    }
  }
  tRayStart = rs; tRayEnd = re;
}

/**
 * Push a start point (x, y) outward along (ux, uy) until it clears the parent by m (a corner
 * or a hairpin of the trunk can put the window's other leg there); into pos.
 */
function clearStart(x: number, y: number, ux: number, uy: number, m: number): void {
  for (let it = 0; it < 4; it++) {
    near(x, y);
    const short = nH + m - nD;
    if (!(short > 1e-9)) break;
    x += ux * (short + 1e-6); y += uy * (short + 1e-6);
  }
  pos[0] = x; pos[1] = y;
}

// ---------------------------------------------------------------------------- emit

/** Parts a filament drawn to nd steps is split into (thirds, or one when shorter than 3 sp). */
const partsOf = (nd: number): number => (nd * STEP < 3 ? 1 : 3);

/** Points emitFilament writes for nd drawn steps (each part: its two ends plus the steps inside). */
function filamentCount(nd: number): number {
  if (!(nd > 0)) return 0;
  const parts = partsOf(nd);
  let n = 0;
  for (let part = 0; part < parts; part++) {
    const k0 = (nd * part) / parts, k1 = (nd * (part + 1)) / parts;
    n += 2 + Math.max(0, Math.ceil(k1) - 1 - Math.floor(k0));
  }
  return n;
}

/** Emit filament (branch b of g) drawn to nd steps as up to three tone thirds. */
function emitFilament(g: UnitGeom, b: number, nd: number, w0: number, z: number, born: number, unit: number, out: Sink): number {
  if (!(nd > 0)) return 0;
  const o = g.bOff[b], floor = W_FLOOR / z, alpha = ALPHA * glow(g.c);
  const parts = partsOf(nd);
  let pts = 0;
  for (let part = 0; part < parts; part++) {
    const k0 = (nd * part) / parts, k1 = (nd * (part + 1)) / parts;
    out.begin(PolyKind.Ribbon, 1, alpha, toneOf(g.p, parts === 1 ? 1 : part + 1), born, unit, 1);
    // start (interpolated unless on a step), interior steps, end (interpolated unless on a step)
    emitAt(g, o, k0, nd, w0, floor, out);
    for (let k = Math.floor(k0) + 1; k < k1; k++) emitAt(g, o, k, nd, w0, floor, out);
    emitAt(g, o, k1, nd, w0, floor, out);
    pts += out.end();
  }
  return pts;
}

/**
 * The point at (fractional) step k: v1's tapered width, capped by the allowance (interpolated
 * linearly between steps, like the position), floored.
 */
function emitAt(g: UnitGeom, o: number, k: number, nd: number, w0: number, floor: number, out: Sink): void {
  const i = Math.floor(k), t = k - i;
  let x = g.px[o + i], y = g.py[o + i];
  let lim = g.aux[o + i];
  if (t > 0) {
    x += (g.px[o + i + 1] - x) * t; y += (g.py[o + i + 1] - y) * t;
    lim += (g.aux[o + i + 1] - lim) * t;
  }
  const u = 1 - k / nd;
  let w = w0 * u * u;
  if (lim < w) w = lim;
  out.pt(x, y, w > floor ? w : floor);
}

// ---------------------------------------------------------------------------- chain

/** Momentum weight from the stroke speed. */
const momentum = (vn: number): number => 0.8 * smoothstep(0.3, 2, vn);
/** Ceiling steps from pressure and crowding. */
const nmaxOf = (p: number, c: number): number => clamp(Math.round(NMAX * (0.35 + 0.9 * p) * (1 - 0.5 * c)), NMIN, NMAX);

const chain: ChainOperator = {
  halfWin: WIN,
  dMax: 6,
  unitBudget: NMAX + 1,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 + 2.5 : cur.s) + WIN;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    if (cur.phase === 0) { cur.s = cx.s0 + 2.5; cur.phase = 1; }
    const s = cur.s;
    rec.s = s; rec.j = cur.j; rec.side = 0; rec.tmpl = 0;
    cur.j++;
    cur.s = s + 5 * (1 + clamp(cx.at.at(cx.sp.c, s), 0, 1));
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s <= cx.L; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
    g.reset();
    const sp = cx.sp, at = cx.at, s = rec.s, z = cx.z;
    at.pos(s, pos); at.normal(s, nrm);
    tan[0] = -nrm[1]; tan[1] = nrm[0];
    const p = at.at(sp.p, s), c = at.at(sp.c, s);
    g.w = at.at(sp.w, s); g.p = p; g.c = c;
    const nmax = nmaxOf(p, c);
    g.k = nmax;
    // the side the first heading (F + m·T) points to is F's: a field running exactly along the
    // stroke (or none) picks one at random
    const fn = cx.curl().dir(pos[0], pos[1], F) ? F[0] * nrm[0] + F[1] * nrm[1] : 0;
    const side = fn > 0 ? 1 : fn < 0 ? -1 : rnd(cx.r.seed, Ch.Side, rec.j) < 0.5 ? 1 : -1;
    // from just outside the trunk's edge
    const off = side * (0.5 * TRUNK_W * g.w + CLEAR_SP / z), ux = side * nrm[0], uy = side * nrm[1];
    trunkParent(cx, s);
    clearStart(pos[0] + nrm[0] * off, pos[1] + nrm[1] * off, ux, uy, CLEAR_SP / z);
    const b = walk(cx, g, pos[0], pos[1], tan[0], tan[1], momentum(at.at(sp.vn, s)), nmax, rec.j);
    g.auxFit(g.nPts, 1);
    allowances(g, b, g.w, z);
    g.ceil = 6;
  },

  count(g: UnitGeom, D: number): number { return filamentCount(drawnSteps(g.k, D)); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return emitFilament(g, 0, drawnSteps(g.k, D), WF * g.w * eIn, cx.z, rec.s, rec.j, out);
  },
};

const rg = new UnitGeom();

/** Radial seed: 24 filaments at 15°·i plus jitter, thrown radially outward from the dot's rim. */
function driftRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, 6);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z, nmax = nmaxOf(seed.p, seed.c), nd = drawnSteps(nmax, D);
  rg.reset(); rg.p = seed.p; rg.c = seed.c;
  const off = 0.5 * TRUNK_W * seed.w + CLEAR_SP / z;
  for (let i = 0; i < RADIAL_N; i++) {
    const addr = (RADIAL_ID + 64 + i) | 0;
    const a = RADIAL_STEP * i + (rnd(r.seed, Ch.Angle, addr) - 0.5) * RADIAL_STEP;
    const ux = dcos(a), uy = dsin(a);
    walk(cx, rg, seed.x + ux * off, seed.y + uy * off, ux, uy, RADIAL_THROW, nmax, addr);
  }
  rg.auxFit(rg.nPts, 1);
  dotParent(seed);
  for (let b = 0; b < rg.nB; b++) allowances(rg, b, seed.w, z);
  for (let b = 0; b < rg.nB; b++) emitFilament(rg, b, nd, WF * seed.w, z, cx.s0, 0, out);
  return D;
}

/** Drift v2. */
export const drift: FormOps = {
  id: 'drift', v: 2, locality: 'local', reach: 12, dMax: 6, baseDefault: 2,
  unitBudget: NMAX + 1, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: TRUNK_W, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: driftRadial,
  radialCeiling: 6,
};
