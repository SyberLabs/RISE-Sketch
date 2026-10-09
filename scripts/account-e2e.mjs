// Fixture account service; real browser document capture, admission and local autosave.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { launch, penStroke, line } from './harness.mjs';
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/e' || pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = resolve('dist-debug', pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file.startsWith(resolve('dist-debug') + '/')) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let env;
try {
  env = await launch({ url: 'about:blank', width: 375, height: 812, touch: true });
  const { page, cdp } = env;
  await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
  let user = { id: 'test-user-one', label: '<script>Fixture reader</script>' }, posts = 0, payload = null, malformed = false;
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (!req.url().startsWith('https://syberlabs.io/admin/api/v1/')) { void req.continue(); return; }
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type,X-SyberLabs-Account', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method() === 'OPTIONS') { void req.respond({ status: 204, headers }); return; }
    const save = { id: 'saved-one', app: 'sketch', name: '<img src=x>', createdAt: 1234567, bytes: 1000 };
    let body = { user };
    if (req.method() === 'POST') { posts++; const input = JSON.parse(req.postData()); payload = input.payload; assert.equal(input.app, 'sketch'); assert.match(input.requestId, /^[a-f0-9-]{36}$/); body = { save }; }
    else if (req.url().includes('/saves?')) body = { saves: payload ? [save] : [] };
    else if (req.url().endsWith('/saves/saved-one')) body = { save: { ...save, payload: malformed ? { schema: 'sketch.account-document.v1', document: {} } : payload } };
    void req.respond({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ version: 1, ...body }) });
  });
  await page.goto(origin + '/?debug', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rise && document.querySelector('.sketch-account-entry')?.textContent === 'Account');
  assert.equal(posts, 0, 'boot never uploads');
  const box = await page.$eval('.sketch-account-entry', e => { const r = e.getBoundingClientRect(); return { right: r.right, left: r.left, top: r.top, height: r.height }; });
  assert(box.left > 250 && box.right <= 375 && box.top < 30 && box.height >= 44, 'phone upper-right control');
  for (const sheet of ['menu', 'help', 'color']) {
    await page.evaluate(sheet => window.__rise.dispatch({ k: 'openSheet', sheet }), sheet);
    await page.waitForFunction(() => document.querySelector('.sketch-account-entry').hidden);
    assert.equal(await page.$eval('.sketch-account-entry', e => getComputedStyle(e).display), 'none', 'modal sheet owns account control hit testing');
    await page.evaluate(() => window.__rise.dispatch({ k: 'openSheet', sheet: null }));
    await page.waitForFunction(() => !document.querySelector('.sketch-account-entry').hidden);
  }
  await page.evaluate(() => window.__rise.idle(15000));
  await penStroke(cdp, line(75, 250, 270, 320, 8));
  await page.waitForFunction(() => window.__rise.strokeCount() > 0);
  await page.click('.sketch-account-entry');
  await page.waitForFunction(() => document.querySelector('[data-save]')?.disabled === false);
  const panelBox = await page.$eval('dialog', e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  assert(panelBox.left >= 0 && panelBox.right <= 375 && panelBox.top >= 0 && panelBox.bottom <= 812, 'phone dialog fits the screen');
  assert.equal(await page.$eval('[data-user]', e => e.textContent), user.label, 'identity label rendered literally');
  await page.click('[data-save]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('saved to your account'));
  assert.equal(posts, 1); assert(payload.document.strokes.length > 0, 'live art captured');
  assert.equal(payload.schema, 'sketch.account-document.v1');
  await page.click('[data-confirm]'); await page.click('[data-restore]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.startsWith('Drawing restored'));
  const before = await page.evaluate(() => window.__rise.serialize());
  malformed = true; await page.click('[data-confirm]'); await page.click('[data-restore]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('failed validation'));
  assert.deepEqual(await page.evaluate(() => window.__rise.serialize()), before, 'bad remote snapshot never mutates browser drawing');
  user = { id: 'other-user', label: 'Changed account' }; await page.click('[data-save]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('account changed'));
  assert.equal(posts, 1, 'stale panel cannot upload to a different account');
  mkdirSync('e2e-out', { recursive: true }); await page.screenshot({ path: 'e2e-out/account-phone.png' });
  assert.deepEqual(env.errors, []);
  console.log('PASS account phone placement, modal controls, explicit save, validated restore, unchanged malformed restore, switched-account refusal');
} finally { await env?.browser.close(); await new Promise(resolve => server.close(resolve)); }
