/**
 * Cooperative background jobs (DESIGN §9 "Job priority").
 *
 * A job is either an iterator (one step per `next()`) or a function that runs one
 * step per call and returns true while unfinished. `run(budget)` always steps the
 * highest-priority job (FIFO within a priority) and stops once the budget is spent,
 * so long work spreads over frames and input stays responsive. A single step cannot
 * be pre-empted, so jobs should keep their steps short.
 *
 * No DOM: the clock is injected (tests pass a fake one) and defaults to
 * `performance.now()` where it exists. This module is also imported by the pure
 * scene layer, so it must compile under tsconfig.pure.json.
 */

/** Job priorities, highest first (DESIGN §9; `Cook` is background cooking). */
export const enum JobPrio { Handoff = 0, Visible = 1, Lift = 2, Prefetch = 3, Bloom = 4, Save = 5, Sheets = 6, Cook = 7 }

const NPRIO = 8;

export interface Jobs {
  /**
   * A job is an iterator (one step per next()) or a function returning true while unfinished.
   * Adding with a key that is already queued replaces (cancels) the earlier job.
   */
  add(prio: JobPrio, job: Iterator<unknown> | (() => boolean), key?: string): void;
  /** Drop a queued job; an iterator job is closed with `return()` so its `finally` blocks run. */
  cancel(key: string): void;
  has(key: string): boolean;
  /**
   * Run jobs in priority order until budgetMs is spent. Returns true if work remains.
   * At least one step runs when budgetMs > 0 and anything is pending. Re-entrant calls
   * (a job calling run) return at once without running anything.
   */
  run(budgetMs: number): boolean;
  readonly pending: number;
}

/** Optional error sink; without one, a throwing job is removed and the error is rethrown from `run`. */
export type JobErrorFn = (err: unknown, key: string | null) => void;

interface Job {
  prio: number;
  key: string | null;
  fn: (() => boolean) | null;
  it: Iterator<unknown> | null;
  dead: boolean;
}

interface Queue { items: Job[]; head: number; dead: number }

function defaultClock(): () => number {
  const g = globalThis as unknown as { performance?: { now(): number } };
  const perf = g.performance;
  return perf && typeof perf.now === 'function' ? () => perf.now() : () => Date.now();
}

function closeIter(it: Iterator<unknown>): void {
  try { it.return?.(); } catch { /* a job that fails while closing is already gone */ }
}

/** Create a job queue. `now` is the budget clock in ms (default performance.now). */
export function createJobs(now?: () => number, onError?: JobErrorFn): Jobs {
  const clock = now ?? defaultClock();
  const queues: Queue[] = [];
  for (let i = 0; i < NPRIO; i++) queues.push({ items: [], head: 0, dead: 0 });
  const byKey = new Map<string, Job>();
  let live = 0;
  let running = false;
  let current: Job | null = null;

  function compact(q: Queue): void {
    if (q.head > 32 && q.head * 2 > q.items.length) {
      q.items.splice(0, q.head);
      q.head = 0;
    }
    if (q.dead > 16 && q.dead * 2 > q.items.length - q.head) {
      const kept: Job[] = [];
      for (let i = q.head; i < q.items.length; i++) if (!q.items[i].dead) kept.push(q.items[i]);
      q.items = kept; q.head = 0; q.dead = 0;
    }
  }

  /** Mark a job finished or cancelled; it stays in its queue as a tombstone until skipped. */
  function retire(job: Job): void {
    if (job.dead) return;
    job.dead = true;
    live--;
    queues[job.prio].dead++;
    if (job.key !== null && byKey.get(job.key) === job) byKey.delete(job.key);
  }

  function kill(job: Job): void {
    retire(job);
    // a generator cannot be closed from inside its own step; run() closes it afterwards
    if (job.it && job !== current) closeIter(job.it);
  }

  function front(): Job | null {
    for (let p = 0; p < NPRIO; p++) {
      const q = queues[p];
      while (q.head < q.items.length && q.items[q.head].dead) { q.head++; q.dead--; }
      compact(q);
      if (q.head < q.items.length) return q.items[q.head];
    }
    return null;
  }

  return {
    add(prio, job, key) {
      const p = prio < 0 ? 0 : prio >= NPRIO ? NPRIO - 1 : prio | 0;
      if (key !== undefined) {
        const old = byKey.get(key);
        if (old) kill(old);
      }
      const isFn = typeof job === 'function';
      const j: Job = {
        prio: p, key: key ?? null,
        fn: isFn ? job as () => boolean : null,
        it: isFn ? null : job as Iterator<unknown>,
        dead: false,
      };
      queues[p].items.push(j);
      live++;
      if (key !== undefined) byKey.set(key, j);
    },
    cancel(key) {
      const j = byKey.get(key);
      if (j) kill(j);
    },
    has: key => byKey.has(key),
    run(budgetMs) {
      if (running || live === 0 || !(budgetMs > 0)) return live > 0;
      running = true;
      const t0 = clock();
      let steps = 0;
      try {
        for (;;) {
          const job = front();
          if (!job) break;
          if (steps > 0 && clock() - t0 >= budgetMs) break;
          steps++;
          current = job;
          let more: boolean;
          try {
            more = job.fn ? job.fn() === true : job.it!.next().done !== true;
          } catch (err) {
            current = null;
            retire(job);
            if (onError) { onError(err, job.key); continue; }
            throw err;
          }
          current = null;
          if (job.dead) {
            if (more && job.it) closeIter(job.it); // cancelled itself mid-step
          } else if (!more) {
            retire(job);
          }
        }
      } finally {
        running = false;
        current = null;
      }
      return live > 0;
    },
    get pending() { return live; },
  };
}
