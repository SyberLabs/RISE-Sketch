/** DESIGN §3.4 / §2.2.1 / §2.3.1 / §2.4.1 chip amounts, keyboard path (§10) and labels. */
import { describe, it, expect } from 'vitest';
import {
  chipHoldLabel, chipLabel, chipTip, colorBend, DEAD_ZONE, depthDelta, fmtDepth, fmtSize, keyBend,
  keyBendAnnouncement, LONG_PRESS_MS, sizeFactor, TOOLTIP_MS,
} from '../src/ui/chip';
import { state } from './ui.helpers';

describe('chip amounts', () => {
  it('size: 60 px per doubling, up = larger', () => {
    expect(sizeFactor(0)).toBe(1);
    expect(sizeFactor(-60)).toBeCloseTo(2, 12);
    expect(sizeFactor(60)).toBeCloseTo(0.5, 12);
    expect(sizeFactor(-120)).toBeCloseTo(4, 12);
  });
  it('depth: −Δy/40 levels in quarter steps, never −0', () => {
    expect(depthDelta(-40)).toBe(1);
    expect(depthDelta(-50)).toBe(1.25);
    expect(depthDelta(30)).toBe(-0.75);
    expect(depthDelta(4)).toBe(0);
    expect(Object.is(depthDelta(4), -0)).toBe(false);
    for (let dy = -200; dy <= 200; dy += 7) expect(Number.isInteger(depthDelta(dy) * 4)).toBe(true);
  });
  it('colour: 0.75° per px of x, −0.002 L per px of y', () => {
    expect(colorBend(10, 0)).toEqual({ dh: 7.5, dL: 0 });
    expect(colorBend(0, -50).dL).toBeCloseTo(0.1, 12);
    expect(colorBend(0, 50).dL).toBeCloseTo(-0.1, 12);
  });
  it('gesture constants match the spec', () => {
    expect(DEAD_ZONE).toBe(6);
    expect(LONG_PRESS_MS).toBe(500);
    expect(TOOLTIP_MS).toBe(600);
  });
});

describe('keyboard path for chip drags', () => {
  it('one [ ] step, one quarter level, 5° / 0.02 L per press, each a complete bend', () => {
    expect(keyBend('stroke', 'ArrowUp')).toEqual({ k: 'bendSize', factor: 1.25, done: true });
    expect(keyBend('stroke', 'ArrowDown')).toEqual({ k: 'bendSize', factor: 0.8, done: true });
    expect(keyBend('form', 'ArrowUp')).toEqual({ k: 'bendDepth', delta: 0.25, done: true });
    expect(keyBend('form', 'ArrowDown')).toEqual({ k: 'bendDepth', delta: -0.25, done: true });
    expect(keyBend('color', 'ArrowRight')).toEqual({ k: 'bendColor', dh: 5, dL: 0, done: true });
    expect(keyBend('color', 'ArrowLeft')).toEqual({ k: 'bendColor', dh: -5, dL: 0, done: true });
    expect(keyBend('color', 'ArrowUp')).toEqual({ k: 'bendColor', dh: 0, dL: 0.02, done: true });
    expect(keyBend('color', 'ArrowDown')).toEqual({ k: 'bendColor', dh: 0, dL: -0.02, done: true });
  });
  it('only Color takes Left / Right; other keys are ignored', () => {
    expect(keyBend('stroke', 'ArrowLeft')).toBeNull();
    expect(keyBend('form', 'ArrowRight')).toBeNull();
    expect(keyBend('color', 'Enter')).toBeNull();
  });
  it('announces what changed, or the target rule with a selection', () => {
    const s = state({ tool: { ...state().tool, sizes: { pen: 2.5, brush: 11.25, chisel: 12, charcoal: 7 }, base: { ...state().tool.base, sprout: 2.25 } } });
    expect(keyBendAnnouncement('stroke', keyBend('stroke', 'ArrowUp')!, s)).toBe('Size 11');
    expect(keyBendAnnouncement('form', keyBend('form', 'ArrowUp')!, s)).toBe('Depth 2.25');
    expect(keyBendAnnouncement('color', keyBend('color', 'ArrowUp')!, s)).toBe('Lighter');
    const sel = state({ selection: ['a'] });
    expect(keyBendAnnouncement('form', keyBend('form', 'ArrowDown')!, sel)).toBe('Selection shallower');
  });
});

describe('chip labels (DESIGN §10)', () => {
  it('aria-label carries the state and the drag', () => {
    expect(chipLabel('form', state())).toBe('Form: Sprout, depth 2. Drag up or down to change depth.');
    expect(chipLabel('stroke', state())).toBe('Stroke: Brush, size 9. Drag up or down to change size.');
    expect(chipLabel('color', state({ ground: 'paper' }))).toMatch(/^Color: Moss on Paper\. Drag sideways for hue, up or down for tone/);
  });
  it('says when the drag targets the selection', () => {
    expect(chipLabel('form', state({ selection: ['a'] }))).toContain("change the selection's depth");
  });
  it('erase mode: the chip returns to the last nib', () => {
    const s = state({ tool: { ...state().tool, mode: 'erase', lastNib: 'chisel' } });
    expect(chipLabel('stroke', s)).toBe('Stroke: Erase mode. Tap to return to Chisel.');
    expect(chipTip('stroke', s)).toContain('tap to return');
  });
  it('tooltips include the shortcut and the drag; long-press names the drag', () => {
    expect(chipTip('form', state())).toBe('Form · Sprout · 1–4 · drag ↕ to deepen');
    expect(chipTip('stroke', state())).toBe('Stroke · Brush · B · drag ↕ to resize');
    expect(chipHoldLabel('form')).toBe('Form · drag ↕ to deepen');
  });
  it('formats sizes and depths without noise', () => {
    expect(fmtSize(2.5)).toBe('2.5');
    expect(fmtSize(0.75)).toBe('0.8');
    expect(fmtSize(9)).toBe('9');
    expect(fmtSize(17.6)).toBe('18');
    expect(fmtDepth(2)).toBe('2');
    expect(fmtDepth(2.75)).toBe('2.75');
    expect(fmtDepth(1.3)).toBe('1.25');
  });
});
