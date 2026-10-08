import { describe, it, expect } from 'vitest';
import { ripple, ringsAt, ringBucket, baseOffset } from '../src/ink/operators/ripple.v2';
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
const longSlow = () => {
  const h = new Hand(0, 0, { jitter: 0.1, seed: 5, p: 0.9 });
  for (let i = 0; i < 12; i++) h.arc(200 * (i % 2), 0, 200, i % 2 ? Math.PI : 0, i % 2 ? 2 * Math.PI : Math.PI, 0.2);
  return h;
};

// ---------------------------------------------------------------------------- helpers

const P = (c: Cooked, j: number): [number, number] => [c.pts[4 * j], c.pts[4 * j + 1]];
const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Growth points of ring k (gen k), optionally only one side of the straight trunk y = 100. */
function ringPts(c: Cooked, k: number, side = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = c.genStart[1]; i < c.nPolys; i++) {
    if (c.gen[i] !== k) continue;
    for (let q = 0; q < c.count[i]; q++) {
      const p = P(c, c.start[i] + q);
      if (side === 0 || Math.sign(p[1] - 100) === side) out.push(p);
    }
  }
  return out;
}
const gens = (c: Cooked): Set<number> => { const s = new Set<number>(); for (let i = c.genStart[1]; i < c.nPolys; i++) s.add(c.gen[i]); return s; };
/** Σ alpha·width·length over growth polys (how much ring ink there is). */
function ink(c: Cooked): number {
  let t = 0;
  for (let i = c.genStart[1]; i < c.nPolys; i++) {
    for (let q = 1; q < c.count[i]; q++) {
      const j = c.start[i] + q, a = P(c, j - 1), b = P(c, j);
      t += c.alpha[i] * 0.5 * (c.pts[4 * j + 2] + c.pts[4 * j - 2]) * dist(a, b);
    }
  }
  return t;
}
/** Mean |offset| from y = 100 of ring k on one side in an x bin. */
function meanOff(c: Cooked, k: number, side: number, x0: number, x1: number): number {
  let s = 0, n = 0;
  for (const [x, y] of ringPts(c, k, side)) if (x >= x0 && x < x1) { s += Math.abs(y - 100); n++; }
  return n ? s / n : NaN;
}

// ---------------------------------------------------------------------------- invariants

describe('ripple: pipeline invariants', () => {
  it('is deterministic and structurally sound on the signature', () => {
    const { c } = opsCook(ripple, sig());
    expect(c.nPts).toBeGreaterThan(1000);
    expect(c.genStart.length).toBeGreaterThan(3); // trunk + several ring generations
    expect(cookedProblems(c)).toEqual([]);
    expect(cookedHash(opsCook(ripple, sig()).c)).toBe(cookedHash(c));
  });

  it('incremental ≡ full under chunking, holds and closure flicker (3 gestures)', () => {
    expect(opsIncremental(ripple, sig(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(ripple, loop(), { closed: true, holds: [[20, 2], [40, 1]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(ripple, corners(), { holds: [[12, 2.5]], flickerClosure: true, pools: [95, 2] })).toBeNull();
    expect(opsIncremental(ripple, sig(4), { base: 6, flickerClosure: true })).toBeNull();
  }, 120_000);

  it('incremental ≡ full on a long slow stroke that exhausts the causal budget', () => {
    expect(opsIncremental(ripple, longSlow(), { chunks: [7, 500], base: 5 })).toBeNull();
  }, 120_000);

  it('honours the budgets', () => {
    for (const base of [2, 6]) {
      const { c } = opsCook(ripple, sig(), { base });
      const per = new Map<number, number>();
      let total = 0;
      for (let i = c.genStart[1]; i < c.nPolys; i++) { per.set(c.unit[i], (per.get(c.unit[i]) ?? 0) + c.count[i]); total += c.count[i]; }
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(ripple.unitBudget);
      expect(total).toBeLessThanOrEqual(ripple.strokeBudget);
    }
    const big = opsCook(ripple, longSlow(), { base: 6 }).c;
    let t2 = 0;
    for (let i = big.genStart[1]; i < big.nPolys; i++) t2 += big.count[i];
    expect(t2).toBeLessThanOrEqual(ripple.strokeBudget + ripple.unitBudget);
    expect(t2).toBeGreaterThan(ripple.strokeBudget * 0.9); // it really ran out
    expect(cookedProblems(big)).toEqual([]);
  });

  it('survives degenerate input (2-sample stroke, tap, bloom, base 0, chisel, pen)', () => {
    const two = new Hand(0, 0, { jitter: 0, seed: 1 }); two.moveTo(1, 0.5, 0.1);
    for (const o of [{}, { radial: true }, { base: 0 }, { base: 6 }]) expect(cookedProblems(opsCook(ripple, two, o).c)).toEqual([]);
    const t = opsCook(ripple, tap(), { radial: true }).c;
    expect(cookedProblems(t)).toEqual([]);
    expect(t.nPts).toBeGreaterThan(100);
    expect(cookedProblems(opsCook(ripple, tap(800), { radial: true, pools: [0, 1.5] }).c)).toEqual([]);
    const bare = opsCook(ripple, sig(), { base: 0 }).c;
    expect(bare.genStart.length).toBe(2); // depth 0 is the bare stroke
    expect(cookedProblems(bare)).toEqual([]);
    expect(cookedProblems(opsCook(ripple, sig(), { nib: 'chisel', size: 12 }).c)).toEqual([]);
    expect(cookedProblems(opsCook(ripple, sig(), { nib: 'pen', size: 2.5 }).c)).toEqual([]);
    for (const s of opsLive(ripple, sig(40), [0.3, 0.8, 1], { poolAtTip: 2 })) expect(cookedProblems(s.c)).toEqual([]);
  });

  it('is continuous in depth: a 1/16 level changes the ring ink a little and brings rings in faint', () => {
    const full = ink(opsCook(ripple, sig(), { base: 6 }).c);
    for (let b = 1; b < 96; b += 5) {
      const a = ink(opsCook(ripple, sig(), { base: b / 16 }).c), c = ink(opsCook(ripple, sig(), { base: (b + 1) / 16 }).c);
      expect(c).toBeGreaterThanOrEqual(a * 0.999);
      expect(c - a).toBeLessThan(0.05 * full); // a 1/16 level is never a pop
    }
    const first = opsCook(ripple, sig(), { base: 1 / 16 }).c;
    expect(first.nPolys).toBeGreaterThan(first.genStart[1]);
    for (let i = first.genStart[1]; i < first.nPolys; i++) expect(first.alpha[i]).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------- acceptance criteria

describe('ripple: acceptance', () => {
  it('contours: rings of a straight stroke are ordered outward on both sides, never cross, and widen apart', () => {
    const { c } = opsCook(ripple, straight(0.8), { base: 6 });
    const ks = [...gens(c)].sort((a, b) => a - b);
    expect(ks.length).toBe(10);
    for (const side of [1, -1]) {
      for (let x = 60; x < 340; x += 4) {
        let prev = 0;
        for (const k of ks) {
          const o = meanOff(c, k, side, x, x + 4);
          if (!(o === o)) continue;
          expect(o).toBeGreaterThan(prev);
          prev = o;
        }
      }
    }
    // spacing grows outward (1.18 per ring): the outer gap is several times the inner one
    const g1 = meanOff(c, 2, 1, 100, 300) - meanOff(c, 1, 1, 100, 300), g9 = meanOff(c, 10, 1, 100, 300) - meanOff(c, 9, 1, 100, 300);
    expect(g9 / g1).toBeGreaterThan(3);
  });

  it('one contour per ring: units share their joint points exactly', () => {
    const { c } = opsCook(ripple, sig(), { base: 2 });
    const ends = new Set<string>();
    for (let i = c.genStart[1]; i < c.nPolys; i++) { const p = P(c, c.start[i] + c.count[i] - 1); ends.add(`${c.gen[i]}:${p[0]},${p[1]}`); }
    let joined = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) { const p = P(c, c.start[i]); if (ends.has(`${c.gen[i]}:${p[0]},${p[1]}`)) joined++; }
    expect(joined).toBeGreaterThan(80);
  });

  it('ends: an open stroke wraps every ring round both ends; a closed loop has no caps and joins at the seam', () => {
    const { r, c } = opsCook(ripple, straight(0.8), { base: 2 });
    const sp = spineOf(r);
    const b = baseOffset(sp.w[sp.n >> 1] * sp.z);
    let head = 0, tail = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) for (let q = 0; q < c.count[i]; q++) {
      const [x] = P(c, c.start[i] + q);
      if (x < -0.8 * b) head++;
      if (x > 400 + 0.8 * b) tail++;
    }
    expect(head).toBeGreaterThan(6); expect(tail).toBeGreaterThan(6);
    // closed: the last unit's rings end on unit 0's starts
    const L = opsCook(ripple, loop(), { closed: true, base: 3 }).c;
    const g1 = L.genStart[1];
    let lastU = 0;
    for (let i = g1; i < L.nPolys; i++) lastU = Math.max(lastU, L.unit[i]);
    let checked = 0;
    for (let i = g1; i < L.nPolys; i++) {
      if (L.unit[i] !== lastU || L.gen[i] > 7) continue; // ring 8 is a partial dash at base 3
      const e = P(L, L.start[i] + L.count[i] - 1);
      let best = Infinity;
      for (let j = g1; j < L.nPolys; j++) if (L.unit[j] === 0 && L.gen[j] === L.gen[i]) best = Math.min(best, dist(e, P(L, L.start[j])));
      expect(best).toBeLessThan(0.01);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('loop: inward rings shrink toward the centre and collapse before crossing it', () => {
    const { c } = opsCook(ripple, loop(), { closed: true, base: 6 });
    let minR = Infinity, inner = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) for (let q = 0; q < c.count[i]; q++) {
      const [x, y] = P(c, c.start[i] + q), rr = Math.hypot(x - 110, y - 90); // the loop's centre (Hand coords)
      if (rr < 40) inner++;
      minR = Math.min(minR, rr);
    }
    expect(inner).toBeGreaterThan(100); // a bullseye of inner rings
    expect(minR).toBeGreaterThan(1);    // none folds through the centre
  });

  it('corners: no ring point falls inside the cleanup tube round its own stretch of spine (swallowtails removed)', () => {
    // rings of far parts of the stroke may cross the trunk (self-interference, by design); the
    // cleanup sees the spine within 40 sp of each unit, so that is what is checked
    const { r, c } = opsCook(ripple, corners(), { base: 6 });
    const sp = spineOf(r);
    let wMin = Infinity;
    for (let i = 0; i < sp.n; i++) wMin = Math.min(wMin, sp.w[i] * sp.z);
    const tube = 0.5 * baseOffset(wMin);
    let worst = Infinity, n = 0;
    for (let i = c.genStart[1]; i < c.nPolys; i++) {
      const sj = sp.s[0] + 12 * c.unit[i];
      for (let q = 0; q < c.count[i]; q++) {
        const [x, y] = P(c, c.start[i] + q);
        let d = Infinity;
        for (let s = 0; s < sp.n; s++) if (sp.s[s] >= sj - 30 && sp.s[s] <= sj + 42) d = Math.min(d, Math.hypot(sp.x[s] - x, sp.y[s] - y));
        worst = Math.min(worst, d); n++;
      }
    }
    expect(n).toBeGreaterThan(2000);
    expect(worst).toBeGreaterThan(tube);
  });

  it('speed: a fast hand makes the rings wobble more (relative modulation of an outer ring)', () => {
    const cv = (c: Cooked): number => {
      const xs: number[] = [];
      for (let x = 60; x < 340; x += 6) { const o = meanOff(c, 6, 1, x, x + 6); if (o === o) xs.push(o); }
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length) / m;
    };
    const slow = opsCook(ripple, straight(0.25), { base: 6 }).c, fast = opsCook(ripple, straight(2.4), { base: 6 }).c;
    expect(cv(fast)).toBeGreaterThan(2 * cv(slow));
  });

  it('pressure: pressing harder draws more rings (and brighter)', () => {
    expect(ringsAt(2, 0.9)).toBeGreaterThan(ringsAt(2, 0.15) * 1.6);
    const light = opsCook(ripple, straight(0.8, { p: 0.15 })).c, heavy = opsCook(ripple, straight(0.8, { p: 0.9 })).c;
    expect(gens(heavy).size).toBeGreaterThan(gens(light).size);
    expect(heavy.alpha[heavy.genStart[1]]).toBeGreaterThan(light.alpha[light.genStart[1]]);
  });

  it('holding: a pool blooms extra rings round the hold only', () => {
    const h = straight(0.8);
    const base = opsCook(ripple, h, { base: 2 }).c, pooled = opsCook(ripple, h, { base: 2, pools: [200, 3] }).c;
    const reach = (c: Cooked, x0: number, x1: number): number => {
      let m = 0;
      for (let i = c.genStart[1]; i < c.nPolys; i++) for (let q = 0; q < c.count[i]; q++) {
        const [x, y] = P(c, c.start[i] + q);
        if (x >= x0 && x <= x1) m = Math.max(m, Math.abs(y - 100));
      }
      return m;
    };
    expect(reach(pooled, 170, 210)).toBeGreaterThan(reach(base, 170, 210) * 1.5);
    expect(reach(pooled, 300, 380)).toBeCloseTo(reach(base, 300, 380), 3);
    expect(reach(pooled, 20, 100)).toBeCloseTo(reach(base, 20, 100), 3);
  });

  it('lean: a pen leaning across the stroke spreads the rings on one side', () => {
    const { c } = opsCook(ripple, straight(0.8, { alt: 0.6, az: Math.PI / 2 }), { base: 4 });
    const up = meanOff(c, 3, -1, 100, 300), down = meanOff(c, 3, 1, 100, 300);
    expect(Math.max(up, down) / Math.min(up, down)).toBeGreaterThan(1.3);
  });

  it('nearby ink: side ink packs that side tighter; crowding dims the glow', () => {
    const side = opsCook(ripple, straight(0.8, { cs: 1 }), { base: 4 }).c;
    const up = meanOff(side, 3, -1, 100, 300), down = meanOff(side, 3, 1, 100, 300);
    expect(Math.min(up, down) / Math.max(up, down)).toBeLessThan(0.8);
    const free = opsCook(ripple, straight(0.8)).c, crowded = opsCook(ripple, straight(0.8, { c: 0.8 })).c;
    expect(crowded.alpha[crowded.genStart[1]]).toBeLessThan(free.alpha[free.genStart[1]] * 0.75);
  });

  it('tones and shimmer: ring k takes bucket min(k, 4) then alternates 3 / 4; odd rings brighter than even', () => {
    const { c } = opsCook(ripple, sig(), { base: 6 });
    const aBy = new Map<number, number>();
    for (let i = c.genStart[1]; i < c.nPolys; i++) {
      expect(c.tone[i] % 5).toBe(ringBucket(c.gen[i]));
      aBy.set(c.gen[i], Math.max(aBy.get(c.gen[i]) ?? 0, c.alpha[i]));
    }
    expect([...new Set([...aBy.keys()].map(ringBucket))].sort()).toEqual([1, 2, 3, 4]);
    expect(aBy.get(1)!).toBeGreaterThan(aBy.get(2)!);
    expect(aBy.get(3)!).toBeGreaterThan(aBy.get(2)!);
  });

  it('tap: a bullseye, then a second offset family fades in to beat against it', () => {
    const fam = (b: number) => opsCook(ripple, tap(), { radial: true, base: b }).c;
    const t1 = fam(0.4), t2 = fam(2);
    const n1 = t1.nPolys - t1.genStart[1], n2 = t2.nPolys - t2.genStart[1];
    expect(n2).toBe(2 * Math.ceil(ringsAt(2, 0.65)));          // two full families
    expect(n1).toBe(Math.ceil(ringsAt(0.4, 0.65)));             // one family below D = 0.5
    expect(cookedProblems(t2)).toEqual([]);
    // concentric: ring radii grow with k
    const [x0, y0] = P(t2, t2.start[0]);
    const rOf = (i: number) => { let s = 0; for (let q = 0; q < t2.count[i]; q++) s += dist(P(t2, t2.start[i] + q), [x0, y0]); return s / t2.count[i]; };
    expect(rOf(t2.genStart[1] + 2)).toBeGreaterThan(rOf(t2.genStart[1]));
  });
});
