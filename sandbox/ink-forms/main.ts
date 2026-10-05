/**
 * ink-forms sandbox: real recipes cooked by ink/cook.ts and drawn through render-core's
 * drawCooked, composited like the live layer stack (Night: 'lighter' over the CSS ground;
 * Paper: white canvas multiplied over the paper ground).
 *
 * Views (?view=):
 *   forms  (default) Forms × gestures on Night        paper  the same on Paper
 *   depth  each Form across its depth range            live   mid-stroke live views (+ Echo ghost)
 *   nibs   pen / brush / chisel / mouse / finger through Sprout and Line
 *   close  close-ups at ~3× (Line depths with a fine pen, Sprout, Echo, Drift)
 *   speed  slow & heavy / medium / fast & light strokes through each Form
 *   seeds  radial seeds (taps) per Form, light → heavy pressure, base 1 and 2.5
 *   preview cookPreview of a deep stroke: full, then 2500 / 900 / 300 point budgets
 */
import type { Camera, ColorStyle, Cooked, FormId, Ground, InkId, NibId, Device, StrokeRecipe } from '../../src/core/types';
import { assignVariant, resolveInk } from '../../src/ink/color';
import { drawCooked, viewMatrix } from '../../src/render/raster';
import { applyGround } from '../../src/render/ground';
import { cook, cookPreview, createIncrementalCook } from '../../src/ink/cook';
import { FORMS } from '../../src/ink/operators/registry';
import { formRecipe, Hand, Feeder } from '../../tests/ink-forms.fixtures';

interface Item { r: StrokeRecipe; c: Cooked; color: ColorStyle; ghost?: Cooked | null }

const INK: Record<FormId, InkId> = { line: 'graphite', echo: 'indigo', sprout: 'moss', drift: 'rose', ripple: 'ochre' };

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

function mk(h: Hand, form: FormId, o: Partial<{ base: number; nib: NibId; size: number; device: Device; closed: boolean; radial: boolean; pools: number[]; seed: number; noP: boolean; z: number }>, ox: number, oy: number, k = 0): Item {
  const rows = h.rows(o.z ?? 1, !!o.noP);
  const base = o.base ?? FORMS[form].baseDefault;
  const r0 = formRecipe(rows, { form, base, nib: o.nib, size: o.size, device: o.device, closed: o.closed, radial: o.radial, pools: o.pools, seed: o.seed ?? 11 + k, z: o.z });
  const r: StrokeRecipe = { ...r0, origin: [ox, oy] };
  return { r, c: cook(r), color: assignVariant(INK[form], k, null, null) };
}

// ---------------------------------------------------------------------------- views

function formsView(): Item[][] {
  const rows: Item[][] = [];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((form, fi) => {
    const y = 40 + fi * 250, items: Item[] = [];
    const lineBase = form === 'line' ? 1.5 : undefined;
    items.push(mk(signature(3 + fi), form, { base: lineBase }, 40, y, fi));
    const p = poolStroke(5 + fi);
    items.push(mk(p.h, form, { base: form === 'line' ? 0.5 : 1.5, pools: p.holds }, 420, y, fi + 1));
    items.push(mk(loop(7 + fi), form, { closed: true, base: lineBase }, 780, y, fi + 2));
    items.push(mk(corners(9 + fi), form, { base: lineBase }, 1060, y + 10, fi + 3));
    items.push(mk(tap(13 + fi, 60), form, { radial: true }, 1420, y + 60, fi + 4));
    items.push(mk(tap(17 + fi, 800), form, { radial: true, pools: [0, 1.5] }, 1530, y + 140, fi + 5));
    rows.push(items);
  });
  return rows;
}

function depthView(): Item[][] {
  const rows: Item[][] = [];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((form, fi) => {
    const items: Item[] = [], dMax = FORMS[form].dMax;
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const base = Math.round(((dMax * k) / (steps - 1)) * 4) / 4;
      const h = new Hand(0, 40, { jitter: 0.2, seed: 21, p: 0.45 });
      h.moveTo(60, 0, 0.7, 0.75).arc(100, 40, 50, -Math.PI / 2, Math.PI / 2, 0.9).moveTo(200, 120, 1.2, 0.35);
      items.push(mk(h, form, { base }, 30 + k * 280, 40 + fi * 250, 2));
    }
    rows.push(items);
  });
  return rows;
}

function nibsView(): Item[][] {
  const rows: Item[][] = [];
  (['line', 'sprout'] as FormId[]).forEach((form, fi) => {
    const items: Item[] = [];
    const specs: { nib: NibId; size: number; device: Device; noP?: boolean }[] = [
      { nib: 'pen', size: 2.5, device: 'pen' }, { nib: 'brush', size: 9, device: 'pen' }, { nib: 'brush', size: 22, device: 'pen' },
      { nib: 'chisel', size: 12, device: 'pen' }, { nib: 'brush', size: 9, device: 'mouse', noP: true }, { nib: 'brush', size: 9, device: 'touch', noP: true },
    ];
    specs.forEach((s, k) => {
      items.push(mk(signature(30 + k), form, { base: form === 'line' ? 2 : 2, ...s }, 30 + k * 300, 60 + fi * 380, k));
    });
    rows.push(items);
  });
  return rows;
}

function closeView(): Item[][] {
  const items: Item[] = [];
  const h = (seed: number): Hand => {
    const g = new Hand(0, 30, { jitter: 0.2, seed, p: 0.55 });
    g.moveTo(50, 0, 0.6, 0.7).arc(80, 30, 42, -Math.PI / 2, Math.PI / 2, 1.0).moveTo(140, 90, 1.8, 0.35);
    return g;
  };
  [0, 1, 3, 5].forEach((d, k) => items.push(mk(h(50), 'line', { base: d, nib: 'pen', size: 2.5 }, 10 + k * 140, 20, 1)));
  items.push(mk(h(51), 'sprout', { base: 3, nib: 'pen', size: 3 }, 30, 230, 2));
  items.push(mk(h(52), 'sprout', { base: 4, nib: 'brush', size: 7 }, 300, 230, 3));
  items.push(mk(h(53), 'echo', { base: 3, nib: 'pen', size: 2.5 }, 30, 420, 2));
  items.push(mk(h(54), 'drift', { base: 3, nib: 'pen', size: 2.5 }, 300, 420, 2));
  return [items];
}

function speedView(): Item[][] {
  const rows: Item[][] = [];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((form, fi) => {
    const items: Item[] = [];
    [[0.25, 0.85], [0.9, 0.55], [2.4, 0.25]].forEach(([v, p], k) => {
      const h = new Hand(0, 60, { jitter: 0.2, seed: 60 + k, p });
      h.moveTo(120, 20, v).moveTo(240, 70, v).moveTo(380, 30, v);
      items.push(mk(h, form, { base: form === 'line' ? 3 : 2 }, 40 + k * 560, 50 + fi * 250, k));
    });
    rows.push(items);
  });
  return rows;
}

/** Radial seeds (taps) per Form at light → heavy pressure, at base 1 and 2.5. */
function seedsView(): Item[][] {
  const rows: Item[][] = [];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((form, fi) => {
    const items: Item[] = [];
    [0.1, 0.35, 0.6, 0.9].forEach((p, k) => {
      [1, 2.5].forEach((base, b) => {
        const h = new Hand(0, 0, { jitter: 0.05, seed: 70 + k, p });
        h.hold(60);
        items.push(mk(h, form, { radial: true, base }, 110 + (2 * k + b) * 200, 130 + fi * 250, k));
      });
    });
    rows.push(items);
  });
  return rows;
}

/** cookPreview of a deep stroke per Form: full cook, then 2500 / 900 / 300 point budgets. */
function previewView(): Item[][] {
  const rows: Item[][] = [];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((form, fi) => {
    const items: Item[] = [];
    [Infinity, 2500, 900, 300].forEach((lim, k) => {
      const h = signature(80 + fi);
      const r0 = formRecipe(h.rows(), { form, base: FORMS[form].dMax, seed: 5 });
      const r: StrokeRecipe = { ...r0, origin: [40 + k * 420, 40 + fi * 250] };
      items.push({ r, c: cookPreview(r, lim), color: assignVariant(INK[form], 1, null, null) });
    });
    rows.push(items);
  });
  return rows;
}

function liveView(): Item[][] {
  const out: Item[] = [];
  (['line', 'echo', 'sprout', 'drift'] as FormId[]).forEach((form, fi) => {
    for (let k = 0; k < 3; k++) {
      const h = signature(40 + fi);
      const r0 = formRecipe(h.rows(), { form, base: form === 'line' ? 1.5 : 2 });
      const r: StrokeRecipe = { ...r0, origin: [40 + k * 520, 40 + fi * 250] };
      const fd = new Feeder(r);
      const ic = createIncrementalCook(fd.d);
      const stop = Math.floor(fd.total * (0.45 + 0.27 * k));
      while (fd.fed < stop) { const n0 = fd.fed; fd.feed(4); ic.append(fd.fed - n0); }
      if (k === 2) { fd.setPools([ic.spine().L - 4, 2]); ic.regrow(0, 1e9); }
      const v = ic.view();
      out.push({ r, c: v.geom, ghost: v.ghost, color: assignVariant(INK[form], k, null, null) });
    }
  });
  return [out];
}

// ---------------------------------------------------------------------------- drawing

const dpr = Math.min(3, window.devicePixelRatio || 1);
const view = new URLSearchParams(location.search).get('view') ?? 'forms';
const ground: Ground = view === 'paper' ? 'paper' : 'night';
const VIEWS: Record<string, () => Item[][]> = {
  depth: depthView, nibs: nibsView, live: liveView, close: closeView, speed: speedView, seeds: seedsView, preview: previewView,
};
const items = (VIEWS[view] ?? formsView)().flat();

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
  const close = view === 'close';
  const scale = close ? Math.min(w / 580, h / 600) : Math.min(w / 1700, h / 1040);
  const cam: Camera = close ? { cx: 290, cy: 300, scale, rot: 0 } : { cx: 850, cy: 520, scale, rot: 0 };
  let pts = 0;
  const t0 = performance.now();
  for (const it of items) {
    const table = resolveInk(it.color, ground);
    drawCooked(ctx, it.c, table, viewMatrix(it.r.origin, cam, w, h, dpr));
    if (it.ghost) drawCooked(ctx, it.ghost, table, viewMatrix(it.r.origin, cam, w, h, dpr));
    pts += it.c.nPts;
  }
  const lab = document.getElementById('label')!;
  lab.textContent = `${view} · ${items.length} strokes · ${pts} pts · ${(performance.now() - t0).toFixed(1)} ms`;
  (window as unknown as { __drawn: number }).__drawn = 1;
});
