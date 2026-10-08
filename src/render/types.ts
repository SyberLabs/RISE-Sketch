/**
 * Render-layer contracts (DOM types allowed). Spec: docs/DESIGN.md §6, §7.2.
 * Implemented by render/renderer.ts (createRenderer), render/live.ts, render/overlay.ts,
 * render/glyphs.ts. Consumed by app/ and ui/.
 */
import type {
  AABB, Camera, ColorStyle, Cooked, DraftStroke, FormId, Ground, IncrementalCook, InkId, InputSample,
  NibId, StrokeId, StrokeRecipe, ToolState, Vec2, Doc, Scene,
} from '../core/types';

/** Nib-shaped cursor drawn on the overlay at the pointer. */
export interface NibCursor {
  kind: NibId | 'erase';
  wCss: number;   // true on-screen width (CSS px)
  angle: number;  // chisel nib angle in screen radians (ignored for round nibs)
  css: string;    // ink colour for the current tool on the current ground
}

/** Rise halo, drawn as ink in #wet. Positions in CSS px. */
export interface Halo {
  x: number; y: number;
  rCss: number;
  level: number;  // 0..1 of the local ceiling (brightness = 0.15 + 0.5·level)
  pre: number;    // 0..1 pre-halo fade-in (before pooling starts)
  brim: boolean;  // ceiling reached: brightness ×1.8 for 160 ms (renderer times the flash)
  css: string;
}

export type RemoveAnim = 'ungrow' | 'fade' | 'none';

export interface Renderer {
  /** Viewport size in CSS px and the device pixel ratio to render at. */
  resize(cssW: number, cssH: number, dpr: number): void;
  setCamera(c: Camera, phase: 'gesture' | 'settled'): void;
  getCamera(): Camera;
  setGround(g: Ground, animate: boolean): void;

  /**
   * Document mutations that did NOT go through the live layer (undo/redo, load, delete,
   * erase, restyle). The renderer invalidates tiles, (re)bakes and plays the animation.
   * Removed/replaced-before recipes are passed as they were, so their geometry can animate out.
   */
  strokesAdded(items: readonly StrokeRecipe[], anim: 'grow' | 'none'): void;
  strokesRemoved(items: readonly StrokeRecipe[], anim: RemoveAnim): void;
  strokesReplaced(before: readonly StrokeRecipe[], after: readonly StrokeRecipe[], anim: 'morph' | 'none'): void;
  /** New document / open: drop every tile and cached raster. */
  reset(anim: 'fade' | 'none'): void;

  /** Selection layer: lift strokes out of the tiles (rest of drawing dims to 45%). */
  lift(ids: readonly StrokeId[]): Promise<void>;
  /** Live restyle preview of lifted strokes (chip drag); pass null to restore. */
  previewLifted(items: readonly { r: StrokeRecipe; c: Cooked }[] | null): void;
  /** Bake the lifted selection back into the tiles. */
  drop(): Promise<void>;

  readonly live: LiveLayer;
  readonly overlay: Overlay;
  readonly glyphs: Glyphs;

  /**
   * Shared raster path for tiles, bloom, export and sheet tiles. Draws every stroke whose inkBox
   * intersects `box` (absolute doc coords) at `pxPerDoc` into ctx (ctx transform is reset by the
   * caller to identity; the generator sets its own). Yields between strokes. Returns ids skipped
   * because they were not cooked yet.
   */
  renderRegion(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    box: AABB, pxPerDoc: number, ground: Ground, paintGround: boolean,
  ): Generator<void, StrokeId[]>;

  /** Encode the visible viewport (ground + ink) for the cold-load snapshot / thumbnail. */
  snapshot(maxEdge: number): Promise<Blob | null>;
  /** Paint a previously saved snapshot under the tiles until real tiles cover the view. */
  showSnapshot(img: ImageBitmap | HTMLImageElement | null, cam: Camera | null): void;

  /** Called by the frame loop. Returns true while work is pending (keeps rAF alive). */
  frame(now: number, budgetMs: number): boolean;
  /** Drop GPU-backed canvases (memory pressure / before export). */
  purge(): void;
  readonly stats: { tiles: number; canvasBytes: number; pendingTiles: number; animating: number };
}

export interface LiveLayer {
  /**
   * A stroke starts. The live layer draws `cook.view()` incrementally (dry/wet split, hot trail,
   * reveals), and once more per symmetry copy, placed by its `xf` in its own colour.
   */
  begin(d: DraftStroke, cook: IncrementalCook, copies?: readonly LiveCopy[]): void;
  /** After cook.append / regrow / setClosing: schedule a redraw of what changed. */
  update(): void;
  /** Predicted tail (screen CSS px), drawn once on the overlay, discarded next frame. */
  predict(tail: readonly InputSample[]): void;
  halo(h: Halo | null): void;
  /**
   * Lift: finish reveals, then two-phase bake into tiles. `copies` are the committed symmetry
   * copies (recipe and placed geometry), in the order `begin` was given them.
   */
  commit(r: StrokeRecipe, c: Cooked, copies?: readonly { r: StrokeRecipe; c: Cooked }[]): void;
  /** Cancel the live stroke with an un-grow; nothing enters the document. */
  withdraw(): void;
  /** Play a recorded/committed stroke growing in (replay, first-run seed, redo). */
  play(r: StrokeRecipe, c: Cooked, opts?: { durationScale?: number; bake?: boolean }): void;
  /** Un-grow something that is only in the live layer (first-run seed dissolve). */
  dissolve(ms: number): void;
  fastForward(): void;
  readonly animating: number;
  readonly active: boolean; // a stroke is being drawn
}

/** A symmetry copy of the live stroke: its placement (doc rel. origin) and colour. */
export interface LiveCopy { xf: Mat2x3; color: ColorStyle }

export interface Overlay {
  cursor(p: Vec2 | null, shape: NibCursor | null): void;   // CSS px
  weld(p: Vec2 | null, rCss: number): void;               // closure weld ring at the stroke start
  lasso(path: Float64Array | null): void;                 // CSS px, interleaved
  eraser(p: Vec2 | null, rCss: number, doomed: readonly StrokeId[]): void;
  selection(box: AABB | null, ids: readonly StrokeId[]): void; // box in absolute doc coords
  /** True-size nib ring preview (size bending) at a screen point; null hides. */
  sizeRing(p: Vec2 | null, wCss: number, css: string): void;
  /**
   * Symmetry guide (DESIGN §2.3.1): a non-interactive 15 % hairline through the centre (doc
   * coords): the vertical axis for Mirror (folds 2), else `folds` spokes. null hides it.
   */
  symmetry(g: { folds: number; cx: number; cy: number } | null): void;
  clear(): void;
}

export type TileOption =
  | { k: 'nib'; nib: NibId }
  | { k: 'erase' }
  | { k: 'ink'; ink: InkId; custom?: ColorStyle }
  | { k: 'form'; form: FormId };

/** Mini renders for chips and sheet tiles. Static renders (P0), cached by the implementation. */
export interface Glyphs {
  chip(canvas: HTMLCanvasElement, which: 'stroke' | 'color' | 'form', tool: ToolState, ground: Ground, erase: boolean): void;
  /** Render `last` (or the stock seed squiggle when null / unusable) through `opt`. */
  tile(canvas: HTMLCanvasElement, opt: TileOption, last: StrokeRecipe | null, tool: ToolState, ground: Ground): void;
  /** Thumbnail of a whole document for Recent (96 px). */
  thumb(canvas: HTMLCanvasElement, recipes: readonly StrokeRecipe[], ground: Ground): void;
}

/** Construction dependencies for createRenderer (render/renderer.ts). */
export interface RendererDeps {
  root: HTMLElement;          // full-viewport container; the renderer creates #ground, #base, #bloom*, #dry, #wet, #overlay inside
  doc: Doc;                   // read-only use: get / ordered / meta
  scene: Scene;               // cooked geometry, queries, ensure
  requestFrame(): void;       // ask the frame loop for a rAF
  reducedMotion(): boolean;
}

// ============================================================================ renderer <-> live layer seam
// render/renderer.ts (render-world agent) implements LiveHost and drives LiveLayerInternal;
// render/live.ts (render-live agent) implements LiveLayerInternal against LiveHost.

import type { InkTable, Mat2x3, RecipeCore } from '../core/types';

export interface LiveHost {
  /** Ink canvases (device-px backing store, CSS-sized to the viewport, blend mode set by the renderer). */
  readonly dry: HTMLCanvasElement;
  readonly wet: HTMLCanvasElement;
  /** Device pixel ratio of dry/wet. */
  dpr(): number;
  ground(): Ground;
  camera(): Camera;
  viewport(): { w: number; h: number }; // CSS px
  /** Doc-relative-to-`origin` -> device px of dry/wet (Float64 offset math; rot = 0 in P0). */
  matrixFor(origin: Vec2): Mat2x3;
  /** Cached ink table for a stroke-like object (keyed by id:colorRev:ground when id is present). */
  inkTable(r: RecipeCore & { id?: string; colorRev?: number }): InkTable;
  /**
   * Two-phase bake (§6.2): draw a committed stroke into its tiles in time slices. `done` is called
   * from inside the renderer's frame() in the SAME rAF in which #base is re-composited; the live
   * layer must clear the stroke from #dry synchronously inside `done` so the stroke never shows
   * twice or vanishes for a frame.
   */
  bake(r: StrokeRecipe, c: Cooked, done: () => void): void;
  requestFrame(): void;
  reducedMotion(): boolean;
  now(): number; // performance.now()
}

export interface LiveLayerInternal extends LiveLayer {
  /** Advance animations and redraw dirty regions of #dry/#wet. Returns true while animating. */
  frame(now: number): boolean;
  /** Committed strokes growing in (redo, load with anim, replay without bake). Bakes when done. */
  grow(items: readonly { r: StrokeRecipe; c: Cooked }[]): void;
  /** Removal animation: the renderer has ALREADY re-rendered tiles without these strokes. */
  ungrow(items: readonly { r: StrokeRecipe; c: Cooked }[]): void;
  /** Restyle: un-grow `before` (150 ms) then grow `after`; tiles already exclude `before`. */
  morph(before: readonly { r: StrokeRecipe; c: Cooked }[], after: readonly { r: StrokeRecipe; c: Cooked }[]): void;
  /** Lifted selection drawn in #dry (dims nothing itself; the renderer sets #base opacity). */
  setLifted(items: readonly { r: StrokeRecipe; c: Cooked }[] | null): void;
  /** Camera moved: re-render dry/wet content under the new transform (gesture => fast-forward first). */
  onCamera(phase: 'gesture' | 'settled'): void;
  resize(): void;
  /** Ground flipped: re-raster live content with the new ink tables. */
  onGround(): void;
}

export interface OverlayInternal extends Overlay {
  frame(now: number): boolean;
  resize(cssW: number, cssH: number, dpr: number): void;
  /** Predicted tail and tip (live stroke), drawn once then cleared. Screen CSS px. */
  predicted(tail: readonly InputSample[] | null, wCss: number, css: string): void;
}

/** Overlay construction needs to map doc boxes/outlines to screen and read cooked geometry for outlines. */
export interface OverlayHost {
  readonly canvas: HTMLCanvasElement; // the renderer creates it with { desynchronized: true }
  camera(): Camera;
  viewport(): { w: number; h: number };
  scene: Scene;
  doc: Doc;
  ground(): Ground;
  requestFrame(): void;
}
