import { describe, it, expect } from 'vitest';
import { keyAction, repeatable, isChord, type KeyLike } from '../src/input/keys';

const k = (code: string, o: Partial<KeyLike> = {}): KeyLike =>
  ({ key: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...o, code });
const win = (e: KeyLike) => keyAction(e, false);
const mac = (e: KeyLike) => keyAction(e, true);

describe('keyAction: single keys', () => {
  it('maps every P0 binding by e.code', () => {
    expect(win(k('Digit1'))).toEqual({ k: 'form', index: 0 });
    expect(win(k('Digit2'))).toEqual({ k: 'form', index: 1 });
    expect(win(k('Digit3'))).toEqual({ k: 'form', index: 2 });
    expect(win(k('Digit4'))).toEqual({ k: 'form', index: 3 });
    expect(win(k('KeyB'))).toEqual({ k: 'nib', dir: 1 });
    expect(win(k('KeyB', { shiftKey: true }))).toEqual({ k: 'nib', dir: -1 });
    expect(win(k('KeyC'))).toEqual({ k: 'ink', dir: 1 });
    expect(win(k('KeyC', { shiftKey: true }))).toEqual({ k: 'ink', dir: -1 });
    expect(win(k('KeyG'))).toEqual({ k: 'ground' });
    expect(win(k('KeyE'))).toEqual({ k: 'erase' });
    expect(win(k('BracketLeft'))).toEqual({ k: 'size', factor: 0.8 });
    expect(win(k('BracketRight'))).toEqual({ k: 'size', factor: 1.25 });
    expect(win(k('Minus'))).toEqual({ k: 'depth', delta: -0.5 });
    expect(win(k('Equal'))).toEqual({ k: 'depth', delta: 0.5 });
    expect(win(k('Equal', { shiftKey: true }))).toEqual({ k: 'depth', delta: 0.5 }); // '+'
    expect(win(k('NumpadAdd'))).toEqual({ k: 'depth', delta: 0.5 });
    expect(win(k('NumpadSubtract'))).toEqual({ k: 'depth', delta: -0.5 });
    expect(win(k('KeyR'))).toEqual({ k: 'reseed' });
    expect(win(k('KeyP'))).toEqual({ k: 'replay' });
    expect(win(k('Delete'))).toEqual({ k: 'delete' });
    expect(win(k('Backspace'))).toEqual({ k: 'delete' });
    expect(win(k('Escape'))).toEqual({ k: 'escape' });
    expect(win(k('Digit1', { shiftKey: true }))).toEqual({ k: 'fit' });
    expect(win(k('Digit0', { shiftKey: true }))).toEqual({ k: 'resetView' });
    expect(win(k('F1'))).toEqual({ k: 'help' });
  });

  it("'?' matches e.key on any layout (one exception to e.code)", () => {
    expect(win(k('Slash', { key: '?', shiftKey: true }))).toEqual({ k: 'help' });
    expect(win(k('Minus', { key: '?', shiftKey: true }))).toEqual({ k: 'help' }); // e.g. German layout
    expect(win(k('KeyM', { key: '?', ctrlKey: true, altKey: true }))).toEqual({ k: 'help' }); // AltGr
    expect(mac(k('Slash', { key: '?', metaKey: true, shiftKey: true }))).toBe(null);
    expect(win(k('Slash', { key: '/' }))).toBe(null);
  });

  it('follows the physical key, not the character (AZERTY digits, Dvorak letters)', () => {
    expect(win(k('Digit1', { key: '&' }))).toEqual({ k: 'form', index: 0 });
    expect(win(k('KeyB', { key: 'x' }))).toEqual({ k: 'nib', dir: 1 });
  });

  it('P1 keys and unbound keys return null', () => {
    expect(win(k('Digit5'))).toBe(null);
    expect(win(k('KeyM'))).toBe(null);
    expect(win(k('ArrowLeft'))).toBe(null);
    expect(win(k('Digit0'))).toBe(null);
    expect(win(k('Digit2', { shiftKey: true }))).toBe(null);
    expect(win(k('KeyG', { shiftKey: true }))).toBe(null);
    expect(win(k('Space'))).toBe(null); // Space is a held modifier, handled by index.ts
  });

  it('single keys never fire with Ctrl, ⌘ or Alt held', () => {
    expect(win(k('KeyB', { altKey: true }))).toBe(null);
    expect(win(k('KeyB', { ctrlKey: true }))).toBe(null);
    expect(mac(k('KeyB', { ctrlKey: true }))).toBe(null);
    expect(mac(k('KeyG', { metaKey: true }))).toBe(null);
    expect(win(k('KeyE', { ctrlKey: true, altKey: true }))).toBe(null); // AltGr+E = €
  });
});

describe('keyAction: Mod chords', () => {
  it('Mod is Ctrl on Windows/Linux and ⌘ on macOS', () => {
    expect(win(k('KeyZ', { ctrlKey: true }))).toEqual({ k: 'undo' });
    expect(win(k('KeyZ', { metaKey: true }))).toBe(null);
    expect(mac(k('KeyZ', { metaKey: true }))).toEqual({ k: 'undo' });
    expect(mac(k('KeyZ', { ctrlKey: true }))).toBe(null);
  });

  it('undo / redo variants', () => {
    expect(win(k('KeyZ', { ctrlKey: true, shiftKey: true }))).toEqual({ k: 'redo' });
    expect(mac(k('KeyZ', { metaKey: true, shiftKey: true }))).toEqual({ k: 'redo' });
    expect(win(k('KeyY', { ctrlKey: true }))).toEqual({ k: 'redo' });
    expect(mac(k('KeyY', { ctrlKey: true }))).toEqual({ k: 'redo' }); // literal Ctrl+Y on every platform
    expect(mac(k('KeyY', { metaKey: true }))).toBe(null);
  });

  it('select all, save, open, export', () => {
    expect(win(k('KeyA', { ctrlKey: true }))).toEqual({ k: 'selectAll' });
    expect(win(k('KeyS', { ctrlKey: true }))).toEqual({ k: 'save' });
    expect(win(k('KeyO', { ctrlKey: true }))).toEqual({ k: 'open' });
    expect(win(k('KeyE', { ctrlKey: true }))).toEqual({ k: 'export' });
    expect(mac(k('KeyS', { metaKey: true }))).toEqual({ k: 'save' });
  });

  it('other chords pass through to the browser', () => {
    expect(win(k('KeyC', { ctrlKey: true }))).toBe(null);
    expect(win(k('KeyR', { ctrlKey: true }))).toBe(null);
    expect(win(k('KeyE', { ctrlKey: true, shiftKey: true }))).toBe(null); // P1 SVG export
    expect(win(k('KeyD', { ctrlKey: true }))).toBe(null);                  // P1 duplicate
    expect(win(k('KeyZ', { ctrlKey: true, altKey: true }))).toBe(null);
  });

  it('results are shared constants (no allocation per key)', () => {
    expect(win(k('KeyB'))).toBe(win(k('KeyB')));
    expect(Object.isFrozen(win(k('KeyB')))).toBe(true);
  });
});

describe('repeat and chord helpers', () => {
  it('steps and undo repeat; toggles and commands do not', () => {
    expect(repeatable({ k: 'size', factor: 1.25 })).toBe(true);
    expect(repeatable({ k: 'depth', delta: 0.5 })).toBe(true);
    expect(repeatable({ k: 'nib', dir: 1 })).toBe(true);
    expect(repeatable({ k: 'undo' })).toBe(true);
    expect(repeatable({ k: 'ground' })).toBe(false);
    expect(repeatable({ k: 'erase' })).toBe(false);
    expect(repeatable({ k: 'save' })).toBe(false);
    expect(repeatable({ k: 'replay' })).toBe(false);
  });
  it('isChord', () => {
    expect(isChord(k('KeyZ', { ctrlKey: true }))).toBe(true);
    expect(isChord(k('KeyZ', { metaKey: true }))).toBe(true);
    expect(isChord(k('KeyZ', { shiftKey: true }))).toBe(false);
    // Ctrl+Alt is AltGr on Windows: it types characters, so it never bypasses keysBlocked().
    expect(isChord(k('Slash', { key: '?', ctrlKey: true, altKey: true }))).toBe(false);
    expect(isChord(k('KeyZ', { metaKey: true, altKey: true }))).toBe(false);
  });
});
