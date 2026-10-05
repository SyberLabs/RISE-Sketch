/**
 * Plume — the stroke as a rachis (lab prototype, brief: lab/forms/briefs/plume.md).
 *
 * The stroke is a feather's shaft. From both edges grows a vane of dense, parallel, gently
 * curved barbs with a soft undulating outer edge (a 24 sp lattice of random vane widths);
 * the entry taper is the bare quill. Fast strokes lay the barbs back toward the tip and
 * ruffle them into groups of 8 sp that sway together; slow strokes are pristine. At depth
 * 1+ barbules fringe every second barb (one zigzag poly per barb: a translucent sheet); at
 * depth 2+ every second barb pair grows a loose plumulaceous down barb (a held hand goes fluffy). The
 * concave vane of a curve is capped at 0.7/|κ̄|, so a closed loop is an ocellus with a clear
 * pupil. A tap is a tuft of down; a bloom grows into a powder-down rosette.
 *
 * Operator model: unit j = two barb pairs, at s_j and s_j + Δ/2, pitch Δ ≈ 3.7 sp at S 9 (two
 * pairs per unit because the cook's per-unit overhead dominates the cost of a unit this small).
 * Barbules ride on the first pair only (one zigzag per side every Δ), and barbs are 4 substeps
 * of ≤ 6 sp: ≈ 9 points per sp of stroke at base 2 (the brief budgets 16). Everything is a
 * prefix or a width, so depth is continuous: barbs to ℓ·clamp(D, 0, 1), barbules to clamp(D − 1, 0, 1),
 * down to clamp(D − 2, 0, 1). The entry factor E is applied at emit only (drawn length and
 * width), so a unit's cooked geometry depends only on the spine within ±6 sp of s_j, d(s_j)
 * and its integer rng addresses.
 *
 * Decisions vs the brief:
 *  - The `tip` taper (keyed on cx.final) is dropped: a unit within 40 sp of the tail is
 *    already emitted live (settled trails the nib by ~20 sp) and the cook only re-truncates
 *    at finish, so a final-only factor would break incremental ≡ full. The shaft's exit
 *    taper carries the end, as the brief's own risk note allows.
 *  - Angles are kept in the (σn, T) frame: heading(θ) = σn·sin θ + T·cos θ with θ the angle
 *    from the shaft; rotating toward the tip is θ − γ. No rotation matrices.
 *  - Barbule nodes sit on the barb's own substeps (≤ 4, from 0.4ℓ), not every 3 sp, and ℓ is
 *    capped at 42 sp, so a unit is ≤ 56 points at the ceiling whatever the nib.
 *  - Barbs root on the shaft edge through an undrawn root marker per barb (σn·0.45w), slid in
 *    by (1 − E) at emit, so the vane stays on the tapering quill (E is still emit-only).
 *  - The tap tuft is 12 curled down barbs (a swirl, not a random star), barbules at D > 1 and
 *    12 more between them at D > 2, drawn a little brighter than the vane (it stands alone).
 *  - The concave cap is CAP·sin θ0/|κ̄| rather than 0.7/|κ̄|: barbs leaving a circle of radius
 *    R at angle θ from the shaft all touch the circle R·cos θ and cross each other beyond
 *    R·sin θ, so a fixed cap let fast (laid-back) inner vanes fold through themselves.
 *  - Down waves as a smooth sine rather than a random walk; the walk read as spider legs.
 */
import { PolyKind } from '../../src/core/types';
import { rnd, Ch, dcos, dsin, PI, TAU } from '../../src/core/det';
import { clamp, smoothstep } from '../../src/core/num';
import { chiselAngle } from '../../src/ink/nibs';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from '../../src/ink/operators/types';
import { UnitGeom, toneOf, glow, hierarchy } from '../../src/ink/operators/types';
import { RADIAL_ID } from '../../src/ink/operators/line.v1';
import type { LabFormMeta } from './harness';

export const meta: LabFormMeta = {
  name: 'Plume',
  v: 102,
  ink: 'ochre',
  notes: 'The stroke is a feather shaft; a vane of parallel curved barbs grows from both edges. Speed sweeps and ruffles the vane into swaying groups; pressure widens it; lean (or curvature) makes it asymmetric; the inner vane of a curve is capped so a loop is an ocellus. Depth 1+ barbules fringe the barbs, depth 2+ (a hold) turns it to down. A tap is a tuft of down.',
};

const DEG = PI / 180;
/** Barb pairs per unit (at s_j and s_j + Δ/2) and the spine window a pair reads either side (sp). */
const PAIRS = 2, WIN = 6;
/** Unit window: the second pair sits ≤ Δmax/2 = 4.8 sp past s_j. */
const HALF_WIN = WIN + 5;
/** Unit depth ceiling. */
const DMAX = 3;
/** Barb substeps (max), down steps (max), substep length (sp). */
const NSUB = 4, NDOWN = 10, SUB = 6;
/** Barb width: fraction of the nib width, clamped (sp); tip fraction; collar in base widths. */
const WB_F = 0.16, WB_MIN = 0.45, WB_MAX = 1.4, WB_TIP = 0.3, COLLAR = 0.6;
/** Barbule and down widths (sp). */
const W_HAIR = 0.35, W_DOWN = 0.55;
/** Design alphas (Night) before hierarchy and glow. */
const ALPHA = 0.5;
/** Barbule angle from the barb toward the tip, and the barbule length in pitches. */
const GAMMA = 55 * DEG, BARBULE_F = 0.85;
/** Down barb length factor and heading wander per step (rad). */
const DOWN_F = 1.4, WANDER = 0.5;
/** Vane-width lattice (sp) and ruffle group (sp). */
const VANE_CELL = 24, RUFFLE_CELL = 8;
/**
 * Concave-side cap: barbs leaving a circle of radius R at angle θ from the shaft all touch the
 * circle of radius R·cos θ, so they cross each other beyond R·sin θ; ℓ ≤ CAP·sin θ0/|κ̄|.
 */
const CAP = 0.8;
/** Shortest and longest barb (sp). */
const MIN_LEN = 0.6, MAX_LEN = 42;
/** Points per unit, the causal stroke budget and a tap's tuft budget. */
const UNIT_BUDGET = 80, STROKE_BUDGET = 24000, TUFT_BUDGET = 640;
/** Down barbs of a tap and their heading jitter. */
const TUFT = 12, TUFT_JIT = 8 * DEG, TUFT_F = 1.05, TUFT_WANDER = 0.18, TUFT_CURL = 40 * DEG, TUFT_ALPHA = 0.68, TUFT_BARBULE = 0.3, TUFT_SUB = 3, TUFT_NSUB = 12;
/** Heading range from the shaft (rad): a hair never crosses the shaft or points back along it. */
const TH_MIN = 4 * DEG, TH_MAX = 150 * DEG;
/** Branch gen tags inside a UnitGeom. */
const G_BARB = 1, G_BARBULE = 2, G_DOWN = 3;
/**
 * A root marker (never drawn) precedes each barb: one point holding the offset from the shaft
 * centre to the barb's root (σn·0.45w). At emit the barb, its barbules and its down slide in by
 * (1 − E)·offset, so in the entry taper the vane stays rooted on the tapering shaft's edge.
 */
const G_ROOT = 0;

const v2 = new Float64Array(2), n2 = new Float64Array(2), t2 = new Float64Array(2);
/** Node heading angles of the barb being built (scratch). */
const nodeTh = new Float64Array(Math.max(NDOWN, TUFT_NSUB, NSUB) + 1);

/** Δ(s): barb pitch from the nib size and crowding. */
function pitch(S: number, c: number): number {
  return clamp(3.1 + 0.07 * S, 3.1, 6.4) * (1 + 0.6 * clamp(c, 0, 1));
}

/** Smooth lerp of two lattice values. */
const slerp = (a: number, b: number, t: number): number => a + (b - a) * (t * t * (3 - 2 * t));

/** vane(s): the undulating outer edge, 0.88..1.12, smooth across 24 sp cells. */
function vaneAt(seed: number, s: number): number {
  const u = s / VANE_CELL, i = Math.floor(u), t = u - i;
  return 0.88 + 0.24 * slerp(rnd(seed, Ch.Growth, i), rnd(seed, Ch.Growth, i + 1), t);
}

/**
 * Walk one hair of `len` sp from (x, y) in the frame (A, B): dir(θ) = A·sin θ + B·cos θ.
 * θ starts at th0, bends by −curve over the length (toward B) and, for down, waves by
 * ±wander as a smooth sine. Node angles are left in nodeTh; returns the branch index.
 */
function hair(g: UnitGeom, gen: number, len: number, x: number, y: number, ax: number, ay: number, bx: number, by: number,
  th0: number, curve: number, wander: number, seed: number, addr: number, nmax: number, sub: number, z: number): number {
  const nsub = Math.max(1, Math.min(nmax, Math.ceil(len / sub))), d = len / nsub;
  const b = g.beginBranch(gen, len);
  g.addPt(x, y, 0);
  nodeTh[0] = th0;
  // down waves smoothly: a sine of random phase and period (6–14 steps) along the hair
  const ph = wander > 0 ? TAU * rnd(seed, Ch.Jitter, addr, 0) : 0;
  const om = wander > 0 ? TAU / (6 + 8 * rnd(seed, Ch.Jitter, addr, 1)) : 0;
  for (let k = 1; k <= nsub; k++) {
    const th = wander > 0 ? th0 + wander * dsin(ph + om * k) : th0;
    const t = th - curve * ((k - 0.5) / nsub);
    const tt = t < TH_MIN ? TH_MIN : t > TH_MAX ? TH_MAX : t;
    const sn = dsin(tt), cs = dcos(tt);
    x += (ax * sn + bx * cs) * d / z; y += (ay * sn + by * cs) * d / z;
    g.addPt(x, y, k === nsub ? len : k * d);
    nodeTh[k] = tt;
  }
  g.endBranch(b);
  return b;
}

/**
 * Barbules of barb branch `b`: one zigzag node_k, tip_k, node_{k+1}, tip_{k+1}, … over the
 * nodes from 0.25ℓ on, each tip `bl` sp from its node at θ − γ (toward the feather tip).
 */
function barbules(g: UnitGeom, b: number, len: number, bl: number, ax: number, ay: number, bx: number, by: number, z: number): void {
  const o = g.bOff[b], n = g.bCnt[b];
  const zb = g.beginBranch(G_BARBULE, 0);
  let arc = 0, lx = 0, ly = 0, first = true;
  for (let k = 1; k < n; k++) {
    if (g.pa[o + k] < 0.4 * len) continue;
    const t = nodeTh[k] - GAMMA;
    const sn = dsin(t), cs = dcos(t);
    const x = g.px[o + k], y = g.py[o + k];
    const tx = x + (ax * sn + bx * cs) * bl / z, ty = y + (ay * sn + by * cs) * bl / z;
    if (!first) arc += Math.sqrt((x - lx) * (x - lx) + (y - ly) * (y - ly)) * z;
    g.addPt(x, y, arc);
    arc += bl;
    g.addPt(tx, ty, arc);
    lx = tx; ly = ty; first = false;
  }
  g.endBranch(zb);
  g.bLen[zb] = arc;
}

/** Drawn fraction of a branch of gen `gen` at depth D. */
const genF = (gen: number, D: number): number => clamp(D - gen + 1, 0, 1);

/** Points the unit emits at depth D with entry factor E (barbules only while g.k > 0). */
function unitCount(g: UnitGeom, D: number, E: number): number {
  let n = 0;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b];
    if (gen === G_ROOT || (gen === G_BARBULE && !(g.k > 0))) continue;
    const f = genF(gen, D) * E;
    if (f > 0) n += g.prefixCount(b, g.bLen[b] * f);
  }
  return n;
}

/** Largest 1/16 level ≤ dMax whose point count fits `budget`. */
function unitCeiling(g: UnitGeom, dMax: number, budget: number): number {
  if (unitCount(g, dMax, 1) <= budget) return dMax;
  let lo = 0, hi = Math.round(dMax * 16);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (unitCount(g, m / 16, 1) <= budget) lo = m; else hi = m; }
  return lo / 16;
}

/** Barb width (doc) at arc a of a barb of length len: w0 → WB_TIP·w0, eased in over the collar. */
function barbWidth(w0: number, a: number, len: number, collar: number): number {
  const w = w0 * (1 + (WB_TIP - 1) * (a / len));
  return a < collar ? w * smoothstep(0, collar, a) : w;
}

/**
 * Emit g truncated to depth D with entry factor E: barbs as tapering ribbons (chisel polys at
 * the nib angle for the chisel nib), barbules and down as hairlines.
 */
function unitEmit(g: UnitGeom, D: number, E: number, z: number, born: number, unit: number, kind: PolyKind, ang: number, hairOnly: boolean, out: Sink): number {
  const gl = glow(g.c), hair = W_HAIR / z, downW = W_DOWN / z;
  const wb = hairOnly ? downW : clamp(WB_F * g.w * z * E, WB_MIN, WB_MAX) / z;
  const collar = COLLAR * wb * z;
  let pts = 0, ox = 0, oy = 0;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b];
    if (gen === G_ROOT) { ox = (1 - E) * g.px[g.bOff[b]]; oy = (1 - E) * g.py[g.bOff[b]]; continue; }
    if (gen === G_BARBULE && !(g.k > 0)) continue;
    const f = genF(gen, D) * E;
    if (!(f > 0)) continue;
    const len = g.bLen[b], lam = len * f;
    const o = g.bOff[b], cnt = g.bCnt[b], pa = g.pa;
    const barb = gen === G_BARB;
    const alpha = (hairOnly ? TUFT_ALPHA : ALPHA) * hierarchy(gen) * gl * (gen === G_BARBULE ? g.k : 1);
    out.begin(barb ? kind : PolyKind.Ribbon, gen, alpha, toneOf(g.p, gen), born, unit, 1);
    let k = 0;
    for (; k < cnt && (k === 0 || pa[o + k] < lam); k++) {
      const w = barb ? barbWidth(wb, pa[o + k], len, collar) : gen === G_DOWN ? downW : hair;
      out.pt(g.px[o + k] - ox, g.py[o + k] - oy, w > hair ? w : hair, ang);
    }
    if (k < cnt) {
      const a0 = pa[o + k - 1], a1 = pa[o + k];
      const t = a1 > a0 ? (lam - a0) / (a1 - a0) : 1;
      const x = t >= 1 ? g.px[o + k] : g.px[o + k - 1] + (g.px[o + k] - g.px[o + k - 1]) * t;
      const y = t >= 1 ? g.py[o + k] : g.py[o + k - 1] + (g.py[o + k] - g.py[o + k - 1]) * t;
      const w = barb ? barbWidth(wb, lam, len, collar) : gen === G_DOWN ? downW : hair;
      out.pt(x - ox, y - oy, w > hair ? w : hair, ang);
    }
    pts += out.end();
  }
  return pts;
}

/** Full barb length (sp) before the per-side factors. */
const barbLen = (S: number, p: number, c: number): number => (8 + 1.6 * S) * (0.45 + 1.1 * p) * (1 - 0.5 * clamp(c, 0, 1));

const chain: ChainOperator = {
  halfWin: HALF_WIN,
  dMax: DMAX,
  unitBudget: UNIT_BUDGET,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 : cur.s) + HALF_WIN;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    const S = cx.r.stroke.size;
    if (cur.phase === 0) {
      cur.s = cx.s0 + 0.5 * pitch(S, cx.at.at(cx.sp.c, cx.s0));
      cur.phase = 1;
      return false;
    }
    const s = cur.s;
    rec.s = s; rec.j = cur.j; rec.side = 0; rec.tmpl = 0;
    cur.j++;
    cur.s = s + pitch(S, cx.at.at(cx.sp.c, s));
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s <= cx.L - 5; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
    g.reset();
    const sp = cx.sp, at = cx.at, r = cx.r, z = cx.z, j = rec.j, seed = r.seed, S = r.stroke.size;
    const delta = pitch(S, at.at(sp.c, rec.s));
    // moiré guard: barbules fade out as the pitch drops below 1.5 doc px
    g.k = clamp((delta / z - 0.75) / 0.75, 0, 1);
    const bl0 = BARBULE_F * delta;
    for (let q = 0; q < PAIRS; q++) {
      const s = rec.s + (q * delta) / PAIRS;
      at.pos(s, v2); at.normal(s, n2); at.tangent(s, t2);
      const p = at.at(sp.p, s), c = at.at(sp.c, s), cs = at.at(sp.cs, s);
      const vn = at.at(sp.vn, s), vbar = at.mean(sp.vn, s, WIN), kbar = at.mean(sp.k, s, WIN);
      const w = at.at(sp.w, s);
      if (q === 0) { g.w = w; g.p = p; g.c = c; }
      const rho = smoothstep(1.0, 2.4, vn);
      // angle from the shaft: pristine ≈ 62°, laid back toward the tip when fast
      let th0 = (90 - 28 - 30 * smoothstep(0.3, 2, vbar)) * DEG;
      // ruffle: groups of 8 sp sway together (angle and length), each barb a little on its own
      const rg = 2 * rnd(seed, Ch.Misc, Math.floor(s / RUFFLE_CELL)) - 1;
      th0 += 18 * DEG * rho * rg;
      const curve = 16 * DEG * (1 + 0.5 * rho);
      // asymmetry: pen tilt across the stroke, else the outside of curves is longer
      let asym = -0.25 * clamp(kbar / 0.01, -1, 1);
      if (r.device === 'pen') {
        const alt = at.at(sp.alt, s), ca = dcos(alt);
        if (ca > 0.3) {
          const az = at.angle(sp.az, s);
          asym = clamp(0.6 * (dcos(az) * n2[0] + dsin(az) * n2[1]), -0.5, 0.5);
        }
      }
      const l0 = Math.min(MAX_LEN, barbLen(S, p, c)) * vaneAt(seed, s) * (1 + 0.3 * rho * rg);
      const half = 0.45 * w;
      for (let si = 0; si < 2; si++) {
        const sigma = si === 0 ? 1 : -1;
        const addr = (j * PAIRS + q) * 4 + si * 2;
        const ax = sigma * n2[0], ay = sigma * n2[1];
        let len = l0 * (1 + sigma * asym) * (1 - 0.5 * Math.max(0, sigma * cs));
        if (sigma * kbar > 0) { const cap = CAP * dsin(th0) / Math.abs(kbar); if (len > cap) len = cap; }
        const rl = rnd(seed, Ch.Length, addr, 0), ra = rnd(seed, Ch.Angle, addr, 0);
        len *= 1 + 0.3 * rho * (2 * rl - 1);
        const th = th0 + 8 * DEG * rho * (2 * ra - 1);
        if (!(len >= MIN_LEN)) continue;
        const x0 = v2[0] + ax * half, y0 = v2[1] + ay * half;
        const rb = g.beginBranch(G_ROOT, 0); g.addPt(ax * half, ay * half, 0); g.endBranch(rb);
        const b = hair(g, G_BARB, len, x0, y0, ax, ay, t2[0], t2[1], th, curve, 0, seed, addr, NSUB, SUB, z);
        // barbules on the first pair only: a barbule zigzag every Δ per side (the pair between
        // reads through them; halving them halves the dominant point cost)
        if (q === 0) barbules(g, b, len, bl0 * (0.8 + 0.4 * rnd(seed, Ch.Length, addr, 1)), ax, ay, t2[0], t2[1], z);
        // down on the first pair of each unit: every second barb pair
        if (q === 0) hair(g, G_DOWN, DOWN_F * len, x0, y0, ax, ay, t2[0], t2[1], th, curve, WANDER, seed, addr + 1, NDOWN, SUB, z);
      }
    }
    g.ceil = unitCeiling(g, DMAX, UNIT_BUDGET);
  },

  count(g: UnitGeom, D: number): number { return unitCount(g, D, 1); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    const r = cx.r;
    let kind = PolyKind.Ribbon, ang = 0;
    if (r.stroke.nib === 'chisel') {
      kind = PolyKind.Chisel;
      ang = chiselAngle(cx.at.at(cx.sp.alt, rec.s), cx.at.angle(cx.sp.az, rec.s)) - r.rot;
    }
    return unitEmit(g, D, eIn, cx.z, rec.s, rec.j, kind, ang, false, out);
  },
};

const tuft = new UnitGeom();
/** Angular step of the tuft's hairs. */
const STEP_A = 2 * PI / TUFT;

/**
 * Radial seed: a tuft of 12 down barbs at 30°·i + jitter (depth 0–1), fringed with barbules
 * (1–2), then 12 more between them (2–3): a powder-down rosette.
 */
function plumeRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z, S = r.stroke.size;
  tuft.reset();
  tuft.w = seed.w; tuft.p = seed.p; tuft.c = seed.c; tuft.k = 1;
  const len = TUFT_F * DOWN_F * Math.min(MAX_LEN, barbLen(S, seed.p, seed.c));
  const bl = TUFT_BARBULE * len;
  const half = 0.45 * seed.w;
  const rot0 = STEP_A * rnd(r.seed, Ch.Angle, RADIAL_ID, 1);
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < TUFT; i++) {
      const addr = (RADIAL_ID + 4 * (ring * TUFT + i)) | 0;
      const a = STEP_A * (i + 0.5 * ring) + rot0 + (rnd(r.seed, Ch.Angle, addr) - 0.5) * 2 * TUFT_JIT;
      const ux = dcos(a), uy = dsin(a), px = -uy, py = ux;
      const l = len * (0.8 + 0.4 * rnd(r.seed, Ch.Length, addr));
      // gens: ring 0 down at 1 (grows 0–1), its barbules at 2, ring 1 down at 3
      const b = hair(tuft, ring === 0 ? G_BARB : G_DOWN, l, seed.x + ux * half, seed.y + uy * half, ux, uy, px, py, 90 * DEG, TUFT_CURL, TUFT_WANDER, r.seed, addr, TUFT_NSUB, TUFT_SUB, z);
      if (ring === 0) barbules(tuft, b, l, bl, ux, uy, px, py, z);
    }
  }
  const Dc = Math.min(D, unitCeiling(tuft, DMAX, TUFT_BUDGET));
  unitEmit(tuft, Dc, 1, z, cx.s0, 0, PolyKind.Ribbon, 0, true, out);
  return Dc;
}

export const ops: FormOps = {
  id: 'ripple', v: 102, locality: 'local', reach: 2 * HALF_WIN, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 0.9, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: plumeRadial,
  radialCeiling: DMAX,
};
