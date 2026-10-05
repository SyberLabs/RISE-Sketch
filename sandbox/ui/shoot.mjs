// UI sandbox driver: screenshots every state on every layout, asserts the visible-control budget
// (DESIGN §1.2) and drives the chip / sheet / chrome interactions through real input events.
// Usage: start `npx vite --port 5186 --strictPort`, then `node sandbox/ui/shoot.mjs <outDir>`
// (UI_PORT=<port> to use another dev server port).
import { launch, sleep } from '../../scripts/harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'e2e-out/ui';
const ONLY = process.argv[3] || '';
mkdirSync(OUT, { recursive: true });
const BASE = `http://localhost:${process.env.UI_PORT || 5186}/sandbox/ui/index.html`;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, touch: false },
  phone: { width: 390, height: 844, touch: true },
  landscape: { width: 844, height: 390, touch: true },
  tablet: { width: 1180, height: 820, touch: true },
};

let failures = 0, passes = 0;
const check = (ok, msg) => {
  if (ok) { passes++; console.log('  ok   ' + msg); } else { failures++; console.log('  FAIL ' + msg); }
};

// [viewport, preset, query, expectations]
const SHOTS = [
  ['desktop', 'rest', '', { chrome: 4 }],
  ['desktop', 'ink', '', { chrome: 5 }],
  ['desktop', 'undo', '', { chrome: 6 }],
  ['desktop', 'zoom', '', { chrome: 6 }],
  ['desktop', 'max', '', { chrome: 7 }],
  ['desktop', 'selection', '', { chrome: 6 }],
  ['desktop', 'stroke', '', { radiosMax: 9, switches: 0 }],
  ['desktop', 'color', '', { radiosMax: 9, switches: 1 }],
  ['desktop', 'form', '', { radiosMax: 9, switches: 0 }],
  ['desktop', 'menu', '', {}],
  ['desktop', 'help', '', {}],
  ['desktop', 'toast', '', { chrome: 5, toast: 1 }],
  ['desktop', 'export', '', { toast: 1 }],
  ['desktop', 'erase', '', { chrome: 5 }],
  ['desktop', 'drawing', '', { chrome: 0 }],
  ['desktop', 'replay', '', { chrome: 0 }],
  ['desktop', 'hints', '', { chrome: 5 }],
  ['desktop', 'rest', 'ground=paper', { chrome: 4 }],
  ['desktop', 'max', 'ground=paper', { chrome: 7 }],
  ['desktop', 'color', 'ground=paper', { radiosMax: 9, switches: 1 }],
  ['desktop', 'selection', 'ground=paper', { chrome: 6 }],
  ['desktop', 'menu', 'ground=paper', {}],
  ['desktop', 'help', 'ground=paper&mac=1', {}],
  ['phone', 'rest', 'touch=1', { chrome: 4 }],
  ['phone', 'ink', 'touch=1', { chrome: 5 }],
  ['phone', 'max', 'touch=1', { chrome: 7 }],
  ['phone', 'selection', 'touch=1', { chrome: 6 }],
  ['phone', 'stroke', 'touch=1', { radiosMax: 9 }],
  ['phone', 'color', 'touch=1', { radiosMax: 9, switches: 1 }],
  ['phone', 'form', 'touch=1&ground=paper', { radiosMax: 9 }],
  ['phone', 'menu', 'touch=1', {}],
  ['phone', 'help', 'touch=1', {}],
  ['phone', 'toast', 'touch=1', { toast: 1 }],
  ['phone', 'zoom', 'touch=1&ground=paper', { chrome: 6 }],
  ['landscape', 'rest', 'touch=1', { chrome: 4 }],
  ['landscape', 'max', 'touch=1', { chrome: 7 }],
  ['landscape', 'color', 'touch=1', { radiosMax: 9, switches: 1 }],
  ['landscape', 'selection', 'touch=1&ground=paper', { chrome: 6 }],
  ['tablet', 'ink', 'touch=1', { chrome: 5 }],
  ['tablet', 'form', 'touch=1', { radiosMax: 9 }],
  ['tablet', 'max', 'touch=1&ground=paper', { chrome: 7 }],
];

async function open(browser, vp, preset, query) {
  const v = VIEWPORTS[vp];
  const page = await browser.newPage();
  await page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 2, hasTouch: v.touch, isMobile: v.touch });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}?s=${preset}${query ? '&' + query : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__ui);
  await sleep(450);
  return { page, errors };
}

async function shots(browser) {
  console.log('\n# states and budgets');
  for (const [vp, preset, query, exp] of SHOTS) {
    const name = `${vp}-${preset}${query.includes('paper') ? '-paper' : ''}${query.includes('mac') ? '-mac' : ''}`;
    if (ONLY && !name.includes(ONLY)) continue;
    const { page, errors } = await open(browser, vp, preset, query);
    if (preset === 'menu' && name.includes('desktop-menu') && !query.includes('paper')) {
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      await page.click('.r-item[data-key="recent"]');
      await sleep(250);
      await page.screenshot({ path: join(OUT, `${name}-recent.png`) });
    } else {
      await page.screenshot({ path: join(OUT, `${name}.png`) });
    }
    const c = await page.evaluate(() => window.__ui.count());
    const layout = await page.evaluate(() => document.getElementById('chrome').dataset.layout);
    if (exp.chrome !== undefined) check(c.chrome.length === exp.chrome, `${name} [${layout}]: ${c.chrome.length} chrome controls (want ${exp.chrome}) ${JSON.stringify(c.chrome.map(s => s.slice(0, 24)))}`);
    if (exp.radiosMax !== undefined) check(c.radios > 0 && c.radios <= exp.radiosMax, `${name}: ${c.radios} tiles (≤ ${exp.radiosMax})`);
    if (exp.switches !== undefined) check(c.switches === exp.switches, `${name}: ${c.switches} switch (want ${exp.switches})`);
    if (exp.toast !== undefined) check(c.toast.length === exp.toast, `${name}: ${c.toast.length} toast action (want ${exp.toast})`);
    check(c.chrome.length <= 7, `${name}: absolute max 7 (${c.chrome.length})`);
    check(errors.length === 0, `${name}: no page errors ${errors.join(' | ')}`);
    await page.close();
  }
}

const centre = async (page, sel) => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const last = page => page.evaluate(() => window.__ui.intents.slice(-1)[0] ?? null);
const intents = page => page.evaluate(() => window.__ui.intents.slice());

async function interactions(browser) {
  console.log('\n# interactions (desktop)');
  let { page, errors } = await open(browser, 'desktop', 'ink', '');
  const m = page.mouse;

  // tap opens the sheet
  let [x, y] = await centre(page, '.r-chip[data-chip="stroke"]');
  await m.click(x, y);
  await sleep(250);
  check((await page.evaluate(() => window.__ui.state().sheet)) === 'stroke', 'tap on Stroke chip opens the Stroke sheet');
  check(await page.$eval('.r-sheet[data-sheet="stroke"]', el => !el.hidden && el.dataset.state === 'open'), 'Stroke sheet is shown');
  // a tile tap picks and closes (no selection)
  [x, y] = await centre(page, '.r-tile[data-key="chisel"]');
  await m.click(x, y);
  await sleep(250);
  const s1 = await page.evaluate(() => window.__ui.state());
  check(s1.tool.nib === 'chisel' && s1.sheet === null, 'tile tap picks Chisel and closes the sheet');

  // drag past the dead zone bends depth and does not open the sheet
  await page.evaluate(() => { window.__ui.intents.length = 0; });
  [x, y] = await centre(page, '.r-chip[data-chip="form"]');
  await m.move(x, y); await m.down();
  for (let i = 1; i <= 10; i++) { await m.move(x, y - i * 9); await sleep(16); }
  await m.up();
  await sleep(100);
  let log = await intents(page);
  const endDepth = log.filter(i => i.k === 'bendDepth' && i.done).pop();
  check(!!endDepth && endDepth.delta === 2, `Form chip drag up 90 px (6 px dead zone) → bendDepth +2 done (${JSON.stringify(endDepth)})`);
  check(log.some(i => i.k === 'bendDepth' && !i.done), 'live bendDepth updates during the drag');
  check(!log.some(i => i.k === 'openSheet'), 'drag does not open the sheet');

  // a 4 px wobble is still a tap
  await page.evaluate(() => { window.__ui.intents.length = 0; });
  [x, y] = await centre(page, '.r-chip[data-chip="color"]');
  await m.move(x, y); await m.down(); await m.move(x + 3, y + 3); await m.up();
  await sleep(250);
  log = await intents(page);
  check(log.length === 1 && log[0].k === 'openSheet' && log[0].sheet === 'color', 'a 4 px wobble inside the dead zone is a tap');
  // backdrop closes the sheet
  await m.click(200, 300);
  await sleep(250);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'pressing the canvas outside a sheet closes it');

  // long-press shows the label and does not open
  await page.evaluate(() => { window.__ui.intents.length = 0; });
  [x, y] = await centre(page, '.r-chip[data-chip="form"]');
  await m.move(x, y); await m.down(); await sleep(650);
  const tipTxt = await page.$eval('.r-tip', el => (el.classList.contains('is-on') ? el.textContent : ''));
  await page.screenshot({ path: join(OUT, 'desktop-longpress.png') });
  await m.up(); await sleep(100);
  check(tipTxt === 'Form · drag ↕ to deepen', `long-press label: "${tipTxt}"`);
  check((await intents(page)).length === 0, 'long-press dispatches nothing');

  // hover tooltip after 600 ms
  [x, y] = await centre(page, '.r-chip[data-chip="stroke"]');
  await m.move(x - 200, y - 200); await m.move(x, y);
  await sleep(300);
  const early = await page.$eval('.r-tip', el => el.classList.contains('is-on'));
  await sleep(450);
  const hoverTxt = await page.$eval('.r-tip', el => (el.classList.contains('is-on') ? el.textContent : ''));
  await page.screenshot({ path: join(OUT, 'desktop-tooltip.png') });
  check(!early && hoverTxt.startsWith('Stroke · Chisel · B'), `tooltip after 600 ms: "${hoverTxt}"`);
  await m.move(700, 300);

  // keyboard: arrows bend; Enter opens; roving tiles; Enter picks; Esc closes and returns focus
  await page.evaluate(() => { window.__ui.intents.length = 0; document.querySelector('.r-chip[data-chip="color"]').focus(); });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  log = await intents(page);
  check(log[0]?.k === 'bendColor' && log[0].dh === 5 && log[0].done, 'ArrowRight on Color chip → hue +5° (done)');
  check(log[1]?.k === 'bendColor' && log[1].dL === 0.02, 'ArrowUp on Color chip → tone +0.02');
  await page.evaluate(() => document.querySelector('.r-chip[data-chip="form"]').focus());
  await page.keyboard.press('ArrowDown');
  check((await last(page))?.delta === -0.25, 'ArrowDown on Form chip → depth −¼');
  await page.keyboard.press('Enter');
  await sleep(250);
  let active = await page.evaluate(() => document.activeElement?.dataset.key);
  check(active === 'sprout', `Enter opens the Form sheet with focus on the checked tile (${active})`);
  await page.keyboard.press('ArrowRight');
  active = await page.evaluate(() => document.activeElement?.dataset.key);
  check(active === 'drift', `ArrowRight moves focus without choosing (${active})`);
  check((await page.evaluate(() => window.__ui.state().tool.form)) === 'sprout', 'moving focus does not change the Form');
  await page.keyboard.press('ArrowRight');
  active = await page.evaluate(() => document.activeElement?.dataset.key);
  check(active === 'line', `roving focus wraps (${active})`);
  await page.screenshot({ path: join(OUT, 'desktop-form-keyboard.png') });
  await page.keyboard.press('Escape');
  await sleep(250);
  active = await page.evaluate(() => document.activeElement?.dataset.chip);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null && active === 'form', `Esc closes and returns focus to the chip (${active})`);
  await page.keyboard.press('Enter');
  await sleep(200);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await sleep(250);
  const s2 = await page.evaluate(() => window.__ui.state());
  check(s2.tool.form === 'echo' && s2.sheet === null, `Enter on a focused tile picks it and closes (${s2.tool.form})`);
  const tabStops = await page.$$eval('.r-sheet[data-sheet="color"] [role="radio"]', els => els.filter(e => e.tabIndex === 0).length);
  check(tabStops === 1, `radiogroup has exactly one tab stop (${tabStops})`);

  // chrome fades on contact and returns 700 ms after release
  await m.move(700, 200);
  await page.evaluate(() => window.__ui.set({ chromeHidden: true }));
  await sleep(160);
  check((await page.evaluate(() => window.__ui.count().chrome.length)) === 0, 'contact hides every control');
  const hiddenVis = await page.$eval('.r-dock', el => getComputedStyle(el).visibility);
  check(hiddenVis === 'hidden', 'hidden chrome is visibility: hidden (blur costs nothing)');
  await page.evaluate(() => window.__ui.set({ chromeHidden: false }));
  await sleep(450);
  check((await page.evaluate(() => window.__ui.count().chrome.length)) === 0, 'still hidden 450 ms after release');
  await sleep(600);
  check((await page.evaluate(() => window.__ui.count().chrome.length)) === 5, 'back after 700 ms');
  // early return near the dock
  await page.evaluate(() => window.__ui.set({ chromeHidden: true }));
  await sleep(120);
  [x, y] = await centre(page, '.r-dock');
  await m.move(x + 40, y - 60);
  await page.evaluate(() => window.__ui.set({ chromeHidden: false }));
  await sleep(120);
  check((await page.evaluate(() => window.__ui.count().chrome.length)) === 5, 'mouse near the dock brings the chrome back at once');

  // undo / redo buttons and the toast action
  await page.evaluate(() => { window.__ui.intents.length = 0; });
  [x, y] = await centre(page, '.r-undo');
  await m.click(x, y);
  check((await last(page))?.k === 'undo', 'Undo button dispatches undo');
  await page.evaluate(() => window.__ui.emit({ k: 'toast', id: 't', text: 'Not autosaving', action: { label: 'Save', intent: { k: 'save' } } }));
  await sleep(250);
  [x, y] = await centre(page, '.r-toast-action');
  await m.click(x, y);
  await sleep(50);
  check((await last(page))?.k === 'save', 'toast action dispatches its intent');
  const live = await page.$eval('.r-live', el => el.textContent);
  check(live.trim().length > 0, `aria-live announced: "${live.trim()}"`);
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await page.close();

  console.log('\n# interactions (phone)');
  ({ page, errors } = await open(browser, 'phone', 'ink', 'touch=1'));
  const cdp = await page.createCDPSession();
  const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([px, py], id) => ({ x: px, y: py, id, radiusX: 4, radiusY: 4, force: 1 })) });
  [x, y] = await centre(page, '.r-chip[data-chip="color"]');
  await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []);
  await sleep(300);
  check((await page.evaluate(() => window.__ui.state().sheet)) === 'color', 'touch tap opens the Color bottom sheet');
  const sheetBox = await page.$eval('.r-sheet[data-sheet="color"]', el => { const r = el.getBoundingClientRect(); return { top: r.top, h: r.height, place: el.dataset.place }; });
  check(sheetBox.place === 'bottom' && sheetBox.h <= 844 * 0.46 + 1, `bottom sheet ≤ 46 % of the height (${Math.round(sheetBox.h)} px)`);
  const gy = sheetBox.top + 10;
  await touch('touchStart', [[195, gy]]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [[195, gy + i * 22]]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(300);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'swipe down closes the bottom sheet');
  // long-press on a chip shows its label on touch
  [x, y] = await centre(page, '.r-chip[data-chip="stroke"]');
  await touch('touchStart', [[x, y]]); await sleep(650);
  const tipPhone = await page.$eval('.r-tip', el => (el.classList.contains('is-on') ? el.textContent : ''));
  await page.screenshot({ path: join(OUT, 'phone-longpress.png') });
  await touch('touchEnd', []); await sleep(120);
  check(tipPhone === 'Stroke · drag ↕ to resize', `touch long-press label: "${tipPhone}"`);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'touch long-press does not open the sheet');
  // touch drag on the Stroke chip bends size
  await page.evaluate(() => { window.__ui.intents.length = 0; });
  await touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 9; i++) { await touch('touchMove', [[x, y - i * 7.5]]); await sleep(16); } // dead zone left at −7.5, so Δy = −60
  await touch('touchEnd', []);
  await sleep(100);
  const sz = (await intents(page)).filter(i => i.k === 'bendSize' && i.done).pop();
  check(!!sz && Math.abs(sz.factor - Math.pow(2, 60 / 60)) < 0.02, `touch drag up 60 px past the dead zone on Stroke → size ×2 (${sz && sz.factor.toFixed(3)})`);
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await page.close();
}

async function accessibility(browser) {
  console.log('\n# accessibility');
  for (const [vp, query, minTarget, minDock] of [['desktop', '', 44, 44], ['phone', 'touch=1', 44, 48], ['tablet', 'touch=1', 48, 48]]) {
    const { page } = await open(browser, vp, 'max', query);
    const r = await page.evaluate(() => {
      const out = { unnamed: [], small: [], dockSmall: [], chips: [] };
      document.querySelectorAll('#chrome button').forEach(b => {
        if (!b.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
        const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
        if (!name) out.unnamed.push(b.className);
        const rc = b.getBoundingClientRect();
        const m = Math.min(rc.width, rc.height);
        out.small.push([b.className.split(' ')[1] || b.className, Math.round(m)]);
        if (b.closest('.r-dock')) out.dockSmall.push(Math.round(m));
      });
      document.querySelectorAll('.r-chip').forEach(c => out.chips.push([c.getAttribute('aria-haspopup'), c.getAttribute('aria-expanded')]));
      return out;
    });
    check(r.unnamed.length === 0, `${vp}: every visible control has an accessible name ${r.unnamed.join(',')}`);
    const tooSmall = r.small.filter(([, m]) => m < minTarget);
    check(tooSmall.length === 0, `${vp}: targets ≥ ${minTarget} px ${JSON.stringify(tooSmall)}`);
    check(r.dockSmall.every(m => m >= minDock), `${vp}: dock targets ≥ ${minDock} px (${r.dockSmall.join(',')})`);
    check(r.chips.every(([p, e]) => p === 'dialog' && (e === 'true' || e === 'false')), `${vp}: chips expose aria-haspopup and aria-expanded`);
    await page.close();
  }
  const { page } = await open(browser, 'desktop', 'ink', '');
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const rm = await page.evaluate(async () => {
    window.__ui.set({ chromeHidden: true });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const d = getComputedStyle(document.querySelector('.r-dock'));
    return d.opacity + ' ' + d.visibility;
  });
  check(rm === '0 hidden', `reduced motion: the chrome hides instantly (${rm})`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await page.evaluate(() => window.__ui.preset('color'));
  await sleep(300);
  await page.screenshot({ path: join(OUT, 'desktop-forced-colors.png') });
  const fc = await page.$eval('.r-tile.is-checked .r-well', el => getComputedStyle(el).outlineStyle);
  check(fc === 'solid', `forced colours: the selected tile keeps a visible outline (${fc})`);
  await page.close();
}

// Regressions found in review: focus, swipe, fade-out input, erase-mode chip, modality, scrolling.
async function regressions(browser) {
  console.log('\n# regressions');
  let { page, errors } = await open(browser, 'desktop', 'menu', '');
  // Deleting a Recent drawing with a synchronous store keeps focus on the neighbouring row.
  await page.click('.r-item[data-key="recent"]');
  await sleep(200);
  await page.click('.r-row[data-id="doc1"] .r-row-del');
  check((await page.evaluate(() => document.activeElement?.textContent)) === 'Keep', 'Recent delete asks first, with focus on Keep');
  await page.click('.r-row[data-id="doc1"] .r-textbtn.is-danger');
  await sleep(50);
  let f = await page.evaluate(() => ({ cls: document.activeElement?.className, id: document.activeElement?.closest?.('.r-row')?.dataset.id }));
  check(f.cls === 'r-row-open' && f.id === 'doc2', `after a delete, focus moves to the next row (${JSON.stringify(f)})`);
  // Deleting the last remaining row moves focus to Back, never to <body>.
  await page.evaluate(() => window.__ui.set({ recentDocs: window.__ui.state().recentDocs.slice(0, 1) }));
  await sleep(50);
  await page.click('.r-row .r-row-del');
  await page.click('.r-row .r-textbtn.is-danger');
  await sleep(50);
  f = await page.evaluate(() => document.activeElement?.className ?? '');
  check(f.includes('r-back'), `deleting the only row focuses Back (${f})`);
  // Esc steps out of Recent with focus on Recent; the next Esc closes the menu.
  await page.keyboard.press('Escape');
  await sleep(50);
  f = await page.evaluate(() => ({ key: document.activeElement?.dataset?.key, view: document.querySelector('.r-sheet[data-sheet="menu"]').dataset.view }));
  check(f.view === 'main' && f.key === 'recent', `Esc in Recent returns to the menu, focus on Recent (${JSON.stringify(f)})`);
  await page.keyboard.press('Escape');
  await sleep(250);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'a second Esc closes the menu');
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await page.close();

  ({ page, errors } = await open(browser, 'desktop', 'ink', ''));
  // No control takes input from the first frame of contact (not only after the 90 ms fade).
  let [x, y] = await centre(page, '.r-chip[data-chip="form"]');
  await page.evaluate(() => { window.__ui.intents.length = 0; window.__ui.set({ chromeHidden: true }); });
  await page.mouse.click(x, y);
  check((await intents(page)).length === 0, 'a click during the fade-out does nothing');
  await page.evaluate(() => window.__ui.set({ chromeHidden: false }));
  await sleep(1000);
  // Erase mode: the Stroke chip bends nothing by keyboard either, and its long-press names the return.
  await page.evaluate(() => { window.__ui.tool({ mode: 'erase' }); window.__ui.intents.length = 0; document.querySelector('.r-chip[data-chip="stroke"]').focus(); });
  await page.keyboard.press('ArrowUp');
  check((await intents(page)).length === 0, 'erase mode: ArrowUp on the Stroke chip bends nothing');
  check((await page.$eval('.r-chip[data-chip="stroke"]', el => el.hasAttribute('aria-haspopup'))) === false, 'erase mode: the Stroke chip does not claim a popup');
  [x, y] = await centre(page, '.r-chip[data-chip="stroke"]');
  await page.mouse.move(x, y); await page.mouse.down(); await sleep(650);
  const tip = await page.$eval('.r-tip', el => (el.classList.contains('is-on') ? el.textContent : ''));
  await page.mouse.up(); await sleep(100);
  check(tip === 'Erase · tap to return', `erase mode long-press label: "${tip}"`);
  check((await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? 'none')) !== '#f4f0e7', 'theme colour follows Night');
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await page.close();

  console.log('\n# regressions (phone)');
  ({ page, errors } = await open(browser, 'phone', 'color', 'touch=1'));
  const cdp = await page.createCDPSession();
  const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([px, py], id) => ({ x: px, y: py, id, radiusX: 4, radiusY: 4, force: 1 })) });
  const swipe = async (sx, sy, dx = 0, dy = 22) => {
    await touch('touchStart', [[sx, sy]]);
    for (let i = 1; i <= 9; i++) { await touch('touchMove', [[sx + i * dx, sy + i * dy]]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(300);
  };
  check((await page.$eval('.r-sheet[data-sheet="color"]', el => el.getAttribute('aria-modal'))) === 'true', 'phone: a chip sheet is aria-modal (it covers the dock)');
  // Swipe down from a gap between tiles (the browser must not claim the pan).
  const gap = await page.evaluate(() => {
    const g = document.querySelector('.r-sheet[data-sheet="color"] .r-tiles');
    const r = g.getBoundingClientRect();
    for (let yy = r.top + 2; yy < r.bottom; yy += 2) for (let xx = r.left + 1; xx < r.right; xx += 2) {
      if (document.elementFromPoint(xx, yy) === g) return [xx, yy];
    }
    return null;
  });
  check(!!gap, `found a gap between tiles ${JSON.stringify(gap)}`);
  if (gap) { await swipe(gap[0], gap[1]); check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'swipe down from a gap between tiles closes the sheet'); }
  // Swipe down from a menu item closes the (non-scrolling) menu.
  await page.evaluate(() => window.__ui.preset('menu'));
  await sleep(400);
  [x, y] = await centre(page, '.r-item[data-key="save"]');
  await swipe(x, y);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'swipe down from a menu item closes the menu');
  // Help overflows on a short phone: its body scrolls, and a scroll is not a swipe.
  await page.setViewport({ width: 390, height: 600, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await sleep(200);
  await page.evaluate(() => window.__ui.preset('help'));
  await sleep(400);
  const scrollable = await page.$eval('.r-sheet[data-sheet="help"] .r-sheet-body', el => el.classList.contains('is-scrollable') && getComputedStyle(el).touchAction);
  check(scrollable === 'pan-y', `phone help body scrolls (touch-action ${scrollable})`);
  const [hx, hy] = await centre(page, '.r-sheet[data-sheet="help"] .r-grammar');
  await swipe(hx, hy, 0, -24);
  const top = await page.$eval('.r-sheet[data-sheet="help"] .r-sheet-body', el => el.scrollTop);
  check(top > 0 && (await page.evaluate(() => window.__ui.state().sheet)) === 'help', `dragging up scrolls the help (scrollTop ${top})`);
  await page.screenshot({ path: join(OUT, 'phone-help-scrolled.png') });
  const [gx, gy] = await page.$eval('.r-sheet[data-sheet="help"] .r-grab', el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await swipe(gx, gy);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'the grab bar still swipes a scrolling sheet closed');
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await page.close();

  // Phone landscape: the side sheet swipes toward the trailing edge.
  ({ page, errors } = await open(browser, 'landscape', 'form', 'touch=1'));
  const cdp2 = await page.createCDPSession();
  const t2 = async (type, pts) => cdp2.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([px, py], id) => ({ x: px, y: py, id, radiusX: 4, radiusY: 4, force: 1 })) });
  [x, y] = await centre(page, '.r-tile[data-key="line"]');
  await t2('touchStart', [[x, y]]);
  for (let i = 1; i <= 9; i++) { await t2('touchMove', [[x + i * 20, y]]); await sleep(16); }
  await t2('touchEnd', []);
  await sleep(300);
  check((await page.evaluate(() => window.__ui.state().sheet)) === null, 'landscape: swipe right closes the side sheet');
  check((await page.evaluate(() => window.__ui.state().tool.form)) === 'sprout', 'landscape: the swipe did not pick the tile under it');
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await page.close();
}

const { browser } = await launch({ url: 'about:blank' });
try {
  await shots(browser);
  if (!ONLY) await interactions(browser);
  if (!ONLY) await accessibility(browser);
  if (!ONLY || ONLY === 'regressions') await regressions(browser);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
