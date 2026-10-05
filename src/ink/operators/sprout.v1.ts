/**
 * Sprout v1 (DESIGN §2.3.5): a developmental L-system. The demo's three rule strings
 * are kept verbatim as branch templates, but depth means development instead of parallel
 * rewriting: apices extend and new generations bud, so n + f is continuous and existing
 * branches never move.
 *
 * Anchors sit at absolute arcs s_0 = s0 + Δ(s0)/2, s_{j+1} = s_j + Δ(s_j), each created
 * once the spine has settled past s_j + 12 sp (the chain cursor is resumable). An anchor's
 * tree is cooked ONCE at its ceiling (all generations, full length) and then truncated:
 * a generation-g branch is drawn to ℓ_g·clamp(D_j − g + 1, 0, 1). Widths are a function
 * of position along the branch's full arc, so truncation is exact and rising never
 * re-runs the operator.
 *
 * Templates (F's outside brackets are the branch's segments; a bracket is a child of
 * the next generation spawned at that node, turned by its signs, + = θ, ++ = 2θ):
 *   fern  F[+F]F[-F]F             (|κ̄| < 0.012)   3 segments, node 1: +, node 2: −
 *   coral F[+F][-F]F              (otherwise)     2 segments, node 1: + and −
 *   bush  FF[+F][-F][++F][--F]    (radial seed)   2 segments, node 2: ±θ, ±2θ; gen ≤ 3
 *
 * Decisions:
 *  - Signs are mirrored by the primary's side σ, so alternate anchors grow mirrored
 *    (like alternate leaves) instead of all curling one way.
 *  - The anchor arc, side and template are frozen when the chain reaches the anchor;
 *    its geometry is recomputed from the spine whenever the unit re-cooks.
 *  - Heading rotations are algebraic ((x, y) → (x cos − y sin, x sin + y cos)) in the
 *    y-down frame; the lean signs are derived so the wind term turns toward the trailing
 *    tangent and the tilt term toward the pen's lean along the stroke.
 *  - Branch width eases in over a collar of 0.6 × its base width: under additive Night ink a
 *    full-width round base on the trunk stamped a bright bar at every anchor ("bamboo").
 *  - The causal stroke budget (24k) counts emitted (truncated) points; the cook decides
 *    which anchors exist from it. Each tree is capped at 900 points at its ceiling: above
 *    that its ceiling drops to the largest 1/16 level that fits.
 */
import { PolyKind } from '../../core/types';
import { rnd, Ch, dcos, dsin, PI } from '../../core/det';
import { clamp, lerp, smoothstep } from '../../core/num';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from './types';
import { UnitGeom, toneOf, glow, hierarchy } from './types';
import { RADIAL_ID } from './line.v1';

const DEG = PI / 180;
/** Template ids. */
export const FERN = 0, CORAL = 1, BUSH = 2;
/** Segments per branch and child specs per template: [node, turn multiple] pairs. */
const SEGS = [3, 2, 2];
const KIDS: readonly (readonly number[])[] = [
  [1, 1, 2, -1],              // fern: node 1 +θ, node 2 −θ
  [1, 1, 1, -1],              // coral: node 1 +θ and −θ
  [2, 1, 2, -1, 2, 2, 2, -2], // bush: node 2 ±θ, ±2θ
];
/** Deepest generation per template (bush is capped at 3). */
const GMAX = [4, 4, 3];
/** Max children per branch (for branch ids: child = parent·4 + k + 1). */
const FAN = 4;
/** Tropism substep (sp) and rate (rad per sp per unit cross product). */
const SUB = 3, TROPISM = 0.008;
/** Width floor (sp); widths shrink by 0.66 per generation (GW). */
const W_FLOOR = 0.35;
/** Branch alpha (Night) before hierarchy and glow. */
const ALPHA = 0.92;
/** Per-sprout point cap at its ceiling, and the stroke's causal total. */
const UNIT_BUDGET = 900, STROKE_BUDGET = 24000;
/** Averaging half-window and spacing clamp (sp). */
const WIN = 12, DMIN = 14, DMAX_SP = 72;
/** Primary heading jitter of a radial burst (±12°) and its 5 primaries. */
const BURST = 5, BURST_JIT = 12 * DEG;

const v2 = new Float64Array(2), n2 = new Float64Array(2), t2 = new Float64Array(2);

/** Δ(s): anchor spacing from pressure, crowding and curvature averaged over ±12 sp. */
function spacing(cx: FormCx, s: number): number {
  const sp = cx.sp, at = cx.at;
  const p = at.mean(sp.p, s, WIN), c = at.mean(sp.c, s, WIN), k = at.mean(sp.k, s, WIN);
  return clamp(lerp(46, 18, p) * (1 + 1.2 * c) * (1 - 0.3 * Math.min(1, Math.abs(k) / 0.05)), DMIN, DMAX_SP);
}

/** Branch-building scratch: a stack of pending children (pos, heading, gen, length, id). */
interface Pending { x: number; y: number; hx: number; hy: number; g: number; len: number; id: number }
const stack: Pending[] = [];
let stackN = 0;
function pushPending(x: number, y: number, hx: number, hy: number, g: number, len: number, id: number): void {
  if (stackN === stack.length) stack.push({ x: 0, y: 0, hx: 0, hy: 0, g: 0, len: 0, id: 0 });
  const e = stack[stackN++];
  e.x = x; e.y = y; e.hx = hx; e.hy = hy; e.g = g; e.len = len; e.id = id;
}

/**
 * Grow one tree into g: primaries from `roots` already pushed on the stack. Branch b of
 * gen gb walks its segments in substeps ≤ 3 sp, turning toward screen-up by
 * 0.008·cross(h, up) rad per sp, and spawns its children at template nodes.
 */
function growTree(g: UnitGeom, z: number, seed: number, addr: number, tmpl: number, theta: number, sigma: number, upx: number, upy: number): void {
  const segs = SEGS[tmpl], kids = KIDS[tmpl], gmax = GMAX[tmpl];
  while (stackN > 0) {
    const e = stack[--stackN];
    let x = e.x, y = e.y, hx = e.hx, hy = e.hy;
    const gb = e.g, len = e.len, id = e.id;
    const b = g.beginBranch(gb, len);
    g.addPt(x, y, 0);
    const segLen = len / segs, nsub = Math.max(1, Math.ceil(segLen / SUB)), d = segLen / nsub;
    let arc = 0;
    // children are pushed after the walk so the stack order (and thus point order) is fixed
    let nk = 0;
    const kx = KX, ky = KY, khx = KHX, khy = KHY, km = KM;
    for (let sgi = 1; sgi <= segs; sgi++) {
      for (let q = 0; q < nsub; q++) {
        const turn = TROPISM * (hx * upy - hy * upx) * d;
        const c = dcos(turn), s = dsin(turn);
        const nx = hx * c - hy * s, ny = hx * s + hy * c;
        hx = nx; hy = ny;
        x += hx * d / z; y += hy * d / z;
        arc = sgi === segs && q === nsub - 1 ? len : arc + d;
        g.addPt(x, y, arc);
      }
      if (gb < gmax) {
        for (let m = 0; m < kids.length; m += 2) {
          if (kids[m] !== sgi) continue;
          kx[nk] = x; ky[nk] = y; khx[nk] = hx; khy[nk] = hy; km[nk] = kids[m + 1]; nk++;
        }
      }
    }
    g.endBranch(b);
    for (let q = nk - 1; q >= 0; q--) {
      const cid = id * FAN + q + 1;
      const mult = 0.75 + 0.5 * rnd(seed, Ch.Angle, addr, cid);
      const a = sigma * km[q] * theta * mult;
      const c = dcos(a), s = dsin(a);
      const chx = khx[q] * c - khy[q] * s, chy = khx[q] * s + khy[q] * c;
      const clen = 0.55 * len * (0.8 + 0.4 * rnd(seed, Ch.Length, addr, cid));
      pushPending(kx[q], ky[q], chx, chy, gb + 1, clen, cid);
    }
  }
}
const KX = new Float64Array(8), KY = new Float64Array(8), KHX = new Float64Array(8), KHY = new Float64Array(8), KM = new Float64Array(8);

/** Points of the tree at depth D (gen g drawn to ℓ·clamp(D − g + 1, 0, 1)). */
function treeCount(g: UnitGeom, D: number): number {
  let n = 0;
  for (let b = 0; b < g.nB; b++) {
    const f = clamp(D - g.bGen[b] + 1, 0, 1);
    if (f > 0) n += g.prefixCount(b, g.bLen[b] * f);
  }
  return n;
}

/** Largest 1/16 level ≤ dMax whose point count fits the unit budget. */
function treeCeiling(g: UnitGeom, dMax: number): number {
  if (treeCount(g, dMax) <= UNIT_BUDGET) return dMax;
  let lo = 0, hi = Math.round(dMax * 16);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (treeCount(g, m / 16) <= UNIT_BUDGET) lo = m; else hi = m; }
  return lo / 16;
}

const GW = [1, 0.66, 0.4356, 0.287496, 0.18974736, 0.1252332576];
/** Collar length as a fraction of the branch's base width: the width eases in over it. */
const COLLAR = 0.6;

/**
 * Width (doc) at arc a (sp) of a branch of length len: linear from w0 to w1, eased in over
 * the collar (sp) so a branch grows out of its parent instead of stamping a bright disc
 * where it overlaps it (under 'lighter', overlapping batches add). Still a function of
 * position only, so truncation stays exact.
 */
function branchWidth(w0: number, w1: number, a: number, len: number, collar: number): number {
  const w = w0 + (w1 - w0) * (a / len);
  return a < collar ? w * smoothstep(0, collar, a) : w;
}

/** Emit the tree truncated to D: one Ribbon per drawn branch, tapering along its full arc. */
function treeEmit(g: UnitGeom, D: number, wb: number, z: number, born: number, unit: number, out: Sink): number {
  const floor = W_FLOOR / z, gl = glow(g.c);
  let pts = 0;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b], f = clamp(D - gen + 1, 0, 1);
    if (!(f > 0)) continue;
    const len = g.bLen[b], lam = len * f;
    const o = g.bOff[b], cnt = g.bCnt[b], pa = g.pa;
    const w0 = wb * GW[gen - 1], w1 = wb * GW[gen];
    const collar = COLLAR * w0 * z;
    out.begin(PolyKind.Ribbon, gen, ALPHA * hierarchy(gen) * gl, toneOf(g.p, gen), born, unit, 1);
    let k = 0;
    for (; k < cnt && (k === 0 || pa[o + k] < lam); k++) {
      const w = branchWidth(w0, w1, pa[o + k], len, collar);
      out.pt(g.px[o + k], g.py[o + k], w > floor ? w : floor);
    }
    if (k < cnt) {
      // the drawn tip: exactly the next point when it sits at lam, else interpolated
      const a0 = pa[o + k - 1], a1 = pa[o + k];
      const t = a1 > a0 ? (lam - a0) / (a1 - a0) : 1;
      const x = t >= 1 ? g.px[o + k] : g.px[o + k - 1] + (g.px[o + k] - g.px[o + k - 1]) * t;
      const y = t >= 1 ? g.py[o + k] : g.py[o + k - 1] + (g.py[o + k] - g.py[o + k - 1]) * t;
      const w = branchWidth(w0, w1, lam, len, collar);
      out.pt(x, y, w > floor ? w : floor);
    }
    pts += out.end();
  }
  return pts;
}

/** Primary length ℓ_1 (sp) at pressure p, crowding c, rng r. */
const primaryLen = (S: number, p: number, c: number, r: number): number =>
  (20 + 2 * S) * (0.4 + 1.3 * p) * (0.6 + 0.8 * r) * (1 - 0.3 * c);
/** Branch angle θ (rad): pressing harder opens the branches. */
const thetaOf = (p: number): number => (16 + 26 * smoothstep(0.25, 0.85, p)) * DEG;

const chain: ChainOperator = {
  halfWin: WIN,
  dMax: 4,
  unitBudget: UNIT_BUDGET,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 : cur.s) + WIN;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    if (cur.phase === 0) {
      cur.s = cx.s0 + 0.5 * spacing(cx, cx.s0);
      cur.phase = 1;
      return false;
    }
    const s = cur.s, sp = cx.sp, at = cx.at;
    const kb = at.mean(sp.k, s, WIN), cs = at.at(sp.cs, s);
    let side: number;
    if (Math.abs(cs) > 0.15) side = cs > 0 ? -1 : 1;
    else if (Math.abs(kb) < 0.004) side = cur.side !== 0 ? -cur.side : (rnd(cx.r.seed, Ch.Side, cur.j) < 0.5 ? 1 : -1);
    else {
      const convex = kb > 0 ? -1 : 1;
      side = rnd(cx.r.seed, Ch.Side, cur.j) < 0.7 ? convex : -convex;
    }
    rec.s = s; rec.j = cur.j; rec.side = side; rec.tmpl = Math.abs(kb) < 0.012 ? FERN : CORAL;
    cur.side = side; cur.j++;
    cur.s = s + spacing(cx, s);
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s <= cx.L - 6; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
    g.reset();
    const sp = cx.sp, at = cx.at, r = cx.r, z = cx.z, s = rec.s, j = rec.j, sigma = rec.side;
    at.pos(s, v2); at.normal(s, n2); at.tangent(s, t2);
    const p = at.at(sp.p, s), c = at.at(sp.c, s), vn = at.at(sp.vn, s);
    g.w = at.at(sp.w, s); g.p = p; g.c = c;
    const theta = thetaOf(p);
    const len = primaryLen(r.stroke.size, p, c, rnd(r.seed, Ch.Length, j));
    // lean: tilt along the tangent, a random term, and the wind turning toward the trailing tangent
    let tilt = 0;
    if (r.device === 'pen') {
      const alt = at.at(sp.alt, s), az = at.angle(sp.az, s);
      tilt = dcos(alt) * (dcos(az) * t2[0] + dsin(az) * t2[1]);
    }
    const lam = sigma * 0.7 * tilt + (rnd(r.seed, Ch.Lean, j) - 0.5) * 0.5 - sigma * 0.5 * smoothstep(1.0, 2.4, vn);
    const hx0 = sigma * n2[0], hy0 = sigma * n2[1], cl = dcos(lam), sl = dsin(lam);
    const upx = dsin(r.rot), upy = -dcos(r.rot);
    stackN = 0;
    pushPending(v2[0], v2[1], hx0 * cl - hy0 * sl, hx0 * sl + hy0 * cl, 1, len, 1);
    growTree(g, z, r.seed, j * 8, rec.tmpl, theta, sigma, upx, upy);
    g.ceil = treeCeiling(g, GMAX[rec.tmpl]);
  },

  count(g: UnitGeom, D: number): number { return treeCount(g, D); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return treeEmit(g, D, g.w * eIn, cx.z, rec.s, rec.j, out);
  },
};

/** Radial burst scratch geometry (reused). */
const burst = new UnitGeom();

/**
 * Radial seed: a bush burst of 5 primaries at 72°·i + 72°·r ± 12°, bush template capped at
 * generation 3, at depth base + a_0 (the dot is the cook's).
 */
function sproutRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const r = cx.r, z = cx.z;
  const D = clamp(depth, 0, GMAX[BUSH]);
  if (!(D > 0)) return 0;
  burst.reset();
  burst.p = seed.p; burst.c = seed.c; burst.w = seed.w;
  const theta = thetaOf(seed.p);
  const rot0 = 72 * DEG * rnd(r.seed, Ch.Angle, RADIAL_ID, 1);
  const upx = dsin(r.rot), upy = -dcos(r.rot);
  for (let i = 0; i < BURST; i++) {
    const addr = (RADIAL_ID + 8 + i * 8) | 0;
    const a = 72 * DEG * i + rot0 + (rnd(r.seed, Ch.Angle, addr) - 0.5) * 2 * BURST_JIT;
    const len = primaryLen(r.stroke.size, seed.p, seed.c, rnd(r.seed, Ch.Length, addr));
    stackN = 0;
    pushPending(seed.x, seed.y, dcos(a), dsin(a), 1, len, 1);
    growTree(burst, z, r.seed, addr, BUSH, theta, 1, upx, upy);
  }
  const Dc = Math.min(D, treeCeiling(burst, GMAX[BUSH]));
  treeEmit(burst, Dc, seed.w, z, cx.s0, 0, out);
  return Dc;
}

/** Sprout v1. */
export const sprout: FormOps = {
  id: 'sprout', v: 1, locality: 'local', reach: 24, dMax: 4, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: sproutRadial,
  radialCeiling: 3,
};
