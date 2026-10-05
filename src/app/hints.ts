/**
 * Hints (DESIGN §3.0, §4): at most four, ever, each shown once and remembered in prefs.
 *
 *  draw  "Draw anything. It grows."  — with the first-run seed (boot sets it 'showing'; the UI
 *        fades it at the first contact and dispatches hintDone).
 *  form  The Form chip pulses once with "Try another Form", 1.2 s after the first stroke.
 *  rise  "Hold still to make it rise." near the end of stroke 5 when nothing has risen yet
 *        (neither in this session nor in the document).
 *  nav   A navigation hint on the first stroke whose ink spills off-screen, or after 10 strokes.
 *
 * Each dismisses itself after 4 s (the UI dispatches hintDone), or when its action happens:
 * picking a Form, a rise, a navigation gesture. The app only decides *when*; the UI owns text
 * placement and timing. hintDone is idempotent (controller).
 */
import type { StrokeRecipe } from '../core/types';
import { S } from '../core/types';
import { defaultHintText } from '../ui/hints';
import { visibleBox } from '../render/camera';
import type { HintId } from './types';
import type { Runtime } from './runtime';
import type { View } from './view';

/** The Form chip pulses this long after the first stroke (ms). */
export const FORM_HINT_DELAY_MS = 1200;
/** The rise hint appears at this stroke when nothing has risen. */
export const RISE_HINT_AT = 5;
/** The nav hint appears after this many strokes at the latest. */
export const NAV_HINT_AT = 10;

export class HintFlow {
  private strokes = 0;
  private rose = false;
  private formTimer = 0;

  constructor(private readonly rt: Runtime, private readonly view: View) {}

  private pending(id: HintId): boolean { return this.rt.store.get().hints[id] === 'pending'; }
  private showing(id: HintId): boolean { return this.rt.store.get().hints[id] === 'showing'; }

  private show(id: HintId, text: string, at: { x: number; y: number } | null): void {
    const s = this.rt.store.get();
    if (s.hints[id] !== 'pending') return;
    this.rt.store.set({ hints: { ...s.hints, [id]: 'showing' } });
    this.rt.store.emit({ k: 'hint', id, text, at });
  }

  /** A stroke entered the document. `rose` > base means it pooled. */
  committed(r: StrokeRecipe, rose: boolean): void {
    this.strokes++;
    if (rose) this.risen();
    const rt = this.rt;
    if (this.strokes === 1 && this.pending('form') && !this.formTimer) {
      this.formTimer = window.setTimeout(() => {
        this.formTimer = 0;
        if (!this.pending('form')) return;
        rt.store.emit({ k: 'pulse', target: 'form' });
        this.show('form', 'Try another Form', null);
      }, FORM_HINT_DELAY_MS);
    }
    if (this.strokes >= RISE_HINT_AT && !this.rose && this.pending('rise') && !this.docHasPools()) {
      const n = Math.floor(r.samples.length / S.STRIDE);
      let at: { x: number; y: number } | null = null;
      if (n > 0) {
        const o = (n - 1) * S.STRIDE;
        const [x, y] = this.view.toScreen(r.origin[0] + r.samples[o + S.X], r.origin[1] + r.samples[o + S.Y]);
        at = { x, y };
      }
      this.show('rise', 'Hold still to make it rise.', at);
    }
    if (this.pending('nav') && (this.strokes >= NAV_HINT_AT || this.offScreen(r))) this.show('nav', defaultHintText('nav', rt.store.get()), null);
  }

  private docHasPools(): boolean {
    for (const r of this.rt.doc.ordered()) if (r.pools.length > 0) return true;
    return false;
  }

  /** The stroke's ink reaches outside the viewport. */
  private offScreen(r: StrokeRecipe): boolean {
    const b = this.rt.scene.boxOf(r.id);
    if (!b) return false;
    const v = visibleBox(this.view.cam, this.view.W, this.view.H);
    return b.x0 < v.x0 || b.y0 < v.y0 || b.x1 > v.x1 || b.y1 > v.y1;
  }

  /** A rise happened (or was loaded): the rise hint is moot. */
  risen(): void {
    this.rose = true;
    if (this.showing('rise')) this.rt.store.dispatch({ k: 'hintDone', id: 'rise' });
  }

  /** The Form was changed: the form hint did its job. */
  formPicked(): void {
    if (this.formTimer) { clearTimeout(this.formTimer); this.formTimer = 0; }
    if (this.showing('form')) this.rt.store.dispatch({ k: 'hintDone', id: 'form' });
  }

  /** A navigation gesture: the nav hint did its job. */
  navigated(): void {
    if (this.showing('nav')) this.rt.store.dispatch({ k: 'hintDone', id: 'nav' });
  }
}
