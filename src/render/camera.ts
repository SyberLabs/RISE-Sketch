/**
 * Camera maths (pure functions on immutable Camera values). Spec: docs/DESIGN.md §5, §6.9.
 *
 * screen = R(rot)·(doc − c)·scale + (W/2, H/2), with R(θ) = [cos −sin; sin cos] in screen
 * space (y down, so positive rot turns content clockwise). rot is 0 in P0; the rot = 0 path uses
 * no trigonometry, so P0 round trips are exact up to floating rounding.
 */
import type { AABB, Camera } from '../core/types';

export const MIN_SCALE = 0.05, MAX_SCALE = 32;
/** Zoom detents (DESIGN §5): a pinch ending within ±8 % of one snaps to it. */
export const DETENTS: readonly number[] = [0.25, 0.5, 1, 2, 4];
const DETENT_TOL = 0.08;

/** Clamp a scale to [MIN_SCALE, MAX_SCALE] (NaN → 1). */
export function clampScale(s: number): number {
  return s >= MIN_SCALE ? (s <= MAX_SCALE ? s : MAX_SCALE) : s < MIN_SCALE ? MIN_SCALE : 1;
}

/** Doc point -> viewport CSS px. */
export function docToScreen(c: Camera, W: number, H: number, x: number, y: number): [number, number] {
  const dx = (x - c.cx) * c.scale, dy = (y - c.cy) * c.scale;
  if (!c.rot) return [dx + W * 0.5, dy + H * 0.5];
  const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
  return [cs * dx - sn * dy + W * 0.5, sn * dx + cs * dy + H * 0.5];
}

/** Viewport CSS px -> doc point. */
export function screenToDoc(c: Camera, W: number, H: number, sx: number, sy: number): [number, number] {
  let dx = sx - W * 0.5, dy = sy - H * 0.5;
  if (c.rot) {
    const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    const rx = cs * dx + sn * dy, ry = -sn * dx + cs * dy;
    dx = rx; dy = ry;
  }
  return [c.cx + dx / c.scale, c.cy + dy / c.scale];
}

/** Move the content by (dx, dy) screen CSS px (a drag of the canvas). */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  let ux = dx, uy = dy;
  if (c.rot) {
    const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    ux = cs * dx + sn * dy; uy = -sn * dx + cs * dy;
  }
  return { cx: c.cx - ux / c.scale, cy: c.cy - uy / c.scale, scale: c.scale, rot: c.rot };
}

/**
 * Zoom by `factor` keeping the doc point under screen (sx, sy) fixed; scale is clamped. A NaN
 * factor (e.g. a 0/0 pinch ratio) leaves the camera unchanged instead of jumping to 100 %.
 */
export function zoomAt(c: Camera, factor: number, sx: number, sy: number, W: number, H: number): Camera {
  if (factor !== factor) return c;
  const s = clampScale(c.scale * factor);
  const [x, y] = screenToDoc(c, W, H, sx, sy);
  let dx = sx - W * 0.5, dy = sy - H * 0.5;
  if (c.rot) {
    const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    const rx = cs * dx + sn * dy, ry = -sn * dx + cs * dy;
    dx = rx; dy = ry;
  }
  return { cx: x - dx / s, cy: y - dy / s, scale: s, rot: c.rot };
}

/**
 * Camera that fits `box` (absolute doc) into a W × H viewport, leaving `margin` (fraction of the
 * viewport, default 0.06) on every side. Degenerate extents count as 1e-6 doc; the scale is
 * clamped to [MIN_SCALE, MAX_SCALE]. A box that is not finite (an empty accumulator such as
 * {Infinity, −Infinity}) gives the 100 % camera at the origin rather than a NaN camera. rot = 0.
 */
export function fitBox(box: AABB, W: number, H: number, margin = 0.06): Camera {
  if (!(Number.isFinite(box.x0) && Number.isFinite(box.y0) && Number.isFinite(box.x1) && Number.isFinite(box.y1))) {
    return { cx: 0, cy: 0, scale: 1, rot: 0 };
  }
  const bw = Math.max(1e-6, box.x1 - box.x0), bh = Math.max(1e-6, box.y1 - box.y0);
  const f = Math.max(0.05, 1 - 2 * margin);
  const s = clampScale(Math.min((W * f) / bw, (H * f) / bh));
  return { cx: (box.x0 + box.x1) * 0.5, cy: (box.y0 + box.y1) * 0.5, scale: s, rot: 0 };
}

/** Snap a scale to 25/50/100/200/400 % when within ±8 % of it; otherwise unchanged. */
export function snapDetent(scale: number): number {
  for (const d of DETENTS) if (Math.abs(scale / d - 1) <= DETENT_TOL) return d;
  return scale;
}

/** Axis-aligned doc box of the viewport (the bounding box of its corners when rotated). */
export function visibleBox(c: Camera, W: number, H: number): AABB {
  if (!c.rot) {
    const hw = (W * 0.5) / c.scale, hh = (H * 0.5) / c.scale;
    return { x0: c.cx - hw, y0: c.cy - hh, x1: c.cx + hw, y1: c.cy + hh };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < 4; k++) {
    const [x, y] = screenToDoc(c, W, H, k & 1 ? W : 0, k & 2 ? H : 0);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Settled-camera snap (DESIGN §6.9): nudge cx/cy by less than half a device pixel so the document
 * origin lands on a whole device pixel of a W × H (CSS px) viewport at `dpr`. Grid-aligned tiles
 * then composite with integer offsets at 100 % and integer DPR. rot ≠ 0 is returned unchanged.
 */
export function snapToDevice(c: Camera, W: number, H: number, dpr: number): Camera {
  if (c.rot) return c;
  const k = c.scale * dpr, hx = W * dpr * 0.5, hy = H * dpr * 0.5;
  const ox = Math.round(hx - c.cx * k), oy = Math.round(hy - c.cy * k);
  return { cx: (hx - ox) / k, cy: (hy - oy) / k, scale: c.scale, rot: c.rot };
}

/** Camera equality (exact). */
export function sameCamera(a: Camera, b: Camera): boolean {
  return a.cx === b.cx && a.cy === b.cy && a.scale === b.scale && a.rot === b.rot;
}
