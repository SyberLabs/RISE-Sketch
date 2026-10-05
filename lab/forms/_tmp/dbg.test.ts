import { it } from 'vitest';
import * as orbit from '../orbit.form';
import { labCook, Hand } from '../harness';
import { spineOf } from '../../../src/ink/cook';
const straight = (speed: number, o: any = {}) => { const h = new Hand(0, 100, { jitter: 0, seed: 1, p: o.p ?? 0.5, c: o.c }); h.moveTo(400, 100, speed); return h; };
it('dbg', () => {
  for (const v of [0.25, 0.8, 2.4, 4]) {
    const { r, c } = labCook(orbit, straight(v));
    const sp = spineOf(r);
    let maxOff = 0, lastX = 0, lastW = 0;
    const us = new Map<number, [number, number, number]>();
    for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) { const j = c.start[i] + k; maxOff = Math.max(maxOff, Math.abs(c.pts[4*j+1]-100)); lastX = c.pts[4*j]; lastW = c.pts[4*j+2]; }
    for (let i = c.genStart[1]; i < c.nPolys; i++) { const u = c.unit[i]; const e = us.get(u) ?? [c.born[i], 0, 0]; e[1] += c.count[i]; e[2] = c.pts[4*(c.start[i]+c.count[i]-1)]; us.set(u, e); }
    console.log(`v ${v} L ${sp.L.toFixed(1)} vn[mid] ${sp.vn[sp.n>>1].toFixed(2)} p ${sp.p[sp.n>>1].toFixed(2)} w ${sp.w[sp.n>>1].toFixed(2)} units ${us.size} maxOff ${maxOff.toFixed(2)} lastX ${lastX.toFixed(1)} lastW ${lastW.toFixed(2)} nPts ${c.nPts}`);
    console.log('  units:', [...us.values()].slice(-4).map(e => `s${e[0].toFixed(1)} n${e[1]} endX${e[2].toFixed(1)}`).join(' | '));
  }
});
