/**
 * PNG export (DESIGN §8 Export). No dialog: the content bounds plus a 6 % margin, rendered from
 * the recipes through renderer.renderRegion with the ground painted, never from the screen bitmap.
 *
 *  - Density: camera.scale · k px per doc unit, k = clamp(3000 / longEdge_css, 1, 4) where
 *    longEdge_css is the content's long edge at the current zoom; then capped to the device
 *    class's pixel budget (phone 8 MP, tablet 16.7 MP, desktop 32 MP).
 *  - Every stroke is cooked first (scene.ensure), the tiles are purged, the region renders one
 *    stroke per step with the main thread yielded every ~8 ms, then the canvas encodes.
 *  - Progress 0..1 is reported for the toast (shown by the caller after 300 ms, with Cancel).
 *  - File name rise-YYYYMMDD-HHMM.png (exportFilename); the app delivers it by <a download>.
 */
import type { AABB, Camera, Doc, Ground, Scene } from '../core/types';
import type { DeviceClass } from '../render/ledger';
import { deviceClass } from '../render/ledger';
import type { RendererImpl } from '../render/renderer';

/** Margin around the content, as a fraction of its long edge. */
export const MARGIN = 0.06;
/** Output pixel budget per device class. */
export const PIXEL_CAPS: Readonly<Record<DeviceClass, number>> = { phone: 8e6, tablet: 16.7e6, desktop: 32e6 };
/** Target long edge of the output (CSS px of content at the current zoom are scaled toward it). */
export const TARGET_EDGE = 3000;
/** Main-thread work between yields while drawing (ms). */
const SLICE_MS = 8;

export interface ExportFrame { box: AABB; pxPerDoc: number; width: number; height: number; k: number }

/** The export framing (pure): margin, density and the capped pixel size. */
export function exportFrame(content: AABB, cam: Camera, cls: DeviceClass = deviceClass()): ExportFrame {
  const w = Math.max(1e-6, content.x1 - content.x0), h = Math.max(1e-6, content.y1 - content.y0);
  const m = MARGIN * Math.max(w, h);
  const box: AABB = { x0: content.x0 - m, y0: content.y0 - m, x1: content.x1 + m, y1: content.y1 + m };
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const longCss = Math.max(bw, bh) * cam.scale;
  const k = Math.min(4, Math.max(1, TARGET_EDGE / longCss));
  let px = cam.scale * k;
  const cap = PIXEL_CAPS[cls];
  if (bw * bh * px * px > cap) px = Math.sqrt(cap / (bw * bh));
  const width = Math.max(1, Math.ceil(bw * px)), height = Math.max(1, Math.ceil(bh * px));
  return { box, pxPerDoc: px, width, height, k };
}

/** `rise-YYYYMMDD-HHMM.<ext>` in local time (`.png` for images, `.mp4` / `.webm` for timelapses). */
export function exportFilename(d = new Date(), ext = 'png'): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `rise-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

export interface ExportOptions {
  onProgress?(fraction: number): void;
  /** Polled between steps; true aborts (resolves null). */
  cancelled?(): boolean;
}

export interface ExportResult { blob: Blob; width: number; height: number }

/** What an export reads: the document, its cooked geometry, the raster path and the ground. */
export interface ExportDeps {
  doc: Doc;
  scene: Scene;
  renderer: Pick<RendererImpl, 'renderRegion' | 'purge' | 'ledger' | 'getCamera'>;
  ground: Ground;
}

const yieldTask = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    try { canvas.toBlob(b => resolve(b), 'image/png'); } catch { resolve(null); }
  });
}

/** Render the document to a PNG blob (null when there is no ink or the export was cancelled). */
export async function renderPng(rt: ExportDeps, o: ExportOptions = {}): Promise<ExportResult | null> {
  const ids = rt.doc.ordered().map(r => r.id);
  const content = rt.scene.contentBox();
  if (!ids.length || !content) return null;
  const progress = (f: number): void => { if (o.onProgress) o.onProgress(f); };
  const cancelled = (): boolean => !!o.cancelled && o.cancelled();
  progress(0.02);
  // cook everything first (strokes outside the view may never have been cooked)
  try { await rt.scene.ensure(ids, 'visible'); } catch { /* skipped strokes are reported below */ }
  if (cancelled()) return null;
  progress(0.3);
  // the content box is exact once everything is cooked
  const box = rt.scene.contentBox() ?? content;
  const f = exportFrame(box, rt.renderer.getCamera());
  const R = rt.renderer;
  R.purge();
  let canvas: HTMLCanvasElement | null = R.ledger.alloc(f.width, f.height, 'export');
  let owned = true;
  if (!canvas) {
    owned = false;
    canvas = document.createElement('canvas');
    canvas.width = f.width; canvas.height = f.height;
  }
  const free = (): void => { if (canvas) { if (owned) R.ledger.free(canvas); else { canvas.width = 0; canvas.height = 0; } } };
  const ctx = canvas.getContext('2d');
  if (!ctx) { free(); return null; }
  const gen = R.renderRegion(ctx, f.box, f.pxPerDoc, rt.ground, true);
  let done = 0, t = performance.now();
  for (;;) {
    const step = gen.next();
    if (step.done) {
      if (step.value.length) console.warn('[rise] export skipped uncooked strokes', step.value.length);
      break;
    }
    done++;
    progress(0.3 + 0.6 * Math.min(1, done / ids.length));
    const now = performance.now();
    if (now - t >= SLICE_MS) {
      await yieldTask();
      t = performance.now();
      if (cancelled()) { free(); return null; }
    }
  }
  progress(0.92);
  const blob = await toBlob(canvas);
  free();
  if (!blob || cancelled()) return null;
  progress(1);
  return { blob, width: f.width, height: f.height };
}
