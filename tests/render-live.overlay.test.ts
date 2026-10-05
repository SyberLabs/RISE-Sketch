/**
 * render-live: the overlay (cursor, predicted tail, weld ring, lasso, eraser ring + doom mask,
 * selection bounds and outlines, size ring), on a recording canvas.
 */
import { describe, it, expect } from 'vitest';
import type { InputSample } from '../src/core/types';
import { createOverlay, OVERLAY_MAX_DPR } from '../src/render/overlay';
import { GROUND_TOKENS } from '../src/ink/color';
import { FakeCook, addSample, freeze, makeDraft, wavePath } from './render-live.fakecook';
import { FakeOverlayHost, unionBox, type DrawOp } from './render-live.helpers';

const paint = (ops: DrawOp[]): DrawOp[] => ops.filter(o => o.op === 'fill' || o.op === 'stroke' || o.op === 'fillRect' || o.op === 'strokeRect');
const clears = (ops: DrawOp[]): DrawOp[] => ops.filter(o => o.op === 'clearRect');
const sample = (x: number, y: number, t: number, predicted: boolean): InputSample => ({ x, y, t, p: 0.5, alt: Math.PI / 2, az: 0, r: NaN, predicted });

function withStroke(h: FakeOverlayHost, id: string, x0: number, y0: number): void {
  const d = makeDraft({ form: 'sprout', base: 2, origin: [x0, y0] });
  const cook = new FakeCook(d);
  const path = wavePath(0, 0, 200, 30, 80);
  path.forEach(([x, y], k) => addSample(d, x, y, k * 10, 0.6));
  cook.append(path.length);
  const r = freeze(d, id);
  h.strokes.set(id, { r, c: cook.finish(r) });
}

describe('overlay sizing', () => {
  it('caps its device pixel ratio at 2', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 3);
    expect(h.can.width).toBe(800 * OVERLAY_MAX_DPR);
    expect(h.can.height).toBe(600 * OVERLAY_MAX_DPR);
    ov.resize(400, 300, 1);
    expect(h.can.width).toBe(400);
  });

  it('asks for a desynchronized context', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    expect(h.can.contextAttrs).toEqual({ desynchronized: true });
  });
});

describe('nib cursor', () => {
  it('draws at once, true size, in the ink colour, and repaints only around itself', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 2);
    h.can.ctx.take();
    ov.cursor([100, 100], { kind: 'brush', wCss: 20, angle: 0, css: '#88cc88' });
    let ops = h.can.ctx.take();
    const p = paint(ops);
    expect(p.length).toBeGreaterThan(0);
    expect(p.some(o => o.style === '#88cc88')).toBe(true);
    const b = unionBox(p);
    // ring of radius 10 CSS px at dpr 2 → about 40 device px across
    expect(b.x1 - b.x0).toBeGreaterThan(36);
    expect(b.x1 - b.x0).toBeLessThan(60);
    ov.cursor([300, 100], { kind: 'brush', wCss: 20, angle: 0, css: '#88cc88' });
    ops = h.can.ctx.take();
    const cb = unionBox(clears(ops));
    // the clear covers the old and the new position, nothing else
    expect(cb.x0).toBeLessThan(200);
    expect(cb.x1).toBeGreaterThan(600);
    expect(cb.y1 - cb.y0).toBeLessThan(80);
  });

  it('shows the chisel as an oriented bar that follows the azimuth', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    h.can.ctx.take();
    ov.cursor([200, 200], { kind: 'chisel', wCss: 40, angle: 0, css: '#ff8800' });
    const flat = unionBox(paint(h.can.ctx.take()).filter(o => o.op === 'fillRect'));
    ov.cursor([200, 200], { kind: 'chisel', wCss: 40, angle: Math.PI / 2, css: '#ff8800' });
    const upright = unionBox(paint(h.can.ctx.take()).filter(o => o.op === 'fillRect'));
    expect(flat.x1 - flat.x0).toBeGreaterThan(flat.y1 - flat.y0);
    expect(upright.y1 - upright.y0).toBeGreaterThan(upright.x1 - upright.x0);
  });

  it('hides on null', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    ov.cursor([100, 100], { kind: 'pen', wCss: 3, angle: 0, css: '#ffffff' });
    h.can.ctx.take();
    ov.cursor(null, null);
    const ops = h.can.ctx.take();
    expect(clears(ops).length).toBe(1);
    expect(paint(ops).length).toBe(0);
  });
});

describe('predicted tail (DESIGN §2.2.2)', () => {
  it('is drawn once as a 50 % bare spine, kept through the next frame, then cleared', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    h.can.ctx.take();
    ov.predicted([sample(100, 100, NaN, false), sample(110, 100, 1000, false), sample(118, 102, 1008, true)], 6, '#abcdef');
    const ops = paint(h.can.ctx.take());
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe('stroke');
    expect(ops[0].alpha).toBe(0.5);
    expect(ops[0].lineWidth).toBe(6);
    expect(h.frames).toBeGreaterThan(0);
    expect(ov.frame(1010)).toBe(true);           // still shown this frame
    expect(clears(h.can.ctx.take()).length).toBe(0);
    expect(ov.frame(1026)).toBe(false);          // gone the frame after
    const c = h.can.ctx.take();
    expect(clears(c).length).toBe(1);
    expect(paint(c).length).toBe(0);
  });

  it('a fresh prediction each frame stays up; null clears it', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    for (let f = 0; f < 4; f++) {
      ov.predicted([sample(100 + f, 100, 1000 + 16 * f, false), sample(110 + f, 100, 1004 + 16 * f, true)], 4, '#fff');
      expect(ov.frame(1000 + 16 * f)).toBe(true);
    }
    h.can.ctx.take();
    ov.predicted(null, 0, '');
    expect(clears(h.can.ctx.take()).length).toBe(1);
  });
});

describe('weld ring, size ring, lasso', () => {
  it('the weld ring fades in over ~140 ms and then needs no frames', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    ov.weld([200, 200], 10);
    let t = performance.now(), n = 0;
    while (ov.frame(t) && n < 100) { t += 16; n++; }
    expect(n * 16).toBeGreaterThanOrEqual(120);
    expect(n * 16).toBeLessThanOrEqual(200);
    h.can.ctx.take();
    ov.weld(null, 0);
    expect(clears(h.can.ctx.take()).length).toBe(1);
  });

  it('the size ring shows at true size and fades out on hide', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    h.can.ctx.take();
    ov.sizeRing([400, 300], 48, '#ffcc00');
    const b = unionBox(paint(h.can.ctx.take()));
    expect(b.x1 - b.x0).toBeGreaterThanOrEqual(48);
    expect(b.x1 - b.x0).toBeLessThan(60);
    ov.sizeRing(null, 0, '');
    let t = performance.now(), n = 0;
    while (ov.frame(t) && n < 100) { t += 16; n++; }
    expect(n).toBeGreaterThan(3);
    expect(n * 16).toBeLessThanOrEqual(200);
  });

  it('the lasso is a dashed accent path with a faint fill', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    h.can.ctx.take();
    ov.lasso(Float64Array.of(100, 100, 200, 100, 200, 200, 120, 220));
    const ops = paint(h.can.ctx.take());
    const acc = GROUND_TOKENS.night.accent;
    expect(ops.some(o => o.op === 'fill' && o.style === acc && o.alpha < 0.2)).toBe(true);
    expect(ops.some(o => o.op === 'stroke' && o.style === acc && o.dash > 0)).toBe(true);
    ov.lasso(null);
  });
});

describe('eraser ring and doom mask (DESIGN §6.2)', () => {
  it('covers doomed strokes with their own outlines in the ground colour at α 0.75', () => {
    const h = new FakeOverlayHost();
    withStroke(h, 'a', 300, 250);
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    h.can.ctx.take();
    ov.eraser([320, 260], 16, ['a']);
    const ops = paint(h.can.ctx.take());
    const mask = ops.filter(o => o.op === 'fill' && o.style === GROUND_TOKENS.night.bg && o.alpha === 0.75);
    expect(mask.length).toBe(1);
    expect(mask[0].subpaths).toBeGreaterThan(5);
    // the mask lies over the stroke (origin 300,250 → screen 300,250 with the camera centred at 400,300)
    const s = h.strokes.get('a')!.c.inkBox;
    expect(mask[0].box.x0).toBeGreaterThanOrEqual(s.x0 - 2);
    expect(mask[0].box.x1).toBeLessThanOrEqual(s.x1 + 2);
    // moving the ring without changing the doomed set repaints only the ring region
    ov.eraser([330, 262], 16, ['a']);
    const c = unionBox(clears(h.can.ctx.take()));
    expect(c.x1 - c.x0).toBeLessThan(60);
    ov.eraser(null, 0, []);
    const off = h.can.ctx.take();
    expect(paint(off).length).toBe(0);
  });
});

describe('selection (DESIGN §3.4)', () => {
  it('draws a 1 px accent ring 1.5 px off the ink (stroke, then ink and gap cut away) and dashed bounds', () => {
    const h = new FakeOverlayHost();
    withStroke(h, 'a', 300, 250);
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    h.can.ctx.take();
    ov.selection(h.strokes.get('a')!.c.inkBox, ['a']);
    const ops = paint(h.can.ctx.take());
    const acc = GROUND_TOKENS.night.accent;
    const outline = ops.find(o => o.op === 'stroke' && o.style === acc && o.lineWidth === 5);
    expect(outline).toBeDefined();
    expect(ops.some(o => o.op === 'fill' && o.comp === 'destination-out')).toBe(true);
    // the cut-away band is 1.5 px each side of the ink edge: 5 − 3 = 2 → a 1 px ring each side
    expect(ops.some(o => o.op === 'stroke' && o.comp === 'destination-out' && o.lineWidth === 3)).toBe(true);
    expect(ops.some(o => o.op === 'strokeRect' && o.style === acc && o.dash > 0)).toBe(true);
  });

  it('follows the camera', () => {
    const h = new FakeOverlayHost();
    withStroke(h, 'a', 300, 250);
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    ov.selection(h.strokes.get('a')!.c.inkBox, ['a']);
    const before = unionBox(paint(h.can.ctx.take()).filter(o => o.op === 'strokeRect'));
    h.cam = { ...h.cam, cx: h.cam.cx + 50 };
    ov.frame(1000);
    const after = unionBox(paint(h.can.ctx.take()).filter(o => o.op === 'strokeRect'));
    expect(after.x0).toBeCloseTo(before.x0 - 50, 0);
  });

  it('clear() removes everything', () => {
    const h = new FakeOverlayHost();
    withStroke(h, 'a', 300, 250);
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    ov.selection(h.strokes.get('a')!.c.inkBox, ['a']);
    ov.cursor([10, 10], { kind: 'brush', wCss: 8, angle: 0, css: '#fff' });
    h.can.ctx.take();
    ov.clear();
    const ops = h.can.ctx.take();
    expect(clears(ops).length).toBe(1);
    expect(clears(ops)[0].box).toEqual({ x0: 0, y0: 0, x1: 800, y1: 600 });
    expect(paint(ops).length).toBe(0);
  });
});

describe('ground', () => {
  it('repaints in the new ground tokens after a flip', () => {
    const h = new FakeOverlayHost();
    const ov = createOverlay(h);
    ov.resize(800, 600, 1);
    ov.lasso(Float64Array.of(100, 100, 200, 100, 200, 200));
    h.g = 'paper';
    h.can.ctx.take();
    ov.frame(1000);
    const ops = paint(h.can.ctx.take());
    expect(ops.some(o => o.style === GROUND_TOKENS.paper.accent)).toBe(true);
  });
});
