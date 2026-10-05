import { describe, it, expect } from 'vitest';
import {
  boxDistance, conservativeBox, createTrack, hitPoly, liftTime, nominalWidth, polysHitSegment,
  segSegDist2, trackDistance, trackHitsPoint, trackHitsSegment, trackInside, trackOf, validBox,
} from '../src/scene/query';
import { PolyKind } from '../src/core/types';
import { fakeSpineOf, linePts, makeCooked, makeRecipe } from './scene-sched.helpers';

describe('segment distances', () => {
  it('segSegDist2: crossing, parallel, collinear gap, touching, degenerate', () => {
    expect(segSegDist2(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0);
    expect(segSegDist2(0, 0, 10, 0, 0, 3, 10, 3)).toBe(9);
    expect(segSegDist2(0, 0, 10, 0, 13, 0, 20, 0)).toBe(9);
    expect(segSegDist2(0, 0, 10, 0, 10, 0, 10, 5)).toBe(0);
    expect(segSegDist2(5, 5, 5, 5, 0, 0, 10, 0)).toBe(25);
    expect(segSegDist2(0, 0, 0, 0, 3, 4, 3, 4)).toBe(25);
  });
});

describe('tracks', () => {
  const r = makeRecipe({ pts: linePts(0, 0, 100, 0, 11), origin: [1000, 2000], size: 10, z: 2 }); // w = 3.5 doc

  it('raw samples use the nominal width 0.7·S/z', () => {
    const t = trackOf(r, null, createTrack());
    expect(t.n).toBe(11);
    expect(nominalWidth(r)).toBeCloseTo(3.5, 12);
    // an unusable zoom must not turn the capsule into an infinitely wide one that hits everything
    const flat = makeRecipe({ pts: linePts(0, 0, 100, 0, 11), z: 0 });
    expect(nominalWidth(flat)).toBe(0);
    expect(nominalWidth({ ...flat, z: NaN })).toBe(0);
    expect(trackHitsPoint(trackOf(flat, null, createTrack()), 50, 500, 1)).toBe(false);
    expect(t.wConst).toBeCloseTo(3.5, 12);
    expect(trackHitsPoint(t, 1050, 2000 + 1.75 + 0.99, 1)).toBe(true);
    expect(trackHitsPoint(t, 1050, 2000 + 1.75 + 1.01, 1)).toBe(false);
    expect(trackHitsPoint(t, 1050, 2010, 0)).toBe(false);
    expect(trackDistance(t, 1050, 2007)).toBeCloseTo(7, 6);
    expect(trackDistance(t, 1110, 2000)).toBeCloseTo(10, 6);
  });

  it('a spine overrides the samples (and its per-station width)', () => {
    const spineOf = fakeSpineOf(12);
    const t = trackOf(r, spineOf(r), createTrack());
    expect(t.ws).not.toBeNull();
    expect(trackHitsPoint(t, 1050, 2000 + 6 + 0.5, 1)).toBe(true);
    // an empty spine falls back to samples
    const empty = { ...spineOf(r), n: 0 };
    expect(trackOf(r, empty, createTrack()).stride).toBe(9);
  });

  it('segment hits (eraser sweeps)', () => {
    const t = trackOf(r, null, createTrack());
    expect(trackHitsSegment(t, 1050, 1990, 1050, 2010, 0)).toBe(true);          // crosses
    expect(trackHitsSegment(t, 1000, 2005, 1100, 2005, 3.3)).toBe(true);         // parallel within r + w/2
    expect(trackHitsSegment(t, 1000, 2005, 1100, 2005, 3.2)).toBe(false);
    expect(trackHitsSegment(t, 1200, 2000, 1300, 2000, 5)).toBe(false);
    const dot = trackOf(makeRecipe({ pts: [[0, 0]], size: 10 }), null, createTrack());
    expect(trackHitsSegment(dot, -10, 5, 10, 5, 1.6)).toBe(true);                 // 5 ≤ 1.6 + 3.5
    expect(trackHitsPoint(dot, 0, 5, 1.4)).toBe(false);
  });

  it('lasso fraction with early exit', () => {
    const t = trackOf(r, null, createTrack());
    const sq = (x0: number, x1: number) => Float64Array.of(x0, 1990, x1, 1990, x1, 2010, x0, 2010);
    expect(trackInside(t, sq(990, 1110))).toBe(1);
    expect(trackInside(t, sq(990, 1055))).toBeCloseTo(6 / 11, 12);
    expect(trackInside(t, sq(990, 1055), true)).toBe(1);
    expect(trackInside(t, sq(990, 1045), true)).toBe(0);
    expect(trackInside(t, Float64Array.of(0, 0, 1, 1))).toBe(0);
  });
});

describe('cooked polys', () => {
  const origin = [500, -500] as const;
  const c = makeCooked([
    { pts: [[0, 0, 4], [50, 0, 4], [100, 0, 4]], alpha: 1, gen: 0 },          // trunk
    { pts: [[50, 0, 2], [50, -40, 1]], alpha: 0.6, gen: 1 },                  // branch up
    { pts: [[80, 0, 2], [80, 40, 1]], alpha: 0.2, gen: 1 },                   // faint branch down
    { pts: [[20, 30, 6]], alpha: 0.9, gen: 2, kind: PolyKind.Dot },           // dot
  ], origin);

  it('hitPoly honours alpha and returns the nearest qualifying poly', () => {
    expect(hitPoly(c, origin[0], origin[1], 550, -530, 1, 0.3)).toBe(1);
    expect(hitPoly(c, origin[0], origin[1], 580, -470, 1, 0.3)).toBe(-1);   // faint branch excluded
    expect(hitPoly(c, origin[0], origin[1], 580, -470, 1, 0.1)).toBe(2);
    expect(hitPoly(c, origin[0], origin[1], 522, -468, 0.5, 0.3)).toBe(3);  // dot (radius 3)
    expect(hitPoly(c, origin[0], origin[1], 550.5, -500.5, 3, 0.3)).toBe(0); // trunk outline nearer than the branch's
    expect(hitPoly(c, origin[0], origin[1], 550, -501, 3, 0.3, true)).toBeGreaterThanOrEqual(0);
    expect(hitPoly(c, origin[0], origin[1], 700, -500, 3, 0.3)).toBe(-1);
  });

  it('polysHitSegment', () => {
    expect(polysHitSegment(c, origin[0], origin[1], 530, -520, 570, -520, 0, 0.3)).toBe(true);  // crosses branch 1
    expect(polysHitSegment(c, origin[0], origin[1], 560, -480, 600, -480, 0, 0.3)).toBe(false); // faint branch only
    expect(polysHitSegment(c, origin[0], origin[1], 560, -480, 600, -480, 0, 0.1)).toBe(true);
    expect(polysHitSegment(c, origin[0], origin[1], 510, -465, 530, -465, 6, 0.3)).toBe(true);  // dot: 5 ≤ 6 + 3
    expect(polysHitSegment(c, origin[0], origin[1], 510, -460, 530, -460, 6, 0.3)).toBe(false); // dot: 10 > 6 + 3
  });
});

describe('boxes and times', () => {
  it('conservative box pads the sample bbox by (64 + 3S)/z', () => {
    const r = makeRecipe({ pts: [[0, 0], [10, -20], [30, 5]], origin: [100, 100], size: 12, z: 2 });
    const b = conservativeBox(r, { x0: 0, y0: 0, x1: 0, y1: 0 });
    const pad = (64 + 36) / 2;
    expect(b).toEqual({ x0: 100 - pad, y0: 80 - pad, x1: 130 + pad, y1: 105 + pad });
    expect(validBox(b)).toBe(true);
    expect(validBox({ x0: 1, y0: 0, x1: 0, y1: 0 })).toBe(false);
    expect(validBox({ x0: 0, y0: 0, x1: Infinity, y1: 0 })).toBe(false);
    expect(validBox(null)).toBe(false);
    const empty = conservativeBox(makeRecipe({ pts: [], origin: [5, 5], size: 0 }), { x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(empty).toEqual({ x0: -59, y0: -59, x1: 69, y1: 69 });
  });

  it('boxDistance and liftTime', () => {
    expect(boxDistance({ x0: 0, y0: 0, x1: 10, y1: 10 }, 5, 5)).toBe(0);
    expect(boxDistance({ x0: 0, y0: 0, x1: 10, y1: 10 }, 13, 14)).toBe(5);
    const r = makeRecipe({ pts: linePts(0, 0, 10, 0, 5), created: 5000, dt: 10 });
    expect(liftTime(r)).toBe(5040);
  });
});
