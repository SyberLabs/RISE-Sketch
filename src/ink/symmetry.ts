/**
 * Symmetry drawing (DESIGN §2.3.1, §7.5): Mirror and radial copies of a stroke.
 *
 * A copy is a recipe of its own (own id, so it autosaves, erases and selects like any stroke) that
 * shares every geometry input with the stroke it was drawn by (samples, seed, calib, pools...) and
 * carries a placement `xf`. `cook(copy)` cooks the shared inputs exactly as the original and then
 * places the result, so a copy is the bit-exact transform of the original's geometry: a Sprout
 * branches the same way in every petal and the live copies are exactly what is committed.
 *
 * `xf` maps doc units relative to the recipe origin onto doc units relative to the same origin
 * (Canvas2D order: x' = a·x + c·y + e, y' = b·x + d·y + f). Symmetry copies use isometries only, so
 * widths are unchanged. Everything spatial (cooked geometry, spines, samples for occupancy and
 * hit tests) goes through `placeCooked` / `placeSpine` / `placedSamples`.
 *
 * Colour: with Spectral ink, copy i of n takes a hue offset of 360°·i/n in `color.dh`, stored in the
 * recipe (DESIGN §2.4.2): a six-fold mandala is a rainbow wheel. Other inks keep the stroke's colour.
 */
import type { Cooked, ColorStyle, Mat2x3, Spine, StrokeRecipe, Vec2 } from '../core/types';
import { S } from '../core/types';
import { datan2, dcos, dsin, TAU } from '../core/det';

/**
 * Placement of copy i (1 ≤ i < folds) of a stroke whose origin is `o`, about the centre (cx, cy):
 * folds = 2 reflects across the vertical line x = cx; otherwise rotates by 360°·i/folds.
 */
export function symmetryXf(folds: number, i: number, cx: number, cy: number, o: Vec2): Mat2x3 {
  let a: number, b: number, c: number, d: number;
  if (folds === 2) { a = -1; b = 0; c = 0; d = 1; }
  else {
    const t = (TAU * i) / folds;
    const cs = dcos(t), sn = dsin(t);
    a = cs; b = sn; c = -sn; d = cs;
  }
  // local' = L·local + L·(o − C) + C − o
  const px = o[0] - cx, py = o[1] - cy;
  const e = a * px + c * py + cx - o[0];
  const f = b * px + d * py + cy - o[1];
  return Float64Array.of(a, b, c, d, e, f);
}

/** Every copy's placement (folds − 1 of them; the stroke itself is copy 0). */
export function symmetryXfs(folds: number, cx: number, cy: number, o: Vec2): Mat2x3[] {
  const out: Mat2x3[] = [];
  for (let i = 1; i < folds; i++) out.push(symmetryXf(folds, i, cx, cy, o));
  return out;
}

/** Colour of copy i of `folds`: Spectral turns its hue by 360°·i/folds; other inks are unchanged. */
export function copyColor(c: ColorStyle, i: number, folds: number): ColorStyle {
  if (c.ink !== 'spectral' || i === 0) return c;
  let dh = (c.dh || 0) + (360 * i) / folds;
  dh -= 360 * Math.floor(dh / 360);
  return { ...c, dh };
}

function boxInto(xf: Mat2x3, x0: number, y0: number, x1: number, y1: number, out: Float32Array | number[], o: number): void {
  const xa = xf[0] * x0, xb = xf[0] * x1, xc = xf[2] * y0, xd = xf[2] * y1;
  const ya = xf[1] * x0, yb = xf[1] * x1, yc = xf[3] * y0, yd = xf[3] * y1;
  out[o] = Math.min(xa, xb) + Math.min(xc, xd) + xf[4];
  out[o + 1] = Math.min(ya, yb) + Math.min(yc, yd) + xf[5];
  out[o + 2] = Math.max(xa, xb) + Math.max(xc, xd) + xf[4];
  out[o + 3] = Math.max(ya, yb) + Math.max(yc, yd) + xf[5];
}

const absBox = (b: Cooked['inkBox'], xf: Mat2x3, o: Vec2): Cooked['inkBox'] => {
  if (!(b.x1 >= b.x0 && b.y1 >= b.y0)) return { ...b };
  const t = [0, 0, 0, 0];
  boxInto(xf, b.x0 - o[0], b.y0 - o[1], b.x1 - o[0], b.y1 - o[1], t, 0);
  return { x0: t[0] + o[0], y0: t[1] + o[1], x1: t[2] + o[0], y1: t[3] + o[1] };
};

/**
 * Cooked geometry placed by `xf` (origin `o`): points, chisel angles, per-poly boxes and the ink /
 * hit boxes move; everything else is shared with the source (it is never mutated after cooking).
 */
export function placeCooked(c: Cooked, xf: Mat2x3, o: Vec2): Cooked {
  const n = c.nPts, src = c.pts, pts = new Float32Array(src.length);
  const a = xf[0], b = xf[1], cc = xf[2], d = xf[3], e = xf[4], f = xf[5];
  for (let j = 0; j < n; j++) {
    const q = 4 * j, x = src[q], y = src[q + 1];
    pts[q] = a * x + cc * y + e;
    pts[q + 1] = b * x + d * y + f;
    pts[q + 2] = src[q + 2];
    pts[q + 3] = src[q + 3];
  }
  let ang: Float32Array | null = null;
  if (c.ang) {
    ang = new Float32Array(c.ang.length);
    for (let j = 0; j < c.ang.length; j++) {
      const t = c.ang[j];
      const ux = dcos(t), uy = dsin(t);
      ang[j] = datan2(b * ux + d * uy, a * ux + cc * uy);
    }
  }
  const box = new Float32Array(c.box.length);
  for (let i = 0; i < c.nPolys; i++) {
    const k = 4 * i;
    boxInto(xf, c.box[k], c.box[k + 1], c.box[k + 2], c.box[k + 3], box, k);
  }
  return {
    ...c, pts, ang, box,
    inkBox: absBox(c.inkBox, xf, o), hitBox: absBox(c.hitBox, xf, o),
  };
}

/** A spine placed by `xf` (positions and normals; everything else shared). */
export function placeSpine(sp: Spine, xf: Mat2x3): Spine {
  const n = sp.n, x = new Float32Array(n), y = new Float32Array(n), nx = new Float32Array(n), ny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const px = sp.x[i], py = sp.y[i], qx = sp.nx[i], qy = sp.ny[i];
    x[i] = xf[0] * px + xf[2] * py + xf[4];
    y[i] = xf[1] * px + xf[3] * py + xf[5];
    nx[i] = xf[0] * qx + xf[2] * qy;
    ny[i] = xf[1] * qx + xf[3] * qy;
  }
  return { ...sp, x, y, nx, ny };
}

const placedCache = new WeakMap<StrokeRecipe, Float32Array>();

/** The recipe's sample rows where its ink actually lies (X, Y placed by `xf`; cached per recipe). */
export function placedSamples(r: StrokeRecipe): Float32Array {
  const xf = r.xf;
  if (!xf) return r.samples;
  let out = placedCache.get(r);
  if (out) return out;
  out = r.samples.slice();
  for (let o = 0; o + S.STRIDE <= out.length; o += S.STRIDE) {
    const x = out[o + S.X], y = out[o + S.Y];
    out[o + S.X] = xf[0] * x + xf[2] * y + xf[4];
    out[o + S.Y] = xf[1] * x + xf[3] * y + xf[5];
  }
  placedCache.set(r, out);
  return out;
}
