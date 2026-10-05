/**
 * Rise UI: the whole chrome (DESIGN §1.2, §3.0, §3.4, §4, §10). It reads AppState, dispatches
 * Intents and listens to AppEvents only (app/types.ts), and renders mini canvases through the
 * Glyphs interface (render/types.ts). It never touches the document, scene or renderer.
 *
 * Calm by construction: 4 controls at rest, 0 while drawing, every conditional control fading in
 * its own fixed slot, all motion 160 ms cubic-bezier(.2,.8,.2,1) and nothing bouncing. An idle
 * page costs nothing: no rAF and no recurring timers (one-shot timers only).
 */
import '../styles.css';
import type { AppEvent, AppState, Intent, SheetId, Store } from '../app/types';
import type { Glyphs } from '../render/types';
import { createAnnouncer, createLiveRegion, type Announcer } from './announce';
import { createTip, type Tip } from './chip';
import { createDock, createFader, distToRect, layoutClass, MOUSE_NEAR, PEN_NEAR } from './dock';
import { createHelp } from './help';
import { createHints } from './hints';
import { createMenu } from './menu';
import { createSelectionBar } from './selectionbar';
import { createTileSheet, type SheetFrame } from './sheet';
import { createToaster } from './toast';
import { createViewChip } from './viewchip';

/** Responsive class (DESIGN §10). */
export type Layout = 'phone' | 'phone-landscape' | 'tablet' | 'desktop';

/** Browser chrome colour per ground (the --r-bg tokens in styles.css). */
const THEME_COLOR = { night: '#0c0e14', paper: '#f4f0e7' } as const;

/** Clamp to 0..1; NaN reads as 0. Pure. */
export function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/** What every UI module gets: the store seam plus shared chrome services. */
export interface UICtx {
  /** The chrome root (#chrome). */
  readonly root: HTMLElement;
  readonly glyphs: Glyphs;
  readonly announcer: Announcer;
  readonly tip: Tip;
  dispatch(i: Intent): void;
  state(): AppState;
  layout(): Layout;
  /** Device pixel ratio for glyph canvases (≤ 3). */
  dpr(): number;
}

/** Build the chrome inside `root` (the #chrome element). */
export function createUI(root: HTMLElement, store: Store, glyphs: Glyphs): { dispose(): void } {
  root.classList.add('r-chrome');
  root.replaceChildren();
  const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

  let layout: Layout = 'desktop';
  let dpr = Math.min(3, window.devicePixelRatio || 1);
  const coarseMq = window.matchMedia('(pointer: coarse)');
  const computeLayout = (): Layout => layoutClass(window.innerWidth, window.innerHeight, store.get().isTouch || coarseMq.matches);
  layout = computeLayout();
  root.dataset.layout = layout;

  const live = createLiveRegion(root);
  const announcer = createAnnouncer(live);
  const tip = createTip(root, () => layout);
  const ctx: UICtx = {
    root, glyphs, announcer, tip,
    dispatch: i => store.dispatch(i),
    state: () => store.get(),
    layout: () => layout,
    dpr: () => dpr,
  };

  // ---- parts
  const backdrop = document.createElement('div');
  backdrop.className = 'r-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('pointerdown', e => {
    e.preventDefault();
    tip.hide();
    store.dispatch({ k: 'openSheet', sheet: null });
  });
  backdrop.addEventListener('contextmenu', e => e.preventDefault());
  root.appendChild(backdrop);

  const view = createViewChip(ctx);
  const del = createSelectionBar(ctx);
  const dock = createDock(ctx, view, del);
  dock.place(layout);
  const hints = createHints(ctx, t => dock.chips[t].el, t => dock.chips[t].pulse());
  const sheets = {
    stroke: createTileSheet('stroke', ctx),
    color: createTileSheet('color', ctx),
    form: createTileSheet('form', ctx),
  };
  const menu = createMenu(ctx);
  const help = createHelp(ctx);
  const frames: Record<SheetId, SheetFrame> = {
    stroke: sheets.stroke.frame, color: sheets.color.frame, form: sheets.form.frame, menu: menu.frame, help: help.frame,
  };
  const toaster = createToaster(ctx);

  const replay = document.createElement('div');
  replay.className = 'r-replay';
  replay.hidden = true;
  replay.setAttribute('aria-hidden', 'true');
  const replayLine = document.createElement('div');
  replayLine.className = 'r-replay-line';
  replay.appendChild(replayLine);
  // Any input stops playback (DESIGN §8); catching it here keeps that first touch from drawing.
  replay.addEventListener('pointerdown', e => { e.preventDefault(); store.dispatch({ k: 'stopReplay' }); });
  root.appendChild(replay);

  // ---- chrome fade (contact / replay) with early return near the dock
  let px = -1e6, py = -1e6, ptype = '', pbuttons = 0, dockRect: DOMRect | null = null;
  const fader = createFader({
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: id => window.clearTimeout(id),
    apply: h => {
      root.classList.toggle('is-hidden', h);
      if (h) tip.hide();
      setTracking(h); // the pointer is tracked only while the chrome is away
    },
    nearDock: () => {
      if (!(ptype === 'mouse' || (ptype === 'pen' && pbuttons === 0))) return false;
      dockRect ??= dock.bar.getBoundingClientRect();
      return distToRect(px, py, dockRect) <= (ptype === 'pen' ? PEN_NEAR : MOUSE_NEAR);
    },
  });
  // Tracks the pointer only while the chrome is hidden or waiting; stores numbers, allocates nothing.
  const track = (e: PointerEvent): void => {
    px = e.clientX; py = e.clientY; ptype = e.pointerType; pbuttons = e.buttons;
    if (fader.waiting) fader.poke();
  };
  let tracking = false;
  function setTracking(on: boolean): void {
    if (on === tracking) return;
    tracking = on;
    const opts = { capture: true, passive: true } as const;
    if (on) {
      window.addEventListener('pointermove', track, opts);
      window.addEventListener('pointerup', track, opts);
    } else {
      window.removeEventListener('pointermove', track, opts);
      window.removeEventListener('pointerup', track, opts);
    }
  }

  // ---- sheets
  let openId: SheetId | null = null;
  const anchorFor = (id: SheetId): HTMLElement | null =>
    id === 'menu' ? dock.menuBtn : id === 'help' ? null : dock.chips[id].el;
  const syncInert = (s: AppState): void => {
    const f = openId ? frames[openId] : null;
    const docked = layout === 'phone' || layout === 'phone-landscape';
    const modal = !!f && (f.modal || docked);
    backdrop.hidden = !f;
    backdrop.dataset.modal = String(modal);
    // On phones every sheet covers the dock and makes it inert, so it is modal there too.
    if (f) f.el.setAttribute('aria-modal', String(modal));
    for (const part of dock.parts) {
      const inert = !!f && (modal || part !== dock.bar);
      part.inert = inert;
    }
    root.dataset.sheet = s.sheet ?? '';
  };
  const syncSheet = (s: AppState): void => {
    if (s.sheet === openId) return;
    const prevFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (openId) frames[openId].close();
    openId = s.sheet;
    if (openId) {
      tip.hide();
      const a = anchorFor(openId);
      // Help opened from the menu returns focus to the mark; opened by key, to wherever focus was.
      const back = openId !== 'help' ? a : prevFocus && frames.menu.el.contains(prevFocus) ? dock.menuBtn : prevFocus;
      frames[openId].open(a, back);
    }
    syncInert(s);
  };

  // ---- render
  let last: AppState | null = null;
  const render = (s: AppState, force: boolean): void => {
    const prev = force ? null : last;
    last = s;
    if (prev && prev.isTouch !== s.isTouch) onResize(); // the coarse-pointer flag feeds the layout class
    if (force || !prev || prev.ground !== s.ground) {
      root.dataset.ground = s.ground;
      themeMeta?.setAttribute('content', THEME_COLOR[s.ground]);
    }
    root.dataset.selection = String(s.selection.length > 0);
    root.dataset.erase = String(s.tool.mode === 'erase');
    root.dataset.reduced = String(s.reducedMotion);
    root.dataset.touch = String(s.isTouch);

    fader.replay(s.replaying);
    fader.contact(s.chromeHidden);
    if (s.chromeHidden) dockRect = null;
    replay.hidden = !s.replaying;
    if (s.replaying) replayLine.style.transform = `scaleX(${clamp01(s.replayProgress).toFixed(4)})`;

    dock.update(s, prev, force);
    view.update(s, prev, force);
    del.update(s, prev, force);
    sheets.stroke.update(s, prev, force);
    sheets.color.update(s, prev, force);
    sheets.form.update(s, prev, force);
    menu.update(s, prev, force);
    help.update(s, prev, force);
    syncSheet(s);
    hints.update(s, prev);
  };

  const onEvent = (e: AppEvent): void => {
    switch (e.k) {
      case 'toast': toaster.show(e); break;
      case 'toastClose': toaster.close(e.id); break;
      case 'announce': announcer.say(e.text); break;
      case 'pulse': hints.pulse(e.target); break;
      case 'hint': hints.show(e.id, e.text, e.at ?? null); break;
      case 'hintHide': hints.hide(e.id); break;
    }
  };

  // ---- layout / resize
  let resizeRaf = 0;
  const relayout = (): void => {
    resizeRaf = 0;
    const nl = computeLayout();
    const nd = Math.min(3, window.devicePixelRatio || 1);
    layout = nl; dpr = nd;
    root.dataset.layout = layout;
    dock.place(layout);
    dockRect = null;
    // Canvas boxes may have changed size even within a layout: re-render glyphs and open tiles.
    render(store.get(), true);
    syncInert(store.get()); // a sheet becomes modal when the layout turns into a phone
    if (openId) frames[openId].relayout();
  };
  const onResize = (): void => { if (!resizeRaf) resizeRaf = requestAnimationFrame(relayout); };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  coarseMq.addEventListener('change', onResize);

  const unsub = store.subscribe(s => render(s, false));
  const unon = store.on(onEvent);
  render(store.get(), true);

  return {
    dispose() {
      unsub(); unon();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      coarseMq.removeEventListener('change', onResize);
      setTracking(false);
      fader.dispose();
      announcer.dispose();
      toaster.dispose();
      hints.dispose();
      sheets.stroke.dispose(); sheets.color.dispose(); sheets.form.dispose();
      menu.dispose(); help.dispose();
      dock.dispose(); view.dispose(); del.dispose();
      tip.dispose();
      root.replaceChildren();
      root.classList.remove('r-chrome', 'is-hidden');
    },
  };
}
