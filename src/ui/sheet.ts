/**
 * Sheets (DESIGN §3.4, §4, §10): dialogs that grow out of their chip (scale .96 → 1 plus a fade,
 * 160 ms, cubic-bezier(.2,.8,.2,1), nothing bounces).
 *
 *  - `createSheetFrame`: the dialog shell shared by every sheet: placement per layout (popover
 *    above the dock, under the menu mark, centred, phone bottom sheet, landscape side sheet),
 *    focus trap, Esc, focus return, swipe-to-close on phones.
 *  - `createTileSheet`: the Stroke / Color / Form sheets: labelled tiles of the user's last
 *    stroke (rendered by `glyphs.tile`) in a radiogroup with roving tabindex, the active nib
 *    tile's size drag, and the Night | Paper switch.
 *
 * Decisions: without a selection, choosing a tile closes its sheet (the next touch draws); with a
 * selection the sheet stays open so restyles can be compared. The ground switch never closes.
 */
import { INK_ORDER, P0_FORMS, P0_NIBS } from '../core/types';
import type { ColorStyle } from '../core/types';
import type { AppState, Intent, SheetId } from '../app/types';
import type { TileOption } from '../render/types';
import { bindPress, fitCanvas, FORM_NAMES, INK_NAMES, NIB_NAMES, sizeFactor, fmtSize, type ChipKind } from './chip';
import type { Layout, UICtx } from './index';

export const SHEET_MS = 160;

// ============================================================================ frame

export type FrameKind = 'chip' | 'menu' | 'full';

export interface FrameOpts {
  kind: FrameKind;
  label: string;
  /** Modal sheets make the rest of the chrome inert (menu, help; every sheet on phones). */
  modal: boolean;
  /** Ask the app to close (Esc, swipe). The frame closes when the state says so. */
  requestClose(): void;
  /** Shown and laid out: render content that needs its size. */
  onShow?(): void;
  /** Element to focus on open (default: first focusable). */
  initialFocus?(): HTMLElement | null;
}

export interface SheetFrame {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly kind: FrameKind;
  readonly modal: boolean;
  readonly isOpen: boolean;
  /** Open, placed against `anchor`; focus returns to `returnTo` (default: the anchor) on close. */
  open(anchor: HTMLElement | null, returnTo?: HTMLElement | null): void;
  close(): void;
  /** Re-place after a resize / layout change. */
  relayout(): void;
  dispose(): void;
}

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [href], input, [tabindex="0"]';

/** Focusable, visible descendants in DOM order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>(FOCUSABLE).forEach(el => {
    if (el.closest('[hidden]') || el.closest('.is-off')) return;
    out.push(el);
  });
  return out;
}

/** Placement mode of a sheet on a layout (pure). */
export function placement(layout: Layout, kind: FrameKind): 'bottom' | 'side' | 'pop-dock' | 'pop-menu' | 'center' {
  if (layout === 'phone') return 'bottom';
  if (layout === 'phone-landscape') return 'side';
  return kind === 'chip' ? 'pop-dock' : kind === 'menu' ? 'pop-menu' : 'center';
}

/** Should a swipe of (dx, dy) px after `ms` close a sheet of extent `size` along its close axis? Pure. */
export function swipeCloses(d: number, ms: number, size: number): boolean {
  if (d <= 0) return false;
  return d > Math.max(56, size * 0.25) || (d > 16 && d / Math.max(1, ms) > 0.6);
}

export function createSheetFrame(ctx: UICtx, opts: FrameOpts): SheetFrame {
  const el = document.createElement('div');
  el.className = 'r-sheet r-surface';
  el.dataset.kind = opts.kind;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', opts.label);
  el.setAttribute('aria-modal', String(opts.modal));
  el.hidden = true;
  const grab = document.createElement('div');
  grab.className = 'r-grab';
  grab.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'r-sheet-body';
  el.append(grab, body);
  ctx.root.appendChild(el);

  let open = false;
  let anchor: HTMLElement | null = null;
  let back: HTMLElement | null = null;
  let hideTimer = 0;
  let mode: ReturnType<typeof placement> = 'center';

  const place = (): void => {
    mode = placement(ctx.layout(), opts.kind);
    el.dataset.place = mode;
    el.style.left = el.style.top = el.style.bottom = el.style.right = '';
    el.style.transformOrigin = '';
    // Bottom / side sheets let the browser pan only when their content really scrolls: a pan-y
    // body makes the browser claim every vertical drag (pointercancel), which would kill the
    // swipe-to-close everywhere except the grab bar. Chip sheets fit, so they swipe anywhere.
    body.classList.toggle('is-scrollable', (mode === 'bottom' || mode === 'side') && body.scrollHeight > body.clientHeight + 1);
    if (mode === 'pop-dock' || mode === 'pop-menu') {
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = el.offsetWidth;
      const ar = anchor?.getBoundingClientRect() ?? null;
      if (mode === 'pop-dock') {
        const dock = ctx.root.querySelector('.r-dock')?.getBoundingClientRect();
        const cx = ar ? ar.left + ar.width / 2 : vw / 2;
        const left = Math.max(12, Math.min(vw - w - 12, cx - w / 2));
        const bottom = vh - (dock ? dock.top : vh - 88) + 12;
        el.style.left = `${Math.round(left)}px`;
        el.style.bottom = `${Math.round(bottom)}px`;
        el.style.transformOrigin = `${Math.round(cx - left)}px 100%`;
      } else {
        const left = ar ? Math.max(12, ar.left) : 16;
        const top = ar ? ar.bottom + 10 : 72;
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
        el.style.transformOrigin = ar ? `${Math.round(ar.left + ar.width / 2 - left)}px 0` : '0 0';
      }
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      opts.requestClose();
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables(el);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const a = document.activeElement;
      if (e.shiftKey && (a === first || !el.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !el.contains(a))) { e.preventDefault(); first.focus(); }
    }
    // Keep single-key shortcuts from reaching the canvas key map while a sheet has focus
    // (DESIGN §5); Mod combinations (undo, save…) still pass.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  };
  el.addEventListener('keydown', onKey);

  // ---- swipe to close (bottom: down; side: toward the trailing edge)
  let sid = -1, sx = 0, sy = 0, st = 0, sd = 0, swiping = false;
  /** Is any scroller between `t` and the sheet scrolled away from its top? */
  const scrolledAbove = (t: Element | null): boolean => {
    for (let n = t; n && n !== el; n = n.parentElement) if (n.scrollTop > 0) return true;
    return false;
  };
  const sdown = (e: PointerEvent): void => {
    if ((mode !== 'bottom' && mode !== 'side') || sid !== -1 || !e.isPrimary) return;
    const t = e.target as Element;
    if (t.closest('.r-noswipe')) return;
    sid = e.pointerId; sx = e.clientX; sy = e.clientY; st = e.timeStamp; sd = 0; swiping = false;
  };
  const smove = (e: PointerEvent): void => {
    if (e.pointerId !== sid) return;
    const along = mode === 'bottom' ? e.clientY - sy : e.clientX - sx;
    const across = mode === 'bottom' ? e.clientX - sx : e.clientY - sy;
    if (!swiping) {
      if (Math.abs(along) < 8 || Math.abs(along) < 1.2 * Math.abs(across)) return;
      if (along < 0) { sid = -1; return; }
      if (mode === 'bottom' && scrolledAbove(e.target as Element)) { sid = -1; return; } // the drag scrolls back up
      swiping = true;
      try { el.setPointerCapture(sid); } catch { /* ignore */ }
      el.dataset.drag = 'true';
    }
    sd = Math.max(0, along);
    el.style.transform = mode === 'bottom' ? `translateY(${sd}px)` : `translateX(${sd}px)`;
  };
  const swipeEnd = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerId !== sid) return;
    sid = -1;
    if (!swiping) return;
    swiping = false;
    delete el.dataset.drag;
    const size = mode === 'bottom' ? el.offsetHeight : el.offsetWidth;
    // A cancelled pointer (the system took it) snaps back: only a real release may close.
    if (!cancelled && swipeCloses(sd, e.timeStamp - st, size)) {
      el.dataset.swiped = 'true';
      opts.requestClose();
    } else {
      el.style.transform = '';
    }
  };
  const sup = (e: PointerEvent): void => swipeEnd(e, false);
  const scancel = (e: PointerEvent): void => swipeEnd(e, true);
  el.addEventListener('pointerdown', sdown);
  el.addEventListener('pointermove', smove);
  el.addEventListener('pointerup', sup);
  el.addEventListener('pointercancel', scancel);

  const frame: SheetFrame = {
    el, body, kind: opts.kind, modal: opts.modal,
    get isOpen() { return open; },
    open(a, returnTo) {
      anchor = a;
      back = returnTo === undefined ? a : returnTo;
      if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = 0; }
      const wasOpen = open;
      open = true;
      el.hidden = false;
      el.style.transform = '';
      delete el.dataset.swiped;
      place();
      if (!wasOpen) {
        el.dataset.state = 'pre';
        void el.offsetWidth; // commit the start state so the transition runs
      }
      el.dataset.state = 'open';
      opts.onShow?.();
      const target = opts.initialFocus?.() ?? focusables(el)[0] ?? null;
      (target ?? el).focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      open = false;
      const hadFocus = el.contains(document.activeElement);
      if (el.dataset.swiped === 'true') {
        el.style.transform = mode === 'bottom' ? 'translateY(110%)' : 'translateX(110%)';
      } else {
        el.style.transform = '';
      }
      el.dataset.state = 'closing';
      const ms = ctx.state().reducedMotion ? 0 : SHEET_MS + 20;
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        if (open) return;
        el.hidden = true;
        el.style.transform = '';
        delete el.dataset.swiped;
      }, ms);
      if (hadFocus) {
        if (back && back.isConnected && !back.closest('.is-off')) back.focus({ preventScroll: true });
        else (document.activeElement as HTMLElement | null)?.blur();
      }
    },
    relayout() { if (open) place(); },
    dispose() {
      if (hideTimer) window.clearTimeout(hideTimer);
      el.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
  return frame;
}

// ============================================================================ tiles (pure model)

export interface TileSpec {
  key: string;
  label: string;
  /** Accessible name (label plus state). */
  aria: string;
  tip: string;
  opt: TileOption | null; // null: an empty recent slot (not a control)
  checked: boolean;
  intent: Intent | null;
  /** The active nib tile: vertical drag sets size. */
  drag: boolean;
}

function sameLch(a: ColorStyle['lch'], b: ColorStyle['lch']): boolean {
  if (!a || !b) return false;
  for (const g of ['night', 'paper'] as const) {
    for (let i = 0; i < 3; i++) if (Math.abs(a[g][i] - b[g][i]) > 1e-6) return false;
  }
  return true;
}

/** Do two tile options render the same thing? Pure. */
export function sameOpt(a: TileOption | null, b: TileOption | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  switch (a.k) {
    case 'nib': return a.nib === (b as typeof a).nib;
    case 'erase': return true;
    case 'form': return a.form === (b as typeof a).form;
    case 'ink': {
      const o = b as typeof a;
      if (a.ink !== o.ink) return false;
      const x = a.custom, y = o.custom;
      if (!x || !y) return x === y;
      return x.ink === y.ink && x.k === y.k && x.dh === y.dh && x.dL === y.dL && (x.lch === y.lch || sameLch(x.lch, y.lch));
    }
  }
}

/**
 * Tiles of a chip sheet for a state (DESIGN §4): ≤ 9 tiles, except the Form sheet, which offers
 * all ten Forms (an accepted exception; it lays out in two rows, see tileCols). Labels always
 * shown. Pure.
 */
export function tileSpecs(kind: ChipKind, s: AppState): TileSpec[] {
  const t = s.tool;
  if (kind === 'stroke') {
    const out: TileSpec[] = P0_NIBS.map((nib): TileSpec => {
      const checked = t.mode === 'draw' && t.nib === nib;
      const name = NIB_NAMES[nib];
      return {
        key: nib, label: name,
        aria: checked ? `${name}, size ${fmtSize(t.sizes[nib])}. Drag up or down to resize.` : name,
        tip: checked ? `${name} · drag ↕ to resize` : `${name} · B cycles`,
        opt: { k: 'nib', nib }, checked, intent: { k: 'pickNib', nib }, drag: checked,
      };
    });
    out.push({
      key: 'erase', label: 'Erase', aria: 'Erase', tip: 'Erase · E',
      opt: { k: 'erase' }, checked: t.mode === 'erase', intent: { k: 'pickErase' }, drag: false,
    });
    return out;
  }
  if (kind === 'color') {
    const out: TileSpec[] = INK_ORDER.map((ink): TileSpec => ({
      key: ink, label: INK_NAMES[ink], aria: INK_NAMES[ink], tip: `${INK_NAMES[ink]} · C cycles`,
      opt: { k: 'ink', ink }, checked: t.ink === ink, intent: { k: 'pickInk', ink }, drag: false,
    }));
    const sel = s.selection.length > 0;
    for (let i = 0; i < 2; i++) {
      const r = t.recents[i];
      if (!r) {
        out.push({ key: `recent${i}`, label: 'Recent', aria: '', tip: '', opt: null, checked: false, intent: null, drag: false });
        continue;
      }
      // With a selection, slot 1 carries the selected stroke's colour (DESIGN §2.4.1): one tap adopts it.
      const label = sel && i === 0 ? 'Selection' : 'Recent';
      const checked = t.ink === 'custom' && r.ink === 'custom' && sameLch(t.custom, r.lch);
      out.push({
        key: `recent${i}`, label,
        aria: sel && i === 0 ? "The selection's colour" : `Recent ink ${i + 1}`,
        tip: sel && i === 0 ? "Selection · adopt this colour" : 'Recent ink',
        opt: { k: 'ink', ink: r.ink, custom: r }, checked, intent: { k: 'pickCustom', color: r }, drag: false,
      });
    }
    return out;
  }
  return P0_FORMS.map((form, i): TileSpec => ({
    key: form, label: FORM_NAMES[form], aria: FORM_NAMES[form], tip: i < 10 ? `${FORM_NAMES[form]} · ${(i + 1) % 10}` : FORM_NAMES[form],
    opt: { k: 'form', form }, checked: t.form === form, intent: { k: 'pickForm', form }, drag: false,
  }));
}

/**
 * Roving focus (DESIGN §10): Left/Right step and wrap; Up/Down step a row in a grid of `cols`
 * (or step like Left/Right in a single row); Home/End. Indices are positions in the list of
 * focusable tiles. Returns -1 for keys it does not handle. Pure.
 */
export function rovingNext(i: number, n: number, key: string, cols: number): number {
  if (n <= 0) return -1;
  const grid = cols < n;
  switch (key) {
    case 'ArrowRight': return (i + 1) % n;
    case 'ArrowLeft': return (i - 1 + n) % n;
    case 'ArrowDown': return grid ? (i + cols < n ? i + cols : i) : (i + 1) % n;
    case 'ArrowUp': return grid ? (i - cols >= 0 ? i - cols : i) : (i - 1 + n) % n;
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return -1;
  }
}

/**
 * Grid columns for a tile sheet (phones use a grid; elsewhere one row, or two balanced rows
 * past 9 tiles: the eleven-Form sheet is 6 + 5).
 */
export function tileCols(layout: Layout, n: number): number {
  if (layout === 'phone') return n > 4 ? 3 : 4;
  if (layout === 'phone-landscape') return n > 4 ? 3 : 2;
  return n > 9 ? Math.ceil(n / 2) : n;
}

const GROUP_LABEL: Record<ChipKind, string> = { stroke: 'Nib', color: 'Ink', form: 'Form' };
const SHEET_LABEL: Record<ChipKind, string> = { stroke: 'Stroke', color: 'Color', form: 'Form' };

// ============================================================================ tile sheet

export interface TileSheet {
  readonly id: SheetId;
  readonly frame: SheetFrame;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  dispose(): void;
}

interface TileEl { el: HTMLButtonElement; canvas: HTMLCanvasElement; label: HTMLSpanElement; spec: TileSpec; stale: boolean }

export function createTileSheet(kind: ChipKind, ctx: UICtx): TileSheet {
  const frame = createSheetFrame(ctx, {
    kind: 'chip',
    label: SHEET_LABEL[kind],
    modal: false,
    requestClose: () => ctx.dispatch({ k: 'openSheet', sheet: null }),
    onShow: () => { markStale(); schedule(); },
    initialFocus: () => tiles.find(t => t.spec.checked && t.spec.intent)?.el ?? tiles.find(t => t.spec.intent)?.el ?? null,
  });
  frame.el.dataset.sheet = kind;

  const group = document.createElement('div');
  group.className = 'r-tiles';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', GROUP_LABEL[kind]);
  frame.body.appendChild(group);

  const tiles: TileEl[] = [];
  const unbinds: (() => void)[] = [];
  let rafId = 0;
  let dragRaf = 0, dragDy = 0;

  const choose = (t: TileEl): void => {
    const intent = t.spec.intent;
    if (!intent) return;
    ctx.dispatch(intent);
    const s = ctx.state();
    if (intent.k === 'pickErase' || s.selection.length === 0) ctx.dispatch({ k: 'openSheet', sheet: null });
  };

  const build = (specs: TileSpec[]): void => {
    specs.forEach((spec, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'r-tile';
      el.dataset.key = spec.key;
      el.setAttribute('role', 'radio');
      if (kind === 'stroke' && spec.key === 'erase') el.classList.add('is-split');
      if (kind === 'color' && i === INK_ORDER.length) el.classList.add('is-split');
      const well = document.createElement('span');
      well.className = 'r-well';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      well.appendChild(canvas);
      const mark = document.createElement('span');
      mark.className = 'r-check';
      mark.setAttribute('aria-hidden', 'true');
      well.appendChild(mark);
      const label = document.createElement('span');
      label.className = 'r-tlabel';
      label.setAttribute('aria-hidden', 'true');
      el.append(well, label);
      group.appendChild(el);
      const t: TileEl = { el, canvas, label, spec, stale: true };
      tiles.push(t);
      const isNib = kind === 'stroke' && spec.key !== 'erase';
      unbinds.push(bindPress(el, {
        tap: () => choose(t),
        drag: isNib ? (_dx, dy, phase) => {
          if (!t.spec.drag) return;
          if (phase === 'start') { dragDy = 0; el.classList.add('is-dragging'); return; }
          if (phase === 'move') {
            dragDy = dy;
            if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; ctx.dispatch({ k: 'bendSize', factor: sizeFactor(dragDy), done: false }); });
            return;
          }
          if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
          ctx.dispatch({ k: 'bendSize', factor: phase === 'cancel' ? 1 : sizeFactor(dy), done: true });
          el.classList.remove('is-dragging');
        } : undefined,
      }));
      unbinds.push(ctx.tip.bind(el, () => t.spec.tip));
    });
  };

  const apply = (specs: TileSpec[]): void => {
    let focusIdx = specs.findIndex(sp => sp.checked && sp.intent);
    if (focusIdx < 0) focusIdx = specs.findIndex(sp => sp.intent);
    specs.forEach((spec, i) => {
      const t = tiles[i];
      // Runs on every tool change (each frame of a chip drag): compare cheaply, and write the DOM
      // only on change so an open sheet is not re-laid out per frame.
      const optChanged = !sameOpt(t.spec.opt, spec.opt);
      t.spec = spec;
      if (optChanged) t.stale = true;
      if (t.label.textContent !== spec.label) t.label.textContent = spec.label;
      const empty = spec.intent === null;
      t.el.classList.toggle('is-empty', empty);
      t.el.disabled = empty;
      t.el.setAttribute('aria-checked', String(spec.checked));
      t.el.classList.toggle('is-checked', spec.checked);
      t.el.classList.toggle('r-noswipe', spec.drag);
      t.el.classList.toggle('is-draggable', spec.drag);
      if (empty) { t.el.setAttribute('aria-hidden', 'true'); t.el.removeAttribute('aria-label'); }
      else { t.el.removeAttribute('aria-hidden'); t.el.setAttribute('aria-label', spec.aria); }
      // Roving tabindex: the checked tile (or the first) is the group's single tab stop.
      t.el.tabIndex = i === focusIdx ? 0 : -1;
    });
  };

  const markStale = (): void => { for (const t of tiles) t.stale = true; };

  // Tiles render a few per frame (≈ 6 ms budget), checked tile first, so the sheet opens smoothly.
  const pump = (): void => {
    rafId = 0;
    if (!frame.isOpen) return;
    const s = ctx.state();
    const t0 = performance.now();
    const order = tiles.slice().sort((a, b) => Number(b.spec.checked) - Number(a.spec.checked));
    for (const t of order) {
      if (!t.stale) continue;
      if (performance.now() - t0 > 6) { schedule(); return; }
      t.stale = false;
      if (!t.spec.opt) { clearCanvas(t.canvas); continue; }
      if (!fitCanvas(t.canvas, ctx.dpr())) { t.stale = true; continue; }
      try {
        ctx.glyphs.tile(t.canvas, t.spec.opt, s.lastRecipe, s.tool, s.ground);
      } catch (err) {
        console.error('[ui] glyphs.tile failed', err);
      }
    }
  };
  const schedule = (): void => { if (!rafId) rafId = requestAnimationFrame(pump); };

  const onGroupKey = (e: KeyboardEvent): void => {
    const live = tiles.filter(t => t.spec.intent);
    const i = live.findIndex(t => t.el === document.activeElement);
    if (i < 0) return;
    const next = rovingNext(i, live.length, e.key, tileCols(ctx.layout(), tiles.length));
    if (next < 0) return;
    e.preventDefault();
    for (const t of live) t.el.tabIndex = -1;
    live[next].el.tabIndex = 0;
    live[next].el.focus();
  };
  group.addEventListener('keydown', onGroupKey);

  // ---- extras: Stroke caption, Color ground switch
  let sw: HTMLButtonElement | null = null;
  if (kind === 'stroke') {
    const cap = document.createElement('p');
    cap.className = 'r-caption';
    cap.textContent = 'Drag the active tile ↕ to resize';
    frame.body.appendChild(cap);
  } else if (kind === 'color') {
    sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'r-switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Paper ground');
    const thumb = document.createElement('span');
    thumb.className = 'r-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    const n = document.createElement('span');
    n.textContent = 'Night';
    n.dataset.v = 'night';
    const p = document.createElement('span');
    p.textContent = 'Paper';
    p.dataset.v = 'paper';
    sw.append(thumb, n, p);
    sw.addEventListener('click', () => ctx.dispatch({ k: 'ground', g: ctx.state().ground === 'night' ? 'paper' : 'night' }));
    unbinds.push(ctx.tip.bind(sw, () => 'Night | Paper · G'));
    frame.body.appendChild(sw);
  }

  build(tileSpecs(kind, ctx.state()));
  let lastLayout: Layout | null = null;

  return {
    id: kind,
    frame,
    update(s, prev, force) {
      const layout = ctx.layout();
      if (layout !== lastLayout) {
        lastLayout = layout;
        frame.el.style.setProperty('--cols', String(tileCols(layout, tiles.length)));
        markStale();
      }
      if (force || !prev || prev.tool !== s.tool || prev.selection.length !== s.selection.length) apply(tileSpecs(kind, s));
      if (sw && (force || !prev || prev.ground !== s.ground)) {
        sw.setAttribute('aria-checked', String(s.ground === 'paper'));
        sw.dataset.on = s.ground;
      }
      const inputs = force || !prev || prev.lastRecipe !== s.lastRecipe || prev.tool !== s.tool || prev.ground !== s.ground;
      if (inputs) markStale();
      if (frame.isOpen && (inputs || tiles.some(t => t.stale))) schedule();
    },
    dispose() {
      if (rafId) cancelAnimationFrame(rafId);
      if (dragRaf) cancelAnimationFrame(dragRaf);
      group.removeEventListener('keydown', onGroupKey);
      for (const u of unbinds) u();
      frame.dispose();
    },
  };
}

function clearCanvas(c: HTMLCanvasElement): void {
  const g = c.getContext('2d');
  if (g) g.clearRect(0, 0, c.width, c.height);
}
