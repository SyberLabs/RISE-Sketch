/**
 * Input-layer contracts. Spec: docs/DESIGN.md §5.
 * input/ turns DOM events into classified gestures and calls an InputSink.
 * It knows nothing about the document or the camera: every position is in
 * viewport CSS px. app/ implements InputSink.
 */
import type { Device, InputSample } from '../core/types';

export type KeyAction =
  | { k: 'form'; index: number }            // Digit1..9 -> 0..8, Digit0 -> 9 (P0_FORMS order)
  | { k: 'nib'; dir: 1 | -1 }               // B / Shift+B
  | { k: 'ink'; dir: 1 | -1 }               // C / Shift+C
  | { k: 'ground' }                         // G
  | { k: 'erase' }                          // E (toggle)
  | { k: 'size'; factor: number }           // [ ] -> 0.8 / 1.25
  | { k: 'depth'; delta: number }           // - = -> -0.5 / +0.5
  | { k: 'reseed' }                         // R
  | { k: 'symmetry'; step: boolean }        // M toggles symmetry / Shift+M steps the fold count
  | { k: 'undo' } | { k: 'redo' }
  | { k: 'selectAll' } | { k: 'delete' } | { k: 'escape' }
  | { k: 'fit' } | { k: 'resetView' }       // Shift+1 / Shift+0
  | { k: 'replay' }                         // P
  | { k: 'timelapse' }                      // Shift+P
  | { k: 'help' }                           // ? or F1
  | { k: 'save' } | { k: 'open' } | { k: 'export' }; // Mod+S / Mod+O / Mod+E

/**
 * Gesture callbacks. Object reuse: the sample passed to strokeBegin, the arrays passed to
 * strokeMove and the object passed to hover are reused by the input layer — copy what you keep.
 * KeyAction values are shared frozen constants.
 */
export interface InputSink {
  // ---- drawing / erasing contact (one pointer at a time)
  /** A contact was classified as a stroke. `mode` is 'erase' for the pen eraser end, barrel button, right-drag or erase mode. */
  strokeBegin(device: Device, s: InputSample, mode: 'draw' | 'erase'): void;
  /** Coalesced samples since the last call (reused objects: copy what you keep), plus predicted samples. */
  strokeMove(samples: readonly InputSample[], predicted: readonly InputSample[]): void;
  /**
   * 'commit' normally; 'withdraw' when a touch stroke is cancelled within 150 ms (second finger /
   * pointercancel). On touch-only devices a TAP's strokeEnd is deferred up to 300 ms (the double-tap
   * window): contact(false) marks the physical lift — stop stepping rise there and use it as t_up.
   * A second tap within the window yields strokeEnd('withdraw') + select(x, y, true).
   */
  strokeEnd(how: 'commit' | 'withdraw'): void;

  /** Pointer moving without contact (mouse, pen hover). null when it leaves. */
  hover(p: { x: number; y: number; device: Device; alt: number; az: number } | null): void;

  // ---- navigation (screen space)
  pan(dx: number, dy: number): void;
  zoom(factor: number, cx: number, cy: number): void;
  /** A navigation gesture ended (pinch released, wheel burst over, space-drag released). */
  navEnd(kind: 'pinch' | 'wheel' | 'drag'): void;

  // ---- selection & sampling (never with the drawing contact)
  /**
   * Mod-click passes add = shiftKey; pen-mode finger taps and touch double-taps pass add = true
   * ("tap more ink adds"). The app deselects on a miss regardless of add.
   */
  select(x: number, y: number, add: boolean): void;
  lassoBegin(x: number, y: number, add: boolean): void;
  lassoMove(x: number, y: number): void;
  lassoEnd(): void;
  sample(x: number, y: number): void;                 // Alt/Option-click

  // ---- misc
  twoFingerTap(): void;                                // undo
  key(a: KeyAction): void;
  /** A drawing, erasing, lasso or navigation contact began (chrome fades out); false when all lifted. Clicks never call it. */
  contact(active: boolean): void;
}

export interface InputOptions {
  /** The element pointer events are bound to (the canvas stack container). */
  target: HTMLElement;
  /** Current tool mode, read at pointerdown (erase mode turns draw contacts into erase). */
  mode(): 'draw' | 'erase';
  /** Whether keyboard shortcuts should be ignored (a sheet / text field has focus). */
  keysBlocked(): boolean;
  isMac: boolean;
}

export interface InputController {
  readonly penMode: boolean;
  /** Turn pen mode off until the next pen event ("Draw with fingers" toast action). */
  disablePenMode(): void;
  /** True while Space is held (pan cursor). */
  readonly spaceHeld: boolean;
  /** Pen mode flips (first pen event, 30 min expiry, disablePenMode). */
  onPenMode(fn: (on: boolean) => void): () => void;
  /** The first one-finger pan in pen mode (for the "Fingers pan while a pen is in use" toast). */
  onFingerPan(fn: () => void): () => void;
  dispose(): void;
}
