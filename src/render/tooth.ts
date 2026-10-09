/**
 * Charcoal fills (DESIGN §6.4): one stroke's charcoal batches through the paper tooth.
 *
 * Coverage is built once for all the batches of a draw call, in a colour-free scratch, so it is
 * continuous along the stroke however the stroke is split into batches:
 *  1. Density D: every batch's ribbon is filled into a coarse field at its pressure's density
 *     (ink/tooth.ts toothDensity), once per step of the stick's contact (TOOTH_CONTACT: nested
 *     width scales, outside in, each adding density or cutting a share of it), so the middle is
 *     dense, the edges thin, and drag lanes streak the grain along the stroke. Drawn back with
 *     bilinear smoothing, the coarse field blurs the pressure steps and ring edges into gradients.
 *  2. Grain H: the tooth map (as its depth 1 − H) as a filtered pattern, anchored to the page, plus
 *     finer octaves of the same map (cell / 4, cell / 16) that fade in as a texel grows on screen,
 *     so zooming in reveals finer tooth instead of magnified texels.
 *  3. Threshold: coverage = clamp((H + D − 1)·2^k) at device resolution, in the alpha channel:
 *     v = min(1, (1 − H) + (1 − D)) by adding, 1 − v by one xor, then k self-additions. Contours
 *     stay smooth at any zoom, and no density means no pigment. (Canvas-to-canvas draws are the
 *     expensive step on software GL, so the pipeline keeps them to the density, k, and one per pigment.)
 * Batches of one pigment and alpha (ink/tooth.ts toothInk: pressure changes density, not colour)
 * are then traced as one path, cut from that coverage, tinted with `source-in`, and composited once
 * with the ground's op and their alpha: like a plain fill whose alpha is the coverage.
 *
 * The density field's grid is anchored to the stroke origin's device position and the grain to the
 * document, so tiles, the live layer and exports draw the same coverage. Zoomed out below MIN_TEXEL
 * device px a texel, or without a canvas (tests), each batch is a plain fill at the ribbon's mean
 * coverage (toothSolid), which is what the grain averages to.
 */
import type { AABB, InkTable, Mat2x3 } from '../core/types';
import { TOOTH_CONTACT, TOOTH_GAIN, TOOTH_N, toothDensity, toothHeight, toothInk, toothLevel, toothSolid } from '../ink/tooth';
import { MODE_HAIR, type Batcher } from './batch';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Texels below this many device px draw as their mean coverage (no sub-pixel sparkle). */
const MIN_TEXEL = 0.45;
/** Largest scratch side (device px); bigger regions are drawn in chunks. */
const SCRATCH_MAX = 1024;
/** Device px per density texel: this fraction of the nominal ribbon width, within [1, BLUR_MAX]. */
const BLUR_PER_WIDTH = 1 / 16, BLUR_MAX = 6;
/** Density texels of margin around a chunk, so its bilinear edge never shows. */
const DPAD = 2;
/** Finer octaves: octave k (cell / 4^k) reaches FINE_WEIGHT as its texel grows from 2 to 6 device px. */
const OCTAVES = 2, FINE_WEIGHT = 0.3;

/** A draw call's batches (a Batcher plan; hairline batches are left to the caller) and how to draw them. */
export interface ToothPlan {
  plan: Batcher['plan'];
  /** Batch b's alpha is min(plan.alpha[b]·aMul, aCap). */
  aMul: number; aCap: number;
  /** Device box of batch b (into out, which arrives empty). */
  box(b: number, out: AABB): void;
  /** Add batch b's polys to ctx's current path through m at a width scale; false when nothing was traced. */
  trace(ctx: Ctx2D, b: number, m: Mat2x3, widthScale: number): boolean;
}

function makeCanvas(w: number, h: number): AnyCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : null;
}

// ---------------------------------------------------------------------------- grain

/** The tooth's depths (1 − height) of a smudge bucket as the alpha of a TOOTH_N² canvas, as a repeating pattern; built once each. */
const grains: (CanvasPattern | null | undefined)[] = [];
function grainPattern(smudge: number): CanvasPattern | null {
  let p = grains[smudge];
  if (p !== undefined) return p;
  const c = makeCanvas(TOOTH_N, TOOTH_N);
  const cx = c ? c.getContext('2d') as Ctx2D | null : null;
  if (!cx || typeof ImageData === 'undefined') return (grains[smudge] = null);
  const n = TOOTH_N * TOOTH_N, px = new Uint8ClampedArray(4 * n);
  for (let k = 0; k < n; k++) px[4 * k + 3] = 255 - toothHeight(k, smudge);
  cx.putImageData(new ImageData(px, TOOTH_N, TOOTH_N), 0, 0);
  p = cx.createPattern(cx.canvas, 'repeat');
  return (grains[smudge] = p);
}

// ---------------------------------------------------------------------------- scratch

/** Coverage, one pigment's ink, and the coarse density field. */
const scratch: (Ctx2D | null)[] = [null, null, null];
const COV = 0, INK = 1, DEN = 2;

/**
 * Scratch context `i`, created once at its full size (SCRATCH_MAX plus the density margin, square):
 * a canvas's first use is costly, so the scratches never grow.
 */
function scratchFor(i: number): Ctx2D | null {
  const s = scratch[i];
  if (s !== null) return s;
  const c = makeCanvas(SCRATCH_MAX + 2 * (DPAD + 1), SCRATCH_MAX + 2 * (DPAD + 1));
  return (scratch[i] = c ? c.getContext('2d') as Ctx2D | null : null);
}

// ---------------------------------------------------------------------------- one draw call

/** Per batch: its padded device box and its group (pigment and alpha); per group: its box. */
let boxes = new Float64Array(64), group = new Int32Array(16), gBox = new Float64Array(64);
const gInk: number[] = [], gAlpha: number[] = [];
const SM = new Float64Array(6), DM = new Float64Array(6);
const PM = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const BOX: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
const ramp = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/**
 * Draw a draw call's charcoal batches onto `ctx` (identity transform, composite op already the
 * ground's). `m` maps doc rel. origin to device px; `clip` is the caller's device clip. Returns the
 * number of fills composited.
 */
export function drawTooth(ctx: Ctx2D, table: InkTable, m: Mat2x3, clip: AABB | null, tp: ToothPlan): number {
  const t = table.tooth!, plan = tp.plan, n = plan.n;
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), texel = t.cell * sc;
  if (group.length < n) { boxes = new Float64Array(8 * n); gBox = new Float64Array(8 * n); group = new Int32Array(2 * n); }
  // batches → groups of one pigment and alpha; the region: every box, padded for miters and antialiasing
  gInk.length = 0; gAlpha.length = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let b = 0; b < n; b++) {
    group[b] = -1;
    if (plan.mode[b] === MODE_HAIR) continue;
    BOX.x0 = Infinity; BOX.y0 = Infinity; BOX.x1 = -Infinity; BOX.y1 = -Infinity;
    tp.box(b, BOX);
    const pad = 0.08 * Math.min(BOX.x1 - BOX.x0, BOX.y1 - BOX.y0) + 2;
    const bx0 = BOX.x0 - pad, by0 = BOX.y0 - pad, bx1 = BOX.x1 + pad, by1 = BOX.y1 + pad;
    boxes[4 * b] = bx0; boxes[4 * b + 1] = by0; boxes[4 * b + 2] = bx1; boxes[4 * b + 3] = by1;
    x0 = Math.min(x0, bx0); y0 = Math.min(y0, by0); x1 = Math.max(x1, bx1); y1 = Math.max(y1, by1);
    const ink = toothInk(plan.css[b]), alpha = Math.min(plan.alpha[b] * tp.aMul, tp.aCap);
    let g = 0;
    while (g < gInk.length && (gInk[g] !== ink || gAlpha[g] !== alpha)) g++;
    if (g === gInk.length) { gInk.push(ink); gAlpha.push(alpha); gBox[4 * g] = bx0; gBox[4 * g + 1] = by0; gBox[4 * g + 2] = bx1; gBox[4 * g + 3] = by1; }
    else { gBox[4 * g] = Math.min(gBox[4 * g], bx0); gBox[4 * g + 1] = Math.min(gBox[4 * g + 1], by0); gBox[4 * g + 2] = Math.max(gBox[4 * g + 2], bx1); gBox[4 * g + 3] = Math.max(gBox[4 * g + 3], by1); }
    group[b] = g;
  }
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
  if (clip) { x0 = Math.max(x0, Math.floor(clip.x0)); y0 = Math.max(y0, Math.floor(clip.y0)); x1 = Math.min(x1, Math.ceil(clip.x1)); y1 = Math.min(y1, Math.ceil(clip.y1)); }
  x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, ctx.canvas.width); y1 = Math.min(y1, ctx.canvas.height);
  if (!(x1 > x0 && y1 > y0)) return 0;

  const blur = Math.min(BLUR_MAX, Math.max(1, t.w * sc * BLUR_PER_WIDTH));
  const pat = texel >= MIN_TEXEL ? grainPattern(t.smudge) : null;
  const cov = pat && scratchFor(COV), ink = cov && scratchFor(INK), den = ink && scratchFor(DEN);
  if (!pat || !cov || !ink || !den) {
    // far zoom or no canvas: the grain's average as a plain fill
    for (let b = 0; b < n; b++) {
      if (group[b] < 0) continue;
      ctx.fillStyle = table.css[gInk[group[b]]];
      ctx.globalAlpha = gAlpha[group[b]] * toothSolid(toothLevel(plan.css[b]), t.smudge);
      ctx.beginPath();
      if (tp.trace(ctx, b, m, 1)) ctx.fill('nonzero');
    }
    return n;
  }
  let fills = 0;
  for (let cy = y0; cy < y1; cy += SCRATCH_MAX) {
    for (let cx = x0; cx < x1; cx += SCRATCH_MAX) {
      const w = Math.min(SCRATCH_MAX, x1 - cx), h = Math.min(SCRATCH_MAX, y1 - cy);
      SM.set(m); SM[4] -= cx; SM[5] -= cy;
      coverage(cov, den, pat, table, m, tp, cx, cy, w, h, blur, texel);
      // one composite per (pigment, alpha): batches that differ only in pressure share one path, so
      // the edges where the stroke changes pressure bucket merge instead of meeting as two fills
      for (let g = 0; g < gInk.length; g++) {
        const bx0 = Math.max(0, Math.floor(gBox[4 * g] - cx)), by0 = Math.max(0, Math.floor(gBox[4 * g + 1] - cy));
        const bw = Math.min(w, Math.ceil(gBox[4 * g + 2] - cx)) - bx0, bh = Math.min(h, Math.ceil(gBox[4 * g + 3] - cy)) - by0;
        if (!(bw > 0 && bh > 0)) continue;
        ink.save();
        ink.setTransform(1, 0, 0, 1, 0, 0);
        ink.beginPath();
        ink.rect(bx0, by0, bw, bh);
        ink.clip();                     // keeps destination-in / source-in to the group's box
        ink.clearRect(bx0, by0, bw, bh);
        ink.fillStyle = '#fff';
        ink.beginPath();
        let traced = false;
        for (let b = 0; b < n; b++) if (group[b] === g && tp.trace(ink, b, SM, 1)) traced = true;
        if (traced) {
          // the group's ribbon, cut from the shared coverage, tinted, composited with the ground's op
          ink.fill('nonzero');
          ink.globalCompositeOperation = 'destination-in';
          ink.drawImage(cov.canvas, bx0, by0, bw, bh, bx0, by0, bw, bh);
          ink.globalCompositeOperation = 'source-in';
          ink.fillStyle = table.css[gInk[g]];
          ink.fillRect(bx0, by0, bw, bh);
          ctx.globalAlpha = gAlpha[g];
          ctx.drawImage(ink.canvas, bx0, by0, bw, bh, cx + bx0, cy + by0, bw, bh);
          fills++;
        }
        ink.restore();
      }
    }
  }
  return fills;
}

/** Build the chunk (cx, cy, w × h) of the draw call's coverage into `cov` (see the module comment). */
function coverage(cov: Ctx2D, den: Ctx2D, pat: CanvasPattern, table: InkTable, m: Mat2x3, tp: ToothPlan,
  cx: number, cy: number, w: number, h: number, blur: number, texel: number): void {
  const t = table.tooth!, plan = tp.plan;
  // 1. density, on a grid of `blur` device px anchored at the stroke origin's device position
  const k0 = Math.floor((cx - m[4]) / blur) - DPAD, l0 = Math.floor((cy - m[5]) / blur) - DPAD;
  const dw = Math.ceil(w / blur) + 2 * DPAD + 1, dh = Math.ceil(h / blur) + 2 * DPAD + 1;
  DM[0] = m[0] / blur; DM[1] = m[1] / blur; DM[2] = m[2] / blur; DM[3] = m[3] / blur; DM[4] = -k0; DM[5] = -l0;
  den.setTransform(1, 0, 0, 1, 0, 0);
  den.clearRect(0, 0, dw, dh);
  den.fillStyle = '#fff';
  const mx0 = cx - DPAD * blur, my0 = cy - DPAD * blur, mx1 = cx + w + DPAD * blur, my1 = cy + h + DPAD * blur;
  for (let b = 0; b < plan.n; b++) {
    if (group[b] < 0 || boxes[4 * b] > mx1 || boxes[4 * b + 2] < mx0 || boxes[4 * b + 1] > my1 || boxes[4 * b + 3] < my0) continue;
    const d = toothDensity(toothLevel(plan.css[b]));
    // the stick's contact, outside in: rings add density, drag lanes cut a share of it (all nonzero)
    for (const [scale, amount] of TOOTH_CONTACT) {
      den.globalCompositeOperation = amount >= 0 ? 'lighter' : 'destination-out';
      den.globalAlpha = amount >= 0 ? d * amount : -amount;
      den.beginPath();
      if (tp.trace(den, b, DM, scale)) den.fill('nonzero');
    }
  }
  // ... inverted: 1 − D
  den.globalCompositeOperation = 'xor';
  den.globalAlpha = 1;
  den.fillRect(0, 0, dw, dh);
  // 2. the tooth's depth 1 − H, its finer octaves faded in by texel size
  cov.setTransform(1, 0, 0, 1, 0, 0);
  cov.imageSmoothingEnabled = true;
  cov.globalCompositeOperation = 'source-over';
  cov.clearRect(0, 0, w, h);
  cov.fillStyle = pat;
  let fine = 0;
  for (let k = OCTAVES; k >= 0; k--) {
    const weight = k ? FINE_WEIGHT * ramp((texel / 4 ** (k - 1) - 2) / 4) : 1 - fine;
    fine += weight;
    if (!(weight > 0)) continue;
    // texel (u, v) → doc rel. origin (u·s − ox, v·s − oy) → chunk px through SM
    const s = t.cell / 4 ** k;
    PM.a = SM[0] * s; PM.b = SM[1] * s; PM.c = SM[2] * s; PM.d = SM[3] * s;
    PM.e = SM[4] - (SM[0] * t.ox + SM[2] * t.oy); PM.f = SM[5] - (SM[1] * t.ox + SM[3] * t.oy);
    pat.setTransform(PM);
    cov.globalAlpha = weight;
    cov.fillRect(0, 0, w, h);
    cov.globalCompositeOperation = 'lighter';
  }
  // 3. v = min(1, (1 − H) + (1 − D)), smoothed density; coverage = clamp(2^k·(H + D − 1)) = clamp(2^k·(1 − v))
  cov.globalAlpha = 1;
  cov.drawImage(den.canvas, 0, 0, dw, dh, m[4] + k0 * blur - cx, m[5] + l0 * blur - cy, dw * blur, dh * blur);
  cov.fillStyle = '#fff';
  cov.globalCompositeOperation = 'xor';
  cov.fillRect(0, 0, w, h);
  cov.globalCompositeOperation = 'lighter';
  for (let i = TOOTH_GAIN; i > 0; i--) cov.drawImage(cov.canvas, 0, 0, w, h, 0, 0, w, h);
}

/** Grow `out` (device px) by poly i's box (doc rel. origin) mapped through m. */
export function growDevBox(out: AABB, box: Float32Array, i: number, m: Mat2x3): void {
  const bx0 = box[4 * i], by0 = box[4 * i + 1], bx1 = box[4 * i + 2], by1 = box[4 * i + 3];
  const xa = m[0] * bx0, xb = m[0] * bx1, xc = m[2] * by0, xd = m[2] * by1;
  const ya = m[1] * bx0, yb = m[1] * bx1, yc = m[3] * by0, yd = m[3] * by1;
  const X0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4], X1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
  const Y0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5], Y1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  if (X0 < out.x0) out.x0 = X0; if (Y0 < out.y0) out.y0 = Y0;
  if (X1 > out.x1) out.x1 = X1; if (Y1 > out.y1) out.y1 = Y1;
}
