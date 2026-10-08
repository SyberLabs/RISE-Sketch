/**
 * Rise: shared data contracts.
 *
 * This file is the single source of truth for every type that crosses a module
 * boundary in the pure layers (core, ink, doc, scene). It contains types only (no
 * runtime code except `const enum`s, which are erased), and compiles under
 * tsconfig.pure.json (no DOM).
 *
 * Spec: docs/DESIGN.md §7.2. Where this file and the spec differ, THIS FILE WINS;
 * the differences are deliberate and are marked "contract note".
 *
 * Units: `sp` = screen CSS px at the zoom when the stroke began; `doc` = document
 * units (doc = sp / z). Arc lengths `s` are absolute, in sp, from the stroke start.
 */

export type StrokeId = string; // base36(ms).padStart(9,'0') + base36(counter).padStart(4,'0'); sorts by creation
export type Device = 'pen' | 'mouse' | 'touch';
export type NibId = 'pen' | 'brush' | 'chisel' | 'charcoal';
export type InkId = 'graphite' | 'indigo' | 'oxide' | 'ochre' | 'moss' | 'rose' | 'spectral' | 'custom';
export type FormId = 'line' | 'echo' | 'sprout' | 'drift' | 'ripple'
  | 'craze' | 'plume' | 'caustic' | 'burin' | 'plait' | 'orbit';
export type Ground = 'night' | 'paper';
export type Vec2 = readonly [number, number];
export type LCh = readonly [L: number, C: number, h: number];
export type Mat2x3 = Float64Array; // [a b c d e f], Canvas2D setTransform order
export interface AABB { x0: number; y0: number; x1: number; y1: number }

/**
 * Nibs / Forms offered in the UI, in sheet and number-key order (charcoal is P1). Digit1–Digit0 pick
 * the first ten Forms; Ripple, the eleventh, has no key.
 */
export const P0_NIBS: readonly NibId[] = ['pen', 'brush', 'chisel'];
export const P0_FORMS: readonly FormId[] = ['line', 'echo', 'sprout', 'drift', 'craze', 'plume', 'caustic', 'burin', 'plait', 'orbit', 'ripple'];
export const INK_ORDER: readonly InkId[] = ['graphite', 'indigo', 'oxide', 'ochre', 'moss', 'rose', 'spectral'];

// ============================================================================ input samples

/**
 * One pointer sample as delivered by input/ (contract note: in SCREEN CSS px, not
 * doc units; app/draft.ts converts to doc and writes the persisted row).
 */
export interface InputSample {
  x: number; y: number;  // CSS px, viewport space
  t: number;             // sanitised, strictly increasing ms (e.timeStamp base, same clock as performance.now())
  p: number;             // raw device pressure 0..1; NaN if the device has none (mouse, most touch)
  alt: number; az: number; // radians; alt = π/2, az = 0 when unknown
  r: number;             // contact radius in CSS px; NaN if unknown
  predicted: boolean;    // predicted samples are drawn once and never stored
}

/** Persisted sample rows: Float32, stride 9. x and y are doc units relative to recipe.origin. */
export const enum S { X = 0, Y = 1, T = 2 /* ms since pen-down */, P = 3 /* raw, NaN if none */, ALT = 4, AZ = 5, R = 6 /* sp */, C = 7, CS = 8, STRIDE = 9 }
/** Pool rows: Float32, stride 4. */
export const enum PL { S = 0 /* arc, sp */, A = 1 /* levels, quantised to 1/16 */, T0 = 2, T1 = 3 /* ms since down; replay only */, STRIDE = 4 }

/** Growable row buffer (see core/pool.ts F32 for the implementation pattern). `n` counts ROWS. */
export interface SampleBuf { data: Float32Array; n: number }
export interface PoolBuf { data: Float32Array; n: number }

// ============================================================================ recipes

export interface Calib {
  lo: number; hi: number; gamma: number; flat: number; // pen pressure curve (flat = k, the flat-hand guard weight)
  vMed: number;   // median in-stroke speed, sp/ms
  jitter: number; // J, sp
  fcMin: number;  // One Euro min cutoff, Hz (derived from J for pens)
}
export interface StrokeStyle { nib: NibId; size: number /* S, sp */ }
export interface ColorStyle {
  ink: InkId;
  k: number;   // variant counter value
  dh: number;  // hue offset, degrees
  dL: number;  // lightness offset
  lch: { night: LCh; paper: LCh } | null; // custom ink colours (ink === 'custom'); null otherwise
}
export interface FormStyle { form: FormId; v: number /* operator version */; base: number /* levels, quantised to 1/4 */ }
export interface Symmetry { axis: 'v' | 'h'; at: number } // reserved (always null): symmetry copies are expressed as `xf`
/**
 * Symmetry drawing (the Form sheet switch, DESIGN §2.3.1, §4). `folds` 2 = Mirror (reflection across
 * the vertical axis through the centre); 3..12 = radial copies rotated by 360°/folds. The centre is
 * in doc units: the view centre when symmetry was turned on. Each copy is a recipe of its own whose
 * `xf` places the shared geometry (ink/symmetry.ts).
 */
export interface SymmetryTool { on: boolean; folds: number; cx: number; cy: number }

/** Fields every recipe-like object shares; operators and the spine builder read only these. */
export interface RecipeCore {
  readonly origin: Vec2;        // Float64 doc coordinates of sample (0,0)
  readonly z: number;           // camera scale at pen-down (sp per doc unit)
  readonly rot: number;         // camera rotation at pen-down; 0 in P0
  readonly seed: number;        // uint32
  readonly device: Device;
  readonly calib: Calib;
  readonly stroke: StrokeStyle;
  readonly color: ColorStyle;
  readonly form: FormStyle;
  readonly s0: number;          // arc offset (sp) of the first station; > 0 only for split pieces
  readonly cut: number;         // bit 0: head is a cut (no entry taper); bit 1: tail is a cut (no exit taper)
  readonly resume: Float32Array | null; // stabiliser + operator cursors at s0 (split pieces)
}

/** Immutable. A restyle creates a new object that shares `samples`. */
export interface StrokeRecipe extends RecipeCore {
  readonly id: StrokeId;
  readonly created: number;     // Date.now() at pen-down — metadata only (lineage recency), never feeds geometry
  readonly samples: Float32Array; // S.STRIDE rows, exact length
  readonly pools: Float32Array;   // PL.STRIDE rows, exact length; length 0 = no pools
  readonly closed: boolean;
  readonly radial: boolean;     // L < 6 sp: tap or bloom seed
  readonly sym: Symmetry | null; // P1
  readonly xf: Mat2x3 | null;   // post-cook placement (doc rel. origin -> doc rel. origin); symmetry copies (format v2)
  readonly geomRev: number;     // bumped by a replace that changes geometry inputs (cache key)
  readonly colorRev: number;    // bumped when only colour changes (re-raster, no re-cook)
}

/** The stroke being drawn; owned by app/draft.ts. Buffers grow in place. */
export interface DraftStroke extends RecipeCore {
  readonly samples: SampleBuf;
  readonly pools: PoolBuf;
  closing: boolean;             // live closure state (hysteresis applied)
}
export type RecipeView = StrokeRecipe | DraftStroke;

/** Depth field d(s) = base + max_i a_i·K(s − s_i). */
export interface DepthField { readonly base: number; at(s: number): number; maxPool(): number }

// ============================================================================ spine

/** Structure of arrays; stations every 2.4 sp on the filtered, corner-aware path. */
export interface Spine {
  n: number;
  x: Float32Array; y: Float32Array; // doc, relative to origin
  s: Float32Array;                  // absolute arc length, sp (starts at s0)
  t: Float32Array;                  // ms since down
  p: Float32Array;                  // calibrated (or synthesised) pressure 0..1
  w: Float32Array;                  // UNTAPERED nib width, doc
  vn: Float32Array;                 // normalised speed v / vMed
  k: Float32Array;                  // signed curvature, rad/sp
  c: Float32Array; cs: Float32Array; // frozen crowding, side crowding
  alt: Float32Array; az: Float32Array;
  nx: Float32Array; ny: Float32Array; // unit normal (left of travel), smoothed over 6 sp
  corner: Uint8Array;
  settled: number;                  // stations < settled are final (live only; == n after finish)
  L: number;                        // current length (absolute end arc s[n-1]), sp
  z: number;                        // sp per doc unit (the recipe's camera scale at pen-down)
}

// ============================================================================ cooked geometry

/** Per-poly nib kind (contract note: added to the spec's Cooked). */
export const enum PolyKind {
  Ribbon = 0, // centreline + full width; tessellated by normal offsets
  Chisel = 1, // centreline + edge length `w` at per-point angle `ang`
  Dot = 2,    // count = 1: a disc of diameter `w`
}

/**
 * Colourless cooked geometry, packed and transferable. Polys are sorted by gen.
 *
 * Contract notes vs spec:
 *  - `kind` (per poly) and `ang` (per point, chisel only) are added.
 *  - `w` is the FINAL full width in doc units with the stroke envelope applied
 *    (during live drawing the exit taper is not yet applied: the tip is round).
 *  - `inkBox` / `hitBox` are ABSOLUTE doc coordinates; per-poly `box` is relative to origin.
 *  - `tone` = pBucket*5 + dBucket (0..29), pBucket = min(5, floor(p*6)), dBucket = min(gen-depth, 4).
 *    Spectral hue is derived at raster time from `born` (see ink/color.ts toneIndex), so geometry
 *    never depends on the ink. Trunk chunks split where the tone changes and at every 50 sp of arc.
 */
export interface Cooked {
  pts: Float32Array;            // stride 4: x, y, w, a (doc rel. origin; a = arc along this poly, sp)
  ang: Float32Array | null;     // nPts entries; chisel nib angle (radians, doc space) for Chisel polys
  start: Uint32Array; count: Uint32Array; // per poly, in points
  kind: Uint8Array;             // PolyKind
  gen: Uint8Array;              // 0 = seed/trunk
  tone: Uint8Array;
  alpha: Float32Array;          // NIGHT design alpha × hierarchy × glow(c). Paper per-generation scales and Echo Paper
                                //   exposure are applied at raster (render/live.ts drawInk), times ink alphaMax.
  born: Float32Array;           // spine arc (sp) each poly grows from
  unit: Uint32Array;            // growth unit (anchor / station / chunk index)
  box: Float32Array;            // 4 per poly: x0, y0, x1, y1 (doc rel. origin, includes w/2)
  genStart: Uint32Array;        // genStart[g] = first poly of gen g; length maxGen + 2 (last = nPolys)
  nPolys: number; nPts: number;
  inkBox: AABB;                 // absolute doc coords, all polys
  hitBox: AABB;                 // absolute doc coords, polys with alpha >= 0.3 (plus spine)
  ceilingMax: number;           // realised max depth after caps
  coverage: number;             // Echo exposure input
  bytes: number;                // total typed-array bytes (LRU accounting)
}

/** A read-only view of one poly. `pts` is a subarray (stride 4) valid until the next mutation. */
export interface PolyView {
  index: number; kind: PolyKind; gen: number; alpha: number; tone: number; born: number; unit: number;
  pts: Float32Array; ang: Float32Array | null; box: Float32Array /* 4 */;
}

// ============================================================================ cook API (implemented in ink/cook.ts)

/** Morph reveal data held by the live layer during an animation (Line live window, Echo fold-out). */
export interface MorphSet {
  from: Float32Array;     // stride 2 (x, y) per point of geom, aligned with geom.pts
  polyFirst: Uint32Array; // first poly index each morph group covers
  t0: Float32Array;       // start time per group on the STROKE clock (ms since pen-down; informational)
  dur: Float32Array;      // duration ms per group
}
export interface LiveView {
  /** Optional stable drain ids per poly of geom (ink-forms InkLiveView). */
  slot?: Int32Array;
  geom: Cooked;           // current geometry, including the unsettled tail (round tip, no exit taper)
  ghost: Cooked | null;   // Echo provisional crystal (α 0.3), null for local forms
  morph: MorphSet | null;
}
export interface IncrementalCook {
  /** Cook the region newly settled by the last `nSamples` appended rows. */
  append(nSamples: number): void;
  /** Pools changed inside spine arc [s0, s1]; regrow affected units. */
  regrow(s0: number, s1: number): void;
  setClosing(on: boolean): void;
  /** Current geometry. Valid until the next call on this object; never retain. */
  view(): LiveView;
  /** Each settled poly exactly once; `replaces` = -1 for new polys, else the index of the poly it supersedes. */
  drainSettled(cb: (p: PolyView, replaces: number) => void): void;
  /** Realisable depth ceiling at arc s (for the rise halo's brim flash). */
  ceiling(s: number): number;
  /** Current spine (read-only; for the halo position, closure, lasso etc.). */
  spine(): Readonly<Spine>;
  /** Lift: re-cooks head/tail zones and global work. MUST equal cook(r) bit for bit. */
  finish(r: StrokeRecipe): Cooked;
}
export type CreateIncrementalCook = (d: RecipeView) => IncrementalCook;
export type CookFn = (r: StrokeRecipe) => Cooked;

// ============================================================================ colour API (implemented in ink/color.ts)

export interface InkDef { id: InkId; night: LCh; paper: LCh; band: number; hd: number; spectral: boolean; name: string }
/**
 * Resolved colours for one stroke on one ground. Index with `toneIndex(table, tone, born)`.
 * Non-spectral: 30 entries (index = tone). Spectral: 36 hue buckets × 30 tones (shared table).
 */
export interface InkTable {
  css: readonly string[];
  op: 'lighter' | 'multiply';
  alphaMax: number;      // 1 on Night, 0.85 on Paper
  spectral: boolean;
  hs: number;            // spectral base hue (deg) for this stroke; 0 otherwise
  rgb: Uint8Array;       // 3 bytes per css entry (for sampling, bloom tint, SVG)
}

// ============================================================================ document

export interface Camera { cx: number; cy: number; scale: number /* [0.05, 32] */; rot: number /* 0 in P0 */ }
/** Camera maps doc -> screen: sx = (x - cx)·scale + W/2, sy = (y - cy)·scale + H/2 (rot = 0). */

export interface DocMeta {
  id: string; title: string; created: number; updated: number; docSeed: number;
  counter: number;                     // monotonic; outside history
  inkCounters: Record<InkId, number>;  // monotonic; outside history
  ground: Ground; camera: Camera;      // saved, not undoable
}
export type Command =
  | { k: 'add'; recipes: readonly StrokeRecipe[] }
  | { k: 'remove'; ids: readonly StrokeId[] }
  | { k: 'replace'; before: readonly StrokeRecipe[]; after: readonly StrokeRecipe[] } // inverse = swap; exact
  | { k: 'meta'; patch: { title?: string } }
  | { k: 'batch'; cmds: readonly Command[] };
export interface DocChange {
  added: StrokeId[]; removed: StrokeId[];
  geometry: StrokeId[]; // replaced with a different geomRev
  color: StrokeId[];    // replaced with only colorRev changed
  meta: boolean;        // title / ground / camera changed
  view: boolean;        // ground or camera changed via setView
}
export interface Doc {
  readonly meta: Readonly<DocMeta>;
  get(id: StrokeId): StrokeRecipe | undefined;
  has(id: StrokeId): boolean;
  ordered(): readonly StrokeRecipe[];  // z-order = id order (creation)
  readonly size: number;
  apply(c: Command): Command;          // returns the inverse; the ONLY stroke mutator
  nextSeed(): number;                  // bumps counter; = hash32(docSeed, counter)
  nextVariant(ink: InkId): number;     // returns then bumps inkCounters[ink]
  nextId(): StrokeId;
  setView(v: Partial<Pick<DocMeta, 'ground' | 'camera'>>): void;
  subscribe(fn: (ch: DocChange) => void): () => void;
}
export interface History {
  push(c: Command, inverse: Command): void;
  undo(): Command | null;  // returns the command that was applied (the inverse), or null
  redo(): Command | null;
  peekUndo(): Command | null; // the inverse that undo() would apply (for peel animations)
  clear(): void;
  readonly canUndo: boolean; readonly canRedo: boolean; // capped at 500 entries
}

// ============================================================================ scene

export type Priority = 'visible' | 'handoff' | 'prefetch' | 'background';
export interface Scene {
  cooked(id: StrokeId): Cooked | undefined;
  /** Register geometry produced synchronously (e.g. by IncrementalCook.finish) without re-cooking. */
  put(id: StrokeId, c: Cooked): void;
  ensure(ids: readonly StrokeId[], prio: Priority): Promise<void>;
  query(box: AABB, out: StrokeId[]): StrokeId[];                    // by inkBox, z-ordered
  hit(p: Vec2, rDoc: number, minAlpha?: number): StrokeId | null;   // topmost; capsule then polys alpha >= minAlpha (0.3)
  sweep(a: Vec2, b: Vec2, rDoc: number, out: Set<StrokeId>): void;  // eraser segment
  lasso(poly: Float64Array): StrokeId[];                            // >= 50% of spine stations inside
  crowding(x: number, y: number, z: number): number;                // c in [0,1]
  sideCrowding(x: number, y: number, nx: number, ny: number, z: number): number; // CS in [-1,1]
  /** Same-ink stroke to inherit colour from. now = Date.now(); z = the NEW stroke's zoom (sp per doc). */
  lineage(x: number, y: number, ink: InkId, wDoc: number, now: number, z?: number): StrokeId | null;
  /** Geometry of this exact recipe revision (e.g. the before side of a restyle), if cached. */
  cookedFor(r: StrokeRecipe): Cooked | undefined;
  /** Register geometry for an explicit recipe revision (use during the add+replace peel commit). */
  putFor(r: StrokeRecipe, c: Cooked): void;
  /** Topmost hit plus its nearest qualifying poly (-1 if uncooked), for Alt-click sampling. */
  pick(p: Vec2, rDoc: number, minAlpha?: number): { id: StrokeId; poly: number } | null;
  contentBox(): AABB | null;
  /** Total cooked points currently cached (debug / budgets). */
  readonly cachedPoints: number;
}
export interface Kitchen { cook(r: StrokeRecipe, prio: Priority): Promise<Cooked>; cancel(id: StrokeId): void }

// ============================================================================ tool state (pure data; app owns it)

export interface ToolState {
  nib: NibId; lastNib: NibId;             // lastNib: where the erase-mode chip tap returns to
  sizes: Record<NibId, number>;           // S per nib, sp
  ink: InkId;                             // 'custom' => `custom` holds the colours
  custom: ColorStyle['lch'];
  recents: readonly ColorStyle[];         // <= 2 custom inks
  form: FormId;
  base: Record<FormId, number>;           // base depth per Form (quarter levels)
  mode: 'draw' | 'erase';
  sym: SymmetryTool;                      // symmetry drawing (Mirror / radial); never in history
}
