// Allocation + handler-time probe for the input layer (DESIGN §9: ≤ 0.3 ms per event,
// no allocation in app code). Runs the sandbox with a no-op sink, warms up, then
// samples the heap during long pen / mouse / touch gestures and reports the bytes
// whose allocating frame is in src/input/.
//   node sandbox/input/alloc.mjs   (dev server on 5185, see drive.mjs)
import { launch, penStroke, sleep } from '../../scripts/harness.mjs';

const URL = (process.env.URL || 'http://localhost:5185/sandbox/input/index.html') + '?quiet';
const { browser, page, cdp } = await launch({ url: URL, touch: true, width: 1200, height: 800 });
await page.waitForFunction(() => !!window.__input);

const zigzag = (n, y0) => {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([100 + (i % 200) * 5, y0 + 60 * Math.sin(i / 9), 0.3 + 0.6 * Math.abs(Math.sin(i / 23)), 20, 10]);
  return pts;
};
const touchDrag = async (n) => {
  const tp = (x, y) => [{ x, y, id: 0, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(100, 600) });
  for (let i = 1; i <= n; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(100 + (i % 200) * 5, 600 + 40 * Math.sin(i / 7)) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

// Warm-up: let TurboFan optimise the handlers (interpreted code boxes doubles).
await page.evaluate(() => localStorage.clear());
await touchDrag(1500);
await penStroke(cdp, zigzag(1500, 300));
await penStroke(cdp, zigzag(1500, 300), { pointerType: 'mouse' });
await sleep(200);
await page.evaluate(() => { window.__perf.handlerMs.length = 0; });

await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128 });
await penStroke(cdp, zigzag(3000, 300));
await penStroke(cdp, zigzag(2000, 400), { pointerType: 'mouse' });
await sleep(400);
const { profile } = await cdp.send('HeapProfiler.stopSampling');

const perFile = new Map();
let total = 0;
const walk = (node, inInput) => {
  const url = node.callFrame.url || '';
  const isInput = /\/src\/input\//.test(url);
  if (isInput && node.selfSize) {
    const key = `${url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${node.callFrame.functionName || '(anon)'}:${node.callFrame.lineNumber + 1}`;
    perFile.set(key, (perFile.get(key) || 0) + node.selfSize);
    total += node.selfSize;
  }
  for (const c of node.children || []) walk(c, inInput || isInput);
};
walk(profile.head, false);

const perf = await page.evaluate(() => {
  const h = window.__perf.handlerMs.slice().sort((a, b) => a - b);
  const q = (p) => h[Math.min(h.length - 1, Math.floor(p * h.length))] || 0;
  return { events: h.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: h[h.length - 1] || 0, counts: window.__perf.counts };
});
console.log('pointermove handler (ms):', JSON.stringify({ ...perf, p50: +perf.p50.toFixed(3), p95: +perf.p95.toFixed(3), p99: +perf.p99.toFixed(3), max: +perf.max.toFixed(3) }));
console.log(`sampled bytes allocated in src/input during ~5000 events: ${total}`);
for (const [k, v] of [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v}\t${k}`);
await browser.close();
