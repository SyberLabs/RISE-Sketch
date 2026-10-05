import { describe, it, expect } from 'vitest';
import {
  TapSession, isDoubleTap, FingerIntent, TwoFinger, TAP_MS, TAP_SLOP, DOUBLE_TAP_MS, DOUBLE_TAP_DIST, PINCH_DEAD,
} from '../src/input/gestures';

describe('TapSession', () => {
  it('classifies a one-finger tap at release', () => {
    const s = new TapSession();
    s.down(0);
    s.move(3);
    expect(s.up(120)).toBe(1);
    expect(s.active).toBe(false);
  });

  it('counts the maximum number of simultaneous contacts', () => {
    const s = new TapSession();
    s.down(0);
    s.down(20);
    expect(s.up(100)).toBe(-1);
    expect(s.up(140)).toBe(2);

    s.down(0); s.down(5); s.down(10);
    expect(s.up(50)).toBe(-1);
    expect(s.up(60)).toBe(-1);
    expect(s.up(70)).toBe(3);
  });

  it('max is the peak, not the total: sequential fingers inside one session', () => {
    const s = new TapSession();
    s.down(0);
    s.down(10);
    s.up(30);       // one lifts
    s.down(40);     // another lands: still at most 2 at once
    s.up(60);
    expect(s.up(80)).toBe(2);
  });

  it('rejects slow taps and moving contacts', () => {
    const s = new TapSession();
    s.down(0);
    expect(s.up(TAP_MS + 1)).toBe(0);
    s.down(0);
    expect(s.up(TAP_MS)).toBe(1); // inclusive bound
    s.down(0);
    s.move(TAP_SLOP);
    expect(s.up(50)).toBe(0);
    s.down(0);
    s.move(TAP_SLOP - 0.01);
    expect(s.up(50)).toBe(1);
  });

  it('spoil disqualifies the session; a new session starts clean', () => {
    const s = new TapSession();
    s.down(0);
    s.spoil();
    expect(s.up(10)).toBe(0);
    s.down(1000);
    expect(s.up(1100)).toBe(1);
  });

  it('leave drops a contact without lifting it; the session ends with its last contact', () => {
    const s = new TapSession();
    s.down(0);
    s.down(10);
    s.spoil();
    s.leave();                // the second contact turned out to be a palm
    expect(s.active).toBe(true);
    expect(s.up(50)).toBe(0); // spoiled: no tap of any kind
    s.down(100);
    s.leave();
    expect(s.active).toBe(false);
    expect(s.up(150)).toBe(0);
    s.leave();                // no session: a no-op
    s.down(200);
    expect(s.up(260)).toBe(1);
  });

  it('up without a session is a no-tap', () => {
    expect(new TapSession().up(0)).toBe(0);
  });
});

describe('isDoubleTap', () => {
  it('requires the second down within the window and distance', () => {
    expect(isDoubleTap(100, 100, 0, 105, 103, 200)).toBe(true);
    expect(isDoubleTap(100, 100, 0, 100, 100, DOUBLE_TAP_MS)).toBe(true);
    expect(isDoubleTap(100, 100, 0, 100, 100, DOUBLE_TAP_MS + 1)).toBe(false);
    expect(isDoubleTap(100, 100, 0, 100 + DOUBLE_TAP_DIST, 100, 10)).toBe(true);
    expect(isDoubleTap(100, 100, 0, 100 + DOUBLE_TAP_DIST + 0.5, 100, 10)).toBe(false);
    expect(isDoubleTap(100, 100, 50, 100, 100, 40)).toBe(false); // time going backwards
  });
});

describe('FingerIntent (pen-mode finger)', () => {
  it('pans after > 12 sp within 250 ms', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(50, 6, true)).toBe('pending');
    expect(f.move(100, 12, true)).toBe('pending');
    expect(f.move(120, 12.5, true)).toBe('pan');
  });

  it('is dead instead of panning when the pen was active recently', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(80, 20, false)).toBe('dead');
  });

  it('motion after 250 ms that breaks the slop before 350 ms is dead (drifting palm)', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(200, 5, true)).toBe('pending');
    expect(f.move(300, 11, true)).toBe('dead');
  });

  it('between the slop and the pan distance inside 250 ms stays pending', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(100, 11, true)).toBe('pending');
    expect(f.move(200, 13, true)).toBe('pan');
  });

  it('held still 350 ms then dragged lassos', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(100, 2, true)).toBe('pending');
    expect(f.move(340, 3, true)).toBe('pending');
    expect(f.move(360, 3.5, true)).toBe('pending'); // below the lasso start distance
    expect(f.move(380, 9, true)).toBe('lasso');
  });

  it('a finger that sends no events during the hold still lassos', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(500, 30, true)).toBe('lasso');
  });

  it('a hold that wobbled beyond the slop never lassos', () => {
    const f = new FingerIntent();
    f.start(0);
    expect(f.move(240, 10.5, true)).toBe('pending');
    expect(f.move(400, 30, true)).toBe('dead');
  });
});

describe('TwoFinger', () => {
  it('does nothing until it may engage', () => {
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    expect(g.update(20, 0, 120, 0, false)).toBe(false);
    expect(g.engaged).toBe(false);
  });

  it('pans with the centroid and includes the motion before engagement', () => {
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    g.update(5, 0, 105, 0, false);
    expect(g.update(10, 4, 110, 4, true)).toBe(true);
    expect(g.out.dx).toBeCloseTo(10);
    expect(g.out.dy).toBeCloseTo(4);
    expect(g.out.factor).toBe(1);
    expect(g.update(12, 4, 112, 4, true)).toBe(true);
    expect(g.out.dx).toBeCloseTo(2);
  });

  it('ignores scale changes inside the 4 % dead zone', () => {
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    // 3.8 % wider with a fixed centroid: nothing to apply
    expect(g.update(-1.9, 0, 101.9, 0, true)).toBe(false);
    expect(g.out.factor).toBe(1);
    expect(g.zoomed).toBe(false);
    // 3.8 % narrower while panning: a pure pan
    expect(g.update(11.9, 5, 108.1, 5, true)).toBe(true);
    expect(g.out.factor).toBe(1);
    expect(g.out.dx).toBeCloseTo(10);
    expect(g.zoomed).toBe(false);
  });

  it('engages zoom past the dead zone without a jump, then tracks the distance exactly', () => {
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    let total = 1;
    for (let d = 100; d <= 200; d += 5) {
      if (g.update(50 - d / 2, 0, 50 + d / 2, 0, true)) total *= g.out.factor;
    }
    expect(g.zoomed).toBe(true);
    // Everything beyond the dead-zone boundary is applied: 200 / (100 · 1.04).
    expect(total).toBeCloseTo(200 / (100 * (1 + PINCH_DEAD)), 10);
    // Engagement needs two consecutive updates past the boundary; the first engaged
    // step is only the excess over the boundary (106 vs 104).
    const h = new TwoFinger();
    h.start(0, 0, 100, 0);
    h.update(-2.5, 0, 102.5, 0, true);
    expect(h.out.factor).toBe(1);
    h.update(-3, 0, 103, 0, true);
    expect(h.out.factor).toBeCloseTo(106 / 104, 10);
  });

  it('half-updated frames of a fast two-finger pan never engage zoom', () => {
    // Fingers 100 px apart pan right 10 px per frame; each frame delivers finger A
    // then finger B, so the distance alternates 90 / 100 between the two events.
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    let ax = 0, bx = 100, pan = 0;
    for (let f = 0; f < 20; f++) {
      ax += 10;
      if (g.update(ax, 0, bx, 0, true)) pan += g.out.dx;
      bx += 10;
      if (g.update(ax, 0, bx, 0, true)) pan += g.out.dx;
    }
    expect(g.zoomed).toBe(false);
    expect(pan).toBeCloseTo(200);
  });

  it('an anchored pinch (one finger still) engages on its second event past the boundary', () => {
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    g.update(0, 0, 103, 0, true);
    g.update(0, 0, 106, 0, true);
    expect(g.zoomed).toBe(false);
    g.update(0, 0, 109, 0, true);
    expect(g.zoomed).toBe(true);
    expect(g.out.factor).toBeCloseTo(109 / 104, 10);
  });

  it('pinch-in mirrors pinch-out', () => {
    const g = new TwoFinger();
    g.start(0, 0, 100, 0);
    let total = 1;
    for (let d = 100; d >= 50; d -= 5) if (g.update(50 - d / 2, 0, 50 + d / 2, 0, true)) total *= g.out.factor;
    expect(total).toBeCloseTo(50 / (100 * (1 - PINCH_DEAD)), 10);
  });

  it('coincident fingers do not divide by zero', () => {
    const g = new TwoFinger();
    g.start(10, 10, 10, 10);
    expect(g.update(10, 10, 40, 10, true)).toBe(true);
    expect(Number.isFinite(g.out.factor)).toBe(true);
  });
});
