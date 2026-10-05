/**
 * Pointer events -> InputSample (DESIGN §2.2.2 "Per sample", "Latency"; §5
 * "Coalesced events", "Allocation"; §7.5 rule 9).
 *
 *  - Coalesced samples via `getCoalescedEvents?.()`, falling back to the event itself
 *    (also when the list is empty, as it is for untrusted events).
 *  - Timestamps sanitised to be strictly increasing: t_i = max(e.timeStamp, t_{i−1} + 0.25).
 *  - Predicted samples from `getPredictedEvents?.()`, else a line fit through the last
 *    3 samples; capped at 16 ms and 24 sp past the last real sample; never stored.
 *  - No allocation per event in steady state: samples are pooled objects and the
 *    arrays handed to the sink are cached per length (the browser's own coalesced /
 *    predicted arrays are excused by §5).
 *
 * The reader works on a structural PointerLike, so it runs under Node in tests.
 */
import type { Device, InputSample } from '../core/types';

/** Minimum step between consecutive sanitised timestamps, ms. */
export const MIN_DT = 0.25;
/** Prediction horizon cap, ms. */
export const PREDICT_MS = 16;
/** Prediction distance cap, sp (CSS px at the stroke's zoom). */
export const PREDICT_SP = 24;
/** At most this many predicted samples per event. */
export const MAX_PREDICTED = 4;
/**
 * Coalesced samples are delivered to the sink in chunks of at most this many, so the
 * per-length array cache stays small even after a long main-thread stall.
 */
export const CHUNK = 64;

const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;

/** The subset of PointerEvent the reader uses. */
export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly width: number;
  readonly height: number;
  readonly altitudeAngle?: number;
  readonly azimuthAngle?: number;
  getCoalescedEvents?(): ArrayLike<PointerLike>;
  getPredictedEvents?(): ArrayLike<PointerLike>;
}

/** Strictly increasing timestamp: max(t, prev + 0.25). Non-finite t falls back to prev + 0.25 (or 0 at the start). */
export function sanitizeTime(prev: number, t: number): number {
  const min = prev + MIN_DT;
  if (Number.isFinite(t) && !(t < min)) return t;
  return Number.isFinite(min) ? min : Number.isFinite(t) ? t : 0;
}

/** A fresh sample with the "unknown" defaults. */
export function newSample(): InputSample {
  return { x: 0, y: 0, t: 0, p: NaN, alt: HALF_PI, az: 0, r: NaN, predicted: false };
}

/** Copy every field of `a` into `b`. */
export function copySample(a: InputSample, b: InputSample): void {
  b.x = a.x; b.y = a.y; b.t = a.t; b.p = a.p; b.alt = a.alt; b.az = a.az; b.r = a.r; b.predicted = a.predicted;
}

/**
 * Pen tilt (degrees, −90..90) -> altitude / azimuth (radians), per the Pointer Events
 * spec conversion. Writes into `out`. tiltX = tiltY = 0 gives alt = π/2, az = 0.
 */
export function tiltToAltAz(tiltX: number, tiltY: number, out: { alt: number; az: number }): void {
  const ax = Math.abs(tiltX), ay = Math.abs(tiltY);
  const tx = tiltX * DEG, ty = tiltY * DEG;
  let az = 0;
  if (tiltX === 0) az = tiltY > 0 ? HALF_PI : tiltY < 0 ? 3 * HALF_PI : 0;
  else if (tiltY === 0) az = tiltX < 0 ? Math.PI : 0;
  else if (ax === 90 || ay === 90) az = 0;
  else {
    az = Math.atan2(Math.tan(ty), Math.tan(tx));
    if (az < 0) az += 2 * Math.PI;
  }
  let alt: number;
  if (ax === 90 || ay === 90) alt = 0;
  else if (tiltX === 0) alt = HALF_PI - Math.abs(ty);
  else if (tiltY === 0) alt = HALF_PI - Math.abs(tx);
  else {
    const a = Math.tan(tx), b = Math.tan(ty);
    alt = Math.atan(1 / Math.sqrt(a * a + b * b));
  }
  out.alt = alt;
  out.az = az;
}

/** Palm-test radius: half the larger contact extent (CSS px); NaN when the device reports none (≤ 1 px). */
export function contactRadius(width: number, height: number): number {
  return width > 1 || height > 1 ? Math.max(width, height) / 2 : NaN;
}

/** Fill `s` from one event (position, pressure, angles, radius). Leaves `t` to the caller. */
export function fillSample(s: InputSample, e: PointerLike, device: Device): void {
  s.x = e.clientX;
  s.y = e.clientY;
  s.predicted = false;
  if (device === 'pen') {
    const p = e.pressure;
    s.p = p > 1 ? 1 : p >= 0 ? p : 0;
    const ae = e.altitudeAngle, az = e.azimuthAngle;
    const tilted = e.tiltX !== 0 || e.tiltY !== 0;
    // Prefer the native angles, unless they are the untilted default while tilt says otherwise.
    if (typeof ae === 'number' && typeof az === 'number' && Number.isFinite(ae) && Number.isFinite(az) &&
        !(tilted && ae === HALF_PI && az === 0)) {
      s.alt = ae;
      s.az = az;
    } else tiltToAltAz(e.tiltX || 0, e.tiltY || 0, s);
  } else {
    s.p = NaN; // mouse, trackpad and finger pressure is synthesised from speed at cook time
    s.alt = HALF_PI;
    s.az = 0;
  }
  // Mean contact radius for touches that report geometry; NaN otherwise.
  s.r = device === 'touch' && (e.width > 1 || e.height > 1) ? (e.width + e.height) / 4 : NaN;
}

const NONE: readonly InputSample[] = Object.freeze([]) as readonly InputSample[];

/**
 * Pooled samples plus one cached array per length: `view(n)` always returns the same
 * array object for the same n, holding the first n pooled samples.
 */
export class SampleBatch {
  private readonly pool: InputSample[] = [];
  private readonly views: (InputSample[] | undefined)[] = [];

  /** The i-th pooled sample (grows the pool on first use). */
  at(i: number): InputSample {
    const pool = this.pool;
    while (pool.length <= i) pool.push(newSample());
    return pool[i];
  }

  /** Array of the first n pooled samples (cached; do not mutate). */
  view(n: number): readonly InputSample[] {
    if (n <= 0) return NONE;
    let v = this.views[n];
    if (!v) {
      this.at(n - 1);
      v = this.pool.slice(0, n);
      this.views[n] = v;
    }
    return v;
  }
}

/**
 * Stateful reader for one input element. Stroke samples share one sanitiser clock
 * (`lastT`), so every sample the sink receives for a stroke is strictly later than
 * the previous one. Non-stroke reads keep the raw event time.
 */
export class PointerReader {
  /** Sanitiser state: time of the last sanitised sample. */
  lastT = -Infinity;
  /** Single-event sample (down / up / hover), reused. */
  readonly one: InputSample = newSample();
  private readonly batch = new SampleBatch();
  private readonly pred = new SampleBatch();
  private readonly tip: InputSample = newSample(); // last real stroke sample
  private readonly hx = new Float64Array(3);
  private readonly hy = new Float64Array(3);
  private readonly ht = new Float64Array(3);
  private hn = 0;
  private hi = 0;
  private list: ArrayLike<PointerLike> | null = null;
  private src: PointerLike | null = null;

  /** Read one event into `one`. `sanitize` puts it on the stroke clock. */
  readOne(e: PointerLike, device: Device, sanitize: boolean): InputSample {
    const s = this.one;
    fillSample(s, e, device);
    s.t = sanitize ? (this.lastT = sanitizeTime(this.lastT, e.timeStamp)) : e.timeStamp;
    return s;
  }

  /** Start a stroke's prediction history at `s` (its first sample). */
  restart(s: InputSample): void {
    this.hn = 0;
    this.hi = 0;
    this.remember(s);
  }

  /** Prepare a move event; returns how many coalesced samples it carries (≥ 1). */
  begin(e: PointerLike): number {
    const co = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    this.src = e;
    if (co && co.length > 0) {
      this.list = co;
      return co.length;
    }
    this.list = null;
    return 1;
  }

  /**
   * Samples [i0, i1) of the prepared event (i1 − i0 ≤ CHUNK). `stroke` sanitises the
   * times and feeds the fallback predictor. The returned array is reused.
   */
  chunk(i0: number, i1: number, device: Device, stroke: boolean): readonly InputSample[] {
    const b = this.batch, list = this.list;
    let k = 0;
    for (let i = i0; i < i1; i++) {
      const e = list ? list[i] : this.src;
      if (!e) continue;
      const s = b.at(k++);
      fillSample(s, e, device);
      if (stroke) {
        s.t = this.lastT = sanitizeTime(this.lastT, e.timeStamp);
        this.remember(s);
      } else s.t = e.timeStamp;
    }
    return b.view(k);
  }

  /** Predicted tail of the prepared event, capped at 16 ms and 24 sp past the last stroke sample. */
  predict(device: Device): readonly InputSample[] {
    const src = this.src;
    if (!src || this.hn === 0) return NONE;
    const pe = typeof src.getPredictedEvents === 'function' ? src.getPredictedEvents() : null;
    if (pe && pe.length > 0) return this.fromEvents(pe, device);
    return this.lineFit();
  }

  /** Drop references to the browser's event objects. */
  end(): void {
    this.list = null;
    this.src = null;
  }

  private remember(s: InputSample): void {
    const i = this.hi;
    this.hx[i] = s.x;
    this.hy[i] = s.y;
    this.ht[i] = s.t;
    this.hi = (i + 1) % 3;
    if (this.hn < 3) this.hn++;
    copySample(s, this.tip);
  }

  private fromEvents(pe: ArrayLike<PointerLike>, device: Device): readonly InputSample[] {
    const tip = this.tip;
    let m = 0, prevT = tip.t;
    for (let i = 0; i < pe.length && m < MAX_PREDICTED; i++) {
      const q = pe[i];
      const s = this.pred.at(m);
      fillSample(s, q, device);
      s.predicted = true;
      if (device === 'pen' && !(s.p > 0)) s.p = tip.p;
      const dx = s.x - tip.x, dy = s.y - tip.y;
      const d = Math.hypot(dx, dy);
      const dt = (Number.isFinite(q.timeStamp) ? q.timeStamp : prevT + MIN_DT) - tip.t;
      let k = 1;
      if (dt > PREDICT_MS) k = PREDICT_MS / dt;
      if (d * k > PREDICT_SP) k = PREDICT_SP / d;
      if (k < 1) {
        s.x = tip.x + dx * k;
        s.y = tip.y + dy * k;
        s.t = sanitizeTime(prevT, tip.t + dt * k);
        m++;
        break;
      }
      s.t = prevT = sanitizeTime(prevT, tip.t + dt);
      m++;
    }
    return this.pred.view(m);
  }

  /** Least-squares velocity through the last 3 samples, extrapolated to the caps. */
  private lineFit(): readonly InputSample[] {
    if (this.hn < 3) return NONE;
    const hx = this.hx, hy = this.hy, ht = this.ht;
    const tm = (ht[0] + ht[1] + ht[2]) / 3, xm = (hx[0] + hx[1] + hx[2]) / 3, ym = (hy[0] + hy[1] + hy[2]) / 3;
    let stt = 0, stx = 0, sty = 0;
    for (let i = 0; i < 3; i++) {
      const dt = ht[i] - tm;
      stt += dt * dt;
      stx += dt * (hx[i] - xm);
      sty += dt * (hy[i] - ym);
    }
    if (stt < 1e-6) return NONE;
    const vx = stx / stt, vy = sty / stt;
    const v = Math.hypot(vx, vy);
    if (v * PREDICT_MS < 0.5) return NONE; // nearly still: nothing worth drawing ahead
    const h = v * PREDICT_MS > PREDICT_SP ? PREDICT_SP / v : PREDICT_MS;
    const tip = this.tip, s = this.pred.at(0);
    copySample(tip, s);
    s.x = tip.x + vx * h;
    s.y = tip.y + vy * h;
    s.t = sanitizeTime(tip.t, tip.t + h);
    s.predicted = true;
    return this.pred.view(1);
  }
}
