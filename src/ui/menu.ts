/**
 * The menu sheet (DESIGN §4): New · Open… · Save project · Export image · Share timelapse ·
 * Recent ▸ · Replay · Gestures & keys. Eight items, no settings. Recent drills into its own view inside the sheet.
 * The not-autosaving state shows on the mark (dot) and as a note on Save.
 */
import type { AppState, Intent } from '../app/types';
import { icon, type IconName } from './icons';
import type { UICtx } from './index';
import { createRecent } from './recent';
import { createSheetFrame, type SheetFrame } from './sheet';

export interface MenuItemSpec {
  key: 'new' | 'open' | 'save' | 'export' | 'timelapse' | 'recent' | 'replay' | 'help';
  label: string;
  icon: IconName;
  /** Shortcut hint (desktop only), or the Recent count. */
  kbd: string | null;
  /** null: drill into Recent. */
  intent: Intent | null;
  note: string | null;
  disabled: boolean;
}

/** The eight menu items for a state (pure). */
export function menuItems(s: AppState): MenuItemSpec[] {
  const mod = s.isMac ? '⌘' : 'Ctrl+';
  const keys = !s.isTouch;
  return [
    { key: 'new', label: 'New', icon: 'plus', kbd: null, intent: { k: 'new' }, note: null, disabled: false },
    { key: 'open', label: 'Open…', icon: 'open', kbd: keys ? `${mod}O` : null, intent: { k: 'openPicker' }, note: null, disabled: false },
    { key: 'save', label: 'Save project', icon: 'save', kbd: keys ? `${mod}S` : null, intent: { k: 'save' }, note: s.autosaveOk ? null : 'Not autosaving', disabled: false },
    { key: 'export', label: 'Export image', icon: 'image', kbd: keys ? `${mod}E` : null, intent: { k: 'exportPng' }, note: null, disabled: !s.hasInk || s.exporting },
    { key: 'timelapse', label: 'Share timelapse', icon: 'share', kbd: keys ? '⇧P' : null, intent: { k: 'timelapse' }, note: null, disabled: !s.hasInk || s.recording },
    { key: 'recent', label: 'Recent', icon: 'clock', kbd: s.recentDocs.length ? String(Math.min(12, s.recentDocs.length)) : null, intent: null, note: null, disabled: false },
    { key: 'replay', label: 'Replay', icon: 'play', kbd: keys ? 'P' : null, intent: { k: 'replay' }, note: null, disabled: !s.hasInk },
    { key: 'help', label: 'Gestures & keys', icon: 'keys', kbd: keys ? '?' : null, intent: { k: 'openSheet', sheet: 'help' }, note: null, disabled: false },
  ];
}

export interface Menu {
  readonly frame: SheetFrame;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  dispose(): void;
}

export function createMenu(ctx: UICtx): Menu {
  let view: 'main' | 'recent' = 'main';
  const frame = createSheetFrame(ctx, {
    kind: 'menu',
    label: 'Menu',
    modal: true,
    requestClose: () => {
      // Esc steps back out of Recent first, with focus on Recent so the next Esc reaches the sheet.
      if (view === 'recent') { backToMain(); return; }
      ctx.dispatch({ k: 'openSheet', sheet: null });
    },
    initialFocus: () => (view === 'main' ? buttons.new : null),
  });
  frame.el.dataset.sheet = 'menu';

  const main = document.createElement('div');
  main.className = 'r-menu-main';
  const title = document.createElement('p');
  title.className = 'r-doctitle';
  const list = document.createElement('div');
  list.className = 'r-items';
  main.append(title, list);

  const buttons = {} as Record<MenuItemSpec['key'], HTMLButtonElement>;
  const parts = {} as Record<MenuItemSpec['key'], { kbd: HTMLElement; note: HTMLElement }>;
  let specs = menuItems(ctx.state());
  for (const spec of specs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'r-item';
    b.dataset.key = spec.key;
    const lab = document.createElement('span');
    lab.className = 'r-item-label';
    const txt = document.createElement('span');
    txt.textContent = spec.label;
    const note = document.createElement('span');
    note.className = 'r-item-note';
    lab.append(txt, note);
    const kbd = document.createElement('span');
    kbd.className = 'r-kbd';
    kbd.setAttribute('aria-hidden', 'true');
    b.append(icon(spec.icon, 20), lab, kbd);
    if (spec.key === 'recent') {
      b.setAttribute('aria-haspopup', 'true');
      b.appendChild(icon('chevron', 16));
    }
    b.addEventListener('click', () => {
      const cur = specs.find(x => x.key === spec.key)!;
      if (cur.disabled) return;
      if (!cur.intent) { show('recent'); return; }
      ctx.dispatch(cur.intent); // synchronously, inside the click: Open… needs the user activation
      if (cur.intent.k !== 'openSheet') ctx.dispatch({ k: 'openSheet', sheet: null });
    });
    list.appendChild(b);
    buttons[spec.key] = b;
    parts[spec.key] = { kbd, note };
  }
  list.addEventListener('keydown', e => {
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>('.r-item:not(:disabled)'));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowDown') n = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n < 0) return;
    e.preventDefault();
    items[n].focus();
  });

  const backToMain = (): void => { show('main'); buttons.recent.focus({ preventScroll: true }); };
  const recent = createRecent(ctx, backToMain);
  frame.body.append(main, recent.el);

  function show(v: 'main' | 'recent'): void {
    view = v;
    main.hidden = v !== 'main';
    recent.el.hidden = v !== 'recent';
    frame.el.dataset.view = v;
    frame.el.setAttribute('aria-label', v === 'main' ? 'Menu' : 'Recent drawings');
    if (v === 'recent') { recent.update(ctx.state().recentDocs, true); recent.focusFirst(); }
    frame.relayout();
  }
  show('main');

  return {
    frame,
    update(s, prev, force) {
      if (prev && prev.sheet === 'menu' && s.sheet !== 'menu' && view !== 'main') show('main');
      if (force || !prev || prev.autosaveOk !== s.autosaveOk || prev.hasInk !== s.hasInk || prev.recentDocs !== s.recentDocs
        || prev.isTouch !== s.isTouch || prev.exporting !== s.exporting || prev.recording !== s.recording || prev.docTitle !== s.docTitle) {
        specs = menuItems(s);
        for (const spec of specs) {
          const b = buttons[spec.key];
          b.disabled = spec.disabled;
          parts[spec.key].kbd.textContent = spec.kbd ?? '';
          parts[spec.key].note.textContent = spec.note ?? '';
          b.setAttribute('aria-label', spec.label + (spec.note ? `. ${spec.note}` : '') + (spec.key === 'recent' && spec.kbd ? `, ${spec.kbd} drawings` : ''));
        }
        title.textContent = s.docTitle.trim() || 'Untitled';
        if (view === 'recent') recent.update(s.recentDocs, false);
      }
    },
    dispose() { recent.dispose(); frame.dispose(); },
  };
}
