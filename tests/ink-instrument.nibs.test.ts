import { describe, it, expect } from 'vitest';
import { NIBS, FINGER_WIDTH, nibWidth, chiselAngle, drySplit } from '../src/ink/nibs';

const DEG = Math.PI / 180;

describe('nibs', () => {
  it('defaults and ranges', () => {
    expect(NIBS.pen).toMatchObject({ S: 2.5, min: 0.75, max: 12, taper: 0.5 });
    expect(NIBS.brush).toMatchObject({ S: 9, min: 2, max: 48, taper: 1 });
    expect(NIBS.chisel).toMatchObject({ S: 12, min: 3, max: 48, taper: 0.4 });
    expect(NIBS.charcoal).toMatchObject({ S: 7, min: 2, max: 40, taper: 0.8 });
    expect(FINGER_WIDTH).toBe(1.35);
  });

  it('width formulas', () => {
    expect(nibWidth('pen', 2.5, 0.5, 1, 'pen')).toBeCloseTo(2.5 * (0.72 + 0.19), 12);
    expect(nibWidth('brush', 9, 0.64, 0.5, 'pen')).toBeCloseTo(9 * (0.14 + 0.512), 12);
    // the speed term thins a pen brush only
    expect(nibWidth('brush', 9, 0.64, 3, 'pen')).toBeCloseTo(9 * (0.14 + 0.512) * 0.75, 12);
    expect(nibWidth('brush', 9, 0.64, 3, 'mouse')).toBeCloseTo(9 * (0.14 + 0.512), 12);
    expect(nibWidth('chisel', 12, 1, 1, 'pen')).toBeCloseTo(12, 12);
    expect(nibWidth('charcoal', 7, 0, 1, 'pen')).toBeCloseTo(4.9, 12);
    expect(nibWidth('pen', 2.5, 0.5, 1, 'touch')).toBeCloseTo(2.5 * 0.91 * 1.35, 12);
    expect(nibWidth('pen', 2.5, 7, 1, 'pen')).toBe(nibWidth('pen', 2.5, 1, 1, 'pen'));
  });

  it('chisel angle: azimuth when tilted, 40° when upright, crossfaded, modulo π', () => {
    expect(chiselAngle(30 * DEG, 1.2)).toBeCloseTo(1.2, 12);
    expect(chiselAngle(80 * DEG, 1.2)).toBeCloseTo(40 * DEG, 12);
    expect(chiselAngle(Math.PI / 2, 0)).toBeCloseTo(40 * DEG, 12);
    expect(chiselAngle(30 * DEG, 1.2 + Math.PI)).toBeCloseTo(1.2, 9);
    const mid = chiselAngle(60 * DEG, 80 * DEG);
    expect(mid).toBeGreaterThan(40 * DEG); expect(mid).toBeLessThan(80 * DEG);
    for (let a = 0; a < 7; a += 0.3) {
      const t = chiselAngle(40 * DEG, a);
      expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThan(Math.PI);
    }
  });

  it('unknown pressure or speed still gives a finite width and split', () => {
    expect(nibWidth('brush', 9, NaN, 1, 'pen')).toBeCloseTo(nibWidth('brush', 9, 0.6, 1, 'pen'), 12);
    expect(nibWidth('brush', 9, 0.5, NaN, 'pen')).toBeCloseTo(nibWidth('brush', 9, 0.5, 0, 'pen'), 12);
    for (const nib of ['pen', 'brush', 'chisel', 'charcoal'] as const) expect(Number.isFinite(nibWidth(nib, 5, NaN, NaN, 'touch'))).toBe(true);
    expect(drySplit('brush', NaN, 0.2, 'pen')).toBe(0);
    expect(drySplit('brush', 2, NaN, 'pen')).toBe(0);
  });

  it('dry split: brush only, fast and light', () => {
    expect(drySplit('brush', 2, 0.2, 'pen')).toBe(1);
    expect(drySplit('brush', 1, 0.2, 'pen')).toBe(0);
    expect(drySplit('brush', 2, 0.7, 'pen')).toBe(0);
    expect(drySplit('pen', 2, 0.2, 'pen')).toBe(0);
    const w = drySplit('brush', 1.3, 0.5, 'mouse');
    expect(w).toBeGreaterThan(0.2); expect(w).toBeLessThan(0.3);
  });
});
