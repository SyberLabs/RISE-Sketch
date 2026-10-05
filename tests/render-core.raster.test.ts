import { describe, it, expect } from 'vitest';
import { PolyKind } from '../src/core/types';
import type { ColorStyle, InkTable, RecipeCore } from '../src/core/types';
import { drawCooked, drawStats, inkTableFor, commitScale, lodFor, lodBytes } from '../src/render/raster';
import { Batcher, alphaBucket, alphaOf, exactKey, ALPHA_LEVELS, MAX_FILLS, MODE_FILL } from '../src/render/batch';
import { resolveInk, assignVariant } from '../src/ink/color';
import { synthCooked, along, type SynthPoly } from './render-core.fixtures';

/** Minimal CanvasRenderingContext2D stand-in that records fills and strokes. */
function fakeCtx() {
  const log: { op: string; style?: string; alpha?: number; comp?: string; lw?: number; subpaths?: number }[] = [];
  let subpaths = 0;
  const arcs = { n: 0 };
  const ctx = {
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    save() {}, restore() {}, setTransform() {}, beginPath() { subpaths = 0; },
    moveTo() { subpaths++; }, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arc() { arcs.n++; },
    fill() { log.push({ op: 'fill', style: ctx.fillStyle, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, subpaths }); },
    stroke() { log.push({ op: 'stroke', style: ctx.strokeStyle, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation, lw: ctx.lineWidth, subpaths }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log, arcs };
}

const I = Float64Array.of(1, 0, 0, 1, 0, 0);
const scaleM = (s: number) => Float64Array.of(s, 0, 0, s, 0, 0);
const moss = (): InkTable => resolveInk(assignVariant('moss', 0, null, null), 'night');
const ribbon = (y: number, extra: Partial<SynthPoly> = {}): SynthPoly => ({ pts: along([[0, y], [100, y]], 2.4, () => 6), ...extra });

describe('batch planning', () => {
  it('alpha buckets: 8 linear levels plus faint levels; invisible below 1/192', () => {
    expect(alphaBucket(1)).toBe(7);
    expect(alphaOf(alphaBucket(0.5))).toBe(0.5);
    expect(alphaOf(alphaBucket(0.38))).toBe(0.375);
    expect(alphaOf(alphaBucket(0.04))).toBeCloseTo(1 / 24, 9);
    expect(alphaOf(alphaBucket(0.02))).toBeCloseTo(1 / 48, 9);
    expect(alphaBucket(0.001)).toBe(-1);
    expect(alphaOf(exactKey(0.3337))).toBeCloseTo(0.3337, 3);
    expect(ALPHA_LEVELS.length).toBe(11);
  });

  it('groups equal (css, alpha, mode) entries into one batch, deterministically sorted', () => {
    const b = new Batcher();
    b.add(0, 5, 7, MODE_FILL); b.add(1, 3, 7, MODE_FILL); b.add(2, 5, 7, MODE_FILL); b.add(3, 5, 3, MODE_FILL);
    const p = b.build(false);
    expect(p.n).toBe(3);
    const groups = Array.from({ length: p.n }, (_, k) => ({ css: p.css[k], alpha: p.alpha[k], polys: Array.from(p.order.subarray(p.first[k], p.first[k] + p.count[k])).map(e => b.poly[e]) }));
    expect(groups).toEqual([{ css: 3, alpha: 1, polys: [1] }, { css: 5, alpha: 0.5, polys: [3] }, { css: 5, alpha: 1, polys: [0, 2] }]);
  });

  it(`merges adjacent tones until ≤ ${MAX_FILLS} fills`, () => {
    const b = new Batcher();
    let i = 0;
    for (let tone = 0; tone < 30; tone++) for (let k = 0; k < 8; k++) b.add(i++, tone, k, MODE_FILL);
    const p = b.build(false);
    expect(p.n).toBeLessThanOrEqual(MAX_FILLS);
    let total = 0;
    for (let k = 0; k < p.n; k++) total += p.count[k];
    expect(total).toBe(240);
    const sb = new Batcher();
    i = 0;
    for (let h = 0; h < 36; h++) for (let tone = 20; tone < 25; tone++) sb.add(i++, h * 30 + tone, 7, MODE_FILL);
    expect(sb.build(true).n).toBeLessThanOrEqual(MAX_FILLS);
  });
});

describe('drawCooked', () => {
  it('fills once per (tone, alpha) batch with the table colour and composite op', () => {
    const c = synthCooked([ribbon(0, { tone: 25 }), ribbon(20, { tone: 25 }), ribbon(40, { tone: 10 }), ribbon(60, { tone: 25, alpha: 0.5 })]);
    const t = moss();
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c, t, I);
    expect(log.length).toBe(3);
    for (const f of log) { expect(f.op).toBe('fill'); expect(f.comp).toBe('lighter'); }
    const two = log.find(f => f.subpaths === 2)!;
    expect(two.style).toBe(t.css[25]);
    expect(two.alpha).toBe(1);
    expect(log.some(f => f.alpha === 0.5 && f.style === t.css[25])).toBe(true);
  });

  it('Paper multiplies with alphaMax 0.85 exactly (Paper safety: never bucketed up to 0.875)', () => {
    const c = synthCooked([ribbon(0)]);
    const t = resolveInk(assignVariant('indigo', 0, null, null), 'paper');
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c, t, I);
    expect(log[0].comp).toBe('multiply');
    expect(log[0].alpha).toBe(0.85);
  });

  it('LOD rule 3 (hairline): sub-pixel polys are stroked at 1 px with alpha × device width', () => {
    const c = synthCooked([{ pts: along([[0, 0], [100, 0]], 2.4, () => 0.5), tone: 20 }]);
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c, moss(), I);
    expect(log).toHaveLength(1);
    expect(log[0].op).toBe('stroke');
    expect(log[0].lw).toBe(1);
    expect(log[0].alpha).toBe(0.5);
    const off = fakeCtx();
    drawCooked(off.ctx, c, moss(), I, { lod: false });
    expect(off.log[0].op).toBe('fill');
  });

  it('LOD rule 2 (generation cull): faint thin generations are skipped, generation 0 never', () => {
    const c = synthCooked([
      { pts: along([[0, 0], [100, 0]], 2.4, () => 0.05), gen: 0 },
      { pts: along([[0, 10], [100, 10]], 2.4, () => 0.08), gen: 1, alpha: 0.4 },
      { pts: along([[0, 20], [100, 20]], 2.4, () => 4), gen: 2, alpha: 0.4 },
    ]);
    const { ctx } = fakeCtx();
    drawCooked(ctx, c, moss(), I);
    expect(drawStats.culled).toBe(1);
  });

  it('generation cull is a property of the whole stroke, never of the clip (tile seams agree)', () => {
    const c = synthCooked([
      { pts: along([[0, 0], [100, 0]], 2.4, () => 6), gen: 0 },
      { pts: along([[0, 300], [100, 300]], 2.4, () => 6), gen: 1, alpha: 0.5 },     // thick, off-clip
      { pts: along([[0, 20], [100, 20]], 2.4, () => 0.05), gen: 1, alpha: 0.5 },    // thin, in clip
    ]);
    const a = fakeCtx();
    drawCooked(a.ctx, c, moss(), I, { clipDev: { x0: -10, y0: -10, x1: 110, y1: 40 } });
    expect(drawStats.culled).toBe(0);
    expect(a.log.some(f => f.op === 'stroke')).toBe(true);    // the thin poly is drawn as a hairline
  });

  it('LOD rule 5 (stroke cull): tiny strokes become one dot; sub-half-pixel strokes vanish', () => {
    const c = synthCooked([ribbon(0), ribbon(20)]);
    const dot = fakeCtx();
    drawCooked(dot.ctx, c, moss(), scaleM(0.02));     // diag ≈ 2.1 px
    expect(dot.log).toHaveLength(1);
    expect(dot.log[0].op).toBe('fill');
    const none = fakeCtx();
    drawCooked(none.ctx, c, moss(), scaleM(0.003));
    expect(none.log).toHaveLength(0);
  });

  it('LOD rule 4: decimated copies below 0.5× / 0.125× of the commit scale', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 200; i++) { const t = i / 200; path.push([t * 400, 60 * Math.sin(t * 9)]); }
    const c = synthCooked([{ pts: along(path, 1.2, () => 6) }], 2);
    expect(commitScale(c)).toBeCloseTo(2, 4);
    const l1 = lodFor(c, 1), l4 = lodFor(c, 4);
    expect(l1.nPolys).toBe(c.nPolys);
    expect(l1.nPts).toBeLessThan(c.nPts);
    expect(l4.nPts).toBeLessThan(l1.nPts);
    expect(lodFor(c, 1)).toBe(l1);                    // cached
    expect(lodBytes(c)).toBe(l1.bytes + l4.bytes);
    // arcs kept exactly at kept points; ends preserved
    expect(l1.pts[3]).toBe(c.pts[3]);
    expect(l1.pts[(l1.nPts - 1) * 4]).toBe(c.pts[(c.nPts - 1) * 4]);
    const { ctx } = fakeCtx();
    drawCooked(ctx, c, moss(), scaleM(2 * 0.4));
    expect(drawStats.lod).toBe(1);
    drawCooked(ctx, c, moss(), scaleM(2 * 0.1));
    expect(drawStats.lod).toBe(4);
    drawCooked(ctx, c, moss(), scaleM(2 * 0.9));
    expect(drawStats.lod).toBe(0);
  });

  it('hot ink: exact alpha multiplier; on Night above 1 adds a second pass', () => {
    const c = synthCooked([ribbon(0, { alpha: 0.5 }), ribbon(20)]);
    const t = moss();
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c, t, I, { hot: i => (i === 0 ? 1.3 : 1.45) });
    const alphas = log.map(f => f.alpha!).sort((a, b) => a - b);
    expect(alphas[0]).toBeCloseTo(0.45, 3);   // poly 1: 1.45 − 1 extra pass
    expect(alphas[1]).toBeCloseTo(0.65, 3);   // poly 0: 0.5 × 1.3
    expect(alphas[2]).toBe(1);
  });

  it('subset, reveal and clip', () => {
    const c = synthCooked([ribbon(0), ribbon(200, { tone: 3 }), ribbon(400, { tone: 9 })]);
    const a = fakeCtx();
    drawCooked(a.ctx, c, moss(), I, { polys: [2] });
    expect(a.log).toHaveLength(1);
    const b = fakeCtx();
    drawCooked(b.ctx, c, moss(), I, { reveal: i => (i === 1 ? 0 : 1) });
    expect(b.log).toHaveLength(2);
    const d = fakeCtx();
    drawCooked(d.ctx, c, moss(), I, { clipDev: { x0: -10, y0: 150, x1: 200, y1: 250 } });
    expect(d.log).toHaveLength(1);
  });

  it('reveal: a chunk whose successor has not started ends in a round tip, not a weld', () => {
    const c = synthCooked([{ pts: [[0, 0, 6], [20, 0, 6]], tone: 3 }, { pts: [[20, 0, 6], [40, 1, 6]], tone: 9 }]);
    const welded = fakeCtx();
    drawCooked(welded.ctx, c, moss(), I);
    expect(welded.arcs.n).toBe(2);                     // start cap of chunk 0, end cap of chunk 1
    const growing = fakeCtx();
    drawCooked(growing.ctx, c, moss(), I, { reveal: i => (i === 0 ? 1 : 0) });
    expect(growing.arcs.n).toBe(2);                    // chunk 0 alone: both ends capped
    expect(growing.log).toHaveLength(1);
  });

  it('dots and chisel polys draw through the same batches', () => {
    const c = synthCooked([
      { pts: [[10, 10, 8]], kind: PolyKind.Dot, tone: 5 },
      { pts: along([[0, 30], [80, 50]], 2.4, () => 14), kind: PolyKind.Chisel, tone: 5 },
    ]);
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c, moss(), I);
    expect(log).toHaveLength(1);
    expect(log[0].subpaths).toBeGreaterThan(20);
  });
});

describe('inkTableFor', () => {
  const recipe = (color: ColorStyle, colorRev = 0): RecipeCore & { id: string; colorRev: number } => ({
    id: 'x', colorRev, origin: [0, 0], z: 1, rot: 0, seed: 1, device: 'pen',
    calib: { lo: 0, hi: 1, gamma: 1, flat: 1, vMed: 1, jitter: 0.3, fcMin: 2 },
    stroke: { nib: 'brush', size: 9 }, color, form: { form: 'line', v: 1, base: 0 }, s0: 0, cut: 0, resume: null,
  });

  it('caches per recipe object and ground; equal colours share a table', () => {
    const r = recipe(assignVariant('rose', 2, null, null));
    const a = inkTableFor(r, 'night');
    expect(inkTableFor(r, 'night')).toBe(a);
    expect(inkTableFor(r, 'paper')).not.toBe(a);
    expect(inkTableFor(r, 'paper').op).toBe('multiply');
    const r2 = recipe(assignVariant('rose', 2, null, null), 1);
    expect(inkTableFor(r2, 'night')).toBe(a);
    const r3 = recipe(assignVariant('rose', 3, null, null), 2);
    expect(inkTableFor(r3, 'night')).not.toBe(a);
  });
});
