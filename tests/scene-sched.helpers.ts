/**
 * Test fixtures for the scene-sched group: a minimal in-memory Doc, synthetic
 * recipes, synthetic Cooked geometry and a fake spine builder. Nothing here
 * depends on other groups' modules (doc/, ink/), which are written in parallel.
 */
import { S, PolyKind } from '../src/core/types';
import type {
  AABB, Calib, Command, Cooked, Doc, DocChange, DocMeta, InkId, Spine, StrokeId, StrokeRecipe,
} from '../src/core/types';

export const CALIB: Calib = { lo: 0.04, hi: 0.8, gamma: 1, flat: 1, vMed: 0.9, jitter: 0.3, fcMin: 2 };

/** Ids that sort by creation like the real ones: base36(ms) padded 9 + base36(counter) padded 4. */
export const makeId = (n: number, ms = 1700000000000): StrokeId =>
  ms.toString(36).padStart(9, '0') + n.toString(36).padStart(4, '0');

export interface RecipeOpts {
  id?: StrokeId;
  n?: number;                 // counter for the id
  pts: ArrayLike<readonly [number, number]> | readonly (readonly [number, number])[]; // doc, relative to origin
  origin?: readonly [number, number];
  z?: number;
  size?: number;
  ink?: InkId;
  form?: StrokeRecipe['form']['form'];
  base?: number;
  created?: number;
  dt?: number;                // ms between samples
  geomRev?: number;
  colorRev?: number;
  seed?: number;
}

let autoN = 1;

/** A committed recipe whose samples pass through `pts` (doc units relative to origin). */
export function makeRecipe(o: RecipeOpts): StrokeRecipe {
  const pts = Array.from(o.pts as ArrayLike<readonly [number, number]>);
  const samples = new Float32Array(pts.length * S.STRIDE);
  const dt = o.dt ?? 8;
  pts.forEach(([x, y], i) => {
    const k = i * S.STRIDE;
    samples[k + S.X] = x; samples[k + S.Y] = y; samples[k + S.T] = i * dt;
    samples[k + S.P] = NaN; samples[k + S.ALT] = Math.PI / 2; samples[k + S.AZ] = 0;
    samples[k + S.R] = NaN; samples[k + S.C] = 0; samples[k + S.CS] = 0;
  });
  const n = o.n ?? autoN++;
  return {
    id: o.id ?? makeId(n),
    created: o.created ?? 1000,
    origin: o.origin ?? [0, 0],
    z: o.z ?? 1,
    rot: 0,
    seed: o.seed ?? 12345,
    device: 'mouse',
    calib: CALIB,
    stroke: { nib: 'brush', size: o.size ?? 9 },
    color: { ink: o.ink ?? 'moss', k: 0, dh: 0, dL: 0, lch: null },
    form: { form: o.form ?? 'line', v: 1, base: o.base ?? 0 },
    s0: 0, cut: 0, resume: null,
    samples,
    pools: new Float32Array(0),
    closed: false,
    radial: pts.length < 2,
    sym: null,
    xf: null,
    geomRev: o.geomRev ?? 0,
    colorRev: o.colorRev ?? 0,
  };
}

/** Straight line of `count` points from (x0, y0) to (x1, y1). */
export function linePts(x0: number, y0: number, x1: number, y1: number, count = 20): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
  }
  return out;
}

export interface PolySpec {
  pts: readonly (readonly [number, number, number])[]; // x, y, w (doc, relative to origin)
  alpha?: number;
  gen?: number;
  kind?: PolyKind;
}

/** Build a well-formed Cooked from poly specs (polys must be given sorted by gen). */
export function makeCooked(polys: readonly PolySpec[], origin: readonly [number, number] = [0, 0]): Cooked {
  const nPts = polys.reduce((a, p) => a + p.pts.length, 0);
  const nPolys = polys.length;
  const pts = new Float32Array(nPts * 4);
  const start = new Uint32Array(nPolys), count = new Uint32Array(nPolys);
  const kind = new Uint8Array(nPolys), gen = new Uint8Array(nPolys), tone = new Uint8Array(nPolys);
  const alpha = new Float32Array(nPolys), born = new Float32Array(nPolys);
  const unit = new Uint32Array(nPolys), box = new Float32Array(nPolys * 4);
  let k = 0;
  const ink: AABB = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const hit: AABB = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let maxGen = 0;
  polys.forEach((p, i) => {
    start[i] = k; count[i] = p.pts.length;
    kind[i] = p.kind ?? (p.pts.length === 1 ? PolyKind.Dot : PolyKind.Ribbon);
    gen[i] = p.gen ?? 0; alpha[i] = p.alpha ?? 1; unit[i] = i;
    if (gen[i] > maxGen) maxGen = gen[i];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, a = 0;
    p.pts.forEach(([x, y, w], j) => {
      if (j > 0) a += Math.hypot(x - p.pts[j - 1][0], y - p.pts[j - 1][1]);
      pts[k * 4] = x; pts[k * 4 + 1] = y; pts[k * 4 + 2] = w; pts[k * 4 + 3] = a;
      bx0 = Math.min(bx0, x - w / 2); by0 = Math.min(by0, y - w / 2);
      bx1 = Math.max(bx1, x + w / 2); by1 = Math.max(by1, y + w / 2);
      k++;
    });
    box.set([bx0, by0, bx1, by1], i * 4);
    const grow = (b: AABB) => {
      b.x0 = Math.min(b.x0, origin[0] + bx0); b.y0 = Math.min(b.y0, origin[1] + by0);
      b.x1 = Math.max(b.x1, origin[0] + bx1); b.y1 = Math.max(b.y1, origin[1] + by1);
    };
    grow(ink);
    if (alpha[i] >= 0.3) grow(hit);
  });
  const genStart = new Uint32Array(maxGen + 2);
  for (let g = 0; g <= maxGen + 1; g++) {
    let first = nPolys;
    for (let i = 0; i < nPolys; i++) if (gen[i] >= g) { first = i; break; }
    genStart[g] = first;
  }
  const c: Cooked = {
    pts, ang: null, start, count, kind, gen, tone, alpha, born, unit, box, genStart,
    nPolys, nPts, inkBox: ink, hitBox: hit, ceilingMax: 0, coverage: 0, bytes: 0,
  };
  c.bytes = [pts, start, count, kind, gen, tone, alpha, born, unit, box, genStart].reduce((a, t) => a + t.byteLength, 0);
  return c;
}

/** Synthetic cook: one ribbon along the samples (width w doc), plus optional extra polys. */
export function trunkCooked(r: StrokeRecipe, w = 4, extra: PolySpec[] = []): Cooked {
  const n = r.samples.length / S.STRIDE;
  const trunk: [number, number, number][] = [];
  for (let i = 0; i < n; i++) trunk.push([r.samples[i * S.STRIDE + S.X], r.samples[i * S.STRIDE + S.Y], w]);
  return makeCooked([{ pts: trunk, alpha: 1, gen: 0 }, ...extra], r.origin);
}

/** Fake spineOf: stations at the samples, constant untapered width `w` (doc). */
export function fakeSpineOf(w: number) {
  const cache = new WeakMap<StrokeRecipe, Spine>();
  const fn = (r: StrokeRecipe): Spine => {
    let sp = cache.get(r);
    if (sp) return sp;
    const n = r.samples.length / S.STRIDE;
    const f = () => new Float32Array(n);
    sp = {
      n, x: f(), y: f(), s: f(), t: f(), p: f(), w: f(), vn: f(), k: f(), c: f(), cs: f(),
      alt: f(), az: f(), nx: f(), ny: f(), corner: new Uint8Array(n), settled: n, L: 0, z: r.z,
    };
    for (let i = 0; i < n; i++) {
      sp.x[i] = r.samples[i * S.STRIDE + S.X];
      sp.y[i] = r.samples[i * S.STRIDE + S.Y];
      sp.w[i] = w;
    }
    cache.set(r, sp);
    fn.calls++;
    return sp;
  };
  fn.calls = 0;
  return fn;
}

/** In-memory Doc that reports changes like the real one (DocChange per apply). */
export class FakeDoc implements Doc {
  private strokes = new Map<StrokeId, StrokeRecipe>();
  private subs = new Set<(ch: DocChange) => void>();
  meta: DocMeta = {
    id: 'doc', title: 't', created: 0, updated: 0, docSeed: 1, counter: 0,
    inkCounters: { graphite: 0, indigo: 0, oxide: 0, ochre: 0, moss: 0, rose: 0, spectral: 0, custom: 0 },
    ground: 'night', camera: { cx: 0, cy: 0, scale: 1, rot: 0 },
  };
  changes: DocChange[] = [];

  constructor(initial: readonly StrokeRecipe[] = []) { for (const r of initial) this.strokes.set(r.id, r); }
  get(id: StrokeId) { return this.strokes.get(id); }
  has(id: StrokeId) { return this.strokes.has(id); }
  ordered() { return [...this.strokes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  get size() { return this.strokes.size; }
  nextSeed() { return ++this.meta.counter; }
  nextVariant(ink: InkId) { return this.meta.inkCounters[ink]++; }
  nextId() { return makeId(++this.meta.counter); }
  setView(v: Partial<Pick<DocMeta, 'ground' | 'camera'>>) {
    Object.assign(this.meta, v);
    const ch: DocChange = { added: [], removed: [], geometry: [], color: [], meta: true, view: true };
    for (const fn of this.subs) fn(ch);
  }
  subscribe(fn: (ch: DocChange) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  get subscribers() { return this.subs.size; }

  apply(c: Command): Command {
    const ch: DocChange = { added: [], removed: [], geometry: [], color: [], meta: false, view: false };
    const inv = this.exec(c, ch);
    this.changes.push(ch);
    for (const fn of this.subs) fn(ch);
    return inv;
  }

  private exec(c: Command, ch: DocChange): Command {
    switch (c.k) {
      case 'add':
        for (const r of c.recipes) { this.strokes.set(r.id, r); ch.added.push(r.id); }
        return { k: 'remove', ids: c.recipes.map(r => r.id) };
      case 'remove': {
        const gone: StrokeRecipe[] = [];
        for (const id of c.ids) {
          const r = this.strokes.get(id);
          if (r) { gone.push(r); this.strokes.delete(id); ch.removed.push(id); }
        }
        return { k: 'add', recipes: gone };
      }
      case 'replace':
        c.after.forEach((r, i) => {
          const before = c.before[i];
          this.strokes.set(r.id, r);
          (before.geomRev !== r.geomRev ? ch.geometry : ch.color).push(r.id);
        });
        return { k: 'replace', before: c.after, after: c.before };
      case 'meta':
        ch.meta = true;
        return { k: 'meta', patch: { title: this.meta.title } };
      case 'batch': {
        const invs = c.cmds.map(x => this.exec(x, ch));
        return { k: 'batch', cmds: invs.reverse() };
      }
    }
  }
}

/** Seeded PRNG for property tests. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fake clock for jobs/frame tests. */
export function fakeClock(start = 0) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => { c.t += ms; } };
  return c;
}
