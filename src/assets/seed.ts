/**
 * The first-run seed (DESIGN §3.0): a short Moss / Sprout pen arc that draws itself,
 * pauses while a pool swells under the virtual nib, and rises into botany. It is
 * played through the real live pipeline by app/replay.ts and never enters the
 * document or history.
 *
 * Generated procedurally (deterministic maths only) instead of shipping base64, so it
 * stays readable and tweakable. Positions are doc units at z = 1, relative to the
 * point the app places it at (the view centre, nudged up).
 */
import { dsin, dcos } from '../core/det';
import { S, PL } from '../core/types';
import type { Device, FormStyle, StrokeStyle } from '../core/types';

export interface SeedStroke {
  device: Device;
  stroke: StrokeStyle;
  form: FormStyle;
  ink: 'moss';
  /** S.STRIDE rows; x/y relative to the placement point, t = ms since down. */
  samples: Float32Array;
  /** PL.STRIDE rows with T0/T1 so replay can rise the pool on schedule. */
  pools: Float32Array;
  /** Total duration in ms (drawing + hold). */
  duration: number;
}

const HZ = 120;            // pen report rate
const DRAW_MS = 1150;      // the arc
const HOLD_MS = 1250;      // the pause that rises
const LIFT_PRESS = 0.82;

/** Ease-in-out speed profile: slow start, quick middle, settling into the hold. */
function easeArc(u: number): number {
  return u * u * (3 - 2 * u) * 0.85 + u * 0.15;
}

export function firstRunSeed(): SeedStroke {
  const dt = 1000 / HZ;
  const nDraw = Math.round(DRAW_MS / dt);
  const nHold = Math.round(HOLD_MS / dt);
  const rows = nDraw + nHold + 1;
  const out = new Float32Array(rows * S.STRIDE);

  let lastX = 0, lastY = 0, len = 0;
  for (let i = 0; i < rows; i++) {
    const t = i * dt;
    let x: number, y: number, p: number;
    if (i <= nDraw) {
      const u = easeArc(i / nDraw);
      // a lifted S-curve, ~300 sp long, drawn left to right and curling up at the end
      x = -170 + 300 * u;
      y = 34 * dsin(u * 5.2 - 0.6) - 46 * u * u + 18;
      p = 0.28 + 0.54 * dsin(Math.min(1, (i / nDraw) * 1.4) * 1.5707963267948966);
    } else {
      // holding still: sub-pixel tremor like a real hand, pressure steady
      const k = i - nDraw;
      x = lastX + 0.18 * dsin(k * 0.9);
      y = lastY + 0.15 * dcos(k * 1.3);
      p = LIFT_PRESS;
    }
    if (i > 0 && i <= nDraw) len += Math.sqrt((x - lastX) * (x - lastX) + (y - lastY) * (y - lastY));
    if (i <= nDraw) { lastX = x; lastY = y; }
    const o = i * S.STRIDE;
    out[o + S.X] = x;
    out[o + S.Y] = y;
    out[o + S.T] = t;
    out[o + S.P] = p;
    out[o + S.ALT] = 0.95;      // pen leaning ~54°
    out[o + S.AZ] = 0.75;
    out[o + S.R] = NaN;
    out[o + S.C] = 0;
    out[o + S.CS] = 0;
  }

  // One pool at the hold point: pooling starts 450 ms into the hold (pen onset) and rises at
  // 0.9 + 1.6p levels/s for the rest of it, quantised to 1/16 like a live pool.
  const t0 = DRAW_MS + 450;
  const t1 = DRAW_MS + HOLD_MS;
  const rate = 0.9 + 1.6 * LIFT_PRESS;
  const a = Math.round(((t1 - t0) / 1000) * rate * 16) / 16;
  const pools = new Float32Array(PL.STRIDE);
  pools[PL.S] = len;
  pools[PL.A] = a;
  pools[PL.T0] = t0;
  pools[PL.T1] = t1;

  return {
    device: 'pen',
    stroke: { nib: 'brush', size: 9 },
    form: { form: 'sprout', v: 1, base: 2 },
    ink: 'moss',
    samples: out,
    pools,
    duration: t1,
  };
}
