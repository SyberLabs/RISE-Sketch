/**
 * CPU-side performance counters (DESIGN §9: measured in-app with performance.now()). Fixed rings,
 * no allocation per sample. Read by the `?debug` hooks (RiseDebug.perf) and the e2e suite.
 */

const RING = 1024;

class Ring {
  private readonly a = new Float64Array(RING);
  private n = 0;
  private head = 0;
  max = 0;
  push(v: number): void {
    this.a[this.head] = v;
    this.head = (this.head + 1) % RING;
    if (this.n < RING) this.n++;
    if (v > this.max) this.max = v;
  }
  p95(): number {
    if (this.n === 0) return 0;
    const s = Array.from(this.a.subarray(0, this.n)).sort((x, y) => x - y);
    return s[Math.min(this.n - 1, Math.floor(0.95 * this.n))];
  }
  get count(): number { return this.n; }
  reset(): void { this.n = 0; this.head = 0; this.max = 0; }
}

export interface Perf {
  /** One live frame's CPU ms (draft step + renderer frame while ink is live). */
  live(ms: number): void;
  /** One input handler's CPU ms. */
  input(ms: number): void;
  read(reset?: boolean): { liveFrameP95: number; liveFrameMax: number; inputP95: number; frames: number; longTasks: number };
}

/** Counters plus a long-task observer where the browser has one. */
export function createPerf(): Perf {
  const live = new Ring(), input = new Ring();
  let longTasks = 0;
  try {
    const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (PO && PO.supportedEntryTypes?.includes('longtask')) {
      new PO(list => { longTasks += list.getEntries().length; }).observe({ entryTypes: ['longtask'] });
    }
  } catch { /* no long-task timing here */ }
  return {
    live: ms => live.push(ms),
    input: ms => input.push(ms),
    read(reset) {
      const out = {
        liveFrameP95: +live.p95().toFixed(3), liveFrameMax: +live.max.toFixed(3),
        inputP95: +input.p95().toFixed(3), frames: live.count, longTasks,
      };
      if (reset) { live.reset(); input.reset(); longTasks = 0; }
      return out;
    },
  };
}
