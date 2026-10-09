/**
 * Charcoal fills (DESIGN §6.4): one batch of a charcoal stroke through the paper tooth.
 *
 * The coverage is built in a scratch canvas, then tinted and composited once:
 *  1. the full-width ribbon is filled with the Fringe mask (only the peaks: the edges break),
 *  2. the same polys at CORE_WIDTH with the Core mask, alpha-composited over it; the core mask is
 *     (c − f)/(1 − f), so the two together cover exactly max(core, fringe) at every texel,
 *  3. `source-in` with the batch's colour turns coverage into ink,
 *  4. the result is drawn onto the target with the ground's op and the batch alpha: one
 *     `lighter` / `multiply` composite, exactly like a plain fill whose alpha is the coverage.
 * Masks carry coverage only (no colour), so they are shared by every ink and stroke: at most one
 * per (pressure level, smudge, pass, 1× / 2×), built on first use and kept in an LRU of MASK_BYTES.
 * `pattern.setTransform(m · translate(−origin) · scale(cell))` maps texels to the device space of
 * the path, so the grain never swims on pan or zoom and tiles, live layers and exports agree.
 *
 * Zoomed in, where a texel spans HI_TEXEL device px or more, the mask is built at 2× from bilinearly
 * interpolated heights and thresholded after interpolation, so the grain keeps smooth contours.
 * Zoomed out below MIN_TEXEL device px a texel, or without a canvas (tests), the batch is a plain
 * fill at the ribbon's mean coverage (toothSolid), which is what the grain averages to.
 */
import type { AABB, InkTable, Mat2x3 } from '../core/types';
import { CORE_WIDTH, TOOTH_N, ToothPass, toothHeight, toothLevel, toothLut, toothSolid } from '../ink/tooth';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Texels below this many device px draw as their mean coverage (no sub-pixel sparkle). */
const MIN_TEXEL = 0.45;
/** Texels of at least this many device px use the 2× mask. */
const HI_TEXEL = 2.5;
/** Bytes of masks kept (1 MB each at 1×, 4 MB at 2×). */
const MASK_BYTES = 32 * 1024 * 1024;
/** Largest scratch side (device px); bigger batches are drawn in chunks. */
const SCRATCH_MAX = 1024;

/** Traces a batch's polys into `ctx` through `m` at a width scale; false when nothing was traced. */
export type TraceBatch = (ctx: Ctx2D, m: Mat2x3, widthScale: number | undefined) => boolean;

function makeCanvas(n: number): AnyCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    return c;
  }
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : null;
}

// ---------------------------------------------------------------------------- masks

interface Mask { canvas: AnyCanvas; pattern: CanvasPattern; bytes: number }
const masks = new Map<number, Mask>();
let maskBytes = 0;
/** Tooth heights per (smudge, scale 1 or 2): built once each (256 KB at 1×, 1 MB at 2×). */
const heights = new Map<number, Uint8Array>();

function heightsFor(smudge: number, up: 1 | 2): Uint8Array {
  const key = smudge * 2 + up - 1;
  let h = heights.get(key);
  if (h) return h;
  const N = TOOTH_N, M = N * up;
  h = new Uint8Array(M * M);
  if (up === 1) for (let k = 0; k < N * N; k++) h[k] = toothHeight(k, smudge);
  else {
    const base = heightsFor(smudge, 1);
    for (let y = 0; y < M; y++) {
      // sample centres of the fine grid in coarse texel space, wrapping
      const fy = (y + 0.5) / 2 - 0.5, y0 = Math.floor(fy), ty = fy - y0;
      const r0 = ((y0 + N) % N) * N, r1 = ((y0 + 1) % N) * N;
      for (let x = 0; x < M; x++) {
        const fx = (x + 0.5) / 2 - 0.5, x0 = Math.floor(fx), tx = fx - x0;
        const c0 = (x0 + N) % N, c1 = (x0 + 1) % N;
        const a = base[r0 + c0] + (base[r0 + c1] - base[r0 + c0]) * tx;
        const b = base[r1 + c0] + (base[r1 + c1] - base[r1 + c0]) * tx;
        h[y * M + x] = Math.round(a + (b - a) * ty);
      }
    }
  }
  heights.set(key, h);
  return h;
}

/**
 * Mask alpha per tooth height: the fringe's own coverage f, and for the core what is still
 * missing once the fringe is down, (c − f)/(1 − f), so `over` lands on max(c, f).
 */
export function maskLut(level: number, smudge: number, pass: ToothPass): Uint8Array {
  const f = toothLut(level, smudge, ToothPass.Fringe);
  if (pass === ToothPass.Fringe) return f;
  const c = toothLut(level, smudge, ToothPass.Core), out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) if (c[v] > f[v]) out[v] = Math.round((255 * (c[v] - f[v])) / (255 - f[v]));
  return out;
}

/** The coverage mask of a pass as a repeating pattern of `ctx`; null without a canvas. */
function maskFor(ctx: Ctx2D, level: number, smudge: number, pass: ToothPass, up: 1 | 2): CanvasPattern | null {
  const key = ((level * 4 + smudge) * 2 + pass) * 2 + up - 1;
  const hit = masks.get(key);
  if (hit) { masks.delete(key); masks.set(key, hit); return hit.pattern; }
  const M = TOOTH_N * up;
  const canvas = makeCanvas(M);
  const cctx = canvas ? canvas.getContext('2d') as Ctx2D | null : null;
  if (!canvas || !cctx || typeof ImageData === 'undefined') return null;
  const lut = maskLut(level, smudge, pass), h = heightsFor(smudge, up), n = M * M;
  const px = new Uint8ClampedArray(4 * n);
  for (let k = 0; k < n; k++) px[4 * k + 3] = lut[h[k]];
  cctx.putImageData(new ImageData(px, M, M), 0, 0);
  const pattern = ctx.createPattern(canvas, 'repeat');
  if (!pattern) return null;
  const bytes = 4 * n;
  while (masks.size && maskBytes + bytes > MASK_BYTES) {
    const old = masks.keys().next().value as number;
    const e = masks.get(old)!;
    e.canvas.width = 0; e.canvas.height = 0;
    maskBytes -= e.bytes;
    masks.delete(old);
  }
  masks.set(key, { canvas, pattern, bytes });
  maskBytes += bytes;
  return pattern;
}

// ---------------------------------------------------------------------------- scratch

let scratch: Ctx2D | null = null;

/** The shared scratch context, at least w × h (grown in powers of two up to SCRATCH_MAX). */
function scratchFor(w: number, h: number): Ctx2D | null {
  const need = Math.max(w, h);
  if (scratch && scratch.canvas.width >= need) return scratch;
  let side = scratch ? scratch.canvas.width : 256;
  while (side < need) side *= 2;
  const c = makeCanvas(Math.min(side, SCRATCH_MAX));
  scratch = c ? c.getContext('2d') as Ctx2D | null : null;
  return scratch;
}

// ---------------------------------------------------------------------------- one batch

const SM = new Float64Array(6);
const PM = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * Draw one charcoal batch in table entry `css` at final `alpha` onto `ctx` (identity transform,
 * composite op already the ground's). `box` is the batch's device box (padded here), `clip` the
 * caller's device clip, `m` maps doc rel. origin to device px, and `trace` builds the batch's path.
 */
export function drawToothBatch(ctx: Ctx2D, table: InkTable, css: number, m: Mat2x3, alpha: number,
  box: AABB, clip: AABB | null, trace: TraceBatch): void {
  const t = table.tooth!, level = toothLevel(css);
  const texel = t.cell * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), up = texel >= HI_TEXEL ? 2 : 1;
  const fringe = texel >= MIN_TEXEL ? maskFor(ctx, level, t.smudge, ToothPass.Fringe, up) : null;
  const core = fringe && maskFor(ctx, level, t.smudge, ToothPass.Core, up);
  // the region: the batch box, padded for miters and antialiasing, inside the clip and the canvas
  const pad = 0.08 * Math.min(box.x1 - box.x0, box.y1 - box.y0) + 2;
  let x0 = Math.floor(box.x0 - pad), y0 = Math.floor(box.y0 - pad), x1 = Math.ceil(box.x1 + pad), y1 = Math.ceil(box.y1 + pad);
  if (clip) { x0 = Math.max(x0, Math.floor(clip.x0)); y0 = Math.max(y0, Math.floor(clip.y0)); x1 = Math.min(x1, Math.ceil(clip.x1)); y1 = Math.min(y1, Math.ceil(clip.y1)); }
  const cv = (ctx as { canvas?: { width: number; height: number } }).canvas;
  if (cv) { x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, cv.width); y1 = Math.min(y1, cv.height); }
  if (!(x1 > x0 && y1 > y0)) return;
  const s = core ? scratchFor(Math.min(x1 - x0, SCRATCH_MAX), Math.min(y1 - y0, SCRATCH_MAX)) : null;
  if (!s || !fringe || !core) {
    // far zoom or no canvas: the grain's average as a plain fill
    ctx.fillStyle = table.css[css];
    ctx.globalAlpha = alpha * toothSolid(level, t.smudge);
    ctx.beginPath();
    if (trace(ctx, m, undefined)) ctx.fill('nonzero');
    return;
  }
  const c = t.cell / up, sm = SM, pm = PM;
  for (let cy = y0; cy < y1; cy += SCRATCH_MAX) {
    for (let cx = x0; cx < x1; cx += SCRATCH_MAX) {
      const w = Math.min(SCRATCH_MAX, x1 - cx), h = Math.min(SCRATCH_MAX, y1 - cy);
      sm.set(m); sm[4] -= cx; sm[5] -= cy;
      // mask px (u, v) → doc rel. origin (u·cell/up − ox, v·cell/up − oy) → scratch px through sm
      pm.a = sm[0] * c; pm.b = sm[1] * c; pm.c = sm[2] * c; pm.d = sm[3] * c;
      pm.e = sm[4] - (sm[0] * t.ox + sm[2] * t.oy); pm.f = sm[5] - (sm[1] * t.ox + sm[3] * t.oy);
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalAlpha = 1;
      s.globalCompositeOperation = 'source-over';
      s.clearRect(0, 0, w, h);
      fringe.setTransform(pm); core.setTransform(pm);
      s.fillStyle = fringe;
      s.beginPath();
      if (!trace(s, sm, undefined)) continue;
      s.fill('nonzero');
      s.fillStyle = core;
      s.beginPath();
      if (trace(s, sm, CORE_WIDTH)) s.fill('nonzero');
      s.globalCompositeOperation = 'source-in';
      s.fillStyle = table.css[css];
      s.fillRect(0, 0, w, h);
      ctx.globalAlpha = alpha;
      ctx.drawImage(s.canvas, 0, 0, w, h, cx, cy, w, h);
    }
  }
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
