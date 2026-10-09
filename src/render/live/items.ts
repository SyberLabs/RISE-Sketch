/**
 * What the live layer draws: the Item contract, the shared frame context, and WakeItem, the
 * poly-by-poly #dry / #wet base of the live stroke, its finish and a replay.
 */
import type { AABB, Cooked, FormId, Ground, InkTable, Mat2x3, RecipeCore, StrokeRecipe, Vec2 } from '../../core/types';
import { PL, PolyKind } from '../../core/types';
import { clamp01 } from '../../core/num';
import { multiply } from '../../core/mat';
import type { LiveHost } from '../types';
import { ArcClock, HOT_EPS, LIFT_MS, PROMOTE_MS, chainReveal, ease01, hotEta, windowEdge } from './timing';
import { IntList, PolyState, type RectList, devOf, dirtyEntry } from './polys';
import { type Ctx2D, type HotView, dopts, drawHot, drawInk } from './draw';

export const DOT = PolyKind.Dot;
/** Poly states (PolyState.st): not drawn, drawn in #wet, drawn in #dry. */
export const HIDDEN = 0, WET = 1, DRY = 2;

const EMPTY_F32 = new Float32Array(0);

// ============================================================================ items

/** A committed stroke ready for the renderer's two-phase bake. */
export interface BakeJob { item: Item; r: StrokeRecipe; c: Cooked }

/** Shared frame context. */
export interface LayerCx {
  readonly host: LiveHost;
  now: number;
  rm: boolean;
  ground: Ground;
  /** Hot gain (0 under reduced motion) and time constant. */
  H: number;
  tau: number;
  camRev: number;
  groundRev: number;
  readonly wet: RectList;
  readonly dry: RectList;
  bake(job: BakeJob): void;
}

/** Item kinds (Item.tag). */
export const TAG_LIVE = 1, TAG_FINISH = 2, TAG_PLAY = 3, TAG_ANIM = 4;

/** Anything the live layer draws. */
export interface Item {
  dead: boolean;
  readonly id: string | null;
  readonly tag: number;
  /** Advance; add dirty rects; true while it needs more frames. */
  step(now: number, cx: LayerCx): boolean;
  drawDry(ctx: Ctx2D, clip: AABB, cx: LayerCx): void;
  drawWet(ctx: Ctx2D, clip: AABB, cx: LayerCx): void;
  /** Device-px bbox of everything it may draw; false when nothing. */
  devBox(out: AABB): boolean;
  animating(): boolean;
  /** Jump every animation to its end (and bake when it would bake). */
  fastForward(now: number, cx: LayerCx): void;
  /** Camera, size or ground changed. */
  refresh(cx: LayerCx): void;
  /** Remove at once, dirtying everything it drew. */
  kill(cx: LayerCx): void;
}

/** A recipe or a draft: what an item draws. */
export type Rec = RecipeCore & { id?: string; colorRev?: number };

/**
 * A stroke drawn poly by poly with a #dry / #wet split: the live stroke, its finish after lift,
 * and a replayed stroke. Per poly: reveal (time prefix with chains, or the trunk's arc for a
 * replay), morph, lift fade, hot multiplier; a poly moves to #dry once nothing about it is still
 * changing (cooled, revealed, settled, outside a hold's pinned window).
 */
export abstract class WakeItem implements Item {
  dead = false;
  id: string | null = null;
  abstract readonly tag: number;
  src: Cooked;
  readonly S = new PolyState();
  table!: InkTable;
  readonly m: Mat2x3 = new Float64Array(6);
  /** Placement of a symmetry copy (doc rel. origin -> doc rel. origin), composed into `m`; null = none. */
  xf: Mat2x3 | null = null;
  /** A symmetry copy's stroke: the copy never drains its cook, animates and fast-forwards with it. */
  lead: Item | null = null;
  sc = 1;
  protected camRev = -1;
  protected groundRev = -1;
  clock: ArcClock;
  /** Hot-window tip arc. */
  tip = -Infinity;
  /** Clock value for arcs not reached yet. */
  protected beyond = 0;
  /** Replay: the trunk is revealed up to this arc. */
  protected sVis = Infinity;
  protected arcReveal = false;
  protected requireSettled = false;
  dryAll = false;
  readonly act = new IntList();
  readonly dry = new IntList();
  readonly wd = new IntList();
  readonly hot = new IntList();
  pinFrom = Infinity;
  pinOn = false;
  pinUntil = -Infinity;
  hasMorph = false;
  morphFrom: Float32Array | null = null;
  /** Last step had time-based work. */
  protected busy = false;
  /** Time of the last batch promoted to #dry, and the polys waiting for the next batch. */
  protected lastPromote = -Infinity;
  private readonly ready = new IntList();
  protected readonly hotView: HotView = { clock: new ArcClock(), now: 0, tip: 0, H: 0, tau: 1, beyond: 0, sVis: Infinity };
  readonly rvFn = (i: number): number => this.S.rv[i];
  readonly hvFn = (i: number): number => this.S.hv[i];
  readonly mvFn = (i: number): number => this.S.mv[i];
  private readonly morphOpt: { from: Float32Array; t: (i: number) => number } = { from: EMPTY_F32, t: this.mvFn };

  constructor(readonly rec: Rec, readonly origin: Vec2, readonly form: FormId, clock: ArcClock, src: Cooked) {
    this.clock = clock;
    this.src = src;
  }

  refresh(cx: LayerCx): void {
    if (this.camRev !== cx.camRev) {
      this.m.set(cx.host.matrixFor(this.origin));   // own storage: hosts may reuse a scratch matrix
      if (this.xf) multiply(this.m, this.xf, this.m);
      this.sc = Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2]));
      this.camRev = cx.camRev;
    }
    if (this.groundRev !== cx.groundRev) {
      this.table = cx.host.inkTable(this.rec);
      this.groundRev = cx.groundRev;
    }
  }

  abstract step(now: number, cx: LayerCx): boolean;
  abstract fastForward(now: number, cx: LayerCx): void;
  /** Ghosts, fade-outs, synthetic halos. */
  protected drawExtras(_ctx: Ctx2D, _clip: AABB, _cx: LayerCx): void { /* none by default */ }
  /** Doc-rel-origin bbox of extras into out; false when none. */
  protected extrasBox(_out: AABB): boolean { return false; }
  /** Unit depth fraction (replays rising through their pools); 1 = full. Sets depthPending. */
  protected depthFrac(_i: number, _now: number): number { return 1; }
  protected depthPending = false;

  animating(): boolean { return !this.dead && this.busy; }

  drawDry(ctx: Ctx2D, clip: AABB): void {
    const c = this.src;
    if (this.dryAll) { drawInk(ctx, c, this.table, this.m, this.form, dopts(clip)); return; }
    if (this.dry.n === 0) return;
    const o = dopts(clip);
    o.polys = this.dry.view();
    drawInk(ctx, c, this.table, this.m, this.form, o);
  }

  drawWet(ctx: Ctx2D, clip: AABB, cx: LayerCx): void {
    if (this.dryAll) { this.drawExtras(ctx, clip, cx); return; }
    const c = this.src;
    if (this.wd.n > 0) {
      const o = dopts(clip);
      o.polys = this.wd.view();
      o.reveal = this.rvFn;
      o.hot = this.hvFn;
      if (this.hasMorph && this.morphFrom) { this.morphOpt.from = this.morphFrom; o.morph = this.morphOpt; }
      drawInk(ctx, c, this.table, this.m, this.form, o);
    }
    if (this.hot.n > 0) {
      const hv = this.hotView;
      hv.clock = this.clock; hv.now = cx.now; hv.tip = this.tip; hv.H = cx.H; hv.tau = cx.tau; hv.beyond = this.beyondAt(cx.now);
      hv.sVis = this.arcReveal ? this.sVis : Infinity;
      drawHot(ctx, c, this.hot.a, this.hot.n, this.table, this.m, clip, hv, this.S, this.hasMorph ? this.morphFrom : null);
    }
    this.drawExtras(ctx, clip, cx);
  }

  /** Clock value for arcs past the last mark (live: now; replay: the stroke's end). */
  protected beyondAt(now: number): number { return now; }

  devBox(out: AABB): boolean {
    const ib = this.src.inkBox, ox = this.origin[0], oy = this.origin[1];
    let x0 = ib.x0 - ox, y0 = ib.y0 - oy, x1 = ib.x1 - ox, y1 = ib.y1 - oy;
    const e = TMP_BOX;
    if (this.extrasBox(e)) {
      if (!(x1 >= x0)) { x0 = e.x0; y0 = e.y0; x1 = e.x1; y1 = e.y1; }
      else { x0 = Math.min(x0, e.x0); y0 = Math.min(y0, e.y0); x1 = Math.max(x1, e.x1); y1 = Math.max(y1, e.y1); }
    }
    if (this.hasMorph) {
      const S = this.S;
      for (let i = 0; i < this.src.nPolys; i++) {
        if (S.mt0[i] !== S.mt0[i]) continue;
        const o = 4 * i;
        x0 = Math.min(x0, S.mbox[o]); y0 = Math.min(y0, S.mbox[o + 1]);
        x1 = Math.max(x1, S.mbox[o + 2]); y1 = Math.max(y1, S.mbox[o + 3]);
      }
    }
    if (!devOf(this.m, x0, y0, x1, y1, out)) return false;
    const pad = 4 + 0.1 * this.sc * (this.maxW > 0 ? this.maxW : 0);
    out.x0 -= pad; out.y0 -= pad; out.x1 += pad; out.y1 += pad;
    return true;
  }
  /** Max poly width (doc) for padding. */
  protected maxW = 0;

  kill(cx: LayerCx): void {
    if (this.dead) return;
    const b = TMP_BOX2;
    if (this.devBox(b)) { cx.dry.add(b.x0, b.y0, b.x1, b.y1); cx.wet.add(b.x0, b.y0, b.x1, b.y1); }
    this.dead = true;
  }

  /** Rebuild the dry list from the states. */
  protected rebuildDry(): void {
    const S = this.S, n = this.src.nPolys;
    this.dry.clear();
    for (let i = 0; i < n; i++) if (S.st[i] === DRY) this.dry.push(i);
  }

  /** Rebuild the active (not-dry) list. */
  protected rebuildAct(): void {
    const S = this.S, n = this.src.nPolys;
    this.act.clear();
    for (let i = 0; i < n; i++) if (S.st[i] !== DRY) this.act.push(i);
  }

  /** Recompute the max width over all entries. */
  protected updateMaxW(): void {
    let w = 0;
    const S = this.S;
    for (let i = 0; i < this.src.nPolys; i++) if (S.wmax[i] > w) w = S.wmax[i];
    this.maxW = w;
  }

  /**
   * The per-poly frame: values for every non-dry poly, wet/dry transitions with their dirty
   * rects, and this frame's draw lists. Returns true while anything is time-varying.
   */
  protected stepPolys(now: number, cx: LayerCx): boolean {
    const c = this.src, S = this.S, p = c.pts;
    const H = cx.H, tau = cx.tau, tip = this.tip, beyond = this.beyondAt(now);
    const pinActive = this.pinOn || now < this.pinUntil;
    // a stroke under 3 device px is one dot (LOD rule 5): its hot trunk goes through drawCooked
    const ib = c.inkBox, dX = ib.x1 - ib.x0, dY = ib.y1 - ib.y0;
    const tiny = dX >= 0 && dY >= 0 && Math.sqrt(dX * dX + dY * dY) * this.sc < 3;
    let busy = false, dryChange = false;
    this.wd.clear(); this.hot.clear(); this.ready.clear();
    const act = this.act.a;
    let w = 0;
    for (let q = 0; q < this.act.n; q++) {
      const i = act[q];
      const rv0 = S.rv[i], mv0 = S.mv[i], hv0 = S.hv[i];
      const gen = c.gen[i], st = c.start[i], cnt = c.count[i];
      const dotLike = c.kind[i] === DOT || cnt < 2;
      let pending = false;
      // reveal
      let rv = 1;
      if (this.arcReveal && gen === 0) {
        const born = c.born[i];
        if (dotLike) rv = this.sVis >= born ? 1 : 0;
        else {
          const sA = born + p[4 * st + 3], sB = born + p[4 * (st + cnt - 1) + 3];
          rv = sB > sA ? clamp01((this.sVis - sA) / (sB - sA)) : (this.sVis >= sA ? 1 : 0);
        }
        if (rv < 1) pending = true;
      } else if (gen > 0) {
        const rd = S.rd[i];
        let f = 1;
        if (rd > 0) { f = ease01((now - S.rs[i]) / rd); if (f < 1) pending = true; }
        this.depthPending = false;
        const df = this.depthFrac(i, now);
        if (this.depthPending) pending = true;
        if (df < f) f = df;
        rv = f >= 1 ? 1 : chainReveal(f, S.coff[i], S.ctot[i], S.len[i]);
      }
      // morph
      let mv = 1;
      const mt0 = S.mt0[i];
      if (mt0 === mt0) { mv = ease01((now - mt0) / S.md[i]); if (mv < 1) pending = true; }
      // lift fade-in
      let fm = 1;
      if (S.fd[i] === 1) { fm = clamp01((now - S.ft0[i]) / LIFT_MS); if (fm < 1) pending = true; }
      // hot
      let hm = fm, hotTrunk = false;
      if (H > 0 && rv > 0) {
        if (gen === 0 && !dotLike) {
          const sB = c.born[i] + p[4 * (st + cnt - 1) + 3];
          const e = hotEta(now - this.clock.at(sB, beyond), tau) * windowEdge(sB, tip);
          if (e > 0) { pending = true; if (tiny) hm = fm * (1 + H * e); else hotTrunk = true; }
        } else {
          const e = hotEta(now - (gen === 0 ? this.clock.at(c.born[i], beyond) : S.t1[i]), tau);
          if (e > 0) { hm = fm * (1 + H * e); pending = true; }
        }
      }
      S.rv[i] = rv; S.mv[i] = mv; S.hv[i] = hm;
      // state: ink that is done waits (still drawn in #wet) for the next batch to #dry
      const prev = S.st[i];
      const pinned = pinActive && c.born[i] >= this.pinFrom;
      const done = !pending && !pinned && rv >= 1 && (!this.requireSettled || S.settled[i] === 1);
      const next = rv > 0 ? WET : HIDDEN;
      if (next !== prev) {
        S.st[i] = next;
        if (prev === WET || next === WET) dirtyEntry(cx.wet, S, i, this.m, this.sc);
        if (prev === DRY) { dirtyEntry(cx.dry, S, i, this.m, this.sc); dryChange = true; }
      } else if (next === WET && (hotTrunk || (pending && (rv !== rv0 || mv !== mv0 || Math.abs(hm - hv0) >= HOT_EPS)))) {
        dirtyEntry(cx.wet, S, i, this.m, this.sc);
      }
      if (done) this.ready.push(i);
      if (next === WET) (hotTrunk ? this.hot : this.wd).push(i);
      act[w++] = i;
      if (pending || (pinned && !this.pinOn)) busy = true;
    }
    this.act.n = w;
    // promote the ready polys in one batch: every PROMOTE_MS, or at once when nothing else moves
    if (this.ready.n > 0) {
      if (!busy || now - this.lastPromote >= PROMOTE_MS) {
        this.lastPromote = now;
        const r = this.ready.a;
        for (let q = 0; q < this.ready.n; q++) {
          const i = r[q];
          S.st[i] = DRY;
          dirtyEntry(cx.wet, S, i, this.m, this.sc);
          dirtyEntry(cx.dry, S, i, this.m, this.sc);
        }
        dryChange = true;
        this.ready.clear();
        // drop the promoted polys from this frame's lists
        this.compactLists();
      } else busy = true;
    }
    if (dryChange) this.rebuildDry();
    return busy;
  }

  /** Remove dry polys from the active and wet draw lists. */
  private compactLists(): void {
    this.dropDry(this.act); this.dropDry(this.wd); this.dropDry(this.hot);
  }

  private dropDry(L: IntList): void {
    const st = this.S.st, a = L.a;
    let w = 0;
    for (let q = 0; q < L.n; q++) if (st[a[q]] !== DRY) a[w++] = a[q];
    L.n = w;
  }

  /** Age every clock to its end: reveals done, morphs done, ink cold. */
  protected ageAll(): void {
    const S = this.S;
    this.clock.agedTo = Infinity;
    for (let i = 0; i < this.src.nPolys; i++) {
      S.rs[i] = -Infinity; S.t1[i] = -Infinity; S.ft0[i] = -Infinity;
      if (S.mt0[i] === S.mt0[i]) S.mt0[i] = -Infinity;
    }
  }
}

/** Scratch boxes. */
export const TMP_BOX: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
export const TMP_BOX2: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Largest pool amount (PL.A) of a recipe; 0 without pools. */
export function maxPool(r: StrokeRecipe): number {
  let m = 0;
  for (let o = PL.A; o < r.pools.length; o += PL.STRIDE) if (r.pools[o] > m) m = r.pools[o];
  return m;
}

/** Per-poly reveal currently visible on a wake item (hidden 0, dry 1, wet its reveal). */
export function visibleReveal(w: WakeItem): Float32Array {
  const n = w.src.nPolys, out = new Float32Array(n), S = w.S;
  for (let i = 0; i < n; i++) out[i] = S.st[i] === DRY ? 1 : S.st[i] === HIDDEN ? 0 : S.rv[i];
  return out;
}
