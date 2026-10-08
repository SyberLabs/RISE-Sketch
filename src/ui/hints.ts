/**
 * Hints and pulses (DESIGN §3.0, §4): at most five, ever, each shown once.
 *  1. "Draw anything. It grows." at 35 % opacity with the first-run seed; fades at the first contact.
 *  2. "Hold still to make it rise." near the end of stroke 5 if nothing has risen.
 *  3. "Try another Form" with one pulse of the Form chip, 1.2 s after the first stroke.
 *  4. A navigation hint on the first off-screen stroke or after 10 strokes.
 *  5. A share hint at the first pause once the drawing has 6 strokes (app/hints.ts).
 * Hints are feedback, never controls (pointer-events: none). Except the first, each dismisses
 * itself after 4 s (`hintDone`); the app also hides them when the action is done (`hintHide`).
 * Hint state in AppState is honoured too: 'showing' without an event shows the default text.
 */
import type { AppState, HintId } from '../app/types';
import type { UICtx } from './index';

export const HINT_MS = 4000;

/** Default texts (DESIGN §3.0 / §4); the app's event text wins when given. */
export function defaultHintText(id: HintId, s: Pick<AppState, 'isTouch' | 'penMode'>): string {
  switch (id) {
    case 'draw': return 'Draw anything. It grows.';
    case 'rise': return 'Hold still to make it rise.';
    case 'form': return 'Try another Form';
    // DESIGN §5: in pen mode one finger pans; on touch-only devices two do; on desktop a mouse
    // wheel zooms (so "scroll to move" would be wrong for a mouse) and Space-drag pans.
    case 'nav':
      if (s.isTouch) return s.penMode ? 'One finger pans · two fingers zoom.' : 'Two fingers pan and zoom.';
      return 'Space-drag to move · wheel or pinch to zoom.';
    // Share timelapse (DESIGN §8): the menu shows ⇧P on every platform; touch has no keys.
    case 'share': return s.isTouch ? 'Share it: Menu → Share timelapse' : 'Share it: ⇧P makes a video of it growing';
  }
}

export interface Hints {
  show(id: HintId, text: string | null, at: { x: number; y: number } | null): void;
  hide(id: HintId): void;
  pulse(target: 'form' | 'stroke' | 'color'): void;
  update(s: AppState, prev: AppState | null): void;
  dispose(): void;
}

interface HintEl { el: HTMLElement; timer: number; shown: boolean }

export function createHints(ctx: UICtx, chipEl: (t: 'form' | 'stroke' | 'color') => HTMLElement, pulseChip: (t: 'form' | 'stroke' | 'color') => void): Hints {
  const layer = document.createElement('div');
  layer.className = 'r-hints r-fade';
  layer.setAttribute('aria-hidden', 'true'); // hints are announced through the live region instead
  ctx.root.prepend(layer);
  const els = new Map<HintId, HintEl>();
  /** Shown and dismissed this session: never shown again even if the state lags behind. */
  const spent = new Set<HintId>();

  const get = (id: HintId): HintEl => {
    let h = els.get(id);
    if (!h) {
      const el = document.createElement('div');
      el.className = 'r-hint';
      el.dataset.hint = id;
      layer.appendChild(el);
      h = { el, timer: 0, shown: false };
      els.set(id, h);
    }
    return h;
  };

  const position = (id: HintId, h: HintEl, at: { x: number; y: number } | null): void => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = h.el.offsetWidth, hh = h.el.offsetHeight;
    let x: number, y: number;
    if (id === 'form' && !at) {
      const r = chipEl('form').getBoundingClientRect();
      if (ctx.layout() === 'phone-landscape') { x = r.left - 14 - w; y = r.top + r.height / 2 - hh / 2; }
      else { x = r.left + r.width / 2 - w / 2; y = r.top - 14 - hh; }
    } else if (at) {
      x = at.x - w / 2;
      y = at.y - 36 - hh;
      if (y < 16) y = at.y + 36;
    } else if (id === 'draw') {
      x = vw / 2 - w / 2; y = vh * 0.56 - hh / 2;
    } else {
      x = vw / 2 - w / 2; y = Math.max(72, vh * 0.16);
    }
    x = Math.max(12, Math.min(vw - w - 12, x));
    y = Math.max(12, Math.min(vh - hh - 12, y));
    h.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const hide = (id: HintId, done: boolean): void => {
    const h = els.get(id);
    if (!h || !h.shown) return;
    h.shown = false;
    window.clearTimeout(h.timer);
    h.timer = 0;
    h.el.classList.remove('is-on');
    spent.add(id);
    if (done) ctx.dispatch({ k: 'hintDone', id });
  };

  const show = (id: HintId, text: string | null, at: { x: number; y: number } | null): void => {
    if (spent.has(id)) return;
    const s = ctx.state();
    const h = get(id);
    const t = text ?? defaultHintText(id, s);
    const fresh = !h.shown;
    h.el.textContent = t;
    h.shown = true;
    position(id, h, at);
    h.el.classList.add('is-on');
    if (fresh) ctx.announcer.say(t);
    window.clearTimeout(h.timer);
    h.timer = id === 'draw' ? 0 : window.setTimeout(() => hide(id, true), HINT_MS);
  };

  return {
    show,
    hide: id => hide(id, false),
    pulse(target) {
      if (ctx.state().reducedMotion) return;
      pulseChip(target);
    },
    update(s, prev) {
      // The first contact fades the first-run text for good (DESIGN §3.0 step 3).
      if (s.chromeHidden && els.get('draw')?.shown) hide('draw', true);
      // Re-read the hint states when they change, and when the chrome comes back (a hint marked
      // 'showing' during a contact waits for it).
      if (prev && prev.hints === s.hints && !(prev.chromeHidden && !s.chromeHidden)) return;
      for (const id of ['draw', 'rise', 'form', 'nav', 'share'] as const) {
        const st = s.hints[id];
        const h = els.get(id);
        if (st === 'showing' && !(h && h.shown) && !spent.has(id) && !s.chromeHidden) show(id, null, null);
        else if (st === 'done' && h && h.shown) hide(id, false);
      }
    },
    dispose() {
      for (const h of els.values()) window.clearTimeout(h.timer);
      layer.remove();
    },
  };
}
