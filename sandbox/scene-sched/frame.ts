/**
 * Real-browser check of sched/frame.ts + sched/jobs.ts: measured frame interval,
 * the §9 job budget under load, and true idling (no rAF once work drains).
 * Results land in window.__result (read by check.mjs).
 */
import { createFrameLoop } from '../../src/sched/frame';
import { createJobs, JobPrio } from '../../src/sched/jobs';

declare global { interface Window { __result?: unknown } }

let rafCalls = 0;
const raf0 = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb: FrameRequestCallback) => { rafCalls++; return raf0(cb); };

const loop = createFrameLoop();
const jobs = createJobs();
let jobOverrun = 0, jobFrames = 0;
loop.add((now, budget) => {
  const t0 = performance.now();
  const more = jobs.run(budget);
  const dt = performance.now() - t0;
  jobFrames++;
  // one 0.5 ms step may overrun the budget; anything more is a scheduler bug
  jobOverrun = Math.max(jobOverrun, dt - budget);
  return more;
}, 1000);

let frames = 0;
const budgets: number[] = [];
loop.add((_now, b) => { budgets.push(b); return ++frames < 90; }, 0);

let done = 0;
const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* spin */ } };
for (let i = 0; i < 300; i++) jobs.add(JobPrio.Cook, () => { busy(0.5); done++; return false; });

const t0 = performance.now();
loop.request();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
(async () => {
  while (loop.running) await sleep(50);
  const elapsed = performance.now() - t0;
  const callsAtIdle = rafCalls;
  await sleep(600);
  const result = {
    frames, jobFrames, done, elapsedMs: Math.round(elapsed),
    frameInterval: +loop.frameInterval.toFixed(2),
    firstBudget: +budgets[0].toFixed(2),
    jobOverrunMs: +jobOverrun.toFixed(2),
    idleRafCalls: rafCalls - callsAtIdle,
    runningAfterIdle: loop.running,
  };
  window.__result = result;
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 2);
})();
