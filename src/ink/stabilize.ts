/**
 * Stabiliser: a causal One Euro filter on sp positions (DESIGN §2.2.2) and the
 * hand-jitter meter that feeds the learner.
 *
 * The filter uses no transcendentals: α = 1/(1 + 1/(2π·fc·dt)). Its cutoff is
 * fc = fcMin + β·|v| with v in sp/s, estimated from the RAW derivative (as in
 * Casiez's reference C++), low-passed at D_CUTOFF. The end flush (the raw lift
 * point appended at lift) lives in the spine builder.
 */
import type { Calib, Device } from '../core/types';
import { TAU } from '../core/det';

/** Derivative cutoff, Hz. Decision: 5 Hz (not the paper's 1 Hz) so the cutoff tracks a hand that accelerates out of a stroke start within ~50 ms. */
export const D_CUTOFF = 5;
/** β per device, per (sp/s). */
export const BETA: Record<Device, number> = { pen: 0.020, mouse: 0.010, touch: 0.008 };
const FC_FALLBACK: Record<Device, number> = { pen: 3.5, mouse: 2.0, touch: 1.5 };

/** Filter parameters for a stroke: fcMin comes from its calib snapshot (derived from J for pens). */
export function oneEuroParams(device: Device, calib: Calib): { fcMin: number; beta: number } {
  const f = calib.fcMin;
  return { fcMin: f > 0 && f < 1e3 ? f : FC_FALLBACK[device], beta: BETA[device] };
}

/** Smoothing factor for cutoff fc (Hz) over dt (ms). */
export function euroAlpha(fc: number, dtMs: number): number {
  return 1 / (1 + 1000 / (TAU * fc * dtMs));
}

/** Two-axis One Euro filter sharing one speed-driven cutoff, so x and y are smoothed alike. */
export class OneEuro {
  /** Filtered position (sp). */
  x = 0; y = 0;
  /** Smoothed velocity estimate (sp/ms). */
  dx = 0; dy = 0;
  /** Last raw position and time. */
  rx = 0; ry = 0; t = 0;
  has = false;

  constructor(public fcMin: number, public beta: number, public dcut = D_CUTOFF) {}

  reset(): void { this.has = false; this.x = this.y = this.dx = this.dy = this.rx = this.ry = this.t = 0; }

  copyFrom(o: OneEuro): void {
    this.fcMin = o.fcMin; this.beta = o.beta; this.dcut = o.dcut;
    this.x = o.x; this.y = o.y; this.dx = o.dx; this.dy = o.dy;
    this.rx = o.rx; this.ry = o.ry; this.t = o.t; this.has = o.has;
  }

  /** Seed the velocity estimate (resumed split pieces start with a warm cutoff). */
  seedVelocity(dx: number, dy: number): void { this.dx = dx; this.dy = dy; }

  /**
   * Time constant τ = 1/(2π·fc) (ms) of the position filter at its current cutoff.
   * Steady motion at speed v lags exactly v·τ behind the raw input (the discrete
   * filter's steady-state error is v·dt·(1 − α)/α = v/(2π·fc)).
   */
  lagMs(): number {
    const fc = this.fcMin + this.beta * Math.sqrt(this.dx * this.dx + this.dy * this.dy) * 1000;
    return 1000 / (TAU * fc);
  }

  /** Feed one raw sample (sp, ms). The first sample passes through unchanged. */
  step(x: number, y: number, t: number): void {
    if (!this.has) {
      this.has = true;
      this.x = this.rx = x; this.y = this.ry = y; this.t = t;
      return;
    }
    let dt = t - this.t;
    if (!(dt > 1e-3)) dt = 1e-3; // sanitised t is strictly increasing; guard anyway
    const ad = euroAlpha(this.dcut, dt);
    this.dx += ad * ((x - this.rx) / dt - this.dx);
    this.dy += ad * ((y - this.ry) / dt - this.dy);
    const speed = Math.sqrt(this.dx * this.dx + this.dy * this.dy) * 1000;
    const a = euroAlpha(this.fcMin + this.beta * speed, dt);
    this.x += a * (x - this.x);
    this.y += a * (y - this.y);
    this.rx = x; this.ry = y; this.t = t;
  }
}

/**
 * Jitter meter (learned J, DESIGN §2.2.2). Decision: "RMS of raw − filtered"
 * measured against the causal filter is dominated by its lag, so the residual is
 * taken against a zero-lag local fit instead: each raw sample minus the time-
 * interpolated midpoint of its two neighbours, on slow segments (v_n < 0.5).
 * For white noise that residual has 1.5× the noise variance, which is divided out.
 * J is the RMS LENGTH of the 2D residual (σ√2 for isotropic per-axis noise σ), the
 * literal "RMS of raw − filtered"; J = median over windows of 16 residuals of the
 * window RMS (robust to outliers).
 */
export class JitterMeter {
  private n = 0;
  private x0 = 0; private y0 = 0; private t0 = 0;
  private x1 = 0; private y1 = 0; private t1 = 0;
  private sum = 0; private cnt = 0;
  private wins: number[] = [];

  constructor(private vSlow: number) {}

  reset(vSlow = this.vSlow): void { this.vSlow = vSlow; this.n = 0; this.sum = 0; this.cnt = 0; this.wins.length = 0; }

  /** Feed one raw sample in sp / ms. */
  push(x: number, y: number, t: number): void {
    if (this.n >= 2) {
      const span = t - this.t0;
      if (span > 0 && span <= 50) {
        const ex = x - this.x0, ey = y - this.y0;
        const v = Math.sqrt(ex * ex + ey * ey) / span;
        if (v < this.vSlow) {
          const f = (this.t1 - this.t0) / span;
          const px = this.x0 + ex * f, py = this.y0 + ey * f;
          const rx = this.x1 - px, ry = this.y1 - py;
          this.sum += rx * rx + ry * ry;
          if (++this.cnt === 16) { this.wins.push(Math.sqrt(this.sum / (16 * 1.5))); this.sum = 0; this.cnt = 0; }
        }
      }
    }
    this.x0 = this.x1; this.y0 = this.y1; this.t0 = this.t1;
    this.x1 = x; this.y1 = y; this.t1 = t;
    this.n++;
  }

  /** Measured J (sp), or NaN when the stroke had too few slow samples. */
  value(): number {
    const w = this.wins.slice();
    if (this.cnt >= 6) w.push(Math.sqrt(this.sum / (this.cnt * 1.5)));
    if (w.length === 0) return NaN;
    w.sort((a, b) => a - b);
    const m = w.length >> 1;
    return w.length & 1 ? w[m] : 0.5 * (w[m - 1] + w[m]);
  }
}
