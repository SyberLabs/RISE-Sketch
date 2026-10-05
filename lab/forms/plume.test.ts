import { describe, it, expect } from 'vitest';
import * as plume from './plume.form';
import { checkIncremental, labCook, problems, Hand, cookedHash } from './harness';
import type { Cooked } from '../../src/core/types';

// ---------------------------------------------------------------------------- gestures

const sig = (seed = 3) => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9).moveTo(150, 110, 1.3, 0.55).moveTo(300, 40, 2.3, 0.25);
  return h;
};
const loop = (seed = 7, R = 60) => {
  const h = new Hand(110 + R, 90, { jitter: 0.15, seed, p: 0.6 });
  h.arc(110, 90, R, 0, 2 * Math.PI * 1.01, 0.8);
  return h;
};
const corners = (seed = 9) => {
  const h = new Hand(10, 140, { jitter: 0.2, seed, p: 0.55 });
  h.moveTo(60, 20, 0.5).moveTo(61, 21, 0.05).hold(70).moveTo(130, 150, 0.6).moveTo(131, 149, 0.05).hold(70).moveTo(200, 20, 0.6);
  return h;
};
const line = (v: number, p: number, seed: number) => {
  const h = new Hand(0, 60, { jitter: 0.2, seed, p });
  h.moveTo(120, 20, v).moveTo(240, 70, v).moveTo(380, 30, v);
  return h;
};
const tap = (hold = 60, seed = 13) => {
  const h = new Hand(0, 0, { jitter: 0.05, seed, p: 0.65 });
  h.hold(hold);
  return h;
};

// ---------------------------------------------------------------------------- helpers

/** Iterate polys of gen g: callback gets (poly index, start point, count). */
function eachPoly(c: Cooked, g: number, f: (i: number, s: number, n: number) => void): void {
  for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === g) f(i, c.start[i], c.count[i]);
}
/** Total drawn arc (sp) over all polys of gen ≥ 1. */
function growthArc(c: Cooked): number {
  let a = 0;
  for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) a += c.pts[4 * (c.start[i] + c.count[i] - 1) + 3];
  return a;
}
const countGen = (c: Cooked, g: number): number => { let n = 0; eachPoly(c, g, () => n++); return n; };

describe('plume: pipeline invariants', () => {
  it('incremental ≡ full on three gestures with holds and closure flicker', () => {
    expect(checkIncremental(plume, sig(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(checkIncremental(plume, loop(), { closed: true, holds: [[20, 2.5]], flickerClosure: true })).toBeNull();
    expect(checkIncremental(plume, corners(), { pools: [60, 2, 150, 1], holds: [[12, 1]], flickerClosure: true })).toBeNull();
  }, 60000); // heavy: random chunkings x 3 gestures; slow on a loaded machine
  it('is deterministic', () => {
    expect(cookedHash(labCook(plume, sig()).c)).toBe(cookedHash(labCook(plume, sig()).c));
    expect(cookedHash(labCook(plume, loop(), { closed: true }).c)).toBe(cookedHash(labCook(plume, loop(), { closed: true }).c));
  });
  it('has no structural problems and honours the budgets', () => {
    for (const { c } of [labCook(plume, sig()), labCook(plume, loop(), { closed: true }), labCook(plume, corners(), { pools: [60, 2.5] }), labCook(plume, sig(), { base: 3 })]) {
      expect(problems(c)).toEqual([]);
      const perUnit = new Map<number, number>();
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) perUnit.set(c.unit[i], (perUnit.get(c.unit[i]) ?? 0) + c.count[i]);
      for (const n of perUnit.values()) expect(n).toBeLessThanOrEqual(plume.ops.unitBudget);
      let growth = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) growth += c.count[i];
      expect(growth).toBeLessThanOrEqual(plume.ops.strokeBudget + plume.ops.unitBudget);
    }
  });
  it('survives degenerate input: a 2-sample stroke and a tap', () => {
    const two = new Hand(0, 0, { seed: 1, p: 0.5 });
    two.moveTo(1, 0.5, 0.5);
    for (const { c } of [labCook(plume, two), labCook(plume, two, { radial: true }), labCook(plume, tap()), labCook(plume, tap(), { radial: true, base: 3 })]) {
      expect(problems(c)).toEqual([]);
      for (let i = 0; i < c.pts.length; i++) expect(Number.isFinite(c.pts[i])).toBe(true);
    }
  });
  it('is continuous in depth: small change per 1/16 level', () => {
    let prev = growthArc(labCook(plume, sig(), { base: 0 }).c);
    expect(prev).toBe(0); // depth 0 is the bare stroke
    const full = growthArc(labCook(plume, sig(), { base: 3 }).c);
    for (let k = 1; k <= 48; k++) {
      const a = growthArc(labCook(plume, sig(), { base: k / 16 }).c);
      expect(a).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(a - prev).toBeLessThan(0.08 * full);
      prev = a;
    }
    expect(prev).toBeCloseTo(full, 6);
  }, 60000);
});

describe('plume: gesture grammar', () => {
  it('has barbs on both sides, no branching: every gen-1 poly starts on the shaft edge', () => {
    const { c } = labCook(plume, line(0.5, 0.6, 3));
    expect(countGen(c, 1)).toBeGreaterThan(100);
    // a unit is two barb pairs (at s_j and s_j + Δ/2), each with one barb per side: 4 gen-1
    // polys per unit. (The earlier version of this test expected 2, from before the unit was
    // widened to two pairs for cost; the test was wrong, not the form.)
    const perUnit = new Map<number, number>();
    eachPoly(c, 1, i => perUnit.set(c.unit[i], (perUnit.get(c.unit[i]) ?? 0) + 1));
    let full = 0;
    for (const n of perUnit.values()) if (n === 4) full++;
    expect(full / perUnit.size).toBeGreaterThan(0.9);
    // both sides: as many barbs left of the shaft as right of it (the stroke runs +x)
    let up = 0, down = 0;
    eachPoly(c, 1, (_, s, k) => { if (c.pts[4 * (s + k - 1) + 1] < c.pts[4 * s + 1]) up++; else down++; });
    expect(Math.min(up, down)).toBeGreaterThan(0.4 * (up + down));
    // no branching: every barb starts on the trunk edge (half the drawn trunk width from the
    // nearest trunk point), never on another barb
    const tr: number[] = [];
    eachPoly(c, 0, (_, s, k) => { for (let q = 0; q < k; q++) tr.push(c.pts[4 * (s + q)], c.pts[4 * (s + q) + 1], c.pts[4 * (s + q) + 2]); });
    let bad = 0;
    eachPoly(c, 1, (_, s) => {
      const x = c.pts[4 * s], y = c.pts[4 * s + 1];
      let best = Infinity, w = 0;
      for (let q = 0; q < tr.length; q += 3) { const d = Math.hypot(tr[q] - x, tr[q + 1] - y); if (d < best) { best = d; w = tr[q + 2]; } }
      if (Math.abs(best - 0.5 * w) > 0.25 * w + 0.75) bad++;
    });
    expect(bad).toBe(0);
  });
  it('acceptance 1 — ocellus: a closed loop keeps a clear pupil ≥ 0.3R and inner barbs stay inside', () => {
    const R = 60;
    const { c } = labCook(plume, loop(7, R), { closed: true });
    // centre from the trunk (gen 0) points
    let cx = 0, cy = 0, n = 0;
    eachPoly(c, 0, (_, s, k) => { for (let q = 0; q < k; q++) { cx += c.pts[4 * (s + q)]; cy += c.pts[4 * (s + q) + 1]; n++; } });
    cx /= n; cy /= n;
    let rMin = Infinity, inner = 0, outer = 0, crossed = 0;
    eachPoly(c, 1, (_, s, k) => {
      const d0 = Math.hypot(c.pts[4 * s] - cx, c.pts[4 * s + 1] - cy);
      const d1 = Math.hypot(c.pts[4 * (s + k - 1)] - cx, c.pts[4 * (s + k - 1) + 1] - cy);
      const isInner = d1 < d0;
      if (isInner) inner++; else outer++;
      for (let q = 0; q < k; q++) {
        const d = Math.hypot(c.pts[4 * (s + q)] - cx, c.pts[4 * (s + q) + 1] - cy);
        if (d < rMin) rMin = d;
        if (isInner ? d > R + 2 : d < R - 2) crossed++;
      }
    });
    expect(inner).toBeGreaterThan(50);
    expect(outer).toBeGreaterThan(50);
    expect(crossed).toBe(0);
    expect(2 * rMin).toBeGreaterThan(0.3 * R);
    // inner barbs are shorter than outer ones
    let li = 0, lo = 0;
    eachPoly(c, 1, (_, s, k) => {
      const d0 = Math.hypot(c.pts[4 * s] - cx, c.pts[4 * s + 1] - cy), d1 = Math.hypot(c.pts[4 * (s + k - 1)] - cx, c.pts[4 * (s + k - 1) + 1] - cy);
      const len = c.pts[4 * (s + k - 1) + 3];
      if (d1 < d0) li += len / inner; else lo += len / outer;
    });
    expect(li).toBeLessThan(0.8 * lo);
  });
  it('acceptance 2 — speed reads as wind: fast barbs lie back toward the tip and vary in length', () => {
    const angleStats = (c: Cooked) => {
      // barb angle from the stroke direction (+x overall): measured from first to last point
      let sum = 0, n = 0; const lens: number[] = [];
      eachPoly(c, 1, (_, s, k) => {
        const dx = c.pts[4 * (s + k - 1)] - c.pts[4 * s], dy = c.pts[4 * (s + k - 1) + 1] - c.pts[4 * s + 1];
        const l = Math.hypot(dx, dy);
        if (l < 1) return;
        sum += Math.abs(dy) / l; n++; lens.push(c.pts[4 * (s + k - 1) + 3]);
      });
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const cv = Math.sqrt(lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length) / mean;
      return { across: sum / n, cv };
    };
    const slow = angleStats(labCook(plume, line(0.25, 0.85, 60)).c);
    const fast = angleStats(labCook(plume, line(2.4, 0.85, 62)).c);
    expect(slow.across).toBeGreaterThan(fast.across + 0.15); // fast barbs are swept back
    expect(fast.cv).toBeGreaterThan(slow.cv + 0.08);          // fast barbs ruffle
  });
  it('acceptance 3 — density without blow-out: barbs are hairs, alphas bounded, hairlines never below the floor', () => {
    for (const o of [{ nib: 'pen' as const, size: 2.5 }, { nib: 'brush' as const, size: 9 }, { nib: 'brush' as const, size: 22 }]) {
      const { c } = labCook(plume, sig(31), o);
      expect(problems(c)).toEqual([]);
      eachPoly(c, 1, (i, s, k) => {
        expect(c.alpha[i]).toBeLessThanOrEqual(0.5);
        for (let q = 0; q < k; q++) { const w = c.pts[4 * (s + q) + 2]; expect(w).toBeLessThanOrEqual(2.2 + 1e-6); expect(w).toBeGreaterThanOrEqual(0.35 - 1e-6); }
      });
      eachPoly(c, 2, i => expect(c.alpha[i]).toBeLessThanOrEqual(0.5 * 0.72 + 1e-6));
    }
    // moiré guard: zoomed well out the barbules vanish, the barbs stay
    const far = labCook(plume, sig(31), { z: 5 }).c;
    expect(countGen(far, 1)).toBeGreaterThan(50);
    expect(countGen(far, 2)).toBe(0);
  });
  it('pressure widens the vane', () => {
    const arc = (p: number) => growthArc(labCook(plume, line(0.5, p, 5), { base: 1 }).c);
    expect(arc(0.9)).toBeGreaterThan(1.5 * arc(0.2));
  });
  it('holding turns the vane to barbules then down (gens 2–3 only inside the pool window)', () => {
    const base1 = labCook(plume, line(0.5, 0.6, 8), { base: 1 }).c;
    expect(countGen(base1, 2)).toBe(0);
    expect(countGen(base1, 3)).toBe(0);
    const held = labCook(plume, line(0.5, 0.6, 8), { base: 1, pools: [150, 2] }).c;
    expect(countGen(held, 2)).toBeGreaterThan(0);
    expect(countGen(held, 3)).toBeGreaterThan(0);
    eachPoly(held, 3, i => { expect(held.born[i]).toBeGreaterThan(150 - 48); expect(held.born[i]).toBeLessThan(150 + 32); });
  });
  it('crowding shortens the vane and narrows the side facing ink', () => {
    const mk = (c: number, cs: number) => { const h = new Hand(0, 60, { jitter: 0.2, seed: 9, p: 0.6, c, cs }); h.moveTo(200, 60, 0.5); return h; };
    const clear = labCook(plume, mk(0, 0), { base: 1 }).c, crowded = labCook(plume, mk(0.8, 0), { base: 1 }).c;
    expect(growthArc(crowded)).toBeLessThan(0.7 * growthArc(clear));
    const sided = labCook(plume, mk(0, 1), { base: 1 }).c;
    let up = 0, down = 0;
    eachPoly(sided, 1, (_, s, k) => { const dy = sided.pts[4 * (s + k - 1) + 1] - sided.pts[4 * s + 1]; const l = sided.pts[4 * (s + k - 1) + 3]; if (dy < 0) up += l; else down += l; });
    expect(Math.min(up, down)).toBeLessThan(0.7 * Math.max(up, down));
  });
  it('a tap is a tuft of down that fills in with depth', () => {
    const d1 = labCook(plume, tap(), { radial: true, base: 1 }).c;
    const d3 = labCook(plume, tap(), { radial: true, base: 3 }).c;
    expect(countGen(d1, 1)).toBe(12);
    expect(countGen(d1, 2)).toBe(0);
    expect(countGen(d3, 2)).toBeGreaterThan(0);
    expect(countGen(d3, 3)).toBe(12);
    expect(problems(d3)).toEqual([]);
  });
  it('chisel nib draws chisel barbs', () => {
    const { c } = labCook(plume, sig(37), { nib: 'chisel', size: 12 });
    let chisel = 0; eachPoly(c, 1, i => { if (c.kind[i] === 1) chisel++; });
    expect(chisel).toBe(countGen(c, 1));
    expect(c.ang).not.toBeNull();
  });
});
