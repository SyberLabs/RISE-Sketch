import { describe, it, expect } from 'vitest';
import {
  PenMode, deviceOf, PEN_EXPIRY_MS, AFTER_PEN_MS, PEN_RECENT_MS, PALM_RADIUS, HOVER_FRESH_MS,
} from '../src/input/devices';

describe('deviceOf', () => {
  it('maps pointer types', () => {
    expect(deviceOf('pen')).toBe('pen');
    expect(deviceOf('touch')).toBe('touch');
    expect(deviceOf('mouse')).toBe('mouse');
    expect(deviceOf('')).toBe('mouse');
    expect(deviceOf('kinect')).toBe('mouse');
  });
});

describe('PenMode', () => {
  it('starts off and turns on with the first pen event of any kind', () => {
    const m = new PenMode();
    expect(m.on(0)).toBe(false);
    expect(m.pen('hover', 10)).toBe(true);
    expect(m.on(10)).toBe(true);
    expect(m.pen('hover', 20)).toBe(false); // already on
  });

  it('expires 30 minutes after the last pen event', () => {
    const m = new PenMode();
    m.pen('down', 0);
    m.pen('up', 100);
    expect(m.on(100 + PEN_EXPIRY_MS)).toBe(true);
    expect(m.on(100 + PEN_EXPIRY_MS + 1)).toBe(false);
    expect(m.pen('hover', 100 + PEN_EXPIRY_MS + 2)).toBe(true);
  });

  it('never expires while the pen is down', () => {
    const m = new PenMode();
    m.pen('down', 0);
    expect(m.on(PEN_EXPIRY_MS * 2)).toBe(true);
  });

  it('is restored from a previous session and still expires', () => {
    const m = new PenMode(-1000);
    expect(m.on(0)).toBe(true);
    expect(m.on(PEN_EXPIRY_MS - 1000 + 1)).toBe(false);
    expect(new PenMode(undefined).on(0)).toBe(false);
    expect(new PenMode(NaN).on(0)).toBe(false);
  });

  it('disable() turns it off until the next pen event', () => {
    const m = new PenMode();
    m.pen('up', 0);
    expect(m.disable()).toBe(true);
    expect(m.on(1)).toBe(false);
    expect(m.disable()).toBe(false);
    expect(m.pen('hover', 2)).toBe(true);
    expect(m.on(3)).toBe(true);
  });

  it('palm rules: radius, pen down, 300 ms after lift, hover', () => {
    const m = new PenMode();
    expect(m.palm(0, PALM_RADIUS + 0.5)).toBe('radius');
    expect(m.palm(0, PALM_RADIUS)).toBe(null);
    expect(m.palm(0, NaN)).toBe(null);
    m.pen('down', 100);
    expect(m.palm(150, 5)).toBe('penDown');
    m.pen('up', 200);
    expect(m.palm(200 + AFTER_PEN_MS - 1, 5)).toBe('afterPen');
    expect(m.palm(200 + AFTER_PEN_MS, 5)).toBe(null);
    m.pen('hover', 1000);
    expect(m.palm(1100, 5)).toBe('hover');
    m.pen('leave', 1150);
    expect(m.palm(1160, 5)).toBe(null);
  });

  it('a stale hover (lost pointerleave) stops blocking touches', () => {
    const m = new PenMode();
    m.pen('hover', 0);
    expect(m.hovering(HOVER_FRESH_MS)).toBe(true);
    expect(m.hovering(HOVER_FRESH_MS + 1)).toBe(false);
    expect(m.palm(HOVER_FRESH_MS + 1, 5)).toBe(null);
  });

  it('a hover sample after a lost pointerup lifts the pen', () => {
    const m = new PenMode();
    m.pen('down', 0);
    m.pen('hover', 50);
    expect(m.penDown).toBe(false);
    expect(m.palm(60, 5)).toBe('afterPen');
  });

  it('finger pans need no pen contact or hover in the last 500 ms', () => {
    const m = new PenMode();
    expect(m.fingerPanAllowed(0)).toBe(true);
    m.pen('down', 0);
    expect(m.fingerPanAllowed(10_000)).toBe(false);
    m.pen('up', 1000);
    expect(m.fingerPanAllowed(1000 + PEN_RECENT_MS)).toBe(false);
    expect(m.fingerPanAllowed(1000 + PEN_RECENT_MS + 1)).toBe(true);
    m.pen('hover', 3000);
    m.pen('leave', 3010);
    expect(m.fingerPanAllowed(3400)).toBe(false);
    expect(m.fingerPanAllowed(3501)).toBe(true);
  });
});
