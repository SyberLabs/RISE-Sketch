import { describe, it, expect } from 'vitest';
import { OneEuro, JitterMeter, euroAlpha, oneEuroParams, BETA } from '../src/ink/stabilize';
import { DEFAULT_CALIB } from '../src/ink/calib';
import { buildSpine } from '../src/ink/spine';
import { Hand, recipe, mulberry32 } from './ink-instrument.fixtures';

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
}

describe('One Euro filter', () => {
  it('α = 1/(1 + 1/(2π·fc·dt)) without transcendentals', () => {
    expect(euroAlpha(10, 1000 / (2 * Math.PI * 10))).toBeCloseTo(0.5, 12);
    expect(euroAlpha(3.5, 4)).toBeLessThan(euroAlpha(20, 4));
    expect(euroAlpha(3.5, 4)).toBeLessThan(euroAlpha(3.5, 16));
  });

  it('uses the calib cutoff and the device β', () => {
    expect(oneEuroParams('pen', DEFAULT_CALIB.pen)).toEqual({ fcMin: 3.5, beta: BETA.pen });
    expect(oneEuroParams('mouse', DEFAULT_CALIB.mouse)).toEqual({ fcMin: 2.0, beta: 0.010 });
    expect(oneEuroParams('touch', { ...DEFAULT_CALIB.touch, fcMin: NaN }).fcMin).toBe(1.5);
  });

  it('passes the first sample through and converges on a still point', () => {
    const f = new OneEuro(3.5, 0.02);
    f.step(10, 20, 0);
    expect([f.x, f.y]).toEqual([10, 20]);
    for (let i = 1; i <= 400; i++) f.step(30, 20, i * 4);
    expect(f.x).toBeCloseTo(30, 6);
  });

  it('reduces noise on a jittered line (slow and fast), with bounded lag', () => {
    for (const speed of [0.15, 1.2]) {
      const rand = mulberry32(42), f = new OneEuro(3.5, 0.02);
      let raw2 = 0, filt2 = 0, n = 0, lagMax = 0;
      const dt = 1000 / 240, sigma = 0.4;
      for (let i = 0; i < 2400; i++) {
        const t = i * dt, x = speed * t;
        const nx = x + sigma * gauss(rand), ny = sigma * gauss(rand);
        f.step(nx, ny, t);
        if (i > 240) {
          raw2 += ny * ny; filt2 += f.y * f.y; n++;
          lagMax = Math.max(lagMax, x - f.x);
        }
      }
      const rawRms = Math.sqrt(raw2 / n), filtRms = Math.sqrt(filt2 / n);
      // One Euro trades smoothing for lag as speed rises (fc = fcMin + β·v): strong when slow, mild when fast
      expect(filtRms).toBeLessThan((speed < 1 ? 0.35 : 0.6) * rawRms);
      expect(lagMax).toBeLessThan(speed < 1 ? 6 : 12);
    }
  });

  it('the spine of a jittered line is far straighter than its samples', () => {
    const h = new Hand(0, 0, { jitter: 0.5, seed: 12 });
    h.moveTo(200, 0, 0.4);
    const sp = buildSpine(recipe(h.rows()));
    let dev = 0, m = 0;
    for (let i = 0; i < sp.n; i++) if (sp.s[i] > 20 && sp.s[i] < sp.L - 20) { dev += sp.y[i] * sp.y[i]; m++; }
    expect(Math.sqrt(dev / m)).toBeLessThan(0.15);
  });
});

describe('jitter meter', () => {
  it('estimates tremor σ on slow segments and ignores fast ones', () => {
    for (const sigma of [0.2, 0.6, 1.2]) {
      const rand = mulberry32(7), j = new JitterMeter(0.45);
      for (let i = 0; i < 1500; i++) { const t = i * 4; j.push(0.1 * t + sigma * gauss(rand), sigma * gauss(rand), t); }
      // J is the RMS length of the 2D residual: σ√2 for per-axis noise σ
      expect(j.value() / (sigma * Math.SQRT2)).toBeGreaterThan(0.9);
      expect(j.value() / (sigma * Math.SQRT2)).toBeLessThan(1.1);
    }
    const fast = new JitterMeter(0.45);
    for (let i = 0; i < 200; i++) fast.push(i * 8, 0, i * 4);
    expect(Number.isNaN(fast.value())).toBe(true);
  });
});
