import { describe, it, expect } from 'vitest';
import * as smoke from './_smoke.form';
import { checkIncremental, labCook, problems, Hand, cookedHash } from './harness';

const sig = (seed = 3) => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9).moveTo(150, 110, 1.3, 0.55).moveTo(300, 40, 2.3, 0.25);
  return h;
};

describe('lab harness smoke', () => {
  it('cooks a lab-registered operator through the real pipeline', () => {
    const { c } = labCook(smoke, sig());
    expect(c.nPts).toBeGreaterThan(100);
    expect(c.genStart.length).toBeGreaterThan(2); // Drift grows generations
    expect(problems(c)).toEqual([]);
  });
  it('is deterministic and incremental ≡ full', () => {
    expect(cookedHash(labCook(smoke, sig()).c)).toBe(cookedHash(labCook(smoke, sig()).c));
    expect(checkIncremental(smoke, sig(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
  });
});
