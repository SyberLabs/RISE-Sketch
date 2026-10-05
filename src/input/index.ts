/**
 * Input layer entry point (DESIGN §5): binds DOM events on the target and on the
 * window, turns them into samples (pointer.ts) and lets the arbiter classify them.
 *
 * Sink notes for app/:
 *  - Every position is viewport CSS px (clientX / clientY).
 *  - The sample passed to strokeBegin, the arrays passed to strokeMove and the object
 *    passed to hover are REUSED: copy what you keep.
 *  - A touch-only tap's strokeEnd arrives up to 300 ms after its contact(false)
 *    (double-tap window, see arbiter.ts); treat contact(false) as the lift moment.
 *  - KeyAction objects are shared frozen constants.
 *
 * Allocation: none per event in steady state. Listeners, scratch records and sample
 * pools are created once here; the browser's own coalesced / predicted arrays are
 * excused (§5).
 */
import type { InputSample } from '../core/types';
import type { InputController, InputOptions, InputSink } from './types';
import { Arbiter, type ArbiterState, type PointerInfo, type WheelInput } from './arbiter';
import { CHUNK, PointerReader, contactRadius } from './pointer';
import { PEN_EXPIRY_MS, deviceOf } from './devices';
import { isChord, keyAction, repeatable } from './keys';

export { sanitizeTime } from './pointer';
export { classifyWheel, createWheelState } from './wheel';
export type { WheelState } from './wheel';
export { keyAction } from './keys';
export type { ArbiterState } from './arbiter';

/** The controller with the hooks app/ needs beyond the frozen contract (see docs/contract-requests/input.md). */
export interface InputControllerEx extends InputController {
  /** Pen mode changed (first pen event, 30 min expiry, disablePenMode). Returns an unsubscribe. */
  onPenMode(fn: (on: boolean) => void): () => void;
  /** A pen-mode one-finger pan started; the app shows the pen-mode toast on the first of the session. */
  onFingerPan(fn: () => void): () => void;
  /** Current arbiter state (debug, e2e). */
  readonly state: ArbiterState;
}

/** localStorage key holding the wall-clock time of the last pen event ("remembered per device"). */
const PEN_KEY = 'rise:penmode';
const NONE: readonly InputSample[] = Object.freeze([]) as readonly InputSample[];

interface GestureEventLike extends Event {
  readonly scale?: number;
  readonly clientX?: number;
  readonly clientY?: number;
}

/** Bind input to `opts.target` and report classified gestures to `sink`. */
export function createInput(opts: InputOptions, sink: InputSink): InputControllerEx {
  const target = opts.target;
  const doc = target.ownerDocument;
  const win = doc.defaultView ?? window;
  const isMac = opts.isMac;
  const penFns = new Set<(on: boolean) => void>();
  const panFns = new Set<() => void>();
  const reader = new PointerReader();
  const info: PointerInfo = {
    id: 0, device: 'mouse', x: 0, y: 0, t: 0, button: 0, buttons: 0, pressure: 0, mod: false, shift: false, alt: false,
    radius: NaN,
  };
  const wi: WheelInput = {
    deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, x: 0, y: 0, t: 0, pageW: 0, pageH: 0,
  };

  const storage = (): Storage | null => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  };
  const savePen = (): void => {
    try {
      storage()?.setItem(PEN_KEY, String(Date.now()));
    } catch { /* quota / privacy mode: pen mode just is not remembered */ }
  };
  const forgetPen = (): void => {
    try {
      storage()?.removeItem(PEN_KEY);
    } catch { /* see savePen */ }
  };
  const restorePen = (): number | undefined => {
    try {
      const v = Number(storage()?.getItem(PEN_KEY));
      const age = Date.now() - v;
      if (v > 0 && age >= 0 && age < PEN_EXPIRY_MS) return performance.now() - age;
    } catch { /* see savePen */ }
    return undefined;
  };

  const arb = new Arbiter(sink, {
    mode: opts.mode,
    now: () => performance.now(),
    setTimer: (fn, ms) => win.setTimeout(fn, ms),
    clearTimer: h => win.clearTimeout(h),
    onPenMode: on => {
      if (on) savePen();
      else forgetPen();
      for (const fn of penFns) fn(on);
    },
    onFingerPan: () => {
      for (const fn of panFns) fn();
    },
    lastPen: restorePen(),
  });

  const fill = (e: PointerEvent): PointerInfo => {
    const d = deviceOf(e.pointerType);
    info.id = e.pointerId;
    info.device = d;
    info.x = e.clientX;
    info.y = e.clientY;
    info.t = e.timeStamp;
    info.buttons = e.buttons;
    info.pressure = e.pressure;
    // macOS turns Ctrl+click into a secondary click: treat it as the right button.
    info.button = isMac && d === 'mouse' && e.ctrlKey && !e.metaKey && e.button === 0 ? 2 : e.button;
    info.mod = isMac ? e.metaKey : e.ctrlKey;
    info.shift = e.shiftKey;
    info.alt = e.altKey;
    info.radius = d === 'touch' ? contactRadius(e.width, e.height) : NaN;
    return info;
  };

  const onDown = (e: PointerEvent): void => {
    const p = fill(e);
    const s = reader.readOne(e, p.device, arb.mayStroke(p.device));
    arb.down(p, s);
    const w = arb.wants(p.id);
    if (w === 2) reader.restart(s);
    if (w !== 0 && p.device !== 'touch') {
      try {
        target.setPointerCapture(p.id);
      } catch { /* synthetic or already-released pointer */ }
    }
  };

  const onMove = (e: PointerEvent): void => {
    const id = e.pointerId;
    const w = arb.wants(id);
    const p = fill(e);
    if (w === 0) {
      if (p.device !== 'touch' && e.buttons === 0) arb.hover(p, reader.readOne(e, p.device, false));
      return;
    }
    const stroke = w === 2;
    const n = reader.begin(e);
    for (let i = 0; i < n; i += CHUNK) {
      const i1 = Math.min(n, i + CHUNK);
      const samples = reader.chunk(i, i1, p.device, stroke);
      arb.move(p, samples, stroke && i1 === n ? reader.predict(p.device) : NONE);
      if (arb.wants(id) === 0) break; // released (lost pointerup detected)
    }
    reader.end();
  };

  const onUp = (e: PointerEvent): void => {
    const w = arb.wants(e.pointerId);
    if (w === 0) return;
    const p = fill(e);
    arb.up(p, reader.readOne(e, p.device, w === 2));
    if (p.device === 'pen') savePen();
  };

  const onCancel = (e: PointerEvent): void => {
    if (arb.wants(e.pointerId) !== 0) arb.cancel(fill(e));
  };

  // Losing OUR capture without a pointerup means the events stop reaching us: end the
  // contact as cancelled. A child losing implicit capture (bubbled) is not that.
  const onLostCapture = (e: PointerEvent): void => {
    if (e.target === target) onCancel(e);
  };

  const onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || arb.wants(e.pointerId) !== 0) return;
    arb.leave(fill(e));
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // the canvas owns the wheel (no page scroll, no browser zoom on ctrl+wheel)
    wi.deltaX = e.deltaX;
    wi.deltaY = e.deltaY;
    wi.deltaMode = e.deltaMode;
    wi.ctrlKey = e.ctrlKey;
    wi.shiftKey = e.shiftKey;
    wi.x = e.clientX;
    wi.y = e.clientY;
    wi.t = e.timeStamp;
    wi.pageW = win.innerWidth;
    wi.pageH = win.innerHeight;
    arb.wheel(wi);
  };

  const prevent = (e: Event): void => e.preventDefault();

  // Middle-button autoscroll and Linux middle-click paste start from mousedown / auxclick.
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  const onGesture = (e: Event): void => {
    e.preventDefault(); // Safari page zoom: the canvas owns pinch
    const g = e as GestureEventLike;
    const phase = e.type === 'gesturestart' ? 'start' : e.type === 'gestureend' ? 'end' : 'change';
    // Every phase goes through (the scale is cumulative); a pinch over the chrome zooms the canvas beneath it.
    arb.gesture(phase, g.scale ?? 1, g.clientX ?? win.innerWidth / 2, g.clientY ?? win.innerHeight / 2, e.timeStamp);
  };

  const editable = (t: EventTarget | null): boolean => {
    if (!(t instanceof HTMLElement)) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };
  const interactive = (t: EventTarget | null): boolean =>
    t instanceof Element && t.closest('button, input, textarea, select, a[href], [contenteditable], [role="button"], [role="radio"], [role="tab"], [role="menuitem"]') !== null;
  // DESIGN §5: single-key shortcuts are ignored while focus is in a radio group (the
  // sheets' tile groups), whatever keysBlocked() says.
  const inRadioGroup = (t: EventTarget | null): boolean =>
    t instanceof Element && t.closest('[role="radiogroup"], [role="radio"]') !== null;

  const onKeyDown = (e: KeyboardEvent): void => {
    // A focused widget that consumed the key (preventDefault) keeps it from the canvas map.
    if (e.isComposing || e.defaultPrevented) return;
    if (e.code === 'Space') {
      if (e.repeat) {
        if (arb.spaceHeld) e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || opts.keysBlocked() || interactive(e.target)) return;
      e.preventDefault(); // no page scroll
      arb.setSpace(true);
      return;
    }
    const a = keyAction(e, isMac);
    if (!a || editable(e.target)) return;
    if (!isChord(e) && (opts.keysBlocked() || inRadioGroup(e.target))) return;
    e.preventDefault();
    if (e.repeat && !repeatable(a)) return;
    arb.flush();
    sink.key(a);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && arb.spaceHeld) {
      e.preventDefault();
      arb.setSpace(false);
    }
  };

  // A press anywhere outside the canvas (the chrome) commits a deferred touch tap first,
  // so e.g. tapping a dot and then Undo undoes that dot.
  const onAnyDown = (e: PointerEvent): void => {
    const t = e.target;
    if (!(t instanceof Node) || !target.contains(t)) arb.flush();
  };

  const onBlur = (): void => arb.reset();
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') arb.reset();
  };

  const prevTouchAction = target.style.touchAction;
  target.style.touchAction = 'none';

  const nonPassive: AddEventListenerOptions = { passive: false };
  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  target.addEventListener('lostpointercapture', onLostCapture);
  target.addEventListener('pointerleave', onLeave);
  target.addEventListener('wheel', onWheel, nonPassive);
  target.addEventListener('contextmenu', prevent);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('auxclick', onMouseDown);
  doc.addEventListener('gesturestart', onGesture, nonPassive);
  doc.addEventListener('gesturechange', onGesture, nonPassive);
  doc.addEventListener('gestureend', onGesture, nonPassive);
  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('pointerdown', onAnyDown, true);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  let disposed = false;
  return {
    get penMode(): boolean {
      return arb.penMode;
    },
    disablePenMode(): void {
      arb.disablePenMode();
    },
    get spaceHeld(): boolean {
      return arb.spaceHeld;
    },
    get state(): ArbiterState {
      return arb.state;
    },
    onPenMode(fn: (on: boolean) => void): () => void {
      penFns.add(fn);
      return () => {
        penFns.delete(fn);
      };
    },
    onFingerPan(fn: () => void): () => void {
      panFns.add(fn);
      return () => {
        panFns.delete(fn);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      arb.dispose();
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
      target.removeEventListener('lostpointercapture', onLostCapture);
      target.removeEventListener('pointerleave', onLeave);
      target.removeEventListener('wheel', onWheel, nonPassive);
      target.removeEventListener('contextmenu', prevent);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('auxclick', onMouseDown);
      doc.removeEventListener('gesturestart', onGesture, nonPassive);
      doc.removeEventListener('gesturechange', onGesture, nonPassive);
      doc.removeEventListener('gestureend', onGesture, nonPassive);
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('pointerdown', onAnyDown, true);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      target.style.touchAction = prevTouchAction;
      penFns.clear();
      panFns.clear();
    },
  };
}
