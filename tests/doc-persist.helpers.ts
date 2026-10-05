/** Deterministic recipe / document builders for the doc-persist tests. */
import { rnd } from '../src/core/det';
import type { Calib, ColorStyle, Device, FormId, InkId, NibId, StrokeRecipe } from '../src/core/types';
import { freezeRecipe } from '../src/doc/commands';

/** Seeded uniform [0, 1) stream built on the addressed hash (stable across engines). */
export function seeded(seed: number): () => number {
  let i = 0;
  return () => rnd(seed, 10, i++);
}
export const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
export const randInt = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

const DEVICES: readonly Device[] = ['pen', 'mouse', 'touch'];
const NIBS: readonly NibId[] = ['pen', 'brush', 'chisel'];
const FORMS: readonly FormId[] = ['line', 'echo', 'sprout', 'drift'];
const INKS: readonly InkId[] = ['graphite', 'indigo', 'oxide', 'ochre', 'moss', 'rose', 'spectral'];

export const CALIB: Calib = { lo: 0.04, hi: 0.8, gamma: 1, flat: 0.35, vMed: 0.9, jitter: 0.3, fcMin: 1.2 };

/** Samples along a wobbly path: pressure NaN for mouse/touch, radius NaN unless touch. */
export function makeSamples(rand: () => number, rows: number, device: Device): Float32Array {
  const a = new Float32Array(rows * 9);
  let x = 0, y = 0, t = 0;
  const heading = rand() * 6.283;
  for (let i = 0; i < rows; i++) {
    const o = i * 9;
    a[o] = x; a[o + 1] = y; a[o + 2] = t;
    a[o + 3] = device === 'pen' ? 0.2 + 0.7 * rand() : NaN;
    a[o + 4] = device === 'pen' ? 0.6 + 0.9 * rand() : Math.PI / 2;
    a[o + 5] = device === 'pen' ? rand() * 6.283 : 0;
    a[o + 6] = device === 'touch' ? 8 + 4 * rand() : NaN;
    a[o + 7] = rand() * 0.5;
    a[o + 8] = rand() * 2 - 1;
    const ang = heading + Math.sin(i * 0.3) * 0.8;
    x += Math.cos(ang) * (1 + 3 * rand());
    y += Math.sin(ang) * (1 + 3 * rand());
    t += 4 + 8 * rand();
  }
  return a;
}

/** A random (but fully deterministic for a seed) frozen recipe. */
export function randomRecipe(rand: () => number, id: string, opts: { pools?: boolean } = {}): StrokeRecipe {
  const device = pick(rand, DEVICES);
  const ink = rand() < 0.15 ? 'custom' as const : pick(rand, INKS);
  const color: ColorStyle = {
    ink, k: randInt(rand, 0, 40), dh: rand() * 8 - 4, dL: rand() * 0.06 - 0.03,
    lch: ink === 'custom' ? { night: [0.8, 0.12, rand() * 360], paper: [0.45, 0.1, rand() * 360] } : null,
  };
  const wantPools = opts.pools ?? rand() < 0.3;
  const nPools = wantPools ? randInt(rand, 1, 3) : 0;
  const pools = new Float32Array(nPools * 4);
  for (let i = 0; i < nPools; i++) { pools[i * 4] = rand() * 200; pools[i * 4 + 1] = Math.round(rand() * 48) / 16; pools[i * 4 + 2] = rand() * 900; pools[i * 4 + 3] = pools[i * 4 + 2] + 300; }
  const rows = randInt(rand, 1, 60);
  return freezeRecipe({
    id,
    created: 1_700_000_000_000 + Math.floor(rand() * 1e6),
    origin: [rand() * 4000 - 2000 + 0.1234567890123, rand() * 4000 - 2000],
    z: pick(rand, [0.25, 0.5, 1, 2, 3.7]),
    rot: 0,
    seed: Math.floor(rand() * 4294967296) >>> 0,
    device,
    calib: { ...CALIB, jitter: 0.2 + rand() * 0.4 },
    stroke: { nib: pick(rand, NIBS), size: 2 + rand() * 20 },
    color,
    form: { form: pick(rand, FORMS), v: 1, base: Math.round(rand() * 16) / 4 },
    s0: 0, cut: 0, resume: null,
    samples: makeSamples(rand, rows, device),
    pools,
    closed: rand() < 0.2,
    radial: rows < 3,
    sym: null, xf: null,
  });
}

/** Bitwise equality of two typed arrays. */
export function sameBits(a: ArrayBufferView | null, b: ArrayBufferView | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Deep equality of the persisted fields of two recipes: typed arrays bitwise, scalars with Object.is. */
export function recipeDiff(a: StrokeRecipe, b: StrokeRecipe): string | null {
  const arrays = ['samples', 'pools', 'resume', 'xf'] as const;
  for (const k of arrays) if (!sameBits(a[k], b[k])) return k;
  const flat = (v: unknown, path: string, out: [string, unknown][]): void => {
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
      for (const [k, x] of Object.entries(v)) flat(x, `${path}.${k}`, out);
    } else out.push([path, v]);
  };
  const fa: [string, unknown][] = [], fb: [string, unknown][] = [];
  const pick = (r: StrokeRecipe) => ({ id: r.id, created: r.created, origin: r.origin, z: r.z, rot: r.rot, seed: r.seed, device: r.device, calib: r.calib, stroke: r.stroke, color: r.color, form: r.form, s0: r.s0, cut: r.cut, closed: r.closed, radial: r.radial, sym: r.sym });
  flat(pick(a), '', fa); flat(pick(b), '', fb);
  if (fa.length !== fb.length) return 'shape';
  for (let i = 0; i < fa.length; i++) {
    if (fa[i][0] !== fb[i][0]) return `key ${fa[i][0]} vs ${fb[i][0]}`;
    if (!Object.is(fa[i][1], fb[i][1])) return `${fa[i][0]}: ${String(fa[i][1])} vs ${String(fb[i][1])}`;
  }
  return null;
}
