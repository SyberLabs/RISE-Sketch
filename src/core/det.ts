/**
 * Deterministic maths.
 *
 * Geometry in Rise is a pure function of a stroke recipe, and a `.rise` file must
 * re-cook to the same pixels on every engine. IEEE 754 guarantees correctly rounded
 * + - * / and sqrt, but not Math.sin/exp/pow, whose last bits differ between engines
 * (and chaotic operators like Drift amplify last-bit differences). These routines are
 * ports of fdlibm kernels built only from correctly rounded operations, so they return
 * bit-identical results everywhere. JS never contracts a*b+c into an FMA, which keeps
 * the polynomial evaluation exact-order.
 *
 * Accuracy is within ~1 ulp of Math.* over the ranges Rise uses.
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
// little-endian assumption holds on every platform browsers ship on; checked once
const LE = (() => { f64[0] = 1; return u32[1] === 0x3ff00000; })();
const HI = LE ? 1 : 0, LO = LE ? 0 : 1;

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** 2^k for integer k in [-1074, 1023], exact. */
export function pow2i(k: number): number {
  if (k > 1023) return Infinity;
  if (k >= -1022) { u32[HI] = (k + 1023) << 20; u32[LO] = 0; return f64[0]; }
  // subnormal: split the scale so each step stays exact
  return pow2i(k + 600) * pow2i(-600);
}

// ---------------------------------------------------------------- sin / cos
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
  S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
  S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
  C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
  C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21;
const INV_PIO2 = 6.36619772367581382433e-01;

function ksin(x: number): number {
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}
function kcos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z, w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
}
/** Cody-Waite reduction; returns quadrant in `quad` and remainder. Good for |x| < 2^20·π/2. */
let quad = 0;
function reduce(x: number): number {
  const k = Math.round(x * INV_PIO2);
  quad = k & 3;
  // two-stage subtraction keeps ~80 bits of pi/2 for the magnitudes we use
  const r1 = x - k * PIO2_1;
  const w = k * PIO2_1T;
  const r = r1 - w;
  if (Math.abs(k) < 4096) return r;
  const t = r1;
  const w2 = k * PIO2_2;
  const r2 = t - w2;
  const ww = k * PIO2_2T - ((t - r2) - w2);
  return r2 - ww;
}

export function dsin(x: number): number {
  if (!(x === x) || x === Infinity || x === -Infinity) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return ksin(x);
  const r = reduce(x);
  switch (quad) {
    case 0: return ksin(r);
    case 1: return kcos(r);
    case 2: return -ksin(r);
    default: return -kcos(r);
  }
}
export function dcos(x: number): number {
  if (!(x === x) || x === Infinity || x === -Infinity) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return kcos(x);
  const r = reduce(x);
  switch (quad) {
    case 0: return kcos(r);
    case 1: return -ksin(r);
    case 2: return -kcos(r);
    default: return ksin(r);
  }
}

// ---------------------------------------------------------------- atan / atan2
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT0 = 3.33333333333329318027e-01, AT1 = -1.99999999998764832476e-01, AT2 = 1.42857142725034663711e-01,
  AT3 = -1.11111104054623557880e-01, AT4 = 9.09088713343650656196e-02, AT5 = -7.69187620504482999495e-02,
  AT6 = 6.66107313738753120669e-02, AT7 = -5.83357013379057348645e-02, AT8 = 4.97687799461593236017e-02,
  AT9 = -3.65315727442169155270e-02, AT10 = 1.62858201153657823623e-02;

export function datan(x: number): number {
  if (!(x === x)) return NaN;
  const neg = x < 0;
  let ax = neg ? -x : x;
  if (ax >= 7.378697629483821e19) return neg ? -ATANHI[3] - ATANLO[3] : ATANHI[3] + ATANLO[3];
  let id = -1;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); }
    else { id = 1; ax = (ax - 1) / (ax + 1); }
  } else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax); }
  else { id = 3; ax = -1 / ax; }
  const xx = id < 0 ? x : ax;
  const z = xx * xx, w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return xx - xx * (s1 + s2);
  const r = ATANHI[id] - ((xx * (s1 + s2) - ATANLO[id]) - xx);
  return neg ? -r : r;
}

const PI_LO = 1.2246467991473532e-16;
export function datan2(y: number, x: number): number {
  if (!(x === x) || !(y === y)) return NaN;
  if (x === 0) { if (y === 0) return 0; return y > 0 ? HALF_PI : -HALF_PI; }
  if (y === 0) return x > 0 ? 0 : (Object.is(y, -0) ? -PI : PI);
  const z = datan(Math.abs(y / x));
  if (x > 0) return y > 0 ? z : -z;
  return y > 0 ? PI - (z - PI_LO) : (z - PI_LO) - PI;
}

// ---------------------------------------------------------------- exp / log / pow
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INV_LN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
  P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;

export function dexp(x: number): number {
  if (!(x === x)) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  if (Math.abs(x) < 3.725290298461914e-9) return 1 + x;
  const k = Math.round(x * INV_LN2);
  const hi = x - k * LN2_HI, lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const y = 1 - ((lo - (r * c) / (2 - c)) - hi);
  if (k >= -1021) return y * pow2i(k);
  return y * pow2i(k + 1000) * pow2i(-1000);
}

const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01,
  LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01,
  LG7 = 1.479819860511658591e-01;
const SQRT2 = 1.4142135623730951;

export function dlog(x: number): number {
  if (!(x === x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let k = 0;
  if (x < 2.2250738585072014e-308) { x *= 18014398509481984; k -= 54; } // subnormal: scale by 2^54
  f64[0] = x;
  const hx = u32[HI];
  k += ((hx >>> 20) & 0x7ff) - 1023;
  u32[HI] = (hx & 0x000fffff) | 0x3ff00000; // mantissa in [1,2)
  let m = f64[0];
  if (m > SQRT2) { m *= 0.5; k += 1; }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s, w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t2 + t1;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
}

/** x^y for x >= 0. Negative bases return NaN unless y is an integer. */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (y === 1) return x;
  if (y === 2) return x * x;
  if (y === 0.5) return Math.sqrt(x);
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) {
    if (Math.floor(y) !== y) return NaN;
    const r = dexp(y * dlog(-x));
    return (y % 2 === 0) ? r : -r;
  }
  return dexp(y * dlog(x));
}

export const dhypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);

// ---------------------------------------------------------------- hashing / addressed RNG

/** murmur3 32-bit finaliser. */
export function fmix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine two 32-bit values into a well-mixed 32-bit hash. */
export function hash32(a: number, b: number): number {
  return fmix32((a ^ Math.imul((b | 0) + 0x9e3779b9, 0x85ebca77)) >>> 0);
}

/**
 * Addressed randomness: a stateless hash of (seed, channel, a, b) -> [0, 1).
 * Output never depends on call order, so changing loops, budgets or chunking
 * never reshuffles a drawing. `a`/`b` should be integers (indices, quantised positions).
 */
export function rnd(seed: number, ch: number, a: number, b = 0): number {
  let h = fmix32((seed ^ Math.imul(ch + 1, 0x9e3779b1)) >>> 0);
  h = fmix32((h ^ Math.imul(a | 0, 0x85ebca77)) >>> 0);
  h = fmix32((h ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae3d)) >>> 0);
  return h / 4294967296;
}

/** Channels for `rnd`; operators must use these so streams never collide. */
export const enum Ch { Geometry = 1, Growth = 2, Jitter = 3, Color = 4, Side = 5, Lean = 6, Angle = 7, Length = 8, Field = 9, Misc = 10 }

/** FNV-1a over raw bytes of typed arrays; used for golden hashes and scene hashes. */
export function fnv1a(arrays: ArrayLike<ArrayBufferView>, init = 0x811c9dc5): number {
  let h = init >>> 0;
  for (let i = 0; i < arrays.length; i++) {
    const v = arrays[i];
    const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (let j = 0; j < b.length; j++) { h ^= b[j]; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h >>> 0;
}
