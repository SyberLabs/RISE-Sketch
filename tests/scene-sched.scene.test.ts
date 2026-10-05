import { describe, it, expect } from 'vitest';
import { createScene, sameGeometry, COOKED_CAP_BYTES } from '../src/scene/scene';
import type { SceneDeps } from '../src/scene/scene';
import { createJobs } from '../src/sched/jobs';
import type { Cooked, StrokeId, StrokeRecipe } from '../src/core/types';
import {
  FakeDoc, fakeClock, fakeSpineOf, linePts, makeRecipe, mulberry, trunkCooked,
} from './scene-sched.helpers';
import type { PolySpec } from './scene-sched.helpers';

/** A scene over a FakeDoc with a counting fake cook (trunk + whatever `extras` says). */
function setup(initial: StrokeRecipe[] = [], opts: Partial<SceneDeps> & { extras?: (r: StrokeRecipe) => PolySpec[] } = {}) {
  const doc = new FakeDoc(initial);
  const clock = fakeClock();
  const jobs = createJobs(clock.now);
  const cooks: string[] = [];
  let frames = 0;
  const cook = (r: StrokeRecipe): Cooked => {
    cooks.push(r.id + '@' + r.geomRev);
    if (r.form.form === 'ripple') throw new Error('cannot cook');
    return trunkCooked(r, 4, opts.extras?.(r) ?? []);
  };
  const scene = createScene({ doc, cook, jobs, requestFrame: () => { frames++; }, ...opts });
  const drain = () => { while (jobs.run(1000)); };
  /** ensure + run the jobs + await. */
  const cookNow = async (ids: readonly StrokeId[]) => {
    const p = scene.ensure(ids, 'visible');
    drain();
    await p;
  };
  return { doc, scene, jobs, cooks, drain, cookNow, frames: () => frames };
}

const line = (n: number, x0: number, y0: number, x1: number, y1: number, extra: Partial<Parameters<typeof makeRecipe>[0]> = {}) =>
  makeRecipe({ n, pts: linePts(x0, y0, x1, y1, 21), ...extra });

const all = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };

describe('scene: index and cache coherence', () => {
  it('indexes the strokes already in the doc with conservative boxes until cooked', async () => {
    const a = line(1, 0, 0, 100, 0), b = line(2, 0, 50, 100, 50);
    const s = setup([a, b]);
    expect(s.scene.query(all, [])).toEqual([a.id, b.id]);
    const pad = (64 + 3 * 9) / 1;
    expect(s.scene.boxOf(a.id)).toEqual({ x0: -pad, y0: -pad, x1: 100 + pad, y1: pad });
    expect(s.scene.isExact(a.id)).toBe(false);
    // a box 30 doc below a's ink but within the conservative pad still finds it while uncooked
    expect(s.scene.query({ x0: 40, y0: 20, x1: 60, y1: 25 }, [])).toEqual([a.id, b.id]);
    expect(s.scene.cooked(a.id)).toBeUndefined();
    await s.cookNow([a.id, b.id]);
    expect(s.scene.isExact(a.id)).toBe(true);
    expect(s.scene.boxOf(a.id)).toEqual({ x0: -2, y0: -2, x1: 102, y1: 2 });
    expect(s.scene.query({ x0: 40, y0: 20, x1: 60, y1: 25 }, [])).toEqual([]);
    expect(s.scene.cooked(a.id)?.nPolys).toBe(1);
    expect(s.scene.cachedPoints).toBe(42);
    expect(s.scene.contentBox()).toEqual({ x0: -2, y0: -2, x1: 102, y1: 52 });
    expect(s.frames()).toBeGreaterThan(0);
  });

  it('query output is cleared, z-ordered by id, and tolerant of bad boxes', () => {
    const rs = [5, 3, 9, 1].map(n => line(n, n * 10, 0, n * 10 + 5, 0));
    const s = setup(rs);
    const out = ['stale'];
    expect(s.scene.query(all, out)).toBe(out);
    expect(out).toEqual(rs.map(r => r.id).sort());
    expect(s.scene.query({ x0: NaN, y0: 0, x1: 1, y1: 1 }, out)).toEqual([]);
  });

  it('follows add / remove / geometry / colour changes', async () => {
    const s = setup();
    const a = line(1, 0, 0, 100, 0);
    s.doc.apply({ k: 'add', recipes: [a] });
    expect(s.scene.query(all, [])).toEqual([a.id]);
    expect(s.scene.occupancy.strokes).toBe(1);
    expect(s.scene.crowding(50, 0, 1)).toBeGreaterThan(0);
    await s.cookNow([a.id]);
    const ca = s.scene.cooked(a.id)!;

    // colour-only replace: same geometry, cache kept, no re-cook
    const aRed = { ...a, color: { ...a.color, ink: 'rose' as const }, colorRev: 1 };
    s.doc.apply({ k: 'replace', before: [a], after: [aRed] });
    expect(s.scene.cooked(a.id)).toBe(ca);
    await s.cookNow([a.id]);
    expect(s.cooks).toEqual([a.id + '@0']);

    // geometry replace (moved 500 doc): index + occupancy move, cache misses until re-cooked
    const moved = { ...aRed, origin: [0, 500] as const, geomRev: 1 };
    s.doc.apply({ k: 'replace', before: [aRed], after: [moved] });
    expect(s.scene.cooked(a.id)).toBeUndefined();
    expect(s.scene.isExact(a.id)).toBe(false);
    expect(s.scene.crowding(50, 0, 1)).toBe(0);
    expect(s.scene.crowding(50, 500, 1)).toBeGreaterThan(0);
    expect(s.scene.query({ x0: 0, y0: -10, x1: 100, y1: 10 }, [])).toEqual([]);
    expect(s.scene.cookedFor(aRed)).toBe(ca);       // the old revision is still cached
    await s.cookNow([a.id]);
    expect(s.cooks).toEqual([a.id + '@0', a.id + '@1']);
    expect(s.scene.boxOf(a.id)!.y0).toBe(498);

    // undo the move: the earlier revision comes straight from the cache
    s.doc.apply({ k: 'replace', before: [moved], after: [aRed] });
    expect(s.scene.cooked(a.id)).toBe(ca);
    expect(s.scene.isExact(a.id)).toBe(true);

    // remove: out of the index and occupancy, but cooked(id) still answers (un-grow)
    s.doc.apply({ k: 'remove', ids: [a.id] });
    expect(s.scene.query(all, [])).toEqual([]);
    expect(s.scene.occupancy.cells).toBe(0);
    expect(s.scene.cooked(a.id)).toBe(ca);
    expect(s.scene.contentBox()).toBeNull();
    // undo the removal: no re-cook
    s.doc.apply({ k: 'add', recipes: [aRed] });
    expect(s.scene.isExact(a.id)).toBe(true);
    expect(s.scene.cooked(a.id)).toBe(ca);
    expect(s.cooks.length).toBe(2);
  });

  it('never confuses two different restyles that reach the same geomRev', async () => {
    const s = setup();
    const A = line(1, 0, 0, 100, 0);
    s.doc.apply({ k: 'add', recipes: [A] });
    const B = { ...A, stroke: { ...A.stroke, size: 30 }, geomRev: 1 };
    s.doc.apply({ k: 'replace', before: [A], after: [B] });
    await s.cookNow([A.id]);
    const cB = s.scene.cooked(A.id)!;
    s.doc.apply({ k: 'replace', before: [B], after: [A] });           // undo
    const C = { ...A, form: { ...A.form, form: 'sprout' as const }, geomRev: 1 };
    expect(sameGeometry(B, C)).toBe(false);
    s.doc.apply({ k: 'replace', before: [A], after: [C] });
    expect(s.scene.cooked(A.id)).toBeUndefined();
    await s.cookNow([A.id]);
    expect(s.scene.cooked(A.id)).not.toBe(cB);
    expect(s.cooks).toEqual([A.id + '@1', A.id + '@1']);
    expect(s.scene.cookedFor(B)).toBe(cB);
  });

  it('a batch that adds and removes in one change is reconciled against the doc', () => {
    const s = setup();
    const a = line(1, 0, 0, 10, 0), b = line(2, 0, 0, 10, 0);
    s.doc.apply({ k: 'batch', cmds: [{ k: 'add', recipes: [a, b] }, { k: 'remove', ids: [a.id] }] });
    expect(s.scene.query(all, [])).toEqual([b.id]);
    expect(s.scene.occupancy.strokes).toBe(1);
  });
});

describe('scene: put and the commit path', () => {
  it('put after add registers geometry without cooking and cancels a queued cook', async () => {
    const s = setup();
    const a = line(1, 0, 0, 100, 0);
    s.doc.apply({ k: 'add', recipes: [a] });
    const p = s.scene.ensure([a.id], 'background');
    const c = trunkCooked(a, 6);
    s.scene.put(a.id, c);
    s.drain();
    await p;
    expect(s.cooks).toEqual([]);
    expect(s.scene.cooked(a.id)).toBe(c);
    expect(s.scene.boxOf(a.id)).toEqual({ x0: -3, y0: -3, x1: 103, y1: 3 });
  });

  it('put before add is adopted when the stroke arrives', () => {
    const s = setup();
    const a = line(1, 0, 0, 100, 0);
    const c = trunkCooked(a);
    s.scene.put(a.id, c);
    s.doc.apply({ k: 'add', recipes: [a] });
    expect(s.scene.cooked(a.id)).toBe(c);
    expect(s.scene.isExact(a.id)).toBe(true);
  });

  it('putFor keys by the exact recipe (peel: add at base depth, then replace with pools)', () => {
    const s = setup();
    const base = line(1, 0, 0, 100, 0);
    const pooled = { ...base, pools: Float32Array.of(50, 2, 0, 400), geomRev: 1 };
    const cPooled = trunkCooked(pooled, 8);
    s.scene.putFor(pooled, cPooled);            // before either doc.apply
    s.doc.apply({ k: 'add', recipes: [base] });
    expect(s.scene.cooked(base.id)).toBeUndefined();   // base depth is NOT the pooled geometry
    s.doc.apply({ k: 'replace', before: [base], after: [pooled] });
    expect(s.scene.cooked(base.id)).toBe(cPooled);
    s.doc.apply({ k: 'replace', before: [pooled], after: [base] }); // first undo peels the pools
    expect(s.scene.cooked(base.id)).toBeUndefined();
    expect(s.scene.cookedFor(pooled)).toBe(cPooled);
  });
});

describe('scene: ensure and the kitchen', () => {
  it('ensure skips cached and unknown strokes, dedupes, and resolves after cooking', async () => {
    const a = line(1, 0, 0, 10, 0), b = line(2, 0, 20, 10, 20);
    const s = setup([a, b]);
    await s.scene.ensure(['nope'], 'visible');
    const p1 = s.scene.ensure([a.id, b.id], 'background');
    const p2 = s.scene.ensure([b.id], 'handoff');       // raises b's priority
    expect(s.scene.kitchen.pending).toBe(2);
    s.jobs.run(1000);
    await Promise.all([p1, p2]);
    expect(s.cooks).toEqual([b.id + '@0', a.id + '@0']);
    await s.cookNow([a.id, b.id]);
    expect(s.cooks.length).toBe(2);
  });

  it('a stroke removed while queued is cancelled and ensure still resolves', async () => {
    const a = line(1, 0, 0, 10, 0);
    const s = setup([a]);
    const p = s.scene.ensure([a.id], 'visible');
    s.doc.apply({ k: 'remove', ids: [a.id] });
    s.drain();
    await expect(p).resolves.toBeUndefined();
    expect(s.cooks).toEqual([]);
  });

  it('a geometry change while queued drops the stale cook', async () => {
    const a = line(1, 0, 0, 10, 0);
    const s = setup([a]);
    const p = s.scene.ensure([a.id], 'visible');
    const a1 = { ...a, stroke: { ...a.stroke, size: 20 }, geomRev: 1 };
    s.doc.apply({ k: 'replace', before: [a], after: [a1] });
    s.drain();
    await p;
    expect(s.cooks).toEqual([]);
    await s.cookNow([a.id]);
    expect(s.cooks).toEqual([a.id + '@1']);
  });

  it('a cook that throws is not retried for the same geometry', async () => {
    const bad = line(1, 0, 0, 10, 0, { form: 'ripple' });
    const s = setup([bad]);
    await s.cookNow([bad.id]);
    await s.cookNow([bad.id]);
    expect(s.cooks).toEqual([bad.id + '@0']);
    expect(s.scene.cooked(bad.id)).toBeUndefined();
    const fixed = { ...bad, form: { ...bad.form, form: 'line' as const }, geomRev: 1 };
    s.doc.apply({ k: 'replace', before: [bad], after: [fixed] });
    await s.cookNow([bad.id]);
    expect(s.scene.cooked(bad.id)).toBeDefined();
  });
});

describe('scene: LRU', () => {
  it('evicts least recently used entries by bytes and keeps exact boxes', async () => {
    const rs = Array.from({ length: 10 }, (_, i) => line(i + 1, 0, i * 10, 100, i * 10));
    const one = trunkCooked(rs[0]).bytes;
    const s = setup(rs, { cacheBytes: one * 4 + 10 });
    expect(s.scene.cacheCap).toBe(one * 4 + 10);
    await s.cookNow(rs.map(r => r.id));
    expect(s.scene.cachedEntries).toBe(4);
    expect(s.scene.cachedBytes).toBeLessThanOrEqual(one * 4 + 10);
    expect(rs.slice(6).every(r => s.scene.cooked(r.id))).toBe(true);
    expect(s.scene.cooked(rs[0].id)).toBeUndefined();
    // evicted strokes keep their exact inkBox in the index
    expect(s.scene.isExact(rs[0].id)).toBe(true);
    // touching rs[6] makes rs[7] the next victim
    s.scene.cooked(rs[6].id);
    await s.cookNow([rs[0].id]);
    expect(s.scene.cooked(rs[6].id)).toBeDefined();
    expect(s.scene.cooked(rs[7].id)).toBeUndefined();
    expect(s.scene.cachedPoints).toBe(4 * 21);
    s.scene.setCacheBytes(one + 1);
    expect(s.scene.cachedEntries).toBe(1);
    s.scene.setCacheBytes(0);
    expect(s.scene.cachedEntries).toBe(0);
    expect(s.scene.cachedPoints).toBe(0);
  });

  it('charge() counts derived bytes (LODs) against the entry and can trigger eviction', async () => {
    const rs = [1, 2, 3].map(i => line(i, 0, i * 10, 100, i * 10));
    const one = trunkCooked(rs[0]).bytes;
    const s = setup(rs, { cacheBytes: one * 3 + 100 });
    await s.cookNow(rs.map(r => r.id));
    expect(s.scene.cachedEntries).toBe(3);
    const c0 = s.scene.cooked(rs[0].id)!;
    s.scene.charge(c0, 50);
    expect(s.scene.cachedBytes).toBe(one * 3 + 50);
    s.scene.charge(c0, -10);                       // ignored
    s.scene.charge(trunkCooked(rs[0]), 1e9);       // not cached: ignored
    expect(s.scene.cachedEntries).toBe(3);
    s.scene.cooked(rs[1].id); s.scene.cooked(rs[2].id);
    s.scene.charge(s.scene.cooked(rs[2].id)!, 60); // over the cap: the LRU entry (rs[0]) goes
    expect(s.scene.cooked(rs[0].id)).toBeUndefined();
    expect(s.scene.cachedBytes).toBe(one * 2 + 60);
    s.scene.charge(c0, 50);                        // evicted: no-op
    expect(s.scene.cachedBytes).toBe(one * 2 + 60);
    // re-registering geometry resets the charge
    s.scene.put(rs[2].id, trunkCooked(rs[2]));
    expect(s.scene.cachedBytes).toBe(one * 2);
  });

  it('default cap is the desktop budget', () => {
    expect(setup().scene.cacheCap).toBe(COOKED_CAP_BYTES.desktop);
    expect(COOKED_CAP_BYTES.phone).toBe(48 * 1024 * 1024);
    expect(COOKED_CAP_BYTES.tablet).toBe(96 * 1024 * 1024);
  });
});

describe('scene: hit, pick, sweep, lasso', () => {
  // a: trunk along y = 0 with a strong branch up at x = 50 and a faint one down at x = 80
  const extras = (r: StrokeRecipe): PolySpec[] => r.form.form === 'sprout'
    ? [{ pts: [[50, 0, 2], [50, -40, 1]], alpha: 0.6, gen: 1 }, { pts: [[80, 0, 2], [80, 40, 1]], alpha: 0.2, gen: 1 }]
    : [];

  it('capsule first, then polys with alpha ≥ 0.3; topmost wins', async () => {
    const a = line(1, 0, 0, 100, 0, { form: 'sprout' });
    const b = line(2, 40, -60, 40, 60);   // later stroke crossing a
    const s = setup([a, b], { extras });
    // uncooked: capsules from raw samples (w = 0.7·9 = 6.3)
    expect(s.scene.hit([20, 3], 0.5)).toBe(a.id);
    expect(s.scene.hit([40, 0], 0.5)).toBe(b.id);        // both hit: the later one is on top
    expect(s.scene.hit([50, -30], 0.5)).toBeNull();      // branch not known before cooking
    await s.cookNow([a.id, b.id]);
    expect(s.scene.hit([50, -30], 0.5)).toBe(a.id);      // strong branch
    expect(s.scene.hit([80, 30], 0.5)).toBeNull();       // faint branch (α 0.2) ignored
    expect(s.scene.hit([80, 30], 0.5, 0.1)).toBe(a.id);
    expect(s.scene.hit([200, 200], 5)).toBeNull();
    expect(s.scene.hit([NaN, 0], 5)).toBeNull();
    expect(s.scene.pick([50, -30], 0.5)).toEqual({ id: a.id, poly: 1 });
    expect(s.scene.pick([20, 0], 0.5)).toEqual({ id: a.id, poly: 0 });
  });

  it('uses the cooked spine when spineOf is provided', () => {
    const a = line(1, 0, 0, 100, 0);
    const spineOf = fakeSpineOf(20);    // much wider than the nominal 6.3
    const s = setup([a], { spineOf });
    expect(s.scene.hit([50, 9.5], 0)).toBe(a.id);
    expect(spineOf.calls).toBe(1);
    const plain = setup([a]);
    expect(plain.scene.hit([50, 9.5], 0)).toBeNull();
    // a throwing spineOf falls back to samples
    const broken = setup([a], { spineOf: () => { throw new Error('no spine'); } });
    expect(broken.scene.hit([50, 3], 0)).toBe(a.id);
  });

  it('the untapered spine capsule past the tapered ink is still hittable (index = inkBox ∪ hitBox)', async () => {
    const a = line(1, 0, 0, 100, 0);
    const spineOf = fakeSpineOf(10);          // untapered width 10: capsule reaches x = 105
    const doc = new FakeDoc([a]);
    const jobs = createJobs(fakeClock().now);
    // a hairline cook (tapered ink 0.5 wide); its hitBox also covers the spine capsule, as ink-forms' does
    const cook = (r: StrokeRecipe): Cooked => {
      const c = trunkCooked(r, 0.5);
      c.hitBox = { x0: -5, y0: -5, x1: 105, y1: 5 };
      return c;
    };
    const scene = createScene({ doc, cook, jobs, requestFrame() {}, spineOf });
    const p = scene.ensure([a.id], 'visible');
    while (jobs.run(100));
    await p;
    expect(scene.cooked(a.id)!.inkBox.x1).toBeCloseTo(100.25, 6);
    expect(scene.boxOf(a.id)).toEqual({ x0: -5, y0: -5, x1: 105, y1: 5 });
    expect(scene.hit([104, 0], 0)).toBe(a.id);          // missed before: inkBox ends at 100.25
    const out = new Set<StrokeId>();
    scene.sweep([104, -20], [104, 20], 0, out);
    expect([...out]).toEqual([a.id]);
    expect(scene.lineage(103.5, 0, 'moss', 0.1, 1e4)).toBe(a.id);
    expect(scene.hit([106, 0], 0)).toBeNull();
  });

  it('a corrupt recipe (non-finite origin) is tracked but never placed, and never breaks the index', async () => {
    const rs = Array.from({ length: 30 }, (_, i) => line(i + 1, i * 20, 0, i * 20 + 10, 0));
    const s = setup(rs);
    const lost = line(100, 0, 0, 10, 0, { origin: [NaN, 0] });
    const far = line(101, 0, 0, 10, 0, { origin: [Infinity, 0] });
    s.doc.apply({ k: 'add', recipes: [lost, far] });
    expect(s.scene.query(all, []).length).toBe(30);
    expect(s.scene.boxOf(lost.id)).toBeNull();
    expect(s.scene.boxOf(rs[0].id)).not.toBeNull();
    expect(s.scene.hit([5, 0], 1)).toBe(rs[0].id);
    expect(s.scene.lasso(Float64Array.of(-1e9, -1e9, 1e9, -1e9, 1e9, 1e9, -1e9, 1e9))).toHaveLength(30);
    expect(s.scene.lineage(5, 0, 'moss', 1, 1e4)).toBe(rs[0].id);
    expect(s.scene.contentBox()).toEqual({ x0: -91, y0: -91, x1: 29 * 20 + 10 + 91, y1: 91 });
    await s.cookNow([lost.id, far.id, rs[0].id]);
    s.doc.apply({ k: 'remove', ids: [lost.id, far.id] });
    expect(s.scene.query(all, []).length).toBe(30);
  });

  it('sweep collects every stroke the eraser segment touches', async () => {
    const a = line(1, 0, 0, 100, 0, { form: 'sprout' });
    const b = line(2, 0, 30, 100, 30);
    const c = line(3, 0, 300, 100, 300);
    const s = setup([a, b, c], { extras });
    const out = new Set<StrokeId>();
    s.scene.sweep([50, -20], [50, 40], 1, out);
    expect([...out].sort()).toEqual([a.id, b.id]);
    out.clear();
    s.scene.sweep([0, 15], [100, 15], 4, out);           // between a and b: misses both capsules
    expect(out.size).toBe(0);
    await s.cookNow([a.id]);
    s.scene.sweep([45, -30], [55, -30], 0, out);         // crosses a's strong branch only
    expect([...out]).toEqual([a.id]);
    out.clear();
    s.scene.sweep([75, 30], [85, 30], 0, out);           // faint branch: not erasable by its own alpha
    expect([...out]).toEqual([b.id]);
    s.scene.sweep([NaN, 0], [1, 1], 1, out);
    expect(out.size).toBe(1);
  });

  it('lasso selects strokes with at least half their stations inside, z-ordered', () => {
    const a = line(1, 0, 0, 100, 0);       // 21 stations at x = 0, 5, …, 100
    const b = line(2, 0, 20, 100, 20);
    const s = setup([b, a]);
    const rect = (x0: number, y0: number, x1: number, y1: number) => Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1);
    expect(s.scene.lasso(rect(-5, -5, 52, 25))).toEqual([a.id, b.id]);   // 11/21 inside
    expect(s.scene.lasso(rect(-5, -5, 47, 25))).toEqual([]);             // 10/21 inside
    expect(s.scene.lasso(rect(-5, -5, 105, 5))).toEqual([a.id]);
    expect(s.scene.lasso(Float64Array.of(0, 0, 1, 1))).toEqual([]);
  });
});

describe('scene: lineage', () => {
  const now0 = 10_000;
  it('proximity: starts within max(6 sp, 3w) of a same-ink spine; nearest wins', () => {
    const a = line(1, 0, 0, 100, 0, { ink: 'moss', created: 0 });
    const b = line(2, 0, 10, 100, 10, { ink: 'moss', created: 0 });
    const c = line(3, 0, 5, 100, 5, { ink: 'indigo', created: 0 });
    const s = setup([a, b, c]);
    expect(s.scene.lineage(102, 3, 'moss', 0.5, now0)).toBe(a.id);    // 3.6 from a's end ≤ 6
    expect(s.scene.lineage(50, 7, 'moss', 0.5, now0)).toBe(b.id);     // 3 from b, 7 from a
    expect(s.scene.lineage(50, 5.5, 'indigo', 0.5, now0)).toBe(c.id);
    expect(s.scene.lineage(150, 0, 'moss', 0.5, now0)).toBeNull();    // 50 away
    expect(s.scene.lineage(150, 0, 'moss', 17, now0)).toBe(a.id);     // 3w = 51 ≥ 50
    expect(s.scene.lineage(50, 5, 'rose', 1, now0)).toBeNull();
  });

  it('proximity ties go to the topmost stroke; the custom ink matches custom', () => {
    const a = line(1, 0, -4, 100, -4, { created: 0 });
    const b = line(2, 0, 4, 100, 4, { created: 0 });                    // equidistant from y = 0
    const c = line(3, 0, 50, 100, 50, { ink: 'custom', created: 0 });
    const s = setup([b, a, c]);
    expect(s.scene.lineage(50, 0, 'moss', 0.5, now0)).toBe(b.id);
    expect(s.scene.lineage(50, 52, 'custom', 0.5, now0)).toBe(c.id);
    expect(s.scene.lineage(50, 52, 'moss', 0.5, now0)).toBeNull();
    expect(s.scene.lineage(NaN, 0, 'moss', 0.5, now0)).toBeNull();
  });

  it('6 sp is measured at the candidate stroke\'s zoom', () => {
    const a = line(1, 0, 0, 100, 0, { z: 4, created: 0 });            // 6 sp = 1.5 doc
    const s = setup([a]);
    expect(s.scene.lineage(50, 1.4, 'moss', 0.1, now0)).toBe(a.id);
    expect(s.scene.lineage(50, 1.6, 'moss', 0.1, now0)).toBeNull();
  });

  it('recency: the last same-ink stroke lifted < 3 s ago within 48 sp', () => {
    // created at pen-down (Date.now ms), 21 samples 8 ms apart: lifted at created + 160
    const T = 1_759_600_000_000;
    const old = line(1, 0, 0, 100, 0, { created: T + 1000 });
    const last = line(2, 0, 100, 100, 100, { created: T + 5000 });
    const other = line(3, 0, 200, 100, 200, { ink: 'rose', created: T + 9000 });
    const s = setup([old, last, other]);
    const lift = T + 5160;
    expect(s.scene.lineage(50, 140, 'moss', 1, lift + 2999)).toBe(last.id);   // 40 sp from its spine
    expect(s.scene.lineage(50, 140, 'moss', 1, lift + 3001)).toBeNull();      // too late
    expect(s.scene.lineage(50, 150, 'moss', 1, lift + 1000)).toBeNull();      // 50 sp: too far
    expect(s.scene.lineage(50, 40, 'moss', 1, lift + 1000)).toBeNull();       // near `old`, but it is not the last
    expect(s.scene.lineage(50, 140, 'moss', 1, lift - 1500)).toBe(last.id);   // created stamped at lift: tolerated
    expect(s.scene.lineage(50, 140, 'moss', 1, 123_456.7)).toBeNull();        // performance.now clock never matches
  });
});

describe('scene: lifecycle', () => {
  it('dispose unsubscribes and cancels pending cooks', async () => {
    const a = line(1, 0, 0, 10, 0);
    const s = setup([a]);
    expect(s.doc.subscribers).toBe(1);
    const p = s.scene.ensure([a.id], 'visible');
    s.scene.dispose();
    expect(s.doc.subscribers).toBe(0);
    expect(s.jobs.pending).toBe(0); // queued cook and occupancy warm job both gone
    s.drain();
    await p;
    expect(s.cooks).toEqual([]);
    s.doc.apply({ k: 'add', recipes: [line(2, 0, 0, 1, 1)] });
    expect(s.scene.query(all, [])).toEqual([]);
  });

  it("warms the occupancy blocks around the camera in a background job", () => {
    const a = line(1, 0, 0, 100, 0), b = line(2, 0, 30, 100, 30);
    const s = setup([a, b]);
    const occ = s.scene.occupancy;
    expect(occ.isBuilt(0, 0, 1)).toBe(false);
    expect(s.jobs.pending).toBe(1);
    s.drain();
    expect(occ.isBuilt(0, 0, 1)).toBe(true);
    expect(occ.isBuilt(900, -900, 1)).toBe(true);   // within 1024 sp of the view centre
    // zooming to a new level warms there too; an already built centre costs nothing
    s.doc.setView({ camera: { cx: 0, cy: 0, scale: 4, rot: 0 } });
    expect(occ.isBuilt(0, 0, 4)).toBe(false);
    expect(s.jobs.pending).toBe(1);
    const c = line(3, 0, 60, 100, 60);
    s.doc.apply({ k: 'add', recipes: [c] });          // replaces the pending warm job, never duplicates it
    expect(s.jobs.pending).toBe(1);
    s.drain();
    expect(occ.isBuilt(0, 0, 4)).toBe(true);
    s.doc.setView({ camera: { cx: 9, cy: 0, scale: 4.2, rot: 0 } });
    expect(s.jobs.pending).toBe(0);
    // crowding read at pen-down is identical whether or not the warm job ran first
    const cold = setup([a, b, c]);
    expect(cold.scene.crowding(50, 15, 1)).toBe(s.scene.crowding(50, 15, 1));
    expect(cold.scene.crowding(50, 15, 1)).toBeGreaterThan(0);
    // an empty document schedules nothing
    expect(setup().jobs.pending).toBe(0);
  });

  it('random command soak keeps index, occupancy and cache coherent with the doc', async () => {
    const rnd = mulberry(4242);
    const s = setup([], { cacheBytes: 40_000 });
    const live = new Map<StrokeId, StrokeRecipe>();
    let n = 0;
    for (let step = 0; step < 400; step++) {
      const k = rnd();
      const ids = [...live.keys()];
      if (k < 0.4 || ids.length === 0) {
        const x = (rnd() - 0.5) * 2000, y = (rnd() - 0.5) * 2000;
        const r = line(++n, x, y, x + rnd() * 80, y + rnd() * 80, { size: 2 + rnd() * 20 });
        s.doc.apply({ k: 'add', recipes: [r] });
        live.set(r.id, r);
      } else if (k < 0.6) {
        const id = ids[Math.floor(rnd() * ids.length)];
        s.doc.apply({ k: 'remove', ids: [id] });
        live.delete(id);
      } else if (k < 0.8) {
        const before = live.get(ids[Math.floor(rnd() * ids.length)])!;
        const geom = rnd() < 0.5;
        const after = geom
          ? { ...before, origin: [before.origin[0] + 30, before.origin[1]] as const, geomRev: before.geomRev + 1 }
          : { ...before, color: { ...before.color, k: before.color.k + 1 }, colorRev: before.colorRev + 1 };
        s.doc.apply({ k: 'replace', before: [before], after: [after] });
        live.set(after.id, after);
      } else {
        const p = s.scene.ensure(ids.slice(0, 5), rnd() < 0.5 ? 'visible' : 'background');
        s.jobs.run(rnd() * 3);
        if (rnd() < 0.3) { s.drain(); await p; }
      }
    }
    s.drain();
    expect(s.scene.query(all, []).sort()).toEqual([...live.keys()].sort());
    expect(s.scene.occupancy.strokes).toBe(live.size);
    expect(s.scene.cachedBytes).toBeLessThanOrEqual(40_000);
    for (const [id, r] of live) {
      const c = s.scene.cooked(id);
      if (c) expect(c.inkBox.x0).toBeCloseTo(r.origin[0] + Math.min(r.samples[0], r.samples[20 * 9]) - 2, 4);
    }
    for (const r of live.values()) s.doc.apply({ k: 'remove', ids: [r.id] });
    expect(s.scene.occupancy.cells).toBe(0);
    expect(s.scene.contentBox()).toBeNull();
  });
});

describe('sameGeometry', () => {
  it('ignores colour and revs, compares every geometry input', () => {
    const a = line(1, 0, 0, 10, 0);
    expect(sameGeometry(a, { ...a, color: { ...a.color, ink: 'rose' }, colorRev: 4, geomRev: 9, created: 1 })).toBe(true);
    expect(sameGeometry(a, { ...a, samples: a.samples.slice() })).toBe(true);
    const s2 = a.samples.slice(); s2[5] = 0.123;
    expect(sameGeometry(a, { ...a, samples: s2 })).toBe(false);
    expect(sameGeometry(a, { ...a, seed: 7 })).toBe(false);
    expect(sameGeometry(a, { ...a, form: { ...a.form, base: 2 } })).toBe(false);
    expect(sameGeometry(a, { ...a, pools: Float32Array.of(1, 1, 0, 0) })).toBe(false);
    expect(sameGeometry(a, { ...a, calib: { ...a.calib, gamma: 1.2 } })).toBe(false);
    expect(sameGeometry(a, { ...a, calib: { ...a.calib } })).toBe(true);
    expect(sameGeometry(a, { ...a, closed: true })).toBe(false);
    expect(sameGeometry(a, { ...a, xf: Float64Array.of(1, 0, 0, 1, 0, 0) })).toBe(false);
    expect(sameGeometry(a, { ...a, sym: { axis: 'v', at: 3 } })).toBe(false);
  });
});
