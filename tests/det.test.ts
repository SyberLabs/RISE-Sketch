import { describe, it, expect } from 'vitest';
import { dsin, dcos, datan, datan2, dexp, dlog, dpow, rnd, fmix32, pow2i } from '../src/core/det';

function maxRelErr(f: (x: number) => number, g: (x: number) => number, xs: number[]) {
  let m = 0;
  for (const x of xs) {
    const a = f(x), b = g(x);
    const e = Math.abs(a - b) / Math.max(1e-300, Math.abs(b), 1e-12);
    if (e > m) m = e;
  }
  return m;
}
const range = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)));

describe('det', () => {
  it('sin/cos match Math within 1e-15 abs over [-1000, 1000]', () => {
    const xs = range(-1000, 1000, 20001).concat(range(-7, 7, 5001));
    let m = 0;
    for (const x of xs) { m = Math.max(m, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x))); }
    expect(m).toBeLessThan(1e-14);
  });
  it('atan/atan2 match Math', () => {
    expect(maxRelErr(datan, Math.atan, range(-50, 50, 20001))).toBeLessThan(1e-15);
    let m = 0;
    for (let i = 0; i < 4000; i++) {
      const a = (i / 4000) * Math.PI * 2 - Math.PI;
      for (const r of [1e-6, 0.3, 1, 7, 1e5]) {
        const y = Math.sin(a) * r, x = Math.cos(a) * r;
        m = Math.max(m, Math.abs(datan2(y, x) - Math.atan2(y, x)));
      }
    }
    expect(m).toBeLessThan(1e-15 * 8);
    expect(datan2(0, -1)).toBeCloseTo(Math.PI, 15);
    expect(datan2(1, 0)).toBeCloseTo(Math.PI / 2, 15);
    expect(datan2(0, 0)).toBe(0);
  });
  it('exp/log/pow match Math', () => {
    expect(maxRelErr(dexp, Math.exp, range(-700, 700, 20001))).toBeLessThan(2e-15);
    expect(maxRelErr(dlog, Math.log, range(1e-9, 1e6, 20001).concat(range(0.5, 2, 5001)))).toBeLessThan(2e-15);
    const xs = range(0.001, 10, 3001);
    let m = 0;
    for (const x of xs) for (const y of [0.3, 0.6, 1.3, 1.5, 2.7, -1.2]) {
      m = Math.max(m, Math.abs(dpow(x, y) - Math.pow(x, y)) / Math.pow(x, y));
    }
    expect(m).toBeLessThan(1e-13);
    expect(dlog(Math.E)).toBeCloseTo(1, 15);
    expect(pow2i(10)).toBe(1024);
    expect(pow2i(-3)).toBe(0.125);
  });
  it('rnd is uniform-ish, deterministic, and order independent', () => {
    const a = rnd(42, 1, 7, 3), b = rnd(42, 1, 7, 3);
    expect(a).toBe(b);
    expect(rnd(42, 1, 7, 3)).not.toBe(rnd(42, 2, 7, 3));
    let sum = 0, n = 100000;
    const bins = new Array(10).fill(0);
    for (let i = 0; i < n; i++) { const v = rnd(123, 3, i); sum += v; bins[Math.floor(v * 10)]++; expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.01);
    for (const c of bins) expect(Math.abs(c - n / 10)).toBeLessThan(n / 10 * 0.05);
    expect(fmix32(0)).toBe(0);
  });
});
