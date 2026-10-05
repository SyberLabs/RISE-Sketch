// Usage: with a vite dev server running, `PORT=5187 node sandbox/scene-sched/shot.mjs occupancy out.png`.
// Loads sandbox/scene-sched/<page>.html, waits for window.__result, screenshots, prints the result.
import { launch, sleep } from '../../scripts/harness.mjs';

const [pageName = 'occupancy', out = `${pageName}.png`] = process.argv.slice(2);
const port = process.env.PORT ?? 5187;
const { browser, page, errors } = await launch({ width: 1140, height: 720, url: `http://localhost:${port}/sandbox/scene-sched/${pageName}.html` });
let result = null;
for (let i = 0; i < 150 && !result; i++) {
  await sleep(100);
  try { result = await page.evaluate(() => window.__result ?? null); } catch { /* reloaded */ }
}
await page.screenshot({ path: out });
await browser.close();
console.log(JSON.stringify({ result, errors }, null, 2));
process.exit(result && errors.length === 0 ? 0 : 1);
