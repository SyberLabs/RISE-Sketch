/**
 * Rasterising cooked strokes with Canvas2D: batching, ink tables, view matrices and the LOD
 * rules. Spec: docs/DESIGN.md §6.3, §6.4, §6.8, §9 (LOD rules 2–5).
 *
 * drawCooked transforms points itself (Float64 matrix → device px) and draws with an identity
 * context transform, so widths, caps and hairline decisions are true device sizes. Everything a
 * draw needs per poly lives in reused scratch arrays; colour strings come from cached tables.
 */
import type { AABB, Camera, Cooked, Ground, InkTable, Mat2x3, RecipeCore, SampleBuf, Vec2 } from '../core/types';
import { PolyKind } from '../core/types';
import { resolveInk, toneIndex } from '../ink/color';
import { tracePoly, traceCentre, type TraceOpts } from './tessellate';
import { Batcher, MODE_FILL, MODE_HAIR, alphaBucket, exactKey, ALPHA_LEVELS } from './batch';
import { toothFor, toothLevel, toothSolid } from '../ink/tooth';
import { drawToothBatch, growDevBox, type TraceBatch } from './tooth';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Options for drawCooked. All optional. */
export interface DrawOpts {
  alphaScale?: number;
  polys?: ArrayLike<number> | null;           // subset of poly indices (default all)
  reveal?: ((i: number) => number) | null;    // per-poly prefix 0..1
  morph?: { from: Float32Array; t: (i: number) => number } | null;
  hot?: ((i: number) => number) | null;       // per-poly alpha multiplier (hot trail)
  clipDev?: AABB | null;                      // device-px rect; polys whose box misses it are skipped
  lod?: boolean;                              // gen cull, hairline, stroke cull, decimated LODs (default true)
}

const DOT = PolyKind.Dot, CHISEL = PolyKind.Chisel;
/** LOD rule 2: generations whose max(w_device · alpha) is below this are skipped (gen ≥ 1). */
const GEN_CULL = 0.06;
/** LOD rule 5: strokes whose ink box diagonal is below these (device px) become a dot / vanish. */
const CULL_DOT = 3, CULL_SKIP = 0.5;
/** LOD rule 4: use a decimated copy once its tolerance maps to ≤ this many device px. */
const LOD_TOL_DEV = 0.5;
/** Fills fainter than this (final alpha) are skipped: below half an 8-bit level even at full ink. */
const MIN_ALPHA = 1 / 192;

/** Counters of the last drawCooked call (debug HUD, tests). */
export const drawStats = { fills: 0, strokes: 0, polys: 0, culled: 0, lod: 0 };

// ---------------------------------------------------------------------------- scratch

const batcher = new Batcher();
const TOPTS: TraceOpts = { minDevWidth: 0 };
let scap = 0;
let maxW = new Float64Array(0), meanW = new Float64Array(0);
function ensureScratch(n: number): void {
  if (n <= scap) return;
  let c = scap || 256;
  while (c < n) c *= 2;
  maxW = new Float64Array(c); meanW = new Float64Array(c);
  scap = c;
}
const cssWeight = new Float64Array(36 * 30);

/** Max and arc-weighted mean width (doc) of poly i into maxW[i], meanW[i]. */
function widthStats(c: Cooked, i: number): void {
  const p = c.pts, st = c.start[i], n = c.count[i];
  let mx = 0, sw = 0, sl = 0;
  let px = p[4 * st], py = p[4 * st + 1], pw = p[4 * st + 2];
  mx = pw;
  for (let j = 1; j < n; j++) {
    const b = 4 * (st + j);
    const x = p[b], y = p[b + 1], w = p[b + 2];
    if (w > mx) mx = w;
    const dx = x - px, dy = y - py, L = Math.sqrt(dx * dx + dy * dy);
    sw += (w + pw) * 0.5 * L; sl += L;
    px = x; py = y; pw = w;
  }
  maxW[i] = mx;
  meanW[i] = sl > 0 ? sw / sl : mx;
}

// ---------------------------------------------------------------------------- matrices

/**
 * doc-rel-origin -> device px matrix for a camera, viewport (CSS px) and dpr. The offset
 * (origin − camera centre) is formed in Float64 before scaling, so ink far from the document
 * origin does not jitter. Rotation (P1) turns about the viewport centre; rot = 0 uses no trig.
 */
export function viewMatrix(origin: Vec2, cam: Camera, cssW: number, cssH: number, dpr: number): Mat2x3 {
  const s = cam.scale * dpr;
  const ox = origin[0] - cam.cx, oy = origin[1] - cam.cy;
  let cs = 1, sn = 0;
  if (cam.rot) { cs = Math.cos(cam.rot); sn = Math.sin(cam.rot); }
  const a = cs * s, b = sn * s, c = -sn * s, d = cs * s;
  return Float64Array.of(a, b, c, d, a * ox + c * oy + cssW * 0.5 * dpr, b * ox + d * oy + cssH * 0.5 * dpr);
}

/** Matrix for an arbitrary raster target: doc box origin (box.x0, box.y0) at (0,0), pxPerDoc scale. */
export function regionMatrix(origin: Vec2, box: AABB, pxPerDoc: number): Mat2x3 {
  return Float64Array.of(pxPerDoc, 0, 0, pxPerDoc, (origin[0] - box.x0) * pxPerDoc, (origin[1] - box.y0) * pxPerDoc);
}

// ---------------------------------------------------------------------------- ink tables

const tableByObject = new WeakMap<object, [InkTable | null, InkTable | null]>();

/**
 * Cached ink table for a stroke-like object on ground g. Recipes are immutable (a restyle makes a
 * new object with a bumped colorRev), so caching per object is equivalent to the spec's
 * id:colorRev:ground key and costs no key string per frame; resolveInk's own content cache shares
 * one table between objects with equal colours (and serves objects without an id).
 */
export function inkTableFor(r: RecipeCore & { id?: string; colorRev?: number; samples: Float32Array | SampleBuf }, g: Ground): InkTable {
  let e = tableByObject.get(r);
  if (!e) { e = [null, null]; tableByObject.set(r, e); }
  const k = g === 'night' ? 0 : 1;
  if (e[k]) return e[k];
  // charcoal draws its colours through the paper tooth (DESIGN §6.4): the shared table plus its tooth
  const t = resolveInk(r.color, g), tooth = toothFor(r);
  return (e[k] = tooth ? { ...t, tooth } : t);
}

// ---------------------------------------------------------------------------- decimated LODs

/**
 * Per-Cooked derived data, built lazily: commit scale, per-generation max(w·alpha) (gen cull) and
 * the decimated copies. Validated by (pts buffer, nPts, nPolys) so a live Cooked that grew is
 * re-derived.
 */
interface LodEntry { pts: Float32Array; nPts: number; nPolys: number; z: number; genWA: Float64Array | null; lod1: Cooked | null; lod4: Cooked | null }
const lodCache = new WeakMap<Cooked, LodEntry>();

function lodEntry(c: Cooked): LodEntry {
  let e = lodCache.get(c);
  if (!e || e.pts !== c.pts || e.nPts !== c.nPts || e.nPolys !== c.nPolys) {
    e = { pts: c.pts, nPts: c.nPts, nPolys: c.nPolys, z: estimateZ(c), genWA: null, lod1: null, lod4: null };
    lodCache.set(c, e);
  }
  return e;
}

/**
 * max(w·alpha) per generation over the WHOLE stroke (doc units), so the generation cull is a
 * property of the stroke at a scale and never differs between neighbouring tiles or subsets.
 */
function genWA(c: Cooked): Float64Array {
  const e = lodEntry(c);
  if (e.genWA) return e.genWA;
  const n = Math.max(1, c.genStart.length - 1);
  const out = new Float64Array(n);
  const p = c.pts;
  for (let i = 0; i < c.nPolys; i++) {
    const g = c.gen[i];
    if (g >= n) continue;
    let mx = 0;
    for (let j = c.start[i], end = j + c.count[i]; j < end; j++) if (p[4 * j + 2] > mx) mx = p[4 * j + 2];
    const v = mx * c.alpha[i];
    if (v > out[g]) out[g] = v;
  }
  e.genWA = out;
  return out;
}

/** Arc `a` is in sp and positions in doc, so their ratio is the commit scale z. */
function estimateZ(c: Cooked): number {
  let sa = 0, sd = 0, used = 0;
  for (let i = 0; i < c.nPolys && used < 8; i++) {
    const st = c.start[i], n = c.count[i];
    if (n < 2 || c.kind[i] === DOT) continue;
    let d = 0;
    for (let j = 1; j < n; j++) {
      const b = 4 * (st + j);
      const dx = c.pts[b] - c.pts[b - 4], dy = c.pts[b + 1] - c.pts[b - 3];
      d += Math.sqrt(dx * dx + dy * dy);
    }
    const a = c.pts[4 * (st + n - 1) + 3] - c.pts[4 * st + 3];
    if (d > 0 && a > 0) { sa += a; sd += d; used++; }
  }
  return sd > 0 ? sa / sd : 0;
}

/** Commit scale z (sp per doc unit) of a cooked stroke, estimated from its arc column; 0 if unknown. */
export function commitScale(c: Cooked): number {
  return lodEntry(c).z;
}

/**
 * Decimated copy of a cooked stroke for drawing far below its commit scale (LOD rule 4): every
 * poly keeps its index and attributes, its points are RDP-simplified at `tolSp` (position, half
 * width and chisel edge all within tolerance), arcs are kept exact so reveals still work. Built
 * lazily and cached per Cooked object (rebuilt if a live Cooked changed size).
 */
export function lodFor(c: Cooked, tolSp: 1 | 4): Cooked {
  const e = lodEntry(c);
  if (!(e.z > 0)) return c;
  if (tolSp === 1) return e.lod1 ?? (e.lod1 = decimate(c, 1 / e.z));
  return e.lod4 ?? (e.lod4 = decimate(c, 4 / e.z));
}

/** Bytes held by the decimated copies of c (count them with the Cooked entry). */
export function lodBytes(c: Cooked): number {
  const e = lodCache.get(c);
  return e ? (e.lod1 ? e.lod1.bytes : 0) + (e.lod4 ? e.lod4.bytes : 0) : 0;
}

function decimate(c: Cooked, eps: number): Cooked {
  const keep = new Uint8Array(c.nPts);
  const stack: number[] = [];
  const p = c.pts, ang = c.ang;
  for (let i = 0; i < c.nPolys; i++) {
    const st = c.start[i], n = c.count[i];
    if (n <= 2 || c.kind[i] === DOT) { for (let j = 0; j < n; j++) keep[st + j] = 1; continue; }
    keep[st] = 1; keep[st + n - 1] = 1;
    stack.length = 0;
    stack.push(st, st + n - 1);
    while (stack.length) {
      const b = stack.pop()!, a = stack.pop()!;
      const ax = p[4 * a], ay = p[4 * a + 1], aw = p[4 * a + 2], bx = p[4 * b], by = p[4 * b + 1], bw = p[4 * b + 2];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let best = -1, bd = eps;
      for (let k = a + 1; k < b; k++) {
        const px = p[4 * k], py = p[4 * k + 1];
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - px, qy = ay + dy * t - py;
        let err = Math.sqrt(qx * qx + qy * qy);
        const we = Math.abs(0.5 * (p[4 * k + 2] - (aw + (bw - aw) * t)));
        if (we > err) err = we;
        if (ang && c.kind[i] === CHISEL) {
          const ae = Math.abs(angleBetween(ang[k], ang[a] + angleBetween(ang[a], ang[b]) * t)) * 0.5 * p[4 * k + 2];
          if (ae > err) err = ae;
        }
        if (err > bd) { bd = err; best = k; }
      }
      if (best >= 0) { keep[best] = 1; stack.push(a, best, best, b); }
    }
  }
  let nPts = 0;
  for (let j = 0; j < c.nPts; j++) nPts += keep[j];
  const pts = new Float32Array(nPts * 4);
  const angOut = ang ? new Float32Array(nPts) : null;
  const start = new Uint32Array(c.nPolys), count = new Uint32Array(c.nPolys);
  let w = 0;
  for (let i = 0; i < c.nPolys; i++) {
    const st = c.start[i], n = c.count[i];
    start[i] = w;
    for (let j = st; j < st + n; j++) {
      if (!keep[j]) continue;
      pts[4 * w] = p[4 * j]; pts[4 * w + 1] = p[4 * j + 1]; pts[4 * w + 2] = p[4 * j + 2]; pts[4 * w + 3] = p[4 * j + 3];
      if (angOut && ang) angOut[w] = ang[j];
      w++;
    }
    count[i] = w - start[i];
  }
  return {
    ...c, pts, ang: angOut, start, count, nPts,
    bytes: pts.byteLength + (angOut ? angOut.byteLength : 0) + start.byteLength + count.byteLength,
  };
}

function angleBetween(a: number, b: number): number {
  let d = (b - a) % 6.283185307179586;
  if (d > 3.141592653589793) d -= 6.283185307179586;
  else if (d <= -3.141592653589793) d += 6.283185307179586;
  return d;
}

// ---------------------------------------------------------------------------- drawing

/**
 * Draw one cooked stroke: batches by (css, alpha bucket), Bézier edges, LOD rules. ctx composite
 * op is set from the table (inside save/restore; the context transform is identity while drawing).
 * `m` maps doc-rel-origin to device px of ctx (viewMatrix / regionMatrix); `clipDev` is in those
 * device px. The `polys`, `reveal`, `morph.t` and `hot` callbacks see poly indices of `c` (kept by
 * the decimated LODs too) and should be cheap: they may be called more than once per poly.
 *
 * LOD decisions (stroke cull, decimated copy, generation cull, hairline) depend only on the stroke
 * and the scale of `m`, never on the clip or subset, so tiles, live layers and exports agree.
 *
 * Chunk welding under reveal: a chunk is welded to its predecessor only once that one is fully
 * revealed, and to its successor only once that one has started, so growing tips stay round.
 *
 * Batching note: overlaps union only within one call. Drawing the same stroke's polys across
 * several calls (subsets) adds where same-batch polys overlap; callers that must match a whole-
 * stroke raster (live → tile hand-off) should draw a stroke's overlapping polys in one call.
 *
 * Alpha: the poly's design alpha (× the hairline / dot-area factor) is what gets bucketed; the
 * ground's alphaMax and `alphaScale` are then applied exactly at fill time. So Paper never exceeds
 * its 0.85 safety alpha (DESIGN §2.4.2), a fade through `alphaScale` is continuous instead of
 * stepping through the buckets, and the batching of a stroke never depends on alphaScale.
 *
 * Hot ink: a poly with hot(i) ≠ 1 draws at its bucketed alpha × hot(i) exactly (continuous, so the
 * trail cools smoothly and lands exactly on the committed alpha). On Night an alpha above 1 is
 * drawn as a second additive pass, so the fresh trail really burns brighter than the cured ink;
 * on Paper it is clamped to the ground's alphaMax.
 */
export function drawCooked(ctx: Ctx2D, c: Cooked, table: InkTable, m: Mat2x3, o?: DrawOpts): void {
  drawStats.fills = 0; drawStats.strokes = 0; drawStats.polys = 0; drawStats.culled = 0; drawStats.lod = 0;
  const nP = c.nPolys;
  if (nP === 0) return;
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (!(sc > 0)) return;
  const lod = !o || o.lod !== false;
  const alphaScale = o && o.alphaScale !== undefined ? o.alphaScale : 1;
  const morph = o && o.morph ? o.morph : null;
  const reveal = o && o.reveal ? o.reveal : null;
  const hot = o && o.hot ? o.hot : null;
  const subset = o && o.polys ? o.polys : null;
  const clip = o && o.clipDev ? o.clipDev : null;
  const aMul = table.alphaMax * alphaScale;
  if (!(aMul > 0)) return;
  const lighter = table.op === 'lighter';
  /** Highest alpha one fill may use: 1 for light, alphaMax (Paper safety) for pigment. */
  const aCap = lighter ? 1 : table.alphaMax;

  // LOD rule 5: stroke cull
  if (lod) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const bx = c.box;
    for (let i = 0; i < nP; i++) {
      if (bx[4 * i] < x0) x0 = bx[4 * i]; if (bx[4 * i + 1] < y0) y0 = bx[4 * i + 1];
      if (bx[4 * i + 2] > x1) x1 = bx[4 * i + 2]; if (bx[4 * i + 3] > y1) y1 = bx[4 * i + 3];
    }
    const diag = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) * sc;
    if (!(diag >= CULL_SKIP)) { drawStats.culled = nP; return; }
    if (diag < CULL_DOT) {
      cullDot(ctx, c, table, m, sc, aMul, aCap, (x0 + x1) * 0.5, (y0 + y1) * 0.5, diag, clip, subset, reveal, hot);
      return;
    }
  }

  // LOD rule 4: decimated copies (not while morphing: `from` is aligned with full-res points)
  let src = c;
  if (lod && !morph) {
    const z = commitScale(c);
    if (z > 0) {
      const devPerSp = sc / z;
      if (4 * devPerSp <= LOD_TOL_DEV) { src = lodFor(c, 4); drawStats.lod = 4; }
      else if (devPerSp <= LOD_TOL_DEV) { src = lodFor(c, 1); drawStats.lod = 1; }
    }
  }

  ensureScratch(nP);
  const gwa = lod ? genWA(c) : null;
  const nGen = gwa ? gwa.length : 0;
  const total = subset ? subset.length : nP;

  // pass 1: clip and width stats
  for (let q = 0; q < total; q++) {
    const i = subset ? subset[q] : q;
    if (i < 0 || i >= nP) continue;
    if (src.count[i] === 0) { maxW[i] = -1; continue; }
    if (clip && !boxHits(c.box, i, m, clip)) { maxW[i] = -1; continue; }
    widthStats(src, i);
  }

  // pass 2: classify into batches (alpha keys are relative to aMul; see the doc comment)
  batcher.reset();
  // the generation cull is a property of the stroke at this scale: alphaScale (a fade) is excluded
  const cullMul = sc * table.alphaMax;
  const relCap = aCap / aMul;
  for (let q = 0; q < total; q++) {
    const i = subset ? subset[q] : q;
    if (i < 0 || i >= nP || maxW[i] < 0) continue;
    const g = c.gen[i];
    if (gwa && g > 0 && g < nGen && gwa[g] * cullMul < GEN_CULL) { drawStats.culled++; continue; }
    let a = c.alpha[i];
    let mode = MODE_FILL;
    const wDev = maxW[i] * sc;
    const dotLike = src.kind[i] === DOT || src.count[i] === 1;
    if (lod && wDev < 1) {
      if (dotLike) a *= wDev * wDev;            // area ratio: drawn at a 1 px disc
      else { mode = MODE_HAIR; a *= meanW[i] * sc; }
    }
    const kb = alphaBucket(a);
    if (kb < 0 || a * aMul < MIN_ALPHA) { drawStats.culled++; continue; }
    const css = toneIndex(table, c.tone[i], c.born[i]);
    const h = hot ? hot(i) : 1;
    if (h === 1 || !(h >= 0)) batcher.add(i, css, kb, mode);
    else {
      const ah = ALPHA_LEVELS[kb] * h;          // relative to aMul
      if (lighter && ah * aMul > 1) {
        // one full additive pass plus the remainder: the trail really is brighter than alpha 1
        batcher.add(i, css, aMul === 1 ? 7 : exactKey(1 / aMul), mode);
        batcher.add(i, css, exactKey(Math.min(1, ah * aMul - 1) / aMul), mode);
      } else if (ah * aMul >= MIN_ALPHA) batcher.add(i, css, exactKey(Math.min(ah, relCap)), mode);
    }
  }
  if (batcher.n === 0) return;
  const plan = batcher.build(table.spectral);

  // draw
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = table.op;
  const topts = TOPTS;
  topts.morphFrom = morph ? morph.from : null;
  // charcoal batches go through the tooth (render/tooth.ts), which traces the batch itself
  let cur = 0;
  const traceTooth: TraceBatch | null = table.tooth
    ? (cx, mm, ws) => { topts.widthScale = ws; return tracePlan(cx, src, cur, plan, mm, nP, false, reveal, morph, lod); }
    : null;
  for (let b = 0; b < plan.n; b++) {
    const css = plan.css[b], hair = plan.mode[b] === MODE_HAIR;
    // never above 1 (Canvas2D ignores out-of-range alpha and would keep the previous batch's)
    const ga = Math.min(plan.alpha[b] * aMul, aCap);
    if (traceTooth && !hair) {
      batchBox(c, b, plan, m);
      cur = b;
      drawToothBatch(ctx, table, css, m, ga, BOX, clip, traceTooth);
      drawStats.fills++;
      continue;
    }
    if (!tracePlan(ctx, src, b, plan, m, nP, hair, reveal, morph, lod)) continue;
    if (hair) {
      ctx.strokeStyle = table.css[css]; ctx.lineWidth = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalAlpha = table.tooth ? ga * toothSolid(toothLevel(css), table.tooth.smudge) : ga;
      ctx.stroke(); drawStats.strokes++;
    } else {
      ctx.fillStyle = table.css[css];
      ctx.globalAlpha = ga;
      ctx.fill('nonzero'); drawStats.fills++;
    }
  }
  ctx.restore();
  topts.morphFrom = null; topts.reveal = undefined; topts.morphT = undefined; topts.joinStart = true; topts.joinEnd = true;
  topts.widthScale = undefined;
}

/** Device box of batch b's polys (into BOX). */
const BOX: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
function batchBox(c: Cooked, b: number, plan: Batcher['plan'], m: Mat2x3): void {
  BOX.x0 = Infinity; BOX.y0 = Infinity; BOX.x1 = -Infinity; BOX.y1 = -Infinity;
  for (let e = plan.first[b], end = e + plan.count[b]; e < end; e++) growDevBox(BOX, c.box, batcher.poly[plan.order[e]], m);
}

/** Build batch b's path (its polys, or their centrelines for a hairline batch); false when nothing was traced. */
function tracePlan(ctx: Ctx2D, src: Cooked, b: number, plan: Batcher['plan'], m: Mat2x3, nP: number, hair: boolean,
  reveal: ((i: number) => number) | null, morph: DrawOpts['morph'] | null, lod: boolean): boolean {
  const topts = TOPTS;
  ctx.beginPath();
  let any = false;
  for (let e = plan.first[b], end = e + plan.count[b]; e < end; e++) {
    const i = batcher.poly[plan.order[e]];
    topts.reveal = reveal ? reveal(i) : undefined;
    // weld a chunk to its neighbour only while that neighbour is drawn up to the shared point,
    // and (under a morph) only while both sit at the same morph t, so the shared edge agrees
    const mt = morph ? morph.t(i) : 1;
    topts.joinStart = (!reveal || i === 0 || reveal(i - 1) >= 1) && (!morph || i === 0 || morph.t(i - 1) === mt);
    topts.joinEnd = (!reveal || i + 1 >= nP || reveal(i + 1) > 0) && (!morph || i + 1 >= nP || morph.t(i + 1) === mt);
    topts.morphT = morph ? mt : undefined;
    topts.minDevWidth = lod && (src.kind[i] === DOT || src.count[i] === 1) ? 1 : 0;
    if (hair ? traceCentre(ctx, src, i, m, topts) : tracePoly(ctx, src, i, m, topts)) { any = true; drawStats.polys++; }
  }
  return any;
}

/**
 * Does poly i's box (doc rel. origin) mapped by m touch the device rect? The box holds the points
 * ± w/2, but a miter vertex reaches up to 1.155·w/2 from its point (turns ≤ 60°), so the test is
 * padded by 0.08 × the box's smaller side (≥ 0.08·w ≥ the miter overshoot) plus 1 px for
 * antialiasing and 1 px hairlines; otherwise a thick corner beside a tile seam would lose a sliver.
 */
function boxHits(box: Float32Array, i: number, m: Mat2x3, clip: AABB): boolean {
  const bx0 = box[4 * i], by0 = box[4 * i + 1], bx1 = box[4 * i + 2], by1 = box[4 * i + 3];
  let dx0: number, dx1: number, dy0: number, dy1: number;
  if (m[1] === 0 && m[2] === 0) {
    const ax = m[0] * bx0 + m[4], bxx = m[0] * bx1 + m[4], ay = m[3] * by0 + m[5], byy = m[3] * by1 + m[5];
    dx0 = Math.min(ax, bxx); dx1 = Math.max(ax, bxx); dy0 = Math.min(ay, byy); dy1 = Math.max(ay, byy);
  } else {
    const xa = m[0] * bx0, xb = m[0] * bx1, xc = m[2] * by0, xd = m[2] * by1;
    const ya = m[1] * bx0, yb = m[1] * bx1, yc = m[3] * by0, yd = m[3] * by1;
    dx0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4]; dx1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
    dy0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5]; dy1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  }
  const pad = 0.08 * Math.min(dx1 - dx0, dy1 - dy0) + 1;
  return dx1 + pad >= clip.x0 && dx0 - pad <= clip.x1 && dy1 + pad >= clip.y0 && dy0 - pad <= clip.y1;
}

/**
 * LOD rule 5: a stroke smaller than 3 device px is one disc in its dominant colour, area-matched
 * to its ink (so a far-away crowd of strokes keeps its overall weight instead of sparkling). Size
 * and colour come from the whole stroke; the alpha counts only the drawn part (subset × reveal ×
 * hot), so a stroke split across calls (dry / wet, a growing stroke) sums to one dot, not two.
 */
function cullDot(ctx: Ctx2D, c: Cooked, table: InkTable, m: Mat2x3, sc: number, aMul: number, aCap: number,
  bx: number, by: number, diag: number, clip: AABB | null, subset: ArrayLike<number> | null,
  reveal: ((i: number) => number) | null, hot: ((i: number) => number) | null): void {
  const X = m[0] * bx + m[2] * by + m[4], Y = m[1] * bx + m[3] * by + m[5];
  if (clip && (X < clip.x0 - 2 || X > clip.x1 + 2 || Y < clip.y0 - 2 || Y > clip.y1 + 2)) return;
  ensureScratch(c.nPolys);
  let area = 0, best = -1, bestW = 0;
  const p = c.pts;
  const touched = table.css.length <= cssWeight.length;
  for (let i = 0; i < c.nPolys; i++) {
    const st = c.start[i], n = c.count[i];
    let ai = 0;
    if (n === 1 || c.kind[i] === DOT) { const w = p[4 * st + 2]; ai = 0.7854 * w * w; }
    else {
      for (let j = 1; j < n; j++) {
        const b = 4 * (st + j);
        const dx = p[b] - p[b - 4], dy = p[b + 1] - p[b - 3];
        ai += 0.5 * (p[b + 2] + p[b - 2]) * Math.sqrt(dx * dx + dy * dy);
      }
    }
    meanW[i] = ai;                                   // scratch: this poly's ink area
    area += ai;
    if (touched) {
      const k = toneIndex(table, c.tone[i], c.born[i]);
      cssWeight[k] += ai * c.alpha[i];
      if (cssWeight[k] > bestW) { bestW = cssWeight[k]; best = k; }
    }
  }
  if (touched) for (let i = 0; i < c.nPolys; i++) cssWeight[toneIndex(table, c.tone[i], c.born[i])] = 0;
  if (!(area > 0)) return;
  let wa = 0;
  const total = subset ? subset.length : c.nPolys;
  for (let q = 0; q < total; q++) {
    const i = subset ? subset[q] : q;
    if (i < 0 || i >= c.nPolys) continue;
    let f = reveal ? reveal(i) : 1;
    f = f > 0 ? (f < 1 ? f : 1) : 0;
    if (hot) { const h = hot(i); if (h >= 0) f *= h; }
    wa += meanW[i] * c.alpha[i] * f;
  }
  const areaDev = area * sc * sc;
  const r = Math.max(0.5, Math.min(diag * 0.5, Math.sqrt(areaDev / Math.PI)));
  let a = Math.min(1, areaDev / (Math.PI * r * r)) * (wa / area) * aMul;
  if (table.tooth && best >= 0) a *= toothSolid(toothLevel(best), table.tooth.smudge);
  if (!(a >= MIN_ALPHA)) return;
  if (a > aCap) a = aCap;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = table.op;
  ctx.globalAlpha = a;
  ctx.fillStyle = table.css[best >= 0 ? best : 0];
  ctx.beginPath();
  ctx.arc(X, Y, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
  drawStats.fills = 1;
}
