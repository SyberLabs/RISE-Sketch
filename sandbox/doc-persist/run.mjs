// Drives sandbox/doc-persist through write -> reload -> read in headless Chrome.
// Usage: start `npx vite --port 5188 --strictPort`, then `node sandbox/doc-persist/run.mjs [outDir]`
// (another port: PORT=5198 node sandbox/doc-persist/run.mjs).
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const out = process.argv[2] || 'e2e-out';
mkdirSync(out, { recursive: true });
const port = process.env.PORT || '5188';
const url = `http://localhost:${port}/sandbox/doc-persist/index.html?phase=write`;
const { browser, page, errors } = await launch({ width: 900, height: 900, url });
let result = null;
for (let i = 0; i < 200 && !result; i++) {
  await sleep(100);
  result = await page.evaluate(() => (window.__result && window.__result.phase === 'read') || (window.__result && !window.__result.ok) ? window.__result : null).catch(() => null);
}
await page.screenshot({ path: join(out, 'doc-persist-sandbox.png') });

// pickFile: choose a file, then cancel; downloadBlob: sanitised name lands in the download dir
const extra = [];
const fixture = resolve('tests/fixtures/doc-v1.rise');
let [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#pick')]);
await chooser.accept([fixture]);
await page.waitForFunction(() => window.__pickDone === true, { timeout: 5000 }).catch(() => null);
const picked = await page.evaluate(() => window.__picked);
extra.push({ name: 'pickFile resolves the chosen file', ok: typeof picked === 'string' && picked.startsWith('doc-v1.rise:') && picked.endsWith(':' + readFileSync(fixture, 'utf8').length), detail: String(picked) });
[chooser] = await Promise.all([page.waitForFileChooser(), page.click('#pick')]);
await chooser.cancel();
await page.waitForFunction(() => window.__pickDone === true, { timeout: 5000 }).catch(() => null);
extra.push({ name: 'pickFile resolves null on cancel', ok: (await page.evaluate(() => window.__picked)) === null });
const dl = mkdtempSync(join(tmpdir(), 'rise-dl-'));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
await page.click('#save');
let got = [];
for (let i = 0; i < 50 && !got.some(f => f.endsWith('.rise')); i++) { await sleep(100); got = readdirSync(dl); }
extra.push({ name: 'downloadBlob saves under a sanitised name', ok: got.includes('My- drawing-1-.rise'), detail: got.join(', ') });
rmSync(dl, { recursive: true, force: true });
await browser.close();
if (result) result.checks.push(...extra);
if (!result) { console.error('no result', errors); process.exit(2); }
for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
const failed = result.checks.filter(c => !c.ok).length;
console.log(`${result.checks.length - failed}/${result.checks.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
