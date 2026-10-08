/**
 * Symmetry drawing (DESIGN §2.3.1, §7.5 rule 8): placements, copy colours, placed geometry,
 * spines and samples, one-command commits, replay grouping and the fold steps.
 */
import { describe, it, expect } from 'vitest';
import type { Cooked, StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import { cook, spineOf } from '../src/ink/cook';
import { buildSpine } from '../src/ink/spine';
import { clampFolds, copyColor, foldsAt, placeCooked, placedSamples, stepFolds, SYM_FOLDS, symmetryXf, symmetryXfs } from '../src/ink/symmetry';
import { foldsAt as coreFoldsAt } from '../src/core/folds';
import { freezeRecipe, peelCommands } from '../src/doc/commands';
import { createDoc, newMeta } from '../src/doc/document';
import { sceneHash } from '../src/doc/serialize';
import { timeline } from '../src/app/replay';
import { formRecipe, longStroke } from './ink-forms.fixtures';

const C = [140, 260] as const;

/** A copy of r: new id, placement about C, Spectral hue offset (what app/draft.ts does). */
function copyOf(r: StrokeRecipe, folds: number, i: number, id: string): StrokeRecipe {
  return freezeRecipe({ ...r, id, xf: symmetryXf(folds, i, C[0], C[1], r.origin), color: copyColor(r.color, i, folds) });
}

const abs = (r: StrokeRecipe, c: Cooked, j: number): [number, number] => [r.origin[0] + c.pts[4 * j], r.origin[1] + c.pts[4 * j + 1]];

describe('placements', () => {
  it('rotate about the centre by 360°·i/n, or reflect across x = cx for Mirror', () => {
    const o = [100, 200] as const;
    const p = [30, -12];
    const ap = (m: Float64Array): [number, number] => [o[0] + m[0] * p[0] + m[2] * p[1] + m[4], o[1] + m[1] * p[0] + m[3] * p[1] + m[5]];
    const P = [o[0] + p[0], o[1] + p[1]];
    // 6-fold, copy 3 = 180°: P -> 2C − P
    const q = ap(symmetryXf(6, 3, C[0], C[1], o));
    expect(q[0]).toBeCloseTo(2 * C[0] - P[0], 9);
    expect(q[1]).toBeCloseTo(2 * C[1] - P[1], 9);
    // 4-fold, copy 1 = 90° (y down: (dx, dy) -> (−dy, dx))
    const r = ap(symmetryXf(4, 1, C[0], C[1], o));
    expect(r[0]).toBeCloseTo(C[0] - (P[1] - C[1]), 9);
    expect(r[1]).toBeCloseTo(C[1] + (P[0] - C[0]), 9);
    // Mirror
    const m = ap(symmetryXf(2, 1, C[0], C[1], o));
    expect(m[0]).toBeCloseTo(2 * C[0] - P[0], 9);
    expect(m[1]).toBeCloseTo(P[1], 9);
    // every copy of n is an isometry; there are n − 1 of them
    for (const n of SYM_FOLDS) {
      const xs = symmetryXfs(n, C[0], C[1], o);
      expect(xs.length).toBe(n - 1);
      for (const x of xs) expect(Math.abs(x[0] * x[3] - x[1] * x[2])).toBeCloseTo(1, 12);
    }
  });

  it('Spectral copies step round the hue wheel; other inks keep their colour', () => {
    const sp = { ink: 'spectral' as const, k: 3, dh: 0, dL: 0, lch: null };
    const hs = [0, 1, 2, 3, 4, 5].map(i => copyColor(sp, i, 6).dh);
    expect(hs).toEqual([0, 60, 120, 180, 240, 300]);
    expect(copyColor({ ...sp, dh: 350 }, 1, 2).dh).toBe(170);
    const moss = { ink: 'moss' as const, k: 1, dh: 4, dL: 0.01, lch: null };
    expect(copyColor(moss, 2, 6)).toBe(moss);
  });

  it('fold steps: Mirror, 3, 4, 5, 6, 8, 12; drags clamp, M wraps', () => {
    expect(clampFolds(7)).toBe(6);
    expect(clampFolds('x')).toBe(6);
    expect(stepFolds(12, 1)).toBe(2);
    expect(stepFolds(2, -1)).toBe(12);
    expect(foldsAt(6, 1)).toBe(8);
    expect(foldsAt(6, 9)).toBe(12);
    expect(foldsAt(6, -9)).toBe(2);
    expect(coreFoldsAt).toBe(foldsAt);
  });
});

describe('placed geometry (cook(copy) ≡ the stroke cooked, then placed)', () => {
  for (const form of ['sprout', 'drift', 'caustic', 'orbit'] as const) {
    it(`${form}: every copy is the exact placement of the stroke's geometry`, () => {
      const r = { ...formRecipe(longStroke(3).rows(), { form }), color: { ink: 'spectral' as const, k: 2, dh: 0, dL: 0, lch: null } };
      const c = cook(r);
      for (let i = 1; i < 6; i++) {
        const k = copyOf(r, 6, i, `copy${i}`);
        const ck = cook(k);
        expect(ck).toEqual(placeCooked(c, k.xf!, k.origin));
        expect(ck.nPolys).toBe(c.nPolys);
        // the geometry turned by 60°·i about the centre
        const t = (Math.PI / 3) * i;
        for (const j of [0, c.nPts >> 1, c.nPts - 1]) {
          const [x, y] = abs(r, c, j), [X, Y] = abs(k, ck, j);
          const ex = C[0] + Math.cos(t) * (x - C[0]) - Math.sin(t) * (y - C[1]);
          const ey = C[1] + Math.sin(t) * (x - C[0]) + Math.cos(t) * (y - C[1]);
          expect(Math.abs(X - ex)).toBeLessThan(1e-3);
          expect(Math.abs(Y - ey)).toBeLessThan(1e-3);
          expect(ck.pts[4 * j + 2]).toBe(c.pts[4 * j + 2]); // widths unchanged
        }
        // the absolute ink box contains every placed point
        for (let j = 0; j < ck.nPts; j++) {
          const [X, Y] = abs(k, ck, j);
          expect(X >= ck.inkBox.x0 - 1e-6 && X <= ck.inkBox.x1 + 1e-6 && Y >= ck.inkBox.y0 - 1e-6 && Y <= ck.inkBox.y1 + 1e-6).toBe(true);
        }
      }
    });
  }

  it('chisel angles turn with the copy; Mirror reflects them', () => {
    const r = formRecipe(longStroke(4).rows(), { form: 'line', nib: 'chisel', size: 12 });
    const c = cook(r);
    expect(c.ang).not.toBeNull();
    const k = copyOf(r, 4, 1, 'q');
    const ck = cook(k);
    const wrap = (a: number) => { let v = a % Math.PI; if (v < 0) v += Math.PI; return v; };
    for (const j of [0, 5, 40]) expect(Math.abs(wrap(ck.ang![j]) - wrap(c.ang![j] + Math.PI / 2))).toBeLessThan(1e-4);
    const m = cook(copyOf(r, 2, 1, 'm'));
    for (const j of [0, 5, 40]) expect(Math.abs(wrap(m.ang![j]) - wrap(Math.PI - c.ang![j]))).toBeLessThan(1e-4);
  });

  it('spines and sample rows are placed where the ink lies (hits, lasso, occupancy)', () => {
    const r = formRecipe(longStroke(3).rows(), { form: 'sprout' });
    const k = copyOf(r, 2, 1, 'm');
    const sp = spineOf(k), raw = buildSpine(r);
    expect(sp.n).toBe(raw.n);
    for (const i of [0, raw.n >> 1, raw.n - 1]) {
      expect(k.origin[0] + sp.x[i]).toBeCloseTo(2 * C[0] - (r.origin[0] + raw.x[i]), 3);
      expect(sp.y[i]).toBeCloseTo(raw.y[i], 4);
    }
    const ps = placedSamples(k);
    expect(placedSamples(k)).toBe(ps); // cached
    expect(placedSamples(r)).toBe(r.samples);
    expect(k.origin[0] + ps[S.X]).toBeCloseTo(2 * C[0] - (r.origin[0] + r.samples[S.X]), 3);
    expect(ps[S.T]).toBe(r.samples[S.T]);
  });
});

describe('one gesture, one command', () => {
  it('the stroke and its copies are added (and peeled) together; one undo removes them all', () => {
    const r = { ...formRecipe(longStroke(5).rows(), { form: 'sprout', pools: [150, 1.5] }), id: '0000000010001' };
    const copies = [1, 2, 3, 4, 5].map(i => copyOf(r, 6, i, `000000001000${i + 1}`));
    const doc = createDoc(newMeta(1, 1, 'd'), []);
    const cmds = peelCommands(r, copies);
    expect(cmds.length).toBe(2);
    const invs = cmds.map(c => doc.apply(c));
    expect(doc.size).toBe(6);
    const h = sceneHash(doc.ordered());
    doc.apply(invs[1]); // undo 1: the pools drain from every copy
    expect(doc.ordered().every(x => x.pools.length === 0)).toBe(true);
    doc.apply(invs[0]); // undo 2: the whole gesture leaves
    expect(doc.size).toBe(0);
    for (const c of cmds) doc.apply(c);
    expect(sceneHash(doc.ordered())).toBe(h);
    expect(peelCommands({ ...r, pools: new Float32Array(0) }, copies.map(c => ({ ...c, pools: new Float32Array(0) }))).length).toBe(1);
  });

  it('replay plays a stroke and its copies together', () => {
    const r = { ...formRecipe(longStroke(3).rows(), { form: 'line' }), id: 'a', created: 1000 };
    const copies = [1, 2].map(i => ({ ...copyOf(r, 3, i, `a${i}`), created: 1000 }));
    const next = { ...r, id: 'b', created: 9000 };
    const tl = timeline([r, ...copies, next]);
    expect(tl.starts[1]).toBe(tl.starts[0]);
    expect(tl.starts[2]).toBe(tl.starts[0]);
    const solo = timeline([r, next]);
    expect(tl.starts[3]).toBeCloseTo(solo.starts[1], 9);
  });
});
