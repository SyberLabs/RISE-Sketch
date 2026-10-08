/** app/hints.ts: when the share hint may show (DESIGN §4 hints, §13). */
import { describe, it, expect } from 'vitest';
import { shareHintDue, SHARE_HINT_AT, SHARE_HINT_PAUSE_MS } from '../src/app/hints';
import { defaultHintText, HINT_MS } from '../src/ui/hints';
import { state } from './ui.helpers';

const hints = (patch = {}) => ({ ...state().hints, draw: 'done' as const, ...patch });

describe('share hint', () => {
  it('shows once the drawing has 6 strokes and the user is looking at it', () => {
    expect(SHARE_HINT_AT).toBe(6);
    expect(shareHintDue(state({ hints: hints() }), 5)).toBe(false);
    expect(shareHintDue(state({ hints: hints() }), 6)).toBe(true);
    expect(shareHintDue(state({ hints: hints() }), 40)).toBe(true);
  });
  it('never while drawing, replaying, recording or in a sheet', () => {
    expect(shareHintDue(state({ hints: hints(), chromeHidden: true }), 6)).toBe(false);
    expect(shareHintDue(state({ hints: hints(), replaying: true }), 6)).toBe(false);
    expect(shareHintDue(state({ hints: hints(), recording: true }), 6)).toBe(false);
    expect(shareHintDue(state({ hints: hints(), sheet: 'menu' }), 6)).toBe(false);
  });
  it('one hint at a time, and the pause outlasts a hint shown at the last lift', () => {
    expect(shareHintDue(state({ hints: hints({ rise: 'showing' }) }), 6)).toBe(false);
    expect(shareHintDue(state({ hints: hints({ nav: 'showing' }) }), 6)).toBe(false);
    expect(SHARE_HINT_PAUSE_MS).toBeGreaterThan(HINT_MS);
  });
  it('at most once, and never after sharing (both mark it done)', () => {
    expect(shareHintDue(state({ hints: hints({ share: 'showing' }) }), 6)).toBe(false);
    expect(shareHintDue(state({ hints: hints({ share: 'done' }) }), 6)).toBe(false);
  });
  it('names the shortcut on desktop and the menu item on touch', () => {
    expect(defaultHintText('share', state())).toBe('Share it: ⇧P makes a video of it growing');
    expect(defaultHintText('share', state({ isTouch: true }))).toBe('Share it: Menu → Share timelapse');
  });
});
