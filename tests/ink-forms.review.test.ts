/**
 * Review regressions for ink-forms: finish(r) ≡ cook(r) even when r is not what the draft
 * saw; bad resume cursors; radial Echo bumps always outward; radial Drift emits in every
 * direction; azimuth wrap in Sprout's lean; live state independent of pool history (causal
 * budget re-existence); Echo's live ceiling; lazy unit cooks at depth 0; cookPreview budgets;
 * and a randomized incremental ≡ full fuzz over Forms, devices, nibs, zooms, bases (0
 * included), holds, Settles, the lift guard and closure flicker. (The bloom ceiling is in
 * ink-forms.live.test.ts.)
 */
import { describe, it, expect, vi } from 'vitest';
import type { Cooked, Device, FormId, NibId, StrokeRecipe } from '../src/core/types';
import { PL, S } from '../src/core/types';
import { cook, cookPreview, createInkCook, createIncrementalCook, draftOf, type InkLiveView } from '../src/ink/cook';
import { continuationSamples, RESUME } from '../src/ink/spine';
import { FORMS } from '../src/ink/operators/registry';
import {
  formRecipe, longStroke, loopStroke, tapStroke, Feeder, Hand, cookedDiff, cookedProblems, inkBoxContains, mulberry32,
} from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

const ALL: FormId[] = ['line', 'echo', 'sprout', 'drift', 'craze', 'plume', 'caustic', 'burin', 'plait', 'orbit'];

/** A long, heavy, wide stroke that spends Sprout's and Drift's causal budgets. */
function bigStroke(): Hand {
  const h = new Hand(0, 0, { jitter: 0.2, seed: 2, p: 0.95 });
  for (let k = 0; k < 10; k++) h.arc(150 + 300 * k, 0, 150, Math.PI, 2 * Math.PI, 0.5).moveTo(450 + 300 * k, 0, 0.5);
  return h;
}

/** Feed a whole recipe through a live cook in fixed chunks. */
function feedAll(r: StrokeRecipe, chunk = 5): { fd: Feeder; ic: ReturnType<typeof createInkCook> } {
  const fd = new Feeder(r), ic = createInkCook(fd.d);
  while (fd.fed < fd.total) { const n0 = fd.fed; fd.feed(chunk); ic.append(fd.fed - n0); }
  return { fd, ic };
}

describe('finish(r) ≡ cook(r) when r is not exactly what the draft consumed', () => {
  it('a pointer-up row present only in the recipe', () => {
    for (const form of ALL) {
      const r = formRecipe(longStroke(3).rows(), { form, pools: [200, 1.5] });
      const fd = new Feeder(r), ic = createInkCook(fd.d);
      while (fd.fed < fd.total - 1) { const n0 = fd.fed; fd.feed(Math.min(5, fd.total - 1 - fd.fed)); ic.append(fd.fed - n0); }
      fd.setPools([200, 1.5]); ic.regrow(152, 232);
      const done = ic.finish(r);
      expect(cookedDiff(done, cook(r))).toBeNull();
      expect(ic.view().geom).toBe(done);
      expect(ic.finish(r)).toBe(done);
    }
  });

  it('a draft that saw more rows than the recipe, or a changed pen-down field', () => {
    const r = formRecipe(longStroke(5).rows(), { form: 'sprout' });
    const short: StrokeRecipe = { ...r, samples: r.samples.slice(0, (Math.floor(r.samples.length / S.STRIDE) - 3) * S.STRIDE) };
    expect(cookedDiff(feedAll(r).ic.finish(short), cook(short))).toBeNull();
    const restyled: StrokeRecipe = { ...r, form: { ...r.form, base: 3 }, seed: 99 };
    expect(cookedDiff(feedAll(r).ic.finish(restyled), cook(restyled))).toBeNull();
  });

  it('Echo keeps its fold-out MorphSet through the fallback', () => {
    const r = formRecipe(longStroke(3).rows(), { form: 'echo', base: 2.5 });
    const fd = new Feeder(r), ic = createInkCook(fd.d);
    while (fd.fed < fd.total - 2) { const n0 = fd.fed; fd.feed(1); ic.append(fd.fed - n0); }
    const c = ic.finish(r), m = ic.view().morph;
    expect(m).not.toBeNull();
    expect(m!.from.length).toBe(2 * c.nPts);
  });
});

describe('resume cursors', () => {
  const whole = formRecipe(longStroke(4).rows(), { form: 'sprout' });
  const total = Math.floor(whole.samples.length / S.STRIDE);
  const fd = new Feeder(whole), ic = createInkCook(fd.d);
  while (fd.fed < Math.floor(total * 0.55)) { const n0 = fd.fed; fd.feed(6); ic.append(fd.fed - n0); }
  const snap = ic.snapshot();
  const piece = (form: FormId, resume: Float32Array): StrokeRecipe => ({
    ...whole, form: { form, v: 1, base: 2 }, samples: continuationSamples(whole.samples, total, resume), s0: resume[RESUME.S], cut: 1, resume,
  });

  it('a cursor snapshot() could not have made is ignored: the chain restarts at s0, fast', () => {
    // fields after the spine's RESUME block: mark, phase, s, j, side, budget
    const bad: [number, number][] = [[1, 5], [1, NaN], [2, NaN], [2, -1e9], [2, Infinity], [3, NaN], [3, -4], [3, 2.5], [4, 7], [5, -1], [5, NaN]];
    for (const form of ['sprout', 'drift'] as FormId[]) {
      const fresh = cook(piece(form, snap.slice(0, RESUME.LENGTH)));
      for (const [field, v] of bad) {
        const b = snap.slice(); b[RESUME.LENGTH + field] = v;
        const t0 = performance.now();
        const c = cook(piece(form, b));
        expect(performance.now() - t0).toBeLessThan(1500);
        expect(cookedProblems(c)).toEqual([]);
        expect(cookedDiff(c, fresh)).toBeNull();
        // and live: appends stay cheap and finish matches
        const f2 = new Feeder(piece(form, b)), i2 = createInkCook(f2.d);
        while (f2.fed < f2.total) { const n0 = f2.fed; f2.feed(9); i2.append(f2.fed - n0); }
        expect(cookedDiff(i2.finish(f2.freeze(false)), cook(f2.freeze(false)))).toBeNull();
      }
    }
  });

  it('a genuine cursor is still honoured', () => {
    const c = cook(piece('sprout', snap));
    const units = new Set<number>();
    for (let i = c.genStart[1]; i < c.nPolys; i++) units.add(c.unit[i]);
    expect(Math.min(...units)).toBe(snap[RESUME.LENGTH + 3]);
  });
});

describe('radial Echo: a hexagonal snowflake with every bump outward', () => {
  it('at light and heavy pressure (light taps used to flip alternate bumps inward)', () => {
    for (const p of [0.05, 0.2, 0.4, 0.57, 0.6, 0.95]) {
      for (const base of [1, 2, 3.5]) {
        const h = new Hand(50, 50, { jitter: 0.05, seed: 9, p });
        h.hold(60); h.moveTo(51, 50.5, 0.05);
        const c = cook(formRecipe(h.rows(), { form: 'echo', base, radial: true }));
        const g1 = c.genStart[1];
        // the dot (gen 0) is the centre; the crystal starts on a hexagon corner (radius R),
        // and the hexagon's inradius is R·cos 30°
        const cx = c.pts[0], cy = c.pts[1], j0 = c.start[g1];
        const R = Math.hypot(c.pts[4 * j0] - cx, c.pts[4 * j0 + 1] - cy);
        let minR = Infinity;
        for (let j = c.start[g1]; j < c.nPts; j++) minR = Math.min(minR, Math.hypot(c.pts[4 * j] - cx, c.pts[4 * j + 1] - cy));
        expect(minR).toBeGreaterThan(R * Math.cos(Math.PI / 6) * 0.98);
      }
    }
  });
});

describe('radial Drift: an emission in every direction', () => {
  it('24 filaments leave the dot outward and cover every heading before the current takes them', () => {
    for (const p of [0.1, 0.6, 0.95]) {
      for (const base of [1, 2.5, 6]) {
        const h = new Hand(50, 50, { jitter: 0.05, seed: 3, p });
        h.hold(60);
        const c = cook(formRecipe(h.rows(), { form: 'drift', base, radial: true, seed: 11 }));
        const g1 = c.genStart[1], cx = c.pts[0], cy = c.pts[1];
        expect((c.nPolys - g1) % 3).toBe(0);
        const sectors = new Set<number>();
        for (let b = 0; b < 24; b++) {
          const i = g1 + 3 * b, st = c.start[i], n = Math.min(c.count[i], 11);
          // the first ~17 sp (10 steps) move steadily away from the centre
          let prev = -1;
          for (let k = 0; k < n; k++) {
            const r = Math.hypot(c.pts[4 * (st + k)] - cx, c.pts[4 * (st + k) + 1] - cy);
            expect(r).toBeGreaterThan(prev);
            prev = r;
          }
          const e = st + n - 1;
          const a = Math.atan2(c.pts[4 * e + 1] - cy, c.pts[4 * e] - cx);
          sectors.add(Math.floor(((a + Math.PI) / (2 * Math.PI)) * 8) % 8);
        }
        expect(sectors.size).toBe(8);
      }
    }
  });
});

describe('Sprout lean reads pen azimuth the short way round', () => {
  it('rows whose azimuth wraps 2π → 0 grow like the same rows unwrapped', () => {
    const h = new Hand(0, 0, { jitter: 0.1, seed: 4, p: 0.6, alt: 0.45, az: 0 });
    h.moveTo(300, 20, 0.6).arc(300, 80, 60, -Math.PI / 2, Math.PI / 2, 0.6);
    const unwrapped = h.rows(), wrapped = unwrapped.slice();
    const n = unwrapped.length / S.STRIDE;
    for (let i = 0; i < n; i++) {
      const a = 6.2 + 0.16 * ((i * 7919) % 13) / 12; // wobbles across 2π
      unwrapped[i * S.STRIDE + S.AZ] = a;
      wrapped[i * S.STRIDE + S.AZ] = a >= 2 * Math.PI ? a - 2 * Math.PI : a;
    }
    const a = cook(formRecipe(unwrapped, { form: 'sprout', base: 2 })), b = cook(formRecipe(wrapped, { form: 'sprout', base: 2 }));
    expect(a.nPolys).toBe(b.nPolys);
    let worst = 0;
    for (let j = 0; j < Math.min(a.nPts, b.nPts); j++) {
      worst = Math.max(worst, Math.abs(a.pts[4 * j] - b.pts[4 * j]), Math.abs(a.pts[4 * j + 1] - b.pts[4 * j + 1]));
    }
    expect(worst).toBeLessThan(1e-3);
  });
});

describe('live state depends only on the current inputs', () => {
  it('after any pool history (rises, Settles, budget spent and freed) the view equals a fresh cook of the final pools', () => {
    for (const form of ['sprout', 'drift'] as FormId[]) {
      for (let trial = 0; trial < 4; trial++) {
        const rand = mulberry32(101 + trial);
        const r = formRecipe(bigStroke().rows(), { form, base: form === 'sprout' ? 2 : 3, size: 30 });
        const a = new Feeder(r), ia = createInkCook(a.d);
        const b = new Feeder(r), ib = createInkCook(b.d);
        const pools: number[] = [];
        while (a.fed < a.total) {
          const k = 1 + Math.floor(rand() * 40);
          const n0 = a.fed; a.feed(k); ia.append(a.fed - n0);
          const m0 = b.fed; b.feed(k); ib.append(b.fed - m0);
          const L = ia.spine().L;
          if (rand() < 0.15 && pools.length < 24) pools.push(Math.floor(rand() * L), 0);
          for (let q = 1; q < pools.length; q += 2) {
            if (rand() < 0.5) continue;
            pools[q] = Math.max(0, Math.min(4, Math.round((pools[q] + (rand() < 0.35 ? -1.5 : 1)) * 16) / 16));
            a.setPools(pools); ia.regrow(pools[q - 1] - 48, pools[q - 1] + 32);
          }
          if (rand() < 0.3) ia.drainSettled(() => {});
        }
        b.setPools(pools); ib.regrow(-1e9, 1e9);
        const va = ia.view() as InkLiveView, vb = ib.view() as InkLiveView;
        const d = cookedDiff(va.geom, vb.geom);
        if (d) throw new Error(`${form} trial ${trial}: ${d}`);
        expect(ia.ceiling(1000)).toBe(ib.ceiling(1000));
      }
    }
  });
});

describe('Echo live ceiling', () => {
  it('is the cap of the crystal the stroke would get if it lifted now, not the 8-vertex ghost’s', () => {
    const h = new Hand(0, 0, { jitter: 0.1, seed: 2, p: 0.6 });
    h.moveTo(120, 80, 0.8).moveTo(240, 0, 0.8);
    const r = formRecipe(h.rows(), { form: 'echo', base: 2 });
    const { ic } = feedAll(r);
    const live = ic.ceiling(ic.spine().L - 5);
    // a V's generator has few segments: depth 5 fits 32k (the ghost's 7 segments would cap it at 4)
    expect(live).toBe(5);
    expect(live).toBe(cook({ ...r, form: { ...r.form, base: 5 } }).ceilingMax);
    // a loop that is closing is capped as a snowflake (three sides)
    const loop = feedAll(formRecipe(loopStroke(70).rows(), { form: 'echo', base: 2 })).ic;
    loop.setClosing(true);
    const lc = loop.ceiling(100);
    expect(lc).toBeLessThanOrEqual(5);
    expect(lc).toBe(cook(formRecipe(loopStroke(70).rows(), { form: 'echo', base: 5, closed: true })).ceilingMax);
  });
});

describe('growth units at depth 0 are not cooked until they rise', () => {
  it('base 0: incremental ≡ full while pools raise and drain units (Sprout, Drift)', () => {
    for (const form of ['sprout', 'drift'] as FormId[]) {
      for (let trial = 0; trial < 4; trial++) {
        const rand = mulberry32(17 + trial);
        const r = formRecipe(longStroke(trial + 2).rows(), { form, base: 0 });
        const fd = new Feeder(r), ic = createInkCook(fd.d);
        const pools: number[] = [];
        while (fd.fed < fd.total) {
          const n0 = fd.fed; fd.feed(1 + Math.floor(rand() * 20)); ic.append(fd.fed - n0);
          if (rand() < 0.1 && pools.length < 16) pools.push(ic.spine().L - rand() * 60, 0);
          for (let q = 1; q < pools.length; q += 2) {
            if (rand() < 0.6) continue;
            pools[q] = Math.max(0, Math.round((pools[q] + (rand() < 0.3 ? -0.75 : 0.5)) * 16) / 16);
            fd.setPools(pools);
            if (rand() < 0.8) ic.regrow(pools[q - 1] - 48, pools[q - 1] + 32);
          }
          if (rand() < 0.3) { const v = ic.view(); expect(cookedProblems(v.geom)).toEqual([]); }
        }
        const fr = fd.freeze(false);
        expect(cookedDiff(ic.finish(fr), cook(fr))).toBeNull();
        expect(cookedProblems(cook(fr))).toEqual([]);
      }
    }
  });

  it('a hold on base-0 growth: the ceiling is the units’ ceiling, not 0', () => {
    for (const form of ['sprout', 'drift'] as FormId[]) {
      const { ic } = feedAll(formRecipe(longStroke(3).rows(), { form, base: 0 }));
      const s = 300;
      expect(ic.ceiling(s)).toBe(FORMS[form].dMax);
    }
  });

  it('a base-0 Drift or Sprout stroke draws only its trunk', () => {
    for (const form of ['sprout', 'drift'] as FormId[]) {
      const c = cook(formRecipe(longStroke(3).rows(), { form, base: 0 }));
      expect(c.genStart.length).toBe(2);
      expect(c.ceilingMax).toBe(0);
    }
  });
});

describe('cookPreview', () => {
  const linear = (r: StrokeRecipe, lim: number): Cooked | null => {
    // the reference: lower by whole levels, one at a time, until it fits
    for (let drop = 0; drop <= 8; drop++) {
      const pools = r.pools.slice();
      for (let o = PL.A; o < pools.length; o += PL.STRIDE) pools[o] = Math.max(0, pools[o] - drop);
      const c = cook({ ...r, form: { ...r.form, base: Math.max(0, r.form.base - drop) }, pools });
      if (c.nPts <= lim) return c;
    }
    return null;
  };

  it('lowers depth to the shallowest level that fits (same as stepping one level at a time)', () => {
    for (const form of ALL) {
      for (const lim of [2500, 6000]) {
        const r = formRecipe(longStroke(3).rows(), { form, base: FORMS[form].dMax, pools: [400, 1] });
        const want = linear(r, lim);
        const got = cookPreview(r, lim);
        expect(got.nPts).toBeLessThanOrEqual(lim);
        if (want) expect(cookedDiff(got, want)).toBeNull();
      }
    }
  });

  it('always fits its budget, even when the trunk alone does not (many chunks, bristles)', () => {
    const dry = new Hand(0, 0, { p: 0.2, seed: 2 });
    for (let k = 0; k < 8; k++) dry.moveTo(400 * (k + 1), k % 2 ? 60 : 0, 2.6);
    const recipes = [
      formRecipe(bigStroke().rows(), { form: 'sprout', base: 4, size: 30 }),
      formRecipe(bigStroke().rows(), { form: 'line', base: 5, nib: 'pen', size: 3 }),
      formRecipe(dry.rows(), { form: 'drift', base: 6, nib: 'brush', size: 14 }),
      formRecipe(loopStroke(70).rows(), { form: 'echo', base: 5, closed: true }),
      formRecipe(tapStroke(800).rows(), { form: 'sprout', base: 3, radial: true }),
    ];
    for (const r of recipes) {
      for (const lim of [2, 3, 10, 60, 200, 900, 2500]) {
        const c = cookPreview(r, lim);
        expect(c.nPts).toBeLessThanOrEqual(lim);
        expect(c.nPolys).toBeGreaterThan(0);
        const p = cookedProblems(c);
        if (p.length) throw new Error(`${r.form.form} lim ${lim}: ${p.join('; ')}`);
        expect(inkBoxContains(c, r.origin)).toBe(true);
      }
    }
  });

  it('a decimated trunk stays one connected chain from start to end', () => {
    const r = formRecipe(bigStroke().rows(), { form: 'drift', base: 2 });
    const full = cook(formRecipe(bigStroke().rows(), { form: 'drift', base: 0 }));
    // the end of the full trunk's core: the last core chunk (bristles would follow; none here)
    const fe = full.nPts - 1;
    for (const lim of [60, 300, 900]) {
      const c = cookPreview(r, lim);
      expect(c.nPts).toBeLessThanOrEqual(lim);
      expect(c.pts[0]).toBe(full.pts[0]);
      // follow polys while each starts on the previous one's end
      let i = 0;
      while (i + 1 < c.nPolys) {
        const e = 4 * (c.start[i] + c.count[i] - 1), f = 4 * c.start[i + 1];
        if (c.pts[e] !== c.pts[f] || c.pts[e + 1] !== c.pts[f + 1]) break;
        i++;
      }
      const e = 4 * (c.start[i] + c.count[i] - 1);
      expect(c.pts[e]).toBe(full.pts[4 * fe]);
      expect(c.pts[e + 1]).toBe(full.pts[4 * fe + 1]);
    }
  });

  it('NaN or infinite budgets mean no limit', () => {
    const r = formRecipe(longStroke(3).rows(), { form: 'drift', base: 4 });
    expect(cookedDiff(cookPreview(r, NaN), cook(r))).toBeNull();
    expect(cookedDiff(cookPreview(r, Infinity), cook(r))).toBeNull();
  });
});

describe('fuzz: incremental ≡ full over random strokes and schedules', () => {
  const DEV: Device[] = ['pen', 'mouse', 'touch'];
  const NIB: NibId[] = ['pen', 'brush', 'chisel'];

  function randomHand(rand: () => number): { h: Hand; closed: boolean } {
    const closed = rand() < 0.2;
    const h = new Hand(rand() * 200, rand() * 200, {
      jitter: rand() * 0.6, seed: Math.floor(rand() * 1e6), hz: [60, 120, 240][Math.floor(rand() * 3)], p: rand(),
      alt: rand() < 0.5 ? Math.PI / 2 : 0.3 + rand(), az: rand() * 6.28,
    });
    if (closed) {
      const R = 20 + rand() * 120;
      h.x = 100 + R; h.y = 100;
      h.arc(100, 100, R, 0, 2 * Math.PI * (0.97 + rand() * 0.06), 0.3 + rand() * 1.5);
      return { h, closed };
    }
    const segs = 3 + Math.floor(rand() * 10);
    for (let k = 0; k < segs; k++) {
      const q = rand();
      if (q < 0.45) h.moveTo(h.x + (rand() - 0.5) * 300, h.y + (rand() - 0.5) * 300, 0.05 + rand() * rand() * 2.5, rand());
      else if (q < 0.75) { const R = 10 + rand() * 100, a0 = rand() * 6.28; h.arc(h.x - R * Math.cos(a0), h.y - R * Math.sin(a0), R, a0, a0 + (rand() - 0.5) * 8, 0.1 + rand() * 1.2); }
      else if (q < 0.9) h.hold(50 + rand() * 700, rand());
      else h.moveTo(h.x + (rand() - 0.5) * 2, h.y + (rand() - 0.5) * 2, 0.02);
    }
    return { h, closed };
  }

  it('120 seeds: every Form, device, nib, zoom 0.25–8, base 0–dMax, holds, Settles, lift guard, closure flicker', () => {
    const fails: string[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const rand = mulberry32(seed * 7717);
      const { h, closed } = randomHand(rand);
      const z = [0.25, 0.5, 1, 1, 2, 4, 8][Math.floor(rand() * 7)];
      const form = ALL[Math.floor(rand() * 4)], device = DEV[Math.floor(rand() * 3)], nib = NIB[Math.floor(rand() * 3)];
      const base = rand() < 0.25 ? 0 : Math.round(rand() * 4 * FORMS[form].dMax) / 4;
      const r0 = formRecipe(h.rows(z, device !== 'pen'), { form, base, device, nib, size: 2 + rand() * 30, z, seed: Math.floor(rand() * 2 ** 31) });
      const fd = new Feeder(r0), ic = createIncrementalCook(fd.d);
      const pools: number[] = [];
      let hold = -1, closing = false;
      while (fd.fed < fd.total) {
        const n0 = fd.fed;
        fd.feed(1 + Math.floor(rand() * (rand() < 0.5 ? 4 : 60)));
        ic.append(fd.fed - n0);
        const L = ic.spine().L;
        if (hold < 0 && rand() < 0.05 && pools.length < 64) { hold = pools.length; pools.push(rand() < 0.1 ? 0 : L, 0); }
        if (hold >= 0) {
          pools[hold + 1] = Math.max(0, Math.round((pools[hold + 1] + (rand() < 0.2 ? -0.3 : 0.5)) * 16) / 16);
          fd.setPools(pools);
          const s = pools[hold], w = rand();
          if (w < 0.6) ic.regrow(s - 48, s + 32); else if (w < 0.8) ic.regrow(s, s);
          if (rand() < 0.2) hold = -1;
        }
        if (rand() < 0.04) { closing = !closing; ic.setClosing(closing); }
        if (rand() < 0.3) { const p = cookedProblems(ic.view().geom); if (p.length) fails.push(`${seed} live: ${p[0]}`); }
        if (rand() < 0.3) ic.drainSettled(() => {});
        if (rand() < 0.1) ic.ceiling(L);
      }
      if (pools.length && rand() < 0.5) { pools[1] = Math.max(0, pools[1] - 0.25); fd.setPools(pools); }
      const sp = ic.spine();
      const r: StrokeRecipe = { ...fd.freeze(closed), radial: sp.n > 0 && sp.L - sp.s[0] < 6 };
      const a = ic.finish(r), b = cook(r);
      const d = cookedDiff(a, b);
      if (d) fails.push(`${seed} ${form} ${device} ${nib} z${z} closed=${closed} base=${base}: ${d}`);
      const p = cookedProblems(b);
      if (p.length) fails.push(`${seed}: ${p.join('; ')}`);
      if (!inkBoxContains(b, r.origin)) fails.push(`${seed}: inkBox`);
    }
    if (fails.length) throw new Error(fails.join('\n'));
  }, 120000);

  it('draftOf keeps every field cook() reads', () => {
    const r = formRecipe(longStroke(2).rows(), { form: 'drift', pools: [100, 1], closed: false });
    const d = draftOf(r);
    expect(d.samples.data).toBe(r.samples);
    expect(d.pools.data).toBe(r.pools);
    expect(d.closing).toBe(r.closed);
  });
});
