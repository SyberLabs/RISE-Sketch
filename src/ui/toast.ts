/**
 * Toasts (DESIGN §1.2, §4): one at a time, above the dock, at most one action, only for the
 * events the app emits (New, Open/drop, export progress / saved, autosave failure, pen mode).
 * 6 s by default; a progress toast stays until it completes or is replaced / closed. The timer
 * pauses while the toast is hovered or holds focus, so its action stays reachable.
 */
import type { AppEvent } from '../app/types';
import type { UICtx } from './index';

export const TOAST_MS = 6000;

type ToastEvent = Extract<AppEvent, { k: 'toast' }>;

/** How long a toast stays, or null while it must stay (progress under way). Pure. */
export function toastDuration(e: Pick<ToastEvent, 'ms' | 'progress'>): number | null {
  // A progress value that is not a finished 1 (including NaN) means the work is still under way.
  if (e.progress !== undefined && !(e.progress >= 1)) return null;
  return e.ms !== undefined && Number.isFinite(e.ms) && e.ms > 0 ? e.ms : TOAST_MS;
}

export interface Toaster {
  readonly el: HTMLElement;
  show(e: ToastEvent): void;
  close(id: string): void;
  readonly current: string | null;
  dispose(): void;
}

export function createToaster(ctx: UICtx): Toaster {
  const el = document.createElement('div');
  el.className = 'r-toast r-surface';
  el.hidden = true;
  const text = document.createElement('span');
  text.className = 'r-toast-text';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'r-textbtn r-toast-action';
  const bar = document.createElement('span');
  bar.className = 'r-toast-bar';
  bar.setAttribute('aria-hidden', 'true');
  el.append(text, action, bar);
  ctx.root.appendChild(el);

  let cur: ToastEvent | null = null;
  let timer = 0, hideTimer = 0;
  let remaining = 0, started = 0;
  let paused = false;

  const clear = (): void => { if (timer) { window.clearTimeout(timer); timer = 0; } };
  const arm = (ms: number): void => {
    clear();
    remaining = ms;
    started = performance.now();
    if (!paused) timer = window.setTimeout(() => { timer = 0; if (cur) hide(); }, ms);
  };
  const hide = (): void => {
    clear();
    cur = null;
    el.classList.remove('is-on');
    hideTimer = window.setTimeout(() => { hideTimer = 0; if (!cur) el.hidden = true; }, ctx.state().reducedMotion ? 0 : 200);
  };
  const pause = (): void => {
    if (paused) return;
    paused = true;
    if (timer) { clear(); remaining = Math.max(800, remaining - (performance.now() - started)); }
  };
  const resume = (): void => {
    if (!paused) return;
    paused = false;
    if (cur && toastDuration(cur) !== null) arm(remaining);
  };
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', () => { if (!el.contains(document.activeElement)) resume(); });
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', e => { if (!el.contains(e.relatedTarget as Node | null)) resume(); });

  action.addEventListener('click', () => {
    const a = cur?.action;
    if (!a) return;
    hide();
    ctx.dispatch(a.intent);
  });

  return {
    el,
    show(e) {
      const same = cur !== null && cur.id === e.id;
      if (!same || cur!.text !== e.text) ctx.announcer.say(e.text);
      cur = e;
      if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = 0; }
      text.textContent = e.text;
      action.hidden = !e.action;
      el.classList.toggle('has-action', !!e.action);
      action.textContent = e.action?.label ?? '';
      const hasBar = e.progress !== undefined;
      el.classList.toggle('has-bar', hasBar);
      const p = e.progress! > 0 ? Math.min(1, e.progress!) : 0; // NaN reads as 0
      bar.style.transform = hasBar ? `scaleX(${p.toFixed(3)})` : '';
      if (el.hidden) {
        el.hidden = false;
        void el.offsetWidth;
      }
      el.classList.add('is-on');
      const ms = toastDuration(e);
      if (ms === null) clear();
      else if (!same || !timer) arm(ms);
    },
    close(id) { if (cur && cur.id === id) hide(); },
    get current() { return cur ? cur.id : null; },
    dispose() { clear(); if (hideTimer) window.clearTimeout(hideTimer); el.remove(); },
  };
}
