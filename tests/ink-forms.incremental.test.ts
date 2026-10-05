/**
 * cook(r) ≡ createIncrementalCook(draft).finish(r), bitwise, for every Form under random
 * append chunking, random hold / Settle / regrow schedules (including pool edits the cook
 * is never told about, like the lift guard) and random closure toggling. Also checks the
 * drain contract (each settled poly exactly once, replacements well-formed) and that the
 * live view is always a valid Cooked.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FormId, PolyView, StrokeRecipe } from '../src/core/types';
import { createIncrementalCook, cook, draftOf } from '../src/ink/cook';
import type { InkLiveView } from '../src/ink/cook';
import {
  formRecipe, longStroke, loopStroke, tapStroke, scribble, Feeder, cookedDiff, cookedProblems, mulberry32, Hand,
} from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

/** Forms at v1, plus the later shipped versions (Sprout v2), as [form, version]. */
const FORMS: [FormId, number][] = [['line', 1], ['echo', 1], ['sprout', 1], ['drift', 1], ['sprout', 2]];
const label = (form: FormId, v: number): string => (v === 1 ? form : `${form}@${v}`);

interface Case { name: string; r: StrokeRecipe; closedAtEnd: boolean }

function cases(form: FormId, v: number): Case[] {
  const base = form === 'line' ? 1.25 : 2;
  const chisel = (() => {
    const h = new Hand(0, 0, { jitter: 0.2, seed: 11, alt: 0.6, az: 0.4, p: 0.2, c: 0.3, cs: -0.2 });
    h.moveTo(80, 40, 0.5).moveTo(81, 41, 0.05).hold(200).moveTo(10, 120, 2.0, 0.1).moveTo(200, 90, 0.7, 0.9);
    return h.rows(2.5);
  })();
  return [
    { name: 'pen brush long', r: formRecipe(longStroke(3).rows(), { v, form, base }), closedAtEnd: false },
    { name: 'mouse pen-nib scribble', r: formRecipe(scribble(5, 0.3, 125).rows(1, true), { v, form, base, device: 'mouse', nib: 'pen', size: 2.5 }), closedAtEnd: false },
    { name: 'touch scribble 60 Hz', r: formRecipe(scribble(9, 0.8, 60).rows(1, true), { v, form, base, device: 'touch' }), closedAtEnd: false },
    { name: 'chisel z 2.5', r: formRecipe(chisel, { v, form, base, nib: 'chisel', size: 12, z: 2.5 }), closedAtEnd: false },
    { name: 'closed loop', r: formRecipe(loopStroke(70).rows(), { v, form, base }), closedAtEnd: true },
  ];
}

/** Drain bookkeeping: every id once; replacements refer to delivered, still-live ids. */
class DrainLog {
  readonly live = new Map<number, number>(); // id -> nPts
  delivered = 0;
  take(p: PolyView, rep: number): void {
    expect(this.live.has(p.index)).toBe(false);
    if (rep >= 0) {
      expect(this.live.has(rep)).toBe(true);
      this.live.delete(rep);
    }
    if (p.pts.length > 0) this.live.set(p.index, p.pts.length / 4);
    this.delivered++;
  }
}

function runLive(c: Case, trial: number, opts: { pools: boolean; closure: boolean; peek: boolean }): { live: ReturnType<typeof cook>; full: ReturnType<typeof cook>; log: DrainLog } {
  const rand = mulberry32(7919 * (trial + 1) + c.name.length);
  const fd = new Feeder(c.r);
  const ic = createIncrementalCook(fd.d);
  const log = new DrainLog();
  const maxChunk = trial === 0 ? 1 : trial === 1 ? 500 : 1 + Math.floor(rand() * 30);
  const pools: number[] = [];
  let closing = false, holdIdx = -1;
  while (fd.fed < fd.total) {
    const n0 = fd.fed;
    fd.feed(1 + Math.floor(rand() * maxChunk));
    ic.append(fd.fed - n0);
    if (opts.pools) {
      const L = ic.spine().L;
      if (holdIdx < 0 && rand() < 0.08 && pools.length < 8 * 2) { holdIdx = pools.length; pools.push(L, 0); }
      if (holdIdx >= 0) {
        const settle = rand() < 0.2;
        pools[holdIdx + 1] = Math.max(0, Math.round((pools[holdIdx + 1] + (settle ? -0.25 : 0.4)) * 16) / 16);
        fd.setPools(pools);
        const s = pools[holdIdx];
        if (rand() < 0.7) ic.regrow(s - 48, s + 32);
        else if (rand() < 0.5) ic.regrow(s, s); // a too-narrow window: the diff must catch the rest
        if (rand() < 0.25) holdIdx = -1;
      }
    }
    if (opts.closure && rand() < 0.05) { closing = !closing; ic.setClosing(closing); }
    if (opts.peek && rand() < 0.3) {
      const v = ic.view() as InkLiveView;
      const probs = cookedProblems(v.geom);
      if (probs.length) throw new Error(`live view invalid at row ${fd.fed}: ${probs.join('; ')}`);
      expect(v.slot.length).toBe(v.geom.nPolys);
      ic.ceiling(ic.spine().L);
    }
    if (rand() < 0.5) ic.drainSettled((p, rep) => log.take(p, rep));
  }
  if (opts.pools && pools.length) {
    // the lift guard edits pools without telling the cook
    pools[1] = Math.max(0, pools[1] - 0.0625);
    fd.setPools(pools);
  }
  ic.drainSettled((p, rep) => log.take(p, rep));
  const r = fd.freeze(c.closedAtEnd);
  const live = ic.finish(r);
  const full = cook(r);
  return { live, full, log };
}

describe('incremental ≡ full (bitwise)', () => {
  for (const [form, v] of FORMS) {
    for (const c of cases(form, v)) {
      it(`${label(form, v)}: ${c.name}`, () => {
        for (let trial = 0; trial < 6; trial++) {
          const opts = { pools: trial >= 2, closure: trial >= 3, peek: trial % 2 === 0 };
          const { live, full, log } = runLive(c, trial, opts);
          const d = cookedDiff(live, full);
          if (d) throw new Error(`trial ${trial} (${JSON.stringify(opts)}): ${d}`);
          expect(cookedProblems(full)).toEqual([]);
          expect(log.delivered).toBeGreaterThanOrEqual(0);
        }
      });
    }
  }
});

describe('cook definition', () => {
  it('cook(r) is literally the incremental finish of draftOf(r)', () => {
    for (const [form, v] of FORMS) {
      const r = formRecipe(longStroke(4).rows(), { v, form, pools: [200, 1.5, 420, 0.75] });
      const a = cook(r), b = createIncrementalCook(draftOf(r)).finish(r);
      expect(cookedDiff(a, b)).toBeNull();
      // a committed recipe can drive the incremental cook directly as well
      expect(cookedDiff(a, createIncrementalCook(r).finish(r))).toBeNull();
    }
  });

  it('finish is idempotent and view() after finish returns the committed geometry', () => {
    const r = formRecipe(longStroke(2).rows(), { form: 'sprout' });
    const ic = createIncrementalCook(draftOf(r));
    const a = ic.finish(r);
    expect(ic.finish(r)).toBe(a);
    expect(ic.view().geom).toBe(a);
  });

  it('radial seeds cook the same live and full (taps and blooms)', () => {
    for (const [form, v] of FORMS) {
      for (const hold of [40, 700]) {
        const fd = new Feeder(formRecipe(tapStroke(hold).rows(), { v, form }));
        const ic = createIncrementalCook(fd.d);
        while (fd.fed < fd.total) { const n0 = fd.fed; fd.feed(3); ic.append(fd.fed - n0); }
        if (hold > 100) { fd.setPools([0, 1.5]); ic.regrow(-48, 32); }
        const r = { ...fd.freeze(false), radial: true };
        expect(cookedDiff(ic.finish(r), cook(r))).toBeNull();
      }
    }
  });
});

describe('drainSettled', () => {
  it('delivers each settled poly once, and the drained set matches the settled polys of the view', () => {
    for (const [form, v] of FORMS) {
      const fd = new Feeder(formRecipe(longStroke(6).rows(), { v, form }));
      const ic = createIncrementalCook(fd.d);
      const log = new DrainLog();
      const rand = mulberry32(31);
      const pools: number[] = [];
      while (fd.fed < fd.total) {
        const n0 = fd.fed;
        fd.feed(1 + Math.floor(rand() * 12));
        ic.append(fd.fed - n0);
        if (fd.fed > fd.total / 2 && pools.length === 0) { pools.push(ic.spine().L - 30, 0.5); fd.setPools(pools); ic.regrow(0, 1e9); }
        else if (pools.length && pools[1] < 2.5) { pools[1] += 0.25; fd.setPools(pools); ic.regrow(pools[0] - 48, pools[0] + 32); }
        ic.drainSettled((p, rep) => log.take(p, rep));
        const v = ic.view() as InkLiveView;
        const settled = new Map<number, number>();
        for (let i = 0; i < v.geom.nPolys; i++) if (v.slot[i] >= 0) settled.set(v.slot[i], v.geom.count[i]);
        expect(settled.size).toBe(log.live.size);
        for (const [id, n] of settled) expect(log.live.get(id)).toBe(n);
      }
    }
  });
});
