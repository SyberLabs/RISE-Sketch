/**
 * Polite, throttled aria-live announcements (DESIGN §10 "Screen readers"): "Sprout stroke
 * added", "Rose to depth 3", "3 strokes selected", "Image saved".
 *
 * Throttle policy (decision): at most one utterance per `gapMs`. While waiting, a new message of
 * the same kind (same text once numbers are masked, e.g. "Rose to depth 2" -> "Rose to depth 3")
 * replaces the queued one, so a long hold announces only its final depth; distinct messages queue
 * (at most 3, oldest dropped). Only one-shot timers are used, so an idle page has none pending.
 */

/** Timer seam so the throttle is unit-testable without a DOM or real time. */
export interface AnnounceTimers {
  now(): number;
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface Announcer {
  /** Queue `text` for the live region. Empty strings are ignored. */
  say(text: string): void;
  /** Pending utterances (for tests and debugging). */
  readonly pending: readonly string[];
  dispose(): void;
}

const MAX_QUEUE = 3;
const NBSP = ' ';

/** Kind key of a message: numbers masked, so updates of one counter coalesce. */
export function announceKind(text: string): string {
  return text.replace(/[\d.,½¼¾]+/g, '#').trim().toLowerCase();
}

const browserTimers: AnnounceTimers = {
  now: () => performance.now(),
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: id => window.clearTimeout(id),
};

/**
 * Announcer writing into `target` (an aria-live element). Identical consecutive messages are
 * re-announced by alternating a trailing no-break space, which changes the text node.
 */
export function createAnnouncer(target: { textContent: string | null }, gapMs = 900, timers: AnnounceTimers = browserTimers): Announcer {
  const queue: string[] = [];
  let timer = 0;
  let armed = false;
  let last = -Infinity;
  let flip = false;

  const flush = (): void => {
    armed = false;
    const msg = queue.shift();
    if (msg === undefined) return;
    flip = !flip;
    target.textContent = flip ? msg : msg + NBSP;
    last = timers.now();
    if (queue.length) arm();
  };
  const arm = (): void => {
    if (armed) return;
    armed = true;
    timer = timers.set(flush, Math.max(0, last + gapMs - timers.now()));
  };

  return {
    say(text: string): void {
      const t = text.trim();
      if (!t) return;
      const kind = announceKind(t);
      const i = queue.findIndex(q => announceKind(q) === kind);
      if (i >= 0) queue.splice(i, 1);
      queue.push(t);
      while (queue.length > MAX_QUEUE) queue.shift();
      arm();
    },
    get pending() { return queue; },
    dispose(): void {
      if (armed) timers.clear(timer);
      armed = false;
      queue.length = 0;
    },
  };
}

/** The visually hidden polite live region the announcer writes into. */
export function createLiveRegion(root: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'r-live';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  root.appendChild(el);
  return el;
}
