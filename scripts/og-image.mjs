#!/usr/bin/env node
// NOTE: public/og.png and the icons now carry the RISE crystal mark; running this overwrites them.
// Renders the link-preview image and the app icons with the real engine:
//   public/og.png (1200×630), public/icons/icon-{192,512}.png, icon-maskable-512.png,
//   public/apple-touch-icon.png.
// A 12-fold Spectral mandala (Sprout, Caustic, Orbit, Ripple on Night), drawn through the
// `?debug` build with real pen input, then framed in a square viewport for the icons. Strokes grow
// with fresh seeds each run, so every run draws a sibling of the committed image.
//
//   node scripts/og-image.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import UPNG from 'upng-js';
import { launch, penStroke, sleep } from './harness.mjs';

if (!process.argv.includes('--no-build')) {
  const r = spawnSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', 'debug', '--logLevel', 'warn'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
const URL = pathToFileURL(resolve('dist-debug/index.html')).href + '?debug';
const W = 1200, H = 630, DPR = 2;

const { browser, page, cdp, errors } = await launch({ width: W, height: H, dpr: DPR, url: URL });
const ready = () => page.waitForFunction(() => window.__rise && window.__rise.version, { timeout: 15000 });
const idle = () => page.evaluate(() => window.__rise.idle(20000));
const dispatch = intent => page.evaluate(i => window.__rise.dispatch(i), intent);

await ready();
await page.evaluate(() => window.__rise.wipe());
await page.evaluate(() => { localStorage.setItem('rise:firstRunDone', 'true'); });
await page.reload({ waitUntil: 'load' });
await ready();
await idle();
await dispatch({ k: 'ground', g: 'night' });
await dispatch({ k: 'pickInk', ink: 'spectral' });
await dispatch({ k: 'symmetry', folds: 12 });

// Polar strokes about the view centre (the symmetry centre). r in px, a in radians.
const cx = W / 2, cy = H / 2;
const S = 0.92; // overall radius scale
const polar = (pts) => pts.map(([r, a, p = 0.6]) => [cx + Math.cos(a) * r * S, cy + Math.sin(a) * r * S, p, 10, 4]);
const ray = (r0, r1, a0, sweep, wobble, n = 50) => polar(Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n;
  return [r0 + (r1 - r0) * t, a0 + sweep * t + Math.sin(t * Math.PI * 2) * wobble, 0.3 + 0.6 * Math.sin(t * Math.PI)];
}));
const arc = (r, a0, a1, n = 30) => polar(Array.from({ length: n + 1 }, (_, i) => [r, a0 + (a1 - a0) * i / n, 0.5]));

async function stroke(form, pts, opts = {}) {
  await dispatch({ k: 'pickForm', form });
  await penStroke(cdp, pts, { delay: 4, ...opts });
  await idle();
}

const A = -Math.PI / 2, F = Math.PI / 6; // one fold
const dot = (r, a) => polar([[r, a, 0.6], [r + 0.5, a, 0.7], [r + 1, a, 0.7]]);
await dispatch({ k: 'pickNib', nib: 'pen' });
await stroke('sprout', ray(55, 235, A, 0.5, 0.05));
await stroke('sprout', ray(60, 165, A + F * 0.5, -0.45, 0.04));
await stroke('caustic', arc(150, A, A + F));
await stroke('orbit', arc(268, A + F * 0.15, A + F * 0.85, 20));
await stroke('ripple', dot(34, A + F * 0.5), { hold: 400 });
await stroke('ripple', dot(205, A + F * 0.5), { hold: 500 });
await dispatch({ k: 'symmetry', on: false });
await idle();

// Hide the UI and set the wordmark.
await page.addStyleTag({ content: `
  #chrome { display: none !important; }
  .og-mark { position: fixed; left: 44px; bottom: 34px; font: 500 22px/1.2 -apple-system, "Helvetica Neue", sans-serif;
    letter-spacing: .02em; color: rgba(236, 232, 255, .92); }
  .og-mark span { color: rgba(236, 232, 255, .55); font-weight: 400; }` });
await page.evaluate(() => {
  const d = document.createElement('div');
  d.className = 'og-mark';
  d.innerHTML = 'RISE Sketch <span>· your stroke is the seed</span>';
  document.body.append(d);
});
await sleep(300);

/**
 * Screenshot, downsampled in the page to w×h (crop: fraction of the shot to keep, centred), as a
 * 256-colour PNG: the ground's grain makes a full-colour one ~1 MB.
 */
async function capture(w, h, crop = 1) {
  const shot = Buffer.from(await page.screenshot({ type: 'png' })).toString('base64');
  const rgba = await page.evaluate(async (src, w, h, crop) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + src;
    await img.decode();
    const sw = img.width * crop, sh = img.height * crop;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
    return Array.from(g.getImageData(0, 0, w, h).data);
  }, shot, w, h, crop);
  return Buffer.from(UPNG.encode([new Uint8Array(rgba).buffer], w, h, 256));
}

const out = (p, buf) => { writeFileSync(resolve('public', p), buf); console.log(`  ${p} ${(buf.length / 1024).toFixed(0)} kB`); };
mkdirSync(resolve('public/icons'), { recursive: true });
out('og.png', await capture(W, H));

// Icons: the same drawing, unscaled, in a square viewport, without the wordmark. The mandala
// (~560 px across) fills ~78 % of the maskable icon (inside its 80 % safe circle); the plain
// icons crop in closer.
await page.evaluate(() => document.querySelector('.og-mark').remove());
await page.setViewport({ width: 720, height: 720, deviceScaleFactor: DPR });
await idle();
await sleep(300);
out('icons/icon-maskable-512.png', await capture(512, 512));
out('icons/icon-512.png', await capture(512, 512, 0.82));
out('icons/icon-192.png', await capture(192, 192, 0.82));
out('apple-touch-icon.png', await capture(180, 180, 0.86));

await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
