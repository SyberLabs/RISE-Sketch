// Usage: start `npx vite --port 5187 --strictPort`, then `node sandbox/scene-sched/check.mjs` (PORT=… to override).
import { launch, sleep } from '../../scripts/harness.mjs';

const { browser, page, errors } = await launch({ url: `http://localhost:${process.env.PORT ?? 5187}/sandbox/scene-sched/frame.html` });
let result = null;
// the dev server may full-reload the page while other files change: tolerate navigations
for (let i = 0; i < 150 && !result; i++) {
  await sleep(100);
  try { result = await page.evaluate(() => window.__result ?? null); } catch { /* reloaded */ }
}
await page.screenshot({ path: process.env.SHOT ?? 'frame-check.png' });
await browser.close();
console.log(JSON.stringify({ result, errors }, null, 2));
const ok = result && result.done === 300 && result.idleRafCalls === 0 && !result.runningAfterIdle &&
  result.frameInterval > 5 && result.frameInterval < 40 && result.jobOverrunMs < 2 && errors.length === 0;
process.exit(ok ? 0 : 1);
