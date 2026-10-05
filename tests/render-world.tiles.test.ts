import { describe, it, expect } from 'vitest';
import { TileCache, TILE_PX, densityOf, levelFor, pushRect, tileDocSize, unionRects, type Rect } from '../src/render/tiles';
import type { AABB, Camera } from '../src/core/types';
import { FakeCanvas, FakeCtx, FakeWorld, NC, forCells, isect, rng, stampDraw } from './render-world.helpers';

const cam = (cx: number, cy: number, scale: number): Camera => ({ cx, cy, scale, rot: 0 });

function drain(tc: TileCache, max = 100000): number {
  let n = 0;
  tc.ensureVisible();
  let tick = 0;
  while (tc.pending > 0 && n < max) {
    tc.ensureVisible();
    tc.run(1e9, () => tick++);
    n++;
  }
  return n;
}

/**
 * Exactness: every ready tile holds each eligible stroke exactly once, ineligible ones never.
 * With `idleOnly`, only tiles without pending work are checked, strokes whose geometry was ever
 * evicted are ignored, and a stroke the tile reports as skipped may be missing.
 */
function checkExact(tc: TileCache, w: FakeWorld, idleOnly = false, evicted: Set<string> | null = null): string[] {
  const bad: string[] = [];
  for (const t of tc.tiles.values()) {
    if (!t.ready || t.failed) continue;
    if (idleOnly && (t.job || t.adds.size || t.rects.length || t.needFull)) continue;
    const ctx = t.canvas ? (t.canvas as unknown as FakeCanvas).ctx : null;
    for (const s of w.strokes.values()) {
      if (idleOnly && (evicted?.has(s.id) || (t.skipped && t.skipped.has(s.id)) || (w.eligible(s.id) && !s.cooked))) continue;
      const foot: Rect = { x0: (s.box.x0 - t.x0) * t.dens, y0: (s.box.y0 - t.y0) * t.dens, x1: (s.box.x1 - t.x0) * t.dens, y1: (s.box.y1 - t.y0) * t.dens };
      const r = isect(foot, { x0: 0, y0: 0, x1: TILE_PX, y1: TILE_PX })!;
      const want = w.eligible(s.id) && s.cooked ? 1 : 0;
      const arr = ctx ? ctx.counts.get(s.id) : undefined;
      let wrong = 0;
      forCells(r, i => { const got = arr ? arr[i] : 0; if (got !== want) wrong++; });
      if (arr) {
        // nothing outside the footprint either
        const inside = new Uint8Array(NC * NC);
        forCells(r, i => { inside[i] = 1; });
        for (let i = 0; i < arr.length; i++) if (!inside[i] && arr[i] !== 0) wrong++;
      }
      if (wrong) bad.push(`${t.key} ${s.id} want ${want} wrong cells ${wrong}`);
    }
  }
  return bad;
}

describe('tile levels', () => {
  it('half-octave levels: ceil(2·log2(scale·dpr)), oversampling within [1, √2)', () => {
    expect(levelFor(1, 1)).toBe(0);
    expect(levelFor(1, 2)).toBe(2);
    expect(levelFor(0.5, 1)).toBe(-2);
    expect(levelFor(1.5, 1)).toBe(2);
    expect(levelFor(Math.SQRT2, 1)).toBe(1);
    expect(densityOf(1)).toBeCloseTo(Math.SQRT2, 15);
    expect(densityOf(-3)).toBeCloseTo(Math.pow(2, -1.5), 15);
    expect(tileDocSize(0)).toBe(512);
    expect(tileDocSize(2)).toBe(256);
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const s = 0.05 * Math.pow(640, r()), d = [1, 1.25, 1.5, 2, 2.625, 3][Math.floor(r() * 6)];
      const k = s * d, dens = densityOf(levelFor(s, d));
      expect(dens / k).toBeGreaterThanOrEqual(1 - 1e-12);
      expect(dens / k).toBeLessThan(Math.SQRT2 + 1e-12);
    }
  });

  it('degenerate scales fall back to level 0', () => {
    expect(levelFor(0, 1)).toBe(0);
    expect(levelFor(NaN, 1)).toBe(0);
    expect(levelFor(Infinity, 1)).toBe(0);
  });
});

describe('dirty rects', () => {
  it('merges overlapping rects and collapses past the cap', () => {
    const l: Rect[] = [];
    pushRect(l, { x0: 0, y0: 0, x1: 10, y1: 10 });
    pushRect(l, { x0: 5, y0: 5, x1: 20, y1: 20 });
    expect(l).toEqual([{ x0: 0, y0: 0, x1: 20, y1: 20 }]);
    pushRect(l, { x0: 100, y0: 100, x1: 110, y1: 110 });
    expect(l.length).toBe(2);
    for (let i = 0; i < 12; i++) pushRect(l, { x0: 200 + i * 20, y0: 0, x1: 205 + i * 20, y1: 5 });
    expect(l.length).toBeLessThanOrEqual(8);
    const u = unionRects(l);
    expect(u.x0).toBe(0); expect(u.x1).toBe(425);
  });

  it('a merge that bridges two rects chains into one', () => {
    const l: Rect[] = [];
    pushRect(l, { x0: 0, y0: 0, x1: 10, y1: 10 });
    pushRect(l, { x0: 30, y0: 0, x1: 40, y1: 10 });
    pushRect(l, { x0: 5, y0: 0, x1: 35, y1: 10 });
    expect(l).toEqual([{ x0: 0, y0: 0, x1: 40, y1: 10 }]);
  });
});

function setup(seed = 1): { w: FakeWorld; tc: TileCache } {
  const w = new FakeWorld();
  const tc = new TileCache(w, 'night', 1e12, stampDraw);
  tc.setView({ cam: cam(256, 256, 1), cssW: 1400, cssH: 900, dpr: 1 });
  void seed;
  return { w, tc };
}

function addStroke(w: FakeWorld, tc: TileCache, id: string, box: AABB, cooked = true): void {
  w.strokes.set(id, { id, box, cooked, inDoc: true, held: false });
  tc.add(id, box, null);
}

describe('tile cache basics', () => {
  it('renders the visible grid, empty tiles hold no canvas', () => {
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 100, y0: 100, x1: 300, y1: 140 });
    drain(tc);
    expect(tc.visibleComplete()).toBe(true);
    // 3×3 visible cells, only the one under the stroke allocates
    const withCanvas = [...tc.tiles.values()].filter(t => t.canvas);
    expect(withCanvas.map(t => t.key)).toEqual(['0:0:0']);
    expect(checkExact(tc, w)).toEqual([]);
  });

  it('a stroke straddling tiles lands in each exactly once', () => {
    const { w, tc } = setup();
    drain(tc);
    addStroke(w, tc, 'x', { x0: 400, y0: 400, x1: 700, y1: 650 });
    drain(tc);
    const keys = [...tc.tiles.values()].filter(t => t.canvas).map(t => t.key).sort();
    expect(keys).toEqual(['0:0:0', '0:0:1', '0:1:0', '0:1:1']);
    expect(checkExact(tc, w)).toEqual([]);
  });

  it('removal re-renders only the dirty sub-rect, other strokes stay', () => {
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 50, y0: 50, x1: 450, y1: 100 });
    addStroke(w, tc, 'b', { x0: 60, y0: 80, x1: 200, y1: 300 });
    drain(tc);
    const ctx = (tc.tiles.get('0:0:0')!.canvas as unknown as FakeCanvas).ctx;
    ctx.clears.length = 0;
    w.strokes.get('b')!.inDoc = false;
    tc.invalidate(w.strokes.get('b')!.box);
    drain(tc);
    expect(checkExact(tc, w)).toEqual([]);
    // the clear was limited to b's box (+ AA pad), not the whole tile
    expect(ctx.clears.length).toBe(1);
    expect(ctx.clears[0]).toEqual({ x0: 58, y0: 78, x1: 202, y1: 302 });
  });

  it('readyFor waits for visible work; busy() during an in-place render', () => {
    const { w, tc } = setup();
    for (let i = 0; i < 10; i++) addStroke(w, tc, 's' + i, { x0: 20 + i * 30, y0: 20, x1: 60 + i * 30, y1: 400 });
    drain(tc);
    const box = { x0: 0, y0: 0, x1: 500, y1: 500 };
    expect(tc.readyFor(box)).toBe(true);
    w.strokes.get('s3')!.inDoc = false;
    tc.invalidate(w.strokes.get('s3')!.box);
    expect(tc.readyFor(box)).toBe(false);
    let tick = 0;
    tc.run(2, () => tick++);  // start the rect render, draw a stroke or two
    expect(tc.busy()).toBe(true);
    tc.flushDisplayed();
    expect(tc.busy()).toBe(false);
    expect(tc.readyFor(box)).toBe(true);
    expect(checkExact(tc, w)).toEqual([]);
  });

  it('missing tiles are not created during a gesture (settled = false)', () => {
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 100, y0: 100, x1: 300, y1: 140 });
    tc.settled = false;
    tc.ensureVisible();
    expect(tc.tiles.size).toBe(0);
    expect(tc.readyFor({ x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(true);
    tc.settled = true;
    expect(tc.readyFor({ x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(false);
    drain(tc);
    expect(tc.readyFor({ x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(true);
  });

  it('allocation failure counts as an empty, complete tile', () => {
    const { w, tc } = setup();
    w.failAlloc = true;
    addStroke(w, tc, 'a', { x0: 100, y0: 100, x1: 300, y1: 140 });
    drain(tc);
    expect(tc.visibleComplete()).toBe(true);
    expect(tc.readyFor({ x0: 0, y0: 0, x1: 500, y1: 500 })).toBe(true);
  });

  it('uncooked strokes are skipped, reported, and added once they cook', () => {
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 100, y0: 100, x1: 300, y1: 140 }, false);
    addStroke(w, tc, 'b', { x0: 100, y0: 200, x1: 300, y1: 240 }, true);
    drain(tc);
    const out: string[] = [];
    expect(tc.takeSkipped(out)).toEqual(['a']);
    expect(tc.completeCells(() => undefined).done).toBe(8);  // the tile with 'a' missing is not complete
    w.strokes.get('a')!.cooked = true;
    tc.cooked('a', null);
    drain(tc);
    expect(checkExact(tc, w)).toEqual([]);
    expect(tc.completeCells(() => undefined).done).toBe(9);
  });

  it('a dirty render that skips an evicted stroke re-renders only that rect when it cooks', () => {
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 50, y0: 50, x1: 450, y1: 100 });
    addStroke(w, tc, 'b', { x0: 100, y0: 60, x1: 140, y1: 300 });
    drain(tc);
    // 'a' loses its geometry (LRU), then 'b' is removed: the dirty rect skips 'a' inside it
    w.strokes.get('a')!.cooked = false;
    w.strokes.get('b')!.inDoc = false;
    tc.invalidate(w.strokes.get('b')!.box);
    drain(tc);
    w.strokes.get('a')!.cooked = true;
    tc.cooked('a', null);
    drain(tc);
    expect(checkExact(tc, w)).toEqual([]);
  });
});

describe('displayed other-level tiles (fallback during gestures)', () => {
  /** Level-0 tiles complete, then a zoom gesture to level 2 with nothing cached there yet. */
  function zoomed(): { w: FakeWorld; tc: TileCache } {
    const { w, tc } = setup();
    for (let i = 0; i < 8; i++) addStroke(w, tc, 'z' + i, { x0: 150 + i * 12, y0: 150, x1: 190 + i * 12, y1: 420 });
    drain(tc);
    tc.settled = false;
    tc.setView({ cam: cam(256, 256, 2), cssW: 1400, cssH: 900, dpr: 1 });
    tc.ensureVisible();
    expect(tc.level).toBe(2);
    expect([...tc.tiles.values()].every(t => t.level === 0)).toBe(true);
    return { w, tc };
  }

  it('readyFor waits for a pending add on the tile standing in for a missing cell', () => {
    // regression: missing cells counted as ready during a gesture, so a bake committed (and the
    // live layer dropped the stroke) while the fallback tile showing that area lacked it
    const { w, tc } = zoomed();
    addStroke(w, tc, 'new', { x0: 200, y0: 200, x1: 300, y1: 260 });
    const box = w.strokes.get('new')!.box;
    expect(tc.readyFor(box)).toBe(false);
    let tick = 0;
    while (tc.pending > 0) tc.run(1, () => tick++);
    expect(tc.readyFor(box)).toBe(true);
    expect(checkExact(tc, w)).toEqual([]);
  });

  it('a forced composite flushes dirty rects of displayed fallback tiles too', () => {
    const { w, tc } = zoomed();
    const s = w.strokes.get('z3')!;
    s.inDoc = false;
    tc.invalidate(s.box);
    expect(tc.readyFor(s.box)).toBe(false);
    tc.flushDisplayed(true);
    const t0 = tc.tiles.get('0:0:0')!;
    expect(t0.rects.length).toBe(0);
    expect(t0.job).toBeNull();
    expect(tc.readyFor(s.box)).toBe(true);
    expect(checkExact(tc, w)).toEqual([]);
  });

  it('busy() only counts in-place renders of tiles that are displayed', () => {
    const { w, tc } = zoomed();
    // complete the current level: level-0 tiles are now hidden under it
    tc.settled = true;
    drain(tc);
    expect(tc.visibleComplete()).toBe(true);
    const s = w.strokes.get('z1')!;
    s.inDoc = false;
    tc.invalidate(s.box);
    let tick = 0, guard = 0;
    const hidden = (): boolean => [...tc.tiles.values()].some(t => t.level === 0 && t.job !== null && t.job.inPlace);
    while (!hidden() && guard++ < 1000) tc.run(1, () => tick++);
    expect(hidden()).toBe(true);
    expect(tc.visibleComplete()).toBe(true);
    expect(tc.busy()).toBe(false);  // a hidden tile mid-render must not hold back the composite
    // zoom so that level 2 is missing again: the level-0 tile is displayed, and now it counts
    tc.settled = false;
    tc.setView({ cam: cam(256, 256, 4), cssW: 1400, cssH: 900, dpr: 1 });
    expect(tc.busy()).toBe(true);
  });
});

describe('forget()', () => {
  it('drops skipped records of a removed stroke so its cell can complete', () => {
    // regression: a stroke removed before it ever cooked stayed "skipped" in its tile forever,
    // so the cell never counted as complete and the cold-load snapshot was never uncovered there
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 100, y0: 100, x1: 300, y1: 140 }, false);
    drain(tc);
    expect(tc.completeCells(() => undefined).done).toBe(8);
    w.strokes.get('a')!.inDoc = false;
    tc.forget('a');
    expect(tc.completeCells(() => undefined).done).toBe(9);
    expect(tc.takeSkipped([])).toEqual([]);
  });
});

describe('tile cache: random operations stay exact', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    it(`seed ${seed}`, () => {
      const r = rng(seed * 7919);
      const w = new FakeWorld();
      const tc = new TileCache(w, seed % 2 ? 'night' : 'paper', 1e12, stampDraw);
      const views = [cam(256, 256, 1), cam(300, 200, 0.5), cam(256, 256, 2), cam(0, 0, 1.5), cam(700, 500, 1)];
      tc.setView({ cam: views[0], cssW: 1400, cssH: 900, dpr: 1 });
      let next = 0, tick = 0;
      const needCook = new Set<string>();
      const deferred: string[] = [];
      const evicted = new Set<string>();
      const pick = (f: (id: string) => boolean): string | null => {
        const ids = [...w.strokes.keys()].filter(f);
        return ids.length ? ids[Math.floor(r() * ids.length)] : null;
      };
      for (let op = 0; op < 400; op++) {
        const k = r();
        if (k < 0.22) {
          const x0 = -700 + r() * 1900, y0 = -500 + r() * 1500;
          const id = 's' + String(next++).padStart(4, '0');
          w.strokes.set(id, { id, box: { x0, y0, x1: x0 + 10 + r() * 500, y1: y0 + 10 + r() * 400 }, cooked: r() < 0.75, inDoc: true, held: false });
          tc.add(id, w.strokes.get(id)!.box, null);
        } else if (k < 0.3) {
          const id = pick(i => w.strokes.get(i)!.inDoc);
          if (id) { const s = w.strokes.get(id)!; const was = w.eligible(id); s.inDoc = false; if (was) tc.invalidate(s.box); tc.forget(id); }
        } else if (k < 0.36) {
          const id = pick(i => w.eligible(i));
          if (id) { const s = w.strokes.get(id)!; s.held = true; tc.invalidate(s.box); }
        } else if (k < 0.42) {
          const id = pick(i => w.strokes.get(i)!.held && w.strokes.get(i)!.inDoc);
          if (id) { const s = w.strokes.get(id)!; s.held = false; tc.add(id, s.box, null); }
        } else if (k < 0.5) {
          // the scene cooks a stroke; the renderer hears about it now or a little later
          const id = pick(i => !w.strokes.get(i)!.cooked);
          if (id) {
            w.strokes.get(id)!.cooked = true;
            if (r() < 0.5) { if (w.eligible(id)) tc.cooked(id, null); } else deferred.push(id);
          }
        } else if (k < 0.53) {
          const id = pick(i => w.strokes.get(i)!.cooked);
          if (id) { w.strokes.get(id)!.cooked = false; evicted.add(id); }  // geometry evicted: pixels stay
        } else if (k < 0.58) {
          const id = pick(i => w.eligible(i));
          if (id) tc.invalidate(w.strokes.get(id)!.box);
        } else if (k < 0.85) {
          tc.ensureVisible();
          tc.run(1 + Math.floor(r() * 12), () => tick++);
          for (const id of tc.takeSkipped([])) needCook.add(id);
          if (r() < 0.4) { for (const id of deferred.splice(0)) if (w.eligible(id)) tc.cooked(id, null); }
          const idle = checkExact(tc, w, true, evicted);
          if (idle.length) throw new Error('op ' + op + ': idle tile inexact: ' + idle.slice(0, 3).join('; '));
        } else if (k < 0.92) {
          tc.settled = r() < 0.7;
          tc.setView({ cam: views[Math.floor(r() * views.length)], cssW: 1400, cssH: 900, dpr: r() < 0.8 ? 1 : 2 });
        } else if (k < 0.96) {
          tc.flushDisplayed();
        } else {
          const withC = [...tc.tiles.values()].filter(t => t.canvas);
          if (withC.length) tc.markLost(withC[Math.floor(r() * withC.length)].canvas!);
        }
      }
      // let everything cook (the renderer's ensure() path), then drain
      tc.settled = true;
      for (const id of deferred.splice(0)) if (w.eligible(id)) tc.cooked(id, null);
      for (let round = 0; round < 3; round++) {
        drain(tc);
        for (const id of tc.takeSkipped([])) needCook.add(id);
        for (const id of needCook) {
          const s = w.strokes.get(id)!;
          if (!s.cooked) { s.cooked = true; }
          if (w.eligible(id)) tc.cooked(id, null);
        }
        needCook.clear();
      }
      for (const s of w.strokes.values()) if (!s.cooked) { s.cooked = true; if (w.eligible(s.id)) tc.cooked(s.id, null); }
      drain(tc);
      expect(checkExact(tc, w)).toEqual([]);
      expect(tc.visibleComplete()).toBe(true);
    });
  }
});

describe('compositing', () => {
  it('blits the visible grid on integer, seamless rects that cover the viewport', () => {
    const { w, tc } = setup();
    for (let i = 0; i < 9; i++) addStroke(w, tc, 'g' + i, { x0: -300 + (i % 3) * 512, y0: -200 + Math.floor(i / 3) * 512, x1: -100 + (i % 3) * 512, y1: 0 + Math.floor(i / 3) * 512 });
    drain(tc);
    const base = new FakeCanvas(1400, 900);
    tc.drawInto(base.ctx as unknown as CanvasRenderingContext2D);
    const bl = base.ctx.blits;
    expect(bl.length).toBe(9);
    for (const b of bl) {
      expect(Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.w) && Number.isInteger(b.h)).toBe(true);
      expect(b.w).toBe(512); expect(b.h).toBe(512);
    }
    const xs = [...new Set(bl.map(b => b.x))].sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBe(512);
    expect(xs[0]).toBeLessThanOrEqual(0);
    expect(xs[2] + 512).toBeGreaterThanOrEqual(1400);
  });

  it('non-native scales round edges on the shared grid (no gaps, no overlaps)', () => {
    const { w, tc } = setup();
    tc.setView({ cam: { cx: 13.37, cy: -7.1, scale: 0.83, rot: 0 }, cssW: 1003, cssH: 707, dpr: 1.25 });
    for (let i = 0; i < 16; i++) addStroke(w, tc, 'n' + i, { x0: -700 + (i % 4) * 400, y0: -500 + Math.floor(i / 4) * 300, x1: -600 + (i % 4) * 400, y1: -400 + Math.floor(i / 4) * 300 });
    drain(tc);
    const base = new FakeCanvas(1254, 884);
    tc.drawInto(base.ctx as unknown as CanvasRenderingContext2D);
    const bl = base.ctx.blits;
    const cols = new Map<number, number>();
    for (const b of bl) cols.set(b.x, b.x + b.w);
    const starts = [...cols.keys()].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBe(cols.get(starts[i - 1]));
  });

  it('other levels stand in for missing tiles, then the current level replaces them', () => {
    const { w, tc } = setup();
    addStroke(w, tc, 'a', { x0: 100, y0: 100, x1: 300, y1: 140 });
    drain(tc);
    // zoom in: level 2, no tiles yet, not settled -> level-0 tiles stand in
    tc.settled = false;
    tc.setView({ cam: cam(256, 256, 2), cssW: 1400, cssH: 900, dpr: 1 });
    tc.ensureVisible();
    const base = new FakeCanvas(1400, 900);
    tc.drawInto(base.ctx as unknown as CanvasRenderingContext2D);
    expect(base.ctx.blits.length).toBe(1);
    expect(base.ctx.blits[0].w).toBe(1024);  // the level-0 tile, scaled ×2
    tc.settled = true;
    drain(tc);
    base.ctx.blits.length = 0;
    tc.drawInto(base.ctx as unknown as CanvasRenderingContext2D);
    expect(base.ctx.blits.every(b => b.w === 512)).toBe(true);
    expect(checkExact(tc, w)).toEqual([]);
  });

  it('evicts least-recently-used tiles outside the view under the soft cap', () => {
    const w = new FakeWorld();
    const tc = new TileCache(w, 'night', 12 * TILE_PX * TILE_PX * 4, stampDraw);
    tc.setView({ cam: cam(256, 256, 1), cssW: 1400, cssH: 900, dpr: 1 });
    for (let i = 0; i < 40; i++) addStroke(w, tc, 'e' + i, { x0: -3000 + i * 150, y0: -100, x1: -2900 + i * 150, y1: 600 });
    drain(tc);
    for (const cx of [-2500, -1500, -500, 500, 1500]) {
      tc.setView({ cam: cam(cx, 256, 1), cssW: 1400, cssH: 900, dpr: 1 });
      drain(tc);
    }
    expect(tc.bytes).toBeLessThanOrEqual(12 * TILE_PX * TILE_PX * 4);
    expect(tc.visibleComplete()).toBe(true);
    expect(w.allocs - w.frees).toBe(tc.count);
    expect(checkExact(tc, w)).toEqual([]);
  });
});

describe('fake context sanity', () => {
  it('clips and clears model a canvas', () => {
    const c = new FakeCanvas();
    const ctx = c.ctx;
    ctx.stamp('a', { x0: 0, y0: 0, x1: 64, y1: 64 }, { x0: 0, y0: 0, x1: 512, y1: 512 });
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 32, 64); ctx.clip();
    ctx.clearRect(0, 0, 512, 512);
    ctx.restore();
    let n = 0;
    forCells({ x0: 0, y0: 0, x1: 64, y1: 64 }, i => { n += ctx.counts.get('a')![i]; });
    expect(n).toBe(32);  // 8×8 cells, left half cleared
    expect(FakeCtx).toBeDefined();
  });
});
