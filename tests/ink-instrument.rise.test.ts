import { describe, it, expect } from 'vitest';
import type { Device, PoolBuf } from '../src/core/types';
import { PL } from '../src/core/types';
import { createRise, HOLD, poolRate, type Rise, type RiseInput, type RisePhase } from '../src/ink/rise';
import { DEFAULT_CALIB } from '../src/ink/calib';

interface Frame { t: number; phase: RisePhase; pre: number; level: number; brim: boolean; changed: [number, number] | null; hold: [number, number, number] | null; n: number; a: number }

const pools = (cap = 4): PoolBuf => ({ data: new Float32Array(cap * PL.STRIDE), n: 0 });
const A = (p: PoolBuf, i = 0): number => p.data[i * PL.STRIDE + PL.A];

/** Step a rise every `dt` ms over [t0, t1] with a scripted tip. */
function run(rise: Rise, pb: PoolBuf, t0: number, t1: number, tip: (t: number) => Partial<RiseInput>,
  o: { dt?: number; base?: number; ceiling?: (s: number) => number } = {}): Frame[] {
  const out: Frame[] = [], dt = o.dt ?? 8, base = o.base ?? 0, ceil = o.ceiling ?? (() => 100);
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    const q = tip(t);
    const r = rise.step({ x: q.x ?? 0, y: q.y ?? 0, s: q.s ?? 0, p: q.p ?? 0.6, now: t, travel: q.travel ?? 0 }, pb, base, ceil);
    out.push({
      t, phase: r.phase, pre: r.pre, level: r.level, brim: r.brim,
      changed: r.changed ? [r.changed.s0, r.changed.s1] : null,
      hold: r.hold ? [r.hold.x, r.hold.y, r.hold.s] : null,
      n: pb.n, a: pb.n > 0 ? A(pb) : 0,
    });
  }
  return out;
}
const firstT = (f: Frame[], ph: RisePhase): number => { const x = f.find(e => e.phase === ph); return x ? x.t : -1; };

describe('rise: hold detection per device', () => {
  for (const [dev, pre, pool] of [['pen', 250, 450], ['mouse', 350, 600], ['touch', 350, 600]] as [Device, number, number][]) {
    it(`${dev}: stillness → prehalo at ${pre} ms → pooling at ${pool} ms (bloom at s = 0)`, () => {
      const rise = createRise(dev, DEFAULT_CALIB[dev]), pb = pools();
      const p = dev === 'pen' ? 0.6 : 0.9;
      const f = run(rise, pb, 0, 1600, () => ({ x: 5, y: 5, s: 2, travel: 2, p }));
      expect(firstT(f, 'prehalo')).toBe(Math.ceil(pre / 8) * 8);
      expect(firstT(f, 'pooling')).toBe(Math.ceil(pool / 8) * 8);
      const mid = f.find(e => e.t >= (pre + pool) / 2)!;
      expect(mid.pre).toBeGreaterThan(0.4); expect(mid.pre).toBeLessThan(0.6);
      expect(pb.n).toBe(1);
      expect(pb.data[PL.S]).toBe(0); // bloom
      // da/dt = 0.9 + 1.6p levels per second, stored in 1/16 steps
      const expected = poolRate(p) * (1600 - pool) / 1000;
      expect(Math.abs(A(pb) - expected)).toBeLessThanOrEqual(1 / 32 + 1e-6);
      expect(A(pb) * 16).toBe(Math.round(A(pb) * 16));
      expect(rise.rose).toBe(true);
      expect(f[f.length - 1].hold).toEqual([5, 5, 0]);
      expect(f[f.length - 1].level).toBeCloseTo(A(pb), 6);
    });
  }

  it('a hold after travel pools at the tip arc; changed windows are [s − 48, s + 32]', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools();
    const f = run(rise, pb, 0, 1500, t => (t < 300 ? { x: t / 5, s: t / 5, travel: t / 5 } : { x: 60, s: 60, travel: 60 }));
    expect(pb.n).toBe(1);
    expect(pb.data[PL.S]).toBe(60);
    const ch = f.filter(e => e.changed);
    expect(ch.length).toBeGreaterThan(5);
    for (const e of ch) expect(e.changed).toEqual([12, 92]);
    // stillness is dated from the first still frame (x = 59.2 at 296 ms is within 1 sp of the stop)
    expect(pb.data[PL.T0]).toBeGreaterThanOrEqual(296 + 600);
    expect(pb.data[PL.T1]).toBeLessThanOrEqual(1500);
  });

  it('jitter inside the still radius counts as still (touch 4 sp), not for a mouse (1 sp)', () => {
    // pairwise spread up to 2·0.6·√2 ≈ 1.7 sp: beyond a mouse's 1 sp, inside 2 sp (jf = 2) and 4 sp (touch)
    const wobble = (t: number) => ({ x: 50 + 0.6 * Math.sin(t / 7), y: 50 + 0.6 * Math.cos(t / 11), s: 80, travel: 80 });
    const touch = createRise('touch', DEFAULT_CALIB.touch), mouse = createRise('mouse', DEFAULT_CALIB.mouse);
    expect(firstT(run(touch, pools(), 0, 1000, wobble), 'pooling')).toBeGreaterThan(0);
    expect(firstT(run(mouse, pools(), 0, 1000, wobble), 'prehalo')).toBe(-1);
    // a jittery hand (J = 0.9 → jf = 2) gets a doubled radius
    const jittery = createRise('mouse', { ...DEFAULT_CALIB.mouse, jitter: 0.9 });
    expect(firstT(run(jittery, pools(), 0, 1000, wobble), 'pooling')).toBeGreaterThan(0);
  });

  it('a late first step after travel does not count the unseen past as still', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools();
    const f = run(rise, pb, 200, 500, () => ({ x: 40, s: 40, travel: 40 }));
    // the window only becomes covered 120 ms after the first step: stillness dates from 200
    expect(firstT(f, 'prehalo')).toBe(-1);
    const g = run(rise, pb, 508, 1000, () => ({ x: 40, s: 40, travel: 40 }));
    expect(firstT(g, 'pooling')).toBe(804); // first step (508 + 8k) at or after 200 + 600
  });

  it('corner dwells (< 150 ms) never trigger a hold', () => {
    const rise = createRise('pen', DEFAULT_CALIB.pen), pb = pools();
    const f = run(rise, pb, 0, 1200, t => {
      const x = t < 400 ? t / 4 : t < 540 ? 100 : 100 + (t - 540) / 4;
      return { x, s: x, travel: x };
    });
    expect(f.every(e => e.phase === 'moving')).toBe(true);
    expect(pb.n).toBe(0);
    expect(rise.rose).toBe(false);
  });
});

describe('rise: pressure gate, Settle, move-on, ceiling', () => {
  it('pen gate: pause between 0.5·p₀ and 0.8·p₀, Settle drains at 0.8/s below, rise again above', () => {
    const rise = createRise('pen', DEFAULT_CALIB.pen), pb = pools();
    const p = (t: number) => (t < 1000 ? 0.6 : t < 1400 ? 0.4 : t < 1900 ? 0.2 : 0.6);
    const f = run(rise, pb, 0, 2400, t => ({ x: 9, y: 9, s: 40, travel: 40, p: p(t) }));
    const at = (t: number) => f.find(e => e.t >= t)!;
    expect(at(900).phase).toBe('pooling');
    expect(at(1200).phase).toBe('paused');
    expect(at(1390).a).toBe(at(1010).a);
    expect(at(1600).phase).toBe('settling');
    const drained = at(1010).a - at(1890).a;
    expect(drained).toBeGreaterThan(0.8 * 0.48 - 0.07); expect(drained).toBeLessThan(0.8 * 0.5 + 0.07);
    expect(at(2200).phase).toBe('pooling');
    expect(at(2390).a).toBeGreaterThan(at(1890).a);
  });

  it('Settle stops at 0', () => {
    const rise = createRise('pen', DEFAULT_CALIB.pen), pb = pools();
    run(rise, pb, 0, 3000, t => ({ x: 1, s: 30, travel: 30, p: t < 700 ? 0.8 : 0.1 }));
    expect(A(pb)).toBe(0);
  });

  it('moving on freezes the pool; a later hold at the same spot continues from the local level', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools();
    const f = run(rise, pb, 0, 2600, t => {
      if (t < 1200) return { x: 20, s: 20, travel: 20 };
      if (t < 1400) { const x = 20 + (t - 1200) / 2; return { x, s: x, travel: x }; } // move on 100 sp
      if (t < 1600) { const x = 120 - (t - 1400) / 2; return { x, s: 120 + (t - 1400) / 2, travel: 220 }; }
      return { x: 20, s: 20.2, travel: 300 };
    });
    const frozen = f.find(e => e.t >= 1250)!;
    expect(frozen.phase).toBe('moving');
    const aFrozen = frozen.a;
    expect(aFrozen).toBeGreaterThan(1);
    expect(f.find(e => e.t >= 1590)!.a).toBe(aFrozen);
    // the same arc (|Δs| < 0.5) continues the same row
    expect(pb.n).toBe(1);
    expect(A(pb)).toBeGreaterThan(aFrozen);
  });

  it('a hold under an earlier pool starts a new row at the local level', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools();
    run(rise, pb, 0, 2600, t => {
      if (t < 1200) return { x: 20, s: 20, travel: 20 };
      if (t < 1300) { const x = 20 + (t - 1200) / 10; return { x, s: x, travel: x }; }
      return { x: 30, s: 30, travel: 30 };
    });
    expect(pb.n).toBe(2);
    expect(pb.data[PL.STRIDE + PL.S]).toBe(30);
    // row 2 started at d(30) − base = a₁·K(10) = a₁ (inside the 6 sp plateau? no: 10 sp ahead → K(10) < 1)
    expect(A(pb, 1)).toBeGreaterThan(A(pb, 0) * 0.5);
  });

  it('brim: the ceiling stops pooling and flashes once', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools();
    const f = run(rise, pb, 0, 2500, () => ({ x: 3, s: 50, travel: 50, p: 0.9 }), { base: 2, ceiling: () => 3 });
    expect(f.filter(e => e.brim).length).toBe(1);
    expect(f[f.length - 1].phase).toBe('ceiling');
    expect(A(pb)).toBe(1);
    expect(f[f.length - 1].level).toBe(3);
  });

  it('a pool that starts at the ceiling flashes once and never lowers an existing level', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools();
    pb.data.set([50, 1.5, 0, 0]); pb.n = 1;
    const f = run(rise, pb, 0, 1500, () => ({ x: 3, s: 50, travel: 50 }), { base: 1, ceiling: () => 2 });
    expect(f.filter(e => e.brim).length).toBe(1);
    expect(A(pb)).toBe(1.5);
  });

  it('33 holds: the 33rd continues the nearest row', () => {
    const rise = createRise('mouse', DEFAULT_CALIB.mouse), pb = pools(2);
    let t = 0;
    for (let k = 0; k < 33; k++) {
      const s = 100 + k * 50;
      run(rise, pb, t, t + 700, () => ({ x: s, s, travel: s }));
      t += 708;
      run(rise, pb, t, t + 40, tt => ({ x: s + (tt - t) * 2, s: s + 25, travel: s + 25 })); // move on
      t += 48;
    }
    expect(pb.n).toBe(32);
    expect(pb.data.length).toBeGreaterThanOrEqual(32 * PL.STRIDE); // grown by replacing the array
    expect(A(pb, 31)).toBeGreaterThan(A(pb, 30)); // the 33rd hold landed in the nearest (last) row
  });
});

describe('rise: robustness', () => {
  it('non-finite inputs never reach a pool row', () => {
    // regression: a NaN ceiling or pressure wrote NaN levels; a NaN tip read as "still"
    const a = createRise('mouse', DEFAULT_CALIB.mouse), pa = pools();
    run(a, pa, 0, 1500, () => ({ x: 1, s: 20, travel: 20, p: 0.9 }), { ceiling: () => NaN });
    expect(pa.n).toBe(1);
    expect(Number.isFinite(A(pa))).toBe(true);
    expect(A(pa)).toBeGreaterThan(1); // a broken ceiling callback means no cap from it
    const b = createRise('touch', DEFAULT_CALIB.touch), pbb = pools();
    const fb = run(b, pbb, 0, 1500, () => ({ x: 1, s: 20, travel: 20, p: NaN }));
    expect(A(pbb)).toBeCloseTo(poolRate(0.6) * 0.9, 1);
    expect(fb.every(e => Number.isFinite(e.level))).toBe(true);
    const pen = createRise('pen', DEFAULT_CALIB.pen), pp = pools();
    run(pen, pp, 0, 1200, () => ({ x: 1, s: 20, travel: 20, p: NaN }));
    expect(Number.isFinite(A(pp))).toBe(true);
    const c = createRise('mouse', DEFAULT_CALIB.mouse), pc = pools();
    const fc = run(c, pc, 0, 1500, () => ({ x: NaN, y: NaN, s: 20, travel: 20 }));
    expect(pc.n).toBe(0);
    expect(fc.every(e => e.phase === 'moving')).toBe(true);
    const d = createRise('mouse', DEFAULT_CALIB.mouse), pd = pools();
    run(d, pd, 0, 1500, () => ({ x: 1, s: 20, travel: 20 }), { base: NaN });
    expect(Number.isFinite(A(pd))).toBe(true);
  });
});

describe('rise: lift guard', () => {
  it('restores pools to their state at tUp − 60 ms', () => {
    const rise = createRise('pen', DEFAULT_CALIB.pen), pb = pools();
    const f = run(rise, pb, 0, 1500, () => ({ x: 1, s: 20, travel: 20, p: 0.9 }));
    const before = f.filter(e => e.t <= 1500 - 60).pop()!;
    expect(A(pb)).toBeGreaterThan(before.a);
    rise.liftGuard(pb, 1500);
    expect(A(pb)).toBe(before.a);
    expect(rise.rose).toBe(true);
  });

  it('removes a pool created within the guard window', () => {
    const rise = createRise('pen', DEFAULT_CALIB.pen), pb = pools();
    run(rise, pb, 0, 480, () => ({ x: 1, s: 20, travel: 20, p: 0.9 }));
    expect(pb.n).toBe(1);
    rise.liftGuard(pb, 480);
    expect(pb.n).toBe(0);
    expect(rise.rose).toBe(false);
  });

  it('thresholds table', () => {
    expect(HOLD.pen).toEqual({ still: 1.5, move: 3, pre: 250, pool: 450, gate: true });
    expect(HOLD.mouse).toEqual({ still: 1.0, move: 3, pre: 350, pool: 600, gate: false });
    expect(HOLD.touch).toEqual({ still: 4, move: 8, pre: 350, pool: 600, gate: false });
  });
});
