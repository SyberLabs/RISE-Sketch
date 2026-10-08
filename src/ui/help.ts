/**
 * The help sheet, "Gestures & keys" (DESIGN §3.3, §4, §5): the Ink Grammar in one line, then
 * Keys (desktop) or Gestures (touch / pen device), with key labels from
 * `navigator.keyboard.getLayoutMap()` where it exists, and Reset calibration.
 */
import type { AppState } from '../app/types';
import { icon } from './icons';
import type { UICtx } from './index';
import { createSheetFrame, type SheetFrame } from './sheet';

/** DESIGN §3.3, printed verbatim as one line. */
export const INK_GRAMMAR: readonly (readonly [string, string])[] = [
  ['Speed', 'wildness'], ['Pressure', 'weight & opening'], ['Hold', 'rise'],
  ['Lean', 'direction'], ['Zoom', 'scale'], ['Nearby ink', 'awareness'],
];
/** "Speed = wildness · Pressure = weight & opening · …" */
export const grammarLine = (): string => INK_GRAMMAR.map(([a, b]) => `${a} = ${b}`).join(' · ');

const FALLBACK: Readonly<Record<string, string>> = {
  BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=', Slash: '/', Backquote: '`',
  Space: 'Space', Escape: 'Esc', Delete: 'Del', Backspace: '⌫',
};

/**
 * Label of a physical key (`e.code`) on the user's layout. Letters are upper-cased; keys the
 * layout map does not know fall back to US labels. Pure.
 */
export function keyLabel(code: string, map?: ReadonlyMap<string, string> | null): string {
  const v = map?.get(code);
  if (v) {
    if (v === '-') return '−';
    // Keycaps are upper case, but only when that stays one character ("ß" would become "SS").
    const u = v.toUpperCase();
    return [...u].length === 1 ? u : v;
  }
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return FALLBACK[code] ?? code;
}

/** One row: keys (rendered as keycaps) or, when `plain`, gesture names (rendered as words). */
export interface HelpRow { keys: readonly string[]; action: string; plain?: boolean }

/** The key map (DESIGN §5) as display rows, labelled for the platform and layout. Pure. */
export function keyRows(isMac: boolean, L: (code: string) => string): HelpRow[] {
  const mod = isMac ? '⌘' : 'Ctrl+';
  const sh = isMac ? '⇧' : 'Shift+';
  const alt = isMac ? '⌥' : 'Alt+';
  return [
    { keys: [`${L('Digit1')}–${L('Digit4')}`], action: 'Form: Line, Echo, Sprout, Drift' },
    { keys: [`${L('Digit5')}–${L('Digit9')}`, L('Digit0')], action: 'Form: Craze, Plume, Caustic, Burin, Plait / Orbit' },
    { keys: [L('KeyB'), `${sh}${L('KeyB')}`], action: 'Next / previous nib' },
    { keys: [L('KeyC'), `${sh}${L('KeyC')}`], action: 'Next / previous ink' },
    { keys: [L('KeyG')], action: 'Night / Paper' },
    { keys: [L('KeyE')], action: 'Erase mode' },
    { keys: [L('BracketLeft'), L('BracketRight')], action: 'Size smaller / larger' },
    { keys: [L('Minus'), L('Equal')], action: 'Depth shallower / deeper' },
    { keys: [L('KeyR')], action: 'Reseed the selection, else the last stroke' },
    { keys: [L('KeyM'), `${sh}${L('KeyM')}`], action: 'Symmetry on / off (centred on the view) · more folds' },
    { keys: isMac ? [`${mod}${L('KeyZ')}`, `${sh}${mod}${L('KeyZ')}`] : [`${mod}${L('KeyZ')}`, `${mod}${L('KeyY')}`], action: 'Undo / redo' },
    { keys: [`${mod}click`, `${mod}drag`], action: `Select · lasso (${isMac ? '⇧' : 'Shift'} adds)` },
    { keys: [`${mod}${L('KeyA')}`], action: 'Select all' },
    { keys: [isMac ? '⌫' : 'Del'], action: 'Delete the selection' },
    { keys: ['Esc'], action: 'Deselect · close · leave a mode' },
    { keys: [`${alt}click`], action: 'Sample a colour from the ink' },
    { keys: ['Right-drag'], action: 'Erase' },
    { keys: ['Space-drag'], action: 'Pan' },
    { keys: ['Wheel', 'Pinch'], action: 'Zoom (a trackpad scroll pans)' },
    { keys: [`${sh}${L('Digit1')}`, `${sh}${L('Digit0')}`], action: 'Fit the drawing / 100%' },
    { keys: [L('KeyP')], action: 'Replay' },
    { keys: [`${mod}${L('KeyS')}`, `${mod}${L('KeyO')}`, `${mod}${L('KeyE')}`], action: 'Save · open · export image' },
    { keys: ['?'], action: 'This sheet' },
  ];
}

/** Gestures for touch-only devices, or for a pen device (pen mode). Pure. */
export function gestureRows(penMode: boolean): HelpRow[] {
  if (penMode) {
    return [
      { keys: ['Pen'], action: 'Draw · ease off during a hold to settle', plain: true },
      { keys: ['Eraser end', 'Barrel button'], action: 'Erase', plain: true },
      { keys: ['One finger'], action: 'Pan', plain: true },
      { keys: ['Two fingers'], action: 'Pan and zoom', plain: true },
      { keys: ['Finger tap on ink'], action: 'Select · tap more to add', plain: true },
      { keys: ['Finger hold, then drag'], action: 'Lasso', plain: true },
      { keys: ['Two-finger tap'], action: 'Undo', plain: true },
    ];
  }
  return [
    { keys: ['One finger'], action: 'Draw', plain: true },
    { keys: ['Two fingers'], action: 'Pan and zoom', plain: true },
    { keys: ['Two-finger tap'], action: 'Undo', plain: true },
    { keys: ['Double-tap ink'], action: 'Select · then drag to lasso', plain: true },
    { keys: ['Double-tap the canvas'], action: 'Deselect', plain: true },
    { keys: ['Stroke → Erase'], action: 'Erase whole strokes', plain: true },
  ];
}

/** Drawing gestures shared by every device. */
const DRAWING: readonly HelpRow[] = [
  { keys: ['Hold still'], action: 'Rise: the ink pools and grows deeper', plain: true },
  { keys: ['Tap'], action: 'A seed; hold before moving to bloom', plain: true },
  { keys: ['Close a loop'], action: 'The ends weld; Echo becomes a snowflake', plain: true },
  { keys: ['Chips'], action: 'Tap a kind · drag an amount', plain: true },
  { keys: ['Form → Symmetry'], action: 'Mirror or kaleidoscope · drag the switch for folds', plain: true },
];

type LayoutMap = ReadonlyMap<string, string>;
interface KeyboardWithLayout { getLayoutMap?: () => Promise<LayoutMap> }

export interface Help {
  readonly frame: SheetFrame;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  dispose(): void;
}

export function createHelp(ctx: UICtx): Help {
  const frame = createSheetFrame(ctx, {
    kind: 'full',
    label: 'Gestures and keys',
    modal: true,
    requestClose: () => ctx.dispatch({ k: 'openSheet', sheet: null }),
    onShow: () => { if (!layoutAsked) askLayout(); },
    initialFocus: () => close,
  });
  frame.el.dataset.sheet = 'help';

  const head = document.createElement('div');
  head.className = 'r-subhead';
  const h = document.createElement('h2');
  h.className = 'r-subtitle';
  h.textContent = 'Gestures & keys';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'r-btn r-close';
  close.setAttribute('aria-label', 'Close');
  close.appendChild(icon('close', 20));
  close.addEventListener('click', () => ctx.dispatch({ k: 'openSheet', sheet: null }));
  head.append(h, close);

  const scroll = document.createElement('div');
  scroll.className = 'r-help r-scroll';
  const grammar = document.createElement('p');
  grammar.className = 'r-grammar';
  grammar.setAttribute('aria-label', grammarLine());
  // Each pair keeps its trailing separator, so a line never starts with "·".
  INK_GRAMMAR.forEach(([a, b], i) => {
    const span = document.createElement('span');
    span.className = 'r-gram';
    const k = document.createElement('b');
    k.textContent = a;
    span.append(k, ` = ${b}${i < INK_GRAMMAR.length - 1 ? ' ·' : ''}`);
    grammar.append(span);
    if (i < INK_GRAMMAR.length - 1) grammar.append(' ');
  });
  const grammarNote = document.createElement('p');
  grammarNote.className = 'r-note';
  grammarNote.textContent = 'Rise learns your lightest and heaviest touch, your speed and your hand’s tremor, then holds still.';

  const drawH = document.createElement('h3');
  drawH.textContent = 'Drawing';
  const drawList = document.createElement('dl');
  drawList.className = 'r-keys is-plain';
  const mapH = document.createElement('h3');
  const mapList = document.createElement('dl');
  mapList.className = 'r-keys is-cols';

  const calib = document.createElement('div');
  calib.className = 'r-calib';
  const calibText = document.createElement('p');
  calibText.className = 'r-note';
  calibText.textContent = 'If the ink feels off after a change of pen or hand, start the learning again.';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'r-textbtn is-outline';
  reset.append(icon('reset', 18), 'Reset calibration');
  let resetTimer = 0;
  reset.addEventListener('click', () => {
    ctx.dispatch({ k: 'resetCalibration' });
    ctx.announcer.say('Calibration reset');
    reset.disabled = true;
    reset.lastChild!.textContent = 'Calibration reset';
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => { reset.disabled = false; reset.lastChild!.textContent = 'Reset calibration'; }, 2400);
  });
  calib.append(calibText, reset);

  scroll.append(grammar, grammarNote, drawH, drawList, mapH, mapList, calib);
  frame.body.append(head, scroll);

  let layoutMap: LayoutMap | null = null;
  let layoutAsked = false;
  const askLayout = (): void => {
    layoutAsked = true;
    const kb = (navigator as Navigator & { keyboard?: KeyboardWithLayout }).keyboard;
    kb?.getLayoutMap?.().then(m => { layoutMap = m; renderRows(ctx.state()); }).catch(() => { /* not allowed here */ });
  };

  const fill = (dl: HTMLElement, rows: readonly HelpRow[]): void => {
    dl.replaceChildren();
    for (const r of rows) {
      const dt = document.createElement('dt');
      r.keys.forEach((k, i) => {
        if (i) dt.append(r.plain ? ' · ' : ' ');
        const el = document.createElement(r.plain ? 'span' : 'kbd');
        if (r.plain) el.className = 'r-gest';
        el.textContent = k;
        dt.append(el);
      });
      const dd = document.createElement('dd');
      dd.textContent = r.action;
      const row = document.createElement('div');
      row.className = 'r-keyrow';
      row.append(dt, dd);
      dl.append(row);
    }
  };
  const renderRows = (s: AppState): void => {
    fill(drawList, DRAWING);
    // Keys on desktop (a desktop pen tablet included: it has a keyboard and no fingers on the
    // canvas); gestures on touch devices, the pen-mode set when a pen has been seen there.
    const touch = s.isTouch;
    mapH.textContent = touch ? 'Gestures' : 'Keys';
    mapList.classList.toggle('is-plain', touch);
    mapList.classList.toggle('is-cols', !touch);
    fill(mapList, touch ? gestureRows(s.penMode) : keyRows(s.isMac, code => keyLabel(code, layoutMap)));
  };
  renderRows(ctx.state());

  return {
    frame,
    update(s, prev, force) {
      if (force || !prev || prev.isTouch !== s.isTouch || prev.penMode !== s.penMode || prev.isMac !== s.isMac) renderRows(s);
    },
    dispose() { window.clearTimeout(resetTimer); frame.dispose(); },
  };
}
