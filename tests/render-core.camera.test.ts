import { describe, it, expect } from 'vitest';
import type { Camera } from '../src/core/types';
import { MIN_SCALE, MAX_SCALE, docToScreen, screenToDoc, panBy, zoomAt, fitBox, snapDetent, visibleBox, clampScale, snapToDevice } from '../src/render/camera';
import { viewMatrix, regionMatrix } from '../src/render/raster';

const W = 1280, H = 820;
const cams: Camera[] = [
  { cx: 0, cy: 0, scale: 1, rot: 0 },
  { cx: 1234.5, cy: -987.25, scale: 2.7, rot: 0 },
  { cx: -1e6, cy: 3e5, scale: 0.05, rot: 0 },
  { cx: 40, cy: 60, scale: 1.3, rot: 0.4 },
];

describe('camera maths', () => {
  it('docToScreen and screenToDoc round-trip', () => {
    for (const c of cams) for (const [x, y] of [[0, 0], [17.5, -3], [c.cx + 100, c.cy - 50]]) {
      const [sx, sy] = docToScreen(c, W, H, x, y);
      const [dx, dy] = screenToDoc(c, W, H, sx, sy);
      expect(dx).toBeCloseTo(x, 6);
      expect(dy).toBeCloseTo(y, 6);
    }
  });

  it('the camera centre maps to the viewport centre', () => {
    for (const c of cams) {
      const [sx, sy] = docToScreen(c, W, H, c.cx, c.cy);
      expect(sx).toBeCloseTo(W / 2, 9);
      expect(sy).toBeCloseTo(H / 2, 9);
    }
  });

  it('panBy moves content by exactly (dx, dy) screen px', () => {
    for (const c of cams) {
      const p = panBy(c, 33, -12);
      const [a, b] = docToScreen(c, W, H, 5, 7), [a2, b2] = docToScreen(p, W, H, 5, 7);
      expect(a2 - a).toBeCloseTo(33, 6);
      expect(b2 - b).toBeCloseTo(-12, 6);
      expect(p.scale).toBe(c.scale);
    }
  });

  it('zoomAt keeps the anchor fixed and clamps the scale', () => {
    for (const c of cams) {
      const z = zoomAt(c, 1.15, 300, 200, W, H);
      const before = screenToDoc(c, W, H, 300, 200), after = screenToDoc(z, W, H, 300, 200);
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[1]).toBeCloseTo(before[1], 6);
    }
    expect(zoomAt(cams[0], 1e6, 0, 0, W, H).scale).toBe(MAX_SCALE);
    expect(zoomAt(cams[0], 1e-6, 0, 0, W, H).scale).toBe(MIN_SCALE);
    expect(clampScale(NaN)).toBe(1);
  });

  it('fitBox contains the box with a 6% margin and centres it', () => {
    const box = { x0: -200, y0: 50, x1: 600, y1: 250 };
    const c = fitBox(box, W, H);
    const [x0, y0] = docToScreen(c, W, H, box.x0, box.y0), [x1, y1] = docToScreen(c, W, H, box.x1, box.y1);
    expect(x0).toBeGreaterThanOrEqual(W * 0.06 - 1e-6);
    expect(x1).toBeLessThanOrEqual(W * 0.94 + 1e-6);
    expect(y0).toBeGreaterThanOrEqual(H * 0.06 - 1e-6);
    expect(y1).toBeLessThanOrEqual(H * 0.94 + 1e-6);
    expect(Math.min(x0 - W * 0.06, y0 - H * 0.06)).toBeCloseTo(0, 6);   // tight on the limiting axis
    expect([c.cx, c.cy]).toEqual([200, 150]);
    expect(fitBox({ x0: 5, y0: 5, x1: 5, y1: 5 }, W, H).scale).toBe(MAX_SCALE);
  });

  it('snapDetent snaps within ±8% of 25/50/100/200/400%', () => {
    expect(snapDetent(1.07)).toBe(1);
    expect(snapDetent(0.93)).toBe(1);
    expect(snapDetent(1.09)).toBe(1.09);
    expect(snapDetent(0.26)).toBe(0.25);
    expect(snapDetent(4.3)).toBe(4);
    expect(snapDetent(3)).toBe(3);
  });

  it('snapToDevice puts the document origin on a whole device pixel, moving < half a pixel', () => {
    for (const dpr of [1, 2, 3]) for (const c of cams.filter(k => !k.rot)) {
      const s = snapToDevice(c, 1001, H, dpr);
      const [x, y] = docToScreen(s, 1001, H, 0, 0);
      expect(Math.abs(x * dpr - Math.round(x * dpr))).toBeLessThan(1e-6 * Math.max(1, Math.abs(x * dpr)));
      expect(Math.abs(y * dpr - Math.round(y * dpr))).toBeLessThan(1e-6 * Math.max(1, Math.abs(y * dpr)));
      expect(Math.abs((s.cx - c.cx) * c.scale * dpr)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(s.scale).toBe(c.scale);
    }
  });

  it('visibleBox matches the viewport corners', () => {
    for (const c of cams) {
      const b = visibleBox(c, W, H);
      for (const [sx, sy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const [x, y] = screenToDoc(c, W, H, sx, sy);
        expect(x).toBeGreaterThanOrEqual(b.x0 - 1e-6); expect(x).toBeLessThanOrEqual(b.x1 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(b.y0 - 1e-6); expect(y).toBeLessThanOrEqual(b.y1 + 1e-6);
      }
    }
  });
});

describe('view and region matrices', () => {
  it('viewMatrix(origin) ∘ doc-rel point = docToScreen × dpr', () => {
    for (const c of cams) for (const dpr of [1, 2, 3]) {
      const origin: [number, number] = [c.cx + 123.25, c.cy - 77.5];
      const m = viewMatrix(origin, c, W, H, dpr);
      for (const [x, y] of [[0, 0], [10, -4], [-300, 222]]) {
        const [sx, sy] = docToScreen(c, W, H, origin[0] + x, origin[1] + y);
        expect(m[0] * x + m[2] * y + m[4]).toBeCloseTo(sx * dpr, 5);
        expect(m[1] * x + m[3] * y + m[5]).toBeCloseTo(sy * dpr, 5);
      }
    }
  });

  it('keeps precision for ink 10⁶ doc units from the document origin', () => {
    const c: Camera = { cx: 1e6 + 0.3, cy: -1e6 + 0.7, scale: 32, rot: 0 };
    const m = viewMatrix([1e6, -1e6], c, W, H, 2);
    expect(m[4]).toBeCloseTo((0 - 0.3) * 64 + W, 6);
    expect(m[5]).toBeCloseTo((0 - 0.7) * 64 + H, 6);
  });

  it('regionMatrix maps the box corner to (0,0) at pxPerDoc', () => {
    const m = regionMatrix([100, 200], { x0: 90, y0: 150, x1: 190, y1: 250 }, 4);
    expect(Array.from(m)).toEqual([4, 0, 0, 4, 40, 200]);
  });
});
