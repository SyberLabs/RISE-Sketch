/**
 * The camera and the view chip (DESIGN §5 navigation, §4 view chip, §6.9 camera).
 *
 *  - Gestures (wheel notches, trackpad scroll and pinch, Space / middle drag, two-finger touch)
 *    move the camera in the renderer's 'gesture' phase: only cached tiles composite, animations
 *    fast-forward. `navEnd` settles it: a pinch ending within ±8 % of 25/50/100/200/400 % snaps to
 *    the detent, the renderer snaps the translation to whole device pixels, and the camera is
 *    saved with the document (doc.setView, outside history).
 *  - Fit and reset glide (easeOutCubic, scale interpolated in log space so a 10× fit does not
 *    rush through the near scales); reduced motion jumps.
 *  - View-chip state (zoom %, whether any ink is in view, the direction to the ink) is derived
 *    once per frame at most, and only when the camera or the ink changed.
 */
import type { AABB, Camera, StrokeId } from '../core/types';
import { clampScale, fitBox, panBy, snapDetent, visibleBox, zoomAt } from '../render/camera';
import type { Runtime } from './runtime';

/** Fit and reset glide (ms). */
const GLIDE_MS = 280;
/** View-chip state is refreshed at most this often while the camera moves (ms). */
const STATE_GAP_MS = 90;

const easeOutCubic = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);

export class View {
  cam: Camera = { cx: 0, cy: 0, scale: 1, rot: 0 };
  W = 1;
  H = 1;
  /** A navigation gesture or glide is in progress (not yet settled). */
  navActive = false;
  /** Called whenever the view-chip state is republished (camera moved or settled, ink changed). */
  onPublish: (() => void) | null = null;
  /** Called once per navigation gesture or glide (the nav hint is dismissed by navigating). */
  onNavigate: (() => void) | null = null;
  private glide: { from: Camera; to: Camera; t0: number } | null = null;
  private stateDirty = true;
  private lastState = -Infinity;
  private readonly q: StrokeId[] = [];
  private zx = 0;
  private zy = 0;

  constructor(private readonly rt: Runtime) {}

  /** Adopt a camera without animation (boot, document switch). */
  reset(c: Camera): void {
    this.glide = null;
    this.navActive = false;
    this.rt.renderer.setCamera({ cx: c.cx, cy: c.cy, scale: clampScale(c.scale), rot: 0 }, 'settled');
    this.cam = { ...this.rt.renderer.getCamera() };
    this.invalidate();
  }

  setSize(W: number, H: number): void {
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    this.cam = { ...this.rt.renderer.getCamera() };
    this.invalidate();
  }

  /** Viewport CSS px -> doc. */
  toDoc(sx: number, sy: number): [number, number] {
    const c = this.cam;
    return [c.cx + (sx - this.W * 0.5) / c.scale, c.cy + (sy - this.H * 0.5) / c.scale];
  }

  /** Doc -> viewport CSS px. */
  toScreen(x: number, y: number): [number, number] {
    return this.toScreenInto(x, y, [0, 0]);
  }

  /** Doc -> viewport CSS px into `out` (no allocation: hot paths). */
  toScreenInto(x: number, y: number, out: [number, number]): [number, number] {
    const c = this.cam;
    out[0] = (x - c.cx) * c.scale + this.W * 0.5;
    out[1] = (y - c.cy) * c.scale + this.H * 0.5;
    return out;
  }

  /** Viewport CSS px -> doc into `out` (no allocation: hot paths). */
  toDocInto(sx: number, sy: number, out: [number, number]): [number, number] {
    const c = this.cam;
    out[0] = c.cx + (sx - this.W * 0.5) / c.scale;
    out[1] = c.cy + (sy - this.H * 0.5) / c.scale;
    return out;
  }

  /** The ink (or the camera) changed: refresh the view-chip state on the next frame. */
  invalidate(): void {
    this.stateDirty = true;
    this.rt.loop.request();
  }

  /** A contact landed: a running glide stops where it is (the camera is locked while drawing). */
  interrupt(): void {
    if (!this.glide) return;
    this.glide = null;
    this.settle();
  }

  // ---------------------------------------------------------------- gestures

  pan(dx: number, dy: number): void {
    this.glide = null;
    this.cam = panBy(this.cam, dx, dy);
    this.gesture();
  }

  zoom(f: number, cx: number, cy: number): void {
    if (!(f > 0) || f === 1) return;
    this.glide = null;
    this.cam = zoomAt(this.cam, f, cx, cy, this.W, this.H);
    this.zx = cx; this.zy = cy;
    this.gesture();
  }

  /** A gesture ended: snap a pinch to a detent, settle and save. */
  navEnd(kind: 'pinch' | 'wheel' | 'drag'): void {
    if (kind === 'pinch') {
      const s = snapDetent(this.cam.scale);
      if (s !== this.cam.scale) this.cam = zoomAt(this.cam, s / this.cam.scale, this.zx, this.zy, this.W, this.H);
    }
    this.settle();
  }

  private gesture(): void {
    if (!this.navActive && this.onNavigate) this.onNavigate();
    this.navActive = true;
    this.rt.renderer.setCamera(this.cam, 'gesture');
    this.invalidate();
  }

  private settle(): void {
    this.navActive = false;
    this.rt.renderer.setCamera(this.cam, 'settled');
    this.cam = { ...this.rt.renderer.getCamera() };
    this.save();
    this.invalidate();
  }

  private save(): void {
    const m = this.rt.doc.meta.camera, c = this.cam;
    if (m.cx === c.cx && m.cy === c.cy && m.scale === c.scale && m.rot === c.rot) return;
    try { this.rt.doc.setView({ camera: { cx: c.cx, cy: c.cy, scale: c.scale, rot: 0 } }); } catch (err) { console.error('[rise] camera not saved', err); }
  }

  // ---------------------------------------------------------------- fit / reset

  /**
   * Fit the content (6 % margin); with no ink, back to 100 % at the origin. `byUser` false is the
   * app's own glide (Replay fitting the drawing first): it is not a navigation, so it neither stops
   * the replay that asked for it nor counts for the nav hint.
   */
  fit(byUser = true): void {
    const box = this.rt.scene.contentBox();
    this.glideTo(box ? fitBox(box, this.W, this.H, 0.06) : { cx: 0, cy: 0, scale: 1, rot: 0 }, byUser);
  }

  /** Back to 100 % around the viewport centre. */
  resetZoom(): void {
    const c = this.cam;
    this.glideTo({ cx: c.cx, cy: c.cy, scale: 1, rot: 0 });
  }

  /** View chip tap: fit when no ink is in view, else back to 100 %. */
  chip(): void {
    const s = this.rt.store.get();
    if (s.hasInk && !s.inkInView) this.fit(); else this.resetZoom();
  }

  private glideTo(to: Camera, byUser = true): void {
    if (this.rt.reduced()) { this.cam = to; this.settle(); return; }
    this.glide = { from: { ...this.cam }, to, t0: -1 };
    if (byUser && !this.navActive && this.onNavigate) this.onNavigate();
    this.navActive = true;
    this.rt.loop.request();
  }

  // ---------------------------------------------------------------- frame

  /** Frame participant: advance a glide, refresh the view-chip state. */
  frame(now: number): boolean {
    let more = false;
    const g = this.glide;
    if (g) {
      if (g.t0 < 0) g.t0 = now;
      const u = Math.min(1, (now - g.t0) / GLIDE_MS), e = easeOutCubic(u);
      if (u >= 1) {
        this.glide = null;
        this.cam = g.to;
        this.settle();
      } else {
        const ls = Math.log(g.from.scale), le = Math.log(g.to.scale);
        this.cam = {
          cx: g.from.cx + (g.to.cx - g.from.cx) * e,
          cy: g.from.cy + (g.to.cy - g.from.cy) * e,
          scale: Math.exp(ls + (le - ls) * e), rot: 0,
        };
        this.rt.renderer.setCamera(this.cam, 'gesture');
        this.stateDirty = true;
        more = true;
      }
    }
    if (this.stateDirty) {
      if (!this.navActive || now - this.lastState >= STATE_GAP_MS) {
        this.lastState = now;
        this.stateDirty = false;
        this.publish();
      } else more = true;
    }
    return more;
  }

  /** zoom %, inkInView, inkDirection into the store. */
  private publish(): void {
    const rt = this.rt, c = this.cam;
    const hasInk = rt.doc.size > 0;
    let inView = false;
    let dir: number | null = null;
    if (hasInk) {
      const vb: AABB = visibleBox(c, this.W, this.H);
      inView = rt.scene.query(vb, this.q).length > 0;
      this.q.length = 0;
      if (!inView) {
        const b = rt.scene.contentBox();
        if (b) {
          const [sx, sy] = this.toScreen((b.x0 + b.x1) * 0.5, (b.y0 + b.y1) * 0.5);
          dir = Math.atan2(sy - this.H * 0.5, sx - this.W * 0.5);
        }
      }
    }
    rt.store.set({ zoom: c.scale * 100, inkInView: inView, inkDirection: dir, hasInk });
    if (this.onPublish) this.onPublish();
  }

  /** The whole content box is inside the viewport (replay starts from a view that shows it all). */
  contentVisible(): boolean {
    const b = this.rt.scene.contentBox();
    if (!b) return true;
    const v = visibleBox(this.cam, this.W, this.H);
    return b.x0 >= v.x0 && b.y0 >= v.y0 && b.x1 <= v.x1 && b.y1 <= v.y1;
  }
}
