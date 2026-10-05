/**
 * Craze — the stroke as a drying film (lab prototype, brief: lab/forms/briefs/craze.md).
 *
 * A band about twice the nib wide dries into a cellular crack NETWORK. The chain walks
 * the arc in plates: unit j is the transverse crack at s_j (gen 1) plus the plate behind it,
 * [s_{j−1}, s_j]: the film of that plate (a gen-0 ribbon, welded to its neighbours at the
 * cracks), its lengthwise split at T-junctions (gen 2), one or two tertiary cracks across each
 * sub-cell (gen 3) and a longitudinal in each tertiary cell (gen 4) while the oldest seams
 * widen. The last kept unit also lays the uncracked film of the partial plate after it, up to
 * the stroke end (only ever at finish: NEED ≥ LAM_MAX + TAIL). Every crack is a straight
 * segment in band coordinates (s, ν) plus a low bow and a hat wobble, both vanishing at its
 * ends; the points map through the spine, P(s, ν) = pos(s) + ν·n(s). A child's end is the
 * parent's DRAWN polyline interpolated at the junction (doc-space chord), so the network welds
 * exactly and nothing dangles except at the band edge.
 *
 * Gesture grammar: pressure = film thickness (band h and plate length Λ grow with p, seam
 * width 0.26·w); speed = thin film (Λ ×(1 − 0.4·fast), wobble ×(1 + fast)); lean along the
 * stroke shears the transverse cracks up to 35°, lean across spreads the band downhill;
 * curvature narrows plates and caps the concave side at 0.8/|κ̄|; a corner within ±6 sp
 * halves Λ and narrows the band (corners shatter); nearby ink narrows the band ×(1 − 0.35c)
 * toward the free side; a hold deepens d(s) locally so gens 2–4 unfold under the nib; a tap
 * is a dried drop (a film disc, radial cracks, a ring crack at 0.55R, short radials ring→rim,
 * widening).
 *
 * Determinism: every unit is a pure function of the spine on [s_j − 60, s_j + 50] (reads are
 * clamped to that window), d(s_j), the entry factor and rng addresses (j, k) (plus L for the
 * tail film, which can only fire once the stroke end is inside that window, i.e. at finish). Crack j−1 is
 * recomputed inside unit j from the same functions, so the T-junctions on it and the shared
 * film edge at s_{j−1} are bit-identical to what unit j−1 drew. rec.tmpl stores the previous
 * crack's arc (the stroke head for j = 0, whose plate has no crack behind it).
 */
import { PolyKind } from '../../src/core/types';
import { rnd, Ch, dcos, dsin, PI, TAU } from '../../src/core/det';
import { clamp, smoothstep } from '../../src/core/num';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from '../../src/ink/operators/types';
import { UnitGeom, toneOf, glow, hierarchy } from '../../src/ink/operators/types';
import { RADIAL_ID } from '../../src/ink/operators/line.v1';
import type { LabFormMeta } from './harness';

export const meta: LabFormMeta = {
  name: 'Craze — the stroke as a drying film',
  v: 101,
  ink: 'oxide',
  notes: 'A film that dries as it rises: transverse cracks, then lengthwise splits at T-junctions, then sub-plates, then the old seams widen. Pressure = plate size, speed = fine crazing, lean shears, corners shatter, holds craze finely, taps are dried drops with a ring crack.',
};

const DEG = PI / 180;
/** Arc that must be settled past a unit before it cooks, and the read window either side. */
const NEED = 50, READ_LO = 60, READ_HI = 50;
/** Tail margin: keep(s) = s ≤ L − TAIL. NEED ≥ LAM_MAX + TAIL, so a unit that can see the stroke end is cooked at finish only. */
const TAIL = 6;
/** Averaging half-window (sp). */
const WIN = 12;
/** Band half-width bounds (sp) and plate length bounds (sp). */
const H_MIN = 3.5, H_MAX = 38, LAM_MIN = 6, LAM_MAX = 44;
/** Point spacing along a crack and along the film (sp), wobble ease at crack ends (sp), child width collar (sp). */
const STEP = 2.5, FILM_STEP = 3, EASE_END = 3, COLLAR = 1.5;
/** Bow of a crack as a fraction of its length (sign and size per crack). */
const BOW = 0.12;
/** Seam alpha (Night) before hierarchy and glow; film alpha; width floor (sp). */
const ALPHA = 0.55, FILM_ALPHA = 0.14, W_FLOOR = 0.3;
/** Seam width: 0.22·w_sp clamped to [0.5, 2.0] sp; per-generation factor 0.78^(g−1), indexed by gen. */
const SEAM_K = 0.26, SEAM_MIN = 0.8, SEAM_MAX = 2.4;
const GW = [1, 1, 0.9, 0.85, 0.8];
const DMAX = 4, UNIT_BUDGET = 160, STROKE_BUDGET = 10000;
/** Minimum cell width / crack length (sp) for a crack to form. */
const MIN_CELL = 2.5, MIN_LEN = 4;
/** Generation tag of the film branch inside a UnitGeom (emitted as a gen-0 poly, never truncated). */
const FILM = 0;

// ---------------------------------------------------------------- band facts

/** Facts about the film at one arc: the crack there and the band around it. */
class Facts {
  s = 0; p = 0; c = 0; cs = 0; vn = 0; kb = 0; fast = 0; wsp = 0;
  h = 0; hp = 0; hm = 0; psi = 0; tanPsi = 0; tAlong = 0; tAcross = 0; corner = false;
}
const FJ = new Facts(), FP = new Facts(), FT = new Facts();
const v2 = new Float64Array(2), n2 = new Float64Array(2), t2 = new Float64Array(2), bp = new Float64Array(2), sn = new Float64Array(2), dp = new Float64Array(2);

/** Whether a corner station lies within ±half sp of s (readable stations only). */
function cornerNear(cx: FormCx, s: number, half: number): boolean {
  const S = cx.sp.s, C = cx.sp.corner, hi = cx.at.hi;
  let i = cx.at.locate(s - half);
  for (; i <= hi && S[i] <= s + half; i++) if (S[i] >= s - half && C[i]) return true;
  return false;
}

/** Film facts at arc s for the crack indexed j (ψ uses j's rng address). */
function facts(cx: FormCx, s: number, j: number, f: Facts): void {
  const sp = cx.sp, at = cx.at, r = cx.r, S = r.stroke.size;
  f.s = s;
  f.p = at.mean(sp.p, s, WIN); f.c = at.mean(sp.c, s, WIN); f.vn = at.mean(sp.vn, s, WIN); f.kb = at.mean(sp.k, s, WIN);
  f.cs = at.at(sp.cs, s);
  f.wsp = at.at(sp.w, s) * cx.z;
  f.fast = smoothstep(1.0, 2.4, f.vn);
  f.corner = cornerNear(cx, s, 6);
  // pen lean along the stroke (shears cracks) and across it (spreads the band downhill)
  f.tAlong = 0; f.tAcross = 0;
  if (r.device === 'pen') {
    const alt = at.at(sp.alt, s), az = at.angle(sp.az, s), ca = dcos(alt);
    if (ca > 0.02) {
      at.tangent(s, t2); at.normal(s, n2);
      const tx = ca * dcos(az), ty = ca * dsin(az);
      f.tAlong = tx * t2[0] + ty * t2[1]; f.tAcross = tx * n2[0] + ty * n2[1];
    }
  }
  const h = clamp(Math.max(H_MIN, f.wsp / 2 + (4 + 1.0 * S) * (0.55 + 0.8 * f.p)) * (1 - 0.35 * clamp(f.c, 0, 1)), H_MIN, H_MAX);
  f.h = h;
  let hp = h * (1 - 0.4 * Math.max(0, f.cs)) * (1 + 0.4 * f.tAcross);
  let hm = h * (1 - 0.4 * Math.max(0, -f.cs)) * (1 - 0.4 * f.tAcross);
  // concave cap: never fold through the centre of curvature (κ > 0 bends toward +n)
  if (f.kb > 0) hp = Math.min(hp, 0.8 / f.kb); else if (f.kb < 0) hm = Math.min(hm, -0.8 / f.kb);
  if (f.corner) { hp *= 0.7; hm *= 0.7; }
  f.hp = Math.max(1.5, hp); f.hm = Math.max(1.5, hm);
  f.psi = clamp(0.6 * f.tAlong, -0.5, 0.5) * 35 * DEG + (2 * rnd(r.seed, Ch.Angle, j) - 1) * 16 * DEG;
  f.tanPsi = dsin(f.psi) / dcos(f.psi);
}

/** Plate length Λ (sp) of the plate ahead of the crack at s (index j). */
function lambdaAt(cx: FormCx, s: number, j: number): number {
  facts(cx, s, j, FT);
  const f = FT, r = rnd(cx.r.seed, Ch.Length, j);
  const lam = 2 * f.h * (0.8 + 0.7 * f.p) * (0.7 + 0.6 * r) * (1 - 0.4 * f.fast) * (1 - 0.4 * Math.min(1, Math.abs(f.kb) / 0.05)) * (f.corner ? 0.5 : 1);
  return clamp(lam, LAM_MIN, LAM_MAX);
}

// ---------------------------------------------------------------- cracks

/** Two nested hat lattices (nodes every 4 sp and every 2 sp) addressed (key, node), in [−1.35, 1.35]. */
function wob(seed: number, key: number, x: number): number {
  const u1 = x / 4, i1 = Math.floor(u1), t1 = u1 - i1;
  const u2 = x / 2, i2 = Math.floor(u2), t2_ = u2 - i2;
  // memo of the last lattice cells (a pure function of (seed, key, node): results are unchanged)
  if (seed !== wS || key !== wK) { wS = seed; wK = key; w1i = NaN; w2i = NaN; }
  if (i1 !== w1i) { w1i = i1; w1a = 2 * rnd(seed, Ch.Geometry, key, i1) - 1; w1b = 2 * rnd(seed, Ch.Geometry, key, i1 + 1) - 1; }
  if (i2 !== w2i) { w2i = i2; w2a = 2 * rnd(seed, Ch.Jitter, key, i2) - 1; w2b = 2 * rnd(seed, Ch.Jitter, key, i2 + 1) - 1; }
  return 0.9 * (w1a + (w1b - w1a) * t1) + 0.45 * (w2a + (w2b - w2a) * t2_);
}
let wS = NaN, wK = NaN, w1i = NaN, w2i = NaN, w1a = 0, w1b = 0, w2a = 0, w2b = 0;
/** Bow coefficient of a crack, memoised per (seed, key). */
function bowOf(seed: number, key: number): number {
  if (seed !== bS || key !== bK) { bS = seed; bK = key; bV = 2 * rnd(seed, Ch.Misc, key) - 1; }
  return bV;
}
let bS = NaN, bK = NaN, bV = 0;

/** A sampled polyline in doc space (n + 1 samples at equal steps of `len`/n) with chord interpolation. */
class Poly {
  n = 0; len = 0;
  dx = new Float64Array(64); dy = new Float64Array(64);
  /** Doc point at arc x along the drawn polyline (the chord between its samples). */
  docAt(x: number, out: Float64Array): void {
    const n = this.n;
    if (x <= 0 || n === 0) { out[0] = this.dx[0]; out[1] = this.dy[0]; return; }
    if (x >= this.len) { out[0] = this.dx[n]; out[1] = this.dy[n]; return; }
    const u = (x / this.len) * n, q = Math.floor(u), t = u - q;
    out[0] = this.dx[q] + (this.dx[q + 1] - this.dx[q]) * t;
    out[1] = this.dy[q] + (this.dy[q + 1] - this.dy[q]) * t;
  }
  /** Copy the samples into g as a branch of gen `gen` (arc = distance along the segment). */
  addTo(g: UnitGeom, gen: number): void {
    const n = this.n, b = g.beginBranch(gen, this.len);
    for (let q = 0; q <= n; q++) g.addPt(this.dx[q], this.dy[q], q === n ? this.len : (q * this.len) / n);
    g.endBranch(b);
  }
}

/** A crack: a segment A→B in (s, ν) plus a wobble on one axis (0 = s, 1 = ν) vanishing at both ends. */
class Crack extends Poly {
  sA = 0; nA = 0; sB = 0; nB = 0; axis = 0; amp = 0; key = 0;
  set(sA: number, nA: number, sB: number, nB: number, axis: number, amp: number, key: number): this {
    this.sA = sA; this.nA = nA; this.sB = sB; this.nB = nB; this.axis = axis; this.amp = amp; this.key = key;
    const ds = sB - sA, dn = nB - nA;
    this.len = Math.sqrt(ds * ds + dn * dn);
    this.n = 0;
    return this;
  }
  /** Smooth (s, ν) at band distance x from A. */
  bandAt(seed: number, x: number, out: Float64Array): void {
    const len = this.len;
    if (x < 0) x = 0; else if (x > len) x = len;
    const u = len > 0 ? x / len : 0;
    let s = this.sA + (this.sB - this.sA) * u, n = this.nA + (this.nB - this.nA) * u;
    const e = smoothstep(0, EASE_END, x) * smoothstep(0, EASE_END, len - x);
    // a low bow (zero slope at both ends) plus the fine hat wobble
    const sb = dsin(PI * u), bow = bowOf(seed, this.key) * (this.axis === 0 ? BOW : 0.4 * BOW) * len * sb * sb;
    const w = bow + (e > 0 ? wob(seed, this.key, x) * this.amp * e : 0);
    if (this.axis === 0) s += w; else n += w;
    out[0] = s; out[1] = n;
  }
  /** Sample the crack through the spine (points every 2.5 sp of band length). */
  build(cx: FormCx, sj: number): this {
    const seed = cx.r.seed, len = this.len, n = Math.max(1, Math.ceil(len / clamp(len / 8, STEP, 4)));
    this.n = n;
    for (let q = 0; q <= n; q++) {
      this.bandAt(seed, q === n ? len : (q * len) / n, bp);
      bandPt(cx, sj, bp[0], bp[1], v2);
      this.dx[q] = v2[0]; this.dy[q] = v2[1];
    }
    return this;
  }
  /** Pin an end (0 = A, 1 = B) onto a parent's drawn point. */
  pin(end: number, x: number, y: number): this {
    const q = end === 0 ? 0 : this.n;
    this.dx[q] = x; this.dy[q] = y;
    return this;
  }
}
const CR: Crack[] = [];
for (let i = 0; i < 28; i++) CR.push(new Crack());

/** Band → doc: pos(s) + ν·n(s)/z, with s clamped to the unit's read window. */
function bandPt(cx: FormCx, sj: number, s: number, nu: number, out: Float64Array): void {
  const sc = clamp(s, sj - READ_LO, sj + READ_HI);
  cx.at.pos(sc, v2); cx.at.normal(sc, sn);
  const k = nu / cx.z;
  out[0] = v2[0] + sn[0] * k; out[1] = v2[1] + sn[1] * k;
}

/** Smooth s on a transverse crack (arms armA for ν ≥ 0, armB for ν < 0) at ν. */
function transAt(seed: number, armA: Crack, armB: Crack, nu: number): number {
  if (nu >= 0) armA.bandAt(seed, nu, bp); else armB.bandAt(seed, -nu, bp);
  return bp[0];
}
/** Drawn doc point of a transverse crack at ν. */
function transDoc(armA: Crack, armB: Crack, nu: number, out: Float64Array): void {
  if (nu >= 0) armA.docAt(nu, out); else armB.docAt(-nu, out);
}

// ---------------------------------------------------------------- unit cook

/** Cell boundary in ν: a longitudinal crack (index into CR) or the band edge (−1, value in `nu`). */
const bndCrack = new Int32Array(4), bndNu = new Float64Array(4);

/**
 * The plate's film: a gen-0 ribbon from s_a to s_b whose centre offset (h_+ − h_−)/2 and width
 * h_+ + h_− interpolate between the two cracks' facts, so neighbouring plates share their edge
 * at the crack exactly (the same facts give the same point and width) and weld at raster.
 * Widths (sp) ride in the branch's arc column, which the film never truncates.
 */
function addFilm(cx: FormCx, g: UnitGeom, sj: number, sa: number, fa: Facts, sb: number, fb: Facts): void {
  const len = sb - sa;
  if (!(len > 0)) return;
  const n = Math.max(1, Math.ceil(len / FILM_STEP)), b = g.beginBranch(FILM, len);
  for (let q = 0; q <= n; q++) {
    const t = q === n ? 1 : q / n, s = q === n ? sb : sa + len * t;
    const hp = fa.hp + (fb.hp - fa.hp) * t, hm = fa.hm + (fb.hm - fa.hm) * t;
    bandPt(cx, sj, s, 0.5 * (hp - hm), v2);
    g.addPt(v2[0], v2[1], hp + hm);
  }
  g.endBranch(b);
}

/** Trunk half-width (sp) the longitudinal splits stay clear of: 0.5·w_sp, at most 0.6 of the band. */
const trunkHalf = (f: Facts, hs: number): number => Math.min(0.5 * f.wsp, 0.6 * hs);

function cookPlate(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
  g.reset();
  const seed = cx.r.seed, j = rec.j, sj = rec.s, sp = cx.sp, at = cx.at;
  facts(cx, sj, j, FJ);
  g.w = at.at(sp.w, sj); g.p = FJ.p; g.c = FJ.c;
  const amp = (1 + FJ.fast) * clamp(FJ.h / 10, 0.6, 1.6), kj = j * 32;
  // gen 1: the transverse crack through s_j, two arms from the spine centre
  const armA = CR[0].set(sj, 0, sj + FJ.tanPsi * FJ.hp, FJ.hp, 0, amp, kj).build(cx, sj);
  const armB = CR[1].set(sj, 0, sj - FJ.tanPsi * FJ.hm, -FJ.hm, 0, amp, kj + 1).build(cx, sj);
  // the plate behind: its film, and crack j−1 recomputed from its own facts and addresses
  const sp_ = rec.tmpl, lam = sj - sp_;
  if (!(lam > 0)) { armA.addTo(g, 1); armB.addTo(g, 1); return; }
  const first = j < 1;
  facts(cx, sp_, first ? 0 : j - 1, FP);
  addFilm(cx, g, sj, sp_, FP, sj, FJ);
  // the last kept unit also carries the partial plate after it (film only: it has not cracked yet).
  // Live, s_j + Λ + TAIL ≤ s_j + NEED ≤ L, so this only ever fires at finish (cook ≡ finish stays exact).
  if (sj + LAM_MAX > cx.L - TAIL && sj + lambdaAt(cx, sj, j + 1) > cx.L - TAIL && cx.L - sj > 1) { facts(cx, cx.L, j + 1, FT); addFilm(cx, g, sj, sj, FJ, cx.L, FT); }
  armA.addTo(g, 1); armB.addTo(g, 1);
  if (first || !(lam >= MIN_LEN)) return;
  const kp = (j - 1) * 32, ampP = (1 + FP.fast) * clamp(FP.h / 10, 0.6, 1.6);
  const pA = CR[2].set(sp_, 0, sp_ + FP.tanPsi * FP.hp, FP.hp, 0, ampP, kp).build(cx, sj);
  const pB = CR[3].set(sp_, 0, sp_ - FP.tanPsi * FP.hm, -FP.hm, 0, ampP, kp + 1).build(cx, sj);
  const hpP = Math.min(FJ.hp, FP.hp), hmP = Math.min(FJ.hm, FP.hm);

  // gen 2: longitudinal split(s) beside the trunk, from a T-junction on crack j−1 to one on crack j
  const n2_ = hpP + hmP < 0.9 * lam ? 1 : 2;
  let nb = 0;
  bndCrack[nb] = -1; bndNu[nb] = -hmP; nb++;
  for (let k = 0; k < n2_; k++) {
    const r = rnd(seed, Ch.Length, j, 2 + k), r2 = rnd(seed, Ch.Length, j, 4 + k);
    const sig = n2_ === 1 ? (r > 0.5 ? 1 : -1) : k === 0 ? -1 : 1;
    const hs = sig > 0 ? hpP : hmP, t0 = trunkHalf(FJ, hs);
    const nc = sig * (t0 + (hs - t0) * (0.3 + 0.4 * r2));
    const sA = transAt(seed, pA, pB, nc), sB = transAt(seed, armA, armB, nc);
    if (!(sB - sA >= MIN_LEN)) continue;
    const ci = 4 + k, c = CR[ci].set(sA, nc, sB, nc, 1, amp, kj + 2 + k).build(cx, sj);
    transDoc(pA, pB, nc, dp); c.pin(0, dp[0], dp[1]);
    transDoc(armA, armB, nc, dp); c.pin(1, dp[0], dp[1]);
    c.addTo(g, 2);
    bndCrack[nb] = ci; bndNu[nb] = nc; nb++;
  }
  bndCrack[nb] = -1; bndNu[nb] = hpP; nb++;
  if (nb > 3 && bndNu[1] > bndNu[2]) { // keep boundaries sorted in ν
    const c = bndCrack[1], v = bndNu[1]; bndCrack[1] = bndCrack[2]; bndNu[1] = bndNu[2]; bndCrack[2] = c; bndNu[2] = v;
  }

  // gen 3: transverse cracks across each sub-cell (two when the cell is long), from a
  // longitudinal boundary to the next (or the band edge); gen 4: a longitudinal in each
  // tertiary sub-cell, from the tertiary crack back to the previous one (or crack j−1) and,
  // after the last, forward to crack j.
  for (let i = 0; i + 1 < nb; i++) {
    const loC = bndCrack[i], hiC = bndCrack[i + 1], nLo = bndNu[i], nHi = bndNu[i + 1];
    if (!(nHi - nLo >= MIN_CELL)) continue;
    const nm = 0.5 * (nLo + nHi);
    const sa = transAt(seed, pA, pB, nm), sb = transAt(seed, armA, armB, nm);
    if (!(sb - sa >= MIN_LEN + 2)) continue;
    const n3 = sb - sa > 2.2 * (nHi - nLo) && sb - sa > 14 ? 2 : 1;
    let prev: Crack | null = null;
    for (let t = 0; t < n3; t++) {
      const st = sa + ((sb - sa) * (t + 0.35 + 0.3 * rnd(seed, Ch.Growth, j, 32 + 4 * i + t))) / n3;
      let nA = nLo, nB = nHi;
      if (loC >= 0) { CR[loC].bandAt(seed, st - CR[loC].sA, bp); nA = bp[1]; }
      if (hiC >= 0) { CR[hiC].bandAt(seed, st - CR[hiC].sA, bp); nB = bp[1]; }
      if (!(nB - nA >= MIN_CELL)) continue;
      // grow out of a longitudinal crack when the cell has one on only one side
      const fromHi = loC < 0 && hiC >= 0;
      const c3 = CR[6 + 2 * i + t], k3 = kj + 4 + 2 * i + t;
      if (fromHi) c3.set(st, nB, st, nA, 0, amp * 0.8, k3); else c3.set(st, nA, st, nB, 0, amp * 0.8, k3);
      c3.build(cx, sj);
      if (loC >= 0) { CR[loC].docAt(st - CR[loC].sA, dp); c3.pin(fromHi ? 1 : 0, dp[0], dp[1]); }
      if (hiC >= 0) { CR[hiC].docAt(st - CR[hiC].sA, dp); c3.pin(fromHi ? 0 : 1, dp[0], dp[1]); }
      c3.addTo(g, 3);
      for (let half = 0; half < 2; half++) {
        if (half === 1 && t + 1 < n3) continue;
        const r4 = rnd(seed, Ch.Growth, j, 64 + 8 * i + 2 * t + half);
        const nm4 = nA + (nB - nA) * (0.3 + 0.4 * r4);
        const x3 = Math.abs(nm4 - c3.nA);
        c3.bandAt(seed, x3, bp);
        const s3 = bp[0];
        let sEnd: number, xp = 0;
        if (half === 1) sEnd = transAt(seed, armA, armB, nm4);
        else if (prev) { xp = clamp(Math.abs(nm4 - prev.nA), 0, prev.len); prev.bandAt(seed, xp, bp); sEnd = bp[0]; }
        else sEnd = transAt(seed, pA, pB, nm4);
        if (!(Math.abs(sEnd - s3) >= MIN_LEN)) continue;
        const c4 = CR[12 + 4 * i + 2 * t + half].set(s3, nm4, sEnd, nm4, 1, amp * 0.7, kj + 10 + 4 * i + 2 * t + half).build(cx, sj);
        c3.docAt(x3, dp); c4.pin(0, dp[0], dp[1]);
        if (half === 1) transDoc(armA, armB, nm4, dp);
        else if (prev) prev.docAt(xp, dp);
        else transDoc(pA, pB, nm4, dp);
        c4.pin(1, dp[0], dp[1]);
        c4.addTo(g, 4);
      }
      prev = c3;
    }
  }
}

/** Points of the network at depth D: gen g drawn to len·clamp(D − g + 1, 0, 1); the film whole once D > 0. */
function netCount(g: UnitGeom, D: number): number {
  let n = 0;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b];
    if (gen === FILM) { if (D > 0) n += g.bCnt[b]; continue; }
    const f = clamp(D - gen + 1, 0, 1);
    if (f > 0) n += g.prefixCount(b, g.bLen[b] * f);
  }
  return n;
}

/** Largest 1/16 level ≤ dMax whose point count fits the unit budget. */
function netCeiling(g: UnitGeom): number {
  if (netCount(g, DMAX) <= UNIT_BUDGET) return DMAX;
  let lo = 0, hi = DMAX * 16;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (netCount(g, m / 16) <= UNIT_BUDGET) lo = m; else hi = m; }
  return lo / 16;
}

/**
 * Emit the network truncated to D. The film (gen 0) fades in with min(D, 1)·eIn and keeps its
 * own widths. Gens 1–2 widen ×(1 + 0.8·clamp(D − 3, 0, 1)); a child's width eases in over its
 * collar so it never stamps a blob on its parent under additive ink. The first gen-1 branch
 * (the +ν arm of the transverse crack) keeps full width at the spine; `arm0Collar` overrides
 * that for the radial seed, whose rays all meet at one point.
 */
function netEmit(g: UnitGeom, D: number, wc: number, eIn: number, z: number, born: number, unit: number, arm0Collar: number, out: Sink): number {
  const floor = W_FLOOR / z, gl = glow(g.c), widen = 1 + 0.8 * clamp(D - 3, 0, 1);
  let pts = 0, arm0 = true;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b], o = g.bOff[b], cnt = g.bCnt[b], pa = g.pa;
    if (gen === FILM) {
      if (!(D > 0)) continue;
      const fa = FILM_ALPHA * Math.min(D, 1) * eIn;
      if (!(fa > 0)) continue;
      out.begin(PolyKind.Ribbon, 0, fa, toneOf(g.p, 0), born, unit, 1);
      for (let k = 0; k < cnt; k++) out.pt(g.px[o + k], g.py[o + k], pa[o + k] / z);
      pts += out.end();
      continue;
    }
    const f = clamp(D - gen + 1, 0, 1);
    if (!(f > 0)) continue;
    const len = g.bLen[b], lam = len * f;
    const w = wc * GW[gen] * (gen <= 2 ? widen : 1);
    let collar = COLLAR;
    if (gen === 1 && arm0) { collar = arm0Collar; arm0 = false; }
    out.begin(PolyKind.Ribbon, gen, ALPHA * hierarchy(gen) * gl, toneOf(g.p, gen), born, unit, 1);
    let k = 0;
    for (; k < cnt && (k === 0 || pa[o + k] < lam); k++) {
      const a = pa[o + k], ww = collar > 0 && a < collar ? w * smoothstep(0, collar, a) : w;
      out.pt(g.px[o + k], g.py[o + k], ww > floor ? ww : floor);
    }
    if (k < cnt) {
      const a0 = pa[o + k - 1], a1 = pa[o + k];
      const t = a1 > a0 ? (lam - a0) / (a1 - a0) : 1;
      const x = t >= 1 ? g.px[o + k] : g.px[o + k - 1] + (g.px[o + k] - g.px[o + k - 1]) * t;
      const y = t >= 1 ? g.py[o + k] : g.py[o + k - 1] + (g.py[o + k] - g.py[o + k - 1]) * t;
      const ww = collar > 0 && lam < collar ? w * smoothstep(0, collar, lam) : w;
      out.pt(x, y, ww > floor ? ww : floor);
    }
    pts += out.end();
  }
  return pts;
}

/** Seam width (doc) of a film whose nib width is w (doc). */
const seamWidth = (w: number, z: number): number => clamp(SEAM_K * w * z, SEAM_MIN, SEAM_MAX) / z;

const chain: ChainOperator = {
  halfWin: READ_LO,
  dMax: DMAX,
  unitBudget: UNIT_BUDGET,
  strokeBudget: STROKE_BUDGET,

  need(cx: FormCx, cur: ChainCursor): number {
    return (cur.phase === 0 ? cx.s0 : cur.s) + NEED;
  },

  step(cx: FormCx, cur: ChainCursor, rec: ChainRecord): boolean {
    if (cur.phase === 0) {
      cur.s = cx.s0 + lambdaAt(cx, cx.s0, 0) * (0.3 + 0.4 * rnd(cx.r.seed, Ch.Length, 0, 1));
      cur.side = cx.s0; cur.phase = 1;
      return false;
    }
    const s = cur.s;
    rec.s = s; rec.j = cur.j; rec.side = 0; rec.tmpl = cur.side;
    cur.side = s; cur.j++;
    cur.s = s + lambdaAt(cx, s, cur.j);
    return true;
  },

  keep(cx: FormCx, s: number): boolean { return s <= cx.L - TAIL; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void {
    cookPlate(cx, rec, g);
    g.ceil = netCeiling(g);
  },

  count(g: UnitGeom, D: number): number { return netCount(g, D); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return netEmit(g, D, seamWidth(g.w, cx.z) * eIn, eIn, cx.z, rec.s, rec.j, 0, out);
  },
};

// ---------------------------------------------------------------- radial seed: a dried drop

const rg = new UnitGeom(), ring = new Poly();
/** Ring crack radius as a fraction of the drop radius; ring wobble amplitude (sp). */
const RING = 0.55, RING_AMP = 0.35;

/** Add a straight doc-space crack A→B with a perpendicular wobble, points every 2.5 sp. */
function addRay(g: UnitGeom, seed: number, z: number, ax: number, ay: number, bx: number, by: number, gen: number, amp: number, key: number): void {
  const dx = bx - ax, dy = by - ay, lenD = Math.sqrt(dx * dx + dy * dy), len = lenD * z;
  const n = Math.max(1, Math.ceil(len / STEP));
  const px = lenD > 0 ? -dy / lenD : 0, py = lenD > 0 ? dx / lenD : 0;
  const b = g.beginBranch(gen, len);
  for (let q = 0; q <= n; q++) {
    const x = q === n ? len : (q * len) / n, u = len > 0 ? x / len : 0;
    const e = smoothstep(0, EASE_END, x) * smoothstep(0, EASE_END, len - x);
    const w = e > 0 ? wob(seed, key, x) * amp * e / z : 0;
    g.addPt(ax + dx * u + px * w, ay + dy * u + py * w, x);
  }
  g.endBranch(b);
}

/** Ring point at angle φ (radius R0 sp around the centre, radial wobble by arc from φ0). */
function ringPt(seed: number, key: number, cxd: number, cyd: number, R0: number, phi0: number, phi: number, z: number, out: Float64Array): void {
  let a = phi - phi0; a -= Math.floor(a / TAU) * TAU;
  const x = a * R0, len = TAU * R0;
  const e = smoothstep(0, EASE_END, x) * smoothstep(0, EASE_END, len - x);
  const r = (R0 + (e > 0 ? wob(seed, key, x) * RING_AMP * e : 0)) / z;
  out[0] = cxd + r * dcos(phi); out[1] = cyd + r * dsin(phi);
}

/**
 * Radial seed: R = (5 + 1.1S)(0.5 + 0.9p) sp. The film is a disc of diameter 2R. Gen 1: 5–7
 * radial cracks from a centre offset 0.2R·r to the rim; gen 2: a ring crack at 0.55R growing
 * around from a random start; gen 3: short radials from the ring to the rim at the mid-angles;
 * gen 4: the old seams widen.
 */
function crazeRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z, sd = r.seed, S = r.stroke.size, p = seed.p;
  const R = (7 + 1.6 * S) * (0.65 + 0.75 * p);
  rg.reset(); rg.p = p; rg.c = seed.c; rg.w = seed.w;
  // the film disc
  out.begin(PolyKind.Dot, 0, FILM_ALPHA * Math.min(D, 1), toneOf(p, 0), cx.s0, 0, 1);
  out.pt(seed.x, seed.y, (2 * R) / z);
  out.end();
  const n1 = 6 + Math.floor(3 * rnd(sd, Ch.Growth, RADIAL_ID));
  const offA = TAU * rnd(sd, Ch.Angle, RADIAL_ID, 1), offR = 0.2 * R * rnd(sd, Ch.Length, RADIAL_ID, 1);
  const c0x = seed.x + offR * dcos(offA) / z, c0y = seed.y + offR * dsin(offA) / z;
  const th0 = TAU * rnd(sd, Ch.Angle, RADIAL_ID, 2);
  for (let i = 0; i < n1; i++) {
    const th = th0 + (TAU * (i + 0.5 * (rnd(sd, Ch.Angle, RADIAL_ID + 8 + i) - 0.5))) / n1;
    addRay(rg, sd, z, c0x, c0y, seed.x + R * dcos(th) / z, seed.y + R * dsin(th) / z, 1, 1, RADIAL_ID + 8 + i);
  }
  // ring crack: one closed branch of points every 2.5 sp of circumference
  const R0 = RING * R, phi0 = TAU * rnd(sd, Ch.Angle, RADIAL_ID, 3), ringLen = TAU * R0, nr = Math.max(8, Math.min(63, Math.ceil(ringLen / STEP)));
  ring.n = nr; ring.len = ringLen;
  for (let q = 0; q <= nr; q++) {
    const x = q === nr ? ringLen : (q * ringLen) / nr;
    ringPt(sd, RADIAL_ID + 1, seed.x, seed.y, R0, phi0, phi0 + x / R0, z, bp);
    ring.dx[q] = bp[0]; ring.dy[q] = bp[1];
  }
  ring.addTo(rg, 2);
  // short radials ring → rim at the mid-angles, starting on the drawn ring
  for (let i = 0; i < n1; i++) {
    const th = th0 + (TAU * (i + 0.5 + 0.3 * (rnd(sd, Ch.Angle, RADIAL_ID + 16 + i) - 0.5))) / n1;
    let a = th - phi0; a -= Math.floor(a / TAU) * TAU;
    ring.docAt(a * R0, bp);
    addRay(rg, sd, z, bp[0], bp[1], seed.x + R * dcos(th) / z, seed.y + R * dsin(th) / z, 3, 0.8, RADIAL_ID + 16 + i);
  }
  netEmit(rg, D, seamWidth(seed.w, z), 1, z, cx.s0, 0, EASE_END, out);
  return D;
}

/** Craze (lab). */
export const ops: FormOps = {
  id: 'ripple', v: 101, locality: 'local', reach: READ_LO, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: crazeRadial,
  radialCeiling: DMAX,
};
