/**
 * render-world renderer test rig: a minimal fake DOM (elements, canvases with recording 2D
 * contexts, CSS.supports, matchMedia, manual timers), a fake Doc / Scene, and fake live layer and
 * overlay factories that log what the renderer asks of them. Nothing here touches real pixels:
 * tests check the renderer's choreography (holds, transactions, composites, commits).
 */
import type {
  AABB, Command, Cooked, Doc, DocChange, DocMeta, Priority, Scene, StrokeId, StrokeRecipe, Vec2,
} from '../src/core/types';
import { S } from '../src/core/types';
import type { LiveHost, LiveLayerInternal, OverlayHost, OverlayInternal } from '../src/render/types';
import { synthCooked } from './render-core.fixtures';

// ---------------------------------------------------------------------------- event log

export interface Ev { el: FakeEl | null; op: string; args: unknown[] }
/** Every recorded context call and fake-live call, in order. */
export const events: Ev[] = [];
export const mark = (op: string, ...args: unknown[]): void => { events.push({ el: null, op, args }); };

// ---------------------------------------------------------------------------- elements

let serial = 0;

export class FakeEl {
  readonly tagName: string;
  readonly uid = ++serial;
  id = '';
  className = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  width = 300; height = 150;
  clientWidth = 0; clientHeight = 0; offsetWidth = 0;
  private ctx: FakeCtx | null = null;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  insertBefore(el: FakeEl, ref: FakeEl | null): FakeEl {
    el.remove();
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(el); else this.children.splice(i, 0, el);
    el.parentNode = this;
    return el;
  }
  appendChild(el: FakeEl): FakeEl { return this.insertBefore(el, null); }
  remove(): void {
    if (!this.parentNode) return;
    const p = this.parentNode.children, i = p.indexOf(this);
    if (i >= 0) p.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  addEventListener(t: string, fn: () => void): void {
    let s = this.listeners.get(t);
    if (!s) { s = new Set(); this.listeners.set(t, s); }
    s.add(fn);
  }
  removeEventListener(t: string, fn: () => void): void { this.listeners.get(t)?.delete(fn); }
  dispatch(t: string): void { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }
  getContext(): FakeCtx | null {
    if (this.tagName !== 'CANVAS') return null;
    return this.ctx ??= new FakeCtx(this);
  }
  toBlob(cb: (b: Blob | null) => void, type = 'image/png'): void { cb(new Blob(['fake'], { type })); }
  toDataURL(): string { return 'data:,'; }
  /** Label for logs: id, or 'tile' for 512² canvases. */
  get label(): string { return this.id || (this.width === 512 && this.height === 512 ? 'tile' : 'canvas' + this.uid); }
}

/** A recording 2D context: every method call is logged; gradients and patterns are stubs. */
export class FakeCtx {
  [k: string]: unknown;
  constructor(readonly canvas: FakeEl) {
    return new Proxy(this, {
      get(t, k: string | symbol) {
        if (typeof k === 'symbol' || k in t) return (t as Record<string | symbol, unknown>)[k];
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
        if (k === 'createPattern') return () => ({ setTransform: () => undefined });
        return (...args: unknown[]) => { events.push({ el: t.canvas, op: k, args }); };
      },
      set(t, k: string | symbol, v) { (t as Record<string | symbol, unknown>)[k] = v; return true; },
    });
  }
}

// ---------------------------------------------------------------------------- timers + globals

interface Timer { id: number; at: number; fn: () => void }

/** Manual clock and timers (window.setTimeout); `advance` fires due timers in order. */
export class FakeTime {
  now = 1000;
  private q: Timer[] = [];
  private next = 1e9;
  setTimeout = (fn: () => void, ms = 0): number => { const id = ++this.next; this.q.push({ id, at: this.now + ms, fn }); return id; };
  clearTimeout = (id: number): void => { this.q = this.q.filter(t => t.id !== id); };
  isFake = (id: unknown): boolean => typeof id === 'number' && id > 1e9;
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.q[0];
      if (!t || t.at > end) break;
      this.q.shift();
      this.now = Math.max(this.now, t.at);
      t.fn();
    }
    this.now = end;
  }
  get pending(): number { return this.q.length; }
}

export interface DomRig {
  time: FakeTime;
  document: FakeEl & { visibilityState: string; createElement(tag: string): FakeEl };
  root: FakeEl;
  restore(): void;
}

/** Install the fake DOM globals. `plusLighter` false exercises the blit fallback. */
export function installDom(o: { plusLighter?: boolean; coarse?: boolean } = {}): DomRig {
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const keys = ['document', 'window', 'CSS', 'matchMedia', 'getComputedStyle', 'ImageData', 'clearTimeout'];
  for (const k of keys) saved[k] = g[k];
  const time = new FakeTime();
  const doc = Object.assign(new FakeEl('#document'), {
    visibilityState: 'visible',
    createElement: (tag: string) => new FakeEl(tag),
  });
  const realClear = globalThis.clearTimeout;
  g.clearTimeout = (id: unknown) => { if (time.isFake(id)) time.clearTimeout(id as number); else realClear(id as Parameters<typeof clearTimeout>[0]); };
  const mm = (q: string) => ({ matches: q.includes('coarse') ? !!o.coarse : false });
  g.document = doc;
  g.window = {
    setTimeout: time.setTimeout, clearTimeout: g.clearTimeout, devicePixelRatio: 1, matchMedia: mm,
    innerWidth: 1280, innerHeight: 800, screen: { width: 1920, height: 1080 },
  };
  g.CSS = { supports: (a: string, b?: string) => !String(a + ' ' + (b ?? '')).includes('plus-lighter') || o.plusLighter !== false };
  g.matchMedia = mm;
  g.getComputedStyle = (el: FakeEl) => ({ position: el.style.position || 'static' });
  g.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
  const root = new FakeEl('div');
  events.length = 0;
  return {
    time, document: doc, root,
    restore() { for (const k of keys) g[k] = saved[k]; },
  };
}

// ---------------------------------------------------------------------------- doc + scene

const CALIB = { lo: 0.04, hi: 0.8, gamma: 1, flat: 1, vMed: 0.9, jitter: 0.3, fcMin: 2 };

/** A recipe whose single sample row sits at (x, y); its box is (x, y)–(x + w, y + h). */
export function recipeAt(n: number, x: number, y: number, w = 60, h = 20, over: Partial<StrokeRecipe> = {}): StrokeRecipe {
  const samples = new Float32Array(2 * S.STRIDE);
  samples[S.X] = 0; samples[S.Y] = 0; samples[S.STRIDE + S.X] = w; samples[S.STRIDE + S.Y] = h;
  samples[S.STRIDE + S.T] = 50;
  return {
    id: String(n).padStart(9, '0') + '0000', created: n, origin: [x, y], z: 1, rot: 0, seed: n, device: 'pen',
    calib: CALIB, stroke: { nib: 'pen', size: 3 }, color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null },
    form: { form: 'line', v: 1, base: 0 }, s0: 0, cut: 0, resume: null, samples, pools: new Float32Array(0),
    closed: false, radial: false, sym: null, xf: null, geomRev: 0, colorRev: 0, ...over,
  };
}

/** Geometry for a recipe: one ribbon along its two sample rows. */
export function cookOf(r: StrokeRecipe): Cooked {
  const s = r.samples, w = Number(r.stroke.size) || 3;
  return synthCooked([{ pts: [[s[S.X], s[S.Y], w], [s[S.STRIDE + S.X], s[S.STRIDE + S.Y], w]] }], 1, r.origin as [number, number]);
}

export class FakeDoc implements Doc {
  meta: DocMeta = {
    id: 'doc', title: 't', created: 0, updated: 0, docSeed: 1, counter: 0,
    inkCounters: { graphite: 0, indigo: 0, oxide: 0, ochre: 0, moss: 0, rose: 0, spectral: 0, custom: 0 },
    ground: 'night', camera: { cx: 0, cy: 0, scale: 1, rot: 0 },
  };
  private map = new Map<StrokeId, StrokeRecipe>();
  private subs = new Set<(c: DocChange) => void>();
  get(id: StrokeId): StrokeRecipe | undefined { return this.map.get(id); }
  has(id: StrokeId): boolean { return this.map.has(id); }
  ordered(): readonly StrokeRecipe[] { return [...this.map.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); }
  get size(): number { return this.map.size; }
  apply(c: Command): Command {
    const ch: DocChange = { added: [], removed: [], geometry: [], color: [], meta: false, view: false };
    let inv: Command;
    if (c.k === 'add') { for (const r of c.recipes) { this.map.set(r.id, r); ch.added.push(r.id); } inv = { k: 'remove', ids: c.recipes.map(r => r.id) }; }
    else if (c.k === 'remove') {
      const gone = c.ids.map(id => this.map.get(id)!).filter(Boolean);
      for (const r of gone) { this.map.delete(r.id); ch.removed.push(r.id); }
      inv = { k: 'add', recipes: gone };
    } else if (c.k === 'replace') {
      for (const r of c.after) {
        const b = this.map.get(r.id);
        this.map.set(r.id, r);
        (b && b.geomRev === r.geomRev ? ch.color : ch.geometry).push(r.id);
      }
      inv = { k: 'replace', before: c.after, after: c.before };
    } else inv = c;
    for (const fn of this.subs) fn(ch);
    return inv;
  }
  nextSeed(): number { return ++this.meta.counter; }
  nextVariant(): number { return 0; }
  nextId(): StrokeId { return String(++this.meta.counter).padStart(13, '0'); }
  setView(): void { /* not needed */ }
  subscribe(fn: (c: DocChange) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
}

const boxOfRecipe = (r: StrokeRecipe, c: Cooked | undefined): AABB =>
  c ? c.inkBox : { x0: r.origin[0] - 70, y0: r.origin[1] - 70, x1: r.origin[0] + 140, y1: r.origin[1] + 100 };

/**
 * Scene over a FakeDoc: geometry per recipe object (cooked on demand). `autoCook` false keeps
 * strokes uncooked until `cookNow` (ensure() then waits for it).
 */
export class FakeScene implements Scene {
  autoCook = true;
  private geo = new Map<StrokeRecipe, Cooked>();
  private waits: { ids: StrokeId[]; resolve: () => void }[] = [];
  constructor(private doc: FakeDoc) {}
  cooked(id: StrokeId): Cooked | undefined {
    const r = this.doc.get(id);
    if (!r) return undefined;
    if (!this.geo.has(r) && this.autoCook) this.geo.set(r, cookOf(r));
    return this.geo.get(r);
  }
  cookedFor(r: StrokeRecipe): Cooked | undefined {
    if (!this.geo.has(r) && this.autoCook) this.geo.set(r, cookOf(r));
    return this.geo.get(r);
  }
  putFor(r: StrokeRecipe, c: Cooked): void { this.geo.set(r, c); }
  pick(): { id: StrokeId; poly: number } | null { return null; }
  /** Cook the current revision of ids now and resolve ensure() calls that wait for them. */
  cookNow(ids: readonly StrokeId[]): void {
    for (const id of ids) { const r = this.doc.get(id); if (r && !this.geo.has(r)) this.geo.set(r, cookOf(r)); }
    const left: typeof this.waits = [];
    for (const w of this.waits) if (w.ids.every(id => !this.doc.has(id) || this.geo.has(this.doc.get(id)!))) w.resolve(); else left.push(w);
    this.waits = left;
  }
  put(id: StrokeId, c: Cooked): void { const r = this.doc.get(id); if (r) this.geo.set(r, c); }
  ensure(ids: readonly StrokeId[], _p: Priority): Promise<void> {
    if (this.autoCook) { for (const id of ids) this.cooked(id); return Promise.resolve(); }
    const need = ids.filter(id => this.doc.has(id) && !this.geo.has(this.doc.get(id)!));
    if (!need.length) return Promise.resolve();
    return new Promise(resolve => { this.waits.push({ ids: need, resolve }); });
  }
  query(box: AABB, out: StrokeId[]): StrokeId[] {
    out.length = 0;
    for (const r of this.doc.ordered()) {
      const b = boxOfRecipe(r, this.geo.get(r));
      if (b.x1 >= box.x0 && b.x0 <= box.x1 && b.y1 >= box.y0 && b.y0 <= box.y1) out.push(r.id);
    }
    return out;
  }
  boxOf(id: StrokeId): AABB | null { const r = this.doc.get(id); return r ? boxOfRecipe(r, this.geo.get(r)) : null; }
  hit(): StrokeId | null { return null; }
  sweep(): void { /* unused */ }
  lasso(): StrokeId[] { return []; }
  crowding(): number { return 0; }
  sideCrowding(): number { return 0; }
  lineage(): StrokeId | null { return null; }
  contentBox(): AABB | null { return null; }
  get cachedPoints(): number { return 0; }
}

// ---------------------------------------------------------------------------- fake live layer + overlay

interface Held { r: StrokeRecipe; c: Cooked }

/** Logs every call; `bake(id)` asks the host to bake a committed / grown stroke. */
export class FakeLive implements LiveLayerInternal {
  host!: LiveHost;
  shown = new Map<StrokeId, Held>();
  lifted: readonly { r: StrokeRecipe; c: Cooked }[] | null = null;
  done = new Set<StrokeId>();
  begin(): void { mark('live.begin'); }
  update(): void { /* no-op */ }
  predict(): void { /* no-op */ }
  halo(): void { /* no-op */ }
  commit(r: StrokeRecipe, c: Cooked): void { mark('live.commit', r.id); this.shown.set(r.id, { r, c }); }
  withdraw(): void { mark('live.withdraw'); }
  play(r: StrokeRecipe, c: Cooked): number { mark('live.play', r.id); this.shown.set(r.id, { r, c }); return 0; }
  dissolve(): void { /* no-op */ }
  fastForward(): void { mark('live.fastForward'); }
  readonly animating = 0;
  readonly active = false;
  frame(): boolean { return false; }
  grow(items: readonly Held[]): void { mark('live.grow', items.map(i => i.r.id)); for (const it of items) this.shown.set(it.r.id, it); }
  ungrow(items: readonly Held[]): void { mark('live.ungrow', items.map(i => i.r.id)); }
  morph(b: readonly Held[], a: readonly Held[]): void { mark('live.morph', a.map(i => i.r.id)); for (const it of a) this.shown.set(it.r.id, it); void b; }
  setLifted(items: readonly Held[] | null): void { mark('live.setLifted', items ? items.map(i => i.r.id) : null); this.lifted = items; }
  onCamera(): void { /* no-op */ }
  resize(): void { /* no-op */ }
  onGround(): void { mark('live.onGround'); }
  /** The live layer finished a stroke: ask for its two-phase bake. */
  bake(id: StrokeId): void {
    const h = this.shown.get(id);
    if (!h) throw new Error('not shown: ' + id);
    this.host.bake(h.r, h.c, () => { mark('done', id); this.done.add(id); this.shown.delete(id); });
  }
}

export class FakeOverlay implements OverlayInternal {
  cursor(): void { /* no-op */ }
  weld(): void { /* no-op */ }
  lasso(): void { /* no-op */ }
  eraser(): void { /* no-op */ }
  selection(_b: AABB | null, _ids: readonly StrokeId[]): void { /* no-op */ }
  sizeRing(_p: Vec2 | null): void { /* no-op */ }
  symmetry(): void { /* no-op */ }
  clear(): void { /* no-op */ }
  frame(): boolean { return false; }
  resize(): void { /* no-op */ }
  predicted(): void { /* no-op */ }
  constructor(readonly host: OverlayHost) {}
}

/** Index of the first event matching `op` (and `el` label when given) at or after `from`. */
export function find(op: string, label?: string, from = 0): number {
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e.op === op && (label === undefined || (e.el ? e.el.label === label : label === ''))) return i;
  }
  return -1;
}
