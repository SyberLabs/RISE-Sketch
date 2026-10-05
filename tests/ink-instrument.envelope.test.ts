import { describe, it, expect } from 'vitest';
import type { Spine } from '../src/core/types';
import { S } from '../src/core/types';
import { liveEnvelope, finalEnvelope, closureTest, closureRadius, weldWidth, entryTaper } from '../src/ink/envelope';
import { buildSpine, createSpineBuilder, createSpine } from '../src/ink/spine';
import { DEFAULT_CALIB } from '../src/ink/calib';
import { Hand, recipe, draftOf } from './ink-instrument.fixtures';

function fin(h: Hand, o: Parameters<typeof recipe>[1] = {}, noP = false) {
  const r = recipe(h.rows(1, noP), o);
  const sp = buildSpine(r);
  return { r, sp, env: finalEnvelope(r, sp) };
}

describe('envelope: tapers', () => {
  it('entry taper follows entry speed (slow 4 sp, flick-in 30 sp, × nib taper)', () => {
    const slow = new Hand(0, 0); slow.moveTo(150, 0, 0.2);
    const fast = new Hand(0, 0); fast.moveTo(300, 0, 2.5);
    expect(fin(slow).env.Te).toBeCloseTo(4, 6);
    expect(fin(fast).env.Te).toBeCloseTo(30, 6);
    expect(fin(fast, { nib: 'pen', size: 2.5 }).env.Te).toBeCloseTo(15, 6);
  });

  it('live envelope: causal Te, round tip, final once 40 ms exist', () => {
    const h = new Hand(0, 0); h.moveTo(300, 0, 2.5);
    const r = recipe(h.rows());
    const { d, feed } = draftOf(r);
    const b = createSpineBuilder(d);
    feed(5); b.append();
    const early = liveEnvelope(d, b.spine);
    expect(early.teFinal).toBe(false);
    feed(20); b.append();
    const live = liveEnvelope(d, b.spine);
    expect(live.teFinal).toBe(true);
    expect(live.Tx).toBe(0);
    expect(live.Te).toBeCloseTo(30, 6);
    for (const s of [0, 5, 15, 29, 40]) expect(live.at(s)).toBe(live.inF(s));
    expect(live.at(b.spine.L)).toBe(1); // tip stays round while drawing
    expect(live.inF(0)).toBe(0);
  });

  it('exit: flick gives a long lift, a slow end a short one', () => {
    const flick = new Hand(0, 0); flick.moveTo(100, 0, 0.3).moveTo(300, 0, 2.6);
    const slowEnd = new Hand(0, 0); slowEnd.moveTo(200, 0, 1).moveTo(260, 0, 0.2);
    const a = fin(flick).env, b = fin(slowEnd).env;
    expect(a.seated).toBe(false);
    expect(a.Tx).toBeCloseTo(50, 6);
    expect(b.Tx).toBeCloseTo(4, 6);
    // E(s): 0 at both ends, 1 inside, exit factor ^0.6
    const { sp } = fin(flick);
    expect(a.at(sp.s[0])).toBe(0);
    expect(a.at(sp.L)).toBe(0);
    expect(a.at(150)).toBe(1);
    const x = 0.5 * 50, e = a.at(sp.L - x);
    expect(e).toBeCloseTo(Math.pow(0.5, 0.6), 6);
  });

  it('short strokes clamp Tx ≤ 0.35·len and the trunk Te ≤ 0.25·len', () => {
    const h = new Hand(0, 0); h.moveTo(30, 0, 2.5);
    const { env, sp } = fin(h);
    const len = sp.L - sp.s[0];
    expect(env.Tx).toBeLessThanOrEqual(0.35 * len + 1e-9);
    expect(env.TeTrunk).toBeCloseTo(Math.min(env.Te, 0.25 * len), 9);
    expect(env.inF(10)).toBe(Math.min(1, env.inF(10)));
  });

  it('seated stop: a slow end with ≥ 60 ms dwell drops Tx and widens the last 3 sp ×1.12', () => {
    const h = new Hand(0, 0); h.moveTo(150, 0, 0.8).moveTo(160, 0, 0.1).hold(120);
    const { env, sp } = fin(h);
    expect(env.seated).toBe(true);
    expect(env.Tx).toBe(0);
    expect(env.at(sp.L)).toBeCloseTo(1.12, 9);
    expect(env.at(sp.L - 2)).toBeCloseTo(1.12, 9);
    expect(env.at(sp.L - 7)).toBe(1);
    const short = new Hand(0, 0); short.moveTo(150, 0, 0.8).moveTo(160, 0, 0.1).hold(30);
    expect(fin(short).env.seated).toBe(false);
  });

  it('seated stop survives hand tremor (net-displacement exit velocity, J-scaled dwell radius)', () => {
    // regression: the raw path length of a still but tremulous hand read as ≈ 0.2 sp/ms (> 0.15·vMed)
    for (const sigma of [0.3, 0.5, 0.8]) {
      const h = new Hand(0, 0, { jitter: sigma, seed: 4 });
      h.moveTo(150, 0, 0.8).moveTo(160, 0, 0.1).hold(150);
      const calib = { ...DEFAULT_CALIB.pen, jitter: Math.max(0.3, sigma * Math.SQRT2) }; // learned J ≈ σ√2
      const { env } = fin(h, { calib });
      expect(env.seated).toBe(true);
      expect(env.Tx).toBe(0);
    }
    // a tremulous hand that is still moving at the end (no dwell) is not seated
    const m = new Hand(0, 0, { jitter: 0.5, seed: 5 }); m.moveTo(150, 0, 0.8).moveTo(170, 0, 0.12);
    expect(fin(m, { calib: { ...DEFAULT_CALIB.pen, jitter: 0.7 } }).env.seated).toBe(false);
  });

  it('corrupt rows never make the envelope NaN', () => {
    // regression: a corrupt first row made v_entry / v_exit (and so Te, Tx and every width) NaN
    const h = new Hand(0, 0); h.moveTo(200, 0, 1.5);
    const rows = h.rows();
    rows[0 * S.STRIDE + S.X] = NaN; rows[20 * S.STRIDE + S.T] = Infinity; rows[rows.length - 2 * S.STRIDE + S.Y] = NaN;
    const r = recipe(rows), sp = buildSpine(r), env = finalEnvelope(r, sp);
    expect(Number.isFinite(env.Te) && Number.isFinite(env.Tx)).toBe(true);
    expect(env.Te).toBeGreaterThan(10); // a fast entry still reads as fast
    for (let i = 0; i < sp.n; i++) expect(Number.isFinite(env.at(sp.s[i]))).toBe(true);
    const all = new Float32Array(3 * S.STRIDE).fill(NaN);
    const ra = recipe(all), ea = finalEnvelope(ra, buildSpine(ra));
    expect(Number.isFinite(ea.Te) && Number.isFinite(ea.Tx)).toBe(true);
    expect(Number.isFinite(liveEnvelope(ra, buildSpine(ra)).at(0))).toBe(true);
  });

  it('pen ramp-down halves Tx when real pressure already fell; synthesised pressure never does', () => {
    const steady = new Hand(0, 0, { p: 0.7 }); steady.moveTo(200, 0, 1).moveTo(300, 0, 1);
    const ramp = new Hand(0, 0, { p: 0.7 }); ramp.moveTo(200, 0, 1).moveTo(300, 0, 1, 0.02);
    const a = fin(steady).env, b = fin(ramp).env;
    expect(b.Tx).toBeCloseTo(0.5 * a.Tx, 9);
    const mouse = fin(ramp, { device: 'mouse' }, true).env;
    expect(mouse.Tx).toBeCloseTo(a.Tx, 9);
  });

  it('cut bits and closure drop the tapers', () => {
    const h = new Hand(0, 0); h.moveTo(300, 0, 2.5);
    expect(fin(h, { cut: 1 }).env.Te).toBe(0);
    expect(fin(h, { cut: 2 }).env.Tx).toBe(0);
    const c = fin(h, { closed: true }).env;
    expect(c.Te).toBe(0); expect(c.Tx).toBe(0); expect(c.closed).toBe(true);
    expect(c.at(0)).toBe(1); expect(c.inF(0)).toBe(1);
    expect(entryTaper(recipe(h.rows(), { cut: 1 }))).toBe(0);
  });
});

describe('closure', () => {
  it('radius and weld width', () => {
    expect(closureRadius(100)).toBe(10);
    expect(closureRadius(1000)).toBe(60);
    expect(weldWidth(1000, 5)).toBe(40);
    expect(weldWidth(5000, 5)).toBe(50);
    expect(weldWidth(100, 20)).toBe(40);
    expect(weldWidth(40, 20)).toBe(20);
  });

  it('hysteresis on a circle: on inside r_c after 300°, off beyond 1.5·r_c', () => {
    const R = 60, h = new Hand(R, 0, { jitter: 0.15, seed: 3 });
    h.arc(0, 0, R, 0, 2 * Math.PI + 0.9, 0.9);
    const r = recipe(h.rows());
    const { d, total, feed } = draftOf(r, false);
    const b = createSpineBuilder(d);
    let closing = false, fed = 0, onAt = -1, offAt = -1;
    const log: { gap: number; rc: number; on: boolean; turned: number }[] = [];
    while (fed < total) {
      fed = feed(3); b.append();
      const sp = b.spine;
      const was = closing;
      closing = closureTest(sp, closing);
      d.closing = closing;
      const n = sp.n, gap = Math.hypot(sp.x[n - 1] - sp.x[0], sp.y[n - 1] - sp.y[0]), rc = closureRadius(sp.L - sp.s[0]);
      log.push({ gap, rc, on: closing, turned: sp.L / R });
      if (closing && !was) { onAt = log.length - 1; expect(gap).toBeLessThan(rc); }
      if (!closing && was) { offAt = log.length - 1; expect(gap).toBeGreaterThan(1.5 * rc); }
      if (!was && !closing && gap > rc && gap < 1.5 * rc && sp.L > 300) expect(closing).toBe(false);
    }
    expect(onAt).toBeGreaterThan(0);
    expect(offAt).toBeGreaterThan(onAt);
    expect(log[onAt].turned).toBeGreaterThan(300 * Math.PI / 180);
    // it stayed on through the band (r_c, 1.5·r_c] after passing the start
    expect(log.slice(onAt, offAt).some(e => e.gap > e.rc && e.gap <= 1.5 * e.rc)).toBe(true);
    expect(log.slice(onAt, offAt).every(e => e.on)).toBe(true);
  });

  it('no closure without enough turning or length', () => {
    const zig = new Hand(0, 0); zig.moveTo(100, 0, 1).moveTo(0, 4, 1);  // back near the start, ~180° turned
    const sp = buildSpine(recipe(zig.rows()));
    expect(closureTest(sp, false)).toBe(false);
    expect(closureTest(sp, true)).toBe(false);
    const empty = { n: 0 } as unknown as Spine;
    expect(closureTest(empty, true)).toBe(false);
  });

  it('a spine object reused for another stroke never inherits the previous turning prefix', () => {
    // regression: the cached prefix was trusted whenever it did not run past `settled`
    const c = new Hand(60, 0); c.arc(0, 0, 60, 0, 2 * Math.PI - 0.1, 1);
    const circle = buildSpine(recipe(c.rows()));
    const q = new Hand(0, 0); q.moveTo(150, 0, 1).moveTo(150, 120, 1).moveTo(0, 120, 1).moveTo(0, 8, 1); // 270°
    const square = buildSpine(recipe(q.rows()));
    const shared = createSpine(Math.max(circle.n, square.n));
    const load = (src: Spine): void => {
      for (const f of ['x', 'y', 's'] as const) shared[f].set(src[f].subarray(0, src.n));
      shared.n = src.n; shared.settled = src.n - 5; shared.L = src.L;
    };
    load(circle);
    expect(closureTest(shared, false)).toBe(true);
    load(square);
    expect(closureTest(square, false)).toBe(false);
    expect(closureTest(shared, false)).toBe(false);
    expect(closureTest(shared, true)).toBe(false);
  });

  it('a finished closed circle reports closed (prefix cache invalidated after finish)', () => {
    const h = new Hand(60, 0); h.arc(0, 0, 60, 0, 2 * Math.PI - 0.1, 1);
    const r = recipe(h.rows());
    const { d, feed, total } = draftOf(r);
    const b = createSpineBuilder(d);
    let c = false;
    for (let f = 0; f < total;) { f = feed(7); b.append(); c = closureTest(b.spine, c); }
    expect(c).toBe(true);
    b.finish(c);
    expect(closureTest(b.spine, true)).toBe(true);
  });
});
