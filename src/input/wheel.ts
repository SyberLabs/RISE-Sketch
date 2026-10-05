/**
 * Wheel burst classifier (DESIGN §5 "Wheel" and the mouse/trackpad rows).
 *
 * A burst is a run of wheel events with gaps under 400 ms. Its DEVICE is decided on
 * its first event: a mouse notch if `deltaMode` is lines/pages, or if |Δy| is an
 * integer ≥ 50 with Δx = 0; anything else is a trackpad. Laptop users switch
 * between mouse and trackpad, so this is per burst, never per session.
 *
 * Decision: inside a trackpad burst each event is then a pinch when `ctrlKey` is set
 * (browsers report trackpad pinch as ctrl+wheel) and a scroll otherwise, so a pinch
 * that follows a two-finger scroll within 400 ms still zooms. Inside a notch burst
 * every event is a notch, including Ctrl+wheel on a mouse (×1.15 per notch, never the
 * pinch curve, which would zoom ×3 per notch). deltaMode 2 (pages) counts as a
 * notch too: only wheels configured to scroll by pages report it.
 */

/** Mutable per-input burst state (create with createWheelState). */
export interface WheelState {
  /** Event time of the last wheel event, ms. */
  last: number;
  /** Device of the current burst; null before the first event. */
  kind: 'notch' | 'trackpad' | null;
}

/** A new burst starts after this gap, ms. */
export const WHEEL_GAP_MS = 400;
/** Zoom per mouse notch. */
export const NOTCH_ZOOM = 1.15;
/** Trackpad pinch zoom: ×exp(−Δy·0.012). */
export const PINCH_K = 0.012;
/** CSS px per wheel "line" (deltaMode 1), matching Chromium's scroll step. */
export const LINE_PX = 40;

export function createWheelState(): WheelState {
  return { last: -Infinity, kind: null };
}

/** Whether one event looks like a mouse notch (the burst's first event decides). */
export function isNotchEvent(e: { deltaMode: number; deltaX: number; deltaY: number }): boolean {
  if (e.deltaMode !== 0) return true;
  const ay = Math.abs(e.deltaY);
  return e.deltaX === 0 && ay >= 50 && Number.isInteger(ay);
}

/** Classify one wheel event at time `now`, updating the burst state. */
export function classifyWheel(
  e: { deltaMode: number; deltaX: number; deltaY: number; ctrlKey: boolean },
  state: WheelState,
  now: number,
): 'notch' | 'pinch' | 'scroll' {
  if (state.kind === null || !(now - state.last < WHEEL_GAP_MS)) {
    state.kind = isNotchEvent(e) ? 'notch' : 'trackpad';
  }
  state.last = now;
  if (state.kind === 'notch') return 'notch';
  return e.ctrlKey ? 'pinch' : 'scroll';
}

/** Convert a wheel delta to CSS px. `pagePx` is the viewport extent along that axis. */
export function wheelPixels(delta: number, deltaMode: number, pagePx: number): number {
  return deltaMode === 1 ? delta * LINE_PX : deltaMode === 2 ? delta * pagePx : delta;
}

/**
 * Zoom factor of a notch event (Δy > 0 scrolls down = zooms out). Line/page events
 * and pixel events of at least half a notch (100 px) count whole notches; smaller
 * pixel deltas (high-resolution wheels) zoom fractionally so free-spinning wheels stay smooth.
 */
export function notchFactor(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) return 1;
  let n = deltaMode === 1 ? Math.abs(deltaY) / 3 : deltaMode === 2 ? Math.abs(deltaY) : Math.abs(deltaY) / 100;
  if (deltaMode !== 0) n = Math.max(1, Math.round(n));
  else if (n >= 0.5) n = Math.round(n);
  return Math.pow(NOTCH_ZOOM, deltaY > 0 ? -n : n);
}

/** Zoom factor of a trackpad pinch event, clamped so one malformed event cannot jump the camera. */
export function pinchFactor(deltaY: number): number {
  const f = Math.exp(-deltaY * PINCH_K);
  return f < 0.25 ? 0.25 : f > 4 ? 4 : f;
}
