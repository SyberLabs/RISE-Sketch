/**
 * Integration seam (wave 2): the incremental cook exposes its own spine builder's filtered tip
 * and jitter, so app/draft.ts steps Rise and feeds the learner from exactly the spine it cooks.
 */
import { describe, it, expect } from 'vitest';
import { S } from '../src/core/types';
import { createInkCook } from '../src/ink/cook';
import { createSpineBuilder } from '../src/ink/spine';
import { formRecipe, longStroke, Feeder } from './ink-forms.fixtures';

describe('InkIncrementalCook.tip / jitter', () => {
  it('match a SpineBuilder fed the same rows, at every chunk and on a later clock', () => {
    for (const device of ['pen', 'mouse'] as const) {
      const r = formRecipe(longStroke(4).rows(), { form: 'sprout' });
      const rr = { ...r, device };
      const fd = new Feeder(rr), ic = createInkCook(fd.d);
      const sb = createSpineBuilder(fd.d);
      while (fd.fed < fd.total) {
        const n0 = fd.fed;
        fd.feed(7);
        ic.append(fd.fed - n0);
        sb.append();
        const tLast = fd.d.samples.data[(fd.fed - 1) * S.STRIDE + S.T];
        for (const now of [undefined, tLast, tLast + 120]) {
          const a = { ...ic.tip(now) }, b = { ...sb.tip(now) };
          expect(a).toEqual(b);
        }
        expect(Object.is(ic.jitter(), sb.jitter())).toBe(true);
      }
      expect(ic.tip().travel).toBeGreaterThan(100);
    }
  });
});
