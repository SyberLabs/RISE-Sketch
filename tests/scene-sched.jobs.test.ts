import { describe, it, expect } from 'vitest';
import { createJobs, JobPrio } from '../src/sched/jobs';
import { fakeClock } from './scene-sched.helpers';

/** A function job that takes `steps` steps, advancing the clock by `cost` ms each. */
function stepper(log: string[], name: string, steps: number, clock?: { advance(ms: number): void }, cost = 0) {
  let left = steps;
  return () => {
    log.push(name);
    clock?.advance(cost);
    return --left > 0;
  };
}

describe('jobs: budget', () => {
  it('stops once the budget is spent (fake clock)', () => {
    const clock = fakeClock();
    const jobs = createJobs(clock.now);
    const log: string[] = [];
    jobs.add(JobPrio.Cook, stepper(log, 'a', 100, clock, 1));
    expect(jobs.run(5)).toBe(true);
    expect(log.length).toBe(5);
    expect(clock.t).toBe(5);
    expect(jobs.run(2.5)).toBe(true);
    expect(log.length).toBe(8);
  });

  it('runs at least one step for a positive budget, none for zero', () => {
    const clock = fakeClock();
    const jobs = createJobs(clock.now);
    const log: string[] = [];
    jobs.add(JobPrio.Cook, stepper(log, 'slow', 3, clock, 50));
    expect(jobs.run(0)).toBe(true);
    expect(log).toEqual([]);
    jobs.run(1);
    expect(log).toEqual(['slow']); // one 50 ms step overruns, then it stops
    jobs.run(1000);
    expect(log.length).toBe(3);
    expect(jobs.pending).toBe(0);
    expect(jobs.run(10)).toBe(false);
  });

  it('a budget spread over frames finishes everything eventually', () => {
    const clock = fakeClock();
    const jobs = createJobs(clock.now);
    const log: string[] = [];
    for (let i = 0; i < 10; i++) jobs.add(JobPrio.Prefetch, stepper(log, 'j' + i, 7, clock, 0.75));
    let frames = 0;
    while (jobs.run(4)) frames++;
    expect(log.length).toBe(70);
    expect(frames).toBeGreaterThan(10);
  });
});

describe('jobs: ordering', () => {
  it('strict priority, FIFO within a priority', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    jobs.add(JobPrio.Cook, stepper(log, 'cook1', 2));
    jobs.add(JobPrio.Save, stepper(log, 'save', 1));
    jobs.add(JobPrio.Handoff, stepper(log, 'handoff', 2));
    jobs.add(JobPrio.Cook, stepper(log, 'cook2', 1));
    jobs.add(JobPrio.Visible, stepper(log, 'visible', 1));
    while (jobs.run(1000));
    expect(log).toEqual(['handoff', 'handoff', 'visible', 'save', 'cook1', 'cook1', 'cook2']);
  });

  it('a higher-priority job added mid-run goes next', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    let spawned = false;
    jobs.add(JobPrio.Cook, () => {
      log.push('bg');
      if (!spawned) { spawned = true; jobs.add(JobPrio.Handoff, stepper(log, 'urgent', 1)); }
      return log.filter(x => x === 'bg').length < 3;
    });
    while (jobs.run(1000));
    expect(log).toEqual(['bg', 'urgent', 'bg', 'bg']);
  });

  it('out-of-range priorities are clamped', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    jobs.add(99 as JobPrio, stepper(log, 'low', 1));
    jobs.add(-5 as JobPrio, stepper(log, 'high', 1));
    while (jobs.run(1000));
    expect(log).toEqual(['high', 'low']);
  });
});

describe('jobs: iterators, keys and cancellation', () => {
  it('iterator jobs advance one step per next() and close on cancel', () => {
    const log: string[] = [];
    function* gen(name: string) {
      try {
        for (let i = 0; i < 5; i++) { log.push(name + i); yield; }
      } finally { log.push(name + ':closed'); }
    }
    const jobs = createJobs(fakeClock().now);
    jobs.add(JobPrio.Bloom, gen('g'), 'g');
    jobs.add(JobPrio.Bloom, gen('h'), 'h');
    expect(jobs.run(1000)).toBe(false);
    expect(log).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', 'g:closed', 'h0', 'h1', 'h2', 'h3', 'h4', 'h:closed']);
    expect(jobs.pending).toBe(0);

    // a clock that jumps past the budget after every reading: exactly one step per run
    log.length = 0;
    let t = 0;
    const one = createJobs(() => (t += 10));
    one.add(JobPrio.Bloom, gen('y'), 'y');
    one.add(JobPrio.Bloom, gen('x'), 'x');
    one.run(5);
    expect(log).toEqual(['y0']);
    expect(one.has('y')).toBe(true);
    one.cancel('y');
    expect(log).toEqual(['y0', 'y:closed']);
    expect(one.has('y')).toBe(false);
    one.cancel('x'); // never started: closing it runs no body and no finally
    expect(log).toEqual(['y0', 'y:closed']);
    expect(one.pending).toBe(0);
    expect(one.run(100)).toBe(false);
  });

  it('adding with an existing key replaces the earlier job', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    jobs.add(JobPrio.Cook, stepper(log, 'old', 3), 'k');
    jobs.add(JobPrio.Cook, stepper(log, 'other', 1));
    jobs.add(JobPrio.Visible, stepper(log, 'new', 1), 'k');
    expect(jobs.pending).toBe(2);
    while (jobs.run(1000));
    expect(log).toEqual(['new', 'other']);
    expect(jobs.has('k')).toBe(false);
  });

  it('a job may cancel itself mid-step, and re-add under its key', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    function* selfish() {
      log.push('a');
      jobs.cancel('s');
      yield;
      log.push('never');
    }
    jobs.add(JobPrio.Cook, selfish(), 's');
    jobs.run(1000);
    expect(log).toEqual(['a']);
    expect(jobs.pending).toBe(0);

    log.length = 0;
    jobs.add(JobPrio.Cook, () => {
      log.push('first');
      jobs.add(JobPrio.Cook, () => { log.push('second'); return false; }, 'r');
      return true; // would continue, but it was replaced
    }, 'r');
    while (jobs.run(1000));
    expect(log).toEqual(['first', 'second']);
    expect(jobs.has('r')).toBe(false);
  });

  it('cancelling many queued jobs keeps the queue consistent', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    for (let i = 0; i < 200; i++) jobs.add(JobPrio.Cook, stepper(log, 'j' + i, 1), 'k' + i);
    for (let i = 0; i < 200; i += 2) jobs.cancel('k' + i);
    expect(jobs.pending).toBe(100);
    while (jobs.run(1000));
    expect(log.length).toBe(100);
    expect(log.every(n => Number(n.slice(1)) % 2 === 1)).toBe(true);
    expect(log[0]).toBe('j1');
    expect(log[99]).toBe('j199');
  });
});

describe('jobs: errors and re-entrancy', () => {
  it('a throwing job is removed and the error rethrown; the queue stays usable', () => {
    const jobs = createJobs(fakeClock().now);
    const log: string[] = [];
    jobs.add(JobPrio.Visible, () => { throw new Error('boom'); }, 'bad');
    jobs.add(JobPrio.Cook, stepper(log, 'ok', 1));
    expect(() => jobs.run(1000)).toThrow('boom');
    expect(jobs.has('bad')).toBe(false);
    expect(jobs.pending).toBe(1);
    jobs.run(1000);
    expect(log).toEqual(['ok']);
  });

  it('with onError the run continues past a failing job', () => {
    const seen: unknown[] = [];
    const jobs = createJobs(fakeClock().now, (e, key) => seen.push([String(e), key]));
    const log: string[] = [];
    jobs.add(JobPrio.Visible, () => { throw new Error('x'); }, 'bad');
    jobs.add(JobPrio.Cook, stepper(log, 'ok', 1));
    expect(jobs.run(1000)).toBe(false);
    expect(log).toEqual(['ok']);
    expect(seen).toEqual([['Error: x', 'bad']]);
  });

  it('run() from inside a job is a no-op', () => {
    const jobs = createJobs(fakeClock().now);
    let inner: boolean | null = null;
    jobs.add(JobPrio.Cook, () => { inner = jobs.run(100); return false; });
    jobs.add(JobPrio.Cook, () => false);
    jobs.run(1000);
    expect(inner).toBe(true); // work remained (the second job), but nothing ran re-entrantly
    expect(jobs.pending).toBe(0);
  });

  it('defaults to a real clock when none is injected', () => {
    const jobs = createJobs();
    let n = 0;
    jobs.add(JobPrio.Cook, () => ++n < 1e9);
    const t0 = performance.now();
    jobs.run(3);
    const dt = performance.now() - t0;
    expect(n).toBeGreaterThan(1);
    expect(dt).toBeLessThan(50);
  });
});

describe('jobs: model check', () => {
  /** Reference: a flat list scanned for the smallest (prio, seq) on every step. */
  interface RefJob { name: string; prio: number; seq: number; key: string | null; left: number }

  it('matches a trivial reference queue over random adds, keyed replaces, cancels and runs', () => {
    let s = 7;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let trial = 0; trial < 20; trial++) {
      const clock = fakeClock();
      const jobs = createJobs(clock.now);
      const log: string[] = [];
      const ref: RefJob[] = [];
      const refLog: string[] = [];
      let seq = 0;
      const refRun = (budget: number) => {
        if (!(budget > 0)) return;
        let spent = 0, steps = 0;
        while (ref.length) {
          if (steps > 0 && spent >= budget) break;
          let best = 0;
          for (let i = 1; i < ref.length; i++) {
            if (ref[i].prio < ref[best].prio || (ref[i].prio === ref[best].prio && ref[i].seq < ref[best].seq)) best = i;
          }
          const j = ref[best];
          refLog.push(j.name);
          spent += 1; steps++;
          if (--j.left === 0) ref.splice(best, 1);
        }
      };
      for (let op = 0; op < 600; op++) {
        const k = rnd();
        if (k < 0.5) {
          const prio = Math.floor(rnd() * 8) as JobPrio;
          const key = rnd() < 0.5 ? 'k' + Math.floor(rnd() * 12) : undefined;
          const steps = 1 + Math.floor(rnd() * 4);
          const name = 'j' + op;
          if (key !== undefined) {
            const i = ref.findIndex(j => j.key === key);
            if (i >= 0) ref.splice(i, 1);
          }
          ref.push({ name, prio, seq: seq++, key: key ?? null, left: steps });
          // half the jobs are iterators, half step functions
          if (rnd() < 0.5) {
            jobs.add(prio, stepper(log, name, steps, clock, 1), key);
          } else {
            jobs.add(prio, (function* () { for (let i = 0; i < steps; i++) { log.push(name); clock.advance(1); if (i < steps - 1) yield; } })(), key);
          }
        } else if (k < 0.65) {
          const key = 'k' + Math.floor(rnd() * 12);
          const i = ref.findIndex(j => j.key === key);
          if (i >= 0) ref.splice(i, 1);
          jobs.cancel(key);
        } else {
          const budget = Math.floor(rnd() * 6);
          refRun(budget);
          jobs.run(budget);
        }
        expect(jobs.pending).toBe(ref.length);
        for (let i = 0; i < 12; i++) expect(jobs.has('k' + i)).toBe(ref.some(j => j.key === 'k' + i));
      }
      refRun(1e9);
      while (jobs.run(1e9));
      expect(log).toEqual(refLog);
      expect(jobs.pending).toBe(0);
    }
  });
});
