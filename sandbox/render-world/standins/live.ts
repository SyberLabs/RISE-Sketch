/**
 * SANDBOX STAND-IN for src/render/live.ts (render-live is writing the real one). Implements just
 * enough of LiveLayerInternal to exercise the renderer's LiveHost side: grow / un-grow / morph
 * with prefix reveals in #wet, lifted selection and baking strokes in #dry, two-phase bake via
 * host.bake with the same-rAF done(). Not product code; never imported from src.
 */
import type { Cooked, StrokeRecipe } from '../../../src/core/types';
import type { LiveHost, LiveLayerInternal } from '../../../src/render/types';
import { drawCooked } from '../../../src/render/raster';

interface Item { r: StrokeRecipe; c: Cooked }
interface Anim { kind: 'grow' | 'ungrow'; items: Item[]; t0: number; dur: number; bake: boolean; then?: () => void }

export function createLiveLayer(host: LiveHost): LiveLayerInternal {
  let lifted: Item[] | null = null;
  const baking: Item[] = [];
  const anims: Anim[] = [];
  const dctx = host.dry.getContext('2d')!;
  const wctx = host.wet.getContext('2d')!;
  let dirty = true;

  const ease = (t: number): number => { const u = 1 - Math.min(1, Math.max(0, t)); return 1 - u * u * u; };

  function draw(ctx: CanvasRenderingContext2D, it: Item, reveal: number | null): void {
    const m = host.matrixFor(it.r.origin);
    drawCooked(ctx, it.c, host.inkTable(it.r), m, reveal === null ? undefined : { reveal: () => reveal });
  }

  function redraw(now: number): void {
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, host.dry.width, host.dry.height);
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, host.wet.width, host.wet.height);
    if (lifted) for (const it of lifted) draw(dctx, it, null);
    for (const it of baking) draw(dctx, it, null);
    for (const a of anims) {
      const f = ease((now - a.t0) / a.dur);
      const rv = a.kind === 'grow' ? f : 1 - f;
      for (const it of a.items) draw(wctx, it, rv);
    }
    dirty = false;
  }

  function startBake(items: Item[]): void {
    for (const it of items) {
      baking.push(it);
      host.bake(it.r, it.c, () => {
        const i = baking.indexOf(it);
        if (i >= 0) baking.splice(i, 1);
        redraw(host.now());  // synchronously, in the same rAF
      });
    }
  }

  function finish(a: Anim): void {
    if (a.kind === 'grow' && a.bake) startBake(a.items);
    if (a.then) a.then();
  }

  function fastForward(): void {
    const all = anims.splice(0);
    for (const a of all) finish(a);
    dirty = true;
    host.requestFrame();
  }

  function add(a: Anim): void {
    if (host.reducedMotion()) { finish(a); dirty = true; host.requestFrame(); return; }
    while (anims.length >= 4) finish(anims.shift()!);
    anims.push(a);
    dirty = true;
    host.requestFrame();
  }

  const layer: LiveLayerInternal = {
    begin() {}, update() {}, predict() {}, halo() {}, withdraw() {}, dissolve() {},
    commit(r, c) { startBake([{ r, c }]); dirty = true; host.requestFrame(); },
    play(r, c, o) { add({ kind: 'grow', items: [{ r, c }], t0: host.now(), dur: 400 * (o?.durationScale ?? 1), bake: o?.bake !== false }); },
    fastForward,
    get animating() { return anims.length; },
    get active() { return false; },
    frame(now) {
      let more = false;
      for (let i = anims.length - 1; i >= 0; i--) {
        const a = anims[i];
        if (now - a.t0 >= a.dur) { anims.splice(i, 1); finish(a); }
      }
      if (anims.length) more = true;
      if (more || dirty) redraw(now);
      return more;
    },
    grow(items) { add({ kind: 'grow', items: items.slice(), t0: host.now(), dur: 450, bake: true }); },
    ungrow(items) { add({ kind: 'ungrow', items: items.slice(), t0: host.now(), dur: 200, bake: false }); },
    morph(before, after) {
      const a = after.slice();
      add({ kind: 'ungrow', items: before.slice(), t0: host.now(), dur: 150, bake: false, then: () => layer.grow(a) });
    },
    setLifted(items) { lifted = items ? items.slice() : null; dirty = true; host.requestFrame(); },
    onCamera(phase) { if (phase === 'gesture') fastForward(); dirty = true; host.requestFrame(); },
    resize() { dirty = true; host.requestFrame(); },
    onGround() { dirty = true; host.requestFrame(); },
  };
  return layer;
}
