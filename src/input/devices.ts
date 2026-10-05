/**
 * Device class, pen mode and palm rules (DESIGN §5 "Pen mode and palms").
 * Pure: times are event-clock ms (e.timeStamp, the performance.now() clock),
 * radii are CSS px. index.ts persists the last pen time across reloads.
 */
import type { Device } from '../core/types';

/** Pen mode expires after 30 minutes with no pen event. */
export const PEN_EXPIRY_MS = 30 * 60 * 1000;
/** Contacts with a radius above this (sp) are palms. */
export const PALM_RADIUS = 20;
/** Touches are ignored while the pen is down and for this long after it lifts. */
export const AFTER_PEN_MS = 300;
/** A pen-mode finger pan needs no pen contact or hover in the last 500 ms. */
export const PEN_RECENT_MS = 500;
/**
 * A pen counts as hovering while hover events keep arriving within this window and
 * no leave was seen. Leave events can be lost (pen lifted out of range quickly), so
 * a stale hover must expire rather than block every touch forever.
 */
export const HOVER_FRESH_MS = 500;

/** Device class of a PointerEvent.pointerType ('' and unknown types act as a mouse). */
export function deviceOf(pointerType: string): Device {
  return pointerType === 'pen' ? 'pen' : pointerType === 'touch' ? 'touch' : 'mouse';
}

export type PenEventKind = 'down' | 'move' | 'hover' | 'up' | 'leave' | 'cancel';
export type PalmVerdict = 'radius' | 'hover' | 'penDown' | 'afterPen' | null;

/**
 * Pen mode as a pure state machine.
 *  - The first pen event turns it on; it expires 30 min after the last pen event.
 *  - `disable()` turns it off until the next pen event ("Draw with fingers").
 *  - `palm()` applies the ignored-contact rules to a touch beginning at t.
 */
export class PenMode {
  private active = false;
  private lastPen = -Infinity;
  private down = false;
  private upAt = -Infinity;
  private hoverAt = -Infinity;
  private hoverLive = false;

  /** `lastPen`: event-clock time of the last pen event of a previous session (persisted), if any. */
  constructor(lastPen?: number) {
    if (lastPen !== undefined && Number.isFinite(lastPen)) {
      this.lastPen = lastPen;
      this.active = true;
    }
  }

  /** Time of the last pen event (event clock), -Infinity if none. */
  get lastPenAt(): number {
    return this.lastPen;
  }

  /** Whether the pen tip is down. */
  get penDown(): boolean {
    return this.down;
  }

  /** Record a pen event at t. Returns true when this turned pen mode on. */
  pen(kind: PenEventKind, t: number): boolean {
    const was = this.active;
    this.active = true;
    if (t > this.lastPen || !Number.isFinite(this.lastPen)) this.lastPen = t;
    switch (kind) {
      case 'down':
        this.down = true;
        this.hoverLive = false;
        break;
      case 'move':
        break;
      case 'hover':
        // A hover sample means the tip is up, even if the pointerup was lost.
        if (this.down) this.upAt = t;
        this.down = false;
        this.hoverAt = t;
        this.hoverLive = true;
        break;
      case 'up':
      case 'cancel':
        if (this.down) this.upAt = t;
        this.down = false;
        break;
      case 'leave':
        this.hoverLive = false;
        break;
    }
    return !was;
  }

  /** Pen mode at time t (applies the 30 min expiry). */
  on(t: number): boolean {
    if (this.active && !this.down && t - this.lastPen > PEN_EXPIRY_MS) this.active = false;
    return this.active;
  }

  /** Off until the next pen event. Returns true if it was on. */
  disable(): boolean {
    const was = this.active;
    this.active = false;
    return was;
  }

  /** Whether the pen is hovering at t. */
  hovering(t: number): boolean {
    return this.hoverLive && t - this.hoverAt <= HOVER_FRESH_MS;
  }

  /**
   * Palm rules for a touch contact beginning at t with radius r (CSS px; NaN = unknown).
   * Only meaningful in pen mode. Returns the reason to ignore it, or null to accept.
   */
  palm(t: number, r: number): PalmVerdict {
    if (r > PALM_RADIUS) return 'radius';
    if (this.down) return 'penDown';
    if (t - this.upAt < AFTER_PEN_MS) return 'afterPen';
    if (this.hovering(t)) return 'hover';
    return null;
  }

  /** A pen-mode finger may start a pan: no pen contact or hover in the last 500 ms. */
  fingerPanAllowed(t: number): boolean {
    if (this.down) return false;
    return t - Math.max(this.upAt, this.hoverAt) > PEN_RECENT_MS;
  }
}
