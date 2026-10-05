import { describe, it, expect } from 'vitest';
import { createOccupancy, levelFor, sameFootprint } from '../src/scene/occupancy';
import { smoothstep } from '../src/core/num';
import { linePts, makeRecipe, mulberry } from './scene-sched.helpers';
import { S } from '../src/core/types';
import type { StrokeRecipe } from '../src/core/types';

function randomStroke(rnd: () => number, i: number): StrokeRecipe {
  const n = 2 + Math.floor(rnd() * 40);
  const pts: [number, number][] = [];
  let x = (rnd() - 0.5) * 400, y = (rnd() - 0.5) * 400, a = rnd() * 6.28;
  for (let k = 0; k < n; k++) {
    pts.push([x, y]);
    a += (rnd() - 0.5) * 0.8;
    const step = 0.3 + rnd() * 6;
    x += Math.cos(a) * step; y += Math.sin(a) * step;
  }
  const zs = [0.25, 0.5, 1, 1, 1, 2, 4];
  return makeRecipe({
    n: i, pts,
    origin: [(rnd() - 0.5) * 1e5, (rnd() - 0.5) * 1e5].map(v => Math.round(v)) as [number, number],
    z: zs[Math.floor(rnd() * zs.length)],
    size: 1 + rnd() * 30,
  });
}

/** Many probe points around a set of strokes (absolute doc). */
function probes(strokes: StrokeRecipe[], rnd: () => number, per = 4): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const r of strokes) {
    for (let k = 0; k < per; k++) {
      out.push([r.origin[0] + r.samples[0] + (rnd() - 0.5) * 60, r.origin[1] + r.samples[1] + (rnd() - 0.5) * 60, r.z]);
    }
  }
  return out;
}

describe('occupancy levels', () => {
  it('picks the level whose cell is nearest to 8 sp', () => {
    expect(levelFor(1)).toBe(3);        // 8 doc
    expect(levelFor(2)).toBe(2);        // 4 doc
    expect(levelFor(0.5)).toBe(4);
    expect(levelFor(32)).toBe(-2);      // 0.25 doc
    expect(levelFor(0.05)).toBe(7);     // 160 doc -> 128
    // geometric rounding at the √2 midpoint: 8/z = 8·√2 rounds up, slightly less rounds down
    expect(levelFor(1 / Math.SQRT2)).toBe(4);
    expect(levelFor(1 / 1.41)).toBe(3);
    expect(levelFor(0)).toBe(3);
    expect(levelFor(NaN)).toBe(3);
  });
});

describe('occupancy add/remove', () => {
  it('returns exactly to zero after adding and removing in any order', () => {
    const rnd = mulberry(1234);
    const occ = createOccupancy();
    const strokes = Array.from({ length: 120 }, (_, i) => randomStroke(rnd, i));
    for (const r of strokes) occ.add(r);
    expect(occ.strokes).toBe(120);
    expect(occ.cells).toBe(0);                 // levels materialise on first read
    const pts = probes(strokes, rnd);
    const before = pts.map(([x, y, z]) => occ.crowding(x, y, z));
    expect(before.some(c => c > 0)).toBe(true);
    expect(occ.cells).toBeGreaterThan(500);
    expect(occ.blocks).toBeGreaterThan(100);
    const order = strokes.slice().sort(() => rnd() - 0.5);
    for (const r of order) occ.remove(r);
    expect(occ.cells).toBe(0);
    expect(occ.strokes).toBe(0);
    for (const [x, y, z] of pts) {
      expect(occ.crowding(x, y, z)).toBe(0);
      expect(occ.side(x, y, 0, 1, z)).toBe(0);
    }
  });

  it('values do not depend on insertion order (bitwise)', () => {
    const rnd = mulberry(77);
    const strokes = Array.from({ length: 60 }, (_, i) => {
      const r = randomStroke(rnd, i);
      return makeRecipe({ n: i, pts: Array.from({ length: r.samples.length / 9 }, (_, k) => [r.samples[k * 9], r.samples[k * 9 + 1]] as [number, number]), z: 1, size: r.stroke.size });
    });
    const a = createOccupancy(), b = createOccupancy();
    for (const r of strokes) a.add(r);
    for (const r of strokes.slice().reverse()) b.add(r);
    // churn b: remove and re-add a third of them
    for (let i = 0; i < strokes.length; i += 3) b.remove(strokes[i]);
    for (let i = 0; i < strokes.length; i += 3) b.add(strokes[i]);
    for (let k = 0; k < 400; k++) {
      const x = (rnd() - 0.5) * 500, y = (rnd() - 0.5) * 500;
      expect(b.coverage(x, y, 48, 1)).toBe(a.coverage(x, y, 48, 1));
      expect(b.side(x, y, 0.6, 0.8, 1)).toBe(a.side(x, y, 0.6, 0.8, 1));
    }
  });

  it('add and remove are idempotent per recipe object; clear empties', () => {
    const occ = createOccupancy();
    const r = makeRecipe({ pts: linePts(0, 0, 100, 0) });
    occ.add(r); occ.add(r);
    const once = occ.coverage(50, 0, 48, 1);
    const ref = createOccupancy(); ref.add(r);
    expect(once).toBe(ref.coverage(50, 0, 48, 1));
    occ.remove(r); occ.remove(r);
    expect(occ.cells).toBe(0);
    occ.add(r);
    occ.clear();
    expect(occ.cells).toBe(0);
    expect(occ.crowding(50, 0, 1)).toBe(0);
  });

  it('replace keeps the grid when the footprint is unchanged and moves it otherwise', () => {
    const occ = createOccupancy();
    const r = makeRecipe({ pts: linePts(0, 0, 100, 0), size: 9 });
    occ.add(r);
    const cov = occ.coverage(50, 0, 48, 1), cells = occ.cells;
    const recolored = { ...r, color: { ...r.color, ink: 'rose' as const }, colorRev: 1 };
    expect(sameFootprint(r, recolored)).toBe(true);
    occ.replace(r, recolored);
    expect(occ.cells).toBe(cells);
    expect(occ.coverage(50, 0, 48, 1)).toBe(cov);
    const bigger = { ...recolored, stroke: { ...r.stroke, size: 30 }, geomRev: 1 };
    expect(sameFootprint(recolored, bigger)).toBe(false);
    occ.replace(recolored, bigger);
    expect(occ.coverage(50, 0, 48, 1)).toBeGreaterThan(cov * 3);
    occ.remove(bigger);
    expect(occ.cells).toBe(0);
  });
});

describe('crowding values', () => {
  it('a straight stroke through the disc gives cov ≈ w·2R / πR²', () => {
    const occ = createOccupancy();
    // long horizontal brush stroke (S = 9 → w = 6.3 doc at z = 1), dense samples
    occ.add(makeRecipe({ pts: linePts(-300, 0, 300, 0, 400), size: 9, z: 1 }));
    const want = (6.3 * 96) / (Math.PI * 48 * 48);
    for (const x of [-37, 0, 13.3, 71]) {
      const cov = occ.coverage(x, 0.7, 48, 1);
      expect(cov).toBeGreaterThan(want * 0.85);
      expect(cov).toBeLessThan(want * 1.15);
      expect(occ.crowding(x, 0.7, 1)).toBeCloseTo(smoothstep(0.02, 0.35, cov), 12);
    }
    // well clear of the stroke: nothing
    expect(occ.crowding(0, 60, 1)).toBe(0);
    expect(occ.crowding(500, 0, 1)).toBe(0);
  });

  it('zoom scales the radius: the same stroke at z = 2 covers the same sp fraction', () => {
    const a = createOccupancy(), b = createOccupancy();
    a.add(makeRecipe({ pts: linePts(-300, 0, 300, 0, 400), size: 9, z: 1 }));
    b.add(makeRecipe({ pts: linePts(-150, 0, 150, 0, 400), size: 9, z: 2 }));
    const ca = a.crowding(5, 0.5, 1), cb = b.crowding(2.5, 0.25, 2);
    expect(cb).toBeGreaterThan(0);
    expect(Math.abs(ca - cb)).toBeLessThan(0.02);
  });

  it('dense hatching saturates c at 1; it is smooth as the probe moves', () => {
    const occ = createOccupancy();
    for (let k = -20; k <= 20; k++) occ.add(makeRecipe({ n: 100 + k, pts: linePts(-200, k * 6, 200, k * 6, 120), size: 9 }));
    expect(occ.crowding(0, 0, 1)).toBe(1);
    // walk out of the hatched block (it ends at y = 120): c falls monotonically and
    // continuously. The analytic slope peaks near 0.05 per doc, so a step of 0.25 doc
    // must stay well under 0.03: no jumps at cell boundaries.
    let prev = occ.crowding(0, 121, 1);
    let maxStep = 0;
    for (let y = 121.25; y < 240; y += 0.25) {
      const c = occ.crowding(0, y, 1);
      maxStep = Math.max(maxStep, Math.abs(c - prev));
      expect(c).toBeLessThanOrEqual(prev + 1e-12);
      prev = c;
    }
    expect(maxStep).toBeLessThan(0.03);
    expect(prev).toBe(0);
  });

  it('a tap (one sample) still registers through its end caps', () => {
    const occ = createOccupancy();
    occ.add(makeRecipe({ pts: [[0, 0]], size: 20 }));
    const cov = occ.coverage(0, 0, 16, 1);
    expect(occ.cells).toBeGreaterThan(0);
    const want = (Math.PI * 14 * 14 / 4) / (Math.PI * 16 * 16); // disc of diameter w = 14 in a 16 disc
    expect(cov).toBeGreaterThan(want * 0.6);
    expect(cov).toBeLessThan(want * 1.4);
  });

  it('side crowding points away from neighbouring ink', () => {
    const occ = createOccupancy();
    // a heavy neighbour 24 doc above the probe (y-down: "above" = −y)
    for (let k = 0; k < 4; k++) occ.add(makeRecipe({ n: k, pts: linePts(-100, -24 + k * 2 - 3, 100, -24 + k * 2 - 3, 80), size: 9 }));
    const up = occ.side(0, 0, 0, -1, 1);
    const down = occ.side(0, 0, 0, 1, 1);
    expect(up).toBeGreaterThan(0.3);
    expect(down).toBeCloseTo(-up, 12);
    expect(occ.side(0, 0, 1, 0, 1)).toBeCloseTo(0, 6); // along the ink: balanced
    // the normal need not be unit length
    expect(occ.side(0, 0, 0, -5, 1)).toBeCloseTo(up, 12);
    expect(occ.side(0, 0, 0, 0, 1)).toBe(0);
    // symmetric neighbours cancel
    const sym = createOccupancy();
    sym.add(makeRecipe({ n: 1, pts: linePts(-100, -24, 100, -24, 80) }));
    sym.add(makeRecipe({ n: 2, pts: linePts(-100, 24, 100, 24, 80) }));
    expect(Math.abs(sym.side(0, 0, 0, 1, 1))).toBeLessThan(0.02);
    expect(Math.abs(sym.side(0, 0, 0, 1, 1))).toBeLessThan(sym.crowding(0, 24, 1));
  });

  it('ink more than two octaves of zoom away is not nearby', () => {
    const occ = createOccupancy();
    occ.add(makeRecipe({ pts: linePts(-300, 0, 300, 0, 400), size: 9, z: 1 })); // level 3, splats 1..5
    expect(occ.crowding(0, 0, 1)).toBeGreaterThan(0);
    expect(occ.coverage(0, 0, 48, 0.25)).toBeGreaterThan(0);   // level 5: seen
    expect(occ.coverage(0, 0, 48, 4)).toBeGreaterThan(0);      // level 1: seen
    expect(occ.coverage(0, 0, 48, 0.125)).toBe(0);             // level 6: not seen
    expect(occ.coverage(0, 0, 48, 8)).toBe(0);                 // level 0: not seen
  });

  it('far-from-origin ink keeps exact cancellation', () => {
    const occ = createOccupancy();
    const rs = [0, 1, 2].map(k => makeRecipe({ n: k, pts: linePts(0, k, 50, k + 3, 30), origin: [3.7e6 + k, -9.1e6], z: 16 }));
    for (const r of rs) occ.add(r);
    expect(occ.crowding(3.7e6 + 25, -9.1e6 + 2, 16)).toBeGreaterThan(0);
    for (const r of rs) occ.remove(r);
    expect(occ.cells).toBe(0);
  });
});

describe('occupancy: corrupt input and extreme zoom never hang', () => {
  it('non-finite sample rows are skipped (an Infinity row used to loop forever)', () => {
    const occ = createOccupancy();
    const bad = makeRecipe({ n: 1, pts: linePts(0, 0, 100, 0, 21) });
    bad.samples[5 * S.STRIDE + S.X] = Infinity;
    bad.samples[9 * S.STRIDE + S.Y] = -Infinity;
    bad.samples[12 * S.STRIDE + S.X] = NaN;
    const good = makeRecipe({ n: 2, pts: linePts(0, 40, 100, 40, 21) });
    occ.add(bad); occ.add(good);
    const t0 = performance.now();
    const c = occ.crowding(50, 0, 1);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(c).toBeGreaterThan(0);
    expect(Number.isFinite(occ.side(50, 20, 0, 1, 1))).toBe(true);
    occ.remove(bad); occ.remove(good);
    expect(occ.cells).toBe(0);
    // a recipe with nothing finite to splat is tracked but inert
    const none = makeRecipe({ n: 3, pts: [[NaN, 0], [Infinity, 1]] });
    occ.add(none);
    expect(occ.strokes).toBe(1);
    expect(occ.crowding(0, 0, 1)).toBe(0);
    occ.remove(none);
    expect(occ.strokes).toBe(0);
  });

  it('a non-finite origin is tracked without touching the grid (no NaN keys, no crash)', () => {
    const occ = createOccupancy();
    const rs = Array.from({ length: 40 }, (_, i) => makeRecipe({ n: i, pts: linePts(i * 10, 0, i * 10 + 5, 5) }));
    for (const r of rs) occ.add(r);
    occ.build(200, 0, 600, 1);
    const cells = occ.cells;
    const lost = makeRecipe({ n: 99, pts: linePts(0, 0, 50, 0), origin: [NaN, 0] });
    occ.add(lost);
    expect(occ.cells).toBe(cells);
    expect(occ.crowding(20, 0, 1)).toBeGreaterThan(0);
    occ.remove(lost);
    for (const r of rs) occ.remove(r);
    expect(occ.cells).toBe(0);
  });

  it('an absurd jump between two samples costs bounded work and still cancels exactly', () => {
    const occ = createOccupancy();
    const r = makeRecipe({ pts: [[0, 0], [1e30, 1e30], [5, 5]], z: 32 });  // level −2: 0.25-doc cells
    occ.build(0, 0, 200, 32);                // materialise first, so add() splats eagerly
    const t0 = performance.now();
    occ.add(r);
    expect(occ.coverage(0, 0, 48, 32)).toBeGreaterThan(0);   // at least the end cap registers
    occ.remove(r);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(occ.cells).toBe(0);
  });

  it('a zoom outside the exact level range is clamped rather than scanning billions of cells', () => {
    const occ = createOccupancy();
    occ.add(makeRecipe({ pts: linePts(0, 0, 100, 0) }));
    const t0 = performance.now();
    for (const z of [1e-9, 1e-30, 1e12, Number.MIN_VALUE]) {
      expect(Number.isFinite(occ.crowding(0, 0, z))).toBe(true);
      expect(Number.isFinite(occ.side(0, 0, 0, 1, z))).toBe(true);
      expect(Number.isFinite(occ.coverage(0, 0, 48, z))).toBe(true);
    }
    expect(occ.coverage(0, 0, 1e12, 1)).toBeGreaterThanOrEqual(0);  // huge radius: capped
    expect(occ.coverage(0, 0, Infinity, 1)).toBe(0);
    occ.build(0, 0, 1e9, 1);                                        // huge warm radius: capped
    expect(occ.blocks).toBeLessThan(70 * 70 + 100);
    expect(occ.side(0, 0, Infinity, 0, 1)).toBe(0);
    expect(occ.crowding(Infinity, 0, 1)).toBe(0);
    expect(occ.isBuilt(Infinity, 0, 1)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('occupancy: lazy blocks', () => {
  const strokesFor = (seed: number, count: number) => {
    const rnd = mulberry(seed);
    return Array.from({ length: count }, (_, i) => makeRecipe({
      n: i,
      pts: Array.from({ length: 30 }, (_, k) => [Math.cos(i + k * 0.2) * (40 + i) + i * 3, Math.sin(i * 0.7 + k * 0.15) * 60] as [number, number]),
      z: [0.5, 1, 1, 2, 8][i % 5],
      size: 2 + rnd() * 40,
    }));
  };
  const probeAll = (g: ReturnType<typeof createOccupancy>, z: number) => {
    const out: number[] = [];
    for (let x = -150; x <= 250; x += 13.7) for (let y = -90; y <= 90; y += 11.3) {
      out.push(g.coverage(x, y, 48, z), g.side(x, y, 0.8, -0.6, z));
    }
    return out;
  };

  it('blocks built late equal blocks maintained from the start (bitwise)', () => {
    const rs = strokesFor(5, 40);
    const eager = createOccupancy();
    eager.build(50, 0, 4000, 1);               // everything materialised before any stroke arrives
    eager.build(50, 0, 4000, 4);
    expect(eager.blocks).toBeGreaterThan(1000);
    for (const r of rs) eager.add(r);
    for (const r of rs.slice(0, 10)) eager.remove(r);
    const lazy = createOccupancy();
    for (const r of rs.slice(10)) lazy.add(r);
    expect(lazy.blocks).toBe(0);
    expect(lazy.isBuilt(0, 0, 1)).toBe(false);
    expect(probeAll(lazy, 1)).toEqual(probeAll(eager, 1));
    expect(probeAll(lazy, 4)).toEqual(probeAll(eager, 4));
    expect(lazy.isBuilt(0, 0, 1)).toBe(true);
    expect(lazy.isBuilt(NaN, 0, 1)).toBe(false);
    expect(lazy.blocks).toBeLessThan(60);      // only the blocks the probes touched
  });

  it('warm builds centre-out in slices and stays exact under concurrent add/remove', () => {
    const rs = strokesFor(9, 60);
    const ref = createOccupancy();
    for (const r of rs.slice(0, 50)) ref.add(r);
    for (const r of rs.slice(0, 5)) ref.remove(r);

    const g = createOccupancy();
    for (const r of rs.slice(0, 40)) g.add(r);
    const it = g.warm(50, 0, 400, 1, 100);
    it.next();
    expect(g.isBuilt(50, 0, 1)).toBe(true);    // the centre block goes first
    let steps = 1;
    for (let k = 0; k < 3; k++) { it.next(); steps++; }
    for (const r of rs.slice(40, 50)) g.add(r);  // arrive mid-warm
    for (const r of rs.slice(0, 5)) g.remove(r);
    while (!it.next().done) steps++;
    expect(steps).toBeGreaterThan(5);
    expect(g.isBuilt(-300, 300, 1)).toBe(true);
    expect(probeAll(g, 1)).toEqual(probeAll(ref, 1));

    // clear abandons a pending warm
    const it3 = g.warm(0, 0, 2000, 2, 10);
    it3.next();
    g.clear();
    expect(it3.next().done).toBe(true);
    expect(g.cells).toBe(0);
    expect(g.blocks).toBe(0);
  });

  it('any interleaving of block builds, adds and removes yields the same integers', () => {
    const rs = strokesFor(21, 50);
    const ref = createOccupancy();
    for (const r of rs.slice(0, 40)) ref.add(r);
    ref.build(50, 0, 3000, 4);
    ref.build(50, 0, 3000, 1);
    const g = createOccupancy();
    const rnd = mulberry(8);
    for (let step = 0; step < 400; step++) {
      const k = rnd();
      const r = rs[Math.floor(rnd() * rs.length)];
      if (k < 0.4) g.add(r);
      else if (k < 0.65) g.remove(r);
      else g.coverage((rnd() - 0.5) * 500, (rnd() - 0.5) * 300, 16 + rnd() * 48, rnd() < 0.5 ? 4 : 1); // builds blocks here and there
    }
    rs.forEach((r, i) => (i < 40 ? g.add(r) : g.remove(r)));
    expect(probeAll(g, 4)).toEqual(probeAll(ref, 4));
    expect(probeAll(g, 1)).toEqual(probeAll(ref, 1));
    for (const r of rs) { g.remove(r); ref.remove(r); }
    expect(g.cells).toBe(0);
    expect(ref.cells).toBe(0);
  });

  it('wide capsules spread across their width (read from a deeper zoom)', () => {
    const g = createOccupancy();
    // a 48 sp brush at z = 1 (w = 33.6 doc) read by a stroke drawn at z = 4 (level 1, 2-doc cells)
    g.add(makeRecipe({ pts: linePts(-300, 0, 300, 0, 300), size: 48, z: 1 }));
    expect(g.coverage(0, 0, 48, 4)).toBeGreaterThan(0.85);
    expect(g.coverage(0, 12, 48, 4)).toBeGreaterThan(0.6);   // off the centreline, still inside the ink
    expect(g.coverage(0, 40, 48, 4)).toBe(0);
  });
});
