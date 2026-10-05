/**
 * render-world test helpers: a fake 2D context that models what a tile holds (per-cell draw
 * counts per stroke, honouring clears and clips), fake canvases, and a fake tile source that
 * emulates the renderer's eligibility protocol.
 */
import type { AABB, Cooked, StrokeId, StrokeRecipe } from '../src/core/types';
import type { AddHint, Drawable, Rect, TileDraw, TileSource } from '../src/render/tiles';
import { TILE_PX } from '../src/render/tiles';

export const CELL = 8;
export const NC = TILE_PX / CELL;

const EMPTY: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Intersection of two rects (an empty rect when they do not overlap; null = unbounded). */
export function isect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : EMPTY;
}

/** Cells (index) whose centre lies inside r. */
export function forCells(r: Rect, fn: (i: number) => void): void {
  const cx0 = Math.max(0, Math.ceil(r.x0 / CELL - 0.5)), cx1 = Math.min(NC - 1, Math.floor(r.x1 / CELL - 0.5 - 1e-9));
  const cy0 = Math.max(0, Math.ceil(r.y0 / CELL - 0.5)), cy1 = Math.min(NC - 1, Math.floor(r.y1 / CELL - 0.5 - 1e-9));
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * NC + cx);
}

/** Records clears / clips / blits and keeps per-stroke cell counts (cell centres decide). */
export class FakeCtx {
  counts = new Map<string, Int32Array>();
  /** Current clip region: a union of rects (null = unclipped). */
  cur: Rect[] | null = null;
  private stack: (Rect[] | null)[] = [];
  private pending: Rect[] = [];
  blits: { x: number; y: number; w: number; h: number; src: unknown }[] = [];
  clears: Rect[] = [];
  globalCompositeOperation = 'source-over';
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  constructor(public canvas: FakeCanvas) {}
  save(): void { this.stack.push(this.cur); }
  restore(): void { this.cur = this.stack.length ? this.stack.pop()! : null; }
  setTransform(): void {}
  beginPath(): void { this.pending = []; }
  rect(x: number, y: number, w: number, h: number): void { this.pending.push({ x0: x, y0: y, x1: x + w, y1: y + h }); }
  clip(): void {
    const p = this.pending;
    if (!this.cur) { this.cur = p.slice(); return; }
    const out: Rect[] = [];
    for (const a of this.cur) for (const b of p) { const r = isect(a, b)!; if (r.x1 > r.x0) out.push(r); }
    this.cur = out;
  }
  private inClip(i: number): boolean {
    if (!this.cur) return true;
    const cx = (i % NC + 0.5) * CELL, cy = (Math.floor(i / NC) + 0.5) * CELL;
    for (const r of this.cur) if (cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1) return true;  // half-open, like forCells
    return false;
  }
  clearRect(x: number, y: number, w: number, h: number): void { this.zero({ x0: x, y0: y, x1: x + w, y1: y + h }); }
  fillRect(x: number, y: number, w: number, h: number): void { this.zero({ x0: x, y0: y, x1: x + w, y1: y + h }); }
  drawImage(src: unknown, ...a: number[]): void {
    const d = a.length >= 8 ? a.slice(4, 8) : a.length >= 4 ? a.slice(0, 4) : [a[0], a[1], 0, 0];
    this.blits.push({ x: d[0], y: d[1], w: d[2], h: d[3], src });
  }
  private zero(r: Rect): void {
    this.clears.push(this.cur && this.cur.length === 1 ? isect(r, this.cur[0])! : r);
    for (const arr of this.counts.values()) forCells(r, i => { if (this.inClip(i)) arr[i] = 0; });
  }
  /** Draw a stroke footprint (tile px rect) through the current clip and `clipDev`. */
  stamp(id: string, foot: Rect, clipDev: Rect): void {
    const r = isect(isect(foot, clipDev), { x0: 0, y0: 0, x1: TILE_PX, y1: TILE_PX })!;
    let arr = this.counts.get(id);
    if (!arr) { arr = new Int32Array(NC * NC); this.counts.set(id, arr); }
    const a = arr;
    forCells(r, i => { if (this.inClip(i)) a[i]++; });
  }
}

export class FakeCanvas {
  width: number; height: number;
  ctx: FakeCtx;
  style: Record<string, string> = {};
  constructor(w = TILE_PX, h = TILE_PX) { this.width = w; this.height = h; this.ctx = new FakeCtx(this); }
  getContext(): FakeCtx { return this.ctx; }
}

/** A minimal stroke: one doc-space box, whether it is cooked, in the document, held. */
export interface FakeStroke { id: string; box: AABB; cooked: boolean; inDoc: boolean; held: boolean }

export function recipeOf(id: string): StrokeRecipe {
  return { id, origin: [0, 0], geomRev: 0, colorRev: 0 } as unknown as StrokeRecipe;
}
export function cookedOf(box: AABB): Cooked {
  return { inkBox: box, box: Float32Array.of(box.x0, box.y0, box.x1, box.y1), nPolys: 1 } as unknown as Cooked;
}

/** The renderer's eligibility protocol over fake strokes. */
export class FakeWorld implements TileSource {
  strokes = new Map<string, FakeStroke>();
  allocs = 0; frees = 0;
  failAlloc = false;
  eligible(id: string): boolean { const s = this.strokes.get(id); return !!s && s.inDoc && !s.held; }
  query(box: AABB, out: StrokeId[]): StrokeId[] {
    out.length = 0;
    const ids = [...this.strokes.keys()].sort();
    for (const id of ids) {
      const s = this.strokes.get(id)!;
      if (!this.eligible(id)) continue;
      if (s.box.x1 >= box.x0 && s.box.x0 <= box.x1 && s.box.y1 >= box.y0 && s.box.y0 <= box.y1) out.push(id);
    }
    return out;
  }
  resolve(id: StrokeId, _hint: AddHint | null): Drawable | null | undefined {
    if (!this.eligible(id)) return undefined;
    const s = this.strokes.get(id)!;
    return s.cooked ? { r: recipeOf(id), c: cookedOf(s.box) } : null;
  }
  alloc(): HTMLCanvasElement | null {
    if (this.failAlloc) return null;
    this.allocs++;
    return new FakeCanvas() as unknown as HTMLCanvasElement;
  }
  free(): void { this.frees++; }
}

/** Tile draw that stamps the stroke's doc box (mapped by m) into the fake context. */
export const stampDraw: TileDraw = (ctx, d, m, clip) => {
  const b = d.c.inkBox;
  const foot = { x0: m[0] * b.x0 + m[4], y0: m[3] * b.y0 + m[5], x1: m[0] * b.x1 + m[4], y1: m[3] * b.y1 + m[5] };
  (ctx as unknown as FakeCtx).stamp(d.r.id, foot, clip);
};

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
