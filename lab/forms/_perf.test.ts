import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as caustic from './caustic.form';
import { labCook, Hand } from './harness';
import { performance } from 'node:perf_hooks';
const OUT = 'C:/Users/MATEO/AppData/Local/Temp/claude/c--Users-MATEO-SYBERLABS-rise-sketch/59b0af8f-a464-4935-882d-79d91c945937/scratchpad/perf.txt';
it('perf', () => {
  const mk = () => { const h = new Hand(20, 40, { jitter: 0.2, seed: 31, p: 0.35 }); h.moveTo(120, 60, 0.6, 0.8).moveTo(220, 30, 1.4, 0.6).arc(260, 90, 60, -Math.PI / 2, Math.PI / 2, 0.9).moveTo(150, 160, 0.25, 0.9).hold(80).moveTo(150, 260, 0.2, 0.5).arc(220, 260, 70, Math.PI, 2.2 * Math.PI, 1.2).moveTo(420, 300, 2.2, 0.2); return h; };
  for (let i = 0; i < 5; i++) labCook(caustic, mk());
  let t = performance.now(); for (let i = 0; i < 20; i++) labCook(caustic, mk()); const a = (performance.now() - t) / 20;
  t = performance.now(); for (let i = 0; i < 20; i++) labCook(caustic, mk(), { base: 0 }); const b = (performance.now() - t) / 20;
  const c = labCook(caustic, mk()).c;
  writeFileSync(OUT, `long stroke: base2 ${a.toFixed(2)} ms, base0 ${b.toFixed(2)} ms, pts ${c.nPts}
`);
});
