/**
 * Lift-zone correctness: whatever was emitted live, the committed geometry follows the
 * FINAL spine and envelope (end flush, seam weld, exit taper / seated bulb, TeTrunk ≤
 * 0.25·len, closure). Equivalence tests cannot see these (both paths share finish), so
 * they are checked against the final spine directly.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked, FormId, StrokeRecipe } from '../src/core/types';
import { PolyKind } from '../src/core/types';
import { cook, createIncrementalCook, spineOf } from '../src/ink/cook';
import { finalEnvelope } from '../src/ink/envelope';
import { Sampler } from '../src/ink/operators/types';
import { operatorFor } from '../src/ink/operators/registry';
import { drySplit } from '../src/ink/nibs';
import { createSpineBuilder } from '../src/ink/spine';
import { BLOCK } from '../src/ink/cook';
import { formRecipe, longStroke, Hand, Feeder, cookedDiff, mulberry32 } from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

/**
 * A fast ~114 sp flick: Te = 30 sp but 0.25·len ≈ 28.5 sp, so TeTrunk < Te at lift, while
 * the first block ends before the 56 sp tail zone (only the head rule re-emits it).
 */
function flick(): Hand {
  const h = new Hand(0, 0, { jitter: 0.1, seed: 4, p: 0.7 });
  h.moveTo(116, 8, 2.4);
  return h;
}
/** A loop that closes with a ~20 sp gap, so the seam weld moves the last ~40 sp. */
function gapLoop(): Hand {
  const h = new Hand(170, 100, { jitter: 0.1, seed: 6, p: 0.6 });
  h.arc(100, 100, 70, 0, 2 * Math.PI - 0.28, 0.8);
  return h;
}

/** Gen-0 core chunk points must be the final stations, widths = w·E(s)·style.w (× 1 − dry-split). */
function checkTrunk(r: StrokeRecipe, c: Cooked): void {
  const sp = spineOf(r), env = finalEnvelope(r, sp), style = operatorFor(r.form.form, 1).trunkStyle(r);
  let st = 0; // station cursor along the chunk sequence
  for (let i = 0; i < c.nPolys && c.gen[i] === 0; i++) {
    if (c.kind[i] === PolyKind.Dot) continue;
    const first = c.start[i];
    // core chunks start where the previous one ended (bristles are ordered after all cores)
    if (i > 0 && c.gen[i - 1] === 0 && Math.abs(c.pts[4 * first] - sp.x[st]) > 1e-9) break;
    for (let k = 0; k < c.count[i]; k++) {
      const j = first + k, s = st + k;
      expect(c.pts[4 * j]).toBe(Math.fround(sp.x[s]));
      expect(c.pts[4 * j + 1]).toBe(Math.fround(sp.y[s]));
      const w = sp.w[s] * env.at(sp.s[s]) * style.w, ds = drySplit(r.stroke.nib, sp.vn[s], sp.p[s], r.device);
      expect(c.pts[4 * j + 2]).toBe(Math.fround(ds > 0 ? w * (1 - ds) : w));
    }
    st += c.count[i] - 1;
  }
  expect(st).toBe(sp.n - 1);
}

/** Each growth unit's first gen-1 poly starts on the final spine at its born arc. */
function checkAnchors(r: StrokeRecipe, c: Cooked): number {
  const sp = spineOf(r), at = new Sampler(sp, sp.n - 1), p = new Float64Array(2);
  const seen = new Set<number>();
  for (let i = c.genStart[1] ?? c.nPolys; i < c.nPolys && c.gen[i] === 1; i++) {
    if (seen.has(c.unit[i])) continue;
    seen.add(c.unit[i]);
    at.pos(c.born[i], p);
    const j = c.start[i];
    expect(Math.abs(c.pts[4 * j] - p[0])).toBeLessThan(1e-4);
    expect(Math.abs(c.pts[4 * j + 1] - p[1])).toBeLessThan(1e-4);
  }
  return seen.size;
}

/** Live path with random chunking and closure flicker, frozen as `closed`. */
function live(r: StrokeRecipe, closed: boolean, seed: number): Cooked {
  const fd = new Feeder(r), ic = createIncrementalCook(fd.d), rand = mulberry32(seed);
  let closing = false;
  while (fd.fed < fd.total) {
    const n0 = fd.fed; fd.feed(1 + Math.floor(rand() * 9)); ic.append(fd.fed - n0);
    if (rand() < 0.1) { closing = !closing; ic.setClosing(closing); }
  }
  return ic.finish(fd.freeze(closed));
}

describe('lift zones follow the final spine and envelope', () => {
  const plain: FormId[] = ['echo', 'sprout', 'drift'];
  for (const form of plain) {
    it(`${form}: trunk on a short flick (TeTrunk = 0.25·len), live and full`, () => {
      const r = formRecipe(flick().rows(), { form });
      const sp = spineOf(r), env = finalEnvelope(r, sp);
      expect(env.TeTrunk).toBeLessThan(env.Te);
      expect(sp.L - 56).toBeGreaterThan(50);
      checkTrunk(r, cook(r));
      checkTrunk(r, live(r, false, 3));
    });
    it(`${form}: trunk and anchors on a welded loop, live and full`, () => {
      const r = formRecipe(gapLoop().rows(), { form, closed: true });
      for (const c of [cook(r), live(r, true, 5)]) {
        checkTrunk(r, c);
        if (form !== 'echo') expect(checkAnchors(r, c)).toBeGreaterThan(3);
      }
    });
    it(`${form}: trunk with exit taper / seated end on a long stroke`, () => {
      for (const nib of ['brush', 'pen'] as const) {
        const r = formRecipe(longStroke(8).rows(), { form, nib, size: nib === 'pen' ? 3 : 9 });
        const sp = spineOf(r), env = finalEnvelope(r, sp);
        expect(env.Tx + (env.seated ? 6 : 0)).toBeGreaterThan(0);
        checkTrunk(r, cook(r));
        checkTrunk(r, live(r, false, 9));
        if (form !== 'echo') checkAnchors(r, cook(r));
      }
    });
  }

  it('a block settled before lift inside the exit taper is re-emitted with it', () => {
    let tested = 0;
    for (let len = 900; len < 1000 && tested < 3; len += 7) {
      const h = new Hand(0, 0, { jitter: 0.05, seed: 3, p: 0.8 });
      h.moveTo(len - 130, 4, 1.0).moveTo(len, 0, 2.4);
      for (const form of ['sprout', 'drift', 'echo'] as FormId[]) {
        const r = formRecipe(h.rows(), { form });
        const b = createSpineBuilder(r); b.append();
        const pre = b.spine.s[b.spine.settled - 1];
        const sp = spineOf(r), env = finalEnvelope(r, sp);
        const lastBlockEnd = Math.floor(pre / BLOCK) * BLOCK;
        if (!(env.Tx > 0 && lastBlockEnd > sp.L - env.Tx + 1)) continue;
        tested++;
        checkTrunk(r, cook(r));
        checkTrunk(r, live(r, false, len));
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('line at depth 0 is exactly the spine ribbon (including the welded seam)', () => {
    for (const [h, closed] of [[longStroke(1), false], [gapLoop(), true], [flick(), false]] as const) {
      const r = formRecipe(h.rows(), { form: 'line', base: 0, closed });
      checkTrunk(r, cook(r));
      checkTrunk(r, live(r, closed, 2));
    }
  });

  it('a closed Line pins its seam: both ends sit exactly on the welded start', () => {
    const r = formRecipe(gapLoop().rows(), { form: 'line', base: 3, closed: true, nib: 'pen', size: 3 });
    const c = cook(r), sp = spineOf(r);
    const lastPoly = c.genStart[1] - 1, e = c.start[lastPoly] + c.count[lastPoly] - 1;
    expect(c.pts[0]).toBe(Math.fround(sp.x[0]));
    expect(c.pts[1]).toBe(Math.fround(sp.y[0]));
    expect(c.pts[4 * e]).toBe(Math.fround(sp.x[sp.n - 1]));
    expect(c.pts[4 * e + 1]).toBe(Math.fround(sp.y[sp.n - 1]));
    expect(sp.x[sp.n - 1]).toBe(sp.x[0]);
    // and the loop really is rough in between
    let maxOff = 0;
    for (let i = 0; i < sp.n; i++) {
      let best = Infinity;
      for (let j = 0; j < c.nPts; j += 1) {
        const dx = c.pts[4 * j] - sp.x[i], dy = c.pts[4 * j + 1] - sp.y[i];
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      maxOff = Math.max(maxOff, Math.sqrt(best));
    }
    expect(maxOff).toBeGreaterThan(0.5);
  });

  it('closure only changes the head and tail zones of an open-vs-closed loop', () => {
    const rows = gapLoop().rows();
    for (const form of ['line', 'sprout', 'drift'] as FormId[]) {
      const a = cook(formRecipe(rows, { form, closed: false })), b = cook(formRecipe(rows, { form, closed: true }));
      const sp = spineOf(formRecipe(rows, { form, closed: false }));
      const L = sp.s[sp.n - 1];
      // polys born well inside the loop are identical
      const key = (c: Cooked, i: number): string => `${c.gen[i]}:${c.unit[i]}:${c.born[i]}:${c.count[i]}`;
      const mid = (c: Cooked): Map<string, number> => {
        const m = new Map<string, number>();
        for (let i = 0; i < c.nPolys; i++) if (c.born[i] > 110 && c.born[i] < L - 130) m.set(key(c, i), i);
        return m;
      };
      const ma = mid(a), mb = mid(b);
      expect(ma.size).toBeGreaterThan(0);
      let same = 0;
      for (const [k, i] of ma) {
        const j = mb.get(k);
        if (j === undefined) continue;
        const pa = a.pts.subarray(4 * a.start[i], 4 * (a.start[i] + a.count[i]));
        const pb = b.pts.subarray(4 * b.start[j], 4 * (b.start[j] + b.count[j]));
        expect(Array.from(pa)).toEqual(Array.from(pb));
        same++;
      }
      expect(same).toBe(ma.size);
    }
  });

  it('live closure flicker never changes the committed result', () => {
    const r = formRecipe(gapLoop().rows(), { form: 'sprout', closed: true });
    expect(cookedDiff(live(r, true, 11), cook(r))).toBeNull();
    const ro = formRecipe(gapLoop().rows(), { form: 'sprout', closed: false });
    expect(cookedDiff(live(ro, false, 12), cook(ro))).toBeNull();
  });
});
