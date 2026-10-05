import { describe, it, expect } from 'vitest';
import {
  classifyWheel, createWheelState, isNotchEvent, notchFactor, pinchFactor, wheelPixels, WHEEL_GAP_MS, NOTCH_ZOOM, LINE_PX,
} from '../src/input/wheel';

const ev = (deltaY: number, o: Partial<{ deltaX: number; deltaMode: number; ctrlKey: boolean }> = {}) =>
  ({ deltaX: 0, deltaMode: 0, ctrlKey: false, ...o, deltaY });

describe('notch detection', () => {
  it('deltaMode lines or pages is a notch', () => {
    expect(isNotchEvent(ev(3, { deltaMode: 1 }))).toBe(true);
    expect(isNotchEvent(ev(0.5, { deltaMode: 1 }))).toBe(true);
    expect(isNotchEvent(ev(1, { deltaMode: 2 }))).toBe(true);
  });
  it('integer |Δy| ≥ 50 with Δx = 0 is a notch', () => {
    expect(isNotchEvent(ev(100))).toBe(true);
    expect(isNotchEvent(ev(-120))).toBe(true);
    expect(isNotchEvent(ev(50))).toBe(true);
    expect(isNotchEvent(ev(49))).toBe(false);
    expect(isNotchEvent(ev(100.5))).toBe(false);
    expect(isNotchEvent(ev(100, { deltaX: 1 }))).toBe(false);
    expect(isNotchEvent(ev(4))).toBe(false);
  });
});

describe('classifyWheel', () => {
  it('a burst keeps the class of its first event', () => {
    const s = createWheelState();
    expect(classifyWheel(ev(100), s, 0)).toBe('notch');
    expect(classifyWheel(ev(3.25), s, 100)).toBe('notch');
    expect(classifyWheel(ev(7), s, 100 + WHEEL_GAP_MS - 1)).toBe('notch');
    // a 400 ms gap starts a new burst, classified afresh
    expect(classifyWheel(ev(7), s, 100 + 2 * WHEEL_GAP_MS)).toBe('scroll');
    expect(classifyWheel(ev(100), s, 100 + 2 * WHEEL_GAP_MS + 10)).toBe('scroll');
  });

  it('trackpad bursts split into pinch (ctrlKey) and scroll per event', () => {
    const s = createWheelState();
    expect(classifyWheel(ev(2.5, { ctrlKey: true }), s, 0)).toBe('pinch');
    expect(classifyWheel(ev(1.5), s, 16)).toBe('scroll');
    expect(classifyWheel(ev(-3, { ctrlKey: true }), s, 32)).toBe('pinch');
  });

  it('Ctrl + mouse wheel stays a notch', () => {
    const s = createWheelState();
    expect(classifyWheel(ev(100, { ctrlKey: true }), s, 0)).toBe('notch');
  });

  it('laptop users switching device between bursts are reclassified', () => {
    const s = createWheelState();
    expect(classifyWheel(ev(2), s, 0)).toBe('scroll');
    expect(classifyWheel(ev(-100), s, 1000)).toBe('notch');
    expect(classifyWheel(ev(2), s, 2000)).toBe('scroll');
  });

  it('a horizontal-only first event is a trackpad scroll', () => {
    const s = createWheelState();
    expect(classifyWheel(ev(0, { deltaX: 100 }), s, 0)).toBe('scroll');
  });
});

describe('factors', () => {
  it('one notch zooms ×1.15 at the cursor, down = out', () => {
    expect(notchFactor(-100, 0)).toBeCloseTo(NOTCH_ZOOM, 12);
    expect(notchFactor(100, 0)).toBeCloseTo(1 / NOTCH_ZOOM, 12);
    expect(notchFactor(120, 0)).toBeCloseTo(1 / NOTCH_ZOOM, 12);
    expect(notchFactor(200, 0)).toBeCloseTo(1 / (NOTCH_ZOOM * NOTCH_ZOOM), 12);
    expect(notchFactor(3, 1)).toBeCloseTo(1 / NOTCH_ZOOM, 12);
    expect(notchFactor(1, 1)).toBeCloseTo(1 / NOTCH_ZOOM, 12); // a line event is at least one notch
    expect(notchFactor(1, 2)).toBeCloseTo(1 / NOTCH_ZOOM, 12);
    expect(notchFactor(0, 0)).toBe(1);
  });
  it('high-resolution wheels zoom fractionally', () => {
    expect(notchFactor(20, 0)).toBeCloseTo(Math.pow(NOTCH_ZOOM, -0.2), 12);
  });
  it('pinch zooms by exp(−Δy·0.012), clamped', () => {
    expect(pinchFactor(10)).toBeCloseTo(Math.exp(-0.12), 12);
    expect(pinchFactor(-10)).toBeCloseTo(Math.exp(0.12), 12);
    expect(pinchFactor(1e6)).toBe(0.25);
    expect(pinchFactor(-1e6)).toBe(4);
  });
  it('wheel deltas convert to px', () => {
    expect(wheelPixels(3, 0, 800)).toBe(3);
    expect(wheelPixels(3, 1, 800)).toBe(3 * LINE_PX);
    expect(wheelPixels(1, 2, 800)).toBe(800);
  });
});
