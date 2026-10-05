/**
 * The selection bar (DESIGN §3.4, §4): Delete, and nothing else. There is no count badge (the
 * count is announced). On desktop / tablet it sits just above the selection's bounds when the app
 * supplies them (local extension `selectionRect`, see docs/contract-requests/ui.md), otherwise just
 * above the dock; on phones it takes the view chip's leading dock slot.
 */
import type { AppState } from '../app/types';
import { icon } from './icons';
import type { UICtx } from './index';

/** Screen-space selection bounds (CSS px). Not in the frozen AppState: optional extension. */
export interface SelectionRect { x: number; y: number; w: number; h: number }
export type AppStateWithRect = AppState & { selectionRect?: SelectionRect | null };

/** Accessible name of Delete for `n` selected strokes. */
export function deleteLabel(n: number): string {
  return n === 1 ? 'Delete the selected stroke' : `Delete ${n} selected strokes`;
}

/**
 * Where Delete goes above a selection rect: centred on it, 12 px above, clamped into the viewport
 * and kept clear of the top edge (below the rect when there is no room above). Pure.
 */
export function deletePosition(r: SelectionRect, bw: number, bh: number, vw: number, vh: number): { x: number; y: number } {
  const m = 12;
  let x = r.x + r.w / 2 - bw / 2;
  let y = r.y - m - bh;
  if (y < 64) y = r.y + r.h + m;
  x = Math.max(m, Math.min(vw - bw - m, x));
  y = Math.max(m, Math.min(vh - bh - m, y));
  return { x: Math.round(x), y: Math.round(y) };
}

export interface SelectionBar {
  readonly el: HTMLButtonElement;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  dispose(): void;
}

export function createSelectionBar(ctx: UICtx): SelectionBar {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'r-btn r-delete r-surface is-off';
  const label = document.createElement('span');
  label.className = 'r-delete-text';
  label.textContent = 'Delete';
  el.append(icon('trash', 18), label);
  el.addEventListener('click', () => ctx.dispatch({ k: 'delete' }));
  const untip = ctx.tip.bind(el, () => (ctx.state().isMac ? 'Delete · ⌫' : 'Delete · Del'));

  return {
    el,
    update(s, prev, force) {
      if (force || !prev || prev.selection.length !== s.selection.length) {
        el.setAttribute('aria-label', deleteLabel(s.selection.length));
      }
      const r = (s as AppStateWithRect).selectionRect;
      const rect = r && Number.isFinite(r.x + r.y + r.w + r.h) ? r : null; // a bad rect falls back to the dock
      const home = el.parentElement;
      const floating = home !== null && home.classList.contains('r-delhome');
      if (floating && rect && s.selection.length > 0) {
        const p = deletePosition(rect, el.offsetWidth || 104, el.offsetHeight || 44, window.innerWidth, window.innerHeight);
        home.classList.add('is-anchored');
        home.style.transform = `translate(${p.x}px, ${p.y}px)`;
      } else if (home) {
        home.classList.remove('is-anchored');
        home.style.transform = '';
      }
    },
    dispose() { untip(); el.remove(); },
  };
}
