#!/usr/bin/env node
// Rise end-to-end suite (DESIGN §7.6). Runs against the single-file build via file:// with
// ?debug, driving real pen / mouse / touch input through CDP and asserting through
// window.__rise (src/app/types.ts RiseDebug).
//
//   npm run build:single && node scripts/e2e.mjs [--only name,name] [--keep] [--out dir] [--url URL]
//
// Screenshots land in e2e-out/ for visual review. Exit code 1 on any failure.
//
// Persistence: headless Chrome gives file:// pages a working IndexedDB, so reload-persist runs
// against the single-file build directly. Where a browser refuses IndexedDB on file:// (the app
// then shows the not-autosaving dot and toast, DESIGN §8), run the suite over http instead:
//   npx vite preview --outDir dist-single --port 5191 --strictPort   (in the background), then
//   node scripts/e2e.mjs --url http://localhost:5191/
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, penStroke, mouseStroke, pinch, tap, wheel, key, wave, circle, line, sleep, measureFrames } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const OUT = resolve(arg('--out', 'e2e-out'));
const URL = (arg('--url', '') || pathToFileURL(resolve('dist-single/index.html')).href) + '?debug';
mkdirSync(OUT, { recursive: true });

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
    results.push({ name, ok: false, ms: Date.now() - t0, err: String(e && e.stack || e) });
    console.log(`  FAIL ${name}: ${e && e.message}`);
    if (env) { try { await shot(env.page, `FAIL-${name}`); } catch {} }
  } finally {
    if (env) await env.browser.close();
  }
}

// ---------------------------------------------------------------------------------------------
console.log(`Rise e2e → ${URL}`);

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
  assert(json.format === 'rise' && json.version === 1, '.rise header');
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

// ---------------------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed` + (failed.length ? `; failed: ${failed.map(f => f.name).join(', ')}` : ''));
for (const f of failed) console.log(`\n--- ${f.name}\n${f.err}`);
process.exit(failed.length ? 1 : 0);
