// Drives sandbox/input/index.html through scripts/harness.mjs (real CDP pen / mouse /
// touch / wheel / key input) and asserts the sink log.
//   npx vite --config sandbox/input/vite.config.mjs --port 5185 --strictPort   (in another shell)
//   node sandbox/input/drive.mjs        [URL=...] [SHOT=path.png]
import { launch, penStroke, pinch, tap, wheel, key, wave, sleep } from '../../scripts/harness.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5185/sandbox/input/index.html';
const SHOT = process.env.SHOT || join(tmpdir(), 'rise-input-sandbox.png');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + JSON.stringify(detail)}`);
};

const { browser, page, cdp, errors } = await launch({ url: URL, touch: true, width: 1200, height: 800 });
await page.waitForFunction(() => !!window.__input);
await page.evaluate(() => localStorage.clear()); // forget any remembered pen mode
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__input);

const getLog = () => page.evaluate(() => window.__input.log.slice());
const probe = (expr) => page.evaluate(expr);
const clear = async () => { await sleep(30); await page.evaluate(() => window.__input.clear()); };
const strip = (l) => l.replace(/ ×\d+$/, '');
/** Structural lines only (collapsed repeats expanded): no move / pan / lasso moves / hover / zoom noise. */
const structural = (log) => log.flatMap(l => {
  const k = Number((/ ×(\d+)$/.exec(l) || [0, 1])[1]);
  return Array(k).fill(strip(l));
}).filter(l => !/^(move|pan |lassoMove|hover |zoom )/.test(l));
const times = (log, re) => log.filter(l => re.test(strip(l))).reduce((n, l) => n + Number((/ ×(\d+)$/.exec(l) || [0, 1])[1]), 0);
const zoomProduct = (log) => log.filter(l => l.startsWith('zoom ')).reduce((p, l) => p * Math.pow(Number(l.split(' ')[1]), Number((/ ×(\d+)$/.exec(l) || [0, 1])[1])), 1);
const panSum = (log) => {
  let x = 0, y = 0;
  for (const l of log) {
    const m = /^pan (-?[\d.]+),(-?[\d.]+)(?: ×(\d+))?$/.exec(l);
    if (m) { const k = Number(m[3] || 1); x += k * Number(m[1]); y += k * Number(m[2]); }
  }
  return [Math.round(x), Math.round(y)];
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const mouse = (type, x, y, o = {}) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: o.button || 'none', buttons: o.buttons || 0, modifiers: o.modifiers || 0,
  pointerType: o.pointerType || 'mouse', clickCount: 1, ...(o.force !== undefined ? { force: o.force } : {}),
});
async function drag(x0, y0, x1, y1, o = {}) {
  const { button = 'left', buttons = 1, steps = 10, delay = 8 } = o;
  await mouse('mouseMoved', x0, y0, o);
  await mouse('mousePressed', x0, y0, { ...o, button, buttons });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { ...o, button, buttons });
    if (delay) await sleep(delay);
  }
  await mouse('mouseReleased', x1, y1, { ...o, button, buttons: 0 });
}
async function click(x, y, o = {}) {
  const { button = 'left', buttons = 1 } = o;
  await mouse('mouseMoved', x, y, o);
  await mouse('mousePressed', x, y, { ...o, button, buttons });
  await mouse('mouseReleased', x, y, { ...o, button, buttons: 0 });
}
const touch = (type, pts, r = 4) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: r, radiusY: r, force: 1 })),
});
async function touchDrag(x0, y0, x1, y1, { steps = 8, delay = 16, holdFirst = 0, r = 4 } = {}) {
  await touch('touchStart', [[x0, y0]], r);
  if (holdFirst) await sleep(holdFirst);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]], r);
    await sleep(delay);
  }
  await touch('touchEnd', []);
}

// ------------------------------------------------------------------ mouse
await clear();
await drag(100, 100, 400, 160, { steps: 20 });
let log = await getLog();
let s = structural(log);
check('mouse left-drag draws and commits', s[0] === 'contact true' && s[1] === 'begin mouse draw 100,100 p=NaN' && /^end commit/.test(s[2]) && s[3] === 'contact false' && s.length === 4, s);
check('mouse stroke timestamps strictly increase', (await probe(() => window.__input.tViolations)) === 0);
check('mouse stroke carries predicted samples', (await probe(() => window.__input.predictedSeen)) > 0);

await clear();
await click(300, 300, { modifiers: MOD.Ctrl });
await click(320, 300, { modifiers: MOD.Ctrl | MOD.Shift });
check('Mod-click selects; Shift+Mod adds; no chrome hiding', eq(structural(await getLog()), ['select 300,300', 'select 320,300 add']), await getLog());

await clear();
await drag(200, 200, 300, 280, { modifiers: MOD.Ctrl, steps: 8 });
s = structural(await getLog());
check('Mod-drag lassos', s[0] === 'contact true' && s[1] === 'lassoBegin 200,200' && /^lassoEnd/.test(s[2]) && s[3] === 'contact false', s);

await clear();
await click(250, 250, { modifiers: MOD.Alt });
check('Alt-click samples', eq(structural(await getLog()), ['sample 250,250']), await getLog());

await clear();
await click(500, 300, { button: 'right', buttons: 2 });
check('bare right-click does nothing', eq(structural(await getLog()), []), await getLog());
const ctxPrevented = await page.evaluate(() => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  document.getElementById('stage').dispatchEvent(e);
  return e.defaultPrevented;
});
check('contextmenu is prevented on the canvas', ctxPrevented);

await clear();
await drag(500, 300, 600, 340, { button: 'right', buttons: 2 });
s = structural(await getLog());
check('right-drag erases from the press point', s[0] === 'contact true' && s[1] === 'begin mouse erase 500,300 p=NaN' && /^end commit/.test(s[2]), s);

await clear();
await drag(600, 400, 650, 420, { button: 'middle', buttons: 4, steps: 5 });
log = await getLog();
check('middle-drag pans', eq(structural(log), ['contact true', 'navEnd drag', 'contact false']) && eq(panSum(log), [50, 20]), log);

await clear();
await page.keyboard.down('Space');
await drag(600, 400, 680, 400, { steps: 4 });
await page.keyboard.up('Space');
log = await getLog();
check('Space-drag pans and never draws', eq(structural(log), ['contact true', 'navEnd drag', 'contact false']) && eq(panSum(log), [80, 0]), log);

// ------------------------------------------------------------------ wheel
await sleep(450);
await clear();
await wheel(cdp, 500, 400, 100);
await sleep(80);
log = await getLog();
check('wheel notch zooms ×1/1.15 at the cursor', log[0] === 'zoom 0.8696 @500,400', log);
await sleep(450);
log = await getLog();
check('wheel burst ends with navEnd wheel after 400 ms', strip(log[log.length - 1]) === 'navEnd wheel', log);
await clear();
await wheel(cdp, 500, 400, 3.5);
await sleep(40);
check('trackpad scroll pans', (await getLog())[0] === 'pan 0.0,-3.5', await getLog());
await sleep(450);
await clear();
await wheel(cdp, 500, 400, 5, { ctrl: true });
await sleep(40);
check('ctrl+wheel pinch zooms by exp(-dy*0.012)', (await getLog())[0] === `zoom ${Math.exp(-0.06).toFixed(4)} @500,400`, await getLog());
await sleep(450);

// ------------------------------------------------------------------ keys
await clear();
await key(page, 'KeyB');
await key(page, 'KeyB', ['Shift']);
await key(page, 'Digit1');
await key(page, 'BracketRight');
await key(page, 'Equal');
await key(page, 'Escape');
await key(page, 'KeyZ', ['Control']);
await key(page, 'KeyZ', ['Control', 'Shift']);
await key(page, 'KeyY', ['Control']);
await key(page, 'Slash', ['Shift']);
await key(page, 'Digit1', ['Shift']);
await key(page, 'KeyG');
await key(page, 'Digit5');
log = await getLog();
check('key map', eq(structural(log), [
  'key nib 1', 'key nib -1', 'key form 0', 'key size 1.25', 'key depth 0.5', 'key escape', 'key undo', 'key redo', 'key redo',
  'key help', 'key fit', 'key ground',
]), log);
await clear();
await page.evaluate(() => { window.__input.blocked = true; });
await key(page, 'KeyB');
await key(page, 'KeyZ', ['Control']);
await page.evaluate(() => { window.__input.blocked = false; });
check('single keys are ignored while keysBlocked(); chords still work', eq(structural(await getLog()), ['key undo']), await getLog());

await clear();
await page.focus('#radio');
await key(page, 'KeyB');
await key(page, 'KeyZ', ['Control']);
await page.focus('#eater');
await key(page, 'KeyB');                       // the widget consumed it (preventDefault)
await key(page, 'KeyC');                       // not consumed: reaches the canvas map
await page.evaluate(() => document.activeElement.blur());
check('radio-group focus blocks single keys (chords pass); a key a widget consumed never fires',
  eq(structural(await getLog()), ['key undo', 'key ink 1']), await getLog());

await clear();
const altGrHelp = (blocked) => page.evaluate((b) => {
  window.__input.blocked = b;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Minus', key: '?', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
  window.__input.blocked = false;
}, blocked);
await altGrHelp(true);
await altGrHelp(false);
check('AltGr ? opens help but respects keysBlocked() (Ctrl+Alt is not a chord)', eq(structural(await getLog()), ['key help']), await getLog());

// ------------------------------------------------------------------ touch, no pen seen
check('pen mode is off before any pen event', (await probe(() => window.__input.input.penMode)) === false);
await clear();
await tap(cdp, 200, 500);
await sleep(30);
s = structural(await getLog());
check('touch tap begins a seed at once, commit deferred', eq(s, ['contact true', 'begin touch draw 200,500 p=NaN', 'contact false']), s);
await sleep(400);
s = structural(await getLog());
check('touch tap commits after the double-tap window', /^end commit/.test(s[3] || ''), s);

await clear();
await tap(cdp, 300, 500);
await sleep(80);
await tap(cdp, 304, 502);
await sleep(30);
s = structural(await getLog());
check('double-tap selects and withdraws the first seed', s[1] === 'begin touch draw 300,500 p=NaN' && /^end withdraw/.test(s[3]) && s[4] === 'select 304,502 add' && s.length === 5, s);
await sleep(400);

await clear();
await tap(cdp, 400, 500, 2);
await sleep(30);
s = structural(await getLog());
check('two-finger tap withdraws and undoes', s[0] === 'contact true' && s[1] === 'begin touch draw 400,500 p=NaN' && /^end withdraw/.test(s[2]) && s[3] === 'twoFingerTap' && s[4] === 'contact false', s);

await clear();
await pinch(cdp, [[500, 400], [600, 400]], [[450, 400], [650, 400]], 12);
await sleep(30);
log = await getLog();
s = structural(log);
const zp = zoomProduct(log);
check('pinch: withdraw, zoom past the 4% dead zone, navEnd pinch', /^end withdraw/.test(s[2]) && s.includes('navEnd pinch') && Math.abs(zp - 200 / 104) < 0.01, { s, zp });

await clear();
await pinch(cdp, [[500, 400], [600, 400]], [[560, 440], [660, 440]], 10);
await sleep(30);
log = await getLog();
check('two-finger pan without zoom ends as a drag', !log.some(l => l.startsWith('zoom')) && structural(log).includes('navEnd drag') && eq(panSum(log), [60, 40]), log);

await clear();
await touchDrag(100, 600, 300, 650, { steps: 10 });
await sleep(30);
s = structural(await getLog());
check('one-finger touch drag draws', s[1] === 'begin touch draw 100,600 p=NaN' && /^end commit/.test(s[2]), s);

await clear();
await tap(cdp, 700, 500);
const ui = await page.evaluate(() => { const r = document.getElementById('ui').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await click(ui[0], ui[1]);
await sleep(20);
s = structural(await getLog());
check('a press on the chrome commits a pending tap at once', /^end commit/.test(s[3] || ''), s);
await sleep(400);

// ------------------------------------------------------------------ pen
await clear();
await penStroke(cdp, wave(150, 300, 750, 90, 80), { delay: 4 });
await sleep(30);
log = await getLog();
s = structural(log);
const pr = await probe(() => window.__input.pressures);
check('pen stroke draws with pressure and turns pen mode on',
  s.includes('[penMode true]') && s.some(l => /^begin pen draw 150,300 p=0\.\d/.test(l)) && s.some(l => /^end commit/.test(l)), s);
check('pen pressure varies along the stroke', Math.min(...pr) < 0.4 && Math.max(...pr) > 0.85, { min: Math.min(...pr), max: Math.max(...pr) });
check('pen stroke timestamps strictly increase', (await probe(() => window.__input.tViolations)) === 0);
check('pen hover is reported', log.some(l => strip(l) === 'hover pen'), log.slice(0, 4));

await sleep(700); // past the pen-recent windows
await clear();
await tap(cdp, 800, 600);
await sleep(30);
check('pen mode: a finger tap selects (adds), never draws', eq(structural(await getLog()), ['select 800,600 add']), await getLog());

await clear();
await touchDrag(800, 600, 900, 600, { steps: 3, r: 26 });
await tap(cdp, 820, 620); // a real tap right after is fine
await sleep(30);
check('pen mode: palms (radius > 20 sp) are ignored', eq(structural(await getLog()), ['select 820,620 add']), await getLog());

await clear();
await touchDrag(600, 650, 700, 650, { steps: 6, delay: 16 });
await sleep(30);
log = await getLog();
check('pen mode: a fast finger pans and fires the toast hook',
  eq(structural(log), ['contact true', '[fingerPan]', 'navEnd drag', 'contact false']) && eq(panSum(log), [100, 0]), log);

await clear();
await touchDrag(400, 650, 480, 700, { steps: 6, holdFirst: 450 });
await sleep(30);
s = structural(await getLog());
check('pen mode: hold 350 ms then drag lassos', s[0] === 'contact true' && s[1] === 'lassoBegin 400,650' && /^lassoEnd/.test(s[2]), s);

await clear();
await tap(cdp, 500, 650, 2);
await sleep(30);
check('pen mode: two-finger tap undoes', eq(structural(await getLog()), ['twoFingerTap']), await getLog());

await clear();
await page.evaluate(() => {
  const st = document.getElementById('stage');
  const o = { pointerId: 77, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, pressure: 0.5 };
  st.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 300, clientY: 700, button: 5, buttons: 32 }));
  st.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 340, clientY: 700, button: -1, buttons: 32 }));
  st.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 340, clientY: 700, button: 5, buttons: 0, pressure: 0 }));
});
s = structural(await getLog());
check('pen eraser end (buttons & 32 / button 5) erases', s[1] === 'begin pen erase 300,700 p=0.5' && /^end commit/.test(s[2]), s);

await clear();
await drag(900, 300, 960, 300, { button: 'right', buttons: 2, pointerType: 'pen', force: 0.5, steps: 6 });
s = structural(await getLog());
check('pen barrel-button drag erases', s.some(l => /^begin pen erase 900,300/.test(l)), s);

// Barrel pressed while hovering (Pointer Events fire pointerdown for it), then the tip
// lands, drags, lifts with the barrel still held, waves in the air, releases.
await clear();
await page.evaluate(() => {
  const st = document.getElementById('stage');
  const o = { pointerId: 78, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true };
  const ev = (type, x, buttons, pressure, button = -1) =>
    st.dispatchEvent(new PointerEvent(type, { ...o, clientX: x, clientY: 560, button, buttons, pressure }));
  ev('pointerdown', 300, 2, 0, 2);
  for (let x = 310; x <= 400; x += 10) ev('pointermove', x, 2, 0);   // hovering: nothing erases
  ev('pointermove', 405, 3, 0.5);                                     // the tip lands
  for (let x = 410; x <= 480; x += 10) ev('pointermove', x, 3, 0.5);
  ev('pointermove', 490, 2, 0);                                       // the tip lifts, barrel held
  for (let x = 500; x <= 600; x += 10) ev('pointermove', x, 2, 0);
  ev('pointerup', 600, 0, 0, 2);
});
s = structural(await getLog());
check('pen barrel in the air erases nothing: the erase spans landing to lift only',
  eq(s, ['contact true', 'begin pen erase 405,560 p=0.5', 'end commit (9 samples)', 'contact false']), s);

await sleep(700);
await clear();
await page.evaluate(() => window.__input.input.disablePenMode());
await touchDrag(100, 720, 250, 720, { steps: 6 });
await sleep(30);
s = structural(await getLog());
check('"Draw with fingers": after disablePenMode fingers draw again', s.includes('[penMode false]') && s.some(l => l === 'begin touch draw 100,720 p=NaN'), s);

await page.screenshot({ path: SHOT });
console.log(`screenshot: ${SHOT}`);
check('no page errors', errors.length === 0, errors);
await browser.close();

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
