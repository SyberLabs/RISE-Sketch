import { describe, it, expect } from 'vitest';
import { createBloom, BLOOM_ALPHA, CURE_MS } from '../src/render/bloom';
import { capDpr, snapshotDocBox, blendFor, opFor, DIM, MAX_VIEWPORT_PX } from '../src/render/compositor';
import { createLedger } from '../src/render/ledger';

interface FakeEl { width: number; height: number; style: Record<string, string>; offsetWidth: number; ops: string[]; getContext(): unknown }

function fakeEl(): FakeEl {
  const ops: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(t, k: string) { return k in t ? t[k] : (...a: unknown[]) => { ops.push(k + (k === 'drawImage' ? ':' + (a.slice(-2) as number[]).join('x') : '')); }; },
    set(t, k: string, v) { t[k] = v; if (k === 'globalCompositeOperation') ops.push('op=' + v); return true; },
  });
  return { width: 1, height: 1, style: {}, offsetWidth: 1, ops, getContext: () => ctx };
}

function setup(): { a: FakeEl; b: FakeEl; bloom: ReturnType<typeof createBloom>; made: FakeEl[] } {
  const made: FakeEl[] = [];
  const ledger = createLedger('desktop', () => { const e = fakeEl(); made.push(e); return e as unknown as HTMLCanvasElement; });
  const a = fakeEl(), b = fakeEl();
  ledger.adopt(a as unknown as HTMLCanvasElement, 'bloomA');
  ledger.adopt(b as unknown as HTMLCanvasElement, 'bloomB');
  const bloom = createBloom(a as unknown as HTMLCanvasElement, b as unknown as HTMLCanvasElement, ledger);
  bloom.resize(1000, 600, 2);
  return { a, b, bloom, made };
}

const view = (cx: number, cy: number, scale: number) => ({ cam: { cx, cy, scale, rot: 0 }, cssW: 1000, cssH: 600, dpr: 2 });
const src = { width: 2000, height: 1200 } as unknown as HTMLCanvasElement;

describe('bloom', () => {
  it('renders at quarter resolution through a 3-down / 3-up chain', () => {
    const { a, bloom, made } = setup();
    bloom.render(src, view(0, 0, 1), false);
    // back buffer (B) became the front; A untouched
    expect(bloom.front).not.toBeNull();
    const back = bloom.front as unknown as FakeEl;
    expect(back).not.toBe(a);
    expect(back.width).toBe(500);
    expect(back.height).toBe(300);
    expect(made.map(m => m.width + 'x' + m.height)).toEqual(['250x150', '125x75', '63x38']);
    // three downsamples into the chain, three additive mixes back up
    const downs = made.flatMap(m => m.ops.filter(o => o.startsWith('drawImage')));
    expect(downs.length).toBe(3 + 2);  // chain levels receive 3 downs and 2 up-mixes
    expect(back.ops.filter(o => o === 'op=lighter').length).toBe(1);
    expect(back.ops.filter(o => o === 'op=destination-out').length).toBe(1);
  });

  it('cures in: the new buffer fades in while the old one fades out (constant sum)', () => {
    const { a, b, bloom } = setup();
    bloom.render(src, view(0, 0, 1), false);
    expect(b.style.opacity).toBe(String(BLOOM_ALPHA));
    expect(a.style.opacity).toBe('0');
    bloom.render(src, view(0, 0, 1), true);
    expect(bloom.front as unknown).toBe(a);
    expect(a.style.opacity).toBe(String(BLOOM_ALPHA));
    expect(b.style.opacity).toBe('0');
    expect(a.style.transition).toBe(`opacity ${CURE_MS}ms linear`);
    expect(b.style.transition).toBe(`opacity ${CURE_MS}ms linear`);
    // a render during the cure snaps it to its end first
    bloom.render(src, view(0, 0, 1), true);
    expect(bloom.front as unknown).toBe(b);
  });

  it('dims with the selection and turns off on Paper', () => {
    const { b, bloom } = setup();
    bloom.render(src, view(0, 0, 1), false);
    bloom.setDim(true, false);
    expect(Number(b.style.opacity)).toBeCloseTo(BLOOM_ALPHA * DIM, 10);
    bloom.setDim(false, false);
    expect(Number(b.style.opacity)).toBeCloseTo(BLOOM_ALPHA, 10);
    bloom.setEnabled(false, false);
    expect(b.style.opacity).toBe('0');
    expect(bloom.valid).toBe(false);
    bloom.render(src, view(0, 0, 1), false);
    expect(bloom.valid).toBe(false);
  });

  it('follows the camera with a CSS transform during gestures', () => {
    const { b, bloom } = setup();
    bloom.render(src, view(10, 20, 1), false);
    bloom.follow(view(10, 20, 1));
    expect(b.style.transform).toBe('');
    // pan: content moves by −Δc·scale
    bloom.follow(view(15, 20, 1));
    expect(b.style.transform).toBe('translate(-5px, 0px) scale(1)');
    // zoom ×2 about the view centre: a doc point at the centre stays put
    bloom.follow(view(10, 20, 2));
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(b.style.transform)!;
    const tx = +m[1], ty = +m[2], f = +m[3];
    expect(f).toBe(2);
    expect(500 * f + tx).toBeCloseTo(500, 9);
    expect(300 * f + ty).toBeCloseTo(300, 9);
  });

  it('fadeOut fades the shown glow instead of popping it, and invalidates it', () => {
    const { b, bloom } = setup();
    bloom.render(src, view(0, 0, 1), false);
    bloom.fadeOut(200);
    expect(b.style.opacity).toBe('0');
    expect(b.style.transition).toBe('opacity 200ms linear');
    expect(bloom.valid).toBe(false);
    // the next render cures in from nothing
    bloom.render(src, view(0, 0, 1), true);
    expect(bloom.valid).toBe(true);
    expect((bloom.front as unknown as FakeEl).style.opacity).toBe(String(BLOOM_ALPHA));
  });

  it('freeScratch frees only the chain; the shown bloom stays', () => {
    const { b, bloom, made } = setup();
    bloom.render(src, view(0, 0, 1), false);
    bloom.freeScratch();
    expect(made.every(m => m.width === 0)).toBe(true);
    expect(bloom.valid).toBe(true);
    expect(b.width).toBe(500);
    expect(b.style.opacity).toBe(String(BLOOM_ALPHA));
    bloom.render(src, view(0, 0, 1), false);  // the chain is rebuilt on demand
    expect(made.filter(m => m.width > 0).length).toBe(3);
  });

  it('resize drops the content; purge frees the chain', () => {
    const { bloom, made } = setup();
    bloom.render(src, view(0, 0, 1), false);
    expect(bloom.valid).toBe(true);
    bloom.resize(800, 600, 2);
    expect(bloom.valid).toBe(false);
    bloom.purge();
    expect(made.every(m => m.width === 0)).toBe(true);
  });
});

describe('layer helpers', () => {
  it('caps DPR at 3 and the viewport at 8 MP', () => {
    expect(capDpr(2, 1000, 800)).toBe(2);
    expect(capDpr(4, 300, 300)).toBe(3);
    expect(capDpr(NaN, 300, 300)).toBe(1);
    const d = capDpr(3, 2560, 1600);
    expect(2560 * 1600 * d * d).toBeLessThanOrEqual(MAX_VIEWPORT_PX + 1e-6);
    expect(d).toBeLessThan(3);
  });

  it('blend modes per ground', () => {
    expect(blendFor('night')).toBe('plus-lighter');
    expect(blendFor('paper')).toBe('multiply');
    expect(opFor('night')).toBe('lighter');
    expect(opFor('paper')).toBe('multiply');
  });

  it('snapshot extent: same viewport, rotated viewport, or fitted', () => {
    const cam = { cx: 100, cy: 50, scale: 2, rot: 0 };
    expect(snapshotDocBox(500, 400, cam, 1000, 800)).toEqual({ x0: -150, y0: -150, x1: 350, y1: 250 });
    // the device rotated since: the image is the old (portrait) viewport
    const r = snapshotDocBox(400, 500, cam, 1000, 800);
    expect(r.x1 - r.x0).toBeCloseTo(800 / 2, 9);
    expect(r.y1 - r.y0).toBeCloseTo(1000 / 2, 9);
    // unrelated aspect: fitted into the current viewport
    const f = snapshotDocBox(1000, 250, cam, 1000, 800);
    expect((f.x1 - f.x0) / (f.y1 - f.y0)).toBeCloseTo(4, 9);
  });
});
