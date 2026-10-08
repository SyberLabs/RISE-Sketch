/** app/store.ts and app/tool.ts: the observable state and the persisted tool. */
import { describe, it, expect } from 'vitest';
import type { AppState } from '../src/app/types';
import { createStore } from '../src/app/store';
import { clampBase, clampSize, cycleInk, cycleNib, defaultTool, loadTool, saveTool, sameCustom } from '../src/app/tool';
import { prefs } from '../src/persist/prefs';

const base = (): AppState => ({
  tool: defaultTool(), ground: 'night', selection: [], selectionRect: null, canUndo: false, canRedo: false,
  hasInk: false, zoom: 100, inkInView: true, inkDirection: null, chromeHidden: false, sheet: null,
  lastRecipe: null, docTitle: 'Untitled', currentDocId: 'd', recentDocs: [], autosaveOk: true,
  replaying: false, replayProgress: 0, exporting: false, recording: false, penMode: false, firstRun: false,
  hints: { draw: 'done', rise: 'pending', form: 'pending', nav: 'pending' },
  reducedMotion: false, isTouch: false, isMac: false,
});

describe('store', () => {
  it('notifies only on real changes, with the previous state', () => {
    const st = createStore(base());
    const seen: [boolean, boolean][] = [];
    st.subscribe((s, p) => seen.push([s.chromeHidden, p.chromeHidden]));
    st.set({ chromeHidden: false });
    expect(seen).toEqual([]);
    st.set({ chromeHidden: true });
    expect(seen).toEqual([[true, false]]);
  });

  it('delivers a set made inside a subscriber after the current one, never a stale state last', () => {
    const st = createStore(base());
    const a: number[] = [], b: number[] = [];
    st.subscribe(s => { a.push(s.zoom); if (s.zoom === 150) st.set({ zoom: 200 }); });
    st.subscribe(s => b.push(s.zoom));
    st.set({ zoom: 150 });
    expect(a).toEqual([150, 200]);
    expect(b).toEqual([150, 200]);
    expect(st.get().zoom).toBe(200);
  });

  it('routes dispatch to the controller and never throws into the UI', () => {
    const st = createStore(base());
    const got: string[] = [];
    st.dispatch({ k: 'undo' });
    st.setDispatcher(i => { got.push(i.k); if (i.k === 'redo') throw new Error('boom'); });
    st.dispatch({ k: 'undo' });
    const err = console.error;
    console.error = () => undefined;
    try { expect(() => st.dispatch({ k: 'redo' })).not.toThrow(); } finally { console.error = err; }
    expect(got).toEqual(['undo', 'redo']);
  });
});

describe('tool', () => {
  it('first-run defaults: Brush, Moss, Sprout at base 2', () => {
    const t = defaultTool();
    expect([t.nib, t.ink, t.form, t.base.sprout, t.mode]).toEqual(['brush', 'moss', 'sprout', 2, 'draw']);
  });

  it('clamps sizes and quarter-level bases into range', () => {
    expect(clampSize('pen', 100)).toBe(12);
    expect(clampSize('brush', 0.1)).toBe(2);
    expect(clampSize('chisel', NaN)).toBe(12);
    expect(clampBase('sprout', 3.13)).toBe(3.25);
    expect(clampBase('sprout', 9)).toBe(4);
    expect(clampBase('line', -1)).toBe(0);
  });

  it('cycles nibs without Erase and inks through the sheet order', () => {
    expect(cycleNib('chisel', 1)).toBe('pen');
    expect(cycleNib('pen', -1)).toBe('chisel');
    expect(cycleInk('spectral', 1)).toBe('graphite');
    expect(cycleInk('custom', 1)).toBe('graphite');
  });

  it('round-trips through prefs, mode excluded, bad values rejected', () => {
    const t = { ...defaultTool(), nib: 'chisel' as const, form: 'drift' as const, mode: 'erase' as const };
    t.sizes = { ...t.sizes, chisel: 20 };
    t.base = { ...t.base, drift: 4.5 };
    saveTool(t);
    const back = loadTool();
    expect([back.nib, back.form, back.sizes.chisel, back.base.drift, back.mode]).toEqual(['chisel', 'drift', 20, 4.5, 'draw']);
    prefs.set('tool', { nib: 'charcoal', ink: 'custom', custom: null, form: 'mirage', sizes: { pen: 'x' } });
    const bad = loadTool();
    expect([bad.nib, bad.ink, bad.form, bad.sizes.pen]).toEqual(['brush', 'moss', 'sprout', 2.5]);
    prefs.remove('tool');
  });

  it('persists symmetry (on, folds, centre) and rejects odd values', () => {
    expect(defaultTool().sym).toEqual({ on: false, folds: 6, cx: 0, cy: 0 });
    saveTool({ ...defaultTool(), sym: { on: true, folds: 8, cx: -12.5, cy: 300 } });
    expect(loadTool().sym).toEqual({ on: true, folds: 8, cx: -12.5, cy: 300 });
    prefs.set('tool', { sym: { on: true, folds: 7, cx: 'x', cy: 1 } });
    expect(loadTool().sym).toEqual({ on: false, folds: 6, cx: 0, cy: 0 });
    prefs.remove('tool');
  });

  it('compares custom inks by value', () => {
    const a = { night: [0.7, 0.1, 30] as const, paper: [0.5, 0.11, 30] as const };
    expect(sameCustom(a, { night: [0.7, 0.1, 30], paper: [0.5, 0.11, 30] })).toBe(true);
    expect(sameCustom(a, null)).toBe(false);
    expect(sameCustom(null, null)).toBe(true);
  });
});
