/**
 * The live layer: where the ink is alive. Spec: docs/DESIGN.md §3.1 (halo), §3.2 (hot trail,
 * living wake, un-grow, concurrency), §6.2 (#dry / #wet, two-phase hand-off), §6.6 (prefix and
 * morph reveal, reduced motion), §9 LOD rules 7–8.
 *
 * Two canvases. #dry holds ink that is final and still: settled live polys that have cooled and
 * finished revealing, committed strokes while they bake, the lifted selection, a resting replay.
 * #wet holds what moves: the provisional tail, the hot window, young growth, the pool window
 * during a hold, the halo, the Echo ghost and every animating stroke. Both are repainted only
 * inside dirty rects built from per-poly boxes (clip, clear, redraw whatever intersects), so an
 * idle frame does no work and a live frame repaints the region around the nib.
 *
 * Everything is drawn through render-core (drawCooked, and tracePoly for the hot trunk's 12 sp
 * chunks), so live ink and baked tiles share batching, LOD and tessellation. The hot multiplier
 * (1 + h·η) reaches exactly 1 at age 3τ, at which point a poly draws with its plain bucketed
 * alpha: bit-for-bit the committed look, and only then does it hand off to #dry.
 *
 * Identity. The cook's live geometry is gen-sorted, so poly indices shift as the stroke grows.
 * The layer keeps its own mirror of it (copying only the suffix that changed) and carries each
 * poly's animation state across views by a content key (kind, gen, unit, tone, alpha, count,
 * end points), so a poly keeps its reveal and hot clocks however the cook reorders, and a
 * superseded poly (regrow) simply stops matching. `slot` ids (ink/cook's InkLiveView) mark
 * settled polys when present; otherwise drainSettled events do.
 *
 * Decisions (also in the render-live report):
 *  - Hot ages use an arc clock: the wall time at which the nib first reached each arc. It equals
 *    t(station) for live drawing and stays right for replays played faster than real time.
 *  - The hot window is the last 120 sp; its oldest 48 sp cool spatially to 0, so a fast stroke
 *    has no step at the cap. Ink older than 3τ is cold anywhere.
 *  - Growth reveals by unit: a unit's clock starts when the unit first appears (provisional or
 *    settled), so a rise that re-truncates a unit never restarts its reveal; the deeper growth it
 *    adds rises with the geometry. A Sprout generation starts when its parent reaches 60 %
 *    (easeOutCubic reaches 0.6 at 26.3 % of T). Drift thirds reveal as one filament.
 *  - Fresh growth polys are hot from the moment they appear, so a rising pool glows while it
 *    rises and cools after.
 *  - Lift zones cross-fade over 120 ms: polys that are new at lift fade in, live polys absent
 *    from the committed geometry fade out. New growth units unfurl normally; Echo's crystal
 *    folds out with the cook's MorphSet (or reveals by prefix without one) while the ghost
 *    dissolves over 150 ms.
 *  - Un-grow / re-grow schedule generations on a grid of dur/(G + 2) with two-slot phases
 *    (consecutive generations overlap by half): deepest first and the spine last when removing;
 *    the spine first when growing. Re-grow (redo, restyle, load) takes 320 ms.
 *  - A restyle that changes only depth inputs (pools, base depth: a peel undo, a Form-chip depth
 *    bend) is a diff: ink present in both revisions stays put, only the old revision's own growth
 *    retracts (200 ms), then the new revision's own growth grows; a side with nothing of its own
 *    skips its phase (a drain-only peel bakes at once). Any change of look (colour, nib, Form)
 *    plays the full un-grow (150 ms) then re-grow.
 *  - The halo belongs to the nib: begin, lift and withdraw end it.
 *  - Wet ink may reach alpha 1 on Paper (above the 0.85 safety cap of committed ink) while it is
 *    hot, so the darker wet trail is visible on full-alpha trunks; it dries to exactly 0.85.
 *  - Replays (play) reveal the trunk along their own sample timing (raw arc normalised onto the
 *    cooked trunk), unfurl growth a hand's breadth behind the nib, raise units under a pool
 *    through their depth over the pool's recorded interval (the fractional-depth contract makes
 *    a prefix reveal equal the rising geometry for Sprout and Drift), and swell a halo there.
 *  - Paper per-generation alpha (ink-forms registry.paperAlphaScale, Echo's Paper exposure) is
 *    applied here through drawInk; tiles draw through it too (render-live contract request §2).
 */
import { rstats } from './stats';
import type {
  AABB, ColorStyle, Cooked, DraftStroke, FormId, Ground, IncrementalCook, InkTable, InputSample, Mat2x3, MorphSet,
  PolyView, RecipeCore, StrokeRecipe, Vec2,
} from '../core/types';
import { PL, PolyKind, S as SR } from '../core/types';
import { clamp01, easeOutCubic } from '../core/num';
import { multiply } from '../core/mat';
import { kernel } from '../ink/depth';
import { nibWidth } from '../ink/nibs';
import { swatchCss, toneIndex } from '../ink/color';
import { echoPaperExposure, paperAlphaScale } from '../ink/operators/registry';
import { ALPHA_LEVELS, Batcher, MODE_FILL, MODE_HAIR, alphaBucket, exactKey } from './batch';
import { drawCooked, type DrawOpts } from './raster';
import { traceCentre, tracePoly, type TraceOpts } from './tessellate';
import type { Halo, LiveCopy, LiveHost, LiveLayerInternal, OverlayInternal } from './types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ============================================================================ constants

/** Hot ink (DESIGN §3.2): Night burns like light painting; Paper reads darker wet and dries lighter. */
export const HOT: Readonly<Record<Ground, { readonly h: number; readonly tau: number }>> = {
  night: { h: 0.45, tau: 220 },
  paper: { h: 0.25, tau: 380 },
};
/** Hot window cap and chunk (sp). */
export const HOT_WINDOW = 120, HOT_CHUNK = 12;
/**
 * The oldest part of a full hot window cools spatially to 0 over this arc (sp): four 12 sp
 * chunks, so a fast stroke's trail fades out at the cap instead of stepping.
 */
export const HOT_EDGE = 48;
/** Living-wake reveal times (ms): Line 160 (morph), Sprout 280 per generation, Drift 240. */
export function revealMs(form: FormId): number {
  return form === 'line' ? 160 : form === 'sprout' ? 280 : 240;
}
/** easeOutCubic reaches 0.6 at this fraction of its time: a Sprout child starts when its parent reaches 60 %. */
export const CHILD_AT = 1 - Math.cbrt(0.4);
/** Spine reach of each Form (sp): growth is born this far behind the nib, plus the 24 sp unsettled tail. */
const REACH: Record<FormId, number> = {
  line: 36, echo: 0, sprout: 24, drift: 12, ripple: 24,
  // the promoted lab Forms: their operators' `reach`
  craze: 60, plume: 22, caustic: 20, burin: 8, plait: 108, orbit: 54,
};
/** Removal, restyle, re-grow, lift cross-fade, Echo ghost dissolve and brim flash durations (ms). */
export const UNGROW_MS = 200, RESTYLE_UNGROW_MS = 150, GROW_MS = 320, LIFT_MS = 120, GHOST_MS = 150, BRIM_MS = 160;
/** At most this many strokes animate at once; older ones fast-forward. */
export const MAX_ANIMATING = 4;
/** On hold start, settled ink this far behind the nib (sp) moves to #wet so the pool window regrows there. */
const PIN_ARC = 96;
/** The pinned window stays wet this long (ms) after the halo goes. */
const PIN_LINGER = 300;
/**
 * Cooled ink moves to #dry in batches at most this often (ms), or at once when nothing else on
 * the stroke is still animating: #dry repaints at ≤ 10 Hz however steadily a stroke cools.
 */
const PROMOTE_MS = 100;
/** A wet poly whose hot multiplier changed by less than this is not repainted this frame. */
const HOT_EPS = 1 / 512;
/** Play: pre-halo ramp before a pool starts and halo fade after it ends (ms, stroke clock). */
const PLAY_PRE = 200, PLAY_OUT = 150;

const DOT = PolyKind.Dot;
const HIDDEN = 0, WET = 1, DRY = 2;
const E3 = Math.exp(-3), INV_1ME3 = 1 / (1 - E3);
const EMPTY_F32 = new Float32Array(0);

// ============================================================================ pure helpers

/**
 * η(age) = max(0, (e^(−age/τ) − e^(−3)) / (1 − e^(−3))): 1 when fresh, reaching exactly 0 at
 * age 3τ (DESIGN §3.2). Negative ages count as fresh; NaN counts as cold.
 */
export function hotEta(age: number, tau: number): number {
  if (age !== age) return 0;
  if (!(age > 0)) return 1;
  if (age >= 3 * tau) return 0;
  const v = (Math.exp(-age / tau) - E3) * INV_1ME3;
  return v > 0 ? v : 0;
}

/** Hot alpha multiplier 1 + h·η(age) on ground g (exactly 1 from age 3τ). */
export function hotMultiplier(age: number, g: Ground): number {
  const p = HOT[g];
  return 1 + p.h * hotEta(age, p.tau);
}

/** Spatial cool-down at the far end of a full hot window: 0 beyond 120 sp behind the tip, 1 within 72 sp. */
export function windowEdge(s: number, tip: number): number {
  const lo = tip - HOT_WINDOW;
  if (s <= lo) return 0;
  const t = (s - lo) / HOT_EDGE;
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** easeOutCubic of a time fraction (NaN → 0). */
function ease01(t: number): number {
  return t === t ? easeOutCubic(t) : 0;
}

/** Reveal of one poly of a prefix chain (Drift thirds): f of the chain's arc, mapped onto this poly. */
export function chainReveal(f: number, off: number, tot: number, len: number): number {
  if (len > 0 && tot > len) return clamp01((f * tot - off) / len);
  return f;
}

/** Sprout cascade: a generation-g poly starts this long after its unit (other Forms: 0). */
export function genOffset(form: FormId, gen: number, T: number): number {
  return form === 'sprout' && gen > 1 ? (gen - 1) * CHILD_AT * T : 0;
}

/** Echo fold-out time T = clamp(350 + 120·d_E, 350, 1100) ms. */
export function echoFoldMs(dE: number): number {
  return Math.min(1100, Math.max(350, 350 + 120 * (dE > 0 ? dE : 0)));
}

/**
 * Progress 0..1 of generation g (of 0..G) at time t of a whole-stroke growth lasting `dur`: one
 * phase per generation, two slots long on a grid of dur/(G + 2), so consecutive generations
 * overlap by half. `reverse` (un-grow) runs the deepest generation first and the spine last.
 */
export function genPhase(t: number, dur: number, g: number, G: number, reverse: boolean): number {
  if (!(dur > 0)) return 1;
  const slot = dur / (G + 2);
  const k = reverse ? G - g : g;
  return clamp01((t - k * slot) / (2 * slot));
}

/** Drift's drawn-length law N(d) = 18·min(d, 1) + 26.4·max(0, d − 1) (DESIGN §2.3.6). */
function driftN(d: number): number {
  return 18 * Math.min(Math.max(d, 0), 1) + 26.4 * Math.max(0, d - 1);
}

/** Device rect of a doc-rel-origin box under m, padded, into a rect list. */
function addBox(list: RectList, m: Mat2x3, x0: number, y0: number, x1: number, y1: number, pad: number): void {
  if (!(x1 >= x0 && y1 >= y0)) return;
  let X0: number, X1: number, Y0: number, Y1: number;
  if (m[1] === 0 && m[2] === 0) {
    X0 = m[0] * x0 + m[4]; X1 = m[0] * x1 + m[4];
    Y0 = m[3] * y0 + m[5]; Y1 = m[3] * y1 + m[5];
    if (X0 > X1) { const t = X0; X0 = X1; X1 = t; }
    if (Y0 > Y1) { const t = Y0; Y0 = Y1; Y1 = t; }
  } else {
    const xa = m[0] * x0, xb = m[0] * x1, xc = m[2] * y0, xd = m[2] * y1;
    const ya = m[1] * x0, yb = m[1] * x1, yc = m[3] * y0, yd = m[3] * y1;
    X0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4]; X1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
    Y0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5]; Y1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  }
  list.add(X0 - pad, Y0 - pad, X1 + pad, Y1 + pad);
}

/** Device bbox of a doc-rel-origin box under m into out (no pad). */
function devOf(m: Mat2x3, x0: number, y0: number, x1: number, y1: number, out: AABB): boolean {
  if (!(x1 >= x0 && y1 >= y0)) return false;
  const xa = m[0] * x0, xb = m[0] * x1, xc = m[2] * y0, xd = m[2] * y1;
  const ya = m[1] * x0, yb = m[1] * x1, yc = m[3] * y0, yd = m[3] * y1;
  out.x0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4]; out.x1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
  out.y0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5]; out.y1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  return out.x1 >= out.x0 && out.y1 >= out.y0;
}

const overlaps = (a: AABB, b: AABB): boolean => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

// ============================================================================ dirty rects

/**
 * Up to `cap` integer device-px rects. A rect that touches (within `gap`) another merges with it;
 * past the cap the pair whose union grows least merges. A repaint clips to their union.
 */
export class RectList {
  n = 0;
  full = false;
  readonly r: Float64Array;
  constructor(readonly cap = 8, readonly gap = 8) { this.r = new Float64Array(4 * (cap + 1)); }

  clear(): void { this.n = 0; this.full = false; }
  get empty(): boolean { return !this.full && this.n === 0; }
  /** Repaint everything. */
  setFull(): void { this.full = true; this.n = 0; }

  add(x0: number, y0: number, x1: number, y1: number): void {
    if (this.full) return;
    if (!(x1 > x0 && y1 > y0)) return;
    if (x0 < -1e7) x0 = -1e7; if (y0 < -1e7) y0 = -1e7; if (x1 > 1e7) x1 = 1e7; if (y1 > 1e7) y1 = 1e7;
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
    const r = this.r, g = this.gap;
    for (let k = 0; k < this.n;) {
      const o = 4 * k;
      if (r[o] <= x1 + g && r[o + 2] >= x0 - g && r[o + 1] <= y1 + g && r[o + 3] >= y0 - g) {
        if (r[o] < x0) x0 = r[o]; if (r[o + 1] < y0) y0 = r[o + 1];
        if (r[o + 2] > x1) x1 = r[o + 2]; if (r[o + 3] > y1) y1 = r[o + 3];
        this.removeAt(k);
        k = 0;
      } else k++;
    }
    const o = 4 * this.n++;
    r[o] = x0; r[o + 1] = y0; r[o + 2] = x1; r[o + 3] = y1;
    if (this.n > this.cap) this.mergeCheapest();
  }

  private removeAt(k: number): void {
    const r = this.r, last = 4 * (this.n - 1), o = 4 * k;
    r[o] = r[last]; r[o + 1] = r[last + 1]; r[o + 2] = r[last + 2]; r[o + 3] = r[last + 3];
    this.n--;
  }

  private mergeCheapest(): void {
    const r = this.r;
    let ba = 0, bb = 1, best = Infinity;
    for (let a = 0; a < this.n; a++) {
      for (let b = a + 1; b < this.n; b++) {
        const oa = 4 * a, ob = 4 * b;
        const ux = Math.max(r[oa + 2], r[ob + 2]) - Math.min(r[oa], r[ob]);
        const uy = Math.max(r[oa + 3], r[ob + 3]) - Math.min(r[oa + 1], r[ob + 1]);
        const cost = ux * uy - (r[oa + 2] - r[oa]) * (r[oa + 3] - r[oa + 1]) - (r[ob + 2] - r[ob]) * (r[ob + 3] - r[ob + 1]);
        if (cost < best) { best = cost; ba = a; bb = b; }
      }
    }
    const oa = 4 * ba, ob = 4 * bb;
    const x0 = Math.min(r[oa], r[ob]), y0 = Math.min(r[oa + 1], r[ob + 1]);
    const x1 = Math.max(r[oa + 2], r[ob + 2]), y1 = Math.max(r[oa + 3], r[ob + 3]);
    this.removeAt(bb);
    this.removeAt(ba);
    this.add(x0, y0, x1, y1);
  }

  /** Clip every rect to [0, W] × [0, H]; drops empty ones. */
  clampTo(W: number, H: number): void {
    const r = this.r;
    for (let k = 0; k < this.n;) {
      const o = 4 * k;
      if (r[o] < 0) r[o] = 0; if (r[o + 1] < 0) r[o + 1] = 0;
      if (r[o + 2] > W) r[o + 2] = W; if (r[o + 3] > H) r[o + 3] = H;
      if (!(r[o + 2] > r[o] && r[o + 3] > r[o + 1])) this.removeAt(k); else k++;
    }
  }

  /** Union of the rects into out; false when empty. */
  bbox(out: AABB): boolean {
    if (this.n === 0) return false;
    const r = this.r;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < this.n; k++) {
      const o = 4 * k;
      if (r[o] < x0) x0 = r[o]; if (r[o + 1] < y0) y0 = r[o + 1];
      if (r[o + 2] > x1) x1 = r[o + 2]; if (r[o + 3] > y1) y1 = r[o + 3];
    }
    out.x0 = x0; out.y0 = y0; out.x1 = x1; out.y1 = y1;
    return true;
  }
}

// ============================================================================ arc clock

/**
 * When the nib (or a replay) reached each arc: monotone (arc, wall-time) marks. Hot ages of the
 * trunk read it, so the trail cools from where the nib actually was, at any replay speed.
 */
export class ArcClock {
  private s = new Float64Array(64);
  private w = new Float64Array(64);
  n = 0;
  /** Arcs ≤ this are treated as reached long ago (fast-forward). */
  agedTo = -Infinity;

  reset(): void { this.n = 0; this.agedTo = -Infinity; }

  /**
   * Record that arc s was reached at time t. Arcs never decrease; a pause (same arc, later time)
   * is kept. Marks closer than 0.25 sp and 40 ms to the last one are dropped unless `force`
   * (a stroke's final arc must always land, or a replay would stop a hair short of its end).
   */
  mark(s: number, t: number, force = false): void {
    if (s !== s || t !== t) return;
    const n = this.n;
    if (n > 0) {
      const ls = this.s[n - 1], lt = this.w[n - 1];
      if (s < ls) s = ls;
      if (!(t > lt)) { if (force && s > ls) this.s[n - 1] = s; return; }
      if (!force && s - ls < 0.25 && t - lt < 40) return;
    }
    if (n >= this.s.length) {
      const a = new Float64Array(2 * n), b = new Float64Array(2 * n);
      a.set(this.s); b.set(this.w); this.s = a; this.w = b;
    }
    this.s[n] = s; this.w[n] = t; this.n = n + 1;
  }

  /** Last arc reached (−∞ before any mark). */
  get last(): number { return this.n > 0 ? this.s[this.n - 1] : -Infinity; }
  /** Wall time of the last mark. */
  get lastTime(): number { return this.n > 0 ? this.w[this.n - 1] : -Infinity; }

  /** Wall time at which arc s was first reached; `beyond` for arcs past the last mark. */
  at(s: number, beyond: number): number {
    if (s <= this.agedTo) return -Infinity;
    const n = this.n;
    if (n === 0) return beyond;
    const S = this.s;
    if (s > S[n - 1]) return beyond;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m] < s) lo = m + 1; else hi = m; }
    if (lo === 0) return this.w[0];
    const s0 = S[lo - 1], s1 = S[lo];
    return s1 > s0 ? this.w[lo - 1] + (this.w[lo] - this.w[lo - 1]) * (s - s0) / (s1 - s0) : this.w[lo];
  }

  /** Arc reached by time t (−∞ before the first mark). */
  arcAt(t: number): number {
    const n = this.n;
    if (n === 0) return -Infinity;
    const W = this.w;
    if (t < W[0]) return -Infinity;
    if (t >= W[n - 1]) return this.s[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (W[m] <= t) lo = m; else hi = m; }
    const s0 = this.s[lo], s1 = this.s[hi];
    return s0 + (s1 - s0) * (t - W[lo]) / (W[hi] - W[lo]);
  }
}

// ============================================================================ growable buffers

function g8(a: Uint8Array, n: number): Uint8Array<ArrayBuffer> { const b = new Uint8Array(n); b.set(a); return b; }
function gu32(a: Uint32Array, n: number): Uint32Array<ArrayBuffer> { const b = new Uint32Array(n); b.set(a); return b; }
function gi32(a: Int32Array, n: number): Int32Array<ArrayBuffer> { const b = new Int32Array(n); b.set(a); return b; }
function gf32(a: Float32Array, n: number): Float32Array<ArrayBuffer> { const b = new Float32Array(n); b.set(a); return b; }
function gf64(a: Float64Array, n: number): Float64Array<ArrayBuffer> { const b = new Float64Array(n); b.set(a); return b; }

/** A growable index list with a cached subarray view (DrawOpts.polys). */
class IntList {
  a = new Int32Array(64);
  n = 0;
  private v: Int32Array = this.a.subarray(0, 0);
  push(x: number): void {
    if (this.n >= this.a.length) this.a = gi32(this.a, 2 * this.a.length);
    this.a[this.n++] = x;
  }
  clear(): void { this.n = 0; }
  view(): Int32Array {
    if (this.v.length !== this.n || this.v.buffer !== this.a.buffer) this.v = this.a.subarray(0, this.n);
    return this.v;
  }
}

/**
 * A Cooked the live layer owns: the mirror of the cook's live geometry, a ghost copy. Polys
 * appended with push() are copied (points, chisel angles, attributes, box). `genStart` only
 * carries the generation count (drawCooked reads its length); the order is the source's.
 */
export class PolyStore implements Cooked {
  pts = new Float32Array(1024);
  ang: Float32Array | null = null;
  start = new Uint32Array(64);
  count = new Uint32Array(64);
  kind = new Uint8Array(64);
  gen = new Uint8Array(64);
  tone = new Uint8Array(64);
  alpha = new Float32Array(64);
  born = new Float32Array(64);
  unit = new Uint32Array(64);
  box = new Float32Array(256);
  genStart = new Uint32Array(2);
  nPolys = 0;
  nPts = 0;
  inkBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };
  hitBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };
  ceilingMax = 0;
  coverage = 0;
  bytes = 0;

  /** Keep polys [0, k). */
  truncate(k: number): void {
    this.nPolys = k;
    this.nPts = k > 0 ? this.start[k - 1] + this.count[k - 1] : 0;
  }

  /** Append poly i of g; returns its index here. */
  push(g: Cooked, i: number): number {
    const k = this.nPolys, n = g.count[i], st = g.start[i], o = this.nPts;
    if (k + 1 > this.start.length) {
      const c = 2 * this.start.length;
      this.start = gu32(this.start, c); this.count = gu32(this.count, c); this.kind = g8(this.kind, c);
      this.gen = g8(this.gen, c); this.tone = g8(this.tone, c); this.alpha = gf32(this.alpha, c);
      this.born = gf32(this.born, c); this.unit = gu32(this.unit, c); this.box = gf32(this.box, 4 * c);
    }
    if (4 * (o + n) > this.pts.length) {
      let c = this.pts.length;
      while (c < 4 * (o + n)) c *= 2;
      this.pts = gf32(this.pts, c);
      if (this.ang) this.ang = gf32(this.ang, c >> 2);
    }
    // plain loops, not set(subarray): the mirror re-copies its unsettled suffix every live frame,
    // and a view object per poly per frame is garbage in the hot path
    const src = g.pts, dst = this.pts;
    for (let k = 4 * st, q = 4 * o, end = 4 * (st + n); k < end; k++, q++) dst[q] = src[k];
    if (g.ang && g.kind[i] === PolyKind.Chisel) {
      if (!this.ang) this.ang = new Float32Array(this.pts.length >> 2);
      const sa = g.ang, da = this.ang;
      for (let k = st, q = o, end = st + n; k < end; k++, q++) da[q] = sa[k];
    }
    this.start[k] = o; this.count[k] = n; this.kind[k] = g.kind[i]; this.gen[k] = g.gen[i];
    this.tone[k] = g.tone[i]; this.alpha[k] = g.alpha[i]; this.born[k] = g.born[i]; this.unit[k] = g.unit[i];
    this.box[4 * k] = g.box[4 * i]; this.box[4 * k + 1] = g.box[4 * i + 1];
    this.box[4 * k + 2] = g.box[4 * i + 2]; this.box[4 * k + 3] = g.box[4 * i + 3];
    this.nPolys = k + 1; this.nPts = o + n;
    if (g.gen[i] + 2 > this.genStart.length) this.genStart = new Uint32Array(g.gen[i] + 2);
    return k;
  }

  /** Recompute inkBox (absolute doc) from the poly boxes. */
  bounds(origin: Vec2): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const b = this.box;
    for (let i = 0; i < this.nPolys; i++) {
      if (b[4 * i] < x0) x0 = b[4 * i]; if (b[4 * i + 1] < y0) y0 = b[4 * i + 1];
      if (b[4 * i + 2] > x1) x1 = b[4 * i + 2]; if (b[4 * i + 3] > y1) y1 = b[4 * i + 3];
    }
    const ib = this.inkBox;
    if (x1 >= x0) { ib.x0 = origin[0] + x0; ib.y0 = origin[1] + y0; ib.x1 = origin[0] + x1; ib.y1 = origin[1] + y1; }
    else { ib.x0 = 0; ib.y0 = 0; ib.x1 = -1; ib.y1 = -1; }
    this.hitBox = this.inkBox;
  }
}

// ============================================================================ per-poly state

const KB = new Float32Array(1), KU = new Uint32Array(KB.buffer);
const bits = (x: number): number => { KB[0] = x; return KU[0]; };
const mix = (h: number, v: number): number => Math.imul(h ^ v, 0x01000193) >>> 0;

/**
 * Animation state per poly of a source Cooked, plus the content key that carries it across
 * views (hash, kind|gen|tone, unit, count, alpha, the two end points).
 */
class PolyState {
  cap = 0;
  n = 0;
  st = new Uint8Array(0); settled = new Uint8Array(0); fd = new Uint8Array(0);
  t1 = new Float64Array(0); rs = new Float64Array(0); mt0 = new Float64Array(0); ft0 = new Float64Array(0);
  rd = new Float32Array(0); md = new Float32Array(0); coff = new Float32Array(0); ctot = new Float32Array(0);
  len = new Float32Array(0); wmax = new Float32Array(0); rv = new Float32Array(0); hv = new Float32Array(0);
  mv = new Float32Array(0); alpha = new Float32Array(0);
  hash = new Uint32Array(0); meta = new Uint32Array(0); unit = new Uint32Array(0); cnt = new Uint32Array(0);
  id = new Int32Array(0);
  ends = new Float32Array(0); box = new Float32Array(0); mbox = new Float32Array(0);

  ensure(n: number): void {
    if (n <= this.cap) return;
    let c = this.cap > 0 ? 2 * this.cap : 64;
    while (c < n) c *= 2;
    this.st = g8(this.st, c); this.settled = g8(this.settled, c); this.fd = g8(this.fd, c);
    this.t1 = gf64(this.t1, c); this.rs = gf64(this.rs, c); this.mt0 = gf64(this.mt0, c); this.ft0 = gf64(this.ft0, c);
    this.rd = gf32(this.rd, c); this.md = gf32(this.md, c); this.coff = gf32(this.coff, c); this.ctot = gf32(this.ctot, c);
    this.len = gf32(this.len, c); this.wmax = gf32(this.wmax, c); this.rv = gf32(this.rv, c); this.hv = gf32(this.hv, c);
    this.mv = gf32(this.mv, c); this.alpha = gf32(this.alpha, c);
    this.hash = gu32(this.hash, c); this.meta = gu32(this.meta, c); this.unit = gu32(this.unit, c); this.cnt = gu32(this.cnt, c);
    this.id = gi32(this.id, c);
    this.ends = gf32(this.ends, 6 * c); this.box = gf32(this.box, 4 * c); this.mbox = gf32(this.mbox, 4 * c);
    this.cap = c;
  }

  /** Key, box, max width and arc length of poly i of c into entry e. */
  keyFrom(c: Cooked, i: number, e: number): void {
    this.keyOnly(c, i, e);
    this.measure(c, i, e);
  }

  /** Content key and box of poly i of c into entry e (O(1): the two end points only). */
  keyOnly(c: Cooked, i: number, e: number): void {
    const st = c.start[i], n = c.count[i], p = c.pts;
    const a = 4 * st, b = 4 * (st + (n > 0 ? n - 1 : 0));
    const meta = c.kind[i] | (c.gen[i] << 8) | (c.tone[i] << 16);
    this.setKey(e, meta, c.unit[i] >>> 0, n, c.alpha[i], p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]);
    this.box[4 * e] = c.box[4 * i]; this.box[4 * e + 1] = c.box[4 * i + 1];
    this.box[4 * e + 2] = c.box[4 * i + 2]; this.box[4 * e + 3] = c.box[4 * i + 3];
  }

  /** Max width and arc length of poly i of c into entry e (scans its points). */
  measure(c: Cooked, i: number, e: number): void {
    const st = c.start[i], n = c.count[i], p = c.pts;
    let w = 0;
    for (let j = st; j < st + n; j++) if (p[4 * j + 2] > w) w = p[4 * j + 2];
    this.wmax[e] = w;
    this.len[e] = n > 1 ? p[4 * (st + n - 1) + 3] - p[4 * st + 3] : 0;
  }

  /** Key of a drained PolyView into entry e. */
  keyFromView(v: PolyView, e: number): void {
    const p = v.pts, n = p.length >> 2;
    const meta = v.kind | (v.gen << 8) | (v.tone << 16);
    if (n === 0) { this.setKey(e, meta, v.unit >>> 0, 0, v.alpha, 0, 0, 0, 0, 0, 0); return; }
    const b = 4 * (n - 1);
    this.setKey(e, meta, v.unit >>> 0, n, v.alpha, p[0], p[1], p[2], p[b], p[b + 1], p[b + 2]);
  }

  private setKey(e: number, meta: number, unit: number, n: number, alpha: number,
    x0: number, y0: number, w0: number, x1: number, y1: number, w1: number): void {
    KB[0] = alpha;
    const ab = KU[0];
    this.meta[e] = meta; this.unit[e] = unit; this.cnt[e] = n;
    this.alpha[e] = alpha;
    const E = this.ends, o = 6 * e;
    E[o] = x0; E[o + 1] = y0; E[o + 2] = w0; E[o + 3] = x1; E[o + 4] = y1; E[o + 5] = w1;
    let h = 0x811c9dc5;
    h = mix(h, meta); h = mix(h, unit); h = mix(h, n); h = mix(h, ab);
    h = mix(h, bits(E[o])); h = mix(h, bits(E[o + 1])); h = mix(h, bits(E[o + 2]));
    h = mix(h, bits(E[o + 3])); h = mix(h, bits(E[o + 4])); h = mix(h, bits(E[o + 5]));
    this.hash[e] = h;
  }

  /** Content keys of entry j here and entry i of B are equal. */
  keyEq(j: number, B: PolyState, i: number): boolean {
    if (this.hash[j] !== B.hash[i] || this.meta[j] !== B.meta[i] || this.unit[j] !== B.unit[i] ||
      this.cnt[j] !== B.cnt[i] || this.alpha[j] !== B.alpha[i]) return false;
    const a = this.ends, b = B.ends, oa = 6 * j, ob = 6 * i;
    return a[oa] === b[ob] && a[oa + 1] === b[ob + 1] && a[oa + 2] === b[ob + 2] &&
      a[oa + 3] === b[ob + 3] && a[oa + 4] === b[ob + 4] && a[oa + 5] === b[ob + 5];
  }

  /** Animation state of entry j of src into entry i (keys stay). */
  carry(src: PolyState, j: number, i: number): void {
    this.st[i] = src.st[j]; this.settled[i] = src.settled[j]; this.fd[i] = src.fd[j];
    this.t1[i] = src.t1[j]; this.rs[i] = src.rs[j]; this.mt0[i] = src.mt0[j]; this.ft0[i] = src.ft0[j];
    this.rd[i] = src.rd[j]; this.md[i] = src.md[j]; this.rv[i] = src.rv[j]; this.hv[i] = src.hv[j]; this.mv[i] = src.mv[j];
    const o = 4 * j, q = 4 * i;
    this.mbox[q] = src.mbox[o]; this.mbox[q + 1] = src.mbox[o + 1]; this.mbox[q + 2] = src.mbox[o + 2]; this.mbox[q + 3] = src.mbox[o + 3];
  }

  /** Everything of entry j of src into entry i (snapshots). */
  copyAll(src: PolyState, j: number, i: number): void {
    this.carry(src, j, i);
    this.hash[i] = src.hash[j]; this.meta[i] = src.meta[j]; this.unit[i] = src.unit[j]; this.cnt[i] = src.cnt[j];
    this.alpha[i] = src.alpha[j]; this.id[i] = src.id[j]; this.coff[i] = src.coff[j]; this.ctot[i] = src.ctot[j];
    this.len[i] = src.len[j]; this.wmax[i] = src.wmax[j];
    for (let k = 0; k < 6; k++) this.ends[6 * i + k] = src.ends[6 * j + k];
    for (let k = 0; k < 4; k++) this.box[4 * i + k] = src.box[4 * j + k];
  }

  /** Default state of a new entry. */
  init(i: number, st: number, now: number): void {
    this.st[i] = st; this.settled[i] = 0; this.fd[i] = 0;
    this.t1[i] = now; this.rs[i] = -Infinity; this.mt0[i] = NaN; this.ft0[i] = -Infinity;
    this.rd[i] = 0; this.md[i] = 0; this.rv[i] = 1; this.hv[i] = 1; this.mv[i] = 1;
  }
}

/** Open-addressing table of entry indices by content hash. */
class KeyTable {
  private t = new Int32Array(128);
  private mask = 127;
  private hs: Uint32Array = new Uint32Array(0);
  private pos = 0;
  private h = 0;

  build(hashes: Uint32Array, n: number): void {
    let cap = 128;
    while (cap < 2 * n) cap *= 2;
    if (this.t.length < cap) this.t = new Int32Array(cap);
    this.mask = cap - 1;
    this.t.fill(-1, 0, cap);
    this.hs = hashes;
    for (let j = 0; j < n; j++) {
      let p = hashes[j] & this.mask;
      while (this.t[p] !== -1) p = (p + 1) & this.mask;
      this.t[p] = j;
    }
  }

  /** Start iterating the entries with hash h. */
  find(h: number): void { this.h = h >>> 0; this.pos = this.h & this.mask; }

  /** Next entry with the started hash, or −1. */
  next(): number {
    for (;;) {
      const j = this.t[this.pos];
      if (j === -1) return -1;
      this.pos = (this.pos + 1) & this.mask;
      if (this.hs[j] === this.h) return j;
    }
  }
}

/** Polys a and b chain (consecutive gen ≥ 1 pieces of one filament sharing an end point). */
function linked(c: Cooked, a: number, b: number): boolean {
  if (c.gen[a] === 0 || c.gen[a] !== c.gen[b] || c.unit[a] !== c.unit[b] || c.kind[a] !== c.kind[b]) return false;
  if (c.count[a] < 2 || c.count[b] < 2) return false;
  const p = c.pts, ia = 4 * (c.start[a] + c.count[a] - 1), ib = 4 * c.start[b];
  return p[ia] === p[ib] && p[ia + 1] === p[ib + 1];
}

/** Chain offsets/totals for polys from the head of the chain containing k to the end. */
function computeChains(c: Cooked, S: PolyState, k: number): void {
  const n = c.nPolys;
  let i = Math.max(0, Math.min(k, n));
  while (i > 0 && i < n && linked(c, i - 1, i)) i--;
  while (i < n) {
    let j = i, off = S.len[i];
    S.coff[i] = 0;
    while (j + 1 < n && linked(c, j, j + 1)) { j++; S.coff[j] = off; off += S.len[j]; }
    for (let q = i; q <= j; q++) S.ctot[q] = off;
    i = j + 1;
  }
}

/** Device-px rect of entry i (box, plus the morph box while morphing), padded for joins and AA. */
function dirtyEntry(list: RectList, S: PolyState, i: number, m: Mat2x3, sc: number): void {
  const b = S.box, o = 4 * i;
  const pad = 2 + 0.1 * S.wmax[i] * sc;
  addBox(list, m, b[o], b[o + 1], b[o + 2], b[o + 3], pad);
  if (S.mt0[i] === S.mt0[i]) {
    const mb = S.mbox;
    addBox(list, m, mb[o], mb[o + 1], mb[o + 2], mb[o + 3], pad);
  }
}

/** Morph box of entry i: its box united with the bbox of its `from` points (± half its max width). */
function setMorphBox(S: PolyState, i: number, c: Cooked, from: Float32Array): void {
  const st = c.start[i], n = c.count[i], o = 4 * i, h = 0.5 * S.wmax[i];
  let x0 = S.box[o], y0 = S.box[o + 1], x1 = S.box[o + 2], y1 = S.box[o + 3];
  for (let j = st; j < st + n; j++) {
    const x = from[2 * j], y = from[2 * j + 1];
    if (x - h < x0) x0 = x - h; if (x + h > x1) x1 = x + h;
    if (y - h < y0) y0 = y - h; if (y + h > y1) y1 = y + h;
  }
  S.mbox[o] = x0; S.mbox[o + 1] = y0; S.mbox[o + 2] = x1; S.mbox[o + 3] = y1;
}

// ============================================================================ drawing

const DOPTS: DrawOpts = {};
const GEN_LIST = new IntList();

/**
 * drawCooked with Paper's per-generation alpha: the Cooked alpha bakes Night's hierarchy
 * (0.72^(g−1), Drift 0.38); Paper wants 0.78^(g−1) and 0.30 (ink-forms registry.paperAlphaScale)
 * and Echo's Paper exposure. On Night, or a stroke with only gen 0, this is exactly one
 * drawCooked call; on Paper each generation is one call with its alphaScale. Tiles must draw the
 * same way for live and baked ink to agree (render-live contract request §2).
 */
export function drawInk(ctx: Ctx2D, c: Cooked, table: InkTable, m: Mat2x3, form: FormId, o: DrawOpts): void {
  const G = c.genStart.length - 2;
  if (table.op !== 'multiply' || G <= 0) { drawCooked(ctx, c, table, m, o); return; }
  const base = o.alphaScale !== undefined ? o.alphaScale : 1;
  const subset = o.polys ?? null;
  const total = subset ? subset.length : c.nPolys;
  const echoK = form === 'echo' ? echoPaperExposure(c.coverage) : 1;
  const saved = o.polys;
  for (let g = 0; g <= G; g++) {
    GEN_LIST.clear();
    for (let q = 0; q < total; q++) {
      const i = subset ? subset[q] : q;
      if (c.gen[i] === g) GEN_LIST.push(i);
    }
    if (GEN_LIST.n === 0) continue;
    o.polys = GEN_LIST.view();
    o.alphaScale = base * (g > 0 ? paperAlphaScale(form, g) * echoK : 1);
    drawCooked(ctx, c, table, m, o);
  }
  o.polys = saved;
  o.alphaScale = base === 1 ? undefined : base;
}

/** Reset the shared DrawOpts and point it at a clip rect. */
function dopts(clip: AABB | null): DrawOpts {
  const o = DOPTS;
  o.alphaScale = undefined; o.polys = null; o.reveal = null; o.morph = null; o.hot = null; o.lod = true;
  o.clipDev = clip;
  return o;
}

// width stats exactly as raster.ts computes them (hairline decisions must agree)
let wsMax = 0, wsMean = 0;
function widthStats(c: Cooked, i: number): void {
  const p = c.pts, st = c.start[i], n = c.count[i];
  let px = p[4 * st], py = p[4 * st + 1], pw = p[4 * st + 2];
  let mx = pw, sw = 0, sl = 0;
  for (let j = 1; j < n; j++) {
    const b = 4 * (st + j);
    const x = p[b], y = p[b + 1], w = p[b + 2];
    if (w > mx) mx = w;
    const dx = x - px, dy = y - py, L = Math.sqrt(dx * dx + dy * dy);
    sw += (w + pw) * 0.5 * L; sl += L;
    px = x; py = y; pw = w;
  }
  wsMax = mx;
  wsMean = sl > 0 ? sw / sl : mx;
}

function boxHitsDev(box: Float32Array, i: number, m: Mat2x3, clip: AABB): boolean {
  const x0 = box[4 * i], y0 = box[4 * i + 1], x1 = box[4 * i + 2], y1 = box[4 * i + 3];
  const xa = m[0] * x0, xb = m[0] * x1, xc = m[2] * y0, xd = m[2] * y1;
  const ya = m[1] * x0, yb = m[1] * x1, yc = m[3] * y0, yd = m[3] * y1;
  const X0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4], X1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
  const Y0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5], Y1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  return X1 >= clip.x0 - 1 && X0 <= clip.x1 + 1 && Y1 >= clip.y0 - 1 && Y0 <= clip.y1 + 1;
}

const hotBatcher = new Batcher();
const HOPTS: TraceOpts = { minDevWidth: 0 };
let rgCap = 64, rgN = 0;
let rgPoly = new Int32Array(rgCap), rgFrom = new Float64Array(rgCap), rgTo = new Float64Array(rgCap), rgRev = new Float64Array(rgCap);

/** One arc range of poly i: cut ends at `from` / `to` (poly arc, NaN = the poly's own end), or a round tip at prefix `rev`. */
function pushRange(i: number, from: number, to: number, rev: number): number {
  if (rgN >= rgCap) {
    rgCap *= 2;
    rgPoly = gi32(rgPoly, rgCap); rgFrom = gf64(rgFrom, rgCap); rgTo = gf64(rgTo, rgCap); rgRev = gf64(rgRev, rgCap);
  }
  rgPoly[rgN] = i; rgFrom[rgN] = from; rgTo[rgN] = to; rgRev[rgN] = rev;
  return rgN++;
}

/** Below this fill alpha nothing is drawn (as raster.ts). */
const MIN_ALPHA = 1 / 192;

/**
 * Batch entry of one range at alpha base·mul, keys relative to aMul exactly as drawCooked makes
 * them (a multiplier of exactly 1 uses the plain bucket key, so a cold chunk is the committed
 * draw). Decision: wet ink may reach alpha 1 on Paper (above its 0.85 safety cap for committed
 * ink) while it is hot; the trail still dries to exactly 0.85 × the bucket.
 */
function addRange(r: number, css: number, kb: number, base: number, mul: number, mode: number, lighter: boolean, aMul: number): void {
  if (mul === 1) { hotBatcher.add(r, css, kb, mode); return; }
  const ah = base * mul;
  if (lighter && ah * aMul > 1) {
    hotBatcher.add(r, css, aMul === 1 ? 7 : exactKey(1 / aMul), mode);
    hotBatcher.add(r, css, exactKey(Math.min(1, ah * aMul - 1) / aMul), mode);
  } else if (ah * aMul >= MIN_ALPHA) hotBatcher.add(r, css, exactKey(Math.min(ah, 1 / aMul)), mode);
}

/** Hot-window state for one hot draw. */
interface HotView {
  clock: ArcClock; now: number; tip: number; H: number; tau: number; beyond: number;
  /** The trunk is drawn up to this arc (a replay's nib; +∞ live), ending in a round tip. */
  sVis: number;
}

/**
 * The trunk's hot window (DESIGN §3.2): each gen-0 poly in `list` is cut at absolute multiples
 * of 12 sp; every chunk draws at its bucketed alpha × (1 + h·η(age at the chunk's middle)) ×
 * the poly's fade, and chunks with equal multipliers merge. Adjacent chunks share their cut edge
 * exactly (tracePoly arcFrom/arcTo; cuts snap identically on both sides); a poly's own ends keep
 * their caps and chunk welds. Hairline, cull and alpha-bucket decisions are per poly, exactly as
 * drawCooked makes them (bucket the design alpha, apply alphaMax at fill time), so a cold chunk is
 * pixel-identical to the committed draw. `S.hv` holds each poly's fade multiplier, `S.mv` its
 * morph t (with `from` when morphing).
 */
function drawHot(ctx: Ctx2D, c: Cooked, list: Int32Array, nList: number, table: InkTable, m: Mat2x3,
  clip: AABB | null, hv: HotView, S: PolyState, from: Float32Array | null): void {
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const aMul = table.alphaMax;
  if (!(sc > 0) || !(aMul > 0) || nList === 0) return;
  const lighter = table.op === 'lighter';
  const { clock, now, tip, H, tau, beyond, sVis } = hv;
  hotBatcher.reset();
  rgN = 0;
  const p = c.pts;
  for (let q = 0; q < nList; q++) {
    const i = list[q];
    if (clip && !boxHitsDev(c.box, i, m, clip)) continue;
    const st = c.start[i], cnt = c.count[i];
    if (cnt < 2) continue;
    widthStats(c, i);
    let a = c.alpha[i], mode = MODE_FILL;
    if (wsMax * sc < 1) { mode = MODE_HAIR; a *= wsMean * sc; }
    const kb = alphaBucket(a);
    if (kb < 0 || a * aMul < MIN_ALPHA) continue;
    const css = toneIndex(table, c.tone[i], c.born[i]);
    const base = ALPHA_LEVELS[kb];
    const born = c.born[i];
    const sA = born + p[4 * st + 3], sB = born + p[4 * (st + cnt - 1) + 3];
    const fade = S.hv[i];
    if (!(sB > sA)) {
      if (sVis < sA) continue;
      const e = H > 0 ? hotEta(now - clock.at(sA, beyond), tau) * windowEdge(sA, tip) : 0;
      addRange(pushRange(i, NaN, NaN, NaN), css, kb, base, (1 + H * e) * fade, mode, lighter, aMul);
      continue;
    }
    // a replay's trunk ends at the nib in a round tip (prefix reveal of this poly)
    const sE = sVis < sB ? sVis : sB;
    if (!(sE > sA)) continue;
    const tipRev = sE < sB ? (sE - sA) / (sB - sA) : NaN;
    let lo = sA, curLo = sA, curMul = -1;
    let b = (Math.floor(sA / HOT_CHUNK) + 1) * HOT_CHUNK;
    while (lo < sE) {
      const hi = b < sE ? b : sE;
      const mid = 0.5 * (lo + hi);
      const e = H > 0 ? hotEta(now - clock.at(mid, beyond), tau) * windowEdge(mid, tip) : 0;
      const mul = (1 + H * e) * fade;
      if (mul !== curMul) {
        if (curMul >= 0) addRange(pushRange(i, curLo <= sA ? NaN : curLo - born, lo - born, NaN), css, kb, base, curMul, mode, lighter, aMul);
        curLo = lo; curMul = mul;
      }
      lo = hi; b += HOT_CHUNK;
    }
    if (curMul >= 0) addRange(pushRange(i, curLo <= sA ? NaN : curLo - born, NaN, tipRev), css, kb, base, curMul, mode, lighter, aMul);
  }
  if (hotBatcher.n === 0) return;
  const plan = hotBatcher.build(table.spectral);
  const o = HOPTS;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = table.op;
  for (let k = 0; k < plan.n; k++) {
    const ga = plan.alpha[k] * aMul;
    ctx.globalAlpha = ga < 1 ? ga : 1;
    ctx.beginPath();
    const hair = plan.mode[k] === MODE_HAIR;
    let any = false;
    for (let e = plan.first[k], end = e + plan.count[k]; e < end; e++) {
      const r = hotBatcher.poly[plan.order[e]];
      const i = rgPoly[r];
      const f = rgFrom[r], t = rgTo[r], rev = rgRev[r];
      o.arcFrom = f === f ? f : undefined;
      o.arcTo = t === t ? t : undefined;
      o.reveal = rev === rev ? rev : undefined;
      const mt = S.mv[i];
      o.morphFrom = from && mt < 1 ? from : null;
      o.morphT = from && mt < 1 ? mt : undefined;
      if (hair ? traceCentre(ctx, c, i, m, o) : tracePoly(ctx, c, i, m, o)) any = true;
    }
    if (!any) continue;
    if (hair) {
      ctx.strokeStyle = table.css[plan.css[k]];
      ctx.lineWidth = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
    } else {
      ctx.fillStyle = table.css[plan.css[k]];
      ctx.fill('nonzero');
    }
  }
  ctx.restore();
  o.arcFrom = undefined; o.arcTo = undefined; o.reveal = undefined; o.morphFrom = null; o.morphT = undefined;
}

// ---------------------------------------------------------------------------- halo

/** Parse '#rgb', '#rrggbb' or 'rgb(a)(r, g, b…)' into out; false when unknown. */
export function cssRgb(css: string, out: Uint8Array): boolean {
  if (css.charCodeAt(0) === 35) {
    const h = css.length === 4 ? css[1] + css[1] + css[2] + css[2] + css[3] + css[3] : css.slice(1, 7);
    const v = parseInt(h, 16);
    if (h.length !== 6 || v !== v) return false;
    out[0] = (v >> 16) & 255; out[1] = (v >> 8) & 255; out[2] = v & 255;
    return true;
  }
  const mm = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(css);
  if (!mm) return false;
  out[0] = +mm[1]; out[1] = +mm[2]; out[2] = +mm[3];
  return true;
}

const gradCache = new WeakMap<object, Map<string, CanvasGradient>>();

/** A unit radial gradient (centre 0,0, radius 1) in css, soft: 1 → .6 → .2 → 0. Cached per context. */
function haloGradient(ctx: Ctx2D, css: string): CanvasGradient | null {
  let m = gradCache.get(ctx);
  if (!m) { m = new Map(); gradCache.set(ctx, m); }
  let g = m.get(css);
  if (g) return g;
  const rgb = new Uint8Array(3);
  if (!cssRgb(css, rgb)) return null;
  const c = `${rgb[0]},${rgb[1]},${rgb[2]}`;
  g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(${c},1)`);
  g.addColorStop(0.38, `rgba(${c},0.6)`);
  g.addColorStop(0.72, `rgba(${c},0.18)`);
  g.addColorStop(1, `rgba(${c},0)`);
  if (m.size >= 24) m.clear();
  m.set(css, g);
  return g;
}

/** Fill a soft glow disc at device (x, y) radius r with alpha a and composite op. */
function drawGlow(ctx: Ctx2D, x: number, y: number, r: number, a: number, css: string, op: GlobalCompositeOperation): void {
  if (!(a > 0) || !(r > 0)) return;
  const g = haloGradient(ctx, css);
  if (!g) return;
  ctx.save();
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = a > 1 ? 1 : a;
  ctx.setTransform(r, 0, 0, r, x, y);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, 6.283185307179586);
  ctx.fill();
  ctx.restore();
}

/** Halo brightness (DESIGN §6.6): pre · (0.15 + 0.5·level) · brim flash (×1.8 for 160 ms, easing off over its last 60). */
export function haloAlpha(pre: number, level: number, flashAge: number, rm: boolean): number {
  let p = clamp01(pre), l = clamp01(level);
  if (rm) { p = p >= 0.5 ? 1 : 0; l = Math.round(l * 4) / 4; }
  let k = 1;
  if (!rm && flashAge >= 0 && flashAge < BRIM_MS) k = 1 + 0.8 * (flashAge < 100 ? 1 : 1 - (flashAge - 100) / (BRIM_MS - 100));
  return p * (0.15 + 0.5 * l) * k;
}

// ============================================================================ items

/** A committed stroke ready for the renderer's two-phase bake. */
interface BakeJob { item: Item; r: StrokeRecipe; c: Cooked }

/** Shared frame context. */
interface LayerCx {
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

const TAG_LIVE = 1, TAG_FINISH = 2, TAG_PLAY = 3, TAG_ANIM = 4;

/** Anything the live layer draws. */
interface Item {
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

type Rec = RecipeCore & { id?: string; colorRev?: number };

/**
 * A stroke drawn poly by poly with a #dry / #wet split: the live stroke, its finish after lift,
 * and a replayed stroke. Per poly: reveal (time prefix with chains, or the trunk's arc for a
 * replay), morph, lift fade, hot multiplier; a poly moves to #dry once nothing about it is still
 * changing (cooled, revealed, settled, outside a hold's pinned window).
 */
abstract class WakeItem implements Item {
  dead = false;
  id: string | null = null;
  abstract readonly tag: number;
  src: Cooked;
  readonly S = new PolyState();
  table!: InkTable;
  readonly m: Mat2x3 = new Float64Array(6);
  /** Placement of a symmetry copy (doc rel. origin -> doc rel. origin), composed into `m`; null = none. */
  xf: Mat2x3 | null = null;
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

const TMP_BOX: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
const TMP_BOX2: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };

// ---------------------------------------------------------------------------- the live stroke

/** The stroke being drawn: mirrors the cook's live view and animates it. */
class LiveStroke extends WakeItem {
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
  /** A symmetry copy: it mirrors the same cook as the stroke (whose drain events it leaves alone). */
  follower = false;

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
    if (!this.follower) this.cook.drainSettled(this.onDrain);
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
class FinishStroke extends WakeItem {
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

function maxPool(r: StrokeRecipe): number {
  let m = 0;
  for (let o = PL.A; o < r.pools.length; o += PL.STRIDE) if (r.pools[o] > m) m = r.pools[o];
  return m;
}

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
class PlayStroke extends WakeItem {
  readonly tag = TAG_PLAY;
  readonly bakeAfter: boolean;
  private readonly tStart: number;
  private readonly scale: number;
  private readonly tEnd: number;
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

// ---------------------------------------------------------------------------- whole-stroke animations

const WAIT = 0, GROW = 1, UNGROW = 2, BAKE = 3, REST = 4, LIFTED = 5;

/**
 * A committed stroke drawn whole: re-grow (redo, restyle, load), un-grow (removal, withdraw,
 * dissolve), waiting for its restyle turn, baking, resting, or lifted (selection layer).
 */
class AnimStroke implements Item {
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

/** Per-poly reveal currently visible on a wake item (hidden 0, dry 1, wet its reveal). */
function visibleReveal(w: WakeItem): Float32Array {
  const n = w.src.nPolys, out = new Float32Array(n), S = w.S;
  for (let i = 0; i < n; i++) out[i] = S.st[i] === DRY ? 1 : S.st[i] === HIDDEN ? 0 : S.rv[i];
  return out;
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
  /** A committed symmetry copy's finish -> the stroke's finish (capAnimations). */
  const copyOf = new WeakMap<Item, Item>();
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
   * its copies, `copyOf`) counts as one and fast-forwards together, so the copies never part ways.
   */
  function capAnimations(now: number): void {
    let n = 0;
    for (const it of items) if (!it.dead && !copyOf.has(it) && !(it instanceof LiveStroke && it.follower) && it.animating()) n++;
    for (let k = 0; k < items.length && n > MAX_ANIMATING; k++) {
      const it = items[k];
      if (it.dead || it === live || copyOf.has(it) || (it instanceof LiveStroke && it.follower) || !it.animating()) continue;
      it.fastForward(now, cx);
      for (const c of items) if (copyOf.get(c) === it && !c.dead) c.fastForward(now, cx);
      n--;
    }
  }

  function killId(id: string | null | undefined): void {
    if (!id) return;
    for (const it of items) if (!it.dead && it.id === id && it.tag !== TAG_LIVE && !(it instanceof AnimStroke && it.mode === LIFTED)) it.kill(cx);
  }

  function begin(d: DraftStroke, cook: IncrementalCook, copies?: readonly LiveCopy[]): void {
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
    followers = [];
    if (copies) {
      for (const cp of copies) {
        const f = new LiveStroke({ ...d, color: cp.color }, cook);
        f.follower = true;
        f.xf = cp.xf;
        f.refresh(cx);
        followers.push(f);
        items.push(f);
      }
    }
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

  function commit(r: StrokeRecipe, c: Cooked, copies?: readonly { r: StrokeRecipe; c: Cooked }[]): void {
    const now = host.now();
    prepare(now);
    const ls = live;
    const fs = followers;
    followers = [];
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
      const n = copies ? copies.length : 0;
      for (let k = 0; k < fs.length; k++) {
        const fl = fs[k];
        if (k < n) {
          // drawn from the stroke's own geometry through the copy's placement; bakes the placed geometry
          const fk = new FinishStroke(fl, copies![k].r, c, now, cx, fold, copies![k].c);
          copyOf.set(fk, f0);
          fl.dead = true;
          replace(fl, fk);
        } else fl.kill(cx);
      }
      capAnimations(now);
    } else {
      for (const f of fs) f.kill(cx);
      killId(r.id);
      const a = new AnimStroke(r, c, r.form.form, BAKE, now, 0);
      a.refresh(cx);
      items.push(a);
    }
    if (copies && (!ls || fs.length < copies.length)) {
      for (let k = ls ? fs.length : 0; k < copies.length; k++) {
        killId(copies[k].r.id);
        const a = new AnimStroke(copies[k].r, copies[k].c, copies[k].r.form.form, BAKE, now, 0);
        a.refresh(cx);
        items.push(a);
      }
    }
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
    play(r: StrokeRecipe, c: Cooked, opts?: PlayOpts): void {
      const now = host.now();
      prepare(now);
      killId(r.id);
      const p = new PlayStroke(r, c, opts, now, cx);
      p.refresh(cx);
      items.push(p);
      capAnimations(now);
      host.requestFrame();
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
