/**
 * The renderer (DESIGN §6.2, §6.7–§6.10, §3.2 choreography, §8 snapshot, §9 scheduling): owns the
 * canvas stack inside `deps.root`, the world tiles, the Night bloom, the live layer's host side
 * and the overlay, and composites them each frame the loop gives it.
 *
 * Which strokes are in the tiles. A document stroke is drawn into tiles ("eligible") unless it
 * is HELD by the live layer (committed or growing, waiting for its two-phase bake), LIFTED into
 * the selection layer, or not in the document. Every transition into eligibility is a CLAIM that
 * adds the stroke to the cached tiles it touches (render/tiles.ts explains why nothing is ever
 * drawn twice). Strokes the document adds are held as 'pending' until the end of the task:
 * a live commit / play turns that into a live hold, an explicit strokesAdded claims or grows them,
 * and anything left (an app path that forgot to tell the renderer) is claimed without animation.
 *
 * Choreography. Each operation that changes what the tiles show is a transaction: its tile work
 * (adds or dirty sub-rects) runs time-sliced while #base keeps the previous composite; once every
 * pending transaction's visible tiles are complete, ONE frame re-composites #base and runs their
 * commits (the bake's done(), the un-grow, the restyle morph, lift/drop), so a stroke never shows
 * twice or vanishes for a frame. A camera change forces the remaining visible work to finish
 * synchronously (DESIGN §6.2 edge cases).
 */
import type {
  AABB, Camera, Cooked, Doc, DocChange, Ground, Scene, StrokeId, StrokeRecipe, Vec2,
} from '../core/types';
import type {
  Glyphs, LiveHost, LiveLayer, LiveLayerInternal, Overlay, OverlayHost, OverlayInternal, RemoveAnim,
  Renderer, RendererDeps,
} from './types';
import { createLiveLayer, drawInk, type LiveHostExt } from './live';
import { createOverlay } from './overlay';
import { createGlyphs } from './glyphs';
import { TileCache, TILE_BYTES, type AddHint, type Drawable, type Tile, type TileDraw, type TileSource, type TileView } from './tiles';
import { capDpr, createCompositor, DIM_MS, opFor, snapshotDocBox, type Compositor } from './compositor';
export { capDpr, snapshotDocBox, MAX_VIEWPORT_PX } from './compositor';
import { createBloom, type Bloom } from './bloom';
import { createLedger, deviceClass, type CanvasLedgerExt } from './ledger';
import { inkTableFor, regionMatrix, viewMatrix, type DrawOpts } from './raster';
import { clampScale, sameCamera, snapToDevice } from './camera';
import { grainDataUrl, paintGround } from './ground';
import { conservativeBox } from '../scene/query';
import { endFrame, rstats } from './stats';

/** Camera settle delay before missing tiles render (DESIGN §6.9). */
export const SETTLE_MS = 150;
/** Strokes at most animated by un-grow / grow / morph; larger sets use a fade or no animation. */
export const MAX_ANIM_STROKES = 24;
/** Lift cap (DESIGN §3.4, §9 rule 10). */
export const LIFT_MAX_STROKES = 200;
export const LIFT_MAX_POINTS = 2_000_000;
/** Base fade for New / Open and large removals (DESIGN §3.2). */
export const RESET_FADE_MS = 200;
/** Ground swap cross-fade (DESIGN §3.5). */
export const GROUND_FADE_MS = 400;
/** A ground swap waits at most this long for the new ground's visible tiles before fading. */
const GROUND_WAIT_MS = 250;
/** Safety net: a live hold that never bakes is released after this long. */
const LIVE_HOLD_TIMEOUT_MS = 30000;
/** Coarse-pointer devices drop canvas pixels after this long in the background (DESIGN §6.10). */
const HIDDEN_LOSS_MS = 30000;
/** After purge(), tiles stay unallocated this long unless something needs them. */
const PURGE_REST_MS = 2000;
/** Boxes per transaction before they merge into their union. */
const TXN_MAX_BOXES = 16;
/** Tile-work slice for urgent transactions: this fraction of the frame, at most URGENT_MAX_MS. */
const URGENT_FRAC = 0.7, URGENT_MAX_MS = 12;
/**
 * After a purge, #base keeps its last picture until the view's tiles are rebuilt (no blank
 * flash), but never longer than this.
 */
const PURGE_REBUILD_MAX_MS = 1000;
/** Edited regions punched into the cold-load snapshot before it is dropped as a whole. */
const SNAP_MAX_HOLES = 64;

type HoldKind = 'pending' | 'live' | 'explicit';
interface Hold { kind: HoldKind; t: number }
interface Item { r: StrokeRecipe; c: Cooked }

interface Txn {
  boxes: AABB[];
  /**
   * A user-visible edit waiting on tiles (erase, undo, restyle, lift / drop): its tile work may
   * use a larger slice of the frame than background work (DESIGN §9: tiles updated ≤ 100 ms).
   */
  urgent?: boolean;
  /** Runs right before the composite that commits this transaction (cross-fade freeze). */
  before?: () => void;
  /** Runs right after that composite, in the same rAF. */
  commit?: () => void;
  /** Not ready before this clock time (drop waits for the un-dim transition). */
  notBefore?: number;
  /** Extra readiness condition (the post-purge rebuild gate). */
  ready?: () => boolean;
}

/** Optional Scene extras implemented by scene/scene.ts (SceneImpl). */
interface SceneExtras {
  cookedFor?(r: StrokeRecipe): Cooked | undefined;
  boxOf?(id: StrokeId): AABB | null;
}

/** Construction extras (all optional): shared ledger, injected live/overlay factories, clock. */
export interface RendererOptions extends RendererDeps {
  ledger?: CanvasLedgerExt;
  liveFactory?: (host: LiveHost) => LiveLayerInternal;
  overlayFactory?: (host: OverlayHost) => OverlayInternal;
  glyphs?: Glyphs;
  now?: () => number;
}

/** The renderer plus extras used by the app (replay holds, document switch) and tests. */
export interface RendererImpl extends Renderer {
  readonly host: LiveHost;
  readonly ledger: CanvasLedgerExt;
  /** Effective device pixel ratio of the ink layers (after the 3× and 8 MP caps). */
  readonly dpr: number;
  /**
   * True while the renderer still has work that will change the picture without further input:
   * a camera settle pending, transactions, tile work, cooks it asked for, a ground swap, live
   * animations (e2e `idle()`).
   */
  readonly busy: boolean;
  /** Internal counters for the `?debug` HUD and e2e diagnostics. */
  debug(): {
    txns: number; urgent: number; held: number; lifted: number; settled: boolean; suspended: boolean;
    tilePending: number; tileCount: number; tileBytes: number; level: number; ensuring: number;
    groundSwitch: boolean; bloomDirty: boolean; frameInterval: number; liveMs: number;
  };
  /** Keep strokes out of the tiles until the live layer bakes them (replay). */
  hold(ids: readonly StrokeId[]): void;
  /** Return held strokes to the tiles without animation. */
  release(ids: readonly StrokeId[]): void;
  /** Point the renderer at another document and scene (New / Open) and reset. */
  rebind(doc: Doc, scene: Scene, anim?: 'fade' | 'none'): void;
  dispose(): void;
}

const validBox = (b: AABB | null | undefined): b is AABB =>
  !!b && b.x1 >= b.x0 && b.y1 >= b.y0 && Number.isFinite(b.x0) && Number.isFinite(b.x1) && Number.isFinite(b.y0) && Number.isFinite(b.y1);

function union(a: AABB | null | undefined, b: AABB | null | undefined): AABB | null {
  const va = validBox(a), vb = validBox(b);
  if (!va && !vb) return null;
  if (!va) return { x0: b!.x0, y0: b!.y0, x1: b!.x1, y1: b!.y1 };
  if (!vb) return { x0: a!.x0, y0: a!.y0, x1: a!.x1, y1: a!.y1 };
  return { x0: Math.min(a!.x0, b!.x0), y0: Math.min(a!.y0, b!.y0), x1: Math.max(a!.x1, b!.x1), y1: Math.max(a!.y1, b!.y1) };
}

/** Create the renderer inside `deps.root`. */
export function createRenderer(deps: RendererDeps | RendererOptions): RendererImpl {
  const opts = deps as RendererOptions;
  const clock = opts.now ?? (() => performance.now());
  const ledger = opts.ledger ?? createLedger();
  let doc: Doc = deps.doc;
  let scene: Scene & SceneExtras = deps.scene;
  const requestFrame = (): void => deps.requestFrame();
  const reduced = (): boolean => { try { return !!deps.reducedMotion(); } catch { return false; } };

  // ------------------------------------------------------------------ state
  const meta = doc.meta;
  let cam: Camera = meta && meta.camera ? { cx: meta.camera.cx, cy: meta.camera.cy, scale: clampScale(meta.camera.scale), rot: 0 } : { cx: 0, cy: 0, scale: 1, rot: 0 };
  let ground: Ground = meta && meta.ground === 'paper' ? 'paper' : 'night';
  let cssW = 1, cssH = 1, dpr = 1, rawDpr = 1;
  const vp = { w: 1, h: 1 };
  let phase: 'gesture' | 'settled' = 'settled';
  let camDirty = false, viewDirty = true, baseDirty = true, bloomDirty = false;
  let settled = true, settleTimer = 0;
  /** #base was last composited with gesture-quality smoothing (re-composite on settle). */
  let lowQuality = false;
  /** The last real composite of #base: its camera and viewport, the tiles it blitted, their revision. */
  const ref = {
    cam: null as Camera | null, list: [] as Tile[], revs: [] as number[], rev: -1, complete: false, cssW: 0, cssH: 0, dpr: 0,
  };
  /** #base is shown under a CSS transform (transform-only gesture frames) instead of re-composited. */
  let baseXf = false;
  let liveKick = false, liveChanged = false, liveMs = 0;
  let lastFrameAt = -1, frameInterval = 1000 / 60;
  const held = new Map<StrokeId, Hold>();
  const lifted = new Map<StrokeId, Item>();
  const drawnBox = new Map<StrokeId, AABB>();
  const txns: Txn[] = [];
  const ensuring = new Set<StrokeId>();
  const skipBuf: StrokeId[] = [];
  const pendAdd = new Set<StrokeId>(), pendRem = new Map<StrokeId, AABB | null>(), pendRep = new Set<StrokeId>();
  let pendQueued = false;
  let selChain: Promise<void> = Promise.resolve();
  let suspended = false, purgeTimer = 0;
  let disposed = false;
  let groundSwitch: { from: Ground; deadline: number; animate: boolean } | null = null;
  /** Cold-load snapshot; `holes` are doc boxes edited since (the image is stale there). */
  let snap: { img: CanvasImageSource; w: number; h: number; cam: Camera; holes: AABB[] } | null = null;
  /** Async waits (cooks before an animation or a lift) that will still change the picture. */
  let waiting = 0;
  let lastSnapshot: { blob: Blob; cam: Camera } | null = null;
  let hiddenAt = 0;
  const coarse = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();

  // ------------------------------------------------------------------ layers
  const comp: Compositor = createCompositor(deps.root, ledger);
  const bloom: Bloom = createBloom(comp.bloomA, comp.bloomB, ledger);

  const view = (): TileView => ({ cam, cssW, cssH, dpr });
  const cls = deviceClass();
  const tileSoftCap = Math.max(24 * TILE_BYTES, Math.floor(ledger.cap * (cls === 'phone' ? 0.45 : 0.55)));

  // ------------------------------------------------------------------ tile source
  const eligible = (id: StrokeId): boolean => !held.has(id) && !lifted.has(id) && doc.has(id);

  function lossListener(c: HTMLCanvasElement): void {
    const lost = (): void => { tiles.markLost(c); baseDirty = true; requestFrame(); };
    c.addEventListener('contextlost', lost);
    c.addEventListener('contextrestored', lost);
  }

  const source: TileSource = {
    query(box, out) {
      scene.query(box, out);
      let w = 0;
      for (let i = 0; i < out.length; i++) if (eligible(out[i])) out[w++] = out[i];
      out.length = w;
      return out;
    },
    resolve(id, hint): Drawable | null | undefined {
      if (held.has(id) || lifted.has(id)) return undefined;
      const r = doc.get(id);
      if (!r) return undefined;
      let c = scene.cooked(id);
      if (!c && hint && hint.r.id === id && hint.r.geomRev === r.geomRev) c = hint.c;
      return c ? { r, c } : null;
    },
    alloc() {
      const c = ledger.alloc(512, 512, 'tile');
      if (c) lossListener(c);
      return c;
    },
    free(c) { ledger.free(c); },
    drawn(id, c) { drawnBox.set(id, c.inkBox); },
  };
  // tiles draw exactly like the live layer (Paper's per-generation alphas live in drawInk), so
  // live and baked ink agree (render-live contract request §2)
  const tileOpts: DrawOpts = {};
  const tileDraw: TileDraw = (ctx, d, m, clip, g) => {
    tileOpts.clipDev = clip;
    drawInk(ctx, d.c, inkTableFor(d.r, g), m, d.r.form.form, tileOpts);
  };
  const tiles = new TileCache(source, ground, tileSoftCap, tileDraw);
  ledger.onPressure(need => { tiles.evict(need); });

  // ------------------------------------------------------------------ overlay + live host
  const ovHost: OverlayHost = {
    canvas: comp.overlay,
    camera: () => cam,
    viewport: () => vp,
    get scene() { return scene; },
    get doc() { return doc; },
    ground: () => ground,
    requestFrame,
  };
  const overlay: OverlayInternal = (opts.overlayFactory ?? createOverlay)(ovHost);
  const host: LiveHostExt = {
    overlay,
    dry: comp.dry,
    wet: comp.wet,
    dpr: () => dpr,
    ground: () => ground,
    camera: () => cam,
    viewport: () => vp,
    matrixFor: (origin: Vec2) => viewMatrix(origin, cam, cssW, cssH, dpr),
    inkTable: r => inkTableFor(r, ground),
    bake,
    layerBlank: (l, b) => comp.setBlank(l, b),
    requestFrame,
    reducedMotion: reduced,
    now: () => clock(),
  };
  const live: LiveLayerInternal = (opts.liveFactory ?? createLiveLayer)(host);
  const glyphs: Glyphs = opts.glyphs ?? createGlyphs({ scene: () => scene, ledger });

  const touchLive = (): void => { liveChanged = true; requestFrame(); };

  /** The LiveLayer handed to the app: forwards to the live layer and tracks what it will bake. */
  const liveFacade: LiveLayer = {
    begin(d, cook) { touchLive(); live.begin(d, cook); },
    update() { touchLive(); live.update(); },
    predict(tail) { requestFrame(); live.predict(tail); },
    halo(h) { touchLive(); live.halo(h); },
    commit(r, c) { holdLive(r.id); touchLive(); live.commit(r, c); },
    withdraw() { touchLive(); live.withdraw(); },
    play(r, c, o) { if (!o || o.bake !== false) holdLive(r.id); touchLive(); live.play(r, c, o); },
    dissolve(ms) { touchLive(); live.dissolve(ms); },
    fastForward() { touchLive(); live.fastForward(); },
    get animating() { return live.animating; },
    get active() { return live.active; },
  };

  // ------------------------------------------------------------------ helpers
  function cookedOf(r: StrokeRecipe): Cooked | undefined {
    if (scene.cookedFor) return scene.cookedFor(r);
    const cur = doc.get(r.id);
    if (!cur || cur === r || (cur.geomRev === r.geomRev)) return scene.cooked(r.id);
    return undefined;
  }

  function boxOfStroke(id: StrokeId, r: StrokeRecipe | undefined, c: Cooked | undefined): AABB | null {
    if (c && validBox(c.inkBox)) return c.inkBox;
    const b = scene.boxOf ? scene.boxOf(id) : null;
    if (validBox(b)) return b;
    if (r) return conservativeBox(r, { x0: 0, y0: 0, x1: 0, y1: 0 });
    return null;
  }

  function pushTxn(t: Txn): void {
    if (t.boxes.length > TXN_MAX_BOXES) {
      let u: AABB | null = null;
      for (const b of t.boxes) u = union(u, b);
      t.boxes = u ? [u] : [];
    }
    txns.push(t);
    resume();
    requestFrame();
  }

  function txnReady(t: Txn): boolean {
    if (t.notBefore !== undefined && clock() < t.notBefore) return false;
    if (t.ready && !t.ready()) return false;
    for (const b of t.boxes) if (!tiles.readyFor(b)) return false;
    return true;
  }

  /** Track an async wait in `busy` (e2e idle must not resolve while it is pending). */
  function waitFor(p: Promise<unknown>, then: () => void): void {
    waiting++;
    const done = (): void => { waiting--; if (!disposed) then(); };
    p.then(done, done);
  }

  /** The cold-load snapshot no longer shows `b` truthfully (an edit): punch it out. */
  function holeSnap(b: AABB | null | undefined): void {
    if (!snap || !validBox(b)) return;
    if (snap.holes.length >= SNAP_MAX_HOLES) { dropSnap(); return; }
    snap.holes.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    baseDirty = true;
  }

  function dropSnap(): void {
    if (!snap && !comp.snap) return;
    snap = null;
    comp.snapCanvas(false);
  }

  /** Make an eligible-to-be stroke part of the tiles (adds on every cached tile it touches). */
  function claim(id: StrokeId, hint: AddHint | null, boxes: AABB[] | null): AABB | null {
    const r = doc.get(id);
    if (!r) return null;
    let c = scene.cooked(id);
    if (!c && hint && hint.r.geomRev === r.geomRev) c = hint.c;
    const box = union(boxOfStroke(id, r, c), hint ? hint.c.inkBox : null);
    if (!box) return null;
    tiles.add(id, box, hint ?? (c ? { r, c } : null));
    drawnBox.set(id, box);
    if (boxes) boxes.push(box);
    return box;
  }

  /** Remove a stroke from the tiles (dirty sub-rect re-render of where it was drawn). */
  function unclaim(id: StrokeId, extra: AABB | null, boxes: AABB[] | null): void {
    const b = union(drawnBox.get(id), extra);
    drawnBox.delete(id);
    if (!b) return;
    tiles.invalidate(b);
    if (boxes) boxes.push(b);
  }

  function holdLive(id: StrokeId): void {
    const h = held.get(id);
    const t = clock();
    if (h) { h.kind = 'live'; h.t = t; return; }
    const wasEligible = doc.has(id) && !lifted.has(id);
    held.set(id, { kind: 'live', t });
    if (wasEligible && drawnBox.has(id)) {
      const boxes: AABB[] = [];
      unclaim(id, null, boxes);
      pushTxn({ boxes });
    }
  }

  function liftedItems(): Item[] | null {
    return lifted.size ? [...lifted.values()] : null;
  }

  /**
   * End a purge's rest. With `gate`, #base keeps showing its pre-purge picture until the visible
   * tiles are rebuilt (a transaction that is ready only then; at most PURGE_REBUILD_MAX_MS), so
   * the canvas never flashes blank after an export. A forced (camera) composite ignores it.
   */
  function resume(gate = true): void {
    if (!suspended) return;
    suspended = false;
    tiles.suspended = false;
    if (purgeTimer) { clearTimeout(purgeTimer); purgeTimer = 0; }
    if (!gate) return;
    const until = clock() + PURGE_REBUILD_MAX_MS;
    txns.push({ boxes: [], ready: () => tiles.visibleComplete() || clock() >= until });
    requestFrame();
  }

  // ------------------------------------------------------------------ document safety net
  function onDoc(ch: DocChange): void {
    for (const id of ch.added) {
      pendRem.delete(id);
      if (!held.has(id) && !lifted.has(id)) { held.set(id, { kind: 'pending', t: clock() }); pendAdd.add(id); }
    }
    for (const id of ch.removed) {
      pendAdd.delete(id);
      pendRem.set(id, drawnBox.get(id) ?? null);
    }
    for (const id of ch.geometry) pendRep.add(id);
    for (const id of ch.color) pendRep.add(id);
    if ((ch.added.length || ch.removed.length || ch.geometry.length || ch.color.length) && !pendQueued) {
      pendQueued = true;
      queueMicrotask(settleDoc);
    }
  }

  /** End of task: claim, drop or refresh whatever no explicit call took care of. */
  function settleDoc(): void {
    pendQueued = false;
    if (disposed) return;
    const boxes: AABB[] = [];
    let liftedChanged = false;
    for (const [id, was] of pendRem) {
      if (doc.has(id)) continue;
      const h = held.get(id);
      if (h && h.kind !== 'explicit') held.delete(id);
      const li = lifted.get(id);
      if (li) { lifted.delete(id); liftedChanged = true; holeSnap(li.c.inkBox); }
      holeSnap(was);
      unclaim(id, null, boxes);
      tiles.forget(id);
    }
    for (const id of pendRep) {
      const r = doc.get(id);
      if (!r) continue;
      const li = lifted.get(id);
      if (li) {
        const c = scene.cooked(id);
        if (li.r !== r && c) { lifted.set(id, { r, c }); liftedChanged = true; }
        continue;
      }
      if (held.has(id)) continue;
      const c = scene.cooked(id);
      const b = union(drawnBox.get(id), boxOfStroke(id, r, c));
      if (b) { tiles.invalidate(b); boxes.push(b); drawnBox.set(id, b); holeSnap(b); }
    }
    for (const id of pendAdd) {
      const h = held.get(id);
      if (!h || h.kind !== 'pending') continue;
      held.delete(id);
      if (eligible(id)) claim(id, null, boxes);
    }
    pendAdd.clear(); pendRem.clear(); pendRep.clear();
    if (boxes.length || liftedChanged) {
      const items = liftedChanged ? liftedItems() : null;
      pushTxn({ boxes, commit: liftedChanged ? () => { setLiftedLayer(items); } : undefined });
    }
  }

  /**
   * Show `items` as the selection layer; when nothing is lifted any more, the rest of the drawing
   * un-dims (a Delete of the whole selection must not leave it at 45%).
   */
  function setLiftedLayer(items: Item[] | null): void {
    live.setLifted(items);
    if (items === null && comp.dimmed) {
      const anim = !reduced();
      comp.setDim(false, anim);
      bloom.setDim(false, anim);
    }
    liveKick = true;
  }

  let unsubscribe = doc.subscribe(onDoc);

  // ------------------------------------------------------------------ two-phase bake (LiveHost)
  function bake(r: StrokeRecipe, c: Cooked, done: () => void): void {
    const id = r.id;
    const h = held.get(id);
    if (h && h.kind !== 'explicit') held.delete(id);
    pendAdd.delete(id);
    const boxes: AABB[] = [];
    if (h && h.kind !== 'explicit' && doc.has(id) && !lifted.has(id)) {
      claim(id, { r, c }, boxes);
    } else if (!h && eligible(id) && validBox(c.inkBox)) {
      boxes.push(c.inkBox);  // already in the tiles: wait until they are consistent
    }
    pushTxn({ boxes, commit: done });
  }

  // ------------------------------------------------------------------ frame
  function finishGroundSwitch(): void {
    const gs = groundSwitch!;
    groundSwitch = null;
    if (gs.animate && !reduced()) comp.crossFade(GROUND_FADE_MS, gs.from);
    comp.setGround(ground, gs.animate && !reduced());
    bloom.setEnabled(ground === 'night', gs.animate && !reduced());
    live.onGround();
    liveKick = true;
    baseDirty = true;
    bloomDirty = ground === 'night';
  }

  function drawSnap(): void {
    const s = snap;
    if (!s) return;
    const sc = comp.snapCanvas(true);
    if (!sc) { snap = null; return; }
    const ctx = sc.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, sc.width, sc.height);
    const b = snapshotDocBox(s.w, s.h, s.cam, cssW, cssH);
    const k = cam.scale * dpr, hx = cssW * 0.5 * dpr, hy = cssH * 0.5 * dpr;
    const x0 = (b.x0 - cam.cx) * k + hx, y0 = (b.y0 - cam.cy) * k + hy;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.img, 0, 0, s.w, s.h, x0, y0, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
    // edited regions: the image shows ink that is gone or restyled there
    for (const hb of s.holes) {
      const hx0 = Math.floor((hb.x0 - cam.cx) * k + hx) - 2, hy0 = Math.floor((hb.y0 - cam.cy) * k + hy) - 2;
      const hx1 = Math.ceil((hb.x1 - cam.cx) * k + hx) + 2, hy1 = Math.ceil((hb.y1 - cam.cy) * k + hy) + 2;
      ctx.clearRect(hx0, hy0, hx1 - hx0, hy1 - hy0);
    }
    const cover = tiles.completeCells((x, y, w, h) => ctx.clearRect(x, y, w, h));
    if (cover.total > 0 && cover.done >= cover.total) {
      snap = null;
      comp.snapCanvas(false);
    }
  }

  function composite(): void {
    rstats.c.composites++;
    lowQuality = !settled;
    comp.composite(ctx => { tiles.drawInto(ctx, settled ? 'high' : 'low', ref.list); }, bloom.front, bloom.alpha);
    ref.cam = cam; ref.rev = tiles.contentRev; ref.cssW = cssW; ref.cssH = cssH; ref.dpr = dpr;
    ref.complete = tiles.lastDrawMissing === 0;
    tiles.revsOf(ref.list, ref.revs);
    if (baseXf) { comp.transformBase(''); baseXf = false; }
    if (snap) drawSnap();
    baseDirty = false;
  }

  /**
   * A gesture frame in which only the camera moved (DESIGN §6.2: #base is the tiles under the camera
   * transform). When the last composite, moved by a CSS transform, still covers the viewport (a
   * zoom in, or back towards where it was drawn), #base is transformed instead of redrawn: no
   * canvas work at all. That is exact when a fresh composite would blit the same unchanged tiles;
   * it is also used, up to a √2 magnification (one tile level), when the last composite was
   * complete and its tiles are unchanged but another level is cached for the new scale: the same
   * ink, resampled once more (DESIGN §6.9: during gestures stale tiles stay visible). The settle
   * re-composites #base at the settled camera.
   */
  function transformOnly(): boolean {
    const r = ref.cam;
    if (!r || phase !== 'gesture' || comp.blitting || snap) return false;
    if (ref.cssW !== cssW || ref.cssH !== cssH || ref.dpr !== dpr) return false;
    const f = cam.scale / r.scale;
    const tx = cssW * 0.5 * (1 - f) + (r.cx - cam.cx) * cam.scale;
    const ty = cssH * 0.5 * (1 - f) + (r.cy - cam.cy) * cam.scale;
    // the composited viewport [0, cssW] × [0, cssH] lands on [tx, tx + f·cssW] × [ty, ty + f·cssH]
    const e = 1e-3;
    if (tx > e || ty > e || tx + f * cssW < cssW - e || ty + f * cssH < cssH - e) return false;
    const exact = !tiles.inkChanged && tiles.contentRev === ref.rev && tiles.sameDisplay(ref.list);
    if (!exact && !(ref.complete && f <= Math.SQRT2 + 1e-9 && tiles.intact(ref.list, ref.revs))) return false;
    const identity = Math.abs(f - 1) < 1e-9 && Math.abs(tx) < 1e-6 && Math.abs(ty) < 1e-6;
    comp.transformBase(identity ? '' : `translate(${tx}px, ${ty}px) scale(${f})`);
    baseXf = !identity;
    tiles.changed = false;
    rstats.c.transformOnly++;
    return true;
  }

  function frame(now: number, budgetMs: number): boolean {
    const t0 = clock();
    const more = frameInner(now, budgetMs);
    const c = rstats.c;
    c.frames++;
    c.frameMs += clock() - t0;
    endFrame(now);
    return more;
  }

  function frameInner(now: number, budgetMs: number): boolean {
    if (disposed) return false;
    const t0 = clock();
    let more = false;
    // display frame interval from back-to-back frames (urgent slices scale with it)
    if (lastFrameAt >= 0) {
      const dt = now - lastFrameAt;
      if (dt > 4 && dt < 50) frameInterval = frameInterval * 0.9 + dt * 0.1;
    }
    lastFrameAt = now;

    // safety net for live holds that never baked
    if (held.size) {
      for (const [id, h] of held) {
        if (h.kind === 'live' && t0 - h.t > LIVE_HOLD_TIMEOUT_MS && !live.animating) {
          held.delete(id);
          if (eligible(id)) { const boxes: AABB[] = []; claim(id, null, boxes); pushTxn({ boxes }); }
        }
      }
    }

    // 1. camera / viewport
    let forced = false;
    const camOnly = camDirty && !viewDirty;
    if (camDirty || viewDirty) {
      tiles.setView(view());
      bloom.follow(view());
      if (camDirty) {
        live.onCamera(phase);  // a gesture fast-forwards and bakes every animating stroke
        resume();
      }
      if (groundSwitch) finishGroundSwitch();
      forced = true;
      camDirty = false; viewDirty = false;
    }

    // 2. live layer (dirty rects, reveals, hot trail; may request bakes)
    const tl = clock();
    if (live.frame(now)) { more = true; liveChanged = true; }
    liveMs = liveMs * 0.8 + (clock() - tl) * 0.2;

    // 3. tiles
    if (!suspended) tiles.ensureVisible();
    if (forced) tiles.flushDisplayed(txns.length > 0);
    const spent = clock() - t0;
    let tb = Math.max(1, budgetMs - spent);
    // a user-visible edit, or a ground swap waiting on the new ground's tiles (nothing else is on
    // screen to keep smooth, and every frame of waiting is latency on G)
    if (settled && !live.active && (groundSwitch !== null || txns.some(t => t.urgent))) {
      tb = Math.max(tb, Math.min(URGENT_MAX_MS, URGENT_FRAC * frameInterval) - spent);
    }
    // during a gesture only cached tiles composite (DESIGN §6.9): no background tile work
    if (!suspended && (settled || txns.length > 0) && tiles.run(settled ? tb : Math.min(tb, 2), clock)) more = true;
    if (tiles.takeSkipped(skipBuf).length) requestCooks(skipBuf);

    // 4. composite + commit transactions
    if (groundSwitch && (clock() >= groundSwitch.deadline || tiles.visibleComplete())) finishGroundSwitch();
    const allReady = txns.every(txnReady);
    const want = forced || baseDirty || tiles.changed || txns.length > 0;
    // a camera-only gesture frame may just move the last composite (no canvas work)
    const moved = want && !groundSwitch && camOnly && txns.length === 0 && !baseDirty && !liveKick && transformOnly();
    if (!moved && want && !groundSwitch && (forced || (!suspended && allReady && !tiles.busy()))) {
      const list = txns.splice(0, txns.length);
      for (const t of list) if (t.before) runSafe(t.before);
      if (tiles.inkChanged) { tiles.inkChanged = false; bloomDirty = ground === 'night'; }
      composite();
      for (const t of list) if (t.commit) runSafe(t.commit);
      if (list.length) {
        bloomDirty = ground === 'night';
        // commits change #dry (a bake's done() clears it): the blit fallback must re-layer #base
        liveChanged = true;
      }
      if (liveKick) {
        liveKick = false;
        if (live.frame(now)) more = true;
        liveChanged = true;
      }
    } else if (txns.length && settled && !suspended) more = true;

    // 5. overlay
    if (overlay.frame(now)) more = true;

    // 6. bloom (Night): after the gesture ends and the visible tiles settle (DESIGN §6.7: during a
    //    gesture the buffers follow the camera by CSS transform; a pause mid-gesture renders tiles
    //    but does not recompute the glow the next event would make stale again)
    if (bloomDirty && ground === 'night' && !groundSwitch) {
      if (settled && phase === 'settled' && txns.length === 0 && tiles.visibleComplete()) {
        bloom.render(comp.inkSource, view(), !reduced());
        bloomDirty = false;
        if (comp.blitting) liveChanged = true;
      } else if (settled && !suspended && tiles.pending > 0) more = true;
    }

    // 7. blit fallback: live layers are composited into #base
    if (comp.blitting && liveChanged) comp.recomposeLive(bloom.front, bloom.alpha);
    liveChanged = false;

    if (tiles.pending > 0 && !suspended && settled) more = true;
    return more;
  }

  function runSafe(fn: () => void): void {
    try { fn(); } catch (err) { console.error('[render] commit failed', err); }
  }

  function requestCooks(ids: readonly StrokeId[]): void {
    const batch: StrokeId[] = [];
    for (const id of ids) if (!ensuring.has(id)) { ensuring.add(id); batch.push(id); }
    if (!batch.length) return;
    scene.ensure(batch, 'visible').then(() => {
      for (const id of batch) {
        ensuring.delete(id);
        if (eligible(id) && scene.cooked(id)) tiles.cooked(id, null);
      }
      requestFrame();
    }, () => { for (const id of batch) ensuring.delete(id); });
  }

  // ------------------------------------------------------------------ settle timer
  /**
   * The camera changed in phase `ph`. A gesture keeps showing cached tiles until SETTLE_MS after its
   * last change (DESIGN §6.9); a settled camera (the gesture ended: navEnd, a glide's last step, a
   * reset) has nothing left to wait for and settles at once, so a wheel burst's end does not wait
   * out a second timer and re-render the glow twice.
   */
  function armSettle(ph: 'gesture' | 'settled'): void {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    // nothing cached to show meanwhile (first view, after reset/purge): render at once
    if (ph === 'settled' || tiles.tiles.size === 0) { settle(); return; }
    settled = false;
    tiles.settled = false;
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      settle();
      requestFrame();
    }, SETTLE_MS);
  }

  /** Missing tiles may render; the glow is stale; a gesture-quality #base is redone at 'high'. */
  function settle(): void {
    if (!settled) rstats.c.settles++;
    settled = true;
    tiles.settled = true;
    bloomDirty = true;
    if (lowQuality || baseXf) baseDirty = true;
  }

  // ------------------------------------------------------------------ public API
  function startGrow(items: Item[]): void {
    if (!items.length) return;
    for (const it of items) holdLive(it.r.id);
    pushTxn({ boxes: [], commit: () => { live.grow(items); liveKick = true; } });
  }

  function strokesAdded(items: readonly StrokeRecipe[], anim: 'grow' | 'none'): void {
    for (const r of items) pendAdd.delete(r.id);
    const present = items.filter(r => doc.has(r.id));
    const grow = anim === 'grow' && present.length <= MAX_ANIM_STROKES && !reduced();
    if (!grow) {
      const boxes: AABB[] = [];
      for (const r of present) {
        const h = held.get(r.id);
        // explicit holds wait for release(); a live hold is still shown by the live layer, and
        // its bake claims it (claiming it now would show it twice until then)
        if (h && (h.kind === 'explicit' || h.kind === 'live')) continue;
        if (h) held.delete(r.id);
        else if (drawnBox.has(r.id) || lifted.has(r.id)) continue;  // already in the tiles / lifted
        if (eligible(r.id)) claim(r.id, null, boxes);
      }
      pushTxn({ boxes });
      return;
    }
    const ready: Item[] = [], wait: StrokeRecipe[] = [];
    for (const r of present) {
      if (lifted.has(r.id)) continue;
      const c = cookedOf(r);
      if (c) ready.push({ r, c }); else wait.push(r);
      holdLive(r.id);
    }
    startGrow(ready);
    if (wait.length) {
      waitFor(scene.ensure(wait.map(r => r.id), 'visible'), () => {
        const later: Item[] = [];
        const boxes: AABB[] = [];
        for (const r of wait) {
          const h = held.get(r.id);
          if (!h || h.kind !== 'live' || doc.get(r.id) !== r) continue;
          const c = cookedOf(r);
          if (c) later.push({ r, c });
          else { held.delete(r.id); if (eligible(r.id)) claim(r.id, null, boxes); }
        }
        startGrow(later);
        if (boxes.length) pushTxn({ boxes });
      });
    }
  }

  function strokesRemoved(items: readonly StrokeRecipe[], anim: RemoveAnim): void {
    const boxes: AABB[] = [];
    const animItems: Item[] = [];
    let liftedGone: Item[] | null = null;
    let liveOwned = false;
    for (const r of items) {
      const id = r.id;
      pendRem.delete(id);
      pendAdd.delete(id);
      if (doc.has(id)) continue;
      const c = cookedOf(r);
      const li = lifted.get(id);
      if (li) {
        lifted.delete(id);
        (liftedGone ??= []).push(li);
        holeSnap(li.c.inkBox);
        continue;
      }
      const h = held.get(id);
      if (h && h.kind !== 'explicit') { held.delete(id); if (h.kind === 'live') liveOwned = true; }
      holeSnap(union(drawnBox.get(id), c ? c.inkBox : null));
      if (drawnBox.has(id)) unclaim(id, c ? c.inkBox : null, boxes);
      tiles.forget(id);
      if (c) animItems.push({ r, c });
    }
    // an undo during a stroke's own animation: finish it first (its bake becomes a no-op)
    if (liveOwned) live.fastForward();
    const ungrow = anim === 'ungrow' && !reduced() && animItems.length > 0 && animItems.length <= MAX_ANIM_STROKES;
    const fade = !reduced() && (anim === 'fade' || (anim === 'ungrow' && animItems.length > MAX_ANIM_STROKES)) && boxes.length > 0;
    const rest = liftedGone ? liftedItems() : null;
    const gone = liftedGone;
    pushTxn({
      boxes,
      urgent: true,
      before: fade ? () => comp.crossFade(RESET_FADE_MS, ground) : undefined,
      commit: () => {
        if (gone) {
          setLiftedLayer(rest);
          if (anim !== 'none' && !reduced()) live.ungrow(gone);
        }
        if (ungrow) live.ungrow(animItems);
        liveKick = true;
      },
    });
  }

  function strokesReplaced(before: readonly StrokeRecipe[], after: readonly StrokeRecipe[], anim: 'morph' | 'none'): void {
    const byId = new Map<StrokeId, StrokeRecipe>();
    for (const r of before) byId.set(r.id, r);
    const pairs: { b: StrokeRecipe | null; a: StrokeRecipe }[] = [];
    let liftedChanged = false;
    const waitLift: StrokeRecipe[] = [];
    for (const a of after) {
      pendRep.delete(a.id);
      if (doc.get(a.id) !== a) continue;
      const li = lifted.get(a.id);
      if (li) {
        const c = cookedOf(a);
        if (c) { lifted.set(a.id, { r: a, c }); liftedChanged = true; } else waitLift.push(a);
        continue;
      }
      pairs.push({ b: byId.get(a.id) ?? null, a });
    }
    if (liftedChanged) {
      const items = liftedItems();
      pushTxn({ boxes: [], commit: () => { live.setLifted(items); liveKick = true; } });
    }
    if (waitLift.length) {
      waitFor(scene.ensure(waitLift.map(r => r.id), 'visible'), () => {
        let any = false;
        for (const a of waitLift) {
          const c = cookedOf(a);
          if (c && lifted.has(a.id) && doc.get(a.id) === a) { lifted.set(a.id, { r: a, c }); any = true; }
        }
        if (any) { const items = liftedItems(); pushTxn({ boxes: [], commit: () => { live.setLifted(items); liveKick = true; } }); }
      });
    }
    if (!pairs.length) return;

    const plain = (ps: typeof pairs): void => {
      const boxes: AABB[] = [];
      for (const p of ps) {
        if (held.has(p.a.id) || doc.get(p.a.id) !== p.a || lifted.has(p.a.id)) continue;
        const cb = p.b ? cookedOf(p.b) : undefined;
        const ca = cookedOf(p.a);
        const b = union(union(drawnBox.get(p.a.id), cb ? cb.inkBox : null), boxOfStroke(p.a.id, p.a, ca));
        if (!b) continue;
        tiles.invalidate(b);
        drawnBox.set(p.a.id, b);
        boxes.push(b);
        holeSnap(b);
      }
      pushTxn({ boxes, urgent: true });
    };

    const morph = anim === 'morph' && !reduced() && pairs.length <= MAX_ANIM_STROKES;
    const go = (): void => {
      if (!morph) { plain(pairs); return; }
      const bItems: Item[] = [], aItems: Item[] = [], boxes: AABB[] = [];
      const fallbackPairs: typeof pairs = [];
      for (const p of pairs) {
        if (doc.get(p.a.id) !== p.a || lifted.has(p.a.id)) continue;
        const cb = p.b ? cookedOf(p.b) : undefined;
        const ca = cookedOf(p.a);
        if (!ca || !p.b || !cb) { fallbackPairs.push(p); continue; }
        const h = held.get(p.a.id);
        if (h && h.kind === 'explicit') { fallbackPairs.push(p); continue; }
        held.set(p.a.id, { kind: 'live', t: clock() });
        holeSnap(union(drawnBox.get(p.a.id), union(cb.inkBox, ca.inkBox)));
        unclaim(p.a.id, cb.inkBox, boxes);
        bItems.push({ r: p.b, c: cb });
        aItems.push({ r: p.a, c: ca });
      }
      if (fallbackPairs.length) plain(fallbackPairs);
      if (aItems.length) pushTxn({ boxes, urgent: true, commit: () => { live.morph(bItems, aItems); liveKick = true; } });
    };
    // the new geometry must exist before the old one leaves the tiles, or the stroke would blink
    // out until it cooks (the tiles still show the old version meanwhile)
    const missing = pairs.filter(p => !cookedOf(p.a)).map(p => p.a.id);
    if (!missing.length) go();
    else waitFor(scene.ensure(missing, 'visible'), go);
  }

  function reset(anim: 'fade' | 'none'): void {
    resume(false);
    const fade = anim === 'fade' && !reduced();
    if (fade) comp.crossFade(RESET_FADE_MS, ground);
    tiles.dropAll();
    for (const [id, h] of held) if (h.kind !== 'explicit') held.delete(id);
    const hadLift = lifted.size > 0;
    lifted.clear();
    if (hadLift) live.setLifted(null);
    comp.setDim(false, false);
    bloom.setDim(false, false);
    drawnBox.clear();
    pendAdd.clear(); pendRem.clear(); pendRep.clear();
    for (const t of txns) t.boxes = [];
    // the glow leaves with the ink it belonged to (fades with #base) instead of popping off
    if (fade) bloom.fadeOut(RESET_FADE_MS); else bloom.clear();
    // a cold-load snapshot shows the previous document: drop it (show the new one afterwards)
    dropSnap();
    bloomDirty = ground === 'night';
    baseDirty = true;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    settled = true; tiles.settled = true;
    requestFrame();
  }

  function doLift(ids: readonly StrokeId[]): Promise<void> {
    const want = ids.filter(id => doc.has(id));
    waiting++;
    const ensure = want.length ? scene.ensure(want, 'visible').catch(() => undefined) : Promise.resolve();
    return ensure.then(() => new Promise<void>(resolve => {
      waiting--;
      if (disposed) { resolve(); return; }
      const next = new Map<StrokeId, Item>();
      let pts = 0;
      for (const id of want) {
        const r = doc.get(id);
        const c = r ? scene.cooked(id) : undefined;
        if (!r || !c) continue;
        next.set(id, { r, c });
        pts += c.nPts;
      }
      if (next.size > LIFT_MAX_STROKES || pts > LIFT_MAX_POINTS) next.clear();
      const boxes: AABB[] = [];
      // drop strokes no longer selected (two-phase: they bake back before the layer forgets them)
      for (const [id, it] of lifted) {
        if (next.has(id)) continue;
        lifted.delete(id);
        if (eligible(id)) claim(id, it, boxes);
      }
      // lift the newly selected ones out of the tiles
      for (const [id, it] of next) {
        if (lifted.has(id)) { lifted.set(id, it); continue; }
        const h = held.get(id);
        if (h && h.kind === 'live') continue;  // still in the live layer: not in the tiles yet
        lifted.set(id, it);
        holeSnap(it.c.inkBox);
        unclaim(id, it.c.inkBox, boxes);
      }
      const items = liftedItems();
      const anim = !reduced();
      // Drop: un-dim FIRST, while the dropped strokes still show at full strength in #dry, and bake
      // them back only once #base is at full opacity again; baking them into a still-dimmed #base
      // would flash them down to 45% and back up during the 160 ms transition.
      const undim = items === null && comp.dimmed && anim && boxes.length > 0;
      if (undim) { comp.setDim(false, true); bloom.setDim(false, true); }
      pushTxn({
        boxes,
        urgent: true,
        notBefore: undim ? clock() + DIM_MS : undefined,
        commit: () => {
          live.setLifted(items);
          if (undim) comp.finishDim();  // a forced (camera) composite may come early
          comp.setDim(items !== null, anim);
          bloom.setDim(items !== null, anim);
          liveKick = true;
          resolve();
        },
      });
    }));
  }

  function lift(ids: readonly StrokeId[]): Promise<void> {
    const p = selChain.then(() => doLift(ids));
    selChain = p.catch(() => undefined);
    return p;
  }

  function drop(): Promise<void> {
    return lift([]);
  }

  /**
   * Live restyle preview of the lifted selection. Items that are not lifted are ignored: they are
   * still in the tiles (over the lift cap, or held by the live layer), so drawing them in the
   * selection layer would show them twice.
   */
  function previewLifted(items: readonly { r: StrokeRecipe; c: Cooked }[] | null): void {
    let show: readonly { r: StrokeRecipe; c: Cooked }[] | null = liftedItems();
    if (items) {
      let all = true;
      for (const it of items) if (!lifted.has(it.r.id)) { all = false; break; }
      show = all ? items : items.filter(it => lifted.has(it.r.id));
    }
    live.setLifted(show && show.length ? show : null);
    touchLive();
  }

  function setGround(g: Ground, animate: boolean): void {
    if (g === ground && !groundSwitch) { comp.setGround(g, false); return; }
    resume(false);
    const from = groundSwitch ? groundSwitch.from : ground;
    ground = g;
    tiles.ground = g;
    tiles.dropAll();
    drawnBox.clear();
    dropSnap();  // the snapshot was taken on the other ground
    const anim = animate && !reduced();
    if (anim && from !== g) {
      // the bloom keeps glowing over the old picture until the swap, then fades with it
      // (finishGroundSwitch: setEnabled on the new ground, animated)
      groundSwitch = { from, deadline: clock() + GROUND_WAIT_MS, animate: true };
    } else {
      groundSwitch = null;
      bloom.clear();
      comp.setGround(g, false);
      bloom.setEnabled(g === 'night', false);
      live.onGround();
      liveKick = true;
      bloomDirty = g === 'night';
    }
    baseDirty = true;
    requestFrame();
  }

  function resize(w: number, h: number, d: number): void {
    const W = Math.max(1, w), H = Math.max(1, h);
    const eff = capDpr(d, W, H);
    if (W === cssW && H === cssH && eff === dpr && d === rawDpr) return;
    const dprChanged = d !== rawDpr;
    cssW = W; cssH = H; dpr = eff; rawDpr = d;
    vp.w = W; vp.h = H;
    comp.resize(W, H, eff);
    bloom.resize(W, H, eff);
    overlay.resize(W, H, Math.min(eff, 2));
    if (dprChanged) comp.setGround(ground, false);  // grain at one texel per device pixel
    if (phase === 'settled') cam = snapToDevice(cam, cssW, cssH, dpr);
    live.resize();
    resume(false);  // #base was cleared by the resize: no picture to keep
    viewDirty = true;
    baseDirty = true;
    bloomDirty = ground === 'night';
    requestFrame();
  }

  function setCamera(c: Camera, ph: 'gesture' | 'settled'): void {
    const base: Camera = { cx: c.cx, cy: c.cy, scale: clampScale(c.scale), rot: 0 };
    if (!Number.isFinite(base.cx) || !Number.isFinite(base.cy)) return;
    const next = ph === 'settled' ? snapToDevice(base, cssW, cssH, dpr) : base;
    const moved = !sameCamera(next, cam);
    if (!moved && ph === phase) return;
    rstats.c.setCamera++;
    cam = next;
    phase = ph;
    // a phase change alone (a gesture ending where it stood) needs no forced composite: the settle
    // re-composites a gesture-quality #base and refreshes the glow
    if (moved) {
      camDirty = true;
      comp.endFade();
    }
    armSettle(ph);
    requestFrame();
  }

  // ------------------------------------------------------------------ region rendering (export, glyphs)
  function* renderRegion(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, box: AABB,
    pxPerDoc: number, g: Ground, withGround: boolean): Generator<void, StrokeId[]> {
    const skipped: StrokeId[] = [];
    const W = Math.max(1, Math.ceil((box.x1 - box.x0) * pxPerDoc)), H = Math.max(1, Math.ceil((box.y1 - box.y0) * pxPerDoc));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (withGround) paintGround(ctx, W, H, g);
    const ids = scene.query(box, []);
    const o: DrawOpts = { clipDev: { x0: 0, y0: 0, x1: W, y1: H } };
    for (const id of ids) {
      const r = doc.get(id);
      if (!r) continue;
      const c = scene.cooked(id);
      if (!c) { skipped.push(id); continue; }
      if (!(c.inkBox.x1 >= box.x0 && c.inkBox.x0 <= box.x1 && c.inkBox.y1 >= box.y0 && c.inkBox.y0 <= box.y1)) continue;
      drawInk(ctx, c, inkTableFor(r, g), regionMatrix(r.origin, box, pxPerDoc), r.form.form, o);
      yield;
    }
    return skipped;
  }

  // ------------------------------------------------------------------ snapshots
  function snapshot(maxEdge: number): Promise<Blob | null> {
    const f = Math.min(dpr, maxEdge > 0 ? maxEdge / Math.max(cssW, cssH) : dpr);
    const W = Math.max(1, Math.round(cssW * f)), H = Math.max(1, Math.round(cssH * f));
    // a transform-only gesture frame left #base drawn for another camera: composite it for this one
    if (baseXf && !comp.blitting) { tiles.flushDisplayed(false); composite(); }
    const c = ledger.alloc(W, H, 'snapshot');
    if (!c) return Promise.resolve(null);
    const ctx = c.getContext('2d')!;
    paintGround(ctx, W, H, ground);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // during a cold load the previous snapshot still stands in for tiles that are not done yet
    const under = comp.snap;
    if (under && snap) ctx.drawImage(under, 0, 0, under.width, under.height, 0, 0, W, H);
    const op = opFor(ground);
    if (comp.blitting) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(comp.base, 0, 0, comp.base.width, comp.base.height, 0, 0, W, H);
    } else {
      ctx.globalCompositeOperation = op;
      ctx.drawImage(comp.base, 0, 0, comp.base.width, comp.base.height, 0, 0, W, H);
      const bf = bloom.front;
      if (ground === 'night' && bf) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = bloom.alpha;
        ctx.drawImage(bf, 0, 0, bf.width, bf.height, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = op;
      ctx.drawImage(comp.dry, 0, 0, comp.dry.width, comp.dry.height, 0, 0, W, H);
      ctx.drawImage(comp.wet, 0, 0, comp.wet.width, comp.wet.height, 0, 0, W, H);
    }
    ctx.restore();
    const camAt: Camera = { ...cam };
    return new Promise<Blob | null>(resolve => {
      const done = (b: Blob | null): void => {
        ledger.free(c);
        if (b) lastSnapshot = { blob: b, cam: camAt };
        resolve(b);
      };
      try {
        c.toBlob(b => {
          if (b && b.type === 'image/webp') { done(b); return; }
          try { c.toBlob(p => done(p), 'image/png'); } catch { done(null); }
        }, 'image/webp', 0.85);
      } catch { done(null); }
    });
  }

  function showSnapshot(img: ImageBitmap | HTMLImageElement | null, c: Camera | null): void {
    if (!img || !c) { snap = null; comp.snapCanvas(false); return; }
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
    if (!(w > 0 && h > 0)) return;
    snap = { img, w, h, cam: { cx: c.cx, cy: c.cy, scale: clampScale(c.scale), rot: 0 }, holes: [] };
    baseDirty = true;
    requestFrame();
  }

  // ------------------------------------------------------------------ robustness
  for (const c of [comp.base, comp.dry, comp.wet]) {
    const restored = (): void => {
      baseDirty = true; bloomDirty = ground === 'night';
      liveKick = true;
      live.onCamera('settled');
      requestFrame();
    };
    c.addEventListener('contextrestored', restored);
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') { hiddenAt = clock(); return; }
    if (!hiddenAt) return;
    const away = clock() - hiddenAt;
    hiddenAt = 0;
    if (!coarse || away < HIDDEN_LOSS_MS) return;
    tiles.markAllLost();
    bloomDirty = ground === 'night';
    baseDirty = true;
    live.onCamera('settled');
    const ls = lastSnapshot;
    if (ls && typeof createImageBitmap === 'function') {
      createImageBitmap(ls.blob).then(bmp => { if (!disposed) showSnapshot(bmp, ls.cam); }, () => undefined);
    }
    requestFrame();
  };
  document.addEventListener('visibilitychange', onVisibility);

  function purge(): void {
    tiles.dropAll();
    drawnBox.clear();
    // the bloom buffers stay (¼-res, small) so the glow does not vanish while #base keeps its
    // picture during an export; only the scratch chain goes
    bloom.freeScratch();
    comp.endFade();
    suspended = true;
    tiles.suspended = true;
    if (purgeTimer) clearTimeout(purgeTimer);
    purgeTimer = window.setTimeout(() => { purgeTimer = 0; resume(); baseDirty = true; requestFrame(); }, PURGE_REST_MS);
  }

  // ------------------------------------------------------------------ assemble
  comp.setGround(ground, false);
  bloom.setEnabled(ground === 'night', false);
  // the other ground's grain is encoded once (toDataURL): do it while idle, not on the first flip
  const warm = (): void => { if (!disposed) grainDataUrl(ground === 'night' ? 'paper' : 'night'); };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(warm, { timeout: 3000 }); else window.setTimeout(warm, 1500);

  const renderer: RendererImpl = {
    resize, setCamera, setGround,
    getCamera: () => cam,
    strokesAdded, strokesRemoved, strokesReplaced, reset,
    lift, drop, previewLifted,
    live: liveFacade,
    overlay: overlay as Overlay,
    glyphs,
    renderRegion,
    snapshot, showSnapshot,
    frame, purge,
    get stats() {
      return { tiles: tiles.count, canvasBytes: ledger.bytes, pendingTiles: tiles.pending, animating: live.animating };
    },
    host, ledger,
    get dpr() { return dpr; },
    get busy() {
      return settleTimer !== 0 || txns.length > 0 || tiles.pending > 0 || ensuring.size > 0 || waiting > 0 || groundSwitch !== null ||
        live.animating > 0 || pendQueued || (bloomDirty && ground === 'night' && !suspended && phase === 'settled');
    },
    debug() {
      return {
        txns: txns.length, urgent: txns.filter(t => t.urgent).length, held: held.size, lifted: lifted.size,
        settled, suspended, tilePending: tiles.pending, tileCount: tiles.count, tileBytes: tiles.bytes,
        level: tiles.level, ensuring: ensuring.size, groundSwitch: groundSwitch !== null, bloomDirty,
        frameInterval, liveMs,
      };
    },
    hold(ids) {
      for (const id of ids) {
        const h = held.get(id);
        if (h) { h.kind = 'explicit'; continue; }
        held.set(id, { kind: 'explicit', t: clock() });
        if (drawnBox.has(id)) { const boxes: AABB[] = []; unclaim(id, null, boxes); pushTxn({ boxes }); }
      }
    },
    release(ids) {
      const boxes: AABB[] = [];
      for (const id of ids) {
        const h = held.get(id);
        // a live hold is still on screen in the live layer: its bake returns it to the tiles
        if (!h || h.kind === 'live') continue;
        held.delete(id);
        if (eligible(id)) claim(id, null, boxes);
      }
      pushTxn({ boxes });
    },
    rebind(d, s, anim = 'none') {
      unsubscribe();
      doc = d; scene = s;
      unsubscribe = doc.subscribe(onDoc);
      held.clear();
      reset(anim);
    },
    dispose() {
      disposed = true;
      unsubscribe();
      if (settleTimer) clearTimeout(settleTimer);
      if (purgeTimer) clearTimeout(purgeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      tiles.dropAll();
      bloom.purge();
      comp.dispose();
    },
  };
  return renderer;
}
