/**
 * Sprout v2 (DESIGN §2.3.5): v1's developmental L-system with clean crotches.
 *
 * Why v2. Under additive Night ink ('lighter') polys of different generations sit in different
 * raster batches (alpha and tone differ), so wherever a child ribbon lies on its parent the two
 * ADD. v1 started every branch on its parent's centreline and only eased its width in over a
 * collar of 0.6 × its base width; at Sprout's shallow branch angles (θ·mult = 12°–52°) a child
 * runs inside its parent for 2–4 parent widths, so every node stamped a bright white dash along
 * the branch and every primary a bright bead on the trunk. (On Paper, multiply turns the same
 * overlaps into dark nodes, which read naturally; v1 stays as is for the recipes drawn with it.)
 *
 * The fix is geometric: a branch never stacks on the ribbons it grows out of. Each point of a
 * branch carries its crotch clearance (cooked once, at the ceiling); the drawn full width is
 *     w ≤ (2·(d − m) − w_par) / κ        beside a parent's side (a band)
 *     w ≤ √((2·(d − m))² − w_par²)        off a round end the branch radiates from
 * with d the distance to the parent's centreline, m = 0.2 sp of clearance kept, w_par the
 * parent's width there and κ = |cos φ| (φ the angle between the branch and the parent). A
 * branch is drawn from its EXIT, where its centreline has cleared the parent's edge (at the
 * width floor), and widens no faster than the room allows until its own taper takes over (the
 * KNEE): its near edge runs along the parent's edge, so the crotch reads as one continuous
 * shape, the branch peeling off its parent's edge, connected but never stacked.
 *
 * Parents. A primary's parent is the trunk, sampled at s ± 12 sp (the unit's spine window) in
 * 3 sp steps, extended by tangent rays where the window is not the stroke's end, at the station
 * width relative to the unit's (sp.w(s')/sp.w(s)); a radial bush primary's is the seed dot. Any
 * other branch's parent is its parent branch near the node it buds at, cleared at its width as
 * DRAWN (its own crotch included, read from the parent's allowances recorded at emit: parents
 * are emitted first). A twig budding near its parent's root, while the parent is still leaving
 * the grandparent, also sits in the grandparent's ribbon, so every further ancestor (at its
 * nominal width) constrains too, the tightest one per point. The clearance is linear in the
 * stroke width wherever it is not read off a drawn parent, so the entry factor still applies at
 * emit, and it is a function of position along the branch only, so truncation stays exact and
 * rising never re-runs the operator. Only the crotch is constrained: once a branch clears them
 * all at full width it is never pinched again, even where tropism bends it back across.
 *
 * What it cannot remove: two branches of different trees (or cousins) that cross still add on
 * Night, like any two crossing lines of light; that is a crossing, not a crotch.
 *
 * Everything else is v1: anchors, templates, angles, lengths, tropism, alphas, tones, budgets,
 * branch tips. The v1 collar is gone (the clearance subsumes it). A drawn branch never writes
 * more points than v1's prefix count (the exit replaces the root; the knee only takes the place
 * of a point dropped inside the parent), so the budgets count exactly as in v1.
 *
 * Templates (F's outside brackets are the branch's segments; a bracket is a child of
 * the next generation spawned at that node, turned by its signs, + = θ, ++ = 2θ):
 *   fern  F[+F]F[-F]F             (|κ̄| < 0.012)   3 segments, node 1: +, node 2: −
 *   coral F[+F][-F]F              (otherwise)     2 segments, node 1: + and −
 *   bush  FF[+F][-F][++F][--F]    (radial seed)   2 segments, node 2: ±θ, ±2θ; gen ≤ 3
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
/** Width ratio per generation: GW[g] = 0.66^g. */
const GW = [1, 0.66, 0.4356, 0.287496, 0.18974736, 0.1252332576];

/** Trunk samples either side of the anchor (3 sp apart, so s ± 12 sp: the unit's window). */
const TRUNK_HALF = 4, TRUNK_STEP = 3;
/** Floor of κ = |cos φ|: a branch nearly square to its parent may widen 1/0.12 × as fast as it clears. */
const KAPPA_MIN = 0.12;
/** Clearance kept between a branch and its parent's edge (sp): sampling slack, so edges abut instead of stacking. */
const CLEAR_SP = 0.2;
/** Parent window read around a node: this many parent widths plus a few sp, either side. */
const NODE_WIN_W = 8, NODE_WIN_SP = 9;

const v2 = new Float64Array(2), n2 = new Float64Array(2), t2 = new Float64Array(2);

/** Δ(s): anchor spacing from pressure, crowding and curvature averaged over ±12 sp. */
function spacing(cx: FormCx, s: number): number {
  const sp = cx.sp, at = cx.at;
  const p = at.mean(sp.p, s, WIN), c = at.mean(sp.c, s, WIN), k = at.mean(sp.k, s, WIN);
  return clamp(lerp(46, 18, p) * (1 + 1.2 * c) * (1 - 0.3 * Math.min(1, Math.abs(k) / 0.05)), DMIN, DMAX_SP);
}

// ---------------------------------------------------------------------------- parents

/**
 * The parent a branch is cleared against: a polyline (doc), per point its nominal width
 * coefficient (× the base width wb, the full doc width) and, for a parent branch, its point
 * index in the unit (so the child clears the parent's width as DRAWN, crotch included; −1 for
 * the trunk and the seed dot, which are drawn at their nominal width), and whether each end
 * continues as a ray (a window cut of a longer ribbon) or is a real, round end. A single point
 * is a round end: the radial seed's dot.
 */
class Parent {
  x = new Float64Array(64); y = new Float64Array(64); c = new Float64Array(64); id = new Float64Array(64); n = 0;
  rayStart = false; rayEnd = false;
  fit(n: number): void {
    if (n > this.x.length) {
      this.x = new Float64Array(2 * n); this.y = new Float64Array(2 * n); this.c = new Float64Array(2 * n); this.id = new Float64Array(2 * n);
    }
    this.n = 0;
  }
  push(x: number, y: number, c: number, id: number): void {
    const k = this.n++;
    this.x[k] = x; this.y[k] = y; this.c[k] = c; this.id[k] = id;
  }
}
const trunkPar = new Parent(), dotPar = new Parent(), branchPar = new Parent();

/**
 * Result of near(): distance, unit direction of the nearest segment, nominal width coefficient
 * and (fractional) point index there, and whether the nearest point is a real end of the
 * parent (its round cap) rather than its side.
 */
let nD = 0, nUx = 1, nUy = 0, nC = 0, nId = -1, nEnd = false;

/** Nearest point of the parent's centreline to (px, py) (a single point is a round end). */
function near(P: Parent, px: number, py: number): void {
  const n = P.n, X = P.x, Y = P.y, C = P.c, I = P.id;
  let best = Infinity;
  nUx = 1; nUy = 0; nC = C[0]; nId = I[0]; nEnd = true;
  for (let j = 0; j + 1 < n; j++) {
    const dx = X[j + 1] - X[j], dy = Y[j + 1] - Y[j], L2 = dx * dx + dy * dy;
    if (!(L2 > 1e-18)) continue;
    let t = ((px - X[j]) * dx + (py - Y[j]) * dy) / L2;
    let end = false;
    if (t < 0 && !(j === 0 && P.rayStart)) { t = 0; end = j === 0; }
    else if (t > 1 && !(j + 2 === n && P.rayEnd)) { t = 1; end = j + 2 === n; }
    const qx = X[j] + dx * t, qy = Y[j] + dy * t;
    const d2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
    if (d2 < best) {
      best = d2;
      const L = Math.sqrt(L2);
      nUx = dx / L; nUy = dy / L; nEnd = end;
      const tc = t < 0 ? 0 : t > 1 ? 1 : t;
      nC = C[j] + (C[j + 1] - C[j]) * tc;
      nId = I[j] < 0 ? -1 : I[j] + tc;
    }
  }
  nD = best < Infinity ? Math.sqrt(best) : Math.sqrt((X[0] - px) * (X[0] - px) + (Y[0] - py) * (Y[0] - py));
}

/** Headings of the branch being walked (per local point), reused. */
let HX = new Float64Array(64), HY = new Float64Array(64);

/**
 * Clearance data of a branch point (g.aux, QS values per point; cooked once, at the ceiling).
 * A branch clears its parent and its further ancestors: a twig budding near its parent's root,
 * while the parent is still leaving the grandparent, sits in the grandparent's ribbon too.
 *   [0] parent: 2(d − m)/κ beside a band, 2(d − m) off a round end (d to the centreline, m the
 *       clearance kept, κ = |cos φ| with φ the angle between the branch and the parent there)
 *   [1] parent: 1/κ beside a band, −1 off a round end
 *   [2] parent: fractional point index of the nearest parent point (the parent's width is read
 *       there as DRAWN at emit, its own crotch included), or −1: nominal width [3]·wb (trunk, dot)
 *   [3] parent: nominal width coefficient there
 *   [4] the tightest further ancestor (at the widest base width): as [0] (∞: none)
 *   [5] that ancestor: nominal width coefficient / κ beside a band, −coefficient off a round end
 * Past the crotch [0] = ∞.
 */
const QS = 6;

/**
 * Crotch allowance (doc) of the current tree's points as emitted, reused: at a vertex whose
 * segment is still in the crotch its allowance (interpolated linearly along the segment, as
 * branchEmit draws it), ∞ past the knee (the branch is drawn at its nominal width there).
 */
let DL = new Float64Array(256);

/**
 * The parent's full width (doc) at the nearest parent point of the point at q[o]: as drawn
 * (min(nominal, allowance), 0 where it is still inside its own parent), or nominal for the
 * trunk and the seed dot.
 */
function parentW(q: Float64Array, o: number, wb: number): number {
  const ref = q[o + 2], n = wb * q[o + 3];
  if (!(ref >= 0)) return n;
  const j = Math.floor(ref), t = ref - j;
  const a0 = DL[j], a1 = t > 0 ? DL[j + 1] : a0;
  if (!(a0 < Infinity) || !(a1 < Infinity)) return n;
  const lim = a0 + (a1 - a0) * t, w = lim < n ? lim : n;
  return w > 0 ? (w > eFloor ? w : eFloor) : 0;
}

/** Allowance from a clearance numerator q0, a width wp and a band factor q1 (> 0) or a round end (< 0). */
function allow1(q0: number, q1: number, wp: number): number {
  if (!(q1 < 0)) return q0 - wp * q1;
  const e = q0 * q0 - wp * wp;
  return q0 > wp && e > 0 ? Math.sqrt(e) : q0 - wp;
}

/**
 * The signed reach of point i past its parents' edges (×2, ÷κ beside a band): linear in the
 * distance, so the exit (reach = floor) is an exact crossing.
 */
function reach(g: UnitGeom, i: number, wb: number): number {
  const q = g.aux, o = i * QS;
  if (!(q[o] < Infinity)) return Infinity;
  const wp = parentW(q, o, wb), q1 = q[o + 1];
  const rp = q1 < 0 ? q[o] - wp : q[o] - wp * q1;
  const q5 = q[o + 5], rg = q[o + 4] - wb * (q5 < 0 ? -q5 : q5);
  return rg < rp ? rg : rp;
}

/**
 * Crotch allowance (doc) at point i: twice the room between the branch's centreline and the
 * nearer of its parents' edges, measured along the branch's normal. Beside a band it is the
 * reach. Off a round end (the branch radiating from its centre) a ribbon edge at (d, w/2)
 * clears the disc of radius r while d² + w²/4 ≥ r², so w = √(q0² − wp²) past the rim (the
 * edges leave the rim tangentially); inside it the reach (< 0), continuous at the rim.
 */
function allowed(g: UnitGeom, i: number, wb: number): number {
  const q = g.aux, o = i * QS;
  if (!(q[o] < Infinity)) return Infinity;
  const ap = allow1(q[o], q[o + 1], parentW(q, o, wb));
  const q5 = q[o + 5];
  const ag = q5 < 0 ? allow1(q[o + 4], -1, -wb * q5) : q[o + 4] - wb * q5;
  return ag < ap ? ag : ap;
}

/** Clearance numerator and factor of the nearest point (after near()) at clearance m: into CL. */
function clearOf(k: number, m: number): void {
  if (nEnd) { CL[0] = 2 * (nD - m); CL[1] = -1; return; }
  const cs = HX[k] * nUx + HY[k] * nUy;
  let kap = cs < 0 ? -cs : cs;
  if (kap < KAPPA_MIN) kap = KAPPA_MIN;
  CL[0] = (2 * (nD - m)) / kap; CL[1] = 1 / kap;
}
const CL = new Float64Array(2);

/** Parent branch (−1: the root parent) and the node it buds at, per branch of the tree being grown. */
let BP = new Int32Array(64), BN = new Int32Array(64);
/** The further ancestors (grandparent and up) of the branch being cleared: the root parent or a window in ANC_SCRATCH. */
const ANC: Parent[] = [];

/**
 * Crotch clearance of branch b against its parent P and its further ancestors (up to the root
 * parent R), per point (see QS): a twig budding near its parent's root sits in the ribbons its
 * parent is still leaving. Of the further ancestors the one leaving the least room at the
 * widest base width is kept per point. Filled until the point where the branch clears all of
 * them at their NOMINAL widths at its own full nominal width for any wb ≤ g.w: a drawn parent
 * is never wider, and the allowance only grows as wb shrinks, so the knee always falls at or
 * before it. The rest is unconstrained ([0] = ∞).
 */
function crotch(g: UnitGeom, b: number, P: Parent, R: Parent, z: number): void {
  const o = g.bOff[b], cnt = g.bCnt[b], gen = g.bGen[b], len = g.bLen[b], m = CLEAR_SP / z;
  g.auxFit(o + cnt, QS);
  const q = g.aux, X = g.px, Y = g.py, A = g.pa, wMax = g.w;
  const c0 = GW[gen - 1], dc = (GW[gen] - c0) / len;
  // the further ancestors: the window of each around the node its child on the line buds at
  let nA = 0;
  for (let cur = BP[b]; cur >= 0; cur = BP[cur]) {
    const up = BP[cur];
    ANC[nA] = up < 0 ? R : nodeWindow(g, up, BN[cur], z, ANC_SCRATCH[nA]);
    nA++;
  }
  let k = 0;
  for (; k < cnt; k++) {
    const i = (o + k) * QS, x = X[o + k], y = Y[o + k], wn = wMax * (c0 + dc * A[o + k]);
    near(P, x, y);
    clearOf(k, m);
    q[i] = CL[0]; q[i + 1] = CL[1]; q[i + 2] = nId; q[i + 3] = nC;
    let clear = allow1(CL[0], CL[1], wMax * nC) >= wn;
    let best = Infinity;
    q[i + 4] = Infinity; q[i + 5] = 0;
    for (let j = 0; j < nA; j++) {
      near(ANC[j], x, y);
      clearOf(k, m);
      const lim = allow1(CL[0], CL[1], wMax * nC);
      if (lim < best) { best = lim; q[i + 4] = CL[0]; q[i + 5] = CL[1] < 0 ? -nC : nC * CL[1]; }
    }
    // clear of them all at full width, at the widest base width: clear for good
    if (clear && best >= wn) { k++; break; }
  }
  for (; k < cnt; k++) { const i = (o + k) * QS; q[i] = Infinity; q[i + 1] = 0; q[i + 2] = -1; q[i + 3] = 0; q[i + 4] = Infinity; q[i + 5] = 0; }
}
/** Ancestor windows, one per level (a branch has at most GMAX − 1 branch ancestors), reused. */
const ANC_SCRATCH: Parent[] = [new Parent(), new Parent(), new Parent(), new Parent()];

/**
 * The parent of a child budding at point index `node` of branch pb, into P: the branch's points
 * within the node window. Cut ends continue as rays; the branch's own ends stay round (a bush
 * child buds from its parent's tip and radiates from it).
 */
function nodeWindow(g: UnitGeom, pb: number, node: number, z: number, P: Parent): Parent {
  const o = g.bOff[pb], cnt = g.bCnt[pb], gen = g.bGen[pb], len = g.bLen[pb], A = g.pa;
  const c0 = GW[gen - 1], dc = (GW[gen] - c0) / len;
  const R = NODE_WIN_W * g.w * c0 * z + NODE_WIN_SP, an = A[node];
  let i0 = node - o, i1 = node - o;
  while (i0 > 0 && an - A[o + i0 - 1] <= R) i0--;
  while (i1 < cnt - 1 && A[o + i1 + 1] - an <= R) i1++;
  if (i0 > 0) i0--;                 // one segment past the window, so the cut is beyond R
  if (i1 < cnt - 1) i1++;
  P.fit(i1 - i0 + 1);
  for (let i = i0; i <= i1; i++) P.push(g.px[o + i], g.py[o + i], c0 + dc * A[o + i], o + i);
  P.rayStart = i0 > 0; P.rayEnd = i1 < cnt - 1;
  return P;
}

// ---------------------------------------------------------------------------- growth

/**
 * Branch-building scratch: a stack of pending children (pos, heading, gen, length, id, and the
 * parent branch with the node it buds at; −1 = the root parent).
 */
interface Pending { x: number; y: number; hx: number; hy: number; g: number; len: number; id: number; pb: number; node: number }
const stack: Pending[] = [];
let stackN = 0;
function pushPending(x: number, y: number, hx: number, hy: number, g: number, len: number, id: number, pb: number, node: number): void {
  if (stackN === stack.length) stack.push({ x: 0, y: 0, hx: 0, hy: 0, g: 0, len: 0, id: 0, pb: 0, node: 0 });
  const e = stack[stackN++];
  e.x = x; e.y = y; e.hx = hx; e.hy = hy; e.g = g; e.len = len; e.id = id; e.pb = pb; e.node = node;
}

/**
 * Grow one tree into g: primaries from `roots` already pushed on the stack (parent −1: `root`).
 * Branch b of gen gb walks its segments in substeps ≤ 3 sp, turning toward screen-up by
 * 0.008·cross(h, up) rad per sp, and spawns its children at template nodes; then its crotch
 * clearance against its parent and further ancestors is filled in.
 */
function growTree(g: UnitGeom, z: number, seed: number, addr: number, tmpl: number, theta: number, sigma: number, upx: number, upy: number, root: Parent): void {
  const segs = SEGS[tmpl], kids = KIDS[tmpl], gmax = GMAX[tmpl];
  while (stackN > 0) {
    const e = stack[--stackN];
    let x = e.x, y = e.y, hx = e.hx, hy = e.hy;
    const gb = e.g, len = e.len, id = e.id, pb = e.pb, pnode = e.node;
    const b = g.beginBranch(gb, len);
    const segLen = len / segs, nsub = Math.max(1, Math.ceil(segLen / SUB)), d = segLen / nsub;
    const nLocal = 1 + segs * nsub;
    if (nLocal > HX.length) { HX = new Float64Array(2 * nLocal); HY = new Float64Array(2 * nLocal); }
    g.addPt(x, y, 0);
    HX[0] = hx; HY[0] = hy;
    let arc = 0, kl = 1;
    // children are pushed after the walk so the stack order (and thus point order) is fixed
    let nk = 0;
    const kx = KX, ky = KY, khx = KHX, khy = KHY, km = KM, kn = KN;
    for (let sgi = 1; sgi <= segs; sgi++) {
      for (let q = 0; q < nsub; q++) {
        const turn = TROPISM * (hx * upy - hy * upx) * d;
        const c = dcos(turn), s = dsin(turn);
        const nx = hx * c - hy * s, ny = hx * s + hy * c;
        hx = nx; hy = ny;
        x += hx * d / z; y += hy * d / z;
        arc = sgi === segs && q === nsub - 1 ? len : arc + d;
        g.addPt(x, y, arc);
        HX[kl] = hx; HY[kl] = hy; kl++;
      }
      if (gb < gmax) {
        for (let m = 0; m < kids.length; m += 2) {
          if (kids[m] !== sgi) continue;
          kx[nk] = x; ky[nk] = y; khx[nk] = hx; khy[nk] = hy; km[nk] = kids[m + 1]; kn[nk] = g.nPts - 1; nk++;
        }
      }
    }
    g.endBranch(b);
    if (b >= BP.length) { const c = 2 * (b + 1); const p2 = new Int32Array(c); p2.set(BP); BP = p2; const n2 = new Int32Array(c); n2.set(BN); BN = n2; }
    BP[b] = pb; BN[b] = pnode;
    crotch(g, b, pb < 0 ? root : nodeWindow(g, pb, pnode, z, branchPar), root, z);
    for (let q = nk - 1; q >= 0; q--) {
      const cid = id * FAN + q + 1;
      const mult = 0.75 + 0.5 * rnd(seed, Ch.Angle, addr, cid);
      const a = sigma * km[q] * theta * mult;
      const c = dcos(a), s = dsin(a);
      const chx = khx[q] * c - khy[q] * s, chy = khx[q] * s + khy[q] * c;
      const clen = 0.55 * len * (0.8 + 0.4 * rnd(seed, Ch.Length, addr, cid));
      pushPending(kx[q], ky[q], chx, chy, gb + 1, clen, cid, b, kn[q]);
    }
  }
}
const KX = new Float64Array(8), KY = new Float64Array(8), KHX = new Float64Array(8), KHY = new Float64Array(8), KM = new Float64Array(8);
const KN = new Int32Array(8);

/**
 * Points of the tree at depth D (gen g drawn to ℓ·clamp(D − g + 1, 0, 1)): an upper bound of
 * what treeEmit writes, since the exit replaces the root and a knee only replaces a point
 * already dropped inside the parent.
 */
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

// ---------------------------------------------------------------------------- emit

/** The poly being written (opened lazily: a branch still inside its parent writes nothing). */
let eOut: Sink | null = null, eOpen = false, eFloor = 0, eGen = 0, eAlpha = 0, eTone = 0, eBorn = 0, eUnit = 0;
/** Drawn length of the branch being written, its last written node, and whether it ended. */
let eLam = 0, eDone = false, pHas = false, pA = 0, pX = 0, pY = 0, pW = 0;
/** The branch being written is still in its crotch (its width is the allowance, not the taper). */
let bActive = true;

function put(x: number, y: number, w: number): void {
  const out = eOut as Sink;
  if (!eOpen) { out.begin(PolyKind.Ribbon, eGen, eAlpha, eTone, eBorn, eUnit, 1); eOpen = true; }
  out.pt(x, y, w > eFloor ? w : eFloor);
}

/**
 * Offer the branch's next node: written while its arc is below the drawn length; the first
 * node at or past it ends the branch with the tip interpolated from the last written node. So
 * a truncated branch is always a prefix of the full branch's polyline (truncation is exact).
 */
function node(a: number, x: number, y: number, w: number): void {
  if (eDone) return;
  if (a < eLam) { put(x, y, w); pHas = true; pA = a; pX = x; pY = y; pW = w; return; }
  eDone = true;
  if (!pHas) return;
  const t = a > pA ? (eLam - pA) / (a - pA) : 1;
  if (t >= 1) put(x, y, w);
  else put(pX + (x - pX) * t, pY + (y - pY) * t, pW + (w - pW) * t);
}

/** Drawn width at allowance lim and nominal width n: the allowance, capped by the taper, past the crotch the taper. */
function crotchW(lim: number, n: number): number {
  if (!bActive) return n;
  const w = lim < n ? lim : n;
  return w > 0 ? w : 0;
}

/** Offer the node at fraction t of segment (p → q). */
function nodeAt(t: number, xp: number, yp: number, ap: number, lp: number, np: number, x: number, y: number, a: number, l: number, nn: number): void {
  if (t >= 1) { node(a, x, y, crotchW(l, nn)); return; }
  node(ap + (a - ap) * t, xp + (x - xp) * t, yp + (y - yp) * t, crotchW(lp + (l - lp) * t, np + (nn - np) * t));
}

/**
 * Emit branch b drawn to arc lam with base width wb. Nodes: the exit (where the ribbon opens
 * to the floor width, replacing the root), the vertices after it, and the knee (where the
 * allowance reaches the nominal width) when a vertex inside the parent made room for it, so a
 * branch never writes more points than v1's prefix count. Within a segment the nominal width
 * is linear and the allowance is interpolated linearly from the exit on (exact beside a band;
 * off a round end the true allowance is concave past the rim, so the chord stays under it); the
 * exit is found on the linear reach, so exit and knee are exact crossings. Returns the points
 * written.
 */
function branchEmit(g: UnitGeom, b: number, lam: number, wb: number, out: Sink): number {
  const o = g.bOff[b], cnt = g.bCnt[b], gen = g.bGen[b], len = g.bLen[b];
  const X = g.px, Y = g.py, A = g.pa;
  const w0 = wb * GW[gen - 1], dw = (wb * GW[gen] - w0) / len, floor = eFloor;
  bActive = true;
  eOpen = false; eLam = lam; eDone = false; pHas = false;
  let started = false, spare = 0;
  let xp = X[o], yp = Y[o], ap = A[o], lp = allowed(g, o, wb), np = w0;
  let rp = reach(g, o, wb);
  DL[o] = lp;
  if (rp >= floor) {
    // already open at the root (a stroke start of zero width): no crotch to cut
    started = true;
    nodeAt(0, xp, yp, ap, lp, np, xp, yp, ap, lp, np);
    if (!(lp < np)) bActive = false;
  }
  for (let k = 1; k < cnt && !eDone; k++) {
    const x = X[o + k], y = Y[o + k], a = A[o + k], nn = w0 + dw * a;
    let l = 0;
    DL[o + k] = Infinity;
    if (bActive) {
      l = allowed(g, o + k, wb);
      DL[o + k] = l;
      if (!(l < Infinity)) { bActive = false; l = 0; } // unreachable: the knee comes first (see crotch)
    }
    if (!started) {
      const r = reach(g, o + k, wb), ep = rp - floor, e = r - floor;
      if (!(e >= 0)) { spare++; xp = x; yp = y; ap = a; lp = l; np = nn; rp = r; continue; } // vertex k is still inside
      // the exit: the rest of this segment starts from it, at the floor width
      const t0 = ep < 0 ? -ep / (e - ep) : 0;
      xp += (x - xp) * t0; yp += (y - yp) * t0; ap += (a - ap) * t0; np += (nn - np) * t0; lp = floor;
      if (t0 < 1) node(ap, xp, yp, crotchW(lp, np));
      started = true;
    }
    if (bActive) {
      const gp = lp - np, gk = l - nn;
      if (gk >= 0) {
        const t = gp >= 0 ? 0 : -gp / (gk - gp);
        if (spare > 0 && t > 0 && t < 1) { nodeAt(t, xp, yp, ap, lp, np, x, y, a, l, nn); spare--; }
        bActive = false;
      }
    }
    nodeAt(1, xp, yp, ap, lp, np, x, y, a, l, nn);
    xp = x; yp = y; ap = a; lp = l; np = nn;
  }
  const n = eOpen ? out.end() : 0;
  eOpen = false;
  return n;
}

/** Emit the tree truncated to D: one Ribbon per drawn branch, from its exit off the parent. */
function treeEmit(g: UnitGeom, D: number, wb: number, z: number, born: number, unit: number, out: Sink): number {
  const gl = glow(g.c);
  eOut = out; eFloor = W_FLOOR / z; eBorn = born; eUnit = unit;
  if (DL.length < g.nPts) DL = new Float64Array(2 * g.nPts);
  let pts = 0;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b], f = clamp(D - gen + 1, 0, 1);
    if (!(f > 0)) continue;
    eGen = gen; eAlpha = ALPHA * hierarchy(gen) * gl; eTone = toneOf(g.p, gen);
    pts += branchEmit(g, b, g.bLen[b] * f, wb, out);
  }
  eOut = null;
  return pts;
}

// ---------------------------------------------------------------------------- chain

/** Primary length ℓ_1 (sp) at pressure p, crowding c, rng r. */
const primaryLen = (S: number, p: number, c: number, r: number): number =>
  (20 + 2 * S) * (0.4 + 1.3 * p) * (0.6 + 0.8 * r) * (1 - 0.3 * c);
/** Branch angle θ (rad): pressing harder opens the branches. */
const thetaOf = (p: number): number => (16 + 26 * smoothstep(0.25, 0.85, p)) * DEG;

/**
 * The trunk around anchor s as a parent: stations sampled at s ± 12 sp (the unit's window;
 * the sampler clamps at the stroke's ends), widths relative to the unit's. An end continues
 * as a tangent ray unless the window reached the stroke's end there (a real, round end).
 */
function trunkParent(cx: FormCx, s: number, w: number): Parent {
  const sp = cx.sp, at = cx.at, P = trunkPar;
  P.fit(2 * TRUNK_HALF + 1);
  for (let i = -TRUNK_HALF; i <= TRUNK_HALF; i++) {
    const si = s + TRUNK_STEP * i;
    at.pos(si, v2);
    P.push(v2[0], v2[1], w > 0 ? at.at(sp.w, si) / w : 1, -1);
  }
  P.rayStart = s - TRUNK_HALF * TRUNK_STEP >= cx.s0;
  P.rayEnd = s + TRUNK_HALF * TRUNK_STEP <= cx.L;
  return P;
}

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
    at.normal(s, n2); at.tangent(s, t2);
    const p = at.at(sp.p, s), c = at.at(sp.c, s), vn = at.at(sp.vn, s);
    g.w = at.at(sp.w, s); g.p = p; g.c = c;
    const root = trunkParent(cx, s, g.w);
    at.pos(s, v2);
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
    pushPending(v2[0], v2[1], hx0 * cl - hy0 * sl, hx0 * sl + hy0 * cl, 1, len, 1, -1, 0);
    growTree(g, z, r.seed, j * 8, rec.tmpl, theta, sigma, upx, upy, root);
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
 * generation 3, at depth base + a_0 (the dot is the cook's; the primaries leave its rim).
 */
function sproutRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const r = cx.r, z = cx.z;
  const D = clamp(depth, 0, GMAX[BUSH]);
  if (!(D > 0)) return 0;
  burst.reset();
  burst.p = seed.p; burst.c = seed.c; burst.w = seed.w;
  const dot = dotPar;
  dot.fit(1); dot.push(seed.x, seed.y, 1, -1); dot.rayStart = false; dot.rayEnd = false;
  const theta = thetaOf(seed.p);
  const rot0 = 72 * DEG * rnd(r.seed, Ch.Angle, RADIAL_ID, 1);
  const upx = dsin(r.rot), upy = -dcos(r.rot);
  for (let i = 0; i < BURST; i++) {
    const addr = (RADIAL_ID + 8 + i * 8) | 0;
    const a = 72 * DEG * i + rot0 + (rnd(r.seed, Ch.Angle, addr) - 0.5) * 2 * BURST_JIT;
    const len = primaryLen(r.stroke.size, seed.p, seed.c, rnd(r.seed, Ch.Length, addr));
    stackN = 0;
    pushPending(seed.x, seed.y, dcos(a), dsin(a), 1, len, 1, -1, 0);
    growTree(burst, z, r.seed, addr, BUSH, theta, 1, upx, upy, dot);
  }
  const Dc = Math.min(D, treeCeiling(burst, GMAX[BUSH]));
  treeEmit(burst, Dc, seed.w, z, cx.s0, 0, out);
  return Dc;
}

/** Sprout v2. */
export const sprout: FormOps = {
  id: 'sprout', v: 2, locality: 'local', reach: 24, dMax: 4, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: sproutRadial,
  radialCeiling: 3,
};
