/**
 * Replay and the first-run seed (DESIGN §3.0, §8 Replay): committed strokes re-run through the
 * live pipeline (renderer.live.play) in creation order, on their own timestamps and pool timings.
 *
 *  - Speed k = max(1.5, T_ink / 18 s), where T_ink is the drawing time plus the gaps between
 *    strokes, each gap capped at 250 ms; durationScale = 1 / k.
 *  - The picture fades out (reset 'fade'), every stroke is held out of the tiles, and each play
 *    turns its hold into a live hold whose bake puts the stroke back (render-world notes §2).
 *  - A view that does not show the whole drawing fits it first (one glide), then plays.
 *  - Progress (0..1 of the scaled timeline) drives the 1 px line; the UI hides while `replaying`.
 *  - Any input stops playback: unplayed strokes return to the tiles without animation, playing
 *    ones fast-forward and bake.
 *
 * The seed is one recorded stroke (src/assets/seed.ts) placed at the view centre and played with
 * `bake: false`; it rests in the live layer until the first pointerdown dissolves it (200 ms,
 * instant under reduced motion). It never enters the document or history.
 */
import type { Cooked, StrokeId, StrokeRecipe } from '../core/types';
import { PL, S } from '../core/types';
import { cook } from '../ink/cook';
import { DEFAULT_CALIB } from '../ink/calib';
import { assignVariant } from '../ink/color';
import { freezeRecipe } from '../doc/commands';
import { firstRunSeed } from '../assets/seed';
import type { Runtime } from './runtime';
import type { View } from './view';

/** Replay never runs slower than this many times real time. */
export const MIN_SPEED = 1.5;
/** A replay aims to last at most this long (ms). */
export const TARGET_MS = 18000;
/** Pauses between strokes are shortened to this (ms). */
export const GAP_CAP_MS = 250;
/** The seed starts after this much idle time on first run (ms). */
export const SEED_DELAY_MS = 600;
/** The seed dissolves over this long at the first touch (ms). */
export const SEED_DISSOLVE_MS = 200;

/** Drawing time of a recipe on its own clock (ms since pen-down of its last sample or pool edit). */
export function strokeDuration(r: StrokeRecipe): number {
  let t = 0;
  for (let o = S.T; o < r.samples.length; o += S.STRIDE) { const v = r.samples[o]; if (v > t) t = v; }
  for (let o = PL.T1; o < r.pools.length; o += PL.STRIDE) { const v = r.pools[o]; if (v > t) t = v; }
  return t;
}

/** The replay timeline (pure): per-stroke start offsets on the scaled clock, total and speed. */
export function timeline(rs: readonly StrokeRecipe[]): { starts: Float64Array; total: number; k: number } {
  const n = rs.length;
  const starts = new Float64Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    starts[i] = t;
    const d = strokeDuration(rs[i]);
    t += d;
    if (i + 1 < n) {
      const gap = rs[i + 1].created - (rs[i].created + d);
      t += gap === gap ? Math.max(0, Math.min(GAP_CAP_MS, gap)) : GAP_CAP_MS;
    }
  }
  const k = Math.max(MIN_SPEED, t / TARGET_MS);
  for (let i = 0; i < n; i++) starts[i] /= k;
  return { starts, total: t / k, k };
}

export class Player {
  private items: { r: StrokeRecipe; c: Cooked }[] = [];
  private starts: Float64Array = new Float64Array(0);
  private total = 0;
  private k = 1;
  private next = 0;
  private t0 = -1;
  private remove: (() => void) | null = null;
  private gen = 0;
  private seedShown = false;
  private seedTimer = 0;

  constructor(private readonly rt: Runtime, private readonly view: View) {}

  /** A replay is running (from the request until the last stroke has baked). */
  get playing(): boolean { return this.rt.store.get().replaying; }
  /** The seed is resting or playing in the live layer. */
  get seedOn(): boolean { return this.seedShown; }
  /** A seed is scheduled or showing (e2e idle waits for it). */
  get seedPending(): boolean { return this.seedTimer !== 0 || this.seedShown; }

  // ---------------------------------------------------------------- replay

  async start(): Promise<void> {
    const rt = this.rt;
    if (this.playing) return;
    const rs = rt.doc.ordered();
    if (!rs.length) return;
    const gen = ++this.gen;
    rt.store.set({ replaying: true, replayProgress: 0 });
    try { await rt.scene.ensure(rs.map(r => r.id), 'visible'); } catch { /* uncooked strokes are skipped */ }
    if (gen !== this.gen || !this.playing || rt.doc.ordered() !== rs) { if (gen === this.gen) this.finish(); return; }
    const items: { r: StrokeRecipe; c: Cooked }[] = [];
    for (const r of rs) { const c = rt.scene.cooked(r.id); if (c) items.push({ r, c }); }
    if (!items.length) { this.finish(); return; }
    const tl = timeline(items.map(it => it.r));
    this.items = items; this.starts = tl.starts; this.total = tl.total; this.k = tl.k;
    this.next = 0; this.t0 = -1;
    if (!this.view.contentVisible()) this.view.fit();
    rt.renderer.reset(rt.reduced() ? 'none' : 'fade');
    rt.renderer.hold(items.map(it => it.r.id));
    this.remove = rt.loop.add(now => this.frame(now), 7);
    rt.loop.request();
    rt.store.emit({ k: 'announce', text: `Replaying ${items.length} ${items.length === 1 ? 'stroke' : 'strokes'}` });
  }

  private frame(now: number): boolean {
    const rt = this.rt;
    if (!this.playing) return false;
    if (this.view.navActive) return true;  // the fit glide first
    if (this.t0 < 0) this.t0 = now;
    const elapsed = now - this.t0;
    const n = this.items.length;
    while (this.next < n && this.starts[this.next] <= elapsed) {
      const it = this.items[this.next++];
      rt.renderer.live.play(it.r, it.c, { durationScale: 1 / this.k });
    }
    const progress = this.total > 0 ? Math.min(1, elapsed / this.total) : 1;
    rt.store.set({ replayProgress: progress });
    if (this.next >= n && elapsed >= this.total && rt.renderer.live.animating === 0) { this.finish(); return false; }
    return true;
  }

  /** Any input: unplayed strokes return at once, playing ones fast-forward and bake. */
  stop(): void {
    if (!this.playing) return;
    this.gen++;
    const rt = this.rt;
    const rest: StrokeId[] = [];
    for (let i = this.next; i < this.items.length; i++) rest.push(this.items[i].r.id);
    rt.renderer.live.fastForward();
    if (rest.length) rt.renderer.release(rest);
    this.finish();
  }

  private finish(): void {
    if (this.remove) { this.remove(); this.remove = null; }
    this.items = [];
    this.next = 0;
    this.rt.store.set({ replaying: false, replayProgress: 0 });
  }

  // ---------------------------------------------------------------- first-run seed

  /** Arm the seed: it plays after 600 ms unless a contact comes first (DESIGN §3.0). */
  armSeed(): void {
    if (this.seedTimer || this.seedShown) return;
    this.seedTimer = window.setTimeout(() => { this.seedTimer = 0; this.playSeed(); }, SEED_DELAY_MS);
  }

  /** The seed is no longer wanted before it started (the user drew first). */
  disarmSeed(): void {
    if (this.seedTimer) { clearTimeout(this.seedTimer); this.seedTimer = 0; }
  }

  private playSeed(): void {
    const rt = this.rt, view = this.view;
    if (rt.doc.size > 0 || !rt.store.get().firstRun) return;
    const seed = firstRunSeed();
    const z = view.cam.scale;
    const origin = view.toDoc(view.W * 0.5, view.H * 0.38);
    const samples = new Float32Array(seed.samples);
    for (let o = 0; o < samples.length; o += S.STRIDE) { samples[o + S.X] /= z; samples[o + S.Y] /= z; }
    const r = freezeRecipe({
      id: 'seed', created: Date.now(), origin: [origin[0], origin[1]], z, rot: 0, seed: 0x5eed, device: seed.device,
      calib: DEFAULT_CALIB.pen, stroke: seed.stroke, color: assignVariant(seed.ink, 0, null, null), form: seed.form,
      s0: 0, cut: 0, resume: null, samples, pools: seed.pools, closed: false, radial: false, sym: null, xf: null,
    });
    let c: Cooked;
    try { c = cook(r); } catch (err) { console.error('[rise] seed did not cook', err); return; }
    this.seedShown = true;
    rt.renderer.live.play(r, c, { bake: false });
    rt.loop.request();
  }

  /** The first pointerdown (or a document change): un-grow the seed. */
  dissolveSeed(): void {
    this.disarmSeed();
    if (!this.seedShown) return;
    this.seedShown = false;
    this.rt.renderer.live.dissolve(this.rt.reduced() ? 0 : SEED_DISSOLVE_MS);
    this.rt.loop.request();
  }
}
