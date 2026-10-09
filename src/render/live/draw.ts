/**
 * Live-layer drawing through render-core: drawInk (Paper's per-generation alpha), the trunk's
 * hot window in 12 sp chunks (drawHot), and the soft halo glow.
 */
import type { AABB, Cooked, FormId, InkTable, Mat2x3 } from '../../core/types';
import { toneIndex } from '../../ink/color';
import { echoPaperExposure, paperAlphaScale } from '../../ink/operators/registry';
import { ALPHA_LEVELS, Batcher, MODE_FILL, MODE_HAIR, alphaBucket, exactKey } from '../batch';
import { drawCooked, type DrawOpts } from '../raster';
import { toothLevel, toothSolid } from '../../ink/tooth';
import { drawToothBatch, growDevBox, type TraceBatch } from '../tooth';
import { traceCentre, tracePoly, type TraceOpts } from '../tessellate';
import { HOT_CHUNK, hotEta, windowEdge, type ArcClock } from './timing';
import { IntList, type PolyState, gf64, gi32 } from './polys';

/** A 2D context the live layer draws into. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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
export function dopts(clip: AABB | null): DrawOpts {
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
export interface HotView {
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
export function drawHot(ctx: Ctx2D, c: Cooked, list: Int32Array, nList: number, table: InkTable, m: Mat2x3,
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
    if (clip && !boxHitsDev(from && S.mv[i] < 1 ? S.mbox : c.box, i, m, clip)) continue;
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
  // charcoal batches go through the tooth (render/tooth.ts), exactly as drawCooked draws them
  let cur = 0;
  const traceTooth: TraceBatch | null = table.tooth
    ? (cx, mm, ws) => { o.widthScale = ws; return traceRanges(cx, c, plan, cur, mm, false, S, from); }
    : null;
  for (let k = 0; k < plan.n; k++) {
    const ga = plan.alpha[k] * aMul, css = plan.css[k], hair = plan.mode[k] === MODE_HAIR;
    if (traceTooth && !hair) {
      HOT_BOX.x0 = Infinity; HOT_BOX.y0 = Infinity; HOT_BOX.x1 = -Infinity; HOT_BOX.y1 = -Infinity;
      for (let e = plan.first[k], end = e + plan.count[k]; e < end; e++) {
        const i = rgPoly[hotBatcher.poly[plan.order[e]]];
        growDevBox(HOT_BOX, from && S.mv[i] < 1 ? S.mbox : c.box, i, m);
      }
      cur = k;
      drawToothBatch(ctx, table, css, m, ga < 1 ? ga : 1, HOT_BOX, clip, traceTooth);
      continue;
    }
    ctx.globalAlpha = ga < 1 ? ga : 1;
    if (!traceRanges(ctx, c, plan, k, m, hair, S, from)) continue;
    if (hair) {
      ctx.strokeStyle = table.css[css];
      ctx.lineWidth = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (table.tooth) ctx.globalAlpha *= toothSolid(toothLevel(css), table.tooth.smudge);
      ctx.stroke();
    } else {
      ctx.fillStyle = table.css[css];
      ctx.fill('nonzero');
    }
  }
  ctx.restore();
  o.arcFrom = undefined; o.arcTo = undefined; o.reveal = undefined; o.morphFrom = null; o.morphT = undefined; o.widthScale = undefined;
}

const HOT_BOX: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Build hot batch k's path: its ranges, cut and revealed as recorded (centrelines for a hairline batch). */
function traceRanges(ctx: Ctx2D, c: Cooked, plan: Batcher['plan'], k: number, m: Mat2x3, hair: boolean, S: PolyState, from: Float32Array | null): boolean {
  const o = HOPTS;
  ctx.beginPath();
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
  return any;
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
export function drawGlow(ctx: Ctx2D, x: number, y: number, r: number, a: number, css: string, op: GlobalCompositeOperation): void {
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
