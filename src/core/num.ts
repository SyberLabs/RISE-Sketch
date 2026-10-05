/** Small numeric helpers. Pure, allocation-free. */

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number): number => (b === a ? 0 : (x - a) / (b - a));

/** Hermite smoothstep. Works reversed when a > b (falls from 1 to 0). */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export const easeOutCubic = (t: number): number => { const u = 1 - clamp01(t); return 1 - u * u * u; };
export const easeInOutCubic = (t: number): number => {
  t = clamp01(t);
  const u = -2 * t + 2;
  return t < 0.5 ? 4 * t * t * t : 1 - (u * u * u) / 2;
};
/** Quantise to 1/16 (depth storage). */
export const quantize16 = (x: number): number => Math.round(x * 16) / 16;
export const fract = (x: number): number => x - Math.floor(x);
export const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
/** Wrap degrees into [0, 360). */
export const wrapDeg = (h: number): number => ((h % 360) + 360) % 360;
/** Shortest signed angle difference in radians, in (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 6.283185307179586;
  if (d > 3.141592653589793) d -= 6.283185307179586;
  else if (d <= -3.141592653589793) d += 6.283185307179586;
  return d;
}
