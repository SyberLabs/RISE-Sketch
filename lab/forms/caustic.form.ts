/**
 * Caustic (lab v103) — the stroke as a mirror.
 *
 * A lamp shines across the page from the side the pen leans toward (from the top when the
 * pen is upright or the device has no tilt). The stroke is a polished mirror: fine reflected
 * rays leave its lit face at the mirror angle and, where the line bends toward the lamp
 * (the light hits a concave face), they gather on a caustic: the locus of the tangential
 * focus, with a cusp at every curvature peak. Nothing grows from the stroke; the stroke is
 * an optical surface.
 *
 * Unit j = Δ sp of arc [s_j, s_j + Δ], Δ = 8·(1 + c), holding 3 rays and 5 caustic points:
 *
 *   L        lamp direction (light travel), per unit from the pen's tilt: wt = smoothstep(0.1,
 *            0.3, cos alt), L = normalize(wt·(−tiltVec) + (1 − wt)·down); mouse / finger: down
 *   n        spine normal at s, κ = κ̄ over ±4 sp, cos θ = |L·n|, lit face n_lit = −sign(L·n)·n
 *   r        = L − 2(L·n)n               reflected direction
 *   real     = −κ·(L·n) > 0              the light hits the concave face (a real focus)
 *   ρ_f      = min(cos θ / 2|κ|, 400)    tangential focal distance (sp)
 *   c(s)     = pos(s) + ρ_f·r            caustic point (real faces only)
 *   scatter  = ±(0.02 + 0.25·smoothstep(0.6, 2.4, vn)) rad on r: slow = polished, fast = brushed
 *   ℓ_max    = (24 + 2.5S)(0.6 + 0.8p)(1 − 0.5·max(0, cs·sign(r·n)))
 *   ℓ(D)     = ℓ_max·min(D, 1)·(1 + 0.35·max(0, D − 1))       a prefix of the ray
 *   α_ray    = (0.14 + 0.18p)·min(1, ρ_f/12)·smoothstep(0, 0.12, cos θ)·glow(c)
 *              ·(1 + 0.3·clamp(D − 1, 0, 1))                   (gen 2; a hold brightens more than it reaches)
 *   source   the pair r rotated ±2.5° at α × clamp(D − 2, 0, 1): above the default base the
 *            source spreads, so a held spot triples its rays on an otherwise quiet fan
 *   caustic  5-point polyline c(s) over the unit (gen 1), split into runs of real points,
 *            α 0.9 × mean of smoothstep(0, 4, ℓ(D) − ρ_f)·smoothstep(140, 70, ρ_f)
 *            ·smoothstep(0, 6, ρ_f)·cos θ  (a focus on the mirror itself is only a hot spot)
 *
 * Every ray is a prefix or an alpha weight of geometry cooked once at the ceiling, so depth
 * is continuous; the lit-face flip at L ⟂ n is continuous because cos θ → 0 fades it. A unit
 * is a pure function of the spine within 20 sp of s_j, d(s_j), the entry factor and the rng
 * address (Ch.Jitter, j, q).
 *
 * Decisions:
 *  - Virtual caustics (convex faces) are not drawn: the real rays diverge there and read as
 *    a crown on their own; a faint mirrored curve added clutter without light.
 *  - A caustic run breaks where a point is virtual, beyond 140 sp or more than 40 sp from
 *    its neighbour (corners), so no long faint chords cross the drawing. Foci further than
 *    ~100 sp from a gentle bend fade out: they floated as detached bright dashes.
 *  - A hold brightens the fan (×1.3 by D = 2) and triples it (D > 2) more than it lengthens
 *    it (×2.05 at D = 4): spread too far, the light thinned into haze instead of blazing.
 *  - Ray width is max(0.7 sp, 0.3·w) tapering to 0.4 sp over the DRAWN length (Drift's rule):
 *    a short ray at low depth still ends in a point; thinner rays died under the hairline LOD.
 *  - Rays beyond the stroke's end (s > L) are dropped at cook: a live-cooked unit never has
 *    any (need = s + 20 > s + 16), so cook ≡ finish holds.
 *  - Chisel: the spine normal is used (the brief's chisel-edge normal is left for later).
 *  - Tap: a glint of 12 rays at 30°·i + 30°·r from the dot's rim, tripled above D = 2, with a
 *    4-cusp astroid caustic at 0.3·ℓ(D); ≤ 105 points.
 */
import { PolyKind } from '../../src/core/types';
import { rnd, Ch, dcos, dsin, PI, TAU } from '../../src/core/det';
import { clamp, smoothstep } from '../../src/core/num';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from '../../src/ink/operators/types';
import { UnitGeom, toneOf, glow, hierarchy } from '../../src/ink/operators/types';
import { RADIAL_ID } from '../../src/ink/operators/line.v1';
import type { LabFormMeta } from './harness';

export const meta: LabFormMeta = {
  name: 'Caustic — the stroke as a mirror',
  v: 103,
  ink: 'spectral',
  notes: 'A lamp from the lean side (top when upright) lights the stroke as a mirror: rays leave the lit face at the mirror angle; concave bends focus them on a cusped caustic, straight runs hatch, corners cross in an X, a loop fills with a nephroid. Speed = polish (scatter), pressure = reflectivity and reach, hold = longer, tripled rays, nearby ink = shorter and dimmer. Tap = glint with a star.',
};

const DMAX = 4, BASE = 2;
/** Unit arc (sp), rays and caustic points per unit. */
const UNIT_SP = 8, RAYS = 3, CPTS = 5;
/** Spine window a unit reads (sp): Δ ≤ 16 plus the κ̄ window. */
const WIN = 20, KWIN = 4;
/** Extended-source half angle (2.5°). */
const SIDE_ANG = 2.5 * PI / 180;
/** Depth above which the extended source fades in (α × clamp(D − SIDE_D0, 0, 1)). */
const SIDE_D0 = 2;
/** Focal distance (sp) below which the caustic fades out (it would sit on the mirror). */
const RHO_MIN = 6;
/** Focal distance cap and the caustic's far fade (sp). */
const RHO_CAP = 400, RHO_FAR = 140, RHO_NEAR = 70;
/** Longest caustic segment (sp) before the run breaks. */
const SEG_MAX = 40;
/** Ray reach: (LEN0 + LEN_S·S)(0.6 + 0.8p) sp; depth growth F(D), F(DMAX) = FD4. */
const LEN0 = 24, LEN_S = 2.5, LEN_GROW = 0.35, FD4 = 1 + LEN_GROW * (DMAX - 1);
/** Hold brightness: ray α × (1 + BLAZE·clamp(D − 1, 0, 1)). */
const BLAZE = 0.3;
/** Alphas (Night design values). */
const RAY_A0 = 0.14, RAY_AP = 0.18, CAUSTIC_A = 0.9;
/** Widths: ray = max(RAY_W_MIN sp, RAY_W·w), caustic = CAUSTIC_W·w, floor W_FLOOR sp. */
const RAY_W = 0.3, RAY_W_MIN = 0.7, CAUSTIC_W = 0.35, W_FLOOR = 0.4;
const UNIT_BUDGET = 40, STROKE_BUDGET = 16000;
/** Glint: 12 rays at 30°, astroid radius as a fraction of the ray length, astroid points. */
const GLINT_N = 12, GLINT_STEP = PI / 6, STAR_R = 0.3, STAR_PTS = 32;

/** Depth growth of the ray length: a prefix, continuous, F(1) = 1, F(4) = 2.05. */
export function lenF(D: number): number {
  const d = clamp(D, 0, DMAX);
  return Math.min(d, 1) * (1 + LEN_GROW * Math.max(0, d - 1));
}
/** ℓ_max (sp) before the side-ink shortening. */
const lenMax = (S: number, p: number): number => (LEN0 + LEN_S * S) * (0.6 + 0.8 * p);
/** Unit spacing Δ(s). */
const spacing = (cx: FormCx, s: number): number => UNIT_SP * (1 + clamp(cx.at.at(cx.sp.c, s), 0, 1));

const pos = new Float64Array(2), nrm = new Float64Array(2), lampV = new Float64Array(2);

/** Lamp direction (light travel, doc frame) at arc s. */
function lamp(cx: FormCx, s: number, out: Float64Array): void {
  const r = cx.r, rot = r.rot;
  let dx = -dsin(rot), dy = dcos(rot); // screen-down
  if (r.device === 'pen') {
    const alt = cx.at.at(cx.sp.alt, s);
    const wt = smoothstep(0.1, 0.3, dcos(alt));
    if (wt > 0) {
      const az = cx.at.angle(cx.sp.az, s);
      const x = -wt * dcos(az) + (1 - wt) * dx, y = -wt * dsin(az) + (1 - wt) * dy;
      const m = Math.sqrt(x * x + y * y);
      if (m > 1e-9) { dx = x / m; dy = y / m; }
    }
  }
  out[0] = dx; out[1] = dy;
}

/** Reflection state at arc s (module scratch, single-threaded). */
let R_rx = 0, R_ry = 0, R_cos = 0, R_rho = 0, R_real = false, R_sgn = 1, R_ln = 0;
function reflectAt(cx: FormCx, s: number): void {
  const at = cx.at;
  at.pos(s, pos); at.normal(s, nrm);
  lamp(cx, s, lampV);
  const ln = lampV[0] * nrm[0] + lampV[1] * nrm[1];
  const k = at.mean(cx.sp.k, s, KWIN);
  R_ln = ln;
  R_cos = ln < 0 ? -ln : ln;
  R_sgn = ln > 0 ? -1 : 1;
  R_rx = lampV[0] - 2 * ln * nrm[0]; R_ry = lampV[1] - 2 * ln * nrm[1];
  R_real = -k * ln > 0;
  const ak = k < 0 ? -k : k;
  R_rho = ak > 1e-9 ? Math.min(R_cos / (2 * ak), RHO_CAP) : RHO_CAP;
}

/**
 * Cook the three branches (main, +side, −side) of ray q at arc sq. Each branch is 4 points:
 * meta (px = α base, py = born arc), origin on the lit rim, mid (at the focus when it is real
 * and within reach, else half way) and the tip at ℓ_ceil; bLen = ℓ_ceil (sp).
 */
function cookRay(cx: FormCx, g: UnitGeom, sq: number, j: number, q: number): void {
  const sp = cx.sp, at = cx.at, r = cx.r, z = cx.z;
  reflectAt(cx, sq);
  const p = at.at(sp.p, sq), c = at.at(sp.c, sq), cs = at.at(sp.cs, sq), vn = at.at(sp.vn, sq), w = at.at(sp.w, sq);
  const toward = R_rx * nrm[0] + R_ry * nrm[1] > 0 ? cs : -cs;
  const lmax = lenMax(r.stroke.size, p) * (1 - 0.5 * Math.max(0, toward));
  const lceil = lmax * FD4;
  let aBase = (RAY_A0 + RAY_AP * p) * Math.min(1, R_rho / 12) * smoothstep(0, 0.12, R_cos) * glow(c);
  if (sq > cx.L || !(lceil > 0)) aBase = 0;
  const scat = (0.02 + 0.25 * smoothstep(0.6, 2.4, vn)) * (2 * rnd(r.seed, Ch.Jitter, j, q) - 1);
  const ox = pos[0] + R_sgn * nrm[0] * w * 0.5, oy = pos[1] + R_sgn * nrm[1] * w * 0.5;
  const aMid = R_real && R_rho < lceil ? R_rho : lceil * 0.5;
  for (let e = 0; e < 3; e++) {
    const a = scat + (e === 0 ? 0 : e === 1 ? SIDE_ANG : -SIDE_ANG);
    const ca = dcos(a), sa = dsin(a);
    const dx = (R_rx * ca - R_ry * sa) / z, dy = (R_rx * sa + R_ry * ca) / z;
    const b = g.beginBranch(e === 0 ? 2 : 3, lceil);
    g.addPt(aBase, sq, 0);
    g.addPt(ox, oy, 0);
    g.addPt(ox + dx * aMid, oy + dy * aMid, aMid);
    g.addPt(ox + dx * lceil, oy + dy * lceil, lceil);
    g.endBranch(b);
  }
}

/** Points of a ray branch drawn to ℓ, 0 when it is dark. */
function rayCount(g: UnitGeom, b: number, l: number): number {
  const o = g.bOff[b];
  if (!(g.px[o] > 0) || !(l > 0)) return 0;
  return g.pa[o + 2] < l ? 3 : 2;
}

function rayEmit(g: UnitGeom, b: number, l: number, alpha: number, tone: number, unit: number, w0: number, floor: number, out: Sink): number {
  const o = g.bOff[b], lceil = g.bLen[b];
  const ox = g.px[o + 1], oy = g.py[o + 1], tx = g.px[o + 3], ty = g.py[o + 3];
  out.begin(PolyKind.Ribbon, 2, alpha, tone, g.py[o], unit, 1);
  out.pt(ox, oy, w0);
  const aMid = g.pa[o + 2];
  if (aMid < l) { const wm = w0 * (1 - aMid / l); out.pt(g.px[o + 2], g.py[o + 2], wm > floor ? wm : floor); }
  const t = l / lceil;
  out.pt(ox + (tx - ox) * t, oy + (ty - oy) * t, floor);
  return out.end();
}

/** Caustic run factor: mean ignition × far fade × cos θ over points [a, b). */
function runFactor(g: UnitGeom, co: number, dO: number, a: number, b: number, l: number): number {
  let f = 0;
  for (let m = a; m < b; m++) {
    const rho = g.pa[co + m];
    f += smoothstep(0, 4, l - rho) * smoothstep(RHO_FAR, RHO_NEAR, rho) * smoothstep(0, RHO_MIN, rho) * g.px[dO + m];
  }
  return f / (b - a);
}

/** Emit (or, with out = null, count) a unit truncated to depth D. */
function unitWalk(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink | null): number {
  const z = cx.z, F = lenF(D), side = clamp(D - SIDE_D0, 0, 1);
  const wsp = g.w * eIn * z;
  const w0 = Math.max(RAY_W_MIN, RAY_W * wsp) / z, floor = W_FLOOR / z;
  const gl = glow(g.c), tone2 = toneOf(g.p, 2), tone1 = toneOf(g.p, 1);
  const a2 = gl * hierarchy(2) * (1 + BLAZE * clamp(D - 1, 0, 1));
  let n = 0;
  for (let b = 0; b < 3 * RAYS; b++) {
    const e = b % 3;
    if (e !== 0 && !(side > 0)) continue;
    const l = g.bLen[b] * F / FD4;
    const k = rayCount(g, b, l);
    if (k === 0) continue;
    n += k;
    if (out) rayEmit(g, b, l, g.px[g.bOff[b]] * a2 * (e === 0 ? 1 : side), tone2, rec.j, w0, floor, out);
  }
  // the caustic: runs of consecutive real points, broken at long jumps
  const cb = 3 * RAYS, co = g.bOff[cb], dO = g.bOff[cb + 1], cnt = g.bCnt[cb];
  const lUnit = g.k * F, wC = CAUSTIC_W * wsp / z;
  let run = -1;
  for (let m = 0; m <= cnt; m++) {
    const valid = m < cnt && g.pa[co + m] >= 0;
    const far = valid && run >= 0 && g.pa[dO + m] > 0;
    if (!valid || far) {
      if (run >= 0 && m - run >= 2) {
        const f = runFactor(g, co, dO, run, m, lUnit);
        if (f > 1e-3) {
          n += m - run;
          if (out) {
            out.begin(PolyKind.Ribbon, 1, CAUSTIC_A * gl * f, tone1, rec.s, rec.j, 1);
            for (let i = run; i < m; i++) {
              const w = wC * (0.5 + 0.5 * g.px[dO + i]);
              out.pt(g.px[co + i], g.py[co + i], w > floor ? w : floor);
            }
            out.end();
          }
        }
      }
      run = valid ? m : -1;
    } else if (run < 0) run = m;
  }
  return n;
}

const chain: ChainOperator = {
  halfWin: WIN,
  dMax: DMAX,
  unitBudget: UNIT_BUDGET,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 + 1 : cur.s) + WIN;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    if (cur.phase === 0) { cur.s = cx.s0 + 1; cur.phase = 1; }
    const s = cur.s;
    rec.s = s; rec.j = cur.j; rec.side = 0; rec.tmpl = 0;
    cur.j++;
    cur.s = s + spacing(cx, s);
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s <= cx.L - 2; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
    g.reset();
    const sp = cx.sp, at = cx.at, z = cx.z, s = rec.s, j = rec.j;
    const delta = spacing(cx, s), sm = s + delta * 0.5;
    g.w = at.at(sp.w, sm); g.p = at.at(sp.p, sm); g.c = at.at(sp.c, sm);
    g.k = lenMax(cx.r.stroke.size, g.p);
    for (let q = 0; q < RAYS; q++) cookRay(cx, g, s + (q + 0.5) * delta / RAYS, j, q);
    // caustic geometry (pa = ρ_f, −1 when virtual / off the end) and its data (px = cos θ)
    const cb = g.beginBranch(1, delta);
    for (let m = 0; m < CPTS; m++) {
      const sq = s + m * delta / (CPTS - 1);
      reflectAt(cx, sq);
      const ok = R_real && R_rho < RHO_FAR && sq <= cx.L;
      g.addPt(pos[0] + R_rx * R_rho / z, pos[1] + R_ry * R_rho / z, ok ? R_rho : -1);
    }
    g.endBranch(cb);
    // data: px = cos θ, py = L·n, pa = 1 when the segment from the previous point is longer than SEG_MAX
    const co = g.bOff[cb];
    const db = g.beginBranch(0, 0);
    for (let m = 0; m < CPTS; m++) {
      reflectAt(cx, s + m * delta / (CPTS - 1));
      let far = 0;
      if (m > 0) {
        const dx = (g.px[co + m] - g.px[co + m - 1]) * z, dy = (g.py[co + m] - g.py[co + m - 1]) * z;
        if (dx * dx + dy * dy > SEG_MAX * SEG_MAX) far = 1;
      }
      g.addPt(R_cos, R_ln, far);
    }
    g.endBranch(db);
    g.ceil = DMAX;
  },

  count(g: UnitGeom, D: number): number { return unitWalk(cxNull, recNull, g, D, 1, null); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return unitWalk(cx, rec, g, D, eIn, out);
  },
};
/** count() has no context: the walk reads only z (point counts do not depend on it) and rec.j. */
const cxNull = { z: 1 } as unknown as FormCx;
const recNull: ChainRecord = { s: 0, j: 0, side: 0, tmpl: 0 };

/** Radial seed: a glint of 12 rays from the dot's rim and a 4-cusp astroid caustic. */
function causticRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z, p = seed.p;
  const len = lenMax(r.stroke.size, p) * lenF(D);
  const wsp = seed.w * z, rim = wsp * 0.5;
  const w0 = Math.max(RAY_W_MIN, RAY_W * wsp) / z, floor = W_FLOOR / z;
  const rot0 = GLINT_STEP * rnd(r.seed, Ch.Angle, RADIAL_ID + 32);
  const gl = glow(seed.c), side = clamp(D - SIDE_D0, 0, 1);
  const aRay = (RAY_A0 + RAY_AP * p) * gl * hierarchy(2) * (1 + BLAZE * clamp(D - 1, 0, 1)), tone2 = toneOf(p, 2);
  for (let i = 0; i < GLINT_N; i++) {
    const th = GLINT_STEP * i + rot0;
    for (let e = 0; e < 3; e++) {
      if (e !== 0 && !(side > 0)) continue;
      const a = th + (e === 0 ? 0 : e === 1 ? SIDE_ANG : -SIDE_ANG);
      const ux = dcos(a) / z, uy = dsin(a) / z;
      out.begin(PolyKind.Ribbon, 2, aRay * (e === 0 ? 1 : side), tone2, cx.s0, 0, 1);
      out.pt(seed.x + ux * rim, seed.y + uy * rim, w0);
      out.pt(seed.x + ux * (rim + len), seed.y + uy * (rim + len), floor);
      out.end();
    }
  }
  const ast = STAR_R * len / z, wC = CAUSTIC_W * wsp / z;
  out.begin(PolyKind.Ribbon, 1, CAUSTIC_A * gl * smoothstep(0, 0.5, D), toneOf(p, 1), cx.s0, 0, 1);
  for (let m = 0; m <= STAR_PTS; m++) {
    const t = rot0 + TAU * (m % STAR_PTS) / STAR_PTS;
    const c = dcos(t), s = dsin(t), c2 = c * c - s * s;
    const w = wC * (0.35 + 0.65 * (c2 < 0 ? -c2 : c2));
    out.pt(seed.x + ast * c * c * c, seed.y + ast * s * s * s, w > floor ? w : floor);
  }
  out.end();
  return D;
}

export const ops: FormOps = {
  id: 'ripple', v: 103, locality: 'local', reach: WIN, dMax: DMAX, baseDefault: BASE,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: causticRadial,
  radialCeiling: DMAX,
};
