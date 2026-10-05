/**
 * Forms lab gallery. One page renders one prototype through the real cook + render path:
 *   /lab/forms/index.html?form=<name>&view=<view>
 * Views: forms (default; gestures at base depth) · paper (same, Paper ground) · depth (sweep)
 *        speed (slow/medium/fast) · live (mid-stroke) · nibs · seeds (taps by pressure)
 *        compare (the prototype beside the four shipped Forms on one gesture)
 * `form` is the file stem of lab/forms/<name>.form.ts.
 */
import type { Camera, ColorStyle, Cooked, FormId, Ground, InkId, NibId, Device, StrokeRecipe } from '../../src/core/types';
import { assignVariant, resolveInk } from '../../src/ink/color';
import { drawCooked, viewMatrix } from '../../src/render/raster';
import { applyGround } from '../../src/render/ground';
import { cook } from '../../src/ink/cook';
import { FORMS } from '../../src/ink/operators/registry';
import { formRecipe, Hand } from '../../tests/ink-forms.fixtures';
import { labCook, labLive, type LabForm, type LabStrokeOpts } from './harness';

interface Item { r: StrokeRecipe; c: Cooked; color: ColorStyle; ghost?: Cooked | null }

const modules = import.meta.glob<LabForm>('./*.form.ts');
const q = new URLSearchParams(location.search);
const formName = q.get('form') ?? 'craze';
const view = q.get('view') ?? 'forms';
const ground: Ground = view === 'paper' ? 'paper' : 'night';
const loader = modules[`./${formName}.form.ts`];
if (!loader) throw new Error(`no lab form '${formName}'; have ${Object.keys(modules).join(', ')}`);
const F = await loader();

// ---------------------------------------------------------------------------- gestures (sp, z = 1)

function signature(seed: number): Hand {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9);
  h.moveTo(150, 110, 1.3, 0.55).arc(200, 110, 50, Math.PI, 1.9 * Math.PI, 1.6);
  h.moveTo(300, 40, 2.3, 0.25);
  return h;
}
function poolStroke(seed: number): { h: Hand; holds: number[] } {
  const h = new Hand(0, 80, { jitter: 0.2, seed, p: 0.5 });
  h.moveTo(70, 40, 0.6, 0.7).moveTo(140, 70, 0.5).moveTo(210, 30, 0.7).moveTo(300, 80, 0.9, 0.4);
  return { h, holds: [95, 2.5, 230, 1.5] };
}
function loop(seed: number): Hand {
  const h = new Hand(170, 90, { jitter: 0.15, seed, p: 0.6 });
  h.arc(110, 90, 60, 0, 2 * Math.PI * 1.01, 0.8);
  return h;
}
function corners(seed: number): Hand {
  const h = new Hand(10, 140, { jitter: 0.2, seed, p: 0.55 });
  h.moveTo(60, 20, 0.5).moveTo(61, 21, 0.05).hold(70).moveTo(130, 150, 0.6).moveTo(131, 149, 0.05).hold(70);
  h.moveTo(200, 20, 0.6).moveTo(201, 21, 0.05).hold(70).moveTo(280, 140, 0.9, 0.3);
  return h;
}
function tap(seed: number, hold: number): Hand {
  const h = new Hand(0, 0, { jitter: 0.05, seed, p: 0.65 });
  h.hold(hold);
  return h;
}
function sweepStroke(seed = 21): Hand {
  const h = new Hand(0, 40, { jitter: 0.2, seed, p: 0.45 });
  h.moveTo(60, 0, 0.7, 0.75).arc(100, 40, 50, -Math.PI / 2, Math.PI / 2, 0.9).moveTo(200, 120, 1.2, 0.35);
  return h;
}

const ink = F.meta.ink;
function mk(h: Hand, o: LabStrokeOpts, ox: number, oy: number, k = 0): Item {
  const { r, c } = labCook(F, h, { ...o, origin: [ox, oy], seed: o.seed ?? 11 + k });
  return { r, c, color: assignVariant(ink, k, null, null) };
}
function mkShipped(h: Hand, form: FormId, ox: number, oy: number, k: number): Item {
  const INK: Record<FormId, InkId> = {
    line: 'graphite', echo: 'indigo', sprout: 'moss', drift: 'rose', ripple: 'ochre',
    craze: 'oxide', plume: 'ochre', caustic: 'spectral', burin: 'graphite', plait: 'indigo', orbit: 'rose',
  };
  const r0 = formRecipe(h.rows(), { form, base: FORMS[form].baseDefault, seed: 11 + k });
  const r: StrokeRecipe = { ...r0, origin: [ox, oy] };
  return { r, c: cook(r), color: assignVariant(INK[form], k, null, null) };
}

// ---------------------------------------------------------------------------- views

function formsView(): Item[] {
  const items: Item[] = [];
  const y = 60;
  items.push(mk(signature(3), {}, 40, y, 0));
  const p = poolStroke(5);
  items.push(mk(p.h, { pools: p.holds }, 420, y, 1));
  items.push(mk(loop(7), { closed: true }, 780, y, 2));
  items.push(mk(corners(9), {}, 1060, y + 10, 3));
  items.push(mk(tap(13, 60), { radial: true }, 1420, y + 60, 4));
  items.push(mk(tap(17, 800), { radial: true, pools: [0, 1.5] }, 1530, y + 140, 5));
  // second row: a long varied stroke, a fast scribble, a heavy slow stroke
  const long = new Hand(20, 40, { jitter: 0.2, seed: 31, p: 0.35 });
  long.moveTo(120, 60, 0.6, 0.8).moveTo(220, 30, 1.4, 0.6).arc(260, 90, 60, -Math.PI / 2, Math.PI / 2, 0.9)
    .moveTo(150, 160, 0.25, 0.9).hold(80).moveTo(150, 260, 0.2, 0.5).arc(220, 260, 70, Math.PI, 2.2 * Math.PI, 1.2).moveTo(420, 300, 2.2, 0.2);
  items.push(mk(long, {}, 40, 360, 6));
  const fast = new Hand(0, 60, { jitter: 0.3, seed: 33, p: 0.3 });
  for (let i = 0; i < 7; i++) fast.moveTo(40 + i * 40, i % 2 ? 0 : 120, 2.6);
  items.push(mk(fast, {}, 560, 420, 7));
  const heavy = new Hand(0, 0, { jitter: 0.15, seed: 35, p: 0.95 });
  heavy.arc(120, 80, 110, Math.PI, 2 * Math.PI, 0.25);
  items.push(mk(heavy, {}, 920, 460, 8));
  const chisel = signature(37);
  items.push(mk(chisel, { nib: 'chisel', size: 12 }, 1240, 420, 9));
  return items;
}
function depthView(): Item[] {
  const items: Item[] = [], dMax = F.ops.dMax, steps = 6;
  for (let k = 0; k < steps; k++) {
    const base = Math.round(((dMax * k) / (steps - 1)) * 4) / 4;
    items.push(mk(sweepStroke(), { base }, 30 + (k % 3) * 560, 60 + Math.floor(k / 3) * 420, 2));
  }
  return items;
}
function speedView(): Item[] {
  const items: Item[] = [];
  [[0.25, 0.85], [0.9, 0.55], [2.4, 0.25]].forEach(([v, p], k) => {
    const h = new Hand(0, 60, { jitter: 0.2, seed: 60 + k, p });
    h.moveTo(120, 20, v).moveTo(240, 70, v).moveTo(380, 30, v);
    items.push(mk(h, {}, 40 + k * 560, 120, k));
    const h2 = new Hand(0, 60, { jitter: 0.2, seed: 70 + k, p });
    h2.moveTo(120, 20, v).moveTo(240, 70, v).moveTo(380, 30, v);
    items.push(mk(h2, { base: F.ops.dMax }, 40 + k * 560, 520, k + 3));
  });
  return items;
}
function nibsView(): Item[] {
  const specs: { nib: NibId; size: number; device: Device; noP?: boolean }[] = [
    { nib: 'pen', size: 2.5, device: 'pen' }, { nib: 'brush', size: 9, device: 'pen' }, { nib: 'brush', size: 22, device: 'pen' },
    { nib: 'chisel', size: 12, device: 'pen' }, { nib: 'brush', size: 9, device: 'mouse', noP: true }, { nib: 'brush', size: 9, device: 'touch', noP: true },
  ];
  return specs.map((s, k) => mk(signature(30 + k), s, 30 + (k % 3) * 560, 80 + Math.floor(k / 3) * 420, k));
}
function seedsView(): Item[] {
  const items: Item[] = [];
  [0.1, 0.35, 0.6, 0.9].forEach((p, k) => {
    [1, 2.5].forEach((base, b) => {
      const h = new Hand(0, 0, { jitter: 0.05, seed: 70 + k, p });
      h.hold(60);
      items.push(mk(h, { radial: true, base }, 110 + (2 * k + b) * 200, 280 + b * 300, k));
    });
  });
  return items;
}
function liveView(): Item[] {
  const stages = labLive(F, signature(40), [0.3, 0.55, 0.8, 1.0], { poolAtTip: 2 });
  return stages.map((s, k) => ({ r: { ...s.r, origin: [40 + (k % 2) * 800, 80 + Math.floor(k / 2) * 420] }, c: s.c, ghost: s.ghost, color: assignVariant(ink, k, null, null) }));
}
function compareView(): Item[] {
  const items: Item[] = [mk(signature(3), {}, 40, 80, 0)];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((f, i) => {
    items.push(mkShipped(signature(3), f, 40 + ((i + 1) % 3) * 560, 80 + Math.floor((i + 1) / 3) * 420, i + 1));
  });
  // second row continues: pool stroke on the lab form, loop on the lab form
  const p = poolStroke(5);
  items.push(mk(p.h, { pools: p.holds }, 40 + 2 * 560, 500, 7));
  return items;
}

// ---------------------------------------------------------------------------- drawing

const dpr = Math.min(3, window.devicePixelRatio || 1);
const VIEWS: Record<string, () => Item[]> = {
  forms: formsView, paper: formsView, depth: depthView, speed: speedView, nibs: nibsView, seeds: seedsView, live: liveView, compare: compareView,
};
const t0 = performance.now();
const items = (VIEWS[view] ?? formsView)();
const cookMs = performance.now() - t0;

const el = document.getElementById('stage')!;
const gEl = document.createElement('div'); gEl.className = 'ground'; el.appendChild(gEl);
const cv = document.createElement('canvas'); el.appendChild(cv);
requestAnimationFrame(() => {
  const w = el.clientWidth, h = el.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d')!;
  applyGround(gEl, ground, false);
  cv.style.mixBlendMode = ground === 'night' ? 'plus-lighter' : 'multiply';
  if (ground === 'paper') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
  const scale = Math.min(w / 1700, h / 1040);
  const cam: Camera = { cx: 850, cy: 520, scale, rot: 0 };
  let pts = 0;
  const t1 = performance.now();
  for (const it of items) {
    const table = resolveInk(it.color, ground);
    drawCooked(ctx, it.c, table, viewMatrix(it.r.origin, cam, w, h, dpr));
    if (it.ghost) drawCooked(ctx, it.ghost, table, viewMatrix(it.r.origin, cam, w, h, dpr));
    pts += it.c.nPts;
  }
  const lab = document.getElementById('label')!;
  lab.textContent = `${F.meta.name} · ${view} · ${items.length} strokes · ${pts} pts · cook ${cookMs.toFixed(1)} ms · draw ${(performance.now() - t1).toFixed(1)} ms — ${F.meta.notes}`;
  (window as unknown as { __drawn: number }).__drawn = 1;
});
