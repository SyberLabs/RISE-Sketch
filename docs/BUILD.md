# Rise: build plan and module contracts

This document turns `docs/DESIGN.md` (the product + technical spec) into parallel work.
Each module group has one owner agent. Read DESIGN.md for *behaviour*; read this file for
*who owns what* and *the exact exported API other modules will call*.

## 0. Global rules (every agent)

1. **Ownership.** Write only the files listed under your group (plus your tests and sandbox
   files). Never edit another group's files.
2. **Shared contracts are frozen:** `src/core/types.ts`, `src/render/types.ts`,
   `src/input/types.ts`, `src/app/types.ts`, and the existing `src/core/{det,num,geom,mat,pool,oklab}.ts`.
   Do **not** edit them. If a contract is wrong or missing something you truly need, write the
   request to `docs/contract-requests/<your-group>.md` (problem, proposed change, workaround you
   used), and work around it locally (e.g. a local interface that extends the shared one). The
   integration phase resolves requests.
3. **Exports listed below are a promise.** Other agents are coding against these exact names and
   signatures right now. You may add exports; you may not rename or change listed ones.
4. **Typecheck:** `npx tsc --noEmit -p tsconfig.json` (and `-p tsconfig.pure.json` for pure layers,
   `-p tsconfig.test.json` for tests). Other agents are mid-flight, so **only errors in your own
   files matter** — filter the output to your paths. Your files must typecheck cleanly.
5. **Tests:** vitest, Node environment. Put tests in `tests/<group>.<topic>.test.ts`. Run only
   yours: `npx vitest run tests/<group>.` Pure modules must be fully unit-tested.
6. **Determinism (geometry modules: `core/{det,geom,num,mat}`, `ink/**` except `ink/color.ts`):**
   Math allow-list only (`sqrt abs floor ceil round trunc min max imul fround sign clz32`); no `**`,
   no `Date`, no `performance`; transcendentals from `core/det.ts` (`dsin dcos datan datan2 dexp dlog
   dpow dhypot`); randomness only from `rnd(seed, Ch.*, a, b)` with integer addresses.
   `tests/purity.test.ts` enforces this, plus import direction (DESIGN §7.3) and no DOM in pure layers.
7. **Allocation:** no per-event / per-sample allocation in hot paths (use `core/pool.ts` growable
   buffers, reuse scratch arrays). Allocation per stroke or per frame-batch is fine.
8. **Style:** match `src/core/*.ts` — a short doc comment on every export, brief comments only where
   the maths or a decision is non-obvious, no commented-out code, strict TypeScript, no `any`
   unless at a DOM boundary. Zero runtime dependencies.
9. **Sandbox pages** (for visual self-checks of DOM modules) go in `sandbox/<group>/*.html` +
   `.ts` (served by `npx vite` dev server at `/sandbox/<group>/x.html`). Screenshot them with
   `scripts/harness.mjs` (puppeteer-core + system Chrome; see its helpers `launch`, `penStroke`,
   `wave`, `circle`, `pinch`, `measureFrames`). Start the dev server with
   `npx vite --port <your port> --strictPort` in the background (ports: ink 5181, render 5182-5184,
   input 5185, ui 5186, scene 5187, doc 5188) and kill it when done.
10. **Spec ambiguity:** decide, document the decision in a comment, and list it in your final report.

## 1. Groups and order

```
wave 1 (parallel):  ink-instrument ─► ink-forms
                    render-core ─► { render-world ∥ render-live }
                    doc-persist     scene-sched     input     ui
wave 2:             app (integration: store, controller, draft, selection, replay, first-run,
                    export, main.ts, e2e)
```

---

## 2. ink-instrument  (pure; tsconfig.pure.json)

**Files:** `src/ink/{nibs,calib,stabilize,signals,spine,envelope,depth,rise}.ts`
**Spec:** DESIGN §2.2 (all of it), §2.3.2 (depth field), §3.1 (Rise), §7.4, §7.5.

```ts
// ink/nibs.ts
export interface NibDef { id: NibId; name: string; S: number; min: number; max: number; taper: number }
export const NIBS: Record<NibId, NibDef>;                 // pen 2.5 (0.75–12) .5; brush 9 (2–48) 1; chisel 12 (3–48) .4; charcoal 7 (2–40) .8
export const FINGER_WIDTH: number;                        // 1.35
/** Untapered nib width in sp (Pen/Brush/Charcoal: full width; Chisel: edge length E). */
export function nibWidth(nib: NibId, S: number, p: number, vn: number, device: Device): number;
/** Chisel nib angle in screen radians: azimuth when altitude < 60°, else 40°. */
export function chiselAngle(alt: number, az: number): number;
/** Brush dry-split weight 0..1 (0 = solid ribbon). */
export function drySplit(nib: NibId, vn: number, p: number, device: Device): number;

// ink/calib.ts
export const DEFAULT_CALIB: Record<Device, Calib>;
export interface Learner {
  snapshot(d: Device): Calib;
  /** Between strokes only: feed a finished stroke's rows (S.STRIDE) and its measured jitter. */
  observe(d: Device, samples: Float32Array, rows: number, jitter: number): void;
  reset(d?: Device): void;
  readonly strokes: Readonly<Record<Device, number>>;
}
export function createLearner(io?: { load(key: string): string | null; save(key: string, v: string): void }): Learner; // keys 'rise:calib:<device>'
export function calibratePressure(raw: number, c: Calib): number;
/** One step of speed-synthesised pressure for mouse/touch (DESIGN §2.2.2). */
export function synthPressure(prev: number, vn: number, dtMs: number): number;

// ink/depth.ts
export function kernel(x: number): number;                 // K(x) of DESIGN §2.3.2
export function createDepthField(base: number, pools: Float32Array, nPools: number): DepthField;

// ink/spine.ts
export function createSpine(capacity?: number): Spine;
export interface SpineBuilder {
  readonly spine: Spine;
  /** Consume sample rows appended to r.samples since the last call; extends stations; advances `settled`. */
  append(): void;
  /** Lift: end flush, lift zones (seated stop, ramp-down), weld if closing. settled = n afterwards. */
  finish(): void;
  /** Measured jitter J of this stroke so far (for the learner). */
  jitter(): number;
  /** Serialisable state at the current settled station (for split pieces / resume). */
  snapshot(): Float32Array;
}
export function createSpineBuilder(r: RecipeView): SpineBuilder;
/** Convenience: full build of a committed recipe (≡ builder + append + finish). */
export function buildSpine(r: StrokeRecipe): Spine;

// ink/envelope.ts
export interface Envelope {
  readonly Te: number; readonly Tx: number;   // sp
  readonly seated: boolean; readonly closed: boolean;
  /** Causal entry factor E_in(s). */
  inF(s: number): number;
  /** Full width multiplier E(s) (exit factor is 1 in a live envelope). */
  at(s: number): number;
}
export function liveEnvelope(r: RecipeView, sp: Spine): Envelope;
export function finalEnvelope(r: RecipeView, sp: Spine): Envelope;
/** Closure test with hysteresis (on inside r_c, off beyond 1.5 r_c). */
export function closureTest(sp: Spine, wasClosing: boolean): boolean;

// ink/rise.ts
export interface RiseInput {
  x: number; y: number;  // filtered tip, sp (i.e. CSS px at the stroke's zoom)
  s: number;             // arc length at the tip, sp
  p: number;             // calibrated pressure (synthesised ≈0.9 for a still mouse)
  now: number;           // ms since pen-down on the rAF clock
  travel: number;        // total travel so far, sp
}
export type RisePhase = 'moving' | 'prehalo' | 'pooling' | 'settling' | 'paused' | 'ceiling';
export interface RiseOut {
  phase: RisePhase;
  pre: number;           // 0..1 pre-halo fade
  level: number;         // local depth d(s_i) (base + pool) at the hold point
  brim: boolean;         // true on the step the ceiling is reached
  changed: { s0: number; s1: number } | null;  // pool window changed: regrow this arc range
  hold: { x: number; y: number; s: number } | null;
}
export interface Rise {
  /** Called every rAF while the contact is down. May grow pools.data (replace the array). */
  step(inp: RiseInput, pools: PoolBuf, base: number, ceiling: (s: number) => number): RiseOut;
  /** Lift guard: restore pools to their state at tUp − 60 ms (ms since down). */
  liftGuard(pools: PoolBuf, tUp: number): void;
  readonly rose: boolean;
}
export function createRise(device: Device, calib: Calib): Rise;
```

**Must-haves:** One Euro filter without transcendentals; corner-aware Chaikin between corners;
resample at 2.4 sp; strictly monotone `settled` watermark (stations below it never change on later
`append` calls — required for incremental ≡ full); per-station `p` (calibrated, or synthesised from
stored `t` for mouse/touch where `P = NaN`), `w` (untapered), `vn`, `k`, `c`/`cs` (copied from
samples), `alt`/`az`, smoothed normals; entry/exit tapers, flick, seated stop, ramp-down; closure
with hysteresis + live weld; pooling per device thresholds × jitter factor, pressure gate, Settle,
ceiling brim, lift guard.

**Tests (`tests/ink-instrument.*.test.ts`):** builder fed in random chunk sizes produces the same
spine as one full build (bitwise on settled stations, and on everything after `finish`); settled
never moves backwards; One Euro reduces noise on a jittered line; tapers/seated/flick behaviours;
closure hysteresis on a circle; depth field values; rise state machine per device (stillness →
prehalo 250/350 ms → pooling 450/600 ms; pressure gate pause/settle; move-on freezes; brim at
ceiling; lift guard restores earlier values); learner percentile + lock rules; pressure synthesis.

---

## 3. ink-forms  (pure; starts after ink-instrument finishes)

**Files:** `src/ink/noise.ts`, `src/ink/operators/{types,registry,line.v1,echo.v1,sprout.v1,drift.v1}.ts`,
`src/ink/cook.ts`. (`ink/operators/types.ts` is yours: the Operator interface may deviate from the
DESIGN §7.2 sketch as long as the exported API below holds.)
**Spec:** DESIGN §2.3 (all), §3.2 (wake/reveal data), §6.6, §7.4, §7.5, §9 rules 9.

```ts
// ink/operators/registry.ts
export interface FormMeta { id: FormId; name: string; dMax: number; baseDefault: number; locality: 'local' | 'global'; p0: boolean }
export const FORMS: Record<FormId, FormMeta>;   // line 0–5 (0), echo 0–5 (2), sprout 0–4 (2), drift 0–6 (2), ripple meta (p0:false)
export const CURRENT_V: Record<FormId, number>; // all 1

// ink/cook.ts
export const createIncrementalCook: CreateIncrementalCook;   // core/types.ts IncrementalCook
export const cook: CookFn;                                    // ≡ createIncrementalCook(draftOf(r)).finish(r)
export function draftOf(r: StrokeRecipe): DraftStroke;
/** Thumbnail-quality cook (sheet tiles, chip glyphs): ≤ maxPts points, may lower depth caps. */
export function cookPreview(r: StrokeRecipe, maxPts: number): Cooked;
/** Spine of a committed recipe, cached per recipe object (hit tests, lasso, lineage use it). */
export function spineOf(r: StrokeRecipe): Spine;
```

**Cooked layout is in `core/types.ts` (read its contract notes):** stride-4 `pts` (x, y, w, a),
per-poly `kind` (Ribbon/Chisel/Dot) and per-point `ang` for chisel polys, final widths with the
envelope applied, absolute `inkBox`/`hitBox`, `tone = pBucket*5 + dBucket`, trunk chunks split at
tone changes and every 50 sp, polys sorted by gen with `genStart`, per-poly `box`.
Brush dry-split bristles are emitted as ordinary Ribbon polys (gen 0) with the noise gating applied.

**Must-haves:** all four operators with every inference mapping, fractional depth contract, depth
field pools (`regrow` re-emits only affected units), Sprout/Drift cooked at unit ceiling and
truncated, Line nested lattice, Echo crystal/snowflake/ghost/fold-out `MorphSet`, radial seeds for
all four Forms, hierarchy alphas, glow budget, Echo exposure, per-unit + causal budgets,
`drainSettled` (each settled poly exactly once), and **`cook(r)` ≡ `finish(r)` bitwise for any
append chunking / hold schedule / closure toggling**. Auto-split (`s0`/`cut`/`resume`) is
desirable; if you run out of room implement `resume = null` pieces correctly and report it.

**Tests (`tests/ink-forms.*.test.ts`):** golden `fnv1a` hashes per Form fixture (commit them);
incremental ≡ full with random chunking/holds/closure; continuity in depth (bounded change per
1/16 level; Line d=0 equals the spine ribbon); budgets, no NaN, inkBox contains all points,
genStart sorted; radial seeds; determinism across two runs; noise curl divergence ≈ 0.

---

## 4. render-core  (DOM allowed except where noted; starts at once)

**Files:** `src/ink/color.ts` (pure, presentation — exempt from the Math allow-list),
`src/render/{tessellate,raster,batch,camera,ledger,ground}.ts`. `render/tessellate.ts` is pure
(no DOM types — it writes to the `PathSink` interface, which CanvasRenderingContext2D and an SVG
path builder both satisfy).
**Spec:** DESIGN §2.4 (colour), §6.1, §6.3, §6.4, §6.9, §9 LOD rules 2–5.

```ts
// ink/color.ts
export const INKS: Record<Exclude<InkId, 'custom'>, InkDef>;
export function resolveInk(c: ColorStyle, g: Ground): InkTable;
export function toneIndex(t: InkTable, tone: number, born: number): number;   // spectral hue from born arc
export function assignVariant(ink: InkId, k: number, lineage: ColorStyle | null, custom: ColorStyle['lch']): ColorStyle;
/** Custom ink from a colour picked on ground g; derives the other ground's twin (DESIGN §2.4.1). */
export function customFromLch(lch: LCh, g: Ground): NonNullable<ColorStyle['lch']>;
/** Colour chip drag: bend a base ink by dh (deg) and dL on ground g into custom colours. */
export function bendColor(base: ColorStyle, dh: number, dL: number, g: Ground): NonNullable<ColorStyle['lch']>;
/** A representative swatch colour (UI chips, cursor, halo). p/d default to 0.7 / 0. */
export function swatchCss(c: Pick<ColorStyle, 'ink' | 'lch'> & Partial<ColorStyle>, g: Ground, p?: number, d?: number): string;
/** Resolved colour of one poly (Alt-click sampling). */
export function lchAt(c: ColorStyle, g: Ground, tone: number, born: number): LCh;
export const GROUND_TOKENS: Record<Ground, { bg: string; ui: string; uiBorder: string; text: string; textDim: string; accent: string; focus: string }>;

// render/tessellate.ts  (pure)
export interface PathSink {
  moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void; closePath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
}
export interface TraceOpts {
  reveal?: number;                  // prefix 0..1 of the poly's arc (interpolated end point)
  morphFrom?: Float32Array | null;  // stride-2 'from' positions aligned with c.pts (for this poly's points)
  morphT?: number;                  // 0..1
  widthScale?: number;
  minDevWidth?: number;             // hairline threshold (device px), default 1
}
/** Append poly i's closed outline (doc-rel-origin -> device via m) to sink. Returns false if nothing drawn. */
export function tracePoly(sink: PathSink, c: Cooked, i: number, m: Mat2x3, o?: TraceOpts): boolean;
/** Centreline of poly i for the hairline rule (stroke it at 1 device px). */
export function traceCentre(sink: PathSink, c: Cooked, i: number, m: Mat2x3, o?: TraceOpts): boolean;

// render/raster.ts
export interface DrawOpts {
  alphaScale?: number;
  polys?: ArrayLike<number> | null;           // subset of poly indices (default all)
  reveal?: ((i: number) => number) | null;    // per-poly prefix 0..1
  morph?: { from: Float32Array; t: (i: number) => number } | null;
  hot?: ((i: number) => number) | null;       // per-poly alpha multiplier (hot trail)
  clipDev?: AABB | null;                      // device-px rect; polys whose box misses it are skipped
  lod?: boolean;                              // gen cull, hairline, stroke cull, decimated LODs (default true)
}
/** Draw one cooked stroke: batches by (css, alpha bucket), Bézier edges, LOD rules. ctx composite op is set from the table. */
export function drawCooked(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  c: Cooked, table: InkTable, m: Mat2x3, o?: DrawOpts): void;
/** doc-rel-origin -> device px matrix for a camera, viewport (CSS px) and dpr. Float64 offset math. */
export function viewMatrix(origin: Vec2, cam: Camera, cssW: number, cssH: number, dpr: number): Mat2x3;
/** Matrix for an arbitrary raster target: doc box origin at (0,0), pxPerDoc scale. */
export function regionMatrix(origin: Vec2, box: AABB, pxPerDoc: number): Mat2x3;
/** Cached ink tables keyed by id:colorRev:ground (or by colour content when no id). */
export function inkTableFor(r: RecipeCore & { id?: string; colorRev?: number }, g: Ground): InkTable;

// render/camera.ts
export const MIN_SCALE = 0.05, MAX_SCALE = 32;
export function docToScreen(c: Camera, W: number, H: number, x: number, y: number): [number, number];
export function screenToDoc(c: Camera, W: number, H: number, sx: number, sy: number): [number, number];
export function panBy(c: Camera, dx: number, dy: number): Camera;
export function zoomAt(c: Camera, factor: number, sx: number, sy: number, W: number, H: number): Camera;
export function fitBox(box: AABB, W: number, H: number, margin?: number): Camera;   // margin 0.06
export function snapDetent(scale: number): number;                                  // 25/50/100/200/400 % within ±8 %
export function visibleBox(c: Camera, W: number, H: number): AABB;

// render/ledger.ts
export type DeviceClass = 'phone' | 'tablet' | 'desktop';
export function deviceClass(): DeviceClass;
export interface CanvasLedger {
  alloc(w: number, h: number, tag: string): HTMLCanvasElement | null;  // evicts via onPressure and retries once
  resize(c: HTMLCanvasElement, w: number, h: number): boolean;
  free(c: HTMLCanvasElement): void;                                    // sets width = height = 0
  onPressure(fn: (needBytes: number) => void): void;                  // the tile cache registers an evictor
  readonly bytes: number; readonly cap: number;
}
export function createLedger(cls?: DeviceClass): CanvasLedger;

// render/ground.ts
export function applyGround(el: HTMLElement, g: Ground, animate: boolean): void; // CSS gradient + vignette + dither grain
export function paintGround(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, g: Ground): void;
```

**Tests:** colour tables (gamut, ramps, Indigo×Ochre multiply lands at hue 130–170, spectral
indexing); tessellation (ribbon outline closed, round joins, inner clamp, chisel winding, prefix
reveal endpoint interpolation) against a recording PathSink; camera maths round-trips.
**Sandbox:** `sandbox/render-core/` page drawing synthetic Cooked strokes (build them by hand)
with every nib kind on both grounds; screenshot it.

---

## 5. render-world  (starts after render-core)

**Files:** `src/render/{tiles,compositor,bloom,renderer,glyphs}.ts`.
**Spec:** DESIGN §6.2, §6.7, §6.8, §6.9, §6.10, §3.4 (tiles in sheets), §8 (snapshot), §9.

```ts
// render/renderer.ts
export function createRenderer(deps: RendererDeps): Renderer;   // render/types.ts
```
Creates inside `deps.root`: `#ground` (div), `#base`, `#bloomA`, `#bloomB`, `#dry`, `#wet`,
`#overlay` (canvases, CSS mix-blend per ground, `pointer-events: none` except as noted — input binds
to `deps.root`). Implements `LiveHost` and constructs the live layer with
`createLiveLayer(host)` from `render/live.ts` and the overlay with `createOverlay(host)` from
`render/overlay.ts` (render-live agent; signatures in §6 below). Tiles: half-octave levels, 512²
device px, dirty sub-rects, LRU through the ledger, centre-out progressive render on settle,
stale tiles during gestures, two-phase bake, lift/drop, bloom double buffer, context-loss rebuild,
snapshot encode/show, `renderRegion` shared by tiles/export/glyphs.
`render/glyphs.ts` implements `Glyphs` using `cookPreview` (ink-forms) — until ink-forms lands,
code against the exported signature in §3.

---

## 6. render-live  (starts after render-core)

**Files:** `src/render/{live,overlay}.ts`.
**Spec:** DESIGN §3.1 (halo), §3.2 (hot trail, wake reveal, un-grow, concurrency), §6.2 (dry/wet,
hand-off), §6.6, §2.2.2 latency (prediction on the overlay), §4 feedback list.

```ts
// render/live.ts
export function createLiveLayer(host: LiveHost): LiveLayerInternal;      // render/types.ts
// render/overlay.ts
export function createOverlay(host: OverlayHost): OverlayInternal;       // render/types.ts
```
The live layer consumes `IncrementalCook` (`view()`, `drainSettled`, `spine()`) — build and test it
against a fake IncrementalCook until ink-forms lands. Draw with render-core's `drawCooked` /
`tracePoly`. Dirty-rect clearing from per-poly boxes; at most 4 animating strokes; reduced motion.

---

## 7. doc-persist  (doc/ pure; persist/ DOM)

**Files:** `src/doc/{ids,document,commands,history,serialize,migrate}.ts`,
`src/persist/{prefs,idb,autosave,files}.ts`.
**Spec:** DESIGN §7.2 (doc types), §8 (history, autosave, Recent, .rise, snapshots storage).

```ts
// doc/ids.ts
export function makeStrokeId(ms: number, counter: number): StrokeId;
export function makeDocId(ms: number, rand32: number): string;
// doc/document.ts
export function newMeta(now: number, docSeed: number, id: string): DocMeta;
export function createDoc(meta: DocMeta, strokes?: readonly StrokeRecipe[]): Doc;   // core/types.ts Doc
// doc/commands.ts
/** New recipe with a patch; bumps geomRev (kind 'geometry') or colorRev (kind 'color'). */
export function patchRecipe(r: StrokeRecipe, patch: Partial<Omit<StrokeRecipe, 'id' | 'geomRev' | 'colorRev'>>, kind: 'geometry' | 'color'): StrokeRecipe;
export function freezeRecipe(fields: Omit<StrokeRecipe, 'geomRev' | 'colorRev'>): StrokeRecipe;
// doc/history.ts
export function createHistory(doc: Doc, cap?: number): History;        // core/types.ts History; push() does not apply
// doc/serialize.ts
export const FORMAT_VERSION: number;   // 1
export class RiseFormatError extends Error {}
export function serializeDoc(meta: DocMeta, strokes: readonly StrokeRecipe[], app: string): string;
export function parseDoc(text: string): { meta: DocMeta; strokes: StrokeRecipe[] };   // migrates; throws RiseFormatError
export function encodeF32(a: Float32Array): string;
export function decodeF32(s: string): Float32Array;
/** Hash of geometry-relevant recipe fields in z-order (e2e reload/round-trip checks). */
export function sceneHash(strokes: readonly StrokeRecipe[]): number;

// persist/prefs.ts  (localStorage under 'rise:'; every call wrapped in try/catch)
export const prefs: {
  get<T>(key: string, fallback: T): T; set(key: string, v: unknown): void; remove(key: string): void;
  load(key: string): string | null; save(key: string, v: string): void;   // raw, for createLearner
};
// persist/idb.ts
export interface DocSummary { id: string; title: string; updated: number; strokes: number }
export interface DocStore {
  listDocs(): Promise<DocSummary[]>;                                     // newest first
  loadDoc(id: string): Promise<{ meta: DocMeta; strokes: StrokeRecipe[] } | null>;
  putMeta(meta: DocMeta, strokeCount: number): Promise<void>;
  putStrokes(docId: string, recipes: readonly StrokeRecipe[]): Promise<void>;
  deleteStrokes(docId: string, ids: readonly StrokeId[]): Promise<void>;
  deleteDoc(id: string): Promise<void>;
  putSnapshot(docId: string, blob: Blob, cam: Camera): Promise<void>;
  getSnapshot(docId: string): Promise<{ blob: Blob; cam: Camera } | null>;
  putThumb(docId: string, blob: Blob): Promise<void>;
  getThumb(docId: string): Promise<Blob | null>;
  requestPersist(): Promise<boolean>;
}
export function openDocStore(): Promise<DocStore | null>;              // null when IndexedDB is unavailable
// persist/autosave.ts
export interface Autosave {
  /** Track a document: subscribes to doc changes, batches writes every 250 ms, flushes on hide/pagehide. */
  attach(doc: Doc): void;
  flush(): Promise<void>;
  readonly ok: boolean;
  onStatus(fn: (ok: boolean) => void): () => void;
  dispose(): void;
}
export function createAutosave(store: DocStore | null): Autosave;
// persist/files.ts
export function downloadBlob(blob: Blob, filename: string): void;
export function pickFile(accept: string): Promise<File | null>;
export function readFileText(f: File): Promise<string>;
export function onDropFiles(el: HTMLElement, fn: (files: File[]) => void): () => void;
```

**Tests:** doc property test (200 seeded random commands, undo all → empty, `replace` exact),
history cap and peek, serialisation bit-exact round trip and fixture migration, id ordering,
sceneHash stability. IndexedDB code is browser-only: verify it in a sandbox page.

---

## 8. scene-sched  (scene/ pure; sched/ DOM)

**Files:** `src/scene/{rtree,occupancy,query,kitchen,scene}.ts`, `src/sched/{frame,jobs}.ts`.
**Spec:** DESIGN §2.3.9 (occupancy, crowding, CS), §2.4.2 (lineage), §3.4 (hit/lasso rules), §6.8
(Cooked LRU), §9 (scheduler, job priorities).

```ts
// sched/jobs.ts
export const enum JobPrio { Handoff = 0, Visible = 1, Lift = 2, Prefetch = 3, Bloom = 4, Save = 5, Sheets = 6, Cook = 7 }
export interface Jobs {
  /** A job is an iterator (one step per next()) or a function returning true while unfinished. */
  add(prio: JobPrio, job: Iterator<unknown> | (() => boolean), key?: string): void;
  cancel(key: string): void;
  has(key: string): boolean;
  /** Run jobs in priority order until budgetMs is spent. Returns true if work remains. */
  run(budgetMs: number): boolean;
  readonly pending: number;
}
export function createJobs(now?: () => number): Jobs;
// sched/frame.ts
export interface FrameLoop {
  request(): void;                                                         // idempotent
  /** Participants run each frame in order of `order`; return true while they need more frames. */
  add(fn: (now: number, budgetMs: number) => boolean, order?: number): () => void;
  readonly frameInterval: number;                                          // measured, ms
  readonly running: boolean;
}
export function createFrameLoop(): FrameLoop;   // rAF only while some participant returns true or request() was called
// scene/scene.ts
export function createScene(deps: { doc: Doc; cook: CookFn; jobs: Jobs; requestFrame(): void; spineOf?: (r: StrokeRecipe) => Spine }): Scene & { dispose(): void };
// scene/occupancy.ts
export interface Occupancy {
  add(r: StrokeRecipe): void; remove(r: StrokeRecipe): void; clear(): void;
  crowding(x: number, y: number, z: number): number;                       // c
  side(x: number, y: number, nx: number, ny: number, z: number): number;   // CS
}
export function createOccupancy(): Occupancy;
// scene/rtree.ts
export class RTree<T> { insert(b: AABB, item: T): void; remove(item: T): boolean; search(b: AABB, out: T[]): T[]; clear(): void; readonly size: number }
```
The scene subscribes to `doc` (added/removed/geometry/color → index, occupancy, cooked cache).
Occupancy capsules use samples and an approximate width `0.7·stroke.size / z` (doc) — no cook
needed. Uncooked strokes are indexed by a conservative box (sample bbox padded by
`(64 + 3·size)/z`) until cooked. `hit`/`lasso`/`lineage` use the cooked spine when available via
`deps.spineOf` (ink-forms' `spineOf`), else raw sample positions. Kitchen cooks in time slices via
`jobs` (`JobPrio.Cook` for background, higher for visible/handoff).
**Tests:** R-tree vs brute force (10k boxes, 1k queries), occupancy returns to zero after
add/remove, crowding/side values on synthetic strokes, hit/sweep/lasso/lineage on fake cooked
data, kitchen priority ordering, jobs budget honoured (inject a fake clock).

---

## 9. input  (DOM)

**Files:** `src/input/{pointer,devices,arbiter,gestures,wheel,keys,index}.ts`.
**Spec:** DESIGN §5 (everything), §2.2.2 latency/predicted events, §3.4 select table.

```ts
// input/index.ts
export function createInput(opts: InputOptions, sink: InputSink): InputController;   // input/types.ts
// pure helpers, unit-tested:
export function sanitizeTime(prev: number, t: number): number;                        // input/pointer.ts
export function classifyWheel(e: { deltaMode: number; deltaX: number; deltaY: number; ctrlKey: boolean }, state: WheelState, now: number): 'notch' | 'pinch' | 'scroll'; // input/wheel.ts
export function keyAction(e: { code: string; key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, isMac: boolean): KeyAction | null; // input/keys.ts
```
Pen mode + palm rules, coalesced (`?? [e]`) and predicted events, timestamp sanitiser, eraser end
/ barrel / right-drag (≥ 4 sp), Mod-click/Mod-drag lasso, Alt-click sample, touch: 1-finger draw
with 150 ms withdraw window, 2-finger pan/pinch (4 % scale dead zone), 2-finger tap undo,
double-tap select, pen-mode finger tap select / 350 ms hold lasso / finger pan, Space-drag and
middle-drag pan, wheel bursts, `e.code` key map, `contextmenu` and Safari `gesturestart` prevented.
**Tests:** pure classifiers (time sanitiser, wheel bursts, taps/double-taps/2-finger taps, key map,
palm rules as a pure state machine). **Sandbox:** a page logging sink calls; drive it with the
harness (pen, mouse, touch pinch, taps, wheel) and assert the log.

---

## 10. ui  (DOM)

**Files:** `src/ui/{dock,chip,sheet,menu,recent,selectionbar,viewchip,toast,hints,help,announce,icons,index}.ts`,
`src/styles.css`, `index.html`.
**Spec:** DESIGN §1.2 (control budget), §3.0 (first ten seconds text), §3.4 (chips, sheets), §4
(entire UI inventory and chrome behaviour, wireframes), §10 (accessibility, responsive).

```ts
// ui/index.ts
export function createUI(root: HTMLElement, store: Store, glyphs: Glyphs): { dispose(): void };
```
`index.html` must contain `<div id="app">` with `<div id="stage">` (the renderer root; input binds
here) and `<div id="chrome">` (UI root), the viewport meta (`user-scalable=no`,
`viewport-fit=cover`), `<script type="module" src="/src/main.ts">`, and nothing else heavy.
`styles.css` defines tokens for both grounds (`:root[data-ground="night"|"paper"]` — the app sets
`data-ground` on `<html>`), reduced-motion and forced-colors rules, layout for phone / landscape /
tablet / desktop. UI reads `AppState` and dispatches `Intent`s only (app/types.ts), listens to
`AppEvent`s for toasts, announcements, pulses and hints. Chips implement tap-a-kind / drag-an-amount
(6 px dead zone, 500 ms long-press label, arrow keys when focused); sheets are dialogs with radiogroup
tiles rendered by `glyphs.tile`; budget of visible controls per state (DESIGN §1.2) is a hard rule.
**Sandbox:** `sandbox/ui/` with a mock Store + fake Glyphs; screenshot every state (rest, with ink,
after undo, zoomed, selection, each sheet, menu, help, toast, phone portrait 390×844, landscape,
Paper ground) and check the visible-control counts.

---

## 11. app  (wave 2, integration)

**Files:** `src/app/{store,controller,draft,selection,replay,firstrun,debug}.ts`, `src/main.ts`,
`src/export/png.ts`, `src/assets/seed.ts`, `scripts/e2e.mjs`. Resolves `docs/contract-requests/*`.
Wires: doc + history + scene + kitchen + renderer + input + ui + persistence + learner + frame loop;
owns the stroke lifecycle (DESIGN §7.4), selection, restyle, peel undo, erase, sampling, replay,
first-run seed, export, view chip state, hints, toasts, `?debug` → `window.__rise`.
