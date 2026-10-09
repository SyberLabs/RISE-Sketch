#!/usr/bin/env node
// Rise end-to-end suite (DESIGN §7.6). Runs against the debug single-file build via file:// with
// ?debug, driving real pen / mouse / touch input through CDP and asserting through
// window.__rise (src/app/types.ts RiseDebug).
//
//   node scripts/e2e.mjs [--only name,name] [--budget] [--keep] [--out dir] [--url URL] [--no-build]
//   --budget runs the control-budget scenarios only (DESIGN §1.2): boot-budget, phone-layout, symmetry.
//   `counters` serves dist-debug over http itself (counters send nothing from file://).
//   --shard i/n runs the i-th of n deterministic slices of every scenario (CI runs them in parallel).
//
// The production single file (`npm run build:single`, dist-single/) carries no debug hooks:
// window.__rise is compiled in only when __DEBUG__ is set (vite.config.ts). So the suite first runs
// `vite build --mode debug`, which writes the same app plus the hooks to dist-debug/index.html, and
// drives that. `--no-build` reuses an existing dist-debug/; `--url` points elsewhere (no build).
// The `prod-file` scenario also builds dist-single/ and checks that the shipped file boots
// cleanly and exposes nothing.
//
// Screenshots land in e2e-out/ for visual review. Exit code 1 on any failure.
//
// Persistence: headless Chrome gives file:// pages a working IndexedDB, so reload-persist runs
// against the single-file build directly. Where a browser refuses IndexedDB on file:// (the app
// then shows the not-autosaving dot and toast, DESIGN §8), run the suite over http instead:
//   npx vite build --mode debug && npx vite preview --outDir dist-debug --port 5191 --strictPort
//   (in the background), then node scripts/e2e.mjs --url http://localhost:5191/
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import UPNG from 'upng-js';
import { launch, penStroke, mouseStroke, pinch, tap, wheel, key, wave, circle, line, sleep, measureFrames } from './harness.mjs';

// Typical scenario times in ms on a GitHub ubuntu-latest runner (the PASS lines; SwiftShader), used
// only to balance --shard. A scenario missing here (a new one) counts as UNTIMED and still runs.
const COST = {
  'stress-300': 268000, 'timelapse-vertical': 68000, 'draw-new-forms': 64000, timelapse: 58000, 'undo-redo-50': 48000,
  'remix-link': 47000, 'share-hint': 42000, 'draw-each-form': 37000, replay: 34000, 'remix-phone': 34000, 'share-hint-shared': 30000,
  hints: 24000, 'lasso-restyle-bend': 24000, 'erase-sweep': 23000, symmetry: 23000, 'rise-hold-mouse': 22000,
  'first-run-seed': 21000, 'prod-file': 20000, documents: 20000, 'rise-file-roundtrip': 20000, 'reload-persist': 19000,
  'select-restyle-delete': 18000, 'touch-pinch': 16000, closure: 14000, 'boot-budget': 14000, navigate: 13000,
  'export-png': 13000, 'png-project': 35000, 'rise-hold-pen': 12000, 'sample-alt-click': 11000, 'radial-seeds': 11000, 'phone-layout': 4000,
};
const UNTIMED = 10000;
/** The scenario names of shard `spec` ("i/n", 1-based): every `scenario('name'` in this file plus
 * prod-file, dealt longest first to the least-loaded shard, so the split is deterministic and
 * covers each scenario exactly once. */
function shardOf(spec) {
  const [i, n] = spec.split('/').map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) { console.error(`--shard ${spec}: want i/n with 1 <= i <= n`); process.exit(2); }
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const names = ['prod-file', ...[...src.matchAll(/^await scenario\('([^']+)'/gm)].map(m => m[1])];
  const cost = name => COST[name] ?? UNTIMED;
  names.sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1));
  const load = Array(n).fill(0), out = Array.from({ length: n }, () => []);
  for (const name of names) {
    const k = load.indexOf(Math.min(...load));
    load[k] += cost(name);
    out[k].push(name);
  }
  console.log(`shard ${i}/${n} (~${Math.round(load[i - 1] / 1000)} s): ${out[i - 1].join(', ')}`);
  return out[i - 1];
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const SHARD = arg('--shard', '');
const ONLY = argv.includes('--budget') ? ['boot-budget', 'phone-layout', 'symmetry']
  : SHARD ? shardOf(SHARD)
  : (arg('--only', '') || '').split(',').filter(Boolean);
const OUT = resolve(arg('--out', 'e2e-out'));
const URL_ARG = arg('--url', '');
const URL = (URL_ARG || pathToFileURL(resolve('dist-debug/index.html')).href) + '?debug';
const PROD = resolve('dist-single/index.html');
const wants = name => !ONLY.length || ONLY.includes(name);
if (SHARD && !ONLY.length) { console.log('empty shard: nothing to run'); process.exit(0); }
mkdirSync(OUT, { recursive: true });

/** `vite build --mode <mode>` with the local vite; exits on failure. */
function build(mode) {
  console.log(`Building --mode ${mode} …`);
  const r = spawnSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', mode, '--logLevel', 'warn'], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`vite build --mode ${mode} failed`); process.exit(1); }
}
if (!URL_ARG && !argv.includes('--no-build')) {
  build('debug');
  if (wants('prod-file')) build('single');
}
if (!URL_ARG && !existsSync(resolve('dist-debug/index.html'))) { console.error('dist-debug/index.html missing: run without --no-build'); process.exit(1); }

const W = 1280, H = 820;
const results = [];

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }
function near(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`); }

async function open(opts = {}) {
  const env = await launch({ width: opts.width || W, height: opts.height || H, url: URL, touch: !!opts.touch, dpr: opts.dpr || 1 });
  const { page } = env;
  await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  if (!opts.keepData) {
    await page.evaluate(() => window.__rise.wipe());
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  }
  if (!opts.firstRun) {
    // dismiss the first-run seed by touching nothing: mark first run done through prefs
    await page.evaluate(() => { try { localStorage.setItem('rise:firstRunDone', 'true'); } catch {} });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  }
  await idle(page);
  return env;
}
const idle = (page, ms = 8000) => page.evaluate(t => window.__rise.idle(t), ms);
const R = (page, fn, ...a) => page.evaluate(fn, ...a);
async function shot(page, name) { await page.screenshot({ path: `${OUT}/${name}.png` }); }
const controls = page => R(page, () => window.__rise.visibleControls());
const last = page => R(page, () => window.__rise.lastStroke());
const count = page => R(page, () => window.__rise.strokeCount());
const dispatch = (page, intent) => R(page, i => window.__rise.dispatch(i), intent);
/** Whether the toast comes to match `re` within `timeout` ms. */
const toastSays = (page, re, timeout = 5000) => page.waitForFunction(src => new RegExp(src).test(document.querySelector('.r-toast')?.textContent || ''), { timeout }, re.source).then(() => true, () => false);
/** An empty e2e-out/<name> that receives the browser's downloads. */
async function downloadsTo(browser, name) {
  const dir = resolve(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await (await browser.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  return dir;
}
/** The size of the timelapse video downloaded into `dir` (waits up to 5 s), or 0. */
async function downloadedMp4(dir) {
  for (let t = 0; t < 50; t++) {
    const f = readdirSync(dir).find(n => /^rise-\d{8}-\d{4}\.mp4$/.test(n));
    if (f) return statSync(resolve(dir, f)).size;
    await sleep(100);
  }
  return 0;
}

async function scenario(name, fn, opts) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const t0 = Date.now();
  let env;
  try {
    env = await open(opts);
    await fn(env);
    const errs = env.errors.filter(e => !/favicon/.test(e));
    assert(errs.length === 0, 'console/page errors:\n  ' + errs.join('\n  '));
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  PASS ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    if (env && !env.browser.connected) await sleep(500); // let the exit status arrive
    const why = env && env.gone.length ? ` [${env.gone.join('; ')}]` : '';
    results.push({ name, ok: false, ms: Date.now() - t0, err: String(e && e.stack || e) + why });
    console.log(`  FAIL ${name}: ${e && e.message}${why}`);
    if (env) { try { await shot(env.page, `FAIL-${name}`); } catch {} }
  } finally {
    if (env) await env.browser.close();
  }
}

// ---------------------------------------------------------------------------------------------
console.log(`Rise e2e → ${URL}`);

// The shipped single file (no debug hooks, so no window.__rise to drive): it boots with its
// chrome, a pen stroke changes the picture, nothing is logged as an error, and `?debug` exposes
// nothing.
if (wants('prod-file') && !URL_ARG) {
  const t0 = Date.now();
  let env;
  try {
    assert(existsSync(PROD), 'dist-single/index.html missing');
    env = await launch({ width: W, height: H, url: pathToFileURL(PROD).href + '?debug' });
    const { page, cdp } = env;
    await page.waitForFunction(() => document.querySelector('#stage canvas') && document.querySelector('#chrome button'), { timeout: 15000 });
    await sleep(800);
    const before = await page.screenshot();
    await penStroke(cdp, wave(300, 400, 900, 90, 60));
    await sleep(1500);
    const after = await page.screenshot({ path: `${OUT}/prod-file.png` });
    assert(!Buffer.from(before).equals(Buffer.from(after)), 'a stroke changes the picture');
    assert(await page.evaluate(() => typeof window.__rise) === 'undefined', 'the production file exposes no window.__rise');
    const errs = env.errors.filter(e => !/favicon/.test(e));
    assert(errs.length === 0, 'console/page errors:\n  ' + errs.join('\n  '));
    results.push({ name: 'prod-file', ok: true, ms: Date.now() - t0 });
    console.log(`  PASS prod-file (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name: 'prod-file', ok: false, ms: Date.now() - t0, err: String(e && e.stack || e) });
    console.log(`  FAIL prod-file: ${e && e.message}`);
  } finally {
    if (env) await env.browser.close();
  }
}

await scenario('boot-budget', async ({ page, cdp }) => {
  const c0 = await controls(page);
  assert(c0.count === 4, `empty canvas shows 4 controls, got ${c0.count}: ${c0.labels}`);
  await shot(page, 'boot');
  await penStroke(cdp, wave(380, 420, 900, 110, 90));
  await idle(page);
  const c1 = await controls(page);
  assert(c1.count === 5, `with ink shows 5 controls (adds Undo), got ${c1.count}: ${c1.labels}`);
  await dispatch(page, { k: 'undo' });
  await idle(page);
  const c2 = await controls(page);
  assert(c2.count <= 7 && c2.labels.length === c2.count, `after undo ≤ 7 controls, got ${c2.count}: ${c2.labels}`);
});

await scenario('draw-each-form', async ({ page, cdp }) => {
  const forms = ['line', 'echo', 'sprout', 'drift'];
  for (let i = 0; i < forms.length; i++) {
    await dispatch(page, { k: 'pickForm', form: forms[i] });
    await penStroke(cdp, wave(140 + i * 270, 300, 340 + i * 270, 90, 70));
    await idle(page);
    const s = await last(page);
    assert(s && s.form === forms[i], `stroke ${i} form ${forms[i]}, got ${s && s.form}`);
    assert(s.nPts > 10, `${forms[i]} produced geometry (${s.nPts} pts)`);
    if (forms[i] !== 'line') assert(s.gens >= 2, `${forms[i]} grew generations (gens=${s.gens})`);
  }
  assert(await count(page) === 4, 'four strokes');
  const c = await controls(page);
  assert(c.count === 5, `with ink: 5 controls, got ${c.count}: ${c.labels}`);
  await shot(page, 'forms-night');
  await dispatch(page, { k: 'ground', g: 'paper' });
  await idle(page);
  await shot(page, 'forms-paper');
});

await scenario('draw-new-forms', async ({ page, cdp }) => {
  // the seven Forms promoted from the forms lab, each in its gallery ink, on a 4 + 3 grid
  const forms = [['craze', 'oxide'], ['plume', 'ochre'], ['caustic', 'spectral'], ['burin', 'graphite'], ['plait', 'indigo'], ['orbit', 'rose'], ['ripple', 'ochre']];
  for (let i = 0; i < forms.length; i++) {
    const [form, ink] = forms[i];
    await dispatch(page, { k: 'pickForm', form });
    await dispatch(page, { k: 'pickInk', ink });
    const x0 = 60 + (i % 4) * 300, y = 250 + Math.floor(i / 4) * 320;
    await penStroke(cdp, wave(x0, y, x0 + 240, 70, 70));
    await idle(page);
    const s = await last(page);
    assert(s && s.form === form, `stroke ${i} form ${form}, got ${s && s.form}`);
    assert(s.nPts > 10, `${form} produced geometry (${s.nPts} pts)`);
    assert(s.gens >= 2, `${form} grew generations (gens=${s.gens})`);
  }
  // a tap with each is a radial seed (bottom row)
  for (let i = 0; i < forms.length; i++) {
    const [form, ink] = forms[i];
    await dispatch(page, { k: 'pickForm', form });
    await dispatch(page, { k: 'pickInk', ink });
    const x = 160 + i * 160, y = 735;
    await penStroke(cdp, [[x, y, 0.6], [x + 0.5, y + 0.3, 0.7], [x + 0.8, y + 0.4, 0.7]]);
    await idle(page);
    const s = await last(page);
    assert(s.form === form && s.radial, `${form} tap is radial (form=${s.form}, radial=${s.radial})`);
    assert(s.nPts > 3, `${form} tap produced geometry (${s.nPts} pts)`);
  }
  assert(await count(page) === 14, 'seven strokes and seven taps');
  // a .rise round trip keeps the new Form ids (serialize.ts knows them)
  const h0 = await R(page, () => window.__rise.sceneHash());
  const text = await R(page, () => window.__rise.serialize());
  await R(page, t => window.__rise.load(t), text);
  await idle(page);
  assert(await R(page, () => window.__rise.sceneHash()) === h0, 'round trip keeps the scene hash');
  await shot(page, 'new-forms-night');
  await dispatch(page, { k: 'ground', g: 'paper' });
  await idle(page);
  await shot(page, 'new-forms-paper');
  // number keys 5–9 and 0 pick them, in sheet order
  const keys = ['Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
  for (let i = 0; i < keys.length; i++) {
    await key(page, keys[i]);
    const f = await R(page, () => window.__rise.state().tool.form);
    assert(f === forms[i][0], `${keys[i]} picks ${forms[i][0]}, got ${f}`);
    // the Form chip's glyph is that Form grown on a tiny squiggle
    await idle(page);
    await sleep(250);
    const inked = await R(page, () => {
      const cv = document.querySelector('.r-chip[data-chip="form"] canvas.r-glyph');
      const g = cv && cv.width > 0 ? cv.getContext('2d') : null;
      if (!g) return -1;
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k] > 24) n++;
      return n;
    });
    assert(inked !== 0, `${forms[i][0]} chip glyph has ink (${inked} px)`);
    const chip = await page.$('.r-chip[data-chip="form"]');
    await chip.screenshot({ path: `${OUT}/new-forms-chip-${forms[i][0]}.png` });
  }
  // the Form sheet offers all eleven as labelled tiles, two rows (6 + 5) on desktop
  await dispatch(page, { k: 'openSheet', sheet: 'form' });
  await idle(page);
  await sleep(400);
  const tiles = await R(page, () => [...document.querySelectorAll('.r-sheet[data-sheet="form"] .r-tile')].map(t => {
    const b = t.getBoundingClientRect();
    return { label: t.textContent.trim(), top: Math.round(b.top) };
  }));
  assert(tiles.length === 11, `eleven Form tiles, got ${tiles.length}`);
  const labels = tiles.map(t => t.label).join(',');
  assert(labels === 'Line,Echo,Sprout,Drift,Craze,Plume,Caustic,Burin,Plait,Orbit,Ripple', `tile labels ${labels}`);
  const rows = new Set(tiles.map(t => t.top)).size;
  assert(rows === 2, `two rows of tiles on desktop, got ${rows}`);
  await shot(page, 'new-forms-sheet');
});

await scenario('rise-hold-pen', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await penStroke(cdp, line(300, 420, 700, 400, 60), { hold: 1400 });
  await idle(page);
  const s = await last(page);
  assert(s.pools >= 1 && s.maxPool > 0.5, `hold created a pool (pools=${s.pools}, max=${s.maxPool})`);
  await shot(page, 'rise-pen');
  // peel undo: first undo drains the pools, second removes the stroke
  await dispatch(page, { k: 'undo' });
  await idle(page);
  const s2 = await last(page);
  assert(s2 && s2.pools === 0, 'first undo peels the pools');
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await count(page) === 0, 'second undo removes the stroke');
});

await scenario('rise-hold-mouse', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'drift' });
  await mouseStroke(cdp, line(300, 420, 640, 380, 50), { hold: 1500 });
  await idle(page);
  const s = await last(page);
  assert(s.device === 'mouse', 'mouse device');
  assert(s.pools >= 1, `mouse hold created a pool (pools=${s.pools})`);
  await shot(page, 'rise-mouse');
});

await scenario('radial-seeds', async ({ page, cdp }) => {
  const forms = ['line', 'echo', 'sprout', 'drift'];
  for (let i = 0; i < forms.length; i++) {
    await dispatch(page, { k: 'pickForm', form: forms[i] });
    const x = 250 + i * 250, y = 400;
    await penStroke(cdp, [[x, y, 0.6], [x + 0.5, y + 0.3, 0.7], [x + 0.8, y + 0.4, 0.7]]);
    await idle(page);
    const s = await last(page);
    assert(s.radial, `${forms[i]} tap is radial`);
  }
  await shot(page, 'radial');
});

await scenario('closure', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'echo' });
  await penStroke(cdp, circle(640, 410, 160, 90, 1.03));
  await idle(page);
  const s = await last(page);
  assert(s.closed, 'circle closes');
  await shot(page, 'closure-echo');
});

await scenario('erase-sweep', async ({ page, cdp }) => {
  for (let i = 0; i < 3; i++) await penStroke(cdp, wave(300, 250 + i * 150, 900, 40, 50));
  await idle(page);
  assert(await count(page) === 3, 'three strokes');
  await dispatch(page, { k: 'pickErase' });
  await penStroke(cdp, line(600, 150, 600, 700, 40));
  await idle(page);
  assert(await count(page) === 0, `erase sweep removed all (left ${await count(page)})`);
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await count(page) === 3, 'one undo restores the whole eraser gesture');
});

await scenario('select-restyle-delete', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'line' });
  await penStroke(cdp, wave(300, 300, 900, 60, 60));
  await penStroke(cdp, wave(300, 520, 900, 60, 60));
  await idle(page);
  // Mod-click on the first stroke
  const isMac = await R(page, () => window.__rise.state().isMac);
  const mod = isMac ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.mouse.click(600, 300);
  await page.keyboard.up(mod);
  await idle(page);
  let st = await R(page, () => window.__rise.state());
  assert(st.selection.length === 1, `mod-click selects one (got ${st.selection.length})`);
  const c = await controls(page);
  assert(c.count <= 6, `selection budget ≤ 6, got ${c.count}: ${c.labels}`);
  await shot(page, 'selection');
  const h0 = await R(page, () => window.__rise.sceneHash());
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await idle(page);
  const h1 = await R(page, () => window.__rise.sceneHash());
  assert(h0 !== h1, 'restyle changed the document');
  await dispatch(page, { k: 'delete' });
  await idle(page);
  assert(await count(page) === 1, 'delete removed the selection');
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await count(page) === 2, 'undo restored it');
});

await scenario('undo-redo-50', async ({ page, cdp }) => {
  for (let i = 0; i < 25; i++) {
    const y = 120 + (i % 12) * 50, x = 200 + Math.floor(i / 12) * 300;
    await penStroke(cdp, line(x, y, x + 260, y + 10, 16));
  }
  await idle(page, 20000);
  const h = await R(page, () => window.__rise.sceneHash());
  for (let i = 0; i < 25; i++) await dispatch(page, { k: 'undo' });
  await idle(page, 20000);
  assert(await count(page) === 0, 'undo all');
  for (let i = 0; i < 25; i++) await dispatch(page, { k: 'redo' });
  await idle(page, 20000);
  assert(await R(page, () => window.__rise.sceneHash()) === h, 'redo all restores the identical scene');
});

await scenario('reload-persist', async (env) => {
  const { page, cdp } = env;
  await dispatch(page, { k: 'pickForm', form: 'drift' });
  await penStroke(cdp, wave(300, 400, 950, 120, 80));
  await dispatch(page, { k: 'pickForm', form: 'echo' });
  await penStroke(cdp, wave(300, 250, 950, 60, 60, 2));
  await idle(page, 15000);
  const h = await R(page, () => window.__rise.sceneHash());
  await R(page, () => window.__rise.idle(5000));
  await sleep(600); // autosave batch
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  await idle(page, 15000);
  assert(await count(page) === 2, `reload restores strokes (got ${await count(page)})`);
  assert(await R(page, () => window.__rise.sceneHash()) === h, 'reload restores the identical scene hash');
  await shot(page, 'reload');
}, { keepData: false });

await scenario('rise-file-roundtrip', async ({ page, cdp }) => {
  await penStroke(cdp, wave(300, 400, 950, 120, 80), { hold: 900 });
  await penStroke(cdp, circle(640, 300, 90, 60));
  await idle(page, 15000);
  const h = await R(page, () => window.__rise.sceneHash());
  const text = await R(page, () => window.__rise.serialize());
  const json = JSON.parse(text);
  assert(json.format === 'rise' && json.version === 2, '.rise header (format v2)');
  await dispatch(page, { k: 'new' });
  await idle(page);
  assert(await count(page) === 0, 'new canvas is empty');
  await R(page, t => window.__rise.load(t), text);
  await idle(page, 15000);
  assert(await R(page, () => window.__rise.sceneHash()) === h, 'round trip preserves the scene hash');
});

await scenario('export-png', async ({ page, cdp }) => {
  await penStroke(cdp, wave(300, 400, 950, 120, 80));
  await idle(page);
  const r = await R(page, () => window.__rise.exportPng());
  assert(r.width >= 1000 && r.height > 100 && r.bytes > 5000, `export ${r.width}x${r.height} ${r.bytes}B`);
});

// Remixable images (DESIGN §8 Export): Mod+E downloads a PNG that carries the project. Opened in a
// fresh browser with a drawing of its own (Mod+O), it is the exact drawing (same sceneHash, not a
// rounded remix) as a new document, and the visitor's drawing stays in Recent. A plain PNG dropped
// on the canvas says it has no drawing in it and changes nothing.
await scenario('png-project', async ({ browser, page, cdp }) => {
  await dispatch(page, { k: 'pickInk', ink: 'spectral' });
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await dispatch(page, { k: 'symmetry', folds: 6 });
  await penStroke(cdp, line(700, 300, 980, 330, 50), { hold: 600 });
  await idle(page, 15000);
  assert(await count(page) === 6, `six strokes to export (${await count(page)})`);
  const h = await R(page, () => window.__rise.sceneHash());
  const dl = await downloadsTo(browser, 'png-project-download');
  const mod = (await R(page, () => window.__rise.state().isMac)) ? 'Meta' : 'Control';
  await key(page, 'KeyE', [mod]);
  assert(await toastSays(page, /Image saved/, 30000), 'Mod+E saves the image');
  let file = '';
  for (let t = 0; t < 50 && !file; t++) { file = readdirSync(dl).find(n => /^rise-\d{8}-\d{4}\.png$/.test(n)) || ''; if (!file) await sleep(100); }
  assert(file, `the PNG was downloaded (${readdirSync(dl)})`);
  const png = readFileSync(resolve(dl, file));
  const img = UPNG.decode(png.buffer.slice(png.byteOffset, png.byteOffset + png.length));
  assert(img.width >= 1000 && img.height > 100, `still an image (${img.width}×${img.height})`);
  assert(png.includes(Buffer.from('iTXtrise-sketch\0')), 'the project rides in an iTXt chunk');

  const v = await open();
  try {
    await dispatch(v.page, { k: 'pickForm', form: 'drift' });
    await penStroke(v.cdp, wave(300, 400, 900, 90, 60));
    await idle(v.page);
    await sleep(700); // autosave batch
    const own = await R(v.page, () => window.__rise.state().currentDocId);
    const [chooser] = await Promise.all([v.page.waitForFileChooser(), key(v.page, 'KeyO', [mod])]);
    await chooser.accept([resolve(dl, file)]);
    assert(await toastSays(v.page, /Opened/, 10000), 'opening the PNG says so');
    await idle(v.page, 15000);
    assert(await count(v.page) === 6, `the drawing opens from the image (${await count(v.page)} strokes)`);
    assert(await R(v.page, () => window.__rise.sceneHash()) === h, 'the exact drawing: the same scene hash');
    assert(await R(v.page, () => window.__rise.state().currentDocId) !== own, 'it opens as a new document');
    await sleep(700);
    await dispatch(v.page, { k: 'openSheet', sheet: 'menu' });
    await sleep(900);
    const st = await R(v.page, () => window.__rise.state());
    assert(st.recentDocs.some(d => d.id === own && d.strokes === 1), `the visitor's drawing is still in Recent (${st.recentDocs.map(d => d.id + ':' + d.strokes)})`);
    await dispatch(v.page, { k: 'openSheet', sheet: null });
    await shot(v.page, 'png-project-opened');
    // a plain PNG (a screenshot), dropped on the canvas
    const plain = Buffer.from(await v.page.screenshot()).toString('base64');
    await R(v.page, b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
      const stage = document.querySelector('#stage');
      for (const type of ['dragenter', 'dragover', 'drop']) stage.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, plain);
    assert(await toastSays(v.page, /This image has no RISE Sketch drawing in it/), 'a plain PNG says it has no drawing');
    assert(await R(v.page, () => window.__rise.sceneHash()) === h, 'a plain PNG changes nothing');
    const errs = v.errors.filter(e => !/favicon/.test(e));
    assert(errs.length === 0, 'visitor console/page errors:\n  ' + errs.join('\n  '));
  } finally {
    await v.browser.close();
  }
});

// Share timelapse (DESIGN §8): Shift+P records the replay as a video and, on a desktop, downloads
// it even where the browser offers a share sheet (desktop sheets don't reach the chat apps); the debug hook hands back the same recording for inspection in a <video>. The
// video and its first, middle and last frames land in e2e-out/ for review.
await scenario('timelapse', async ({ browser, page, cdp }) => {
  await dispatch(page, { k: 'pickInk', ink: 'spectral' });
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await dispatch(page, { k: 'symmetry', folds: 6 });
  await penStroke(cdp, wave(660, 300, 900, 40, 50), { delay: 6 });
  await idle(page);
  await dispatch(page, { k: 'symmetry', on: false });
  await dispatch(page, { k: 'pickForm', form: 'ripple' });
  await penStroke(cdp, [[640, 410, 0.6], [640.5, 410.3, 0.7], [640.8, 410.4, 0.7]], { hold: 700 });
  await idle(page);
  const h = await R(page, () => window.__rise.sceneHash());
  const n0 = await count(page);
  // the key, delivered as a download: intercept it
  const dl = await downloadsTo(browser, 'timelapse-download');
  // a share sheet that takes files, as desktop Chrome and Edge on Windows have: it must stay closed
  await R(page, () => {
    window.__sheetOpened = false;
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async () => { window.__sheetOpened = true; }, configurable: true });
  });
  await key(page, 'P', ['Shift']);
  let st = await R(page, () => window.__rise.state());
  assert(st.recording, 'Shift+P starts recording');
  // the toast follows the async encoder probe (VideoEncoder.isConfigSupported), which takes no fixed time
  assert(await toastSays(page, /Recording timelapse/, 10000), 'a progress toast shows');
  // drawing goes on while it records
  await penStroke(cdp, line(200, 700, 420, 690, 20));
  await page.waitForFunction(() => !window.__rise.state().recording, { timeout: 90000 });
  assert(await toastSays(page, /Timelapse saved/), 'Timelapse saved');
  const bytes = await downloadedMp4(dl);
  assert(bytes > 50000, `a real video was downloaded (${bytes} B: ${readdirSync(dl)})`);
  assert(!(await R(page, () => window.__sheetOpened)), 'a desktop never opens the share sheet');
  assert(await count(page) === n0 + 1, 'the stroke drawn while recording landed');
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await R(page, () => window.__rise.sceneHash()) === h, 'recording changed nothing');
  // the recording itself, through the debug hook; the first and last frames the app hands the
  // encoder are kept (clones) to compare with what comes out of the video
  await R(page, () => {
    const encode = VideoEncoder.prototype.encode;
    window.__fed = { first: null, last: null, restore: () => { VideoEncoder.prototype.encode = encode; } };
    VideoEncoder.prototype.encode = function (frame, opts) {
      const f = window.__fed;
      if (!f.first) f.first = frame.clone();
      else { f.last?.close(); f.last = frame.clone(); }
      return encode.call(this, frame, opts);
    };
  });
  const r = await R(page, () => window.__rise.timelapse());
  await R(page, () => window.__fed.restore());
  assert(r && r.bytes > 50000 && r.width === 1080 && (r.height === 1080 || r.height === 1350), `timelapse ${JSON.stringify(r && { ...r, url: 0 })}`);
  const v = await R(page, async url => {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    const el = document.createElement('video');
    el.muted = true; el.src = url;
    await new Promise((ok, no) => { el.onloadedmetadata = ok; el.onerror = () => no(new Error('the video does not load')); });
    if (!Number.isFinite(el.duration)) { el.currentTime = 1e9; await new Promise(ok => { el.ondurationchange = ok; setTimeout(ok, 3000); }); }
    const c = document.createElement('canvas'); c.width = el.videoWidth; c.height = el.videoHeight;
    const ctx = c.getContext('2d');
    const grab = async t => {
      el.currentTime = t;
      await new Promise(ok => { el.onseeked = ok; });
      ctx.drawImage(el, 0, 0);
      return { px: ctx.getImageData(0, 0, c.width, c.height).data, png: c.toDataURL('image/png') };
    };
    // the middle of each frame: frame 0, 40 % in, and the very last frame
    const first = await grab(0.5 / 30), mid = await grab(el.duration * 0.4), last = await grab(el.duration - 0.5 / 30);
    const fed = f => { ctx.drawImage(f, 0, 0); f.close(); return ctx.getImageData(0, 0, c.width, c.height).data; };
    const fed0 = fed(window.__fed.first), fedN = fed(window.__fed.last);
    const diff = (a, b) => {
      let d = 0;
      for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return d / (a.length / 4);
    };
    return {
      duration: el.duration, w: el.videoWidth, h: el.videoHeight, b64: btoa(bin), first: first.png, mid: mid.png, last: last.png,
      fedSeam: diff(fed0, fedN), seam: diff(first.px, last.px), err0: diff(fed0, first.px), errN: diff(fedN, last.px), grow: diff(first.px, mid.px),
    };
  }, r.url);
  writeFileSync(`${OUT}/timelapse.mp4`, Buffer.from(v.b64, 'base64'));
  for (const k of ['first', 'mid', 'last']) writeFileSync(`${OUT}/timelapse-${k}.png`, Buffer.from(v[k].split(',')[1], 'base64'));
  assert(v.w === r.width && v.h === r.height, `the video is ${v.w}×${v.h}`);
  assert(v.duration >= 3 && v.duration <= 12.5, `plausible duration (${v.duration} s)`);
  near(v.duration, r.durationMs / 1000, 0.1, 'the container duration matches the frames');
  console.log(`    mean |Δ|: fed seam ${v.fedSeam.toFixed(4)}, decoded seam ${v.seam.toFixed(2)}, codec error frame 0 ${v.err0.toFixed(2)}, last ${v.errN.toFixed(2)}, grow ${v.grow.toFixed(2)}`);
  // Frame 0 is the finished piece and the hold ends on it: the clip loops without a seam.
  // The app's claim, on the frames it hands the encoder: the last is the first. Not always
  // bit-exact (0–0.001 measured on macOS and the Linux runner: at most a few hundred pixels where
  // strokes cross, invisible); a seam anyone could see is far more (the growing piece is 20+ away).
  assert(v.fedSeam < 0.01, `the last frame fed to the encoder is the first (mean |Δ| ${v.fedSeam.toFixed(4)})`);
  // In the video, the two ends differ by codec noise only: no more than the codec's own error on
  // frame 0 (decoded vs the frame it was fed). Measured seam vs that error: macOS VideoToolbox
  // 3.0–3.2 vs 5.7–6.1; macOS software H.264 3.5–4.1 vs 6.4–7.2; Linux runner (OpenH264) 4.6–4.8 vs 6.3–6.4.
  assert(v.seam <= v.err0, `the video's last frame is its first, up to codec noise (seam ${v.seam.toFixed(2)} vs frame 0 codec error ${v.err0.toFixed(2)})`);
  assert(v.grow > 2, `the ink grows: the middle differs from the finished piece (mean |Δ| ${v.grow.toFixed(2)})`);
});

// On a phone or tablet (coarse pointer) the timelapse is the 9:16 frame the feed apps want, and it
// leaves through the share sheet; closing the sheet turns the toast into Save, which downloads it.
await scenario('timelapse-vertical', async ({ browser, page, cdp }) => {
  assert((await R(page, () => window.__rise.state())).isTouch, 'a touch device');
  await penStroke(cdp, wave(60, 400, 340, 60, 40), { delay: 4 });
  await idle(page);
  const r = await R(page, () => window.__rise.timelapse());
  assert(r && r.width === 1080 && r.height === 1920, `vertical timelapse ${JSON.stringify(r && { ...r, url: 0 })}`);
  const dl = await downloadsTo(browser, 'timelapse-phone-download');
  // a share sheet the person closes
  await R(page, () => {
    window.__shared = [];
    Object.defineProperty(navigator, 'canShare', { value: d => !!d.files?.length, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async d => { window.__shared.push(d.files.map(f => f.name)); throw new DOMException('closed', 'AbortError'); }, configurable: true });
  });
  await dispatch(page, { k: 'timelapse' });
  assert(await toastSays(page, /Timelapse ready.*Share/, 90000), 'the finished video waits on a Share toast');
  await page.click('.r-toast-action');
  assert(await toastSays(page, /Timelapse ready.*Save/), 'closing the sheet offers Save');
  const shared = await R(page, () => window.__shared);
  assert(shared.length === 1 && /^rise-\d{8}-\d{4}\.mp4$/.test(shared[0][0]), `the sheet got the video (${JSON.stringify(shared)})`);
  await page.click('.r-toast-action');
  assert(await toastSays(page, /Timelapse saved/), 'Save confirms');
  assert(await downloadedMp4(dl) > 50000, `Save downloads the video (${readdirSync(dl)})`);
}, { touch: true, width: 400, height: 860 });

await scenario('first-run-seed', async ({ page, cdp }) => {
  await sleep(2600); // seed plays after 600 ms idle and takes ~2.4 s
  await shot(page, 'first-run-seed');
  assert(await count(page) === 0, 'seed never enters the document');
  const st = await R(page, () => window.__rise.state());
  assert(st.firstRun, 'first run flag');
  await penStroke(cdp, wave(300, 500, 900, 60, 50));
  await idle(page);
  assert(await count(page) === 1, 'the first touch draws the user stroke');
  await shot(page, 'first-run-after');
}, { firstRun: true });

await scenario('navigate', async ({ page, cdp }) => {
  await penStroke(cdp, wave(300, 400, 950, 120, 80));
  await idle(page);
  const c0 = await R(page, () => window.__rise.camera());
  await wheel(cdp, 640, 410, -120);
  await idle(page);
  const c1 = await R(page, () => window.__rise.camera());
  assert(c1.scale > c0.scale, `wheel zooms in (${c0.scale} -> ${c1.scale})`);
  const cc = await controls(page);
  assert(cc.labels.some(l => /%/.test(l)) || cc.count >= 6, 'view chip appears off 100%');
  await dispatch(page, { k: 'resetView' });
  await idle(page);
  near((await R(page, () => window.__rise.camera())).scale, 1, 1e-6, 'reset view');
  await shot(page, 'navigate');
});

await scenario('touch-pinch', async ({ page, cdp }) => {
  // A one-finger tap on the canvas is a radial seed (DESIGN §2.3.8), committed after the 300 ms
  // double-tap window, and a pen landing inside that window withdraws it (input contract #2).
  // So the tap that marks this as a touch device is let settle before the pen draws, and the
  // pinch is checked to add nothing to whatever is there (it used to assume the tap drew nothing,
  // which raced the 300 ms window).
  await tap(cdp, 10, 10); // touch device
  await idle(page);
  await penStroke(cdp, wave(300, 400, 950, 120, 80));
  await idle(page);
  const n0 = await count(page);
  assert(n0 >= 1, 'the pen stroke is in the document');
  const c0 = await R(page, () => window.__rise.camera());
  await pinch(cdp, [[540, 410], [740, 410]], [[440, 410], [840, 410]]);
  await idle(page);
  const c1 = await R(page, () => window.__rise.camera());
  assert(c1.scale > c0.scale * 1.3, `pinch zooms (${c0.scale} -> ${c1.scale})`);
  assert(await count(page) === n0, 'pinch drew nothing');
}, { touch: true });

await scenario('phone-layout', async ({ page, cdp }) => {
  const c = await controls(page);
  assert(c.count === 4, `phone empty canvas 4 controls (got ${c.count}: ${c.labels})`);
  await shot(page, 'phone');
  await dispatch(page, { k: 'openSheet', sheet: 'color' });
  await idle(page);
  await shot(page, 'phone-color-sheet');
}, { width: 390, height: 844, touch: true });

await scenario('stress-300', async ({ page, cdp }) => {
  const forms = ['line', 'echo', 'sprout', 'drift'];
  for (let i = 0; i < 300; i++) {
    if (i % 75 === 0) await dispatch(page, { k: 'pickForm', form: forms[(i / 75) | 0] });
    const x = 80 + (i % 20) * 58, y = 80 + Math.floor(i / 20) * 46;
    await penStroke(cdp, line(x, y, x + 48, y + 18, 8));
  }
  await idle(page, 60000);
  assert(await count(page) === 300, '300 strokes');
  await R(page, () => window.__rise.perf(true));
  const frames = await measureFrames(page, 2500, async () => {
    for (let i = 0; i < 20; i++) {
      await wheel(cdp, 640, 410, i % 2 ? 120 : -120);
      await sleep(60);
    }
  });
  const perf = await R(page, () => window.__rise.perf());
  console.log('    stress frames', JSON.stringify(frames), 'perf', JSON.stringify(perf));
  await idle(page, 30000);
  await shot(page, 'stress');
});

await scenario('lasso-restyle-bend', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await penStroke(cdp, wave(300, 300, 900, 60, 60));
  await penStroke(cdp, wave(300, 520, 900, 60, 60));
  await idle(page);
  const isMac = await R(page, () => window.__rise.state().isMac);
  const mod = isMac ? 'Meta' : 'Control';
  // Mod-drag lasso around both strokes
  await page.keyboard.down(mod);
  await page.mouse.move(240, 200);
  await page.mouse.down();
  const corners = [[960, 200], [960, 640], [240, 640], [240, 220]];
  for (const [x, y] of corners) await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(mod);
  await idle(page);
  let st = await R(page, () => window.__rise.state());
  assert(st.selection.length === 2, `lasso selects both (got ${st.selection.length})`);
  assert(st.selectionRect && st.selectionRect.w > 500, `selectionRect covers the strokes (${JSON.stringify(st.selectionRect)})`);
  assert(st.tool.form === 'sprout' && st.tool.recents.length >= 1, 'the selection mirrors its style into the tool');
  const c = await controls(page);
  assert(c.count <= 6 && !c.labels.some(l => /menu/i.test(l)), `selection budget ≤ 6 without the menu, got ${c.count}: ${c.labels}`);
  const h0 = await R(page, () => window.__rise.sceneHash());
  // a Form-chip drag: preview while dragging, one replace on release
  await dispatch(page, { k: 'bendDepth', delta: -0.5, done: false });
  await sleep(80);
  await dispatch(page, { k: 'bendDepth', delta: -1, done: false });
  await sleep(80);
  await dispatch(page, { k: 'bendDepth', delta: -1, done: true });
  await idle(page);
  const h1 = await R(page, () => window.__rise.sceneHash());
  assert(h1 !== h0, 'the bend restyled the selection');
  const s = await last(page);
  assert(s.base === 1, `depth bent relatively per stroke (2 -> 1, got ${s.base})`);
  await shot(page, 'lasso-bend');
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await R(page, () => window.__rise.sceneHash()) === h0, 'one undo restores both strokes (one replace)');
  // R reseeds the selection: geometry changes, count does not
  await dispatch(page, { k: 'reseed' });
  await idle(page);
  assert(await R(page, () => window.__rise.sceneHash()) !== h0, 'reseed changed the selection');
  assert(await count(page) === 2, 'reseed keeps the strokes');
  // Esc deselects and restores the tool
  await page.keyboard.press('Escape');
  await idle(page);
  st = await R(page, () => window.__rise.state());
  assert(st.selection.length === 0 && st.selectionRect === null, 'Escape deselects');
  assert((await controls(page)).count === 5, 'back to 5 controls after deselect');
});

await scenario('sample-alt-click', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickInk', ink: 'oxide' });
  await penStroke(cdp, wave(300, 300, 900, 60, 60));
  await idle(page);
  await page.keyboard.down('Alt');
  await page.mouse.click(600, 300);
  await page.keyboard.up('Alt');
  await idle(page);
  const st = await R(page, () => window.__rise.state());
  assert(st.tool.ink === 'custom' && st.tool.custom, `Alt-click sampled a custom ink (got ${st.tool.ink})`);
  assert(st.tool.recents.length >= 1 && st.tool.recents[0].ink === 'custom', 'the sample is recent slot 1');
  assert(await count(page) === 1, 'sampling never draws');
});

await scenario('replay', async ({ page, cdp }) => {
  const forms = ['sprout', 'drift', 'line'];
  for (let i = 0; i < 3; i++) {
    await dispatch(page, { k: 'pickForm', form: forms[i] });
    await penStroke(cdp, wave(200 + i * 300, 400, 420 + i * 300, 80, 60), { hold: i === 0 ? 700 : 0 });
  }
  await idle(page);
  const h = await R(page, () => window.__rise.sceneHash());
  await dispatch(page, { k: 'replay' });
  await sleep(120);
  let st = await R(page, () => window.__rise.state());
  assert(st.replaying, 'replay started');
  assert((await controls(page)).count === 0, 'the UI hides during replay');
  await sleep(500);
  await shot(page, 'replay-mid');
  await idle(page, 30000);
  st = await R(page, () => window.__rise.state());
  assert(!st.replaying, 'replay finished by itself');
  assert(await count(page) === 3 && await R(page, () => window.__rise.sceneHash()) === h, 'replay changes nothing');
  await shot(page, 'replay-done');
  // any input stops playback
  await dispatch(page, { k: 'replay' });
  await sleep(150);
  await page.mouse.click(640, 100);
  await sleep(50);
  st = await R(page, () => window.__rise.state());
  assert(!st.replaying, 'a pointer stops the replay');
  await idle(page, 30000);
  assert(await count(page) === 3 && await R(page, () => window.__rise.sceneHash()) === h, 'stopping keeps the drawing intact');
  await shot(page, 'replay-stopped');
});

await scenario('documents', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'drift' });
  await penStroke(cdp, wave(300, 400, 950, 120, 80));
  await idle(page);
  const id0 = await R(page, () => window.__rise.state().currentDocId);
  const h0 = await R(page, () => window.__rise.sceneHash());
  await sleep(700); // autosave batch
  await dispatch(page, { k: 'new' });
  await idle(page);
  assert(await count(page) === 0, 'New starts empty');
  const id1 = await R(page, () => window.__rise.state().currentDocId);
  assert(id1 !== id0, 'New is a different document');
  await penStroke(cdp, wave(300, 300, 700, 40, 40));
  await idle(page);
  await sleep(700);
  await dispatch(page, { k: 'openSheet', sheet: 'menu' });
  await sleep(900);
  await idle(page);
  let st = await R(page, () => window.__rise.state());
  assert(st.recentDocs.some(d => d.id === id0), `Recent lists the previous document (${st.recentDocs.map(d => d.id)})`);
  const prev = st.recentDocs.find(d => d.id === id0);
  assert(prev.strokes === 1, `Recent knows its stroke count (${prev.strokes})`);
  await shot(page, 'recent');
  await dispatch(page, { k: 'openRecent', id: id0 });
  await dispatch(page, { k: 'openSheet', sheet: null });
  await idle(page, 15000);
  assert(await count(page) === 1, 'opening a Recent document restores its strokes');
  assert(await R(page, () => window.__rise.sceneHash()) === h0, 'the same scene comes back');
  assert(await R(page, () => window.__rise.state().currentDocId) === id0, 'currentDocId follows');
  await dispatch(page, { k: 'deleteRecent', id: id0 });
  await idle(page, 15000);
  assert(await count(page) === 0, 'deleting the open document moves to a fresh canvas');
  await sleep(300);
  st = await R(page, () => window.__rise.state());
  assert(!st.recentDocs.some(d => d.id === id0), 'the deleted document left Recent');
  assert(st.recentDocs.some(d => d.id === id1), 'the other document is still there');
});

await scenario('hints', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'line' });
  await penStroke(cdp, line(300, 200, 800, 210, 30));
  await idle(page);
  await sleep(1400);
  let st = await R(page, () => window.__rise.state());
  assert(st.hints.form !== 'pending', `the Form hint shows 1.2 s after the first stroke (${st.hints.form})`);
  for (let i = 1; i < 5; i++) await penStroke(cdp, line(300, 200 + i * 90, 800, 210 + i * 90, 30));
  await idle(page);
  st = await R(page, () => window.__rise.state());
  assert(st.hints.rise !== 'pending', `the rise hint shows at stroke 5 without a rise (${st.hints.rise})`);
  await shot(page, 'hint-rise');
  await penStroke(cdp, line(300, 700, 800, 700, 30), { hold: 1200 });
  await idle(page);
  st = await R(page, () => window.__rise.state());
  assert(st.hints.rise === 'done', 'a rise dismisses the rise hint');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  await idle(page, 15000);
  st = await R(page, () => window.__rise.state());
  assert(st.hints.rise === 'done' && st.hints.form === 'done', 'hints are remembered across reloads');
});

// The share hint (DESIGN §4 hints, §13): at the first pause once the drawing has 6 strokes, once
// ever (remembered across reloads), never after Share timelapse or Copy remix link.
// The touch wording is a unit test (tests/app.share-hint.test.ts): the flow is the same.
const shareHint = page => R(page, () => {
  const el = document.querySelector('.r-hint[data-hint="share"]');
  return { st: window.__rise.state().hints.share, on: !!el && el.classList.contains('is-on'), text: el ? el.textContent : '' };
});
await scenario('share-hint', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  for (let i = 0; i < 5; i++) await penStroke(cdp, line(60, 160 + i * 70, W - 60, 170 + i * 70, 30));
  await sleep(5000);
  let h = await shareHint(page);
  assert(h.st === 'pending' && !h.on, `no share hint at 5 strokes (${h.st})`);
  await penStroke(cdp, line(60, 560, W - 60, 570, 30));
  await sleep(2000);
  h = await shareHint(page);
  assert(h.st === 'pending', `no share hint right after the 6th stroke (${h.st})`);
  await sleep(3200);
  h = await shareHint(page);
  assert(h.st === 'showing' && h.on, `the share hint shows at the pause after stroke 6 (${h.st})`);
  assert(h.text === 'Share it: ⇧P makes a video of it growing', `share hint text (${h.text})`);
  assert(!(await R(page, () => Object.entries(window.__rise.state().hints).some(([k, v]) => k !== 'share' && v === 'showing'))), 'one hint at a time');
  await shot(page, 'share-hint');
  await sleep(4500);
  h = await shareHint(page);
  assert(h.st === 'done' && !h.on, `the share hint dismisses itself (${h.st})`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  await idle(page, 15000);
  await penStroke(cdp, line(60, 640, W - 60, 650, 30));
  await sleep(5000);
  h = await shareHint(page);
  assert(h.st === 'done' && !h.on, `the share hint never comes back after a reload (${h.st})`);
});

await scenario('share-hint-shared', async ({ page, cdp }) => {
  await penStroke(cdp, line(300, 160, 800, 170, 30));
  await idle(page);
  await dispatch(page, { k: 'copyRemix' });
  await sleep(300);
  for (let i = 1; i < 7; i++) await penStroke(cdp, line(300, 160 + i * 70, 800, 170 + i * 70, 30));
  await sleep(5500);
  const h = await shareHint(page);
  assert(h.st === 'done' && !h.on, `a user who shared never sees the share hint (${h.st})`);
  assert(JSON.parse(await R(page, () => localStorage.getItem('rise:hints')) || '[]').includes('share'), 'sharing is remembered in prefs');
});

// Symmetry (DESIGN §2.3.1): the Form sheet's switch, no extra control at rest, one gesture = six
// strokes that live-draw, undo as one, redo, survive a reload and keep their rainbow hues.
await scenario('symmetry', async ({ page, cdp }) => {
  await dispatch(page, { k: 'ground', g: 'night' });
  await dispatch(page, { k: 'pickInk', ink: 'spectral' });
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await page.click('.r-chip[data-chip="form"]');
  await sleep(300);
  const sw = await page.$('.r-symswitch');
  assert(sw, 'the Form sheet has the symmetry switch');
  const sheetBtns = await R(page, () => document.querySelectorAll('.r-sheet[data-sheet="form"] button:not([hidden])').length);
  assert(sheetBtns === 12, `the Form sheet holds 11 tiles plus one switch (got ${sheetBtns} buttons)`);
  await sw.click();
  await sleep(100);
  let st = await R(page, () => window.__rise.state());
  assert(st.tool.sym.on && st.tool.sym.folds === 6, `the switch turns on 6-fold symmetry (${JSON.stringify(st.tool.sym)})`);
  assert(await R(page, () => document.querySelector('.r-symswitch').getAttribute('aria-checked')) === 'true', 'aria-checked follows');
  await dispatch(page, { k: 'openSheet', sheet: null });
  await idle(page);
  const c0 = await controls(page);
  assert(c0.count === 4, `symmetry adds no control at rest (got ${c0.count}: ${c0.labels})`);
  // the copies draw live, while the pen is still down: probe the 180° copy of the nib's path
  const pts = line(700, 300, 980, 330, 50);
  const rot = ([x, y]) => [W - x, H - y];
  const probeAt = async ([x, y]) => (await R(page, (a, b) => window.__rise.probe(a, b), x, y)).slice(0, 3).reduce((u, v) => u + v, 0);
  const mid = pts[30];
  const bg = await probeAt(rot(mid));
  const ev = (type, [x, y], extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, force: 0.6, pointerType: 'pen', button: 'left', buttons: 1, ...extra });
  await ev('mouseMoved', pts[0], { force: 0, buttons: 0 });
  await ev('mousePressed', pts[0], { clickCount: 1 });
  for (let i = 1; i < pts.length; i++) { await ev('mouseMoved', pts[i]); await sleep(4); }
  // probing with the pen down and still is a hold: a short one rose or not depending on how long
  // the probe took, and a rise adds a peel step to the undo below. Hold long enough that it rises.
  await sleep(1400);
  const liveInk = await probeAt(rot(mid));
  await ev('mouseReleased', pts[pts.length - 1], { buttons: 0, clickCount: 1, force: 0 });
  await idle(page);
  assert(liveInk > bg + 60, `the copies draw while the pen is down (probe ${bg} -> ${liveInk})`);
  assert(await count(page) === 6, `one stroke in 6-fold makes 6 strokes (got ${await count(page)})`);
  const c1 = await controls(page);
  assert(c1.count === 5, `with ink: 5 controls (got ${c1.count}: ${c1.labels})`);
  const doc = await R(page, () => window.__rise.serialize());
  const strokes = doc.trim().split('\n').filter(l => l.startsWith('{"id"')).map(l => JSON.parse(l.replace(/,$/, '')));
  assert(strokes.length === 6, `six recipes serialised (${strokes.length})`);
  assert(strokes.filter(s => s.xf).length === 5, 'five copies carry a placement');
  const hues = new Set(strokes.map(s => Math.round(s.color.dh) % 360));
  assert(hues.size === 6, `Spectral copies take six hues (${[...hues]})`);
  assert(/"version":2/.test(doc), 'the file is format v2');
  await shot(page, 'symmetry-6');
  const h = await R(page, () => window.__rise.sceneHash());
  assert((await last(page)).pools >= 1, 'the hold under the probe rose');
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await count(page) === 6 && (await last(page)).pools === 0, 'the first undo peels the pools, keeping the copies');
  await dispatch(page, { k: 'undo' });
  await idle(page);
  assert(await count(page) === 0, `one undo removes every copy (left ${await count(page)})`);
  await dispatch(page, { k: 'redo' });
  await dispatch(page, { k: 'redo' });
  await idle(page);
  assert(await count(page) === 6 && await R(page, () => window.__rise.sceneHash()) === h, 'redo restores all six');
  await sleep(600); // autosave batch
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
  await idle(page, 15000);
  assert(await count(page) === 6, `reload keeps the copies (${await count(page)})`);
  assert(await R(page, () => window.__rise.sceneHash()) === h, 'reload restores the identical scene hash');
  st = await R(page, () => window.__rise.state());
  assert(st.tool.sym.on && st.tool.sym.folds === 6, 'symmetry survives a reload');
  // M toggles, Shift+M steps the folds; Mirror makes two
  await key(page, 'KeyM');
  st = await R(page, () => window.__rise.state());
  assert(!st.tool.sym.on, 'M turns symmetry off');
  await dispatch(page, { k: 'symmetry', folds: 2 });
  await penStroke(cdp, wave(250, 600, 500, 40, 40));
  await idle(page);
  assert(await count(page) === 8, `Mirror makes two strokes (total ${await count(page)})`);
  await shot(page, 'symmetry-mirror');
});

// Remix links (DESIGN §8): a symmetry drawing becomes a link; a visitor with a drawing of their own
// opens it as a new document that replays once and looks the same as the sender's (a pixel-diff
// bound: v2 links round the input, so the cook is not bit-identical), their own drawing stays in
// Recent, the fragment leaves the address bar, sharing the remix again gives the same link, and a
// truncated link loads nothing.
/** The stage alone (chrome hidden), as RGBA. */
async function stage(page) {
  await page.addStyleTag({ content: '#chrome{display:none!important}' });
  const img = UPNG.decode(await page.screenshot());
  return { w: img.width, h: img.height, d: new Uint8Array(UPNG.toRGBA8(img)[0]) };
}
/** Mean absolute difference per channel (0..255) and the share of pixels off by more than 16 in any channel. */
function pixelDiff(a, b) {
  let sum = 0, over = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a.d[i * 4 + c] - b.d[i * 4 + c]); sum += d; if (d > m) m = d; }
    if (m > 16) over++;
  }
  return { mean: sum / (3 * n), over: over / n };
}
await scenario('remix-link', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickInk', ink: 'spectral' });
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await dispatch(page, { k: 'symmetry', folds: 6 });
  await penStroke(cdp, line(700, 300, 980, 330, 50), { hold: 600 });
  await idle(page, 15000);
  assert(await count(page) === 6, `six strokes to share (${await count(page)})`);
  const link = await R(page, () => window.__rise.remixUrl());
  assert(link && link.startsWith('https://sketch.syberlabs.io/#r='), `a remix link (${link && link.slice(0, 40)})`);
  // the menu item copies it (or says why not) without an error
  await dispatch(page, { k: 'copyRemix' });
  assert(await toastSays(page, /Remix link copied|Couldn’t copy/), 'Copy remix link answers');
  const fragment = link.slice(link.indexOf('#'));
  await dispatch(page, { k: 'symmetry', on: false }); // its guides are not part of the drawing
  await sleep(6500); // the toast leaves
  const sent = await stage(page);

  // the visitor: a fresh browser with a drawing of their own
  const v = await open();
  try {
    await v.page.evaluate(() => window.__rise.dispatch({ k: 'pickForm', form: 'drift' }));
    await penStroke(v.cdp, wave(300, 400, 900, 90, 60));
    await idle(v.page);
    await sleep(700); // autosave batch
    const own = await R(v.page, () => window.__rise.state().currentDocId);
    const ownHash = await R(v.page, () => window.__rise.sceneHash());
    await v.page.goto('about:blank');
    await v.page.goto(URL + fragment, { waitUntil: 'load' });
    await v.page.waitForFunction(() => window.__rise && window.__rise.state().replaying, { polling: 'raf', timeout: 15000 });
    assert(await R(v.page, () => location.hash) === '', 'the fragment leaves the address bar');
    await idle(v.page, 30000);
    let st = await R(v.page, () => window.__rise.state());
    assert(!st.replaying, 'the replay finished');
    assert(await count(v.page) === 6, `the shared drawing opens (${await count(v.page)} strokes)`);
    assert(st.currentDocId !== own, 'it opens as a new document');
    const h = await R(v.page, () => window.__rise.sceneHash());
    assert(h !== ownHash, 'the two drawings differ');
    assert(await R(v.page, () => window.__rise.remixUrl()) === link, 'sharing the remix again gives the same link');
    await sleep(700);
    await dispatch(v.page, { k: 'openSheet', sheet: 'menu' });
    await sleep(900);
    st = await R(v.page, () => window.__rise.state());
    assert(st.recentDocs.some(d => d.id === own && d.strokes === 1), `the visitor's own drawing is still in Recent (${st.recentDocs.map(d => d.id + ':' + d.strokes)})`);
    await dispatch(v.page, { k: 'openSheet', sheet: null });
    await sleep(6500); // the toast and the sheet leave
    const got = await stage(v.page);
    await shot(v.page, 'remix-opened');
    const diff = pixelDiff(sent, got);
    console.log(`    remix vs sender: mean ${diff.mean.toFixed(3)}/255, ${(100 * diff.over).toFixed(3)} % of pixels off by > 16`);
    // runs measure 0.08–0.59 % of pixels off by > 16 (sub-pixel edge shifts, invisible side by side); 1 % keeps
    // headroom without letting a real change through (a re-grown stroke moves several %)
    assert(diff.mean < 0.5 && diff.over < 0.01, `the remix looks like the sender's drawing (mean ${diff.mean.toFixed(3)}, ${(100 * diff.over).toFixed(3)} % > 16)`);
    // a truncated link (pasted into the open app) loads nothing and says so
    await R(v.page, f => { location.hash = f; }, fragment.slice(0, fragment.length >> 1));
    assert(await toastSays(v.page, /damaged or incomplete/), 'a bad link says so');
    assert(await R(v.page, () => window.__rise.sceneHash()) === h, 'a bad link changes nothing');
    const errs = v.errors.filter(e => !/favicon/.test(e));
    assert(errs.length === 0, 'visitor console/page errors:\n  ' + errs.join('\n  '));
  } finally {
    await v.browser.close();
  }
});

// A remix link opened on a phone (DESIGN §8 Replay, §13): the drawing is wider than the phone, so
// Replay fits it first. That glide used to count as the visitor navigating, which stopped the
// replay before its first frame and left every stroke held out of the tiles: a blank canvas, for
// good. Now the fit glides, the drawing grows, stays on screen, and the visitor is told to draw on it.
const inkCover = page => R(page, () => {
  const el = document.querySelector('#base');
  const c = document.createElement('canvas');
  c.width = el.width; c.height = el.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(el, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
  return lit / (c.width * c.height);
});
await scenario('remix-phone', async ({ page, cdp }) => {
  await dispatch(page, { k: 'pickInk', ink: 'spectral' });
  await dispatch(page, { k: 'pickForm', form: 'sprout' });
  await dispatch(page, { k: 'symmetry', folds: 6 });
  await penStroke(cdp, line(700, 180, 1150, 330, 50), { hold: 600 });
  await idle(page, 15000);
  const link = await R(page, () => window.__rise.remixUrl());
  const fragment = link.slice(link.indexOf('#'));
  // the visitor: a phone that has never opened Rise
  const v = await open({ width: 390, height: 844, touch: true, firstRun: true });
  try {
    await v.page.goto('about:blank');
    await v.page.goto(URL + fragment, { waitUntil: 'load' });
    await v.page.waitForFunction(() => window.__rise && window.__rise.state().replaying, { polling: 'raf', timeout: 15000 });
    await sleep(600);
    assert(await R(v.page, () => window.__rise.state().replaying), 'the replay survives its own fit glide');
    await idle(v.page, 30000);
    assert(!(await R(v.page, () => window.__rise.state().replaying)), 'the replay finished');
    assert(await count(v.page) === 6, `the shared drawing opens (${await count(v.page)} strokes)`);
    const cover = await inkCover(v.page);
    assert(cover > 0.02, `the drawing is on screen after the replay (ink on ${(cover * 100).toFixed(1)} % of the canvas)`);
    // then the first-run hint, worded for a drawing that is already there, as a legible pill
    const hint = () => R(v.page, () => {
      const el = document.querySelector('.r-hint[data-hint="draw"]');
      return { on: !!el && el.classList.contains('is-on'), bare: !!el && el.classList.contains('is-bare'), text: el ? el.textContent : '', st: window.__rise.state().hints.draw };
    });
    let h = await hint();
    assert(h.on && !h.bare && h.text === 'Draw on it. It grows.', `after the replay: "Draw on it. It grows." (${JSON.stringify(h)})`);
    await shot(v.page, 'remix-phone');
    // a contact on the canvas, clear of the chrome: the "Opened a shared drawing" toast is still up
    // above the dock, and on Linux it wraps to two lines and reaches y ≈ 700 (a tap there hits it)
    const onStage = await R(v.page, () => !!document.elementFromPoint(200, 560)?.closest('#stage'));
    assert(onStage, 'the tap point is on the canvas');
    await tap(v.cdp, 200, 560);
    await idle(v.page);
    h = await hint();
    assert(!h.on && h.st === 'done', `the first contact retires it (${JSON.stringify(h)})`);
    const errs = v.errors.filter(e => !/favicon/.test(e));
    assert(errs.length === 0, 'visitor console/page errors:\n  ' + errs.join('\n  '));
  } finally {
    await v.browser.close();
  }
});

// Usage counters (DESIGN §8 Privacy): over http the app POSTs bare event names to /e, and no request
// carries a fragment, the drawing, a cookie or anything but an allow-listed name. Drawing and remix
// links work as before. Served here because counters send nothing from file://.
if (wants('counters') && !URL_ARG) {
  const t0 = Date.now();
  let env, server;
  try {
    const hits = [];
    const html = readFileSync(resolve('dist-debug/index.html'));
    server = createServer((req, res) => {
      if (req.url.startsWith('/e')) {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => { hits.push({ method: req.method, url: req.url, body, cookie: req.headers.cookie, referer: req.headers.referer }); res.writeHead(204).end(); });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}/?debug`;
    env = await launch({ width: W, height: H, url: base });
    const { page, cdp } = env;
    await page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
    await page.evaluate(() => { localStorage.setItem('rise:firstRunDone', 'true'); });
    await idle(page);
    await penStroke(cdp, wave(300, 400, 900, 90, 60));
    await idle(page);
    assert(await count(page) === 1, 'drawing works over http');
    await dispatch(page, { k: 'copyRemix' });
    await toastSays(page, /Remix link copied|Couldn’t copy/);
    const link = await R(page, () => window.__rise.remixUrl());
    await page.goto('about:blank');
    await page.goto(base + link.slice(link.indexOf('#')), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__rise && window.__rise.state().replaying, { polling: 'raf', timeout: 15000 });
    await idle(page, 30000);
    assert(await count(page) === 1, 'the remix opens over http');
    await sleep(500);
    const names = hits.map(h => h.body);
    for (const e of ['visit', 'stroke_first', 'form_sprout', 'visit_remix']) assert(names.includes(e), `${e} was counted (${names})`);
    assert(names.filter(n => n === 'visit').length === 2, `one visit per page load (${names})`);
    for (const h of hits) {
      assert(h.method === 'POST' && h.url === '/e', `only POST /e (${h.method} ${h.url})`);
      assert(/^[a-z_]{1,32}$/.test(h.body), `a bare event name (${h.body.slice(0, 40)})`);
      assert(!h.cookie, 'no cookie');
      assert(!h.referer || !h.referer.includes('#'), 'no fragment in the referer');
    }
    const errs = env.errors.filter(e => !/favicon/.test(e));
    assert(errs.length === 0, 'console/page errors:\n  ' + errs.join('\n  '));
    results.push({ name: 'counters', ok: true, ms: Date.now() - t0 });
    console.log(`  PASS counters (${Date.now() - t0} ms): ${names.join(' ')}`);
  } catch (e) {
    results.push({ name: 'counters', ok: false, ms: Date.now() - t0, err: String(e && e.stack || e) });
    console.log(`  FAIL counters: ${e && e.message}`);
  } finally {
    if (env) await env.browser.close();
    server?.close();
  }
}

// ---------------------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed` + (failed.length ? `; failed: ${failed.map(f => f.name).join(', ')}` : ''));
for (const f of failed) console.log(`\n--- ${f.name}\n${f.err}`);
process.exit(failed.length ? 1 : 0);
