// Screenshot the ink-instrument sandbox: the gallery plus a live pen stroke drawn through
// CDP, then any zoom views given as query strings (e.g. "panel=1&k=8&fx=240&fy=150").
// usage: node sandbox/ink-instrument/shot.mjs <outDir> [query ...]   (needs `npx vite --port 5191 --strictPort`)
import { launch, sleep, penStroke } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || '.';
const zooms = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const BASE = 'http://localhost:5191/sandbox/ink-instrument/index.html';

async function shoot(query, name, live) {
  const { browser, page, cdp, errors } = await launch({ width: 1600, height: 900, dpr: 1, url: query ? `${BASE}?${query}` : BASE });
  try {
    await page.waitForFunction(() => (window.__drawn ?? 0) > 0, { timeout: 20000 });
    if (live) {
      // live panel: bottom-right quarter; a loop that closes on itself, pressure swelling
      const cx = 1400, cy = 670, pts = [];
      for (let i = 0; i <= 140; i++) {
        const a = (i / 140) * Math.PI * 2.02;
        pts.push([cx + 110 * Math.cos(a), cy + 80 * Math.sin(a), 0.25 + 0.6 * Math.sin(Math.min(1, i / 140) * Math.PI)]);
      }
      await penStroke(cdp, pts, { delay: 4 });
      await sleep(300);
    }
    const file = join(out, `ink-instrument-${name}.png`);
    await page.screenshot({ path: file });
    console.log(file, live ? JSON.stringify(await page.evaluate(() => window.__live ?? null)) : '');
    const real = errors.filter(e => !/favicon|404/.test(e));
    if (real.length) console.log('ERRORS:\n' + real.join('\n'));
  } finally {
    await browser.close();
  }
}

await shoot('', 'gallery', true);
for (let i = 0; i < zooms.length; i++) await shoot(zooms[i], `zoom${i}`, false);
