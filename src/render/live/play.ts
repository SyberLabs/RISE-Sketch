/** Replays and the first-run seed: a recorded stroke drawing itself (PlayStroke). */
import type { AABB, Cooked, StrokeRecipe } from '../../core/types';
import { PL, S as SR } from '../../core/types';
import { clamp01 } from '../../core/num';
import { kernel } from '../../ink/depth';
import { swatchCss } from '../../ink/color';
import { ArcClock, PLAY_OUT, PLAY_PRE, REACH, driftN, echoFoldMs, genOffset, haloAlpha, revealMs } from './timing';
import { addBox, computeChains } from './polys';
import { type Ctx2D, drawGlow } from './draw';
import { DRY, HIDDEN, type LayerCx, TAG_PLAY, TMP_BOX2, WakeItem, maxPool } from './items';

// ---------------------------------------------------------------------------- replay

/** Options of LiveLayer.play. */
export interface PlayOpts { durationScale?: number; bake?: boolean }

/**
 * A recorded stroke drawing itself (replay, first-run seed): the trunk follows its own sample
 * timing, growth unfurls a hand's breadth behind the nib, units under a pool rise through their
 * depth over the pool's recorded interval (Sprout generations and Drift lengths follow the
 * fractional-depth contract, so the prefix reveal reproduces the rising geometry), and a halo
 * swells over each pool. Then it bakes (or rests until dissolve() when opts.bake is false).
 */
export class PlayStroke extends WakeItem {
  readonly tag = TAG_PLAY;
  readonly bakeAfter: boolean;
  private readonly tStart: number;
  private readonly scale: number;
  /** When the whole play (trunk, growth, pools) ends, on the host clock. */
  readonly tEnd: number;
  private resting = false;
  private baking = false;
  private ffDone = false;
  // pools (stroke clock, unscaled ms) and per-poly dominant pool
  private readonly pS: Float32Array;
  private readonly pA: Float32Array;
  private readonly pT0: Float32Array;
  private readonly pT1: Float32Array;
  private readonly poolIdx: Int32Array;
  /** a_j·K(born − s_j) of the dominant pool (Float64: the final fraction must come out exactly 1). */
  private readonly poolV: Float64Array;
  private readonly base: number;
  // synthetic halo
  private readonly hx: Float32Array;
  private readonly hy: Float32Array;
  private readonly hr: Float32Array;
  private haloOn = false;
  private haloX = 0; private haloY = 0; private haloR = 0; private haloA = 0;
  private haloCss = '';
  private haloRev = -1;

  constructor(readonly r: StrokeRecipe, readonly c: Cooked, opts: PlayOpts | undefined, now: number, cx: LayerCx) {
    super(r, r.origin, r.form.form, new ArcClock(), c);
    this.id = r.id;
    this.arcReveal = true;
    this.bakeAfter = !opts || opts.bake !== false;
    const scale = opts && opts.durationScale !== undefined && opts.durationScale > 0 ? opts.durationScale : 1;
    this.scale = scale;
    this.tStart = now;
    const S = this.S, n = c.nPolys, p = c.pts;
    S.ensure(n);
    S.n = n;
    for (let i = 0; i < n; i++) { S.keyFrom(c, i, i); S.init(i, HIDDEN, now); S.settled[i] = 1; }
    computeChains(c, S, 0);
    this.updateMaxW();
    // trunk arc range
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (c.gen[i] !== 0) continue;
      const st = c.start[i], cnt = c.count[i], born = c.born[i];
      const a = born + p[4 * st + 3], b = born + (cnt > 0 ? p[4 * (st + cnt - 1) + 3] : 0);
      if (a < sMin) sMin = a; if (b > sMax) sMax = b;
    }
    if (!(sMax >= sMin)) { sMin = r.s0; sMax = r.s0; }
    // the clock: raw sample arc, normalised onto the trunk's arc range
    const rows = Math.floor(r.samples.length / SR.STRIDE), sm = r.samples;
    let total = 0;
    for (let k = 1; k < rows; k++) {
      const dx = sm[k * SR.STRIDE + SR.X] - sm[(k - 1) * SR.STRIDE + SR.X], dy = sm[k * SR.STRIDE + SR.Y] - sm[(k - 1) * SR.STRIDE + SR.Y];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d === d) total += d;
    }
    let acc = 0, tLast = 0;
    for (let k = 0; k < rows; k++) {
      if (k > 0) {
        const dx = sm[k * SR.STRIDE + SR.X] - sm[(k - 1) * SR.STRIDE + SR.X], dy = sm[k * SR.STRIDE + SR.Y] - sm[(k - 1) * SR.STRIDE + SR.Y];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d === d) acc += d;
      }
      const t = sm[k * SR.STRIDE + SR.T];
      if (!(t === t)) continue;
      const s = total > 0 ? sMin + (sMax - sMin) * (acc / total) : sMin;
      this.clock.mark(k === rows - 1 ? sMax : s, now + t * scale);
      tLast = t;
    }
    // the trunk's end always lands on the clock (the last row may be a dropped near-duplicate)
    this.clock.mark(sMax, now + tLast * scale, true);
    const tStrokeEnd = now + tLast * scale;
    this.beyond = tStrokeEnd;
    // growth schedule
    const form = this.form, T = revealMs(form) * scale;
    const lag = 24 + REACH[form];
    const dE = r.form.base + maxPool(r);
    let tEnd = tStrokeEnd;
    for (let i = 0; i < n; i++) {
      const gen = c.gen[i];
      if (gen === 0) continue;
      if (form === 'echo') { S.rs[i] = tStrokeEnd; S.rd[i] = echoFoldMs(dE) * scale; }
      else { S.rs[i] = this.clock.at(c.born[i] + lag, tStrokeEnd) + genOffset(form, gen, T); S.rd[i] = T; }
      S.t1[i] = S.rs[i];
      if (S.rs[i] + S.rd[i] > tEnd) tEnd = S.rs[i] + S.rd[i];
    }
    // pools
    const np = Math.floor(r.pools.length / PL.STRIDE);
    this.pS = new Float32Array(np); this.pA = new Float32Array(np); this.pT0 = new Float32Array(np); this.pT1 = new Float32Array(np);
    for (let j = 0; j < np; j++) {
      const o = j * PL.STRIDE;
      this.pS[j] = r.pools[o + PL.S]; this.pA[j] = r.pools[o + PL.A];
      this.pT0[j] = r.pools[o + PL.T0]; this.pT1[j] = r.pools[o + PL.T1];
      const e = now + Math.max(this.pT1[j], this.pT0[j]) * scale + PLAY_OUT;
      if (e > tEnd) tEnd = e;
    }
    this.tEnd = tEnd;
    this.base = r.form.base;
    this.poolIdx = new Int32Array(n).fill(-1);
    this.poolV = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (c.gen[i] === 0) continue;
      let best = 0, bj = -1;
      for (let j = 0; j < np; j++) {
        const v = this.pA[j] * kernel(c.born[i] - this.pS[j]);
        if (v > best) { best = v; bj = j; }
      }
      this.poolIdx[i] = bj; this.poolV[i] = best;
      // like the live cook's provisional growth: a unit a pool raises shows as soon as the pool
      // starts rising, even before the nib has moved on far enough to settle it
      if (bj >= 0 && form !== 'echo') {
        const tp = now + this.pT0[bj] * scale + genOffset(form, c.gen[i], T);
        if (tp < S.rs[i]) { S.rs[i] = tp; S.t1[i] = tp; }
      }
    }
    // halo positions: the trunk point (doc) and half width at each pool's arc
    this.hx = new Float32Array(np); this.hy = new Float32Array(np); this.hr = new Float32Array(np);
    for (let j = 0; j < np; j++) this.trunkPoint(this.pS[j], j);
    for (let i = 0; i < n; i++) S.st[i] = HIDDEN;
    if (cx.rm) {
      for (let i = 0; i < n; i++) S.st[i] = DRY;
      this.ffDone = true;
    }
    this.rebuildAct();
    this.rebuildDry();
    const b = TMP_BOX2;
    if (cx.rm && this.devBox(b)) cx.dry.add(b.x0, b.y0, b.x1, b.y1);
  }

  /** Trunk position and halo radius (doc) at absolute arc s, for pool j. */
  private trunkPoint(s: number, j: number): void {
    const c = this.c, p = c.pts;
    let bestD = Infinity;
    for (let i = 0; i < c.nPolys; i++) {
      if (c.gen[i] !== 0) continue;
      const st = c.start[i], cnt = c.count[i], born = c.born[i];
      for (let k = 0; k < cnt; k++) {
        const a = born + p[4 * (st + k) + 3];
        const d = Math.abs(a - s);
        if (d < bestD) {
          bestD = d;
          this.hx[j] = p[4 * (st + k)]; this.hy[j] = p[4 * (st + k) + 1];
          this.hr[j] = 0.5 * p[4 * (st + k) + 2] + 6 / (this.r.z > 0 ? this.r.z : 1);
        }
      }
    }
  }

  protected override beyondAt(): number { return this.beyond; }

  protected override depthFrac(i: number, now: number): number {
    const j = this.poolIdx[i];
    if (j < 0 || this.ffDone) return 1;
    const tRel = (now - this.tStart) / this.scale;
    const t0 = this.pT0[j], t1 = this.pT1[j];
    const u = t1 > t0 ? clamp01((tRel - t0) / (t1 - t0)) : (tRel >= t0 ? 1 : 0);
    if (u >= 1) return 1;
    this.depthPending = true;
    const D = this.base + this.poolV[i] * u, Df = this.base + this.poolV[i];
    if (this.form === 'sprout') {
      const g = this.c.gen[i];
      const ff = clamp01(Df - g + 1);
      return ff > 0 ? clamp01(D - g + 1) / ff : 1;
    }
    if (this.form === 'drift') {
      const nf = driftN(Df);
      return nf > 0 ? Math.min(1, driftN(D) / nf) : 1;
    }
    return 1;
  }

  step(now: number, cx: LayerCx): boolean {
    this.refresh(cx);
    if (this.resting || this.baking || this.dead) return false;
    this.sVis = this.ffDone || now >= this.beyond ? Infinity : this.clock.arcAt(now);
    this.tip = this.sVis === Infinity ? this.clock.last : this.sVis;
    let busy = this.stepPolys(now, cx);
    if (this.stepHalo(now, cx)) busy = true;
    if (!this.ffDone && now < this.tEnd) busy = true;
    this.busy = busy;
    if (!busy && this.act.n === 0) {
      this.dryAll = true;
      this.wd.clear(); this.hot.clear();
      if (this.bakeAfter) { this.baking = true; cx.bake({ item: this, r: this.r, c: this.c }); } else this.resting = true;
    }
    return busy;
  }

  private stepHalo(now: number, cx: LayerCx): boolean {
    const np = this.pS.length;
    const wasOn = this.haloOn;
    const ox = this.haloX, oy = this.haloY, or = this.haloR;
    this.haloOn = false;
    if (np === 0 || this.ffDone || cx.rm) {
      if (wasOn) this.dirtyGlow(cx, ox, oy, or);
      return false;
    }
    const tRel = (now - this.tStart) / this.scale;
    let busy = false;
    for (let j = 0; j < np; j++) {
      const t0 = this.pT0[j], t1 = Math.max(this.pT1[j], t0);
      if (tRel < t0 - PLAY_PRE) { busy = true; continue; }
      if (tRel > t1 + PLAY_OUT) continue;
      busy = true;
      const pre = clamp01((tRel - (t0 - PLAY_PRE)) / PLAY_PRE);
      const u = t1 > t0 ? clamp01((tRel - t0) / (t1 - t0)) : 1;
      const level = (this.base + this.pA[j] * u) / Math.max(1e-6, this.c.ceilingMax > 0 ? this.c.ceilingMax : this.base + this.pA[j]);
      const out = 1 - clamp01((tRel - t1) / PLAY_OUT);
      this.haloOn = true;
      this.haloX = this.hx[j]; this.haloY = this.hy[j]; this.haloR = this.hr[j];
      this.haloA = haloAlpha(pre, level, -1, false) * out;
    }
    if (wasOn) this.dirtyGlow(cx, ox, oy, or);
    if (this.haloOn) {
      this.dirtyGlow(cx, this.haloX, this.haloY, this.haloR);
      if (this.haloRev !== cx.groundRev) { this.haloCss = swatchCss(this.r.color, cx.ground); this.haloRev = cx.groundRev; }
    }
    return busy;
  }

  private dirtyGlow(cx: LayerCx, x: number, y: number, r: number): void {
    addBox(cx.wet, this.m, x - r, y - r, x + r, y + r, 3);
  }

  protected override drawExtras(ctx: Ctx2D, _clip: AABB, cx: LayerCx): void {
    if (!this.haloOn) return;
    const m = this.m;
    drawGlow(ctx, m[0] * this.haloX + m[2] * this.haloY + m[4], m[1] * this.haloX + m[3] * this.haloY + m[5],
      this.haloR * this.sc, this.haloA, this.haloCss, cx.ground === 'night' ? 'lighter' : 'multiply');
  }

  protected override extrasBox(out: AABB): boolean {
    if (!this.haloOn) return false;
    out.x0 = this.haloX - this.haloR; out.y0 = this.haloY - this.haloR;
    out.x1 = this.haloX + this.haloR; out.y1 = this.haloY + this.haloR;
    return true;
  }

  /** A resting replay (first-run seed) waiting for dissolve(). */
  get isResting(): boolean { return this.resting; }

  override animating(): boolean { return !this.dead && !this.resting && !this.baking; }

  fastForward(now: number, cx: LayerCx): void {
    if (this.resting || this.baking || this.dead) return;
    this.ffDone = true;
    this.ageAll();
    this.step(now, cx);
  }
}
