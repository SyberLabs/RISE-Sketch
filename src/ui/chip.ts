/**
 * The three primitive chips and the one gesture rule they share (DESIGN §3.4, §4, §10):
 * tap = choose a kind (opens the sheet), drag = bend the primitive's single amount.
 *
 *  - 6 px dead zone separates tap from drag; the drag is measured from the point where the dead
 *    zone was left, so the amount starts from zero with no jump.
 *  - Long-press (500 ms without leaving the dead zone) shows the chip's label and its drag.
 *  - Keyboard: ArrowUp/Down bend (Color also ArrowLeft/Right), one step per press.
 *  - Desktop: tooltip after 600 ms of mouse hover, including the shortcut and the drag.
 *
 * Also home to the shared press binding (`bindPress`, used by tiles and the view chip) and the
 * tooltip / long-press bubble (`createTip`).
 */
import type { FormId, InkId, NibId } from '../core/types';
import type { AppState, Intent } from '../app/types';
import type { Layout, UICtx } from './index';

export const DEAD_ZONE = 6;
export const LONG_PRESS_MS = 500;
export const TOOLTIP_MS = 600;

export type ChipKind = 'stroke' | 'color' | 'form';

export const NIB_NAMES: Readonly<Record<NibId, string>> = { pen: 'Pen', brush: 'Brush', chisel: 'Chisel', charcoal: 'Charcoal' };
export const INK_NAMES: Readonly<Record<InkId, string>> = {
  graphite: 'Graphite', indigo: 'Indigo', oxide: 'Oxide', ochre: 'Ochre', moss: 'Moss', rose: 'Rose', spectral: 'Spectral', custom: 'Custom ink',
};
export const FORM_NAMES: Readonly<Record<FormId, string>> = { line: 'Line', echo: 'Echo', sprout: 'Sprout', drift: 'Drift', ripple: 'Ripple' };
const GROUND_NAMES = { night: 'Night', paper: 'Paper' } as const;

// ============================================================================ amount maths (pure)

/** Stroke chip: S' = S·2^(−Δy/60), 60 px per doubling (DESIGN §2.2.1). */
export const sizeFactor = (dy: number): number => Math.pow(2, -dy / 60);
/** Form chip: Δbase = −Δy/40 levels in quarter-level steps (DESIGN §2.3.1). */
export function depthDelta(dy: number): number {
  const q = Math.round((-dy / 40) * 4) / 4;
  return q === 0 ? 0 : q; // never -0
}
/** Color chip: Δh = 0.75°·Δx, ΔL = −0.002·Δy (DESIGN §2.4.1). */
export function colorBend(dx: number, dy: number): { dh: number; dL: number } {
  return { dh: 0.75 * dx, dL: dy === 0 ? 0 : -0.002 * dy };
}

/**
 * Keyboard path for a chip drag (DESIGN §10): one `[ ]` step, one quarter level, or 5° hue /
 * 0.02 L per press. Decision: a key step is a complete bend, so it is sent as one intent with
 * `done: true` (one history entry per press when it targets a selection).
 */
export function keyBend(which: ChipKind, key: string): Intent | null {
  switch (which) {
    case 'stroke':
      if (key === 'ArrowUp') return { k: 'bendSize', factor: 1.25, done: true };
      if (key === 'ArrowDown') return { k: 'bendSize', factor: 0.8, done: true };
      return null;
    case 'form':
      if (key === 'ArrowUp') return { k: 'bendDepth', delta: 0.25, done: true };
      if (key === 'ArrowDown') return { k: 'bendDepth', delta: -0.25, done: true };
      return null;
    case 'color':
      if (key === 'ArrowUp') return { k: 'bendColor', dh: 0, dL: 0.02, done: true };
      if (key === 'ArrowDown') return { k: 'bendColor', dh: 0, dL: -0.02, done: true };
      if (key === 'ArrowRight') return { k: 'bendColor', dh: 5, dL: 0, done: true };
      if (key === 'ArrowLeft') return { k: 'bendColor', dh: -5, dL: 0, done: true };
      return null;
  }
}

/** Size for labels: one decimal below 10 sp, whole numbers above. */
export function fmtSize(s: number): string {
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}
/** Depth for labels: quarter levels as decimals ("2", "2.25"). */
export function fmtDepth(d: number): string {
  return String(Math.round(d * 4) / 4);
}

// ============================================================================ labels (pure)

/** Accessible name with state and drag (DESIGN §10). */
export function chipLabel(which: ChipKind, s: AppState): string {
  const t = s.tool;
  const target = s.selection.length > 0 ? "the selection's" : '';
  switch (which) {
    case 'stroke':
      if (t.mode === 'erase') return `Stroke: Erase mode. Tap to return to ${NIB_NAMES[t.lastNib]}.`;
      return `Stroke: ${NIB_NAMES[t.nib]}, size ${fmtSize(t.sizes[t.nib])}. Drag up or down to change ${target ? target + ' ' : ''}size.`;
    case 'color':
      return `Color: ${INK_NAMES[t.ink]} on ${GROUND_NAMES[s.ground]}. Drag sideways for hue, up or down for tone${target ? ' of the selection' : ''}.`;
    case 'form':
      return `Form: ${FORM_NAMES[t.form]}, depth ${fmtDepth(t.base[t.form])}. Drag up or down to change ${target ? target + ' ' : ''}depth.`;
  }
}

/** Desktop tooltip: name, current kind, shortcut, drag (DESIGN §10 Responsive). */
export function chipTip(which: ChipKind, s: AppState): string {
  const t = s.tool;
  switch (which) {
    case 'stroke':
      return t.mode === 'erase' ? 'Erase · E · tap to return' : `Stroke · ${NIB_NAMES[t.nib]} · B · drag ↕ to resize`;
    case 'color':
      return `Color · ${INK_NAMES[t.ink]} · C · drag ↔ hue, ↕ tone`;
    case 'form':
      return `Form · ${FORM_NAMES[t.form]} · 1–4 · drag ↕ to deepen`;
  }
}

/**
 * Long-press label: the chip's name and its drag (DESIGN §3.4). In erase mode the Stroke chip has
 * no drag (the eraser radius is fixed), so it names its one-tap return instead.
 */
export function chipHoldLabel(which: ChipKind, erase = false): string {
  if (which === 'stroke') return erase ? 'Erase · tap to return' : 'Stroke · drag ↕ to resize';
  return which === 'color' ? 'Color · drag ↔ hue, ↕ tone' : 'Form · drag ↕ to deepen';
}

/** Does the chip's amount bend right now? The Stroke chip bends nothing in erase mode. Pure. */
export function chipBends(which: ChipKind, s: Pick<AppState, 'tool'>): boolean {
  return !(which === 'stroke' && s.tool.mode === 'erase');
}

// ============================================================================ press binding

export type DragPhase = 'start' | 'move' | 'end' | 'cancel';
export interface PressHandlers {
  /** Plain tap, or keyboard activation (Enter / Space). */
  tap?(): void;
  /** 500 ms still hold. The tap that would follow is suppressed. */
  hold?(): void;
  /** Hold released without dragging. */
  holdEnd?(): void;
  /** Cumulative offsets from the point where the dead zone was left. */
  drag?(dx: number, dy: number, phase: DragPhase): void;
}

/**
 * Tap / long-press / drag on a button. Taps arrive through `click` so keyboard activation shares
 * the path; a click that follows a drag or a hold is swallowed. Only the primary pointer counts.
 */
export function bindPress(el: HTMLElement, h: PressHandlers): () => void {
  let id = -1;
  let x0 = 0, y0 = 0, ox = 0, oy = 0;
  let dragging = false, held = false, suppress = false;
  let timer = 0;

  const clearTimer = (): void => { if (timer) { window.clearTimeout(timer); timer = 0; } };
  const down = (e: PointerEvent): void => {
    if (id !== -1 || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    id = e.pointerId;
    x0 = e.clientX; y0 = e.clientY;
    dragging = false; held = false; suppress = false;
    try { el.setPointerCapture(id); } catch { /* element detached */ }
    if (h.hold) {
      timer = window.setTimeout(() => {
        timer = 0;
        if (id === -1 || dragging) return;
        held = true; suppress = true;
        h.hold!();
      }, LONG_PRESS_MS);
    }
  };
  const move = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!dragging) {
      if (dx * dx + dy * dy <= DEAD_ZONE * DEAD_ZONE) return;
      clearTimer();
      suppress = true;
      if (!h.drag) return;
      dragging = true;
      ox = e.clientX; oy = e.clientY;
      if (held) { held = false; h.holdEnd?.(); }
      h.drag(0, 0, 'start');
      return;
    }
    e.preventDefault();
    h.drag!(e.clientX - ox, e.clientY - oy, 'move');
  };
  const finish = (e: PointerEvent, cancel: boolean): void => {
    if (e.pointerId !== id) return;
    clearTimer();
    id = -1;
    if (dragging) { dragging = false; h.drag!(e.clientX - ox, e.clientY - oy, cancel ? 'cancel' : 'end'); }
    if (held) { held = false; h.holdEnd?.(); }
    // The click (if any) is dispatched in this same task; clear the guard afterwards.
    if (suppress) window.setTimeout(() => { suppress = false; }, 0);
  };
  const up = (e: PointerEvent): void => finish(e, false);
  const cancel = (e: PointerEvent): void => finish(e, true);
  const click = (e: MouseEvent): void => {
    if (suppress) { suppress = false; e.preventDefault(); e.stopPropagation(); return; }
    h.tap?.();
  };
  const ctx = (e: Event): void => e.preventDefault(); // long-press must not open the system menu

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', cancel); // another element took the pointer (sheet swipe)
  el.addEventListener('click', click);
  el.addEventListener('contextmenu', ctx);
  return () => {
    clearTimer();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('lostpointercapture', cancel);
    el.removeEventListener('click', click);
    el.removeEventListener('contextmenu', ctx);
  };
}

// ============================================================================ tooltip / long-press bubble

export interface Tip {
  /** Desktop tooltip after 600 ms of mouse hover. `text` is read when it shows. */
  bind(el: HTMLElement, text: () => string): () => void;
  /** Show the bubble at `el` now (long-press label). */
  show(el: HTMLElement, text: string): void;
  hide(): void;
  dispose(): void;
}

/** One shared bubble: above its anchor, below it near the top edge, left of it on a trailing rail. */
export function createTip(root: HTMLElement, layout: () => Layout): Tip {
  const bubble = document.createElement('div');
  bubble.className = 'r-tip';
  bubble.setAttribute('aria-hidden', 'true'); // the controls' aria-labels already say this
  root.appendChild(bubble);
  let timer = 0;
  let anchor: HTMLElement | null = null;

  const place = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const gap = 10;
    let x: number, y: number, side: string;
    if (layout() === 'phone-landscape' && r.left > vw * 0.6) {
      x = r.left - gap - bw; y = r.top + r.height / 2 - bh / 2; side = 'left';
    } else if (r.top < bh + gap + 12) {
      x = r.left + r.width / 2 - bw / 2; y = r.bottom + gap; side = 'below';
    } else {
      x = r.left + r.width / 2 - bw / 2; y = r.top - gap - bh; side = 'above';
    }
    x = Math.max(8, Math.min(vw - bw - 8, x));
    y = Math.max(8, Math.min(vh - bh - 8, y));
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    bubble.dataset.side = side;
  };
  const show = (el: HTMLElement, text: string): void => {
    window.clearTimeout(timer); timer = 0;
    anchor = el;
    bubble.textContent = text;
    bubble.classList.add('is-on');
    place(el);
  };
  const hide = (): void => {
    window.clearTimeout(timer); timer = 0;
    anchor = null;
    bubble.classList.remove('is-on');
  };

  return {
    bind(el, text) {
      const enter = (e: PointerEvent): void => {
        if (e.pointerType !== 'mouse') return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { timer = 0; if (el.isConnected) show(el, text()); }, TOOLTIP_MS);
      };
      const leave = (): void => { if (anchor === el || timer) hide(); };
      el.addEventListener('pointerenter', enter);
      el.addEventListener('pointerleave', leave);
      el.addEventListener('pointerdown', leave);
      el.addEventListener('blur', leave);
      return () => {
        el.removeEventListener('pointerenter', enter);
        el.removeEventListener('pointerleave', leave);
        el.removeEventListener('pointerdown', leave);
        el.removeEventListener('blur', leave);
      };
    },
    show,
    hide,
    dispose() { hide(); bubble.remove(); },
  };
}

// ============================================================================ canvas helper

/** Size a glyph canvas's backing store to its CSS box × dpr. Returns false when it has no box. */
export function fitCanvas(c: HTMLCanvasElement, dpr: number): boolean {
  const w = c.clientWidth, h = c.clientHeight;
  if (w <= 0 || h <= 0) return false;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (c.width !== bw) c.width = bw;
  if (c.height !== bh) c.height = bh;
  return true;
}

// ============================================================================ the chip

export interface Chip {
  readonly el: HTMLButtonElement;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  /** One soft ring (the "Try another Form" pulse). */
  pulse(): void;
  dispose(): void;
}

/** Create one primitive chip. The caller places `el` in the dock. */
export function createChip(which: ChipKind, ctx: UICtx): Chip {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'r-chip';
  el.dataset.chip = which;
  el.setAttribute('aria-haspopup', 'dialog');
  el.setAttribute('aria-expanded', 'false');
  const canvas = document.createElement('canvas');
  canvas.className = 'r-glyph';
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);

  let pendingRaf = 0, pulseTimer = 0;
  let lastDx = 0, lastDy = 0, lastDepth = 0;
  let inert = false; // erase mode: the eraser has a fixed radius, so the Stroke drag bends nothing
  let glyphFailed = false;
  let stale = true; // glyph needs a render (tool / ground changed, or the canvas had no box yet)

  const render = (s: AppState): void => {
    if (!fitCanvas(canvas, ctx.dpr())) return; // hidden: retry on the next update
    stale = false;
    try {
      ctx.glyphs.chip(canvas, which, s.tool, s.ground, which === 'stroke' && s.tool.mode === 'erase');
    } catch (err) {
      if (!glyphFailed) { glyphFailed = true; console.error('[ui] glyphs.chip failed', err); }
    }
  };

  const dispatchDrag = (done: boolean): void => {
    switch (which) {
      case 'stroke': ctx.dispatch({ k: 'bendSize', factor: sizeFactor(lastDy), done }); break;
      case 'color': { const b = colorBend(lastDx, lastDy); ctx.dispatch({ k: 'bendColor', dh: b.dh, dL: b.dL, done }); break; }
      case 'form': ctx.dispatch({ k: 'bendDepth', delta: depthDelta(lastDy), done }); break;
    }
  };
  const frame = (): void => { pendingRaf = 0; dispatchDrag(false); };

  const unbind = bindPress(el, {
    tap() {
      const s = ctx.state();
      if (which === 'stroke' && s.tool.mode === 'erase') { ctx.dispatch({ k: 'exitErase' }); return; }
      ctx.dispatch({ k: 'openSheet', sheet: s.sheet === which ? null : which });
    },
    hold() { ctx.tip.show(el, chipHoldLabel(which, !chipBends(which, ctx.state()))); },
    holdEnd() { ctx.tip.hide(); },
    drag(dx, dy, phase) {
      if (phase === 'start') {
        ctx.tip.hide();
        inert = !chipBends(which, ctx.state());
        if (inert) return;
        el.classList.add('is-dragging');
        ctx.root.dataset.drag = which;
        lastDx = 0; lastDy = 0; lastDepth = 0;
        return;
      }
      if (inert) return;
      if (phase === 'cancel') {
        // A system gesture stole the pointer: put the amount back where it started.
        if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = 0; }
        lastDx = 0; lastDy = 0;
        dispatchDrag(true);
      } else if (phase === 'end') {
        if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = 0; }
        lastDx = dx; lastDy = dy;
        dispatchDrag(true);
      } else {
        lastDx = dx; lastDy = dy;
        if (which === 'form') {
          const d = depthDelta(dy);
          if (d === lastDepth) return; // only quarter-level changes are worth a dispatch
          lastDepth = d;
        }
        if (!pendingRaf) pendingRaf = requestAnimationFrame(frame); // ≤ one intent per frame
        return;
      }
      el.classList.remove('is-dragging');
      delete ctx.root.dataset.drag;
    },
  });

  const keydown = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const intent = keyBend(which, e.key);
    if (!intent) return;
    e.preventDefault();
    e.stopPropagation();
    if (!chipBends(which, ctx.state())) return; // same rule as the drag: the eraser has no size
    ctx.dispatch(intent);
    queueMicrotask(() => ctx.announcer.say(keyBendAnnouncement(which, intent, ctx.state())));
  };
  el.addEventListener('keydown', keydown);
  const untip = ctx.tip.bind(el, () => chipTip(which, ctx.state()));

  return {
    el,
    update(s, prev, force) {
      if (force || !prev || prev.tool !== s.tool || prev.ground !== s.ground || prev.selection.length !== s.selection.length) {
        el.setAttribute('aria-label', chipLabel(which, s));
      }
      el.setAttribute('aria-expanded', String(s.sheet === which));
      el.classList.toggle('is-open', s.sheet === which);
      if (which === 'stroke') {
        const erase = s.tool.mode === 'erase';
        el.classList.toggle('is-erase', erase);
        // In erase mode a tap returns to the last nib instead of opening the sheet.
        if (erase) el.removeAttribute('aria-haspopup');
        else el.setAttribute('aria-haspopup', 'dialog');
      }
      // The tool object is replaced on every change; the Glyphs implementation caches renders.
      if (force || !prev || prev.tool !== s.tool || prev.ground !== s.ground) stale = true;
      if (stale) render(s);
    },
    pulse() {
      el.classList.remove('is-pulse');
      void el.offsetWidth; // restart the animation
      el.classList.add('is-pulse');
      window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => { pulseTimer = 0; el.classList.remove('is-pulse'); }, 1200);
    },
    dispose() {
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      window.clearTimeout(pulseTimer);
      unbind();
      untip();
      el.removeEventListener('keydown', keydown);
      el.remove();
    },
  };
}

/** What a keyboard bend changed, read back from the state after the dispatch. */
export function keyBendAnnouncement(which: ChipKind, i: Intent, s: AppState): string {
  const sel = s.selection.length;
  if (which === 'stroke' && i.k === 'bendSize') {
    if (sel) return i.factor > 1 ? 'Selection larger' : 'Selection smaller';
    return `Size ${fmtSize(s.tool.sizes[s.tool.nib])}`;
  }
  if (which === 'form' && i.k === 'bendDepth') {
    if (sel) return i.delta > 0 ? 'Selection deeper' : 'Selection shallower';
    return `Depth ${fmtDepth(s.tool.base[s.tool.form])}`;
  }
  if (i.k === 'bendColor') {
    const what = i.dL > 0 ? 'Lighter' : i.dL < 0 ? 'Darker' : i.dh > 0 ? 'Hue +5°' : 'Hue −5°';
    return sel ? `Selection ${what.toLowerCase()}` : what;
  }
  return '';
}
