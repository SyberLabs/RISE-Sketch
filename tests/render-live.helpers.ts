/**
 * render-live test helpers: a recording 2D context (path bboxes, fills with their alpha and
 * composite op, clears, clips), a fake canvas, and a fake LiveHost / OverlayHost with a manual
 * clock and manual bake completion.
 */
import type { AABB, Camera, Cooked, Doc, Ground, InkTable, RecipeCore, Scene, StrokeId, StrokeRecipe, Vec2 } from '../src/core/types';
import type { LiveHost, OverlayHost } from '../src/render/types';
import { inkTableFor, viewMatrix } from '../src/render/raster';

export interface DrawOp {
  op: 'fill' | 'stroke' | 'clearRect' | 'fillRect' | 'strokeRect' | 'clip';
  alpha: number;
  comp: string;
  style: unknown;
  /** Device-space bbox of the path (or rect). */
  box: AABB;
  lineWidth: number;
  dash: number;
  /** Subpaths in the path (moveTo count). */
  subpaths: number;
}

interface State {
  alpha: number; comp: string; fill: unknown; stroke: unknown; lw: number;
  m: [number, number, number, number, number, number]; dash: number;
}

/** A Canvas2D stand-in that records what is drawn (enough of the API for render-core and render-live). */
export class RecCtx {
  ops: DrawOp[] = [];
  private st: State = { alpha: 1, comp: 'source-over', fill: '#000', stroke: '#000', lw: 1, m: [1, 0, 0, 1, 0, 0], dash: 0 };
  private stack: State[] = [];
  private bx = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  private sub = 0;
  lineCap = 'butt';
  lineJoin = 'miter';
  lineDashOffset = 0;
  imageSmoothingEnabled = true;
  constructor(readonly canvas: FakeCanvas) {}

  get globalAlpha(): number { return this.st.alpha; }
  set globalAlpha(v: number) { if (v >= 0 && v <= 1) this.st.alpha = v; }
  get globalCompositeOperation(): string { return this.st.comp; }
  set globalCompositeOperation(v: string) { this.st.comp = v; }
  get fillStyle(): unknown { return this.st.fill; }
  set fillStyle(v: unknown) { this.st.fill = v; }
  get strokeStyle(): unknown { return this.st.stroke; }
  set strokeStyle(v: unknown) { this.st.stroke = v; }
  get lineWidth(): number { return this.st.lw; }
  set lineWidth(v: number) { this.st.lw = v; }

  save(): void { this.stack.push({ ...this.st, m: [...this.st.m] as State['m'] }); }
  restore(): void { const s = this.stack.pop(); if (s) this.st = s; }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.st.m = [a, b, c, d, e, f]; }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const [A, B, C, D, E, F] = this.st.m;
    this.st.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y); }
  scale(x: number, y: number): void { this.transform(x, 0, 0, y, 0, 0); }
  setLineDash(d: number[]): void { this.st.dash = d.length; }
  getLineDash(): number[] { return []; }

  private pt(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.st.m;
    const X = a * x + c * y + e, Y = b * x + d * y + f;
    if (X < this.bx.x0) this.bx.x0 = X; if (X > this.bx.x1) this.bx.x1 = X;
    if (Y < this.bx.y0) this.bx.y0 = Y; if (Y > this.bx.y1) this.bx.y1 = Y;
  }
  beginPath(): void { this.bx = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; this.sub = 0; }
  moveTo(x: number, y: number): void { this.sub++; this.pt(x, y); }
  lineTo(x: number, y: number): void { this.pt(x, y); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void { this.pt(cx, cy); this.pt(x, y); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void { this.pt(a, b); this.pt(c, d); this.pt(x, y); }
  arc(x: number, y: number, r: number): void { this.pt(x - r, y - r); this.pt(x + r, y + r); }
  closePath(): void { /* no-op */ }
  rect(x: number, y: number, w: number, h: number): void { this.sub++; this.pt(x, y); this.pt(x + w, y + h); }

  private rec(op: DrawOp['op'], box?: AABB): void {
    this.ops.push({
      op, alpha: this.st.alpha, comp: this.st.comp, style: op === 'stroke' || op === 'strokeRect' ? this.st.stroke : this.st.fill,
      box: box ?? { ...this.bx }, lineWidth: this.st.lw, dash: this.st.dash, subpaths: this.sub,
    });
  }
  private rectBox(x: number, y: number, w: number, h: number): AABB {
    const save = this.bx;
    this.bx = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.pt(x, y); this.pt(x + w, y + h);
    const b = this.bx;
    this.bx = save;
    return b;
  }
  fill(): void { this.rec('fill'); }
  stroke(): void { this.rec('stroke'); }
  clip(): void { this.rec('clip'); }
  clearRect(x: number, y: number, w: number, h: number): void { this.rec('clearRect', this.rectBox(x, y, w, h)); }
  fillRect(x: number, y: number, w: number, h: number): void { this.rec('fillRect', this.rectBox(x, y, w, h)); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.rec('strokeRect', this.rectBox(x, y, w, h)); }
  createRadialGradient(): { addColorStop(o: number, c: string): void; stops: [number, string][] } {
    const g = { stops: [] as [number, string][], addColorStop(o: number, c: string): void { g.stops.push([o, c]); } };
    return g;
  }

  /** Ops since the last take(), then forget them. */
  take(): DrawOp[] { const o = this.ops; this.ops = []; return o; }
}

/** A canvas stand-in. */
export class FakeCanvas {
  width: number;
  height: number;
  readonly style: Record<string, string> = {};
  readonly ctx: RecCtx;
  contextAttrs: unknown = null;
  constructor(w: number, h: number) { this.width = w; this.height = h; this.ctx = new RecCtx(this); }
  getContext(_kind: string, attrs?: unknown): RecCtx { if (attrs !== undefined) this.contextAttrs = attrs; return this.ctx; }
}

export interface BakeCall { r: StrokeRecipe; c: Cooked; done: () => void; doneCalled: boolean }

/** A LiveHost with a manual clock and manual bake completion. */
export class FakeHost implements LiveHost {
  readonly dry: HTMLCanvasElement;
  readonly wet: HTMLCanvasElement;
  readonly dryC: FakeCanvas;
  readonly wetC: FakeCanvas;
  t = 1000;
  g: Ground = 'night';
  cam: Camera = { cx: 400, cy: 300, scale: 1, rot: 0 };
  vp = { w: 800, h: 600 };
  d = 1;
  rm = false;
  frames = 0;
  bakes: BakeCall[] = [];
  /** Complete bakes immediately inside bake(). */
  autoBake = false;
  constructor(w = 800, h = 600, dpr = 1) {
    this.vp = { w, h };
    this.d = dpr;
    this.dryC = new FakeCanvas(w * dpr, h * dpr);
    this.wetC = new FakeCanvas(w * dpr, h * dpr);
    this.dry = this.dryC as unknown as HTMLCanvasElement;
    this.wet = this.wetC as unknown as HTMLCanvasElement;
  }
  dpr(): number { return this.d; }
  ground(): Ground { return this.g; }
  camera(): Camera { return this.cam; }
  viewport(): { w: number; h: number } { return this.vp; }
  matrixFor(origin: Vec2): Float64Array { return viewMatrix(origin, this.cam, this.vp.w, this.vp.h, this.d); }
  inkTable(r: RecipeCore & { id?: string; colorRev?: number }): InkTable { return inkTableFor(r, this.g); }
  bake(r: StrokeRecipe, c: Cooked, done: () => void): void {
    const b: BakeCall = { r, c, done: () => { b.doneCalled = true; done(); }, doneCalled: false };
    this.bakes.push(b);
    if (this.autoBake) b.done();
  }
  requestFrame(): void { this.frames++; }
  reducedMotion(): boolean { return this.rm; }
  now(): number { return this.t; }
}

/** An OverlayHost over a fake canvas with a tiny scene / doc of cooked strokes. */
export class FakeOverlayHost implements OverlayHost {
  readonly canvas: HTMLCanvasElement;
  readonly can: FakeCanvas;
  cam: Camera = { cx: 400, cy: 300, scale: 1, rot: 0 };
  vp = { w: 800, h: 600 };
  g: Ground = 'night';
  frames = 0;
  readonly strokes = new Map<StrokeId, { r: StrokeRecipe; c: Cooked }>();
  readonly scene: Scene;
  readonly doc: Doc;
  constructor() {
    this.can = new FakeCanvas(800, 600);
    this.canvas = this.can as unknown as HTMLCanvasElement;
    const strokes = this.strokes;
    this.scene = { cooked: (id: StrokeId) => strokes.get(id)?.c } as unknown as Scene;
    this.doc = { get: (id: StrokeId) => strokes.get(id)?.r } as unknown as Doc;
  }
  camera(): Camera { return this.cam; }
  viewport(): { w: number; h: number } { return this.vp; }
  ground(): Ground { return this.g; }
  requestFrame(): void { this.frames++; }
}

/** Union of the device boxes of a set of ops. */
export function unionBox(ops: readonly DrawOp[]): AABB {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const o of ops) {
    if (o.box.x0 < b.x0) b.x0 = o.box.x0; if (o.box.y0 < b.y0) b.y0 = o.box.y0;
    if (o.box.x1 > b.x1) b.x1 = o.box.x1; if (o.box.y1 > b.y1) b.y1 = o.box.y1;
  }
  return b;
}
