/**
 * Review regressions for the ui group: degenerate inputs from the app (NaN zoom / progress /
 * dates), layout-map key labels, the erase-mode Stroke chip, tile option equality, hint texts
 * per device, and the announcer's quiet idle.
 */
import { describe, it, expect } from 'vitest';
import type { ColorStyle } from '../src/core/types';
import { createAnnouncer } from '../src/ui/announce';
import { chipBends, chipHoldLabel, keyBend } from '../src/ui/chip';
import { createFader, viewChipWanted, visibleControls, zoomPct } from '../src/ui/dock';
import { keyLabel, keyRows } from '../src/ui/help';
import { defaultHintText } from '../src/ui/hints';
import { clamp01 } from '../src/ui/index';
import { formatWhen, strokeCount } from '../src/ui/recent';
import { sameOpt, tileSpecs } from '../src/ui/sheet';
import { TOAST_MS, toastDuration } from '../src/ui/toast';
import { viewChipModel } from '../src/ui/viewchip';
import { fakeTimers, state } from './ui.helpers';

const custom = (h: number): ColorStyle => ({ ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.8, 0.12, h], paper: [0.45, 0.12, h] } });

describe('degenerate values from the app never reach the screen', () => {
  it('a missing or bad zoom reads as 100 %: no view chip, no "NaN%"', () => {
    expect(zoomPct(NaN)).toBe(100);
    expect(zoomPct(Infinity)).toBe(100);
    expect(zoomPct(0)).toBe(100);
    expect(zoomPct(-50)).toBe(100);
    expect(zoomPct(139.6)).toBe(140);
    expect(viewChipWanted({ zoom: NaN, hasInk: true, inkInView: true })).toBe(false);
    expect(visibleControls(state({ zoom: NaN, hasInk: true, canUndo: true }))).not.toContain('view');
    const m = viewChipModel({ zoom: NaN, hasInk: true, inkInView: false, inkDirection: NaN });
    expect(m.text).toBeNull();
    expect(m.arrow).toBeNull();
    expect(m.lost).toBe(true);
    expect(m.label).not.toMatch(/NaN/);
  });
  it('a progress toast whose value is not a finished 1 stays; a bad duration falls back to 6 s', () => {
    expect(toastDuration({ progress: NaN })).toBeNull();
    expect(toastDuration({ progress: 0 })).toBeNull();
    expect(toastDuration({ progress: 1.2 })).toBe(TOAST_MS);
    expect(toastDuration({ ms: NaN })).toBe(TOAST_MS);
    expect(toastDuration({ ms: 0 })).toBe(TOAST_MS);
    expect(toastDuration({ ms: -5 })).toBe(TOAST_MS);
    expect(toastDuration({ ms: 1500 })).toBe(1500);
  });
  it('clamp01 for progress bars: NaN reads as 0', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(7)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
  });
  it('Recent never prints "Invalid Date" or "NaN strokes"', () => {
    expect(formatWhen(NaN, Date.now())).toBe('');
    expect(formatWhen(Date.now(), NaN)).toBe('');
    expect(formatWhen(Date.now(), Date.now())).toMatch(/^Today, /);
    expect(strokeCount(NaN)).toBe('0 strokes');
    expect(strokeCount(-3)).toBe('0 strokes');
    expect(strokeCount(1.2)).toBe('1 stroke');
    expect(strokeCount(0)).toBe('0 strokes');
  });
});

describe('help key labels', () => {
  it('upper-cases a keycap only when it stays one character', () => {
    const de = new Map([['Minus', 'ß'], ['KeyA', 'a'], ['Equal', '´'], ['BracketLeft', 'ü'], ['Slash', '-']]);
    expect(keyLabel('Minus', de)).toBe('ß'); // not "SS"
    expect(keyLabel('KeyA', de)).toBe('A');
    expect(keyLabel('Equal', de)).toBe('´');
    expect(keyLabel('BracketLeft', de)).toBe('Ü');
    expect(keyLabel('Slash', de)).toBe('−');
    expect(keyLabel('Unidentified')).toBe('Unidentified');
  });
  it('the key list follows the layout map (QWERTZ: the physical Z key is labelled Y)', () => {
    const de = new Map([['KeyZ', 'y'], ['KeyY', 'z']]);
    const keys = keyRows(false, c => keyLabel(c, de)).flatMap(r => r.keys);
    expect(keys).toContain('Ctrl+Y'); // undo: e.code KeyZ
    expect(keys).toContain('Ctrl+Z'); // redo: e.code KeyY
  });
});

describe('the Stroke chip in erase mode', () => {
  const erase = state({ tool: { ...state().tool, mode: 'erase' } });
  it('bends nothing (the eraser radius is fixed) while the other chips still bend', () => {
    expect(chipBends('stroke', erase)).toBe(false);
    expect(chipBends('stroke', state())).toBe(true);
    expect(chipBends('form', erase)).toBe(true);
    expect(chipBends('color', erase)).toBe(true);
    expect(keyBend('stroke', 'ArrowUp')).not.toBeNull(); // the key maps; the chip gates it on chipBends
  });
  it('its long-press names the one-tap return instead of a drag', () => {
    expect(chipHoldLabel('stroke', true)).toBe('Erase · tap to return');
    expect(chipHoldLabel('stroke')).toBe('Stroke · drag ↕ to resize');
    expect(chipHoldLabel('form', true)).toBe('Form · drag ↕ to deepen');
  });
});

describe('tile option equality (decides which sheet tiles re-render)', () => {
  it('compares kinds and their fields, custom inks by value', () => {
    expect(sameOpt(null, null)).toBe(true);
    expect(sameOpt({ k: 'nib', nib: 'pen' }, { k: 'nib', nib: 'pen' })).toBe(true);
    expect(sameOpt({ k: 'nib', nib: 'pen' }, { k: 'nib', nib: 'brush' })).toBe(false);
    expect(sameOpt({ k: 'nib', nib: 'pen' }, { k: 'erase' })).toBe(false);
    expect(sameOpt({ k: 'erase' }, { k: 'erase' })).toBe(true);
    expect(sameOpt({ k: 'form', form: 'echo' }, { k: 'form', form: 'echo' })).toBe(true);
    expect(sameOpt({ k: 'ink', ink: 'moss' }, { k: 'ink', ink: 'moss' })).toBe(true);
    expect(sameOpt({ k: 'ink', ink: 'moss' }, { k: 'ink', ink: 'rose' })).toBe(false);
    expect(sameOpt({ k: 'ink', ink: 'custom', custom: custom(30) }, { k: 'ink', ink: 'custom', custom: custom(30) })).toBe(true);
    expect(sameOpt({ k: 'ink', ink: 'custom', custom: custom(30) }, { k: 'ink', ink: 'custom', custom: custom(31) })).toBe(false);
    expect(sameOpt({ k: 'ink', ink: 'custom', custom: custom(30) }, { k: 'ink', ink: 'custom' })).toBe(false);
    expect(sameOpt({ k: 'nib', nib: 'pen' }, null)).toBe(false);
  });
  it('a size bend leaves every tile option unchanged (only the labels say the size)', () => {
    const a = tileSpecs('stroke', state());
    const b = tileSpecs('stroke', state({ tool: { ...state().tool, sizes: { pen: 2.5, brush: 13, chisel: 12, charcoal: 7 } } }));
    a.forEach((t, i) => expect(sameOpt(t.opt, b[i].opt)).toBe(true));
    expect(a[1].aria).not.toBe(b[1].aria);
  });
  it('with a selection, recent slot 1 adopts the selection colour; an empty slot stays inert', () => {
    const sel = tileSpecs('color', state({ selection: ['s1'], tool: { ...state().tool, recents: [custom(200)] } }));
    expect(sel[7]).toMatchObject({ label: 'Selection', intent: { k: 'pickCustom', color: custom(200) } });
    expect(sel[8]).toMatchObject({ label: 'Recent', intent: null, opt: null, aria: '' });
  });
});

describe('hint texts per device (DESIGN §5)', () => {
  it('navigation: desktop keys (a desktop pen tablet too), touch fingers, pen-mode one finger', () => {
    expect(defaultHintText('nav', { isTouch: false, penMode: false })).toBe('Space-drag to move · wheel or pinch to zoom.');
    expect(defaultHintText('nav', { isTouch: false, penMode: true })).toBe('Space-drag to move · wheel or pinch to zoom.');
    expect(defaultHintText('nav', { isTouch: true, penMode: false })).toBe('Two fingers pan and zoom.');
    expect(defaultHintText('nav', { isTouch: true, penMode: true })).toBe('One finger pans · two fingers zoom.');
  });
});

describe('idle costs nothing (DESIGN §1.1 rule 7)', () => {
  it('the announcer and the fader leave no timer behind once done', () => {
    const t = fakeTimers();
    const a = createAnnouncer({ textContent: '' }, 900, t);
    a.say('one'); a.say('two'); a.say('three');
    t.advance(5000);
    expect(t.pending).toBe(0);
    expect(a.pending.length).toBe(0);
    const f = createFader({ set: t.set, clear: t.clear, apply: () => {}, nearDock: () => false });
    f.contact(true); f.contact(false); f.replay(true); f.replay(false);
    t.advance(1000);
    expect(t.pending).toBe(0);
    expect(f.hidden).toBe(false);
  });
  it('dispose cancels a queued announcement', () => {
    const t = fakeTimers();
    const el = { textContent: '' as string | null };
    const a = createAnnouncer(el, 900, t);
    a.say('first'); t.advance(0);
    a.say('second');
    a.dispose();
    t.advance(2000);
    expect(el.textContent!.trim()).toBe('first');
    expect(t.pending).toBe(0);
  });
});
