import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import * as plume from './plume.form';
import { labCook, labRecipe, Hand } from './harness';
import { cook } from '../../src/ink/cook';
import { PolyBuf, UnitGeom } from '../../src/ink/operators/types';
import type { FormCx, ChainRecord } from '../../src/ink/operators/types';

const sig = (seed = 3) => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9).moveTo(150, 110, 1.3, 0.55).moveTo(300, 40, 2.3, 0.25);
  return h;
};
it('profile', () => {
  const r = labRecipe(plume, sig());
  for (let i = 0; i < 3; i++) cook(r);
  let t0 = performance.now();
  for (let i = 0; i < 10; i++) cook(r);
  const full = (performance.now() - t0) / 10;
  const { c } = labCook(plume, sig());
  // isolate operator cost: fake a cx by cooking once and grabbing via a spy
  const ch = plume.ops.chain!;
  let cxRef: FormCx | null = null;
  const orig = ch.cook;
  (ch as { cook: typeof orig }).cook = (cx, rec, g) => { cxRef = cx; orig(cx, rec, g); };
  cook(r);
  (ch as { cook: typeof orig }).cook = orig;
  const cx = cxRef!;
  const g = new UnitGeom(), buf = new PolyBuf(64, 8); buf.zs = cx.z;
  const rec: ChainRecord = { s: cx.s0 + 100, j: 30, side: 0, tmpl: 0 };
  t0 = performance.now();
  for (let i = 0; i < 2000; i++) { rec.s = cx.s0 + 20 + (i % 200); rec.j = i; ch.cook(cx, rec, g); }
  const ck = (performance.now() - t0) / 2000;
  t0 = performance.now();
  for (let i = 0; i < 2000; i++) { buf.clear(); ch.emit(cx, rec, g, 2, 1, buf); }
  const em = (performance.now() - t0) / 2000;
  let units = 0; for (let i = 0; i < c.nPolys; i++) if (c.unit[i] + 1 > units) units = c.unit[i] + 1;
  writeFileSync('C:/Users/MATEO/AppData/Local/Temp/claude/c--Users-MATEO-SYBERLABS-rise-sketch/59b0af8f-a464-4935-882d-79d91c945937/scratchpad/plume-prof.txt', `full cook ${full.toFixed(2)} ms, ${c.nPts} pts, ~${units} units; op cook ${(ck * 1000).toFixed(1)} us/unit, emit ${(em * 1000).toFixed(1)} us/unit -> op total ${(units * (ck + em)).toFixed(2)} ms`);
});
