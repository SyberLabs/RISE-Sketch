/**
 * Fixtures for the ink-forms tests: recipes per Form built from the ink-instrument's
 * synthetic hand, a draft feeder with pools / closure, and Cooked invariants.
 */
import type { Cooked, DraftStroke, FormId, NibId, Device, StrokeRecipe } from '../src/core/types';
import { PL, S } from '../src/core/types';
import { fnv1a } from '../src/core/det';
import { Hand, recipe, scribble, mulberry32 } from './ink-instrument.fixtures';

export { Hand, scribble, mulberry32 };

export interface FormOpts {
  form: FormId; base?: number; nib?: NibId; size?: number; device?: Device; z?: number;
  closed?: boolean; radial?: boolean; pools?: number[]; seed?: number; s0?: number; cut?: number; resume?: Float32Array | null;
}

/** A committed recipe over rows with the given Form, base depth and pools ([s, a, s, a, …]). */
export function formRecipe(rows: Float32Array, o: FormOpts): StrokeRecipe {
  const r = recipe(rows, {
    device: o.device ?? 'pen', nib: o.nib ?? 'brush', size: o.size ?? 9, z: o.z ?? 1, closed: o.closed ?? false,
    seed: o.seed ?? 7, s0: o.s0, cut: o.cut, resume: o.resume ?? null,
  });
  const pl = o.pools ?? [];
  const pools = new Float32Array((pl.length / 2) * PL.STRIDE);
  for (let i = 0; i < pl.length / 2; i++) {
    pools[i * PL.STRIDE + PL.S] = pl[2 * i]; pools[i * PL.STRIDE + PL.A] = pl[2 * i + 1];
    pools[i * PL.STRIDE + PL.T0] = 0; pools[i * PL.STRIDE + PL.T1] = 0;
  }
  return { ...r, form: { form: o.form, v: 1, base: o.base ?? (o.form === 'line' ? 0 : 2) }, pools, radial: o.radial ?? false };
}

/** A long, varied pen stroke: speed changes, corners, a hold, curves, a fast flick. */
export function longStroke(seed = 3, hz = 240): Hand {
  const h = new Hand(20, 40, { jitter: 0.2, seed, hz, p: 0.35 });
  h.moveTo(120, 60, 0.6, 0.8).moveTo(220, 30, 1.4, 0.6);
  h.arc(260, 90, 60, -Math.PI / 2, Math.PI / 2, 0.9);
  h.moveTo(150, 160, 0.25, 0.9).hold(80);
  h.moveTo(150, 260, 0.2, 0.5);
  h.arc(220, 260, 70, Math.PI, 2.2 * Math.PI, 1.2);
  h.moveTo(420, 300, 2.2, 0.2);
  return h;
}

/** A closed loop (circle of radius R) with an overshoot back onto the start. */
export function loopStroke(R = 70, seed = 5): Hand {
  const h = new Hand(100 + R, 100, { jitter: 0.15, seed, p: 0.55 });
  h.arc(100, 100, R, 0, 2 * Math.PI * 1.02, 0.8);
  return h;
}

/** A tap (radial seed) or a bloom (hold at pen-down). */
export function tapStroke(holdMs = 60, seed = 9): Hand {
  const h = new Hand(50, 50, { jitter: 0.05, seed, p: 0.6 });
  h.hold(holdMs);
  h.moveTo(51, 50.5, 0.05);
  return h;
}

/**
 * A draft that reveals a recipe's rows `feed(k)` at a time and lets a test edit its pools
 * (rows of [s, a]) and closure, the way app/draft.ts and rise.ts would.
 */
export class Feeder {
  readonly d: DraftStroke;
  readonly total: number;
  private buf: { data: Float32Array; n: number };
  private pl: { data: Float32Array; n: number };
  constructor(readonly r: StrokeRecipe, startPools: number[] = []) {
    this.total = Math.floor(r.samples.length / S.STRIDE);
    this.buf = { data: new Float32Array(16 * S.STRIDE), n: 0 };
    this.pl = { data: new Float32Array(4 * PL.STRIDE), n: 0 };
    this.d = {
      origin: r.origin, z: r.z, rot: r.rot, seed: r.seed, device: r.device, calib: r.calib,
      stroke: r.stroke, color: r.color, form: r.form, s0: r.s0, cut: r.cut, resume: r.resume,
      samples: this.buf, pools: this.pl, closing: false,
    };
    this.setPools(startPools);
  }
  get fed(): number { return this.buf.n; }
  feed(k: number): number {
    const b = this.buf, n = Math.min(this.total, b.n + k);
    if (n * S.STRIDE > b.data.length) {
      let c = b.data.length;
      while (c < n * S.STRIDE) c *= 2;
      const g = new Float32Array(c); g.set(b.data); b.data = g;
    }
    b.data.set(this.r.samples.subarray(b.n * S.STRIDE, n * S.STRIDE), b.n * S.STRIDE);
    b.n = n;
    return n;
  }
  /** Replace the pool rows ([s, a, s, a, …]). */
  setPools(rows: number[]): void {
    const n = rows.length / 2, p = this.pl;
    if (n * PL.STRIDE > p.data.length) p.data = new Float32Array(Math.max(n * PL.STRIDE, 2 * p.data.length));
    for (let i = 0; i < n; i++) {
      p.data[i * PL.STRIDE + PL.S] = rows[2 * i]; p.data[i * PL.STRIDE + PL.A] = rows[2 * i + 1];
      p.data[i * PL.STRIDE + PL.T0] = 0; p.data[i * PL.STRIDE + PL.T1] = 0;
    }
    p.n = n;
  }
  /** The committed recipe as app/draft.ts would freeze it (rows, pools, closure). */
  freeze(closed: boolean): StrokeRecipe {
    const pools = this.pl.data.slice(0, this.pl.n * PL.STRIDE);
    return { ...this.r, samples: this.buf.data.slice(0, this.buf.n * S.STRIDE), pools, closed };
  }
}

/** Golden hash of every Cooked array (and the scalar fields). */
export function cookedHash(c: Cooked): number {
  const sc = new Float64Array([c.nPolys, c.nPts, c.inkBox.x0, c.inkBox.y0, c.inkBox.x1, c.inkBox.y1,
    c.hitBox.x0, c.hitBox.y0, c.hitBox.x1, c.hitBox.y1, c.ceilingMax, c.coverage, c.bytes]);
  const arrs: ArrayBufferView[] = [c.pts, c.start, c.count, c.kind, c.gen, c.tone, c.alpha, c.born, c.unit, c.box, c.genStart, sc];
  if (c.ang) arrs.push(c.ang);
  return fnv1a(arrs);
}

/** Bitwise equality of two Cooked (first difference as a message, or null). */
export function cookedDiff(a: Cooked, b: Cooked): string | null {
  if (a.nPolys !== b.nPolys) return `nPolys ${a.nPolys} vs ${b.nPolys}`;
  if (a.nPts !== b.nPts) return `nPts ${a.nPts} vs ${b.nPts}`;
  const fields = ['pts', 'start', 'count', 'kind', 'gen', 'tone', 'alpha', 'born', 'unit', 'box', 'genStart'] as const;
  for (const f of fields) {
    const x = a[f], y = b[f];
    if (x.length !== y.length) return `${f}.length ${x.length} vs ${y.length}`;
    const ux = new Uint8Array(x.buffer, x.byteOffset, x.byteLength), uy = new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
    for (let i = 0; i < ux.length; i++) if (ux[i] !== uy[i]) {
      const el = Math.floor(i / (x.byteLength / x.length));
      return `${f}[${el}] ${x[el]} vs ${y[el]}`;
    }
  }
  if (!!a.ang !== !!b.ang) return 'ang presence';
  if (a.ang && b.ang) for (let i = 0; i < a.ang.length; i++) if (!Object.is(a.ang[i], b.ang[i])) return `ang[${i}]`;
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) {
    if (!Object.is(a.inkBox[k], b.inkBox[k])) return `inkBox.${k}`;
    if (!Object.is(a.hitBox[k], b.hitBox[k])) return `hitBox.${k}`;
  }
  if (!Object.is(a.ceilingMax, b.ceilingMax)) return `ceilingMax ${a.ceilingMax} vs ${b.ceilingMax}`;
  if (!Object.is(a.coverage, b.coverage)) return 'coverage';
  if (a.bytes !== b.bytes) return 'bytes';
  return null;
}

/** Structural invariants every Cooked must satisfy; returns the problems found. */
export function cookedProblems(c: Cooked): string[] {
  const out: string[] = [];
  if (c.pts.length !== 4 * c.nPts) out.push('pts length');
  for (let i = 0; i < c.pts.length; i++) if (!Number.isFinite(c.pts[i])) { out.push(`NaN pts[${i}]`); break; }
  for (let i = 0; i < c.box.length; i++) if (!Number.isFinite(c.box[i])) { out.push(`NaN box[${i}]`); break; }
  let prevGen = 0, covered = 0;
  for (let i = 0; i < c.nPolys; i++) {
    if (c.gen[i] < prevGen) { out.push(`gen not sorted at ${i}`); break; }
    prevGen = c.gen[i];
    if (c.start[i] !== covered) { out.push(`start gap at ${i}`); break; }
    covered += c.count[i];
    if (c.count[i] < (c.kind[i] === 2 ? 1 : 2)) out.push(`short poly ${i}`);
    if (!(c.alpha[i] > 0 && c.alpha[i] <= 1)) out.push(`alpha ${c.alpha[i]} at ${i}`);
    if (c.tone[i] > 29) out.push(`tone ${c.tone[i]}`);
    for (let k = 0; k < c.count[i]; k++) {
      const j = c.start[i] + k, x = c.pts[4 * j], y = c.pts[4 * j + 1], h = 0.5 * c.pts[4 * j + 2];
      // per-poly boxes (relative to the origin) contain every point and its half width exactly
      if (x - h < c.box[4 * i] || x + h > c.box[4 * i + 2] || y - h < c.box[4 * i + 1] || y + h > c.box[4 * i + 3]) {
        out.push(`point outside poly box at ${i}`); break;
      }
      if (k > 0 && c.pts[4 * j + 3] < c.pts[4 * j - 1] - 1e-6) { out.push(`arc decreasing at ${i}`); break; }
    }
    if (out.length > 8) break;
  }
  if (covered !== c.nPts) out.push('counts do not cover pts');
  const gs = c.genStart;
  if (gs[gs.length - 1] !== c.nPolys) out.push('genStart end');
  for (let g = 1; g < gs.length; g++) if (gs[g] < gs[g - 1]) out.push('genStart order');
  for (let g = 0; g + 1 < gs.length; g++) for (let i = gs[g]; i < gs[g + 1]; i++) if (c.gen[i] !== g) { out.push(`genStart mismatch at ${i}`); break; }
  return out;
}

/** Whether every point of c lies in its absolute inkBox (origin added in Float64). */
export function inkBoxContains(c: Cooked, origin: readonly [number, number]): boolean {
  for (let j = 0; j < c.nPts; j++) {
    const x = origin[0] + c.pts[4 * j], y = origin[1] + c.pts[4 * j + 1];
    if (x < c.inkBox.x0 - 1e-6 || x > c.inkBox.x1 + 1e-6 || y < c.inkBox.y0 - 1e-6 || y > c.inkBox.y1 + 1e-6) return false;
  }
  return true;
}
