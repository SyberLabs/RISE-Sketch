/** DESIGN §3.4 / §4 sheets: tiles, selection and recents, roving focus, placement, swipe. */
import { describe, it, expect } from 'vitest';
import type { ColorStyle } from '../src/core/types';
import { placement, rovingNext, swipeCloses, tileCols, tileSpecs } from '../src/ui/sheet';
import { state } from './ui.helpers';

const custom = (h: number): ColorStyle => ({ ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.8, 0.12, h], paper: [0.45, 0.12, h] } });

describe('tile specs', () => {
  it('Stroke: Pen · Brush · Chisel · Erase; only the active nib tile drags', () => {
    const t = tileSpecs('stroke', state());
    expect(t.map(x => x.label)).toEqual(['Pen', 'Brush', 'Chisel', 'Erase']);
    expect(t.filter(x => x.checked).map(x => x.key)).toEqual(['brush']);
    expect(t.filter(x => x.drag).map(x => x.key)).toEqual(['brush']);
    expect(t[1].aria).toBe('Brush, size 9. Drag up or down to resize.');
    expect(t[3].intent).toEqual({ k: 'pickErase' });
  });
  it('Stroke in erase mode: Erase is the checked tile and no nib drags', () => {
    const t = tileSpecs('stroke', state({ tool: { ...state().tool, mode: 'erase' } }));
    expect(t.filter(x => x.checked).map(x => x.key)).toEqual(['erase']);
    expect(t.some(x => x.drag)).toBe(false);
  });
  it('Color: 7 inks + 2 recents (≤ 9 tiles); empty recent slots are not controls', () => {
    const t = tileSpecs('color', state());
    expect(t.length).toBe(9);
    expect(t.slice(0, 7).map(x => x.label)).toEqual(['Graphite', 'Indigo', 'Oxide', 'Ochre', 'Moss', 'Rose', 'Spectral']);
    expect(t[7].intent).toBeNull();
    expect(t[7].opt).toBeNull();
    expect(t.filter(x => x.checked).map(x => x.key)).toEqual(['moss']);
  });
  it('Color: a custom ink checks its recent tile; with a selection slot 1 is the selection colour', () => {
    const a = custom(300), b = custom(40);
    const s = state({ tool: { ...state().tool, ink: 'custom', custom: b.lch, recents: [a, b] } });
    const t = tileSpecs('color', s);
    expect(t.filter(x => x.checked).map(x => x.key)).toEqual(['recent1']);
    expect(t[7].intent).toEqual({ k: 'pickCustom', color: a });
    expect(t[7].opt).toEqual({ k: 'ink', ink: 'custom', custom: a });
    const sel = tileSpecs('color', { ...s, selection: ['x'] });
    expect(sel[7].label).toBe('Selection');
    expect(sel[8].label).toBe('Recent');
  });
  it('Form: all eleven Forms, the first ten with their number keys (1–9, 0)', () => {
    const t = tileSpecs('form', state());
    expect(t.map(x => x.label)).toEqual(['Line', 'Echo', 'Sprout', 'Drift', 'Craze', 'Plume', 'Caustic', 'Burin', 'Plait', 'Orbit', 'Ripple']);
    expect(t.map(x => x.tip)).toEqual(['Line · 1', 'Echo · 2', 'Sprout · 3', 'Drift · 4', 'Craze · 5', 'Plume · 6', 'Caustic · 7', 'Burin · 8', 'Plait · 9', 'Orbit · 0', 'Ripple']);
    expect(t[9].intent).toEqual({ k: 'pickForm', form: 'orbit' });
    expect(t[2].checked).toBe(true);
    expect(t[0].intent).toEqual({ k: 'pickForm', form: 'line' });
  });
  it('every sheet stays within 9 tiles, except the eleven-Form sheet (accepted exception)', () => {
    for (const k of ['stroke', 'color'] as const) expect(tileSpecs(k, state()).length).toBeLessThanOrEqual(9);
    expect(tileSpecs('form', state()).length).toBe(11);
  });
});

describe('roving focus', () => {
  it('a single row: arrows step and wrap, Home / End jump', () => {
    expect(rovingNext(0, 4, 'ArrowRight', 4)).toBe(1);
    expect(rovingNext(3, 4, 'ArrowRight', 4)).toBe(0);
    expect(rovingNext(0, 4, 'ArrowLeft', 4)).toBe(3);
    expect(rovingNext(1, 4, 'ArrowDown', 4)).toBe(2);
    expect(rovingNext(1, 4, 'ArrowUp', 4)).toBe(0);
    expect(rovingNext(2, 4, 'Home', 4)).toBe(0);
    expect(rovingNext(0, 4, 'End', 4)).toBe(3);
    expect(rovingNext(0, 4, 'Enter', 4)).toBe(-1);
  });
  it('a grid: Up / Down move by a row and stop at the edges', () => {
    expect(rovingNext(1, 8, 'ArrowDown', 3)).toBe(4);
    expect(rovingNext(6, 8, 'ArrowDown', 3)).toBe(6);
    expect(rovingNext(4, 8, 'ArrowUp', 3)).toBe(1);
    expect(rovingNext(1, 8, 'ArrowUp', 3)).toBe(1);
  });
  it('phones use a grid, larger screens one row', () => {
    expect(tileCols('phone', 9)).toBe(3);
    expect(tileCols('phone', 4)).toBe(4);
    expect(tileCols('phone-landscape', 4)).toBe(2);
    expect(tileCols('desktop', 9)).toBe(9);
    expect(tileCols('tablet', 4)).toBe(4);
    // ten tiles: two rows of five on larger screens, the phone grid stays three wide (scrolls)
    expect(tileCols('desktop', 10)).toBe(5);
    expect(tileCols('tablet', 10)).toBe(5);
    expect(tileCols('phone', 10)).toBe(3);
    expect(tileCols('phone-landscape', 10)).toBe(3);
  });
});

describe('placement and swipe', () => {
  it('chip sheets grow out of the dock; phones get bottom / side sheets', () => {
    expect(placement('desktop', 'chip')).toBe('pop-dock');
    expect(placement('tablet', 'menu')).toBe('pop-menu');
    expect(placement('desktop', 'full')).toBe('center');
    expect(placement('phone', 'chip')).toBe('bottom');
    expect(placement('phone', 'full')).toBe('bottom');
    expect(placement('phone-landscape', 'menu')).toBe('side');
  });
  it('a swipe closes past a quarter of the sheet or when flicked', () => {
    expect(swipeCloses(120, 400, 380)).toBe(true);
    expect(swipeCloses(40, 400, 380)).toBe(false);
    expect(swipeCloses(40, 50, 380)).toBe(true);
    expect(swipeCloses(10, 5, 380)).toBe(false);
    expect(swipeCloses(-80, 100, 380)).toBe(false);
  });
});
