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
 * when you zoom. How much of the tooth a mark fills (`toothLut`) depends on pressure, through the
 * poly's tone (its pressure bucket), and on the pen's lean at pen-down (`toothSmudge`): the side of
 * the stick smears pigment into the valleys.
 *
 * Presentation only: the tooth never feeds geometry, ids or sceneHash. It still uses only the
 * §7.5 allow-list and det.ts, so the bytes are identical on every engine.
 */
import { S } from '../core/types';
import type { RecipeCore, SampleBuf, ToothSpec } from '../core/types';
import { dcos, dsin, rnd, Ch, PI, TAU } from '../core/det';
import { smoothstep } from '../core/num';
import { TONES } from './color';

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
/** The two passes of a charcoal fill: the full-width fringe catches only the peaks; the core is denser. */
export const enum ToothPass { Fringe = 0, Core = 1 }
/** Width of the core pass as a fraction of the ribbon (tessellation widthScale). */
export const CORE_WIDTH = 0.62;

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
  return ((tableIndex % TONES) / 5) | 0;
}

/**
 * Threshold `t` of a pass: heavier pressure lowers the threshold so the
 * charcoal reaches further down into the valleys. Level 0 (lightest) catches the top third of the
 * tooth in the core; level 5 (heaviest) fills about 85 %. The fringe sits 0.2 higher.
 */
function threshold(level: number, pass: ToothPass): number {
  const p = (level + 0.5) / TOOTH_LEVELS;
  return 0.72 - 0.62 * p + (pass === ToothPass.Fringe ? 0.2 : 0);
}

/**
 * Coverage (0..255) per tooth height of one pass on its own: smoothstep(t − e, t + e, H). Smudge
 * (the side of the stick dragging pigment into the valleys) lowers t by up to 0.06, widens the edge
 * e from 0.07 to 0.2 and reads H from a blend toward the blurred map (toothHeight), so the grain
 * goes soft and fuller. (A floor of pigment across the valleys was tried and dropped: it showed the
 * ribbon's straight outline.) The renderer lays the core over the fringe so that the two together
 * cover exactly max(core, fringe) (render/tooth.ts).
 */
export function toothLut(level: number, smudge: number, pass: ToothPass): Uint8Array {
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) out[v] = Math.round(255 * coverage(level, smudge, pass, (v + 0.5) / 256));
  return out;
}

/** Coverage 0..1 of one pass on its own at tooth height H. */
function coverage(level: number, smudge: number, pass: ToothPass, H: number): number {
  const s = smudge / (SMUDGE_LEVELS - 1);
  const t = threshold(level, pass) - 0.06 * s, e = 0.07 + 0.13 * s;
  return smoothstep(t - e, t + e, H);
}

/** Tooth height byte at texel k for a smudge bucket: the crisp map blended toward the soft one. */
export function toothHeight(k: number, smudge: number): number {
  const m = toothMaps(), w = smudge / (SMUDGE_LEVELS - 1);
  return Math.round(m.crisp[k] + (m.soft[k] - m.crisp[k]) * w);
}

/**
 * Solid-equivalent coverage of a whole charcoal ribbon at (level, smudge), for marks too small to
 * show grain (hairlines, far zoom, the stroke-cull dot): the fringe alone outside the core, the
 * larger of the two inside it (the core pass adds exactly the difference, render/tooth.ts).
 */
const solids = new Float64Array(TOOTH_LEVELS * SMUDGE_LEVELS).fill(NaN);
export function toothSolid(level: number, smudge: number): number {
  const key = level * SMUDGE_LEVELS + smudge, have = solids[key];
  if (have === have) return have;
  let f = 0, c = 0;
  for (let v = 0; v < 256; v++) {
    const H = (v + 0.5) / 256;
    f += coverage(level, smudge, ToothPass.Fringe, H);
    c += Math.max(coverage(level, smudge, ToothPass.Core, H), coverage(level, smudge, ToothPass.Fringe, H));
  }
  return (solids[key] = ((1 - CORE_WIDTH) * f + CORE_WIDTH * c) / 256);
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

/** Lean at pen-down → smudge bucket: tK = smoothstep(60°, 25°, alt) of the first sample, bucketed. */
export function toothSmudge(samples: Float32Array | SampleBuf): number {
  const d = samples instanceof Float32Array ? samples : samples.data;
  const n = samples instanceof Float32Array ? Math.floor(d.length / S.STRIDE) : samples.n;
  if (n < 1) return 0;
  const alt = d[S.ALT];
  if (!(alt === alt)) return 0;
  const tK = smoothstep(60 * PI / 180, 25 * PI / 180, alt);
  return Math.round(tK * (SMUDGE_LEVELS - 1));
}

/** The tooth a charcoal stroke draws with (undefined for every other nib). */
export function toothFor(r: RecipeCore & { samples: Float32Array | SampleBuf }): ToothSpec | undefined {
  if (r.stroke.nib !== 'charcoal') return undefined;
  const cell = toothCell(r.z), period = cell * TOOTH_N;
  const mod = (v: number): number => { const q = v % period; return q < 0 ? q + period : q; };
  return { cell, ox: mod(r.origin[0]), oy: mod(r.origin[1]), smudge: toothSmudge(r.samples) };
}
