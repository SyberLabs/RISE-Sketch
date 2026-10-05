/**
 * The observable app state (DESIGN §7.1 app/store.ts): one immutable AppState object, replaced on
 * every change, plus a one-way event channel (toasts, announcements, pulses, hints) and the
 * dispatch seam to the controller. ui/ reads it and dispatches Intents; it never sees the
 * document, the scene or the renderer.
 *
 * Notifications are synchronous (the UI compares `prev` and `s` field by field), and only real
 * changes notify: a patch whose fields are all identical is free, so hot paths may call `set`
 * without checking first. A `set` made by a subscriber while others are still being told is
 * delivered after them, in order, so nobody ever sees a stale state last.
 */
import type { AppEvent, AppState, Intent, Store } from './types';

/** The store plus the writer side the controller uses. */
export interface StoreImpl extends Store {
  /** Shallow-merge a patch; notifies only when some field actually changed. */
  set(patch: Partial<AppState>): void;
  /** Send a one-shot event to the UI (toast, announcement, pulse, hint). */
  emit(e: AppEvent): void;
  /** Where dispatched intents go (the controller). */
  setDispatcher(fn: (i: Intent) => void): void;
}

/** Create the store with its initial state. */
export function createStore(initial: AppState): StoreImpl {
  let state = initial;
  let delivered = initial;
  let notifying = false;
  const subs: ((s: AppState, prev: AppState) => void)[] = [];
  const evs: ((e: AppEvent) => void)[] = [];
  let dispatcher: ((i: Intent) => void) | null = null;

  function flush(): void {
    if (notifying) return;
    notifying = true;
    try {
      while (delivered !== state) {
        const prev = delivered, s = state;
        delivered = s;
        for (const fn of subs.slice()) {
          try { fn(s, prev); } catch (err) { console.error('[rise] state subscriber failed', err); }
        }
      }
    } finally {
      notifying = false;
    }
  }

  return {
    get: () => state,
    set(patch) {
      const cur = state as unknown as Record<string, unknown>;
      const p = patch as Record<string, unknown>;
      let changed = false;
      for (const k in p) if (p[k] !== cur[k]) { changed = true; break; }
      if (!changed) return;
      state = { ...state, ...patch };
      flush();
    },
    subscribe(fn) {
      subs.push(fn);
      return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    },
    on(fn) {
      evs.push(fn);
      return () => { const i = evs.indexOf(fn); if (i >= 0) evs.splice(i, 1); };
    },
    emit(e) {
      for (const fn of evs.slice()) {
        try { fn(e); } catch (err) { console.error('[rise] event listener failed', err); }
      }
    },
    dispatch(i) {
      if (!dispatcher) return;
      try { dispatcher(i); } catch (err) { console.error('[rise] intent failed', i.k, err); }
    },
    setDispatcher(fn) { dispatcher = fn; },
  };
}
