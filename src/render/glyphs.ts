/**
 * Glyphs (DESIGN §3.4, §4, §6.8): the mini renders the chrome shows.
 *
 *  - Chips: Stroke = an S-curve in the current nib, size and ink (an eraser ring in erase mode);
 *    Color = the current ink's tone ramp on the current ground; Form = a tiny squiggle grown at
 *    the current base depth.
 *  - Sheet tiles: YOUR last committed stroke rendered through each option (nib, ink, Form), cooked
 *    at tile quality (≤ 2.5k points). The last stroke is used only if 40 ≤ L ≤ 2000 sp and its
 *    aspect is within 1:4..4:1; otherwise a stock squiggle stands in. Nib tiles render at true
 *    size. Static renders (P0), cached by (last stroke id:geomRev, option, ground).
 *  - Recent thumbnails of whole documents.
 *
 * Everything is cooked through the real pipeline (`cookPreview`), so a tile shows exactly what
 * that choice would grow. Strokes are re-laid into "tile space" first: the samples are scaled to
 * the tile (time scaled alike, so speeds, hence tapers, roughness and lean, are kept) at z = 1,
 * where doc units are CSS px.
 */
import type { AABB, ColorStyle, Cooked, FormId, Ground, InkId, NibId, Scene, StrokeRecipe, ToolState } from '../core/types';
import { S, PL } from '../core/types';
import type { Glyphs, TileOption } from './types';
import { cookPreview } from '../ink/cook';
import { CURRENT_V, FORMS } from '../ink/operators/registry';
import { NIBS } from '../ink/nibs';
import { DEFAULT_CALIB } from '../ink/calib';
import { GROUND_TOKENS, assignVariant, resolveInk, toneIndex } from '../ink/color';
import { inkTableFor, regionMatrix, type DrawOpts } from './raster';
import { drawInk } from './live';
import { paintGround } from './ground';
import type { CanvasLedgerExt } from './ledger';

/** Point budget of a tile / chip cook (DESIGN §3.4). */
export const TILE_MAX_PTS = 2500;
/** Last-stroke use rule (DESIGN §3.4). */
export const USE_MIN_L = 40, USE_MAX_L = 2000, USE_MAX_ASPECT = 4;
/** Chip strokes are cooked this much larger than shown (short tapers relative to the curve). */
const CHIP_UP = 2.5;
/** Cached rasters / geometries. */
const RASTER_CACHE = 40, GEOM_CACHE = 32;
/** Thumbnail: total cook budget (ms) before the remaining strokes are drawn as plain lines. */
const THUMB_BUDGET_MS = 40;
const THUMB_STROKE_PTS = 900;

export interface GlyphsDeps {
  /** The current scene (thumbnails reuse cached geometry of strokes it holds). */
  scene?: () => Scene | null;
  ledger?: CanvasLedgerExt;
  /** Preview cook (default ink/cook.ts cookPreview); injectable for tests. */
  cook?: (r: StrokeRecipe, maxPts: number) => Cooked;
  now?: () => number;
}

/** Glyphs plus cache control. */
export interface GlyphsImpl extends Glyphs {
  /** Drop every cached raster and geometry. */
  clear(): void;
  readonly cached: { rasters: number; geoms: number };
}

// ---------------------------------------------------------------------------- recipes

const GLYPH_SEED = 0x2f6b9a1d;

function baseRecipe(id: string, samples: Float32Array, nib: NibId, size: number, form: FormId, base: number, color: ColorStyle): StrokeRecipe {
  return {
    id, created: 0, origin: [0, 0], z: 1, rot: 0, seed: GLYPH_SEED, device: 'pen', calib: DEFAULT_CALIB.pen,
    stroke: { nib, size }, color, form: { form, v: CURRENT_V[form] ?? 1, base },
    s0: 0, cut: 0, resume: null, samples, pools: new Float32Array(0), closed: false, radial: false,
    sym: null, xf: null, geomRev: 0, colorRev: 0,
  };
}

/**
 * The stock squiggle: a lifted S-curve with a pressure swell, `w` × `h` sp, centred on the origin,
 * drawn at ~0.9 sp/ms by a pen held upright.
 */
export function stockSamples(w: number, h: number): Float32Array {
  const n = Math.max(8, Math.round((w + h) / 2));
  const out = new Float32Array(n * S.STRIDE);
  let t = 0, px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const x = (u - 0.5) * w;
    const y = Math.sin(u * Math.PI * 2 - 0.35) * h * 0.42 - (u - 0.5) * h * 0.12;
    if (i > 0) t += Math.hypot(x - px, y - py) / 0.9;
    px = x; py = y;
    const o = i * S.STRIDE;
    out[o + S.X] = x; out[o + S.Y] = y; out[o + S.T] = t;
    out[o + S.P] = 0.3 + 0.55 * Math.sin(Math.min(1, u * 1.25) * Math.PI);
    out[o + S.ALT] = Math.PI / 2; out[o + S.AZ] = 0; out[o + S.R] = NaN; out[o + S.C] = 0; out[o + S.CS] = 0;
  }
  return out;
}

/** Spine length (sp, from the raw samples) and bbox aspect (≥ 1) of a recipe. */
export function strokeMetrics(r: StrokeRecipe): { L: number; aspect: number; w: number; h: number } {
  const s = r.samples, n = (s.length / S.STRIDE) | 0;
  let L = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, px = 0, py = 0, have = false;
  for (let i = 0; i < n; i++) {
    const x = s[i * S.STRIDE + S.X], y = s[i * S.STRIDE + S.Y];
    if (!(x === x && y === y)) continue;
    if (have) L += Math.hypot(x - px, y - py);
    px = x; py = y; have = true;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const z = r.z > 0 ? r.z : 1;
  if (!have) return { L: 0, aspect: Infinity, w: 0, h: 0 };
  const w = (x1 - x0) * z, h = (y1 - y0) * z;
  const lo = Math.min(w, h), hi = Math.max(w, h);
  return { L: L * z, aspect: lo > 0 ? hi / lo : Infinity, w, h };
}

/** DESIGN §3.4 use rule for the last stroke in sheet tiles. */
export function lastUsable(r: StrokeRecipe | null): r is StrokeRecipe {
  if (!r || r.radial) return false;
  const m = strokeMetrics(r);
  return m.L >= USE_MIN_L && m.L <= USE_MAX_L && m.aspect <= USE_MAX_ASPECT;
}

/**
 * Re-lay a stroke into tile space: origin (0,0), z = 1, samples scaled so the stroke's box fits
 * `fitW` × `fitH` sp (centred), times scaled alike (speeds kept), pool arcs scaled alike.
 */
export function tileSpace(r: StrokeRecipe, fitW: number, fitH: number, id: string): StrokeRecipe {
  const s = r.samples, n = (s.length / S.STRIDE) | 0;
  const m = strokeMetrics(r);
  const z = r.z > 0 ? r.z : 1;
  const k = Math.min(fitW / Math.max(1e-3, m.w), fitH / Math.max(1e-3, m.h), 64);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = s[i * S.STRIDE + S.X], y = s[i * S.STRIDE + S.Y];
    if (!(x === x && y === y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const out = new Float32Array(s.length);
  for (let i = 0; i < n; i++) {
    const o = i * S.STRIDE;
    for (let c = 0; c < S.STRIDE; c++) out[o + c] = s[o + c];
    out[o + S.X] = (s[o + S.X] - cx) * z * k;
    out[o + S.Y] = (s[o + S.Y] - cy) * z * k;
    out[o + S.T] = s[o + S.T] * k;
  }
  const pools = r.pools.slice();
  for (let o = 0; o + PL.STRIDE <= pools.length; o += PL.STRIDE) pools[o + PL.S] *= k;
  return {
    ...r, id, origin: [0, 0], z: 1, rot: 0, samples: out, pools, s0: r.s0 * k, cut: 0, resume: null,
    xf: null, sym: null, geomRev: 0, colorRev: 0,
  };
}

function toolColor(t: ToolState): ColorStyle {
  if (t.ink === 'custom') return { ink: 'custom', k: 0, dh: 0, dL: 0, lch: t.custom };
  return assignVariant(t.ink, 0, null, null);
}

function inkColor(ink: InkId, custom: ColorStyle | undefined, t: ToolState): ColorStyle {
  if (custom) return custom;
  if (ink === 'custom') return { ink: 'custom', k: 0, dh: 0, dL: 0, lch: t.custom };
  return assignVariant(ink, 0, null, null);
}

const lchKey = (c: ColorStyle['lch']): string => (c ? c.night.join(',') + '/' + c.paper.join(',') : '-');
const colorKey = (c: ColorStyle): string => c.ink + ':' + c.k + ':' + c.dh + ':' + c.dL + ':' + lchKey(c.lch);

// ---------------------------------------------------------------------------- raster helpers

type Ctx2D = CanvasRenderingContext2D;

function dprOf(canvas: HTMLCanvasElement): number {
  const cw = canvas.clientWidth;
  if (cw > 0 && canvas.width > 0) return canvas.width / cw;
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/** Bounding box of every point of a cooked stroke (doc rel. origin), from its per-poly boxes. */
function cookedBox(c: Cooked): AABB {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.nPolys; i++) {
    const b = 4 * i;
    if (c.box[b] < x0) x0 = c.box[b]; if (c.box[b + 1] < y0) y0 = c.box[b + 1];
    if (c.box[b + 2] > x1) x1 = c.box[b + 2]; if (c.box[b + 3] > y1) y1 = c.box[b + 3];
  }
  if (!(x1 >= x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/**
 * Draw cooked geometry (tile space: doc = CSS px) into ctx (device px), centred at `center`
 * (doc) on the canvas centre, at `scale` CSS px per doc unit.
 */
function drawCentered(ctx: Ctx2D, r: StrokeRecipe, c: Cooked, g: Ground, W: number, H: number, dpr: number,
  center: readonly [number, number], scale: number, alphaScale = 1): void {
  const px = scale * dpr;
  const box: AABB = { x0: center[0] - W / 2 / px, y0: center[1] - H / 2 / px, x1: center[0] + W / 2 / px, y1: center[1] + H / 2 / px };
  const o: DrawOpts = { clipDev: { x0: 0, y0: 0, x1: W, y1: H }, alphaScale: alphaScale === 1 ? undefined : alphaScale };
  drawInk(ctx, c, inkTableFor(r, g), regionMatrix(r.origin, box, px), r.form.form, o);
}

/** Fit scale (CSS px per doc) of a box into W × H device px with a margin (CSS px). */
function fitScale(b: AABB, W: number, H: number, dpr: number, margin: number, maxScale: number): number {
  const w = Math.max(1e-3, b.x1 - b.x0), h = Math.max(1e-3, b.y1 - b.y0);
  const s = Math.min((W / dpr - 2 * margin) / w, (H / dpr - 2 * margin) / h);
  return Math.max(0.05, Math.min(maxScale, s));
}

// ---------------------------------------------------------------------------- glyphs

/** Create the Glyphs implementation. */
export function createGlyphs(deps: GlyphsDeps = {}): GlyphsImpl {
  const cookFn = deps.cook ?? cookPreview;
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const rasters = new Map<string, HTMLCanvasElement>();
  const geoms = new Map<string, { r: StrokeRecipe; c: Cooked }>();

  function lruGet<V>(m: Map<string, V>, k: string): V | undefined {
    const v = m.get(k);
    if (v !== undefined) { m.delete(k); m.set(k, v); }
    return v;
  }
  function lruPut<V>(m: Map<string, V>, k: string, v: V, cap: number, drop?: (v: V) => void): void {
    m.set(k, v);
    while (m.size > cap) {
      const first = m.keys().next().value as string;
      const old = m.get(first)!;
      m.delete(first);
      if (drop) drop(old);
    }
  }
  const freeCanvas = (c: HTMLCanvasElement): void => { if (deps.ledger) deps.ledger.free(c); else { c.width = 0; c.height = 0; } };

  function newCanvas(w: number, h: number): HTMLCanvasElement | null {
    if (deps.ledger) return deps.ledger.alloc(w, h, 'glyph');
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Cook (cached) a recipe built by `make` under `key`. */
  function geom(key: string, make: () => StrokeRecipe): { r: StrokeRecipe; c: Cooked } | null {
    const hit = lruGet(geoms, key);
    if (hit) return hit;
    try {
      const r = make();
      const c = cookFn(r, TILE_MAX_PTS);
      const e = { r, c };
      lruPut(geoms, key, e, GEOM_CACHE);
      return e;
    } catch (err) {
      console.error('[glyphs] cook failed', err);
      return null;
    }
  }

  /**
   * Render through the raster cache: `paint` draws into a fresh W × H context once per key; later
   * calls blit the cached raster (one drawImage). The canvas is always redrawn: its owner may
   * have cleared or resized it since (a sheet tile emptied and refilled with the same option), so
   * remembering "this canvas already shows key k" would leave it blank.
   */
  function cached(canvas: HTMLCanvasElement, key: string, paint: (ctx: Ctx2D, W: number, H: number, dpr: number) => void): void {
    const W = canvas.width, H = canvas.height;
    if (!(W > 0 && H > 0)) return;
    const full = key + '@' + W + 'x' + H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = dprOf(canvas);
    let r = lruGet(rasters, full);
    if (!r) {
      const made = newCanvas(W, H);
      if (!made) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, W, H);
        ctx.restore();
        paint(ctx, W, H, dpr);
        return;
      }
      r = made;
      const rc = r.getContext('2d')!;
      rc.clearRect(0, 0, W, H);
      paint(rc, W, H, dpr);
      lruPut(rasters, full, r, RASTER_CACHE, freeCanvas);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(r, 0, 0);
    ctx.restore();
  }

  // ------------------------------------------------------------------ chips

  /** Display size for the Stroke chip: the nib's range compressed into ~1.5–9 CSS px. */
  function chipSize(nib: NibId, size: number): number {
    const d = NIBS[nib];
    const t = Math.max(0, Math.min(1, (Math.log(Math.max(d.min, size)) - Math.log(d.min)) / (Math.log(d.max) - Math.log(d.min))));
    return 1.6 + 7.4 * Math.sqrt(t);
  }

  function chipStroke(canvas: HTMLCanvasElement, t: ToolState, g: Ground): void {
    const nib = t.nib, size = t.sizes[nib] ?? NIBS[nib].S;
    const col = toolColor(t);
    const sz = chipSize(nib, size);
    const key = `chip:stroke:${nib}:${sz.toFixed(2)}:${colorKey(col)}:${g}`;
    cached(canvas, key, (ctx, W, H, dpr) => {
      const w = W / dpr, h = H / dpr;
      // cooked CHIP_UP× larger and drawn back down, so the tapers stay short next to the curve
      // and the displayed width is the compressed size `sz`
      const e = geom(`chipS:${nib}:${sz.toFixed(2)}:${Math.round(w)}x${Math.round(h)}`, () =>
        baseRecipe('glyph:chip:stroke', stockSamples(Math.max(10, w - 6 - sz) * CHIP_UP, Math.max(6, h - 6 - sz) * CHIP_UP), nib, sz * CHIP_UP, 'line', 0, col));
      if (!e) return;
      const r = { ...e.r, color: col };
      const b = cookedBox(e.c);
      drawCentered(ctx, r, e.c, g, W, H, dpr, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], fitScale(b, W, H, dpr, 2, 1 / CHIP_UP));
    });
  }

  function chipErase(canvas: HTMLCanvasElement, g: Ground): void {
    cached(canvas, `chip:erase:${g}`, (ctx, W, H, dpr) => {
      const tok = GROUND_TOKENS[g];
      const R = Math.min(W, H) * 0.32;
      ctx.save();
      // a ghost of a stroke being erased
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = tok.textDim;
      ctx.lineWidth = 2 * dpr;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(W * 0.14, H * 0.66);
      ctx.bezierCurveTo(W * 0.36, H * 0.2, W * 0.62, H * 0.9, W * 0.86, H * 0.34);
      ctx.stroke();
      // the eraser ring, in the accent colour
      ctx.globalAlpha = 1;
      ctx.fillStyle = g === 'night' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = tok.accent;
      ctx.lineWidth = 1.75 * dpr;
      ctx.stroke();
      ctx.restore();
    });
  }

  function chipColor(canvas: HTMLCanvasElement, t: ToolState, g: Ground): void {
    const col = toolColor(t);
    cached(canvas, `chip:color:${colorKey(col)}:${g}`, (ctx, W, H, dpr) => {
      const table = resolveInk(col, g);
      const x0 = W * 0.14, x1 = W * 0.86, cy = H / 2, th = Math.min(H * 0.42, 12 * dpr);
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      if (table.spectral) {
        for (let i = 0; i <= 12; i++) {
          const hb = Math.round(((table.hs + i * 30) % 360) / 10) % 36;
          grad.addColorStop(i / 12, table.css[hb * 30 + 20]);
        }
      } else {
        // light touch → full pressure at depth 0, then deepening with depth
        const stops = [5, 10, 15, 20, 25, 26, 27, 28, 29];
        stops.forEach((tone, i) => grad.addColorStop(i / (stops.length - 1), table.css[toneIndex(table, tone, 0)]));
      }
      ctx.save();
      ctx.globalCompositeOperation = table.op;
      ctx.globalAlpha = table.alphaMax;
      ctx.fillStyle = grad;
      ctx.beginPath();
      const r = th / 2;
      ctx.moveTo(x0 + r, cy - r);
      ctx.lineTo(x1 - r, cy - r);
      ctx.arc(x1 - r, cy, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(x0 + r, cy + r);
      ctx.arc(x0 + r, cy, r, Math.PI / 2, Math.PI * 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  function chipForm(canvas: HTMLCanvasElement, t: ToolState, g: Ground): void {
    const form = t.form, base = t.base[form] ?? FORMS[form].baseDefault;
    const col = toolColor(t);
    const nib: NibId = t.nib === 'chisel' ? 'chisel' : t.nib;
    const key = `chip:form:${form}:${base}:${nib}:${colorKey(col)}:${g}`;
    cached(canvas, key, (ctx, W, H, dpr) => {
      // a hand-sized squiggle (so growth has room to read), fitted down into the chip
      const e = geom(`chipF:${form}:${base}:${nib}`, () =>
        baseRecipe('glyph:chip:form', stockSamples(150, 60), nib, nib === 'pen' ? 3 : 6, form, base, col));
      if (!e) return;
      const r = { ...e.r, color: col };
      const b = cookedBox(e.c);
      drawCentered(ctx, r, e.c, g, W, H, dpr, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], fitScale(b, W, H, dpr, 2, 1.2));
    });
  }

  // ------------------------------------------------------------------ sheet tiles

  function sourceOf(lastR: StrokeRecipe | null): { key: string; r: StrokeRecipe | null } {
    if (lastUsable(lastR)) return { key: lastR.id + ':' + lastR.geomRev, r: lastR };
    return { key: 'stock', r: null };
  }

  function tile(canvas: HTMLCanvasElement, opt: TileOption, lastR: StrokeRecipe | null, t: ToolState, g: Ground): void {
    const src = sourceOf(lastR);
    const srcColor = src.r ? src.r.color : toolColor(t);
    const srcNib = src.r ? src.r.stroke.nib : t.nib;
    const srcSize = src.r ? src.r.stroke.size : (t.sizes[t.nib] ?? NIBS[t.nib].S);
    const srcForm = src.r ? src.r.form.form : t.form;
    const srcBase = src.r ? src.r.form.base : (t.base[t.form] ?? FORMS[t.form].baseDefault);
    let nib = srcNib, size = srcSize, form = srcForm, base = srcBase, color = srcColor, trueSize = false, erase = false;
    let bare = false;
    let optKey: string;
    switch (opt.k) {
      case 'nib':
        // the nib's own mark at true size: your stroke as a bare nib (depth 0 of any Form), so
        // growth never crowds or crops what this tile is about
        nib = opt.nib; size = t.sizes[opt.nib] ?? NIBS[opt.nib].S; trueSize = true; bare = true;
        form = 'line'; base = 0;
        optKey = `nib:${nib}:${size}`;
        break;
      case 'erase':
        erase = true; optKey = 'erase';
        break;
      case 'ink':
        color = inkColor(opt.ink, opt.custom, t);
        optKey = `ink:${colorKey(color)}`;
        break;
      case 'form':
        form = opt.form; base = t.base[opt.form] ?? FORMS[opt.form].baseDefault;
        optKey = `form:${form}:${base}`;
        break;
    }
    const colKey = colorKey(color);
    const key = `tile:${src.key}:${optKey}:${colKey}:${nib}:${size}:${form}:${base}:${g}`;
    cached(canvas, key, (ctx, W, H, dpr) => {
      const cw = W / dpr, ch = H / dpr;
      const margin = Math.max(4, Math.min(cw, ch) * 0.08);
      const wNib = trueSize ? size * (nib === 'chisel' ? 1 : 1.2) : 0;
      // nib tiles: the stroke fits at true size; others leave room for growth, then fit
      const fitW = trueSize ? Math.max(8, cw - 2 * margin - wNib) : cw * 1.05;
      const fitH = trueSize ? Math.max(6, ch - 2 * margin - wNib) : ch * 0.9;
      const gkey = `g:${src.key}:${nib}:${size}:${form}:${base}:${trueSize ? 'T' : 'F'}:${Math.round(fitW)}x${Math.round(fitH)}`;
      const e = geom(gkey, () => {
        const s = src.r ? tileSpace(src.r, fitW, fitH, 'glyph:tile') : baseRecipe('glyph:tile', stockSamples(fitW, fitH * 0.8), nib, size, form, base, color);
        const pools = bare ? new Float32Array(0) : s.pools;
        return { ...s, pools, stroke: { nib, size }, form: { form, v: CURRENT_V[form] ?? 1, base }, color };
      });
      if (!e) return;
      const r = { ...e.r, color };
      const b = cookedBox(e.c);
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      // true size unless the mark would still not fit (then the least shrink that fits)
      const scale = trueSize ? fitScale(b, W, H, dpr, margin * 0.5, 1) : fitScale(b, W, H, dpr, margin, 1.6);
      drawCentered(ctx, r, e.c, g, W, H, dpr, [cx, cy], scale, erase ? 0.3 : 1);
      if (erase) {
        const tok = GROUND_TOKENS[g];
        const R = Math.min(W, H) * 0.24;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = g === 'night' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = tok.accent;
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  // ------------------------------------------------------------------ thumbnails

  function thumb(canvas: HTMLCanvasElement, recipes: readonly StrokeRecipe[], g: Ground): void {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || !(W > 0 && H > 0)) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    paintGround(ctx, W, H, g);
    if (!recipes.length) return;
    const sc = deps.scene ? deps.scene() : null;
    const geomFor = (r: StrokeRecipe): Cooked | undefined => {
      if (!sc) return undefined;
      const ext = sc as Scene & { cookedFor?(x: StrokeRecipe): Cooked | undefined };
      return ext.cookedFor ? ext.cookedFor(r) : undefined;
    };
    // content box from samples (cheap, conservative by the nib size)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of recipes) {
      const s = r.samples, n = (s.length / S.STRIDE) | 0, z = r.z > 0 ? r.z : 1, pad = (r.stroke.size || 4) / z;
      for (let i = 0; i < n; i++) {
        const x = r.origin[0] + s[i * S.STRIDE + S.X], y = r.origin[1] + s[i * S.STRIDE + S.Y];
        if (!(x === x && y === y)) continue;
        if (x - pad < x0) x0 = x - pad; if (x + pad > x1) x1 = x + pad;
        if (y - pad < y0) y0 = y - pad; if (y + pad > y1) y1 = y + pad;
      }
    }
    if (!(x1 > x0 && y1 > y0)) return;
    const mw = (x1 - x0) * 0.08, mh = (y1 - y0) * 0.08;
    x0 -= mw; x1 += mw; y0 -= mh; y1 += mh;
    const px = Math.min(W / (x1 - x0), H / (y1 - y0));
    const cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;
    const box: AABB = { x0: cxm - W / 2 / px, y0: cym - H / 2 / px, x1: cxm + W / 2 / px, y1: cym + H / 2 / px };
    const clip: AABB = { x0: 0, y0: 0, x1: W, y1: H };
    const t0 = now();
    for (const r of recipes) {
      let c = geomFor(r);
      if (!c && now() - t0 < THUMB_BUDGET_MS) {
        try { c = cookFn(r, THUMB_STROKE_PTS); } catch { c = undefined; }
      }
      if (c) { drawInk(ctx, c, inkTableFor(r, g), regionMatrix(r.origin, box, px), r.form.form, { clipDev: clip }); continue; }
      // over budget: the bare spine in the stroke's colour
      const table = inkTableFor(r, g);
      const s = r.samples, n = (s.length / S.STRIDE) | 0;
      if (n < 1) continue;
      ctx.save();
      ctx.globalCompositeOperation = table.op;
      ctx.globalAlpha = table.alphaMax;
      ctx.strokeStyle = table.css[toneIndex(table, 20, 0)];
      ctx.lineWidth = Math.max(0.75, (r.stroke.size / (r.z > 0 ? r.z : 1)) * px * 0.8);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const X = (r.origin[0] + s[i * S.STRIDE + S.X] - box.x0) * px, Y = (r.origin[1] + s[i * S.STRIDE + S.Y] - box.y0) * px;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  return {
    chip(canvas, which, tool, ground, erase) {
      if (which === 'stroke') { if (erase) chipErase(canvas, ground); else chipStroke(canvas, tool, ground); }
      else if (which === 'color') chipColor(canvas, tool, ground);
      else chipForm(canvas, tool, ground);
    },
    tile,
    thumb,
    clear() {
      for (const c of rasters.values()) freeCanvas(c);
      rasters.clear();
      geoms.clear();
    },
    get cached() { return { rasters: rasters.size, geoms: geoms.size }; },
  };
}
