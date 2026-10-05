/**
 * render-live against the real ink/cook.ts: the mirror follows the gen-sorted live view exactly
 * (slot ids), settled ink reaches #dry, Echo's fold-out MorphSet is picked up at lift, and every
 * stroke bakes exactly once.
 */
import { describe, it, expect } from 'vitest';
import type { DraftStroke, FormId, StrokeRecipe } from '../src/core/types';
import { S, PL } from '../src/core/types';
import { createIncrementalCook } from '../src/ink/cook';
import { setup, tick, settle, PATH } from './render-live.drive';

function draft(form: FormId): DraftStroke {
  return {
    origin: [0, 0], z: 1, rot: 0, seed: 99, device: 'pen',
    calib: { lo: 0.04, hi: 0.8, gamma: 1, flat: 1, vMed: 0.9, jitter: 0.3, fcMin: 2 },
    stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null },
    form: { form, v: 1, base: 2 }, s0: 0, cut: 0, resume: null,
    samples: { data: new Float32Array(PATH.length * S.STRIDE), n: 0 },
    pools: { data: new Float32Array(8 * PL.STRIDE), n: 0 }, closing: false,
  };
}

describe('live layer × real IncrementalCook', () => {
  for (const form of ['sprout', 'drift', 'line', 'echo'] as const) {
    it(`${form}: mirrors the live view, cools into #dry, folds out / finishes, bakes once`, () => {
      const e = setup();
      const d = draft(form);
      const cook = createIncrementalCook(d);
      e.live.begin(d, cook);
      const t0 = e.host.t;
      let k = 0;
      while (k < PATH.length) {
        for (let q = 0; q < 2 && k < PATH.length; q++, k++) {
          const o = d.samples.n * S.STRIDE, D = d.samples.data;
          D[o + S.X] = PATH[k][0]; D[o + S.Y] = PATH[k][1]; D[o + S.T] = e.host.t - t0 + q * 8; D[o + S.P] = 0.6;
          D[o + S.ALT] = Math.PI / 2; D[o + S.AZ] = 0; D[o + S.R] = NaN; D[o + S.C] = 0; D[o + S.CS] = 0;
          d.samples.n++;
        }
        cook.append(2); e.live.update(); tick(e);
      }
      settle(e);
      const v = cook.view();
      const info = e.live.inspect().find(i => i.kind === 'live')!;
      expect(info.polys).toBe(v.geom.nPolys);
      expect(Array.from(info.cooked.pts.subarray(0, 4 * v.geom.nPts))).toEqual(Array.from(v.geom.pts));
      expect(info.dry).toBeGreaterThan(0);
      const slot = (v as { slot?: Int32Array }).slot;
      if (slot) for (let i = 0; i < info.polys; i++) if (info.st![i] !== 2) expect(slot[i]).toBe(-1);
      const r: StrokeRecipe = {
        ...d, id: 'r-' + form, created: 0, samples: d.samples.data.slice(0, d.samples.n * S.STRIDE),
        pools: new Float32Array(0), closed: false, radial: false, sym: null, xf: null, geomRev: 0, colorRev: 0,
      };
      const c = cook.finish(r);
      e.live.commit(r, c);
      tick(e);
      if (form === 'echo') {
        const mo = cook.view().morph;
        expect(mo).not.toBeNull();
        const fin = e.live.inspect()[0];
        const g1 = mo!.polyFirst[0];
        let folding = 0;
        for (let i = g1; i < c.nPolys; i++) if (fin.mv![i] > 0 && fin.mv![i] < 1) folding++;
        expect(folding).toBe(c.nPolys - g1);
      }
      settle(e);
      expect(e.host.bakes.length).toBe(1);
      expect(e.host.bakes[0].c).toBe(c);
      e.host.bakes[0].done();
      expect(e.live.inspect().length).toBe(0);
    }, 30_000);   // real cooks are cheap, but other suites may share the machine
  }
});
