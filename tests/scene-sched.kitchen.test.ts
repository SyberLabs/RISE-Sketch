import { describe, it, expect } from 'vitest';
import { createKitchen, CookCancelled, jobPrio } from '../src/scene/kitchen';
import { createJobs, JobPrio } from '../src/sched/jobs';
import type { Cooked, StrokeRecipe } from '../src/core/types';
import { fakeClock, linePts, makeRecipe, trunkCooked } from './scene-sched.helpers';

function setup(cost = 0) {
  const clock = fakeClock();
  const jobs = createJobs(clock.now);
  const cooked: string[] = [];
  const landed: string[] = [];
  let frames = 0;
  const kitchen = createKitchen({
    cook: (r: StrokeRecipe): Cooked => {
      cooked.push(r.id + '@' + r.geomRev + (r.form.form === 'sprout' ? 's' : ''));
      clock.advance(cost);
      if (r.form.form === 'ripple') throw new Error('bad recipe');
      return trunkCooked(r);
    },
    jobs,
    requestFrame: () => { frames++; },
    onCooked: r => landed.push(r.id),
  });
  return { clock, jobs, kitchen, cooked, landed, frames: () => frames };
}

const rec = (n: number, extra: Partial<Parameters<typeof makeRecipe>[0]> = {}) =>
  makeRecipe({ n, pts: linePts(0, 0, 50, 0, 5), ...extra });

describe('kitchen', () => {
  it('maps scene priorities onto job priorities', () => {
    expect(jobPrio('handoff')).toBe(JobPrio.Handoff);
    expect(jobPrio('visible')).toBe(JobPrio.Visible);
    expect(jobPrio('prefetch')).toBe(JobPrio.Prefetch);
    expect(jobPrio('background')).toBe(JobPrio.Cook);
  });

  it('cooks in priority order, FIFO within a priority, and asks for frames', async () => {
    const k = setup();
    const a = rec(1), b = rec(2), c = rec(3), d = rec(4), e = rec(5);
    const ps = [
      k.kitchen.cook(a, 'background'), k.kitchen.cook(b, 'visible'), k.kitchen.cook(c, 'handoff'),
      k.kitchen.cook(d, 'prefetch'), k.kitchen.cook(e, 'visible'),
    ];
    expect(k.frames()).toBe(5);
    expect(k.kitchen.pending).toBe(5);
    expect(k.kitchen.has(a.id)).toBe(true);
    k.jobs.run(1000);
    expect(k.cooked).toEqual([c, b, e, d, a].map(r => r.id + '@0'));
    expect(k.landed).toEqual([c, b, e, d, a].map(r => r.id));
    const results = await Promise.all(ps);
    expect(results[0].nPolys).toBe(1);
    expect(k.kitchen.pending).toBe(0);
  });

  it('a repeated request shares the promise and can only raise the priority', async () => {
    const k = setup();
    const a = rec(1), b = rec(2);
    const p1 = k.kitchen.cook(a, 'background');
    k.kitchen.cook(b, 'visible');
    const p2 = k.kitchen.cook(a, 'handoff');
    expect(p2).toBe(p1);
    expect(k.kitchen.cook({ ...a, colorRev: 3 }, 'background')).toBe(p1); // colour-only twin: same geometry rev
    k.jobs.run(1000);
    expect(k.cooked).toEqual([a.id + '@0', b.id + '@0']);
    await p1;
  });

  it('a new revision supersedes the queued one; cancel rejects with CookCancelled', async () => {
    const k = setup();
    const a0 = rec(1), a1 = { ...a0, geomRev: 1 };
    const p0 = k.kitchen.cook(a0, 'visible');
    const p1 = k.kitchen.cook(a1, 'visible');
    await expect(p0).rejects.toBeInstanceOf(CookCancelled);
    expect(k.kitchen.queued(a0.id)).toBe(a1);
    const b = rec(2);
    const pb = k.kitchen.cook(b, 'visible');
    k.kitchen.cancel(b.id);
    k.kitchen.cancel('nope');
    await expect(pb).rejects.toMatchObject({ name: 'CookCancelled', id: b.id });
    expect(k.jobs.pending).toBe(1);
    k.jobs.run(1000);
    expect(k.cooked).toEqual([a0.id + '@1']);
    await expect(p1).resolves.toBeTruthy();
  });

  it('different geometry at the same geomRev (A→B, undo, A→C) never shares B\'s cook', async () => {
    const k = setup();
    const A = rec(1);
    const B = { ...A, stroke: { ...A.stroke, size: 30 }, geomRev: 1 };
    const C = { ...A, form: { ...A.form, form: 'sprout' as const }, geomRev: 1 };
    const pB = k.kitchen.cook(B, 'visible');
    const pC = k.kitchen.cook(C, 'visible');
    expect(pC).not.toBe(pB);                       // used to return B's promise (and B's geometry)
    await expect(pB).rejects.toBeInstanceOf(CookCancelled);
    expect(k.kitchen.queued(A.id)).toBe(C);
    // a colour-only twin of C (shared arrays, same geometry) still shares C's cook
    expect(k.kitchen.cook({ ...C, colorRev: 5 }, 'background')).toBe(pC);
    k.jobs.run(1000);
    expect(k.cooked).toEqual([A.id + '@1s']);      // C was cooked, B never was
    await expect(pC).resolves.toBeTruthy();
  });

  it('a throwing cook rejects its promise and the queue continues', async () => {
    const k = setup();
    const bad = rec(1, { form: 'ripple' }), good = rec(2);
    const pBad = k.kitchen.cook(bad, 'visible');
    const pGood = k.kitchen.cook(good, 'visible');
    k.jobs.run(1000);
    await expect(pBad).rejects.toThrow('bad recipe');
    await expect(pGood).resolves.toBeTruthy();
    expect(k.landed).toEqual([good.id]);
  });

  it('time-slices between cooks: a 6 ms budget fits two 4 ms cooks', () => {
    const k = setup(4);
    for (let i = 1; i <= 7; i++) k.kitchen.cook(rec(i), 'background');
    expect(k.jobs.run(6)).toBe(true);
    expect(k.cooked.length).toBe(2);
    expect(k.jobs.run(6)).toBe(true);
    expect(k.cooked.length).toBe(4);
    while (k.jobs.run(6));
    expect(k.cooked.length).toBe(7);
  });

  it('cancelAll rejects everything pending', async () => {
    const k = setup();
    const ps = [1, 2, 3].map(i => k.kitchen.cook(rec(i), 'prefetch'));
    k.kitchen.cancelAll();
    for (const p of ps) await expect(p).rejects.toBeInstanceOf(CookCancelled);
    expect(k.jobs.pending).toBe(0);
    expect(k.jobs.run(100)).toBe(false);
  });
});
