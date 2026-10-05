/**
 * Orbit v1: epicycles around the nib (promoted from the forms lab, v106; brief: lab/forms/briefs/orbit.md).
 *
 * A satellite circles the nib as it travels; its trail (a trochoid in the moving frame
 * (t, n) of the spine) curls along the stroke as one unbroken rope of loops. Rising adds
 * epicycles, so every loop grows a scalloped lace edge and finally swells, like the edge of
 * a copperplate flourish. A tap draws a five-petal spirograph rose as a growing prefix.
 *
 * Unit j = one orbit over the arc [s_j, s_j + P_j]. Every orbit starts at phase 0 on +t, so
 * consecutive orbits (and the seam of a closed loop) join at a bit-identical point.
 *
 *   P(s)  = clamp((10 + 2S)(0.6 + 0.9·smoothstep(0.4, 2.4, v̄n)), 10, 36) sp     v̄n over ±12 sp
 *   R(s)  = (3.5 + 1.1S)(0.5 + p)(1 − 0.5·smoothstep(1, 2.6, vn))(1 − 0.4c) sp
 *   T(s)  = pos(s) + swell(D)·Σ_k f_k(D)·e_k(s),   e_k = R·ρ_k·M·(cos φ_k t + sin φ_k n)
 *   (m_k, ρ_k) = (1, 1), (+6, 0.13), (+11, 0.04);  φ_k = m_k·2πu,  u = (s − s_j)/P_j
 *   f_k(D) = clamp(D − k + 1, 0, 1);  swell(D) = 1 + 0.5·clamp(D − 3, 0, 1)
 *   M     = I − 0.6·cos(alt)·tv tvᵀ (pen lean: the circle seen in perspective)
 *   cs    : the n-component on the ink side × (1 − 0.6·|cs|)  (loops lean away from neighbours)
 *
 * (+6, 0.13) is five-fold (6 − 1 = 5): every loop grows five ROUND outward lobes (a cloud-scroll
 * frill); (+11, 0.04) is ten-fold, a scallop on every lobe (lace). Same-sense harmonics keep the
 * cusps inward and the velocity ratios (0.78, 0.44) < 1, so the edge never spikes.
 *
 * The unit is cooked ONCE at its ceiling: per sample the trunk position, the three epicycle
 * vectors (lean and cs applied) and the width profile; emit at depth D is a weighted sum,
 * so fractional depth is continuous by construction and rising never re-cooks. The orbit
 * is written as three polys split by thirds of u with tone buckets 1 / 2 / 3 (shared joints).
 * The phase advances by a fixed rotation recurrence and the spine is read by a monotone
 * station walker that reproduces Sampler.pos / normal bit for bit (no per-sample search).
 *
 * Width: brush 0.32·w'·(0.5 + 0.8·v̂), v̂ = normalised speed of the D = 1 trail: thick on the
 * outer sweep where the loops are apart (the flourish's belly), thin at the inner cusp;
 * pen 0.5·w (hairline), chisel 0.32·w'; w' = max(w, 0.4·S) so a light, fast hand still draws a
 * legible rope. Where the plain loop lies over the trunk (|offset| < 0.45w) the width eases to
 * 0.4×, so additive Night ink stays off white at the crossings. Floor 0.35 sp. Alpha
 * 0.8·glow(c), eased in over D ∈ [0, 0.5] so the trail grows out of the trunk.
 *
 * Seam: at finish, a unit whose successor would not be kept (keep(s) = s ≤ L − 0.45·P(s))
 * is the last orbit and stretches to P' = L − s_j, so a closed loop's rope joins itself; on
 * an open stroke the last orbit's radius and width fade over the last 10 sp, so the
 * satellite lands on the nib. With halfWin = 54 > 1.45·P_MAX a unit cooked live can never
 * be the last one at finish, which keeps live cooking ≡ one-shot cooking exact (keepRule).
 *
 * Decisions vs the brief: lace harmonics (+6, 0.13), (+11, 0.04) instead of (−5, 0.30),
 * (+7, 0.12) (those make outward cusps: a chain of barbed stars, and −5 is six-fold, not the
 * five lobes the acceptance asks for); trail 0.32·w at α 0.8 rather than 0.55·w (a thin bright
 * line reads as a rope, a wide one as a halo); R over (3.5 + 1.1S) so loops clear the trunk;
 * halfWin / reach 54 instead of 40 (keepRule; the brief's 40 cannot hold exactness with
 * P up to 36); endpoint facts (R, lean, cs, width) evaluated at the orbit's two ends and lerped
 * over u (smooth, and neighbours agree at the joint exactly). The rose is a five-loop
 * spirograph (1, 1.25R), (−4, 0.55·1.25R) rather than (−4, 0.35R) (a pentagon with corner
 * knots); its moon is (+6, 0.06) (five-fold compatible); its rotation is the only use of rng.
 */
import { PolyKind } from '../../core/types';
import { rnd, Ch, dcos, dsin, TAU } from '../../core/det';
import { clamp, smoothstep } from '../../core/num';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from './types';
import { UnitGeom, toneOf, glow } from './types';
import { RADIAL_ID } from './line.v1';

/** Depth range and the chain window (sp). */
const DMAX = 4, HALF_WIN = 54;
/** Budgets: samples per orbit (multiple of 3) + 3 joint points ≤ unitBudget. */
const NMAX = 216, NMIN = 48, UNIT_BUDGET = NMAX + 4, STROKE_BUDGET = 24000;
/** Target ceiling-trail advance per sample (sp). */
const SAMPLE_SP = 2.0;
/** Period clamp (sp) and the speed averaging half-window (sp). 1.45·P_MAX < HALF_WIN (see keepRule). */
const P_MIN = 10, P_MAX = 36, SPEED_WIN = 12;
/** Tail fraction of a period below which the next orbit is not started. */
const KEEP_FRAC = 0.45;
/** Epicycle radii as fractions of R (harmonics 1, +6, +11: five round lobes, then ten scallops). */
const RHO1 = 1, RHO2 = 0.13, RHO3 = 0.04;
/** Swell above depth 3. */
const SWELL = 0.5;
/** Trail alpha (Night and Paper), width factor, width floor (sp), tail fade of width and radius (sp). */
const ALPHA = 0.8, WF = 0.32, W_FLOOR = 0.35, TAIL = 10;
/** Least reference nib width (× S) of the brush / chisel trail. */
const W_MIN = 0.4;
/** Depth over which the trail's alpha eases in. */
const ALPHA_IN = 0.5;
/** Rose: radius factor, second harmonic (m = −4) = five petal loops, moon (+6); samples. */
const ROSE_R = 1.25, ROSE_RHO2 = 0.55, ROSE_RHO3 = 0.06, ROSE_N = 360;

/** P(S, v̄n) in sp. */
export function period(S: number, vbar: number): number {
  return clamp((10 + 2 * S) * (0.6 + 0.9 * smoothstep(0.4, 2.4, vbar)), P_MIN, P_MAX);
}
function periodAt(cx: FormCx, s: number): number {
  return period(cx.r.stroke.size, cx.at.mean(cx.sp.vn, s, SPEED_WIN));
}
/** R(S, p, vn, c) in sp. */
export function radius(S: number, p: number, vn: number, c: number): number {
  return (3.5 + 1.1 * S) * (0.5 + p) * (1 - 0.5 * smoothstep(1, 2.6, vn)) * (1 - 0.4 * clamp(c, 0, 1));
}

/** Facts at one end of an orbit: radius (sp), lean matrix, side crowding, nib width (doc), pressure, crowding. */
class EndFacts { R = 0; m00 = 1; m01 = 0; m11 = 1; cs = 0; w = 0; p = 0; c = 0 }
const FA = new EndFacts(), FB = new EndFacts();

function endFacts(cx: FormCx, s: number, out: EndFacts): void {
  const sp = cx.sp, at = cx.at, r = cx.r;
  const p = at.at(sp.p, s), c = at.at(sp.c, s), vn = at.at(sp.vn, s);
  out.R = radius(r.stroke.size, p, vn, c);
  out.cs = clamp(at.at(sp.cs, s), -1, 1);
  out.w = at.at(sp.w, s); out.p = p; out.c = c;
  out.m00 = 1; out.m01 = 0; out.m11 = 1;
  if (r.device === 'pen') {
    const ca = dcos(at.at(sp.alt, s));
    const k = 0.6 * ca * smoothstep(0.2, 0.4, ca);
    if (k > 0) {
      const az = at.angle(sp.az, s), tx = dcos(az), ty = dsin(az);
      out.m00 = 1 - k * tx * tx; out.m01 = -k * tx * ty; out.m11 = 1 - k * ty * ty;
    }
  }
}

/** Per-sample scratch: the epicycle vectors and the D = 1 trail (width profile). */
const E1X = new Float64Array(NMAX + 1), E1Y = new Float64Array(NMAX + 1), E2X = new Float64Array(NMAX + 1), E2Y = new Float64Array(NMAX + 1);
const E3X = new Float64Array(NMAX + 1), E3Y = new Float64Array(NMAX + 1), TX = new Float64Array(NMAX + 1), TY = new Float64Array(NMAX + 1), DS = new Float64Array(NMAX + 1), ON = new Float64Array(NMAX + 1);

/** Samples for an orbit of period P (sp) and mean radius R (sp): a multiple of 3 in [NMIN, NMAX]. */
function sampleCount(P: number, R: number): number {
  const len = P + TAU * R * (1 + SWELL) * (1 + 6 * RHO2 + 11 * RHO3) * 0.8;
  const n = Math.ceil(len / SAMPLE_SP / 3) * 3;
  return n < NMIN ? NMIN : n > NMAX ? NMAX : n;
}

/**
 * Whether an orbit starting at arc s is started: it must have 0.45 of its own period before
 * L. Both the chain's keep() and cookOrbit() (deciding whether unit j is the LAST orbit, so
 * it stretches to L) evaluate this from bit-identical inputs: s = s_j + P(s_j) is exactly the
 * cursor arithmetic of step(), and P(·) reads stations the unit's need() already settled.
 *
 * Live/finish exactness: a unit stepped live has s_j + HALF_WIN ≤ settled ≤ L_final, and
 * the last orbit needs L < s_j + P_j + 0.45·P_next ≤ s_j + 1.45·P_MAX = s_j + 52.2 < s_j +
 * HALF_WIN, so a unit cooked live is never the last one at finish and never re-cooks.
 */
function keepRule(cx: FormCx, s: number): boolean {
  return s <= cx.L - KEEP_FRAC * periodAt(cx, s);
}

/**
 * Cook one orbit at its ceiling into g: branch 0 = trunk positions (pa = width profile),
 * branches 1..3 = the epicycle vectors e_k (doc), N + 1 samples each. g.k = N.
 */
function cookOrbit(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
  g.reset();
  const at = cx.at, r = cx.r, z = cx.z, s = rec.s;
  const P0 = periodAt(cx, s);
  let P = P0, last = false;
  if (cx.final && !keepRule(cx, s + P0)) { last = true; P = cx.L - s; }
  if (!(P > 0.5)) P = 0.5;
  endFacts(cx, s, FA);
  endFacts(cx, s + P, FB);
  g.w = FA.w; g.p = FA.p; g.c = FA.c; g.ceil = DMAX;
  const N = sampleCount(P, 0.5 * (FA.R + FB.R));
  g.k = N;
  const brush = r.stroke.nib === 'brush', pen = r.stroke.nib === 'pen';
  const openTail = last && !cx.closed;
  const inv = 1 / z;
  // phase by rotation recurrence (fixed operation order: deterministic), exact at both ends
  const cd = dcos(TAU / N), sd = dsin(TAU / N);
  let c1 = 1, s1 = 0;
  // spine walker: the same bracketing stations and weights as Sampler.pos / normal, without a
  // binary search per sample (arcs increase monotonically along the orbit)
  const sp = cx.sp, S = sp.s, X = sp.x, Y = sp.y, NX = sp.nx, NY = sp.ny, hi = at.hi;
  let k = at.locate(s);
  const b0 = g.beginBranch(1, P);
  for (let i = 0; i <= N; i++) {
    const u = i / N, sa = i === N ? s + P : s + u * P;
    if (i > 0) { const c = c1 * cd - s1 * sd; s1 = s1 * cd + c1 * sd; c1 = c; }
    if (i === N) { c1 = 1; s1 = 0; }
    let px: number, py: number, nx: number, ny: number;
    if (hi <= 0 || !(sa > S[0])) { px = X[0]; py = Y[0]; nx = NX[0]; ny = NY[0]; }
    else if (sa >= S[hi]) { px = X[hi]; py = Y[hi]; nx = NX[hi]; ny = NY[hi]; }
    else {
      while (k < hi - 1 && S[k + 1] <= sa) k++;
      const ds = S[k + 1] - S[k], t = ds > 0 ? (sa - S[k]) / ds : 0;
      if (t === 0) { px = X[k]; py = Y[k]; nx = NX[k]; ny = NY[k]; }
      else { px = X[k] + (X[k + 1] - X[k]) * t; py = Y[k] + (Y[k + 1] - Y[k]) * t; nx = NX[k] + (NX[k + 1] - NX[k]) * t; ny = NY[k] + (NY[k + 1] - NY[k]) * t; }
    }
    const nm = Math.sqrt(nx * nx + ny * ny);
    if (nm > 1e-9) { nx /= nm; ny /= nm; } else { nx = 0; ny = -1; }
    const tx = -ny, ty = nx;
    g.addPt(px, py, sa - s);
    // facts lerped between the orbit's ends (neighbours agree at the joint exactly)
    let R = (FA.R + (FB.R - FA.R) * u) * inv;
    if (openTail) R *= smoothstep(0, TAIL, cx.L - sa);
    const cs = FA.cs + (FB.cs - FA.cs) * u;
    const m00 = FA.m00 + (FB.m00 - FA.m00) * u, m01 = FA.m01 + (FB.m01 - FA.m01) * u, m11 = FA.m11 + (FB.m11 - FA.m11) * u;
    // harmonics by angle addition: 2, 4, 6 = 4 + 2, 8, 10 = 8 + 2, 11 = 10 + 1 (fixed order: deterministic)
    const c2 = c1 * c1 - s1 * s1, s2 = 2 * s1 * c1;
    const c4 = c2 * c2 - s2 * s2, s4 = 2 * s2 * c2;
    const c6 = c4 * c2 - s4 * s2, s6 = s4 * c2 + c4 * s2;
    const c8 = c4 * c4 - s4 * s4, s8 = 2 * s4 * c4;
    const c10 = c8 * c2 - s8 * s2, s10 = s8 * c2 + c8 * s2;
    const c11 = c10 * c1 - s10 * s1, s11 = s10 * c1 + c10 * s1;
    epi(R * RHO1, c1, s1, cs, tx, ty, nx, ny, m00, m01, m11, E1X, E1Y, i);
    epi(R * RHO2, c6, s6, cs, tx, ty, nx, ny, m00, m01, m11, E2X, E2Y, i);
    epi(R * RHO3, c11, s11, cs, tx, ty, nx, ny, m00, m01, m11, E3X, E3Y, i);
    TX[i] = px + E1X[i]; TY[i] = py + E1Y[i]; ON[i] = Math.abs(E1X[i] * nx + E1Y[i] * ny);
  }
  g.endBranch(b0);
  for (let k = 1; k <= 3; k++) {
    const b = g.beginBranch(1, P), ex = k === 1 ? E1X : k === 2 ? E2X : E3X, ey = k === 1 ? E1Y : k === 2 ? E2Y : E3Y;
    for (let i = 0; i <= N; i++) g.addPt(ex[i], ey[i], 0);
    g.endBranch(b);
  }
  // width profile from the normalised speed of the D = 1 trail
  let vmax = 0;
  for (let i = 1; i <= N; i++) {
    const dx = TX[i] - TX[i - 1], dy = TY[i] - TY[i - 1];
    const d = Math.sqrt(dx * dx + dy * dy);
    DS[i] = d;
    if (d > vmax) vmax = d;
  }
  DS[0] = DS[1];
  const vinv = vmax > 0 ? 1 / vmax : 0;
  // a light / fast hand still draws a legible rope: the brush / chisel trail reads at least a 0.4·S nib
  const wMin = (W_MIN * r.stroke.size) / z;
  for (let i = 0; i <= N; i++) {
    const u = i / N, wn = FA.w + (FB.w - FA.w) * u, w = pen || wn > wMin ? wn : wMin;
    let wd = brush ? WF * w * (0.5 + 0.8 * DS[i] * vinv) : pen ? 0.5 * w : WF * w;
    // thin where the plain loop crosses the trunk (half-width 0.45w): additive Night ink stays off white
    wd *= 0.4 + 0.6 * smoothstep(0.7, 1.4, ON[i] / (0.45 * wn));
    if (openTail) wd *= smoothstep(0, TAIL, cx.L - (i === N ? s + P : s + u * P));
    g.pa[i] = wd;
  }
}

/** One epicycle vector: radius R (doc), phase (c, s), side-crowding squash on the n-component, lean matrix. */
function epi(R: number, c: number, sn: number, cs: number, tx: number, ty: number, nx: number, ny: number,
  m00: number, m01: number, m11: number, ox: Float64Array, oy: Float64Array, i: number): void {
  let sq = sn;
  if (sn > 0 && cs > 0) sq = sn * (1 - 0.6 * cs); else if (sn < 0 && cs < 0) sq = sn * (1 + 0.6 * cs);
  const vx = R * (c * tx + sq * nx), vy = R * (c * ty + sq * ny);
  ox[i] = m00 * vx + m01 * vy; oy[i] = m01 * vx + m11 * vy;
}

/** Points emitted at depth D: the three thirds share their joints. */
const orbitCount = (N: number, D: number): number => (D > 0 ? N + 3 : 0);

function emitOrbit(g: UnitGeom, D: number, eIn: number, z: number, born: number, unit: number, out: Sink): number {
  if (!(D > 0)) return 0;
  const N = g.k, m = N / 3, o1 = N + 1, o2 = 2 * o1, o3 = 3 * o1;
  const sw = 1 + SWELL * clamp(D - 3, 0, 1);
  const a1 = sw * clamp(D, 0, 1), a2 = sw * clamp(D - 1, 0, 1), a3 = sw * clamp(D - 2, 0, 1);
  const alpha = ALPHA * glow(g.c) * smoothstep(0, ALPHA_IN, D);
  const floor = W_FLOOR / z, px = g.px, py = g.py, pa = g.pa;
  let pts = 0;
  for (let t = 0; t < 3; t++) {
    out.begin(PolyKind.Ribbon, 1, alpha, toneOf(g.p, t + 1), born, unit, 1);
    for (let i = m * t; i <= m * (t + 1); i++) {
      const x = px[i] + a1 * px[o1 + i] + a2 * px[o2 + i] + a3 * px[o3 + i];
      const y = py[i] + a1 * py[o1 + i] + a2 * py[o2 + i] + a3 * py[o3 + i];
      const w = pa[i] * eIn;
      out.pt(x, y, w > floor ? w : floor);
    }
    pts += out.end();
  }
  return pts;
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
    cur.s = s + periodAt(cx, s);
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return keepRule(cx, s); },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void { cookOrbit(cx, rec, g); },

  count(g: UnitGeom, D: number): number { return orbitCount(g.k, D); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return emitOrbit(g, D, eIn, cx.z, rec.s, rec.j, out);
  },
};

/** Rose scratch: positions of the full rose and its width profile. */
const RX = new Float64Array(ROSE_N + 1), RY = new Float64Array(ROSE_N + 1), RW = new Float64Array(ROSE_N + 1);

/**
 * Radial seed: a five-loop spirograph rose (1, 1), (−4, 0.55) scaled by 1.25·R, drawn as a
 * prefix to fraction min(1, D/2) of its parameter (the pen draws the rosette for you), the
 * moon (+6, 0.06) fading in over D ∈ [2, 3], swelling above 3; split into tone thirds of the
 * drawn part. Width from the normalised speed of the moonless rose (brush), 0.5·w pen,
 * 0.32·w' chisel (w' = max(w, 0.4·S)).
 */
function orbitRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z;
  const R = ROSE_R * radius(r.stroke.size, seed.p, 0, seed.c) * (1 + SWELL * clamp(D - 3, 0, 1)) / z;
  const f3 = clamp(D - 2, 0, 1);
  const rot = (TAU / 5) * rnd(r.seed, Ch.Angle, RADIAL_ID + 32);
  const cr = dcos(rot), sr = dsin(rot);
  const brush = r.stroke.nib === 'brush';
  let vmax = 0, lx = 0, ly = 0;
  for (let i = 0; i <= ROSE_N; i++) {
    const phi = (TAU * i) / ROSE_N;
    const c1 = i === 0 || i === ROSE_N ? 1 : dcos(phi), s1 = i === 0 || i === ROSE_N ? 0 : dsin(phi);
    const c2 = c1 * c1 - s1 * s1, s2 = 2 * s1 * c1, c4 = c2 * c2 - s2 * s2, s4 = 2 * s2 * c2;
    const c6 = c4 * c2 - s4 * s2, s6 = s4 * c2 + c4 * s2;
    // base rose (for the width) and the full trail; (cos mφ, sin mφ) for m < 0 is (c, −s)
    const bx = c1 + ROSE_RHO2 * c4, by = s1 - ROSE_RHO2 * s4;
    const fx = bx + f3 * ROSE_RHO3 * c6, fy = by + f3 * ROSE_RHO3 * s6;
    RX[i] = seed.x + R * (cr * fx - sr * fy); RY[i] = seed.y + R * (sr * fx + cr * fy);
    if (i > 0) { const dx = bx - lx, dy = by - ly; const d = Math.sqrt(dx * dx + dy * dy); RW[i] = d; if (d > vmax) vmax = d; }
    lx = bx; ly = by;
  }
  RW[0] = RW[1];
  const wMin = (W_MIN * r.stroke.size) / z, inv = vmax > 0 ? 1 / vmax : 0, w0 = brush || r.stroke.nib === 'chisel' ? (seed.w > wMin ? seed.w : wMin) : seed.w, floor = W_FLOOR / z;
  const pen = r.stroke.nib === 'pen';
  for (let i = 0; i <= ROSE_N; i++) RW[i] = brush ? WF * w0 * (0.5 + 0.8 * RW[i] * inv) : pen ? 0.5 * w0 : WF * w0;
  const drawn = ROSE_N * Math.min(1, D / 2);
  if (!(drawn > 0)) return D;
  const alpha = ALPHA * glow(seed.c) * smoothstep(0, ALPHA_IN, D);
  for (let t = 0; t < 3; t++) {
    const k0 = (drawn * t) / 3, k1 = (drawn * (t + 1)) / 3;
    out.begin(PolyKind.Ribbon, 1, alpha, toneOf(seed.p, t + 1), cx.s0, 0, 1);
    roseAt(k0, floor, out);
    for (let k = Math.floor(k0) + 1; k < k1; k++) roseAt(k, floor, out);
    roseAt(k1, floor, out);
    out.end();
  }
  return D;
}
function roseAt(k: number, floor: number, out: Sink): void {
  const i = Math.floor(k), t = k - i;
  let x = RX[i], y = RY[i], w = RW[i];
  if (t > 0 && i < ROSE_N) { x += (RX[i + 1] - x) * t; y += (RY[i + 1] - y) * t; w += (RW[i + 1] - w) * t; }
  out.pt(x, y, w > floor ? w : floor);
}

export const orbit: FormOps = {
  id: 'orbit', v: 1, locality: 'local', reach: HALF_WIN, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 0.9, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: orbitRadial,
  radialCeiling: DMAX,
};
