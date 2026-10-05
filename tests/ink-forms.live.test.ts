/**
 * Live behaviour of the incremental cook (DESIGN §3.1, §3.2, §2.3.4 live behaviour):
 * provisional tail to the nib, Line's clean nib, the Echo ghost and its snowflake snap,
 * bloom previews, growth rising under the nib only where pooled, and the ceiling query.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked, FormId } from '../src/core/types';
import { PolyKind } from '../src/core/types';
import { createInkCook, type InkLiveView } from '../src/ink/cook';
import { FORMS } from '../src/ink/operators/registry';
import { formRecipe, longStroke, loopStroke, tapStroke, Feeder, Hand, cookedProblems, cookedHash } from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

function drawTo(form: FormId, frac: number, o: Partial<Parameters<typeof formRecipe>[1]> = {}, h = longStroke(3)) {
  const fd = new Feeder(formRecipe(h.rows(), { form, ...o }));
  const ic = createInkCook(fd.d);
  const stop = Math.floor(fd.total * frac);
  while (fd.fed < stop) { const n0 = fd.fed; fd.feed(4); ic.append(fd.fed - n0); }
  return { fd, ic };
}
const live = (v: ReturnType<ReturnType<typeof createInkCook>['view']>): InkLiveView => v as InkLiveView;
const provisional = (v: InkLiveView, gen0: number): number => {
  let n = 0;
  for (let i = 0; i < v.geom.nPolys; i++) if (v.slot[i] < 0 && v.geom.gen[i] >= gen0) n++;
  return n;
};

describe('live view', () => {
  for (const form of ['line', 'echo', 'sprout', 'drift'] as FormId[]) {
    it(`${form}: the trunk reaches the nib (provisional tail), and the view is a valid Cooked`, () => {
      const { ic } = drawTo(form, 0.6, { base: form === 'line' ? 2 : 2 });
      const v = live(ic.view()), sp = ic.spine();
      expect(cookedProblems(v.geom)).toEqual([]);
      expect(v.slot.length).toBe(v.geom.nPolys);
      expect(provisional(v, 0)).toBeGreaterThan(0);
      expect(sp.settled).toBeLessThan(sp.n);
      // some trunk point sits on the last (provisional) station
      const lx = Math.fround(sp.x[sp.n - 1]), ly = Math.fround(sp.y[sp.n - 1]);
      let found = false;
      for (let j = 0; j < v.geom.nPts && !found; j++) found = v.geom.pts[4 * j] === lx && v.geom.pts[4 * j + 1] === ly;
      if (form !== 'line') expect(found).toBe(true);
      expect(v.morph).toBeNull();
    });
  }

  it('line: the nib stays clean, crackle develops behind it', () => {
    const { ic } = drawTo('line', 0.7, { base: 4, nib: 'pen', size: 3 });
    const v = ic.view().geom, sp = ic.spine();
    // nearest-station distance of geometry points near the tip vs further back
    const tipS = sp.L;
    const dist = (j: number): number => {
      let best = Infinity;
      for (let i = 0; i < sp.n; i++) {
        const dx = v.pts[4 * j] - sp.x[i], dy = v.pts[4 * j + 1] - sp.y[i];
        best = Math.min(best, dx * dx + dy * dy);
      }
      return Math.sqrt(best);
    };
    let nearTip = 0, behind = 0;
    for (let i = 0; i < v.nPolys; i++) {
      for (let k = 0; k < v.count[i]; k++) {
        const j = v.start[i] + k, s = v.born[i] + v.pts[4 * j + 3];
        if (s > tipS - 3) nearTip = Math.max(nearTip, dist(j));
        else if (s < tipS - 60 && s > tipS - 160) behind = Math.max(behind, dist(j));
      }
    }
    expect(nearTip).toBeLessThan(1.3);
    expect(behind).toBeGreaterThan(2);
  });

  it('echo: a ghost (α ≤ 0.3) appears with depth and deepens with a pool', () => {
    const none = drawTo('echo', 0.5, { base: 0 }).ic.view();
    expect(none.ghost).toBeNull();
    const { fd, ic } = drawTo('echo', 0.5, { base: 0.5 });
    const g1 = ic.view().ghost as Cooked;
    expect(g1).not.toBeNull();
    for (let i = 0; i < g1.nPolys; i++) expect(g1.alpha[i]).toBeLessThanOrEqual(0.3 + 1e-6);
    const h1 = cookedHash(g1), n1 = g1.nPts;
    fd.setPools([ic.spine().L - 2, 1.5]); ic.regrow(-1e9, 1e9);
    const g2 = ic.view().ghost as Cooked;
    expect(g2.nPts).toBeGreaterThan(n1);
    expect(cookedHash(g2)).not.toBe(h1);
    expect(ic.ceiling(ic.spine().L)).toBeLessThanOrEqual(FORMS.echo.dMax);
  });

  it('echo: when the live spine enters closure the ghost snaps into the snowflake', () => {
    const { ic } = drawTo('echo', 0.98, { base: 2 }, loopStroke(70));
    const open = ic.view().ghost as Cooked;
    ic.setClosing(true);
    const g = ic.view().ghost as Cooked;
    expect(g.nPts).toBeGreaterThan(open.nPts);
    const last = g.start[g.nPolys - 1] + g.count[g.nPolys - 1] - 1;
    expect(g.pts[0]).toBeCloseTo(g.pts[4 * last], 4);
    expect(g.pts[1]).toBeCloseTo(g.pts[4 * last + 1], 4);
  });

  it('a hold at pen-down previews its radial seed (bloom) and rises with the pool', () => {
    for (const form of ['line', 'echo', 'sprout', 'drift'] as FormId[]) {
      const fd = new Feeder(formRecipe(tapStroke(800).rows(), { form, base: 1 }));
      const ic = createInkCook(fd.d);
      while (fd.fed < fd.total) { const n0 = fd.fed; fd.feed(4); ic.append(fd.fed - n0); }
      const before = live(ic.view()).geom;
      expect(before.kind.includes(PolyKind.Dot)).toBe(false);
      fd.setPools([0, 0]); ic.regrow(-48, 32);
      const a = live(ic.view()).geom;
      expect(a.kind.includes(PolyKind.Dot)).toBe(true);
      fd.setPools([0, 2]); ic.regrow(-48, 32);
      const b = live(ic.view()).geom;
      expect(b.nPts).toBeGreaterThanOrEqual(a.nPts);
      // below the Form's radial cap the live ceiling is that cap; a seed its budget stops
      // short of it (this bush: 900 points at ~2.8) reports where it stopped, so the halo
      // brims exactly where the committed seed ends
      const cap = { line: 5, echo: 5, sprout: 3, drift: 6 }[form as 'line'];
      const ceil = ic.ceiling(0), done = ic.finish({ ...fd.freeze(false), radial: true }).ceilingMax;
      if (done < 3) expect(ceil).toBe(done);
      else expect(ceil).toBe(cap);
      if (form === 'sprout') expect(ceil).toBeLessThan(3);
    }
  });

  it('growth under the nib shows only where a pool raised the depth', () => {
    for (const form of ['sprout', 'drift'] as FormId[]) {
      const { fd, ic } = drawTo(form, 0.6);
      expect(provisional(live(ic.view()), 1)).toBe(0);
      const L = ic.spine().L;
      fd.setPools([L - 3, 0.5]); ic.regrow(L - 51, L + 29);
      const v = live(ic.view());
      expect(provisional(v, 1)).toBeGreaterThan(0);
      // provisional growth sits near the nib, within the pool's reach
      for (let i = 0; i < v.geom.nPolys; i++) if (v.slot[i] < 0 && v.geom.gen[i] >= 1) expect(v.geom.born[i]).toBeGreaterThan(L - 3 - 48 - 1);
    }
  });

  it('settled growth in the pool window regrows live and is re-drained as replacements', () => {
    const { fd, ic } = drawTo('sprout', 0.6);
    const ids = new Map<number, number>();
    ic.drainSettled((p) => ids.set(p.index, p.pts.length));
    const L = ic.spine().L;
    fd.setPools([L - 20, 1.5]); ic.regrow(L - 68, L + 12);
    let replaced = 0;
    ic.drainSettled((p, rep) => { if (rep >= 0) { expect(ids.has(rep)).toBe(true); replaced++; } });
    expect(replaced).toBeGreaterThan(0);
  });

  it('ceiling(): bounded by dMax; once the causal budget is spent a hold cannot rise', () => {
    expect(drawTo('line', 0.5).ic.ceiling(100)).toBe(5);
    const fresh = drawTo('sprout', 0.5).ic;
    expect(fresh.ceiling(fresh.spine().L)).toBe(4);
    const h = new Hand(0, 0, { jitter: 0.2, seed: 2, p: 0.95 });
    for (let k = 0; k < 10; k++) h.arc(150 + 300 * k, 0, 150, Math.PI, 2 * Math.PI, 0.5).moveTo(450 + 300 * k, 0, 0.5);
    const { ic } = drawTo('sprout', 1, { size: 30, base: 2 }, h);
    expect(ic.ceiling(ic.spine().L)).toBe(2);
  });
});
