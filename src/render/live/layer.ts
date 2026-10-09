/**
 * The live layer itself: createLiveLayer owns the items, the frame loop, dirty-rect repaints of
 * #dry / #wet, the nib's halo, prediction, and the LiveLayer API the renderer calls.
 */
import type { AABB, Cooked, DraftStroke, IncrementalCook, InputSample, MorphSet, StrokeRecipe } from '../../core/types';
import { S as SR } from '../../core/types';
import { rstats } from '../stats';
import { nibWidth } from '../../ink/nibs';
import { swatchCss } from '../../ink/color';
import type { Halo, LiveCopy, LiveHost, LiveLayerInternal, OverlayInternal } from '../types';
import { BRIM_MS, GROW_MS, HOT, MAX_ANIMATING, RESTYLE_UNGROW_MS, UNGROW_MS, haloAlpha } from './timing';
import { RectList, overlaps } from './polys';
import { type Ctx2D, drawGlow } from './draw';
import { type BakeJob, type Item, type LayerCx, TAG_FINISH, TAG_LIVE, TMP_BOX, WakeItem, visibleReveal } from './items';
import { FinishStroke, LiveStroke } from './stroke';
import { type PlayOpts, PlayStroke } from './play';
import { AnimStroke, BAKE, GROW, LIFTED, REST, UNGROW, WAIT, depthOnlyChange, diffMasks } from './anim';

// ============================================================================ the layer

/** Optional LiveHost extension: where predicted tails go (render-live contract request §1). */
export interface LiveHostExt extends LiveHost {
  readonly overlay?: Pick<OverlayInternal, 'predicted'> | null;
  /**
   * #dry or #wet became blank (cleared with nothing drawn) or holds ink again. The renderer hides a
   * blank layer so the compositor does not blend an empty full-viewport canvas every frame.
   */
  layerBlank?(layer: 'dry' | 'wet', blank: boolean): void;
}

/** Inspection of one item (tests, debug HUD). */
export interface LiveItemInfo {
  kind: 'live' | 'finish' | 'play' | 'anim';
  id: string | null;
  mode: string;
  animating: boolean;
  polys: number;
  wet: number;
  dry: number;
  hot: number;
  /** The geometry the per-poly arrays index (the live mirror, or the committed Cooked). */
  cooked: Cooked;
  /** Per-poly state (0 hidden, 1 wet, 2 dry), reveal, hot multiplier, morph t; valid until the next frame. */
  st: Uint8Array | null;
  rv: Float32Array | null;
  hv: Float32Array | null;
  mv: Float32Array | null;
}

/** Additive API of the live layer (beyond LiveLayerInternal). */
export interface LiveLayerExtras {
  /** Route predicted tails to the overlay (the renderer wires its overlay here). */
  attachOverlay(o: Pick<OverlayInternal, 'predicted'> | null): void;
  /** Snapshot of every item (tests, debug HUD; empty in production builds, __DEBUG__ off). */
  inspect(): LiveItemInfo[];
}

const MODE_NAMES = ['wait', 'grow', 'ungrow', 'bake', 'rest', 'lifted'];

/**
 * Build the live layer over the renderer's #dry / #wet canvases. Draws only inside frame()
 * (and synchronously inside a bake's `done`, so a baked stroke never shows twice or vanishes).
 */
export function createLiveLayer(host: LiveHost): LiveLayerInternal & LiveLayerExtras {
  const items: Item[] = [];
  let live: LiveStroke | null = null;
  /** Symmetry copies of the live stroke (same cook, own placement and colour). */
  let followers: LiveStroke[] = [];
  let overlay: Pick<OverlayInternal, 'predicted'> | null = (host as LiveHostExt).overlay ?? null;
  let camRev = 1, groundRev = 1;
  let lastW = -1, lastH = -1, lastDpr = -1;
  const g0 = host.ground();
  const cx: LayerCx = {
    host, now: host.now(), rm: host.reducedMotion(), ground: g0, H: HOT[g0].h, tau: HOT[g0].tau,
    camRev, groundRev, wet: new RectList(), dry: new RectList(),
    bake(job: BakeJob): void { host.bake(job.r, job.c, () => onBaked(job.item)); },
  };
  cx.wet.setFull(); cx.dry.setFull();

  // halo (DESIGN §3.1): drawn as ink in #wet
  const halo = { on: false, x: 0, y: 0, r: 0, level: 0, pre: 0, brim: false, css: '', flashT0: -Infinity };
  const haloBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };
  const clip: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const ib: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };

  // prediction scratch (no allocation per event)
  const predSeq: InputSample[] = [];
  const mkSample = (): InputSample => ({ x: 0, y: 0, t: NaN, p: NaN, alt: Math.PI / 2, az: 0, r: NaN, predicted: false });
  const bridgeA = mkSample(), bridgeB = mkSample();

  let dryCtx: Ctx2D | null = null, wetCtx: Ctx2D | null = null;
  /**
   * [#dry, #wet] hold no pixels: fully cleared with nothing drawn since. A full repaint of a blank
   * canvas with nothing to draw (every camera frame of a pan or zoom with no live ink) is skipped.
   */
  const blank = [false, false];
  const setBlank = (k: number, b: boolean): void => {
    if (blank[k] === b) return;
    blank[k] = b;
    (host as LiveHostExt).layerBlank?.(k ? 'wet' : 'dry', b);
  };
  const anyInk = (wet: boolean): boolean => {
    for (const it of items) if (!it.dead) return true;
    return wet && halo.on;
  };
  const ctxOf = (c: HTMLCanvasElement): Ctx2D | null => c.getContext('2d') as Ctx2D | null;

  function prepare(now: number): void {
    cx.now = now;
    cx.rm = host.reducedMotion();
    const g = host.ground();
    if (g !== cx.ground) { cx.ground = g; groundRev++; cx.wet.setFull(); cx.dry.setFull(); }
    const hp = HOT[cx.ground];
    cx.H = cx.rm ? 0 : hp.h;
    cx.tau = hp.tau;
    const W = host.dry.width, Hh = host.dry.height, dpr = host.dpr();
    if (W !== lastW || Hh !== lastH || dpr !== lastDpr) {
      lastW = W; lastH = Hh; lastDpr = dpr;
      camRev++;
      cx.wet.setFull(); cx.dry.setFull();
    }
    cx.camRev = camRev;
    cx.groundRev = groundRev;
    for (const it of items) if (!it.dead) it.refresh(cx);
  }

  function repaint(wet: boolean): void {
    const list = wet ? cx.wet : cx.dry;
    if (list.empty) return;
    const canvas = wet ? host.wet : host.dry;
    let ctx = wet ? wetCtx : dryCtx;
    if (!ctx) { ctx = ctxOf(canvas); if (wet) wetCtx = ctx; else dryCtx = ctx; }
    const W = canvas.width, H = canvas.height;
    if (!ctx || !(W > 0 && H > 0)) { list.clear(); return; }
    const k = wet ? 1 : 0;
    if (list.full && blank[k] && !anyInk(wet)) { list.clear(); return; }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const full = list.full;
    let drew = false;
    if (full) {
      clip.x0 = 0; clip.y0 = 0; clip.x1 = W; clip.y1 = H;
      ctx.clearRect(0, 0, W, H);
      rstats.c.fullClears++;
    } else {
      list.clampTo(W, H);
      if (!list.bbox(clip)) { ctx.restore(); list.clear(); return; }
      ctx.beginPath();
      for (let k = 0; k < list.n; k++) {
        const o = 4 * k;
        ctx.rect(list.r[o], list.r[o + 1], list.r[o + 2] - list.r[o], list.r[o + 3] - list.r[o + 1]);
      }
      ctx.clip();
      ctx.clearRect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
    }
    list.clear();
    for (const it of items) {
      if (it.dead || !it.devBox(ib) || !overlaps(ib, clip)) continue;
      drew = true;
      if (wet) it.drawWet(ctx, clip, cx); else it.drawDry(ctx, clip, cx);
    }
    if (wet && halo.on && haloRect(ib) && overlaps(ib, clip)) {
      drew = true;
      const dpr = host.dpr();
      drawGlow(ctx, halo.x * dpr, halo.y * dpr, halo.r * dpr, haloAlpha(halo.pre, halo.level, cx.now - halo.flashT0, cx.rm),
        halo.css, cx.ground === 'night' ? 'lighter' : 'multiply');
    }
    ctx.restore();
    if (full) setBlank(k, !drew); else if (drew) setBlank(k, false);
  }

  function flush(): void { repaint(false); repaint(true); }

  function haloRect(out: AABB): boolean {
    if (!halo.on) return false;
    const dpr = host.dpr();
    out.x0 = (halo.x - halo.r) * dpr - 3; out.y0 = (halo.y - halo.r) * dpr - 3;
    out.x1 = (halo.x + halo.r) * dpr + 3; out.y1 = (halo.y + halo.r) * dpr + 3;
    return true;
  }

  function dirtyHalo(): void {
    if (haloRect(haloBox)) cx.wet.add(haloBox.x0, haloBox.y0, haloBox.x1, haloBox.y1);
  }

  /**
   * The halo belongs to the nib: begin, lift and withdraw end it, so a halo the caller did not
   * clear never outlives its stroke (decision; a still-held nib re-sends it the next frame).
   */
  function endHalo(): void {
    if (!halo.on) return;
    dirtyHalo();
    halo.on = false; halo.brim = false; halo.flashT0 = -Infinity;
  }

  function onBaked(item: Item): void {
    if (item.dead) return;
    if (item.devBox(ib)) cx.dry.add(ib.x0, ib.y0, ib.x1, ib.y1);
    item.dead = true;
    repaint(false);
  }

  function sweep(): void {
    let w = 0;
    for (let k = 0; k < items.length; k++) if (!items[k].dead) items[w++] = items[k];
    items.length = w;
    if (live && live.dead) live = null;
    if (followers.length && followers.some(f => f.dead)) followers = followers.filter(f => !f.dead);
  }

  function replace(a: Item, b: Item): void {
    const k = items.indexOf(a);
    if (k >= 0) items[k] = b; else items.push(b);
  }

  /**
   * At most MAX_ANIMATING strokes animate; older ones fast-forward. A symmetry group (a stroke and
   * the copies whose `lead` it is) counts as one and fast-forwards together, so they never part ways.
   */
  function capAnimations(now: number): void {
    let n = 0;
    for (const it of items) if (!it.dead && !leadOf(it) && it.animating()) n++;
    for (let k = 0; k < items.length && n > MAX_ANIMATING; k++) {
      const it = items[k];
      if (it.dead || it === live || leadOf(it) || !it.animating()) continue;
      it.fastForward(now, cx);
      for (const c of items) if (leadOf(c) === it && !c.dead) c.fastForward(now, cx);
      n--;
    }
  }

  function killId(id: string | null | undefined): void {
    if (!id) return;
    for (const it of items) if (!it.dead && it.id === id && it.tag !== TAG_LIVE && !(it instanceof AnimStroke && it.mode === LIFTED)) it.kill(cx);
  }

  const leadOf = (it: Item): Item | null => (it instanceof WakeItem ? it.lead : null);

  function begin(d: DraftStroke, cook: IncrementalCook, copies: readonly LiveCopy[] = []): void {
    if (live) withdraw();
    const now = host.now();
    prepare(now);
    endHalo();
    const ls = new LiveStroke(d, cook);
    ls.refresh(cx);
    ls.tipCss = swatchCss(d.color, cx.ground);
    ls.tipW = nibWidth(d.stroke.nib, d.stroke.size, 0.6, 0, d.device) / (d.z > 0 ? d.z : 1);
    live = ls;
    items.push(ls);
    followers = copies.map(cp => {
      const f = new LiveStroke({ ...d, color: cp.color }, cook);
      f.lead = ls;
      f.xf = cp.xf;
      f.refresh(cx);
      items.push(f);
      return f;
    });
    host.requestFrame();
  }

  function withdrawOne(ls: LiveStroke, now: number): void {
    if (ls.cookDirty) ls.step(now, cx);
    const keep = !cx.rm && ls.M.nPolys > 0;
    ls.kill(cx);
    if (keep) {
      const a = new AnimStroke(ls.d, ls.M, ls.form, UNGROW, now, UNGROW_MS);
      a.xf = ls.xf;
      a.cap = visibleReveal(ls);
      a.refresh(cx);
      replace(ls, a);
    }
  }

  function withdraw(): void {
    const ls = live;
    if (!ls) return;
    live = null;
    const fs = followers;
    followers = [];
    const now = host.now();
    prepare(now);
    endHalo();
    withdrawOne(ls, now);
    for (const f of fs) withdrawOne(f, now);
    capAnimations(now);
    host.requestFrame();
  }

  function commit(r: StrokeRecipe, c: Cooked, copies: readonly { r: StrokeRecipe; c: Cooked }[] = []): void {
    const now = host.now();
    prepare(now);
    const ls = live;
    const fs = followers;
    followers = [];
    const bake = (br: StrokeRecipe, bc: Cooked): void => {
      killId(br.id);
      const a = new AnimStroke(br, bc, br.form.form, BAKE, now, 0);
      a.refresh(cx);
      items.push(a);
    };
    let finished = 0; // copies finished from their live follower; the rest bake directly
    if (ls) {
      live = null;
      endHalo();
      let fold: MorphSet | null = null;
      if (ls.form === 'echo' && !cx.rm) {
        const v = ls.cook.view();
        const mo = v.morph;
        if (mo && v.geom.nPolys === c.nPolys && v.geom.nPts === c.nPts && mo.from.length >= 2 * c.nPts && mo.polyFirst.length > 0) fold = mo;
      }
      // the copies' live mirrors are current before the stroke's cook moves on
      for (const f of fs) if (f.cookDirty) f.step(now, cx);
      const f0 = new FinishStroke(ls, r, c, now, cx, fold);
      ls.dead = true;
      replace(ls, f0);
      for (const fl of fs) {
        if (finished < copies.length) {
          // drawn from the stroke's own geometry through the copy's placement; bakes the placed geometry
          const cp = copies[finished++];
          const fk = new FinishStroke(fl, cp.r, c, now, cx, fold, cp.c);
          fk.lead = f0;
          fl.dead = true;
          replace(fl, fk);
        } else fl.kill(cx);
      }
      capAnimations(now);
    } else {
      for (const f of fs) f.kill(cx);
      bake(r, c);
    }
    for (const cp of copies.slice(finished)) bake(cp.r, cp.c);
    host.requestFrame();
  }

  function setHalo(h: Halo | null): void {
    const now = host.now();
    if (halo.on) dirtyHalo();
    if (!h) {
      halo.on = false;
      halo.brim = false;
      if (live) live.onHalo(false, now);
      for (const f of followers) f.onHalo(false, now);
      host.requestFrame();
      return;
    }
    if (h.brim && !halo.brim) halo.flashT0 = now;
    halo.on = true;
    halo.x = h.x; halo.y = h.y; halo.r = h.rCss; halo.level = h.level; halo.pre = h.pre; halo.brim = h.brim; halo.css = h.css;
    dirtyHalo();
    if (live) live.onHalo(true, now);
    for (const f of followers) f.onHalo(true, now);
    host.requestFrame();
  }

  function predict(tail: readonly InputSample[]): void {
    const o = overlay;
    if (!o) return;
    const ls = live;
    if (!ls) { o.predicted(null, 0, ''); return; }
    const cam = host.camera(), vp = host.viewport();
    const ox = ls.origin[0] - cam.cx, oy = ls.origin[1] - cam.cy, s = cam.scale, hw = vp.w * 0.5, hh = vp.h * 0.5;
    predSeq.length = 0;
    if (ls.tipX === ls.tipX) {
      bridgeA.x = (ox + ls.tipX) * s + hw; bridgeA.y = (oy + ls.tipY) * s + hh;
      predSeq.push(bridgeA);
    }
    const rows = ls.d.samples.n;
    if (rows > 0) {
      const D = ls.d.samples.data, b = (rows - 1) * SR.STRIDE;
      bridgeB.x = (ox + D[b + SR.X]) * s + hw; bridgeB.y = (oy + D[b + SR.Y]) * s + hh;
      predSeq.push(bridgeB);
    }
    for (let k = 0; k < tail.length; k++) predSeq.push(tail[k]);
    if (predSeq.length < 2) { o.predicted(null, 0, ''); return; }
    o.predicted(predSeq, Math.max(1, ls.tipW * s), ls.tipCss);
  }

  function frame(now: number): boolean {
    prepare(now);
    let busy = false;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (!it.dead && it.step(now, cx)) busy = true;
    }
    if (halo.on && !cx.rm && now - halo.flashT0 < BRIM_MS + 20) { dirtyHalo(); busy = true; }
    sweep();
    flush();
    return busy;
  }

  function fastForwardAll(): void {
    const now = host.now();
    prepare(now);
    for (const it of items.slice()) if (!it.dead) it.fastForward(now, cx);
    halo.flashT0 = -Infinity;
    sweep();
    host.requestFrame();
  }

  const layer: LiveLayerInternal & LiveLayerExtras = {
    begin,
    update(): void {
      if (live) {
        live.cookDirty = true;
        for (const f of followers) f.cookDirty = true;
        host.requestFrame();
      }
    },
    predict,
    halo: setHalo,
    commit,
    withdraw,
    play(r: StrokeRecipe, c: Cooked, opts?: PlayOpts): number {
      const now = host.now();
      prepare(now);
      killId(r.id);
      const p = new PlayStroke(r, c, opts, now, cx);
      p.refresh(cx);
      // a symmetry copy plays with the stroke it was drawn by (same pen-down): the group counts as
      // one animation in capAnimations, so a mandala's petals never pop in fast-forwarded
      if (r.xf) {
        for (let k = items.length - 1; k >= 0; k--) {
          const it = items[k];
          if (!it.dead && it instanceof PlayStroke && !it.lead && it.r.created === r.created) { p.lead = it; break; }
        }
      }
      items.push(p);
      capAnimations(now);
      host.requestFrame();
      return p.tEnd;
    },
    dissolve(ms: number): void {
      const now = host.now();
      prepare(now);
      for (const it of items.slice()) {
        if (it.dead) continue;
        const resting = (it instanceof PlayStroke && !it.bakeAfter) || (it instanceof AnimStroke && it.mode === REST);
        if (!resting) continue;
        it.kill(cx);
        if (cx.rm || !(ms > 0)) continue;
        const src = it instanceof PlayStroke ? it : (it as AnimStroke);
        const a = new AnimStroke(src.r, src.c, src.form, UNGROW, now, ms);
        if (it instanceof PlayStroke && !it.isResting) a.cap = visibleReveal(it);
        a.refresh(cx);
        replace(it, a);
      }
      capAnimations(now);
      host.requestFrame();
    },
    fastForward: fastForwardAll,
    get animating(): number {
      let n = 0;
      for (const it of items) if (!it.dead && it.animating()) n++;
      return n;
    },
    get active(): boolean { return live !== null; },
    frame,
    grow(list): void {
      const now = host.now();
      prepare(now);
      for (const { r, c } of list) {
        killId(r.id);
        const a = new AnimStroke(r, c, r.form.form, cx.rm ? BAKE : GROW, now, GROW_MS);
        a.refresh(cx);
        items.push(a);
      }
      capAnimations(now);
      host.requestFrame();
    },
    ungrow(list): void {
      const now = host.now();
      prepare(now);
      for (const { r, c } of list) {
        killId(r.id);
        if (cx.rm) continue;
        const a = new AnimStroke(r, c, r.form.form, UNGROW, now, UNGROW_MS);
        a.refresh(cx);
        items.push(a);
      }
      capAnimations(now);
      host.requestFrame();
    },
    morph(before, after): void {
      const now = host.now();
      prepare(now);
      for (const { r } of before) killId(r.id);
      for (const { r } of after) killId(r.id);
      const paired = new Uint8Array(before.length);
      for (let k = 0; k < after.length; k++) {
        const { r, c } = after[k];
        // the old revision of the same stroke
        let b = k < before.length && before[k].r.id === r.id ? k : -1;
        if (b < 0) for (let q = 0; q < before.length; q++) if (before[q].r.id === r.id) { b = q; break; }
        if (b >= 0 && depthOnlyChange(before[b].r, r)) {
          // a change of growth, not of look: shared ink stays, the old growth drains, the new grows
          paired[b] = 1;
          if (cx.rm) { const a = new AnimStroke(r, c, r.form.form, BAKE, now, 0); a.refresh(cx); items.push(a); continue; }
          const { bMask, aMask } = diffMasks(before[b].c, c);
          // only the old revision's own ink drains, only the new one's own ink grows; a side
          // with nothing of its own skips its phase (a drain-only peel bakes the new one at once)
          const drains = bMask.indexOf(0) >= 0, grows = aMask.indexOf(0) >= 0;
          if (drains) {
            const u = new AnimStroke(before[b].r, before[b].c, before[b].r.form.form, UNGROW, now, UNGROW_MS, bMask);
            u.refresh(cx);
            items.push(u);
          }
          const a = grows
            ? new AnimStroke(r, c, r.form.form, GROW, now + (drains ? UNGROW_MS : 0), GROW_MS, aMask)
            : new AnimStroke(r, c, r.form.form, BAKE, now, 0);
          a.refresh(cx);
          items.push(a);
          continue;
        }
        const a = new AnimStroke(r, c, r.form.form, cx.rm ? BAKE : WAIT, now + RESTYLE_UNGROW_MS, GROW_MS);
        a.refresh(cx);
        items.push(a);
      }
      if (!cx.rm) {
        for (let k = 0; k < before.length; k++) {
          if (paired[k] === 1) continue;
          const { r, c } = before[k];
          const a = new AnimStroke(r, c, r.form.form, UNGROW, now, RESTYLE_UNGROW_MS);
          a.refresh(cx);
          items.push(a);
        }
      }
      capAnimations(now);
      host.requestFrame();
    },
    setLifted(list): void {
      const now = host.now();
      prepare(now);
      for (const it of items) if (!it.dead && it instanceof AnimStroke && it.mode === LIFTED) it.kill(cx);
      if (list) {
        for (const { r, c } of list) {
          const a = new AnimStroke(r, c, r.form.form, LIFTED, now, 0);
          a.refresh(cx);
          items.push(a);
          const b = TMP_BOX;
          if (a.devBox(b)) cx.dry.add(b.x0, b.y0, b.x1, b.y1);
        }
      }
      sweep();
      host.requestFrame();
    },
    onCamera(phase: 'gesture' | 'settled'): void {
      camRev++;
      cx.wet.setFull(); cx.dry.setFull();
      if (phase === 'gesture') fastForwardAll();
      host.requestFrame();
    },
    resize(): void {
      camRev++;
      cx.wet.setFull(); cx.dry.setFull();
      host.requestFrame();
    },
    onGround(): void {
      groundRev++;
      cx.wet.setFull(); cx.dry.setFull();
      host.requestFrame();
    },
    attachOverlay(o): void { overlay = o; },
    inspect(): LiveItemInfo[] {
      const out: LiveItemInfo[] = [];
      if (!__DEBUG__) return out; // tests and debug HUD only: production builds drop the walk
      for (const it of items) {
        if (it.dead) continue;
        if (it instanceof WakeItem) {
          out.push({
            kind: it.tag === TAG_LIVE ? 'live' : it.tag === TAG_FINISH ? 'finish' : 'play', id: it.id,
            mode: it.dryAll ? 'dry' : 'wake', animating: it.animating(), polys: it.src.nPolys,
            wet: it.wd.n, dry: it.dryAll ? it.src.nPolys : it.dry.n, hot: it.hot.n, cooked: it.src,
            st: it.S.st, rv: it.S.rv, hv: it.S.hv, mv: it.S.mv,
          });
        } else if (it instanceof AnimStroke) {
          out.push({
            kind: 'anim', id: it.id, mode: MODE_NAMES[it.mode], animating: it.animating(), polys: it.c.nPolys,
            wet: it.mode === GROW || it.mode === UNGROW ? it.c.nPolys : 0,
            dry: it.mode === BAKE || it.mode === REST || it.mode === LIFTED ? it.c.nPolys : 0, hot: 0, cooked: it.c,
            st: null, rv: it.rv, hv: null, mv: null,
          });
        }
      }
      return out;
    },
  };
  return layer;
}
