/**
 * render-live sandbox: a minimal LiveHost stand-in (CSS ground + #base / #dry / #wet / #overlay
 * with the real blend modes) driving the live layer and the overlay from a scripted stroke, on a
 * deterministic virtual clock. The page simulates up to `at` ms and stops, so screenshots are
 * reproducible. The stand-in bakes synchronously into #base (the real renderer time-slices).
 *
 *   ?view=stroke&form=sprout&ground=night&at=900   the scripted stroke: draw, hold (pool + halo), lift
 *   ?view=withdraw&at=90                           un-grow 90 ms after a withdraw
 *   ?view=play&at=…[&bake=0]                       the same stroke replayed through live.play
 *   ?view=overlay                                  every overlay feedback element
 *   ?view=seam                                     welded-joint coverage experiment (render-core)
 * Options: cook=real (ink/cook.ts instead of the fake), nib, size, ink, base, ground=paper, rm=1,
 * path=straight[&pvar=1], nocursor=1, hide=base,dry,wet,overlay, dbg=1 (outline the last frame's
 * #wet repaint rects), defer=1 (wait for window.__run(), for profiling).
 */
import type { Cooked, Doc, FormId, Ground, InputSample, NibId, Scene, StrokeId, StrokeRecipe, Vec2 } from '../../src/core/types';
import { createLiveLayer, drawInk, type LiveHostExt, type LiveLayerExtras } from '../../src/render/live';
import { createOverlay } from '../../src/render/overlay';
import { inkTableFor, viewMatrix } from '../../src/render/raster';
import { applyGround } from '../../src/render/ground';
import { swatchCss } from '../../src/ink/color';
import type { LiveLayerInternal, OverlayInternal } from '../../src/render/types';
import type { IncrementalCook } from '../../src/core/types';
import { createIncrementalCook } from '../../src/ink/cook';
import { FakeCook, addSample, freeze, makeDraft, setPool, assemble, type FakeDraft } from '../../tests/render-live.fakecook';
const seamKit = { assemble };

declare global { interface Window { __ready?: boolean; __stats?: unknown } }

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'stroke';
const ground = (q.get('ground') ?? 'night') as Ground;
const form = (q.get('form') ?? 'sprout') as FormId;
const nib = (q.get('nib') ?? 'brush') as NibId;
const ink = (q.get('ink') ?? (form === 'drift' ? 'indigo' : form === 'line' ? 'oxide' : form === 'echo' ? 'rose' : 'moss')) as 'moss';
const at = +(q.get('at') ?? '1200');
const base = +(q.get('base') ?? (form === 'line' ? '0' : '2'));
const size = +(q.get('size') ?? (nib === 'pen' ? '3' : nib === 'chisel' ? '16' : '11'));
const dbg = q.get('dbg') === '1';
const realCook = q.get('cook') === 'real';
const mkCook = (d: FakeDraft): IncrementalCook & { spine: FakeCook['spine'] } => (realCook ? createIncrementalCook(d) : new FakeCook(d));
const hide = (q.get('hide') ?? '').split(',');
const noCursor = q.get('nocursor') === '1';

const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1;
const cam = { cx: W / 2, cy: H / 2, scale: 1, rot: 0 };
if (ground === 'paper') document.body.classList.add('paper');

// ---------------------------------------------------------------------------- stage
const stage = document.getElementById('stage')!;
const groundEl = document.createElement('div');
groundEl.className = 'ground';
stage.appendChild(groundEl);
applyGround(groundEl, ground, false);
const blend = ground === 'night' ? 'plus-lighter' : 'multiply';
function layer(id: string, b: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.id = id;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  c.style.mixBlendMode = b;
  stage.appendChild(c);
  return c;
}
const baseC = layer('base', blend), dry = layer('dry', blend), wet = layer('wet', blend);
const dbgC = layer('dbg', 'normal');
const ovC = document.createElement('canvas');
ovC.id = 'overlay';
stage.appendChild(ovC);
for (const c of [baseC, dry, wet, ovC]) if (hide.includes(c.id)) c.style.visibility = 'hidden';

// ---------------------------------------------------------------------------- strokes known to the overlay
const strokes = new Map<StrokeId, { r: StrokeRecipe; c: Cooked }>();
const scene = { cooked: (id: StrokeId) => strokes.get(id)?.c } as unknown as Scene;
const doc = { get: (id: StrokeId) => strokes.get(id)?.r } as unknown as Doc;

let vt = 0;
const overlay: OverlayInternal = createOverlay({
  canvas: ovC, camera: () => cam, viewport: () => ({ w: W, h: H }), scene, doc, ground: () => ground, requestFrame: () => undefined,
});
overlay.resize(W, H, dpr);

const baked: { r: StrokeRecipe; c: Cooked }[] = [];
function drawBase(): void {
  const ctx = baseC.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, baseC.width, baseC.height);
  for (const { r, c } of baked) drawInk(ctx, c, inkTableFor(r, ground), viewMatrix(r.origin, cam, W, H, dpr), r.form.form, {});
}
let bakes = 0;
const host: LiveHostExt = {
  overlay, dry, wet,
  dpr: () => dpr, ground: () => ground, camera: () => cam, viewport: () => ({ w: W, h: H }),
  matrixFor: (o: Vec2) => viewMatrix(o, cam, W, H, dpr),
  inkTable: r => inkTableFor(r, ground),
  bake(r, c, done) { bakes++; baked.push({ r, c }); strokes.set(r.id, { r, c }); drawBase(); done(); },
  requestFrame: () => undefined,
  reducedMotion: () => q.get('rm') === '1',
  now: () => vt,
};
const live = createLiveLayer(host) as LiveLayerInternal & LiveLayerExtras;

// debug: record the #wet repaint rects of the last frame
const wetRects: number[][] = [];
if (dbg) {
  const wctx = wet.getContext('2d')!;
  const orig = wctx.clearRect.bind(wctx);
  wctx.clearRect = (x: number, y: number, w: number, h: number): void => { wetRects.push([x, y, w, h]); orig(x, y, w, h); };
}

// ---------------------------------------------------------------------------- the scripted stroke
/** Catmull-Rom through control points, densely sampled. */
function curve(ctrl: [number, number][], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < ctrl.length - 1; k++) {
    const p0 = ctrl[Math.max(0, k - 1)], p1 = ctrl[k], p2 = ctrl[k + 1], p3 = ctrl[Math.min(ctrl.length - 1, k + 2)];
    for (let i = 0; i < n; i++) {
      const t = i / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}
const straight = q.get('path') === 'straight';
const ctrl: [number, number][] = (straight ? [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]] : [[0.1, 0.66], [0.22, 0.52], [0.34, 0.38], [0.47, 0.42], [0.56, 0.6], [0.68, 0.66], [0.8, 0.5], [0.9, 0.34]]).map(([x, y]) => [x * W, y * H]);
const dense = curve(ctrl, 60);
const arcs: number[] = [0];
for (let i = 1; i < dense.length; i++) arcs.push(arcs[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
const LEN = arcs[arcs.length - 1];
function pointAt(s: number): [number, number] {
  let i = 1;
  while (i < arcs.length - 1 && arcs[i] < s) i++;
  const t = arcs[i] > arcs[i - 1] ? (s - arcs[i - 1]) / (arcs[i] - arcs[i - 1]) : 0;
  return [dense[i - 1][0] + (dense[i][0] - dense[i - 1][0]) * t, dense[i - 1][1] + (dense[i][1] - dense[i - 1][1]) * t];
}

interface Sample { t: number; s: number; x: number; y: number; p: number }
const HOLD_S = 0.56 * LEN, HOLD_MS = 1300;
const samples: Sample[] = [];
{
  let t = 0, s = 0, held = false;
  while (s < LEN) {
    const u = s / LEN;
    // brisk in the middle, easing into the hold and at both ends
    const v = straight ? 0.5 : 0.35 + 0.75 * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - 0.7 * Math.exp(-Math.abs(s - HOLD_S) / 60));
    const p = straight ? (q.get('pvar') === '1' ? 0.25 + 0.7 * u : 0.7) : 0.4 + 0.45 * Math.sin(Math.PI * u) + 0.1 * Math.sin(u * 23);
    const [x, y] = pointAt(s);
    samples.push({ t, s, x, y, p: Math.max(0.15, Math.min(1, p)) });
    if (!held && s >= HOLD_S && !straight) { held = true; t += HOLD_MS; }
    t += 8;
    s += v * 8;
  }
  const [x, y] = pointAt(LEN);
  samples.push({ t, s: LEN, x, y, p: 0.3 });
}
const T_HOLD0 = samples.find(sm => sm.s >= HOLD_S)!.t;
const T_LIFT = samples[samples.length - 1].t + 16;

function nibCss(d: FakeDraft): string { return swatchCss(d.color, ground); }
const mkS = (x: number, y: number, t: number, predicted: boolean): InputSample => ({ x, y, t, p: 0.5, alt: Math.PI / 2, az: 0, r: NaN, predicted });

/** Simulate the scripted stroke up to virtual time `until` (ms since pen-down). */
function runStroke(until: number, withdrawAt = Infinity): void {
  const d = makeDraft({ form, base, nib, size, ink, seed: 7 });
  const cook = mkCook(d);
  live.begin(d, cook);
  let k = 0, poolIdx = -1, lastP: Sample = samples[0];
  let committed = false, withdrawn = false;
  for (vt = 0; vt <= until; vt += 16) {
    if (!committed && !withdrawn) {
      let n = 0;
      while (k < samples.length && samples[k].t <= vt) {
        const sm = samples[k++];
        addSample(d, sm.x, sm.y, sm.t, sm.p);   // origin (0,0), camera centred: doc = screen
        lastP = sm; n++;
      }
      if (n) { cook.append(n); live.update(); }
      // the hold: pre-halo from 250 ms, pooling from 450 ms (≈ 2.3 levels/s up to the ceiling)
      const th = vt - T_HOLD0;
      if (th >= 0 && th <= HOLD_MS) {
        const pre = Math.max(0, Math.min(1, (th - 250) / 200));
        let a = 0, brim = false;
        if (th >= 450) {
          a = Math.min(4 - base, ((th - 450) / 1000) * 2.3);
          brim = a >= 4 - base;
          const L = cook.spine().L;
          poolIdx = setPool(d, L, Math.round(a * 16) / 16, T_HOLD0 + 450, vt, poolIdx);
          cook.regrow(L - 48, L + 32);
          live.update();
        }
        if (th >= 250) {
          const w = size * (0.3 + 0.7 * lastP.p);
          live.halo({ x: lastP.x, y: lastP.y, rCss: w / 2 + 6, level: (base + a) / 4, pre, brim, css: nibCss(d) });
        }
      } else if (th > HOLD_MS && th < HOLD_MS + 32) live.halo(null);
      // nib cursor and prediction (16 ms ahead along the path)
      if (k < samples.length && !noCursor) {
        const w = size * (0.3 + 0.7 * lastP.p);
        overlay.cursor([lastP.x, lastP.y], { kind: nib, wCss: w, angle: 0.7, css: nibCss(d) });
        const ahead = samples[Math.min(samples.length - 1, k + 2)];
        live.predict([mkS((lastP.x + ahead.x) / 2, (lastP.y + ahead.y) / 2, vt + 8, true), mkS(ahead.x, ahead.y, vt + 16, true)]);
      }
      if (vt >= withdrawAt) { live.withdraw(); withdrawn = true; overlay.cursor(null, null); }
      else if (k >= samples.length && vt >= T_LIFT) {
        const r = freeze(d, 'stroke-' + form);
        live.commit(r, cook.finish(r));
        committed = true;
        overlay.cursor(null, null);
      }
    }
    if (dbg) wetRects.length = 0;
    const t0 = performance.now();
    live.frame(vt);
    frameMs.push(performance.now() - t0);
    overlay.frame(vt);
  }
}
const frameMs: number[] = [];

// ---------------------------------------------------------------------------- overlay demo
function bakeStroke(id: string, fm: FormId, ox: number, oy: number, sc: number, nb: NibId = 'brush', ik: 'moss' = 'moss'): { r: StrokeRecipe; c: Cooked } {
  const d = makeDraft({ form: fm, base: 2, nib: nb, size: 10, ink: ik, origin: [ox, oy], seed: id.length * 31 });
  const cook = mkCook(d);
  const n = 90;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    addSample(d, t * 240 * sc, Math.sin(t * Math.PI * 2) * 40 * sc, i * 10, 0.4 + 0.5 * Math.sin(t * Math.PI));
  }
  cook.append(n + 1);
  const r = freeze(d, id);
  const c = cook.finish(r);
  baked.push({ r, c });
  strokes.set(id, { r, c });
  return { r, c };
}

function runOverlay(): void {
  bakeStroke('s1', 'sprout', W * 0.1, H * 0.3, 1);
  bakeStroke('s2', 'drift', W * 0.55, H * 0.28, 1, 'brush', 'indigo' as 'moss');
  bakeStroke('s3', 'line', W * 0.15, H * 0.72, 1, 'pen', 'oxide' as 'moss');
  bakeStroke('s4', 'sprout', W * 0.55, H * 0.7, 1, 'brush', 'rose' as 'moss');
  drawBase();
  vt = 1000;
  const s2 = strokes.get('s2')!.c;
  overlay.selection(s2.inkBox, ['s2']);
  overlay.eraser([W * 0.62, H * 0.7], 16, ['s4']);
  overlay.lasso(Float64Array.from([0.08, 0.12, 0.3, 0.1, 0.42, 0.18, 0.4, 0.52, 0.2, 0.55, 0.06, 0.4].map((v, i) => (i % 2 ? v * H : v * W))));
  const css = swatchCss({ ink: 'moss', lch: null }, ground);
  overlay.cursor([W * 0.82, H * 0.15], { kind: 'brush', wCss: 22, angle: 0, css });
  overlay.sizeRing([W * 0.5, H * 0.5], 48, css);
  overlay.weld([W * 0.12, H * 0.62], 12);
  overlay.predicted([mkS(W * 0.3, H * 0.9, 990, false), mkS(W * 0.34, H * 0.89, 1000, false), mkS(W * 0.355, H * 0.885, 1008, true)], 8, css);
  // chisel and pen cursors side by side
  const ctxC = swatchCss({ ink: 'ochre', lch: null }, ground);
  overlay.cursor([W * 0.9, H * 0.15], { kind: 'chisel', wCss: 30, angle: 0.7, css: ctxC });
  // let the weld ring fade in
  for (vt = 1000; vt <= 1200; vt += 16) overlay.frame(vt);
}

/** A recorded stroke (the scripted one, with its pool) replayed through live.play. */
function runPlay(until: number, bakeAfter: boolean): void {
  const d = makeDraft({ form, base, nib, size, ink, seed: 7 });
  const cook = mkCook(d);
  for (const sm of samples) addSample(d, sm.x, sm.y, sm.t, sm.p);
  cook.append(samples.length);
  const L = cook.spine().L;
  // the pool the hold made: at the hold point, rising from 450 ms into the hold to its end
  let sHold = 0;
  for (let i = 0; i < cook.spine().n; i++) if (cook.spine().t[i] <= T_HOLD0) sHold = cook.spine().s[i];
  setPool(d, sHold, 4 - base, T_HOLD0 + 450, T_HOLD0 + HOLD_MS);
  cook.regrow(0, L);
  const r = freeze(d, 'played');
  const c = cook.finish(r);
  vt = 0;
  live.play(r, c, { bake: bakeAfter });
  for (vt = 0; vt <= until; vt += 16) live.frame(vt);
}

// ---------------------------------------------------------------------------- seam experiment
/** One welded two-chunk ribbon drawn three ways (rows): one call; two calls on one canvas; split across #dry / #wet. */
function runSeam(): void {
  const { assemble } = seamKit;
  // rows: straight / bent joint × same / different tone; columns: one drawCooked call
  const mk = (x0: number, y: number, bend: number, tone2: number): Cooked => {
    const pts1: number[] = [], pts2: number[] = [];
    for (let k = 0; k <= 20; k++) pts1.push(x0 + k * 6, y + k * 2.4, 14);
    const jx = x0 + 120, jy = y + 48;
    for (let k = 0; k <= 20; k++) { const a = Math.atan2(2.4, 6) + bend; pts2.push(jx + k * 6.46 * Math.cos(a), jy + k * 6.46 * Math.sin(a), 14); }
    return assemble([{ polys: [
      { kind: 0, gen: 0, alpha: 1, tone: 20, born: 0, unit: 0, cat: 0, pts: pts1 },
      { kind: 0, gen: 0, alpha: 1, tone: tone2, born: 130, unit: 1, cat: 0, pts: pts2 },
    ], ids: null }], 1, [0, 0]).c;
  };
  const rec = makeDraft({ form: 'line', ink: 'oxide' as 'moss' });
  const t = inkTableFor(rec, ground);
  const m = viewMatrix([0, 0], cam, W, H, dpr);
  const bctx = baseC.getContext('2d')!;
  let y = 60;
  for (const bend of [0, 0.35]) for (const tone2 of [20, 25]) {
    drawInk(bctx, mk(100, y, bend, tone2), t, m, 'line', {});
    y += 150;
  }
  (window as unknown as { __seam: unknown }).__seam = { rows: [60, 210, 360, 510], joint: [220, 48] };
}

// ---------------------------------------------------------------------------- run
function run(): void {
if (view === 'seam') runSeam();
else if (view === 'play') runPlay(at, q.get('bake') !== '0');
else if (view === 'overlay') runOverlay();
else if (view === "withdraw") runStroke(T_HOLD0 - 200 + at, T_HOLD0 - 200);
else runStroke(at);

if (dbg) {
  const g = dbgC.getContext('2d')!;
  g.strokeStyle = 'rgba(255,60,60,0.9)';
  g.lineWidth = 2;
  for (const [x, y, w, h] of wetRects) g.strokeRect(x + 1, y + 1, w - 2, h - 2);
}
const info = live.inspect().map(i => `${i.kind}:${i.mode} polys ${i.polys} wet ${i.wet} dry ${i.dry} hot ${i.hot}${i.animating ? ' anim' : ''}`).join('\n');
document.getElementById('label')!.textContent = `${view} ${form} ${ground} t=${vt - 16}ms  bakes ${bakes}  (lift at ${T_LIFT}, hold ${T_HOLD0}-${T_HOLD0 + HOLD_MS})\n${info}`;
const sorted = frameMs.slice().sort((a, b) => a - b);
const perf = sorted.length ? { n: sorted.length, p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(3), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3), max: +sorted[sorted.length - 1].toFixed(3) } : null;
window.__stats = { T_HOLD0, T_LIFT, bakes, info, perf, frames: frameMs };
(window as unknown as { __live: unknown }).__live = live;
window.__ready = true;
}
if (q.get('defer') === '1') (window as unknown as { __run: () => void }).__run = run; else run();
