/**
 * World tiles (DESIGN §6.2, §6.9, §9 LOD rule 6): committed ink rasterised into 512² device-px
 * canvases at half-octave levels, keyed (level, ix, iy), kept in an LRU through the ledger.
 *
 *  - Level ℓ = ceil(2·log2(scale·dpr)); density 2^(ℓ/2) device px per doc unit, so a tile is
 *    oversampled by at most √2 and blitted at a scale in (1/√2, 1].
 *  - Night tiles start transparent and are drawn with 'lighter'; Paper tiles start white and are
 *    drawn with 'multiply'. Both are order-independent, so a new stroke is simply drawn on top of
 *    the tiles it touches (an "add"), and a removal re-renders only the dirty sub-rect (clip,
 *    clear, redraw the strokes whose boxes intersect it).
 *  - Work is time-sliced one stroke per step and scheduled by priority: adds on visible tiles,
 *    then visible renders (centre-out), then the prefetch ring, then other levels.
 *
 * Consistency rules (why a stroke is never drawn twice into a tile):
 *  1. A render takes a SNAPSHOT of the eligible strokes when it starts; strokes claimed later
 *     (claim epoch newer than the render) are never drawn by it.
 *  2. Every claim queues an add on each cached tile it touches, and a tile drains its pending adds
 *     before any render takes its snapshot. Adds that run while a render is in progress draw
 *     strokes that render will skip (rule 1), so each eligible stroke lands exactly once.
 *  3. A tile that still needs its first full render drops pending adds: its snapshot includes them.
 * An in-place render of a displayed tile leaves it inconsistent until it finishes, so the
 * renderer never re-composites #base while one is running (`busy`), or finishes it synchronously
 * when the camera forces a composite (`flushDisplayed`).
 *
 * No per-step allocation beyond the matrix drawCooked needs; scratch boxes are reused.
 */
import type { AABB, Camera, Cooked, Ground, StrokeId, StrokeRecipe } from '../core/types';
import { drawCooked, inkTableFor, regionMatrix } from './raster';

/** Tile edge in device px. */
export const TILE_PX = 512;
/** Bytes of one tile canvas. */
export const TILE_BYTES = TILE_PX * TILE_PX * 4;
/** Anti-aliasing margin (device px) added around every dirty rect and query box. */
const AA_PAD = 2;
/** Dirty rects kept per tile before they collapse into their union. */
const MAX_RECTS = 8;
/** Levels further than this from the current level are never used as fallback. */
const FALLBACK_SPAN = 6;

/** Tile level for a camera scale at a device pixel ratio: ceil(2·log2(scale·dpr)). */
export function levelFor(scale: number, dpr: number): number {
  const s = scale * dpr;
  if (!(s > 0) || !Number.isFinite(s)) return 0;
  const l = Math.ceil(2 * Math.log2(s) - 1e-9);
  return l === 0 ? 0 : l;  // never -0
}

/** Tile density (device px per doc unit) of a level: 2^(ℓ/2). */
export function densityOf(level: number): number {
  const h = Math.floor(level / 2);
  const base = Math.pow(2, h);
  return level - 2 * h === 1 ? base * Math.SQRT2 : base;
}

/** Doc extent of one tile at a level. */
export function tileDocSize(level: number): number {
  return TILE_PX / densityOf(level);
}

/** Integer device-px rect inside a tile, half-open [x0, x1). */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Optional geometry carried by an add (a bake hands over the geometry it just showed). */
export interface AddHint { r: StrokeRecipe; c: Cooked }

/** What a tile needs to draw a stroke. */
export interface Drawable { r: StrokeRecipe; c: Cooked }

/** The renderer's view of the document for tile rendering. */
export interface TileSource {
  /** Eligible (drawable-in-tiles) stroke ids whose indexed box meets `box` (absolute doc), z-ordered. */
  query(box: AABB, out: StrokeId[]): StrokeId[];
  /**
   * Geometry for an id at draw time: undefined when it is no longer eligible (skip silently),
   * null when it is eligible but not cooked yet (recorded as skipped; see `takeSkipped`).
   */
  resolve(id: StrokeId, hint: AddHint | null): Drawable | null | undefined;
  /** A 512² canvas (through the ledger), or null when memory is refused. */
  alloc(): HTMLCanvasElement | null;
  free(c: HTMLCanvasElement): void;
  /** A stroke was drawn into a tile (the renderer records its box for later invalidation). */
  drawn?(id: StrokeId, c: Cooked, tile: Tile): void;
}

/** Draws one stroke into a tile context (default: render-core's drawCooked with the ink table). */
export type TileDraw = (ctx: CanvasRenderingContext2D, d: Drawable, m: Float64Array, clip: Rect, ground: Ground) => void;

const defaultDraw: TileDraw = (ctx, d, m, clip, ground) => {
  drawCooked(ctx, d.c, inkTableFor(d.r, ground), m, { clipDev: clip });
};

/** Camera + viewport the tiles are composited for. */
export interface TileView { cam: Camera; cssW: number; cssH: number; dpr: number }

interface Job {
  /** Bounding rect of the job (poly culling, skipped-stroke bookkeeping). */
  rect: Rect;
  /** The dirty rects themselves (one clip region); null = just `rect`. */
  rects: Rect[] | null;
  ids: StrokeId[];
  i: number;
  epoch: number;
  /** Ids this job must not draw: a whole-stroke add took them over while it ran. */
  skip: Set<StrokeId> | null;
  inPlace: boolean; // the tile was displayable when the job started
  clip: boolean;    // rect smaller than the tile: draw through a clip
}

/** One cached tile. */
export interface Tile {
  readonly key: string;
  readonly level: number; readonly ix: number; readonly iy: number;
  readonly x0: number; readonly y0: number; readonly size: number; readonly dens: number;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  /** Content is complete (as of its renders) and may be displayed. */
  ready: boolean;
  /** Needs a full render (new, or its pixels were lost). */
  needFull: boolean;
  /** Allocation was refused: treated as an empty, complete tile. */
  failed: boolean;
  rects: Rect[];
  adds: Map<StrokeId, AddHint | null>;
  job: Job | null;
  /**
   * Eligible strokes that could not be drawn because they were not cooked yet, with where they
   * are missing: null = the whole tile (never drawn here), else the rect a dirty render skipped.
   */
  skipped: Map<StrokeId, Rect | null> | null;
  used: number;
}

const FULL: Readonly<Rect> = { x0: 0, y0: 0, x1: TILE_PX, y1: TILE_PX };
const keyOf = (level: number, ix: number, iy: number): string => level + ':' + ix + ':' + iy;

/** Priority classes (lower runs first). */
const P_ADD = 0, P_VISIBLE = 1, P_PREFETCH = 3, P_OTHER = 5, P_NONE = 99;

/**
 * The tile cache for one ground. The renderer drives it: setView on camera/viewport changes,
 * add/invalidate on document changes, run() inside frame(), drawInto() to composite #base.
 */
export class TileCache {
  readonly tiles = new Map<string, Tile>();
  /** Current level and its geometry. */
  level = 0;
  dens = 1;
  size = TILE_PX;
  /** Visible cell range at the current level (inclusive), and the prefetch ring around it. */
  vx0 = 0; vy0 = 0; vx1 = -1; vy1 = -1;
  /** Missing visible tiles are created only when true (150 ms after the last camera change). */
  settled = true;
  /** Creating tiles is suspended (after purge) while true. */
  suspended = false;
  /** Visible content changed since the last drawInto (the renderer re-composites). */
  changed = false;
  /**
   * Ink inside the view changed (not just the camera) since the renderer last cleared this flag:
   * derived layers built from the composite (bloom) are stale.
   */
  inkChanged = false;
  ground: Ground;
  private view: TileView = { cam: { cx: 0, cy: 0, scale: 1, rot: 0 }, cssW: 1, cssH: 1, dpr: 1 };
  private stamp = 1;
  private epoch = 0;
  private claimEpoch = new Map<StrokeId, number>();
  private skippedAll = new Set<StrokeId>();
  private box: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private qbox: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private vbox: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private missing = new Uint8Array(64);
  private work = new Set<Tile>();
  private bytesNow = 0;
  /** The tile whose canvas is being allocated (never evicted by the pressure callback). */
  private allocating: Tile | null = null;
  /** Soft cap on tile bytes (the ledger's onPressure is the hard backstop). */
  softCap: number;

  private draw: TileDraw;

  constructor(private src: TileSource, ground: Ground, softCapBytes: number, draw?: TileDraw) {
    this.ground = ground;
    this.softCap = softCapBytes;
    this.draw = draw ?? defaultDraw;
  }

  // ------------------------------------------------------------------ view

  /** Update the camera/viewport; recomputes the level and the visible cell range. */
  setView(v: TileView): void {
    this.view = v;
    const prev = this.level;
    this.level = levelFor(v.cam.scale, v.dpr);
    if (this.level !== prev) {
      // never-rendered tiles of the old level hold no pixels and will never be rendered
      for (const t of [...this.tiles.values()]) if (t.needFull && !t.job && !t.canvas && t.level !== this.level) this.drop(t);
    }
    this.dens = densityOf(this.level);
    this.size = TILE_PX / this.dens;
    const hw = (v.cssW * 0.5) / v.cam.scale, hh = (v.cssH * 0.5) / v.cam.scale;
    const T = this.size;
    this.vx0 = Math.floor((v.cam.cx - hw) / T);
    this.vy0 = Math.floor((v.cam.cy - hh) / T);
    this.vx1 = Math.ceil((v.cam.cx + hw) / T) - 1;
    this.vy1 = Math.ceil((v.cam.cy + hh) / T) - 1;
    if (this.vx1 < this.vx0) this.vx1 = this.vx0;
    if (this.vy1 < this.vy0) this.vy1 = this.vy0;
    this.changed = true;
  }

  /** Doc box of the visible area (absolute). */
  visibleDocBox(out: AABB): AABB {
    const v = this.view;
    const hw = (v.cssW * 0.5) / v.cam.scale, hh = (v.cssH * 0.5) / v.cam.scale;
    out.x0 = v.cam.cx - hw; out.y0 = v.cam.cy - hh; out.x1 = v.cam.cx + hw; out.y1 = v.cam.cy + hh;
    return out;
  }

  private isVisible(t: Tile): boolean {
    return t.level === this.level && t.ix >= this.vx0 && t.ix <= this.vx1 && t.iy >= this.vy0 && t.iy <= this.vy1;
  }
  private isPrefetch(t: Tile): boolean {
    return t.level === this.level && t.ix >= this.vx0 - 1 && t.ix <= this.vx1 + 1 && t.iy >= this.vy0 - 1 && t.iy <= this.vy1 + 1;
  }

  // ------------------------------------------------------------------ tiles

  private make(level: number, ix: number, iy: number): Tile {
    const dens = densityOf(level), size = TILE_PX / dens;
    const t: Tile = {
      key: keyOf(level, ix, iy), level, ix, iy, x0: ix * size, y0: iy * size, size, dens,
      canvas: null, ctx: null, ready: false, needFull: true, failed: false,
      rects: [], adds: new Map(), job: null, skipped: null, used: this.stamp,
    };
    this.tiles.set(t.key, t);
    this.work.add(t);
    return t;
  }

  private release(t: Tile): void {
    if (t.canvas) { this.src.free(t.canvas); this.bytesNow -= TILE_BYTES; }
    t.canvas = null; t.ctx = null;
  }

  private drop(t: Tile): void {
    this.release(t);
    this.tiles.delete(t.key);
    this.work.delete(t);
    t.job = null; t.adds.clear(); t.rects.length = 0;
  }

  /** Allocate the tile's canvas and paint its background (white on Paper). */
  private ensureCanvas(t: Tile): boolean {
    if (t.canvas && t.ctx) return true;
    if (t.failed) return false;
    this.allocating = t;
    if (this.bytesNow + TILE_BYTES > this.softCap) this.evict(this.bytesNow + TILE_BYTES - this.softCap);
    const c = this.src.alloc();
    this.allocating = null;
    const ctx = c ? c.getContext('2d') : null;
    if (!c || !ctx) {
      if (c) this.src.free(c);
      t.failed = true;
      return false;
    }
    t.canvas = c; t.ctx = ctx;
    this.bytesNow += TILE_BYTES;
    this.paintBackground(t, FULL);
    return true;
  }

  private paintBackground(t: Tile, r: Rect): void {
    const ctx = t.ctx!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (this.ground === 'paper') { ctx.fillStyle = '#ffffff'; ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); }
    else ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.restore();
  }

  /**
   * Create the missing visible tiles (when settled), then the prefetch ring once the visible set
   * is complete. Marks visible tiles as recently used. Returns true if anything was created.
   */
  ensureVisible(): boolean {
    let made = false;
    const L = this.level, s = ++this.stamp;
    let complete = true;
    for (let iy = this.vy0; iy <= this.vy1; iy++) {
      for (let ix = this.vx0; ix <= this.vx1; ix++) {
        const t = this.tiles.get(keyOf(L, ix, iy));
        if (t) {
          t.used = s;
          if (!t.ready && !t.failed) complete = false;
          continue;
        }
        complete = false;
        if (this.settled && !this.suspended) { this.make(L, ix, iy).used = s; made = true; }
      }
    }
    if (complete && this.settled && !this.suspended) {
      for (let iy = this.vy0 - 1; iy <= this.vy1 + 1; iy++) {
        for (let ix = this.vx0 - 1; ix <= this.vx1 + 1; ix++) {
          if (ix >= this.vx0 && ix <= this.vx1 && iy >= this.vy0 && iy <= this.vy1) continue;
          const t = this.tiles.get(keyOf(L, ix, iy));
          if (t) { t.used = s; continue; }
          if (this.bytesNow + TILE_BYTES > this.softCap) continue;
          this.make(L, ix, iy).used = s - 1; made = true;
        }
      }
    }
    return made;
  }

  /** True when every visible cell holds a complete tile with no pending work. */
  visibleComplete(): boolean {
    const L = this.level;
    for (let iy = this.vy0; iy <= this.vy1; iy++) {
      for (let ix = this.vx0; ix <= this.vx1; ix++) {
        const t = this.tiles.get(keyOf(L, ix, iy));
        if (!t) return false;
        if (!t.failed && (!t.ready || t.needFull || t.job || t.adds.size || t.rects.length)) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ claims & invalidation

  /**
   * Claim a stroke into the tiles (two-phase bake, 'none' adds, late cooks): every cached tile its
   * box touches gets an add. Tiles still waiting for their first full render need none.
   */
  add(id: StrokeId, box: AABB, hint: AddHint | null): void {
    this.claimEpoch.set(id, ++this.epoch);
    this.skippedAll.delete(id);
    if (!validBox(box)) return;
    for (const t of this.tiles.values()) {
      if (!this.touches(t, box)) continue;
      if (t.skipped) t.skipped.delete(id);
      if (t.needFull && !t.job) continue;  // rule 3
      t.adds.set(id, hint);
      this.work.add(t);
    }
  }

  /** Re-render the dirty sub-rect `box` (absolute doc) of every cached tile it touches. */
  invalidate(box: AABB): void {
    if (!validBox(box)) return;
    for (const t of this.tiles.values()) {
      if (!this.touches(t, box)) continue;
      if (t.needFull && !t.job) continue;  // its full render will see the new state
      const r = this.toRect(t, box);
      if (!r) continue;
      // an in-progress render keeps its snapshot; the rect is redone after it
      pushRect(t.rects, r);
      this.work.add(t);
    }
  }

  /**
   * A stroke that tiles skipped (uncooked) has cooked: where it is missing from a whole tile it
   * is added (and an in-progress render of that tile leaves it to the add); where a dirty render
   * skipped it, that rect is re-rendered. No claim epoch is taken: renders that have not reached
   * it yet in other tiles draw it themselves.
   */
  cooked(id: StrokeId, hint: AddHint | null): void {
    this.skippedAll.delete(id);
    for (const t of this.tiles.values()) {
      if (!t.skipped || !t.skipped.has(id)) continue;
      const where = t.skipped.get(id)!;
      t.skipped.delete(id);
      if (t.needFull && !t.job) continue;
      if (where === null) {
        t.adds.set(id, hint);
        if (t.job) (t.job.skip ??= new Set()).add(id);
      } else pushRect(t.rects, where);
      this.work.add(t);
    }
  }

  /** Ids skipped as uncooked since the last call (the renderer asks the scene to cook them). */
  takeSkipped(out: StrokeId[]): StrokeId[] {
    out.length = 0;
    for (const id of this.skippedAll) out.push(id);
    this.skippedAll.clear();
    return out;
  }

  /** Mark a tile's pixels lost (context loss / discarded backing store). */
  markLost(canvas: HTMLCanvasElement): void {
    for (const t of this.tiles.values()) {
      if (t.canvas !== canvas) continue;
      t.ready = false; t.needFull = true; t.job = null; t.adds.clear(); t.rects.length = 0;
      this.work.add(t);
      this.changed = true;
      this.inkChanged = true;
    }
  }

  /** Every tile's pixels are suspect (long background on iPadOS, context restored). */
  markAllLost(): void {
    for (const t of this.tiles.values()) {
      t.ready = false; t.needFull = true; t.job = null; t.adds.clear(); t.rects.length = 0; t.failed = false;
      this.work.add(t);
    }
    this.changed = true;
    this.inkChanged = true;
  }

  private inView(t: Tile): boolean {
    return this.touches(t, this.visibleDocBox(this.vbox));
  }

  private touches(t: Tile, b: AABB): boolean {
    const pad = AA_PAD / t.dens;
    return b.x1 + pad > t.x0 && b.x0 - pad < t.x0 + t.size && b.y1 + pad > t.y0 && b.y0 - pad < t.y0 + t.size;
  }

  /** Doc box -> integer tile rect (padded for anti-aliasing), or null when it misses the tile. */
  private toRect(t: Tile, b: AABB): Rect | null {
    const d = t.dens;
    const x0 = Math.max(0, Math.floor((b.x0 - t.x0) * d) - AA_PAD);
    const y0 = Math.max(0, Math.floor((b.y0 - t.y0) * d) - AA_PAD);
    const x1 = Math.min(TILE_PX, Math.ceil((b.x1 - t.x0) * d) + AA_PAD);
    const y1 = Math.min(TILE_PX, Math.ceil((b.y1 - t.y0) * d) + AA_PAD);
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x0, y0, x1, y1 };
  }

  // ------------------------------------------------------------------ work

  private prio(t: Tile): number {
    if (!t.adds.size && !t.job && !t.needFull && !t.rects.length) return P_NONE;
    if (this.isVisible(t)) return t.adds.size ? P_ADD : P_VISIBLE;
    if (t.needFull && !t.job) {
      // only the current level is worth a fresh render
      return this.isPrefetch(t) && t.level === this.level ? P_PREFETCH : P_NONE;
    }
    return this.isPrefetch(t) ? P_PREFETCH : P_OTHER;
  }

  /** Squared distance of a tile's centre to the view centre (centre-out order). */
  private dist2(t: Tile): number {
    const c = this.view.cam;
    const dx = t.x0 + t.size * 0.5 - c.cx, dy = t.y0 + t.size * 0.5 - c.cy;
    return dx * dx + dy * dy;
  }

  private pick(maxPrio: number): Tile | null {
    let best: Tile | null = null, bp = P_NONE, bd = Infinity;
    for (const t of this.work) {
      const p = this.prio(t);
      if (p === P_NONE) {
        if (!t.adds.size && !t.job && !t.needFull && !t.rects.length) this.work.delete(t);
        continue;
      }
      if (p > maxPrio || p > bp) continue;
      const d = this.dist2(t);
      if (p < bp || d < bd) { best = t; bp = p; bd = d; }
    }
    return best;
  }

  /** True while any tile has work that run() would do. */
  get pending(): number {
    let n = 0;
    for (const t of this.work) if (this.prio(t) !== P_NONE) n++;
    return n;
  }

  /**
   * Run tile work in priority order until `budgetMs` (by `clock`) is spent. At least one step
   * runs. Returns true while work remains.
   */
  run(budgetMs: number, clock: () => number): boolean {
    const t0 = clock();
    let steps = 0;
    for (;;) {
      const t = this.pick(P_OTHER);
      if (!t) break;
      // keep stepping the chosen tile while it has work (cheap re-pick avoidance)
      do {
        if (steps > 0 && clock() - t0 >= budgetMs) return this.pending > 0;
        this.step(t);
        steps++;
      } while (this.prio(t) !== P_NONE && this.prio(t) <= P_VISIBLE);
    }
    return this.pending > 0;
  }

  /** One unit of work on a tile: an add, one stroke of a render, or starting a render. */
  private step(t: Tile): void {
    if (t.adds.size && !(t.needFull && !t.job)) {
      const it = t.adds.entries().next();
      const [id, hint] = it.value as [StrokeId, AddHint | null];
      t.adds.delete(id);
      this.doAdd(t, id, hint);
      return;
    }
    if (t.needFull && !t.job) t.adds.clear();
    if (t.job) { this.advance(t); return; }
    if (t.needFull) { this.start(t, FULL, true); return; }
    if (t.rects.length) {
      // all pending rects render together as ONE clip region (not their union): each stroke
      // touching any of them is drawn once, and disjoint rects never re-render the gap between
      const rs = t.rects.splice(0, t.rects.length);
      this.start(t, rs.length === 1 ? rs[0] : unionRects(rs), false, rs.length > 1 ? rs : null);
    }
  }

  private doAdd(t: Tile, id: StrokeId, hint: AddHint | null): void {
    const d = this.src.resolve(id, hint);
    if (d === undefined) return;
    if (d === null) { this.skip(t, id, null); return; }
    if (!this.ensureCanvas(t)) return;
    this.drawOne(t, id, d, FULL, false);
    if (t.skipped) t.skipped.delete(id);
    if (t.ready && this.inView(t)) { this.changed = true; this.inkChanged = true; }
  }

  /** Eligible ids whose boxes meet tile rect r (padded for anti-aliasing). */
  private queryRect(t: Tile, r: Rect, out: StrokeId[]): StrokeId[] {
    const T = t.size, d = t.dens;
    const qb = this.qbox;
    qb.x0 = t.x0 + (r.x0 - AA_PAD) / d; qb.y0 = t.y0 + (r.y0 - AA_PAD) / d;
    qb.x1 = t.x0 + (r.x1 + AA_PAD) / d; qb.y1 = t.y0 + (r.y1 + AA_PAD) / d;
    if (qb.x1 > t.x0 + T + AA_PAD / d) qb.x1 = t.x0 + T + AA_PAD / d;
    if (qb.y1 > t.y0 + T + AA_PAD / d) qb.y1 = t.y0 + T + AA_PAD / d;
    return this.src.query(qb, out);
  }

  private start(t: Tile, r: Rect, full: boolean, rects: Rect[] | null = null): void {
    let ids: StrokeId[];
    if (!rects) ids = this.queryRect(t, r, []);
    else {
      const seen = new Set<StrokeId>(), tmp: StrokeId[] = [];
      for (const q of rects) for (const id of this.queryRect(t, q, tmp)) seen.add(id);
      ids = [...seen].sort();  // ids sort by creation = z-order
    }
    if (full) {
      t.needFull = false;
      t.skipped = null;
      if (ids.length === 0) {
        // empty tile: no canvas at all (cleared region on Paper and Night alike)
        this.release(t);
        t.ready = true; t.failed = false;
        if (this.inView(t)) { this.changed = true; this.inkChanged = true; }
        return;
      }
      const reuse = !!t.canvas;
      if (!this.ensureCanvas(t)) { t.ready = true; return; }
      if (reuse) this.paintBackground(t, FULL);
      t.ready = false;
      t.job = { rect: FULL, rects: null, ids, i: 0, epoch: this.epoch, skip: null, inPlace: false, clip: false };
      return;
    }
    // dirty sub-rect(s)
    if (!t.canvas) {
      if (ids.length === 0) return;  // still empty
      if (!this.ensureCanvas(t)) return;
    } else if (rects) for (const q of rects) this.paintBackground(t, q);
    else this.paintBackground(t, r);
    const whole = !rects && r.x0 === 0 && r.y0 === 0 && r.x1 === TILE_PX && r.y1 === TILE_PX;
    t.job = { rect: r, rects, ids, i: 0, epoch: this.epoch, skip: null, inPlace: t.ready, clip: !whole };
  }

  private advance(t: Tile): void {
    const j = t.job!;
    while (j.i < j.ids.length) {
      const id = j.ids[j.i++];
      const ce = this.claimEpoch.get(id);
      if (ce !== undefined && ce > j.epoch) continue;  // rule 1: claimed after the snapshot
      if (j.skip && j.skip.has(id)) continue;
      const d = this.src.resolve(id, null);
      if (d === undefined) continue;
      if (d === null) { this.skip(t, id, j.rect === FULL || !j.clip ? null : j.rect); continue; }
      if (!t.ctx) break;
      if (t.skipped && t.skipped.has(id) && t.skipped.get(id) === null) {
        // missing from the whole tile: draw it whole with an add instead of inside this rect only
        t.skipped.delete(id);
        t.adds.set(id, null);
        this.work.add(t);
        continue;
      }
      this.drawOne(t, id, d, j.rect, j.clip, j.rects);
      if (j.i < j.ids.length) return;  // one stroke per step
    }
    this.finish(t);
  }

  private finish(t: Tile): void {
    t.job = null;
    t.ready = true;
    if (this.inView(t)) { this.changed = true; this.inkChanged = true; }
  }

  /** Record an uncooked stroke as missing from `where` (null = the whole tile). */
  private skip(t: Tile, id: StrokeId, where: Rect | null): void {
    const m = (t.skipped ??= new Map());
    if (where === null) m.set(id, null);
    else if (!m.has(id)) m.set(id, { x0: where.x0, y0: where.y0, x1: where.x1, y1: where.y1 });
    else {
      const prev = m.get(id);
      if (prev) m.set(id, unionRects([prev, where]));
    }
    this.skippedAll.add(id);
  }

  private drawOne(t: Tile, id: StrokeId, d: Drawable, r: Rect, clip: boolean, rects: Rect[] | null = null): void {
    const ctx = t.ctx!;
    const b = this.box;
    b.x0 = t.x0; b.y0 = t.y0; b.x1 = t.x0 + t.size; b.y1 = t.y0 + t.size;
    const m = regionMatrix(d.r.origin, b, t.dens);
    if (clip) {
      ctx.save();
      ctx.beginPath();
      if (rects) for (const q of rects) ctx.rect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
      else ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.clip();
    }
    this.draw(ctx, d, m, r, this.ground);
    if (clip) ctx.restore();
    if (this.src.drawn) this.src.drawn(id, d.c, t);
  }

  /**
   * Finish, synchronously, what keeps a DISPLAYED tile inconsistent before a forced composite:
   * in-place renders always; with `all` (transactions are waiting on the tiles) also pending adds
   * and dirty rects. Displayed = complete visible tiles of the current level, plus tiles of other
   * levels that stand in for a missing current-level cell (drawInto's fallback). Without `all`,
   * adds that merely complete a tile (late cooks) wait for the scheduler. Fresh tiles (not
   * displayable yet) and hidden tiles of other levels are left to the scheduler.
   */
  flushDisplayed(all = true): void {
    const nMissing = this.computeMissing();
    const vb = this.visibleDocBox(this.vbox);
    for (const t of this.tiles.values()) {
      if (!t.ready) continue;
      if (t.level === this.level ? !this.isVisible(t) : !(nMissing > 0 && this.touches(t, vb) && this.coversMissing(t))) continue;
      let guard = 1 << 22;
      while (guard-- > 0 && t.ready) {
        if (t.job) { this.advance(t); continue; }
        if (all && (t.adds.size || t.rects.length)) { this.step(t); continue; }
        break;
      }
    }
  }

  /** True while a displayed tile is mid-way through an in-place render (do not composite). */
  busy(): boolean {
    let nMissing = -1;
    for (const t of this.work) {
      if (!t.job || !t.job.inPlace) continue;
      if (t.level === this.level) { if (this.isVisible(t)) return true; continue; }
      if (nMissing < 0) nMissing = this.computeMissing();
      if (nMissing > 0 && this.inView(t) && this.coversMissing(t)) return true;
    }
    return false;
  }

  /**
   * True when what is displayed over `box` is complete: every visible current-level tile touching
   * it has no pending work (or could not be allocated), and where a current-level cell is missing
   * during a gesture, the other-level tiles standing in for it have none either. Cells without a
   * tile count as not ready while tiles can be created (settled); during a gesture they cannot be
   * waited for, so their fallback is what must be consistent.
   */
  readyFor(box: AABB): boolean {
    if (!validBox(box)) return true;
    const T = this.size, L = this.level, pad = AA_PAD / this.dens;
    const ix0 = Math.max(this.vx0, Math.floor((box.x0 - pad) / T)), ix1 = Math.min(this.vx1, Math.floor((box.x1 + pad) / T));
    const iy0 = Math.max(this.vy0, Math.floor((box.y0 - pad) / T)), iy1 = Math.min(this.vy1, Math.floor((box.y1 + pad) / T));
    let fallback = false;
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const t = this.tiles.get(keyOf(L, ix, iy));
        if (!t) { if (this.settled && !this.suspended) return false; fallback = true; continue; }
        if (t.failed) continue;
        if (!t.ready || t.needFull || t.job || t.adds.size || t.rects.length) return false;
      }
    }
    if (!fallback || this.computeMissing() === 0) return true;
    for (const t of this.tiles.values()) {
      if (!t.job && !t.adds.size && !t.rects.length) continue;
      if (this.touches(t, box) && this.coversMissing(t)) return false;
    }
    return true;
  }

  /**
   * Fill `missing` with the visible current-level cells that have no displayable tile (1) and
   * return how many there are.
   */
  private computeMissing(): number {
    const L = this.level, nx = this.vx1 - this.vx0 + 1, ny = this.vy1 - this.vy0 + 1;
    if (this.missing.length < nx * ny) this.missing = new Uint8Array(nx * ny * 2);
    let n = 0;
    for (let iy = this.vy0; iy <= this.vy1; iy++) {
      for (let ix = this.vx0; ix <= this.vx1; ix++) {
        const t = this.tiles.get(keyOf(L, ix, iy));
        const miss = !t || !(t.ready || t.failed) ? 1 : 0;
        this.missing[(iy - this.vy0) * nx + (ix - this.vx0)] = miss;
        n += miss;
      }
    }
    return n;
  }

  /** True when other-level tile `t` stands in for a missing cell (needs a fresh computeMissing). */
  private coversMissing(t: Tile): boolean {
    if (t.level === this.level || !t.ready || t.failed || Math.abs(t.level - this.level) > FALLBACK_SPAN) return false;
    const T = this.size, nx = this.vx1 - this.vx0 + 1;
    const cx0 = Math.max(this.vx0, Math.floor(t.x0 / T)), cx1 = Math.min(this.vx1, Math.ceil((t.x0 + t.size) / T) - 1);
    const cy0 = Math.max(this.vy0, Math.floor(t.y0 / T)), cy1 = Math.min(this.vy1, Math.ceil((t.y0 + t.size) / T) - 1);
    for (let iy = cy0; iy <= cy1; iy++) {
      for (let ix = cx0; ix <= cx1; ix++) if (this.missing[(iy - this.vy0) * nx + (ix - this.vx0)]) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ compositing

  /**
   * Blit the tiles into a viewport-sized device-px context (identity transform): fallback tiles
   * from other levels first (farthest level first) where the current level has no complete tile,
   * then the current level. Every blit REPLACES its rectangle (clear, then draw), so overlapping
   * levels never add up. Destination rects are rounded on the shared grid, so neighbours meet
   * without seams. Returns the number of tiles drawn.
   */
  drawInto(ctx: CanvasRenderingContext2D, smoothing: ImageSmoothingQuality = 'medium'): number {
    const v = this.view;
    const k = v.cam.scale * v.dpr;
    const hx = v.cssW * 0.5 * v.dpr, hy = v.cssH * 0.5 * v.dpr;
    const W = Math.round(v.cssW * v.dpr), H = Math.round(v.cssH * v.dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = smoothing;
    ctx.clearRect(0, 0, W, H);
    const L = this.level, s = ++this.stamp;
    const nMissing = this.computeMissing();
    let drawn = 0;
    if (nMissing > 0) {
      const fb: Tile[] = [];
      for (const t of this.tiles.values()) if (this.coversMissing(t)) fb.push(t);
      fb.sort((a, b) => Math.abs(b.level - L) - Math.abs(a.level - L) || a.level - b.level);
      for (const t of fb) { this.blit(ctx, t, k, hx, hy, W, H); t.used = s; drawn++; }
    }
    for (let iy = this.vy0; iy <= this.vy1; iy++) {
      for (let ix = this.vx0; ix <= this.vx1; ix++) {
        const t = this.tiles.get(keyOf(L, ix, iy));
        if (!t || !(t.ready || t.failed)) continue;
        t.used = s;
        if (this.blit(ctx, t, k, hx, hy, W, H)) drawn++;
      }
    }
    ctx.restore();
    this.changed = false;
    return drawn;
  }

  /** Replace-blit one tile; empty tiles just clear their rect. */
  private blit(ctx: CanvasRenderingContext2D, t: Tile, k: number, hx: number, hy: number, W: number, H: number): boolean {
    const c = this.view.cam;
    const x0 = Math.round((t.x0 - c.cx) * k + hx), x1 = Math.round((t.x0 + t.size - c.cx) * k + hx);
    const y0 = Math.round((t.y0 - c.cy) * k + hy), y1 = Math.round((t.y0 + t.size - c.cy) * k + hy);
    if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H || x1 <= x0 || y1 <= y0) return false;
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    if (!t.canvas) return false;
    ctx.drawImage(t.canvas, 0, 0, TILE_PX, TILE_PX, x0, y0, x1 - x0, y1 - y0);
    return true;
  }

  /**
   * Device rects (viewport px) of visible current-level cells whose tiles are complete and missed
   * no stroke (used to uncover the cold-load snapshot). Returns how many visible cells qualify
   * out of the total.
   */
  completeCells(cb: (x: number, y: number, w: number, h: number) => void): { done: number; total: number } {
    const v = this.view, k = v.cam.scale * v.dpr;
    const hx = v.cssW * 0.5 * v.dpr, hy = v.cssH * 0.5 * v.dpr;
    let done = 0, total = 0;
    for (let iy = this.vy0; iy <= this.vy1; iy++) {
      for (let ix = this.vx0; ix <= this.vx1; ix++) {
        total++;
        const t = this.tiles.get(keyOf(this.level, ix, iy));
        if (!t || !(t.ready || t.failed) || t.job || t.adds.size || t.rects.length || (t.skipped && t.skipped.size)) continue;
        done++;
        const x0 = Math.round((t.x0 - v.cam.cx) * k + hx), x1 = Math.round((t.x0 + t.size - v.cam.cx) * k + hx);
        const y0 = Math.round((t.y0 - v.cam.cy) * k + hy), y1 = Math.round((t.y0 + t.size - v.cam.cy) * k + hy);
        cb(x0, y0, x1 - x0, y1 - y0);
      }
    }
    return { done, total };
  }

  // ------------------------------------------------------------------ memory

  /** Bytes held by tile canvases. */
  get bytes(): number { return this.bytesNow; }
  /** Tiles holding a canvas. */
  get count(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.canvas) n++;
    return n;
  }

  /** Keep tile bytes under the soft cap by evicting least-recently-used invisible tiles. */
  trim(): void {
    if (this.bytesNow <= this.softCap) return;
    this.evict(this.bytesNow - this.softCap);
  }

  /** Evict least-recently-used tiles outside the view until `needBytes` are freed. */
  evict(needBytes: number): number {
    const cand: Tile[] = [];
    for (const t of this.tiles.values()) if (!this.isVisible(t) && t !== this.allocating) cand.push(t);
    cand.sort((a, b) => a.used - b.used);
    let freed = 0;
    for (const t of cand) {
      if (freed >= needBytes) break;
      if (t.canvas) freed += TILE_BYTES;
      this.drop(t);
    }
    return freed;
  }

  /** Drop every tile (new document, ground flip, purge). */
  dropAll(): void {
    for (const t of [...this.tiles.values()]) this.drop(t);
    this.work.clear();
    this.claimEpoch.clear();
    this.skippedAll.clear();
    this.changed = true;
    this.inkChanged = true;
  }

  /**
   * Forget the bookkeeping of a stroke that left the document: its claim epoch and every tile's
   * record of it as skipped (a removed stroke will never cook into a tile, and a lingering record
   * would keep that cell "incomplete" forever, e.g. under the cold-load snapshot).
   */
  forget(id: StrokeId): void {
    this.claimEpoch.delete(id);
    this.skippedAll.delete(id);
    for (const t of this.tiles.values()) if (t.skipped) t.skipped.delete(id);
  }
}

function validBox(b: AABB | null | undefined): b is AABB {
  return !!b && b.x1 >= b.x0 && b.y1 >= b.y0 && Number.isFinite(b.x0) && Number.isFinite(b.y1) && Number.isFinite(b.x1) && Number.isFinite(b.y0);
}

/** Add a dirty rect, merging overlapping ones; beyond MAX_RECTS everything becomes one union. */
export function pushRect(list: Rect[], r: Rect): void {
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (r.x0 <= a.x1 && r.x1 >= a.x0 && r.y0 <= a.y1 && r.y1 >= a.y0) {
      const u = { x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1) };
      list.splice(i, 1);
      pushRect(list, u);
      return;
    }
  }
  list.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
  if (list.length > MAX_RECTS) {
    const u = unionRects(list);
    list.length = 0;
    list.push(u);
  }
}

/** Bounding rect of a list of rects. */
export function unionRects(list: readonly Rect[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of list) {
    if (r.x0 < x0) x0 = r.x0; if (r.y0 < y0) y0 = r.y0;
    if (r.x1 > x1) x1 = r.x1; if (r.y1 > y1) y1 = r.y1;
  }
  return { x0, y0, x1, y1 };
}
