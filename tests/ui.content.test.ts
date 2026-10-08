/**
 * Content and timing of the remaining chrome: announcer throttle (§10), view chip (§4), Delete,
 * menu items (§4), Recent dates, help (§3.3 grammar line, §5 key list), toasts, hints (§3.0).
 */
import { describe, it, expect } from 'vitest';
import { announceKind, createAnnouncer } from '../src/ui/announce';
import { defaultHintText, HINT_MS } from '../src/ui/hints';
import { gestureRows, grammarLine, INK_GRAMMAR, keyLabel, keyRows } from '../src/ui/help';
import { menuItems } from '../src/ui/menu';
import { RECENT_MAX, strokeCount, whenCategory } from '../src/ui/recent';
import { deleteLabel, deletePosition } from '../src/ui/selectionbar';
import { TOAST_MS, toastDuration } from '../src/ui/toast';
import { viewChipModel } from '../src/ui/viewchip';
import { fakeTimers, state } from './ui.helpers';

describe('announcer', () => {
  const make = () => {
    const t = fakeTimers();
    const el = { textContent: '' as string | null };
    const a = createAnnouncer(el, 900, t);
    return { t, el, a };
  };
  it('speaks the first message at once, then at most one per gap', () => {
    const { t, el, a } = make();
    a.say('Sprout stroke added');
    t.advance(0);
    expect(el.textContent!.trim()).toBe('Sprout stroke added');
    a.say('3 strokes selected');
    t.advance(500);
    expect(el.textContent!.trim()).toBe('Sprout stroke added');
    t.advance(400);
    expect(el.textContent!.trim()).toBe('3 strokes selected');
    expect(t.pending).toBe(0);
  });
  it('coalesces updates of one kind: a long hold announces only its final depth', () => {
    const { t, el, a } = make();
    a.say('Image saved');
    t.advance(0);
    a.say('Rose to depth 1');
    a.say('Rose to depth 2');
    a.say('Rose to depth 3');
    expect(a.pending).toEqual(['Rose to depth 3']);
    t.advance(900);
    expect(el.textContent!.trim()).toBe('Rose to depth 3');
  });
  it('re-announces an identical message by changing the text node', () => {
    const { t, el, a } = make();
    a.say('Undone: pools removed');
    t.advance(0);
    const first = el.textContent;
    a.say('Undone: pools removed');
    t.advance(900);
    expect(el.textContent).not.toBe(first);
    expect(el.textContent!.trim()).toBe('Undone: pools removed');
  });
  it('keeps at most three distinct messages and ignores empty ones', () => {
    const { a } = make();
    a.say('a one'); a.say('b two'); a.say('c three'); a.say('d four'); a.say('   ');
    expect(a.pending.length).toBe(3);
    expect(a.pending[2]).toBe('d four');
  });
  it('kind masks numbers', () => {
    expect(announceKind('Rose to depth 2.5')).toBe(announceKind('Rose to depth 3'));
    expect(announceKind('Undone: stroke removed')).not.toBe(announceKind('Undone: pools removed'));
  });
});

describe('view chip', () => {
  it('shows the zoom, an arrow to lost ink, or both', () => {
    expect(viewChipModel({ zoom: 140, hasInk: true, inkInView: true, inkDirection: null })).toMatchObject({ text: '140%', arrow: null, lost: false });
    const lost = viewChipModel({ zoom: 100, hasInk: true, inkInView: false, inkDirection: 1.2 });
    expect(lost).toMatchObject({ text: null, arrow: 1.2, lost: true });
    expect(lost.label).toBe('No ink in view. Tap to fit the drawing.');
    const both = viewChipModel({ zoom: 37.4, hasInk: true, inkInView: false, inkDirection: -2 });
    expect(both.text).toBe('37%');
    expect(both.label).toContain('Zoom 37%');
  });
  it('labels the tap and the long-press', () => {
    expect(viewChipModel({ zoom: 200, hasInk: true, inkInView: true, inkDirection: null }).label).toBe('Zoom 200%. Tap to return to 100%. Long-press to fit the drawing.');
  });
});

describe('Delete', () => {
  it('names the count (there is no badge)', () => {
    expect(deleteLabel(1)).toBe('Delete the selected stroke');
    expect(deleteLabel(4)).toBe('Delete 4 selected strokes');
  });
  it('sits centred just above the selection, inside the viewport', () => {
    expect(deletePosition({ x: 400, y: 300, w: 200, h: 100 }, 100, 44, 1200, 800)).toEqual({ x: 450, y: 244 });
    expect(deletePosition({ x: 400, y: 20, w: 200, h: 100 }, 100, 44, 1200, 800)).toEqual({ x: 450, y: 132 });
    expect(deletePosition({ x: -50, y: 300, w: 60, h: 10 }, 100, 44, 1200, 800).x).toBe(12);
  });
});

describe('menu', () => {
  it('has exactly the nine items of DESIGN §4, in order', () => {
    expect(menuItems(state()).map(i => i.label)).toEqual(['New', 'Open…', 'Save project', 'Export image', 'Share timelapse', 'Copy remix link', 'Recent', 'Replay', 'Gestures & keys']);
  });
  it('shows shortcuts on desktop only, with the platform modifier', () => {
    expect(menuItems(state({ isMac: true })).find(i => i.key === 'save')!.kbd).toBe('⌘S');
    expect(menuItems(state()).find(i => i.key === 'open')!.kbd).toBe('Ctrl+O');
    expect(menuItems(state({ isTouch: true })).every(i => i.key === 'recent' || i.kbd === null)).toBe(true);
  });
  it('notes the autosave failure on Save; Export and Replay need ink', () => {
    expect(menuItems(state({ autosaveOk: false })).find(i => i.key === 'save')!.note).toBe('Not autosaving');
    expect(menuItems(state()).find(i => i.key === 'export')!.disabled).toBe(true);
    expect(menuItems(state({ hasInk: true })).find(i => i.key === 'replay')!.disabled).toBe(false);
    expect(menuItems(state()).find(i => i.key === 'help')!.intent).toEqual({ k: 'openSheet', sheet: 'help' });
    expect(menuItems(state()).find(i => i.key === 'recent')!.intent).toBeNull();
  });
  it('Share timelapse needs ink, waits while one records, and shows Shift+P on desktop', () => {
    const tl = (s: Parameters<typeof state>[0]) => menuItems(state(s)).find(i => i.key === 'timelapse')!;
    expect(tl({}).disabled).toBe(true);
    expect(tl({ hasInk: true }).disabled).toBe(false);
    expect(tl({ hasInk: true, recording: true }).disabled).toBe(true);
    expect(tl({ hasInk: true, exporting: true }).disabled).toBe(false);
    expect(tl({}).intent).toEqual({ k: 'timelapse' });
    expect(tl({}).kbd).toBe('⇧P');
    expect(tl({ isTouch: true }).kbd).toBe(null);
  });
  it('Copy remix link needs ink and has no shortcut', () => {
    const rm = (s: Parameters<typeof state>[0]) => menuItems(state(s)).find(i => i.key === 'remix')!;
    expect(rm({}).disabled).toBe(true);
    expect(rm({ hasInk: true }).disabled).toBe(false);
    expect(rm({}).intent).toEqual({ k: 'copyRemix' });
    expect(rm({}).kbd).toBe(null);
  });
});

describe('recent', () => {
  it('dates relative to local days', () => {
    const now = new Date(2026, 9, 4, 15, 0).getTime();
    expect(whenCategory(new Date(2026, 9, 4, 0, 1).getTime(), now)).toBe('today');
    expect(whenCategory(new Date(2026, 9, 3, 23, 59).getTime(), now)).toBe('yesterday');
    expect(whenCategory(new Date(2026, 9, 3, 0, 0).getTime(), now)).toBe('yesterday');
    expect(whenCategory(new Date(2026, 8, 29, 12).getTime(), now)).toBe('week');
    expect(whenCategory(new Date(2026, 8, 20).getTime(), now)).toBe('year');
    expect(whenCategory(new Date(2025, 11, 31).getTime(), now)).toBe('older');
  });
  it('lists twelve and counts strokes', () => {
    expect(RECENT_MAX).toBe(12);
    expect(strokeCount(1)).toBe('1 stroke');
    expect(strokeCount(14)).toBe('14 strokes');
  });
});

describe('help', () => {
  it('prints the Ink Grammar in one line, verbatim', () => {
    expect(grammarLine()).toBe('Speed = wildness · Pressure = weight & opening · Hold = rise · Lean = direction · Zoom = scale · Nearby ink = awareness');
    expect(INK_GRAMMAR.length).toBe(6);
  });
  it('labels physical keys from the layout map, falling back to US labels', () => {
    const de = new Map([['KeyZ', 'y'], ['BracketLeft', 'ü'], ['Minus', 'ß'], ['Digit1', '1']]);
    expect(keyLabel('KeyZ', de)).toBe('Y');
    expect(keyLabel('BracketLeft', de)).toBe('Ü');
    expect(keyLabel('KeyB', de)).toBe('B');
    expect(keyLabel('BracketRight')).toBe(']');
    expect(keyLabel('Minus')).toBe('−');
    expect(keyLabel('Digit4')).toBe('4');
  });
  it('covers every action in the DESIGN §5 key list', () => {
    const rows = keyRows(false, c => keyLabel(c));
    const actions = rows.map(r => r.action).join(' | ');
    for (const want of ['Form', 'nib', 'ink', 'Night / Paper', 'Erase mode', 'Size', 'Depth', 'Reseed', 'Undo / redo',
      'Select all', 'Delete the selection', 'Deselect', 'Pan', 'Fit the drawing / 100%', 'Replay', 'This sheet', 'Save · open · export']) {
      expect(actions).toContain(want);
    }
    const keys = rows.flatMap(r => r.keys);
    for (const k of ['1–4', '5–9', '0', 'B', 'Shift+B', 'C', 'G', 'E', '[', ']', '−', '=', 'R', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Esc', 'Shift+1', 'Shift+0', 'P', '?', 'Ctrl+S', 'Ctrl+O', 'Ctrl+E']) {
      expect(keys).toContain(k);
    }
  });
  it('uses Mac modifiers on a Mac', () => {
    const keys = keyRows(true, c => keyLabel(c)).flatMap(r => r.keys);
    expect(keys).toContain('⌘Z');
    expect(keys).toContain('⇧⌘Z');
    expect(keys).toContain('⌥click');
  });
  it('gestures differ for touch-only and pen devices', () => {
    expect(gestureRows(false).map(r => r.keys[0])).toContain('Double-tap ink');
    expect(gestureRows(true).map(r => r.keys[0])).toContain('Finger tap on ink');
    expect(gestureRows(true).every(r => r.plain)).toBe(true);
  });
});

describe('toasts and hints', () => {
  it('toasts last 6 s; progress toasts stay until done', () => {
    expect(TOAST_MS).toBe(6000);
    expect(toastDuration({})).toBe(6000);
    expect(toastDuration({ ms: 2000 })).toBe(2000);
    expect(toastDuration({ progress: 0.4 })).toBeNull();
    expect(toastDuration({ progress: 1 })).toBe(6000);
  });
  it('hint texts follow DESIGN §3.0; hints dismiss after 4 s', () => {
    expect(defaultHintText('draw', state())).toBe('Draw anything. It grows.');
    expect(defaultHintText('rise', state())).toBe('Hold still to make it rise.');
    expect(defaultHintText('form', state())).toBe('Try another Form');
    expect(defaultHintText('nav', state({ isTouch: true }))).toBe('Two fingers pan and zoom.');
    expect(HINT_MS).toBe(4000);
  });
});
