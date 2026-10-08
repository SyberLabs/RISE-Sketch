/**
 * The overlay (DESIGN §4 feedback list, §2.2.2 latency, §6.2 layer 5): the nib cursor (true
 * width and shape in the ink colour; Chisel is an oriented bar that follows the azimuth), the
 * predicted tail and tip of the live stroke, the closure weld ring, the lasso, the eraser ring
 * with its doom mask, the selection's dashed bounds and 1 px outline, the size ring, and the
 * symmetry guide (a 15 % hairline axis for Mirror, or one spoke per fold, through the centre).
 * None of it is ever interactive.
 *
 * Latency: every call draws at once (the canvas is `desynchronized`), inside dirty rects of the
 * element's old and new extents, so a cursor move repaints two small squares. frame() expires
 * the predicted tail one frame after it was drawn, runs the weld ring's fade-in and the size
 * ring's fade-out, and repaints doc-anchored feedback (selection, doom mask) when the camera
 * moves. Device pixel ratio is capped at 2 (DESIGN §6.9).
 *
 * Decisions:
 *  - Feedback colours: the cursor, size ring and predicted tail use the caller's ink colour; the
 *    lasso and selection use the ground's accent; the eraser ring is neutral (ground text). Every
 *    ring sits on a soft ground-coloured backing so it reads over bright or dark ink alike.
 *  - Doom mask: the doomed strokes' own outlines (one union path) filled with the ground colour at
 *    α 0.75, plus a 1 px edge so hairline growth is covered too.
 *  - Selection outline: the union of the selected ink stroked 5 px wide, then the ink and a 1.5 px
 *    band around it cut away (destination-out), leaving a 1 CSS px ring 1.5 px off the ink: no seams
 *    at chunk joints, and it never merges with ink of a similar hue.
 *  - Outlines and the doom mask stop after 400k traced points per repaint (huge selections show
 *    their bounds and as much outline as fits).
 *  - The predicted tail is drawn as a bare spine at 50 % alpha with a round tip. Its first point
 *    is where the ink already ends, so the ink's round tip (a disc of half the width there) is
 *    clipped out: the spine continues the ink instead of veiling it. Input already caps
 *    prediction at 16 ms / 24 sp; the overlay caps it again (24 CSS px past the last real point,
 *    16 ms past the last real sample time) and never extrapolates.
 *  - Animations begun between frames (weld fade-in, size-ring fade-out) start on the next
 *    frame's timestamp, so they run on the frame loop's clock whatever calls them.
 */
import type { AABB, Camera, Cooked, Ground, InputSample, StrokeId, Vec2 } from '../core/types';
import { GROUND_TOKENS } from '../ink/color';
import { easeOutCubic } from '../core/num';
import { tracePoly, type TraceOpts } from './tessellate';
import { RectList } from './live';
import type { NibCursor, OverlayHost, OverlayInternal } from './types';

type Ctx2D = CanvasRenderingContext2D;

/** Overlay device pixel ratio cap (DESIGN §6.2). */
export const OVERLAY_MAX_DPR = 2;
/** Prediction caps (DESIGN §2.2.2): ms past the last real sample and CSS px of path. */
export const PRED_MAX_MS = 16, PRED_MAX_PX = 24;
/** Weld ring fade-in and size ring fade-out (ms). */
const WELD_IN_MS = 140, RING_OUT_MS = 160;
/** Gap (CSS px) between the selected ink and its 1 px outline. */
const OUTLINE_GAP = 1.5;
/** Points traced per repaint for outlines and the doom mask. */
const TRACE_BUDGET = 400_000;
const TAU = 6.283185307179586;

/** Copy of a predicted path after the caps: interleaved CSS px. */
export interface CappedPath { n: number; xy: Float64Array }

/**
 * Cap a predicted tail: every real (non-predicted) sample is kept; predicted samples follow
 * until 24 CSS px of path past the last real point or 16 ms past the last real sample time
 * (the last segment is cut exactly at the arc cap). Writes into `out`; returns the point count.
 */
export function capPrediction(tail: readonly InputSample[], out: CappedPath): number {
  let n = 0;
  const need = 2 * tail.length;
  if (out.xy.length < need) out.xy = new Float64Array(Math.max(need, 2 * out.xy.length));
  const xy = out.xy;
  let lastRealT = NaN, arc = 0, predicting = false;
  for (let k = 0; k < tail.length; k++) {
    const s = tail[k];
    if (!(s.x === s.x && s.y === s.y)) continue;
    if (!s.predicted) {
      if (predicting) break;           // real samples after predicted ones: ignore the rest
      xy[2 * n] = s.x; xy[2 * n + 1] = s.y; n++;
      if (s.t === s.t) lastRealT = s.t;
      continue;
    }
    predicting = true;
    if (lastRealT === lastRealT && s.t === s.t && s.t - lastRealT > PRED_MAX_MS) break;
    if (n === 0) { xy[0] = s.x; xy[1] = s.y; n = 1; continue; }
    const px = xy[2 * n - 2], py = xy[2 * n - 1];
    const d = Math.sqrt((s.x - px) * (s.x - px) + (s.y - py) * (s.y - py));
    if (arc + d > PRED_MAX_PX) {
      const f = d > 0 ? (PRED_MAX_PX - arc) / d : 0;
      if (f > 0) { xy[2 * n] = px + (s.x - px) * f; xy[2 * n + 1] = py + (s.y - py) * f; n++; }
      break;
    }
    arc += d;
    xy[2 * n] = s.x; xy[2 * n + 1] = s.y; n++;
  }
  out.n = n;
  return n;
}

/** A stroke resolved for outline drawing. */
interface Resolved { c: Cooked; ox: number; oy: number }

/**
 * Build the overlay on the renderer's #overlay canvas. Draws immediately on every call; frame()
 * handles expiry, small animations and camera moves. Returns true from frame() while it needs
 * another frame.
 */
export function createOverlay(host: OverlayHost): OverlayInternal {
  const canvas = host.canvas;
  let ctx: Ctx2D | null = null;
  const getCtx = (): Ctx2D | null => {
    if (!ctx) ctx = canvas.getContext('2d', { desynchronized: true }) as Ctx2D | null;
    return ctx;
  };
  let dpr = 1;
  let W = host.viewport().w, H = host.viewport().h;   // CSS px
  let now = 0;
  const dirty = new RectList(10, 6);
  const clip: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const tmp: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const cullBox: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const m = new Float64Array(6);
  const topts: TraceOpts = { minDevWidth: 0 };
  let cam: Camera = { ...host.camera() };
  let ground: Ground = host.ground();

  // ---- element state (CSS px unless noted)
  const cur = { on: false, x: 0, y: 0, kind: 'brush' as NibCursor['kind'], w: 0, angle: 0, css: '#ffffff' };
  const weld = { on: false, x: 0, y: 0, r: 0, t0: -Infinity };
  const lasso: CappedPath & { on: boolean } = { on: false, n: 0, xy: new Float64Array(256) };
  const er = { on: false, x: 0, y: 0, r: 0 };
  let doomIds: StrokeId[] = [];
  const doom: Resolved[] = [];
  const doomBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };       // device px
  const sel = { on: false, box: { x0: 0, y0: 0, x1: -1, y1: -1 } as AABB };
  let selIds: StrokeId[] = [];
  const selRes: Resolved[] = [];
  const selBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };        // device px (bounds + outlines)
  const ring = { on: false, x: 0, y: 0, w: 0, css: '#ffffff', hideT0: Infinity };
  const pred: CappedPath & { on: boolean; w: number; css: string; age: number } = { on: false, n: 0, xy: new Float64Array(64), w: 1, css: '#ffffff', age: 0 };
  const guide = { on: false, folds: 2, cx: 0, cy: 0 };
  let lastInk = '';
  const widthCache = new WeakMap<Cooked, number>();

  const tokens = (): (typeof GROUND_TOKENS)['night'] => GROUND_TOKENS[ground];

  // ---- rects (device px)
  function addCss(x0: number, y0: number, x1: number, y1: number): void {
    dirty.add(x0 * dpr - 2, y0 * dpr - 2, x1 * dpr + 2, y1 * dpr + 2);
  }
  function cursorExtent(): number { return Math.max(cur.w * 0.5, 2.5) + 5; }
  function dirtyCursor(): void { if (cur.on) { const e = cursorExtent(); addCss(cur.x - e, cur.y - e, cur.x + e, cur.y + e); } }
  function dirtyWeld(): void { if (weld.on) { const e = weld.r * 1.4 + 4; addCss(weld.x - e, weld.y - e, weld.x + e, weld.y + e); } }
  function dirtyEraser(): void { if (er.on) { const e = er.r + 4; addCss(er.x - e, er.y - e, er.x + e, er.y + e); } }
  function dirtyRing(): void { if (ring.on) { const e = Math.max(ring.w * 0.5, 2.5) + 5; addCss(ring.x - e, ring.y - e, ring.x + e, ring.y + e); } }
  function pathBox(p: CappedPath, pad: number): void {
    if (p.n === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < p.n; k++) {
      const x = p.xy[2 * k], y = p.xy[2 * k + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    addCss(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  }
  function dirtyPred(): void { if (pred.on) pathBox(pred, pred.w * 0.5 + 3); }
  function dirtyLasso(): void { if (lasso.on) pathBox(lasso, 4); }
  function dirtyDev(b: AABB): void { if (b.x1 >= b.x0) dirty.add(b.x0, b.y0, b.x1, b.y1); }

  /** doc-rel-origin -> overlay device px for an origin (rot = 0 fast path, rotation honoured). */
  function matrixFor(ox: number, oy: number): Float64Array {
    const s = cam.scale * dpr, dx = ox - cam.cx, dy = oy - cam.cy;
    let cs = 1, sn = 0;
    if (cam.rot) { cs = Math.cos(cam.rot); sn = Math.sin(cam.rot); }
    m[0] = cs * s; m[1] = sn * s; m[2] = -sn * s; m[3] = cs * s;
    m[4] = m[0] * dx + m[2] * dy + W * 0.5 * dpr;
    m[5] = m[1] * dx + m[3] * dy + H * 0.5 * dpr;
    return m;
  }

  /** Device box of absolute doc box b into out. */
  function docBoxDev(b: AABB, out: AABB, padCss: number): boolean {
    if (!(b.x1 >= b.x0 && b.y1 >= b.y0)) return false;
    const mm = matrixFor(0, 0);
    const xa = mm[0] * b.x0, xb = mm[0] * b.x1, xc = mm[2] * b.y0, xd = mm[2] * b.y1;
    const ya = mm[1] * b.x0, yb = mm[1] * b.x1, yc = mm[3] * b.y0, yd = mm[3] * b.y1;
    const p = padCss * dpr;
    out.x0 = Math.min(xa, xb) + Math.min(xc, xd) + mm[4] - p; out.x1 = Math.max(xa, xb) + Math.max(xc, xd) + mm[4] + p;
    out.y0 = Math.min(ya, yb) + Math.min(yc, yd) + mm[5] - p; out.y1 = Math.max(ya, yb) + Math.max(yc, yd) + mm[5] + p;
    return true;
  }

  function resolve(ids: readonly StrokeId[], out: Resolved[], box: AABB, padCss: number): void {
    out.length = 0;
    box.x0 = Infinity; box.y0 = Infinity; box.x1 = -Infinity; box.y1 = -Infinity;
    for (const id of ids) {
      const c = host.scene.cooked(id), r = host.doc.get(id);
      if (!c || !r) continue;
      out.push({ c, ox: r.origin[0], oy: r.origin[1] });
      // plus the miter overshoot of the stroke's widest ink (≤ 0.08 × width, raster.ts boxHits)
      if (docBoxDev(c.inkBox, tmp, padCss + 0.08 * maxWidthCss(c))) {
        if (tmp.x0 < box.x0) box.x0 = tmp.x0; if (tmp.y0 < box.y0) box.y0 = tmp.y0;
        if (tmp.x1 > box.x1) box.x1 = tmp.x1; if (tmp.y1 > box.y1) box.y1 = tmp.y1;
      }
    }
  }

  /** Widest ink of a stroke in CSS px at the current zoom (cached per Cooked). */
  function maxWidthCss(c: Cooked): number {
    let w = widthCache.get(c);
    if (w === undefined) {
      w = 0;
      for (let j = 0; j < c.nPts; j++) if (c.pts[4 * j + 2] > w) w = c.pts[4 * j + 2];
      widthCache.set(c, w);
    }
    return w * cam.scale;
  }

  function selectionDevBox(): void {
    resolve(selIds, selRes, selBox, OUTLINE_GAP + 1 + 4);
    if (sel.on && docBoxDev(sel.box, tmp, 8)) {
      if (tmp.x0 < selBox.x0) selBox.x0 = tmp.x0; if (tmp.y0 < selBox.y0) selBox.y0 = tmp.y0;
      if (tmp.x1 > selBox.x1) selBox.x1 = tmp.x1; if (tmp.y1 > selBox.y1) selBox.y1 = tmp.y1;
    }
  }

  // ---- drawing (device transform set per element)
  /**
   * Trace every poly of the resolved strokes whose box, padded by `pad` device px (what the
   * element draws beyond the ink), touches the clip into the current path.
   */
  function traceInk(c2: Ctx2D, list: readonly Resolved[], budget: number, pad: number): number {
    for (const s of list) {
      const c = s.c;
      // whole strokes first: a cursor-sized repaint over a big selection touches few of them
      if (docBoxDev(c.inkBox, cullBox, 0)) {
        const p = pad + 0.08 * maxWidthCss(c) * dpr + 1;
        if (cullBox.x1 + p < clip.x0 || cullBox.x0 - p > clip.x1 || cullBox.y1 + p < clip.y0 || cullBox.y0 - p > clip.y1) continue;
      }
      const mm = matrixFor(s.ox, s.oy), b = c.box;
      for (let i = 0; i < c.nPolys && budget > 0; i++) {
        const x0 = b[4 * i], y0 = b[4 * i + 1], x1 = b[4 * i + 2], y1 = b[4 * i + 3];
        const xa = mm[0] * x0, xb = mm[0] * x1, xc = mm[2] * y0, xd = mm[2] * y1;
        const ya = mm[1] * x0, yb = mm[1] * x1, yc = mm[3] * y0, yd = mm[3] * y1;
        const X0 = Math.min(xa, xb) + Math.min(xc, xd) + mm[4], X1 = Math.max(xa, xb) + Math.max(xc, xd) + mm[4];
        const Y0 = Math.min(ya, yb) + Math.min(yc, yd) + mm[5], Y1 = Math.max(ya, yb) + Math.max(yc, yd) + mm[5];
        // a miter reaches 0.08 × the box's smaller side past it (raster.ts boxHits)
        const p = pad + 0.08 * Math.min(X1 - X0, Y1 - Y0);
        if (X1 + p < clip.x0 || X0 - p > clip.x1 || Y1 + p < clip.y0 || Y0 - p > clip.y1) continue;
        if (tracePoly(c2, c, i, mm, topts)) budget -= c.count[i];
      }
      if (budget <= 0) break;
    }
    return budget;
  }

  function drawSelection(c2: Ctx2D): void {
    const t = tokens();
    c2.setTransform(1, 0, 0, 1, 0, 0);
    if (selRes.length > 0) {
      // a 1 px ring OUTLINE_GAP px off the ink: stroke (gap + 1) px each side, then cut away the
      // ink and the gap, so the ring never merges with ink of a similar hue
      c2.beginPath();
      traceInk(c2, selRes, TRACE_BUDGET, (OUTLINE_GAP + 1) * dpr + 2);
      c2.globalAlpha = 0.95;
      c2.strokeStyle = t.accent;
      c2.lineWidth = 2 * (OUTLINE_GAP + 1) * dpr;
      c2.lineJoin = 'round';
      c2.setLineDash([]);
      c2.stroke();
      c2.globalCompositeOperation = 'destination-out';
      c2.globalAlpha = 1;
      c2.fill('nonzero');
      c2.lineWidth = 2 * OUTLINE_GAP * dpr;
      c2.stroke();
      c2.globalCompositeOperation = 'source-over';
    }
    if (sel.on && docBoxDev(sel.box, tmp, 6)) {
      const x0 = Math.round(tmp.x0) + 0.5, y0 = Math.round(tmp.y0) + 0.5;
      const x1 = Math.round(tmp.x1) - 0.5, y1 = Math.round(tmp.y1) - 0.5;
      c2.lineWidth = Math.max(1, Math.round(dpr));
      c2.setLineDash([4 * dpr, 3 * dpr]);
      c2.globalAlpha = 0.5;
      c2.strokeStyle = t.bg;
      c2.lineDashOffset = 0;
      c2.strokeRect(x0 + 1, y0 + 1, x1 - x0, y1 - y0);
      c2.globalAlpha = 0.9;
      c2.strokeStyle = t.accent;
      c2.strokeRect(x0, y0, x1 - x0, y1 - y0);
      c2.setLineDash([]);
    }
  }

  function drawDoom(c2: Ctx2D): void {
    if (doom.length === 0) return;
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.beginPath();
    traceInk(c2, doom, TRACE_BUDGET, 2);
    c2.globalAlpha = 0.75;
    c2.fillStyle = tokens().bg;
    c2.fill('nonzero');
    c2.strokeStyle = tokens().bg;
    c2.lineWidth = 1;
    c2.lineJoin = 'round';
    c2.stroke();
  }

  /** A ring on a soft backing so it reads over any ink. */
  function ringAt(c2: Ctx2D, x: number, y: number, r: number, css: string, alpha: number, lw: number): void {
    const t = tokens();
    c2.beginPath();
    c2.arc(x, y, r, 0, TAU);
    c2.globalAlpha = 0.45 * alpha;
    c2.strokeStyle = t.bg;
    c2.lineWidth = lw + 2;
    c2.stroke();
    c2.globalAlpha = alpha;
    c2.strokeStyle = css;
    c2.lineWidth = lw;
    c2.stroke();
  }

  function drawLasso(c2: Ctx2D): void {
    const n = lasso.n;
    if (n < 2) return;
    const t = tokens(), xy = lasso.xy;
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.beginPath();
    c2.moveTo(xy[0], xy[1]);
    for (let k = 1; k < n; k++) c2.lineTo(xy[2 * k], xy[2 * k + 1]);
    c2.closePath();
    c2.globalAlpha = 0.07;
    c2.fillStyle = t.accent;
    c2.fill('nonzero');
    c2.beginPath();
    c2.moveTo(xy[0], xy[1]);
    for (let k = 1; k < n; k++) c2.lineTo(xy[2 * k], xy[2 * k + 1]);
    c2.lineJoin = 'round'; c2.lineCap = 'round';
    c2.setLineDash([5, 4]);
    c2.globalAlpha = 0.45; c2.strokeStyle = t.bg; c2.lineWidth = 3; c2.stroke();
    c2.globalAlpha = 0.95; c2.strokeStyle = t.accent; c2.lineWidth = 1.25; c2.stroke();
    // the closing chord, quieter
    c2.beginPath();
    c2.moveTo(xy[2 * n - 2], xy[2 * n - 1]);
    c2.lineTo(xy[0], xy[1]);
    c2.globalAlpha = 0.4; c2.stroke();
    c2.setLineDash([]);
  }

  function drawEraser(c2: Ctx2D): void {
    if (!er.on) return;
    const t = tokens();
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.beginPath();
    c2.arc(er.x, er.y, er.r, 0, TAU);
    c2.globalAlpha = 0.06; c2.fillStyle = t.text; c2.fill();
    ringAt(c2, er.x, er.y, er.r, t.text, 0.8, 1.5);
  }

  /** Symmetry guide: 1 CSS px at 15 % of the ground's text colour, the whole viewport long. */
  function drawGuide(c2: Ctx2D): void {
    const sx = (guide.cx - cam.cx) * cam.scale + W * 0.5, sy = (guide.cy - cam.cy) * cam.scale + H * 0.5;
    const R = W + H + Math.abs(sx) + Math.abs(sy);
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.globalAlpha = 0.15;
    c2.strokeStyle = tokens().text;
    c2.lineWidth = 1;
    c2.beginPath();
    if (guide.folds === 2) { c2.moveTo(sx, -1); c2.lineTo(sx, H + 1); }
    else {
      for (let i = 0; i < guide.folds; i++) {
        const t = -Math.PI / 2 + (TAU * i) / guide.folds;
        c2.moveTo(sx + 4 * Math.cos(t), sy + 4 * Math.sin(t));
        c2.lineTo(sx + R * Math.cos(t), sy + R * Math.sin(t));
      }
      c2.moveTo(sx + 4, sy);
      c2.arc(sx, sy, 4, 0, TAU);
    }
    c2.stroke();
  }

  function drawWeld(c2: Ctx2D): void {
    if (!weld.on) return;
    const u = weld.t0 === weld.t0 ? easeOutCubic((now - weld.t0) / WELD_IN_MS) : 0;
    const r = weld.r * (1.35 - 0.35 * u);
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ringAt(c2, weld.x, weld.y, r, lastInk || tokens().accent, 0.95 * u, 1.5);
    c2.beginPath();
    c2.arc(weld.x, weld.y, Math.max(1.5, r * 0.18), 0, TAU);
    c2.globalAlpha = 0.9 * u;
    c2.fillStyle = lastInk || tokens().accent;
    c2.fill();
  }

  function drawRing(c2: Ctx2D): void {
    if (!ring.on) return;
    const k = ring.hideT0 === Infinity || ring.hideT0 !== ring.hideT0 ? 1 : 1 - Math.min(1, (now - ring.hideT0) / RING_OUT_MS);
    if (!(k > 0)) return;
    const r = Math.max(ring.w * 0.5, 1.5);
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.beginPath();
    c2.arc(ring.x, ring.y, r, 0, TAU);
    c2.globalAlpha = 0.16 * k; c2.fillStyle = ring.css; c2.fill();
    ringAt(c2, ring.x, ring.y, r, ring.css, 0.95 * k, 1.5);
  }

  function drawPred(c2: Ctx2D): void {
    if (!pred.on || pred.n < 1) return;
    const xy = pred.xy, n = pred.n;
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.globalAlpha = 0.5;
    c2.lineCap = 'round'; c2.lineJoin = 'round';
    c2.setLineDash([]);
    if (n === 1) {
      c2.beginPath();
      c2.arc(xy[0], xy[1], pred.w * 0.5, 0, TAU);
      c2.fillStyle = pred.css;
      c2.fill();
      return;
    }
    // the tail starts where the ink ends: keep out of the ink's round tip so the 50 % spine
    // continues it instead of veiling it
    c2.beginPath();
    c2.rect(-1, -1, W + 2, H + 2);
    c2.arc(xy[0], xy[1], pred.w * 0.5, 0, TAU);
    c2.clip('evenodd');
    c2.beginPath();
    c2.moveTo(xy[0], xy[1]);
    for (let k = 1; k < n; k++) c2.lineTo(xy[2 * k], xy[2 * k + 1]);
    c2.strokeStyle = pred.css;
    c2.lineWidth = pred.w;
    c2.stroke();
  }

  function drawCursor(c2: Ctx2D): void {
    if (!cur.on) return;
    const t = tokens();
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cur.kind === 'erase') {
      ringAt(c2, cur.x, cur.y, Math.max(cur.w * 0.5, 2), t.text, 0.8, 1.5);
      return;
    }
    if (cur.kind === 'chisel') {
      // the broad edge: an oriented bar E long and about the core thick
      const L = Math.max(cur.w, 3), th = Math.max(2, 0.14 * L);
      const cs = Math.cos(cur.angle), sn = Math.sin(cur.angle);
      c2.translate(cur.x, cur.y);
      c2.transform(cs, sn, -sn, cs, 0, 0);
      c2.globalAlpha = 0.5; c2.fillStyle = t.bg;
      c2.fillRect(-L / 2 - 1, -th / 2 - 1, L + 2, th + 2);
      c2.globalAlpha = 0.92; c2.fillStyle = cur.css;
      c2.fillRect(-L / 2, -th / 2, L, th);
      return;
    }
    const r = Math.max(cur.w * 0.5, 1.5);
    c2.beginPath();
    c2.arc(cur.x, cur.y, r, 0, TAU);
    c2.globalAlpha = 0.14; c2.fillStyle = cur.css; c2.fill();
    ringAt(c2, cur.x, cur.y, Math.max(r, 2.5), cur.css, 0.95, 1.25);
    if (cur.w < 5) {
      c2.beginPath();
      c2.arc(cur.x, cur.y, 0.9, 0, TAU);
      c2.globalAlpha = 1; c2.fillStyle = cur.css; c2.fill();
    }
  }

  // ---- repaint
  function flush(): void {
    if (dirty.empty) return;
    const c2 = getCtx();
    const cw = canvas.width, ch = canvas.height;
    if (!c2 || !(cw > 0 && ch > 0)) { dirty.clear(); return; }
    c2.save();
    c2.setTransform(1, 0, 0, 1, 0, 0);
    if (dirty.full) {
      clip.x0 = 0; clip.y0 = 0; clip.x1 = cw; clip.y1 = ch;
      c2.clearRect(0, 0, cw, ch);
    } else {
      dirty.clampTo(cw, ch);
      if (!dirty.bbox(clip)) { c2.restore(); dirty.clear(); return; }
      c2.beginPath();
      for (let k = 0; k < dirty.n; k++) {
        const o = 4 * k;
        c2.rect(dirty.r[o], dirty.r[o + 1], dirty.r[o + 2] - dirty.r[o], dirty.r[o + 3] - dirty.r[o + 1]);
      }
      c2.clip();
      c2.clearRect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
    }
    dirty.clear();
    c2.globalCompositeOperation = 'source-over';
    c2.globalAlpha = 1;
    // bottom to top: the guide, outlines (their interior is cut away), then everything else
    if (guide.on) { c2.save(); drawGuide(c2); c2.restore(); }
    if ((sel.on || selRes.length > 0) && hits(selBox)) { c2.save(); drawSelection(c2); c2.restore(); }
    if (doom.length > 0 && hits(doomBox)) { c2.save(); drawDoom(c2); c2.restore(); }
    if (lasso.on) { c2.save(); drawLasso(c2); c2.restore(); }
    if (weld.on) { c2.save(); drawWeld(c2); c2.restore(); }
    if (ring.on) { c2.save(); drawRing(c2); c2.restore(); }
    if (pred.on) { c2.save(); drawPred(c2); c2.restore(); }
    if (er.on) { c2.save(); drawEraser(c2); c2.restore(); }
    if (cur.on) { c2.save(); drawCursor(c2); c2.restore(); }
    c2.restore();
  }

  function hits(b: AABB): boolean {
    return b.x1 >= b.x0 && b.x0 <= clip.x1 && b.x1 >= clip.x0 && b.y0 <= clip.y1 && b.y1 >= clip.y0;
  }

  const sameIds = (a: readonly StrokeId[], b: readonly StrokeId[]): boolean => {
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    return true;
  };

  const overlay: OverlayInternal = {
    cursor(p: Vec2 | null, shape: NibCursor | null): void {
      dirtyCursor();
      if (!p || !shape) cur.on = false;
      else {
        cur.on = true; cur.x = p[0]; cur.y = p[1];
        cur.kind = shape.kind; cur.w = shape.wCss > 0 ? shape.wCss : 0; cur.angle = shape.angle; cur.css = shape.css;
        if (shape.kind !== 'erase' && shape.css) lastInk = shape.css;
        dirtyCursor();
      }
      flush();
    },
    weld(p: Vec2 | null, rCss: number): void {
      dirtyWeld();
      if (!p) weld.on = false;
      else {
        if (!weld.on) weld.t0 = NaN;
        weld.on = true; weld.x = p[0]; weld.y = p[1]; weld.r = rCss > 0 ? rCss : 6;
        dirtyWeld();
        host.requestFrame();
      }
      flush();
    },
    lasso(path: Float64Array | null): void {
      dirtyLasso();
      if (!path || path.length < 4) { lasso.on = false; lasso.n = 0; }
      else {
        const n = path.length >> 1;
        if (lasso.xy.length < 2 * n) lasso.xy = new Float64Array(Math.max(2 * n, 2 * lasso.xy.length));
        lasso.xy.set(path.subarray(0, 2 * n));
        lasso.n = n; lasso.on = true;
        dirtyLasso();
      }
      flush();
    },
    eraser(p: Vec2 | null, rCss: number, doomed: readonly StrokeId[]): void {
      dirtyEraser();
      if (!p) er.on = false;
      else { er.on = true; er.x = p[0]; er.y = p[1]; er.r = rCss > 0 ? rCss : 16; dirtyEraser(); }
      const ids = p ? doomed : [];
      if (!sameIds(ids, doomIds)) {
        dirtyDev(doomBox);
        doomIds = ids.slice();
        resolve(doomIds, doom, doomBox, 4);
        dirtyDev(doomBox);
      }
      flush();
    },
    selection(box: AABB | null, ids: readonly StrokeId[]): void {
      dirtyDev(selBox);
      sel.on = box !== null && box.x1 >= box.x0;
      if (box) { sel.box.x0 = box.x0; sel.box.y0 = box.y0; sel.box.x1 = box.x1; sel.box.y1 = box.y1; }
      selIds = box ? ids.slice() : [];
      selectionDevBox();
      dirtyDev(selBox);
      flush();
    },
    sizeRing(p: Vec2 | null, wCss: number, css: string): void {
      dirtyRing();
      if (!p) {
        if (ring.on && ring.hideT0 === Infinity) { ring.hideT0 = NaN; dirtyRing(); host.requestFrame(); }
      } else {
        ring.on = true; ring.x = p[0]; ring.y = p[1]; ring.w = wCss > 0 ? wCss : 0; ring.css = css || lastInk || tokens().accent;
        ring.hideT0 = Infinity;
        dirtyRing();
      }
      flush();
    },
    symmetry(g: { folds: number; cx: number; cy: number } | null): void {
      const on = !!g && g.folds >= 2 && Number.isFinite(g.cx) && Number.isFinite(g.cy);
      if (!on && !guide.on) return;
      if (on && guide.on && g!.folds === guide.folds && g!.cx === guide.cx && g!.cy === guide.cy) return;
      guide.on = on;
      if (on) { guide.folds = g!.folds; guide.cx = g!.cx; guide.cy = g!.cy; }
      dirty.setFull();
      flush();
    },
    clear(): void {
      cur.on = false; weld.on = false; lasso.on = false; lasso.n = 0; er.on = false; ring.on = false; pred.on = false;
      sel.on = false; selIds = []; selRes.length = 0; doomIds = []; doom.length = 0;
      selBox.x1 = -1; selBox.x0 = 0; doomBox.x1 = -1; doomBox.x0 = 0;
      dirty.setFull();
      flush();
    },
    predicted(tail: readonly InputSample[] | null, wCss: number, css: string): void {
      dirtyPred();
      if (!tail || capPrediction(tail, pred) < 1) pred.on = false;
      else {
        pred.on = true; pred.w = wCss > 0 ? wCss : 1; pred.css = css || lastInk || tokens().accent; pred.age = 0;
        if (css) lastInk = css;
        dirtyPred();
        host.requestFrame();
      }
      flush();
    },
    frame(t: number): boolean {
      now = t;
      let busy = false;
      // camera / ground: doc-anchored feedback follows
      const c = host.camera(), g = host.ground();
      if (g !== ground) { ground = g; dirty.setFull(); }
      if (c.cx !== cam.cx || c.cy !== cam.cy || c.scale !== cam.scale || c.rot !== cam.rot) {
        const docAnchored = sel.on || selRes.length > 0 || doom.length > 0;
        if (guide.on) dirty.setFull();
        if (docAnchored) { dirtyDev(selBox); dirtyDev(doomBox); }
        cam = { cx: c.cx, cy: c.cy, scale: c.scale, rot: c.rot };
        if (docAnchored) {
          selectionDevBox();
          resolve(doomIds, doom, doomBox, 4);
          dirtyDev(selBox); dirtyDev(doomBox);
        }
      }
      // the predicted tail lives for one frame after it was drawn
      if (pred.on) {
        if (pred.age >= 1) { dirtyPred(); pred.on = false; }
        else { pred.age++; busy = true; }
      }
      // animations begun between frames start on this frame's clock
      if (weld.on && weld.t0 !== weld.t0) weld.t0 = t;
      if (ring.on && ring.hideT0 !== ring.hideT0) ring.hideT0 = t;
      if (weld.on && t - weld.t0 < WELD_IN_MS + 20) { dirtyWeld(); busy = true; }
      if (ring.on && ring.hideT0 !== Infinity) {
        dirtyRing();
        if (t - ring.hideT0 >= RING_OUT_MS) ring.on = false; else busy = true;
      }
      flush();
      return busy;
    },
    resize(cssW: number, cssH: number, d: number): void {
      W = cssW; H = cssH;
      dpr = Math.min(OVERLAY_MAX_DPR, d > 0 ? d : 1);
      const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      cam = { ...host.camera() };
      if (sel.on || selRes.length > 0) selectionDevBox();
      if (doom.length > 0) resolve(doomIds, doom, doomBox, 4);
      dirty.setFull();
      flush();
    },
  };

  return overlay;
}
