/**
 * Charcoal rendering (render/tooth.ts through drawCooked, DESIGN §6.4): one coverage per draw call
 * (a smoothed density field from every batch's contact rings and drag lanes, plus the page's tooth
 * and its finer octaves, thresholded in the alpha channel), then one tinted composite per pigment
 * with the ground's op; far out a plain fill at the mean coverage; non-charcoal strokes untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { InkTable, Mat2x3 } from '../src/core/types';
import { S } from '../src/core/types';
import { drawCooked, inkTableFor } from '../src/render/raster';
import { drawHot } from '../src/render/live/draw';
import { PolyState, setMorphBox } from '../src/render/live/polys';
import { ArcClock } from '../src/render/live/timing';
import { assignVariant } from '../src/ink/color';
import { TOOTH_CONTACT, toothInk, toothLevel, toothSolid } from '../src/ink/tooth';
import { nibWidth } from '../src/ink/nibs';
import { synthCooked, along } from './render-core.fixtures';

interface Pat { kind: 'mask'; size: number; m: DOMMatrix2DInit | null; setTransform(m: DOMMatrix2DInit): void }
interface Op { op: string; style?: unknown; alpha: number; comp: string; halfW?: number; m?: DOMMatrix2DInit | null; at?: number[]; rule?: string }

/** A recording 2D context (fills with the path's half height, drawImage, fillRect). */
function recCtx(w: number, h: number) {
  const log: Op[] = [], stack: unknown[][] = [];
  let y0 = Infinity, y1 = -Infinity;
  const pt = (_x: number, y: number) => { y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: '' as unknown, strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', imageSmoothingEnabled: true,
    save() { stack.push([ctx.globalCompositeOperation, ctx.globalAlpha, ctx.fillStyle]); },
    restore() { const st = stack.pop(); if (st) [ctx.globalCompositeOperation, ctx.globalAlpha, ctx.fillStyle] = st as [string, number, unknown]; },
    setTransform() {}, clearRect() {}, rect() {}, clip() {}, beginPath() { y0 = Infinity; y1 = -Infinity; },
    moveTo: pt, lineTo: pt, quadraticCurveTo(_a: number, _b: number, x: number, y: number) { pt(x, y); }, closePath() {}, arc() {}, stroke() {},
    fill(rule?: string) {
      const s = ctx.fillStyle as Pat;
      log.push({ op: 'fill', style: s, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, halfW: (y1 - y0) / 2, m: typeof s === 'object' ? { ...s.m } : null, rule });
    },
    fillRect() {
      const s = ctx.fillStyle as Pat;
      log.push({ op: 'fillRect', style: s, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, m: typeof s === 'object' ? { ...s.m } : null });
    },
    drawImage(_c: unknown, ...a: number[]) { log.push({ op: 'drawImage', alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, at: a }); },
    putImageData() {},
    createPattern(c: { width: number }): Pat { return { kind: 'mask', size: c.width, m: null, setTransform(m) { this.m = m; } }; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

/** Every canvas the module makes (grain maps, the scratches), with its recording context. */
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
/** The log of the scratch that holds the coverage (the one that draws pattern fills). */
const covLog = () => made.find(c => c.rec && c.rec.log.some(l => typeof l.style === 'object' && l.style !== null && (l.style as Pat).kind === 'mask'))!.rec.log;
/** The log of the scratch that holds the density field (lighter fills of white). */
const denLog = () => made.find(c => c.rec && c.rec.log.some(l => l.op === 'fill' && l.comp === 'lighter'))!.rec.log;
/** The log of the scratch where a pigment is cut and tinted (its fills are opaque white). */
const inkLog = () => made.find(c => c.rec && c.rec.log.some(l => l.op === 'fill' && l.comp === 'source-over' && l.style === '#fff'))!.rec.log;
const clearLogs = () => { for (const c of made) if (c.rec) c.rec.log.length = 0; };

const rows = () => { const r = new Float32Array(2 * S.STRIDE); r[S.ALT] = Math.PI / 2; return r; };
function table(nib: 'charcoal' | 'brush', ground: 'night' | 'paper', origin: [number, number] = [0, 0]): InkTable {
  return inkTableFor({
    origin, z: 1, rot: 0, seed: 1, device: 'pen', calib: { lo: 0, hi: 1, gamma: 1, flat: 1, vMed: 1, jitter: 0.3, fcMin: 2 },
    stroke: { nib, size: 9 }, color: assignVariant('graphite', 0, null, null), form: { form: 'line', v: 1, base: 0 },
    s0: 0, cut: 0, resume: null, samples: rows(),
  }, ground);
}
const ribbon = (tone: number) => synthCooked([{ pts: along([[0, 50], [200, 50]], 2.4, () => 20), tone }]);
/** One ribbon in two chunks whose pressure buckets differ (tone 10, then 25). */
const twoTones = () => synthCooked([
  { pts: along([[0, 50], [100, 50]], 2.4, () => 20), tone: 10 },
  { pts: along([[100, 50], [200, 50]], 2.4, () => 20), tone: 25 },
]);
const M = (s: number, e = 0, f = 0): Mat2x3 => Float64Array.of(s, 0, 0, s, e, f);

describe('charcoal fills', () => {
  it('only charcoal tables carry a tooth', () => {
    expect(table('brush', 'night').tooth).toBeUndefined();
    expect(table('charcoal', 'night').tooth).toEqual({ cell: 1, ox: 0, oy: 0, smudge: 0, w: nibWidth('charcoal', 9, 0.5, NaN, 'pen', Math.PI / 2) });
  });

  it('a draw call: density contact steps, grain, threshold, then one tinted composite with the ground op', () => {
    for (const ground of ['night', 'paper'] as const) {
      const t = table('charcoal', ground);
      const { ctx, log } = recCtx(1024, 1024);
      clearLogs();
      drawCooked(ctx, ribbon(20), t, M(2));
      expect(log.map(l => [l.op, l.comp, l.alpha])).toEqual([['drawImage', t.op, t.alphaMax]]);
      // density: one nonzero fill per contact step, outside in: rings add, drag lanes cut
      const d = denLog().filter(l => l.op === 'fill');
      expect(d.map(l => [l.comp, l.rule])).toEqual(TOOTH_CONTACT.map(([, a]) => [a >= 0 ? 'lighter' : 'destination-out', 'nonzero']));
      for (let i = 1; i < d.length; i++) expect(d[i].halfW! / d[0].halfW!).toBeCloseTo(TOOTH_CONTACT[i][0], 1);
      // ... then inverted to 1 − D
      expect(denLog().filter(l => l.op === 'fillRect').map(l => l.comp)).toEqual(['xor']);
      // coverage: the tooth's depth 1 − H, plus 1 − D, xor to H + D − 1, then the gain 2^3 (upright)
      const c = covLog().map(l => [l.op, l.comp]);
      expect(c).toEqual([
        ['fillRect', 'source-over'], ['drawImage', 'lighter'], ['fillRect', 'xor'],
        ...new Array(3).fill(['drawImage', 'lighter']),
      ]);
      // one pigment: the ribbon cut from the coverage and tinted with the heaviest bucket of its depth
      const k = inkLog().map(l => [l.op, l.comp, l.op === 'fillRect' ? l.style : null]);
      expect(k).toEqual([['fill', 'source-over', null], ['drawImage', 'destination-in', null], ['fillRect', 'source-in', t.css[toothInk(20)]]]);
    }
  });

  it('a stroke whose pressure bucket changes is one coverage and one composite (no seam at the change)', () => {
    const { ctx, log } = recCtx(1024, 1024);
    clearLogs();
    drawCooked(ctx, twoTones(), table('charcoal', 'paper'), M(2));
    expect(log.map(l => l.op)).toEqual(['drawImage']);
    const ink = inkLog().filter(l => l.op === 'fill');
    expect(ink.length).toBe(1);
    // ... while each chunk still lays down its own pressure's density
    const d = denLog().filter(l => l.op === 'fill');
    expect(d.length).toBe(2 * TOOTH_CONTACT.length);
    expect(d[0].alpha).not.toBeCloseTo(d[TOOTH_CONTACT.length].alpha, 3);
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
      clearLogs();
      drawCooked(ctx, ribbon(20), t, m);
      const [, , , , dx0, dy0] = log[0].at!;                  // where the scratch lands on the target
      const p = covLog().filter(l => l.op === 'fillRect' && l.m).at(-1)!.m!; // the base octave
      const sx = m[0] * x + m[4] - dx0, sy = m[3] * y + m[5] - dy0; // scratch px of the doc point
      // texel → doc units (a / m0 = cell), as world coordinates modulo the tooth period
      return [((sx - p.e!) / p.a!) * (p.a! / m[0]), ((sy - p.f!) / p.d!) * (p.d! / m[3])];
    };
    const wrap = (v: number) => ((v % 512) + 512) % 512;
    const a = world(M(1), 30, 50);
    for (const q of [world(M(3, -411.25, 77), 30, 50), world(M(0.75, 5, 90), 30, 50)]) for (let i = 0; i < 2; i++) expect(wrap(q[i])).toBeCloseTo(wrap(a[i]), 6);
    expect(wrap(a[0])).toBeCloseTo(wrap(origin[0] + 30), 4);
    expect(wrap(a[1])).toBeCloseTo(wrap(origin[1] + 50), 4);
  });

  it('zoomed in, finer octaves of the same tooth fade in (cell / 4, then cell / 16), still on the page', () => {
    const grain = (s: number) => {
      const { ctx } = recCtx(4096, 4096);
      clearLogs();
      drawCooked(ctx, ribbon(20), table('charcoal', 'night'), M(s));
      return covLog().filter(l => l.op === 'fillRect' && l.m);
    };
    expect(grain(1).length).toBe(1);
    const z = grain(40).slice(0, 3);  // the first chunk
    expect(z.map(l => l.m!.a! / 40)).toEqual([1 / 16, 1 / 4, 1]);
    expect(z.reduce((s, l) => s + l.alpha, 0)).toBeCloseTo(1, 9);  // the octaves share the grain's weight
    for (const l of z) expect([l.m!.e, l.m!.f]).toEqual([z[2].m!.e, z[2].m!.f]);
  });

  it('the density grid is anchored at the stroke origin, so two tiles of one view agree', () => {
    const at = (clip: { x0: number; y0: number; x1: number; y1: number }) => {
      const { ctx, log } = recCtx(4096, 4096);
      clearLogs();
      drawCooked(ctx, ribbon(20), table('charcoal', 'night'), M(8, 13.3, 7.1), { clipDev: clip });
      const up = covLog().find(l => l.op === 'drawImage')!.at!;
      return { x: up[4] + log[0].at![4], cell: up[6] / up[2] };  // grid origin on the target, device px per density texel
    };
    const a = at({ x0: 0, y0: 0, x1: 700, y1: 1024 }), b = at({ x0: 700, y0: 0, x1: 1700, y1: 1024 });
    expect(a.cell).toBeCloseTo(b.cell, 12);
    const k = (b.x - a.x) / a.cell;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    expect(((a.x - 13.3) / a.cell) % 1).toBeCloseTo(0, 9);
  });

  it('a region wider than the scratch is drawn in chunks that tile it', () => {
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

  it('far out, sub-half-pixel texels: one plain fill in the pigment at the mean coverage', () => {
    const { ctx, log } = recCtx(1024, 1024);
    const t = table('charcoal', 'night');
    drawCooked(ctx, ribbon(20), t, M(0.3));
    expect(log.map(l => [l.op, l.style])).toEqual([['fill', t.css[toothInk(20)]]]);
    expect(log[0].alpha).toBeCloseTo(toothSolid(toothLevel(20), 0), 6);
  });
});
