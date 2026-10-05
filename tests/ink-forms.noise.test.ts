/** Gradient noise, its analytic derivatives, the curl field and the lookup tables. */
import { describe, it, expect } from 'vitest';
import { CurlField, gradNoise, permutation, GRAD, GRAD_N, JIT_COS, JIT_SIN, JIT_N, JIT_HALF, type NoiseSample } from '../src/ink/noise';
import { mulberry32 } from './ink-forms.fixtures';

describe('noise', () => {
  it('the permutation is a seeded shuffle of 0..255, doubled', () => {
    const p = permutation(1234), q = permutation(1234), r = permutation(99);
    expect(Array.from(p)).toEqual(Array.from(q));
    expect(Array.from(p)).not.toEqual(Array.from(r));
    expect([...p.subarray(0, 256)].sort((a, b) => a - b)).toEqual([...Array(256).keys()]);
    for (let i = 0; i < 256; i++) expect(p[256 + i]).toBe(p[i]);
  });

  it('the gradient table holds unit vectors; the jitter table spans ±0.14 rad', () => {
    for (let k = 0; k < GRAD_N; k++) expect(Math.hypot(GRAD[2 * k], GRAD[2 * k + 1])).toBeCloseTo(1, 12);
    expect(JIT_N).toBe(64);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < JIT_N; k++) {
      const a = Math.atan2(JIT_SIN[k], JIT_COS[k]);
      lo = Math.min(lo, a); hi = Math.max(hi, a);
    }
    expect(lo).toBeGreaterThan(-JIT_HALF);
    expect(hi).toBeLessThan(JIT_HALF);
    expect(hi - lo).toBeGreaterThan(2 * JIT_HALF * 0.95);
  });

  it('analytic derivatives match finite differences; value is 0 on the lattice and C1 across cells', () => {
    const perm = permutation(7), rand = mulberry32(3);
    const a: NoiseSample = { v: 0, dx: 0, dy: 0 }, b: NoiseSample = { v: 0, dx: 0, dy: 0 }, c: NoiseSample = { v: 0, dx: 0, dy: 0 };
    const h = 1e-6;
    for (let k = 0; k < 400; k++) {
      const x = (rand() - 0.5) * 40, y = (rand() - 0.5) * 40;
      gradNoise(perm, x, y, a);
      gradNoise(perm, x + h, y, b); gradNoise(perm, x - h, y, c);
      expect((b.v - c.v) / (2 * h)).toBeCloseTo(a.dx, 5);
      gradNoise(perm, x, y + h, b); gradNoise(perm, x, y - h, c);
      expect((b.v - c.v) / (2 * h)).toBeCloseTo(a.dy, 5);
      expect(Math.abs(a.v)).toBeLessThan(1);
    }
    gradNoise(perm, 3, -5, a);
    expect(a.v).toBe(0);
    gradNoise(perm, 3 - 1e-9, 0.37, b); gradNoise(perm, 3 + 1e-9, 0.37, c);
    expect(b.v).toBeCloseTo(c.v, 7);
    expect(b.dx).toBeCloseTo(c.dx, 5);
  });

  it('the curl field is divergence-free and its direction is a unit vector', () => {
    const f = new CurlField(42, 140), rand = mulberry32(5);
    const p = new Float64Array(2), q = new Float64Array(2), u = new Float64Array(2);
    const h = 1e-3;
    let worst = 0, scale = 0;
    for (let k = 0; k < 300; k++) {
      const x = (rand() - 0.5) * 2000, y = (rand() - 0.5) * 2000;
      f.curl(x + h, y, p); f.curl(x - h, y, q);
      const dcx = (p[0] - q[0]) / (2 * h);
      scale = Math.max(scale, Math.abs(dcx));
      f.curl(x, y + h, p); f.curl(x, y - h, q);
      const dcy = (p[1] - q[1]) / (2 * h);
      worst = Math.max(worst, Math.abs(dcx + dcy));
      if (f.dir(x, y, u)) expect(Math.hypot(u[0], u[1])).toBeCloseTo(1, 12);
    }
    expect(scale).toBeGreaterThan(1e-6);
    expect(worst).toBeLessThan(1e-6 * scale + 1e-12);
  });

  it('wavelength follows the cell: a field at half the cell is the same field at half the scale', () => {
    const a = new CurlField(9, 140), b = new CurlField(9, 70);
    const p = new Float64Array(2), q = new Float64Array(2);
    for (let k = 0; k < 20; k++) {
      a.dir(10 * k, 7 * k, p); b.dir(5 * k, 3.5 * k, q);
      expect(q[0]).toBeCloseTo(p[0], 9);
      expect(q[1]).toBeCloseTo(p[1], 9);
    }
  });
});
