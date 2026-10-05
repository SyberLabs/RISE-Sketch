import { describe, it, expect } from 'vitest';
import { orbit, period, radius } from '../src/ink/operators/orbit.v1';
import { opsIncremental, opsCook, opsLive, cookedProblems, Hand, cookedHash } from './ink-forms.fixtures';
import { spineOf } from '../src/ink/cook';
import type { Cooked } from '../src/core/types';

// ---------------------------------------------------------------------------- gestures

const sig = (seed = 3) => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9).moveTo(150, 110, 1.3, 0.55).moveTo(300, 40, 2.3, 0.25);
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
const straight = (speed: number, o: { p?: number; alt?: number; az?: number; c?: number; cs?: number; seed?: number } = {}) => {
  const h = new Hand(0, 100, { jitter: 0, seed: o.seed ?? 1, p: o.p ?? 0.5, alt: o.alt, az: o.az, c: o.c, cs: o.cs });
  h.moveTo(400, 100, speed);
  return h;
};
const tap = (hold = 60, seed = 13) => { const h = new Hand(0, 0, { jitter: 0.05, seed, p: 0.65 }); h.hold(hold); return h; };

// ---------------------------------------------------------------------------- helpers

/** Growth (gen ≥ 1) point statistics: |offset| from the straight trunk y = 100 (doc = sp at z 1). */
function growth(c: Cooked, x0 = -Infinity, x1 = Infinity): { n: number; polys: number; maxOff: number; meanOff: number } {
  let n = 0, polys = 0, maxOff = 0, sum = 0;
  for (let i = c.genStart[1]; i < c.nPolys; i++) {
    polys++;
    for (let k = 0; k < c.count[i]; k++) {
      const j = c.start[i] + k, x = c.pts[4 * j], off = Math.abs(c.pts[4 * j + 1] - 100); // points are relative to the origin; the hand runs at y = 100
      if (x < x0 || x > x1) continue;
      n++; sum += off; if (off > maxOff) maxOff = off;
    }
  }
  return { n, polys, maxOff, meanOff: n ? sum / n : 0 };
}
/** Curvature sign changes (inflections) along the growth polys, ignoring near-straight turns. */
function inflections(c: Cooked): number {
  let t = 0;
  for (let i = c.genStart[1]; i < c.nPolys; i++) {
    let last = 0;
    for (let k = 1; k + 1 < c.count[i]; k++) {
      const j = 4 * (c.start[i] + k), P = c.pts;
      const ax = P[j] - P[j - 4], ay = P[j + 1] - P[j - 3], bx = P[j + 4] - P[j], by = P[j + 5] - P[j + 1];
      const cr = (ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-12);
      if (Math.abs(cr) < 0.004) continue;
      const sg = cr > 0 ? 1 : -1;
      if (last !== 0 && sg !== last) t++;
      last = sg;
    }
  }
  return t;
}
const units = (c: Cooked): number => {
  const s = new Set<number>();
  for (let i = c.genStart[1]; i < c.nPolys; i++) s.add(c.unit[i]);
  return s.size;
};
const pt = (c: Cooked, poly: number, k: number): [number, number] => {
  const j = c.start[poly] + k;
  return [c.pts[4 * j], c.pts[4 * j + 1]];
};
const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------------------- invariants

describe('orbit: pipeline invariants', () => {
  it('is deterministic and structurally sound on the signature', () => {
    const { c } = opsCook(orbit, sig());
    expect(c.nPts).toBeGreaterThan(500);
    expect(c.genStart.length).toBe(3);
    expect(cookedProblems(c)).toEqual([]);
    expect(cookedHash(opsCook(orbit, sig()).c)).toBe(cookedHash(c));
  });

  it('incremental ≡ full under chunking, holds and closure flicker (3 gestures)', () => {
    expect(opsIncremental(orbit, sig(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(orbit, loop(), { closed: true, holds: [[20, 2], [40, 1]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(orbit, corners(), { holds: [[12, 2.5]], flickerClosure: true, pools: [95, 2] })).toBeNull();
  }, 60_000); // heavy: many chunkings × holds × flicker; generous for a loaded machine

  it('incremental ≡ full on a long slow stroke that exhausts the causal budget', () => {
    const h = new Hand(0, 0, { jitter: 0.1, seed: 5, p: 0.9 });
    for (let i = 0; i < 12; i++) h.arc(200 * (i % 2), 0, 200, i % 2 ? Math.PI : 0, i % 2 ? 2 * Math.PI : Math.PI, 0.2);
    expect(opsIncremental(orbit, h, { chunks: [7, 500] })).toBeNull();
  }, 60_000);

  it('honours the budgets', () => {
    const { c } = opsCook(orbit, sig());
    const per = new Map<number, number>();
    let total = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) { per.set(c.unit[i], (per.get(c.unit[i]) ?? 0) + c.count[i]); total += c.count[i]; }
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(orbit.unitBudget);
    expect(total).toBeLessThanOrEqual(orbit.strokeBudget);
    const h = new Hand(0, 0, { jitter: 0.1, seed: 5, p: 0.9 });
    for (let i = 0; i < 12; i++) h.arc(200 * (i % 2), 0, 200, i % 2 ? Math.PI : 0, i % 2 ? 2 * Math.PI : Math.PI, 0.2);
    const big = opsCook(orbit, h).c;
    let t2 = 0;
    for (let i = big.genStart[1]; i < big.nPolys; i++) t2 += big.count[i];
    expect(t2).toBeLessThanOrEqual(orbit.strokeBudget + orbit.unitBudget);
    expect(cookedProblems(big)).toEqual([]);
  });

  it('survives degenerate input (2-sample stroke, tap, bloom, base 0)', () => {
    const two = new Hand(0, 0, { jitter: 0, seed: 1 }); two.moveTo(1, 0.5, 0.1);
    for (const o of [{}, { radial: true }, { base: 0 }, { base: 4 }]) {
      const { c } = opsCook(orbit, two, o);
      expect(cookedProblems(c)).toEqual([]);
    }
    const t = opsCook(orbit, tap(), { radial: true }).c;
    expect(cookedProblems(t)).toEqual([]);
    expect(t.nPts).toBeGreaterThan(100);
    const bloom = opsCook(orbit, tap(800), { radial: true, pools: [0, 1.5] }).c;
    expect(cookedProblems(bloom)).toEqual([]);
    const bare = opsCook(orbit, sig(), { base: 0 }).c;
    expect(bare.genStart.length).toBe(2); // depth 0 is the bare stroke
    expect(cookedProblems(bare)).toEqual([]);
    const live = opsLive(orbit, sig(40), [0.3, 0.8, 1], { poolAtTip: 2 });
    for (const s of live) expect(cookedProblems(s.c)).toEqual([]);
  });

  it('is continuous in depth: a 1/16 level moves no point more than ~2 sp and changes no count', () => {
    for (let b = 1; b < 64; b += 7) {
      const a = opsCook(orbit, sig(), { base: b / 16 }).c, c = opsCook(orbit, sig(), { base: (b + 1) / 16 }).c;
      expect(c.nPts).toBe(a.nPts);
      expect(c.nPolys).toBe(a.nPolys);
      let maxD = 0, maxA = 0;
      for (let j = 0; j < a.nPts; j++) maxD = Math.max(maxD, Math.hypot(a.pts[4 * j] - c.pts[4 * j], a.pts[4 * j + 1] - c.pts[4 * j + 1]));
      for (let i = 0; i < a.nPolys; i++) maxA = Math.max(maxA, Math.abs(a.alpha[i] - c.alpha[i]));
      expect(maxD).toBeLessThan(2.2);
      expect(maxA).toBeLessThan(0.2);
    }
    const bare = opsCook(orbit, sig(), { base: 0 }).c, first = opsCook(orbit, sig(), { base: 1 / 16 }).c;
    expect(first.nPts).toBeGreaterThan(bare.nPts);
    for (let i = first.genStart[1]; i < first.nPolys; i++) expect(first.alpha[i]).toBeLessThan(0.1); // fades in from the trunk
  });
});

// ---------------------------------------------------------------------------- acceptance criteria

describe('orbit: acceptance', () => {
  it('1. one rope: consecutive orbits and their thirds share their joint point exactly', () => {
    const { c } = opsCook(orbit, sig());
    let prevEnd: [number, number] | null = null, prevUnit = -1, joints = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) {
      const first = pt(c, i, 0);
      if (prevEnd && (c.unit[i] === prevUnit || c.unit[i] === prevUnit + 1)) { expect(dist(first, prevEnd)).toBe(0); joints++; }
      prevEnd = pt(c, i, c.count[i] - 1); prevUnit = c.unit[i];
    }
    expect(joints).toBeGreaterThan(20);
    expect(units(c)).toBeGreaterThan(8);
  });

  it('1. speed: slow hands make tight round loops, fast hands stretch them (period) and shrink them (radius)', () => {
    const slow = opsCook(orbit, straight(0.25, { p: 0.5 })).c, fast = opsCook(orbit, straight(2.4, { p: 0.5 })).c;
    expect(units(slow)).toBeGreaterThan(units(fast) * 1.6);
    const gs = growth(slow, 120, 320), gf = growth(fast, 120, 320);
    expect(gf.maxOff).toBeLessThan(gs.maxOff * 0.7);
    expect(period(9, 0.2)).toBeLessThan(period(9, 2.4) * 0.5);
    expect(radius(9, 0.5, 2.6, 0)).toBeCloseTo(0.5 * radius(9, 0.5, 0, 0), 6);
  });

  it('2. seam: a closed loop joins itself at the seam and the orbit ends on the start', () => {
    const { c } = opsCook(orbit, loop(), { closed: true });
    const g1 = c.genStart[1];
    const start = pt(c, g1, 0), end = pt(c, c.nPolys - 1, c.count[c.nPolys - 1] - 1);
    expect(dist(start, end)).toBeLessThan(1.5); // sp (z = 1); radius differs only by the hand's own p / speed at the two ends
    expect(cookedProblems(c)).toEqual([]);
    // the last orbit is not a half-size one: its arc span is at least 0.45 of a period
    const last = c.unit[c.nPolys - 1];
    let n = 0;
    for (let i = g1; i < c.nPolys; i++) if (c.unit[i] === last) n += c.count[i];
    expect(n).toBeGreaterThan(40);
  });

  it('2. open stroke: the rope ends on the nib with a tapered width', () => {
    const { c } = opsCook(orbit, straight(0.8));
    const lastPoly = c.nPolys - 1, j = c.start[lastPoly] + c.count[lastPoly] - 1;
    expect(c.pts[4 * j + 2]).toBeLessThan(0.5); // floor-ish: the width tapers to 0.35 sp at L
    expect(Math.abs(c.pts[4 * j] - 400)).toBeLessThan(2); // the hand ends at x = 400 (relative to the origin)
  });

  it('3. depth ladder: d = 1 plain loops, d = 2 frilled, d = 4 lace swollen 1.5×', () => {
    const { r, c: c1 } = opsCook(orbit, straight(0.8), { base: 1 });
    const c2 = opsCook(orbit, straight(0.8), { base: 2 }).c, c4 = opsCook(orbit, straight(0.8), { base: 4 }).c;
    const g1 = growth(c1, 100, 300), g2 = growth(c2, 100, 300), g4 = growth(c4, 100, 300);
    const sp = spineOf(r), mid = sp.n >> 1;
    const R = radius(9, sp.p[mid], sp.vn[mid], 0);
    expect(g1.maxOff).toBeGreaterThan(R * 0.9); expect(g1.maxOff).toBeLessThan(R * 1.1);
    expect(g2.maxOff / g1.maxOff).toBeGreaterThan(1.08); expect(g2.maxOff / g1.maxOff).toBeLessThan(1.25);
    expect(g4.maxOff / g1.maxOff).toBeGreaterThan(1.5 * 1.1); expect(g4.maxOff / g1.maxOff).toBeLessThan(1.5 * 1.3);
    // lace: a plain prolate loop never changes its turning sense; five lobes put two
    // inflections at each of the five dents (≈ 10 per orbit, a few lost at the third joints)
    const i1 = inflections(c1) / units(c1), i2 = inflections(c2) / units(c2), i4 = inflections(c4) / units(c4);
    expect(i1).toBeLessThan(1);
    expect(i2).toBeGreaterThan(7); expect(i2).toBeLessThan(11);
    expect(i4).toBeGreaterThan(i2 + 3); // the ten-fold lace on top of the five lobes
  });

  it('3. tap: a rose drawn as a growing prefix, full at d = 2, moon above', () => {
    const n = (b: number) => { const c = opsCook(orbit, tap(), { radial: true, base: b }).c; let k = 0; for (let i = c.genStart[1]; i < c.nPolys; i++) k += c.count[i]; return k; };
    expect(n(1)).toBeGreaterThan(170); expect(n(1)).toBeLessThan(200);
    expect(n(2)).toBeGreaterThan(350);
    expect(n(4)).toBe(n(2));
    const c = opsCook(orbit, tap(), { radial: true, base: 2 }).c;
    expect(c.genStart[1]).toBe(1); // the gen-0 dot, then three thirds
    expect(c.nPolys).toBe(4);
    expect(new Set([c.tone[1] % 5, c.tone[2] % 5, c.tone[3] % 5]).size).toBe(3);
    // five petals: the distance from the seed peaks five times around the full rose
    const xs: number[] = [], ys: number[] = [];
    for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = i === c.genStart[1] ? 0 : 1; k < c.count[i]; k++) { const [x, y] = pt(c, i, k); xs.push(x); ys.push(y); }
    const [cx0, cy0] = pt(c, 0, 0), rr = xs.map((x, k) => Math.hypot(x - cx0, ys[k] - cy0)), n0 = rr.length - 1;
    let peaks = 0;
    for (let k = 0; k < n0; k++) if (rr[k] > rr[(k + n0 - 1) % n0] && rr[k] >= rr[(k + 1) % n0]) peaks++;
    expect(peaks).toBe(5);
    expect(dist([xs[0], ys[0]], [xs[n0], ys[n0]])).toBeLessThan(1e-3); // the full rose closes
  });

  it('3. tones: every orbit is three thirds with depth buckets 1 / 2 / 3', () => {
    const { c } = opsCook(orbit, sig());
    const per = new Map<number, number[]>();
    for (let i = c.genStart[1]; i < c.nPolys; i++) { const u = c.unit[i]; if (!per.has(u)) per.set(u, []); per.get(u)!.push(c.tone[i] % 5); }
    for (const t of per.values()) expect(t).toEqual([1, 2, 3]);
  });

  it('3. Night: the trail thins where it crosses the trunk (crossings do not blow out), the trunk stays underneath', () => {
    const { c } = opsCook(orbit, straight(0.8, { p: 0.8 }), { base: 1 });
    let on = 0, nOn = 0, off = 0, nOff = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) {
      const j = 4 * (c.start[i] + k), x = c.pts[j], dy = Math.abs(c.pts[j + 1] - 100), w = c.pts[j + 2];
      if (x < 60 || x > 340) continue;
      if (dy < 1) { on += w; nOn++; } else if (dy > 6) { off += w; nOff++; }
    }
    expect(nOn).toBeGreaterThan(10);
    expect(on / nOn).toBeLessThan(0.6 * (off / nOff));
    let trunk = 0;
    for (let i = 0; i < c.genStart[1]; i++) trunk += c.count[i];
    expect(trunk).toBeGreaterThan(20);
  });

  it('pressure: harder pressing widens the orbit', () => {
    const light = growth(opsCook(orbit, straight(0.8, { p: 0.15 })).c), heavy = growth(opsCook(orbit, straight(0.8, { p: 0.9 })).c);
    expect(heavy.maxOff).toBeGreaterThan(light.maxOff * 1.6);
  });

  it('lean: a pen leaning across the stroke squashes the loops into ellipses', () => {
    const up = growth(opsCook(orbit, straight(0.8)).c);
    const lean = growth(opsCook(orbit, straight(0.8, { alt: 0.6, az: Math.PI / 2 })).c); // tilt vector along n
    expect(lean.maxOff).toBeLessThan(up.maxOff * 0.75);
    expect(lean.maxOff).toBeGreaterThan(up.maxOff * 0.4);
  });

  it('holding: a pool adds lace and swell around the hold, plain again beyond 32 sp', () => {
    const h = straight(0.8);
    const base = opsCook(orbit, h, { base: 2 }).c, pooled = opsCook(orbit, h, { base: 2, pools: [200, 2] }).c;
    const offAt = (c: Cooked, lo: number, hi: number): number => {
      let m = 0;
      for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) {
        const j = c.start[i] + k, x = c.pts[4 * j];
        if (x >= lo && x <= hi) m = Math.max(m, Math.abs(c.pts[4 * j + 1] - 100));
      }
      return m;
    };
    expect(offAt(pooled, 170, 215)).toBeGreaterThan(offAt(base, 170, 215) * 1.2);
    expect(offAt(pooled, 300, 400)).toBeCloseTo(offAt(base, 300, 400), 3);
    expect(offAt(pooled, 0, 100)).toBeCloseTo(offAt(base, 0, 100), 3);
  });

  it('nearby ink: crowding shrinks the orbit and side ink squashes the loops away from it', () => {
    const free = growth(opsCook(orbit, straight(0.8)).c);
    const crowded = growth(opsCook(orbit, straight(0.8, { c: 0.8 })).c);
    expect(crowded.maxOff).toBeLessThan(free.maxOff * 0.8);
    const side = opsCook(orbit, straight(0.8, { cs: 1 })).c;
    let up = 0, down = 0;
    for (let i = side.genStart[1]; i < side.nPolys; i++) for (let k = 0; k < side.count[i]; k++) {
      const y = side.pts[4 * (side.start[i] + k) + 1] - 100;
      if (y < 0) up = Math.max(up, -y); else down = Math.max(down, y);
    }
    expect(Math.min(up, down)).toBeLessThan(Math.max(up, down) * 0.7);
  });

  it('nibs: the pen draws a hairline rope, the brush breathes its width with the satellite speed', () => {
    const pen = opsCook(orbit, straight(0.8), { nib: 'pen', size: 2.5 }).c, brush = opsCook(orbit, straight(0.8), { nib: 'brush', size: 9 }).c;
    const ws = (c: Cooked): [number, number] => {
      let lo = Infinity, hi = 0;
      for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) { const w = c.pts[4 * (c.start[i] + k) + 2]; lo = Math.min(lo, w); hi = Math.max(hi, w); }
      return [lo, hi];
    };
    const [plo, phi] = ws(pen), [blo, bhi] = ws(brush);
    expect(phi).toBeLessThan(2);
    expect(bhi).toBeGreaterThan(blo * 1.8);
    expect(cookedProblems(opsCook(orbit, sig(), { nib: 'chisel', size: 12 }).c)).toEqual([]);
    expect(plo).toBeGreaterThan(0.3);
  });
});
