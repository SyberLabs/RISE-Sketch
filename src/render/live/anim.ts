/**
 * Whole-stroke animations (AnimStroke: re-grow, un-grow, restyle turns, bake, rest, lifted) and
 * the diff restyle that keeps shared ink still when only depth inputs change.
 */
import type { AABB, ColorStyle, Cooked, FormId, InkTable, Mat2x3, StrokeRecipe } from '../../core/types';
import { clamp01, easeOutCubic } from '../../core/num';
import { multiply } from '../../core/mat';
import { chainReveal, genPhase } from './timing';
import { KeyTable, PolyState, type RectList, devOf, linked } from './polys';
import { type Ctx2D, dopts, drawInk } from './draw';
import { DOT, type Item, type LayerCx, type Rec, TAG_ANIM, TMP_BOX2 } from './items';

// ---------------------------------------------------------------------------- whole-stroke animations

/** AnimStroke modes. */
export const WAIT = 0, GROW = 1, UNGROW = 2, BAKE = 3, REST = 4, LIFTED = 5;

/**
 * A committed stroke drawn whole: re-grow (redo, restyle, load), un-grow (removal, withdraw,
 * dissolve), waiting for its restyle turn, baking, resting, or lifted (selection layer).
 */
export class AnimStroke implements Item {
  dead = false;
  readonly id: string | null;
  readonly tag = TAG_ANIM;
  mode: number;
  private table!: InkTable;
  private readonly m: Mat2x3 = new Float64Array(6);
  /** Placement composed into the matrix (a withdrawn symmetry copy); null = none. */
  xf: Mat2x3 | null = null;
  private sc = 1;
  private camRev = -1;
  private groundRev = -1;
  /** Per-poly reveal of the current growth / un-growth. */
  readonly rv: Float32Array;
  private readonly coff: Float32Array;
  private readonly ctot: Float32Array;
  private readonly len: Float32Array;
  private readonly sA: Float32Array;
  private readonly sB: Float32Array;
  private readonly G: number;
  /** Shallowest generation that animates (a diff restyle may leave the spine untouched). */
  private readonly gMin: number;
  private readonly fg: Float64Array;
  private readonly sMin: number;
  private readonly sMax: number;
  private maxW = 0;
  private readonly rvFn = (i: number): number => this.rv[i];
  private bakeAsked = false;
  /** Un-grow from what was visible (a dissolved replay, a withdrawn stroke): reveal ≤ cap. */
  cap: Float32Array | null = null;

  /**
   * `r` is a committed recipe (bakes) or the withdrawn draft (never bakes: no id). `mask` (diff
   * restyles) marks polys that stay fully shown (1) or are never drawn (2); the rest (0) animate,
   * and the generation schedule spans only those.
   */
  constructor(readonly r: Rec, readonly c: Cooked, readonly form: FormId, mode: number,
    public t0: number, public dur: number, readonly mask: Uint8Array | null = null) {
    this.id = r.id ?? null;
    this.mode = mode;
    const n = c.nPolys, p = c.pts;
    this.rv = new Float32Array(n).fill(1);
    if (mask) for (let i = 0; i < n; i++) if (mask[i] === 2) this.rv[i] = 0;
    this.coff = new Float32Array(n); this.ctot = new Float32Array(n); this.len = new Float32Array(n);
    this.sA = new Float32Array(n); this.sB = new Float32Array(n);
    let G = 0, gMin = 255, sMin = Infinity, sMax = -Infinity, w = 0;
    for (let i = 0; i < n; i++) {
      const st = c.start[i], cnt = c.count[i];
      if (cnt === 0) continue;
      const a0 = p[4 * st + 3], aL = p[4 * (st + cnt - 1) + 3];
      this.len[i] = cnt > 1 ? aL - a0 : 0;
      this.sA[i] = c.born[i] + a0; this.sB[i] = c.born[i] + aL;
      for (let j = st; j < st + cnt; j++) if (p[4 * j + 2] > w) w = p[4 * j + 2];
      if (mask && mask[i] !== 0) continue;
      if (c.gen[i] > G) G = c.gen[i];
      if (c.gen[i] < gMin) gMin = c.gen[i];
      if (c.gen[i] === 0) { if (this.sA[i] < sMin) sMin = this.sA[i]; if (this.sB[i] > sMax) sMax = this.sB[i]; }
    }
    if (!(sMax >= sMin)) { sMin = 0; sMax = 0; }
    this.G = G; this.gMin = gMin <= G ? gMin : 0; this.sMin = sMin; this.sMax = sMax; this.maxW = w;
    this.fg = new Float64Array(G + 1);
    // chains (Drift thirds)
    let i = 0;
    while (i < n) {
      let j = i, off = this.len[i];
      this.coff[i] = 0;
      while (j + 1 < n && linked(c, j, j + 1)) { j++; this.coff[j] = off; off += this.len[j]; }
      for (let q = i; q <= j; q++) this.ctot[q] = off;
      i = j + 1;
    }
  }

  refresh(cx: LayerCx): void {
    if (this.camRev !== cx.camRev) {
      this.m.set(cx.host.matrixFor(this.r.origin));
      if (this.xf) multiply(this.m, this.xf, this.m);
      this.sc = Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2]));
      this.camRev = cx.camRev;
    }
    if (this.groundRev !== cx.groundRev) { this.table = cx.host.inkTable(this.r); this.groundRev = cx.groundRev; }
  }

  /** Reveal of every poly at time t into the growth: generation phases, trunk by arc, chains by prefix. */
  private reveal(t: number, reverse: boolean): void {
    const c = this.c, G = this.G, g0 = this.gMin, fg = this.fg;
    // the schedule spans only the generations that animate
    for (let g = g0; g <= G; g++) {
      const u = genPhase(t, this.dur, g - g0, G - g0, reverse);
      fg[g] = reverse ? easeOutCubic(1 - u) : easeOutCubic(u);
    }
    const F = fg[0], sv = this.sMin + (this.sMax - this.sMin) * F;
    const mask = this.mask;
    for (let i = 0; i < c.nPolys; i++) {
      if (mask && mask[i] !== 0) continue;
      const g = c.gen[i];
      if (g === 0) {
        if (c.kind[i] === DOT || c.count[i] < 2) this.rv[i] = F;
        else {
          // a zero-length piece shows once the spine reaches it; a zero-length spine (a tap) by F
          const a = this.sA[i], b = this.sB[i];
          this.rv[i] = b > a ? clamp01((sv - a) / (b - a)) : this.sMax > this.sMin ? (F > 0 && sv >= a ? 1 : 0) : F;
        }
      } else this.rv[i] = chainReveal(fg[g], this.coff[i], this.ctot[i], this.len[i]);
      if (this.cap && this.cap[i] < this.rv[i]) this.rv[i] = this.cap[i];
    }
  }

  private dirty(list: RectList): void {
    const b = TMP_BOX2;
    if (this.devBox(b)) list.add(b.x0, b.y0, b.x1, b.y1);
  }

  step(now: number, cx: LayerCx): boolean {
    this.refresh(cx);
    if (this.dead) return false;
    if (this.mode === WAIT) {
      if (!cx.rm && now < this.t0) return true;
      this.mode = GROW;
      if (this.t0 > now) this.t0 = now;
    }
    if (this.mode === GROW || this.mode === UNGROW) {
      const t = cx.rm ? this.dur : Math.max(0, now - this.t0);
      this.dirty(cx.wet);
      if (t >= this.dur) {
        if (this.mode === UNGROW) { this.dead = true; return false; }
        this.toBake(cx);
        return false;
      }
      this.reveal(t, this.mode === UNGROW);
      return true;
    }
    if (this.mode === BAKE && !this.bakeAsked) this.toBake(cx);
    return false;
  }

  private toBake(cx: LayerCx): void {
    this.mode = BAKE;
    this.dirty(cx.dry);
    if (this.bakeAsked) return;
    this.bakeAsked = true;
    // only committed recipes (they carry an id) bake; a withdrawn draft never reaches here
    if (this.id !== null) cx.bake({ item: this, r: this.r as StrokeRecipe, c: this.c });
  }

  drawDry(ctx: Ctx2D, clip: AABB): void {
    if (this.mode !== BAKE && this.mode !== REST && this.mode !== LIFTED) return;
    drawInk(ctx, this.c, this.table, this.m, this.form, dopts(clip));
  }

  drawWet(ctx: Ctx2D, clip: AABB): void {
    if (this.mode !== GROW && this.mode !== UNGROW) return;
    const o = dopts(clip);
    o.reveal = this.rvFn;
    drawInk(ctx, this.c, this.table, this.m, this.form, o);
  }

  devBox(out: AABB): boolean {
    const ib = this.c.inkBox, ox = this.r.origin[0], oy = this.r.origin[1];
    if (!devOf(this.m, ib.x0 - ox, ib.y0 - oy, ib.x1 - ox, ib.y1 - oy, out)) return false;
    const pad = 4 + 0.1 * this.maxW * this.sc;
    out.x0 -= pad; out.y0 -= pad; out.x1 += pad; out.y1 += pad;
    return true;
  }

  animating(): boolean { return !this.dead && (this.mode === WAIT || this.mode === GROW || this.mode === UNGROW); }

  fastForward(_now: number, cx: LayerCx): void {
    if (this.dead) return;
    if (this.mode === UNGROW) { this.dirty(cx.wet); this.dead = true; return; }
    if (this.mode === WAIT || this.mode === GROW) { this.dirty(cx.wet); this.toBake(cx); }
  }

  kill(cx: LayerCx): void {
    if (this.dead) return;
    this.dirty(cx.wet);
    this.dirty(cx.dry);
    this.dead = true;
  }
}

// ---------------------------------------------------------------------------- diff restyles

const sameLch = (a: ColorStyle['lch'], b: ColorStyle['lch']): boolean => {
  if (!a || !b) return a === b;
  for (const g of ['night', 'paper'] as const) for (let k = 0; k < 3; k++) if (a[g][k] !== b[g][k]) return false;
  return true;
};

/** Float32 arrays equal element for element (NaN equals NaN). */
function sameF32(a: Float32Array, b: Float32Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) { const x = a[k], y = b[k]; if (x !== y && (x === x || y === y)) return false; }
  return true;
}

/**
 * Do two revisions differ only in their depth inputs (pools, base depth)? Then a restyle is a
 * change of growth, not of look: a peel undo drains its pools, a Form-chip depth bend grows or
 * retracts generations, and everything else stays put.
 */
export function depthOnlyChange(a: StrokeRecipe, b: StrokeRecipe): boolean {
  const ca = a.color, cb = b.color;
  return a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.z === b.z && a.rot === b.rot &&
    a.seed === b.seed && a.device === b.device && a.closed === b.closed && a.radial === b.radial &&
    a.s0 === b.s0 && a.cut === b.cut &&
    a.stroke.nib === b.stroke.nib && a.stroke.size === b.stroke.size &&
    a.form.form === b.form.form && a.form.v === b.form.v &&
    ca.ink === cb.ink && ca.k === cb.k && ca.dh === cb.dh && ca.dL === cb.dL && sameLch(ca.lch, cb.lch) &&
    sameF32(a.samples, b.samples);
}

const DIFF_A = new PolyState(), DIFF_B = new PolyState(), DIFF_KEYS = new KeyTable();

/**
 * Masks for a diff restyle of `before` into `after`: polys present in both (same content) stay
 * shown from `after` (aMask 1) and are never drawn from `before` (bMask 2); the rest animate (0).
 * `changed` counts the animating polys of both.
 */
export function diffMasks(before: Cooked, after: Cooked): { bMask: Uint8Array; aMask: Uint8Array; changed: number } {
  const nb = before.nPolys, na = after.nPolys;
  const bMask = new Uint8Array(nb), aMask = new Uint8Array(na);
  DIFF_B.ensure(nb); DIFF_A.ensure(na);
  for (let j = 0; j < nb; j++) DIFF_B.keyOnly(before, j, j);
  for (let i = 0; i < na; i++) DIFF_A.keyOnly(after, i, i);
  DIFF_KEYS.build(DIFF_B.hash, nb);
  let changed = nb + na;
  for (let i = 0; i < na; i++) {
    DIFF_KEYS.find(DIFF_A.hash[i]);
    let j = DIFF_KEYS.next();
    while (j >= 0 && (bMask[j] !== 0 || !DIFF_B.keyEq(j, DIFF_A, i))) j = DIFF_KEYS.next();
    if (j < 0) continue;
    bMask[j] = 2; aMask[i] = 1; changed -= 2;
  }
  return { bMask, aMask, changed };
}
