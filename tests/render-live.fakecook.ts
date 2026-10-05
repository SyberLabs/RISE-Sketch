/**
 * A fake IncrementalCook for render-live tests and the sandbox. It follows the contract of the
 * real ink/cook.ts (gen-sorted live views with an additive `slot` array of drain ids, monotonic
 * drain ids with `replaces`, a provisional tail, pool regrow, finish with lift zones and an Echo
 * fold-out MorphSet) over synthetic geometry built from the draft's samples:
 *  - trunk: one station per sample, absolute 50 sp blocks, chunks split where the tone changes,
 *    adjacent chunks share their boundary point exactly; entry taper live, exit taper at finish;
 *  - sprout: anchors every 32 sp; each unit is a little curling tree (gen 1..3) truncated to the
 *    depth d(s) = base + pools (fractional: gen g drawn to clamp(d − g + 1, 0, 1) of its length);
 *  - drift: stations every 7 sp; a filament walks a smooth field and is split into thirds;
 *  - line: displaced trunk (gen 0 only); echo: trunk at α 0.55 plus a ghost while live, a crystal
 *    folding out at finish.
 * Options let tests switch off slot ids (drain-event path) and shuffle view order.
 */
import type {
  Cooked, DraftStroke, FormId, IncrementalCook, LiveView, MorphSet, NibId, PolyView, Spine, StrokeRecipe,
} from '../src/core/types';
import { PL, PolyKind, S } from '../src/core/types';
import { kernel } from '../src/ink/depth';

export interface FakeOpts {
  form?: FormId;
  base?: number;
  nib?: NibId;
  size?: number;
  z?: number;
  origin?: readonly [number, number];
  /** Provide `slot` ids in views (like ink/cook). Default true. */
  slots?: boolean;
  /** Reverse the order of growth units in views (index churn). Default false. */
  shuffle?: boolean;
  ink?: 'moss' | 'indigo' | 'oxide' | 'ochre' | 'rose' | 'graphite' | 'spectral';
  seed?: number;
}

/** A draft with growable sample / pool buffers. */
export interface FakeDraft extends DraftStroke {
  samples: { data: Float32Array; n: number };
  pools: { data: Float32Array; n: number };
}

export function makeDraft(o: FakeOpts = {}): FakeDraft {
  return {
    origin: o.origin ?? [0, 0], z: o.z ?? 1, rot: 0, seed: o.seed ?? 12345, device: 'pen',
    calib: { lo: 0.04, hi: 0.8, gamma: 1, flat: 1, vMed: 0.9, jitter: 0.3, fcMin: 2 },
    stroke: { nib: o.nib ?? 'brush', size: o.size ?? 9 },
    color: { ink: o.ink ?? 'moss', k: 0, dh: 0, dL: 0, lch: null },
    form: { form: o.form ?? 'sprout', v: 1, base: o.base ?? 2 },
    s0: 0, cut: 0, resume: null,
    samples: { data: new Float32Array(64 * S.STRIDE), n: 0 },
    pools: { data: new Float32Array(8 * PL.STRIDE), n: 0 },
    closing: false,
  };
}

/** Append one sample row (doc units relative to origin, t ms since down, p 0..1). */
export function addSample(d: FakeDraft, x: number, y: number, t: number, p = 0.6): void {
  const b = d.samples;
  if ((b.n + 1) * S.STRIDE > b.data.length) { const g = new Float32Array(b.data.length * 2); g.set(b.data); b.data = g; }
  const o = b.n * S.STRIDE;
  b.data[o + S.X] = x; b.data[o + S.Y] = y; b.data[o + S.T] = t; b.data[o + S.P] = p;
  b.data[o + S.ALT] = Math.PI / 2; b.data[o + S.AZ] = 0; b.data[o + S.R] = NaN; b.data[o + S.C] = 0; b.data[o + S.CS] = 0;
  b.n++;
}

/** Set (or add) a pool row. Returns its index. */
export function setPool(d: FakeDraft, s: number, a: number, t0: number, t1: number, index = -1): number {
  const b = d.pools;
  let i = index;
  if (i < 0) {
    i = b.n++;
    if (b.n * PL.STRIDE > b.data.length) { const g = new Float32Array(b.data.length * 2); g.set(b.data); b.data = g; }
  }
  const o = i * PL.STRIDE;
  b.data[o + PL.S] = s; b.data[o + PL.A] = a; b.data[o + PL.T0] = t0; b.data[o + PL.T1] = t1;
  return i;
}

/** A fresh draft with the same samples and pools as `d` (to cook a recipe variant from scratch). */
export function makeDraftFrom(d: FakeDraft): FakeDraft {
  const e = makeDraft();
  return { ...d, samples: { data: d.samples.data.slice(), n: d.samples.n }, pools: { data: e.pools.data, n: 0 } };
}

/** Freeze a draft into a recipe. */
export function freeze(d: FakeDraft, id: string): StrokeRecipe {
  return {
    id, created: 0, origin: d.origin, z: d.z, rot: 0, seed: d.seed, device: d.device, calib: d.calib,
    stroke: d.stroke, color: d.color, form: d.form, s0: 0, cut: 0, resume: null,
    samples: d.samples.data.slice(0, d.samples.n * S.STRIDE), pools: d.pools.data.slice(0, d.pools.n * PL.STRIDE),
    closed: d.closing, radial: false, sym: null, xf: null, geomRev: 0, colorRev: 0,
  };
}

// ---------------------------------------------------------------------------- polys

interface FPoly {
  kind: PolyKind; gen: number; alpha: number; tone: number; born: number; unit: number; cat: number;
  pts: number[]; // x, y, w triples (doc rel origin)
}

interface Unit { key: string; polys: FPoly[]; ids: number[]; sig: string }

const smooth = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const pBucket = (p: number): number => Math.max(0, Math.min(5, Math.floor(p * 6)));
const hash = (a: number, b: number): number => { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35); h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

const BLOCK = 50;
const REACH: Record<FormId, number> = { line: 36, echo: 0, sprout: 24, drift: 12, ripple: 24 };
const DMAX: Record<FormId, number> = { line: 5, echo: 5, sprout: 4, drift: 6, ripple: 6 };

/** The fake cook. */
export class FakeCook implements IncrementalCook {
  private readonly d: FakeDraft;
  private readonly o: Required<Pick<FakeOpts, 'slots' | 'shuffle'>>;
  private readonly form: FormId;
  private readonly sp: Spine;
  private blocks: Unit[] = [];
  private units = new Map<number, Unit>();
  private prov: FPoly[] = [];
  private provUnits: FPoly[] = [];
  private ghost: FPoly[] = [];
  private nextId = 0;
  private queue: { id: number; rep: number; p: FPoly | null }[] = [];
  private pending = new Map<number, number>();
  private done: Cooked | null = null;
  private doneMorph: MorphSet | null = null;
  private poolSig = '';
  /** Calls counted (tests). */
  views = 0;

  constructor(d: FakeDraft, o: FakeOpts = {}) {
    this.d = d;
    this.o = { slots: o.slots ?? true, shuffle: o.shuffle ?? false };
    this.form = d.form.form;
    this.sp = {
      n: 0, x: new Float32Array(0), y: new Float32Array(0), s: new Float32Array(0), t: new Float32Array(0),
      p: new Float32Array(0), w: new Float32Array(0), vn: new Float32Array(0), k: new Float32Array(0),
      c: new Float32Array(0), cs: new Float32Array(0), alt: new Float32Array(0), az: new Float32Array(0),
      nx: new Float32Array(0), ny: new Float32Array(0), corner: new Uint8Array(0), settled: 0, L: 0, z: 1,
    };
  }

  // ---- spine from samples (one station per sample)
  private rebuildSpine(): void {
    const b = this.d.samples, n = b.n, z = this.d.z, sp = this.sp;
    if (sp.x.length < n) {
      const c = Math.max(64, 2 * n);
      for (const k of ['x', 'y', 's', 't', 'p', 'w', 'vn', 'k', 'c', 'cs', 'alt', 'az', 'nx', 'ny'] as const) {
        const a = new Float32Array(c); a.set(sp[k]); sp[k] = a;
      }
    }
    let s = 0;
    for (let i = 0; i < n; i++) {
      const o = i * S.STRIDE;
      const x = b.data[o + S.X], y = b.data[o + S.Y];
      if (i > 0) s += Math.hypot(x - sp.x[i - 1], y - sp.y[i - 1]) * z;
      sp.x[i] = x; sp.y[i] = y; sp.s[i] = s; sp.t[i] = b.data[o + S.T];
      const p = b.data[o + S.P];
      sp.p[i] = p === p ? p : 0.6;
      sp.w[i] = this.d.stroke.size * (0.3 + 0.7 * sp.p[i]) / z;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
      let tx = sp.x[c] - sp.x[a], ty = sp.y[c] - sp.y[a];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      sp.nx[i] = -ty; sp.ny[i] = tx;
    }
    sp.n = n;
    sp.L = n > 0 ? sp.s[n - 1] : 0;
    const sArc = sp.L - 24 - REACH[this.form];
    let k = 0;
    while (k < n && sp.s[k] <= sArc) k++;
    sp.settled = Math.max(sp.settled, k);
  }

  private depthAt(s: number): number {
    const P = this.d.pools;
    let m = 0;
    for (let i = 0; i < P.n; i++) {
      const o = i * PL.STRIDE, a = P.data[o + PL.A];
      const v = a * kernel(s - P.data[o + PL.S]);
      if (v > m) m = v;
    }
    return this.d.form.base + m;
  }

  /** Station position/normal/width at arc s (linear). */
  private at(s: number): { x: number; y: number; nx: number; ny: number; w: number; p: number } {
    const sp = this.sp, n = sp.n;
    let i = 0;
    while (i < n - 2 && sp.s[i + 1] < s) i++;
    const ds = sp.s[i + 1] - sp.s[i];
    const t = n > 1 && ds > 0 ? Math.max(0, Math.min(1, (s - sp.s[i]) / ds)) : 0;
    const j = Math.min(n - 1, i + 1);
    return {
      x: sp.x[i] + (sp.x[j] - sp.x[i]) * t, y: sp.y[i] + (sp.y[j] - sp.y[i]) * t,
      nx: sp.nx[i], ny: sp.ny[i], w: sp.w[i], p: sp.p[i],
    };
  }

  // ---- trunk
  private env(s: number, final: boolean): number {
    const e = smooth(0, 20, s);
    if (!final) return e;
    const L = this.sp.L, x = smooth(0, 40, L - s);
    return e * Math.pow(x, 0.6);
  }

  private trunkPolys(i0: number, i1: number, u: number, final: boolean): FPoly[] {
    const sp = this.sp, out: FPoly[] = [];
    const lineAmp = this.form === 'line' ? Math.min(DMAX.line, this.depthAt(sp.s[i0])) : 0;
    const alpha = this.form === 'echo' ? 0.55 : 1, wMul = this.form === 'echo' ? 0.6 : 1;
    let k0 = i0;
    const tone = (i: number): number => pBucket(sp.p[i]) * 5;
    for (let k = i0 + 1; k <= i1; k++) {
      if (k < i1 && tone(k) === tone(k0)) continue;
      const pts: number[] = [];
      for (let q = k0; q <= k; q++) {
        const s = sp.s[q];
        const off = lineAmp > 0 ? (Math.sin(s * 0.21) * 0.6 + Math.sin(s * 0.57 + 1) * 0.3) * lineAmp * 1.6 / this.d.z : 0;
        pts.push(sp.x[q] + sp.nx[q] * off, sp.y[q] + sp.ny[q] * off, sp.w[q] * wMul * this.env(s, final));
      }
      out.push({ kind: this.d.stroke.nib === 'chisel' ? PolyKind.Chisel : PolyKind.Ribbon, gen: 0, alpha, tone: tone(k0), born: sp.s[k0], unit: u, cat: 0, pts });
      k0 = k;
    }
    return out;
  }

  /** Blocks over stations up to `hi` (live: complete and settled blocks only). */
  private extendBlocks(final: boolean): void {
    const sp = this.sp, n = sp.n;
    if (n < 2) return;
    const settledArc = final ? Infinity : sp.L - 24 - REACH[this.form];
    for (;;) {
      const u = this.blocks.length;
      const i0 = u > 0 ? this.blockEnd(u - 1) : 0;
      if (i0 >= n - 1) break;
      let i1 = i0 + 1;
      while (i1 < n - 1 && sp.s[i1] < BLOCK * (u + 1)) i1++;
      if (!final && (sp.s[i1] < BLOCK * (u + 1) || sp.s[i1] > settledArc)) break;
      const blk: Unit = { key: 'b' + u, polys: this.trunkPolys(i0, i1, u, false), ids: [], sig: '' };
      this.blocks.push(blk);
      this.blockI1.push(i1);
      this.settle(blk);
    }
  }
  private blockI1: number[] = [];
  private blockEnd(u: number): number { return this.blockI1[u] ?? 0; }

  // ---- growth
  private anchors(final: boolean): number[] {
    const out: number[] = [];
    const L = this.sp.L;
    if (this.form === 'sprout') for (let s = 20; s <= (final ? L - 6 : L); s += 32) out.push(s);
    else if (this.form === 'drift') for (let s = 2.5; s <= (final ? L - 2 : L); s += 7) out.push(s);
    return out;
  }

  private unitPolys(j: number, s: number): FPoly[] {
    const D = Math.min(DMAX[this.form], this.depthAt(s));
    const a = this.at(s), z = this.d.z, out: FPoly[] = [];
    const eIn = this.env(s, false);
    const wb = Math.max(0.35 / z, a.w * 0.55 * eIn);
    const tone = (g: number): number => pBucket(a.p) * 5 + Math.min(g, 4);
    if (this.form === 'sprout') {
      const side = j % 2 === 0 ? 1 : -1;
      const grow = (x: number, y: number, h: number, len: number, g: number, curl: number): void => {
        const f = Math.max(0, Math.min(1, D - g + 1));
        if (f <= 0 || g > 4) return;
        const n = Math.max(2, Math.round((len * f) / 2));
        const step = (len * f) / n / z;
        const pts: number[] = [x, y, wb * Math.pow(0.66, g - 1)];
        let hx = Math.cos(h), hy = Math.sin(h), px = x, py = y;
        const nodes: [number, number, number][] = [];
        for (let k = 1; k <= n; k++) {
          const th = Math.atan2(hy, hx) + curl * step * z + 0.012 * step * z * (hx > 0 ? -1 : 1);
          hx = Math.cos(th); hy = Math.sin(th);
          px += hx * step; py += hy * step;
          const u = (k * f) / n;
          pts.push(px, py, wb * Math.pow(0.66, g - 1) * (1 - 0.34 * u));
          if (k === Math.round(n / 3) || k === Math.round((2 * n) / 3)) nodes.push([px, py, th]);
        }
        out.push({ kind: PolyKind.Ribbon, gen: g, alpha: 0.92 * Math.pow(0.72, g - 1), tone: tone(g), born: s, unit: j, cat: 1, pts });
        const theta = 0.5 + 0.3 * hash(j, g);
        nodes.forEach(([nx, ny, th], q) => grow(nx, ny, th + (q % 2 ? -theta : theta), len * 0.55, g + 1, curl * 1.3));
      };
      const h0 = Math.atan2(a.ny * side, a.nx * side) - 0.35 * side;
      grow(a.x, a.y, h0, (20 + 2 * this.d.stroke.size) * (0.6 + 0.8 * hash(j, 7)), 1, 0.03 * side);
    } else if (this.form === 'drift') {
      const N = (d: number): number => 18 * Math.min(Math.max(d, 0), 1) + 26.4 * Math.max(0, d - 1);
      const nSteps = Math.round(70 * N(D) / 150);
      if (nSteps < 3) return out;
      const pts: [number, number, number][] = [];
      let x = a.x, y = a.y;
      for (let k = 0; k <= nSteps; k++) {
        pts.push([x, y, 0.55 * a.w * eIn * Math.pow(1 - k / (nSteps + 1), 2)]);
        const fx = Math.sin(y * z * 0.021 + j * 0.1) + Math.cos(x * z * 0.017);
        const fy = Math.cos(x * z * 0.019) - Math.sin(y * z * 0.015 + 1);
        const L = Math.hypot(fx, fy) || 1;
        x += (fx / L) * 1.7 / z; y += (fy / L) * 1.7 / z;
      }
      const third = Math.ceil(pts.length / 3);
      for (let q = 0; q < 3; q++) {
        const a0 = q * third, a1 = Math.min(pts.length - 1, (q + 1) * third);
        if (a1 - a0 < 1) break;
        const pp: number[] = [];
        for (let k = a0; k <= a1; k++) pp.push(...pts[k]);
        out.push({ kind: PolyKind.Ribbon, gen: 1, alpha: 0.38, tone: pBucket(a.p) * 5 + 1 + q, born: s, unit: j, cat: 1, pts: pp });
      }
    }
    return out;
  }

  private refreshUnits(final: boolean): void {
    const sp = this.sp, settledArc = final ? Infinity : sp.L - 24 - REACH[this.form];
    const ss = this.anchors(final);
    for (let j = 0; j < ss.length; j++) {
      const s = ss[j];
      if (s + 24 > settledArc) break;
      const sig = this.depthAt(s).toFixed(4) + (final ? 'f' : '');
      let u = this.units.get(j);
      if (u && (u.sig === sig || (final && u.sig + 'f' === sig))) continue;
      if (!u) { u = { key: 'u' + j, polys: [], ids: [], sig: '' }; this.units.set(j, u); }
      u.polys = this.unitPolys(j, s);
      u.sig = sig;
      if (!final) this.settle(u);
    }
    // provisional growth under a raised depth (a hold rises right under the nib)
    this.provUnits = [];
    if (!final) {
      for (let j = 0; j < ss.length; j++) {
        if (this.units.has(j)) continue;
        if (this.depthAt(ss[j]) > this.d.form.base) this.provUnits.push(...this.unitPolys(j, ss[j]));
      }
    }
  }

  private rebuildProvisional(): void {
    const sp = this.sp;
    this.prov = [];
    const lastU = this.blocks.length;
    let i0 = this.blocks.length ? this.blockEnd(lastU - 1) : 0;
    let u = lastU;
    while (i0 < sp.n - 1) {
      let i1 = i0 + 1;
      while (i1 < sp.n - 1 && sp.s[i1] < BLOCK * (u + 1)) i1++;
      this.prov.push(...this.trunkPolys(i0, i1, u, false));
      i0 = i1; u++;
    }
    this.ghost = [];
    if (this.form === 'echo' && sp.n > 2) {
      const D = Math.min(3, this.depthAt(0) + 0);
      const pts: number[] = [];
      const N = 8;
      for (let k = 0; k <= N; k++) {
        const a = this.at((sp.L * k) / N);
        pts.push(a.x, a.y, 1.2 / this.d.z);
        if (k < N) {
          const b = this.at((sp.L * (k + 0.5)) / N);
          const bump = (6 + 3 * D) / this.d.z;
          pts.push(b.x + b.nx * bump, b.y + b.ny * bump, 1.2 / this.d.z);
        }
      }
      this.ghost.push({ kind: PolyKind.Ribbon, gen: 1, alpha: 0.3, tone: 16, born: 0, unit: 0, cat: 1, pts });
    }
  }

  private settle(u: Unit): void {
    const old = u.ids, nw: number[] = [];
    u.polys.forEach((p, k) => {
      const id = this.nextId++;
      const rep = k < old.length ? this.supersede(old[k]) : -1;
      this.pending.set(id, rep);
      this.queue.push({ id, rep, p });
      nw.push(id);
    });
    for (let k = u.polys.length; k < old.length; k++) {
      const rep = this.supersede(old[k]);
      if (rep < 0) continue;
      const id = this.nextId++;
      this.pending.set(id, rep);
      this.queue.push({ id, rep, p: null });
    }
    u.ids = nw;
  }
  private supersede(old: number): number {
    const r = this.pending.get(old);
    if (r === undefined) return old;
    this.pending.delete(old);
    return r;
  }

  // ---- IncrementalCook
  append(_n: number): void {
    if (this.done) return;
    this.rebuildSpine();
    this.extendBlocks(false);
    this.syncPools();
    this.refreshUnits(false);
    this.rebuildProvisional();
  }

  private syncPools(): void {
    const P = this.d.pools;
    const sig = Array.from(P.data.subarray(0, P.n * PL.STRIDE)).filter((_, i) => i % PL.STRIDE < 2).join(',');
    if (sig === this.poolSig) return;
    this.poolSig = sig;
    if (this.form === 'line') {
      // Line re-cooks its blocks near pools
      for (let u = 0; u < this.blocks.length; u++) {
        const i0 = u > 0 ? this.blockEnd(u - 1) : 0, i1 = this.blockEnd(u);
        const polys = this.trunkPolys(i0, i1, u, false);
        if (JSON.stringify(polys) !== JSON.stringify(this.blocks[u].polys)) { this.blocks[u].polys = polys; this.settle(this.blocks[u]); }
      }
    }
  }

  regrow(_s0: number, _s1: number): void {
    if (this.done) return;
    this.syncPools();
    this.refreshUnits(false);
    this.rebuildProvisional();
  }

  setClosing(on: boolean): void { this.d.closing = on; }

  view(): LiveView & { slot: Int32Array } {
    this.views++;
    if (this.done) return { geom: this.done, ghost: null, morph: this.doneMorph, slot: new Int32Array(this.done.nPolys).fill(-1) };
    const srcs: { polys: FPoly[]; ids: number[] | null }[] = [];
    for (const b of this.blocks) srcs.push({ polys: b.polys, ids: b.ids });
    srcs.push({ polys: [...this.prov, ...this.provUnits], ids: null });
    const us = [...this.units.values()];
    if (this.o.shuffle) us.reverse();
    for (const u of us) srcs.push({ polys: u.polys, ids: u.ids });
    const { c, slot } = assemble(srcs, this.d.z, this.d.origin);
    const ghost = this.ghost.length ? assemble([{ polys: this.ghost, ids: null }], this.d.z, this.d.origin).c : null;
    return { geom: c, ghost, morph: null, slot: this.o.slots ? slot : (undefined as unknown as Int32Array) };
  }

  drainSettled(cb: (p: PolyView, replaces: number) => void): void {
    const q = this.queue;
    this.queue = [];
    for (const e of q) {
      const rep = this.pending.get(e.id);
      if (rep === undefined) continue;
      this.pending.delete(e.id);
      cb(viewOf(e.id, e.p, this.d.z), rep);
    }
  }

  ceiling(_s: number): number { return DMAX[this.form]; }
  spine(): Readonly<Spine> { return this.sp; }

  /** Cook a recipe from scratch (its own pools and base) through this cook: append everything, then finish. */
  finishFrom(r: StrokeRecipe): Cooked {
    const P = this.d.pools;
    const n = Math.floor(r.pools.length / PL.STRIDE);
    if (P.data.length < r.pools.length) P.data = new Float32Array(Math.max(8 * PL.STRIDE, r.pools.length));
    P.data.set(r.pools); P.n = n;
    (this.d as { form: FakeDraft['form'] }).form = r.form;
    this.append(this.d.samples.n);
    return this.finish(r);
  }

  finish(r: StrokeRecipe): Cooked {
    if (this.done) return this.done;
    this.rebuildSpine();
    this.sp.settled = this.sp.n;
    this.syncPools();
    // re-emit the tail blocks with the exit taper, and add the remaining blocks
    const sp = this.sp, finals: Unit[] = [];
    let i0 = 0;
    for (let u = 0; i0 < sp.n - 1; u++) {
      let i1 = i0 + 1;
      while (i1 < sp.n - 1 && sp.s[i1] < BLOCK * (u + 1)) i1++;
      const tail = sp.s[i1] >= sp.L - 46;
      const settled = this.blocks[u];
      finals.push(settled && !tail ? settled : { key: 'b' + u, polys: this.trunkPolys(i0, i1, u, true), ids: [], sig: '' });
      i0 = i1;
    }
    this.refreshUnits(true);
    const srcs: { polys: FPoly[]; ids: number[] | null }[] = [];
    for (const b of finals) srcs.push({ polys: b.polys, ids: null });
    for (const u of this.units.values()) srcs.push({ polys: u.polys, ids: null });
    // Echo: a crystal folding out from its depth-0 positions
    let crystal: FPoly | null = null, from: number[] | null = null;
    if (this.form === 'echo' && sp.n > 2) {
      const dE = this.d.form.base;
      const pts: number[] = [], fr: number[] = [];
      const N = 24;
      for (let k = 0; k <= N; k++) {
        const s = (sp.L * k) / N, a = this.at(s);
        const bump = k % 2 ? (5 + 4 * dE) / this.d.z : 0;
        pts.push(a.x + a.nx * bump, a.y + a.ny * bump, 1.4 / this.d.z);
        fr.push(a.x, a.y);
      }
      crystal = { kind: PolyKind.Ribbon, gen: 1, alpha: 0.8, tone: 16, born: 0, unit: 0, cat: 1, pts };
      from = fr;
      srcs.push({ polys: [crystal], ids: null });
    }
    const { c } = assemble(srcs, this.d.z, r.origin);
    this.done = c;
    if (crystal && from) {
      const f = new Float32Array(2 * c.nPts);
      for (let j = 0; j < c.nPts; j++) { f[2 * j] = c.pts[4 * j]; f[2 * j + 1] = c.pts[4 * j + 1]; }
      const g1 = c.genStart.length > 2 ? c.genStart[1] : c.nPolys;
      for (let i = g1; i < c.nPolys; i++) {
        if (c.count[i] !== from.length / 2) continue;
        for (let k = 0; k < c.count[i]; k++) { f[2 * (c.start[i] + k)] = from[2 * k]; f[2 * (c.start[i] + k) + 1] = from[2 * k + 1]; }
      }
      this.doneMorph = { from: f, polyFirst: Uint32Array.of(g1), t0: Float32Array.of(sp.t[sp.n - 1]), dur: Float32Array.of(590) };
    }
    this.queue = []; this.pending.clear();
    return c;
  }
}

function viewOf(id: number, p: FPoly | null, z: number): PolyView {
  if (!p) return { index: id, kind: PolyKind.Ribbon, gen: 0, alpha: 0, tone: 0, born: 0, unit: 0, pts: new Float32Array(0), ang: null, box: new Float32Array(4) };
  const n = p.pts.length / 3, pts = new Float32Array(4 * n), box = new Float32Array(4);
  let a = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = Math.fround(p.pts[3 * k]), y = Math.fround(p.pts[3 * k + 1]), w = Math.fround(p.pts[3 * k + 2]);
    if (k > 0) a += Math.hypot(x - pts[4 * k - 4], y - pts[4 * k - 3]) * z;
    pts[4 * k] = x; pts[4 * k + 1] = y; pts[4 * k + 2] = w; pts[4 * k + 3] = a;
    x0 = Math.min(x0, x - w / 2); y0 = Math.min(y0, y - w / 2); x1 = Math.max(x1, x + w / 2); y1 = Math.max(y1, y + w / 2);
  }
  box[0] = x0; box[1] = y0; box[2] = x1; box[3] = y1;
  return { index: id, kind: p.kind, gen: p.gen, alpha: Math.fround(p.alpha), tone: p.tone, born: Math.fround(p.born), unit: p.unit, pts, ang: null, box };
}

/** Pack sources into a gen-sorted Cooked (gen, then cat 0 before 1, then source order). */
export function assemble(srcs: { polys: FPoly[]; ids: number[] | null }[], z: number, origin: readonly [number, number]): { c: Cooked; slot: Int32Array } {
  const all: { p: FPoly; id: number; order: number }[] = [];
  let order = 0;
  for (const s of srcs) s.polys.forEach((p, k) => { if (p.pts.length >= 3 && (p.pts.length >= 6 || p.kind === PolyKind.Dot)) all.push({ p, id: s.ids ? s.ids[k] ?? -1 : -1, order: order++ }); });
  all.sort((a, b) => a.p.gen - b.p.gen || a.p.cat - b.p.cat || a.order - b.order);
  const nPolys = all.length;
  const nPts = all.reduce((t, e) => t + e.p.pts.length / 3, 0);
  const pts = new Float32Array(4 * nPts);
  const start = new Uint32Array(nPolys), count = new Uint32Array(nPolys);
  const kind = new Uint8Array(nPolys), gen = new Uint8Array(nPolys), tone = new Uint8Array(nPolys);
  const alpha = new Float32Array(nPolys), born = new Float32Array(nPolys), unit = new Uint32Array(nPolys);
  const box = new Float32Array(4 * nPolys), slot = new Int32Array(nPolys);
  let w = 0, maxGen = 0;
  let ix0 = Infinity, iy0 = Infinity, ix1 = -Infinity, iy1 = -Infinity;
  all.forEach((e, i) => {
    const v = viewOf(e.id, e.p, z);
    const n = v.pts.length / 4;
    start[i] = w; count[i] = n;
    pts.set(v.pts, 4 * w);
    kind[i] = v.kind; gen[i] = v.gen; tone[i] = v.tone; alpha[i] = v.alpha; born[i] = v.born; unit[i] = v.unit;
    box.set(v.box, 4 * i);
    slot[i] = e.id;
    maxGen = Math.max(maxGen, v.gen);
    ix0 = Math.min(ix0, v.box[0]); iy0 = Math.min(iy0, v.box[1]); ix1 = Math.max(ix1, v.box[2]); iy1 = Math.max(iy1, v.box[3]);
    w += n;
  });
  const genStart = new Uint32Array(maxGen + 2);
  for (let g = 0; g <= maxGen + 1; g++) { let k = 0; while (k < nPolys && gen[k] < g) k++; genStart[g] = k; }
  const inkBox = ix1 >= ix0 ? { x0: origin[0] + ix0, y0: origin[1] + iy0, x1: origin[0] + ix1, y1: origin[1] + iy1 } : { x0: origin[0], y0: origin[1], x1: origin[0], y1: origin[1] };
  const c: Cooked = {
    pts, ang: null, start, count, kind, gen, tone, alpha, born, unit, box, genStart, nPolys, nPts,
    inkBox, hitBox: { ...inkBox }, ceilingMax: 0, coverage: 0.5, bytes: pts.byteLength,
  };
  return { c, slot };
}

/** Scripted paths (doc units at z = 1). */
export function wavePath(x0: number, y0: number, len: number, amp: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([x0 + len * t, y0 + amp * Math.sin(t * Math.PI * 2.2) + amp * 0.25 * Math.sin(t * Math.PI * 7)]);
  }
  return out;
}
