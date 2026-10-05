/**
 * Burin v1 — engraving that follows the form (promoted from the forms lab, v104; brief: lab/forms/briefs/burin.md).
 *
 * The stroke becomes an engraver's contour: short lozenge ticks (thin, thick, thin — the
 * burin's cut) are laid ACROSS it on the side the light does not reach, so a straight run
 * reads as a lit cylinder and the inside of a bend shades like a sphere's far rim. The pen's
 * lean is the light; without tilt the lamp is up-left. Rising crosses the ticks into
 * cross-hatch (gen 3), adds the other diagonal and stipple (gen 4); a held tap is a stippled
 * disc (mezzotint rocker spot).
 *
 * Operator model: one chain unit = one hatch station at s_j, cooked once at its ceiling (4)
 * with every family on both sides (a side with zero weight has no ticks) and truncated to D:
 *   gen g tick drawn to ℓ·clamp(D − g + 1, 0, 1); the lozenge width is a function of arc
 *   position only, so prefix truncation is exact; stipple dots ease in by width × (D − 3).
 * Every unit is a pure function of the spine within ±8 sp of s_j, the entry factor and its
 * integer rng address (seed, Ch.*, j, k).
 *
 * Decisions beyond the brief (noted for the report):
 *  - The curvature shortening clamp(1 − 0.8ℓ|κ̄|, 0.25, 1) applies to the concave side only:
 *    ticks on the convex side fan apart and never cross, so they keep their length.
 *  - The brief's alternate(j) side rule for |n·ℓ| < 0.15 flipped the hatch from station to
 *    station on runs parallel to the light (fur on both sides); the cylinder rule is instead a
 *    continuous side weight smoothstep(−0.15, 0.15, σ·n·ℓ), so ticks migrate smoothly.
 *  - Gen 2 is an INFILL tick at the midpoint to the next station (0.85ℓ, same side), so the
 *    hatch doubles in density as the stroke rises (tone deepens as on a plate); the brief's
 *    lit-side tick survives only in the terminator band (|n·ℓ| < 0.5), where it belongs.
 *  - Cross families (gen 3 +40°, gen 4 −40°, both toward the trailing tangent) root at the
 *    quarter points of the station gap and only on the heavier side, so they cross the hatch
 *    as a lattice instead of fanning from one root; the "ℓ ≥ 6 sp" gate is a smoothstep(5, 7).
 *  - Inside tight bends (r < ~33 sp, gone by 18 sp) the concave side fades out: shortened ticks piling
 *    up there (and at a short V, which the κ smoothing makes look like an R ≈ 25 arc) made a bright knot.
 *  - The sphere rule needs a SUSTAINED bend: q reads the weakest same-signed third of the ±8 sp
 *    window, so a short kink never throws a spike of ticks onto the lit side. The lit-side
 *    terminator tick is kept to straight runs (it read as stray leaves in S-bends).
 *  - Ticks never enter the stroke's own trunk within ±8 sp: each tick is ray-cast against the
 *    station discs (w/2 + 0.5 sp) in the window and stopped at 85 % of the free room; on the
 *    concave side it also uses at most 55 % of the room to the centre of curvature.
 *  - Tick length grows with nib size as 5 + 1.3S, compressed above S = 10 (÷ (1 + (S − 10)/25)),
 *    so a 22 sp brush engraves rather than grows feathers; the brief's (6 + 1.5S) read as fur.
 *  - Chisel: ticks are Chisel polys at the NIB's edge angle (chiselAngle(alt, az) − rot), so
 *    a tick across the edge is broad and one along it is a hairline, for free.
 */
import { PolyKind } from '../../core/types';
import { rnd, Ch, dcos, dsin, PI } from '../../core/det';
import { clamp, lerp, smoothstep } from '../../core/num';
import { chiselAngle } from '../nibs';
import type { ChainCursor, ChainOperator, ChainRecord, FormCx, FormOps, RadialSeed, Sink, TrunkStyle } from './types';
import { UnitGeom, toneOf, glow } from './types';

const DEG = PI / 180;
/** Spine window a unit reads either side (sp). */
const WIN = 8;
/** Spacing clamp (sp) and corner clearance (sp). */
const D_MIN = 3, D_MAX = 11, CORNER_CLEAR = 3;
/** Points per tick (5: thin, thick, thin + the flick) and width floor (sp). */
const TICK_PTS = 5, W_FLOOR = 0.35;
/** Ticks shorter than this (sp) are not laid (invisible stubs). */
const MIN_TICK = 1;
/** Family alphas (Night), gen 1..4; stipple uses the gen-4 alpha. */
const ALPHA = [0, 0.55, 0.45, 0.35, 0.35];
/** Cross-hatch angle and the fast skew. */
const CROSS = 40 * DEG, SKEW = 25 * DEG, JIT = 4 * DEG;
/** The flick: the tick's last point slides this fraction of its length along the trailing tangent. */
const FLICK = 0.08;
/** Tick belly (sp): w_sp·lerp(0.22, 0.40, p) (pen 0.6·w_sp), clamped so hatching stays line-like at broad nibs. */
const BELLY_MIN = 0.5, BELLY_MAX = 2.4, BELLY_PEN_MAX = 1.4;
/** Per-unit ceiling point count (≤ 7 ticks × 5 + 2 dots) and the causal stroke budget. */
const UNIT_BUDGET = 40, STROKE_BUDGET = 16000;
/** Depth ceiling of every unit. */
const DMAX = 4;
/** Stipple dots per unit (gen 4) and their diameter as a fraction of the nib width. */
const DOTS = 2, DOT_W = 0.4, DOT_MAX = 2.6;

const v2 = new Float64Array(2), n2 = new Float64Array(2), t2 = new Float64Array(2);

/** Δ(s): tick spacing from pressure and crowding averaged over ±8 sp. */
function spacing(cx: FormCx, s: number): number {
  const sp = cx.sp, at = cx.at;
  const p = at.mean(sp.p, s, WIN), c = at.mean(sp.c, s, WIN);
  return clamp(lerp(8.5, 4.5, p) * (1 + 0.8 * c), D_MIN, D_MAX);
}

/** Whether a corner station lies within ±CORNER_CLEAR sp of s (stations ≤ hi only). */
function nearCorner(cx: FormCx, s: number): boolean {
  const sp = cx.sp, S = sp.s, hi = cx.at.hi, lo = s - CORNER_CLEAR, up = s + CORNER_CLEAR;
  let i = cx.at.locate(lo);
  if (S[i] < lo) i++;
  for (; i <= hi && S[i] <= up; i++) if (sp.corner[i]) return true;
  return false;
}

/**
 * Room (sp) along the tick ray from (rx, ry) in unit direction (ux, uy) before it enters the
 * stroke's own trunk (the disc of half-width w/2 + 0.5 sp round any station within ±WIN): the
 * inside of a V, a rounded bottom or a tight curl. A station's veto eases out toward the window
 * edge so a station entering the window never steps the hatch.
 */
function rayRoom(cx: FormCx, s: number, rx: number, ry: number, ux: number, uy: number): number {
  const sp = cx.sp, S = sp.s, X = sp.x, Y = sp.y, W = sp.w, z = cx.z, hi = cx.at.hi, lo = s - WIN, up = s + WIN;
  let i = cx.at.locate(lo), room = 1e9;
  if (S[i] < lo) i++;
  for (; i <= hi && S[i] <= up; i++) {
    const vx = (X[i] - rx) * z, vy = (Y[i] - ry) * z;
    const along = vx * ux + vy * uy;
    if (!(along > 0)) continue;
    const perp = vx * uy - vy * ux, rad = 0.5 * W[i] * z + 0.5;
    if (Math.abs(perp) >= rad) continue;
    const r = along - Math.sqrt(rad * rad - perp * perp) + 60 * smoothstep(6, WIN, Math.abs(S[i] - s));
    if (r < room) room = r;
  }
  return room > 0 ? room : 0;
}

/** The light direction ℓ (unit vector light travels along) at arc s into out. */
function lightAt(cx: FormCx, s: number, out: Float64Array): void {
  const r = cx.r, a = r.rot + PI / 4; // lamp up-left: light travels down-right (y-down screen)
  let lx = dcos(a), ly = dsin(a);
  if (r.device === 'pen') {
    const sp = cx.sp, at = cx.at;
    const alt = at.at(sp.alt, s);
    const wt = smoothstep(0.1, 0.3, dcos(alt));
    if (wt > 0) {
      const az = at.angle(sp.az, s);
      const tx = dcos(az), ty = dsin(az);
      const x = wt * -tx + (1 - wt) * lx, y = wt * -ty + (1 - wt) * ly;
      const m = Math.sqrt(x * x + y * y);
      if (m > 1e-6) { lx = x / m; ly = y / m; }
    }
  }
  out[0] = lx; out[1] = ly;
}

/** Lozenge width (doc) at arc a (sp) of a tick of length len: thin, thick, thin. */
function lozenge(wt: number, a: number, len: number, floor: number): number {
  const u = len > 0 ? (4 * a * (len - a)) / (len * len) : 0;
  const w = wt * (0.25 + 0.75 * (u < 0 ? 0 : u));
  return w > floor ? w : floor;
}

/**
 * Add one tick as a branch of g: from the root (rx, ry) along unit direction (ux, uy) for
 * len sp, 5 points at a = 0, ¼, ½, ¾, 1; the last displaced 0.15·len along (fx, fy) (the
 * flick). Arcs are nominal (i·len/4) so the tip interpolates continuously under truncation.
 */
function tick(g: UnitGeom, gen: number, rx: number, ry: number, ux: number, uy: number, fx: number, fy: number, len: number, z: number): void {
  const b = g.beginBranch(gen, len);
  const d = len / z;
  for (let i = 0; i < TICK_PTS; i++) {
    const a = i / (TICK_PTS - 1);
    let x = rx + ux * d * a, y = ry + uy * d * a;
    if (i === TICK_PTS - 1) { x += fx * d * FLICK; y += fy * d * FLICK; }
    g.addPt(x, y, a * len);
  }
  g.endBranch(b);
}

/** Direction u·cos θ + tt·sin θ (u ⟂ tt, both unit): u turned by θ toward tt. */
function turn(ux: number, uy: number, tx: number, ty: number, th: number, out: Float64Array): void {
  const c = dcos(th), s = dsin(th);
  out[0] = ux * c + tx * s; out[1] = uy * c + ty * s;
}
const u2 = new Float64Array(2), l2 = new Float64Array(2);

/** Index of the first stipple dot in g (dots sit after the branches, before the trailing meta point). */
const dotBase = (g: UnitGeom): number => g.nPts - 1 - g.k;
function dotCount(g: UnitGeom, D: number): number { return D > 3 ? g.k : 0; }

/** Points of the unit at depth D. */
function unitCount(g: UnitGeom, D: number): number {
  let n = 0;
  for (let b = 0; b < g.nB; b++) {
    const f = clamp(D - g.bGen[b] + 1, 0, 1);
    if (f > 0) n += g.prefixCount(b, g.bLen[b] * f);
  }
  return n + dotCount(g, D);
}

/** Tick belly width (doc) from the untapered nib width (doc), pressure and zoom; clamped in sp. */
function bellyOf(nib: string, w: number, p: number, z: number): number {
  const sp = w * z;
  return (nib === 'pen' ? clamp(0.6 * sp, BELLY_MIN, BELLY_PEN_MAX) : clamp(sp * lerp(0.22, 0.4, p), BELLY_MIN, BELLY_MAX)) / z;
}

/**
 * Emit the unit truncated to D: one poly per drawn tick (lozenge width along its full
 * length, eased by eIn) and the stipple dots easing in by width over D ∈ (3, 4].
 */
function unitEmit(cx: FormCx, g: UnitGeom, D: number, eIn: number, born: number, unit: number, out: Sink): number {
  const z = cx.z, floor = W_FLOOR / z, gl = glow(g.c), nib = cx.r.stroke.nib, chisel = nib === 'chisel';
  const kind = chisel ? PolyKind.Chisel : PolyKind.Ribbon;
  const ang = chisel ? g.px[g.nPts - 1] : 0; // the trailing meta point carries the nib edge angle
  const w0 = bellyOf(nib, g.w, g.p, z) * eIn;
  let pts = 0;
  for (let b = 0; b < g.nB; b++) {
    const gen = g.bGen[b], f = clamp(D - gen + 1, 0, 1);
    if (!(f > 0)) continue;
    const len = g.bLen[b], lam = len * f;
    const o = g.bOff[b], cnt = g.bCnt[b], pa = g.pa;
    out.begin(kind, gen, ALPHA[gen] * gl, toneOf(g.p, gen), born, unit, 1);
    let k = 0;
    for (; k < cnt && (k === 0 || pa[o + k] < lam); k++) out.pt(g.px[o + k], g.py[o + k], lozenge(w0, pa[o + k], len, floor), ang);
    if (k < cnt) {
      const a0 = pa[o + k - 1], a1 = pa[o + k];
      const t = a1 > a0 ? (lam - a0) / (a1 - a0) : 1;
      const x = t >= 1 ? g.px[o + k] : g.px[o + k - 1] + (g.px[o + k] - g.px[o + k - 1]) * t;
      const y = t >= 1 ? g.py[o + k] : g.py[o + k - 1] + (g.py[o + k] - g.py[o + k - 1]) * t;
      out.pt(x, y, lozenge(w0, lam, len, floor), ang);
    }
    pts += out.end();
  }
  const nd = dotCount(g, D);
  if (nd > 0) {
    const f = clamp(D - 3, 0, 1), o = dotBase(g), w = clamp(DOT_W * g.w * z, W_FLOOR, DOT_MAX) / z * eIn * f;
    for (let i = 0; i < nd; i++) {
      out.begin(PolyKind.Dot, 4, ALPHA[4] * gl, toneOf(g.p, 4), born, unit, 1);
      out.pt(g.px[o + i], g.py[o + i], w > 1e-6 ? w : 1e-6);
      pts += out.end();
    }
  }
  return pts;
}

/**
 * Cook one hatch station at arc s with unit index j into g. Scalars on g: p, c (pressure,
 * crowding), w (UNTAPERED nib width, doc), k (number of stipple dots), ceil = 4. The px/py
 * tail after the branches holds the dots, then one meta point whose px is the chisel edge
 * angle (0 for other nibs), so emit never reads the spine.
 */
function cookUnit(cx: FormCx, s: number, j: number, g: UnitGeom): void {
  g.reset();
  const sp = cx.sp, at = cx.at, r = cx.r, z = cx.z, seed = r.seed;
  at.pos(s, v2); at.normal(s, n2); at.tangent(s, t2);
  const p = at.at(sp.p, s), c = at.at(sp.c, s), cs = at.at(sp.cs, s), vn = at.at(sp.vn, s);
  const kb = at.mean(sp.k, s, WIN);
  const wDoc = at.at(sp.w, s), wSp = wDoc * z;
  g.p = p; g.c = c; g.w = wDoc; g.ceil = DMAX;
  const edge = r.stroke.nib === 'chisel' ? chiselAngle(at.at(sp.alt, s), at.angle(sp.az, s)) - r.rot : 0;
  // light; the cylinder rule as a continuous side weight (ticks migrate from side to side as the line turns)
  lightAt(cx, s, l2);
  const nl = n2[0] * l2[0] + n2[1] * l2[1];
  // sphere rule on the concave side of a sustained bend; tight bends (r < ~33 sp, open by 18 sp) leave the inside open
  // the bend must be SUSTAINED: the weakest same-signed third of the window (a kink lives in at most two thirds,
  // so it never trips the sphere rule and throws a spike of ticks onto the lit side); deadband for jitter
  const sIn = kb >= 0 ? 1 : -1;
  const ka = sIn * at.mean(sp.k, s - (2 * WIN) / 3, WIN / 3), km = sIn * at.mean(sp.k, s, WIN / 3), kz = sIn * at.mean(sp.k, s + (2 * WIN) / 3, WIN / 3);
  const kSus = Math.max(0, Math.min(ka, km, kz));
  const kTop = Math.max(ka, km, kz); // an arc has even thirds; a smoothed kink has one hot third
  const q = smoothstep(0.004, 0.011, kSus) * (kTop > 0 ? smoothstep(0.35, 0.6, kSus / kTop) : 0);
  const wFar = smoothstep(-0.2, 0.6, -sIn * nl) * smoothstep(0.055, 0.03, Math.abs(kb));
  // base length, skew
  const fast = smoothstep(1, 2.5, vn);
  const rl = rnd(seed, Ch.Length, j, 0), ra = rnd(seed, Ch.Angle, j, 0);
  const S = r.stroke.size, sizeL = 5 + (1.3 * S) / (1 + Math.max(0, S - 10) / 25); // broad nibs: hatch grows slower than the nib
  const base = sizeL * (0.5 + p) * (1 - 0.4 * fast) * (0.9 + 0.2 * rl);
  const skew = SKEW * fast + JIT * (2 * ra - 1);
  const root = (wSp / 2 + 0.5) / z;
  const ttx = -t2[0], tty = -t2[1]; // trailing tangent
  const half = 0.5 * spacing(cx, s) / z; // doc offset to the midpoint of the next station
  const graze = smoothstep(0.5, 0.2, Math.abs(nl)); // the terminator band, where a lit-side contour tick belongs
  let lenP = 0, lenM = 0;
  for (let side = 0; side < 2; side++) {
    const sg = side === 0 ? 1 : -1;
    const cyl = smoothstep(-0.15, 0.15, sg * nl), cylO = smoothstep(-0.15, 0.15, -sg * nl);
    const weight = sg === sIn ? q * wFar + (1 - q) * cyl : (1 - q) * cyl;
    const other = sg === sIn ? (1 - q) * cylO : q * wFar + (1 - q) * cylO;
    const curv = sg === sIn ? clamp(1 - 0.8 * base * Math.abs(kb), 0.25, 1) : 1;
    const crowd = 1 - 0.6 * Math.max(0, sg * cs);
    // inside a bend a tick may use at most 55 % of the free room between the trunk edge and the centre of curvature
    const bend = sg === sIn && Math.abs(kb) > 1e-6 ? 0.55 * Math.max(0, 1 / Math.abs(kb) - (wSp / 2 + 0.5)) : 1e9;
    const ux = sg * n2[0], uy = sg * n2[1];
    const rx = v2[0] + ux * root, ry = v2[1] + uy * root;
    turn(ux, uy, ttx, tty, skew, u2);
    const room = Math.min(bend, 0.85 * rayRoom(cx, s, rx, ry, u2[0], u2[1]));
    const lenFull = Math.min(base * curv, room) * crowd;
    const len = lenFull * weight;
    const lit = 0.45 * lenFull * Math.max(0, other - weight) * graze * (1 - q) * smoothstep(0.008, 0.003, Math.abs(kb));
    if (sg > 0) lenP = len; else lenM = len;
    if (len > MIN_TICK) {
      tick(g, 1, rx, ry, u2[0], u2[1], ttx, tty, len, z);
      // gen 2: the infill tick at the midpoint to the next station doubles the hatch density (tone deepens)
      tick(g, 2, rx + t2[0] * half, ry + t2[1] * half, u2[0], u2[1], ttx, tty, 0.85 * len, z);
    }
    if (lit > MIN_TICK) {
      tick(g, 2, rx, ry, u2[0], u2[1], ttx, tty, lit, z);
    }
  }
  // cross families on the heavier side only, rooted at the quarter points so they cross the hatch instead of
  // fanning from its roots: gen 3 leans +40° toward the trailing tangent, gen 4 −40°
  const heavy = lenP >= lenM ? 1 : -1, lenH = lenP >= lenM ? lenP : lenM;
  const cross = 0.9 * lenH * smoothstep(5, 7, lenH);
  if (cross > MIN_TICK) {
    const ux = heavy * n2[0], uy = heavy * n2[1];
    const rx = v2[0] + ux * root, ry = v2[1] + uy * root;
    turn(ux, uy, ttx, tty, skew + CROSS, u2);
    tick(g, 3, rx + t2[0] * half * 0.5, ry + t2[1] * half * 0.5, u2[0], u2[1], ttx, tty, cross, z);
    turn(ux, uy, ttx, tty, skew - CROSS, u2);
    tick(g, 4, rx + t2[0] * half * 1.5, ry + t2[1] * half * 1.5, u2[0], u2[1], ttx, tty, cross, z);
  }
  // stipple: 2 dots on the heavier side, between 0.15 and 0.6 of its tick out, scattered ±0.4Δ along the stroke
  g.k = 0;
  if (lenH > 1) {
    const ux = heavy * n2[0], uy = heavy * n2[1], dd = 2 * half * z;
    for (let i = 0; i < DOTS; i++) {
      const ra2 = rnd(seed, Ch.Misc, j, 1 + i), rb = rnd(seed, Ch.Misc, j, 8 + i);
      const a = (0.15 + 0.45 * ra2) * lenH, along = (rb - 0.5) * 0.8 * dd;
      g.addPt(v2[0] + ux * root + (ux * a - t2[0] * along) / z, v2[1] + uy * root + (uy * a - t2[1] * along) / z, 0);
      g.k++;
    }
  }
  g.addPt(edge, 0, 0); // meta point
}

const chain: ChainOperator = {
  halfWin: WIN,
  dMax: DMAX,
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
    const s = cur.s;
    const skip = nearCorner(cx, s);
    rec.s = s; rec.j = cur.j; rec.side = 0; rec.tmpl = 0;
    cur.j++;
    cur.s = s + spacing(cx, s);
    return !skip;
  },

  keep(cx: FormCx, s: number): boolean { return s <= cx.L - 2; },

  cook(cx: FormCx, rec: ChainRecord, g: UnitGeom): void { cookUnit(cx, rec.s, rec.j, g); },

  count(g: UnitGeom, D: number): number { return unitCount(g, D); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return unitEmit(cx, g, D, eIn, rec.s, rec.j, out);
  },
};

/** rng address base of the radial seed (above any chain unit index). */
const RADIAL_J = 0x7fff0104;

/**
 * Radial seed: the cook's dot, then a stippled disc: ring k = 1.. at radius (3 + 0.4S)·k sp
 * of 6k dots (±30 % jitter of the ring gap), ring k easing in by width over D ∈ [(k−1)/2, k/2].
 * Ring tone/alpha family = 1 + floor((k − 1)/2), so the spot deepens outward.
 */
function burinRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, DMAX);
  if (!(D > 0)) return 0;
  const r = cx.r, z = cx.z, S = r.stroke.size, gap = 3 + 0.4 * S;
  const wDot = clamp(DOT_W * seed.w * z, W_FLOOR, DOT_MAX) / z, gl = glow(seed.c);
  const rot0 = rnd(r.seed, Ch.Angle, RADIAL_J, 0);
  for (let k = 1; k <= 2 * DMAX; k++) {
    const f = clamp(2 * D - (k - 1), 0, 1);
    if (!(f > 0)) break;
    const n = 6 * k, gen = Math.min(4, 1 + ((k - 1) >> 1)), w = wDot * f;
    const alpha = ALPHA[gen] * gl, tone = toneOf(seed.p, gen);
    for (let i = 0; i < n; i++) {
      const ra = rnd(r.seed, Ch.Angle, RADIAL_J + k, i), rr = rnd(r.seed, Ch.Length, RADIAL_J + k, i);
      const a = (2 * PI * (i + rot0 + 0.6 * (ra - 0.5))) / n;
      const rad = (gap * k + (rr - 0.5) * 0.6 * gap) / z;
      out.begin(PolyKind.Dot, gen, alpha, tone, cx.s0, 0, 1);
      out.pt(seed.x + dcos(a) * rad, seed.y + dsin(a) * rad, w > 1e-6 ? w : 1e-6);
      out.end();
    }
  }
  return D;
}

export const burin: FormOps = {
  id: 'burin', v: 1, locality: 'local', reach: WIN, dMax: DMAX, baseDefault: 2,
  unitBudget: UNIT_BUDGET, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: burinRadial,
  radialCeiling: DMAX,
};
