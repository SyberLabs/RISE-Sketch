/**
 * The gesture arbiter (DESIGN §5, §3.4 "Select", §1.4 "Selecting"): decides what
 * every contact becomes and drives the InputSink.
 *
 *   idle → draw | erase | lasso | navigate | sample | chipDrag   (+ 'pending' while undecided)
 *
 * DOM-free: index.ts feeds it PointerInfo records and InputSample batches built by
 * pointer.ts, timers come from the env, so the whole state machine runs under
 * vitest. Times are event-clock ms (e.timeStamp); positions are viewport CSS px.
 *
 * Rules implemented here (DESIGN §5):
 *  - One drawing pointer at a time; the camera is locked during a stroke or lasso.
 *  - Mouse / desktop pen: left = draw (erase in erase mode); Mod-click selects,
 *    Mod-drag lassos, Shift adds; Alt-click samples; right-drag (or pen barrel drag)
 *    erases after ≥ 4 sp, a bare right-click does nothing; eraser end erases at once;
 *    middle-drag and Space-drag pan.
 *  - Touch, no pen seen: one finger draws; a second finger within 150 ms (first
 *    finger < 20 px travel) withdraws the stroke and starts a two-finger gesture;
 *    two fingers pan and pinch (4 % scale dead zone); a 2-finger tap undoes; a
 *    double-tap selects, double-tap-then-drag lassos.
 *  - Pen mode: fingers never draw. One-finger tap selects; held 350 ms then dragged
 *    lassos; > 12 sp within 250 ms pans (no pen activity in the last 500 ms); two
 *    fingers pinch only once both have moved. Palms are ignored (devices.ts).
 *  - pointercancel: pen / mouse commit what exists; touch withdraws inside the
 *    150 ms window and commits after it.
 *  - Taps are classified at release by the maximum number of simultaneous contacts.
 *
 * Decisions (spec silent or ambiguous):
 *  - Touch-only double-tap: the first tap is an ordinary stroke (a radial seed) whose
 *    strokeEnd is DEFERRED for the double-tap window (300 ms). A second tap nearby
 *    withdraws it (un-grow, no history) and selects; otherwise it commits. contact(false)
 *    fires at the real lift, so the app can stop the rise clock there. Anything else
 *    (a far contact, a mouse press, a key, a pointerdown on the chrome, wheel, hide)
 *    commits it first, so history order is never disturbed. The one exception is a pen
 *    touching down within the window: like a live finger stroke, the tap is then taken
 *    for the hand landing before the pen and is withdrawn.
 *  - contact(true) is sent for contacts that draw, erase, lasso or navigate. Clicks
 *    (Mod-click, Alt-click, finger taps, a bare right-click) never hide the chrome.
 *  - A pen touching down while a finger stroke is live withdraws that stroke (it is
 *    almost always the palm that landed first on the first pen use) and ends any
 *    finger gesture: all touches yield to the pen. Touches that were down then stay
 *    palms until they lift: they leave the tap session, so a resting palm can neither
 *    block later finger taps nor join a two-finger gesture.
 *  - A pen barrel pressed while hovering fires pointerdown too (Pointer Events): the
 *    ≥ 4 sp barrel-erase travel counts only from where the tip lands, and lifting the
 *    tip with the barrel still held (a pointermove, not a pointerup) commits the erase
 *    there, so nothing is ever erased in the air. Landing again erases anew.
 *  - A pen-mode finger whose contact grows past the palm radius before it has done
 *    anything (a palm rolling onto the glass) becomes a palm.
 *  - Travel thresholds use the maximum displacement from the down point, so jitter
 *    in place never counts as travel.
 *  - navEnd reports 'pinch' only if the 4 % dead zone was exceeded, else 'drag', so
 *    a pure two-finger pan never snaps the zoom to a detent.
 *  - After a two-finger gesture the remaining finger never draws: in pen mode it keeps
 *    panning (one finger pans there), in touch-only mode it rests; a finger that
 *    rejoins it starts a new two-finger gesture (re-grip). navEnd reports 'pinch' if
 *    any part of the navigation zoomed.
 *  - Pen mode, a second contact joining a one-finger pan: until both have moved (the
 *    both-moved pinch rule) the panning finger keeps panning on its own and the pinch
 *    re-bases, so the canvas stays under the finger and zoom never jumps when the gate
 *    opens. If the panning finger lifts first, the unmoved contact does not inherit it.
 *  - Space-drag keeps panning until the pointer lifts even if Space is released.
 */
import type { Device, InputSample } from '../core/types';
import type { InputSink } from './types';
import { PALM_RADIUS, PEN_EXPIRY_MS, PenMode, type PenEventKind } from './devices';
import {
  DOUBLE_TAP_MS, DRAG_SLOP, FingerIntent, PINCH_MOVE, TAP_SLOP, TapSession, TwoFinger, WITHDRAW_MS,
  WITHDRAW_TRAVEL, isDoubleTap,
} from './gestures';
import { WHEEL_GAP_MS, classifyWheel, createWheelState, notchFactor, pinchFactor, wheelPixels } from './wheel';
import { copySample, newSample } from './pointer';

/** Arbiter state (DESIGN §5). 'chipDrag' belongs to the dock: chips live in #chrome, outside the input target, so the arbiter never enters it; it is kept for the shared vocabulary. */
export type ArbiterState = 'idle' | 'draw' | 'erase' | 'lasso' | 'navigate' | 'sample' | 'chipDrag' | 'pending';

/** One pointer event, as index.ts extracts it (reused by the caller; the arbiter copies what it keeps). */
export interface PointerInfo {
  id: number;
  device: Device;
  x: number; y: number;   // viewport CSS px
  t: number;              // raw event time, ms
  button: number;         // PointerEvent.button (mac Ctrl+click already mapped to 2)
  buttons: number;        // PointerEvent.buttons
  pressure: number;       // PointerEvent.pressure (0 when not in contact)
  mod: boolean;           // ⌘ on macOS, Ctrl elsewhere
  shift: boolean;
  alt: boolean;
  radius: number;         // palm-test radius, CSS px; NaN when unknown
}

/** One wheel event (reused by the caller). */
export interface WheelInput {
  deltaX: number; deltaY: number; deltaMode: number;
  ctrlKey: boolean; shiftKey: boolean;
  x: number; y: number; t: number;
  pageW: number; pageH: number; // viewport size, for deltaMode 2
}

/** Host services. Tests inject a fake clock and timers. */
export interface ArbiterEnv {
  /** Tool mode, read at pointerdown. */
  mode(): 'draw' | 'erase';
  /** Current time on the event clock (performance.now()). */
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** Pen mode flipped (first pen event, 30 min expiry, disablePenMode). */
  onPenMode?(on: boolean): void;
  /** A pen-mode one-finger pan started (the app shows the session's pen-mode toast once). */
  onFingerPan?(): void;
  /** Event-clock time of the last pen event of a previous session (persisted), if recent. */
  lastPen?: number;
}

const enum Role { Ignore, Stroke, PendErase, PendSelect, PendSample, Lasso, Pan, Finger, DTap, Two }

class Contact {
  id = 0;
  device: Device = 'mouse';
  role = Role.Ignore;
  x0 = 0; y0 = 0; t0 = 0;   // down
  x = 0; y = 0; t = 0;      // latest
  dMax = 0;                 // max displacement from the down point
  sx = 0; sy = 0; dTwo = 0; // two-finger start point and max displacement since
  counted = false;          // contributes to contact(true/false)
  session = false;          // member of the touch tap session
  air = false;              // pen barrel pressed while hovering: the tip has not landed yet
  barrel = false;           // pen barrel erase (its stroke ends when the tip leaves the glass)
  shift = false;
  readonly intent = new FingerIntent();
}

const NONE: readonly InputSample[] = Object.freeze([]) as readonly InputSample[];

export class Arbiter {
  private readonly cs: Contact[] = [];
  private n = 0;
  private strokeC: Contact | null = null;
  private strokeOpen = false;        // between sink.strokeBegin and sink.strokeEnd
  private strokeErase = false;
  private readonly lastOut = newSample();
  private readonly pendBegin = newSample();
  private readonly finalOne: InputSample[] = [newSample()];
  private lassoC: Contact | null = null;
  private panC: Contact | null = null;
  private twoA: Contact | null = null;
  private twoB: Contact | null = null;
  private twoPen = false;            // the two-finger gesture follows the pen-mode both-moved rule
  private twoLead: Contact | null = null; // pen mode: the finger that was panning when the second contact joined
  private twoNav = false;            // navigation started (or continued from a finger pan)
  private navZoomed = false;         // the current touch navigation zoomed at some point (pan <-> pinch hand-overs)
  private sessionTwo = false;        // the current tap session had a two-finger gesture
  private readonly two = new TwoFinger();
  private readonly tap = new TapSession();
  private pendTap = false;           // a touch tap whose strokeEnd is deferred
  private pendX = 0;
  private pendY = 0;
  private pendT = 0;
  private pendTimer = 0;
  private counted = 0;
  private readonly pen: PenMode;
  private penReported: boolean;
  private penTimer = 0;
  private readonly wheelState = createWheelState();
  private wheelNav = false;
  private wheelLast = 0;
  private wheelTimer = 0;
  private lastCtrlWheel = -Infinity;
  private gScale = 1;
  private gNav = false;
  private space = false;
  private hovering = false;
  private readonly hov = { x: 0, y: 0, device: 'mouse' as Device, alt: Math.PI / 2, az: 0 };

  constructor(private readonly sink: InputSink, private readonly env: ArbiterEnv) {
    this.pen = new PenMode(env.lastPen);
    this.penReported = this.pen.on(env.now());
    if (this.penReported) this.armPenExpiry();
  }

  // ------------------------------------------------------------------ queries

  /** Pen mode now (applies the 30 min expiry). */
  get penMode(): boolean {
    return this.reportPen(this.pen.on(this.env.now()));
  }

  /** True while Space is held. */
  get spaceHeld(): boolean {
    return this.space;
  }

  get state(): ArbiterState {
    if (this.strokeC) return this.strokeErase ? 'erase' : 'draw';
    if (this.lassoC) return 'lasso';
    if (this.panC || this.twoNav || this.wheelNav || this.gNav) return 'navigate';
    let pending = this.pendTap;
    for (let i = 0; i < this.n; i++) {
      const r = this.cs[i].role;
      if (r === Role.PendSample) return 'sample';
      if (r !== Role.Ignore) pending = true;
    }
    return pending ? 'pending' : 'idle';
  }

  /**
   * What index.ts should read for moves of pointer `id`: 2 = stroke samples
   * (sanitised clock + prediction), 1 = positions, 0 = untracked (hover only).
   */
  wants(id: number): 0 | 1 | 2 {
    const c = this.find(id);
    if (!c) return 0;
    return c.role === Role.Stroke || c.role === Role.PendErase ? 2 : 1;
  }

  /** Whether a new contact of this device could become the stroke (decides whether its down sample joins the stroke clock). */
  mayStroke(device: Device): boolean {
    return !this.strokeC || (this.strokeC.device === 'touch' && device === 'pen');
  }

  // ------------------------------------------------------------------ commands

  /** Turn pen mode off until the next pen event. */
  disablePenMode(): void {
    this.pen.disable();
    this.clearPenTimer();
    this.reportPen(false);
  }

  setSpace(on: boolean): void {
    this.space = on;
  }

  /** Commit a deferred touch tap now (another gesture, a key or a UI press is starting). */
  flush(): void {
    if (!this.pendTap) return;
    this.pendTap = false;
    this.clearPendTimer();
    this.closeStroke('commit');
  }

  /** End everything as if every pointer was cancelled (blur, hidden page, dispose). */
  reset(): void {
    const now = this.env.now();
    while (this.n > 0) this.release(this.cs[this.n - 1], null, now, true);
    this.flush();
    this.endWheel();
    if (this.gNav) {
      this.gNav = false;
      this.sink.navEnd('pinch');
    }
    if (this.pen.penDown) this.pen.pen('cancel', now);
    this.tap.reset();
    this.sessionTwo = false;
    this.space = false;
    if (this.hovering) {
      this.hovering = false;
      this.sink.hover(null);
    }
  }

  /** reset() plus every timer cleared (the controller is going away). */
  dispose(): void {
    this.reset();
    this.clearPenTimer();
  }

  // ------------------------------------------------------------------ pointer events

  /** pointerdown. `s` is the down sample (reused by the caller). */
  down(p: PointerInfo, s: InputSample): void {
    const stale = this.find(p.id);
    if (stale) this.release(stale, null, p.t, true); // its pointerup was lost: finish it as cancelled
    if (p.device === 'pen') this.penEvent('down', p.t);
    if (p.device === 'touch') {
      this.touchDown(p, s);
      return;
    }
    if (this.busy()) {
      this.add(p, Role.Ignore);
      return;
    }
    this.flush();
    const pen = p.device === 'pen';
    const eraserEnd = pen && ((p.buttons & 32) !== 0 || p.button === 5);
    const barrel = pen && !eraserEnd && ((p.buttons & 2) !== 0 || p.button === 2);
    if (eraserEnd) this.beginStroke(this.add(p, Role.Stroke), s, true);
    else if (this.space && p.button === 0) this.beginPan(this.add(p, Role.Pan));
    else if (!pen && p.button === 1) this.beginPan(this.add(p, Role.Pan));
    else if (barrel || (!pen && p.button === 2)) {
      const c = this.add(p, Role.PendErase);
      c.barrel = barrel;
      c.air = barrel && !(p.pressure > 0);
      copySample(s, this.pendBegin);
    } else if (p.button !== 0) this.add(p, Role.Ignore);
    else if (p.mod) this.add(p, Role.PendSelect);
    else if (p.alt) this.add(p, Role.PendSample);
    else this.beginStroke(this.add(p, Role.Stroke), s, this.env.mode() === 'erase');
  }

  /** pointermove: `samples` are the event's coalesced samples in order (a chunk of them), `predicted` the predicted tail. */
  move(p: PointerInfo, samples: readonly InputSample[], predicted: readonly InputSample[]): void {
    const c = this.find(p.id);
    if (!c) return;
    if (p.device !== 'touch' && p.buttons === 0 && (p.device === 'mouse' || !(p.pressure > 0))) {
      // A mouse (or a pen with no pressure) moving with no buttons: its pointerup was lost.
      // Pens also need zero pressure, since some engines report buttons = 0 in contact.
      this.up(p, null);
      return;
    }
    if (p.device === 'pen') this.penEvent('move', p.t);
    const px = c.x, py = c.y;
    const n = samples.length;
    for (let i = 0; i < n; i++) this.track(c, samples[i].x, samples[i].y);
    if (n === 0) this.track(c, p.x, p.y);
    c.t = p.t;
    if (c.session) this.tap.move(c.dMax);

    switch (c.role) {
      case Role.Stroke:
        if (c.barrel && (p.buttons & 1) === 0 && !(p.pressure > 0)) {
          this.liftBarrel(c, samples); // the tip left the glass, the barrel is still held
          break;
        }
        if (n > 0) {
          this.sink.strokeMove(samples, predicted);
          copySample(samples[n - 1], this.lastOut);
        }
        break;
      case Role.PendErase:
        if (c.air) {
          this.land(c, samples);
          break;
        }
        if (c.dMax >= DRAG_SLOP) {
          c.role = Role.Stroke;
          this.beginStroke(c, this.pendBegin, true);
          if (n > 0) {
            this.sink.strokeMove(samples, predicted);
            copySample(samples[n - 1], this.lastOut);
          }
        }
        break;
      case Role.PendSelect:
        if (c.dMax >= DRAG_SLOP) {
          this.beginLasso(c, c.shift);
          this.lassoPoints(c, samples, 0);
        }
        break;
      case Role.PendSample:
        if (c.dMax >= DRAG_SLOP) c.role = Role.Ignore; // Alt-drag (duplicate) is P1
        break;
      case Role.Lasso:
        this.lassoPoints(c, samples, 0);
        break;
      case Role.Pan:
        if (c.x !== px || c.y !== py) this.sink.pan(c.x - px, c.y - py);
        break;
      case Role.Finger:
        if (p.radius > PALM_RADIUS) this.toPalm(c);
        else this.fingerMove(c, samples);
        break;
      case Role.DTap:
        if (c.dMax >= TAP_SLOP) {
          this.endPending('withdraw');
          this.beginLasso(c, false);
          this.lassoPoints(c, samples, 0);
        }
        break;
      case Role.Two:
        this.twoMove(c, px, py);
        break;
      default:
        break;
    }
  }

  /** pointerup. `s` is the up sample (reused by the caller), or null. */
  up(p: PointerInfo, s: InputSample | null): void {
    const c = this.find(p.id);
    if (!c) return;
    if (p.device === 'pen') this.penEvent('up', p.t);
    if (s) this.track(c, s.x, s.y);
    if (c.session) this.tap.move(c.dMax);
    this.release(c, s, p.t, false);
  }

  /** pointercancel (and lost capture). */
  cancel(p: PointerInfo): void {
    const c = this.find(p.id);
    if (!c) return;
    if (p.device === 'pen') this.penEvent('cancel', p.t);
    this.release(c, null, p.t, true);
  }

  /** A mouse / pen moving without contact. `s` supplies the pen angles. */
  hover(p: PointerInfo, s: InputSample): void {
    if (p.device === 'touch') return;
    if (p.device === 'pen') this.penEvent('hover', p.t);
    const h = this.hov;
    h.x = p.x;
    h.y = p.y;
    h.device = p.device;
    h.alt = s.alt;
    h.az = s.az;
    this.hovering = true;
    this.sink.hover(h);
  }

  /** pointerleave of a mouse / pen that is not in contact. */
  leave(p: PointerInfo): void {
    if (p.device === 'touch') return;
    if (p.device === 'pen') this.penEvent('leave', p.t);
    if (this.hovering) {
      this.hovering = false;
      this.sink.hover(null);
    }
  }

  // ------------------------------------------------------------------ wheel / Safari gestures

  /** One wheel event (DESIGN §5 "Wheel"). Ignored while a stroke or lasso holds the camera. */
  wheel(w: WheelInput): void {
    if (this.strokeC || this.lassoC) return;
    this.flush();
    const kind = classifyWheel(w, this.wheelState, w.t);
    if (kind === 'notch') {
      if (w.shiftKey && w.deltaX === 0) {
        if (w.deltaY !== 0) this.sink.pan(-wheelPixels(w.deltaY, w.deltaMode, w.pageW), 0);
      } else {
        const f = notchFactor(w.deltaY, w.deltaMode);
        if (f !== 1) this.sink.zoom(f, w.x, w.y);
        else if (w.deltaX !== 0) this.sink.pan(-wheelPixels(w.deltaX, w.deltaMode, w.pageW), 0);
      }
    } else if (kind === 'pinch') {
      this.lastCtrlWheel = w.t;
      const f = pinchFactor(wheelPixels(w.deltaY, w.deltaMode, w.pageH));
      if (f !== 1) this.sink.zoom(f, w.x, w.y);
    } else {
      const dx = -wheelPixels(w.deltaX, w.deltaMode, w.pageW), dy = -wheelPixels(w.deltaY, w.deltaMode, w.pageH);
      if (dx !== 0 || dy !== 0) this.sink.pan(dx, dy);
    }
    this.wheelNav = true;
    this.wheelLast = w.t;
    if (!this.wheelTimer) this.wheelTimer = this.env.setTimer(this.onWheelTimer, WHEEL_GAP_MS);
  }

  /**
   * Safari trackpad pinch (gesturestart/change/end; `scale` is cumulative). Used only
   * when no touch pointers are down (iOS reports touch pinches as pointers too) and no
   * ctrl+wheel pinch arrived recently (engines that send both).
   */
  gesture(phase: 'start' | 'change' | 'end', scale: number, x: number, y: number, t: number): void {
    if (phase === 'start') {
      this.gScale = 1;
      return;
    }
    if (phase === 'end') {
      if (this.gNav) {
        this.gNav = false;
        this.sink.navEnd('pinch');
      }
      return;
    }
    if (!(scale > 0)) return;
    const f = scale / this.gScale;
    this.gScale = scale;
    if (this.strokeC || this.lassoC || this.anyTouch() || t - this.lastCtrlWheel < 250 || f === 1) return;
    this.flush();
    this.gNav = true;
    this.sink.zoom(f, x, y);
  }

  // ------------------------------------------------------------------ internals: roles

  private touchDown(p: PointerInfo, s: InputSample): void {
    if (this.nonTouchActive()) {
      this.add(p, Role.Ignore); // a mouse / pen gesture owns the canvas
      return;
    }
    const penMode = this.reportPen(this.pen.on(p.t));
    if (penMode && this.pen.palm(p.t, p.radius) !== null) {
      this.add(p, Role.Ignore); // palm: not counted, not part of any tap
      return;
    }
    const others = this.sessionTouches();
    const c = this.add(p, Role.Ignore);
    c.session = true;
    this.tap.down(p.t);

    if (others === 0) {
      if (penMode) {
        c.role = Role.Finger;
        c.intent.start(p.t);
      } else if (this.pendTap && isDoubleTap(this.pendX, this.pendY, this.pendT, p.x, p.y, p.t)) {
        c.role = Role.DTap;
      } else {
        this.flush();
        c.role = Role.Stroke;
        this.beginStroke(c, s, this.env.mode() === 'erase');
      }
      return;
    }
    const other = others === 1 ? this.sessionTouch(c) : null;
    if (!other) return; // a third finger: ignored, but it still counts for the tap
    switch (other.role) {
      case Role.Stroke:
        if (p.t - other.t0 <= WITHDRAW_MS && other.dMax < WITHDRAW_TRAVEL) {
          this.strokeC = null;
          this.closeStroke('withdraw');
          this.startTwo(other, c, false, penMode);
        }
        break;
      case Role.DTap:
        this.flush();
        this.startTwo(other, c, false, penMode);
        break;
      case Role.Pan:
        this.panC = null;
        this.startTwo(other, c, true, penMode);
        break;
      case Role.Finger:
      case Role.Ignore:
        this.startTwo(other, c, false, penMode);
        break;
      default:
        break; // a finger lasso keeps the canvas
    }
  }

  private fingerMove(c: Contact, samples: readonly InputSample[]): void {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const v = c.intent.move(s.t, Math.hypot(s.x - c.x0, s.y - c.y0), this.pen.fingerPanAllowed(s.t));
      if (v === 'pending') continue;
      if (v === 'dead') {
        c.role = Role.Ignore;
        return;
      }
      if (v === 'pan') {
        c.role = Role.Pan;
        this.beginPan(c);
        this.env.onFingerPan?.();
        // Pan by the whole displacement so the canvas stays under the finger.
        this.sink.pan(c.x - c.x0, c.y - c.y0);
        return;
      }
      this.beginLasso(c, false);
      this.lassoPoints(c, samples, i);
      return;
    }
  }

  private startTwo(a: Contact, b: Contact, navigating: boolean, penMode: boolean): void {
    a.role = Role.Two;
    b.role = Role.Two;
    a.sx = a.x; a.sy = a.y; a.dTwo = 0;
    b.sx = b.x; b.sy = b.y; b.dTwo = 0;
    this.twoA = a;
    this.twoB = b;
    this.twoNav = navigating;
    this.twoPen = penMode;
    this.twoLead = navigating && penMode ? a : null;
    this.sessionTwo = true;
    this.two.start(a.x, a.y, b.x, b.y);
    // One gesture, one contact: if either finger already hides the chrome, both keep it hidden.
    if (a.counted || b.counted) {
      this.count(a);
      this.count(b);
    }
  }

  /** A move of `c` (previously at px, py), one of the two fingers. */
  private twoMove(c: Contact, px: number, py: number): void {
    const a = this.twoA, b = this.twoB;
    if (!a || !b) return;
    const slop = a.dTwo >= TAP_SLOP || b.dTwo >= TAP_SLOP || this.twoNav;
    const can = this.twoPen ? slop && a.dTwo >= PINCH_MOVE && b.dTwo >= PINCH_MOVE : slop;
    if (!can && this.twoLead && !this.two.engaged) {
      // Pen mode, a finger pan joined by a contact that has not moved yet (maybe a palm):
      // the panning finger keeps the canvas under it, and the pinch re-bases here so it
      // starts from where both have moved, without a jump.
      if (c === this.twoLead && (c.x !== px || c.y !== py)) this.sink.pan(c.x - px, c.y - py);
      this.two.start(a.x, a.y, b.x, b.y);
      return;
    }
    if (!this.two.update(a.x, a.y, b.x, b.y, can)) return;
    if (!this.twoNav) {
      this.twoNav = true;
      this.endWheel();
    }
    this.count(a);
    this.count(b);
    const o = this.two.out;
    if (o.dx !== 0 || o.dy !== 0) this.sink.pan(o.dx, o.dy);
    if (o.factor !== 1) this.sink.zoom(o.factor, o.cx, o.cy);
  }

  private release(c: Contact, s: InputSample | null, t: number, cancelled: boolean): void {
    let tapN = -1;
    if (c.session) {
      if (cancelled) this.tap.spoil();
      tapN = this.tap.up(t);
    }
    switch (c.role) {
      case Role.Stroke:
        this.releaseStroke(c, s, t, cancelled, tapN);
        break;
      case Role.PendSelect:
        if (!cancelled) this.sink.select(c.x0, c.y0, c.shift);
        break;
      case Role.PendSample:
        if (!cancelled) this.sink.sample(c.x0, c.y0);
        break;
      case Role.Lasso:
        this.lassoC = null;
        this.sink.lassoEnd();
        break;
      case Role.Pan:
        this.panC = null;
        this.sink.navEnd(this.navZoomed ? 'pinch' : 'drag');
        this.navZoomed = false;
        break;
      case Role.Finger:
        if (tapN === 1) this.sink.select(c.x0, c.y0, true);
        break;
      case Role.DTap:
        if (tapN === 1) {
          this.endPending('withdraw');
          this.sink.select(c.x0, c.y0, true);
        } else this.flush();
        break;
      case Role.Two:
        this.releaseTwo(c);
        break;
      default:
        break;
    }
    if (tapN === 2 && this.sessionTwo) this.sink.twoFingerTap();
    if (tapN >= 0) this.sessionTwo = false;
    this.uncount(c);
    this.remove(c);
  }

  private releaseStroke(c: Contact, s: InputSample | null, t: number, cancelled: boolean, tapN: number): void {
    this.strokeC = null;
    if (!cancelled && s && Math.hypot(s.x - this.lastOut.x, s.y - this.lastOut.y) >= 1) {
      // The lift point differs from the last move: append it (end flush). A pen reports
      // zero pressure at lift, which would fake a ramp-down, so it keeps the last pressure.
      const f = this.finalOne[0];
      copySample(s, f);
      if (c.device === 'pen' && !(f.p > 0)) f.p = this.lastOut.p;
      if (!(f.t > this.lastOut.t)) f.t = this.lastOut.t + 0.25;
      this.sink.strokeMove(this.finalOne, NONE);
      copySample(f, this.lastOut);
    }
    if (c.device !== 'touch') {
      this.closeStroke('commit');
      return;
    }
    if (cancelled) {
      this.closeStroke(t - c.t0 <= WITHDRAW_MS ? 'withdraw' : 'commit');
      return;
    }
    if (tapN === 1) {
      // Touch-only tap: defer the commit for the double-tap window.
      this.pendTap = true;
      this.pendX = c.x0;
      this.pendY = c.y0;
      this.pendT = t;
      this.clearPendTimer();
      this.pendTimer = this.env.setTimer(this.onPendTimeout, DOUBLE_TAP_MS);
      return;
    }
    this.closeStroke('commit');
  }

  private releaseTwo(c: Contact): void {
    const other = c === this.twoA ? this.twoB : this.twoA;
    const zoomed = this.navZoomed || this.two.zoomed;
    const nav = this.twoNav;
    // A contact that joined a finger pan and never moved (the both-moved gate stayed shut)
    // was never part of the navigation: it does not inherit the pan when the lead lifts.
    const inherits = this.two.engaged || other === this.twoLead;
    this.twoA = null;
    this.twoB = null;
    this.twoNav = false;
    this.twoLead = null;
    if (nav && this.twoPen && other && inherits) {
      // Pen mode: one finger pans, so the finger left on the glass keeps panning;
      // navEnd comes when it lifts and still reports the zoom for detent snapping.
      other.role = Role.Pan;
      this.panC = other;
      this.navZoomed = zoomed;
      return;
    }
    if (nav) this.sink.navEnd(zoomed ? 'pinch' : 'drag');
    this.navZoomed = false;
    if (other) other.role = Role.Ignore; // touch-only: the remaining finger never draws
  }

  // ------------------------------------------------------------------ internals: helpers

  private beginStroke(c: Contact, s: InputSample, erase: boolean): void {
    this.flush();
    if (this.strokeOpen) this.closeStroke('commit');
    this.endWheel();
    this.count(c);
    this.strokeC = c;
    this.strokeOpen = true;
    this.strokeErase = erase;
    copySample(s, this.lastOut);
    this.sink.strokeBegin(c.device, s, erase ? 'erase' : 'draw');
  }

  private closeStroke(how: 'commit' | 'withdraw'): void {
    if (!this.strokeOpen) return;
    this.strokeOpen = false;
    this.sink.strokeEnd(how);
  }

  private endPending(how: 'commit' | 'withdraw'): void {
    if (!this.pendTap) return;
    this.pendTap = false;
    this.clearPendTimer();
    this.closeStroke(how);
  }

  private clearPendTimer(): void {
    if (this.pendTimer) {
      this.env.clearTimer(this.pendTimer);
      this.pendTimer = 0;
    }
  }

  private readonly onPendTimeout = (): void => {
    this.pendTimer = 0;
    if (!this.pendTap) return;
    for (let i = 0; i < this.n; i++) if (this.cs[i].role === Role.DTap) return; // the second tap decides
    this.flush();
  };

  private beginLasso(c: Contact, add: boolean): void {
    this.endWheel();
    c.role = Role.Lasso;
    this.lassoC = c;
    this.count(c);
    this.sink.lassoBegin(c.x0, c.y0, add);
  }

  private lassoPoints(c: Contact, samples: readonly InputSample[], from: number): void {
    const n = samples.length;
    if (n === 0) this.sink.lassoMove(c.x, c.y);
    for (let i = from; i < n; i++) this.sink.lassoMove(samples[i].x, samples[i].y);
  }

  private beginPan(c: Contact): void {
    this.endWheel();
    this.panC = c;
    this.count(c);
  }

  private readonly onWheelTimer = (): void => {
    this.wheelTimer = 0;
    if (!this.wheelNav) return;
    const idle = this.env.now() - this.wheelLast;
    if (idle >= WHEEL_GAP_MS - 1) this.endWheel();
    else this.wheelTimer = this.env.setTimer(this.onWheelTimer, WHEEL_GAP_MS - idle);
  };

  private endWheel(): void {
    if (this.wheelTimer) {
      this.env.clearTimer(this.wheelTimer);
      this.wheelTimer = 0;
    }
    if (this.wheelNav) {
      this.wheelNav = false;
      this.sink.navEnd('wheel');
    }
  }

  private penEvent(kind: PenEventKind, t: number): void {
    this.pen.pen(kind, t);
    this.reportPen(true);
    this.armPenExpiry();
    if (kind === 'down') this.yieldTouches();
    else if (kind === 'hover' && this.tap.active) this.tap.spoil(); // a pending finger tap under a hovering pen is a palm
  }

  /**
   * One timer reports the 30 min pen-mode expiry when it happens (not at the next
   * touch), so AppState.penMode never goes stale. It is armed once and re-armed for
   * the remainder when it fires early, so pen events never touch timers.
   */
  private armPenExpiry(): void {
    if (this.penTimer) return;
    const left = this.pen.lastPenAt + PEN_EXPIRY_MS - this.env.now();
    this.penTimer = this.env.setTimer(this.onPenExpiry, Math.max(1000, left + 1));
  }

  private readonly onPenExpiry = (): void => {
    this.penTimer = 0;
    if (this.reportPen(this.pen.on(this.env.now()))) this.armPenExpiry();
  };

  private clearPenTimer(): void {
    if (this.penTimer) {
      this.env.clearTimer(this.penTimer);
      this.penTimer = 0;
    }
  }

  /**
   * Pen barrel pressed in the air: follow the pen until its tip lands (pressure > 0),
   * then measure the ≥ 4 sp erase travel from the landing sample, which also becomes
   * the stroke's first sample. The conversion waits for the next move, so every sample
   * the sink then receives is later than that first one.
   */
  private land(c: Contact, samples: readonly InputSample[]): void {
    const n = samples.length;
    if (n === 0) return;
    let k = 0;
    while (k < n && !(samples[k].p > 0)) k++;
    const a = samples[k < n ? k : n - 1];
    copySample(a, this.pendBegin);
    c.x0 = a.x;
    c.y0 = a.y;
    c.dMax = 0;
    if (k === n) return;
    c.air = false;
    for (let i = k + 1; i < n; i++) {
      const dx = samples[i].x - a.x, dy = samples[i].y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > c.dMax) c.dMax = d;
    }
  }

  /**
   * A barrel erase whose tip lifted while the barrel stays held (a pointermove, not a
   * pointerup): the in-contact samples still sweep, then the stroke commits and the
   * contact waits in the air again, so landing once more starts a new erase.
   */
  private liftBarrel(c: Contact, samples: readonly InputSample[]): void {
    const one = this.finalOne, n = samples.length;
    for (let i = 0; i < n && samples[i].p > 0; i++) {
      copySample(samples[i], one[0]);
      this.sink.strokeMove(one, NONE);
      copySample(samples[i], this.lastOut);
    }
    this.strokeC = null;
    this.closeStroke('commit');
    this.uncount(c);
    c.role = Role.PendErase;
    c.air = true;
    c.x0 = c.x;
    c.y0 = c.y;
    c.dMax = 0;
  }

  /** A pen-mode finger re-classified as a palm (its contact grew past the palm radius): it leaves every gesture. */
  private toPalm(c: Contact): void {
    c.role = Role.Ignore;
    if (!c.session) return;
    c.session = false;
    this.tap.spoil();
    this.tap.leave();
    if (!this.tap.active) this.sessionTwo = false;
  }

  /** All touches yield to a pen touching down (DESIGN §5: touches are ignored while the pen is down). */
  private yieldTouches(): void {
    let any = false;
    for (let i = 0; i < this.n; i++) {
      const c = this.cs[i];
      if (c.device !== 'touch') continue;
      any = true;
      switch (c.role) {
        case Role.Stroke:
          this.strokeC = null;
          this.closeStroke('withdraw');
          break;
        case Role.Lasso:
          this.lassoC = null;
          this.sink.lassoEnd();
          break;
        case Role.Pan:
          this.panC = null;
          this.sink.navEnd(this.navZoomed ? 'pinch' : 'drag');
          break;
        default:
          break;
      }
      // A palm from now on: out of the tap session, so it never blocks a later finger
      // tap (the session would not end while it rests) nor joins a two-finger gesture.
      c.role = Role.Ignore;
      c.session = false;
    }
    if (this.twoA) {
      if (this.twoNav) this.sink.navEnd(this.navZoomed || this.two.zoomed ? 'pinch' : 'drag');
      this.twoA = null;
      this.twoB = null;
      this.twoNav = false;
      this.twoLead = null;
    }
    this.navZoomed = false;
    if (any) {
      this.tap.reset();
      this.sessionTwo = false;
    }
    this.endPending('withdraw');
  }

  private reportPen(on: boolean): boolean {
    if (on !== this.penReported) {
      this.penReported = on;
      this.env.onPenMode?.(on);
    }
    return on;
  }

  private track(c: Contact, x: number, y: number): void {
    c.x = x;
    c.y = y;
    let dx = x - c.x0, dy = y - c.y0;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > c.dMax) c.dMax = d;
    if (c.role === Role.Two) {
      dx = x - c.sx;
      dy = y - c.sy;
      const d2 = Math.sqrt(dx * dx + dy * dy);
      if (d2 > c.dTwo) c.dTwo = d2;
    }
  }

  private count(c: Contact): void {
    if (c.counted) return;
    c.counted = true;
    if (this.counted++ === 0) this.sink.contact(true);
  }

  private uncount(c: Contact): void {
    if (!c.counted) return;
    c.counted = false;
    if (--this.counted === 0) this.sink.contact(false);
  }

  private add(p: PointerInfo, role: Role): Contact {
    let c = this.cs[this.n];
    if (!c) {
      c = new Contact();
      this.cs.push(c);
    }
    this.n++;
    c.id = p.id;
    c.device = p.device;
    c.role = role;
    c.x0 = c.x = c.sx = p.x;
    c.y0 = c.y = c.sy = p.y;
    c.t0 = c.t = p.t;
    c.dMax = 0;
    c.dTwo = 0;
    c.counted = false;
    c.session = false;
    c.air = false;
    c.barrel = false;
    c.shift = p.shift;
    return c;
  }

  private remove(c: Contact): void {
    const cs = this.cs, last = this.n - 1;
    for (let i = 0; i <= last; i++) {
      if (cs[i] !== c) continue;
      cs[i] = cs[last];
      cs[last] = c;
      this.n = last;
      return;
    }
  }

  private find(id: number): Contact | null {
    for (let i = 0; i < this.n; i++) if (this.cs[i].id === id) return this.cs[i];
    return null;
  }

  /** Some contact is doing (or deciding) something. Ignored contacts do not count. */
  private busy(): boolean {
    for (let i = 0; i < this.n; i++) if (this.cs[i].role !== Role.Ignore) return true;
    return false;
  }

  private nonTouchActive(): boolean {
    for (let i = 0; i < this.n; i++) {
      const c = this.cs[i];
      if (c.device !== 'touch' && c.role !== Role.Ignore) return true;
    }
    return false;
  }

  private anyTouch(): boolean {
    for (let i = 0; i < this.n; i++) if (this.cs[i].device === 'touch') return true;
    return false;
  }

  /** Number of touch contacts in the current tap session (palms excluded). */
  private sessionTouches(): number {
    let k = 0;
    for (let i = 0; i < this.n; i++) if (this.cs[i].session) k++;
    return k;
  }

  /** The first session touch other than `not`. */
  private sessionTouch(not: Contact): Contact | null {
    for (let i = 0; i < this.n; i++) {
      const c = this.cs[i];
      if (c.session && c !== not) return c;
    }
    return null;
  }
}
