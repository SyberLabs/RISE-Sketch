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
  let user = { id: 'test-user-one', label: '<script>Fixture reader</script>' }, posts = 0, payload = null, malformed = false, race = false, failNextList = 0;
  const attemptedPosts = [];
  let holdDetail = false; const heldDetails = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (!req.url().startsWith('https://syberlabs.io/admin/api/v1/')) { void req.continue(); return; }
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type,X-SyberLabs-Account,X-SyberLabs-Expected-User', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method() === 'OPTIONS') { void req.respond({ status: 204, headers }); return; }
    if (req.url().includes('/saves')) {
      const owner = req.headers()['x-syberlabs-expected-user'];
      if (req.method() === 'POST') attemptedPosts.push({ owner, body: JSON.parse(req.postData()) });
      if (owner !== user.id || race) {
        void req.respond({ status: owner ? 409 : 400, headers, contentType: 'application/json', body: JSON.stringify({ version: 1, error: owner ? 'account_changed' : 'expected_user_required' }) });
        return;
      }
    }
    if (req.url().includes('/saves?') && failNextList) {
      const status = failNextList; failNextList = 0;
      void req.respond({ status, headers, contentType: 'application/json', body: JSON.stringify({ version: 1, error: status === 409 ? 'account_changed' : 'unavailable' }) }); return;
    }
    const save = { id: 'saved-one', app: 'sketch', name: '<img src=x>', createdAt: 1234567, bytes: 1000 };
    let body = { user };
    if (req.method() === 'POST') { posts++; const input = JSON.parse(req.postData()); payload = input.payload; assert.equal(input.app, 'sketch'); assert.match(input.requestId, /^[a-f0-9-]{36}$/); body = { save }; }
    else if (req.url().includes('/saves?')) body = { saves: payload ? [save] : [] };
    else if (req.url().endsWith('/saves/saved-one')) body = { save: { ...save, payload: malformed ? { schema: 'sketch.account-document.v1', document: {} } : payload } };
    const respond = () => req.respond({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ version: 1, ...body }) });
    if (holdDetail && req.url().endsWith('/saves/saved-one')) { heldDetails.push(respond); return; }
    void respond();
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
  failNextList = 503;
  await page.click('[data-save]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('saved to your account'));
  assert.equal(posts, 1); assert(payload.document.strokes.length > 0, 'live art captured');
  assert.equal(payload.schema, 'sketch.account-document.v1');
  assert.match(await page.$eval('[data-status]', e => e.textContent), /saved to your account.*could not refresh/, 'committed save remains successful when only list refresh fails');
  assert.equal(await page.$eval('[data-restore]', e => e.disabled), true, 'unavailable list cannot authorize a restore');
  assert.match(await page.$eval('[data-detail]', e => e.textContent), /could not be loaded/, 'failure does not masquerade as an empty library');
  await page.click('[data-reload]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('up to date'));
  assert.equal(posts, 1, 'refresh never reuploads a committed backup');
  assert.match(await page.$eval('[data-detail]', e => e.textContent), /Saved .*1 KB/);
  assert.equal(await page.$eval('[data-confirm-label]', e => e.textContent), 'Open “<img src=x>” in this browser', 'chosen backup named literally before consent');
  assert.equal(await page.$$eval('dialog img', nodes => nodes.length), 0, 'backup name never becomes markup');
  await page.click('[data-confirm]'); await page.click('[data-reload]');
  await page.waitForFunction(() => document.querySelector('[data-reload]')?.disabled === false);
  assert.equal(await page.$eval('[data-confirm]', e => e.checked), false, 'refresh requires renewed consent');
  assert(await page.$eval('.sketch-account-confirm', e => e.getBoundingClientRect().height >= 44), 'named consent has a phone-sized hit target');
  assert(await page.$eval('[data-close]', e => e.getBoundingClientRect().width >= 44), 'close control has a phone-sized hit target');
  mkdirSync('e2e-out', { recursive: true }); await page.screenshot({ path: 'e2e-out/account-ux-phone.png' });
  for (const code of [401, 409]) {
    failNextList = code;
    await page.click('[data-save]');
    await page.waitForFunction(() => document.querySelector('[data-save]')?.disabled === false);
    const message = await page.$eval('[data-status]', e => e.textContent);
    assert.match(message, /saved to your account.*could not refresh/, 'committed save stays successful across profile recovery errors');
    assert.match(message, code === 401 ? /Sign in again/ : /account changed.*Close this panel/);
    assert.doesNotMatch(message, /Use Refresh backups/, 'captured identity mismatch cannot be fixed by retrying the old owner');
    assert.equal(await page.$eval('[data-signin]', e => e.hidden), code !== 401);
    await page.click('[data-reload]');
    await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('up to date'));
  }
  const acceptedUploads = posts;
  await page.focus('#sketch-backup-name');
  const nameBeforeKeys = await page.$eval('#sketch-backup-name', e => e.value);
  await page.keyboard.type('x'); await page.keyboard.press('Backspace');
  assert.equal(await page.$eval('#sketch-backup-name', e => e.value), nameBeforeKeys, 'native text editing still works inside the keyboard boundary');
  const artBeforeKeys = await page.evaluate(() => window.__rise.serialize());
  await page.evaluate(() => document.activeElement.blur());
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.down(modifier);
  await page.keyboard.press('z');
  await page.keyboard.up(modifier);
  assert.deepEqual(await page.evaluate(() => window.__rise.serialize()), artBeforeKeys, 'body focus after refresh cannot send Undo to background drawing');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sketch-account-panel'));
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.sketch-account-entry')), true, 'Escape closes the account modal and returns trigger focus after body focus');
  await penStroke(cdp, line(90, 390, 280, 460, 8));
  await page.evaluate(() => window.__rise.idle(15000));
  const priorCount = await page.evaluate(() => window.__rise.strokeCount());
  assert(priorCount > payload.document.strokes.length, 'newer browser drawing differs from older backup');
  await page.click('.sketch-account-entry');
  await page.waitForFunction(() => document.querySelector('[data-save]')?.disabled === false);
  await page.click('[data-confirm]'); await page.click('[data-restore]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.startsWith('Drawing restored'));
  // Success must mean imported ink is durable; reload immediately, without an autosave delay.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__rise && document.querySelector('.sketch-account-entry')?.textContent === 'Account');
  assert.equal(await page.evaluate(() => window.__rise.strokeCount()), payload.document.strokes.length, 'reload selects restored older backup');
  await page.evaluate(() => window.__rise.dispatch({ k: 'openSheet', sheet: 'menu' }));
  await page.waitForFunction(count => window.__rise.state().recentDocs.some(doc => doc.strokes === count), {}, priorCount);
  await page.evaluate(() => window.__rise.dispatch({ k: 'openSheet', sheet: null }));
  await page.click('.sketch-account-entry');
  await page.waitForFunction(() => document.querySelector('[data-save]')?.disabled === false);
  const before = await page.evaluate(() => window.__rise.serialize());
  malformed = true; await page.click('[data-confirm]'); await page.click('[data-restore]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('failed validation'));
  assert.deepEqual(await page.evaluate(() => window.__rise.serialize()), before, 'bad remote snapshot never mutates browser drawing');
  race = true;
  await page.click('[data-save]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('account changed'));
  await page.click('[data-save]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('account changed'));
  assert.equal(attemptedPosts.length, acceptedUploads + 2, 'successful fixture uploads plus two explicit refused retries');
  assert.equal(attemptedPosts[acceptedUploads].owner, 'test-user-one');
  assert.deepEqual(attemptedPosts[acceptedUploads], attemptedPosts[acceptedUploads + 1], 'race retries retain original captured owner, UUID and snapshot');
  assert.equal(posts, acceptedUploads, 'server account switch refuses upload even when profile pre-check still saw A');
  user = { id: 'other-user', label: 'Changed account' }; await page.click('[data-save]');
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('account changed'));
  assert.equal(posts, acceptedUploads, 'stale panel cannot upload to a different account');
  await page.click('[data-close]');
  race = false; malformed = false; holdDetail = true;
  for (const [from, to] of [['owner-a', 'owner-b'], ['owner-b', 'owner-a']]) {
    user = { id: from, label: from };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(label => document.querySelector('.sketch-account-entry').title === `SyberLabs account: ${label}`, {}, from);
    await page.click('.sketch-account-entry');
    await page.waitForFunction(() => document.querySelector('[data-save]')?.disabled === false);
    const unchanged = await page.evaluate(() => window.__rise.serialize());
    await page.click('[data-confirm]'); await page.click('[data-restore]');
    while (!heldDetails.length) await new Promise(resolve => setTimeout(resolve, 20));
    user = { id: to, label: to };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector('.sketch-account-panel'));
    await heldDetails.shift()();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    assert.equal(await page.evaluate(() => window.__rise.serialize()), unchanged, 'successful stale detail cannot mutate browser art after account switch');
  }
  mkdirSync('e2e-out', { recursive: true }); await page.screenshot({ path: 'e2e-out/account-phone.png' });
  const expectedConflicts = env.errors.filter(error => error === 'console: Failed to load resource: the server responded with a status of 409 (Conflict)');
  assert.equal(expectedConflicts.length, 3, 'two refused account-race retries and one deliberately changed list owner log HTTP conflicts');
  const expectedUnavailable = env.errors.filter(error => error === 'console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)');
  assert.equal(expectedUnavailable.length, 1, 'only the deliberately failed list refresh logs service unavailable');
  const expectedUnauthorized = env.errors.filter(error => error === 'console: Failed to load resource: the server responded with a status of 401 (Unauthorized)');
  assert.equal(expectedUnauthorized.length, 1);
  assert.deepEqual(env.errors.filter(error => !expectedConflicts.includes(error) && !expectedUnavailable.includes(error) && !expectedUnauthorized.includes(error)), []);
  console.log('PASS account phone placement, modal controls, explicit save, validated restore, unchanged malformed restore, switched-account/server-race refusal and both-direction delayed-detail cancellation');
} finally { await env?.browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
