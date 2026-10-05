/**
 * Synthetic gestures for the ink-instrument tests: a tiny "hand" that moves at a
 * given speed, holds, varies pressure, and emits S.STRIDE sample rows at a fixed
 * rate. Deterministic (seeded PRNG for jitter).
 */
import type { Calib, Device, DraftStroke, NibId, StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import { DEFAULT_CALIB } from '../src/ink/calib';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HandOpts { hz?: number; p?: number; alt?: number; az?: number; jitter?: number; seed?: number; c?: number; cs?: number }

/** A hand in sp; emits rows with doc = sp / z. */
export class Hand {
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  readonly ts: number[] = [];
  readonly ps: number[] = [];
  readonly alts: number[] = [];
  readonly azs: number[] = [];
  readonly cs: number[] = [];
  readonly css: number[] = [];
  x: number; y: number; t = 0;
  p: number; alt: number; az: number; c: number; side: number;
  readonly dt: number;
  private readonly rand: () => number;
  private readonly sigma: number;

  constructor(x: number, y: number, o: HandOpts = {}) {
    this.x = x; this.y = y;
    this.dt = 1000 / (o.hz ?? 240);
    this.p = o.p ?? 0.6; this.alt = o.alt ?? Math.PI / 2; this.az = o.az ?? 0;
    this.c = o.c ?? 0; this.side = o.cs ?? 0;
    this.sigma = o.jitter ?? 0;
    this.rand = mulberry32(o.seed ?? 1);
    this.emit();
  }

  private gauss(): number {
    const u = Math.max(1e-12, this.rand()), v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  emit(): void {
    this.xs.push(this.x + this.sigma * this.gauss());
    this.ys.push(this.y + this.sigma * this.gauss());
    this.ts.push(this.t); this.ps.push(this.p); this.alts.push(this.alt); this.azs.push(this.az);
    this.cs.push(this.c); this.css.push(this.side);
  }

  /** Straight move at constant speed (sp/ms); optional pressure ramp to p1. */
  moveTo(x: number, y: number, speed: number, p1?: number): this {
    const dx = x - this.x, dy = y - this.y, L = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(L / (speed * this.dt)));
    const x0 = this.x, y0 = this.y, pa = this.p;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      this.x = x0 + dx * f; this.y = y0 + dy * f; this.t += this.dt;
      if (p1 !== undefined) this.p = pa + (p1 - pa) * f;
      this.emit();
    }
    return this;
  }

  /** Arc around (cx, cy) from angle a0 to a1 (radians, screen y-down) at constant speed. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, speed: number): this {
    const L = Math.abs(a1 - a0) * r;
    const steps = Math.max(1, Math.ceil(L / (speed * this.dt)));
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      this.x = cx + r * Math.cos(a); this.y = cy + r * Math.sin(a); this.t += this.dt;
      this.emit();
    }
    return this;
  }

  /** Stay put (rows keep arriving, as a pen does) for ms; optional pressure ramp. */
  hold(ms: number, p1?: number): this {
    const steps = Math.max(1, Math.round(ms / this.dt));
    const pa = this.p;
    for (let i = 1; i <= steps; i++) {
      this.t += this.dt;
      if (p1 !== undefined) this.p = pa + (p1 - pa) * (i / steps);
      this.emit();
    }
    return this;
  }

  /** Rows (S.STRIDE) in doc units for zoom z; P = NaN when `noPressure`. */
  rows(z = 1, noPressure = false): Float32Array {
    const n = this.ts.length, out = new Float32Array(n * S.STRIDE);
    for (let i = 0; i < n; i++) {
      const o = i * S.STRIDE;
      out[o + S.X] = this.xs[i] / z; out[o + S.Y] = this.ys[i] / z; out[o + S.T] = this.ts[i];
      out[o + S.P] = noPressure ? NaN : this.ps[i];
      out[o + S.ALT] = this.alts[i]; out[o + S.AZ] = this.azs[i]; out[o + S.R] = NaN;
      out[o + S.C] = this.cs[i]; out[o + S.CS] = this.css[i];
    }
    return out;
  }
}

export interface RecipeOpts {
  device?: Device; nib?: NibId; size?: number; z?: number; calib?: Calib; closed?: boolean;
  s0?: number; cut?: number; resume?: Float32Array | null; pools?: Float32Array; seed?: number;
}

/** A committed recipe over the given rows. */
export function recipe(samples: Float32Array, o: RecipeOpts = {}): StrokeRecipe {
  const device = o.device ?? 'pen';
  return {
    id: '000000000' + '0001', created: 0, origin: [100, 200], z: o.z ?? 1, rot: 0, seed: o.seed ?? 7,
    device, calib: o.calib ?? DEFAULT_CALIB[device],
    stroke: { nib: o.nib ?? 'brush', size: o.size ?? 9 },
    color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null },
    form: { form: 'line', v: 1, base: 0 },
    s0: o.s0 ?? 0, cut: o.cut ?? 0, resume: o.resume ?? null,
    samples, pools: o.pools ?? new Float32Array(0),
    closed: o.closed ?? false, radial: false, sym: null, xf: null, geomRev: 0, colorRev: 0,
  };
}

/** A draft over a recipe's rows whose sample buffer is revealed `feed(k)` rows at a time. */
export function draftOf(r: StrokeRecipe, closing = r.closed): { d: DraftStroke; total: number; feed(k: number): number } {
  const total = Math.floor(r.samples.length / S.STRIDE);
  const buf = { data: new Float32Array(16 * S.STRIDE), n: 0 };
  const d: DraftStroke = {
    origin: r.origin, z: r.z, rot: r.rot, seed: r.seed, device: r.device, calib: r.calib,
    stroke: r.stroke, color: r.color, form: r.form, s0: r.s0, cut: r.cut, resume: r.resume,
    samples: buf, pools: { data: new Float32Array(0), n: 0 }, closing,
  };
  return {
    d, total,
    feed(k: number): number {
      const n = Math.min(total, buf.n + k);
      if (n * S.STRIDE > buf.data.length) {
        // grow like app/draft.ts would: replace the array
        let c = buf.data.length;
        while (c < n * S.STRIDE) c *= 2;
        const g = new Float32Array(c); g.set(buf.data); buf.data = g;
      }
      buf.data.set(r.samples.subarray(buf.n * S.STRIDE, n * S.STRIDE), buf.n * S.STRIDE);
      buf.n = n;
      return n;
    },
  };
}

/** A scribble with corners, curves, speed changes and a pressure swell. */
export function scribble(seed = 3, jitter = 0.25, hz = 240): Hand {
  const h = new Hand(10, 10, { jitter, seed, hz, p: 0.3 });
  h.moveTo(60, 12, 0.4, 0.7).moveTo(120, 30, 1.6, 0.8);
  h.moveTo(150, 30, 0.12).hold(90);           // slow into a corner and dwell
  h.moveTo(150, 90, 0.15, 0.5);               // 90° corner
  h.arc(120, 90, 30, 0, Math.PI, 1.1);        // half circle
  h.moveTo(40, 140, 2.4, 0.2);                // fast run
  h.moveTo(42, 141, 0.05).hold(40);
  h.moveTo(20, 60, 0.9, 0.6);
  return h;
}

/** Same bytes? (NaN-safe, bitwise.) */
export function sameBits(a: ArrayLike<number> & { buffer?: ArrayBufferLike }, b: ArrayLike<number>, n: number): boolean {
  const fa = new Float32Array(n), fb = new Float32Array(n);
  for (let i = 0; i < n; i++) { fa[i] = a[i]; fb[i] = b[i]; }
  const ua = new Uint32Array(fa.buffer), ub = new Uint32Array(fb.buffer);
  for (let i = 0; i < n; i++) if (ua[i] !== ub[i]) return false;
  return true;
}
