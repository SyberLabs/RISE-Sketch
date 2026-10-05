/**
 * Signals: what the hand did, measured from sample rows and spine stations
 * (DESIGN §2.2.2). Per-sample interpolation, per-station speed windows and
 * frames (curvature + smoothed normal), per-stroke entry/exit speed, end dwell
 * and net turning. Pure functions over typed arrays; no allocation in the
 * per-station paths.
 */
import type { Device, RecipeView } from '../core/types';
import { S } from '../core/types';
import { angleDiff, clamp } from '../core/num';
import { datan2 } from '../core/det';

/** Sample rows (S.STRIDE) and their count. */
export interface Rows { data: Float32Array; n: number }

/** The sample rows of a recipe or a draft (draft rows grow in place). */
export function rowsOf(r: RecipeView): Rows {
  const s = r.samples;
  return s instanceof Float32Array ? { data: s, n: Math.floor(s.length / S.STRIDE) } : s;
}

/** Whether pressure is synthesised from speed: the stored P of the first row is NaN (mouse, most touch). */
export function isSynthPressure(d: Float32Array, n: number): boolean {
  return n === 0 || !(d[S.P] === d[S.P]);
}

/**
 * A row is intact when its position and time are finite. Corrupt rows (a bad file, a
 * failed conversion) are skipped everywhere: by the filter, by every per-station
 * interpolation and by the per-stroke measures, so they can never poison a stroke.
 */
export function rowOk(d: Float32Array, i: number): boolean {
  const o = i * S.STRIDE, x = d[o + S.X], y = d[o + S.Y], t = d[o + S.T];
  return x - x === 0 && y - y === 0 && t - t === 0;
}
/** Index of the first intact row, or -1. */
export function firstOk(d: Float32Array, n: number): number {
  for (let i = 0; i < n; i++) if (rowOk(d, i)) return i;
  return -1;
}
/** Index of the last intact row, or -1. */
export function lastOk(d: Float32Array, n: number): number {
  for (let i = n - 1; i >= 0; i--) if (rowOk(d, i)) return i;
  return -1;
}

/** Scratch result of `bracket` (single-threaded, never retained). */
const br = { lo: 0, hi: 0, f: 0 };

/**
 * Bracket fractional row q (clamped to the rows) between the nearest intact rows
 * lo ≤ q ≤ hi, with f the fraction from lo to hi (lo == hi when q sits on an intact row
 * or beyond the intact ones). On intact data this is ⌊q⌋, ⌊q⌋ + 1 and q − ⌊q⌋ exactly.
 * False when no row is intact.
 */
function bracket(d: Float32Array, n: number, q: number): boolean {
  let lo = q > 0 ? Math.floor(q) : 0;
  if (lo > n - 1) lo = n - 1;
  let hi = q > lo && lo < n - 1 ? lo + 1 : lo;
  while (lo >= 0 && !rowOk(d, lo)) lo--;
  while (hi < n && !rowOk(d, hi)) hi++;
  if (lo < 0) { if (hi >= n) return false; lo = hi; }
  else if (hi >= n) hi = lo;
  br.lo = lo; br.hi = hi; br.f = hi > lo ? (q - lo) / (hi - lo) : 0;
  return true;
}

/** Linear interpolation of channel `ch` at fractional row index q (clamped; corrupt rows skipped). */
export function lerpRow(d: Float32Array, n: number, q: number, ch: S): number {
  if (n <= 0 || !bracket(d, n, q)) return NaN;
  const a = d[br.lo * S.STRIDE + ch];
  if (br.hi === br.lo) return a;
  const b = d[br.hi * S.STRIDE + ch];
  return a + (b - a) * br.f;
}

/** Azimuth at q, interpolated along the shorter way round (corrupt rows skipped). */
export function azAt(d: Float32Array, n: number, q: number): number {
  if (n <= 0 || !bracket(d, n, q)) return 0;
  const a = d[br.lo * S.STRIDE + S.AZ];
  if (br.hi === br.lo) return a === a ? a : 0;
  const b = d[br.hi * S.STRIDE + S.AZ];
  if (!(a === a)) return b === b ? b : 0;
  if (!(b === b)) return a;
  return a + angleDiff(a, b) * br.f;
}

/**
 * Raw pressure at q (corrupt rows skipped). A NaN pressure is bridged from its finite
 * neighbour, else from the last finite intact row before it (a pure function of rows
 * ≤ ⌈q⌉), else `fallback`.
 */
export function rawPressureAt(d: Float32Array, n: number, q: number, fallback: number): number {
  if (n <= 0 || !bracket(d, n, q)) return fallback;
  const lo = br.lo, hi = br.hi;
  const a = d[lo * S.STRIDE + S.P], b = hi > lo ? d[hi * S.STRIDE + S.P] : a;
  if (a === a && b === b) return hi > lo ? a + (b - a) * br.f : a;
  if (a === a) return a;
  if (b === b) return b;
  for (let j = lo - 1; j >= 0; j--) {
    const v = d[j * S.STRIDE + S.P];
    if (v === v && rowOk(d, j)) return v;
  }
  return fallback;
}

/** Index of the last row with t ≤ time (binary search; -1 if none). */
export function rowAtTime(d: Float32Array, n: number, time: number): number {
  let lo = 0, hi = n - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (d[m * S.STRIDE + S.T] <= time) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

/** Fractional row index at a time (clamped to the rows). */
export function qAtTime(d: Float32Array, n: number, time: number): number {
  if (n <= 0) return 0;
  const i = rowAtTime(d, n, time);
  if (i < 0) return 0;
  if (i >= n - 1) return n - 1;
  const t0 = d[i * S.STRIDE + S.T], t1 = d[(i + 1) * S.STRIDE + S.T];
  return t1 > t0 ? i + clamp((time - t0) / (t1 - t0), 0, 1) : i;
}

/**
 * Mean speed (sp/ms) of the intact raw rows whose t lies in [tA, tB]: their path
 * length over their elapsed time. With `chord`, the mean VELOCITY instead: the net
 * displacement from the first to the last of those rows over the same time, which
 * counts sensor noise once rather than once per sample. 0 with fewer than two rows or
 * no elapsed time.
 */
export function windowSpeed(d: Float32Array, n: number, z: number, tA: number, tB: number, chord = false): number {
  let first = -1, last = -1, len = 0, px = 0, py = 0, fx = 0, fy = 0;
  for (let i = Math.max(0, rowAtTime(d, n, tA)); i < n; i++) {
    if (!rowOk(d, i)) continue;
    const o = i * S.STRIDE, t = d[o + S.T];
    if (t < tA) continue;
    if (t > tB) break;
    const x = d[o + S.X] * z, y = d[o + S.Y] * z;
    if (first < 0) { first = i; fx = x; fy = y; }
    else { const dx = x - px, dy = y - py; len += Math.sqrt(dx * dx + dy * dy); }
    px = x; py = y; last = i;
  }
  if (first < 0 || last <= first) return 0;
  const dt = d[last * S.STRIDE + S.T] - d[first * S.STRIDE + S.T];
  if (chord) { const dx = px - fx, dy = py - fy; len = Math.sqrt(dx * dx + dy * dy); }
  return dt > 0 ? len / dt : 0;
}

/** Window (ms) over which entry and exit speeds are measured. */
export const END_WINDOW_MS = 40;

/** v_entry: mean speed over the first 40 ms of intact rows (sp/ms). */
export function entrySpeed(d: Float32Array, n: number, z: number): number {
  const f = firstOk(d, n);
  if (f < 0) return 0;
  const t0 = d[f * S.STRIDE + S.T];
  return windowSpeed(d, n, z, t0, t0 + END_WINDOW_MS);
}

/** True once the intact rows span the entry window, i.e. the entry taper is final. */
export function entryKnown(d: Float32Array, n: number): boolean {
  const f = firstOk(d, n), l = lastOk(d, n);
  return f >= 0 && l > f && d[l * S.STRIDE + S.T] - d[f * S.STRIDE + S.T] >= END_WINDOW_MS;
}

/** v_exit: mean speed over the last 40 ms of intact rows (sp/ms). */
export function exitSpeed(d: Float32Array, n: number, z: number): number {
  const l = lastOk(d, n);
  if (l < 0) return 0;
  const tl = d[l * S.STRIDE + S.T];
  return windowSpeed(d, n, z, tl - END_WINDOW_MS, tl);
}

/**
 * Exit velocity (sp/ms): net displacement over the last 40 ms of intact rows per ms.
 * The seated-stop test uses this instead of the mean speed: a still but tremulous
 * hand adds path length on every sample (σ = 0.5 sp of tremor at 240 Hz reads as
 * ≈ 0.2 sp/ms, above the 0.15·vMed threshold) while its net displacement stays at the
 * noise level.
 */
export function exitVelocity(d: Float32Array, n: number, z: number): number {
  const l = lastOk(d, n);
  if (l < 0) return 0;
  const tl = d[l * S.STRIDE + S.T];
  return windowSpeed(d, n, z, tl - END_WINDOW_MS, tl, true);
}

/** Still radius (sp) per device: the Rise still threshold, before the jitter factor. */
export const STILL_RADIUS: Record<Device, number> = { pen: 1.5, mouse: 1.0, touch: 4 };

/** jf = 1 + clamp((J − 0.3)/0.6, 0, 1.5): every distance threshold scales with the hand's tremor. */
export function jitterFactor(J: number): number {
  return 1 + clamp(((J === J ? J : 0.3) - 0.3) / 0.6, 0, 1.5);
}

/**
 * End dwell (ms): how long the tip stayed within `radius` sp of the last intact row
 * before lift. Mouse rows stop arriving while the mouse is still, so app/draft
 * appends a final row at pointerup (same position, lift time) to make this measurable.
 */
export function endDwell(d: Float32Array, n: number, z: number, radius: number): number {
  const l = lastOk(d, n);
  if (l < 1) return 0;
  const lo = l * S.STRIDE, lx = d[lo + S.X] * z, ly = d[lo + S.Y] * z, tl = d[lo + S.T];
  const r2 = radius * radius;
  let k = l;
  for (let j = l - 1; j >= 0; j--) {
    if (!rowOk(d, j)) continue;
    const o = j * S.STRIDE;
    const dx = d[o + S.X] * z - lx, dy = d[o + S.Y] * z - ly;
    if (dx * dx + dy * dy > r2) break;
    k = j;
  }
  return tl - d[k * S.STRIDE + S.T];
}

// ============================================================================ stations

/** Central-difference speed window: v uses stations i ± k with T[i+k] − T[i−k] ≥ 8 ms. */
export const SPEED_WINDOW_MS = 8;
/** Largest k tried (±9.6 sp of stations). */
export const SPEED_KMAX = 4;

/**
 * Speed window at station i over stations [0, last]: the smallest k ≤ 4 with
 * T[min(i+k, last)] − T[max(i−k, 0)] ≥ 8 ms, else 4. With `strict`, a window that
 * would need a station beyond `last` returns -1 (not final yet).
 */
export function speedWindow(T: ArrayLike<number>, i: number, last: number, strict: boolean): number {
  for (let k = 1; k <= SPEED_KMAX; k++) {
    let hi = i + k;
    if (hi > last) { if (strict) return -1; hi = last; }
    const lo = i - k < 0 ? 0 : i - k;
    if (T[hi] - T[lo] >= SPEED_WINDOW_MS) return k;
  }
  return SPEED_KMAX;
}

/** Speed (sp/ms) at station i with window k (indices clamped to [0, last]). */
export function speedAt(Sa: ArrayLike<number>, T: ArrayLike<number>, i: number, k: number, last: number): number {
  const hi = i + k > last ? last : i + k, lo = i - k < 0 ? 0 : i - k;
  if (hi <= lo) return 0;
  const dt = T[hi] - T[lo];
  return (Sa[hi] - Sa[lo]) / (dt > 0.25 ? dt : 0.25);
}

/** Half-width (sp) of the curvature / normal window (κ over 6 sp). */
export const FRAME_HALF = 3;

/**
 * True once station i's frame can no longer change as stations are appended after
 * `last`: the window [s−3, s+3] must end before the turning interval of the last
 * station (which has no outgoing segment yet) begins.
 */
export function frameFinal(Sa: ArrayLike<number>, i: number, last: number): boolean {
  return last >= 1 && 0.5 * (Sa[last - 1] + Sa[last]) >= Sa[i] + FRAME_HALF;
}

/** Curvature and unit normal at a station. */
export interface Frame { k: number; nx: number; ny: number }

const pa = new Float64Array(2), pb = new Float64Array(2);

/** Position at arc `a` on stations [lo, hi] (a clamped), by binary search + lerp, into out. */
export function posAtArc(X: ArrayLike<number>, Y: ArrayLike<number>, Sa: ArrayLike<number>, lo: number, hi: number, a: number, out: Float64Array): void {
  if (a <= Sa[lo]) { out[0] = X[lo]; out[1] = Y[lo]; return; }
  if (a >= Sa[hi]) { out[0] = X[hi]; out[1] = Y[hi]; return; }
  let l = lo, h = hi;
  while (h - l > 1) { const m = (l + h) >> 1; if (Sa[m] <= a) l = m; else h = m; }
  const ds = Sa[h] - Sa[l], f = ds > 0 ? (a - Sa[l]) / ds : 0;
  out[0] = X[l] + (X[h] - X[l]) * f; out[1] = Y[l] + (Y[h] - Y[l]) * f;
}

/** Signed turning (rad) at station j between its incoming and outgoing segments; + toward the left normal. */
function turnAt(X: ArrayLike<number>, Y: ArrayLike<number>, a: number, j: number, b: number): number {
  const ix = X[j] - X[a], iy = Y[j] - Y[a], ox = X[b] - X[j], oy = Y[b] - Y[j];
  if (ix * ix + iy * iy < 1e-18 || ox * ox + oy * oy < 1e-18) return 0;
  return datan2(-(ix * oy - iy * ox), ix * ox + iy * oy);
}

/**
 * Frame of station i over stations [lo, hi].
 *  - Normal: left of travel, (ty, −tx)/|t| in the y-down frame, with the tangent the
 *    chord P(s+3) − P(s−3), i.e. smoothed over 6 sp.
 *  - κ: the turning of the polyline inside the window [s−3, s+3] per sp. Each
 *    station's turning is spread evenly over the arc between its two segment
 *    midpoints and integrated over the window, which is exact on circles (a chord-
 *    interpolated P(s±3) would overstate κ by the chord sagitta, ~12% at R = 60).
 *    κ > 0 when the path bends toward the normal.
 * With `cyclic` (a welded loop whose last station coincides with its first) both
 * windows wrap across the seam.
 */
export function stationFrame(X: ArrayLike<number>, Y: ArrayLike<number>, Sa: ArrayLike<number>,
  i: number, lo: number, hi: number, cyclic: boolean, out: Frame): Frame {
  const s = Sa[i], s0 = Sa[lo], s1 = Sa[hi], len = s1 - s0;
  const wrap = cyclic && hi - lo >= 4 && len > 4 * FRAME_HALF;
  let aB = s - FRAME_HALF, aF = s + FRAME_HALF;
  if (wrap) {
    if (aB < s0) aB += len;
    if (aF > s1) aF -= len;
  } else {
    if (aB < s0) aB = s0;
    if (aF > s1) aF = s1;
  }
  posAtArc(X, Y, Sa, lo, hi, aB, pa);
  posAtArc(X, Y, Sa, lo, hi, aF, pb);
  let tx = pb[0] - pa[0], ty = pb[1] - pa[1];
  let tl = Math.sqrt(tx * tx + ty * ty);
  if (!(tl > 1e-9)) {
    // degenerate window (single station or a spike): fall back to the neighbouring segment
    const j = i < hi ? i + 1 : i > lo ? i - 1 : i;
    tx = i < hi ? X[j] - X[i] : X[i] - X[j]; ty = i < hi ? Y[j] - Y[i] : Y[i] - Y[j];
    tl = Math.sqrt(tx * tx + ty * ty);
    if (!(tl > 1e-12)) { tx = 1; ty = 0; tl = 1; }
  }
  out.nx = ty / tl; out.ny = -tx / tl;

  // κ: integrate station turnings over [wa, wb] (absolute arcs; unwrapped when cyclic)
  const m = hi - lo; // distinct stations of a loop (last == first)
  const wa = wrap ? s - FRAME_HALF : aB, wb = wrap ? s + FRAME_HALF : aF;
  let sum = 0;
  for (let v = i - 5; v <= i + 5; v++) {
    let j: number, jp: number, jn: number, off = 0;
    if (wrap) {
      const r = (((v - lo) % m) + m) % m;
      j = lo + r;
      off = Math.floor((v - lo) / m) * len;
      jp = r === 0 ? hi - 1 : j - 1;
      jn = j + 1;
    } else {
      if (v <= lo || v >= hi) continue;
      j = v; jp = v - 1; jn = v + 1;
    }
    const sj = Sa[j] + off;
    const sp = neighbourArc(Sa, jp, j, sj, wrap ? len : 0, true), sn = neighbourArc(Sa, jn, j, sj, wrap ? len : 0, false);
    const a = 0.5 * (sp + sj), b = 0.5 * (sj + sn);
    const ov = Math.min(wb, b) - Math.max(wa, a);
    if (ov > 0 && b > a) sum += turnAt(X, Y, jp, j, jn) * (ov / (b - a));
  }
  out.k = wb - wa > 1e-9 ? sum / (wb - wa) : 0;
  return out;
}

/** Arc of a neighbour of station j (at absolute arc sj), unwrapped across a loop seam. */
function neighbourArc(Sa: ArrayLike<number>, nb: number, j: number, sj: number, len: number, prev: boolean): number {
  const d = Sa[nb] - Sa[j];
  if (len > 0) {
    if (prev && d > 0) return sj + d - len;
    if (!prev && d < 0) return sj + d + len;
  }
  return sj + d;
}

/** Net signed turning (rad) of the polyline through stations [from, to]; degenerate segments skipped. */
export function netTurning(X: ArrayLike<number>, Y: ArrayLike<number>, from: number, to: number): number {
  let sum = 0, hx = 0, hy = 0, has = false;
  for (let i = from + 1; i <= to; i++) {
    const dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1];
    if (dx * dx + dy * dy < 1e-18) continue;
    if (has) sum += datan2(hx * dy - hy * dx, hx * dx + hy * dy);
    hx = dx; hy = dy; has = true;
  }
  return sum;
}
