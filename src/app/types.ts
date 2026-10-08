/**
 * App-layer contracts: tool state, intents, observable app state and events.
 * Spec: docs/DESIGN.md §3.4, §4, §7.2. ui/ reads AppState and dispatches Intents;
 * it never touches doc/scene/renderer directly.
 */
import type { ColorStyle, FormId, Ground, InkId, NibId, StrokeId, StrokeRecipe, ToolState } from '../core/types';
import type { FrameRecord, RenderCounters } from '../render/stats';
export type { ToolState };

export type SheetId = 'stroke' | 'color' | 'form' | 'menu' | 'help';

export type Intent =
  | { k: 'pickNib'; nib: NibId } | { k: 'pickErase' } | { k: 'exitErase' }
  | { k: 'pickInk'; ink: InkId } | { k: 'pickCustom'; color: ColorStyle } | { k: 'pickForm'; form: FormId }
  | { k: 'bendSize'; factor: number; done: boolean }      // relative to the value at drag start
  | { k: 'bendDepth'; delta: number; done: boolean }      // levels, relative to drag start
  | { k: 'bendColor'; dh: number; dL: number; done: boolean } // degrees / L, relative to drag start
  | { k: 'reseed' } | { k: 'delete' } | { k: 'undo' } | { k: 'redo' }
  | { k: 'ground'; g: Ground }
  /** Symmetry (Form sheet switch, M): `on` toggles it (the centre becomes the view centre); `folds` sets the fold count and turns it on. */
  | { k: 'symmetry'; on?: boolean; folds?: number }
  | { k: 'select'; ids: readonly StrokeId[]; add: boolean } | { k: 'deselect' } | { k: 'selectAll' }
  | { k: 'new' } | { k: 'open'; file: File } | { k: 'openPicker' }
  | { k: 'openRecent'; id: string } | { k: 'deleteRecent'; id: string }
  | { k: 'save' } | { k: 'exportPng' } | { k: 'cancelExport' }
  | { k: 'replay' } | { k: 'stopReplay' }
  | { k: 'fit' } | { k: 'resetView' } | { k: 'viewChip' }
  | { k: 'resetCalibration' }
  | { k: 'openSheet'; sheet: SheetId | null }
  | { k: 'disablePenMode' }
  | { k: 'hintDone'; id: HintId };

export type HintId = 'draw' | 'rise' | 'form' | 'nav';

export interface RecentDoc { id: string; title: string; updated: number; strokes: number; thumb: string | null /* object URL / data URL */ }

export interface AppState {
  tool: ToolState;
  ground: Ground;
  selection: readonly StrokeId[];
  /** Screen bounds of the selection (viewport CSS px), for placing Delete; null without a selection. */
  selectionRect: { x: number; y: number; w: number; h: number } | null;
  canUndo: boolean;
  canRedo: boolean;
  hasInk: boolean;
  /** Zoom as a percentage (100 = 1:1) and whether any ink is in view. */
  zoom: number;
  inkInView: boolean;
  /** Screen-space angle (radians) from the viewport centre toward the ink when none is in view. */
  inkDirection: number | null;
  /** A contact is on the canvas: chrome is hidden (fades back 700 ms after release). */
  chromeHidden: boolean;
  sheet: SheetId | null;
  /** The last committed stroke, used by sheet tiles (null = stock squiggle). */
  lastRecipe: StrokeRecipe | null;
  docTitle: string;
  currentDocId: string;
  recentDocs: readonly RecentDoc[];
  autosaveOk: boolean;
  replaying: boolean;
  replayProgress: number; // 0..1
  exporting: boolean;
  penMode: boolean;
  firstRun: boolean;
  hints: Readonly<Record<HintId, 'pending' | 'showing' | 'done'>>;
  reducedMotion: boolean;
  isTouch: boolean;   // coarse pointer device
  isMac: boolean;
}

export type AppEvent =
  | { k: 'toast'; id: string; text: string; action?: { label: string; intent: Intent }; progress?: number; ms?: number }
  | { k: 'toastClose'; id: string }
  | { k: 'announce'; text: string }
  | { k: 'pulse'; target: 'form' | 'stroke' | 'color' }
  | { k: 'hint'; id: HintId; text: string; at?: { x: number; y: number } | null }
  | { k: 'hintHide'; id: HintId };

export interface Store {
  get(): AppState;
  subscribe(fn: (s: AppState, prev: AppState) => void): () => void;
  on(fn: (e: AppEvent) => void): () => void;
  dispatch(i: Intent): void;
}

/**
 * `?debug` only: window.__rise, used by scripts/e2e.mjs. Implemented by app/debug.ts.
 * Everything here is test plumbing; none of it is product UI.
 */
export interface RiseDebug {
  readonly version: string;
  /** Resolves when no rAF work, animations, bakes, cooks or autosave writes are pending. */
  idle(timeoutMs?: number): Promise<boolean>;
  state(): AppState;
  dispatch(i: Intent): void;
  /** Geometry-relevant hash of the document (doc/serialize sceneHash). */
  sceneHash(): number;
  strokeCount(): number;
  /** Summary of the most recent stroke in z-order. */
  lastStroke(): {
    id: string; form: string; nib: string; ink: string; device: string;
    pools: number; maxPool: number; radial: boolean; closed: boolean;
    nPolys: number; nPts: number; gens: number; base: number;
  } | null;
  camera(): { cx: number; cy: number; scale: number; rot: number };
  /** Doc point -> viewport CSS px, and back. */
  toScreen(x: number, y: number): [number, number];
  toDoc(sx: number, sy: number): [number, number];
  /** Interactive controls currently visible in #chrome (DESIGN §1.2 budget). */
  visibleControls(): { count: number; labels: string[] };
  /** Serialise / load the current document as .rise text. */
  serialize(): string;
  load(text: string): Promise<void>;
  exportPng(): Promise<{ width: number; height: number; bytes: number }>;
  /** Perf counters since the last reset (CPU-side ms). */
  perf(reset?: boolean): { liveFrameP95: number; liveFrameMax: number; inputP95: number; frames: number; longTasks: number };
  /**
   * Render work counters (render/stats.ts): totals and, while recording, one delta per renderer
   * frame. `reset` zeroes both; `record` turns the per-frame log on or off (scripts/bench-zoom.mjs).
   */
  renderStats(opts?: { reset?: boolean; record?: boolean }): { totals: RenderCounters; log: FrameRecord[] };
  /** Pixel probe on the composited stage at viewport CSS px (reads the canvases; slow). */
  probe(sx: number, sy: number): [number, number, number, number];
  /** Wipe local persistence (IndexedDB + rise:* prefs) for clean test runs. */
  wipe(): Promise<void>;
}
