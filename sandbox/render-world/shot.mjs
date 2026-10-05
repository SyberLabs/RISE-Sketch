// render-world sandbox driver: screenshots + scripted scenarios with pixel/timing checks.
// usage: node sandbox/render-world/shot.mjs <outDir> [scenario ...]
// (needs `npx vite --config sandbox/render-world/vite.config.mjs --port 5183 --strictPort`)
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || '.';
const only = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const BASE = `http://localhost:${process.env.RW_PORT || 5183}/sandbox/render-world/index.html`;
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

async function open(q, { width = 1280, height = 800, dpr = 1 } = {}) {
  const r = await launch({ width, height, dpr, url: `${BASE}?${q}` });
  await r.page.waitForFunction(() => (window.__drawn ?? 0) > 0, { timeout: 30000 });
  return r;
}
const shot = (page, name) => page.screenshot({ path: join(out, `rw-${name}.png`) });
const idle = page => page.evaluate(() => window.__rw.idle(15000));

const scenarios = {
  async grounds() {
    for (const g of ['night', 'paper']) {
      const { browser, page, errors } = await open(`ground=${g}&n=40`);
      await idle(page);
      await shot(page, `main-${g}`);
      const st = await page.evaluate(() => window.__rw.stats());
      check(st.pendingTiles === 0, `${g}: tiles settled (${st.tiles} tiles, ${(st.canvasBytes / 1048576).toFixed(1)} MB)`);
      check(errors.length === 0, `${g}: no page errors ${errors.join(' | ')}`);
      await browser.close();
    }
  },

  async dpr2() {
    const { browser, page, errors } = await open('n=30', { width: 900, height: 600, dpr: 2 });
    await idle(page);
    await shot(page, 'main-dpr2');
    check(errors.length === 0, 'dpr2: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async gesture() {
    const { browser, page, errors } = await open('n=60');
    await idle(page);
    // a pan + zoom gesture: only cached tiles composite; stale tiles stay visible
    await page.evaluate(() => window.__rw.frameStats());
    for (let i = 0; i < 20; i++) {
      await page.evaluate(i => { window.__rw.pan(-9, -4); window.__rw.zoom(1.035); }, i);
      await sleep(16);
    }
    const g = await page.evaluate(() => window.__rw.frameStats());
    await shot(page, 'gesture-mid');
    check(g.p95 < 8, `gesture frames p95 ${g.p95} ms (max ${g.max}) < 8`);
    await page.evaluate(() => window.__rw.camera({}, 'settled'));
    await idle(page);
    await shot(page, 'gesture-settled');
    // zoom far out and back in
    await page.evaluate(() => window.__rw.camera({ scale: 0.12 }, 'settled'));
    await idle(page);
    await shot(page, 'zoom-out');
    await page.evaluate(() => window.__rw.camera({ scale: 6, cx: 700, cy: 450 }, 'settled'));
    await idle(page);
    await shot(page, 'zoom-in');
    check(errors.length === 0, 'gesture: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async edits() {
    const { browser, page, errors } = await open('n=36');
    await idle(page);
    await shot(page, 'edits-0');
    const ids = await page.evaluate(() => window.__rw.ids());
    // removal with un-grow: tiles first, then the un-grow (mid frame screenshot)
    await page.evaluate(ids => window.__rw.remove(ids.slice(0, 6), 'ungrow'), ids);
    await sleep(90);
    await shot(page, 'edits-ungrow-mid');
    await idle(page);
    await shot(page, 'edits-1-removed');
    // grow-in additions (redo-like)
    await page.evaluate(() => window.__rw.seed(5, 'grow', { x0: 300, y0: 200, w: 700, h: 400 }));
    await sleep(200);
    await shot(page, 'edits-grow-mid');
    await idle(page);
    await shot(page, 'edits-2-grown');
    // restyle morph (colour) and regrow (geometry)
    await page.evaluate(ids => { window.__rw.restyle(ids.slice(10, 14), 'rose'); window.__rw.regrow(ids.slice(14, 16), 'drift'); }, ids);
    await idle(page);
    await shot(page, 'edits-3-restyled');
    // a live commit: two-phase bake
    await page.evaluate(() => window.__rw.commitLive({ form: 'sprout', nib: 'brush', ink: 'ochre', base: 2 }, Array.from({ length: 80 }, (_, i) => [300 + i * 6, 650 + Math.sin(i / 8) * 30, 0.4 + 0.4 * Math.sin(i / 25)])));
    await idle(page);
    await shot(page, 'edits-4-baked');
    check(errors.length === 0, 'edits: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async groundflip() {
    const { browser, page, errors } = await open('n=40');
    await idle(page);
    await page.evaluate(() => window.__rw.ground('paper', true));
    await sleep(160);
    await shot(page, 'flip-mid');
    await idle(page);
    await sleep(500);
    await shot(page, 'flip-paper');
    await page.evaluate(() => window.__rw.ground('night', false));
    await idle(page);
    await sleep(500);
    await shot(page, 'flip-night');
    check(errors.length === 0, 'groundflip: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async lift() {
    const { browser, page, errors } = await open('n=40');
    await idle(page);
    const ids = await page.evaluate(() => window.__rw.ids());
    await page.evaluate(ids => window.__rw.lift(ids.slice(5, 9)), ids);
    await idle(page);
    await sleep(250);
    await shot(page, 'lift');
    await page.evaluate(ids => window.__rw.restyle(ids.slice(5, 7), 'spectral'), ids);
    await idle(page);
    await page.evaluate(() => window.__rw.drop());
    await idle(page);
    await sleep(250);
    await shot(page, 'drop');
    check(errors.length === 0, 'lift: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async snapshot() {
    const { browser, page, errors } = await open('n=40');
    await idle(page);
    const r = await page.evaluate(() => window.__rw.snapshotRoundTrip());
    check(r.bytes > 1000, `snapshot encoded ${r.bytes} bytes (${r.type})`);
    await sleep(30);
    await shot(page, 'snapshot-shown');
    await idle(page);
    await shot(page, 'snapshot-replaced');
    check(errors.length === 0, 'snapshot: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async handoff() {
    for (const g of ['night', 'paper']) {
      const { browser, page, errors } = await open(`view=empty&ground=${g}`);
      const res = await page.evaluate(async () => {
        const out = [];
        const specs = [
          { form: 'line', nib: 'brush', ink: 'moss', base: 0 },
          { form: 'sprout', nib: 'pen', ink: 'indigo', base: 2 },
          { form: 'drift', nib: 'chisel', ink: 'oxide', base: 2 },
          { form: 'echo', nib: 'brush', ink: 'spectral', base: 2 },
        ];
        let x = 200;
        for (const s of specs) {
          const path = Array.from({ length: 70 }, (_, i) => [x + i * 3, 300 + Math.sin(i / 9) * 60, 0.3 + 0.5 * Math.sin(i / 22)]);
          out.push(await window.__rw.handoff(s, path));
          window.__rw.remove(window.__rw.ids(), 'none');
          await window.__rw.idle();
          x += 20;
        }
        return out;
      });
      for (const r of res) check(r.over2 / Math.max(1, r.nonzero) <= 0.005, `${g} hand-off: ${r.over2} of ${r.nonzero} inked px differ by > 2 (max ${r.maxDiff})`);
      check(errors.length === 0, `handoff ${g}: no page errors ` + errors.join(' | '));
      await browser.close();
    }
  },

  async fallback() {
    const { browser, page, errors } = await open('n=40&noplus=1');
    await idle(page);
    const blit = await page.evaluate(() => getComputedStyle(document.getElementById('base')).mixBlendMode);
    check(blit === 'normal', 'fallback: #base is opaque and normal-blended (' + blit + ')');
    await page.evaluate(() => window.__rw.seed(4, 'grow', { x0: 300, y0: 200, w: 600, h: 400 }));
    await idle(page);
    await shot(page, 'fallback-night');
    check(errors.length === 0, 'fallback: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async purge() {
    const { browser, page, errors } = await open('n=40');
    await idle(page);
    const before = await page.evaluate(() => window.__rw.stats());
    await page.evaluate(() => window.__rw.renderer.purge());
    const mid = await page.evaluate(() => window.__rw.stats());
    check(mid.tiles === 0 && mid.canvasBytes < before.canvasBytes, `purge freed tiles (${before.tiles} -> ${mid.tiles}, ${(before.canvasBytes / 1048576).toFixed(1)} -> ${(mid.canvasBytes / 1048576).toFixed(1)} MB)`);
    await sleep(2300);
    await idle(page);
    const after = await page.evaluate(() => window.__rw.stats());
    check(after.tiles > 0, `tiles came back after the purge rest (${after.tiles})`);
    await shot(page, 'purge-restored');
    check(errors.length === 0, 'purge: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async stress() {
    const { browser, page, errors } = await open('n=300');
    const t0 = Date.now();
    await idle(page);
    console.log('  .. 300 strokes cooked and tiled in ' + (Date.now() - t0) + ' ms (headless, software raster)');
    await page.evaluate(() => window.__rw.frameStats());
    for (let i = 0; i < 20; i++) {
      await page.evaluate(i => { window.__rw.pan(i % 2 ? 23 : -17, 9); window.__rw.zoom(i < 10 ? 1.06 : 0.94); }, i);
      await sleep(16);
    }
    const g = await page.evaluate(() => window.__rw.frameStats());
    check(g.p95 < 3, `300 strokes: gesture frame CPU p95 ${g.p95} ms (max ${g.max}) < 3`);
    const t1 = Date.now();
    await page.evaluate(() => window.__rw.camera({}, 'settled'));
    await idle(page);
    const s = await page.evaluate(() => window.__rw.frameStats());
    console.log(`  .. settle -> complete ${Date.now() - t1} ms; frame CPU p50 ${s.p50} p95 ${s.p95} max ${s.max} ms over ${s.n} frames`);
    check(s.p95 < 12, `settle frames p95 ${s.p95} ms < 12 (one stroke per step; budget ≤ 6 ms)`);
    await shot(page, 'stress');
    const ids = await page.evaluate(() => window.__rw.ids());
    await page.evaluate(() => window.__rw.frameStats());
    const er = await page.evaluate(async ids => {
      const t0 = performance.now();
      window.__rw.remove(ids.slice(0, 20), 'fade');
      let tiles = 0;
      await new Promise(res => { const f = () => { if (window.__rw.renderer.debug().txns === 0) { tiles = performance.now() - t0; res(); } else requestAnimationFrame(f); }; requestAnimationFrame(f); });
      await window.__rw.idle(60000);
      return { tiles, total: performance.now() - t0, fs: window.__rw.frameStats() };
    }, ids);
    const cpu = er.fs.n * er.fs.p50;
    console.log(`  .. erase 20 strokes: tiles swapped after ${er.tiles.toFixed(0)} ms wall over ${er.fs.n} frames (CPU/frame p50 ${er.fs.p50}, max ${er.fs.max} ms; ≈${cpu.toFixed(0)} ms CPU)`);
    check(er.fs.max < 16, `erase frames stay under a 60 Hz frame (max ${er.fs.max} ms)`);
    check(errors.length === 0, 'stress: no page errors ' + errors.join(' | '));
    await browser.close();
  },

  async glyphs() {
    for (const dpr of [1, 2]) {
      const { browser, page, errors } = await open('view=glyphs', { width: 1400, height: 820, dpr });
      await sleep(200);
      await shot(page, `glyphs@${dpr}`);
      check(errors.length === 0, 'glyphs: no page errors ' + errors.join(' | '));
      await browser.close();
    }
  },
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  console.log('== ' + name);
  try { await fn(); } catch (e) { fails++; console.log('  FAIL threw: ' + (e?.stack || e)); }
}
console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
