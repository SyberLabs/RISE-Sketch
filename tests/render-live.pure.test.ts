/**
 * render-live: pure helpers (hot decay, window edge, reveal schedules, dirty rects, the arc
 * clock, halo brightness, colour parsing, prediction caps).
 */
import { describe, it, expect } from 'vitest';
import {
  ArcClock, CHILD_AT, HOT, HOT_EDGE, HOT_WINDOW, RectList, chainReveal, cssRgb, echoFoldMs, genOffset, genPhase,
  haloAlpha, hotEta, hotMultiplier, revealMs, windowEdge,
} from '../src/render/live';
import { capPrediction, PRED_MAX_MS, PRED_MAX_PX } from '../src/render/overlay';
import { easeOutCubic } from '../src/core/num';
import type { InputSample } from '../src/core/types';

describe('hot ink decay (DESIGN §3.2)', () => {
  it('η is 1 when fresh and exactly 0 from 3τ', () => {
    for (const tau of [220, 380]) {
      expect(hotEta(0, tau)).toBe(1);
      expect(hotEta(-50, tau)).toBe(1);
      expect(hotEta(3 * tau, tau)).toBe(0);
      expect(hotEta(3 * tau + 1, tau)).toBe(0);
      expect(hotEta(1e9, tau)).toBe(0);
      expect(hotEta(3 * tau - 1, tau)).toBeGreaterThan(0);
      expect(hotEta(3 * tau - 1, tau)).toBeLessThan(1e-3);
    }
  });

  it('η follows the renormalised exponential and decreases monotonically', () => {
    const tau = 220, e3 = Math.exp(-3);
    let prev = 2;
    for (let a = 0; a <= 3 * tau; a += 5) {
      const v = hotEta(a, tau);
      expect(v).toBeCloseTo(Math.max(0, (Math.exp(-a / tau) - e3) / (1 - e3)), 12);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it('NaN ages are cold, never hot', () => {
    expect(hotEta(NaN, 220)).toBe(0);
  });

  it('the multiplier lands exactly on 1 (the committed alpha) and peaks at 1 + h', () => {
    expect(hotMultiplier(0, 'night')).toBeCloseTo(1.45, 12);
    expect(hotMultiplier(0, 'paper')).toBeCloseTo(1.25, 12);
    expect(hotMultiplier(3 * HOT.night.tau, 'night')).toBe(1);
    expect(hotMultiplier(3 * HOT.paper.tau, 'paper')).toBe(1);
    // within 1.14 s on either ground
    expect(3 * HOT.paper.tau).toBeLessThanOrEqual(1140);
  });

  it('the window edge cools the far end of a full window spatially, without a step', () => {
    const tip = 500;
    expect(windowEdge(tip - HOT_WINDOW, tip)).toBe(0);
    expect(windowEdge(tip - HOT_WINDOW - 10, tip)).toBe(0);
    expect(windowEdge(tip - HOT_WINDOW + HOT_EDGE, tip)).toBe(1);
    expect(windowEdge(tip, tip)).toBe(1);
    let prev = 0;
    for (let s = tip - HOT_WINDOW; s <= tip; s += 1) {
      const v = windowEdge(s, tip);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v - prev).toBeLessThan(0.08);
      prev = v;
    }
  });
});

describe('reveal schedules (DESIGN §3.2, §6.6)', () => {
  it('reveal times per Form', () => {
    expect(revealMs('line')).toBe(160);
    expect(revealMs('sprout')).toBe(280);
    expect(revealMs('drift')).toBe(240);
  });

  it('a Sprout child starts when its parent reaches 60 %', () => {
    expect(easeOutCubic(CHILD_AT)).toBeCloseTo(0.6, 12);
    expect(genOffset('sprout', 1, 280)).toBe(0);
    expect(genOffset('sprout', 2, 280)).toBeCloseTo(CHILD_AT * 280, 9);
    expect(genOffset('sprout', 3, 280)).toBeCloseTo(2 * CHILD_AT * 280, 9);
    expect(genOffset('drift', 3, 240)).toBe(0);
  });

  it('Echo fold-out T = clamp(350 + 120·d, 350, 1100)', () => {
    expect(echoFoldMs(0)).toBe(350);
    expect(echoFoldMs(2)).toBe(590);
    expect(echoFoldMs(5)).toBe(950);
    expect(echoFoldMs(9)).toBe(1100);
    expect(echoFoldMs(-3)).toBe(350);
  });

  it('chains reveal as one filament: thirds fill in order', () => {
    const len = [10, 10, 10], off = [0, 10, 20], tot = 30;
    const at = (f: number): number[] => len.map((l, i) => chainReveal(f, off[i], tot, l));
    expect(at(0)).toEqual([0, 0, 0]);
    expect(at(1 / 3)).toEqual([1, 0, 0]);
    expect(at(0.5)[1]).toBeCloseTo(0.5, 12);
    expect(at(1)).toEqual([1, 1, 1]);
    // an unchained poly reveals by f itself
    expect(chainReveal(0.4, 0, 10, 10)).toBe(0.4);
  });

  it('un-grow retracts the deepest generation first and the spine last', () => {
    const dur = 200, G = 3;
    const u = (t: number, g: number): number => genPhase(t, dur, g, G, true);
    expect(u(0, 3)).toBe(0);
    // early on the deepest generation is already retracting while the spine has not moved
    expect(u(30, 3)).toBeGreaterThan(0);
    expect(u(30, 0)).toBe(0);
    for (let t = 0; t <= dur; t += 10) {
      for (let g = 1; g <= G; g++) expect(u(t, g)).toBeGreaterThanOrEqual(u(t, g - 1));
    }
    for (let g = 0; g <= G; g++) expect(u(dur, g)).toBe(1);
  });

  it('re-growth runs the spine first and finishes every generation on time', () => {
    const dur = 320, G = 2;
    const u = (t: number, g: number): number => genPhase(t, dur, g, G, false);
    expect(u(40, 0)).toBeGreaterThan(0);
    expect(u(40, 2)).toBe(0);
    for (let g = 0; g <= G; g++) expect(u(dur, g)).toBe(1);
    // consecutive generations overlap by half a phase
    const slot = dur / (G + 2);
    expect(u(slot, 1)).toBe(0);
    expect(u(slot * 2, 0)).toBe(1);
    expect(u(slot * 1.5, 1)).toBeGreaterThan(0);
    expect(u(slot * 1.5, 0)).toBeLessThan(1);
  });

  it('a stroke with only a spine grows over the whole duration', () => {
    expect(genPhase(0, 200, 0, 0, false)).toBe(0);
    expect(genPhase(100, 200, 0, 0, false)).toBeCloseTo(0.5, 12);
    expect(genPhase(200, 200, 0, 0, false)).toBe(1);
  });
});

describe('RectList (dirty rects)', () => {
  it('snaps outward to whole device pixels', () => {
    const r = new RectList();
    r.add(10.2, 20.7, 30.1, 40.01);
    expect(r.n).toBe(1);
    expect(Array.from(r.r.subarray(0, 4))).toEqual([10, 20, 31, 41]);
  });

  it('merges rects that touch or come within the gap, keeps far ones apart', () => {
    const r = new RectList(8, 8);
    r.add(0, 0, 10, 10);
    r.add(15, 0, 25, 10);        // within 8 px: merges
    expect(r.n).toBe(1);
    r.add(200, 200, 210, 210);   // far: separate
    expect(r.n).toBe(2);
    r.add(5, 5, 205, 205);       // bridges both
    expect(r.n).toBe(1);
    const b = { x0: 0, y0: 0, x1: 0, y1: 0 };
    r.bbox(b);
    expect(b).toEqual({ x0: 0, y0: 0, x1: 210, y1: 210 });
  });

  it('never exceeds its cap: the cheapest pair merges', () => {
    const r = new RectList(4, 0);
    for (let k = 0; k < 12; k++) r.add(k * 100, 0, k * 100 + 10, 10);
    expect(r.n).toBeLessThanOrEqual(4);
    const b = { x0: 0, y0: 0, x1: 0, y1: 0 };
    r.bbox(b);
    expect(b.x0).toBe(0);
    expect(b.x1).toBe(1110);
  });

  it('ignores empty and NaN rects; clamps to the canvas', () => {
    const r = new RectList();
    r.add(5, 5, 5, 9);
    r.add(NaN, 0, 10, 10);
    expect(r.n).toBe(0);
    r.add(-50, -50, 20, 20);
    r.add(790, 590, 900, 900);
    r.clampTo(800, 600);
    expect(Array.from(r.r.subarray(0, 8))).toEqual([0, 0, 20, 20, 790, 590, 800, 600]);
    r.add(1000, 1000, 1010, 1010);
    r.clampTo(800, 600);
    expect(r.n).toBe(2);
  });

  it('full repaints swallow further rects until cleared', () => {
    const r = new RectList();
    r.setFull();
    r.add(0, 0, 10, 10);
    expect(r.full).toBe(true);
    expect(r.n).toBe(0);
    expect(r.empty).toBe(false);
    r.clear();
    expect(r.empty).toBe(true);
  });
});

describe('ArcClock', () => {
  it('maps arcs to the time the nib reached them, and back', () => {
    const c = new ArcClock();
    c.mark(0, 1000);
    c.mark(10, 1100);
    c.mark(30, 1200);
    expect(c.at(0, 9999)).toBe(1000);
    expect(c.at(5, 9999)).toBeCloseTo(1050, 9);
    expect(c.at(20, 9999)).toBeCloseTo(1150, 9);
    expect(c.at(31, 9999)).toBe(9999);        // not reached yet
    expect(c.arcAt(1150)).toBeCloseTo(20, 9);
    expect(c.arcAt(999)).toBe(-Infinity);
    expect(c.arcAt(5000)).toBe(30);
  });

  it('keeps pauses: the arc holds still while time passes', () => {
    const c = new ArcClock();
    c.mark(0, 0);
    c.mark(20, 100);
    c.mark(20, 600);   // a hold
    c.mark(40, 700);
    expect(c.arcAt(350)).toBe(20);
    expect(c.at(20, 1e9)).toBe(100);
    expect(c.at(30, 1e9)).toBeCloseTo(650, 9);
  });

  it('never runs backwards and drops redundant marks', () => {
    const c = new ArcClock();
    c.mark(10, 0);
    c.mark(5, 50);     // arc clamps to 10, the time is a pause
    c.mark(10.1, 60);  // too close to bother
    c.mark(20, 40);    // time not increasing: ignored
    expect(c.n).toBe(2);
    expect(c.last).toBe(10);
  });

  it('fast-forward ages everything up to an arc', () => {
    const c = new ArcClock();
    c.mark(0, 0); c.mark(100, 1000);
    c.agedTo = 50;
    expect(c.at(40, 0)).toBe(-Infinity);
    expect(c.at(60, 0)).toBeCloseTo(600, 9);
  });
});

describe('halo brightness (DESIGN §3.1, §6.6)', () => {
  it('is 0.15 + 0.5·level, faded in by pre', () => {
    expect(haloAlpha(1, 0, -1, false)).toBeCloseTo(0.15, 12);
    expect(haloAlpha(1, 1, -1, false)).toBeCloseTo(0.65, 12);
    expect(haloAlpha(0.5, 0.5, -1, false)).toBeCloseTo(0.2, 12);
    expect(haloAlpha(0, 1, -1, false)).toBe(0);
  });

  it('flashes ×1.8 at the brim for 160 ms, then settles', () => {
    expect(haloAlpha(1, 1, 0, false)).toBeCloseTo(0.65 * 1.8, 12);
    expect(haloAlpha(1, 1, 90, false)).toBeCloseTo(0.65 * 1.8, 12);
    expect(haloAlpha(1, 1, 130, false)).toBeGreaterThan(0.65);
    expect(haloAlpha(1, 1, 130, false)).toBeLessThan(0.65 * 1.8);
    expect(haloAlpha(1, 1, 160, false)).toBeCloseTo(0.65, 12);
  });

  it('under reduced motion: static, quarter steps, no flash', () => {
    expect(haloAlpha(0.3, 0.6, 0, true)).toBe(0);
    expect(haloAlpha(0.7, 0.6, 0, true)).toBeCloseTo(0.15 + 0.5 * 0.5, 12);
    expect(haloAlpha(1, 0.9, 10, true)).toBeCloseTo(0.65, 12);
  });
});

describe('cssRgb', () => {
  it('parses hex and rgb()', () => {
    const o = new Uint8Array(3);
    expect(cssRgb('#1d5b8a', o)).toBe(true);
    expect(Array.from(o)).toEqual([0x1d, 0x5b, 0x8a]);
    expect(cssRgb('#fa0', o)).toBe(true);
    expect(Array.from(o)).toEqual([255, 170, 0]);
    expect(cssRgb('rgb(12, 34, 56)', o)).toBe(true);
    expect(Array.from(o)).toEqual([12, 34, 56]);
    expect(cssRgb('rgba(1,2,3,0.5)', o)).toBe(true);
    expect(Array.from(o)).toEqual([1, 2, 3]);
    expect(cssRgb('oklch(.5 .1 30)', o)).toBe(false);
    expect(cssRgb('#zzzzzz', o)).toBe(false);
  });
});

describe('prediction caps (DESIGN §2.2.2)', () => {
  const S = (x: number, y: number, t: number, predicted: boolean): InputSample =>
    ({ x, y, t, p: 0.5, alt: Math.PI / 2, az: 0, r: NaN, predicted });

  it('keeps real points, caps predicted ones at 24 px of path', () => {
    const out = { n: 0, xy: new Float64Array(4) };
    const tail = [S(0, 0, 100, false), S(10, 0, 104, true), S(20, 0, 108, true), S(30, 0, 112, true)];
    expect(capPrediction(tail, out)).toBe(4);
    expect(out.xy[6]).toBeCloseTo(PRED_MAX_PX, 9);
    expect(out.xy[7]).toBe(0);
  });

  it('caps predicted samples at 16 ms past the last real sample', () => {
    const out = { n: 0, xy: new Float64Array(4) };
    const tail = [S(0, 0, 100, false), S(2, 0, 108, true), S(4, 0, 116, true), S(6, 0, 124, true)];
    expect(capPrediction(tail, out)).toBe(3);
    expect(116 - 100).toBeLessThanOrEqual(PRED_MAX_MS);
  });

  it('bridge points without a time do not cap; NaN positions are skipped', () => {
    const out = { n: 0, xy: new Float64Array(2) };
    const tail = [S(0, 0, NaN, false), S(NaN, 3, NaN, false), S(1, 1, NaN, false), S(2, 2, 500, true)];
    expect(capPrediction(tail, out)).toBe(3);
  });
});
