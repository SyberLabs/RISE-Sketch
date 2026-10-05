// Screenshot a lab form's gallery views.
//   node lab/forms/shot.mjs <form> <port> <outDir> [view[:WxH[@dpr]] ...]
// Needs `npx vite --port <port> --strictPort` running from the repo root.
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [form, port, out = '.'] = process.argv.slice(2);
if (!form || !port) { console.error('usage: node lab/forms/shot.mjs <form> <port> <outDir> [views...]'); process.exit(2); }
const specs = process.argv.slice(5).length ? process.argv.slice(5) : ['forms', 'paper', 'depth', 'live', 'speed', 'seeds', 'compare'];
mkdirSync(out, { recursive: true });

for (const spec of specs) {
  const m = /^(\w+)(?::(\d+)x(\d+))?(?:@(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) throw new Error('bad spec ' + spec);
  const [, view, w = '1700', h = '1040', dpr = '1'] = m;
  const { browser, page, errors } = await launch({ width: +w, height: +h, dpr: +dpr, url: `http://localhost:${port}/lab/forms/index.html?form=${form}&view=${view}` });
  try {
    await page.waitForFunction(() => (window.__drawn ?? 0) > 0, { timeout: 60000 });
    await sleep(300);
    const file = join(out, `${form}-${view}${dpr !== '1' ? '@' + dpr : ''}.png`);
    await page.screenshot({ path: file });
    console.log(file, '\n   ', await page.$eval('#label', e => e.textContent));
    const errs = errors.filter(e => !/favicon/.test(e));
    if (errs.length) console.log('ERRORS:\n' + errs.join('\n'));
  } catch (e) {
    console.log(`FAILED ${view}: ${e.message}`);
    if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
