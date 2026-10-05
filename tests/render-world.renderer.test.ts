/**
 * Renderer choreography (DESIGN §6.2, §3.2, §3.4, §6.7, §6.10) on a fake DOM: holds, two-phase
 * bakes, transactions and the frame they commit in, lift / drop dimming, purge, the blit
 * fallback's bloom source, the cold-load snapshot. Pixels are not checked here (the sandbox
 * does that); the order of tile draws, #base composites and live-layer commits is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Camera, StrokeRecipe } from '../src/core/types';
import type { Glyphs } from '../src/render/types';
import { createRenderer, type RendererImpl } from '../src/render/renderer';
import { createLedger } from '../src/render/ledger';
import { DIM, DIM_MS } from '../src/render/compositor';
import { rstats } from '../src/render/stats';
import {
  FakeDoc, FakeEl, FakeLive, FakeOverlay, FakeScene, cookOf, events, find, installDom, recipeAt, type DomRig,
} from './render-world.dom';

interface Rig {
  dom: DomRig; doc: FakeDoc; scene: FakeScene; live: FakeLive; r: RendererImpl;
  clk: { t: number; step: number };
  el(id: string): FakeEl;
  frame(n?: number): void;
  idle(max?: number): Promise<void>;
}

let current: Rig | null = null;
afterEach(() => { if (current) { current.r.dispose(); current.dom.restore(); current = null; } });

const CAM: Camera = { cx: 500, cy: 300, scale: 1, rot: 0 };

function rig(o: { plusLighter?: boolean } = {}): Rig {
  const dom = installDom(o);
  const doc = new FakeDoc();
  const scene = new FakeScene(doc);
  const clk = { t: 1000, step: 0 };
  let live: FakeLive | null = null;
  const r = createRenderer({
    root: dom.root as unknown as HTMLElement, doc, scene,
    requestFrame: () => undefined,
    reducedMotion: () => false,
    liveFactory: host => { live = new FakeLive(); live.host = host; return live; },
    overlayFactory: host => new FakeOverlay(host),
    glyphs: {} as Glyphs,
    ledger: createLedger('desktop'),
    now: () => (clk.t += clk.step),
  });
  r.resize(1000, 600, 1);
  r.setCamera(CAM, 'settled');
  const R: Rig = {
    dom, doc, scene, live: live!, r, clk,
    el(id) {
      const f = dom.root.children.find(c => c.id === id);
      if (!f) throw new Error('no #' + id);
      return f;
    },
    frame(n = 1) {
      for (let i = 0; i < n; i++) { clk.t += 16; dom.time.advance(16); r.frame(clk.t, 6); }
    },
    async idle(max = 400) {
      for (let i = 0; i < max; i++) {
        for (let k = 0; k < 6; k++) await Promise.resolve();
        if (!r.busy) return;
        R.frame();
      }
      throw new Error('renderer never went idle: ' + JSON.stringify(r.debug()));
    },
  };
  current = R;
  return R;
}

/** Add strokes to the doc and the tiles (no animation), then settle. */
async function seed(R: Rig, rs: StrokeRecipe[]): Promise<void> {
  R.doc.apply({ k: 'add', recipes: rs });
  R.r.strokesAdded(rs, 'none');
  await R.idle();
}

const tileDraws = (from = 0): number => events.slice(from).filter(e => e.el?.label === 'tile' && (e.op === 'fill' || e.op === 'stroke')).length;

describe('layer stack', () => {
  it('creates #ground, #base, #bloomA/B, #dry, #wet, #overlay in order, pointer-events none', () => {
    const R = rig();
    expect(R.dom.root.children.slice(0, 7).map(c => c.id)).toEqual(['ground', 'base', 'bloomA', 'bloomB', 'dry', 'wet', 'overlay']);
    for (const c of R.dom.root.children.slice(0, 7)) expect(c.style.pointerEvents).toBe('none');
    expect(R.el('base').style.mixBlendMode).toBe('plus-lighter');
    R.r.setGround('paper', false);
    expect(R.el('base').style.mixBlendMode).toBe('multiply');
    expect(R.el('dry').style.mixBlendMode).toBe('multiply');
  });
});

describe('two-phase bake', () => {
  it('done() runs right after the #base composite that shows the baked stroke', async () => {
    const R = rig();
    await R.idle();
    const s = recipeAt(1, 400, 250);
    const c = cookOf(s);
    R.doc.apply({ k: 'add', recipes: [s] });
    R.r.live.commit(s, c);
    R.frame(3);
    expect(tileDraws()).toBe(0);  // held by the live layer: never drawn into tiles meanwhile
    const from = events.length;
    R.live.bake(s.id);
    R.frame();
    const iDraw = events.findIndex((e, i) => i >= from && e.el?.label === 'tile' && e.op === 'fill');
    const iComp = find('clearRect', 'base', from);
    const iDone = find('done', '', from);
    expect(iDraw).toBeGreaterThanOrEqual(0);
    expect(iComp).toBeGreaterThan(iDraw);
    expect(iDone).toBeGreaterThan(iComp);
  });

  it('strokesAdded("none") never claims a stroke the live layer still shows', async () => {
    // regression: a live-held stroke was claimed into the tiles too and showed twice until its bake
    const R = rig();
    await R.idle();
    const s = recipeAt(1, 400, 250);
    R.doc.apply({ k: 'add', recipes: [s] });
    R.r.live.commit(s, cookOf(s));
    R.r.strokesAdded([s], 'none');
    R.frame(4);
    expect(tileDraws()).toBe(0);
    expect(R.r.debug().held).toBe(1);
    R.live.bake(s.id);
    R.frame();
    expect(tileDraws()).toBeGreaterThan(0);
    expect(R.live.done.has(s.id)).toBe(true);
    expect(R.r.debug().held).toBe(0);
  });

  it('release() leaves strokes the live layer still shows to their bake', async () => {
    const R = rig();
    const s = recipeAt(1, 400, 250);
    await seed(R, [s]);
    const r = R.r;
    r.hold([s.id]);
    await R.idle();
    r.live.play(s, cookOf(s));  // replay: the hold becomes a live hold
    r.release([s.id]);
    const from = events.length;
    R.frame(3);
    expect(tileDraws(from)).toBe(0);
    R.live.bake(s.id);
    R.frame();
    expect(tileDraws(from)).toBeGreaterThan(0);
    expect(R.live.done.has(s.id)).toBe(true);
  });
});

describe('selection', () => {
  it('drop un-dims first and bakes the strokes back only after the transition', async () => {
    // regression: dropped strokes went from full strength in #dry into a #base still at 45%,
    // flashing down and back up during the 160 ms un-dim
    const R = rig();
    const a = recipeAt(1, 300, 200), b = recipeAt(2, 600, 350);
    await seed(R, [a, b]);
    const base = R.el('base');
    const lifting = R.r.lift([a.id]);
    await R.idle();
    await lifting;
    expect(base.style.opacity).toBe(String(DIM));
    expect(R.live.lifted?.map(i => i.r.id)).toEqual([a.id]);

    const from = events.length;
    const dropping = R.r.drop();
    for (let k = 0; k < 6; k++) await Promise.resolve();
    expect(base.style.opacity).toBe('1');                // the un-dim has started...
    expect(base.style.transition).toContain(`${DIM_MS}ms`);
    R.frame(2);                                          // 32 ms later
    expect(find('live.setLifted', '', from)).toBe(-1);   // ...while the selection layer still holds them
    R.frame(Math.ceil(DIM_MS / 16));
    await dropping;
    const iSet = find('live.setLifted', '', from);
    expect(iSet).toBeGreaterThan(find('clearRect', 'base', from));
    expect(events[iSet].args[0]).toBeNull();
    expect(base.style.opacity).toBe('1');
    expect(base.style.transition).toBe('none');
  });

  it('deleting the whole lifted selection un-dims the drawing', async () => {
    const R = rig();
    const a = recipeAt(1, 300, 200), b = recipeAt(2, 600, 350);
    await seed(R, [a, b]);
    const lifting = R.r.lift([a.id]);
    await R.idle();
    await lifting;
    expect(R.el('base').style.opacity).toBe(String(DIM));
    R.doc.apply({ k: 'remove', ids: [a.id] });
    R.r.strokesRemoved([a], 'ungrow');
    await R.idle();
    expect(R.el('base').style.opacity).toBe('1');
    expect(R.live.lifted).toBeNull();
  });

  it('previewLifted ignores strokes that are not lifted (they are still in the tiles)', async () => {
    const R = rig();
    const a = recipeAt(1, 300, 200);
    await seed(R, [a]);
    const from = events.length;
    R.r.previewLifted([{ r: a, c: cookOf(a) }]);
    const i = find('live.setLifted', '', from);
    expect(events[i].args[0]).toBeNull();
  });
});

describe('restyle', () => {
  it('a restyle without animation waits for the new geometry before re-rendering (no blink)', async () => {
    const R = rig();
    const a = recipeAt(1, 300, 200);
    await seed(R, [a]);
    R.scene.autoCook = false;
    const a2: StrokeRecipe = { ...a, stroke: { nib: 'pen', size: 6 }, geomRev: 1 };
    R.doc.apply({ k: 'replace', before: [a], after: [a2] });
    R.r.strokesReplaced([a], [a2], 'none');
    const from = events.length;
    R.frame(4);
    expect(find('clearRect', 'tile', from)).toBe(-1);  // the tiles keep the old version meanwhile
    expect(R.r.busy).toBe(true);
    R.scene.cookNow([a.id]);
    await R.idle();
    expect(find('clearRect', 'tile', from)).toBeGreaterThanOrEqual(0);
    expect(tileDraws(from)).toBeGreaterThan(0);
  });
});

describe('purge', () => {
  it('#base keeps its picture until the view is rebuilt (no blank flash)', async () => {
    const R = rig();
    // three strokes in three different tiles
    await seed(R, [recipeAt(1, 100, 100), recipeAt(2, 700, 100), recipeAt(3, 100, 520)]);
    R.r.purge();
    expect(R.r.stats.tiles).toBe(0);
    let from = events.length;
    R.frame(3);
    expect(find('clearRect', 'base', from)).toBe(-1);  // suspended: nothing composites
    R.clk.step = 2.5;  // tile work now spans several frames
    R.dom.time.advance(2100);  // the purge rest ends
    from = events.length;
    let comps = 0, drawsAtFirst = -1;
    for (let i = 0; i < 40 && R.r.busy; i++) {
      R.frame();
      const c = events.slice(from).filter(e => e.el?.label === 'base' && e.op === 'clearRect').length;
      if (c > 0 && drawsAtFirst < 0) drawsAtFirst = tileDraws(from);
      comps = c;
    }
    expect(comps).toBeGreaterThan(0);
    expect(drawsAtFirst).toBe(3);  // the first composite already had every visible stroke
  });
});

describe('blit fallback (no CSS plus-lighter)', () => {
  it('the bloom is made from the tiles, never from #base (which holds the painted ground)', async () => {
    // regression: blooming #base lifted the ground by ~30% and fed the bloom back into itself
    const R = rig({ plusLighter: false });
    expect(R.el('base').style.mixBlendMode).toBe('normal');
    await seed(R, [recipeAt(1, 400, 250)]);
    const renders = events.filter(e => (e.el?.label === 'bloomA' || e.el?.label === 'bloomB') && e.op === 'drawImage');
    expect(renders.length).toBeGreaterThan(0);
    for (const e of renders) expect((e.args[0] as FakeEl).id).not.toBe('base');
    expect((renders[0].args[0] as FakeEl).width).toBe(1000);  // the viewport-sized tile composite
  });
});

describe('blit fallback: commits', () => {
  it('#base is re-layered after commits change #dry (a bake during a gesture)', async () => {
    // regression: #base was layered (tiles + #dry) BEFORE the commits ran, so a baked stroke
    // stayed doubled in #base until some later live change
    const R = rig({ plusLighter: false });
    await R.idle();
    const s = recipeAt(1, 400, 250);
    R.doc.apply({ k: 'add', recipes: [s] });
    R.r.live.commit(s, cookOf(s));
    R.frame(2);
    const from = events.length;
    R.r.setCamera({ ...CAM, cx: CAM.cx + 3 }, 'gesture');  // no bloom refresh until settle
    R.live.bake(s.id);
    R.frame();
    const iDone = find('done', '', from);
    expect(iDone).toBeGreaterThan(0);
    const relayer = events.slice(iDone).some(e => e.el?.label === 'base' && e.op === 'drawImage' && (e.args[0] as FakeEl).id === 'dry');
    expect(relayer).toBe(true);
  });
});

describe('grounds and resets', () => {
  async function bloomed(R: Rig): Promise<FakeEl> {
    await seed(R, [recipeAt(1, 400, 250)]);
    const front = [R.el('bloomA'), R.el('bloomB')].find(e => e.style.opacity === '0.3');
    if (!front) throw new Error('no bloom shown');
    return front;
  }

  it('an animated ground swap keeps the glow until the swap, then fades it with the old picture', async () => {
    const R = rig();
    const front = await bloomed(R);
    R.r.setGround('paper', true);
    expect(front.style.opacity).toBe('0.3');  // still glowing over the old picture
    await R.idle();
    expect(front.style.opacity).toBe('0');
    expect(front.style.transition).toContain('400ms');
  });

  it('reset("fade") fades the bloom out with #base instead of popping it off', async () => {
    const R = rig();
    const front = await bloomed(R);
    R.r.reset('fade');
    expect(front.style.opacity).toBe('0');
    expect(front.style.transition).toBe('opacity 200ms linear');
  });
});

describe('cold-load snapshot', () => {
  const img = { width: 500, height: 300 } as unknown as HTMLImageElement;
  const hasSnap = (R: Rig): boolean => R.dom.root.children.some(c => c.id === 'snap');

  it('a stroke removed before it cooks no longer keeps its cell under the snapshot', async () => {
    const R = rig();
    R.scene.autoCook = false;
    const a = recipeAt(1, 300, 200);
    R.doc.apply({ k: 'add', recipes: [a] });
    R.r.strokesAdded([a], 'none');
    R.r.showSnapshot(img, CAM);
    R.frame(3);
    expect(hasSnap(R)).toBe(true);  // a's tile is waiting for its cook
    R.doc.apply({ k: 'remove', ids: [a.id] });
    R.r.strokesRemoved([a], 'none');
    R.frame(3);
    expect(hasSnap(R)).toBe(false);  // every cell is complete now: the snapshot is uncovered
  });

  it('edits punch holes into the snapshot; reset drops it', async () => {
    const R = rig();
    R.scene.autoCook = false;
    const a = recipeAt(1, 300, 200), b = recipeAt(2, 320, 230);
    R.scene.cookNow([]);
    R.doc.apply({ k: 'add', recipes: [a, b] });
    R.scene.cookNow([b.id]);
    R.r.strokesAdded([a, b], 'none');
    R.r.showSnapshot(img, CAM);
    R.frame(3);
    expect(hasSnap(R)).toBe(true);
    const from = events.length;
    R.doc.apply({ k: 'remove', ids: [b.id] });
    R.r.strokesRemoved([b], 'none');
    R.frame(3);
    // b's region is cleared from the snapshot (the image still shows b there)
    const cb = cookOf(b).inkBox;
    // clears after the last time the image was drawn (drawSnap starts with a full clear)
    let lastImg = -1;
    events.forEach((e, i) => { if (i >= from && e.el?.label === 'snap' && e.op === 'drawImage') lastImg = i; });
    expect(lastImg).toBeGreaterThan(0);
    const holes = events.slice(lastImg).filter(e => e.el?.label === 'snap' && e.op === 'clearRect').map(e => e.args as number[]);
    const covers = holes.some(([x, y, w, h]) => x <= cb.x0 - CAM.cx + 500 && y <= cb.y0 - CAM.cy + 300 && x + w >= cb.x1 - CAM.cx + 500 && y + h >= cb.y1 - CAM.cy + 300);
    expect(covers).toBe(true);
    expect(hasSnap(R)).toBe(true);
    R.r.reset('none');
    expect(hasSnap(R)).toBe(false);
  });
});

describe('busy', () => {
  it('stays true while a cook the renderer waits for is pending', async () => {
    const R = rig();
    R.scene.autoCook = false;
    const a = recipeAt(1, 300, 200);
    R.doc.apply({ k: 'add', recipes: [a] });
    R.r.strokesAdded([a], 'grow');
    for (let k = 0; k < 6; k++) await Promise.resolve();
    R.frame(2);
    expect(R.r.debug().txns).toBe(0);
    expect(R.r.busy).toBe(true);
    R.scene.cookNow([a.id]);
    for (let k = 0; k < 6; k++) await Promise.resolve();
    R.frame();
    expect(find('live.grow')).toBeGreaterThanOrEqual(0);
  });
});

describe('camera gestures (DESIGN §6.9, §9 pan / zoom frame)', () => {
  const baseBlits = (from: number): number => events.slice(from).filter(e => e.el?.label === 'base' && e.op === 'drawImage').length;

  it('a zoom-in frame moves the last composite by CSS transform; the settle re-composites', async () => {
    const R = rig();
    await seed(R, [recipeAt(1, 300, 200), recipeAt(2, 700, 400)]);
    const from = events.length;
    const x0 = rstats.c.transformOnly;
    R.r.setCamera({ ...CAM, scale: 1.1 }, 'gesture');
    R.frame();
    expect(baseBlits(from)).toBe(0);
    expect(R.el('base').style.transform).toMatch(/scale\(1\.1/);
    // back to where #base was drawn: no transform, still no canvas work
    R.r.setCamera(CAM, 'gesture');
    R.frame();
    expect(baseBlits(from)).toBe(0);
    expect(R.el('base').style.transform).toBe('');
    expect(rstats.c.transformOnly - x0).toBe(2);
    R.r.setCamera({ ...CAM, scale: 1.1 }, 'gesture');
    R.frame();
    R.r.setCamera({ ...CAM, scale: 1.1 }, 'settled');
    await R.idle();
    expect(baseBlits(from)).toBeGreaterThan(0);
    expect(R.el('base').style.transform).toBe('');
  });

  it('a pan or a zoom out exposes area the last composite lacks: those frames re-composite', async () => {
    const R = rig();
    await seed(R, [recipeAt(1, 300, 200)]);
    let from = events.length;
    R.r.setCamera({ ...CAM, cx: CAM.cx + 40 }, 'gesture');
    R.frame();
    expect(baseBlits(from)).toBeGreaterThan(0);
    from = events.length;
    R.r.setCamera({ ...CAM, cx: CAM.cx + 40, scale: 0.9 }, 'gesture');
    R.frame();
    expect(baseBlits(from)).toBeGreaterThan(0);
    expect(R.el('base').style.transform || '').toBe('');
  });

  it('a transform-only #base is composited for the current camera before a snapshot reads it', async () => {
    const R = rig();
    await seed(R, [recipeAt(1, 300, 200)]);
    R.r.setCamera({ ...CAM, scale: 1.2 }, 'gesture');
    R.frame();
    expect(R.el('base').style.transform).not.toBe('');
    const from = events.length;
    void R.r.snapshot(0);
    expect(baseBlits(from)).toBeGreaterThan(0);
    expect(R.el('base').style.transform).toBe('');
  });

  it('the glow waits for the gesture to end and renders once; a settled camera settles at once', async () => {
    const R = rig();
    await seed(R, [recipeAt(1, 300, 200)]);
    const b0 = rstats.c.bloomRenders;
    R.r.setCamera({ ...CAM, cx: CAM.cx + 40 }, 'gesture');
    R.frame(20);  // longer than SETTLE_MS: missing tiles render, the glow keeps following by transform
    expect(R.r.debug().settled).toBe(true);
    expect(rstats.c.bloomRenders).toBe(b0);
    R.r.setCamera({ ...CAM, cx: CAM.cx + 40 }, 'settled');  // the gesture ends where it stood
    expect(R.r.debug().settled).toBe(true);
    await R.idle();
    expect(rstats.c.bloomRenders).toBe(b0 + 1);
    // a settled camera move (fit, reset) renders without waiting out the settle delay
    R.r.setCamera({ ...CAM, cx: CAM.cx + 900 }, 'settled');
    expect(R.r.debug().settled).toBe(true);
  });
});
