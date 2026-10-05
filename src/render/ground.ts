/**
 * Grounds (DESIGN §6.1): painted in CSS on #ground, never on a canvas; a canvas copy is painted
 * only for export.
 *  - Night: radial gradient oklch(.165 .012 265) at the centre → .135 at the corners, an
 *    elliptical vignette from 55 % radius, and a static 128² hash-noise grain (±1.2 % L) that
 *    dithers away 8-bit banding. The grain is generated once into a data URL, repeats anchored to
 *    the screen at one grain pixel per device pixel, and is never animated.
 *  - Paper: oklch(.955 .012 85) warm cotton with a corner vignette of −0.02 L. Decision: Paper
 *    also gets a finer, fainter grain so its slow vignette cannot band either.
 * The grain is mid-grey noise blended with `overlay`, which shifts dark and light grounds by a
 * similar ±1–2 levels; the export painter uses the same tile with the same composite op.
 */
import type { Ground } from '../core/types';
import { lchToRgb255 } from '../core/oklab';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const GRAIN = 128;
/** Grain amplitude in 8-bit grey around 128 (overlay blend). */
const GRAIN_AMP: Record<Ground, number> = { night: 15, paper: 10 };

interface GroundSpec {
  base: string;          // solid fallback / background-color
  inner: string;         // radial gradient centre
  outer: string;         // radial gradient corners
  vignette: string;      // colour at the vignette rim
  vignetteClear: string; // the same colour at alpha 0 (CSS interpolates premultiplied, canvas does
                         // not: fading from transparent BLACK would darken the canvas copy)
  vignetteFrom: number;  // 0..1 radius where the vignette starts
}

const rgb = (L: number, C: number, h: number): [number, number, number] => lchToRgb255([L, C, h]);
const css = (c: [number, number, number], a = 1): string => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

const SPECS: Record<Ground, GroundSpec> = {
  night: {
    base: css(rgb(0.165, 0.012, 265)),
    inner: css(rgb(0.165, 0.012, 265)),
    outer: css(rgb(0.135, 0.012, 265)),
    vignette: css(rgb(0.07, 0.012, 265), 0.42),
    vignetteClear: css(rgb(0.07, 0.012, 265), 0),
    vignetteFrom: 0.55,
  },
  paper: {
    base: css(rgb(0.955, 0.012, 85)),
    inner: css(rgb(0.955, 0.012, 85)),
    outer: css(rgb(0.948, 0.013, 82)),
    // corner = the .948 gradient rim under this rim colour at 8.5 %: L .936, i.e. −0.02 L (§6.1)
    vignette: css(rgb(0.80, 0.03, 75), 0.085),
    vignetteClear: css(rgb(0.80, 0.03, 75), 0),
    vignetteFrom: 0.5,
  },
};

/** Hash → [0,1) (deterministic grain; integer avalanche). */
function hash01(x: number, y: number, s: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b9);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Grain RGBA pixels: triangular-PDF noise around mid grey, opaque. */
function grainPixels(g: Ground): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(GRAIN * GRAIN * 4);
  const amp = GRAIN_AMP[g];
  for (let y = 0; y < GRAIN; y++) {
    for (let x = 0; x < GRAIN; x++) {
      const v = 128 + Math.round((hash01(x, y, 1) + hash01(x, y, 2) - 1) * amp);
      const i = (y * GRAIN + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }
  return px;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
const grainCanvas: Partial<Record<Ground, AnyCanvas>> = {};
const grainUrl: Partial<Record<Ground, string>> = {};

function makeCanvas(w: number, h: number): AnyCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function grainTile(g: Ground): AnyCanvas | null {
  const have = grainCanvas[g];
  if (have) return have;
  const c = makeCanvas(GRAIN, GRAIN);
  if (!c) return null;
  const ctx = c.getContext('2d') as Ctx2D | null;
  if (!ctx) return null;
  ctx.putImageData(new ImageData(grainPixels(g), GRAIN, GRAIN), 0, 0);
  grainCanvas[g] = c;
  return c;
}

/** The grain tile as a PNG data URL (generated once per ground). Empty string outside the DOM. */
export function grainDataUrl(g: Ground): string {
  const have = grainUrl[g];
  if (have !== undefined) return have;
  const c = grainTile(g);
  const url = c && 'toDataURL' in c ? c.toDataURL('image/png') : '';
  grainUrl[g] = url;
  return url;
}

/** CSS background declarations for a ground (layers top → bottom: grain, vignette, gradient). */
export function groundStyle(g: Ground, dpr = 1): { backgroundColor: string; backgroundImage: string; backgroundSize: string; backgroundBlendMode: string; backgroundRepeat: string; backgroundPosition: string } {
  const s = SPECS[g];
  const url = grainDataUrl(g);
  const grainPx = GRAIN / Math.max(1, dpr);
  const vig = `radial-gradient(ellipse farthest-corner at 50% 50%, ${s.vignetteClear} ${Math.round(s.vignetteFrom * 100)}%, ${s.vignette} 100%)`;
  const grad = `radial-gradient(circle farthest-corner at 50% 50%, ${s.inner} 0%, ${s.outer} 100%)`;
  const layers = url ? [`url("${url}")`, vig, grad] : [vig, grad];
  return {
    backgroundColor: s.base,
    backgroundImage: layers.join(', '),
    backgroundSize: url ? `${grainPx}px ${grainPx}px, 100% 100%, 100% 100%` : '100% 100%, 100% 100%',
    backgroundBlendMode: url ? 'overlay, normal, normal' : 'normal, normal',
    backgroundRepeat: url ? 'repeat, no-repeat, no-repeat' : 'no-repeat, no-repeat',
    backgroundPosition: url ? '0 0, 50% 50%, 50% 50%' : '50% 50%, 50% 50%',
  };
}

const LAYER_CLASS = 'rise-ground-layer';
const FADE_MS = 400;
interface GroundState { layers: Record<Ground, HTMLDivElement>; current: Ground | null; timer: number }
const states = new WeakMap<HTMLElement, GroundState>();

function styleLayer(d: HTMLDivElement, g: Ground): void {
  const st = groundStyle(g, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const s = d.style;
  s.position = 'absolute'; s.left = '0'; s.top = '0'; s.right = '0'; s.bottom = '0';
  s.pointerEvents = 'none';
  s.backgroundColor = st.backgroundColor;
  s.backgroundImage = st.backgroundImage;
  s.backgroundSize = st.backgroundSize;
  s.backgroundBlendMode = st.backgroundBlendMode;
  s.backgroundRepeat = st.backgroundRepeat;
  s.backgroundPosition = st.backgroundPosition;
}

/**
 * Paint ground g on `el` with CSS (gradient + vignette + dither grain). With `animate`, the new
 * ground fades in over the old one in 400 ms (a true cross-fade: the old layer stays opaque
 * beneath until the fade ends, so nothing dips through). Re-applying refreshes the grain scale
 * for the current devicePixelRatio. Sets `data-ground` on el.
 */
export function applyGround(el: HTMLElement, g: Ground, animate: boolean): void {
  let st = states.get(el);
  if (!st) {
    const mk = (gg: Ground): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = LAYER_CLASS;
      d.dataset.ground = gg;
      d.setAttribute('aria-hidden', 'true');
      d.style.opacity = '0';
      d.style.visibility = 'hidden';
      el.insertBefore(d, el.firstChild);
      return d;
    };
    st = { layers: { night: mk('night'), paper: mk('paper') }, current: null, timer: 0 };
    states.set(el, st);
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    // own stacking context: the layers' z-index must never escape above the ink canvases
    el.style.isolation = 'isolate';
  }
  const top = st.layers[g], other = st.layers[g === 'night' ? 'paper' : 'night'];
  styleLayer(top, g);
  el.dataset.ground = g;
  el.style.backgroundColor = SPECS[g].base;
  if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
  const fade = animate && st.current !== null && st.current !== g;
  st.current = g;
  top.style.zIndex = '1'; other.style.zIndex = '0';
  top.style.visibility = 'visible';
  if (!fade) {
    top.style.transition = 'none'; top.style.opacity = '1';
    other.style.transition = 'none'; other.style.opacity = '0'; other.style.visibility = 'hidden';
    return;
  }
  other.style.transition = 'none'; other.style.opacity = '1'; other.style.visibility = 'visible';
  top.style.transition = 'none'; top.style.opacity = '0';
  void top.offsetWidth;                                   // commit the start state before fading
  top.style.transition = `opacity ${FADE_MS}ms cubic-bezier(.2,.8,.2,1)`;
  top.style.opacity = '1';
  const s = st;
  st.timer = window.setTimeout(() => {
    s.timer = 0;
    if (s.current === g) { other.style.opacity = '0'; other.style.visibility = 'hidden'; }
  }, FADE_MS + 40);
}

/**
 * Canvas copy of ground g for export: the same gradient, vignette and grain as the CSS ground,
 * filling w × h device px. Leaves the context state as it found it.
 */
export function paintGround(ctx: Ctx2D, w: number, h: number, g: Ground): void {
  const s = SPECS[g];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const cx = w / 2, cy = h / 2, R = Math.sqrt(cx * cx + cy * cy);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grad.addColorStop(0, s.inner);
  grad.addColorStop(1, s.outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // CSS "ellipse farthest-corner": the closest-side aspect (w:h) scaled to pass through a corner
  if (w > 0 && h > 0) {
    const rx = cx * Math.SQRT2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, h / w);
    const vg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    vg.addColorStop(0, s.vignetteClear);
    vg.addColorStop(s.vignetteFrom, s.vignetteClear);
    vg.addColorStop(1, s.vignette);
    ctx.fillStyle = vg;
    ctx.fillRect(-cx, -cx, w, w);
    ctx.restore();
  }
  const tile = grainTile(g);
  if (tile) {
    const pat = ctx.createPattern(tile as CanvasImageSource, 'repeat');
    if (pat) {
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.restore();
}
