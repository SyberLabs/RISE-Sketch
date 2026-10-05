import { describe, it, expect } from 'vitest';
import { kernel, createDepthField, POOL_BACK, POOL_AHEAD } from '../src/ink/depth';

describe('depth field', () => {
  it('kernel K(x)', () => {
    expect(kernel(0)).toBe(1);
    expect(kernel(-6)).toBe(1);
    expect(kernel(-3)).toBe(1);
    expect(kernel(-27)).toBeCloseTo(0.5, 12);
    expect(kernel(-48)).toBe(0);
    expect(kernel(-60)).toBe(0);
    expect(kernel(16)).toBeCloseTo(0.5, 12);
    expect(kernel(32)).toBe(0);
    expect(kernel(1e-9)).toBeCloseTo(1, 9);
    for (let x = -50; x < 34; x += 0.5) { expect(kernel(x)).toBeGreaterThanOrEqual(0); expect(kernel(x)).toBeLessThanOrEqual(1); }
    expect(POOL_BACK).toBe(48); expect(POOL_AHEAD).toBe(32);
  });

  it('d(s) = base + max a·K, maxPool, and live rows', () => {
    const pools = new Float32Array([100, 2, 0, 500, 130, 1, 600, 900, 0, 0, 0, 0]);
    const d = createDepthField(1.5, pools, 2);
    expect(d.base).toBe(1.5);
    expect(d.at(100)).toBe(3.5);
    expect(d.at(500)).toBe(1.5);
    expect(d.at(116)).toBeCloseTo(1.5 + Math.max(2 * 0.5, 1 * kernel(116 - 130)), 6);
    expect(d.at(130)).toBe(3.5 - 2 + Math.max(2 * kernel(30), 1));
    expect(d.maxPool()).toBe(2);
    pools[1] = 3;
    expect(d.at(100)).toBe(4.5);
    expect(createDepthField(0, new Float32Array(0), 0).at(5)).toBe(0);
    expect(createDepthField(0, pools, 99).maxPool()).toBe(3);
  });
});
