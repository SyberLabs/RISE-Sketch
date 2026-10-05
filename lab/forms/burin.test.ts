import { describe, it, expect } from 'vitest';
import * as burin from './burin.form';
import { checkIncremental, labCook, problems, Hand, cookedHash } from './harness';
import type { Cooked } from '../../src/core/types';

// ---------------------------------------------------------------------------- gestures

const signature = (seed = 3, o: { alt?: number; az?: number } = {}) => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3, ...o });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9);
  h.moveTo(150, 110, 1.3, 0.55).arc(200, 110, 50, Math.PI, 1.9 * Math.PI, 1.6);
  h.moveTo(300, 40, 2.3, 0.25);
  return h;
};
const loop = (seed = 7) => {
  const h = new Hand(170, 90, { jitter: 0.15, seed, p: 0.6 });
  h.arc(110, 90, 60, 0, 2 * Math.PI * 1.01, 0.8);
  return h;
};
const corners = (seed = 9) => {
  const h = new Hand(10, 140, { jitter: 0.2, seed, p: 0.55 });
  h.moveTo(60, 20, 0.5).moveTo(61, 21, 0.05).hold(70).moveTo(130, 150, 0.6).moveTo(131, 149, 0.05).hold(70);
  h.moveTo(200, 20, 0.6).moveTo(201, 21, 0.05).hold(70).moveTo(280, 140, 0.9, 0.3);
  return h;
};
const straight = (p = 0.5, v = 0.6, seed = 21) => {
  const h = new Hand(0, 0, { jitter: 0.1, seed, p });
  h.moveTo(300, 0, v);
  return h;
};
const tap = (hold = 60, seed = 13) => {
  const h = new Hand(0, 0, { jitter: 0.05, seed, p: 0.65 });
  h.hold(hold);
  return h;
};
const sweep = (seed = 21) => {
  const h = new Hand(0, 40, { jitter: 0.2, seed, p: 0.45 });
  h.moveTo(60, 0, 0.7, 0.75).arc(100, 40, 50, -Math.PI / 2, Math.PI / 2, 0.9).moveTo(200, 120, 1.2, 0.35);
  return h;
};

// ---------------------------------------------------------------------------- helpers

interface Poly { gen: number; kind: number; n: number; x: number; y: number; w: number; x1: number; y1: number; unit: number; alpha: number }
function polys(c: Cooked): Poly[] {
  const out: Poly[] = [];
  for (let i = 0; i < c.nPolys; i++) {
    const s = c.start[i], n = c.count[i], e = s + n - 1;
    out.push({ gen: c.gen[i], kind: c.kind[i], n, x: c.pts[4 * s], y: c.pts[4 * s + 1], w: c.pts[4 * s + 2], x1: c.pts[4 * e], y1: c.pts[4 * e + 1], unit: c.unit[i], alpha: c.alpha[i] });
  }
  return out;
}
const ticks = (c: Cooked, gen?: number) => polys(c).filter(p => p.gen >= 1 && p.kind !== 2 && (gen === undefined || p.gen === gen));
const dots = (c: Cooked) => polys(c).filter(p => p.kind === 2 && p.gen >= 1);
/** Signed side of a tick's root relative to its unit's spine point: here the straight stroke runs along +x at y = 0. */
const sideY = (p: Poly) => Math.sign(p.y);

/** Max over polys of the belly width / root width ratio (a lozenge has a visible belly). */
function bellyRatio(c: Cooked): number {
  let best = 0;
  for (let i = 0; i < c.nPolys; i++) {
    if (c.gen[i] !== 1 || c.kind[i] === 2 || c.count[i] < 5) continue;
    const s = c.start[i];
    const w0 = c.pts[4 * s + 2], wm = c.pts[4 * (s + 2) + 2];
    best = Math.max(best, wm / w0);
  }
  return best;
}

/** Every point of poly i as [x, y]. */
function ptsOf(c: Cooked, i: number): [number, number][] {
  const s = c.start[i], out: [number, number][] = [];
  for (let k = 0; k < c.count[i]; k++) out.push([c.pts[4 * (s + k)], c.pts[4 * (s + k) + 1]]);
  return out;
}
/** Whether segments ab and cd properly cross. */
function crosses(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(c, d, a) * o(c, d, b) < 0 && o(a, b, c) * o(a, b, d) < 0;
}

// ---------------------------------------------------------------------------- tests

describe('burin: harness invariants', { timeout: 30000 }, () => {
  it('cooks the signature and is structurally sound', () => {
    const { c } = labCook(burin, signature());
    expect(c.nPts).toBeGreaterThan(200);
    expect(problems(c)).toEqual([]);
    expect(ticks(c, 1).length).toBeGreaterThan(20);
  });

  it('is deterministic (cookedHash) across repeated cooks', () => {
    expect(cookedHash(labCook(burin, signature()).c)).toBe(cookedHash(labCook(burin, signature()).c));
    expect(cookedHash(labCook(burin, loop(), { closed: true }).c)).toBe(cookedHash(labCook(burin, loop(), { closed: true }).c));
  });

  it('incremental ≡ full on 3 gestures with holds and closure flicker', () => {
    expect(checkIncremental(burin, signature(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(checkIncremental(burin, loop(), { closed: true, holds: [[20, 2], [40, 1]], flickerClosure: true })).toBeNull();
    expect(checkIncremental(burin, corners(), { holds: [[12, 2.5]], pools: [95, 2.5, 230, 1.5], flickerClosure: true })).toBeNull();
  });

  it('incremental ≡ full with a deep pool at the tail and on a chisel nib', () => {
    expect(checkIncremental(burin, sweep(), { pools: [150, 2], nib: 'chisel', size: 12 })).toBeNull();
    expect(checkIncremental(burin, signature(5), { nib: 'pen', size: 2.5, base: 4 })).toBeNull();
  });

  it('honours the unit and stroke budgets', () => {
    const { c } = labCook(burin, signature(), { base: 4 });
    const perUnit = new Map<number, number>();
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) perUnit.set(c.unit[i], (perUnit.get(c.unit[i]) ?? 0) + c.count[i]);
    for (const n of perUnit.values()) expect(n).toBeLessThanOrEqual(burin.ops.unitBudget);
    let growth = 0;
    for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) growth += c.count[i];
    expect(growth).toBeLessThanOrEqual(burin.ops.strokeBudget);
    expect(problems(c)).toEqual([]);
  });

  it('survives degenerate input: a 2-sample stroke and a tap, at every depth', () => {
    const two = new Hand(0, 0, { seed: 1, p: 0.5 });
    two.moveTo(1, 0.5, 0.05);
    for (const base of [0, 1, 2.5, 4]) {
      const a = labCook(burin, two, { base }).c;
      expect(problems(a)).toEqual([]);
      const b = labCook(burin, tap(), { base, radial: true }).c;
      expect(problems(b)).toEqual([]);
      const d = labCook(burin, tap(800), { base, radial: true, pools: [0, 1.5] }).c;
      expect(problems(d)).toEqual([]);
    }
  });

  it('is continuous in depth: a 1/16 step changes little (no pop)', () => {
    // drawn growth ink: Σ over gen ≥ 1 polys of (polyline length + width) — what the eye sees
    const ink = (c: Cooked): number => {
      let t = 0;
      for (let i = 0; i < c.nPolys; i++) {
        if (c.gen[i] < 1) continue;
        const s = c.start[i], n = c.count[i];
        let l = c.pts[4 * s + 2];
        for (let k = 1; k < n; k++) l += Math.hypot(c.pts[4 * (s + k)] - c.pts[4 * (s + k - 1)], c.pts[4 * (s + k) + 1] - c.pts[4 * (s + k - 1) + 1]);
        t += l;
      }
      return t;
    };
    let prev = ink(labCook(burin, sweep(), { base: 0 }).c);
    expect(prev).toBe(0);
    const steps: number[] = [];
    for (let k = 1; k <= 64; k++) {
      const v = ink(labCook(burin, sweep(), { base: k / 16 }).c);
      steps.push(v - prev);
      prev = v;
    }
    // no sixteenth adds more than 1/12 of the final ink, and nothing ever disappears
    for (const d of steps) { expect(d).toBeGreaterThanOrEqual(-1e-6); expect(d).toBeLessThanOrEqual(prev / 12); }
    // the drawn tick tips move continuously: compare d = 0.5 and 0.5625
    const a = ticks(labCook(burin, sweep(), { base: 0.5 }).c, 1), b = ticks(labCook(burin, sweep(), { base: 0.5625 }).c, 1);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(Math.hypot(a[i].x1 - b[i].x1, a[i].y1 - b[i].y1)).toBeLessThan(3);
  });
});

describe('burin: acceptance criteria', { timeout: 30000 }, () => {
  it('1. light reads: on a straight run the ticks sit on one side (the shadow side of the up-left lamp), as lozenges', () => {
    const { c } = labCook(burin, straight(), { base: 1 });
    const t = ticks(c, 1);
    expect(t.length).toBeGreaterThan(20);
    // light travels down-right: the shadow side of a stroke along +x is +y (y-down screen)
    const below = t.filter(p => sideY(p) > 0).length;
    expect(below / t.length).toBeGreaterThan(0.95);
    // lozenge: the belly is clearly wider than the root
    expect(bellyRatio(c)).toBeGreaterThan(2);
  });

  it('1b. the pen lean is the light: leaning the pen flips the shadow side', () => {
    // azimuth pointing to −y (up): the lamp is above, so the shadow side is +y; azimuth +y: the shadow side is −y
    const up = ticks(labCook(burin, straight(0.5, 0.6, 21), { base: 1 }).c, 1);
    const hUp = new Hand(0, 0, { jitter: 0.1, seed: 21, p: 0.5, alt: 0.3, az: -Math.PI / 2 }); hUp.moveTo(300, 0, 0.6);
    const hDn = new Hand(0, 0, { jitter: 0.1, seed: 21, p: 0.5, alt: 0.3, az: Math.PI / 2 }); hDn.moveTo(300, 0, 0.6);
    const a = ticks(labCook(burin, hUp, { base: 1 }).c, 1), b = ticks(labCook(burin, hDn, { base: 1 }).c, 1);
    expect(a.filter(p => sideY(p) > 0).length / a.length).toBeGreaterThan(0.95);
    expect(b.filter(p => sideY(p) < 0).length / b.length).toBeGreaterThan(0.95);
    expect(up.length).toBeGreaterThan(0);
  });

  it('1c. ticks switch sides where the line turns: the shadow stays down-right of the lamp', () => {
    // right along +x, then down along +y: light travels down-right, so the shadow is +y on the first leg (the
    // stroke's right-hand side) and +x on the second (its left-hand side)
    const h = new Hand(0, 0, { jitter: 0.1, seed: 31, p: 0.5 });
    h.moveTo(200, 0, 0.6).moveTo(200, 200, 0.6);
    const t = ticks(labCook(burin, h, { base: 1 }).c, 1);
    const legA = t.filter(p => p.x < 170), legB = t.filter(p => p.y > 30);
    expect(legA.length).toBeGreaterThan(10); expect(legB.length).toBeGreaterThan(10);
    expect(legA.filter(p => p.y1 > p.y + 1).length / legA.length).toBeGreaterThan(0.95);
    expect(legB.filter(p => p.x1 > p.x + 1).length / legB.length).toBeGreaterThan(0.95);
  });

  it('2. the sphere: a closed loop is hatched inside on the lower-right rim and bare on the upper-left', () => {
    const { c } = labCook(burin, loop(), { closed: true, base: 1 });
    const t = ticks(c, 1);
    expect(t.length).toBeGreaterThan(10);
    const cx = 110, cy = 90; // loop centre in sp (origin-relative doc at z = 1)
    let inside = 0, lowerRight = 0, upperLeft = 0;
    for (const p of t) {
      const rr = Math.hypot(p.x - cx, p.y - cy), rt = Math.hypot(p.x1 - cx, p.y1 - cy);
      if (rt < rr) inside++;
      const ang = Math.atan2(p.y - cy, p.x - cx); // y-down: lower-right is ang in (0, π/2)
      if (ang > -0.3 && ang < Math.PI / 2 + 0.3) lowerRight++;
      if (ang < -Math.PI / 2 + 0.3 && ang > -Math.PI + 0.3 || ang > Math.PI - 0.3) upperLeft++;
    }
    expect(inside / t.length).toBeGreaterThan(0.85);
    expect(lowerRight).toBeGreaterThan(t.length * 0.5);
    expect(upperLeft).toBeLessThan(t.length * 0.1);
    // no tick crosses the trunk: every point of an inward tick stays inside the spine circle (r = 60)
    for (let i = 0; i < c.nPolys; i++) {
      if (c.gen[i] < 1 || c.kind[i] === 2) continue;
      const P = ptsOf(c, i), r0 = Math.hypot(P[0][0] - cx, P[0][1] - cy), r1 = Math.hypot(P[P.length - 1][0] - cx, P[P.length - 1][1] - cy);
      if (r1 < r0) for (const [x, y] of P) expect(Math.hypot(x - cx, y - cy)).toBeLessThan(60);
    }
    // at base depth (2: shadow ticks + their infill) no tick crosses another
    const b = labCook(burin, loop(), { closed: true }).c;
    const segs: { i: number; a: number[]; b: number[] }[] = [];
    for (let i = 0; i < b.nPolys; i++) {
      if (b.gen[i] < 1 || b.kind[i] === 2) continue;
      const P = ptsOf(b, i);
      for (let k = 1; k < P.length; k++) segs.push({ i, a: P[k - 1], b: P[k] });
    }
    expect(segs.length).toBeGreaterThan(40);
    let crossings = 0;
    for (let u = 0; u < segs.length; u++) for (let v = u + 1; v < segs.length; v++) {
      if (segs[u].i !== segs[v].i && crosses(segs[u].a, segs[u].b, segs[v].a, segs[v].b)) crossings++;
    }
    expect(crossings).toBe(0);
  });

  it('3. tone ladder: d = 2 single hatching, d = 3 cross-hatching, d = 4 three families + stipple; the held tap is a stippled disc', () => {
    const d2 = labCook(burin, sweep(), { base: 2 }).c, d3 = labCook(burin, sweep(), { base: 3 }).c, d4 = labCook(burin, sweep(), { base: 4 }).c;
    expect(ticks(d2, 3).length).toBe(0); expect(ticks(d2, 4).length).toBe(0); expect(dots(d2).length).toBe(0);
    expect(ticks(d3, 3).length).toBeGreaterThan(10); expect(ticks(d3, 4).length).toBe(0); expect(dots(d3).length).toBe(0);
    expect(ticks(d4, 4).length).toBeGreaterThan(10); expect(dots(d4).length).toBeGreaterThan(10);
    // a triple crossing peaks at ≈ 0.55 + 0.35 + 0.35 = 1.25 < 2: never a white patch
    for (let i = 0; i < d4.nPolys; i++) if (d4.gen[i] >= 1) expect(d4.alpha[i]).toBeLessThanOrEqual(0.5501);
    const t = labCook(burin, tap(800), { radial: true, pools: [0, 2] }).c;
    expect(dots(t).length).toBeGreaterThan(30);
    expect(problems(t)).toEqual([]);
  });

  it('gesture grammar: pressure packs the ticks, speed shortens and skews them, crowding sparsens them', () => {
    const light = ticks(labCook(burin, straight(0.2), { base: 1 }).c, 1), heavy = ticks(labCook(burin, straight(0.9), { base: 1 }).c, 1);
    expect(heavy.length).toBeGreaterThan(light.length * 1.4);
    const slow = ticks(labCook(burin, straight(0.5, 0.3), { base: 1 }).c, 1), fast = ticks(labCook(burin, straight(0.5, 3), { base: 1 }).c, 1);
    const len = (p: Poly) => Math.hypot(p.x1 - p.x, p.y1 - p.y);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(fast.map(len))).toBeLessThan(mean(slow.map(len)) * 0.8);
    // fast ticks lean back: their tip sits further behind their root (along −x) than a slow tick's (whose flick alone is ≈ 0.15ℓ)
    const lean = (p: Poly) => (p.x1 - p.x) / Math.max(1, len(p));
    expect(mean(fast.map(lean))).toBeLessThan(mean(slow.map(lean)) - 0.25);
    const hc = new Hand(0, 0, { jitter: 0.1, seed: 21, p: 0.5, c: 0.8 }); hc.moveTo(300, 0, 0.6);
    const crowded = ticks(labCook(burin, hc, { base: 1 }).c, 1);
    expect(crowded.length).toBeLessThan(slow.length * 0.8);
  });

  it('corners stay open: no tick roots within 3 sp of a corner station', () => {
    const { c } = labCook(burin, corners(), { base: 1 });
    expect(ticks(c, 1).length).toBeGreaterThan(20);
    // the three corners are at (60,20), (130,150), (200,20) in sp
    const cs = [[60, 20], [130, 150], [200, 20]];
    for (const p of ticks(c, 1)) for (const [x, y] of cs) expect(Math.hypot(p.x - x, p.y - y)).toBeGreaterThan(3);
  });
});
