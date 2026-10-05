import { describe, it, expect } from 'vitest';
import { attachJobs, createFrameLoop } from '../src/sched/frame';
import { createJobs, JobPrio } from '../src/sched/jobs';
import type { FrameEnv } from '../src/sched/frame';

/** A fake display: rAF callbacks queue up and fire on `frame(ts)`. */
function fakeEnv() {
  const queue: ((t: number) => void)[] = [];
  const errors: unknown[] = [];
  const env: FrameEnv & { t: number; rafCalls: number } = {
    t: 0,
    rafCalls: 0,
    raf(cb) { env.rafCalls++; queue.push(cb); return queue.length; },
    now: () => env.t,
    report: e => errors.push(e),
  };
  /** Fire the pending callbacks at timestamp ts (like one vsync). */
  const frame = (ts: number) => {
    env.t = ts;
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(ts);
    return cbs.length;
  };
  return { env, frame, queue, errors };
}

describe('frame loop: on demand', () => {
  it('is idle until requested; request is idempotent', () => {
    const { env, frame, queue } = fakeEnv();
    const loop = createFrameLoop(env);
    let runs = 0;
    loop.add(() => { runs++; return false; });
    expect(env.rafCalls).toBe(0);
    expect(loop.running).toBe(false);
    loop.request(); loop.request(); loop.request();
    expect(env.rafCalls).toBe(1);
    expect(loop.running).toBe(true);
    expect(frame(16)).toBe(1);
    expect(runs).toBe(1);
    expect(queue.length).toBe(0);
    expect(loop.running).toBe(false);
    frame(32);
    expect(runs).toBe(1); // nothing pending: no frame
  });

  it('keeps running while a participant returns true, then stops', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    let left = 3;
    loop.add(() => --left > 0);
    loop.request();
    let frames = 0, ts = 0;
    while (frame((ts += 16.7))) frames++;
    expect(frames).toBe(3);
    expect(loop.running).toBe(false);
  });

  it('request() from inside a frame schedules exactly one more', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    let n = 0;
    loop.add(() => { n++; if (n === 1) { loop.request(); loop.request(); } return false; });
    loop.request();
    frame(10);
    expect(env.rafCalls).toBe(2);
    frame(20);
    expect(n).toBe(2);
    expect(frame(30)).toBe(0);
  });
});

describe('frame loop: participants', () => {
  it('run in ascending order, ties in insertion order', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    const log: string[] = [];
    loop.add(() => { log.push('jobs'); return false; }, 100);
    loop.add(() => { log.push('live'); return false; }, 0);
    loop.add(() => { log.push('anim'); return false; }, 10);
    loop.add(() => { log.push('live2'); return false; }, 0);
    loop.request();
    frame(16);
    expect(log).toEqual(['live', 'live2', 'anim', 'jobs']);
  });

  it('removal (also during a frame) and additions during a frame', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    const log: string[] = [];
    let offB: () => void = () => {};
    loop.add(() => {
      log.push('a');
      offB();                                        // remove b mid-frame: it must not run
      loop.add(() => { log.push('c'); return false; }, 5); // added mid-frame: runs next frame
      return false;
    }, 0);
    offB = loop.add(() => { log.push('b'); return false; }, 1);
    loop.request();
    frame(16);
    expect(log).toEqual(['a']);
    loop.request();
    frame(32);
    expect(log).toEqual(['a', 'a', 'c']);
    const offAll = loop.add(() => { log.push('d'); return false; }, 9);
    offAll(); offAll();
    log.length = 0;
    loop.request();
    frame(48);
    expect(log).toEqual(['a', 'c', 'c']);
  });

  it('hands each participant the rAF timestamp and the §9 budget', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    const seen: [number, number][] = [];
    loop.add((now, b) => { seen.push([now, b]); env.t += 5; return false; }, 0);   // live work: 5 ms
    loop.add((now, b) => { seen.push([now, b]); return false; }, 1);               // jobs
    loop.request();
    frame(1000);
    // default interval 16.67: first gets clamp(7.5, 1, 6) = 6; second gets 7.5 − 5 = 2.5
    expect(seen[0]).toEqual([1000, 6]);
    expect(seen[1][0]).toBe(1000);
    expect(seen[1][1]).toBeCloseTo(0.45 * (1000 / 60) - 5, 10);
  });

  it('the budget never drops below 1 ms', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    let got = -1;
    loop.add(() => { env.t += 50; return false; }, 0);
    loop.add((_, b) => { got = b; return false; }, 1);
    loop.request();
    frame(10);
    expect(got).toBe(1);
  });

  it('a throwing participant is reported and does not stop the others', () => {
    const { env, frame, errors } = fakeEnv();
    const loop = createFrameLoop(env);
    let ok = 0;
    loop.add(() => { throw new Error('bad'); }, 0);
    loop.add(() => { ok++; return false; }, 1);
    loop.request();
    let ts = 0, frames = 0;
    while (frame((ts += 16)) && frames < 50) frames++;
    expect(errors.length).toBe(3);       // kept alive for up to 3 consecutive throws, then dropped
    expect(ok).toBe(3);
    expect(loop.running).toBe(false);
  });
});

describe('frame loop: self-removal', () => {
  it('a participant that removes itself mid-frame is never called again and the loop idles', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    let calls = 0, other = 0;
    const off = loop.add(() => { calls++; off(); return true; }, 0);
    loop.add(() => { other++; return other < 2; }, 1);
    loop.request();
    let ts = 0, frames = 0;
    while (frame((ts += 16.7))) frames++;
    expect(calls).toBe(1);
    expect(other).toBe(2);
    expect(frames).toBe(2);
    expect(loop.running).toBe(false);
    off();                               // removing twice is harmless
    expect(env.rafCalls).toBe(2);
  });
});

describe('frame loop + jobs', () => {
  it('attachJobs runs the queue last with the leftover budget until it drains', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    const jobs = createJobs(env.now);
    const log: string[] = [];
    loop.add(() => { log.push('live'); env.t += 3; return false; }, 0);
    const off = attachJobs(loop, jobs);
    let steps = 0;
    jobs.add(JobPrio.Cook, () => { log.push('job'); env.t += 1; return ++steps < 10; });
    loop.request();
    let ts = 0, frames = 0;
    while (frame((ts += 16.7))) frames++;
    // 7.5 − 3 = 4.5 ms per frame for jobs: 5 one-ms steps per frame, 10 steps → 2 frames
    expect(frames).toBe(2);
    expect(log.slice(0, 7)).toEqual(['live', 'job', 'job', 'job', 'job', 'job', 'live']);
    expect(jobs.pending).toBe(0);
    off();
    jobs.add(JobPrio.Cook, () => false);
    loop.request();
    frame((ts += 16.7));
    expect(jobs.pending).toBe(1); // detached
  });
});

describe('frame loop: measured frame interval', () => {
  it('measures back-to-back frames (120 Hz) as their median', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    loop.add(() => true);
    expect(loop.frameInterval).toBeCloseTo(16.667, 2);
    loop.request();
    let ts = 5000;
    for (let i = 0; i < 30; i++) frame((ts += 8.333 + (i % 3 === 0 ? 0.2 : -0.1)));
    expect(loop.frameInterval).toBeGreaterThan(8.2);
    expect(loop.frameInterval).toBeLessThan(8.5);
  });

  it('ignores dropped frames below 50% and idle gaps', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    let busy = true;
    loop.add(() => busy);
    loop.request();
    let ts = 0;
    for (let i = 0; i < 40; i++) frame((ts += i % 4 === 3 ? 33.4 : 16.7)); // every 4th frame dropped
    expect(loop.frameInterval).toBeCloseTo(16.7, 5);
    // go idle, wait 5 s, come back: the gap must not count as an interval
    busy = false;
    frame((ts += 16.7));
    expect(loop.running).toBe(false);
    ts += 5000;
    busy = true;
    loop.request();
    frame(ts);
    frame((ts += 16.7));
    expect(loop.frameInterval).toBeCloseTo(16.7, 5);
  });

  it('does not count gaps over 100 ms (hidden tab) as intervals', () => {
    const { env, frame } = fakeEnv();
    const loop = createFrameLoop(env);
    loop.add(() => true);
    loop.request();
    let ts = 0;
    for (let i = 0; i < 5; i++) frame((ts += 6.944)); // 144 Hz
    frame((ts += 900));                               // background-tab stall
    for (let i = 0; i < 5; i++) frame((ts += 6.944));
    expect(loop.frameInterval).toBeCloseTo(6.944, 5);
  });
});
