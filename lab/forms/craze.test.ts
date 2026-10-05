/**
 * Craze (lab): incremental ≡ full, determinism, invariants, budgets, degenerate input,
 * depth continuity, and the brief's acceptance criteria where they can be measured.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked } from '../../src/core/types';
import * as craze from './craze.form';
import { checkIncremental, labCook, problems, Hand, cookedHash } from './harness';

vi.setConfig({ testTimeout: 60000 });

// ---------------------------------------------------------------- gestures (sp)

const signature = (seed = 3): Hand => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9);
  h.moveTo(150, 110, 1.3, 0.55).arc(200, 110, 50, Math.PI, 1.9 * Math.PI, 1.6);
  h.moveTo(300, 40, 2.3, 0.25);
  return h;
};
const loop = (seed = 7): Hand => {
  const h = new Hand(170, 90, { jitter: 0.15, seed, p: 0.6 });
  h.arc(110, 90, 60, 0, 2 * Math.PI * 1.01, 0.8);
  return h;
};
const corners = (seed = 9): Hand => {
  const h = new Hand(10, 140, { jitter: 0.2, seed, p: 0.55 });
  h.moveTo(60, 20, 0.5).moveTo(61, 21, 0.05).hold(70).moveTo(130, 150, 0.6).moveTo(131, 149, 0.05).hold(70);
  h.moveTo(200, 20, 0.6).moveTo(201, 21, 0.05).hold(70).moveTo(280, 140, 0.9, 0.3);
  return h;
};
const straight = (v: number, p: number, seed = 21, c = 0): Hand => {
  const h = new Hand(0, 60, { jitter: 0.15, seed, p, c });
  h.moveTo(160, 40, v).moveTo(320, 70, v).moveTo(480, 40, v);
  return h;
};
const sweep = (seed = 21): Hand => {
  const h = new Hand(0, 40, { jitter: 0.2, seed, p: 0.45 });
  h.moveTo(60, 0, 0.7, 0.75).arc(100, 40, 50, -Math.PI / 2, Math.PI / 2, 0.9).moveTo(200, 120, 1.2, 0.35);
  return h;
};
const tap = (hold = 60, seed = 13, p = 0.65): Hand => {
  const h = new Hand(0, 0, { jitter: 0.05, seed, p });
  h.hold(hold);
  return h;
};

// ---------------------------------------------------------------- helpers

const genSet = (c: Cooked): Set<number> => { const s = new Set<number>(); for (let i = 0; i < c.nPolys; i++) s.add(c.gen[i]); return s; };
const units = (c: Cooked): Set<number> => { const s = new Set<number>(); for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) s.add(c.unit[i]); return s; };
const ptsPerUnit = (c: Cooked): Map<number, number> => {
  const m = new Map<number, number>();
  for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1 || isFilm(c, i)) m.set(c.unit[i], (m.get(c.unit[i]) ?? 0) + c.count[i]);
  return m;
};
/** Distance from (x, y) to the nearest point of polys satisfying `pick`. */
function nearest(c: Cooked, x: number, y: number, pick: (i: number) => boolean): number {
  let best = Infinity;
  for (let i = 0; i < c.nPolys; i++) {
    if (!pick(i)) continue;
    for (let k = 0; k < c.count[i]; k++) {
      const j = c.start[i] + k, dx = c.pts[4 * j] - x, dy = c.pts[4 * j + 1] - y, d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
/** Distance from (x, y) to the nearest drawn segment of polys satisfying `pick`. */
function nearestSeg(c: Cooked, x: number, y: number, pick: (i: number) => boolean): number {
  let best = Infinity;
  for (let i = 0; i < c.nPolys; i++) {
    if (!pick(i)) continue;
    for (let k = 1; k < c.count[i]; k++) {
      const j = c.start[i] + k, ax = c.pts[4 * j - 4], ay = c.pts[4 * j - 3], bx = c.pts[4 * j], by = c.pts[4 * j + 1];
      const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
      const dx = ax + vx * t - x, dy = ay + vy * t - y, d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
/** Trunk polys: gen 0 at full alpha (the film is gen 0 too, at alpha ≤ 0.14). */
const isTrunk = (c: Cooked, i: number): boolean => c.gen[i] === 0 && c.alpha[i] === 1;
const isFilm = (c: Cooked, i: number): boolean => c.gen[i] === 0 && c.alpha[i] < 1;
/** Hausdorff distance between the point sets of polys with gen in [g0, g1] (one way, both ways). */
function hausdorff(a: Cooked, b: Cooked, g0: number, g1: number): number {
  const one = (p: Cooked, q: Cooked): number => {
    let worst = 0;
    for (let i = 0; i < p.nPolys; i++) {
      if (p.gen[i] < g0 || p.gen[i] > g1) continue;
      for (let k = 0; k < p.count[i]; k++) {
        const j = p.start[i] + k;
        const d = nearest(q, p.pts[4 * j], p.pts[4 * j + 1], (m) => q.gen[m] >= g0 && q.gen[m] <= g1);
        if (d > worst) worst = d;
      }
    }
    return worst;
  };
  return Math.max(one(a, b), one(b, a));
}
/** End points (x, y) of a poly. */
const ends = (c: Cooked, i: number): number[] => {
  const a = c.start[i], b = c.start[i] + c.count[i] - 1;
  return [c.pts[4 * a], c.pts[4 * a + 1], c.pts[4 * b], c.pts[4 * b + 1]];
};
/** Mean arc spacing (sp) between consecutive gen-1 units' `born` arcs. */
function meanSpacing(c: Cooked): number {
  const born: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 1 && !seen.has(c.unit[i])) { seen.add(c.unit[i]); born.push(c.born[i]); }
  born.sort((a, b) => a - b);
  let s = 0;
  for (let i = 1; i < born.length; i++) s += born[i] - born[i - 1];
  return born.length > 1 ? s / (born.length - 1) : NaN;
}
/** Max width (doc) of polys of one gen. */
function maxWidth(c: Cooked, gen: number): number {
  let w = 0;
  for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === gen) for (let k = 0; k < c.count[i]; k++) w = Math.max(w, c.pts[4 * (c.start[i] + k) + 2]);
  return w;
}

// ---------------------------------------------------------------- invariants

describe('craze: incremental ≡ full', () => {
  it('signature with holds and closure flicker', () => {
    expect(checkIncremental(craze, signature(), { holds: [[30, 1.5], [10, 2], [60, 3]], flickerClosure: true })).toBeNull();
  });
  it('closed loop with holds', () => {
    expect(checkIncremental(craze, loop(), { closed: true, holds: [[20, 2], [50, 1]], flickerClosure: true })).toBeNull();
  });
  it('corners with pools, base 4', () => {
    expect(checkIncremental(craze, corners(), { base: 4, holds: [[15, 2]], pools: [80, 2, 200, 1.5] })).toBeNull();
  });
});

describe('craze: determinism and invariants', () => {
  it('cookedHash is stable across cooks', () => {
    expect(cookedHash(labCook(craze, signature()).c)).toBe(cookedHash(labCook(craze, signature()).c));
    expect(cookedHash(labCook(craze, loop(), { closed: true }).c)).toBe(cookedHash(labCook(craze, loop(), { closed: true }).c));
    expect(cookedHash(labCook(craze, signature()).c)).not.toBe(cookedHash(labCook(craze, signature(), { seed: 99 }).c));
  });
  it('problems() is empty on every gesture', () => {
    for (const { c } of [
      labCook(craze, signature()), labCook(craze, loop(), { closed: true }), labCook(craze, corners(), { base: 4 }),
      labCook(craze, tap(), { radial: true }), labCook(craze, tap(800), { radial: true, pools: [0, 1.5] }),
      labCook(craze, signature(), { nib: 'chisel', size: 12 }), labCook(craze, signature(), { nib: 'pen', size: 2.5 }),
      labCook(craze, signature(), { nib: 'brush', size: 22, base: 4 }),
    ]) expect(problems(c)).toEqual([]);
  });
  it('honours the unit and stroke budgets', () => {
    const { c } = labCook(craze, signature(), { base: 4, nib: 'brush', size: 22 });
    for (const [, n] of ptsPerUnit(c)) expect(n).toBeLessThanOrEqual(craze.ops.unitBudget);
    let growth = 0;
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1 || isFilm(c, i)) growth += c.count[i];
    expect(growth).toBeLessThanOrEqual(craze.ops.strokeBudget + craze.ops.unitBudget);
  });
  it('no NaN at degenerate input (2-sample stroke, tap, 1-sample)', () => {
    const two = new Hand(0, 0, { seed: 1, p: 0.5 }); two.moveTo(0.5, 0.2, 0.5);
    expect(problems(labCook(craze, two).c)).toEqual([]);
    expect(problems(labCook(craze, two, { radial: true }).c)).toEqual([]);
    expect(problems(labCook(craze, tap(20), { radial: true, base: 4 }).c)).toEqual([]);
    const one = new Hand(5, 5, { seed: 2, p: 0.5 });
    expect(problems(labCook(craze, one, { radial: true }).c)).toEqual([]);
    expect(problems(labCook(craze, signature(), { base: 0 }).c)).toEqual([]);
  });
  it('depth is continuous: bounded change per 1/16 level', () => {
    const h = sweep(5);
    let worst = 0;
    for (const d of [0, 0.4375, 1, 1.9375, 2.5, 3, 3.9375]) {
      const a = labCook(craze, h, { base: d, nib: 'pen', size: 3 }).c;
      const b = labCook(craze, h, { base: d + 0.0625, nib: 'pen', size: 3 }).c;
      const hd = hausdorff(a, b, 0, 9);
      worst = Math.max(worst, hd);
      expect(hd).toBeLessThan(3.5);
    }
    expect(worst).toBeGreaterThan(0);
  });
  it('depth 0 is the bare stroke', () => {
    const { c } = labCook(craze, signature(), { base: 0 });
    expect(genSet(c)).toEqual(new Set([0]));
    for (let i = 0; i < c.nPolys; i++) expect(c.alpha[i]).toBe(1); // no film either
  });
});

// ---------------------------------------------------------------- acceptance criteria

describe('craze: 1. network, not hair', () => {
  it('gen-2 and gen-4 cracks end on their parent cracks (exact T-junctions)', () => {
    for (const h of [signature(), corners()]) {
      const { c } = labCook(craze, h, { base: 4 });
      let checked = 0;
      for (let i = 0; i < c.nPolys; i++) {
        const g = c.gen[i];
        if (g !== 2 && g !== 4) continue;
        const u = c.unit[i], e = ends(c, i);
        // gen 2 spans from crack j−1 (the previous unit) to crack j; gen 4 from this unit's gen-3 crack to a gen-1 crack
        const parent = (m: number): boolean => c.gen[m] === 1 || (g === 4 && c.gen[m] === 3 && c.unit[m] === u);
        expect(nearestSeg(c, e[0], e[1], parent)).toBeLessThan(1e-3);
        expect(nearestSeg(c, e[2], e[3], parent)).toBeLessThan(1e-3);
        checked++;
      }
      expect(checked).toBeGreaterThan(10);
    }
  });
  it('gen-3 cracks start on a longitudinal crack when the plate has one', () => {
    const { c } = labCook(craze, signature(), { base: 4 });
    let withLong = 0, onLong = 0;
    for (let i = 0; i < c.nPolys; i++) {
      if (c.gen[i] !== 3) continue;
      const u = c.unit[i];
      let has = false;
      for (let m = 0; m < c.nPolys && !has; m++) if (c.unit[m] === u && c.gen[m] === 2) has = true;
      if (!has) continue;
      withLong++;
      const e = ends(c, i);
      const d0 = nearestSeg(c, e[0], e[1], (m) => c.unit[m] === u && c.gen[m] === 2);
      const d1 = nearestSeg(c, e[2], e[3], (m) => c.unit[m] === u && c.gen[m] === 2);
      if (Math.min(d0, d1) < 1e-3) onLong++;
    }
    expect(withLong).toBeGreaterThan(5);
    expect(onLong).toBe(withLong);
  });
  it('plates are larger on heavy / slow runs and finer on fast / light ones', () => {
    const slowHeavy = meanSpacing(labCook(craze, straight(0.25, 0.9)).c);
    const fastLight = meanSpacing(labCook(craze, straight(2.6, 0.25)).c);
    const slowLight = meanSpacing(labCook(craze, straight(0.25, 0.25)).c);
    expect(slowHeavy).toBeGreaterThan(1.5 * fastLight);
    expect(slowHeavy).toBeGreaterThan(1.2 * slowLight);
    expect(slowLight).toBeGreaterThan(1.15 * fastLight);
  });
  it('corners shatter: units pack tighter near the corner holds than on the straight runs', () => {
    const { c } = labCook(craze, corners());
    const born: number[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 1 && !seen.has(c.unit[i])) { seen.add(c.unit[i]); born.push(c.born[i]); }
    born.sort((a, b) => a - b);
    const gaps = born.slice(1).map((b, i) => b - born[i]);
    gaps.sort((a, b) => a - b);
    expect(gaps[0]).toBeLessThan(0.6 * gaps[gaps.length - 1]);
  });
  it('nearby ink narrows the band', () => {
    const extent = (c: Cooked): number => {
      let e = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 1) {
        const en = ends(c, i);
        e = Math.max(e, nearest(c, en[2], en[3], (m) => isTrunk(c, m)));
      }
      return e;
    };
    const free = extent(labCook(craze, straight(0.6, 0.6, 21, 0)).c);
    const crowded = extent(labCook(craze, straight(0.6, 0.6, 21, 0.9)).c);
    expect(crowded).toBeLessThan(0.85 * free);
  });
});

describe('craze: 2. depth ladder', () => {
  it('d = 1 transverse only; d = 2 adds longitudinal splits; d = 4 sub-plates and wider old seams', () => {
    const h = sweep();
    const d1 = labCook(craze, h, { base: 1 }).c, d2 = labCook(craze, h, { base: 2 }).c;
    const d3 = labCook(craze, h, { base: 3 }).c, d4 = labCook(craze, h, { base: 4 }).c;
    expect(genSet(d1)).toEqual(new Set([0, 1]));
    expect(genSet(d2)).toEqual(new Set([0, 1, 2]));
    expect(genSet(d4)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(maxWidth(d4, 1)).toBeCloseTo(1.8 * maxWidth(d3, 1), 5);
    expect(maxWidth(d4, 3)).toBeCloseTo(maxWidth(d3, 3), 5);
    // nothing moves: gen-1 geometry at d = 4 contains gen-1 at d = 1 exactly
    expect(hausdorff(d1, d4, 1, 1)).toBeLessThan(1e-4);
    expect(units(d1)).toEqual(units(d4));
  });
  it('the held tap is a dried drop with a ring crack', () => {
    const c = labCook(craze, tap(800), { radial: true, pools: [0, 1.5] }).c;
    expect(genSet(c)).toEqual(new Set([0, 1, 2, 3]));
    // the ring: one gen-2 poly whose points sit at a near-constant radius from the seed
    let ring = -1;
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 2) ring = i;
    expect(ring).toBeGreaterThanOrEqual(0);
    const o = c.start[ring], n = c.count[ring];
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) { cx += c.pts[4 * (o + k)]; cy += c.pts[4 * (o + k) + 1]; }
    cx /= n; cy /= n;
    let rMin = Infinity, rMax = 0;
    for (let k = 0; k < n; k++) { const r = Math.hypot(c.pts[4 * (o + k)] - cx, c.pts[4 * (o + k) + 1] - cy); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
    expect(rMax - rMin).toBeLessThan(0.15 * rMax);
    expect(problems(c)).toEqual([]);
    const shallow = labCook(craze, tap(60), { radial: true }).c;
    expect(genSet(shallow)).toEqual(new Set([0, 1, 2]));
  });
});

describe('craze: 3. two grounds, one geometry', () => {
  it('seam alphas follow the hierarchy and never exceed the trunk', () => {
    const { c } = labCook(craze, signature(), { base: 4 });
    const a: number[] = [1, 0, 0, 0, 0];
    for (let i = 0; i < c.nPolys; i++) a[c.gen[i]] = Math.max(a[c.gen[i]], c.alpha[i]);
    expect(a[1]).toBeCloseTo(0.55, 5);
    expect(a[2]).toBeLessThan(a[1]); expect(a[3]).toBeLessThan(a[2]); expect(a[4]).toBeLessThan(a[3]);
    let trunk = 0, film = 0;
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 0) { if (c.alpha[i] === 1) trunk++; else { film++; expect(c.alpha[i]).toBeLessThanOrEqual(0.14 + 1e-6); } }
    expect(trunk).toBeGreaterThan(0); expect(film).toBeGreaterThan(5);
  });
  it('the film welds: neighbouring plates share their edge point and width at the crack', () => {
    const { c } = labCook(craze, signature(), { base: 2 });
    const films: number[] = [];
    for (let i = 0; i < c.nPolys; i++) if (isFilm(c, i)) films.push(i);
    films.sort((a, b) => c.unit[a] - c.unit[b]);
    let shared = 0;
    for (let k = 1; k < films.length; k++) {
      const a = films[k - 1], b = films[k];
      if (c.unit[b] !== c.unit[a] + 1) continue;
      const ea = c.start[a] + c.count[a] - 1, sb = c.start[b];
      expect(c.pts[4 * ea]).toBe(c.pts[4 * sb]); expect(c.pts[4 * ea + 1]).toBe(c.pts[4 * sb + 1]); expect(c.pts[4 * ea + 2]).toBe(c.pts[4 * sb + 2]);
      expect(b).toBe(a + 1); // consecutive polys, so the raster welds them
      shared++;
    }
    expect(shared).toBeGreaterThan(5);
  });
  it('gens 3–4 never widen with depth (no blow-out at a held spot)', () => {
    const h = sweep();
    const a = labCook(craze, h, { base: 3, pools: [100, 1] }).c, b = labCook(craze, h, { base: 3 }).c;
    expect(maxWidth(a, 3)).toBeCloseTo(maxWidth(b, 3), 5);
    expect(maxWidth(a, 1)).toBeGreaterThan(maxWidth(b, 1));
  });
});
