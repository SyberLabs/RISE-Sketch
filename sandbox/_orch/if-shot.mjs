// Screenshot the ink-forms sandbox views.
// usage: node sandbox/ink-forms/shot.mjs <outDir> [view[:WxH[@dpr]] ...]
// (needs `npx vite --port 5181 --strictPort` running)
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || '.';
const specs = process.argv.slice(3).length ? process.argv.slice(3) : ['forms:1700x1040@1', 'paper:1700x1040@1', 'depth:1700x1040@1', 'live:1700x1040@1', 'nibs:1800x800@1'];
mkdirSync(out, { recursive: true });

for (const spec of specs) {
  const m = /^(\w+)(?::(\d+)x(\d+))?(?:@(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) throw new Error('bad spec ' + spec);
  const [, view, w = '1700', h = '1040', dpr = '1'] = m;
  const { browser, page, errors } = await launch({ width: +w, height: +h, dpr: +dpr, url: `http://localhost:5197/sandbox/ink-forms/index.html?view=${view}` });
  try {
    await page.waitForFunction(() => (window.__drawn ?? 0) > 0, { timeout: 30000 });
    await sleep(300);
    const file = join(out, `ink-forms-${view}${dpr !== '1' ? '@' + dpr : ''}.png`);
    await page.screenshot({ path: file });
    console.log(file, await page.$eval('#label', e => e.textContent));
    if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  } finally {
    await browser.close();
  }
}
