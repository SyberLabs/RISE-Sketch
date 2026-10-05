import { describe, it, expect } from 'vitest';
import { resample, chaikin, rdp, signedArea, pointInPolygon, polyLength, bbox, transformBox } from '../src/core/geom';
import { gamutMap, lchToHex, hexToLch, deltaE, lchToLinear } from '../src/core/oklab';
import { multiply, invert, apply, rotation, translation } from '../src/core/mat';

describe('geom', () => {
  it('resample keeps spacing and endpoints', () => {
    const p = [0, 0, 10, 0, 10, 10];
    const r = resample(p, 2);
    for (let i = 2; i < r.length - 2; i += 2) expect(Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1])).toBeCloseTo(2, 6);
    expect(r[r.length - 2]).toBeCloseTo(10); expect(r[r.length - 1]).toBeCloseTo(10);
    expect(polyLength(r)).toBeGreaterThan(19.5);
  });
  it('chaikin keeps endpoints', () => {
    const c = chaikin([0, 0, 10, 0, 10, 10], 2);
    expect([c[0], c[1]]).toEqual([0, 0]);
    expect([c[c.length - 2], c[c.length - 1]]).toEqual([10, 10]);
  });
  it('rdp keeps corners', () => {
    const p: number[] = [];
    for (let i = 0; i <= 10; i++) p.push(i, 0);
    for (let i = 1; i <= 10; i++) p.push(10, i);
    expect(Array.from(rdp(p, 0.1))).toEqual([0, 0, 10, 0, 10, 10]);
  });
  it('area and point in polygon', () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(Math.abs(signedArea(sq))).toBe(100);
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(15, 5, sq)).toBe(false);
    expect(bbox(sq, 1)).toEqual({ x0: -1, y0: -1, x1: 11, y1: 11 });
  });
});
describe('mat', () => {
  it('invert and multiply', () => {
    const m = multiply(translation(5, 7), rotation(0.7));
    const inv = invert(m)!;
    const [x, y] = apply(m, 3, 4);
    const [bx, by] = apply(inv, x, y);
    expect(bx).toBeCloseTo(3, 12); expect(by).toBeCloseTo(4, 12);
    const b = transformBox({ x0: 0, y0: 0, x1: 1, y1: 1 }, translation(2, 3));
    expect(b).toEqual({ x0: 2, y0: 3, x1: 3, y1: 4 });
  });
});
describe('oklab', () => {
  it('round-trips hex and gamut maps', () => {
    for (const h of ['#1d5b8a', '#e8c04a', '#ffffff', '#000000', '#7f3fbf']) {
      const lch = hexToLch(h)!;
      expect(lchToHex(lch)).toBe(h);
    }
    const g = gamutMap([0.7, 0.4, 145]);
    const lin = lchToLinear(g);
    for (const c of lin) { expect(c).toBeGreaterThanOrEqual(-1e-3); expect(c).toBeLessThanOrEqual(1 + 1e-3); }
    expect(g[1]).toBeLessThan(0.4);
    expect(deltaE([0.5, 0.1, 30], [0.5, 0.1, 30])).toBe(0);
  });
});
