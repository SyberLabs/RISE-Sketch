/**
 * The dock and the always-there chrome (DESIGN §1.2, §4, §10 Responsive): the menu mark, the three
 * primitive chips, Undo / Redo, and the slots the view chip and Delete occupy on each layout.
 *
 * Layouts:
 *  - desktop / tablet: menu top-left, Undo · Redo top-right, chips in a bottom-centre dock, view
 *    chip bottom-right, Delete just above the dock (or above the selection when its rect is known).
 *  - phone: one bottom bar `[view|Delete] · Stroke Color Form · Undo Redo`, the chips centred and the
 *    conditional slots on either side, so nothing moves when a conditional control appears.
 *  - phone-landscape: the same bar, vertical, on the trailing edge.
 *
 * Every slot is fixed: a conditional control fades in its own place, so a finger tapping Undo
 * repeatedly never chases it when Redo appears.
 */
import type { AppState } from '../app/types';
import { createChip, type Chip, type ChipKind } from './chip';
import { icon } from './icons';
import type { Layout, UICtx } from './index';
import type { ViewChip } from './viewchip';
import type { SelectionBar } from './selectionbar';

/** Interactive chrome controls counted by the budget (DESIGN §1.2). */
export type ControlId = 'menu' | 'stroke' | 'color' | 'form' | 'undo' | 'redo' | 'view' | 'delete';

/** Max visible controls per state (DESIGN §1.2): empty 4, with ink 5, selection 6, absolute 7. */
export const BUDGET = { empty: 4, ink: 5, selection: 6, max: 7 } as const;

/**
 * The controls a state shows, in focus order. Pure; the DOM follows it exactly, and the budget
 * tests run against it. `chromeHidden` / replay hide everything (Drawing: 0).
 */
export function visibleControls(s: AppState): ControlId[] {
  if (s.chromeHidden || s.replaying) return [];
  const out: ControlId[] = [];
  const sel = s.selection.length > 0;
  if (!sel) out.push('menu');
  out.push('stroke', 'color', 'form');
  if (s.canUndo) out.push('undo');
  if (s.canRedo) out.push('redo');
  if (sel) out.push('delete');
  else if (viewChipWanted(s)) out.push('view');
  return out;
}

/** Zoom as the whole percentage the view chip shows; a missing or bad zoom reads as 100. Pure. */
export function zoomPct(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? Math.round(zoom) : 100;
}

/** View chip rule (DESIGN §4): zoom ≠ 100 %, or the document has ink but none is in view. */
export function viewChipWanted(s: Pick<AppState, 'zoom' | 'hasInk' | 'inkInView'>): boolean {
  return zoomPct(s.zoom) !== 100 || (s.hasInk && !s.inkInView);
}

/**
 * Layout class (DESIGN §10 Responsive). Phone: width < 600, or a coarse pointer with a short side
 * < 500. Tablet: any other coarse pointer. Desktop: everything else (the spec's desktop is
 * ≥ 1100 px and fine; narrower fine-pointer windows also get the desktop layout, with sheets that
 * wrap — decision).
 */
export function layoutClass(w: number, h: number, coarse: boolean): Layout {
  const phone = w < 600 || (coarse && Math.min(w, h) < 500);
  if (phone) return w > h ? 'phone-landscape' : 'phone';
  return coarse ? 'tablet' : 'desktop';
}

export interface Dock {
  readonly chips: Readonly<Record<ChipKind, Chip>>;
  readonly menuBtn: HTMLButtonElement;
  /** Containers that fade with the chrome and go inert under a modal sheet. */
  readonly parts: readonly HTMLElement[];
  readonly bar: HTMLElement;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  /** Re-parent the conditional controls for a layout. */
  place(layout: Layout): void;
  dispose(): void;
}

function roundButton(cls: string, name: Parameters<typeof icon>[0], label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `r-btn ${cls}`;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(name, 20));
  return b;
}

/** Set a control's shown state (fades in place; hidden controls leave the tab order and a11y tree). */
export function setShown(el: HTMLElement, on: boolean): void {
  if (el.classList.contains('is-off') !== on) return;
  el.classList.toggle('is-off', !on);
}

export function createDock(ctx: UICtx, view: ViewChip, del: SelectionBar): Dock {
  const root = ctx.root;

  const menuBtn = roundButton('r-menu r-fade r-surface', 'mark', 'Menu');
  menuBtn.setAttribute('aria-haspopup', 'dialog');
  menuBtn.setAttribute('aria-expanded', 'false');
  const dot = document.createElement('span');
  dot.className = 'r-dot';
  dot.setAttribute('aria-hidden', 'true');
  menuBtn.appendChild(dot);
  menuBtn.addEventListener('click', () => {
    const s = ctx.state();
    ctx.dispatch({ k: 'openSheet', sheet: s.sheet === 'menu' ? null : 'menu' });
  });
  const untipMenu = ctx.tip.bind(menuBtn, () => (ctx.state().autosaveOk ? 'Menu' : 'Menu · not autosaving'));

  const bar = document.createElement('div');
  bar.className = 'r-dock r-fade r-surface';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Ink');
  const lead = document.createElement('div');
  lead.className = 'r-slot r-lead';
  const chipsBox = document.createElement('div');
  chipsBox.className = 'r-chips';
  const trail = document.createElement('div');
  trail.className = 'r-slot r-trail';
  bar.append(lead, chipsBox, trail);

  const chips: Record<ChipKind, Chip> = {
    stroke: createChip('stroke', ctx),
    color: createChip('color', ctx),
    form: createChip('form', ctx),
  };
  chipsBox.append(chips.stroke.el, chips.color.el, chips.form.el);

  const history = document.createElement('div');
  history.className = 'r-history r-fade';
  history.setAttribute('role', 'group');
  history.setAttribute('aria-label', 'History');
  const undoBtn = roundButton('r-undo r-surface', 'undo', 'Undo');
  const redoBtn = roundButton('r-redo r-surface', 'redo', 'Redo');
  undoBtn.addEventListener('click', () => ctx.dispatch({ k: 'undo' }));
  redoBtn.addEventListener('click', () => ctx.dispatch({ k: 'redo' }));
  const mod = (): string => (ctx.state().isMac ? '⌘' : 'Ctrl+');
  const untipUndo = ctx.tip.bind(undoBtn, () => `Undo · ${mod()}Z`);
  const untipRedo = ctx.tip.bind(redoBtn, () => (ctx.state().isMac ? 'Redo · ⇧⌘Z' : 'Redo · Ctrl+Shift+Z'));

  // Floating homes for the view chip and Delete on desktop / tablet.
  const viewHome = document.createElement('div');
  viewHome.className = 'r-viewhome r-fade';
  const delHome = document.createElement('div');
  delHome.className = 'r-delhome r-fade';

  // Focus order follows reading order: menu, chips, history, view, delete.
  root.append(menuBtn, bar, history, viewHome, delHome);
  let placed: Layout | null = null;

  const place = (layout: Layout): void => {
    if (layout === placed) return;
    placed = layout;
    const docked = layout === 'phone' || layout === 'phone-landscape';
    if (docked) {
      lead.append(view.el, del.el);
      trail.append(undoBtn, redoBtn);
    } else {
      history.append(undoBtn, redoBtn);
      viewHome.append(view.el);
      delHome.append(del.el);
    }
    bar.dataset.docked = String(docked);
  };

  return {
    chips,
    menuBtn,
    parts: [menuBtn, bar, history, viewHome, delHome],
    bar,
    update(s, prev, force) {
      // Same rules as visibleControls (contact / replay hiding is the chrome fader's job).
      const sel = s.selection.length > 0;
      setShown(menuBtn, !sel);
      setShown(undoBtn, s.canUndo);
      setShown(redoBtn, s.canRedo);
      setShown(view.el, !sel && viewChipWanted(s));
      setShown(del.el, sel);
      // A focused control that just hid (Undo emptied, Delete done, view reset) hands focus on
      // instead of dropping it to the page.
      const a = document.activeElement;
      if (a instanceof HTMLElement && root.contains(a) && a.closest('.is-off')) {
        [undoBtn, redoBtn, chips.stroke.el].find(b => !b.classList.contains('is-off'))?.focus({ preventScroll: true });
      }
      chips.stroke.update(s, prev, force);
      chips.color.update(s, prev, force);
      chips.form.update(s, prev, force);
      if (force || !prev || prev.autosaveOk !== s.autosaveOk) {
        dot.classList.toggle('is-on', !s.autosaveOk);
        menuBtn.setAttribute('aria-label', s.autosaveOk ? 'Menu' : 'Menu. Not autosaving');
      }
      menuBtn.setAttribute('aria-expanded', String(s.sheet === 'menu' || s.sheet === 'help'));
    },
    place,
    dispose() {
      untipMenu(); untipUndo(); untipRedo();
      chips.stroke.dispose(); chips.color.dispose(); chips.form.dispose();
      menuBtn.remove(); bar.remove(); history.remove(); viewHome.remove(); delHome.remove();
    },
  };
}

// ============================================================================ chrome fade

/** Chrome returns this long after the last contact lifts (DESIGN §4), so hatching never flickers it. */
export const RETURN_MS = 700;
/** Early return: a mouse within this distance of the dock (a hovering pen: PEN_NEAR) brings it back at once. */
export const MOUSE_NEAR = 80;
export const PEN_NEAR = 96;

export interface FaderDeps {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
  /** Apply the hidden state to the DOM. Called only on changes. */
  apply(hidden: boolean): void;
  /** Is the pointer near the dock right now (mouse, or a hovering pen)? */
  nearDock(): boolean;
}
export interface Fader {
  /** A contact is on the canvas (AppState.chromeHidden). */
  contact(on: boolean): void;
  replay(on: boolean): void;
  /** The pointer moved: early-return check while waiting. */
  poke(): void;
  readonly hidden: boolean;
  readonly waiting: boolean;
  dispose(): void;
}

/**
 * Chrome visibility (DESIGN §4): hidden at once on contact (the CSS fades it out in 90 ms, then
 * sets visibility: hidden so its blur costs nothing), back 700 ms after the last contact lifts
 * (220 ms fade), or at once when the pointer comes near the dock. Replay hides it outright.
 * Decision: the app reports raw contact in `chromeHidden`; the UI owns the 700 ms delay.
 */
export function createFader(d: FaderDeps): Fader {
  let contactOn = false, replayOn = false, timer = 0, waiting = false, hidden = false;
  const sync = (): void => {
    const h = contactOn || replayOn || waiting;
    if (h !== hidden) { hidden = h; d.apply(h); }
  };
  const stopWait = (): void => {
    if (timer) d.clear(timer);
    timer = 0;
    waiting = false;
  };
  return {
    contact(on) {
      if (on === contactOn) return;
      contactOn = on;
      stopWait();
      if (!on && !replayOn && !d.nearDock()) {
        waiting = true;
        timer = d.set(() => { timer = 0; waiting = false; sync(); }, RETURN_MS);
      }
      sync();
    },
    replay(on) {
      if (on === replayOn) return;
      replayOn = on;
      if (on) stopWait();
      sync();
    },
    poke() {
      if (waiting && d.nearDock()) { stopWait(); sync(); }
    },
    get hidden() { return hidden; },
    get waiting() { return waiting; },
    dispose() { stopWait(); },
  };
}

/** Distance from a point to a rect (0 inside). Pure. */
export function distToRect(x: number, y: number, r: { left: number; top: number; right: number; bottom: number }): number {
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return Math.sqrt(dx * dx + dy * dy);
}
