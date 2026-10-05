/**
 * The layer stack and its compositing (DESIGN §6.2). Inside the renderer root, bottom to top:
 *
 *   #ground    div      CSS ground (render/ground.ts)                        —
 *   #snap      canvas   cold-load snapshot under the tiles (only while used)  normal
 *   #base      canvas   committed tiles under the camera                      plus-lighter | multiply
 *   #baseFade  canvas   frozen #base during a cross-fade (only while used)    blend of its ground
 *   #bloomA/B  canvas   ¼-res Night bloom, double-buffered (render/bloom.ts)  plus-lighter
 *   #dry       canvas   settled live ink, baking strokes, lifted selection    as #base
 *   #wet       canvas   unsettled tail, hot window, halo, animations          as #base
 *   #overlay   canvas   cursor, lasso, eraser, selection ({ desynchronized })  normal
 *
 * Every layer is `pointer-events: none`; input binds to the root. The root is its own stacking
 * context (isolation), so the blend modes mix with the ground only.
 *
 * Fallback (no CSS plus-lighter, Night only): #dry, #wet and the bloom are hidden and #base is
 * rebuilt each live frame as ground + tiles + bloom + dry + wet with the same canvas ops. Best
 * effort, as the spec allows; Paper's multiply is supported everywhere.
 */
import type { AABB, Camera, Ground } from '../core/types';
import { applyGround, paintGround } from './ground';
import type { CanvasLedgerExt } from './ledger';

/** CSS blend of the ink layers on a ground. */
export function blendFor(g: Ground): string {
  return g === 'night' ? 'plus-lighter' : 'multiply';
}

/** Canvas composite op of the ink on a ground. */
export function opFor(g: Ground): GlobalCompositeOperation {
  return g === 'night' ? 'lighter' : 'multiply';
}

/** Viewport device-pixel cap (DESIGN §6.9). */
export const MAX_VIEWPORT_PX = 8e6;

/** Effective DPR: min(dpr, 3), further capped so the viewport stays ≤ 8 MP of device pixels. */
export function capDpr(dpr: number, cssW: number, cssH: number): number {
  let d = dpr > 0 && Number.isFinite(dpr) ? Math.min(dpr, 3) : 1;
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  if (area * d * d > MAX_VIEWPORT_PX) d = Math.sqrt(MAX_VIEWPORT_PX / area);
  return d;
}

/**
 * Doc extent of a saved snapshot image taken with camera `cam`. The image is assumed to cover the
 * whole viewport it was taken from; that viewport's CSS size is not stored, so it is taken to be
 * the current one when the aspect ratios agree (or agree rotated), else the current viewport
 * fitted to the image's aspect.
 */
export function snapshotDocBox(imgW: number, imgH: number, cam: Camera, cssW: number, cssH: number): AABB {
  const ia = imgW / Math.max(1, imgH), va = cssW / Math.max(1, cssH);
  let w0: number, h0: number;
  if (Math.abs(ia / va - 1) < 0.03) { w0 = cssW; h0 = cssH; }
  else if (Math.abs(ia * va - 1) < 0.03) { w0 = cssH; h0 = cssW; }
  else if (ia > va) { w0 = cssW; h0 = cssW / ia; }
  else { h0 = cssH; w0 = cssH * ia; }
  const hw = w0 * 0.5 / cam.scale, hh = h0 * 0.5 / cam.scale;
  return { x0: cam.cx - hw, y0: cam.cy - hh, x1: cam.cx + hw, y1: cam.cy + hh };
}

/** Selection dimming of #base and the bloom (DESIGN §6.2). */
export const DIM = 0.45;
/** Dim / un-dim transition (chrome timing, DESIGN §4). */
export const DIM_MS = 160;

/** True when CSS `mix-blend-mode: plus-lighter` is available (else the blit fallback is used). */
export function supportsPlusLighter(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('mix-blend-mode', 'plus-lighter');
  } catch {
    return false;
  }
}

export interface Compositor {
  readonly root: HTMLElement;
  readonly ground: HTMLDivElement;
  readonly base: HTMLCanvasElement;
  readonly bloomA: HTMLCanvasElement;
  readonly bloomB: HTMLCanvasElement;
  readonly dry: HTMLCanvasElement;
  readonly wet: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  /** True when Night live layers are blitted into #base (no CSS plus-lighter). */
  readonly fallback: boolean;
  /** Fallback is active right now (fallback && Night). */
  readonly blitting: boolean;
  /** Backing-store size of the viewport layers, device px. */
  readonly W: number;
  readonly H: number;
  /** Resize #base / #dry / #wet (device px) and keep CSS at the viewport. Returns true if changed. */
  resize(cssW: number, cssH: number, dpr: number): boolean;
  /** Blend modes for a ground and the CSS ground itself. */
  setGround(g: Ground, animate: boolean): void;
  /**
   * Re-composite #base. `drawTiles` blits the tiles into the context it is given (identity
   * transform, replace semantics). In fallback mode the result is layered over a painted ground
   * with the bloom and the live layers.
   */
  composite(drawTiles: (ctx: CanvasRenderingContext2D) => void, bloom: HTMLCanvasElement | null, bloomAlpha: number): void;
  /** Rebuild #base from the last tile composite plus the live layers (fallback mode only). */
  recomposeLive(bloom: HTMLCanvasElement | null, bloomAlpha: number): void;
  /**
   * The canvas holding exactly the composited tiles (the bloom's source): #base normally; in
   * fallback mode #base also holds the painted ground, the bloom and the live layers, so the
   * separate tile composite is returned instead (blooming those would lift the ground and feed the
   * bloom back into itself).
   */
  readonly inkSource: HTMLCanvasElement;
  setDim(on: boolean, animate: boolean): void;
  /** Jump a running dim / un-dim transition to its end state. */
  finishDim(): void;
  readonly dimmed: boolean;
  /**
   * Freeze the current #base into #baseFade (with the blend of ground `from`) and cross-fade it
   * out over `ms` while #base fades in. Call before re-compositing #base with the new content.
   */
  crossFade(ms: number, from: Ground): void;
  /** End a running cross-fade at once (camera moved, reduced motion). */
  endFade(): void;
  readonly fading: boolean;
  /** The snapshot underlay canvas (created on demand), or null to remove it. */
  snapCanvas(on: boolean): HTMLCanvasElement | null;
  /** The snapshot underlay while it is shown, else null. */
  readonly snap: HTMLCanvasElement | null;
  dispose(): void;
}

function layer(tag: 'div' | 'canvas', id: string): HTMLElement {
  const el = document.createElement(tag);
  el.id = id;
  const s = el.style;
  s.position = 'absolute';
  s.left = '0'; s.top = '0';
  s.width = '100%'; s.height = '100%';
  s.pointerEvents = 'none';
  s.display = 'block';
  s.margin = '0'; s.padding = '0'; s.border = '0';
  return el;
}

/** Create the layer stack inside `root` (which keeps any children the app already put there). */
export function createCompositor(root: HTMLElement, ledger: CanvasLedgerExt): Compositor {
  const fallback = !supportsPlusLighter();
  const rs = root.style;
  if (typeof getComputedStyle === 'function' && getComputedStyle(root).position === 'static') rs.position = 'relative';
  rs.isolation = 'isolate';
  rs.overflow = 'hidden';

  const groundEl = layer('div', 'ground') as HTMLDivElement;
  groundEl.setAttribute('aria-hidden', 'true');
  const base = layer('canvas', 'base') as HTMLCanvasElement;
  const bloomA = layer('canvas', 'bloomA') as HTMLCanvasElement;
  const bloomB = layer('canvas', 'bloomB') as HTMLCanvasElement;
  const dry = layer('canvas', 'dry') as HTMLCanvasElement;
  const wet = layer('canvas', 'wet') as HTMLCanvasElement;
  const overlay = layer('canvas', 'overlay') as HTMLCanvasElement;
  for (const c of [base, bloomA, bloomB, dry, wet, overlay]) { c.width = 1; c.height = 1; c.setAttribute('aria-hidden', 'true'); }
  // the overlay's context must be created first with its settings (later getContext calls reuse it)
  overlay.getContext('2d', { desynchronized: true });
  const baseCtx = base.getContext('2d')!;
  for (const c of [dry, wet]) c.getContext('2d');
  const first = root.firstChild;
  for (const el of [groundEl, base, bloomA, bloomB, dry, wet, overlay]) root.insertBefore(el, first);
  for (const c of [base, dry, wet, overlay, bloomA, bloomB]) ledger.adopt(c, c.id);

  let snap: HTMLCanvasElement | null = null;
  let fade: HTMLCanvasElement | null = null;
  let fadeTimer = 0;
  let fadeEnd = 0;
  let W = 1, H = 1;
  let ground: Ground = 'night';
  let dimmed = false;
  // fallback: the last tile composite, kept so live frames only redo the cheap layering
  let tilesCanvas: HTMLCanvasElement | null = null;

  const blitting = (): boolean => fallback && ground === 'night';
  const baseOpacity = (): string => (dimmed && !blitting() ? String(DIM) : '1');

  function applyBlend(): void {
    const b = blitting();
    const mode = b ? 'normal' : blendFor(ground);
    base.style.mixBlendMode = mode;
    dry.style.mixBlendMode = blendFor(ground);
    wet.style.mixBlendMode = blendFor(ground);
    dry.style.visibility = b ? 'hidden' : 'visible';
    wet.style.visibility = b ? 'hidden' : 'visible';
    bloomA.style.mixBlendMode = 'plus-lighter';
    bloomB.style.mixBlendMode = 'plus-lighter';
    if (b) { bloomA.style.visibility = 'hidden'; bloomB.style.visibility = 'hidden'; }
    else { bloomA.style.visibility = ''; bloomB.style.visibility = ''; }
  }

  function sizeCanvas(c: HTMLCanvasElement): void {
    if (c.width !== W || c.height !== H) ledger.resize(c, W, H);
  }

  function clearFade(): void {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = 0; }
    fadeEnd = 0;
    if (fade) {
      fade.remove();
      ledger.free(fade);
      fade = null;
    }
    base.style.transition = 'none';
    base.style.opacity = baseOpacity();
  }

  const comp: Compositor = {
    root, ground: groundEl, base, bloomA, bloomB, dry, wet, overlay, fallback,
    get blitting() { return blitting(); },
    get W() { return W; },
    get H() { return H; },
    get dimmed() { return dimmed; },
    get fading() { return fade !== null && fadeEnd > 0; },
    get inkSource() { return blitting() && tilesCanvas ? tilesCanvas : base; },
    get snap() { return snap; },

    resize(cssW, cssH, dpr) {
      const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
      if (w === W && h === H && base.width === w) return false;
      W = w; H = h;
      for (const c of [base, dry, wet]) sizeCanvas(c);
      if (snap) sizeCanvas(snap);
      if (tilesCanvas) sizeCanvas(tilesCanvas);
      if (fade) clearFade();
      return true;
    },

    setGround(g, animate) {
      ground = g;
      applyBlend();
      applyGround(groundEl, g, animate);
      base.style.opacity = baseOpacity();
    },

    composite(drawTiles, bloom, bloomAlpha) {
      if (!blitting()) {
        if (tilesCanvas) { ledger.free(tilesCanvas); tilesCanvas = null; }
        drawTiles(baseCtx);
        return;
      }
      if (!tilesCanvas) tilesCanvas = ledger.alloc(W, H, 'tilesFallback');
      if (!tilesCanvas) { drawTiles(baseCtx); return; }
      sizeCanvas(tilesCanvas);
      drawTiles(tilesCanvas.getContext('2d')!);
      comp.recomposeLive(bloom, bloomAlpha);
    },

    recomposeLive(bloom, bloomAlpha) {
      if (!blitting()) return;
      const ctx = baseCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      paintGround(ctx, W, H, ground);
      ctx.globalCompositeOperation = 'lighter';
      const a = dimmed ? DIM : 1;
      if (tilesCanvas) { ctx.globalAlpha = a; ctx.drawImage(tilesCanvas, 0, 0); }
      if (bloom && bloomAlpha > 0 && bloom.width > 1) {
        ctx.globalAlpha = bloomAlpha * a;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bloom, 0, 0, bloom.width, bloom.height, 0, 0, W, H);
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(dry, 0, 0);
      ctx.drawImage(wet, 0, 0);
      ctx.restore();
    },

    setDim(on, animate) {
      if (dimmed === on) return;
      dimmed = on;
      if (fade) clearFade();
      base.style.transition = animate ? `opacity ${DIM_MS}ms cubic-bezier(.2,.8,.2,1)` : 'none';
      base.style.opacity = baseOpacity();
    },

    finishDim() {
      if (fade) return;  // a cross-fade owns #base's opacity
      base.style.transition = 'none';
      base.style.opacity = baseOpacity();
    },

    crossFade(ms, from) {
      clearFade();
      if (!(ms > 0) || blitting()) return;
      const f = ledger.alloc(W, H, 'baseFade');
      if (!f) return;
      f.id = 'baseFade';
      const s = f.style;
      s.position = 'absolute'; s.left = '0'; s.top = '0'; s.width = '100%'; s.height = '100%';
      s.pointerEvents = 'none'; s.display = 'block';
      s.mixBlendMode = blendFor(from);
      f.setAttribute('aria-hidden', 'true');
      const fctx = f.getContext('2d')!;
      fctx.drawImage(base, 0, 0);
      root.insertBefore(f, bloomA);
      fade = f;
      const target = baseOpacity();
      s.transition = 'none';
      s.opacity = target;
      base.style.transition = 'none';
      base.style.opacity = '0';
      void f.offsetWidth;  // commit the start state before transitioning
      const tr = `opacity ${ms}ms linear`;  // linear on both: the additive sum stays constant
      s.transition = tr;
      base.style.transition = tr;
      s.opacity = '0';
      base.style.opacity = target;
      fadeEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + ms;
      fadeTimer = window.setTimeout(() => { fadeTimer = 0; clearFade(); }, ms + 50);
    },

    endFade() {
      if (fade) clearFade();
    },

    snapCanvas(on) {
      if (!on) {
        if (snap) { snap.remove(); ledger.free(snap); snap = null; }
        return null;
      }
      if (!snap) {
        snap = ledger.alloc(W, H, 'snap');
        if (!snap) return null;
        snap.id = 'snap';
        const s = snap.style;
        s.position = 'absolute'; s.left = '0'; s.top = '0'; s.width = '100%'; s.height = '100%';
        s.pointerEvents = 'none'; s.display = 'block';
        snap.setAttribute('aria-hidden', 'true');
        root.insertBefore(snap, base);
      }
      sizeCanvas(snap);
      return snap;
    },

    dispose() {
      clearFade();
      comp.snapCanvas(false);
      if (tilesCanvas) { ledger.free(tilesCanvas); tilesCanvas = null; }
      for (const c of [base, bloomA, bloomB, dry, wet, overlay]) { ledger.free(c); c.remove(); }
      groundEl.remove();
    },
  };
  applyBlend();
  return comp;
}
