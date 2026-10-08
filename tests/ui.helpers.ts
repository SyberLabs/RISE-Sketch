/** Shared fixtures for the ui tests (not a test file itself). */
import type { AppState } from '../src/app/types';

export function state(patch: Partial<AppState> = {}): AppState {
  const base: AppState = {
    tool: {
      nib: 'brush', lastNib: 'brush',
      sizes: { pen: 2.5, brush: 9, chisel: 12, charcoal: 7 },
      ink: 'moss', custom: null, recents: [],
      form: 'sprout', base: { line: 0, echo: 2, sprout: 2, drift: 2, ripple: 2, craze: 2, plume: 2, caustic: 2, burin: 2, plait: 2, orbit: 2 },
      mode: 'draw', sym: { on: false, folds: 6, cx: 0, cy: 0 },
    },
    ground: 'night', selection: [], selectionRect: null, canUndo: false, canRedo: false, hasInk: false,
    zoom: 100, inkInView: true, inkDirection: null, chromeHidden: false, sheet: null, lastRecipe: null,
    docTitle: 'Untitled', currentDocId: 'doc', recentDocs: [], autosaveOk: true, replaying: false, replayProgress: 0,
    exporting: false, penMode: false, firstRun: false,
    hints: { draw: 'pending', rise: 'pending', form: 'pending', nav: 'pending' },
    reducedMotion: false, isTouch: false, isMac: false,
  };
  return { ...base, ...patch };
}

/** A fake one-shot timer queue driven by an explicit clock. */
export function fakeTimers() {
  let now = 0, next = 1;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set(fn: () => void, ms: number): number { const id = next++; q.set(id, { at: now + ms, fn }); return id; },
    clear(id: number): void { q.delete(id); },
    get pending(): number { return q.size; },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let best: number | null = null;
        for (const [id, t] of q) if (t.at <= end && (best === null || t.at < q.get(best)!.at)) best = id;
        if (best === null) break;
        const t = q.get(best)!;
        q.delete(best);
        now = t.at;
        t.fn();
      }
      now = end;
    },
  };
}
