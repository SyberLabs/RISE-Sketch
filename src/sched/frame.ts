/**
 * The single on-demand rAF loop (DESIGN §9 "Scheduler", §1.1 rule 7).
 *
 * A frame is scheduled only when `request()` is called or when some participant
 * returned true in the previous frame, so an idle page costs nothing: no rAF and
 * no timers. Participants run in ascending `order` (ties in insertion order) and
 * each receives the frame's rAF timestamp plus a CPU budget:
 *
 *   budget = clamp(0.45 · frameInterval − elapsedThisFrame, 1, 6) ms
 *
 * which is §9 step 6 applied uniformly: the live layer (early, small `order`) sees
 * the whole slice, and background jobs (late) get what the live work left over.
 * The frame interval is measured per display from back-to-back frames only (an
 * idle gap is not an interval), as the median of the last 15, so 120 Hz screens
 * get proportionally smaller slices and occasional dropped frames do not skew it.
 */

export interface FrameLoop {
  /** Schedule a frame if none is pending. Idempotent; safe to call from inside a frame. */
  request(): void;
  /** Participants run each frame in order of `order`; return true while they need more frames. */
  add(fn: (now: number, budgetMs: number) => boolean, order?: number): () => void;
  /** Measured display frame interval, ms (16.67 until measured). */
  readonly frameInterval: number;
  /** True while a frame is pending or executing. */
  readonly running: boolean;
}

/** Host hooks; tests inject a fake rAF and clock. */
export interface FrameEnv {
  raf(cb: (t: number) => void): number;
  now(): number;
  /** Where participant exceptions go (default console.error). */
  report?(err: unknown): void;
}

interface Participant {
  fn: (now: number, budgetMs: number) => boolean;
  order: number;
  dead: boolean;
  errors: number;
}

const DEFAULT_INTERVAL = 1000 / 60;
const RING = 15;
const MIN_INTERVAL = 2;    // ms; anything shorter is a duplicate callback, not a display frame
const MAX_INTERVAL = 100;  // ms; anything longer is a stall or a hidden tab
const MAX_ERRORS = 3;      // consecutive throws before a participant stops keeping the loop alive

function browserEnv(): FrameEnv {
  return {
    raf: cb => requestAnimationFrame(cb),
    now: () => performance.now(),
    report: err => console.error(err),
  };
}

/** rAF only while some participant returns true or request() was called. */
export function createFrameLoop(env: FrameEnv = browserEnv()): FrameLoop {
  const parts: Participant[] = [];
  const adds: Participant[] = [];
  let pending = false;
  let inFrame = false;
  let chained = false;   // the previous frame scheduled this one directly
  let lastTs = -1;
  let interval = DEFAULT_INTERVAL;
  let dirtyRemovals = false;
  const ring = new Float64Array(RING);
  const sorted = new Float64Array(RING);
  let ringN = 0, ringAt = 0;

  const report = env.report ?? ((err: unknown) => console.error(err));

  function insertSorted(p: Participant): void {
    let i = parts.length;
    while (i > 0 && parts[i - 1].order > p.order) i--;
    parts.splice(i, 0, p);
  }

  function measure(dt: number): void {
    if (!(dt >= MIN_INTERVAL && dt <= MAX_INTERVAL)) return;
    ring[ringAt] = dt;
    ringAt = (ringAt + 1) % RING;
    if (ringN < RING) ringN++;
    // insertion sort of ≤ 15 values into a reused buffer: allocation-free median
    for (let i = 0; i < ringN; i++) {
      const v = ring[i];
      let j = i;
      while (j > 0 && sorted[j - 1] > v) { sorted[j] = sorted[j - 1]; j--; }
      sorted[j] = v;
    }
    interval = ringN & 1 ? sorted[ringN >> 1] : 0.5 * (sorted[(ringN >> 1) - 1] + sorted[ringN >> 1]);
  }

  function tick(ts: number): void {
    pending = false;
    if (chained && lastTs >= 0) measure(ts - lastTs);
    lastTs = ts;
    inFrame = true;
    const start = env.now();
    let more = false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.dead) continue;
      let b = 0.45 * interval - (env.now() - start);
      b = b < 1 ? 1 : b > 6 ? 6 : b;
      let again: boolean;
      try {
        again = p.fn(ts, b) === true;
        p.errors = 0;
      } catch (err) {
        again = ++p.errors < MAX_ERRORS;
        try { report(err); } catch { /* never let reporting kill the loop */ }
      }
      if (again) more = true;
    }
    inFrame = false;
    if (dirtyRemovals) {
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i].dead) parts.splice(i, 1);
      dirtyRemovals = false;
    }
    if (adds.length) {
      for (const p of adds) if (!p.dead) insertSorted(p);
      adds.length = 0;
    }
    if (more) loop.request();
    chained = pending;
  }

  const loop: FrameLoop = {
    request() {
      if (pending) return;
      pending = true;
      // a request from outside an idle loop starts a new run: its first gap is not an interval
      if (!inFrame) chained = false;
      env.raf(tick);
    },
    add(fn, order = 0) {
      const p: Participant = { fn, order, dead: false, errors: 0 };
      if (inFrame) adds.push(p); else insertSorted(p);
      return () => {
        if (p.dead) return;
        p.dead = true;
        if (inFrame) { dirtyRemovals = true; return; }
        const i = parts.indexOf(p);
        if (i >= 0) parts.splice(i, 1);
      };
    },
    get frameInterval() { return interval; },
    get running() { return pending || inFrame; },
  };
  return loop;
}

/** Wire a job queue into the loop as its last participant (DESIGN §9 step 6). */
export function attachJobs(loop: FrameLoop, jobs: { run(budgetMs: number): boolean }, order = 1000): () => void {
  return loop.add((_now, budgetMs) => jobs.run(budgetMs), order);
}
