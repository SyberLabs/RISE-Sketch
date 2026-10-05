/**
 * Rise (DESIGN §3.1): hold still, and the ink pools.
 *
 * A pure state machine stepped every rAF while the contact is down, on the rAF
 * clock and on FILTERED positions (a still mouse or pen sends no events).
 *
 *   moving ─(still ≥ pre)─► prehalo ─(still ≥ pool)─► pooling ⇄ paused ⇄ settling
 *                                                        └──► ceiling (brim flash)
 *   any hold phase ─(moved > move-on from the hold point)─► moving (pool frozen)
 *
 * Decisions (documented in the report):
 *  - "Still" = every filtered position of the trailing 120 ms lies within the still
 *    radius of the current one (a displacement test: frame-rate independent and
 *    immune to the filter's residual tremor). Stillness is dated from the start of
 *    that window, so the pre-halo / pooling onsets are measured from the stop.
 *  - The jitter factor jf scales the distance thresholds only, not the onset times.
 *  - A hold at the exact arc of an existing pool (|Δs| < 0.5 sp) continues that row;
 *    a 33rd hold continues the nearest row (its arc unchanged).
 */
import type { Calib, Device, PoolBuf } from '../core/types';
import { PL } from '../core/types';
import { clamp01 } from '../core/num';
import { kernel, MAX_POOLS, POOL_AHEAD, POOL_BACK } from './depth';
import { jitterFactor } from './signals';

/** One rAF step of the contact. */
export interface RiseInput {
  x: number; y: number;  // filtered tip, sp (i.e. CSS px at the stroke's zoom)
  s: number;             // arc length at the tip, sp
  p: number;             // calibrated pressure (synthesised ≈0.9 for a still mouse)
  now: number;           // ms since pen-down on the rAF clock
  travel: number;        // total travel so far, sp
}
/** Hold state: moving (incl. waiting out the pre-halo onset), then the hold phases. */
export type RisePhase = 'moving' | 'prehalo' | 'pooling' | 'settling' | 'paused' | 'ceiling';
/** Step result. The object (and its `changed` / `hold` members) is reused: valid until the next step. */
export interface RiseOut {
  phase: RisePhase;
  pre: number;           // 0..1 pre-halo fade
  level: number;         // local depth d(s_i) (base + pool) at the hold point
  brim: boolean;         // true on the step the ceiling is reached
  changed: { s0: number; s1: number } | null;  // pool window changed: regrow this arc range
  hold: { x: number; y: number; s: number } | null;
}
/** One stroke's hold detector and pool integrator. */
export interface Rise {
  /** Called every rAF while the contact is down. May grow pools.data (replace the array). */
  step(inp: RiseInput, pools: PoolBuf, base: number, ceiling: (s: number) => number): RiseOut;
  /** Lift guard: restore pools to their state at tUp − 60 ms (ms since down). */
  liftGuard(pools: PoolBuf, tUp: number): void;
  readonly rose: boolean;
}

/** Hold thresholds per device (distances in sp, before × jf; times in ms). */
export const HOLD: Record<Device, { still: number; move: number; pre: number; pool: number; gate: boolean }> = {
  pen: { still: 1.5, move: 3, pre: 250, pool: 450, gate: true },
  mouse: { still: 1.0, move: 3, pre: 350, pool: 600, gate: false },
  touch: { still: 4, move: 8, pre: 350, pool: 600, gate: false },
};
/** Trailing window of the still test (ms). */
export const STILL_WINDOW_MS = 120;
/** Lift guard: pools are taken as they stood this long before lift (ms). */
export const LIFT_GUARD_MS = 60;
/** A hold before this much travel blooms at s = 0 (sp). */
export const BLOOM_TRAVEL = 6;
/** Pen pressure gate: rise needs p ≥ 0.8·p₀; Settle below 0.5·p₀; pause between. */
export const RISE_GATE = 0.8, SETTLE_GATE = 0.5;
/** Settle drain rate, levels per second. */
export const SETTLE_RATE = 0.8;
/** Pooling rate, levels per second: 0.9 + 1.6·p. */
export const poolRate = (p: number): number => 0.9 + 1.6 * clamp01(p);

const HIST = 256;
const JOURNAL = 128;

class RiseImpl implements Rise {
  private readonly still: number;
  private readonly move: number;
  private readonly preT: number;
  private readonly poolT: number;
  private readonly gate: boolean;

  // trailing history (ring)
  private readonly ht = new Float64Array(HIST);
  private readonly hx = new Float64Array(HIST);
  private readonly hy = new Float64Array(HIST);
  private readonly hp = new Float64Array(HIST);
  private readonly htr = new Float64Array(HIST);
  private hHead = 0; private hCount = 0; private hTotal = 0;

  private phase: RisePhase = 'moving';
  private stillStart = -1;
  private p0 = 0;
  private holdX = 0; private holdY = 0; private holdS = 0;
  private poolIdx = -1;
  private aCont = 0;
  private lastNow = 0;
  private stepped = false;
  private roseFlag = false;

  // journal of pool-row edits for the lift guard
  private readonly jt = new Float64Array(JOURNAL);
  private readonly ji = new Int32Array(JOURNAL);
  private readonly ja = new Float64Array(JOURNAL);
  private readonly j1 = new Float64Array(JOURNAL);
  private readonly jn = new Int32Array(JOURNAL);   // -1: edit; ≥ 0: row created, n before
  private jHead = 0; private jCount = 0;

  private readonly out: RiseOut = { phase: 'moving', pre: 0, level: 0, brim: false, changed: null, hold: null };
  private readonly chg = { s0: 0, s1: 0 };
  private readonly hold = { x: 0, y: 0, s: 0 };

  constructor(device: Device, calib: Calib) {
    const h = HOLD[device], jf = jitterFactor(calib.jitter);
    this.still = h.still * jf; this.move = h.move * jf;
    this.preT = h.pre; this.poolT = h.pool; this.gate = h.gate;
  }

  get rose(): boolean { return this.roseFlag; }

  private record(now: number, x: number, y: number, p: number, travel: number): void {
    const i = this.hHead;
    this.ht[i] = now; this.hx[i] = x; this.hy[i] = y; this.hp[i] = p; this.htr[i] = travel;
    this.hHead = (i + 1) % HIST;
    if (this.hCount < HIST) this.hCount++;
    this.hTotal++;
  }

  /** Still test over the trailing window; returns the window start (stillness date) or -1. */
  private stillSince(now: number, x: number, y: number): number {
    const from = now - STILL_WINDOW_MS;
    if (from < 0) return -1;
    const r2 = this.still * this.still;
    let covered = false;
    for (let k = 1; k <= this.hCount; k++) {
      const i = (this.hHead - k + HIST) % HIST;
      const dx = this.hx[i] - x, dy = this.hy[i] - y;
      if (dx * dx + dy * dy > r2) return -1;
      if (this.ht[i] <= from) { covered = true; break; }
    }
    if (!covered) {
      // the history starts at the first step: before it the tip sat at its first position
      // only if it had not travelled yet (a stroke that steps from its first rAF)
      if (this.hTotal > this.hCount) return -1;
      const oldest = (this.hHead - this.hCount + HIST) % HIST;
      if (!(this.htr[oldest] < this.still)) return -1;
    }
    return from;
  }

  private pressureAt(t: number): number {
    for (let k = 1; k <= this.hCount; k++) {
      const i = (this.hHead - k + HIST) % HIST;
      if (this.ht[i] <= t) return this.hp[i];
    }
    return this.hp[(this.hHead - this.hCount + HIST) % HIST];
  }

  private journal(now: number, idx: number, prevA: number, prevT1: number, createdFromN: number): void {
    const i = this.jHead;
    this.jt[i] = now; this.ji[i] = idx; this.ja[i] = prevA; this.j1[i] = prevT1; this.jn[i] = createdFromN;
    this.jHead = (i + 1) % JOURNAL;
    if (this.jCount < JOURNAL) this.jCount++;
  }

  private depthAt(pools: PoolBuf, base: number, s: number): number {
    const d = pools.data;
    let m = 0;
    for (let i = 0; i < pools.n; i++) {
      const o = i * PL.STRIDE, a = d[o + PL.A];
      if (a <= m) continue;
      const v = a * kernel(s - d[o + PL.S]);
      if (v > m) m = v;
    }
    return base + m;
  }

  private startPool(pools: PoolBuf, base: number, now: number): void {
    const s = this.holdS, d = pools.data;
    let idx = -1, near = -1, nd = Infinity;
    for (let i = 0; i < pools.n; i++) {
      const ds = Math.abs(d[i * PL.STRIDE + PL.S] - s);
      if (ds < 0.5) idx = i;
      if (ds < nd) { nd = ds; near = i; }
    }
    const local = Math.max(0, this.depthAt(pools, base, s) - base);
    if (idx < 0 && pools.n >= MAX_POOLS) {
      idx = near;
      this.aCont = d[idx * PL.STRIDE + PL.A];
    } else if (idx >= 0) {
      this.aCont = Math.max(d[idx * PL.STRIDE + PL.A], local);
    } else {
      const n = pools.n;
      if ((n + 1) * PL.STRIDE > pools.data.length) {
        const g = new Float32Array(Math.max(8 * PL.STRIDE, pools.data.length * 2));
        g.set(pools.data.subarray(0, n * PL.STRIDE));
        pools.data = g;
      }
      const o = n * PL.STRIDE, q = Math.round(local * 16) / 16;
      pools.data[o + PL.S] = s; pools.data[o + PL.A] = q; pools.data[o + PL.T0] = now; pools.data[o + PL.T1] = now;
      this.journal(now, n, 0, 0, n);
      pools.n = n + 1;
      idx = n;
      this.aCont = local;
    }
    this.poolIdx = idx;
  }

  /** Store the continuous level into the row (quantised); returns true if the stored value changed. */
  private store(pools: PoolBuf, now: number, maxA: number): boolean {
    const o = this.poolIdx * PL.STRIDE, d = pools.data;
    let q = Math.round(this.aCont * 16) / 16;
    // the ceiling stops rising; it never lowers a row below what it already holds
    if (q > maxA + 1e-9) q = Math.max(Math.floor(maxA * 16) / 16, Math.min(q, d[o + PL.A]));
    if (q === d[o + PL.A]) return false;
    this.journal(now, this.poolIdx, d[o + PL.A], d[o + PL.T1], -1);
    d[o + PL.A] = q; d[o + PL.T1] = now;
    if (q > 0) this.roseFlag = true;
    return true;
  }

  step(inp: RiseInput, pools: PoolBuf, base: number, ceiling: (s: number) => number): RiseOut {
    const out = this.out, now = inp.now;
    out.brim = false; out.changed = null;
    // a non-finite tip or clock is ignored (it must never read as "still" or reach a pool row)
    if (!(now - now === 0 && inp.x - inp.x === 0 && inp.y - inp.y === 0 && inp.s - inp.s === 0)) return out;
    if (!(base - base === 0)) base = 0;
    // unknown pressure reads as 0.6, as calibratePressure(NaN) does
    const pIn = inp.p === inp.p ? inp.p : 0.6;
    const dt = this.stepped ? Math.max(0, now - this.lastNow) : 0;
    this.stepped = true; this.lastNow = now;
    this.record(now, inp.x, inp.y, pIn, inp.travel);

    if (this.phase !== 'moving') {
      const dx = inp.x - this.holdX, dy = inp.y - this.holdY;
      if (dx * dx + dy * dy > this.move * this.move) {
        // move on: the pool freezes where it stood
        this.phase = 'moving'; this.stillStart = -1; this.poolIdx = -1;
      }
    }

    if (this.phase === 'moving') {
      const since = this.stillSince(now, inp.x, inp.y);
      if (since < 0) this.stillStart = -1;
      else if (this.stillStart < 0) { this.stillStart = since; this.p0 = this.pressureAt(since); }
      if (this.stillStart >= 0 && now - this.stillStart >= this.preT) {
        this.phase = 'prehalo';
        this.holdX = inp.x; this.holdY = inp.y;
        this.holdS = inp.travel < BLOOM_TRAVEL ? 0 : inp.s;
      }
    }

    let poolDt = dt, started = false;
    if (this.phase === 'prehalo') {
      const el = now - this.stillStart;
      if (el >= this.poolT) {
        this.startPool(pools, base, now);
        started = true;
        this.phase = 'pooling';
        poolDt = Math.min(dt, el - this.poolT);
      }
    }

    if (this.poolIdx >= 0 && this.phase !== 'moving' && this.phase !== 'prehalo') {
      const s = pools.data[this.poolIdx * PL.STRIDE + PL.S];
      // decision: a NaN ceiling (a broken callback) means no cap from it, never a NaN pool row
      const c = ceiling(s);
      const maxA = (c === c ? c : Infinity) - base;
      let mode: 'rise' | 'settle' | 'pause' = 'rise';
      if (this.gate) {
        mode = pIn >= RISE_GATE * this.p0 ? 'rise' : pIn < SETTLE_GATE * this.p0 ? 'settle' : 'pause';
      }
      if (mode === 'rise') {
        if (this.aCont >= maxA - 1e-9) {
          // a pool that starts at the ceiling flashes once; otherwise the flash belongs to the crossing step
          if (started) out.brim = true;
          this.phase = 'ceiling';
        } else {
          this.aCont = Math.min(this.aCont + poolRate(pIn) * poolDt / 1000, maxA);
          if (this.aCont >= maxA - 1e-9) { this.phase = 'ceiling'; out.brim = true; } else this.phase = 'pooling';
        }
      } else if (mode === 'settle') {
        this.aCont = Math.max(0, this.aCont - SETTLE_RATE * poolDt / 1000);
        this.phase = 'settling';
      } else this.phase = 'paused';
      if (this.store(pools, now, maxA)) {
        this.chg.s0 = s - POOL_BACK; this.chg.s1 = s + POOL_AHEAD;
        out.changed = this.chg;
      }
    }

    out.phase = this.phase;
    out.pre = this.phase === 'moving' ? 0 : this.phase === 'prehalo'
      ? clamp01((now - this.stillStart - this.preT) / (this.poolT - this.preT)) : 1;
    if (this.phase === 'moving') {
      out.hold = null;
      out.level = this.depthAt(pools, base, inp.s);
    } else {
      const s = this.poolIdx >= 0 ? pools.data[this.poolIdx * PL.STRIDE + PL.S] : this.holdS;
      this.hold.x = this.holdX; this.hold.y = this.holdY; this.hold.s = s;
      out.hold = this.hold;
      out.level = this.depthAt(pools, base, s);
    }
    return out;
  }

  liftGuard(pools: PoolBuf, tUp: number): void {
    const cut = tUp - LIFT_GUARD_MS, d = pools.data;
    while (this.jCount > 0) {
      const i = (this.jHead - 1 + JOURNAL) % JOURNAL;
      if (!(this.jt[i] > cut)) break;
      const idx = this.ji[i];
      if (this.jn[i] >= 0) pools.n = this.jn[i];
      else if (idx < pools.n) { d[idx * PL.STRIDE + PL.A] = this.ja[i]; d[idx * PL.STRIDE + PL.T1] = this.j1[i]; }
      this.jHead = i; this.jCount--;
    }
    let rose = false;
    for (let i = 0; i < pools.n; i++) if (d[i * PL.STRIDE + PL.A] > 0) rose = true;
    this.roseFlag = rose;
    this.phase = 'moving'; this.poolIdx = -1; this.stillStart = -1;
  }
}

/** Hold detector for one stroke (thresholds from its device class and calib.jitter). */
export function createRise(device: Device, calib: Calib): Rise {
  return new RiseImpl(device, calib);
}
