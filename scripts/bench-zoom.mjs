#!/usr/bin/env node
// Pan / zoom benchmark (DESIGN §9 "Pan / zoom frame ≤ 3 ms CPU, ≤ 8 ms total").
//
//   node scripts/bench-zoom.mjs [--reps 3] [--only storm,sweep,pan,pinch] [--json out.json]
//                               [--url URL] [--no-build] [--doc strokes.rise] [--top]
//
// Like scripts/e2e.mjs, it needs the window.__rise hooks, which only the debug build has: it runs
// `vite build --mode debug` and drives dist-debug/index.html. `--no-build` reuses an existing
// dist-debug/; `--url` points elsewhere (no build).
//
// Draws the e2e stress-300 document (300 strokes, four Forms) on the debug single-file build, then runs
// camera gestures and reports, per gesture and per phase (burst = while input arrives, settle =
// after the last event until the renderer is idle):
//   - rAF frame intervals p50 / p95 / max (what the e2e stress scenario measures),
//   - renderer.frame CPU ms p50 / p95 / max,
//   - render work counters (render/stats.ts): tiles rendered, strokes drawn into tiles, tile
//     blits, #base composites, full-canvas clears, canvases allocated / freed / resized, bloom
//     renders, synchronous flush steps, settles — as sums and per-frame maxima.
// Headless Chrome uses SwiftShader (software GL): absolute numbers are trend-only; compare runs
// on the same machine with the same settings.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { launch, penStroke, line, sleep } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const REPS = +arg('--reps', '3');
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const JSON_OUT = arg('--json', '');
// --doc file.rise: load these strokes instead of drawing (written on the first run if missing)
const DOC = arg('--doc', '');
const TOP = argv.includes('--top');
const URL_ARG = arg('--url', '');
const URL = (URL_ARG || pathToFileURL(resolve('dist-debug/index.html')).href) + '?debug';
if (!URL_ARG && !argv.includes('--no-build')) {
  console.log('Building --mode debug …');
  const r = spawnSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', 'debug', '--logLevel', 'warn'], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('vite build --mode debug failed'); process.exit(1); }
}
if (!URL_ARG && !existsSync(resolve('dist-debug/index.html'))) { console.error('dist-debug/index.html missing: run without --no-build'); process.exit(1); }
const CX = 640, CY = 410;

const R = (page, fn, ...a) => page.evaluate(fn, ...a);
const idle = (page, ms = 30000) => R(page, t => window.__rise.idle(t), ms);

async function open() {
  const env = await launch({ width: 1280, height: 820, url: URL });
  const { page } = env;
  const ready = () => page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  await ready();
  await R(page, () => window.__rise.wipe());
  await page.evaluate(() => { try { localStorage.setItem('rise:firstRunDone', 'true'); } catch {} });
  await page.reload({ waitUntil: 'load' });
  await ready();
  await idle(page);
  return env;
}

const wheelEv = (cdp, deltaX, deltaY, ctrl = false) =>
  cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX, deltaY, modifiers: ctrl ? 2 : 0 });

/** Gestures: each returns the camera to (about) where it started so reps are comparable. */
const GESTURES = {
  // exactly the e2e stress-300 storm: 20 notches alternating in / out, 60 ms apart
  storm: async cdp => { for (let i = 0; i < 20; i++) { await wheelEv(cdp, 0, i % 2 ? 120 : -120); await sleep(60); } },
  // 10 notches in then 10 out (×1.15 each: crosses ~4 half-octave levels each way)
  sweep: async cdp => { for (let i = 0; i < 20; i++) { await wheelEv(cdp, 0, i < 10 ? -120 : 120); await sleep(60); } },
  // trackpad two-finger scroll (pixel deltas, not notches): 30 events right/down, 30 back
  pan: async cdp => { for (let i = 0; i < 60; i++) { const s = i < 30 ? 1 : -1; await wheelEv(cdp, 13.5 * s, 9.5 * s); await sleep(16); } },
  // trackpad pinch (ctrl + small pixel deltas): 25 in, 25 out
  pinch: async cdp => { for (let i = 0; i < 50; i++) { await wheelEv(cdp, 0, i < 25 ? -4.5 : 4.5, true); await sleep(16); } },
};

const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = v => +v.toFixed(2);
const COUNTERS = ['composites', 'tileBlits', 'tileRenders', 'rectRenders', 'strokeDraws', 'flushSteps', 'fullClears',
  'canvasAlloc', 'canvasFree', 'canvasResize', 'bloomRenders', 'settles', 'setCamera', 'transformOnly'];

function summarize(frames, log) {
  const iv = frames.map(f => f.dt);
  const cpu = log.map(l => l.frameMs);
  const out = {
    rafFrames: iv.length,
    raf: { p50: r1(q(iv, 0.5)), p95: r1(q(iv, 0.95)), max: r1(iv.length ? Math.max(...iv) : 0) },
    rendererFrames: log.length,
    cpu: { p50: r1(q(cpu, 0.5)), p95: r1(q(cpu, 0.95)), max: r1(cpu.length ? Math.max(...cpu) : 0) },
    sum: {}, maxPerFrame: {},
  };
  for (const k of COUNTERS) {
    out.sum[k] = log.reduce((a, l) => a + (l[k] || 0), 0);
    out.maxPerFrame[k] = log.reduce((a, l) => Math.max(a, l[k] || 0), 0);
  }
  return out;
}

async function runGesture(env, name) {
  const { page, cdp } = env;
  await idle(page);
  await R(page, () => {
    window.__wheelT = [];
    if (!window.__wheelHook) {
      window.__wheelHook = true;
      window.addEventListener('wheel', () => window.__wheelT.push(performance.now()), { capture: true, passive: true });
    }
    window.__rise.renderStats({ reset: true, record: true });
    window.__frames = [];
    window.__stopFrames = false;
    let last = performance.now();
    const tick = t => { window.__frames.push({ t, dt: t - last }); last = t; if (!window.__stopFrames) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await sleep(100);
  const t0 = Date.now();
  await GESTURES[name](cdp);
  const gestureMs = Date.now() - t0;
  const settledOk = await idle(page, 30000);
  await sleep(100);
  const data = await R(page, () => {
    window.__stopFrames = true;
    const st = window.__rise.renderStats({ record: false });
    return { frames: window.__frames.slice(1), wheel: window.__wheelT, log: st.log };
  });
  const w0 = data.wheel[0], w1 = data.wheel[data.wheel.length - 1];
  const idleAt = data.frames.length ? data.frames[data.frames.length - 1].t : w1;
  const inBurst = t => t >= w0 && t <= w1 + 1;
  const inSettle = t => t > w1 + 1;
  const burst = summarize(data.frames.filter(f => inBurst(f.t)), data.log.filter(l => inBurst(l.t)));
  const settle = summarize(data.frames.filter(f => inSettle(f.t)), data.log.filter(l => inSettle(l.t)));
  // the e2e window: 2500 ms of rAF from the start of the gesture
  const e2e = summarize(data.frames.filter(f => f.t >= w0 - 100 && f.t <= w0 + 2400), []);
  // time from the last input event to the last renderer frame that did work
  let lastWork = w1;
  for (const l of data.log) if (l.t > w1 && (l.composites || l.strokeDraws || l.bloomRenders || l.tileBlits)) lastWork = l.t;
  if (TOP) {
    // the slowest rAF intervals with the renderer work of the frame that ended them
    const worst = [...data.frames].sort((a, b) => b.dt - a.dt).slice(0, 6);
    for (const f of worst) {
      const l = data.log.find(x => Math.abs(x.t - f.t) < 0.5);
      const work = l ? COUNTERS.filter(k => l[k]).map(k => `${k}=${l[k]}`).join(' ') : '(no renderer frame)';
      console.log(`      ${name} ${f.t > w1 + 1 ? 'settle' : 'burst '} +${r1(f.t - w0)} ms: raf ${r1(f.dt)} ms, cpu ${l ? r1(l.frameMs) : '-'} ms ${work}`);
    }
  }
  return {
    name, wheelEvents: data.wheel.length, gestureMs, settledOk,
    settleToDoneMs: r1(lastWork - w1), idleAfterMs: r1(idleAt - w1),
    burst, settle, e2eWindow: e2e.raf,
  };
}

function median(vals) { const s = [...vals].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

/** Median across reps of every numeric leaf. */
function mergeReps(reps) {
  const walk = (objs) => {
    const o0 = objs[0];
    if (typeof o0 === 'number') return median(objs);
    if (typeof o0 !== 'object' || o0 === null) return o0;
    const out = {};
    for (const k of Object.keys(o0)) out[k] = walk(objs.map(o => o[k]));
    return out;
  };
  return walk(reps);
}

function fmtPhase(label, p) {
  const s = p.sum, m = p.maxPerFrame;
  return `    ${label.padEnd(6)} raf p50/p95/max ${p.raf.p50}/${p.raf.p95}/${p.raf.max} ms (${p.rafFrames} fr)` +
    ` | cpu p50/p95/max ${p.cpu.p50}/${p.cpu.p95}/${p.cpu.max} ms (${p.rendererFrames} fr)\n` +
    `           composites ${s.composites} (max ${m.composites}/fr), blits ${s.tileBlits} (max ${m.tileBlits}/fr),` +
    ` tileRenders ${s.tileRenders}, rectRenders ${s.rectRenders}, strokeDraws ${s.strokeDraws} (max ${m.strokeDraws}/fr),` +
    ` flushSteps ${s.flushSteps}, fullClears ${s.fullClears} (max ${m.fullClears}/fr),` +
    ` canvases +${s.canvasAlloc}/-${s.canvasFree}/~${s.canvasResize}, bloom ${s.bloomRenders}, settles ${s.settles},` +
    ` setCamera ${s.setCamera}, transformOnly ${s.transformOnly}`;
}

// ---------------------------------------------------------------------------------------------
console.log(`Rise bench-zoom → ${URL} (reps ${REPS}; SwiftShader numbers are trend-only)`);
const env = await open();
const { page, cdp } = env;
const tDraw = Date.now();
const loaded = !!DOC && existsSync(DOC);
if (loaded) {
  // the same strokes for every run (drawn strokes depend on input timing, which load changes)
  await R(page, t => window.__rise.load(t), readFileSync(DOC, 'utf8'));
  await idle(page, 120000);
} else {
  const forms = ['line', 'echo', 'sprout', 'drift'];
  for (let i = 0; i < 300; i++) {
    if (i % 75 === 0) await R(page, f => window.__rise.dispatch({ k: 'pickForm', form: f }), forms[(i / 75) | 0]);
    const x = 80 + (i % 20) * 58, y = 80 + Math.floor(i / 20) * 46;
    await penStroke(cdp, line(x, y, x + 48, y + 18, 8));
  }
  await idle(page, 60000);
  if (DOC) writeFileSync(DOC, await R(page, () => window.__rise.serialize()));
}
const n = await R(page, () => window.__rise.strokeCount());
console.log(`  ${loaded ? 'loaded' : 'drew'} ${n} strokes in ${Date.now() - tDraw} ms`);
if (n !== 300) throw new Error('expected 300 strokes');

const names = Object.keys(GESTURES).filter(k => !ONLY.length || ONLY.includes(k));
const all = {};
for (const k of names) all[k] = [];
for (let rep = 0; rep < REPS; rep++) for (const k of names) all[k].push(await runGesture(env, k));
const result = {};
for (const k of names) {
  const m = mergeReps(all[k]);
  result[k] = m;
  console.log(`  ${k}: ${m.wheelEvents} events over ${m.gestureMs} ms; last work ${m.settleToDoneMs} ms after the last event; e2e-window raf p50/p95/max ${m.e2eWindow.p50}/${m.e2eWindow.p95}/${m.e2eWindow.max}`);
  console.log(fmtPhase('burst', m.burst));
  console.log(fmtPhase('settle', m.settle));
}
const errs = env.errors.filter(e => !/favicon/.test(e));
if (errs.length) console.log('  page errors:\n   ' + errs.join('\n   '));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ reps: REPS, result, raw: all }, null, 2));
await env.browser.close();
