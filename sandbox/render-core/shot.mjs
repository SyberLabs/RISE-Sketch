// Screenshot the render-core sandbox views.
// usage: node sandbox/render-core/shot.mjs <outDir> [view[:WxH[@dpr]] ...]
// (needs `npx vite --port <PORT> --strictPort` running; PORT env var, default 5182)
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || '.';
const specs = process.argv.slice(3).length ? process.argv.slice(3) : ['main:1600x1040@1', 'zoom:1500x1000@1', 'zoom2:1600x900@1', 'zoom3:1600x900@1', 'lod:1600x900@1', 'reveal:1600x900@1', 'export:1600x1040@1', 'main:800x520@2'];
mkdirSync(out, { recursive: true });

for (const spec of specs) {
  const m = /^(\w+)(?::(\d+)x(\d+))?(?:@(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) throw new Error('bad spec ' + spec);
  const [, view, w = '1600', h = '1000', dpr = '1'] = m;
  const { browser, page, errors } = await launch({ width: +w, height: +h, dpr: +dpr, url: `http://localhost:${process.env.PORT || 5182}/sandbox/render-core/index.html?view=${view}` });
  try {
    await page.waitForFunction(() => (window.__drawn ?? 0) > 0, { timeout: 20000 });
    await sleep(400);
    const file = join(out, `render-core-${view}${dpr !== '1' ? '@' + dpr : ''}.png`);
    await page.screenshot({ path: file });
    const labels = await page.$$eval('.label', els => els.map(e => e.textContent));
    console.log(file, labels.join(' | '));
    if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  } finally {
    await browser.close();
  }
}
