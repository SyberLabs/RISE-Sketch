/**
 * Drift v2: v1's wake poured off the trunk's edge. Under additive Night ink a filament lying on
 * the trunk (another raster batch) adds, so v1, which released every filament on the trunk's
 * centreline inside a trunk 0.8 × the stroke width, drew a near-white core with a thin coloured
 * rim. v2 starts each filament just outside the trunk's edge, on the side the field pushes
 * toward, and tapers its width in from the edge. These tests pin the new invariant (no filament
 * root enters the trunk, every root touches its edge), that everything else is v1's (trunk,
 * units, point counts, tones, alphas), versioning, and the shared Form invariants on v2 (cook ≡
 * incremental finish under holds / closure flicker, determinism, budgets, depth).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked } from '../src/core/types';
import { cook } from '../src/ink/cook';
import { CURRENT_V, operatorFor } from '../src/ink/operators/registry';
import { drift as drift1 } from '../src/ink/operators/drift.v1';
import { drift as drift2 } from '../src/ink/operators/drift.v2';
import {
  formRecipe, longStroke, loopStroke, tapStroke, Hand, cookedHash, cookedProblems, opsIncremental, opsCook,
} from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU
vi.setConfig({ testTimeout: 60000 });

// ---------------------------------------------------------------------------- gestures

/** A gentle wave, fast enough that filaments carry momentum along the trunk. */
const wave = (seed = 5, p = 0.6): Hand => {
  const h = new Hand(0, 60, { jitter: 0.2, seed, p });
  h.moveTo(150, 30, 0.5, 0.8).moveTo(300, 70, 0.5, 0.6).moveTo(420, 40, 0.6, 0.5);
  return h;
};
/** A slow straight line (little momentum: filaments follow the field from the start). */
const slow = (seed = 7): Hand => {
  const h = new Hand(0, 0, { jitter: 0.15, seed, p: 0.7 });
  h.moveTo(320, -40, 0.15, 0.7);
  return h;
};
/** A tight curve. */
const curl = (seed = 7): Hand => {
  const h = new Hand(0, 0, { jitter: 0.15, seed, p: 0.7 });
  h.arc(60, 0, 60, Math.PI, 2.6 * Math.PI, 0.6);
  return h;
};

// ---------------------------------------------------------------------------- geometry helpers

interface Poly { gen: number; tone: number; unit: number; born: number; x: number[]; y: number[]; w: number[]; a: number[] }
function polys(c: Cooked): Poly[] {
  const out: Poly[] = [];
  for (let i = 0; i < c.nPolys; i++) {
    const p: Poly = { gen: c.gen[i], tone: c.tone[i], unit: c.unit[i], born: c.born[i], x: [], y: [], w: [], a: [] };
    for (let k = 0; k < c.count[i]; k++) {
      const j = c.start[i] + k;
      p.x.push(c.pts[4 * j]); p.y.push(c.pts[4 * j + 1]); p.w.push(c.pts[4 * j + 2]); p.a.push(c.pts[4 * j + 3]);
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
const trunkClear = (trunk: Poly[], x: number, y: number): number => {
  let best = Infinity;
  for (const t of trunk) best = Math.min(best, ribbonClear(t, x, y));
  return best;
};

/**
 * The trunk around arc s (the gen-0 ribbons cut to arcs s ± win; a trunk point's arc is its
 * poly's born arc plus its own): the stretch a filament released at s pours off. Elsewhere a
 * stroke that curls back onto itself is crossed, not stacked on.
 */
function trunkNear(trunk: Poly[], s: number, win: number): Poly[] {
  const out: Poly[] = [];
  const lo = s - win, hi = s + win;
  for (const t of trunk) {
    const q: Poly = { ...t, x: [], y: [], w: [], a: [] };
    const put = (k: number, u: number): void => {
      const k1 = Math.min(k + 1, t.x.length - 1);
      q.x.push(t.x[k] + (t.x[k1] - t.x[k]) * u); q.y.push(t.y[k] + (t.y[k1] - t.y[k]) * u);
      q.w.push(t.w[k] + (t.w[k1] - t.w[k]) * u); q.a.push(t.a[k] + (t.a[k1] - t.a[k]) * u);
    };
    for (let k = 0; k < t.x.length; k++) {
      const sk = t.born + t.a[k], next = k + 1 < t.x.length ? t.born + t.a[k + 1] : NaN;
      if (sk >= lo && sk <= hi) put(k, 0);
      // the window's cuts inside segment k → k + 1
      if (sk < lo && next > lo) put(k, (lo - sk) / (next - sk));
      if (sk < hi && next > hi) put(k, (hi - sk) / (next - sk));
    }
    if (q.x.length) out.push(q);
  }
  return out;
}

/** A filament's root: its first poly (the dBucket-1 third, or the whole filament when short). */
interface Root { gap: number; worst: number }

/**
 * Every filament root of c (doc units), against the trunk it pours off (s ± 6 sp, the unit's
 * window): `gap` is the clearance of its first point from that trunk, `worst` the clearance of
 * the root's first `crotch` points, each widened to its two ribbon edges along the local normal
 * (< 0 is ink stacked on the trunk). Points pinched to the width floor are hairlines and are
 * skipped. With `whole`, every poly of every filament, all its points.
 */
function roots(c: Cooked, floor: number, crotch = 6, whole = false): Root[] {
  const P = polys(c), all = P.filter(p => p.gen === 0), out: Root[] = [];
  for (const b of P) {
    if (b.gen !== 1 || (!whole && b.tone % 5 !== 1) || b.x.length < 2) continue;
    const trunk = trunkNear(all, b.born, 6);
    let worst = Infinity;
    for (let k = 0; k < Math.min(crotch, b.x.length); k++) {
      if (b.w[k] <= floor) continue;
      const k0 = Math.max(0, k - 1), k1 = Math.min(b.x.length - 1, k + 1);
      const dx = b.x[k1] - b.x[k0], dy = b.y[k1] - b.y[k0], L = Math.hypot(dx, dy);
      if (!(L > 0)) continue;
      const nx = -dy / L, ny = dx / L, h = b.w[k] / 2;
      for (const sg of [-1, 1]) worst = Math.min(worst, trunkClear(trunk, b.x[k] + sg * nx * h, b.y[k] + sg * ny * h));
    }
    out.push({ gap: trunkClear(trunk, b.x[0], b.y[0]), worst });
  }
  return out;
}

// ---------------------------------------------------------------------------- versioning

describe('Drift v2: versioning (DESIGN §7.5 rule 8)', () => {
  it('new strokes draw v2; a recipe keeps cooking with the version it was drawn with', () => {
    expect(CURRENT_V.drift).toBe(2);
    expect(operatorFor('drift', 1)).toBe(drift1);
    expect(operatorFor('drift', 2)).toBe(drift2);
    const rows = longStroke(3).rows();
    const a = cook(formRecipe(rows, { form: 'drift' })), b = cook(formRecipe(rows, { v: 2, form: 'drift' }));
    expect(cookedHash(a)).toBe(cookedHash(cook(formRecipe(rows, { form: 'drift' }))));
    expect(cookedHash(a)).not.toBe(cookedHash(b));
  });
  it('changes only the filaments: the same trunk, units, polys, points, tones and alphas as v1', () => {
    for (const [h, o] of [[longStroke(3), {}], [wave(), { size: 22 }], [curl(), { base: 4 }], [tapStroke(60), { radial: true, base: 3, size: 22 }]] as const) {
      const rows = h.rows();
      const a = cook(formRecipe(rows, { form: 'drift', ...o })), b = cook(formRecipe(rows, { v: 2, form: 'drift', ...o }));
      const ta = polys(a).filter(p => p.gen === 0), tb = polys(b).filter(p => p.gen === 0);
      expect(JSON.stringify(tb)).toBe(JSON.stringify(ta));
      expect(b.nPolys).toBe(a.nPolys);
      expect(b.nPts).toBe(a.nPts);
      expect(b.ceilingMax).toBe(a.ceilingMax);
      expect(Array.from(b.count)).toEqual(Array.from(a.count));
      expect(Array.from(b.unit)).toEqual(Array.from(a.unit));
      expect(Array.from(b.tone)).toEqual(Array.from(a.tone));
      expect(Array.from(b.alpha)).toEqual(Array.from(a.alpha));
      // arcs along each filament (the field walk's steps) are v1's
      for (let j = 0; j < a.nPts; j++) expect(b.pts[4 * j + 3]).toBe(a.pts[4 * j + 3]);
    }
  });
});

// ---------------------------------------------------------------------------- roots

describe('Drift v2: roots', () => {
  const gestures: [string, Hand, Parameters<typeof formRecipe>[1]][] = [
    ['wave, brush 3', wave(5), { form: 'drift', size: 3, base: 3 }],
    ['wave, brush 9', wave(6), { form: 'drift', size: 9, base: 3 }],
    ['wave, brush 22', wave(7), { form: 'drift', size: 22, base: 3 }],
    ['slow line, brush 22', slow(), { form: 'drift', size: 22, base: 3 }],
    ['curl, brush 14', curl(), { form: 'drift', size: 14, base: 4 }],
    ['long pen stroke', longStroke(3), { form: 'drift', base: 3, nib: 'pen', size: 3 }],
    ['zoomed in (z 4)', wave(8), { form: 'drift', size: 12, base: 3, z: 4 }],
  ];
  for (const [name, h, o] of gestures) {
    it(`filaments pour off the trunk's edge without stacking on it: ${name}`, () => {
      const z = o.z ?? 1, rows = h.rows(z), tol = 0.1 / z, floor = 0.29 / z;
      const v2 = roots(cook(formRecipe(rows, { ...o, v: 2 })), floor);
      expect(v2.length).toBeGreaterThan(20);
      for (const r of v2) {
        // every root starts outside the trunk: 0.2 sp beyond the untapered edge, more where the
        // trunk's envelope (its entry and exit tapers, which operators never see) draws it thinner
        expect(r.gap).toBeGreaterThan(0.1 / z);
        // and never stacks on it
        expect(r.worst).toBeGreaterThan(-tol);
      }
      // nor does any filament anywhere along it: one the field brings back across the stretch it
      // poured off passes under it as a hairline
      for (const r of roots(cook(formRecipe(rows, { ...o, v: 2 })), floor, Infinity, true)) expect(r.worst).toBeGreaterThan(-tol);
      // and touches it, away from the tapers
      const touching = v2.filter(r => r.gap < 0.3 / z).length / v2.length;
      expect(touching).toBeGreaterThan(0.6);
      // the same measure flags v1's roots, released on the centreline (the Night white core)
      const v1 = roots(cook(formRecipe(rows, { ...o, v: 1 })), floor);
      expect(v1.filter(r => r.worst < -tol).length / v1.length).toBeGreaterThan(0.9);
    });
  }
  it('a radial burst leaves the seed dot at its rim', () => {
    for (const size of [3, 22]) {
      const c = cook(formRecipe(tapStroke(60).rows(), { v: 2, form: 'drift', base: 3, radial: true, size }));
      const P = polys(c), dot = P[0];
      expect(dot.gen).toBe(0);
      expect(dot.x.length).toBe(1);
      const first = P.filter(p => p.gen === 1 && p.tone % 5 === 1);
      expect(first.length).toBe(24);
      for (const p of first) {
        const d = Math.hypot(p.x[0] - dot.x[0], p.y[0] - dot.y[0]);
        expect(d).toBeGreaterThan(dot.w[0] / 2 + 0.1);
        expect(d).toBeLessThan(dot.w[0] / 2 + 0.3);
        // the whole root clears the dot (a round end)
        for (let k = 0; k < p.x.length; k++) {
          if (p.w[k] <= 0.29) continue;
          const r = Math.hypot(p.x[k] - dot.x[0], p.y[k] - dot.y[0]);
          expect(Math.sqrt(r * r - (p.w[k] / 2) ** 2)).toBeGreaterThan(dot.w[0] / 2 - 1e-6);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------- invariants

describe('Drift v2: pipeline invariants', () => {
  it('incremental ≡ full (bitwise) with holds, closure flicker, pools and radial seeds', () => {
    expect(opsIncremental(drift2, wave(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(drift2, wave(11), { size: 22, holds: [[20, 2.5]] })).toBeNull();
    expect(opsIncremental(drift2, curl(), { closed: true, holds: [[20, 2.5]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(drift2, longStroke(5), { pools: [60, 2, 150, 1], holds: [[12, 1]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(drift2, tapStroke(700), { radial: true, pools: [0, 1.5] })).toBeNull();
    expect(opsIncremental(drift2, loopStroke(70), { closed: true, size: 3, nib: 'pen' })).toBeNull();
  });
  it('is deterministic and structurally sound on hard inputs', () => {
    expect(cookedHash(opsCook(drift2, wave()).c)).toBe(cookedHash(opsCook(drift2, wave()).c));
    const two = new Hand(0, 0, { seed: 1, p: 0.5 });
    two.moveTo(1, 0.5, 0.5);
    for (const { c } of [
      opsCook(drift2, two), opsCook(drift2, two, { radial: true }), opsCook(drift2, tapStroke(60), { radial: true, base: 3 }),
      opsCook(drift2, wave(), { z: 0.06 }), opsCook(drift2, wave(), { z: 16 }), opsCook(drift2, curl(), { nib: 'chisel', size: 12 }),
    ]) {
      expect(cookedProblems(c)).toEqual([]);
      for (let i = 0; i < c.nPts * 4; i++) expect(Number.isFinite(c.pts[i])).toBe(true);
    }
  });
  it('writes no more points than v1 (the budgets count the same)', () => {
    for (const [h, o] of [[wave(), { size: 22, base: 6 }], [curl(), { base: 6 }], [tapStroke(60), { radial: true, base: 6, size: 22 }]] as const) {
      const rows = h.rows();
      const a = cook(formRecipe(rows, { form: 'drift', ...o })), b = cook(formRecipe(rows, { v: 2, form: 'drift', ...o }));
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
    const ink = (c: Cooked): number => {
      let s = 0;
      for (const p of polys(c)) if (p.gen >= 1) for (let k = 1; k < p.x.length; k++) s += Math.hypot(p.x[k] - p.x[k - 1], p.y[k] - p.y[k - 1]) * (p.w[k] + p.w[k - 1]) / 2;
      return s;
    };
    const rows = wave(3).rows();
    const deep = cook(formRecipe(rows, { v: 2, form: 'drift', base: 6, size: 9 }));
    const full = arc(deep), fullInk = ink(deep);
    let prev = 0, prevInk = 0;
    for (let k = 0; k <= 96; k++) {
      const c = cook(formRecipe(rows, { v: 2, form: 'drift', base: k / 16, size: 9 }));
      const a = arc(c), i = ink(c);
      expect(a).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(a - prev).toBeLessThan(0.08 * full);
      expect(Math.abs(i - prevInk)).toBeLessThan(0.08 * fullInk);
      prev = a; prevInk = i;
    }
    expect(prev).toBeCloseTo(full, 6);
  });
  it('keeps the wake lush and the trunk clear: as much ink outside the trunk as v1, a fraction inside', () => {
    // filament ink (∫ w ds) whose centreline lies outside / inside the trunk (anywhere along it)
    const ink = (c: Cooked): [number, number] => {
      const P = polys(c), trunk = P.filter(p => p.gen === 0);
      let out = 0, inn = 0;
      for (const p of P) {
        if (p.gen < 1) continue;
        for (let k = 1; k < p.x.length; k++) {
          const mx = (p.x[k] + p.x[k - 1]) / 2, my = (p.y[k] + p.y[k - 1]) / 2;
          const a = Math.hypot(p.x[k] - p.x[k - 1], p.y[k] - p.y[k - 1]) * (p.w[k] + p.w[k - 1]) / 2;
          if (trunkClear(trunk, mx, my) > 0) out += a; else inn += a;
        }
      }
      return [out, inn];
    };
    for (const [h, size] of [[wave(4), 9], [wave(4), 22], [slow(3), 22], [longStroke(3), 3]] as const) {
      const rows = h.rows();
      const [o1, i1] = ink(cook(formRecipe(rows, { form: 'drift', size, base: 3 })));
      const [o2, i2] = ink(cook(formRecipe(rows, { v: 2, form: 'drift', size, base: 3 })));
      expect(o2).toBeGreaterThan(0.95 * o1);
      expect(i2).toBeLessThan(0.3 * i1);
    }
  });
});
