/**
 * Noise for the Drift field (DESIGN §2.3.6): 2D gradient noise with analytic
 * derivatives, a two-octave stream function ψ, its curl, and the lookup tables the
 * hot paths use (DESIGN §7.5 rule 3: noise gradients and Drift jitter come from
 * precomputed tables; only the allow-listed Math functions are used).
 *
 *   ψ(p)    = N(p/cell) + ½·N(2p/cell + offset)       two octaves, the second at half amplitude
 *   curl ψ  = (∂ψ/∂y, −∂ψ/∂x)                        divergence-free by construction
 *   F(p)    = curl ψ / |curl ψ|                       the Drift heading (same streamlines)
 *
 * N is gradient (Perlin) noise with a quintic fade: C² continuous, value 0 at the lattice
 * points, so along a line it oscillates about once per two cells. A cell of λ/2 therefore
 * gives the wavelength λ the spec asks for (280 sp at the commit zoom).
 * Lattice gradients are 256 unit vectors picked through a 256-entry permutation shuffled
 * from the stroke's field seed hash32(seed, Ch.Field) with the addressed rng, so a field is
 * a pure function of the seed (period 256 cells = 35,840 sp at λ = 280, far beyond a stroke).
 */
import { dcos, dsin, hash32, rnd, TAU } from '../core/det';

/** Entries in the gradient table. */
export const GRAD_N = 256;
/** Unit gradients at angles 2πk/256, interleaved (x, y). */
export const GRAD: Float64Array = (() => {
  const g = new Float64Array(2 * GRAD_N);
  for (let k = 0; k < GRAD_N; k++) { const a = (TAU * k) / GRAD_N; g[2 * k] = dcos(a); g[2 * k + 1] = dsin(a); }
  return g;
})();

/** Entries in the Drift jitter table. */
export const JIT_N = 64;
/** Half-range of the Drift jitter rotation (rad): (r − 0.5)·0.28. */
export const JIT_HALF = 0.14;
/** cos / sin of the 64 jitter angles, uniform over [−0.14, 0.14] (bucket centres). */
export const JIT_COS = new Float64Array(JIT_N);
export const JIT_SIN = new Float64Array(JIT_N);
for (let k = 0; k < JIT_N; k++) {
  const a = ((k + 0.5) / JIT_N) * 2 * JIT_HALF - JIT_HALF;
  JIT_COS[k] = dcos(a); JIT_SIN[k] = dsin(a);
}

/** Value and gradient of one noise evaluation. */
export interface NoiseSample { v: number; dx: number; dy: number }

/** 512-entry doubled permutation of 0..255 shuffled by `seed` (Fisher–Yates, addressed rng). */
export function permutation(seed: number): Uint8Array {
  const p = new Uint8Array(2 * GRAD_N);
  for (let i = 0; i < GRAD_N; i++) p[i] = i;
  for (let i = GRAD_N - 1; i > 0; i--) {
    const k = Math.floor(rnd(seed, 0, i) * (i + 1));
    const t = p[i]; p[i] = p[k]; p[k] = t;
  }
  for (let i = 0; i < GRAD_N; i++) p[GRAD_N + i] = p[i];
  return p;
}

/**
 * Gradient noise at (x, y) in lattice units through permutation `perm`, with its analytic
 * gradient. Output is roughly within ±0.75. Allocation-free.
 */
export function gradNoise(perm: Uint8Array, x: number, y: number, out: NoiseSample): NoiseSample {
  const fi = Math.floor(x), fj = Math.floor(y);
  const fx = x - fi, fy = y - fj;
  const i = fi & 255, j = fj & 255;
  const pi = perm[i], pi1 = perm[i + 1];
  const a = perm[pi + j] << 1, b = perm[pi1 + j] << 1, c = perm[pi + j + 1] << 1, d = perm[pi1 + j + 1] << 1;
  const ax = GRAD[a], ay = GRAD[a + 1], bx = GRAD[b], by = GRAD[b + 1];
  const cx = GRAD[c], cy = GRAD[c + 1], ex = GRAD[d], ey = GRAD[d + 1];
  const n00 = ax * fx + ay * fy;
  const n10 = bx * (fx - 1) + by * fy;
  const n01 = cx * fx + cy * (fy - 1);
  const n11 = ex * (fx - 1) + ey * (fy - 1);
  // quintic fade and its derivative
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), du = 30 * fx * fx * (fx - 1) * (fx - 1);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10), dv = 30 * fy * fy * (fy - 1) * (fy - 1);
  const k1 = n10 - n00, k2 = n01 - n00, k3 = n00 - n10 - n01 + n11;
  out.v = n00 + u * k1 + v * k2 + u * v * k3;
  out.dx = ax + u * (bx - ax) + v * (cx - ax) + u * v * (ax - bx - cx + ex) + du * (k1 + v * k3);
  out.dy = ay + u * (by - ay) + v * (cy - ay) + u * v * (ay - by - cy + ey) + dv * (k2 + u * k3);
  return out;
}

/** Offset of the second octave (cells), so its zero lattice never aligns with the first. */
const OCT2_X = 0.3719, OCT2_Y = 0.7127;

/**
 * Curl field of a two-octave stream function ψ. Coordinates are doc units relative to the
 * stroke origin; `cell` is the lattice spacing in doc units (λ/2).
 */
export class CurlField {
  private readonly s1: Uint8Array;
  private readonly s2: Uint8Array;
  private readonly inv: number;
  private readonly n1: NoiseSample = { v: 0, dx: 0, dy: 0 };
  private readonly n2: NoiseSample = { v: 0, dx: 0, dy: 0 };

  constructor(seed: number, readonly cell: number) {
    this.s1 = permutation(seed >>> 0);
    this.s2 = permutation(hash32(seed >>> 0, 0x2545f491));
    this.inv = cell > 0 ? 1 / cell : 1;
  }

  /** ψ and its gradient (per doc unit) at (x, y). */
  psi(x: number, y: number, out: NoiseSample): NoiseSample {
    const q = this.inv;
    gradNoise(this.s1, x * q, y * q, this.n1);
    gradNoise(this.s2, 2 * x * q + OCT2_X, 2 * y * q + OCT2_Y, this.n2);
    // second octave: half amplitude, double frequency, so its derivative weight is 1
    out.v = this.n1.v + 0.5 * this.n2.v;
    out.dx = (this.n1.dx + this.n2.dx) * q;
    out.dy = (this.n1.dy + this.n2.dy) * q;
    return out;
  }

  /** Unnormalised curl (∂ψ/∂y, −∂ψ/∂x) at (x, y), into out[0], out[1]. */
  curl(x: number, y: number, out: Float64Array): void {
    const q = this.inv;
    gradNoise(this.s1, x * q, y * q, this.n1);
    gradNoise(this.s2, 2 * x * q + OCT2_X, 2 * y * q + OCT2_Y, this.n2);
    out[0] = (this.n1.dy + this.n2.dy) * q;
    out[1] = -(this.n1.dx + this.n2.dx) * q;
  }

  /** Unit field direction F at (x, y), into out. Returns false (out untouched) where the curl vanishes. */
  dir(x: number, y: number, out: Float64Array): boolean {
    const q = this.inv;
    gradNoise(this.s1, x * q, y * q, this.n1);
    gradNoise(this.s2, 2 * x * q + OCT2_X, 2 * y * q + OCT2_Y, this.n2);
    const cx = this.n1.dy + this.n2.dy, cy = -(this.n1.dx + this.n2.dx);
    const m = Math.sqrt(cx * cx + cy * cy);
    if (!(m > 1e-12)) return false;
    out[0] = cx / m; out[1] = cy / m;
    return true;
  }
}
