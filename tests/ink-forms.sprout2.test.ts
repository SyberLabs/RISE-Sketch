/**
 * Sprout v2: v1's grammar with clean crotches. Under additive Night ink a branch lying on its
 * parent (another raster batch) adds, so v1 drew bright dashes at every node and a bead where
 * every primary left the trunk. v2 draws each branch from where it clears its parent's ribbon.
 * These tests pin the new invariant (no branch ribbon enters its parent), that everything else
 * is v1's (anchors, tips, tones, alphas), versioning, and the shared Form invariants on v2
 * (cook ≡ incremental finish under holds / closure flicker, determinism, budgets, depth).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked } from '../src/core/types';
import { cook } from '../src/ink/cook';
import { CURRENT_V, operatorFor } from '../src/ink/operators/registry';
import { sprout as sprout1 } from '../src/ink/operators/sprout.v1';
import { sprout as sprout2 } from '../src/ink/operators/sprout.v2';
import {
  formRecipe, longStroke, loopStroke, tapStroke, Hand, cookedHash, cookedProblems, opsIncremental, opsCook,
} from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU
vi.setConfig({ testTimeout: 60000 });

// ---------------------------------------------------------------------------- gestures

/** A gentle wave: fern anchors (low curvature) with long shallow-angle branches. */
const wave = (seed = 5, p = 0.6): Hand => {
  const h = new Hand(0, 60, { jitter: 0.2, seed, p });
  h.moveTo(150, 30, 0.5, 0.8).moveTo(300, 70, 0.5, 0.6).moveTo(420, 40, 0.6, 0.5);
  return h;
};
/** A tight curve: coral anchors. */
const curl = (seed = 7): Hand => {
  const h = new Hand(0, 0, { jitter: 0.15, seed, p: 0.7 });
  h.arc(60, 0, 60, Math.PI, 2.6 * Math.PI, 0.6);
  return h;
};

// ---------------------------------------------------------------------------- geometry helpers

interface Poly { gen: number; unit: number; x: number[]; y: number[]; w: number[] }
function polys(c: Cooked): Poly[] {
  const out: Poly[] = [];
  for (let i = 0; i < c.nPolys; i++) {
    const p: Poly = { gen: c.gen[i], unit: c.unit[i], x: [], y: [], w: [] };
    for (let k = 0; k < c.count[i]; k++) {
      const j = c.start[i] + k;
      p.x.push(c.pts[4 * j]); p.y.push(c.pts[4 * j + 1]); p.w.push(c.pts[4 * j + 2]);
    }
    out.push(p);
  }
  return out;
}

/** Signed clearance of (x, y) from a ribbon: distance to its centreline minus its half width there. */
function ribbonClear(r: Poly, x: number, y: number): number {
  let best = Infinity;
  const n = r.x.length;
  if (n === 1) return Math.hypot(r.x[0] - x, r.y[0] - y) - r.w[0] / 2;
  for (let k = 0; k + 1 < n; k++) {
    const ax = r.x[k], ay = r.y[k], dx = r.x[k + 1] - ax, dy = r.y[k + 1] - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y) - (r.w[k] + (r.w[k + 1] - r.w[k]) * t) / 2;
    if (d < best) best = d;
  }
  return best;
}

/** One branch's crotch: its generation, whether it leaves from an ancestor's edge, and how deep its crotch stacks on it. */
interface Crotch { gen: number; connected: boolean; worst: number }

/**
 * The crotch of every branch of gen ≥ 1 (doc units). A branch leaves from an ancestor: its
 * parent, or, for a twig budding near its parent's root while the parent is still leaving the
 * grandparent, a further ancestor (up to three generations up; the trunk's chunks and the seed
 * dot for every generation). Cooked does not record lineage, so the ancestor is taken to be the
 * ribbon of those generations (same unit) whose edge is nearest the branch's first point; the
 * branch is connected when that distance lies in [lo, hi] (v2 draws a branch from just outside
 * its ancestors' edges, v1 from inside its parent: hi = 0). `worst` is the clearance of the
 * crotch (the first `crotch` points, each widened to its two ribbon edges along the local
 * normal) from that ancestor: < 0 is ink stacked on it. Points pinched to the width floor are
 * hairlines and are skipped.
 */
function crotches(c: Cooked, lo: number, hi: number, floor: number, crotch = 6): Crotch[] {
  const P = polys(c), out: Crotch[] = [];
  for (const b of P) {
    if (b.gen < 1 || b.x.length < 2) continue;
    let parent: Poly | null = null, pd = Infinity;
    for (const q of P) {
      if (q.gen >= b.gen || q.gen < b.gen - 3 || (q.gen > 0 && q.unit !== b.unit)) continue;
      const d = ribbonClear(q, b.x[0], b.y[0]);
      const e = d > hi ? d - hi : d < lo ? lo - d : 0;
      if (e < pd) { pd = e; parent = q; }
    }
    if (!parent || pd > 0) { out.push({ gen: b.gen, connected: false, worst: Infinity }); continue; }
    let worst = Infinity;
    for (let k = 0; k < Math.min(crotch, b.x.length); k++) {
      if (b.w[k] <= floor) continue;
      const k0 = Math.max(0, k - 1), k1 = Math.min(b.x.length - 1, k + 1);
      const dx = b.x[k1] - b.x[k0], dy = b.y[k1] - b.y[k0], L = Math.hypot(dx, dy);
      if (!(L > 0)) continue;
      const nx = -dy / L, ny = dx / L, h = b.w[k] / 2;
      for (const sg of [-1, 1]) worst = Math.min(worst, ribbonClear(parent, b.x[k] + sg * nx * h, b.y[k] + sg * ny * h));
    }
    out.push({ gen: b.gen, connected: true, worst });
  }
  return out;
}

// ---------------------------------------------------------------------------- versioning

describe('Sprout v2: versioning (DESIGN §7.5 rule 8)', () => {
  it('new strokes draw v2; a recipe keeps cooking with the version it was drawn with', () => {
    expect(CURRENT_V.sprout).toBe(2);
    expect(operatorFor('sprout', 1)).toBe(sprout1);
    expect(operatorFor('sprout', 2)).toBe(sprout2);
    const rows = longStroke(3).rows();
    const a = cook(formRecipe(rows, { form: 'sprout' })), b = cook(formRecipe(rows, { v: 2, form: 'sprout' }));
    expect(cookedHash(a)).toBe(cookedHash(cook(formRecipe(rows, { form: 'sprout' }))));
    expect(cookedHash(a)).not.toBe(cookedHash(b));
  });
  it('changes only the crotches: the same trunk, units, generations and branch tips as v1', () => {
    for (const [h, o] of [[longStroke(3), {}], [wave(), { size: 22 }], [curl(), { base: 4 }], [tapStroke(60), { radial: true, base: 3 }]] as const) {
      const rows = h.rows();
      const a = cook(formRecipe(rows, { form: 'sprout', ...o })), b = cook(formRecipe(rows, { v: 2, form: 'sprout', ...o }));
      // the trunk is untouched
      const ta = polys(a).filter(p => p.gen === 0), tb = polys(b).filter(p => p.gen === 0);
      expect(JSON.stringify(tb)).toBe(JSON.stringify(ta));
      // every v2 branch ends exactly where a v1 branch ends, no wider (a twig still in its
      // crotch at its tip is narrower)
      const tips = new Map<string, number>();
      for (const p of polys(a)) if (p.gen >= 1) tips.set(`${p.gen}:${p.unit}:${p.x.at(-1)}:${p.y.at(-1)}`, p.w.at(-1)!);
      let n = 0, same = 0;
      for (const p of polys(b)) {
        if (p.gen < 1) continue;
        const w = tips.get(`${p.gen}:${p.unit}:${p.x.at(-1)}:${p.y.at(-1)}`);
        expect(w).toBeDefined();
        expect(p.w.at(-1)!).toBeLessThanOrEqual(w! + 1e-6);
        if (p.w.at(-1) === w) same++;
        n++;
      }
      // a branch can only vanish if it never leaves its parent
      expect(n).toBeGreaterThan(0.97 * tips.size);
      expect(same).toBeGreaterThan(0.9 * n);
    }
  });
});

// ---------------------------------------------------------------------------- crotches

describe('Sprout v2: crotches', () => {
  const gestures: [string, Hand, Parameters<typeof formRecipe>[1]][] = [
    ['wave, brush 3', wave(5), { form: 'sprout', size: 3, base: 4 }],
    ['wave, brush 9', wave(6), { form: 'sprout', size: 9, base: 4 }],
    ['wave, brush 22', wave(7), { form: 'sprout', size: 22, base: 4 }],
    ['curl (coral), brush 14', curl(), { form: 'sprout', size: 14, base: 4 }],
    ['long pen stroke', longStroke(3), { form: 'sprout', base: 3, nib: 'pen', size: 3 }],
    ['zoomed in (z 4)', wave(8), { form: 'sprout', size: 12, base: 3, z: 4 }],
  ];
  for (const [name, h, o] of gestures) {
    it(`branches leave their parents' edges without stacking on them: ${name}`, () => {
      const z = o.z ?? 1, rows = h.rows(z), tol = 0.2 / z;
      // v2 exits 0.2 sp (+ half the width floor) outside its ancestors' edges; up to 1.2 sp where
      // the trunk's final envelope (an exit taper, which operators never see) or an ancestor's own
      // crotch drew it thinner than the width the branch cleared
      const v2 = crotches(cook(formRecipe(rows, { ...o, v: 2 })), -0.1 / z, 1.2 / z, 0.36 / z);
      expect(v2.length).toBeGreaterThan(20);
      // primaries and their children (unambiguous parents: the trunk, the unit's one primary)
      for (const r of v2) if (r.gen <= 2) { expect(r.connected).toBe(true); expect(r.worst).toBeGreaterThan(-tol); }
      // deeper twigs: the nearest-edge guess can pick an uncle or a cousin, so count instead
      const stacked = (rs: Crotch[]): number => rs.filter(r => r.connected && r.worst < -tol).length / rs.length;
      expect(v2.filter(r => !r.connected).length / v2.length).toBeLessThan(0.03);
      expect(stacked(v2)).toBeLessThan(0.06);
      // the same measure flags v1's stacked crotches (the Night dashes and beads)
      const v1 = crotches(cook(formRecipe(rows, { ...o, v: 1 })), -Infinity, 0, 0.36 / z);
      expect(stacked(v1)).toBeGreaterThan(Math.max(0.05, 3 * stacked(v2)));
    });
  }
  it('primaries leave from the trunk edge (connected, no gap wider than the clearance kept)', () => {
    const c = cook(formRecipe(wave(9).rows(), { v: 2, form: 'sprout', size: 22, base: 1 }));
    const P = polys(c), trunk = P.filter(p => p.gen === 0);
    let n = 0;
    for (const b of P) {
      if (b.gen !== 1) continue;
      let gap = Infinity;
      for (const t of trunk) gap = Math.min(gap, ribbonClear(t, b.x[0], b.y[0]));
      expect(gap).toBeGreaterThan(-0.05);
      expect(gap).toBeLessThan(0.6);
      n++;
    }
    expect(n).toBeGreaterThan(8);
  });
  it('a radial burst leaves the seed dot at its rim', () => {
    const c = cook(formRecipe(tapStroke(60).rows(), { v: 2, form: 'sprout', base: 3, radial: true, size: 22 }));
    const P = polys(c), dot = P[0];
    expect(dot.gen).toBe(0);
    expect(dot.x.length).toBe(1);
    const prim = P.filter(p => p.gen === 1);
    expect(prim.length).toBe(5);
    for (const p of prim) {
      const d = Math.hypot(p.x[0] - dot.x[0], p.y[0] - dot.y[0]);
      expect(d).toBeGreaterThan(dot.w[0] / 2);
      expect(d).toBeLessThan(dot.w[0] / 2 + 0.8);
    }
  });
});

// ---------------------------------------------------------------------------- invariants

describe('Sprout v2: pipeline invariants', () => {
  it('incremental ≡ full (bitwise) with holds, closure flicker, pools and radial seeds', () => {
    expect(opsIncremental(sprout2, wave(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(sprout2, wave(11), { size: 22, holds: [[20, 2.5]] })).toBeNull();
    expect(opsIncremental(sprout2, curl(), { closed: true, holds: [[20, 2.5]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(sprout2, longStroke(5), { pools: [60, 2, 150, 1], holds: [[12, 1]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(sprout2, tapStroke(700), { radial: true, pools: [0, 1.5] })).toBeNull();
    expect(opsIncremental(sprout2, loopStroke(70), { closed: true, size: 3, nib: 'pen' })).toBeNull();
  });
  it('is deterministic and structurally sound on hard inputs', () => {
    expect(cookedHash(opsCook(sprout2, wave()).c)).toBe(cookedHash(opsCook(sprout2, wave()).c));
    const two = new Hand(0, 0, { seed: 1, p: 0.5 });
    two.moveTo(1, 0.5, 0.5);
    for (const { c } of [
      opsCook(sprout2, two), opsCook(sprout2, two, { radial: true }), opsCook(sprout2, tapStroke(60), { radial: true, base: 3 }),
      opsCook(sprout2, wave(), { z: 0.06 }), opsCook(sprout2, wave(), { z: 16 }), opsCook(sprout2, curl(), { nib: 'chisel', size: 12 }),
    ]) {
      expect(cookedProblems(c)).toEqual([]);
      for (let i = 0; i < c.nPts * 4; i++) expect(Number.isFinite(c.pts[i])).toBe(true);
    }
  });
  it('writes no more points than v1 (the budgets count the same)', () => {
    for (const [h, o] of [[wave(), { size: 22, base: 4 }], [curl(), { base: 4 }], [tapStroke(60), { radial: true, base: 3, size: 22 }]] as const) {
      const rows = h.rows();
      const a = cook(formRecipe(rows, { form: 'sprout', ...o })), b = cook(formRecipe(rows, { v: 2, form: 'sprout', ...o }));
      expect(b.nPts).toBeLessThanOrEqual(a.nPts);
      expect(b.ceilingMax).toBe(a.ceilingMax);
    }
  });
  it('rises continuously: drawn growth never shrinks and changes a little per 1/16 level', () => {
    const arc = (c: Cooked): number => {
      let s = 0;
      for (const p of polys(c)) if (p.gen >= 1) for (let k = 1; k < p.x.length; k++) s += Math.hypot(p.x[k] - p.x[k - 1], p.y[k] - p.y[k - 1]);
      return s;
    };
    const rows = wave(3).rows();
    const full = arc(cook(formRecipe(rows, { v: 2, form: 'sprout', base: 4, size: 9 })));
    let prev = 0;
    for (let k = 0; k <= 64; k++) {
      const a = arc(cook(formRecipe(rows, { v: 2, form: 'sprout', base: k / 16, size: 9 })));
      expect(a).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(a - prev).toBeLessThan(0.08 * full);
      prev = a;
    }
    expect(prev).toBeCloseTo(full, 6);
  });
});
