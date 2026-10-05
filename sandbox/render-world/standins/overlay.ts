/**
 * SANDBOX STAND-IN for src/render/overlay.ts (render-live is writing the real one): draws only
 * the selection bounds, enough to see the layer on screenshots. Not product code.
 */
import type { AABB } from '../../../src/core/types';
import type { OverlayHost, OverlayInternal } from '../../../src/render/types';
import { docToScreen } from '../../../src/render/camera';

export function createOverlay(host: OverlayHost): OverlayInternal {
  const ctx = host.canvas.getContext('2d', { desynchronized: true })!;
  let sel: AABB | null = null;
  let dpr = 1;
  let dirty = false;
  const ov: OverlayInternal = {
    cursor() {}, weld() {}, lasso() {}, eraser() {}, sizeRing() {}, predicted() {},
    selection(box) { sel = box; dirty = true; host.requestFrame(); },
    clear() { sel = null; dirty = true; host.requestFrame(); },
    resize(w, h, d) {
      dpr = d;
      host.canvas.width = Math.round(w * d); host.canvas.height = Math.round(h * d);
      dirty = true;
    },
    frame() {
      if (!dirty) return false;
      dirty = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, host.canvas.width, host.canvas.height);
      if (sel) {
        const { w, h } = host.viewport();
        const [x0, y0] = docToScreen(host.camera(), w, h, sel.x0, sel.y0);
        const [x1, y1] = docToScreen(host.camera(), w, h, sel.x1, sel.y1);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = host.ground() === 'night' ? 'rgba(160,190,255,.8)' : 'rgba(40,70,170,.8)';
        ctx.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
      }
      return false;
    },
  };
  return ov;
}
