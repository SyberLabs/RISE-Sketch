/**
 * OKLab / OKLCH colour maths (Björn Ottosson), with chroma-bisection gamut mapping.
 * Colour is presentation, not geometry, so Math.* is allowed here.
 *
 * Conventions: L in [0,1], C >= 0 (practical max ~0.37), h in degrees.
 */

export type LCh = readonly [L: number, C: number, h: number];
export type RGB = [number, number, number];
export type Gamut = 'srgb' | 'p3';

// ---- transfer functions
export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// ---- OKLab <-> linear sRGB
export function oklabToLinearSrgb(L: number, a: number, b: number, out: RGB = [0, 0, 0]): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return out;
}
export function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// linear sRGB -> linear Display P3 (via XYZ D65)
function linSrgbToLinP3(c: RGB): RGB {
  const [r, g, b] = c;
  return [
    0.8224621 * r + 0.1775380 * g + 0.0000000 * b,
    0.0331941 * r + 0.9668058 * g + 0.0000000 * b,
    0.0170827 * r + 0.0723974 * g + 0.9105199 * b,
  ];
}

const DEG = Math.PI / 180;
export function lchToLab(c: LCh): [number, number, number] {
  return [c[0], c[1] * Math.cos(c[2] * DEG), c[1] * Math.sin(c[2] * DEG)];
}
export function labToLch(L: number, a: number, b: number): LCh {
  const C = Math.hypot(a, b);
  let h = Math.atan2(b, a) / DEG;
  if (h < 0) h += 360;
  return [L, C, h];
}

/** Linear RGB of an LCh colour in the requested gamut's primaries (unclamped). */
export function lchToLinear(c: LCh, gamut: Gamut = 'srgb'): RGB {
  const [L, a, b] = lchToLab(c);
  const lin = oklabToLinearSrgb(L, a, b);
  return gamut === 'p3' ? linSrgbToLinP3(lin) : lin;
}

const inGamut = (c: RGB, eps = 1e-4): boolean =>
  c[0] >= -eps && c[0] <= 1 + eps && c[1] >= -eps && c[1] <= 1 + eps && c[2] >= -eps && c[2] <= 1 + eps;

/** Reduce chroma at constant L and h until the colour fits the gamut (8-step bisection). */
export function gamutMap(c: LCh, gamut: Gamut = 'srgb'): LCh {
  const L = Math.min(1, Math.max(0, c[0]));
  if (inGamut(lchToLinear([L, c[1], c[2]], gamut))) return [L, c[1], c[2]];
  let lo = 0, hi = c[1];
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(lchToLinear([L, mid, c[2]], gamut))) lo = mid; else hi = mid;
  }
  return [L, lo, c[2]];
}

const to255 = (x: number): number => Math.round(Math.min(1, Math.max(0, linearToSrgb(x))) * 255);

/** Gamut-mapped encoded sRGB in 0..255. */
export function lchToRgb255(c: LCh): RGB {
  const m = gamutMap(c, 'srgb');
  const lin = lchToLinear(m, 'srgb');
  return [to255(lin[0]), to255(lin[1]), to255(lin[2])];
}

/** CSS colour string; `p3` emits color(display-p3 ...). Alpha optional. */
export function lchToCss(c: LCh, gamut: Gamut = 'srgb', alpha = 1): string {
  if (gamut === 'p3') {
    const m = gamutMap(c, 'p3');
    const lin = lchToLinear(m, 'p3');
    const f = (x: number) => Math.min(1, Math.max(0, linearToSrgb(x))).toFixed(4);
    return `color(display-p3 ${f(lin[0])} ${f(lin[1])} ${f(lin[2])}${alpha < 1 ? ` / ${alpha.toFixed(3)}` : ''})`;
  }
  const [r, g, b] = lchToRgb255(c);
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha.toFixed(3)})` : `rgb(${r},${g},${b})`;
}

export function lchToHex(c: LCh): string {
  const [r, g, b] = lchToRgb255(c);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Parse #rgb / #rrggbb into LCh. */
export function hexToLch(hex: string): LCh | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map(ch => ch + ch).join('');
  const n = parseInt(s, 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255), g = srgbToLinear(((n >> 8) & 255) / 255), b = srgbToLinear((n & 255) / 255);
  const [L, A, B] = linearSrgbToOklab(r, g, b);
  return labToLch(L, A, B);
}

/** Perceptual distance (ΔE in OKLab units). */
export function deltaE(a: LCh, b: LCh): number {
  const [L1, a1, b1] = lchToLab(a), [L2, a2, b2] = lchToLab(b);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

/** WCAG relative luminance of an encoded sRGB colour, for contrast checks. */
export function relLuminance(rgb255: RGB): number {
  const [r, g, b] = rgb255.map(v => srgbToLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
