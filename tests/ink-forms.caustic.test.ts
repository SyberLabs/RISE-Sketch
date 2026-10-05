import { describe, it, expect } from 'vitest';
import type { Cooked } from '../src/core/types';
import { caustic } from '../src/ink/operators/caustic.v1';
import { opsIncremental, opsCook, cookedProblems, Hand, cookedHash } from './ink-forms.fixtures';

// ---------------------------------------------------------------------------- gestures (sp)

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
const straight = (speed = 0.6, seed = 21, o: { alt?: number; az?: number } = {}) => {
  const h = new Hand(0, 50, { jitter: 0.1, seed, p: 0.5, ...o });
  h.moveTo(320, 50, speed);
  return h;
};
/** A gentle bend (radius 140 sp) at a given speed, no jitter so scatter is the only noise. */
const bend = (speed: number, seed = 31) => {
  const h = new Hand(0, 0, { jitter: 0, seed, p: 0.5 });
  h.arc(0, 140, 140, -Math.PI / 2, -Math.PI / 2 + 1.6, speed);
  return h;
};
const tap = (hold = 60, seed = 13) => {
  const h = new Hand(0, 0, { jitter: 0.05, seed, p: 0.65 });
  h.hold(hold);
  return h;
};

// ---------------------------------------------------------------------------- helpers

interface Poly { i: number; gen: number; unit: number; alpha: number; born: number; n: number; x: (k: number) => number; y: (k: number) => number; w: (k: number) => number }
function polys(c: Cooked, gen?: number): Poly[] {
  const out: Poly[] = [];
  for (let i = 0; i < c.nPolys; i++) {
    if (gen !== undefined && c.gen[i] !== gen) continue;
    const s = c.start[i];
    out.push({
      i, gen: c.gen[i], unit: c.unit[i], alpha: c.alpha[i], born: c.born[i], n: c.count[i],
      x: k => c.pts[4 * (s + k)], y: k => c.pts[4 * (s + k) + 1], w: k => c.pts[4 * (s + k) + 2],
    });
  }
  return out;
}
/** Direction (radians) of a ray poly: first point to last. */
const dirOf = (p: Poly) => Math.atan2(p.y(p.n - 1) - p.y(0), p.x(p.n - 1) - p.x(0));
/** Ink mass of growth: Σ alpha × length × mean width. */
function mass(c: Cooked): number {
  let m = 0;
  for (const p of polys(c)) {
    if (p.gen === 0) continue;
    let a = 0;
    for (let k = 1; k < p.n; k++) a += Math.hypot(p.x(k) - p.x(k - 1), p.y(k) - p.y(k - 1)) * 0.5 * (p.w(k) + p.w(k - 1));
    m += p.alpha * a;
  }
  return m;
}
const noNaN = (c: Cooked) => { for (let i = 0; i < 4 * c.nPts; i++) if (c.pts[i] !== c.pts[i]) return false; return true; };
/** Circular standard deviation (rad) of a set of directions. */
function angSpread(a: number[]): number {
  let cx = 0, cy = 0;
  for (const t of a) { cx += Math.cos(t); cy += Math.sin(t); }
  const R = Math.hypot(cx, cy) / a.length;
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, R)));
}

// ---------------------------------------------------------------------------- invariants

// the incremental checks cook each gesture ~7 times; give them room on a loaded machine
const SLOW = 30000;

describe('caustic: invariants', () => {
  it('incremental ≡ full on a signature with holds and closure flicker', () => {
    expect(opsIncremental(caustic, sig(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
  }, SLOW);
  it('incremental ≡ full on a closed loop with holds', () => {
    expect(opsIncremental(caustic, loop(), { closed: true, holds: [[20, 1], [40, 2.5]], flickerClosure: true, pools: [120, 1.5] })).toBeNull();
  }, SLOW);
  it('incremental ≡ full on corners with holds', () => {
    expect(opsIncremental(caustic, corners(), { holds: [[12, 2], [50, 1]] })).toBeNull();
  }, SLOW);
  it('incremental ≡ full on a held tap (bloom)', () => {
    expect(opsIncremental(caustic, tap(800), { radial: true, pools: [0, 1.5] })).toBeNull();
  }, SLOW);
  it('cookedHash is deterministic', () => {
    const a = cookedHash(opsCook(caustic, sig()).c), b = cookedHash(opsCook(caustic, sig()).c);
    expect(a).toBe(b);
    expect(cookedHash(opsCook(caustic, sig(), { seed: 99 }).c)).not.toBe(a);
  });
  it('cookedProblems() is empty on every gesture', () => {
    expect(cookedProblems(opsCook(caustic, sig()).c)).toEqual([]);
    expect(cookedProblems(opsCook(caustic, loop(), { closed: true }).c)).toEqual([]);
    expect(cookedProblems(opsCook(caustic, corners()).c)).toEqual([]);
    expect(cookedProblems(opsCook(caustic, tap(), { radial: true }).c)).toEqual([]);
    expect(cookedProblems(opsCook(caustic, sig(), { nib: 'chisel', size: 12 }).c)).toEqual([]);
    expect(cookedProblems(opsCook(caustic, sig(), { nib: 'pen', size: 2.5, z: 2.5 }).c)).toEqual([]);
  });
  it('honours the unit and stroke budgets', () => {
    const long = new Hand(0, 0, { jitter: 0.2, seed: 41, p: 0.8 });
    for (let i = 0; i < 12; i++) long.arc(200 * (i % 2 ? 1 : -1) + 400 * i, 0, 180, Math.PI, 2 * Math.PI, 0.7);
    const { c } = opsCook(caustic, long, { base: 4 });
    const per = new Map<number, number>();
    let total = 0;
    for (const p of polys(c)) {
      if (p.gen === 0) continue;
      per.set(p.unit, (per.get(p.unit) ?? 0) + p.n);
      total += p.n;
    }
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(caustic.unitBudget);
    expect(total).toBeLessThanOrEqual(caustic.strokeBudget + caustic.unitBudget); // causal: admitted while cum < budget
    expect(total).toBeGreaterThan(1000);
  }, SLOW);

  it('no NaN at degenerate input (2-sample stroke, tap, mouse without pressure)', () => {
    const two = new Hand(0, 0, { seed: 1, p: 0.5 });
    two.moveTo(9, 0, 9);
    expect(two.xs.length).toBe(2);
    for (const base of [0, 1, 2.5, 4]) {
      const { c } = opsCook(caustic, two, { base });
      expect(noNaN(c)).toBe(true);
      expect(cookedProblems(c)).toEqual([]);
    }
    const t = opsCook(caustic, tap(), { radial: true }).c;
    expect(noNaN(t)).toBe(true);
    expect(t.nPolys).toBeGreaterThan(12);
    const m = opsCook(caustic, sig(), { device: 'mouse', noP: true }).c;
    expect(noNaN(m)).toBe(true);
    expect(cookedProblems(m)).toEqual([]);
  });
  it('depth is continuous: small mass change per 1/16 level, bare stroke at 0', () => {
    expect(opsCook(caustic, sig(), { base: 0 }).c.nPolys).toBe(polys(opsCook(caustic, sig(), { base: 0 }).c, 0).length);
    const ms: number[] = [];
    for (let k = 0; k <= 64; k++) ms.push(mass(opsCook(caustic, sig(), { base: k / 16 }).c));
    const top = Math.max(...ms);
    expect(ms[0]).toBe(0);
    expect(top).toBeGreaterThan(0);
    for (let k = 1; k <= 64; k++) {
      expect(ms[k]).toBeGreaterThanOrEqual(ms[k - 1] * 0.98);
      expect(Math.abs(ms[k] - ms[k - 1])).toBeLessThan(0.06 * top);
    }
  }, SLOW);

});

// ---------------------------------------------------------------------------- acceptance

describe('caustic: acceptance', () => {
  it('1. the nephroid: a continuous caustic inside the loop on the far side, rays crowning the near side', () => {
    const { c } = opsCook(caustic, loop(), { closed: true, base: 2 });
    const cx = 110, cy = 90, R = 60;
    const ca = polys(c, 1);
    expect(ca.length).toBeGreaterThan(6);
    let inside = 0, below = 0, n = 0;
    for (const p of ca) for (let k = 0; k < p.n; k++) {
      const d = Math.hypot(p.x(k) - cx, p.y(k) - cy);
      n++; if (d < R + 1.5) inside++; if (p.y(k) > cy) below++;
    }
    expect(inside / n).toBeGreaterThan(0.97);
    expect(below / n).toBeGreaterThan(0.9);
    // continuity: adjacent units' caustic runs share their boundary point exactly
    const byUnit = new Map<number, Poly[]>();
    for (const p of ca) byUnit.set(p.unit, [...(byUnit.get(p.unit) ?? []), p]);
    let joints = 0;
    for (const [u, ps] of byUnit) {
      const nx = byUnit.get(u + 1);
      if (!nx) continue;
      const a = ps[ps.length - 1], b = nx[0];
      if (a.n < 5 || b.n < 5) continue; // partial runs (the seam overshoot) need not meet
      expect(a.x(a.n - 1)).toBe(b.x(0));
      expect(a.y(a.n - 1)).toBe(b.y(0));
      joints++;
    }
    expect(joints).toBeGreaterThan(4);
    // crown: rays from the top of the loop leave upward, above the loop
    const crown = polys(c, 2).filter(p => p.y(0) < cy - R * 0.7);
    expect(crown.length).toBeGreaterThan(10);
    for (const p of crown) expect(Math.hypot(p.x(p.n - 1) - cx, p.y(p.n - 1) - cy)).toBeGreaterThan(R);
  });

  it('2a. straight runs hatch in parallel with no caustic', () => {
    const { c } = opsCook(caustic, straight(0.5));
    expect(polys(c, 1).length).toBe(0);
    const rays = polys(c, 2);
    expect(rays.length).toBeGreaterThan(60);
    expect(angSpread(rays.map(dirOf))).toBeLessThan(0.12);
    // the lamp is at the top: rays leave upward
    for (const p of rays) expect(p.y(p.n - 1)).toBeLessThan(p.y(0));
  });

  it('2b. corners cross their rays in an X; the signature focuses only at bends, never clipped', () => {
    const { c } = opsCook(caustic, corners());
    const rays = polys(c, 2);
    // the apex at (60, 20): rays born within 25 sp of it split into two directions ≥ 60° apart
    const near = rays.filter(p => Math.hypot(p.x(0) - 60, p.y(0) - 20) < 25).map(dirOf);
    expect(near.length).toBeGreaterThan(4);
    let maxDiff = 0;
    for (const a of near) for (const b of near) maxDiff = Math.max(maxDiff, Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))));
    expect(maxDiff).toBeGreaterThan(Math.PI / 3);
    const s = opsCook(caustic, sig()).c;
    const ca = polys(s, 1);
    expect(ca.length).toBeGreaterThan(0);
    for (const p of polys(s)) if (p.gen > 0) expect(p.alpha).toBeLessThanOrEqual(0.9 + 1e-6);
    // caustic born only where the signature bends (the first arc and the second), not on the straight flick
  });

  it('2c. caustic cusp sits at the tightest bend, brightest there', () => {
    const { c } = opsCook(caustic, sig());
    const ca = polys(c, 1);
    // both arcs of the signature bulge toward the lamp (convex faces: no real focus); the V
    // corner at (150, 110) between them is the tightest concave bend and it focuses, brightly
    const v = ca.filter(p => Math.hypot(p.x(0) - 150, p.y(0) - 110) < 30);
    expect(v.length).toBeGreaterThan(0);
    expect(Math.max(...v.map(p => p.alpha))).toBeGreaterThan(0.5);
    expect(ca.filter(p => Math.hypot(p.x(0) - 80, p.y(0) - 40) < 40 && p.y(0) < 40).length).toBe(0);
    // the final straight flick (born past the corner at (150, 110), arc ≈ 330 sp) has none
    expect(ca.filter(p => p.born > 345).length).toBe(0);
  });

  it('3. speed: a slow bend throws a razor fan, a fast one a glittering (scattered) band', () => {
    const spread = (v: number) => {
      const { c } = opsCook(caustic, bend(v));
      const rays = polys(c, 2);
      // scatter relative to the local mean: compare each ray with its unit neighbours
      const byUnit = new Map<number, number[]>();
      for (const p of rays) byUnit.set(p.unit, [...(byUnit.get(p.unit) ?? []), dirOf(p)]);
      let s = 0, n = 0;
      for (const ds of byUnit.values()) { if (ds.length < 2) continue; s += angSpread(ds); n++; }
      return s / n;
    };
    const slow = spread(0.25), fast = spread(2.6);
    expect(slow).toBeLessThan(0.05);
    expect(fast).toBeGreaterThan(slow * 3);
  });

  it('3b. speed: the slow caustic is one razor line, the fast one a scattered band of glints', () => {
    // a cup (concave toward the lamp at the top): the bottom of a radius-100 circle
    const cup = (v: number) => {
      const h = new Hand(-80, 60, { jitter: 0, seed: 33, p: 0.6 });
      h.arc(0, 0, 100, Math.PI - 0.93, 0.93, v);
      return opsCook(caustic, h).c;
    };
    const rough = (c: Cooked) => {
      const pts: number[][] = [];
      for (const p of polys(c, 1)) for (let k = 0; k < p.n; k++) pts.push([p.x(k), p.y(k)]);
      // lateral roughness: distance of each point from the midpoint of its neighbours
      let r = 0;
      for (let i = 1; i + 1 < pts.length; i++) r += Math.hypot(pts[i][0] - 0.5 * (pts[i - 1][0] + pts[i + 1][0]), pts[i][1] - 0.5 * (pts[i - 1][1] + pts[i + 1][1]));
      return r / Math.max(1, pts.length - 2);
    };
    const slow = cup(0.25), fast = cup(2.6);
    const sc = polys(slow, 1), fc = polys(fast, 1);
    expect(sc.length).toBeGreaterThan(3);
    expect(fc.length).toBeGreaterThan(6);
    expect(sc.filter(p => p.n >= 3).length / sc.length).toBeGreaterThan(0.8); // connected runs (2-pt runs only at the range ends)
    expect(fc.filter(p => p.n === 2).length / fc.length).toBeGreaterThan(0.8); // glints
    // the slow caustic sits inside the cup, above its floor (the focus at R/2 from the mirror)
    for (const p of sc) for (let k = 0; k < p.n; k++) expect(Math.hypot(p.x(k), p.y(k))).toBeLessThan(100);
    expect(rough(fast)).toBeGreaterThan(3 * rough(slow));
  });

  it('caustic arms taper: the cusp is wider than the far arm', () => {
    const h = new Hand(-80, 60, { jitter: 0, seed: 33, p: 0.6 });
    h.arc(0, 0, 100, Math.PI - 0.93, 0.93, 0.25);
    const ca = polys(opsCook(caustic, h).c, 1);
    // the cusp is the caustic point nearest the circle centre's axis below it (ρ = R/2 = 50)
    let wCusp = 0, wArm = Infinity;
    for (const p of ca) for (let k = 0; k < p.n; k++) {
      if (Math.abs(p.x(k)) < 6) wCusp = Math.max(wCusp, p.w(k));
      if (Math.abs(p.x(k)) > 30) wArm = Math.min(wArm, p.w(k));
    }
    expect(wCusp).toBeGreaterThan(0);
    expect(wArm).toBeLessThan(wCusp);
  });

  it('lean swings the lamp: tilting the pen moves the fan to the other side', () => {
    const left = opsCook(caustic, straight(0.6, 21, { alt: 0.4, az: 0 })).c;
    const right = opsCook(caustic, straight(0.6, 21, { alt: 0.4, az: Math.PI })).c;
    const mean = (c: Cooked) => { const r = polys(c, 2); let x = 0; for (const p of r) x += p.x(p.n - 1) - p.x(0); return x / r.length; };
    expect(mean(left) * mean(right)).toBeLessThan(0);
    expect(Math.abs(mean(left))).toBeGreaterThan(5);
  });

  it('holding lengthens and triples the rays in the pool window only', () => {
    const base = opsCook(caustic, straight(0.5)).c;
    const held = opsCook(caustic, straight(0.5), { pools: [160, 1.5] }).c;
    const inWin = (c: Cooked) => polys(c, 2).filter(p => Math.abs(p.born - 160) < 10);
    const outWin = (c: Cooked) => polys(c, 2).filter(p => p.born < 40 || p.born > 280);
    expect(inWin(held).length).toBe(inWin(base).length * 3);
    expect(outWin(held).length).toBe(outWin(base).length);
    const len = (ps: Poly[]) => ps.reduce((a, p) => a + Math.hypot(p.x(p.n - 1) - p.x(0), p.y(p.n - 1) - p.y(0)), 0) / ps.length;
    expect(len(inWin(held))).toBeGreaterThan(len(inWin(base)) * 1.5);
  });

  it('nearby ink shortens rays toward it and dims growth', () => {
    const clear = opsCook(caustic, straight(0.5)).c;
    const h = new Hand(0, 50, { jitter: 0.1, seed: 21, p: 0.5, c: 0.8, cs: 0.8 });
    h.moveTo(320, 50, 0.5);
    const crowded = opsCook(caustic, h).c;
    const len = (c: Cooked) => { const r = polys(c, 2); return r.reduce((a, p) => a + Math.hypot(p.x(p.n - 1) - p.x(0), p.y(p.n - 1) - p.y(0)), 0) / r.length; };
    const al = (c: Cooked) => { const r = polys(c, 2); return r.reduce((a, p) => a + p.alpha, 0) / r.length; };
    expect(len(crowded)).toBeLessThan(len(clear) * 0.8);
    expect(al(crowded)).toBeLessThan(al(clear) * 0.8);
    expect(polys(crowded, 2).length).toBeLessThan(polys(clear, 2).length * 0.7);
  });

  it('tap: a glint of 12 rays with a star caustic; a held tap triples them', () => {
    const t = opsCook(caustic, tap(), { radial: true, base: 1 }).c;
    expect(polys(t, 2).length).toBe(12);
    expect(polys(t, 1).length).toBe(1);
    expect(polys(t, 1)[0].n).toBe(33);
    const held = opsCook(caustic, tap(800), { radial: true, base: 1, pools: [0, 2.5] }).c;
    expect(polys(held, 2).length).toBe(36);
    expect(held.nPts).toBeLessThanOrEqual(110);
  });
});
