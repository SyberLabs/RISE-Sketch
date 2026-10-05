/**
 * Drift v1 (DESIGN §2.3.6): an attractor wake. Each station along the stroke releases a
 * filament that rides a divergence-free curl-noise field (the demo's sum-of-sines field
 * pooled filaments into clumps; curl noise cannot).
 *
 *   σ_0 = s0 + 2.5,  σ_{m+1} = σ_m + 5·(1 + c(σ_m)) sp       resumable chain
 *   n_max = round(150·(0.35 + 0.9p)·(1 − 0.5c)) steps of 1.7 sp   (cooked once, at the ceiling)
 *   n(d)  = n_max·N(d)/150,  N(d) = 18·min(d, 1) + 26.4·max(0, d − 1)   (N(6) = 150)
 *   dir_k = normalize(F(x_k) + 0.8·smoothstep(0.3, 2, v_n)·0.95^k·T),  then jitter ±0.14 rad
 *   width = 0.55·w(σ)·E_in(σ)·(1 − k/n)²    recomputed whenever the filament is truncated
 *
 * The field's lattice is λ/2 = 140 sp at the commit zoom (λ_doc = 280/z), so zooming out
 * gives broad currents and zooming in fine eddies. Each filament is split into thirds of
 * its drawn steps with depth tones 0.2 / 0.5 / 0.8 (dBucket 1, 2, 3): the wake deepens in
 * colour as it fades. The thirds share their joints exactly, so they weld at tessellation.
 *
 * Decisions:
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

/** Steps drawn at depth d for a filament of n_max steps (fractional). */
export function drawnSteps(nmax: number, d: number): number {
  const D = clamp(d, 0, 6);
  const nd = (nmax * (18 * Math.min(D, 1) + 26.4 * Math.max(0, D - 1))) / NMAX;
  return nd < nmax ? nd : nmax;
}

const pos = new Float64Array(2), tan = new Float64Array(2), F = new Float64Array(2);

/** Walk one filament from (x, y) with momentum direction (tx, ty) into branch 0 of g. */
function walk(cx: FormCx, g: UnitGeom, x: number, y: number, tx: number, ty: number, mw: number, nmax: number, addr: number): void {
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
}

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

function emitAt(g: UnitGeom, o: number, k: number, nd: number, w0: number, floor: number, out: Sink): void {
  const i = Math.floor(k), t = k - i;
  let x = g.px[o + i], y = g.py[o + i];
  if (t > 0) { x += (g.px[o + i + 1] - x) * t; y += (g.py[o + i + 1] - y) * t; }
  const u = 1 - k / nd, w = w0 * u * u;
  out.pt(x, y, w > floor ? w : floor);
}

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
    const sp = cx.sp, at = cx.at, s = rec.s;
    at.pos(s, pos); at.tangent(s, tan);
    const p = at.at(sp.p, s), c = at.at(sp.c, s);
    g.w = at.at(sp.w, s); g.p = p; g.c = c;
    const nmax = nmaxOf(p, c);
    g.k = nmax;
    walk(cx, g, pos[0], pos[1], tan[0], tan[1], momentum(at.at(sp.vn, s)), nmax, rec.j);
    g.ceil = 6;
  },

  count(g: UnitGeom, D: number): number { return filamentCount(drawnSteps(g.k, D)); },

  emit(cx: FormCx, rec: ChainRecord, g: UnitGeom, D: number, eIn: number, out: Sink): number {
    return emitFilament(g, 0, drawnSteps(g.k, D), WF * g.w * eIn, cx.z, rec.s, rec.j, out);
  },
};

const rg = new UnitGeom();

/** Radial seed: 24 filaments at 15°·i plus jitter, thrown radially outward. */
function driftRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const D = clamp(depth, 0, 6);
  if (!(D > 0)) return 0;
  const r = cx.r, nmax = nmaxOf(seed.p, seed.c), nd = drawnSteps(nmax, D);
  rg.reset(); rg.p = seed.p; rg.c = seed.c;
  for (let i = 0; i < RADIAL_N; i++) {
    const addr = (RADIAL_ID + 64 + i) | 0;
    const a = RADIAL_STEP * i + (rnd(r.seed, Ch.Angle, addr) - 0.5) * RADIAL_STEP;
    walk(cx, rg, seed.x, seed.y, dcos(a), dsin(a), RADIAL_THROW, nmax, addr);
  }
  for (let b = 0; b < rg.nB; b++) emitFilament(rg, b, nd, WF * seed.w, cx.z, cx.s0, 0, out);
  return D;
}

/** Drift v1. */
export const drift: FormOps = {
  id: 'drift', v: 1, locality: 'local', reach: 12, dMax: 6, baseDefault: 2,
  unitBudget: NMAX + 1, strokeBudget: STROKE_BUDGET,
  trunkStyle: (): TrunkStyle => ({ w: 0.8, alpha: 1 }),
  trunk: null,
  trunkReach: 0,
  trunkDepthReach: -1,
  chain,
  radial: driftRadial,
  radialCeiling: 6,
};
