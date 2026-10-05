/**
 * Plait (lab, v105): a woven cord along the line (brief: lab/forms/briefs/plait.md).
 *
 * The stroke becomes a cord. As it rises the gen-0 trunk thins to a core strand and strands
 * twine around it in the 120° rhythm of a three-strand plait, passing OVER and UNDER with the
 * carved gaps of a knotwork panel. Strand 0 arrives over d ∈ (0, 1], strand 1 over (1, 2],
 * strand 2 over (2, 3]; at d > 3 every strand carries the carver's groove.
 *
 *   P(s)  = clamp(clamp(6·w_sp + 14, 20, 72)·(1 + 0.6·fast)·(1 + 0.5c), 20, 84)   braid period (sp)
 *   A(s)  = A0·clamp(1 − A0·|κ̄|/0.8, 0.3, 1),  A0 = 0.9·w_sp + 2                   amplitude (sp)
 *   A_±   = A·(1 ∓ 0.4·tilt_n)·(1 − 0.5·max(0, ±cs))                              lean / crowding
 *   o_m   = A_σ·dsin(φ + 2πm/3),  φ = 2π·(s − s_j)/P_j                             strand offset
 *   crossings at φ_k = π/6 + kπ/3 (k = 0..5): strand k mod 3 passes over strand (k+1) mod 3.
 *
 * Operator model: unit j = one braid period starting at s_j (s_0 = s0 + 0.5, s_{j+1} = s_j + P_j).
 * A unit owns the strand PIECES that begin in its period: each strand has two under-crossings
 * per period, and a piece runs from one under gap to the strand's next under gap, which lies
 * in the NEXT period (up to 5P'/12 into it). A fresh unit (the first, or the first after a
 * corner cut) also owns the three initial pieces from its start. A corner station inside a
 * period cuts the cord 2 sp before it (every piece ends there, round caps) and the next unit
 * starts fresh 2 sp after it; the stroke's end cuts the same way. Pieces are therefore never
 * split at period boundaries, so no two polys share an end point and nothing double-adds.
 *
 * Every piece is a pure function of the spine within halfWin = 136 sp of s_j (P ≤ 84, the
 * overhang ≤ 35, the ±12 sp means); the record freezes only s_j, j, the fresh flag and the
 * drawn length. The unit is cooked once at its ceiling; `count` / `emit` draw prefixes:
 * strand m to λ_m = (ext + w_s)·clamp(D − m, 0, 1) of its unit arc, with the growing tip
 * tapering over w_s so arrival never pops, and the groove easing in by width × clamp(D − 3, 0, 1).
 * Widths follow w(s) under the causal entry factor, so pressure fattens the cord locally.
 *
 * Decisions:
 *  - Strand alphas fade 0.88^m instead of the 0.72^(g−1) hierarchy: the strands are peers of
 *    one cord, not generations growing from each other; their tone buckets (m + 1) already
 *    deepen the colour from strand to strand.
 *  - The gap half-width includes the under piece's own round cap (w_s/2) plus the over strand's
 *    projected half-width (strands cross at ≈ 77°) plus a clearance, capped at P/8.
 *  - No rng in the braid at all; the trefoil's rotation is the only random choice.
 *  - A held tap ties a trefoil x = sin t + 2 sin 2t, y = cos t − 2 cos 2t: three crossings at
 *    t = 0.270919 + i·2π/3 (over) and 3.917872 + i·2π/3 (under), found numerically once.
 */
import { PolyKind } from '../../src/core/types';
import type { RecipeCore } from '../../src/core/types';
import { rnd, Ch, dcos, dsin, TAU } from '../../src/core/det';
import { clamp, lerp, smoothstep } from '../../src/core/num';
import { chiselAngle } from '../../src/ink/nibs';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkPts, TrunkStyle } from '../../src/ink/operators/types';
import { UnitGeom, stationTrunk, toneOf, glow } from '../../src/ink/operators/types';
import { RADIAL_ID } from '../../src/ink/operators/line.v1';
import type { LabFormMeta } from './harness';

export const V = 105;
export const meta: LabFormMeta = {
  name: 'Plait — a woven cord along the line',
  v: V,
  ink: 'indigo',
  notes: 'Strands twine around the thinning core in a three-strand plait, over and under with carved gaps: strand 0 by d=1, two by 2, three by 3, the carver\'s groove at 4. Heavy = fat long-period rope, fast = loose braid, tilt lays the cord over, nearby ink flattens the crowded side, corners cut the cord, a held tap ties a trefoil.',
};

/** Averaging half-window (sp) for w̄, v̄n, κ̄. */
const WIN = 12;
/** Period bounds (sp) and the overhang of a piece into the next period (fraction of P'). */
const PMIN = 20, PMAX = 84, OVERHANG = 5 / 12;
/** Spine a unit may read either side of s_j: P + 5P/12 + WIN + slack. */
const HALF_WIN = 136;
/** Shortest unit (sp), the cut distance either side of a corner, the first unit's offset from s0. */
const MIN_UNIT = 6, CORNER_GAP = 2, HEAD = 0.5;
/** Strand passing over / under at crossing k = 0..5 (φ_k = π/6 + kπ/3). */
export const OVER: readonly number[] = [0, 1, 2, 0, 1, 2];
export const UNDER: readonly number[] = [1, 2, 0, 1, 2, 0];
/** Strand width factor, width floor (sp), groove width factor. */
const WS = 0.45, W_MIN = 0.35, GROOVE_W = 0.12;
/** Night alphas: strands (× 0.88^m) and the groove (gen 4). */
const ALPHA = 0.8, FADE = [1, 0.88, 0.7744], GROOVE_A = 0.45;
/** A piece shorter than this (sp) is not drawn. */
const TIP_MIN = 0.25;
const UNIT_BUDGET = 260, STROKE_BUDGET = 20000;
const DMAX = 4;
/** Sample spacing: P/24, within [1, 3.5] sp. */
const STEP_DIV = 24, STEP_MIN = 1, STEP_MAX = 3.5;

const pv = new Float64Array(2), nv = new Float64Array(2);

// ---------------------------------------------------------------------------- pure braid facts

/** Unit arc (sp) of crossing k in a period P. */
export const crossingArc = (P: number, k: number): number => (P * (2 * k + 1)) / 12;
/** Unit-amplitude offset of strand m at phase φ. */
export const strandSine = (m: number, phi: number): number => dsin(phi + (m * TAU) / 3);
/** Strand m's two under-crossings per period: k_a = (m + 2) mod 3 and k_a + 3. */
export const underA = (m: number): number => (m + 2) % 3;

/** Braid period at arc s (sp). */
export function periodOf(cx: FormCx, s: number): number {
  const sp = cx.sp, at = cx.at;
  const wsp = at.mean(sp.w, s, WIN) * cx.z;
  const fast = smoothstep(1, 2.5, at.mean(sp.vn, s, WIN));
  const c = clamp(at.at(sp.c, s), 0, 1);
  return clamp(clamp(6 * wsp + 14, PMIN, 72) * (1 + 0.6 * fast) * (1 + 0.5 * c), PMIN, PMAX);
}

/** Strand width (sp) at arc s. */
const strandW = (cx: FormCx, s: number): number => Math.max(W_MIN, WS * cx.at.at(cx.sp.w, s) * cx.z);

/** Gap half-width (sp) around an under-crossing: the cap, the over strand's projection, a clearance. */
export const gapOf = (ws: number, P: number): number => Math.min(1.05 * ws + clamp(0.35 * ws, 0.8, 3), P / 8);

/** First corner station arc in (s + 2, upTo], or NaN. */
function cornerAfter(cx: FormCx, s: number, upTo: number): number {
  const sp = cx.sp, at = cx.at, S = sp.s, hi = at.hi;
  for (let i = at.locate(s); i <= hi && S[i] <= upTo; i++) if (sp.corner[i] && S[i] > s + CORNER_GAP) return S[i];
  return NaN;
}

/** Offset point of strand m at absolute arc S and braid phase phi into out (doc). */
function strandPoint(cx: FormCx, S: number, phi: number, m: number, out: Float64Array): void {
  const sp = cx.sp, at = cx.at, z = cx.z;
  at.pos(S, pv); at.normal(S, nv);
  const wsp = at.at(sp.w, S) * z;
  const kb = at.mean(sp.k, S, WIN);
  const A0 = 0.9 * wsp + 2;
  const A = A0 * clamp(1 - (A0 * Math.abs(kb)) / 0.8, 0.3, 1);
  let ta = 0;
  if (cx.r.device === 'pen') {
    const wt = smoothstep(0.1, 0.3, dcos(at.at(sp.alt, S)));
    if (wt > 0) {
      const az = at.angle(sp.az, S);
      ta = wt * clamp(dcos(az) * nv[0] + dsin(az) * nv[1], -1, 1);
    }
  }
  const cs = at.at(sp.cs, S);
  const o = strandSine(m, phi);
  const As = o >= 0 ? A * (1 - 0.4 * ta) * (1 - 0.5 * Math.max(0, cs)) : A * (1 + 0.4 * ta) * (1 - 0.5 * Math.max(0, -cs));
  const off = (As * o) / z;
  out[0] = pv[0] + nv[0] * off; out[1] = pv[1] + nv[1] * off;
}

/** Phase of unit arc a: 2πa/P inside the period, continuing at the next period's rate beyond it. */
const phaseOf = (a: number, P: number, P2: number): number => (a <= P ? (TAU * a) / P : TAU + (TAU * (a - P)) / P2);

const xy = new Float64Array(2);

/** One strand piece [a0, a1] (unit arc) sampled every `step` sp into g. */
function piece(cx: FormCx, g: UnitGeom, s: number, m: number, a0: number, a1: number, P: number, P2: number, step: number): void {
  if (!(a1 - a0 >= TIP_MIN)) return;
  const b = g.beginBranch(m + 1, a1 - a0);
  strandPoint(cx, s + a0, phaseOf(a0, P, P2), m, xy); g.addPt(xy[0], xy[1], a0);
  for (let a = step * (Math.floor(a0 / step) + 1); a < a1 - 0.5 * step; a += step) {
    strandPoint(cx, s + a, phaseOf(a, P, P2), m, xy); g.addPt(xy[0], xy[1], a);
  }
  strandPoint(cx, s + a1, phaseOf(a1, P, P2), m, xy); g.addPt(xy[0], xy[1], a1);
  g.endBranch(b);
}

/** Points of branch b drawn to unit arc lam: none, all, or a prefix plus an interpolated tip. */
function branchPrefix(g: UnitGeom, b: number, lam: number): number {
  const o = g.bOff[b], n = g.bCnt[b], pa = g.pa;
  if (!(lam - pa[o] >= TIP_MIN)) return 0;
  if (lam >= pa[o + n - 1]) return n;
  let k = 1;
  while (k < n && pa[o + k] < lam) k++;
  return k + 1;
}

/** Points the unit draws at depth D (strand prefixes, plus the groove above 3). */
function unitCount(g: UnitGeom, D: number): number {
  const groove = D > 3;
  let n = 0;
  for (let b = 0; b < g.nB; b++) {
    const c = branchPrefix(g, b, g.k * clamp(D - (g.bGen[b] - 1), 0, 1));
    n += groove ? 2 * c : c;
  }
  return n;
}

/** Largest 1/16 level ≤ DMAX whose point count fits the unit budget. */
function unitCeiling(g: UnitGeom): number {
  if (unitCount(g, DMAX) <= UNIT_BUDGET) return DMAX;
  let lo = 0, hi = DMAX * 16;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (unitCount(g, mid / 16) <= UNIT_BUDGET) lo = mid; else hi = mid; }
  return lo / 16;
}

/** Write one point: width from w(S) × entry factor × tip taper (× groove easing), chisel angle. */
function writePt(cx: FormCx, x: number, y: number, a: number, s: number, lam: number, ws: number, wm: number, chisel: boolean, out: Sink): void {
  const sp = cx.sp, at = cx.at, z = cx.z, S = s + a;
  const wsp = at.at(sp.w, S) * z;
  let w = Math.max(W_MIN, wm * wsp) * cx.inF(S) * clamp((lam - a) / ws, 0, 1);
  if (w < 0.05) w = 0.05;
  if (chisel) out.pt(x, y, w / z, chiselAngle(at.at(sp.alt, S), at.angle(sp.az, S)) - cx.r.rot);
  else out.pt(x, y, w / z);
}

/** Emit the unit's pieces truncated to D: strands (gen m + 1), then their grooves (gen 4). */
function unitEmit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, out: Sink): number {
  const z = cx.z, s = rec.s, chisel = cx.r.stroke.nib === 'chisel';
  const kind = chisel ? PolyKind.Chisel : PolyKind.Ribbon;
  const ws = Math.max(W_MIN, WS * g.w * z), gl = glow(g.c), groove = clamp(D - 3, 0, 1);
  const passes = groove > 0 ? 2 : 1;
  let pts = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (let b = 0; b < g.nB; b++) {
      const m = g.bGen[b] - 1, lam = g.k * clamp(D - m, 0, 1);
      const n = branchPrefix(g, b, lam);
      if (n === 0) continue;
      const o = g.bOff[b], full = lam >= g.pa[o + g.bCnt[b] - 1];
      if (pass === 0) out.begin(kind, m + 1, ALPHA * FADE[m] * gl, toneOf(g.p, m + 1), s, rec.j, 1);
      else out.begin(kind, 4, GROOVE_A * gl, toneOf(g.p, 4), s, rec.j, 1);
      const wm = pass === 0 ? WS : GROOVE_W * groove;
      const real = full ? n : n - 1;
      for (let q = 0; q < real; q++) writePt(cx, g.px[o + q], g.py[o + q], g.pa[o + q], s, lam, ws, wm, chisel, out);
      if (!full) {
        const i = o + real - 1, a0 = g.pa[i], a1 = g.pa[i + 1];
        const t = a1 > a0 ? (lam - a0) / (a1 - a0) : 1;
        writePt(cx, g.px[i] + (g.px[i + 1] - g.px[i]) * t, g.py[i] + (g.py[i + 1] - g.py[i]) * t, lam, s, lam, ws, wm, chisel, out);
      }
      pts += out.end();
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------- chain

const chain: ChainOperator = {
  halfWin: HALF_WIN,
  dMax: DMAX,
  unitBudget: UNIT_BUDGET,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 + HEAD : cur.s) + HALF_WIN;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    if (cur.phase === 0) { cur.s = cx.s0 + HEAD; cur.phase = 1; cur.side = 1; }
    const s = cur.s, P = periodOf(cx, s);
    const sc = cornerAfter(cx, s, s + P + CORNER_GAP);
    const cut = sc === sc;
    let Pe = cut ? Math.min(P, sc - CORNER_GAP - s) : P;
    if (cx.L - s < Pe) Pe = cx.L - s;
    const fresh = cur.side;
    cur.s = cut ? sc + CORNER_GAP : s + P;
    cur.side = cut ? 1 : 0;
    if (!(Pe >= MIN_UNIT)) return false;
    rec.s = s; rec.j = cur.j; rec.side = fresh; rec.tmpl = Pe;
    cur.j++;
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s + MIN_UNIT <= cx.L; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
    g.reset();
    const sp = cx.sp, at = cx.at, z = cx.z, s = rec.s, Pe = rec.tmpl, fresh = rec.side === 1;
    const P = periodOf(cx, s);
    g.w = at.at(sp.w, s); g.p = at.at(sp.p, s); g.c = at.at(sp.c, s);
    const ws = Math.max(W_MIN, WS * g.w * z), gap = gapOf(ws, P);
    const cut = Pe < P;
    // the next period, for the pieces that run on into it
    let P2 = P, g2 = gap, Pe2 = 0;
    if (!cut) {
      const s2 = s + P;
      P2 = periodOf(cx, s2);
      g2 = gapOf(strandW(cx, s2), P2);
      const sc = cornerAfter(cx, s2, s2 + OVERHANG * P2 + CORNER_GAP);
      Pe2 = sc === sc ? Math.min(P2, sc - CORNER_GAP - s2) : P2;
      if (cx.L - s2 < Pe2) Pe2 = cx.L - s2;
    }
    const step = clamp(P / STEP_DIV, STEP_MIN, STEP_MAX);
    let ext = 0;
    for (let m = 0; m < 3; m++) {
      const ka = underA(m), ca = crossingArc(P, ka), cb = crossingArc(P, ka + 3);
      if (fresh) piece(cx, g, s, m, 0, Math.min(ca - gap, Pe), P, P2, step);
      piece(cx, g, s, m, ca + gap, Math.min(cb - gap, Pe), P, P2, step);
      const end = cut ? Pe : P + Math.min(crossingArc(P2, ka) - g2, Pe2);
      piece(cx, g, s, m, cb + gap, end, P, P2, step);
      if (end > ext) ext = end;
    }
    g.k = ext + ws;
    g.ceil = unitCeiling(g);
  },

  count(g: UnitGeom, D: number): number { return unitCount(g, D); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, _eIn: number, out: Sink): number {
    return unitEmit(cx, rec, g, D, out);
  },
};

// ---------------------------------------------------------------------------- trunk

/** The station trunk with the core thinning: × lerp(1, 0.45, d) as strand 0 arrives, × lerp(1, 0.5, d − 2) as strand 2 does. */
function plaitTrunk(cx: FormCx, i0: number, i1: number, T: TrunkPts): void {
  T.reset();
  if (cx.depth.base <= 0 && cx.depth.maxPool() <= 0) { stationTrunk(cx, i0, i1, 1, T); return; }
  const S = cx.sp.s;
  for (let i = i0; i <= i1; i++) {
    const d = clamp(cx.depth.at(S[i]), 0, DMAX);
    const mul = lerp(1, 0.45, clamp(d, 0, 1)) * lerp(1, 0.5, clamp(d - 2, 0, 1));
    stationTrunk(cx, i, i, mul, T);
  }
}

// ---------------------------------------------------------------------------- radial: the trefoil

/** Under passes of x = sin t + 2 sin 2t, y = cos t − 2 cos 2t: t = T_UNDER + i·2π/3 (over passes at T_OVER + i·2π/3). */
export const T_OVER = 0.270919, T_UNDER = 3.917872;
/** |dP/dt| at every crossing (the parametrisation is 3-fold symmetric). */
const X_SPEED = 4.7434;
/** Samples per full loop. */
const KNOT_N = 72;

function knotPt(t: number, c: number, sn: number, sc: number, seed: RadialSeed, out: Float64Array): void {
  const x = dsin(t) + 2 * dsin(2 * t), y = dcos(t) - 2 * dcos(2 * t);
  out[0] = seed.x + sc * (x * c - y * sn); out[1] = seed.y + sc * (x * sn + y * c);
}

/**
 * Radial seed: a held tap ties a trefoil of radius (8 + 1.2S)(0.5 + p) sp, drawn as three
 * pieces between its under gaps; the prefix grows over d ∈ [0, 2] with a tapering tip, the
 * groove eases in over [2, 4]. Rotated by 120°·r so taps do not all face one way.
 */
function plaitRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z;
  const sigma = ((8 + 1.2 * r.stroke.size) * (0.5 + seed.p)) / 3; // sp per parametric unit
  const sc = sigma / z;
  const th = (TAU / 3) * rnd(r.seed, Ch.Angle, RADIAL_ID);
  const c = dcos(th), sn = dsin(th);
  const wsp = seed.w * z, ws = Math.max(W_MIN, WS * wsp);
  const gap = Math.min(1.05 * ws + clamp(0.35 * ws, 0.8, 3), 0.3 * sigma) / (sigma * X_SPEED); // in t
  const tStart = T_UNDER + gap, tEnd = T_UNDER + TAU - gap;
  const tDrawn = tStart + (tEnd - tStart) * clamp(D / 2, 0, 1);
  const taper = ws / (sigma * X_SPEED);
  const groove = clamp((D - 2) / 2, 0, 1), gl = glow(seed.c);
  const chisel = r.stroke.nib === 'chisel', kind = chisel ? PolyKind.Chisel : PolyKind.Ribbon;
  const sp = cx.sp, i = sp.n >> 1;
  const ang = chisel ? chiselAngle(sp.alt[i], sp.az[i]) - r.rot : 0;
  const dt = TAU / KNOT_N;
  for (let pass = 0; pass < (groove > 0 ? 2 : 1); pass++) {
    const wm = pass === 0 ? ws : Math.max(W_MIN, GROOVE_W * wsp) * groove;
    for (let q = 0; q < 3; q++) {
      const t0 = T_UNDER + (q * TAU) / 3 + gap, t1 = Math.min(T_UNDER + ((q + 1) * TAU) / 3 - gap, tDrawn);
      if (!(t1 - t0 > 1e-6)) continue;
      if (pass === 0) out.begin(kind, 1, ALPHA * gl, toneOf(seed.p, 1), cx.s0, 0, 1);
      else out.begin(kind, 4, GROOVE_A * gl, toneOf(seed.p, 4), cx.s0, 0, 1);
      for (let t = t0; ; t += dt) {
        const tt = t < t1 ? t : t1;
        knotPt(tt, c, sn, sc, seed, xy);
        let w = wm * clamp((tDrawn - tt) / taper, 0, 1);
        if (w < 0.05) w = 0.05;
        if (chisel) out.pt(xy[0], xy[1], w / z, ang); else out.pt(xy[0], xy[1], w / z);
        if (tt >= t1) break;
      }
      out.end();
    }
  }
  return D;
}

/** Plait v105. */
export const ops: FormOps = {
  id: 'ripple', v: V, locality: 'local', reach: HALF_WIN, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (_r: RecipeCore): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: plaitTrunk,
  trunkReach: 0,
  trunkDepthReach: 0,
  chain,
  radial: plaitRadial,
  radialCeiling: DMAX,
};
