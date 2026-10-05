/**
 * Keyboard map (DESIGN §5 "Keyboard"). Bindings use `e.code`, so they follow the
 * physical key on every layout; `?` is the one exception and matches `e.key`.
 * Mod = ⌘ on macOS and Ctrl elsewhere. Space (pan) is not a KeyAction: index.ts
 * tracks it as a held modifier.
 *
 * Decisions:
 *  - Single-key shortcuts require no Ctrl, ⌘ or Alt, so OS / browser chords and
 *    AltGr characters (Ctrl+Alt on Windows) never trigger them.
 *  - Mod chords require no Alt for the same reason (AltGr+E is "€" on many layouts).
 *  - Shift is ignored where it cannot mean anything else: `[ ] - =` (so `+` deepens
 *    too), Delete/Backspace, Escape. Numpad +/− also set depth.
 *  - `?` is accepted with AltGr (layouts that need it) but not with Mod alone.
 *  - Digit1–Digit9 and Digit0 pick the ten Forms in sheet order (P0_FORMS); Shift+Digit0 is 100 %.
 *  - P1 bindings (Mod+D, Mod+Shift+E, M, arrows) return null.
 */
import type { KeyAction } from './types';

export interface KeyLike {
  code: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

// Shared immutable results: mapping a key allocates nothing.
const A = {
  form: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => Object.freeze({ k: 'form', index }) as KeyAction),
  nibNext: Object.freeze({ k: 'nib', dir: 1 }) as KeyAction,
  nibPrev: Object.freeze({ k: 'nib', dir: -1 }) as KeyAction,
  inkNext: Object.freeze({ k: 'ink', dir: 1 }) as KeyAction,
  inkPrev: Object.freeze({ k: 'ink', dir: -1 }) as KeyAction,
  ground: Object.freeze({ k: 'ground' }) as KeyAction,
  erase: Object.freeze({ k: 'erase' }) as KeyAction,
  smaller: Object.freeze({ k: 'size', factor: 0.8 }) as KeyAction,
  larger: Object.freeze({ k: 'size', factor: 1.25 }) as KeyAction,
  shallower: Object.freeze({ k: 'depth', delta: -0.5 }) as KeyAction,
  deeper: Object.freeze({ k: 'depth', delta: 0.5 }) as KeyAction,
  reseed: Object.freeze({ k: 'reseed' }) as KeyAction,
  undo: Object.freeze({ k: 'undo' }) as KeyAction,
  redo: Object.freeze({ k: 'redo' }) as KeyAction,
  selectAll: Object.freeze({ k: 'selectAll' }) as KeyAction,
  del: Object.freeze({ k: 'delete' }) as KeyAction,
  escape: Object.freeze({ k: 'escape' }) as KeyAction,
  fit: Object.freeze({ k: 'fit' }) as KeyAction,
  resetView: Object.freeze({ k: 'resetView' }) as KeyAction,
  replay: Object.freeze({ k: 'replay' }) as KeyAction,
  help: Object.freeze({ k: 'help' }) as KeyAction,
  save: Object.freeze({ k: 'save' }) as KeyAction,
  open: Object.freeze({ k: 'open' }) as KeyAction,
  exportPng: Object.freeze({ k: 'export' }) as KeyAction,
};

/** Map a keydown to an action, or null when Rise does not handle it. */
export function keyAction(e: KeyLike, isMac: boolean): KeyAction | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;

  if (e.key === '?' && !e.metaKey && !(e.ctrlKey && !e.altKey)) return A.help;

  if (mod) {
    if (e.altKey) return null;
    switch (e.code) {
      case 'KeyZ': return e.shiftKey ? A.redo : A.undo;
      case 'KeyY': return !e.shiftKey && e.ctrlKey ? A.redo : null;
      case 'KeyA': return e.shiftKey ? null : A.selectAll;
      case 'KeyS': return e.shiftKey ? null : A.save;
      case 'KeyO': return e.shiftKey ? null : A.open;
      case 'KeyE': return e.shiftKey ? null : A.exportPng;
      default: return null;
    }
  }
  // Ctrl+Y redoes on every platform (on macOS Ctrl is not Mod).
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyY') return A.redo;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  const s = e.shiftKey;
  switch (e.code) {
    case 'Digit1': return s ? A.fit : A.form[0];
    case 'Digit2': return s ? null : A.form[1];
    case 'Digit3': return s ? null : A.form[2];
    case 'Digit4': return s ? null : A.form[3];
    case 'Digit5': return s ? null : A.form[4];
    case 'Digit6': return s ? null : A.form[5];
    case 'Digit7': return s ? null : A.form[6];
    case 'Digit8': return s ? null : A.form[7];
    case 'Digit9': return s ? null : A.form[8];
    case 'Digit0': return s ? A.resetView : A.form[9];
    case 'KeyB': return s ? A.nibPrev : A.nibNext;
    case 'KeyC': return s ? A.inkPrev : A.inkNext;
    case 'KeyG': return s ? null : A.ground;
    case 'KeyE': return s ? null : A.erase;
    case 'KeyR': return s ? null : A.reseed;
    case 'KeyP': return s ? null : A.replay;
    case 'BracketLeft': return A.smaller;
    case 'BracketRight': return A.larger;
    case 'Minus': case 'NumpadSubtract': return A.shallower;
    case 'Equal': case 'NumpadAdd': return A.deeper;
    case 'Delete': case 'Backspace': return A.del;
    case 'Escape': return A.escape;
    case 'F1': return A.help;
    default: return null;
  }
}

/** Whether an action may auto-repeat while its key is held (steps and undo do; toggles and commands do not). */
export function repeatable(a: KeyAction): boolean {
  return a.k === 'size' || a.k === 'depth' || a.k === 'nib' || a.k === 'ink' || a.k === 'undo' || a.k === 'redo';
}

/**
 * Whether a keydown is a chord (Ctrl or ⌘ held, no Alt): chords stay live while single
 * keys are blocked, except in text fields. Ctrl+Alt is AltGr on Windows, which types
 * characters (the AltGr `?` help key), so it is not a chord.
 */
export function isChord(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey;
}
