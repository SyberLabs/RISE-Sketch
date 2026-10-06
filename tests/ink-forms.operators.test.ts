/**
 * Operator behaviour: depth continuity, truncation = prefix of the ceiling cook, budgets,
 * radial seeds, Echo shapes and fold-out, tones and hierarchy alphas, determinism.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked, FormId, StrokeRecipe } from '../src/core/types';
import { PolyKind, P0_FORMS } from '../src/core/types';
import { cook, cookPreview, createIncrementalCook, draftOf, spineOf } from '../src/ink/cook';
import { buildSpine } from '../src/ink/spine';
import { FORMS, CURRENT_V, operatorFor, paperAlphaScale, echoPaperExposure } from '../src/ink/operators/registry';
import { latticeStep } from '../src/ink/operators/line.v1';
import { drawnSteps } from '../src/ink/operators/drift.v1';
import {
  formRecipe, longStroke, loopStroke, tapStroke, scribble, Hand, cookedHash, cookedDiff, cookedProblems, inkBoxContains,
} from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

const ALL: FormId[] = ['line', 'echo', 'sprout', 'drift', 'craze', 'plume', 'caustic', 'burin', 'plait', 'orbit'];

/** A medium stroke (~330 sp) with a curve, a corner and a speed change. */
function medium(seed = 3): Hand {
  const h = new Hand(0, 40, { jitter: 0.2, seed, p: 0.45 });
  h.moveTo(70, 0, 0.7, 0.75).arc(110, 40, 50, -Math.PI / 2, Math.PI / 2, 0.9).moveTo(200, 120, 1.4, 0.35);
  return h;
}

/** Points (x, y) and segment ends of polys with gen in [g0, g1]. */
function segs(c: Cooked, g0: number, g1: number, unit = -1): { P: number[]; S: number[] } {
  const P: number[] = [], S: number[] = [];
  for (let i = 0; i < c.nPolys; i++) {
    if (c.gen[i] < g0 || c.gen[i] > g1 || (unit >= 0 && c.unit[i] !== unit)) continue;
    for (let k = 0; k < c.count[i]; k++) {
      const j = c.start[i] + k;
      P.push(c.pts[4 * j], c.pts[4 * j + 1]);
      if (k > 0) S.push(c.pts[4 * j - 4], c.pts[4 * j - 3], c.pts[4 * j], c.pts[4 * j + 1]);
    }
    if (c.count[i] === 1) { const j = c.start[i]; S.push(c.pts[4 * j], c.pts[4 * j + 1], c.pts[4 * j], c.pts[4 * j + 1]); }
  }
  return { P, S };
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}
/** Directed Hausdorff distance: max over points of A of the distance to B's segments. */
function directed(A: number[], B: number[]): number {
  let worst = 0;
  for (let i = 0; i < A.length; i += 2) {
    let best = Infinity;
    for (let k = 0; k < B.length && best > worst; k += 4) {
      const d = segDist(A[i], A[i + 1], B[k], B[k + 1], B[k + 2], B[k + 3]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}
const hausdorff = (a: Cooked, b: Cooked, g0: number, g1: number): number => {
  const A = segs(a, g0, g1), B = segs(b, g0, g1);
  if (!A.P.length && !B.P.length) return 0;
  return Math.max(directed(A.P, B.S), directed(B.P, A.S));
};

describe('registry', () => {
  it('lists every Form with the spec ranges and defaults', () => {
    expect(FORMS.line).toMatchObject({ dMax: 5, baseDefault: 0, locality: 'local', p0: true });
    expect(FORMS.echo).toMatchObject({ dMax: 5, baseDefault: 2, locality: 'global', p0: true });
    expect(FORMS.sprout).toMatchObject({ dMax: 4, baseDefault: 2, locality: 'local', p0: true });
    expect(FORMS.drift).toMatchObject({ dMax: 6, baseDefault: 2, locality: 'local', p0: true });
    expect(FORMS.ripple.p0).toBe(false);
    // promoted from the forms lab: local, offered in the UI after the first four, in this order
    expect(P0_FORMS).toEqual(['line', 'echo', 'sprout', 'drift', 'craze', 'plume', 'caustic', 'burin', 'plait', 'orbit']);
    for (const f of P0_FORMS.slice(4)) {
      expect(FORMS[f]).toMatchObject({ id: f, locality: 'local', p0: true, baseDefault: 2 });
      expect(operatorFor(f, 1).id).toBe(f);
      expect(operatorFor(f, 1).baseDefault).toBe(FORMS[f].baseDefault);
      expect(paperAlphaScale(f, 3)).toBe(paperAlphaScale('sprout', 3)); // no Form-specific Paper rule
    }
    for (const f of Object.keys(CURRENT_V) as FormId[]) {
      // Sprout (clean crotches) and Drift (filaments off the trunk's edge) draw new strokes with
      // v2; v1 recipes keep cooking with v1
      expect(CURRENT_V[f]).toBe(f === 'sprout' || f === 'drift' ? 2 : 1);
      expect(operatorFor(f, 1).dMax).toBe(f === 'ripple' ? 5 : FORMS[f].dMax);
      expect(operatorFor(f, CURRENT_V[f]).dMax).toBe(f === 'ripple' ? 5 : FORMS[f].dMax);
      expect(operatorFor(f, CURRENT_V[f]).v).toBe(f === 'ripple' ? 1 : CURRENT_V[f]);
    }
    expect(operatorFor('sprout', 1).v).toBe(1);
    expect(operatorFor('sprout', 2).v).toBe(2);
    expect(operatorFor('sprout', 3).v).toBe(1); // unknown versions fall back to v1
    expect(operatorFor('drift', 1).v).toBe(1);
    expect(operatorFor('drift', 2).v).toBe(2);
    expect(operatorFor('drift', 3).v).toBe(1);
  });
  it('Paper alpha conversions', () => {
    expect(paperAlphaScale('sprout', 0)).toBe(1);
    expect(paperAlphaScale('sprout', 1)).toBe(1);
    expect(paperAlphaScale('sprout', 3)).toBeCloseTo((0.78 / 0.72) ** 2, 12);
    expect(paperAlphaScale('drift', 1)).toBeCloseTo(0.30 / 0.38, 12);
    expect(echoPaperExposure(0.1)).toBeCloseTo(0.85, 12);
    expect(echoPaperExposure(4)).toBeCloseTo((0.6 / 2) / (0.55 / 2), 12);
  });
});

describe('continuity in depth (bounded change per 1/16 level)', () => {
  // sp at z = 1; Echo's crystal appears off the trunk by at most the 3%-of-chord RDP tolerance
  const bound: Record<string, number> = { line: 1.6, echo: 8, sprout: 7, drift: 4, 
    // the promoted lab Forms (measured worst: craze 2.1, plume 3.2, caustic 4.3, burin 2.8, plait 3.9, orbit 0.6)
    craze: 4, plume: 6, caustic: 7, burin: 5, plait: 7, orbit: 1.2 };
  for (const [form, v] of [...ALL.map((f): [FormId, number] => [f, 1]), ['sprout', 2] as [FormId, number], ['drift', 2] as [FormId, number]]) {
    it(v === 1 ? form : `${form}@${v}`, () => {
      const rows = medium(5).rows();
      const dMax = FORMS[form].dMax;
      let worst = 0;
      for (const d of [0, 0.4375, 1, 1.9375, 2.5, 3, dMax - 0.0625]) {
        const a = cook(formRecipe(rows, { v, form, base: d, nib: 'pen', size: 3 }));
        const b = cook(formRecipe(rows, { v, form, base: d + 0.0625, nib: 'pen', size: 3 }));
        const h = hausdorff(a, b, 0, 9);
        worst = Math.max(worst, h);
        expect(h).toBeLessThan(bound[form]);
      }
      expect(worst).toBeGreaterThan(0);
    }, 60000); // Echo compares ~32k-point crystals pairwise (~5 s; 5 s was the default limit)
  }
  it('Echo crosses integer depths without a jump (the new level starts flat on its parents)', () => {
    const rows = medium(6).rows();
    for (const n of [1, 2]) {
      const a = cook(formRecipe(rows, { form: 'echo', base: n, nib: 'pen' }));
      const b = cook(formRecipe(rows, { form: 'echo', base: n + 1 / 64, nib: 'pen' }));
      expect(hausdorff(a, b, 1, 1)).toBeLessThan(1);
    }
  });
});

describe('Line', () => {
  it('depth 0 has no lattice and no offsets; the lattice nests and stays ≤ 2 points/sp', () => {
    expect(latticeStep(0)).toBe(0);
    expect(latticeStep(0.0625)).toBe(2);
    expect(latticeStep(3)).toBe(2);
    expect(latticeStep(3.5)).toBe(1);
    expect(latticeStep(4.25)).toBe(0.5);
    const r = formRecipe(medium().rows(), { form: 'line', base: 5, nib: 'pen', size: 3 });
    const sp = spineOf(r), c = cook(r), L = sp.s[sp.n - 1] - sp.s[0];
    expect(c.nPts).toBeLessThan(2.5 * L + 64);
    const r0 = formRecipe(medium().rows(), { form: 'line', base: 0, nib: 'pen', size: 3 });
    expect(cook(r0).nPts).toBeLessThanOrEqual(spineOf(r0).n + 32);
  });
  it('rises only inside a pool window: points far from the pool are untouched', () => {
    const rows = longStroke(2).rows();
    const a = cook(formRecipe(rows, { form: 'line', base: 1, nib: 'pen', size: 3 }));
    const b = cook(formRecipe(rows, { form: 'line', base: 1, nib: 'pen', size: 3, pools: [400, 3] }));
    let changedNear = 0;
    for (let i = 0; i < a.nPolys; i++) {
      const born = a.born[i];
      const j = b.born.indexOf(born);
      // a pool reaches [s − 48, s + 32]; level-1 nodes carry it 24 sp further; chunks are ≤ 52 sp
      if (born + 52 < 400 - 48 - 24 || born > 400 + 32 + 24) {
        expect(j).toBeGreaterThanOrEqual(0);
        expect(Array.from(b.pts.subarray(4 * b.start[j], 4 * (b.start[j] + b.count[j])))).toEqual(Array.from(a.pts.subarray(4 * a.start[i], 4 * (a.start[i] + a.count[i]))));
      } else changedNear++;
    }
    expect(changedNear).toBeGreaterThan(0);
    expect(b.nPts).toBeGreaterThan(a.nPts);
  });
});

describe('Sprout and Drift: truncation equals a direct cook at the shallower depth', () => {
  for (const [form, v] of [['sprout', 1], ['drift', 1], ['sprout', 2], ['drift', 2]] as const) {
    it(v === 1 ? form : `${form}@${v}`, () => {
      const rows = medium(7).rows();
      const deep = cook(formRecipe(rows, { v, form, base: FORMS[form].dMax }));
      for (const d of [0.5, 1.25, 2, 3.0625]) {
        const shallow = cook(formRecipe(rows, { v, form, base: d }));
        // every unit's growth at depth d lies exactly on its ceiling geometry
        const units = new Set<number>();
        for (let i = 0; i < shallow.nPolys; i++) if (shallow.gen[i] >= 1) units.add(shallow.unit[i]);
        expect(units.size).toBeGreaterThan(2);
        for (const u of units) {
          const A = segs(shallow, 1, 9, u), B = segs(deep, 1, 9, u);
          expect(directed(A.P, B.S)).toBeLessThan(2e-4);
        }
      }
    });
  }
  it('Drift draws n(d) = n_max·N(d)/150 steps', () => {
    expect(drawnSteps(150, 6)).toBe(150);
    expect(drawnSteps(100, 1)).toBeCloseTo(12, 12);
    expect(drawnSteps(150, 2)).toBeCloseTo(44.4, 12);
    expect(drawnSteps(80, 0)).toBe(0);
  });
});

describe('budgets and operator safety', () => {
  const big = (): Hand => {
    const h = new Hand(0, 0, { jitter: 0.2, seed: 2, p: 0.95 });
    for (let k = 0; k < 10; k++) h.arc(150 + 300 * k, 0, 150, Math.PI, 2 * Math.PI, 0.5).moveTo(450 + 300 * k, 0, 0.5);
    return h;
  };
  it('Sprout (v1 and v2): ≤ 900 points per sprout, causal total ≤ 24k (+ one sprout)', () => {
    for (const v of [1, 2]) {
      const c = cook(formRecipe(big().rows(), { v, form: 'sprout', base: 4, size: 30 }));
      const per = new Map<number, number>();
      let total = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) { per.set(c.unit[i], (per.get(c.unit[i]) ?? 0) + c.count[i]); total += c.count[i]; }
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(900);
      expect(total).toBeLessThanOrEqual(24000 + 900);
      expect(total).toBeGreaterThan(20000);
    }
  });
  it('Drift (v1 and v2): ≤ 150 steps per filament, causal total ≤ 30k (+ one filament)', () => {
    for (const v of [1, 2]) {
      const c = cook(formRecipe(big().rows(), { v, form: 'drift', base: 6 }));
      const per = new Map<number, number>();
      let total = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] >= 1) {
        per.set(c.unit[i], (per.get(c.unit[i]) ?? 0) + c.count[i]); total += c.count[i];
        const arc = c.pts[4 * (c.start[i] + c.count[i] - 1) + 3];
        expect(arc).toBeLessThanOrEqual(150 * 1.7 + 1e-3);
      }
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(151 + 4);
      expect(total).toBeLessThanOrEqual(30000 + 160);
    }
  });
  it('Echo: the crystal stays within 32k segments and the 40× growth cap', () => {
    const zig = new Hand(0, 0, { jitter: 0.1, seed: 4 });
    for (let k = 0; k < 6; k++) zig.moveTo(40 + 80 * k, k % 2 ? -60 : 60, 0.6).moveTo(41 + 80 * k, k % 2 ? -61 : 61, 0.05).hold(60);
    for (const r of [formRecipe(zig.rows(), { form: 'echo', base: 5 }), formRecipe(longStroke(5).rows(), { form: 'echo', base: 5 }), formRecipe(loopStroke().rows(), { form: 'echo', base: 5, closed: true })]) {
      const c = cook(r);
      let crystal = 0;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] === 1) crystal += c.count[i];
      expect(crystal).toBeLessThanOrEqual(32000 + 32000 / 255 + 2);
      expect(c.ceilingMax).toBeLessThanOrEqual(5);
    }
  });
  it('no NaN, boxes contain every point, genStart sorted, for every Form on hard inputs', () => {
    const hard: { name: string; rows: Float32Array; o?: Partial<Parameters<typeof formRecipe>[1]> }[] = [
      { name: 'long', rows: longStroke(1).rows() },
      { name: 'mouse', rows: scribble(4, 0.3, 125).rows(1, true), o: { device: 'mouse' } },
      { name: 'touch', rows: scribble(8, 1.2, 60).rows(1, true), o: { device: 'touch' } },
      { name: 'zoomed in', rows: medium().rows(16), o: { z: 16 } },
      { name: 'zoomed out', rows: medium().rows(0.06), o: { z: 0.06 } },
      { name: 'single sample', rows: new Hand(5, 5).rows() },
      { name: 'two samples', rows: new Hand(5, 5).moveTo(5.5, 5, 0.1).rows() },
      { name: 'zigzag', rows: (() => { const h = new Hand(0, 0); for (let k = 0; k < 20; k++) h.moveTo(10 * k, k % 2 ? 30 : 0, 2.5); return h; })().rows() },
      { name: 'chisel tilt', rows: new Hand(0, 0, { alt: 0.5, az: 2 }).moveTo(200, 50, 0.8).rows(), o: { nib: 'chisel', size: 12 } },
    ];
    const variants: [FormId, number][] = [...ALL.map((f): [FormId, number] => [f, 1]), ['sprout', 2], ['drift', 2]];
    for (const [form, v] of variants) for (const h of hard) for (const base of [0, 1.5, FORMS[form].dMax]) {
      const r = formRecipe(h.rows, { v, form, base, ...(h.o ?? {}), pools: [30, 1] });
      const c = cook(r);
      const p = cookedProblems(c);
      if (p.length) throw new Error(`${form}@${v} ${h.name} base ${base}: ${p.join('; ')}`);
      expect(inkBoxContains(c, r.origin)).toBe(true);
      expect(c.bytes).toBeGreaterThan(0);
    }
  });
});

describe('tones, hierarchy and kinds', () => {
  it('trunk is gen 0 (dBucket 0), Sprout gen g has dBucket min(g, 4) and α 0.92·0.72^(g−1) (v1 and v2)', () => {
    for (const v of [1, 2]) {
      const c = cook(formRecipe(medium().rows(), { v, form: 'sprout', base: 4 }));
      for (let i = 0; i < c.nPolys; i++) {
        const g = c.gen[i];
        expect(c.tone[i] % 5).toBe(Math.min(g, 4));
        if (g >= 1) expect(c.alpha[i]).toBeCloseTo(0.92 * 0.72 ** (g - 1), 6); // crowding 0 in fixtures
        else expect(c.alpha[i]).toBe(1);
      }
      expect(c.genStart.length).toBe(4 + 2);
    }
  });
  it('Drift filaments are gen 1 in thirds with dBuckets 1/2/3 and α 0.38; trunk ×0.8 (v1 and v2)', () => {
    for (const v of [1, 2]) {
      const c = cook(formRecipe(medium().rows(), { v, form: 'drift', base: 3 }));
      const seen = new Set<number>();
      for (let i = c.genStart[1]; i < c.nPolys; i++) { seen.add(c.tone[i] % 5); expect(c.alpha[i]).toBeCloseTo(0.38, 6); }
      expect([...seen].sort()).toEqual([1, 2, 3]);
    }
  });
  it('chisel trunks are Chisel polys with an angle per point; tilt turns the edge', () => {
    const flat = cook(formRecipe(new Hand(0, 0, { alt: Math.PI / 2 }).moveTo(200, 50, 0.8).rows(), { form: 'sprout', nib: 'chisel', size: 12 }));
    const tilt = cook(formRecipe(new Hand(0, 0, { alt: 0.4, az: 2 }).moveTo(200, 50, 0.8).rows(), { form: 'sprout', nib: 'chisel', size: 12 }));
    expect(flat.ang).not.toBeNull();
    expect(flat.kind[0]).toBe(PolyKind.Chisel);
    expect(flat.ang![0]).toBeCloseTo((40 * Math.PI) / 180, 5);
    expect(tilt.ang![0]).toBeCloseTo(2, 4);
    for (let i = flat.genStart[1]; i < flat.nPolys; i++) expect(flat.kind[i]).toBe(PolyKind.Ribbon);
  });
  it('a fast light brush stroke dry-splits into gated bristles (gen 0 ribbons)', () => {
    const h = new Hand(0, 0, { p: 0.2, seed: 2 });
    h.moveTo(400, 30, 2.6);
    const r = formRecipe(h.rows(), { form: 'sprout', base: 0, nib: 'brush', size: 14 });
    const c = cook(r), sp = spineOf(r);
    let bristles = 0;
    for (let i = 0; i < c.nPolys; i++) {
      if (c.gen[i] !== 0) continue;
      const j = c.start[i];
      // bristles are offset from the centreline; core chunks start on a station
      let onStation = false;
      for (let k = 0; k < sp.n; k++) if (c.pts[4 * j] === Math.fround(sp.x[k]) && c.pts[4 * j + 1] === Math.fround(sp.y[k])) { onStation = true; break; }
      if (!onStation) bristles++;
    }
    expect(bristles).toBeGreaterThan(4);
  });
});

describe('radial seeds', () => {
  const tap = tapStroke(60).rows(), bloom = tapStroke(800).rows();
  it('Line: a dot at depth 0, six crackled rays above', () => {
    const d0 = cook(formRecipe(tap, { form: 'line', base: 0, radial: true }));
    expect(d0.nPolys).toBe(1);
    expect(d0.kind[0]).toBe(PolyKind.Dot);
    const d2 = cook(formRecipe(tap, { form: 'line', base: 2, radial: true }));
    expect(d2.nPolys).toBe(7);
    expect(d2.ceilingMax).toBe(2);
  });
  it('Echo: a closed hexagonal snowflake; Sprout: 5 bush primaries ≤ gen 3; Drift: 24 filaments', () => {
    const e = cook(formRecipe(tap, { form: 'echo', base: 2, radial: true }));
    const g1 = e.genStart[1], last = e.start[e.nPolys - 1] + e.count[e.nPolys - 1] - 1;
    expect(e.pts[4 * e.start[g1]]).toBeCloseTo(e.pts[4 * last], 4);
    expect(e.pts[4 * e.start[g1] + 1]).toBeCloseTo(e.pts[4 * last + 1], 4);
    for (const v of [1, 2]) {
      const s = cook(formRecipe(tap, { v, form: 'sprout', base: 4, radial: true }));
      expect(s.genStart[2] - s.genStart[1]).toBe(5);
      expect(s.genStart.length).toBeLessThanOrEqual(3 + 2);
      expect(s.ceilingMax).toBeLessThanOrEqual(3);
    }
    for (const v of [1, 2]) {
      const d = cook(formRecipe(tap, { v, form: 'drift', base: 3, radial: true }));
      expect((d.nPolys - d.genStart[1]) / 3).toBe(24);
    }
  });
  it('a bloom rises with its pool at s = 0 (radial depth = base + a_0)', () => {
    for (const form of ALL) {
      const flat = cook(formRecipe(bloom, { form, base: 1, radial: true }));
      const risen = cook(formRecipe(bloom, { form, base: 1, radial: true, pools: [0, 1.5] }));
      expect(risen.ceilingMax).toBeGreaterThan(flat.ceilingMax);
      expect(cookedHash(risen)).not.toBe(cookedHash(flat));
      if (form !== 'line') expect(risen.nPts).toBeGreaterThan(flat.nPts);
    }
  });
});

describe('Echo', () => {
  it('a short open stroke falls back to Line at the same depth', () => {
    const h = new Hand(0, 0, { seed: 3 });
    h.arc(5, 0, 5, Math.PI, 2.8 * Math.PI, 0.5);
    const r = formRecipe(h.rows(), { form: 'echo', base: 3 });
    const c = cook(r);
    expect(c.genStart.length).toBe(2);
    const asLine = cook({ ...r, form: { form: 'line', v: 1, base: 3 } });
    expect(cookedDiff(c, asLine)).toBeNull();
  });
  it('the trunk is the bare nib at base 0 and α 0.55 / ×0.6 from base ½', () => {
    const rows = medium().rows();
    const b0 = cook(formRecipe(rows, { form: 'echo', base: 0 })), b2 = cook(formRecipe(rows, { form: 'echo', base: 2 }));
    expect(b0.alpha[0]).toBe(1);
    expect(b2.alpha[0]).toBeCloseTo(0.55, 6);
    expect(b2.pts[4 * 5 + 2] / b0.pts[4 * 5 + 2]).toBeCloseTo(0.6, 5);
  });
  it('finish provides the fold-out MorphSet: crystal points unfold from depth 0', () => {
    const r = formRecipe(medium().rows(), { form: 'echo', base: 2.5 });
    const ic = createIncrementalCook(draftOf(r));
    const c = ic.finish(r);
    const m = ic.view().morph!;
    expect(m).not.toBeNull();
    expect(m.from.length).toBe(2 * c.nPts);
    expect(m.polyFirst[0]).toBe(c.genStart[1]);
    expect(m.dur[0]).toBeCloseTo(350 + 120 * 2.5, 3);
    // trunk points do not move; crystal points start on the depth-0 generator
    for (let j = 0; j < c.start[c.genStart[1]]; j++) expect(m.from[2 * j]).toBe(c.pts[4 * j]);
    let moved = 0;
    for (let j = c.start[c.genStart[1]]; j < c.nPts; j++) if (m.from[2 * j] !== c.pts[4 * j]) moved++;
    expect(moved).toBeGreaterThan(10);
  });
  it('coverage drives the Night exposure', () => {
    const c = cook(formRecipe(medium().rows(), { form: 'echo', base: 3 }));
    expect(c.coverage).toBeGreaterThan(0);
    const fade = 1;
    const exp = Math.min(1, 0.55 / Math.sqrt(Math.max(c.coverage, 0.3)));
    expect(c.alpha[c.genStart[1]]).toBeCloseTo(fade * exp, 5);
  });
});

describe('determinism and caches', () => {
  it('two runs (with other cooks in between) are bitwise identical', () => {
    const recipes: StrokeRecipe[] = ALL.map((form) => formRecipe(longStroke(9).rows(), { form, pools: [250, 2] }));
    const first = recipes.map((r) => cookedHash(cook(r)));
    for (const form of ALL) cook(formRecipe(scribble(2).rows(), { form, base: 4 }));
    expect(recipes.map((r) => cookedHash(cook(r)))).toEqual(first);
  });
  it('the seed changes the growth but never the trunk (bristle gating aside)', () => {
    const rows = medium().rows();
    for (const form of ['sprout', 'drift'] as const) {
      const a = cook(formRecipe(rows, { form, seed: 1, nib: 'pen', size: 3 })), b = cook(formRecipe(rows, { form, seed: 2, nib: 'pen', size: 3 }));
      const t0 = a.genStart[1];
      expect(Array.from(a.pts.subarray(0, 4 * a.start[t0]))).toEqual(Array.from(b.pts.subarray(0, 4 * b.start[t0])));
      expect(cookedHash(a)).not.toBe(cookedHash(b));
    }
  });
  it('spineOf is cached per recipe and equals buildSpine', () => {
    const r = formRecipe(medium().rows(), { form: 'line' });
    const a = spineOf(r);
    expect(spineOf(r)).toBe(a);
    const b = buildSpine(r);
    expect(Array.from(a.x.subarray(0, a.n))).toEqual(Array.from(b.x.subarray(0, b.n)));
  });
  it('cookPreview respects its point budget', () => {
    for (const form of ALL) {
      const r = formRecipe(longStroke(3).rows(), { form, base: FORMS[form].dMax });
      const c = cookPreview(r, 2500);
      expect(c.nPts).toBeLessThanOrEqual(2500);
      expect(cookedProblems(c)).toEqual([]);
      expect(c.nPolys).toBeGreaterThan(0);
    }
    const small = formRecipe(medium().rows(), { form: 'line', base: 0 });
    expect(cookedDiff(cookPreview(small, 5000), cook(small))).toBeNull();
  });
});
