// Screenshot the render-live sandbox.
// usage: node sandbox/render-live/shot.mjs <outDir> [name=query ...]
// (needs `npx vite --port $PORT --strictPort` running; PORT defaults to 5184)
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || '.';
const DEFAULT = [
  'sprout-mid=view=stroke&cook=real&form=sprout&at=1100',
  'sprout-hold=view=stroke&cook=real&form=sprout&at=HOLD+1100',
  'sprout-lift=view=stroke&cook=real&form=sprout&at=LIFT+150',
  'sprout-baked=view=stroke&cook=real&form=sprout&at=LIFT+1500',
  'sprout-paper-mid=view=stroke&cook=real&form=sprout&ground=paper&at=1400',
  'drift-mid=view=stroke&cook=real&form=drift&at=1500&dbg=1',
  'line-mid=view=stroke&cook=real&form=line&at=1300',
  'echo-lift=view=stroke&cook=real&form=echo&at=LIFT+250',
  'withdraw=view=withdraw&cook=real&form=sprout&at=90',
  'play-hold=view=play&at=HOLD+1000',
  'nib-zoom=view=stroke&cook=real&form=sprout&at=1100&dpr=3&clip=560,360,260,170',
  'overlay-night=view=overlay',
  'overlay-paper=view=overlay&ground=paper',
];
const specs = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT;
mkdirSync(out, { recursive: true });
const base = `http://localhost:${process.env.PORT || 5184}/sandbox/render-live/index.html`;

// discover the scripted timeline once
const probe = await launch({ width: 1400, height: 820, url: `${base}?view=stroke&at=0` });
await probe.page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
const tl = await probe.page.evaluate(() => window.__stats);
await probe.browser.close();
console.log('timeline', JSON.stringify(tl));

for (const spec of specs) {
  const [name, qs0] = spec.split(/=(.*)/s);
  let qs = qs0
    .replace('AFTERHOLD', String(tl.T_HOLD0 + 1150))
    .replace(/HOLD\+(\d+)/, (_, d) => String(tl.T_HOLD0 + +d))
    .replace(/LIFT\+(\d+)/, (_, d) => String(tl.T_LIFT + +d));
  const m = /&size=(\d+)x(\d+)(?:@(\d+))?/.exec(qs);
  const w = m ? +m[1] : 1400, h = m ? +m[2] : 820;
  const dm = /&dpr=(\d+)/.exec(qs), cm = /&clip=(\d+),(\d+),(\d+),(\d+)/.exec(qs);
  const dpr = dm ? +dm[1] : m && m[3] ? +m[3] : 1;
  const clip = cm ? { x: +cm[1], y: +cm[2], width: +cm[3], height: +cm[4] } : undefined;
  const { browser, page, errors } = await launch({ width: w, height: h, dpr, url: `${base}?${qs}` });
  try {
    await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
    await sleep(200);
    const file = join(out, `render-live-${name}.png`);
    await page.screenshot({ path: file, clip });
    const label = await page.$eval('#label', e => e.textContent);
    console.log(file, '|', label.replace(/\n/g, ' | '));
    if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  } finally {
    await browser.close();
  }
}
