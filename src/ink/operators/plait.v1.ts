/**
 * Plait v1: a woven cord along the line (promoted from the forms lab, v105; brief: lab/forms/briefs/plait.md).
 *
 * The stroke becomes a cord. As it rises the gen-0 trunk thins to a core strand and strands
 * twine around it in the 120° rhythm of a three-strand plait, passing OVER and UNDER with the
 * carved gaps of a knotwork panel. Strand 0 arrives over d ∈ (0, 1], strand 1 over (1, 2],
 * strand 2 over (2, 3]; at d > 3 every strand carries the carver's groove.
 *
 *   P(s)  = clamp(2.5·w_sp + 22, 20, 72)·(1 + 1.4·fast)·(1 + 0.4c) ∈ [20, 96]     braid period (sp)
 *   A(s)  = min(A0·clamp(1 − A0·|κ̄|/0.8, 0.3, 1), 0.5/κ_tent),  A0 = min(0.9·w_sp + 2, 0.13·P)
 *   A_±   = A·(1 ∓ 0.4·tilt_n)·(1 − 0.5·max(0, ±cs))·whip                         lean / crowding
 *   o_m   = A_σ·dsin(φ + 2πm/3)                                                    strand offset
 *   crossings at φ_k = π/6 + kπ/3: OVER[k] passes over UNDER[k] (the rising strand at even k).
 *
 * Operator model: unit j = HALF a braid period, H_j = P_j/2, from s_j (s_0 = s0 + 0.5,
 * s_{j+1} = s_j + H_j). The over/under pattern repeats every three crossings, so an odd unit is
 * the even one mirrored (offsets × −1, phase + π) and every strand has exactly one under-crossing
 * per unit. A unit owns one branch per strand, from that under-crossing to the strand's
 * under-crossing in the next unit (≤ 5P'/12 into it); a fresh unit (stroke start or after a
 * corner) starts its branches at 0 with round caps. Gaps are applied at truncation (`walk`):
 * the under strand is removed for ±g around the crossing and its ends ease from 0 width over
 * 0.5 sp, so a unit's branch end and the next unit's start meet zero-width to zero-width (no
 * caps overlap, nothing double-adds on Night). Strand 0 passes under strand 2, which arrives
 * last: its gaps open only as strand 2's growing tip passes each crossing, so below d = 2 it is
 * one unbroken strand (a two-ply twist), not a chain of fragments.
 *
 * Cuts: a corner station cuts the cord 2 + ≈w/2 sp either side; the stroke end cuts too. Within
 * 12 sp of a cut the amplitude gathers to 0.4 (a whipped cord end), read from the record's
 * cord-segment start (`side`) and the next cut within reach, so neighbouring units agree.
 * `need` asks for the actual P, P' (s + P/2 + 5P'/12 + 20) instead of the worst case, so the
 * braid trails the nib by ~30–40 sp; halfWin = reach = 108 bounds every read.
 *
 * Every point is a pure function of the spine within halfWin of s_j, d(s_j) and the record
 * (s_j, j, segment start, unit length); `count` and `emit` share the walker, which is a pure
 * function of (geometry, D). Strand m is drawn to λ_m = (ext + w_s)·clamp(D − m, 0, 1) of its
 * unit arc with a tip tapering over w_s; the groove eases in by width × clamp(D − 3, 0, 1).
 *
 * Decisions (deviations from the brief noted):
 *  - Units are half periods (brief: one period) to halve the live lag; the braid is identical.
 *  - P's width term is 2.5w + 22 capped at 72 and speed weighs ×2.4 (brief: 6w + 14, ×1.6), so
 *    the speed sheet's fast stroke really is the longer-period braid; A0 is also capped at
 *    0.13P (strands ≤ 35° to the axis) and the strand width at 0.7·A0, so heavy and broad nibs
 *    stay a braid instead of hooks or blobs.
 *  - The core thins to 0.25w (≤ 1.2 + 0.1w sp) by d = 1 and × 0.3 by d = 3 (brief: 0.45, × 0.5):
 *    on Paper the gen-0 core is the darkest ink and otherwise reads as the main line.
 *  - Strand alphas fade 0.88^m instead of the 0.72^(g−1) hierarchy: the strands are peers of
 *    one cord; their tone buckets (m + 1) already deepen the colour from strand to strand.
 *  - No rng in the braid at all; the trefoil's rotation is the only random choice.
 *  - A held tap ties a trefoil x = sin t + 2 sin 2t, y = cos t − 2 cos 2t: three crossings at
 *    t = 0.270919 + i·2π/3 (over) and 3.917872 + i·2π/3 (under), found numerically once.
 *  - Unit budget 220 as briefed (a half-period unit with its groove peaks at ~150 points over
 *    the gallery gestures and zooms 0.4–3); the ceiling drops in 1/16 steps if one ever exceeds it.
 */
import { PolyKind } from '../../core/types';
import type { RecipeCore } from '../../core/types';
import { rnd, Ch, dcos, dsin, PI, TAU } from '../../core/det';
import { clamp, lerp, smoothstep } from '../../core/num';
import { chiselAngle } from '../nibs';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkPts, TrunkStyle } from './types';
import { UnitGeom, stationTrunk, toneOf, glow } from './types';
import { RADIAL_ID } from './line.v1';


/** Averaging half-window (sp) for w̄, v̄n, κ̄. */
const WIN = 12;
/** Period bounds (sp) and the overhang of a piece into the next period (fraction of P'). */
const PMIN = 20, PMAX = 96, OVERHANG = 5 / 12;
/** Spine a unit may read either side of s_j: P/2 + 5P'/12 + WHIP + CG_MAX + slack (need() asks for less: the actual P, P'). */
const HALF_WIN = 108;
/** Amplitude cap as a fraction of the local period: keeps the strands at ≤ 35° to the cord axis. */
const A_OF_P = 0.13;
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
const UNIT_BUDGET = 220, STROKE_BUDGET = 20000;
const DMAX = 4;
/** Sample spacing: P/20, within [1, 3.5] sp. */
const STEP_DIV = 20, STEP_MIN = 1, STEP_MAX = 3.5;

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
  return periodFor(at.mean(sp.w, s, WIN) * cx.z, at.mean(sp.vn, s, WIN), at.at(sp.c, s));
}
/** P(w_sp, v̄n, c) = clamp(2.5w + 22, 20, 72)·(1 + 1.4·fast)·(1 + 0.4c), fast = smoothstep(1, 2.5, v̄n), within [20, 96]. */
export function periodFor(wsp: number, vn: number, c: number): number {
  const fast = smoothstep(1, 2.5, vn);
  return clamp(clamp(2.5 * wsp + 22, PMIN, 72) * (1 + 1.4 * fast) * (1 + 0.4 * clamp(c, 0, 1)), PMIN, PMAX);
}
/** Amplitude (sp) before bends / lean / crowding: A0 = min(0.9·w + 2, 0.13·P). */
export const ampFor = (wsp: number, P: number): number => Math.min(0.9 * wsp + 2, A_OF_P * P);

/** Strands never grow wider than this fraction of the amplitude: a broad brush stays a braid, not a row of blobs. */
const WS_OF_A = 0.7;
/** A unit's strand width (sp) at its arc s with period P: max(W_MIN, 0.45·w), at most 0.7·A0. */
function unitWs(cx: FormCx, s: number, P: number): number {
  const wsp = cx.at.at(cx.sp.w, s) * cx.z;
  return Math.min(Math.max(W_MIN, WS * wsp), Math.max(W_MIN, WS_OF_A * ampFor(wsp, P)));
}

/** Gap half-width (sp) around an under-crossing: the over strand's footprint (it crosses at ≈ 70°, ws/2/sin) plus a clearance; the under ends are 0.5 sp ramps, not caps. */
export const gapOf = (ws: number, P: number): number => Math.min(0.6 * ws + clamp(0.25 * ws, 0.4, 1.2), P / 9);

/**
 * Cut distance (sp) either side of a corner at arc sc: 2 sp plus about half the amplitude, so the
 * two cord ends never tangle in the corner. Reads only the corner station (≤ CG_MAX).
 */
const CG_MAX = 7;
function cornerGap(cx: FormCx, sc: number): number {
  return CORNER_GAP + clamp(0.45 * cx.at.at(cx.sp.w, sc) * cx.z + 1, 0, CG_MAX - CORNER_GAP);
}

/** The next cut after s (unit arc from s): the first corner's cut point, else the stroke end, searched up to upTo. */
function nextCut(cx: FormCx, s: number, upTo: number): number {
  const sc = cornerAfter(cx, s, upTo);
  const c = sc === sc ? sc - cornerGap(cx, sc) : Infinity;
  return (c < cx.L ? c : cx.L) - s;
}

/** First corner station arc in (s + 2, upTo], or NaN. */
function cornerAfter(cx: FormCx, s: number, upTo: number): number {
  const sp = cx.sp, at = cx.at, S = sp.s, hi = at.hi;
  for (let i = at.locate(s); i <= hi && S[i] <= upTo; i++) if (sp.corner[i] && S[i] > s + CORNER_GAP) return S[i];
  return NaN;
}

/** Fold guard: no strand offset beyond K_FOLD / κ, κ the tent-weighted local max of |κ| within K_R sp. */
const K_FOLD = 0.5, K_R = 10;
/** max_i |κ_i|·(1 − |s_i − S|/K_R) over stations within K_R of S: continuous in S, sees a sharp bend before it arrives. */
function kTent(cx: FormCx, S: number): number {
  const sp = cx.sp, at = cx.at, SS = sp.s, K = sp.k, hi = at.hi;
  let i = at.locate(S - K_R), m = 0;
  for (; i <= hi && SS[i] <= S + K_R; i++) {
    const t = 1 - Math.abs(SS[i] - S) / K_R;
    if (t > 0) { const v = Math.abs(K[i]) * t; if (v > m) m = v; }
  }
  return m;
}

/** Offset point of strand m at absolute arc S and braid phase phi into out (doc). */
function strandPoint(cx: FormCx, S: number, phi: number, m: number, sign: number, amul: number, out: Float64Array): void {
  const sp = cx.sp, at = cx.at, z = cx.z;
  at.pos(S, pv); at.normal(S, nv);
  const wsp = at.at(sp.w, S) * z;
  const kb = at.mean(sp.k, S, WIN);
  const A0 = ampFor(wsp, periodOf(cx, S));
  const kt = kTent(cx, S);
  const A = amul * Math.min(A0 * clamp(1 - (A0 * Math.abs(kb)) / 0.8, 0.3, 1), K_FOLD / (kt > 1e-6 ? kt : 1e-6));
  let ta = 0;
  if (cx.r.device === 'pen') {
    const wt = smoothstep(0.1, 0.3, dcos(at.at(sp.alt, S)));
    if (wt > 0) {
      const az = at.angle(sp.az, S);
      ta = wt * clamp(dcos(az) * nv[0] + dsin(az) * nv[1], -1, 1);
    }
  }
  const cs = at.at(sp.cs, S);
  const o = sign * strandSine(m, phi);
  const As = o >= 0 ? A * (1 - 0.4 * ta) * (1 - 0.5 * Math.max(0, cs)) : A * (1 + 0.4 * ta) * (1 - 0.5 * Math.max(0, -cs));
  const off = (As * o) / z;
  out[0] = pv[0] + nv[0] * off; out[1] = pv[1] + nv[1] * off;
}

const xy = new Float64Array(2);

/**
 * Per-branch gap data, stored beside the UnitGeom (GX slots per branch):
 *  0 hs  start gap half-width (0: the branch starts with a round cap: a fresh cord start)
 *  1 cs  start crossing (unit arc)
 *  2 he  end gap half-width (0: round cap: a cut or the stroke end)
 *  3 ceN end crossing in the NEXT unit's arc (strand 2 there belongs to the next unit)
 *  4 nI  interior gaps (0..2), then (c, h) pairs at 5..8
 */
const GX = 9;
type PGeom = UnitGeom & { gx?: Float64Array; wcap?: number };
function gxOf(g: PGeom, nB: number): Float64Array {
  if (!g.gx || g.gx.length < nB * GX) g.gx = new Float64Array(Math.max(nB, 4) * GX);
  return g.gx;
}

/** The cord gathers toward a cut (stroke ends, corners): amplitude × lerp(WHIP_A, 1, smoothstep(0, WHIP, distance)). */
const WHIP = 12, WHIP_A = 0.4;

/** Sample strand m from unit arc a0 to a1 every `step` sp into branch b (S = s + a inside the period, s2 + (a − P) beyond). */
function sampleStrand(cx: FormCx, g: UnitGeom, s: number, m: number, sign: number, a0: number, a1: number, P: number, s2: number, P2: number, step: number, cutLo: number, cutHi: number): void {
  const H = 0.5 * P;
  const b = g.beginBranch(m + 1, a1 - a0);
  const put = (a: number): void => {
    const amul = lerp(WHIP_A, 1, smoothstep(0, WHIP, Math.min(a - cutLo, cutHi - a)));
    if (a <= H) strandPoint(cx, s + a, (TAU * a) / P, m, sign, amul, xy);
    else strandPoint(cx, s2 + (a - H), PI + (TAU * (a - H)) / P2, m, sign, amul, xy);
    g.addPt(xy[0], xy[1], a);
  };
  put(a0);
  for (let a = step * (Math.floor(a0 / step) + 1); a < a1 - 0.5 * step; a += step) put(a);
  put(a1);
  g.endBranch(b);
}

// ---------------------------------------------------------------------------- truncation walker

/** Width ramp (sp) at a gap edge: the under strand's end eases from 0 to full over this. */
const E_RAMP = 0.5;
/** A dynamic gap (strand 0 under strand 2) splits its strand once it is this far open; below it the strand only dips. */
const OPEN_SPLIT = 0.25;
/** Inserted arcs closer than this (sp) to a cooked sample replace it. */
const DEDUPE = 0.05;

/** Walker output (scratch): arcs and envelopes of every run of one branch, runs delimited by rOff. */
let wA = new Float64Array(512), wE = new Float64Array(512);
const rOff = new Int32Array(8);
let nRuns = 0;
const ins = new Float64Array(64);
/** Active interior gaps of the branch being walked: centre, half-width, dip depth (1 = full gap), split. */
const gC = new Float64Array(2), gH = new Float64Array(2), gD = new Float64Array(2), gS = new Uint8Array(2);

function pushW(n: number, a: number, e: number): void {
  if (n >= wA.length) { const A = new Float64Array(wA.length * 2); A.set(wA); wA = A; const B = new Float64Array(wE.length * 2); B.set(wE); wE = B; }
  wA[n] = a; wE[n] = e;
}

/**
 * Runs of branch b drawn at depth D: the strand from its start gap to its end gap, prefix-truncated
 * at λ_m = k·clamp(D − m, 0, 1), split at its open under-gaps. Strand 0 passes under strand 2, so its
 * gaps open only as strand 2's growing tip λ_2 passes each crossing (open = (λ_2 − c + h)/2h); the
 * other strands' over strands are always complete when they are drawn, so their gaps are static.
 * Every gap edge eases the width from 0 over E_RAMP, so a unit's branch end and its neighbour's
 * start meet zero-width to zero-width: no round caps overlap, nothing double-adds under 'lighter'.
 * Fills wA / wE / rOff / nRuns; returns the point count. A pure function of (g, b, D).
 */
function walk(g: PGeom, b: number, D: number): number {
  nRuns = 0;
  const gx = g.gx!, q = b * GX, o = g.bOff[b], n = g.bCnt[b], pa = g.pa;
  const m = g.bGen[b] - 1;
  const lam = g.k * clamp(D - m, 0, 1), lam2 = g.k * clamp(D - 2, 0, 1);
  const a0 = pa[o], a1 = pa[o + n - 1];
  if (!(lam - a0 >= TIP_MIN)) return 0;
  const open = (c: number, h: number): number => (m === 0 ? clamp((lam2 - c + h) / (2 * h), 0, 1) : 1);
  const hs = gx[q], he = gx[q + 2];
  const vs = hs > 0 ? a0 + hs * open(gx[q + 1], hs) : a0;
  const ve = he > 0 ? a1 - he * open(gx[q + 3], he) : a1;
  const tip = lam < ve ? lam : ve;
  if (!(tip - vs >= TIP_MIN)) return 0;
  let nG = 0;
  const nI = gx[q + 4];
  for (let i = 0; i < nI; i++) {
    const c = gx[q + 5 + 2 * i], h0 = gx[q + 6 + 2 * i], op = open(c, h0);
    if (!(op > 0)) continue;
    gC[nG] = c; gH[nG] = h0 * op; gS[nG] = op >= OPEN_SPLIT ? 1 : 0; gD[nG] = op >= OPEN_SPLIT ? 1 : op / OPEN_SPLIT; nG++;
  }
  const env = (a: number): number => {
    let e = 1;
    if (hs > 0) e *= clamp((a - vs) / E_RAMP, 0, 1);
    if (he > 0) e *= clamp((ve - a) / E_RAMP, 0, 1);
    for (let i = 0; i < nG; i++) e *= 1 - gD[i] * (1 - clamp((Math.abs(a - gC[i]) - gH[i]) / E_RAMP, 0, 1));
    return e;
  };
  let total = 0, r0 = vs, gi = 0, k = o;
  for (;;) {
    while (gi < nG && !gS[gi]) gi++;
    let r1 = gi < nG ? gC[gi] - gH[gi] : tip;
    if (r1 > tip) r1 = tip;
    if (r1 - r0 >= TIP_MIN) {
      // inserted arcs: run ends, their ramps, and the dip edges of partly open gaps inside the run
      let ni = 0;
      ins[ni++] = r0;
      if (r0 + E_RAMP < r1) ins[ni++] = r0 + E_RAMP;
      for (let i = 0; i < nG; i++) {
        if (gS[i]) continue;
        const c = gC[i], h = gH[i];
        const e4 = [c - h - E_RAMP, c - h, c + h, c + h + E_RAMP];
        for (let t = 0; t < 4; t++) if (e4[t] > r0 && e4[t] < r1) ins[ni++] = e4[t];
      }
      if (r1 - E_RAMP > r0 && r1 < tip) ins[ni++] = r1 - E_RAMP;
      else if (r1 === tip && he > 0 && tip === ve && r1 - E_RAMP > r0) ins[ni++] = r1 - E_RAMP;
      ins[ni++] = r1;
      // sort the few inserted arcs, drop near-duplicates
      for (let i = 1; i < ni; i++) { const v = ins[i]; let j = i - 1; while (j >= 0 && ins[j] > v) { ins[j + 1] = ins[j]; j--; } ins[j + 1] = v; }
      let nu = 1;
      for (let i = 1; i < ni; i++) if (ins[i] - ins[nu - 1] > DEDUPE) ins[nu++] = ins[i]; else if (i === ni - 1) ins[nu - 1] = ins[i];
      // merge with the cooked samples strictly inside the run
      if (nRuns + 1 >= rOff.length) break;
      rOff[nRuns] = total;
      while (k < o + n && pa[k] <= r0 + DEDUPE) k++;
      let ii = 0;
      for (;;) {
        const ai = ii < nu ? ins[ii] : Infinity;
        const ak = k < o + n && pa[k] < r1 - DEDUPE ? pa[k] : Infinity;
        if (ai === Infinity && ak === Infinity) break;
        if (ai <= ak) {
          pushW(total++, ai, env(ai)); ii++;
          if (ak - ai <= DEDUPE) k++;
        } else {
          let near = false;
          if (ii < nu && ins[ii] - ak <= DEDUPE) near = true;
          if (!near) pushW(total++, ak, env(ak));
          k++;
        }
      }
      nRuns++;
    }
    if (gi >= nG || r1 >= tip) break;
    r0 = gC[gi] + gH[gi];
    gi++;
    if (r0 >= tip) break;
  }
  rOff[nRuns] = total;
  return total;
}

/** Points the unit draws at depth D (strand runs, plus the groove above 3). */
function unitCount(g: UnitGeom, D: number): number {
  let n = 0;
  for (let b = 0; b < g.nB; b++) n += walk(g, b, D);
  return D > 3 ? 2 * n : n;
}

/** Largest 1/16 level ≤ DMAX such that it and every level below it fit the unit budget. */
function unitCeiling(g: UnitGeom): number {
  // fast path: even every sample plus every inserted arc, twice (groove), fits
  if (2 * (g.nPts + 14 * g.nB) <= UNIT_BUDGET) return DMAX;
  let best = 0;
  for (let l = 1; l <= DMAX * 16; l++) {
    if (unitCount(g, l / 16) > UNIT_BUDGET) break;
    best = l;
  }
  return best / 16;
}

/** Position on branch b's cooked polyline at unit arc a (linear between samples) into xy; i = search hint. */
function posAt(g: UnitGeom, b: number, a: number, hint: number): number {
  const o = g.bOff[b], n = g.bCnt[b], pa = g.pa;
  let i = hint < o ? o : hint;
  while (i < o + n - 2 && pa[i + 1] < a) i++;
  const t = pa[i + 1] > pa[i] ? clamp((a - pa[i]) / (pa[i + 1] - pa[i]), 0, 1) : 0;
  xy[0] = g.px[i] + (g.px[i + 1] - g.px[i]) * t; xy[1] = g.py[i] + (g.py[i + 1] - g.py[i]) * t;
  return i;
}

/** Emit the unit truncated to D: every strand's runs (gen m + 1), then their grooves (gen 4). */
function unitEmit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, out: Sink): number {
  const sp = cx.sp, at = cx.at, z = cx.z, s = rec.s, chisel = cx.r.stroke.nib === 'chisel';
  const kind = chisel ? PolyKind.Chisel : PolyKind.Ribbon;
  const wcap = (g as PGeom).wcap ?? Infinity, ws = Math.min(Math.max(W_MIN, WS * g.w * z), wcap), gl = glow(g.c), groove = clamp(D - 3, 0, 1);
  const passes = groove > 0 ? 2 : 1;
  let pts = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (let b = 0; b < g.nB; b++) {
      if (walk(g, b, D) === 0) continue;
      const m = g.bGen[b] - 1, lam = g.k * clamp(D - m, 0, 1);
      const wm = pass === 0 ? 1 : (GROOVE_W / WS) * groove;
      let hint = 0;
      for (let r = 0; r < nRuns; r++) {
        if (pass === 0) out.begin(kind, m + 1, ALPHA * FADE[m] * gl, toneOf(g.p, m + 1), s, rec.j, 1);
        else out.begin(kind, 4, GROOVE_A * gl, toneOf(g.p, 4), s, rec.j, 1);
        for (let i = rOff[r]; i < rOff[r + 1]; i++) {
          const a = wA[i], e = wE[i];
          hint = posAt(g, b, a, hint);
          const S = s + a;
          const wsp = at.at(sp.w, S) * z;
          let w = Math.max(W_MIN, wm * Math.min(WS * wsp, wcap)) * cx.inF(S) * clamp((lam - a) / ws, 0, 1) * e;
          if (e <= 0) w = 0; else if (w < 0.05) w = 0.05;
          if (chisel) out.pt(xy[0], xy[1], w / z, chiselAngle(at.at(sp.alt, S), at.angle(sp.az, S)) - cx.r.rot);
          else out.pt(xy[0], xy[1], w / z);
        }
        pts += out.end();
      }
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
    // Readable arc a unit at s needs: its period (P from the spine within s ± WIN), the next
    // unit's start (P' within s + P/2 ± WIN) and the overhang 5P'/12, plus WIN for the means.
    // Each stage only reads arcs that the previous stage proved readable, so the answer is
    // the same whatever the watermark when it is asked.
    const s = cur.phase === 0 ? cx.s0 + HEAD : cur.s;
    if (!(cx.L >= s + WIN)) return s + WIN;
    const P = periodOf(cx, s);
    const H = 0.5 * P;
    if (!(cx.L >= s + H + WIN)) return s + H + WIN;
    // WHIP + CG_MAX past the overhang: every corner whose cut can gather this unit's strands (the
    // whip) is readable, and a stroke end that close never is, so a unit stepped live is
    // bit-identical to its final cook.
    return s + H + OVERHANG * periodOf(cx, s + H) + WHIP + CG_MAX + 1;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    // cur.side = arc where the current cord segment starts (the stroke start or a corner's cut)
    if (cur.phase === 0) { cur.s = cx.s0 + HEAD; cur.phase = 1; cur.side = cur.s; }
    const s = cur.s, H = 0.5 * periodOf(cx, s);
    const sc = cornerAfter(cx, s, s + H + CORNER_GAP);
    const cut = sc === sc;
    let Pe = cut ? Math.min(H, sc - cornerGap(cx, sc) - s) : H;
    if (cx.L - s < Pe) Pe = cx.L - s;
    const seg = cur.side;
    cur.s = cut ? sc + cornerGap(cx, sc) : s + H;
    if (cut) cur.side = cur.s;
    if (!(Pe >= MIN_UNIT)) return false;
    rec.s = s; rec.j = cur.j; rec.side = seg; rec.tmpl = Pe;
    cur.j++;
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s + MIN_UNIT <= cx.L; },

  /**
   * A unit is half a braid period H = P/2 (the over/under pattern repeats every three crossings,
   * so an odd unit is the even one mirrored: sign = −1, phase + π). One branch per strand: from
   * its under-crossing c_a in this half (or from 0 on a fresh cord, through c_a as an interior
   * gap) to its under-crossing in the next half (or the cut). Gaps are applied at truncation.
   */
  cook(cx: FormCx, rec: ChainRecord, g: PGeom): void {
    g.reset();
    const sp = cx.sp, at = cx.at, z = cx.z, s = rec.s, Pe = rec.tmpl, fresh = rec.side === s;
    const P = periodOf(cx, s);
    g.w = at.at(sp.w, s); g.p = at.at(sp.p, s); g.c = at.at(sp.c, s);
    const ws = unitWs(cx, s, P), gap = gapOf(ws, P);
    g.wcap = Math.max(W_MIN, WS_OF_A * ampFor(g.w * z, P));
    const H = 0.5 * P, cut = Pe < H, sign = rec.j % 2 === 0 ? 1 : -1;
    // the next unit, which every branch runs on into up to its under-crossing there
    const s2 = s + H;
    let P2 = P, g2 = gap, Pe2 = 0;
    if (!cut) {
      P2 = periodOf(cx, s2);
      g2 = gapOf(unitWs(cx, s2, P2), P2);
      const sc = cornerAfter(cx, s2, s2 + OVERHANG * P2 + CORNER_GAP);
      Pe2 = sc === sc ? Math.min(0.5 * P2, sc - cornerGap(cx, sc) - s2) : 0.5 * P2;
      if (cx.L - s2 < Pe2) Pe2 = cx.L - s2;
    }
    const step = clamp(P / STEP_DIV, STEP_MIN, STEP_MAX);
    // the whip reads the next cut within reach of the furthest sample (corners up to WHIP + CG_MAX beyond it)
    const cutHi = cut ? Pe : nextCut(cx, s, s2 + OVERHANG * P2 + WHIP + CG_MAX);
    const gx = gxOf(g, 3);
    let ext = 0, nb = 0;
    for (let m = 0; m < 3; m++) {
      const ka = underA(m), ca = crossingArc(P, ka);
      const a0 = fresh ? 0 : ca;
      let a1: number, he = 0, ceN = 0;
      if (cut) a1 = Pe;
      else {
        const cn = crossingArc(P2, ka);
        if (cn - g2 <= Pe2) { a1 = H + cn; he = g2; ceN = cn; } else a1 = H + Pe2;
      }
      if (!(a1 - a0 >= TIP_MIN)) continue;
      const q = nb * GX;
      gx[q] = fresh ? 0 : gap; gx[q + 1] = ca; gx[q + 2] = he; gx[q + 3] = ceN;
      let nI = 0;
      if (fresh && ca < a1) { gx[q + 5 + 2 * nI] = ca; gx[q + 6 + 2 * nI] = gap; nI++; }
      gx[q + 4] = nI;
      sampleStrand(cx, g, s, m, sign, a0, a1, P, s2, P2, step, rec.side - s, cutHi);
      nb++;
      if (a1 > ext) ext = a1;
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

/** Core width factors: as strand 0 arrives (d 0 → 1) and as strand 2 does (d 2 → 3): ≈ 0.08·w at d ≥ 3. */
const CORE1 = 0.25, CORE3 = 0.3;

/** The station trunk with the core thinning: × lerp(1, CORE1, d) as strand 0 arrives, × lerp(1, CORE3, d − 2) as strand 2 does. */
function plaitTrunk(cx: FormCx, i0: number, i1: number, T: TrunkPts): void {
  T.reset();
  if (cx.depth.base <= 0 && cx.depth.maxPool() <= 0) { stationTrunk(cx, i0, i1, 1, T); return; }
  const S = cx.sp.s;
  for (let i = i0; i <= i1; i++) {
    const d = clamp(cx.depth.at(S[i]), 0, DMAX);
    // a broad nib's core is held to ≈ 1.2 + 0.1·w sp so it never outshines the strands
    const wsp = cx.sp.w[i] * cx.z, c1 = Math.min(CORE1, (1.2 + 0.1 * wsp) / (wsp > 1e-6 ? wsp : 1e-6));
    const mul = lerp(1, c1, clamp(d, 0, 1)) * lerp(1, CORE3, clamp(d - 2, 0, 1));
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

/** Plait v1. */
export const plait: FormOps = {
  id: 'plait', v: 1, locality: 'local', reach: HALF_WIN, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (_r: RecipeCore): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: plaitTrunk,
  trunkReach: 0,
  trunkDepthReach: 0,
  chain,
  radial: plaitRadial,
  radialCeiling: DMAX,
};
