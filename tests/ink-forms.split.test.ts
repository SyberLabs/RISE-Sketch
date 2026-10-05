/**
 * Auto-split pieces (DESIGN §7.4 step 5): piece 1 commits with a cut tail, the
 * continuation starts at its last settled station with cut head, s0 and the resume state
 * (spine + growth-chain cursor). The pieces must meet exactly and growth must continue
 * without a gap or a duplicate.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked, FormId, StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import { cook, createInkCook, draftOf } from '../src/ink/cook';
import { continuationSamples, RESUME } from '../src/ink/spine';
import { formRecipe, longStroke, Feeder, cookedDiff, cookedProblems } from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

/** Split a recipe after `rows` rows, the way app/draft.ts would. */
function split(r: StrokeRecipe, rows: number): { a: StrokeRecipe; b: StrokeRecipe; snap: Float32Array } {
  const fd = new Feeder(r);
  const ic = createInkCook(fd.d);
  while (fd.fed < rows) { const n0 = fd.fed; fd.feed(Math.min(5, rows - fd.fed)); ic.append(fd.fed - n0); }
  const snap = ic.snapshot();
  const a: StrokeRecipe = { ...fd.freeze(false), cut: 2 };
  const total = Math.floor(r.samples.length / S.STRIDE);
  const b: StrokeRecipe = {
    ...r, samples: continuationSamples(r.samples, total, snap), s0: snap[RESUME.S], cut: 1, resume: snap,
  };
  // the live cook of piece 1 finishes to the same geometry as its one-shot cook
  expect(cookedDiff(ic.finish(a), cook(a))).toBeNull();
  return { a, b, snap };
}

const firstPt = (c: Cooked): [number, number] => [c.pts[0], c.pts[1]];
function lastTrunkPt(c: Cooked): [number, number] {
  // the last core chunk ends on the last station: the gen-0 poly whose end has the largest arc born+a
  let best = -1, bx = 0, by = 0;
  for (let i = 0; i < (c.genStart[1] ?? c.nPolys); i++) {
    const e = c.start[i] + c.count[i] - 1, s = c.born[i] + c.pts[4 * e + 3];
    if (s > best) { best = s; bx = c.pts[4 * e]; by = c.pts[4 * e + 1]; }
  }
  return [bx, by];
}

describe('split pieces', () => {
  for (const form of ['line', 'echo', 'sprout', 'drift'] as FormId[]) {
    it(`${form}: the pieces meet on one station and growth continues`, () => {
      const r = formRecipe(longStroke(4).rows(), { form, base: form === 'line' ? 3 : 2, nib: 'pen', size: 3 });
      const total = Math.floor(r.samples.length / S.STRIDE);
      const { a, b, snap } = split(r, Math.floor(total * 0.55));
      const ca = cook(a), cb = cook(b);
      expect(cookedProblems(ca)).toEqual([]);
      expect(cookedProblems(cb)).toEqual([]);
      expect(b.s0).toBeGreaterThan(100);
      // trunks join exactly (Line pins its offset to 0 at both cut ends)
      const [ax, ay] = lastTrunkPt(ca), [bx, by] = firstPt(cb);
      expect(bx).toBe(ax);
      expect(by).toBe(ay);
      expect(ca.born[0]).toBe(0);
      expect(cb.born[0]).toBe(Math.fround(b.s0));
      // a cut end has no taper: full width on both sides of the join
      expect(cb.pts[2]).toBeGreaterThan(0.5 * cb.pts[4 * 3 + 2]);
      if (form === 'sprout' || form === 'drift') {
        const unitsA = new Set<number>(), unitsB = new Set<number>();
        let maxBornA = -Infinity, minBornB = Infinity;
        for (let i = ca.genStart[1]; i < ca.nPolys; i++) { unitsA.add(ca.unit[i]); maxBornA = Math.max(maxBornA, ca.born[i]); }
        for (let i = cb.genStart[1]; i < cb.nPolys; i++) { unitsB.add(cb.unit[i]); minBornB = Math.min(minBornB, cb.born[i]); }
        const nextJ = snap[RESUME.LENGTH + 3];
        expect(Math.min(...unitsB)).toBe(nextJ);
        expect(Math.max(...unitsA)).toBe(nextJ - 1);
        expect(minBornB).toBeGreaterThan(maxBornA);
      }
      // the continuation also cooks the same live and full
      const fd = new Feeder(b), ic = createInkCook(fd.d);
      while (fd.fed < fd.total) { const n0 = fd.fed; fd.feed(7); ic.append(fd.fed - n0); }
      expect(cookedDiff(ic.finish(fd.freeze(false)), cb)).toBeNull();
      // draftOf keeps every field
      expect(draftOf(b).resume).toBe(snap);
    });
  }
});
