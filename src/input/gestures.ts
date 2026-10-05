/**
 * Pure gesture classifiers (DESIGN §5 "Rules shared by every input", touch and
 * pen-device rows, §3.4 select table). No DOM: times are event-clock ms
 * (`e.timeStamp`), positions are viewport CSS px (= sp for gesture measures).
 * Every class here is reused across gestures, so classifying allocates nothing.
 */

/** A tap: every contact goes down and up within this window... */
export const TAP_MS = 250;
/** ...and each moves less than this (px) from where it went down. */
export const TAP_SLOP = 10;
/** Touch-only: a second finger this soon after the first withdraws the stroke... */
export const WITHDRAW_MS = 150;
/** ...provided the first finger has travelled less than this (px). */
export const WITHDRAW_TRAVEL = 20;
/**
 * Touch-only double-tap: the second tap must go down within this long after the
 * first tap lifted, and within DOUBLE_TAP_DIST px of it. Spec leaves both open;
 * 300 ms / 24 px keeps a deliberate double-tap easy without eating fast stippling.
 */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DIST = 24;
/** Two-finger gestures ignore scale changes below 4 %. */
export const PINCH_DEAD = 0.04;
/** Pen mode: a contact counts as "moved" for the both-moved pinch rule past this (px). */
export const PINCH_MOVE = 4;
/** Pen mode: a finger pans only after > 12 sp of motion within 250 ms. */
export const FINGER_PAN_DIST = 12;
export const FINGER_PAN_MS = 250;
/** Pen mode: a finger held still (< TAP_SLOP) this long, then dragged, lassos. */
export const HOLD_LASSO_MS = 350;
/** Pen mode: drag distance after the hold that starts the lasso (px). */
export const LASSO_START = 4;
/**
 * Mouse / desktop pen: travel that turns a press into a drag (right-drag erase,
 * Mod-drag lasso, Alt-drag). DESIGN §5 fixes it at ≥ 4 sp for right-drag; the same
 * value is used for Mod and Alt so a click is a click on every button.
 */
export const DRAG_SLOP = 4;

/**
 * Tap classification over one touch session: from the first contact down to the
 * last contact up. Classified at release by the maximum number of simultaneous
 * contacts (DESIGN §5).
 */
export class TapSession {
  active = false;
  t0 = 0;
  count = 0;
  max = 0;
  moved = false;

  /** A contact went down at t. */
  down(t: number): void {
    if (!this.active) {
      this.active = true;
      this.t0 = t;
      this.count = 0;
      this.max = 0;
      this.moved = false;
    }
    this.count++;
    if (this.count > this.max) this.max = this.count;
  }

  /** A contact of this session has moved `d` px (max displacement) from its down point. */
  move(d: number): void {
    if (d >= TAP_SLOP) this.moved = true;
  }

  /** Disqualify the session as a tap (cancel, palm takeover). */
  spoil(): void {
    this.moved = true;
  }

  /** A contact left the session without lifting (re-classified as a palm); the session ends with its last contact. */
  leave(): void {
    if (!this.active) return;
    if (--this.count <= 0) {
      this.active = false;
      this.count = 0;
    }
  }

  /**
   * A contact lifted at t. Returns -1 while other contacts remain; otherwise the
   * session ends and the result is the tap's finger count, or 0 if it was no tap.
   */
  up(t: number): number {
    if (!this.active) return 0;
    if (--this.count > 0) return -1;
    this.active = false;
    this.count = 0;
    return !this.moved && t - this.t0 <= TAP_MS ? this.max : 0;
  }

  reset(): void {
    this.active = false;
    this.count = 0;
    this.max = 0;
    this.moved = false;
  }
}

/** Whether a contact going down at (x, y, t) is the second tap of a double-tap whose first tap lifted at (px, py, pt). */
export function isDoubleTap(px: number, py: number, pt: number, x: number, y: number, t: number): boolean {
  const dt = t - pt;
  if (!(dt >= 0 && dt <= DOUBLE_TAP_MS)) return false;
  const dx = x - px, dy = y - py;
  return dx * dx + dy * dy <= DOUBLE_TAP_DIST * DOUBLE_TAP_DIST;
}

export type FingerVerdict = 'pending' | 'pan' | 'lasso' | 'dead';

/**
 * Pen-mode one-finger classifier (DESIGN §5 pen device row, §3.4 pen-mode select):
 *  - > 12 sp within 250 ms              -> pan (or dead if the pen was active in the last 500 ms)
 *  - still (< 10 px) for 350 ms, dragged -> lasso
 *  - anything else that moves            -> dead (a drifting palm or an undecided touch)
 *  - lifted as a tap                     -> select (decided by TapSession, not here)
 * Fed every coalesced sample in order; a still finger sends no events, so the hold
 * is judged lazily at the first sample that moves.
 */
export class FingerIntent {
  private t0 = 0;
  private still = 0; // max displacement observed during the hold window

  start(t0: number): void {
    this.t0 = t0;
    this.still = 0;
  }

  /** One sample at time t, displacement d from the down point; panAllowed = no pen activity in the last 500 ms. */
  move(t: number, d: number, panAllowed: boolean): FingerVerdict {
    const el = t - this.t0;
    if (el < HOLD_LASSO_MS && d > this.still) this.still = d;
    if (el <= FINGER_PAN_MS && d > FINGER_PAN_DIST) return panAllowed ? 'pan' : 'dead';
    if (el < HOLD_LASSO_MS) return this.still >= TAP_SLOP && el > FINGER_PAN_MS ? 'dead' : 'pending';
    if (this.still >= TAP_SLOP) return 'dead';
    return d >= LASSO_START ? 'lasso' : 'pending';
  }
}

/** Output of TwoFinger.update (reused). */
export interface NavStep {
  dx: number; dy: number;   // centroid motion since the last step, CSS px
  factor: number;           // zoom factor about (cx, cy); 1 = none
  cx: number; cy: number;   // current centroid
}

/**
 * Two-finger pan + pinch (DESIGN §5): pan follows the centroid; zoom follows the
 * finger distance once it has changed by more than 4 % (then stays engaged for the
 * rest of the gesture). The dead-zone boundary becomes the zoom reference, so
 * engaging never jumps. Callers apply `pan(dx, dy)` then `zoom(factor, cx, cy)`,
 * which keeps the doc point under the centroid fixed.
 *
 * Browsers deliver one pointermove per finger, so between the two events of a frame
 * the distance is momentarily wrong (one finger moved, the other not yet): a fast
 * two-finger pan would cross the dead zone on that half-updated state. Zoom therefore
 * engages only when two consecutive updates exceed the dead zone in the same
 * direction; half-frame artefacts alternate and never qualify, while a real pinch
 * (or an anchored one-finger pinch) does on its next event.
 */
export class TwoFinger {
  readonly out: NavStep = { dx: 0, dy: 0, factor: 1, cx: 0, cy: 0 };
  engaged = false;
  /** True once the 4 % dead zone was exceeded (navEnd reports 'pinch' instead of 'drag'). */
  zoomed = false;
  private lcx = 0;
  private lcy = 0;
  private d0 = 1;
  private dPrev = 1;
  private over = 0; // direction (±1) in which the previous update exceeded the dead zone, else 0

  start(ax: number, ay: number, bx: number, by: number): void {
    this.engaged = false;
    this.zoomed = false;
    this.over = 0;
    this.lcx = (ax + bx) / 2;
    this.lcy = (ay + by) / 2;
    this.d0 = Math.max(1, Math.hypot(bx - ax, by - ay));
    this.dPrev = this.d0;
  }

  /**
   * New finger positions. `canEngage` gates the start of navigation (tap slop /
   * both-moved rule, decided by the caller). Returns true when `out` holds a step to apply.
   */
  update(ax: number, ay: number, bx: number, by: number, canEngage: boolean): boolean {
    if (!this.engaged) {
      if (!canEngage) return false;
      this.engaged = true;
    }
    const cx = (ax + bx) / 2, cy = (ay + by) / 2;
    const d = Math.max(1, Math.hypot(bx - ax, by - ay));
    let f = 1;
    if (!this.zoomed) {
      const r = d / this.d0;
      const dir = r > 1 + PINCH_DEAD ? 1 : r < 1 - PINCH_DEAD ? -1 : 0;
      if (dir !== 0 && dir === this.over) {
        this.zoomed = true;
        this.dPrev = this.d0 * (1 + dir * PINCH_DEAD);
      }
      this.over = dir;
    }
    if (this.zoomed) {
      f = d / this.dPrev;
      this.dPrev = d;
    }
    const o = this.out;
    o.dx = cx - this.lcx;
    o.dy = cy - this.lcy;
    o.factor = f;
    o.cx = cx;
    o.cy = cy;
    this.lcx = cx;
    this.lcy = cy;
    return o.dx !== 0 || o.dy !== 0 || f !== 1;
  }
}
