/** app/replay.ts timeline and export/png.ts framing (DESIGN §8). */
import { describe, it, expect } from 'vitest';
import type { StrokeRecipe } from '../src/core/types';
import { PL, S } from '../src/core/types';
import { DEFAULT_CALIB } from '../src/ink/calib';
import { freezeRecipe } from '../src/doc/commands';
import { GAP_CAP_MS, MIN_SPEED, TARGET_MS, strokeDuration, timeline } from '../src/app/replay';
import { PIXEL_CAPS, exportFilename, exportFrame } from '../src/export/png';

function stroke(created: number, ms: number, poolT1 = 0): StrokeRecipe {
  const samples = new Float32Array(2 * S.STRIDE);
  samples[S.STRIDE + S.X] = 10; samples[S.STRIDE + S.T] = ms;
  const pools = poolT1 ? new Float32Array(PL.STRIDE) : new Float32Array(0);
  if (poolT1) { pools[PL.A] = 1; pools[PL.T1] = poolT1; }
  return freezeRecipe({
    id: `${created}`, created, origin: [0, 0], z: 1, rot: 0, seed: 1, device: 'pen', calib: DEFAULT_CALIB.pen,
    stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null }, form: { form: 'line', v: 1, base: 0 },
    s0: 0, cut: 0, resume: null, samples, pools, closed: false, radial: false, sym: null, xf: null,
  });
}

describe('replay timeline', () => {
  it('stroke duration is the last sample, or a later pool edit', () => {
    expect(strokeDuration(stroke(0, 400))).toBe(400);
    expect(strokeDuration(stroke(0, 400, 900))).toBe(900);
  });

  it('runs at least 1.5× real time with gaps capped at 250 ms', () => {
    const rs = [stroke(0, 1000), stroke(5000, 1000), stroke(6100, 1000)];
    const t = timeline(rs);
    expect(t.k).toBe(MIN_SPEED);
    // 1000 + 250 (capped) + 1000 + 100 + 1000 = 3350 ms real, at 1.5×
    expect(t.total).toBeCloseTo(3350 / 1.5, 6);
    expect(Array.from(t.starts)).toEqual([0, 1250 / 1.5, 2350 / 1.5]);
  });

  it('compresses a long drawing toward 18 s', () => {
    const rs: StrokeRecipe[] = [];
    for (let i = 0; i < 60; i++) rs.push(stroke(i * 10000, 1000));
    const t = timeline(rs);
    const real = 60 * 1000 + 59 * GAP_CAP_MS;
    expect(t.k).toBeCloseTo(real / TARGET_MS, 9);
    expect(t.total).toBeCloseTo(TARGET_MS, 6);
  });

  it('treats a missing created time as a capped gap', () => {
    const t = timeline([stroke(NaN, 100), stroke(NaN, 100)]);
    expect(t.starts[1] * t.k).toBe(100 + GAP_CAP_MS);
  });
});

describe('export framing', () => {
  const cam = { cx: 0, cy: 0, scale: 1, rot: 0 };

  it('adds a 6 % margin and scales the long edge toward 3000 px, at most 4×', () => {
    const f = exportFrame({ x0: 0, y0: 0, x1: 500, y1: 100 }, cam, 'desktop');
    expect(f.box.x0).toBeCloseTo(-30); expect(f.box.y0).toBeCloseTo(-30);
    expect(f.k).toBe(4);
    expect(f.width).toBe(Math.ceil(560 * 4));
    expect(f.height).toBe(Math.ceil(160 * 4));
    const g = exportFrame({ x0: 0, y0: 0, x1: 4000, y1: 100 }, cam, 'desktop');
    expect(g.k).toBe(1);
    expect(g.pxPerDoc).toBe(1);
  });

  it('follows the camera scale and never exceeds the device pixel cap', () => {
    const f = exportFrame({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, { ...cam, scale: 2 }, 'phone');
    expect(f.width * f.height).toBeLessThanOrEqual(PIXEL_CAPS.phone * 1.01);
    expect(f.pxPerDoc).toBeLessThan(2 * f.k);
    const g = exportFrame({ x0: 0, y0: 0, x1: 100, y1: 100 }, { ...cam, scale: 2 }, 'phone');
    expect(g.pxPerDoc).toBe(8); // 2 × k, k = 4
  });

  it('names the file rise-YYYYMMDD-HHMM.png in local time', () => {
    expect(exportFilename(new Date(2026, 9, 5, 7, 3))).toBe('rise-20261005-0703.png');
  });
});
