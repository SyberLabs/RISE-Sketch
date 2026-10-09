/**
 * Paper tooth: the grain Charcoal catches on (DESIGN §2.2.1, §6.4).
 *
 * One periodic heightmap of TOOTH_N² texels, a pure function of nothing (no seed, no clock), so
 * every device builds the same bytes: three octaves of value noise (2, 8 and 32 texel cells)
 * plus 140 short faint fibres, equalised so a threshold `t` covers exactly a fraction 1 − t of the
 * paper. A second, smudged copy is the same map box-blurred and equalised again.
 *
 * The map is anchored to the world: a texel is `toothCell(z)` doc units, the nearest power of two
 * to one sp at the stroke's commit zoom, so strokes drawn at zooms within one octave share the
 * same grain (a second pass of charcoal catches the same peaks), and the grain scales with the ink
 * when you zoom. How much of the tooth a mark fills depends on its density: pressure, through the
 * poly's tone (its pressure bucket, `toothDensity`), times the stick's contact across the ribbon
 * (`toothProfile`: full in the middle, thin at the edges, with drag lanes). The lean at pen-down
 * (`toothSmudge`) softens the grain: the side of the stick smears pigment over the peaks.
 *
 * Presentation only: the tooth never feeds geometry, ids or sceneHash. It still uses only the
 * §7.5 allow-list and det.ts, so the bytes are identical on every engine.
 */
import { S } from '../core/types';
import type { RecipeCore, SampleBuf, ToothSpec } from '../core/types';
import { dcos, dsin, rnd, Ch, PI, TAU } from '../core/det';
import { smoothstep } from '../core/num';
import { TONES } from './color';
import { nibWidth } from './nibs';

/** Heightmap side, texels (a power of two: every octave tiles it exactly). */
export const TOOTH_N = 512;
/** Fibres laid over the noise. */
const FIBRES = 140;
/** The seed of the one paper (a constant: the tooth is the same on every document). */
const PAPER_SEED = 0x7007;

/** Smudge buckets (0 = upright stick, crisp grain; SMUDGE_LEVELS − 1 = laid on its side). */
export const SMUDGE_LEVELS = 4;
/** Pressure levels: the six pressure buckets of the tone index (tone = pBucket·5 + dBucket). */
export const TOOTH_LEVELS = 6;
/**
 * The stick's contact across the ribbon, laid down outside in: each step either adds density inside
 * a width scale or (negative) cuts that share of what is there, so the edges catch only the peaks,
 * the middle is full, and the cuts leave drag lanes until the next ring adds density again.
 */
export const TOOTH_CONTACT: readonly (readonly [scale: number, amount: number])[] = [
  [1, 0.2], [0.8, 0.3], [0.7, -0.45], [0.56, 0.5], [0.4, -0.35], [0.3, 0.496],
];

/** Density profile 0..1 at u = |offset| / half-width across the ribbon (0 = centreline). */
export function toothProfile(u: number): number {
  let p = 0;
  for (const [scale, amount] of TOOTH_CONTACT) if (u < scale) p = amount >= 0 ? p + amount : p * (1 + amount);
  return p;
}

/** Depth buckets per pressure bucket in a tone (tone = pBucket·DEPTHS + dBucket). */
const DEPTHS = TONES / TOOTH_LEVELS;

// ---------------------------------------------------------------------------- heightmap

/** Smooth value noise, periodic over TOOTH_N, with lattice cells of `cell` texels. */
function valueOctave(out: Float64Array, cell: number, ch: number, amp: number): void {
  const n = TOOTH_N, L = n / cell;
  const lat = new Float64Array(L * L);
  for (let j = 0; j < L; j++) for (let i = 0; i < L; i++) lat[j * L + i] = rnd(PAPER_SEED, ch, i, j);
  for (let y = 0; y < n; y++) {
    const fy = y / cell, j0 = Math.floor(fy), ty = fy - j0, sy = ty * ty * (3 - 2 * ty);
    const r0 = (j0 % L) * L, r1 = ((j0 + 1) % L) * L;
    for (let x = 0; x < n; x++) {
      const fx = x / cell, i0 = Math.floor(fx), tx = fx - i0, sx = tx * tx * (3 - 2 * tx);
      const i1 = (i0 + 1) % L;
      const a = lat[r0 + i0] + (lat[r0 + i1] - lat[r0 + i0]) * sx;
      const b = lat[r1 + i0] + (lat[r1 + i1] - lat[r1 + i0]) * sx;
      out[y * n + x] += amp * (a + (b - a) * sy);
    }
  }
}

/** Short, slightly curved raised fibres (wrapping), each a soft ridge about one texel wide. */
function fibres(out: Float64Array): void {
  const n = TOOTH_N;
  for (let f = 0; f < FIBRES; f++) {
    let x = rnd(PAPER_SEED, Ch.Geometry, f, 0) * n, y = rnd(PAPER_SEED, Ch.Geometry, f, 1) * n;
    let a = rnd(PAPER_SEED, Ch.Angle, f) * TAU;
    const bend = (rnd(PAPER_SEED, Ch.Lean, f) - 0.5) * 0.02;
    const len = 18 + rnd(PAPER_SEED, Ch.Length, f) * 40;
    const h = 0.05 + 0.05 * rnd(PAPER_SEED, Ch.Misc, f);
    for (let s = 0; s < len; s += 0.5) {
      const xi = Math.floor(x), yi = Math.floor(y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = xi + dx, py = yi + dy;
          const ex = px + 0.5 - x, ey = py + 0.5 - y, d2 = ex * ex + ey * ey;
          if (d2 >= 1.2) continue;
          const k = ((py % n) + n) % n * n + (((px % n) + n) % n);
          out[k] += h * (1 - d2 / 1.2);
        }
      }
      x += dcos(a) * 0.5; y += dsin(a) * 0.5; a += bend;
    }
  }
}

/**
 * Equalise to bytes 0..255 through a 4096-bin histogram of the value range: a byte v covers about
 * a fraction (v + 0.5)/256 of the map. Equal values always get equal bytes (no ordering of ties).
 */
function equalise(h: Float64Array): Uint8Array {
  const n = h.length, BINS = 4096;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  const k = hi > lo ? (BINS - 1) / (hi - lo) : 0;
  const bin = new Uint16Array(n), cum = new Float64Array(BINS);
  for (let i = 0; i < n; i++) { bin[i] = Math.floor((h[i] - lo) * k); cum[bin[i]]++; }
  // byte of a bin: the mid-rank of its members
  let below = 0;
  for (let b = 0; b < BINS; b++) { const c = cum[b]; cum[b] = Math.floor(((below + 0.5 * c) * 256) / n); below += c; }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = cum[bin[i]] > 255 ? 255 : cum[bin[i]];
  return out;
}

/** One 3 × 3 wrapping box blur of `a` into a new map. */
function blur(a: Float64Array): Float64Array {
  const n = TOOTH_N, b = new Float64Array(a.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const r = ((y + dy + n) % n) * n;
        for (let dx = -1; dx <= 1; dx++) s += a[r + ((x + dx + n) % n)];
      }
      b[y * n + x] = s / 9;
    }
  }
  return b;
}

let maps: { crisp: Uint8Array; soft: Uint8Array } | null = null;

/** The tooth heightmaps (crisp and smudged), TOOTH_N² bytes each, row-major. Built once (≈ 10 ms). */
export function toothMaps(): { crisp: Uint8Array; soft: Uint8Array } {
  if (maps) return maps;
  const h = new Float64Array(TOOTH_N * TOOTH_N);
  valueOctave(h, 2, Ch.Jitter, 0.50);
  valueOctave(h, 8, Ch.Growth, 0.28);
  valueOctave(h, 32, Ch.Field, 0.14);
  fibres(h);
  maps = { crisp: equalise(h), soft: equalise(blur(blur(h))) };
  return maps;
}

// ---------------------------------------------------------------------------- coverage

/** Pressure level 0..5 of a colour-table index (tone = index mod TONES; tone = pBucket·5 + dBucket). */
export function toothLevel(tableIndex: number): number {
  return ((tableIndex % TONES) / DEPTHS) | 0;
}

/**
 * The colour-table index a charcoal mark is tinted with: its tone at the heaviest pressure bucket.
 * Pigment is the same at any pressure (pressure shows as how much of the tooth it fills), so the
 * stroke has one colour per depth bucket and never steps where its pressure bucket changes.
 */
export function toothInk(tableIndex: number): number {
  return tableIndex + DEPTHS * (TOOTH_LEVELS - 1 - toothLevel(tableIndex));
}

/**
 * Density a pressure level lays down in the middle of the ribbon: about the fraction of the tooth it
 * fills there, from a third at the lightest touch to nearly all of it at the heaviest.
 */
export function toothDensity(level: number): number {
  return 0.48 + 0.56 * (level + 0.5) / TOOTH_LEVELS;
}

/**
 * Sharpness k of the threshold: coverage = clamp((H + D − 1)·2^k) over tooth height H and density
 * D, so it ramps over 1/8 of the height range above 1 − D and fills about a fraction D − 1/16 of
 * the tooth. (Smudge softens the grain through the blurred map, not the ramp.)
 */
export const TOOTH_GAIN = 3;

/** Tooth height byte at texel k for a smudge bucket: the crisp map blended toward the soft one. */
export function toothHeight(k: number, smudge: number): number {
  const m = toothMaps(), w = smudge / (SMUDGE_LEVELS - 1);
  return Math.round(m.crisp[k] + (m.soft[k] - m.crisp[k]) * w);
}

/**
 * Mean coverage of a whole charcoal ribbon at (level, smudge), for marks too small to show grain
 * (hairlines, far zoom, the stroke-cull dot): the threshold averaged over the equalised tooth and
 * over the ring profile across the width.
 */
const solids = new Float64Array(TOOTH_LEVELS * SMUDGE_LEVELS).fill(NaN);
export function toothSolid(level: number, smudge: number): number {
  const key = level * SMUDGE_LEVELS + smudge, have = solids[key];
  if (have === have) return have;
  const g = 1 << TOOTH_GAIN, d = toothDensity(level), U = 64;
  let sum = 0;
  for (let k = 0; k < U; k++) {
    const D = d * toothProfile((k + 0.5) / U);
    for (let v = 0; v < 256; v++) { const x = (v + 0.5) / 256 + D - 1; sum += Math.min(1, Math.max(0, x * g)); }
  }
  sum /= U * 256;
  return (solids[key] = sum);
}

// ---------------------------------------------------------------------------- per stroke

/** Doc units per texel: the power of two nearest to one sp at commit zoom z (z·cell in [0.71, 1.42)). */
export function toothCell(z: number): number {
  let cell = 1;
  if (!(z > 0)) return cell;
  while (z * cell >= 1.4142135623730951) cell *= 0.5;
  while (z * cell < 0.7071067811865476) cell *= 2;
  return cell;
}

/** Pen altitude of a stroke's first sample (NaN when it is unknown or there is no sample yet). */
function firstAlt(samples: Float32Array | SampleBuf): number {
  const d = samples instanceof Float32Array ? samples : samples.data;
  const n = samples instanceof Float32Array ? Math.floor(d.length / S.STRIDE) : samples.n;
  return n < 1 ? NaN : d[S.ALT];
}

/** Lean at pen-down → smudge bucket: tK = smoothstep(60°, 25°, alt) of the first sample, bucketed. */
export function toothSmudge(samples: Float32Array | SampleBuf): number {
  const alt = firstAlt(samples);
  if (!(alt === alt)) return 0;
  const tK = smoothstep(60 * PI / 180, 25 * PI / 180, alt);
  return Math.round(tK * (SMUDGE_LEVELS - 1));
}

/** The tooth a charcoal stroke draws with (undefined for every other nib). */
export function toothFor(r: RecipeCore & { samples: Float32Array | SampleBuf }): ToothSpec | undefined {
  if (r.stroke.nib !== 'charcoal') return undefined;
  const cell = toothCell(r.z), period = cell * TOOTH_N;
  const mod = (v: number): number => { const q = v % period; return q < 0 ? q + period : q; };
  // the nominal width (mid pressure, the lean at pen-down), which a draft and its commit share
  const w = nibWidth('charcoal', r.stroke.size, 0.5, NaN, r.device, firstAlt(r.samples)) / r.z;
  return { cell, ox: mod(r.origin[0]), oy: mod(r.origin[1]), smudge: toothSmudge(r.samples), w };
}
