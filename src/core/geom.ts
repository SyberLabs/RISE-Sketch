/**
 * Geometry helpers on interleaved xy arrays ([x0, y0, x1, y1, ...]).
 * Pure and deterministic: only + - * / sqrt (no transcendental Math.*).
 */
import type { AABB } from './types';

export type XY = ArrayLike<number>;

export const dist = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax, dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
};

/** Polyline arc length. */
export function polyLength(p: XY): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += dist(p[i - 2], p[i - 1], p[i], p[i + 1]);
  return L;
}

/** Resample a polyline at a fixed arc step. Keeps the first point, and the last if > 0.4·step away. */
export function resample(p: XY, step: number): Float64Array {
  const n = p.length >> 1;
  if (n < 2) return Float64Array.from(p as ArrayLike<number>);
  const out: number[] = [p[0], p[1]];
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const ax = p[2 * i - 2], ay = p[2 * i - 1], bx = p[2 * i], by = p[2 * i + 1];
    const d = dist(ax, ay, bx, by);
    if (d < 1e-9) continue;
    let s = step - carry;
    while (s <= d) {
      const t = s / d;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      s += step;
    }
    carry = d - (s - step);
  }
  const lx = p[2 * n - 2], ly = p[2 * n - 1];
  const k = out.length;
  if (dist(out[k - 2], out[k - 1], lx, ly) > step * 0.4) out.push(lx, ly);
  return Float64Array.from(out);
}

/** Chaikin corner cutting, endpoints kept. */
export function chaikin(p: XY, rounds = 1): Float64Array {
  let cur = Float64Array.from(p as ArrayLike<number>);
  for (let r = 0; r < rounds; r++) {
    const n = cur.length >> 1;
    if (n < 3) break;
    const nx = new Float64Array((2 * (n - 1) + 2) * 2);
    let k = 0;
    nx[k++] = cur[0]; nx[k++] = cur[1];
    for (let i = 0; i < n - 1; i++) {
      const ax = cur[2 * i], ay = cur[2 * i + 1], bx = cur[2 * i + 2], by = cur[2 * i + 3];
      nx[k++] = ax * 0.75 + bx * 0.25; nx[k++] = ay * 0.75 + by * 0.25;
      nx[k++] = ax * 0.25 + bx * 0.75; nx[k++] = ay * 0.25 + by * 0.75;
    }
    nx[k++] = cur[2 * n - 2]; nx[k++] = cur[2 * n - 1];
    cur = nx.subarray(0, k).slice();
  }
  return cur;
}

/** Squared distance from point to segment. */
export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/** Ramer-Douglas-Peucker simplification. Returns indices of kept vertices. */
export function rdpIndices(p: XY, eps: number): number[] {
  const n = p.length >> 1;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  const e2 = eps * eps;
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    let best = -1, bd = e2;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(p[2 * i], p[2 * i + 1], p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push(a, best, best, b); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
export function rdp(p: XY, eps: number): Float64Array {
  const idx = rdpIndices(p, eps);
  const out = new Float64Array(idx.length * 2);
  idx.forEach((i, k) => { out[2 * k] = p[2 * i]; out[2 * k + 1] = p[2 * i + 1]; });
  return out;
}

/** Signed area (shoelace); positive = counter-clockwise in y-up, clockwise on screen (y-down). */
export function signedArea(p: XY): number {
  const n = p.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1];
  return a / 2;
}

/** Even-odd point in polygon. */
export function pointInPolygon(x: number, y: number, poly: XY): boolean {
  const n = poly.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Bounding box of an interleaved array; optional padding. */
export function bbox(p: XY, pad = 0, out?: AABB): AABB {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const b = out ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  b.x0 = x0 - pad; b.y0 = y0 - pad; b.x1 = x1 + pad; b.y1 = y1 + pad;
  return b;
}

// ---- AABB helpers
export const emptyBox = (): AABB => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export const isEmptyBox = (b: AABB): boolean => !(b.x1 >= b.x0 && b.y1 >= b.y0);
export function growBox(b: AABB, x: number, y: number, r = 0): void {
  if (x - r < b.x0) b.x0 = x - r; if (x + r > b.x1) b.x1 = x + r;
  if (y - r < b.y0) b.y0 = y - r; if (y + r > b.y1) b.y1 = y + r;
}
export const unionBox = (a: AABB, b: AABB): AABB =>
  ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
export const boxesOverlap = (a: AABB, b: AABB): boolean => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
export const boxContains = (b: AABB, x: number, y: number): boolean => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
export const padBox = (b: AABB, r: number): AABB => ({ x0: b.x0 - r, y0: b.y0 - r, x1: b.x1 + r, y1: b.y1 + r });
export const translateBox = (b: AABB, dx: number, dy: number): AABB => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });
export const boxW = (b: AABB): number => b.x1 - b.x0;
export const boxH = (b: AABB): number => b.y1 - b.y0;

/** Transform an AABB by an affine matrix [a b c d e f]; returns the bounding box of the 4 corners. */
export function transformBox(b: AABB, m: ArrayLike<number>): AABB {
  const out = emptyBox();
  const cs = [b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1];
  for (let i = 0; i < 8; i += 2) {
    const x = cs[i], y = cs[i + 1];
    growBox(out, m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  }
  return out;
}
