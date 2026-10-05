/**
 * render-live review: regressions for bugs found in the independent review, plus edge cases the
 * first suite did not reach (degenerate strokes, holds against the real cook, far coordinates).
 */
import { describe, it, expect } from 'vitest';
import type { Cooked, DraftStroke, FormId, StrokeRecipe } from '../src/core/types';
import { PL, S } from '../src/core/types';
import { createIncrementalCook } from '../src/ink/cook';
import { ArcClock, UNGROW_MS } from '../src/render/live';
import { setup, tick, settle, drawPath, commit, PATH } from './render-live.drive';
import { FakeCook, addSample, assemble, freeze, makeDraft, wavePath } from './render-live.fakecook';

describe('replay edge cases', () => {
  /** A recorded stroke whose last samples creep (sub-0.25 sp steps, 8 ms apart): a slow lift. */
  function creeping(form: 'sprout' | 'line' = 'line'): { r: StrokeRecipe; c: Cooked } {
    const d = makeDraft({ form, base: 1 });
    const cook = new FakeCook(d);
    const P = wavePath(80, 200, 400, 40, 160);
    let t = 0;
    for (let k = 0; k < P.length; k++, t += 10) addSample(d, P[k][0], P[k][1], t, 0.6);
    const [lx, ly] = P[P.length - 1];
    for (let k = 1; k <= 4; k++, t += 8) addSample(d, lx + 0.1 * k, ly, t, 0.6);
    cook.append(d.samples.n);
    const r = freeze(d, 'creep');
    return { r, c: cook.finish(r) };
  }

  it('a replay whose stroke ends in tiny slow steps still reveals fully and bakes', () => {
    for (const form of ['line', 'sprout'] as const) {
      const e = setup();
      const { r, c } = creeping(form);
      e.live.play(r, c);
      const n = settle(e, 1000);
      expect(n).toBeLessThan(1000);
      expect(e.host.bakes.length).toBe(1);
      expect(e.live.animating).toBe(0);
    }
  });

  it('a resting replay of such a stroke comes to rest (frames stop)', () => {
    const e = setup();
    const { r, c } = creeping();
    e.live.play(r, c, { bake: false });
    expect(settle(e, 1000)).toBeLessThan(1000);
    expect(e.live.inspect()[0].mode).toBe('dry');
  });

  it('a single-sample (tap) replay and an empty cooked replay both finish', () => {
    const e = setup({ form: 'sprout' });
    const d = makeDraft({ form: 'sprout' });
    addSample(d, 100, 100, 0, 0.7);
    const cook = new FakeCook(d);
    cook.append(1);
    const r = freeze(d, 'tap');
    e.live.play(r, cook.finish(r));
    expect(settle(e, 400)).toBeLessThan(400);
    expect(e.host.bakes.length).toBe(1);
    const empty = new FakeCook(makeDraft()).finish(freeze(makeDraft(), 'none'));
    e.live.play(freeze(makeDraft(), 'none'), empty);
    expect(settle(e, 400)).toBeLessThan(400);
    expect(e.host.bakes.length).toBe(2);
  });
});

describe('ArcClock final marks', () => {
  it('force always lands the final arc, even within the dedupe distance', () => {
    const k = new ArcClock();
    k.mark(0, 0);
    k.mark(10, 100);
    k.mark(10.1, 110);              // dropped: < 0.25 sp and < 40 ms
    expect(k.last).toBe(10);
    k.mark(10.2, 120, true);
    expect(k.last).toBeCloseTo(10.2, 6);
    expect(k.lastTime).toBe(120);
    expect(k.arcAt(1000)).toBeCloseTo(10.2, 6);
    // same time, further arc: the last mark is raised instead of dropped
    k.mark(10.4, 120, true);
    expect(k.last).toBeCloseTo(10.4, 6);
    // never backwards
    k.mark(5, 200, true);
    expect(k.last).toBeCloseTo(10.4, 6);
  });
});

describe('degenerate live strokes', () => {
  it('withdraw and commit right after begin (no samples) never throw and leave nothing animating', () => {
    const e = setup({ form: 'sprout' });
    e.live.begin(e.d, e.cook);
    e.live.withdraw();
    expect(settle(e)).toBeLessThan(400);
    expect(e.live.inspect().length).toBe(0);
    const e2 = setup({ form: 'drift' });
    e2.live.begin(e2.d, e2.cook);
    commit(e2, 'empty');
    expect(settle(e2)).toBeLessThan(400);
    expect(e2.host.bakes.length).toBe(1);
    e2.host.bakes[0].done();
    expect(e2.live.inspect().length).toBe(0);
  });

  it('ink a million units from the document origin draws where it is (Float64 offsets)', () => {
    const e = setup({ form: 'line', origin: [1e6, -1e6] });
    e.host.cam = { cx: 1e6 + 300, cy: -1e6 + 300, scale: 1, rot: 0 };
    drawPath(e, PATH);
    settle(e);
    const ops = e.host.dryC.ctx.ops.filter(o => o.op === 'fill');
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      expect(o.box.x0).toBeGreaterThan(-50); expect(o.box.x1).toBeLessThan(850);
      expect(o.box.y0).toBeGreaterThan(-50); expect(o.box.y1).toBeLessThan(650);
    }
  });
});

describe('holds against the real cook', () => {
  function draft(form: FormId): DraftStroke {
    return {
      origin: [0, 0], z: 1, rot: 0, seed: 7, device: 'pen',
      calib: { lo: 0.04, hi: 0.8, gamma: 1, flat: 1, vMed: 0.9, jitter: 0.3, fcMin: 2 },
      stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null },
      form: { form, v: 1, base: 1 }, s0: 0, cut: 0, resume: null,
      samples: { data: new Float32Array((PATH.length + 400) * S.STRIDE), n: 0 },
      pools: { data: new Float32Array(8 * PL.STRIDE), n: 0 }, closing: false,
    };
  }

  for (const form of ['sprout', 'drift', 'line', 'echo'] as const) {
    it(`${form}: pools rise under a held nib with a halo, the stroke moves on, lifts, and bakes once`, () => {
      const e = setup();
      const d = draft(form);
      const cook = createIncrementalCook(d);
      e.live.begin(d, cook);
      const t0 = e.host.t;
      const push = (x: number, y: number): void => {
        const o = d.samples.n * S.STRIDE, D = d.samples.data;
        D[o + S.X] = x; D[o + S.Y] = y; D[o + S.T] = e.host.t - t0; D[o + S.P] = 0.7;
        D[o + S.ALT] = Math.PI / 2; D[o + S.AZ] = 0; D[o + S.R] = NaN; D[o + S.C] = 0; D[o + S.CS] = 0;
        d.samples.n++;
      };
      const half = Math.floor(PATH.length / 2);
      for (let k = 0; k < half; k++) { push(PATH[k][0], PATH[k][1]); cook.append(1); e.live.update(); tick(e, 8); }
      // hold: a pool rises at the nib for ~600 ms, the halo tracks it, the brim flashes at the end
      const L = cook.spine().L;
      for (let f = 0; f < 40; f++) {
        const a = Math.min(2, f * 0.06);
        const o = 0;
        d.pools.data[o + PL.S] = L; d.pools.data[o + PL.A] = Math.round(a * 16) / 16;
        d.pools.data[o + PL.T0] = 0; d.pools.data[o + PL.T1] = e.host.t - t0;
        d.pools.n = 1;
        cook.regrow(L - 48, L + 32);
        e.live.update();
        e.live.halo({ x: 300, y: 300, rCss: 10, level: a / 3, pre: 1, brim: a >= 2, css: '#88cc88' });
        tick(e);
      }
      e.live.halo(null);
      for (let k = half; k < PATH.length; k++) { push(PATH[k][0], PATH[k][1]); cook.append(1); e.live.update(); tick(e, 8); }
      settle(e);
      const r: StrokeRecipe = {
        ...d, id: 'held-' + form, created: 0, samples: d.samples.data.slice(0, d.samples.n * S.STRIDE),
        pools: d.pools.data.slice(0, d.pools.n * PL.STRIDE), closed: false, radial: false, sym: null, xf: null,
        geomRev: 0, colorRev: 0,
      };
      const c = cook.finish(r);
      e.live.commit(r, c);
      expect(settle(e, 600)).toBeLessThan(600);
      expect(e.host.bakes.length).toBe(1);
      expect(e.host.bakes[0].c).toBe(c);
      e.host.bakes[0].done();
      expect(e.live.inspect().length).toBe(0);
      expect(tick(e)).toBe(false);
    }, 30_000);
  }
});

describe('halo lifetime', () => {
  const gradientFills = (ops: { op: string; style: unknown }[]): number => ops.filter(o => o.op === 'fill' && typeof o.style === 'object').length;

  it('lift ends the halo even when the caller never sent halo(null)', () => {
    const e = setup({ form: 'sprout' });
    drawPath(e, PATH.slice(0, 120));
    e.live.halo({ x: 300, y: 300, rCss: 12, level: 0.5, pre: 1, brim: false, css: '#88cc88' });
    tick(e);
    expect(gradientFills(e.host.wetC.ctx.take())).toBeGreaterThan(0);
    commit(e);
    // the lift repaints the whole stroke (and the old halo's rect): no halo is drawn again
    for (let k = 0; k < 30; k++) tick(e);
    expect(gradientFills(e.host.wetC.ctx.take())).toBe(0);
  });

  it('withdraw and a new stroke end it too', () => {
    const e = setup({ form: 'line' });
    drawPath(e, PATH.slice(0, 60));
    e.live.halo({ x: 300, y: 300, rCss: 12, level: 0.5, pre: 1, brim: true, css: '#88cc88' });
    tick(e);
    e.live.withdraw();
    e.host.wetC.ctx.take();
    for (let k = 0; k < 20; k++) tick(e);
    expect(gradientFills(e.host.wetC.ctx.take())).toBe(0);
    expect(settle(e)).toBeLessThan(400);
  });
});

describe('whole-stroke growth of a tap', () => {
  /** A tap: its trunk is one zero-length ribbon piece (two coincident points) plus a little growth. */
  function tap(): { r: StrokeRecipe; c: Cooked } {
    const r = freeze(makeDraft({ form: 'sprout' }), 'tap');
    const { c } = assemble([{ polys: [
      { kind: 0, gen: 0, alpha: 1, tone: 20, born: 0, unit: 0, cat: 0, pts: [300, 300, 10, 300, 300, 10] },
      { kind: 0, gen: 1, alpha: 0.7, tone: 21, born: 0, unit: 0, cat: 0, pts: [300, 300, 4, 306, 290, 3, 310, 280, 2] },
    ], ids: null }], 1, [0, 0]);
    return { r, c };
  }

  it('grows in (never pops in whole at the first frame) and un-grows to nothing', () => {
    const e = setup();
    const { r, c } = tap();
    expect(c.pts[3]).toBe(c.pts[7]);                  // the trunk piece really has zero arc length
    e.live.grow([{ r, c }]);
    tick(e, 16);
    const early = e.live.inspect()[0].rv![0];
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.6);
    settle(e);
    expect(e.host.bakes.length).toBe(1);
    e.live.ungrow([{ r, c }]);
    let last = 1;
    for (let k = 0; k < 20; k++) {
      tick(e, 10);
      const u = e.live.inspect()[0];
      if (!u) break;
      expect(u.rv![0]).toBeLessThanOrEqual(last + 1e-9);
      last = u.rv![0];
    }
    expect(last).toBeLessThan(0.3);                  // was stuck at 1 before the fix
  });
});

describe('diff restyles with one-sided changes', () => {
  /** Two revisions of one stroke differing only in pools: `small` ⊂ `big` (one extra growth unit). */
  function revisions(): { small: { r: StrokeRecipe; c: Cooked }; big: { r: StrokeRecipe; c: Cooked } } {
    const base = freeze(makeDraft({ form: 'sprout' }), 'peel');
    const trunk = { kind: 0, gen: 0, alpha: 1, tone: 20, born: 0, unit: 0, cat: 0, pts: [100, 300, 8, 200, 300, 8, 300, 300, 8] };
    const u1 = { kind: 0, gen: 1, alpha: 0.7, tone: 21, born: 50, unit: 1, cat: 0, pts: [150, 300, 4, 160, 280, 3, 170, 260, 2] };
    const u2 = { kind: 0, gen: 1, alpha: 0.7, tone: 21, born: 150, unit: 2, cat: 0, pts: [250, 300, 4, 260, 280, 3, 270, 260, 2] };
    const small = assemble([{ polys: [trunk, u1], ids: null }], 1, [0, 0]).c;
    const big = assemble([{ polys: [trunk, u1, u2], ids: null }], 1, [0, 0]).c;
    const pooled: StrokeRecipe = { ...base, pools: Float32Array.of(200, 1, 0, 100) };
    return { small: { r: base, c: small }, big: { r: pooled, c: big } };
  }

  it('a drain-only peel undo bakes the new revision at once while the old growth retracts', () => {
    const e = setup();
    const { small, big } = revisions();
    e.live.morph([big], [small]);
    expect(e.live.inspect().map(i => i.mode).sort()).toEqual(['bake', 'ungrow']);
    tick(e);
    expect(e.host.bakes.length).toBe(1);
    expect(e.host.bakes[0].r).toBe(small.r);
    const ug = e.live.inspect().find(i => i.mode === 'ungrow')!;
    // only the unit the pool added retracts; shared ink is never drawn from the old revision
    expect(Array.from(ug.rv!).filter(v => v > 0).length).toBe(1);
    tick(e, UNGROW_MS + 5);
    expect(e.live.inspect().filter(i => i.mode === 'ungrow').length).toBe(0);
  });

  it('a grow-only change (redo of the pools) grows at once, with nothing to wait for', () => {
    const e = setup();
    const { small, big } = revisions();
    e.live.morph([small], [big]);
    expect(e.live.inspect().map(i => i.mode)).toEqual(['grow']);
    tick(e, 40);
    const g = e.live.inspect()[0];
    const growing = Array.from(g.rv!).filter(v => v > 0 && v < 1).length;
    expect(growing).toBe(1);
    expect(settle(e)).toBeLessThan(400);
    expect(e.host.bakes.length).toBe(1);
    expect(e.host.bakes[0].r).toBe(big.r);
  });
});
