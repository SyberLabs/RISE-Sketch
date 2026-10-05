/**
 * render-world sandbox: a real Doc + Scene (real cook) + frame loop + jobs driving the real
 * renderer, with procedurally drawn strokes (every Form, nib and ink). `window.__rw` exposes
 * scripted scenarios for sandbox/render-world/shot.mjs: pan/zoom gestures, removals with un-grow,
 * grow-in additions, restyle morphs, ground flips, lift/drop, snapshots, hand-off fidelity.
 *
 * Views (?view=): main (default) · glyphs · empty
 */
import type { Camera, Cooked, FormId, Ground, InkId, NibId, StrokeRecipe, ToolState } from '../../src/core/types';
import { S, PL, INK_ORDER } from '../../src/core/types';
import { createDoc, newMeta } from '../../src/doc/document';
import { freezeRecipe, patchRecipe } from '../../src/doc/commands';
import { createScene } from '../../src/scene/scene';
import { createJobs } from '../../src/sched/jobs';
import { attachJobs, createFrameLoop } from '../../src/sched/frame';
import { cook, cookPreview } from '../../src/ink/cook';
import { DEFAULT_CALIB } from '../../src/ink/calib';
import { assignVariant, GROUND_TOKENS } from '../../src/ink/color';
import { createRenderer } from '../../src/render/renderer';
import { createGlyphs } from '../../src/render/glyphs';
import { inkTableFor } from '../../src/render/raster';
import { drawInk } from '../../src/render/live';
import { panBy, zoomAt } from '../../src/render/camera';

const params = new URLSearchParams(location.search);
const viewName = params.get('view') ?? 'main';
const groundParam = (params.get('ground') as Ground | null) ?? 'night';

let seedState = Number(params.get('seed') ?? 4242) >>> 0;
const rnd = (): number => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296; };

// ---------------------------------------------------------------------------- strokes

type P3 = [number, number, number];

function wave(x0: number, y0: number, len: number, amp: number, cycles: number, ang: number, n = 90): P3[] {
  const out: P3[] = [];
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const lx = u * len, ly = Math.sin(u * Math.PI * 2 * cycles) * amp;
    out.push([x0 + lx * ca - ly * sa, y0 + lx * sa + ly * ca, 0.25 + 0.6 * Math.sin(Math.min(1, u * 1.2) * Math.PI)]);
  }
  return out;
}
function loop(cx: number, cy: number, r: number, n = 110): P3[] {
  const out: P3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * 1.02 - Math.PI / 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8, 0.55 + 0.25 * Math.sin(a * 3)]);
  }
  return out;
}

interface Spec { form: FormId; nib: NibId; ink: InkId; base: number; size?: number; closed?: boolean; pools?: number[] }

function recipe(doc: ReturnType<typeof createDoc>, spec: Spec, path: P3[], z: number): StrokeRecipe {
  const ox = path[0][0], oy = path[0][1];
  const samples = new Float32Array(path.length * S.STRIDE);
  let t = 0, len = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) { const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]) * z; len += d; t += Math.max(0.5, d / 0.9); }
    const o = i * S.STRIDE;
    samples[o + S.X] = path[i][0] - ox; samples[o + S.Y] = path[i][1] - oy; samples[o + S.T] = t;
    samples[o + S.P] = path[i][2]; samples[o + S.ALT] = 1.1; samples[o + S.AZ] = 0.8; samples[o + S.R] = NaN;
  }
  const pools = new Float32Array(spec.pools ? spec.pools.length / 2 * PL.STRIDE : 0);
  if (spec.pools) for (let k = 0; k < spec.pools.length / 2; k++) { pools[k * PL.STRIDE + PL.S] = spec.pools[2 * k] * len; pools[k * PL.STRIDE + PL.A] = spec.pools[2 * k + 1]; }
  const size = spec.size ?? (spec.nib === 'pen' ? 2.5 : spec.nib === 'brush' ? 9 : 12);
  return freezeRecipe({
    id: doc.nextId(), created: Date.now(), origin: [ox, oy], z, rot: 0, seed: doc.nextSeed(), device: 'pen',
    calib: DEFAULT_CALIB.pen, stroke: { nib: spec.nib, size },
    color: assignVariant(spec.ink, doc.nextVariant(spec.ink), null, null),
    form: { form: spec.form, v: 1, base: spec.base }, s0: 0, cut: 0, resume: null, samples, pools,
    closed: !!spec.closed, radial: false, sym: null, xf: null,
  });
}

const FORMS: FormId[] = ['line', 'echo', 'sprout', 'drift'];
const NIBS: NibId[] = ['pen', 'brush', 'chisel'];

function randomRecipes(doc: ReturnType<typeof createDoc>, n: number, area: { x0: number; y0: number; w: number; h: number }): StrokeRecipe[] {
  const out: StrokeRecipe[] = [];
  for (let i = 0; i < n; i++) {
    const form = FORMS[Math.floor(rnd() * 4)];
    const nib = NIBS[Math.floor(rnd() * 3)];
    const ink = INK_ORDER[Math.floor(rnd() * INK_ORDER.length)];
    const base = form === 'line' ? Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
    const x = area.x0 + rnd() * area.w, y = area.y0 + rnd() * area.h;
    const closed = form === 'echo' && rnd() < 0.3;
    const path = closed ? loop(x, y, 50 + rnd() * 60) : wave(x - 120, y, 160 + rnd() * 260, 10 + rnd() * 50, 0.5 + rnd() * 1.5, (rnd() - 0.5) * 1.2);
    const pools = rnd() < 0.25 ? [0.6, 1.5] : undefined;
    out.push(recipe(doc, { form, nib, ink, base, closed, pools }, path, 1));
  }
  return out;
}

// ---------------------------------------------------------------------------- world

const stage = document.getElementById('stage')!;
const hud = document.getElementById('hud')!;
const meta = newMeta(Date.now(), 0x5eed, 'sandbox');
meta.ground = groundParam;
const doc = createDoc(meta);
const jobs = createJobs();
const loop2 = createFrameLoop();
const scene = createScene({ doc, cook, jobs, requestFrame: () => loop2.request() });
let reduced = params.get('reduced') === '1';
const renderer = createRenderer({ root: stage, doc, scene, requestFrame: () => loop2.request(), reducedMotion: () => reduced });
let frameMs: number[] = [];
loop2.add((now, budget) => {
  const t0 = performance.now();
  const more = renderer.frame(now, budget);
  frameMs.push(performance.now() - t0);
  if (frameMs.length > 600) frameMs.shift();
  return more;
}, 10);
attachJobs(loop2, jobs);

let cam: Camera = { cx: 800, cy: 500, scale: 1, rot: 0 };
function size(): void { renderer.resize(innerWidth, innerHeight, devicePixelRatio || 1); renderer.setCamera(cam, 'settled'); }
addEventListener('resize', size);
size();
renderer.setGround(groundParam, false);

function updateHud(): void {
  const s = renderer.stats;
  hud.textContent = `strokes ${doc.size} · tiles ${s.tiles} · pending ${s.pendingTiles} · anim ${s.animating} · canvas ${(s.canvasBytes / 1048576).toFixed(1)} MB · dpr ${renderer.dpr.toFixed(2)}`;
}
setInterval(updateHud, 250);

function idle(timeout = 8000): Promise<boolean> {
  const t0 = performance.now();
  return new Promise(res => {
    const check = (): void => {
      const s = renderer.stats;
      if (!loop2.running && jobs.pending === 0 && s.pendingTiles === 0 && s.animating === 0 && !renderer.busy) { res(true); return; }
      if (performance.now() - t0 > timeout) { res(false); return; }
      setTimeout(check, 30);
    };
    setTimeout(check, 40);
  });
}

function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
}

const api = {
  doc, scene, renderer, jobs, loop: loop2,
  idle,
  setReduced(on: boolean) { reduced = on; },
  frameStats() {
    const f = frameMs.slice().sort((a, b) => a - b);
    const q = (p: number): number => f[Math.min(f.length - 1, Math.floor(p * f.length))] || 0;
    const r = { n: f.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +(f[f.length - 1] || 0).toFixed(2) };
    frameMs = [];
    return r;
  },
  seed(n: number, anim: 'none' | 'grow' = 'none', area = { x0: 80, y0: 60, w: 1500, h: 900 }): string[] {
    const rs = randomRecipes(doc, n, area);
    doc.apply({ k: 'add', recipes: rs });
    renderer.strokesAdded(rs, anim);
    return rs.map(r => r.id);
  },
  addSpec(spec: Spec, path: P3[], anim: 'none' | 'grow' = 'none'): string {
    const r = recipe(doc, spec, path, cam.scale);
    doc.apply({ k: 'add', recipes: [r] });
    renderer.strokesAdded([r], anim);
    return r.id;
  },
  /** A stroke committed through the live layer (two-phase bake path). */
  commitLive(spec: Spec, path: P3[]): string {
    const r = recipe(doc, spec, path, cam.scale);
    const c = cook(r);
    scene.putFor(r, c);
    doc.apply({ k: 'add', recipes: [r] });
    renderer.live.commit(r, c);
    return r.id;
  },
  remove(ids: string[], anim: 'ungrow' | 'fade' | 'none' = 'ungrow'): void {
    const before = ids.map(id => doc.get(id)!).filter(Boolean);
    doc.apply({ k: 'remove', ids });
    renderer.strokesRemoved(before, anim);
  },
  restyle(ids: string[], ink: InkId, anim: 'morph' | 'none' = 'morph'): void {
    const before = ids.map(id => doc.get(id)!);
    const after = before.map(r => patchRecipe(r, { color: assignVariant(ink, r.color.k, null, null) }, 'color'));
    doc.apply({ k: 'replace', before, after });
    renderer.strokesReplaced(before, after, anim);
  },
  regrow(ids: string[], form: FormId, anim: 'morph' | 'none' = 'morph'): void {
    const before = ids.map(id => doc.get(id)!);
    const after = before.map(r => patchRecipe(r, { form: { form, v: 1, base: 2 } }, 'geometry'));
    doc.apply({ k: 'replace', before, after });
    renderer.strokesReplaced(before, after, anim);
  },
  camera(c: Partial<Camera>, phase: 'gesture' | 'settled' = 'settled'): void {
    cam = { ...cam, ...c };
    renderer.setCamera(cam, phase);
  },
  pan(dx: number, dy: number, phase: 'gesture' | 'settled' = 'gesture'): void {
    cam = panBy(cam, dx, dy);
    renderer.setCamera(cam, phase);
  },
  zoom(f: number, phase: 'gesture' | 'settled' = 'gesture'): void {
    cam = zoomAt(cam, f, innerWidth / 2, innerHeight / 2, innerWidth, innerHeight);
    renderer.setCamera(cam, phase);
  },
  ground(g: Ground, anim = true): void { renderer.setGround(g, anim); },
  lift(ids: string[]): Promise<void> { return renderer.lift(ids); },
  drop(): Promise<void> { return renderer.drop(); },
  async snapshotRoundTrip(): Promise<{ bytes: number; type: string }> {
    const b = await renderer.snapshot(800);
    if (!b) return { bytes: 0, type: '' };
    const bmp = await createImageBitmap(b);
    renderer.reset('none');
    renderer.showSnapshot(bmp, renderer.getCamera());
    return { bytes: b.size, type: b.type };
  },
  reset(anim: 'fade' | 'none' = 'fade'): void { renderer.reset(anim); },
  ids(): string[] { return doc.ordered().map(r => r.id); },
  stats() { return { ...renderer.stats, ledger: renderer.ledger.byTag() }; },
  /**
   * Hand-off fidelity (DESIGN §6.2): a lone stroke drawn the live way (viewMatrix into a viewport
   * canvas) vs the same stroke baked into tiles and composited into #base.
   */
  async handoff(spec: Spec, path: P3[]): Promise<{ px: number; over2: number; maxDiff: number; nonzero: number }> {
    const id = api.addSpec(spec, path, 'none');
    await idle();
    const r = doc.get(id)!;
    const c = scene.cooked(id)!;
    const base = document.getElementById('base') as HTMLCanvasElement;
    const live = document.createElement('canvas');
    live.width = base.width; live.height = base.height;
    const lctx = live.getContext('2d')!;
    const paper = renderer.host.ground() === 'paper';
    if (paper) { lctx.fillStyle = '#fff'; lctx.fillRect(0, 0, live.width, live.height); }  // Paper tiles start white
    drawInk(lctx, c, inkTableFor(r, renderer.host.ground()), renderer.host.matrixFor(r.origin), r.form.form, {});
    const A = pixels(live), B = pixels(base);
    let over2 = 0, maxDiff = 0, nonzero = 0;
    for (let p = 0; p < A.length; p += 4) {
      if (paper && B[p + 3] === 0) continue;  // no tile there (empty): ground shows, as white would
      const inked = paper ? (A[p] < 255 || A[p + 1] < 255 || A[p + 2] < 255 || B[p] < 255 || B[p + 1] < 255 || B[p + 2] < 255) : (A[p + 3] > 0 || B[p + 3] > 0);
      if (!inked) continue;
      nonzero++;
      let m = 0;
      for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A[p + k] - B[p + k]));
      if (m > 2) over2++;
      if (m > maxDiff) maxDiff = m;
    }
    return { px: A.length / 4, over2, maxDiff, nonzero };
  },
  probe(x: number, y: number): number[] {
    const base = document.getElementById('base') as HTMLCanvasElement;
    const d = renderer.dpr;
    return Array.from(base.getContext('2d')!.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data);
  },
};
(window as unknown as { __rw: typeof api }).__rw = api;

// ---------------------------------------------------------------------------- views

if (viewName === 'glyphs') {
  stage.style.display = 'none';
  const gal = document.getElementById('gallery')!;
  gal.style.display = 'block';
  const g = createGlyphs({ scene: () => scene });
  const grid = document.createElement('div');
  grid.className = 'gal';
  gal.appendChild(grid);
  const last = randomRecipes(doc, 1, { x0: 0, y0: 0, w: 1, h: 1 })[0];
  const lastSprout = recipe(doc, { form: 'sprout', nib: 'brush', ink: 'moss', base: 2, pools: [0.7, 1.5] }, wave(0, 0, 260, 40, 1, -0.3), 1.5);
  const tool: ToolState = {
    nib: 'brush', lastNib: 'brush', sizes: { pen: 2.5, brush: 9, chisel: 12, charcoal: 7 }, ink: 'moss', custom: null,
    recents: [], form: 'sprout', base: { line: 1, echo: 2, sprout: 2, drift: 3, ripple: 2 }, mode: 'draw', mirror: null,
  };
  void last;
  for (const ground of ['night', 'paper'] as const) {
    const tok = GROUND_TOKENS[ground];
    const side = document.createElement('div');
    side.className = 'side';
    side.style.background = tok.bg;
    side.style.color = tok.text;
    side.innerHTML = `<h2>${ground}</h2>`;
    grid.appendChild(side);
    const row = (): HTMLDivElement => { const r = document.createElement('div'); r.className = 'row'; side.appendChild(r); return r; };
    const cell = (r: HTMLDivElement, label: string, cls: string): HTMLCanvasElement => {
      const d = document.createElement('div');
      d.className = 'cell';
      d.style.background = tok.ui;
      const c = document.createElement('canvas');
      c.className = cls;
      const s = document.createElement('span');
      s.textContent = label;
      d.append(c, s);
      r.appendChild(d);
      return c;
    };
    const fit = (c: HTMLCanvasElement): void => { c.width = Math.round(c.clientWidth * devicePixelRatio); c.height = Math.round(c.clientHeight * devicePixelRatio); };
    const chips = row();
    for (const [lab, t, which, er] of [
      ['stroke', tool, 'stroke', false], ['pen', { ...tool, nib: 'pen' as NibId }, 'stroke', false], ['chisel', { ...tool, nib: 'chisel' as NibId, ink: 'indigo' as InkId }, 'stroke', false],
      ['erase', { ...tool, mode: 'erase' as const }, 'stroke', true], ['color', tool, 'color', false], ['spectral', { ...tool, ink: 'spectral' as InkId }, 'color', false],
      ['form', tool, 'form', false], ['echo 3', { ...tool, form: 'echo' as FormId, base: { ...tool.base, echo: 3 } }, 'form', false], ['drift', { ...tool, form: 'drift' as FormId }, 'form', false],
    ] as [string, ToolState, 'stroke' | 'color' | 'form', boolean][]) {
      const c = cell(chips, lab, 'chip'); fit(c); g.chip(c, which, t, ground, er);
    }
    const nibs = row();
    for (const nib of ['pen', 'brush', 'chisel'] as NibId[]) { const c = cell(nibs, nib, 'tile'); fit(c); g.tile(c, { k: 'nib', nib }, lastSprout, tool, ground); }
    { const c = cell(nibs, 'erase', 'tile'); fit(c); g.tile(c, { k: 'erase' }, lastSprout, tool, ground); }
    const inks = row();
    for (const ink of INK_ORDER) { const c = cell(inks, ink, 'tile'); fit(c); g.tile(c, { k: 'ink', ink }, lastSprout, tool, ground); }
    const forms = row();
    for (const form of FORMS) { const c = cell(forms, form, 'tile'); fit(c); g.tile(c, { k: 'form', form }, lastSprout, tool, ground); }
    const stock = row();
    for (const form of FORMS) { const c = cell(stock, 'stock ' + form, 'tile'); fit(c); g.tile(c, { k: 'form', form }, null, tool, ground); }
    const th = row();
    const docRs = randomRecipes(doc, 30, { x0: 0, y0: 0, w: 1400, h: 900 });
    { const c = cell(th, 'recent', 'thumb'); fit(c); g.thumb(c, docRs, ground); }
  }
  (window as unknown as { __drawn: number }).__drawn = 1;
} else if (viewName !== 'empty') {
  const n = Number(params.get('n') ?? 40);
  api.seed(n, 'none');
  idle(20000).then(() => { (window as unknown as { __drawn: number }).__drawn = 1; });
} else {
  (window as unknown as { __drawn: number }).__drawn = 1;
}
void cookPreview;
void ({} as Cooked);
