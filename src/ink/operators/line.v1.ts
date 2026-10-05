/**
 * Line v1 (DESIGN §2.3.3): the bare nib and the demo's Roughen merged into one Form.
 *
 * Depth 0 is exactly the spine ribbon (stations only, no wobble). Above 0 an offset
 * field along the smoothed normal turns the line into a weathered coastline, then
 * crackle. Unlike the demo's recursive midpoint displacement (which needed the whole
 * stroke and re-shuffled when it grew), the field is a sum of hat functions on absolute
 * nested lattices, so every point is a pure function of the spine within 36 sp:
 *
 *   h_k     = 24·2^(1−k) sp, k = 1..5          node spacing per level
 *   s_{k,i} = (i + ½)·h_k                       absolute node arcs
 *   D_{k,i} = h_1·A·0.62^(k−1)·[(2r − 1)(0.4 + 1.2p) + 0.7·asym]·W_k     (at the node)
 *   W_k     = clamp(d(s_node) − k + 1, 0, 1)    fractional depth contract
 *   off(s)  = Σ_k Σ_i D_{k,i}·hat((s − s_{k,i})/h_k)
 *   point   = spine(s) + off(s)·pin(s)·n(s)
 *
 * Output points are the stations plus lattice points at absolute multiples of δ(s)
 * (2 sp up to depth 3, 1 sp at 4, 0.5 sp at 5; none where d = 0). The lattices nest, so a
 * re-cooked block splices exactly against its neighbours.
 *
 * Decisions:
 *  - Level amplitude decays 0.62 per level from h_1 (spec text: h_k·0.62^(k−1)). Read
 *    literally, the amplitude falls ×0.31 per level, so level 5 is < 0.05 sp (invisible)
 *    and depths 3–5 look identical, contradicting "weathered coastline → crackle" and the
 *    spec's own note that level-6 hats would alias at the 0.5 sp lattice. With ×0.62 per
 *    level the line is a gentle undulation at d = 1, a coastline at 3 and crackles at 5
 *    (a fractal dimension of about 1.3); fast strokes (A → 0.42) throw lightning.
 *  - asym "sign(κ̄)" is softened to clamp(κ̄/0.004, −1, 1) (0.004 rad/sp is the spec's own
 *    "straight run" threshold), so near-straight runs do not flip bumps from node to node.
 *    Bumps erode toward the outside of curves: asym = −0.35·that (κ > 0 bends toward +n).
 *  - Pen tilt: tiltVec = unit(azimuth); its weight crossfades in over cos(alt) 0.1–0.3 so
 *    an upright pen (or a device without tilt) uses the curvature rule.
 *  - pin(s): off is multiplied by smoothstep(0, 12, s − s0) at a closed or cut head and by
 *    smoothstep(0, 12, L − s) at a closed or cut tail (finished spines only), so welded
 *    seams and split joins meet the spine exactly. The live provisional tail fades the
 *    offset in over `tipFade` sp behind the nib (the nib itself stays clean; crackle
 *    develops behind it), replacing the spec's 160 ms morph with a spatial one.
 *  - Line keeps dBucket = 0 (it has no generations); its trunk tone is the pressure bucket.
 */
import type { RecipeCore } from '../../core/types';
import { PolyKind } from '../../core/types';
import { rnd, Ch, dcos, dsin, PI } from '../../core/det';
import { clamp, smoothstep } from '../../core/num';
import { chiselAngle, drySplit } from '../nibs';
import type { FormCx, FormOps, RadialSeed, Sink, TrunkPts, TrunkStyle } from './types';
import { stationTrunk, toneOf } from './types';

/** Number of offset levels (depth range 0–5). */
const LEVELS = 5;
/** Node spacing per level (sp), index k = 1..5. */
const H = [0, 24, 12, 6, 3, 1.5];
/** 0.62^(k−1). */
const DECAY = [0, 1, 0.62, 0.3844, 0.238328, 0.14776336];
/** Finest lattice step (sp). */
const FINE = 0.5;
/** Lattice points this close (sp) to a station are dropped (the station is kept). */
const NEAR = 0.05;
/** Arc (sp) of the closed / cut pins. */
const PIN = 12;
/** κ̄ averaging half-window (sp). */
const KBAR = 12;
/** Rays of a radial Line seed, their roughness, level-1 amplitude scale (sp) and rng address base. */
const RAYS = 6, RAY_A = 0.3, RAY_SCALE = 6, RAY_RNG = 16;
/** Rng address of a radial seed's rotation. */
export const RADIAL_ID = 0x7fff0000;

const DEG60 = PI / 3;

/** Lattice step at depth dc (sp), 0 when there is no lattice. */
export function latticeStep(dc: number): number {
  if (!(dc > 0)) return 0;
  const c = Math.ceil(dc);
  return c <= 3 ? 2 : c === 4 ? 1 : 0.5;
}

/** Shortest interpolation between two edge angles (mod π). */
function lerpEdge(a: number, b: number, t: number): number {
  let d = (b - a) % PI;
  if (d > PI / 2) d -= PI; else if (d < -PI / 2) d += PI;
  return a + d * t;
}

/** Per-block node evaluation state (module scratch; operators run single-threaded). */
const nodeI = new Float64Array(LEVELS + 1);
const nodeA = new Float64Array(LEVELS + 1);
const nodeB = new Float64Array(LEVELS + 1);
const tv = new Float64Array(2), nv = new Float64Array(2);

/** Asymmetry at arc s: pen tilt toward the lean, else erosion toward the outside of curves. */
function asymAt(cx: FormCx, s: number): number {
  const sp = cx.sp, at = cx.at;
  const kb = at.mean(sp.k, s, KBAR);
  const ca = -0.35 * clamp(kb / 0.004, -1, 1);
  if (cx.r.device !== 'pen') return ca;
  const alt = at.at(sp.alt, s);
  const wt = smoothstep(0.1, 0.3, dcos(alt));
  if (!(wt > 0)) return ca;
  const az = at.angle(sp.az, s);
  at.normal(s, nv);
  const ta = clamp(dcos(az) * nv[0] + dsin(az) * nv[1], -0.6, 0.6);
  return wt * ta + (1 - wt) * ca;
}

/** D_{k,i} in sp. */
function node(cx: FormCx, k: number, i: number, dMax: number): number {
  const sn = (i + 0.5) * H[k];
  const dn = clamp(cx.depth.at(sn), 0, dMax);
  const W = clamp(dn - k + 1, 0, 1);
  if (!(W > 0)) return 0;
  const sp = cx.sp, at = cx.at;
  const A = 0.10 + 0.32 * smoothstep(0.6, 2.4, at.at(sp.vn, sn));
  const p = at.at(sp.p, sn);
  const r = rnd(cx.r.seed, Ch.Geometry, k, i);
  return H[1] * A * DECAY[k] * ((2 * r - 1) * (0.4 + 1.2 * p) + 0.7 * asymAt(cx, sn)) * W;
}

/** off(s) in sp; nodes are cached per level while arcs increase. */
function offsetAt(cx: FormCx, s: number, dMax: number): number {
  let off = 0;
  for (let k = 1; k <= LEVELS; k++) {
    const u = s / H[k] - 0.5, i = Math.floor(u), t = u - i;
    if (nodeI[k] !== i) {
      if (nodeI[k] === i - 1) nodeA[k] = nodeB[k];
      else nodeA[k] = node(cx, k, i, dMax);
      nodeB[k] = node(cx, k, i + 1, dMax);
      nodeI[k] = i;
    }
    off += nodeA[k] + (nodeB[k] - nodeA[k]) * t;
  }
  return off;
}

function pinAt(cx: FormCx, s: number): number {
  let f = 1;
  if (cx.closed || cx.cut & 1) f *= smoothstep(0, PIN, s - cx.s0);
  if (cx.final && (cx.closed || cx.cut & 2)) f *= smoothstep(0, PIN, cx.L - s);
  if (cx.tipFade > 0) f *= smoothstep(0, cx.tipFade, cx.L - s);
  return f;
}

/** Line trunk points of stations [i0, i1]: stations plus nested lattice points, displaced. */
function lineTrunk(cx: FormCx, i0: number, i1: number, T: TrunkPts): void {
  T.reset();
  const dMax = line.dMax;
  if (cx.depth.base <= 0 && cx.depth.maxPool() <= 0) { stationTrunk(cx, i0, i1, 1, T); return; }
  for (let k = 1; k <= LEVELS; k++) nodeI[k] = NaN;
  const sp = cx.sp, r = cx.r, z = cx.z, nib = r.stroke.nib, dev = r.device, chisel = nib === 'chisel';
  const S = sp.s;
  for (let i = i0; i <= i1; i++) {
    // the station itself
    const si = S[i];
    const offS = offsetAt(cx, si, dMax) * pinAt(cx, si) / z;
    const angI = chisel ? chiselAngle(sp.alt[i], sp.az[i]) - r.rot : 0;
    T.push(sp.x[i] + sp.nx[i] * offS, sp.y[i] + sp.ny[i] * offS, sp.w[i] * cx.trunkE(si),
      sp.nx[i], sp.ny[i], drySplit(nib, sp.vn[i], sp.p[i], dev), angI, si, toneOf(sp.p[i], 0));
    if (i === i1) break;
    // lattice points strictly inside (s_i, s_{i+1})
    const sj = S[i + 1];
    const tone = toneOf(sp.p[i], 0);
    const angJ = chisel ? chiselAngle(sp.alt[i + 1], sp.az[i + 1]) - r.rot : 0;
    const m1 = Math.ceil(sj / FINE) - 1;
    for (let m = Math.floor(si / FINE) + 1; m <= m1; m++) {
      const s = m * FINE;
      if (s - si < NEAR || sj - s < NEAR) continue;
      const dc = clamp(cx.depth.at(s), 0, dMax);
      const step = latticeStep(dc);
      if (step === 0) continue;
      const q = step / FINE;
      if (((m % q) + q) % q !== 0) continue;
      const t = (s - si) / (sj - si);
      const bx = sp.x[i] + (sp.x[i + 1] - sp.x[i]) * t, by = sp.y[i] + (sp.y[i + 1] - sp.y[i]) * t;
      cx.at.normal(s, tv);
      const off = offsetAt(cx, s, dMax) * pinAt(cx, s) / z;
      const w = (sp.w[i] + (sp.w[i + 1] - sp.w[i]) * t) * cx.trunkE(s);
      const vn = sp.vn[i] + (sp.vn[i + 1] - sp.vn[i]) * t, p = sp.p[i] + (sp.p[i + 1] - sp.p[i]) * t;
      T.push(bx + tv[0] * off, by + tv[1] * off, w, tv[0], tv[1], drySplit(nib, vn, p, dev),
        chisel ? lerpEdge(angI, angJ, t) : 0, s, tone);
    }
  }
}

/** Offset (sp) along a radial ray at arc t, for ray `ray` at depth d. */
function rayOffset(seed: number, ray: number, t: number, p: number, d: number): number {
  let off = 0;
  for (let k = 1; k <= LEVELS; k++) {
    const W = clamp(d - k + 1, 0, 1);
    if (!(W > 0)) break;
    const u = t / H[k] - 0.5, i = Math.floor(u), f = u - i;
    const ra = rnd(seed, Ch.Geometry, k + RAY_RNG * (ray + 1), i), rb = rnd(seed, Ch.Geometry, k + RAY_RNG * (ray + 1), i + 1);
    const amp = RAY_SCALE * RAY_A * DECAY[k] * (0.4 + 1.2 * p) * W;
    off += amp * ((2 * ra - 1) + ((2 * rb - 1) - (2 * ra - 1)) * f);
  }
  return off;
}

/**
 * Radial Line seed above depth 0: 6 rays at 60°·i + 60°·r, each (8 + 1.2S)(0.5 + p) sp
 * long, crackled with Line's field. Decision: rays extend with min(d, 1) and taper to the
 * tip, so the seed is continuous in depth from the bare dot at d = 0.
 */
function lineRadial(cx: FormCx, seed: RadialSeed, depth: number, out: Sink): number {
  const d = clamp(depth, 0, line.dMax);
  if (!(d > 0)) return 0;
  const r = cx.r, z = cx.z, S = r.stroke.size, p = seed.p;
  const len = (8 + 1.2 * S) * (0.5 + p);
  const drawn = len * Math.min(1, d);
  const step = latticeStep(d);
  const wsp = seed.w * z;
  const rot0 = DEG60 * rnd(r.seed, Ch.Angle, RADIAL_ID);
  const tone = toneOf(p, 0);
  for (let ray = 0; ray < RAYS; ray++) {
    const th = DEG60 * ray + rot0, ux = dcos(th), uy = dsin(th);
    out.begin(PolyKind.Ribbon, 0, 1, tone, cx.s0, 0, 1);
    for (let t = 0; ; t += step) {
      const tt = t < drawn ? t : drawn;
      const off = rayOffset(r.seed, ray, tt, p, d) * smoothstep(0, 3, tt);
      const w = Math.max(0.35, wsp * 0.75 * (1 - tt / len));
      out.pt(seed.x + (ux * tt - uy * off) / z, seed.y + (uy * tt + ux * off) / z, w / z);
      if (tt >= drawn) break;
    }
    out.end();
  }
  return d;
}

/** Line v1. */
export const line: FormOps = {
  id: 'line', v: 1, locality: 'local', reach: 36, dMax: 5, baseDefault: 0,
  unitBudget: 0, strokeBudget: 0,
  trunkStyle: (_r: RecipeCore): TrunkStyle => ({ w: 1, alpha: 1 }),
  trunk: lineTrunk,
  trunkReach: 36,
  trunkDepthReach: 24,
  chain: null,
  radial: lineRadial,
  radialCeiling: 5,
};
