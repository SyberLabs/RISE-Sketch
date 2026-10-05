import { describe, it, expect } from 'vitest';
import {
  sanitizeTime, tiltToAltAz, contactRadius, fillSample, newSample, SampleBatch, PointerReader, type PointerLike,
  MIN_DT, PREDICT_MS, PREDICT_SP, CHUNK, MAX_PREDICTED,
} from '../src/input/pointer';

interface Ev extends PointerLike { co?: Ev[]; pred?: Ev[] }
const ev = (x: number, y: number, t: number, o: Partial<Ev> = {}): Ev => {
  const e: Ev = { clientX: x, clientY: y, timeStamp: t, pressure: 0.5, tiltX: 0, tiltY: 0, width: 1, height: 1, ...o };
  if (o.co) e.getCoalescedEvents = () => o.co!;
  if (o.pred) e.getPredictedEvents = () => o.pred!;
  return e;
};

describe('sanitizeTime', () => {
  it('t_i = max(t, t_{i-1} + 0.25)', () => {
    expect(sanitizeTime(10, 20)).toBe(20);
    expect(sanitizeTime(10, 10)).toBe(10 + MIN_DT);
    expect(sanitizeTime(10, 5)).toBe(10 + MIN_DT);
    expect(sanitizeTime(10, 10.25)).toBe(10.25);
  });
  it('starts from the first timestamp and survives garbage', () => {
    expect(sanitizeTime(-Infinity, 1234.5)).toBe(1234.5);
    expect(sanitizeTime(10, NaN)).toBe(10 + MIN_DT);
    expect(sanitizeTime(10, Infinity)).toBe(10 + MIN_DT);
    expect(sanitizeTime(-Infinity, NaN)).toBe(0);
  });
  it('a run of identical coalesced timestamps becomes strictly increasing', () => {
    let prev = -Infinity;
    const out: number[] = [];
    for (const t of [100, 100, 100, 100, 101, 101.1, 99]) out.push(prev = sanitizeTime(prev, t));
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] + MIN_DT);
    expect(out[0]).toBe(100);
    expect(out[4]).toBe(101);
  });
});

describe('tiltToAltAz', () => {
  const o = { alt: 0, az: 0 };
  it('untilted is perpendicular', () => {
    tiltToAltAz(0, 0, o);
    expect(o.alt).toBeCloseTo(Math.PI / 2);
    expect(o.az).toBe(0);
  });
  it('single-axis tilts', () => {
    tiltToAltAz(45, 0, o);
    expect(o.alt).toBeCloseTo(Math.PI / 4);
    expect(o.az).toBe(0);
    tiltToAltAz(-30, 0, o);
    expect(o.alt).toBeCloseTo(Math.PI / 3);
    expect(o.az).toBeCloseTo(Math.PI);
    tiltToAltAz(0, 30, o);
    expect(o.az).toBeCloseTo(Math.PI / 2);
    tiltToAltAz(0, -30, o);
    expect(o.az).toBeCloseTo(3 * Math.PI / 2);
  });
  it('two-axis tilt', () => {
    tiltToAltAz(45, 45, o);
    expect(o.az).toBeCloseTo(Math.PI / 4);
    expect(o.alt).toBeCloseTo(Math.atan(1 / Math.SQRT2));
    tiltToAltAz(90, 10, o);
    expect(o.alt).toBe(0);
  });
});

describe('fillSample', () => {
  it('mouse: no pressure, default angles, no radius', () => {
    const s = newSample();
    fillSample(s, ev(3, 4, 0, { pressure: 0.5 }), 'mouse');
    expect([s.x, s.y]).toEqual([3, 4]);
    expect(s.p).toBeNaN();
    expect(s.alt).toBeCloseTo(Math.PI / 2);
    expect(s.az).toBe(0);
    expect(s.r).toBeNaN();
    expect(s.predicted).toBe(false);
  });
  it('pen: raw pressure (clamped) and native angles, falling back to tilt', () => {
    const s = newSample();
    fillSample(s, ev(0, 0, 0, { pressure: 0.37, altitudeAngle: 0.8, azimuthAngle: 2 }), 'pen');
    expect(s.p).toBeCloseTo(0.37);
    expect([s.alt, s.az]).toEqual([0.8, 2]);
    fillSample(s, ev(0, 0, 0, { pressure: 1.4, tiltX: 45 }), 'pen');
    expect(s.p).toBe(1);
    expect(s.alt).toBeCloseTo(Math.PI / 4);
    // native angles stuck at the default while tilt says otherwise: use tilt
    fillSample(s, ev(0, 0, 0, { tiltX: 45, altitudeAngle: Math.PI / 2, azimuthAngle: 0 }), 'pen');
    expect(s.alt).toBeCloseTo(Math.PI / 4);
  });
  it('touch: no pressure; radius from contact geometry when reported', () => {
    const s = newSample();
    fillSample(s, ev(0, 0, 0, { width: 20, height: 12 }), 'touch');
    expect(s.p).toBeNaN();
    expect(s.r).toBe(8);
    fillSample(s, ev(0, 0, 0, { width: 1, height: 1 }), 'touch');
    expect(s.r).toBeNaN();
  });
  it('contactRadius is half the larger extent', () => {
    expect(contactRadius(50, 30)).toBe(25);
    expect(contactRadius(1, 1)).toBeNaN();
    expect(contactRadius(0, 0)).toBeNaN();
  });
});

describe('SampleBatch', () => {
  it('returns the same array object per length, over pooled samples', () => {
    const b = new SampleBatch();
    const a3 = b.view(3);
    expect(a3.length).toBe(3);
    expect(b.view(3)).toBe(a3);
    expect(b.view(5)[0]).toBe(a3[0]);
    expect(b.view(0).length).toBe(0);
    expect(b.at(2)).toBe(a3[2]);
  });
});

describe('PointerReader', () => {
  it('reads coalesced samples in order with a strictly increasing stroke clock', () => {
    const r = new PointerReader();
    const down = r.readOne(ev(0, 0, 100), 'pen', true);
    expect(down.t).toBe(100);
    r.restart(down);
    const co = [ev(1, 0, 100), ev(2, 0, 100), ev(3, 0, 104)];
    const e = ev(3, 0, 104, { co });
    expect(r.begin(e)).toBe(3);
    const s = r.chunk(0, 3, 'pen', true);
    expect(s.map(q => q.x)).toEqual([1, 2, 3]);
    expect(s.map(q => q.t)).toEqual([100.25, 100.5, 104]);
    r.end();
  });

  it('falls back to the event itself when the coalesced list is missing or empty', () => {
    const r = new PointerReader();
    expect(r.begin(ev(5, 6, 10))).toBe(1);
    expect(r.chunk(0, 1, 'mouse', false).map(q => [q.x, q.y, q.t])).toEqual([[5, 6, 10]]);
    expect(r.begin(ev(7, 8, 11, { co: [] }))).toBe(1);
    expect(r.chunk(0, 1, 'mouse', false)[0].x).toBe(7);
  });

  it('non-stroke reads keep raw times and leave the stroke clock alone', () => {
    const r = new PointerReader();
    r.readOne(ev(0, 0, 100), 'pen', true);
    r.begin(ev(0, 0, 50));
    expect(r.chunk(0, 1, 'touch', false)[0].t).toBe(50);
    expect(r.lastT).toBe(100);
    expect(r.readOne(ev(0, 0, 40), 'touch', false).t).toBe(40);
    expect(r.lastT).toBe(100);
  });

  it('reuses the arrays and samples it hands out (steady state allocates nothing)', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'pen', true));
    r.begin(ev(1, 0, 4, { co: [ev(0.5, 0, 2), ev(1, 0, 4)] }));
    const a = r.chunk(0, 2, 'pen', true);
    r.begin(ev(2, 0, 8, { co: [ev(1.5, 0, 6), ev(2, 0, 8)] }));
    const b = r.chunk(0, 2, 'pen', true);
    expect(b).toBe(a);
    expect(b[0].x).toBe(1.5);
  });

  it('chunks a long coalesced list', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'pen', true));
    const co: Ev[] = [];
    for (let i = 1; i <= CHUNK + 10; i++) co.push(ev(i, 0, i));
    const n = r.begin(ev(0, 0, 0, { co }));
    expect(n).toBe(CHUNK + 10);
    expect(r.chunk(0, CHUNK, 'pen', true).length).toBe(CHUNK);
    const tail = r.chunk(CHUNK, n, 'pen', true);
    expect(tail.length).toBe(10);
    expect(tail[9].x).toBe(CHUNK + 10);
  });

  it('predicted events are marked, capped at 16 ms and 24 sp, and never advance the clock', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'pen', true));
    const pred = [ev(4, 0, 104, { pressure: 0 }), ev(8, 0, 108), ev(40, 0, 112), ev(60, 0, 130)];
    r.begin(ev(0, 0, 100, { co: [ev(0, 0, 100)], pred }));
    r.chunk(0, 1, 'pen', true);
    const p = r.predict('pen');
    expect(p.length).toBe(3);
    expect(p.every(q => q.predicted)).toBe(true);
    expect(p[0].p).toBeCloseTo(0.5); // zero predicted pressure inherits the tip's
    expect(p[1].x).toBe(8);
    expect(Math.hypot(p[2].x, p[2].y)).toBeCloseTo(PREDICT_SP); // clamped onto the 24 sp circle
    for (const q of p) expect(q.t - 100).toBeLessThanOrEqual(PREDICT_MS);
    expect(r.lastT).toBe(100);
  });

  it('time cap scales a far-future predicted point back to 16 ms', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'pen', true));
    r.begin(ev(0, 0, 100, { co: [ev(0, 0, 100)], pred: [ev(8, 0, 132)] }));
    r.chunk(0, 1, 'pen', true);
    const p = r.predict('pen');
    expect(p.length).toBe(1);
    expect(p[0].x).toBeCloseTo(4);
    expect(p[0].t).toBeCloseTo(116);
  });

  it('without getPredictedEvents, a line fit through the last 3 samples predicts the tip', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'mouse', true));
    r.begin(ev(2, 1, 8, { co: [ev(1, 0.5, 4), ev(2, 1, 8)] }));
    r.chunk(0, 2, 'mouse', true);
    const p = r.predict('mouse');
    expect(p.length).toBe(1);
    // v = (0.25, 0.125) px/ms -> +16 ms
    expect(p[0].x).toBeCloseTo(2 + 0.25 * 16);
    expect(p[0].y).toBeCloseTo(1 + 0.125 * 16);
    expect(p[0].t).toBeCloseTo(24);
    expect(p[0].predicted).toBe(true);
    expect(p[0].p).toBeNaN();
  });

  it('line fit respects the 24 sp cap and skips a still pointer', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'mouse', true));
    r.begin(ev(20, 0, 2, { co: [ev(10, 0, 1), ev(20, 0, 2)] }));
    r.chunk(0, 2, 'mouse', true);
    const p = r.predict('mouse');
    expect(p[0].x).toBeCloseTo(20 + PREDICT_SP);
    const s = new PointerReader();
    s.restart(s.readOne(ev(0, 0, 0), 'mouse', true));
    s.begin(ev(0, 0, 8, { co: [ev(0, 0, 4), ev(0.01, 0, 8)] }));
    s.chunk(0, 2, 'mouse', true);
    expect(s.predict('mouse').length).toBe(0);
  });

  it('an empty getPredictedEvents() list falls back to the line fit', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'pen', true));
    r.begin(ev(2, 0, 8, { co: [ev(1, 0, 4), ev(2, 0, 8)], pred: [] }));
    r.chunk(0, 2, 'pen', true);
    const p = r.predict('pen');
    expect(p.length).toBe(1);
    expect(p[0].x).toBeCloseTo(2 + 0.25 * PREDICT_MS);
    expect(p[0].p).toBeCloseTo(0.5);
  });

  it('keeps at most MAX_PREDICTED predicted samples', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'pen', true));
    const pred: Ev[] = [];
    for (let i = 1; i <= 10; i++) pred.push(ev(i, 0, 100 + i));
    r.begin(ev(0, 0, 100, { co: [ev(0, 0, 100)], pred }));
    r.chunk(0, 1, 'pen', true);
    const p = r.predict('pen');
    expect(p.length).toBe(MAX_PREDICTED);
    for (let i = 1; i < p.length; i++) expect(p[i].t).toBeGreaterThan(p[i - 1].t);
  });

  it('needs three samples before the line fit predicts', () => {
    const r = new PointerReader();
    r.restart(r.readOne(ev(0, 0, 0), 'mouse', true));
    r.begin(ev(5, 0, 4));
    r.chunk(0, 1, 'mouse', true);
    expect(r.predict('mouse').length).toBe(0);
  });
});
