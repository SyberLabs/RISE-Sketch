/**
 * render-core sandbox: hand-built synthetic Cooked strokes drawn through drawCooked on both
 * grounds, composited exactly like the real layer stack (Night: transparent canvas, 'lighter',
 * CSS plus-lighter over the CSS ground; Paper: white canvas, 'multiply', CSS multiply).
 *
 * Views (?view=): main (default) · zoom · zoom2 · zoom3 · lod · reveal · export · ground · review
 */
import type { Camera, ColorStyle, Cooked, Ground, InkId } from '../../src/core/types';
import { PolyKind } from '../../src/core/types';
import { assignVariant, resolveInk } from '../../src/ink/color';
import { drawCooked, viewMatrix, type DrawOpts } from '../../src/render/raster';
import { tracePoly } from '../../src/render/tessellate';
import { applyGround, paintGround } from '../../src/render/ground';
import { synthCooked, type SynthPoly } from '../../tests/render-core.fixtures';

type P2 = [number, number];
interface Stroke { c: Cooked; color: ColorStyle; opts?: DrawOpts }

// ---------------------------------------------------------------------------- deterministic helpers

let seed = 12345;
const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Resample a path every `step` doc units: returns points and arcs. */
function resample(path: readonly P2[], step = 2.4): { pts: P2[]; s: number[]; L: number } {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const L = acc[acc.length - 1], n = Math.max(1, Math.round(L / step));
  const pts: P2[] = [], s: number[] = [];
  let k = 1;
  for (let i = 0; i <= n; i++) {
    const d = (L * i) / n;
    while (k < path.length - 1 && acc[k] < d) k++;
    const t = acc[k] > acc[k - 1] ? (d - acc[k - 1]) / (acc[k] - acc[k - 1]) : 0;
    pts.push([path[k - 1][0] + (path[k][0] - path[k - 1][0]) * t, path[k - 1][1] + (path[k][1] - path[k - 1][1]) * t]);
    s.push(d);
  }
  return { pts, s, L };
}

/** Exact corners: resample each straight run separately so the corner vertex is kept. */
function polyline(corners: readonly P2[], step = 2.4): P2[] {
  const out: P2[] = [];
  for (let i = 1; i < corners.length; i++) {
    const r = resample([corners[i - 1], corners[i]], step).pts;
    out.push(...(i === 1 ? r : r.slice(1)));
  }
  return out;
}

const tonePD = (p: number, dBucket: number): number => Math.min(5, Math.floor(p * 6)) * 5 + Math.min(4, dBucket);

/**
 * Trunk ribbon chunks: split where the tone changes and every 50 sp; adjacent chunks share their
 * boundary point (so tessellation welds them). born = arc at the chunk start.
 */
function trunk(path: readonly P2[], wf: (t: number, s: number) => number, pf: (t: number) => number, opts: { gen?: number; alpha?: number; dBucket?: number; kind?: PolyKind; ang?: (t: number) => number; resampled?: boolean } = {}): SynthPoly[] {
  const r = opts.resampled ? { pts: path as P2[], s: cumul(path), L: 0 } : resample(path);
  if (opts.resampled) r.L = r.s[r.s.length - 1];
  const polys: SynthPoly[] = [];
  let cur: [number, number, number][] = [], curAng: number[] = [], curTone = -1, chunkStart = 0, unit = 0;
  for (let i = 0; i < r.pts.length; i++) {
    const t = r.L > 0 ? r.s[i] / r.L : 0;
    const tone = tonePD(pf(t), opts.dBucket ?? 0);
    const pt: [number, number, number] = [r.pts[i][0], r.pts[i][1], wf(t, r.s[i])];
    const a = opts.ang ? opts.ang(t) : 0;
    if (cur.length && (tone !== curTone || r.s[i] - chunkStart >= 50) && cur.length >= 2) {
      cur.push(pt); curAng.push(a);
      polys.push({ pts: cur, ang: opts.ang ? curAng : undefined, gen: opts.gen ?? 0, tone: curTone, alpha: opts.alpha ?? 1, born: chunkStart, unit: unit++, kind: opts.kind, a0: chunkStart });
      cur = []; curAng = []; chunkStart = r.s[i];
    }
    if (!cur.length) curTone = tone;
    cur.push(pt); curAng.push(a);
  }
  if (cur.length >= 2) polys.push({ pts: cur, ang: opts.ang ? curAng : undefined, gen: opts.gen ?? 0, tone: curTone, alpha: opts.alpha ?? 1, born: chunkStart, unit: unit++, kind: opts.kind, a0: chunkStart });
  return polys;
}
function cumul(p: readonly P2[]): number[] {
  const s = [0];
  for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  return s;
}
/** Entry/exit taper envelope like DESIGN §2.2.2 (in arc units). */
const env = (s: number, L: number, te: number, tx: number): number => smooth(0, te, s) * Math.pow(smooth(0, tx, L - s), 0.6);

// ---------------------------------------------------------------------------- the strokes

function brushStroke(x0: number, y0: number): Stroke {
  // an S-curve, a crisp V corner, then a flick
  const path: P2[] = [];
  for (let i = 0; i <= 60; i++) { const t = i / 60; path.push([x0 + t * 300, y0 + 50 * Math.sin(t * Math.PI * 1.6)]); }
  const corner: P2 = [x0 + 380, y0 + 120];
  const flick: P2[] = [];
  for (let i = 1; i <= 30; i++) { const t = i / 30; flick.push([corner[0] + t * 290, corner[1] - 150 * t + 40 * t * t]); }
  const r1 = resample([...path, corner]).pts, r2 = resample([corner, ...flick]).pts;
  const all = [...r1, ...r2.slice(1)];
  const L = cumul(all)[all.length - 1];
  const polys = trunk(all, (t, s) => 3 + 33 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.8) * env(s, L, 30, 60) + 0.5, t => 0.25 + 0.7 * Math.sin(Math.PI * t), { resampled: true });
  return { c: synthCooked(polys), color: assignVariant('moss', 0, null, null) };
}

function penZigzag(x0: number, y0: number): Stroke {
  const corners: P2[] = [];
  for (let i = 0; i <= 14; i++) corners.push([x0 + i * 46, y0 + (i % 2 ? -26 : 26) * (1 - i / 22)]);
  const pts = polyline(corners);
  const L = cumul(pts)[pts.length - 1];
  return { c: synthCooked(trunk(pts, (_t, s) => 2.6 * env(s, L, 4, 6) + 0.4, () => 0.7, { resampled: true })), color: assignVariant('graphite', 0, null, null) };
}

function chisel(x0: number, y0: number): Stroke {
  // a calligraphic loop: the travel direction rotates through the nib angle (thick ↔ thin)
  const path: P2[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120, a = t * Math.PI * 2.4;
    path.push([x0 + t * 340 + 70 * Math.sin(a), y0 + 70 * Math.cos(a) * (0.6 + 0.4 * t)]);
  }
  const r = resample(path);
  const polys = trunk(r.pts, (t, s) => 22 * (0.6 + 0.4 * Math.sin(Math.PI * t)) * env(s, r.L, 10, 14), t => 0.4 + 0.5 * Math.sin(Math.PI * t), { kind: PolyKind.Chisel, ang: () => (40 * Math.PI) / 180, resampled: true });
  return { c: synthCooked(polys), color: assignVariant('indigo', 0, null, null) };
}

function dots(x0: number, y0: number): Stroke {
  const polys: SynthPoly[] = [];
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 70;
    const p = rnd();
    polys.push({ kind: PolyKind.Dot, pts: [[x0 + Math.cos(a) * rr, y0 + Math.sin(a) * rr * 0.8, 1.5 + 13 * p * p]], tone: tonePD(p, 0) });
  }
  return { c: synthCooked(polys), color: assignVariant('rose', 0, null, null) };
}

/** Sprout-like botany: a trunk with fern branches (gens 1–3), tropism upward, tapering widths. */
function sprout(x0: number, y0: number, len: number): Stroke {
  const path: P2[] = [];
  for (let i = 0; i <= 50; i++) { const t = i / 50; path.push([x0 + t * len, y0 + 22 * Math.sin(t * Math.PI * 2.2)]); }
  const r = resample(path);
  const wf = (t: number, s: number) => (4 + 7 * Math.sin(Math.PI * t)) * env(s, r.L, 20, 30) + 0.3;
  const polys = trunk(r.pts, wf, t => 0.35 + 0.5 * Math.sin(Math.PI * t), { resampled: true });
  let side = 1, unit = 1000;
  const branch = (bx: number, by: number, hx: number, hy: number, g: number, l: number, wb: number, p: number, born: number) => {
    const pts: [number, number, number][] = [];
    let x = bx, y = by, h = Math.atan2(hy, hx);
    const steps = Math.max(2, Math.ceil(l / 2.4));
    const nodes: { x: number; y: number; h: number }[] = [];
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      pts.push([x, y, Math.max(0.35, wb * Math.pow(0.66, g - 1) * (1 - f) + wb * Math.pow(0.66, g) * f)]);
      if (k === Math.round(steps / 3) || k === Math.round((2 * steps) / 3)) nodes.push({ x, y, h });
      // tropism toward screen-up
      h += 0.008 * 2.4 * Math.sin(-Math.PI / 2 - h) * 3;
      x += Math.cos(h) * (l / steps); y += Math.sin(h) * (l / steps);
    }
    polys.push({ pts, gen: g, alpha: 0.92 * Math.pow(0.72, g - 1), tone: tonePD(p, g), born, unit: unit++ });
    if (g < 3) {
      nodes.forEach((n, j) => {
        const turn = (j === 0 ? 1 : -1) * (0.45 + 0.25 * rnd());
        const hh = n.h + turn;
        branch(n.x, n.y, Math.cos(hh), Math.sin(hh), g + 1, l * 0.55 * (0.8 + 0.4 * rnd()), wb, p, born);
      });
    }
  };
  for (let s = 18; s < r.L - 10; s += 26 + 10 * rnd()) {
    const i = Math.round((s / r.L) * (r.pts.length - 1));
    const a = r.pts[Math.max(0, i - 1)], b = r.pts[Math.min(r.pts.length - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
    let nx = -ty / tl, ny = tx / tl;
    if (ny > 0) side = -side;
    nx *= side; ny *= side;
    if (ny > 0.3) { nx = -nx; ny = -ny; }   // botany grows mostly upward
    const t = s / r.L, p = 0.35 + 0.5 * Math.sin(Math.PI * t);
    const lean = -0.3 + 0.6 * rnd();
    const hx = nx * Math.cos(lean) - ny * Math.sin(lean), hy = nx * Math.sin(lean) + ny * Math.cos(lean);
    branch(r.pts[i][0], r.pts[i][1], hx, hy, 1, (20 + 18) * (0.4 + 1.3 * p) * (0.6 + 0.8 * rnd()) * 0.8, wf(t, s) * 0.8, p, s);
  }
  return { c: synthCooked(polys), color: assignVariant('moss', 3, null, null) };
}

/** Drift-like wake: filaments along a curl field, split into thirds that deepen in colour. */
function drift(x0: number, y0: number, len: number): Stroke {
  const path: P2[] = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40; path.push([x0 + t * len, y0 - 30 * Math.sin(t * Math.PI)]); }
  const r = resample(path);
  const wf = (t: number, s: number) => (3 + 5 * Math.sin(Math.PI * t)) * env(s, r.L, 15, 25) + 0.3;
  const polys = trunk(r.pts, (t, s) => wf(t, s) * 0.8, t => 0.3 + 0.5 * Math.sin(Math.PI * t), { resampled: true });
  const psi = (x: number, y: number) => Math.sin(x * 0.021 + Math.sin(y * 0.017) * 1.3) * Math.cos(y * 0.019 - 0.7) + 0.5 * Math.sin(x * 0.043 - y * 0.037 + 2);
  const curl = (x: number, y: number): P2 => {
    const e = 0.5;
    const dx = (psi(x, y + e) - psi(x, y - e)) / (2 * e), dy = -(psi(x + e, y) - psi(x - e, y)) / (2 * e);
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  let unit = 500;
  for (let s = 4; s < r.L - 4; s += 9) {
    const i = Math.round((s / r.L) * (r.pts.length - 1));
    const t = s / r.L, p = 0.3 + 0.5 * Math.sin(Math.PI * t);
    const n = Math.round(110 * (0.35 + 0.9 * p));
    let x = r.pts[i][0], y = r.pts[i][1];
    const w0 = 0.55 * wf(t, s) * 1.2;
    const fil: [number, number, number][] = [];
    for (let k = 0; k <= n; k++) {
      const f = 1 - k / n;
      fil.push([x, y, w0 * f * f + 0.05]);
      const [fx, fy] = curl(x, y);
      const mom = 0.8 * 0.95 ** k;
      let dx = fx + mom, dy = fy - 0.1 * mom;
      const l = Math.hypot(dx, dy) || 1;
      const j = (rnd() - 0.5) * 0.28, cj = Math.cos(j), sj = Math.sin(j);
      dx /= l; dy /= l;
      x += (dx * cj - dy * sj) * 1.7; y += (dx * sj + dy * cj) * 1.7;
    }
    const third = Math.floor(fil.length / 3);
    const cuts = [0, third, 2 * third, fil.length - 1];
    const u = unit++;
    [1, 2, 3].forEach((db, q) => {
      const seg = fil.slice(cuts[q], cuts[q + 1] + 1);
      if (seg.length >= 2) polys.push({ pts: seg, gen: 1, alpha: 0.38, tone: tonePD(p, db), born: s, unit: u });
    });
  }
  return { c: synthCooked(polys), color: assignVariant('oxide', 0, null, null) };
}

function spectral(x0: number, y0: number, len: number): Stroke {
  const path: P2[] = [];
  for (let i = 0; i <= 80; i++) { const t = i / 80; path.push([x0 + t * len, y0 + 24 * Math.sin(t * Math.PI * 4)]); }
  const r = resample(path);
  const polys = trunk(r.pts, (t, s) => (5 + 9 * Math.sin(Math.PI * t)) * env(s, r.L, 25, 40) + 0.4, t => 0.5 + 0.45 * Math.sin(Math.PI * t * 3), { resampled: true });
  return { c: synthCooked(polys), color: assignVariant('spectral', 2, null, null) };
}

/** Brush dry-split: 4 bristle sub-ribbons, gated in 12 sp pieces (strands break). */
function drySplit(x0: number, y0: number): Stroke {
  const path: P2[] = [];
  for (let i = 0; i <= 30; i++) { const t = i / 30; path.push([x0 + t * 260, y0 + 60 * t - 30 * t * t]); }
  const r = resample(path);
  const polys: SynthPoly[] = [];
  const w = 24;
  for (let j = 0; j < 4; j++) {
    let cur: [number, number, number][] = [];
    let born = 0;
    for (let i = 0; i < r.pts.length; i++) {
      const s = r.s[i];
      const on = rnd() > 0.2 || Math.floor(s / 12) % 5 !== j;
      const a = r.pts[Math.max(0, i - 1)], b = r.pts[Math.min(r.pts.length - 1, i + 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      const off = (j - 1.5) * (w / 4);
      const e = env(s, r.L, 20, 40);
      const pt: [number, number, number] = [r.pts[i][0] - (ty / tl) * off * e, r.pts[i][1] + (tx / tl) * off * e, (w / 4.5) * e + 0.3];
      if (on) { if (!cur.length) born = s; cur.push(pt); }
      else if (cur.length) { if (cur.length >= 2) polys.push({ pts: cur, tone: tonePD(0.35, 0), born }); cur = []; }
    }
    if (cur.length >= 2) polys.push({ pts: cur, tone: tonePD(0.35, 0), born });
  }
  return { c: synthCooked(polys), color: assignVariant('ochre', 0, null, null) };
}

function crossing(cx: number, cy: number, ink: InkId, angle: number, w: number): Stroke {
  const dx = Math.cos(angle) * 110, dy = Math.sin(angle) * 110;
  const r = resample([[cx - dx, cy - dy], [cx + dx, cy + dy]]);
  const polys = trunk(r.pts, (_t, s) => w * env(s, r.L, 18, 22) + 0.4, () => 0.85, { resampled: true });
  return { c: synthCooked(polys), color: assignVariant(ink, 0, null, null) };
}

/** A fat brush loop crossing itself: unions inside a batch (no double-add within one chunk). */
function loop(cx: number, cy: number): Stroke {
  const path: P2[] = [];
  for (let i = 0; i <= 90; i++) { const t = (i / 90) * Math.PI * 2; path.push([cx + 70 * Math.sin(t), cy + 32 * Math.sin(2 * t)]); }
  const r = resample(path);
  const polys = trunk(r.pts, (t, s) => 16 * env(s, r.L, 20, 30) + 0.5, () => 0.8, { resampled: true });
  return { c: synthCooked(polys), color: assignVariant('rose', 5, null, null) };
}

function composition(): Stroke[] {
  seed = 12345;
  return [
    brushStroke(70, 120),
    penZigzag(60, 330),
    chisel(70, 470),
    dots(640, 460),
    crossing(560, 640, 'ochre', -0.5, 30),
    crossing(560, 640, 'indigo', 0.55, 30),
    drySplit(420, 330),
    loop(170, 650),
    sprout(320, 780, 440),
    drift(50, 880, 280),
    spectral(80, 975, 640),
  ];
}

// ---------------------------------------------------------------------------- panels

const dpr = Math.min(3, window.devicePixelRatio || 1);
const grid = document.getElementById('grid')!;

type Custom = (ctx: CanvasRenderingContext2D, g: Ground, w: number, h: number) => void;

function panel(g: Ground, label: string, strokes: Stroke[], cam: Camera, world = false, custom?: Custom): void {
  const el = document.createElement('div');
  el.className = 'panel ' + g;
  const ground = document.createElement('div');
  ground.className = 'ground';
  el.appendChild(ground);
  const cv = document.createElement('canvas');
  el.appendChild(cv);
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = label;
  el.appendChild(lab);
  grid.appendChild(el);
  requestAnimationFrame(() => {
    const w = el.clientWidth, h = el.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d')!;
    if (world) {
      paintGround(ctx, cv.width, cv.height, g);   // export path: ground + ink in one canvas
    } else {
      applyGround(ground, g, false);
      cv.style.mixBlendMode = g === 'night' ? 'plus-lighter' : 'multiply';
      if (g === 'paper') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
    }
    const t0 = performance.now();
    for (const s of strokes) drawCooked(ctx, s.c, resolveInk(s.color, g), viewMatrix([0, 0], cam, w, h, dpr), s.opts);
    if (custom) custom(ctx, g, w, h);
    const ms = performance.now() - t0;
    lab.textContent = `${label} · ${ms.toFixed(1)} ms`;
    (window as unknown as { __drawn: number }).__drawn = ((window as unknown as { __drawn: number }).__drawn ?? 0) + 1;
  });
}

const view = new URLSearchParams(location.search).get('view') ?? 'main';
const strokes = composition();
const cam = (cx: number, cy: number, scale: number): Camera => ({ cx, cy, scale, rot: 0 });

if (view === 'main' || view === 'export') {
  grid.style.gridTemplateColumns = '1fr 1fr';
  for (const g of ['night', 'paper'] as const) panel(g, `${g}${view === 'export' ? ' · export painter' : ''}`, strokes, cam(400, 520, Math.min(innerWidth / 2 / 800, innerHeight / 1040)), view === 'export');
} else if (view === 'zoom') {
  grid.style.gridTemplateColumns = '1fr 1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  for (const g of ['night', 'paper'] as const) {
    panel(g, `${g} · brush V corner ×10`, strokes, cam(450, 240, 10));
    panel(g, `${g} · chisel twist ×6`, strokes, cam(190, 470, 6));
    panel(g, `${g} · sprout + joints ×5`, strokes, cam(470, 760, 5));
  }
} else if (view === 'ground') {
  grid.style.gridTemplateColumns = '1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  for (const g of ['night', 'paper'] as const) { panel(g, '', [], cam(0, 0, 1)); panel(g, '', [], cam(0, 0, 1), true); }
} else if (view === 'zoom2') {
  grid.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  for (const g of ['night', 'paper'] as const) {
    panel(g, `${g} · brush chunks ×6`, strokes, cam(205, 165, 6));
    panel(g, `${g} · dry-split ×5`, strokes, cam(560, 352, 5));
    panel(g, `${g} · drift thirds ×4`, strokes, cam(150, 850, 4));
    panel(g, `${g} · spectral ×5`, strokes, cam(400, 975, 5));
  }
} else if (view === 'zoom3') {
  grid.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  for (const g of ['night', 'paper'] as const) {
    panel(g, `${g} · chisel start ×7`, strokes, cam(82, 508, 7));
    panel(g, `${g} · chisel end ×5`, strokes, cam(440, 470, 5));
    panel(g, `${g} · pen corners ×12`, strokes, cam(106, 305, 12));
    panel(g, `${g} · dots ×5`, strokes, cam(640, 460, 5));
  }
} else if (view === 'lod') {
  grid.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  for (const g of ['night', 'paper'] as const) for (const s of [0.6, 0.3, 0.1, 0.03]) panel(g, `${g} · ${Math.round(s * 100)}%`, strokes, cam(400, 520, s));
} else if (view === 'reveal') {
  grid.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  // Sequential reveal, as a live layer does it: the trunk grows along its absolute arc (chunks in
  // order, so welded joints stay welded and only the front is a round tip); growth polys start
  // when the front passes their birth arc and extend over ~60 sp; hot ink cools behind the front.
  const arc0 = (c: Cooked, i: number) => c.pts[4 * c.start[i] + 3];
  const arc1 = (c: Cooked, i: number) => c.pts[4 * (c.start[i] + c.count[i] - 1) + 3];
  for (const g of ['night', 'paper'] as const) for (const f of [0.25, 0.5, 0.75, 1]) {
    const rs = strokes.map(s => {
      let L = 0;
      for (let i = 0; i < s.c.nPolys; i++) if (s.c.gen[i] === 0) L = Math.max(L, arc1(s.c, i));
      const front = f * (L + 120);
      const rev = (i: number): number => {
        if (s.c.kind[i] === PolyKind.Dot) return Math.min(1, Math.max(0, f * 2 - (i % 7) * 0.12));
        if (s.c.gen[i] === 0) { const a = arc0(s.c, i), b = arc1(s.c, i); return b > a ? Math.min(1, Math.max(0, (front - a) / (b - a))) : 1; }
        return Math.min(1, Math.max(0, (front - s.c.born[i] - 25 * (s.c.gen[i] - 1)) / 60));
      };
      const hot = (i: number): number => {
        if (s.c.gen[i] !== 0) return 1;
        const age = (front - arc1(s.c, i)) / 120;
        return age >= 1 ? 1 : 1 + 0.45 * Math.max(0, 1 - Math.max(0, age));
      };
      return { ...s, opts: { reveal: rev, hot } };
    });
    panel(g, `${g} · reveal ${f}`, rs, cam(400, 520, 0.42));
  }
}

// ---------------------------------------------------------------------------- review view
// Exercises the review fixes: (1) a thick ribbon drawn as sliding hot-window arc ranges, each in
// its OWN fill (so any overlap would double-add), including sub-pixel and empty ranges at the
// cuts; (2) alphaScale fades (exact, not bucketed); (3) single-station chisel taps; (4) a thick
// 55° miter whose tip pokes below its box, drawn as two clipped "tiles" with a seam just below
// the box.
if (view === 'review' || view === 'rangezoom') {
  const rz = view === 'rangezoom';
  grid.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  const s1 = (x: number, y: number) => ({ pts: resample([[x, y], [x + 120, y + 60], [x + 260, y - 10]]).pts, x, y });
  const ranges: Custom = (ctx, g, w, h) => {
    // a hot window as render-live draws it: the trunk is welded chunks (different tones), and
    // every 12 sp of absolute arc a cut, each range its own fill. Chunk ends sit a hair (0.03 sp)
    // from some cuts, so ranges that would be sub-pixel slivers occur and must snap away.
    const r = s1(30, 80);
    const all = r.pts.map(([x, y], i) => [x, y, 26 + 10 * Math.sin(i / 9)] as [number, number, number]);
    const s = cumul(r.pts);
    const bounds = [0];
    for (const target of [24.03, 47.97, 72, 95.2, 132.05, 179.9]) {
      let k = 1; while (k < all.length - 1 && s[k] < target) k++;
      if (k > bounds[bounds.length - 1]) bounds.push(k);
    }
    if (bounds[bounds.length - 1] !== all.length - 1) bounds.push(all.length - 1);
    const polys: SynthPoly[] = [];
    for (let q = 0; q + 1 < bounds.length; q++) polys.push({ pts: all.slice(bounds[q], bounds[q + 1] + 1), tone: 20 + (q % 3), born: s[bounds[q]], unit: q });
    const c = synthCooked(polys);
    const t = resolveInk(assignVariant('moss', 0, null, null), g);
    const m = viewMatrix([0, 0], rz ? cam(150, 140, 7) : cam(150, 110, 1.5), w, h, dpr);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = t.op;
    ctx.globalAlpha = g === 'night' ? 0.7 : 0.6;
    for (let i = 0; i < c.nPolys; i++) {
      const born = c.born[i], len = c.pts[4 * (c.start[i] + c.count[i] - 1) + 3];
      ctx.fillStyle = t.css[c.tone[i]];
      for (let cut = Math.floor(born / 12) * 12; cut < born + len; cut += 12) {
        ctx.beginPath();
        tracePoly(ctx, c, i, m, { arcFrom: cut - born, arcTo: cut + 12 - born });
        ctx.fill();
      }
    }
    ctx.restore();
  };
  const fades: Stroke[] = [0.15, 0.35, 0.6, 0.85].map((s, k) => {
    const b = brushStroke(-20, 60 + k * 110);
    return { ...b, opts: { alphaScale: s } };
  });
  const taps: Stroke[] = [];
  for (let k = 0; k < 12; k++) {
    taps.push({
      c: synthCooked([{ kind: PolyKind.Chisel, pts: [[40 + (k % 4) * 70, 60 + Math.floor(k / 4) * 80, 8 + 5 * k]], ang: [(k * 15 * Math.PI) / 180] }]),
      color: assignVariant('indigo', 0, null, null),
    });
  }
  const seam: Custom = (ctx, g, w, h) => {
    const b = (62.5 * Math.PI) / 180, hw = 30;
    const c = synthCooked([{ pts: [[-90 * Math.sin(b), -90 * Math.cos(b), 2 * hw], [0, 0, 2 * hw], [90 * Math.sin(b), -90 * Math.cos(b), 2 * hw]], tone: 25 }]);
    const t = resolveInk(assignVariant('rose', 0, null, null), g);
    const m = viewMatrix([0, 0], cam(0, -10, 2), w, h, dpr);
    const seamY = Math.round(m[5] + (hw + 2) * m[3]);   // device row just below the box (apex + w/2)
    for (const [y0, y1] of [[0, seamY], [seamY, h * dpr]]) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, y0, w * dpr, y1 - y0); ctx.clip();
      drawCooked(ctx, c, t, m, { clipDev: { x0: 0, y0, x1: w * dpr, y1 } });
      ctx.restore();
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g === 'night' ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)'; ctx.fillRect(0, seamY, w * dpr, 1); ctx.restore();
  };
  if (rz) {
    grid.style.gridTemplateColumns = '1fr 1fr'; grid.style.gridTemplateRows = '1fr';
    for (const g of ['night', 'paper'] as const) panel(g, `${g} · ranges at the corner ×7`, [], cam(0, 0, 1), false, ranges);
  } else for (const g of ['night', 'paper'] as const) {
    panel(g, `${g} · hot-window ranges (own fills)`, [], cam(0, 0, 1), false, ranges);
    panel(g, `${g} · alphaScale .15/.35/.6/.85`, fades, cam(300, 280, 0.62));
    panel(g, `${g} · chisel taps`, taps, cam(140, 140, 1.2));
    panel(g, `${g} · miter at a tile seam`, [], cam(0, 0, 1), false, seam);
  }
}
