/**
 * Night bloom (DESIGN §6.7): dense ink reads as light rather than flat white.
 *
 *  - Source: the composited tiles (#base, which holds exactly the visible tiles under the camera)
 *    drawn at ¼ resolution: one scaled drawImage instead of 20–40 tile blits.
 *  - Blur: a dual-filter mip chain using drawImage only (never ctx.filter): three 2× downsamples,
 *    then three 2× upsamples, each upsample mixed into the level below it
 *    (level = (1 − m)·level + m·up(coarser)), so the glow has a soft core and a wide halo.
 *  - Double buffer: the new bloom renders into the back buffer and cross-fades in over 400 ms
 *    (linear on both buffers, so their additive sum is constant where nothing changed): only the
 *    new stroke's glow fades in, and the ink cures into light.
 *  - Camera gestures: both buffers follow the camera with a CSS transform; the renderer asks for a
 *    fresh render once the camera settles. Night only; live layers are not bloomed.
 */
import type { Camera } from '../core/types';
import type { CanvasLedgerExt } from './ledger';
import { DIM } from './compositor';

/** CSS opacity of the bloom layer (DESIGN §6.2). */
export const BLOOM_ALPHA = 0.30;
/** Cure cross-fade, ms. */
export const CURE_MS = 400;
/** Weight of the coarser level in each upsample mix. */
const MIX = 0.6;
/** Bloom resolution relative to the viewport's device px. */
const SCALE = 0.25;

export interface BloomView { cam: Camera; cssW: number; cssH: number; dpr: number }

export interface Bloom {
  /** Viewport changed: buffers are resized and their content dropped. */
  resize(cssW: number, cssH: number, dpr: number): void;
  /** Render the bloom of `src` (device-px viewport canvas) for `view` and cure it in. */
  render(src: HTMLCanvasElement, view: BloomView, animate: boolean): void;
  /** Align both buffers with the current camera by CSS transform (no re-render). */
  follow(view: BloomView): void;
  /** Night on / Paper off. Turning off fades the layer out and drops its content. */
  setEnabled(on: boolean, animate: boolean): void;
  setDim(on: boolean, animate: boolean): void;
  /** Drop both buffers' content at once. */
  clear(): void;
  /**
   * Fade the shown bloom out over `ms` (New / Open with a base fade) and mark it invalid; the next
   * render cures in from nothing. Pixels stay until that render, so the fade has something to show.
   */
  fadeOut(ms: number): void;
  /** Free the scratch chain and the buffers' backing stores (memory pressure). */
  purge(): void;
  /** Free only the scratch chain (rebuilt by the next render); the shown bloom stays. */
  freeScratch(): void;
  /** The buffer currently shown (for snapshots and the blit fallback), or null. */
  readonly front: HTMLCanvasElement | null;
  /** Effective opacity of the front buffer when settled. */
  readonly alpha: number;
  readonly enabled: boolean;
  /** The front buffer holds a bloom for the current content. */
  readonly valid: boolean;
}

interface Buf { el: HTMLCanvasElement; cam: Camera | null }

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Bloom over two existing canvases (the compositor's #bloomA / #bloomB). */
export function createBloom(a: HTMLCanvasElement, b: HTMLCanvasElement, ledger: CanvasLedgerExt): Bloom {
  const bufs: [Buf, Buf] = [{ el: a, cam: null }, { el: b, cam: null }];
  let front = 0;
  let enabled = true;
  let dimmed = false;
  let fadeEnd = 0;
  let bw = 1, bh = 1, cssW = 1, cssH = 1;
  let chain: HTMLCanvasElement[] = [];
  for (const x of bufs) {
    x.el.style.opacity = '0';
    x.el.style.transformOrigin = '0 0';
    x.el.style.willChange = 'opacity, transform';
  }

  const target = (): number => (enabled ? BLOOM_ALPHA * (dimmed ? DIM : 1) : 0);

  function setOpacity(el: HTMLCanvasElement, v: number, ms: number, easing = 'linear'): void {
    el.style.transition = ms > 0 ? `opacity ${ms}ms ${easing}` : 'none';
    el.style.opacity = String(v);
  }

  /** Snap a running cure to its end state. */
  function settleFade(): void {
    if (!fadeEnd) return;
    fadeEnd = 0;
    setOpacity(bufs[front].el, target(), 0);
    setOpacity(bufs[1 - front].el, 0, 0);
  }

  function sized(el: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
    if (el.width !== w || el.height !== h) {
      if (!ledger.resize(el, w, h)) return null;
    }
    return el.getContext('2d');
  }

  function ensureChain(): boolean {
    let w = bw, h = bh;
    for (let i = 0; i < 3; i++) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      let c = chain[i];
      if (!c) {
        const made = ledger.alloc(w, h, 'bloom');
        if (!made) return false;
        c = chain[i] = made;
      } else if (c.width !== w || c.height !== h) {
        if (!ledger.resize(c, w, h)) return false;
      }
    }
    return true;
  }

  function prep(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  /** dst = src scaled to dst's size (dst cleared first). */
  function down(src: HTMLCanvasElement, dst: HTMLCanvasElement): void {
    const ctx = dst.getContext('2d')!;
    prep(ctx);
    ctx.clearRect(0, 0, dst.width, dst.height);
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, dst.width, dst.height);
  }

  /** dst = (1 − MIX)·dst + MIX·up(src). */
  function mixUp(src: HTMLCanvasElement, dst: HTMLCanvasElement): void {
    const ctx = dst.getContext('2d')!;
    prep(ctx);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = MIX;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, dst.width, dst.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, dst.width, dst.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function transformFor(x: Buf, v: BloomView): string {
    if (!x.cam) return '';
    const k = v.cam.scale, k0 = x.cam.scale;
    const f = k / k0;
    const tx = cssW * 0.5 * (1 - f) + (x.cam.cx - v.cam.cx) * k;
    const ty = cssH * 0.5 * (1 - f) + (x.cam.cy - v.cam.cy) * k;
    if (Math.abs(f - 1) < 1e-9 && Math.abs(tx) < 1e-6 && Math.abs(ty) < 1e-6) return '';
    return `translate(${tx}px, ${ty}px) scale(${f})`;
  }

  const bloom: Bloom = {
    get front() { return bufs[front].cam ? bufs[front].el : null; },
    get alpha() { return target(); },
    get enabled() { return enabled; },
    get valid() { return bufs[front].cam !== null; },

    resize(w, h, dpr) {
      cssW = w; cssH = h;
      const nbw = Math.max(1, Math.ceil(w * dpr * SCALE)), nbh = Math.max(1, Math.ceil(h * dpr * SCALE));
      if (nbw === bw && nbh === bh) return;
      bw = nbw; bh = nbh;
      bloom.clear();
    },

    render(src, view, animate) {
      if (!enabled || src.width < 2 || src.height < 2) return;
      settleFade();
      const back = bufs[1 - front];
      const ctx = sized(back.el, bw, bh);
      if (!ctx || !ensureChain()) return;
      prep(ctx);
      ctx.clearRect(0, 0, bw, bh);
      ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, bw, bh);
      down(back.el, chain[0]);
      down(chain[0], chain[1]);
      down(chain[1], chain[2]);
      mixUp(chain[2], chain[1]);
      mixUp(chain[1], chain[0]);
      mixUp(chain[0], back.el);
      back.cam = view.cam;
      back.el.style.transform = '';
      const old = bufs[front];
      const t = target();
      if (animate && old.cam) {
        setOpacity(back.el, 0, 0);
        void back.el.offsetWidth;  // commit the start state
        setOpacity(back.el, t, CURE_MS);
        setOpacity(old.el, 0, CURE_MS);
        fadeEnd = now() + CURE_MS;
      } else {
        setOpacity(back.el, t, animate ? CURE_MS : 0);
        setOpacity(old.el, 0, 0);
        fadeEnd = animate ? now() + CURE_MS : 0;
      }
      front = 1 - front;
    },

    follow(view) {
      cssW = view.cssW; cssH = view.cssH;
      for (const x of bufs) x.el.style.transform = transformFor(x, view);
    },

    setEnabled(on, animate) {
      if (enabled === on) return;
      enabled = on;
      settleFade();
      if (!on) {
        setOpacity(bufs[0].el, 0, animate ? CURE_MS : 0);
        setOpacity(bufs[1].el, 0, animate ? CURE_MS : 0);
        bufs[0].cam = null; bufs[1].cam = null;
      }
    },

    setDim(on, animate) {
      if (dimmed === on) return;
      dimmed = on;
      settleFade();
      if (bufs[front].cam) setOpacity(bufs[front].el, target(), animate ? 160 : 0, 'cubic-bezier(.2,.8,.2,1)');
    },

    clear() {
      settleFade();
      for (const x of bufs) {
        x.cam = null;
        setOpacity(x.el, 0, 0);
        x.el.style.transform = '';
        const c = x.el.getContext('2d');
        if (c) c.clearRect(0, 0, x.el.width, x.el.height);
      }
    },

    fadeOut(ms) {
      settleFade();
      const shown = bufs[front];
      setOpacity(bufs[1 - front].el, 0, 0);
      setOpacity(shown.el, 0, shown.cam && ms > 0 ? ms : 0);
      bufs[0].cam = null; bufs[1].cam = null;
    },

    purge() {
      bloom.clear();
      bloom.freeScratch();
      for (const x of bufs) ledger.resize(x.el, 1, 1);
    },

    freeScratch() {
      for (const c of chain) ledger.free(c);
      chain = [];
    },
  };
  return bloom;
}
