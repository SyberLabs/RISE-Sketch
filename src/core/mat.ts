/**
 * 2D affine matrices as Float64Array [a, b, c, d, e, f], matching Canvas2D's
 * setTransform(a, b, c, d, e, f):  x' = a·x + c·y + e,  y' = b·x + d·y + f.
 */
import { dcos, dsin } from "./det";

export type Mat2x3 = Float64Array;

export const identity = (): Mat2x3 => Float64Array.of(1, 0, 0, 1, 0, 0);
export const fromValues = (a: number, b: number, c: number, d: number, e: number, f: number): Mat2x3 =>
  Float64Array.of(a, b, c, d, e, f);
export const translation = (x: number, y: number): Mat2x3 => Float64Array.of(1, 0, 0, 1, x, y);
export const scaling = (s: number, sy = s): Mat2x3 => Float64Array.of(s, 0, 0, sy, 0, 0);
/** Rotation by `r` radians (deterministic trig, so it may feed geometry). */
export const rotation = (r: number): Mat2x3 => {
  const c = dcos(r), s = dsin(r);
  return Float64Array.of(c, s, -s, c, 0, 0);
};

/** out = m · n  (apply n first, then m). */
export function multiply(m: Mat2x3, n: Mat2x3, out: Mat2x3 = new Float64Array(6)): Mat2x3 {
  const a = m[0] * n[0] + m[2] * n[1];
  const b = m[1] * n[0] + m[3] * n[1];
  const c = m[0] * n[2] + m[2] * n[3];
  const d = m[1] * n[2] + m[3] * n[3];
  const e = m[0] * n[4] + m[2] * n[5] + m[4];
  const f = m[1] * n[4] + m[3] * n[5] + m[5];
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = e; out[5] = f;
  return out;
}

export function invert(m: Mat2x3, out: Mat2x3 = new Float64Array(6)): Mat2x3 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const id = 1 / det;
  const a = m[3] * id, b = -m[1] * id, c = -m[2] * id, d = m[0] * id;
  const e = -(a * m[4] + c * m[5]);
  const f = -(b * m[4] + d * m[5]);
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = e; out[5] = f;
  return out;
}

export function apply(m: Mat2x3, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
/** Apply into an existing array at offset, avoiding allocation. */
export function applyInto(m: Mat2x3, x: number, y: number, out: { 0: number; 1: number }): void {
  out[0] = m[0] * x + m[2] * y + m[4];
  out[1] = m[1] * x + m[3] * y + m[5];
}
/** Uniform scale factor of the linear part (sqrt |det|). */
export const scaleOf = (m: Mat2x3): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
export const isIdentity = (m: Mat2x3 | null): boolean =>
  !m || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);
