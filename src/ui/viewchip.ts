/**
 * The view chip (DESIGN §4): the only number on screen. Shows "140%", an arrow pointing to the
 * ink when none is in view, or both. Tap: the app fits the content when no ink is in view,
 * otherwise resets to 100% (`viewChip` intent). Long-press: fit.
 */
import type { AppState } from '../app/types';
import { bindPress } from './chip';
import { zoomPct } from './dock';
import { icon } from './icons';
import type { UICtx } from './index';

export interface ViewModel {
  /** Zoom text ("140%"), or null at 100 %. */
  text: string | null;
  /** Screen angle (radians) of the lost-ink arrow, or null when ink is in view. */
  arrow: number | null;
  /** Whether ink is out of view (an arrow shows even if the direction is unknown). */
  lost: boolean;
  label: string;
  tip: string;
}

/** What the view chip says for a state (pure). Visibility is `viewChipWanted` in dock.ts. */
export function viewChipModel(s: Pick<AppState, 'zoom' | 'hasInk' | 'inkInView' | 'inkDirection'>): ViewModel {
  const pct = zoomPct(s.zoom);
  const zoomed = pct !== 100;
  const lost = s.hasInk && !s.inkInView;
  const text = zoomed ? `${pct}%` : null;
  const arrow = lost && s.inkDirection !== null && Number.isFinite(s.inkDirection) ? s.inkDirection : null;
  let label: string;
  let tip: string;
  if (lost) {
    label = zoomed ? `Zoom ${pct}%, no ink in view. Tap to fit the drawing.` : 'No ink in view. Tap to fit the drawing.';
    tip = 'Fit to ink · ⇧1';
  } else {
    label = `Zoom ${pct}%. Tap to return to 100%. Long-press to fit the drawing.`;
    tip = 'Back to 100% · ⇧0 · hold to fit';
  }
  return { text, arrow, lost, label, tip };
}

export interface ViewChip {
  readonly el: HTMLButtonElement;
  update(s: AppState, prev: AppState | null, force: boolean): void;
  dispose(): void;
}

export function createViewChip(ctx: UICtx): ViewChip {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'r-btn r-view r-surface is-off';
  const arrowWrap = document.createElement('span');
  arrowWrap.className = 'r-view-arrow';
  arrowWrap.appendChild(icon('arrow', 18));
  const text = document.createElement('span');
  text.className = 'r-view-text';
  el.append(arrowWrap, text);

  let model = viewChipModel(ctx.state());
  const unbind = bindPress(el, {
    tap: () => ctx.dispatch({ k: 'viewChip' }),
    hold: () => ctx.dispatch({ k: 'fit' }),
  });
  const untip = ctx.tip.bind(el, () => model.tip);

  return {
    el,
    update(s, prev, force) {
      if (!force && prev && prev.zoom === s.zoom && prev.hasInk === s.hasInk && prev.inkInView === s.inkInView && prev.inkDirection === s.inkDirection) return;
      model = viewChipModel(s);
      text.textContent = model.text ?? '';
      el.classList.toggle('has-text', model.text !== null);
      el.classList.toggle('is-lost', model.lost);
      arrowWrap.style.transform = model.arrow === null ? '' : `rotate(${model.arrow.toFixed(3)}rad)`;
      el.setAttribute('aria-label', model.label);
    },
    dispose() { unbind(); untip(); el.remove(); },
  };
}
