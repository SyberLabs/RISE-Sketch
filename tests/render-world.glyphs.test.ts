import { describe, it, expect } from 'vitest';
import type { Cooked, FormId, NibId, StrokeRecipe, ToolState } from '../src/core/types';
import { S, PL } from '../src/core/types';
import { createGlyphs, lastUsable, stockSamples, strokeMetrics, tileSpace, TILE_MAX_PTS } from '../src/render/glyphs';
import { cookPreview } from '../src/ink/cook';
import { DEFAULT_CALIB } from '../src/ink/calib';
import { createLedger } from '../src/render/ledger';

/** A 2D context that accepts every call (counts them) and returns chainable stubs. */
function anyCtx(log: string[]): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') {
        return () => ({ addColorStop: () => undefined, setTransform: () => undefined });
      }
      return (..._a: unknown[]) => { log.push(k); };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(w: number, h: number, cssW: number, log: string[]): HTMLCanvasElement {
  const ctx = anyCtx(log);
  return { width: w, height: h, clientWidth: cssW, clientHeight: cssW * h / w, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function recipe(samples: Float32Array, z = 1, over: Partial<StrokeRecipe> = {}): StrokeRecipe {
  return {
    id: '000000001' + '0001', created: 0, origin: [100, 50], z, rot: 0, seed: 12345, device: 'pen', calib: DEFAULT_CALIB.pen,
    stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 3, dh: 2, dL: 0.01, lch: null },
    form: { form: 'sprout', v: 1, base: 2 }, s0: 0, cut: 0, resume: null, samples, pools: new Float32Array(0),
    closed: false, radial: false, sym: null, xf: null, geomRev: 4, colorRev: 1, ...over,
  };
}

function line(x0: number, y0: number, x1: number, y1: number, n: number): Float32Array {
  const out = new Float32Array(n * S.STRIDE);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1), o = i * S.STRIDE;
    out[o + S.X] = x0 + (x1 - x0) * u; out[o + S.Y] = y0 + (y1 - y0) * u; out[o + S.T] = i * 8;
    out[o + S.P] = 0.6; out[o + S.ALT] = Math.PI / 2; out[o + S.R] = NaN;
  }
  return out;
}

const tool = (over: Partial<ToolState> = {}): ToolState => ({
  nib: 'brush', lastNib: 'brush', sizes: { pen: 2.5, brush: 9, chisel: 12, charcoal: 7 },
  ink: 'moss', custom: null, recents: [], form: 'sprout',
  base: { line: 0, echo: 2, sprout: 2, drift: 2, ripple: 2, craze: 2, plume: 2, caustic: 2, burin: 2, plait: 2, orbit: 2 }, mode: 'draw', sym: { on: false, folds: 6, cx: 0, cy: 0 }, ...over,
});

describe('last-stroke use rule (DESIGN §3.4)', () => {
  it('needs 40 ≤ L ≤ 2000 sp and an aspect within 1:4..4:1', () => {
    expect(lastUsable(null)).toBe(false);
    // diagonal 100×80 sp
    expect(lastUsable(recipe(line(0, 0, 100, 80, 30)))).toBe(true);
    // too short
    expect(lastUsable(recipe(line(0, 0, 20, 15, 10)))).toBe(false);
    // flat: aspect > 4
    expect(lastUsable(recipe(line(0, 0, 300, 20, 30)))).toBe(false);
    // z = 2 doubles the sp length: 20 doc → 40 sp... a 15×15 doc diagonal is 42 sp at z 2
    expect(lastUsable(recipe(line(0, 0, 15, 15, 10), 2))).toBe(true);
    // a radial tap never qualifies
    expect(lastUsable(recipe(line(0, 0, 100, 80, 30), 1, { radial: true }))).toBe(false);
    const m = strokeMetrics(recipe(line(0, 0, 30, 40, 11), 1));
    expect(m.L).toBeCloseTo(50, 4);
    expect(m.aspect).toBeCloseTo(40 / 30, 6);
  });
});

describe('tile space', () => {
  it('scales the stroke to fit, centred at the origin, keeping speeds', () => {
    const src = recipe(line(0, 0, 200, 100, 41), 2, { pools: Float32Array.of(150, 1.5, 100, 400) });
    const t = tileSpace(src, 80, 60, 'glyph:x');
    const m = strokeMetrics(t);
    expect(t.z).toBe(1);
    expect(t.origin).toEqual([0, 0]);
    expect(Math.max(m.w / 80, m.h / 60)).toBeCloseTo(1, 5);
    // centred
    const n = t.samples.length / S.STRIDE;
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, t.samples[i * S.STRIDE]); x1 = Math.max(x1, t.samples[i * S.STRIDE]); }
    expect(x0 + x1).toBeCloseTo(0, 4);
    // speed (sp/ms) is unchanged: positions and times scale alike
    const v0 = (Math.hypot(200, 100) * 2) / (40 * 8);
    const v1 = m.L / t.samples[(n - 1) * S.STRIDE + S.T];
    expect(v1).toBeCloseTo(v0, 4);
    // pool arcs scale with the stroke; amounts do not
    const k = 80 / 400;
    expect(t.pools[PL.S]).toBeCloseTo(150 * k, 4);
    expect(t.pools[PL.A]).toBe(1.5);
    // the source is untouched
    expect(src.samples[S.X]).toBe(0);
    expect(src.pools[PL.S]).toBe(150);
  });

  it('the stock squiggle is a smooth, strictly timed S-curve', () => {
    const s = stockSamples(120, 60);
    const n = s.length / S.STRIDE;
    expect(n).toBeGreaterThan(20);
    for (let i = 1; i < n; i++) expect(s[i * S.STRIDE + S.T]).toBeGreaterThan(s[(i - 1) * S.STRIDE + S.T]);
    const m = strokeMetrics(recipe(s));
    expect(m.w).toBeCloseTo(120, 5);
    expect(m.h).toBeGreaterThan(30);
  });
});

describe('glyph recipes cook through the real pipeline', () => {
  const forms: FormId[] = ['line', 'echo', 'sprout', 'drift'];
  const nibs: NibId[] = ['pen', 'brush', 'chisel'];
  for (const form of forms) {
    it(`${form}: every nib cooks within the tile budget`, () => {
      for (const nib of nibs) {
        const r = recipe(stockSamples(110, 60), 1, { origin: [0, 0], stroke: { nib, size: nib === 'pen' ? 2.5 : 9 }, form: { form, v: 1, base: 3 } });
        const c = cookPreview(r, TILE_MAX_PTS);
        expect(c.nPts).toBeGreaterThan(0);
        expect(c.nPts).toBeLessThanOrEqual(TILE_MAX_PTS);
        expect(Number.isFinite(c.inkBox.x0) && Number.isFinite(c.inkBox.y1)).toBe(true);
        for (let i = 0; i < c.nPts * 4; i++) expect(Number.isFinite(c.pts[i])).toBe(true);
      }
    });
  }
  it('a re-laid last stroke with pools cooks', () => {
    const src = recipe(line(0, 0, 300, 220, 60), 1.5, { pools: Float32Array.of(200, 2, 0, 0) });
    const c = cookPreview(tileSpace(src, 90, 60, 'glyph:tile'), TILE_MAX_PTS);
    expect(c.nPts).toBeGreaterThan(0);
  });
});

describe('glyph caching', () => {
  function counting(): { cook: (r: StrokeRecipe, n: number) => Cooked; calls: string[] } {
    const calls: string[] = [];
    return { calls, cook: (r, n) => { calls.push(r.form.form + ':' + r.stroke.nib + ':' + r.form.base); return cookPreview(r, n); } };
  }

  it('chips re-cook only when their inputs change; unchanged calls are one blit', () => {
    const { cook, calls } = counting();
    const offLog: string[] = [];
    const ledger = createLedger('desktop', () => fakeCanvas(1, 1, 1, offLog));
    const g = createGlyphs({ cook, ledger });
    const log: string[] = [];
    const cv = fakeCanvas(80, 56, 40, log);
    g.chip(cv, 'form', tool(), 'night', false);
    expect(calls.length).toBe(1);
    expect(offLog.filter(c => c === 'fill').length).toBeGreaterThan(0);  // painted once, off-screen
    expect(log.filter(c => c === 'drawImage').length).toBe(1);
    const painted = offLog.length;
    log.length = 0;
    g.chip(cv, 'form', tool(), 'night', false);  // same state: no cook, no paint, one blit
    expect(calls.length).toBe(1);
    expect(offLog.length).toBe(painted);
    expect(log.filter(c => c === 'drawImage').length).toBe(1);
    expect(log.filter(c => c === 'fill').length).toBe(0);
    g.chip(cv, 'form', tool({ base: { line: 0, echo: 2, sprout: 3, drift: 2, ripple: 2, craze: 2, plume: 2, caustic: 2, burin: 2, plait: 2, orbit: 2 } }), 'night', false);
    expect(calls.length).toBe(2);
    // the colour chip never cooks
    g.chip(fakeCanvas(80, 56, 40, log), 'color', tool(), 'paper', false);
    g.chip(fakeCanvas(80, 56, 40, log), 'color', tool({ ink: 'spectral' }), 'night', false);
    expect(calls.length).toBe(2);
    // erase glyph never cooks either
    g.chip(fakeCanvas(80, 56, 40, log), 'stroke', tool({ mode: 'erase' }), 'night', true);
    expect(calls.length).toBe(2);
  });

  it('a canvas cleared by its owner is redrawn by an unchanged call (no blank tiles)', () => {
    // regression: the glyph used to remember "this canvas shows key k" and skip, so a sheet tile
    // that the UI emptied (clearCanvas) and then refilled with the same option stayed blank
    const offLog: string[] = [];
    const ledger = createLedger('desktop', () => fakeCanvas(1, 1, 1, offLog));
    const g = createGlyphs({ ledger });
    const log: string[] = [];
    const cv = fakeCanvas(192, 128, 96, log);
    const last = recipe(line(0, 0, 160, 110, 50), 1);
    g.tile(cv, { k: 'form', form: 'echo' }, last, tool(), 'night');
    cv.getContext('2d')!.clearRect(0, 0, 192, 128);  // the UI empties the tile
    log.length = 0;
    g.tile(cv, { k: 'form', form: 'echo' }, last, tool(), 'night');
    expect(log.filter(c => c === 'drawImage').length).toBe(1);
  });

  it('ink tiles share one geometry; nib and form tiles cook their own', () => {
    const { cook, calls } = counting();
    const g = createGlyphs({ cook });
    const log: string[] = [];
    const last = recipe(line(0, 0, 160, 110, 50), 1);
    for (const ink of ['graphite', 'indigo', 'oxide', 'ochre', 'moss', 'rose', 'spectral'] as const) {
      g.tile(fakeCanvas(192, 128, 96, log), { k: 'ink', ink }, last, tool(), 'night');
    }
    expect(calls.length).toBe(1);
    g.tile(fakeCanvas(192, 128, 96, log), { k: 'form', form: 'echo' }, last, tool(), 'night');
    g.tile(fakeCanvas(192, 128, 96, log), { k: 'nib', nib: 'chisel' }, last, tool(), 'night');
    expect(calls).toEqual(['sprout:brush:2', 'echo:brush:2', 'line:chisel:0']);  // nib tiles: the bare nib mark
    // the same tile again (another canvas): served from the raster cache, no cook
    g.tile(fakeCanvas(192, 128, 96, log), { k: 'form', form: 'echo' }, last, tool(), 'night');
    expect(calls.length).toBe(3);
    // an unusable last stroke falls back to the stock squiggle with the tool's style
    g.tile(fakeCanvas(192, 128, 96, log), { k: 'form', form: 'drift' }, recipe(line(0, 0, 10, 5, 4)), tool(), 'paper');
    expect(calls[calls.length - 1]).toBe('drift:brush:2');
    g.clear();
    expect(g.cached).toEqual({ rasters: 0, geoms: 0 });
  });

  it('thumbnails stay within budget: late strokes draw as plain spines', () => {
    let clock = 0;
    const cooks: string[] = [];
    const g = createGlyphs({
      cook: (r, n) => { cooks.push(r.id); clock += 25; return cookPreview(r, n); },
      now: () => clock,
    });
    const log: string[] = [];
    const rs = [0, 1, 2, 3, 4].map(i => recipe(line(i * 40, 0, i * 40 + 30, 60, 12), 1, { id: 'r' + i }));
    g.thumb(fakeCanvas(96, 96, 96, log), rs, 'night');
    expect(cooks.length).toBe(2);  // 25 ms each against a 40 ms budget
    expect(log.filter(c => c === 'stroke').length).toBeGreaterThanOrEqual(3);
  });
});
