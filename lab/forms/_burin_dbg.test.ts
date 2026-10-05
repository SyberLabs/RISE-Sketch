import { it } from 'vitest';
import * as burin from './burin.form';
import * as smoke from './_smoke.form';
import { labCook, Hand } from './harness';

it('burin perf', () => {
  const sig = (seed: number) => {
    const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
    h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9);
    h.moveTo(150, 110, 1.3, 0.55).arc(200, 110, 50, Math.PI, 1.9 * Math.PI, 1.6);
    h.moveTo(300, 40, 2.3, 0.25);
    return h;
  };
  const hs = Array.from({ length: 10 }, (_, i) => sig(3 + i));
  for (let round = 0; round < 4; round++) {
    const t0 = performance.now();
    let pts = 0;
    for (const h of hs) pts += labCook(burin, h, {}).c.nPts;
    console.log(`round ${round}: 10 strokes ${pts} pts ${(performance.now() - t0).toFixed(1)} ms`);
  }
  for (let round = 0; round < 3; round++) {
    const t1 = performance.now();
    let pts = 0;
    for (const h of hs) pts += labCook(smoke, h, {}).c.nPts;
    console.log(`smoke(drift) round ${round}: ${pts} pts ${(performance.now() - t1).toFixed(1)} ms`);
  }
  const t0 = performance.now();
  for (const h of hs) labCook(burin, h, { base: 4 });
  console.log(`base 4: ${(performance.now() - t0).toFixed(1)} ms`);
});
