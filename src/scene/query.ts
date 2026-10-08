/**
 * Geometric queries behind Scene.hit / sweep / lasso / lineage (DESIGN §3.4, §2.4.2).
 *
 * A `Track` is a uniform read-only view of a stroke's centreline: the cooked spine
 * (stations every 2.4 sp, untapered width per station) when ink-forms' `spineOf` is
 * available, otherwise the raw sample rows with the nominal capsule width
 * 0.7·S / z. Coordinates stay relative to the recipe origin; probes are moved into
 * that frame once per stroke (Float64), so far-from-origin ink keeps its precision.
 *
 * Hit rule: the spine capsule (radius w/2 around the centreline), then cooked polys
 * whose alpha ≥ minAlpha (ribbon/chisel polys as capsules of their per-point width,
 * dots as discs). Lasso rule: ≥ 50% of the spine stations inside the polygon.
 *
 * Everything here is pure and allocation-free; the scene owns the scratch Track.
 */
import { S, PolyKind } from '../core/types';
import type { AABB, Cooked, Spine, StrokeRecipe } from '../core/types';
import { segDist2 } from '../core/geom';
import { placedSamples } from '../ink/symmetry';

/** Capsule width of a recipe without a cook, doc units (matches occupancy); 0 when z or size is unusable. */
export const nominalWidth = (r: StrokeRecipe): number => {
  const w = (0.7 * r.stroke.size) / r.z;
  return w > 0 && w < Infinity ? w : 0;
};

/** Read-only centreline view. Point i is (xs[xo + i·stride], ys[yo + i·stride]) relative to (ox, oy). */
export interface Track {
  n: number;
  xs: ArrayLike<number>; ys: ArrayLike<number>;
  xo: number; yo: number; stride: number;
  /** Per-point full width (doc), or null to use `wConst`. */
  ws: ArrayLike<number> | null;
  wConst: number;
  ox: number; oy: number;
}

const EMPTY = new Float32Array(0);

/** A blank Track to reuse as scratch. */
export function createTrack(): Track {
  return { n: 0, xs: EMPTY, ys: EMPTY, xo: 0, yo: 0, stride: 1, ws: null, wConst: 0, ox: 0, oy: 0 };
}

/** Point `into` at the stroke's spine (if `sp` is given and non-empty) or its raw samples. */
export function trackOf(r: StrokeRecipe, sp: Readonly<Spine> | null, into: Track): Track {
  into.ox = r.origin[0];
  into.oy = r.origin[1];
  into.wConst = nominalWidth(r);
  if (sp && sp.n > 0) {
    into.n = sp.n; into.xs = sp.x; into.ys = sp.y; into.xo = 0; into.yo = 0; into.stride = 1;
    into.ws = sp.w;
  } else {
    const smp = placedSamples(r);
    into.n = (smp.length / S.STRIDE) | 0;
    into.xs = smp; into.ys = smp; into.xo = S.X; into.yo = S.Y; into.stride = S.STRIDE;
    into.ws = null;
  }
  return into;
}

const halfW = (t: Track, i: number): number => {
  const w = t.ws ? t.ws[i] : t.wConst;
  return w > 0 ? 0.5 * w : 0;
};

/** Squared distance between segments AB and CD (0 when they cross). */
export function segSegDist2(ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number): number {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  let m = segDist2(ax, ay, cx, cy, dx, dy);
  let v = segDist2(bx, by, cx, cy, dx, dy); if (v < m) m = v;
  v = segDist2(cx, cy, ax, ay, bx, by); if (v < m) m = v;
  v = segDist2(dx, dy, ax, ay, bx, by); if (v < m) m = v;
  return m;
}

/** Does the capsule chain of `t` come within `r` of absolute point (px, py)? */
export function trackHitsPoint(t: Track, px: number, py: number, r: number): boolean {
  const n = t.n;
  if (n === 0) return false;
  const qx = px - t.ox, qy = py - t.oy;
  const { xs, ys, xo, yo, stride } = t;
  if (n === 1) {
    const dx = xs[xo] - qx, dy = ys[yo] - qy, rr = r + halfW(t, 0);
    return dx * dx + dy * dy <= rr * rr;
  }
  let ax = xs[xo], ay = ys[yo], ha = halfW(t, 0);
  for (let i = 1; i < n; i++) {
    const bx = xs[xo + i * stride], by = ys[yo + i * stride], hb = halfW(t, i);
    const rr = r + (ha > hb ? ha : hb);
    if (segDist2(qx, qy, ax, ay, bx, by) <= rr * rr) return true;
    ax = bx; ay = by; ha = hb;
  }
  return false;
}

/** Does the capsule chain of `t` come within `r` of the absolute segment AB? */
export function trackHitsSegment(t: Track, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const n = t.n;
  if (n === 0) return false;
  const qax = ax - t.ox, qay = ay - t.oy, qbx = bx - t.ox, qby = by - t.oy;
  const { xs, ys, xo, yo, stride } = t;
  if (n === 1) {
    const rr = r + halfW(t, 0);
    return segDist2(xs[xo], ys[yo], qax, qay, qbx, qby) <= rr * rr;
  }
  let px = xs[xo], py = ys[yo], hp = halfW(t, 0);
  for (let i = 1; i < n; i++) {
    const cx = xs[xo + i * stride], cy = ys[yo + i * stride], hc = halfW(t, i);
    const rr = r + (hp > hc ? hp : hc);
    if (segSegDist2(qax, qay, qbx, qby, px, py, cx, cy) <= rr * rr) return true;
    px = cx; py = cy; hp = hc;
  }
  return false;
}

/** Distance from absolute (px, py) to the centreline of `t` (Infinity when empty). */
export function trackDistance(t: Track, px: number, py: number): number {
  const n = t.n;
  if (n === 0) return Infinity;
  const qx = px - t.ox, qy = py - t.oy;
  const { xs, ys, xo, yo, stride } = t;
  let ax = xs[xo], ay = ys[yo];
  let best = (ax - qx) * (ax - qx) + (ay - qy) * (ay - qy);
  for (let i = 1; i < n; i++) {
    const bx = xs[xo + i * stride], by = ys[yo + i * stride];
    const d = segDist2(qx, qy, ax, ay, bx, by);
    if (d < best) best = d;
    ax = bx; ay = by;
  }
  return Math.sqrt(best);
}

/**
 * Fraction of the track's points inside the absolute polygon `poly` (interleaved xy,
 * even-odd rule). Stops early once the 50% verdict is certain when `early` is set.
 */
export function trackInside(t: Track, poly: ArrayLike<number>, early = false): number {
  const n = t.n;
  const m = poly.length >> 1;
  if (n === 0 || m < 3) return 0;
  const { xs, ys, xo, yo, stride, ox, oy } = t;
  let inside = 0, outside = 0;
  const half = n * 0.5;
  for (let i = 0; i < n; i++) {
    const x = ox + xs[xo + i * stride], y = oy + ys[yo + i * stride];
    let c = false;
    for (let a = 0, b = m - 1; a < m; b = a++) {
      const xa = poly[2 * a], ya = poly[2 * a + 1], xb = poly[2 * b], yb = poly[2 * b + 1];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c;
    }
    if (c) inside++; else outside++;
    if (early && (inside >= half || outside > half)) return inside >= half ? 1 : 0;
  }
  return inside / n;
}

/** Point-in-box with padding, box given as 4 floats at `o` in `b`. */
const inPolyBox = (b: Float32Array, o: number, x: number, y: number, pad: number): boolean =>
  x >= b[o] - pad && x <= b[o + 2] + pad && y >= b[o + 1] - pad && y <= b[o + 3] + pad;

/**
 * The cooked poly of `c` (alpha ≥ minAlpha) whose ink comes within `r` of absolute
 * (px, py), choosing the one whose outline is nearest (smallest distance − w/2; ties
 * go to the later poly, i.e. the deeper generation). -1 if none. (ox, oy) is the
 * recipe origin. With `any`, returns the first poly found (plain hit tests).
 * Used by Scene.hit and by Alt-click sampling (the resolved colour of that poly).
 */
export function hitPoly(c: Cooked, ox: number, oy: number, px: number, py: number, r: number, minAlpha: number,
  any = false): number {
  const qx = px - ox, qy = py - oy;
  const pts = c.pts;
  let best = -1, bestGap = Infinity;
  for (let i = c.nPolys - 1; i >= 0; i--) {
    if (!(c.alpha[i] >= minAlpha)) continue;
    if (!inPolyBox(c.box, 4 * i, qx, qy, r)) continue;
    const s = c.start[i], cnt = c.count[i];
    if (cnt === 0) continue;
    let gap = Infinity;
    if (cnt === 1 || c.kind[i] === PolyKind.Dot) {
      const k = 4 * s, dx = pts[k] - qx, dy = pts[k + 1] - qy;
      gap = Math.sqrt(dx * dx + dy * dy) - 0.5 * pts[k + 2];
    } else {
      let k = 4 * s;
      let ax = pts[k], ay = pts[k + 1], wa = pts[k + 2];
      for (let j = 1; j < cnt; j++) {
        k += 4;
        const bx = pts[k], by = pts[k + 1], wb = pts[k + 2];
        const hw = 0.5 * (wa > wb ? wa : wb), rr = r + hw;
        const d2 = segDist2(qx, qy, ax, ay, bx, by);
        if (d2 <= rr * rr) {
          const g = Math.sqrt(d2) - hw;
          if (g < gap) gap = g;
          if (any) break;
        }
        ax = bx; ay = by; wa = wb;
      }
    }
    if (gap <= r && gap < bestGap) {
      if (any) return i;
      best = i; bestGap = gap;
    }
  }
  return best;
}

/** Does any cooked poly of `c` with alpha ≥ minAlpha come within `r` of absolute segment AB? */
export function polysHitSegment(c: Cooked, ox: number, oy: number,
  ax: number, ay: number, bx: number, by: number, r: number, minAlpha: number): boolean {
  const qax = ax - ox, qay = ay - oy, qbx = bx - ox, qby = by - oy;
  const sx0 = (qax < qbx ? qax : qbx) - r, sx1 = (qax > qbx ? qax : qbx) + r;
  const sy0 = (qay < qby ? qay : qby) - r, sy1 = (qay > qby ? qay : qby) + r;
  const pts = c.pts, box = c.box;
  for (let i = 0; i < c.nPolys; i++) {
    if (!(c.alpha[i] >= minAlpha)) continue;
    const o = 4 * i;
    if (box[o] > sx1 || box[o + 2] < sx0 || box[o + 1] > sy1 || box[o + 3] < sy0) continue;
    const s = c.start[i], cnt = c.count[i];
    if (cnt === 0) continue;
    if (cnt === 1 || c.kind[i] === PolyKind.Dot) {
      const k = 4 * s, rr = r + 0.5 * pts[k + 2];
      if (segDist2(pts[k], pts[k + 1], qax, qay, qbx, qby) <= rr * rr) return true;
      continue;
    }
    let k = 4 * s;
    let px = pts[k], py = pts[k + 1], wp = pts[k + 2];
    for (let j = 1; j < cnt; j++) {
      k += 4;
      const cx = pts[k], cy = pts[k + 1], wc = pts[k + 2];
      const rr = r + 0.5 * (wp > wc ? wp : wc);
      if (segSegDist2(qax, qay, qbx, qby, px, py, cx, cy) <= rr * rr) return true;
      px = cx; py = cy; wp = wc;
    }
  }
  return false;
}

/** Distance from (x, y) to box b (0 inside). */
export function boxDistance(b: AABB, x: number, y: number): number {
  const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0;
  const dy = y < b.y0 ? b.y0 - y : y > b.y1 ? y - b.y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Wall-clock lift time of a recipe: `created` (pen-down, Date.now) + the last sample's t. */
export function liftTime(r: StrokeRecipe): number {
  const n = (r.samples.length / S.STRIDE) | 0;
  const t = n > 0 ? r.samples[(n - 1) * S.STRIDE + S.T] : 0;
  return r.created + (t === t ? t : 0);
}

/** Conservative doc-space box of an uncooked recipe: sample bbox padded by (64 + 3·S)/z (DESIGN BUILD §8). */
export function conservativeBox(r: StrokeRecipe, out: AABB): AABB {
  const smp = placedSamples(r);
  const n = (smp.length / S.STRIDE) | 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = smp[i * S.STRIDE + S.X], y = smp[i * S.STRIDE + S.Y];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!(x0 <= x1 && y0 <= y1)) { x0 = x1 = 0; y0 = y1 = 0; }
  const z = r.z > 0 ? r.z : 1;
  const pad = (64 + 3 * (r.stroke.size > 0 ? r.stroke.size : 0)) / z;
  out.x0 = r.origin[0] + x0 - pad; out.y0 = r.origin[1] + y0 - pad;
  out.x1 = r.origin[0] + x1 + pad; out.y1 = r.origin[1] + y1 + pad;
  return out;
}

/** A box usable by the index: finite and non-inverted. */
export const validBox = (b: AABB | null | undefined): b is AABB =>
  !!b && Number.isFinite(b.x0) && Number.isFinite(b.y0) && Number.isFinite(b.x1) && Number.isFinite(b.y1) &&
  b.x0 <= b.x1 && b.y0 <= b.y1;
