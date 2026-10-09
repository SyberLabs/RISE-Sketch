/**
 * The stroke being drawn (LiveStroke, mirroring the cook's live view) and its finish after lift
 * (FinishStroke: lift cross-fade, Echo fold-out and ghost, then the bake).
 */
import type { AABB, Cooked, DraftStroke, IncrementalCook, MorphSet, PolyView, StrokeRecipe } from '../../core/types';
import { clamp01 } from '../../core/num';
import { toneIndex } from '../../ink/color';
import { ArcClock, GHOST_MS, LIFT_MS, PIN_ARC, PIN_LINGER, echoFoldMs, genOffset, hotEta, revealMs, windowEdge } from './timing';
import { IntList, KeyTable, PolyState, PolyStore, addBox, computeChains, dirtyEntry, setMorphBox } from './polys';
import { type Ctx2D, dopts, drawInk } from './draw';
import { DOT, DRY, HIDDEN, type LayerCx, TAG_FINISH, TAG_LIVE, TMP_BOX2, WET, WakeItem, maxPool } from './items';

// ---------------------------------------------------------------------------- the live stroke

/** The stroke being drawn: mirrors the cook's live view and animates it. */
export class LiveStroke extends WakeItem {
  readonly tag = TAG_LIVE;
  readonly M: PolyStore;
  private readonly O = new PolyState();
  private readonly EV = new PolyState();
  private evN = 0;
  private readonly keys = new KeyTable();
  private claimed = new Uint8Array(64);
  readonly ghost = new PolyStore();
  readonly ghostBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };
  readonly unitT0 = new Map<number, number>();
  cookDirty = true;
  /** Hold start: move settled ink in the pinned window back to #wet on the next step. */
  private migrate = false;
  tipX = NaN;
  tipY = NaN;
  tipW = 0;
  tipCss = '';
  private hasSlot = false;

  constructor(readonly d: DraftStroke, readonly cook: IncrementalCook) {
    super(d, d.origin, d.form.form, new ArcClock(), new PolyStore());
    this.M = this.src as PolyStore;
    this.requireSettled = true;
  }

  /** Ink past the last mark (the round tip) was laid by the last update, not now. */
  protected override beyondAt(now: number): number { return this.clock.n > 0 ? this.clock.lastTime : now; }

  private readonly onDrain = (v: PolyView, _replaces: number): void => {
    const e = this.evN++;
    this.EV.ensure(e + 1);
    this.EV.keyFromView(v, e);
  };

  /** Hold started / ended (halo shown / hidden). */
  onHalo(on: boolean, now: number): void {
    if (on && !this.pinOn) {
      this.pinOn = true;
      this.pinFrom = this.tip - PIN_ARC;
      this.migrate = true;
    } else if (!on && this.pinOn) {
      this.pinOn = false;
      this.pinUntil = now + PIN_LINGER;
    }
  }

  step(now: number, cx: LayerCx): boolean {
    this.refresh(cx);
    if (this.cookDirty) this.sync(now, cx);
    if (this.migrate) this.migratePinned(cx);
    this.busy = this.stepPolys(now, cx);
    return this.busy;
  }

  /** Pull the cook's current view into the mirror; carry state; dirty what changed. */
  private sync(now: number, cx: LayerCx): void {
    this.cookDirty = false;
    this.evN = 0;
    if (!this.lead) this.cook.drainSettled(this.onDrain);
    const v = this.cook.view();
    const g = v.geom, n = g.nPolys;
    const slotRaw = (v as { slot?: unknown }).slot;
    const slot = slotRaw instanceof Int32Array && slotRaw.length >= n ? slotRaw : null;
    this.hasSlot = slot !== null;
    const M = this.M, S = this.S, O = this.O;

    // 1. the unchanged settled prefix
    const lim = Math.min(M.nPolys, n);
    let k = 0;
    if (slot) {
      while (k < lim && S.id[k] >= 0 && slot[k] === S.id[k]) k++;
    } else {
      O.ensure(1);
      while (k < lim && S.settled[k] === 1) {
        O.keyOnly(g, k, 0);
        if (!S.keyEq(k, O, 0)) break;
        k++;
      }
    }
    // 2. snapshot the old suffix, re-copy the new one
    const nOld = M.nPolys, mOld = nOld - k;
    O.ensure(mOld);
    for (let j = 0; j < mOld; j++) O.copyAll(S, k + j, j);
    M.truncate(k);
    for (let i = k; i < n; i++) M.push(g, i);
    S.ensure(n);
    S.n = n;
    // 3. carry state by content key; fresh polys start now
    this.keys.build(O.hash, mOld);
    if (this.claimed.length < mOld) this.claimed = new Uint8Array(2 * mOld);
    this.claimed.fill(0, 0, mOld);
    for (let i = k; i < n; i++) {
      S.keyOnly(M, i, i);
      S.id[i] = slot ? slot[i] : -1;
      this.keys.find(S.hash[i]);
      let j = this.keys.next();
      while (j >= 0 && (this.claimed[j] === 1 || !O.keyEq(j, S, i))) j = this.keys.next();
      if (j >= 0) {
        // same content: carry its clocks, and its measures (no rescan of its points)
        this.claimed[j] = 1;
        S.carry(O, j, i);
        S.wmax[i] = O.wmax[j]; S.len[i] = O.len[j];
      } else {
        S.measure(M, i, i);
        this.fresh(i, now, cx);
        dirtyEntry(cx.wet, S, i, this.m, this.sc);
      }
      if (slot) S.settled[i] = S.id[i] >= 0 ? 1 : 0;
    }
    for (let j = 0; j < mOld; j++) {
      if (this.claimed[j] === 1) continue;
      if (O.st[j] === DRY) dirtyEntry(cx.dry, O, j, this.m, this.sc);
      else if (O.st[j] === WET) dirtyEntry(cx.wet, O, j, this.m, this.sc);
    }
    // 4. settled marks from drain events (cooks without slot ids)
    if (!slot && this.evN > 0) {
      this.keys.build(S.hash, n);
      for (let e = 0; e < this.evN; e++) {
        if (this.EV.cnt[e] === 0) continue;
        this.keys.find(this.EV.hash[e]);
        let i = this.keys.next();
        while (i >= 0 && !S.keyEq(i, this.EV, e)) i = this.keys.next();
        if (i >= 0) S.settled[i] = 1;
      }
    }
    computeChains(M, S, k);
    M.bounds(this.origin);
    this.updateMaxW();
    this.rebuildAct();
    this.rebuildDry();

    // 5. Echo ghost
    const gh = v.ghost;
    if (gh || this.ghost.nPolys > 0) {
      const gb = this.ghostBox;
      addBox(cx.wet, this.m, gb.x0, gb.y0, gb.x1, gb.y1, 4 + 0.1 * this.maxW * this.sc);
      this.ghost.truncate(0);
      gb.x0 = Infinity; gb.y0 = Infinity; gb.x1 = -Infinity; gb.y1 = -Infinity;
      if (gh) {
        for (let i = 0; i < gh.nPolys; i++) {
          this.ghost.push(gh, i);
          const b = gh.box;
          if (b[4 * i] < gb.x0) gb.x0 = b[4 * i]; if (b[4 * i + 1] < gb.y0) gb.y0 = b[4 * i + 1];
          if (b[4 * i + 2] > gb.x1) gb.x1 = b[4 * i + 2]; if (b[4 * i + 3] > gb.y1) gb.y1 = b[4 * i + 3];
        }
        this.ghost.coverage = gh.coverage;
        addBox(cx.wet, this.m, gb.x0, gb.y0, gb.x1, gb.y1, 4 + 0.1 * this.maxW * this.sc);
      }
    }

    // 6. the nib: arc clock, tip position, tip width and colour (prediction)
    const sp = this.cook.spine();
    if (sp.n > 0) {
      const L = sp.L;
      this.clock.mark(L, now);
      if (L > this.tip) this.tip = L;
      this.tipX = sp.x[sp.n - 1];
      this.tipY = sp.y[sp.n - 1];
    }
    let best = -Infinity, bi = -1;
    for (let i = k; i < n; i++) {
      if (M.gen[i] !== 0 || M.count[i] < 1) continue;
      const e = M.born[i] + M.pts[4 * (M.start[i] + M.count[i] - 1) + 3];
      if (e > best) { best = e; bi = i; }
    }
    if (bi >= 0) {
      this.tipW = M.pts[4 * (M.start[bi] + M.count[bi] - 1) + 2];
      if (this.table) this.tipCss = this.table.css[toneIndex(this.table, M.tone[bi], M.born[bi])];
    }
  }

  /** Initial state of a poly that appeared (or changed) now. */
  private fresh(i: number, now: number, cx: LayerCx): void {
    const S = this.S, M = this.M;
    S.init(i, WET, now);
    const gen = M.gen[i];
    if (gen >= 1 && !cx.rm) {
      const u = M.unit[i];
      let t0 = this.unitT0.get(u);
      if (t0 === undefined) { t0 = now; this.unitT0.set(u, now); }
      const T = revealMs(this.form);
      S.rs[i] = t0 + genOffset(this.form, gen, T);
      S.rd[i] = T;
    }
  }

  /** Hold start: settled ink in the pinned window goes back to #wet (it is about to regrow). */
  private migratePinned(cx: LayerCx): void {
    this.migrate = false;
    const S = this.S, c = this.src;
    let any = false;
    for (let i = 0; i < c.nPolys; i++) {
      if (S.st[i] !== DRY || c.born[i] < this.pinFrom) continue;
      S.st[i] = WET;
      dirtyEntry(cx.dry, S, i, this.m, this.sc);
      dirtyEntry(cx.wet, S, i, this.m, this.sc);
      this.act.push(i);
      any = true;
    }
    if (any) this.rebuildDry();
  }

  protected override drawExtras(ctx: Ctx2D, clip: AABB): void {
    if (this.ghost.nPolys > 0) drawInk(ctx, this.ghost, this.table, this.m, this.form, dopts(clip));
  }

  protected override extrasBox(out: AABB): boolean {
    if (this.ghost.nPolys === 0) return false;
    const g = this.ghostBox;
    out.x0 = g.x0; out.y0 = g.y0; out.x1 = g.x1; out.y1 = g.y1;
    return g.x1 >= g.x0;
  }

  override animating(): boolean { return !this.dead; }

  fastForward(now: number, cx: LayerCx): void {
    const at = this.clock.last;
    this.ageAll();
    this.clock.agedTo = at;
    this.step(now, cx);
  }

  /** Whether the view has cook slot ids (tests / HUD). */
  get slotted(): boolean { return this.hasSlot; }
}

// ---------------------------------------------------------------------------- the finish

/** The committed geometry after lift: finishes reveals and the hot trail, cross-fades lift zones, then bakes. */
export class FinishStroke extends WakeItem {
  readonly tag = TAG_FINISH;
  private readonly old: PolyStore;
  private readonly oldS: PolyState;
  private readonly fo = new IntList();
  private foBase = new Float32Array(0);
  private readonly oldRv = (i: number): number => this.oldS.rv[i];
  private readonly oldHv = (i: number): number => this.oldS.hv[i];
  private readonly ghost: PolyStore;
  private readonly ghostBox: AABB;
  private readonly tLift: number;
  private baking = false;
  private readonly unitT0: Map<number, number>;

  /**
   * `c` is the geometry the live stroke drew (in the stroke's own frame, placed by `ls.xf` for a
   * symmetry copy); `bakeC` is the committed (placed) geometry the tiles take, `c` by default.
   */
  constructor(ls: LiveStroke, readonly r: StrokeRecipe, readonly c: Cooked, now: number, cx: LayerCx, fold: MorphSet | null,
    private readonly bakeC: Cooked = c) {
    super(r, r.origin, r.form.form, ls.clock, c);
    this.id = r.id;
    this.xf = ls.xf;
    this.tLift = now;
    this.tip = ls.tip;
    this.unitT0 = ls.unitT0;
    this.old = ls.M;
    this.oldS = ls.S;
    this.ghost = ls.ghost;
    this.ghostBox = ls.ghostBox;
    this.m.set(ls.m); this.sc = ls.sc; this.camRev = cx.camRev;
    this.table = cx.host.inkTable(r); this.groundRev = cx.groundRev;
    const S = this.S, n = c.nPolys;
    S.ensure(n);
    S.n = n;
    for (let i = 0; i < n; i++) S.keyFrom(c, i, i);
    computeChains(c, S, 0);
    this.updateMaxW();
    // the trunk's final end may lie past the last live arc (end flush): it was laid at lift
    for (let i = 0; i < n; i++) {
      if (c.gen[i] !== 0 || c.count[i] < 1) continue;
      const e = c.born[i] + c.pts[4 * (c.start[i] + c.count[i] - 1) + 3];
      if (e > this.tip) this.tip = e;
    }
    this.clock.mark(this.tip, now);
    // carry the live state of every poly that survived lift unchanged
    const O = ls.S, no = ls.M.nPolys;
    const keys = new KeyTable();
    keys.build(O.hash, no);
    const claimed = new Uint8Array(no);
    const fold0 = fold ? fold.polyFirst[0] : n;
    const foldDur = fold && fold.dur.length > 0 && fold.dur[0] > 0 ? fold.dur[0] : echoFoldMs(r.form.base);
    for (let i = 0; i < n; i++) {
      keys.find(S.hash[i]);
      let j = keys.next();
      while (j >= 0 && (claimed[j] === 1 || !O.keyEq(j, S, i))) j = keys.next();
      if (j >= 0) { claimed[j] = 1; S.carry(O, j, i); }
      else this.freshAtLift(i, now, cx, fold !== null && i >= fold0);
      S.settled[i] = 1;
      if (cx.rm) { if (S.st[i] !== DRY) S.st[i] = DRY; }
    }
    // Echo fold-out: the crystal unfolds from its parent anchors
    if (fold && !cx.rm) {
      this.morphFrom = fold.from;
      for (let i = fold0; i < n; i++) {
        if (c.gen[i] === 0) continue;
        S.mt0[i] = now; S.md[i] = foldDur;
        setMorphBox(S, i, c, fold.from);
        this.hasMorph = true;
      }
    }
    // live polys absent from the committed geometry fade out (#wet); they leave #dry now
    this.foBase = new Float32Array(Math.max(1, no));
    const old = ls.M, op = old.pts;
    for (let j = 0; j < no; j++) {
      if (claimed[j] === 1) continue;
      const st = O.st[j];
      if (st === DRY) dirtyEntry(cx.dry, O, j, this.m, this.sc);
      if (st === HIDDEN) continue;
      dirtyEntry(cx.wet, O, j, this.m, this.sc);
      if (cx.rm) continue;
      this.fo.push(j);
      let base = O.hv[j] > 0 ? O.hv[j] : 1;
      if (old.gen[j] === 0 && old.kind[j] !== DOT && old.count[j] > 1) {
        // a trunk poly drawn by the hot routine: fade out from its hot alpha at its newest arc
        const sB = old.born[j] + op[4 * (old.start[j] + old.count[j] - 1) + 3];
        base *= 1 + cx.H * hotEta(now - this.clock.at(sB, now), cx.tau) * windowEdge(sB, this.tip);
      }
      this.foBase[j] = base;
      O.st[j] = WET;
    }
    if (cx.rm) this.ghost.truncate(0);
    this.rebuildAct();
    this.rebuildDry();
    // one repaint of the whole stroke swaps the live drawing for the committed one
    const b = TMP_BOX2;
    if (this.devBox(b)) {
      cx.wet.add(b.x0, b.y0, b.x1, b.y1);
      if (cx.rm) cx.dry.add(b.x0, b.y0, b.x1, b.y1);
    }
  }

  protected override beyondAt(): number { return this.tLift; }

  private freshAtLift(i: number, now: number, cx: LayerCx, crystal: boolean): void {
    const S = this.S, c = this.c;
    S.init(i, WET, now);
    if (cx.rm) return;
    const gen = c.gen[i];
    if (gen === 0) { S.fd[i] = 1; S.ft0[i] = now; return; }
    if (crystal) return;
    if (this.form === 'echo') { S.rs[i] = now; S.rd[i] = echoFoldMs(this.r.form.base + maxPool(this.r)); return; }
    const u = c.unit[i];
    if (this.unitT0.has(u)) { S.fd[i] = 1; S.ft0[i] = now; return; }
    this.unitT0.set(u, now);
    const T = revealMs(this.form);
    S.rs[i] = now + genOffset(this.form, gen, T);
    S.rd[i] = T;
  }

  step(now: number, cx: LayerCx): boolean {
    this.refresh(cx);
    if (this.baking || this.dead) return false;
    let busy = this.stepPolys(now, cx);
    const u = cx.rm ? 1 : clamp01((now - this.tLift) / LIFT_MS);
    if (this.fo.n > 0) {
      const O = this.oldS;
      for (let q = 0; q < this.fo.n; q++) {
        const j = this.fo.a[q];
        O.hv[j] = this.foBase[j] * (1 - u);
        dirtyEntry(cx.wet, O, j, this.m, this.sc);
      }
      if (u >= 1) this.fo.clear(); else busy = true;
    }
    if (this.ghost.nPolys > 0) {
      const g = this.ghostBox;
      addBox(cx.wet, this.m, g.x0, g.y0, g.x1, g.y1, 4);
      if (cx.rm || now - this.tLift >= GHOST_MS) this.ghost.truncate(0); else busy = true;
    }
    this.busy = busy;
    if (!busy && this.act.n === 0 && this.fo.n === 0 && this.ghost.nPolys === 0) {
      this.baking = true;
      this.dryAll = true;
      this.wd.clear(); this.hot.clear();
      cx.bake({ item: this, r: this.r, c: this.bakeC });
    }
    return busy;
  }

  protected override drawExtras(ctx: Ctx2D, clip: AABB, cx: LayerCx): void {
    if (this.fo.n > 0) {
      const o = dopts(clip);
      o.polys = this.fo.view();
      o.reveal = this.oldRv;
      o.hot = this.oldHv;
      drawInk(ctx, this.old, this.table, this.m, this.form, o);
    }
    if (this.ghost.nPolys > 0) {
      const o = dopts(clip);
      o.alphaScale = 1 - clamp01((cx.now - this.tLift) / GHOST_MS);
      if (o.alphaScale > 0) drawInk(ctx, this.ghost, this.table, this.m, this.form, o);
    }
  }

  protected override extrasBox(out: AABB): boolean {
    let any = false;
    out.x0 = Infinity; out.y0 = Infinity; out.x1 = -Infinity; out.y1 = -Infinity;
    if (this.fo.n > 0) {
      const ib = this.old.inkBox, ox = this.origin[0], oy = this.origin[1];
      if (ib.x1 >= ib.x0) {
        out.x0 = ib.x0 - ox; out.y0 = ib.y0 - oy; out.x1 = ib.x1 - ox; out.y1 = ib.y1 - oy;
        any = true;
      }
    }
    if (this.ghost.nPolys > 0) {
      const g = this.ghostBox;
      out.x0 = Math.min(out.x0, g.x0); out.y0 = Math.min(out.y0, g.y0);
      out.x1 = Math.max(out.x1, g.x1); out.y1 = Math.max(out.y1, g.y1);
      any = true;
    }
    return any;
  }

  override animating(): boolean { return !this.dead && !this.baking; }

  fastForward(now: number, cx: LayerCx): void {
    if (this.baking || this.dead) return;
    this.ageAll();
    const O = this.oldS;
    for (let q = 0; q < this.fo.n; q++) { const j = this.fo.a[q]; dirtyEntry(cx.wet, O, j, this.m, this.sc); }
    this.fo.clear();
    if (this.ghost.nPolys > 0) { const g = this.ghostBox; addBox(cx.wet, this.m, g.x0, g.y0, g.x1, g.y1, 4); this.ghost.truncate(0); }
    this.step(now, cx);
  }
}
