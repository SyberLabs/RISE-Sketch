/**
 * Hints (DESIGN §3.0, §4): at most five, ever, each shown once and remembered in prefs.
 *
 *  draw  "Draw anything. It grows."  — with the first-run seed (boot sets it 'showing'; the UI
 *        fades it at the first contact and dispatches hintDone).
 *  form  The Form chip pulses once with "Try another Form", 1.2 s after the first stroke.
 *  rise  "Hold still to make it rise." near the end of stroke 5 when nothing has risen yet
 *        (neither in this session nor in the document).
 *  nav   A navigation hint on the first stroke whose ink spills off-screen, or after 10 strokes.
 *  share "Share it: ⇧P makes a video of it growing" (touch: Menu → Share timelapse) at the first
 *        pause once the drawing has 6 strokes: there is something worth sharing and the user is
 *        looking at it (DESIGN §13). Never once Share timelapse or Copy remix link has been used.
 *
 * Each dismisses itself after 4 s (the UI dispatches hintDone), or when its action happens:
 * picking a Form, a rise, a navigation gesture, sharing. The app only decides *when*; the UI owns text
 * placement and timing. hintDone is idempotent (controller).
 */
import type { StrokeRecipe } from '../core/types';
import { S } from '../core/types';
import { defaultHintText, HINT_MS } from '../ui/hints';
import { visibleBox } from '../render/camera';
import type { AppState, HintId } from './types';
import type { Runtime } from './runtime';
import type { View } from './view';

/** The Form chip pulses this long after the first stroke (ms). */
export const FORM_HINT_DELAY_MS = 1200;
/** The rise hint appears at this stroke when nothing has risen. */
export const RISE_HINT_AT = 5;
/** The nav hint appears after this many strokes at the latest. */
export const NAV_HINT_AT = 10;
/** The share hint needs this many strokes in the drawing… */
export const SHARE_HINT_AT = 6;
/** …and this long without a new stroke (ms). Longer than a hint lives, so one shown at the last
 *  lift (rise, nav) is gone by then: one hint at a time. */
export const SHARE_HINT_PAUSE_MS = HINT_MS + 500;

/** Whether the share hint may show now (pure): pending, enough ink, and the user idle, looking at
 *  it: not drawing (chrome back), not replaying or recording, no sheet open, no other hint up. */
export function shareHintDue(s: AppState, strokes: number): boolean {
  return s.hints.share === 'pending' && strokes >= SHARE_HINT_AT && !s.chromeHidden && !s.replaying
    && !s.recording && s.sheet === null && !Object.values(s.hints).includes('showing');
}

export class HintFlow {
  private strokes = 0;
  private rose = false;
  private formTimer = 0;
  private shareTimer = 0;

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
    // Each stroke restarts the pause; a check that fails waits for the next stroke's pause.
    if (this.pending('share')) {
      clearTimeout(this.shareTimer);
      this.shareTimer = window.setTimeout(() => {
        const s = rt.store.get();
        if (shareHintDue(s, rt.doc.size)) this.show('share', defaultHintText('share', s), null);
      }, SHARE_HINT_PAUSE_MS);
    }
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

  /** Share timelapse or Copy remix link was used: the share hint is moot, now and for good. */
  shared(): void {
    clearTimeout(this.shareTimer);
    this.rt.store.dispatch({ k: 'hintDone', id: 'share' });
  }

  /** A navigation gesture: the nav hint did its job. */
  navigated(): void {
    if (this.showing('nav')) this.rt.store.dispatch({ k: 'hintDone', id: 'nav' });
  }
}
