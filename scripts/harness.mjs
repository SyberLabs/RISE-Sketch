// Reusable headless-Chrome harness for Rise e2e checks.
// Drives the system Chrome via puppeteer-core and synthesizes pen / mouse / touch
// input through CDP so pressure, tilt and multi-touch reach the app as real
// PointerEvents.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ width = 1280, height = 820, dpr = 1, url, touch = false } = {}) {
  const executablePath = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', `--force-device-scale-factor=${dpr}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr, hasTouch: touch, isMobile: false });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + (e?.stack || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const target = url || pathToFileURL(resolve('dist-single/index.html')).href;
  await page.goto(target, { waitUntil: 'load' });
  const cdp = await page.createCDPSession();
  return { browser, page, cdp, errors };
}

/** points: [[x, y, pressure?, tiltX?, tiltY?], ...] in CSS px */
export async function penStroke(cdp, points, { delay = 0, hold = 0, pointerType = 'pen' } = {}) {
  const P = i => {
    const [x, y, p = 0.5, tx = 0, ty = 0] = points[i];
    return { x, y, force: p, tiltX: tx, tiltY: ty, pointerType };
  };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...P(0), force: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...P(0), button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i < points.length; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...P(i), button: 'left', buttons: 1 });
    if (delay) await sleep(delay);
  }
  if (hold) {
    // keep the pen still and pressed, emitting tiny keep-alive moves like a real pen does
    const end = Date.now() + hold;
    const last = P(points.length - 1);
    while (Date.now() < end) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last, button: 'left', buttons: 1 });
      await sleep(16);
    }
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...P(points.length - 1), button: 'left', buttons: 0, clickCount: 1, force: 0 });
}

export const mouseStroke = (cdp, points, opts = {}) => penStroke(cdp, points.map(([x, y]) => [x, y, 0.5]), { ...opts, pointerType: 'mouse' });

/** Two-finger pinch/pan. from/to: [[x1,y1],[x2,y2]] */
export async function pinch(cdp, from, to, steps = 12) {
  const tp = (pts) => pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(from) });
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cur = from.map(([x, y], i) => [x + (to[i][0] - x) * t, y + (to[i][1] - y) * t]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(cur) });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

export async function tap(cdp, x, y, fingers = 1) {
  const pts = Array.from({ length: fingers }, (_, i) => ({ x: x + i * 30, y, id: i, radiusX: 4, radiusY: 4, force: 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts });
  await sleep(40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

export async function wheel(cdp, x, y, deltaY, { ctrl = false } = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0 });
}

export async function key(page, k, mods = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(k);
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
}

/** Generators for test strokes */
export function wave(x0, y0, x1, amp = 120, n = 90, cycles = 1) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([x0 + (x1 - x0) * t, y0 + Math.sin(t * Math.PI * 2 * cycles) * amp, 0.25 + 0.7 * Math.sin(t * Math.PI), 15, 5]);
  }
  return pts;
}
export function circle(cx, cy, r, n = 80, closeOver = 1.04) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * closeOver - Math.PI / 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0.4 + 0.4 * Math.sin((i / n) * Math.PI)]);
  }
  return pts;
}
export function line(x0, y0, x1, y1, n = 40) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n; pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.3 + 0.5 * Math.sin(t * Math.PI)]); }
  return pts;
}

/** Measure rAF frame times for `ms` while `work` runs concurrently. */
export async function measureFrames(page, ms, work) {
  await page.evaluate((ms) => {
    window.__frames = [];
    let last = performance.now();
    const end = last + ms;
    const tick = (t) => { window.__frames.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, ms);
  if (work) await work();
  await sleep(ms + 50);
  return page.evaluate(() => {
    const f = window.__frames.slice(1).sort((a, b) => a - b);
    const q = p => f[Math.min(f.length - 1, Math.floor(p * f.length))] || 0;
    return { n: f.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +(f[f.length - 1] || 0).toFixed(1) };
  });
}
