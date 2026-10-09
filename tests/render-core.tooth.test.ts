/**
 * Charcoal rendering (render/tooth.ts through drawCooked, DESIGN §6.4): per batch, the fringe and
 * the narrower core are laid as coverage masks in a scratch canvas, tinted, and composited once with
 * the ground's op; the masks are world-anchored and colour-free; far out the batch is a plain fill
 * at the mean coverage; non-charcoal strokes are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { InkTable, Mat2x3 } from '../src/core/types';
import { S } from '../src/core/types';
import { drawCooked, inkTableFor } from '../src/render/raster';
import { maskLut } from '../src/render/tooth';
import { drawHot } from '../src/render/live/draw';
import { PolyState, setMorphBox } from '../src/render/live/polys';
import { ArcClock } from '../src/render/live/timing';
import { assignVariant } from '../src/ink/color';
import { SMUDGE_LEVELS, TOOTH_LEVELS, ToothPass, toothLevel, toothLut, toothSolid } from '../src/ink/tooth';
import { synthCooked, along } from './render-core.fixtures';

interface Pat { kind: 'mask'; size: number; m: DOMMatrix2DInit | null; setTransform(m: DOMMatrix2DInit): void }
interface Op { op: string; style?: unknown; alpha: number; comp: string; halfW?: number; m?: DOMMatrix2DInit | null; at?: number[] }

/** A recording 2D context (fills with the path's half height, drawImage, fillRect). */
function recCtx(w: number, h: number) {
  const log: Op[] = [];
  let y0 = Infinity, y1 = -Infinity;
  const pt = (_x: number, y: number) => { y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: '' as unknown, strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    save() {}, restore() {}, setTransform() {}, clearRect() {}, beginPath() { y0 = Infinity; y1 = -Infinity; },
    moveTo: pt, lineTo: pt, quadraticCurveTo(_a: number, _b: number, x: number, y: number) { pt(x, y); }, closePath() {}, arc() {}, stroke() {},
    fill() {
      const s = ctx.fillStyle as Pat;
      log.push({ op: 'fill', style: s, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, halfW: (y1 - y0) / 2, m: typeof s === 'object' ? { ...s.m } : null });
    },
    fillRect() { log.push({ op: 'fillRect', style: ctx.fillStyle, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation }); },
    drawImage(_c: unknown, ...a: number[]) { log.push({ op: 'drawImage', alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, at: a }); },
    putImageData() {},
    createPattern(c: { width: number }): Pat { return { kind: 'mask', size: c.width, m: null, setTransform(m) { this.m = m; } }; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

/** Every canvas the module makes (masks, the scratch), with its recording context. */
const made: { width: number; height: number; rec: ReturnType<typeof recCtx> }[] = [];
const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
  g.document = {
    createElement: () => {
      const c = { width: 0, height: 0, rec: null as unknown as ReturnType<typeof recCtx>, getContext: () => (c.rec ??= recCtx(c.width, c.height)).ctx };
      made.push(c);
      return c;
    },
  };
});
afterAll(() => { delete g.ImageData; delete g.document; });
/** The scratch's log: the most recent canvas whose context filled something. */
const scratchLog = () => made.filter(c => c.rec && c.rec.log.length).at(-1)!.rec.log;

const rows = () => { const r = new Float32Array(2 * S.STRIDE); r[S.ALT] = Math.PI / 2; return r; };
function table(nib: 'charcoal' | 'brush', ground: 'night' | 'paper', origin: [number, number] = [0, 0]): InkTable {
  return inkTableFor({
    origin, z: 1, rot: 0, seed: 1, device: 'pen', calib: { lo: 0, hi: 1, gamma: 1, flat: 1, vMed: 1, jitter: 0.3, fcMin: 2 },
    stroke: { nib, size: 9 }, color: assignVariant('graphite', 0, null, null), form: { form: 'line', v: 1, base: 0 },
    s0: 0, cut: 0, resume: null, samples: rows(),
  }, ground);
}
const ribbon = (tone: number) => synthCooked([{ pts: along([[0, 50], [200, 50]], 2.4, () => 20), tone }]);
const M = (s: number, e = 0, f = 0): Mat2x3 => Float64Array.of(s, 0, 0, s, e, f);

describe('charcoal fills', () => {
  it('only charcoal tables carry a tooth', () => {
    expect(table('brush', 'night').tooth).toBeUndefined();
    expect(table('charcoal', 'night').tooth).toEqual({ cell: 1, ox: 0, oy: 0, smudge: 0 });
  });

  it('a batch: fringe mask at full width, core mask at 0.62 of it, tinted, then one composite with the ground op', () => {
    for (const ground of ['night', 'paper'] as const) {
      const t = table('charcoal', ground);
      const { ctx, log } = recCtx(1024, 1024);
      drawCooked(ctx, ribbon(20), t, M(2));
      expect(log.map(l => l.op)).toEqual(['drawImage']);
      expect(log[0].comp).toBe(t.op);
      expect(log[0].alpha).toBe(t.alphaMax);
      const s = scratchLog().slice(-3);
      expect(s.map(l => l.op)).toEqual(['fill', 'fill', 'fillRect']);
      expect([(s[0].style as Pat).kind, (s[1].style as Pat).kind, s[2].style, s[2].comp]).toEqual(['mask', 'mask', t.css[20], 'source-in']);
      expect(s[1].halfW! / s[0].halfW!).toBeCloseTo(0.62, 1);
    }
  });

  it('a brush stroke still fills once with its colour', () => {
    const { ctx, log } = recCtx(1024, 1024);
    const t = table('brush', 'night');
    drawCooked(ctx, ribbon(20), t, M(2));
    expect(log.map(l => [l.op, l.style])).toEqual([['fill', t.css[20]]]);
  });

  it('the grain is anchored to the world: any view maps a doc point to the same texel', () => {
    const origin: [number, number] = [1e6 + 17.5, -3];
    const t = table('charcoal', 'paper', origin);
    const world = (m: Mat2x3, x: number, y: number) => {
      const { ctx, log } = recCtx(4096, 4096);
      drawCooked(ctx, ribbon(20), t, m);
      const [, , , , dx0, dy0] = log[0].at!;                  // where the scratch lands on the target
      const p = scratchLog().slice(-3)[0].m!;
      const sx = m[0] * x + m[4] - dx0, sy = m[3] * y + m[5] - dy0; // scratch px of the doc point
      // mask px → doc units (a / m0 = cell / up), as world coordinates modulo the tooth period
      return [((sx - p.e!) / p.a!) * (p.a! / m[0]), ((sy - p.f!) / p.d!) * (p.d! / m[3])];
    };
    const wrap = (v: number) => ((v % 512) + 512) % 512;
    const a = world(M(1), 30, 50);
    for (const q of [world(M(3, -411.25, 77), 30, 50), world(M(0.75, 5, 90), 30, 50)]) for (let i = 0; i < 2; i++) expect(wrap(q[i])).toBeCloseTo(wrap(a[i]), 6);
    expect(wrap(a[0])).toBeCloseTo(wrap(origin[0] + 30), 4);
    expect(wrap(a[1])).toBeCloseTo(wrap(origin[1] + 50), 4);
  });

  it('zoomed in past 2.5 device px a texel, the masks are built at 2× (smooth grain contours)', () => {
    const { ctx } = recCtx(1024, 1024);
    drawCooked(ctx, ribbon(20), table('charcoal', 'night'), M(4));
    const s = scratchLog().slice(-3);
    expect((s[0].style as Pat).size).toBe(1024);
    expect(s[0].m!.a).toBe(2);
  });

  it('a batch wider than the scratch is drawn in chunks that tile its box', () => {
    const { ctx, log } = recCtx(4096, 4096);
    drawCooked(ctx, ribbon(20), table('charcoal', 'night'), M(8));
    expect(log.length).toBe(2);
    const [a, b] = log.map(l => l.at!);
    expect(b[4]).toBe(a[4] + a[2]);   // the second chunk starts where the first ends
  });

  it('the scratch includes the starting geometry while a charcoal stroke morphs', () => {
    const c = ribbon(20), from = new Float32Array(c.nPts * 2);
    for (let j = 0; j < c.nPts; j++) { from[2 * j] = c.pts[4 * j]; from[2 * j + 1] = 450; }
    const { ctx, log } = recCtx(1024, 1024);
    drawCooked(ctx, c, table('charcoal', 'night'), M(1), { morph: { from, t: () => 0 } });
    const a = log[0].at!;
    expect(a[5] + a[7]).toBeGreaterThan(460);
    const clipped = recCtx(1024, 1024);
    drawCooked(clipped.ctx, c, table('charcoal', 'night'), M(1), {
      morph: { from, t: () => 0 }, clipDev: { x0: 0, y0: 430, x1: 220, y1: 480 },
    });
    expect(clipped.log[0].at![5]).toBe(430);
    expect(clipped.log[0].at![5] + clipped.log[0].at![7]).toBeGreaterThan(460);
  });

  it('live charcoal draws a morph whose starting geometry is inside the clip and target outside', () => {
    const c = ribbon(20), from = new Float32Array(c.nPts * 2), state = new PolyState();
    for (let j = 0; j < c.nPts; j++) { from[2 * j] = c.pts[4 * j]; from[2 * j + 1] = 450; }
    state.ensure(1); state.keyFrom(c, 0, 0); state.hv[0] = 1; state.mv[0] = 0;
    setMorphBox(state, 0, c, from);
    const { ctx, log } = recCtx(1024, 1024);
    drawHot(ctx, c, Int32Array.of(0), 1, table('charcoal', 'night'), M(1),
      { x0: 0, y0: 430, x1: 220, y1: 480 },
      { clock: new ArcClock(), now: 0, tip: 200, H: 0, tau: 220, beyond: 0, sVis: Infinity }, state, from);
    expect(log[0].at![5]).toBe(430);
    expect(log[0].at![5] + log[0].at![7]).toBeGreaterThan(460);
  });

  it('far out, sub-half-pixel texels: one plain fill at the mean coverage', () => {
    const { ctx, log } = recCtx(1024, 1024);
    const t = table('charcoal', 'night');
    drawCooked(ctx, ribbon(20), t, M(0.3));
    expect(log.map(l => [l.op, l.style])).toEqual([['fill', t.css[20]]]);
    expect(log[0].alpha).toBeCloseTo(toothSolid(toothLevel(20), 0), 6);
  });

  it('fringe then core, alpha-composited, cover exactly max(core, fringe): no rim where both are partial', () => {
    for (let l = 0; l < TOOTH_LEVELS; l++) {
      for (let s = 0; s < SMUDGE_LEVELS; s++) {
        const f = maskLut(l, s, ToothPass.Fringe), x = maskLut(l, s, ToothPass.Core);
        const c = toothLut(l, s, ToothPass.Core), fo = toothLut(l, s, ToothPass.Fringe);
        for (let v = 0; v < 256; v++) {
          const got = f[v] / 255 + (x[v] / 255) * (1 - f[v] / 255);
          expect(Math.abs(got - Math.max(c[v], fo[v]) / 255)).toBeLessThan(1.5 / 255);
        }
      }
    }
  });
});
