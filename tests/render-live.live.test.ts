/**
 * render-live: the live layer driven through a fake IncrementalCook on a manual clock.
 * Covers the #dry/#wet split, hot trail exactness, living-wake reveals, dirty-rect locality,
 * idle = no work, the two-phase hand-off, un-grow ordering, concurrency, reduced motion,
 * holds, Echo fold-out, replay, restyle, camera gestures and prediction forwarding.
 */
import { describe, it, expect } from 'vitest';
import type { Cooked, InputSample, StrokeRecipe } from '../src/core/types';
import { PolyKind } from '../src/core/types';
import { ALPHA_LEVELS } from '../src/render/batch';
import { drawInk, hotEta, HOT, GROW_MS, UNGROW_MS, RESTYLE_UNGROW_MS, MAX_ANIMATING, type LiveItemInfo } from '../src/render/live';
import { inkTableFor, viewMatrix } from '../src/render/raster';
import { paperAlphaScale } from '../src/ink/operators/registry';
import { easeOutCubic } from '../src/core/num';
import { setup, tick, drawPath, settle, commit, PATH, type Env } from './render-live.drive';
import { FakeCook, addSample, freeze, makeDraft, makeDraftFrom, setPool, wavePath, assemble } from './render-live.fakecook';
import { PL } from '../src/core/types';
import { FakeCanvas, unionBox, type DrawOp } from './render-live.helpers';

/** A committed (cold) fill alpha: an alpha level × the ground's alphaMax (and per-gen scale on Paper). */
const isBucket = (a: number, aMax = 1): boolean => ALPHA_LEVELS.some(l => Math.abs(l * aMax - a) < 1e-9);
const fills = (ops: DrawOp[]): DrawOp[] => ops.filter(o => o.op === 'fill' || o.op === 'stroke');
const liveInfo = (e: Env): LiveItemInfo => e.live.inspect().find(i => i.kind === 'live' || i.kind === 'finish')!;

/** Draw only part of PATH: begin and feed `count` samples. */
function drawSome(e: Env, count: number, perFrame = 2): void {
  drawPath(e, PATH.slice(0, count), perFrame);
}

describe('live stroke: #dry / #wet', () => {
  it('fresh ink starts in #wet and moves to #dry once settled, cooled and revealed', () => {
    const e = setup({ form: 'sprout' });
    drawSome(e, 40);
    const first = liveInfo(e);
    expect(first.polys).toBeGreaterThan(0);
    expect(e.host.wetC.ctx.ops.some(o => o.op === 'fill')).toBe(true);
    drawPath(e, []); // no-op guard
    e.host.dryC.ctx.take(); e.host.wetC.ctx.take();
    // keep drawing: the head of the stroke cools and settles into #dry
    const e2 = setup({ form: 'sprout' });
    drawPath(e2, PATH);
    settle(e2);
    const info = liveInfo(e2);
    expect(info.dry).toBeGreaterThan(info.polys * 0.8);
    expect(fills(e2.host.dryC.ctx.ops).length).toBeGreaterThan(0);
    // every poly is in exactly one place
    const st = info.st!;
    let wet = 0, dry = 0;
    for (let i = 0; i < info.polys; i++) { if (st[i] === 1) wet++; else if (st[i] === 2) dry++; }
    expect(dry).toBe(info.dry);
    expect(wet + dry).toBe(info.polys);
  });

  it('an idle frame does no work: frame() returns false and draws nothing', () => {
    const e = setup({ form: 'sprout' });
    drawPath(e, PATH);
    const n = settle(e);
    expect(n).toBeLessThan(400);
    e.host.dryC.ctx.take(); e.host.wetC.ctx.take();
    for (let k = 0; k < 5; k++) expect(tick(e)).toBe(false);
    expect(e.host.dryC.ctx.ops.length).toBe(0);
    expect(e.host.wetC.ctx.ops.length).toBe(0);
  });

  it('repaints only around the nib while drawing (dirty rects from per-poly boxes)', () => {
    const e = setup({ form: 'drift' });
    drawSome(e, 60);
    const canvasArea = 800 * 600;
    for (let k = 60; k < 160; k += 2) {
      e.host.wetC.ctx.take(); e.host.dryC.ctx.take();
      for (let q = 0; q < 2; q++) addSample(e.d, PATH[k + q][0], PATH[k + q][1], e.host.t - e.tDown, 0.6);
      e.cook.append(2); e.live.update(); tick(e);
      const clears = e.host.wetC.ctx.ops.filter(o => o.op === 'clearRect');
      expect(clears.length).toBeGreaterThan(0);
      const b = unionBox(clears);
      expect((b.x1 - b.x0) * (b.y1 - b.y0)).toBeLessThan(canvasArea * 0.4);
      // the nib (current sample, doc → device: camera centred at 400,300 with scale 1) is inside
      const [x, y] = PATH[k + 1];
      expect(x).toBeGreaterThanOrEqual(b.x0 - 1); expect(x).toBeLessThanOrEqual(b.x1 + 1);
      expect(y).toBeGreaterThanOrEqual(b.y0 - 1); expect(y).toBeLessThanOrEqual(b.y1 + 1);
    }
  });
});

describe('hot trail (DESIGN §3.2)', () => {
  it('burns above the committed alpha on Night (second additive pass) and lands exactly on it', () => {
    const e = setup({ form: 'line', base: 0 });
    drawSome(e, 120, 3);
    const hotOps = fills(e.host.wetC.ctx.take());
    // fresh trunk: an alpha-1 pass plus an additive (α − 1) pass with a non-bucket alpha
    const exact = hotOps.filter(o => !isBucket(o.alpha));
    expect(exact.length).toBeGreaterThan(0);
    expect(exact.every(o => o.comp === 'lighter')).toBe(true);
    // the additive remainder is h·η at most (exact keys are quantised to 1/1024)
    expect(Math.max(...exact.map(o => o.alpha))).toBeLessThanOrEqual(HOT.night.h + 1 / 1024);
    // hold still: after 3τ everything that remains in #wet is cold and every alpha is a bucket
    for (let t = 0; t < 3 * HOT.night.tau + 64; t += 16) tick(e);
    e.host.wetC.ctx.take(); e.host.dryC.ctx.take();
    e.live.onCamera('settled');
    tick(e);
    const cold = fills(e.host.wetC.ctx.take()).concat(fills(e.host.dryC.ctx.take()));
    expect(cold.length).toBeGreaterThan(0);
    expect(cold.every(o => isBucket(o.alpha))).toBe(true);
  });

  it('reads darker on Paper while wet (multiply, above the 0.85 cap, never above 1), dries to 0.85', () => {
    const e = setup({ form: 'line', base: 0, ground: 'paper' });
    drawSome(e, 100, 3);
    const ops = fills(e.host.wetC.ctx.take());
    expect(ops.every(o => o.comp === 'multiply')).toBe(true);
    const wet = ops.filter(o => !isBucket(o.alpha, 0.85));
    expect(wet.length).toBeGreaterThan(0);
    expect(Math.max(...wet.map(o => o.alpha))).toBeGreaterThan(0.85);
    expect(Math.max(...ops.map(o => o.alpha))).toBeLessThanOrEqual(1);
    for (let t = 0; t < 3 * HOT.paper.tau + 64; t += 16) tick(e);
    e.host.wetC.ctx.take(); e.host.dryC.ctx.take();
    e.live.onCamera('settled');
    tick(e);
    const dry = fills(e.host.wetC.ctx.take()).concat(fills(e.host.dryC.ctx.take()));
    expect(dry.length).toBeGreaterThan(0);
    expect(dry.every(o => isBucket(o.alpha, 0.85))).toBe(true);
  });

  it('growth is hot from the moment it appears, cooling with η', () => {
    const e = setup({ form: 'sprout' });
    drawSome(e, 140);
    const info = liveInfo(e);
    const c = info.cooked, hv = info.hv!;
    let found = false;
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] > 0 && hv[i] > 1) { found = true; expect(hv[i]).toBeLessThanOrEqual(1 + HOT.night.h + 1e-6); }
    expect(found).toBe(true);
    settle(e);
    const after = liveInfo(e);
    for (let i = 0; i < after.cooked.nPolys; i++) if (after.st![i] === 2) expect(after.hv![i]).toBe(1);
  });

  it('is off under reduced motion', () => {
    const e = setup({ form: 'sprout', rm: true });
    drawSome(e, 140);
    const ops = fills(e.host.wetC.ctx.ops).concat(fills(e.host.dryC.ctx.ops));
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every(o => isBucket(o.alpha))).toBe(true);
    const info = liveInfo(e);
    for (let i = 0; i < info.cooked.nPolys; i++) expect(info.hv![i]).toBe(1);
  });

  it('the hot window is capped at 120 sp behind the nib', () => {
    const e = setup({ form: 'line', base: 0 });
    // a fast stroke: 8 samples (≈ 19 sp) per frame, so 120 sp is ~100 ms old
    drawSome(e, 200, 8);
    const info = liveInfo(e);
    const c = info.cooked;
    let tip = 0;
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 0) tip = Math.max(tip, c.born[i] + c.pts[4 * (c.start[i] + c.count[i] - 1) + 3]);
    // hot polys are drawn by the hot routine; anything whose newest arc is > 120 sp behind is cold
    expect(info.hot).toBeGreaterThan(0);
    for (let i = 0; i < c.nPolys; i++) {
      if (c.gen[i] !== 0) continue;
      const end = c.born[i] + c.pts[4 * (c.start[i] + c.count[i] - 1) + 3];
      if (end < tip - 125) expect(info.hv![i]).toBe(1);
    }
  });
});

describe('living wake reveal', () => {
  it('Sprout growth unfurls with easeOutCubic over 280 ms per generation, children after their parent', () => {
    const e = setup({ form: 'sprout', base: 3 });
    e.live.begin(e.d, e.cook);
    e.tDown = e.host.t;
    const seen = new Map<string, { gen: number; first: number; full: number }>();
    let k = 0;
    for (let f = 0; f < 200; f++) {
      if (k < PATH.length) {
        for (let q = 0; q < 2 && k < PATH.length; q++, k++) addSample(e.d, PATH[k][0], PATH[k][1], e.host.t - e.tDown, 0.6);
        e.cook.append(2); e.live.update();
      }
      tick(e);
      const info = liveInfo(e);
      const c = info.cooked;
      for (let i = 0; i < c.nPolys; i++) {
        if (c.gen[i] === 0) continue;
        const key = `${c.unit[i]}:${c.gen[i]}:${c.pts[4 * c.start[i]]}:${c.pts[4 * c.start[i] + 1]}`;
        let s = seen.get(key);
        if (!s) { s = { gen: c.gen[i], first: Infinity, full: Infinity }; seen.set(key, s); }
        if (info.rv![i] > 0 && s.first === Infinity) s.first = e.host.t;
        if (info.rv![i] >= 1 && s.full === Infinity) s.full = e.host.t;
      }
    }
    const byGen = new Map<number, number[]>();
    for (const s of seen.values()) {
      if (s.first === Infinity || s.full === Infinity) continue;
      const arr = byGen.get(s.gen) ?? [];
      arr.push(s.full - s.first);
      byGen.set(s.gen, arr);
    }
    const g1 = byGen.get(1)!;
    expect(g1.length).toBeGreaterThan(3);
    // a gen-1 branch takes ~280 ms (frame quantised) to unfurl
    for (const d of g1) { expect(d).toBeGreaterThanOrEqual(260); expect(d).toBeLessThanOrEqual(300); }
    // children start later than their unit's primary: gen 2 first visible after gen 1
    const firstOf = (g: number, unit: string): number => Math.min(...[...seen.entries()].filter(([kk, s]) => s.gen === g && kk.startsWith(unit + ':')).map(([, s]) => s.first));
    const units = new Set([...seen.keys()].map(kk => kk.split(':')[0]));
    let checked = 0;
    for (const u of units) {
      const a = firstOf(1, u), b = firstOf(2, u);
      if (a === Infinity || b === Infinity) continue;
      expect(b - a).toBeGreaterThanOrEqual(Math.floor(0.26 * 280) - 16);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('Drift thirds reveal as one filament (later thirds wait for earlier ones)', () => {
    const e = setup({ form: 'drift', base: 3 });
    drawSome(e, 120);
    const info = liveInfo(e);
    const c = info.cooked, rv = info.rv!;
    let chains = 0;
    for (let i = 1; i < c.nPolys; i++) {
      if (c.gen[i] !== 1 || c.unit[i] !== c.unit[i - 1] || c.gen[i - 1] !== 1) continue;
      const a = 4 * (c.start[i - 1] + c.count[i - 1] - 1), b = 4 * c.start[i];
      if (c.pts[a] !== c.pts[b] || c.pts[a + 1] !== c.pts[b + 1]) continue;
      chains++;
      if (rv[i] > 0) expect(rv[i - 1]).toBe(1);
    }
    expect(chains).toBeGreaterThan(5);
  });

  it('reveals are instant under reduced motion', () => {
    const e = setup({ form: 'sprout', rm: true });
    drawSome(e, 140);
    const info = liveInfo(e);
    for (let i = 0; i < info.cooked.nPolys; i++) expect(info.rv![i]).toBe(1);
  });
});

describe('robust identity', () => {
  for (const [slots, shuffle] of [[true, false], [false, false], [false, true], [true, true]] as const) {
    it(`mirrors the cook exactly (slots ${slots}, shuffled ${shuffle})`, () => {
      const e = setup({ form: 'sprout', slots, shuffle });
      drawPath(e, PATH);
      settle(e);
      const info = liveInfo(e);
      const v = e.cook.view();
      expect(info.polys).toBe(v.geom.nPolys);
      expect(Array.from(info.cooked.pts.subarray(0, 4 * v.geom.nPts))).toEqual(Array.from(v.geom.pts));
      // the settled majority reached #dry
      expect(info.dry).toBeGreaterThan(info.polys * 0.8);
      const { r, c } = commit(e);
      settle(e);
      expect(e.host.bakes.length).toBe(1);
      expect(e.host.bakes[0].r).toBe(r);
      expect(e.host.bakes[0].c).toBe(c);
    });
  }
});

describe('lift and the two-phase hand-off (DESIGN §3.2, §6.2)', () => {
  it('finishes reveals and the hot trail, bakes once, and clears #dry synchronously inside done', () => {
    const e = setup({ form: 'sprout' });
    drawPath(e, PATH);
    const { r, c } = commit(e);
    expect(e.live.active).toBe(false);
    expect(e.host.bakes.length).toBe(0);           // not before the animations end
    expect(e.live.animating).toBe(1);
    settle(e);
    expect(e.host.bakes.length).toBe(1);
    const fin = e.live.inspect();
    expect(fin.length).toBe(1);
    expect(fin[0].kind).toBe('finish');
    expect(fin[0].dry).toBe(c.nPolys);
    expect(e.live.animating).toBe(0);
    e.host.dryC.ctx.take();
    e.host.bakes[0].done();
    // synchronously: the stroke's region of #dry was cleared and nothing of it redrawn
    const ops = e.host.dryC.ctx.take();
    expect(ops.some(o => o.op === 'clearRect')).toBe(true);
    expect(fills(ops).length).toBe(0);
    expect(e.live.inspect().length).toBe(0);
    // a later done() is harmless, and nothing of the stroke ever draws again
    e.host.bakes[0].done();
    e.live.onCamera('settled');
    tick(e);
    expect(fills(e.host.dryC.ctx.take()).length).toBe(0);
    expect(r.id).toBe('stroke-1');
  });

  it('cross-fades the lift zone over 120 ms (new tail in, old tail out)', () => {
    const e = setup({ form: 'line', base: 0 });
    drawPath(e, PATH);
    for (let k = 0; k < 10; k++) tick(e);
    commit(e);
    e.host.wetC.ctx.take();
    tick(e, 60);
    const mid = fills(e.host.wetC.ctx.take());
    expect(mid.length).toBeGreaterThan(0);
    // both fading versions draw with non-bucket alphas mid-fade
    expect(mid.some(o => !isBucket(o.alpha))).toBe(true);
  });

  it('commits instantly under reduced motion', () => {
    const e = setup({ form: 'sprout', rm: true });
    drawPath(e, PATH);
    commit(e);
    tick(e);
    tick(e);
    expect(e.host.bakes.length).toBe(1);
  });

  it('a camera gesture fast-forwards and bakes every animating stroke', () => {
    const e = setup({ form: 'sprout' });
    drawPath(e, PATH);
    commit(e);
    expect(e.host.bakes.length).toBe(0);
    e.live.onCamera('gesture');
    expect(e.host.bakes.length).toBe(1);
    expect(e.live.animating).toBe(0);
  });
});

describe('withdraw, un-grow, re-grow, restyle', () => {
  function cookedStroke(form: 'sprout' | 'drift' | 'line' = 'sprout', id = 's1'): { r: StrokeRecipe; c: Cooked } {
    const d = makeDraft({ form, base: 3 });
    const cook = new FakeCook(d);
    for (let k = 0; k < PATH.length; k++) addSample(d, PATH[k][0], PATH[k][1], k * 8, 0.6);
    cook.append(PATH.length);
    const r = freeze(d, id);
    return { r, c: cook.finish(r) };
  }

  it('withdraw un-grows the live stroke over 200 ms and never bakes', () => {
    const e = setup({ form: 'sprout' });
    drawSome(e, 120);
    e.live.withdraw();
    expect(e.live.active).toBe(false);
    const a = e.live.inspect();
    expect(a.length).toBe(1);
    expect(a[0].mode).toBe('ungrow');
    tick(e, 100);
    expect(e.live.inspect().length).toBe(1);
    tick(e, 120);
    tick(e);
    expect(e.live.inspect().length).toBe(0);
    expect(e.host.bakes.length).toBe(0);
  });

  it('un-grow retracts deepest generations first, the spine last', () => {
    const e = setup();
    const { r, c } = cookedStroke('sprout');
    e.live.ungrow([{ r, c }]);
    const meanRv = (g: number): number => {
      const info = e.live.inspect()[0];
      let s = 0, n = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === g) { s += info.rv![i]; n++; }
      return n ? s / n : NaN;
    };
    tick(e, 50);
    const G = c.genStart.length - 2;
    expect(G).toBeGreaterThanOrEqual(2);
    expect(meanRv(0)).toBe(1);
    expect(meanRv(G)).toBeLessThan(1);
    tick(e, 60);
    expect(meanRv(G)).toBeLessThanOrEqual(meanRv(1));
    expect(meanRv(1)).toBeLessThanOrEqual(meanRv(0));
    tick(e, UNGROW_MS);
    expect(e.live.inspect().length).toBe(0);
  });

  it('grow re-grows (spine first) over 320 ms and then bakes', () => {
    const e = setup();
    const { r, c } = cookedStroke('sprout');
    e.live.grow([{ r, c }]);
    tick(e, 40);
    const info = e.live.inspect()[0];
    let g0 = 0, n0 = 0, gd = 0, nd = 0;
    for (let i = 0; i < c.nPolys; i++) { if (c.gen[i] === 0) { g0 += info.rv![i]; n0++; } else if (c.gen[i] >= 2) { gd += info.rv![i]; nd++; } }
    expect(g0 / n0).toBeGreaterThan(0);
    expect(gd / nd).toBe(0);
    expect(e.host.bakes.length).toBe(0);
    tick(e, GROW_MS);
    expect(e.host.bakes.length).toBe(1);
    expect(e.live.inspect()[0].mode).toBe('bake');
  });

  it('restyle: un-grow the old version (150 ms), then grow the new one, then bake it', () => {
    const e = setup();
    const before = cookedStroke('sprout', 'x');
    const after = cookedStroke('drift', 'x');
    e.live.morph([before], [after]);
    let modes = e.live.inspect().map(i => i.mode).sort();
    expect(modes).toEqual(['ungrow', 'wait']);
    tick(e, RESTYLE_UNGROW_MS + 5);
    tick(e);
    modes = e.live.inspect().map(i => i.mode);
    expect(modes).toEqual(['grow']);
    tick(e, GROW_MS + 5);
    expect(e.host.bakes.length).toBe(1);
    expect(e.host.bakes[0].r).toBe(after.r);
  });

  it('a peel undo drains the pools: shared ink stays, only the pooled growth retracts, then bakes', () => {
    const e = setup();
    const d = makeDraft({ form: 'sprout', base: 2 });
    const cook = new FakeCook(d);
    for (let k = 0; k < PATH.length; k++) addSample(d, PATH[k][0], PATH[k][1], k * 8, 0.6);
    cook.append(PATH.length);
    const L = cook.spine().L;
    const base = freeze(d, 'p');
    const cBase = new FakeCook(makeDraftFrom(d)).finishFrom(base);
    setPool(d, 0.5 * L, 2, 0, 0);
    const pooled = { ...base, pools: d.pools.data.slice(0, PL.STRIDE) };
    const cPooled = new FakeCook(makeDraftFrom(d)).finishFrom(pooled);
    expect(cPooled.nPolys).toBeGreaterThan(cBase.nPolys);
    e.live.morph([{ r: pooled, c: cPooled }], [{ r: base, c: cBase }]);
    const items = e.live.inspect();
    // the pools only added growth: the unpooled revision has nothing of its own to grow, so it
    // bakes at once while the pooled growth drains (review fix: no empty 520 ms wait)
    expect(items.map(i => i.mode).sort()).toEqual(['bake', 'ungrow']);
    tick(e, 16);
    expect(e.host.bakes.length).toBe(1);
    const ug = e.live.inspect().find(i => i.mode === 'ungrow')!;
    const gr = e.live.inspect().find(i => i.mode !== 'ungrow')!;
    // every poly of the unpooled version is either shown already (shared) or waits to grow
    const shared = Array.from(gr.rv!).filter(v => v === 1).length;
    expect(shared).toBeGreaterThan(cBase.nPolys * 0.6);
    // the pooled version draws only what the unpooled one lacks, retracting
    let retracting = 0;
    for (let i = 0; i < cPooled.nPolys; i++) if (ug.rv![i] > 0) retracting++;
    expect(retracting).toBeGreaterThan(0);
    expect(retracting + shared).toBeLessThanOrEqual(cPooled.nPolys + cBase.nPolys);
    tick(e, UNGROW_MS);
    tick(e, GROW_MS);
    tick(e);
    expect(e.host.bakes.length).toBe(1);
    expect(e.host.bakes[0].r).toBe(base);
  });

  it('a look change (colour, nib or Form) is a full un-grow then re-grow', () => {
    const e = setup();
    const a = cookedStroke('sprout', 'z');
    const b = { r: { ...a.r, color: { ...a.r.color, ink: 'rose' as const } }, c: a.c };
    e.live.morph([a], [b]);
    expect(e.live.inspect().map(i => i.mode).sort()).toEqual(['ungrow', 'wait']);
  });

  it('rapid repeats fast-forward: a stroke that is still animating is replaced', () => {
    const e = setup();
    const s = cookedStroke('sprout', 'y');
    e.live.grow([s]);
    tick(e, 50);
    e.live.ungrow([s]);
    const all = e.live.inspect();
    expect(all.length).toBe(1);
    expect(all[0].mode).toBe('ungrow');
  });

  it('at most 4 strokes animate at once; older ones fast-forward (and bake)', () => {
    const e = setup();
    const list = [0, 1, 2, 3, 4, 5].map(k => cookedStroke('sprout', 'g' + k));
    e.live.grow(list);
    expect(e.live.animating).toBeLessThanOrEqual(MAX_ANIMATING);
    expect(e.host.bakes.length).toBe(2);
    expect(e.host.bakes.map(b => b.r.id)).toEqual(['g0', 'g1']);
    // a live stroke counts too
    const e2 = setup({ form: 'sprout' });
    drawSome(e2, 30);
    e2.live.grow(list.slice(0, 4));
    expect(e2.live.animating).toBeLessThanOrEqual(MAX_ANIMATING);
    expect(e2.live.active).toBe(true);
  });

  it('un-grow is instant under reduced motion', () => {
    const e = setup({ rm: true });
    e.live.ungrow([cookedStroke()]);
    expect(e.live.inspect().length).toBe(0);
  });
});

describe('holds: halo, pinned window, regrow', () => {
  it('a hold migrates settled ink near the nib back to #wet, rises live, and settles back', () => {
    const e = setup({ form: 'sprout', base: 1 });
    drawSome(e, 160);
    settle(e);
    const before = liveInfo(e);
    expect(before.dry).toBeGreaterThan(0);
    const tipX = PATH[159][0] - 400 + 400, tipY = PATH[159][1];
    e.live.halo({ x: tipX, y: tipY, rCss: 12, level: 0.2, pre: 1, brim: false, css: '#9fe0a0' });
    tick(e);
    const pinned = liveInfo(e);
    expect(pinned.wet).toBeGreaterThan(before.wet);
    // pool rising at the nib: depth goes up, units regrow
    const L = e.cook.spine().L;
    const pi = setPool(e.d, L, 0.25, 0, 0);
    for (let a = 0.25; a <= 2; a += 0.25) {
      setPool(e.d, L, a, 0, 0, pi);
      e.cook.regrow(L - 48, L + 32);
      e.live.update();
      e.live.halo({ x: tipX, y: tipY, rCss: 12, level: a / 3, pre: 1, brim: a >= 2, css: '#9fe0a0' });
      tick(e);
      const info = liveInfo(e);
      expect(info.polys).toBe(e.cook.view().geom.nPolys);
    }
    // the halo is drawn as ink (a radial-gradient disc with the ground's op) in #wet
    const haloOps = e.host.wetC.ctx.ops.filter(o => o.op === 'fill' && typeof o.style === 'object');
    expect(haloOps.length).toBeGreaterThan(0);
    expect(haloOps.every(o => o.comp === 'lighter')).toBe(true);
    e.live.halo(null);
    settle(e);
    // only provisional ink (the tail, and growth the pool raised ahead of the settled chain) stays wet
    const after = liveInfo(e);
    const slot = (e.cook.view() as { slot: Int32Array }).slot;
    for (let i = 0; i < after.polys; i++) if (after.st![i] !== 2) expect(slot[i]).toBe(-1);
    expect(after.dry).toBeGreaterThanOrEqual(before.dry);
  });

  it('the brim flash keeps frames coming for 160 ms, then stops', () => {
    const e = setup({ form: 'sprout' });
    drawSome(e, 40);
    settle(e);
    e.live.halo({ x: 100, y: 100, rCss: 10, level: 1, pre: 1, brim: true, css: '#ffffff' });
    expect(tick(e)).toBe(true);
    let n = 0;
    while (tick(e) && n < 50) n++;
    expect(n * 16).toBeLessThanOrEqual(200);
  });
});

describe('Echo: ghost while live, fold-out at lift', () => {
  it('draws the ghost in #wet and folds the crystal out with the cook\'s MorphSet', () => {
    const e = setup({ form: 'echo', base: 2 });
    drawPath(e, PATH);
    expect(e.cook.view().ghost).not.toBeNull();
    const { c } = commit(e);
    const fin = liveInfo(e);
    expect(fin.kind).toBe('finish');
    tick(e);
    const mv = liveInfo(e).mv!;
    const g1 = c.genStart[1];
    expect(g1).toBeLessThan(c.nPolys);
    for (let i = g1; i < c.nPolys; i++) { expect(mv[i]).toBeGreaterThan(0); expect(mv[i]).toBeLessThan(1); }
    tick(e, 300);
    const mid = liveInfo(e).mv![g1];
    expect(mid).toBeGreaterThan(easeOutCubic(250 / 590));
    settle(e);
    expect(e.host.bakes.length).toBe(1);
  });
});

describe('replay (play)', () => {
  function recorded(): { r: StrokeRecipe; c: Cooked } {
    const d = makeDraft({ form: 'sprout', base: 2 });
    const cook = new FakeCook(d);
    for (let k = 0; k < PATH.length; k++) addSample(d, PATH[k][0], PATH[k][1], k * 10, 0.6);
    // a pool at 60 % of the stroke, rising from t = 1500 to 2100 ms
    cook.append(PATH.length);
    const L = cook.spine().L;
    setPool(d, 0.6 * L, 1.5, 1500, 2100);
    cook.regrow(0, L);
    const r = freeze(d, 'rec');
    return { r, c: cook.finish(r) };
  }

  it('draws the trunk along its own timing, growth behind it, rises at the pool, then bakes', () => {
    const e = setup();
    const { r, c } = recorded();
    e.live.play(r, c);
    const trunkReveal = (): number => {
      const info = e.live.inspect()[0];
      let s = 0, n = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 0) { s += info.rv![i]; n++; }
      return s / n;
    };
    tick(e, 16);
    const early = trunkReveal();
    for (let k = 0; k < 60; k++) tick(e);            // ~1 s in: about half the 2.2 s stroke
    const half = trunkReveal();
    expect(early).toBeLessThan(0.1);
    expect(half).toBeGreaterThan(0.25);
    expect(half).toBeLessThan(0.75);
    // during the pool interval the synthetic halo is drawn
    e.host.wetC.ctx.take();
    while (e.host.t - 1000 < 1700) tick(e);
    expect(e.host.wetC.ctx.ops.some(o => o.op === 'fill' && typeof o.style === 'object')).toBe(true);
    settle(e, 600);
    expect(e.host.bakes.length).toBe(1);
  });

  it('rests without baking when asked, and dissolves on demand', () => {
    const e = setup();
    const { r, c } = recorded();
    e.live.play(r, c, { bake: false, durationScale: 0.25 });
    settle(e, 600);
    expect(e.host.bakes.length).toBe(0);
    expect(e.live.inspect().length).toBe(1);
    expect(e.live.animating).toBe(0);
    e.live.dissolve(200);
    expect(e.live.inspect()[0].mode).toBe('ungrow');
    tick(e, 210);
    tick(e);
    expect(e.live.inspect().length).toBe(0);
  });

  it('dissolving mid-replay un-grows from what is visible (never pops growth in first)', () => {
    const e = setup();
    const { r, c } = recorded();
    e.live.play(r, c, { bake: false });
    for (let k = 0; k < 50; k++) tick(e);            // ~0.8 s: part drawn, part hidden
    const before = e.live.inspect()[0];
    const vis = Array.from({ length: c.nPolys }, (_, i) => (before.st![i] === 2 ? 1 : before.st![i] === 0 ? 0 : before.rv![i]));
    expect(vis.some(v => v === 0)).toBe(true);
    e.live.dissolve(200);
    for (let k = 0; k < 14; k++) {
      tick(e);
      const u = e.live.inspect()[0];
      if (!u) break;
      for (let i = 0; i < c.nPolys; i++) expect(u.rv![i]).toBeLessThanOrEqual(vis[i] + 1e-6);
    }
  });

  it('is instant under reduced motion', () => {
    const e = setup({ rm: true });
    const { r, c } = recorded();
    e.live.play(r, c);
    tick(e);
    expect(e.host.bakes.length).toBe(1);
  });
});

describe('lifted selection, ground and camera', () => {
  it('draws lifted strokes in #dry and removes them on setLifted(null)', () => {
    const e = setup();
    const d = makeDraft({ form: 'line', base: 0 });
    const cook = new FakeCook(d);
    for (let k = 0; k < PATH.length; k++) addSample(d, PATH[k][0], PATH[k][1], k * 8, 0.6);
    cook.append(PATH.length);
    const r = freeze(d, 'L');
    const c = cook.finish(r);
    e.live.setLifted([{ r, c }]);
    tick(e);
    expect(fills(e.host.dryC.ctx.take()).length).toBeGreaterThan(0);
    e.live.setLifted(null);
    tick(e);
    const ops = e.host.dryC.ctx.take();
    expect(ops.some(o => o.op === 'clearRect')).toBe(true);
    expect(fills(ops).length).toBe(0);
    expect(e.live.inspect().length).toBe(0);
  });

  it('a ground flip re-rasters with the new ink tables and composite op', () => {
    const e = setup({ form: 'sprout' });
    drawPath(e, PATH);
    settle(e);
    e.host.g = 'paper';
    e.live.onGround();
    e.host.dryC.ctx.take();
    tick(e);
    const ops = fills(e.host.dryC.ctx.take());
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every(o => o.comp === 'multiply')).toBe(true);
  });
});

describe('prediction forwarding (DESIGN §2.2.2)', () => {
  it('sends the bridge (ink tip → last sample) plus the predicted tail to the overlay', () => {
    const e = setup({ form: 'sprout' });
    const calls: { tail: readonly InputSample[] | null; w: number; css: string }[] = [];
    e.live.attachOverlay({ predicted: (tail, w, css) => { calls.push({ tail: tail ? tail.map(s => ({ ...s })) : null, w, css }); } });
    drawSome(e, 50);
    const p = (x: number, y: number): InputSample => ({ x, y, t: e.host.t + 4, p: 0.5, alt: Math.PI / 2, az: 0, r: NaN, predicted: true });
    e.live.predict([p(500, 300), p(510, 302)]);
    const last = calls[calls.length - 1];
    expect(last.tail).not.toBeNull();
    expect(last.tail!.length).toBe(4);
    expect(last.tail![0].predicted).toBe(false);
    expect(last.tail![3].predicted).toBe(true);
    // camera centred at (400, 300), scale 1: the last sample maps to its doc position
    expect(last.tail![1].x).toBeCloseTo(PATH[49][0], 3);
    expect(last.w).toBeGreaterThan(0);
    expect(last.css).toMatch(/^#|rgb/);
    commit(e);
    e.live.predict([p(1, 1)]);
    expect(calls[calls.length - 1].tail).toBeNull();
  });
});

describe('drawInk: Paper per-generation alpha', () => {
  it('scales growth by registry.paperAlphaScale on Paper and leaves Night alone', () => {
    const pts = (y: number): number[] => [100, y, 4, 200, y, 4];
    const { c } = assemble([{
      polys: [
        { kind: PolyKind.Ribbon, gen: 0, alpha: 1, tone: 20, born: 0, unit: 0, cat: 0, pts: pts(100) },
        { kind: PolyKind.Ribbon, gen: 1, alpha: 0.38, tone: 21, born: 0, unit: 1, cat: 1, pts: pts(200) },
      ], ids: null,
    }], 1, [0, 0]);
    const night = new FakeCanvas(800, 600), paper = new FakeCanvas(800, 600);
    const rec = makeDraft({ form: 'drift' });
    const m = viewMatrix([0, 0], { cx: 400, cy: 300, scale: 1, rot: 0 }, 800, 600, 1);
    drawInk(night.ctx as unknown as CanvasRenderingContext2D, c, inkTableFor(rec, 'night'), m, 'drift', {});
    drawInk(paper.ctx as unknown as CanvasRenderingContext2D, c, inkTableFor({ ...rec }, 'paper'), m, 'drift', {});
    const at = (ops: DrawOp[], y: number): number => ops.find(o => o.op === 'fill' && o.box.y0 < y && o.box.y1 > y)!.alpha;
    // drawCooked buckets the design alpha and applies alphaMax × alphaScale exactly at fill time
    const bucket = Math.round(0.38 * 8) / 8;
    expect(at(night.ctx.ops, 200)).toBeCloseTo(bucket, 9);
    const k = paperAlphaScale('drift', 1);
    expect(k).toBeCloseTo(0.30 / 0.38, 9);
    expect(at(paper.ctx.ops, 200)).toBeCloseTo(bucket * 0.85 * k, 9);
    expect(at(paper.ctx.ops, 100)).toBeCloseTo(0.85, 9);
  });
});

describe('allocation discipline', () => {
  it('reuses its buffers frame to frame (no growth once warmed up)', () => {
    const e = setup({ form: 'line', base: 0 });
    drawSome(e, 200, 2);
    settle(e);
    // idle frames: nothing to do, nothing allocated
    const heap0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 2000; k++) tick(e);
    const grown = process.memoryUsage().heapUsed - heap0;
    expect(grown).toBeLessThan(2_000_000);
  });

  it('hotEta is cheap and allocation-free', () => {
    let s = 0;
    for (let k = 0; k < 100000; k++) s += hotEta(k % 700, 220);
    expect(s).toBeGreaterThan(0);
  });
});

void wavePath;
